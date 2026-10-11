import { changeLink } from '../files/links.ts';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { confirmUpload, editFile, listFiles, requestUpload, viewFile } from '../files/files.ts';
import type { FileDeps } from '../files/files.ts';

const caller = (res: Response) => ({ systemCode: res.locals.systemCode, actorId: res.locals.actorId });
const idOf = (req: Request) => String(req.params.id);

export function filesRouter(deps: FileDeps) {
  const router = Router();
  router.post('/files', async (req, res, next) => {
    try { res.status(201).json(await requestUpload(deps, caller(res), req.body)); } catch (error) { next(error); }
  });
  router.post('/files/:id/confirm', async (req, res, next) => {
    try { res.json(await confirmUpload(deps, caller(res), idOf(req))); } catch (error) { next(error); }
  });
  router.get('/files/:id', async (req, res, next) => {
    try { res.json(await viewFile(deps, caller(res), idOf(req))); } catch (error) { next(error); }
  });
  router.patch('/files/:id', async (req, res, next) => {
    try { res.json(await editFile(deps, caller(res), idOf(req), req.body)); } catch (error) { next(error); }
  });
  router.get('/files', async (req, res, next) => {
    try { res.json(await listFiles(deps, req.query)); } catch (error) { next(error); }
  });
  router.post('/files/:id/links', async (req, res, next) => {
    try { await changeLink(deps, caller(res), idOf(req), req.body, 'add'); res.sendStatus(204); } catch (error) { next(error); }
  });
  router.delete('/files/:id/links', async (req, res, next) => {
    try { await changeLink(deps, caller(res), idOf(req), req.body, 'remove'); res.sendStatus(204); } catch (error) { next(error); }
  });
  return router;
}
