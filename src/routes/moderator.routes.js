'use strict';

const express = require('express');
const validate = require('../middleware/validate');
const { requireModerator } = require('../middleware/auth');
const {
  listReports,
  getReport,
  updateStatus,
  addUpdate,
  getStats,
} = require('../controllers/moderation.controller');
const {
  listReportsQuerySchema,
  reportIdParamsSchema,
  updateStatusSchema,
  addUpdateSchema,
} = require('../validators/report.validator');

const router = express.Router();

// One guard for the whole router: every route below requires a valid JWT.
// Applying it here rather than per-route means a new endpoint cannot be added
// unprotected by mistake.
router.use(requireModerator);

router.get('/stats', getStats);
router.get('/reports', validate({ query: listReportsQuerySchema }), listReports);
router.get('/reports/:id', validate({ params: reportIdParamsSchema }), getReport);

router.patch(
  '/reports/:id/status',
  validate({ params: reportIdParamsSchema, body: updateStatusSchema }),
  updateStatus
);

router.post(
  '/reports/:id/updates',
  validate({ params: reportIdParamsSchema, body: addUpdateSchema }),
  addUpdate
);

module.exports = router;
