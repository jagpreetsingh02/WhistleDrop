'use strict';

const AppError = require('../utils/AppError');

/**
 * Builds a middleware that validates parts of the request against zod schemas.
 *
 * Parsed values land on `req.validated` rather than overwriting `req.body` /
 * `req.query` (in Express 5 `req.query` is a getter and cannot be reassigned),
 * so controllers always read data that has been validated and coerced.
 *
 * @param {{ body?: import('zod').ZodTypeAny, query?: import('zod').ZodTypeAny, params?: import('zod').ZodTypeAny }} schemas
 */
function validate(schemas = {}) {
  return (req, _res, next) => {
    const validated = {};
    const errors = [];

    for (const source of ['body', 'query', 'params']) {
      const schema = schemas[source];
      if (!schema) continue;

      const result = schema.safeParse(req[source] ?? {});
      if (result.success) {
        validated[source] = result.data;
      } else {
        for (const issue of result.error.issues) {
          errors.push({
            field: [source, ...issue.path].join('.'),
            message: issue.message,
          });
        }
      }
    }

    if (errors.length > 0) {
      return next(AppError.badRequest('Validation failed', errors));
    }

    req.validated = validated;
    return next();
  };
}

module.exports = validate;
