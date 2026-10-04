'use strict';

const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');

/**
 * ESLint owns correctness, Prettier owns formatting. eslint-config-prettier
 * (last) switches off every stylistic rule that would fight Prettier.
 */
module.exports = [
  { ignores: ['node_modules/', 'coverage/', 'video/', 'renders/', 'screenshots/'] },

  js.configs.recommended,

  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      strict: ['error', 'global'],
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      // Sequential awaits are usually an accident; the deliberate ones say so.
      'no-await-in-loop': 'error',
      // Console output bypasses the logger's "never log request data" rule.
      'no-console': 'error',
      'no-throw-literal': 'error',
      'prefer-promise-reject-errors': 'error',
      'no-return-await': 'off',
    },
  },

  {
    files: ['tests/**/*.js'],
    languageOptions: { globals: { ...globals.jest } },
    // Tests spy on console to assert what is (and is not) logged.
    rules: { 'no-console': 'off' },
  },

  {
    // CLI scripts talk to an operator on the terminal.
    files: ['scripts/**/*.js'],
    rules: { 'no-console': 'off' },
  },

  prettier,
];
