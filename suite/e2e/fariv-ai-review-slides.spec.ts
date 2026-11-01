import { test, expect, type Page } from '@playwright/test'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import JSZip from 'jszip'
import { defaultAiSettings, resolveCustomEndpoints } from '@genoffice/ai-provider'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl, screenshotPath } from './helpers'

/**
 * Fariv review of an AI task in Apresentações, with a SIMULATED model (local
 * OpenAI-compatible stub; no Codex/Claude): the AI's text change stays in the open deck
 * until Accept; Reject restores the deck through the main-process snapshot of the
 * task; a run that fails after the change is rolled back; a user edit after the task
 * blocks Reject.
 *
 * Each run: read_slide(0) → apply_ops(setText on the title box) → reply. FALHA in
 * the instruction makes the stub answer HTTP 500 after the change.
 */

const POLL = { timeout: 20_000, intervals: [250, 500, 1000] }

const W = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'

/** One slide with a text box across the middle of the stage, so a double click lands on it. */
async function buildDeck(path: string): Promise<void> {
  const slide =
    `<?xml version="1.0"?><p:sld ${P} ${R} ${W}><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>` +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Titulo"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="914400" y="1828800"/><a:ext cx="7315200" cy="1485900"/></a:xfrm><a:prstGeom prst="rect"/></p:spPr>' +
    '<p:txBody><a:bodyPr wrap="square"/><a:lstStyle/><a:p><a:r><a:rPr lang="pt-BR" sz="4000"/><a:t>Resultados</a:t></a:r></a:p></p:txBody></p:sp>' +
    '</p:spTree></p:cSld></p:sld>'
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
      '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' +
      '</Types>',
  )
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
      '</Relationships>',
  )
  zip.file(
    'ppt/presentation.xml',
    `<?xml version="1.0"?><p:presentation ${P} ${R} ${W}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>` +
      '<p:sldSz cx="9144000" cy="5143500"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>',
  )
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>' +
      '</Relationships>',
  )
  zip.file('ppt/slides/slide1.xml', slide)
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }))
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

function call(name: string, args: unknown) {
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
    const body = JSON.parse(await readBody(req)) as {
      messages: Array<{ role: string; content: unknown }>
    }
    let lastUser = -1
    body.messages.forEach((m, i) => {
      if (m.role === 'user') lastUser = i
    })
    const instruction = text(body.messages[lastUser]?.content)
    const tools = body.messages.slice(lastUser + 1).filter((m) => m.role === 'tool')
    const value = /VALOR:\s*(.+?)\s*$/m.exec(instruction)?.[1] ?? 'IA'
    let message: unknown
    if (tools.length === 0) {
      message = call('read_slide', { slideIndex: 0 })
    } else if (tools.length === 1) {
      const el = /\b(e_[A-Za-z0-9_-]+)/.exec(text(tools[0]!.content))?.[1]
      message = call('apply_ops', {
        ops: [
          { op: 'setText', target: { slide: 0, el }, paragraphs: [{ runs: [{ text: value }] }] },
        ],
      })
    } else if (instruction.includes('FALHA')) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'simulated failure after a change' } }))
      return
    } else {
      message = { role: 'assistant', content: `Pronto: título "${value}".` }
    }
    const done = (message as { tool_calls?: unknown }).tool_calls ? 'tool_calls' : 'stop'
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message, finish_reason: done }] }))
  })
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)))
}

async function slideXml(path: string): Promise<string> {
  const zip = await JSZip.loadAsync(await readFile(path))
  return (await zip.file('ppt/slides/slide1.xml')?.async('string')) ?? ''
}

/** the deck's text as the renderer holds it (the session lives in the main process) */
async function deckText(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const api = (window as unknown as { slidesApi: { getRenderSlides(): Promise<unknown> } })
      .slidesApi
    const out: string[] = []
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk)
      else if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>
        if (Array.isArray(record.runs)) {
          out.push(record.runs.map((run) => (run as { text?: string }).text ?? '').join(''))
        }
        Object.values(record).forEach(walk)
      }
    }
    walk(await api.getRenderSlides())
    return out.join('\n')
  })
}

