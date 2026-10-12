// src/docs/openapi.ts
// OpenAPI 3.1 document, generated from the SAME Zod schemas the handlers validate with, so the
// published contract cannot drift from the real request validation. Served at GET /api/v1/openapi.json.

import { z } from 'zod';
import { registerSchema, loginSchema, changePasswordSchema } from '../modules/auth/auth.schema';
import { createAccountSchema, updateAccountSchema } from '../modules/accounts/accounts.service';
import { createCategorySchema, updateCategorySchema } from '../modules/categories/categories.service';
import { createRuleSchema, updateRuleSchema } from '../modules/merchant-rules/merchant-rules.service';
import {
  createTransactionSchema,
  updateTransactionSchema,
  transactionQuerySchema,
} from '../modules/transactions/transactions.schema';
import { importQuerySchema, importRowQuerySchema, uploadSchema } from '../modules/imports/imports.schema';
import { upsertBudgetSchema } from '../modules/budgets/budgets.service';
import { createGoalSchema, updateGoalSchema } from '../modules/savings-goals/savings-goals.service';
import { updateProfileSchema, deleteAccountSchema } from '../modules/users/users.service';

type Json = Record<string, unknown>;

const toSchema = (s: z.ZodType): Json => {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' }) as Json;
  return rest;
};

interface Op {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  tag: string;
  summary: string;
  description?: string;
  body?: z.ZodType;
  multipart?: z.ZodType;
  query?: z.ZodType | Array<{ name: string; description?: string }>;
  auth?: boolean;
  success?: { status: number; description: string };
}

const errorRef = { $ref: '#/components/schemas/Error' };

