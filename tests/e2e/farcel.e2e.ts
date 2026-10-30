import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { decodeFarcel } from '../../src/core/file-format.ts';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { PANE, copyText, formulaBar, idle, inPane, openPage, select, startApp, typeAt } from './harness.ts';

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
  await page.fill(inPane('[data-testid=formula-bar]'), '=ARRED(A3/3;1)');
  await page.press(inPane('[data-testid=formula-bar]'), 'Enter');
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
  assert.equal(await page.inputValue(inPane('[aria-label="Caixa de nome"]')), 'C4');
  await select(page, 'B2');
  await page.keyboard.press('ControlOrMeta+ArrowDown');
  await page.waitForFunction(b => (document.querySelector(b) as HTMLInputElement).value === 'B4', inPane('[aria-label="Caixa de nome"]'));
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
  await page.waitForSelector(inPane('[data-testid=pivot-info][data-status=ready]'));
  await page.click(inPane('[data-testid=pivot-table] [data-testid=grid-scroller]'), { position: { x: 100, y: 40 } });
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
  await page.click(inPane('[data-testid=new-pivot]'));
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
  assert.equal(await page.locator(inPane('.chart-bar')).count(), 6, 'one bar per region and channel');
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
  await page.locator(inPane('.sheet-tab'), { hasText: 'Planilha1' }).click();
  await typeAt(page, 'C2', '100');
  await page.locator(inPane('.sheet-tab.pivot button[role=tab]')).click();
  await pivotShows(page, /Sul\t100\t5\t105\nTotal geral\t108\t25\t133$/);
  assert.deepEqual(errors, []);
});

test('save to .farcel and reopen restores cells, formulas, accents and the pivot', async () => {
  const { page, errors } = await fresh();
  await salesData(page);
  await typeAt(page, 'E1', '=SOMASE(A2:A6;"Sul";C2:C6)');
  await typeAt(page, 'E2', 'Observação: preço médio');
  await page.click(inPane('[data-testid=new-pivot]'));
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
  await page.waitForFunction(() => document.querySelector('.doc-pane:not([hidden]) [data-testid=status-message]')?.textContent?.includes('Não é XLSX'));

  const second = await openPage(app.browser, app.url);
  await second.page.setInputFiles('[data-testid=open-input]', path);
  await second.page.waitForFunction(() => document.querySelector('.doc-pane:not([hidden]) [data-testid=status-message]')?.textContent?.startsWith('Aberto'));
  assert.equal(await pivotShows(second.page, before), before, 'pivot configuration and result restored');
  await second.page.locator(inPane('.sheet-tab'), { hasText: 'Planilha1' }).click();
  await page.locator(inPane('.sheet-tab'), { hasText: 'Planilha1' }).click();
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
  await second.page.waitForSelector('[data-testid=notice] >> text=corrompido');
  assert.equal(await second.page.locator('[data-testid=doc-tab]').count(), 1, 'the tab opened for the bad file is closed');
  assert.equal(await copyText(second.page, 'E2'), 'Observação: preço médio', 'current workbook kept');
  assert.deepEqual([...errors, ...second.errors], []);
});

test('spaces, assistant context and honest placeholders', async () => {
  const { page, errors } = await fresh();
  await salesData(page);
  await page.waitForFunction(() => document.querySelector('[data-testid=assistant-context]')?.textContent?.includes('Região · Canal · Receita'));
  const context = await page.textContent('[data-testid=assistant-context]');
  assert.match(await page.textContent('.assistant-scope') ?? '', /^Pasta1 · Planilha1 · /);
  assert.match(context!, /Linhas de dados5/);
  assert.equal(await page.locator('.composer textarea').isDisabled(), true);
  assert.equal(await page.locator('.composer .send').isDisabled(), true);
  // Visible names, not internal ids.
  assert.deepEqual(await page.locator('.space-switcher [role=tab]').allTextContents(), ['Planilhas', 'Documentos', 'Apresentações']);
  assert.equal(await page.evaluate(() => /Farcel|Fardoc|Farcanvas/.test(document.body.innerText)), false, 'internal names are not visible');
  await page.click('[data-testid=space-fardoc]');
  await page.waitForSelector('[data-testid=placeholder] >> text=Em preparação');
  assert.match(await page.textContent('[data-testid=placeholder]') ?? '', /^Documentos/);
  await page.click('[data-testid=space-farcanvas]');
  assert.match(await page.textContent('[data-testid=placeholder]') ?? '', /^Apresentações/);
  await page.click('[data-testid=space-farcel]');
  assert.equal(await copyText(page, 'A2'), 'Sul', 'workbook kept while switching spaces');
  assert.deepEqual(errors, []);
});

