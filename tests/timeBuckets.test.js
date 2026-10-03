'use strict';

const { coarsenDate, coarseObjectId } = require('../src/utils/timeBuckets');

describe('timestamp coarsening (unit)', () => {
  it('rounds down to the start of the bucket', () => {
    expect(coarsenDate('2026-09-21T14:32:07.123Z', 15).toISOString()).toBe(
      '2026-09-21T14:30:00.000Z'
    );
    expect(coarsenDate('2026-09-21T14:44:59.999Z', 15).toISOString()).toBe(
      '2026-09-21T14:30:00.000Z'
    );
    expect(coarsenDate('2026-09-21T14:45:00.000Z', 15).toISOString()).toBe(
      '2026-09-21T14:45:00.000Z'
    );
  });

  it('supports other bucket sizes', () => {
    expect(coarsenDate('2026-09-21T14:32:07Z', 60).toISOString()).toBe('2026-09-21T14:00:00.000Z');
    expect(coarsenDate('2026-09-21T14:32:07Z', 1440).toISOString()).toBe(
      '2026-09-21T00:00:00.000Z'
    );
  });

  it('leaves the time untouched when the bucket is 0', () => {
    expect(coarsenDate('2026-09-21T14:32:07.123Z', 0).toISOString()).toBe(
      '2026-09-21T14:32:07.123Z'
    );
  });

  it('never moves a timestamp into the future', () => {
    const now = new Date();
    expect(coarsenDate(now, 15).getTime()).toBeLessThanOrEqual(now.getTime());
  });

  it('builds ObjectIds that carry only the coarse time', () => {
    const bucket = new Date('2026-09-21T14:30:00Z');
    const id = coarseObjectId(bucket);

    expect(id.getTimestamp().toISOString()).toBe('2026-09-21T14:30:00.000Z');
  });

  it('keeps ObjectIds unique within a bucket', () => {
    const bucket = new Date('2026-09-21T14:30:00Z');
    const ids = new Set(Array.from({ length: 5000 }, () => coarseObjectId(bucket).toString()));

    expect(ids.size).toBe(5000);
  });
});
