'use strict';

const crypto = require('crypto');
const AuditLog = require('../models/AuditLog');
const AppError = require('../utils/AppError');

/** prevHash of the very first entry. */
const GENESIS_HASH = '0'.repeat(64);

/**
 * Appends race with each other: two writers can read the same "last entry".
 * The unique `seq` index lets only one of them win; the other re-reads the
 * new head and tries again, so the chain never forks.
 */
const MAX_APPEND_ATTEMPTS = 20;

const idOrNull = (value) => (value ? value.toString() : null);

/**
 * SHA-256 over the previous hash and this entry's content. JSON.stringify of
 * a fixed-order array is the canonical form: unambiguous (no delimiter that
 * could appear inside a field) and stable across runs.
 */
function computeHash({ prevHash, seq, moderator, action, report, targetModerator, createdAt }) {
  const canonical = JSON.stringify([
    prevHash,
    seq,
    idOrNull(moderator),
    action,
    idOrNull(report),
    idOrNull(targetModerator),
    new Date(createdAt).toISOString(),
  ]);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Records a staff action. Only ids and the action name are stored — never
 * report text, case codes or network identifiers.
 */
async function record({ moderatorId, action, reportId = null, targetModeratorId = null }) {
  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const head = await AuditLog.findOne().sort({ seq: -1 }).select('seq hash').lean();

    const entry = {
      seq: head ? head.seq + 1 : 1,
      prevHash: head ? head.hash : GENESIS_HASH,
      moderator: moderatorId,
      action,
      report: reportId,
      targetModerator: targetModeratorId,
      createdAt: new Date(),
    };
    entry.hash = computeHash(entry);

    try {
      // eslint-disable-next-line no-await-in-loop
      return await AuditLog.create(entry);
    } catch (error) {
      if (error.code === 11000) continue;
      throw error;
    }
  }

  throw new AppError(503, 'The audit log is busy. Please retry the request.');
}

/**
 * Walks the whole chain in order and reports the first break, if any.
 *
 *  - MISSING_ENTRY:           a seq is absent (an entry was deleted)
 *  - PREVIOUS_HASH_MISMATCH:  an entry no longer points at its predecessor
 *                             (something before it was altered and re-hashed)
 *  - CONTENT_HASH_MISMATCH:   an entry's fields no longer match its own hash
 *
 * The head hash is returned so it can be recorded outside the database:
 * comparing it later is the only way to notice the newest entries being cut
 * off, which an internal chain cannot detect on its own.
 */
async function verifyChain() {
  let expectedSeq = 1;
  let expectedPrevHash = GENESIS_HASH;
  let checkedEntries = 0;

  const cursor = AuditLog.find().sort({ seq: 1 }).lean().cursor();

  // eslint-disable-next-line no-restricted-syntax
  for await (const entry of cursor) {
    let reason = null;
    if (entry.seq !== expectedSeq) reason = 'MISSING_ENTRY';
    else if (entry.prevHash !== expectedPrevHash) reason = 'PREVIOUS_HASH_MISMATCH';
    else if (computeHash(entry) !== entry.hash) reason = 'CONTENT_HASH_MISMATCH';

    if (reason) {
      await cursor.close();
      return {
        intact: false,
        checkedEntries,
        brokenAtSeq: reason === 'MISSING_ENTRY' ? expectedSeq : entry.seq,
        reason,
      };
    }

    checkedEntries += 1;
    expectedSeq += 1;
    expectedPrevHash = entry.hash;
  }

  return {
    intact: true,
    checkedEntries,
    headSeq: checkedEntries,
    headHash: expectedPrevHash,
  };
}

async function listEntries({ page = 1, limit = 50 } = {}) {
  const [entries, total] = await Promise.all([
    AuditLog.find()
      .sort({ seq: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('moderator', 'username displayName'),
    AuditLog.countDocuments(),
  ]);

  return {
    entries,
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}

function toAuditView(entry) {
  const { moderator } = entry;
  return {
    seq: entry.seq,
    action: entry.action,
    moderator:
      moderator && moderator.username
        ? { id: moderator._id.toString(), username: moderator.username, displayName: moderator.displayName }
        : { id: idOrNull(moderator) },
    reportId: idOrNull(entry.report),
    targetModeratorId: idOrNull(entry.targetModerator),
    createdAt: entry.createdAt,
    prevHash: entry.prevHash,
    hash: entry.hash,
  };
}

module.exports = { GENESIS_HASH, computeHash, record, verifyChain, listEntries, toAuditView };
