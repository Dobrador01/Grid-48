import type { MapLayers } from '@/types';

// Grid 48 commands — quase todo o módulo era do search global WorldMonitor
// (nav:mena, layer:flights, panel:cii, etc.). Grid 48 não tem command
// palette ativa, mas mantemos os tipos exportados pra retro-compat com
// imports remanescentes em search-manager / urlState.

export interface Command {
  id: string;
  keywords: string[];
  label: string;
  icon: string;
  category: 'navigate' | 'layers' | 'panels' | 'view' | 'actions' | 'country';
}

// Presets minimal pro Grid 48 — só celesc + weatherAlerts.
export const LAYER_PRESETS: Record<string, (keyof MapLayers)[]> = {
  all: ['celescOutages', 'weatherAlerts'],
  minimal: ['celescOutages'],
};

// Maps command suffix → actual MapLayers key (sem aliases após cleanup).
export const LAYER_KEY_MAP: Record<string, keyof MapLayers> = {
  celesc: 'celescOutages',
  alerts: 'weatherAlerts',
};

// Lista vazia — Command palette não está ativa em Grid 48.
export const COMMANDS: Command[] = [];
