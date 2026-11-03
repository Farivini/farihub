import { afterEach, describe, expect, it } from 'vitest'

import { activateFormulaClosure, applyPinnedOverlay } from '../src/renderer/univer-sync'
import type { LazyWorkbookState } from '../src/renderer/univer-state'

interface PatchCall {
  sheetId: string
  startRow: number
  startColumn: number
}

const sheetMeta = (id: string, name: string) => ({
  id,
  name,
  rowCount: 10,
  columnCount: 5,
  tables: [],
  pivotTables: [],
  freeze: null,
  columnWidths: [],
})

function closureState(): LazyWorkbookState {
  return {
    formulaMode: false,
    file: {
      sessionId: 'session-1',
      styles: [],
      sheets: [sheetMeta('sheet-1', 'Alpha'), sheetMeta('sheet-2', 'Beta')],
    },
    editJournal: { structuralOps: new Map(), cells: new Map() },
    closure: { status: 'idle', pinned: new Map() },
    formulaText: new Map(),
    sharedFormulaGroups: new Map(),
    cachedFormulaValues: new Map(),
    rowColStyleKeys: new Map(),
    hiddenFileRows: new Map(),
    hiddenRowsCoveredThrough: new Map(),
  } as unknown as LazyWorkbookState
}

function stubWorksheet(id: string, patches: PatchCall[]): unknown {
  return {
    getSheetId: () => id,
    getRange: (row: number, column: number) => ({
      setValues: () => {
        patches.push({ sheetId: id, startRow: row, startColumn: column })
      },
    }),
  }
}

function stubRuntime(patches: PatchCall[]): unknown {
  const worksheets = new Map([
    ['sheet-1', stubWorksheet('sheet-1', patches)],
    ['sheet-2', stubWorksheet('sheet-2', patches)],
  ])
  return {
    univerAPI: {
      getActiveWorkbook: () => ({
        getSheetBySheetId: (id: string) => worksheets.get(id) ?? null,
      }),
    },
  }
}

/// Each sheet holds one formula at D1 referencing A1, so the closure fetches
/// exactly one band per sheet — two sequential sidecar reads in total.
function stubDesktopApi(onRangeRead: (call: number) => void): void {
  let rangeReads = 0
  ;(globalThis as { window?: unknown }).window = {
    desktopApi: {
      readWorkbookFormulas: async () => ({
        truncated: false,
        indexingComplete: true,
        cells: [{ row: 0, column: 3, formula: 'A1*2' }],
        sharedGroups: [],
      }),
      readWorkbookRange: async () => {
        rangeReads += 1
        onRangeRead(rangeReads)
        return {
          cells: [
            { row: 0, column: 0, value: 2 },
            { row: 0, column: 3, formula: 'A1*2', value: 4 },
          ],
          rows: [],
          merges: [],
          hyperlinks: [],
          conditionalRules: [],
          dataValidations: [],
          autoFilter: null,
          sheetProtection: null,
          indexedThroughRow: 10,
          indexingComplete: true,
        }
      },
    },
  }
}

describe('activateFormulaClosure structural-edit race', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window
  })

  it('installs and pins the closure when no structural edit interferes', async () => {
    const state = closureState()
    const patches: PatchCall[] = []
    stubDesktopApi(() => undefined)

    await activateFormulaClosure(stubRuntime(patches) as never, { current: state }, () => undefined)

    expect(state.closure.status).toBe('active')
    expect(patches).toHaveLength(2)
    expect(state.closure.pinned.get('sheet-1')?.get('0:3')).toEqual({ f: 'A1*2', v: 4 })
    expect(state.closure.pinned.get('sheet-2')?.get('0:0')).toEqual({ v: 2 })
  })

  it('publishes the first band before awaiting the next read of the same sheet', async () => {
    const state = closureState()
    Object.assign(state.file, { sheets: [{ ...sheetMeta('sheet-1', 'Alpha'), rowCount: 20000 }] })
    let reads = 0
    ;(globalThis as { window?: unknown }).window = {
      desktopApi: {
        readWorkbookFormulas: async () => ({
          truncated: false,
          indexingComplete: true,
          cells: [{ row: 0, column: 3, formula: 'SUM(A1:A20000)' }],
          sharedGroups: [],
        }),
        readWorkbookRange: async ({ range }: { range: { startRow: number } }) => {
          reads += 1
          if (reads === 2)
            expect(state.closure.pinned.get('sheet-1')?.get('0:3')).toEqual({
              f: 'SUM(A1:A20000)',
              v: 40000,
            })
          return {
            cells:
              range.startRow === 0
                ? [{ row: 0, column: 3, formula: 'SUM(A1:A20000)', value: 40000 }]
                : [],
            rows: [],
            merges: [],
            hyperlinks: [],
          }
        },
      },
    }
    await activateFormulaClosure(stubRuntime([]) as never, { current: state }, () => undefined)
    expect(reads).toBeGreaterThan(1)
    expect(state.closure.status).toBe('active')
  })

  it('gives up and drops all pins when a structural edit lands during an install read', async () => {
    const state = closureState()
    const patches: PatchCall[] = []
    // The first sheet installs cleanly; while the second sheet's read is in
    // flight the user inserts rows. Installing that file-space result (or
    // keeping the already-stored pins for later re-application) would land
    // cells at shifted screen positions.
    stubDesktopApi((call) => {
      if (call === 2) {
        state.editJournal.structuralOps.set('sheet-2', [
          { kind: 'insert-rows', index: 0, count: 3 },
        ])
      }
    })

    await activateFormulaClosure(stubRuntime(patches) as never, { current: state }, () => undefined)

    expect(state.closure.status).toBe('unavailable')
    expect(patches).toHaveLength(1)
    expect(state.closure.pinned.size).toBe(0)
  })
})

describe('native cached recalc versus live formulas', () => {
  it('never overwrites engine-owned cells when a native recalc completes later', () => {
    const writes: { row: number; column: number; value: unknown }[] = []
    const worksheet = {
      getRange: (row: number, column: number) => ({
        setValues: (value: unknown) => writes.push({ row, column, value }),
      }),
    }
    applyPinnedOverlay(
      worksheet as never,
      new Map([
        ['1:8', { v: 15.3 }],
        ['2:8', { v: 6.36 }],
      ]),
      undefined,
      { startRow: 0, endRow: 10000, startColumn: 0, endColumn: 8 },
      new Map([['1:8', { f: '=D2*F2', v: 15.3 }]]),
    )
    expect(writes).toHaveLength(1)
    expect(writes[0]?.row).toBe(2)
  })

  it('a value-only pin (a precedent at its cached result) takes the refreshed native value', () => {
    const writes: { row: number; column: number; value: unknown }[] = []
    const worksheet = {
      getRange: (row: number, column: number) => ({
        setValues: (value: unknown) => writes.push({ row, column, value }),
      }),
    }
    // E2 is an imported formula pinned at its cached value (no live f); the user
    // changed its input, and the native recalc now reports 42
    applyPinnedOverlay(
      worksheet as never,
      new Map([
        ['1:4', { v: 42 }],
        ['1:8', { v: 15.3 }],
      ]),
      undefined,
      { startRow: 0, endRow: 10000, startColumn: 0, endColumn: 8 },
      new Map([
        ['1:4', { v: 7 }],
        ['1:8', { f: '=D2*F2', v: 15.3 }],
      ]),
    )
    expect(writes).toEqual([{ row: 1, column: 4, value: [[{ v: 42 }]] }])
  })
})
