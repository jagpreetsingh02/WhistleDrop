'use strict';

/** Categories a reporter can file a report under. */
const CATEGORIES = Object.freeze([
  'SECURITY',
  'HARASSMENT',
  'CORRUPTION',
  'TECHNICAL',
  'OTHER',
]);

/** Lifecycle states of a report. */
const STATUSES = Object.freeze([
  'SUBMITTED',
  'UNDER_REVIEW',
  'RESOLVED',
  'DISMISSED',
]);

const STATUS = Object.freeze({
  SUBMITTED: 'SUBMITTED',
  UNDER_REVIEW: 'UNDER_REVIEW',
  RESOLVED: 'RESOLVED',
  DISMISSED: 'DISMISSED',
});

const CASE_CODE_PREFIX = 'WD';

/** Claims pinned on every moderator JWT, checked again on verification. */
const JWT_ISSUER = 'whistledrop-api';
const JWT_AUDIENCE = 'whistledrop-moderators';

module.exports = {
  CATEGORIES,
  STATUSES,
  STATUS,
  CASE_CODE_PREFIX,
  JWT_ISSUER,
  JWT_AUDIENCE,
};
