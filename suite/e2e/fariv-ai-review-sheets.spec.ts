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
  type ModelReply,
} from './fariv-review-helpers'

/**
 * Fariv review of AI tasks in Planilhas, with a SIMULATED model (no Codex/Claude).
 * The task's changes are shown in the open workbook (a preview, not an isolated
 * draft); the file is written only after an explicit Accept.
 *
 * Instruction directives read by the simulated model:
 *   OPS: A3=x;B3=y|A4=z   one propose_operations per `|` group, one set_cell per `;`
 *   FILL                  grow the sheet, then one fill_range of 104,000 cells (past the
 *                         100,000-cell undo budget, so it leaves no undo step)
 *   ESPERA                hold the run (after the changes) until the test releases it
 *   FALHA                 then fail with HTTP 500
 */

const XLSX_FIXTURE = resolve(
  __dirname,
  '../apps/sheets/fixtures/generated/compatibility-basic.xlsx',
)
const POLL = { timeout: 20_000, intervals: [250, 500, 1000] }

async function part(path: string, name: string): Promise<string> {
  const zip = await JSZip.loadAsync(await readFile(path))
  return (await zip.file(name)?.async('string')) ?? ''
}

async function savedText(path: string): Promise<string> {
  return (await part(path, 'xl/sharedStrings.xml')) + (await part(path, 'xl/worksheets/sheet1.xml'))
}

async function goTo(page: Page, address: string): Promise<void> {
  const nameBox = page.locator('[data-u-comp="defined-name"] input')
  await nameBox.click()
  await nameBox.fill(address)
  await nameBox.press('Enter')
  await expect(nameBox).toHaveValue(address)
}

/** a cell's value, read through the app's control hook (the grid is a canvas) */
async function cell(page: Page, address: string): Promise<unknown> {
  await goTo(page, address)
  const selected = await page.evaluate(() => {
    const control = (
      window as unknown as {
        __genofficeControl(r: { cmd: 'selection' }): Promise<{ result?: { values?: unknown[][] } }>
      }
    ).__genofficeControl
    return control({ cmd: 'selection' })
  })
  return selected.result?.values?.[0]?.[0] ?? ''
}

async function typeInto(page: Page, address: string, value: string): Promise<void> {
  await goTo(page, address)
  await page.keyboard.type(value, { delay: 20 })
  await page.keyboard.press('Enter')
}

async function ask(page: Page, instruction: string): Promise<void> {
  const composer = page.locator('.copilot textarea')
  await composer.fill(instruction)
  await composer.press('Enter')
}

