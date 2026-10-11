import express from 'express';
import { Pool } from 'pg';
import { createApp } from './http/app.ts';
import { R2ObjectStore } from './storage/r2.ts';

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
const pool = new Pool({ connectionString: required('DATABASE_URL') });
const port = Number(process.env.PORT ?? 3000);
// Vercel only detects an Express entrypoint (app, index or server in the root or src/) that imports express.
const server = express().use(createApp({
  pool,
  publicBaseUrl: required('R2_PUBLIC_BASE_URL'),
  store: new R2ObjectStore({
    accountId: required('R2_ACCOUNT_ID'), accessKeyId: required('R2_ACCESS_KEY_ID'), secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
    publicBucket: required('R2_PUBLIC_BUCKET'), privateBucket: required('R2_PRIVATE_BUCKET'),
  }),
}));
server.listen(port, () => { console.log(`file-storage listening on :${port}`); });
