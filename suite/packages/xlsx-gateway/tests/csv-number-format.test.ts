import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'

import { csvToXlsxBufferForOpen, parseCsv } from '../src/gateway/csv-import'
import {
  analyzeCsvColumns,
  describeCsvImport,
  numberShape,
  parseNumberWithMark,
} from '../src/gateway/csv-number-format'

/** cells of the converted sheet: numbers as numbers, inline strings as strings */
async function convert(csv: string, delimiter?: string) {
  const { buffer, report } = await csvToXlsxBufferForOpen(csv, 'Sheet1', delimiter)
  const zip = await JSZip.loadAsync(buffer)
  const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
  const cells: Record<string, number | string> = {}
  for (const match of xml.matchAll(/<c r="([A-Z]+\d+)"( t="inlineStr")?>(.*?)<\/c>/g)) {
    const [, ref, inline, body] = match
    cells[ref!] = inline
      ? /<t[^>]*>(.*?)<\/t>/.exec(body!)![1]!
      : Number(/<v>(.*?)<\/v>/.exec(body!)![1])
  }
  return { cells, report }
}

describe('numberShape / parseNumberWithMark', () => {
  it('tells the conventions apart only where the value does', () => {
    expect(numberShape('16,99')).toBe('comma')
    expect(numberShape('1.234,56')).toBe('comma')
    expect(numberShape('1.234.567')).toBe('comma')
    expect(numberShape('16.99')).toBe('point')
    expect(numberShape('1,234.56')).toBe('point')
    expect(numberShape('1e10')).toBe('point')
    expect(numberShape('1.234')).toBe('ambiguous')
    expect(numberShape('1,234')).toBe('ambiguous')
    expect(numberShape('0,125')).toBe('comma')
    expect(numberShape('-2')).toBe('int')
    expect(numberShape('007')).toBe('code')
    expect(numberShape('12345678901')).toBe('code')
    expect(numberShape('+55')).toBeNull()
    expect(numberShape('12,5%')).toBeNull()
    expect(numberShape('R$ 10,00')).toBeNull()
  })

  it('reads a value with the column mark', () => {
    expect(parseNumberWithMark('1.234,56', ',')).toBe(1234.56)
    expect(parseNumberWithMark('-1.234,56', ',')).toBe(-1234.56)
    expect(parseNumberWithMark('16,99', ',')).toBe(16.99)
    expect(parseNumberWithMark('1.234', ',')).toBe(1234)
    expect(parseNumberWithMark('1.234', '.')).toBe(1.234)
    expect(parseNumberWithMark('1,234.5', '.')).toBe(1234.5)
    expect(parseNumberWithMark('16.99', ',')).toBeNull()
    expect(parseNumberWithMark('007', ',')).toBeNull()
    expect(parseNumberWithMark(' 3,5 ', ',')).toBe(3.5)
  })
})

