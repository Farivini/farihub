import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { copyText, idle, inPane, openPage, select, startApp, typeAt } from './harness.ts';
import { decodeFarcel } from '../../src/core/file-format.ts';

let app: Awaited<ReturnType<typeof startApp>>;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

// Grid geometry at 100%: row header 56 px, column header 30 px, rows 28 px, columns 124 px.
const HEADER = 30, ROW = 28, COLUMN = 124, ROW_HEADER = 56;

const DATA = [
  'Nome\tRegião\tValor\tData',
  'Ana\tSul\t10\t05/01/2026',
  'Beto\tNorte\t30\t02/01/2026',
  'Caio\tSul\t20\t',
  'Dani\tLeste\t5\t10/01/2026',
  'Eva\tNorte\t15\t01/12/2025',
].join('\n');

async function pasteData(page: Page, text = DATA, at = 'A1') {
  await select(page, at);
  await page.evaluate(t => navigator.clipboard.writeText(t), text);
  await page.keyboard.press('ControlOrMeta+v');
  await idle(page);
}

/** Viewport point of the shown row at display position `index` (1 = first row on screen), column `column`. */
async function point(page: Page, index: number, column: number, dx = 40) {
  const box = (await page.locator(inPane('[data-testid=grid-scroller]')).boundingBox())!;
  return { x: box.x + ROW_HEADER + (column - 1) * COLUMN + dx, y: box.y + HEADER + (index - 1) * ROW + ROW / 2 };
}

async function openFilter(page: Page, column: number) {
  const p = await point(page, 1, column, COLUMN - 10);
  await page.mouse.click(p.x, p.y);
  await page.waitForSelector('[data-testid=filter-values]');
}

async function contextMenu(page: Page, at: { x: number; y: number }) {
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await page.waitForSelector('[data-testid=context-menu]');
}

async function waitStatus(page: Page, pattern: RegExp) {
  await page.waitForFunction(([sel, source]) => new RegExp(source).test(document.querySelector(sel)?.textContent ?? ''), [inPane('[data-testid=status-message]'), pattern.source] as const);
}

test('filter: values with counts, search, apply; hidden rows marked; copy and clear only shown rows; remove', async () => {
  const { page, errors } = await openPage(app.browser, app.url);
  await pasteData(page);
  await select(page, 'B3');
  await page.click(inPane('[data-testid=filter-toggle]'));
  await waitStatus(page, /^Filtro em A1:D6/);
  assert.equal(await page.getAttribute(inPane('[data-testid=filter-toggle]'), 'aria-pressed'), 'true');

  await openFilter(page, 2);
  assert.deepEqual(await page.locator('[data-testid=filter-values] label').allTextContents(), ['Selecionar tudo', 'Leste1', 'Norte2', 'Sul2']);
  await page.fill('[data-testid=filter-search]', 'nor');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=filter-values] label').length === 2);
  await page.click('[data-testid=filter-apply]');
  await waitStatus(page, /^Filtrado por B/);
  await idle(page);
  assert.match(await page.textContent(inPane('[data-testid=filter-status]')) ?? '', /2 de 5 linhas/);
  assert.equal(await copyText(page, 'A1:B6'), 'Nome\tRegião\nBeto\tNorte\nEva\tNorte', 'only shown rows are copied');

  // Arrow keys skip the hidden rows.
  await select(page, 'A3');
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(sel => (document.querySelector(sel) as HTMLInputElement).value !== 'A3', inPane('[aria-label="Caixa de nome"]'), { timeout: 5000 }).catch(() => {});
  assert.equal(await page.inputValue(inPane('[aria-label="Caixa de nome"]')), 'A6');

  // Delete on a filtered range clears only the shown rows.
  await select(page, 'C2:C6');
  await page.keyboard.press('Delete');
  await idle(page);
  await page.keyboard.press('ControlOrMeta+Shift+l'); // remove the filter
  await waitStatus(page, /^Filtro removido/);
  await idle(page);
  assert.equal(await copyText(page, 'C2:C6'), '10\n\n20\n5\n', 'hidden rows kept their values');
  assert.equal(await page.locator(inPane('[data-testid=filter-status]')).count(), 0);
  await page.keyboard.press('ControlOrMeta+z'); // the filter comes back
  await idle(page);
  assert.match(await page.textContent(inPane('[data-testid=filter-status]')) ?? '', /2 de 5 linhas/);
  assert.deepEqual(errors, []);
});

