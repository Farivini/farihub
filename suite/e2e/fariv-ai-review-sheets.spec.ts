import { test, expect, type Page } from '@playwright/test'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import JSZip from 'jszip'
import { defaultAiSettings, resolveCustomEndpoints } from '@genoffice/ai-provider'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl, screenshotPath } from './helpers'

/**
 * Fariv review of an AI task in Planilhas, with a SIMULATED model (a local
 * OpenAI-compatible stub that scripts the agent's tool calls; no Codex/Claude here):
 *
 * - the task's changes land in the open workbook only; the file stays as it was
 *   (AutoSave on) until the user accepts;
 * - Reject undoes the whole task; Accept saves it;
 * - a run that fails after changing the workbook is rolled back;
 * - an edit by the user after the task blocks Reject (conflict).
 *
 * Each run: get_workbook_context → propose_operations(set_cell A3) → reply. An
 * instruction containing FALHA makes the stub fail (HTTP 500) after the change.
 */

const XLSX_FIXTURE = resolve(
  __dirname,
  '../apps/sheets/fixtures/generated/compatibility-basic.xlsx',
)
const POLL = { timeout: 20_000, intervals: [250, 500, 1000] }

interface ChatRequest {
  messages: Array<{ role: string; content: unknown }>
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function text(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => (part as { text?: string }).text ?? '').join('')
  }
  return ''
}

