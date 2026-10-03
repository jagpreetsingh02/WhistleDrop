'use strict';

const env = require('../config/env');
const Report = require('../models/Report');
const AppError = require('../utils/AppError');
const { generateCaseCode, hashCaseCode } = require('../utils/caseCode');
const { coarsenDate, coarseObjectId } = require('../utils/timeBuckets');
const { scanForPii } = require('../utils/piiScanner');
const { getAllowedTransitions, isValidTransition, isTerminal } = require('../utils/statusWorkflow');
const auditService = require('./audit.service');
const { STATUS, STATUSES, VISIBILITY, AUDIT_ACTION, MESSAGE_FROM } = require('../utils/constants');

const MAX_CASE_CODE_ATTEMPTS = 5;
const PREVIEW_LENGTH = 140;
const OPEN_STATUSES = STATUSES.filter((status) => !isTerminal(status));

/**
 * Messages are embedded in the report, so the thread is capped to keep the
 * document bounded (MongoDB's 16 MB limit, and the "embed only what stays
 * small" rule). 200 messages is far beyond any real clarification exchange.
 */
const MAX_MESSAGES_PER_REPORT = 200;

const MODERATOR_REFS = [
  { path: 'updates.moderator', select: 'displayName' },
  { path: 'messages.moderator', select: 'displayName' },
];

/* ---------------------------------------------------------------------------
 * Presenters
 *
 * Two audiences, two shapes. Keeping the mapping explicit (rather than
 * returning raw documents) is what guarantees that internal fields —
 * caseCodeHash, the moderator behind an update — can never slip into a
 * response by accident.
 * ------------------------------------------------------------------------- */

const isPublic = (update) => update.visibility !== VISIBILITY.INTERNAL;

/**
 * Latest moment the reporter could have seen something change. Deliberately
 * NOT the document's updatedAt: that also moves when an INTERNAL note is
 * added, which would tell the reporter that moderators discussed the case
 * privately.
 */
function latestPublicActivity(report, publicUpdates) {
  return [...publicUpdates, ...(report.messages || [])].reduce(
    (latest, item) => (item.createdAt > latest ? item.createdAt : latest),
    report.createdAt
  );
}

/** What the anonymous reporter sees when tracking a case. */
function toReporterView(report) {
  const publicUpdates = report.updates.filter(isPublic);

  return {
    category: report.category,
    status: report.status,
    submittedAt: report.createdAt,
    lastUpdatedAt: latestPublicActivity(report, publicUpdates),
    isClosed: isTerminal(report.status),
    awaitingYourReply: Boolean(report.awaitingReporter),
    updates: publicUpdates.map((update) => ({
      message: update.message,
      status: update.status,
      createdAt: update.createdAt,
    })),
    // "from" says which side wrote it — never which moderator.
    messages: (report.messages || []).map((message) => ({
      from: message.from,
      body: message.body,
      createdAt: message.createdAt,
    })),
  };
}

/** What an authenticated moderator sees for a single case. */
function toModeratorView(report) {
  return {
    id: report._id.toString(),
    category: report.category,
    description: report.description,
    evidenceUrl: report.evidenceUrl,
    status: report.status,
    allowedTransitions: getAllowedTransitions(report.status),
    submittedAt: report.createdAt,
    lastUpdatedAt: report.updatedAt,
    closedAt: report.closedAt || null,
    awaitingReporter: Boolean(report.awaitingReporter),
    messages: (report.messages || []).map((message) => ({
      from: message.from,
      body: message.body,
      createdAt: message.createdAt,
      moderator:
        message.from === MESSAGE_FROM.MODERATOR ? formatModerator(message.moderator) : null,
    })),
    updates: report.updates.map((update) => ({
      id: update._id.toString(),
      message: update.message,
      status: update.status,
      visibility: update.visibility || VISIBILITY.PUBLIC,
      createdAt: update.createdAt,
      moderator: formatModerator(update.moderator),
    })),
  };
}

/** Condensed shape for the moderator list view. */
function toModeratorSummary(report) {
  return {
    id: report._id.toString(),
    category: report.category,
    status: report.status,
    descriptionPreview:
      report.description.length > PREVIEW_LENGTH
        ? `${report.description.slice(0, PREVIEW_LENGTH)}…`
        : report.description,
    hasEvidence: Boolean(report.evidenceUrl),
    updateCount: report.updates.length,
    messageCount: (report.messages || []).length,
    awaitingReporter: Boolean(report.awaitingReporter),
    submittedAt: report.createdAt,
    lastUpdatedAt: report.updatedAt,
  };
}

