import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { StyleFlag, WorkbookEngine } from '../src/engine/workbook-engine.ts';
import { modelToXlsx, xlsxToModel } from '../src/engine/xlsx.ts';
import { keptFeatures, lostFeatures } from '../src/core/xlsx-report.ts';
import { ic } from './ironcalc-node.ts';
import { xlsxBridge } from './xlsx-node.ts';
import { unzip } from './zip.ts';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/xlsx/${name}`, import.meta.url)));

function open(bytes: Uint8Array, name = 'teste.xlsx') {
  const { model, report } = xlsxToModel(xlsxBridge, bytes, name);
  return { engine: WorkbookEngine.fromModelBytes(ic, model).engine, report };
}

const roundTrip = (engine: WorkbookEngine) => open(modelToXlsx(xlsxBridge, engine.modelBytes()));

/** The cells of the openpyxl fixture as Planilhas shows them, independent of who wrote the file. */
function assertBasic(engine: WorkbookEngine) {
  assert.deepEqual(engine.sheets(), ['Vendas', 'Resumo Geral']);
  assert.equal(engine.formatted(0, 2, 1), 'Sudeste');
  assert.equal(engine.formatted(0, 4, 1), 'São Paulo – Capital');
  assert.equal(engine.formatted(0, 2, 2), '00123', 'code kept as text with its leading zeros');
  assert.equal(engine.formatted(0, 2, 3), '15/03/2024');
  assert.equal(engine.formatted(0, 4, 5), 'R$ 1.234,56');
  assert.equal(engine.input(0, 2, 6), '=D2*E2');
  assert.equal(engine.formatted(0, 6, 6), 'R$ 1.319,26');
  assert.equal(engine.input(0, 6, 6), '=SOMA(F2:F4)');
  assert.equal(engine.input(0, 7, 5), '=MÉDIA(E2:E4)');
  assert.equal(engine.formatted(0, 8, 6), 'sim');
  assert.match(engine.input(0, 9, 6), /^=PROCV\("Nordeste";A2:F4;6;FALSO(\(\))?\)$/);
  assert.equal(engine.formatted(0, 9, 6), '25');
  assert.equal(engine.formatted(0, 10, 6), 'Sudeste / 00123');
  assert.equal(engine.formatted(0, 2, 7), 'VERDADEIRO');
  assert.equal(engine.input(1, 1, 2), '=Vendas!F6');
  assert.equal(engine.formatted(1, 2, 2), '4,5%');
  assert.equal(engine.input(1, 3, 2), '=CONT.VALORES(Vendas!A2:A4)');
  assert.equal(engine.formatted(1, 4, 2), '1234,5678');
  assert.equal(engine.formatted(1, 6, 2), '#DIV/0!');
  const header = engine.cellFormat(0, 1, 1);
  assert.equal(header.bold, true);
  assert.equal(header.align, 'center');
  // LibreOffice rewrites the codes (for example with a locale tag), so check what they show.
  assert.match(engine.cellFormat(0, 2, 5).numberFormatCode, /R\$/);
  assert.match(engine.cellFormat(0, 2, 3).numberFormatCode, /dd.mm.yyyy/i);
}

test('openpyxl file: values, types, formulas in pt-BR, sheets and basic formatting', () => {
  const { engine, report } = open(fixture('openpyxl-basico.xlsx'));
  assertBasic(engine);
  assert.equal(engine.cellFormat(0, 2, 5).numberFormat, 'currency');
  assert.equal(engine.cellFormat(0, 2, 3).numberFormat, 'date');
  assert.deepEqual(report.lost, {});
  assert.deepEqual(report.kept, {});
  assert.deepEqual([report.sheets, report.formulas], [2, 13]);
});

test('LibreOffice file: same content; its showGridLines="true" keeps the gridlines', () => {
  const { engine, report } = open(fixture('libreoffice-basico.xlsx'));
  assertBasic(engine);
  assert.equal(report.kept.gridlinesHidden, undefined);
  assert.deepEqual(Object.keys(report.lost), ['printSettings']);
});

test('Excel shared formulas are expanded with relative references', () => {
  const { engine } = open(fixture('excel-formulas-compartilhadas.xlsx'));
  assert.deepEqual([2, 3, 4].map(r => engine.input(0, r, 3)), ['=A2*B2', '=A3*B3', '=A4*B4']);
  assert.deepEqual([2, 3, 4].map(r => engine.formatted(0, r, 3)), ['6', '20', '42']);
});

test('features that are not kept are reported, the rest of the file opens', () => {
  const { engine, report } = open(fixture('openpyxl-recursos.xlsx'));
  assert.deepEqual(Object.keys(report.lost).sort(), ['autoFilter', 'charts', 'comments', 'dataValidation', 'drawings', 'tables']);
  for (const code of ['mergedCells', 'frozenPanes', 'columnWidths', 'fills', 'borders', 'fontStyles']) assert.ok(report.kept[code], code);
  assert.ok(lostFeatures(report).includes('gráficos'));
  assert.ok(keptFeatures(report).includes('células mescladas'));
  assert.equal(engine.formatted(0, 2, 3), '60');
  assert.deepEqual(engine.sheets(), ['Dados', 'Tabela', 'Filtro']);
  // Kept features survive an export (not shown by the grid, but in the file).
  const again = roundTrip(engine);
  for (const code of ['mergedCells', 'frozenPanes', 'columnWidths', 'fills', 'borders']) assert.ok(again.report.kept[code], `${code} after export`);
});

test('pt-BR typing is written as Excel formulas and read back the same', () => {
  const engine = WorkbookEngine.create(ic);
  engine.setInput(0, 1, 1, '1,5');
  engine.setInput(0, 2, 1, '2');
  engine.setInput(0, 3, 1, '=SOMA(A1:A2;2,25)');
  engine.setInput(0, 4, 1, '=SE(A3>5;"sim";"não")');
  engine.setInput(0, 5, 1, '=PROCV(2;A1:A2;1;FALSO)');
  engine.setInput(0, 6, 1, '=CONT.SE(A1:A2;">1")');
  engine.setInput(0, 7, 1, 'ação');
  engine.setInput(0, 8, 1, '15/03/2024');
  engine.format(0, { top: 1, left: 1, bottom: 1, right: 1 }, { kind: 'bold', value: true });
  engine.format(0, { top: 2, left: 1, bottom: 2, right: 1 }, { kind: 'number', value: 'currency' });
  engine.format(0, { top: 3, left: 1, bottom: 3, right: 1 }, { kind: 'align', value: 'right' });
  engine.addSheet();
  engine.setInput(1, 1, 1, '=Planilha1!A3*2');
  const xlsx = modelToXlsx(xlsxBridge, engine.modelBytes());
  const sheet = unzip(xlsx).get('xl/worksheets/sheet1.xml')!;
  for (const formula of ['SUM(A1:A2,2.25)', 'IF(A3&gt;5,&quot;sim&quot;,&quot;não&quot;)', 'VLOOKUP(2,A1:A2,1,FALSE)', 'COUNTIF(A1:A2,&quot;&gt;1&quot;)']) {
    assert.ok(sheet.includes(`<f>${formula}</f>`), `${formula} in ${sheet}`);
  }
  assert.ok(sheet.includes('<v>1.5</v>'), 'numbers use the file\'s decimal point');
  const { engine: back } = open(xlsx);
  for (let row = 1; row <= 8; row++) {
    assert.equal(back.input(0, row, 1), engine.input(0, row, 1), `A${row} input`);
    assert.equal(back.formatted(0, row, 1), engine.formatted(0, row, 1), `A${row} value`);
  }
  assert.deepEqual(back.sheets(), engine.sheets());
  assert.equal(back.input(1, 1, 1), '=Planilha1!A3*2');
  assert.equal(back.formatted(1, 1, 1), '11,5');
  assert.equal(back.cellFormat(0, 1, 1).bold, true);
  assert.equal(back.cellFormat(0, 2, 1).numberFormat, 'currency');
  assert.equal(back.cellFormat(0, 3, 1).align, 'right');
  assert.equal(back.viewport(0, 1, 1, 1, 1).styles[0] & StyleFlag.Bold, StyleFlag.Bold);
});

test('import, edit, export, reopen: the edit is in the file and the rest is unchanged', () => {
  const { engine } = open(fixture('openpyxl-basico.xlsx'));
  engine.setInput(0, 2, 4, '30');
  engine.setInput(0, 11, 1, 'Novo');
  engine.setInput(0, 11, 6, '=SOMASE(A2:A4;"Sudeste";F2:F4)');
  const { engine: back } = roundTrip(engine);
  assert.equal(back.formatted(0, 2, 6), 'R$ 597,00');
  assert.equal(back.formatted(0, 6, 6), 'R$ 1.856,56');
  assert.equal(back.input(0, 11, 6), '=SOMASE(A2:A4;"Sudeste";F2:F4)');
  assert.equal(back.formatted(0, 11, 6), '597');
  assert.equal(back.formatted(0, 2, 2), '00123');
  assert.equal(back.formatted(1, 1, 2), '1856,56', 'cross-sheet formula follows the edit');
});

test('functions IronCalc does not compute keep their formula text through import and export', () => {
  const engine = WorkbookEngine.create(ic);
  engine.setInput(0, 1, 1, '=PROCX(2;B1:B2;B1:B2)');
  const xlsx = modelToXlsx(xlsxBridge, engine.modelBytes());
  assert.ok(unzip(xlsx).get('xl/worksheets/sheet1.xml')!.includes('_xlfn.XLOOKUP(2,B1:B2,B1:B2)'));
  assert.equal(roundTrip(engine).engine.input(0, 1, 1), '=PROCX(2;B1:B2;B1:B2)');
});

test('a file that is not XLSX is refused with an error', () => {
  assert.throws(() => xlsxToModel(xlsxBridge, new TextEncoder().encode('Nome;Valor\nAna;1'), 'falso.xlsx'), /XLSX ilegível|Zip/);
});
