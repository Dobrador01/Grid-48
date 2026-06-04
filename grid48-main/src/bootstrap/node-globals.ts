/**
 * Browser polyfill for Node globals referenced by @meshtastic/core (and its
 * @bufbuild/protobuf dep) at module-eval / log time.
 *
 * Most refs are guarded (`typeof process !== 'object'`), but the bundled logger
 * calls `process.cwd()` UNGUARDED when formatting the caller file path — which
 * throws `ReferenceError: process is not defined` in the browser. Defining a
 * minimal `process`/`global` on globalThis makes those paths safe.
 *
 * Imported first in main.ts so it runs before any consumer evaluates (the
 * Meshtastic bridge is lazy-loaded on click, well after this).
 */
const g = globalThis as unknown as Record<string, unknown>;

if (typeof g.process === 'undefined') {
  g.process = {
    env: {},
    cwd: () => '/',
    platform: 'browser',
    version: '',
    versions: {},
    argv: [],
  };
}

if (typeof g.global === 'undefined') {
  g.global = globalThis;
}

export {};
