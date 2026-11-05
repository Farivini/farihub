import { describe, expect, it } from 'vitest'

import { parseCsv } from '@genoffice/xlsx-gateway/gateway/csv-import'
import {
  analyzeCsvColumns,
  decideCsvColumns,
  numberShape,
  type ColumnCounts,
} from '@genoffice/xlsx-gateway/gateway/csv-number-format'

import { largeTableBlock } from '../src/renderer/sheet-protection'
import {
  largeTableCellValue,
  largeTableColumnMark,
  largeTableEditText,
  largeTableEngineEdits,
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
    target: { current: { path: '/tmp/base.csv', format: 'csv', size: 0, mtimeMs: 0 } },
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

describe('large-table edits', () => {
  const rows = parseCsv('id;valor\n1;1,5\n', ';')
  const ptBr = analyzeCsvColumns(rows, ';').report
  const en = analyzeCsvColumns(parseCsv('id,value\n1,1.5\n', ','), ',').report

  it('writes an edited value in the file convention', () => {
    expect(largeTableEditText(1234.5, ptBr)).toBe('1234,5')
    expect(largeTableEditText(1234.5, en)).toBe('1234.5')
    expect(largeTableEditText(1.2e-7, ptBr)).toBe('0,00000012')
    expect(largeTableEditText('007', ptBr)).toBe('007')
    expect(largeTableEditText(true, ptBr)).toBe('TRUE')
    expect(largeTableEditText(null, ptBr)).toBeNull()
    expect(largeTableEditText('', ptBr)).toBeNull()
  })

  it('keeps the text the grid shows for a formatted number (a typed date)', () => {
    expect(largeTableEditText(36526, ptBr, 'dd/mm/yyyy')).toBe('01/01/2000')
    expect(largeTableEditText(0.125, ptBr, '0.00%')).toBe('12,50%')
    expect(largeTableEditText(0.125, en, '0.00%')).toBe('12.50%')
    expect(largeTableEditText(0.125, en, 'General')).toBe('0.125')
  })

  it('turns a save request into engine edits for the base sheet only', () => {
    const table = {
      engineSessionId: 'e',
      rows: 10,
      columns: 2,
      cells: 0,
      sourcePath: '/b.csv',
      importMs: 0,
      csvFormat: ptBr,
      sheetId: 'sheet-1',
      target: { current: { path: '/b.csv', format: 'csv' as const, size: 0, mtimeMs: 0 } },
    }
    const edits = largeTableEngineEdits(table, {
      edits: [
        { sheetId: 'sheet-1', row: 1, column: 1, writeValue: true, value: 2.5 },
        { sheetId: 'sheet-1', row: 2, column: 0, writeValue: false, value: null },
        { sheetId: 'other', row: 1, column: 1, writeValue: true, value: 'x' },
      ],
      bulkConstantFills: [
        { sheetId: 'sheet-1', startRow: 3, endRow: 9, startColumn: 0, endColumn: 0, value: null },
      ],
    })
    expect(edits).toEqual({
      fills: [{ startRow: 3, endRow: 9, startColumn: 0, endColumn: 0, text: null }],
      cells: [{ row: 1, column: 1, text: '2,5' }],
    })
  })
})

describe('large-table command guard', () => {
  it('lets value edits through and stops formulas, formatting and structure', () => {
    const range = { startRow: 1, endRow: 1, startColumn: 0, endColumn: 0 }
    expect(
      largeTableBlock('sheet.command.set-range-values', 'edit', { range, value: { v: 'novo' } }),
    ).toBeNull()
    expect(
      largeTableBlock('sheet.command.set-range-values', 'edit', { range, value: { f: '=A1*2' } }),
    ).toBe('appLargeTableNoFormulas')
    expect(
      largeTableBlock('sheet.command.set-range-values', 'edit', { range, value: { s: 'bold' } }),
    ).toBe('appLargeTableNotYet')
    expect(largeTableBlock('sheet.command.clear-selection-content', 'edit', {})).toBeNull()
    expect(largeTableBlock('sheet.command.insert-row', 'insertRows', {})).toBe(
      'appLargeTableNotYet',
    )
    expect(
      largeTableBlock('sheet.command.set-range-values', 'edit', {
        range: { startRow: 1_048_576, endRow: 1_048_576, startColumn: 0, endColumn: 0 },
        value: { v: 1 },
      }),
    ).toBe('appLargeTableRowLimit')
  })
})

describe('large-table decimal mark per column', () => {
  // pt-BR file: comma-decimal amounts, an integer-only quantity column
  const rows = parseCsv('qtd;valor;obs\n2;1,5;a\n30;2,25;b\n', ';')
  const typing = analyzeCsvColumns(rows, ';')
  const format = typing.report

  it('an integer-only column takes the file mark, and its values read the same', () => {
    expect(format.decimal).toBe(',')
    expect(format.columns[0]?.kind).toBe('number')
    expect(format.columns[0]?.decimal).toBeUndefined()
    expect(largeTableColumnMark(format, 0)).toBe(',')
    for (const row of rows)
      row.forEach((value, column) =>
        expect(largeTableCellValue(format, column, value)).toBe(
          typing.numberAt(column, value) ?? value,
        ),
      )
  })

  it('an edited number round-trips through its column (1.234 stays 1.234)', () => {
    const text = largeTableEditText(1.234, format, undefined, 0)
    expect(text).toBe('1,234')
    expect(largeTableCellValue(format, 0, text!)).toBe(1.234)
    expect(largeTableCellValue(format, 1, largeTableEditText(1234.5, format, undefined, 1)!)).toBe(
      1234.5,
    )
  })

  it('a file whose columns disagree writes each column in its own mark', () => {
    const mixed = analyzeCsvColumns(parseCsv('a;b\n1,5;2.5\n', ';'), ';').report
    expect(mixed.decimal).toBeNull()
    expect(largeTableColumnMark(mixed, 0)).toBe(',')
    expect(largeTableColumnMark(mixed, 1)).toBe('.')
    expect(largeTableEditText(7.25, mixed, undefined, 0)).toBe('7,25')
    expect(largeTableEditText(7.25, mixed, undefined, 1)).toBe('7.25')
    expect(largeTableCellValue(mixed, 0, '7,25')).toBe(7.25)
    expect(largeTableCellValue(mixed, 1, '7.25')).toBe(7.25)
  })

  it('a fill over several columns becomes one engine fill per column', () => {
    const edits = largeTableEngineEdits(
      {
        engineSessionId: 'e',
        rows: 10,
        columns: 3,
        cells: 0,
        sourcePath: '/b.csv',
        importMs: 0,
        csvFormat: format,
        sheetId: 's',
        target: { current: { path: '/b.csv', format: 'csv', size: 0, mtimeMs: 0 } },
      },
      {
        edits: [],
        bulkConstantFills: [
          { sheetId: 's', startRow: 1, endRow: 2, startColumn: 0, endColumn: 1, value: 0.5 },
        ],
      },
    )
    expect(edits.fills).toEqual([
      { startRow: 1, endRow: 2, startColumn: 0, endColumn: 0, text: '0,5' },
      { startRow: 1, endRow: 2, startColumn: 1, endColumn: 1, text: '0,5' },
    ])
  })
})
