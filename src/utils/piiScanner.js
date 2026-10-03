'use strict';

/**
 * Flags text that may identify the person who wrote it.
 *
 * Reporters routinely undo their own anonymity by signing off with an email
 * address or mentioning their staff number. This scanner spots the obvious
 * cases so the API can warn them.
 *
 * Design rules:
 *  - It returns warning CODES only, never the matched text. Matches are not
 *    logged, stored or echoed back, so the scanner cannot itself become a
 *    place where identifying data accumulates.
 *  - It is a nudge, not a gate. A submission is never rejected because of it:
 *    a false positive that blocks a real report would be far worse than a
 *    warning the reporter can ignore. We therefore lean towards over-warning.
 *  - It is pure and synchronous: no I/O, trivially unit-testable.
 */

const DETECTORS = [
  {
    code: 'POSSIBLE_EMAIL',
    message: 'The text appears to contain an email address.',
    test: (text) => /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text),
  },
  {
    code: 'POSSIBLE_PHONE_NUMBER',
    message: 'The text appears to contain a phone number or long personal number.',
    test: (text) => {
      // Candidate runs of digits with common phone separators. Counting the
      // digits afterwards (10–15, the E.164 range) keeps dates, years,
      // versions and amounts from matching.
      const candidates = text.match(/\+?\(?\d[\d\s().-]{8,}\d/g) || [];
      return candidates.some((candidate) => {
        const digits = candidate.replace(/\D/g, '');
        return digits.length >= 10 && digits.length <= 15;
      });
    },
  },
  {
    code: 'POSSIBLE_SOCIAL_HANDLE',
    message: 'The text appears to contain a social media or chat handle (@name).',
    // Not preceded by a word character, so the "@" inside an email is ignored.
    test: (text) => /(^|[^\w@.])@[A-Za-z0-9_]{2,30}\b/.test(text),
  },
  {
    code: 'POSSIBLE_PERSONAL_ID',
    message: 'The text appears to contain an employee, student or badge ID.',
    test: (text) =>
      // Labelled IDs: "employee id: 4521", "staff no 88", "roll number RA21…".
      /\b(?:emp(?:loyee)?|staff|badge|student|roll|reg(?:istration)?|register)\s*(?:id|no\.?|number|#)\s*[:#-]?\s*[A-Z0-9-]{2,}/i.test(
        text
      ) ||
      // Unlabelled codes shaped like "EMP123456" or "RA2111003010123": a short
      // upper-case prefix and six or more digits. Six keeps "CVE-2024" and
      // "ISO27001" out.
      /\b[A-Z]{1,4}-?\d{6,}\b/.test(text),
  },
  {
    code: 'POSSIBLE_SELF_IDENTIFICATION',
    message: 'The text appears to name or describe how to contact the author.',
    test: (text) =>
      /\b(?:my name is|my employee id|my staff id|you can reach me|contact me at|call me at|email me at|text me at)\b/i.test(
        text
      ),
  },
];

const ADVICE =
  'Moderators will see this text. If it could identify you, avoid repeating such details in follow-up messages.';

/**
 * @param {string} text
 * @returns {{ code: string, message: string }[]} one entry per kind of finding
 */
function scanForPii(text) {
  if (typeof text !== 'string' || text.length === 0) return [];

  return DETECTORS.filter((detector) => detector.test(text)).map((detector) => ({
    code: detector.code,
    message: `${detector.message} ${ADVICE}`,
  }));
}

module.exports = { scanForPii, PII_WARNING_CODES: DETECTORS.map((d) => d.code) };
