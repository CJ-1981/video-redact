/**
 * capability.js — REQ-002/003/004 (design.md §3).
 *
 * Secure-context detection, decode/encode capability probes, and the
 * capability-report guidance model (the "honesty moment" rendered in
 * #cap-report before analyze is offered).
 *
 * Seams (so unit tests never touch the real browser stack):
 *  - mediabunny is reached ONLY by duck-typing the injected `input`
 *    (`getPrimaryVideoTrack()`, `getAudioTracks()`, `track.canDecode()`,
 *    `track.computePacketStats()`, `track.displayWidth/Height`) — no import
 *    of mediabunny anywhere in this module (it is CDN-pinned in index.html
 *    and not installed as a node dependency, so a static import would break
 *    node/vitest resolution);
 *  - WebCodecs is reached through `globalThis.VideoEncoder` or the
 *    `opts.videoEncoder` param (only the static `isConfigSupported` is used);
 *  - the engine sniff reads `opts.userAgent`, falling back to
 *    `globalThis.navigator.userAgent`.
 *
 * `engine` values follow src/types.js `CapabilityReport.engine`:
 * 'webkit' | 'chromium'. The documented union also allows 'gecko'/'unknown';
 * for v1 every non-WebKit engine collapses into the chromium branch
 * (acceptance.md §5: Safari/Firefox are covered by capability-gate
 * messaging, not full support), and `epPolicy` carries the ADR-5 decision
 * directly: webkit → 'wasm', else 'webgpu'.
 *
 * Depends on: mediabunny (duck-typed), WebCodecs (globalThis seam).
 */
import './types.js';

/**
 * Copy-paste serve commands for the REQ-004 gate (AC-01): shown verbatim in
 * #serve-gate and echoed by `guidance()` when the report is insecure.
 */
const SERVE_INSTRUCTIONS = Object.freeze([
  'python3 -m http.server 8000',
  'npx serve',
]);

/**
 * H.264 level ladder for the avc encode probe (ADR-7 / design §4.8: level
 * must match resolution, e.g. 4K → 5.1). Walked low → high; the first rung
 * `VideoEncoder.isConfigSupported` accepts wins, so the probe reports the
 * minimum viable level.
 */
const AVC_LEVEL_LADDER = Object.freeze([
  { level: '4.2', codec: 'avc1.64002A' },
  { level: '5.0', codec: 'avc1.640032' },
  { level: '5.1', codec: 'avc1.640033' },
  { level: '5.2', codec: 'avc1.640034' },
]);

/** WebCodecs VP9 profile-0 8-bit string (the ADR-7 WebM fallback target). */
const VP9_CODEC = 'vp09.00.10.08';

// @MX:NOTE HEVC sources report codec strings 'hvc1'/'hev1' (never 'hevc') in containers — drives REQ-003 guidance; Chrome decodes HEVC hardware-only.
/** Codec strings that mean "HEVC source" for the REQ-003 guidance branch. */
const HEVC_CODEC_ALIASES = new Set(['hevc', 'hvc1', 'hev1']);

/** ≥ this many pixels counts as 4K for the large-file advisory. */
const FOUR_K_PIXELS = 8_000_000; // 3840×2160 = 8,294,400

/**
 * Report whether the page runs in a secure context, with the serve-gate
 * details when it does not (REQ-004).
 *
 * @returns {{secure: boolean, protocol: string, instructions: string[]}}
 *     `instructions` holds the copy-paste serve commands shown in #serve-gate
 *     (e.g. `python3 -m http.server 8000`, `npx serve`); empty when secure.
 */
export function secureContextInfo() {
  const secure = globalThis.isSecureContext === true;
  const protocol = globalThis.location?.protocol ?? 'unknown';
  return {
    secure,
    protocol,
    instructions: secure ? [] : [...SERVE_INSTRUCTIONS],
  };
}

/**
 * Classify a user-agent string into the ADR-5 engine categories: 'webkit'
 * when the UA is WebKit-based and NOT Chromium-based (Chrome/Edge also ship
 * AppleWebKit tokens), else 'chromium'.
 *
 * @param {string=} userAgent
 * @returns {'webkit'|'chromium'}
 */
export function sniffEngine(userAgent) {
  const ua = String(userAgent ?? '');
  const chromiumBased = /Chrome|Chromium|Edg\//.test(ua);
  const webkitBased = /AppleWebKit/.test(ua);
  return webkitBased && !chromiumBased ? 'webkit' : 'chromium';
}

/**
 * Average frame rate from a mediabunny track's packet stats; 0 when unknown.
 *
 * @param {{computePacketStats?: () => Promise<{averagePacketRate?: number}>}} track
 * @returns {Promise<number>} Frames per second, or 0 when undeterminable.
 */
