import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, pivotByRegion } from '../src/analysis/table.ts';

test('known independent table aggregates and filters correctly', () => {
  const table = { rowCount: 4, region: new Uint8Array([2, 1, 2, 1]), revenueCents: new Float64Array([100, 400, 200, 0]), costCents: new Float64Array([80, 100, 70, 10]) };
  assert.deepEqual(pivotByRegion(table), [
    { region: 1, count: 2, revenueCents: 400, costCents: 110, margin: 0.725 },
    { region: 2, count: 2, revenueCents: 300, costCents: 150, margin: 0.5 },
  ]);
  assert.deepEqual(pivotByRegion(table, { region: 2, minRevenueCents: 150 }), [
    { region: 2, count: 1, revenueCents: 200, costCents: 70, margin: 0.65 },
  ]);
});
test('empty input and zero revenue have explicit results', () => {
  assert.deepEqual(pivotByRegion(makeFixture(0)), []);
  const table = { rowCount: 1, region: new Uint8Array([0]), revenueCents: new Float64Array([0]), costCents: new Float64Array([0]) };
  assert.equal(pivotByRegion(table)[0].margin, null);
});
test('invalid column lengths and invalid money fail instead of silently producing wrong totals', () => {
  const table = makeFixture(5);
  assert.throws(() => pivotByRegion({ ...table, rowCount: 6 }), /Column length/);
  table.revenueCents[0] = NaN;
  assert.throws(() => pivotByRegion(table), /Invalid money/);
  table.revenueCents[0] = Number.MAX_SAFE_INTEGER;
  table.region[1] = 0;
  assert.throws(() => pivotByRegion(table), /safe integer/);
});
test('one million rows match an independently derived cycle total', () => {
  const groups = pivotByRegion(makeFixture(1_000_000));
  assert.equal(groups.reduce((sum, group) => sum + group.count, 0), 1_000_000);
  assert.equal(groups.reduce((sum, group) => sum + group.revenueCents, 0), 30_000_000_000);
  assert.equal(groups.reduce((sum, group) => sum + group.costCents, 0), 18_000_000_000);
});
