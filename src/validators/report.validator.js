'use strict';

const { z } = require('zod');
const { CATEGORIES, STATUSES, VISIBILITIES, VISIBILITY } = require('../utils/constants');

/** Accepts "Security", " security " or "SECURITY" and normalises to the enum. */
const categoryField = z
  .string({ message: 'category is required' })
  .trim()
  .toUpperCase()
  .pipe(z.enum(CATEGORIES, { message: `category must be one of: ${CATEGORIES.join(', ')}` }));

const statusField = z
  .string({ message: 'status is required' })
  .trim()
  .toUpperCase()
  .pipe(z.enum(STATUSES, { message: `status must be one of: ${STATUSES.join(', ')}` }));

/**
 * Optional evidence link. Only http(s) is accepted — allowing `javascript:` or
 * `data:` URLs would hand any future UI a stored-XSS vector. An empty string is
 * treated as "not provided".
 */
const evidenceUrlField = z
  .union([
    z.literal(''),
    z.null(),
    z
      .url({ protocol: /^https?$/, message: 'evidenceUrl must be a valid http(s) URL' })
      .max(2048, 'evidenceUrl must be at most 2048 characters'),
  ])
  .optional()
  .transform((value) => (value ? value : null));

/**
 * Submission payload. `strictObject` rejects unknown keys outright: a client
 * cannot smuggle an `email` or `reporterName` field into the request and hope
 * it gets persisted. It is both a privacy control and a typo catcher.
 */
const submitReportSchema = z.strictObject({
  category: categoryField,
  description: z
    .string({ message: 'description is required' })
    .trim()
    .min(20, 'description must be at least 20 characters')
    .max(5000, 'description must be at most 5000 characters'),
  evidenceUrl: evidenceUrlField,
});

const trackReportParamsSchema = z.object({
  caseCode: z
    .string({ message: 'caseCode is required' })
    .trim()
    .min(8, 'caseCode is not a valid case code')
    .max(64, 'caseCode is not a valid case code'),
});

const listReportsQuerySchema = z.object({
  status: statusField.optional(),
  category: categoryField.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(['newest', 'oldest']).default('newest'),
});

const reportIdParamsSchema = z.object({
  id: z.string().trim().regex(/^[a-f\d]{24}$/i, 'id must be a valid report id'),
});

const updateStatusSchema = z.strictObject({
  status: statusField,
  message: z
    .string()
    .trim()
    .min(5, 'message must be at least 5 characters')
    .max(500, 'message must be at most 500 characters')
    .optional(),
});

const addUpdateSchema = z.strictObject({
  message: z
    .string({ message: 'message is required' })
    .trim()
    .min(5, 'message must be at least 5 characters')
    .max(500, 'message must be at most 500 characters'),
  visibility: z
    .string()
    .trim()
    .toUpperCase()
    .pipe(
      z.enum(VISIBILITIES, { message: `visibility must be one of: ${VISIBILITIES.join(', ')}` })
    )
    .default(VISIBILITY.PUBLIC),
});

module.exports = {
  submitReportSchema,
  trackReportParamsSchema,
  listReportsQuerySchema,
  reportIdParamsSchema,
  updateStatusSchema,
  addUpdateSchema,
};
