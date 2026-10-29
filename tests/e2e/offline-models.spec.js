/**
 * offline-models.spec.js — AC-10 (model cache offline reuse).
 *
 * Flow: populate the IndexedDB model byte cache with the network ON (through
 * the app's real models.js on the dev shell — same origin, so the SAME
 * IndexedDB the dist artifact reads), then block every URL that WOULD be a
 * model fetch (Hugging Face + GitHub release hosts), reload, and prove that
 * ensureModel + createDetectors resolve purely from cache with ZERO model
 * requests attempted.
 *
 * DIVERGENCE (deliberate): the onnxruntime-web bundle and its .wasm binaries
 * (jsDelivr) are NOT blocked. They are the inference RUNTIME, not model
 * weights — the app never caches them (AC-10's scope is the model byte
 * cache), and the blocked-route assertion is only meaningful for URLs that
 * would be model fetches.
 */
import { test, expect } from './fixtures.js';
import { MODELS } from '../../src/models.js';

/** Globs matching every host a MODEL fetch can touch (pinned registry URLs). */
const MODEL_ROUTE_GLOBS = [
  '**huggingface.co/**',
  '***.hf.co/**',
  '**github.com/**',
  '**objects.githubusercontent.com/**',
  '**release-assets.githubusercontent.com/**',
];

test.setTimeout(240_000);

test('AC-10: cached models load and detectors create with model CDNs blocked', async ({ sharedPage: page }) => {
  // ── 1. Warm the model cache (network ON) via the app's real module ────────
  // The dev shell serves /src/models.js from the same origin, so importing it
  // in the page yields the SAME module instance + IndexedDB the app uses.
  await page.goto('/index.html', { waitUntil: 'load' });
  await page.evaluate(async () => {
    const models = await import('/src/models.js');
    await models.ensureModel('yunet');
    await models.ensureModel('plate-yolov9t');
  });

  // ── 2. Block all model-fetch hosts and reload ──────────────────────────────
  /** @type {string[]} */
  const blockedModelRequests = [];
  for (const glob of MODEL_ROUTE_GLOBS) {
    await page.context().route(glob, (route) => {
      blockedModelRequests.push(route.request().url());
      return route.abort();
    });
  }

  try {
    await page.reload({ waitUntil: 'load' });

    // ── 3. Cache-first load + real ORT session creation, offline for models ──
    const result = await page.evaluate(async () => {
      const models = await import('/src/models.js');
      const detector = await import('/src/detector.js');
      const yunet = await models.ensureModel('yunet');
      const plate = await models.ensureModel('plate-yolov9t');
      const detectors = await detector.createDetectors({ epPolicy: ['wasm'] });
      detectors.close();
      return { yunet: yunet.byteLength, plate: plate.byteLength };
    });

    // Bytes came from the cache intact (pinned registry sizes).
    expect(result.yunet).toBe(MODELS.yunet.bytes);
    expect(result.plate).toBe(MODELS['plate-yolov9t'].bytes);

    // Not a single model fetch was attempted while blocked — a cache miss
    // would have surfaced here as an aborted-request violation AND a
    // rejected ensureModel above.
    expect(
      blockedModelRequests,
      `model CDNs must not be touched once cached (saw: ${blockedModelRequests.join(', ')})`,
    ).toEqual([]);
  } finally {
    await page.context().unroute(MODEL_ROUTE_GLOBS).catch(() => {});
  }
});
