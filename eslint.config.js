/**
 * ESLint flat config — hygiene only (T-702): js.configs.recommended plus
 * no-unused-vars, with browser + node globals for no-undef. NO stylistic or
 * formatting rules (the project has no formatter; diffs stay minimal).
 */
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    // `.claude`/`.agents`/`.zcode`/`.moai` are MoAI-scaffold scripts (node
    // runtime, managed upstream) — not project code; excluded from every lint
    // surface including the pre-commit hook's repo-wide eslint pass.
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'tests/**',
      '.claude/**',
      '.agents/**',
      '.zcode/**',
      '.moai/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'tools/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': 'error',
    },
  },
];
