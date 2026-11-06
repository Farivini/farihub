import { CommandType, ICommandService, IUndoRedoService } from '@univerjs/core'
import { SheetPermissionCheckController } from '@univerjs/sheets'

import type { LargeTableCalcResult, LargeTableGridEdits } from '../shared/desktop-api'
import { BULK_FILL_UNDO_COMMAND_ID } from './bulk-fill-undo'
import {
  journalCellContentAt,
  recordBulkConstantFill,
  removeBulkConstantFill,
  restoreJournalCells,
} from './edit-journal'
import { t } from './i18n/locale'
import { columnLabel } from './redact-actions'
import { pushVisualUndo } from './univer-sync'
import { journalSuppression, type LazyWorkbookState, type UniverRuntime } from './univer-state'

/// Calculated columns of a large base (data engine). A formula typed in one
/// cell fills every data row of its column, like Excel's table column
/// formula: the engine computes it over the whole base, the grid repaints
/// the rows it holds. Undo/Redo turn the column off and on; an edit of a cell
/// a formula reads recomputes it.

export const LARGE_TABLE_CALC_UNDO_ID = 'sheets.mutation.large-table-calc'

const SET_RANGE_VALUES_MUTATION = 'sheet.mutation.set-range-values'
/// Edits arriving within this window recompute together.
const REFRESH_DEBOUNCE_MS = 250

interface CalcUndoParams {
  readonly calcId: string
  /// the calculated column this one replaced on the same column
  readonly replaced: string | null
  readonly direction: 'undo' | 'redo'
}

export interface LargeTableCalcDeps {
  readonly runtime: UniverRuntime
  readonly getState: () => LazyWorkbookState | null
  readonly notify: (message: string, kind: 'success' | 'error') => void
  /// status bar only (no toast): the background recompute after an edit
  readonly status?: (message: string) => void
  /// the journal changed outside a grid command (the unsaved-edits count)
  readonly journalChanged?: () => void
}

interface Span {
  startRow: number
  endRow: number
  startColumn: number
  endColumn: number
}

/// The grid's unsaved value edits of the base's sheet, as the engine reads
/// them (the values the grid holds).
export function largeTableJournalEdits(
  state: LazyWorkbookState,
  sheetId: string,
): LargeTableGridEdits {
  const cells: { row: number; column: number; value: string | number | boolean | null }[] = []
  for (const entry of state.editJournal.cells.get(sheetId)?.values() ?? []) {
    if (entry.hasValue) cells.push({ row: entry.row, column: entry.column, value: entry.value })
  }
  const fills = (state.editJournal.bulkConstantFills.get(sheetId) ?? []).map(
    ({ startRow, endRow, startColumn, endColumn, value }) => ({
      startRow,
      endRow,
      startColumn,
      endColumn,
      value,
    }),
  )
  return { cells, fills }
}

export { singleFormulaCell } from './large-table-formula'

/// The message for an engine refusal.
export function largeTableCalcMessage(code: string, detail: string): string {
  switch (code) {
    case 'HEADER_ROW':
      return t('appLargeTableCalcHeader')
    case 'COLUMN_NOT_EMPTY':
      return t('appLargeTableCalcNotEmpty')
    case 'UNSUPPORTED_FUNCTION':
      return t('appLargeTableCalcFunction', { name: detail })
    case 'UNSUPPORTED_REFERENCE':
      return t('appLargeTableCalcReference', { ref: detail })
    case 'CIRCULAR':
      return t('appLargeTableCalcCircular')
    case 'APPROXIMATE_LOOKUP':
      return t('appLargeTableCalcApproximate', { name: detail })
    case 'UNSUPPORTED_RANGE':
      return t('appLargeTableCalcRange')
    case 'SYNTAX':
      return t('appLargeTableCalcSyntax', { detail })
    default:
      return t('appLargeTableCalcFailed', { detail })
  }
}

/// The base changed in the engine (a calculated column on or off): the
/// workbook has something to save even with no cell edit in the journal.
function noteEngineChange(deps: LargeTableCalcDeps, state: LazyWorkbookState): void {
  state.editJournal.engineChanges.count += 1
  deps.journalChanged?.()
}

/// Set by installLargeTableCalc: recompute the formulas reading these cells.
let scheduleRefresh: ((span: Span) => void) | null = null