/** Echoes the applied filters back in list metadata (null = not applied). */
function describeFilters({
  status,
  category,
  q,
  from,
  toExclusive,
  hasEvidence,
  awaitingReporter,
}) {
  const boolOrNull = (value) => (typeof value === 'boolean' ? value : null);
  return {
    status: status || null,
    category: category || null,
    q: q || null,
    from: from || null,
    toExclusive: toExclusive || null,
    hasEvidence: boolOrNull(hasEvidence),
    awaitingReporter: boolOrNull(awaitingReporter),
  };
}

function formatModerator(moderator) {
  if (!moderator) return null;
  // Populated document vs. raw ObjectId.
  if (moderator.displayName) {
    return { id: moderator._id.toString(), displayName: moderator.displayName };
  }
  return { id: moderator.toString() };
}

/* ---------------------------------------------------------------------------
 * Commands & queries
 * ------------------------------------------------------------------------- */

/**
 * Creates a report and returns the plaintext case code alongside it.
 *
 * The code is returned exactly once, here. We store only its hash, so if the
 * reporter loses the code there is genuinely no way — for us or for anyone
 * else — to recover it. That is the point.
 *
 * `warnings` lists kinds of possibly-identifying content found in the
 * description (codes only, never the matched text). They never block the
 * submission.
 */
async function createReport({ category, description, evidenceUrl = null }) {
  // Stored and returned timestamps are the bucket start, never the real time.
  const submittedAt = coarsenDate(new Date(), env.privacy.timestampBucketMinutes);

  for (let attempt = 0; attempt < MAX_CASE_CODE_ATTEMPTS; attempt += 1) {
    const caseCode = generateCaseCode();
    try {
      // Retries must run one after another: each depends on the last failing.
      // eslint-disable-next-line no-await-in-loop
      const report = await Report.create({
        _id: coarseObjectId(submittedAt),
        createdAt: submittedAt,
        updatedAt: submittedAt,
        caseCodeHash: hashCaseCode(caseCode),
        category,
        description,
        evidenceUrl,
        status: STATUS.SUBMITTED,
      });
      return { report, caseCode, warnings: scanForPii(description) };
    } catch (error) {
      // Duplicate case code or id: astronomically unlikely, but retrying is
      // cheap and means a collision can never surface as a 500.
      if (error.code === 11000) continue;
      throw error;
    }
  }

  throw new AppError(500, 'Could not allocate a case code. Please try again.');
}

/** Looks a case up by its code. Unknown codes are a 404, never a hint. */
async function getReportByCaseCode(caseCode) {
  const report = await Report.findOne({ caseCodeHash: hashCaseCode(caseCode) });
  if (!report) {
    throw AppError.notFound('No case found for that code. Check the code and try again.');
  }
  return report;
}

// Reports in the same time bucket share a createdAt; the (random) _id is a
// stable tie-breaker so pagination never repeats or skips a report.
const SORTS = Object.freeze({
  newest: { createdAt: -1, _id: -1 },
  oldest: { createdAt: 1, _id: 1 },
  recentlyUpdated: { updatedAt: -1, _id: -1 },
});

/**
 * Turns validated filters into a MongoDB query. Every value arrives typed and
 * bounded from Zod, and free text goes to the `$text` index — never into a
 * RegExp — so there is nothing to escape and no ReDoS surface.
 */
function buildReportFilter({
  status,
  category,
  q,
  from,
  toExclusive,
  hasEvidence,
  awaitingReporter,
}) {
  const filter = {};
  if (status) filter.status = status;
  if (category) filter.category = category;
  if (q) filter.$text = { $search: q };

  if (from || toExclusive) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = from;
    if (toExclusive) filter.createdAt.$lt = toExclusive;
  }

  if (hasEvidence === true) filter.evidenceUrl = { $ne: null };
  if (hasEvidence === false) filter.evidenceUrl = null;
  if (typeof awaitingReporter === 'boolean') filter.awaitingReporter = awaitingReporter;

  return filter;
}

