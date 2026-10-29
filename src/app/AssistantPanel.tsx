import { useEffect, useState } from 'react';
import type { AssistantContext } from '../core/assistant-context.ts';
import type { EngineClient } from '../engine/client.ts';
import type { ContextRequest } from './farcel/FarcelWorkspace.tsx';
import { Icon } from './ui/Icon.tsx';

/**
 * Assistant side panel. Not connected to any model in this version: it shows, from real
 * workbook state, the bounded context a future connection would receive. It never sends
 * anything and never fabricates answers.
 */
export function AssistantPanel({ client, request, onClose }: { client: EngineClient | null; request: ContextRequest | null; onClose(): void }) {
  const [context, setContext] = useState<AssistantContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!client || !request) return;
    let live = true;
    const timer = setTimeout(() => {
      client.call('assistantContext', request).then(c => { if (live) { setContext(c); setError(null); } }, e => { if (live) setError(String(e)); });
    }, 350);
    return () => { live = false; clearTimeout(timer); };
  }, [client, request]);

  const size = context ? new TextEncoder().encode(JSON.stringify(context)).length : 0;
  return (
    <aside className="assistant" aria-label="Assistente">
      <header className="assistant-header">
        <span className="assistant-title"><Icon name="sparkle" size={16} />Assistente</span>
        <span className="pill">Não conectado</span>
        <button className="icon-button" onClick={onClose} aria-label="Recolher assistente" title="Recolher"><Icon name="panel" size={16} /></button>
      </header>
      <div className="assistant-body">
        <p className="assistant-lead">A IA ainda não está conectada nesta versão. Nada é enviado e nenhuma resposta é gerada.</p>
        <p className="assistant-note">Quando conectada, ela receberá só um contexto limitado — nunca a planilha inteira:</p>
        {error && <p className="panel-hint error">{error}</p>}
        {context && request?.sheet !== undefined && (
          <dl className="context" data-testid="assistant-context">
            <dt>Pasta</dt><dd>{context.workbook}</dd>
            <dt>Planilha</dt><dd>{context.sheet}</dd>
            <dt>Seleção</dt><dd>{context.selection}</dd>
            <dt>Linhas de dados</dt><dd>{context.dataRows.toLocaleString('pt-BR')}</dd>
            <dt>Cabeçalhos</dt><dd>{context.headers.length ? context.headers.join(' · ') : '—'}</dd>
            <dt>Amostra</dt><dd>{context.sample.length} de {context.dataRows.toLocaleString('pt-BR')} linhas (máx. {context.limits.sampleRows})</dd>
            <dt>Dinâmica</dt><dd>{context.pivot ? `${context.pivot.rows.length} linhas agregadas${context.pivot.truncated ? ' (cortado)' : ''}` : '—'}</dd>
            <dt>Tamanho</dt><dd>{(size / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} KiB</dd>
          </dl>
        )}
      </div>
      <footer className="assistant-input">
        <textarea disabled placeholder="Conexão com IA ainda não configurada" aria-label="Mensagem para o assistente (indisponível)" />
      </footer>
    </aside>
  );
}
