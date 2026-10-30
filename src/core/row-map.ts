/**
 * Hidden rows of a sheet as sorted, disjoint (start, end) pairs, and the mapping between the
 * rows of the sheet and the rows the grid shows (display index 1..count, hidden rows skipped).
 * Built once per layout; every lookup is a binary search, so a filter that hides half of a
 * million rows still maps in microseconds.
 */
export type HiddenRanges = Int32Array;

export const NO_HIDDEN: HiddenRanges = new Int32Array(0);

export class RowMap {
  readonly count: number;
  readonly hidden: HiddenRanges;
  readonly totalRows: number;
  /** starts[j], ends[j]: interval j; before[j]: hidden rows in intervals 0..j-1. */
  private starts: Int32Array;
  private ends: Int32Array;
  private before: Float64Array;

  constructor(hidden: HiddenRanges, totalRows: number) {
    this.hidden = hidden;
    this.totalRows = totalRows;
    const n = hidden.length >> 1;
    this.starts = new Int32Array(n);
    this.ends = new Int32Array(n);
    this.before = new Float64Array(n + 1);
    for (let j = 0; j < n; j++) {
      this.starts[j] = hidden[2 * j];
      this.ends[j] = hidden[2 * j + 1];
      this.before[j + 1] = this.before[j] + hidden[2 * j + 1] - hidden[2 * j] + 1;
    }
    this.count = totalRows - this.before[n];
  }

  get hasHidden(): boolean { return this.starts.length > 0; }

  /** Interval containing `row`, or -1. */
  private intervalOf(row: number): number {
    let lo = 0, hi = this.starts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.ends[mid] < row) lo = mid + 1;
      else if (this.starts[mid] > row) hi = mid - 1;
      else return mid;
    }
    return -1;
  }

  /** Number of intervals ending before `row`. */
  private intervalsBefore(row: number): number {
    let lo = 0, hi = this.starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ends[mid] < row) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  isHidden(row: number): boolean { return this.intervalOf(row) >= 0; }

  /** Sheet row shown at display index `index` (1-based). */
  rowAt(index: number): number {
    // Intervals whose first row would be shown at or before `index` push the row down.
    let lo = 0, hi = this.starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.starts[mid] - this.before[mid] <= index) lo = mid + 1; else hi = mid;
    }
    return index + this.before[lo];
  }

  /** Display index of `row`; a hidden row maps to the next shown row (or the last one). */
  indexOf(row: number): number {
    const j = this.intervalOf(row);
    if (j >= 0) {
      if (this.ends[j] >= this.totalRows) return this.count;
      return this.ends[j] + 1 - this.before[j + 1];
    }
    return row - this.before[this.intervalsBefore(row)];
  }

  /** Display index of the last shown row at or before `row` (0 if none). */
  indexAtOrBefore(row: number): number {
    const j = this.intervalOf(row);
    if (j >= 0) return this.starts[j] - 1 - this.before[j];
    return row - this.before[this.intervalsBefore(row)];
  }

  /** The shown row `delta` display rows away from `row` (clamped). */
  step(row: number, delta: number): number {
    const index = delta >= 0 ? this.indexOf(row) : this.indexAtOrBefore(row) || 1;
    return this.rowAt(Math.max(1, Math.min(this.count, index + delta)));
  }

  /** True when the row just above `row` is hidden (a gap the grid marks). */
  gapBefore(row: number): boolean { return row > 1 && this.isHidden(row - 1); }
}

/** Ranges of the rows `first + i` for which `hide[i]` is true. */
export function rangesFromFlags(first: number, hide: ArrayLike<boolean | number>): HiddenRanges {
  const pairs: number[] = [];
  for (let i = 0; i < hide.length; i++) {
    if (!hide[i]) continue;
    const row = first + i;
    if (pairs.length && pairs[pairs.length - 1] === row - 1) pairs[pairs.length - 1] = row;
    else pairs.push(row, row);
  }
  return Int32Array.from(pairs);
}

/** Hidden ranges restricted to `from..to`. */
export function rangesWithin(ranges: HiddenRanges, from: number, to: number): HiddenRanges {
  const out: number[] = [];
  for (let i = 0; i < ranges.length; i += 2) {
    const s = Math.max(ranges[i], from), e = Math.min(ranges[i + 1], to);
    if (s <= e) out.push(s, e);
  }
  return Int32Array.from(out);
}

/** Replaces the hidden state of rows `from..to` with `inside` (ranges within that span). */
export function replaceRanges(ranges: HiddenRanges, from: number, to: number, inside: HiddenRanges): HiddenRanges {
  const rows: Array<[number, number]> = [];
  for (let i = 0; i < ranges.length; i += 2) {
    const s = ranges[i], e = ranges[i + 1];
    if (s < from) rows.push([s, Math.min(e, from - 1)]);
    if (e > to) rows.push([Math.max(s, to + 1), e]);
  }
  for (let i = 0; i < inside.length; i += 2) rows.push([inside[i], inside[i + 1]]);
  rows.sort((a, b) => a[0] - b[0]);
  const out: number[] = [];
  for (const [s, e] of rows) {
    if (out.length && out[out.length - 1] >= s - 1) out[out.length - 1] = Math.max(out[out.length - 1], e);
    else out.push(s, e);
  }
  return Int32Array.from(out);
}

/** After inserting `count` rows at `at`: rows at or below move down (as IronCalc moves row data). */
export function insertRowsInRanges(ranges: HiddenRanges, at: number, count: number): HiddenRanges {
  const out: number[] = [];
  for (let i = 0; i < ranges.length; i += 2) {
    const s = ranges[i], e = ranges[i + 1];
    if (e < at) out.push(s, e);
    else if (s >= at) out.push(s + count, e + count);
    else out.push(s, at - 1, at + count, e + count);
  }
  return Int32Array.from(out);
}

/** After deleting rows `at..at+count-1`: those go, rows below move up. */
export function deleteRowsInRanges(ranges: HiddenRanges, at: number, count: number): HiddenRanges {
  const end = at + count - 1;
  const parts: Array<[number, number]> = [];
  for (let i = 0; i < ranges.length; i += 2) {
    const s = ranges[i], e = ranges[i + 1];
    if (s < at) parts.push([s, Math.min(e, at - 1)]);
    if (e > end) parts.push([Math.max(s, end + 1) - count, e - count]);
  }
  const out: number[] = [];
  for (const [s, e] of parts) {
    if (out.length && out[out.length - 1] >= s - 1) out[out.length - 1] = Math.max(out[out.length - 1], e);
    else out.push(s, e);
  }
  return Int32Array.from(out);
}

export function hiddenCount(ranges: HiddenRanges): number {
  let n = 0;
  for (let i = 0; i < ranges.length; i += 2) n += ranges[i + 1] - ranges[i] + 1;
  return n;
}
