// src/modules/auth/auth.controller.ts
// Express 5 forwards rejected promises to the error handler, so handlers need no try/catch.
import type { Request, Response } from 'express';
import { requireUser } from '../../middleware/authenticate';
import { changePasswordSchema, loginSchema, registerSchema } from './auth.schema';
import * as authService from './auth.service';
import { getProfile } from '../users/users.service';

export async function registerHandler(req: Request, res: Response) {
  res.status(201).json(await authService.register(registerSchema.parse(req.body)));
}

export async function loginHandler(req: Request, res: Response) {
  res.json(await authService.login(loginSchema.parse(req.body)));
}

export async function getMeHandler(req: Request, res: Response) {
  res.json({ user: await getProfile(requireUser(req).sub) });
}

export async function changePasswordHandler(req: Request, res: Response) {
  await authService.changePassword(requireUser(req).sub, changePasswordSchema.parse(req.body));
  res.status(204).send();
}