const ops: Op[] = [
  // Auth & profile
  { method: 'post', path: '/auth/register', tag: 'Auth', summary: 'Create an account', body: registerSchema, auth: false, success: { status: 201, description: 'User and JWT' } },
  { method: 'post', path: '/auth/login', tag: 'Auth', summary: 'Log in', body: loginSchema, auth: false, success: { status: 200, description: 'User and JWT' } },
  { method: 'get', path: '/auth/me', tag: 'Auth', summary: 'Current user' },
  { method: 'post', path: '/auth/change-password', tag: 'Auth', summary: 'Change password', body: changePasswordSchema, success: { status: 204, description: 'Changed' } },
  { method: 'get', path: '/users/me', tag: 'Users', summary: 'Profile' },
  { method: 'patch', path: '/users/me', tag: 'Users', summary: 'Update display name / reporting timezone', body: updateProfileSchema },
  { method: 'get', path: '/users/me/export', tag: 'Users', summary: 'Export all of the user\'s data (JSON download)' },
  { method: 'delete', path: '/users/me', tag: 'Users', summary: 'Permanently delete the account and all data', body: deleteAccountSchema, success: { status: 204, description: 'Deleted' } },

  // Accounts, categories, rules
  { method: 'get', path: '/accounts', tag: 'Accounts', summary: 'List accounts with ledger-derived balances' },
  { method: 'post', path: '/accounts', tag: 'Accounts', summary: 'Create an account', body: createAccountSchema, success: { status: 201, description: 'Created' } },
  { method: 'get', path: '/accounts/{id}', tag: 'Accounts', summary: 'Get an account' },
  { method: 'patch', path: '/accounts/{id}', tag: 'Accounts', summary: 'Update / deactivate an account', body: updateAccountSchema },
  { method: 'delete', path: '/accounts/{id}', tag: 'Accounts', summary: 'Delete an empty account', success: { status: 204, description: 'Deleted' } },
  { method: 'get', path: '/categories', tag: 'Categories', summary: 'System + own categories' },
  { method: 'post', path: '/categories', tag: 'Categories', summary: 'Create a category', body: createCategorySchema, success: { status: 201, description: 'Created' } },
  { method: 'patch', path: '/categories/{id}', tag: 'Categories', summary: 'Update an own category', body: updateCategorySchema },
  { method: 'delete', path: '/categories/{id}', tag: 'Categories', summary: 'Delete an own category (transactions become uncategorized)', success: { status: 204, description: 'Deleted' } },
  { method: 'get', path: '/merchant-rules', tag: 'Merchant rules', summary: 'List auto-categorization rules' },
  { method: 'post', path: '/merchant-rules', tag: 'Merchant rules', summary: 'Create a rule', body: createRuleSchema, success: { status: 201, description: 'Created' } },
  { method: 'patch', path: '/merchant-rules/{id}', tag: 'Merchant rules', summary: 'Update a rule', body: updateRuleSchema },
  { method: 'delete', path: '/merchant-rules/{id}', tag: 'Merchant rules', summary: 'Delete a rule', success: { status: 204, description: 'Deleted' } },
  { method: 'post', path: '/merchant-rules/{id}/apply', tag: 'Merchant rules', summary: 'Re-apply a rule to unreviewed transactions' },

  // Ledger
  { method: 'get', path: '/transactions', tag: 'Transactions', summary: 'Search the ledger (cursor pagination)', description: 'Ordered by occurredAt DESC, id ASC. Pass pagination.nextCursor as `cursor` for the next page.', query: transactionQuerySchema },
  { method: 'post', path: '/transactions', tag: 'Transactions', summary: 'Add a manual entry', body: createTransactionSchema, success: { status: 201, description: 'Created' } },
  { method: 'get', path: '/transactions/{id}', tag: 'Transactions', summary: 'Get a transaction' },
  { method: 'patch', path: '/transactions/{id}', tag: 'Transactions', summary: 'Correct category / merchant / type / notes', body: updateTransactionSchema },
  { method: 'delete', path: '/transactions/{id}', tag: 'Transactions', summary: 'Delete a transaction', success: { status: 204, description: 'Deleted' } },

  // Imports
  { method: 'get', path: '/imports/adapters', tag: 'Imports', summary: 'Supported statement formats' },
  {
    method: 'post', path: '/imports', tag: 'Imports', summary: 'Upload a CSV statement',
    description: 'Multipart field `file` (.csv, size-limited). Sync mode answers 201 with the final summary; with IMPORT_ASYNC=true it answers 202 with a batch to poll via GET /imports/{id} until `isFinished` is true. Re-uploading a COMPLETED file returns 409 DUPLICATE_IMPORT; re-uploading a FAILED/PARTIAL file retries it.',
    multipart: uploadSchema, success: { status: 201, description: 'Import summary (sync) / 202 accepted batch (async)' },
  },
  { method: 'get', path: '/imports', tag: 'Imports', summary: 'Import history', query: importQuerySchema },
  { method: 'get', path: '/imports/{id}', tag: 'Imports', summary: 'Import status (poll `isFinished`)' },
  { method: 'get', path: '/imports/{id}/rows', tag: 'Imports', summary: 'Row-level outcomes', query: importRowQuerySchema },

  // Analytics
  { method: 'get', path: '/dashboard/summary', tag: 'Analytics', summary: 'Monthly income / expenses / savings', query: [{ name: 'year' }, { name: 'month' }] },
  { method: 'get', path: '/analytics/categories', tag: 'Analytics', summary: 'Spending by category with month-over-month', query: [{ name: 'year' }, { name: 'month' }] },
  { method: 'get', path: '/analytics/trends', tag: 'Analytics', summary: 'Monthly series with MoM change', query: [{ name: 'months', description: '1-36, default 12' }] },
  { method: 'get', path: '/insights', tag: 'Analytics', summary: 'Forecast, recurring candidates, safe-to-spend (all estimates labelled)' },

  // Budgets & goals
  { method: 'get', path: '/budgets', tag: 'Budgets', summary: 'Budgets with live utilization', query: [{ name: 'year' }, { name: 'month' }] },
  { method: 'put', path: '/budgets/{categoryId}', tag: 'Budgets', summary: 'Create/replace a category budget for a month', body: upsertBudgetSchema },
  { method: 'delete', path: '/budgets/{categoryId}', tag: 'Budgets', summary: 'Remove a budget', query: [{ name: 'year' }, { name: 'month' }], success: { status: 204, description: 'Deleted' } },
  { method: 'get', path: '/savings-goals', tag: 'Savings goals', summary: 'Goals with progress and required monthly saving' },
  { method: 'post', path: '/savings-goals', tag: 'Savings goals', summary: 'Create a goal', body: createGoalSchema, success: { status: 201, description: 'Created' } },
  { method: 'patch', path: '/savings-goals/{id}', tag: 'Savings goals', summary: 'Update a goal', body: updateGoalSchema },
  { method: 'delete', path: '/savings-goals/{id}', tag: 'Savings goals', summary: 'Delete a goal', success: { status: 204, description: 'Deleted' } },
];

