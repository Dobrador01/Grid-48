import { getOrCreateConvexClient } from '@/services/beacon-client';
import { escapeHtml } from '@/utils/sanitize';

// ═══════════════════════════════════════════════════════════════════════════
// DefconRulesPanel — UI do RuleSet DSL (import/export JSON + histórico)
// ═══════════════════════════════════════════════════════════════════════════
//
// Sem editor visual de blocos (decisão Fase 5): você edita o JSON externamente
// e importa. Painel mostra:
//   - Versão atual + qtd de regras + timestamp
//   - Lista read-only de resumo (nome + categoria + DEFCON-alvo)
//   - Botões Importar JSON / Exportar JSON
//   - Botão "Ver histórico" → modal com versões salvas + restaurar
//
// CSP-friendly: zero inline handlers, tudo via addEventListener delegado.
// Renderiza como `{ html, attach }` (mesmo contrato dos outros painéis Settings).
// ═══════════════════════════════════════════════════════════════════════════

interface RegraResumo {
  id: string;
  nome: string;
  descricao?: string;
  categoria: "energia" | "clima" | "mobilidade" | "combinada";
  prioridade: number;
  ativa: boolean;
  acao: { nivel_defcon: number };
  condicao: any;
}

interface RulesetDoc {
  versao: string;
  atualizado_em: number;
  regras: RegraResumo[];
  regras_count: number;
  erro?: string;
}

interface HistoryEntry {
  _id: string;
  versao: string;
  salvo_em: number;
  regras_count: number;
}

interface RenderResult {
  html: string;
  attach: (root: HTMLElement) => () => void;
}

const CAT_COR: Record<string, string> = {
  energia: '#f59e0b',
  clima: '#0ea5e9',
  mobilidade: '#8b5cf6',
  combinada: '#dc2626',
};

