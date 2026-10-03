'use strict';

const asyncHandler = require('../utils/asyncHandler');
const adminService = require('../services/admin.service');

/** POST /api/v1/admin/moderators */
const createModerator = asyncHandler(async (req, res) => {
  const account = await adminService.createStaffAccount(req.validated.body);

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

module.exports = { createModerator, listModerators, deactivateModerator, activateModerator };
