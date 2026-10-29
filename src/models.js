/**
 * models.js — REQ-011 (design.md §3, §5).
 *
 * Model registry (pinned URLs, versions, licenses — shown in the UI per
 * license-notice requirements), fetch-with-progress, and the IndexedDB
 * byte cache. Cache key is `${name}@${version}`; value is the raw
 * ArrayBuffer. `navigator.storage.persist()` is requested after the first
 * successful analyze (design §5) — by the caller, NOT here. @MX:WARN
 * cache-key versioning: bumping a version string invalidates old cache
 * entries by design — never reuse a version for different bytes.
 *
 * Cache-first invariant (AC-10): `ensureModel` hits IndexedDB before the
 * network; once a model is cached, later calls resolve with zero network
 * traffic (verified by tests that make `fetch` throw).
 *
 * Test/embedding seams: `setModelDeps` / `resetModelDeps` override the
 * IndexedDB factory and `fetch` implementation (unit tests inject
 * fake-indexeddb and stubbed fetch; production resolves the globals).
 *
 * Depends on: IndexedDB, fetch.
 */

/**
 * Typed model failure. `code` distinguishes the failure families the UI
 * maps to recovery actions (retry download, check connection, …).
 *
 * @extends Error
 */
export class ModelError extends Error {
  /**
   * @param {'unknown-model'|'network'|'idb'} code
   * @param {string} message
   * @param {{cause?: unknown}} [opts]
   */
  constructor(code, message, opts) {
    super(message, opts);
    this.name = 'ModelError';
    this.code = code;
  }
}

/**
 * Pinned model registry (plan.md §B). Names are the `name` half of the
 * `${name}@${version}` cache keys consumed by detector.js / ensureModel.
 * `sha256` is null for every entry: neither upstream (Hugging Face resolve
 * endpoint, GitHub release asset) publishes an integrity hash, so the
 * pinned byte size is the only integrity gate we have (warn on mismatch).
 * @type {Record<string, {
 *   name: string, url: string, version: string, bytes: number,
 *   license: string, source: string, sha256: string | null
 * }>}
 */
export const MODELS = {
  yunet: {
    name: 'yunet',
    // YuNet 2023mar face detection — 232,589 B.
    url: 'https://huggingface.co/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx',
    version: '2023mar',
    bytes: 232589,
    license: 'MIT',
    source: 'https://huggingface.co/opencv/face_detection_yunet',
    // No upstream hash published (research.md §2.3) — sha256 unknown.
    sha256: null,
  },
  'plate-yolov9t': {
    name: 'plate-yolov9t',
    // YOLOv9-t 640 end-to-end license-plate detection — 7,835,770 B.
    // @MX:NOTE HF-mirror on purpose: github.com/release-assets sends NO
    // `access-control-allow-origin` on any redirect hop, so a browser fetch()
    // can never read the canonical asset — never repoint this at github.com.
    // URL is the Hugging Face mirror of the upstream GitHub RELEASE asset:
    // github.com/release-assets send NO `access-control-allow-origin` on any
    // redirect hop (verified 2025-10), so a browser fetch() can never read
    // the asset from the canonical URL. The mirror serves the same bytes
    // (size-pinned below) with CORS `*` on every hop; final host
    // us.aws.cdn.hf.co is covered by the connect-src `*.hf.co` entry.
    url: 'https://huggingface.co/wide-video/open-image-models-v0.5.1/resolve/main/yolo-v9-t-640-license-plates-end2end.onnx',
    version: 'open-image-models-asset',
    bytes: 7835770,
    license: 'MIT (repo; per-weights license unverified — plan R6)',
    source: 'https://github.com/ankandrew/open-image-models',
    // No upstream hash published (research.md §2.3) — sha256 unknown.
    sha256: null,
  },
};

/** IndexedDB database backing the model byte cache (design.md §5). */
export const MODEL_DB_NAME = 'video-redact-models';

/** Object store inside MODEL_DB_NAME holding the cached ArrayBuffers. */
export const MODEL_STORE = 'models';

/**
 * The M1 cache-key shape: `${name}@${version}`.
 * @param {string} name Registry key in MODELS.
 * @returns {string}
 */
export function modelCacheKey(name) {
  const model = MODELS[name];
  return `${model.name}@${model.version}`;
}

// ---------------------------------------------------------------------------
// Dependency seams (tests inject fake-indexeddb + a stubbed fetch).
// ---------------------------------------------------------------------------

/** @type {IDBFactory | null} */
let idbFactoryOverride = null;

/** @type {typeof fetch | null} */
let fetchOverride = null;

/**
 * Override the model loader's environment dependencies. Undefined fields
 * are left untouched. Production code never calls this.
 * @param {{indexedDB?: IDBFactory, fetch?: typeof fetch}} [deps]
 */
