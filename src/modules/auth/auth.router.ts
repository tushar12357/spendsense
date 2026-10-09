// src/modules/auth/auth.router.ts
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../../middleware/authenticate';
import { env } from '../../config/env';
import * as controller from './auth.controller';

const router = Router();

const authLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later' } },
});

router.post('/register', authLimiter, controller.registerHandler);
router.post('/login', authLimiter, controller.loginHandler);
router.get('/me', authenticate, controller.getMeHandler);

export { router as authRouter };
