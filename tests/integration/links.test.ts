import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../support/test-app.ts';

let context: Awaited<ReturnType<typeof createTestApp>>;
beforeAll(async () => { context = await createTestApp(); });
afterAll(async () => { await context.pool.end(); });
beforeEach(async () => {
  await context.pool.query('DELETE FROM files');
  await context.pool.query('DELETE FROM file_audit_entries');
  context.store.objects.clear();
});
const headers = { 'X-System-Code': 'IMS', 'X-Actor-Id': 'user-7' };
const link = { system: 'IMS', entityType: 'product', entityId: '42', role: 'cover' };
const valid = { filename: 'note.txt', contentType: 'text/plain', size: 4, visibility: 'public', retentionType: 'permanent' };
async function upload(change: object = {}, confirm = true) {
  const response = await request(context.app).post('/files').set(headers).send({ ...valid, ...change }).expect(201);
  if (confirm) {
    context.store.upload(response.body.uploadUrl, new Uint8Array([1, 2, 3, 4]), 'text/plain');
    await request(context.app).post(`/files/${response.body.id}/confirm`).set(headers).expect(200);
  }
  return response.body.id as string;
}
async function list(query: object = link) {
  return request(context.app).get('/files').set(headers).query(query).expect(200);
}

test('an upload Link finds the File only for its record, without restricting viewing', async () => {
  const id = await upload({ link, visibility: 'private' });
  const response = await list();
  expect(response.body.files.map((file: { id: string }) => file.id)).toEqual([id]);
  expect(response.body.nextPage).toBeNull();
  for (const change of [{ system: 'POS' }, { entityType: 'order' }, { entityId: '43' }]) {
    expect((await list({ ...link, ...change })).body.files).toEqual([]);
  }
  await request(context.app).get(`/files/${id}`).set('X-System-Code', 'POS').expect(200);
});

test('Links can be added and removed across Client Systems, with role filtering and change audits', async () => {
  const id = await upload({ link });
  const gallery = { ...link, role: 'gallery' };
  const other = await upload({ link: gallery });
  const path = `/files/${id}/links`;
  await request(context.app).post(path).set({ ...headers, 'X-System-Code': 'POS' }).send(gallery).expect(204);
  await request(context.app).post(path).set(headers).send(gallery).expect(204);
  expect((await list()).body.files.map((file: { id: string }) => file.id)).toEqual([id]);
  const all = await list({ system: 'IMS', entityType: 'product', entityId: '42' });
  expect(all.body.files.map((file: { id: string }) => file.id).sort()).toEqual([id, other].sort());
  await request(context.app).delete(path).set({ ...headers, 'X-System-Code': 'ECOM' }).send(link).expect(204);
  await request(context.app).delete(path).set(headers).send(link).expect(204);
  expect((await list()).body.files).toEqual([]);
  expect((await list(gallery)).body.files).toHaveLength(2);
  await request(context.app).get(`/files/${id}`).set('X-System-Code', 'HRMS').expect(200);
  const audits = await context.pool.query(
    "SELECT action, system_code, actor_id, detail FROM file_audit_entries WHERE file_id = $1 AND action LIKE 'file.link.%' ORDER BY created_at",
    [id],
  );
  expect(audits.rows).toEqual([
    { action: 'file.link.added', system_code: 'IMS', actor_id: 'user-7', detail: link },
    { action: 'file.link.added', system_code: 'POS', actor_id: 'user-7', detail: gallery },
    { action: 'file.link.removed', system_code: 'ECOM', actor_id: 'user-7', detail: link },
  ]);
}, 30_000);

test('paging returns 50 Files then the remaining File exactly once, even with multiple roles', async () => {
  const ids = await Promise.all(Array.from({ length: 51 }, () => upload({ link })));
  await request(context.app).post(`/files/${ids[0]}/links`).set(headers).send({ ...link, role: 'gallery' }).expect(204);
  const query = { system: 'IMS', entityType: 'product', entityId: '42' };
  const first = await list(query);
  expect(first.body.files).toHaveLength(50);
  expect(first.body.nextPage).toEqual(expect.any(String));
  const second = await list({ ...query, page: first.body.nextPage });
  expect(second.body.files).toHaveLength(1);
  expect(second.body.nextPage).toBeNull();
  const found = [...first.body.files, ...second.body.files].map((file: { id: string }) => file.id);
  expect(found.sort()).toEqual(ids.sort());
  // Removing an earlier result does not shift subsequent pages.
  await context.pool.query('DELETE FROM files WHERE id = $1', [first.body.files[49].id]);
  expect((await list({ ...query, page: first.body.nextPage })).body).toEqual(second.body);
  expect((await list(query)).body.nextPage).toBeNull();
}, 60_000);

test('Pending, expired and deleted Files stay out of results and cannot change Links', async () => {
  const active = await upload({ link });
  const pending = await upload({ link }, false);
  const expired = await upload({ link, retentionType: 'temporary' });
  const deleted = await upload({ link });
  await context.pool.query("UPDATE files SET expires_at = now() - interval '1 second' WHERE id = $1", [expired]);
  // Until the Delete endpoint is implemented, arrange deletion through the database.
  await context.pool.query('DELETE FROM files WHERE id = $1', [deleted]);
  expect((await list()).body.files.map((file: { id: string }) => file.id)).toEqual([active]);
  for (const id of [pending, expired, deleted, 'not-a-uuid', '6f1c1c0e-0000-4000-8000-000000000000']) {
    await request(context.app).post(`/files/${id}/links`).set(headers).send(link).expect(404);
    await request(context.app).delete(`/files/${id}/links`).set(headers).send(link).expect(404);
  }
}, 30_000);

test('invalid Links and list filters are rejected clearly without changing record results', async () => {
  const id = await upload({ link });
  for (const invalid of [null, [], {}, { ...link, system: 'UNKNOWN' }, { ...link, entityType: '' }, { ...link, entityId: 42 }, { ...link, role: ' ' }]) {
    const response = await request(context.app).post('/files').set(headers).send({ ...valid, link: invalid }).expect(400);
    expect(response.body.error).toEqual(expect.any(String));
    // Supertest cannot send null as a JSON body; use an empty object for that request.
    await request(context.app).post(`/files/${id}/links`).set(headers).send(invalid ?? {}).expect(400);
    await request(context.app).delete(`/files/${id}/links`).set(headers).send(invalid ?? {}).expect(400);
  }
  for (const query of [{}, { ...link, entityId: '' }, { ...link, system: 'UNKNOWN' }, { ...link, role: '' }, { ...link, page: 'bad' }, { ...link, page: [id, id] }]) {
    const response = await request(context.app).get('/files').set(headers).query(query).expect(400);
    expect(response.body.error).toEqual(expect.any(String));
  }
  expect((await list()).body.files.map((file: { id: string }) => file.id)).toEqual([id]);
}, 30_000);

test('a rejected upload leaves no linked File in record results', async () => {
  const response = await request(context.app).post('/files').set(headers).send({ ...valid, link }).expect(201);
  context.store.upload(response.body.uploadUrl, new Uint8Array([1]), 'text/plain');
  await request(context.app).post(`/files/${response.body.id}/confirm`).set(headers).expect(422);
  expect((await list()).body.files).toEqual([]);
});
