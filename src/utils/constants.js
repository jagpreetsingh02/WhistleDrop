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

/** Who may read a moderator update. INTERNAL notes never reach the reporter. */
const VISIBILITY = Object.freeze({
  PUBLIC: 'PUBLIC',
  INTERNAL: 'INTERNAL',
});

const VISIBILITIES = Object.freeze(Object.values(VISIBILITY));

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
  CASE_CODE_PREFIX,
  JWT_ISSUER,
  JWT_AUDIENCE,
};
