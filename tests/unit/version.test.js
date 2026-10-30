/**
 * version.test.js — formal versioning + footer version badge.
 *
 * Covers the pure formatter (src/main.js formatVersionBadge) and the static
 * wiring that makes the shipped artifact show it:
 *  - package.json carries the release version (single source of truth
 *    for tools/inline.mjs's build-time injection);
 *  - index.html hosts the #app-version badge span in the footer;
 *  - tools/inline.mjs defines the globalThis.* stamp keys esbuild replaces.
 *
 * (The dist stamp itself is asserted end-to-end: the build runs in
 * scaffold.test.js / `npm run build`, and capture-docs + manual grep check
 * the populated badge in the built page.)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { formatVersionBadge } from '../../src/main.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('formatVersionBadge (footer version badge)', () => {
  it('formats a versioned build with its build date', () => {
    expect(formatVersionBadge({ version: '1.0.0', buildDate: '2026-10-29' })).toBe(
      'v1.0.0 · built 2026-10-29',
    );
  });

  it('omits the built suffix when the build date is missing/empty', () => {
    expect(formatVersionBadge({ version: '1.0.0', buildDate: '' })).toBe('v1.0.0');
    expect(formatVersionBadge({ version: '1.1.2', buildDate: null })).toBe('v1.1.2');
    expect(formatVersionBadge({ version: '1.1.2' })).toBe('v1.1.2');
  });

  it('falls back to the dev badge for dev or missing versions', () => {
    expect(formatVersionBadge({ version: 'dev', buildDate: '2026-10-29' })).toBe('dev build (unbuilt)');
    expect(formatVersionBadge({ version: '' })).toBe('dev build (unbuilt)');
    expect(formatVersionBadge({ version: null })).toBe('dev build (unbuilt)');
    expect(formatVersionBadge({})).toBe('dev build (unbuilt)');
    expect(formatVersionBadge()).toBe('dev build (unbuilt)');
  });

  it('ignores surrounding whitespace on either part', () => {
    expect(formatVersionBadge({ version: ' 1.0.0 ', buildDate: ' 2026-10-29 ' })).toBe(
      'v1.0.0 · built 2026-10-29',
    );
    expect(formatVersionBadge({ version: ' dev ' })).toBe('dev build (unbuilt)');
  });
});

describe('v1.10.1 version stamping wiring', () => {
  it('package.json is at the 1.10.1 release version', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.version).toBe('1.10.1');
  });

  it('index.html hosts the #app-version badge in the footer', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    const footer = html.slice(html.indexOf('<footer'));
    expect(footer).toContain('id="app-version"');
  });

  it('tools/inline.mjs injects the version + build-date defines', () => {
    const inline = readFileSync(join(ROOT, 'tools', 'inline.mjs'), 'utf8');
    expect(inline).toContain("'globalThis.__APP_VERSION__'");
    expect(inline).toContain("'globalThis.__BUILD_DATE__'");
    // Version is read from package.json, not hardcoded.
    expect(inline).toContain("join(ROOT, 'package.json')");
  });
});
