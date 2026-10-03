'use strict';

const { app, request, VALID_REPORT } = require('./setup/helpers');
const db = require('./setup/testDb');
const Report = require('../src/models/Report');

beforeAll(db.connect);
afterEach(db.clear);
afterAll(db.close);

describe('POST /api/v1/reports — anonymous submission', () => {
  it('accepts a valid report and returns a case code once', async () => {
    const res = await request(app).post('/api/v1/reports').send(VALID_REPORT);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.caseCode).toMatch(/^WD-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    expect(res.body.data.status).toBe('SUBMITTED');
    expect(res.body.data.category).toBe('SECURITY');
    expect(res.body.message).toMatch(/only once/i);
  });

  it('never returns the stored hash or the internal id to the reporter', async () => {
    const res = await request(app).post('/api/v1/reports').send(VALID_REPORT);
    const body = JSON.stringify(res.body);

    expect(body).not.toMatch(/caseCodeHash/i);
    expect(res.body.data.id).toBeUndefined();
    expect(res.body.data._id).toBeUndefined();
  });

  it('stores only the hash of the case code, never the code itself', async () => {
    const res = await request(app).post('/api/v1/reports').send(VALID_REPORT);
    const stored = await Report.findOne().select('+caseCodeHash').lean();

    expect(stored.caseCodeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(res.body.data.caseCode.replace(/-/g, ''));
    expect(JSON.stringify(stored)).not.toContain(res.body.data.caseCode);
  });

  it('gives every report a different case code', async () => {
    const codes = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await request(app).post('/api/v1/reports').send(VALID_REPORT);
      codes.push(res.body.data.caseCode);
    }
    expect(new Set(codes).size).toBe(5);
  });

  it('returns an empty warnings list for text with nothing identifying', async () => {
    const res = await request(app).post('/api/v1/reports').send(VALID_REPORT);
    expect(res.body.data.warnings).toEqual([]);
  });

  it('warns — but still accepts — a description that may identify the reporter', async () => {
    const res = await request(app)
      .post('/api/v1/reports')
      .send({
        ...VALID_REPORT,
        description:
          'My name is Arjun. The admin password is shared in chat; reach me at arjun.k@example.com or 9876543210.',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.caseCode).toBeDefined();
    expect(res.body.data.warnings.map((w) => w.code)).toEqual([
      'POSSIBLE_EMAIL',
      'POSSIBLE_PHONE_NUMBER',
      'POSSIBLE_SELF_IDENTIFICATION',
    ]);
    expect(res.body.data.warnings[0].message).toMatch(/email address/i);

    // The warning describes the kind of finding without repeating it.
    const serialisedWarnings = JSON.stringify(res.body.data.warnings);
    expect(serialisedWarnings).not.toContain('arjun.k@example.com');
    expect(serialisedWarnings).not.toContain('9876543210');
    expect(serialisedWarnings).not.toContain('Arjun');
  });

  it('stores nothing extra about a PII warning', async () => {
    await request(app)
      .post('/api/v1/reports')
      .send({ ...VALID_REPORT, description: `${VALID_REPORT.description} Contact me at a@b.co.` });

    const stored = await Report.findOne().lean();
    expect(Object.keys(stored)).not.toContain('warnings');
  });

  it('normalises a lower-case category', async () => {
    const res = await request(app)
      .post('/api/v1/reports')
      .send({ ...VALID_REPORT, category: 'harassment' });

    expect(res.status).toBe(201);
    expect(res.body.data.category).toBe('HARASSMENT');
  });

  it('treats evidenceUrl as optional', async () => {
    const res = await request(app)
      .post('/api/v1/reports')
      .send({ category: 'OTHER', description: VALID_REPORT.description });

    expect(res.status).toBe(201);
    const stored = await Report.findOne().lean();
    expect(stored.evidenceUrl).toBeNull();
  });

  describe('validation', () => {
    it('rejects a description that is too short', async () => {
      const res = await request(app)
        .post('/api/v1/reports')
        .send({ ...VALID_REPORT, description: 'too short' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('Validation failed');
      expect(res.body.error.details).toContainEqual({
        field: 'body.description',
        message: 'description must be at least 20 characters',
      });
    });

    it('rejects a description beyond the maximum length', async () => {
      const res = await request(app)
        .post('/api/v1/reports')
        .send({ ...VALID_REPORT, description: 'x'.repeat(5001) });

      expect(res.status).toBe(400);
    });

    it('rejects an unknown category', async () => {
      const res = await request(app)
        .post('/api/v1/reports')
        .send({ ...VALID_REPORT, category: 'GOSSIP' });

      expect(res.status).toBe(400);
      expect(res.body.error.details[0].message).toMatch(/category must be one of/);
    });

    it('rejects a missing body entirely', async () => {
      const res = await request(app).post('/api/v1/reports').send({});
      expect(res.status).toBe(400);
      expect(res.body.error.details.length).toBeGreaterThanOrEqual(2);
    });

    it('rejects a non-http evidence URL (no javascript: or data: links)', async () => {
      for (const evidenceUrl of ['javascript:alert(1)', 'data:text/html,<script>', 'not-a-url']) {
        // eslint-disable-next-line no-await-in-loop
        const res = await request(app)
          .post('/api/v1/reports')
          .send({ ...VALID_REPORT, evidenceUrl });

        expect(res.status).toBe(400);
      }
    });

    it('rejects malformed JSON with 400 rather than crashing', async () => {
      const res = await request(app)
        .post('/api/v1/reports')
        .set('Content-Type', 'application/json')
        .send('{"category": "SECURITY",');

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/valid JSON/i);
    });
  });

  describe('privacy', () => {
    it('refuses a payload carrying identifying fields instead of silently keeping them', async () => {
      const res = await request(app)
        .post('/api/v1/reports')
        .send({ ...VALID_REPORT, email: 'reporter@example.com', reporterName: 'Alice' });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.error.details)).toMatch(/Unrecognized key/i);
    });

    it('stores only a coarsened submission time, in createdAt and inside the id', async () => {
      const before = Date.now();
      const res = await request(app).post('/api/v1/reports').send(VALID_REPORT);
      const stored = await Report.findOne().lean();
      const bucketMs = 15 * 60 * 1000;

      // Exactly on a 15-minute boundary, and within the current window.
      expect(stored.createdAt.getTime() % bucketMs).toBe(0);
      expect(stored.createdAt.getTime()).toBeLessThanOrEqual(before);
      expect(before - stored.createdAt.getTime()).toBeLessThan(bucketMs);

      // updatedAt and the ObjectId's embedded time leak nothing more precise.
      expect(stored.updatedAt.getTime()).toBe(stored.createdAt.getTime());
      expect(stored._id.getTimestamp().getTime()).toBe(stored.createdAt.getTime());

      // The reporter is shown the same coarse value.
      expect(new Date(res.body.data.submittedAt).getTime()).toBe(stored.createdAt.getTime());
    });

    it('stores no network identifiers even when the client sends them', async () => {
      await request(app)
        .post('/api/v1/reports')
        .set('User-Agent', 'Mozilla/5.0 (very-identifying-agent)')
        .set('X-Forwarded-For', '203.0.113.42')
        .set('Referer', 'https://intranet.example.com/hr')
        .send(VALID_REPORT);

      const stored = await Report.findOne().select('+caseCodeHash').lean();
      const keys = Object.keys(stored);
      const serialised = JSON.stringify(stored);

      expect(keys.sort()).toEqual(
        [
          '_id',
          '__v',
          'caseCodeHash',
          'category',
          'createdAt',
          'description',
          'evidenceUrl',
          'status',
          'updatedAt',
          'updates',
        ].sort()
      );
      expect(serialised).not.toContain('203.0.113.42');
      expect(serialised).not.toContain('very-identifying-agent');
      expect(serialised).not.toContain('intranet.example.com');
    });
  });
});

