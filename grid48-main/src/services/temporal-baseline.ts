/**
 * Temporal Baseline — Stub module.
 *
 * The temporal anomaly detection was previously part of the server-side
 * infrastructure. This stub preserves the type and function signatures
 * so existing consumers compile without changes.
 */

export interface TemporalAnomaly {
  metric: string;
  country: string;
  region: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  deviation: number;
  timestamp: number;
}

/** No-op — server anomalies are no longer consumed locally. */
export function consumeServerAnomalies(): TemporalAnomaly[] {
  return [];
}
