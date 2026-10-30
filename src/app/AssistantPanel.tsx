import { useEffect, useState } from 'react';
import type { AssistantContext } from '../core/assistant-context.ts';
import type { EngineClient } from '../engine/client.ts';
import type { ContextRequest } from './farcel/FarcelWorkspace.tsx';
import { FileBadge, Icon } from './ui/Icon.tsx';
import { MenuButton } from './shell/Menu.tsx';

/**
 * Assistant side panel. Not connected to any model in this version: it shows, from real
 * workbook state, the bounded context a future connection would receive. It never sends
 * anything and never fabricates answers or completed tasks.
 */
export function AssistantPanel({ client, request, documentTitle, width, onClose, onResetWidth }: {
  client: EngineClient | null; request: ContextRequest | null; documentTitle: string; width: number;
  onClose(): void; onResetWidth(): void;
}) {
  const [context, setContext] = useState<AssistantContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!client || !request) { setContext(null); return; }
    let live = true;
    const timer = setTimeout(() => {
      client.call('assistantContext', request).then(c => { if (live) { setContext(c); setError(null); } }, e => { if (live) setError(String(e)); });
    }, 300);
    return () => { live = false; clearTimeout(timer); };
  }, [client, request]);

  const size = context ? new TextEncoder().encode(JSON.stringify(context)).length : 0;
  const workbook = documentTitle.replace(/\.farcel$/, '');
  return (
    <aside className="assistant" style={{ width }} aria-label="Assistente">
      <header className="assistant-header">
        <span className="assistant-title"><span className="assistant-spark"><Icon name="sparkle" size={20} strokeWidth={1.3} /></span>Assistente</span>
        <MenuButton label="Opções do assistente" className="icon-button" align="end" items={[
          { id: 'reset', label: 'Largura padrão', onSelect: onResetWidth },
          { id: 'close', label: 'Recolher painel', onSelect: onClose },
        ]}><Icon name="more" size={18} /></MenuButton>
      </header>
      <div className="assistant-scope">
        {context ? <>{workbook} · {context.sheet} · {context.selection}</> : client ? workbook : 'Disponível em Planilhas'}
      </div>
      <div className="assistant-body">
        <section className="assistant-state">
          <span className="assistant-avatar" aria-hidden="true"><Icon name="sparkle" size={18} strokeWidth={1.3} /></span>
          <div>
            <h3>Não conectado</h3>
            <p>A IA ainda não está ligada nesta versão. Nada é enviado e nenhuma resposta é gerada.</p>
          </div>
        </section>
        {error && <p className="panel-hint error">{error}</p>}
        {context && (
          <section className="assistant-context">
            <h4>Contexto que seria enviado</h4>
            <p className="assistant-note">Limitado à amostra abaixo. A base inteira nunca sai do dispositivo.</p>
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
          </section>
        )}
      </div>
      <footer className="composer" aria-disabled="true">
        <textarea disabled placeholder="Assistente não conectado nesta versão" aria-label="Mensagem para o assistente (indisponível)" />
        <div className="composer-row">
          {client && (
            <span className="context-chip" title="Contexto da conversa">
              <FileBadge kind="sheet" size={15} />
              <span>{workbook}{context ? ` · ${context.sheet}` : ''}</span>
            </span>
          )}
          <span className="composer-spacer" />
          <button className="send" disabled aria-label="Enviar (indisponível: assistente não conectado)"><Icon name="send" size={18} strokeWidth={2} /></button>
        </div>
      </footer>
    </aside>
  );
}
