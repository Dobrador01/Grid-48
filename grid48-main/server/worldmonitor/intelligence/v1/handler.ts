import type { IntelligenceServiceHandler } from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { getRiskScores } from './get-risk-scores';

import { classifyEvent } from './classify-event';
import { getCountryIntelBrief } from './get-country-intel-brief';
import { searchGdeltDocuments } from './search-gdelt-documents';
import { deductSituation } from './deduct-situation';

export const intelligenceHandler: IntelligenceServiceHandler = {
  getRiskScores,

  // getPizzintStatus is defined in the proto but not used in Grid 48
  getPizzintStatus: async () => ({ tensionPairs: [] }),

  classifyEvent,
  getCountryIntelBrief,
  searchGdeltDocuments,
  deductSituation,
};
