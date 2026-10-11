import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import { createTestApp } from '../support/test-app.ts';
import { FakeR2 } from '../support/fake-r2.ts';
import type { Bucket } from '../../src/storage/object-store.ts';

class UnreliableR2 extends FakeR2 {
  failMedium = false;
  failRead = false;
  override async get(bucket: Bucket, key: string) {
    if (this.failRead) throw new Error('R2 read failed');
    return super.get(bucket, key);
  }
  override async put(bucket: Bucket, key: string, body: Uint8Array, contentType: string) {
    if (this.failMedium && key.endsWith('/medium.webp')) throw new Error('R2 write failed');
    return super.put(bucket, key, body, contentType);
  }
}
const store = new UnreliableR2();

let context: Awaited<ReturnType<typeof createTestApp>>;
beforeAll(async () => { context = await createTestApp(store); });
afterAll(async () => { await context?.pool.end(); });
beforeEach(async () => { vi.restoreAllMocks(); await context.pool.query('DELETE FROM files'); store.objects.clear(); store.failMedium = false; store.failRead = false; });

const headers = { 'X-System-Code': 'IMS' };
async function upload(body: Uint8Array, contentType = 'image/png', visibility = 'public') {
  const response = await request(context.app).post('/files').set(headers).send({
    filename: 'picture', contentType, size: body.byteLength, visibility, retentionType: 'permanent',
  });
  expect(response.status).toBe(201);
  context.store.upload(response.body.uploadUrl, body, contentType);
  return response.body.id as string;
}
const confirm = (id: string) => request(context.app).post(`/files/${id}/confirm`).set(headers);
const view = (id: string) => request(context.app).get(`/files/${id}`).set({ 'X-System-Code': 'POS' });

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('concurrent confirmations preserve failed Variant statuses and objects consistently', async () => {
  const bytes = await sharp({ create: { width: 1600, height: 800, channels: 3, background: 'red' } }).png().toBuffer();
  const id = await upload(bytes);
  const firstRead = signal();
  const secondRead = signal();
  const releaseFirst = signal();
  const releaseSecond = signal();
  const get = store.get.bind(store);
  let reads = 0;
  vi.spyOn(store, 'get').mockImplementation(async (bucket, key) => {
    if (key.endsWith('/original')) {
      if (++reads === 1) { firstRead.resolve(); await releaseFirst.promise; }
      else { secondRead.resolve(); await releaseSecond.promise; }
    }
    return get(bucket, key);
  });
  store.failMedium = true;
  const first = confirm(id).then(response => response);
  await firstRead.promise;
  const second = confirm(id).then(response => response);
  // Allow the second HTTP request to reach either the original read or the File lock.
  await Promise.race([secondRead.promise, new Promise(resolve => setTimeout(resolve, 100))]);
  releaseFirst.resolve();
  const winner = await first;
  store.failMedium = false;
  releaseSecond.resolve();
  const follower = await second;
  expect(winner.status).toBe(200);
  expect(follower.status).toBe(200);
  expect(follower.body.variants).toEqual(winner.body.variants);
  expect(winner.body.variants[1]).toEqual({ name: 'medium', status: 'failed', url: null });
  expect(await store.head('public', `${id}/medium.webp`)).toBeNull();
});

test.each(['application/pdf', 'text/plain', 'image/gif'])('a %s File has no Variants', async contentType => {
  const id = await upload(new Uint8Array([1, 2, 3, 4]), contentType);
  const confirmed = await confirm(id);
  expect(confirmed.status).toBe(200);
  expect(confirmed.body.variants).toEqual([]);
  expect((await view(id)).body.variants).toEqual([]);
});

test('a WebP File has ready Variants and repeated confirmation returns the saved result', async () => {
  const bytes = await sharp({ create: { width: 1600, height: 800, channels: 3, background: 'green' } }).webp().toBuffer();
  const id = await upload(bytes, 'image/webp');
  const first = await confirm(id);
  expect(first.status).toBe(200);
  expect(first.body.variants).toEqual([
    { name: 'small', status: 'ready', url: `https://cdn.test/${id}/small.webp` },
    { name: 'medium', status: 'ready', url: `https://cdn.test/${id}/medium.webp` },
    { name: 'large', status: 'ready', url: `https://cdn.test/${id}/large.webp` },
  ]);
  // A confirmed File no longer needs to read its original to return its Variants.
  store.failRead = true;
  expect((await confirm(id)).body).toEqual(first.body);
});