export function setModelDeps(deps = {}) {
  if (deps.indexedDB !== undefined) idbFactoryOverride = deps.indexedDB;
  if (deps.fetch !== undefined) fetchOverride = deps.fetch;
}

/**
 * Restore global `indexedDB` / `fetch` resolution and drop all in-flight
 * bookkeeping (in-flight downloads, progress listeners).
 */
export function resetModelDeps() {
  idbFactoryOverride = null;
  fetchOverride = null;
  inflight.clear();
  progressListeners.clear();
}

/** @returns {IDBFactory | null} */
function idbFactory() {
  return idbFactoryOverride ?? globalThis.indexedDB ?? null;
}

/** @param {string} url @returns {Promise<Response>} */
function doFetch(url) {
  const impl = fetchOverride ?? globalThis.fetch.bind(globalThis);
  return impl(url);
}

// ---------------------------------------------------------------------------
// IndexedDB cache layer (db `video-redact-models`, store `models`).
// ---------------------------------------------------------------------------

/** @type {WeakMap<IDBFactory, Promise<IDBDatabase>>} */
const dbPromises = new WeakMap();

/** Open (and memoize per-factory) the model cache database. */
function openCacheDb() {
  const factory = idbFactory();
  if (!factory) {
    return Promise.reject(new ModelError('idb', 'IndexedDB is unavailable'));
  }
  let opening = dbPromises.get(factory);
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const req = factory.open(MODEL_DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(MODEL_STORE)) {
          req.result.createObjectStore(MODEL_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () =>
        reject(new ModelError('idb', `Failed to open "${MODEL_DB_NAME}"`, { cause: req.error }));
    });
    // Never memoize a failed open — the next call must be able to retry.
    opening.catch(() => dbPromises.delete(factory));
    dbPromises.set(factory, opening);
  }
  return opening;
}

/**
 * @param {IDBDatabase} db
 * @param {string} key
 * @returns {Promise<ArrayBuffer | null>} Stored bytes, or null on miss
 *     (a non-ArrayBuffer value is treated as a miss and re-downloaded).
 */
function cacheGet(db, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(MODEL_STORE, 'readonly').objectStore(MODEL_STORE).get(key);
    req.onsuccess = () => resolve(req.result instanceof ArrayBuffer ? req.result : null);
    req.onerror = () =>
      reject(new ModelError('idb', `Cache read failed for "${key}"`, { cause: req.error }));
  });
}

/**
 * @param {IDBDatabase} db
 * @param {string} key
 * @param {ArrayBuffer} bytes
 * @returns {Promise<void>}
 */
function cachePut(db, key, bytes) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MODEL_STORE, 'readwrite');
    tx.objectStore(MODEL_STORE).put(bytes, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(new ModelError('idb', `Cache write failed for "${key}"`, { cause: tx.error }));
    tx.onabort = () =>
      reject(new ModelError('idb', `Cache write aborted for "${key}"`, { cause: tx.error }));
  });
}

/**
 * Remove cached model bytes: `clearModelCache()` wipes the whole store,
 * `clearModelCache(name)` deletes only `${name}@${version}`.
 *
 * Used by tests and by stale-temp cleanup after export/cancel.
 *
 * @param {string=} name Registry key in MODELS; omit to clear everything.
 * @returns {Promise<void>}
 * @throws {ModelError} 'unknown-model' for an unrecognized name, 'idb' on
 *     storage failure.
 */
export async function clearModelCache(name) {
  if (name !== undefined && !MODELS[name]) {
    throw new ModelError('unknown-model', unknownModelMessage(name));
  }
  const db = await openCacheDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(MODEL_STORE, 'readwrite');
    if (name === undefined) tx.objectStore(MODEL_STORE).clear();
    else tx.objectStore(MODEL_STORE).delete(modelCacheKey(name));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new ModelError('idb', 'Cache clear failed', { cause: tx.error }));
    tx.onabort = () => reject(new ModelError('idb', 'Cache clear aborted', { cause: tx.error }));
  });
}

// ---------------------------------------------------------------------------
// Download with streaming progress.
// ---------------------------------------------------------------------------

/**
 * Per-chunk download progress. `total`/`ratio` are null when the server
 * did not send a usable Content-Length.
 * @typedef {object} ModelProgress
 * @property {number} received  Bytes accumulated so far.
 * @property {number | null} total  Content-Length when known.
 * @property {number | null} ratio  received / total when total is known.
 */

/** @type {Map<string, Promise<ArrayBuffer>>} In-flight downloads per cache key. */
const inflight = new Map();

