'use strict';

const { app, request, VALID_REPORT, loginAsModerator } = require('./setup/helpers');
const db = require('./setup/testDb');

beforeAll(db.connect);
afterEach(db.clear);
afterAll(db.close);

let authHeader;

beforeEach(async () => {
  ({ authHeader } = await loginAsModerator());
});

/** Submits a report and returns { caseCode, id } as the moderator sees it. */
async function seedReport(overrides = {}) {
  const submission = await request(app)
    .post('/api/v1/reports')
    .send({ ...VALID_REPORT, ...overrides });

  const list = await request(app)
    .get('/api/v1/moderator/reports?limit=100')
    .set('Authorization', authHeader);

  const created = list.body.data.find((r) => r.category === (overrides.category || 'SECURITY'));
  return { caseCode: submission.body.data.caseCode, id: created.id };
}

function patchStatus(id, body) {
  return request(app)
    .patch(`/api/v1/moderator/reports/${id}/status`)
    .set('Authorization', authHeader)
    .send(body);
}

describe('GET /api/v1/moderator/reports', () => {
  it('lists reports newest first with pagination metadata', async () => {
    await seedReport();
    await seedReport({ category: 'TECHNICAL' });

    const res = await request(app).get('/api/v1/moderator/reports').set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 20, total: 2, totalPages: 1 });
    expect(new Date(res.body.data[0].submittedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(res.body.data[1].submittedAt).getTime()
    );
  });

  it('never includes the case code hash in the list', async () => {
    await seedReport();
    const res = await request(app).get('/api/v1/moderator/reports').set('Authorization', authHeader);

    expect(JSON.stringify(res.body)).not.toMatch(/caseCodeHash/i);
  });

  it('filters by status', async () => {
    const { id } = await seedReport();
    await seedReport({ category: 'TECHNICAL' });
    await patchStatus(id, { status: 'UNDER_REVIEW' });

    const underReview = await request(app)
      .get('/api/v1/moderator/reports?status=UNDER_REVIEW')
      .set('Authorization', authHeader);

    expect(underReview.body.data).toHaveLength(1);
    expect(underReview.body.data[0].id).toBe(id);
    expect(underReview.body.meta.filters.status).toBe('UNDER_REVIEW');
  });

  it('filters by category, accepting lower case', async () => {
    await seedReport();
    await seedReport({ category: 'CORRUPTION' });

    const res = await request(app)
      .get('/api/v1/moderator/reports?category=corruption')
      .set('Authorization', authHeader);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].category).toBe('CORRUPTION');
  });

  it('combines filters and returns an empty list when nothing matches', async () => {
    await seedReport();

    const res = await request(app)
      .get('/api/v1/moderator/reports?category=SECURITY&status=RESOLVED')
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.total).toBe(0);
  });

  it('paginates', async () => {
    await seedReport();
    await seedReport({ category: 'TECHNICAL' });
    await seedReport({ category: 'OTHER' });

    const page2 = await request(app)
      .get('/api/v1/moderator/reports?page=2&limit=2')
      .set('Authorization', authHeader);

    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.meta).toMatchObject({ page: 2, limit: 2, total: 3, totalPages: 2 });
  });

  it('rejects invalid filter and pagination values', async () => {
    const badStatus = await request(app)
      .get('/api/v1/moderator/reports?status=PENDING')
      .set('Authorization', authHeader);
    const badLimit = await request(app)
      .get('/api/v1/moderator/reports?limit=500')
      .set('Authorization', authHeader);

    expect(badStatus.status).toBe(400);
    expect(badLimit.status).toBe(400);
  });
});

