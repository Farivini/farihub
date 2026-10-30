import type { Model } from '@ironcalc/wasm';
import { MAX_COLUMN, MAX_ROW, rectSize } from '../core/address.ts';
import type { CellRef, Rect } from '../core/address.ts';
import { localizeValue, toDisplayInput, toEngineInput } from '../core/formula-locale.ts';
import { parseTsv, serializeTsv } from '../core/tsv.ts';
import { decodeFarcel, encodeFarcel } from '../core/file-format.ts';
import type { FarcelHeader } from '../core/file-format.ts';
import { computePivot, configFields } from '../core/pivot.ts';
import type { PivotConfig, PivotResult } from '../core/pivot.ts';
import { SYNTHETIC_HEADERS, rowToInputs, summaryFormulas, syntheticRows } from '../core/synthetic.ts';
import { decodeText, interpret, looksLikeFormula, parseDelimited, protectText, serializeDelimited } from '../core/delimited.ts';
import type { DelimitedExportMode, DelimitedOptions, Separator } from '../core/delimited.ts';
import { PivotSource } from './pivot-source.ts';
import {
  NO_HIDDEN, deleteRowsInRanges, insertRowsInRanges, rangesFromFlags, rangesWithin, replaceRanges,
} from '../core/row-map.ts';
import type { HiddenRanges } from '../core/row-map.ts';
import { DELETE_SECONDS_PER_CELL, INSERT_SECONDS_PER_CELL, isIdentity, passes, sortOrder } from '../core/table-ops.ts';
import type { FilterState, FilterValues, KeyColumn, OperationCost, TableOperation } from '../core/table-ops.ts';

export type IronCalc = typeof import('@ironcalc/wasm');
/** The engine-data editor compiled with IronCalc (vendor/xlsx-bridge): sort and hidden rows. */
export type TableBridge = Pick<typeof import('../../vendor/xlsx-bridge/xlsx_bridge.js'), 'WorkbookEdit'>;

export const IRONCALC_VERSION = '0.9.1';
/** es: comma decimal and semicolon separators, as pt-BR. Function names come from formula-locale.ts. */
export const ENGINE_LOCALE = 'es';
export const ENGINE_LANGUAGE = 'en';
export const ENGINE_TIMEZONE = 'America/Sao_Paulo';
export const MAX_COPY_CELLS = 500_000;
export const MAX_FORMAT_CELLS = 200_000;
const EXPORT_BLOCK_CELLS = 100_000;
/** Bands of shown rows cleared one by one when a selection crosses hidden rows. */
const MAX_CLEAR_BANDS = 5_000;

export const CellKind = { Empty: 0, Number: 1, Text: 2, Boolean: 3, Error: 4 } as const;

/**
 * Per-cell presentation flags in a viewport: bit 0 bold, bit 1 italic, bits 2-3 horizontal
 * alignment (0 general, 1 left, 2 center, 3 right).
 */
export const StyleFlag = { Bold: 1, Italic: 2, AlignShift: 2, AlignMask: 12 } as const;
const ALIGNMENTS = ['general', 'left', 'center', 'right'] as const;
export type HorizontalAlign = typeof ALIGNMENTS[number];

/** Number formats offered in the toolbar. Codes use the engine's canonical (en) notation. */
export const NUMBER_FORMATS = [
  { id: 'general', label: 'Geral', code: 'general', sample: '1234,5' },
  { id: 'number', label: 'Número', code: '#,##0.00', sample: '1.234,50' },
  { id: 'currency', label: 'Moeda (R$)', code: '"R$" #,##0.00', sample: 'R$ 1.234,50' },
  { id: 'percent', label: 'Porcentagem', code: '0.0%', sample: '12,5%' },
  { id: 'date', label: 'Data', code: 'dd/mm/yyyy', sample: '30/10/2026' },
] as const;
export type NumberFormatId = typeof NUMBER_FORMATS[number]['id'];

export type FormatChange =
  | { kind: 'bold'; value: boolean }
  | { kind: 'align'; value: HorizontalAlign }
  | { kind: 'number'; value: NumberFormatId };

export interface CellFormat { bold: boolean; align: HorizontalAlign; numberFormat: NumberFormatId | 'custom'; numberFormatCode: string }

export interface Viewport { sheet: number; top: number; left: number; rows: number; columns: number; values: string[]; kinds: Uint8Array; styles: Uint8Array; revision: number }
export interface Change { sheet: number; rect: Rect }

/** Row visibility and filters, per sheet. Replaced as a whole on every change (never mutated). */
export interface TableState { hidden: Map<number, HiddenRanges>; filters: Map<number, FilterState> }
const EMPTY_TABLE: TableState = { hidden: new Map(), filters: new Map() };

/**
 * One undo step. 'native': `steps` IronCalc undo steps (and the table state around them).
 * 'swap': an operation that produced a new model (sort, filter, delete); `model` and `table`
 * hold the other side, so undo and redo exchange them. Keeping the previous model alive keeps
 * its own undo history, so edits made before the operation can still be undone after it.
 */
type HistoryEntry =
  | { kind: 'native'; change: Change; steps: number; table?: { before: TableState; after: TableState } }
  | { kind: 'swap'; change: Change; model: Model; table: TableState };

/** Previous models kept for undo: fewer for large workbooks (each holds a full copy). */
const KEEP_MODELS = 4;
const KEEP_MODELS_LARGE = 1;
const LARGE_MODEL_BYTES = 4 * 1024 * 1024;

export interface GenerationReport {
  rows: number; columns: number; formulas: number; seed: number;
  fillMs: number; historyResetMs: number; evaluateMs: number; totalMs: number;
  wasmMemoryBytes: number | null;
}

const LONG_NUMBER = /^-?\d+,\d+$/;
/**
 * IronCalc's General format prints up to 17 significant digits (13260750,389999978);
 * Excel shows at most 15 (13260750,39). Only plain decimal text is touched.
 */
export function limitPrecision(value: string): string {
  if (!LONG_NUMBER.test(value) || value.replace(/[-,]/g, '').replace(/^0+/, '').length <= 15) return value;
  const rounded = Number(Number(value.replace(',', '.')).toPrecision(15));
  return String(rounded).replace('.', ',');
}

/**
 * The workbook. Wraps one IronCalc model, which is the single source of truth for cells,
 * formulas and references. Independent of DOM, Node, Tauri and Electron: it runs inside a
 * Web Worker in the browser and directly under Node for tests.
 */
