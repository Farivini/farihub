import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WorkbookEngine } from '../src/engine/workbook-engine.ts';
import { modelToXlsx, xlsxToModel } from '../src/engine/xlsx.ts';
import { RowMap, deleteRowsInRanges, insertRowsInRanges, rangesFromFlags, replaceRanges } from '../src/core/row-map.ts';
import { editedCriterion, parseFilters, sortOrder } from '../src/core/table-ops.ts';
import type { KeyColumn, TableOperation } from '../src/core/table-ops.ts';
import { saveLosses } from '../src/core/save-plan.ts';
import { decodeFarcel } from '../src/core/file-format.ts';
import type { PivotConfig } from '../src/core/pivot.ts';
import { ic } from './ironcalc-node.ts';
import { xlsxBridge } from './xlsx-node.ts';
import { unzip } from './zip.ts';

WorkbookEngine.bridge = xlsxBridge;

const table = (top: number, left: number, bottom: number, right: number) => ({ top, left, bottom, right });

/** Values of a block as displayed, row by row. */
function shown(engine: WorkbookEngine, sheet: number, rect: ReturnType<typeof table>): string[][] {
  const view = engine.viewport(sheet, rect.top, rect.left, rect.bottom - rect.top + 1, rect.right - rect.left + 1);
  return Array.from({ length: view.rows }, (_, r) => view.values.slice(r * view.columns, (r + 1) * view.columns));
}

/** A small sales table: header in row 1, five records, a total formula per row and a bold cell. */
function sales(): WorkbookEngine {
  const engine = WorkbookEngine.create(ic);
  engine.paste(0, { row: 1, column: 1 }, [
    'Nome\tRegião\tQtd\tPreço\tTotal\tData',
    'Érica\tSul\t3\t10\t=C2*D2\t15/03/2026',
    'ana\tNorte\t1\t5\t=C3*D3\t02/01/2026',
    'Bruno\tSul\t2\t7,5\t=C4*D4\t',
    'Ana\tLeste\t2\t5\t=C5*D5\t28/02/2026',
    'Carla\tNorte\t\t20\t=C6*D6\t10/10/2025',
  ].join('\n'));
  engine.format(0, table(4, 1, 4, 1), { kind: 'bold', value: true }); // Bruno in bold
  return engine;
}

const sortOp = (keys: Array<{ column: number; descending?: boolean }>, header = true): TableOperation =>
  ({ kind: 'sort', sheet: 0, range: table(1, 1, 6, 6), header, keys });

// ------------------------------------------------------------------ pure helpers

test('sort order: numbers, text, booleans, errors; empty last both ways; stable; several keys', () => {
  const key = (kinds: number[], numbers: number[], texts: string[], descending = false): KeyColumn =>
    ({ kinds: Uint8Array.from(kinds), numbers: Float64Array.from(numbers), texts, descending });
  // 0: "b", 1: 10, 2: empty, 3: "Á", 4: 2, 5: TRUE, 6: #N/D, 7: "a", 8: 2 (duplicate of 4)
  const kinds = [2, 1, 0, 2, 1, 3, 4, 2, 1];
  const numbers = [0, 10, 0, 0, 2, 1, 0, 0, 2];
  const texts = ['b', '', '', 'Á', '', '', '', 'a', ''];
  assert.deepEqual([...sortOrder([key(kinds, numbers, texts)])], [4, 8, 1, 7, 3, 0, 5, 6, 2], 'ascending; a before Á; equal 2s keep their order');
  assert.deepEqual([...sortOrder([key(kinds, numbers, texts, true)])], [6, 5, 0, 3, 7, 1, 4, 8, 2], 'descending; empty still last');
  // Case is ignored: "ana" and "Ana" are equal and keep their order.
  assert.deepEqual([...sortOrder([key([2, 2, 2], [0, 0, 0], ['ana', 'Bia', 'Ana'])])], [0, 2, 1]);
  // Second key breaks ties of the first.
  const region = key([2, 2, 2, 2], [0, 0, 0, 0], ['Sul', 'Norte', 'Sul', 'Norte']);
  const value = key([1, 1, 1, 1], [1, 2, 3, 4], ['', '', '', ''], true);
  assert.deepEqual([...sortOrder([region, value])], [3, 1, 2, 0]);
});

