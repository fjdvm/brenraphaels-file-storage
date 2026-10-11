import { Pool } from 'pg';
import { createApp } from '../../src/http/app.ts';
import { migrate } from '../../scripts/migrate.ts';
import { FakeR2 } from './fake-r2.ts';

// Tests run against the Neon "test" branch, never the main branch.
export async function createTestApp() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required (a Neon branch connection string)');
  const pool = new Pool({ connectionString: url });
  await migrate(pool);
  const store = new FakeR2();
  return { app: createApp({ pool, store }), pool, store };
}