test('planilha: revisão da tarefa da IA — decisão explícita, nada parcial, edição manual preservada', async () => {
  test.setTimeout(300_000)
  let gate = { reached: deferred(), release: deferred() }
  const { server, port } = await startScriptedModel((run): ModelReply | Promise<ModelReply> => {
    const sheetId = (results: readonly string[]) =>
      /id=([^,)\s]+)/.exec(results[0] ?? '')?.[1] ?? 'sheet-1'
    const groups = directive(run.instruction, 'OPS')
      .split('|')
      .filter(Boolean)
      .map((group) => group.split(';').map((pair) => pair.split('=') as [string, string]))
    const steps = [
      () => ({ tool: 'get_workbook_context', args: {} }),
      ...groups.map((ops) => (results: readonly string[]) => ({
        tool: 'propose_operations',
        args: {
          summary: 'Editar células',
          operations: ops.map(([address, value]) => ({
            op: 'set_cell',
            sheetId: sheetId(results),
            address,
            value,
          })),
        },
      })),
      ...(run.instruction.includes('FILL')
        ? [
            // the grid has 1,000 rows: grow it (structural ops go in their own batch),
            // then fill 4,000 × 26 = 104,000 cells — past the 100,000-cell undo budget
            (results: readonly string[]) => ({
              tool: 'propose_operations',
              args: {
                summary: 'Acrescentar linhas',
                operations: Array.from({ length: 8 }, () => ({
                  op: 'insert_rows',
                  sheetId: sheetId(results),
                  row: 1000,
                  count: 500,
                })),
              },
            }),
            (results: readonly string[]) => ({
              tool: 'propose_operations',
              args: {
                summary: 'Preencher o bloco novo',
                operations: [
                  {
                    op: 'fill_range',
                    sheetId: sheetId(results),
                    source: 'A1',
                    target: 'A1001:Z5000',
                  },
                ],
              },
            }),
          ]
        : []),
    ]
    return scriptedRun(run, steps, gate)
  })
  const dir = await mkdtemp(join(tmpdir(), 'fariv-review-'))
  const workbook = join(dir, 'vendas.xlsx')
  await copyFile(XLSX_FIXTURE, workbook)
  const userDataDir = await mkdtemp(join(tmpdir(), 'fariv-review-ud-'))
  await useScriptedModel(userDataDir, port)

  const launched = await launchShell({
    userDataDir,
    onboardingSeen: true,
    // AutoSave on: the origin would write each run to the file right away
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
    await sheets.waitForTimeout(1_000)
    const expand = sheets.locator('.copilot.collapsed .expand-copilot')
    if (await expand.isVisible()) await expand.click()
    const cards = sheets.locator('.copilot .ai-review-card')
    const lastCard = () => cards.last()
    const original = await savedText(workbook)

    // 1) a task waits for review; the file is untouched; Reject undoes it
    await ask(sheets, 'Escreva.\nOPS: A3=Rascunho rejeitado')
    await expect(lastCard()).toHaveAttribute('data-review', 'pending', { timeout: 30_000 })
    await expect(lastCard()).toContainText('1 alteração da IA no documento aberto')
    await sheets.screenshot({ path: screenshotPath('fariv-review-sheets-pending') })
    expect(await cell(sheets, 'A3')).toBe('Rascunho rejeitado')
    await sheets.waitForTimeout(2_000)
    expect(await savedText(workbook)).toBe(original)
    await lastCard().locator('.ai-review-reject').click()
    await expect(lastCard()).toHaveAttribute('data-review', 'rejected')
    await expect.poll(() => cell(sheets, 'A3'), POLL).toBe('')
    expect(await savedText(workbook)).toBe(original)

    // 2) a task of several operations (two batches, five cells) is accepted in one action
    await ask(sheets, 'Escreva.\nOPS: A3=Um;B3=Dois;C3=Três|A4=Quatro;B4=Cinco')
    await expect(lastCard()).toHaveAttribute('data-review', 'pending', { timeout: 30_000 })
    await expect(lastCard()).toContainText('5 alterações da IA')
    await lastCard().locator('.ai-review-accept').click()
    await expect(lastCard()).toHaveAttribute('data-review', 'accepted')
    for (const value of ['Um', 'Dois', 'Três', 'Quatro', 'Cinco']) {
      await expect.poll(() => savedText(workbook), POLL).toContain(value)
    }
    const afterAccept = await savedText(workbook)

    // 3) a task of several operations is undone in one action
    await ask(sheets, 'Reescreva.\nOPS: A3=X1;B3=X2;C3=X3|A4=X4;B4=X5')
    await expect(lastCard()).toHaveAttribute('data-review', 'pending', { timeout: 30_000 })
    await expect(lastCard()).toContainText('5 alterações da IA')
    expect(await cell(sheets, 'C3')).toBe('X3')
    await lastCard().locator('.ai-review-reject').click()
    await expect(lastCard()).toHaveAttribute('data-review', 'rejected')
    for (const [address, value] of [
      ['A3', 'Um'],
      ['B3', 'Dois'],
      ['C3', 'Três'],
      ['A4', 'Quatro'],
      ['B4', 'Cinco'],
    ] as const) {
      expect(await cell(sheets, address)).toBe(value)
    }
    expect(await savedText(workbook)).toBe(afterAccept)

    // 4) the run fails after a change while the user edited by hand: the user's edit is
    //    kept, the AI's partial change is not undone (that would take the edit too) and
    //    waits for a decision; nothing reaches the file, not even the user's own Save
    gate = { reached: deferred(), release: deferred() }
    await ask(sheets, 'Escreva e falhe.\nOPS: A5=Parcial da IA\nESPERA\nFALHA')
    await gate.reached.promise
    await expect.poll(() => cell(sheets, 'A5'), POLL).toBe('Parcial da IA')
    await typeInto(sheets, 'D5', 'Minha edição')
    gate.release.resolve()
    await expect(lastCard()).toHaveAttribute('data-review', 'conflict-edited', { timeout: 30_000 })
    await expect(lastCard()).toContainText('não foram desfeitas automaticamente')
    await expect(lastCard().locator('.ai-review-reject')).toBeDisabled()
    expect(await cell(sheets, 'D5')).toBe('Minha edição')
    expect(await cell(sheets, 'A5')).toBe('Parcial da IA')
    await sheets.screenshot({ path: screenshotPath('fariv-review-sheets-failure-kept') })
    await launched.app.evaluate(({ webContents }) => {
      webContents
        .getAllWebContents()
        .find((w) => w.getURL().includes('://sheets/'))
        ?.send('menu:action', 'save')
    })
    await sheets.waitForTimeout(2_000)
    expect(await savedText(workbook)).toBe(afterAccept)
    await lastCard().locator('.ai-review-accept').click()
    await expect(lastCard()).toHaveAttribute('data-review', 'accepted')
    await expect.poll(() => savedText(workbook), POLL).toContain('Minha edição')
    expect(await savedText(workbook)).toContain('Parcial da IA')
    const afterKept = await savedText(workbook)

    // 5) a failed run with nothing else in the way is undone, and says so once confirmed
    await ask(sheets, 'Escreva e falhe.\nOPS: A6=Falha limpa\nFALHA')
    await expect(lastCard()).toHaveAttribute('data-review', 'rolled-back', { timeout: 30_000 })
    expect(await cell(sheets, 'A6')).toBe('')
    expect(await savedText(workbook)).toBe(afterKept)

    // 6) a new request and a new conversation do not decide a pending task
    await ask(sheets, 'Primeira.\nOPS: A7=Pendente P')
    await expect(lastCard()).toHaveAttribute('data-review', 'pending', { timeout: 30_000 })
    await ask(sheets, 'Segunda.\nOPS: B7=Pendente Q')
    await expect(cards).toHaveCount(7, { timeout: 30_000 })
    await expect(lastCard()).toHaveAttribute('data-review', 'pending', { timeout: 30_000 })
    await expect(cards.nth(5)).toHaveAttribute('data-review', 'pending')
    await sheets.waitForTimeout(2_000)
    expect(await savedText(workbook)).toBe(afterKept)
    await sheets.locator('.copilot [data-action="new-chat"]').click()
    const open = sheets.locator('.ai-review-open .ai-review-card')
    await expect(open).toHaveCount(2)
    await sheets.screenshot({ path: screenshotPath('fariv-review-sheets-open-after-new-chat') })
    await open.first().locator('.ai-review-accept').click()
    await expect(open).toHaveCount(1)
    // Q is still open: the accepted P waits with it
    await sheets.waitForTimeout(2_000)
    expect(await savedText(workbook)).toBe(afterKept)
    await open.first().locator('.ai-review-reject').click()
    await expect(open).toHaveCount(0)
    expect(await cell(sheets, 'B7')).toBe('')
    expect(await cell(sheets, 'A7')).toBe('Pendente P')
    await expect.poll(() => savedText(workbook), POLL).toContain('Pendente P')
    expect(await savedText(workbook)).not.toContain('Pendente Q')
    const afterOpen = await savedText(workbook)

    // 7) a change past the undo budget leaves no history: a failure is not announced as
    //    undone — the task stays under review, flagged, and the file is not written
    await ask(sheets, 'Preencha e falhe.\nFILL\nFALHA')
    const big = sheets.locator('.copilot .ai-review-card').last()
    await expect(big).toHaveAttribute('data-review', 'conflict-untracked', { timeout: 60_000 })
    await expect(big).toContainText('Não há histórico suficiente')
    await expect(big).not.toContainText('as alterações dela foram desfeitas')
    await expect(big.locator('.ai-review-reject')).toBeDisabled()
    await sheets.screenshot({ path: screenshotPath('fariv-review-sheets-untracked') })
    await sheets.waitForTimeout(2_000)
    expect(await savedText(workbook)).toBe(afterOpen)
  } finally {
    await closeAndSaveVideo(launched, 'fariv-ai-review-sheets')
    server.close()
  }
})

