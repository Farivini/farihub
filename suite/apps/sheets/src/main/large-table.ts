import * as numfmt from 'numfmt'
import {
  parseNumberWithMark,
  type CsvImportReport,
} from '@genoffice/xlsx-gateway/gateway/csv-number-format'

import type { DataEngineClient, DataEngineGridEdits, DataEngineSpan } from './data-engine-client'

/// Where Save writes the base, and the file's size/mtime as last read or
/// written: a Save over a file changed elsewhere since then is refused.
export interface LargeTableTarget {
  readonly path: string
  readonly format: 'csv' | 'xlsx'
  readonly size: number
  readonly mtimeMs: number
}

/// A calculated column of the base: its results live in the engine's copy,
/// written in the file's convention with `mark` as the decimal mark.
export interface LargeTableCalc {
  readonly column: number
  readonly mark: ',' | '.'
  readonly active: boolean
}

/// A delimited file past the regular import limit, held by the data engine.
export interface LargeTableSession {
  readonly engineSessionId: string
  /** rows of the base (the first line counts, as in the regular import) */
  readonly rows: number
  readonly columns: number
  /** non-empty values, each one grid cell */
  readonly cells: number
  readonly sourcePath: string
  readonly importMs: number
  /** the regular import's column decisions, over every row of the file */
  readonly csvFormat: CsvImportReport
  /** the shell workbook's sheet id, set once the session opens */
  readonly sheetId?: string
  /// Shared by every session that holds this engine copy (a save swaps the
  /// renderer's session but keeps the base), so it is a mutable holder.
  readonly target: { current: LargeTableTarget }
  /// Calculated columns by engine id, shared the same way.
  readonly calcs: { current: ReadonlyMap<string, LargeTableCalc> }
  /// Columns the grid shows: the file's, plus columns that edits or
  /// calculated columns added (a session opened after Save takes this).
  readonly width: { current: number }
}

/// The calculated column on `column` that is on, if any.
export function activeLargeTableCalc(
  table: LargeTableSession,
  column: number,
): LargeTableCalc | undefined {
  for (const calc of table.calcs.current.values()) {
    if (calc.active && calc.column === column) return calc
  }
  return undefined
}

/// Number columns and their marks, as the grid reads them: the file's number
/// columns, then the calculated columns that are on.
export function largeTableNumberColumns(
  table: LargeTableSession,
): { column: number; decimal: ',' | '.' }[] {
  const out = new Map<number, ',' | '.'>()
  for (const column of table.csvFormat.columns) {
    if (column.kind === 'number') {
      out.set(column.column, largeTableColumnMark(table.csvFormat, column.column))
    }
  }
  for (const calc of table.calcs.current.values()) {
    if (calc.active) out.set(calc.column, calc.mark)
  }
  return [...out].map(([column, decimal]) => ({ column, decimal }))
}

/// The file's own number columns (what the engine reads base values with;
/// it knows its calculated columns itself).
export function largeTableFileNumberColumns(
  table: LargeTableSession,
): { column: number; decimal: ',' | '.' }[] {
  return table.csvFormat.columns
    .filter((column) => column.kind === 'number')
    .map((column) => ({
      column: column.column,
      decimal: largeTableColumnMark(table.csvFormat, column.column),
    }))
}

/// A number in plain decimal digits, never in exponent form (csv-export.ts
/// plainDecimal; the importer reads `0,00000012` back, not `1,2e-7`).
export function plainDecimal(value: number): string {
  const text = String(value)
  const match = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(text)
  if (!match) return text
  const [, sign, lead, rest = '', exponentText] = match
  const digits = lead! + rest
  const exponent = Number(exponentText)
  if (exponent < 0) return `${sign}0.${'0'.repeat(-exponent - 1)}${digits}`
  const point = exponent + 1
  return point >= digits.length
    ? `${sign}${digits}${'0'.repeat(point - digits.length)}`
    : `${sign}${digits.slice(0, point)}.${digits.slice(point)}`
}

/// The decimal mark a column is read and written with. A number column keeps
/// its own mark; an integer-only number column (no mark of its own) takes the
/// file's, so an edited 1.5 is written and read back the same way — its
/// existing whole numbers read identically under either mark. Text columns
/// write numbers in the file's convention, like the CSV writer.
export function largeTableColumnMark(format: CsvImportReport, column: number): ',' | '.' {
  const decision = format.columns[column]
  if (decision?.kind === 'number' && decision.decimal !== undefined) return decision.decimal
  return format.decimal ?? '.'
}

