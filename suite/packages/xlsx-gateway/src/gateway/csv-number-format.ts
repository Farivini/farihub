/// Number recognition for delimited imports, decided per column.
///
/// A CSV from a Brazilian (or most European) system writes `16,99` and
/// `1.234,56`; an English one writes `16.99` and `1,234.56`. Reading one
/// value at a time cannot tell `1.234` (one thousand two hundred thirty-four,
/// or one point two three four) apart, and reading only the point form turned
/// every pt-BR amount into text. So each column is judged as a whole, from the
/// values that are unambiguous (`16,99` can only be comma-decimal, `16.99` only
/// point-decimal), and every value of the column is then read the same way.
///
/// Rules (shared with the root Farihub importer, src/core/delimited.ts):
/// - identifiers stay text: integers with leading zeros (`007`, CEP `01310100`)
///   or 11+ digits (CPF, CNPJ, phones, barcodes) make the whole column text,
///   so no zero is lost and no code is half-converted;
/// - a column whose own values only fit one decimal mark uses it; one with
///   both (`16,99` and `16.99`) is ambiguous;
/// - a column with only ambiguous values (`1.234`) follows the mark the rest of
///   the file shows; with no evidence anywhere, a comma-delimited file keeps the
///   point reading it always had, and any other file keeps the data as text;
/// - ambiguous columns keep their text as written and are reported, so the user
///   (and the AI) see why they did not become numbers;
/// - a `+` sign, percentages, currency symbols and dates are left as text, as before.

export type DecimalMark = ',' | '.'

export type CsvColumnKind =
  /** values were read as numbers (decimal mark in `decimal`; absent for integers only) */
  | 'number'
  /** identifiers (leading zeros, long digit runs): kept as text on purpose */
  | 'identifier'
  /** number-like values whose reading is not certain: kept as text and reported */
  | 'ambiguous'
  | 'text'
  | 'empty'

export interface CsvColumnReport {
  /** 0-based column index */
  readonly column: number
  /** first-row text when it is a header (not a number), else '' */
  readonly header: string
  readonly kind: CsvColumnKind
  readonly decimal?: DecimalMark | undefined
  /** the mark came from the rest of the file (the column's own values were ambiguous) */
  readonly decidedByFile?: boolean | undefined
  /** cells written as numbers */
  readonly numbers: number
  /** number-like cells kept as text (identifiers, ambiguous values) */
  readonly keptAsText: number
  /** one such value, to explain the decision */
  readonly example?: string | undefined
}

export interface CsvImportReport {
  readonly delimiter: string
  /** the decimal mark the file's numbers use, when they agree on one */
  readonly decimal: DecimalMark | null
  readonly columns: readonly CsvColumnReport[]
}

export interface CsvColumnTyping {
  readonly report: CsvImportReport
  /** the number a cell holds under its column's reading, or null to keep the text */
  numberAt(column: number, value: string): number | null
}

/** CPF has 11 digits, CNPJ 14; phones and barcodes are as long (root Farihub rule). */
const CODE_DIGITS = 11
/** Past 15 significant digits a double cannot hold the value exactly. */
const MAX_EXACT_DIGITS = 15

type Shape = 'int' | 'comma' | 'point' | 'ambiguous' | 'code'

