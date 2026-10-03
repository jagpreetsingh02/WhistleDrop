'use strict';

module.exports = {
  testEnvironment: 'node',
  // Runs before any module is imported, so config/env.js sees test values.
  setupFiles: ['<rootDir>/tests/setup/env.js'],
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  collectCoverageFrom: ['src/**/*.js', '!src/server.js', '!src/config/swagger.js'],
  testTimeout: 30000,
  verbose: true,
};
