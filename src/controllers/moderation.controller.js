'use strict';

const asyncHandler = require('../utils/asyncHandler');
const reportService = require('../services/report.service');

/** GET /api/v1/moderator/reports — list with optional filters and paging. */
const listReports = asyncHandler(async (req, res) => {
  const { page, limit, sort, ...filters } = req.validated.query;
  const { reports, pagination } = await reportService.listReports({
    page,
    limit,
    sort,
    ...filters,
  });

  res.status(200).json({
    success: true,
    data: reports.map(reportService.toModeratorSummary),
    meta: { ...pagination, sort, filters: reportService.describeFilters(filters) },
  });
});

/** GET /api/v1/moderator/reports/:id */
const getReport = asyncHandler(async (req, res) => {
  const report = await reportService.viewReport({
    reportId: req.validated.params.id,
    moderatorId: req.moderator._id,
  });

  res.status(200).json({
    success: true,
    data: reportService.toModeratorView(report),
  });
});

/** PATCH /api/v1/moderator/reports/:id/status — workflow-checked transition. */
const updateStatus = asyncHandler(async (req, res) => {
  const report = await reportService.updateReportStatus({
    reportId: req.validated.params.id,
    moderatorId: req.moderator._id,
    nextStatus: req.validated.body.status,
    message: req.validated.body.message,
  });

  res.status(200).json({
    success: true,
    message: `Report status updated to ${report.status}`,
    data: reportService.toModeratorView(report),
  });
});

/** POST /api/v1/moderator/reports/:id/updates — public or internal note. */
const addUpdate = asyncHandler(async (req, res) => {
  const { message, visibility } = req.validated.body;
  const report = await reportService.addStatusUpdate({
    reportId: req.validated.params.id,
    moderatorId: req.moderator._id,
    message,
    visibility,
  });

  res.status(201).json({
    success: true,
    message: visibility === 'INTERNAL' ? 'Internal note added' : 'Update added',
    data: reportService.toModeratorView(report),
  });
});

/** POST /api/v1/moderator/reports/:id/messages — ask the reporter a question. */
const sendMessage = asyncHandler(async (req, res) => {
  const report = await reportService.addModeratorMessage({
    reportId: req.validated.params.id,
    moderatorId: req.moderator._id,
    body: req.validated.body.body,
  });

  res.status(201).json({
    success: true,
    message: 'Message sent to the reporter',
    data: reportService.toModeratorView(report),
  });
});

/** GET /api/v1/moderator/stats — counts per status for a queue overview. */
const getStats = asyncHandler(async (_req, res) => {
  const breakdown = await reportService.getStatusBreakdown();
  const total = Object.values(breakdown).reduce((sum, count) => sum + count, 0);

  res.status(200).json({
    success: true,
    data: { total, byStatus: breakdown },
  });
});

module.exports = { listReports, getReport, updateStatus, addUpdate, sendMessage, getStats };
