// src/modules/budgets/budgets.controller.ts
import type { Request, Response } from 'express';
import { requireUser } from '../../middleware/authenticate';
import { uuidSchema } from '../../shared/validation/pagination.schema';
import { yearMonthQuery } from '../../shared/validation/money';
import { getUserTimezone } from '../users/users.service';
import * as service from './budgets.service';

export async function list(req: Request, res: Response) {
  const { sub } = requireUser(req);
  const { year, month } = yearMonthQuery.parse(req.query);
  res.json(await service.listBudgets(sub, await getUserTimezone(sub), year, month));
}

export async function upsert(req: Request, res: Response) {
  const { sub } = requireUser(req);
  const input = service.upsertBudgetSchema.parse(req.body);
  res.json(await service.upsertBudget(sub, uuidSchema.parse(req.params['categoryId']), input, await getUserTimezone(sub)));
}

export async function remove(req: Request, res: Response) {
  const { sub } = requireUser(req);
  const { year, month } = yearMonthQuery.parse(req.query);
  await service.deleteBudget(sub, uuidSchema.parse(req.params['categoryId']), await getUserTimezone(sub), year, month);
  res.status(204).send();
}