async function ask(page: Page, instruction: string): Promise<void> {
  const composer = page.locator('.ai-panel textarea')
  await composer.fill(instruction)
  await composer.press('Enter')
}

test('apresentação: tarefa da IA em revisão — rejeitar, aceitar, falha e conflito', async () => {
  test.setTimeout(240_000)
  const server = await startModelStub()
  const port = (server.address() as AddressInfo).port
  const dir = await mkdtemp(join(tmpdir(), 'fariv-review-pptx-'))
  const deck = join(dir, 'apresentacao.pptx')
  await buildDeck(deck)
  const original = await slideXml(deck)
  const userDataDir = await mkdtemp(join(tmpdir(), 'fariv-review-pptx-ud-'))
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
    videoDir: 'fariv-ai-review-slides',
    openFile: deck,
    lang: 'pt',
  })
  try {
    const slides = await waitForPageWithUrl(launched.app, '://slides/')
    await expect(slides.locator('.stage-wrap canvas').first()).toBeVisible({ timeout: 30_000 })
    await slides.waitForTimeout(1_000)
    const rail = slides.locator('.ai-rail')
    if (await rail.isVisible()) await rail.click()
    const cards = slides.locator('.ai-review-card')

    // 1) pending → the file is untouched → Reject restores the deck
    await ask(slides, 'Troque o título.\nVALOR: Título rejeitado')
    await expect(cards.last()).toHaveAttribute('data-review', 'pending', { timeout: 30_000 })
    await expect(cards.last()).toContainText('1 alteração em revisão')
    expect(await deckText(slides)).toContain('Título rejeitado')
    await slides.screenshot({ path: screenshotPath('fariv-review-slides-pending') })
    await slides.waitForTimeout(2_000)
    expect(await slideXml(deck)).toBe(original)
    await cards.last().locator('.ai-review-reject').click()
    await expect(cards.last()).toHaveAttribute('data-review', 'rejected')
    await expect.poll(() => deckText(slides), POLL).not.toContain('Título rejeitado')
    expect(await deckText(slides)).toContain('Resultados')
    expect(await slideXml(deck)).toBe(original)

    // 2) Accept → AutoSave writes the deck
    await ask(slides, 'Troque o título.\nVALOR: Título aceito')
    await expect(cards.last()).toHaveAttribute('data-review', 'pending', { timeout: 30_000 })
    await cards.last().locator('.ai-review-accept').click()
    await expect(cards.last()).toHaveAttribute('data-review', 'accepted')
    await expect.poll(() => slideXml(deck), POLL).toContain('Título aceito')

    // 3) failure after the change → rolled back
    await ask(slides, 'Troque o título e FALHA.\nVALOR: Título parcial')
    await expect(cards.last()).toHaveAttribute('data-review', 'rolled-back', { timeout: 30_000 })
    await expect.poll(() => deckText(slides), POLL).not.toContain('Título parcial')
    expect(await deckText(slides)).toContain('Título aceito')

    // 4) the user edits after the task → Reject refused
    await ask(slides, 'Troque o título.\nVALOR: Título antes do conflito')
    await expect(cards.last()).toHaveAttribute('data-review', 'pending', { timeout: 30_000 })
    await slides.locator('.stage-wrap').first().dblclick()
    await slides.keyboard.press('ControlOrMeta+a')
    await slides.keyboard.type('Edição do usuário', { delay: 20 })
    await slides.keyboard.press('Escape')
    await expect.poll(() => deckText(slides), POLL).toContain('Edição do usuário')
    await cards.last().locator('.ai-review-reject').click()
    await expect(cards.last()).toHaveAttribute('data-review', 'conflict-edited')
    await expect(cards.last().locator('.ai-review-reject')).toBeDisabled()
    await slides.screenshot({ path: screenshotPath('fariv-review-slides-conflict') })
    expect(await slideXml(deck)).not.toContain('Título antes do conflito')
  } finally {
    await closeAndSaveVideo(launched, 'fariv-ai-review-slides')
    server.close()
  }
})
