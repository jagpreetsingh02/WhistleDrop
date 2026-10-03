#!/usr/bin/env node
'use strict';

/**
 * DEV / DEMO ONLY — fills a database with demo accounts and sample reports.
 *
 *   npm run seed
 *
 * Refuses to run when NODE_ENV=production. Everything is created through the
 * real services, so the data is shaped exactly like production data: hashed
 * case codes, coarsened timestamps, audit-log entries, atomic transitions.
 *
 * Re-running is safe: existing demo accounts are reused, and each run adds a
 * fresh set of sample reports (their case codes are printed, since the
 * plaintext codes cannot be recovered later).
 */

const env = require('../src/config/env');

const DEMO_ADMIN = {
  username: 'demo-admin',
  password: process.env.SEED_ADMIN_PASSWORD || 'Demo-Admin-Passphrase-2026',
  displayName: 'Integrity Office (demo)',
  role: 'admin',
};

const DEMO_MODERATOR = {
  username: 'demo-moderator',
  password: process.env.SEED_MODERATOR_PASSWORD || 'Demo-Moderator-Passphrase-2026',
  displayName: 'Ethics Desk (demo)',
  role: 'moderator',
};

const SAMPLE_REPORTS = [
  {
    category: 'SECURITY',
    description:
      'Production database credentials are committed to a public repository and have not been rotated since March.',
    evidenceUrl: 'https://example.com/evidence/credentials-commit',
    journey: 'resolved',
  },
  {
    category: 'CORRUPTION',
    description:
      'Vendor invoices for the campus fest are approved by the same person who requested the purchase.',
    journey: 'question',
  },
  {
    category: 'HARASSMENT',
    description:
      'A team lead repeatedly shouts at junior members during the weekly stand-up and mocks their work.',
    journey: 'review',
  },
  {
    category: 'TECHNICAL',
    description:
      'The attendance portal accepts any password for accounts created before 2024, including staff accounts.',
    journey: 'submitted',
  },
  {
    category: 'OTHER',
    description: 'Duplicate of an earlier report about the shared admin password in the lab.',
    journey: 'dismissed',
  },
];

async function ensureAccount(authService, account) {
  const Moderator = require('../src/models/Moderator');
  const existing = await Moderator.findOne({ username: account.username });
  return existing || authService.createModerator(account);
}

/** Seeds the connected database and returns what it created. */
async function seed() {
  const authService = require('../src/services/auth.service');
  const reportService = require('../src/services/report.service');

  const admin = await ensureAccount(authService, DEMO_ADMIN);
  const moderator = await ensureAccount(authService, DEMO_MODERATOR);
  const moderatorId = moderator._id;

  const created = [];
  for (const sample of SAMPLE_REPORTS) {
    // Sequential on purpose: keeps the audit log in a readable order.
    // eslint-disable-next-line no-await-in-loop
    const { report, caseCode } = await reportService.createReport(sample);
    const reportId = report._id;
    const step = (fn) => fn({ reportId, moderatorId });

    /* eslint-disable no-await-in-loop */
    switch (sample.journey) {
      case 'resolved':
        await step((a) => reportService.viewReport(a));
        await step((a) =>
          reportService.updateReportStatus({
            ...a,
            nextStatus: 'UNDER_REVIEW',
            message: 'We have opened an investigation and contacted the infrastructure team.',
          })
        );
        await step((a) =>
          reportService.addStatusUpdate({
            ...a,
            message: 'Repo owner identified; rotation scheduled for tonight.',
            visibility: 'INTERNAL',
          })
        );
        await step((a) =>
          reportService.updateReportStatus({
            ...a,
            nextStatus: 'RESOLVED',
            message: 'The exposed credentials were rotated and access logs were reviewed.',
          })
        );
        break;
      case 'question':
        await step((a) => reportService.updateReportStatus({ ...a, nextStatus: 'UNDER_REVIEW' }));
        await step((a) =>
          reportService.addModeratorMessage({
            ...a,
            body: 'Roughly which month did this start? An approximate answer is fine.',
          })
        );
        break;
      case 'review':
        await step((a) => reportService.updateReportStatus({ ...a, nextStatus: 'UNDER_REVIEW' }));
        await step((a) =>
          reportService.addModeratorMessage({
            ...a,
            body: 'Has this happened in other meetings too?',
          })
        );
        await reportService.addReporterMessage({
          caseCode,
          body: 'Yes, in the sprint retros as well, most weeks.',
        });
        break;
      case 'dismissed':
        await step((a) =>
          reportService.updateReportStatus({
            ...a,
            nextStatus: 'DISMISSED',
            message: 'This duplicates an open case, which is being handled.',
          })
        );
        break;
      default:
        break;
    }
    /* eslint-enable no-await-in-loop */

    created.push({ caseCode, category: sample.category, journey: sample.journey });
  }

  return { admin, moderator, reports: created };
}

async function main() {
  if (env.isProduction) {
    console.error(
      'Refusing to seed: NODE_ENV is "production". The seed script is for development and demos only.'
    );
    process.exit(1);
  }

  const { connectDatabase, disconnectDatabase } = require('../src/config/db');
  await connectDatabase();

  try {
    const { reports } = await seed();

    console.log('\nDemo accounts (development only):');
    console.log(`  admin      ${DEMO_ADMIN.username} / ${DEMO_ADMIN.password}`);
    console.log(`  moderator  ${DEMO_MODERATOR.username} / ${DEMO_MODERATOR.password}`);
    console.log('\nSample reports — track them at GET /api/v1/reports/<caseCode>:');
    for (const report of reports) {
      console.log(`  ${report.caseCode}  ${report.category.padEnd(10)}  ${report.journey}`);
    }
    console.log('');
  } catch (error) {
    console.error(`Seeding failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await disconnectDatabase();
  }
}

if (require.main === module) {
  main();
}

module.exports = { seed, DEMO_ADMIN, DEMO_MODERATOR, SAMPLE_REPORTS };
