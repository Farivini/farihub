import { useEffect, useMemo, useRef, useState } from 'react'

import type { LargeTableGridEdits, LargeTablePivotResult } from '../shared/desktop-api'
import { DATE_LOCALES, useI18n, type StringKey } from './i18n/locale'
import {
  buildPivotTable,
  largePivotQuery,
  looksLikeDates,
  pivotTableText,
  type LargePivotField,
  type LargePivotGap,
  type LargePivotQuery,
  type PivotCell,
  type PivotTable,
  type ShowAs,
  type TableTexts,
} from './large-pivot'
import { EMPTY_PIVOT_MODEL, type PivotLayoutModel } from './pivot-field-model'
import { PivotFieldPane } from './PivotFieldPane'

/// Rows the table draws (and the engine returns for it); Copy and Save ask
/// the engine again for every row.
const DRAWN_ROWS = 2_000
/// Every row a Copy or Save takes (Excel's sheet height).
const ALL_ROWS = 1_048_576
/// Bars of a category chart (the largest by the first value).
const CHART_BARS = 20
/// Columns of a date chart (in time order).
const CHART_COLUMNS = 120

const AGG_KEYS: Record<string, StringKey> = {
  sum: 'dlgPivotAggSum',
  count: 'dlgPivotAggCount',
  countDistinct: 'dlgPivotAggCountDistinct',
  average: 'dlgPivotAggAverage',
  max: 'dlgPivotAggMax',
  min: 'dlgPivotAggMin',
}

interface Answer {
  readonly result: LargeTablePivotResult
  readonly query: LargePivotQuery
  readonly showAs: ShowAs[]
  /// rows came largest first (Pareto, the chart's top bars)
  readonly sortByValue: boolean
  readonly model: PivotLayoutModel
  readonly seconds: number
}