describe('pt-BR CSV import (per column)', () => {
  const ptbr =
    '﻿total_bill;tip;sex;smoker;day;time;size\n' +
    '16,99;1,01;Female;No;Sun;Dinner;2\n' +
    '10,34;1,66;Male;No;Sun;Dinner;3\n' +
    '21;3,5;Male;No;Sun;Dinner;3\n'

  it('reads comma-decimal amounts as numbers, integers included', async () => {
    const { cells, report } = await convert(ptbr)
    expect(cells.A2).toBe(16.99)
    expect(cells.B2).toBe(1.01)
    expect(cells.A4).toBe(21)
    expect(cells.G3).toBe(3)
    expect(cells.E2).toBe('Sun')
    expect(report.delimiter).toBe(';')
    expect(report.decimal).toBe(',')
    expect(report.columns[0]).toMatchObject({ header: 'total_bill', kind: 'number', decimal: ',' })
    expect(report.columns[0]!.numbers).toBe(3)
  })

  it('handles grouping, negatives, empty fields and quotes', async () => {
    const csv =
      'Cliente;Valor;Saldo;Obs\n' +
      '"Ação; Ltda";"1.234,56";-2,5;"diz ""oi"""\n' +
      'Café;;-1.000,00;\n' +
      'Rui;12,30;7;x\n'
    const { cells } = await convert(csv)
    expect(cells.A2).toBe('Ação; Ltda')
    expect(cells.B2).toBe(1234.56)
    expect(cells.C2).toBe(-2.5)
    expect(cells.C3).toBe(-1000)
    expect(cells.B3).toBeUndefined()
    expect(cells.B4).toBe(12.3)
    expect(cells.D2).toBe('diz &quot;oi&quot;')
  })

  it('keeps identifiers as text: leading zeros, CEP, CPF, CNPJ', async () => {
    const csv =
      'Codigo;CEP;CPF;Valor\n' +
      '00123;01310100;12345678901;10,50\n' +
      '456;20040002;98765432100;3\n'
    const { cells, report } = await convert(csv)
    expect(cells.A2).toBe('00123')
    expect(cells.A3).toBe('456')
    expect(cells.B2).toBe('01310100')
    expect(cells.B3).toBe('20040002')
    expect(cells.C2).toBe('12345678901')
    expect(cells.D2).toBe(10.5)
    expect(report.columns.slice(0, 3).map((c) => c.kind)).toEqual([
      'identifier',
      'identifier',
      'identifier',
    ])
  })

  it('an ambiguous column follows the rest of the file', async () => {
    const { cells, report } = await convert('Qtd;Preço\n1.234;10,50\n2.500;3,25\n')
    expect(cells.A2).toBe(1234)
    expect(cells.A3).toBe(2500)
    expect(report.columns[0]).toMatchObject({ kind: 'number', decimal: ',', decidedByFile: true })
  })

  it('with no evidence anywhere, an ambiguous column keeps the data and is explained', async () => {
    const { cells, report } = await convert('Peso;Nome\n1.250;a\n2.500;b\n')
    expect(cells.A2).toBe('1.250')
    expect(cells.A3).toBe('2.500')
    expect(report.columns[0]).toMatchObject({ kind: 'ambiguous', example: '1.250', keptAsText: 2 })
    expect(describeCsvImport(report)).toContain('AMBIGUOUS column A "Peso"')
  })

  it('a column mixing both conventions keeps the data and is explained', async () => {
    const { cells, report } = await convert('Valor;Nome\n16,99;a\n16.99;b\n')
    expect(cells.A2).toBe('16,99')
    expect(cells.A3).toBe('16.99')
    expect(report.columns[0]!.kind).toBe('ambiguous')
  })
})

describe('point-decimal CSV and TSV keep their reading', () => {
  it('comma-delimited with point decimals', async () => {
    const csv = '"total_bill","tip","day","size"\n16.99,1.01,"Sun",2\n"1,234.50",-0.5,"Sat",3\n'
    const { cells, report } = await convert(csv)
    expect(cells.A2).toBe(16.99)
    expect(cells.A3).toBe(1234.5)
    expect(cells.B3).toBe(-0.5)
    expect(cells.D2).toBe(2)
    expect(report.decimal).toBe('.')
  })

  it('a comma file with only 1.250-style values keeps the point reading it always had', async () => {
    const { cells } = await convert('peso,nome\n1.250,a\n')
    expect(cells.A2).toBe(1.25)
  })

  it('TSV with point decimals', async () => {
    const { cells } = await convert('a\tb\n16.99\tx\n2\ty\n', '\t')
    expect(cells.A2).toBe(16.99)
    expect(cells.A3).toBe(2)
  })

  it('analysis runs on the parsed grid the import uses', () => {
    const rows = parseCsv('x;y\n1,5;2\n', ';')
    const typing = analyzeCsvColumns(rows, ';')
    expect(typing.numberAt(0, '1,5')).toBe(1.5)
    expect(typing.numberAt(0, 'x')).toBeNull()
  })
})

describe('delimiter of a narrow pt-BR table', () => {
  it('a two-column `;` table with decimal commas is not split on the commas', async () => {
    const { cells, report } = await convert('a;b\n1,25;2,25\n3,25;4,25\n')
    expect(report.delimiter).toBe(';')
    expect(cells.A2).toBe(1.25)
    expect(cells.B3).toBe(4.25)
  })

  it('a consistent comma table keeps the comma even with a `;` in the text', async () => {
    const { cells, report } = await convert('nome,obs\nAna,"a; b"\nRui,c; d\n')
    expect(report.delimiter).toBe(',')
    expect(cells.B3).toBe('c; d')
  })

  it('an Excel `sep=` line is honoured and reported, so a save can write it back', async () => {
    const { cells, report } = await convert('sep=;\na;b\n1,25;2,25\n')
    expect(report).toMatchObject({ delimiter: ';', declared: true, decimal: ',' })
    expect(cells.A2).toBe(1.25)
    expect((await convert('a;b\n1,25;2,25\n')).report.declared).toBeUndefined()
  })
})
