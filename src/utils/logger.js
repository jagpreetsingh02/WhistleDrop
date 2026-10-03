'use strict';

/**
 * Deliberately minimal logger.
 *
 * WhistleDrop does not use an HTTP request logger (morgan and friends), because
 * access logs are exactly where reporter-identifying data — IP addresses,
 * user-agents, referrers — normally ends up. We log lifecycle and error events
 * only, and never log request bodies.
 */

const isTest = process.env.NODE_ENV === 'test';

/* eslint-disable no-console */
const logger = {
  info: (...args) => {
    if (!isTest) console.log('[info]', ...args);
  },
  warn: (...args) => {
    if (!isTest) console.warn('[warn]', ...args);
  },
  error: (...args) => {
    if (!isTest) console.error('[error]', ...args);
  },
};
/* eslint-enable no-console */

module.exports = logger;