export class WorkbookEngine {
  revision = 0;
  /** Bumped when hidden rows or filters change (the grid fetches the row layout again). */
  layoutVersion = 0;
  /** Set when old models were released and the oldest steps can no longer be undone. */
  historyTrimmed = false;
  /** IronCalc and the bridge, set by whoever loads them (worker, tests). */
  static ic: IronCalc | null = null;
  static bridge: TableBridge | null = null;
  readonly pivotSource: PivotSource;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private table: TableState = EMPTY_TABLE;
  private clipboard: { sheet: number; rect: Rect; tsv: string; data: ReturnType<Model['copyToClipboard']> } | null = null;

  private model: Model;
  private memoryBytes: () => number | null;

  constructor(model: Model, memoryBytes: () => number | null = () => null) {
    this.model = model;
    this.memoryBytes = memoryBytes;
    this.pivotSource = new PivotSource(() => this.model, 0);
  }

  static create(ic: IronCalc, name = 'Pasta1', memoryBytes?: () => number | null): WorkbookEngine {
    WorkbookEngine.ic = ic;
    const model = new ic.Model(name, ENGINE_LOCALE, ENGINE_TIMEZONE, ENGINE_LANGUAGE);
    model.renameSheet(0, 'Planilha1');
    return new WorkbookEngine(model, memoryBytes);
  }

  get name(): string { return this.model.getName(); }

  sheets(): string[] {
    return this.model.getWorksheetsProperties().map(sheet => sheet.name);
  }

  addSheet(): number {
    const existing = new Set(this.sheets());
    this.model.newSheet();
    const index = this.sheets().length - 1;
    let n = index + 1;
    while (existing.has(`Planilha${n}`)) n++;
    this.model.renameSheet(index, `Planilha${n}`);
    // New sheet and its name: two IronCalc undo steps, one for the person.
    this.commit({ sheet: index, rect: { top: 1, left: 1, bottom: 1, right: 1 } }, 2);
    return index;
  }

  viewport(sheet: number, top: number, left: number, rows: number, columns: number): Viewport {
    rows = Math.max(0, Math.min(rows, MAX_ROW - top + 1));
    columns = Math.max(0, Math.min(columns, MAX_COLUMN - left + 1));
    const values: string[] = new Array(rows * columns);
    const kinds = new Uint8Array(rows * columns);
    const styles = new Uint8Array(rows * columns);
    this.readValues(sheet, top, left, rows, columns, values, kinds, styles);
    return { sheet, top, left, rows, columns, values, kinds, styles, revision: this.revision };
  }

