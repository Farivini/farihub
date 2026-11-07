/**
 * Pivot of a large base (Etapa B): the Fields pane's layout model becomes a
 * data-engine query, and the engine's answer becomes the table the view
 * shows, copies and saves. Pure functions; the view (LargePivotView) only
 * renders them.
 *
 * Layout: Excel's tabular form without subtotals. One label column per row
 * field; per column-field member one block of value columns; a Grand Total
 * block and a Grand Total row. "Show values as" % of grand total / row / column
 * are worked out here from the engine's totals (a distinct count or an average
 * total is aggregated from the rows by the engine, never summed here).
 */
import type {
  LargeTablePivotAgg,
  LargeTablePivotGroup,
  LargeTablePivotResult,
} from '../shared/desktop-api'
import type { PivotField, PivotLayoutModel } from './pivot-field-model'

export interface LargePivotField extends PivotField {
  /// most sample values read as dates: grouped by day unless grouped coarser
  readonly date?: boolean
}

export interface LargePivotQuery {
  readonly rows: { column: number; group: LargeTablePivotGroup }[]
  readonly columns: { column: number; group: LargeTablePivotGroup }[]
  readonly filters: { column: number; group: LargeTablePivotGroup; include: string[] }[]
  readonly values: { column: number; agg: LargeTablePivotAgg }[]
}

export type ShowAs = '' | 'percentOfTotal' | 'percentOfRow' | 'percentOfCol'

/// What the engine does not do yet, named so the view can say it.
export type LargePivotGap =
  | { readonly kind: 'rangeGroup' }
  | { readonly kind: 'labelFilter' }
  | { readonly kind: 'valueFilter' }
  | { readonly kind: 'calcField' }
  | { readonly kind: 'agg'; readonly agg: string }
  | { readonly kind: 'showAs'; readonly mode: string }

const ENGINE_AGGS = new Set<string>(['sum', 'count', 'countDistinct', 'average', 'min', 'max'])
const ENGINE_SHOW_AS = new Set<string>(['', 'percentOfTotal', 'percentOfRow', 'percentOfCol'])

function groupOf(model: PivotLayoutModel, field: LargePivotField | undefined, index: number) {
  const grouping = model.groupings[index]
  if (grouping?.kind === 'date') return grouping.dateUnit as LargeTablePivotGroup
  return field?.date === true ? 'day' : 'none'
}

/// The engine query of a layout, or what keeps it from running.
export function largePivotQuery(
  model: PivotLayoutModel,
  fields: readonly LargePivotField[],
): { query: LargePivotQuery; showAs: ShowAs[] } | { gap: LargePivotGap } {
  for (const [index, grouping] of Object.entries(model.groupings)) {
    const used = model.rows.includes(Number(index)) || model.columns.includes(Number(index))
    if (used && grouping.kind === 'range') return { gap: { kind: 'rangeGroup' } }
  }
  if (Object.keys(model.labelFilters).length > 0) return { gap: { kind: 'labelFilter' } }
  for (const value of model.values) {
    if (value.formula !== undefined || value.fieldIndex < 0) return { gap: { kind: 'calcField' } }
    if (value.filter !== undefined) return { gap: { kind: 'valueFilter' } }
    if (!ENGINE_AGGS.has(value.agg)) return { gap: { kind: 'agg', agg: value.agg } }
    if (!ENGINE_SHOW_AS.has(value.showDataAs ?? ''))
      return { gap: { kind: 'showAs', mode: value.showDataAs ?? '' } }
  }
  const dim = (index: number) => ({
    column: fields[index]?.colIndex ?? index,
    group: groupOf(model, fields[index], index),
  })
  return {
    query: {
      rows: model.rows.map(dim),
      columns: model.columns.map(dim),
      filters: model.filters
        .filter((filter) => filter.item !== null)
        .map((filter) => ({ ...dim(filter.fieldIndex), include: [filter.item!] })),
      values: model.values.map((value) => ({
        column: fields[value.fieldIndex]?.colIndex ?? value.fieldIndex,
        agg: value.agg as LargeTablePivotAgg,
      })),
    },
    showAs: model.values.map((value) => (value.showDataAs ?? '') as ShowAs),
  }
}