/// Engine calls run one at a time, in the order the grid asked for them.
let queue: Promise<unknown> = Promise.resolve()
function enqueue<T>(run: () => Promise<T>): Promise<T> {
  const next = queue.then(run, run)
  queue = next.catch(() => undefined)
  return next
}

/// Every large-table calc change waits for the calls already queued (a Save
/// must not run between an edit and its recompute).
export function largeTableCalcSettled(): Promise<void> {
  return queue.then(() => undefined)
}

/// Rewrites the resident rows of `columns` from the base, under journal
/// suppression; a cell the journal holds keeps the journal's value.
async function repaintColumns(
  deps: LargeTableCalcDeps,
  state: LazyWorkbookState,
  columns: readonly number[],
): Promise<void> {
  const sheetId = state.file.sheets[0]?.id
  const loaded = sheetId === undefined ? undefined : state.loadedRanges.get(sheetId)
  const worksheet = deps.runtime.univerAPI.getActiveWorkbook()?.getSheetBySheetId(sheetId ?? '')
  if (sheetId === undefined || loaded === undefined || !worksheet) return
  for (const column of new Set(columns)) {
    const startRow = loaded.startRow
    const endRow = loaded.endRow
    if (endRow < startRow) continue
    const result = await window.desktopApi.readWorkbookRange({
      sessionId: state.file.sessionId,
      sheetId,
      range: { startRow, endRow, startColumn: column, endColumn: column },
    })
    if (deps.getState() !== state) return
    const values = new Map<number, string | number | boolean | null>()
    for (const cell of result.cells) values.set(cell.row, cell.value ?? null)
    const matrix = Array.from({ length: endRow - startRow + 1 }, (_unused, offset) => {
      const row = startRow + offset
      // the journal's own edit of this cell (a typed value, a clear) wins
      const journal = journalCellContentAt(state.editJournal, sheetId, row, column)
      const value = journal.found ? journal.value : (values.get(row) ?? null)
      return [
        value === null
          ? { v: null, f: null, si: null, p: null, t: null }
          : { v: value, f: null, si: null, p: null },
      ]
    })
    journalSuppression.active = true
    try {
      worksheet.getRange(startRow, column, matrix.length, 1).setValues(matrix)
    } finally {
      journalSuppression.active = false
    }
  }
}

function pushCalcUndo(deps: LargeTableCalcDeps, calcId: string, replaced: string | null): void {
  const unitId = deps.runtime.univerAPI.getActiveWorkbook()?.getId()
  if (!unitId) return
  const injector = (
    deps.runtime.univer as unknown as { __getInjector(): { get<T>(token: unknown): T } }
  ).__getInjector()
  injector
    .get<{
      pushUndoRedo(item: {
        unitID: string
        undoMutations: { id: string; params: CalcUndoParams }[]
        redoMutations: { id: string; params: CalcUndoParams }[]
      }): void
    }>(IUndoRedoService)
    .pushUndoRedo({
      unitID: unitId,
      undoMutations: [
        { id: LARGE_TABLE_CALC_UNDO_ID, params: { calcId, replaced, direction: 'undo' } },
      ],
      redoMutations: [
        { id: LARGE_TABLE_CALC_UNDO_ID, params: { calcId, replaced, direction: 'redo' } },
      ],
    })
}

/// Turns one calculated column off (undo) or on (redo), with the column it
/// replaced the other way, then repaints what changed.
async function applyCalcUndo(deps: LargeTableCalcDeps, params: CalcUndoParams): Promise<void> {
  const state = deps.getState()
  const sheetId = state?.file.sheets[0]?.id
  if (!state || state.file.largeTable === undefined || sheetId === undefined) return
  const steps: { calcId: string; active: boolean }[] =
    params.direction === 'undo'
      ? [
          { calcId: params.calcId, active: false },
          ...(params.replaced === null ? [] : [{ calcId: params.replaced, active: true }]),
        ]
      : [
          ...(params.replaced === null ? [] : [{ calcId: params.replaced, active: false }]),
          { calcId: params.calcId, active: true },
        ]
  const repaint: number[] = []
  for (const step of steps) {
    const result = await window.desktopApi.largeTableCalc({
      action: 'set-active',
      sessionId: state.file.sessionId,
      calcId: step.calcId,
      active: step.active,
      edits: largeTableJournalEdits(state, sheetId),
    })
    if (!result.ok) {
      deps.notify(largeTableCalcMessage(result.code, result.detail), 'error')
      break
    }
    repaint.push(...result.refreshed)
  }
  if (deps.getState() === state) {
    noteEngineChange(deps, state)
    await repaintColumns(deps, state, repaint)
  }
}

