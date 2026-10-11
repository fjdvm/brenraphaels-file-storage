import express from 'express';
import type { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { ObjectStore } from '../storage/object-store.ts';
import { errorHandler, notFound } from './errors.ts';
import { requireSystemCode } from './middleware/system-code.ts';
import { filesRouter } from './files-router.ts';
import { authenticate } from './middleware/authenticate.ts';
import { routes } from './contract.ts';
import { buildOpenApiDocument } from './openapi.ts';

export interface AppDeps { pool: Pool; store: ObjectStore; publicBaseUrl: string }

export function createApp({ pool, store, publicBaseUrl }: AppDeps) {
  const db = drizzle(pool);
  const app = express();
  const openApiDocument = buildOpenApiDocument();
  app.get(routes.health.path, (_req, res) => { res.json({ status: 'ok' }); });
  app.get(routes.openapi.path, (_req, res) => { res.json(openApiDocument); });

  // Everything below the open routes needs a known Client System.
  const api = express.Router();
  api.use(requireSystemCode(db), authenticate, express.json({ limit: '16kb' }));
  api.use(filesRouter({ db, store, publicBaseUrl }));
  app.use(api);

  app.use(notFound, errorHandler);
  return app;
}
