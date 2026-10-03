'use strict';

const crypto = require('crypto');
const { CASE_CODE_PREFIX } = require('./constants');

/**
 * Case codes are the reporter's ONLY credential — there is no account to fall
 * back on — so they must be unguessable and hard to mistype.
 *
 * - Generated from crypto.randomInt (CSPRNG, rejection-sampled internally so
 *   every character is equally likely). Never Math.random().
 * - Crockford-style alphabet: no 0/O/1/I/L/U, which are the characters people
 *   confuse when copying a code off a screen.
 * - 15 random characters from a 30-character alphabet ≈ 73 bits of entropy,
 *   far beyond brute force — especially behind the tracking rate limiter.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const GROUP_LENGTH = 5;
const GROUP_COUNT = 3;

function randomGroup() {
  let group = '';
  for (let i = 0; i < GROUP_LENGTH; i += 1) {
    group += ALPHABET[crypto.randomInt(ALPHABET.length)];
  }
  return group;
}

/** @returns {string} e.g. "WD-4K9TM-XQ7YB-2NHVR" */
function generateCaseCode() {
  const groups = Array.from({ length: GROUP_COUNT }, randomGroup);
  return [CASE_CODE_PREFIX, ...groups].join('-');
}

/**
 * Canonical form of a code: uppercase, separators removed. Lets a reporter
 * paste "wd 4k9tm xq7yb 2nhvr" and still find their case.
 */
function normalizeCaseCode(caseCode) {
  return String(caseCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * We store only the SHA-256 of the case code, never the code itself.
 * A stolen database dump therefore cannot be used to read cases: an attacker
 * would have to guess the original ~73-bit code. SHA-256 (not bcrypt) is the
 * right tool here because the input is high-entropy random data, and lookups
 * must be a single indexed query.
 */
function hashCaseCode(caseCode) {
  return crypto.createHash('sha256').update(normalizeCaseCode(caseCode)).digest('hex');
}

module.exports = {
  ALPHABET,
  generateCaseCode,
  normalizeCaseCode,
  hashCaseCode,
};
