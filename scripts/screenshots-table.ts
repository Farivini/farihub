/**
 * Captures the table operations: a filtered table with its marks, the values list of a filter
 * button, the context menu of a cell and the sort dialog. Run `npm run build` first. Writes
 * docs/screenshots/tabela-*.png. The data is a small sample written here.
 */
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { startApp, openPage, select, idle, inPane } from '../tests/e2e/harness.ts';

const out = fileURLToPath(new URL('../docs/screenshots/', import.meta.url));
const viewport = { width: 1586, height: 992 };
const data = [
  'Cliente\tCidade\tUF\tEmissão\tValor\tSituação',
  'Padaria Pão Quente\tSão Paulo\tSP\t15/03/2026\t1234,56\tPaga',
  'Açaí do Norte\tBelém\tPA\t02/04/2026\t89,9\tAberta',
  'Ferragens União\tCuritiba\tPR\t20/05/2026\t12500\tPaga',
  'Café & Cia\tBelo Horizonte\tMG\t31/05/2026\t-45,1\tCancelada',
  'Livraria Saber\tSão Paulo\tSP\t03/06/2026\t780\tAberta',
  'Mercado Bom Preço\tRecife\tPE\t11/06/2026\t3420,75\tPaga',
  'Ótica Visão\tCuritiba\tPR\t18/06/2026\t615\tAberta',
  'Distribuidora Sul\tPorto Alegre\tRS\t25/06/2026\t9870,4\tPaga',
  'Farmácia Vida\tSão Paulo\tSP\t01/07/2026\t455,3\tPaga',
].join('\n');

/** Each table operation ends with its own status message; the grid is drawn after it. */
async function done(page: Page, prefix: string) {
  await page.waitForFunction(([sel, p]) => document.querySelector(sel)?.textContent?.startsWith(p), [inPane('[data-testid=status-message]'), prefix] as const);
  await idle(page);
}

const app = await startApp();
try {
  const { page } = await openPage(app.browser, app.url, viewport);
  await select(page, 'A1');
  await page.evaluate(t => navigator.clipboard.writeText(t), data);
  await page.keyboard.press('ControlOrMeta+v');
  await idle(page);
  await select(page, 'E2:E10');
  await page.click(inPane('[data-testid=number-format]'));
  await page.click('role=menuitemradio[name=/Moeda/]');
  await idle(page);
  await select(page, 'A1:F1');
  await page.click(inPane('[data-testid=bold]'));
  await idle(page);

  const box = (await page.locator(inPane('[data-testid=grid-scroller]')).boundingBox())!;
  const rowHeader = await page.evaluate(sel => (document.querySelector(sel) as HTMLElement).offsetLeft, inPane('[data-testid=cell-editor]'));
  await select(page, 'B4');
  await page.mouse.click(box.x + rowHeader + 124 + 40, box.y + 30 + 3 * 28 + 14, { button: 'right' });
  await page.waitForSelector('[data-testid=context-menu]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}tabela-menu.png` });
  await page.click('[data-testid=menu-filter]');
  await done(page, 'Filtro em');

  // Values list of "Situação", then keep Paga and Aberta.
  await page.mouse.click(box.x + rowHeader + 6 * 124 - 10, box.y + 30 + 14);
  await page.waitForSelector('[data-testid=filter-values]');
  await page.locator('[data-testid=filter-values] label', { hasText: 'Cancelada' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}tabela-filtro.png` });
  await page.click('[data-testid=filter-apply]');
  await done(page, 'Filtrado por F');
  // Then only São Paulo and Curitiba.
  await page.mouse.click(box.x + rowHeader + 2 * 124 - 10, box.y + 30 + 14);
  await page.waitForSelector('[data-testid=filter-values]');
  await page.click('[data-testid=filter-all]');
  await page.locator('[data-testid=filter-values] label', { hasText: 'São Paulo' }).click();
  await page.locator('[data-testid=filter-values] label', { hasText: 'Curitiba' }).click();
  await page.click('[data-testid=filter-apply]');
  await done(page, 'Filtrado por B');
  await select(page, 'E2:E10');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}tabela-filtrada.png` });

  await select(page, 'C3');
  await page.click(inPane('[data-testid=sort-open]'));
  await page.waitForSelector('[data-testid=sort-dialog]');
  await page.click('[data-testid=sort-add-level]');
  await page.locator('[data-testid=sort-levels] select').nth(2).selectOption('5');
  await page.locator('[data-testid=sort-levels] select').nth(3).selectOption('desc');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}tabela-ordenar.png` });
  console.log('docs/screenshots/tabela-*.png');
} finally {
  await app.close();
}
