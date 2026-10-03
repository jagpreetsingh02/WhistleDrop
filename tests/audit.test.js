'use strict';

const { app, request, VALID_REPORT, loginAsModerator, loginAsAdmin } = require('./setup/helpers');
const db = require('./setup/testDb');
const AuditLog = require('../src/models/AuditLog');
const auditService = require('../src/services/audit.service');

beforeAll(db.connect);
afterEach(db.clear);
afterAll(db.close);

const getLog = (authHeader, query = '') =>
  request(app).get(`/api/v1/admin/audit-log${query}`).set('Authorization', authHeader);
const verify = (authHeader) =>
  request(app).get('/api/v1/admin/audit-log/verify').set('Authorization', authHeader);

/** Runs a short moderator session that touches every report action. */
async function moderatorSession() {
  const { moderator, authHeader } = await loginAsModerator();
  const submitted = await request(app).post('/api/v1/reports').send(VALID_REPORT);
  const list = await request(app).get('/api/v1/moderator/reports').set('Authorization', authHeader);
  const reportId = list.body.data[0].id;

  await request(app).get(`/api/v1/moderator/reports/${reportId}`).set('Authorization', authHeader);
  await request(app)
    .patch(`/api/v1/moderator/reports/${reportId}/status`)
    .set('Authorization', authHeader)
    .send({ status: 'UNDER_REVIEW' });
  await request(app)
    .post(`/api/v1/moderator/reports/${reportId}/updates`)
    .set('Authorization', authHeader)
    .send({ message: 'Looking into it now.' });

  return { moderator, reportId, caseCode: submitted.body.data.caseCode };
}

describe('what gets recorded', () => {
  it('records login, report view, status change and note — in order', async () => {
    const { moderator, reportId } = await moderatorSession();
    const entries = await AuditLog.find().sort({ seq: 1 }).lean();

    expect(entries.map((e) => e.action)).toEqual([
      'LOGIN',
      'VIEW_REPORT',
      'UPDATE_STATUS',
      'ADD_UPDATE',
    ]);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(entries.every((e) => e.moderator.toString() === moderator._id.toString())).toBe(true);
    expect(entries.slice(1).every((e) => e.report.toString() === reportId)).toBe(true);
  });

  it('records admin account actions with their target', async () => {
    const { moderator: admin, authHeader } = await loginAsAdmin();
    const created = await request(app)
      .post('/api/v1/admin/moderators')
      .set('Authorization', authHeader)
      .send({ username: 'neha.r', password: 'An0ther-Long-Passphrase' });
    const targetId = created.body.data.id;

    await request(app)
      .patch(`/api/v1/admin/moderators/${targetId}/deactivate`)
      .set('Authorization', authHeader);
    await request(app)
      .patch(`/api/v1/admin/moderators/${targetId}/activate`)
      .set('Authorization', authHeader);

    const entries = await AuditLog.find({ action: /^ADMIN_/ })
      .sort({ seq: 1 })
      .lean();
    expect(entries.map((e) => e.action)).toEqual([
      'ADMIN_CREATE_ACCOUNT',
      'ADMIN_DEACTIVATE_ACCOUNT',
      'ADMIN_ACTIVATE_ACCOUNT',
    ]);
    for (const entry of entries) {
      expect(entry.moderator.toString()).toBe(admin._id.toString());
      expect(entry.targetModerator.toString()).toBe(targetId);
    }
  });

  it('does not record failed actions', async () => {
    const { authHeader } = await loginAsModerator();
    await request(app)
      .get('/api/v1/moderator/reports/64b7f1a2c3d4e5f6a7b8c9d0')
      .set('Authorization', authHeader);
    await request(app)
      .post('/api/v1/auth/login')
      .send({ username: 'testmod', password: 'wrong-password' });

    const actions = (await AuditLog.find().lean()).map((e) => e.action);
    expect(actions).toEqual(['LOGIN']);
  });

  it('does not show a report when its view cannot be recorded', async () => {
    const { authHeader } = await loginAsModerator();
    await request(app).post('/api/v1/reports').send(VALID_REPORT);
    const list = await request(app)
      .get('/api/v1/moderator/reports')
      .set('Authorization', authHeader);

    jest.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('audit store down'));
    const res = await request(app)
      .get(`/api/v1/moderator/reports/${list.body.data[0].id}`)
      .set('Authorization', authHeader);
    jest.restoreAllMocks();

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(VALID_REPORT.description);
  });
});

describe('privacy of the audit log', () => {
  it('stores only ids, the action, the time and the chain hashes', async () => {
    await moderatorSession();
    const entries = await AuditLog.find().lean();

    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(
        [
          '_id',
          'action',
          'createdAt',
          'hash',
          'moderator',
          'prevHash',
          'report',
          'seq',
          'targetModerator',
        ].sort()
      );
    }
  });

  it('contains no report text, case code or network identifiers', async () => {
    const { authHeader } = await loginAsModerator({ username: 'net.mod' });
    const submitted = await request(app)
      .post('/api/v1/reports')
      .set('User-Agent', 'very-identifying-agent/1.0')
      .set('X-Forwarded-For', '203.0.113.77')
      .send(VALID_REPORT);
    const list = await request(app)
      .get('/api/v1/moderator/reports')
      .set('Authorization', authHeader)
      .set('User-Agent', 'moderator-browser/2.0')
      .set('X-Forwarded-For', '198.51.100.23');
    await request(app)
      .get(`/api/v1/moderator/reports/${list.body.data[0].id}`)
      .set('Authorization', authHeader)
      .set('User-Agent', 'moderator-browser/2.0')
      .set('X-Forwarded-For', '198.51.100.23');

    const serialised = JSON.stringify(await AuditLog.find().lean());
    for (const forbidden of [
      VALID_REPORT.description,
      submitted.body.data.caseCode,
      '203.0.113.77',
      '198.51.100.23',
      'very-identifying-agent',
      'moderator-browser',
    ]) {
      expect(serialised).not.toContain(forbidden);
    }
  });
});

