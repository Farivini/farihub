import { describe, expect, it } from 'vitest'

import { applyChangePlan, nextSheetName, planFromOps } from '../src/renderer/op-executor'

const workbook = {
  getSheetBySheetId: (id: string) => (id === 'sh1' ? { getSheetName: () => 'Data' } : undefined),
} as unknown as Parameters<typeof planFromOps>[1]

describe('nextSheetName', () => {
  it('picks the lowest free SheetN, case-insensitively', () => {
    expect(nextSheetName([])).toBe('Sheet1')
    expect(nextSheetName(['Sheet1', 'sheet2', 'Data'])).toBe('Sheet3')
    expect(nextSheetName(['Sheet2'])).toBe('Sheet1')
  })
})

describe('planFromOps', () => {
  it('wraps ribbon-built ops into the plan shape the executor applies', () => {
    const plan = planFromOps(
      [
        { op: 'insert_rows', sheetId: 'sh1', row: 3, count: 1 },
        { op: 'set_freeze', sheetId: 'sh1', rows: 1, columns: 0 },
        { op: 'merge_cells', sheetId: 'sh1', range: 'A1:C1' },
        {
          op: 'format_range',
          sheetId: 'sh1',
          range: 'A1:C1',
          format: { horizontalAlign: 'center' },
        },
      ],
      workbook,
      'ribbon',
    )
    expect(plan.structuralChanges.map((change) => change.op.op)).toEqual([
      'insert_rows',
      'set_freeze',
      'merge_cells',
    ])
    expect(plan.formatChanges).toHaveLength(1)
    expect(plan.cellChanges).toHaveLength(0)
    expect(plan.transactionId).toMatch(/^ui-/)
  })
})

describe('applyChangePlan on a large base', () => {
  it('refuses every plan before it touches the grid or the journal', async () => {
    const plan = planFromOps(
      [{ op: 'fill_range', sheetId: 'sh1', source: 'A1', target: 'A1:A10' }] as never,
      workbook,
      'ribbon',
    )
    const messages: string[] = []
    const ctx = {
      // any access beyond the read-only check would throw on these stubs
      runtime: null,
      workbook: null,
      state: { file: { largeTable: { rows: 2_000_000, columns: 9 } } },
      lazyWorkbookRef: { current: null },
      setMessage: (message: string) => messages.push(message),
      setPendingEdits: () => undefined,
    } as unknown as Parameters<typeof applyChangePlan>[1]
    const outcome = await applyChangePlan(plan, ctx, {} as Parameters<typeof applyChangePlan>[2])
    expect(outcome.ok).toBe(false)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatch(/next stage|próxima etapa|下一阶段/)
    expect(outcome.ok ? '' : outcome.reason).toBe(messages[0])
  })
})
