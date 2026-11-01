import { test, expect, type Page } from '@playwright/test'
import { copyFile, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
 * Fariv review of AI tasks in Documentos, with a SIMULATED model (no Codex/Claude).
 * The task's paragraphs are shown in the open document (a preview, not an isolated
 * draft); the file is written only after an explicit Accept.
 *
 * Instruction directives read by the simulated model:
 *   PARAS: texto 1|texto 2   one insert_content (at the start) per `|` part
 *   ESPERA                   hold the run (after the changes) until the test releases it
 *   FALHA                    then fail with HTTP 500
 */

const DOCX_FIXTURE = resolve(__dirname, '../fixtures/generated/simple.docx')
const POLL = { timeout: 20_000, intervals: [250, 500, 1000] }

interface DocsWindow {
  __aidocs?: { editor?: { commands: { focus(pos: string): void }; getText(): string } }
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

test('documento: revisão da tarefa da IA — decisão explícita, nada parcial, edição manual preservada', async () => {
  test.setTimeout(240_000)
  let gate = { reached: deferred(), release: deferred() }
  const { server, port } = await startScriptedModel((run) => {
    const paragraphs = directive(run.instruction, 'PARAS').split('|').filter(Boolean)
    const steps = paragraphs.map((value) => () => ({
      tool: 'insert_content',
      args: { html: `<p>${value}</p>`, afterBlockIndex: -1 },
    }))
    return scriptedRun(run, steps, gate)
  })
  const dir = await mkdtemp(join(tmpdir(), 'fariv-review-docx-'))
  const doc = join(dir, 'relatorio.docx')
  await copyFile(DOCX_FIXTURE, doc)
  const original = await documentXml(doc)
  const userDataDir = await mkdtemp(join(tmpdir(), 'fariv-review-docx-ud-'))
  await useScriptedModel(userDataDir, port)

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
    const cards = docs.locator('.ai-panel .ai-review-card')
    const lastCard = () => cards.last()

    // 1) pending → the file is untouched → Reject restores the document
    await ask(docs, 'Insira.\nPARAS: Parágrafo rejeitado')
    await expect(lastCard()).toHaveAttribute('data-review', 'pending', { timeout: 30_000 })
    await expect(lastCard()).toContainText('1 alteração da IA no documento aberto')
    expect(await editorText(docs)).toContain('Parágrafo rejeitado')
    await docs.screenshot({ path: screenshotPath('fariv-review-docs-pending') })
    await docs.waitForTimeout(2_000)
    expect(await documentXml(doc)).toBe(original)
    await lastCard().locator('.ai-review-reject').click()
    await expect(lastCard()).toHaveAttribute('data-review', 'rejected')
    await expect.poll(() => editorText(docs), POLL).toBe(before)
    expect(await documentXml(doc)).toBe(original)

    // 2) a task of several operations is accepted in one action
    await ask(docs, 'Insira.\nPARAS: Primeiro aceito|Segundo aceito|Terceiro aceito')
    await expect(lastCard()).toHaveAttribute('data-review', 'pending', { timeout: 30_000 })
    await expect(lastCard()).toContainText('3 alterações da IA')
    await lastCard().locator('.ai-review-accept').click()
    await expect(lastCard()).toHaveAttribute('data-review', 'accepted')
    for (const value of ['Primeiro aceito', 'Segundo aceito', 'Terceiro aceito']) {
      await expect.poll(() => documentXml(doc), POLL).toContain(value)
    }
    const afterAccept = await documentXml(doc)
    const textAfterAccept = await editorText(docs)

    // 3) a task of several operations is undone in one action
    await ask(docs, 'Insira.\nPARAS: Desfeito um|Desfeito dois|Desfeito três')
    await expect(lastCard()).toHaveAttribute('data-review', 'pending', { timeout: 30_000 })
    await expect(lastCard()).toContainText('3 alterações da IA')
    await lastCard().locator('.ai-review-reject').click()
    await expect(lastCard()).toHaveAttribute('data-review', 'rejected')
    await expect.poll(() => editorText(docs), POLL).toBe(textAfterAccept)
    expect(await documentXml(doc)).toBe(afterAccept)

    // 4) the run fails after a change while the user typed: the user's text is kept,
    //    the AI's partial change is not undone and waits for a decision
    gate = { reached: deferred(), release: deferred() }
    await ask(docs, 'Insira e falhe.\nPARAS: Parcial da IA\nESPERA\nFALHA')
    await gate.reached.promise
    await expect.poll(() => editorText(docs), POLL).toContain('Parcial da IA')
    await docs.evaluate(() =>
      (window as unknown as DocsWindow).__aidocs!.editor!.commands.focus('end'),
    )
    await docs.keyboard.type(' Minha edição.', { delay: 20 })
    gate.release.resolve()
    await expect(lastCard()).toHaveAttribute('data-review', 'conflict-edited', { timeout: 30_000 })
    await expect(lastCard()).toContainText('não foram desfeitas automaticamente')
    await expect(lastCard().locator('.ai-review-reject')).toBeDisabled()
    expect(await editorText(docs)).toContain('Minha edição.')
    expect(await editorText(docs)).toContain('Parcial da IA')
    await docs.screenshot({ path: screenshotPath('fariv-review-docs-failure-kept') })
    // the user's own Save waits for the decision too
    await docs.keyboard.press('ControlOrMeta+s')
    await docs.waitForTimeout(2_000)
    expect(await documentXml(doc)).toBe(afterAccept)
    await lastCard().locator('.ai-review-accept').click()
    await expect(lastCard()).toHaveAttribute('data-review', 'accepted')
    await expect.poll(() => documentXml(doc), POLL).toContain('Minha edição.')
    expect(await documentXml(doc)).toContain('Parcial da IA')
    const afterKept = await documentXml(doc)
    const textAfterKept = await editorText(docs)

    // 5) a failed run with nothing else in the way is undone, confirmed
    await ask(docs, 'Insira e falhe.\nPARAS: Falha limpa\nFALHA')
    await expect(lastCard()).toHaveAttribute('data-review', 'rolled-back', { timeout: 30_000 })
    await expect.poll(() => editorText(docs), POLL).toBe(textAfterKept)
    expect(await documentXml(doc)).toBe(afterKept)

    // 6) a new request and a new conversation do not decide a pending task
    await ask(docs, 'Primeira.\nPARAS: Pendente P')
    await expect(lastCard()).toHaveAttribute('data-review', 'pending', { timeout: 30_000 })
    const pendingCount = await cards.count()
    await ask(docs, 'Segunda.\nPARAS: Pendente Q')
    await expect(cards).toHaveCount(pendingCount + 1, { timeout: 30_000 })
    await expect(lastCard()).toHaveAttribute('data-review', 'pending', { timeout: 30_000 })
    await expect(cards.nth(pendingCount - 1)).toHaveAttribute('data-review', 'pending')
    await docs.waitForTimeout(2_000)
    expect(await documentXml(doc)).toBe(afterKept)
    await docs.locator('.ai-panel [data-action="new-chat"]').click()
    const open = docs.locator('.ai-review-open .ai-review-card')
    await expect(open).toHaveCount(2)
    await open.first().locator('.ai-review-accept').click()
    await expect(open).toHaveCount(1)
    await docs.waitForTimeout(2_000)
    expect(await documentXml(doc)).toBe(afterKept)
    await open.first().locator('.ai-review-reject').click()
    await expect(open).toHaveCount(0)
    expect(await editorText(docs)).not.toContain('Pendente Q')
    expect(await editorText(docs)).toContain('Pendente P')
    await expect.poll(() => documentXml(doc), POLL).toContain('Pendente P')
    expect(await documentXml(doc)).not.toContain('Pendente Q')
  } finally {
    await closeAndSaveVideo(launched, 'fariv-ai-review-docs')
    server.close()
  }
})
