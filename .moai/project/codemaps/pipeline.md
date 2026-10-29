# Codemap: Pipeline (data flow)

All boxes/coordinates are display-oriented native pixels after ingest (ADR-9). Seconds-keyed time everywhere (ADR-3). No user media bytes ever touch the network — only pinned CDN code/weights.

```
 File (user pick/drop)
   │  never uploaded
   ▼
 ┌──────────────┐  meta: container/codec/res/fps/duration/audio/rotation
 │ ingest.js    │  openInput(file) → { input, meta }   (+ ProRes decoder registration)
 └──────┬───────┘
        ▼
 ┌───────────────┐  CapabilityReport: decode probes (per track) + avc/vp9 encode probes
 │ capability.js │  probeCapabilities(input) → guidance(report)   [blocks or gates before Analyze]
 └──────┬────────┘
        ▼  Analyze (REQ-009 loop, cancellable, per-frame progress)
 ┌────────────────────────────────────────────────────────────────────┐
 │ analyze.js  runAnalyze: VideoSampleSink.samples() presentation    │
 │   order; reusable canvas; faces every frame, plates every 2nd;    │
 │   dashcam mode adds a tiled pass (tileGrid → mergeTiles)          │
 │   ┌──────────────┐   ┌───────────────┐   ┌────────────┐           │
 │   │ detector.js  │   │ detector.js   │   │ tracker.js │           │
 │   │ detectFace   │──▶│ detectPlate   │──▶│ Tracker    │           │
 │   │ (YuNet 640²) │   │ (YOLOv9-t 640²)│  │ update(t)  │           │
 │   └──────┬───────┘   └───────────────┘   └─────┬──────┘           │
 │          │ Detection[] (display space)         │ finalize(pad)    │
 │          │  models.js: ensureModel → ORT       ▼                  │
 │          │  (IndexedDB cache, WebGPU→WASM)   Track[] (dense       │
 │          │                                   keyframes, ±pad span)│
 └──────────┼────────────────────────────────────┼───────────────────┘
            ▼                                    ▼
 ┌────────────────────────────────────────────────────────────────────┐
 │ editor.js + redact.js  REVIEW (pixel-truthful preview)             │
 │   <video> + overlay canvas: pixelateFrame(tracksAt(t)) burn-through│
 │   timeline chips (renderTimeline/hitTestTimeline), toggleTrack,    │
 │   manualTrackFromBox (drawn regions) → Track[] (user-final states) │
 └──────────┬─────────────────────────────────────────────────────────┘
            ▼  Export (REQ-017..019, cancellable, streamed)
 ┌────────────────────────────────────────────────────────────────────┐
 │ exporter.js  runExport: mediabunny Conversion.init({ video:        │
 │   { process } }) — process(sample) = draw + redact.pixelateFrame   │
 │   for tracksAt(t) → BURNED-IN pixels (forces video transcode)      │
 │   audio: no config → packet-copied (AAC→MP4, Opus/Vorbis→WebM)     │
 │   ladder: avc hw → avc software → vp9/WebM (probe + runtime retry) │
 │   output: StreamTarget(chunked) → OPFS staging → save picker /     │
 │   Blob download → temp cleanup (discardExportTemp crash sweep)     │
 └──────────┬─────────────────────────────────────────────────────────┘
            ▼
     Redacted MP4/WebM file (pixelation burned in, original audio)
```

Shared seams: `redact.pixelateFrame` is used by BOTH the review preview and the export process callback (pixel-truthful preview, AC-04). `models.ensureModel` feeds ORT sessions; after first run all weights come from IndexedDB (zero network).
