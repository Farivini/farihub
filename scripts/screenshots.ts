/**
 * Captures the interface states documented in the README and the pull request.
 * Run `npm run build` first. Writes docs/screenshots/*.png. Pass --million to include
 * the screenshot with the 1,000,000-row base (takes about a minute to generate).
 */
import { mkdir } from 'node:fs/promises';
import { startApp, openPage, select, idle, typeAt } from '../tests/e2e/harness.ts';

const out = new URL('../docs/screenshots/', import.meta.url).pathname;
await mkdir(out, { recursive: true });
const app = await startApp();
try {
  const { page } = await openPage(app.browser, app.url, { width: 1440, height: 860 });
  const rows = [
    'Região\tCanal\tCategoria\tQuantidade\tReceita',
    'Sudeste\tE-commerce\tEletrônicos\t3\t4.590,00',
    'Sul\tLoja física\tVestuário\t7\t1.245,90',
    'Nordeste\tAtacado\tAlimentação\t40\t3.180,00',
    'Sudeste\tLoja física\tDecoração\t2\t890,50',
    'Centro-Oeste\tE-commerce\tPapelaria\t12\t264,00',
    'Norte\tAtacado\tHigiene\t25\t1.012,75',
    'Sul\tE-commerce\tBrinquedos\t5\t735,00',
    'Nordeste\tLoja física\tEletrônicos\t1\t2.399,00',
    'Sudeste\tAtacado\tAutomóveis\t4\t6.420,00',
  ];
  await page.evaluate(text => navigator.clipboard.writeText(text), rows.join('\n'));
  await select(page, 'A1');
  await page.keyboard.press('ControlOrMeta+v');
  await idle(page);
  await typeAt(page, 'G1', 'Receita Sudeste');
  await typeAt(page, 'G2', '=SOMASE(A2:A10;"Sudeste";E2:E10)');
  await typeAt(page, 'G4', 'Ticket médio');
  await typeAt(page, 'G5', '=ARRED(MÉDIA(E2:E10);2)');
  await select(page, 'G2');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}farcel-planilha.png` });

  await page.click('text=Tabela dinâmica');
  await page.click('[data-testid=field-Região]');
  await page.click('[data-testid=field-Receita]');
  await page.dragAndDrop('[data-testid=field-Canal]', '[data-testid=zone-columns]');
  await page.waitForFunction(() => document.querySelector('[data-testid=pivot-info]')?.getAttribute('data-status') === 'ready');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}farcel-dinamica.png` });

  await page.click('[aria-label="Recolher assistente"]');
  await page.click('[data-testid=space-fardoc]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}fardoc-em-preparacao.png` });
  await page.click('[data-testid=space-farcel]');

  if (process.argv.includes('--million')) {
    await page.click('.assistant-toggle');
    await page.click('text=Base de teste');
    await page.click('.dialog button.primary');
    await page.waitForSelector('[data-testid=generation-report]', { timeout: 15 * 60_000 });
    await idle(page);
    await select(page, 'A999990');
    await idle(page);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${out}farcel-um-milhao.png` });
  }
} finally {
  await app.close();
}
console.log(`Capturas em ${out}`);
