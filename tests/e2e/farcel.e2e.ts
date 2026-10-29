import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { copyText, formulaBar, idle, openPage, select, startApp, typeAt } from './harness.ts';

let app: Awaited<ReturnType<typeof startApp>>;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

async function fresh(): Promise<{ page: Page; errors: string[] }> {
  const { page, errors } = await openPage(app.browser, app.url);
  return { page, errors };
}

test('typing with accents, IME composition and formula bar', async () => {
  const { page, errors } = await fresh();
  await typeAt(page, 'A1', 'Ação São João ç ü');
  // Dead-key style composition: the editor receives the composed character.
  await select(page, 'A2');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '´', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.insertText', { text: 'é' });
  await page.keyboard.type('gua');
  await page.keyboard.press('Enter');
  await idle(page);
  assert.equal(await copyText(page, 'A1:A2'), 'Ação São João ç ü\négua');
  await select(page, 'A1');
  assert.equal(await formulaBar(page), 'Ação São João ç ü');
  assert.deepEqual(errors, []);
});

test('pt-BR formulas calculate and recalculate after an edit', async () => {
  const { page, errors } = await fresh();
  await typeAt(page, 'A1', '10');
  await typeAt(page, 'A2', '2,5');
  await typeAt(page, 'A3', '=SOMA(A1:A2)');
  await typeAt(page, 'A4', '=SE(A3>12;"alto";"baixo")');
  await typeAt(page, 'A5', '=MÉDIA(A1:A2)');
  assert.equal(await copyText(page, 'A3:A5'), '12,5\nalto\n6,25');
  await typeAt(page, 'A1', '100');
  assert.equal(await copyText(page, 'A3:A5'), '102,5\nalto\n51,25');
  await select(page, 'A4');
  assert.equal(await formulaBar(page), '=SE(A3>12;"alto";"baixo")');
  // Edit through the formula bar.
  await page.fill('[data-testid=formula-bar]', '=ARRED(A3/3;1)');
  await page.press('[data-testid=formula-bar]', 'Enter');
  await idle(page);
  assert.equal(await copyText(page, 'A4'), '34,2');
  // Undo / redo
  await page.keyboard.press('ControlOrMeta+z');
  await idle(page);
  assert.equal(await copyText(page, 'A4'), 'alto');
  await page.keyboard.press('ControlOrMeta+y');
  await idle(page);
  assert.equal(await copyText(page, 'A4'), '34,2');
  assert.deepEqual(errors, []);
});

test('keyboard navigation, delete and selection statistics', async () => {
  const { page } = await fresh();
  await typeAt(page, 'B2', '1');
  await page.keyboard.type('2');
  await page.keyboard.press('Enter');
  await page.keyboard.type('3');
  await page.keyboard.press('Tab');
  await idle(page);
  assert.equal(await page.inputValue('[aria-label="Caixa de nome"]'), 'C4');
  await select(page, 'B2');
  await page.keyboard.press('ControlOrMeta+ArrowDown');
  await page.waitForFunction(() => (document.querySelector('[aria-label="Caixa de nome"]') as HTMLInputElement).value === 'B4');
  await page.keyboard.press('Shift+ArrowUp');
  await page.keyboard.press('Shift+ArrowUp');
  await page.waitForFunction(() => document.querySelector('[data-testid=selection-stats]')?.textContent?.includes('Soma: 6'));
  await page.keyboard.press('Delete');
  await idle(page);
  assert.equal(await copyText(page, 'B2:B4'), '\n\n');
});

