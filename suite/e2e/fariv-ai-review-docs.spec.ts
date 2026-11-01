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
 * Fariv review of an AI task in Documentos, with a SIMULATED model (local
 * OpenAI-compatible stub; no Codex/Claude): the inserted paragraph stays in the
 * editor until Accept; Reject restores the document from before the task; a run
 * that fails after inserting is rolled back; a user edit after the task blocks Reject.
 *
 * Each run: insert_content(<p>VALOR</p> at the start) → reply. FALHA in the
 * instruction makes the stub answer HTTP 500 after the insertion.
 */

const DOCX_FIXTURE = resolve(__dirname, '../fixtures/generated/simple.docx')
const POLL = { timeout: 20_000, intervals: [250, 500, 1000] }

interface DocsWindow {
  __aidocs?: {
    editor?: { commands: { focus(pos: string): void }; getText(): string }
    save(): Promise<unknown>
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function text(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content.map((p) => (p as { text?: string }).text ?? '').join('')
  return ''
}

function startModelStub(): Promise<Server> {
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404).end()
      return
    }
    const body = JSON.parse(await readBody(req)) as {
      messages: Array<{ role: string; content: unknown }>
    }
    let lastUser = -1
    body.messages.forEach((m, i) => {
      if (m.role === 'user') lastUser = i
    })
    const instruction = text(body.messages[lastUser]?.content)
    const tools = body.messages.slice(lastUser + 1).filter((m) => m.role === 'tool').length
    const value = /VALOR:\s*(.+?)\s*$/m.exec(instruction)?.[1] ?? 'IA'
    let message: unknown
    if (tools === 0) {
      message = {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: `call_insert_${Date.now()}`,
            type: 'function',
            function: {
              name: 'insert_content',
              arguments: JSON.stringify({ html: `<p>${value}</p>`, afterBlockIndex: -1 }),
            },
          },
        ],
      }
    } else if (instruction.includes('FALHA')) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'simulated failure after a change' } }))
      return
    } else {
      message = { role: 'assistant', content: `Pronto: inseri "${value}".` }
    }
    const done = (message as { tool_calls?: unknown }).tool_calls ? 'tool_calls' : 'stop'
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message, finish_reason: done }] }))
  })
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)))
}

async function documentXml(path: string): Promise<string> {
  const zip = await JSZip.loadAsync(await readFile(path))
  return (await zip.file('word/document.xml')?.async('string')) ?? ''
}

function editorText(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as DocsWindow).__aidocs!.editor!.getText())
}

async function ask(page: Page, instruction: string): Promise<void> {
  const composer = page.locator('.ai-panel textarea')
  await composer.fill(instruction)
  await composer.press('Enter')
}

test('documento: tarefa da IA em revisão — rejeitar, aceitar, falha e conflito', async () => {
  test.setTimeout(240_000)
  const server = await startModelStub()
  const port = (server.address() as AddressInfo).port
  const dir = await mkdtemp(join(tmpdir(), 'fariv-review-docx-'))
  const doc = join(dir, 'relatorio.docx')
  await copyFile(DOCX_FIXTURE, doc)
  const original = await documentXml(doc)
  const userDataDir = await mkdtemp(join(tmpdir(), 'fariv-review-docx-ud-'))
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
    settings: { autoSaveDefault: true, autoSaveDefaultUpdatedAt: Date.now() },
    videoDir: 'fariv-ai-review-docs',
    openFile: doc,
    lang: 'pt',
  })
  try {
    const docs = await waitForPageWithUrl(launched.app, '://docs/')
    await docs.waitForFunction(() => !!(window as unknown as DocsWindow).__aidocs?.editor, null, {
      timeout: 30_000,
    })
    await docs.waitForTimeout(1_000)
    const before = await editorText(docs)
    const rail = docs.locator('.ai-rail')
    if (await rail.isVisible()) await rail.click()
    const cards = docs.locator('.ai-review-card')

    // 1) pending → the file is untouched → Reject restores the document
    await ask(docs, 'Insira um parágrafo.\nVALOR: Parágrafo rejeitado')
    await expect(cards.last()).toHaveAttribute('data-review', 'pending', { timeout: 30_000 })
    await expect(cards.last()).toContainText('1 alteração em revisão')
    expect(await editorText(docs)).toContain('Parágrafo rejeitado')
    await docs.screenshot({ path: screenshotPath('fariv-review-docs-pending') })
    await docs.waitForTimeout(2_000)
    expect(await documentXml(doc)).toBe(original)
    await cards.last().locator('.ai-review-reject').click()
    await expect(cards.last()).toHaveAttribute('data-review', 'rejected')
    await expect.poll(() => editorText(docs), POLL).toBe(before)
    expect(await documentXml(doc)).toBe(original)

    // 2) Accept → AutoSave writes the document
    await ask(docs, 'Insira um parágrafo.\nVALOR: Parágrafo aceito pela revisão')
    await expect(cards.last()).toHaveAttribute('data-review', 'pending', { timeout: 30_000 })
    await cards.last().locator('.ai-review-accept').click()
    await expect(cards.last()).toHaveAttribute('data-review', 'accepted')
    await expect.poll(() => documentXml(doc), POLL).toContain('Parágrafo aceito pela revisão')

    // 3) failure after an insertion → rolled back
    await ask(docs, 'Insira e FALHA.\nVALOR: Parágrafo parcial')
    await expect(cards.last()).toHaveAttribute('data-review', 'rolled-back', { timeout: 30_000 })
    await expect.poll(() => editorText(docs), POLL).not.toContain('Parágrafo parcial')
    expect(await editorText(docs)).toContain('Parágrafo aceito pela revisão')

    // 4) the user edits after the task → Reject refused
    await ask(docs, 'Insira um parágrafo.\nVALOR: Parágrafo antes do conflito')
    await expect(cards.last()).toHaveAttribute('data-review', 'pending', { timeout: 30_000 })
    await docs.evaluate(() =>
      (window as unknown as DocsWindow).__aidocs!.editor!.commands.focus('end'),
    )
    await docs.keyboard.type(' Edição do usuário.', { delay: 20 })
    await cards.last().locator('.ai-review-reject').click()
    await expect(cards.last()).toHaveAttribute('data-review', 'conflict-edited')
    await expect(cards.last().locator('.ai-review-reject')).toBeDisabled()
    expect(await editorText(docs)).toContain('Parágrafo antes do conflito')
    await docs.screenshot({ path: screenshotPath('fariv-review-docs-conflict') })
    expect(await documentXml(doc)).not.toContain('Parágrafo antes do conflito')
  } finally {
    await closeAndSaveVideo(launched, 'fariv-ai-review-docs')
    server.close()
  }
})
