import { useCallback, useEffect, useRef, useState } from 'react';
import { EngineClient } from '../engine/client.ts';
import { FILE_EXTENSION } from '../core/file-format.ts';
import { DEFAULT_SEED } from '../core/synthetic.ts';
import { FarcelWorkspace } from './farcel/FarcelWorkspace.tsx';
import type { ContextRequest, Startup, WorkspaceHandle, WorkspaceStatus } from './farcel/FarcelWorkspace.tsx';
import { AssistantPanel } from './AssistantPanel.tsx';
import { Placeholder } from './Placeholder.tsx';
import { FileBadge, Icon } from './ui/Icon.tsx';
import { Wordmark } from './shell/Wordmark.tsx';
import { WindowControls } from './shell/WindowControls.tsx';
import type { WindowControlsApi } from './shell/WindowControls.tsx';
import { SpaceSwitcher } from './shell/SpaceSwitcher.tsx';
import type { Space } from './shell/SpaceSwitcher.tsx';
import { MenuButton } from './shell/Menu.tsx';
import { Dialog } from './shell/Dialog.tsx';
import { SettingsButton } from './shell/SettingsButton.tsx';

interface Doc { id: string; client: EngineClient; startup: Startup }

const INITIAL_STATUS: WorkspaceStatus = { title: 'Pasta1.farcel', dirty: false, saved: false, pristine: true, engine: 'Iniciando motor…', busy: true };
const ASSISTANT_WIDTH = { min: 320, max: 600, initial: 420 };
let nextDoc = 1;
const newDoc = (startup: Startup): Doc => ({ id: `doc${nextDoc++}`, client: new EngineClient(), startup });
// Module scope: StrictMode runs state initializers twice and would start a second worker.
let firstDoc: Doc | null = null;
const initialDoc = () => (firstDoc ??= newDoc({ kind: 'new' }));

function readWidth(): number {
  try {
    const stored = Number(localStorage.getItem('fariv.assistantWidth'));
    if (stored >= ASSISTANT_WIDTH.min && stored <= ASSISTANT_WIDTH.max) return stored;
  } catch { /* storage unavailable */ }
  return ASSISTANT_WIDTH.initial;
}

/** Desktop builds inject the native window bridge here; the browser has none. */
const nativeWindow = (window as unknown as { farivWindow?: WindowControlsApi }).farivWindow ?? null;