async function listReports({ page = 1, limit = 20, sort = 'newest', ...filters } = {}) {
  const filter = buildReportFilter(filters);
  const skip = (page - 1) * limit;

  const [reports, total] = await Promise.all([
    Report.find(filter).sort(SORTS[sort]).skip(skip).limit(limit),
    Report.countDocuments(filter),
  ]);

  return {
    reports,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  };
}

async function getReportById(id) {
  const report = await Report.findById(id).populate(MODERATOR_REFS);
  if (!report) {
    throw AppError.notFound('Report not found');
  }
  return report;
}

/**
 * Loads a report for a moderator and records that they opened it. The audit
 * entry is written BEFORE the contents are returned: if the read cannot be
 * recorded, it does not happen.
 */
async function viewReport({ reportId, moderatorId }) {
  const report = await getReportById(reportId);
  await auditService.record({
    moderatorId,
    action: AUDIT_ACTION.VIEW_REPORT,
    reportId: report._id,
  });
  return report;
}

/**
 * Validates a requested transition against the workflow table. Every
 * rejection path is explicit so the caller gets an actionable message: a no-op
 * transition is a 409, an illegal jump is a 422 listing what IS allowed, and a
 * closed case says so.
 */
function assertTransitionAllowed(currentStatus, nextStatus) {
  if (currentStatus === nextStatus) {
    throw AppError.conflict(`Report is already ${currentStatus}`);
  }

  if (!isValidTransition(currentStatus, nextStatus)) {
    const reason = isTerminal(currentStatus)
      ? `Report is closed (${currentStatus}) and cannot change status`
      : `Cannot change status from ${currentStatus} to ${nextStatus}`;

    throw AppError.unprocessable(reason, {
      currentStatus,
      requestedStatus: nextStatus,
      allowedTransitions: getAllowedTransitions(currentStatus),
    });
  }
}

/**
 * Called when an atomic write matched nothing. Re-reads the report to tell the
 * two possible causes apart: it no longer exists (404), or someone else
 * changed it between our read and our write (409).
 */
async function rejectStaleWrite(reportId, expectedStatus) {
  const latest = await Report.findById(reportId).select('status');
  if (!latest) {
    throw AppError.notFound('Report not found');
  }

  if (expectedStatus && latest.status !== expectedStatus) {
    throw AppError.conflict(
      `Report status changed from ${expectedStatus} to ${latest.status} while this request was in flight. Reload and try again.`,
      { expectedStatus, currentStatus: latest.status }
    );
  }

  throw AppError.conflict(`Report is closed (${latest.status}) and cannot be changed`, {
    currentStatus: latest.status,
  });
}

/**
 * Moves a report to a new status, recording who did it and why.
 *
 * The write is a single findOneAndUpdate filtered on the status we validated
 * against. A read-validate-save sequence would let two moderators both pass
 * the check (UNDER_REVIEW → RESOLVED and UNDER_REVIEW → DISMISSED) and the
 * second save would silently overwrite the first. Filtering on the expected
 * status turns that race into a clean 409 for whoever lost it.
 */
async function updateReportStatus({ reportId, moderatorId, nextStatus, message }) {
  const current = await Report.findById(reportId).select('status');
  if (!current) {
    throw AppError.notFound('Report not found');
  }

  assertTransitionAllowed(current.status, nextStatus);

  // closedAt is written in the same operation as the status, so there is no
  // moment at which a report is closed but missing from the retention index.
  const updated = await Report.findOneAndUpdate(
    { _id: reportId, status: current.status },
    {
      $set: {
        status: nextStatus,
        closedAt: isTerminal(nextStatus) ? new Date() : null,
        // A closed case cannot be answered, so it is not "waiting" any more.
        ...(isTerminal(nextStatus) ? { awaitingReporter: false } : {}),
      },
      $push: {
        updates: {
          message: message || `Status changed to ${nextStatus}`,
          status: nextStatus,
          // A status change is something the reporter is entitled to see.
          visibility: VISIBILITY.PUBLIC,
          moderator: moderatorId,
        },
      },
    },
    { new: true, runValidators: true }
  ).populate(MODERATOR_REFS);

  if (!updated) {
    return rejectStaleWrite(reportId, current.status);
  }

  await auditService.record({
    moderatorId,
    action: AUDIT_ACTION.UPDATE_STATUS,
    reportId: updated._id,
  });
  return updated;
}

