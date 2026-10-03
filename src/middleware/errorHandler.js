'use strict';

const mongoose = require('mongoose');
const env = require('../config/env');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');

/**
 * Translates a thrown error into an HTTP response.
 *
 * Rules:
 *  - Errors we raised on purpose (AppError) keep their status and message.
 *  - Known library errors are mapped to sensible 4xx codes.
 *  - Anything else is a bug: log it server-side, return a generic 500. The
 *    client never sees a stack trace, a Mongo error string or a file path,
 *    because those leak implementation detail to an attacker.
 *
 * Errors are logged without request bodies or headers — a report's contents
 * must not end up in a log file.
 */
function normalize(error) {
  if (error instanceof AppError) return error;

  if (error instanceof mongoose.Error.ValidationError) {
    const details = Object.values(error.errors).map((e) => ({
      field: e.path,
      message: e.message,
    }));
    return AppError.badRequest('Validation failed', details);
  }

  if (error instanceof mongoose.Error.CastError) {
    return AppError.badRequest(`Invalid value for ${error.path}`);
  }

  if (error.code === 11000) {
    return AppError.conflict('Resource already exists');
  }

  if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
    return AppError.unauthorized('Invalid authentication token');
  }

  // express.json() throws this for malformed JSON bodies.
  if (error.type === 'entity.parse.failed' || (error instanceof SyntaxError && 'body' in error)) {
    return AppError.badRequest('Request body is not valid JSON');
  }

  if (error.type === 'entity.too.large') {
    return new AppError(413, 'Request body is too large');
  }

  return null;
}

// eslint-disable-next-line no-unused-vars
function errorHandler(error, req, res, _next) {
  const appError = normalize(error);

  if (!appError) {
    logger.error(`Unhandled error on ${req.method} ${req.path}:`, error);
    return res.status(500).json({
      success: false,
      error: {
        message: 'Something went wrong. Please try again later.',
        ...(env.isProduction ? {} : { debug: error.message }),
      },
    });
  }

  if (appError.statusCode >= 500) {
    logger.error(`Server error on ${req.method} ${req.path}:`, appError.message);
  }

  return res.status(appError.statusCode).json({
    success: false,
    error: {
      message: appError.message,
      ...(appError.details ? { details: appError.details } : {}),
    },
  });
}

module.exports = errorHandler;