function buildPaths(): Json {
  const paths: Json = {};
  for (const op of ops) {
    const params: Json[] = [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => ({
      name: m[1], in: 'path', required: true, schema: { type: 'string', format: 'uuid' },
    }));
    if (Array.isArray(op.query)) {
      params.push(...op.query.map((q) => ({ name: q.name, in: 'query', required: false, description: q.description, schema: { type: 'string' } })));
    } else if (op.query) {
      const js = toSchema(op.query) as { properties?: Record<string, Json>; required?: string[] };
      for (const [name, schema] of Object.entries(js.properties ?? {})) {
        params.push({ name, in: 'query', required: js.required?.includes(name) ?? false, schema });
      }
    }

    const requestBody = op.body
      ? { required: true, content: { 'application/json': { schema: toSchema(op.body) } } }
      : op.multipart
        ? {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['file', 'accountId'],
                  properties: { file: { type: 'string', format: 'binary' }, ...((toSchema(op.multipart) as { properties?: Json }).properties ?? {}) },
                },
              },
            },
          }
        : undefined;

    const success = op.success ?? { status: 200, description: 'OK' };
    const operation: Json = {
      tags: [op.tag],
      summary: op.summary,
      ...(op.description && { description: op.description }),
      ...(params.length > 0 && { parameters: params }),
      ...(requestBody && { requestBody }),
      ...(op.auth === false ? { security: [] } : {}),
      responses: {
        [String(success.status)]: { description: success.description },
        '400': { description: 'Validation error', content: { 'application/json': { schema: errorRef } } },
        ...(op.auth === false ? {} : { '401': { description: 'Missing or invalid token', content: { 'application/json': { schema: errorRef } } } }),
        '404': { description: 'Not found (also returned for other users\' resources)', content: { 'application/json': { schema: errorRef } } },
        '429': { description: 'Rate limited', content: { 'application/json': { schema: errorRef } } },
      },
    };

    const key = `/api/v1${op.path}`;
    (paths[key] ??= {} as Json);
    (paths[key] as Json)[op.method] = operation;
  }
  return paths;
}

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'SpendSense API',
    version: '1.0.0',
    description:
      'Backend for the SpendSense expense tracker. Money is always a decimal string with two fraction digits (never a float). ' +
      'All timestamps are ISO-8601 UTC; calendar months follow the user\'s reporting timezone. ' +
      'Every error uses the envelope { error: { code, message, details[], requestId } }.',
  },
  servers: [{ url: '/' }],
  security: [{ bearerAuth: [] }],
  paths: buildPaths(),
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message', 'details', 'requestId'],
            properties: {
              code: { type: 'string', example: 'VALIDATION_ERROR' },
              message: { type: 'string' },
              details: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, message: { type: 'string' } } } },
              requestId: { type: 'string' },
            },
          },
        },
      },
    },
  },
} as const;
