/**
 * Captures the file flows (CSV preview, XLSX import report, export confirmation, an imported
 * XLSX). Run `npm run build` first. Writes docs/screenshots/arquivos-*.png. The CSV is sample
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

  await page.click('[data-testid=files-menu]');
  await page.locator('[role=menuitem]', { hasText: 'Excel (.xlsx)' }).click();
  await page.waitForSelector('[data-testid=export-confirm]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}arquivos-exportar-confirmacao.png` });
  await page.click('[data-testid=export-confirm] button:not(.primary)');

  await page.setInputFiles('[data-testid=open-input]', fixture('openpyxl-basico.xlsx'));
  await page.waitForFunction(() => document.querySelector('.doc-pane:not([hidden]) [data-testid=status-message]')?.textContent?.startsWith('Importado openpyxl-basico'));
  await select(page, 'F9');
  await idle(page);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}arquivos-xlsx-importado.png` });
} finally {
  await app.close();
}
