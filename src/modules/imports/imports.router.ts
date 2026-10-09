// src/modules/imports/imports.router.ts
import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../../middleware/authenticate';
import { env } from '../../config/env';
import * as controller from './imports.controller';

const router = Router();
router.use(authenticate);

// Store file in memory — max size enforced, cleanup automatic
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_FILE_SIZE_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are accepted'));
    }
  },
});

router.post('/', upload.single('file'), controller.upload);
router.get('/', controller.list);
router.get('/:id', controller.get);
router.get('/:id/rows', controller.getRows);

export { router as importsRouter };
