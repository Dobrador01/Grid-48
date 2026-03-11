/**
 * Research service handler -- thin composition file.
 *
 * Each RPC is implemented in its own file:
 * - list-arxiv-papers.ts    (arXiv Atom XML API)
 * - list-trending-repos.ts  (GitHub trending JSON APIs)
 * - list-hackernews-items.ts (HN Firebase JSON API)
 * - list-tech-events.ts     (Techmeme ICS + dev.events RSS + curated)
 */

import type { ResearchServiceHandler } from '../../../../src/generated/server/worldmonitor/research/v1/service_server';
import { listArxivPapers } from './list-arxiv-papers';
import { listTrendingRepos } from './list-trending-repos';
import { listHackernewsItems } from './list-hackernews-items';


export const researchHandler: ResearchServiceHandler = {
  listArxivPapers,
  listTrendingRepos,
  listHackernewsItems,

  // listTechEvents is defined in the proto but not used in Grid 48
  listTechEvents: async () => ({ success: true, count: 0, conferenceCount: 0, mappableCount: 0, lastUpdated: '', events: [], error: '' }),
};
