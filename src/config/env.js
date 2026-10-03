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

/**
 * Express `trust proxy` accepts a hop count, a boolean or a list of subnets.
 * "0"/"false" map to `false` (not the number 0) on purpose: express-rate-limit
 * only warns about a stray X-Forwarded-For header when the setting is exactly
 * `false`, and that warning is how a forgotten TRUST_PROXY shows up in logs.
 */
function parseTrustProxy(value) {
  const normalized = String(value).trim().toLowerCase();
  if (normalized === '' || normalized === '0' || normalized === 'false') return false;
  if (normalized === 'true') return true;
  if (/^\d+$/.test(normalized)) return Number(normalized);
  return value.trim();
}

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
  // bcrypt work factor for staff passwords. 4 is bcrypt's minimum (tests only).
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),

  CORS_ORIGIN: z.string().default('*'),
  TRUST_PROXY: z.string().default('0'),

  // Reporter-originated timestamps are rounded down to this many minutes.
  TIMESTAMP_BUCKET_MINUTES: z.coerce.number().int().min(0).max(1440).default(15),
  // Closed reports are deleted this many days after closing. 0 keeps them forever.
  RETENTION_DAYS_AFTER_CLOSE: z.coerce.number().int().min(0).max(36500).default(365),

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
  bcryptRounds: raw.BCRYPT_ROUNDS,
  trustProxy: parseTrustProxy(raw.TRUST_PROXY),
  privacy: {
    timestampBucketMinutes: raw.TIMESTAMP_BUCKET_MINUTES,
    retentionDaysAfterClose: raw.RETENTION_DAYS_AFTER_CLOSE,
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
module.exports.parseTrustProxy = parseTrustProxy;