  /** Displayed values (and kinds) of a block; style flags too when `styles` is given. */
  private readValues(sheet: number, top: number, left: number, rows: number, columns: number, values: string[], kinds: Uint8Array, styles?: Uint8Array) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++) {
        const i = r * columns + c;
        const value = this.model.getFormattedCellValue(sheet, top + r, left + c);
        if (styles && value !== '') styles[i] = this.styleFlags(sheet, top + r, left + c);
        const type = this.model.getCellType(sheet, top + r, left + c);
        if (type === 1) {
          values[i] = limitPrecision(value);
          kinds[i] = value === '' ? CellKind.Empty : CellKind.Number;
        } else if (type === 4) {
          values[i] = localizeValue(value, 'boolean');
          kinds[i] = CellKind.Boolean;
        } else if (type === 16) {
          values[i] = localizeValue(value, 'error');
          kinds[i] = CellKind.Error;
        } else {
          values[i] = value;
          kinds[i] = CellKind.Text;
        }
      }
    }
  }

  private styleFlags(sheet: number, row: number, column: number): number {
    const style = this.model.getCellStyle(sheet, row, column).style;
    let flags = 0;
    if (style.font?.b) flags |= StyleFlag.Bold;
    if (style.font?.i) flags |= StyleFlag.Italic;
    const align = ALIGNMENTS.indexOf((style.alignment?.horizontal ?? 'general') as HorizontalAlign);
    if (align > 0) flags |= align << StyleFlag.AlignShift;
    return flags;
  }

  /** Formatting of one cell, for the toolbar state. */
  cellFormat(sheet: number, row: number, column: number): CellFormat {
    const style = this.model.getCellStyle(sheet, row, column).style;
    const code = style.num_fmt ?? 'general';
    const known = NUMBER_FORMATS.find(f => f.code.toLowerCase() === code.toLowerCase());
    const align = (style.alignment?.horizontal ?? 'general') as HorizontalAlign;
    return {
      bold: !!style.font?.b,
      align: ALIGNMENTS.includes(align) ? align : 'general',
      numberFormat: known?.id ?? 'custom',
      numberFormatCode: code,
    };
  }

  /**
   * Applies one formatting change to a range. One engine undo step.
   * IronCalc stores the style per cell (a whole column costs about 1 s and 250 MB), so whole
   * columns or rows are limited to the cells that hold data, and other ranges to MAX_FORMAT_CELLS.
   */
  format(sheet: number, input: Rect, change: FormatChange): Change {
    const rect = { ...input };
    const wholeColumns = rect.top === 1 && rect.bottom === MAX_ROW;
    const wholeRows = rect.left === 1 && rect.right === MAX_COLUMN;
    if (wholeColumns || wholeRows) {
      // Extent of the data inside the whole selection (scanning every column takes ~30 ms).
      let lastRow = 0;
      let lastColumn = 0;
      for (let column = rect.left; column <= rect.right; column++) {
        const rows = this.model.getRowsWithData(sheet, column);
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          if (row < rect.top || row > rect.bottom) continue;
          if (row > lastRow) lastRow = row;
          lastColumn = column;
        }
      }
      if (wholeColumns) rect.bottom = Math.max(rect.top, lastRow);
      if (wholeRows) rect.right = Math.max(rect.left, lastColumn);
    }
    if (rectSize(rect) > MAX_FORMAT_CELLS) {
      throw new RangeError(`Seleção grande demais para formatar nesta versão (máximo ${MAX_FORMAT_CELLS.toLocaleString('pt-BR')} células).`);
    }
    const area = { sheet, row: rect.top, column: rect.left, width: rect.right - rect.left + 1, height: rect.bottom - rect.top + 1 };
    if (change.kind === 'bold') this.model.updateRangeStyle(area, 'font.b', String(change.value));
    else if (change.kind === 'align') this.model.updateRangeStyle(area, 'alignment.horizontal', change.value);
    else {
      const format = NUMBER_FORMATS.find(f => f.id === change.value);
      if (!format) throw new RangeError(`Formato desconhecido: ${change.value}`);
      this.model.updateRangeStyle(area, 'num_fmt', format.code);
    }
    return this.commit({ sheet, rect });
  }

  /** Text for the formula bar / cell editor, in pt-BR. */
  input(sheet: number, row: number, column: number): string {
    return toDisplayInput(this.model.getCellContent(sheet, row, column));
  }

  /** Engine content as stored (canonical function names). For tests and diagnostics. */
  rawContent(sheet: number, row: number, column: number): string {
    return this.model.getCellContent(sheet, row, column);
  }

  formatted(sheet: number, row: number, column: number): string {
    return this.viewport(sheet, row, column, 1, 1).values[0];
  }

  /** Records an edit made through IronCalc's own history (`steps` undo steps). */
  private commit(change: Change, steps = 1, table?: { before: TableState; after: TableState }): Change {
    this.revision++;
    this.undoStack.push({ kind: 'native', change, steps, table });
    this.clearRedo();
    if (table) this.layoutChanged();
    else this.pivotSource.onChange(change.sheet, change.rect);
    return change;
  }

  private clearRedo() {
    for (const entry of this.redoStack) if (entry.kind === 'swap') entry.model.free();
    this.redoStack = [];
  }

  private layoutChanged() {
    this.layoutVersion++;
    this.clipboard = null;
    // Rows moved or appeared: the pivot source is read again (whole base, hidden rows included).
    this.pivotSource.reset(this.pivotSource.sheet);
  }

  /** Makes `model` current; the previous one is kept for undo. */
  private swapIn(model: Model, change: Change, table: TableState, size: number): Change {
    this.undoStack.push({ kind: 'swap', change, model: this.model, table: this.table });
    this.model = model;
    this.table = table;
    this.clearRedo();
    const keep = size > LARGE_MODEL_BYTES ? KEEP_MODELS_LARGE : KEEP_MODELS;
    let swaps = this.undoStack.filter(e => e.kind === 'swap').length;
    while (swaps > keep) {
      const oldest = this.undoStack.findIndex(e => e.kind === 'swap');
      (this.undoStack[oldest] as Extract<HistoryEntry, { kind: 'swap' }>).model.free();
      this.undoStack.splice(0, oldest + 1);
      this.historyTrimmed = true;
      swaps--;
    }
    this.revision++;
    this.layoutChanged();
    return change;
  }

  private step(entry: HistoryEntry, direction: 'undo' | 'redo') {
    if (entry.kind === 'native') {
      for (let i = 0; i < entry.steps; i++) {
        if (direction === 'undo' && this.model.canUndo()) this.model.undo();
        if (direction === 'redo' && this.model.canRedo()) this.model.redo();
      }
      if (entry.table) this.table = direction === 'undo' ? entry.table.before : entry.table.after;
    } else {
      const model = this.model, table = this.table;
      this.model = entry.model;
      this.table = entry.table;
      entry.model = model;
      entry.table = table;
    }
    this.revision++;
    if (entry.kind === 'swap' || entry.table) this.layoutChanged();
    else this.pivotSource.onChange(entry.change.sheet, entry.change.rect);
  }

  setInput(sheet: number, row: number, column: number, text: string): Change {
    this.model.setUserInput(sheet, row, column, toEngineInput(text));
    return this.commit({ sheet, rect: { top: row, left: column, bottom: row, right: column } });
  }

  /** Clears contents. Rows hidden inside the range keep theirs, as in Excel with a filter. */
  clear(sheet: number, rect: Rect): Change {
    const hidden = rangesWithin(this.table.hidden.get(sheet) ?? NO_HIDDEN, rect.top, rect.bottom);
    if (!hidden.length) {
      this.model.rangeClearContents(sheet, rect.top, rect.left, rect.bottom, rect.right);
      return this.commit({ sheet, rect });
    }
    const bands: Array<[number, number]> = [];
    let top = rect.top;
    for (let i = 0; i < hidden.length; i += 2) {
      if (hidden[i] > top) bands.push([top, hidden[i] - 1]);
      top = hidden[i + 1] + 1;
    }
    if (top <= rect.bottom) bands.push([top, rect.bottom]);
    if (bands.length > MAX_CLEAR_BANDS) {
      throw new RangeError(`A seleção alterna linhas visíveis e ocultas ${bands.length.toLocaleString('pt-BR')} vezes; limpe o filtro ou selecione menos linhas (máximo ${MAX_CLEAR_BANDS.toLocaleString('pt-BR')} trechos).`);
    }
    for (const [from, to] of bands) this.model.rangeClearContents(sheet, from, rect.left, to, rect.right);
    // One IronCalc step per band of shown rows, one step for the person.
    return this.commit({ sheet, rect }, bands.length);
  }

  /**
   * Pastes clipboard text at `origin`. Text copied from this workbook is pasted from the
   * engine clipboard so relative references move as in Excel; anything else is parsed as
   * tab separated values, each cell translated as typed pt-BR input. One undo step.
   */
  paste(sheet: number, origin: CellRef, text: string): Change {
    if (this.clipboard && this.clipboard.tsv === text) {
      const source = this.clipboard;
      const height = source.rect.bottom - source.rect.top;
      const width = source.rect.right - source.rect.left;
      const rect = { top: origin.row, left: origin.column, bottom: origin.row + height, right: origin.column + width };
      this.model.setSelectedSheet(sheet);
      this.model.setSelectedCell(rect.top, rect.left);
      this.model.setSelectedRange(rect.top, rect.left, rect.bottom, rect.right);
      this.model.pasteFromClipboard(source.sheet, [source.rect.top, source.rect.left, source.rect.bottom, source.rect.right], source.data.data, false);
      return this.commit({ sheet, rect });
    }
    const grid = parseTsv(text).map(row => row.map(toEngineInput));
    const height = grid.length;
    const width = grid[0].length;
    if (origin.row + height - 1 > MAX_ROW || origin.column + width - 1 > MAX_COLUMN) {
      throw new RangeError('A área colada ultrapassa o limite da planilha.');
    }
    const rect = { top: origin.row, left: origin.column, bottom: origin.row + height - 1, right: origin.column + width - 1 };
    this.model.setSelectedSheet(sheet);
    this.model.setSelectedCell(rect.top, rect.left);
    this.model.pasteCsvText({ sheet, row: rect.top, column: rect.left, width, height }, serializeTsv(grid));
    return this.commit({ sheet, rect });
  }

  /** Copies the displayed values as TSV (what other apps receive) and keeps the engine clipboard. */
  copy(sheet: number, rect: Rect): string {
    if (rectSize(rect) > MAX_COPY_CELLS) {
      throw new RangeError(`Seleção grande demais para copiar nesta versão (máximo ${MAX_COPY_CELLS.toLocaleString('pt-BR')} células).`);
    }
    const view = this.viewport(sheet, rect.top, rect.left, rect.bottom - rect.top + 1, rect.right - rect.left + 1);
    const hidden = rangesWithin(this.table.hidden.get(sheet) ?? NO_HIDDEN, rect.top, rect.bottom);
    const rows: string[][] = [];
    for (let r = 0; r < view.rows; r++) {
      if (hidden.length && isHiddenIn(hidden, rect.top + r)) continue;
      rows.push(view.values.slice(r * view.columns, (r + 1) * view.columns));
    }
    const tsv = serializeTsv(rows);
    if (hidden.length) {
      // As Excel, a range with hidden rows copies the shown rows; they paste as values.
      this.clipboard = null;
      return tsv;
    }
    this.model.setSelectedSheet(sheet);
    this.model.setSelectedCell(rect.top, rect.left);
    this.model.setSelectedRange(rect.top, rect.left, rect.bottom, rect.right);
    this.clipboard = { sheet, rect, tsv, data: this.model.copyToClipboard() };
    return tsv;
  }

  undo(): Change | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.step(entry, 'undo');
    this.redoStack.push(entry);
    return entry.change;
  }

  redo(): Change | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.step(entry, 'redo');
    this.undoStack.push(entry);
    return entry.change;
  }

  /** Releases every model held by this workbook (current and kept for undo). */
  dispose(): void {
    for (const entry of [...this.undoStack, ...this.redoStack]) if (entry.kind === 'swap') entry.model.free();
    this.undoStack = [];
    this.redoStack = [];
    this.model.free();
  }

  /** Ctrl+arrow target, Excel semantics: edge of the current block or next non-empty cell. */
  edge(sheet: number, from: CellRef, direction: 'up' | 'down' | 'left' | 'right'): CellRef {
    const vertical = direction === 'up' || direction === 'down';
    const forward = direction === 'down' || direction === 'right';
    const filled = vertical
      ? this.model.getRowsWithData(sheet, from.column)
      : this.model.getColumnsWithData(sheet, from.row);
    const set = new Set(filled);
    const sorted = Array.from(filled).sort((a, b) => a - b);
    const position = vertical ? from.row : from.column;
    const limit = vertical ? MAX_ROW : MAX_COLUMN;
    const step = forward ? 1 : -1;
    const at = (p: number) => vertical ? { row: p, column: from.column } : { row: from.row, column: p };
    if (set.has(position) && set.has(position + step)) {
      let p = position;
      while (set.has(p + step)) p += step;
      return at(p);
    }
    const next = forward ? sorted.find(p => p > position) : [...sorted].reverse().find(p => p < position);
    return at(next ?? (forward ? limit : 1));
  }

  // ---------------------------------------------------------------- table operations

  /** Hidden rows (pairs) and the filter of a sheet, for the grid. */
  rowLayout(sheet: number): { hidden: HiddenRanges; filter: FilterState | null } {
    return { hidden: this.table.hidden.get(sheet) ?? NO_HIDDEN, filter: this.table.filters.get(sheet) ?? null };
  }

  /** Sheets that have a filter (a filter is not part of an .xlsx file). */
  filteredSheets(): number[] { return [...this.table.filters.keys()]; }

  /** Reads the hidden rows of every sheet from the model (after a file is loaded). */
  loadLayout(filters: FilterState[][] = []): void {
    const bridge = WorkbookEngine.bridge;
    if (!bridge) throw new Error('Editor de tabela não carregado');
    const edit = new bridge.WorkbookEdit(this.model.toBytes());
    const hidden = new Map<number, HiddenRanges>();
    try {
      this.sheets().forEach((_, sheet) => {
        const ranges = edit.hiddenRows(sheet);
        if (ranges.length) hidden.set(sheet, ranges);
      });
    } finally {
      edit.free();
    }
    const kept = new Map<number, FilterState>();
    filters.forEach((list, sheet) => { if (list[0]) kept.set(sheet, list[0]); });
    this.table = { hidden, filters: kept };
    this.layoutVersion++;
  }

  /** What an insertion or deletion makes IronCalc move, cell by cell. */
  estimate(op: TableOperation): OperationCost {
    if (op.kind !== 'insertRows' && op.kind !== 'deleteRows' && op.kind !== 'insertColumns' && op.kind !== 'deleteColumns') return { cells: 0, seconds: 0 };
    const used = this.usedRangeFrom(op.sheet);
    const cells = op.kind === 'insertRows' || op.kind === 'deleteRows'
      ? Math.max(0, used.rows - op.at + 1) * used.columns
      : Math.max(0, used.columns - op.at + 1) * used.rows;
    const perCell = op.kind === 'deleteRows' || op.kind === 'deleteColumns' ? DELETE_SECONDS_PER_CELL : INSERT_SECONDS_PER_CELL;
    return { cells, seconds: cells * perCell };
  }

  /**
   * Runs a table operation as one undo step. Insertions use IronCalc directly (it updates
   * references in every sheet and its undo restores them). Deletions run on a copy of the
   * model, because IronCalc 0.9.1's undo of a deletion leaves #REF! in formulas that pointed
   * at the deleted cells; undo returns to the previous model instead. Sort and filters go
   * through the bridge, which edits the model data in one pass.
   */
  apply(op: TableOperation): Change {
    switch (op.kind) {
      case 'insertRows': return this.insertRows(op.sheet, op.at, op.count);
      case 'insertColumns': return this.insertColumns(op.sheet, op.at, op.count);
      case 'deleteRows':
      case 'deleteColumns': return this.deleteLines(op.kind, op.sheet, op.at, op.count);
      case 'sort': return this.sort(op);
      case 'setFilter': return this.setFilter(op.sheet, { range: op.range, criteria: op.criteria });
      case 'clearFilter': return this.clearFilter(op.sheet);
      case 'showRows': return this.showRows(op.sheet, op.top, op.bottom);
    }
  }

  private withTable(sheet: number, hidden: HiddenRanges | undefined, filter: FilterState | null | undefined): TableState {
    const next: TableState = { hidden: new Map(this.table.hidden), filters: new Map(this.table.filters) };
    if (hidden !== undefined) {
      if (hidden.length) next.hidden.set(sheet, hidden); else next.hidden.delete(sheet);
    }
    if (filter !== undefined) {
      if (filter) next.filters.set(sheet, filter); else next.filters.delete(sheet);
    }
    return next;
  }

  private insertRows(sheet: number, at: number, count: number): Change {
    checkCount(count, MAX_ROW);
    const before = this.table;
    this.model.insertRows(sheet, at, count);
    const filter = this.table.filters.get(sheet);
    const after = this.withTable(sheet, insertRowsInRanges(this.table.hidden.get(sheet) ?? NO_HIDDEN, at, count), filter && shiftFilterRows(filter, at, count));
    this.table = after;
    return this.commit({ sheet, rect: { top: at, left: 1, bottom: MAX_ROW, right: MAX_COLUMN } }, 1, { before, after });
  }

  private insertColumns(sheet: number, at: number, count: number): Change {
    checkCount(count, MAX_COLUMN);
    const before = this.table;
    this.model.insertColumns(sheet, at, count);
    const filter = this.table.filters.get(sheet);
    const after = this.withTable(sheet, undefined, filter && shiftFilterColumns(filter, at, count));
    this.table = after;
    return this.commit({ sheet, rect: { top: 1, left: at, bottom: MAX_ROW, right: MAX_COLUMN } }, 1, { before, after });
  }

  private deleteLines(kind: 'deleteRows' | 'deleteColumns', sheet: number, at: number, count: number): Change {
    checkCount(count, kind === 'deleteRows' ? MAX_ROW : MAX_COLUMN);
    const ic = WorkbookEngine.requireIronCalc();
    const bytes = this.model.toBytes();
    const copy = ic.Model.fromBytes(bytes, ENGINE_LANGUAGE);
    try {
      if (kind === 'deleteRows') copy.deleteRows(sheet, at, count);
      else copy.deleteColumns(sheet, at, count);
      copy.evaluate();
    } catch (error) {
      copy.free();
      throw error;
    }
    const filter = this.table.filters.get(sheet);
    const table = kind === 'deleteRows'
      ? this.withTable(sheet, deleteRowsInRanges(this.table.hidden.get(sheet) ?? NO_HIDDEN, at, count), filter && deleteFilterRows(filter, at, count))
      : this.withTable(sheet, undefined, filter && deleteFilterColumns(filter, at, count));
    const rect = kind === 'deleteRows' ? { top: at, left: 1, bottom: MAX_ROW, right: MAX_COLUMN } : { top: 1, left: at, bottom: MAX_ROW, right: MAX_COLUMN };
    return this.swapIn(copy, { sheet, rect }, table, bytes.length);
  }

  /**
   * Sorts the rows of the range, Excel's way: whole records move (values, formulas, styles,
   * links); relative references inside a moved formula keep their offset, absolute ones and
   * references from outside the range do not change. Hidden rows travel with their records.
   */
  private sort(op: Extract<TableOperation, { kind: 'sort' }>): Change {
    const { sheet, range, header, keys } = op;
    const first = header ? range.top + 1 : range.top;
    const last = range.bottom;
    if (!keys.length) throw new RangeError('Escolha ao menos uma coluna para ordenar.');
    for (const key of keys) {
      if (key.column < range.left || key.column > range.right) throw new RangeError('A coluna de ordenação está fora do intervalo.');
    }
    const change = { sheet, rect: { top: first, left: range.left, bottom: last, right: range.right } };
    if (last - first < 1) return change;
    const bridge = WorkbookEngine.requireBridge();
    const bytes = this.model.toBytes();
    const edit = new bridge.WorkbookEdit(bytes);
    let model: Model;
    let hidden = this.table.hidden.get(sheet) ?? NO_HIDDEN;
    try {
      const columns: KeyColumn[] = keys.map(key => {
        const values = edit.sortKeys(sheet, first, last, key.column);
        const column = { kinds: values.kinds, numbers: values.numbers, texts: values.texts, descending: !!key.descending };
        values.free();
        return column;
      });
      const order = sortOrder(columns);
      if (isIdentity(order)) return change;
      edit.reorderRows(sheet, first, range.left, range.right, order);
      const inside = rangesWithin(hidden, first, last);
      if (inside.length) {
        const was = new Uint8Array(last - first + 1);
        for (let i = 0; i < inside.length; i += 2) was.fill(1, inside[i] - first, inside[i + 1] - first + 1);
        const now = Uint8Array.from(order, o => was[o]);
        const moved = rangesFromFlags(first, now);
        edit.setHiddenRows(sheet, first, last, moved);
        hidden = replaceRanges(hidden, first, last, moved);
      }
      model = WorkbookEngine.requireIronCalc().Model.fromBytes(edit.toBytes(), ENGINE_LANGUAGE);
    } finally {
      edit.free();
    }
    model.evaluate();
    return this.swapIn(model, change, this.withTable(sheet, hidden, undefined), bytes.length);
  }

  /** Hides the data rows of the range that fail a criterion and shows the others. */
  private setFilter(sheet: number, filter: FilterState): Change {
    const { range } = filter;
    if (range.bottom <= range.top) throw new RangeError('O filtro precisa de um cabeçalho e ao menos uma linha de dados.');
    for (const criterion of filter.criteria) {
      if (criterion.column < range.left || criterion.column > range.right) throw new RangeError('O critério está fora do intervalo do filtro.');
    }
    const first = range.top + 1, last = range.bottom;
    const hide = new Uint8Array(last - first + 1);
    for (const criterion of filter.criteria) {
      this.columnValues(sheet, first, last, criterion.column, (i, text) => { if (!passes(criterion, text)) hide[i] = 1; });
    }
    const previous = this.table.filters.get(sheet);
    // Rows of a previous, larger filter range are shown again.
    const from = Math.min(first, previous ? previous.range.top + 1 : first);
    const to = Math.max(last, previous ? previous.range.bottom : last);
    return this.setHidden(sheet, from, to, rangesFromFlags(first, hide), filter);
  }

  private clearFilter(sheet: number): Change {
    const filter = this.table.filters.get(sheet);
    if (!filter) throw new RangeError('Esta planilha não tem filtro.');
    return this.setHidden(sheet, filter.range.top + 1, filter.range.bottom, NO_HIDDEN, null);
  }

  private showRows(sheet: number, top: number, bottom: number): Change {
    return this.setHidden(sheet, top, bottom, NO_HIDDEN, undefined);
  }

  /** Rows `from..to` hidden exactly as `inside` says; a new model only if visibility changes. */
  private setHidden(sheet: number, from: number, to: number, inside: HiddenRanges, filter: FilterState | null | undefined): Change {
    const current = this.table.hidden.get(sheet) ?? NO_HIDDEN;
    const hidden = replaceRanges(current, from, to, inside);
    const table = this.withTable(sheet, hidden, filter);
    const change = { sheet, rect: { top: from, left: 1, bottom: to, right: MAX_COLUMN } };
    if (sameRanges(rangesWithin(current, from, to), inside)) {
      // Only the filter definition changed: no model change, still one undo step.
      const before = this.table;
      this.table = table;
      return this.commit(change, 0, { before, after: table });
    }
    const bridge = WorkbookEngine.requireBridge();
    const bytes = this.model.toBytes();
    const edit = new bridge.WorkbookEdit(bytes);
    let model: Model;
    try {
      edit.setHiddenRows(sheet, from, to, inside);
      model = WorkbookEngine.requireIronCalc().Model.fromBytes(edit.toBytes(), ENGINE_LANGUAGE);
    } finally {
      edit.free();
    }
    model.evaluate();
    return this.swapIn(model, change, table, bytes.length);
  }

  /** Displayed text of `column` in rows `first..last`, block by block, as the grid shows it. */
  private columnValues(sheet: number, first: number, last: number, column: number, visit: (index: number, text: string) => void) {
    const block = 50_000;
    const values: string[] = new Array(block);
    const kinds = new Uint8Array(block);
    for (let top = first; top <= last; top += block) {
      const rows = Math.min(block, last - top + 1);
      this.readValues(sheet, top, column, rows, 1, values, kinds);
      for (let r = 0; r < rows; r++) visit(top - first + r, kinds[r] === CellKind.Empty ? '' : values[r]);
    }
  }

  /** Distinct displayed values of a filter column (data rows of the sheet's filter) with counts. */
  filterValues(sheet: number, column: number, search = '', limit = 1000): FilterValues {
    const filter = this.table.filters.get(sheet);
    if (!filter) throw new RangeError('Esta planilha não tem filtro.');
    const counts = new Map<string, number>();
    this.columnValues(sheet, filter.range.top + 1, filter.range.bottom, column, (_, text) => counts.set(text, (counts.get(text) ?? 0) + 1));
    const criterion = filter.criteria.find(c => c.column === column);
    const fold = (t: string) => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    const needle = fold(search.trim());
    const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'accent' });
    const all = [...counts.entries()]
      .filter(([text]) => !needle || fold(text).includes(needle))
      .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : collator.compare(a, b)));
    return {
      values: all.slice(0, limit).map(([text, count]) => ({ text, count, selected: !criterion || passes(criterion, text) })),
      distinct: all.length,
      truncated: all.length > limit,
    };
  }

  /**
   * Excel's current region: the block of filled cells connected to `cell` (diagonals count).
   * Reads the filled rows of each column involved once (one engine call per column), so a
   * table of a million rows costs a few calls, not one per row.
   */
  region(sheet: number, cell: CellRef): Rect {
    const rowsOf = new Map<number, Int32Array>();
    const filled = (column: number) => {
      let rows = rowsOf.get(column);
      if (!rows) { rows = this.model.getRowsWithData(sheet, column); rowsOf.set(column, rows); }
      return rows;
    };
    // Rows with data in any column of the span around the block, grown as columns join.
    const occupied = new Uint8Array(MAX_ROW + 2);
    const marked = new Set<number>();
    const mark = (column: number) => {
      if (column < 1 || column > MAX_COLUMN || marked.has(column)) return;
      marked.add(column);
      for (const row of filled(column)) occupied[row] = 1;
    };
    const hasData = (column: number, top: number, bottom: number) => column >= 1 && column <= MAX_COLUMN && filled(column).some(row => row >= top && row <= bottom);
    const rect = { top: cell.row, left: cell.column, bottom: cell.row, right: cell.column };
    for (let changed = true; changed;) {
      changed = false;
      for (let column = rect.left - 1; column <= rect.right + 1; column++) mark(column);
      while (rect.bottom < MAX_ROW && occupied[rect.bottom + 1]) { rect.bottom++; changed = true; }
      while (rect.top > 1 && occupied[rect.top - 1]) { rect.top--; changed = true; }
      // A column next to the block joins when it has data in the block's rows or the rows next to them.
      if (hasData(rect.left - 1, rect.top - 1, rect.bottom + 1)) { rect.left--; changed = true; }
      if (hasData(rect.right + 1, rect.top - 1, rect.bottom + 1)) { rect.right++; changed = true; }
    }
    return rect;
  }

  /** Rows and columns in use from row 1, stopping after 4 096 empty rows in a row. */
  private usedRangeFrom(sheet: number): { rows: number; columns: number } {
    let rows = 0, columns = 0, empty = 0;
    for (let row = 1; row <= MAX_ROW && empty < 4096; row++) {
      const filled = this.model.getColumnsWithData(sheet, row);
      if (!filled.length) { empty++; continue; }
      empty = 0;
      rows = row;
      for (let i = 0; i < filled.length; i++) if (filled[i] > columns) columns = filled[i];
    }
    return { rows, columns };
  }

  private static requireBridge(): TableBridge {
    if (!WorkbookEngine.bridge) throw new Error('Editor de tabela não carregado');
    return WorkbookEngine.bridge;
  }

  private static requireIronCalc(): IronCalc {
    if (!WorkbookEngine.ic) throw new Error('IronCalc não carregado');
    return WorkbookEngine.ic;
  }

  async pivot(config: PivotConfig, onProgress?: (done: number, total: number, field: string) => void): Promise<PivotResult & { extractMs: number; aggregateMs: number }> {
    const started = performance.now();
    const columns = await this.pivotSource.ensure(configFields(config), onProgress);
    const extracted = performance.now();
    const result = computePivot(columns, this.pivotSource.rowCount, config);
    return { ...result, extractMs: extracted - started, aggregateMs: performance.now() - extracted };
  }

  /** Saves to the Farcel container. */
  toFile(app: Record<string, unknown>): Uint8Array {
    // Filters go in the header (one list per sheet); hidden rows are in the model itself.
    const filters = this.sheets().map((_, sheet) => this.table.filters.has(sheet) ? [this.table.filters.get(sheet)!] : []);
    return encodeFarcel(this.model.toBytes(), IRONCALC_VERSION, this.table.filters.size ? { ...app, filters } : app);
  }

  static fromFile(ic: IronCalc, file: Uint8Array, memoryBytes?: () => number | null): { engine: WorkbookEngine; header: FarcelHeader; evaluateMs: number } {
    const { header, payload } = decodeFarcel(file);
    return { ...WorkbookEngine.fromModelBytes(ic, payload, memoryBytes), header };
  }

  /** A model from `Model.toBytes()` data (a .farcel payload or a converted .xlsx), recalculated. */
  static fromModelBytes(ic: IronCalc, bytes: Uint8Array, memoryBytes?: () => number | null): { engine: WorkbookEngine; evaluateMs: number } {
    WorkbookEngine.ic = ic;
    const model = ic.Model.fromBytes(bytes, ENGINE_LANGUAGE);
    const started = performance.now();
    model.evaluate();
    return { engine: new WorkbookEngine(model, memoryBytes), evaluateMs: performance.now() - started };
  }

  /** The engine's own representation of the workbook, as `Model.toBytes()` returns it. */
  modelBytes(): Uint8Array {
    return this.model.toBytes();
  }

  /**
   * A new workbook with one sheet holding a delimited text file. Every value goes through
   * `interpret` (explicit numbers, dates and text; no formulas). Refuses files beyond the
   * sheet limits instead of cutting them.
   */
  static async fromDelimited(ic: IronCalc, name: string, bytes: Uint8Array, options: DelimitedOptions, settings: {
    chunk?: number; memoryBytes?: () => number | null; onProgress?: (done: number, total: number) => void;
  } = {}): Promise<{ engine: WorkbookEngine; rows: number; columns: number }> {
    WorkbookEngine.ic = ic;
    const chunk = settings.chunk ?? 100_000;
    const text = decodeText(bytes, options.encoding);
    // Progress total: line breaks, an upper bound when quoted fields hold line breaks.
    let lines = 1;
    for (let i = text.indexOf('\n'); i !== -1 && i < text.length - 1; i = text.indexOf('\n', i + 1)) lines++;
    let model = new ic.Model(name, ENGINE_LOCALE, ENGINE_TIMEZONE, ENGINE_LANGUAGE);
    model.renameSheet(0, sheetName(name));
    model.pauseEvaluation();
    const engine = new WorkbookEngine(model, settings.memoryBytes);
    let row = 0;
    let columns = 0;
    try {
      for (const fields of parseDelimited(text, options.separator)) {
        row++;
        if (row > MAX_ROW) throw new RangeError(`O arquivo tem mais de ${MAX_ROW.toLocaleString('pt-BR')} linhas, o limite de uma planilha. Nada foi importado.`);
        if (fields.length > MAX_COLUMN) throw new RangeError(`A linha ${row} tem mais de ${MAX_COLUMN.toLocaleString('pt-BR')} colunas, o limite de uma planilha. Nada foi importado.`);
        columns = Math.max(columns, fields.length);
        const header = options.header && row === 1;
        for (let c = 0; c < fields.length; c++) {
          const value = interpret(fields[c], header ? 'text' : options.columns[c] ?? 'auto', options.decimal);
          if (value.input !== null) model.setUserInput(0, row, c + 1, value.input);
        }
        if (row % chunk === 0) {
          model = resetHistory(ic, model);
          engine.model = model;
          settings.onProgress?.(row, Math.max(row, lines));
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
    } catch (error) {
      model.free();
      throw error;
    }
    engine.model = resetHistory(ic, model);
    engine.model.resumeEvaluation();
    engine.model.evaluate();
    engine.pivotSource.reset(0);
    engine.revision++;
    return { engine, rows: row, columns };
  }

  /** Last row and column holding data in a sheet (0 when empty). Scans rows, about 0.3 s per sheet. */
  usedRange(sheet: number): { rows: number; columns: number } {
    let rows = 0;
    let columns = 0;
    for (let row = 1; row <= MAX_ROW; row++) {
      const filled = this.model.getColumnsWithData(sheet, row);
      if (filled.length === 0) continue;
      rows = row;
      for (let i = 0; i < filled.length; i++) if (filled[i] > columns) columns = filled[i];
    }
    return { rows, columns };
  }

  /**
   * One sheet as delimited text with the values as displayed (results, not formulas). In
   * 'spreadsheet' mode, text cells a spreadsheet would run as formulas get a leading
   * apostrophe; `protectedCells` counts them. Number cells are never changed.
   */
  toDelimited(sheet: number, separator: Separator, mode: DelimitedExportMode = 'spreadsheet'): { text: string; rows: number; columns: number; protectedCells: number } {
    const { rows, columns } = this.usedRange(sheet);
    const out: string[] = [];
    let protectedCells = 0;
    // About EXPORT_BLOCK_CELLS per block, never more rows than the sheet uses.
    const block = Math.max(1, Math.min(rows, Math.floor(EXPORT_BLOCK_CELLS / Math.max(1, columns))));
    const values: string[] = new Array(block * columns);
    const kinds = new Uint8Array(block * columns);
    for (let top = 1; top <= rows; top += block) {
      const height = Math.min(block, rows - top + 1);
      this.readValues(sheet, top, 1, height, columns, values, kinds);
      if (mode === 'spreadsheet') {
        for (let i = 0; i < height * columns; i++) {
          if (kinds[i] === CellKind.Text && looksLikeFormula(values[i])) {
            values[i] = protectText(values[i]);
            protectedCells++;
          }
        }
      }
      const lines: string[][] = [];
      for (let r = 0; r < height; r++) lines.push(values.slice(r * columns, (r + 1) * columns));
      out.push(serializeDelimited(lines, separator));
    }
    return { text: out.join(''), rows, columns, protectedCells };
  }

  /**
   * Builds the reproducible synthetic base in a fresh model: sheet "Dados" (headers plus
   * `rows` populated rows, five columns) and sheet "Resumo" with three aggregate formulas.
   * The model is rebuilt from its own bytes every chunk to drop the undo history that
   * IronCalc keeps for each user input (measured: hundreds of bytes per cell).
   */
  static async generateSynthetic(ic: IronCalc, rows: number, seed: number, options: {
    chunk?: number; memoryBytes?: () => number | null; onProgress?: (done: number, total: number, engine: WorkbookEngine) => void;
  } = {}): Promise<{ engine: WorkbookEngine; report: GenerationReport }> {
    WorkbookEngine.ic = ic;
    const chunk = options.chunk ?? 100_000;
    const started = performance.now();
    let model = new ic.Model('Base sintética', ENGINE_LOCALE, ENGINE_TIMEZONE, ENGINE_LANGUAGE);
    model.renameSheet(0, 'Dados');
    model.pauseEvaluation();
    SYNTHETIC_HEADERS.forEach((header, i) => model.setUserInput(0, 1, i + 1, header));
    const engine = new WorkbookEngine(model, options.memoryBytes);
    let fillMs = 0;
    let historyResetMs = 0;
    let row = 2;
    let fillStarted = performance.now();
    for (const data of syntheticRows(rows, seed)) {
      const inputs = rowToInputs(data);
      for (let c = 0; c < inputs.length; c++) model.setUserInput(0, row, c + 1, inputs[c]);
      if ((row - 1) % chunk === 0 || row - 1 === rows) {
        fillMs += performance.now() - fillStarted;
        const resetStarted = performance.now();
        model = resetHistory(ic, model);
        engine.model = model;
        historyResetMs += performance.now() - resetStarted;
        options.onProgress?.(row - 1, rows, engine);
        await new Promise(resolve => setTimeout(resolve, 0));
        fillStarted = performance.now();
      }
      row++;
    }
    model.newSheet();
    model.renameSheet(1, 'Resumo');
    const formulas = summaryFormulas(rows);
    formulas.forEach(([label, formula], i) => {
      model.setUserInput(1, i + 1, 1, label);
      model.setUserInput(1, i + 1, 2, toEngineInput(formula));
    });
    model.resumeEvaluation();
    const evaluateStarted = performance.now();
    model.evaluate();
    const evaluateMs = performance.now() - evaluateStarted;
    // Start the editing session without the generation steps in the undo history.
    const bytes = model.toBytes();
    model.free();
    engine.model = ic.Model.fromBytes(bytes, ENGINE_LANGUAGE);
    engine.model.evaluate();
    engine.pivotSource.reset(0);
    engine.revision++;
    return {
      engine,
      report: {
        rows, columns: SYNTHETIC_HEADERS.length, formulas: formulas.length, seed,
        fillMs, historyResetMs, evaluateMs, totalMs: performance.now() - started,
        wasmMemoryBytes: options.memoryBytes?.() ?? null,
      },
    };
  }

  wasmMemoryBytes(): number | null { return this.memoryBytes(); }

  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }
}