test('row map: display indexes skip hidden rows; ranges follow insertions and deletions', () => {
  const map = new RowMap(Int32Array.from([3, 4, 8, 8]), 10);
  assert.equal(map.count, 7);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(i => map.rowAt(i)), [1, 2, 5, 6, 7, 9, 10]);
  assert.equal(map.indexOf(5), 3);
  assert.equal(map.indexOf(4), 3, 'a hidden row maps to the next shown one');
  assert.equal(map.indexAtOrBefore(4), 2);
  assert.equal(map.step(2, 1), 5);
  assert.equal(map.step(5, -1), 2);
  assert.equal(map.step(9, -1), 7);
  assert.ok(map.gapBefore(5) && map.gapBefore(9) && !map.gapBefore(6));
  assert.deepEqual([...rangesFromFlags(10, [0, 1, 1, 0, 1])], [11, 12, 14, 14]);
  assert.deepEqual([...replaceRanges(Int32Array.from([1, 10]), 4, 6, Int32Array.from([5, 5]))], [1, 3, 5, 5, 7, 10]);
  assert.deepEqual([...insertRowsInRanges(Int32Array.from([3, 5]), 4, 2)], [3, 3, 6, 7]);
  assert.deepEqual([...deleteRowsInRanges(Int32Array.from([3, 5, 9, 9]), 4, 3)], [3, 3, 6, 6]);
});

test('a filter list keeps the criterion of values it does not show', () => {
  const shown = (pairs: Array<[string, boolean]>, truncated: boolean) =>
    ({ values: pairs.map(([text, selected]) => ({ text, count: 1, selected })), truncated });
  const none = new Map<string, boolean>();
  // A value beyond the first page was chosen with a search; reopening and applying keeps it.
  const far = { column: 1, mode: 'include' as const, values: ['v1500'] };
  assert.deepEqual(editedCriterion(far, shown([['v1', false], ['v2', false]], true), 'current', none, false), { mode: 'include', values: ['v1500'] });
  // Checking a listed value adds it; values beyond the list stay as they were.
  assert.deepEqual(editedCriterion(far, shown([['v1', false]], true), 'current', new Map([['v1', true]]), false), { mode: 'include', values: ['v1500', 'v1'] });
  const excluded = { column: 1, mode: 'exclude' as const, values: ['v1500', 'v2'] };
  assert.deepEqual(editedCriterion(excluded, shown([['v1', true], ['v2', false]], true), 'current', new Map([['v2', true]]), false), { mode: 'exclude', values: ['v1500'] });
  // "Select all" covers values beyond the list too.
  assert.equal(editedCriterion(excluded, shown([['v1', true]], true), 'all', none, false), null);
  assert.deepEqual(editedCriterion(excluded, shown([['v1', true]], true), 'none', new Map([['v1', true]]), false), { mode: 'include', values: ['v1'] });
  // A complete list: the smaller of the two sets is kept.
  assert.deepEqual(editedCriterion(undefined, shown([['a', true], ['b', true], ['c', true]], false), 'current', new Map([['c', false]]), false), { mode: 'exclude', values: ['c'] });
  assert.deepEqual(editedCriterion(undefined, shown([['a', true], ['b', true], ['c', true]], false), 'none', new Map([['a', true]]), false), { mode: 'include', values: ['a'] });
  assert.equal(editedCriterion(undefined, shown([['a', true]], false), 'current', none, false), null);
  // With a search, the checked results (as Excel), using each value's current state.
  assert.deepEqual(editedCriterion(far, shown([['v1500', true], ['v150', false]], false), 'current', none, true), { mode: 'include', values: ['v1500'] });
});

test('saved filters are validated when a file is opened', () => {
  const good = { range: table(1, 1, 5, 3), criteria: [{ column: 2, mode: 'include', values: ['Sul', ''] }] };
  assert.deepEqual(parseFilters([[good], []]), [[good], []]);
  assert.deepEqual(parseFilters('x'), []);
  assert.deepEqual(parseFilters([[{ range: table(1, 1, 5, 3), criteria: [{ column: 'B', mode: 'include', values: [] }] }, { range: {} }]]), [[]]);
});

