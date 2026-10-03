#!/usr/bin/env node
'use strict';

/**
 * Provisions a moderator account.
 *
 *   npm run create:moderator -- --username alice --password "Str0ngPassphrase!" --name "Ethics Desk"
 *
 * There is no public sign-up endpoint: accounts for people who can read
 * sensitive reports are created deliberately, by an operator with database
 * access, and never by a stranger hitting an open route.
 */

const { connectDatabase, disconnectDatabase } = require('../src/config/db');
const { createModerator } = require('../src/services/auth.service');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith('--')) continue;
    const key = current.slice(2);
    const next = argv[i + 1];
    args[key] = !next || next.startsWith('--') ? true : next;
    if (args[key] !== true) i += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const username = args.username || process.env.MODERATOR_USERNAME;
  const password = args.password || process.env.MODERATOR_PASSWORD;
  const displayName = args.name || process.env.MODERATOR_NAME || username;

  if (!username || !password) {
    console.error(
      'Usage: npm run create:moderator -- --username <username> --password <password> [--name "Display Name"]'
    );
    process.exit(1);
  }

  if (String(password).length < 8) {
    console.error('Password must be at least 8 characters long.');
    process.exit(1);
  }

  await connectDatabase();

  try {
    const moderator = await createModerator({ username, password, displayName });
    console.log(`Moderator created: ${moderator.username} (${moderator.displayName})`);
    console.log('Log in at POST /api/v1/auth/login to obtain a JWT.');
  } catch (error) {
    console.error(`Could not create moderator: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await disconnectDatabase();
  }
}

main();
