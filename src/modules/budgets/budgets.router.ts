// src/modules/budgets/budgets.router.ts
import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import * as controller from './budgets.controller';

const router = Router();
router.use(authenticate);

router.get('/', controller.list);
router.put('/:categoryId', controller.upsert);
router.delete('/:categoryId', controller.remove);

export { router as budgetsRouter };
