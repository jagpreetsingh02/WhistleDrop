'use strict';

const AppError = require('../utils/AppError');

/** Turns unmatched routes into a normal 404 that the error handler formats. */
function notFound(req, _res, next) {
  next(AppError.notFound(`Route ${req.method} ${req.originalUrl} does not exist`));
}

module.exports = notFound;
