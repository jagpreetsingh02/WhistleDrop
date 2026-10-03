'use strict';

/** Categories a reporter can file a report under. */
const CATEGORIES = Object.freeze(['SECURITY', 'HARASSMENT', 'CORRUPTION', 'TECHNICAL', 'OTHER']);

/** Lifecycle states of a report. */
const STATUSES = Object.freeze(['SUBMITTED', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED']);

const STATUS = Object.freeze({
  SUBMITTED: 'SUBMITTED',
  UNDER_REVIEW: 'UNDER_REVIEW',
  RESOLVED: 'RESOLVED',
  DISMISSED: 'DISMISSED',
});

/** Who may read a moderator update. INTERNAL notes never reach the reporter. */
const VISIBILITY = Object.freeze({
  PUBLIC: 'PUBLIC',
  INTERNAL: 'INTERNAL',
});

const VISIBILITIES = Object.freeze(Object.values(VISIBILITY));

/** Staff roles. Admins can do everything moderators can, plus manage accounts. */
const ROLE = Object.freeze({
  ADMIN: 'admin',
  MODERATOR: 'moderator',
});

const ROLES = Object.freeze(Object.values(ROLE));

/** Author side of a follow-up message. Never more specific than this for reporters. */
const MESSAGE_FROM = Object.freeze({
  REPORTER: 'REPORTER',
  MODERATOR: 'MODERATOR',
});

/** Actions recorded in the tamper-evident audit log. */
const AUDIT_ACTION = Object.freeze({
  LOGIN: 'LOGIN',
  VIEW_REPORT: 'VIEW_REPORT',
  UPDATE_STATUS: 'UPDATE_STATUS',
  ADD_UPDATE: 'ADD_UPDATE',
  SEND_MESSAGE: 'SEND_MESSAGE',
  ADMIN_CREATE_ACCOUNT: 'ADMIN_CREATE_ACCOUNT',
  ADMIN_DEACTIVATE_ACCOUNT: 'ADMIN_DEACTIVATE_ACCOUNT',
  ADMIN_ACTIVATE_ACCOUNT: 'ADMIN_ACTIVATE_ACCOUNT',
});

const AUDIT_ACTIONS = Object.freeze(Object.values(AUDIT_ACTION));

const CASE_CODE_PREFIX = 'WD';

/** Claims pinned on every moderator JWT, checked again on verification. */
const JWT_ISSUER = 'whistledrop-api';
const JWT_AUDIENCE = 'whistledrop-moderators';

module.exports = {
  CATEGORIES,
  STATUSES,
  STATUS,
  VISIBILITY,
  VISIBILITIES,
  ROLE,
  ROLES,
  MESSAGE_FROM,
  AUDIT_ACTION,
  AUDIT_ACTIONS,
  CASE_CODE_PREFIX,
  JWT_ISSUER,
  JWT_AUDIENCE,
};
