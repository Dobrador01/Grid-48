// /api/bootstrap não está provisionado neste deploy (depende de Upstash Redis +
// crons Railway do projeto Worldmonitor original). Mantemos os exports como no-op
// para que panels chamem getHydratedData() e caiam transparentemente para seu
// fetch individual.

export function getHydratedData(_key: string): unknown | undefined {
  return undefined;
}

export async function fetchBootstrapData(): Promise<void> {
  return;
}
