'use strict';

const express = require('express');
const validate = require('../middleware/validate');
const noStore = require('../middleware/noStore');
const { requireModerator, requireRole } = require('../middleware/auth');
const {
  createModerator,
  listModerators,
  deactivateModerator,
  activateModerator,
  listAuditLog,
  verifyAuditLog,
} = require('../controllers/admin.controller');
const {
  createStaffSchema,
  listStaffQuerySchema,
  staffIdParamsSchema,
  listAuditQuerySchema,
} = require('../validators/admin.validator');
const { ROLE } = require('../utils/constants');

const router = express.Router();

// Every admin route: authenticated (401), then admin-only (403), never cached.
router.use(noStore, requireModerator, requireRole(ROLE.ADMIN));

router.post('/moderators', validate({ body: createStaffSchema }), createModerator);
router.get('/moderators', validate({ query: listStaffQuerySchema }), listModerators);

router.patch(
  '/moderators/:id/deactivate',
  validate({ params: staffIdParamsSchema }),
  deactivateModerator
);

router.patch(
  '/moderators/:id/activate',
  validate({ params: staffIdParamsSchema }),
  activateModerator
);

router.get('/audit-log', validate({ query: listAuditQuerySchema }), listAuditLog);
router.get('/audit-log/verify', verifyAuditLog);

module.exports = router;