/// Pivot of a large base: the Fields pane on the right, the engine's answer
/// on the left (table, chart, Pareto ABC), Copy and Save CSV. Every field
/// change is one engine query over the whole base; the grid is not touched.
export function LargePivotView({
  sessionId,
  sheetId,
  baseRows,
  columnCount,
  getEdits,
  initialModel,
  onLayout,
  onClose,
}: {
  readonly sessionId: string
  readonly sheetId: string
  /// data rows (below the header)
  readonly baseRows: number
  readonly columnCount: number
  readonly getEdits: () => LargeTableGridEdits
  /// the layout last used on this base (the view reopens on it)
  readonly initialModel?: PivotLayoutModel | undefined
  readonly onLayout?: (model: PivotLayoutModel) => void
  readonly onClose: () => void
}): React.JSX.Element {
  const { t, lang } = useI18n()
  const locale = DATE_LOCALES[lang]
  const decimal: ',' | '.' = (1.5).toLocaleString(locale).includes(',') ? ',' : '.'
  const dayFirst = decimal === ','
  const [fields, setFields] = useState<LargePivotField[] | null>(null)
  const [model, setModel] = useState<PivotLayoutModel>(initialModel ?? EMPTY_PIVOT_MODEL)
  const [applied, setApplied] = useState<PivotLayoutModel>(initialModel ?? EMPTY_PIVOT_MODEL)
  const [deferred, setDeferred] = useState(false)
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [running, setRunning] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pareto, setPareto] = useState(false)
  const [chart, setChart] = useState(false)
  const [members, setMembers] = useState<ReadonlyMap<number, string[]>>(new Map())
  const pendingMembers = useRef(new Set<number>())
  const sequence = useRef(0)

  // field names and kinds from the header and a sample of the first rows;
  // the engine starts reading every column for the first query
  useEffect(() => {
    let alive = true
    void (async () => {
      const last = Math.max(0, columnCount - 1)
      const read = await window.desktopApi.readWorkbookRange({
        sessionId,
        sheetId,
        range: { startRow: 0, endRow: Math.min(200, baseRows), startColumn: 0, endColumn: last },
      })
      if (!alive) return
      const byColumn = new Map<number, unknown[]>()
      const header = new Map<number, unknown>()
      for (const cell of read.cells) {
        if (cell.row === 0) header.set(cell.column, cell.value)
        else {
          const list = byColumn.get(cell.column) ?? []
          list.push(cell.value)
          byColumn.set(cell.column, list)
        }
      }
      setFields(
        Array.from({ length: columnCount }, (_unused, column) => {
          const sample = byColumn.get(column) ?? []
          const name = header.get(column)
          return {
            label:
              name === undefined || name === null || name === ''
                ? t('appFieldN', { n: column + 1 })
                : String(name),
            colIndex: column,
            numeric: sample.length > 0 && sample.every((value) => typeof value === 'number'),
            date: looksLikeDates(sample),
          }
        }),
      )
    })()
    void window.desktopApi
      .largeTableCalc({ action: 'pivot-warm', sessionId })
      .catch(() => undefined)
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one read per open
  }, [sessionId, sheetId])

  // one query per applied layout; a newer layout wins over a slower answer
  useEffect(() => {
    if (!fields) return
    const ticket = ++sequence.current
    if (applied.values.length === 0) {
      setAnswer(null)
      setMessage(null)
      setRunning(false)
      return
    }
    const planned = largePivotQuery(applied, fields)
    if ('gap' in planned) {
      // the last answer no longer matches the pane: show the reason only
      setAnswer(null)
      setRunning(false)
      setMessage(gapMessage(planned.gap))
      return
    }
    setRunning(true)
    setMessage(null)
    // Pareto and a category chart need the largest rows, not the first labels
    const sortByValue =
      planned.query.rows.length > 0 &&
      planned.query.columns.length === 0 &&
      (pareto || (chart && planned.query.rows[0]!.group === 'none'))
    const started = performance.now()
    void window.desktopApi
      .largeTableCalc({
        action: 'pivot',
        sessionId,
        ...planned.query,
        maxRows: DRAWN_ROWS,
        sortByValue,
        edits: getEdits(),
      })
      .then((outcome) => {
        if (ticket !== sequence.current) return
        setRunning(false)
        if (!outcome.ok) {
          setMessage(
            outcome.code === 'TOO_MANY_COLUMNS'
              ? t('appLargePivotTooManyColumns')
              : t('appLargePivotFailed', { detail: outcome.detail }),
          )
          return
        }
        if (!outcome.pivot) return
        setAnswer({
          result: outcome.pivot,
          query: planned.query,
          showAs: planned.showAs,
          sortByValue,
          model: applied,
          seconds: (performance.now() - started) / 1000,
        })
      })
      .catch((error: unknown) => {
        if (ticket !== sequence.current) return
        setRunning(false)
        setMessage(t('appLargePivotFailed', { detail: String(error) }))
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t and getEdits are read fresh
  }, [applied, fields, sessionId, pareto, chart])

  const gapMessage = (gap: LargePivotGap): string => {
    const what =
      gap.kind === 'rangeGroup'
        ? t('appLargePivotRangeGroup')
        : gap.kind === 'labelFilter'
          ? t('appLargePivotLabelFilter')
          : gap.kind === 'valueFilter'
            ? t('appLargePivotValueFilter')
            : gap.kind === 'calcField'
              ? t('appLargePivotCalcField')
              : gap.kind === 'agg'
                ? t('appLargePivotSummary2', { what: gap.agg })
                : t('appLargePivotShowAs', { what: gap.mode })
    return t('appLargePivotUnsupported', { what })
  }

  const canPareto =
    answer !== null && answer.query.rows.length > 0 && answer.query.columns.length === 0
  const tableTexts = (shown: Answer): TableTexts => ({
    rowFieldNames: shown.model.rows.map((index) => fields?.[index]?.label ?? ''),
    valueCaptions: shown.model.values.map((value) => {
      if (value.name?.trim()) return value.name
      const key = AGG_KEYS[value.agg]
      return t('dlgPivotValueCaption', {
        agg: key ? t(key) : value.agg,
        field: fields?.[value.fieldIndex]?.label ?? '',
      })
    }),
    grandTotal: t('appLargePivotTotal'),
    blank: t('appLargePivotBlank'),
    share: t('appLargePivotParetoShare'),
    cumulative: t('appLargePivotParetoAccum'),
    abcClass: t('appLargePivotParetoClass'),
    dayFirst,
  })
  const table: PivotTable | null = useMemo(() => {
    if (!answer || !fields) return null
    return buildPivotTable(
      answer.result,
      answer.query,
      answer.showAs,
      tableTexts(answer),
      pareto && canPareto,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t follows lang
  }, [answer, fields, pareto, canPareto, lang])

  const numberFormat = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }),
    [locale],
  )
  const percentFormat = useMemo(
    () => new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }),
    [locale],
  )
  const cellText = (cell: PivotCell): string => {
    if (cell.text !== undefined) return cell.text
    if (cell.value === null || cell.value === undefined) return ''
    return cell.percent === true
      ? percentFormat.format(cell.value)
      : numberFormat.format(cell.value)
  }

  const onGetFieldMembers = (fieldIndex: number): string[] => {
    const known = members.get(fieldIndex)
    if (known) return known
    if (!fields || pendingMembers.current.has(fieldIndex)) return []
    pendingMembers.current.add(fieldIndex)
    const grouping = model.groupings[fieldIndex]
    void window.desktopApi
      .largeTableCalc({
        action: 'pivot-members',
        sessionId,
        column: fields[fieldIndex]?.colIndex ?? fieldIndex,
        group:
          grouping?.kind === 'date'
            ? grouping.dateUnit
            : fields[fieldIndex]?.date === true
              ? 'day'
              : 'none',
        edits: getEdits(),
      })
      .then((outcome) => {
        pendingMembers.current.delete(fieldIndex)
        if (!outcome.ok || !outcome.members) return
        const labels = outcome.members.members.map((member) => member.label)
        setMembers((current) => new Map(current).set(fieldIndex, labels))
      })
      .catch(() => pendingMembers.current.delete(fieldIndex))
    return []
  }

  /// The whole table (every row) for Copy and Save: the shown answer when it
  /// holds every row, else one more engine query.
  const fullTable = async (): Promise<PivotTable | null> => {
    if (!answer || !table) return null
    if (answer.result.rows.length >= answer.result.rowCount) return table
    setRunning(true)
    const outcome = await window.desktopApi
      .largeTableCalc({
        action: 'pivot',
        sessionId,
        ...answer.query,
        maxRows: ALL_ROWS,
        sortByValue: answer.sortByValue,
        edits: getEdits(),
      })
      .finally(() => setRunning(false))
    if (!outcome.ok || !outcome.pivot) {
      if (!outcome.ok) setMessage(t('appLargePivotFailed', { detail: outcome.detail }))
      return null
    }
    return buildPivotTable(
      outcome.pivot,
      answer.query,
      answer.showAs,
      tableTexts(answer),
      pareto && canPareto,
    )
  }
  const copy = async (): Promise<void> => {
    const whole = await fullTable()
    if (!whole) return
    await navigator.clipboard.writeText(pivotTableText(whole, '\t', decimal))
    setNotice(t('appLargePivotCopied', { rows: numberFormat.format(whole.body.length) }))
  }
  const save = async (): Promise<void> => {
    const whole = await fullTable()
    if (!whole) return
    const outcome = await window.desktopApi.largeTableCalc({
      action: 'pivot-save',
      sessionId,
      text: pivotTableText(whole, decimal === ',' ? ';' : ',', decimal),
      name: t('appLargePivotTitle'),
    })
    if (outcome.ok && outcome.saved) setNotice(t('appLargePivotSaved', { path: outcome.saved }))
  }

  const summary =
    answer &&
    t('appLargePivotSummary', {
      rows: numberFormat.format(answer.result.sourceRows),
      groups: numberFormat.format(answer.result.rowCount),
      seconds: answer.seconds.toLocaleString(locale, { maximumFractionDigits: 2 }),
    })

  return (
    <div className="large-pivot" role="dialog" aria-label={t('appLargePivotTitle')}>
      <header className="large-pivot-bar">
        <div className="large-pivot-title">
          <strong>{t('appLargePivotTitle')}</strong>
          <span>
            {running
              ? t('appLargePivotRunning')
              : (summary ?? t('appLargePivotOpen', { rows: numberFormat.format(baseRows) }))}
          </span>
        </div>
        <div className="large-pivot-actions">
          <label data-tip={canPareto ? undefined : t('appLargePivotParetoNeedsRows')}>
            <input
              type="checkbox"
              checked={pareto && canPareto}
              disabled={!canPareto}
              onChange={(event) => setPareto(event.target.checked)}
            />
            {t('appLargePivotPareto')}
          </label>
          <label>
            <input
              type="checkbox"
              checked={chart}
              onChange={(event) => setChart(event.target.checked)}
            />
            {t('appLargePivotChart')}
          </label>
          <button type="button" disabled={!table} onClick={() => void copy()}>
            {t('appLargePivotCopy')}
          </button>
          <button type="button" disabled={!table} onClick={() => void save()}>
            {t('appLargePivotSave')}
          </button>
          <button type="button" className="primary-action" onClick={onClose}>
            {t('appLargePivotBack')}
          </button>
        </div>
      </header>
      <div className="large-pivot-body">
        {message && (
          <p className="dialog-error" role="alert">
            {message}
          </p>
        )}
        {notice && (
          <p className="large-pivot-notice" role="status">
            {notice}
          </p>
        )}
        {!answer && !message && <p className="large-pivot-empty">{t('appLargePivotEmpty')}</p>}
        {chart && table && answer && (
          <PivotChart
            table={table}
            query={answer.query}
            title={
              answer.query.rows.length > 0
                ? t('appLargePivotChartAll', {
                    value: table.head.at(-1)?.[table.labelColumns]?.text ?? '',
                    field: answer.model.rows
                      .map((index) => fields?.[index]?.label ?? '')
                      .join(' · '),
                  })
                : ''
            }
            needs={t('appLargePivotChartNeeds')}
            topTitle={(count, total) =>
              t('appLargePivotChartTop', {
                value: table.head.at(-1)?.[table.labelColumns]?.text ?? '',
                count,
                total: numberFormat.format(total),
              })
            }
            format={(value) => numberFormat.format(value)}
            totalRows={answer.result.rowCount}
          />
        )}
        {table && (
          <div className="large-pivot-table-wrap">
            <table className="large-pivot-table">
              <thead>
                {table.head.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) => (
                      <th
                        key={c}
                        colSpan={cell.span ?? 1}
                        className={cell.total === true ? 'is-total' : undefined}
                      >
                        {cell.text}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.body.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) =>
                      c < table.labelColumns ? (
                        <th key={c} scope="row">
                          {cell.text}
                        </th>
                      ) : (
                        <td key={c} className={cell.total === true ? 'is-total' : undefined}>
                          {cellText(cell)}
                        </td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
              {table.foot.length > 0 && (
                <tfoot>
                  <tr>
                    {table.foot.map((cell, c) =>
                      c < table.labelColumns ? (
                        <th key={c} scope="row">
                          {cell.text}
                        </th>
                      ) : (
                        <td key={c}>{cellText(cell)}</td>
                      ),
                    )}
                  </tr>
                </tfoot>
              )}
            </table>
            {answer !== null && answer.result.rowCount > table.body.length && (
              <p className="large-pivot-note">
                {t('appLargePivotShowingFirst', {
                  shown: numberFormat.format(table.body.length),
                  total: numberFormat.format(answer.result.rowCount),
                })}
              </p>
            )}
          </div>
        )}
      </div>
      {fields && (
        <PivotFieldPane
          fields={fields}
          model={model}
          largeBase
          deferred={deferred}
          dirty={model !== applied}
          error={null}
          onModelChange={(next) => {
            setModel(next)
            onLayout?.(next)
            setNotice(null)
            if (!deferred) setApplied(next)
          }}
          onDeferredChange={(next) => {
            setDeferred(next)
            if (!next) setApplied(model)
          }}
          onUpdate={() => setApplied(model)}
          onGetFieldMembers={onGetFieldMembers}
          onClose={onClose}
        />
      )}
    </div>
  )
}

