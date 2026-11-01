import { test, expect, type Page } from '@playwright/test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl, screenshotPath } from './helpers'
import {
  deferred,
  directive,
  scriptedRun,
  startScriptedModel,
  useScriptedModel,
} from './fariv-review-helpers'

/**
 * Fariv review of AI tasks in Apresentações, with a SIMULATED model (no Codex/Claude).
 * The task's changes are shown in the open deck (a preview, not an isolated draft);
 * the file is written only after an explicit Accept. Reject restores the task's
 * main-process history batch, confirmed against the deck's fingerprint.
 *
 * Instruction directives read by the simulated model (after a read_slide):
 *   TITLE: texto   one apply_ops setText on the title box
 *   NOTES: texto   one apply_ops setNotes on slide 1
 *   ESPERA         hold the run (after the changes) until the test releases it
 *   FALHA          then fail with HTTP 500
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

/** every XML part of the saved deck (slide, notes) */
async function savedXml(path: string): Promise<string> {
  const zip = await JSZip.loadAsync(await readFile(path))
  const parts = Object.values(zip.files).filter((f) => !f.dir && f.name.endsWith('.xml'))
  return (await Promise.all(parts.map((f) => f.async('string')))).join('\n')
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

test('apresentação: revisão da tarefa da IA — decisão explícita, nada parcial, edição manual preservada', async () => {
  test.setTimeout(240_000)
  let gate = { reached: deferred(), release: deferred() }
  const { server, port } = await startScriptedModel((run) => {
    const title = directive(run.instruction, 'TITLE')
    const notes = directive(run.instruction, 'NOTES')
    const el = (results: readonly string[]) => /\b(e_[A-Za-z0-9_-]+)/.exec(results[0] ?? '')?.[1]
    const steps = [
      () => ({ tool: 'read_slide', args: { slideIndex: 0 } }),
      ...(title
        ? [
            (results: readonly string[]) => ({
              tool: 'apply_ops',
              args: {
                ops: [
                  {
                    op: 'setText',
                    target: { slide: 0, el: el(results) },
                    paragraphs: [{ runs: [{ text: title }] }],
                  },
                ],
              },
            }),
          ]
        : []),
      ...(notes
        ? [
            () => ({
              tool: 'apply_ops',
              args: { ops: [{ op: 'setNotes', target: { slide: 0 }, text: notes }] },
            }),
          ]
        : []),
    ]
    return scriptedRun(run, steps, gate)
  })
  const dir = await mkdtemp(join(tmpdir(), 'fariv-review-pptx-'))
  const deck = join(dir, 'apresentacao.pptx')
  await buildDeck(deck)
  const original = await savedXml(deck)
  const userDataDir = await mkdtemp(join(tmpdir(), 'fariv-review-pptx-ud-'))
  await useScriptedModel(userDataDir, port)

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
    const cards = slides.locator('.ai-panel .ai-review-card')
    const lastCard = () => cards.last()

    // 1) pending → the file is untouched → Reject restores the deck
    await ask(slides, 'Troque.\nTITLE: Título rejeitado')
    await expect(lastCard()).toHaveAttribute('data-review', 'pending', { timeout: 30_000 })
    await expect(lastCard()).toContainText('1 alteração da IA no documento aberto')
    expect(await deckText(slides)).toContain('Título rejeitado')
    await slides.screenshot({ path: screenshotPath('fariv-review-slides-pending') })
    await slides.waitForTimeout(2_000)
    expect(await savedXml(deck)).toBe(original)
    await lastCard().locator('.ai-review-reject').click()
    await expect(lastCard()).toHaveAttribute('data-review', 'rejected')
    await expect.poll(() => deckText(slides), POLL).not.toContain('Título rejeitado')
    expect(await deckText(slides)).toContain('Resultados')
    expect(await savedXml(deck)).toBe(original)

    // 2) a task of several operations (title and speaker notes) is accepted in one action
    await ask(slides, 'Troque.\nTITLE: Título aceito\nNOTES: Notas aceitas')
    await expect(lastCard()).toHaveAttribute('data-review', 'pending', { timeout: 30_000 })
    await expect(lastCard()).toContainText('2 alterações da IA')
    await lastCard().locator('.ai-review-accept').click()
    await expect(lastCard()).toHaveAttribute('data-review', 'accepted')
    await expect.poll(() => savedXml(deck), POLL).toContain('Título aceito')
    expect(await savedXml(deck)).toContain('Notas aceitas')
    const afterAccept = await savedXml(deck)

    // 3) a task of several operations is undone in one action
    await ask(slides, 'Troque.\nTITLE: Título desfeito\nNOTES: Notas desfeitas')
    await expect(lastCard()).toHaveAttribute('data-review', 'pending', { timeout: 30_000 })
    await expect(lastCard()).toContainText('2 alterações da IA')
    await lastCard().locator('.ai-review-reject').click()
    await expect(lastCard()).toHaveAttribute('data-review', 'rejected')
    await expect.poll(() => deckText(slides), POLL).toContain('Título aceito')
    expect(await deckText(slides)).not.toContain('Título desfeito')
    expect(await savedXml(deck)).toBe(afterAccept)

    // 4) the run fails after a change while the user edited the title by hand: the
    //    user's edit is kept, the AI's notes are not undone and wait for a decision
    gate = { reached: deferred(), release: deferred() }
    await ask(slides, 'Anote e falhe.\nNOTES: Notas parciais da IA\nESPERA\nFALHA')
    await gate.reached.promise
    await slides.locator('.stage-wrap').first().dblclick()
    await slides.keyboard.press('ControlOrMeta+a')
    await slides.keyboard.type('Minha edição', { delay: 20 })
    await slides.keyboard.press('Escape')
    await expect.poll(() => deckText(slides), POLL).toContain('Minha edição')
    gate.release.resolve()
    await expect(lastCard()).toHaveAttribute('data-review', 'conflict-edited', { timeout: 30_000 })
    await expect(lastCard()).toContainText('não foram desfeitas automaticamente')
    await expect(lastCard().locator('.ai-review-reject')).toBeDisabled()
    expect(await deckText(slides)).toContain('Minha edição')
    await slides.screenshot({ path: screenshotPath('fariv-review-slides-failure-kept') })
    await slides.waitForTimeout(2_000)
    expect(await savedXml(deck)).toBe(afterAccept)
    await lastCard().locator('.ai-review-accept').click()
    await expect(lastCard()).toHaveAttribute('data-review', 'accepted')
    await expect.poll(() => savedXml(deck), POLL).toContain('Minha edição')
    expect(await savedXml(deck)).toContain('Notas parciais da IA')
    const afterKept = await savedXml(deck)

    // 5) a failed run with nothing else in the way is undone, confirmed
    await ask(slides, 'Troque e falhe.\nTITLE: Título com falha\nFALHA')
    await expect(lastCard()).toHaveAttribute('data-review', 'rolled-back', { timeout: 30_000 })
    await expect.poll(() => deckText(slides), POLL).toContain('Minha edição')
    expect(await deckText(slides)).not.toContain('Título com falha')
    expect(await savedXml(deck)).toBe(afterKept)

    // 6) a new request and a new conversation do not decide a pending task
    await ask(slides, 'Primeira.\nNOTES: Pendente P')
    await expect(lastCard()).toHaveAttribute('data-review', 'pending', { timeout: 30_000 })
    const pendingCount = await cards.count()
    await ask(slides, 'Segunda.\nTITLE: Pendente Q')
    await expect(cards).toHaveCount(pendingCount + 1, { timeout: 30_000 })
    await expect(lastCard()).toHaveAttribute('data-review', 'pending', { timeout: 30_000 })
    await expect(cards.nth(pendingCount - 1)).toHaveAttribute('data-review', 'pending')
    await slides.waitForTimeout(2_000)
    expect(await savedXml(deck)).toBe(afterKept)
    await slides.locator('.ai-panel [data-action="new-chat"]').click()
    const open = slides.locator('.ai-review-open .ai-review-card')
    await expect(open).toHaveCount(2)
    await slides.screenshot({ path: screenshotPath('fariv-review-slides-open-after-new-chat') })
    await open.first().locator('.ai-review-accept').click()
    await expect(open).toHaveCount(1)
    await slides.waitForTimeout(2_000)
    expect(await savedXml(deck)).toBe(afterKept)
    await open.first().locator('.ai-review-reject').click()
    await expect(open).toHaveCount(0)
    await expect.poll(() => deckText(slides), POLL).not.toContain('Pendente Q')
    await expect.poll(() => savedXml(deck), POLL).toContain('Pendente P')
    expect(await savedXml(deck)).not.toContain('Pendente Q')
  } finally {
    await closeAndSaveVideo(launched, 'fariv-ai-review-slides')
    server.close()
  }
})
