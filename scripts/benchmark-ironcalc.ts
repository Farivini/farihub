import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { platform, cpus } from 'node:os';
import assert from 'node:assert/strict';

if (isMainThread) {
  const started = performance.now();
  const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url));
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(new Error('IronCalc benchmark exceeded 60 seconds'));
    }, 60_000);
    worker.once('message', message => { clearTimeout(timeout); resolve(message); });
    worker.once('error', error => { clearTimeout(timeout); reject(error); });
    worker.once('exit', code => { clearTimeout(timeout); if (code !== 0) reject(new Error(`Worker exit ${code}`)); });
  });
  const report = {
    createdAt: new Date().toISOString(), candidate: '@ironcalc/nodejs@0.9.1',
    environment: { node: process.version, platform: platform(), cpu: cpus()[0]?.model },
    ...result, workerStartupAndTotalMs: performance.now() - started,
    limitations: ['Single run in Node native binding; not WASM/browser/Windows app', 'Three numeric columns, five distinct groups, only one aggregate formula', 'No grid, pivot UI, XLSX round-trip, complex dependency chains or Excel comparison'],
  };
  await mkdir(new URL('../reports/', import.meta.url), { recursive: true });
  await writeFile(new URL('../reports/ironcalc-million.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} else {
  const { Model } = await import('@ironcalc/nodejs');
  const model = new Model('Million populated rows', 'en', 'UTC', 'en');
  const fillStarted = performance.now();
  for (let row = 1; row <= 1_000_000; row++) {
    const region = (row - 1) % 5;
    model.updateCellWithNumber(0, row, 1, region);
    model.updateCellWithNumber(0, row, 2, (region + 1) * 10_000);
    model.updateCellWithNumber(0, row, 3, (region + 1) * 6_000);
  }
  const populationMs = performance.now() - fillStarted;
  model.setUserInput(0, 1, 4, '=SUM(B1:B1000000)');
  const recalcStarted = performance.now();
  model.evaluate();
  const recalcMs = performance.now() - recalcStarted;
  const sum = model.getFormattedCellValue(0, 1, 4);
  assert.equal(sum, '30000000000');
  const editStarted = performance.now();
  model.updateCellWithNumber(0, 1_000_000, 2, 50_001);
  model.evaluate();
  const editAndRecalcMs = performance.now() - editStarted;
  const editedSum = model.getFormattedCellValue(0, 1, 4);
  assert.equal(editedSum, '30000000001');
  parentPort!.postMessage({ rows: 1_000_000, populatedColumns: 3, populatedCells: 3_000_001, populationMs, recalcMs, editAndRecalcMs, sum, editedSum, processRssAtEndBytes: process.memoryUsage().rss });
}
