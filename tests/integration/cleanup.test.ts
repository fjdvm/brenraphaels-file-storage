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

const as = { 'X-System-Code': 'IMS', 'X-Actor-Id': 'user-1' };
const cron = { Authorization: 'Bearer test-cron-secret' };
const link = { system: 'IMS', entityType: 'product', entityId: '42', role: 'cover' };

async function add(retentionType: 'permanent' | 'temporary', { confirm = true, visibility = 'public' } = {}) {
  const requested = await request(app).post('/files').set(as).send({
    filename: 'note.txt', contentType: 'text/plain', size: 4, visibility, retentionType, link,
  }).expect(201);
  store.upload(requested.body.uploadUrl, new Uint8Array([1, 2, 3, 4]), 'text/plain');
  if (confirm) await request(app).post(`/files/${requested.body.id}/confirm`).set(as).expect(200);
  return requested.body.id as string;
}
const status = async (id: string) => (await pool.query('SELECT status FROM files WHERE id = $1', [id])).rows[0]?.status;
const age = (id: string, interval: string) => pool.query(
  `UPDATE files SET created_at = now() - $2::interval, expires_at = CASE WHEN expires_at IS NULL THEN NULL ELSE now() - $2::interval + interval '7 days' END WHERE id = $1`, [id, interval]);
const audits = async (action: string) => (await pool.query('SELECT system_code, actor_id, file_id FROM file_audit_entries WHERE action = $1', [action])).rows;

test('an expired Temporary File is removed from R2, its Links dropped and the row marked Deleted', async () => {
  const id = await add('temporary', { visibility: 'private' });
  const keep = await add('temporary');
  const permanent = await add('permanent');
  await age(id, '8 days');
  await request(app).get('/cron/cleanup').set(cron).expect(200);
  expect(await status(id)).toBe('deleted');
  expect(store.objects.has(`private/${id}/original`)).toBe(false);
  expect((await pool.query('SELECT 1 FROM file_links WHERE file_id = $1', [id])).rowCount).toBe(0);
  expect(await status(keep)).toBe('active');
  expect(await status(permanent)).toBe('active');
  expect(store.objects.has(`public/${keep}/original`)).toBe(true);
  expect(await audits('file.deleted')).toEqual([{ system_code: 'CRON', actor_id: 'cron', file_id: id }]);
});

test('a Pending upload older than 24 hours and its object are discarded; a recent one is kept', async () => {
  const stale = await add('permanent', { confirm: false });
  const fresh = await add('permanent', { confirm: false });
  await age(stale, '25 hours');
  await request(app).get('/cron/cleanup').set(cron).expect(200);
  expect(await status(stale)).toBeUndefined();
  expect(store.objects.has(`public/${stale}/original`)).toBe(false);
  expect(await status(fresh)).toBe('pending');
  expect(store.objects.has(`public/${fresh}/original`)).toBe(true);
  expect(await audits('file.pending_discarded')).toEqual([{ system_code: 'CRON', actor_id: 'cron', file_id: stale }]);
});

test('a stale replacement staging object is discarded and the File is unchanged', async () => {
  const id = await add('permanent');
  const staleRequest = async (hours: number) => {
    const requested = await request(app).post(`/files/${id}/replacement`).set(as).send({ contentType: 'text/plain', size: 2 }).expect(201);
    store.upload(requested.body.uploadUrl, new Uint8Array([9, 9]), 'text/plain');
    await pool.query(`UPDATE files SET replacement = jsonb_set(replacement, '{requestedAt}', to_jsonb(to_char(now() - $2::interval, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) WHERE id = $1`, [id, `${hours} hours`]);
  };
  await staleRequest(1);
  await request(app).get('/cron/cleanup').set(cron).expect(200);
  expect(store.objects.has(`public/${id}/replacement`)).toBe(true);
  await staleRequest(25);
  await request(app).get('/cron/cleanup').set(cron).expect(200);
  expect(store.objects.has(`public/${id}/replacement`)).toBe(false);
  expect(store.objects.has(`public/${id}/original`)).toBe(true);
  expect((await pool.query('SELECT replacement FROM files WHERE id = $1', [id])).rows[0].replacement).toBeNull();
  expect(await status(id)).toBe('active');
  expect(await audits('file.replacement_discarded')).toEqual([{ system_code: 'CRON', actor_id: 'cron', file_id: id }]);
});

test('a replacement requested before times were recorded is stamped, not discarded, then discarded once stale', async () => {
  const id = await add('permanent');
  const requested = await request(app).post(`/files/${id}/replacement`).set(as).send({ contentType: 'text/plain', size: 2 }).expect(201);
  store.upload(requested.body.uploadUrl, new Uint8Array([9, 9]), 'text/plain');
  await pool.query("UPDATE files SET replacement = replacement - 'requestedAt' WHERE id = $1", [id]);
  await request(app).get('/cron/cleanup').set(cron).expect(200);
  expect(store.objects.has(`public/${id}/replacement`)).toBe(true);
  expect((await pool.query('SELECT replacement FROM files WHERE id = $1', [id])).rows[0].replacement.requestedAt).toBeTruthy();
});

test('an expired Temporary picture loses its Variants too', async () => {
  const bytes = await sharp({ create: { width: 200, height: 100, channels: 3, background: 'red' } }).png().toBuffer();
  const requested = await request(app).post('/files').set(as).send({
    filename: 'p.png', contentType: 'image/png', size: bytes.length, visibility: 'private', retentionType: 'temporary',
  }).expect(201);
  store.upload(requested.body.uploadUrl, bytes, 'image/png');
  await request(app).post(`/files/${requested.body.id}/confirm`).set(as).expect(200);
  expect([...store.objects.keys()].filter(key => key.startsWith(`private/${requested.body.id}/`))).toHaveLength(4);
  await age(requested.body.id, '8 days');
  await request(app).get('/cron/cleanup').set(cron).expect(200);
  expect([...store.objects.keys()].filter(key => key.startsWith(`private/${requested.body.id}/`))).toEqual([]);
});

test.each([[{}], [{ Authorization: 'Bearer wrong' }], [{ Authorization: 'test-cron-secret' }]])('a call without the secret is refused and changes nothing (%j)', async headers => {
  const id = await add('temporary');
  const stale = await add('permanent', { confirm: false });
  await age(id, '8 days');
  await age(stale, '25 hours');
  const response = await request(app).get('/cron/cleanup').set(headers);
  expect(response.status).toBe(401);
  expect(await status(id)).toBe('active');
  expect(await status(stale)).toBe('pending');
  expect(store.objects.has(`public/${id}/original`)).toBe(true);
  expect((await pool.query("SELECT 1 FROM file_audit_entries WHERE system_code = 'CRON'")).rowCount).toBe(0);
});