async function trackFps(track) {
  try {
    if (typeof track.computePacketStats === 'function') {
      const stats = await track.computePacketStats();
      const rate = Number(stats?.averagePacketRate);
      if (Number.isFinite(rate) && rate > 0) return rate;
    }
  } catch {
    // Packet stats are best-effort; the report degrades to "fps unknown".
  }
  return 0;
}

/** `30` → "30fps"; 0/NaN → "fps unknown" (kept out of the numeric slot). */
function fmtFps(fps) {
  return fps > 0 ? `${Math.round(fps * 100) / 100}fps` : 'fps unknown';
}

/**
 * Rough bitrate hint for the encoder probe config. Real export bitrate
 * selection lives in exporter.js; this just makes isConfigSupported realistic.
 */
function estimateBitrate(width, height, fps) {
  return Math.min(120_000_000, Math.max(1_000_000, Math.round(width * height * (fps > 0 ? fps : 30) * 0.1)));
}

/** Build a WebCodecs VideoEncoderConfig-shaped object for probing. */
function encodeConfig(codec, width, height, fps) {
  return { codec, width, height, framerate: fps > 0 ? fps : 30, bitrate: estimateBitrate(width, height, fps) };
}

/**
 * Probe decode capability for every video/audio track of the opened input
 * (mediabunny `track.canDecode()`) and encode capability for the export
 * target (WebCodecs `VideoEncoder.isConfigSupported` avc level ladder +
 * vp9 fallback, ADR-7). Produces the report displayed in #cap-report before
 * analyze is offered.
 *
 * Probe entries are `{kind, ok, codec?, width?, height?, detail}` with
 * `kind ∈ {'video-decode','audio-decode','video-encode-avc',
 * 'video-encode-vp9'}`.
 *
 * @param {object} input Mediabunny `Input` opened by ingest.openInput()
 *     (duck-typed; never imported here).
 * @param {{userAgent?: string, videoEncoder?: {isConfigSupported: Function}}=} opts
 *     Test seams: explicit UA override and WebCodecs encoder override.
 * @returns {Promise<import('./types.js').CapabilityReport>}
 */
export async function probeCapabilities(input, opts = {}) {
  const { secure: secureContext, protocol } = secureContextInfo();
  const engine = sniffEngine(opts.userAgent ?? globalThis.navigator?.userAgent ?? '');
  const epPolicy = engine === 'webkit' ? 'wasm' : 'webgpu';
  const encoder = opts.videoEncoder ?? globalThis.VideoEncoder ?? null;

  /** @type {import('./types.js').CapabilityReport['probes']} */
  const probes = [];
  /** @type {string[]} */
  const warnings = [];

  // --- Decode probes (REQ-002) -------------------------------------------
  const videoTrack = (await input?.getPrimaryVideoTrack?.()) ?? null;
  let width = 0;
  let height = 0;
  let fps = 0;

  if (videoTrack) {
    const codec = String(videoTrack.codec ?? 'unknown');
    let ok = false;
    try {
      ok = (await videoTrack.canDecode?.()) === true;
    } catch {
      ok = false; // canDecode() rejection == "cannot decode here".
    }
    width = Number(videoTrack.displayWidth ?? videoTrack.codedWidth ?? 0);
    height = Number(videoTrack.displayHeight ?? videoTrack.codedHeight ?? 0);
    fps = await trackFps(videoTrack);

    probes.push({
      kind: 'video-decode',
      ok,
      codec,
      width,
      height,
      detail: `${codec} ${width}x${height} @ ${fmtFps(fps)} — ${ok ? 'decodable' : 'NOT decodable in this browser'}`,
    });
    if (!ok && HEVC_CODEC_ALIASES.has(codec)) {
      warnings.push('HEVC decode is hardware-gated in Chromium (no software fallback); Safari 17.4+ decodes HEVC via WebCodecs.');
    }
  }

  const audioTracks = (await input?.getAudioTracks?.()) ?? [];
  for (const audioTrack of audioTracks) {
    const codec = String(audioTrack.codec ?? 'unknown');
    let ok = false;
    try {
      ok = (await audioTrack.canDecode?.()) === true;
    } catch {
      ok = false;
    }
    probes.push({
      kind: 'audio-decode',
      ok,
      codec,
      detail: `${codec} — ${ok ? 'decodable' : 'NOT decodable in this browser'}`,
    });
  }

  // --- Encode probes (ADR-7 ladder) --------------------------------------
  if (videoTrack && width > 0 && height > 0) {
    if (encoder && typeof encoder.isConfigSupported === 'function') {
      let avcHit = null;
      for (const rung of AVC_LEVEL_LADDER) {
        try {
          const res = await encoder.isConfigSupported(encodeConfig(rung.codec, width, height, fps));
          if (res?.supported === true) {
            avcHit = rung;
            break;
          }
        } catch {
          // A rejecting/broken encoder answer moves the probe to the next rung.
        }
      }
      probes.push({
        kind: 'video-encode-avc',
        ok: avcHit !== null,
        codec: avcHit?.codec ?? 'avc',
        width,
        height,
        detail: avcHit
          ? `avc level ${avcHit.level} (${avcHit.codec}) ${width}x${height}`
          : `avc encode unsupported at ${width}x${height} (tried levels ${AVC_LEVEL_LADDER[0].level}–${AVC_LEVEL_LADDER.at(-1).level})`,
      });

      let vp9Ok = false;
      try {
        const res = await encoder.isConfigSupported(encodeConfig(VP9_CODEC, width, height, fps));
        vp9Ok = res?.supported === true;
      } catch {
        vp9Ok = false;
      }
      probes.push({
        kind: 'video-encode-vp9',
        ok: vp9Ok,
        codec: VP9_CODEC,
        width,
        height,
        detail: vp9Ok
          ? `vp9 (${VP9_CODEC}) ${width}x${height}`
          : `vp9 encode unsupported at ${width}x${height}`,
      });
    } else {
      for (const kind of /** @type {['video-encode-avc', 'video-encode-vp9']} */ (['video-encode-avc', 'video-encode-vp9'])) {
        probes.push({
          kind,
          ok: false,
          codec: kind === 'video-encode-avc' ? 'avc' : VP9_CODEC,
          width,
          height,
          detail: 'WebCodecs VideoEncoder unavailable',
        });
      }
    }
  }

  const canAnalyze = probes.some((p) => p.kind === 'video-decode' && p.ok);
  const canExport = probes.some(
    (p) => (p.kind === 'video-encode-avc' || p.kind === 'video-encode-vp9') && p.ok,
  );

  return { secureContext, protocol, engine, epPolicy, probes, canAnalyze, canExport, warnings };
}

