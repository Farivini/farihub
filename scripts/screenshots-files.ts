/**
 * Captures the file flows (CSV preview, XLSX import report, save with losses, Save as, CSV
 * export, an imported XLSX). Run `npm run build` first. Writes docs/screenshots/arquivos-*.png. The CSV is sample
 * data written here; the XLSX files are the test fixtures.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp, openPage, select, idle } from '../tests/e2e/harness.ts';

const out = fileURLToPath(new URL('../docs/screenshots/', import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`../tests/fixtures/xlsx/${name}`, import.meta.url));
const viewport = { width: 1586, height: 992 };
const app = await startApp();
try {
  const { page } = await openPage(app.browser, app.url, viewport);
  const dir = await mkdtemp(join(tmpdir(), 'farcel-shots-'));
  const csv = [
    'Código;Cliente;Cidade;Emissão;Valor;CNPJ',
    '000123;Padaria Pão Quente;São Paulo;15/03/2024;1.234,56;12345678000190',
    '000456;Açaí do Norte;Belém;02/04/2024;89,90;98765432000110',
    '001789;Ferragens União;Curitiba;2024-05-20;12.500,00;11222333000144',
    '002010;Café & Cia;Belo Horizonte;31/05/2024;-45,10;55666777000188',
  ].join('\r\n');
  const csvPath = join(dir, 'notas-maio.csv');
  await writeFile(csvPath, Buffer.from(csv, 'latin1'));
  await page.setInputFiles('[data-testid=open-input]', csvPath);
  await page.waitForSelector('[data-testid=import-dialog]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}arquivos-csv-previa.png` });
  await page.click('[data-testid=import-confirm]');
  await page.waitForFunction(() => document.querySelector('.doc-pane:not([hidden]) [data-testid=status-message]')?.textContent?.startsWith('Importado'));

  await page.setInputFiles('[data-testid=open-input]', fixture('openpyxl-recursos.xlsx'));
  await page.waitForSelector('[data-testid=import-report]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}arquivos-xlsx-relatorio.png` });
  await page.click('[data-testid=import-report] button.primary');

  // Ctrl+S on an .xlsx that would lose something: the losses and the choice.
  await page.keyboard.press('ControlOrMeta+s');
  await page.waitForSelector('[data-testid=save-confirm]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}arquivos-salvar-perdas.png` });
  // Save as: XLSX by default, .farcel as the alternative; a downloaded copy in this browser.
  await page.click('[data-testid=save-as-farcel]');
  await page.check('[data-testid=save-format] input[value=xlsx]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}arquivos-salvar-como.png` });
  await page.click('[data-testid=save-as] footer button:first-child');
  // CSV export: for spreadsheets (protected) or original data.
  await page.click('[data-testid=files-menu]');
  await page.locator('[role=menuitem]', { hasText: 'CSV' }).click();
  await page.waitForSelector('[data-testid=export-confirm]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}arquivos-exportar-csv.png` });
  await page.click('[data-testid=export-confirm] footer button:first-child');

  await page.setInputFiles('[data-testid=open-input]', fixture('openpyxl-basico.xlsx'));
  await page.waitForFunction(() => document.querySelector('.doc-pane:not([hidden]) [data-testid=status-message]')?.textContent?.startsWith('Importado openpyxl-basico'));
  await select(page, 'F9');
  await idle(page);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}arquivos-xlsx-importado.png` });
} finally {
  await app.close();
}
