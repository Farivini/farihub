/**
 * Measures the Farcel UI in Chromium with a synthetic base of N fully populated rows.
 * Run `npm run build` first. Usage: node scripts/bench-browser.ts [rows] (default 1,000,000).
 * Writes reports/browser-million.json. Numbers are from this machine and browser only.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { cpus, platform, release, totalmem, tmpdir, arch } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { startApp, openPage, select, idle, copyText, inPane } from '../tests/e2e/harness.ts';
import { syntheticTotals, REGIONS, CHANNELS, DEFAULT_SEED, centsToInput, syntheticRows } from '../src/core/synthetic.ts';

const ROWS = Number(process.argv[2] ?? 1_000_000);
const parseNumber = (text: string) => Number(text.replace(/\./g, '').replace(',', '.'));
const round = (n: number) => Math.round(n * 10) / 10;

function chromiumRssBytes(): number | null {
  try {
    const out = execFileSync('ps', ['-eo', 'rss=,args='], { encoding: 'utf8' });
    return out.split('\n').filter(line => /chrom/i.test(line) && !/ps -eo/.test(line))
      .reduce((sum, line) => sum + Number(line.trim().split(/\s+/)[0] || 0) * 1024, 0);
  } catch {
    return null;
  }
}

async function measures(page: Page, name: string) {
  return page.evaluate(n => performance.getEntriesByName(n).map(e => ({ start: e.startTime, duration: e.duration, detail: (e as PerformanceMeasure).detail })), name);
}

async function memory(page: Page) {
  const wasm = await page.evaluate(() => (window as unknown as { farcelDiagnostics: { stats(): Promise<{ wasmMemoryBytes: number | null }> } }).farcelDiagnostics.stats().then(s => s.wasmMemoryBytes));
  // performance.memory is bucketed in Chromium; the DevTools protocol reports the page heap.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const { metrics } = await cdp.send('Performance.getMetrics');
  await cdp.detach();
  const heap = metrics.find(m => m.name === 'JSHeapUsedSize')?.value ?? null;
  return { wasmLinearMemoryBytes: wasm, mainThreadJsHeapUsedBytes: heap, chromiumProcessesRssBytes: chromiumRssBytes() };
}

async function settledAfter(page: Page, action: () => Promise<void>): Promise<number> {
  const t0 = await page.evaluate(() => performance.now());
  await action();
  await page.waitForFunction(() => [...document.querySelectorAll('.doc-pane:not([hidden]) .grid-root')].every(g => g.getAttribute('data-settled') === 'true'), null, { timeout: 120_000 });
  return page.evaluate(start => {
    const draws = performance.getEntriesByName('grid:draw');
    const last = draws[draws.length - 1];
    return last.startTime + last.duration - start;
  }, t0);
}

const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { count: values.length, mean: round(values.reduce((a, b) => a + b, 0) / Math.max(1, values.length)), p50: round(pick(0.5)), p95: round(pick(0.95)), max: round(sorted.at(-1) ?? 0) };
};

const app = await startApp();
const report: Record<string, unknown> = {
  createdAt: new Date().toISOString(),
  scope: 'Farcel UI in headless Chromium (Playwright), production build served by vite preview. Not Windows, not a packaged app.',
  environment: {
    browser: `Chromium ${app.browser.version()}`, os: `${platform()} ${release()} ${arch()}`,
    cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), node: process.version,
  },
  corpus: {
    rows: ROWS, seed: DEFAULT_SEED, sheet: 'Dados', columns: ['Região (texto, 5)', 'Canal (texto, 3)', 'Categoria (texto, 8)', 'Quantidade (inteiro)', 'Receita (decimal)'],
    populatedCells: ROWS * 5 + 5,
    formulas: ['Resumo!B1 =SOMA(Dados!E2:E…)', 'Resumo!B2 =SOMASE(Dados!A2:A…;"Sul";Dados!E2:E…)', 'Resumo!B3 =CONT.VALORES(Dados!A2:A…)'],
  },
};

try {
  const { page, errors } = await openPage(app.browser, app.url);
  await page.evaluate(() => {
    const w = window as unknown as { longTasks: number[] };
    w.longTasks = [];
    new PerformanceObserver(list => list.getEntries().forEach(e => w.longTasks.push(e.duration))).observe({ type: 'longtask', buffered: true });
  });
  report.memoryEmpty = await memory(page);

  // 1. Generate the base inside the engine worker.
  console.log(`Gerando ${ROWS} linhas…`);
  await page.click('[data-testid=files-menu]');
  await page.click('role=menuitem[name=/Base de teste/]');
  await page.fill('.dialog input[name=rows]', String(ROWS));
  await page.click('.dialog button.primary');
  await page.waitForSelector('[data-testid=generation-report]', { timeout: 15 * 60_000 });
  const generation = (await measures(page, 'engine:generate')).at(-1)!;
  const longTasks = await page.evaluate(() => (window as unknown as { longTasks: number[] }).longTasks);
  await idle(page);
  report.generation = {
    wallMs: round(generation.duration), engine: generation.detail,
    mainThreadLongTasksDuringGeneration: stats(longTasks),
    note: 'Generation writes every cell through IronCalc setUserInput in the worker and rebuilds the model every 100k rows to drop undo history.',
  };
  report.memoryAfterGeneration = await memory(page);
  console.log('Geração', report.generation);

  // 2. Formula results against the independent expectation.
  const expected = syntheticTotals(ROWS, DEFAULT_SEED);
  await page.locator(inPane('.sheet-tab'), { hasText: 'Resumo' }).click();
  await idle(page);
  const summary = (await copyText(page, 'B1:B3')).split('\n');
  assert.equal(Math.round(parseNumber(summary[0]) * 100), expected.revenueCents, 'SOMA');
  assert.equal(Math.round(parseNumber(summary[1]) * 100), expected.revenueCentsByRegion[REGIONS.indexOf('Sul')], 'SOMASE');
  assert.equal(parseNumber(summary[2]), ROWS, 'CONT.VALORES');
  report.formulaCheck = { soma: summary[0], somase: summary[1], contValores: summary[2], matchesIndependentExpectation: true };

  // 3. Navigation and scrolling on the populated sheet.
  await page.locator(inPane('.sheet-tab'), { hasText: 'Dados' }).click();
  await idle(page);
  const jumpLast = await settledAfter(page, async () => { await select(page, `E${ROWS + 1}`); });
  const lastRow = [...syntheticRows(ROWS, DEFAULT_SEED)].at(-1)!;
  assert.equal(await copyText(page, `E${ROWS + 1}`), centsToInput(lastRow.revenueCents).replace(/0+$/, '').replace(/,$/, ''));
  const jumpMiddle = await settledAfter(page, async () => { await select(page, `A${Math.floor(ROWS / 2)}`); });
  const drawsBefore = (await measures(page, 'grid:draw')).length;
  const fetchesBefore = (await measures(page, 'grid:fetch')).length;
  const box = (await page.locator(inPane('.farcel-body [data-testid=grid-scroller]')).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const scrollStarted = Date.now();
  for (let i = 0; i < 60; i++) { await page.mouse.wheel(0, i % 20 < 10 ? 1500 : -900); await page.waitForTimeout(16); }
  await idle(page);
  const scrollWallMs = Date.now() - scrollStarted;
  const draws = (await measures(page, 'grid:draw')).slice(drawsBefore).map(m => m.duration);
  const fetches = (await measures(page, 'grid:fetch')).slice(fetchesBefore).map(m => m.duration);
  report.navigation = {
    jumpToLastRowUntilDrawnMs: round(jumpLast), jumpToMiddleUntilDrawnMs: round(jumpMiddle),
    scroll: { wheelEvents: 60, wallMs: scrollWallMs, drawMs: stats(draws), blockFetchRoundTripMs: stats(fetches), blockSize: '64 linhas × 16 colunas' },
  };
  console.log('Navegação', report.navigation);

  // 4. Edit and recalculation (three aggregate formulas over the base).
  const firstRow = [...syntheticRows(1, DEFAULT_SEED)][0];
  await select(page, 'E2');
  await page.keyboard.type('1000');
  const editLatency = await settledAfter(page, async () => { await page.keyboard.press('Enter'); await idle(page); });
  const edit = (await measures(page, 'engine:setInput')).at(-1)!;
  await page.locator(inPane('.sheet-tab'), { hasText: 'Resumo' }).click();
  await idle(page);
  const afterEdit = (await copyText(page, 'B1')).split('\n');
  assert.equal(Math.round(parseNumber(afterEdit[0]) * 100), expected.revenueCents - firstRow.revenueCents + 100_000, 'SOMA after edit');
  report.editRecalculation = {
    cell: 'Dados!E2', engineSetInputMs: round((edit.detail as { engineMs: number }).engineMs), roundTripMs: round(edit.duration), untilGridSettledMs: round(editLatency),
    note: 'IronCalc 0.9.1 re-evaluates the workbook on each input; with formulas spanning the base every edit pays for them.',
  };
  console.log('Edição', report.editRecalculation);

  // 5. Pivot: first build (extraction from the engine + aggregation), reconfiguration, refresh after edit.
  await page.locator(inPane('.sheet-tab'), { hasText: 'Dados' }).click();
  await page.click(inPane('[data-testid=new-pivot]'));
  await page.waitForSelector('[data-testid=field-Região]');
  await page.click('[data-testid=field-Região]');
  await page.click('[data-testid=field-Receita]');
  await page.waitForFunction(() => document.querySelector('.doc-pane:not([hidden]) [data-testid=pivot-info]')?.getAttribute('data-status') === 'ready', null, { timeout: 10 * 60_000 });
  const pivotRuns = async () => (await measures(page, 'pivot:compute')).filter(m => (m.detail as { current: boolean }).current);
  const first = (await pivotRuns()).at(-1)!;
  await page.dragAndDrop('[data-testid=field-Canal]', '[data-testid=zone-columns]');
  await page.waitForFunction(n => performance.getEntriesByName('pivot:compute').length > n && document.querySelector('.doc-pane:not([hidden]) [data-testid=pivot-info]')?.getAttribute('data-status') === 'ready', (await measures(page, 'pivot:compute')).length, { timeout: 10 * 60_000 });
  const second = (await pivotRuns()).at(-1)!;
  const pivotTsv = await (async () => {
    await page.click(inPane('[data-testid=pivot-table] [data-testid=grid-scroller]'), { position: { x: 100, y: 40 } });
    await page.keyboard.press('ControlOrMeta+a');
    await page.evaluate(() => navigator.clipboard.writeText('(vazio)'));
    await page.keyboard.press('ControlOrMeta+c');
    await page.waitForFunction(() => navigator.clipboard.readText().then(t => t !== '(vazio)'));
    return page.evaluate(() => navigator.clipboard.readText());
  })();
  const lines = pivotTsv.split('\n').map(l => l.split('\t'));
  const header = lines[0];
  for (const region of REGIONS) {
    const line = lines.find(l => l[0] === region)!;
    const r = REGIONS.indexOf(region);
    const centsTotal = expected.revenueCentsByRegion[r] - (firstRow.region === r ? firstRow.revenueCents - 100_000 : 0);
    assert.equal(Math.round(parseNumber(line[header.indexOf('Total geral')]) * 100), centsTotal, `pivot ${region}`);
  }
  assert.ok(CHANNELS.every(channel => header.includes(channel)));
  const chartBars = await page.locator(inPane('.chart-bar')).count();
  // Edit a source cell, return to the pivot: snapshot patched, then aggregated again.
  await page.locator(inPane('.sheet-tab'), { hasText: 'Dados' }).click();
  await select(page, 'E3');
  await page.keyboard.type('0');
  await page.keyboard.press('Enter');
  await idle(page);
  const beforeRefresh = (await measures(page, 'pivot:compute')).length;
  await page.locator(inPane('.sheet-tab.pivot button[role=tab]')).click();
  await page.waitForFunction(n => performance.getEntriesByName('pivot:compute').length > n && document.querySelector('.doc-pane:not([hidden]) [data-testid=pivot-info]')?.getAttribute('data-status') === 'ready', beforeRefresh, { timeout: 10 * 60_000 });
  const third = (await pivotRuns()).at(-1)!;
  const extraction = await page.evaluate(() => (window as unknown as { farcelDiagnostics: { stats(): Promise<unknown> } }).farcelDiagnostics.stats());
  report.pivot = {
    firstBuild: { config: 'Linhas: Região · Valores: Soma de Receita', roundTripMs: round(first.duration), engine: first.detail },
    addColumnField: { config: '+ Colunas: Canal', roundTripMs: round(second.duration), engine: second.detail },
    afterSourceEdit: { edit: 'Dados!E3 = 0', roundTripMs: round(third.duration), engine: third.detail },
    totalsMatchIndependentExpectation: true, chartBars,
    columnExtraction: (extraction as { extraction: unknown }).extraction,
  };
  report.memoryAfterPivot = await memory(page);
  console.log('Dinâmica', report.pivot);

  // 6. Save and reopen in a fresh page.
  const download = page.waitForEvent('download', { timeout: 10 * 60_000 });
  await page.keyboard.press('ControlOrMeta+s');
  const file = await download;
  const dir = await mkdtemp(join(tmpdir(), 'farcel-bench-'));
  const path = join(dir, file.suggestedFilename());
  await file.saveAs(path);
  const saved = (await measures(page, 'engine:save')).at(-1)!;
  const bytes = (await readFile(path)).length;
  await page.context().close();
  const reopened = await openPage(app.browser, app.url);
  await reopened.page.setInputFiles('[data-testid=open-input]', path);
  await reopened.page.waitForFunction(() => /^(Aberto|.*farcel)/.test(document.querySelector('.doc-pane:not([hidden]) [data-testid=status-message]')?.textContent ?? '') , null, { timeout: 10 * 60_000 });
  const openStatus = await reopened.page.textContent(inPane('[data-testid=status-message]'));
  assert.match(openStatus ?? '', /^Aberto/);
  const opened = (await measures(reopened.page, 'engine:open')).at(-1)!;
  await reopened.page.locator(inPane('.sheet-tab'), { hasText: 'Resumo' }).click();
  await idle(reopened.page);
  const reopenedSum = await copyText(reopened.page, 'B1');
  assert.equal(Math.round(parseNumber(reopenedSum) * 100), expected.revenueCents - firstRow.revenueCents + 100_000 - [...syntheticRows(2, DEFAULT_SEED)][1].revenueCents);
  report.file = {
    format: '.farcel (IronCalc Model.toBytes + JSON header + CRC32); not XLSX',
    bytes, saveEngineMs: round((saved.detail as { engineMs: number }).engineMs), saveRoundTripMs: round(saved.duration),
    openWallMs: round(opened.duration), openEngineMs: round((opened.detail as { engineMs: number }).engineMs), evaluateOnOpenMs: round((opened.detail as { evaluateMs: number }).evaluateMs),
    reopenedValuesMatch: true,
  };
  report.memoryAfterReopen = await memory(reopened.page);
  report.pageErrors = [...errors, ...reopened.errors];
  console.log('Arquivo', report.file);
  report.limitations = [
    'Single run on a Linux container; no Windows machine, no packaged app.',
    'Headless Chromium; GPU and display timings of a real desktop are not represented.',
    'WASM linear memory never shrinks: the value is the high-water mark of the worker.',
    'Chromium RSS is the sum over all Chromium processes found by ps, including the browser process.',
    'Five columns and three aggregate formulas; no per-row formulas (see docs/results for the Node WASM measurement of formula columns).',
  ];
} finally {
  await app.close();
}

await mkdir(new URL('../reports/', import.meta.url), { recursive: true });
await writeFile(new URL('../reports/browser-million.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log('Relatório: reports/browser-million.json');