/// A formula typed into a data cell of the base: the whole column becomes
/// that formula. Runs after the edit command was vetoed, so nothing of the
/// typed text lands in the journal.
export type LargeTableCalcOutcome =
  | {
      ok: true
      message: string
      rows: number
      errors: number
      firstErrorRow: number | null
      /** the first and last data rows' results, read back from the engine */
      first: string | number | boolean | null
      last: string | number | boolean | null
    }
  | { ok: false; message: string }

export function createLargeTableCalc(
  deps: LargeTableCalcDeps,
  cell: { row: number; column: number; formula: string },
): Promise<LargeTableCalcOutcome> {
  return enqueue(async (): Promise<LargeTableCalcOutcome> => {
    const fail = (message: string): LargeTableCalcOutcome => {
      deps.notify(message, 'error')
      return { ok: false, message }
    }
    const state = deps.getState()
    const sheetId = state?.file.sheets[0]?.id
    const large = state?.file.largeTable
    if (!state || large === undefined || sheetId === undefined) {
      return { ok: false, message: t('appApplyTxFailed') }
    }
    if (cell.row < 1) return fail(t('appLargeTableCalcHeader'))
    const rows = (large.rows - 1).toLocaleString()
    const column = columnLabel(cell.column)
    deps.notify(t('appLargeTableCalcRunning', { column, rows }), 'success')
    let result: LargeTableCalcResult
    try {
      result = await window.desktopApi.largeTableCalc({
        action: 'create',
        sessionId: state.file.sessionId,
        column: cell.column,
        anchorRow: cell.row,
        formula: cell.formula,
        edits: largeTableJournalEdits(state, sheetId),
      })
    } catch (error) {
      return fail(
        t('appLargeTableCalcFailed', {
          detail: error instanceof Error ? error.message : String(error),
        }),
      )
    }
    if (!result.ok) return fail(largeTableCalcMessage(result.code, result.detail))
    if (deps.getState() !== state || result.calcId === undefined) {
      return { ok: false, message: t('appApplyTxFailed') }
    }
    // the base gained a column: the grid streams it like the file's own
    const meta = state.file.sheets[0] as { columnCount: number; valueColumnCount?: number }
    meta.columnCount = Math.max(meta.columnCount, cell.column + 1)
    if (meta.valueColumnCount !== undefined) {
      meta.valueColumnCount = Math.max(meta.valueColumnCount, cell.column + 1)
    }
    noteEngineChange(deps, state)
    pushCalcUndo(deps, result.calcId, result.replaced ?? null)
    await repaintColumns(deps, state, result.refreshed)
    const seconds = (result.ms / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })
    const done = t('appLargeTableCalcDone', { column, rows, seconds })
    const errors = result.errors ?? 0
    const message =
      errors > 0 && result.firstErrorRow != null
        ? `${done} ${t('appLargeTableCalcErrors', {
            count: errors.toLocaleString(),
            row: (result.firstErrorRow + 1).toLocaleString(),
          })}`
        : done
    deps.notify(message, 'success')
    const lastRow = large.rows - 1
    const readBack = async (row: number) =>
      (
        await window.desktopApi.readWorkbookRange({
          sessionId: state.file.sessionId,
          sheetId,
          range: { startRow: row, endRow: row, startColumn: cell.column, endColumn: cell.column },
        })
      ).cells[0]?.value ?? null
    return {
      ok: true,
      message,
      rows: result.rows ?? lastRow,
      errors,
      firstErrorRow: result.firstErrorRow ?? null,
      first: await readBack(1),
      last: await readBack(lastRow),
    }
  })
}

interface PlanLike {
  readonly cellChanges: readonly {
    readonly sheetId: string
    readonly address: string
    readonly after: { readonly value: unknown; readonly formula?: string | null | undefined }
  }[]
  readonly structuralChanges: readonly { readonly op: { readonly op: string } }[]
  readonly formatChanges: readonly unknown[]
  readonly sheetRenames: readonly unknown[]
}

