'use strict';

const { app, request, loginAsModerator } = require('./setup/helpers');
const db = require('./setup/testDb');
const Report = require('../src/models/Report');

beforeAll(db.connect);
afterEach(db.clear);
afterAll(db.close);

let authHeader;

const list = (query = '') =>
  request(app).get(`/api/v1/moderator/reports${query}`).set('Authorization', authHeader);

/**
 * Seeds four reports with fixed dates. Dates are written with the raw driver
 * because createdAt is immutable through Mongoose (and coarsened on submit).
 */
async function seed() {
  const fixtures = [
    {
      key: 'creds',
      category: 'SECURITY',
      description: 'Production database credentials are committed to a public repository.',
      evidenceUrl: 'https://example.com/evidence/creds',
      createdAt: '2026-09-01T09:00:00Z',
    },
    {
      key: 'invoice',
      category: 'CORRUPTION',
      description: 'Vendor invoices are approved by the same manager who requested the purchase.',
      createdAt: '2026-09-10T12:00:00Z',
    },
    {
      key: 'firewall',
      category: 'SECURITY',
      description: 'The office firewall allows inbound connections on every port from any address.',
      createdAt: '2026-09-21T23:30:00Z',
    },
    {
      key: 'shouting',
      category: 'HARASSMENT',
      description: 'A team lead repeatedly shouts at junior staff during the weekly stand-up.',
      evidenceUrl: 'https://example.com/evidence/recording',
      createdAt: '2026-09-30T08:15:00Z',
    },
  ];

  const ids = {};
  for (const fixture of fixtures) {
    // eslint-disable-next-line no-await-in-loop
    await request(app)
      .post('/api/v1/reports')
      .send({
        category: fixture.category,
        description: fixture.description,
        ...(fixture.evidenceUrl ? { evidenceUrl: fixture.evidenceUrl } : {}),
      });
    // eslint-disable-next-line no-await-in-loop
    const doc = await Report.findOne({ description: fixture.description });
    const date = new Date(fixture.createdAt);
    // eslint-disable-next-line no-await-in-loop
    await Report.collection.updateOne(
      { _id: doc._id },
      { $set: { createdAt: date, updatedAt: date } }
    );
    ids[fixture.key] = doc._id.toString();
  }
  return ids;
}

const keysOf = (res, ids) => {
  const byId = Object.fromEntries(Object.entries(ids).map(([key, id]) => [id, key]));
  return res.body.data.map((report) => byId[report.id]);
};

beforeEach(async () => {
  ({ authHeader } = await loginAsModerator());
});