/// What a single value can be. `null`: not a number in either convention.
export function numberShape(raw: string): Shape | null {
  const value = raw.trim()
  if (value === '') return null
  const unsigned = value.startsWith('-') ? value.slice(1) : value
  if (/^\d+$/.test(unsigned)) {
    if ((unsigned.length > 1 && unsigned.startsWith('0')) || unsigned.length >= CODE_DIGITS) {
      return 'code'
    }
    return 'int'
  }
  // `1.234` / `1,234`: a grouped thousand in one convention, a decimal in the other
  if (/^[1-9]\d{0,2}[.,]\d{3}$/.test(unsigned)) return 'ambiguous'
  const leadingZero = /^0\d/.test(unsigned)
  if (/^\d+,\d+$/.test(unsigned)) return leadingZero ? 'code' : 'comma'
  if (/^\d+\.\d+$/.test(unsigned)) return leadingZero ? 'code' : 'point'
  if (/^[1-9]\d{0,2}(?:\.\d{3})+(?:,\d+)?$/.test(unsigned)) return 'comma'
  if (/^[1-9]\d{0,2}(?:,\d{3})+(?:\.\d+)?$/.test(unsigned)) return 'point'
  // the forms the point reading always accepted: `.5`, `1.`, `-.5`, `1e10`
  if (/^(?:(?:0|[1-9]\d*)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(unsigned)) return 'point'
  return null
}

const GROUPED: Record<DecimalMark, RegExp> = {
  ',': /^(-?)((?:[1-9]\d{0,2}(?:\.\d{3})+)|\d+)(?:,(\d+))?$/,
  '.': /^(-?)((?:[1-9]\d{0,2}(?:,\d{3})+)|\d+)(?:\.(\d+))?$/,
}

/// The number `raw` holds when read with `mark`, or null (stays text).
export function parseNumberWithMark(raw: string, mark: DecimalMark): number | null {
  const value = raw.trim()
  const match = GROUPED[mark].exec(value)
  if (match) {
    const [, sign, whole, fraction] = match
    const digits = whole!.replace(/[.,]/g, '')
    if (digits.length > 1 && digits.startsWith('0')) return null
    if ((digits + (fraction ?? '')).replace(/^0+/, '').length > MAX_EXACT_DIGITS) return null
    const number = Number(`${sign}${digits}${fraction ? `.${fraction}` : ''}`)
    return Number.isFinite(number) ? number : null
  }
  if (mark === '.' && numberShape(value) === 'point') {
    const number = Number(value)
    return Number.isFinite(number) ? number : null
  }
  return null
}

interface ColumnCounts {
  int: number
  comma: number
  point: number
  ambiguous: number
  code: number
  text: number
  firstAmbiguous?: string
  firstConflict?: string
  firstCode?: string
}

/// Judges every column of the parsed rows (header row included: a text header
/// simply does not count as a number).
export function analyzeCsvColumns(
  rows: readonly (readonly string[])[],
  delimiter: string,
): CsvColumnTyping {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0)
  const counts: ColumnCounts[] = Array.from({ length: width }, () => ({
    int: 0,
    comma: 0,
    point: 0,
    ambiguous: 0,
    code: 0,
    text: 0,
  }))
  for (const row of rows) {
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
  }

  // the columns' own evidence first; the file's mark is what they agree on
  const own = counts.map((entry): DecimalMark | 'conflict' | null => {
    if (entry.code > 0) return null
    if (entry.comma > 0 && entry.point > 0) return 'conflict'
    if (entry.comma > 0) return ','
    if (entry.point > 0) return '.'
    return null
  })
  const marks = new Set(own.filter((mark): mark is DecimalMark => mark === ',' || mark === '.'))
  const fileMark: DecimalMark | null = marks.size === 1 ? [...marks][0]! : null

  const header = rows[0] ?? []
  const decided: { kind: CsvColumnKind; decimal?: DecimalMark; decidedByFile?: boolean }[] =
    counts.map((entry, column) => {
      const numeric = entry.int + entry.comma + entry.point + entry.ambiguous
      if (entry.code > 0) return { kind: 'identifier' }
      const mark = own[column]
      if (mark === 'conflict') return { kind: 'ambiguous' }
      if (mark === ',' || mark === '.') return { kind: 'number', decimal: mark }
      if (entry.ambiguous > 0) {
        if (fileMark !== null) return { kind: 'number', decimal: fileMark, decidedByFile: true }
        // a comma-delimited file cannot hold an unquoted decimal comma: the
        // point reading it always had stays
        if (delimiter === ',') return { kind: 'number', decimal: '.' }
        return { kind: 'ambiguous' }
      }
      if (numeric > 0) return { kind: 'number' }
      return { kind: entry.text > 0 ? 'text' : 'empty' }
    })

  const numberAt = (column: number, value: string): number | null => {
    const decision = decided[column]
    if (decision?.kind !== 'number') return null
    return parseNumberWithMark(value, decision.decimal ?? '.')
  }

  // the counts come from the one pass above: a number column reads every
  // number-like value it holds; the other kinds keep them all as text
  const columns = counts.map((entry, column): CsvColumnReport => {
    const decision = decided[column]!
    const headerText = header[column] ?? ''
    const isHeader = headerText.trim() !== '' && numberShape(headerText) === null
    const numberLike = entry.int + entry.comma + entry.point + entry.ambiguous + entry.code
    const numbers = decision.kind === 'number' ? numberLike : 0
    const kept = decision.kind === 'number' ? 0 : numberLike
    const shown =
      decision.kind === 'identifier'
        ? entry.firstCode
        : decision.kind === 'ambiguous'
          ? (entry.firstAmbiguous ?? entry.firstConflict)
          : undefined
    return {
      column,
      header: isHeader ? headerText : '',
      kind: decision.kind,
      ...(decision.decimal !== undefined ? { decimal: decision.decimal } : {}),
      ...(decision.decidedByFile ? { decidedByFile: true } : {}),
      numbers,
      keptAsText: kept,
      ...(shown !== undefined ? { example: shown } : {}),
    }
  })
  return { report: { delimiter, decimal: fileMark, columns }, numberAt }
}

function columnName(column: number): string {
  let label = ''
  let remaining = column + 1
  while (remaining > 0) {
    remaining -= 1
    label = String.fromCharCode(65 + (remaining % 26)) + label
    remaining = Math.floor(remaining / 26)
  }
  return label
}

/// A plain-English account of the import for the AI's workbook context.
export function describeCsvImport(report: CsvImportReport): string {
  const name = (entry: CsvColumnReport) =>
    `${columnName(entry.column)}${entry.header ? ` "${entry.header}"` : ''}`
  const delimiter =
    report.delimiter === '\t' ? 'tab' : report.delimiter === ';' ? 'semicolon' : 'comma'
  const lines = [
    `Opened from a delimited text file (${delimiter}-separated` +
      (report.decimal ? `, decimal ${report.decimal === ',' ? 'comma' : 'point'})` : ')') +
      '. Numbers were recognized per column; the cells below hold real numbers.',
  ]
  const numeric = report.columns.filter((entry) => entry.kind === 'number' && entry.numbers > 0)
  if (numeric.length > 0) {
    lines.push(
      `Numeric columns: ${numeric
        .map(
          (entry) =>
            `${name(entry)}${entry.decimal ? ` (decimal ${entry.decimal === ',' ? 'comma' : 'point'}${entry.decidedByFile ? ', as in the rest of the file' : ''})` : ''}`,
        )
        .join(', ')}.`,
    )
  }
  const identifiers = report.columns.filter((entry) => entry.kind === 'identifier')
  if (identifiers.length > 0) {
    lines.push(
      `Identifier columns kept as text (leading zeros or long codes): ${identifiers.map(name).join(', ')}.`,
    )
  }
  for (const entry of report.columns.filter((column) => column.kind === 'ambiguous')) {
    lines.push(
      `AMBIGUOUS column ${name(entry)}: values like "${entry.example ?? ''}" fit both decimal conventions, ` +
        'so they were kept as text exactly as written. Do not sum them as numbers; ask the user which ' +
        'convention the column uses before converting it.',
    )
  }
  return lines.join('\n')
}
