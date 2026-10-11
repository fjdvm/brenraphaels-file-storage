import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import request from 'supertest';
import sharp from 'sharp';
import { createTestApp } from '../support/test-app.ts';
import { createApp } from '../../src/http/app.ts';
import { R2ObjectStore } from '../../src/storage/r2.ts';

let context: Awaited<ReturnType<typeof createTestApp>>;
beforeAll(async () => { context = await createTestApp(); });
afterAll(async () => { await context?.pool.end(); });
beforeEach(async () => {
  vi.restoreAllMocks();
  await context.pool.query('DELETE FROM files');
  await context.pool.query('DELETE FROM file_audit_entries');
  context.store.objects.clear();
});
const headers = { 'X-System-Code': 'IMS' };
const deletingCaller = { 'X-System-Code': 'POS', 'X-Actor-Id': 'user-8' };
const link = { system: 'IMS', entityType: 'product', entityId: '42', role: 'cover' };

async function uploadText(confirm = true) {
  const uploaded = await request(context.app).post('/files').set(headers).send({
    filename: 'note.txt', contentType: 'text/plain', size: 4, visibility: 'public', retentionType: 'permanent', link,
  }).expect(201);
  context.store.upload(uploaded.body.uploadUrl, new Uint8Array([1, 2, 3, 4]), 'text/plain');
  if (confirm) await request(context.app).post(`/files/${uploaded.body.id}/confirm`).set(headers).expect(200);
  return uploaded.body as { id: string; uploadUrl: string };
}

test.each(['public', 'private'] as const)('deleting a %s File removes it for every Client System, including its Variants', async visibility => {
  const bytes = await sharp({ create: { width: 200, height: 100, channels: 3, background: 'red' } }).png().toBuffer();
  const uploaded = await request(context.app).post('/files').set(headers).send({
    filename: 'picture.png', contentType: 'image/png', size: bytes.length, visibility, retentionType: 'permanent', link,
  }).expect(201);
  const id = uploaded.body.id as string;
  context.store.upload(uploaded.body.uploadUrl, bytes, 'image/png');
  const confirmed = await request(context.app).post(`/files/${id}/confirm`).set(headers).expect(200);
  expect(confirmed.body.variants.map((variant: { status: string }) => variant.status)).toEqual(['ready', 'ready', 'ready']);
  await request(context.app).post(`/files/${id}/links`).set(headers).send({ ...link, system: 'ECOM' }).expect(204);
  await request(context.app).delete(`/files/${id}`).set(deletingCaller).expect(204);
  for (const system of ['IMS', 'POS', 'CRMS', 'HRMS', 'ECOM']) {
    await request(context.app).get(`/files/${id}`).set('X-System-Code', system).expect(404);
  }
  for (const system of ['IMS', 'ECOM']) {
    const listed = await request(context.app).get('/files').set(headers).query({ ...link, system }).expect(200);
    expect(listed.body.files).toEqual([]);
  }
  for (const key of ['original', 'small.webp', 'medium.webp', 'large.webp']) {
    expect(await context.store.get(visibility, `${id}/${key}`)).toBeNull();
  }
  await request(context.app).delete(`/files/${id}`).set(deletingCaller).expect(204);
}, 30_000);

test('a deleted File cannot be confirmed, edited or linked again', async () => {
  const { id, uploadUrl } = await uploadText();
  await request(context.app).delete(`/files/${id}`).set(deletingCaller).expect(204);
  // A previously issued upload address may still be usable; confirmation must never revive the row.
  context.store.upload(uploadUrl, new Uint8Array([1, 2, 3, 4]), 'text/plain');
  await request(context.app).post(`/files/${id}/confirm`).set(headers).expect(404);
  await request(context.app).patch(`/files/${id}`).set(headers).send({ filename: 'revived.txt' }).expect(404);
  await request(context.app).post(`/files/${id}/links`).set(headers).send(link).expect(404);
  await request(context.app).delete(`/files/${id}/links`).set(headers).send(link).expect(404);
  await request(context.app).get(`/files/${id}`).set(headers).expect(404);
});

test('an uppercase File id deletes the same stored objects', async () => {
  const { id } = await uploadText();
  await request(context.app).delete(`/files/${id.toUpperCase()}`).set(headers).expect(204);
  expect(await context.store.get('public', `${id}/original`)).toBeNull();
});

test('an R2 per-object delete failure returns an error and allows retry', async () => {
  const { id } = await uploadText();
  const app = createApp({ pool: context.pool, publicBaseUrl: 'https://cdn.test', store: new R2ObjectStore({
    accountId: 'test', accessKeyId: 'test', secretAccessKey: 'test', publicBucket: 'public', privateBucket: 'private',
  }) });
  // Fake the external S3 responses, including an HTTP 200 with an object-level failure.
  vi.spyOn(S3Client.prototype, 'send')
    .mockImplementationOnce(async () => ({ Contents: [{ Key: `${id}/original` }] }))
    .mockImplementationOnce(async () => ({ Errors: [{ Key: `${id}/original`, Code: 'InternalError' }] }));
  await request(app).delete(`/files/${id}`).set(deletingCaller).expect(500);
  await request(context.app).get(`/files/${id}`).set(headers).expect(200);
  const listed = await request(context.app).get('/files').set(headers).query(link).expect(200);
  expect(listed.body.files.map((file: { id: string }) => file.id)).toEqual([id]);
  await request(context.app).delete(`/files/${id}`).set(deletingCaller).expect(204);
  expect(await context.store.get('public', `${id}/original`)).toBeNull();
});

test('concurrent deletes are safe and leave another File available', async () => {
  const { id } = await uploadText();
  const other = await uploadText();
  await Promise.all([
    request(context.app).delete(`/files/${id}`).set(deletingCaller).expect(204),
    request(context.app).delete(`/files/${id}`).set(headers).expect(204),
  ]);
  await request(context.app).get(`/files/${id}`).set(headers).expect(404);
  await request(context.app).get(`/files/${other.id}`).set(headers).expect(200);
  expect(await context.store.get('public', `${other.id}/original`)).toEqual(new Uint8Array([1, 2, 3, 4]));
  const listed = await request(context.app).get('/files').set(headers).query(link).expect(200);
  expect(listed.body.files.map((file: { id: string }) => file.id)).toEqual([other.id]);
});

test('a Pending upload can be deleted and never confirmed afterward', async () => {
  const { id } = await uploadText(false);
  await request(context.app).delete(`/files/${id}`).set(headers).expect(204);
  expect(await context.store.get('public', `${id}/original`)).toBeNull();
  await request(context.app).post(`/files/${id}/confirm`).set(headers).expect(404);
  await request(context.app).delete(`/files/${id}`).set(headers).expect(204);
});

test('deletion requires a known Client System and a valid existing File', async () => {
  const { id } = await uploadText();
  await request(context.app).delete(`/files/${id}`).expect(401);
  await request(context.app).delete(`/files/${id}`).set('X-System-Code', 'UNKNOWN').expect(401);
  await request(context.app).get(`/files/${id}`).set(headers).expect(200);
  for (const missing of ['not-a-uuid', '6f1c1c0e-0000-4000-8000-000000000000']) {
    const response = await request(context.app).delete(`/files/${missing}`).set(headers).expect(404);
    expect(response.body).toEqual({ error: 'File not found' });
  }
});
