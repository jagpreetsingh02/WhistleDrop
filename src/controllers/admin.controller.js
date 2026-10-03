'use strict';

const asyncHandler = require('../utils/asyncHandler');
const adminService = require('../services/admin.service');
const auditService = require('../services/audit.service');

/** POST /api/v1/admin/moderators */
const createModerator = asyncHandler(async (req, res) => {
  const account = await adminService.createStaffAccount({
    actorId: req.moderator._id,
    ...req.validated.body,
  });

  res.status(201).json({
    success: true,
    message: `Account "${account.username}" created`,
    data: adminService.toStaffView(account),
  });
});

/** GET /api/v1/admin/moderators */
const listModerators = asyncHandler(async (req, res) => {
  const { accounts, pagination } = await adminService.listStaffAccounts(req.validated.query);

  res.status(200).json({
    success: true,
    data: accounts.map(adminService.toStaffView),
    meta: pagination,
  });
});

/** Builds the activate / deactivate handlers, which differ only in the target state. */
const setActive = (isActive) =>
  asyncHandler(async (req, res) => {
    const account = await adminService.setAccountActive({
      actorId: req.moderator._id,
      targetId: req.validated.params.id,
      isActive,
    });

    res.status(200).json({
      success: true,
      message: `Account "${account.username}" ${isActive ? 'activated' : 'deactivated'}`,
      data: adminService.toStaffView(account),
    });
  });

/** PATCH /api/v1/admin/moderators/:id/deactivate */
const deactivateModerator = setActive(false);

/** PATCH /api/v1/admin/moderators/:id/activate */
const activateModerator = setActive(true);

/** GET /api/v1/admin/audit-log — newest entries first. */
const listAuditLog = asyncHandler(async (req, res) => {
  const { entries, pagination } = await auditService.listEntries(req.validated.query);

  res.status(200).json({
    success: true,
    data: entries.map(auditService.toAuditView),
    meta: pagination,
  });
});

/** GET /api/v1/admin/audit-log/verify — recomputes the whole hash chain. */
const verifyAuditLog = asyncHandler(async (_req, res) => {
  const result = await auditService.verifyChain();

  res.status(200).json({
    success: true,
    message: result.intact
      ? 'Audit log is intact'
      : `Audit log has been tampered with at entry #${result.brokenAtSeq}`,
    data: result,
  });
});

module.exports = {
  createModerator,
  listModerators,
  deactivateModerator,
  activateModerator,
  listAuditLog,
  verifyAuditLog,
};
