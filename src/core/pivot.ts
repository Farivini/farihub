/**
 * Pivot table over a columnar snapshot.
 *
 * The snapshot is derived from the workbook engine (the only source of truth); see
 * src/engine/pivot-source.ts for how it is extracted and kept current after edits.
 */

export const EMPTY_LABEL = '(vazio)';

/** One source column, dictionary encoded. Code 0 is always the empty cell. */
export interface ColumnSnapshot {
  name: string;
  /** Label code per data row. */
  codes: Uint32Array;
  /** Distinct labels; labels[0] === EMPTY_LABEL. */
  labels: string[];
  /** Numeric value of each label (NaN when the label is not a number). Used for sums and sorting. */
  labelValues: number[];
}

export type Aggregation = 'sum' | 'count';
export interface ValueField { field: string; aggregation: Aggregation }
export interface FilterField { field: string; excluded: string[] }
export interface PivotConfig {
  rows: string[];
  columns: string[];
  values: ValueField[];
  filters: FilterField[];
}

export interface PivotResult {
  rowFields: string[];
  columnFields: string[];
  values: ValueField[];
  /** Label tuple per row group, sorted. */
  rowGroups: string[][];
  /** Label tuple per column group, sorted. */
  columnGroups: string[][];
  /**
   * Dense cube: index ((r * (columnGroups + 1)) + c) * values + v.
   * r === rowGroups.length is the grand total row, c === columnGroups.length the grand total column.
   */
  cells: Float64Array;
  sourceRows: number;
  includedRows: number;
}

export const MAX_PIVOT_CELLS = 20_000_000;

export function emptyConfig(): PivotConfig {
  return { rows: [], columns: [], values: [], filters: [] };
}

export function aggregationLabel(value: ValueField): string {
  return `${value.aggregation === 'sum' ? 'Soma' : 'Contagem'} de ${value.field}`;
}

export function configFields(config: PivotConfig): string[] {
  return [...new Set([...config.rows, ...config.columns, ...config.values.map(v => v.field), ...config.filters.map(f => f.field)])];
}

/** Excel-like order: numbers ascending, then text (pt-BR collation), empty last. */
function labelComparator(column: ColumnSnapshot) {
  const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
  return (a: number, b: number) => {
    if (a === b) return 0;
    if (a === 0) return 1;
    if (b === 0) return -1;
    const va = column.labelValues[a];
    const vb = column.labelValues[b];
    const na = !Number.isNaN(va);
    const nb = !Number.isNaN(vb);
    if (na && nb) return va - vb;
    if (na !== nb) return na ? -1 : 1;
    return collator.compare(column.labels[a], column.labels[b]) || (column.labels[a] < column.labels[b] ? -1 : 1);
  };
}

interface Grouping { index: Int32Array; tuples: number[][] }

/** Assigns every included row to a group of the given fields. Rows excluded by filters get -1. */
function groupRows(columns: ColumnSnapshot[], rowCount: number, included: Uint8Array): Grouping {
  const index = new Int32Array(rowCount).fill(-1);
  if (columns.length === 0) {
    for (let row = 0; row < rowCount; row++) if (included[row]) index[row] = 0;
    return { index, tuples: [[]] };
  }
  // Mixed radix key when it fits in a safe integer; string key otherwise.
  const radix = columns.map(c => c.labels.length);
  const numericKey = radix.reduce((p, r) => p * r, 1) < Number.MAX_SAFE_INTEGER;
  const keys = new Map<number | string, number>();
  const tuples: number[][] = [];
  for (let row = 0; row < rowCount; row++) {
    if (!included[row]) continue;
    let key: number | string;
    if (numericKey) {
      key = 0;
      for (let f = 0; f < columns.length; f++) key = key * radix[f] + columns[f].codes[row];
    } else {
      key = columns.map(c => c.codes[row]).join('|');
    }
    let group = keys.get(key);
    if (group === undefined) {
      group = tuples.length;
      keys.set(key, group);
      tuples.push(columns.map(c => c.codes[row]));
    }
    index[row] = group;
  }
  // Sort groups and remap indices.
  const comparators = columns.map(labelComparator);
  const order = tuples.map((_, i) => i).sort((a, b) => {
    for (let f = 0; f < columns.length; f++) {
      const diff = comparators[f](tuples[a][f], tuples[b][f]);
      if (diff) return diff;
    }
    return 0;
  });
  const remap = new Int32Array(tuples.length);
  order.forEach((oldIndex, newIndex) => { remap[oldIndex] = newIndex; });
  for (let row = 0; row < rowCount; row++) if (index[row] >= 0) index[row] = remap[index[row]];
  return { index, tuples: order.map(i => tuples[i]) };
}

