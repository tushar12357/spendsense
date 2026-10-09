// src/modules/accounts/accounts.router.ts
import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import * as controller from './accounts.controller';

const router = Router();
router.use(authenticate);

router.get('/', controller.list);
router.post('/', controller.create);
router.get('/:id', controller.get);
router.patch('/:id', controller.update);
router.delete('/:id', controller.remove);

export { router as accountsRouter };
