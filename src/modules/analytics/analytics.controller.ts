// src/modules/analytics/analytics.controller.ts
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { requireUser } from '../../middleware/authenticate';
import * as service from './analytics.service';
import { prisma } from '../../infrastructure/database/prisma';

const periodSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  months: z.coerce.number().int().min(1).max(24).default(12),
});

async function getUserTimezone(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId }, select: { timezone: true },
  });
  return user?.timezone ?? 'Asia/Kolkata';
}

export async function summary(req: Request, res: Response, next: NextFunction) {
  try {
    const { sub } = requireUser(req);
    const tz = await getUserTimezone(sub);
    res.json(await service.getDashboardSummary(sub, tz));
  } catch (err) { next(err); }
}

export async function categories(req: Request, res: Response, next: NextFunction) {
  try {
    const { sub } = requireUser(req);
    const { year, month } = periodSchema.parse(req.query);
    const tz = await getUserTimezone(sub);
    res.json(await service.getCategoryBreakdown(sub, tz, year, month));
  } catch (err) { next(err); }
}

export async function trends(req: Request, res: Response, next: NextFunction) {
  try {
    const { sub } = requireUser(req);
    const { months } = periodSchema.parse(req.query);
    const tz = await getUserTimezone(sub);
    res.json(await service.getMonthlyTrends(sub, tz, months));
  } catch (err) { next(err); }
}
