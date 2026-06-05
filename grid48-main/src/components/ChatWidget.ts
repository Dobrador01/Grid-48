import { Panel } from './Panel';
import { getOrCreateConvexClient } from '@/services/beacon-client';
import { escapeHtml } from '@/utils/sanitize';

// ═══════════════════════════════════════════════════════════════════════════
// ChatWidget — chat de texto da malha LoRa (Feature 1)
// ═══════════════════════════════════════════════════════════════════════════
//
// Conversa em grupo (broadcast) no canal selecionado. Toggle Privado (canal 0)
// ⇄ Público (canal 1). Persistência + reatividade vêm do Convex
// (queries:listLoraMessages); o envio vai pela ponte (sendChatText → broadcast).
//
// O esqueleto é montado UMA vez e só a lista de mensagens é repintada — assim
// uma mensagem chegando não apaga o que o usuário está digitando.
//
// Limites assumidos: broadcast de canal NÃO tem confirmação por destinatário
// (decisão do dono); status mostra só "enviado". Leitura real não existe no
// Meshtastic. Só funciona com o rádio conectado (envio); o histórico aparece
// sempre (persistido no Convex).
// ═══════════════════════════════════════════════════════════════════════════

interface ChatMsg {
  _id: string;
  from_node: string;
  to_node?: string;
  text: string;
  timestamp: number;
  direction: string; // "rx" | "tx"
}

const CHANNELS: Array<{ index: number; label: string }> = [
  { index: 0, label: '🔒 Privado' },
  { index: 1, label: '🌐 Público' },
];

export class ChatWidget extends Panel {
  private channelIndex = 0;
  private messages: ChatMsg[] = [];
  private unsub: (() => void) | null = null;
  private unsubLabels: (() => void) | null = null;
  private sending = false;
  private radioConnected = false;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  // Id (!hex) do nó local → marca "Você". Mapa node_id → nome amigável (rótulo
  // ou longName) → mostra nome em vez do !hex cru.
  private localNodeId: string | null = null;
  private nameMap = new Map<string, string>();

