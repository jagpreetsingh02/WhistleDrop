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

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_OR_DATETIME =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const isoDateField = (name) =>
  z
    .string()
    .trim()
    .refine(
      (value) => ISO_DATE_OR_DATETIME.test(value) && !Number.isNaN(Date.parse(value)),
      `${name} must be an ISO 8601 date or date-time, e.g. 2026-09-21`
    );

/** "true" / "false" query strings. z.coerce.boolean() would turn "false" into true. */
const booleanQueryField = (name) =>
  z
    .enum(['true', 'false'], { message: `${name} must be true or false` })
    .transform((value) => value === 'true');

/**
 * Moderator list filters.
 *
 * Date range semantics: `from` is inclusive; `to` is inclusive of the whole
 * day when given as a plain date (`to=2026-09-21` includes reports from that
 * day), which is what a person filling in a date picker expects. Both are
 * normalised into a half-open range [from, toExclusive) for the query.
 */
const listReportsQuerySchema = z
  .object({
    status: statusField.optional(),
    category: categoryField.optional(),
    q: z
      .string()
      .trim()
      .min(2, 'q must be at least 2 characters')
      .max(100, 'q must be at most 100 characters')
      .optional(),
    from: isoDateField('from')
      .transform((value) => new Date(value))
      .optional(),
    to: isoDateField('to')
      .transform((value) =>
        DATE_ONLY.test(value)
          ? new Date(Date.parse(value) + DAY_MS)
          : new Date(Date.parse(value) + 1)
      )
      .optional(),
    hasEvidence: booleanQueryField('hasEvidence').optional(),
    awaitingReporter: booleanQueryField('awaitingReporter').optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    sort: z
      .enum(['newest', 'oldest', 'recentlyUpdated'], {
        message: 'sort must be one of: newest, oldest, recentlyUpdated',
      })
      .default('newest'),
  })
  .superRefine((query, ctx) => {
    if (query.from && query.to && query.from >= query.to) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'to must not be earlier than from' });
    }
  })
  .transform(({ to, ...rest }) => ({ ...rest, toExclusive: to }));

const reportIdParamsSchema = z.object({
  id: z
    .string()
    .trim()
    .regex(/^[a-f\d]{24}$/i, 'id must be a valid report id'),
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

/** Follow-up message, from either side of the conversation. */
const messageSchema = z.strictObject({
  body: z
    .string({ message: 'body is required' })
    .trim()
    .min(1, 'body must not be empty')
    .max(1000, 'body must be at most 1000 characters'),
});

module.exports = {
  submitReportSchema,
  trackReportParamsSchema,
  listReportsQuerySchema,
  reportIdParamsSchema,
  updateStatusSchema,
  addUpdateSchema,
  messageSchema,
};