/// A label as the view shows it: ISO dates in the reader's order, the
/// blank as "(blank)".
export function displayLabel(
  label: string,
  group: LargeTablePivotGroup,
  dayFirst: boolean,
  blank: string,
): string {
  if (label === '') return blank
  if (group === 'day') {
    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(label)
    if (day) return dayFirst ? `${day[3]}/${day[2]}/${day[1]}` : label
  }
  if (group === 'month') {
    const month = /^(\d{4})-(\d{2})$/.exec(label)
    if (month) return dayFirst ? `${month[2]}/${month[1]}` : label
  }
  if (group === 'quarter') {
    const quarter = /^(\d{4})-T(\d)$/.exec(label)
    if (quarter) return dayFirst ? `T${quarter[2]}/${quarter[1]}` : `${quarter[1]} Q${quarter[2]}`
  }
  return label
}

export interface PivotCell {
  readonly text?: string
  readonly value?: number | null
  readonly percent?: boolean
  readonly total?: boolean
  readonly span?: number
}

export interface PivotTable {
  /// header rows (cells may span columns)
  readonly head: PivotCell[][]
  readonly body: PivotCell[][]
  readonly foot: PivotCell[]
  /// row labels and the first value per row (chart, Pareto)
  readonly series: { label: string; value: number | null }[]
  readonly labelColumns: number
}

export interface TableTexts {
  readonly rowFieldNames: readonly string[]
  readonly valueCaptions: readonly string[]
  readonly grandTotal: string
  readonly blank: string
  readonly share: string
  readonly cumulative: string
  readonly abcClass: string
  readonly dayFirst: boolean
}

type Raw = number | null

function ratio(value: Raw, base: Raw): Raw {
  if (value === null || base === null || base === 0) return null
  return value / base
}

