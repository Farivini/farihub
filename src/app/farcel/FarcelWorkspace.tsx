import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { MAX_COLUMN, MAX_ROW, cellName, columnName, parseRect, rectName } from '../../core/address.ts';
import type { Rect } from '../../core/address.ts';
import { emptyConfig, layoutPivot } from '../../core/pivot.ts';
import { FILE_EXTENSION } from '../../core/file-format.ts';
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
import { FILE_KINDS, fileSink } from '../files.ts';
import type { FileHandle, SinkMode } from '../files.ts';
import { importXlsx, exportXlsx } from '../../engine/xlsx-client.ts';
import { keptFeatures, lostFeatures } from '../../core/xlsx-report.ts';
import type { DelimitedExportMode, DelimitedOptions } from '../../core/delimited.ts';
import { delimitedLosses, isComplete, lossKey, parseOrigin, saveLosses } from '../../core/save-plan.ts';
import type { Loss, Origin, SaveFormat } from '../../core/save-plan.ts';
import { Dialog } from '../shell/Dialog.tsx';
import { ImportDialog } from './ImportDialog.tsx';
import { SaveDialog } from './SaveDialog.tsx';

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
export type Startup = { kind: 'new' } | { kind: 'open'; file: File; handle?: FileHandle } | { kind: 'generate'; rows: number; seed: number };
/** CSV and TSV export one sheet; workbooks are saved as .xlsx or .farcel. */
export type ExportFormat = 'csv' | 'tsv';
/** Opened as .farcel; .xlsx, .csv, .tsv and .txt are imported into a new workbook. */
export const OPEN_EXTENSIONS = [FILE_EXTENSION, '.xlsx', '.csv', '.tsv', '.txt'];
/** How opening a file ended: refused files leave the current workbook as it was. */
export type OpenResult = { ok: true } | { ok: false; message: string | null };
export interface WorkspaceHandle {
  /** Ctrl+S: the file and format the workbook came from or was last saved as; asks when there is none. */
  save(): void;
  saveAs(): void;
  /** `handle`: the file on disk, when the browser gave one, so Ctrl+S can write it again. */
  openFile(file: File, handle?: FileHandle): Promise<OpenResult>;
  exportFile(format: ExportFormat): void;
  /** Unsaved changes, including writes the engine has not answered yet (read synchronously). */
  hasUnsavedWork(): boolean;
}

type Tab = { kind: 'sheet'; index: number } | { kind: 'pivot'; id: string };
/** Where Ctrl+S writes: the file opened or last saved, in its format. */
interface Target { name: string; format: SaveFormat; handle?: FileHandle }
interface ExportPlan { format: ExportFormat; losses: Loss[] }
const SAVE_EXTENSIONS: Record<SaveFormat, string> = { xlsx: '.xlsx', farcel: FILE_EXTENSION };

const extension = (name: string) => name.toLowerCase().slice(name.lastIndexOf('.'));
const stem = (name: string) => name.replace(/\.[^.]+$/, '');
const plural = (n: number, one: string, many: string) => `${n.toLocaleString('pt-BR')} ${n === 1 ? one : many}`;

const number = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
const seconds = (ms: number) => ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s`;
const mib = (bytes: number | null) => bytes === null ? 'não medida'
  : bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KiB`
  : `${(bytes / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MiB`;
const statValue = (value: number, unit: SelectionStats['unit']) =>
  unit === '%' ? `${number.format(value * 100)}%` : unit === 'R$' ? `R$ ${number.format(value)}` : number.format(value);
const ZOOMS = [0.75, 0.9, 1, 1.1, 1.25, 1.5];
const FORMAT_SHORT: Record<string, string> = { general: 'Geral', number: '0,00', currency: 'R$', percent: '%', date: 'Data', custom: 'Pers.' };

