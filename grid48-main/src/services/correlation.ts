/**
 * Correlation service — Stub module.
 *
 * The correlation engine's runtime state was previously managed in this file.
 * It has been consolidated into analysis-core.ts. This module re-exports
 * the canonical types so that existing consumers continue to compile.
 */

export interface CorrelationSignal {
  id: string;
  type: string;
  title: string;
  description: string;
  confidence: number;
  timestamp: Date;
  data: {
    newsVelocity?: number;
    marketChange?: number;
    predictionShift?: number;
    relatedTopics?: string[];
    correlatedEntities?: string[];
    correlatedNews?: string[];
    explanation?: string;
    term?: string;
    baseline?: number;
    multiplier?: number;
    sourceCount?: number;
    [key: string]: unknown;
  };
}
