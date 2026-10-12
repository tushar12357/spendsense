// src/modules/transactions/transactions.controller.ts
import type { Request, Response } from 'express';
import { requireUser } from '../../middleware/authenticate';
import { uuidSchema } from '../../shared/validation/pagination.schema';
import { createTransactionSchema, transactionQuerySchema, updateTransactionSchema } from './transactions.schema';
import * as service from './transactions.service';

export async function create(req: Request, res: Response) {
  const input = createTransactionSchema.parse(req.body);
  res.status(201).json(await service.createTransaction(requireUser(req).sub, input));
}

export async function list(req: Request, res: Response) {
  res.json(await service.listTransactions(requireUser(req).sub, transactionQuerySchema.parse(req.query)));
}

export async function get(req: Request, res: Response) {
  res.json(await service.getTransaction(requireUser(req).sub, uuidSchema.parse(req.params['id'])));
}

export async function update(req: Request, res: Response) {
  const input = updateTransactionSchema.parse(req.body);
  res.json(await service.updateTransaction(requireUser(req).sub, uuidSchema.parse(req.params['id']), input));
}

export async function remove(req: Request, res: Response) {
  await service.deleteTransaction(requireUser(req).sub, uuidSchema.parse(req.params['id']));
  res.status(204).send();
}
