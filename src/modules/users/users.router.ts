// src/modules/users/users.router.ts
import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import * as controller from './users.controller';

const router = Router();
router.use(authenticate);

router.get('/me', controller.me);
router.patch('/me', controller.update);
router.get('/me/export', controller.exportData);
router.delete('/me', controller.remove);

export { router as usersRouter };
