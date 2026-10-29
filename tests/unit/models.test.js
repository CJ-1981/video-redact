/**
 * Unit tests for src/models.js — REQ-011 / AC-10.
 *
 * Covers the model registry data, the streaming download with progress,
 * the IndexedDB byte cache (`video-redact-models` / `models`, key
 * `${name}@${version}`), the AC-10 cache-first offline invariant, error
 * paths, and in-flight dedupe. The IndexedDB layer is fake-indexeddb and
 * `fetch` is stubbed with ReadableStream bodies — no test touches the
 * network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import {
  MODELS,
  MODEL_DB_NAME,
  MODEL_STORE,
  ModelError,
  modelCacheKey,
  ensureModel,
  clearModelCache,
  setModelDeps,
  resetModelDeps,
} from '../../src/models.js';

const YUNET_BYTES = MODELS.yunet.bytes; // 232,589

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A deterministic Uint8Array of `length` bytes. */
function bytesOf(length, fill = 0xab) {
  const a = new Uint8Array(length);
  a.fill(fill);
  return a;
}

/** Split `buf` into chunks of the given byte sizes (must sum to buf length). */
function chunkify(buf, sizes) {
  const chunks = [];
  let offset = 0;
  for (const size of sizes) {
    chunks.push(buf.subarray(offset, offset + size));
    offset += size;
  }
  if (offset !== buf.length) throw new Error('chunkify sizes must sum to buf length');
  return chunks;
}

/** A real Response whose body streams `chunks`; optional content-length. */
function responseWithChunks(chunks, { status = 200, contentLength } = {}) {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const headers = new Headers();
  if (contentLength !== undefined) headers.set('content-length', String(contentLength));
  return new Response(stream, { status, headers });
}

/** Standard stub: serve `buf` split into a few chunks with a content-length. */
function serveBytes(fetchMock, buf, opts = {}) {
  const sizes = opts.sizes ?? [Math.ceil(buf.length / 3), Math.ceil(buf.length / 3), Math.max(0, buf.length - 2 * Math.ceil(buf.length / 3))];
  const contentLength = 'contentLength' in opts ? opts.contentLength : buf.length;
  fetchMock.mockImplementation((url) => {
    expect(url).toBe(MODELS.yunet.url);
    return responseWithChunks(chunkify(buf, sizes), { status: opts.status, contentLength });
  });
}

/** Raw read of the cache store through the injected fake factory. */
function idbRead(factory, key) {
  return new Promise((resolve, reject) => {
    const rq = factory.open(MODEL_DB_NAME);
    rq.onupgradeneeded = () => {
      if (!rq.result.objectStoreNames.contains(MODEL_STORE)) {
        rq.result.createObjectStore(MODEL_STORE);
      }
    };
    rq.onsuccess = () => {
      const db = rq.result;
      const get = db.transaction(MODEL_STORE, 'readonly').objectStore(MODEL_STORE).get(key);
      get.onsuccess = () => {
        db.close();
        resolve(get.result);
      };
      get.onerror = () => reject(get.error);
    };
    rq.onerror = () => reject(rq.error);
  });
}

/** Raw multi-key write into the cache store through the injected factory. */
function idbWrite(factory, entries) {
  return new Promise((resolve, reject) => {
    const rq = factory.open(MODEL_DB_NAME);
    rq.onupgradeneeded = () => {
      if (!rq.result.objectStoreNames.contains(MODEL_STORE)) {
        rq.result.createObjectStore(MODEL_STORE);
      }
    };
    rq.onsuccess = () => {
      const db = rq.result;
      const tx = db.transaction(MODEL_STORE, 'readwrite');
      for (const [key, value] of Object.entries(entries)) tx.objectStore(MODEL_STORE).put(value, key);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    rq.onerror = () => reject(rq.error);
  });
}

function bytesEqual(a, b) {
  return Buffer.from(new Uint8Array(a)).equals(Buffer.from(new Uint8Array(b)));
}

// ---------------------------------------------------------------------------
// Fixture isolation: fresh fake-indexeddb factory + stubbed fetch per test.
// ---------------------------------------------------------------------------

/** @type {IDBFactory} */
let idb;
/** @type {import('vitest').Mock} */
let fetchMock;

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  idb = new IDBFactory();
  fetchMock = vi.fn();
  setModelDeps({ indexedDB: idb, fetch: fetchMock });
});

