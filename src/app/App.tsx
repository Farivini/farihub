import { useCallback, useState } from 'react';
import { EngineClient } from '../engine/client.ts';
import { FarcelWorkspace } from './farcel/FarcelWorkspace.tsx';
import type { ContextRequest, WorkspaceStatus } from './farcel/FarcelWorkspace.tsx';
import { AssistantPanel } from './AssistantPanel.tsx';
import { Placeholder } from './Placeholder.tsx';
import { FarivMark, Icon } from './ui/Icon.tsx';

type Space = 'farcel' | 'fardoc' | 'farcanvas';
const SPACES: Array<{ id: Space; label: string }> = [
  { id: 'farcel', label: 'Farcel' },
  { id: 'fardoc', label: 'Fardoc' },
  { id: 'farcanvas', label: 'Farcanvas' },
];

// One engine worker per page (module scope, so StrictMode double renders do not spawn extra workers).
let sharedClient: EngineClient | null = null;
const engineClient = () => {
  if (!sharedClient) {
    sharedClient = new EngineClient();
    // Read-only diagnostics for benchmarks and support (memory, extraction timings).
    const client = sharedClient;
    (window as unknown as { farcelDiagnostics: unknown }).farcelDiagnostics = { stats: () => client.call('stats') };
  }
  return sharedClient;
};

export function App() {
  const client = engineClient();
  const [space, setSpace] = useState<Space>('farcel');
  const [assistantOpen, setAssistantOpen] = useState(() => window.innerWidth >= 1280);
  const [status, setStatus] = useState<WorkspaceStatus>({ title: 'Pasta1.farcel', dirty: false, engine: 'Iniciando motor…', busy: true });
  const [context, setContext] = useState<ContextRequest | null>(null);
  const onStatus = useCallback((s: WorkspaceStatus) => setStatus(s), []);
  const onContext = useCallback((c: ContextRequest) => setContext(c), []);

  return (
    <div className={`app space-${space}`}>
      <nav className="rail" aria-label="Espaços">
        <div className="rail-brand" title="Fariv"><FarivMark /></div>
        {SPACES.map(s => (
          <button key={s.id} className={space === s.id ? 'rail-item active' : 'rail-item'} onClick={() => setSpace(s.id)}
            aria-current={space === s.id ? 'page' : undefined} title={s.label} data-testid={`space-${s.id}`}>
            <Icon name={s.id} size={21} />
            <span>{s.label}</span>
          </button>
        ))}
      </nav>
      <div className="main">
        <header className="titlebar">
          <div className="doc-tabs" role="tablist">
            {space === 'farcel' ? (
              <div className="doc-tab active" role="tab" aria-selected="true" data-testid="doc-tab">
                <Icon name="farcel" size={15} />
                <span>{status.title}</span>
                {status.dirty && <i className="dirty" aria-label="Alterações não salvas" />}
              </div>
            ) : (
              <div className="doc-tab active" role="tab" aria-selected="true"><Icon name={space} size={15} /><span>{SPACES.find(s => s.id === space)!.label}</span></div>
            )}
          </div>
          <div className="titlebar-right">
            {space === 'farcel' && <span className={status.busy ? 'engine-state busy' : 'engine-state'} data-testid="engine-state"><i />{status.engine}</span>}
            <button className={assistantOpen ? 'assistant-toggle on' : 'assistant-toggle'} onClick={() => setAssistantOpen(o => !o)}
              aria-pressed={assistantOpen} title="Assistente"><Icon name="sparkle" size={16} /><span>Assistente</span></button>
          </div>
        </header>
        <div className="workspace">
          <div className="space-host">
            {/* Farcel stays mounted so the workbook survives switching spaces. */}
            <div className="space-pane" hidden={space !== 'farcel'}>
              <FarcelWorkspace client={client} onStatus={onStatus} onContext={onContext} />
            </div>
            {space !== 'farcel' && <Placeholder space={space} />}
          </div>
          {assistantOpen && <AssistantPanel client={client} request={space === 'farcel' ? context : null} onClose={() => setAssistantOpen(false)} />}
        </div>
      </div>
    </div>
  );
}
