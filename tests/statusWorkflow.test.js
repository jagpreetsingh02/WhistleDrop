'use strict';

const {
  isValidTransition,
  getAllowedTransitions,
  isTerminal,
} = require('../src/utils/statusWorkflow');
const { STATUS } = require('../src/utils/constants');

describe('status workflow rules (unit)', () => {
  it('allows the forward path SUBMITTED → UNDER_REVIEW → RESOLVED', () => {
    expect(isValidTransition(STATUS.SUBMITTED, STATUS.UNDER_REVIEW)).toBe(true);
    expect(isValidTransition(STATUS.UNDER_REVIEW, STATUS.RESOLVED)).toBe(true);
  });

  it('allows dismissing from either open state', () => {
    expect(isValidTransition(STATUS.SUBMITTED, STATUS.DISMISSED)).toBe(true);
    expect(isValidTransition(STATUS.UNDER_REVIEW, STATUS.DISMISSED)).toBe(true);
  });

  it('rejects skipping review', () => {
    expect(isValidTransition(STATUS.SUBMITTED, STATUS.RESOLVED)).toBe(false);
  });

  it('rejects moving backwards', () => {
    expect(isValidTransition(STATUS.UNDER_REVIEW, STATUS.SUBMITTED)).toBe(false);
    expect(isValidTransition(STATUS.RESOLVED, STATUS.UNDER_REVIEW)).toBe(false);
  });

  it('treats RESOLVED and DISMISSED as final', () => {
    expect(isTerminal(STATUS.RESOLVED)).toBe(true);
    expect(isTerminal(STATUS.DISMISSED)).toBe(true);
    expect(getAllowedTransitions(STATUS.RESOLVED)).toEqual([]);
    expect(getAllowedTransitions(STATUS.DISMISSED)).toEqual([]);
  });

  it('never treats an open state as final', () => {
    expect(isTerminal(STATUS.SUBMITTED)).toBe(false);
    expect(isTerminal(STATUS.UNDER_REVIEW)).toBe(false);
  });

  it('returns an empty list for an unknown status instead of throwing', () => {
    expect(getAllowedTransitions('NOT_A_STATUS')).toEqual([]);
    expect(isValidTransition('NOT_A_STATUS', STATUS.RESOLVED)).toBe(false);
  });
});
