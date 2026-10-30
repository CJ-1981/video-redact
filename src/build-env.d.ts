/**
 * Build-time injected globals (tools/inline.mjs esbuild `define`).
 *
 * The bundler replaces the `globalThis.__APP_VERSION__` /
 * `globalThis.__BUILD_DATE__` member expressions in src/main.js with string
 * literals (package.json version + build-time UTC date). Dev mode runs
 * unbundled, so both stay undefined at runtime — main.js applies its own
 * `?? 'dev'` / `?? ''` fallbacks; these declarations only exist for checkJs.
 */
declare var __APP_VERSION__: string | undefined;
declare var __BUILD_DATE__: string | undefined;

/**
 * Runtime shared diagnostics counters (v1.8.2 `?debug=1` support). NOT
 * build-injected: main.js creates `{tu, vfc}` at module scope and shares it
 * via `globalThis.__VR_DIAG` so editor.js's tick can bump `vfc` (rVFC-
 * delivered ticks only) without an import cycle; main.js's `timeupdate`
 * listener bumps `tu`, and the log tick reads + resets both. May be absent
 * (script order) — every reader guards.
 */
declare var __VR_DIAG: { tu: number, vfc: number, tickErr: number, tued: number, errs: number, lastErr: string | null } | undefined;
