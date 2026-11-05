import * as numfmt from 'numfmt'
import {
  parseNumberWithMark,
  type CsvImportReport,
} from '@genoffice/xlsx-gateway/gateway/csv-number-format'

import type { DataEngineClient } from './data-engine-client'

/// Where Save writes the base, and the file's size/mtime as last read or
/// written: a Save over a file changed elsewhere since then is refused.
export interface LargeTableTarget {
  readonly path: string
  readonly format: 'csv' | 'xlsx'
  readonly size: number
  readonly mtimeMs: number
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

/// The text an edited value takes in the base, in the file's own convention:
/// a number with the file's decimal mark (as the CSV writer saves it), a
/// boolean as Excel writes it, text as typed; null empties the cell.
export function largeTableEditText(
  value: string | number | boolean | null,
  format: CsvImportReport,
  numberFormat?: string | undefined,
): string | null {
  if (value === null || value === '') return null
  if (typeof value === 'number') {
    // a typed date or a formatted number keeps the text the grid shows —
    // the CSV writer's "values as displayed" — not the serial behind it
    if (numberFormat !== undefined && !/^general$/i.test(numberFormat.trim())) {
      const shown = numfmt.format(numberFormat, value, {
        throws: false,
        locale: format.decimal === ',' ? 'pt-BR' : 'en-US',
      })
      if (typeof shown === 'string' && shown !== '' && !/^#+$/.test(shown)) return shown
    }
    const text = plainDecimal(value)
    return format.decimal === ',' ? text.replace('.', ',') : text
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  return value
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
    fills: (request.bulkConstantFills ?? [])
      .filter((fill) => onSheet(fill.sheetId))
      .map((fill) => ({
        startRow: fill.startRow,
        endRow: fill.endRow,
        startColumn: fill.startColumn,
        endColumn: fill.endColumn,
        text: largeTableEditText(fill.value, table.csvFormat),
      })),
    cells: request.edits
      .filter((edit) => edit.writeValue && onSheet(edit.sheetId))
      .map((edit) => ({
        row: edit.row,
        column: edit.column,
        text: largeTableEditText(edit.value, table.csvFormat, edit.style?.numberFormat),
      })),
  }
}

type CellValue = string | number

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
  return parseNumberWithMark(raw, decision.decimal ?? '.') ?? raw
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
  for (const [row, values] of rows) {
    values.forEach((raw, offset) => {
      if (raw === null || raw === '') return
      const column = range.startColumn + offset
      cells.push({ row, column, value: largeTableCellValue(table.csvFormat, column, raw) })
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
  const numberColumns = table.csvFormat.columns
    .filter((column) => column.kind === 'number')
    .map((column) => ({ column: column.column, decimal: column.decimal ?? '.' }))
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
        table.csvFormat.columns[column]?.kind === 'number' &&
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
