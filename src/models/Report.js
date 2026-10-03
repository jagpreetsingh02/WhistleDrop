'use strict';

const mongoose = require('mongoose');
const { CATEGORIES, STATUSES, STATUS } = require('../utils/constants');

/**
 * A moderator note attached to a report.
 *
 * `message` is written for the reporter, so moderators are told (in the API
 * docs) to keep it free of identifying detail. `moderator` is stored for
 * internal accountability and is never returned on the public tracking route.
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
  },
  {
    timestamps: true,
    strict: true,
    minimize: false,
  }
);

// Common moderator query: "open SECURITY cases, newest first".
reportSchema.index({ status: 1, category: 1, createdAt: -1 });

module.exports = mongoose.model('Report', reportSchema);
