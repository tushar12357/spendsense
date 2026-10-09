// src/modules/accounts/accounts.controller.ts
import type { Request, Response, NextFunction } from 'express';
import { requireUser } from '../../middleware/authenticate';
import * as service from './accounts.service';

export async function list(req: Request, res: Response, next: NextFunction) {
  try {
    const { sub } = requireUser(req);
    res.json(await service.listAccounts(sub));
  } catch (err) { next(err); }
}

export async function get(req: Request, res: Response, next: NextFunction) {
  try {
    const { sub } = requireUser(req);
    res.json(await service.getAccount(sub, req.params['id'] as string));
  } catch (err) { next(err); }
}

export async function create(req: Request, res: Response, next: NextFunction) {
  try {
    const { sub } = requireUser(req);
    const input = service.createAccountSchema.parse(req.body);
    res.status(201).json(await service.createAccount(sub, input));
  } catch (err) { next(err); }
}

export async function update(req: Request, res: Response, next: NextFunction) {
  try {
    const { sub } = requireUser(req);
    const input = service.updateAccountSchema.parse(req.body);
    res.json(await service.updateAccount(sub, req.params['id'] as string, input));
  } catch (err) { next(err); }
}

export async function remove(req: Request, res: Response, next: NextFunction) {
  try {
    const { sub } = requireUser(req);
    await service.deleteAccount(sub, req.params['id'] as string);
    res.status(204).send();
  } catch (err) { next(err); }
}