test('formatting: number formats, bold and alignment through the toolbar, kept on reopen', async () => {
  const { page, errors } = await fresh();
  await page.evaluate(() => navigator.clipboard.writeText('Receita\tMargem\n1234,5\t0,265\n99\t0,1'));
  await select(page, 'A1');
  await page.keyboard.press('ControlOrMeta+v');
  await idle(page);
  await select(page, 'A2:A3');
  await page.click(inPane('[data-testid=number-format]'));
  await page.click('role=menuitemradio[name=/Moeda/]');
  await idle(page);
  await select(page, 'B2:B3');
  await page.click(inPane('[data-testid=number-format]'));
  await page.click('role=menuitemradio[name=/Porcentagem/]');
  await idle(page);
  await select(page, 'A1:B1');
  await page.click(inPane('[data-testid=bold]'));
  await page.click(inPane('[aria-label=Centralizar]'));
  await idle(page);
  assert.equal(await copyText(page, 'A2:B3'), 'R$ 1.234,50\t26,5%\nR$ 99,00\t10,0%');
  await select(page, 'A1');
  assert.equal(await page.getAttribute(inPane('[data-testid=bold]'), 'aria-pressed'), 'true');
  assert.equal(await page.getAttribute(inPane('[aria-label=Centralizar]'), 'aria-pressed'), 'true');
  assert.equal(await formulaBar(page), 'Receita', 'formatting does not change the value');
  await select(page, 'A2:A3');
  await page.waitForFunction(p => document.querySelector(`${p} [data-testid=selection-stats]`)?.textContent?.includes('Soma: R$ 1.333,5'), PANE);
  await select(page, 'B2:B3');
  await page.waitForFunction(p => document.querySelector(`${p} [data-testid=selection-stats]`)?.textContent?.includes('Soma: 36,5%'), PANE);
  // Undo removes one formatting step at a time.
  await page.keyboard.press('ControlOrMeta+z');
  await idle(page);
  await select(page, 'A1');
  assert.equal(await page.getAttribute(inPane('[aria-label=Centralizar]'), 'aria-pressed'), 'false');
  // Save and reopen keeps the formats.
  const download = page.waitForEvent('download');
  await page.keyboard.press('ControlOrMeta+s');
  const dir = await mkdtemp(join(tmpdir(), 'farcel-format-'));
  const path = join(dir, 'formatos.farcel');
  await (await download).saveAs(path);
  const second = await openPage(app.browser, app.url);
  await second.page.setInputFiles('[data-testid=open-input]', path);
  await second.page.waitForFunction(() => document.querySelector('.doc-pane:not([hidden]) [data-testid=save-state]')?.textContent?.includes('Salvo neste dispositivo'));
  assert.equal(await copyText(second.page, 'A2:B3'), 'R$ 1.234,50\t26,5%\nR$ 99,00\t10,0%');
  await select(second.page, 'A1');
  assert.equal(await second.page.getAttribute(inPane('[data-testid=bold]'), 'aria-pressed'), 'true');
  assert.deepEqual([...errors, ...second.errors], []);
});

