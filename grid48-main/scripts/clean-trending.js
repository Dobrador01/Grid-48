const fs = require('fs');
let code = fs.readFileSync('src/services/trending-keywords.ts', 'utf8');

// remove mlWorker import
code = code.replace(/import \{ mlWorker \} from '\.\/ml-worker';\r?\n/, '');

// remove interfaces
code = code.replace(/interface PendingMLEnrichmentHeadline \{[\s\S]*?\}\r?\n\r?\n/, '');
code = code.replace(/interface MLEntity \{[\s\S]*?\}\r?\n\r?\n/, '');

// remove constants
code = code.replace(/const ML_ENTITY_MIN_CONFIDENCE = 0\.75;\r?\n/, '');
code = code.replace(/const ML_ENTITY_BATCH_SIZE = 20;\r?\n/, '');
code = code.replace(/const ML_ENTITY_TYPES = new Set\(\['PER', 'ORG', 'LOC', 'MISC'\]\);\r?\n/, '');

// remove ML functions block
// This starts at normalizeEntityType and ends at extractEntitiesWithML
code = code.replace(/function normalizeEntityType\([\s\S]*?async function extractEntitiesWithML\([\s\S]*?\}\r?\n/g, '');

// remove enrichWithMLEntities
code = code.replace(/async function enrichWithMLEntities\([\s\S]*?\}\r?\n\}\r?\n/g, '');

// rewrite isSignificantTerm
code = code.replace(/async function isSignificantTerm\(term: string, headlines: StoredHeadline\[\]\): Promise<boolean> \{[\s\S]*?return isLikelyProperNoun\(term, headlines\);\r?\n\s*\}/, 
`async function isSignificantTerm(term: string, headlines: StoredHeadline[]): Promise<boolean> {
  const lower = term.toLowerCase();

  if (/^(cve-\\\\d{4}-\\\\d{4,}|apt\\\\d+|fin\\\\d+)$/i.test(term)) return true;
  for (const { pattern } of LEADER_PATTERNS) {
    if (pattern.test(term)) return true;
  }

  return isLikelyProperNoun(term, headlines);
}`);

// remove from ingestHeadlines
code = code.replace(/const pendingMLEnrichment: PendingMLEnrichmentHeadline\[\] = \[\];\r?\n/, '');
code = code.replace(/    pendingMLEnrichment\.push\(\{\r?\n      headline,\r?\n      baseTermKeys: new Set\(termCandidates\.keys\(\)\),\r?\n    \}\);\r?\n/, '');
code = code.replace(/  void enrichWithMLEntities\(pendingMLEnrichment, now\);\r?\n/, '');

fs.writeFileSync('src/services/trending-keywords.ts', code);