describe('GET /api/v1/admin/audit-log', () => {
  it('lists entries newest first with the acting moderator', async () => {
    await moderatorSession();
    const { authHeader } = await loginAsAdmin();

    const res = await getLog(authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data.map((e) => e.action)).toEqual([
      'LOGIN',
      'ADD_UPDATE',
      'UPDATE_STATUS',
      'VIEW_REPORT',
      'LOGIN',
    ]);
    expect(res.body.data[1].moderator).toMatchObject({
      username: 'testmod',
      displayName: 'Ethics Desk',
    });
    expect(res.body.data[0]).toMatchObject({ seq: 5, reportId: null, targetModeratorId: null });
    expect(res.body.data[0].hash).toMatch(/^[a-f0-9]{64}$/);
    expect(res.body.data[0].prevHash).toBe(res.body.data[1].hash);
  });

  it('paginates and caps the page size', async () => {
    await moderatorSession();
    const { authHeader } = await loginAsAdmin();

    const page = await getLog(authHeader, '?page=2&limit=2');
    expect(page.body.data.map((e) => e.seq)).toEqual([3, 2]);
    expect(page.body.meta).toMatchObject({ page: 2, limit: 2, total: 5, totalPages: 3 });

    expect((await getLog(authHeader, '?limit=101')).status).toBe(400);
  });

  it('is admin-only', async () => {
    const { authHeader } = await loginAsModerator();
    expect((await getLog(authHeader)).status).toBe(403);
    expect((await verify(authHeader)).status).toBe(403);
    expect((await request(app).get('/api/v1/admin/audit-log')).status).toBe(401);
  });
});

describe('GET /api/v1/admin/audit-log/verify — tamper detection', () => {
  it('reports an empty log as intact', async () => {
    const result = await auditService.verifyChain();
    expect(result).toEqual({
      intact: true,
      checkedEntries: 0,
      headSeq: 0,
      headHash: auditService.GENESIS_HASH,
    });
  });

  it('confirms an untouched chain', async () => {
    await moderatorSession();
    const { authHeader } = await loginAsAdmin();

    const res = await verify(authHeader);
    const head = await AuditLog.findOne().sort({ seq: -1 }).lean();

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Audit log is intact');
    expect(res.body.data).toEqual({
      intact: true,
      checkedEntries: 5,
      headSeq: 5,
      headHash: head.hash,
    });
  });

  it('detects an edited entry', async () => {
    await moderatorSession();
    const { authHeader } = await loginAsAdmin();

    // Someone with database access tries to make a status change look like a login.
    await AuditLog.collection.updateOne({ seq: 3 }, { $set: { action: 'LOGIN' } });

    const res = await verify(authHeader);
    expect(res.body.message).toBe('Audit log has been tampered with at entry #3');
    expect(res.body.data).toEqual({
      intact: false,
      checkedEntries: 2,
      brokenAtSeq: 3,
      reason: 'CONTENT_HASH_MISMATCH',
    });
  });

  it('detects an edited entry even if the attacker recomputes its hash', async () => {
    await moderatorSession();
    const { authHeader } = await loginAsAdmin();

    const entry = await AuditLog.findOne({ seq: 2 }).lean();
    const forged = { ...entry, moderator: '64b7f1a2c3d4e5f6a7b8c9d0' };
    await AuditLog.collection.updateOne(
      { seq: 2 },
      { $set: { moderator: forged.moderator, hash: auditService.computeHash(forged) } }
    );

    const res = await verify(authHeader);
    expect(res.body.data).toMatchObject({
      intact: false,
      brokenAtSeq: 3,
      reason: 'PREVIOUS_HASH_MISMATCH',
    });
  });

  it('detects a deleted entry', async () => {
    await moderatorSession();
    const { authHeader } = await loginAsAdmin();

    await AuditLog.collection.deleteOne({ seq: 2 });

    const res = await verify(authHeader);
    expect(res.body.data).toMatchObject({ intact: false, brokenAtSeq: 2, reason: 'MISSING_ENTRY' });
  });

  it('detects re-ordered entries', async () => {
    await moderatorSession();
    const { authHeader } = await loginAsAdmin();

    await AuditLog.collection.updateOne({ seq: 2 }, { $set: { seq: 99 } });
    await AuditLog.collection.updateOne({ seq: 3 }, { $set: { seq: 2 } });
    await AuditLog.collection.updateOne({ seq: 99 }, { $set: { seq: 3 } });

    const res = await verify(authHeader);
    expect(res.body.data).toMatchObject({ intact: false, brokenAtSeq: 2 });
  });
});

describe('concurrent appends', () => {
  it('keeps a single unbroken chain when many actions are recorded at once', async () => {
    const { moderator } = await loginAsModerator();

    await Promise.all(
      Array.from({ length: 8 }, () =>
        auditService.record({ moderatorId: moderator._id, action: 'VIEW_REPORT' })
      )
    );

    const seqs = (await AuditLog.find().sort({ seq: 1 }).lean()).map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect((await auditService.verifyChain()).intact).toBe(true);
  });
});