test('workbook tabs: each tab keeps its own workbook; switching spaces keeps the work', async () => {
  const { page, errors } = await fresh();
  await typeAt(page, 'A1', 'Primeira pasta');
  await page.click('button[aria-label="Nova planilha"].doc-new');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=doc-tab]').length === 2);
  await page.waitForFunction(p => document.querySelector(`${p} [data-testid=engine-state]`)?.textContent?.includes('IronCalc'), PANE);
  assert.equal(await copyText(page, 'A1'), '', 'new tab starts empty');
  await typeAt(page, 'A1', '=1+1');
  assert.equal(await copyText(page, 'A1'), '2');
  await page.locator('[data-testid=doc-tab] [role=tab]').first().click();
  assert.equal(await copyText(page, 'A1'), 'Primeira pasta');
  await page.click('[data-testid=space-farcanvas]');
  await page.click('[data-testid=space-farcel]');
  assert.equal(await copyText(page, 'A1'), 'Primeira pasta', 'kept after switching spaces');
  // Closing a tab with unsaved changes asks first.
  await page.locator('[data-testid=doc-tab] .doc-close').nth(1).click();
  await page.waitForSelector('[data-testid=confirm-close]');
  await page.click('[data-testid=confirm-close] button.danger');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=doc-tab]').length === 1);
  assert.equal(await copyText(page, 'A1'), 'Primeira pasta');
  // An edit still in the cell editor counts as unsaved work when the tab is closed.
  await page.click('button[aria-label="Nova planilha"].doc-new');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=doc-tab]').length === 2);
  await page.waitForFunction(p => document.querySelector(`${p} [data-testid=engine-state]`)?.textContent?.includes('IronCalc'), PANE);
  await select(page, 'B2');
  await page.keyboard.type('digitado agora');
  await page.locator('[data-testid=doc-tab] .doc-close').nth(1).click();
  await page.waitForSelector('[data-testid=confirm-close]');
  await page.click('[data-testid=confirm-close] button:not(.danger)');
  await idle(page);
  assert.equal(await copyText(page, 'B2'), 'digitado agora', 'edit kept after cancelling the close');
  assert.deepEqual(errors, []);
});

test('window controls are not presented as working in the browser; assistant collapses and resizes', async () => {
  const { page, errors } = await fresh();
  const controls = page.locator('.window-controls');
  assert.equal(await controls.getAttribute('class'), 'window-controls unavailable');
  assert.equal(await controls.locator('button').count(), 0, 'no clickable fake window buttons');
  assert.match(await controls.getAttribute('aria-label') ?? '', /indisponíveis no navegador/);
  const panel = page.locator('aside.assistant');
  const before = (await panel.boundingBox())!.width;
  const handle = (await page.locator('.assistant-resizer').boundingBox())!;
  await page.mouse.move(handle.x + 2, handle.y + 200);
  await page.mouse.down();
  await page.mouse.move(handle.x - 80, handle.y + 200, { steps: 5 });
  await page.mouse.up();
  const after = (await panel.boundingBox())!.width;
  assert.ok(after > before + 60, `assistant widened (${before} -> ${after})`);
  await page.click('[data-testid=assistant-toggle]');
  assert.equal(await panel.count(), 0);
  await page.click('[data-testid=assistant-toggle]');
  assert.equal(await page.locator('aside.assistant').count(), 1);
  // Function menu inserts a pt-BR function into the formula bar.
  await select(page, 'C3');
  await page.click(inPane('[data-testid=function-menu]'));
  await page.fill('.function-menu input', 'procv');
  await page.keyboard.press('Enter');
  await page.keyboard.type('1;A1:B2;2;FALSO)');
  await page.keyboard.press('Enter');
  await idle(page);
  await select(page, 'C3');
  assert.equal(await formulaBar(page), '=PROCV(1;A1:B2;2;FALSO)');
  assert.deepEqual(errors, []);
});

/** File sink whose write stays pending until the test releases it (a slow disk or dialog). */
function delayedSaves() {
  const w = window as unknown as { farivFiles: unknown; saves: Array<{ name: string; bytes: number[] }>; release: Array<() => void> };
  w.saves = [];
  w.release = [];
  w.farivFiles = {
    save(name: string, bytes: Uint8Array) {
      w.saves.push({ name, bytes: Array.from(bytes) });
      return new Promise<string>(resolve => w.release.push(() => resolve(name)));
    },
  };
}

