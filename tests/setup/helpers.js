'use strict';

const request = require('supertest');
const createApp = require('../../src/app');
const { createModerator } = require('../../src/services/auth.service');

const app = createApp();

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

module.exports = { app, request, VALID_REPORT, MODERATOR_CREDENTIALS, loginAsModerator };
