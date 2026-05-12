import { SITE_VARIANT } from '@/config/variant';

const WS_API_URL = import.meta.env.VITE_WS_API_URL || '';

const DEFAULT_REMOTE_HOSTS: Record<string, string> = {
  tech: WS_API_URL,
  full: WS_API_URL,
  finance: WS_API_URL,
  world: WS_API_URL,
  happy: WS_API_URL,
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '');
}

export function getRemoteApiBaseUrl(): string {
  const configuredRemoteBase = import.meta.env.VITE_TAURI_REMOTE_API_BASE_URL;
  if (configuredRemoteBase) {
    return normalizeBaseUrl(configuredRemoteBase);
  }

  const fromHosts = DEFAULT_REMOTE_HOSTS[SITE_VARIANT] ?? DEFAULT_REMOTE_HOSTS.full ?? '';
  return fromHosts;
}

export function toRuntimeUrl(path: string): string {
  return path;
}

function extractHostnames(...urls: (string | undefined)[]): string[] {
  const hosts: string[] = [];
  for (const u of urls) {
    if (!u) continue;
    try { hosts.push(new URL(u).hostname); } catch {}
  }
  return hosts;
}

export const APP_HOSTS = new Set([
  'worldmonitor.app',
  'www.worldmonitor.app',
  'tech.worldmonitor.app',
  'api.worldmonitor.app',
  'localhost',
  '127.0.0.1',
  ...extractHostnames(WS_API_URL, import.meta.env.VITE_WS_RELAY_URL),
]);


export type SmartPollReason = 'interval' | 'resume' | 'manual' | 'startup';

export interface SmartPollContext {
  signal?: AbortSignal;
  reason: SmartPollReason;
  isHidden: boolean;
}

export interface SmartPollOptions {
  intervalMs: number;
  hiddenIntervalMs?: number;
  hiddenMultiplier?: number;
  pauseWhenHidden?: boolean;
  refreshOnVisible?: boolean;
  runImmediately?: boolean;
  shouldRun?: () => boolean;
  maxBackoffMultiplier?: number;
  jitterFraction?: number;
  minIntervalMs?: number;
  onError?: (error: unknown) => void;
  visibilityDebounceMs?: number;
}

export interface SmartPollLoopHandle {
  stop: () => void;
  trigger: () => void;
  isActive: () => boolean;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: string }).name;
  return name === 'AbortError';
}

function hasVisibilityApi(): boolean {
  return typeof document !== 'undefined'
    && typeof document.addEventListener === 'function'
    && typeof document.removeEventListener === 'function';
}

function isDocumentHidden(): boolean {
  return hasVisibilityApi() && document.visibilityState === 'hidden';
}

