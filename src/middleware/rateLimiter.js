'use strict';

const rateLimit = require('express-rate-limit');
const env = require('../config/env');
const AppError = require('../utils/AppError');

/**
 * Rate limiting.
 *
 * express-rate-limit keys buckets by IP address. That IP lives in memory for
 * the length of the window only — it is never written to the database, to a
 * log line, or to a report document. This is the one place the system touches
 * a network identifier, and it is a deliberate trade: without it, the tracking
 * endpoint could be brute-forced and the submission endpoint flooded.
 */
function createLimiter({ limit, windowMs = env.rateLimit.windowMs, message }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // Route 429s through the centralized error handler so every error
    // response in the API has the same shape.
    handler: (_req, _res, next) => next(new AppError(429, message)),
  });
}

/** Baseline limiter applied to every API route. */
const globalLimiter = createLimiter({
  limit: env.rateLimit.max,
  message: 'Too many requests. Please slow down and try again later.',
});

/** Submitting reports is expensive and abusable; keep it tight. */
const submitReportLimiter = createLimiter({
  limit: env.rateLimit.reportMax,
  message: 'Too many reports submitted from this network. Please try again later.',
});

/** Slows down password guessing against moderator accounts. */
const loginLimiter = createLimiter({
  limit: env.rateLimit.authMax,
  message: 'Too many login attempts. Please try again later.',
});

/** Makes guessing case codes impractical on top of their ~73 bits of entropy. */
const trackLimiter = createLimiter({
  limit: env.rateLimit.trackMax,
  message: 'Too many case lookups. Please try again later.',
});

/** Reporter replies: enough for a conversation, too few to flood a thread. */
const reporterMessageLimiter = createLimiter({
  limit: env.rateLimit.reporterMessageMax,
  message: 'Too many messages sent. Please wait before replying again.',
});

module.exports = {
  createLimiter,
  globalLimiter,
  submitReportLimiter,
  loginLimiter,
  trackLimiter,
  reporterMessageLimiter,
};
