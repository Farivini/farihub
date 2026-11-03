/**
 * Read-only workbook views for the AI skill layer (read_cells, read_formats,
 * sheet feature reports, and the active-sheet context block). Extracted from
 * App.tsx; the App component wires these into SheetsSkillDeps with a
 * WorkbookReadContext closing over its refs.
 */
import type { IRange } from '@univerjs/core'
import { columnLabel, parseAddress } from '@genoffice/xlsx-gateway/domain/cell-address'
import { MAX_PATCH_ENTRY_BYTES } from '../../shared/desktop-api'
import type { InMemoryWorkbookAdapter } from '@genoffice/xlsx-gateway/domain/in-memory-workbook'
import type { CellFormatState, CellScalar } from '@genoffice/xlsx-gateway/domain/workbook.types'
import { planFileTableRegistrations } from '../file-tables'
import { toSelectionFormat } from '../selection-format'
import { lazyCellReader } from '../univer-sync'
import { plainCellValue } from '../edit-journal'
import { indexedFormulaText } from '../formula-view'
import { lazySheetScreenExtent, type LazyWorkbookState, type UniverRuntime } from '../univer-state'
import type { ActiveSheetInfo, FrozenSelection } from './tools'
import { NO_REDACTIONS, placeholderSource, type RedactionIndex } from './redact'

/** The App refs the readers need; passed per call so they never go stale. */
export interface WorkbookReadContext {
  univerRef: { readonly current: UniverRuntime | null }
  lazyWorkbookRef: { readonly current: LazyWorkbookState | null }
  adapterRef: { readonly current: InMemoryWorkbookAdapter }
  /**
   * The cells the reader withheld from the model. Optional so a workbook that
   * hides nothing costs nothing: `redactionsOf` falls back to NO_REDACTIONS and
   * every reader below behaves exactly as it did before the feature existed.
   */
  redactionIndexRef?: { readonly current: RedactionIndex | null } | undefined
}

/// The workbook's withheld cells, or the shared "nothing withheld" index.
export function redactionsOf(ctx: WorkbookReadContext): RedactionIndex {
  return ctx.redactionIndexRef?.current ?? NO_REDACTIONS
}

