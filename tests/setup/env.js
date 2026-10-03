'use strict';

/**
 * Test environment defaults.
 *
 * Rate limits are raised well above what any functional test needs, so a
 * limiter never causes a spurious failure. The rate-limit test file lowers
 * them again for itself before importing the app.
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-value-at-least-32-characters-long';
process.env.JWT_EXPIRES_IN = '1h';
process.env.RATE_LIMIT_MAX = process.env.RATE_LIMIT_MAX || '10000';
process.env.REPORT_RATE_LIMIT_MAX = process.env.REPORT_RATE_LIMIT_MAX || '10000';
process.env.AUTH_RATE_LIMIT_MAX = process.env.AUTH_RATE_LIMIT_MAX || '10000';
process.env.TRACK_RATE_LIMIT_MAX = process.env.TRACK_RATE_LIMIT_MAX || '10000';
