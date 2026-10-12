// src/modules/merchant-rules/merchant-rules.router.ts
import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import * as controller from './merchant-rules.controller';

const router = Router();
router.use(authenticate);

router.get('/', controller.list);
router.post('/', controller.create);
router.patch('/:id', controller.update);
router.delete('/:id', controller.remove);
router.post('/:id/apply', controller.apply);

export { router as merchantRulesRouter };