  constructor() {
    super({ id: 'lora-chat', title: 'Chat LoRa' });
    this.build();

    // Delegação de clique: toggle de canal + botão enviar.
    this.content.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      const ch = target?.closest<HTMLElement>('[data-chat-channel]');
      if (ch) { this.setChannel(Number(ch.dataset.chatChannel)); return; }
      if (target?.closest('[data-action="chat-send"]')) { void this.send(); return; }
    });
    // Enter envia (Shift+Enter quebra linha não se aplica — input single-line).
    this.content.addEventListener('keydown', (e) => {
      const el = e.target as HTMLElement | null;
      if (el?.id !== 'chatInput') return;
      if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); void this.send(); }
    });

    this.subscribe();
    this.subscribeNames();
    this.updateMessages();
    void this.refreshRadioConnected();
    this.statusTimer = setInterval(() => void this.refreshRadioConnected(), 3_000);
  }

  public destroy(): void {
    this.unsub?.();
    this.unsub = null;
    this.unsubLabels?.();
    this.unsubLabels = null;
    if (this.statusTimer) { clearInterval(this.statusTimer); this.statusTimer = null; }
  }

  // Nomes: rótulos locais (getLatestTelemetry.label, reativo) + longName da
  // vizinhança (bridge). Resolve node_id → nome amigável no chat.
  private subscribeNames(): void {
    const client = getOrCreateConvexClient();
    if (!client) return;
    const c = client as unknown as {
      onUpdate: (name: string, args: unknown, cb: (data: unknown) => void) => (() => void);
    };
    this.unsubLabels = c.onUpdate('queries:getLatestTelemetry', {}, (data) => {
      if (!Array.isArray(data)) return;
      for (const n of data as Array<{ node_id?: string; label?: string }>) {
        if (n.node_id && n.label && n.label.trim()) this.nameMap.set(n.node_id, n.label.trim());
      }
      this.updateMessages();
    });
  }

  // ── Subscription reativa (re-assina ao trocar de canal) ──────────────────
  private subscribe(): void {
    this.unsub?.();
    this.unsub = null;
    const client = getOrCreateConvexClient();
    if (!client) return;
    const c = client as unknown as {
      onUpdate: (name: string, args: unknown, cb: (data: unknown) => void) => (() => void);
    };
    this.unsub = c.onUpdate('queries:listLoraMessages', { channel_index: this.channelIndex }, (data) => {
      this.messages = Array.isArray(data) ? (data as ChatMsg[]) : [];
      this.updateMessages();
    });
  }

  private setChannel(idx: number): void {
    if (idx === this.channelIndex) return;
    this.channelIndex = idx;
    this.messages = [];
    this.subscribe();
    this.updateToggle();
    this.updateMessages();
    this.updateSendState();
  }

  private async refreshRadioConnected(): Promise<void> {
    try {
      const bridge = await import('@/services/meshtastic-bridge');
      const conn = bridge.isRadioConnected();
      if (conn !== this.radioConnected) { this.radioConnected = conn; this.updateSendState(); }
      // Id local (pra marcar "Você") + nomes da vizinhança (longName) como
      // fallback ao rótulo. Só quando conectado (a ponte tem o dado).
      if (conn) {
        const lid = bridge.getLocalNodeId();
        if (lid && lid !== this.localNodeId) { this.localNodeId = lid; this.updateMessages(); }
        let changed = false;
        for (const n of bridge.getMeshNodes()) {
          const nm = n.longName?.trim() || n.shortName?.trim();
          if (nm && !this.nameMap.has(n.id)) { this.nameMap.set(n.id, nm); changed = true; }
        }
        if (changed) this.updateMessages();
      }
    } catch { /* ponte ainda não carregada */ }
  }

  private async send(): Promise<void> {
    const input = this.content.querySelector<HTMLInputElement>('#chatInput');
    const text = input?.value.trim() ?? '';
    if (!text || this.sending || !this.radioConnected) return;
    this.sending = true;
    this.updateSendState();
    try {
      const bridge = await import('@/services/meshtastic-bridge');
      await bridge.sendChatText(text, this.channelIndex);
      if (input) input.value = '';
    } catch (e) {
      const st = this.content.querySelector<HTMLElement>('#chatStatus');
      if (st) { st.textContent = e instanceof Error ? e.message : 'Falha ao enviar.'; st.style.color = '#dc2626'; }
    } finally {
      this.sending = false;
      this.updateSendState();
      input?.focus();
    }
  }

  // ── Render: esqueleto uma vez, partes atualizadas ────────────────────────
  private build(): void {
    const toggles = CHANNELS.map((c) => `
      <button type="button" data-chat-channel="${c.index}"
        style="flex:1;cursor:pointer;font-size:11px;font-weight:600;padding:5px 8px;border:1px solid var(--overlay-medium,rgba(0,0,0,0.12));border-radius:6px;background:var(--overlay-medium,rgba(0,0,0,0.04));color:var(--text-primary,inherit);">
        ${c.label}
      </button>`).join('');

    this.content.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%;min-height:240px;gap:8px;">
        <div id="chatToggle" style="display:flex;gap:6px;">${toggles}</div>
        <div id="chatMessages" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:5px;padding:4px 2px;min-height:120px;"></div>
        <div style="display:flex;gap:6px;align-items:center;">
          <input type="text" id="chatInput" maxlength="200" placeholder="Mensagem…"
            style="flex:1;min-width:0;font-size:12px;padding:6px 8px;border-radius:6px;border:1px solid var(--overlay-medium,rgba(0,0,0,0.2));background:var(--bg-primary,#fff);color:var(--text-primary,inherit);">
          <button type="button" data-action="chat-send"
            style="cursor:pointer;font-size:12px;font-weight:600;padding:6px 12px;border-radius:6px;border:none;background:var(--accent,#2563eb);color:#fff;">➤</button>
        </div>
        <div id="chatStatus" style="font-size:10px;color:var(--text-dim,#6b7280);min-height:12px;"></div>
      </div>`;

    this.updateToggle();
    this.updateSendState();
  }

  private updateToggle(): void {
    this.content.querySelectorAll<HTMLElement>('[data-chat-channel]').forEach((btn) => {
      const active = Number(btn.dataset.chatChannel) === this.channelIndex;
      btn.style.background = active ? 'rgba(37,99,235,0.15)' : 'var(--overlay-medium,rgba(0,0,0,0.04))';
      btn.style.borderColor = active ? 'var(--accent,#2563eb)' : 'var(--overlay-medium,rgba(0,0,0,0.12))';
    });
  }

  private updateMessages(): void {
    const box = this.content.querySelector<HTMLElement>('#chatMessages');
    if (!box) return;
    if (this.messages.length === 0) {
      box.innerHTML = `<div style="font-size:11px;color:var(--text-dim,#6b7280);margin:auto;text-align:center;">Sem mensagens neste canal ainda.</div>`;
      return;
    }
    box.innerHTML = this.messages.map((m) => this.renderMsg(m)).join('');
    box.scrollTop = box.scrollHeight;
  }

  private renderMsg(m: ChatMsg): string {
    // "Você" = mensagem do NÓ LOCAL (independe de ter sido enviada pelo Grid 48
    // ou pelo app do celular). Fallback p/ direction tx se ainda não temos o id.
    const mine = this.localNodeId ? m.from_node === this.localNodeId : m.direction === 'tx';
    const who = mine ? 'Você' : (this.nameMap.get(m.from_node) ?? m.from_node);
    const time = new Date(m.timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const align = mine ? 'flex-end' : 'flex-start';
    const bg = mine ? 'rgba(37,99,235,0.12)' : 'var(--overlay-medium,rgba(0,0,0,0.05))';
    return `
      <div style="display:flex;justify-content:${align};">
        <div style="max-width:85%;padding:5px 8px;border-radius:8px;background:${bg};">
          <div style="font-size:9.5px;color:var(--text-dim,#6b7280);margin-bottom:1px;">${escapeHtml(who)} · ${time}${mine ? ' · ✓' : ''}</div>
          <div style="font-size:12px;color:var(--text-primary,inherit);word-break:break-word;">${escapeHtml(m.text)}</div>
        </div>
      </div>`;
  }

  private updateSendState(): void {
    const btn = this.content.querySelector<HTMLButtonElement>('[data-action="chat-send"]');
    const input = this.content.querySelector<HTMLInputElement>('#chatInput');
    const st = this.content.querySelector<HTMLElement>('#chatStatus');
    const blocked = !this.radioConnected || this.sending;
    if (btn) { btn.disabled = blocked; btn.style.opacity = blocked ? '0.5' : '1'; btn.style.cursor = blocked ? 'not-allowed' : 'pointer'; }
    if (input) input.disabled = !this.radioConnected;
    if (st) {
      st.style.color = 'var(--text-dim,#6b7280)';
      st.textContent = this.sending ? 'Enviando…'
        : !this.radioConnected ? 'Conecte o rádio (painel Comando & Controle) para enviar.'
        : `Grupo (broadcast) no canal ${this.channelIndex === 0 ? 'privado' : 'público'}.`;
    }
  }
}
