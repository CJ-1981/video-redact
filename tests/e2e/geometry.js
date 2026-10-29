/**
 * geometry.js — shared constants for the synthetic E2E fixture (T-701).
 *
 * The SINGLE source of truth for the fixture's on-screen geometry: both
 * tools/make-fixture.mjs (which draws the frames) and tests/e2e/journey.spec.js
 * (which asserts the burn-in against the exported pixels) import from here, so
 * the manual-box assertions are computed from the same numbers the fixture was
 * rendered with. Plain data + pure functions only — no DOM, no Playwright.
 */

/** Frame/timeline shape of tests/fixtures/synthetic.* */
export const FIXTURE = Object.freeze({
  width: 640,
  height: 360,
  fps: 30,
  durationS: 4,
  frames: 120,
  /** Checkerboard cell (px) — the high-frequency background detail that
   *  pixelation must destroy for the variance assertion to separate. */
  checkerCell: 8,
  card: Object.freeze({
    w: 140,
    h: 90,
    yTop: 135,
    x0: -150, // left edge at t=0 (starts off-frame)
    speed: 200, // px per second, left → right
  }),
  /** Burned-in frame counter chip (bottom-left corner). */
  counter: Object.freeze({ x: 8, y: 328, w: 96, h: 26 }),
});

/** Left edge of the white card at time `t` seconds. */
export function cardLeftAt(t) {
  return FIXTURE.card.x0 + FIXTURE.card.speed * t;
}

/** The card's full rect at time `t` seconds (native display px). */
export function cardRectAt(t) {
  return {
    x: cardLeftAt(t),
    y: FIXTURE.card.yTop,
    w: FIXTURE.card.w,
    h: FIXTURE.card.h,
  };
}

/**
 * The manual box the journey draws over the card at MANUAL_BOX_TIME
 * (native display px): covers the card at that instant plus a margin of
 * checkerboard background on every side, so a pixelated region has BOTH
 * flat white blocks AND flattened checker blocks to compare.
 */
export const MANUAL_BOX = Object.freeze({ x: 225, y: 105, w: 210, h: 150 });
export const MANUAL_BOX_TIME = 2.0;

/** Instant within the manual track's span the exported output is decoded at. */
export const VERIFY_TIME = 2.25;

/**
 * Mirror of redact.dilate (factor 0.15, clamped) — the burn-in applies
 * pixelation to the DILATED box, so assertions must use the same geometry.
 * @param {{x: number, y: number, w: number, h: number}} box
 */
export function dilated(box, factor = 0.15, frame = { width: FIXTURE.width, height: FIXTURE.height }) {
  const growX = (box.w * factor) / 2;
  const growY = (box.h * factor) / 2;
  let w = box.w + growX * 2;
  let h = box.h + growY * 2;
  let x = box.x - growX;
  let y = box.y - growY;
  x = Math.max(0, Math.min(x, frame.width - w));
  y = Math.max(0, Math.min(y, frame.height - h));
  return { x, y, w, h };
}

/** The dilated region the burn-in actually pixelates for MANUAL_BOX. */
export const MANUAL_BOX_DILATED = dilated(MANUAL_BOX);

/**
 * applyPixelation block size for the dilated manual box:
 * block = max(12, round(min(boxW, boxH) / 10)) — mirrors redact.js.
 */
export const PIXEL_BLOCK = Math.max(12, Math.round(Math.min(MANUAL_BOX_DILATED.w, MANUAL_BOX_DILATED.h) / 10));

/**
 * Interior sampling window inside the dilated box (inset by 1.5 blocks so
 * edge blocks straddling the pixelation boundary are excluded).
 */
export const INSIDE_REGION = (() => {
  const inset = PIXEL_BLOCK * 1.5;
  const b = MANUAL_BOX_DILATED;
  return {
    x: Math.round(b.x + inset),
    y: Math.round(b.y + inset),
    w: Math.round(b.w - inset * 2),
    h: Math.round(b.h - inset * 2),
  };
})();

/**
 * Background reference window (pure checkerboard + gradient at VERIFY_TIME —
 * clear of the card, the manual box's dilated region, and the frame counter).
 */
export const OUTSIDE_REGION = Object.freeze({ x: 30, y: 40, w: 150, h: 150 });
