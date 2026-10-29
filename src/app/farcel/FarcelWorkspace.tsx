import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MAX_COLUMN, MAX_ROW, cellName, columnName, parseRect, rectName } from '../../core/address.ts';
import type { Rect } from '../../core/address.ts';
import { emptyConfig, layoutPivot } from '../../core/pivot.ts';
import { DEFAULT_SEED } from '../../core/synthetic.ts';
import { FILE_EXTENSION, FORMAT_DESCRIPTION } from '../../core/file-format.ts';
import type { EngineClient } from '../../engine/client.ts';
import type { WorkbookInfo } from '../../engine/protocol.ts';
import type { GenerationReport } from '../../engine/workbook-engine.ts';
import { Grid } from './Grid.tsx';
import type { GridController, GridHandle, Selection, SelectionStats } from './Grid.tsx';
import { PivotView } from './PivotView.tsx';
import type { PivotDef, PivotState } from './PivotView.tsx';
import { Icon } from '../ui/Icon.tsx';
import { measure } from '../perf.ts';

export interface ContextRequest { sheet: number; selection: Rect; pivotRows: string[][] | null }
export interface WorkspaceStatus { title: string; dirty: boolean; engine: string; busy: boolean }

type Tab = { kind: 'sheet'; index: number } | { kind: 'pivot'; id: string };

const number = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
const seconds = (ms: number) => `${(ms / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s`;
const mib = (bytes: number | null) => bytes === null ? 'não medida' : `${(bytes / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} MiB`;

interface SaveFilePicker {
  showSaveFilePicker?(options: unknown): Promise<{ name: string; createWritable(): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void> }> }>;
}

