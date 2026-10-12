// src/modules/users/users.controller.ts
import type { Request, Response } from 'express';
import { requireUser } from '../../middleware/authenticate';
import * as service from './users.service';

export async function me(req: Request, res: Response) {
  res.json(await service.getProfile(requireUser(req).sub));
}

export async function update(req: Request, res: Response) {
  res.json(await service.updateProfile(requireUser(req).sub, service.updateProfileSchema.parse(req.body)));
}

export async function exportData(req: Request, res: Response) {
  const data = await service.exportUserData(requireUser(req).sub);
  res.setHeader('Content-Disposition', 'attachment; filename="spendsense-export.json"');
  res.json(data);
}

export async function remove(req: Request, res: Response) {
  const { password } = service.deleteAccountSchema.parse(req.body);
  await service.deleteAccount(requireUser(req).sub, password);
  res.status(204).send();
}
