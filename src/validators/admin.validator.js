'use strict';

const { z } = require('zod');
const { ROLES, ROLE } = require('../utils/constants');

const createStaffSchema = z.strictObject({
  username: z
    .string({ message: 'username is required' })
    .trim()
    .toLowerCase()
    .min(3, 'username must be at least 3 characters')
    .max(40, 'username must be at most 40 characters')
    .regex(
      /^[a-z0-9._-]+$/,
      'username may only contain letters, digits, dots, dashes and underscores'
    ),
  // Longer than the login minimum: these accounts can read every report.
  password: z
    .string({ message: 'password is required' })
    .min(12, 'password must be at least 12 characters')
    .max(128, 'password must be at most 128 characters'),
  displayName: z.string().trim().min(1).max(80).optional(),
  role: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.enum(ROLES, { message: `role must be one of: ${ROLES.join(', ')}` }))
    .default(ROLE.MODERATOR),
});

const listStaffQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const staffIdParamsSchema = z.object({
  id: z
    .string()
    .trim()
    .regex(/^[a-f\d]{24}$/i, 'id must be a valid moderator id'),
});

const listAuditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

module.exports = {
  createStaffSchema,
  listStaffQuerySchema,
  staffIdParamsSchema,
  listAuditQuerySchema,
};