describe('full-text search (q)', () => {
  it('finds reports by words in the description', async () => {
    const ids = await seed();
    const res = await list('?q=firewall');

    expect(res.status).toBe(200);
    expect(keysOf(res, ids)).toEqual(['firewall']);
    expect(res.body.meta.filters.q).toBe('firewall');
  });

  it('matches word stems ("credential" finds "credentials")', async () => {
    const ids = await seed();
    expect(keysOf(await list('?q=credential'), ids)).toEqual(['creds']);
  });

  it('is case-insensitive and matches any of several words', async () => {
    const ids = await seed();
    const res = await list('?q=INVOICES%20firewall&sort=oldest');
    expect(keysOf(res, ids)).toEqual(['invoice', 'firewall']);
  });

  it('treats regex metacharacters as plain text', async () => {
    await seed();
    const res = await list(`?q=${encodeURIComponent('(a+)+$ .*')}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('returns an empty page when nothing matches', async () => {
    await seed();
    const res = await list('?q=submarine');

    expect(res.body.data).toEqual([]);
    expect(res.body.meta.total).toBe(0);
  });

  it.each([
    ['too short', '?q=a'],
    ['too long', `?q=${'x'.repeat(101)}`],
  ])('rejects a query that is %s', async (_label, query) => {
    const res = await list(query);
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe('query.q');
  });
});

describe('date range (from / to)', () => {
  it('filters with an inclusive from', async () => {
    const ids = await seed();
    const res = await list('?from=2026-09-21&sort=oldest');
    expect(keysOf(res, ids)).toEqual(['firewall', 'shouting']);
  });

  it('treats a date-only "to" as the end of that day', async () => {
    const ids = await seed();
    // "firewall" was filed at 23:30 on the 21st and must be included.
    const res = await list('?to=2026-09-21&sort=oldest');
    expect(keysOf(res, ids)).toEqual(['creds', 'invoice', 'firewall']);
  });

  it('accepts full date-times', async () => {
    const ids = await seed();
    const res = await list('?from=2026-09-10T12:00:00Z&to=2026-09-21T23:00:00Z');
    expect(keysOf(res, ids)).toEqual(['invoice']);
  });

  it('echoes the normalised range in meta', async () => {
    await seed();
    const res = await list('?from=2026-09-01&to=2026-09-30');
    expect(res.body.meta.filters).toMatchObject({
      from: '2026-09-01T00:00:00.000Z',
      toExclusive: '2026-10-01T00:00:00.000Z',
    });
  });

  it('rejects a range that ends before it starts', async () => {
    const res = await list('?from=2026-09-21&to=2026-09-01');

    expect(res.status).toBe(400);
    expect(res.body.error.details[0]).toEqual({
      field: 'query.to',
      message: 'to must not be earlier than from',
    });
  });

  it.each(['yesterday', '21/09/2026', '2026-13-45', '1726900000'])(
    'rejects a malformed date (%s)',
    async (value) => {
      const res = await list(`?from=${value}`);
      expect(res.status).toBe(400);
      expect(res.body.error.details[0].field).toBe('query.from');
    }
  );
});

describe('hasEvidence', () => {
  it('true returns only reports with an evidence link', async () => {
    const ids = await seed();
    const res = await list('?hasEvidence=true&sort=oldest');

    expect(keysOf(res, ids)).toEqual(['creds', 'shouting']);
    expect(res.body.data.every((r) => r.hasEvidence)).toBe(true);
  });

  it('false returns only reports without one', async () => {
    const ids = await seed();
    expect(keysOf(await list('?hasEvidence=false&sort=oldest'), ids)).toEqual([
      'invoice',
      'firewall',
    ]);
  });

  it('rejects anything other than true/false', async () => {
    const res = await list('?hasEvidence=yes');

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].message).toBe('hasEvidence must be true or false');
  });
});

describe('sort', () => {
  it('newest (default) and oldest order by submission time', async () => {
    const ids = await seed();

    expect(keysOf(await list(), ids)).toEqual(['shouting', 'firewall', 'invoice', 'creds']);
    expect(keysOf(await list('?sort=oldest'), ids)).toEqual([
      'creds',
      'invoice',
      'firewall',
      'shouting',
    ]);
  });

  it('recentlyUpdated puts the most recently worked-on report first', async () => {
    const ids = await seed();
    await request(app)
      .patch(`/api/v1/moderator/reports/${ids.creds}/status`)
      .set('Authorization', authHeader)
      .send({ status: 'UNDER_REVIEW' });

    const res = await list('?sort=recentlyUpdated');

    expect(keysOf(res, ids)[0]).toBe('creds');
    expect(res.body.meta.sort).toBe('recentlyUpdated');
  });

  it('rejects an unknown sort', async () => {
    const res = await list('?sort=random');
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].message).toMatch(/newest, oldest, recentlyUpdated/);
  });
});

describe('combined filters', () => {
  it('applies text, category, evidence and date filters together', async () => {
    const ids = await seed();
    const res = await list(
      '?q=database%20firewall&category=security&hasEvidence=true&from=2026-08-01&to=2026-09-30'
    );

    expect(keysOf(res, ids)).toEqual(['creds']);
    expect(res.body.meta.filters).toMatchObject({
      q: 'database firewall',
      category: 'SECURITY',
      hasEvidence: true,
    });
  });

  it('combines search with status and pagination', async () => {
    const ids = await seed();
    await request(app)
      .patch(`/api/v1/moderator/reports/${ids.firewall}/status`)
      .set('Authorization', authHeader)
      .send({ status: 'UNDER_REVIEW' });

    const open = await list('?q=firewall%20credentials&status=SUBMITTED');
    const paged = await list('?q=firewall%20credentials&limit=1&page=2&sort=oldest');

    expect(keysOf(open, ids)).toEqual(['creds']);
    expect(keysOf(paged, ids)).toEqual(['firewall']);
    expect(paged.body.meta).toMatchObject({ total: 2, totalPages: 2, page: 2, limit: 1 });
  });

  it('caps the page size at 100', async () => {
    const res = await list('?limit=101');
    expect(res.status).toBe(400);
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/v1/moderator/reports?q=firewall');
    expect(res.status).toBe(401);
  });
});
