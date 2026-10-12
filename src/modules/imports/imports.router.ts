// src/modules/imports/imports.router.ts
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { authenticate } from '../../middleware/authenticate';
import { env } from '../../config/env';
import { AppError } from '../../shared/errors/AppError';
import * as controller from './imports.controller';

const router = Router();
router.use(authenticate);

// Files are held in memory (bounded by MAX_FILE_SIZE_MB); nothing touches disk in sync mode.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_FILE_SIZE_MB * 1024 * 1024, files: 1, fields: 10 },
  fileFilter: (_req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() === '.csv') cb(null, true);
    else cb(AppError.unsupportedFile('Only .csv files are accepted'));
  },
});

// Uploads are the expensive operation: limit them per authenticated user, not per IP.
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.sub ?? 'anonymous',
  validate: { keyGeneratorIpFallback: false },
  message: { error: { code: 'RATE_LIMITED', message: 'Too many uploads, please try again later', details: [] } },
});

router.get('/adapters', controller.adapters);
router.post('/', uploadLimiter, upload.single('file'), controller.upload);
router.get('/', controller.list);
router.get('/:id', controller.get);
router.get('/:id/rows', controller.getRows);

export { router as importsRouter };
