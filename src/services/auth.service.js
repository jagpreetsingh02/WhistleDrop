'use strict';

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const env = require('../config/env');
const Moderator = require('../models/Moderator');
const AppError = require('../utils/AppError');
const { JWT_ISSUER, JWT_AUDIENCE, ROLE } = require('../utils/constants');

/**
 * A pre-computed hash of a throwaway password. When a login arrives for a
 * username that does not exist we still run one bcrypt comparison against it,
 * so a failed login takes the same time either way. Without this, response
 * timing quietly tells an attacker which usernames are real.
 */
const DUMMY_HASH = bcrypt.hashSync('timing-attack-mitigation-placeholder', 12);

function signToken(moderator) {
  return jwt.sign(
    { sub: moderator._id.toString(), role: moderator.role },
    env.jwt.secret,
    {
      expiresIn: env.jwt.expiresIn,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    }
  );
}

/**
 * Verifies credentials and issues a JWT.
 *
 * Every failure — unknown username, wrong password, deactivated account —
 * returns the same 401 message, so the endpoint never confirms that an
 * account exists.
 */
async function login({ username, password }) {
  const moderator = await Moderator.findOne({ username: username.toLowerCase() }).select(
    '+passwordHash'
  );

  const passwordMatches = moderator
    ? await moderator.verifyPassword(password)
    : await bcrypt.compare(password, DUMMY_HASH);

  if (!moderator || !passwordMatches || !moderator.isActive) {
    throw AppError.unauthorized('Invalid username or password');
  }

  return {
    token: signToken(moderator),
    expiresIn: env.jwt.expiresIn,
    moderator: toAccountView(moderator),
  };
}

/** Public shape of a staff account. Never includes the password hash. */
function toAccountView(moderator) {
  return {
    id: moderator._id.toString(),
    username: moderator.username,
    displayName: moderator.displayName,
    role: moderator.role,
  };
}

/**
 * Creates a staff account. There is no public registration endpoint by
 * design — accounts are provisioned by an operator (`npm run create:moderator`)
 * or by an admin through the admin API, so nobody can self-register into the
 * queue of sensitive reports.
 *
 * Uniqueness is enforced by the database index rather than a prior lookup, so
 * two simultaneous requests for the same username cannot both succeed.
 */
async function createModerator({ username, password, displayName, role = ROLE.MODERATOR }) {
  const normalizedUsername = String(username).trim().toLowerCase();
  const passwordHash = await Moderator.hashPassword(password);

  try {
    return await Moderator.create({
      username: normalizedUsername,
      passwordHash,
      displayName: displayName || normalizedUsername,
      role,
    });
  } catch (error) {
    if (error.code === 11000) {
      throw AppError.conflict(`Moderator "${normalizedUsername}" already exists`);
    }
    throw error;
  }
}

module.exports = { login, createModerator, signToken, toAccountView };
