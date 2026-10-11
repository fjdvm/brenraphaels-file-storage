import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
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
const png = new Uint8Array([1, 2, 3, 4]);
const valid = { filename: 'cover.png', contentType: 'image/png', size: 4, visibility: 'public', retentionType: 'permanent' };

async function requestUpload(body: object = valid, code = 'IMS') {
  return request(app).post('/files').set(as(code)).send(body);
}
async function audits(action: string) {
  return (await pool.query('SELECT system_code, actor_id, file_id FROM file_audit_entries WHERE action = $1', [action])).rows;
}

async function activeFile(change: object = {}) {
  const requested = await requestUpload({ ...valid, ...change });
  store.upload(requested.body.uploadUrl, png, 'image/png');
  return (await request(app).post(`/files/${requested.body.id}/confirm`).set(as('IMS'))).body;
}

test('a Client System edits another system’s File filename and records the edit', async () => {
  const file = await activeFile();
  const edited = await request(app).patch(`/files/${file.id}`).set(as('POS')).send({ filename: ' renamed.png ' });
  expect(edited.status).toBe(200);
  expect(edited.body).toMatchObject({ filename: 'renamed.png', retentionType: 'permanent', expiresAt: null });
  const viewed = await request(app).get(`/files/${file.id}`).set(as('ECOM'));
  expect(viewed.body.filename).toBe('renamed.png');
  expect(await audits('file.edited')).toEqual([{ system_code: 'POS', actor_id: 'user-1', file_id: file.id }]);
});