/// An AI plan on a large base: value writes stay in the plan; a formula
/// filled down its own column (set_formula + fill_range, in one or several
/// fill_range ops) becomes one calculated column over the whole base. Anything
/// else (formatting, structure, a lone formula) is refused with `reason`.
export function splitLargeTablePlan<P extends PlanLike>(
  plan: P,
  parse: (address: string) => {
    startRow: number
    endRow: number
    startColumn: number
    endColumn: number
  },
): { plan: P; calcs: { row: number; column: number; formula: string }[] } | { reason: string } {
  if (plan.formatChanges.length > 0 || plan.sheetRenames.length > 0) {
    return { reason: 'formatting and sheet changes' }
  }
  const staged = new Map<string, string>()
  for (const change of plan.cellChanges) {
    if (change.after.formula)
      staged.set(`${change.sheetId}:${change.address.toUpperCase()}`, change.after.formula)
  }
  const calcs = new Map<number, { row: number; column: number; formula: string }>()
  const consumed = new Set<string>()
  for (const { op } of plan.structuralChanges) {
    const fill = op as {
      op: string
      sheetId?: string
      sourceSheetId?: string
      source?: string
      target?: string
    }
    if (fill.op !== 'fill_range' || !fill.source || !fill.target || !fill.sheetId) {
      return { reason: `${fill.op}` }
    }
    if (fill.sourceSheetId !== undefined && fill.sourceSheetId !== fill.sheetId) {
      return { reason: 'fill from another sheet' }
    }
    const source = parse(fill.source)
    const target = parse(fill.target)
    if (
      source.startRow !== source.endRow ||
      source.startColumn !== source.endColumn ||
      target.startColumn !== source.startColumn ||
      target.endColumn !== source.startColumn
    ) {
      return { reason: 'fill_range other than one formula cell down its own column' }
    }
    const key = `${fill.sheetId}:${fill.source.toUpperCase()}`
    const formula = staged.get(key)
    if (formula === undefined) return { reason: 'fill_range of a cell without a new formula' }
    consumed.add(key)
    const existing = calcs.get(source.startColumn)
    if (
      existing !== undefined &&
      (existing.formula !== formula || existing.row !== source.startRow)
    ) {
      return { reason: 'two formulas for one column' }
    }
    calcs.set(source.startColumn, { row: source.startRow, column: source.startColumn, formula })
  }
  for (const key of staged.keys()) {
    if (!consumed.has(key)) return { reason: 'a formula in a single cell' }
  }
  const values: P = {
    ...plan,
    cellChanges: plan.cellChanges.filter((change) => !change.after.formula),
    structuralChanges: [],
  }
  return { plan: values, calcs: [...calcs.values()] }
}

/// Cells a value mutation touched, as one span per mutation.
function mutationSpan(id: string, params: unknown): Span | null {
  if (typeof params !== 'object' || params === null) return null
  const record = params as Record<string, unknown>
  if (id === BULK_FILL_UNDO_COMMAND_ID) {
    const fill = record.fill as Span | undefined
    return fill ?? null
  }
  const matrix = record.cellValue
  if (typeof matrix !== 'object' || matrix === null) return null
  let span: Span | null = null
  for (const [rowKey, rowValue] of Object.entries(matrix as Record<string, unknown>)) {
    if (typeof rowValue !== 'object' || rowValue === null) continue
    const row = Number(rowKey)
    for (const columnKey of Object.keys(rowValue as Record<string, unknown>)) {
      const column = Number(columnKey)
      if (!Number.isInteger(row) || !Number.isInteger(column)) continue
      span =
        span === null
          ? { startRow: row, endRow: row, startColumn: column, endColumn: column }
          : {
              startRow: Math.min(span.startRow, row),
              endRow: Math.max(span.endRow, row),
              startColumn: Math.min(span.startColumn, column),
              endColumn: Math.max(span.endColumn, column),
            }
    }
  }
  return span
}

