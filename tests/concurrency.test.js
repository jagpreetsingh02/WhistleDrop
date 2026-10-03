'use strict';

const { app, request, VALID_REPORT, loginAsModerator } = require('./setup/helpers');
const db = require('./setup/testDb');
const Report = require('../src/models/Report');

beforeAll(db.connect);
afterEach(async () => {
  jest.restoreAllMocks();
  await db.clear();
});
afterAll(db.close);

let authHeader;

beforeEach(async () => {
  ({ authHeader } = await loginAsModerator());
});

async function seedUnderReview() {
  await request(app).post('/api/v1/reports').send(VALID_REPORT);
  const list = await request(app).get('/api/v1/moderator/reports').set('Authorization', authHeader);
  const { id } = list.body.data[0];
  await request(app)
    .patch(`/api/v1/moderator/reports/${id}/status`)
    .set('Authorization', authHeader)
    .send({ status: 'UNDER_REVIEW' });
  return id;
}

/**
 * Holds every `Report.findById` result until `expected` reads have completed.
 * This forces the exact interleaving a real race needs — both requests read
 * the same status before either writes — instead of hoping the event loop
 * happens to produce it.
 */
function installReadBarrier(expected) {
  const originalFindById = Report.findById.bind(Report);
  let arrivals = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  jest.spyOn(Report, 'findById').mockImplementation((...args) => {
    const query = originalFindById(...args);
    const exec = query.exec.bind(query);
    query.exec = async (...execArgs) => {
      const result = await exec(...execArgs);
      arrivals += 1;
      if (arrivals >= expected) release();
      await gate;
      return result;
    };
    return query;
  });
}

const patchStatus = (id, body) =>
  request(app)
    .patch(`/api/v1/moderator/reports/${id}/status`)
    .set('Authorization', authHeader)
    .send(body);

describe('concurrent moderator actions', () => {
  it('lets exactly one of two conflicting transitions win; the other gets 409', async () => {
    const id = await seedUnderReview();
    installReadBarrier(2);

    const responses = await Promise.all([
      patchStatus(id, { status: 'RESOLVED', message: 'Resolved by moderator A.' }),
      patchStatus(id, { status: 'DISMISSED', message: 'Dismissed by moderator B.' }),
    ]);

    const statuses = responses.map((res) => res.status).sort();
    expect(statuses).toEqual([200, 409]);

    const loser = responses.find((res) => res.status === 409);
    expect(loser.body.error.message).toMatch(/changed from UNDER_REVIEW to (RESOLVED|DISMISSED)/);
    expect(loser.body.error.details.expectedStatus).toBe('UNDER_REVIEW');

    jest.restoreAllMocks();
    const stored = await Report.findById(id).lean();
    const winner = responses.find((res) => res.status === 200);

    // The stored status is the winner's, and only the winner's update exists.
    expect(stored.status).toBe(winner.body.data.status);
    expect(stored.updates.filter((u) => ['RESOLVED', 'DISMISSED'].includes(u.status))).toHaveLength(1);
  });

  it('reports a stale read as 409, not as a silent overwrite', async () => {
    const id = await seedUnderReview();

    // Another moderator resolves the case...
    await patchStatus(id, { status: 'RESOLVED' });

    // ...but this request's read still sees the old status.
    jest.spyOn(Report, 'findById').mockImplementationOnce(() => ({
      select: () => Promise.resolve({ status: 'UNDER_REVIEW' }),
    }));

    const res = await patchStatus(id, { status: 'DISMISSED' });

    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual({
      expectedStatus: 'UNDER_REVIEW',
      currentStatus: 'RESOLVED',
    });

    jest.restoreAllMocks();
    const stored = await Report.findById(id).lean();
    expect(stored.status).toBe('RESOLVED');
  });

  it('never lets a note land after a concurrent close', async () => {
    const id = await seedUnderReview();

    const [closeRes, noteRes] = await Promise.all([
      patchStatus(id, { status: 'DISMISSED' }),
      request(app)
        .post(`/api/v1/moderator/reports/${id}/updates`)
        .set('Authorization', authHeader)
        .send({ message: 'Racing note from another moderator.' }),
    ]);

    expect(closeRes.status).toBe(200);
    expect([201, 409]).toContain(noteRes.status);

    const stored = await Report.findById(id).lean();
    const closeIndex = stored.updates.findIndex((u) => u.status === 'DISMISSED');
    const noteIndex = stored.updates.findIndex((u) => u.message === 'Racing note from another moderator.');

    if (noteRes.status === 201) {
      expect(noteIndex).toBeLessThan(closeIndex);
    } else {
      expect(noteIndex).toBe(-1);
    }
  });

  it('returns 404 when the report is deleted between read and write', async () => {
    const id = await seedUnderReview();

    jest.spyOn(Report, 'findById').mockImplementationOnce(() => ({
      select: () => Promise.resolve({ status: 'UNDER_REVIEW' }),
    }));
    await Report.deleteMany({});

    const res = await patchStatus(id, { status: 'RESOLVED' });
    expect(res.status).toBe(404);
  });
});
