'use strict';

const asyncHandler = require('../utils/asyncHandler');
const reportService = require('../services/report.service');

/**
 * POST /api/v1/reports — anonymous submission.
 *
 * No authentication, no session, nothing identifying is read off the request.
 * The response is the only time the case code is ever shown.
 */
const submitReport = asyncHandler(async (req, res) => {
  const { category, description, evidenceUrl } = req.validated.body;

  const { report, caseCode, warnings } = await reportService.createReport({
    category,
    description,
    evidenceUrl,
  });

  res.status(201).json({
    success: true,
    message:
      'Report submitted. Save your case code now — it is shown only once and cannot be recovered.',
    data: {
      caseCode,
      category: report.category,
      status: report.status,
      submittedAt: report.createdAt,
      warnings,
    },
  });
});

/** GET /api/v1/reports/:caseCode — anonymous case tracking. */
const trackReport = asyncHandler(async (req, res) => {
  const { caseCode } = req.validated.params;
  const report = await reportService.getReportByCaseCode(caseCode);

  res.status(200).json({
    success: true,
    data: reportService.toReporterView(report),
  });
});

module.exports = { submitReport, trackReport };
