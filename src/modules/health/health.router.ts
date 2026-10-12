// src/modules/health/health.router.ts
// /health        liveness  - the process is up (no dependencies touched)
// /health/ready  readiness - the database (and Redis, when background imports are on) respond

import { Router } from 'express';
import { env } from '../../config/env';
import { pingDatabase } from '../../infrastructure/database/prisma';
import { pingRedis } from '../../infrastructure/queue/import-queue';

const router = Router();

router.get('/', (_req, res) => {
  res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()), timestamp: new Date().toISOString() });
});

router.get('/ready', async (_req, res) => {
  const checks: Record<string, 'ok' | 'down'> = {};
  await pingDatabase().then(() => (checks['database'] = 'ok'), () => (checks['database'] = 'down'));
  if (env.IMPORT_ASYNC) {
    await pingRedis().then(() => (checks['redis'] = 'ok'), () => (checks['redis'] = 'down'));
  }
  const ready = Object.values(checks).every((v) => v === 'ok');
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unavailable', checks });
});

export { router as healthRouter };
