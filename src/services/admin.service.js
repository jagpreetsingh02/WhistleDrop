'use strict';

const Moderator = require('../models/Moderator');
const AppError = require('../utils/AppError');
const authService = require('./auth.service');

/** Admin-facing shape of a staff account. */
function toStaffView(account) {
  return {
    ...authService.toAccountView(account),
    isActive: account.isActive,
    createdAt: account.createdAt,
  };
}

function createStaffAccount({ username, password, displayName, role }) {
  return authService.createModerator({ username, password, displayName, role });
}

async function listStaffAccounts({ page = 1, limit = 20 } = {}) {
  const [accounts, total] = await Promise.all([
    Moderator.find()
      .sort({ createdAt: 1, _id: 1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Moderator.countDocuments(),
  ]);

  return {
    accounts,
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}

/**
 * Activates or deactivates a staff account.
 *
 * An admin may not deactivate themselves. Besides preventing an accidental
 * lock-out, it guarantees the system always keeps at least one active admin:
 * the last one standing has nobody else who could remove them.
 *
 * The write is filtered on the opposite of the requested state, so a no-op
 * ("deactivate an already inactive account") is reported as a 409 instead of
 * pretending something changed.
 */
async function setAccountActive({ actorId, targetId, isActive }) {
  if (!isActive && actorId.toString() === targetId.toString()) {
    throw AppError.forbidden('Admins cannot deactivate their own account');
  }

  const updated = await Moderator.findOneAndUpdate(
    { _id: targetId, isActive: !isActive },
    { $set: { isActive } },
    { new: true }
  );

  if (updated) return updated;

  const exists = await Moderator.exists({ _id: targetId });
  if (!exists) {
    throw AppError.notFound('Moderator not found');
  }
  throw AppError.conflict(`Moderator account is already ${isActive ? 'active' : 'inactive'}`);
}

module.exports = { toStaffView, createStaffAccount, listStaffAccounts, setAccountActive };
