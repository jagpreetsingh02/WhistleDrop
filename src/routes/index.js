'use strict';

const express = require('express');
const reportRoutes = require('./report.routes');
const authRoutes = require('./auth.routes');
const moderatorRoutes = require('./moderator.routes');
const { CATEGORIES, STATUSES } = require('../utils/constants');
const { ALLOWED_TRANSITIONS } = require('../utils/statusWorkflow');

const router = express.Router();

/** Liveness probe, also reachable at the root as `/health`. */
router.get('/health', (_req, res) => {
  res.status(200).json({ success: true, data: { status: 'ok' } });
});

/**
 * Self-describing metadata endpoint: lets any client discover the valid
 * categories and the status workflow instead of hard-coding them.
 */
router.get('/meta', (_req, res) => {
  res.status(200).json({
    success: true,
    data: {
      categories: CATEGORIES,
      statuses: STATUSES,
      workflow: ALLOWED_TRANSITIONS,
    },
  });
});

router.use('/reports', reportRoutes);
router.use('/auth', authRoutes);
router.use('/moderator', moderatorRoutes);

module.exports = router;
