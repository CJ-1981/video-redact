/**
 * Ambient module declaration for `onnxruntime-web`.
 *
 * The library is NOT an npm dependency: it is pinned to the jsDelivr
 * 1.31.1 bundle via the index.html importmap (ADR-2) and unit tests inject
 * a mock module (tests/unit/detector.js mock). TypeScript therefore cannot
 * resolve the specifier — declare it as `any` for checkJs only. The real
 * API surface used here is pinned by the E2E suite.
 */
declare module 'onnxruntime-web';
