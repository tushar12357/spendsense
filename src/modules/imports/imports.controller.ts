// src/modules/imports/imports.controller.ts
import type { Request, Response, NextFunction } from 'express';
import { requireUser } from '../../middleware/authenticate';
import { uploadSchema, importQuerySchema, importRowQuerySchema } from './imports.schema';
import * as service from './imports.service';

export async function upload(req: Request, res: Response, next: NextFunction) {
  try {
    const { sub } = requireUser(req);
    if (!req.file) throw new Error('No file uploaded');
    const input = uploadSchema.parse(req.body);
    const result = await service.uploadImport(sub, req.file, input);
    res.status(201).json(result);
  } catch (err) { next(err); }
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { sub } = requireUser(req);
    const { limit } = importQuerySchema.parse(req.query);
    res.json(await service.listImports(sub, limit));
  } catch (err) { next(err); }
}

export async function get(req: Request, res: Response, next: NextFunction) {
  try {
    const { sub } = requireUser(req);
    res.json(await service.getImport(sub, req.params['id'] as string));
  } catch (err) { next(err); }
}

export async function getRows(req: Request, res: Response, next: NextFunction) {
  try {
    const { sub } = requireUser(req);
    const { status, limit } = importRowQuerySchema.parse(req.query);
    res.json(await service.getImportRows(sub, req.params['id'] as string, { status, limit }));
  } catch (err) { next(err); }
}
