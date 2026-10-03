'use strict';

const { STATUS } = require('./constants');

/**
 * The only legal status transitions.
 *
 *   SUBMITTED ──▶ UNDER_REVIEW ──▶ RESOLVED
 *                              └─▶ DISMISSED
 *
 * RESOLVED and DISMISSED are terminal: once a case is closed it stays closed,
 * so a reporter can trust that the outcome they were shown is final. Keeping
 * the rules in one small data structure (instead of `if` statements inside a
 * controller) makes the workflow easy to read, test and extend.
 */
const ALLOWED_TRANSITIONS = Object.freeze({
  [STATUS.SUBMITTED]: [STATUS.UNDER_REVIEW, STATUS.DISMISSED],
  [STATUS.UNDER_REVIEW]: [STATUS.RESOLVED, STATUS.DISMISSED],
  [STATUS.RESOLVED]: [],
  [STATUS.DISMISSED]: [],
});

function getAllowedTransitions(currentStatus) {
  return ALLOWED_TRANSITIONS[currentStatus] || [];
}

function isValidTransition(currentStatus, nextStatus) {
  return getAllowedTransitions(currentStatus).includes(nextStatus);
}

function isTerminal(status) {
  return getAllowedTransitions(status).length === 0;
}

module.exports = {
  ALLOWED_TRANSITIONS,
  getAllowedTransitions,
  isValidTransition,
  isTerminal,
};
