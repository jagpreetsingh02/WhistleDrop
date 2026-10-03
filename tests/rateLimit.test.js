'use strict';

/**
 * Rate limiting is configured from the environment when the app module is
 * first imported, so this file lowers the limits BEFORE requiring the app.
 * Jest gives every test file its own module registry, which keeps these tiny
 * limits from affecting the other suites.
 */
process.env.REPORT_RATE_LIMIT_MAX = '2';
process.env.TRACK_RATE_LIMIT_MAX = '3';
process.env.AUTH_RATE_LIMIT_MAX = '2';

const request = require('supertest');
const createApp = require('../src/app');
const db = require('./setup/testDb');

const app = createApp();

const VALID_REPORT = {
  category: 'OTHER',
  description: 'A description that comfortably clears the twenty character minimum.',
};

beforeAll(db.connect);
afterAll(db.close);

describe('rate limiting', () => {
  it('blocks report submissions beyond the configured limit', async () => {
    const first = await request(app).post('/api/v1/reports').send(VALID_REPORT);
    const second = await request(app).post('/api/v1/reports').send(VALID_REPORT);
    const third = await request(app).post('/api/v1/reports').send(VALID_REPORT);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(third.status).toBe(429);
    expect(third.body).toEqual({
      success: false,
      error: { message: 'Too many reports submitted from this network. Please try again later.' },
    });
  });

  it('throttles case-code lookups so codes cannot be brute-forced', async () => {
    const statuses = [];
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).get('/api/v1/reports/WD-AAAAA-BBBBB-CCCCC');
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 3)).toEqual([404, 404, 404]);
    expect(statuses[3]).toBe(429);
  });

  it('throttles moderator login attempts', async () => {
    const attempt = () =>
      request(app).post('/api/v1/auth/login').send({ username: 'nobody', password: 'guess-me-123' });

    await attempt();
    await attempt();
    const blocked = await attempt();

    expect(blocked.status).toBe(429);
    expect(blocked.body.error.message).toMatch(/too many login attempts/i);
  });

  it('sends standard RateLimit headers so clients can back off politely', async () => {
    const res = await request(app).get('/health');
    const limited = await request(app).get('/api/v1/meta');

    // /health sits outside the limiter; API routes carry the headers.
    expect(res.headers['ratelimit']).toBeUndefined();
    expect(limited.headers['ratelimit']).toBeDefined();
  });
});