/**
 * Rebuilds a model from its own bytes to drop the undo history IronCalc keeps for each user
 * input (measured: hundreds of bytes per cell). Evaluation stays paused if it was.
 */
function resetHistory(ic: IronCalc, model: Model): Model {
  model.flushSendQueue();
  const bytes = model.toBytes();
  model.free();
  const fresh = ic.Model.fromBytes(bytes, ENGINE_LANGUAGE);
  fresh.pauseEvaluation();
  return fresh;
}

/** A valid sheet name from a workbook name: at most 31 characters, none of : \\ / ? * [ ]. */
export function sheetName(workbookName: string): string {
  const name = workbookName.replace(/[:\\/?*[\]]/g, '_').trim().slice(0, 31);
  return name || 'Planilha1';
}

function checkCount(count: number, max: number) {
  if (!Number.isInteger(count) || count < 1 || count > max) throw new RangeError('Quantidade inválida.');
}

function isHiddenIn(ranges: HiddenRanges, row: number): boolean {
  for (let i = 0; i < ranges.length; i += 2) if (row >= ranges[i] && row <= ranges[i + 1]) return true;
  return false;
}

function sameRanges(a: HiddenRanges, b: HiddenRanges): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Filter range after inserting rows: below it moves; inside the data it grows. */
function shiftFilterRows(filter: FilterState, at: number, count: number): FilterState {
  const { range } = filter;
  if (at <= range.top) return { ...filter, range: { ...range, top: range.top + count, bottom: range.bottom + count } };
  if (at <= range.bottom) return { ...filter, range: { ...range, bottom: range.bottom + count } };
  return filter;
}

