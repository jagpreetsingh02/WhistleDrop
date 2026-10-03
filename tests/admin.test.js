'use strict';

const {
  app,
  request,
  MODERATOR_CREDENTIALS,
  loginAsModerator,
  loginAsAdmin,
} = require('./setup/helpers');
const db = require('./setup/testDb');
const Moderator = require('../src/models/Moderator');

beforeAll(db.connect);
afterEach(db.clear);
afterAll(db.close);

const NEW_ACCOUNT = {
  username: 'Neha.R',
  password: 'An0ther-Long-Passphrase',
  displayName: 'Compliance Desk',
};

const asAdmin = (authHeader) => ({
  create: (body) =>
    request(app).post('/api/v1/admin/moderators').set('Authorization', authHeader).send(body),
  list: (query = '') =>
    request(app).get(`/api/v1/admin/moderators${query}`).set('Authorization', authHeader),
  deactivate: (id) =>
    request(app)
      .patch(`/api/v1/admin/moderators/${id}/deactivate`)
      .set('Authorization', authHeader),
  activate: (id) =>
    request(app).patch(`/api/v1/admin/moderators/${id}/activate`).set('Authorization', authHeader),
});

describe('admin route protection', () => {
  const someId = '64b7f1a2c3d4e5f6a7b8c9d0';
  const routes = [
    ['post', '/api/v1/admin/moderators'],
    ['get', '/api/v1/admin/moderators'],
    ['patch', `/api/v1/admin/moderators/${someId}/deactivate`],
    ['patch', `/api/v1/admin/moderators/${someId}/activate`],
  ];

  it.each(routes)('%s %s returns 401 without a token', async (method, url) => {
    const res = await request(app)[method](url);
    expect(res.status).toBe(401);
  });

  it.each(routes)('%s %s returns 403 for a moderator', async (method, url) => {
    const { authHeader } = await loginAsModerator();
    const res = await request(app)[method](url).set('Authorization', authHeader).send(NEW_ACCOUNT);

    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('This action requires the admin role');
  });

  it('lets an admin use moderator routes as well', async () => {
    const { authHeader } = await loginAsAdmin();
    const res = await request(app)
      .get('/api/v1/moderator/reports')
      .set('Authorization', authHeader);
    expect(res.status).toBe(200);
  });
});

describe('POST /api/v1/admin/moderators', () => {
  it('creates a moderator account that can log in', async () => {
    const admin = asAdmin((await loginAsAdmin()).authHeader);
    const res = await admin.create(NEW_ACCOUNT);

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      username: 'neha.r',
      displayName: 'Compliance Desk',
      role: 'moderator',
      isActive: true,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|password/);

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: 'neha.r', password: NEW_ACCOUNT.password });
    expect(login.status).toBe(200);
    expect(login.body.data.moderator.role).toBe('moderator');
  });

  it('can create another admin', async () => {
    const admin = asAdmin((await loginAsAdmin()).authHeader);
    const res = await admin.create({ ...NEW_ACCOUNT, role: 'ADMIN' });

    expect(res.status).toBe(201);
    expect(res.body.data.role).toBe('admin');
  });

  it('rejects a duplicate username with 409', async () => {
    const admin = asAdmin((await loginAsAdmin()).authHeader);
    await admin.create(NEW_ACCOUNT);
    const res = await admin.create({ ...NEW_ACCOUNT, username: 'NEHA.R' });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('Moderator "neha.r" already exists');
  });

  it.each([
    ['a short password', { password: 'short-pass' }, 'body.password'],
    ['an unknown role', { role: 'superuser' }, 'body.role'],
    ['an invalid username', { username: 'neha r!' }, 'body.username'],
    ['an unknown field', { isActive: false }, 'body'],
  ])('rejects %s with 400', async (_label, override, field) => {
    const admin = asAdmin((await loginAsAdmin()).authHeader);
    const res = await admin.create({ ...NEW_ACCOUNT, ...override });

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe(field);
  });
});

