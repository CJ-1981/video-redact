#!/usr/bin/env node
/**
 * Dev-time single-file inliner (ADR-1): bundles ./src/main.js with esbuild and
 * writes ./dist/index.html — the shipped artifact is ONE self-contained file.
 *
 * How it works:
 *  1. esbuild bundles src/main.js (ESM, no minify). The CDN bare specifiers
 *     'mediabunny' and 'onnxruntime-web' are marked external so they survive
 *     as imports and resolve via the dist importmap at runtime.
 *  2. The dev entry tag `<script type="module" src="./src/main.js"></script>`
 *     in index.html is replaced by an inline `<script type="module">` holding
 *     the bundled code (`</script>` inside the code is escaped).
 *  3. The output is asserted to contain no 'src/' module references — if any
 *     survive, the build FAILS loudly (single-file guarantee).
 *
 * Usage: node tools/inline.mjs   (npm run build)
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEV_TAG = '<script type="module" src="./src/main.js"></script>';

// Build-time stamping (v1.0.0 formal semver start): the version comes from
// package.json (single source of truth) and the build date from the current
// UTC calendar date. Injected as esbuild `define` member-expression keys so
// src/main.js's `globalThis.__APP_VERSION__` reads become inline literals in
// the bundle; unbundled dev mode falls back to 'dev' / '' at runtime.
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const APP_VERSION = String(pkg.version ?? 'dev');
const BUILD_DATE = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)

const result = await build({
  entryPoints: [join(ROOT, 'src', 'main.js')],
  bundle: true,
  format: 'esm',
  minify: false,
  write: false,
  // CDN bare specifiers resolve through the importmap embedded in index.html.
  external: ['mediabunny', 'onnxruntime-web'],
  define: {
    'globalThis.__APP_VERSION__': JSON.stringify(APP_VERSION),
    'globalThis.__BUILD_DATE__': JSON.stringify(BUILD_DATE),
  },
  logLevel: 'warning',
});

const bundle = result.outputFiles[0].text;
// esbuild stamps every input module with a '// <path>' comment in non-minified
// bundles (no flag disables them). They are build artifacts, not runtime
// references — strip them so the single-file guarantee below holds verbatim.
// Matches only comment lines that are exactly a JS file path.
const cleaned = bundle.replace(/^\/\/ [\w@./\\-]+\.(?:m|c)?js(?:x)?\s*$/gm, '');
// Inline <script> safety: an unescaped </script> would terminate the tag early.
const inlined = cleaned.replaceAll('</script', '<\\/script');

const indexHtml = readFileSync(join(ROOT, 'index.html'), 'utf8');
if (!indexHtml.includes(DEV_TAG)) {
  console.error(`build failed: dev entry tag not found in index.html\n  expected: ${DEV_TAG}`);
  process.exit(1);
}

let dist = indexHtml.replace(DEV_TAG, () => `<script type="module">\n${inlined}\n</script>`);

// Single-file guarantee: no dev-mode module paths may remain.
const leaked = dist.match(/\.\/src\/|src\/main\.js/g);
if (leaked) {
  console.error(`build failed: dist/index.html still references dev modules (${leaked.length} occurrence(s) of 'src/')`);
  process.exit(1);
}

mkdirSync(join(ROOT, 'dist'), { recursive: true });
const outPath = join(ROOT, 'dist', 'index.html');
writeFileSync(outPath, dist);

const bytes = Buffer.byteLength(dist, 'utf8');
console.log(`dist/index.html written: ${(bytes / 1024).toFixed(1)} KiB (${bytes} bytes)`);
