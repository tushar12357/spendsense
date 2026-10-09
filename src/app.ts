// src/app.ts
// Express application factory — no side-effects on import.
// All routers are mounted here. Error handler registered last.

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pinoHttp from 'pino-http';
import { logger } from './infrastructure/logging/logger';
import { requestId } from './middleware/request-id';
import { errorHandler } from './middleware/error-handler';
import { authRouter } from './modules/auth/auth.router';
import { accountsRouter } from './modules/accounts/accounts.router';
import { categoriesRouter } from './modules/categories/categories.router';
import { transactionsRouter } from './modules/transactions/transactions.router';
import { importsRouter } from './modules/imports/imports.router';
import { analyticsRouter } from './modules/analytics/analytics.router';
import { budgetsRouter } from './modules/budgets/budgets.router';
import { savingsGoalsRouter } from './modules/savings-goals/savings-goals.router';

export function createApp() {
  const app = express();

  // ── Security headers ────────────────────────────────────────
  app.use(helmet());
  app.use(cors({
    origin: process.env['ALLOWED_ORIGINS']?.split(',') ?? '*',
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
    exposedHeaders: ['X-Request-ID'],
  }));

  // ── Request correlation ──────────────────────────────────────
  app.use(requestId);

  // ── Structured request logging ───────────────────────────────
  app.use(pinoHttp({
    logger,
    customLogLevel: (_req, res) => res.statusCode >= 500 ? 'error' : 'info',
    redact: ['req.headers.authorization', 'req.headers.cookie'],
  }));

  // ── Body parsing ─────────────────────────────────────────────
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  // ── Health endpoints ─────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ── API routes ───────────────────────────────────────────────
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/accounts', accountsRouter);
  app.use('/api/v1/categories', categoriesRouter);
  app.use('/api/v1/transactions', transactionsRouter);
  app.use('/api/v1/imports', importsRouter);
  app.use('/api/v1', analyticsRouter);
  app.use('/api/v1/budgets', budgetsRouter);
  app.use('/api/v1/savings-goals', savingsGoalsRouter);

  // ── 404 handler ──────────────────────────────────────────────
  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  // ── Central error handler — MUST be last ─────────────────────
  app.use(errorHandler);

  return app;
}