/// The text an edited value takes in the base, in the file's own convention:
/// a number with its column's decimal mark (the mark reads and the XLSX export
/// use for that column), a boolean as Excel writes it, text as typed; null
/// empties the cell.
export function largeTableEditText(
  value: string | number | boolean | null,
  format: CsvImportReport,
  numberFormat?: string | undefined,
  column = -1,
): string | null {
  const mark = column >= 0 ? largeTableColumnMark(format, column) : (format.decimal ?? '.')
  if (value === null || value === '') return null
  if (typeof value === 'number') {
    // a typed date or a formatted number keeps the text the grid shows —
    // the CSV writer's "values as displayed" — not the serial behind it
    if (numberFormat !== undefined && !/^general$/i.test(numberFormat.trim())) {
      const shown = numfmt.format(numberFormat, value, {
        throws: false,
        locale: mark === ',' ? 'pt-BR' : 'en-US',
      })
      if (typeof shown === 'string' && shown !== '' && !/^#+$/.test(shown)) return shown
    }
    const text = plainDecimal(value)
    return mark === ',' ? text.replace('.', ',') : text
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  return value
}

/// The value edits of a save request with the values the grid holds (what a
/// formula reads), and the cells they cover.
export function largeTableGridEdits(
  table: LargeTableSession,
  request: SaveEditsLike,
): { edits: DataEngineGridEdits; changed: DataEngineSpan[] } {
  const onSheet = (sheetId: string) => table.sheetId === undefined || sheetId === table.sheetId
  const fills = (request.bulkConstantFills ?? [])
    .filter((fill) => onSheet(fill.sheetId))
    .map(({ startRow, endRow, startColumn, endColumn, value }) => ({
      startRow,
      endRow,
      startColumn,
      endColumn,
      value,
    }))
  const cells = request.edits
    .filter((edit) => edit.writeValue && onSheet(edit.sheetId))
    .map(({ row, column, value }) => ({ row, column, value }))
  const changed: DataEngineSpan[] = [
    ...fills.map(({ startRow, endRow, startColumn, endColumn }) => ({
      startRow,
      endRow,
      startColumn,
      endColumn,
    })),
    ...cells.map(({ row, column }) => ({
      startRow: row,
      endRow: row,
      startColumn: column,
      endColumn: column,
    })),
  ]
  return { edits: { cells, fills }, changed }
}

interface SaveEditsLike {
  readonly edits: readonly {
    readonly sheetId: string
    readonly row: number
    readonly column: number
    readonly writeValue: boolean
    readonly value: string | number | boolean | null
    readonly style?: { readonly numberFormat?: string | undefined } | undefined
  }[]
  readonly bulkConstantFills?:
    | readonly {
        readonly sheetId: string
        readonly startRow: number
        readonly endRow: number
        readonly startColumn: number
        readonly endColumn: number
        readonly value: string | number | boolean | null
      }[]
    | undefined
}

/// The value edits of a save request, as engine edits for the base's sheet.
/// Style-only edits carry nothing a CSV can keep; a formula cell is written
/// with the value the grid computed for it (CSV holds values, as in Excel).
export function largeTableEngineEdits(
  table: LargeTableSession,
  request: SaveEditsLike,
): {
  fills: {
    startRow: number
    endRow: number
    startColumn: number
    endColumn: number
    text: string | null
  }[]
  cells: { row: number; column: number; text: string | null }[]
} {
  const onSheet = (sheetId: string) => table.sheetId === undefined || sheetId === table.sheetId
  return {
    // a fill spans columns that may read numbers with different marks:
    // one engine fill per column, each written in its column's convention
    fills: (request.bulkConstantFills ?? [])
      .filter((fill) => onSheet(fill.sheetId))
      .flatMap((fill) =>
        Array.from({ length: fill.endColumn - fill.startColumn + 1 }, (_, offset) => {
          const column = fill.startColumn + offset
          return {
            startRow: fill.startRow,
            endRow: fill.endRow,
            startColumn: column,
            endColumn: column,
            text: largeTableEditText(fill.value, table.csvFormat, undefined, column),
          }
        }),
      ),
    cells: request.edits
      .filter((edit) => edit.writeValue && onSheet(edit.sheetId))
      .map((edit) => ({
        row: edit.row,
        column: edit.column,
        text: largeTableEditText(
          edit.value,
          table.csvFormat,
          edit.style?.numberFormat,
          edit.column,
        ),
      })),
  }
}

type CellValue = string | number | boolean

/// The value a raw field becomes in the grid — csvToXlsxBufferForOpen's rule:
/// a number column reads the field with its decimal mark, anything that does
/// not read (and every other column) keeps the text exactly as written.
export function largeTableCellValue(
  format: CsvImportReport,
  column: number,
  raw: string,
): CellValue {
  const decision = format.columns[column]
  if (decision?.kind !== 'number') return raw
  return parseNumberWithMark(raw, largeTableColumnMark(format, column)) ?? raw
}

/// A calculated column's stored text as the grid shows it: a number, a
/// logical, or the text itself (an error value stays its text).
export function largeTableCalcValue(raw: string, mark: ',' | '.'): CellValue {
  if (raw === 'TRUE') return true
  if (raw === 'FALSE') return false
  return parseNumberWithMark(raw, mark) ?? raw
}

interface RangeRequest {
  readonly sessionId: string
  readonly sheetId: string
  readonly range: {
    readonly startRow: number
    readonly endRow: number
    readonly startColumn: number
    readonly endColumn: number
  }
}

/// A read of the grid window: the shell workbook's (empty) answer carries
/// every sheet-level field; the cells come from the engine.
export async function largeTableRangeResult(
  engine: DataEngineClient,
  table: LargeTableSession,
  request: RangeRequest,
  shellResult: unknown,
): Promise<unknown> {
  const { range } = request
  const rows = await engine.readRange({
    sessionId: table.engineSessionId,
    startRow: range.startRow,
    endRow: range.endRow,
    startColumn: range.startColumn,
    endColumn: range.endColumn,
  })
  const cells: { row: number; column: number; value: CellValue }[] = []
  const calcMarks = new Map<number, ',' | '.'>()
  for (const calc of table.calcs.current.values()) {
    if (calc.active) calcMarks.set(calc.column, calc.mark)
  }
  for (const [row, values] of rows) {
    values.forEach((raw, offset) => {
      if (raw === null || raw === '') return
      const column = range.startColumn + offset
      const calcMark = calcMarks.get(column)
      cells.push({
        row,
        column,
        value:
          calcMark === undefined
            ? largeTableCellValue(table.csvFormat, column, raw)
            : largeTableCalcValue(raw, calcMark),
      })
    })
  }
  // the engine holds every row from the moment the import returns
  return {
    ...(shellResult as Record<string, unknown>),
    cells,
    indexedThroughRow: Math.max(0, table.rows - 1),
    indexingComplete: true,
  }
}

interface FindRequest {
  readonly sessionId: string
  readonly sheetId?: string | undefined
  readonly query: string
  readonly matchCase: boolean
  readonly matchEntireCell: boolean
  readonly lookIn: 'values' | 'formulas' | 'formulas_only' | 'both'
  readonly wildcards: boolean
  readonly resumeAt?:
    { readonly sheetId: string; readonly row: number; readonly column: number } | undefined
  readonly limit: number
}

/// Excel Find over the whole base, in the engine. A number cell matches on
/// the text the grid gives it (JavaScript number text), like the sidecar.
export async function largeTableFindResult(
  engine: DataEngineClient,
  table: LargeTableSession,
  request: FindRequest,
): Promise<unknown> {
  const sheetId = table.sheetId ?? request.sheetId ?? ''
  if (request.lookIn === 'formulas_only' || (request.sheetId && request.sheetId !== sheetId)) {
    return { matches: [], complete: true, indexingComplete: true }
  }
  const numberColumns = largeTableNumberColumns(table)
  const page = await engine.findCells({
    sessionId: table.engineSessionId,
    query: request.query,
    matchCase: request.matchCase,
    matchEntireCell: request.matchEntireCell,
    wildcards: request.wildcards,
    numberColumns,
    resumeRow: request.resumeAt?.row ?? 0,
    resumeColumn: request.resumeAt?.column ?? 0,
    limit: request.limit,
  })
  return {
    matches: page.matches.map(([row, column, text]) => {
      // the engine sends a number cell as its JavaScript text: read it back
      const number = Number(text)
      const isNumber =
        numberColumns.some((entry) => entry.column === column) &&
        text.trim() !== '' &&
        Number.isFinite(number) &&
        String(number) === text
      const value = isNumber ? number : text
      return { sheetId, row, column, value, valueText: text }
    }),
    complete: page.complete,
    ...(page.complete || page.nextRow === undefined
      ? {}
      : { nextCursor: { sheetId, row: page.nextRow, column: page.nextColumn ?? 0 } }),
    indexingComplete: true,
  }
}
