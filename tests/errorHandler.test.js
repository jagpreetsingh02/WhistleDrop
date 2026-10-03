'use strict';

const mongoose = require('mongoose');
const { app, request, VALID_REPORT } = require('./setup/helpers');
const db = require('./setup/testDb');
const logger = require('../src/utils/logger');
const reportService = require('../src/services/report.service');
const errorHandler = require('../src/middleware/errorHandler');
const AppError = require('../src/utils/AppError');

/** Minimal Express response double that records what the handler sent. */
function run(error) {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  errorHandler(error, { method: 'GET', baseUrl: '', route: { path: '/x' } }, res, () => {});
  return res;
}

describe('centralized error handler — status code mapping', () => {
  it('keeps the status and details of an AppError', () => {
    const res = run(AppError.unprocessable('Nope', { why: 'workflow' }));
    expect(res.statusCode).toBe(422);
    expect(res.body).toEqual({
      success: false,
      error: { message: 'Nope', details: { why: 'workflow' } },
    });
  });

  it('maps a Mongoose validation error to 400 with field details', () => {
    const error = new mongoose.Error.ValidationError();
    error.addError(
      'description',
      new mongoose.Error.ValidatorError({ path: 'description', message: 'too long' })
    );

    const res = run(error);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.details).toEqual([{ field: 'description', message: 'too long' }]);
  });

  it('maps a Mongoose cast error to 400', () => {
    const res = run(new mongoose.Error.CastError('ObjectId', 'nope', '_id'));
    expect(res.statusCode).toBe(400);
    expect(res.body.error.message).toBe('Invalid value for _id');
  });

  it('maps a duplicate-key error to 409', () => {
    const res = run(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));
    expect(res.statusCode).toBe(409);
    expect(res.body.error.message).toBe('Resource already exists');
  });

  it.each(['JsonWebTokenError', 'TokenExpiredError'])('maps %s to 401', (name) => {
    const res = run(Object.assign(new Error('jwt'), { name }));
    expect(res.statusCode).toBe(401);
  });

  it('turns an unexpected error into a generic 500 with no stack trace', () => {
    const res = run(new Error('connection refused by db-host-7'));

    expect(res.statusCode).toBe(500);
    expect(res.body.error.message).toBe('Something went wrong. Please try again later.');
    expect(JSON.stringify(res.body)).not.toMatch(/stack|at .*\.js:\d+/);
    // Outside production, the original message is included to help developers.
    expect(res.body.error.debug).toBe('connection refused by db-host-7');
  });

  it('omits the debug message entirely in production', () => {
    let productionHandler;
    const saved = { ...process.env };
    jest.isolateModules(() => {
      Object.assign(process.env, {
        NODE_ENV: 'production',
        MONGODB_URI: 'mongodb://127.0.0.1:27017/unused',
        JWT_SECRET: 'p'.repeat(40),
      });
      productionHandler = require('../src/middleware/errorHandler');
    });
    process.env = saved;

    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    productionHandler(
      new Error('connection refused by db-host-7'),
      { method: 'GET', path: '/x' },
      res
    );

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: { message: 'Something went wrong. Please try again later.' },
    });
  });
});

describe('error handling over HTTP', () => {
  it('rejects a body over 100 KB with 413', async () => {
    const res = await request(app)
      .post('/api/v1/reports')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ category: 'OTHER', description: 'x'.repeat(110 * 1024) }));

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ success: false, error: { message: 'Request body is too large' } });
  });
});

describe('error logging never contains a case code', () => {
  beforeAll(db.connect);
  afterAll(db.close);
  afterEach(() => jest.restoreAllMocks());

  it('logs the route pattern, not the URL, when a reporter route fails', async () => {
    const submitted = await request(app).post('/api/v1/reports').send(VALID_REPORT);
    const { caseCode } = submitted.body.data;

    const logged = jest.spyOn(logger, 'error').mockImplementation(() => {});
    jest
      .spyOn(reportService, 'getReportByCaseCode')
      .mockRejectedValueOnce(new Error('db exploded'));

    const res = await request(app).get(`/api/v1/reports/${caseCode}`);
    const output = JSON.stringify(logged.mock.calls, (_key, value) =>
      value instanceof Error ? value.message : value
    );

    expect(res.status).toBe(500);
    expect(logged).toHaveBeenCalled();
    expect(output).toContain('GET /api/v1/reports/:caseCode');
    expect(output).not.toContain(caseCode);
    expect(output).not.toContain(caseCode.replace(/-/g, ''));
  });

  it('does the same for the reporter reply route', async () => {
    const submitted = await request(app).post('/api/v1/reports').send(VALID_REPORT);
    const { caseCode } = submitted.body.data;

    const logged = jest.spyOn(logger, 'error').mockImplementation(() => {});
    jest.spyOn(reportService, 'addReporterMessage').mockRejectedValueOnce(new Error('db exploded'));

    await request(app).post(`/api/v1/reports/${caseCode}/messages`).send({ body: 'Hello' });

    expect(JSON.stringify(logged.mock.calls)).toContain('POST /api/v1/reports/:caseCode/messages');
    expect(JSON.stringify(logged.mock.calls)).not.toContain(caseCode);
  });
});