// ------------------------------------------------------------------ sort

test('sort moves whole records: values, formulas, styles; header stays; empty last', () => {
  const engine = sales();
  engine.apply(sortOp([{ column: 1 }]));
  assert.deepEqual(shown(engine, 0, table(1, 1, 6, 6)), [
    ['Nome', 'Região', 'Qtd', 'Preço', 'Total', 'Data'],
    ['ana', 'Norte', '1', '5', '5', '02/01/2026'],
    ['Ana', 'Leste', '2', '5', '10', '28/02/2026'],
    ['Bruno', 'Sul', '2', '7,5', '15', ''],
    ['Carla', 'Norte', '', '20', '0', '10/10/2025'],
    ['Érica', 'Sul', '3', '10', '30', '15/03/2026'],
  ], 'case ignored (ana, Ana keep their order), É sorts as E');
  assert.equal(engine.input(0, 4, 5), '=C4*D4', 'the moved formula reads its own row');
  assert.equal(engine.cellFormat(0, 4, 1).bold, true, 'bold moved with Bruno');
  assert.equal(engine.cellFormat(0, 2, 1).bold, false);
});

test('sort by numbers and by dates, descending, empty cells last', () => {
  const engine = sales();
  engine.apply(sortOp([{ column: 3, descending: true }]));
  assert.deepEqual(shown(engine, 0, table(2, 1, 6, 1)).flat(), ['Érica', 'Bruno', 'Ana', 'ana', 'Carla'], 'Qtd 3, 2, 2, 1, empty');
  engine.apply(sortOp([{ column: 6 }]));
  assert.deepEqual(shown(engine, 0, table(2, 6, 6, 6)).flat(), ['10/10/2025', '02/01/2026', '28/02/2026', '15/03/2026', ''], 'dates in time order');
});

test('sort by several columns and without a header row', () => {
  const engine = sales();
  engine.apply(sortOp([{ column: 2 }, { column: 5, descending: true }]));
  assert.deepEqual(shown(engine, 0, table(2, 1, 6, 2)), [
    ['Ana', 'Leste'], ['ana', 'Norte'], ['Carla', 'Norte'], ['Érica', 'Sul'], ['Bruno', 'Sul'],
  ]);
  const plain = WorkbookEngine.create(ic);
  plain.paste(0, { row: 1, column: 1 }, 'c\t3\na\t1\nb\t2');
  plain.apply({ kind: 'sort', sheet: 0, range: table(1, 1, 3, 2), header: false, keys: [{ column: 2 }] });
  assert.deepEqual(shown(plain, 0, table(1, 1, 3, 2)), [['a', '1'], ['b', '2'], ['c', '3']]);
});

test('formulas after a sort: relative references keep their offset, absolute and outside ones stay', () => {
  const engine = WorkbookEngine.create(ic);
  engine.paste(0, { row: 1, column: 1 }, [
    'Item\tValor\tDobro\tAcumulado\tTaxa',
    'b\t20\t=B2*2\t=B2\t=B2*$F$1',
    'c\t30\t=B3*2\t=D2+B3\t=B3*$F$1',
    'a\t10\t=B4*2\t=D3+B4\t=B4*$F$1',
  ].join('\n'));
  engine.setInput(0, 1, 6, '0,5');
  engine.addSheet();
  engine.setInput(1, 1, 1, '=Planilha1!B2');
  engine.apply({ kind: 'sort', sheet: 0, range: table(1, 1, 4, 5), header: true, keys: [{ column: 1 }] });
  assert.deepEqual(shown(engine, 0, table(2, 1, 4, 3)), [['a', '10', '20'], ['b', '20', '40'], ['c', '30', '60']]);
  assert.equal(engine.input(0, 2, 3), '=B2*2', 'same-row reference: still its own row');
  assert.equal(engine.input(0, 2, 5), '=B2*$F$1', 'absolute reference unchanged');
  assert.equal(engine.formatted(0, 2, 5), '5');
  // A reference to the previous row keeps pointing one row up, as in Excel: a running total
  // is no longer a running total after sorting, and the first one reads the header.
  assert.equal(engine.input(0, 2, 4), '=D1+B2');
  assert.equal(engine.formatted(0, 2, 4), '#VALOR!');
  assert.equal(engine.input(0, 3, 4), '=B3');
  assert.equal(engine.input(0, 4, 4), '=D3+B4');
  // A reference from another sheet points at the cell, not at the record.
  assert.equal(engine.input(1, 1, 1), '=Planilha1!B2');
  assert.equal(engine.formatted(1, 1, 1), '10');
});