/// The first value by row: horizontal bars for categories (the largest
/// first), columns in time order when the first row field is a date.
function PivotChart({
  table,
  query,
  title,
  needs,
  topTitle,
  format,
  totalRows,
}: {
  readonly table: PivotTable
  readonly query: LargePivotQuery
  readonly title: string
  readonly needs: string
  readonly topTitle: (count: number, total: number) => string
  readonly format: (value: number) => string
  /// row groups of the whole answer (the table holds the first ones)
  readonly totalRows: number
}): React.JSX.Element {
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null)
  const points = table.series.filter(
    (point): point is { label: string; value: number } => point.value !== null,
  )
  if (query.rows.length === 0 || points.length === 0) {
    return <p className="large-pivot-note">{needs}</p>
  }
  const temporal = query.rows[0]!.group !== 'none'
  const shown = temporal
    ? points.slice(0, CHART_COLUMNS)
    : [...points].sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, CHART_BARS)
  const total = Math.max(points.length, totalRows)
  // a date chart runs in time order: no "top N" to name
  const caption = !temporal && total > shown.length ? topTitle(shown.length, total) : title
  const low = Math.min(0, ...shown.map((point) => point.value))
  const high = Math.max(0, ...shown.map((point) => point.value))
  const span = high - low || 1
  const show = (event: React.PointerEvent, point: { label: string; value: number }) =>
    setHover({ x: event.clientX, y: event.clientY, text: `${point.label}: ${format(point.value)}` })

  if (temporal) {
    const width = Math.max(480, shown.length * 14)
    const height = 220
    const plot = height - 28
    const step = width / shown.length
    const bar = Math.max(2, step - 2)
    const zero = plot * (high / span)
    return (
      <figure className="large-pivot-chart">
        <figcaption>{caption}</figcaption>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width={width}
          height={height}
          role="img"
          aria-label={caption}
        >
          <line className="axis" x1={0} x2={width} y1={zero} y2={zero} />
          {shown.map((point, index) => {
            const length = (Math.abs(point.value) / span) * plot
            const x = index * step + 1
            const top = point.value >= 0 ? zero - length : zero
            return (
              <path
                key={index}
                className="mark"
                d={columnPath(x, top, bar, length, point.value >= 0)}
                onPointerMove={(event) => show(event, point)}
                onPointerLeave={() => setHover(null)}
              />
            )
          })}
          <text className="tick" x={0} y={height - 8}>
            {shown[0]!.label}
          </text>
          <text className="tick" x={width} y={height - 8} textAnchor="end">
            {shown.at(-1)!.label}
          </text>
        </svg>
        {hover && <ChartTip hover={hover} />}
      </figure>
    )
  }
  const labelWidth = 160
  const plotWidth = 420
  const rowHeight = 22
  const thickness = 14
  const height = shown.length * rowHeight + 4
  const zero = labelWidth + (plotWidth * -low) / span
  return (
    <figure className="large-pivot-chart">
      <figcaption>{caption}</figcaption>
      <svg
        viewBox={`0 0 ${labelWidth + plotWidth + 90} ${height}`}
        width={labelWidth + plotWidth + 90}
        height={height}
        role="img"
        aria-label={caption}
      >
        <line className="axis" x1={zero} x2={zero} y1={0} y2={height} />
        {shown.map((point, index) => {
          const length = (Math.abs(point.value) / span) * plotWidth
          const y = index * rowHeight + (rowHeight - thickness) / 2
          const left = point.value >= 0 ? zero : zero - length
          return (
            <g key={index}>
              <text className="tick" x={labelWidth - 8} y={y + thickness - 3} textAnchor="end">
                {point.label.length > 24 ? `${point.label.slice(0, 23)}…` : point.label}
              </text>
              <path
                className="mark"
                d={barPath(left, y, length, thickness, point.value >= 0)}
                onPointerMove={(event) => show(event, point)}
                onPointerLeave={() => setHover(null)}
              />
              <text
                className="value"
                x={(point.value >= 0 ? left + length : zero) + 6}
                y={y + thickness - 3}
              >
                {format(point.value)}
              </text>
            </g>
          )
        })}
      </svg>
      {hover && <ChartTip hover={hover} />}
    </figure>
  )
}

