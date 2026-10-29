import { defineConfig } from '@playwright/test';

// E2E/integration (Chromium) against the zero-dependency static server.
// First run requires: npx playwright install chromium
//
// Real network IS used (CDN importmap libraries + ONNX model weights, ~40 MB
// first run — perf gate P-4), so timeouts are generous and runs are strictly
// serial: workers=1 + one shared worker-scoped browser context (see
// tests/e2e/fixtures.js) lets the IndexedDB model cache and the HTTP cache
// carry over between specs (AC-10 offline reuse depends on that ordering).
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000, // per-test default; the analyze journey overrides higher
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8000',
    viewport: { width: 1280, height: 800 },
    actionTimeout: 20_000,
    navigationTimeout: 60_000,
  },
  webServer: {
    command: 'node tools/serve.mjs',
    url: 'http://127.0.0.1:8000',
    reuseExistingServer: true,
  },
});
