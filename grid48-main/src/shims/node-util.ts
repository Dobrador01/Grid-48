/**
 * Browser shim for Node's `util`.
 * @meshtastic/core's bundled logger uses `formatWithOptions(...)` to render log
 * args and `types.isNativeError(...)` to detect errors. We provide minimal
 * browser-safe equivalents.
 */
function safeStringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function formatWithOptions(_opts: unknown, ...args: unknown[]): string {
  return args.map(safeStringify).join(' ');
}

export function format(...args: unknown[]): string {
  return args.map(safeStringify).join(' ');
}

export const types = {
  isNativeError: (e: unknown): e is Error => e instanceof Error,
};

export default { formatWithOptions, format, types };
