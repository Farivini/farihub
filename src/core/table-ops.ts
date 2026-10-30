import type { CellRef, Rect } from './address.ts';

/**
 * Table operations on a sheet, as data. The UI sends them to the engine worker; the assistant
 * will send the same values. Every operation is one undo step.
 */
export type TableOperation =
  | { kind: 'insertRows'; sheet: number; at: number; count: number }
  | { kind: 'deleteRows'; sheet: number; at: number; count: number }
  | { kind: 'insertColumns'; sheet: number; at: number; count: number }
  | { kind: 'deleteColumns'; sheet: number; at: number; count: number }
  /** Sorts the rows of `range` (the header row, when `header`, stays). Records move whole. */
  | { kind: 'sort'; sheet: number; range: Rect; header: boolean; keys: SortKey[] }
  /** Sets the sheet's filter: `range` starts with the header row; rows failing a criterion are hidden. */
  | { kind: 'setFilter'; sheet: number; range: Rect; criteria: FilterCriterion[] }
  /** Removes the filter and shows the rows it hid. */
  | { kind: 'clearFilter'; sheet: number }
  /** Shows hidden rows (for rows hidden by a file, outside any filter). */
  | { kind: 'showRows'; sheet: number; top: number; bottom: number };

export interface SortKey { column: number; descending?: boolean }

/**
 * Rows pass when their displayed value in `column` is (include) or is not (exclude) one of
 * `values`. The empty string stands for empty cells. Text matches as displayed, like Excel.
 */
export interface FilterCriterion { column: number; mode: 'include' | 'exclude'; values: string[] }

export interface FilterState { range: Rect; criteria: FilterCriterion[] }

export type TableQuery =
  /** The contiguous block of filled cells around `cell` (Excel's current region). */
  | { kind: 'region'; sheet: number; cell: CellRef }
  /** Distinct displayed values of a filter column with counts; `search` narrows the list. */
  | { kind: 'filterValues'; sheet: number; column: number; search?: string; limit?: number };

export interface FilterValue { text: string; count: number; selected: boolean }
export interface FilterValues { values: FilterValue[]; distinct: number; truncated: boolean }

/**
 * What the values not explicitly checked or unchecked in a filter list are: as the current
 * criterion says, all checked ('Selecionar tudo') or all unchecked.
 */
export type ListBase = 'current' | 'all' | 'none';

export const listChecked = (value: FilterValue, base: ListBase, changes: ReadonlyMap<string, boolean>) =>
  changes.get(value.text) ?? (base === 'all' ? true : base === 'none' ? false : value.selected);

/**
 * The criterion a filter list stands for after the person's changes. The list may hold only
 * part of the values (`truncated`); values it does not show keep what they were, so a
 * criterion on a value beyond the list survives opening the list and applying it again.
 * With a search, the rows shown are the checked results (as Excel). null: no criterion.
 */
export function editedCriterion(
  current: FilterCriterion | undefined, list: { values: FilterValue[]; truncated: boolean },
  base: ListBase, changes: ReadonlyMap<string, boolean>, searching: boolean,
): Omit<FilterCriterion, 'column'> | null {
  const checked = (v: FilterValue) => listChecked(v, base, changes);
  if (searching) return { mode: 'include', values: list.values.filter(checked).map(v => v.text) };
  if (!list.truncated) {
    const on = list.values.filter(checked).map(v => v.text);
    const off = list.values.filter(v => !checked(v)).map(v => v.text);
    if (!off.length) return null;
    return on.length <= off.length ? { mode: 'include', values: on } : { mode: 'exclude', values: off };
  }
  const plus = [...changes].filter(([, on]) => on).map(([text]) => text);
  const minus = [...changes].filter(([, on]) => !on).map(([text]) => text);
  if (base === 'none') return { mode: 'include', values: plus };
  if (base === 'all' || !current) return minus.length ? { mode: 'exclude', values: minus } : null;
  const values = new Set(current.values);
  if (current.mode === 'include') {
    plus.forEach(t => values.add(t));
    minus.forEach(t => values.delete(t));
    return { mode: 'include', values: [...values] };
  }
  minus.forEach(t => values.add(t));
  plus.forEach(t => values.delete(t));
  return values.size ? { mode: 'exclude', values: [...values] } : null;
}