test('planilha: Aceitar → desfazer a tarefa inteira, mesmo depois do salvamento automático', async () => {
  test.setTimeout(240_000)
  const { server, port } = await startScriptedModel((run): ModelReply | Promise<ModelReply> => {
    const sheetId = (results: readonly string[]) =>
      /id=([^,)\s]+)/.exec(results[0] ?? '')?.[1] ?? 'sheet-1'
    const groups = directive(run.instruction, 'OPS')
      .split('|')
      .filter(Boolean)
      .map((group) => group.split(';').map((pair) => pair.split('=') as [string, string]))
    return scriptedRun(run, [
      () => ({ tool: 'get_workbook_context', args: {} }),
      ...groups.map((ops) => (results: readonly string[]) => ({
        tool: 'propose_operations',
        args: {
          summary: 'Editar células',
          operations: ops.map(([address, value]) => ({
            op: 'set_cell',
            sheetId: sheetId(results),
            address,
            value,
          })),
        },
      })),
    ])
  })
  const dir = await mkdtemp(join(tmpdir(), 'fariv-undo-'))
  const workbook = join(dir, 'vendas.xlsx')
  await copyFile(XLSX_FIXTURE, workbook)
  const userDataDir = await mkdtemp(join(tmpdir(), 'fariv-undo-ud-'))
  await useScriptedModel(userDataDir, port)
  const launched = await launchShell({
    userDataDir,
    onboardingSeen: true,
    settings: { autoSaveDefault: true, autoSaveDefaultUpdatedAt: Date.now() },
    videoDir: 'fariv-ai-review-sheets-undo',
    openFile: workbook,
    lang: 'pt',
  })
  try {
    const sheets = await waitForPageWithUrl(launched.app, '://sheets/')
    await sheets.waitForFunction(() => document.body.textContent?.includes('Sheet1'), null, {
      timeout: 30_000,
    })
    await sheets.waitForTimeout(1_000)
    const expand = sheets.locator('.copilot.collapsed .expand-copilot')
    if (await expand.isVisible()) await expand.click()
    const lastCard = () => sheets.locator('.copilot .ai-review-card').last()

    // 1) a task of several operations (two batches) is accepted and written to the file
    await ask(sheets, 'Escreva.\nOPS: A3=Aceito 1;B3=Aceito 2;C3=Aceito 3|A4=Aceito 4;B4=Aceito 5')
    await expect(lastCard()).toHaveAttribute('data-review', 'pending', { timeout: 30_000 })
    await expect(lastCard()).toContainText('5 alterações da IA')
    await lastCard().locator('.ai-review-accept').click()
    await expect(lastCard()).toHaveAttribute('data-review', 'accepted')
    for (const value of ['Aceito 1', 'Aceito 3', 'Aceito 5']) {
      await expect.poll(() => savedText(workbook), POLL).toContain(value)
    }

    // 2) Undo task: the whole task leaves the workbook and the file, in one action —
    //    across the save that already wrote it (the history is carried over the save)
    const undo = lastCard().locator('.ai-review-undo')
    await expect(undo).toBeEnabled()
    await expect(undo).toHaveText('Desfazer tarefa')
    await sheets.screenshot({ path: screenshotPath('fariv-review-sheets-accepted-undo') })
    await undo.click()
    await expect(lastCard()).toHaveAttribute('data-review', 'undone', { timeout: 30_000 })
    await expect(lastCard()).toContainText('Tarefa aceita e depois desfeita')
    for (const address of ['A3', 'B3', 'C3', 'A4', 'B4']) {
      expect(await cell(sheets, address)).toBe('')
    }
    await expect.poll(() => savedText(workbook), POLL).not.toContain('Aceito')

    // 3) after a manual edit, the accepted task can no longer be undone as a unit (that
    //    would take the edit too): the card says so and nothing changes
    await ask(sheets, 'Escreva.\nOPS: A5=Mantido 1;B5=Mantido 2')
    await expect(lastCard()).toHaveAttribute('data-review', 'pending', { timeout: 30_000 })
    await lastCard().locator('.ai-review-accept').click()
    await expect(lastCard()).toHaveAttribute('data-review', 'accepted')
    await expect.poll(() => savedText(workbook), POLL).toContain('Mantido 2')
    await typeInto(sheets, 'D5', 'Edição manual')
    await lastCard().locator('.ai-review-undo').click()
    await expect(lastCard()).toHaveAttribute('data-review', 'conflict-edited')
    await expect(lastCard()).toContainText('não pode mais ser desfeita de uma vez')
    await expect(lastCard().locator('.ai-review-undo')).toBeDisabled()
    expect(await cell(sheets, 'A5')).toBe('Mantido 1')
    expect(await cell(sheets, 'D5')).toBe('Edição manual')

    // 4) a later task blocks undoing an earlier one, which would take it too
    await ask(sheets, 'Escreva.\nOPS: A6=Primeira')
    await expect(lastCard()).toHaveAttribute('data-review', 'pending', { timeout: 30_000 })
    await lastCard().locator('.ai-review-accept').click()
    await expect.poll(() => savedText(workbook), POLL).toContain('Primeira')
    const first = lastCard()
    const firstId = await first.getAttribute('data-task')
    await ask(sheets, 'Escreva.\nOPS: A7=Segunda')
    await expect(lastCard()).not.toHaveAttribute('data-task', firstId!, { timeout: 30_000 })
    await expect(lastCard()).toHaveAttribute('data-review', 'pending', { timeout: 30_000 })
    await lastCard().locator('.ai-review-accept').click()
    await expect.poll(() => savedText(workbook), POLL).toContain('Segunda')
    const earlier = sheets.locator(`.copilot .ai-review-card[data-task="${firstId}"]`)
    await earlier.locator('.ai-review-undo').click()
    await expect(earlier).toHaveAttribute('data-review', 'conflict-edited')
    expect(await cell(sheets, 'A6')).toBe('Primeira')
    // the latest one still can
    await lastCard().locator('.ai-review-undo').click()
    await expect(lastCard()).toHaveAttribute('data-review', 'undone', { timeout: 30_000 })
    expect(await cell(sheets, 'A7')).toBe('')
    await expect.poll(() => savedText(workbook), POLL).not.toContain('Segunda')
    expect(await savedText(workbook)).toContain('Primeira')
  } finally {
    await closeAndSaveVideo(launched, 'fariv-ai-review-sheets-undo')
    server.close()
  }
})
