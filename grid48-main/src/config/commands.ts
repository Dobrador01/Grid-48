import type { MapLayers } from '@/types';
import { CURATED_COUNTRIES } from '@/config/countries';
import { getCurrentLanguage, t } from '@/services/i18n';

export interface Command {
  id: string;
  keywords: string[];
  label: string;
  icon: string;
  category: 'navigate' | 'layers' | 'panels' | 'view' | 'actions' | 'country';
}

export const LAYER_PRESETS: Record<string, (keyof MapLayers)[]> = {
  regional: ['weather', 'natural', 'fires', 'climate', 'outages', 'flights'],
  minimal: ['weather', 'fires'],
};

// Maps command suffix → actual MapLayers key when they differ
export const LAYER_KEY_MAP: Record<string, keyof MapLayers> = {
  natural: 'natural',
};

export const COMMANDS: Command[] = [
  // Navigation (region switching)
  { id: 'nav:global', keywords: ['global', 'world', 'reset', 'home'], label: 'Map: Global view', icon: '\u{1F30D}', category: 'navigate' },
  { id: 'nav:mena', keywords: ['mena', 'middle east', 'mideast'], label: 'Map: Middle East & North Africa', icon: '\u{1F54C}', category: 'navigate' },
  { id: 'nav:eu', keywords: ['europe', 'eu'], label: 'Map: Europe', icon: '\u{1F3F0}', category: 'navigate' },
  { id: 'nav:asia', keywords: ['asia', 'pacific'], label: 'Map: Asia-Pacific', icon: '\u{1F3EF}', category: 'navigate' },
  { id: 'nav:america', keywords: ['america', 'americas', 'us', 'usa'], label: 'Map: Americas', icon: '\u{1F5FD}', category: 'navigate' },
  { id: 'nav:africa', keywords: ['africa'], label: 'Map: Africa', icon: '\u{1F30D}', category: 'navigate' },
  { id: 'nav:latam', keywords: ['latam', 'latin america', 'south america'], label: 'Map: Latin America', icon: '\u{1F30E}', category: 'navigate' },
  { id: 'nav:oceania', keywords: ['oceania', 'australia', 'pacific islands'], label: 'Map: Oceania', icon: '\u{1F30F}', category: 'navigate' },

  // Layer presets (toggle groups)
  { id: 'layers:regional', keywords: ['regional', 'regional layers', 'show regional'], label: 'Show regional layers', icon: '\u{1F30E}', category: 'layers' },
  { id: 'layers:all', keywords: ['all layers', 'show all', 'enable all'], label: 'Enable all layers', icon: '\u{1F441}\uFE0F', category: 'layers' },
  { id: 'layers:none', keywords: ['hide all', 'clear layers', 'no layers', 'disable all'], label: 'Hide all layers', icon: '\u{1F6AB}', category: 'layers' },
  { id: 'layers:minimal', keywords: ['minimal', 'minimal layers', 'clean'], label: 'Minimal layers (weather + fires)', icon: '\u2728', category: 'layers' },

  // Individual layer toggles
  { id: 'layer:weather', keywords: ['weather', 'tempo', 'chuva'], label: 'Toggle weather overlay', icon: '\u{1F324}\uFE0F', category: 'layers' },
  { id: 'layer:natural', keywords: ['natural events', 'earthquakes', 'volcanoes', 'tsunamis'], label: 'Toggle natural events', icon: '\u{1F30B}', category: 'layers' },
  { id: 'layer:fires', keywords: ['fires', 'wildfires', 'incendios'], label: 'Toggle satellite fires', icon: '\u{1F525}', category: 'layers' },
  { id: 'layer:climate', keywords: ['climate', 'anomalies', 'clima'], label: 'Toggle climate anomalies', icon: '\u{1F321}\uFE0F', category: 'layers' },
  { id: 'layer:outages', keywords: ['outages', 'internet outages'], label: 'Toggle internet outages', icon: '\u{1F4E1}', category: 'layers' },
  { id: 'layer:flights', keywords: ['flights', 'aircraft', 'aviacao'], label: 'Toggle aviation', icon: '\u2708\uFE0F', category: 'layers' },
  { id: 'layer:dayNight', keywords: ['day night', 'terminator', 'shadow', 'day/night'], label: 'Toggle day/night overlay', icon: '\u{1F31C}', category: 'layers' },

  // Panel navigation (matching actual DEFAULT_PANELS keys)
  { id: 'panel:live-news', keywords: ['news', 'live news', 'headlines'], label: 'Panel: Live News', icon: '\u{1F4F0}', category: 'panels' },
  { id: 'panel:intel', keywords: ['intel', 'intel feed'], label: 'Panel: Intel Feed', icon: '\u{1F50E}', category: 'panels' },
  { id: 'panel:gdelt-intel', keywords: ['gdelt', 'intelligence feed'], label: 'Panel: Live Intelligence', icon: '\u{1F50D}', category: 'panels' },
  { id: 'panel:deduction', keywords: ['deduction', 'future', 'what if'], label: 'Panel: Deduct Situation', icon: '\u{1F9E0}', category: 'panels' },
  { id: 'panel:cii', keywords: ['cii', 'instability', 'country risk'], label: 'Panel: Country Instability', icon: '\u{1F3AF}', category: 'panels' },
  { id: 'panel:cascade', keywords: ['cascade', 'infrastructure cascade'], label: 'Panel: Infrastructure Cascade', icon: '\u{1F517}', category: 'panels' },
  { id: 'panel:strategic-risk', keywords: ['risk', 'strategic risk', 'threat level'], label: 'Panel: Strategic Risk', icon: '\u26A0\uFE0F', category: 'panels' },
  { id: 'panel:politics', keywords: ['world news', 'politics', 'geopolitics'], label: 'Panel: World News', icon: '\u{1F30D}', category: 'panels' },
  { id: 'panel:us', keywords: ['united states', 'us news', 'america news'], label: 'Panel: United States', icon: '\u{1F1FA}\u{1F1F8}', category: 'panels' },
  { id: 'panel:europe', keywords: ['europe news', 'eu news'], label: 'Panel: Europe', icon: '\u{1F1EA}\u{1F1FA}', category: 'panels' },
  { id: 'panel:middleeast', keywords: ['middle east news', 'mideast news'], label: 'Panel: Middle East', icon: '\u{1F54C}', category: 'panels' },
  { id: 'panel:africa', keywords: ['africa news'], label: 'Panel: Africa', icon: '\u{1F30D}', category: 'panels' },
  { id: 'panel:latam', keywords: ['latin america news', 'latam news'], label: 'Panel: Latin America', icon: '\u{1F30E}', category: 'panels' },
  { id: 'panel:asia', keywords: ['asia news', 'asia-pacific news'], label: 'Panel: Asia-Pacific', icon: '\u{1F30F}', category: 'panels' },
  { id: 'panel:energy', keywords: ['energy', 'resources', 'oil news'], label: 'Panel: Energy & Resources', icon: '\u26A1', category: 'panels' },
  { id: 'panel:gov', keywords: ['government', 'gov'], label: 'Panel: Government', icon: '\u{1F3DB}\uFE0F', category: 'panels' },
  { id: 'panel:thinktanks', keywords: ['think tanks', 'thinktanks', 'analysis'], label: 'Panel: Think Tanks', icon: '\u{1F9E0}', category: 'panels' },
  { id: 'panel:polymarket', keywords: ['predictions', 'polymarket', 'forecasts'], label: 'Panel: Predictions', icon: '\u{1F52E}', category: 'panels' },
  { id: 'panel:commodities', keywords: ['commodities', 'gold', 'silver'], label: 'Panel: Commodities', icon: '\u{1F4E6}', category: 'panels' },
  { id: 'panel:markets', keywords: ['markets', 'stocks', 'indices'], label: 'Panel: Markets', icon: '\u{1F4C8}', category: 'panels' },
  { id: 'panel:economic', keywords: ['economic', 'economy', 'fred'], label: 'Panel: Economic Indicators', icon: '\u{1F4CA}', category: 'panels' },
  { id: 'panel:trade-policy', keywords: ['trade', 'tariffs', 'wto', 'trade policy', 'sanctions', 'restrictions'], label: 'Panel: Trade Policy', icon: '\u{1F4CA}', category: 'panels' },
  { id: 'panel:supply-chain', keywords: ['supply chain', 'shipping', 'chokepoint', 'minerals', 'freight', 'logistics'], label: 'Panel: Supply Chain', icon: '\u{1F6A2}', category: 'panels' },
  { id: 'panel:finance', keywords: ['financial', 'finance news'], label: 'Panel: Financial', icon: '\u{1F4B5}', category: 'panels' },
  { id: 'panel:tech', keywords: ['technology', 'tech news'], label: 'Panel: Technology', icon: '\u{1F4BB}', category: 'panels' },
  { id: 'panel:crypto', keywords: ['crypto', 'bitcoin', 'ethereum'], label: 'Panel: Crypto', icon: '\u20BF', category: 'panels' },
  { id: 'panel:heatmap', keywords: ['heatmap', 'sector heatmap'], label: 'Panel: Sector Heatmap', icon: '\u{1F5FA}\uFE0F', category: 'panels' },
  { id: 'panel:ai', keywords: ['ai', 'ml', 'artificial intelligence'], label: 'Panel: AI/ML', icon: '\u{1F916}', category: 'panels' },
  { id: 'panel:macro-signals', keywords: ['macro', 'macro signals', 'liquidity'], label: 'Panel: Market Radar', icon: '\u{1F4C9}', category: 'panels' },
  { id: 'panel:etf-flows', keywords: ['etf', 'etf flows', 'fund flows'], label: 'Panel: BTC ETF Tracker', icon: '\u{1F4B9}', category: 'panels' },
  { id: 'panel:stablecoins', keywords: ['stablecoins', 'usdt', 'usdc'], label: 'Panel: Stablecoins', icon: '\u{1FA99}', category: 'panels' },
  { id: 'panel:monitors', keywords: ['monitors', 'my monitors', 'watchlist'], label: 'Panel: My Monitors', icon: '\u{1F4CB}', category: 'panels' },

  // View / settings
  { id: 'view:dark', keywords: ['dark', 'dark mode', 'night'], label: 'Switch to dark mode', icon: '\u{1F319}', category: 'view' },
  { id: 'view:light', keywords: ['light', 'light mode', 'day'], label: 'Switch to light mode', icon: '\u2600\uFE0F', category: 'view' },
  { id: 'view:fullscreen', keywords: ['fullscreen', 'full screen'], label: 'Toggle fullscreen', icon: '\u26F6', category: 'view' },
  { id: 'view:settings', keywords: ['settings', 'config', 'api keys'], label: 'Open settings', icon: '\u2699\uFE0F', category: 'view' },
  { id: 'view:refresh', keywords: ['refresh', 'reload', 'refresh all'], label: 'Refresh all data', icon: '\u{1F504}', category: 'view' },

  // Time range
  { id: 'time:1h', keywords: ['1h', 'last hour', '1 hour'], label: 'Show events from last hour', icon: '\u{1F550}', category: 'actions' },
  { id: 'time:6h', keywords: ['6h', 'last 6 hours', '6 hours'], label: 'Show events from last 6 hours', icon: '\u{1F555}', category: 'actions' },
  { id: 'time:24h', keywords: ['24h', 'last 24 hours', 'today'], label: 'Show events from last 24 hours', icon: '\u{1F55B}', category: 'actions' },
  { id: 'time:48h', keywords: ['48h', '2 days', 'last 2 days'], label: 'Show events from last 48 hours', icon: '\u{1F4C5}', category: 'actions' },
  { id: 'time:7d', keywords: ['7d', 'week', 'last week', '7 days'], label: 'Show events from last 7 days', icon: '\u{1F5D3}\uFE0F', category: 'actions' },
];

