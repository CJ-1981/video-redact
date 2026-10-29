#!/usr/bin/env node
/**
 * Zero-dependency static file server for the video-redact dev shell.
 *
 * SERVE OVER LOCALHOST — NEVER file://
 * The app relies on Secure Context APIs (WebCodecs, IndexedDB, OPFS, WASM
 * threads policy). Under `file://` the page is not a secure context and the
 * serve-gate (#serve-gate) deliberately blocks all processing. Always run:
 *
 *     npm run dev                      # this server on http://127.0.0.1:8000
 *     python3 -m http.server 8000      # equivalent, stdlib
 *     npx serve                        # equivalent
 *
 * E2E TESTS (Playwright) need a browser binary once per machine:
 *
 *     npx playwright install chromium
 *
 * Notes:
 *  - Serves ./ (project root) so /src/*.js ES modules resolve relative to index.html.
 *  - Cache-Control: no-store on everything — local dev files must never be stale.
 *  - Default host/port: 127.0.0.1:8000 (override: HOST / PORT env vars).
 */
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 8000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.onnx': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';

    // Resolve inside ROOT only (path traversal guard).
    const filePath = normalize(join(ROOT, pathname));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    if (stat.isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    createReadStream(filePath).pipe(res);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`500 Internal Server Error: ${err?.message ?? err}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`video-redact dev server → http://${HOST}:${PORT}/  (Ctrl+C to stop)`);
});
