'use strict';

const { scanForPii, PII_WARNING_CODES } = require('../src/utils/piiScanner');

const codes = (text) => scanForPii(text).map((warning) => warning.code);

describe('PII scanner (unit)', () => {
  describe('detects', () => {
    it.each([
      ['plain email', 'Reach me via priya.sharma@example.com if needed.'],
      ['email with plus tag', 'I used j.doe+work@corp.co.in for this.'],
    ])('%s', (_label, text) => {
      expect(codes(text)).toContain('POSSIBLE_EMAIL');
    });

    it.each([
      ['Indian mobile with country code', 'Call +91 98765 43210 after 6pm.'],
      ['bare 10-digit mobile', 'My number is 9876543210.'],
      ['US format', 'Office line (555) 123-4567 ext 2.'],
      ['dashed number', 'Use 020-2612-3456 for the front desk.'],
      ['Aadhaar-style 12 digits', 'The form had 1234 5678 9012 on it.'],
    ])('%s', (_label, text) => {
      expect(codes(text)).toContain('POSSIBLE_PHONE_NUMBER');
    });

    it.each([
      ['handle at start', '@rahul_k posted the screenshot.'],
      ['handle mid-sentence', 'It was shared by @devops_lead in Slack.'],
    ])('%s', (_label, text) => {
      expect(codes(text)).toContain('POSSIBLE_SOCIAL_HANDLE');
    });

    it.each([
      ['labelled employee id', 'For reference, employee id: 45219.'],
      ['labelled roll number', 'Roll no 21 in section B saw it.'],
      ['badge number', 'Badge #A-7731 was used at the gate.'],
      ['prefixed employee code', 'Logged in as EMP204518 when it happened.'],
      ['university register number', 'Register number is RA2111003010123.'],
    ])('%s', (_label, text) => {
      expect(codes(text)).toContain('POSSIBLE_PERSONAL_ID');
    });

    it.each([
      ['name', 'My name is Arjun and I work on the night shift.'],
      ['contact offer', 'You can reach me in the second-floor lab.'],
    ])('%s', (_label, text) => {
      expect(codes(text)).toContain('POSSIBLE_SELF_IDENTIFICATION');
    });

    it('reports each kind of finding once, however many matches there are', () => {
      const result = codes('a@example.com and b@example.com and c@example.com');
      expect(result).toEqual(['POSSIBLE_EMAIL']);
    });

    it('reports several kinds together', () => {
      const result = codes('My name is Sam, email sam@example.com, phone 9876543210, @samk');
      expect(result).toEqual([
        'POSSIBLE_EMAIL',
        'POSSIBLE_PHONE_NUMBER',
        'POSSIBLE_SOCIAL_HANDLE',
        'POSSIBLE_SELF_IDENTIFICATION',
      ]);
    });
  });

  describe('does not flag ordinary report text (false positives)', () => {
    it.each([
      ['ISO dates', 'It started on 2026-09-21 and continued until 2026-10-02.'],
      ['years', 'This has happened every quarter in 2024, 2025 and 2026.'],
      ['times', 'Between 14:30 and 16:45 the door was left open.'],
      ['software versions', 'The server runs nginx 1.24.0 and OpenSSL 3.0.13.'],
      ['IP-like addresses', 'The admin panel at 10.0.12.4 has no password.'],
      ['money', 'Roughly ₹5,00,000 or $12,500.00 was moved without approval.'],
      ['CVE identifiers', 'The VPN is still vulnerable to CVE-2024-3094.'],
      ['standards', 'This breaks ISO 27001 and ISO27001 controls.'],
      ['ports and counts', 'Port 8080 is open on 300 machines across 12 floors.'],
      ['the @ inside an email is not a handle', 'Write to ethics@example.org about it.'],
      ['empty input', ''],
    ])('%s', (_label, text) => {
      const result = codes(text);
      // The email example is expected to be flagged as an email — but only that.
      if (text.includes('ethics@')) {
        expect(result).toEqual(['POSSIBLE_EMAIL']);
      } else {
        expect(result).toEqual([]);
      }
    });

    it('accepts non-string input without throwing', () => {
      expect(scanForPii(undefined)).toEqual([]);
      expect(scanForPii(null)).toEqual([]);
      expect(scanForPii(42)).toEqual([]);
    });
  });

  describe('known, accepted false positives', () => {
    // We deliberately over-warn: a needless warning costs the reporter a
    // second of reading, a missed phone number can cost them their anonymity.
    it('flags a 10-digit invoice number as a possible phone number', () => {
      expect(codes('Invoice 4400012345 was paid twice.')).toEqual(['POSSIBLE_PHONE_NUMBER']);
    });

    it('flags a long ticket key as a possible personal ID', () => {
      expect(codes('See ticket INC0012345 for history.')).toEqual(['POSSIBLE_PERSONAL_ID']);
    });
  });

  describe('privacy of the scanner itself', () => {
    it('never echoes the matched text back', () => {
      const secretBits = ['priya.sharma@example.com', '9876543210', '@rahul_k', 'EMP204518', 'Arjun'];
      const text = `My name is Arjun. priya.sharma@example.com 9876543210 @rahul_k EMP204518`;
      const serialised = JSON.stringify(scanForPii(text));

      for (const bit of secretBits) expect(serialised).not.toContain(bit);
    });

    it('exposes a stable list of warning codes', () => {
      expect(PII_WARNING_CODES).toEqual([
        'POSSIBLE_EMAIL',
        'POSSIBLE_PHONE_NUMBER',
        'POSSIBLE_SOCIAL_HANDLE',
        'POSSIBLE_PERSONAL_ID',
        'POSSIBLE_SELF_IDENTIFICATION',
      ]);
    });
  });
});