export function startSmartPollLoop(
  poll: (ctx: SmartPollContext) => Promise<boolean | void> | boolean | void,
  opts: SmartPollOptions,
): SmartPollLoopHandle {
  const intervalMs = Math.max(1_000, Math.round(opts.intervalMs));
  const hiddenMultiplier = Math.max(1, opts.hiddenMultiplier ?? 10);
  const pauseWhenHidden = opts.pauseWhenHidden ?? false;
  const refreshOnVisible = opts.refreshOnVisible ?? true;
  const runImmediately = opts.runImmediately ?? false;
  const shouldRun = opts.shouldRun;
  const onError = opts.onError;
  const maxBackoffMultiplier = Math.max(1, opts.maxBackoffMultiplier ?? 4);
  const jitterFraction = Math.max(0, opts.jitterFraction ?? 0.1);
  const minIntervalMs = Math.max(250, opts.minIntervalMs ?? 1_000);
  const hiddenIntervalMs = opts.hiddenIntervalMs !== undefined
    ? Math.max(minIntervalMs, Math.round(opts.hiddenIntervalMs))
    : undefined;

  const visibilityDebounceMs = Math.max(0, opts.visibilityDebounceMs ?? 300);

  let active = true;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let visibilityDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let backoffMultiplier = 1;
  let activeController: AbortController | null = null;

  const clearTimer = () => {
    if (!timerId) return;
    clearTimeout(timerId);
    timerId = null;
  };

  const baseDelayMs = (hidden: boolean): number | null => {
    if (hidden) {
      if (pauseWhenHidden) return null;
      return hiddenIntervalMs ?? (intervalMs * hiddenMultiplier);
    }
    return intervalMs * backoffMultiplier;
  };

  const computeDelay = (baseMs: number): number => {
    const jitterRange = baseMs * jitterFraction;
    const jittered = baseMs + ((Math.random() * 2 - 1) * jitterRange);
    return Math.max(minIntervalMs, Math.round(jittered));
  };

  const scheduleNext = () => {
    if (!active) return;
    clearTimer();
    const base = baseDelayMs(isDocumentHidden());
    if (base === null) return;
    timerId = setTimeout(() => {
      timerId = null;
      void runOnce('interval');
    }, computeDelay(base));
  };

  const runOnce = async (reason: SmartPollReason): Promise<void> => {
    if (!active) return;

    const hidden = isDocumentHidden();
    if (hidden && pauseWhenHidden) {
      scheduleNext();
      return;
    }
    if (shouldRun && !shouldRun()) {
      scheduleNext();
      return;
    }
    if (inFlight) {
      scheduleNext();
      return;
    }

    inFlight = true;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    activeController = controller;

    try {
      const result = await poll({
        signal: controller?.signal,
        reason,
        isHidden: hidden,
      });

      if (result === false) {
        backoffMultiplier = Math.min(backoffMultiplier * 2, maxBackoffMultiplier);
      } else {
        backoffMultiplier = 1;
      }
    } catch (error) {
      if (!controller?.signal.aborted && !isAbortError(error)) {
        backoffMultiplier = Math.min(backoffMultiplier * 2, maxBackoffMultiplier);
        if (onError) onError(error);
      }
    } finally {
      if (activeController === controller) activeController = null;
      inFlight = false;
      scheduleNext();
    }
  };

  const clearVisibilityDebounce = () => {
    if (visibilityDebounceTimer) {
      clearTimeout(visibilityDebounceTimer);
      visibilityDebounceTimer = null;
    }
  };

  const handleVisibilityChange = () => {
    if (!active) return;
    const hidden = isDocumentHidden();

    if (hidden) {
      if (pauseWhenHidden) {
        clearTimer();
        activeController?.abort();
        return;
      }
      scheduleNext();
      return;
    }

    if (refreshOnVisible) {
      clearTimer();
      void runOnce('resume');
      return;
    }

    scheduleNext();
  };

  const onVisibilityChange = () => {
    if (!active) return;
    if (visibilityDebounceMs > 0 && !isDocumentHidden()) {
      clearVisibilityDebounce();
      visibilityDebounceTimer = setTimeout(handleVisibilityChange, visibilityDebounceMs);
      return;
    }
    handleVisibilityChange();
  };

  if (hasVisibilityApi()) {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  if (runImmediately) {
    void runOnce('startup');
  } else {
    scheduleNext();
  }

  return {
    stop: () => {
      if (!active) return;
      active = false;
      clearTimer();
      clearVisibilityDebounce();
      activeController?.abort();
      activeController = null;
      if (hasVisibilityApi()) {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    },
    trigger: () => {
      if (!active) return;
      clearTimer();
      void runOnce('manual');
    },
    isActive: () => active,
  };
}

const ALLOWED_REDIRECT_HOSTS = /^https:\/\/([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*worldmonitor\.app(:\d+)?$/;

function isAllowedRedirectTarget(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ALLOWED_REDIRECT_HOSTS.test(parsed.origin) || parsed.hostname === 'localhost';
  } catch {
    return false;
  }
}

export function installWebApiRedirect(): void {
  if (typeof window === 'undefined') return;
  if (!WS_API_URL) return;
  if (!isAllowedRedirectTarget(WS_API_URL)) {
    console.warn('[runtime] VITE_WS_API_URL blocked — not in hostname allowlist:', WS_API_URL);
    return;
  }
  if ((window as unknown as Record<string, unknown>).__wmWebRedirectPatched) return;

  const nativeFetch = window.fetch.bind(window);
  const API_BASE = WS_API_URL;
  const shouldRedirectPath = (pathWithQuery: string): boolean => pathWithQuery.startsWith('/api/');
  const shouldFallbackToOrigin = (status: number): boolean => status === 404 || status === 405 || status === 501 || status === 502 || status === 503;
  const fetchWithRedirectFallback = async (
    redirectedInput: RequestInfo | URL,
    originalInput: RequestInfo | URL,
    originalInit?: RequestInit,
  ): Promise<Response> => {
    try {
      const redirectedResponse = await nativeFetch(redirectedInput, originalInit);
      if (!shouldFallbackToOrigin(redirectedResponse.status)) return redirectedResponse;
      return nativeFetch(originalInput, originalInit);
    } catch {
      return nativeFetch(originalInput, originalInit);
    }
  };

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (typeof input === 'string' && shouldRedirectPath(input)) {
      return fetchWithRedirectFallback(`${API_BASE}${input}`, input, init);
    }
    if (input instanceof URL && input.origin === window.location.origin && shouldRedirectPath(`${input.pathname}${input.search}`)) {
      return fetchWithRedirectFallback(new URL(`${API_BASE}${input.pathname}${input.search}`), input, init);
    }
    if (input instanceof Request) {
      const u = new URL(input.url);
      if (u.origin === window.location.origin && shouldRedirectPath(`${u.pathname}${u.search}`)) {
        return fetchWithRedirectFallback(
          new Request(`${API_BASE}${u.pathname}${u.search}`, input),
          input.clone(),
          init,
        );
      }
    }
    return nativeFetch(input, init);
  };

  (window as unknown as Record<string, unknown>).__wmWebRedirectPatched = true;
}

// ── Stub exports for removed desktop runtime ──
// These are kept as no-op stubs so that callers across the codebase
// don't need to be individually rewritten. Always returns web-mode defaults.

/** Always false — desktop runtime has been removed. */
export function isDesktopRuntime(): boolean { return false; }

/** Returns empty string — use relative URLs for web fat client. */
export function getApiBaseUrl(): string { return ''; }

/** No-op — sidecar no longer exists. */
export async function waitForSidecarReady(): Promise<void> {}

/** Returns 0 — no local API port in web mode. */
export function resolveLocalApiPort(): number { return 0; }
