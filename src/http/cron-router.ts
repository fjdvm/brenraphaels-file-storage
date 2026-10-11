import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { ObjectStore } from '../storage/object-store.ts';
import { runCleanup } from '../files/cleanup.ts';
import { routes } from './contract.ts';
import { HttpError } from './errors.ts';

// Vercel Cron calls this with `Authorization: Bearer $CRON_SECRET`. It sits outside the Client System checks.
export function cronRouter({ db, store, cronSecret }: { db: NodePgDatabase; store: ObjectStore; cronSecret: string }) {
  if (!cronSecret) throw new Error('CRON_SECRET is required');
  const router = express.Router();
  const expected = Buffer.from(`Bearer ${cronSecret}`);
  router.get(routes.cleanup.path, async (req, res, next) => {
    try {
      const given = Buffer.from(req.header('authorization') ?? '');
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new HttpError(401, 'Invalid cron secret');
      const result = await runCleanup({ db, store });
      res.status(result.failures ? 500 : 200).json(result);
    } catch (error) { next(error); }
  });
  return router;
}
