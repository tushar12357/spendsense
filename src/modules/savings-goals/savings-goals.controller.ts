// src/modules/savings-goals/savings-goals.controller.ts
import type { Request, Response } from 'express';
import { requireUser } from '../../middleware/authenticate';
import { uuidSchema } from '../../shared/validation/pagination.schema';
import { getUserTimezone } from '../users/users.service';
import * as service from './savings-goals.service';

export async function list(req: Request, res: Response) {
  const { sub } = requireUser(req);
  res.json(await service.listGoals(sub, await getUserTimezone(sub)));
}

export async function create(req: Request, res: Response) {
  const { sub } = requireUser(req);
  const input = service.createGoalSchema.parse(req.body);
  res.status(201).json(await service.createGoal(sub, input, await getUserTimezone(sub)));
}

export async function update(req: Request, res: Response) {
  const { sub } = requireUser(req);
  const input = service.updateGoalSchema.parse(req.body);
  res.json(await service.updateGoal(sub, uuidSchema.parse(req.params['id']), input, await getUserTimezone(sub)));
}

export async function remove(req: Request, res: Response) {
  await service.deleteGoal(requireUser(req).sub, uuidSchema.parse(req.params['id']));
  res.status(204).send();
}