export function computePivot(source: Map<string, ColumnSnapshot>, rowCount: number, config: PivotConfig): PivotResult {
  const column = (name: string) => {
    const found = source.get(name);
    if (!found) throw new Error(`Campo inexistente: ${name}`);
    if (found.codes.length !== rowCount) throw new RangeError(`Coluna ${name} com tamanho inconsistente`);
    return found;
  };
  const included = new Uint8Array(rowCount).fill(1);
  for (const filter of config.filters) {
    if (filter.excluded.length === 0) continue;
    const col = column(filter.field);
    const excluded = new Set(filter.excluded);
    const excludedCodes = new Uint8Array(col.labels.length);
    col.labels.forEach((label, code) => { if (excluded.has(label)) excludedCodes[code] = 1; });
    for (let row = 0; row < rowCount; row++) if (excludedCodes[col.codes[row]]) included[row] = 0;
  }
  let includedRows = 0;
  for (let row = 0; row < rowCount; row++) includedRows += included[row];

  const rowCols = config.rows.map(column);
  const colCols = config.columns.map(column);
  const rowGrouping = groupRows(rowCols, rowCount, included);
  const colGrouping = groupRows(colCols, rowCount, included);
  // Without grouping fields the only row/column is the grand total (index 0 === total).
  const nR = rowCols.length ? rowGrouping.tuples.length : 0;
  const nC = colCols.length ? colGrouping.tuples.length : 0;
  const nV = config.values.length;
  const width = nC + 1;
  const size = (nR + 1) * width * nV;
  if (size > MAX_PIVOT_CELLS) {
    throw new RangeError(`Resultado com ${(nR + 1) * width} combinações excede o limite desta versão`);
  }
  const cells = new Float64Array(size);
  const totalRow = nR;
  const totalCol = nC;
  config.values.forEach((value, v) => {
    const col = column(value.field);
    const isSum = value.aggregation === 'sum';
    const contribution = new Float64Array(col.labels.length);
    col.labelValues.forEach((n, code) => {
      contribution[code] = isSum ? (Number.isNaN(n) ? 0 : n) : code === 0 ? 0 : 1;
    });
    for (let row = 0; row < rowCount; row++) {
      const r = rowGrouping.index[row];
      if (r < 0) continue;
      const amount = contribution[col.codes[row]];
      if (amount === 0) continue;
      const c = colGrouping.index[row];
      cells[(r * width + c) * nV + v] += amount;
      if (c !== totalCol) cells[(r * width + totalCol) * nV + v] += amount;
      if (r !== totalRow) {
        cells[(totalRow * width + c) * nV + v] += amount;
        if (c !== totalCol) cells[(totalRow * width + totalCol) * nV + v] += amount;
      }
    }
  });
  const label = (cols: ColumnSnapshot[], tuple: number[]) => tuple.map((code, f) => cols[f].labels[code]);
  return {
    rowFields: [...config.rows],
    columnFields: [...config.columns],
    values: config.values.map(v => ({ ...v })),
    rowGroups: rowGrouping.tuples.slice(0, nR).map(t => label(rowCols, t)),
    columnGroups: colGrouping.tuples.slice(0, nC).map(t => label(colCols, t)),
    cells,
    sourceRows: rowCount,
    includedRows,
  };
}

export function pivotCell(result: PivotResult, row: number, column: number, value: number): number {
  const width = result.columnGroups.length + 1;
  return result.cells[(row * width + column) * result.values.length + value];
}

const numberFormat = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
export function formatPivotNumber(value: number): string {
  return numberFormat.format(value);
}

/**
 * Tabular layout for display and copying: header rows, then one line per row group,
 * then the grand total. Numbers are returned unformatted in `numbers` (NaN for labels).
 */
