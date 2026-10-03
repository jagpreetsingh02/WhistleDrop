'use strict';

/**
 * Wraps an async route handler so a rejected promise is forwarded to the
 * centralized error handler instead of hanging the request.
 *
 * It also records the matched route PATTERN (e.g. /api/v1/reports/:caseCode)
 * while `req.baseUrl` is still set — Express resets it once an error leaves
 * the router — so error logs can name the route without containing the URL,
 * which on reporter routes holds the plaintext case code.
 */
const asyncHandler = (fn) => (req, res, next) => {
  if (req.route) req.routePattern = `${req.baseUrl}${req.route.path}`;
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = asyncHandler;
