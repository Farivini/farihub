import { describe, expect, it } from 'vitest'
import { parseRange } from '@genoffice/xlsx-gateway/domain/cell-address'

import {
  planLargeTableClear,
  singleFormulaCell,
  splitLargeTablePlan,
} from '../src/renderer/large-table-calc'

const plan = (over: Record<string, unknown>): any => ({
  transactionId: 't',
  baseRevision: 0,
  warnings: [],
  cellChanges: [],
  structuralChanges: [],
  formatChanges: [],
  sheetRenames: [],
  ...over,
})
const change = (address: string, after: { value: unknown; formula?: string }) => ({
  sheetId: 'sh1',
  address,
  before: { value: null },
  after,
})
const fill = (source: string, target: string, sheetId = 'sh1') => ({
  op: { op: 'fill_range', sheetId, source, target },
})

describe('splitLargeTablePlan', () => {
  it('turns a formula filled down its column (in several fills) into one calculated column', () => {
    const split = splitLargeTablePlan(
      plan({
        cellChanges: [
          change('J1', { value: 'Imposto' }),
          change('J2', { value: null, formula: '=I2*0.18' }),
        ],
        // the DSL caps one fill at 200,000 cells: a model fills in parts
        structuralChanges: [fill('J2', 'J2:J200001'), fill('J2', 'J200002:J400001')],
      }),
      parseRange,
    )
    expect('reason' in split).toBe(false)
    if ('reason' in split) return
    expect(split.calcs).toEqual([{ row: 1, column: 9, formula: '=I2*0.18' }])
    // the header stays a value write; the formula and the fills are gone
    expect(split.plan.cellChanges.map((c: { address: string }) => c.address)).toEqual(['J1'])
    expect(split.plan.structuralChanges).toEqual([])
  })

  it('keeps a values-only plan as it is', () => {
    const split = splitLargeTablePlan(
      plan({ cellChanges: [change('A2', { value: 5 })] }),
      parseRange,
    )
    expect('reason' in split ? split.reason : split.calcs).toEqual([])
  })

  it('refuses what a large base cannot take yet', () => {
    const reason = (over: Record<string, unknown>) => {
      const split = splitLargeTablePlan(plan(over), parseRange)
      return 'reason' in split ? split.reason : null
    }
    expect(reason({ formatChanges: [{}] })).toMatch(/formatting/)
    expect(reason({ structuralChanges: [{ op: { op: 'insert_rows' } }] })).toBe('insert_rows')
    // a lone formula: on a large base it would fill the whole column
    expect(reason({ cellChanges: [change('K2', { value: null, formula: '=SUM(I:I)' })] })).toMatch(
      /single cell/,
    )
    // a fill sideways, or of a cell without a new formula
    expect(
      reason({
        cellChanges: [change('J2', { value: null, formula: '=I2' })],
        structuralChanges: [fill('J2', 'J2:K10')],
      }),
    ).toMatch(/own column/)
    expect(reason({ structuralChanges: [fill('J2', 'J2:J10')] })).toMatch(/without a new formula/)
  })
})

describe('singleFormulaCell', () => {
  it('finds the one formula a set-range-values command writes', () => {
    expect(
      singleFormulaCell({ range: { startRow: 1, startColumn: 9 }, value: { f: '=I2*2', v: null } }),
    ).toEqual({ row: 1, column: 9, formula: '=I2*2' })
    // typed text the editor did not convert
    expect(singleFormulaCell({ value: { 4: { 2: { v: '=A1' } } } })).toEqual({
      row: 4,
      column: 2,
      formula: '=A1',
    })
    // several formulas (a paste) or none
    expect(singleFormulaCell({ value: { 1: { 0: { f: '=A1' }, 1: { f: '=B1' } } } })).toBeNull()
    expect(
      singleFormulaCell({ value: { v: 12 }, range: { startRow: 0, startColumn: 0 } }),
    ).toBeNull()
  })
})

describe('planLargeTableClear', () => {
  const calcs = [{ calcId: 'c9', column: 9, firstRow: 1, lastRow: 99 }]
  it('turns off a calculated column whose formula rows are all selected', () => {
    // J1:J100 plus whole-column overshoot: the header clears, the formula goes
    expect(
      planLargeTableClear(
        [{ startRow: 0, endRow: 1_048_575, startColumn: 8, endColumn: 9 }],
        100,
        10,
        calcs,
      ),
    ).toEqual({
      fills: [
        { startRow: 0, endRow: 99, startColumn: 8, endColumn: 8 },
        { startRow: 0, endRow: 0, startColumn: 9, endColumn: 9 },
      ],
      calcIds: ['c9'],
    })
  })
  it('clears part of a calculated column as values, and clamps to the base', () => {
    expect(
      planLargeTableClear(
        [{ startRow: 5, endRow: 9, startColumn: 9, endColumn: 16_383 }],
        100,
        10,
        calcs,
      ),
    ).toEqual({ fills: [{ startRow: 5, endRow: 9, startColumn: 9, endColumn: 9 }], calcIds: [] })
  })
})
