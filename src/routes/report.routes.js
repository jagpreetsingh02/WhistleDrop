'use strict';

const express = require('express');
const validate = require('../middleware/validate');
const noStore = require('../middleware/noStore');
const {
  submitReportLimiter,
  trackLimiter,
  reporterMessageLimiter,
} = require('../middleware/rateLimiter');
const { submitReport, trackReport, sendMessage } = require('../controllers/report.controller');
const {
  submitReportSchema,
  trackReportParamsSchema,
  messageSchema,
} = require('../validators/report.validator');

/** Public, unauthenticated routes used by reporters. */
const router = express.Router();

// Applied before the limiter and validation so 4xx responses are covered too.
router.use(noStore);

router.post('/', submitReportLimiter, validate({ body: submitReportSchema }), submitReport);

router.get('/:caseCode', trackLimiter, validate({ params: trackReportParamsSchema }), trackReport);

router.post(
  '/:caseCode/messages',
  reporterMessageLimiter,
  validate({ params: trackReportParamsSchema, body: messageSchema }),
  sendMessage
);

module.exports = router;
