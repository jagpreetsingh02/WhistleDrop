'use strict';

/**
 * Wraps an async route handler so a rejected promise is forwarded to the
 * centralized error handler instead of hanging the request.
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = asyncHandler;