/// Feature-state report for the AI: what already exists before it edits.
/// Each section is independent so one facade failure never hides the rest.
export function readSheetFeatures(ctx: WorkbookReadContext, sheetIdInput?: string): string {
  const workbook = ctx.univerRef.current?.univerAPI.getActiveWorkbook()
  if (!workbook) return 'No workbook is currently open.'
  const worksheet =
    sheetIdInput === undefined
      ? workbook.getActiveSheet()
      : workbook.getSheetBySheetId(sheetIdInput)
  if (!worksheet) return `Unknown sheet: ${sheetIdInput}`
  const sheetId = worksheet.getSheetId()
  const redactions = redactionsOf(ctx)
  const state = ctx.lazyWorkbookRef.current
  const a1 = (range: IRange): string =>
    `${columnLabel(range.startColumn)}${range.startRow + 1}:${columnLabel(range.endColumn)}${range.endRow + 1}`
  const lines: string[] = [`Feature state of sheet ${worksheet.getSheetName()} (id=${sheetId}):`]

  const fileMeta = state?.file.sheets.find((sheet) => sheet.id === sheetId)
  const hidden = state?.editJournal.sheets.hidden.get(sheetId) ?? fileMeta?.hidden ?? false
  const isProtected =
    state?.editJournal.sheetProtection.get(sheetId) ??
    state?.sheetProtections.get(sheetId)?.protected ??
    false
  const status = [
    fileMeta?.veryHidden ? 'veryHidden (cannot be unhidden)' : hidden ? 'hidden' : 'visible',
    isProtected ? 'protected' : 'unprotected',
  ]
  try {
    const freeze = worksheet.getFreeze()
    if (freeze.ySplit > 0 || freeze.xSplit > 0) {
      status.push(`frozen: first ${freeze.ySplit} row(s), ${freeze.xSplit} column(s)`)
    }
  } catch {
    // freeze state unavailable
  }
  lines.push(`Status: ${status.join(', ')}`)

  // AutoFilter/DV install from the file only once the sheet finishes
  // indexing (captureSheetFileState marks that by filling sheetProtections),
  // so until then the grid-backed sections below under-report.
  if (fileMeta && state && !state.sheetProtections.has(sheetId)) {
    lines.push(
      '⚠️ This sheet is still indexing: the AutoFilter / conditional formatting / data validation ' +
        'sections below may be missing rules that exist in the file. Do NOT modify or clear those ' +
        'features based on this read — retry after indexing completes.',
    )
  }

  const tableLines: string[] = []
  if (state) {
    for (const table of planFileTableRegistrations(state.file.sheets)) {
      if (table.sheetId !== sheetId) continue
      tableLines.push(
        `- ${table.tableName}: ${a1(table.range)} columns[${(table.columns ?? []).join(', ')}] (from file; structure read-only)`,
      )
    }
    for (const table of state.editJournal.tableAdds) {
      if (table.sheetId !== sheetId) continue
      tableLines.push(
        `- ${table.name}: ${a1(table.area)} columns[${table.columnNames.join(', ')}] (added this session)`,
      )
    }
  }
  if (tableLines.length > 0) {
    lines.push('Tables (formulas may use TableName[Column] with this exact casing):', ...tableLines)
  }

  if (fileMeta && fileMeta.pivotTables.length > 0) {
    lines.push(
      `Pivot tables: ${fileMeta.pivotTables.length} (output region read-only; recompute from source data with refresh_pivot):`,
    )
    for (const pivot of fileMeta.pivotTables) {
      const definition = state?.pivotDefinitions.get(pivot.path)
      if (!definition) {
        lines.push(`- ${pivot.outputRef}: definition not loaded`)
        continue
      }
      const rows = definition.rowFields
        .filter((field) => field >= 0)
        .map((field) => definition.fields[field]?.name)
        .filter(Boolean)
      const cols = definition.colFields
        .filter((field) => field >= 0)
        .map((field) => definition.fields[field]?.name)
        .filter(Boolean)
      const values = definition.dataFields.map((dataField) => dataField.name)
      lines.push(
        `- ${pivot.outputRef}: rows[${rows.join(',')}] cols[${cols.join(',')}] values[${values.join(',')}]` +
          ` source=${definition.sourceSheet}!${definition.sourceRef}` +
          (definition.unsupported.length > 0
            ? ` (recompute unsupported: ${definition.unsupported.join('; ')})`
            : ' (recomputable)'),
      )
    }
  } else if (fileMeta && fileMeta.pivotRanges.length > 0) {
    lines.push(
      `Pivot table output regions (read-only, writes are rejected): ${fileMeta.pivotRanges.map(a1).join(', ')}`,
    )
  }

  try {
    const filter = worksheet.getFilter()
    if (filter) {
      const bounds = filter.getRange().getRange()
      const criteria: string[] = []
      for (let column = bounds.startColumn; column <= bounds.endColumn; column += 1) {
        const columnCriteria = filter.getColumnFilterCriteria(column)
        if (!columnCriteria) continue
        const values = (columnCriteria.filters?.filters ?? []) as string[]
        criteria.push(
          values.length > 0
            ? `${columnLabel(column)} keeps [${values.slice(0, 10).join(', ')}${values.length > 10 ? ', …' : ''}]`
            : `${columnLabel(column)} has custom criteria`,
        )
      }
      lines.push(
        `AutoFilter: ${a1(bounds)}${criteria.length > 0 ? `;${criteria.join(';')}` : ' (no column criteria)'}`,
      )
    } else {
      lines.push('AutoFilter: none')
    }
  } catch {
    lines.push('AutoFilter: read failed')
  }

  try {
    const rules = worksheet.getConditionalFormattingRules()
    if (rules.length === 0) {
      lines.push('Conditional formatting: none')
    } else {
      lines.push(
        `Conditional formatting: ${rules.length} rule(s) (clear_conditional_formats removes them all):`,
      )
      for (const rule of rules.slice(0, 20)) {
        const detail = rule.rule as unknown as Record<string, unknown>
        const summary = ['type', 'subType', 'operator', 'value']
          .filter((key) => detail[key] !== undefined)
          .map((key) => `${key}=${JSON.stringify(detail[key])}`)
          .join(' ')
        lines.push(`- ${(rule.ranges ?? []).map(a1).join(',')}: ${summary}`)
      }
      if (rules.length > 20) lines.push(`- …${rules.length - 20} more`)
    }
  } catch {
    lines.push('Conditional formatting: read failed')
  }

  try {
    const validations = worksheet.getDataValidations()
    if (validations.length === 0) {
      lines.push('Data validation: none')
    } else {
      lines.push(`Data validation: ${validations.length} rule(s):`)
      for (const validation of validations.slice(0, 20)) {
        const rangeList = validation.getRanges()
        const ranges = rangeList.map((range) => range.getA1Notation()).join(',')
        const rule = validation.rule
        // A validation formula can carry the value itself — `cellIs equal
        // "13800138000"` is a rule that stores the secret. The rule still has
        // to be reported (the model must not break it), but on a range holding
        // withheld cells the formulas are dropped: their shape is the only part
        // that is not the reader's data.
        const covered = redactions.isEmpty
          ? false
          : rangeList.some((range) =>
              redactions
                .marksFor(sheetId)
                .some(
                  (mark) =>
                    mark.startRow <= range.getLastRow() &&
                    mark.endRow >= range.getRow() &&
                    mark.startColumn <= range.getLastColumn() &&
                    mark.endColumn >= range.getColumn(),
                ),
            )
        const parts = [rule.type, rule.operator, rule.formula1, rule.formula2].filter(
          (part) => part !== undefined && part !== '',
        )
        lines.push(
          covered
            ? `- ${ranges}: ${[rule.type, rule.operator, '(withheld)'].filter(Boolean).join(' ')}`
            : `- ${ranges}: ${parts.join(' ')}`,
        )
      }
    }
  } catch {
    lines.push('Data validation: read failed')
  }

  try {
    const names = workbook.getDefinedNames()
    lines.push(
      names.length === 0
        ? 'Defined names: none'
        : `Defined names: ${names
            .slice(0, 30)
            .map((name) => `${name.getName()} = ${name.getFormulaOrRefString()}`)
            .join('; ')}`,
    )
  } catch {
    lines.push('Defined names: read failed')
  }

  try {
    const notes = worksheet.getNotes()
    if (notes.length > 0) {
      lines.push(`Notes: ${notes.length}:`)
      for (const note of notes.slice(0, 20)) {
        // A note is cell-attached content, exactly like the cell's value, and
        // readers routinely write the same secret in both. Withholding the cell
        // without withholding its note would leak through the side door.
        const withheld = redactions.labelAt(sheetId, note.row, note.col)
        const text =
          withheld !== null
            ? placeholderSource(withheld)
            : note.note.length > 80
              ? `${note.note.slice(0, 80)}…`
              : note.note
        lines.push(`- ${columnLabel(note.col)}${note.row + 1}: ${text.replace(/\n/g, ' ')}`)
      }
    }
  } catch {
    // notes unavailable
  }

  if (state) {
    const visuals = [...state.file.visuals, ...state.editJournal.visualAdds].filter(
      (visual) => visual.sheetId === sheetId && visual.kind !== 'chart',
    )
    if (visuals.length > 0) {
      lines.push(`Shapes/images: ${visuals.length} (charts are listed in get_workbook_context):`)
      for (const visual of visuals.slice(0, 20)) {
        const origin = visual.id.startsWith('added-shape-')
          ? `id=${visual.id}, editable via edit_shape`
          : visual.id.startsWith('added-')
            ? 'added this session'
            : 'came with the file, not modifiable by the AI'
        const label =
          visual.kind === 'image'
            ? 'image'
            : visual.kind === 'ole'
              ? `embedded object ${visual.progId ?? ''}`
              : visual.kind === 'slicer'
                ? 'slicer'
                : `shape ${visual.shapeType ?? ''}`
        lines.push(
          `- ${label} @ ` +
            `${columnLabel(visual.anchor.fromColumn)}${visual.anchor.fromRow + 1}` +
            `${visual.text ? ` text "${visual.text}"` : ''} (${origin})`,
        )
      }
    }
    const pageSetup = state.editJournal.pageSetup.get(sheetId)
    if (pageSetup && Object.keys(pageSetup).length > 0) {
      lines.push(`Page setup pending save this session: ${JSON.stringify(pageSetup)}`)
    }
  }
  return lines.join('\n')
}

