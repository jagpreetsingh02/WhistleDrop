'use strict';

const mongoose = require('mongoose');
const env = require('../config/env');
const { CATEGORIES, STATUSES, STATUS, VISIBILITIES, VISIBILITY } = require('../utils/constants');

/**
 * A moderator note attached to a report.
 *
 * PUBLIC messages are written for the reporter, so moderators are told (in the
 * API docs) to keep them free of identifying detail. INTERNAL notes are for
 * moderators only and are filtered out of the reporter view. `moderator` is
 * stored for internal accountability and is never returned on the public
 * tracking route.
 */
const statusUpdateSchema = new mongoose.Schema(
  {
    message: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },
    // Status the report moved to with this update (null = note only).
    status: {
      type: String,
      enum: [...STATUSES, null],
      default: null,
    },
    visibility: {
      type: String,
      enum: VISIBILITIES,
      default: VISIBILITY.PUBLIC,
    },
    moderator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Moderator',
      required: true,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false }, _id: true }
);

/**
 * A report.
 *
 * Note what is NOT here: no reporter id, no email, no IP address, no
 * user-agent, no session. Mongoose runs in strict mode, so if a client posts
 * extra fields such as `email` they are silently dropped rather than stored —
 * the schema itself is the privacy guarantee.
 */
const reportSchema = new mongoose.Schema(
  {
    // SHA-256 of the case code. The plaintext code exists only in the
    // submission response and in the reporter's hands.
    caseCodeHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
      select: false,
    },
    category: {
      type: String,
      required: true,
      enum: CATEGORIES,
      index: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
      minlength: 20,
      maxlength: 5000,
    },
    // Optional link to externally hosted evidence. We store a URL, never a file
    // upload, so no document metadata (author, device, GPS) reaches our disk.
    evidenceUrl: {
      type: String,
      trim: true,
      default: null,
    },
    status: {
      type: String,
      required: true,
      enum: STATUSES,
      default: STATUS.SUBMITTED,
      index: true,
    },
    updates: {
      type: [statusUpdateSchema],
      default: [],
    },
    // Set in the same atomic write that moves the report to RESOLVED or
    // DISMISSED. Drives the retention TTL index below.
    closedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    strict: true,
    minimize: false,
  }
);

// Common moderator query: "open SECURITY cases, newest first".
reportSchema.index({ status: 1, category: 1, createdAt: -1 });
reportSchema.index({ updatedAt: -1 });

// Full-text search over descriptions for the moderator `q` filter. A text
// index (rather than a RegExp built from user input) gives stemming —
// "credential" matches "credentials" — and cannot be turned into a ReDoS.
reportSchema.index({ description: 'text' }, { name: 'description_text' });

/**
 * Retention: MongoDB deletes a report automatically once it has been closed
 * for RETENTION_DAYS_AFTER_CLOSE days. Data that no longer exists cannot leak,
 * be subpoenaed or be cross-referenced. Open reports have closedAt = null and
 * are never touched (TTL indexes ignore non-date values). The TTL monitor runs
 * about once a minute, so deletion is "shortly after", not to the second.
 */
const { retentionDaysAfterClose } = env.privacy;
if (retentionDaysAfterClose > 0) {
  reportSchema.index(
    { closedAt: 1 },
    { name: 'closedAt_retention_ttl', expireAfterSeconds: retentionDaysAfterClose * 24 * 60 * 60 }
  );
}

module.exports = mongoose.model('Report', reportSchema);
