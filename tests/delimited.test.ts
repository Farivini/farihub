import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeText, detectDecimal, detectEncoding, detectSeparator, interpret, parseDelimited, serializeDelimited, suggestColumnTypes } from '../src/core/delimited.ts';
import { WorkbookEngine } from '../src/engine/workbook-engine.ts';
import type { DelimitedOptions } from '../src/core/delimited.ts';
import { ic } from './ironcalc-node.ts';

const rows = (text: string, sep: ';' | ',' | '\t' = ';') => [...parseDelimited(text, sep)];

test('quotes, doubled quotes, separators and line breaks inside fields; CRLF; no trailing empty row', () => {
  assert.deepEqual(rows('a;"b;c";"d ""e"""\r\n"linha\r\nquebrada";2\r\n'), [['a', 'b;c', 'd "e"'], ['linha\r\nquebrada', '2']]);
  assert.deepEqual(rows('a;;\n;b'), [['a', '', ''], ['', 'b']]);
  assert.deepEqual(rows('x,"unterminated', ','), [['x', 'unterminated']]);
});

test('encoding: UTF-8 when valid (BOM dropped), otherwise Windows-1252', () => {
  const utf8 = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('Ação;Preço')]);
  assert.equal(detectEncoding(utf8), 'utf-8');
  assert.equal(decodeText(utf8, 'utf-8'), 'Ação;Preço');
  // A preview sample that ends inside "ç" (0xc3 0xa7) is still UTF-8.
  const cut = new TextEncoder().encode('João;Preço');
  assert.equal(detectEncoding(cut.subarray(0, cut.indexOf(0xa7))), 'utf-8');
  const latin = new Uint8Array([0x41, 0xe7, 0xe3, 0x6f]); // "Ação" in Windows-1252
  assert.equal(detectEncoding(latin), 'windows-1252');
  assert.equal(decodeText(latin, 'windows-1252'), 'Ação');
});

test('separator and decimal detection', () => {
  assert.equal(detectSeparator('Nome;Valor\nAna;1,5\nRui;2'), ';');
  assert.equal(detectSeparator('Nome,Valor\nAna,1.5\n"Rui, filho",2'), ',');
  assert.equal(detectSeparator('Nome\tValor\nAna\t1'), '\t');
  assert.equal(detectDecimal(rows('1,5;1.234,56'), ';'), ',');
  assert.equal(detectDecimal(rows('1.5,1234.56', ','), ','), '.');
  assert.equal(detectDecimal(rows('a;b'), ';'), ',');
});

test('values: numbers per decimal mark, dates, leading zeros kept, formulas never injected', () => {
  assert.deepEqual(interpret('1.234,56', 'auto', ','), { kind: 'number', input: '1234,56' });
  assert.deepEqual(interpret('1,234.56', 'auto', '.'), { kind: 'number', input: '1234,56' });
  assert.deepEqual(interpret('-0.5', 'auto', '.'), { kind: 'number', input: '-0,5' });
  assert.deepEqual(interpret('12,5%', 'auto', ','), { kind: 'number', input: '12,5%' });
  assert.equal(interpret('1.234', 'auto', ',').input, '1234', 'point is grouping with comma decimals');
  assert.equal(interpret('1.234', 'auto', '.').input, '1,234', 'point is decimal with point decimals');
  assert.deepEqual(interpret('15/03/2024', 'auto', ','), { kind: 'date', input: '15/03/2024' });
  assert.deepEqual(interpret('2024-03-05', 'auto', ','), { kind: 'date', input: '05/03/2024' });
  assert.equal(interpret('31/02/2024', 'auto', ',').kind, 'text', 'impossible date stays text');
  assert.deepEqual(interpret('00123', 'auto', ','), { kind: 'text', input: "'00123" });
  assert.deepEqual(interpret('12345678901234567890', 'auto', ','), { kind: 'text', input: "'12345678901234567890" });
  assert.deepEqual(interpret('12345678000190', 'auto', ','), { kind: 'text', input: "'12345678000190" }, 'CNPJ');
  assert.deepEqual(interpret('1234567890', 'auto', ','), { kind: 'number', input: '1234567890' });
  assert.deepEqual(interpret('=1+1', 'auto', ','), { kind: 'text', input: "'=1+1" });
  assert.deepEqual(interpret('VERDADEIRO', 'auto', ','), { kind: 'text', input: "'VERDADEIRO" });
  assert.deepEqual(interpret('123', 'text', ','), { kind: 'text', input: "'123" });
  assert.deepEqual(interpret('São Paulo', 'auto', ','), { kind: 'text', input: 'São Paulo' });
  assert.deepEqual(interpret('', 'auto', ','), { kind: 'empty', input: null });
  assert.deepEqual(suggestColumnTypes([['Código', 'Valor', 'CPF'], ['00123', '10', '12345678901'], ['456', '20', '98765432100']]), ['text', 'auto', 'text']);
});