describe('GET /api/v1/admin/moderators', () => {
  it('lists every staff account without password hashes', async () => {
    const { authHeader } = await loginAsAdmin();
    await loginAsModerator();

    const res = await asAdmin(authHeader).list();

    expect(res.status).toBe(200);
    expect(res.body.data.map((a) => a.username)).toEqual(['testadmin', 'testmod']);
    expect(res.body.data.map((a) => a.role)).toEqual(['admin', 'moderator']);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 20, total: 2, totalPages: 1 });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
  });

  it('paginates and validates paging input', async () => {
    const { authHeader } = await loginAsAdmin();
    await loginAsModerator();

    const page2 = await asAdmin(authHeader).list('?page=2&limit=1');
    const bad = await asAdmin(authHeader).list('?limit=1000');

    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.data[0].username).toBe('testmod');
    expect(bad.status).toBe(400);
  });
});

describe('PATCH /api/v1/admin/moderators/:id/(de)activate', () => {
  it('deactivates an account, which immediately loses access, and reactivates it', async () => {
    const admin = asAdmin((await loginAsAdmin()).authHeader);
    const { moderator, authHeader: modHeader } = await loginAsModerator();
    const id = moderator._id.toString();

    const off = await admin.deactivate(id);
    expect(off.status).toBe(200);
    expect(off.body.data.isActive).toBe(false);

    const blocked = await request(app)
      .get('/api/v1/moderator/reports')
      .set('Authorization', modHeader);
    expect(blocked.status).toBe(401);

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: MODERATOR_CREDENTIALS.username, password: MODERATOR_CREDENTIALS.password });
    expect(login.status).toBe(401);

    const on = await admin.activate(id);
    expect(on.status).toBe(200);
    expect(on.body.data.isActive).toBe(true);

    const restored = await request(app)
      .get('/api/v1/moderator/reports')
      .set('Authorization', modHeader);
    expect(restored.status).toBe(200);
  });

  it('forbids an admin from deactivating themselves', async () => {
    const { moderator: self, authHeader } = await loginAsAdmin();
    const res = await asAdmin(authHeader).deactivate(self._id.toString());

    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Admins cannot deactivate their own account');
    expect((await Moderator.findById(self._id)).isActive).toBe(true);
  });

  it('returns 409 when the account is already in the requested state', async () => {
    const admin = asAdmin((await loginAsAdmin()).authHeader);
    const { moderator } = await loginAsModerator();
    const id = moderator._id.toString();

    expect((await admin.activate(id)).status).toBe(409);
    await admin.deactivate(id);
    const again = await admin.deactivate(id);

    expect(again.status).toBe(409);
    expect(again.body.error.message).toBe('Moderator account is already inactive');
  });

  it('returns 404 for an unknown account and 400 for a malformed id', async () => {
    const admin = asAdmin((await loginAsAdmin()).authHeader);

    expect((await admin.deactivate('64b7f1a2c3d4e5f6a7b8c9d0')).status).toBe(404);
    expect((await admin.activate('not-an-id')).status).toBe(400);
  });
});

describe('role claim is re-validated against the database', () => {
  it('rejects an admin token after the account is demoted', async () => {
    const { authHeader } = await loginAsAdmin();
    await Moderator.updateOne({ username: 'testadmin' }, { role: 'moderator' });

    const res = await asAdmin(authHeader).list();

    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/role has changed/i);
  });

  it('does not grant admin rights to an old token after promotion — a fresh login does', async () => {
    const { authHeader: oldToken } = await loginAsModerator();
    await Moderator.updateOne({ username: 'testmod' }, { role: 'admin' });

    expect((await asAdmin(oldToken).list()).status).toBe(401);

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: MODERATOR_CREDENTIALS.username, password: MODERATOR_CREDENTIALS.password });
    const fresh = await asAdmin(`Bearer ${login.body.data.token}`).list();

    expect(fresh.status).toBe(200);
  });

  it('includes the role in the token and in /auth/me', async () => {
    const { authHeader } = await loginAsAdmin();
    const me = await request(app).get('/api/v1/auth/me').set('Authorization', authHeader);

    expect(me.body.data).toMatchObject({ username: 'testadmin', role: 'admin' });
  });
});
