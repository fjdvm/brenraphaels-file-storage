import express from 'express';
import type { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { ObjectStore } from '../storage/object-store.ts';
import { errorHandler, notFound } from './errors.ts';
import { requireSystemCode } from './middleware/system-code.ts';
import { cronRouter } from './cron-router.ts';
import { filesRouter } from './files-router.ts';
import { authenticate } from './middleware/authenticate.ts';

export interface AppDeps { pool: Pool; store: ObjectStore; publicBaseUrl: string; cronSecret: string }

export function createApp({ pool, store, publicBaseUrl, cronSecret }: AppDeps) {
  const db = drizzle(pool);
  const app = express();
  app.get('/health', (_req, res) => { res.json({ status: 'ok' }); });

  app.use(cronRouter({ db, store, cronSecret }));

  // Everything below the health route needs a known Client System.
  const api = express.Router();
  api.use(requireSystemCode(db), authenticate, express.json({ limit: '16kb' }));
  api.use(filesRouter({ db, store, publicBaseUrl }));
  app.use(api);

  app.use(notFound, errorHandler);
  return app;
}
