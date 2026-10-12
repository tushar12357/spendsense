// src/modules/merchant-rules/merchant-rules.controller.ts
import type { Request, Response } from 'express';
import { requireUser } from '../../middleware/authenticate';
import { uuidSchema } from '../../shared/validation/pagination.schema';
import * as service from './merchant-rules.service';

export async function list(req: Request, res: Response) {
  res.json(await service.listRules(requireUser(req).sub));
}

export async function create(req: Request, res: Response) {
  const input = service.createRuleSchema.parse(req.body);
  res.status(201).json(await service.createRule(requireUser(req).sub, input));
}

export async function update(req: Request, res: Response) {
  const input = service.updateRuleSchema.parse(req.body);
  res.json(await service.updateRule(requireUser(req).sub, uuidSchema.parse(req.params['id']), input));
}

export async function remove(req: Request, res: Response) {
  await service.deleteRule(requireUser(req).sub, uuidSchema.parse(req.params['id']));
  res.status(204).send();
}

export async function apply(req: Request, res: Response) {
  res.json(await service.applyRule(requireUser(req).sub, uuidSchema.parse(req.params['id'])));
}
