// src/modules/auth/auth.service.ts
// Registration, login and token issuance. Passwords are hashed with bcrypt (bcryptjs: pure JS).

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';
import { env } from '../../config/env';
import { AppError } from '../../shared/errors/AppError';
import { JWT_AUDIENCE, JWT_ISSUER, type JwtPayload } from '../../middleware/authenticate';
import type { ChangePasswordInput, LoginInput, RegisterInput } from './auth.schema';

const USER_SELECT = {
  id: true,
  email: true,
  displayName: true,
  timezone: true,
  createdAt: true,
} as const;

// Compared against when the email is unknown so login timing does not reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('spendsense-timing-equalizer', env.BCRYPT_ROUNDS);

export function issueToken(userId: string, email: string): string {
  const payload: Pick<JwtPayload, 'sub' | 'email'> = { sub: userId, email };
  return jwt.sign(payload, env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: env.JWT_EXPIRES_IN,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  } as jwt.SignOptions);
}

export async function register(input: RegisterInput) {
  const passwordHash = await bcrypt.hash(input.password, env.BCRYPT_ROUNDS);
  try {
    const user = await prisma.user.create({
      data: {
        email: input.email,
        passwordHash,
        displayName: input.displayName,
        timezone: input.timezone,
      },
      select: USER_SELECT,
    });
    return { user, token: issueToken(user.id, user.email) };
  } catch (err) {
    // The unique index is the source of truth - a pre-check would race with concurrent sign-ups.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw AppError.conflict('An account with this email already exists');
    }
    throw err;
  }
}

export async function login(input: LoginInput) {
  const found = await prisma.user.findUnique({
    where: { email: input.email },
    select: { ...USER_SELECT, passwordHash: true },
  });

  const valid = await bcrypt.compare(input.password, found?.passwordHash ?? DUMMY_HASH);
  if (!found || !valid) throw AppError.invalidCredentials();

  const { passwordHash: _omit, ...user } = found;
  return { user, token: issueToken(user.id, user.email) };
}

export async function changePassword(userId: string, input: ChangePasswordInput) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
  if (!user) throw AppError.notFound('User');
  if (!(await bcrypt.compare(input.currentPassword, user.passwordHash))) {
    throw AppError.invalidCredentials();
  }
  const passwordHash = await bcrypt.hash(input.newPassword, env.BCRYPT_ROUNDS);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
}
