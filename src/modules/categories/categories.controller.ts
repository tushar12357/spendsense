// src/modules/categories/categories.controller.ts
import type { Request, Response, NextFunction } from 'express';
import { requireUser } from '../../middleware/authenticate';
import * as service from './categories.service';

export async function list(req: Request, res: Response, next: NextFunction) {
  try { res.json(await service.listCategories(requireUser(req).sub)); }
  catch (err) { next(err); }
}

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const { sub } = requireUser(req);
    const input = service.createCategorySchema.parse(req.body);
    res.status(201).json(await service.createCategory(sub, input));
  } catch (err) { next(err); }
}

export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const { sub } = requireUser(req);
    const input = service.updateCategorySchema.parse(req.body);
    res.json(await service.updateCategory(sub, req.params['id'] as string, input));
  } catch (err) { next(err); }
}

export async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    await service.deleteCategory(requireUser(req).sub, req.params['id'] as string);
    res.status(204).send();
  } catch (err) { next(err); }
}
