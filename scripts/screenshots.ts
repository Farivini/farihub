/**
 * Captures the interface states documented in the README and the pull request.
 * Run `npm run build` first. Writes docs/screenshots/*.png. Pass --million to include
 * the screenshot with the 1,000,000-row base (takes about half a minute to generate).
 * The example workbook below is typed through the real UI; its numbers are sample data.
 */
import { mkdir } from 'node:fs/promises';
import type { Page } from 'playwright';
import { startApp, openPage, select, idle, typeAt } from '../tests/e2e/harness.ts';

const out = new URL('../docs/screenshots/', import.meta.url).pathname;
const viewport = { width: 1586, height: 992 }; // same proportions as the approved references
await mkdir(out, { recursive: true });

async function format(page: Page, ref: string, action: () => Promise<void>) {
  await select(page, ref);
  await action();
  await idle(page);
}

const app = await startApp();
try {
  const { page } = await openPage(app.browser, app.url, viewport);
  const rows = [
    'Região\tProduto\tReceita\tCusto\tMargem',
    'Sudeste\tNotebook\t231400\t171900\t=(C2-D2)/C2',
    'Sul\tMonitor\t118250\t76300\t=(C3-D3)/C3',
    'Nordeste\tTeclado\t96480\t63950\t=(C4-D4)/C4',
    'Centro-Oeste\tMouse\t82900\t52600\t=(C5-D5)/C5',
    'Norte\tWebcam\t51730\t37050\t=(C6-D6)/C6',
    'Outros\tAcessórios\t58120\t40480\t=(C7-D7)/C7',
  ];
  await page.evaluate(text => navigator.clipboard.writeText(text), rows.join('\n'));
  await select(page, 'A1');
  await page.keyboard.press('ControlOrMeta+v');
  await idle(page);
  await format(page, 'A1:E1', () => page.click('[data-testid=bold]'));
  await format(page, 'C2:D7', async () => { await page.click('[data-testid=number-format]'); await page.click('role=menuitemradio[name=/Moeda/]'); });
  await format(page, 'E2:E7', async () => { await page.click('[data-testid=number-format]'); await page.click('role=menuitemradio[name=/Porcentagem/]'); });
  // Summary block beside the data (column F stays empty, so the pivot source ends at E).
  await typeAt(page, 'G1', 'Resumo');
  await typeAt(page, 'G2', 'Receita total');
  await typeAt(page, 'H2', '=SOMA(C2:C7)');
  await typeAt(page, 'G3', 'Custo total');
  await typeAt(page, 'H3', '=SOMA(D2:D7)');
  await typeAt(page, 'G4', 'Margem total');
  await typeAt(page, 'H4', '=(H2-H3)/H2');
  await format(page, 'G1', () => page.click('[data-testid=bold]'));
  await format(page, 'H2:H3', async () => { await page.click('[data-testid=number-format]'); await page.click('role=menuitemradio[name=/Moeda/]'); });
  await format(page, 'H4', async () => { await page.click('[data-testid=number-format]'); await page.click('role=menuitemradio[name=/Porcentagem/]'); });
  await select(page, 'E2:E7');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}planilhas.png` });

  await page.click('[data-testid=new-pivot]');
  await page.click('[data-testid=field-Região]');
  await page.click('[data-testid=field-Receita]');
  await page.dragAndDrop('[data-testid=field-Produto]', '[data-testid=zone-filters]');
  await page.waitForFunction(() => document.querySelector('[data-testid=pivot-info]')?.getAttribute('data-status') === 'ready');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}planilhas-dinamica.png` });

  await page.click('[data-testid=space-fardoc]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}documentos-em-preparacao.png` });
  await page.click('[data-testid=space-farcel]');

  // Notebook width with the assistant collapsed.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click('[data-testid=assistant-toggle]');
  await page.locator('.sheet-tab', { hasText: 'Planilha1' }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}planilhas-notebook.png` });

  if (process.argv.includes('--million')) {
    await page.setViewportSize(viewport);
    await page.click('[data-testid=assistant-toggle]');
    await page.click('[data-testid=files-menu]');
    await page.click('role=menuitem[name=/Base de teste/]');
    await page.click('[data-testid=generator] button.primary');
    await page.waitForSelector('[data-testid=generation-report]', { timeout: 15 * 60_000 });
    await idle(page);
    await select(page, 'A999990');
    await idle(page);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${out}planilhas-um-milhao.png` });
  }
} finally {
  await app.close();
}
console.log(`Capturas em ${out}`);
