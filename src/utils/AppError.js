'use strict';

/**
 * Error type for failures we expect and want to surface to the client with a
 * specific HTTP status code. Anything that is NOT an AppError is treated as an
 * unexpected bug by the error handler and reported as a generic 500, so we
 * never leak internals (stack traces, driver messages) to callers.
 */
class AppError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.isOperational = true;
    if (details) this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message = 'Bad request', details) {
    return new AppError(400, message, details);
  }

  static unauthorized(message = 'Authentication required') {
    return new AppError(401, message);
  }

  static forbidden(message = 'You do not have permission to perform this action') {
    return new AppError(403, message);
  }

  static notFound(message = 'Resource not found') {
    return new AppError(404, message);
  }

  static conflict(message = 'Conflicting request', details) {
    return new AppError(409, message, details);
  }

  static unprocessable(message = 'Request could not be processed', details) {
    return new AppError(422, message, details);
  }
}

module.exports = AppError;