/**
 * Cost of an operation IronCalc performs cell by cell (inserting and deleting rows or columns
 * move every cell after the insertion point). Measured under Node (scripts/bench-table.ts):
 * inserting one row above 100k and 1M rows of 5 columns moved 2.9 to 3.6 µs per cell;
 * deleting also copies and reloads the model (see WorkbookEngine.apply), about twice that.
 */
export interface OperationCost { cells: number; seconds: number }
export const INSERT_SECONDS_PER_CELL = 4e-6;
export const DELETE_SECONDS_PER_CELL = 8e-6;
/** Above this, the UI asks before running the operation. */
export const SLOW_OPERATION_SECONDS = 3;

export const isStructural = (op: TableOperation) =>
  op.kind === 'insertRows' || op.kind === 'deleteRows' || op.kind === 'insertColumns' || op.kind === 'deleteColumns';

export const passes = (criterion: FilterCriterion, text: string) =>
  criterion.values.includes(text) === (criterion.mode === 'include');

/** Values of one sort key column, as the engine bridge returns them. */
export interface KeyColumn {
  /** 0 empty, 1 number, 2 text, 3 boolean, 4 error */
  kinds: Uint8Array;
  numbers: Float64Array;
  texts: string[];
  descending: boolean;
}

const collator = new Intl.Collator('pt-BR', { sensitivity: 'accent', numeric: false });

/**
 * Stable order of rows by the keys, Excel's rules: ascending is numbers (and dates), then text
 * (case ignored, accents after the plain letter), then TRUE/FALSE, then errors; descending
 * reverses that; empty cells are last either way. Equal rows keep their order.
 */
export function sortOrder(keys: KeyColumn[]): Uint32Array {
  const n = keys[0]?.kinds.length ?? 0;
  // Text compared once per distinct value, then by rank.
  const ranks = keys.map(key => {
    const distinct = [...new Set(key.texts.filter((_, i) => key.kinds[i] === 2))].sort(collator.compare);
    // Spellings the collator finds equal ("ana", "Ana") share a rank, so the next key decides.
    const rank = new Map<string, number>();
    distinct.forEach((t, i) => rank.set(t, i > 0 && collator.compare(distinct[i - 1], t) === 0 ? rank.get(distinct[i - 1])! : i));
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = key.kinds[i] === 2 ? rank.get(key.texts[i])! : key.numbers[i];
    return out;
  });
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const sorted = Array.from(order).sort((a, b) => {
    for (let k = 0; k < keys.length; k++) {
      const { kinds, descending } = keys[k];
      const ka = kinds[a], kb = kinds[b];
      if (ka === 0 || kb === 0) {
        if (ka !== kb) return ka === 0 ? 1 : -1;
        continue;
      }
      let d = ka !== kb ? ka - kb : ka === 4 ? 0 : ranks[k][a] - ranks[k][b];
      if (descending) d = -d;
      if (d !== 0) return d;
    }
    return a - b;
  });
  return Uint32Array.from(sorted);
}

export function isIdentity(order: Uint32Array): boolean {
  for (let i = 0; i < order.length; i++) if (order[i] !== i) return false;
  return true;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
const isRect = (v: unknown): v is Rect => isObject(v) && ['top', 'left', 'bottom', 'right'].every(k => Number.isInteger(v[k]));
const isCriterion = (v: unknown): v is FilterCriterion =>
  isObject(v) && Number.isInteger(v.column) && (v.mode === 'include' || v.mode === 'exclude') &&
  Array.isArray(v.values) && v.values.every(t => typeof t === 'string');

/** Filters saved in a .farcel header (one list per sheet); malformed entries are dropped. */
export function parseFilters(value: unknown): FilterState[][] {
  if (!Array.isArray(value)) return [];
  return value.map(list => Array.isArray(list)
    ? list.filter((f): f is FilterState => isObject(f) && isRect(f.range) && Array.isArray(f.criteria) && f.criteria.every(isCriterion))
    : []);
}
