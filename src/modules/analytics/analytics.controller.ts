// src/modules/analytics/analytics.controller.ts
import type { Request, Response } from 'express';
import { z } from 'zod';
import { requireUser } from '../../middleware/authenticate';
import { yearMonthQuery } from '../../shared/validation/money';
import { getUserTimezone } from '../users/users.service';
import * as analytics from './analytics.service';
import * as insights from './insights.service';

const trendsQuery = z.object({ months: z.coerce.number().int().min(1).max(36).default(12) });

export async function summary(req: Request, res: Response) {
  const { sub } = requireUser(req);
  const { year, month } = yearMonthQuery.parse(req.query);
  res.json(await analytics.getDashboardSummary(sub, await getUserTimezone(sub), year, month));
}

export async function categories(req: Request, res: Response) {
  const { sub } = requireUser(req);
  const { year, month } = yearMonthQuery.parse(req.query);
  res.json(await analytics.getCategoryBreakdown(sub, await getUserTimezone(sub), year, month));
}

export async function trends(req: Request, res: Response) {
  const { sub } = requireUser(req);
  const { months } = trendsQuery.parse(req.query);
  res.json(await analytics.getMonthlyTrends(sub, await getUserTimezone(sub), months));
}

export async function insightsHandler(req: Request, res: Response) {
  const { sub } = requireUser(req);
  res.json(await insights.getInsights(sub, await getUserTimezone(sub)));
}
