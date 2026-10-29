# SPEC-VID-001 Implementation Review (sync-audit, review-1)

- **Auditor**: Independent sync-auditor (did not author the code; all claims re-verified by execution)
- **Date**: 2026-10-28
- **Changeset**: entire tree uncommitted (`git status`); SPEC `.moai/specs/SPEC-VID-001/`, `src/` (10 modules), `index.html`, `tools/`, `tests/` (11 unit files, 4 E2E spec files), `dist/index.html`
- **Weighting**: Functionality 40% · Security 25% · Craft 20% · Consistency 15%

## 0. Claims re-verified by execution (all reproduced by this audit)

| Claim | Audit result |
|---|---|
| `npm run gate` exit 0 | **CONFIRMED** — re-run by auditor, exit 0 (eslint + tsc + vitest + build) |
| `npx vitest run --coverage` green | **CONFIRMED** — 11 files, **293/293 tests pass**, 1.10 s |
| Coverage ≥ 85% on the 8 logic modules | **CONFIRMED** — see §3.1 table (min 85.5%, analyze.js) |
| `npx playwright test` 5/5 | **CONFIRMED** — 5 passed, 1.3 m (serial, shared context; needs network for CDNs — was available) |
| `dist/index.html` 119.8 KB self-contained | **CONFIRMED** — 119.8 KiB (122,702 bytes); zero `./src/` references (build-time assertion in `tools/inline.mjs:55`), importmap pins preserved (`mediabunny@1.63.0`, `onnxruntime-web@1.31.1`) |

---

## 1. Functionality (40%)

### 1.1 What was proven

- **Unit**: 293/293 across 11 files. The logic core is genuinely well-tested: exporter 100 % lines incl. burn-in, ladder, staging, delivery; tracker 100 % incl. a dedicated `AC-05 (PRIVACY-BLOCKING)` describe block; detector 99.4 % incl. a pinned YuNet decode fixture and the EP ladder; models cache-first invariant tested with `fetch` throwing.
- **E2E (Chromium, real CDNs, real ORT sessions, real WebCodecs encode)**: journey (open → capability report → analyze with dashcam ON → manual box draw → toggle → export → **re-decode of the exported file in-page** with block-variance pixelation assertions + duration/audio checks), AC-10 offline model cache (model CDNs route-aborted, zero requests), AC-19 dist boot (no `/src/` requests, pins load), corrupt-input recovery, dev-shell boot.
- **AC-04 burn-in proof is real**: `journey.spec.js:166-313` re-decodes the exported MP4 with mediabunny inside the page and asserts per-block luminance std inside the (dilated) manual-box region collapses (< 8 mean / < 5 median) while the checkered background stays high-frequency (> 20) and `inside.meanStd < outside.meanStd / 2.5`. This is encoded-pixel evidence, not overlay evidence. Unit side: `exporter.test.js:269-385` pins the exact dilated `drawImage` rects (`[97,47,46,46]` for a 40×40 box at 100,50 → 15 % dilation) with real `redact.js` code and no redact mock.

### 1.2 AC evidence table (AC-01 … AC-19)

Legend: **VERIFIED-BY-TEST** = direct automated evidence incl. the E2E layer · **UNIT-ONLY** = automated unit evidence only (acceptable where the AC itself specifies a simulated probe) · **PARTIAL** = some legs proven, named legs unproven · **UNVERIFIED** = no automated evidence.

