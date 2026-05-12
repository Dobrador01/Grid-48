import type { ClusteredEvent, VelocityMetrics, VelocityLevel, SentimentType } from '@/types';

const HOUR_MS = 60 * 60 * 1000;
const ELEVATED_THRESHOLD = 3;
const SPIKE_THRESHOLD = 6;

const NEGATIVE_WORDS = new Set([
  'war', 'attack', 'killed', 'death', 'dead', 'crisis', 'crash', 'collapse',
  'threat', 'danger', 'escalate', 'escalation', 'conflict', 'strike', 'bomb',
  'explosion', 'casualties', 'disaster', 'emergency', 'catastrophe', 'fail',
  'failure', 'reject', 'rejected', 'sanctions', 'invasion', 'missile', 'nuclear',
  'terror', 'terrorist', 'hostage', 'assassination', 'coup', 'protest', 'riot',
  'warns', 'warning', 'fears', 'concern', 'worried', 'plunge', 'plummet', 'surge',
  'flee', 'evacuate', 'shutdown', 'layoff', 'layoffs', 'cuts', 'slump', 'recession',
]);

const POSITIVE_WORDS = new Set([
  'peace', 'deal', 'agreement', 'breakthrough', 'success', 'win', 'gains',
  'recovery', 'growth', 'rise', 'surge', 'boost', 'rally', 'soar', 'jump',
  'ceasefire', 'treaty', 'alliance', 'partnership', 'cooperation', 'progress',
  'release', 'released', 'freed', 'rescue', 'saved', 'approved', 'passes',
  'record', 'milestone', 'historic', 'landmark', 'celebrates', 'victory',
]);

function analyzeSentiment(text: string): { sentiment: SentimentType; score: number } {
  const words = text.toLowerCase().split(/\W+/);
  let score = 0;

  for (const word of words) {
    if (NEGATIVE_WORDS.has(word)) score -= 1;
    if (POSITIVE_WORDS.has(word)) score += 1;
  }

  const sentiment: SentimentType = score < -1 ? 'negative' : score > 1 ? 'positive' : 'neutral';
  return { sentiment, score };
}

function calculateVelocityLevel(sourcesPerHour: number): VelocityLevel {
  if (sourcesPerHour >= SPIKE_THRESHOLD) return 'spike';
  if (sourcesPerHour >= ELEVATED_THRESHOLD) return 'elevated';
  return 'normal';
}

export function calculateVelocity(cluster: ClusteredEvent): VelocityMetrics {
  const items = cluster.allItems;

  if (items.length <= 1) {
    const { sentiment, score } = analyzeSentiment(cluster.primaryTitle);
    return { sourcesPerHour: 0, level: 'normal', trend: 'stable', sentiment, sentimentScore: score };
  }

  const timeSpanMs = cluster.lastUpdated.getTime() - cluster.firstSeen.getTime();
  const timeSpanHours = Math.max(timeSpanMs / HOUR_MS, 0.25);
  const sourcesPerHour = items.length / timeSpanHours;

  const midpoint = cluster.firstSeen.getTime() + timeSpanMs / 2;
  const recentItems = items.filter(i => i.pubDate.getTime() > midpoint);
  const olderItems = items.filter(i => i.pubDate.getTime() <= midpoint);

  let trend: 'rising' | 'stable' | 'falling' = 'stable';
  if (recentItems.length > olderItems.length * 1.5) {
    trend = 'rising';
  } else if (olderItems.length > recentItems.length * 1.5) {
    trend = 'falling';
  }

  const allText = items.map(i => i.title).join(' ');
  const { sentiment, score } = analyzeSentiment(allText);

  return {
    sourcesPerHour: Math.round(sourcesPerHour * 10) / 10,
    level: calculateVelocityLevel(sourcesPerHour),
    trend,
    sentiment,
    sentimentScore: score,
  };
}

export function enrichWithVelocity(clusters: ClusteredEvent[]): ClusteredEvent[] {
  return clusters.map(cluster => ({
    ...cluster,
    velocity: calculateVelocity(cluster),
  }));
}