test('sort from the context menu moves whole records; undo restores; a partial selection asks for the whole table', async () => {
  const { page, errors } = await openPage(app.browser, app.url);
  await pasteData(page);
  await typeAt(page, 'E1', 'Dobro');
  for (let r = 2; r <= 6; r++) await typeAt(page, `E${r}`, `=C${r}*2`);
  await select(page, 'C3');
  await contextMenu(page, await point(page, 3, 3));
  await page.click('[data-testid=menu-sort-desc]');
  await waitStatus(page, /^Ordenado A2:E6 por C ↓ · cabeçalho mantido/);
  await idle(page);
  assert.equal(await copyText(page, 'A1:E6'), [
    'Nome\tRegião\tValor\tData\tDobro',
    'Beto\tNorte\t30\t02/01/2026\t60',
    'Caio\tSul\t20\t\t40',
    'Eva\tNorte\t15\t01/12/2025\t30',
    'Ana\tSul\t10\t05/01/2026\t20',
    'Dani\tLeste\t5\t10/01/2026\t10',
  ].join('\n'));
  await select(page, 'E2');
  assert.equal(await page.inputValue(inPane('[data-testid=formula-bar]')), '=C2*2');
  await page.keyboard.press('ControlOrMeta+z');
  await idle(page);
  assert.equal(await copyText(page, 'A2:A6'), 'Ana\nBeto\nCaio\nDani\nEva');

  // Selecting only the names column: the person chooses the whole table.
  await select(page, 'A2:A6');
  await contextMenu(page, await point(page, 3, 1));
  await page.click('[data-testid=menu-sort-desc]');
  await page.waitForSelector('[data-testid=sort-ambiguous]');
  assert.match(await page.textContent('[data-testid=sort-ambiguous]') ?? '', /A2:A6 faz parte da tabela A1:E6/);
  await page.click('[data-testid=sort-whole-table]');
  await waitStatus(page, /^Ordenado A2:E6 por A ↓/);
  await idle(page);
  assert.equal(await copyText(page, 'A2:C3'), 'Eva\tNorte\t15\nDani\tLeste\t5', 'records stayed together');
  assert.deepEqual(errors, []);
});

test('sort dialog: two levels and the header option', async () => {
  const { page, errors } = await openPage(app.browser, app.url);
  await pasteData(page);
  await select(page, 'B2');
  await page.click(inPane('[data-testid=sort-open]'));
  await page.waitForSelector('[data-testid=sort-dialog]');
  assert.equal(await page.isChecked('[data-testid=sort-header]'), true, 'text over values: a header');
  await page.click('[data-testid=sort-add-level]');
  const selects = page.locator('[data-testid=sort-levels] select');
  await selects.nth(2).selectOption('3');
  await selects.nth(3).selectOption('desc');
  await page.click('[data-testid=sort-apply]');
  await waitStatus(page, /^Ordenado A2:D6 por B ↑, C ↓/);
  await idle(page);
  assert.equal(await copyText(page, 'A2:A6'), 'Dani\nBeto\nEva\nCaio\nAna');
  assert.deepEqual(errors, []);
});

test('insert and delete rows and columns from the headers; references in other sheets follow; undo and redo', async () => {
  const { page, errors } = await openPage(app.browser, app.url);
  await pasteData(page);
  await page.click(inPane('.sheet-add'));
  await page.waitForSelector(inPane('.grid-root[aria-label="Planilha Planilha2"]'));
  await idle(page);
  await typeAt(page, 'A1', '=SOMA(Planilha1!C2:C6)');
  await typeAt(page, 'A2', '=Planilha1!A3');
  await page.locator(inPane('.sheet-tab'), { hasText: 'Planilha1' }).click();
  await page.waitForSelector(inPane('.grid-root[aria-label="Planilha Planilha1"]'));
  await idle(page);

  // Two whole rows selected, then "insert above" from their row header.
  const box = (await page.locator(inPane('[data-testid=grid-scroller]')).boundingBox())!;
  await select(page, 'A2:XFD3');
  await contextMenu(page, { x: box.x + 20, y: box.y + HEADER + ROW + ROW / 2 });
  assert.equal(await page.locator('[data-testid=menu-insert-columns-left]').count(), 0, 'row menu has row actions only');
  await page.click('[data-testid=menu-insert-rows-above]');
  await waitStatus(page, /^Inseridas 2 linhas acima da 2/);
  await idle(page);
  assert.equal(await copyText(page, 'A2:A4'), '\n\nAna');

  // A column from its header.
  await contextMenu(page, { x: box.x + ROW_HEADER + COLUMN + 40, y: box.y + HEADER / 2 });
  await page.click('[data-testid=menu-insert-columns-left]');
  await waitStatus(page, /^Inserida 1 coluna à esquerda de B/);
  await idle(page);

  await page.locator(inPane('.sheet-tab'), { hasText: 'Planilha2' }).click();
  await page.waitForSelector(inPane('.grid-root[aria-label="Planilha Planilha2"]'));
  await idle(page);
  await select(page, 'A1');
  await page.waitForFunction(sel => (document.querySelector(sel) as HTMLInputElement).value === '=SOMA(Planilha1!D4:D8)', inPane('[data-testid=formula-bar]'));
  assert.equal(await copyText(page, 'A1:A2'), '80\nBeto');

  // Delete the row Beto is in: the reference becomes #REF!; undo restores it.
  await page.locator(inPane('.sheet-tab'), { hasText: 'Planilha1' }).click();
  await page.waitForSelector(inPane('.grid-root[aria-label="Planilha Planilha1"]'));
  await idle(page);
  await select(page, 'A5');
  await contextMenu(page, await point(page, 5, 1));
  await page.click('[data-testid=menu-delete-rows]');
  await waitStatus(page, /^Excluída 1 linha \(5\)/);
  await idle(page);
  await page.locator(inPane('.sheet-tab'), { hasText: 'Planilha2' }).click();
  await page.waitForSelector(inPane('.grid-root[aria-label="Planilha Planilha2"]'));
  await idle(page);
  assert.equal(await copyText(page, 'A1:A2'), '50\n#REF!');
  await page.keyboard.press('ControlOrMeta+z');
  await idle(page);
  assert.equal(await copyText(page, 'A1:A2'), '80\nBeto');
  await page.keyboard.press('ControlOrMeta+y');
  await idle(page);
  assert.equal(await copyText(page, 'A1:A2'), '50\n#REF!');
  assert.deepEqual(errors, []);
});