function toFlagEmoji(code: string): string {
  return code.toUpperCase().split('').map(c => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65)).join('');
}

// All ISO 3166-1 alpha-2 codes — Intl.DisplayNames resolves human-readable names at runtime
const ISO_CODES = [
  'AD', 'AE', 'AF', 'AG', 'AL', 'AM', 'AO', 'AR', 'AT', 'AU', 'AZ', 'BA', 'BB', 'BD', 'BE', 'BF',
  'BG', 'BH', 'BI', 'BJ', 'BN', 'BO', 'BR', 'BS', 'BT', 'BW', 'BY', 'BZ', 'CA', 'CD', 'CF', 'CG',
  'CH', 'CI', 'CL', 'CM', 'CN', 'CO', 'CR', 'CU', 'CV', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO',
  'DZ', 'EC', 'EE', 'EG', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FM', 'FR', 'GA', 'GB', 'GD', 'GE', 'GH',
  'GM', 'GN', 'GQ', 'GR', 'GT', 'GW', 'GY', 'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IN', 'IQ',
  'IR', 'IS', 'IT', 'JM', 'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KZ',
  'LA', 'LB', 'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MG',
  'MH', 'MK', 'ML', 'MM', 'MN', 'MR', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA', 'NE', 'NG',
  'NI', 'NL', 'NO', 'NP', 'NR', 'NZ', 'OM', 'PA', 'PE', 'PG', 'PH', 'PK', 'PL', 'PS', 'PT', 'PW',
  'PY', 'QA', 'RO', 'RS', 'RU', 'RW', 'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SI', 'SK', 'SL', 'SM',
  'SN', 'SO', 'SR', 'SS', 'ST', 'SV', 'SY', 'SZ', 'TD', 'TG', 'TH', 'TJ', 'TL', 'TM', 'TN', 'TO',
  'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VN', 'VU', 'WS',
  'YE', 'ZA', 'ZM', 'ZW',
];

