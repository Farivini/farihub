import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePivot, layoutPivot, chartFromPivot, pivotCell, EMPTY_LABEL } from '../src/core/pivot.ts';
import type { ColumnSnapshot } from '../src/core/pivot.ts';

function column(name: string, values: string[]): ColumnSnapshot {
  const labels = [EMPTY_LABEL];
  const codes = new Uint32Array(values.length);
  values.forEach((value, i) => {
    const label = value === '' ? EMPTY_LABEL : value;
    let code = labels.indexOf(label);
    if (code < 0) { code = labels.length; labels.push(label); }
    codes[i] = code;
  });
  const labelValues = labels.map((l, i) => i === 0 ? NaN : /^-?\d+(,\d+)?$/.test(l) ? Number(l.replace(',', '.')) : NaN);
  return { name, codes, labels, labelValues };
}

const source = new Map([
  ['Região', column('Região', ['Sul', 'Norte', 'Sul', 'Sudeste', 'Norte', ''])],
  ['Canal', column('Canal', ['Loja', 'Online', 'Online', 'Loja', 'Loja', 'Loja'])],
  ['Receita', column('Receita', ['10,5', '20', '5', 'texto', '1', '4'])],
]);

test('rows, columns, sum, count and totals match hand computed values', () => {
  const result = computePivot(source, 6, {
    rows: ['Região'], columns: ['Canal'],
    values: [{ field: 'Receita', aggregation: 'sum' }, { field: 'Receita', aggregation: 'count' }], filters: [],
  });
  assert.deepEqual(result.rowGroups, [['Norte'], ['Sudeste'], ['Sul'], [EMPTY_LABEL]]);
  assert.deepEqual(result.columnGroups, [['Loja'], ['Online']]);
  const sum = (r: number, c: number) => pivotCell(result, r, c, 0);
  const count = (r: number, c: number) => pivotCell(result, r, c, 1);
  assert.equal(sum(0, 0), 1); assert.equal(sum(0, 1), 20); assert.equal(sum(0, 2), 21);
  assert.equal(sum(1, 0), 0, 'text is ignored by sum'); assert.equal(count(1, 0), 1, 'text is counted');
  assert.equal(sum(2, 2), 15.5);
  assert.equal(sum(3, 0), 4);
  assert.equal(sum(4, 0), 15.5); assert.equal(sum(4, 1), 25); assert.equal(sum(4, 2), 40.5);
  assert.equal(count(4, 2), 6);
});

test('filters exclude rows from groups and totals', () => {
  const result = computePivot(source, 6, {
    rows: ['Canal'], columns: [], values: [{ field: 'Receita', aggregation: 'sum' }],
    filters: [{ field: 'Região', excluded: ['Sul', EMPTY_LABEL] }],
  });
  assert.equal(result.includedRows, 3);
  assert.deepEqual(result.rowGroups, [['Loja'], ['Online']]);
  assert.equal(pivotCell(result, 2, 0, 0), 21);
});

test('layout and chart are derived from the aggregate', () => {
  const result = computePivot(source, 6, { rows: ['Região'], columns: ['Canal'], values: [{ field: 'Receita', aggregation: 'sum' }], filters: [] });
  const table = layoutPivot(result);
  assert.deepEqual(table.rows[0], ['Soma de Receita', 'Loja', 'Online', 'Total geral']);
  assert.deepEqual(table.rows[1], ['Região', '', '', '']);
  assert.deepEqual(table.rows.at(-1), ['Total geral', '15,5', '25', '40,5']);
  const chart = chartFromPivot(result);
  assert.deepEqual(chart.categories, ['Norte', 'Sudeste', 'Sul', EMPTY_LABEL]);
  assert.deepEqual(chart.series.map(s => s.name), ['Loja', 'Online']);
  assert.deepEqual(chart.series[1].values, [20, 0, 5, 0]);
});

test('no row fields gives a single total; unknown fields fail loudly', () => {
  const result = computePivot(source, 6, { rows: [], columns: [], values: [{ field: 'Receita', aggregation: 'sum' }], filters: [] });
  assert.equal(pivotCell(result, 0, 0, 0), 40.5);
  assert.equal(result.cells.length, 1);
  assert.deepEqual(layoutPivot(result).rows, [['Valores', 'Soma de Receita'], ['Total geral', '40,5']]);
  assert.throws(() => computePivot(source, 6, { rows: ['X'], columns: [], values: [], filters: [] }), /Campo inexistente/);
});
