'use strict';

/**
 * Loads and validates environment configuration once, at startup.
 *
 * Failing fast here means the rest of the codebase can trust that, e.g.,
 * `env.jwtSecret` exists — no defensive `process.env.X || 'fallback'` checks
 * scattered around (a very common way for a weak default secret to reach
 * production).
 */

const path = require('path');
const { z } = require('zod');

require('dotenv').config({
  path: path.resolve(__dirname, '../../.env'),
  quiet: true,
});

const isTest = process.env.NODE_ENV === 'test';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  // The in-memory MongoDB used by the test suite supplies its own URI.
  MONGODB_URI: isTest
    ? z.string().default('mongodb://127.0.0.1:27017/whistledrop-test')
    : z.string().min(1, 'MONGODB_URI is required'),

  JWT_SECRET: isTest
    ? z.string().default('test-secret-not-used-in-production')
    : z.string().min(32, 'JWT_SECRET must be at least 32 characters long'),
  JWT_EXPIRES_IN: z.string().default('2h'),

  CORS_ORIGIN: z.string().default('*'),

  RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  REPORT_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  TRACK_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n${details}`);
  process.exit(1);
}

const raw = parsed.data;

const env = {
  nodeEnv: raw.NODE_ENV,
  isProduction: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  port: raw.PORT,
  mongoUri: raw.MONGODB_URI,
  jwt: {
    secret: raw.JWT_SECRET,
    expiresIn: raw.JWT_EXPIRES_IN,
  },
  corsOrigin: raw.CORS_ORIGIN === '*' ? '*' : raw.CORS_ORIGIN.split(',').map((o) => o.trim()),
  rateLimit: {
    windowMs: raw.RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
    max: raw.RATE_LIMIT_MAX,
    reportMax: raw.REPORT_RATE_LIMIT_MAX,
    authMax: raw.AUTH_RATE_LIMIT_MAX,
    trackMax: raw.TRACK_RATE_LIMIT_MAX,
  },
};

module.exports = env;
