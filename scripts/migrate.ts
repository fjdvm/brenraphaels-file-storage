import { Pool } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function migrate(pool: Pool, directory = fileURLToPath(new URL('../migrations/', import.meta.url))) {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const applied = new Set((await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(row => row.name));
  const pending = (await readdir(directory)).filter(name => /^\d{4}_.+\.sql$/.test(name) && !applied.has(name)).sort();
  for (const name of pending) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(await readFile(`${directory}${name}`, 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  return pending;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.DATABASE_URL_UNPOOLED) throw new Error('DATABASE_URL_UNPOOLED is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL_UNPOOLED });
  try { console.log('Applied:', await migrate(pool)); } finally { await pool.end(); }
}
