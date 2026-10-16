import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { HttpError } from '../errors.ts';

// file-storage only accepts API requests from the gateway, which proves itself with `Authorization: Bearer $GATEWAY_SECRET`.
export function requireGatewaySecret(gatewaySecret: string): RequestHandler {
  if (!gatewaySecret) throw new Error('GATEWAY_SECRET is required');
  const expected = Buffer.from(`Bearer ${gatewaySecret}`);
  return (req, _res, next) => {
    const given = Buffer.from(req.header('authorization') ?? '');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return next(new HttpError(401, 'Invalid gateway secret'));
    next();
  };
}
