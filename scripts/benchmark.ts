import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, arch, totalmem } from 'node:os';
import assert from 'node:assert/strict';
import { makeFixture } from '../src/analysis/table.ts';
import type { Group } from '../src/analysis/table.ts';

const started = performance.now();
const table = makeFixture(1_000_000);
const generationMs = performance.now() - started;
const startWorker = performance.now();
const memorySamples = [process.memoryUsage().rss];
let heartbeatTicks = 0;
const ticker = setInterval(() => {
  heartbeatTicks++;
  memorySamples.push(process.memoryUsage().rss);
}, 5);
const result = await new Promise<{ groups: Group[]; aggregationMs: number }>((resolve, reject) => {
  const worker = new Worker(new URL('./aggregation-worker.ts', import.meta.url), {
    workerData: { table, spec: {} },
    transferList: [table.region.buffer, table.revenueCents.buffer, table.costCents.buffer] as ArrayBuffer[],
  });
  const timeout = setTimeout(() => {
    void worker.terminate();
    reject(new Error('Worker exceeded 60 seconds'));
  }, 60_000);
  worker.once('message', message => { clearTimeout(timeout); resolve(message); });
  worker.once('error', error => { clearTimeout(timeout); reject(error); });
  worker.once('exit', code => {
    clearTimeout(timeout);
    if (code !== 0) reject(new Error(`Worker exit ${code}`));
  });
}).finally(() => clearInterval(ticker));

assert.equal(result.groups.length, 5);
for (let region = 0; region < 5; region++) {
  assert.deepEqual(result.groups[region], {
    region, count: 200_000,
    revenueCents: (region + 1) * 2_000_000_000,
    costCents: (region + 1) * 1_200_000_000,
    margin: 0.4,
  });
}
const report = {
  scope: 'Synthetic columnar snapshot: fixed aggregation, not full spreadsheet or XLSX',
  createdAt: new Date().toISOString(),
  environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem() },
  rows: 1_000_000, inputColumns: 3, groups: result.groups,
  generationMs, aggregationMs: result.aggregationMs,
  workerStartupAndAggregationMs: performance.now() - startWorker,
  mainThreadHeartbeatTicks: heartbeatTicks,
  snapshotBytes: 17_000_000,
  processRssMaxSampledBytes: Math.max(...memorySamples, process.memoryUsage().rss),
  limitations: ['One run only; no performance threshold approved', 'Node worker, not a browser responsiveness test', 'No formula engine, pivot UI, sorting, XLSX, document renderer or Windows installer tested'],
};
await mkdir(new URL('../reports/', import.meta.url), { recursive: true });
await writeFile(new URL('../reports/aggregation.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
