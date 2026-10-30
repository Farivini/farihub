/**
 * Table operations on the synthetic base under Node, with the same WASM builds the browser
 * worker loads (IronCalc and the engine-data editor). No grid, no worker messaging: this is
 * the engine's own cost. Usage: node scripts/bench-table.ts [rows...] (default 100000 1000000).
 * Writes reports/table-node-<rows>.json. Run one size per process: memory grown by one size
 * would make the next look faster. Numbers are from this machine only.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { WorkbookEngine } from '../src/engine/workbook-engine.ts';
import type { TableOperation } from '../src/core/table-ops.ts';
import { DEFAULT_SEED } from '../src/core/synthetic.ts';
import { ic, wasmMemoryBytes } from '../tests/ironcalc-node.ts';
import { bridgeMemoryBytes, xlsxBridge } from '../tests/xlsx-node.ts';

WorkbookEngine.bridge = xlsxBridge;
const sizes = process.argv.slice(2).map(Number).filter(n => n > 0);
const ROWS = sizes.length ? sizes : [100_000, 1_000_000];
const round = (n: number) => Math.round(n * 10) / 10;
const MiB = (n: number | null) => n === null ? null : round(n / 1024 / 1024);

function memory() {
  const usage = process.memoryUsage();
  return { ironcalcWasmMiB: MiB(wasmMemoryBytes()), bridgeWasmMiB: MiB(bridgeMemoryBytes()), nodeRssMiB: MiB(usage.rss), nodeHeapUsedMiB: MiB(usage.heapUsed) };
}

async function measure(label: string, run: () => unknown | Promise<unknown>) {
  const started = performance.now();
  const result = await run();
  const ms = round(performance.now() - started);
  const entry = { label, ms, ...memory() };
  console.log(`  ${label}: ${ms.toLocaleString('pt-BR')} ms · IronCalc ${entry.ironcalcWasmMiB} MiB · RSS ${entry.nodeRssMiB} MiB`);
  return { entry, result };
}

const report: Record<string, unknown> = {
  createdAt: new Date().toISOString(),
  scope: 'Engine only (WorkbookEngine.apply) under Node, single thread, the same IronCalc 0.9.1 WASM and xlsx-bridge WASM the browser loads. No worker messaging, no grid drawing.',
  environment: { node: process.version, os: `${platform()} ${release()} ${arch()}`, cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem() },
  corpus: 'Synthetic base (Dados: Região, Canal, Categoria, Quantidade, Receita; header in row 1) plus the Resumo sheet with 3 aggregate formulas over Dados.',
  runs: [] as unknown[],
};

for (const rows of ROWS) {
  console.log(`${rows.toLocaleString('pt-BR')} linhas`);
  const { engine, report: generation } = await WorkbookEngine.generateSynthetic(ic, rows, DEFAULT_SEED);
  const range = { top: 1, left: 1, bottom: rows + 1, right: 5 };
  const steps = [];
  steps.push({ label: 'after generation', ms: round(generation.totalMs), ...memory() });
  const run = async (label: string, op: TableOperation) => (await measure(label, () => engine.apply(op))).entry;
  steps.push(await run('filter on: header buttons, no criterion', { kind: 'setFilter', sheet: 0, range, criteria: [] }));
  steps.push((await measure('filter values of Região (distinct + counts)', () => engine.filterValues(0, 1))).entry);
  steps.push((await measure('filter values of Receita (distinct + counts)', () => engine.filterValues(0, 5))).entry);
  // Twice: the first pass includes the growth of WASM memory to hold copies of the workbook
  // (much slower at 1M rows); the second is the steady cost of the same operations.
  const hiddenRuns: Record<string, number> = {};
  for (const pass of ['first', 'repeat']) {
    const tag = (label: string) => `${label} · ${pass}`;
    steps.push(await run(tag('filter Região = Sul (hides ~80%)'), { kind: 'setFilter', sheet: 0, range, criteria: [{ column: 1, mode: 'include', values: ['Sul'] }] }));
    hiddenRuns[pass] = engine.rowLayout(0).hidden.length / 2;
    steps.push(await run(tag('filter Região ≠ Sul and Canal = Atacado'), { kind: 'setFilter', sheet: 0, range, criteria: [
      { column: 1, mode: 'exclude', values: ['Sul'] }, { column: 2, mode: 'include', values: ['Atacado'] },
    ] }));
    steps.push((await measure(tag('undo the last filter'), () => engine.undo())).entry);
    steps.push(await run(tag('filter off (all rows shown)'), { kind: 'clearFilter', sheet: 0 }));
    // The repeat sorts the other way: with one model kept for undo (1M rows) the data may
    // still be in the first pass's order, and sorting it again the same way changes nothing.
    const flip = pass === 'repeat';
    steps.push(await run(tag(`sort by Receita ${flip ? 'ascending' : 'descending'} (numbers)`), { kind: 'sort', sheet: 0, range, header: true, keys: [{ column: 5, descending: !flip }] }));
    steps.push(await run(tag(`sort by Região, Canal, Receita (text, text, number)${flip ? ', Região descending' : ''}`), { kind: 'sort', sheet: 0, range, header: true, keys: [{ column: 1, descending: flip }, { column: 2 }, { column: 5, descending: true }] }));
    steps.push((await measure(tag('undo the sort'), () => engine.undo())).entry);
    steps.push((await measure(tag('redo the sort'), () => engine.redo())).entry);
    if (pass === 'first') {
      // Back to the generated order, so the repeat filters the same data.
      engine.undo();
      engine.undo();
      steps.push(await run('filter on again: header buttons, no criterion', { kind: 'setFilter', sheet: 0, range, criteria: [] }));
    }
  }
  const atEnd = { kind: 'insertRows', sheet: 0, at: rows + 2, count: 10 } as const;
  steps.push(await run('insert 10 rows after the data', atEnd));
  const atTop = { kind: 'insertRows', sheet: 0, at: 2, count: 1 } as const;
  const estimate = engine.estimate(atTop);
  steps.push(await run('insert 1 row below the header (moves every cell)', atTop));
  const deletion = { kind: 'deleteRows', sheet: 0, at: 2, count: 1 } as const;
  const deleteEstimate = engine.estimate(deletion);
  steps.push(await run('delete that row (on a copy, for a correct undo)', deletion));
  const check = [engine.formatted(1, 1, 2), engine.formatted(1, 2, 2), engine.formatted(1, 3, 2)];
  report.runs = [...(report.runs as unknown[]), {
    rows, cells: rows * 5 + 5, hiddenRunsAfterFilterSul: hiddenRuns,
    estimates: {
      insertAtTop: { cells: estimate.cells, seconds: round(estimate.seconds) },
      deleteAtTop: { cells: deleteEstimate.cells, seconds: round(deleteEstimate.seconds) },
    },
    resumoAfterOperations: check, steps,
  }];
  engine.dispose();
}

await mkdir(new URL('../reports/', import.meta.url), { recursive: true });
const name = `table-node-${ROWS.join('-')}.json`;
await writeFile(new URL(`../reports/${name}`, import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(`Relatório: reports/${name}`);