let _cachedLang = '';
let _cachedCountryCommands: Command[] = [];
let _cachedAllCommands: Command[] = [];

const KEYWORD_I18N_MAP: Record<string, string> = {
  military: 'commands.keywords.military',
  finance: 'commands.keywords.finance',
  financial: 'commands.keywords.finance',
  infrastructure: 'commands.keywords.infrastructure',
  intelligence: 'commands.keywords.intelligence',
  news: 'commands.keywords.news',
  dark: 'commands.keywords.dark',
  light: 'commands.keywords.light',
  settings: 'commands.keywords.settings',
  fullscreen: 'commands.keywords.fullscreen',
  refresh: 'commands.keywords.refresh',
};

function injectLocalizedKeywords(commands: Command[]): Command[] {
  const lang = getCurrentLanguage();
  if (lang === 'en') return commands;

  return commands.map(cmd => {
    const extra: string[] = [];
    for (const kw of cmd.keywords) {
      const i18nKey = KEYWORD_I18N_MAP[kw];
      if (i18nKey) {
        const localized = t(i18nKey).toLowerCase();
        if (localized !== kw && !cmd.keywords.includes(localized)) {
          extra.push(localized);
        }
      }
    }
    if (extra.length === 0) return cmd;
    return { ...cmd, keywords: [...cmd.keywords, ...extra] };
  });
}