test('the filter is kept in .farcel; XLSX keeps hidden rows and lists the filter as a loss; pivots read the whole base', async () => {
  const recording = () => {
    const w = window as unknown as { farivFiles: unknown; saves: Array<{ name: string; bytes: number[] }> };
    w.saves = [];
    w.farivFiles = { save(name: string, bytes: Uint8Array) { w.saves.push({ name, bytes: Array.from(bytes) }); return Promise.resolve(name); } };
  };
  const { page, errors } = await openPage(app.browser, app.url, undefined, recording);
  await pasteData(page);
  await select(page, 'A1');
  await page.keyboard.press('ControlOrMeta+Shift+l');
  await waitStatus(page, /^Filtro em A1:D6/);
  await idle(page);
  await openFilter(page, 2);
  await page.locator('[data-testid=filter-values] label', { hasText: 'Sul' }).click();
  await page.click('[data-testid=filter-apply]');
  await waitStatus(page, /^Filtrado por B/);

  await page.click(inPane('[data-testid=new-pivot]'));
  await page.waitForFunction(sel => document.querySelector(sel)?.textContent?.includes('base inteira, inclusive linhas ocultas pelo filtro'), inPane('.farcel-body'));
  await page.locator(inPane('.sheet-tab'), { hasText: 'Planilha1' }).click();
  await idle(page);

  await page.keyboard.press('ControlOrMeta+s');
  await page.waitForSelector('[data-testid=save-as]');
  await page.check('[data-testid=save-format] input[value=xlsx]');
  assert.match(await page.textContent('[data-testid=save-losses]') ?? '', /O filtro de 1 planilha \(botões e critérios\)/);
  await page.check('[data-testid=save-format] input[value=farcel]');
  await page.fill('[data-testid=save-name]', 'filtrada');
  await page.click('[data-testid=save-as-confirm]');
  await page.waitForFunction(() => (window as unknown as { saves: unknown[] }).saves.length === 1);
  const file = Buffer.from(await page.evaluate(() => (window as unknown as { saves: Array<{ bytes: number[] }> }).saves[0].bytes));
  const filters = decodeFarcel(new Uint8Array(file)).header.app.filters as unknown[][];
  assert.equal(filters[0].length, 1);

  const path = join(await mkdtemp(join(tmpdir(), 'farcel-filter-')), 'filtrada.farcel');
  await writeFile(path, file);
  const reopened = await openPage(app.browser, app.url);
  await reopened.page.setInputFiles('[data-testid=open-input]', path);
  await waitStatus(reopened.page, /^Aberto filtrada\.farcel/);
  await idle(reopened.page);
  assert.match(await reopened.page.textContent(inPane('[data-testid=filter-status]')) ?? '', /3 de 5 linhas/);
  assert.equal(await copyText(reopened.page, 'A1:A6'), 'Nome\nBeto\nDani\nEva');
  await openFilter(reopened.page, 2);
  assert.deepEqual(await reopened.page.locator('[data-testid=filter-values] label:has(input:checked)').allTextContents(), ['Leste1', 'Norte2'], 'the criterion came back with the file');
  assert.deepEqual([...errors, ...reopened.errors], []);
});
