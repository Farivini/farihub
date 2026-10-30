import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { MAX_COLUMN, MAX_ROW, cellName, columnName, parseRect, rectName } from '../../core/address.ts';
import type { Rect } from '../../core/address.ts';
import { emptyConfig, layoutPivot } from '../../core/pivot.ts';
import { FILE_EXTENSION, FORMAT_DESCRIPTION } from '../../core/file-format.ts';
import type { EngineClient } from '../../engine/client.ts';
import type { WorkbookInfo } from '../../engine/protocol.ts';
import { NUMBER_FORMATS } from '../../engine/workbook-engine.ts';
import type { CellFormat, FormatChange, GenerationReport, HorizontalAlign } from '../../engine/workbook-engine.ts';
import { Grid } from './Grid.tsx';
import type { GridController, GridHandle, Selection, SelectionStats } from './Grid.tsx';
import { PivotView } from './PivotView.tsx';
import type { PivotDef, PivotState } from './PivotView.tsx';
import { FunctionMenu } from './FunctionMenu.tsx';
import { Icon } from '../ui/Icon.tsx';
import { MenuButton } from '../shell/Menu.tsx';
import { measure } from '../perf.ts';

export interface ContextRequest { sheet: number; selection: Rect; pivotRows: string[][] | null }
export interface WorkspaceStatus {
  title: string;
  dirty: boolean;
  /** True once the workbook was written to or read from a file and nothing changed since. */
  saved: boolean;
  /** No edits and no file: a fresh workbook that can be replaced by an opened file. */
  pristine: boolean;
  engine: string;
  busy: boolean;
}
export type Startup = { kind: 'new' } | { kind: 'open'; file: File } | { kind: 'generate'; rows: number; seed: number };
export interface WorkspaceHandle {
  save(): Promise<void>;
  /** Resolves false when the file was refused; the current workbook is kept. */
  openFile(file: File): Promise<boolean>;
  /** Unsaved changes, including writes the engine has not answered yet (read synchronously). */
  hasUnsavedWork(): boolean;
}

type Tab = { kind: 'sheet'; index: number } | { kind: 'pivot'; id: string };

const number = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
const seconds = (ms: number) => ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s`;
const mib = (bytes: number | null) => bytes === null ? 'não medida'
  : bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KiB`
  : `${(bytes / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MiB`;
const statValue = (value: number, unit: SelectionStats['unit']) =>
  unit === '%' ? `${number.format(value * 100)}%` : unit === 'R$' ? `R$ ${number.format(value)}` : number.format(value);
const ZOOMS = [0.75, 0.9, 1, 1.1, 1.25, 1.5];
const FORMAT_SHORT: Record<string, string> = { general: 'Geral', number: '0,00', currency: 'R$', percent: '%', date: 'Data', custom: 'Pers.' };

interface SaveFilePicker {
  showSaveFilePicker?(options: unknown): Promise<{ name: string; createWritable(): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void> }> }>;
}