const NIVEL_COR: Record<number, string> = {
  1: '#dc2626', 2: '#ea580c', 3: '#eab308', 4: '#84cc16', 5: '#22c55e',
};

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return 'agora';
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h}h`;
  return `há ${Math.floor(h / 24)}d`;
}

export function renderDefconRulesPanel(): RenderResult {
  const html = `
    <div class="defcon-rules-panel" style="margin-top: 18px; border-top: 1px solid rgba(0,0,0,0.08); padding-top: 14px;">
      <h3 style="margin: 0 0 4px 0; font-size: 0.95rem;">Regras DEFCON (DSL)</h3>
      <p style="margin: 0 0 12px 0; font-size: 0.72rem; color: #6b7280;">
        Fonte de verdade pras regras a partir da Fase 5. Edite o JSON externamente e importe.
        Os campos de threshold acima (regras 6.1–6.3) viraram <em>legacy</em> — agora cada regra
        carrega os próprios valores no JSON.
      </p>

      <div id="rulesStatus" style="font-size: 0.72rem; color: #6b7280; margin-bottom: 10px;">
        Carregando ruleset…
      </div>

      <div style="display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap;">
        <button type="button" id="rulesExport" style="font-size: 0.72rem; padding: 5px 12px; cursor: pointer;">📤 Exportar JSON</button>
        <button type="button" id="rulesImport" style="font-size: 0.72rem; padding: 5px 12px; cursor: pointer;">📥 Importar JSON</button>
        <button type="button" id="rulesHistory" style="font-size: 0.72rem; padding: 5px 12px; cursor: pointer;">📜 Ver histórico</button>
        <input type="file" id="rulesFileInput" accept="application/json,.json" style="display:none">
      </div>

      <div id="rulesList"></div>

      <!-- Modal de import (textarea + erro) -->
      <div id="rulesImportModal" style="display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.5); z-index:9999; align-items:center; justify-content:center;">
        <div style="background:white; padding:20px; border-radius:10px; max-width:700px; width:90%; max-height:80vh; overflow-y:auto;">
          <h4 style="margin:0 0 10px 0;">Importar RuleSet JSON</h4>
          <p style="font-size:0.72rem; color:#6b7280; margin:0 0 8px 0;">Cole o JSON abaixo OU clique "Carregar de arquivo".</p>
          <textarea id="rulesImportText" placeholder='{"versao":"1.0.0","regras":[...]}' style="width:100%; height:260px; font-family:monospace; font-size:0.7rem; box-sizing:border-box;"></textarea>
          <div id="rulesImportError" style="font-size:0.72rem; color:#dc2626; margin-top:8px; white-space:pre-wrap; font-family:monospace; max-height:140px; overflow-y:auto;"></div>
          <div style="display:flex; gap:8px; margin-top:10px; justify-content:flex-end;">
            <button type="button" id="rulesImportCancel" style="padding:5px 12px; cursor:pointer;">Cancelar</button>
            <button type="button" id="rulesImportFile" style="padding:5px 12px; cursor:pointer;">📁 Carregar de arquivo</button>
            <button type="button" id="rulesImportConfirm" style="padding:5px 12px; cursor:pointer; font-weight:600;">Validar + Salvar</button>
          </div>
        </div>
      </div>

      <!-- Modal de histórico -->
      <div id="rulesHistoryModal" style="display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.5); z-index:9999; align-items:center; justify-content:center;">
        <div style="background:white; padding:20px; border-radius:10px; max-width:600px; width:90%; max-height:80vh; overflow-y:auto;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
            <h4 style="margin:0;">Histórico de versões</h4>
            <button type="button" id="rulesHistoryClose" style="padding:4px 10px; cursor:pointer;">✕</button>
          </div>
          <p style="font-size:0.72rem; color:#6b7280; margin:0 0 8px 0;">
            Cada save no editor cria uma versão. Restaurar substitui o ruleset atual e cria nova entrada no histórico.
          </p>
          <div id="rulesHistoryList"></div>
        </div>
      </div>
    </div>
  `;

  const attach = (root: HTMLElement): (() => void) => {
    const client = getOrCreateConvexClient();
    const statusEl = root.querySelector<HTMLElement>('#rulesStatus')!;
    const listEl = root.querySelector<HTMLElement>('#rulesList')!;
    const exportBtn = root.querySelector<HTMLButtonElement>('#rulesExport')!;
    const importBtn = root.querySelector<HTMLButtonElement>('#rulesImport')!;
    const historyBtn = root.querySelector<HTMLButtonElement>('#rulesHistory')!;
    const fileInput = root.querySelector<HTMLInputElement>('#rulesFileInput')!;

    const importModal = root.querySelector<HTMLElement>('#rulesImportModal')!;
    const importText = root.querySelector<HTMLTextAreaElement>('#rulesImportText')!;
    const importError = root.querySelector<HTMLElement>('#rulesImportError')!;
    const importConfirm = root.querySelector<HTMLButtonElement>('#rulesImportConfirm')!;
    const importCancel = root.querySelector<HTMLButtonElement>('#rulesImportCancel')!;
    const importFile = root.querySelector<HTMLButtonElement>('#rulesImportFile')!;

    const historyModal = root.querySelector<HTMLElement>('#rulesHistoryModal')!;
    const historyClose = root.querySelector<HTMLButtonElement>('#rulesHistoryClose')!;
    const historyListEl = root.querySelector<HTMLElement>('#rulesHistoryList')!;

    if (!client) {
      statusEl.textContent = 'Convex não configurado.';
      return () => {};
    }
    const c = client as any;
    let currentRuleset: RulesetDoc | null = null;

    const unsubRuleset = c.onUpdate(
      'defcon/ruleset:getRuleset',
      {},
      (data: RulesetDoc | null) => {
        if (!data) {
          statusEl.textContent = 'Ruleset ainda não inicializado. Disparando recompute pra gerar inicial…';
          return;
        }
        currentRuleset = data;
        statusEl.innerHTML = `Versão <strong>${escapeHtml(data.versao)}</strong> · ${data.regras_count} regras · atualizado ${formatRelative(data.atualizado_em)}${data.erro ? ` <span style="color:#dc2626;">(${escapeHtml(data.erro)})</span>` : ''}`;
        renderList(data.regras);
      },
    );

    function renderList(regras: RegraResumo[]) {
      if (regras.length === 0) {
        listEl.innerHTML = `<div style="font-size:0.72rem; color:#9ca3af; padding:8px;">Nenhuma regra no ruleset.</div>`;
        return;
      }
      // Agrupa por categoria pra leitura mais clara
      const grupos: Record<string, RegraResumo[]> = {};
      for (const r of regras) {
        (grupos[r.categoria] ?? (grupos[r.categoria] = [])).push(r);
      }
      const categoriaOrder = ['combinada', 'clima', 'energia', 'mobilidade'];
      listEl.innerHTML = categoriaOrder.filter(cat => grupos[cat]).map(cat => {
        const cor = CAT_COR[cat] ?? '#6b7280';
        const itens = grupos[cat]!.sort((a, b) => a.prioridade - b.prioridade).map(r => {
          const corNivel = NIVEL_COR[r.acao.nivel_defcon] ?? '#6b7280';
          const inativa = !r.ativa ? ' opacity:0.5;' : '';
          return `
            <div style="display:flex; align-items:center; gap:8px; padding:5px 0; font-size:0.72rem; border-bottom:1px dashed rgba(0,0,0,0.05);${inativa}">
              <span style="display:inline-block; width:22px; height:22px; line-height:22px; text-align:center; background:${corNivel}; color:white; font-weight:800; border-radius:5px; font-size:0.7rem;">${r.acao.nivel_defcon}</span>
              <span style="flex:1; min-width:0;">
                <span style="font-weight:600;">${escapeHtml(r.nome)}</span>${r.descricao ? `<br><span style="color:#6b7280; font-size:0.65rem;">${escapeHtml(r.descricao)}</span>` : ''}
              </span>
              <span style="font-size:0.6rem; color:#9ca3af;">prio ${r.prioridade}</span>
            </div>
          `;
        }).join('');
        return `
          <div style="margin-bottom:10px;">
            <div style="font-size:0.65rem; color:${cor}; text-transform:uppercase; letter-spacing:0.06em; font-weight:700; margin-bottom:4px;">${cat}</div>
            ${itens}
          </div>
        `;
      }).join('');
    }

    // ── Export ──────────────────────────────────────────────────────────
    exportBtn.addEventListener('click', () => {
      if (!currentRuleset) return;
      const payload = JSON.stringify({
        versao: currentRuleset.versao,
        regras: currentRuleset.regras,
      }, null, 2);
      const blob = new Blob([payload], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `grid48-ruleset-v${currentRuleset.versao}-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });

    // ── Import (modal) ──────────────────────────────────────────────────
    importBtn.addEventListener('click', () => {
      importText.value = currentRuleset
        ? JSON.stringify({ versao: currentRuleset.versao, regras: currentRuleset.regras }, null, 2)
        : '';
      importError.textContent = '';
      importModal.style.display = 'flex';
    });
    importCancel.addEventListener('click', () => { importModal.style.display = 'none'; });
    importFile.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        importText.value = String(reader.result ?? '');
      };
      reader.readAsText(file);
      fileInput.value = '';
    });
    importConfirm.addEventListener('click', async () => {
      importError.textContent = '';
      try {
        // Pré-valida JSON.parse aqui pra dar feedback rápido (antes do servidor).
        JSON.parse(importText.value);
      } catch (e: any) {
        importError.textContent = `JSON inválido: ${e?.message ?? e}`;
        return;
      }
      importConfirm.disabled = true;
      try {
        await c.mutation('defcon/ruleset:updateRuleset', { regras_json: importText.value });
        importModal.style.display = 'none';
      } catch (e: any) {
        importError.textContent = e?.message ?? String(e);
      } finally {
        importConfirm.disabled = false;
      }
    });

    // ── Histórico (modal) ───────────────────────────────────────────────
    historyBtn.addEventListener('click', async () => {
      historyListEl.innerHTML = `<div style="font-size:0.72rem; color:#6b7280;">Carregando…</div>`;
      historyModal.style.display = 'flex';
      try {
        const entries: HistoryEntry[] = await c.query('defcon/ruleset:getRulesetHistory', { limit: 50 });
        renderHistory(entries);
      } catch (e: any) {
        historyListEl.innerHTML = `<div style="color:#dc2626; font-size:0.72rem;">Erro: ${escapeHtml(e?.message ?? String(e))}</div>`;
      }
    });
    historyClose.addEventListener('click', () => { historyModal.style.display = 'none'; });

    function renderHistory(entries: HistoryEntry[]) {
      if (entries.length === 0) {
        historyListEl.innerHTML = `<div style="font-size:0.72rem; color:#9ca3af;">Nenhuma versão histórica.</div>`;
        return;
      }
      historyListEl.innerHTML = entries.map((e) => `
        <div data-history-id="${escapeHtml(e._id)}" style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid rgba(0,0,0,0.06); font-size:0.72rem;">
          <div>
            <div style="font-weight:600;">v${escapeHtml(e.versao)} · ${e.regras_count} regras</div>
            <div style="font-size:0.65rem; color:#6b7280;">${new Date(e.salvo_em).toLocaleString('pt-BR')} · ${formatRelative(e.salvo_em)}</div>
          </div>
          <button type="button" class="history-restore" style="font-size:0.7rem; padding:4px 10px; cursor:pointer;">Restaurar</button>
        </div>
      `).join('');
    }

    historyListEl.addEventListener('click', async (ev) => {
      const target = ev.target as HTMLElement;
      if (!target.classList.contains('history-restore')) return;
      const row = target.closest<HTMLElement>('[data-history-id]');
      if (!row) return;
      const historyId = row.dataset.historyId!;
      if (!confirm('Restaurar essa versão? O ruleset atual será sobrescrito (uma cópia da atual será criada no histórico).')) return;
      try {
        target.setAttribute('disabled', 'true');
        await c.mutation('defcon/ruleset:restoreFromHistory', { history_id: historyId });
        historyModal.style.display = 'none';
      } catch (e: any) {
        alert(`Erro ao restaurar: ${e?.message ?? e}`);
      }
    });

    return () => {
      try { unsubRuleset?.(); } catch {}
    };
  };

  return { html, attach };
}