export function FarcelWorkspace({ client, onStatus, onContext }: {
  client: EngineClient;
  onStatus(status: WorkspaceStatus): void;
  onContext(request: ContextRequest): void;
}) {
  const grid = useRef<GridHandle>(null);
  const [info, setInfo] = useState<WorkbookInfo | null>(null);
  const [engineName, setEngineName] = useState('Iniciando motor…');
  const [revision, setRevision] = useState(0);
  const [tab, setTab] = useState<Tab>({ kind: 'sheet', index: 0 });
  const [selection, setSelection] = useState<Selection>({ active: { row: 1, column: 1 }, rect: { top: 1, left: 1, bottom: 1, right: 1 } });
  const [stats, setStats] = useState<SelectionStats | null>(null);
  const [editingText, setEditingText] = useState<string | null>(null);
  const [cellInput, setCellInput] = useState('');
  const [formulaDraft, setFormulaDraft] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [message, setMessage] = useState<{ text: string; tone: 'info' | 'error' } | null>(null);
  const [progress, setProgress] = useState<{ label: string; done: number; total: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [pivots, setPivots] = useState<PivotDef[]>([]);
  const [pivotStates, setPivotStates] = useState<Record<string, PivotState>>({});
  const [fields, setFields] = useState<{ sheet: number; names: string[]; rows: number } | null>(null);
  const [generator, setGenerator] = useState<{ rows: string; seed: string } | null>(null);
  const [report, setReport] = useState<GenerationReport | null>(null);
  const openInput = useRef<HTMLInputElement>(null);
  const sheet = tab.kind === 'sheet' ? tab.index : pivots.find(p => p.id === tab.id)?.sheet ?? 0;

  const fail = useCallback((error: unknown) => {
    setMessage({ text: error instanceof Error ? error.message : String(error), tone: 'error' });
  }, []);

  // Engine lifecycle and events
  useEffect(() => {
    const off = client.on(event => {
      if (event.event === 'changed') { setRevision(r => r + 1); setDirty(true); }
      else setProgress({ label: event.task === 'generate' ? 'Gerando base' : event.task === 'pivot' ? `Lendo ${event.label}` : 'Abrindo', done: event.done, total: event.total });
    });
    client.call('init').then(result => {
      setInfo(result);
      setEngineName(result.engine);
      setDirty(false);
    }, fail);
    return () => { off(); };
  }, [client, fail]);

  const inFlight = useRef(0);
  const track = useCallback(<T,>(promise: Promise<T>): Promise<T> => {
    inFlight.current++;
    setPending(p => p + 1);
    return promise.then(result => {
      if (result && typeof result === 'object' && 'sheets' in result) setInfo(result as unknown as WorkbookInfo);
      return result;
    }).catch(error => { fail(error); throw error; }).finally(() => { inFlight.current--; setPending(p => p - 1); });
  }, [fail]);

  // Sheet grid controller: every read and write goes to the engine worker.
  const controller = useMemo<GridController>(() => ({
    key: `sheet-${sheet}-${info?.name ?? ''}`,
    revision,
    rowCount: MAX_ROW,
    columnCount: MAX_COLUMN,
    readOnly: !!busy,
    pending: () => inFlight.current > 0,
    columnWidth: () => 104,
    columnLabel: columnName,
    fetch: (top, left, rows, columns) => client.call('viewport', { sheet, top, left, rows, columns }),
    getInput: cell => client.call('input', { sheet, row: cell.row, column: cell.column }),
    commit: async (cell, text) => {
      const started = performance.now();
      const result = await track(client.call('setInput', { sheet, row: cell.row, column: cell.column, text }));
      measure('engine:setInput', started, { engineMs: result.ms, sheet, row: cell.row, column: cell.column });
    },
    clear: async rect => { await track(client.call('clear', { sheet, rect })); },
    paste: async (origin, text) => {
      const started = performance.now();
      const result = await track(client.call('paste', { sheet, origin, text }));
      measure('engine:paste', started, { engineMs: result.ms });
      if (result.rect) grid.current?.select(origin, result.rect);
    },
    copy: rect => client.call('copy', { sheet, rect }),
    undo: async () => { await track(client.call('undo')); },
    redo: async () => { await track(client.call('redo')); },
    edge: (from, direction) => client.call('edge', { sheet, from, direction }),
  }), [client, sheet, revision, info?.name, busy, track]);

  // Formula bar content follows the active cell.
  useEffect(() => {
    if (tab.kind !== 'sheet' || !info) return;
    let live = true;
    client.call('input', { sheet, row: selection.active.row, column: selection.active.column }).then(text => { if (live) setCellInput(text); }, () => {});
    return () => { live = false; };
  }, [client, sheet, selection.active.row, selection.active.column, revision, tab.kind, info]);

  // Selection statistics from the grid's view cache (no full-sheet scan on the main thread).
  useEffect(() => {
    const update = () => setStats(grid.current?.stats(selection.rect) ?? null);
    update();
    const timer = setTimeout(update, 200);
    return () => clearTimeout(timer);
  }, [selection, revision]);

  // Pivot fields for the source sheet of the active pivot.
  const activePivot = tab.kind === 'pivot' ? pivots.find(p => p.id === tab.id) ?? null : null;
  useEffect(() => {
    if (!activePivot || !info) return;
    let live = true;
    client.call('pivotFields', { sheet: activePivot.sheet }).then(f => { if (live) setFields({ sheet: activePivot.sheet, names: f.fields, rows: f.rows }); }, fail);
    return () => { live = false; };
  }, [client, activePivot?.sheet, activePivot?.id, revision, info, fail]); // eslint-disable-line

  // Pivot recalculation: on config change, and after engine edits while the pivot is visible.
  const pivotRequest = useRef(0);
  useEffect(() => {
    if (!activePivot || busy) return;
    const config = activePivot.config;
    const configKey = JSON.stringify(config);
    const state = pivotStates[activePivot.id];
    if (state && state.revision === revision && state.configKey === configKey && !state.loading) return;
    if (config.values.length === 0 && config.rows.length === 0 && config.columns.length === 0) return;
    const id = activePivot.id;
    const request = ++pivotRequest.current;
    const timer = setTimeout(() => {
      setPivotStates(s => ({ ...s, [id]: { ...(s[id] ?? { result: null, table: null, error: null, revision, configKey, version: 0 }), loading: true, progress: null } }));
      const started = performance.now();
      client.call('pivot', { sheet: activePivot.sheet, config }).then(result => {
        measure('pivot:compute', started, { extractMs: result.extractMs, aggregateMs: result.aggregateMs, sourceRows: result.sourceRows, config: configKey, current: request === pivotRequest.current });
        if (request !== pivotRequest.current) return;
        setProgress(null);
        setPivotStates(s => ({ ...s, [id]: { result, table: layoutPivot(result), error: null, loading: false, progress: null, revision, configKey, version: (s[id]?.version ?? 0) + 1 } }));
      }, error => {
        if (request !== pivotRequest.current) return;
        setProgress(null);
        setPivotStates(s => ({ ...s, [id]: { result: null, table: null, error: error instanceof Error ? error.message : String(error), loading: false, progress: null, revision, configKey, version: (s[id]?.version ?? 0) + 1 } }));
      });
    }, 150);
    return () => clearTimeout(timer);
  }, [client, activePivot, revision, busy]); // eslint-disable-line

  // Assistant context request (bounded; built in the worker).
  useEffect(() => {
    const state = activePivot ? pivotStates[activePivot.id] : undefined;
    onContext({ sheet, selection: selection.rect, pivotRows: state?.table?.rows ?? null });
  }, [sheet, selection, activePivot, pivotStates, onContext]);

  // Status for the shell
  useEffect(() => {
    const title = (fileName ?? `${info?.name ?? 'Pasta1'}${FILE_EXTENSION}`);
    const engine = busy ? busy : pending > 0 ? 'Calculando…' : engineName;
    onStatus({ title, dirty, engine, busy: !!busy || pending > 0 });
  }, [fileName, info?.name, dirty, busy, pending, engineName, onStatus]);

  // Enter commits and then blurs the input; the ref stops the blur from committing twice.
  const formulaDraftRef = useRef<string | null>(null);
  formulaDraftRef.current = formulaDraft;
  const commitFormula = () => {
    const text = formulaDraftRef.current;
    if (text === null || tab.kind !== 'sheet') return;
    formulaDraftRef.current = null;
    setFormulaDraft(null);
    controller.commit?.(selection.active, text).catch(() => {});
    grid.current?.focus();
  };

  const goTo = (text: string) => {
    const rect = parseRect(text);
    setNameDraft(null);
    if (rect) grid.current?.select({ row: rect.top, column: rect.left }, rect);
    else setMessage({ text: `Referência inválida: ${text}`, tone: 'error' });
    grid.current?.focus();
  };

  // Files
  const save = useCallback(async () => {
    if (busy) return;
    try {
      const started = performance.now();
      const { bytes, ms } = await track(client.call('save', { app: { pivots, activeTab: tab } }));
      measure('engine:save', started, { engineMs: ms, bytes: bytes.length });
      const name = fileName ?? `${info?.name ?? 'Pasta1'}${FILE_EXTENSION}`;
      const picker = window as unknown as SaveFilePicker;
      let savedName = name;
      if (picker.showSaveFilePicker && !navigator.webdriver) {
        const handle = await picker.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Pasta de trabalho Farcel', accept: { 'application/x-farcel': [FILE_EXTENSION] } }] });
        const writable = await handle.createWritable();
        await writable.write(bytes);
        await writable.close();
        savedName = handle.name;
      } else {
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/x-farcel' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }
      setFileName(savedName);
      setDirty(false);
      setMessage({ text: `Salvo ${savedName} · ${mib(bytes.length)} · ${seconds(ms)}. ${FORMAT_DESCRIPTION}`, tone: 'info' });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) fail(error);
    }
  }, [busy, client, fileName, info?.name, pivots, tab, track, fail]);

  const openFile = async (file: File) => {
    if (dirty && !window.confirm('Descartar alterações não salvas?')) return;
    if (!file.name.toLowerCase().endsWith(FILE_EXTENSION)) {
      setMessage({ text: `${file.name}: só arquivos ${FILE_EXTENSION} abrem nesta versão. Importar XLSX ainda não está disponível no navegador.`, tone: 'error' });
      return;
    }
    setBusy('Abrindo arquivo…');
    try {
      const started = performance.now();
      const bytes = new Uint8Array(await file.arrayBuffer());
      const size = bytes.length;
      const result = await client.call('open', { bytes });
      measure('engine:open', started, { engineMs: result.ms, evaluateMs: result.evaluateMs, bytes: size });
      const app = result.header.app as { pivots?: PivotDef[]; activeTab?: Tab };
      setInfo(result);
      setPivots(app.pivots ?? []);
      setPivotStates({});
      setTab(app.activeTab && (app.activeTab.kind === 'sheet' ? app.activeTab.index < result.sheets.length : app.pivots?.some(p => p.id === (app.activeTab as { id: string }).id)) ? app.activeTab : { kind: 'sheet', index: 0 });
      setFileName(file.name);
      setDirty(false);
      setMessage({ text: `Aberto ${file.name} · ${mib(size)} · ${seconds(result.ms)} (recalculo ${seconds(result.evaluateMs)}) · IronCalc ${result.header.engine.version}`, tone: 'info' });
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
    }
  };

  const generate = async () => {
    if (!generator) return;
    const rows = Number(generator.rows.replace(/\D/g, ''));
    const seed = Number(generator.seed.replace(/\D/g, ''));
    setGenerator(null);
    setBusy('Gerando base sintética…');
    setReport(null);
    setPivots([]);
    setPivotStates({});
    setTab({ kind: 'sheet', index: 0 });
    try {
      const started = performance.now();
      const result = await client.call('generate', { rows, seed });
      measure('engine:generate', started, { ...result.report });
      setInfo(result);
      setReport(result.report);
      setFileName(null);
      setDirty(true);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const newPivot = () => {
    const id = Math.random().toString(36).slice(2, 9);
    const n = pivots.length + 1;
    const source = tab.kind === 'sheet' ? tab.index : sheet;
    setPivots(p => [...p, { id, name: `Dinâmica ${n}`, sheet: source, config: emptyConfig(), chart: 'columns', valueIndex: 0 }]);
    setTab({ kind: 'pivot', id });
  };

  const closePivot = (id: string) => {
    setPivots(p => p.filter(x => x.id !== id));
    if (tab.kind === 'pivot' && tab.id === id) setTab({ kind: 'sheet', index: pivots.find(p => p.id === id)?.sheet ?? 0 });
  };

  // Global shortcuts
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === 's') { event.preventDefault(); void save(); }
      if (event.key.toLowerCase() === 'o') { event.preventDefault(); openInput.current?.click(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  const loadLabels = useCallback((field: string) => client.call('pivotLabels', { sheet: activePivot?.sheet ?? 0, field }), [client, activePivot?.sheet]);
  const address = selection.rect.top === selection.rect.bottom && selection.rect.left === selection.rect.right ? cellName(selection.active) : rectName(selection.rect);
  const formulaValue = formulaDraft ?? editingText ?? cellInput;
  const sheets = info?.sheets ?? ['Planilha1'];

  return (
    <div className="farcel">
      <div className="toolbar" role="toolbar" aria-label="Ferramentas do Farcel">
        <button onClick={() => openInput.current?.click()} disabled={!!busy} title="Abrir pasta Farcel (Ctrl+O)"><Icon name="open" /><span>Abrir</span></button>
        <button onClick={() => void save()} disabled={!!busy || !info} title={`Salvar (Ctrl+S). ${FORMAT_DESCRIPTION}`}><Icon name="save" /><span>Salvar</span></button>
        <span className="toolbar-sep" />
        <button onClick={() => controller.undo?.()} disabled={!info?.canUndo || !!busy} title="Desfazer (Ctrl+Z)" aria-label="Desfazer"><Icon name="undo" /></button>
        <button onClick={() => controller.redo?.()} disabled={!info?.canRedo || !!busy} title="Refazer (Ctrl+Y)" aria-label="Refazer"><Icon name="redo" /></button>
        <span className="toolbar-sep" />
        <button onClick={newPivot} disabled={!!busy || !info} title="Nova tabela dinâmica a partir de A1 desta planilha"><Icon name="pivot" /><span>Tabela dinâmica</span></button>
        <span className="toolbar-spacer" />
        <button className="quiet" onClick={() => setGenerator({ rows: '1.000.000', seed: String(DEFAULT_SEED) })} disabled={!!busy || !info} title="Gerar base sintética reproduzível para testes de volume"><Icon name="base" /><span>Base de teste</span></button>
        <input ref={openInput} type="file" accept={`${FILE_EXTENSION},.xlsx`} hidden data-testid="open-input"
          onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void openFile(file); }} />
      </div>

      <div className="formula-bar">
        <input
          className="name-box"
          aria-label="Caixa de nome"
          value={nameDraft ?? (tab.kind === 'sheet' ? address : '')}
          disabled={tab.kind !== 'sheet'}
          onChange={e => setNameDraft(e.target.value)}
          onFocus={e => e.target.select()}
          onBlur={() => setNameDraft(null)}
          onKeyDown={e => {
            // preventDefault: the Enter must not reach the cell editor that receives focus.
            if (e.key === 'Enter') { e.preventDefault(); goTo(e.currentTarget.value); }
            if (e.key === 'Escape') { e.preventDefault(); setNameDraft(null); grid.current?.focus(); }
          }}
        />
        <span className="fx" aria-hidden="true">fx</span>
        <input
          className="formula-input"
          aria-label="Barra de fórmulas"
          data-testid="formula-bar"
          spellCheck={false}
          value={tab.kind === 'sheet' ? formulaValue : ''}
          disabled={tab.kind !== 'sheet' || !!busy}
          onChange={e => setFormulaDraft(e.target.value)}
          onFocus={() => setFormulaDraft(formulaValue)}
          onBlur={commitFormula}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); commitFormula(); }
            if (e.key === 'Escape') { e.preventDefault(); setFormulaDraft(null); grid.current?.focus(); }
          }}
        />
      </div>

      <div className="farcel-body">
        {tab.kind === 'sheet' && (
          <Grid ref={grid} controller={controller} onSelection={setSelection} onEditingText={setEditingText} onError={text => setMessage({ text, tone: 'error' })} label={`Planilha ${sheets[sheet]}`} />
        )}
        {activePivot && (
          <PivotView
            pivot={activePivot}
            sourceName={sheets[activePivot.sheet] ?? ''}
            state={pivotStates[activePivot.id]}
            fields={fields?.sheet === activePivot.sheet ? fields.names : []}
            rows={fields?.sheet === activePivot.sheet ? fields.rows : 0}
            onChange={next => { setPivots(p => p.map(x => (x.id === next.id ? next : x))); setDirty(true); }}
            loadLabels={loadLabels}
            onError={text => setMessage({ text, tone: 'error' })}
          />
        )}
        {generator && (
          <div className="dialog-backdrop" onMouseDown={() => setGenerator(null)}>
            <form className="dialog" role="dialog" aria-label="Base de teste" onMouseDown={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); void generate(); }}>
              <h3>Base sintética de vendas</h3>
              <p>Cria uma pasta nova com a planilha <strong>Dados</strong> (Região, Canal, Categoria, Quantidade, Receita), todas as linhas preenchidas, e a planilha <strong>Resumo</strong> com SOMA, SOMASE e CONT.VALORES sobre a base. Mesma semente, mesmos dados.</p>
              <label>Linhas<input name="rows" value={generator.rows} onChange={e => setGenerator({ ...generator, rows: e.target.value })} inputMode="numeric" /></label>
              <label>Semente<input name="seed" value={generator.seed} onChange={e => setGenerator({ ...generator, seed: e.target.value })} inputMode="numeric" /></label>
              {dirty && <p className="panel-hint">A pasta atual será substituída. Salve antes se precisar dela.</p>}
              <footer>
                <button type="button" onClick={() => setGenerator(null)}>Cancelar</button>
                <button type="submit" className="primary">Gerar</button>
              </footer>
            </form>
          </div>
        )}
      </div>

      <div className="sheet-strip">
        <div className="sheet-tabs" role="tablist" aria-label="Planilhas">
          {sheets.map((name, index) => (
            <button key={name + index} role="tab" aria-selected={tab.kind === 'sheet' && tab.index === index}
              className={tab.kind === 'sheet' && tab.index === index ? 'sheet-tab active' : 'sheet-tab'}
              onClick={() => setTab({ kind: 'sheet', index })}>{name}</button>
          ))}
          <button className="sheet-add" aria-label="Nova planilha" title="Nova planilha" disabled={!!busy}
            onClick={() => track(client.call('addSheet')).then(r => setTab({ kind: 'sheet', index: r.sheet }), () => {})}><Icon name="plus" size={15} /></button>
          {pivots.map(pivot => (
            <span key={pivot.id} className={tab.kind === 'pivot' && tab.id === pivot.id ? 'sheet-tab pivot active' : 'sheet-tab pivot'}>
              <button role="tab" aria-selected={tab.kind === 'pivot' && tab.id === pivot.id} onClick={() => setTab({ kind: 'pivot', id: pivot.id })}>
                <Icon name="pivot" size={14} />{pivot.name}
              </button>
              <button className="tab-close" aria-label={`Fechar ${pivot.name}`} onClick={() => closePivot(pivot.id)}><Icon name="close" size={12} /></button>
            </span>
          ))}
        </div>
      </div>

      <footer className="status-bar">
        <span className={message?.tone === 'error' ? 'status-message error' : 'status-message'} data-testid="status-message" title={message?.text}>
          {progress && busy
            ? `${progress.label}: ${progress.done.toLocaleString('pt-BR')} de ${progress.total.toLocaleString('pt-BR')} (${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%)`
            : progress ? `${progress.label}: ${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` : message?.text ?? 'Pronto'}
        </span>
        {report && (
          <span className="status-report" data-testid="generation-report" title="Medido neste navegador">
            Base: {report.rows.toLocaleString('pt-BR')} linhas × {report.columns} colunas + {report.formulas} fórmulas · {seconds(report.totalMs)} · WASM {mib(report.wasmMemoryBytes)}
            <button className="icon-button" aria-label="Fechar relatório" onClick={() => setReport(null)}><Icon name="close" size={12} /></button>
          </span>
        )}
        {tab.kind === 'sheet' && stats && stats.count > 1 && (
          <span className="status-stats" data-testid="selection-stats">
            {stats.numbers > 0 && <>Soma: {number.format(stats.sum)} · Média: {number.format(stats.sum / stats.numbers)} · </>}Contagem: {stats.count.toLocaleString('pt-BR')}
          </span>
        )}
      </footer>
    </div>
  );
}
