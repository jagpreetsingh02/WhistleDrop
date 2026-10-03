'use strict';

const { app, request, VALID_REPORT, loginAsModerator } = require('./setup/helpers');
const db = require('./setup/testDb');
const Report = require('../src/models/Report');
const AuditLog = require('../src/models/AuditLog');
const { MAX_MESSAGES_PER_REPORT } = require('../src/services/report.service');

beforeAll(db.connect);
afterEach(db.clear);
afterAll(db.close);

let authHeader;

beforeEach(async () => {
  ({ authHeader } = await loginAsModerator());
});

async function seedReport() {
  const submitted = await request(app).post('/api/v1/reports').send(VALID_REPORT);
  const list = await request(app).get('/api/v1/moderator/reports').set('Authorization', authHeader);
  return { caseCode: submitted.body.data.caseCode, id: list.body.data[0].id };
}

const ask = (id, body) =>
  request(app)
    .post(`/api/v1/moderator/reports/${id}/messages`)
    .set('Authorization', authHeader)
    .send({ body });

const reply = (caseCode, body) =>
  request(app).post(`/api/v1/reports/${caseCode}/messages`).send({ body });

const track = (caseCode) => request(app).get(`/api/v1/reports/${caseCode}`);

const listAwaiting = (value) =>
  request(app)
    .get(`/api/v1/moderator/reports?awaitingReporter=${value}`)
    .set('Authorization', authHeader);

describe('full conversation journey', () => {
  it('moderator asks, reporter sees it and replies, moderator sees the answer', async () => {
    const { id, caseCode } = await seedReport();

    // 1. Moderator asks a clarifying question.
    const asked = await ask(id, 'Which repository are the credentials in?');
    expect(asked.status).toBe(201);
    expect(asked.body.data.awaitingReporter).toBe(true);
    expect(asked.body.data.messages).toEqual([
      expect.objectContaining({
        from: 'MODERATOR',
        body: 'Which repository are the credentials in?',
        moderator: expect.objectContaining({ displayName: 'Ethics Desk' }),
      }),
    ]);

    // 2. The case shows up in the "waiting for reporter" queue.
    const waiting = await listAwaiting(true);
    expect(waiting.body.data.map((r) => r.id)).toEqual([id]);
    expect(waiting.body.data[0]).toMatchObject({ awaitingReporter: true, messageCount: 1 });

    // 3. The reporter sees the question, without learning who asked it.
    const seen = await track(caseCode);
    expect(seen.body.data.awaitingYourReply).toBe(true);
    expect(seen.body.data.messages).toEqual([
      {
        from: 'MODERATOR',
        body: 'Which repository are the credentials in?',
        createdAt: expect.any(String),
      },
    ]);

    // 4. The reporter answers with only the case code.
    const answered = await reply(caseCode, 'It is the infra-scripts repo, in the deploy folder.');
    expect(answered.status).toBe(201);
    expect(answered.body.data.awaitingYourReply).toBe(false);
    expect(answered.body.data.messages.map((m) => m.from)).toEqual(['MODERATOR', 'REPORTER']);
    expect(answered.body.data.warnings).toEqual([]);

    // 5. The flag is cleared and the moderator sees the whole thread.
    expect((await listAwaiting(true)).body.data).toEqual([]);
    expect((await listAwaiting(false)).body.data.map((r) => r.id)).toEqual([id]);

    const detail = await request(app)
      .get(`/api/v1/moderator/reports/${id}`)
      .set('Authorization', authHeader);
    expect(detail.body.data.awaitingReporter).toBe(false);
    expect(detail.body.data.messages).toEqual([
      expect.objectContaining({ from: 'MODERATOR', moderator: expect.objectContaining({ displayName: 'Ethics Desk' }) }),
      expect.objectContaining({
        from: 'REPORTER',
        body: 'It is the infra-scripts repo, in the deploy folder.',
        moderator: null,
      }),
    ]);
  });

  it('lets the reporter write without being asked first', async () => {
    const { caseCode } = await seedReport();
    const res = await reply(caseCode, 'One more detail: it happened again last night.');

    expect(res.status).toBe(201);
    expect(res.body.data.messages).toHaveLength(1);
    expect(res.body.data.awaitingYourReply).toBe(false);
  });

  it('records moderator messages in the audit log', async () => {
    const { id } = await seedReport();
    await ask(id, 'Could you tell us roughly when this started?');

    const entry = await AuditLog.findOne({ action: 'SEND_MESSAGE' }).lean();
    expect(entry.report.toString()).toBe(id);
  });
});