/** @type {Map<string, Set<((info: ModelProgress) => void)>>} */
const progressListeners = new Map();

/**
 * @param {string} key
 * @param {ModelProgress} info
 */
function emitProgress(key, info) {
  const listeners = progressListeners.get(key);
  if (!listeners) return;
  for (const fn of listeners) {
    try {
      fn(info);
    } catch {
      // A broken progress listener must never fail the download.
    }
  }
}

/**
 * @param {string} name
 * @returns {string}
 */
function unknownModelMessage(name) {
  return `Unknown model "${name}" — known models: ${Object.keys(MODELS).join(', ')}`;
}

/**
 * Concatenate accumulated stream chunks into one ArrayBuffer.
 * @param {Uint8Array[]} chunks
 * @param {number} totalBytes
 * @returns {ArrayBuffer}
 */
function concatChunks(chunks, totalBytes) {
  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

/**
 * Stream `model.url` into memory with per-chunk progress, verify the
 * accumulated length against the pinned registry size (warn only — no
 * upstream hash exists), store, and return the bytes.
 *
 * @param {typeof MODELS[string]} model
 * @param {string} key
 * @returns {Promise<ArrayBuffer>}
 * @throws {ModelError} 'network' on fetch failure or non-2xx response.
 */
async function downloadModel(model, key) {
  let res;
  try {
    res = await doFetch(model.url);
  } catch (err) {
    throw new ModelError('network', `Model download failed: ${model.url}`, { cause: err });
  }
  if (!res.ok) {
    throw new ModelError('network', `Model download failed: HTTP ${res.status} for ${model.url}`);
  }

  const lenHeader = res.headers ? res.headers.get('content-length') : null;
  const total = lenHeader === null || lenHeader === '' ? null : Number(lenHeader);
  const emit = (received) =>
    emitProgress(key, { received, total, ratio: total ? received / total : null });

  let bytes;
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    /** @type {Uint8Array[]} */
    const chunks = [];
    let received = 0;
    emit(0);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      emit(received);
    }
    bytes = concatChunks(chunks, received);
  } else {
    // No streaming body available on this engine: single-shot fallback.
    bytes = await res.arrayBuffer();
    emit(bytes.byteLength);
  }

  if (bytes.byteLength !== model.bytes) {
    // Size is our only integrity gate (no upstream sha256) — surface the
    // anomaly but keep the promise: ORT session creation rejects on truly
    // corrupt bytes upstream of us.
    console.warn(
      `[models] size mismatch for ${key}: registry says ${model.bytes} bytes, ` +
        `downloaded ${bytes.byteLength}` +
        (total != null ? ` (content-length ${total})` : '') +
        ' — caching anyway; inference will fail if the bytes are corrupt.',
    );
  }

  const db = await openCacheDb();
  await cachePut(db, key, bytes);
  return bytes;
}

/** Cache-first load: IndexedDB hit wins, otherwise download + store. */
async function loadOrDownload(model, key) {
  const db = await openCacheDb();
  const cached = await cacheGet(db, key);
  if (cached) return cached;
  return downloadModel(model, key);
}

/**
 * Fetch a model's bytes with download progress, serving repeat calls from
 * the IndexedDB cache (`models` object store, key `${name}@${version}`,
 * value ArrayBuffer — ADR-8).
 *
 * Cache-first (AC-10): a cache hit performs zero network traffic. Concurrent
 * calls for the same model resolve to the SAME in-flight promise and dedupe
 * onto a single download (each caller's `onProgress` receives the shared
 * download's progress); calls for different models download independently.
 *
 * @param {string} name Registry key in MODELS.
 * @param {((info: ModelProgress) => void)=} onProgress Per-chunk progress;
 *     not called on cache hits.
 * @returns {Promise<ArrayBuffer>} Model bytes suitable for
 *     `ort.InferenceSession.create(ArrayBuffer)`. Rejects with ModelError:
 *     'unknown-model' for an unrecognized registry name, 'network' on
 *     download failure with an empty cache, 'idb' on cache open/read/write
 *     failure.
 */
export function ensureModel(name, onProgress) {
  const model = MODELS[name];
  if (!model) return Promise.reject(new ModelError('unknown-model', unknownModelMessage(name)));

  const key = modelCacheKey(name);
  let entry = inflight.get(key);
  if (!entry) {
    entry = loadOrDownload(model, key).finally(() => {
      inflight.delete(key);
      progressListeners.delete(key);
    });
    inflight.set(key, entry);
  }
  if (typeof onProgress === 'function') {
    let listeners = progressListeners.get(key);
    if (!listeners) {
      listeners = new Set();
      progressListeners.set(key, listeners);
    }
    listeners.add(onProgress);
  }
  return entry;
}