describe('GET /api/v1/moderator/reports/:id', () => {
  it('returns the full report including description and allowed transitions', async () => {
    const { id } = await seedReport();

    const res = await request(app)
      .get(`/api/v1/moderator/reports/${id}`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id,
      category: 'SECURITY',
      description: VALID_REPORT.description,
      status: 'SUBMITTED',
      allowedTransitions: ['UNDER_REVIEW', 'DISMISSED'],
    });
    expect(JSON.stringify(res.body)).not.toMatch(/caseCodeHash/i);
  });

  it('forbids caching of report contents', async () => {
    const { id } = await seedReport();
    const res = await request(app)
      .get(`/api/v1/moderator/reports/${id}`)
      .set('Authorization', authHeader);

    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('returns 404 for an unknown id', async () => {
    const res = await request(app)
      .get('/api/v1/moderator/reports/64b7f1a2c3d4e5f6a7b8c9d0')
      .set('Authorization', authHeader);

    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Report not found');
  });

  it('returns 400 for a malformed id instead of a cast error', async () => {
    const res = await request(app)
      .get('/api/v1/moderator/reports/not-an-id')
      .set('Authorization', authHeader);

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe('params.id');
  });
});

describe('PATCH /api/v1/moderator/reports/:id/status — workflow enforcement', () => {
  it('moves SUBMITTED → UNDER_REVIEW and records who did it', async () => {
    const { id } = await seedReport();

    const res = await patchStatus(id, {
      status: 'UNDER_REVIEW',
      message: 'We have opened an investigation into this report.',
    });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('UNDER_REVIEW');
    expect(res.body.data.allowedTransitions).toEqual(['RESOLVED', 'DISMISSED']);
    expect(res.body.data.updates).toHaveLength(1);
    expect(res.body.data.updates[0]).toMatchObject({
      status: 'UNDER_REVIEW',
      message: 'We have opened an investigation into this report.',
      moderator: { displayName: 'Ethics Desk' },
    });
  });

  it('writes a default message when none is supplied', async () => {
    const { id } = await seedReport();
    const res = await patchStatus(id, { status: 'UNDER_REVIEW' });

    expect(res.body.data.updates[0].message).toBe('Status changed to UNDER_REVIEW');
  });

  it('completes the full path to RESOLVED', async () => {
    const { id } = await seedReport();
    await patchStatus(id, { status: 'UNDER_REVIEW' });

    const res = await patchStatus(id, { status: 'RESOLVED', message: 'Credentials rotated.' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('RESOLVED');
    expect(res.body.data.allowedTransitions).toEqual([]);
  });

  it('allows dismissing straight from SUBMITTED', async () => {
    const { id } = await seedReport();
    const res = await patchStatus(id, { status: 'DISMISSED', message: 'Duplicate of an open case.' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('DISMISSED');
  });

  it('rejects skipping review (SUBMITTED → RESOLVED) with 422 and the allowed options', async () => {
    const { id } = await seedReport();
    const res = await patchStatus(id, { status: 'RESOLVED' });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe('Cannot change status from SUBMITTED to RESOLVED');
    expect(res.body.error.details).toEqual({
      currentStatus: 'SUBMITTED',
      requestedStatus: 'RESOLVED',
      allowedTransitions: ['UNDER_REVIEW', 'DISMISSED'],
    });
  });

  it('rejects moving backwards', async () => {
    const { id } = await seedReport();
    await patchStatus(id, { status: 'UNDER_REVIEW' });

    const res = await patchStatus(id, { status: 'SUBMITTED' });
    expect(res.status).toBe(422);
  });

  it('rejects any change once a case is closed', async () => {
    const { id } = await seedReport();
    await patchStatus(id, { status: 'DISMISSED' });

    const res = await patchStatus(id, { status: 'UNDER_REVIEW' });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/closed \(DISMISSED\)/);
  });

  it('returns 409 when the report is already in the requested status', async () => {
    const { id } = await seedReport();
    const res = await patchStatus(id, { status: 'SUBMITTED' });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('Report is already SUBMITTED');
  });

  it('leaves the status untouched when a transition is rejected', async () => {
    const { id } = await seedReport();
    await patchStatus(id, { status: 'RESOLVED' });

    const after = await request(app)
      .get(`/api/v1/moderator/reports/${id}`)
      .set('Authorization', authHeader);

    expect(after.body.data.status).toBe('SUBMITTED');
    expect(after.body.data.updates).toHaveLength(0);
  });

  it('validates the payload', async () => {
    const { id } = await seedReport();

    const missing = await patchStatus(id, {});
    const unknown = await patchStatus(id, { status: 'ARCHIVED' });
    const shortMessage = await patchStatus(id, { status: 'UNDER_REVIEW', message: 'hi' });

    expect(missing.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect(shortMessage.status).toBe(400);
  });

  it('requires authentication', async () => {
    const { id } = await seedReport();
    const res = await request(app)
      .patch(`/api/v1/moderator/reports/${id}/status`)
      .send({ status: 'UNDER_REVIEW' });

    expect(res.status).toBe(401);
  });
});

describe('POST /api/v1/moderator/reports/:id/updates', () => {
  it('adds a note without changing the status', async () => {
    const { id } = await seedReport();

    const res = await request(app)
      .post(`/api/v1/moderator/reports/${id}/updates`)
      .set('Authorization', authHeader)
      .send({ message: 'Still gathering information from the infrastructure team.' });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('SUBMITTED');
    expect(res.body.data.updates).toHaveLength(1);
    expect(res.body.data.updates[0].status).toBeNull();
  });

  it('refuses updates on a closed case', async () => {
    const { id } = await seedReport();
    await patchStatus(id, { status: 'DISMISSED' });

    const res = await request(app)
      .post(`/api/v1/moderator/reports/${id}/updates`)
      .set('Authorization', authHeader)
      .send({ message: 'One more thought on this case.' });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/closed \(DISMISSED\)/);
  });

  it('validates the message', async () => {
    const { id } = await seedReport();

    const empty = await request(app)
      .post(`/api/v1/moderator/reports/${id}/updates`)
      .set('Authorization', authHeader)
      .send({});
    const tooLong = await request(app)
      .post(`/api/v1/moderator/reports/${id}/updates`)
      .set('Authorization', authHeader)
      .send({ message: 'x'.repeat(501) });

    expect(empty.status).toBe(400);
    expect(tooLong.status).toBe(400);
  });
});

describe('update visibility', () => {
  const addNote = (id, body) =>
    request(app)
      .post(`/api/v1/moderator/reports/${id}/updates`)
      .set('Authorization', authHeader)
      .send(body);

  it('defaults to PUBLIC', async () => {
    const { id } = await seedReport();
    const res = await addNote(id, { message: 'We are looking into this now.' });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Update added');
    expect(res.body.data.updates[0].visibility).toBe('PUBLIC');
  });

  it('accepts INTERNAL (case-insensitive) and shows it to moderators', async () => {
    const { id } = await seedReport();
    const res = await addNote(id, { message: 'Suspect this is the payroll team.', visibility: 'internal' });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Internal note added');
    expect(res.body.data.updates[0]).toMatchObject({
      message: 'Suspect this is the payroll team.',
      visibility: 'INTERNAL',
    });

    const detail = await request(app)
      .get(`/api/v1/moderator/reports/${id}`)
      .set('Authorization', authHeader);
    expect(detail.body.data.updates.map((u) => u.visibility)).toEqual(['INTERNAL']);
  });

  it('never sends an INTERNAL note to the reporter', async () => {
    const { id, caseCode } = await seedReport();
    await addNote(id, { message: 'Public: we have received your report.' });
    await addNote(id, { message: 'INTERNAL-ONLY: cross-check with badge logs.', visibility: 'INTERNAL' });

    const tracked = await request(app).get(`/api/v1/reports/${caseCode}`);

    expect(tracked.body.data.updates).toEqual([
      expect.objectContaining({ message: 'Public: we have received your report.' }),
    ]);
    const payload = JSON.stringify(tracked.body);
    expect(payload).not.toContain('INTERNAL-ONLY');
    expect(payload).not.toContain('badge logs');
    expect(payload).not.toMatch(/visibility/i);
  });

  it('does not reveal internal activity through the reporter lastUpdatedAt', async () => {
    const { id, caseCode } = await seedReport();
    const before = await request(app).get(`/api/v1/reports/${caseCode}`);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await addNote(id, { message: 'Private discussion between moderators.', visibility: 'INTERNAL' });

    const after = await request(app).get(`/api/v1/reports/${caseCode}`);
    expect(after.body.data.lastUpdatedAt).toBe(before.body.data.lastUpdatedAt);
  });

  it('moves the reporter lastUpdatedAt for PUBLIC updates', async () => {
    const { id, caseCode } = await seedReport();
    const res = await addNote(id, { message: 'We have started the review.' });

    const tracked = await request(app).get(`/api/v1/reports/${caseCode}`);
    expect(tracked.body.data.lastUpdatedAt).toBe(res.body.data.updates[0].createdAt);
  });

  it('marks status-change updates as PUBLIC', async () => {
    const { id } = await seedReport();
    const res = await patchStatus(id, { status: 'UNDER_REVIEW' });
    expect(res.body.data.updates[0].visibility).toBe('PUBLIC');
  });

  it('rejects an unknown visibility', async () => {
    const { id } = await seedReport();
    const res = await addNote(id, { message: 'Some note text here.', visibility: 'SECRET' });

    expect(res.status).toBe(400);
    expect(res.body.error.details[0]).toEqual({
      field: 'body.visibility',
      message: 'visibility must be one of: PUBLIC, INTERNAL',
    });
  });

  it('requires authentication for internal notes too', async () => {
    const { id } = await seedReport();
    const res = await request(app)
      .post(`/api/v1/moderator/reports/${id}/updates`)
      .send({ message: 'Unauthenticated note.', visibility: 'INTERNAL' });

    expect(res.status).toBe(401);
  });
});

describe('end-to-end: reporter sees moderator progress', () => {
  it('surfaces status changes and notes on the tracking endpoint, without moderator identity', async () => {
    const { id, caseCode } = await seedReport();

    await patchStatus(id, {
      status: 'UNDER_REVIEW',
      message: 'A moderator has started reviewing this case.',
    });
    await request(app)
      .post(`/api/v1/moderator/reports/${id}/updates`)
      .set('Authorization', authHeader)
      .send({ message: 'We expect an outcome within two weeks.' });
    await patchStatus(id, { status: 'RESOLVED', message: 'The exposed credentials were rotated.' });

    const tracked = await request(app).get(`/api/v1/reports/${caseCode}`);

    expect(tracked.status).toBe(200);
    expect(tracked.body.data.status).toBe('RESOLVED');
    expect(tracked.body.data.isClosed).toBe(true);
    expect(tracked.body.data.updates.map((u) => u.message)).toEqual([
      'A moderator has started reviewing this case.',
      'We expect an outcome within two weeks.',
      'The exposed credentials were rotated.',
    ]);
    // The reporter sees what moderators wrote, never who wrote it: no display
    // name, no moderator id, no `moderator` key anywhere in the payload.
    const payload = JSON.stringify(tracked.body);
    expect(payload).not.toContain('Ethics Desk');
    expect(payload).not.toMatch(/"moderator"/);
    expect(tracked.body.data.updates.every((u) => u.moderator === undefined)).toBe(true);
  });
});

describe('GET /api/v1/moderator/stats', () => {
  it('counts reports per status', async () => {
    const { id } = await seedReport();
    await seedReport({ category: 'OTHER' });
    await patchStatus(id, { status: 'UNDER_REVIEW' });

    const res = await request(app).get('/api/v1/moderator/stats').set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      total: 2,
      byStatus: { SUBMITTED: 1, UNDER_REVIEW: 1 },
    });
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/moderator/stats');
    expect(res.status).toBe(401);
  });
});
