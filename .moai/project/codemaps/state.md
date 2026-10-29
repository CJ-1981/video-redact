# Codemap: State (main.js stepper state machine)

`main.js` owns the single `AppState` (see `src/types.js`); `deriveStep(step, event)` is the pure reducer (unit-tested in `main-wiring.test.js` — 39 tests, incl. a v1.6.0 group asserting CLEAR from every known step). Unlisted (state, event) pairs are illegal and derive to `null` — the caller ignores them.

## States

`gate → ready → analyzing → review → exporting → done`

| State | Meaning | Stepper view (`stepperModel`) |
| --- | --- | --- |
| `gate` | No file yet / insecure context | current: ① Capability check; done: — |
| `ready` | File opened, capability report shown, Analyze enabled | current: ② Analyze; done: ① |
| `analyzing` | Detection pass running (progress + cancel) | current: ② Analyze; done: ① |
| `review` | Tracks available; preview/timeline/editor active | current: ③ Review; done: ①② |
| `exporting` | Burn-in export running (progress + cancel) | current: ④ Export; done: ①②③ |
| `done` | Output delivered; re-analyze/re-export/new file allowed | current: —; done: ①②③④ |

## Transitions (`STEP_TRANSITIONS`)

```
gate ──FILE_OPENED──▶ ready
ready ──ANALYZE_START──▶ analyzing        ready ──FILE_OPENED──▶ ready (new file)
analyzing ──ANALYZE_FINISH──▶ review      analyzing ──ANALYZE_FAIL──▶ ready
review ──ANALYZE_START──▶ analyzing       (re-analyze, e.g. dashcam/sensitivity changed)
review ──EXPORT_START──▶ exporting        review ──FILE_OPENED──▶ ready
exporting ──EXPORT_DONE──▶ done           exporting ──EXPORT_FAIL──▶ review
done ──ANALYZE_START──▶ analyzing         done ──EXPORT_START──▶ exporting
done ──FILE_OPENED──▶ ready

ANY step ──CLEAR──▶ gate        (v1.6.0: the header ✕ Clear button —
                                 legal from every step; DOM-side clearAll()
                                 owns the teardown: abort in-flight passes,
                                 editor destroy, blob URL + decoder + Input
                                 disposal, OPFS temp sweep, file-input reset)
```

Cancellation convention: analyze cancel is the `ANALYZE_FINISH` success event carrying a cancelled flag (partial tracks kept, AC-03); export cancel surfaces as `EXPORT_FAIL` with a cancelled marker at the callsite. `CLEAR` is independent of both — it aborts them first and lands on `gate`.

## Data shapes (`AppState`, src/types.js)

```ts
{
  step: 'gate'|'ready'|'analyzing'|'review'|'exporting'|'done',
  file: File | null,
  meta: MediaMeta | null,        // ingest.openInput(): container, codec, displayWidth/Height (rotation-applied),
                                 // rotation, fps, duration, audio {codec}|null
  caps: CapabilityReport | null, // capability.probeCapabilities(): secureContext, engine 'chromium'|'webkit',
                                 // epPolicy 'webgpu'|'wasm', probes[], canAnalyze, canExport, warnings[]
  tracks: Track[],               // { id, cls 'face'|'plate'|'manual', label, color,
                                 //   keyframes: Map<seconds, Box> (DENSE over span), start, end,
                                 //   enabled (true = redact), source 'auto'|'manual',
                                 //   style 'pixelate'|'solid' (REQ-101; default pixelate for auto,
                                 //   solid for manual — tracker.finalize sets it) }
  settings: { dashcamMode: boolean, padSeconds: number, quality: 'high'|'balanced',
              confFace?: number, confPlate?: number }   // REQ-113 (v1.5.0): detection confidence
                                 // thresholds from the Analyze-panel sensitivity sliders
                                 // (defaults 0.6 / 0.25 — detector DEFAULT_CONF_FACE/PLATE when omitted);
                                 // reset from DEFAULT_SETTINGS() on mount and on CLEAR (v1.6.0)
}
```

Privacy invariant carried by state: `Track.keyframes` is dense over `[start, end]` after `tracker.finalize()`, so `redact.tracksAt(tracks, t)` resolves a box for every instant of every enabled span — preview and export both ask only `tracksAt(t)` and never re-derive. Manual tracks (REQ-103) satisfy the same invariant with ONE constant keyframe (`keyframes: Map([[0, box]])`) over a full-duration span — `tracksAt`'s nearest-keyframe clamp keeps the box constant at every instant.
