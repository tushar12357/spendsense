// src/modules/categories/categories.controller.ts
import type { Request, Response } from 'express';
import { requireUser } from '../../middleware/authenticate';
import { uuidSchema } from '../../shared/validation/pagination.schema';
import * as service from './categories.service';

export async function list(req: Request, res: Response) {
  res.json(await service.listCategories(requireUser(req).sub));
}

export async function create(req: Request, res: Response) {
  const input = service.createCategorySchema.parse(req.body);
  res.status(201).json(await service.createCategory(requireUser(req).sub, input));
}

export async function update(req: Request, res: Response) {
  const input = service.updateCategorySchema.parse(req.body);
  res.json(await service.updateCategory(requireUser(req).sub, uuidSchema.parse(req.params['id']), input));
}

export async function remove(req: Request, res: Response) {
  await service.deleteCategory(requireUser(req).sub, uuidSchema.parse(req.params['id']));
  res.status(204).send();
}