/// Explicit formatting only: cells whose merged style resolves to all
/// defaults are omitted, so the model sees a compact "what is styled" map.
export function readFormats(
  ctx: WorkbookReadContext,
  addresses: readonly string[],
  sheetId?: string,
): Record<string, CellFormatState> {
  const workbook = ctx.univerRef.current?.univerAPI.getActiveWorkbook()
  const worksheet =
    sheetId === undefined ? workbook?.getActiveSheet() : workbook?.getSheetBySheetId(sheetId)
  if (!worksheet) return {}
  const result: Record<string, CellFormatState> = {}
  for (const address of addresses) {
    const range = worksheet.getRange(address)
    let pattern = ''
    try {
      pattern = range.getNumberFormat()
    } catch {
      // number-format resolution can fail on never-touched cells; treat as General
    }
    const echo = toSelectionFormat(range.getCellStyleData() ?? {}, pattern)
    const format: Record<string, unknown> = {}
    if (echo.bold) format.bold = true
    if (echo.italic) format.italic = true
    if (echo.underline) format.underline = true
    if (echo.strike) format.strikethrough = true
    if (echo.fontFamily) format.fontFamily = echo.fontFamily
    if (echo.fontSize) format.fontSize = echo.fontSize
    if (echo.fontColor) format.fontColor = echo.fontColor
    if (echo.fillColor) format.fillColor = echo.fillColor
    if (echo.numberFormat && echo.numberFormat !== 'General')
      format.numberFormat = echo.numberFormat
    if (
      echo.horizontalAlignment === 'left' ||
      echo.horizontalAlignment === 'center' ||
      echo.horizontalAlignment === 'right'
    ) {
      format.horizontalAlign = echo.horizontalAlignment
    }
    if (
      echo.verticalAlignment === 'top' ||
      echo.verticalAlignment === 'center' ||
      echo.verticalAlignment === 'bottom'
    ) {
      format.verticalAlign = echo.verticalAlignment
    }
    if (echo.wrap) format.wrapText = true
    if (Object.keys(format).length > 0) result[address] = format as CellFormatState
  }
  return result
}