export const FarcelWorkspace = forwardRef<WorkspaceHandle, {
  client: EngineClient;
  startup: Startup;
  active: boolean;
  onStatus(status: WorkspaceStatus): void;
  onContext(request: ContextRequest): void;
  /** The file this tab was created to open was not opened (message null: the person cancelled). */
  onStartupFailed?(message: string | null): void;
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
  const [target, setTarget] = useState<Target | null>(null);
  const [savedMode, setSavedMode] = useState<SinkMode>('file');
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [importing, setImporting] = useState<{ file: File; bytes: Uint8Array; done(result: OpenResult): void } | null>(null);
  const [importReport, setImportReport] = useState<Origin | null>(null);
  const [saveDialog, setSaveDialog] = useState<{ start: 'choose' | 'confirm'; format: SaveFormat; name: string } | null>(null);
  const [exportPlan, setExportPlan] = useState<ExportPlan | null>(null);
  const [exportMode, setExportMode] = useState<DelimitedExportMode>('spreadsheet');
  /** XLSX losses already accepted for this workbook (asked again after reopening). */
  const acceptedLosses = useRef<string | null>(null);
  const [pivots, setPivots] = useState<PivotDef[]>([]);
  const [pivotStates, setPivotStates] = useState<Record<string, PivotState>>({});
  const [fields, setFields] = useState<{ sheet: number; names: string[]; rows: number } | null>(null);
  const [report, setReport] = useState<GenerationReport | null>(null);
  const [zoom, setZoom] = useState(1);
  const sheet = tab.kind === 'sheet' ? tab.index : pivots.find(p => p.id === tab.id)?.sheet ?? 0;

  /*
   * What a save captures. The engine part is the model at the moment the worker serialises
   * it: every 'changed' event for an edit processed before that arrives before the save
   * reply, so the count read on the reply matches the bytes. The pivot part is read when the
   * request is sent, together with the pivot list put in the file.
   */
  const engineChanges = useRef(0);
  /** Read when a write starts (it may wait behind another), not when it was requested. */
  const targetRef = useRef<Target | null>(null);
  const originRef = useRef<Origin | null>(null);
  /** Writes run one after another, so an older snapshot can never land after a newer one. */
  const writing = useRef<Promise<void>>(Promise.resolve());
  const appChanges = useRef(0);
  const pivotsRef = useRef(pivots);

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
  /** Shared end of every successful open: a workbook that matches its file, no edits. */
  const opened = (result: WorkbookInfo, file: Target | null, from: Origin | null, app: { pivots?: PivotDef[]; activeTab?: Tab } = {}) => {
    setInfo(result);
    pivotsRef.current = app.pivots ?? [];
    appChanges.current++;
    setPivots(pivotsRef.current);
    setPivotStates({});
    setTab(app.activeTab && (app.activeTab.kind === 'sheet' ? app.activeTab.index < result.sheets.length : app.pivots?.some(p => p.id === (app.activeTab as { id: string }).id)) ? app.activeTab : { kind: 'sheet', index: 0 });
    targetRef.current = file;
    originRef.current = from;
    setTarget(file);
    setOrigin(from);
    acceptedLosses.current = null;
    setDirty(false);
    setSaved(!!file);
    setSavedMode('file');
  };

  const openXlsx = useCallback(async (file: File, handle?: FileHandle): Promise<OpenResult> => {
    setBusy('Importando XLSX…');
    try {
      const started = performance.now();
      const bytes = new Uint8Array(await file.arrayBuffer());
      const size = bytes.length;
      const converted = await importXlsx(bytes, stem(file.name));
      const result = await client.call('loadModel', { bytes: converted.model });
      measure('xlsx:import', started, { convertMs: converted.ms, engineMs: result.ms, evaluateMs: result.evaluateMs, bytes: size });
      const from: Origin = { name: file.name, format: 'XLSX', report: converted.report };
      opened(result, { name: file.name, format: 'xlsx', handle }, from);
      const { cells, formulas } = converted.report;
      setMessage({ text: `Importado ${file.name} · ${mib(size)} · ${plural(cells, 'célula', 'células')}, ${plural(formulas, 'fórmula', 'fórmulas')} · ${seconds(performance.now() - started)}`, tone: 'info' });
      if (lostFeatures(converted.report).length || keptFeatures(converted.report).length) setImportReport(from);
      return { ok: true };
    } catch (error) {
      const text = `Não foi possível importar ${file.name}: ${error instanceof Error ? error.message : String(error)}`;
      setMessage({ text, tone: 'error' });
      return { ok: false, message: text };
    } finally {
      setBusy(null);
    }
  }, [client]); // eslint-disable-line react-hooks/exhaustive-deps

  /** CSV, TSV and TXT open the preview first; the promise settles when it is confirmed or cancelled. */
  const openDelimited = useCallback(async (file: File): Promise<OpenResult> => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return new Promise<OpenResult>(done => setImporting({ file, bytes, done }));
  }, []);

  const importDelimited = async (file: File, bytes: Uint8Array, options: DelimitedOptions): Promise<OpenResult> => {
    setBusy('Importando arquivo…');
    try {
      const started = performance.now();
      const result = await client.call('importDelimited', { bytes, name: stem(file.name), options });
      measure('delimited:import', started, { engineMs: result.ms, rows: result.rows, columns: result.columns, bytes: bytes.length });
      const format = extension(file.name) === '.tsv' ? 'TSV' : extension(file.name) === '.txt' ? 'TXT' : 'CSV';
      opened(result, null, { name: file.name, format, report: null });
      setMessage({ text: `Importado ${file.name} · ${plural(result.rows, 'linha', 'linhas')} × ${plural(result.columns, 'coluna', 'colunas')} · ${seconds(result.ms)}`, tone: 'info' });
      return { ok: true };
    } catch (error) {
      const text = `Não foi possível importar ${file.name}: ${error instanceof Error ? error.message : String(error)}`;
      setMessage({ text, tone: 'error' });
      return { ok: false, message: text };
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const openFile = useCallback(async (file: File, handle?: FileHandle): Promise<OpenResult> => {
    const kind = extension(file.name);
    if (kind === '.xlsx') return openXlsx(file, handle);
    if (kind === '.csv' || kind === '.tsv' || kind === '.txt') return openDelimited(file);
    if (kind !== FILE_EXTENSION) {
      const text = `${file.name}: abrem arquivos ${OPEN_EXTENSIONS.join(', ')}. Este formato ainda não é suportado.`;
      setMessage({ text, tone: 'error' });
      return { ok: false, message: text };
    }
    setBusy('Abrindo arquivo…');
    try {
      const started = performance.now();
      const bytes = new Uint8Array(await file.arrayBuffer());
      const size = bytes.length;
      const result = await client.call('open', { bytes });
      measure('engine:open', started, { engineMs: result.ms, evaluateMs: result.evaluateMs, bytes: size });
      const app = result.header.app as { pivots?: PivotDef[]; activeTab?: Tab; origin?: unknown };
      opened(result, { name: file.name, format: 'farcel', handle }, parseOrigin(app.origin), app);
      setMessage({ text: `Aberto ${file.name} · ${mib(size)} · ${seconds(result.ms)} (recálculo ${seconds(result.evaluateMs)}) · IronCalc ${result.header.engine.version}`, tone: 'info' });
      return { ok: true };
    } catch (error) {
      const text = `Não foi possível abrir ${file.name}: ${error instanceof Error ? error.message : String(error)}`;
      setMessage({ text, tone: 'error' });
      return { ok: false, message: text };
    } finally {
      setBusy(null);
    }
  }, [client, openXlsx, openDelimited]); // eslint-disable-line react-hooks/exhaustive-deps

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
      if (event.event === 'changed') { engineChanges.current++; setRevision(r => r + 1); setDirty(true); setSaved(false); }
      else setProgress({ label: event.task === 'generate' ? 'Gerando base' : event.task === 'pivot' ? `Lendo ${event.label}` : 'Abrindo', done: event.done, total: event.total });
    });
    let live = true;
    client.call('init').then(result => {
      if (!live) return;
      setInfo(result);
      setEngineName(result.engine);
      setDirty(false);
      if (startup.kind === 'open') {
        void openFile(startup.file, startup.handle).then(result => { if (!result.ok) onStartupFailed?.(result.message); });
      }
      if (startup.kind === 'generate') void generate(startup.rows, startup.seed);
    }, fail);
    return () => { live = false; off(); };
    // The startup action runs once per tab.
  }, [client]); // eslint-disable-line

  /**
   * Writes the workbook as .xlsx or .farcel. The engine snapshot is the model when the worker
   * serialised it and the pivot snapshot is read when the request is sent; if either changed
   * while the file was being written, the workbook stays unsaved. A file that leaves out part
   * of the workbook (pivots in an .xlsx) does not mark it saved either.
   */
  const write = (format: SaveFormat, name: string | null, choose: boolean) => {
    writing.current = writing.current.then(() => writeNow(format, name, choose));
    return writing.current;
  };

  /** `name` null: the current file (Ctrl+S), resolved when the write starts. */
  const writeNow = async (format: SaveFormat, requested: string | null, choose: boolean) => {
    try {
      const started = performance.now();
      const target = targetRef.current;
      const origin = originRef.current;
      const name = requested ?? target?.name ?? `${stem(origin?.name ?? info?.name ?? 'Pasta1')}${SAVE_EXTENSIONS[format]}`;
      const appSnapshot = appChanges.current;
      const losses = saveLosses(format, { pivots: pivotsRef.current.length, origin });
      let bytes: Uint8Array;
      let engineSnapshot: number;
      if (format === 'farcel') {
        const result = await track(client.call('save', { app: { pivots: pivotsRef.current, activeTab: tab, origin } }));
        engineSnapshot = engineChanges.current;
        bytes = result.bytes;
        measure('engine:save', started, { engineMs: result.ms, bytes: bytes.length });
      } else {
        const { bytes: model } = await track(client.call('modelBytes'));
        engineSnapshot = engineChanges.current;
        const converted = await track(exportXlsx(model));
        bytes = converted.xlsx;
        measure('xlsx:export', started, { convertMs: converted.ms, bytes: bytes.length });
      }
      const handle = !choose && target?.format === format ? target.handle : undefined;
      const written = await fileSink().write({ name, kind: FILE_KINDS[format], handle }, bytes);
      targetRef.current = { name: written.name, format, handle: written.handle };
      setTarget(targetRef.current);
      setSavedMode(written.mode);
      const current = engineChanges.current === engineSnapshot && appChanges.current === appSnapshot;
      const complete = isComplete(losses);
      // Only a file holding the whole workbook as it is now marks it saved; anything else marks
      // it unsaved, even if it was saved before (Save as .xlsx of a saved .farcel with pivots).
      setDirty(!(current && complete));
      setSaved(current && complete);
      const verb = written.mode === 'download' ? 'Cópia baixada' : 'Salvo';
      const where = written.mode === 'download' ? ' na pasta de downloads' : '';
      const copyNote = written.mode === 'download' ? ' O navegador não grava sobre o arquivo aberto: cada Ctrl+S baixa uma nova cópia.' : '';
      const text = !current
        ? `${verb} ${written.name} com o estado do início da gravação. As alterações feitas durante a gravação ainda não estão no arquivo.`
        : !complete
          ? `${verb} ${written.name}${where}, sem ${plural(pivotsRef.current.length, 'tabela dinâmica', 'tabelas dinâmicas')}: continuam só aqui. Para guardar tudo, use Salvar como… e escolha .farcel.`
          : `${verb} ${written.name}${where} · ${mib(bytes.length)} · ${seconds(performance.now() - started)}.${copyNote}`;
      setMessage({ text, tone: 'info' });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) fail(error);
    }
  };

  const baseName = stem(target?.name ?? origin?.name ?? info?.name ?? 'Pasta1');
  const xlsxLosses = (format: SaveFormat) => saveLosses(format, { pivots: pivotsRef.current.length, origin });

  /** Ctrl+S: keeps the format of the file; a new or imported workbook asks (XLSX by default). */
  const save = () => {
    if (busy) return;
    if (!target) { setSaveDialog({ start: 'choose', format: 'xlsx', name: baseName }); return; }
    const losses = xlsxLosses(target.format);
    if (losses.length && acceptedLosses.current !== lossKey(losses)) {
      setSaveDialog({ start: 'confirm', format: target.format, name: stem(target.name) });
      return;
    }
    void write(target.format, null, false);
  };

  const saveAs = () => {
    if (busy) return;
    setSaveDialog({ start: 'choose', format: target?.format ?? 'xlsx', name: baseName });
  };

  const confirmSave = (format: SaveFormat, name: string, choose: boolean) => {
    setSaveDialog(null);
    const losses = xlsxLosses(format);
    if (losses.length) acceptedLosses.current = lossKey(losses);
    void write(format, choose || !target ? `${name.trim() || 'Pasta1'}${SAVE_EXTENSIONS[format]}` : null, choose || !target);
  };

  /**
   * Pivot and chart configuration is saved in the file too. The ref, the change count and the
   * state move together, so a save never pairs a new count with an older pivot list.
   */
  const updatePivots = (next: (current: PivotDef[]) => PivotDef[]) => {
    pivotsRef.current = next(pivotsRef.current);
    appChanges.current++;
    setPivots(pivotsRef.current);
    setDirty(true);
    setSaved(false);
  };

  /**
   * CSV and TSV: one sheet of displayed values, always confirmed with what the format leaves
   * out and how text is written (protected for spreadsheets, or as is for integrations).
   */
  const exportFile = (format: ExportFormat) => {
    if (busy) return;
    setExportMode('spreadsheet');
    setExportPlan({ format, losses: delimitedLosses(format, { sheets: info?.sheets ?? [], sheet, pivots: pivotsRef.current.length }) });
  };

  const runExport = async (format: ExportFormat, mode: DelimitedExportMode) => {
    try {
      const started = performance.now();
      const result = await track(client.call('exportDelimited', { sheet, separator: format === 'csv' ? ';' : '\t', mode }));
      measure('delimited:export', started, { engineMs: result.ms, rows: result.rows, columns: result.columns, protectedCells: result.protectedCells });
      const written = await fileSink().write({ name: `${baseName}.${format}`, kind: FILE_KINDS[format] }, result.bytes);
      const protectedNote = result.protectedCells
        ? ` · ${plural(result.protectedCells, 'texto recebeu', 'textos receberam')} ' na frente para não virar fórmula`
        : '';
      setMessage({ text: `${written.mode === 'download' ? 'Baixado' : 'Exportado'} ${written.name} · ${plural(result.rows, 'linha', 'linhas')} × ${plural(result.columns, 'coluna', 'colunas')}${protectedNote} · ${seconds(performance.now() - started)}`, tone: 'info' });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) fail(error);
    }
  };
  const commands = useRef({ save, saveAs, exportFile });
  commands.current = { save, saveAs, exportFile };

  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useImperativeHandle(ref, () => ({
    save: () => commands.current.save(),
    saveAs: () => commands.current.saveAs(),
    openFile,
    exportFile: format => commands.current.exportFile(format),
    hasUnsavedWork: () => dirtyRef.current || inFlight.current > 0,
  }), [openFile]);

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
    const title = target?.name ?? origin?.name ?? info?.name ?? 'Pasta1';
    const engine = busy ? busy : pending > 0 ? 'Calculando…' : engineName;
    onStatus({ title, dirty, saved, pristine: !dirty && !target && !origin && !busy && !report && !importing, engine, busy: !!busy || pending > 0 });
  }, [target, origin, info?.name, dirty, saved, busy, pending, engineName, report, importing, onStatus]);

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
    updatePivots(p => [...p, { id, name: `Dinâmica ${n}`, sheet: source, config: emptyConfig(), chart: 'columns', valueIndex: 0 }]);
    setTab({ kind: 'pivot', id });
  };

  const closePivot = (id: string) => {
    updatePivots(p => p.filter(x => x.id !== id));
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
            onChange={next => updatePivots(p => p.map(x => (x.id === next.id ? next : x)))}
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
          {saved && !dirty ? <><Icon name="check" size={14} strokeWidth={2.2} />{savedMode === 'download' ? 'Cópia baixada' : 'Salvo neste dispositivo'}</> : dirty ? 'Alterações não salvas' : origin && !target ? `Importado de ${origin.format}` : 'Nova pasta'}
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

      {importing && (
        <ImportDialog
          fileName={importing.file.name}
          bytes={importing.bytes}
          onCancel={() => { importing.done({ ok: false, message: null }); setImporting(null); }}
          onImport={options => {
            const { file, bytes, done } = importing;
            setImporting(null);
            void importDelimited(file, bytes, options).then(done);
          }}
        />
      )}

      {importReport?.report && (
        <Dialog title={lostFeatures(importReport.report).length ? 'Importado com ressalvas' : 'Importado'} testId="import-report" onClose={() => setImportReport(null)}
          actions={<button type="button" className="primary" onClick={() => setImportReport(null)}>Entendi</button>}>
          <p>{importReport.name}: {plural(importReport.report.sheets, 'planilha', 'planilhas')}, {plural(importReport.report.cells, 'célula', 'células')}, {plural(importReport.report.formulas, 'fórmula', 'fórmulas')}.</p>
          {lostFeatures(importReport.report).length > 0 && <>
            <h4>Não importados</h4>
            <p>Não aparecem aqui e não voltam num XLSX exportado:</p>
            <ul className="report-list" data-testid="report-lost">{lostFeatures(importReport.report).map(f => <li key={f}>{f}</li>)}</ul>
          </>}
          {keptFeatures(importReport.report).length > 0 && <>
            <h4>Mantidos, ainda não exibidos</h4>
            <p>Ficam na pasta e voltam no XLSX exportado, mas o Planilhas ainda não os mostra:</p>
            <ul className="report-list" data-testid="report-kept">{keptFeatures(importReport.report).map(f => <li key={f}>{f}</li>)}</ul>
          </>}
        </Dialog>
      )}

      {saveDialog && (
        <SaveDialog
          start={saveDialog.start}
          name={saveDialog.name}
          format={saveDialog.format}
          lossesFor={xlsxLosses}
          sinkMode={fileSink().mode}
          onCancel={() => setSaveDialog(null)}
          onSave={confirmSave}
        />
      )}

      {exportPlan && (
        <Dialog title={`Exportar planilha como ${exportPlan.format.toUpperCase()}`} testId="export-confirm" onClose={() => setExportPlan(null)} actions={<>
          <button type="button" onClick={() => setExportPlan(null)}>Cancelar</button>
          <button type="button" className="primary" data-testid="export-anyway" onClick={() => { const { format } = exportPlan; setExportPlan(null); void runExport(format, exportMode); }}>
            {fileSink().mode === 'download' ? 'Baixar' : 'Exportar'}
          </button>
        </>}>
          <fieldset className="format-choice" data-testid="export-mode">
            <label className={exportMode === 'spreadsheet' ? 'option on' : 'option'}>
              <input type="radio" name="export-mode" value="spreadsheet" checked={exportMode === 'spreadsheet'} onChange={() => setExportMode('spreadsheet')} />
              <span><strong>Para abrir em planilhas</strong> (padrão) — texto que começa com <code>=</code>, <code>+</code>, <code>-</code> ou <code>@</code> recebe <code>'</code> na frente, para o Excel, o LibreOffice ou o Google Planilhas não o executarem como fórmula. Números, inclusive negativos, não mudam.</span>
            </label>
            <label className={exportMode === 'raw' ? 'option on' : 'option'}>
              <input type="radio" name="export-mode" value="raw" checked={exportMode === 'raw'} onChange={() => setExportMode('raw')} />
              <span><strong>Dados originais</strong> — cada valor exatamente como aparece, para sistemas que leem o arquivo como dados. Ao abrir num programa de planilhas, um texto como <code>=1+1</code> pode virar fórmula.</span>
            </label>
          </fieldset>
          <p>O arquivo {baseName}.{exportPlan.format} não terá:</p>
          <ul className="report-list" data-testid="export-losses">{exportPlan.losses.map(loss => <li key={loss.text}>{loss.text}</li>)}</ul>
          <p>Para entregar a pasta inteira, use Salvar como… e escolha XLSX.</p>
        </Dialog>
      )}
    </div>
  );
});
