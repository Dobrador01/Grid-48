import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

// English is always needed as fallback — bundle it eagerly.
import enTranslation from '../locales/en.json';

// Grid 48 ships only en (fallback) + pt (Brazilian Portuguese, primary audience).
// Outras línguas foram removidas no fim da Camada D — restore via git se voltar a precisar.
const SUPPORTED_LANGUAGES = ['en', 'pt'] as const;
type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number];
type TranslationDictionary = Record<string, unknown>;

const SUPPORTED_LANGUAGE_SET = new Set<SupportedLanguage>(SUPPORTED_LANGUAGES);
const loadedLanguages = new Set<SupportedLanguage>();

// Lazy-load only the locale that's actually needed — all others stay out of the bundle.
const localeModules = import.meta.glob<TranslationDictionary>(
  ['../locales/*.json', '!../locales/en.json'],
  { import: 'default' },
);

function normalizeLanguage(lng: string): SupportedLanguage {
  const base = (lng || 'en').split('-')[0]?.toLowerCase() || 'en';
  if (SUPPORTED_LANGUAGE_SET.has(base as SupportedLanguage)) {
    return base as SupportedLanguage;
  }
  return 'en';
}

function applyDocumentLanguage(lang: string): void {
  const base = lang.split('-')[0] || lang;
  document.documentElement.setAttribute('lang', base);
}

async function ensureLanguageLoaded(lng: string): Promise<SupportedLanguage> {
  const normalized = normalizeLanguage(lng);
  if (loadedLanguages.has(normalized) && i18next.hasResourceBundle(normalized, 'translation')) {
    return normalized;
  }

  let translation: TranslationDictionary;
  if (normalized === 'en') {
    translation = enTranslation as TranslationDictionary;
  } else {
    const loader = localeModules[`../locales/${normalized}.json`];
    if (!loader) {
      console.warn(`No locale file for "${normalized}", falling back to English`);
      translation = enTranslation as TranslationDictionary;
    } else {
      translation = await loader();
    }
  }

  i18next.addResourceBundle(normalized, 'translation', translation, true, true);
  loadedLanguages.add(normalized);
  return normalized;
}

// Initialize i18n
export async function initI18n(): Promise<void> {
  if (i18next.isInitialized) {
    const currentLanguage = normalizeLanguage(i18next.language || 'en');
    await ensureLanguageLoaded(currentLanguage);
    applyDocumentLanguage(i18next.language || currentLanguage);
    return;
  }

  loadedLanguages.add('en');

  await i18next
    .use(LanguageDetector)
    .init({
      resources: {
        en: { translation: enTranslation as TranslationDictionary },
      },
      supportedLngs: [...SUPPORTED_LANGUAGES],
      nonExplicitSupportedLngs: true,
      fallbackLng: 'en',
      debug: import.meta.env.DEV,
      interpolation: {
        escapeValue: false, // not needed for these simple strings
      },
      detection: {
        order: ['localStorage', 'navigator'],
        caches: ['localStorage'],
      },
    });

  const detectedLanguage = await ensureLanguageLoaded(i18next.language || 'en');
  if (detectedLanguage !== 'en') {
    // Re-trigger translation resolution now that the detected bundle is loaded.
    await i18next.changeLanguage(detectedLanguage);
  }

  applyDocumentLanguage(i18next.language || detectedLanguage);
}

// Helper to translate
export function t(key: string, options?: Record<string, unknown>): string {
  return i18next.t(key, options);
}

// Helper to change language
export async function changeLanguage(lng: string): Promise<void> {
  const normalized = await ensureLanguageLoaded(lng);
  await i18next.changeLanguage(normalized);
  applyDocumentLanguage(normalized);
  window.location.reload(); // Simple reload to update all components for now
}

// Helper to get current language (normalized to short code)
export function getCurrentLanguage(): string {
  const lang = i18next.language || 'en';
  return lang.split('-')[0]!;
}

export const LANGUAGES = [
  { code: 'pt', label: 'Português', flag: '🇧🇷' },
  { code: 'en', label: 'English', flag: '🇬🇧' },
];
