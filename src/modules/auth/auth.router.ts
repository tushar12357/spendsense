// src/modules/auth/auth.router.ts
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../../middleware/authenticate';
import { env } from '../../config/env';
import * as controller from './auth.controller';

const router = Router();

// Brute-force protection on credential endpoints (keyed by client IP).
const authLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later', details: [] } },
});

router.post('/register', authLimiter, controller.registerHandler);
router.post('/login', authLimiter, controller.loginHandler);
router.get('/me', authenticate, controller.getMeHandler);
router.post('/change-password', authLimiter, authenticate, controller.changePasswordHandler);

export { router as authRouter };