export const FarcelWorkspace = forwardRef<WorkspaceHandle, {
  client: EngineClient;
  startup: Startup;
  active: boolean;
  onStatus(status: WorkspaceStatus): void;
  onContext(request: ContextRequest): void;
  /** The file this tab was created to open could not be opened. */
  onStartupFailed?(message: string): void;
}>(function FarcelWorkspace({ client, startup, active, onStatus, onContext, onStartupFailed }, ref) {
  const grid = useRef<GridHandle>(null);
  const formulaInput = useRef<HTMLInputElement>(null);
  const [info, setInfo] = useState<WorkbookInfo | null>(null);
  const [engineName, setEngineName] = useState('Iniciando motor…');
  const [revision, setRevision] = useState(0);
  const [tab, setTab] = useState<Tab>({ kind: 'sheet', index: 0 });
  const [selection, setSelection] = useState<Selection>({ active: { row: 1, column: 1 }, rect: { top: 1, left: 1, bottom: 1, right: 1 } });
  const [stats, setStats] = useState<SelectionStats | null>(null);
  const [format, setFormat] = useState<CellFormat | null>(null);
  const [editingText, setEditingText] = useState<string | null>(null);
  const [cellInput, setCellInput] = useState('');
  const [formulaDraft, setFormulaDraft] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [message, setMessage] = useState<{ text: string; tone: 'info' | 'error' } | null>(null);
  const [progress, setProgress] = useState<{ label: string; done: number; total: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [pivots, setPivots] = useState<PivotDef[]>([]);
  const [pivotStates, setPivotStates] = useState<Record<string, PivotState>>({});
  const [fields, setFields] = useState<{ sheet: number; names: string[]; rows: number } | null>(null);
  const [report, setReport] = useState<GenerationReport | null>(null);
  const [zoom, setZoom] = useState(1);
  const sheet = tab.kind === 'sheet' ? tab.index : pivots.find(p => p.id === tab.id)?.sheet ?? 0;

  const fail = useCallback((error: unknown) => {
    setMessage({ text: error instanceof Error ? error.message : String(error), tone: 'error' });
  }, []);

  const inFlight = useRef(0);
  const track = useCallback(<T,>(promise: Promise<T>): Promise<T> => {
    inFlight.current++;
    setPending(p => p + 1);
    return promise.then(result => {
      if (result && typeof result === 'object' && 'sheets' in result) setInfo(result as unknown as WorkbookInfo);
      return result;
    }).catch(error => { fail(error); throw error; }).finally(() => { inFlight.current--; setPending(p => p - 1); });
  }, [fail]);

  // Files
  const openFile = useCallback(async (file: File): Promise<boolean> => {
    if (!file.name.toLowerCase().endsWith(FILE_EXTENSION)) {
      setMessage({ text: `${file.name}: só arquivos ${FILE_EXTENSION} abrem nesta versão. Importar XLSX ainda não está disponível no navegador.`, tone: 'error' });
      return false;
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
      setSaved(true);
      setMessage({ text: `Aberto ${file.name} · ${mib(size)} · ${seconds(result.ms)} (recálculo ${seconds(result.evaluateMs)}) · IronCalc ${result.header.engine.version}`, tone: 'info' });
      return true;
    } catch (error) {
      fail(error);
      return false;
    } finally {
      setBusy(null);
    }
  }, [client, fail]);

  const generate = useCallback(async (rows: number, seed: number) => {
    setBusy('Gerando base sintética…');
    setReport(null);
    try {
      const started = performance.now();
      const result = await client.call('generate', { rows, seed });
      measure('engine:generate', started, { ...result.report });
      setInfo(result);
      setReport(result.report);
      setDirty(true);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }, [client, fail]);

  // Engine lifecycle, events and the startup action of this tab.
  useEffect(() => {
    const off = client.on(event => {
      if (event.event === 'changed') { setRevision(r => r + 1); setDirty(true); setSaved(false); }
      else setProgress({ label: event.task === 'generate' ? 'Gerando base' : event.task === 'pivot' ? `Lendo ${event.label}` : 'Abrindo', done: event.done, total: event.total });
    });
    let live = true;
    client.call('init').then(result => {
      if (!live) return;
      setInfo(result);
      setEngineName(result.engine);
      setDirty(false);
      if (startup.kind === 'open') {
        void openFile(startup.file).then(ok => {
          if (!ok) onStartupFailed?.(startup.file.name.toLowerCase().endsWith(FILE_EXTENSION)
            ? `Não foi possível abrir ${startup.file.name}: o arquivo está corrompido ou não é uma pasta ${FILE_EXTENSION} válida.`
            : `${startup.file.name}: só arquivos ${FILE_EXTENSION} abrem nesta versão. Importar XLSX ainda não está disponível no navegador.`);
        });
      }
      if (startup.kind === 'generate') void generate(startup.rows, startup.seed);
    }, fail);
    return () => { live = false; off(); };
    // The startup action runs once per tab.
  }, [client]); // eslint-disable-line

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
        const handle = await picker.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Pasta de trabalho Fariv', accept: { 'application/x-farcel': [FILE_EXTENSION] } }] });
        const writable = await handle.createWritable();
        await writable.write(bytes);
        await writable.close();
        savedName = handle.name;
      } else {
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/x-farcel' }));
        const link = document.createElement('a');
        link.href = url;
        // Chromium drops non-ASCII names given through the download attribute; the native
        // save dialog above keeps the original name.
        link.download = name.normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\x20-\x7e]/g, '_');
        savedName = link.download;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }
      setFileName(savedName);
      setDirty(false);
      setSaved(true);
      setMessage({ text: `Salvo ${savedName} · ${mib(bytes.length)} · ${seconds(ms)}. ${FORMAT_DESCRIPTION}`, tone: 'info' });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) fail(error);
    }
  }, [busy, client, fileName, info?.name, pivots, tab, track, fail]);

  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useImperativeHandle(ref, () => ({
    save,
    openFile,
    hasUnsavedWork: () => dirtyRef.current || inFlight.current > 0,
  }), [save, openFile]);

  // Sheet grid controller: every read and write goes to the engine worker.
  const controller = useMemo<GridController>(() => ({
    key: `sheet-${sheet}-${info?.name ?? ''}`,
    revision,
    rowCount: MAX_ROW,
    columnCount: MAX_COLUMN,
    readOnly: !!busy,
    pending: () => inFlight.current > 0,
    columnWidth: () => 124,
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

  // Formula bar and toolbar state follow the active cell.
  useEffect(() => {
    if (tab.kind !== 'sheet' || !info) return;
    let live = true;
    const { row, column } = selection.active;
    client.call('input', { sheet, row, column }).then(text => { if (live) setCellInput(text); }, () => {});
    client.call('cellFormat', { sheet, row, column }).then(f => { if (live) setFormat(f); }, () => {});
    return () => { live = false; };
  }, [client, sheet, selection.active.row, selection.active.column, revision, tab.kind, info]); // eslint-disable-line

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

  // Assistant context request (bounded; built in the worker). Only the visible tab reports.
  useEffect(() => {
    if (!active) return;
    const state = activePivot ? pivotStates[activePivot.id] : undefined;
    onContext({ sheet, selection: selection.rect, pivotRows: state?.table?.rows ?? null });
  }, [active, sheet, selection, activePivot, pivotStates, onContext]);

  // Status for the shell
  useEffect(() => {
    const title = fileName ?? `${info?.name ?? 'Pasta1'}${FILE_EXTENSION}`;
    const engine = busy ? busy : pending > 0 ? 'Calculando…' : engineName;
    onStatus({ title, dirty, saved, pristine: !dirty && !fileName && !busy && !report, engine, busy: !!busy || pending > 0 });
  }, [fileName, info?.name, dirty, saved, busy, pending, engineName, report, onStatus]);

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

  const insertFunction = (name: string) => {
    const current = formulaDraftRef.current ?? editingText ?? cellInput;
    const next = current.startsWith('=') ? `${current}${name}(` : `=${name}(`;
    formulaDraftRef.current = next;
    // Render synchronously so the caret can be placed before the next keystroke arrives.
    flushSync(() => setFormulaDraft(next));
    formulaInput.current?.focus();
    formulaInput.current?.setSelectionRange(next.length, next.length);
  };

  const goTo = (text: string) => {
    const rect = parseRect(text);
    setNameDraft(null);
    if (rect) grid.current?.select({ row: rect.top, column: rect.left }, rect);
    else setMessage({ text: `Referência inválida: ${text}`, tone: 'error' });
    grid.current?.focus();
  };

  const applyFormat = (change: FormatChange) => {
    if (tab.kind !== 'sheet') return;
    track(client.call('format', { sheet, rect: selection.rect, change })).then(() => grid.current?.focus(), () => {});
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

  const loadLabels = useCallback((field: string) => client.call('pivotLabels', { sheet: activePivot?.sheet ?? 0, field }), [client, activePivot?.sheet]);
  const address = selection.rect.top === selection.rect.bottom && selection.rect.left === selection.rect.right ? cellName(selection.active) : rectName(selection.rect);
  const formulaValue = formulaDraft ?? editingText ?? cellInput;
  const sheets = info?.sheets ?? ['Planilha1'];
  const onSheet = tab.kind === 'sheet';
  const align = (value: HorizontalAlign) => () => applyFormat({ kind: 'align', value: format?.align === value ? 'general' : value });
  const tabsMenu = [
    ...sheets.map((name, index) => ({ id: `s${index}`, label: name, checked: tab.kind === 'sheet' && tab.index === index, onSelect: () => setTab({ kind: 'sheet', index }) })),
    ...pivots.map((pivot, i) => ({ id: pivot.id, label: pivot.name, separatorBefore: i === 0, checked: tab.kind === 'pivot' && tab.id === pivot.id, onSelect: () => setTab({ kind: 'pivot', id: pivot.id }) })),
  ];
  const statusText = progress && busy
    ? `${progress.label}: ${progress.done.toLocaleString('pt-BR')} de ${progress.total.toLocaleString('pt-BR')} (${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%)`
    : progress ? `${progress.label}: ${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` : message?.text ?? '';

  return (
    <div className="farcel">
      <div className="toolbar" role="toolbar" aria-label="Ferramentas da planilha">
        <button className="tool" onClick={() => controller.undo?.()} disabled={!info?.canUndo || !!busy} title="Desfazer (Ctrl+Z)" aria-label="Desfazer"><Icon name="undo" size={19} /></button>
        <button className="tool" onClick={() => controller.redo?.()} disabled={!info?.canRedo || !!busy} title="Refazer (Ctrl+Y)" aria-label="Refazer"><Icon name="redo" size={19} /></button>
        <span className="toolbar-sep" />
        <MenuButton
          label="Formato de número"
          className="tool select"
          testId="number-format"
          disabled={!onSheet || !!busy}
          items={NUMBER_FORMATS.map(f => ({ id: f.id, label: f.label, hint: f.sample, checked: format?.numberFormat === f.id, onSelect: () => applyFormat({ kind: 'number', value: f.id }) }))}
        >
          <span className="select-value">{FORMAT_SHORT[format?.numberFormat ?? 'general']}</span><Icon name="chevron-down" size={15} />
        </MenuButton>
        <button className={format?.bold ? 'tool on' : 'tool'} aria-pressed={!!format?.bold} disabled={!onSheet || !!busy}
          onClick={() => applyFormat({ kind: 'bold', value: !format?.bold })} title="Negrito" aria-label="Negrito" data-testid="bold"><Icon name="bold" size={18} strokeWidth={2} /></button>
        <span className="toolbar-sep" />
        <button className={format?.align === 'left' ? 'tool on' : 'tool'} aria-pressed={format?.align === 'left'} disabled={!onSheet || !!busy} onClick={align('left')} title="Alinhar à esquerda" aria-label="Alinhar à esquerda"><Icon name="align-left" /></button>
        <button className={format?.align === 'center' ? 'tool on' : 'tool'} aria-pressed={format?.align === 'center'} disabled={!onSheet || !!busy} onClick={align('center')} title="Centralizar" aria-label="Centralizar"><Icon name="align-center" /></button>
        <button className={format?.align === 'right' ? 'tool on' : 'tool'} aria-pressed={format?.align === 'right'} disabled={!onSheet || !!busy} onClick={align('right')} title="Alinhar à direita" aria-label="Alinhar à direita"><Icon name="align-right" /></button>
        <span className="toolbar-sep" />
        <button className="tool labeled" onClick={newPivot} disabled={!!busy || !info} title="Nova tabela dinâmica a partir de A1 desta planilha" data-testid="new-pivot"><Icon name="pivot" /><span>Dinâmica</span></button>
      </div>

      <div className="formula-bar" hidden={!onSheet}>
        <input
          className="name-box"
          aria-label="Caixa de nome"
          value={nameDraft ?? (onSheet ? address : '')}
          disabled={!onSheet}
          onChange={e => setNameDraft(e.target.value)}
          onFocus={e => e.target.select()}
          onBlur={() => setNameDraft(null)}
          onKeyDown={e => {
            // preventDefault: the Enter must not reach the cell editor that receives focus.
            if (e.key === 'Enter') { e.preventDefault(); goTo(e.currentTarget.value); }
            if (e.key === 'Escape') { e.preventDefault(); setNameDraft(null); grid.current?.focus(); }
          }}
        />
        <FunctionMenu disabled={!onSheet || !!busy} onPick={insertFunction} />
        <div className="formula-field">
          <span className="fx" aria-hidden="true">fx</span>
          <input
            ref={formulaInput}
            className="formula-input"
            aria-label="Barra de fórmulas"
            data-testid="formula-bar"
            spellCheck={false}
            value={onSheet ? formulaValue : ''}
            disabled={!onSheet || !!busy}
            onChange={e => setFormulaDraft(e.target.value)}
            onFocus={() => setFormulaDraft(d => d ?? formulaValue)}
            onBlur={commitFormula}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); commitFormula(); }
              if (e.key === 'Escape') { e.preventDefault(); setFormulaDraft(null); grid.current?.focus(); }
            }}
          />
        </div>
      </div>

      <div className="farcel-body">
        {onSheet && (
          <Grid ref={grid} controller={controller} zoom={zoom} onSelection={setSelection} onEditingText={setEditingText} onError={text => setMessage({ text, tone: 'error' })} label={`Planilha ${sheets[sheet]}`} />
        )}
        {activePivot && (
          <PivotView
            pivot={activePivot}
            sourceName={sheets[activePivot.sheet] ?? ''}
            state={pivotStates[activePivot.id]}
            fields={fields?.sheet === activePivot.sheet ? fields.names : []}
            rows={fields?.sheet === activePivot.sheet ? fields.rows : 0}
            zoom={zoom}
            onChange={next => { setPivots(p => p.map(x => (x.id === next.id ? next : x))); setDirty(true); setSaved(false); }}
            loadLabels={loadLabels}
            onError={text => setMessage({ text, tone: 'error' })}
          />
        )}
      </div>

      <div className="sheet-strip">
        <MenuButton label="Todas as planilhas" className="strip-menu" items={tabsMenu} placement="above" testId="sheets-menu">
          <Icon name="menu" size={18} />
        </MenuButton>
        <div className="sheet-tabs" role="tablist" aria-label="Planilhas">
          {sheets.map((name, index) => (
            <button key={name + index} role="tab" aria-selected={tab.kind === 'sheet' && tab.index === index}
              className={tab.kind === 'sheet' && tab.index === index ? 'sheet-tab active' : 'sheet-tab'}
              onClick={() => setTab({ kind: 'sheet', index })}>{name}</button>
          ))}
          {pivots.map(pivot => (
            <span key={pivot.id} className={tab.kind === 'pivot' && tab.id === pivot.id ? 'sheet-tab pivot active' : 'sheet-tab pivot'}>
              <button role="tab" aria-selected={tab.kind === 'pivot' && tab.id === pivot.id} onClick={() => setTab({ kind: 'pivot', id: pivot.id })}>
                <Icon name="pivot" size={14} />{pivot.name}
              </button>
              <button className="tab-close" aria-label={`Fechar ${pivot.name}`} onClick={() => closePivot(pivot.id)}><Icon name="close" size={12} /></button>
            </span>
          ))}
          <button className="sheet-add" aria-label="Nova planilha" title="Nova planilha" disabled={!!busy}
            onClick={() => track(client.call('addSheet')).then(r => setTab({ kind: 'sheet', index: r.sheet }), () => {})}><Icon name="plus" size={16} /></button>
        </div>
      </div>

      <footer className="status-bar">
        <span className={saved && !dirty ? 'save-state saved' : 'save-state'} data-testid="save-state">
          {saved && !dirty ? <><Icon name="check" size={14} strokeWidth={2.2} />Salvo neste dispositivo</> : dirty ? 'Alterações não salvas' : 'Nova pasta'}
        </span>
        <span className={message?.tone === 'error' ? 'status-message error' : 'status-message'} data-testid="status-message" title={message?.text}>
          {statusText}
        </span>
        {report && (
          <span className="status-report" data-testid="generation-report" title="Medido neste navegador">
            Base: {report.rows.toLocaleString('pt-BR')} linhas × {report.columns} colunas + {report.formulas} fórmulas · {seconds(report.totalMs)} · WASM {mib(report.wasmMemoryBytes)}
            <button className="icon-button" aria-label="Fechar relatório" onClick={() => setReport(null)}><Icon name="close" size={12} /></button>
          </span>
        )}
        {onSheet && stats && stats.count > 1 && (
          <span className="status-stats" data-testid="selection-stats">
            {stats.numbers > 0 && <>Soma: {statValue(stats.sum, stats.unit)} · Média: {statValue(stats.sum / stats.numbers, stats.unit)} · </>}Contagem: {stats.count.toLocaleString('pt-BR')}
          </span>
        )}
        <span className={busy || pending > 0 ? 'engine-state busy' : 'engine-state'} data-testid="engine-state" title="Motor de cálculo desta pasta, em segundo plano">
          <i />{busy ? busy : pending > 0 ? 'Calculando…' : engineName}
        </span>
        <span className="status-sep" />
        <MenuButton label="Zoom" className="zoom" placement="above" align="end" testId="zoom"
          items={ZOOMS.map(z => ({ id: String(z), label: `${Math.round(z * 100)}%`, checked: z === zoom, onSelect: () => setZoom(z) }))}>
          <span>{Math.round(zoom * 100)}%</span><Icon name="chevron-down" size={14} />
        </MenuButton>
      </footer>
    </div>
  );
});