/**
 * Turn a capability report into actionable guidance (REQ-003): which steps
 * are blocked (analyze/export) and the human advice lines — e.g. "use a
 * browser with hardware HEVC decode" or "re-record with iPhone Camera →
 * Formats → 'Most Compatible'".
 *
 * @param {import('./types.js').CapabilityReport} report
 * @returns {{canAnalyze: boolean, canExport: boolean, messages: string[]}}
 */
export function guidance(report) {
  const probes = report?.probes ?? [];
  const video = probes.find((p) => p.kind === 'video-decode') ?? null;
  const canAnalyze = video?.ok === true;
  const encodeProbes = probes.filter(
    (p) => p.kind === 'video-encode-avc' || p.kind === 'video-encode-vp9',
  );
  const canExport = encodeProbes.some((p) => p.ok);
  const avcOk = encodeProbes.some((p) => p.kind === 'video-encode-avc' && p.ok);
  const vp9Ok = encodeProbes.some((p) => p.kind === 'video-encode-vp9' && p.ok);

  /** @type {string[]} */
  const messages = [];

  if (report?.secureContext === false) {
    messages.push(
      `This page is not in a secure context (${report?.protocol ?? 'unknown protocol'}) — processing is disabled until served over http://localhost or HTTPS (e.g. \`${SERVE_INSTRUCTIONS[0]}\` or \`${SERVE_INSTRUCTIONS[1]}\`).`,
    );
  }

  const videoCodec = String(video?.codec ?? '');
  if (video && !video.ok && HEVC_CODEC_ALIASES.has(videoCodec)) {
    messages.push(
      'HEVC (H.265) cannot be decoded in this browser: use Chrome or Edge with hardware HEVC support (modern GPU), or Safari 17.4+.',
    );
    messages.push(
      'Alternatively, re-record the source on iPhone: Settings → Camera → Formats → "Most Compatible" (records H.264).',
    );
  } else if (video && !video.ok) {
    messages.push(
      `The video codec "${videoCodec || 'unknown'}" cannot be decoded in this browser — processing of this file is blocked.`,
    );
  }

  if (canExport && !avcOk && vp9Ok) {
    messages.push(
      'H.264 encoding is unavailable at this resolution — export will use the VP9/WebM fallback (larger files).',
    );
  }
  if (avcOk && (Number(video?.width ?? 0) * Number(video?.height ?? 0)) >= FOUR_K_PIXELS) {
    messages.push(
      '4K source with H.264 encode available — export produces a large file streamed to disk; keep this tab focused during export.',
    );
  }
  if (!canExport && canAnalyze) {
    messages.push('No viable encode target in this browser — export is unavailable.');
  }

  return { canAnalyze, canExport, messages };
}