test('import into the engine and export back: types, codes, accents, quotes', async () => {
  const csv = 'Código;Cliente;Valor;Data;Obs\r\n00123;Ação Ltda;1.234,56;15/03/2024;"diz ""oi""; tchau"\r\n00456;Café;-2,5;2024-12-01;=HYPERLINK("x")\r\n';
  const options: DelimitedOptions = { encoding: 'utf-8', separator: ';', decimal: ',', header: true, columns: ['text', 'auto', 'auto', 'auto', 'auto'] };
  const { engine, rows: count, columns } = await WorkbookEngine.fromDelimited(ic, 'clientes', new TextEncoder().encode(csv), options);
  assert.deepEqual([count, columns], [3, 5]);
  assert.deepEqual(engine.sheets(), ['clientes']);
  assert.equal(engine.formatted(0, 2, 1), '00123');
  assert.equal(engine.formatted(0, 2, 3), '1234,56', 'a number in General format, as Excel opens a CSV');
  assert.equal(engine.formatted(0, 3, 3), '-2,5');
  assert.equal(engine.formatted(0, 3, 4), '01/12/2024');
  assert.equal(engine.formatted(0, 3, 5), '=HYPERLINK("x")', 'kept as text');
  assert.equal(engine.formatted(0, 2, 5), 'diz "oi"; tchau');
  assert.equal(engine.canUndo(), false, 'the import is not an undo step');
  engine.setInput(0, 4, 3, '=SOMA(C2:C3)');
  const out = engine.toDelimited(0, ';');
  assert.deepEqual([out.rows, out.columns], [4, 5]);
  assert.equal(out.text, serializeDelimited([
    ['Código', 'Cliente', 'Valor', 'Data', 'Obs'],
    ['00123', 'Ação Ltda', '1234,56', '15/03/2024', 'diz "oi"; tchau'],
    ['00456', 'Café', '-2,5', '01/12/2024', '=HYPERLINK("x")'],
    ['', '', '1232,06', '', ''],
  ], ';'));
  assert.ok(out.text.includes('"diz ""oi""; tchau"'));
});

test('export of a short, wide sheet: every column, one row', async () => {
  const engine = WorkbookEngine.create(ic);
  engine.setInput(0, 1, 1, 'início');
  engine.setInput(0, 1, 16_384, 'fim');
  const out = engine.toDelimited(0, ';');
  assert.deepEqual([out.rows, out.columns], [1, 16_384]);
  assert.equal(out.text, `início${';'.repeat(16_383)}fim\r\n`);
});

test('a file beyond the sheet limit is refused, not cut', async () => {
  const wide = Array.from({ length: 16_385 }, (_, i) => String(i)).join(';');
  await assert.rejects(
    WorkbookEngine.fromDelimited(ic, 'largo.csv', new TextEncoder().encode(wide), { encoding: 'utf-8', separator: ';', decimal: ',', header: false, columns: [] }),
    /mais de 16\.384 colunas/,
  );
});
