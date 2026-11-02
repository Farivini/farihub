import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'

import { csvToXlsxBufferForOpen } from '@genoffice/xlsx-gateway/gateway/csv-import'
import { describeCsvImport } from '@genoffice/xlsx-gateway/gateway/csv-number-format'
import {
  csvDialectOf,
  csvField,
  plainDecimal,
  serializeActiveSheetCsv,
} from '../src/renderer/csv-export'
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

describe('a saved pt-BR CSV reopens the same way', () => {
  /** open → the grid's values → save back → open again */
  async function roundTrip(source: string) {
    const first = await csvToXlsxBufferForOpen(source)
    const zip = await JSZip.loadAsync(first.buffer)
    const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
    const raws: unknown[][] = []
    for (const match of xml.matchAll(/<c r="([A-Z])(\d+)"( t="inlineStr")?>(.*?)<\/c>/g)) {
      const [, column, row, inline, body] = match
      const r = Number(row) - 1
      const c = column!.charCodeAt(0) - 65
      ;(raws[r] ??= [])[c] = inline
        ? /<t[^>]*>(.*?)<\/t>/.exec(body!)![1]
        : Number(/<v>(.*?)<\/v>/.exec(body!)![1])
    }
    const displays = raws.map((row) => row.map((value) => String(value)))
    const saved = serializeActiveSheetCsv(
      sheetOf(displays, raws) as never,
      null,
      () => null,
      csvDialectOf(first.report),
    )
    if (saved === 'too-large') throw new Error('too large')
    const second = await csvToXlsxBufferForOpen(saved)
    return { saved, first: first.report, second: second.report, raws }
  }

  it('keeps an Excel `sep=` line', async () => {
    const { saved, second } = await roundTrip('sep=;\r\na;b\r\n1,25;2,25\r\n3,25;4,25\r\n')
    expect(saved).toBe('sep=;\r\na;b\r\n1,25;2,25\r\n3,25;4,25\r\n')
    expect(second).toMatchObject({ delimiter: ';', declared: true, decimal: ',' })
  })

  it('a narrow `;` table without a declaration reopens with `;`', async () => {
    const { second } = await roundTrip('a;b\r\n1,25;2,25\r\n3,25;4,25\r\n')
    expect(second.delimiter).toBe(';')
    expect(second.columns.map((column) => column.kind)).toEqual(['number', 'number'])
  })

  it('small and large numbers are written without an exponent, and stay numbers', async () => {
    expect(plainDecimal(1.2e-7)).toBe('0.00000012')
    expect(plainDecimal(-3.5e-9)).toBe('-0.0000000035')
    expect(plainDecimal(1.5e21)).toBe('1500000000000000000000')
    expect(plainDecimal(16.99)).toBe('16.99')
    const { saved, second } = await roundTrip('v;w\r\n0,00000012;1,5\r\n2,5;3\r\n')
    expect(saved).toContain('0,00000012;1,5')
    expect(second.columns[0]).toMatchObject({ kind: 'number', decimal: ',', numbers: 2 })
  })
})
