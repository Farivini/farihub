/**
 * Filters and sort through the Planilhas UI in Chromium, on the synthetic base: the filter
 * shortcut, the values list of a filter button, a filter applied from it, sort from the context
 * menu, undo. Each time is from the action to the grid showing the result (data-settled).
 * Run `npm run build` first. Usage: node scripts/bench-table-browser.ts [rows] (default 1,000,000).
 * Writes reports/table-browser-<rows>.json. Numbers are from this machine and browser only.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import type { Page } from 'playwright';
import { idle, inPane, openPage, select, startApp } from '../tests/e2e/harness.ts';
import { DEFAULT_SEED } from '../src/core/synthetic.ts';

const ROWS = Number(process.argv[2] ?? 1_000_000);
const round = (n: number) => Math.round(n * 10) / 10;
const MiB = (n: number | null) => n === null ? null : round(n / 1024 / 1024);
const LONG = 10 * 60_000;
// Grid geometry at 100% (see Grid.tsx); the row header grows with 7-digit row numbers.
const HEADER = 30, ROW = 28, COLUMN = 124;

function chromiumRssBytes(): number | null {
  try {
    const out = execFileSync('ps', ['-eo', 'rss=,args='], { encoding: 'utf8' });
    return out.split('\n').filter(line => /chrom/i.test(line) && !/ps -eo/.test(line))
      .reduce((sum, line) => sum + Number(line.trim().split(/\s+/)[0] || 0) * 1024, 0);
  } catch {
    return null;
  }
}

async function memory(page: Page) {
  const wasm = await page.evaluate(() => (window as unknown as { farcelDiagnostics: { stats(): Promise<{ wasmMemoryBytes: number | null }> } }).farcelDiagnostics.stats().then(s => s.wasmMemoryBytes));
  return { ironcalcWasmMiB: MiB(wasm), chromiumProcessesRssMiB: MiB(chromiumRssBytes()) };
}

const statusText = (page: Page) => page.textContent(inPane('[data-testid=status-message]')).then(t => t ?? '');

/** Waits for a status message containing `text` (each step expects a message no earlier step left). */
async function waitStatus(page: Page, text: string) {
  await page.waitForFunction(([sel, t]) => document.querySelector(sel)?.textContent?.includes(t), [inPane('[data-testid=status-message]'), text] as const, { timeout: LONG });
}

const tableMeasures = (page: Page) => page.evaluate(() => performance.getEntriesByType('measure').filter(e => e.name.startsWith('table:'))
  .map(e => ({ name: e.name, engineMs: ((e as PerformanceMeasure).detail as { engineMs?: number } | null)?.engineMs ?? null })));

/** Wall time of `action` until `done` resolves and the grid has drawn the current revision. */
async function timed(page: Page, label: string, action: () => Promise<void>, done: () => Promise<void>) {
  const before = (await tableMeasures(page)).length;
  const started = Date.now();
  await action();
  await done();
  await page.waitForFunction(() => [...document.querySelectorAll('.doc-pane:not([hidden]) .grid-root')].every(g => g.getAttribute('data-settled') === 'true'), null, { timeout: LONG });
  const wallMs = Date.now() - started;
  // Time spent in the worker on the table operation of this step, if the step ran one.
  const engine = (await tableMeasures(page)).slice(before).at(-1);
  const entry = { label, wallMs, workerMs: engine?.engineMs != null ? round(engine.engineMs) : null, status: await statusText(page), ...await memory(page) };
  console.log(`  ${label}: ${wallMs.toLocaleString('pt-BR')} ms (motor ${entry.workerMs ?? '—'} ms) · WASM ${entry.ironcalcWasmMiB} MiB · Chromium ${entry.chromiumProcessesRssMiB} MiB`);
  return entry;
}

const app = await startApp();
const report: Record<string, unknown> = {
  createdAt: new Date().toISOString(),
  scope: 'Planilhas UI in headless Chromium (Playwright), production build served by vite preview; the engine runs in its Web Worker. Not Windows, not a packaged app.',
  environment: {
    browser: `Chromium ${app.browser.version()}`, os: `${platform()} ${release()} ${arch()}`,
    cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), node: process.version,
  },
  corpus: { rows: ROWS, seed: DEFAULT_SEED, columns: ['Região', 'Canal', 'Categoria', 'Quantidade', 'Receita'] },
};

