'use strict';

const {
  generateCaseCode,
  normalizeCaseCode,
  hashCaseCode,
  ALPHABET,
} = require('../src/utils/caseCode');

describe('case code generation (unit)', () => {
  it('produces the documented WD-XXXXX-XXXXX-XXXXX shape', () => {
    expect(generateCaseCode()).toMatch(/^WD-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  });

  it('never uses visually ambiguous characters (0, O, 1, I, L, U)', () => {
    const codes = Array.from({ length: 200 }, generateCaseCode).join('');
    expect(codes.replace(/[-W D]/g, '')).not.toMatch(/[01ILOU]/);
    for (const char of ALPHABET) expect('01ILOU').not.toContain(char);
  });

  it('does not repeat codes across many generations', () => {
    const codes = new Set(Array.from({ length: 5000 }, generateCaseCode));
    expect(codes.size).toBe(5000);
  });

  it('normalizes case, spaces and dashes so reporters can paste loosely', () => {
    const code = 'WD-4K9TM-XQ7YB-2NHVR';
    expect(normalizeCaseCode(code.toLowerCase())).toBe('WD4K9TMXQ7YB2NHVR');
    expect(normalizeCaseCode('wd 4k9tm xq7yb 2nhvr')).toBe('WD4K9TMXQ7YB2NHVR');
    expect(hashCaseCode('wd4k9tm xq7yb-2nhvr')).toBe(hashCaseCode(code));
  });

  it('hashes to a stable 64-character digest that is not the code itself', () => {
    const code = generateCaseCode();
    const hash = hashCaseCode(code);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(normalizeCaseCode(code));
    expect(hashCaseCode(code)).toBe(hash);
  });

  it('gives different codes different hashes', () => {
    expect(hashCaseCode(generateCaseCode())).not.toBe(hashCaseCode(generateCaseCode()));
  });
});
