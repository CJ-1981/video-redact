import { defineConfig } from 'vitest/config';

// Unit tests only: pure logic, node environment (no GPU/browser needed).
// Playwright integration lives in tests/e2e (npm run test:e2e) and is excluded here.
//
// Coverage (plan.md §F: ≥ 85% lines on logic modules, main.js UI wiring
// excluded): `npm run test:coverage` — main.js / editor.js are still MEASURED
// but the 85% gate applies to the logic modules only (DOM-heavy code is
// covered by the Playwright suite, not the node unit run).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
});
