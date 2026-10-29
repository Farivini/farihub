import type { Model } from '@ironcalc/wasm';
import { EMPTY_LABEL } from '../core/pivot.ts';
import type { ColumnSnapshot } from '../core/pivot.ts';
import { localizeValue } from '../core/formula-locale.ts';
import type { Rect } from '../core/address.ts';

/**
 * Columnar snapshot of the pivot source, derived from the engine model.
 *
 * The engine model is the only source of truth. This cache is a read-only projection of
 * the data region that starts at A1 of one sheet (headers in row 1, data from row 2).
 * - Columns are extracted lazily, only for fields used by a pivot.
 * - Every engine mutation reports the changed rectangle through `onChange`:
 *   literal edits inside a column without formulas are patched cell by cell;
 *   a column that contains formulas is re-extracted after any change, because a formula
 *   may depend on any cell; header edits reset the field list.
 * - Undo/redo report the rectangle of the operation they revert or repeat.
 */

export interface PivotField { name: string; column: number }

interface CachedColumn {
  snapshot: ColumnSnapshot;
  labelIndex: Map<string, number>;
  hasFormula: boolean;
}

export interface ExtractionStats { column: string; rows: number; ms: number }

const NUMBER_INPUT = /^-?\d+(,\d+)?(E[+-]?\d+)?$/i;
/** Parses the engine's es-locale number text (comma decimal, no grouping). */
export function parseEngineNumber(text: string): number {
  return NUMBER_INPUT.test(text) ? Number(text.replace(',', '.')) : NaN;
}

/** Reads one cell as a pivot label and its numeric value. */
export function readCell(model: Model, sheet: number, row: number, column: number): { label: string; value: number; formula: boolean } {
  const content = model.getCellContent(sheet, row, column);
  if (content === '') return { label: EMPTY_LABEL, value: NaN, formula: false };
  if (content.startsWith('=')) {
    const formatted = model.getFormattedCellValue(sheet, row, column);
    const type = model.getCellType(sheet, row, column);
    if (type === 4) return { label: localizeValue(formatted, 'boolean'), value: NaN, formula: true };
    if (type === 16) return { label: localizeValue(formatted, 'error'), value: NaN, formula: true };
    if (formatted === '') return { label: EMPTY_LABEL, value: NaN, formula: true };
    return { label: formatted, value: type === 1 ? parseEngineNumber(formatted) : NaN, formula: true };
  }
  if (content.startsWith("'")) return { label: content.slice(1), value: NaN, formula: false };
  return { label: content, value: parseEngineNumber(content), formula: false };
}

export class PivotSource {
  private fieldList: PivotField[] | null = null;
  private lastRow = 1;
  private columns = new Map<number, CachedColumn>();
  /** Bumped on every change; extraction restarts if it moves underneath it. */
  private generation = 0;
  readonly stats: ExtractionStats[] = [];

  private getModel: () => Model;
  sheet: number;

  constructor(getModel: () => Model, sheet = 0) {
    this.getModel = getModel;
    this.sheet = sheet;
  }

  reset(sheet = this.sheet): void {
    this.sheet = sheet;
    this.fieldList = null;
    this.columns.clear();
    this.generation++;
  }

  get rowCount(): number {
    this.fields();
    return Math.max(0, this.lastRow - 1);
  }

  fields(): PivotField[] {
    if (this.fieldList) return this.fieldList;
    const model = this.getModel();
    const fields: PivotField[] = [];
    const seen = new Map<string, number>();
    for (let column = 1; ; column++) {
      const raw = model.getFormattedCellValue(this.sheet, 1, column).trim();
      if (raw === '') break;
      const count = (seen.get(raw) ?? 0) + 1;
      seen.set(raw, count);
      fields.push({ name: count > 1 ? `${raw} (${count})` : raw, column });
    }
    this.fieldList = fields;
    this.lastRow = this.findLastRow(model);
    return fields;
  }

  /** Extracts the requested fields. Yields between chunks so viewport requests stay served. */
  async ensure(names: string[], onProgress?: (done: number, total: number, field: string) => void, yieldEvery = 50_000): Promise<Map<string, ColumnSnapshot>> {
    for (;;) {
      const generation = this.generation;
      const fields = this.fields();
      const wanted = names.map(name => {
        const field = fields.find(f => f.name === name);
        if (!field) throw new Error(`Campo inexistente: ${name}`);
        return field;
      });
      const missing = wanted.filter(f => !this.columns.has(f.column));
      let restarted = false;
      for (const field of missing) {
        const cached = await this.extract(field, generation, onProgress, yieldEvery);
        if (!cached) { restarted = true; break; }
        this.columns.set(field.column, cached);
      }
      if (restarted || generation !== this.generation) continue;
      return new Map(wanted.map(f => [f.name, this.columns.get(f.column)!.snapshot]));
    }
  }

