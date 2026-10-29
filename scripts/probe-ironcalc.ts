import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

let Model;
try {
  ({ Model } = await import('@ironcalc/nodejs'));
} catch (error) {
  console.error('IronCalc not available. Install the pinned candidate: npm install --no-save --package-lock=false @ironcalc/nodejs@0.9.1');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const model = new Model('Farcel technical probe', 'en', 'UTC', 'en');
model.setUserInput(0, 1, 1, '100');
model.setUserInput(0, 2, 1, '200');
model.setUserInput(0, 3, 1, '300');
// Expected answers are hand-derived. These are not results from Microsoft Excel.
const cases = [
  ['SUM', '=SUM(A1:A3)', '600'],
  ['AVERAGE', '=AVERAGE(A1:A3)', '200'],
  ['IF', '=IF(A1>50,1,0)', '1'],
  ['SUMIF', '=SUMIF(A1:A3,">150")', '500'],
  ['COUNTIF', '=COUNTIF(A1:A3,">150")', '2'],
  ['absolute reference', '=$A$1+A2', '300'],
  ['division by zero', '=1/0', '#DIV/0!'],
];
const started = performance.now();
const results = cases.map(([name, formula, expected], index) => {
  model.setUserInput(0, index + 1, 2, formula);
  model.evaluate();
  const actual = model.getFormattedCellValue(0, index + 1, 2);
  return { name, formula, expected, actual, passed: actual === expected };
});
// Probe Portuguese separately. Failure does not imply lack of a locale adapter.
model.setUserInput(0, 1, 3, '=SOMA(A1:A3)');
model.evaluate();
const portugueseDirect = model.getFormattedCellValue(0, 1, 3);
model.setUserInput(0, 1_000_000, 1, '42');
model.evaluate();
const millionthRow = model.getFormattedCellValue(0, 1_000_000, 1);
const portugueseConfigurations = ['pt', 'pt-BR', 'pt-PT'].map(language => {
  try {
    const localized = new Model('Portuguese probe', 'en', 'UTC', language);
    localized.setUserInput(0, 1, 1, '10');
    localized.setUserInput(0, 2, 1, '=SOMA(A1:A1)');
    localized.evaluate();
    return { language, actual: localized.getFormattedCellValue(0, 2, 1) };
  } catch (error) {
    return { language, error: String(error) };
  }
});
const temp = await mkdtemp(join(tmpdir(), 'farcel-probe-'));
let xlsxRoundTrip;
try {
  const small = new Model('Roundtrip', 'en', 'UTC', 'en');
  small.setUserInput(0, 1, 1, '123');
  small.setUserInput(0, 2, 1, '=A1*2');
  small.evaluate();
  const file = join(temp, 'small.xlsx');
  small.saveToXlsx(file);
  const reopened = Model.fromXlsx(file, 'en', 'UTC', 'en');
  reopened.evaluate();
  xlsxRoundTrip = { value: reopened.getFormattedCellValue(0, 2, 1), formula: reopened.getCellContent(0, 2, 1) };
} finally {
  await rm(temp, { recursive: true, force: true });
}
const report = {
  candidate: '@ironcalc/nodejs@0.9.1', elapsedMs: performance.now() - started,
  results, portugueseDirectInEnglishMode: portugueseDirect, portugueseConfigurations,
  sparseMillionthRow: millionthRow, xlsxRoundTrip,
  limitations: ['Small English formula fixture; no comparison against Excel executed', 'Sparse last-row address is not a million populated rows', 'Complete Portuguese formula syntax and Excel semantics remain unvalidated', 'Two-cell XLSX round-trip within the same engine, not Microsoft Office fidelity', 'No WASM browser integration or pivot support tested'],
};
await mkdir(new URL('../reports/', import.meta.url), { recursive: true });
await writeFile(new URL('../reports/ironcalc.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (results.some(result => !result.passed) || millionthRow !== '42' || xlsxRoundTrip.value !== '246' || xlsxRoundTrip.formula !== '=A1*2') process.exitCode = 1;
