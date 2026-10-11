import express from 'express';
import { Pool } from 'pg';
import { createApp } from './http/app.ts';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const port = Number(process.env.PORT ?? 3000);
// Vercel only detects an Express entrypoint (app, index or server in the root or src/) that imports express.
const server = express().use(createApp({ pool }));
server.listen(port, () => { console.log(`file-storage listening on :${port}`); });