test('undo and redo of a sort restore values, formulas and styles', () => {
  const engine = sales();
  const before = shown(engine, 0, table(1, 1, 6, 6));
  engine.apply(sortOp([{ column: 4, descending: true }]));
  const after = shown(engine, 0, table(1, 1, 6, 6));
  assert.notDeepEqual(after, before);
  engine.undo();
  assert.deepEqual(shown(engine, 0, table(1, 1, 6, 6)), before);
  assert.equal(engine.input(0, 4, 5), '=C4*D4');
  assert.equal(engine.cellFormat(0, 4, 1).bold, true);
  engine.redo();
  assert.deepEqual(shown(engine, 0, table(1, 1, 6, 6)), after);
  // Edits made before the sort can still be undone after undoing it.
  engine.undo();
  engine.undo(); // the bold
  assert.equal(engine.cellFormat(0, 4, 1).bold, false);
});

test('a range with merged cells is not sorted (and nothing changes)', () => {
  const { model } = xlsxToModel(xlsxBridge, new Uint8Array(readFileSync(new URL('./fixtures/xlsx/openpyxl-recursos.xlsx', import.meta.url))), 'r.xlsx');
  const engine = WorkbookEngine.fromModelBytes(ic, model).engine;
  engine.loadLayout();
  // Sheet "Dados" of the fixture merges A6:C6.
  const before = shown(engine, 0, table(1, 1, 7, 3));
  assert.throws(() => engine.apply({ kind: 'sort', sheet: 0, range: table(1, 1, 7, 3), header: true, keys: [{ column: 1, descending: true }] }), /mescladas/);
  assert.deepEqual(shown(engine, 0, table(1, 1, 7, 3)), before);
  assert.equal(engine.canUndo(), false);
});

test('current region: the connected block around a cell, diagonals included', () => {
  const engine = WorkbookEngine.create(ic);
  const cells: Array<[number, number, string]> = [[2, 2, 'a'], [2, 3, 'b'], [2, 4, 'c'], [3, 2, '1'], [3, 4, '3'], [5, 2, '4'], [5, 3, '5'], [5, 4, '6'], [6, 5, 'x'], [9, 2, 'longe']];
  for (const [row, column, text] of cells) engine.setInput(0, row, column, text);
  assert.deepEqual(engine.region(0, { row: 3, column: 3 }), table(2, 2, 3, 4), 'an empty row ends the block');
  assert.deepEqual(engine.region(0, { row: 5, column: 3 }), table(5, 2, 6, 5), 'E6 touches D5 diagonally');
  assert.deepEqual(engine.region(0, { row: 9, column: 2 }), table(9, 2, 9, 2));
  assert.deepEqual(engine.region(0, { row: 20, column: 20 }), table(20, 20, 20, 20));
});

// ------------------------------------------------------------------ filters