async function startSave(page: Page, count: number) {
  await page.keyboard.press('ControlOrMeta+s');
  await page.waitForFunction(n => (window as unknown as { saves: unknown[] }).saves.length === n, count);
}

/** Releases a pending write and waits for its own outcome, not the "Salvo …" left by the previous save. */
async function finishSave(page: Page, index: number) {
  const status = '.doc-pane:not([hidden]) [data-testid=status-message]';
  const before = await page.evaluate(s => document.querySelector(s)?.textContent ?? '', status);
  await page.evaluate(i => (window as unknown as { release: Array<() => void> }).release[i](), index);
  await page.waitForFunction(([s, previous]) => {
    const text = document.querySelector(s)?.textContent ?? '';
    return text.startsWith('Salvo') && text !== previous;
  }, [status, before] as const);
}

async function savedBytes(page: Page, index: number): Promise<Buffer> {
  return Buffer.from(await page.evaluate(i => (window as unknown as { saves: Array<{ bytes: number[] }> }).saves[i].bytes, index));
}

const saveState = (page: Page) => page.textContent(inPane('[data-testid=save-state]'));

test('a slow save marks as saved only what the file contains; edits during the write stay pending', async () => {
  const { page, errors } = await openPage(app.browser, app.url, undefined, delayedSaves);
  await typeAt(page, 'A1', 'antes');

  // Cell edit while the write is pending.
  await startSave(page, 1);
  await typeAt(page, 'A2', 'durante');
  await finishSave(page, 0);
  assert.equal(await saveState(page), 'Alterações não salvas', 'the edit made during the write is not in the file');
  assert.equal(await page.locator('[data-testid=doc-tab] .dirty').count(), 1);
  assert.match(await page.textContent(inPane('[data-testid=status-message]')) ?? '', /ainda não estão no arquivo/);

  const dir = await mkdtemp(join(tmpdir(), 'farcel-slow-'));
  const first = join(dir, 'primeiro.farcel');
  await writeFile(first, await savedBytes(page, 0));
  const reopened = await openPage(app.browser, app.url);
  await reopened.page.setInputFiles('[data-testid=open-input]', first);
  await reopened.page.waitForFunction(() => document.querySelector('.doc-pane:not([hidden]) [data-testid=save-state]')?.textContent?.includes('Salvo neste dispositivo'));
  assert.equal(await copyText(reopened.page, 'A1:A2'), 'antes\n', 'file holds the snapshot, not the later edit');

  // A save with nothing happening during the write is clean.
  await startSave(page, 2);
  await finishSave(page, 1);
  assert.equal(await saveState(page), 'Salvo neste dispositivo');

  // Pivot configuration changed while the write is pending.
  await page.click(inPane('[data-testid=new-pivot]'));
  await page.waitForSelector(inPane('[data-testid=field-antes]'));
  assert.equal(await saveState(page), 'Alterações não salvas', 'a new pivot is an unsaved change');
  await startSave(page, 3);
  await page.click(inPane('[data-testid=field-antes]'));
  await finishSave(page, 2);
  assert.equal(await saveState(page), 'Alterações não salvas', 'the pivot change made during the write is not in the file');
  const header = decodeFarcel(new Uint8Array(await savedBytes(page, 2))).header;
  assert.deepEqual((header.app as { pivots: Array<{ config: { rows: string[] } }> }).pivots[0].config.rows, [], 'file holds the pivot as it was at the snapshot');

  await startSave(page, 4);
  await finishSave(page, 3);
  assert.equal(await saveState(page), 'Salvo neste dispositivo');
  const latest = decodeFarcel(new Uint8Array(await savedBytes(page, 3))).header;
  assert.deepEqual((latest.app as { pivots: Array<{ config: { rows: string[] } }> }).pivots[0].config.rows, ['antes']);
  assert.deepEqual([...errors, ...reopened.errors], []);
});
