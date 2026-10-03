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
 * Protects moderator routes.
 *
 * Verifies the JWT, then re-loads the moderator from the database on every
 * request. That extra read means a deactivated account loses access
 * immediately rather than when its token happens to expire.
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

  req.moderator = moderator;
  return next();
});

module.exports = { requireModerator, extractBearerToken };