/**
 * `frozen` is the selection scope of the run in flight: `undefined` when no run
 * owns one (report the live grid selection), `null` when the user dropped the
 * scope off the composer chip, otherwise the send-time snapshot.
 */
export function getActiveSheetInfo(
  ctx: WorkbookReadContext,
  frozen?: FrozenSelection | null,
): ActiveSheetInfo {
  const workbook = ctx.univerRef.current?.univerAPI.getActiveWorkbook()
  const live = workbook?.getActiveRange()?.getA1Notation() ?? undefined
  // A frozen snapshot taken on another sheet has to carry its sheet name, or
  // the model reads a bare A1 as an address on whatever sheet is active now.
  const frozenLabel = frozen
    ? frozen.sheetId === workbook?.getActiveSheet()?.getSheetId()
      ? frozen.a1
      : `${workbook?.getSheetBySheetId(frozen.sheetId)?.getSheetName() ?? frozen.sheetId}!${frozen.a1}`
    : undefined
  const selection = frozen === undefined ? live : frozenLabel
  const frozenFields = frozenLabel
    ? {
        selectionFrozen: true,
        ...(frozen?.columns?.length ? { selectionColumns: frozen.columns } : {}),
      }
    : {}
  const state = ctx.lazyWorkbookRef.current
  if (state) {
    const worksheet = workbook?.getActiveSheet()
    if (!workbook || !worksheet)
      return { mode: 'none', sheetId: '', sheetName: '', knownAddresses: [], sheets: [] }
    const sheetId = worksheet.getSheetId()
    const loaded = state.loadedRanges.get(sheetId)
    const loadedRange = loaded
      ? `${columnLabel(loaded.startColumn)}${loaded.startRow + 1}:` +
        `${columnLabel(loaded.endColumn)}${loaded.endRow + 1}`
      : undefined
    return {
      mode: 'lazy',
      streaming: !state.formulaMode,
      sheetId,
      sheetName: worksheet.getSheetName(),
      knownAddresses: [],
      loadedRange,
      sheets: workbook.getSheets().map((sheet) => {
        const fileExtent = lazySheetScreenExtent(state, sheet.getSheetId())
        // File streaming bounds must stay file-sized, but the AI's data view
        // must also include columns/rows written since open. Otherwise a new
        // calculated column is immediately invisible to read_range/context.
        let rows = fileExtent?.rows ?? 0
        let columns = fileExtent?.columns ?? 0
        for (const entry of state.editJournal.cells?.get(sheet.getSheetId())?.values() ?? []) {
          if (!entry.formula && !(entry.hasValue && entry.value != null)) continue
          rows = Math.max(rows, entry.row + 1)
          columns = Math.max(columns, entry.column + 1)
        }
        for (const fill of state.editJournal.bulkConstantFills?.get(sheet.getSheetId()) ?? []) {
          if (fill.value == null) continue
          rows = Math.max(rows, fill.endRow + 1)
          columns = Math.max(columns, fill.endColumn + 1)
        }
        const extent = fileExtent || rows || columns ? { rows, columns } : null
        const meta = state.file.sheets.find((candidate) => candidate.id === sheet.getSheetId())
        const oversized = (meta?.sourceXmlBytes ?? 0) > MAX_PATCH_ENTRY_BYTES
        return {
          id: sheet.getSheetId(),
          name: sheet.getSheetName(),
          ...(extent ? { rows: extent.rows, columns: extent.columns } : {}),
          ...(oversized ? { readOnlyOversized: true } : {}),
        }
      }),
      selection,
      ...frozenFields,
      merges: worksheet.getMergedRanges().map((range) => range.getA1Notation()),
      // Session-added charts have no chart part yet; their visual id
      // doubles as the edit_chart path.
      charts: [...state.file.visuals, ...state.editJournal.visualAdds]
        .filter((visual) => visual.kind === 'chart' && (visual.chartPath || visual.chart))
        .map((visual) => ({
          path: visual.chartPath ?? visual.id,
          title: visual.chart?.title ?? '',
          types: visual.chart?.chartTypes.join('+') ?? '',
          sheetId: visual.sheetId,
        })),
    }
  }
  const snapshot = ctx.adapterRef.current.getSnapshot()
  // The adapter has no active-sheet notion — resolve it from the grid (demo
  // Univer sheets reuse the snapshot ids), falling back to the first sheet.
  const activeId = workbook?.getActiveSheet()?.getSheetId()
  const sheet = snapshot.sheets.find((entry) => entry.id === activeId) ?? snapshot.sheets[0]
  if (!sheet) return { mode: 'none', sheetId: '', sheetName: '', knownAddresses: [], sheets: [] }
  return {
    mode: 'demo',
    sheetId: sheet.id,
    sheetName: sheet.name,
    revision: snapshot.revision,
    knownAddresses: Object.keys(sheet.cells),
    sheets: snapshot.sheets.map((entry) => {
      let maxRow = -1
      let maxColumn = -1
      for (const address of Object.keys(entry.cells)) {
        const cell = parseAddress(address)
        if (cell.row > maxRow) maxRow = cell.row
        if (cell.column > maxColumn) maxColumn = cell.column
      }
      return {
        id: entry.id,
        name: entry.name,
        ...(maxRow >= 0 ? { rows: maxRow + 1, columns: maxColumn + 1 } : {}),
      }
    }),
    selection,
    ...frozenFields,
    merges: sheet.merges ?? [],
    charts: snapshot.sheets.flatMap((entry) =>
      (entry.visuals ?? []).map((visual) => ({
        path: visual.id,
        title: visual.chart.title,
        types: visual.chart.chartTypes.join('+'),
        sheetId: visual.sheetId,
      })),
    ),
  }
}

