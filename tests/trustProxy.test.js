'use strict';

/**
 * These tests only touch /api/v1/meta, which needs no database, so each app
 * can be built in an isolated module registry with its own environment.
 */

const request = require('supertest');

const ORIGINAL_ENV = { ...process.env };

function buildApp(overrides) {
  let app;
  jest.isolateModules(() => {
    Object.assign(process.env, overrides);
    app = require('../src/app')();
  });
  process.env = { ...ORIGINAL_ENV };
  return app;
}

const fromClient = (app, ip) => request(app).get('/api/v1/meta').set('X-Forwarded-For', ip);

beforeEach(() => {
  // express-rate-limit warns (on purpose) when it sees X-Forwarded-For without
  // trust proxy configured. Keep test output clean; one test asserts on it.
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('TRUST_PROXY', () => {
  it('without it, every client behind a proxy shares one rate-limit bucket', async () => {
    const app = buildApp({ TRUST_PROXY: '0', RATE_LIMIT_MAX: '2' });

    const statuses = [];
    for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
      // eslint-disable-next-line no-await-in-loop
      statuses.push((await fromClient(app, ip)).status);
    }

    // Three different reporters, but the third is blocked by the other two.
    expect(statuses).toEqual([200, 200, 429]);
  });

  it('logs the misconfiguration warning so a forgotten setting is visible', async () => {
    const app = buildApp({ TRUST_PROXY: '0', RATE_LIMIT_MAX: '50' });
    await fromClient(app, '198.51.100.9');

    const logged = [...console.error.mock.calls, ...console.warn.mock.calls].flat().join(' ');
    expect(logged).toMatch(/ERR_ERL_UNEXPECTED_X_FORWARDED_FOR/);
    // The warning names the setting, never the client address.
    expect(logged).not.toContain('198.51.100.9');
  });

  it('with one trusted hop, each real client gets its own bucket', async () => {
    const app = buildApp({ TRUST_PROXY: '1', RATE_LIMIT_MAX: '2' });

    expect((await fromClient(app, '198.51.100.1')).status).toBe(200);
    expect((await fromClient(app, '198.51.100.1')).status).toBe(200);
    expect((await fromClient(app, '198.51.100.1')).status).toBe(429);

    // A different reporter behind the same load balancer is unaffected.
    expect((await fromClient(app, '198.51.100.2')).status).toBe(200);
  });

  it('parses hop counts, booleans and subnet lists', () => {
    const { parseTrustProxy } = require('../src/config/env');

    expect(parseTrustProxy('0')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy(' loopback, 10.0.0.0/8 ')).toBe('loopback, 10.0.0.0/8');
  });
});
