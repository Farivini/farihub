import { describe, expect, it } from 'vitest'

import { parseCsv } from '@genoffice/xlsx-gateway/gateway/csv-import'
import {
  analyzeCsvColumns,
  decideCsvColumns,
  numberShape,
  type ColumnCounts,
} from '@genoffice/xlsx-gateway/gateway/csv-number-format'

import {
  largeTableCellValue,
  largeTableFindResult,
  largeTableRangeResult,
  type LargeTableSession,
} from '../src/main/large-table'
import type { DataEngineClient } from '../src/main/data-engine-client'

/** What the data engine counts natively, computed here the same way. */
function countsOf(rows: string[][]): ColumnCounts[] {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0)
  const counts: ColumnCounts[] = Array.from({ length: width }, () => ({
    int: 0,
    comma: 0,
    point: 0,
    ambiguous: 0,
    code: 0,
    text: 0,
  }))
  for (const row of rows)
    row.forEach((value, column) => {
      if (value.trim() === '') return
      const entry = counts[column]!
      const shape = numberShape(value)
      if (shape === null) entry.text += 1
      else entry[shape] += 1
      if (shape === 'ambiguous') entry.firstAmbiguous ??= value
      if (shape === 'code') entry.firstCode ??= value
      if (shape === 'comma' || shape === 'point') entry.firstConflict ??= value
    })
  return counts
}

const CSV = [
  'nota;codigo;preco;qtd;obs',
  '1;007;1.234,56;-2;texto',
  '2;010;0,5;3;',
  '3;011;12,00;4;1,5',
  '4;012;abc;5;x',
].join('\n')

describe('large tables decide columns like the regular import', () => {
  it('decideCsvColumns from counts equals analyzeCsvColumns', () => {
    const rows = parseCsv(CSV, ';')
    const direct = analyzeCsvColumns(rows, ';')
    const fromCounts = decideCsvColumns(countsOf(rows), ';', rows[0]!)
    expect(fromCounts.report).toEqual(direct.report)
    for (const row of rows)
      row.forEach((value, column) =>
        expect(fromCounts.numberAt(column, value)).toBe(direct.numberAt(column, value)),
      )
  })

  it('a large-table cell is what the regular import writes', () => {
    const rows = parseCsv(CSV, ';')
    const typing = analyzeCsvColumns(rows, ';')
    for (const row of rows)
      row.forEach((value, column) => {
        if (value === '') return
        expect(largeTableCellValue(typing.report, column, value)).toBe(
          typing.numberAt(column, value) ?? value,
        )
      })
    // identifiers keep their zeros, the pt-BR decimal reads, text stays text
    expect(largeTableCellValue(typing.report, 1, '007')).toBe('007')
    expect(largeTableCellValue(typing.report, 2, '1.234,56')).toBe(1234.56)
    expect(largeTableCellValue(typing.report, 2, 'abc')).toBe('abc')
  })
})

describe('large-table reads and finds through the engine', () => {
  const rows = parseCsv(CSV, ';')
  const typing = analyzeCsvColumns(rows, ';')
  const table: LargeTableSession = {
    engineSessionId: 'engine-1',
    rows: rows.length,
    columns: 5,
    cells: 0,
    sourcePath: '/tmp/base.csv',
    importMs: 0,
    csvFormat: typing.report,
    sheetId: 'sheet-1',
  }

  it('maps engine rows onto grid cells and keeps the shell fields', async () => {
    const engine = {
      readRange: async () => [
        [1, ['007', '1.234,56', null]],
        [2, ['010', '', '3']],
      ],
    } as unknown as DataEngineClient
    const result = (await largeTableRangeResult(
      engine,
      table,
      {
        sessionId: 's',
        sheetId: 'sheet-1',
        range: { startRow: 1, endRow: 2, startColumn: 1, endColumn: 3 },
      },
      { cells: [], merges: [], indexingComplete: false },
    )) as {
      cells: unknown[]
      merges: unknown[]
      indexingComplete: boolean
      indexedThroughRow: number
    }
    expect(result.cells).toEqual([
      { row: 1, column: 1, value: '007' },
      { row: 1, column: 2, value: 1234.56 },
      { row: 2, column: 1, value: '010' },
      { row: 2, column: 3, value: 3 },
    ])
    expect(result.merges).toEqual([])
    expect(result.indexingComplete).toBe(true)
    expect(result.indexedThroughRow).toBe(rows.length - 1)
  })

  it('pages find results with the sheet id and number values', async () => {
    const engine = {
      findCells: async () => ({
        matches: [
          [1, 2, '1234.56'],
          [4, 2, 'abc'],
        ],
        complete: false,
        nextRow: 4,
        nextColumn: 3,
      }),
    } as unknown as DataEngineClient
    const result = await largeTableFindResult(engine, table, {
      sessionId: 's',
      query: '1',
      matchCase: false,
      matchEntireCell: false,
      lookIn: 'values',
      wildcards: false,
      limit: 2,
    })
    expect(result).toEqual({
      matches: [
        { sheetId: 'sheet-1', row: 1, column: 2, value: 1234.56, valueText: '1234.56' },
        { sheetId: 'sheet-1', row: 4, column: 2, value: 'abc', valueText: 'abc' },
      ],
      complete: false,
      nextCursor: { sheetId: 'sheet-1', row: 4, column: 3 },
      indexingComplete: true,
    })
  })

  it('formula-only find has nothing to match in a delimited base', async () => {
    const engine = {} as unknown as DataEngineClient
    expect(
      await largeTableFindResult(engine, table, {
        sessionId: 's',
        query: '1',
        matchCase: false,
        matchEntireCell: false,
        lookIn: 'formulas_only',
        wildcards: false,
        limit: 10,
      }),
    ).toEqual({ matches: [], complete: true, indexingComplete: true })
  })
})
