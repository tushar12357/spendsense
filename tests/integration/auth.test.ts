import { beforeEach, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { bearer, http, registerUser } from '../helpers/api';
import { resetDb } from '../helpers/db';

beforeEach(resetDb);

const valid = { email: 'asha@example.com', password: 'CorrectHorse9', displayName: 'Asha' };

describe('registration', () => {
  it('creates a user, returns a token and never returns the password hash', async () => {
    const res = await http().post('/api/v1/auth/register').send(valid);
    expect(res.status).toBe(201);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.user).toMatchObject({ email: 'asha@example.com', displayName: 'Asha', timezone: 'Asia/Kolkata' });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|password_hash/);
  });

  it('rejects a duplicate email (case-insensitively) with 409', async () => {
    await http().post('/api/v1/auth/register').send(valid);
    const res = await http().post('/api/v1/auth/register').send({ ...valid, email: 'ASHA@example.com' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('survives two simultaneous sign-ups for one email: exactly one wins', async () => {
    const results = await Promise.all([
      http().post('/api/v1/auth/register').send(valid),
      http().post('/api/v1/auth/register').send(valid),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it.each([
    ['weak password', { ...valid, password: 'short' }],
    ['password without digits', { ...valid, password: 'abcdefghijklmnop' }],
    ['bad email', { ...valid, email: 'nope' }],
    ['unknown timezone', { ...valid, timezone: 'Mars/Base' }],
    ['missing name', { email: valid.email, password: valid.password }],
  ])('validates input: %s', async (_name, body) => {
    const res = await http().post('/api/v1/auth/register').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(res.body.error.requestId).toEqual(expect.any(String));
  });

  it('answers malformed JSON with a clean 400 envelope', async () => {
    const res = await http().post('/api/v1/auth/register').set('Content-Type', 'application/json').send('{"email":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('login and sessions', () => {
  it('logs in with correct credentials', async () => {
    await http().post('/api/v1/auth/register').send(valid);
    const res = await http().post('/api/v1/auth/login').send({ email: valid.email, password: valid.password });
    expect(res.status).toBe(200);
    const me = await http().get('/api/v1/auth/me').set('Authorization', `Bearer ${res.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(valid.email);
  });

  it('gives the same 401 for a wrong password and an unknown email (no account enumeration)', async () => {
    await http().post('/api/v1/auth/register').send(valid);
    const wrongPw = await http().post('/api/v1/auth/login').send({ email: valid.email, password: 'WrongPassword1' });
    const noUser = await http().post('/api/v1/auth/login').send({ email: 'ghost@example.com', password: 'WrongPassword1' });
    expect(wrongPw.status).toBe(401);
    expect(noUser.status).toBe(401);
    expect(wrongPw.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(noUser.body.error.message).toBe(wrongPw.body.error.message);
  });

  it('changes the password and invalidates the old one', async () => {
    const u = await registerUser({ email: 'pw@example.com' });
    const bad = await http().post('/api/v1/auth/change-password').set(bearer(u)).send({ currentPassword: 'nope', newPassword: 'BrandNewPass1' });
    expect(bad.status).toBe(401);
    const ok = await http().post('/api/v1/auth/change-password').set(bearer(u)).send({ currentPassword: 'CorrectHorse9', newPassword: 'BrandNewPass1' });
    expect(ok.status).toBe(204);
    expect((await http().post('/api/v1/auth/login').send({ email: 'pw@example.com', password: 'CorrectHorse9' })).status).toBe(401);
    expect((await http().post('/api/v1/auth/login').send({ email: 'pw@example.com', password: 'BrandNewPass1' })).status).toBe(200);
  });
});

describe('token verification', () => {
  const secret = 'test-secret-test-secret-test-secret-0123456789';

  it('rejects requests without, or with a malformed, Authorization header', async () => {
    expect((await http().get('/api/v1/accounts')).status).toBe(401);
    expect((await http().get('/api/v1/accounts').set('Authorization', 'Token abc')).status).toBe(401);
    expect((await http().get('/api/v1/accounts').set('Authorization', 'Bearer garbage')).status).toBe(401);
  });

  it('rejects a token signed with another secret, wrong audience, wrong issuer or expired', async () => {
    const u = await registerUser();
    const claims = { sub: u.id, email: u.email };
    const good = { issuer: 'spendsense', audience: 'spendsense-api' };
    const tokens = {
      wrongSecret: jwt.sign(claims, 'x'.repeat(40), good),
      wrongAudience: jwt.sign(claims, secret, { ...good, audience: 'someone-else' }),
      wrongIssuer: jwt.sign(claims, secret, { ...good, issuer: 'evil' }),
      expired: jwt.sign(claims, secret, { ...good, expiresIn: -10 }),
      noneAlg: `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ ...claims, iss: 'spendsense', aud: 'spendsense-api' })).toString('base64url')}.`,
      nonUuidSub: jwt.sign({ sub: "1' OR '1'='1", email: 'x' }, secret, good),
    };
    for (const [name, token] of Object.entries(tokens)) {
      const res = await http().get('/api/v1/accounts').set('Authorization', `Bearer ${token}`);
      expect(res.status, name).toBe(401);
    }
    const ok = jwt.sign(claims, secret, good);
    expect((await http().get('/api/v1/accounts').set('Authorization', `Bearer ${ok}`)).status).toBe(200);
  });
});

describe('platform behaviour', () => {
  it('sets security headers and echoes a safe request id', async () => {
    const res = await http().get('/health').set('X-Request-ID', 'trace-abc-12345');
    expect(res.headers['x-request-id']).toBe('trace-abc-12345');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('replaces an unsafe request id instead of reflecting it', async () => {
    const res = await http().get('/health').set('X-Request-ID', 'evil id with spaces;<script>');
    expect(res.headers['x-request-id']).not.toContain('evil');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns the standard envelope for unknown routes', async () => {
    const res = await http().get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('reports readiness once the database answers', async () => {
    const res = await http().get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ready', checks: { database: 'ok' } });
  });

  it('serves an OpenAPI document that covers the main endpoints', async () => {
    const res = await http().get('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining(['/api/v1/transactions', '/api/v1/imports', '/api/v1/insights', '/api/v1/budgets/{categoryId}']),
    );
    expect(res.body.paths['/api/v1/transactions'].post.requestBody.content['application/json'].schema.properties.amount).toBeDefined();
  });
});
