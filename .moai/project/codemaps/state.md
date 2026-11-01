# Codemap: State (main.js stepper state machine)

`main.js` owns the single `AppState` (see `src/types.js`); `deriveStep(step, event)` is the pure reducer (unit-tested in `main-wiring.test.js` — incl. a v1.6.0 group asserting CLEAR from every known step and v1.10.0 groups for the ready-carried editor, export-transition groups (ready→EXPORT_START legal since v1.35.0)). Unlisted (state, event) pairs are illegal and derive to `null` — the caller ignores them.

## States

`gate → ready → analyzing → review → exporting → done`

| State | Meaning | Stepper view (`stepperModel`) |
| --- | --- | --- |
| `gate` | No file yet / insecure context | current: ① Capability check; done: — |
| `ready` | File opened, capability report shown, Analyze enabled — since v1.10.0 the review editor is ALREADY mounted here (`mountEditorLive()` → `mountEditorSafe`, 0 tracks): timeline, scrub thumb, manual boxes and Space playback are live pre-analysis | current: ② Analyze; done: ① |
| `analyzing` | Detection pass running (progress + cancel) | current: ② Analyze; done: ① |
| `review` | Tracks available; preview/timeline/editor active | current: ③ Review; done: ①② |
| `exporting` | Burn-in export running (progress + cancel) | current: ④ Export; done: ①②③ |
| `done` | Output delivered; re-analyze/re-export/new file allowed | current: —; done: ①②③④ |

## Transitions (`STEP_TRANSITIONS`)

```
gate ──FILE_OPENED──▶ ready
ready ──ANALYZE_START──▶ analyzing        ready ──FILE_OPENED──▶ ready (new file)
analyzing ──ANALYZE_FINISH──▶ review      analyzing ──ANALYZE_FAIL──▶ ready
                                          (v1.10.0: ANALYZE_FINISH does NOT remount the
                                           editor — it merges tracks via mergeManualTracks
                                           (manual tracks preserved) and editor.refresh()s)
review ──ANALYZE_START──▶ analyzing       (re-analyze, e.g. dashcam/sensitivity changed)
ready ──EXPORT_START──▶ exporting         (v1.35.0: the grey "Export (not analyzed)"
                                          pre-analysis export — manual regions,
                                          watermark and settings only)
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

Keyboard gating over states (v1.9.0/1.10.0, map extended v1.12.0): the doc-level keyboard handler is wired FIRST (before any editor mount, preserved through v1.10.0); `Space` toggles playback at `ready` (a live editor exists) and in review/done, `B` draws a manual box; since v1.12.0 `←`/`→` jump ±5 s (`SEEK_STEP_S`) and `Shift+←/→` frame-step ±1 (review/done-gated), `F` toggles fullscreen/enlarge and `M` mute (REQ-122); `EXPORT_START` is legal from ready since v1.35.0 (the grey pre-analysis export); it stays rejected at `gate`/`analyzing` (`deriveStep` → null). A mount failure at any state surfaces a readable toast while the keyboard stays live (`mountEditorSafe`).

Export settings flow (v1.16.0–v1.17.1, REQ-127): the export panel's resolution select and "Include audio" checkbox are read live at export click (`startExport` reads `els.exportResolution` / `els.exportAudio` / `app.settings.pixelStrength` / `app.trims`). `resetExportChoices()` (resolution → 'full', audio → checked) runs ONLY on file load and Clear — v1.17.1 removed the pre-read reset that made every export run with defaults. Pixel strength lives in `app.settings.pixelStrength` (preview and export share it).

Layout state note (v1.18.0–v1.18.1): the review workspace's `#below-timeline` section (Tracks panel, then Compare-thresholds) is a child of `#stage-column` directly after `#timeline` — not a workspace-grid child — so the panels follow the preview-column width and hold a constant 28px gap (16px margin + 12px column gap) under the timeline no matter how tall the right rail is. Pure DOM/CSS contract, pinned by `tests/unit/mobile-ui.test.js`; no state-machine impact.

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
              confFace?: number, confPlate?: number,
              detectFace?: boolean, detectPlate?: boolean }   // REQ-113 (v1.5.0): detection confidence
                                 // thresholds from the Analyze-panel sensitivity sliders
                                 // (defaults 0.6 / 0.25 — detector DEFAULT_CONF_FACE/PLATE when omitted);
                                 // detectFace/detectPlate (v1.39.0): per-class detector toggles —
                                 // false skips that model entirely (≥1 must stay on, enforceDetectorPair);
                                 // reset from DEFAULT_SETTINGS() on mount and on CLEAR (v1.6.0).
                                 // A SECOND settings record on the mountApp app object holds the
                                 // analyze-pass knobs (v1.12.0/v1.17.0): { minSizePx: 0, downscale: 'full',
                                 // pixelStrength: 'normal' } (REQ-117/120/129) — reset per file load + Clear.
  trims: Array<{id, start, end}>,  // v1.15.0 REQ-125: sorted, non-overlapping trim regions
                                 // (min span 0.1 s via normalizeTrims/addTrim/moveTrimEdge/
                                 // removeTrim); trimsAt(t) gates the preview veil, keptSegments
                                 // (REQ-126) drives the export exclusion, inTrims skips analyze
                                 // frames; nextTrimId + trimMode (✂ toggle) ride alongside; reset
                                 // on file load + Clear; persisted in .vrproj (REQ-130)
}
```

Project pending-state (v1.17.0 REQ-130): a parsed `.vrproj` awaiting its video (`pendingProject`) is set by the 📂 Load project handler, applied the moment a video is open (tracks adopted via `adoptTracks` + `clampTracksToDuration`, settings/trims restored), and cleared by Clear and after applying.

Privacy invariant carried by state: `Track.keyframes` is dense over `[start, end]` after `tracker.finalize()`, so `redact.tracksAt(tracks, t)` resolves a box for every instant of every enabled span — preview and export both ask only `tracksAt(t)` and never re-derive. Manual tracks (REQ-103) satisfy the same invariant with ONE constant keyframe (`keyframes: Map([[0, box]])`) over a full-duration span — `tracksAt`'s nearest-keyframe clamp keeps the box constant at every instant.