test('filter hides rows without deleting data; values list, search, empty cells and clearing', () => {
  const engine = sales();
  engine.apply({ kind: 'setFilter', sheet: 0, range: table(1, 1, 6, 6), criteria: [] });
  const values = engine.filterValues(0, 2);
  assert.deepEqual(values.values.map(v => [v.text, v.count, v.selected]), [['Leste', 1, true], ['Norte', 2, true], ['Sul', 2, true]]);
  assert.deepEqual(engine.filterValues(0, 3).values.map(v => v.text), ['1', '2', '3', ''], 'numbers in numeric order, empty last');
  assert.deepEqual(engine.filterValues(0, 1, 'ANA').values.map(v => v.text), ['ana', 'Ana'], 'search ignores case');
  assert.deepEqual(engine.filterValues(0, 1, 'erica').values.map(v => v.text), ['Érica'], 'search ignores accents');

  engine.apply({ kind: 'setFilter', sheet: 0, range: table(1, 1, 6, 6), criteria: [{ column: 2, mode: 'include', values: ['Norte'] }] });
  assert.deepEqual([...engine.rowLayout(0).hidden], [2, 2, 4, 5]);
  assert.equal(engine.formatted(0, 2, 1), 'Érica', 'hidden rows keep their data');
  assert.deepEqual(engine.filterValues(0, 2).values.map(v => v.selected), [false, true, false]);
  // Two criteria: Norte and an empty Qtd.
  engine.apply({ kind: 'setFilter', sheet: 0, range: table(1, 1, 6, 6), criteria: [
    { column: 2, mode: 'include', values: ['Norte'] }, { column: 3, mode: 'include', values: [''] },
  ] });
  assert.deepEqual([...engine.rowLayout(0).hidden], [2, 5]);
  // exclude mode
  engine.apply({ kind: 'setFilter', sheet: 0, range: table(1, 1, 6, 6), criteria: [{ column: 2, mode: 'exclude', values: ['Sul'] }] });
  assert.deepEqual([...engine.rowLayout(0).hidden], [2, 2, 4, 4]);

  engine.apply({ kind: 'clearFilter', sheet: 0 });
  assert.deepEqual([...engine.rowLayout(0).hidden], []);
  assert.equal(engine.rowLayout(0).filter, null);
  assert.deepEqual(shown(engine, 0, table(2, 1, 6, 1)).flat(), ['Érica', 'ana', 'Bruno', 'Ana', 'Carla']);
});

test('with a filter, copy and clear touch only the shown rows; undo brings the filter back', () => {
  const engine = sales();
  engine.apply({ kind: 'setFilter', sheet: 0, range: table(1, 1, 6, 6), criteria: [{ column: 2, mode: 'include', values: ['Sul'] }] });
  assert.equal(engine.copy(0, table(1, 1, 6, 2)), 'Nome\tRegião\nÉrica\tSul\nBruno\tSul');
  engine.clear(0, table(2, 3, 6, 3));
  assert.deepEqual(shown(engine, 0, table(2, 3, 6, 3)).flat(), ['', '1', '', '2', ''], 'hidden rows keep Qtd');
  engine.undo();
  assert.deepEqual(shown(engine, 0, table(2, 3, 6, 3)).flat(), ['3', '1', '2', '2', '']);
  engine.undo(); // the filter
  assert.equal(engine.rowLayout(0).filter, null);
  assert.deepEqual([...engine.rowLayout(0).hidden], []);
  engine.redo();
  assert.deepEqual([...engine.rowLayout(0).hidden], [3, 3, 5, 6]);
});

test('sorting a filtered table moves hidden rows with their records (the filter still holds)', () => {
  const engine = sales();
  engine.apply({ kind: 'setFilter', sheet: 0, range: table(1, 1, 6, 6), criteria: [{ column: 2, mode: 'exclude', values: ['Norte'] }] });
  engine.apply(sortOp([{ column: 1 }]));
  // Sorted: ana(Norte), Ana(Leste), Bruno(Sul), Carla(Norte), Érica(Sul)
  assert.deepEqual([...engine.rowLayout(0).hidden], [2, 2, 5, 5]);
  const regions = shown(engine, 0, table(2, 2, 6, 2)).flat();
  const hidden = new Set([2, 5]);
  assert.ok(regions.every((region, i) => (region === 'Norte') === hidden.has(i + 2)));
});

// ------------------------------------------------------------------ insert and delete

