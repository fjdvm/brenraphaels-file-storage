import express from 'express';
import type { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { ObjectStore } from '../storage/object-store.ts';
import { errorHandler, notFound } from './errors.ts';
import { requireGatewaySecret } from './middleware/gateway-secret.ts';
import { requireSystemCode } from './middleware/system-code.ts';
import { cronRouter } from './cron-router.ts';
import { filesRouter } from './files-router.ts';
import { authenticate } from './middleware/authenticate.ts';
import { routes } from './contract.ts';
import { buildOpenApiDocument } from './openapi.ts';
import { mcpRouter } from '../mcp/mcp-router.ts';
import { guide } from './docs.ts';

export interface AppDeps { pool: Pool; store: ObjectStore; publicBaseUrl: string; cronSecret: string; gatewaySecret: string }

export function createApp({ pool, store, publicBaseUrl, cronSecret, gatewaySecret }: AppDeps) {
  const db = drizzle(pool);
  const app = express();
  const openApiDocument = buildOpenApiDocument();
  app.get(routes.health.path, (_req, res) => { res.json({ status: 'ok' }); });
  app.get(routes.openapi.path, (_req, res) => { res.json(openApiDocument); });

  app.get(routes.docs.path, (_req, res) => { res.type('html').send(guide()); });

  app.use(cronRouter({ db, store, cronSecret }));

  // Everything below the open routes needs the gateway secret and a known Client System.
  const api = express.Router();
  api.use(requireGatewaySecret(gatewaySecret), requireSystemCode(db), authenticate, express.json({ limit: '16kb' }));
  api.use(filesRouter({ db, store, publicBaseUrl }));
  api.use(mcpRouter({ db, store, publicBaseUrl }));
  app.use(api);

  app.use(notFound, errorHandler);
  return app;
}