afterEach(() => {
  resetModelDeps();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('MODELS registry (plan.md §B, research.md §2.3)', () => {
  it('pins the YuNet face model exactly (URL, version, size, license)', () => {
    const m = MODELS.yunet;
    expect(m.name).toBe('yunet');
    expect(m.url).toBe(
      'https://huggingface.co/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx',
    );
    expect(m.version).toBe('2023mar');
    expect(m.bytes).toBe(232589);
    expect(m.license).toBe('MIT');
    expect(m.source).toBe('https://huggingface.co/opencv/face_detection_yunet');
  });

  it('pins the YOLOv9-t plate model exactly (URL, size, license, source)', () => {
    const m = MODELS['plate-yolov9t'];
    expect(m.name).toBe('plate-yolov9t');
    // HF mirror of the GitHub release asset — the canonical URL sends no
    // CORS headers on any hop, so a browser fetch can never read it (T-701).
    expect(m.url).toBe(
      'https://huggingface.co/wide-video/open-image-models-v0.5.1/resolve/main/yolo-v9-t-640-license-plates-end2end.onnx',
    );
    expect(m.version).toBe('open-image-models-asset');
    expect(m.bytes).toBe(7835770);
    expect(m.license).toContain('MIT');
    expect(m.source).toBe('https://github.com/ankandrew/open-image-models');
  });

  it('records that no integrity hash is published (sha256 null) and keys are stable', () => {
    for (const [key, entry] of Object.entries(MODELS)) {
      expect(entry.sha256, `${key}: upstream publishes no sha256 — noted as null`).toBeNull();
      expect(entry.name).toBe(key);
    }
    // M1 cache-key shape, shared with detector.js.
    expect(modelCacheKey('yunet')).toBe('yunet@2023mar');
    expect(modelCacheKey('plate-yolov9t')).toBe('plate-yolov9t@open-image-models-asset');
  });
});

describe('ensureModel: miss → download → cache (REQ-011)', () => {
  it('streams a miss from the network, reports chunked progress, stores, and returns exact bytes', async () => {
    const payload = bytesOf(YUNET_BYTES);
    serveBytes(fetchMock, payload, { sizes: [70000, 70000, 70000, 22589] });

    /** @type {import('../../src/models.js').ModelProgress[]} */
    const progress = [];
    const buf = await ensureModel('yunet', (p) => progress.push({ ...p }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bytesEqual(buf, payload)).toBe(true);
    expect(console.warn).not.toHaveBeenCalled();

    // Initial zero-progress emit, then one emit per chunk, monotonic received.
    expect(progress[0]).toEqual({ received: 0, total: YUNET_BYTES, ratio: 0 });
    const last = progress.at(-1);
    expect(last).toEqual({ received: YUNET_BYTES, total: YUNET_BYTES, ratio: 1 });
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i].received).toBeGreaterThan(progress[i - 1].received);
    }

    // Stored in IndexedDB under the pinned `${name}@${version}` key.
    const stored = await idbRead(idb, 'yunet@2023mar');
    expect(stored).toBeInstanceOf(ArrayBuffer);
    expect(stored.byteLength).toBe(YUNET_BYTES);
    expect(bytesEqual(stored, payload)).toBe(true);
  });

  it('handles a response without content-length (total/ratio null, still caches)', async () => {
    const payload = bytesOf(YUNET_BYTES);
    serveBytes(fetchMock, payload, { contentLength: undefined, sizes: [100000, 132589] });

    const progress = [];
    const buf = await ensureModel('yunet', (p) => progress.push({ ...p }));

    expect(bytesEqual(buf, payload)).toBe(true);
    expect(console.warn).not.toHaveBeenCalled();
    for (const p of progress) {
      expect(p.total).toBeNull();
      expect(p.ratio).toBeNull();
    }
    expect(progress.at(-1).received).toBe(YUNET_BYTES);
    expect(await idbRead(idb, 'yunet@2023mar')).toBeInstanceOf(ArrayBuffer);
  });
});

describe('ensureModel: cache-first offline invariant (AC-10)', () => {
  it('resolves the second call entirely from cache with zero network traffic', async () => {
    const payload = bytesOf(YUNET_BYTES);
    serveBytes(fetchMock, payload);

    const first = await ensureModel('yunet');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Network "blocked": fetch throws on any further call.
    fetchMock.mockImplementation(async () => {
      throw new TypeError('Failed to fetch');
    });

    const onProgress = vi.fn();
    const second = await ensureModel('yunet', onProgress);

    expect(bytesEqual(second, first)).toBe(true);
    expect(new Uint8Array(second)).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledTimes(1); // still exactly one, from the miss
    expect(onProgress).not.toHaveBeenCalled(); // no progress on cache hits
  });
});

