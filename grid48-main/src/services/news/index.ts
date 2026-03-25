/**
 * Unified news service module.
 *
 * RSS feed parsing stays client-side (requires DOMParser).
 * Summarization stays via existing edge functions (Groq/OpenRouter).
 * This module re-exports from the legacy files and will migrate
 * to sebuf RPCs as those handlers get implemented.
 */

// RSS feed fetching removed (fat-client DCE - rss module deleted)

// Summarization (client-side with Groq/OpenRouter/Browser T5 fallback)
export { generateSummary, translateText } from '../summarization';
export type { SummarizationResult, SummarizationProvider, ProgressCallback } from '../summarization';
