'use strict';

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const env = require('../config/env');
const Moderator = require('../models/Moderator');
const AppError = require('../utils/AppError');
const { JWT_ISSUER, JWT_AUDIENCE } = require('../utils/constants');

/**
 * A pre-computed hash of a throwaway password. When a login arrives for a
 * username that does not exist we still run one bcrypt comparison against it,
 * so a failed login takes the same time either way. Without this, response
 * timing quietly tells an attacker which usernames are real.
 */
const DUMMY_HASH = bcrypt.hashSync('timing-attack-mitigation-placeholder', 12);

function signToken(moderator) {
  return jwt.sign(
    { sub: moderator._id.toString(), role: 'moderator' },
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
    moderator: {
      id: moderator._id.toString(),
      username: moderator.username,
      displayName: moderator.displayName,
    },
  };
}

/**
 * Creates a moderator account. There is no public registration endpoint by
 * design — accounts are provisioned by an operator running
 * `npm run create:moderator`, so nobody can self-register into the queue of
 * sensitive reports.
 */
async function createModerator({ username, password, displayName }) {
  const normalizedUsername = String(username).trim().toLowerCase();

  const existing = await Moderator.findOne({ username: normalizedUsername });
  if (existing) {
    throw AppError.conflict(`Moderator "${normalizedUsername}" already exists`);
  }

  const passwordHash = await Moderator.hashPassword(password);
  return Moderator.create({
    username: normalizedUsername,
    passwordHash,
    displayName: displayName || normalizedUsername,
  });
}

module.exports = { login, createModerator, signToken };
