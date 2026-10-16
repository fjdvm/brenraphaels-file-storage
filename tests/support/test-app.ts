import type { RequestListener } from 'node:http';
import { Pool } from 'pg';
import { createApp } from '../../src/http/app.ts';
import { migrate } from '../../scripts/migrate.ts';
import { FakeR2 } from './fake-r2.ts';

export const gatewaySecret = 'test-gateway-secret';

// Tests run against the Neon "test" branch, never the main branch.
export async function createTestApp(store = new FakeR2()) {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required (a Neon branch connection string)');
  const pool = new Pool({ connectionString: url });
  await migrate(pool);
  const rawApp = createApp({ pool, store, publicBaseUrl: 'https://cdn.test', cronSecret: 'test-cron-secret', gatewaySecret });
  // Behaves like the gateway: adds the secret unless the request brings its own Authorization header.
  const app: RequestListener = (req, res) => {
    if (!req.headers.authorization) req.headers.authorization = `Bearer ${gatewaySecret}`;
    rawApp(req, res);
  };
  return { app, rawApp, pool, store };
}
