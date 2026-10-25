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

const headers = { 'X-System-Code': 'IMS', 'X-Actor-Id': 'agent-1', Accept: 'application/json, text/event-stream' };
const rpc = (method: string, params: object = {}, as: Record<string, string> = headers) =>
  request(app).post('/mcp').set(as).send({ jsonrpc: '2.0', id: 1, method, params });

async function call(name: string, args: object = {}) {
  const response = await rpc('tools/call', { name, arguments: args });
  expect(response.status).toBe(200);
  const { content, isError } = response.body.result;
  const text = content[0].text as string;
  return { isError: Boolean(isError), text, data: isError ? undefined : JSON.parse(text) };
}

const upload = { filename: 'notes.txt', contentType: 'text/plain', size: 5, visibility: 'public', retentionType: 'permanent' };
async function activeFile() {
  const { data } = await call('request_upload', upload);
  store.upload(data.uploadUrl, new TextEncoder().encode('hello'), 'text/plain');
  await call('confirm_upload', { id: data.id });
  return data.id as string;
}

test('refuses a call without a system code', async () => {
  const response = await rpc('tools/list', {}, { Accept: headers.Accept });
  expect(response.status).toBe(401);
  expect(response.body).toEqual({ error: 'X-System-Code header is required' });
});

test('refuses an unknown system code', async () => {
  expect((await rpc('tools/list', {}, { ...headers, 'X-System-Code': 'NOPE' })).status).toBe(401);
});

test('lists the tools', async () => {
  const response = await rpc('tools/list');
  expect(response.body.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
    'confirm_replacement', 'confirm_upload', 'delete_file', 'edit_file', 'list_files', 'replace_file', 'request_upload', 'view_file',
  ]);
});

test('request_upload returns the presigned address and a runnable command, and the audit uses the header identity', async () => {
  const { data } = await call('request_upload', { ...upload, localPath: '/tmp/my notes.txt' });
  expect(data).toMatchObject({ status: 'pending', filename: 'notes.txt' });
  expect(data.uploadUrl).toContain(data.id);
  expect(data.uploadCommand).toBe(`curl -X PUT -H 'Content-Type: text/plain' --upload-file '/tmp/my notes.txt' '${data.uploadUrl}'`);
  const audit = await pool.query("SELECT system_code, actor_id FROM file_audit_entries WHERE action = 'file.requested'");
  expect(audit.rows).toEqual([{ system_code: 'IMS', actor_id: 'agent-1' }]);
});

test('the command has a placeholder when no local path is given', async () => {
  const { data } = await call('request_upload', upload);
  expect(data.uploadCommand).toContain("--upload-file '<path-to-file>'");
});

test('confirm, view, list, edit, replace and delete behave like the API', async () => {
  const link = { system: 'IMS', entityType: 'product', entityId: '42', role: 'manual' };
  const requested = await call('request_upload', { ...upload, link });
  store.upload(requested.data.uploadUrl, new TextEncoder().encode('hello'), 'text/plain');
  const confirmed = await call('confirm_upload', { id: requested.data.id });
  expect(confirmed.data).toMatchObject({ id: requested.data.id, status: 'active' });

  const viewed = await call('view_file', { id: requested.data.id });
  expect(viewed.data.url).toBe(`https://cdn.test/${requested.data.id}/original`);

  const listed = await call('list_files', { system: 'IMS', entityType: 'product', entityId: '42' });
  expect(listed.data.files.map((file: { id: string }) => file.id)).toEqual([requested.data.id]);

  const edited = await call('edit_file', { id: requested.data.id, filename: 'renamed.txt' });
  expect(edited.data.filename).toBe('renamed.txt');

  const replacement = await call('replace_file', { id: requested.data.id, contentType: 'text/plain', size: 3, localPath: 'new.txt' });
  expect(replacement.data.id).toBe(requested.data.id);
  expect(replacement.data.uploadCommand).toContain("--upload-file 'new.txt'");
  store.upload(replacement.data.uploadUrl, new TextEncoder().encode('bye'), 'text/plain');
  expect((await call('confirm_replacement', { id: requested.data.id })).data.size).toBe(3);

  expect((await call('delete_file', { id: requested.data.id })).data).toEqual({ deleted: true });
  expect((await call('view_file', { id: requested.data.id })).isError).toBe(true);
});

test('failures come back as tool errors with the API message', async () => {
  const missing = await call('view_file', { id: '00000000-0000-4000-8000-000000000000' });
  expect(missing).toMatchObject({ isError: true, text: 'File not found' });

  const invalid = await call('request_upload', { ...upload, contentType: 'video/webm' });
  expect(invalid).toMatchObject({ isError: true, text: 'contentType is not an allowed file type' });

  const id = await activeFile();
  expect((await call('edit_file', { id })).text).toBe('Provide filename or retentionType to edit');
});
