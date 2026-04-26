import { IDataProvider } from './types';
import { ConvexProvider } from './convex-provider';
import { LocalProvider } from './local-provider';

// Define the global to prevent TS errors if it isn't typed yet
declare const __API_MODE__: string;

const mode = typeof __API_MODE__ !== 'undefined' ? __API_MODE__ : 'cloud';

let providerInstance: IDataProvider;

export function getDataProvider(): IDataProvider {
  if (!providerInstance) {
    if (mode === 'local') {
      console.log('[Adapter] Initializing Local Data Provider');
      providerInstance = new LocalProvider();
    } else {
      console.log('[Adapter] Initializing Cloud Data Provider (Convex)');
      providerInstance = new ConvexProvider();
    }
  }
  return providerInstance;
}
