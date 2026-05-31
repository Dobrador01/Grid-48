import { LANGUAGES, getCurrentLanguage, changeLanguage, t } from '@/services/i18n';
import { getAiFlowSettings, setAiFlowSetting } from '@/services/ai-flow-settings';
import { getMapProvider, setMapProvider, MAP_PROVIDER_OPTIONS, MAP_THEME_OPTIONS, getMapTheme, setMapTheme, type MapProvider } from '@/config/basemap';
import { getThemePreference, setThemePreference, type ThemePreference } from '@/utils/theme-manager';
import { escapeHtml } from '@/utils/sanitize';
import { trackLanguageChange } from '@/services/analytics';
import { exportSettings, importSettings, type ImportResult } from '@/utils/settings-persistence';

export interface PreferencesHost {
  onMapProviderChange?: (provider: MapProvider) => void;
}

export interface PreferencesResult {
  html: string;
  attach: (container: HTMLElement) => () => void;
}

function toggleRowHtml(id: string, label: string, desc: string, checked: boolean): string {
  return `
    <div class="ai-flow-toggle-row">
      <div class="ai-flow-toggle-label-wrap">
        <div class="ai-flow-toggle-label">${label}</div>
        <div class="ai-flow-toggle-desc">${desc}</div>
      </div>
      <label class="ai-flow-switch">
        <input type="checkbox" id="${id}"${checked ? ' checked' : ''}>
        <span class="ai-flow-slider"></span>
      </label>
    </div>
  `;
}

function renderMapThemeDropdown(container: HTMLElement, provider: MapProvider): void {
  const select = container.querySelector<HTMLSelectElement>('#us-map-theme');
  if (!select) return;
  const currentTheme = getMapTheme(provider);
  select.innerHTML = MAP_THEME_OPTIONS[provider]
    .map(opt => `<option value="${opt.value}"${opt.value === currentTheme ? ' selected' : ''}>${escapeHtml(opt.label)}</option>`)
    .join('');
}

