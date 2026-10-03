'use strict';

const env = require('../config/env');
const Report = require('../models/Report');
const AppError = require('../utils/AppError');
const { generateCaseCode, hashCaseCode } = require('../utils/caseCode');
const { coarsenDate, coarseObjectId } = require('../utils/timeBuckets');
const { getAllowedTransitions, isValidTransition, isTerminal } = require('../utils/statusWorkflow');
const { STATUS, STATUSES } = require('../utils/constants');

const MAX_CASE_CODE_ATTEMPTS = 5;
const PREVIEW_LENGTH = 140;
const OPEN_STATUSES = STATUSES.filter((status) => !isTerminal(status));

/* ---------------------------------------------------------------------------
 * Presenters
 *
 * Two audiences, two shapes. Keeping the mapping explicit (rather than
 * returning raw documents) is what guarantees that internal fields —
 * caseCodeHash, the moderator behind an update — can never slip into a
 * response by accident.
 * ------------------------------------------------------------------------- */

/** What the anonymous reporter sees when tracking a case. */
function toReporterView(report) {
  return {
    category: report.category,
    status: report.status,
    submittedAt: report.createdAt,
    lastUpdatedAt: report.updatedAt,
    isClosed: isTerminal(report.status),
    updates: report.updates.map((update) => ({
      message: update.message,
      status: update.status,
      createdAt: update.createdAt,
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
    updates: report.updates.map((update) => ({
      id: update._id.toString(),
      message: update.message,
      status: update.status,
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
    submittedAt: report.createdAt,
    lastUpdatedAt: report.updatedAt,
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
 */
async function createReport({ category, description, evidenceUrl = null }) {
  // Stored and returned timestamps are the bucket start, never the real time.
  const submittedAt = coarsenDate(new Date(), env.privacy.timestampBucketMinutes);

  for (let attempt = 0; attempt < MAX_CASE_CODE_ATTEMPTS; attempt += 1) {
    const caseCode = generateCaseCode();
    try {
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
      return { report, caseCode };
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

async function listReports({ status, category, page = 1, limit = 20, sort = 'newest' } = {}) {
  const filter = {};
  if (status) filter.status = status;
  if (category) filter.category = category;

  const skip = (page - 1) * limit;
  const sortOrder = sort === 'oldest' ? 1 : -1;

  // Reports in the same time bucket share a createdAt; the (random) _id is a
  // stable tie-breaker so pagination never repeats or skips a report.
  const [reports, total] = await Promise.all([
    Report.find(filter).sort({ createdAt: sortOrder, _id: sortOrder }).skip(skip).limit(limit),
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
  const report = await Report.findById(id).populate('updates.moderator', 'displayName');
  if (!report) {
    throw AppError.notFound('Report not found');
  }
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

  const updated = await Report.findOneAndUpdate(
    { _id: reportId, status: current.status },
    {
      $set: { status: nextStatus },
      $push: {
        updates: {
          message: message || `Status changed to ${nextStatus}`,
          status: nextStatus,
          moderator: moderatorId,
        },
      },
    },
    { new: true, runValidators: true }
  ).populate('updates.moderator', 'displayName');

  if (!updated) {
    return rejectStaleWrite(reportId, current.status);
  }

  return updated;
}

/**
 * Adds a note for the reporter without changing the status.
 *
 * The "case is still open" check is part of the update filter rather than a
 * prior read, so a note can never land on a case that was closed a moment
 * earlier by another moderator.
 */
async function addStatusUpdate({ reportId, moderatorId, message }) {
  const updated = await Report.findOneAndUpdate(
    { _id: reportId, status: { $in: OPEN_STATUSES } },
    { $push: { updates: { message, status: null, moderator: moderatorId } } },
    { new: true, runValidators: true }
  ).populate('updates.moderator', 'displayName');

  if (!updated) {
    return rejectStaleWrite(reportId);
  }

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
  updateReportStatus,
  addStatusUpdate,
  getStatusBreakdown,
  toReporterView,
  toModeratorView,
  toModeratorSummary,
};
