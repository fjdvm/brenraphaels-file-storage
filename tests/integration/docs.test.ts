import { expect, test } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../../src/http/app.ts';
import { FakeR2 } from '../support/fake-r2.ts';
import { routes } from '../../src/http/contract.ts';

// The guide is static, so no query runs and no database is needed.
const app = createApp({ pool: new Pool(), store: new FakeR2(), publicBaseUrl: 'https://cdn.test', cronSecret: 'secret', gatewaySecret: 'gateway' });

async function guide() {
  const response = await request(app).get('/docs');
  expect(response.status).toBe(200);
  expect(response.type).toBe('text/html');
  return response.text;
}

test('serves the guide without a system code', async () => {
  expect(await guide()).toContain('File Storage API');
});

test('names every endpoint', async () => {
  const html = await guide();
  for (const spec of Object.values(routes)) {
    expect(html, `${spec.method} ${spec.path}`).toContain(`id:'${spec.method}-${spec.path.replace(/[/:]+/g, '-').replace(/^-|-$/g, '')}'`);
    expect(html).toContain(`path:'${spec.path}'`);
  }
});

test('has Start here with the documented headers and the Public or Private rule', async () => {
  const html = await guide();
  expect(html).toContain('Start here');
  expect(html).toContain('X-System-Code');
  expect(html).toContain('X-Actor-Id');
  expect(html).toMatch(/Public[^`]*Private/);
});

test('every example is written against $BASE_URL so the base-URL box can rewrite it', async () => {
  const html = await guide();
  expect(html).toContain('id="base"');
  expect(html).toContain("replaceAll('$BASE_URL'");
  expect(html).not.toMatch(/curl[^\n]*"https?:\/\//);
});

test('keeps the Files routes behind a system code', async () => {
  expect((await request(app).get('/files')).status).toBe(401);
});

test('shows the install snippet for all four agent clients', async () => {
  const html = await guide();
  expect(html).toContain('Use it from an agent');
  for (const snippet of ['claude mcp add --transport http file-storage', '[mcp_servers.file-storage]', '.cursor/mcp.json', '.kiro/settings/mcp.json']) {
    expect(html).toContain(snippet);
  }
});