describe('GET /api/v1/reports/:caseCode — anonymous tracking', () => {
  async function submit(payload = VALID_REPORT) {
    const res = await request(app).post('/api/v1/reports').send(payload);
    return res.body.data.caseCode;
  }

  it('returns the current status for a valid code', async () => {
    const caseCode = await submit();
    const res = await request(app).get(`/api/v1/reports/${caseCode}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      category: 'SECURITY',
      status: 'SUBMITTED',
      isClosed: false,
      updates: [],
    });
    expect(res.body.data.submittedAt).toBeDefined();
  });

  it('accepts the code in any case, with or without separators', async () => {
    const caseCode = await submit();
    const variants = [
      caseCode.toLowerCase(),
      caseCode.replace(/-/g, ''),
      caseCode.replace(/-/g, ' '),
    ];

    for (const variant of variants) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).get(`/api/v1/reports/${encodeURIComponent(variant)}`);
      expect(res.status).toBe(200);
    }
  });

  it('does not expose the report body, internal id or moderator identity', async () => {
    const caseCode = await submit();
    const res = await request(app).get(`/api/v1/reports/${caseCode}`);

    expect(res.body.data.description).toBeUndefined();
    expect(res.body.data.evidenceUrl).toBeUndefined();
    expect(res.body.data.id).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/moderator|caseCodeHash/i);
  });

  it('returns 404 for a well-formed but unknown code', async () => {
    const res = await request(app).get('/api/v1/reports/WD-AAAAA-BBBBB-CCCCC');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.message).toMatch(/no case found/i);
  });

  it('returns 400 for a code that cannot be a case code at all', async () => {
    const res = await request(app).get('/api/v1/reports/abc');

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe('params.caseCode');
  });

  it('keeps cases isolated — one code never reveals another', async () => {
    const first = await submit();
    const second = await submit({ ...VALID_REPORT, category: 'CORRUPTION' });

    const firstRes = await request(app).get(`/api/v1/reports/${first}`);
    const secondRes = await request(app).get(`/api/v1/reports/${second}`);

    expect(firstRes.body.data.category).toBe('SECURITY');
    expect(secondRes.body.data.category).toBe('CORRUPTION');
  });
});

describe('caching', () => {
  const expectNoStore = (res) => {
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.pragma).toBe('no-cache');
  };

  it('forbids caching of the tracking response', async () => {
    const submitted = await request(app).post('/api/v1/reports').send(VALID_REPORT);
    const res = await request(app).get(`/api/v1/reports/${submitted.body.data.caseCode}`);

    expect(res.status).toBe(200);
    expectNoStore(res);
  });

  it('forbids caching of the submission response, which carries the case code', async () => {
    const res = await request(app).post('/api/v1/reports').send(VALID_REPORT);

    expect(res.status).toBe(201);
    expectNoStore(res);
  });

  it('forbids caching of tracking errors too', async () => {
    const notFound = await request(app).get('/api/v1/reports/WD-AAAAA-BBBBB-CCCCC');
    const malformed = await request(app).get('/api/v1/reports/abc');

    expect(notFound.status).toBe(404);
    expect(malformed.status).toBe(400);
    expectNoStore(notFound);
    expectNoStore(malformed);
  });
});

describe('service metadata', () => {
  it('publishes categories, statuses and the workflow', async () => {
    const res = await request(app).get('/api/v1/meta');

    expect(res.status).toBe(200);
    expect(res.body.data.categories).toContain('SECURITY');
    expect(res.body.data.workflow.SUBMITTED).toEqual(['UNDER_REVIEW', 'DISMISSED']);
    expect(res.body.data.workflow.RESOLVED).toEqual([]);
  });

  it('answers the health probe', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
  });

  it('returns 404 in the standard error shape for unknown routes', async () => {
    const res = await request(app).get('/api/v1/nope');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      error: { message: 'Route GET /api/v1/nope does not exist' },
    });
  });
});
