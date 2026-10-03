'use strict';

const supertest = require('supertest');
const createApp = require('../../src/app');
const { createModerator } = require('../../src/services/auth.service');
const { useLoopbackServer } = require('./loopback');

const app = createApp();
const client = useLoopbackServer(app);

/**
 * Drop-in replacement for supertest's `request(app)` that talks to the app
 * over 127.0.0.1 (see loopback.js for why). Tests keep writing
 * `request(app).get(...)`.
 */
const request = (target) => (target === app ? client() : supertest(target));

const VALID_REPORT = {
  category: 'SECURITY',
  description:
    'Production database credentials are committed in the public repository and have not been rotated.',
  evidenceUrl: 'https://example.com/evidence/1',
};

const MODERATOR_CREDENTIALS = {
  username: 'testmod',
  password: 'Str0ngPassphrase!',
  displayName: 'Ethics Desk',
};

/** Creates a moderator and returns a ready-to-use `Authorization` header value. */
async function loginAsModerator(overrides = {}) {
  const credentials = { ...MODERATOR_CREDENTIALS, ...overrides };
  const moderator = await createModerator(credentials);

  const response = await request(app)
    .post('/api/v1/auth/login')
    .send({ username: credentials.username, password: credentials.password });

  return {
    moderator,
    token: response.body.data.token,
    authHeader: `Bearer ${response.body.data.token}`,
  };
}

const ADMIN_CREDENTIALS = {
  username: 'testadmin',
  password: 'Adm1nPassphrase!',
  displayName: 'Integrity Office',
  role: 'admin',
};

/** Same as loginAsModerator, for an account with the admin role. */
function loginAsAdmin(overrides = {}) {
  return loginAsModerator({ ...ADMIN_CREDENTIALS, ...overrides });
}

module.exports = {
  app,
  request,
  VALID_REPORT,
  MODERATOR_CREDENTIALS,
  ADMIN_CREDENTIALS,
  loginAsModerator,
  loginAsAdmin,
};
