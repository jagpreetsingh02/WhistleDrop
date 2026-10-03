'use strict';

/**
 * RETENTION_DAYS_AFTER_CLOSE is read when the Report model is compiled, so it
 * is set before anything is imported. Jest's per-file module registry keeps
 * this from affecting other suites.
 */
process.env.RETENTION_DAYS_AFTER_CLOSE = '0';

const db = require('./setup/testDb');
const Report = require('../src/models/Report');

beforeAll(db.connect);
afterAll(db.close);

describe('retention disabled', () => {
  it('creates no TTL index when RETENTION_DAYS_AFTER_CLOSE is 0', async () => {
    const indexes = await Report.collection.indexes();

    expect(indexes.some((index) => 'expireAfterSeconds' in index)).toBe(false);
    expect(indexes.find((index) => index.name === 'closedAt_retention_ttl')).toBeUndefined();
  });
});
