/**
 * Browser shim for Node's `os`.
 * @meshtastic/core's bundled logger calls `os.hostname()`. No real OS info
 * is available (or wanted) in the browser, so we return a placeholder.
 */
export function hostname(): string {
  return 'browser';
}

export function platform(): string {
  return 'browser';
}

export const EOL = '\n';

export default { hostname, platform, EOL };
