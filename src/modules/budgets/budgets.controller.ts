// src/modules/budgets/budgets.controller.ts
import type { Request, Response, NextFunction } from 'express';
import { requireUser } from '../../middleware/authenticate';
import { prisma } from '../../infrastructure/database/prisma';
import * as service from './budgets.service';

async function getUserTimezone(userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });
  return u?.timezone ?? 'Asia/Kolkata';
}

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { sub } = requireUser(req);
    const tz = await getUserTimezone(sub);
    res.json(await service.listBudgets(sub, tz));
  } catch (err) { next(err); }
}

export async function upsert(req: Request, res: Response, next: NextFunction) {
  try {
    const { sub } = requireUser(req);
    const tz = await getUserTimezone(sub);
    const input = service.upsertBudgetSchema.parse(req.body);
    res.json(await service.upsertBudget(sub, req.params['categoryId'] as string, input, tz));
  } catch (err) { next(err); }
}
