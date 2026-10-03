'use strict';

const jwt = require('jsonwebtoken');
const env = require('../config/env');
const Moderator = require('../models/Moderator');
const AppError = require('../utils/AppError');
const { JWT_ISSUER, JWT_AUDIENCE } = require('../utils/constants');
const asyncHandler = require('../utils/asyncHandler');

function extractBearerToken(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (!token || scheme.toLowerCase() !== 'bearer') return null;
  return token.trim();
}

/**
 * Authenticates staff (moderators and admins).
 *
 * Verifies the JWT, then re-loads the account from the database on every
 * request. That extra read means a deactivated account loses access
 * immediately rather than when its token happens to expire, and a token whose
 * role claim no longer matches the account (promoted or demoted since login)
 * is rejected instead of carrying stale privileges for up to JWT_EXPIRES_IN.
 */
const requireModerator = asyncHandler(async (req, _res, next) => {
  const token = extractBearerToken(req);
  if (!token) {
    throw AppError.unauthorized('Missing or malformed Authorization header');
  }

  let payload;
  try {
    payload = jwt.verify(token, env.jwt.secret, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw AppError.unauthorized('Session expired, please log in again');
    }
    throw AppError.unauthorized('Invalid authentication token');
  }

  const moderator = await Moderator.findById(payload.sub);
  if (!moderator || !moderator.isActive) {
    throw AppError.unauthorized('Moderator account is no longer active');
  }

  if (payload.role !== moderator.role) {
    throw AppError.unauthorized('Your role has changed since you logged in. Please log in again.');
  }

  req.moderator = moderator;
  return next();
});

/**
 * Restricts a route to the given roles. Must run after requireModerator; it
 * checks the role on the freshly loaded account, never the token claim alone.
 */
function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.moderator) {
      return next(AppError.unauthorized());
    }
    if (!roles.includes(req.moderator.role)) {
      return next(AppError.forbidden(`This action requires the ${roles.join(' or ')} role`));
    }
    return next();
  };
}

module.exports = { requireModerator, requireRole, extractBearerToken };
