'use strict';

/**
 * Forbids any cache — browser, corporate proxy, CDN — from keeping a copy of
 * the response.
 *
 * A cached tracking page is a privacy leak: it sits on a shared machine or in
 * a proxy's disk long after the reporter has left, revealing that this person
 * looked up a whistleblowing case and what its status was. The submission
 * response is worse still, since it carries the plaintext case code.
 * `Pragma` covers old HTTP/1.0 intermediaries that ignore Cache-Control.
 */
function noStore(_req, res, next) {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  next();
}

module.exports = noStore;
