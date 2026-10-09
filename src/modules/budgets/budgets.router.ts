// src/modules/budgets/budgets.router.ts
import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import * as controller from './budgets.controller';

const router = Router();
router.use(authenticate);

router.get('/', controller.list);
router.put('/:categoryId', controller.upsert);

export { router as budgetsRouter };
