'use strict';

const { app, request } = require('./setup/helpers');
const db = require('./setup/testDb');
const { openApiSpec } = require('../src/config/swagger');

beforeAll(db.connect);
afterAll(db.close);

/**
 * Every route the API serves. Adding an endpoint without documenting it (or
 * documenting one that does not exist) fails this suite.
 */
const EXPECTED_OPERATIONS = [
  'GET /health',
  'GET /meta',
  'POST /reports',
  'GET /reports/{caseCode}',
  'POST /reports/{caseCode}/messages',
  'POST /auth/login',
  'GET /auth/me',
  'GET /moderator/reports',
  'GET /moderator/reports/{id}',
  'PATCH /moderator/reports/{id}/status',
  'POST /moderator/reports/{id}/updates',
  'POST /moderator/reports/{id}/messages',
  'GET /moderator/stats',
  'POST /admin/moderators',
  'GET /admin/moderators',
  'PATCH /admin/moderators/{id}/deactivate',
  'PATCH /admin/moderators/{id}/activate',
  'GET /admin/audit-log',
  'GET /admin/audit-log/verify',
];

const PLACEHOLDERS = { caseCode: 'WD-AAAAA-BBBBB-CCCCC', id: '64b7f1a2c3d4e5f6a7b8c9d0' };
const PROTECTED_PREFIXES = ['/moderator', '/admin', '/auth/me'];

const documentedOperations = Object.entries(openApiSpec.paths).flatMap(([path, item]) =>
  Object.entries(item).map(([method, operation]) => ({ method, path, operation }))
);

describe('OpenAPI document', () => {
  it('documents exactly the operations the API serves', () => {
    const documented = documentedOperations.map(({ method, path }) => `${method.toUpperCase()} ${path}`);
    expect(documented.sort()).toEqual([...EXPECTED_OPERATIONS].sort());
  });

  it.each(documentedOperations.map(({ method, path }) => [method.toUpperCase(), path]))(
    '%s %s is actually routed',
    async (method, path) => {
      const url = `/api/v1${path.replace(/\{(\w+)\}/g, (_m, name) => PLACEHOLDERS[name])}`;
      const res = await request(app)[method.toLowerCase()](url).send({});

      const message = res.body && res.body.error && res.body.error.message;
      expect(message || '').not.toMatch(/^Route .* does not exist$/);
    }
  );

  it('gives every operation a summary, a tag and at least one documented response', () => {
    for (const { method, path, operation } of documentedOperations) {
      const label = `${method.toUpperCase()} ${path}`;
      expect([label, Boolean(operation.summary)]).toEqual([label, true]);
      expect([label, operation.tags && operation.tags.length > 0]).toEqual([label, true]);
      expect([label, Object.keys(operation.responses).length > 0]).toEqual([label, true]);
    }
  });

  it('marks every protected operation with bearer auth and documents its 401', () => {
    const protectedOps = documentedOperations.filter(({ path }) =>
      PROTECTED_PREFIXES.some((prefix) => path.startsWith(prefix))
    );

    expect(protectedOps.length).toBeGreaterThan(0);
    for (const { method, path, operation } of protectedOps) {
      const label = `${method.toUpperCase()} ${path}`;
      expect([label, operation.security]).toEqual([label, [{ bearerAuth: [] }]]);
      expect([label, Boolean(operation.responses[401])]).toEqual([label, true]);
    }
  });

  it('documents a 403 for every admin operation', () => {
    for (const { method, path, operation } of documentedOperations) {
      if (!path.startsWith('/admin')) continue;
      expect([`${method} ${path}`, Boolean(operation.responses[403])]).toEqual([
        `${method} ${path}`,
        true,
      ]);
    }
  });

  it('resolves every $ref to a defined component', () => {
    const refs = JSON.stringify(openApiSpec).match(/"\$ref":"#\/components\/[^"]+"/g) || [];
    for (const ref of refs) {
      const [, section, name] = ref.match(/#\/components\/(\w+)\/([^"]+)/);
      expect([ref, Boolean(openApiSpec.components[section][name])]).toEqual([ref, true]);
    }
  });

  it('is served as JSON at /api-docs.json', async () => {
    const res = await request(app).get('/api-docs.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.0.3');
  });
});
