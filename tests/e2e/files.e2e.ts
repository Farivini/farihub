import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { copyText, formulaBar, idle, inPane, openPage, select, startApp, typeAt } from './harness.ts';
import { WorkbookEngine } from '../../src/engine/workbook-engine.ts';
import { decodeFarcel } from '../../src/core/file-format.ts';
import { xlsxToModel } from '../../src/engine/xlsx.ts';
import { ic } from '../ironcalc-node.ts';
import { xlsxBridge } from '../xlsx-node.ts';

let app: Awaited<ReturnType<typeof startApp>>;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/xlsx/${name}`, import.meta.url));
const status = (page: Page) => page.textContent(inPane('[data-testid=status-message]'));
const saveState = (page: Page) => page.textContent(inPane('[data-testid=save-state]'));

async function waitStatus(page: Page, prefix: string) {
  await page.waitForFunction(p => document.querySelector('.doc-pane:not([hidden]) [data-testid=status-message]')?.textContent?.startsWith(p), prefix);
}

/** The formula bar follows the active cell through an engine request, so wait for the text. */
async function formulaShows(page: Page, expected: string) {
  await page.waitForFunction(([sel, v]) => (document.querySelector(sel) as HTMLInputElement | null)?.value === v, [inPane('[data-testid=formula-bar]'), expected] as const, { timeout: 5000 })
    .catch(async () => assert.equal(await formulaBar(page), expected));
}

/** Switches sheet tab and waits until the grid shows that sheet, so the next selection lands on it. */
async function showSheet(page: Page, name: string) {
  await page.locator(inPane('.sheet-tab'), { hasText: name }).click();
  await page.waitForSelector(inPane(`.grid-root[aria-label="Planilha ${name}"]`));
  await idle(page);
}

/** Runs `action` and returns the file the browser downloads (automation has no native file dialog). */
async function downloadOf(page: Page, action: () => Promise<void>): Promise<{ name: string; bytes: Buffer }> {
  const download = page.waitForEvent('download');
  await action();
  const file = await download;
  const path = join(await mkdtemp(join(tmpdir(), 'farcel-download-')), file.suggestedFilename());
  await file.saveAs(path);
  return { name: file.suggestedFilename(), bytes: await readFile(path) };
}

async function menu(page: Page, label: string) {
  await page.click('[data-testid=files-menu]');
  await page.locator('[role=menuitem]', { hasText: label }).click();
}

/** Desktop-style file access (window.farivFiles): records each written file; nothing is downloaded. */
function recordingFiles() {
  const w = window as unknown as { farivFiles: unknown; saves: Array<{ name: string; bytes: number[] }> };
  w.saves = [];
  w.farivFiles = { save(name: string, bytes: Uint8Array) { w.saves.push({ name, bytes: Array.from(bytes) }); return Promise.resolve(name); } };
}

async function saved(page: Page, count: number): Promise<{ name: string; bytes: Buffer }> {
  await page.waitForFunction(n => (window as unknown as { saves: unknown[] }).saves.length === n, count);
  const file = await page.evaluate(i => (window as unknown as { saves: Array<{ name: string; bytes: number[] }> }).saves[i], count - 1);
  return { name: file.name, bytes: Buffer.from(file.bytes) };
}

function openXlsxBytes(bytes: Uint8Array): WorkbookEngine {
  return WorkbookEngine.fromModelBytes(ic, xlsxToModel(xlsxBridge, bytes, 'exportado').model).engine;
}

test('XLSX: open, edit, Ctrl+S keeps XLSX (a downloaded copy here), reopen; formulas stay formulas in pt-BR', async () => {
  const { page, errors } = await openPage(app.browser, app.url);
  await page.setInputFiles('[data-testid=open-input]', fixture('openpyxl-basico.xlsx'));
  await waitStatus(page, 'Importado openpyxl-basico.xlsx');
  assert.match(await status(page) ?? '', /51 células, 13 fórmulas/);
  assert.equal(await page.locator('[data-testid=import-report]').count(), 0, 'nothing to report for this file');
  assert.equal(await saveState(page), 'Salvo neste dispositivo', 'the workbook matches the file it came from');
  assert.equal(await page.textContent('[data-testid=doc-tab] .doc-title'), 'openpyxl-basico.xlsx');
  assert.equal(await copyText(page, 'A1:C2'), 'Região\tCódigo\tData\nSudeste\t00123\t15/03/2024');
  assert.equal(await copyText(page, 'F6'), 'R$ 1.319,26');
  await select(page, 'F9');
  await formulaShows(page, '=PROCV("Nordeste";A2:F4;6;FALSO)');
  await showSheet(page, 'Resumo Geral');
  assert.equal(await copyText(page, 'B2:B3'), '4,5%\n3');
  await showSheet(page, 'Vendas');

  await typeAt(page, 'D2', '30');
  await typeAt(page, 'A12', '=SOMASE(A2:A4;"Sudeste";F2:F4)');
  assert.equal(await saveState(page), 'Alterações não salvas');
  // Ctrl+S writes the same format and name, without asking: nothing would be lost.
  const copy = await downloadOf(page, () => page.keyboard.press('ControlOrMeta+s'));
  assert.equal(copy.name, 'openpyxl-basico.xlsx');
  assert.equal(await page.locator('[data-testid=save-as], [data-testid=save-confirm]').count(), 0);
  await waitStatus(page, 'Cópia baixada openpyxl-basico.xlsx na pasta de downloads');
  assert.equal(await saveState(page), 'Cópia baixada', 'the browser says it downloaded a copy');

  const back = openXlsxBytes(copy.bytes);
  assert.equal(back.input(0, 12, 1), '=SOMASE(A2:A4;"Sudeste";F2:F4)');
  assert.equal(back.formatted(0, 12, 1), '597');
  assert.equal(back.formatted(0, 6, 6), 'R$ 1.856,56');
  assert.equal(back.formatted(0, 2, 2), '00123');
  assert.deepEqual(back.sheets(), ['Vendas', 'Resumo Geral']);

  // The copy opens in the app again, in a new tab because this one has a file.
  const path = join(await mkdtemp(join(tmpdir(), 'farcel-reopen-')), 'devolvido.xlsx');
  await writeFile(path, copy.bytes);
  await page.setInputFiles('[data-testid=open-input]', path);
  await waitStatus(page, 'Importado devolvido.xlsx');
  assert.equal(await page.locator('[data-testid=doc-tab]').count(), 2);
  await select(page, 'A12');
  await formulaShows(page, '=SOMASE(A2:A4;"Sudeste";F2:F4)');
  assert.deepEqual(errors, []);
});

test('XLSX with losses: Ctrl+S explains them and lets the person choose; once accepted it does not ask again', async () => {
  const { page, errors } = await openPage(app.browser, app.url);
  await page.setInputFiles('[data-testid=open-input]', fixture('openpyxl-recursos.xlsx'));
  await page.waitForSelector('[data-testid=import-report]');
  const lost = await page.textContent('[data-testid=report-lost]') ?? '';
  for (const item of ['gráficos', 'comentários', 'validação de dados', 'filtros aplicados', 'tabelas formatadas']) assert.ok(lost.includes(item), item);
  const kept = await page.textContent('[data-testid=report-kept]') ?? '';
  for (const item of ['células mescladas', 'painéis congelados', 'bordas']) assert.ok(kept.includes(item), item);
  await page.click('[data-testid=import-report] button.primary');
  assert.equal(await copyText(page, 'C2'), '60');

  await page.keyboard.press('ControlOrMeta+s');
  await page.waitForSelector('[data-testid=save-confirm]');
  assert.match(await page.textContent('[data-testid=save-losses]') ?? '', /openpyxl-recursos\.xlsx.*gráficos/);
  assert.equal(await page.textContent('[data-testid=save-anyway]'), 'Baixar XLSX assim mesmo');
  await page.click('[data-testid=save-confirm] footer button:first-child');
  assert.equal(await page.locator('[data-testid=save-confirm]').count(), 0, 'cancel writes nothing');

  // "Salvar como .farcel…" switches to Save as with .farcel chosen.
  await page.keyboard.press('ControlOrMeta+s');
  await page.click('[data-testid=save-as-farcel]');
  assert.equal(await page.isChecked('[data-testid=save-format] input[value=farcel]'), true);
  assert.equal(await page.locator('[data-testid=save-as] [data-testid=save-losses]').count(), 0, '.farcel keeps everything');
  await page.check('[data-testid=save-format] input[value=xlsx]');
  assert.match(await page.textContent('[data-testid=save-losses]') ?? '', /gráficos/);
  await page.click('[data-testid=save-as] footer button:first-child');

  const first = await downloadOf(page, async () => {
    await page.keyboard.press('ControlOrMeta+s');
    await page.click('[data-testid=save-anyway]');
  });
  assert.equal(first.name, 'openpyxl-recursos.xlsx');
  // Accepted once for this workbook: the next Ctrl+S saves directly.
  await typeAt(page, 'D1', 'novo');
  const second = await downloadOf(page, () => page.keyboard.press('ControlOrMeta+s'));
  assert.equal(second.name, 'openpyxl-recursos.xlsx');
  assert.equal(openXlsxBytes(second.bytes).formatted(0, 1, 4), 'novo');
  assert.deepEqual(errors, []);
});

test('the import origin and its warnings are kept in .farcel and shown again when saving XLSX after reopening', async () => {
  const { page, errors } = await openPage(app.browser, app.url, undefined, recordingFiles);
  await page.setInputFiles('[data-testid=open-input]', fixture('openpyxl-recursos.xlsx'));
  await page.waitForSelector('[data-testid=import-report]');
  await page.click('[data-testid=import-report] button.primary');
  await page.keyboard.press('ControlOrMeta+Shift+s');
  await page.waitForSelector('[data-testid=save-as]');
  assert.equal(await page.inputValue('[data-testid=save-name]'), 'openpyxl-recursos');
  assert.equal(await page.locator('[data-testid=download-note]').count(), 0, 'file access: no download note');
  await page.check('[data-testid=save-format] input[value=farcel]');
  await page.fill('[data-testid=save-name]', 'recursos-nativo');
  await page.click('[data-testid=save-as-confirm]');
  const native = await saved(page, 1);
  assert.equal(native.name, 'recursos-nativo.farcel');
  await waitStatus(page, 'Salvo recursos-nativo.farcel');
  assert.equal(await saveState(page), 'Salvo neste dispositivo');
  const origin = decodeFarcel(new Uint8Array(native.bytes)).header.app.origin as { name: string; report: { lost: Record<string, number> } };
  assert.equal(origin.name, 'openpyxl-recursos.xlsx');
  assert.ok(origin.report.lost.charts && origin.report.lost.comments);

  const path = join(await mkdtemp(join(tmpdir(), 'farcel-origin-')), 'recursos-nativo.farcel');
  await writeFile(path, native.bytes);
  const reopened = await openPage(app.browser, app.url, undefined, recordingFiles);
  await reopened.page.setInputFiles('[data-testid=open-input]', path);
  await waitStatus(reopened.page, 'Aberto recursos-nativo.farcel');
  // Ctrl+S keeps .farcel, no question.
  await reopened.page.keyboard.press('ControlOrMeta+s');
  assert.equal((await saved(reopened.page, 1)).name, 'recursos-nativo.farcel');
  // Saving as XLSX still lists what the original file had and was not imported.
  await reopened.page.keyboard.press('ControlOrMeta+Shift+s');
  await reopened.page.check('[data-testid=save-format] input[value=xlsx]');
  assert.match(await reopened.page.textContent('[data-testid=save-losses]') ?? '', /Do arquivo original openpyxl-recursos\.xlsx.*gráficos, comentários/);
  await reopened.page.click('[data-testid=save-as-confirm]');
  const xlsx = await saved(reopened.page, 2);
  assert.equal(xlsx.name, 'recursos-nativo.xlsx');
  assert.equal(xlsx.bytes.subarray(0, 2).toString('latin1'), 'PK', 'a real .xlsx (zip) file');
  assert.equal(await saveState(reopened.page), 'Salvo neste dispositivo', 'the workbook itself is complete in the .xlsx');
  // From now on Ctrl+S writes that .xlsx.
  await reopened.page.keyboard.press('ControlOrMeta+s');
  assert.equal((await saved(reopened.page, 3)).name, 'recursos-nativo.xlsx');
  assert.deepEqual([...errors, ...reopened.errors], []);
});

test('a new workbook offers XLSX by default; with a pivot it explains the loss, says it downloads a copy, and stays unsaved', async () => {
  const { page, errors } = await openPage(app.browser, app.url);
  await typeAt(page, 'A1', 'Região');
  await typeAt(page, 'A2', 'Sul');
  await page.click(inPane('[data-testid=new-pivot]'));
  await showSheet(page, 'Planilha1');
  await page.keyboard.press('ControlOrMeta+s');
  await page.waitForSelector('[data-testid=save-as]');
  assert.equal(await page.isChecked('[data-testid=save-format] input[value=xlsx]'), true, 'XLSX is the default');
  assert.match(await page.textContent('[data-testid=save-losses]') ?? '', /1 tabela dinâmica/);
  assert.match(await page.textContent('[data-testid=download-note]') ?? '', /baixada uma cópia/);
  assert.equal(await page.textContent('[data-testid=save-as-confirm]'), 'Baixar cópia');
  const copy = await downloadOf(page, () => page.click('[data-testid=save-as-confirm]'));
  assert.equal(copy.name, 'Pasta1.xlsx');
  await waitStatus(page, 'Cópia baixada Pasta1.xlsx na pasta de downloads, sem 1 tabela dinâmica');
  assert.equal(await saveState(page), 'Alterações não salvas', 'the pivot is not in the .xlsx');
  assert.deepEqual(errors, []);
});

test('CSV: preview with encoding, separator, decimal and types; codes keep their zeros; export back', async () => {
  const { page, errors } = await openPage(app.browser, app.url);
  // Something to protect: the open must not replace this workbook.
  await typeAt(page, 'A1', 'trabalho existente');
  const csv = 'Código;Cliente;Valor;Data;Obs\r\n00123;Ação Ltda;1.234,56;15/03/2024;=1+1\r\n00456;Café;-2,5;2024-12-01;"linha; com separador"\r\n';
  const latin1 = Buffer.from(csv.replace(/\r\n/g, '\r\n'), 'latin1');
  const dir = await mkdtemp(join(tmpdir(), 'farcel-csv-'));
  const path = join(dir, 'clientes.csv');
  await writeFile(path, latin1);
  await page.setInputFiles('[data-testid=open-input]', path);
  await page.waitForSelector('[data-testid=import-dialog]');
  assert.equal(await page.inputValue('[data-testid=import-encoding]'), 'windows-1252');
  assert.equal(await page.inputValue('[data-testid=import-separator]'), ';');
  assert.equal(await page.inputValue('[data-testid=import-decimal]'), ',');
  assert.equal(await page.inputValue('[data-testid=import-type-0]'), 'text', 'codes with leading zeros become text');
  assert.match(await page.textContent('[data-testid=import-note]') ?? '', /A \(Código\)/);
  const preview = await page.locator('.import-preview tbody tr').first().locator('td').allTextContents();
  assert.deepEqual(preview, ['00123', 'Ação Ltda', '1234,56', '15/03/2024', '=1+1']);
  // Wrong decimal choice shows up in the preview before anything is imported.
  await page.selectOption('[data-testid=import-decimal]', '.');
  assert.equal(await page.locator('.import-preview tbody tr').first().locator('td').nth(2).getAttribute('class'), 'text');
  await page.selectOption('[data-testid=import-decimal]', ',');
  await page.click('[data-testid=import-confirm]');
  await waitStatus(page, 'Importado clientes.csv');
  assert.equal(await page.locator('[data-testid=doc-tab]').count(), 2, 'imported into a new tab');
  assert.equal(await saveState(page), 'Importado de CSV');
  assert.equal(await copyText(page, 'A1:E3'), 'Código\tCliente\tValor\tData\tObs\n00123\tAção Ltda\t1234,56\t15/03/2024\t=1+1\n00456\tCafé\t-2,5\t01/12/2024\tlinha; com separador');
  await typeAt(page, 'C4', '=SOMA(C2:C3)');
  assert.equal(await copyText(page, 'C4'), '1232,06');

  // Default: for opening in spreadsheets. "=1+1" is text here and gets an apostrophe; -2,5 stays a number.
  await menu(page, 'CSV');
  assert.equal(await page.isChecked('[data-testid=export-mode] input[value=spreadsheet]'), true);
  const forSpreadsheets = await downloadOf(page, () => page.click('[data-testid=export-anyway]'));
  assert.equal(forSpreadsheets.name, 'clientes.csv');
  assert.equal(forSpreadsheets.bytes.toString('utf8'), '﻿Código;Cliente;Valor;Data;Obs\r\n00123;Ação Ltda;1234,56;15/03/2024;\'=1+1\r\n00456;Café;-2,5;01/12/2024;"linha; com separador"\r\n;;1232,06;;\r\n');
  await waitStatus(page, 'Baixado clientes.csv');
  assert.match(await status(page) ?? '', /1 texto recebeu ' na frente para não virar fórmula/);
  // Original data, for integrations: written as is.
  await menu(page, 'CSV');
  await page.check('[data-testid=export-mode] input[value=raw]');
  const original = await downloadOf(page, () => page.click('[data-testid=export-anyway]'));
  assert.equal(original.bytes.toString('utf8'), '﻿Código;Cliente;Valor;Data;Obs\r\n00123;Ação Ltda;1234,56;15/03/2024;=1+1\r\n00456;Café;-2,5;01/12/2024;"linha; com separador"\r\n;;1232,06;;\r\n');

  // The first tab still holds its work.
  await page.locator('[data-testid=doc-tab] .doc-tab-main').first().click();
  assert.equal(await copyText(page, 'A1'), 'trabalho existente');
  assert.deepEqual(errors, []);
});

test('CSV opened into a new tab and cancelled closes only that tab', async () => {
  const { page, errors } = await openPage(app.browser, app.url);
  await typeAt(page, 'A1', 'manter');
  const path = join(await mkdtemp(join(tmpdir(), 'farcel-tsv-')), 'dados.tsv');
  await writeFile(path, 'a\tb\n1\t2\n');
  await page.setInputFiles('[data-testid=open-input]', path);
  await page.waitForSelector('[data-testid=import-dialog]');
  assert.equal(await page.inputValue('[data-testid=import-separator]'), '\t');
  await page.click('[data-testid=import-dialog] footer button:not(.primary)');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=doc-tab]').length === 1);
  assert.equal(await page.locator('[data-testid=notice]').count(), 0, 'cancelling is not an error');
  assert.equal(await copyText(page, 'A1'), 'manter');
  await idle(page);
  assert.deepEqual(errors, []);
});

test('a file that is not a valid XLSX is refused and the workbook is kept', async () => {
  const { page, errors } = await openPage(app.browser, app.url);
  await typeAt(page, 'A1', 'manter');
  const path = join(await mkdtemp(join(tmpdir(), 'farcel-bad-')), 'falso.xlsx');
  await writeFile(path, 'isto não é um zip');
  await page.setInputFiles('[data-testid=open-input]', path);
  await page.waitForSelector('[data-testid=notice] >> text=falso.xlsx');
  assert.equal(await page.locator('[data-testid=doc-tab]').count(), 1);
  assert.equal(await copyText(page, 'A1'), 'manter');
  assert.deepEqual(errors, []);
});

test('an edit made while an XLSX save is written stays pending', async () => {
  const { page, errors } = await openPage(app.browser, app.url, undefined, () => {
    const w = window as unknown as { farivFiles: unknown; exports: number; release: () => void };
    w.exports = 0;
    w.farivFiles = {
      save(name: string) {
        w.exports++;
        return new Promise<string>(resolve => { w.release = () => resolve(name); });
      },
    };
  });
  await typeAt(page, 'A1', 'antes');
  await page.keyboard.press('ControlOrMeta+s');
  await page.click('[data-testid=save-as-confirm]');
  await page.waitForFunction(() => (window as unknown as { exports: number }).exports === 1);
  await typeAt(page, 'A2', 'durante');
  await page.evaluate(() => (window as unknown as { release: () => void }).release());
  await page.waitForFunction(() => document.querySelector('.doc-pane:not([hidden]) [data-testid=status-message]')?.textContent?.includes('ainda não estão no arquivo'));
  assert.equal(await saveState(page), 'Alterações não salvas');
  assert.deepEqual(errors, []);
});

/**
 * A Chromium desktop with the File System Access API, simulated: the pickers return handles that
 * record what is written. Automation normally hides the native dialogs (navigator.webdriver).
 */
function nativeFileAccess() {
  type Write = { name: string; bytes: number[] };
  const w = window as unknown as {
    writes: Write[]; savePicks: Array<{ suggestedName: string }>; toOpen: { name: string; bytes: number[] } | null;
    showOpenFilePicker: unknown; showSaveFilePicker: unknown;
  };
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  w.writes = [];
  w.savePicks = [];
  w.toOpen = null;
  const handle = (name: string, bytes: number[] = []) => ({
    name,
    getFile: async () => new File([new Uint8Array(bytes)], name),
    queryPermission: async () => 'granted',
    createWritable: async () => {
      const chunks: number[] = [];
      return { write: async (data: Uint8Array) => { chunks.push(...data); }, close: async () => { w.writes.push({ name, bytes: chunks }); } };
    },
  });
  w.showOpenFilePicker = async () => [handle(w.toOpen!.name, w.toOpen!.bytes)];
  w.showSaveFilePicker = async (options: { suggestedName: string }) => { w.savePicks.push(options); return handle(options.suggestedName); };
}

test('with native file access, Ctrl+S writes the opened file in place; Save as asks once for the new file', async () => {
  const { page, errors } = await openPage(app.browser, app.url, undefined, nativeFileAccess);
  const bytes = [...await readFile(fixture('openpyxl-basico.xlsx'))];
  await page.evaluate(b => { (window as unknown as { toOpen: unknown }).toOpen = { name: 'vendas.xlsx', bytes: b }; }, bytes);
  await page.keyboard.press('ControlOrMeta+o');
  await waitStatus(page, 'Importado vendas.xlsx');
  await typeAt(page, 'D2', '30');
  const counts = () => page.evaluate(() => { const w = window as unknown as { writes: unknown[]; savePicks: unknown[] }; return [w.writes.length, w.savePicks.length]; });
  await page.keyboard.press('ControlOrMeta+s');
  await waitStatus(page, 'Salvo vendas.xlsx');
  assert.deepEqual(await counts(), [1, 0], 'written to the opened file, no dialog');
  assert.equal(await saveState(page), 'Salvo neste dispositivo');
  const written = await page.evaluate(() => (window as unknown as { writes: Array<{ name: string; bytes: number[] }> }).writes[0]);
  assert.equal(written.name, 'vendas.xlsx');
  assert.equal(openXlsxBytes(new Uint8Array(written.bytes)).formatted(0, 2, 6), 'R$ 597,00');

  await page.keyboard.press('ControlOrMeta+Shift+s');
  await page.waitForSelector('[data-testid=save-as]');
  assert.equal(await page.textContent('[data-testid=save-as-confirm]'), 'Salvar');
  await page.check('[data-testid=save-format] input[value=farcel]');
  await page.click('[data-testid=save-as-confirm]');
  await waitStatus(page, 'Salvo vendas.farcel');
  assert.deepEqual(await counts(), [2, 1]);
  assert.equal(await page.evaluate(() => (window as unknown as { savePicks: Array<{ suggestedName: string }> }).savePicks[0].suggestedName), 'vendas.farcel');
  await typeAt(page, 'A12', 'depois');
  await page.keyboard.press('ControlOrMeta+s');
  await page.waitForFunction(() => (window as unknown as { writes: unknown[] }).writes.length === 3);
  assert.deepEqual(await counts(), [3, 1], 'the .farcel chosen in Save as is written again without asking');
  assert.deepEqual(errors, []);
});
