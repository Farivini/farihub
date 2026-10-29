import { preview } from 'vite';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';

/** Serves the production build (run `npm run build` first) and drives it in Chromium. */
export async function startApp(): Promise<{ url: string; browser: Browser; close(): Promise<void> }> {
  const server = await preview({ preview: { port: 0, strictPort: false }, logLevel: 'silent' });
  const address = server.httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 4173;
  const browser = await chromium.launch();
  return {
    url: `http://localhost:${port}/`,
    browser,
    async close() {
      await browser.close();
      await new Promise<void>(resolve => server.httpServer.close(() => resolve()));
    },
  };
}

export async function openPage(browser: Browser, url: string, viewport = { width: 1440, height: 900 }): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('[data-testid=engine-state]')?.textContent?.includes('IronCalc'));
  return { context, page, errors };
}

export async function select(page: Page, ref: string): Promise<void> {
  await page.fill('[aria-label="Caixa de nome"]', ref);
  await page.press('[aria-label="Caixa de nome"]', 'Enter');
  await page.waitForFunction(r => (document.querySelector('[aria-label="Caixa de nome"]') as HTMLInputElement).value === r, ref, { timeout: 5000 }).catch(async error => {
    const state = await page.evaluate(() => ({ value: (document.querySelector('[aria-label="Caixa de nome"]') as HTMLInputElement).value, active: document.activeElement?.getAttribute('aria-label'), log: (window as any).__log }));
    throw new Error(`select(${ref}) failed: ${JSON.stringify(state)}\n${error}`);
  });
}

/** Waits until no engine request is pending and the grid has drawn after the last change. */
export async function idle(page: Page): Promise<void> {
  await page.waitForFunction(() => !document.querySelector('[data-testid=engine-state]')?.classList.contains('busy'));
  await page.waitForFunction(() => [...document.querySelectorAll('.grid-root')].every(g => g.getAttribute('data-settled') === 'true'));
}

export async function typeAt(page: Page, ref: string, text: string): Promise<void> {
  await select(page, ref);
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await idle(page);
}

/** Reads displayed values through the real copy path (Ctrl+C -> system clipboard). */
export async function copyText(page: Page, ref: string): Promise<string> {
  await select(page, ref);
  await page.evaluate(() => navigator.clipboard.writeText('(vazio)'));
  await page.keyboard.press('ControlOrMeta+c');
  await page.waitForFunction(() => navigator.clipboard.readText().then(t => t !== '(vazio)'));
  return page.evaluate(() => navigator.clipboard.readText());
}

export async function formulaBar(page: Page): Promise<string> {
  return page.inputValue('[data-testid=formula-bar]');
}