export function readCells(
  ctx: WorkbookReadContext,
  addresses: readonly string[],
  sheetId?: string,
): Record<string, { value: CellScalar; formula?: string; rawValue?: CellScalar | undefined }> {
  const result: Record<
    string,
    { value: CellScalar; formula?: string; rawValue?: CellScalar | undefined }
  > = {}
  const workbook = ctx.univerRef.current?.univerAPI.getActiveWorkbook()
  const state = ctx.lazyWorkbookRef.current
  const redactions = redactionsOf(ctx)
  if (state) {
    const worksheet =
      sheetId === undefined ? workbook?.getActiveSheet() : workbook?.getSheetBySheetId(sheetId)
    if (!worksheet) return result
    const targetId = sheetId ?? worksheet.getSheetId()
    // Bulk formula verification/save reads a whole calculated column locally.
    // Avoid constructing 10,000 range facades on every calculation poll. Shared
    // formulas/rich text retain the general reader below; writes from fill_range
    // have explicit f and si=null, so this fast path has identical provenance.
    if (addresses.length >= 256) {
      const first = parseAddress(addresses[0]!)
      const contiguous = addresses.every((address, index) => {
        const at = parseAddress(address)
        return at.column === first.column && at.row === first.row + index
      })
      if (contiguous) {
        const range = worksheet.getRange(first.row, first.column, addresses.length, 1)
        const raw = range.getCellDatas()
        if (
          raw.every((row) => typeof row[0]?.f === 'string' && row[0].f.length > 0) &&
          raw.length === addresses.length
        ) {
          const values = range.getValues()
          for (let index = 0; index < addresses.length; index += 1) {
            const address = addresses[index]!
            const withheld = redactions.labelAt(targetId, first.row + index, first.column)
            const cell = raw[index]![0]!
            result[address] =
              withheld !== null
                ? { value: placeholderSource(withheld) }
                : {
                    value: (values[index]?.[0] ?? null) as CellScalar,
                    formula: cell.f!,
                    rawValue: plainCellValue(cell.v, cell.t) as CellScalar | undefined,
                  }
          }
          return result
        }
      }
    }
    const reader = lazyCellReader(worksheet)
    for (const address of addresses) {
      // All three fields, not just the rendered value: `formula` is the cell's
      // own text and `rawValue` the model value behind it, so projecting only
      // `value` would hand over the very number the reader hid.
      const withheld = redactions.labelAt(
        targetId,
        parseAddress(address).row,
        parseAddress(address).column,
      )
      if (withheld !== null) {
        result[address] = { value: placeholderSource(withheld) }
        continue
      }
      const cell = reader(address)
      const at = parseAddress(address)
      // Cache-only imported cells deliberately have no grid f. Their original
      // formula still belongs in the AI view; the index rejects overwritten
      // cells and unreliable coordinates after structural changes.
      const formula =
        cell.formula ||
        (state.formulaText && indexedFormulaText(state, targetId, at.row, at.column))
      // `value` is the rendered text and `rawValue` the model value behind it;
      // machine-facing callers (the MCP bridge, the save pipeline) need the
      // latter — see modelCellValue in univer-sync.ts.
      result[address] = formula
        ? { value: cell.value, formula, rawValue: cell.rawValue }
        : { value: cell.value, rawValue: cell.rawValue }
    }
    return result
  }
  const sheets = ctx.adapterRef.current.getSnapshot().sheets
  const targetId = sheetId ?? workbook?.getActiveSheet()?.getSheetId()
  const sheet =
    sheets.find((s) => s.id === targetId) ?? (sheetId === undefined ? sheets[0] : undefined)
  if (!sheet) return result
  // The in-memory model stores only value:null for formula cells; computed
  // values live in Univer's formula engine, backfilled by reading the grid
  const worksheet =
    sheetId === undefined ? workbook?.getActiveSheet() : workbook?.getSheetBySheetId(sheetId)
  for (const address of addresses) {
    const position = parseAddress(address)
    const withheld = redactions.labelAt(sheet.id, position.row, position.column)
    if (withheld !== null) {
      result[address] = { value: placeholderSource(withheld) }
      continue
    }
    const cell = sheet.cells[address] ?? { value: null }
    if (cell.formula) {
      let computed = cell.value
      if (computed === null && worksheet) {
        try {
          computed = worksheet.getRange(address).getValue() ?? null
        } catch {
          /* fail-open */
        }
      }
      result[address] = { value: computed, formula: cell.formula }
    } else {
      result[address] = { value: cell.value }
    }
  }
  return result
}
