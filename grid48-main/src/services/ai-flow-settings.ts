/**
 * UI preferences do Grid 48 (apenas badgeAnimation).
 *
 * Histórico: o arquivo armazenava cloudLlm, browserModel, mapNewsFlash,
 * headlineMemory, streamQuality — todos descartados junto com a Settings UI.
 * Mantemos só `badgeAnimation` (gen érico) consumido por Panel.ts em
 * setCount() pra animar contadores.
 */

const STORAGE_KEY_BADGE_ANIMATION = 'grid48-badge-animation';
const EVENT_NAME = 'ai-flow-changed';

export interface AiFlowSettings {
  badgeAnimation: boolean;
}

const DEFAULTS: AiFlowSettings = {
  badgeAnimation: false,
};

function readBool(key: string, defaultValue: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return defaultValue;
    return raw === 'true';
  } catch {
    return defaultValue;
  }
}

function writeBool(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Quota or private-browsing; silently ignore
  }
}

const STORAGE_KEY_MAP: Record<keyof AiFlowSettings, string> = {
  badgeAnimation: STORAGE_KEY_BADGE_ANIMATION,
};

export function getAiFlowSettings(): AiFlowSettings {
  return {
    badgeAnimation: readBool(STORAGE_KEY_BADGE_ANIMATION, DEFAULTS.badgeAnimation),
  };
}

export function setAiFlowSetting(key: keyof AiFlowSettings, value: boolean): void {
  writeBool(STORAGE_KEY_MAP[key], value);
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { key } }));
}

export function subscribeAiFlowChange(cb: (changedKey?: keyof AiFlowSettings) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail as { key?: keyof AiFlowSettings } | undefined;
    cb(detail?.key);
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
