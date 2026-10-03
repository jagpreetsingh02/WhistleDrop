'use strict';

const jwt = require('jsonwebtoken');
const { app, request, MODERATOR_CREDENTIALS, loginAsModerator } = require('./setup/helpers');
const db = require('./setup/testDb');
const env = require('../src/config/env');
const { JWT_ISSUER, JWT_AUDIENCE } = require('../src/utils/constants');
const Moderator = require('../src/models/Moderator');

beforeAll(db.connect);
afterEach(db.clear);
afterAll(db.close);

describe('POST /api/v1/auth/login', () => {
  it('issues a JWT for valid credentials', async () => {
    await loginAsModerator();

    const res = await request(app).post('/api/v1/auth/login').send({
      username: MODERATOR_CREDENTIALS.username,
      password: MODERATOR_CREDENTIALS.password,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.token).toEqual(expect.any(String));
    expect(res.body.data.moderator).toMatchObject({
      username: 'testmod',
      displayName: 'Ethics Desk',
    });

    const payload = jwt.verify(res.body.data.token, env.jwt.secret);
    expect(payload).toMatchObject({ role: 'moderator', iss: JWT_ISSUER, aud: JWT_AUDIENCE });
  });

  it('never returns the password hash', async () => {
    await loginAsModerator();
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: MODERATOR_CREDENTIALS.username, password: MODERATOR_CREDENTIALS.password });

    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
  });

  it('gives the same 401 for a wrong password and an unknown username', async () => {
    await loginAsModerator();

    const wrongPassword = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: MODERATOR_CREDENTIALS.username, password: 'WrongPassword1!' });

    const unknownUser = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: 'ghostuser', password: 'WrongPassword1!' });

    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(wrongPassword.body.error.message).toBe('Invalid username or password');
    expect(unknownUser.body.error.message).toBe('Invalid username or password');
  });

  it('is case-insensitive on the username', async () => {
    await loginAsModerator();
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: 'TESTMOD', password: MODERATOR_CREDENTIALS.password });

    expect(res.status).toBe(200);
  });

  it('rejects a deactivated account', async () => {
    await loginAsModerator();
    await Moderator.updateOne({ username: 'testmod' }, { isActive: false });

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: MODERATOR_CREDENTIALS.username, password: MODERATOR_CREDENTIALS.password });

    expect(res.status).toBe(401);
  });

  it('validates the login payload', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ username: 'ab' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Validation failed');
  });
});

describe('moderator route protection', () => {
  const protectedRoute = '/api/v1/moderator/reports';

  it('accepts a valid token', async () => {
    const { authHeader } = await loginAsModerator();
    const res = await request(app).get(protectedRoute).set('Authorization', authHeader);

    expect(res.status).toBe(200);
  });

  it('rejects a request with no Authorization header', async () => {
    const res = await request(app).get(protectedRoute);

    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/missing or malformed/i);
  });

  it('rejects a malformed Authorization header', async () => {
    const { token } = await loginAsModerator();

    for (const header of ['Token abc', token, 'Bearer', 'Basic dXNlcjpwYXNz']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).get(protectedRoute).set('Authorization', header);
      expect(res.status).toBe(401);
    }
  });

  it('rejects a tampered token', async () => {
    const { token } = await loginAsModerator();
    const tampered = `${token.slice(0, -3)}abc`;

    const res = await request(app).get(protectedRoute).set('Authorization', `Bearer ${tampered}`);
    expect(res.status).toBe(401);
  });

  it('rejects a token signed with a different secret', async () => {
    const { moderator } = await loginAsModerator();
    const forged = jwt.sign({ sub: moderator._id.toString(), role: 'moderator' }, 'another-secret', {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      expiresIn: '1h',
    });

    const res = await request(app).get(protectedRoute).set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  it('rejects a token for the wrong audience', async () => {
    const { moderator } = await loginAsModerator();
    const wrongAudience = jwt.sign({ sub: moderator._id.toString() }, env.jwt.secret, {
      issuer: JWT_ISSUER,
      audience: 'some-other-app',
      expiresIn: '1h',
    });

    const res = await request(app)
      .get(protectedRoute)
      .set('Authorization', `Bearer ${wrongAudience}`);
    expect(res.status).toBe(401);
  });

  it('rejects an expired token with a clear message', async () => {
    const { moderator } = await loginAsModerator();
    const expired = jwt.sign({ sub: moderator._id.toString() }, env.jwt.secret, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      expiresIn: '-10s',
    });

    const res = await request(app).get(protectedRoute).set('Authorization', `Bearer ${expired}`);

    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/expired/i);
  });

  it('rejects a valid token whose account was deactivated afterwards', async () => {
    const { authHeader } = await loginAsModerator();
    await Moderator.updateOne({ username: 'testmod' }, { isActive: false });

    const res = await request(app).get(protectedRoute).set('Authorization', authHeader);

    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/no longer active/i);
  });

  it('rejects a token for a deleted account', async () => {
    const { authHeader } = await loginAsModerator();
    await Moderator.deleteMany({});

    const res = await request(app).get(protectedRoute).set('Authorization', authHeader);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/auth/me', () => {
  it('returns the authenticated moderator', async () => {
    const { authHeader } = await loginAsModerator();
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ username: 'testmod', displayName: 'Ethics Desk' });
    expect(res.body.data.passwordHash).toBeUndefined();
  });

  it('requires a token', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });
});
