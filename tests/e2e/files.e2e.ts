import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { copyText, formulaBar, idle, inPane, openPage, select, startApp, typeAt } from './harness.ts';
import { WorkbookEngine } from '../../src/engine/workbook-engine.ts';
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

async function exportFrom(page: Page, label: string, confirm: boolean): Promise<{ name: string; bytes: Buffer }> {
  const download = page.waitForEvent('download');
  await page.click('[data-testid=files-menu]');
  await page.locator('[role=menuitem]', { hasText: label }).click();
  if (confirm) await page.click('[data-testid=export-anyway]');
  const file = await download;
  const path = join(await mkdtemp(join(tmpdir(), 'farcel-export-')), file.suggestedFilename());
  await file.saveAs(path);
  return { name: file.suggestedFilename(), bytes: await readFile(path) };
}

function openXlsxBytes(bytes: Uint8Array): WorkbookEngine {
  return WorkbookEngine.fromModelBytes(ic, xlsxToModel(xlsxBridge, bytes, 'exportado').model).engine;
}

test('XLSX: open, edit, export and reopen; formulas stay formulas in pt-BR', async () => {
  const { page, errors } = await openPage(app.browser, app.url);
  await page.setInputFiles('[data-testid=open-input]', fixture('openpyxl-basico.xlsx'));
  await waitStatus(page, 'Importado openpyxl-basico.xlsx');
  assert.match(await status(page) ?? '', /51 células, 13 fórmulas/);
  assert.equal(await page.locator('[data-testid=import-report]').count(), 0, 'nothing to report for this file');
  assert.equal(await saveState(page), 'Importado de XLSX');
  assert.equal(await page.textContent('[data-testid=doc-tab] .doc-title'), 'openpyxl-basico.xlsx');
  assert.equal(await copyText(page, 'A1:C2'), 'Região\tCódigo\tData\nSudeste\t00123\t15/03/2024');
  assert.equal(await copyText(page, 'F6'), 'R$ 1.319,26');
  await select(page, 'F9');
  await formulaShows(page, '=PROCV("Nordeste";A2:F4;6;FALSO)');
  await showSheet(page, 'Resumo Geral');
  assert.equal(await copyText(page, 'B2:B3'), '4,5%\n3');
  await showSheet(page, 'Vendas');

  // Edit, then export: no losses for this workbook, so no confirmation.
  await typeAt(page, 'D2', '30');
  await typeAt(page, 'A12', '=SOMASE(A2:A4;"Sudeste";F2:F4)');
  assert.equal(await saveState(page), 'Alterações não salvas');
  const exported = await exportFrom(page, 'Excel (.xlsx)', false);
  assert.equal(exported.name, 'openpyxl-basico.xlsx');
  await waitStatus(page, 'Exportado');
  assert.equal(await saveState(page), 'Salvo neste dispositivo', 'everything is in the exported file');

  const back = openXlsxBytes(exported.bytes);
  assert.equal(back.input(0, 12, 1), '=SOMASE(A2:A4;"Sudeste";F2:F4)');
  assert.equal(back.formatted(0, 12, 1), '597');
  assert.equal(back.formatted(0, 6, 6), 'R$ 1.856,56');
  assert.equal(back.formatted(0, 2, 2), '00123');
  assert.deepEqual(back.sheets(), ['Vendas', 'Resumo Geral']);

  // The exported file opens in the app again, in a new tab because this one has a file.
  const path = join(await mkdtemp(join(tmpdir(), 'farcel-reopen-')), 'devolvido.xlsx');
  await writeFile(path, exported.bytes);
  await page.setInputFiles('[data-testid=open-input]', path);
  await waitStatus(page, 'Importado devolvido.xlsx');
  assert.equal(await page.locator('[data-testid=doc-tab]').count(), 2);
  await select(page, 'A12');
  await formulaShows(page, '=SOMASE(A2:A4;"Sudeste";F2:F4)');
  assert.deepEqual(errors, []);
});

test('XLSX: what is not kept is reported on open and listed again before export', async () => {
  const { page, errors } = await openPage(app.browser, app.url);
  await page.setInputFiles('[data-testid=open-input]', fixture('openpyxl-recursos.xlsx'));
  await page.waitForSelector('[data-testid=import-report]');
  const lost = await page.textContent('[data-testid=report-lost]') ?? '';
  for (const item of ['gráficos', 'comentários', 'validação de dados', 'filtros aplicados', 'tabelas formatadas']) assert.ok(lost.includes(item), item);
  const kept = await page.textContent('[data-testid=report-kept]') ?? '';
  for (const item of ['células mescladas', 'painéis congelados', 'bordas']) assert.ok(kept.includes(item), item);
  await page.click('[data-testid=import-report] button.primary');
  assert.equal(await copyText(page, 'C2'), '60');

  // Export lists the same losses and waits for confirmation; cancel writes nothing.
  await page.click('[data-testid=files-menu]');
  await page.locator('[role=menuitem]', { hasText: 'Excel (.xlsx)' }).click();
  const losses = await page.textContent('[data-testid=export-losses]') ?? '';
  assert.match(losses, /openpyxl-recursos\.xlsx.*gráficos/);
  await page.click('[data-testid=export-confirm] button:not(.primary)');
  assert.equal(await page.locator('[data-testid=export-confirm]').count(), 0);
  assert.deepEqual(errors, []);
});

test('XLSX export of a workbook with a pivot asks first and leaves it unsaved', async () => {
  const { page, errors } = await openPage(app.browser, app.url);
  await typeAt(page, 'A1', 'Região');
  await typeAt(page, 'A2', 'Sul');
  await page.click(inPane('[data-testid=new-pivot]'));
  await showSheet(page, 'Planilha1');
  await page.click('[data-testid=files-menu]');
  await page.locator('[role=menuitem]', { hasText: 'Excel (.xlsx)' }).click();
  assert.match(await page.textContent('[data-testid=export-losses]') ?? '', /1 tabela dinâmica/);
  const download = page.waitForEvent('download');
  await page.click('[data-testid=export-anyway]');
  await download;
  await waitStatus(page, 'Exportado');
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

  const exported = await exportFrom(page, 'CSV', true);
  assert.equal(exported.name, 'clientes.csv');
  const text = exported.bytes.toString('utf8');
  assert.equal(text, '﻿Código;Cliente;Valor;Data;Obs\r\n00123;Ação Ltda;1234,56;15/03/2024;=1+1\r\n00456;Café;-2,5;01/12/2024;"linha; com separador"\r\n;;1232,06;;\r\n');

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

test('an edit made while the XLSX export is written stays pending (same rule as save)', async () => {
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
  await page.click('[data-testid=files-menu]');
  await page.locator('[role=menuitem]', { hasText: 'Excel (.xlsx)' }).click();
  await page.waitForFunction(() => (window as unknown as { exports: number }).exports === 1);
  await typeAt(page, 'A2', 'durante');
  await page.evaluate(() => (window as unknown as { release: () => void }).release());
  await page.waitForFunction(() => document.querySelector('.doc-pane:not([hidden]) [data-testid=status-message]')?.textContent?.includes('ainda não estão no arquivo'));
  assert.equal(await saveState(page), 'Alterações não salvas');
  assert.deepEqual(errors, []);
});