export interface PivotTable { rows: string[][]; numbers: Float64Array; width: number; headerRows: number }

export function layoutPivot(result: PivotResult): PivotTable {
  const nV = result.values.length;
  const slots = Math.max(1, nV);
  const nR = result.rowGroups.length;
  const nC = result.columnGroups.length;
  const colLevels = result.columnFields.length;
  const labelCols = Math.max(1, result.rowFields.length);
  const width = labelCols + (nC + 1) * slots;
  const valueHeader = nV > 1 || colLevels === 0;
  // Column labels take one row per level; the last header row holds the row field names.
  const headerRows = colLevels + 1;
  const height = headerRows + nR + 1;
  const rows: string[][] = Array.from({ length: height }, () => Array(width).fill(''));
  const numbers = new Float64Array(width * height).fill(NaN);
  const sameGroup = (a: string[] | undefined, b: string[] | undefined, depth: number) =>
    !!a && !!b && a.slice(0, depth).join('\u0000') === b.slice(0, depth).join('\u0000');
  for (let level = 0; level < colLevels; level++) {
    for (let c = 0; c < nC; c++) {
      if (sameGroup(result.columnGroups[c - 1], result.columnGroups[c], level + 1)) continue;
      rows[level][labelCols + c * slots] = result.columnGroups[c][level];
    }
    if (level === 0) rows[0][labelCols + nC * slots] = 'Total geral';
  }
  if (colLevels > 0 && nV === 1) rows[0][0] = aggregationLabel(result.values[0]);
  const fieldRow = headerRows - 1;
  if (valueHeader) {
    for (let c = 0; c <= nC; c++) {
      result.values.forEach((value, v) => { rows[fieldRow][labelCols + c * slots + v] = aggregationLabel(value); });
    }
  }
  result.rowFields.forEach((field, f) => { rows[fieldRow][f] = field; });
  if (result.rowFields.length === 0 && colLevels === 0) rows[fieldRow][0] = 'Valores';
  for (let r = 0; r <= nR; r++) {
    const line = headerRows + r;
    if (r === nR) rows[line][0] = 'Total geral';
    else result.rowGroups[r].forEach((label, f) => {
      rows[line][f] = sameGroup(result.rowGroups[r - 1], result.rowGroups[r], f + 1) ? '' : label;
    });
    for (let c = 0; c <= nC; c++) {
      for (let v = 0; v < nV; v++) {
        const value = pivotCell(result, r, c, v);
        const col = labelCols + c * slots + v;
        rows[line][col] = formatPivotNumber(value);
        numbers[line * width + col] = value;
      }
    }
  }
  return { rows, numbers, width, headerRows };
}

export interface ChartSeries { name: string; values: number[] }
export interface ChartData {
  categories: string[];
  series: ChartSeries[];
  valueLabel: string;
  /** Total groups before truncation, so the UI can say what is not drawn. */
  totalCategories: number;
  totalSeries: number;
}

/** Chart data from the aggregated result (never from the source rows). */
export function chartFromPivot(result: PivotResult, valueIndex = 0, maxCategories = 24, maxSeries = 8): ChartData {
  const value = result.values[valueIndex];
  const nR = result.rowGroups.length;
  const nC = result.columnGroups.length;
  if (!value) return { categories: [], series: [], valueLabel: '', totalCategories: 0, totalSeries: 0 };
  // Without row fields the only category is the grand total row.
  const rowIndices = nR ? Array.from({ length: Math.min(nR, maxCategories) }, (_, i) => i) : [nR];
  const categories = nR ? rowIndices.map(i => result.rowGroups[i].join(' · ')) : ['Total geral'];
  const series: ChartSeries[] = nC === 0
    ? [{ name: aggregationLabel(value), values: rowIndices.map(r => pivotCell(result, r, nC, valueIndex)) }]
    : result.columnGroups.slice(0, maxSeries).map((group, c) => ({
      name: group.join(' · '),
      values: rowIndices.map(r => pivotCell(result, r, c, valueIndex)),
    }));
  return { categories, series, valueLabel: aggregationLabel(value), totalCategories: Math.max(1, nR), totalSeries: Math.max(1, nC) };
}