export function App() {
  const [docs, setDocs] = useState<Doc[]>(() => [initialDoc()]);
  const [activeId, setActiveId] = useState(() => docs[0].id);
  const [statuses, setStatuses] = useState<Record<string, WorkspaceStatus>>({});
  const handles = useRef(new Map<string, WorkspaceHandle>());
  const [space, setSpace] = useState<Space>('farcel');
  const [assistantOpen, setAssistantOpen] = useState(() => window.innerWidth >= 1200);
  const [assistantWidth, setAssistantWidth] = useState(readWidth);
  const [context, setContext] = useState<ContextRequest | null>(null);
  const [generator, setGenerator] = useState<{ rows: string; seed: string } | null>(null);
  const [closing, setClosing] = useState<Doc | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const openInput = useRef<HTMLInputElement>(null);
  const active = docs.find(d => d.id === activeId) ?? docs[0];
  // Latest values for callbacks captured by workspaces at mount time.
  const latest = useRef({ docs, active });
  latest.current = { docs, active };
  const activeStatus = statuses[active.id] ?? INITIAL_STATUS;

  // One stable callback per document, so workspaces do not re-report on every shell render.
  const statusCallbacks = useRef(new Map<string, (status: WorkspaceStatus) => void>());
  const statusCallback = (id: string) => {
    let callback = statusCallbacks.current.get(id);
    if (!callback) {
      callback = status => setStatuses(s => ({ ...s, [id]: status }));
      statusCallbacks.current.set(id, callback);
    }
    return callback;
  };
  const onContext = useCallback((c: ContextRequest) => setContext(c), []);

  // Read-only diagnostics of the visible workbook (memory, extraction timings) for benchmarks.
  useEffect(() => {
    (window as unknown as { farcelDiagnostics: unknown }).farcelDiagnostics = { stats: () => active.client.call('stats') };
  }, [active]);

  useEffect(() => {
    try { localStorage.setItem('fariv.assistantWidth', String(assistantWidth)); } catch { /* storage unavailable */ }
  }, [assistantWidth]);

  const addDoc = (startup: Startup) => {
    const doc = newDoc(startup);
    setDocs(d => [...d, doc]);
    setActiveId(doc.id);
    setSpace('farcel');
  };

  const closeDoc = (doc: Doc, force = false) => {
    // The handle also sees an edit still on its way to the engine (submitted when the
    // cell editor lost focus to this click), which the status has not reported yet.
    const unsaved = statuses[doc.id]?.dirty || handles.current.get(doc.id)?.hasUnsavedWork();
    if (!force && unsaved) { setClosing(doc); return; }
    doc.client.terminate();
    handles.current.delete(doc.id);
    statusCallbacks.current.delete(doc.id);
    const { docs: current, active: shown } = latest.current;
    const rest = current.filter(d => d.id !== doc.id);
    const next = rest.length ? rest : [newDoc({ kind: 'new' })];
    setDocs(next);
    if (doc.id === shown.id || rest.length === 0) setActiveId(next[Math.max(0, Math.min(current.indexOf(doc) - 1, next.length - 1))].id);
    setStatuses(s => { const copy = { ...s }; delete copy[doc.id]; return copy; });
  };

  const openFile = (file: File) => {
    if (activeStatus.pristine && handles.current.has(active.id)) {
      setSpace('farcel');
      void handles.current.get(active.id)!.openFile(file);
    } else addDoc({ kind: 'open', file });
  };

  const save = () => { setSpace('farcel'); void handles.current.get(active.id)?.save(); };

  // Global shortcuts go to the visible workbook only.
  const shortcuts = useRef({ save, open: () => openInput.current?.click() });
  shortcuts.current = { save, open: () => openInput.current?.click() };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 's') { event.preventDefault(); shortcuts.current.save(); }
      if (key === 'o') { event.preventDefault(); shortcuts.current.open(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Assistant width: drag the left edge or use the arrow keys on it.
  const startResize = (event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = assistantWidth;
    const onMove = (move: PointerEvent) => {
      setAssistantWidth(Math.min(ASSISTANT_WIDTH.max, Math.max(ASSISTANT_WIDTH.min, startWidth + startX - move.clientX)));
    };
    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); document.body.classList.remove('resizing'); };
    document.body.classList.add('resizing');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const fileMenu = [
    { id: 'new', label: 'Nova planilha', icon: <Icon name="plus" size={16} />, onSelect: () => addDoc({ kind: 'new' }) },
    { id: 'open', label: 'Abrir…', hint: 'Ctrl+O', icon: <Icon name="open" size={16} />, onSelect: () => openInput.current?.click() },
    { id: 'save', label: 'Salvar', hint: 'Ctrl+S', icon: <Icon name="save" size={16} />, disabled: activeStatus.busy && activeStatus.engine.startsWith('Gerando'), onSelect: save },
    { id: 'base', label: 'Base de teste…', separatorBefore: true, icon: <Icon name="base" size={16} />, onSelect: () => setGenerator({ rows: '1.000.000', seed: String(DEFAULT_SEED) }) },
  ];

  return (
    <div className={`app space-${space}`}>
      <header className="titlebar">
        <div className="titlebar-left">
          <WindowControls api={nativeWindow} />
          <span className="brand"><Wordmark height={20} /></span>
        </div>
        <SpaceSwitcher space={space} onChange={setSpace} />
        <div className="titlebar-right">
          <button className={assistantOpen ? 'assistant-toggle on' : 'assistant-toggle'} onClick={() => setAssistantOpen(o => !o)}
            aria-pressed={assistantOpen} aria-label={assistantOpen ? 'Recolher assistente' : 'Mostrar assistente'} title="Assistente" data-testid="assistant-toggle">
            <Icon name="sparkle" size={17} strokeWidth={1.4} />
          </button>
        </div>
      </header>

      <div className="body">
        <nav className="rail" aria-label="Navegação">
          <MenuButton label="Arquivos" className="rail-button active" items={fileMenu} placement="right" testId="files-menu">
            <Icon name="files" size={21} />
          </MenuButton>
          <span className="rail-spacer" />
          <SettingsButton client={active.client} />
        </nav>

        <main className="workspace">
          <div className="space-host" hidden={space !== 'farcel'}>
            <div className="doc-tabs" role="tablist" aria-label="Pastas abertas">
              {docs.map(doc => {
                const status = statuses[doc.id] ?? INITIAL_STATUS;
                const selected = doc.id === active.id;
                return (
                  <div key={doc.id} className={selected ? 'doc-tab active' : 'doc-tab'} data-testid="doc-tab">
                    <button role="tab" aria-selected={selected} className="doc-tab-main" onClick={() => setActiveId(doc.id)} title={status.title}>
                      <FileBadge kind="sheet" />
                      <span className="doc-title">{status.title.replace(new RegExp(`\\${FILE_EXTENSION}$`), '')}</span>
                    </button>
                    {status.dirty && <i className="dirty" title="Alterações não salvas" />}
                    <button className="doc-close" aria-label={`Fechar ${status.title}`} onClick={() => closeDoc(doc)}><Icon name="close" size={14} /></button>
                  </div>
                );
              })}
              <button className="doc-new" aria-label="Nova planilha" title="Nova planilha" onClick={() => addDoc({ kind: 'new' })}><Icon name="plus" size={18} /></button>
            </div>
            {docs.map(doc => (
              <div key={doc.id} className="doc-pane" hidden={doc.id !== active.id}>
                <FarcelWorkspace
                  ref={handle => { if (handle) handles.current.set(doc.id, handle); }}
                  client={doc.client}
                  startup={doc.startup}
                  active={doc.id === active.id && space === 'farcel'}
                  onStatus={statusCallback(doc.id)}
                  onContext={onContext}
                  onStartupFailed={message => { closeDoc(doc, true); setNotice(message); }}
                />
              </div>
            ))}
          </div>
          {space !== 'farcel' && <Placeholder space={space} />}
        </main>

        {assistantOpen && (
          <>
            <div className="assistant-resizer" role="separator" aria-orientation="vertical" aria-label="Largura do assistente"
              aria-valuemin={ASSISTANT_WIDTH.min} aria-valuemax={ASSISTANT_WIDTH.max} aria-valuenow={assistantWidth} tabIndex={0}
              onPointerDown={startResize}
              onDoubleClick={() => setAssistantWidth(ASSISTANT_WIDTH.initial)}
              onKeyDown={e => {
                if (e.key === 'ArrowLeft') setAssistantWidth(w => Math.min(ASSISTANT_WIDTH.max, w + 20));
                if (e.key === 'ArrowRight') setAssistantWidth(w => Math.max(ASSISTANT_WIDTH.min, w - 20));
              }} />
            <AssistantPanel
              width={assistantWidth}
              client={space === 'farcel' ? active.client : null}
              request={space === 'farcel' ? context : null}
              documentTitle={activeStatus.title}
              onClose={() => setAssistantOpen(false)}
              onResetWidth={() => setAssistantWidth(ASSISTANT_WIDTH.initial)}
            />
          </>
        )}
      </div>

      <input ref={openInput} type="file" accept={`${FILE_EXTENSION},.xlsx`} hidden data-testid="open-input"
        onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) openFile(file); }} />

      {generator && (
        <Dialog title="Base sintética de vendas" testId="generator" onClose={() => setGenerator(null)} actions={<>
          <button type="button" onClick={() => setGenerator(null)}>Cancelar</button>
          <button type="button" className="primary" onClick={() => {
            const rows = Number(generator.rows.replace(/\D/g, ''));
            const seed = Number(generator.seed.replace(/\D/g, ''));
            setGenerator(null);
            addDoc({ kind: 'generate', rows, seed });
          }}>Gerar em nova aba</button>
        </>}>
          <p>Cria uma pasta nova com a planilha <strong>Dados</strong> (Região, Canal, Categoria, Quantidade, Receita), todas as linhas preenchidas, e a planilha <strong>Resumo</strong> com SOMA, SOMASE e CONT.VALORES sobre a base. Mesma semente, mesmos dados.</p>
          <label>Linhas<input name="rows" value={generator.rows} onChange={e => setGenerator({ ...generator, rows: e.target.value })} inputMode="numeric" /></label>
          <label>Semente<input name="seed" value={generator.seed} onChange={e => setGenerator({ ...generator, seed: e.target.value })} inputMode="numeric" /></label>
        </Dialog>
      )}

      {notice && (
        <div className="notice" role="alert" data-testid="notice">
          <span>{notice}</span>
          <button className="icon-button" aria-label="Fechar aviso" onClick={() => setNotice(null)}><Icon name="close" size={14} /></button>
        </div>
      )}

      {closing && (
        <Dialog title="Fechar sem salvar?" testId="confirm-close" onClose={() => setClosing(null)} actions={<>
          <button type="button" onClick={() => setClosing(null)}>Cancelar</button>
          <button type="button" className="danger" onClick={() => { const doc = closing; setClosing(null); closeDoc(doc, true); }}>Fechar sem salvar</button>
        </>}>
          <p>{(statuses[closing.id] ?? INITIAL_STATUS).title} tem alterações que não foram salvas neste dispositivo.</p>
        </Dialog>
      )}
    </div>
  );
}
