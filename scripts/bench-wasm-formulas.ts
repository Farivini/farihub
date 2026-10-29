/**
 * IronCalc 0.9.1 WASM under Node: cost of one formula per row. Not a browser measurement.
 * Usage: node scripts/bench-wasm-formulas.ts [rows]. Writes reports/wasm-row-formulas.json.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, arch } from 'node:os';
import assert from 'node:assert/strict';
import { ic, wasmMemoryBytes } from '../tests/ironcalc-node.ts';
import { ENGINE_LANGUAGE, ENGINE_LOCALE, ENGINE_TIMEZONE } from '../src/engine/workbook-engine.ts';

const rows = Number(process.argv[2] ?? 1_000_000);
const chunk = 100_000;
const started = performance.now();
let model = new ic.Model('Fórmulas por linha', ENGINE_LOCALE, ENGINE_TIMEZONE, ENGINE_LANGUAGE);
model.pauseEvaluation();
let resetMs = 0;
for (let r = 1; r <= rows; r++) {
  model.setUserInput(0, r, 1, String(r % 20 + 1));
  model.setUserInput(0, r, 2, `${r % 997},5`);
  model.setUserInput(0, r, 3, `=A${r}*B${r}`);
  if (r % chunk === 0 || r === rows) {
    const t = performance.now();
    model.flushSendQueue();
    const bytes = model.toBytes();
    model.free();
    model = ic.Model.fromBytes(bytes, ENGINE_LANGUAGE);
    model.pauseEvaluation();
    resetMs += performance.now() - t;
  }
}
const fillMs = performance.now() - started - resetMs;
model.resumeEvaluation();
let t = performance.now();
model.evaluate();
const firstEvaluateMs = performance.now() - t;
assert.equal(model.getFormattedCellValue(0, 1, 3), '3');
t = performance.now();
model.setUserInput(0, 1, 1, '10');
const editMs = performance.now() - t;
assert.equal(model.getFormattedCellValue(0, 1, 3), '15');
const report = {
  createdAt: new Date().toISOString(),
  scope: 'IronCalc 0.9.1 WASM (same wasm_bg.wasm as the browser) under Node; single run; not a browser or Windows measurement',
  environment: { node: process.version, platform: `${platform()} ${arch()}`, cpu: cpus()[0]?.model, logicalCpus: cpus().length },
  rows, columns: 3, formulas: rows, formula: '=A{n}*B{n}',
  fillMs, historyResetMs: resetMs, firstEvaluateMs, editWithAutomaticRecalculationMs: editMs,
  wasmLinearMemoryBytes: wasmMemoryBytes(),
};
await mkdir(new URL('../reports/', import.meta.url), { recursive: true });
await writeFile(new URL('../reports/wasm-row-formulas.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
