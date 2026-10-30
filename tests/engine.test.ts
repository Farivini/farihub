import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StyleFlag, WorkbookEngine } from '../src/engine/workbook-engine.ts';
import { pivotCell, EMPTY_LABEL } from '../src/core/pivot.ts';
import type { PivotConfig } from '../src/core/pivot.ts';
import { REGIONS, CHANNELS, syntheticTotals } from '../src/core/synthetic.ts';
import { ic, wasmMemoryBytes } from './ironcalc-node.ts';

const byRegion: PivotConfig = { rows: ['Região'], columns: [], values: [{ field: 'Receita', aggregation: 'sum' }], filters: [] };

function salesSheet(): WorkbookEngine {
  const engine = WorkbookEngine.create(ic);
  engine.paste(0, { row: 1, column: 1 }, 'Região\tReceita\nSul\t10,5\nNorte\t20\nSul\t5');
  return engine;
}

test('typing, accents, recalculation and formula bar text', () => {
  const engine = WorkbookEngine.create(ic);
  engine.setInput(0, 1, 1, 'Ação São João ç ü');
  engine.setInput(0, 2, 1, '10');
  engine.setInput(0, 3, 1, '=A2*2');
  assert.equal(engine.formatted(0, 1, 1), 'Ação São João ç ü');
  assert.equal(engine.formatted(0, 3, 1), '20');
  engine.setInput(0, 2, 1, '2,5');
  assert.equal(engine.formatted(0, 3, 1), '5', 'dependent formula recalculated after edit');
  assert.equal(engine.input(0, 3, 1), '=A2*2');
});

test('external paste is one undo step; internal paste moves relative references', () => {
  const engine = WorkbookEngine.create(ic);
  engine.paste(0, { row: 1, column: 1 }, 'ação\t"a\tb"\n1,5\t=SOMA(A2;1)');
  assert.equal(engine.formatted(0, 1, 2), 'a\tb');
  assert.equal(engine.formatted(0, 2, 2), '2,5');
  assert.equal(engine.input(0, 2, 2), '=SOMA(A2;1)');
  engine.undo();
  assert.equal(engine.formatted(0, 1, 1), '');
  assert.equal(engine.formatted(0, 2, 2), '');
  engine.redo();
  assert.equal(engine.formatted(0, 1, 1), 'ação');

  const tsv = engine.copy(0, { top: 2, left: 1, bottom: 2, right: 2 });
  assert.equal(tsv, '1,5\t2,5', 'other apps receive displayed values');
  engine.paste(0, { row: 5, column: 1 }, tsv);
  assert.equal(engine.input(0, 5, 2), '=SOMA(A5;1)', 'reference moved with the paste');
  engine.setInput(0, 5, 1, '10');
  assert.equal(engine.formatted(0, 5, 2), '11');
  engine.paste(0, { row: 7, column: 1 }, '1,5\t2,5 alterado');
  assert.equal(engine.formatted(0, 7, 2), '2,5 alterado', 'changed text is pasted as external text');
});

test('each mirrored operation is exactly one engine undo step', () => {
  const engine = salesSheet();
  engine.setInput(0, 2, 2, '99');
  engine.clear(0, { top: 3, left: 1, bottom: 4, right: 2 });
  engine.paste(0, { row: 10, column: 1 }, 'x\ty');
  const internal = engine.copy(0, { top: 10, left: 1, bottom: 10, right: 2 });
  engine.paste(0, { row: 12, column: 1 }, internal);
  for (let i = 0; i < 4; i++) assert.ok(engine.undo(), `undo ${i}`);
  assert.deepEqual([engine.formatted(0, 2, 2), engine.formatted(0, 3, 1), engine.formatted(0, 10, 1), engine.formatted(0, 12, 1)], ['10,5', 'Norte', '', '']);
  assert.ok(engine.undo(), 'initial paste');
  assert.equal(engine.formatted(0, 1, 1), '');
  assert.equal(engine.undo(), null, 'mirror exhausted');
});