test('copy and paste: TSV out, external TSV in, internal paste moves references', async () => {
  const { page, errors } = await fresh();
  // External paste with quotes, tabs inside quotes and line breaks inside quotes.
  await page.evaluate(() => navigator.clipboard.writeText('Região\tReceita\nSul\t10,5\nNorte\t"1.234,5"\n"Centro\tOeste"\t=B2*2'));
  await select(page, 'A1');
  await page.keyboard.press('ControlOrMeta+v');
  await idle(page);
  assert.equal(await copyText(page, 'A1:B4'), 'Região\tReceita\nSul\t10,5\nNorte\t1.234,50\n"Centro\tOeste"\t21');
  // Internal copy of a formula and paste elsewhere: relative reference moves.
  await copyText(page, 'B4');
  await select(page, 'C4');
  await page.keyboard.press('ControlOrMeta+v');
  await idle(page);
  await select(page, 'C4');
  assert.equal(await formulaBar(page), '=C2*2');
  // Undo the paste as a single step.
  await page.keyboard.press('ControlOrMeta+z');
  await idle(page);
  assert.equal(await copyText(page, 'C4'), '');
  assert.deepEqual(errors, []);
});

async function salesData(page: Page) {
  const rows = ['Região\tCanal\tReceita', 'Sul\tLoja\t10', 'Norte\tOnline\t20', 'Sul\tOnline\t5', 'Sudeste\tLoja\t7', 'Norte\tLoja\t1'];
  await page.evaluate(text => navigator.clipboard.writeText(text), rows.join('\n'));
  await select(page, 'A1');
  await page.keyboard.press('ControlOrMeta+v');
  await idle(page);
}

/** Copies the whole pivot result (Ctrl+A, Ctrl+C on the read-only result grid). */
async function copyPivot(page: Page): Promise<string> {
  await page.waitForSelector('[data-testid=pivot-info][data-status=ready]');
  await page.click('[data-testid=pivot-table] [data-testid=grid-scroller]', { position: { x: 100, y: 40 } });
  await page.evaluate(() => navigator.clipboard.writeText('(vazio)'));
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ControlOrMeta+c');
  await page.waitForFunction(() => navigator.clipboard.readText().then(t => t !== '(vazio)'));
  return page.evaluate(() => navigator.clipboard.readText());
}

/** Polls until the pivot shows the expected result (computations are debounced and asynchronous). */
async function pivotShows(page: Page, expected: string | RegExp): Promise<string> {
  const deadline = Date.now() + 15_000;
  let text = '';
  while (Date.now() < deadline) {
    text = await copyPivot(page);
    if (typeof expected === 'string' ? text === expected : expected.test(text)) return text;
    await page.waitForTimeout(150);
  }
  assert.fail(`Pivot did not show ${expected}; last:\n${text}`);
}

test('pivot: rows, columns, sum, count, filter, chart and refresh after edit', async () => {
  const { page, errors } = await fresh();
  await salesData(page);
  await page.click('text=Tabela dinâmica');
  await page.waitForSelector('[data-testid=field-Região]');
  await page.click('[data-testid=field-Região]'); // first click goes to Linhas
  await page.click('[data-testid=field-Receita]'); // then to Valores (Soma)
  await pivotShows(page, 'Região\tSoma de Receita\nNorte\t21\nSudeste\t7\nSul\t15\nTotal geral\t43');
  await page.dragAndDrop('[data-testid=field-Canal]', '[data-testid=zone-columns]');
  await pivotShows(page, [
    'Soma de Receita\tLoja\tOnline\tTotal geral',
    'Região\t\t\t',
    'Norte\t1\t20\t21',
    'Sudeste\t7\t0\t7',
    'Sul\t10\t5\t15',
    'Total geral\t18\t25\t43',
  ].join('\n'));
  assert.equal(await page.locator('.chart-bar').count(), 6, 'one bar per region and channel');
  // Count instead of sum
  await page.click('[data-testid=zone-values] .chip-agg');
  await pivotShows(page, /^Contagem de Receita\tLoja\tOnline\tTotal geral[\s\S]*Total geral\t3\t2\t5$/);
  await page.click('[data-testid=zone-values] .chip-agg');
  // Move Região from Linhas to Filtros and exclude Sul.
  await page.dragAndDrop('[data-testid=field-Região]', '[data-testid=zone-filters]');
  await page.click('[data-testid=zone-filters] .chip-agg');
  await page.locator('.filter-list label', { hasText: 'Sul' }).click();
  await page.click('[aria-label="Fechar filtro"]');
  await pivotShows(page, 'Soma de Receita\tLoja\tOnline\tTotal geral\n\t\t\t\nTotal geral\t8\t20\t28');
  await page.locator('[data-testid=zone-filters] .chip-remove').click();
  await page.dragAndDrop('[data-testid=field-Região]', '[data-testid=zone-rows]');
  // Edit source data: the pivot follows.
  await page.locator('.sheet-tab', { hasText: 'Planilha1' }).click();
  await typeAt(page, 'C2', '100');
  await page.locator('.sheet-tab.pivot button[role=tab]').click();
  await pivotShows(page, /Sul\t100\t5\t105\nTotal geral\t108\t25\t133$/);
  assert.deepEqual(errors, []);
});

