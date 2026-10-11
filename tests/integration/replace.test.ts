import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import type { Pool } from 'pg';
import { createTestApp } from '../support/test-app.ts';
import type { FakeR2 } from '../support/fake-r2.ts';

let app: Awaited<ReturnType<typeof createTestApp>>['app'];
let pool: Pool;
let store: FakeR2;
beforeAll(async () => { ({ app, pool, store } = await createTestApp()); });
afterAll(async () => { await pool.end(); });
beforeEach(async () => { await pool.query('DELETE FROM files'); await pool.query("DELETE FROM file_audit_entries WHERE action LIKE 'file.%'"); store.objects.clear(); });

const as = (code: string) => ({ 'X-System-Code': code, 'X-Actor-Id': 'user-1' });
const picture = (width: number, background: string) => sharp({ create: { width, height: 100, channels: 3, background } }).png().toBuffer();

async function activeFile(bytes: Uint8Array, visibility = 'public') {
  const requested = await request(app).post('/files').set(as('IMS')).send({
    filename: 'cover.png', contentType: 'image/png', size: bytes.byteLength, visibility, retentionType: 'permanent',
  });
  store.upload(requested.body.uploadUrl, bytes, 'image/png');
  return (await request(app).post(`/files/${requested.body.id}/confirm`).set(as('IMS'))).body;
}
const requestReplacement = (id: string, body: object) => request(app).post(`/files/${id}/replacement`).set(as('POS')).send(body);
const confirmReplacement = (id: string) => request(app).post(`/files/${id}/replacement/confirm`).set(as('POS'));
const audits = async (action: string) => (await pool.query('SELECT system_code, file_id FROM file_audit_entries WHERE action = $1', [action])).rows;
const dimensions = async (key: string) => { const { width } = await sharp(store.objects.get(key)!.body).metadata(); return width; };

test('replacing a File keeps its id and address, swaps the bytes and regenerates Variants', async () => {
  const file = await activeFile(await picture(1600, 'red'));
  expect(await dimensions(`public/${file.id}/large.webp`)).toBe(1200);
  const replacement = await picture(400, 'blue');
  const requested = await requestReplacement(file.id, { contentType: 'image/png', size: replacement.byteLength });
  expect(requested.status).toBe(201);
  expect(requested.body.id).toBe(file.id);
  store.upload(requested.body.uploadUrl, replacement, 'image/png');
  const confirmed = await confirmReplacement(file.id);
  expect(confirmed.status).toBe(200);
  expect(confirmed.body).toMatchObject({ id: file.id, size: replacement.byteLength, visibility: 'public' });
  expect(store.objects.get(`public/${file.id}/original`)!.body).toEqual(replacement);
  expect(store.objects.has(`public/${file.id}/replacement`)).toBe(false);
  expect(await dimensions(`public/${file.id}/large.webp`)).toBe(400);
  expect(confirmed.body.variants.map((v: { status: string }) => v.status)).toEqual(['ready', 'ready', 'ready']);
  const viewed = await request(app).get(`/files/${file.id}`).set(as('ECOM'));
  expect(viewed.body.url).toBe(`https://cdn.test/${file.id}/original`);
  expect(viewed.body.size).toBe(replacement.byteLength);
  expect(await audits('file.replaced')).toEqual([{ system_code: 'POS', file_id: file.id }]);
});

test('public objects get a short cache lifetime; private ones do not', async () => {
  const pub = await activeFile(await picture(300, 'red'));
  const bytes = await picture(200, 'blue');
  const requested = await requestReplacement(pub.id, { contentType: 'image/png', size: bytes.byteLength });
  store.upload(requested.body.uploadUrl, bytes, 'image/png');
  await confirmReplacement(pub.id);
  expect(store.objects.get(`public/${pub.id}/original`)!.cacheControl).toBe('public, max-age=300');
  expect(store.objects.get(`public/${pub.id}/small.webp`)!.cacheControl).toBe('public, max-age=300');

  const priv = await activeFile(await picture(300, 'red'), 'private');
  const second = await requestReplacement(priv.id, { contentType: 'image/png', size: bytes.byteLength });
  store.upload(second.body.uploadUrl, bytes, 'image/png');
  await confirmReplacement(priv.id);
  expect(store.objects.get(`private/${priv.id}/original`)!.cacheControl).toBe('private');
  expect(store.objects.get(`private/${priv.id}/small.webp`)!.cacheControl).toBeUndefined();
});

test('a mismatched replacement is rejected, the staging object removed and the live File untouched', async () => {
  const original = await picture(300, 'red');
  const file = await activeFile(original);
  const requested = await requestReplacement(file.id, { contentType: 'image/png', size: 10 });
  store.upload(requested.body.uploadUrl, await picture(200, 'blue'), 'image/png');
  const confirmed = await confirmReplacement(file.id);
  expect(confirmed.status).toBe(422);
  expect(store.objects.has(`public/${file.id}/replacement`)).toBe(false);
  expect(store.objects.get(`public/${file.id}/original`)!.body).toEqual(original);
  const viewed = await request(app).get(`/files/${file.id}`).set(as('POS'));
  expect(viewed.status).toBe(200);
  expect(viewed.body.size).toBe(original.byteLength);
  expect(await audits('file.replaced')).toHaveLength(0);
  expect(await audits('file.replacement_rejected')).toHaveLength(1);
  expect((await confirmReplacement(file.id)).status).toBe(409);
});

test('an abandoned replacement leaves the live File untouched and confirm without an upload is refused', async () => {
  const original = await picture(300, 'red');
  const file = await activeFile(original);
  await requestReplacement(file.id, { contentType: 'image/png', size: 5 });
  expect((await confirmReplacement(file.id)).status).toBe(409);
  expect(store.objects.get(`public/${file.id}/original`)!.body).toEqual(original);
  expect((await request(app).get(`/files/${file.id}`).set(as('POS'))).body.size).toBe(original.byteLength);
});

test('Visibility cannot be changed by a replace, and invalid requests are refused', async () => {
  const file = await activeFile(await picture(300, 'red'));
  const visibility = await requestReplacement(file.id, { contentType: 'image/png', size: 5, visibility: 'private' });
  expect(visibility.status).toBe(400);
  expect(visibility.body.error).toMatch(/visibility.*cannot be changed/i);
  expect((await requestReplacement(file.id, { contentType: 'image/svg+xml', size: 5 })).status).toBe(400);
  expect((await requestReplacement(file.id, { contentType: 'image/png', size: 0 })).status).toBe(400);
  expect((await requestReplacement(file.id, { contentType: 'image/png', size: 26 * 1024 * 1024 })).status).toBe(400);
  expect((await requestReplacement('00000000-0000-4000-8000-000000000000', { contentType: 'image/png', size: 5 })).status).toBe(404);
  expect((await request(app).get(`/files/${file.id}`).set(as('POS'))).body.visibility).toBe('public');
});

test('replacing a picture with a non-picture removes the stale Variants', async () => {
  const file = await activeFile(await picture(300, 'red'));
  const text = new TextEncoder().encode('hello');
  const requested = await requestReplacement(file.id, { contentType: 'text/plain', size: text.byteLength });
  store.upload(requested.body.uploadUrl, text, 'text/plain');
  const confirmed = await confirmReplacement(file.id);
  expect(confirmed.body).toMatchObject({ contentType: 'text/plain', variants: [] });
  expect(store.objects.has(`public/${file.id}/small.webp`)).toBe(false);
});
