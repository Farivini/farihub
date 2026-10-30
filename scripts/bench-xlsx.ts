/**
 * XLSX and CSV conversion times for the synthetic base, under Node with the same WASM builds
 * the browser loads (engine and converter). One run per size; not a browser measurement.
 *
 *   node scripts/bench-xlsx.ts [rows...]     (default 100000 1000000)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { WorkbookEngine } from '../src/engine/workbook-engine.ts';
import { modelToXlsx, xlsxToModel } from '../src/engine/xlsx.ts';
import { ic, wasmMemoryBytes } from '../tests/ironcalc-node.ts';
import * as bridge from '../vendor/xlsx-bridge/xlsx_bridge.js';
import { readFileSync } from 'node:fs';

const sizes = process.argv.slice(2).map(Number).filter(Boolean);
const module = new WebAssembly.Module(readFileSync(new URL('../vendor/xlsx-bridge/xlsx_bridge_bg.wasm', import.meta.url)));
const mib = (n: number) => Math.round(n / 1024 / 1024 * 10) / 10;
const results = [];
for (const rows of sizes.length ? sizes : [100_000, 1_000_000]) {
  const instance = bridge.initSync({ module });
  const { engine } = await WorkbookEngine.generateSynthetic(ic, rows, 20261029);
  let t = performance.now();
  const model = engine.modelBytes();
  const modelMs = performance.now() - t;
  t = performance.now();
  const xlsx = modelToXlsx(bridge, model);
  const exportMs = performance.now() - t;
  const converterAfterExport = instance.memory.buffer.byteLength;
  t = performance.now();
  const imported = xlsxToModel(bridge, xlsx, 'bench');
  const importMs = performance.now() - t;
  t = performance.now();
  const { engine: reopened, evaluateMs } = WorkbookEngine.fromModelBytes(ic, imported.model);
  const loadMs = performance.now() - t;
  const same = reopened.formatted(1, 1, 2) === engine.formatted(1, 1, 2) && reopened.formatted(0, rows + 1, 5) === engine.formatted(0, rows + 1, 5);
  t = performance.now();
  const csv = engine.toDelimited(0, ';');
  const csvMs = performance.now() - t;
  t = performance.now();
  const csvImport = await WorkbookEngine.fromDelimited(ic, 'bench', new TextEncoder().encode(csv.text), {
    encoding: 'utf-8', separator: ';', decimal: ',', header: true, columns: [],
  });
  const importCsvMs = performance.now() - t;
  const csvSame = csvImport.engine.formatted(0, rows + 1, 5) === engine.formatted(0, rows + 1, 5);
  const result = {
    rows, cells: imported.report.cells, formulas: imported.report.formulas,
    modelBytesMiB: mib(model.length), xlsxMiB: mib(xlsx.length), csvMiB: mib(Buffer.byteLength(csv.text)),
    modelBytesMs: Math.round(modelMs), exportXlsxMs: Math.round(exportMs), importXlsxMs: Math.round(importMs),
    loadAndEvaluateMs: Math.round(loadMs), evaluateMs: Math.round(evaluateMs), exportCsvMs: Math.round(csvMs), importCsvMs: Math.round(importCsvMs),
    // WASM memory only grows: this is the peak of all sizes run so far (the browser starts a fresh worker per conversion).
    converterWasmMiB: mib(Math.max(converterAfterExport, instance.memory.buffer.byteLength)), engineWasmMiB: mib(wasmMemoryBytes()),
    roundTripMatches: same && csvSame,
  };
  console.log(result);
  results.push(result);
}
mkdirSync(new URL('../reports/', import.meta.url), { recursive: true });
writeFileSync(new URL('../reports/xlsx-bench.json', import.meta.url), JSON.stringify({
  scope: 'IronCalc 0.9.1 engine + xlsx-bridge WASM under Node, one run per size; not a browser or Windows measurement',
  node: process.version, platform: `${process.platform} ${process.arch}`, results,
}, null, 2));