test('a Temporary File can be promoted and demoted with expiry seven days from the change', async () => {
  const file = await activeFile({ retentionType: 'temporary' });
  const promoted = await request(app).patch(`/files/${file.id}`).set(as('POS')).send({ retentionType: 'permanent' });
  expect(promoted.status).toBe(200);
  expect(promoted.body).toMatchObject({ retentionType: 'permanent', expiresAt: null });
  expect((await request(app).get(`/files/${file.id}`).set(as('IMS'))).body.expiresAt).toBeNull();
  const before = Date.now();
  const demoted = await request(app).patch(`/files/${file.id}`).set(as('HRMS')).send({ retentionType: 'temporary', filename: 'temporary.png' });
  expect(demoted.status).toBe(200);
  expect(demoted.body).toMatchObject({ filename: 'temporary.png', retentionType: 'temporary' });
  expect(new Date(demoted.body.expiresAt).getTime()).toBeGreaterThanOrEqual(before + 604_800_000);
  expect(new Date(demoted.body.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 604_800_000);
  expect((await request(app).get(`/files/${file.id}`).set(as('IMS'))).body.expiresAt).toBe(demoted.body.expiresAt);
  expect(await audits('file.edited')).toEqual([
    { system_code: 'POS', actor_id: 'user-1', file_id: file.id },
    { system_code: 'HRMS', actor_id: 'user-1', file_id: file.id },
  ]);
});

test('a Visibility change is clearly refused without applying any edit', async () => {
  const file = await activeFile();
  const response = await request(app).patch(`/files/${file.id}`).set(as('POS')).send({ visibility: 'private', filename: 'wrong.png' });
  expect(response.status).toBe(400);
  expect(response.body.error).toMatch(/visibility.*cannot be changed/i);
  const viewed = await request(app).get(`/files/${file.id}`).set(as('IMS'));
  expect(viewed.body).toMatchObject({ filename: 'cover.png', visibility: 'public' });
  expect(await audits('file.edited')).toHaveLength(0);
});

test.each([
  {}, { contentType: 'text/plain' }, { filename: '   ' }, { filename: null },
  { retentionType: 'forever' }, { retentionType: null }, [],
].map(body => [body]))('refuses invalid edit %j without changing the File or writing an edit audit', async body => {
  const file = await activeFile();
  const response = await request(app).patch(`/files/${file.id}`).set(as('POS')).send(body);
  expect(response.status).toBe(400);
  expect(response.body.error).toEqual(expect.any(String));
  expect((await request(app).get(`/files/${file.id}`).set(as('IMS'))).body).toMatchObject({ filename: 'cover.png', retentionType: 'permanent' });
  expect(await audits('file.edited')).toHaveLength(0);
});

test('editing a Temporary File without changing Retention type preserves its expiry and address', async () => {
  const file = await activeFile({ retentionType: 'temporary', visibility: 'private' });
  const viewed = await request(app).get(`/files/${file.id}`).set(as('IMS'));
  const edited = await request(app).patch(`/files/${file.id}`).set(as('POS')).send({ filename: 'renamed.png', retentionType: 'temporary' });
  expect(edited.status).toBe(200);
  expect(edited.body).toMatchObject({ expiresAt: file.expiresAt, visibility: 'private', variants: file.variants });
  expect((await request(app).get(`/files/${file.id}`).set(as('IMS'))).body.url).toBe(viewed.body.url);
});

test('Pending, expired, missing and malformed Files cannot be edited', async () => {
  const pending = await requestUpload();
  const expired = await activeFile({ retentionType: 'temporary' });
  await pool.query("UPDATE files SET expires_at = now() - interval '1 second' WHERE id = $1", [expired.id]);
  for (const id of [pending.body.id, expired.id, 'not-a-uuid', '6f1c1c0e-0000-4000-8000-000000000000']) {
    const response = await request(app).patch(`/files/${id}`).set(as('POS')).send({ retentionType: 'permanent' });
    expect(response.status).toBe(404);
    expect(response.body.error).toBe('File not found');
  }
  expect(await audits('file.edited')).toHaveLength(0);
});

test('concurrent filename and Retention type edits both remain visible', async () => {
  const file = await activeFile();
  const responses = await Promise.all([
    request(app).patch(`/files/${file.id}`).set(as('POS')).send({ filename: 'renamed.png' }),
    request(app).patch(`/files/${file.id}`).set(as('HRMS')).send({ retentionType: 'temporary' }),
  ]);
  expect(responses.map(response => response.status)).toEqual([200, 200]);
  expect((await request(app).get(`/files/${file.id}`).set(as('IMS'))).body).toMatchObject({ filename: 'renamed.png', retentionType: 'temporary', expiresAt: expect.any(String) });
  expect(await audits('file.edited')).toHaveLength(2);
});

test('a Public File goes through request, upload, confirm and view', async () => {
  const requested = await requestUpload();
  expect(requested.status).toBe(201);
  expect(requested.body.uploadUrl).toContain('expires=900');
  store.upload(requested.body.uploadUrl, png, 'image/png');

  const confirmed = await request(app).post(`/files/${requested.body.id}/confirm`).set(as('IMS'));
  expect(confirmed.status).toBe(200);
  expect(confirmed.body).toMatchObject({ id: requested.body.id, status: 'active', filename: 'cover.png', visibility: 'public', retentionType: 'permanent', expiresAt: null });

  const viewed = await request(app).get(`/files/${requested.body.id}`).set(as('POS'));
  expect(viewed.status).toBe(200);
  expect(viewed.body.url).toMatch(/^https?:\/\/.+\/.+\/original$/);
  expect(viewed.body.url).not.toContain('expires');
});

test('a Private File is viewed through a 5 minute signed address', async () => {
  const requested = await requestUpload({ ...valid, visibility: 'private' });
  store.upload(requested.body.uploadUrl, png, 'image/png');
  await request(app).post(`/files/${requested.body.id}/confirm`).set(as('IMS'));
  const viewed = await request(app).get(`/files/${requested.body.id}`).set(as('CRMS'));
  expect(viewed.status).toBe(200);
  expect(viewed.body.url).toContain('fake://private/');
  expect(viewed.body.url).toContain('expires=300');
});

test.each(['visibility', 'retentionType'])('missing %s returns 400 with a clear message', async field => {
  const { [field]: _omitted, ...rest } = valid as Record<string, unknown>;
  const response = await requestUpload(rest);
  expect(response.status).toBe(400);
  expect(response.body.error).toContain(field);
});

test.each([
  ['over 25 MB', { size: 25 * 1024 * 1024 + 1 }],
  ['a disallowed type', { contentType: 'application/x-msdownload' }],
  ['an unknown visibility', { visibility: 'secret' }],
  ['an empty filename', { filename: '' }],
])('refuses a request with %s', async (_name, change) => {
  const response = await requestUpload({ ...valid, ...change });
  expect(response.status).toBe(400);
  expect(response.body.error).toEqual(expect.any(String));
});

test('a size mismatch at confirm rejects the upload and removes the object', async () => {
  const requested = await requestUpload();
  store.upload(requested.body.uploadUrl, new Uint8Array([1, 2]), 'image/png');
  const confirmed = await request(app).post(`/files/${requested.body.id}/confirm`).set(as('IMS'));
  expect(confirmed.status).toBe(422);
  expect(store.objects.size).toBe(0);
  expect((await request(app).get(`/files/${requested.body.id}`).set(as('IMS'))).status).toBe(404);
  expect(await audits('file.rejected')).toHaveLength(1);
});

test('confirming without an uploaded object is refused and keeps the Pending upload', async () => {
  const requested = await requestUpload();
  expect((await request(app).post(`/files/${requested.body.id}/confirm`).set(as('IMS'))).status).toBe(409);
  store.upload(requested.body.uploadUrl, png, 'image/png');
  expect((await request(app).post(`/files/${requested.body.id}/confirm`).set(as('IMS'))).status).toBe(200);
});

test('confirming twice returns the same Active File', async () => {
  const requested = await requestUpload();
  store.upload(requested.body.uploadUrl, png, 'image/png');
  const first = await request(app).post(`/files/${requested.body.id}/confirm`).set(as('IMS'));
  const second = await request(app).post(`/files/${requested.body.id}/confirm`).set(as('IMS'));
  expect(second.status).toBe(200);
  expect(second.body).toEqual(first.body);
  expect(await audits('file.confirmed')).toHaveLength(1);
});

test('a Pending upload is not shown', async () => {
  const requested = await requestUpload();
  expect((await request(app).get(`/files/${requested.body.id}`).set(as('IMS'))).status).toBe(404);
});

test('an unknown or malformed id is not found', async () => {
  expect((await request(app).get('/files/not-a-uuid').set(as('IMS'))).status).toBe(404);
  expect((await request(app).get('/files/6f1c1c0e-0000-4000-8000-000000000000').set(as('IMS'))).status).toBe(404);
  expect((await request(app).post('/files/not-a-uuid/confirm').set(as('IMS'))).status).toBe(404);
});

test('a Temporary File stores its expiry and is not found once expired', async () => {
  const requested = await requestUpload({ ...valid, retentionType: 'temporary' });
  store.upload(requested.body.uploadUrl, png, 'image/png');
  const confirmed = await request(app).post(`/files/${requested.body.id}/confirm`).set(as('IMS'));
  const days = (new Date(confirmed.body.expiresAt).getTime() - Date.now()) / 86_400_000;
  expect(days).toBeGreaterThan(6.99);
  expect(days).toBeLessThanOrEqual(7);

  await pool.query("UPDATE files SET expires_at = now() - interval '1 second' WHERE id = $1", [requested.body.id]);
  expect((await request(app).get(`/files/${requested.body.id}`).set(as('IMS'))).status).toBe(404);
  expect((await request(app).post(`/files/${requested.body.id}/confirm`).set(as('IMS'))).status).toBe(404);
});

test('request, confirm and view each write an audit entry with system code and actor id', async () => {
  const requested = await requestUpload();
  store.upload(requested.body.uploadUrl, png, 'image/png');
  await request(app).post(`/files/${requested.body.id}/confirm`).set(as('IMS'));
  await request(app).get(`/files/${requested.body.id}`).set(as('POS'));
  expect(await audits('file.requested')).toEqual([{ system_code: 'IMS', actor_id: 'user-1', file_id: requested.body.id }]);
  expect(await audits('file.confirmed')).toEqual([{ system_code: 'IMS', actor_id: 'user-1', file_id: requested.body.id }]);
  expect(await audits('file.viewed')).toEqual([{ system_code: 'POS', actor_id: 'user-1', file_id: requested.body.id }]);
});
