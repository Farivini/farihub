import { parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { pivotByRegion } from '../src/analysis/table.ts';
import type { NumericTable, PivotSpec } from '../src/analysis/table.ts';

const { table, spec } = workerData as { table: NumericTable; spec: PivotSpec };
const started = performance.now();
const groups = pivotByRegion(table, spec);
parentPort!.postMessage({ groups, aggregationMs: performance.now() - started });