/// The table of an engine answer: labels, value blocks, totals, "show values
/// as", and with `pareto` the rows sorted by their first value with share,
/// cumulative share and ABC class (A up to 80% cumulative, B up to 95%, C
/// the rest; the first row is always A).
export function buildPivotTable(
  result: LargeTablePivotResult,
  query: LargePivotQuery,
  showAs: readonly ShowAs[],
  texts: TableTexts,
  pareto: boolean,
): PivotTable {
  const nv = query.values.length
  const byColumns = query.columns.length > 0
  const grand = result.grandTotal
  const shown = (raw: Raw, i: number, rowTotal: Raw, colTotal: Raw): PivotCell => {
    switch (showAs[i] ?? '') {
      case 'percentOfTotal':
        return { value: ratio(raw, grand[i] ?? null), percent: true }
      case 'percentOfRow':
        return { value: ratio(raw, rowTotal), percent: true }
      case 'percentOfCol':
        return { value: ratio(raw, colTotal), percent: true }
      default:
        return { value: raw }
    }
  }
  const labelColumns = Math.max(1, query.rows.length)
  const head: PivotCell[][] = []
  const names =
    query.rows.length > 0 ? texts.rowFieldNames.map((text) => ({ text })) : [{ text: '' }]
  if (byColumns) {
    head.push([
      ...names.map(() => ({ text: '' })),
      ...result.columns.map((column) => ({
        text: column.labels
          .map((label, level) =>
            displayLabel(label, query.columns[level]!.group, texts.dayFirst, texts.blank),
          )
          .join(' · '),
        span: nv,
      })),
      { text: texts.grandTotal, span: nv, total: true },
    ])
    head.push([
      ...names,
      ...result.columns.flatMap(() => texts.valueCaptions.map((text) => ({ text }))),
      ...texts.valueCaptions.map((text) => ({ text, total: true })),
    ])
  } else {
    head.push([
      ...names,
      ...texts.valueCaptions.map((text) => ({ text })),
      ...(pareto
        ? [{ text: texts.share }, { text: texts.cumulative }, { text: texts.abcClass }]
        : []),
    ])
  }
  let rows = result.rows.map((row) => ({ row, first: (row.total[0] ?? null) as Raw }))
  if (pareto) {
    rows = [...rows].sort((a, b) => {
      if (a.first === null) return b.first === null ? 0 : 1
      if (b.first === null) return -1
      return b.first - a.first
    })
  }
  let cumulative = 0
  // a Pareto's shares divide by the sum of the rows (every row, not only the
  // ones returned); a distinct count's rows add up past its grand total
  const firstGrand = (result.firstValueSum ?? grand[0] ?? null) as Raw
  const body = rows.map(({ row, first }) => {
    const labels: PivotCell[] =
      query.rows.length > 0
        ? row.labels.map((label, level) => ({
            text: displayLabel(label, query.rows[level]!.group, texts.dayFirst, texts.blank),
          }))
        : [{ text: texts.grandTotal, total: true }]
    const cells: PivotCell[] = []
    if (byColumns) {
      row.cells.forEach((cell, c) => {
        for (let i = 0; i < nv; i += 1) {
          cells.push(
            shown(
              (cell?.[i] ?? null) as Raw,
              i,
              (row.total[i] ?? null) as Raw,
              (result.columns[c]?.total[i] ?? null) as Raw,
            ),
          )
        }
      })
    }
    for (let i = 0; i < nv; i += 1) {
      const raw = (row.total[i] ?? null) as Raw
      cells.push({ ...shown(raw, i, raw, (grand[i] ?? null) as Raw), total: byColumns })
    }
    if (pareto && !byColumns) {
      const share = ratio(first, firstGrand)
      // the running total over the grand total, not a sum of shares (no drift)
      const firstRow = cumulative === 0
      cumulative += first ?? 0
      const upTo = ratio(cumulative, firstGrand)
      const abc =
        share === null || upTo === null
          ? ''
          : firstRow || upTo <= 0.8 + 1e-9
            ? 'A'
            : upTo <= 0.95 + 1e-9
              ? 'B'
              : 'C'
      cells.push(
        { value: share, percent: true },
        { value: share === null ? null : upTo, percent: true },
        { text: abc },
      )
    }
    return [...labels, ...cells]
  })
  // without row fields the only row is the grand total already
  if (query.rows.length === 0) {
    return { head, body, foot: [], series: [], labelColumns }
  }
  const foot: PivotCell[] = [
    { text: texts.grandTotal, total: true },
    ...Array.from({ length: labelColumns - 1 }, () => ({ text: '', total: true })),
  ]
  if (byColumns) {
    result.columns.forEach((column) => {
      for (let i = 0; i < nv; i += 1) {
        const raw = (column.total[i] ?? null) as Raw
        foot.push({ ...shown(raw, i, (grand[i] ?? null) as Raw, raw), total: true })
      }
    })
  }
  for (let i = 0; i < nv; i += 1) {
    const raw = (grand[i] ?? null) as Raw
    foot.push({ ...shown(raw, i, raw, raw), total: true })
  }
  if (pareto && !byColumns) {
    foot.push(
      { value: firstGrand === null ? null : 1, percent: true, total: true },
      { text: '', total: true },
      { text: '', total: true },
    )
  }
  const series = rows.map(({ row, first }) => ({
    label:
      query.rows.length > 0
        ? row.labels
            .map((label, level) =>
              displayLabel(label, query.rows[level]!.group, texts.dayFirst, texts.blank),
            )
            .join(' · ')
        : texts.grandTotal,
    value: first,
  }))
  return { head, body, foot, series, labelColumns }
}

/// The table as delimited text (Copy: tabs; Save: the locale's CSV), every
/// row, numbers plain with the given decimal mark, spans written out.
export function pivotTableText(table: PivotTable, delimiter: string, decimal: ',' | '.'): string {
  const field = (cell: PivotCell): string => {
    let text: string
    if (cell.text !== undefined) text = cell.text
    else if (cell.value === null || cell.value === undefined) text = ''
    else {
      const value = cell.percent === true ? cell.value * 100 : cell.value
      text = String(Number(value.toPrecision(15)))
      if (decimal === ',') text = text.replace('.', ',')
      if (cell.percent === true) text += '%'
    }
    return /["\n\r]/.test(text) || text.includes(delimiter) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const line = (cells: readonly PivotCell[]): string =>
    cells
      .flatMap((cell) => [field(cell), ...Array.from({ length: (cell.span ?? 1) - 1 }, () => '')])
      .join(delimiter)
  const rows =
    table.foot.length > 0
      ? [...table.head, ...table.body, table.foot]
      : [...table.head, ...table.body]
  return rows.map(line).join('\r\n')
}

/// Whether text values read as dates (most of a sample of the column).
export function looksLikeDates(sample: readonly unknown[]): boolean {
  const texts = sample.filter((value): value is string => typeof value === 'string' && value !== '')
  if (texts.length === 0) return false
  const dated = texts.filter((text) => /^\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}(?:[ T].*)?$/.test(text))
  return dated.length >= texts.length * 0.8
}
