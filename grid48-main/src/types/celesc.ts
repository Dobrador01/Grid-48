/**
 * Celesc Infrastructure Sensor — TypeScript types
 */

export type CelescTendencia = 'ESTÁVEL' | 'PIORANDO' | 'MELHORANDO';

export interface CelescBairro {
  nome: string;
  ucsAfetadas: number;
}

export interface CelescMunicipioPayload {
  nome: string;           // Normalized uppercase, no accents
  totalUcsReal: number;
  ucsAfetadas: number;
  pct: number;
  tendencia: CelescTendencia;
  bairros: CelescBairro[];
  timestampLeitura: string;    // ISO string from Celesc DATA field
}