test('inserting rows and columns updates references in other sheets; undo and redo', () => {
  const engine = sales();
  engine.addSheet();
  engine.setInput(1, 1, 1, '=SOMA(Planilha1!E2:E6)');
  engine.setInput(1, 2, 1, '=Planilha1!F2');
  assert.equal(engine.formatted(1, 1, 1), '60');
  engine.apply({ kind: 'insertRows', sheet: 0, at: 3, count: 2 });
  assert.equal(engine.input(1, 1, 1), '=SOMA(Planilha1!E2:E8)');
  assert.equal(engine.formatted(0, 5, 1), 'ana');
  assert.equal(engine.input(0, 5, 5), '=C5*D5');
  engine.setInput(0, 3, 5, '100');
  assert.equal(engine.formatted(1, 1, 1), '160', 'new rows inside the range are summed');
  engine.apply({ kind: 'insertColumns', sheet: 0, at: 1, count: 1 });
  assert.equal(engine.input(1, 1, 1), '=SOMA(Planilha1!F2:F8)');
  assert.equal(engine.input(1, 2, 1), '=Planilha1!G2');
  engine.undo();
  engine.undo();
  engine.undo();
  assert.equal(engine.input(1, 1, 1), '=SOMA(Planilha1!E2:E6)');
  assert.equal(engine.formatted(1, 1, 1), '60');
  engine.redo();
  assert.equal(engine.input(1, 1, 1), '=SOMA(Planilha1!E2:E8)');
});

test('deleting rows and columns: references shrink or become #REF!; undo restores the formulas', () => {
  const engine = sales();
  engine.addSheet();
  engine.setInput(1, 1, 1, '=SOMA(Planilha1!E2:E6)');
  engine.setInput(1, 2, 1, '=Planilha1!A3');
  engine.setInput(1, 3, 1, '=Planilha1!F2');
  engine.apply({ kind: 'deleteRows', sheet: 0, at: 3, count: 2 });
  assert.equal(engine.input(1, 1, 1), '=SOMA(Planilha1!E2:E4)');
  assert.equal(engine.formatted(1, 1, 1), '40');
  assert.equal(engine.input(1, 2, 1), '=#REF!');
  assert.equal(engine.formatted(0, 3, 1), 'Ana');
  engine.undo();
  // IronCalc's own undo would leave #REF! here; the previous model is restored instead.
  assert.equal(engine.input(1, 2, 1), '=Planilha1!A3');
  assert.equal(engine.formatted(1, 2, 1), 'ana');
  assert.equal(engine.input(1, 1, 1), '=SOMA(Planilha1!E2:E6)');
  assert.equal(engine.cellFormat(0, 4, 1).bold, true);
  engine.redo();
  assert.equal(engine.input(1, 2, 1), '=#REF!');
  engine.undo();
  engine.apply({ kind: 'deleteColumns', sheet: 0, at: 5, count: 2 });
  assert.equal(engine.input(1, 3, 1), '=#REF!');
  assert.equal(engine.formatted(0, 1, 5), '');
  engine.undo();
  assert.equal(engine.input(1, 3, 1), '=Planilha1!F2');
  assert.equal(engine.input(0, 2, 5), '=C2*D2');
});

test('insert and delete keep the filter and hidden rows in place', () => {
  const engine = sales();
  engine.apply({ kind: 'setFilter', sheet: 0, range: table(1, 1, 6, 6), criteria: [{ column: 2, mode: 'include', values: ['Sul'] }] });
  engine.apply({ kind: 'insertRows', sheet: 0, at: 1, count: 1 });
  assert.deepEqual(engine.rowLayout(0).filter?.range, table(2, 1, 7, 6));
  assert.deepEqual([...engine.rowLayout(0).hidden], [4, 4, 6, 7]);
  engine.apply({ kind: 'deleteRows', sheet: 0, at: 3, count: 1 }); // Érica
  assert.deepEqual(engine.rowLayout(0).filter?.range, table(2, 1, 6, 6));
  assert.deepEqual([...engine.rowLayout(0).hidden], [3, 3, 5, 6]);
  engine.apply({ kind: 'deleteColumns', sheet: 0, at: 1, count: 1 });
  assert.deepEqual(engine.rowLayout(0).filter?.criteria, [{ column: 1, mode: 'include', values: ['Sul'] }]);
  engine.apply({ kind: 'deleteRows', sheet: 0, at: 2, count: 1 }); // the header row
  assert.equal(engine.rowLayout(0).filter, null, 'deleting the header row removes the filter');
});