/**
 * Adds a note without changing the status: PUBLIC for the reporter, or
 * INTERNAL for moderators only.
 *
 * The "case is still open" check is part of the update filter rather than a
 * prior read, so a note can never land on a case that was closed a moment
 * earlier by another moderator.
 */
async function addStatusUpdate({ reportId, moderatorId, message, visibility = VISIBILITY.PUBLIC }) {
  const updated = await Report.findOneAndUpdate(
    { _id: reportId, status: { $in: OPEN_STATUSES } },
    { $push: { updates: { message, status: null, visibility, moderator: moderatorId } } },
    { new: true, runValidators: true }
  ).populate(MODERATOR_REFS);

  if (!updated) {
    return rejectStaleWrite(reportId);
  }

  await auditService.record({
    moderatorId,
    action: AUDIT_ACTION.ADD_UPDATE,
    reportId: updated._id,
  });
  return updated;
}

/**
 * Re-reads a report after an atomic message write matched nothing and turns
 * the reason into the right error: unknown (404), closed (409) or full (409).
 */
async function rejectMessageWrite(filter) {
  const report = await Report.findOne(filter).select('status messages');
  if (!report) {
    throw AppError.notFound('No case found for that code. Check the code and try again.');
  }
  if (isTerminal(report.status)) {
    throw AppError.conflict(
      `This case is closed (${report.status}) and no longer accepts messages`
    );
  }
  throw AppError.conflict(
    `This conversation has reached its limit of ${MAX_MESSAGES_PER_REPORT} messages`
  );
}

/** Filter fragment: the case is open and the thread has room for one more. */
const acceptsMessages = () => ({
  status: { $in: OPEN_STATUSES },
  [`messages.${MAX_MESSAGES_PER_REPORT - 1}`]: { $exists: false },
});

/**
 * The reporter answers (or writes unprompted) using only their case code.
 *
 * Everything that could identify them is kept out of the write: the message
 * time is coarsened like the submission time, and `timestamps: false` stops
 * Mongoose from stamping the exact time into updatedAt — `$max` with the
 * coarse time moves it forward without ever revealing more than the bucket.
 */
async function addReporterMessage({ caseCode, body }) {
  const caseCodeHash = hashCaseCode(caseCode);
  const sentAt = coarsenDate(new Date(), env.privacy.timestampBucketMinutes);

  const updated = await Report.findOneAndUpdate(
    { caseCodeHash, ...acceptsMessages() },
    {
      $push: { messages: { from: MESSAGE_FROM.REPORTER, body, createdAt: sentAt } },
      $set: { awaitingReporter: false },
      $max: { updatedAt: sentAt },
    },
    { new: true, runValidators: true, timestamps: false }
  );

  if (!updated) {
    return rejectMessageWrite({ caseCodeHash });
  }

  return { report: updated, warnings: scanForPii(body) };
}

/** A moderator asks the reporter a question; the case is flagged as waiting. */
async function addModeratorMessage({ reportId, moderatorId, body }) {
  const updated = await Report.findOneAndUpdate(
    { _id: reportId, ...acceptsMessages() },
    {
      $push: {
        messages: {
          from: MESSAGE_FROM.MODERATOR,
          body,
          moderator: moderatorId,
          createdAt: new Date(),
        },
      },
      $set: { awaitingReporter: true },
    },
    { new: true, runValidators: true }
  ).populate(MODERATOR_REFS);

  if (!updated) {
    const exists = await Report.exists({ _id: reportId });
    if (!exists) throw AppError.notFound('Report not found');
    return rejectMessageWrite({ _id: reportId });
  }

  await auditService.record({
    moderatorId,
    action: AUDIT_ACTION.SEND_MESSAGE,
    reportId: updated._id,
  });
  return updated;
}

/** Small dashboard aggregate: how many reports sit in each status. */
async function getStatusBreakdown() {
  const rows = await Report.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
  return rows.reduce((acc, row) => ({ ...acc, [row._id]: row.count }), {});
}

module.exports = {
  createReport,
  getReportByCaseCode,
  listReports,
  getReportById,
  viewReport,
  updateReportStatus,
  addStatusUpdate,
  addReporterMessage,
  addModeratorMessage,
  MAX_MESSAGES_PER_REPORT,
  getStatusBreakdown,
  toReporterView,
  toModeratorView,
  toModeratorSummary,
  describeFilters,
};
