// src/modules/analytics/analytics.router.ts
// Mounted at /api/v1: dashboard, analytics and insights live side by side.
import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import * as controller from './analytics.controller';

const router = Router();
// Auth is attached per route (not router.use) because this router is mounted at the API root:
// a blanket guard would turn every unknown /api/v1/* path into a 401 instead of a 404.
router.get('/dashboard/summary', authenticate, controller.summary);
router.get('/analytics/categories', authenticate, controller.categories);
router.get('/analytics/trends', authenticate, controller.trends);
router.get('/insights', authenticate, controller.insightsHandler);

export { router as analyticsRouter };
