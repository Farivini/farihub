/**
 * Univer rebuilds every header "unhide" arrow (one shape per hidden run, each
 * disposal scheduling its own MessageChannel task) on every skeleton change.
 * A streamed load of a filtered sheet with a thousand hidden runs therefore
 * paid a full rebuild per chunk. Coalesce the rebuilds so a burst of skeleton
 * changes ends in one.
 */
import { SheetSkeleton } from '@univerjs/core'
import { HeaderUnhideRenderController } from '@univerjs/sheets-ui'

const HEADER_UNHIDE_SETTLE_MS = 120

let installed = false

export function installHeaderUnhideDebounce(): void {
  if (installed) return
  installed = true
  const proto = HeaderUnhideRenderController.prototype as any
  const origUpdate = proto._update
  const pending = new WeakMap<object, ReturnType<typeof setTimeout>>()
  proto._update = function (workbook: unknown, worksheet: unknown) {
    const timer = pending.get(this)
    if (timer !== undefined) clearTimeout(timer)
    pending.set(
      this,
      setTimeout(() => {
        pending.delete(this)
        if (this._disposed) return
        origUpdate.call(this, workbook, worksheet)
      }, HEADER_UNHIDE_SETTLE_MS),
    )
  }
}

/**
 * Univer's sheet layout asks every row "is it filtered?" (getRowFiltered) when
 * it builds the row-height table, and the sheets-table plugin answers through
 * TableFilterController._getTableFilteredOutRows, which builds a
 * `${unitId}|${subUnitId}` key and allocates an empty Set on every call when
 * the sheet has no table filter. On a 1,048,568-row base that alone held the
 * renderer ~500 ms at open. The fast path below reuses the key for repeated
 * calls on the same sheet and answers with one shared empty Set, so a sheet
 * without table filters costs a map lookup per row. Callers only read the
 * Set (`has`).
 *
 * The controller is not exported, so its instance is found in the injector by
 * shape; when Univer changes it the patch quietly does nothing.
 */
const EMPTY_FILTERED_ROWS: ReadonlySet<number> = new Set<number>()
const PATCHED = Symbol('fariv.tableFilterFastPath')

interface TableFilterControllerShape {
  _tableFilteredOutRows: Map<string, Set<number>>
  _getTableFilteredOutRows(unitId: string, subUnitId: string): ReadonlySet<number>
  _getSheetKey(unitId: string, subUnitId: string): string
  [PATCHED]?: true
}

function isTableFilterController(value: unknown): value is TableFilterControllerShape {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<TableFilterControllerShape>
  return (
    candidate._tableFilteredOutRows instanceof Map &&
    typeof candidate._getTableFilteredOutRows === 'function' &&
    typeof candidate._getSheetKey === 'function'
  )
}

let tableFilterController: TableFilterControllerShape | null = null

/** true when a table filter hides rows on the sheet (unknown controller: assume so) */
export function tableFilterHidesRows(unitId: string, subUnitId: string): boolean {
  if (tableFilterController === null) return true
  const rows = tableFilterController._tableFilteredOutRows.get(
    tableFilterController._getSheetKey(unitId, subUnitId),
  )
  return rows !== undefined && rows.size > 0
}

export function installTableFilterFastPath(injector: unknown): boolean {
  const resolved = (
    injector as {
      resolvedDependencyCollection?: { resolvedDependencies?: Map<unknown, unknown[]> }
    }
  )?.resolvedDependencyCollection?.resolvedDependencies
  if (!(resolved instanceof Map)) return false
  for (const instances of resolved.values()) {
    for (const instance of Array.isArray(instances) ? instances : [instances]) {
      if (!isTableFilterController(instance) || instance[PATCHED]) continue
      let lastUnit: string | undefined
      let lastSubUnit: string | undefined
      let lastKey = ''
      instance._getTableFilteredOutRows = function (unitId: string, subUnitId: string) {
        if (unitId !== lastUnit || subUnitId !== lastSubUnit) {
          lastUnit = unitId
          lastSubUnit = subUnitId
          lastKey = this._getSheetKey(unitId, subUnitId)
        }
        return this._tableFilteredOutRows.get(lastKey) ?? EMPTY_FILTERED_ROWS
      }
      instance[PATCHED] = true
      tableFilterController = instance
      return true
    }
  }
  return false
}

/**
 * The same row-height pass still runs Univer's whole "is this row filtered?"
 * interceptor chain once per row: ~250 ms on a million rows. A sheet that
 * cannot have filtered rows skips the chain: `canSkip` answers for a sheet
 * (the host checks that it is a read-only large base with no sheet filter and
 * no table filter), and only then the pass runs with getRowFiltered = false,
 * which is exactly what the chain would have answered for every row.
 */
let rowFilterSkipInstalled = false

export function installRowFilterSkip(
  canSkip: (unitId: string, subUnitId: string) => boolean,
): void {
  if (rowFilterSkipInstalled) return
  rowFilterSkipInstalled = true
  const proto = SheetSkeleton.prototype as any
  const original = proto._generateRowMatrixCache
  if (typeof original !== 'function') return
  proto._generateRowMatrixCache = function (...args: unknown[]) {
    const worksheet = this.worksheet
    if (!worksheet || !canSkip(worksheet.getUnitId(), worksheet.getSheetId())) {
      return original.apply(this, args)
    }
    const own = Object.prototype.hasOwnProperty.call(worksheet, 'getRowFiltered')
    const saved = worksheet.getRowFiltered
    worksheet.getRowFiltered = () => false
    try {
      return original.apply(this, args)
    } finally {
      if (own) worksheet.getRowFiltered = saved
      else delete worksheet.getRowFiltered
    }
  }
}
