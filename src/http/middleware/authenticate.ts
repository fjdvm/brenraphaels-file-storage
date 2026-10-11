import type { RequestHandler } from 'express';

// Placeholder: runs after the system check and allows everything. Real authentication goes here.
export const authenticate: RequestHandler = (_req, _res, next) => { next(); };
