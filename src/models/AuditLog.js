'use strict';

const mongoose = require('mongoose');
const { AUDIT_ACTIONS } = require('../utils/constants');

/**
 * One entry in the staff audit trail.
 *
 * Records WHO (a staff account) did WHAT to WHICH object, and when — nothing
 * else. Deliberately absent: report contents, case codes, IP addresses,
 * user-agents. The audit log watches moderators; it must not become a second
 * copy of the reports or a new source of identifying data.
 *
 * Entries form a hash chain: `hash` = SHA-256 over `prevHash` plus this
 * entry's own fields, and `seq` is gap-free. Editing, deleting or reordering
 * any entry breaks the chain from that point on (see audit.service.verify).
 */
const auditLogSchema = new mongoose.Schema(
  {
    seq: { type: Number, required: true, unique: true, min: 1 },
    moderator: { type: mongoose.Schema.Types.ObjectId, ref: 'Moderator', required: true },
    action: { type: String, required: true, enum: AUDIT_ACTIONS },
    report: { type: mongoose.Schema.Types.ObjectId, ref: 'Report', default: null },
    targetModerator: { type: mongoose.Schema.Types.ObjectId, ref: 'Moderator', default: null },
    // Set explicitly (not via `timestamps`) because it is part of the hash and
    // must be known before the document is written.
    createdAt: { type: Date, required: true },
    prevHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    hash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  },
  { versionKey: false, strict: true }
);

module.exports = mongoose.model('AuditLog', auditLogSchema);
