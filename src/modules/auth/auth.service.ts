// src/modules/auth/auth.service.ts
// Business logic for registration, login, and token issuance.
// Passwords are hashed with bcryptjs (pure JS, no native build required).

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../../infrastructure/database/prisma';
import { env } from '../../config/env';
import { AppError } from '../../shared/errors/AppError';
import type { RegisterInput, LoginInput } from './auth.schema';
import type { JwtPayload } from '../../middleware/authenticate';

const SALT_ROUNDS = 12;

function issueToken(userId: string, email: string): string {
  const payload: JwtPayload = { sub: userId, email };
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
    issuer: 'spendsense',
    audience: 'spendsense-api',
  } as jwt.SignOptions);
}

function safeUser(user: { id: string; email: string; displayName: string; timezone: string; createdAt: Date }) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    timezone: user.timezone,
    createdAt: user.createdAt,
  };
}

export async function register(input: RegisterInput) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    throw AppError.conflict('An account with this email already exists');
  }

  const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

  const user = await prisma.user.create({
    data: {
      email: input.email,
      passwordHash,
      displayName: input.displayName,
      timezone: input.timezone,
    },
    select: { id: true, email: true, displayName: true, timezone: true, createdAt: true },
  });

  const token = issueToken(user.id, user.email);
  return { user: safeUser(user), token };
}

export async function login(input: LoginInput) {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true, email: true, passwordHash: true, displayName: true, timezone: true, createdAt: true },
  });

  if (!user) throw AppError.invalidCredentials();

  const valid = await bcrypt.compare(input.password, user.passwordHash);
  if (!valid) throw AppError.invalidCredentials();

  const token = issueToken(user.id, user.email);
  const { passwordHash: _omit, ...safeFields } = user;
  return { user: safeFields, token };
}

export async function getMe(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, displayName: true, timezone: true, createdAt: true },
  });
  if (!user) throw AppError.notFound('User');
  return user;
}
