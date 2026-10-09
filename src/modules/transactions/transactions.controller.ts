// src/modules/transactions/transactions.controller.ts
import type { Request, Response, NextFunction } from 'express';
import { requireUser } from '../../middleware/authenticate';
import { transactionQuerySchema, updateTransactionSchema } from './transactions.schema';
import * as service from './transactions.service';

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { sub } = requireUser(req);
    const query = transactionQuerySchema.parse(req.query);
    res.json(await service.listTransactions(sub, query));
  } catch (err) { next(err); }
}

export async function get(req: Request, res: Response, next: NextFunction) {
  try {
    const { sub } = requireUser(req);
    res.json(await service.getTransaction(sub, req.params['id'] as string));
  } catch (err) { next(err); }
}

export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const { sub } = requireUser(req);
    const input = updateTransactionSchema.parse(req.body);
    res.json(await service.updateTransaction(sub, req.params['id'] as string, input));
  } catch (err) { next(err); }
}

export async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    const { sub } = requireUser(req);
    await service.deleteTransaction(sub, req.params['id'] as string);
    res.status(204).send();
  } catch (err) { next(err); }
}