| AC | Verdict | Evidence |
|---|---|---|
| AC-01 secure-context gate | **UNIT-ONLY** | `capability.test.js` (`secureContextInfo` file:// → serve commands); `capability.test.js:305` guidance text. The `mountApp` gate wiring (main.js:347-355, blocks all handlers) has **no test** — DOM branch; E2E only asserts the gate is *hidden* on localhost. |
| AC-02 capability report before analyze | **VERIFIED-BY-TEST** | E2E journey step 1 (`journey.spec.js:93-100`): container/codec/resolution rows, `td.cap-ok`, analyze enabled; unit `capability.test.js` avc level ladder, `metaSummaryRows` rotation row. |
| AC-03 analyze progress + cancellation | **UNIT-ONLY** | `analyze.test.js:302-389` (honest per-frame events, ETA, `{cancelled:true}` with finalized partial tracks); `analyze.test.js:439` per-frame yield (P-5 mechanism). E2E never presses Cancel and never asserts fps/ETA mid-run (journey asserts only the terminal status line). |
| AC-04 burn-in **[PRIVACY-BLOCKING]** | **VERIFIED-BY-TEST** (burn-in legs) / **UNIT-ONLY** (auto-detection leg) | Burn-in: E2E re-decode variance proof + unit dilated-rect pinning (§1.1). The *“face detected”* leg has no end-to-end proof — the fixture contains no detectable face patch and the E2E redaction target is the **manual box** (documented decision, see MAJOR-2). Overlay-only redaction is excluded by construction: `drawOverlay` never rasterizes (unit-tested `redact.test.js:368`), preview burns through `pixelateFrame` (editor.js:548), export burns through the same function (exporter.js:172 → redact.js:284). |
| AC-05 no-leak padding **[PRIVACY-BLOCKING]** | **VERIFIED-BY-TEST** (unit, privacy core) | `tracker.test.js:327-411`: 100–200 span with 150–152 dropout → span `[first−5/fps, last+5/fps]`, 101 dense keyframes contiguous on the 1/30 s grid, every instant within ½ frame period of a keyframe, dropout frames interpolate the true linear motion, detected boxes exact. Consumer side: `redact.tracksAt` nearest-keyframe lookup + density-invariant throw (`redact.test.js:197`). The AC's preview frame-stepping (95–205) is not E2E'd; the invariant it checks is. |
| AC-06 toggle keep-visible | **UNIT-ONLY** | `exporter.test.js:337` (disabled track → no pixelation at export), `timeline.test.js:196` (toggle removes from `tracksAt`), E2E journey toggles the manual chip in preview but re-enables before export. The “excluded track visible in output” combination is not E2E-exported. |
| AC-07 manual region | **VERIFIED-BY-TEST** | E2E journey: draw → `Manual #1` chip + row → toggle off/on with safe-green `(visible)` state → **burned into the exported pixels** (variance proof is over the manual box). Unit: `manualTrackFromBox` span clamp, chip render model, `scaleTracksToCanvas` commute proof (`timeline.test.js:292`). |
| AC-08 audio preserved | **VERIFIED-BY-TEST** (codec level) | E2E: `audioTracks ≥ 1` and `audioCodec === 'aac'` (fixture has AAC) + duration ± 0.5 s. Unit: “never configures audio (packet-copy invariant) on both container paths” (`exporter.test.js:527`). Bit-exact packet identity is not asserted — codec-string + duration is the evidence level. |
| AC-09 dashcam tiled pass | **UNIT-ONLY** (mechanism) / **UNVERIFIED** (detection differential) | `tileGrid`/`mergeTiles`/`analyze.test.js:234,290` prove the tiled pass merges into full-frame coords and runs only with dashcam ON. The AC's decisive assertion — small plate detected ON and *not* OFF at unchanged threshold — has **no test**; E2E runs analyze with dashcam ON but tolerates zero detections. See MAJOR-2. Note: `detector.js:384` doc says “4K 16:9 → k = 3” but formula + pinned test give k = 4 (doc bug only). |
| AC-10 model cache offline reuse | **VERIFIED-BY-TEST** | E2E `offline-models.spec.js`: cache warmed through the real app module, **all model hosts route-aborted**, reload → `ensureModel` returns pinned byte sizes and `createDetectors` succeeds with **zero** blocked requests logged. Unit: cache-first with `fetch` throwing. |
| AC-11 undecodable HEVC blocked | **VERIFIED-BY-TEST** (simulated per AC wording) | `capability.test.js:226,268,286`: probe `ok:false` → `canAnalyze:false`, exact guidance lines (hardware HEVC browsers; iPhone “Most Compatible”); `ingest.test.js:296` `undecodable-track` blocks processing. AC explicitly says “simulated capability probe”. |
| AC-12 export fallback ladder | **VERIFIED-BY-TEST** (simulated per AC wording) | `exporter.test.js:438` probe-walk avc→sw→vp9/WebM; `:479` **runtime** failure advances the ladder with fresh staging; `:507` exhaustion → deepest stage + cause, “No output file was delivered”; `:457` empty probe ladder. AC says “simulated encoder error” — satisfied. |
| AC-13 corrupt / zero-detection | **PARTIAL** | Corrupt: E2E `errors.spec.js` (readable toast, no crash, recovery with a good file) + unit ingest taxonomy. Zero-detection: the empty-state paragraph exists and the journey *records* `zero-detection` as an annotation, but no test asserts the empty-state message; also the implemented text (“No tracks yet — run Analyze…”, index.html:486) differs from the AC's “No faces or plates found” (MINOR-8). |
| AC-14 export cancel cleanup + crash recovery | **PARTIAL** | Cancel: `exporter.test.js:601,631,642` (temp removed on cancel/fail/ladder-retry), `discardExportTemp` fully tested. Crash-recovery sweep (`main.js:529-572` OPFS listing + delete toast): **no automated test at any layer** — the only UNVERIFIED acceptance leg. |
| AC-15 portrait rotation | **UNIT-ONLY** (partial) | `ingest.test.js:175` (90° rotation swaps display dims), `metaSummaryRows` rotation annotation; export-space correctness rests on mediabunny `sample.draw` rotation (comment, exporter.js:169) — no portrait E2E. |
| AC-16 WebM/VP9 source | **UNIT-ONLY** | `exporter.test.js:464` forceWebM rung, `:527` no-audio-config invariant on the WebM path. No WebM fixture is exercised E2E (manifest ships only the MP4; `make-fixture.mjs` can produce one but none is committed). |
| AC-17 EP selection + fallback | **UNIT-ONLY** + **clause gap** | `detector.test.js:510-540`: webgpu→wasm retry, override, total failure; `capability.test.js:244` webkit→wasm policy. **The “UI notice of the active provider” clause is unimplemented** — `renderProbeRows` computes `engine`/`epPolicy` (main.js:258-259) but `renderCapReport` (main.js:576-598) never renders them and no fallback notice exists anywhere. See MAJOR-1. |
| AC-18 overlay/timeline sync | **UNIT-ONLY** + partial E2E | Chips/playhead view model, smallest-span hit-test, overlay strokes/labels all unit-tested; E2E asserts chip presence, toggle states and safe-green styling, and seeks via `video.currentTime` (then verifies the redrawn preview). The DOM click-to-seek and rVFC per-frame sync are untested. |
| AC-19 single-file artifact | **VERIFIED-BY-TEST** | E2E smoke runs **against `/dist/index.html`**: boots, no `/src/` requests, both pins served, mediabunny import resolves; unit `scaffold.test.js:19` + build-time assertion in `tools/inline.mjs`. |

### 1.3 Performance gates P-1…P-5

**UNVERIFIED by automated test** (no assertion anywhere measures throughput/memory):
- P-1/P-2 (analyze/export throughput): no measurement harness.
- P-3 (4K correctness/memory discipline): mechanisms exist (single reusable canvas `analyze.js:147`, `sample.close()` in `finally` at `analyze.js:192-196`, reused burn-in canvases `exporter.js:143-150`) and are unit-checked for call shape, but no 4K run was measured.
- P-4 (≤ 40 MB first load, < 3 s interactive): not measured; the journey merely budgets a 300 s timeout for the ~40 MB first download.
- P-5 (Cancel/progress not blocked > 500 ms): per-frame yield mechanism unit-tested (`analyze.test.js:439`), latency not measured.
These are reference-hardware targets; recording them as design-verified-only is acceptable, but the SPEC's acceptance.md lists them as gates — they remain open evidence.

### 1.4 Is the E2E acceptance story honest and sufficient for v1?

**Honest — yes, unambiguously.** The limitation is stated where it matters: `journey.spec.js:5-16` (“auto face/plate detection on synthetic patterns may legitimately find ZERO tracks — no assertion anywhere depends on a specific auto-detected track count”), `make-fixture.mjs` (fixture content spec: detectors are “NOT expected to fire on synthetic patterns”), and the zero-detection outcome is *recorded* as a test annotation rather than hidden. The deterministic assertion was deliberately moved to the manual box, and the burn-in proof re-decodes real output pixels.

**Sufficient for v1 — mostly, with one recorded gap (MAJOR-2).** The auto-detection chain is covered piecewise with pinned fixtures: YuNet decode formula (`detector.test.js` fixture pins exact decode numbers against the documented OpenCV reference), plate row parsing, letterbox inversion, tiling, tracking/padding (AC-05 block), and burn-in composition (AC-04 block) — plus real ORT session creation E2E. What no test proves is the integrated claim “a real detectable face/plate in the video ends up pixelated in the export without human drawing”. The design mitigates the failure mode: the preview is pixel-truthful through the same seam, so a detector that found nothing shows the user an unredacted preview — a silent miss is user-visible, not covert. Verdict: acceptable for a v1 release with MAJOR-2 tracked (add a fixture with a real/synthetic detectable face patch — e.g. a composited stock face photo — and one assertion that an auto track is created and burned).

**Findings (Functionality)**

- **MAJOR-1 — AC-17 “UI notice of the active provider” clause unimplemented.** `src/main.js:255-269` computes `engine`/`epPolicy` in the view model, but `renderCapReport` (`src/main.js:576-598`) renders only summary + probe rows; `epPolicy`/`engine` never reach the DOM, and neither the WebKit→WASM policy nor a webgpu→wasm runtime fallback produces any UI notice (grep for "provider" in `src/` and `index.html`: comments only). AC-17 is met mechanically (unit-tested ladder) but not in its stated UI behavior. Severity: MAJOR (acceptance clause), not security.
- **MAJOR-2 — no end-to-end auto-detection evidence (AC-04 auto leg, AC-09 differential).** No fixture with a detectable face/plate exists; the ON/OFF detection differential of AC-09 and the “face detected → burned in” leg of privacy-blocking AC-04 are unproven at system level (piecewise unit evidence only). Honest and mitigated by the pixel-truthful preview (see §1.4), but it is the largest evidence gap in the suite. Severity: MAJOR.
- **MINOR-1 — AC-14 crash-recovery sweep untested** (`main.js:529-572`); `discardExportTemp` itself is well tested, the OPFS-listing toast flow is not.
- **MINOR-2 — perf gates P-1…P-5 carry no automated evidence** (§1.3).
- **MINOR-3 — AC-13 empty-state wording deviates** from the AC text (“No tracks yet — …” vs “No faces or plates found”), and is only annotated, not asserted, in E2E.
- **MINOR-4 — AC-08 asserts codec+duration, not packet identity** (reasonable E2E level; noted for precision).
- **MINOR-5 — `detector.js:384` doc comment says 4K 16:9 → k = 3; formula and pinned test give k = 4** (doc/behavior mismatch in a geometry function).
- **MINOR-6 — exporter cancel edge:** if cancellation ever throws *inside* the burn-in `process()` callback, the wrapper (`exporter.js:174-182`) classifies it `ExportError(stage)`; the outer catch (`exporter.js:532`) checks `ExportError` before `ConversionCanceledError`/`signal.aborted`, so it would surface as an encode failure rather than 'cancelled'. The UI compensates (`main.js:912` also checks `ctl.signal.aborted`), and temp cleanup still runs. Low-probability, cosmetic misclassification.

---

## 2. Security (25%) — HARD gate

### 2.1 CSP review (index.html:19-20)

`default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://esm.sh; connect-src 'self' https://cdn.jsdelivr.net https://esm.sh https://huggingface.co https://*.hf.co https://cas-bridge.xethub.hf.co https://transfer.xethub.hf.co https://github.com https://objects.githubusercontent.com https://release-assets.githubusercontent.com blob: data:; worker-src blob:; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'unsafe-inline'`

- **`script-src 'unsafe-inline'`** — unavoidable for the single-file artifact (REQ-020: one self-contained `index.html`, no build-time nonce possible since the inline bundle changes every build). Residual risk: any injected inline script executes. Compensating controls verified this audit: **zero** XSS sinks (`innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write`: none in `src/`, `index.html`, `tools/`; all dynamic strings inserted via `textContent`/`createElement`, including filenames — `main.js:663` toast, `main.js:898-903` handle.name, `editor.js:618-649` labels/titles are app-generated “Face #N”/“Manual #N”, never user input); no `eval`/`new Function`; no web storage. No `object-src`/`frame-ancestors`/`form-action` are set (defaults inherit `default-src 'self'` for objects; frame-ancestors has no meta-tag effect) — negligible for a local tool. Verdict: accepted residual, correctly documented in the CSP comment (index.html:9-18).
- **`'wasm-unsafe-eval'`** — required by onnxruntime-web WASM compilation; unlocks WebAssembly.compile only, not JS eval. WASM bytes can only come from script/connect-approved hosts. Accepted.
- **connect-src vs actual fetches** — every runtime fetch enumerated:
  1. `models.js:57,77` → `https://huggingface.co/...` (both model URLs); HF resolve redirects (xethub/`us.aws.cdn.hf.co`) are covered by `*.hf.co` + the two explicit xethub entries — consistent with the `models.js:76` comment.
  2. `ingest.js:37-38` → `cdn.jsdelivr.net` ProRes bundle via dynamic `import()` → script-src ✓.
  3. `detector.js:81` `ORT_WASM_PATHS` → `cdn.jsdelivr.net` → connect-src ✓.
  4. Importmap libs → `cdn.jsdelivr.net` ✓.
  **Allowed but never fetched**: `esm.sh` (script-src + connect-src) and `github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com` (connect-src) — `models.js:69-77` explicitly documents the GitHub release host is unusable from browser fetch (no CORS) and uses the HF mirror instead, making those three entries dead allowlist. **MINOR-7 (over-broad allowlist)**: prune unused hosts; each is an extra pre-approved exfil destination if a CDN dependency ever turns hostile. Also `data:` in connect-src is unexplained (no data: fetch found). No host that *is* fetched is missing.
- **Egress inventory (privacy)**: the only network APIs in shipped code are `fetch` in `models.js` (model registry URLs only) and the two CDN module loads. No `XMLHttpRequest`/`WebSocket`/`sendBeacon`/`EventSource` anywhere. Video bytes flow exclusively: File → BlobSource → decode → canvas → OPFS staging (`exports/redact-export-*`) → picker/download; `media-src blob:` preview URL is local and revoked on file change (`main.js:625`).

### 2.2 Privacy invariants (the redaction invariant, DX level)

- **Single shared seam — CONFIRMED by reading both call sites.** `redact.pixelateFrame` (`src/redact.js:284-288` = `tracksAt` → `dilate(box, 0.15, frameSize)` → `applyPixelation`) is called by the **export burn-in** (`exporter.js:172`, per sample, native display px) and by the **editor preview** (`editor.js:548`, per presented frame, canvas-px scaled tracks; `scaleTracksToCanvas` commutes with dilate+clamp — unit-proven `timeline.test.js:292`). `drawOverlay` is stroke-only and never rasterizes (unit `redact.test.js:368`). No second redaction implementation exists.
- **Preview/export resolution nuance (not a defect):** the preview pixelates at canvas bitmap scale (content box × DPR), so absolute block granularity differs from export; the divergence errs in the safe direction (preview blocks are coarser/larger in native terms when scale < 1). Region identity and enabled-state are exact; noted for the record.
- **Disabled track slipping into export — impossible.** `tracksAt` skips `!track.enabled` (`redact.js:83`); the exporter passes the full review array and burn-in asks only `tracksAt` (unit `exporter.test.js:337`); all tracks are created `enabled: true` (`tracker.js:424`, `editor.js:235`); preview and export read the same `app.tracks` array (single source of truth via `getState`).
- **tracksAt throw invariant honored everywhere.** `nearestBox` throws on an enabled track covering `t` with no keyframes (`redact.js:55`); `pixelateFrame` does not catch; exporter wraps and re-throws as `ExportError(stage)` **without ladder retry** (fail-fast, `exporter.js:174-182`, unit `:363`); editor clears the canvas and re-throws, halting the loop (fail-closed, `editor.js:554-559`); `tracksAtForView` propagates (unit `timeline.test.js:220`).
- **Manual track with zero keyframes — impossible.** The only factories are `manualTrackFromBox` (`editor.js:232`, always ≥ 1 keyframe) and `Tracker.beginManualTrack` (`tracker.js:448`, always 1); there is no track-deletion UI, so no path empties a track's keyframes while its span covers `t`. A single-keyframe manual track spanning 0.5 s resolves every `t` to the drawn box (nearest-keyframe).
- **Persistence audit:** IndexedDB is used **only** in `models.js` (store `models`, keys `${name}@${version}`, values = model ArrayBuffers) — grep confirms no other `indexedDB` reference in `src/`. OPFS holds only export staging temps under `exports/`, deleted on delivery/cancel/failure and swept on startup. No `localStorage`/`sessionStorage`. **No media bytes, tracks, or metadata are ever persisted** beyond the process lifetime except the output the user saves.

**Security verdict: no CRITICAL or HIGH finding.** The HARD gate passes.

**Findings (Security)**: MINOR-7 (over-broad connect-src: `esm.sh`, three github hosts, `data:` — allowed but unused; prune for least privilege).

---

## 3. Craft (20%)

### 3.1 Coverage (auditor-measured, v8, `npx vitest run --coverage`)

| Module | Lines | Branches | ≥85% gate |
|---|---|---|---|
| src/exporter.js | 100.0 % (171/171) | 95/118 | PASS |
| src/tracker.js | 100.0 % (171/171) | 63/66 | PASS |
| src/detector.js | 99.4 % (170/171) | 87/101 | PASS |
| src/capability.js | 96.9 % (94/97) | 105/123 | PASS |
| src/ingest.js | 95.7 % (45/47) | 22/22 | PASS |
| src/models.js | 94.2 % (114/121) | 46/56 | PASS |
| src/redact.js | 92.0 % (80/87) | 41/53 | PASS |
| src/analyze.js | 85.5 % (59/69) | 41/50 | PASS |
| src/editor.js (DOM) | 28.8 % (83/288) | 75/291 | excluded by gate |
| src/main.js (DOM) | 12.6 % (52/413) | 67/402 | excluded by gate |

Aggregate 63.5 % lines is an artifact of including the two DOM shells; the gate as specified (8 logic modules) is met with margin on 7 of 8. **Assessment of the DOM-heavy untested surface:** the split is principled — every pure decision was extracted (`renderTimeline`, `hitTestTimeline`, `toggleTrack`, `manualTrackFromBox`, `scaleTracksToCanvas`, `deriveStep`, formatters, error maps — all tested), leaving `mountEditor`'s frame loop and `mountApp`'s handlers. That residue is exactly where E2E picks up the happy path (journey exercises the loop, chips, toggles, export). **Risk that remains:** the rVFC sync, timeline click-seek, keyboard routing, and the crash-recovery sweep have no automated coverage at any layer (see MINOR-1); a regression there ships silently. Acceptable, but the sweep deserves a test.

### 3.2 Error handling (REQ-021)

- Taxonomies are typed and complete: `ExportError{stage}` (6 stages, `exporter.js:59-71`), `IngestError{code}` (5 codes, `ingest.js:59-71`), `ModelError{code}` (3 codes, `models.js:29-40`).
- `mapExportErrorToMessage` covers every stage with distinct, actionable recovery text incl. explicit “no output file was delivered” phrasing (unit `main-wiring.test.js:148-166`); unknown stages fall back safely. The final all-rungs-failed message embeds the deepest stage and underlying cause.
- “Never a silently corrupted output” is structurally enforced: delivery happens only after `conversion.execute()` resolves; `conversion.isValid` is checked with discarded-track reasons (`exporter.js:500-505`); every failure path removes the staging temp before throwing; I/O failures and the density invariant are classified non-retryable.
- Gap: none material. (MINOR-6 misclassification edge above.)

### 3.3 Dead code / length hotspots

- **Effectively dead production exports** (used only by their own unit tests): `Tracker.beginManualTrack` (`tracker.js:441` — the shipped manual-track path is `editor.manualTrackFromBox`; the divergence is documented at `editor.js:206-210`, but the tracker seam is unused in `src/` outside tests), `tracker.interpolate` export (`tracker.js:268`, internal `interpolateKeyframes` is what runs), `models.clearModelCache` (`models.js:222` — its doc claims use by “stale-temp cleanup after export/cancel”, which does not exist; temp cleanup is OPFS-side in exporter/main). MINOR-9: remove or wire.
- **Function-length hotspots (> 80 lines)**: `runAnalyze` 131 (`analyze.js:104`), `probeCapabilities` 123 (`capability.js:150`), `runExport` 108 (`exporter.js:453`), `createDetectors` 93 (`detector.js:451`), `openInput` 90 (`ingest.js:166`), `startAnalyze` 84 (`main.js:717`). All are linear, heavily commented, and seam-injected; none obscures logic. Borderline-acceptable; `runAnalyze` and `runExport` are the two worth decomposing if touched again.
- `analyze.js:221` reads the private `tracker._order` for live track count (documented in-place) — a `liveTrackCount()` accessor would be cleaner. MINOR-10.

---

## 4. Consistency (15%)

- **Module pattern adherence — high.** Every module opens with a JSDoc contract block (purpose, REQ links, dependencies, invariants); test seams are explicit and uniformly implemented (`setModelDeps`/`resetModelDeps`, `canvasFactory`/`yieldNow`/`now`, `opts.videoEncoder`, `opts.userAgent`, scratch-canvas injection); lazy CDN imports are confined to `createDetectors` (`import('onnxruntime-web')`) and `ensureProresDecoder` (dynamic `import(PRORES_MODULE_URL)`), so the node unit run never touches the network — verified by the 1.1 s unit suite. Pure/DOM split is enforced and documented in editor.js and main.js headers.
- **Naming** — consistent (`tracksAt`, `pixelateFrame`, `ensureModel`, `probeCapabilities`); constants frozen and named (`LADDER`, `STAGING_DIR`); one duplication acknowledged in-code: `STAGING_DIR`/`STAGING_PREFIX` are literal in main.js with a comment explaining why they mirror exporter.js (`main.js:36-41`) — acceptable, a shared constants module would be better.
- **@MX tags — 15 found** (`@MX:ANCHOR` ×5, `@MX:WARN` ×5, `@MX:NOTE` ×5), all in headers/above the governed code, none dangling. Spot-check of 5:
  1. `redact.js:2` ANCHOR “preview and export share this exact code” — true (§2.2).
  2. `redact.js:260` ANCHOR pixelateFrame seam — true, matches both call sites.
  3. `exporter.js:31` WARN “process callback must NOT close the VideoSample” — honored (`exporter.js:171-173`; unit asserts `s1.close` not called).
  4. `analyze.js:193` WARN “sample closed on EVERY exit path” — true (`finally` at `analyze.js:192-196`; unit `analyze.test.js:391`).
  5. `index.html:23` NOTE ort importmap/wasmPaths version coupling — true (both 1.31.1; `scaffold.test.js:43` pins the importmap, `detector.test.js:511` pins wasmPaths).
- **Cross-module contracts hold:** display-space boxes end-to-end (ADR-9) — detector returns display coords (`detector.js:52-61`), tracker/redact/exporter/editor never re-transform; seconds-keyed keyframes throughout; the one deliberate duplication (main.js staging constants) is self-declared.

---

## 5. Findings summary

| # | Severity | Finding | Location |
|---|---|---|---|
| MAJOR-1 | MAJOR | AC-17 “UI notice of the active provider” unimplemented; `engine`/`epPolicy` computed but never rendered; webgpu→wasm fallback is silent | `src/main.js:255-269`, `src/main.js:576-598` |
| MAJOR-2 | MAJOR | No end-to-end auto-detection evidence: AC-04 auto leg + AC-09 ON/OFF differential unproven at system level (no detectable-subject fixture); honest, documented, mitigated by pixel-truthful preview | `tests/e2e/journey.spec.js:5-16`, `tools/make-fixture.mjs` |
| MINOR-1 | MINOR | AC-14 crash-recovery sweep untested at every layer | `src/main.js:529-572` |
| MINOR-2 | MINOR | Perf gates P-1…P-5 have no automated evidence | acceptance.md §4 |
| MINOR-3 | MINOR | AC-13 empty-state wording deviates; zero-detection only annotated, not asserted | `index.html:486`, `journey.spec.js:115` |
| MINOR-4 | MINOR | AC-08 audio verified at codec+duration level, not packet identity | `journey.spec.js:282-287` |
| MINOR-5 | MINOR | Doc comment says 4K → k = 3; formula + test give k = 4 | `src/detector.js:384` |
| MINOR-6 | MINOR | Cancel surfacing inside burn-in `process()` would be misclassified as an encode-stage failure (UI compensates via `signal.aborted`) | `src/exporter.js:174-182`, `:532` |
| MINOR-7 | MINOR | connect-src over-broad: `esm.sh`, `github.com`, `objects-/release-assets.githubusercontent.com`, `data:` allowed but never fetched | `index.html:20` |
| MINOR-8 | MINOR | DOM shell regression risk: rVFC loop, chip-click seek, keyboard routing, serve-gate wiring untested at any layer | `src/editor.js`, `src/main.js` |
| MINOR-9 | MINOR | Dead production exports: `beginManualTrack`, `interpolate`, `clearModelCache` (doc claims a caller that does not exist) | `src/tracker.js:441,268`, `src/models.js:222` |
| MINOR-10 | MINOR | `runAnalyze` reads private `tracker._order`; length hotspots `runAnalyze` 131 / `probeCapabilities` 123 / `runExport` 108 | `src/analyze.js:221,104` |

No CRITICAL findings. No security CONFIRMED-critical/high failure (HARD gate clean).

---

## 6. Verdict rationale

The claimed gates all reproduce: lint/typecheck/293 unit tests/build exit 0; 5/5 E2E including an in-page re-decode of the exported file proving encoded-pixel burn-in; coverage gate met on all 8 logic modules; the shipped artifact is genuinely one self-contained file. The privacy architecture is real, not decorative: a single audited seam (`pixelateFrame`) feeds both preview and export, disabled tracks cannot leak in either direction, the density invariant fails closed at every consumer, and no code path can move video bytes off-device. The failures found are evidence and completeness gaps — an unimplemented UI clause (AC-17), the absence of any auto-detection end-to-end proof (AC-04 leg/AC-09), the untested crash-recovery sweep, and unmeasured perf gates — none of which is a CRITICAL or CONFIRMED-critical/high security failure, and none of which breaks a privacy invariant. Both MAJORs are concrete and actionable (render the provider notice / add a detectable-subject fixture with one auto-track assertion; a focused follow-up, not a rework).

Verdict: PASS