function toolCall(name: string, args: unknown) {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: `call_${name}_${Date.now()}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  }
}

function startModelStub(): Promise<Server> {
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404).end()
      return
    }
    const body = JSON.parse(await readBody(req)) as ChatRequest
    let lastUser = -1
    body.messages.forEach((message, index) => {
      if (message.role === 'user') lastUser = index
    })
    const instruction = text(body.messages[lastUser]?.content)
    const tools = body.messages.slice(lastUser + 1).filter((message) => message.role === 'tool')
    const value = /VALOR:\s*(.+?)\s*$/m.exec(instruction)?.[1] ?? 'IA'
    let message: unknown
    if (tools.length === 0) {
      message = toolCall('get_workbook_context', {})
    } else if (tools.length === 1) {
      const sheetId = /id=([^,)\s]+)/.exec(text(tools[0]!.content))?.[1] ?? 'sheet-1'
      message = toolCall('propose_operations', {
        summary: `Escrever ${value} em A3`,
        operations: [{ op: 'set_cell', sheetId, address: 'A3', value }],
      })
    } else if (instruction.includes('FALHA')) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'simulated failure after a change' } }))
      return
    } else {
      message = { role: 'assistant', content: `Pronto: ${value} em A3.` }
    }
    const done = (message as { tool_calls?: unknown }).tool_calls ? 'tool_calls' : 'stop'
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message, finish_reason: done }] }))
  })
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)))
}

async function part(path: string, name: string): Promise<string> {
  const zip = await JSZip.loadAsync(await readFile(path))
  return (await zip.file(name)?.async('string')) ?? ''
}

async function savedText(path: string): Promise<string> {
  return (await part(path, 'xl/sharedStrings.xml')) + (await part(path, 'xl/worksheets/sheet1.xml'))
}

async function gridA1(page: Page): Promise<{ x: number; y: number }> {
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('canvas')].some((canvas) => {
        const rect = canvas.getBoundingClientRect()
        return rect.width > 400 && rect.height > 300
      }),
    null,
    { timeout: 30_000 },
  )
  await page.waitForTimeout(500)
  const grid = await page.evaluate(() => {
    for (const canvas of document.querySelectorAll('canvas')) {
      const rect = canvas.getBoundingClientRect()
      if (rect.width > 400 && rect.height > 300) return { x: rect.x, y: rect.y }
    }
    return null
  })
  if (!grid) throw new Error('worksheet canvas not found')
  return { x: grid.x + 46 + 43, y: grid.y + 24 + 12 }
}

/** the value of A3, read through the app's control hook (the grid is a canvas) */
async function valueOfA3(page: Page): Promise<unknown> {
  const a1 = await gridA1(page)
  await page.mouse.click(a1.x, a1.y)
  await expect(page.locator('[data-u-comp="defined-name"] input')).toHaveValue('A1')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('[data-u-comp="defined-name"] input')).toHaveValue('A3')
  const selected = await page.evaluate(() => {
    const control = (
      window as unknown as {
        __genofficeControl(r: { cmd: 'selection' }): Promise<{ result?: { values?: unknown[][] } }>
      }
    ).__genofficeControl
    return control({ cmd: 'selection' })
  })
  const values = selected.result?.values
  return values?.[0]?.[0] ?? ''
}

async function ask(page: Page, instruction: string): Promise<void> {
  const composer = page.locator('.copilot textarea')
  await composer.fill(instruction)
  await composer.press('Enter')
}

test('planilha: tarefa da IA em revisão — rejeitar, aceitar, falha e conflito', async () => {
  test.setTimeout(240_000)
  const server = await startModelStub()
  const port = (server.address() as AddressInfo).port
  const dir = await mkdtemp(join(tmpdir(), 'fariv-review-'))
  const workbook = join(dir, 'vendas.xlsx')
  await copyFile(XLSX_FIXTURE, workbook)
  const original = await savedText(workbook)
  const userDataDir = await mkdtemp(join(tmpdir(), 'fariv-review-ud-'))
  const settings = defaultAiSettings()
  settings.provider = 'custom'
  settings.providers.custom = {
    apiKey: 'stub',
    model: 'stub-model',
    baseUrl: `http://127.0.0.1:${port}/v1`,
  }
  await writeFile(
    join(userDataDir, 'ai-settings.json'),
    JSON.stringify(resolveCustomEndpoints(settings)),
  )

  const launched = await launchShell({
    userDataDir,
    onboardingSeen: true,
    // AutoSave on: the origin would write the run to the file right away
    settings: { autoSaveDefault: true, autoSaveDefaultUpdatedAt: Date.now() },
    videoDir: 'fariv-ai-review-sheets',
    openFile: workbook,
    lang: 'pt',
  })
  try {
    const sheets = await waitForPageWithUrl(launched.app, '://sheets/')
    await sheets.waitForFunction(() => document.body.textContent?.includes('Sheet1'), null, {
      timeout: 30_000,
    })
    const before = await valueOfA3(sheets)
    const expand = sheets.locator('.copilot.collapsed .expand-copilot')
    if (await expand.isVisible()) await expand.click()
    const cards = sheets.locator('.ai-review-card')

    // 1) the task waits for review; the file is untouched; Reject undoes it
    await ask(sheets, 'Escreva em A3.\nVALOR: Rascunho rejeitado')
    await expect(cards.last()).toHaveAttribute('data-review', 'pending', { timeout: 30_000 })
    await expect(cards.last()).toContainText('1 alteração em revisão')
    await expect(cards.last().locator('.ai-review-accept')).toHaveText('Aceitar')
    await sheets.screenshot({ path: screenshotPath('fariv-review-sheets-pending') })
    expect(await valueOfA3(sheets)).toBe('Rascunho rejeitado')
    // AutoSave would have written by now in the origin (it saves when the run ends)
    await sheets.waitForTimeout(2_000)
    expect(await savedText(workbook)).toBe(original)
    await cards.last().locator('.ai-review-reject').click()
    await expect(cards.last()).toHaveAttribute('data-review', 'rejected')
    await expect.poll(() => valueOfA3(sheets), POLL).toEqual(before)
    expect(await savedText(workbook)).toBe(original)

    // 2) Accept keeps the task and AutoSave writes it
    await ask(sheets, 'Escreva em A3.\nVALOR: Revisado pela IA')
    await expect(cards.last()).toHaveAttribute('data-review', 'pending', { timeout: 30_000 })
    await cards.last().locator('.ai-review-accept').click()
    await expect(cards.last()).toHaveAttribute('data-review', 'accepted')
    await expect.poll(() => savedText(workbook), POLL).toContain('Revisado pela IA')
    await sheets.screenshot({ path: screenshotPath('fariv-review-sheets-accepted') })

    // 3) a run that fails after changing the workbook leaves nothing behind
    await ask(sheets, 'Escreva em A3 e FALHA.\nVALOR: Parcial com falha')
    await expect(cards.last()).toHaveAttribute('data-review', 'rolled-back', { timeout: 30_000 })
    await expect(cards.last()).toContainText('alterações parciais foram desfeitas')
    await expect.poll(() => valueOfA3(sheets), POLL).toBe('Revisado pela IA')
    expect(await savedText(workbook)).not.toContain('Parcial com falha')

    // 4) an edit by the user after the task: Reject would undo it too, so it is refused
    await ask(sheets, 'Escreva em A3.\nVALOR: Antes do conflito')
    await expect(cards.last()).toHaveAttribute('data-review', 'pending', { timeout: 30_000 })
    const a1 = await gridA1(sheets)
    await sheets.mouse.click(a1.x, a1.y)
    await sheets.keyboard.type('Edição do usuário', { delay: 20 })
    await sheets.keyboard.press('Enter')
    await cards.last().locator('.ai-review-reject').click()
    await expect(cards.last()).toHaveAttribute('data-review', 'conflict-edited')
    await expect(cards.last().locator('.ai-review-reject')).toBeDisabled()
    await sheets.screenshot({ path: screenshotPath('fariv-review-sheets-conflict') })
    expect(await valueOfA3(sheets)).toBe('Antes do conflito')
    // the file still has only the accepted task
    expect(await savedText(workbook)).not.toContain('Antes do conflito')
  } finally {
    await closeAndSaveVideo(launched, 'fariv-ai-review-sheets')
    server.close()
  }
})
