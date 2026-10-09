// src/modules/savings-goals/savings-goals.controller.ts
import type { Request, Response, NextFunction } from 'express';
import { requireUser } from '../../middleware/authenticate';
import * as service from './savings-goals.service';

export async function list(req: Request, res: Response, next: NextFunction) {
  try { res.json(await service.listGoals(requireUser(req).sub)); }
  catch (err) { next(err); }
}

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const { sub } = requireUser(req);
    const input = service.createGoalSchema.parse(req.body);
    res.status(201).json(await service.createGoal(sub, input));
  } catch (err) { next(err); }
}

export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const { sub } = requireUser(req);
    const input = service.updateGoalSchema.parse(req.body);
    res.json(await service.updateGoal(sub, req.params['id'] as string, input));
  } catch (err) { next(err); }
}

export async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    await service.deleteGoal(requireUser(req).sub, req.params['id'] as string);
    res.status(204).send();
  } catch (err) { next(err); }
}
