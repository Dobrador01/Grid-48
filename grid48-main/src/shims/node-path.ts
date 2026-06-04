/**
 * Browser shim for Node's `path`.
 * @meshtastic/core's bundled logger calls `path.normalize()` to format the
 * caller file:line in log lines. Browser bundles have no filesystem paths, so
 * these are best-effort string ops.
 */
export function normalize(p: string): string {
  return p;
}

export function join(...parts: string[]): string {
  return parts.filter(Boolean).join('/');
}

export function dirname(p: string): string {
  return p.replace(/\/[^/]*$/, '') || '/';
}

export function basename(p: string): string {
  return p.replace(/^.*\//, '');
}

export function resolve(...parts: string[]): string {
  return parts.filter(Boolean).join('/');
}

export const sep = '/';

export default { normalize, join, dirname, basename, resolve, sep };
