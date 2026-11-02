import { describe, expect, it } from 'vitest'

import { csvToXlsxBufferForOpen } from '@genoffice/xlsx-gateway/gateway/csv-import'
import { describeCsvImport } from '@genoffice/xlsx-gateway/gateway/csv-number-format'
import { csvDialectOf, csvField, serializeActiveSheetCsv } from '../src/renderer/csv-export'
import { csvOpenNotice } from '../src/renderer/csv-open-notice'

/** a structural worksheet over display strings and raw values (as csv-export.test.ts) */
function sheetOf(displays: string[][], raws: unknown[][]) {
  return {
    getLastRow: () => displays.length - 1,
    getLastColumn: () => Math.max(...displays.map((row) => row.length)) - 1,
    getSheetId: () => 's1',
    getSheetName: () => 'Sheet1',
    getRange: (row: number, _column: number, rows: number, columns: number) => ({
      getDisplayValues: () =>
        displays
          .slice(row, row + rows)
          .map((line) => Array.from({ length: columns }, (_, i) => line[i] ?? '')),
      getRawValues: () =>
        raws
          .slice(row, row + rows)
          .map((line) => Array.from({ length: columns }, (_, i) => line[i] ?? '')),
    }),
    getSheet: () => ({ getCellMatrix: () => ({ forValue: () => undefined }) }),
  }
}

const t = (key: string, values: Record<string, string | number>) =>
  `${key}:${Object.entries(values)
    .map(([name, value]) => `${name}=${value}`)
    .join(',')}`

describe('a pt-BR CSV is saved back in its own convention', () => {
  it('keeps the semicolon and the decimal comma for General numbers', () => {
    const sheet = sheetOf(
      [
        ['total_bill', 'tip', 'obs'],
        ['16.99', '1.01', 'a;b'],
      ],
      [
        ['total_bill', 'tip', 'obs'],
        [16.99, 1.01, 'a;b'],
      ],
    )
    const dialect = csvDialectOf({ delimiter: ';', decimal: ',' })
    expect(serializeActiveSheetCsv(sheet as never, null, () => null, dialect)).toBe(
      'total_bill;tip;obs\r\n16,99;1,01;"a;b"\r\n',
    )
  })

  it('a point-decimal or unknown file keeps the comma export', () => {
    expect(csvDialectOf(undefined)).toEqual({ delimiter: ',', decimal: '.' })
    expect(csvDialectOf({ delimiter: ';', decimal: null })).toEqual({
      delimiter: ';',
      decimal: '.',
    })
    expect(csvField('16,99', ';')).toBe('16,99')
    expect(csvField('16,99')).toBe('"16,99"')
  })
})

describe('what the user and the AI are told', () => {
  it('names the comma-decimal columns and the ambiguous ones', async () => {
    const { report } = await csvToXlsxBufferForOpen('Valor;Peso;Nome\n16,99;1.250;a\n2,5;2.500;b\n')
    // Peso follows the file (comma decimal): 1.250 is one thousand two hundred fifty
    expect(report.columns[1]).toMatchObject({ kind: 'number', decidedByFile: true })
    expect(csvOpenNotice({ name: 'x.csv', csvFormat: report }, t)).toBe(
      'appCsvCommaDecimal:name=x.csv,count=2',
    )
    const mixed = await csvToXlsxBufferForOpen('Valor;Nome\n16,99;a\n16.99;b\n')
    expect(csvOpenNotice({ name: 'y.csv', csvFormat: mixed.report }, t)).toBe(
      'appCsvAmbiguousKept:columns=A (Valor),example=16,99',
    )
    expect(describeCsvImport(report)).toContain('semicolon-separated, decimal comma')
    expect(describeCsvImport(mixed.report)).toContain('AMBIGUOUS column A "Valor"')
  })

  it('a plain point-decimal CSV needs no remark', async () => {
    const { report } = await csvToXlsxBufferForOpen('a,b\n1.5,x\n')
    expect(csvOpenNotice({ name: 'z.csv', csvFormat: report }, t)).toBeNull()
  })
})
