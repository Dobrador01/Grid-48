import { Panel } from './Panel';
import { getDataProvider } from '@/adapters';

const CATEGORIAS: Array<{ value: number; label: string }> = [
  { value: 1, label: 'ENERGIA' },
  { value: 2, label: 'CLIMA' },
  { value: 3, label: 'MOBILIDADE' },
];

const LOCALIDADES: Array<{ value: number; label: string }> = [
  { value: 1, label: 'Florianópolis' },
  { value: 2, label: 'São José' },
  { value: 3, label: 'Palhoça' },
  { value: 4, label: 'Biguaçu' },
];

const POLL_INTERVAL_MS = 2_000;
const TIMEOUT_MS = 120_000;

type State =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'waiting'; requestId: string; startedAt: number }
  | { kind: 'ready'; requestId: string; valor: number; ttlSeconds: number; receivedAt: number }
  | { kind: 'timeout'; requestId: string }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string };

/**
 * Panel that submits a SITREP request via the adapter and tracks the response.
 * In CLOUD mode the adapter stubs `requestSitrep` to null and we render an
 * "unavailable in cloud" state — no broken interaction.
 */
export class SitrepButton extends Panel {
  private state: State = { kind: 'idle' };
  private categoria = 1;
  private localidade = 1;
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private tickHandle: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super({
      id: 'sitrep',
      title: 'SITREP — Pedido C2',
    });
    this.render();
    this.attach();
  }

  public destroy() {
    this.stopPolling();
  }

  private stopPolling() {
    if (this.pollHandle) { clearInterval(this.pollHandle); this.pollHandle = null; }
    if (this.tickHandle) { clearInterval(this.tickHandle); this.tickHandle = null; }
  }

  private attach() {
    const root = this.content;
    const catSelect = root.querySelector<HTMLSelectElement>('[data-role="cat"]');
    const locSelect = root.querySelector<HTMLSelectElement>('[data-role="loc"]');
    const button = root.querySelector<HTMLButtonElement>('[data-role="send"]');

    catSelect?.addEventListener('change', () => {
      this.categoria = parseInt(catSelect.value, 10) || 1;
    });
    locSelect?.addEventListener('change', () => {
      this.localidade = parseInt(locSelect.value, 10) || 1;
    });
    button?.addEventListener('click', () => void this.send());
  }

  private async send() {
    if (this.state.kind === 'sending' || this.state.kind === 'waiting') return;

    this.state = { kind: 'sending' };
    this.render();
    this.attach();

    const result = await getDataProvider().requestSitrep(this.categoria, this.localidade);
    if (!result) {
      this.state = { kind: 'unavailable' };
      this.render();
      this.attach();
      return;
    }

    this.state = { kind: 'waiting', requestId: result.request_id, startedAt: Date.now() };
    this.render();
    this.attach();
    this.startPolling(result.request_id);
  }

  private startPolling(requestId: string) {
    this.stopPolling();
    this.pollHandle = setInterval(async () => {
      if (this.state.kind !== 'waiting') return;
      if (Date.now() - this.state.startedAt > TIMEOUT_MS) {
        this.stopPolling();
        this.state = { kind: 'timeout', requestId };
        this.render();
        this.attach();
        return;
      }

      try {
        const resp = await getDataProvider().getSitrepResponse(requestId);
        if (resp.status === 'ready' && typeof resp.resposta_valor === 'number') {
          this.stopPolling();
          this.state = {
            kind: 'ready',
            requestId,
            valor: resp.resposta_valor,
            ttlSeconds: resp.ttl_seconds ?? 0,
            receivedAt: resp.received_at ?? Math.floor(Date.now() / 1000),
          };
          this.render();
          this.attach();
        }
      } catch (e) {
        // transient failures are tolerated — keep polling until timeout
        console.warn('[SitrepButton] poll error', e);
      }
    }, POLL_INTERVAL_MS);

    // Visual countdown — re-renders every second so the elapsed time stays live
    this.tickHandle = setInterval(() => {
      if (this.state.kind !== 'waiting') return;
      this.render();
      this.attach();
    }, 1_000);
  }

  public render() {
    this.content.innerHTML = this.renderContent();
  }

  protected renderContent(): string {
    return `
      <div class="sitrep-container">
        <div class="sitrep-form">
          <label class="sitrep-label">Categoria</label>
          <select data-role="cat" class="sitrep-select">
            ${CATEGORIAS.map(c => `<option value="${c.value}" ${c.value === this.categoria ? 'selected' : ''}>${c.label}</option>`).join('')}
          </select>
          <label class="sitrep-label">Localidade</label>
          <select data-role="loc" class="sitrep-select">
            ${LOCALIDADES.map(l => `<option value="${l.value}" ${l.value === this.localidade ? 'selected' : ''}>${l.label}</option>`).join('')}
          </select>
          <button data-role="send" class="sitrep-button" ${this.isBusy() ? 'disabled' : ''}>
            ${this.buttonLabel()}
          </button>
        </div>
        <div class="sitrep-status">${this.renderStatus()}</div>
      </div>
    `;
  }

  private isBusy(): boolean {
    return this.state.kind === 'sending' || this.state.kind === 'waiting';
  }

  private buttonLabel(): string {
    switch (this.state.kind) {
      case 'sending':  return 'Enviando…';
      case 'waiting':  return 'Aguardando…';
      default:         return 'Solicitar SITREP';
    }
  }

  private renderStatus(): string {
    switch (this.state.kind) {
      case 'idle':
        return `<span class="sitrep-status-idle">Pronto.</span>`;

      case 'sending':
        return `<span class="sitrep-status-sending">Encaminhando ao gateway…</span>`;

      case 'waiting': {
        const elapsed = Math.floor((Date.now() - this.state.startedAt) / 1000);
        const remaining = Math.max(0, Math.floor((TIMEOUT_MS / 1000) - elapsed));
        const pct = Math.min(100, (elapsed / (TIMEOUT_MS / 1000)) * 100);
        return `
          <div class="sitrep-progress">
            <div class="sitrep-progress-bar" style="width: ${pct}%"></div>
          </div>
          <div class="sitrep-progress-label">
            Aguardando resposta · ${elapsed}s decorridos · ${remaining}s restantes
          </div>
          <div class="sitrep-request-id">id: ${this.state.requestId}</div>
        `;
      }

      case 'ready': {
        const cat = CATEGORIAS.find(c => c.value === this.categoria)?.label ?? '?';
        const loc = LOCALIDADES.find(l => l.value === this.localidade)?.label ?? '?';
        return `
          <div class="sitrep-result">
            <div class="sitrep-result-headline">${cat} · ${loc}</div>
            <div class="sitrep-result-value">${this.state.valor}</div>
            <div class="sitrep-result-meta">TTL ${this.state.ttlSeconds}s · id ${this.state.requestId}</div>
          </div>
        `;
      }

      case 'timeout':
        return `<span class="sitrep-status-error">⏱ Sem resposta em 2 min. Tente de novo.</span>`;

      case 'unavailable':
        return `<span class="sitrep-status-error">SITREP só disponível no modo LOCAL (Engine + rádio).</span>`;

      case 'error':
        return `<span class="sitrep-status-error">Erro: ${this.state.message}</span>`;
    }
  }
}