export function renderPreferences(host: PreferencesHost): PreferencesResult {
  const settings = getAiFlowSettings();
  const currentLang = getCurrentLanguage();
  let html = '';

  // ── Display group ──
  html += `<details class="grid48-pref-group" open>`;
  html += `<summary>${t('preferences.display')}</summary>`;
  html += `<div class="grid48-pref-group-content">`;

  // Appearance
  const currentThemePref = getThemePreference();
  html += `<div class="ai-flow-toggle-row">
    <div class="ai-flow-toggle-label-wrap">
      <div class="ai-flow-toggle-label">${t('preferences.theme')}</div>
      <div class="ai-flow-toggle-desc">${t('preferences.themeDesc')}</div>
    </div>
  </div>`;
  html += `<select class="unified-settings-select" id="us-theme">`;
  for (const opt of [
    { value: 'auto', label: t('preferences.themeAuto') },
    { value: 'dark', label: t('preferences.themeDark') },
    { value: 'light', label: t('preferences.themeLight') },
  ] as { value: ThemePreference; label: string }[]) {
    const selected = opt.value === currentThemePref ? ' selected' : '';
    html += `<option value="${opt.value}"${selected}>${escapeHtml(opt.label)}</option>`;
  }
  html += `</select>`;

  // Map tile provider
  const currentProvider = getMapProvider();
  html += `<div class="ai-flow-toggle-row">
    <div class="ai-flow-toggle-label-wrap">
      <div class="ai-flow-toggle-label">${t('preferences.mapProvider')}</div>
      <div class="ai-flow-toggle-desc">${t('preferences.mapProviderDesc')}</div>
    </div>
  </div>`;
  html += `<select class="unified-settings-select" id="us-map-provider">`;
  for (const opt of MAP_PROVIDER_OPTIONS) {
    const selected = opt.value === currentProvider ? ' selected' : '';
    html += `<option value="${opt.value}"${selected}>${escapeHtml(opt.label)}</option>`;
  }
  html += `</select>`;

  // Map theme
  const currentMapTheme = getMapTheme(currentProvider);
  html += `<div class="ai-flow-toggle-row">
    <div class="ai-flow-toggle-label-wrap">
      <div class="ai-flow-toggle-label">${t('preferences.mapTheme')}</div>
      <div class="ai-flow-toggle-desc">${t('preferences.mapThemeDesc')}</div>
    </div>
  </div>`;
  html += `<select class="unified-settings-select" id="us-map-theme">`;
  for (const opt of MAP_THEME_OPTIONS[currentProvider]) {
    const selected = opt.value === currentMapTheme ? ' selected' : '';
    html += `<option value="${opt.value}"${selected}>${escapeHtml(opt.label)}</option>`;
  }
  html += `</select>`;

  // Language
  html += `<div class="ai-flow-section-label">${t('header.languageLabel')}</div>`;
  html += `<select class="unified-settings-lang-select" id="us-language">`;
  for (const lang of LANGUAGES) {
    const selected = lang.code === currentLang ? ' selected' : '';
    html += `<option value="${lang.code}"${selected}>${lang.flag} ${escapeHtml(lang.label)}</option>`;
  }
  html += `</select>`;
  if (currentLang === 'vi') {
    html += `<div class="ai-flow-toggle-desc">${t('components.languageSelector.mapLabelsFallbackVi')}</div>`;
  }

  html += `</div></details>`;

  // ── Panels group ──
  html += `<details class="grid48-pref-group">`;
  html += `<summary>${t('preferences.panels')}</summary>`;
  html += `<div class="grid48-pref-group-content">`;
  html += toggleRowHtml('us-badge-anim', t('components.insights.badgeAnimLabel'), t('components.insights.badgeAnimDesc'), settings.badgeAnimation);
  html += `</div></details>`;

  // ── Data group (export/import) ──
  html += `<details class="grid48-pref-group">`;
  html += `<summary>${t('preferences.dataAndCommunity')}</summary>`;
  html += `<div class="grid48-pref-group-content">`;
  html += `
    <div class="us-data-mgmt">
      <button type="button" class="settings-btn settings-btn-secondary" id="usExportBtn">${t('components.settings.exportSettings')}</button>
      <button type="button" class="settings-btn settings-btn-secondary" id="usImportBtn">${t('components.settings.importSettings')}</button>
      <input type="file" id="usImportInput" accept=".json" class="us-hidden-input" />
    </div>
    <div class="us-data-mgmt-toast" id="usDataMgmtToast"></div>
  `;
  html += `</div></details>`;

  return {
    html,
    attach(container: HTMLElement): () => void {
      const ac = new AbortController();
      const { signal } = ac;

      container.addEventListener('change', (e) => {
        const target = e.target as HTMLInputElement;

        if (target.id === 'usImportInput') {
          const file = target.files?.[0];
          if (!file) return;
          importSettings(file).then((result: ImportResult) => {
            showToast(container, t('components.settings.importSuccess', { count: String(result.keysImported) }), true);
          }).catch(() => {
            showToast(container, t('components.settings.importFailed'), false);
          });
          target.value = '';
          return;
        }

        if (target.id === 'us-theme') {
          setThemePreference(target.value as ThemePreference);
          return;
        }
        if (target.id === 'us-map-provider') {
          const provider = target.value as MapProvider;
          setMapProvider(provider);
          renderMapThemeDropdown(container, provider);
          host.onMapProviderChange?.(provider);
          window.dispatchEvent(new CustomEvent('map-theme-changed'));
          return;
        }
        if (target.id === 'us-map-theme') {
          const provider = getMapProvider();
          setMapTheme(provider, target.value);
          window.dispatchEvent(new CustomEvent('map-theme-changed'));
          return;
        }
        if (target.id === 'us-language') {
          trackLanguageChange(target.value);
          void changeLanguage(target.value);
          return;
        }
        if (target.id === 'us-badge-anim') {
          setAiFlowSetting('badgeAnimation', target.checked);
        }
      }, { signal });

      container.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('#usExportBtn')) {
          try {
            exportSettings();
            showToast(container, t('components.settings.exportSuccess'), true);
          } catch {
            showToast(container, t('components.settings.exportFailed'), false);
          }
          return;
        }
        if (target.closest('#usImportBtn')) {
          container.querySelector<HTMLInputElement>('#usImportInput')?.click();
          return;
        }
      }, { signal });

      return () => ac.abort();
    },
  };
}

function showToast(container: HTMLElement, msg: string, success: boolean): void {
  const toast = container.querySelector('#usDataMgmtToast');
  if (!toast) return;
  toast.className = `us-data-mgmt-toast ${success ? 'ok' : 'error'}`;
  toast.innerHTML = success
    ? `${escapeHtml(msg)} <a href="#" class="us-toast-reload">${t('components.settings.reloadNow')}</a>`
    : escapeHtml(msg);
  toast.querySelector('.us-toast-reload')?.addEventListener('click', (e) => {
    e.preventDefault();
    window.location.reload();
  });
}
