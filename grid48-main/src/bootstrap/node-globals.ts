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

// O logger do @meshtastic faz deep-clone/mask dos valores logados e chama
// Buffer.isBuffer() / usa `instanceof Buffer` sem guarda → "Buffer is not
// defined" no navegador. Shim como FUNÇÃO (pra `x instanceof Buffer` não
// estourar) com isBuffer sempre false (o browser nunca tem Buffers).
if (typeof g.Buffer === 'undefined') {
  const BufferShim = function () {} as unknown as Record<string, unknown>;
  BufferShim.isBuffer = () => false;
  BufferShim.from = (v: unknown) =>
    v instanceof Uint8Array ? v : new Uint8Array(Array.isArray(v) ? v : []);
  BufferShim.alloc = (n: number) => new Uint8Array(n);
  g.Buffer = BufferShim;
}

export {};
