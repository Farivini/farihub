/** Excel limits, also used by IronCalc. */
export const MAX_ROW = 1_048_576;
export const MAX_COLUMN = 16_384;

export interface CellRef { row: number; column: number }
/** Inclusive, 1-based rectangle. */
export interface Rect { top: number; left: number; bottom: number; right: number }

export function columnName(column: number): string {
  if (!Number.isInteger(column) || column < 1 || column > MAX_COLUMN) throw new RangeError(`Invalid column ${column}`);
  let name = '';
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

export function columnNumber(name: string): number {
  if (!/^[A-Za-z]{1,3}$/.test(name)) throw new RangeError(`Invalid column name ${name}`);
  let column = 0;
  for (const ch of name.toUpperCase()) column = column * 26 + ch.charCodeAt(0) - 64;
  if (column > MAX_COLUMN) throw new RangeError(`Invalid column name ${name}`);
  return column;
}

export function cellName(ref: CellRef): string {
  return `${columnName(ref.column)}${ref.row}`;
}

export function rectName(rect: Rect): string {
  const start = cellName({ row: rect.top, column: rect.left });
  if (rect.top === rect.bottom && rect.left === rect.right) return start;
  return `${start}:${cellName({ row: rect.bottom, column: rect.right })}`;
}

/** Parses A1 or A1:B2 (optionally with $). Returns null for anything else. */
export function parseRect(text: string): Rect | null {
  const match = /^\s*\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?\s*$/.exec(text);
  if (!match) return null;
  try {
    const a = { column: columnNumber(match[1]), row: Number(match[2]) };
    const b = match[3] ? { column: columnNumber(match[3]), row: Number(match[4]) } : a;
    if ([a.row, b.row].some(row => row < 1 || row > MAX_ROW)) return null;
    return normalizeRect(a, b);
  } catch {
    return null;
  }
}

export function normalizeRect(a: CellRef, b: CellRef): Rect {
  return {
    top: Math.min(a.row, b.row), bottom: Math.max(a.row, b.row),
    left: Math.min(a.column, b.column), right: Math.max(a.column, b.column),
  };
}

export function rectSize(rect: Rect): number {
  return (rect.bottom - rect.top + 1) * (rect.right - rect.left + 1);
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom;
}

export function clampRef(ref: CellRef): CellRef {
  return {
    row: Math.min(MAX_ROW, Math.max(1, ref.row)),
    column: Math.min(MAX_COLUMN, Math.max(1, ref.column)),
  };
}
