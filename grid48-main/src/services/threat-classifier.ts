/**
 * Threat Classifier — Stub module.
 *
 * The original ML-based classifier was removed as part of the desktop-to-web
 * migration. This stub preserves the public API surface so that existing
 * consumers (analysis-core, intelligence/index, etc.) continue to compile.
 *
 * Classification is now purely keyword-based.
 */

// Re-export canonical types from the central types barrel
export type { ThreatClassification, ThreatLevel, EventCategory } from '@/types';
import type { ThreatClassification, ThreatLevel, EventCategory } from '@/types';

// ── Constants ──

export const THREAT_PRIORITY: Record<ThreatLevel, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

// ── Keyword lists for heuristic classification ──

const CONFLICT_KEYWORDS = [
  'war', 'airstrike', 'strike', 'missile', 'bomb', 'invasion',
  'combat', 'troops', 'artillery', 'casualties', 'killed',
  'clashes', 'shelling', 'offensive', 'military', 'drone',
];

const CYBER_KEYWORDS = [
  'hack', 'breach', 'ransomware', 'malware', 'phishing',
  'vulnerability', 'exploit', 'cve-', 'apt', 'ddos',
  'cyberattack', 'data leak', 'zero-day',
];

const HEALTH_KEYWORDS = [
  'pandemic', 'outbreak', 'epidemic', 'virus', 'vaccine',
  'who', 'disease', 'infection', 'quarantine',
];

const DISASTER_KEYWORDS = [
  'earthquake', 'tsunami', 'hurricane', 'typhoon', 'flood',
  'wildfire', 'tornado', 'volcanic', 'eruption', 'landslide',
];

const MARKET_KEYWORDS = [
  'stock', 'market crash', 'recession', 'inflation',
  'interest rate', 'fed', 'central bank', 'gdp',
];

const POLITICS_KEYWORDS = [
  'election', 'sanctions', 'coup', 'protest', 'parliament',
  'legislation', 'summit', 'diplomacy', 'treaty', 'veto',
];

// ── Heuristic classifier ──

function detectCategory(title: string): EventCategory {
  const lower = title.toLowerCase();
  if (CONFLICT_KEYWORDS.some(kw => lower.includes(kw))) return 'conflict';
  if (CYBER_KEYWORDS.some(kw => lower.includes(kw))) return 'cyber';
  if (HEALTH_KEYWORDS.some(kw => lower.includes(kw))) return 'health';
  if (DISASTER_KEYWORDS.some(kw => lower.includes(kw))) return 'disaster';
  if (MARKET_KEYWORDS.some(kw => lower.includes(kw))) return 'market';
  if (POLITICS_KEYWORDS.some(kw => lower.includes(kw))) return 'politics';
  return 'general';
}

function detectLevel(category: EventCategory): ThreatLevel {
  switch (category) {
    case 'conflict': return 'high';
    case 'cyber': return 'medium';
    case 'disaster': return 'high';
    case 'health': return 'medium';
    case 'market': return 'low';
    case 'politics': return 'low';
    default: return 'info';
  }
}

/** Keyword-based classification (no ML). */
export function classifyByKeyword(title: string): ThreatClassification {
  const category = detectCategory(title);
  const level = detectLevel(category);
  return {
    level,
    confidence: 0.6,
    category,
    reasoning: `keyword match → ${category}`,
  };
}

/** AI-based classification — currently aliases keyword classifier. */
export async function classifyWithAI(title: string): Promise<ThreatClassification> {
  return classifyByKeyword(title);
}

/** Aggregate threats across a cluster of items. */
export function aggregateThreats(
  items: Array<{ threat?: ThreatClassification; title?: string }>,
): ThreatClassification | undefined {
  const threats = items
    .map(i => i.threat ?? (i.title ? classifyByKeyword(i.title) : undefined))
    .filter((t): t is ThreatClassification => t != null && t.level !== 'info');

  if (threats.length === 0) return undefined;

  // Pick highest-priority threat
  threats.sort((a, b) => (THREAT_PRIORITY[b.level] ?? 0) - (THREAT_PRIORITY[a.level] ?? 0));
  return threats[0];
}
