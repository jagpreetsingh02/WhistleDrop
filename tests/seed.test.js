'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const db = require('./setup/testDb');
const { seed, SAMPLE_REPORTS } = require('../scripts/seed');
const Moderator = require('../src/models/Moderator');
const Report = require('../src/models/Report');
const AuditLog = require('../src/models/AuditLog');
const { verifyChain } = require('../src/services/audit.service');

beforeAll(db.connect);
afterEach(db.clear);
afterAll(db.close);

describe('npm run seed', () => {
  it('creates the demo accounts and one report per sample journey', async () => {
    const { admin, moderator, reports } = await seed();

    expect(admin.role).toBe('admin');
    expect(moderator.role).toBe('moderator');
    expect(reports).toHaveLength(SAMPLE_REPORTS.length);
    expect(reports.every((r) => /^WD-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(r.caseCode))).toBe(
      true
    );

    const statuses = (await Report.find().lean()).map((r) => r.status).sort();
    expect(statuses).toEqual([
      'DISMISSED',
      'RESOLVED',
      'SUBMITTED',
      'UNDER_REVIEW',
      'UNDER_REVIEW',
    ]);
    expect(await Report.countDocuments({ awaitingReporter: true })).toBe(1);
    expect(await Report.countDocuments({ 'messages.from': 'REPORTER' })).toBe(1);
    expect(await Report.countDocuments({ 'updates.visibility': 'INTERNAL' })).toBe(1);
  });

  it('produces a valid audit trail', async () => {
    await seed();

    expect(await AuditLog.countDocuments()).toBeGreaterThan(0);
    expect((await verifyChain()).intact).toBe(true);
  });

  it('can be run again without duplicating accounts', async () => {
    await seed();
    await seed();

    expect(await Moderator.countDocuments()).toBe(2);
    expect(await Report.countDocuments()).toBe(SAMPLE_REPORTS.length * 2);
  });

  it('refuses to run when NODE_ENV=production, before touching any database', () => {
    const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/seed.js')], {
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'production',
        // Deliberately unreachable: the script must exit before connecting.
        MONGODB_URI: 'mongodb://127.0.0.1:1/never-used',
        JWT_SECRET: 'x'.repeat(40),
      },
      encoding: 'utf8',
      timeout: 15000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Refusing to seed: NODE_ENV is "production"/);
  });
});
