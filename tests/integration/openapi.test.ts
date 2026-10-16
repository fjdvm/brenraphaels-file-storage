import { afterAll, beforeAll, expect, test } from 'vitest';
import request from 'supertest';
import type { Pool } from 'pg';
import { createTestApp } from '../support/test-app.ts';
import { routes } from '../../src/http/contract.ts';

let app: Awaited<ReturnType<typeof createTestApp>>['app'];
let rawApp: Awaited<ReturnType<typeof createTestApp>>['rawApp'];
let pool: Pool;
beforeAll(async () => { ({ app, rawApp, pool } = await createTestApp()); });
afterAll(async () => { await pool.end(); });

interface Layer { route?: { path: string; methods: Record<string, boolean> }; handle?: { stack?: Layer[] } }
// Every method + path Express will answer, found by walking the app's router.
function servedRoutes(layers: Layer[]): string[] {
  return layers.flatMap(layer => layer.route
    ? Object.keys(layer.route.methods).map(method => `${method} ${layer.route!.path}`)
    : servedRoutes(layer.handle?.stack ?? []));
}
const toOpenApi = (path: string) => path.replace(/:(\w+)/g, '{$1}');

async function document() {
  const response = await request(app).get('/openapi.json').expect(200);
  return response.body as { openapi: string; paths: Record<string, Record<string, any>>; components: any };
}

test('the document is served without a system code', async () => {
  expect((await document()).openapi).toBe('3.1.0');
});

test('every route the app serves is in the document, and nothing else is', async () => {
  const served = servedRoutes((rawApp as any).router.stack).map(route => {
    const [method, path] = route.split(' ') as [string, string];
    return `${method} ${toOpenApi(path)}`;
  }).sort();
  const { paths } = await document();
  const documented = Object.entries(paths).flatMap(([path, methods]) => Object.keys(methods).map(method => `${method} ${path}`)).sort();
  expect(documented).toEqual(served);
  expect(documented).toHaveLength(Object.keys(routes).length);
});

test('each operation lists its inputs and errors', async () => {
  const { paths } = await document();
  const upload = paths['/files']!.post;
  expect(upload.requestBody.content['application/json'].schema.required).toEqual(expect.arrayContaining(['filename', 'contentType', 'size', 'visibility', 'retentionType']));
  expect(upload.requestBody.content['application/json'].schema.properties.visibility.enum).toEqual(['public', 'private']);
  expect(Object.keys(upload.responses)).toEqual(['201', '400', '401', '413', '500']);

  const view = paths['/files/{id}']!.get;
  expect(view.parameters).toContainEqual(expect.objectContaining({ name: 'id', in: 'path', required: true }));
  expect(Object.keys(view.responses)).toEqual(['200', '400', '401', '404', '413', '500']);

  const list = paths['/files']!.get;
  expect(list.parameters.filter((p: any) => p.required).map((p: any) => p.name)).toEqual(['system', 'entityType', 'entityId']);
  expect(list.parameters.map((p: any) => p.name)).toEqual(expect.arrayContaining(['role', 'page']));
});

test('the body schema in the document matches what the route enforces', async () => {
  const { paths } = await document();
  const maxSize = paths['/files']!.post.requestBody.content['application/json'].schema.properties.size.maximum;
  const headers = { 'X-System-Code': 'IMS' };
  const body = { filename: 'a.png', contentType: 'image/png', visibility: 'public', retentionType: 'permanent' };
  await request(app).post('/files').set(headers).send({ ...body, size: maxSize }).expect(201);
  const refused = await request(app).post('/files').set(headers).send({ ...body, size: maxSize + 1 }).expect(400);
  expect(refused.body).toMatchObject({ error: 'size must be 25 MB or less', details: [{ path: 'size' }] });
});
