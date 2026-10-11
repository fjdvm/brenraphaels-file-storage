import { afterAll, beforeAll, expect, test } from 'vitest';
import request from 'supertest';
import type { Pool } from 'pg';
import { createTestApp } from '../support/test-app.ts';
import type { FakeR2 } from '../support/fake-r2.ts';
import { writeAudit } from '../../src/audit/write-audit.ts';
import { drizzle } from 'drizzle-orm/node-postgres';

let app: Awaited<ReturnType<typeof createTestApp>>['app'];
let pool: Pool;
let store: FakeR2;
beforeAll(async () => { ({ app, pool, store } = await createTestApp()); });
afterAll(async () => { await pool.end(); });

test('health answers without a system code', async () => {
  const response = await request(app).get('/health');
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ status: 'ok' });
});

test('other routes refuse a missing system code', async () => {
  const response = await request(app).get('/files/anything');
  expect(response.status).toBe(401);
  expect(response.body).toEqual({ error: 'X-System-Code header is required' });
});

test('other routes refuse an unknown system code', async () => {
  const response = await request(app).get('/files/anything').set('X-System-Code', 'NOPE');
  expect(response.status).toBe(401);
  expect(response.body).toEqual({ error: 'Unknown system code' });
});

test.each(['POS', 'CRMS', 'IMS', 'HRMS', 'ECOM'])('accepts %s and reaches the route lookup', async code => {
  const response = await request(app).get('/files/anything').set('X-System-Code', code);
  expect(response.status).toBe(404);
  expect(response.body).toEqual({ error: 'Not found' });
});

test('refuses a missing system code before reading the body', async () => {
  const response = await request(app).post('/files').set('Content-Type', 'application/json').send('{oops');
  expect(response.status).toBe(401);
});

test('malformed JSON uses the short error shape', async () => {
  const response = await request(app).post('/files').set('X-System-Code', 'POS').set('Content-Type', 'application/json').send('{oops');
  expect(response.status).toBe(400);
  expect(response.body).toEqual({ error: 'Invalid request' });
});

test('seeds only the five Client Systems and has no API keys table', async () => {
  const systems = await pool.query('SELECT code FROM client_systems ORDER BY code');
  expect(systems.rows.map(row => row.code)).toEqual(['CRMS', 'ECOM', 'HRMS', 'IMS', 'POS']);
  const keys = await pool.query("SELECT to_regclass('api_keys') AS found");
  expect(keys.rows[0].found).toBeNull();
});

test('the fake R2 signs, accepts and removes objects', async () => {
  const url = await store.presignPut('public', 'abc/original', { contentType: 'image/png', expiresInSeconds: 900 });
  expect(() => store.upload(url, new Uint8Array([1]), 'text/plain')).toThrow();
  store.upload(url, new Uint8Array([1, 2, 3]), 'image/png');
  expect(await store.head('public', 'abc/original')).toEqual({ size: 3, contentType: 'image/png' });
  await store.deletePrefix('public', 'abc/');
  expect(await store.head('public', 'abc/original')).toBeNull();
});

test('writeAudit records the system code and actor id', async () => {
  await writeAudit(drizzle(pool), { action: 'test.skeleton', systemCode: 'IMS', actorId: 'user-7' });
  const rows = await pool.query("SELECT system_code, actor_id FROM file_audit_entries WHERE action = 'test.skeleton'");
  expect(rows.rows.at(-1)).toEqual({ system_code: 'IMS', actor_id: 'user-7' });
});