function buildCountryCommands(): Command[] {
  const lang = getCurrentLanguage();
  if (lang === _cachedLang && _cachedCountryCommands.length > 0) {
    return _cachedCountryCommands;
  }

  const displayNames = new Intl.DisplayNames([lang], { type: 'region' });

  const result = ISO_CODES.flatMap(code => {
    const curated = CURATED_COUNTRIES[code];
    const name = displayNames.of(code) || curated?.name || code;
    const keywords = curated
      ? [name.toLowerCase(), curated.name.toLowerCase(), ...curated.searchAliases].filter(Boolean)
      : [name.toLowerCase()];
    return [
      {
        id: `country-map:${code}`,
        keywords: [...keywords, 'map'],
        label: name,
        icon: toFlagEmoji(code),
        category: 'navigate' as const,
      },
      {
        id: `country:${code}`,
        keywords: [...keywords, 'brief'],
        label: name,
        icon: toFlagEmoji(code),
        category: 'country' as const,
      },
    ];
  });

  _cachedLang = lang;
  _cachedCountryCommands = result;
  _cachedAllCommands = [...injectLocalizedKeywords(COMMANDS), ...result];
  return result;
}

export function getAllCommands(): Command[] {
  buildCountryCommands();
  return _cachedAllCommands.length > 0 ? _cachedAllCommands : COMMANDS;
}