try {
  const { page, errors } = await openPage(app.browser, app.url);
  console.log(`Gerando ${ROWS.toLocaleString('pt-BR')} linhas…`);
  await page.click('[data-testid=files-menu]');
  await page.click('role=menuitem[name=/Base de teste/]');
  await page.fill('.dialog input[name=rows]', String(ROWS));
  await page.click('.dialog button.primary');
  await page.waitForSelector('[data-testid=generation-report]', { timeout: LONG });
  await idle(page);
  const steps: unknown[] = [{ label: 'after generation', ...await memory(page) }];
  const scroller = (await page.locator(inPane('[data-testid=grid-scroller]')).boundingBox())!;
  await select(page, 'A1');
  // The cell editor sits on the active cell (A1): its left edge is the row header width.
  const rowHeader = await page.evaluate(sel => (document.querySelector(sel) as HTMLElement).offsetLeft, inPane('[data-testid=cell-editor]'));
  steps.push(await timed(page, 'filter on (Ctrl+Shift+L)', () => page.keyboard.press('ControlOrMeta+Shift+l'), () => waitStatus(page, 'Filtro em A1:E')));
  const openFilter = async (column: number) => {
    await page.mouse.click(scroller.x + rowHeader + column * COLUMN - 10, scroller.y + HEADER + ROW / 2);
  };
  steps.push(await timed(page, 'values list of Região (button → list shown)', () => openFilter(1),
    () => page.waitForSelector('[data-testid=filter-values]', { timeout: LONG }).then(() => {})));
  await page.click('[data-testid=filter-all]');
  await page.locator('[data-testid=filter-values] label', { hasText: /^Sul/ }).click();
  steps.push(await timed(page, 'apply Região = Sul (hides ~80%)', () => page.click('[data-testid=filter-apply]'), () => waitStatus(page, 'Filtrado por A')));
  const shown = await page.textContent(inPane('[data-testid=filter-status]'));
  steps.push(await timed(page, 'PageDown ×20 over the filtered rows', async () => { for (let i = 0; i < 20; i++) await page.keyboard.press('PageDown'); }, async () => {}));
  await select(page, 'A1');
  steps.push(await timed(page, 'filter off (Ctrl+Shift+L)', () => page.keyboard.press('ControlOrMeta+Shift+l'), () => waitStatus(page, 'Filtro removido')));
  await select(page, 'E2');
  steps.push(await timed(page, 'sort Receita descending (context menu)', async () => {
    await page.mouse.click(scroller.x + rowHeader + 4 * COLUMN + 40, scroller.y + HEADER + ROW + ROW / 2, { button: 'right' });
    await page.click('[data-testid=menu-sort-desc]');
  }, () => waitStatus(page, 'por E ↓')));
  steps.push(await timed(page, 'undo the sort (Ctrl+Z)', () => page.keyboard.press('ControlOrMeta+z'), async () => {
    await page.waitForFunction(sel => !document.querySelector(sel)?.classList.contains('busy'), inPane('[data-testid=engine-state]'), { timeout: LONG });
  }));
  await select(page, 'A2');
  steps.push(await timed(page, 'sort Região, Canal (dialog, two levels)', async () => {
    await page.click(inPane('[data-testid=sort-open]'));
    await page.waitForSelector('[data-testid=sort-dialog]');
    await page.click('[data-testid=sort-add-level]');
    await page.click('[data-testid=sort-apply]');
  }, () => waitStatus(page, 'por A ↑, B ↑')));
  report.steps = steps;
  report.filterShown = shown;
  report.errors = errors;
} finally {
  await app.close();
}

await mkdir(new URL('../reports/', import.meta.url), { recursive: true });
const name = `table-browser-${ROWS}.json`;
await writeFile(new URL(`../reports/${name}`, import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(`Relatório: reports/${name}`);