  private async extract(field: PivotField, generation: number, onProgress: ((done: number, total: number, field: string) => void) | undefined, yieldEvery: number): Promise<CachedColumn | null> {
    const started = performance.now();
    const model = this.getModel();
    const rows = this.lastRow - 1;
    const codes = new Uint32Array(rows);
    const labels = [EMPTY_LABEL];
    const labelValues = [NaN];
    const labelIndex = new Map<string, number>([[EMPTY_LABEL, 0]]);
    let hasFormula = false;
    for (let i = 0; i < rows; i++) {
      if (i > 0 && i % yieldEvery === 0) {
        onProgress?.(i, rows, field.name);
        await new Promise(resolve => setTimeout(resolve, 0));
        if (generation !== this.generation) return null;
      }
      const cell = readCell(model, this.sheet, i + 2, field.column);
      if (cell.formula) hasFormula = true;
      let code = labelIndex.get(cell.label);
      if (code === undefined) {
        code = labels.length;
        labels.push(cell.label);
        labelValues.push(cell.value);
        labelIndex.set(cell.label, code);
      }
      codes[i] = code;
    }
    onProgress?.(rows, rows, field.name);
    this.stats.push({ column: field.name, rows, ms: performance.now() - started });
    return { snapshot: { name: field.name, codes, labels, labelValues }, labelIndex, hasFormula };
  }

  /** Must be called after every engine mutation with the rectangle it touched (null = unknown). */
  onChange(sheet: number, rect: Rect | null): void {
    this.generation++;
    if (!this.fieldList) return;
    // Any change may alter formula results anywhere, including on other sheets.
    for (const [column, cached] of this.columns) if (cached.hasFormula) this.columns.delete(column);
    if (sheet !== this.sheet) return;
    if (!rect) { this.reset(); return; }
    const lastFieldColumn = this.fieldList.length;
    if (rect.top === 1 && rect.left <= lastFieldColumn + 1) { this.reset(); return; }
    if (rect.left > lastFieldColumn) return;
    const model = this.getModel();
    if (rect.bottom >= this.lastRow) {
      // Rows may have been added or removed at the end: recompute the extent.
      const lastRow = this.findLastRow(model);
      if (lastRow !== this.lastRow) {
        const grow = lastRow > this.lastRow;
        const oldRows = this.lastRow - 1;
        this.lastRow = lastRow;
        if (!grow) { this.columns.clear(); return; }
        for (const cached of this.columns.values()) {
          const codes = new Uint32Array(lastRow - 1);
          codes.set(cached.snapshot.codes.subarray(0, oldRows));
          cached.snapshot.codes = codes;
        }
        // New rows outside the edited rectangle are empty; patch the full new tail.
        this.patch(model, { ...rect, top: Math.min(rect.top, oldRows + 2), bottom: lastRow, left: 1, right: lastFieldColumn });
        return;
      }
    }
    this.patch(model, rect);
  }

  /** Last row with a non-empty value in any field column (cleared cells may still be listed). */
  private findLastRow(model: Model): number {
    const fields = this.fieldList ?? [];
    let lastRow = 1;
    for (const field of fields) {
      const rows = model.getRowsWithData(this.sheet, field.column);
      for (let i = 0; i < rows.length; i++) if (rows[i] > lastRow) lastRow = rows[i];
    }
    while (lastRow > 1 && fields.every(f => model.getCellContent(this.sheet, lastRow, f.column) === '')) lastRow--;
    return lastRow;
  }

  private patch(model: Model, rect: Rect): void {
    const top = Math.max(2, rect.top);
    const bottom = Math.min(this.lastRow, rect.bottom);
    for (const [column, cached] of this.columns) {
      if (column < rect.left || column > rect.right) continue;
      if (bottom - top > 200_000) { this.columns.delete(column); continue; }
      const snap = cached.snapshot;
      for (let row = top; row <= bottom; row++) {
        const cell = readCell(model, this.sheet, row, column);
        if (cell.formula) { cached.hasFormula = true; }
        let code = cached.labelIndex.get(cell.label);
        if (code === undefined) {
          code = snap.labels.length;
          snap.labels.push(cell.label);
          snap.labelValues.push(cell.value);
          cached.labelIndex.set(cell.label, code);
        }
        snap.codes[row - 2] = code;
      }
      if (cached.hasFormula) this.columns.delete(column);
    }
  }

  /** Distinct labels of a field (for the filter list), in first-seen order. */
  async labels(name: string): Promise<string[]> {
    const map = await this.ensure([name]);
    const snapshot = map.get(name)!;
    const used = new Uint8Array(snapshot.labels.length);
    for (let i = 0; i < snapshot.codes.length; i++) used[snapshot.codes[i]] = 1;
    return snapshot.labels.filter((_, code) => used[code]);
  }
}
