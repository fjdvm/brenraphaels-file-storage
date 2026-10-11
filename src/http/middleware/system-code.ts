import type { RequestHandler } from 'express';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { clientSystems } from '../../db/schema.ts';
import { HttpError } from '../errors.ts';

declare module 'express-serve-static-core' {
  interface Locals { systemCode: string; actorId: string | null }
}

// Resolves the calling Client System from X-System-Code and captures the optional X-Actor-Id.
export function requireSystemCode(db: NodePgDatabase): RequestHandler {
  return async (req, res, next) => {
    try {
      const code = req.header('x-system-code')?.trim();
      if (!code) throw new HttpError(401, 'X-System-Code header is required');
      const [system] = await db.select().from(clientSystems).where(eq(clientSystems.code, code));
      if (!system) throw new HttpError(401, 'Unknown system code');
      res.locals.systemCode = system.code;
      res.locals.actorId = req.header('x-actor-id')?.trim() || null;
      next();
    } catch (error) { next(error); }
  };
}