test('save to .farcel and reopen restores cells, formulas, accents and the pivot', async () => {
  const { page, errors } = await fresh();
  await salesData(page);
  await typeAt(page, 'E1', '=SOMASE(A2:A6;"Sul";C2:C6)');
  await typeAt(page, 'E2', 'Observação: preço médio');
  await page.click('text=Tabela dinâmica');
  await page.click('[data-testid=field-Região]');
  await page.click('[data-testid=field-Receita]');
  const before = await pivotShows(page, /Total geral\t43$/);
  const download = page.waitForEvent('download');
  await page.keyboard.press('ControlOrMeta+s');
  const file = await download;
  assert.equal(file.suggestedFilename(), 'Pasta1.farcel');
  const dir = await mkdtemp(join(tmpdir(), 'farcel-e2e-'));
  const path = join(dir, 'Pasta1.farcel');
  await file.saveAs(path);
  const bytes = await readFile(path);
  assert.equal(bytes.subarray(0, 8).toString('latin1'), 'FARCEL01');
  await page.waitForFunction(() => document.querySelector('[data-testid=status-message]')?.textContent?.includes('Não é XLSX'));

  const second = await openPage(app.browser, app.url);
  await second.page.setInputFiles('[data-testid=open-input]', path);
  await second.page.waitForFunction(() => document.querySelector('[data-testid=status-message]')?.textContent?.startsWith('Aberto'));
  assert.equal(await pivotShows(second.page, before), before, 'pivot configuration and result restored');
  await second.page.locator('.sheet-tab', { hasText: 'Planilha1' }).click();
  await page.locator('.sheet-tab', { hasText: 'Planilha1' }).click();
  const original = await copyText(page, 'A1:C6');
  assert.equal(await copyText(second.page, 'A1:C6'), original);
  assert.match(original, /^Região\tCanal\tReceita\nSul\tLoja\t10/);
  assert.equal(await copyText(second.page, 'E1:E2'), '15\nObservação: preço médio');
  await select(second.page, 'E1');
  assert.equal(await formulaBar(second.page), '=SOMASE(A2:A6;"Sul";C2:C6)');

  // A corrupted copy is refused with a clear message.
  const corrupted = Buffer.from(bytes);
  corrupted[corrupted.length - 5] ^= 0xff;
  const bad = join(dir, 'corrompido.farcel');
  await writeFile(bad, corrupted);
  await second.page.setInputFiles('[data-testid=open-input]', bad);
  await second.page.waitForFunction(() => document.querySelector('[data-testid=status-message]')?.textContent?.includes('CRC32'));
  assert.equal(await copyText(second.page, 'E2'), 'Observação: preço médio', 'current workbook kept');
  assert.deepEqual([...errors, ...second.errors], []);
});

test('spaces, assistant context and honest placeholders', async () => {
  const { page, errors } = await fresh();
  await salesData(page);
  await page.waitForFunction(() => document.querySelector('[data-testid=assistant-context]')?.textContent?.includes('Região · Canal · Receita'));
  const context = await page.textContent('[data-testid=assistant-context]');
  assert.match(context!, /Linhas de dados5/);
  assert.equal(await page.locator('.assistant-input textarea').isDisabled(), true);
  await page.click('[data-testid=space-fardoc]');
  await page.waitForSelector('text=Em preparação');
  await page.click('[data-testid=space-farcel]');
  assert.equal(await copyText(page, 'A2'), 'Sul', 'workbook kept while switching spaces');
  assert.deepEqual(errors, []);
});