test('undecodable picture bytes yield three failed Variants while the original stays viewable', async () => {
  const id = await upload(new Uint8Array([1, 2, 3, 4]));
  const confirmed = await confirm(id);
  expect(confirmed.status).toBe(200);
  expect(confirmed.body.variants).toEqual([
    { name: 'small', status: 'failed', url: null },
    { name: 'medium', status: 'failed', url: null },
    { name: 'large', status: 'failed', url: null },
  ]);
  expect((await view(id)).body.url).toBe(`https://cdn.test/${id}/original`);
  expect(await store.get('public', `${id}/original`)).toEqual(new Uint8Array([1, 2, 3, 4]));
});

test('an original read failure marks every Variant failed and still confirms the File', async () => {
  const id = await upload(new Uint8Array([1, 2, 3, 4]));
  store.failRead = true;
  const confirmed = await confirm(id);
  expect(confirmed.status).toBe(200);
  expect(confirmed.body.status).toBe('active');
  expect(confirmed.body.variants).toEqual([
    { name: 'small', status: 'failed', url: null },
    { name: 'medium', status: 'failed', url: null },
    { name: 'large', status: 'failed', url: null },
  ]);
  expect((await view(id)).body.variants).toEqual(confirmed.body.variants);
});

test('a confirmed PNG has three ready WebP Variants with working Public addresses', async () => {
  const bytes = await sharp({ create: { width: 1600, height: 800, channels: 3, background: 'red' } }).png().toBuffer();
  const id = await upload(bytes);
  const confirmed = await confirm(id);
  expect(confirmed.status).toBe(200);
  expect(confirmed.body.variants).toEqual([
    { name: 'small', status: 'ready', url: `https://cdn.test/${id}/small.webp` },
    { name: 'medium', status: 'ready', url: `https://cdn.test/${id}/medium.webp` },
    { name: 'large', status: 'ready', url: `https://cdn.test/${id}/large.webp` },
  ]);
  for (const [index, width] of [150, 600, 1200].entries()) {
    const url = new URL(confirmed.body.variants[index].url);
    const key = url.pathname.slice(1);
    expect(await context.store.head('public', key)).toMatchObject({ contentType: 'image/webp' });
    const body = await context.store.get('public', key);
    expect(body).not.toBeNull();
    expect(await sharp(body!).metadata()).toMatchObject({ format: 'webp', width, height: width / 2 });
  }
  expect((await view(id)).body.variants).toEqual(confirmed.body.variants);
});

test('a Private File exposes Variants through signed addresses in its own bucket', async () => {
  const bytes = await sharp({ create: { width: 100, height: 200, channels: 3, background: 'blue' } }).jpeg().toBuffer();
  const id = await upload(bytes, 'image/jpeg', 'private');
  const confirmed = await confirm(id);
  expect(confirmed.status).toBe(200);
  for (const variant of confirmed.body.variants) {
    expect(variant.status).toBe('ready');
    expect(variant.url).toBe(`fake://private/${id}/${variant.name}.webp?get&expires=300`);
    const key = new URL(variant.url).pathname.slice(1);
    expect(await store.get('public', key)).toBeNull();
    const body = await store.get('private', key);
    expect(body).not.toBeNull();
    const metadata = await sharp(body!).metadata();
    expect(metadata.format).toBe('webp');
    expect(metadata.width! / metadata.height!).toBe(0.5);
    expect(metadata.height).toBeLessThanOrEqual(200);
  }
  expect((await view(id)).body.variants).toEqual(confirmed.body.variants);
});

test('a failed Variant is persisted without failing confirmation or the other Variants', async () => {
  const bytes = await sharp({ create: { width: 1600, height: 800, channels: 3, background: 'red' } }).png().toBuffer();
  const id = await upload(bytes);
  store.failMedium = true;
  const confirmed = await confirm(id);
  expect(confirmed.status).toBe(200);
  expect(confirmed.body.status).toBe('active');
  expect(confirmed.body.variants).toEqual([
    { name: 'small', status: 'ready', url: `https://cdn.test/${id}/small.webp` },
    { name: 'medium', status: 'failed', url: null },
    { name: 'large', status: 'ready', url: `https://cdn.test/${id}/large.webp` },
  ]);
  expect(await store.head('public', `${id}/medium.webp`)).toBeNull();
  expect(await store.head('public', `${id}/large.webp`)).toMatchObject({ contentType: 'image/webp' });
  store.failMedium = false;
  expect((await confirm(id)).body.variants).toEqual(confirmed.body.variants);
  expect((await view(id)).body.variants).toEqual(confirmed.body.variants);
});