test('pivot snapshot follows edits, pastes, clears, appends, undo and formulas', async () => {
  const engine = salesSheet();
  const sul = async () => {
    const result = await engine.pivot(byRegion);
    const index = result.rowGroups.findIndex(g => g[0] === 'Sul');
    return { sul: index < 0 ? 0 : pivotCell(result, index, 0, 0), total: pivotCell(result, result.rowGroups.length, 0, 0), groups: result.rowGroups.map(g => g[0]) };
  };
  assert.deepEqual(await sul(), { sul: 15.5, total: 35.5, groups: ['Norte', 'Sul'] });
  engine.setInput(0, 4, 2, '6');
  assert.equal((await sul()).sul, 16.5);
  engine.setInput(0, 3, 1, 'Sul');
  assert.deepEqual(await sul(), { sul: 36.5, total: 36.5, groups: ['Sul'] });
  engine.undo();
  assert.deepEqual(await sul(), { sul: 16.5, total: 36.5, groups: ['Norte', 'Sul'] });
  engine.paste(0, { row: 5, column: 1 }, 'Sul\t100\nCentro-Oeste\t1');
  assert.deepEqual(await sul(), { sul: 116.5, total: 137.5, groups: ['Centro-Oeste', 'Norte', 'Sul'] });
  engine.clear(0, { top: 6, left: 1, bottom: 6, right: 2 });
  assert.deepEqual(await sul(), { sul: 116.5, total: 136.5, groups: ['Norte', 'Sul'] });
  engine.setInput(0, 7, 2, '=B2*2');
  assert.equal((await sul()).total, 136.5 + 21, 'appended row with empty region');
  engine.setInput(0, 2, 2, '1');
  assert.equal((await sul()).total, 1 + 20 + 6 + 100 + 2, 'formula column re-read after the cell it depends on changed');
  engine.setInput(0, 1, 2, 'Valor');
  await assert.rejects(engine.pivot(byRegion), /Campo inexistente: Receita/);
  const renamed = await engine.pivot({ ...byRegion, values: [{ field: 'Valor', aggregation: 'count' }] });
  assert.equal(pivotCell(renamed, renamed.rowGroups.length, 0, 0), 5);
  assert.ok(renamed.rowGroups.some(g => g[0] === EMPTY_LABEL));
});

test('save and reopen keeps values, formulas, accents and sheets; corruption is detected', () => {
  const engine = salesSheet();
  engine.setInput(0, 1, 4, '=SOMASE(A2:A4;"Sul";B2:B4)');
  engine.addSheet();
  engine.setInput(1, 1, 1, 'Observação: preço médio');
  const file = engine.toFile({ pivots: [byRegion] });
  const { engine: reopened, header } = WorkbookEngine.fromFile(ic, file);
  assert.deepEqual(reopened.sheets(), ['Planilha1', 'Planilha2']);
  assert.equal(reopened.input(0, 1, 4), '=SOMASE(A2:A4;"Sul";B2:B4)');
  assert.equal(reopened.formatted(0, 1, 4), '15,5');
  assert.equal(reopened.formatted(1, 1, 1), 'Observação: preço médio');
  assert.deepEqual(header.app, { pivots: [byRegion] });
  for (let row = 1; row <= 4; row++) for (let col = 1; col <= 4; col++) {
    assert.equal(reopened.input(0, row, col), engine.input(0, row, col));
    assert.equal(reopened.formatted(0, row, col), engine.formatted(0, row, col));
  }
  reopened.setInput(0, 2, 2, '0');
  assert.equal(reopened.formatted(0, 1, 4), '5', 'reopened workbook recalculates');
  const corrupted = file.slice();
  corrupted[corrupted.length - 10] ^= 0xff;
  assert.throws(() => WorkbookEngine.fromFile(ic, corrupted), /CRC32/);
});

test('ctrl+arrow navigation follows Excel block edges', () => {
  const engine = WorkbookEngine.create(ic);
  for (const row of [1, 2, 3, 10]) engine.setInput(0, row, 1, 'x');
  assert.deepEqual(engine.edge(0, { row: 1, column: 1 }, 'down'), { row: 3, column: 1 });
  assert.deepEqual(engine.edge(0, { row: 3, column: 1 }, 'down'), { row: 10, column: 1 });
  assert.deepEqual(engine.edge(0, { row: 10, column: 1 }, 'down'), { row: 1_048_576, column: 1 });
  assert.deepEqual(engine.edge(0, { row: 10, column: 1 }, 'up'), { row: 3, column: 1 });
  assert.deepEqual(engine.edge(0, { row: 1, column: 5 }, 'left'), { row: 1, column: 1 });
});

