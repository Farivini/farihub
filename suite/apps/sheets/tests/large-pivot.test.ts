import { describe, expect, it } from 'vitest'

import {
  buildPivotTable,
  displayLabel,
  largePivotQuery,
  looksLikeDates,
  pivotTableText,
  type TableTexts,
} from '../src/renderer/large-pivot'
import { EMPTY_PIVOT_MODEL } from '../src/renderer/pivot-field-model'
import type { LargeTablePivotResult } from '../src/shared/desktop-api'

const fields = [
  { label: 'cidade', colIndex: 0 },
  { label: 'data', colIndex: 1, date: true },
  { label: 'valor', colIndex: 2, numeric: true },
  { label: 'cliente', colIndex: 3 },
]

const texts: TableTexts = {
  rowFieldNames: ['cidade'],
  valueCaptions: ['Soma de valor'],
  grandTotal: 'Total geral',
  blank: '(vazio)',
  share: '% do total',
  cumulative: '% acumulado',
  abcClass: 'Classe',
  dayFirst: true,
}

describe('largePivotQuery', () => {
  it('maps the layout to an engine query, dates by day unless grouped', () => {
    const out = largePivotQuery(
      {
        ...EMPTY_PIVOT_MODEL,
        rows: [0],
        columns: [1],
        filters: [
          { fieldIndex: 3, item: 'a' },
          { fieldIndex: 0, item: null },
        ],
        values: [{ fieldIndex: 2, agg: 'sum', showDataAs: 'percentOfTotal' }],
        groupings: { 1: { kind: 'date', dateUnit: 'month' } },
      },
      fields,
    )
    expect(out).toEqual({
      query: {
        rows: [{ column: 0, group: 'none' }],
        columns: [{ column: 1, group: 'month' }],
        filters: [{ column: 3, group: 'none', include: ['a'] }],
        values: [{ column: 2, agg: 'sum' }],
      },
      showAs: ['percentOfTotal'],
    })
    const day = largePivotQuery({ ...EMPTY_PIVOT_MODEL, rows: [1] }, fields)
    expect('query' in day && day.query.rows).toEqual([{ column: 1, group: 'day' }])
  })

  it('names what the engine does not do yet', () => {
    expect(
      largePivotQuery(
        { ...EMPTY_PIVOT_MODEL, rows: [2], groupings: { 2: { kind: 'range', rangeStep: 10 } } },
        fields,
      ),
    ).toEqual({ gap: { kind: 'rangeGroup' } })
    expect(
      largePivotQuery({ ...EMPTY_PIVOT_MODEL, values: [{ fieldIndex: 2, agg: 'stdDev' }] }, fields),
    ).toEqual({ gap: { kind: 'agg', agg: 'stdDev' } })
    expect(
      largePivotQuery(
        { ...EMPTY_PIVOT_MODEL, values: [{ fieldIndex: 2, agg: 'sum', showDataAs: 'runTotal' }] },
        fields,
      ),
    ).toEqual({ gap: { kind: 'showAs', mode: 'runTotal' } })
  })
})

describe('buildPivotTable', () => {
  const result: LargeTablePivotResult = {
    rows: [
      { labels: ['Rio'], cells: [[30]], total: [30] },
      { labels: ['SP'], cells: [[60]], total: [60] },
      { labels: [''], cells: [[10]], total: [10] },
    ],
    rowCount: 3,
    columns: [{ labels: [], total: [100] }],
    grandTotal: [100],
    sourceRows: 9,
    ms: 1,
  }
  const query = {
    rows: [{ column: 0, group: 'none' as const }],
    columns: [],
    filters: [],
    values: [{ column: 2, agg: 'sum' as const }],
  }

  it('sorts by the first value with share, cumulative share and ABC class', () => {
    const table = buildPivotTable(result, query, [''], texts, true)
    expect(table.body.map((row) => row.map((cell) => cell.text ?? cell.value))).toEqual([
      ['SP', 60, 0.6, 0.6, 'A'],
      ['Rio', 30, 0.3, 0.9, 'B'],
      ['(vazio)', 10, 0.1, 1, 'C'],
    ])
    expect(pivotTableText(table, ';', ',').split('\r\n')).toEqual([
      'cidade;Soma de valor;% do total;% acumulado;Classe',
      'SP;60;60%;60%;A',
      'Rio;30;30%;90%;B',
      '(vazio);10;10%;100%;C',
      'Total geral;100;100%;;',
    ])
  })

  it('shows values as % of the row and of the column from the totals', () => {
    const byMonth: LargeTablePivotResult = {
      rows: [
        { labels: ['Rio'], cells: [[10], null], total: [10] },
        { labels: ['SP'], cells: [[30], [60]], total: [90] },
      ],
      rowCount: 2,
      columns: [
        { labels: ['2024-01'], total: [40] },
        { labels: ['2024-02'], total: [60] },
      ],
      grandTotal: [100],
      sourceRows: 4,
      ms: 1,
    }
    const q = { ...query, columns: [{ column: 1, group: 'month' as const }] }
    const row = buildPivotTable(byMonth, q, ['percentOfRow'], texts, false)
    expect(row.head[0]!.map((cell) => cell.text)).toEqual(['', '01/2024', '02/2024', 'Total geral'])
    expect(row.body[1]!.map((cell) => cell.text ?? cell.value)).toEqual(['SP', 1 / 3, 2 / 3, 1])
    const col = buildPivotTable(byMonth, q, ['percentOfCol'], texts, false)
    expect(col.body[1]!.map((cell) => cell.text ?? cell.value)).toEqual(['SP', 0.75, 1, 0.9])
    expect(col.foot.map((cell) => cell.text ?? cell.value)).toEqual(['Total geral', 1, 1, 1])
  })
})

describe('labels and dates', () => {
  it('shows ISO date labels in the reader order', () => {
    expect(displayLabel('2016-08-02', 'day', true, '-')).toBe('02/08/2016')
    expect(displayLabel('2016-T3', 'quarter', true, '-')).toBe('T3/2016')
    expect(displayLabel('', 'none', true, '(vazio)')).toBe('(vazio)')
    expect(displayLabel('2016-08', 'month', false, '-')).toBe('2016-08')
  })

  it('tells date columns from codes and text', () => {
    expect(looksLikeDates(['2/8/16', '29/06/2025 11:00', '', '2024-01-05'])).toBe(true)
    expect(looksLikeDates(['V073', 'V074', '2/8/16'])).toBe(false)
    expect(looksLikeDates([1, 2])).toBe(false)
  })
})
