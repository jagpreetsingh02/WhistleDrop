'use strict';

const express = require('express');
const validate = require('../middleware/validate');
const { submitReportLimiter, trackLimiter } = require('../middleware/rateLimiter');
const { submitReport, trackReport } = require('../controllers/report.controller');
const {
  submitReportSchema,
  trackReportParamsSchema,
} = require('../validators/report.validator');

/** Public, unauthenticated routes used by reporters. */
const router = express.Router();

router.post(
  '/',
  submitReportLimiter,
  validate({ body: submitReportSchema }),
  submitReport
);

router.get(
  '/:caseCode',
  trackLimiter,
  validate({ params: trackReportParamsSchema }),
  trackReport
);

module.exports = router;