/// Registers the Undo/Redo mutation and recomputes formulas after edits of
/// the cells they read.
export function installLargeTableCalc(deps: LargeTableCalcDeps): { dispose(): void } {
  const injector = (
    deps.runtime.univer as unknown as { __getInjector(): { get<T>(token: unknown): T } }
  ).__getInjector()
  const commands = injector.get<{
    registerCommand(command: {
      id: string
      type: unknown
      handler: (accessor: unknown, params?: CalcUndoParams) => boolean
    }): { dispose(): void }
  }>(ICommandService)
  const registration = commands.registerCommand({
    id: LARGE_TABLE_CALC_UNDO_ID,
    type: CommandType.MUTATION,
    handler: (_accessor, params) => {
      if (params === undefined) return false
      void enqueue(() => applyCalcUndo(deps, params))
      return true
    },
  })

  // Univer checks view permission on every cell a typed formula references
  // before the command runs (getCell per cell: 30 s for B2:I1048568). A large
  // base has no protection, and the guard turns the formula into a calculated
  // column anyway: skip that walk there.
  const permission = injector.get(SheetPermissionCheckController) as unknown as {
    _permissionCheckWithFormula?: (params: unknown) => boolean
  }
  const formulaCheck = permission._permissionCheckWithFormula
  if (typeof formulaCheck === 'function') {
    permission._permissionCheckWithFormula = function (this: unknown, params: unknown) {
      if (deps.getState()?.file.largeTable !== undefined) return true
      return formulaCheck.call(this, params)
    }
  }

  let pending: Span[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  scheduleRefresh = (span) => {
    pending.push(span)
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(flush, REFRESH_DEBOUNCE_MS)
  }
  const flush = (): void => {
    timer = null
    const changed = pending
    pending = []
    void enqueue(async () => {
      const state = deps.getState()
      const sheetId = state?.file.sheets[0]?.id
      if (!state || state.file.largeTable === undefined || sheetId === undefined) return
      // the edited rows of row-local formulas first, then the formulas that
      // read whole columns (running totals, SUMIF, lookups)
      const started = performance.now()
      for (const quick of [true, false]) {
        const result = await window.desktopApi.largeTableCalc({
          action: 'refresh',
          sessionId: state.file.sessionId,
          changed,
          edits: largeTableJournalEdits(state, sheetId),
          quick,
        })
        if (!result.ok) {
          deps.notify(largeTableCalcMessage(result.code, result.detail), 'error')
          return
        }
        if (deps.getState() !== state) return
        if (result.refreshed.length > 0) await repaintColumns(deps, state, result.refreshed)
        if (quick && result.pending !== true) return
        if (quick) deps.status?.(t('appLargeTableCalcRefreshing'))
      }
      const seconds = ((performance.now() - started) / 1000).toLocaleString(undefined, {
        maximumFractionDigits: 1,
      })
      deps.status?.(t('appLargeTableCalcRefreshed', { seconds }))
    })
  }
  const subscription = deps.runtime.univerAPI.onCommandExecuted(
    (command: { id?: string; params?: unknown }) => {
      if (command.id !== SET_RANGE_VALUES_MUTATION && command.id !== BULK_FILL_UNDO_COMMAND_ID) {
        return
      }
      // the loader and this module's own repaints write under suppression
      if (journalSuppression.active) return
      const state = deps.getState()
      if (!state || state.file.largeTable === undefined) return
      const params = command.params as { subUnitId?: string } | undefined
      if (params?.subUnitId !== undefined && params.subUnitId !== state.file.sheets[0]?.id) return
      const span = mutationSpan(command.id, command.params)
      if (span === null) return
      scheduleRefresh?.(span)
    },
  )
  return {
    dispose() {
      if (typeof formulaCheck === 'function') permission._permissionCheckWithFormula = formulaCheck
      registration.dispose()
      subscription.dispose()
      scheduleRefresh = null
      if (timer !== null) clearTimeout(timer)
    },
  }
}

/// A selection as the clear path takes it: whole-row/column picks reach far
/// past the base; they are clamped to it.
export interface ClearRange {
  readonly startRow: number
  readonly endRow: number
  readonly startColumn: number
  readonly endColumn: number
}

/// The fills and calculated columns a clear of `ranges` turns into: a
/// calculated column whose every formula row is selected is turned off as a
/// whole (Excel: deleting a table's calculated column); every other selected
/// cell of the base takes an empty constant fill.
export function planLargeTableClear(
  ranges: readonly ClearRange[],
  rows: number,
  columns: number,
  calcs: readonly { calcId: string; column: number; firstRow: number; lastRow: number }[],
): { fills: ClearRange[]; calcIds: string[] } {
  const fills: ClearRange[] = []
  const calcIds = new Set<string>()
  for (const range of ranges) {
    const startRow = Math.max(0, range.startRow)
    const endRow = Math.min(rows - 1, range.endRow)
    const startColumn = Math.max(0, range.startColumn)
    const endColumn = Math.min(columns - 1, range.endColumn)
    if (startRow > endRow || startColumn > endColumn) continue
    let runStart: number | null = null
    const flush = (end: number) => {
      if (runStart !== null) fills.push({ startRow, endRow, startColumn: runStart, endColumn: end })
      runStart = null
    }
    for (let column = startColumn; column <= endColumn; column += 1) {
      const calc = calcs.find(
        (candidate) =>
          candidate.column === column &&
          startRow <= candidate.firstRow &&
          endRow >= candidate.lastRow,
      )
      if (calc === undefined) {
        runStart ??= column
        continue
      }
      flush(column - 1)
      calcIds.add(calc.calcId)
      // the rest of the column (its header) still clears
      if (startRow < calc.firstRow) {
        fills.push({ startRow, endRow: calc.firstRow - 1, startColumn: column, endColumn: column })
      }
      if (endRow > calc.lastRow) {
        fills.push({ startRow: calc.lastRow + 1, endRow, startColumn: column, endColumn: column })
      }
    }
    flush(endColumn)
  }
  return { fills, calcIds: [...calcIds] }
}

/// Delete / Clear contents on a large base: one journal fill per area and
/// whole calculated columns turned off, in one undo step. The grid never
/// writes the cleared cells one by one (a million-row column took seconds to
/// clear and a minute to undo, and the undo only knew the resident rows).
export function clearLargeTableSelection(
  deps: LargeTableCalcDeps,
  ranges: readonly ClearRange[],
): Promise<void> {
  return enqueue(async () => {
    const state = deps.getState()
    const sheet = state?.file.sheets[0]
    const large = state?.file.largeTable
    if (!state || !sheet || large === undefined) return
    const sheetId = sheet.id
    const listed = await window.desktopApi.largeTableCalc({
      action: 'list',
      sessionId: state.file.sessionId,
    })
    if (!listed.ok) {
      deps.notify(largeTableCalcMessage(listed.code, listed.detail), 'error')
      return
    }
    const plan = planLargeTableClear(
      ranges,
      large.rows,
      sheet.columnCount,
      (listed.calcs ?? []).filter((calc) => calc.active),
    )
    if (plan.fills.length === 0 && plan.calcIds.length === 0) return
    let records = plan.fills.map((fill) =>
      recordBulkConstantFill(state.editJournal, { sheetId, ...fill, value: null }),
    )
    const setCalcs = async (active: boolean): Promise<number[]> => {
      const repaint: number[] = []
      for (const calcId of plan.calcIds) {
        const current = deps.getState()
        if (!current) break
        const result = await window.desktopApi.largeTableCalc({
          action: 'set-active',
          sessionId: current.file.sessionId,
          calcId,
          active,
          edits: largeTableJournalEdits(current, sheetId),
        })
        if (!result.ok) {
          deps.notify(largeTableCalcMessage(result.code, result.detail), 'error')
          break
        }
        repaint.push(...result.refreshed)
      }
      return repaint
    }
    const settle = async (extra: readonly number[]): Promise<void> => {
      const current = deps.getState()
      if (!current) return
      if (plan.calcIds.length > 0) current.editJournal.engineChanges.count += 1
      deps.journalChanged?.()
      const columns = new Set<number>(extra)
      for (const fill of plan.fills) {
        for (let column = fill.startColumn; column <= fill.endColumn; column += 1) {
          columns.add(column)
        }
        scheduleRefresh?.(fill)
      }
      await repaintColumns(deps, current, [...columns])
    }
    await settle(await setCalcs(false))
    pushVisualUndo(deps.runtime, {
      undo: () => {
        void enqueue(async () => {
          const current = deps.getState()
          if (!current) return
          for (const record of [...records].reverse()) {
            removeBulkConstantFill(current.editJournal, record.fill)
            restoreJournalCells(current.editJournal, sheetId, record.purgedCells)
          }
          await settle(await setCalcs(true))
        })
      },
      redo: () => {
        void enqueue(async () => {
          const current = deps.getState()
          if (!current) return
          records = records.map((record) =>
            recordBulkConstantFill(current.editJournal, record.fill),
          )
          await settle(await setCalcs(false))
        })
      },
    })
  })
}