describe('ensureModel: error paths', () => {
  it('rejects an unknown model name with a typed ModelError before touching fetch', async () => {
    await expect(ensureModel('nonexistent')).rejects.toMatchObject({
      name: 'ModelError',
      code: 'unknown-model',
    });
    await expect(ensureModel('nonexistent')).rejects.toBeInstanceOf(ModelError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('wraps a network failure (empty cache) in ModelError code "network" with cause', async () => {
    const boom = new TypeError('Failed to fetch');
    fetchMock.mockImplementation(async () => {
      throw boom;
    });
    const err = await ensureModel('yunet').then(
      () => {
        throw new Error('should have rejected');
      },
      (e) => e,
    );
    expect(err).toBeInstanceOf(ModelError);
    expect(err.code).toBe('network');
    expect(err.cause).toBe(boom);
  });

  it('rejects non-2xx responses as ModelError code "network"', async () => {
    serveBytes(fetchMock, bytesOf(10), { status: 404 });
    await expect(ensureModel('yunet')).rejects.toMatchObject({
      name: 'ModelError',
      code: 'network',
    });
  });
});

describe('ensureModel: size-mismatch integrity warning', () => {
  it('warns on a short/corrupt download but still resolves and caches it', async () => {
    const shortPayload = bytesOf(1000, 0x11);
    serveBytes(fetchMock, shortPayload, { contentLength: 1000 });

    const buf = await ensureModel('yunet'); // registry expects 232,589 B

    expect(buf.byteLength).toBe(1000);
    expect(console.warn).toHaveBeenCalledTimes(1);
    const warnText = String(console.warn.mock.calls[0].join(' '));
    expect(warnText).toContain('yunet@2023mar');
    expect(warnText).toContain(String(YUNET_BYTES));
    expect(warnText).toContain('1000');

    // The short bytes are cached; an offline second call still resolves.
    fetchMock.mockImplementation(async () => {
      throw new TypeError('Failed to fetch');
    });
    const second = await ensureModel('yunet');
    expect(second.byteLength).toBe(1000);
  });
});

describe('ensureModel: in-flight dedupe', () => {
  it('concurrent calls for the same model share one fetch and one download', async () => {
    const payload = bytesOf(YUNET_BYTES);
    let releaseFetch;
    const gate = new Promise((resolve) => {
      releaseFetch = resolve;
    });
    fetchMock.mockImplementation(() => gate.then(() => responseWithChunks(chunkify(payload, [YUNET_BYTES]))));

    const progressA = [];
    const progressB = [];
    const pA = ensureModel('yunet', (p) => progressA.push(p));
    const pB = ensureModel('yunet', (p) => progressB.push(p));
    expect(pA).toBe(pB); // same in-flight promise

    releaseFetch();
    const [a, b] = await Promise.all([pA, pB]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bytesEqual(a, payload)).toBe(true);
    expect(bytesEqual(b, payload)).toBe(true);
    // Both callers observe the shared download's progress.
    expect(progressA.length).toBeGreaterThan(0);
    expect(progressB.length).toBeGreaterThan(0);
  });

  it('concurrent calls for different models download independently', async () => {
    fetchMock.mockImplementation((url) => {
      if (url === MODELS.yunet.url) {
        return responseWithChunks(chunkify(bytesOf(YUNET_BYTES), [YUNET_BYTES]), {
          contentLength: YUNET_BYTES,
        });
      }
      return responseWithChunks([new Uint8Array([1, 2, 3])], { contentLength: 3 });
    });

    const [yunet, plate] = await Promise.all([ensureModel('yunet'), ensureModel('plate-yolov9t')]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(yunet.byteLength).toBe(YUNET_BYTES);
    expect(plate.byteLength).toBe(3);
  });
});

describe('clearModelCache', () => {
  it('deletes a single model key and clears everything without an argument', async () => {
    const yunetKey = 'yunet@2023mar';
    const plateKey = 'plate-yolov9t@open-image-models-asset';
    const yunetBuf = bytesOf(8, 1);
    const plateBuf = bytesOf(9, 2);
    await idbWrite(idb, { [yunetKey]: yunetBuf, [plateKey]: plateBuf });

    await clearModelCache('yunet');
    expect(await idbRead(idb, yunetKey)).toBeUndefined();
    expect(bytesEqual(await idbRead(idb, plateKey), plateBuf)).toBe(true);

    await clearModelCache();
    expect(await idbRead(idb, plateKey)).toBeUndefined();
  });

  it('rejects unknown model names with ModelError code "unknown-model"', async () => {
    await expect(clearModelCache('bogus')).rejects.toMatchObject({
      name: 'ModelError',
      code: 'unknown-model',
    });
  });

  it('makes a subsequent ensureModel go back to the network', async () => {
    serveBytes(fetchMock, bytesOf(YUNET_BYTES));
    await ensureModel('yunet');
    await clearModelCache('yunet');

    fetchMock.mockImplementation(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(ensureModel('yunet')).rejects.toMatchObject({ code: 'network' });
  });
});
