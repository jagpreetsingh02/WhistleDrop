'use strict';

const Report = require('../models/Report');
const AppError = require('../utils/AppError');
const { generateCaseCode, hashCaseCode } = require('../utils/caseCode');
const { getAllowedTransitions, isValidTransition, isTerminal } = require('../utils/statusWorkflow');
const { STATUS } = require('../utils/constants');

const MAX_CASE_CODE_ATTEMPTS = 5;
const PREVIEW_LENGTH = 140;

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
  for (let attempt = 0; attempt < MAX_CASE_CODE_ATTEMPTS; attempt += 1) {
    const caseCode = generateCaseCode();
    try {
      const report = await Report.create({
        caseCodeHash: hashCaseCode(caseCode),
        category,
        description,
        evidenceUrl,
        status: STATUS.SUBMITTED,
      });
      return { report, caseCode };
    } catch (error) {
      // Duplicate case code: astronomically unlikely, but retrying is cheap
      // and means a collision can never surface as a 500.
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

  const [reports, total] = await Promise.all([
    Report.find(filter).sort({ createdAt: sortOrder }).skip(skip).limit(limit),
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
 * Moves a report to a new status, recording who did it and why.
 *
 * Every rejection path is explicit so the caller gets an actionable message:
 * a no-op transition is a 409, an illegal jump is a 422 listing what IS
 * allowed, and a closed case says so.
 */
async function updateReportStatus({ reportId, moderatorId, nextStatus, message }) {
  const report = await getReportById(reportId);
  const currentStatus = report.status;

  if (currentStatus === nextStatus) {
    throw AppError.conflict(`Report is already ${currentStatus}`);
  }

  if (!isValidTransition(currentStatus, nextStatus)) {
    const allowed = getAllowedTransitions(currentStatus);
    const reason = isTerminal(currentStatus)
      ? `Report is closed (${currentStatus}) and cannot change status`
      : `Cannot change status from ${currentStatus} to ${nextStatus}`;

    throw AppError.unprocessable(reason, {
      currentStatus,
      requestedStatus: nextStatus,
      allowedTransitions: allowed,
    });
  }

  report.status = nextStatus;
  report.updates.push({
    message: message || `Status changed to ${nextStatus}`,
    status: nextStatus,
    moderator: moderatorId,
  });

  await report.save();
  await report.populate('updates.moderator', 'displayName');
  return report;
}

/** Adds a note for the reporter without changing the status. */
async function addStatusUpdate({ reportId, moderatorId, message }) {
  const report = await getReportById(reportId);

  if (isTerminal(report.status)) {
    throw AppError.conflict(`Report is closed (${report.status}) and cannot receive new updates`);
  }

  report.updates.push({ message, status: null, moderator: moderatorId });
  await report.save();
  await report.populate('updates.moderator', 'displayName');
  return report;
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
