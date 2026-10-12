// src/app.ts
// Express application factory - no side effects on import (tests build their own instance).

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { logger } from './infrastructure/logging/logger';
import { requestId } from './middleware/request-id';
import { errorHandler } from './middleware/error-handler';
import { healthRouter } from './modules/health/health.router';
import { authRouter } from './modules/auth/auth.router';
import { usersRouter } from './modules/users/users.router';
import { accountsRouter } from './modules/accounts/accounts.router';
import { categoriesRouter } from './modules/categories/categories.router';
import { merchantRulesRouter } from './modules/merchant-rules/merchant-rules.router';
import { transactionsRouter } from './modules/transactions/transactions.router';
import { importsRouter } from './modules/imports/imports.router';
import { analyticsRouter } from './modules/analytics/analytics.router';
import { budgetsRouter } from './modules/budgets/budgets.router';
import { savingsGoalsRouter } from './modules/savings-goals/savings-goals.router';
import { openApiDocument } from './docs/openapi';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Behind a load balancer the client IP (used for rate limiting) comes from X-Forwarded-For.
  if (env.TRUST_PROXY > 0) app.set('trust proxy', env.TRUST_PROXY);

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.headers['x-request-id'] as string,
      autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      // Log shape only: no bodies, no query strings (they can carry search terms / amounts).
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: String(req.url).split('?')[0] }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  app.use(helmet());
  const origins = env.ALLOWED_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean);
  app.use(
    cors({
      origin: origins && origins.length > 0 ? origins : env.NODE_ENV === 'production' ? false : true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
      exposedHeaders: ['X-Request-ID', 'Location'],
      maxAge: 600,
    }),
  );
  app.use(compression());

  // Probes first: they must stay cheap and un-throttled.
  app.use('/health', healthRouter);

  // Global per-IP throttle for the API surface (auth and uploads add stricter limits of their own).
  app.use(
    '/api',
    rateLimit({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      limit: env.RATE_LIMIT_MAX_REQUESTS,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later', details: [] } },
    }),
  );

  app.use(express.json({ limit: '1mb' }));

  app.get('/api/v1/openapi.json', (_req, res) => res.json(openApiDocument));

  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/users', usersRouter);
  app.use('/api/v1/accounts', accountsRouter);
  app.use('/api/v1/categories', categoriesRouter);
  app.use('/api/v1/merchant-rules', merchantRulesRouter);
  app.use('/api/v1/transactions', transactionsRouter);
  app.use('/api/v1/imports', importsRouter);
  app.use('/api/v1/budgets', budgetsRouter);
  app.use('/api/v1/savings-goals', savingsGoalsRouter);
  app.use('/api/v1', analyticsRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found', details: [] } });
  });

  app.use(errorHandler); // must be last
  return app;
}