function ChartTip({
  hover,
}: {
  readonly hover: { x: number; y: number; text: string }
}): React.JSX.Element {
  return (
    <div className="large-pivot-tip" style={{ left: hover.x + 12, top: hover.y + 12 }}>
      {hover.text}
    </div>
  )
}

/// A horizontal bar anchored square at the baseline, its data end rounded.
function barPath(x: number, y: number, length: number, thickness: number, right: boolean): string {
  const r = Math.min(4, length / 2, thickness / 2)
  if (right) {
    const end = x + length
    return `M${x},${y}H${end - r}Q${end},${y} ${end},${y + r}V${y + thickness - r}Q${end},${y + thickness} ${end - r},${y + thickness}H${x}Z`
  }
  const end = x
  const base = x + length
  return `M${base},${y}H${end + r}Q${end},${y} ${end},${y + r}V${y + thickness - r}Q${end},${y + thickness} ${end + r},${y + thickness}H${base}Z`
}

/// A column anchored square at the baseline, its data end rounded.
function columnPath(x: number, top: number, width: number, length: number, up: boolean): string {
  const r = Math.min(4, length / 2, width / 2)
  if (up) {
    const base = top + length
    return `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + width - r}Q${x + width},${top} ${x + width},${top + r}V${base}Z`
  }
  const end = top + length
  return `M${x},${top}V${end - r}Q${x},${end} ${x + r},${end}H${x + width - r}Q${x + width},${end} ${x + width},${end - r}V${top}Z`
}
