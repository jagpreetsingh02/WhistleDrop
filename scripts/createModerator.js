#!/usr/bin/env node
'use strict';

/**
 * Provisions a moderator account.
 *
 *   npm run create:moderator -- --username alice --password "Str0ngPassphrase!" --name "Ethics Desk"
 *   npm run create:moderator -- --username root --password "…" --role admin
 *
 * The first admin has to be created this way; after that, admins can manage
 * accounts through /api/v1/admin.
 * There is no public sign-up endpoint: accounts for people who can read
 * sensitive reports are created deliberately, by an operator with database
 * access, and never by a stranger hitting an open route.
 */

const { connectDatabase, disconnectDatabase } = require('../src/config/db');
const { createModerator } = require('../src/services/auth.service');
const { ROLES, ROLE } = require('../src/utils/constants');

const MIN_PASSWORD_LENGTH = 12;

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
  const role = String(args.role || process.env.MODERATOR_ROLE || ROLE.MODERATOR).toLowerCase();

  if (!username || !password) {
    console.error(
      'Usage: npm run create:moderator -- --username <username> --password <password> [--name "Display Name"] [--role moderator|admin]'
    );
    process.exit(1);
  }

  if (String(password).length < MIN_PASSWORD_LENGTH) {
    console.error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
    process.exit(1);
  }

  if (!ROLES.includes(role)) {
    console.error(`Role must be one of: ${ROLES.join(', ')}`);
    process.exit(1);
  }

  await connectDatabase();

  try {
    const moderator = await createModerator({ username, password, displayName, role });
    console.log(
      `Account created: ${moderator.username} (${moderator.displayName}), role: ${moderator.role}`
    );
    console.log('Log in at POST /api/v1/auth/login to obtain a JWT.');
  } catch (error) {
    console.error(`Could not create moderator: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await disconnectDatabase();
  }
}

main();