test('deleting a criterion column or the header row shows the rows the filter hid', () => {
  const engine = sales();
  engine.apply({ kind: 'setFilter', sheet: 0, range: table(1, 1, 6, 6), criteria: [
    { column: 2, mode: 'include', values: ['Sul', 'Norte'] }, { column: 4, mode: 'exclude', values: ['5'] },
  ] });
  assert.deepEqual([...engine.rowLayout(0).hidden], [3, 3, 5, 5], 'ana (Norte, 5) and Ana (Leste)');
  engine.apply({ kind: 'deleteColumns', sheet: 0, at: 4, count: 1 }); // Preço, and its criterion
  assert.deepEqual([...engine.rowLayout(0).hidden], [5, 5], 'ana is shown again; Ana still fails Região');
  engine.undo();
  assert.deepEqual([...engine.rowLayout(0).hidden], [3, 3, 5, 5]);
  assert.equal(engine.rowLayout(0).filter?.criteria.length, 2);
  engine.apply({ kind: 'deleteRows', sheet: 0, at: 1, count: 1 }); // the header
  assert.equal(engine.rowLayout(0).filter, null);
  assert.deepEqual([...engine.rowLayout(0).hidden], [], 'no filter, nothing hidden by it');
  engine.undo();
  assert.deepEqual([...engine.rowLayout(0).hidden], [3, 3, 5, 5]);
  // The rows are hidden in the model too: a file saved now has none hidden.
  engine.redo();
  const reopened = WorkbookEngine.fromFile(ic, engine.toFile({})).engine;
  reopened.loadLayout();
  assert.deepEqual([...reopened.rowLayout(0).hidden], []);
});

test('each workbook of a worker has its own layout version', () => {
  const a = WorkbookEngine.fromModelBytes(ic, sales().modelBytes()).engine;
  a.loadLayout();
  const b = WorkbookEngine.fromModelBytes(ic, sales().modelBytes()).engine;
  b.loadLayout();
  assert.notEqual(a.layoutVersion, b.layoutVersion, 'opening another file always refreshes the grid layout');
});

test('large insertions are estimated before they run', () => {
  const engine = WorkbookEngine.create(ic);
  engine.paste(0, { row: 1, column: 1 }, Array.from({ length: 2000 }, (_, i) => `${i}\t${i * 2}`).join('\n'));
  assert.deepEqual(engine.estimate({ kind: 'insertRows', sheet: 0, at: 1, count: 1 }).cells, 4000);
  assert.deepEqual(engine.estimate({ kind: 'insertRows', sheet: 0, at: 1001, count: 5 }).cells, 2000);
  assert.deepEqual(engine.estimate({ kind: 'insertColumns', sheet: 0, at: 2, count: 1 }).cells, 2000);
  assert.equal(engine.estimate(sortOp([{ column: 1 }])).cells, 0, 'sort is not cell by cell');
});

test('old models are released after several operations, and the notice is set', () => {
  const engine = sales();
  for (let i = 0; i < 6; i++) engine.apply(sortOp([{ column: 1 + (i % 4), descending: i % 2 === 1 }]));
  assert.equal(engine.historyTrimmed, true);
  let undone = 0;
  while (engine.undo()) undone++;
  assert.equal(undone, 4, 'four sorts can be undone; the edits before them were released');
});

test('adding a sheet is one undo step', () => {
  const engine = WorkbookEngine.create(ic);
  engine.setInput(0, 1, 1, 'x');
  engine.addSheet();
  engine.undo();
  assert.deepEqual(engine.sheets(), ['Planilha1']);
  assert.equal(engine.formatted(0, 1, 1), 'x');
});

// ------------------------------------------------------------------ pivots

