import {
  parseNumberWithMark,
  type CsvImportReport,
} from '@genoffice/xlsx-gateway/gateway/csv-number-format'

import type { DataEngineClient } from './data-engine-client'

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