describe('privacy of the thread', () => {
  it('never exposes moderator identity on the reporter side', async () => {
    const { id, caseCode } = await seedReport();
    await ask(id, 'Is there anyone else who saw this happen?');
    const answered = await reply(caseCode, 'Not that I know of.');
    const tracked = await track(caseCode);

    for (const payload of [JSON.stringify(answered.body), JSON.stringify(tracked.body)]) {
      expect(payload).not.toContain('Ethics Desk');
      expect(payload).not.toMatch(/"moderator"/);
      expect(payload).not.toContain(id);
    }
  });

  it('stores reporter messages with a coarse time and no per-message id', async () => {
    const { caseCode } = await seedReport();
    const before = Date.now();
    await reply(caseCode, 'Adding context to my earlier report.');

    const stored = await Report.findOne().lean();
    const [message] = stored.messages;

    expect(Object.keys(message).sort()).toEqual(['body', 'createdAt', 'from', 'moderator']);
    expect(message.moderator).toBeNull();
    expect(message.createdAt.getTime() % (15 * 60 * 1000)).toBe(0);
    expect(before - message.createdAt.getTime()).toBeLessThan(15 * 60 * 1000);
    // updatedAt never gets more precise than the bucket because of a reply.
    expect(stored.updatedAt.getTime() % (15 * 60 * 1000)).toBe(0);
  });

  it('warns about identifying details in a reply without echoing them', async () => {
    const { caseCode } = await seedReport();
    const res = await reply(caseCode, 'You can reach me at sam.k@example.com if that helps.');

    expect(res.status).toBe(201);
    expect(res.body.data.warnings.map((w) => w.code)).toEqual([
      'POSSIBLE_EMAIL',
      'POSSIBLE_SELF_IDENTIFICATION',
    ]);
    expect(JSON.stringify(res.body.data.warnings)).not.toContain('sam.k@example.com');
  });

  it('forbids caching of the reply response', async () => {
    const { caseCode } = await seedReport();
    const res = await reply(caseCode, 'Following up.');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('closed cases', () => {
  async function seedClosed() {
    const seeded = await seedReport();
    await ask(seeded.id, 'Can you confirm the date?');
    await request(app)
      .patch(`/api/v1/moderator/reports/${seeded.id}/status`)
      .set('Authorization', authHeader)
      .send({ status: 'DISMISSED', message: 'Closing — duplicate of another case.' });
    return seeded;
  }

  it('rejects a reporter reply with 409', async () => {
    const { caseCode } = await seedClosed();
    const res = await reply(caseCode, 'Here is the date you asked for.');

    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe(
      'This case is closed (DISMISSED) and no longer accepts messages'
    );
  });

  it('rejects a moderator message with 409', async () => {
    const { id } = await seedClosed();
    const res = await ask(id, 'One more question.');
    expect(res.status).toBe(409);
  });

  it('clears awaitingReporter when the case is closed', async () => {
    const { id, caseCode } = await seedClosed();

    expect((await listAwaiting(true)).body.data).toEqual([]);
    expect((await track(caseCode)).body.data.awaitingYourReply).toBe(false);
    expect((await Report.findById(id).lean()).messages).toHaveLength(1);
  });
});

describe('thread size limit', () => {
  it(`stops accepting messages after ${MAX_MESSAGES_PER_REPORT}`, async () => {
    const { id, caseCode } = await seedReport();
    const filler = Array.from({ length: MAX_MESSAGES_PER_REPORT }, () => ({
      from: 'REPORTER',
      body: 'filler',
      moderator: null,
      createdAt: new Date(),
    }));
    await Report.collection.updateOne({ caseCodeHash: { $exists: true } }, { $set: { messages: filler } });

    const fromReporter = await reply(caseCode, 'One too many.');
    const fromModerator = await ask(id, 'One too many.');

    expect(fromReporter.status).toBe(409);
    expect(fromReporter.body.error.message).toMatch(/limit of 200 messages/);
    expect(fromModerator.status).toBe(409);
  });
});

describe('validation and errors', () => {
  it('returns 404 for an unknown case code', async () => {
    const res = await reply('WD-AAAAA-BBBBB-CCCCC', 'Hello?');
    expect(res.status).toBe(404);
  });

  it('returns 400 for a malformed case code', async () => {
    const res = await reply('abc', 'Hello?');
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe('params.caseCode');
  });

  it.each([
    ['an empty body', { body: '   ' }, 'body must not be empty'],
    ['a body over 1000 characters', { body: 'x'.repeat(1001) }, 'body must be at most 1000 characters'],
    ['a missing body', {}, 'body is required'],
  ])('rejects %s', async (_label, payload, message) => {
    const { caseCode } = await seedReport();
    const res = await request(app).post(`/api/v1/reports/${caseCode}/messages`).send(payload);

    expect(res.status).toBe(400);
    expect(res.body.error.details[0]).toEqual({ field: 'body.body', message });
  });

  it('rejects unknown fields (strictObject)', async () => {
    const { caseCode } = await seedReport();
    const res = await request(app)
      .post(`/api/v1/reports/${caseCode}/messages`)
      .send({ body: 'Hi', email: 'me@example.com' });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.error.details)).toMatch(/Unrecognized key/);
  });

  it('requires authentication for moderator messages', async () => {
    const { id } = await seedReport();
    const res = await request(app).post(`/api/v1/moderator/reports/${id}/messages`).send({ body: 'Hi' });
    expect(res.status).toBe(401);
  });

  it('returns 404 / 400 for unknown or malformed report ids', async () => {
    expect((await ask('64b7f1a2c3d4e5f6a7b8c9d0', 'Hello?')).status).toBe(404);
    expect((await ask('not-an-id', 'Hello?')).status).toBe(400);
  });

  it('validates the awaitingReporter filter', async () => {
    const res = await listAwaiting('maybe');
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].message).toBe('awaitingReporter must be true or false');
  });
});
