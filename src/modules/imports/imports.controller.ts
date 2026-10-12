// src/modules/imports/imports.controller.ts
import type { Request, Response } from 'express';
import { requireUser } from '../../middleware/authenticate';
import { AppError } from '../../shared/errors/AppError';
import { uuidSchema } from '../../shared/validation/pagination.schema';
import { importQuerySchema, importRowQuerySchema, uploadSchema } from './imports.schema';
import * as service from './imports.service';

export async function upload(req: Request, res: Response) {
  const { sub } = requireUser(req);
  if (!req.file) {
    throw AppError.badRequest('No file uploaded', [{ field: 'file', message: 'Send the CSV as multipart field "file"' }]);
  }
  const input = uploadSchema.parse(req.body);
  const correlationId = String(req.headers['x-request-id'] ?? '');
  const result = await service.uploadImport(sub, req.file, input, correlationId);

  if (result.mode === 'sync') {
    res.status(201).json(result.summary);
  } else {
    // 202 Accepted: processing continues in the background; poll GET /imports/:id until isFinished.
    res.status(202).location(`/api/v1/imports/${result.batch.id}`).json({ batchId: result.batch.id, ...result.batch });
  }
}

export function adapters(_req: Request, res: Response) {
  res.json(service.getAdapters());
}

export async function list(req: Request, res: Response) {
  res.json(await service.listImports(requireUser(req).sub, importQuerySchema.parse(req.query)));
}

export async function get(req: Request, res: Response) {
  res.json(await service.getImport(requireUser(req).sub, uuidSchema.parse(req.params['id'])));
}

export async function getRows(req: Request, res: Response) {
  const query = importRowQuerySchema.parse(req.query);
  res.json(await service.getImportRows(requireUser(req).sub, uuidSchema.parse(req.params['id']), query));
}
