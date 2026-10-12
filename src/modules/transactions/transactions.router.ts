// src/modules/transactions/transactions.router.ts
import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import * as controller from './transactions.controller';

const router = Router();
router.use(authenticate);

router.post('/', controller.create);
router.get('/', controller.list);
router.get('/:id', controller.get);
router.patch('/:id', controller.update);
router.delete('/:id', controller.remove);

export { router as transactionsRouter };
