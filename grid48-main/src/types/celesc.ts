/**
 * Celesc Infrastructure Sensor — TypeScript types
 */

export type CelescTendencia = 'ESTÁVEL' | 'PIORANDO' | 'MELHORANDO';

export interface CelescBairro {
  nome: string;
  ucs: number;
}

export interface CelescMunicipioPayload {
  municipio: string;           // Normalized uppercase, no accents
  totalUcs: number;
  ucsAfetadas: number;
  porcentagemAfetada: number;
  tendenciaDelta: CelescTendencia;
  bairrosAfetados: CelescBairro[];
  timestampLeitura: string;    // ISO string from Celesc DATA field
}
