'use strict';

const { app, request, VALID_REPORT, loginAsModerator } = require('./setup/helpers');
const db = require('./setup/testDb');
const Report = require('../src/models/Report');

const DAY_SECONDS = 24 * 60 * 60;

// Run MongoDB's TTL monitor every second instead of every 60, so the test can
// watch a closed report actually being deleted.
beforeAll(() => db.connect({ instance: { args: ['--setParameter', 'ttlMonitorSleepSecs=1'] } }));
afterEach(async () => {
  jest.restoreAllMocks();
  await db.clear();
});
afterAll(db.close);

let authHeader;

beforeEach(async () => {
  ({ authHeader } = await loginAsModerator());
});

// Reports filed in the same time bucket have no meaningful order, so a report
// is found by its (unique per test) category rather than by list position.
async function seedReport(category = 'SECURITY') {
  await request(app)
    .post('/api/v1/reports')
    .send({ ...VALID_REPORT, category });
  const list = await request(app)
    .get(`/api/v1/moderator/reports?category=${category}`)
    .set('Authorization', authHeader);
  return list.body.data[0].id;
}

const patchStatus = (id, status) =>
  request(app)
    .patch(`/api/v1/moderator/reports/${id}/status`)
    .set('Authorization', authHeader)
    .send({ status });

describe('closedAt', () => {
  it('is null while a report is open', async () => {
    const id = await seedReport();
    expect((await Report.findById(id).lean()).closedAt).toBeNull();

    const res = await patchStatus(id, 'UNDER_REVIEW');
    expect(res.body.data.closedAt).toBeNull();
  });

  it.each(['RESOLVED', 'DISMISSED'])('is set when the report becomes %s', async (finalStatus) => {
    const id = await seedReport();
    await patchStatus(id, 'UNDER_REVIEW');

    const before = Date.now();
    const res = await patchStatus(id, finalStatus);

    expect(res.status).toBe(200);
    const closedAt = new Date(res.body.data.closedAt).getTime();
    expect(closedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(closedAt).toBeLessThanOrEqual(Date.now());
  });

  it('is written in the same atomic operation as the status', async () => {
    const id = await seedReport();
    await patchStatus(id, 'UNDER_REVIEW');

    const spy = jest.spyOn(Report, 'findOneAndUpdate');
    await patchStatus(id, 'RESOLVED');

    expect(spy).toHaveBeenCalledTimes(1);
    const [filter, update] = spy.mock.calls[0];
    expect(filter).toMatchObject({ status: 'UNDER_REVIEW' });
    expect(update.$set.status).toBe('RESOLVED');
    expect(update.$set.closedAt).toBeInstanceOf(Date);
  });
});

describe('retention TTL index', () => {
  it('exists with the configured expiry (default 365 days)', async () => {
    const indexes = await Report.collection.indexes();
    const ttl = indexes.find((index) => index.name === 'closedAt_retention_ttl');

    expect(ttl).toBeDefined();
    expect(ttl.key).toEqual({ closedAt: 1 });
    expect(ttl.expireAfterSeconds).toBe(365 * DAY_SECONDS);
  });

  it('lets MongoDB delete a report once it has been closed for longer than the retention period', async () => {
    const expiredId = await seedReport();
    await patchStatus(expiredId, 'DISMISSED');
    const openId = await seedReport('OTHER');

    // Pretend the case was closed 400 days ago.
    await Report.updateOne(
      { _id: expiredId },
      { $set: { closedAt: new Date(Date.now() - 400 * DAY_SECONDS * 1000) } }
    );

    let remaining;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      remaining = await Report.findById(expiredId).lean();
      if (!remaining) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    expect(remaining).toBeNull();
    // An open report (closedAt = null) is never touched.
    expect(await Report.findById(openId).lean()).not.toBeNull();
  });
});
