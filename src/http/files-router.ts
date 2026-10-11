import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';
import { z } from 'zod';
import { changeLink } from '../files/links.ts';
import { confirmReplacement, confirmUpload, deleteFile, editFile, listFiles, requestReplacement, requestUpload, viewFile } from '../files/files.ts';
import type { FileDeps } from '../files/files.ts';
import { HttpError } from './errors.ts';
import { routes } from './contract.ts';

const caller = (res: Response) => ({ systemCode: res.locals.systemCode, actorId: res.locals.actorId });
const idOf = (req: Request) => String(req.params.id);

// Parses with the route's schema; the first failing rule is the message, all of them are the details.
export function parseWith<T extends ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  throw new HttpError(400, result.error.issues[0]!.message, result.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })));
}

export function filesRouter(deps: FileDeps) {
  const router = Router();
  const handle = (run: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    async (req, res, next) => { try { await run(req, res); } catch (error) { next(error); } };

  router.post(routes.requestUpload.path, handle(async (req, res) => {
    res.status(201).json(await requestUpload(deps, caller(res), parseWith(routes.requestUpload.body, req.body)));
  }));
  router.post(routes.confirmUpload.path, handle(async (req, res) => {
    res.json(await confirmUpload(deps, caller(res), idOf(req)));
  }));
  router.post(routes.requestReplacement.path, handle(async (req, res) => {
    res.status(201).json(await requestReplacement(deps, caller(res), idOf(req), parseWith(routes.requestReplacement.body, req.body)));
  }));
  router.post(routes.confirmReplacement.path, handle(async (req, res) => {
    res.json(await confirmReplacement(deps, caller(res), idOf(req)));
  }));
  router.get(routes.viewFile.path, handle(async (req, res) => {
    res.json(await viewFile(deps, caller(res), idOf(req)));
  }));
  router.patch(routes.editFile.path, handle(async (req, res) => {
    res.json(await editFile(deps, caller(res), idOf(req), parseWith(routes.editFile.body, req.body)));
  }));
  router.delete(routes.deleteFile.path, handle(async (req, res) => {
    await deleteFile(deps, caller(res), idOf(req));
    res.sendStatus(204);
  }));
  router.get(routes.listFiles.path, handle(async (req, res) => {
    res.json(await listFiles(deps, parseWith(routes.listFiles.query, req.query)));
  }));
  router.post(routes.addLink.path, handle(async (req, res) => {
    await changeLink(deps, caller(res), idOf(req), parseWith(routes.addLink.body, req.body), 'add');
    res.sendStatus(204);
  }));
  router.delete(routes.removeLink.path, handle(async (req, res) => {
    await changeLink(deps, caller(res), idOf(req), parseWith(routes.removeLink.body, req.body), 'remove');
    res.sendStatus(204);
  }));
  return router;
}