/** Filter range after deleting rows; deleting the header row removes the filter. */
function deleteFilterRows(filter: FilterState, at: number, count: number): FilterState | null {
  const { range } = filter;
  const end = at + count - 1;
  if (at <= range.top && end >= range.top) return null;
  const removedAbove = Math.max(0, Math.min(end, range.top - 1) - at + 1);
  const removedInside = Math.max(0, Math.min(end, range.bottom) - Math.max(at, range.top + 1) + 1);
  const bottom = range.bottom - removedAbove - removedInside;
  const top = range.top - removedAbove;
  return bottom > top ? { ...filter, range: { ...range, top, bottom } } : null;
}

function shiftFilterColumns(filter: FilterState, at: number, count: number): FilterState {
  const { range } = filter;
  const move = (c: number) => (c >= at ? c + count : c);
  return {
    range: at <= range.left ? { ...range, left: range.left + count, right: range.right + count } : at <= range.right ? { ...range, right: range.right + count } : range,
    criteria: filter.criteria.map(c => ({ ...c, column: move(c.column) })),
  };
}

function deleteFilterColumns(filter: FilterState, at: number, count: number): FilterState | null {
  const { range } = filter;
  const end = at + count - 1;
  const gone = (c: number) => c >= at && c <= end;
  const move = (c: number) => (c > end ? c - count : c);
  const left = range.left < at ? range.left : Math.max(at, range.left - count);
  const removed = Math.max(0, Math.min(end, range.right) - Math.max(at, range.left) + 1);
  const width = range.right - range.left + 1 - removed;
  if (width <= 0) return null;
  return {
    range: { ...range, left: range.left > end ? range.left - count : left, right: (range.left > end ? range.left - count : left) + width - 1 },
    criteria: filter.criteria.filter(c => !gone(c.column)).map(c => ({ ...c, column: move(c.column) })),
  };
}

