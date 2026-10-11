import express from 'express';
import type { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { ObjectStore } from '../storage/object-store.ts';
import { errorHandler, notFound } from './errors.ts';
import { requireSystemCode } from './middleware/system-code.ts';
import { authenticate } from './middleware/authenticate.ts';

export interface AppDeps { pool: Pool; store?: ObjectStore }

export function createApp({ pool }: AppDeps) {
  const db = drizzle(pool);
  const app = express();
  app.get('/health', (_req, res) => { res.json({ status: 'ok' }); });

  // Everything below the health route needs a known Client System.
  const api = express.Router();
  api.use(requireSystemCode(db), authenticate, express.json({ limit: '16kb' }));
  app.use(api);

  app.use(notFound, errorHandler);
  return app;
}
