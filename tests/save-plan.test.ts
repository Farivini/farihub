import { test } from 'node:test';
import assert from 'node:assert/strict';
import { delimitedLosses, isComplete, lossKey, parseOrigin, saveLosses } from '../src/core/save-plan.ts';
import type { Origin } from '../src/core/save-plan.ts';
import { decodeFarcel, encodeFarcel } from '../src/core/file-format.ts';
import { WorkbookEngine } from '../src/engine/workbook-engine.ts';
import { ic } from './ironcalc-node.ts';

const origin: Origin = {
  name: 'vendas.xlsx', format: 'XLSX',
  report: { lost: { charts: 2, comments: 1 }, kept: { mergedCells: 3 }, cells: 10, formulas: 2, sheets: 1 },
};

test('.farcel keeps everything; .xlsx lists pivots (incomplete) and what the original lost (still complete)', () => {
  assert.deepEqual(saveLosses('farcel', { pivots: 2, origin }), []);
  assert.deepEqual(saveLosses('xlsx', { pivots: 0, origin: null }), []);
  const fromOrigin = saveLosses('xlsx', { pivots: 0, origin });
  assert.equal(fromOrigin.length, 1);
  assert.match(fromOrigin[0].text, /vendas\.xlsx.*gráficos, comentários/);
  assert.equal(isComplete(fromOrigin), true, 'features the workbook never had do not make the save incomplete');
  const withPivots = saveLosses('xlsx', { pivots: 2, origin });
  assert.match(withPivots[0].text, /^2 tabelas dinâmicas/);
  assert.equal(isComplete(withPivots), false);
  assert.notEqual(lossKey(withPivots), lossKey(fromOrigin), 'a new pivot asks again');
});

test('CSV/TSV losses name the sheet left out and the values-only rule', () => {
  const losses = delimitedLosses('csv', { sheets: ['Dados', 'Resumo'], sheet: 1, pivots: 0 });
  assert.match(losses[0].text, /Só a planilha Resumo: CSV.*as outras 1/);
  assert.match(losses[1].text, /fórmulas viram seus resultados/);
  assert.equal(delimitedLosses('tsv', { sheets: ['Dados'], sheet: 0, pivots: 1 }).length, 2);
});

test('the import origin and its report survive a .farcel save and reopen; malformed headers are dropped', () => {
  const engine = WorkbookEngine.create(ic);
  engine.setInput(0, 1, 1, 'x');
  const file = engine.toFile({ pivots: [], origin });
  const header = decodeFarcel(file).header;
  assert.deepEqual(parseOrigin(header.app.origin), origin);
  assert.equal(parseOrigin({ name: 'x', format: 'PDF' }), null);
  assert.equal(parseOrigin('vendas.xlsx'), null);
  assert.deepEqual(parseOrigin({ name: 'a.csv', format: 'CSV', report: null }), { name: 'a.csv', format: 'CSV', report: null });
  assert.deepEqual(parseOrigin({ name: 'a.xlsx', format: 'XLSX', report: { lost: { charts: 'x' } } })!.report!.lost, {}, 'non-numeric counts are not trusted');
  // A file without origin (saved before this change) opens with none.
  assert.equal(parseOrigin(decodeFarcel(encodeFarcel(engine.modelBytes(), '0.9.1', { pivots: [] })).header.app.origin), null);
});
