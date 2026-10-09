// src/modules/analytics/analytics.router.ts
import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import * as controller from './analytics.controller';

const router = Router();
router.use(authenticate);

router.get('/dashboard/summary', controller.summary);
router.get('/analytics/categories', controller.categories);
router.get('/analytics/trends', controller.trends);

export { router as analyticsRouter };
