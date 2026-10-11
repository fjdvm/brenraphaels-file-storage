import type { ErrorRequestHandler, RequestHandler } from 'express';

// Every error looks like { error: 'short message', details?: ... }.
export class HttpError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const notFound: RequestHandler = (_req, _res, next) => { next(new HttpError(404, 'Not found')); };

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof HttpError) {
    res.status(error.status).json(error.details === undefined ? { error: error.message } : { error: error.message, details: error.details });
    return;
  }
  // body-parser errors carry their own 4xx status; anything else is ours.
  const status = typeof error?.status === 'number' && error.status >= 400 && error.status < 500 ? error.status : 500;
  if (status === 500) console.error(error);
  res.status(status).json({ error: status === 500 ? 'Internal server error' : 'Invalid request' });
};
