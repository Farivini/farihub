/// The status line after opening a CSV: what the per-column number reading did
/// when it matters to the user — comma-decimal numbers recognized, and columns
/// kept as text because their reading was ambiguous (csv-number-format.ts).

import type { CsvImportReport } from '@genoffice/xlsx-gateway/gateway/csv-number-format'

type Translate = (
  key: 'appCsvCommaDecimal' | 'appCsvAmbiguousKept',
  values: Record<string, string | number>,
) => string

function columnLetters(column: number): string {
  let label = ''
  let remaining = column + 1
  while (remaining > 0) {
    remaining -= 1
    label = String.fromCharCode(65 + (remaining % 26)) + label
    remaining = Math.floor(remaining / 26)
  }
  return label
}

/** null when the import needs no remark (a plain point-decimal file) */
export function csvOpenNotice(
  file: { readonly name: string; readonly csvFormat?: CsvImportReport | undefined },
  t: Translate,
): string | null {
  const format = file.csvFormat
  if (!format) return null
  const parts: string[] = []
  const comma = format.columns.filter(
    (column) => column.kind === 'number' && column.decimal === ',' && column.numbers > 0,
  )
  if (comma.length > 0)
    parts.push(t('appCsvCommaDecimal', { name: file.name, count: comma.length }))
  const ambiguous = format.columns.filter((column) => column.kind === 'ambiguous')
  if (ambiguous.length > 0) {
    parts.push(
      t('appCsvAmbiguousKept', {
        columns: ambiguous
          .map(
            (column) =>
              `${columnLetters(column.column)}${column.header ? ` (${column.header})` : ''}`,
          )
          .join(', '),
        example: ambiguous[0]!.example ?? '',
      }),
    )
  }
  return parts.length > 0 ? parts.join(' ') : null
}