test('the pivot reads the whole base (hidden rows too) and follows sort, insert, delete and undo', async () => {
  const engine = sales();
  const config: PivotConfig = { rows: ['Região'], columns: [], values: [{ field: 'Total', aggregation: 'sum' }], filters: [] };
  const totals = async () => {
    const result = await engine.pivot(config);
    // One value field, no column fields: cell (r, total column) is at index r * 1 + 0 with a stride of 1 column.
    const stride = result.columnGroups.length + 1;
    return Object.fromEntries(result.rowGroups.map((key, r) => [key[0], result.cells[r * stride + stride - 1]]));
  };
  engine.pivotSource.reset(0);
  const base = await totals();
  assert.deepEqual(base, { Leste: 10, Norte: 5, Sul: 45 });
  engine.apply({ kind: 'setFilter', sheet: 0, range: table(1, 1, 6, 6), criteria: [{ column: 2, mode: 'include', values: ['Sul'] }] });
  assert.deepEqual(await totals(), base, 'hidden rows still count');
  engine.apply(sortOp([{ column: 5, descending: true }]));
  assert.deepEqual(await totals(), base, 'sorting does not change totals');
  engine.apply({ kind: 'insertRows', sheet: 0, at: 3, count: 1 });
  engine.setInput(0, 3, 1, 'Davi');
  engine.setInput(0, 3, 2, 'Leste');
  engine.setInput(0, 3, 5, '7');
  assert.deepEqual(await totals(), { ...base, Leste: 17 });
  engine.apply({ kind: 'deleteRows', sheet: 0, at: 2, count: 1 }); // the largest Total (Érica, Sul 30)
  assert.deepEqual(await totals(), { Leste: 17, Norte: 5, Sul: 15 });
  engine.undo();
  assert.deepEqual(await totals(), { ...base, Leste: 17 });
});

// ------------------------------------------------------------------ files

test('.farcel keeps the filter and hidden rows; reopening restores both', () => {
  const engine = sales();
  engine.apply({ kind: 'setFilter', sheet: 0, range: table(1, 1, 6, 6), criteria: [{ column: 2, mode: 'include', values: ['Norte', 'Leste'] }] });
  const file = engine.toFile({});
  const { header } = decodeFarcel(file);
  const opened = WorkbookEngine.fromFile(ic, file).engine;
  opened.loadLayout(parseFilters(header.app.filters));
  assert.deepEqual([...opened.rowLayout(0).hidden], [...engine.rowLayout(0).hidden]);
  assert.deepEqual(opened.rowLayout(0).filter, engine.rowLayout(0).filter);
  assert.deepEqual(opened.filteredSheets(), [0]);
  assert.equal(opened.formatted(0, 2, 1), 'Érica');
  opened.apply({ kind: 'clearFilter', sheet: 0 });
  assert.deepEqual([...opened.rowLayout(0).hidden], []);
  assert.equal(opened.canUndo(), true);
});

test('.xlsx keeps the hidden rows but not the filter, and the save says so', () => {
  const engine = sales();
  engine.apply({ kind: 'setFilter', sheet: 0, range: table(1, 1, 6, 6), criteria: [{ column: 2, mode: 'include', values: ['Sul'] }] });
  const xlsx = modelToXlsx(xlsxBridge, engine.modelBytes());
  const sheet = unzip(xlsx).get('xl/worksheets/sheet1.xml')!;
  assert.match(sheet, /<row r="3"[^>]*hidden="1"/);
  assert.doesNotMatch(sheet, /<autoFilter/);
  const { model } = xlsxToModel(xlsxBridge, xlsx, 'v.xlsx');
  const back = WorkbookEngine.fromModelBytes(ic, model).engine;
  back.loadLayout();
  assert.deepEqual([...back.rowLayout(0).hidden], [3, 3, 5, 6]);
  assert.equal(back.rowLayout(0).filter, null);
  back.apply({ kind: 'showRows', sheet: 0, top: 1, bottom: 10 });
  assert.deepEqual([...back.rowLayout(0).hidden], []);
  const losses = saveLosses('xlsx', { pivots: 0, origin: null, filters: engine.filteredSheets().length });
  assert.equal(losses.length, 1);
  assert.match(losses[0].text, /filtro/);
  assert.equal(losses[0].inWorkbook, true);
});
