// src/modules/accounts/accounts.controller.ts
import type { Request, Response } from 'express';
import { requireUser } from '../../middleware/authenticate';
import { uuidSchema } from '../../shared/validation/pagination.schema';
import * as service from './accounts.service';

export async function list(req: Request, res: Response) {
  res.json(await service.listAccounts(requireUser(req).sub));
}

export async function get(req: Request, res: Response) {
  res.json(await service.getAccount(requireUser(req).sub, uuidSchema.parse(req.params['id'])));
}

export async function create(req: Request, res: Response) {
  const input = service.createAccountSchema.parse(req.body);
  res.status(201).json(await service.createAccount(requireUser(req).sub, input));
}

export async function update(req: Request, res: Response) {
  const input = service.updateAccountSchema.parse(req.body);
  res.json(await service.updateAccount(requireUser(req).sub, uuidSchema.parse(req.params['id']), input));
}

export async function remove(req: Request, res: Response) {
  await service.deleteAccount(requireUser(req).sub, uuidSchema.parse(req.params['id']));
  res.status(204).send();
}
