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

export type IronCalc = typeof import('@ironcalc/wasm');

export const IRONCALC_VERSION = '0.9.1';
/** es: comma decimal and semicolon separators, as pt-BR. Function names come from formula-locale.ts. */
export const ENGINE_LOCALE = 'es';
export const ENGINE_LANGUAGE = 'en';
export const ENGINE_TIMEZONE = 'America/Sao_Paulo';
export const MAX_COPY_CELLS = 500_000;
export const MAX_FORMAT_CELLS = 200_000;
const EXPORT_BLOCK_CELLS = 100_000;

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
  readonly pivotSource: PivotSource;
  private undoStack: Change[] = [];
  private redoStack: Change[] = [];
  private clipboard: { sheet: number; rect: Rect; tsv: string; data: ReturnType<Model['copyToClipboard']> } | null = null;

  private model: Model;
  private memoryBytes: () => number | null;

  constructor(model: Model, memoryBytes: () => number | null = () => null) {
    this.model = model;
    this.memoryBytes = memoryBytes;
    this.pivotSource = new PivotSource(() => this.model, 0);
  }

  static create(ic: IronCalc, name = 'Pasta1', memoryBytes?: () => number | null): WorkbookEngine {
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
    this.revision++;
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

  private commit(change: Change, recordUndo = true): Change {
    this.revision++;
    if (recordUndo) {
      this.undoStack.push(change);
      this.redoStack = [];
    }
    this.pivotSource.onChange(change.sheet, change.rect);
    return change;
  }

  setInput(sheet: number, row: number, column: number, text: string): Change {
    this.model.setUserInput(sheet, row, column, toEngineInput(text));
    return this.commit({ sheet, rect: { top: row, left: column, bottom: row, right: column } });
  }

  clear(sheet: number, rect: Rect): Change {
    this.model.rangeClearContents(sheet, rect.top, rect.left, rect.bottom, rect.right);
    return this.commit({ sheet, rect });
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
    const rows: string[][] = [];
    for (let r = 0; r < view.rows; r++) rows.push(view.values.slice(r * view.columns, (r + 1) * view.columns));
    const tsv = serializeTsv(rows);
    this.model.setSelectedSheet(sheet);
    this.model.setSelectedCell(rect.top, rect.left);
    this.model.setSelectedRange(rect.top, rect.left, rect.bottom, rect.right);
    this.clipboard = { sheet, rect, tsv, data: this.model.copyToClipboard() };
    return tsv;
  }

  undo(): Change | null {
    const change = this.undoStack.pop();
    if (!change || !this.model.canUndo()) return null;
    this.model.undo();
    this.redoStack.push(change);
    return this.commit(change, false);
  }

  redo(): Change | null {
    const change = this.redoStack.pop();
    if (!change || !this.model.canRedo()) return null;
    this.model.redo();
    this.undoStack.push(change);
    return this.commit(change, false);
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

  async pivot(config: PivotConfig, onProgress?: (done: number, total: number, field: string) => void): Promise<PivotResult & { extractMs: number; aggregateMs: number }> {
    const started = performance.now();
    const columns = await this.pivotSource.ensure(configFields(config), onProgress);
    const extracted = performance.now();
    const result = computePivot(columns, this.pivotSource.rowCount, config);
    return { ...result, extractMs: extracted - started, aggregateMs: performance.now() - extracted };
  }

  /** Saves to the Farcel container. */
  toFile(app: Record<string, unknown>): Uint8Array {
    return encodeFarcel(this.model.toBytes(), IRONCALC_VERSION, app);
  }

  static fromFile(ic: IronCalc, file: Uint8Array, memoryBytes?: () => number | null): { engine: WorkbookEngine; header: FarcelHeader; evaluateMs: number } {
    const { header, payload } = decodeFarcel(file);
    return { ...WorkbookEngine.fromModelBytes(ic, payload, memoryBytes), header };
  }

  /** A model from `Model.toBytes()` data (a .farcel payload or a converted .xlsx), recalculated. */
  static fromModelBytes(ic: IronCalc, bytes: Uint8Array, memoryBytes?: () => number | null): { engine: WorkbookEngine; evaluateMs: number } {
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