test('synthetic base matches the independent expectation (5,000 rows)', async () => {
  const rows = 5_000;
  const { engine, report } = await WorkbookEngine.generateSynthetic(ic, rows, 7, { chunk: 2_000, memoryBytes: wasmMemoryBytes });
  const expected = syntheticTotals(rows, 7);
  assert.deepEqual(engine.sheets(), ['Dados', 'Resumo']);
  assert.equal(report.formulas, 3);
  assert.equal(engine.input(1, 1, 2), `=SOMA(Dados!E2:E${rows + 1})`);
  const money = (cents: number) => (cents / 100).toFixed(2).replace('.', ',').replace(/,?0+$/, '');
  assert.equal(engine.formatted(1, 1, 2), money(expected.revenueCents), 'shown with at most 15 significant digits');
  assert.equal(engine.formatted(1, 3, 2), String(rows));
  const result = await engine.pivot({ rows: ['Região'], columns: ['Canal'], values: [{ field: 'Receita', aggregation: 'sum' }, { field: 'Receita', aggregation: 'count' }], filters: [] });
  REGIONS.forEach(region => {
    const r = result.rowGroups.findIndex(g => g[0] === region);
    assert.equal(Math.round(pivotCell(result, r, result.columnGroups.length, 0) * 100), expected.revenueCentsByRegion[REGIONS.indexOf(region)]);
    CHANNELS.forEach(channel => {
      const c = result.columnGroups.findIndex(g => g[0] === channel);
      assert.equal(pivotCell(result, r, c, 1), expected.rowsByRegionChannel[REGIONS.indexOf(region)][CHANNELS.indexOf(channel)]);
    });
  });
  assert.equal(engine.canUndo(), false, 'generation steps are not undoable edits');
});

test('formatting: bold, alignment and number formats are styles, undoable and saved', () => {
  const engine = salesSheet();
  engine.format(0, { top: 2, left: 2, bottom: 4, right: 2 }, { kind: 'number', value: 'currency' });
  engine.format(0, { top: 1, left: 1, bottom: 1, right: 2 }, { kind: 'bold', value: true });
  engine.format(0, { top: 1, left: 2, bottom: 1, right: 2 }, { kind: 'align', value: 'center' });
  assert.equal(engine.formatted(0, 2, 2), 'R$ 10,50');
  assert.deepEqual(engine.cellFormat(0, 1, 2), { bold: true, align: 'center', numberFormat: 'general', numberFormatCode: 'general' });
  assert.equal(engine.cellFormat(0, 2, 2).numberFormat, 'currency');
  const view = engine.viewport(0, 1, 1, 2, 2);
  assert.deepEqual([...view.styles], [StyleFlag.Bold, StyleFlag.Bold | (2 << StyleFlag.AlignShift), 0, 0]);
  const reopened = WorkbookEngine.fromFile(ic, engine.toFile({})).engine;
  assert.equal(reopened.formatted(0, 2, 2), 'R$ 10,50');
  assert.equal(reopened.cellFormat(0, 1, 1).bold, true);
  engine.undo();
  assert.equal(engine.cellFormat(0, 1, 2).align, 'general');
  engine.undo();
  assert.equal(engine.cellFormat(0, 1, 1).bold, false);
  engine.undo();
  assert.equal(engine.formatted(0, 2, 2), '10,5');
  assert.equal(engine.input(0, 2, 2), '10,5', 'value unchanged by formatting');
});

test('formatting a whole column only touches the rows with data; huge ranges are refused', () => {
  const engine = salesSheet();
  const change = engine.format(0, { top: 1, left: 2, bottom: 1_048_576, right: 2 }, { kind: 'bold', value: true });
  assert.deepEqual(change.rect, { top: 1, left: 2, bottom: 4, right: 2 });
  assert.throws(() => engine.format(0, { top: 1, left: 1, bottom: 300_000, right: 1 }, { kind: 'bold', value: true }), /grande demais/);
  // Data beyond the first 256 columns or 4,096 rows still bounds the range.
  engine.setInput(0, 10, 257, 'IW10');
  engine.setInput(0, 5_000, 300, 'longe');
  assert.deepEqual(engine.format(0, { top: 1, left: 1, bottom: 1_048_576, right: 257 }, { kind: 'bold', value: true }).rect,
    { top: 1, left: 1, bottom: 10, right: 257 });
  assert.equal(engine.cellFormat(0, 10, 257).bold, true);
  assert.deepEqual(engine.format(0, { top: 4_990, left: 1, bottom: 5_010, right: 16_384 }, { kind: 'bold', value: true }).rect,
    { top: 4_990, left: 1, bottom: 5_010, right: 300 });
  assert.equal(engine.cellFormat(0, 5_000, 300).bold, true);
});
