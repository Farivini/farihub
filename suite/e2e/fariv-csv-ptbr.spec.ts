import { test, expect, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl, screenshotPath } from './helpers'
import { startScriptedModel, useScriptedModel } from './fariv-review-helpers'

/**
 * CSV pt-BR import (`;` and decimal comma) against a real public dataset, end to end
 * in the Electron app: open → types and sums over all 244 records → the AI's tools
 * read the imported numbers → formulas and a pivot under review → Accept → Save As
 * .xlsx → reopen. The original (comma + point) and a TSV keep their reading, and a
 * pt-BR CSV saved in place keeps its own convention.
 *
 * Data: seaborn-data `tips.csv` (244 restaurant bills and tips), downloaded and
 * checked by SHA-256 rather than vendored (no license file in that repository).
 * Set FARIV_TIPS_CSV to a local copy to run offline. The variants are derived here.
 *
 * The model is SIMULATED (a scripted OpenAI-compatible endpoint driving the real
 * tools); this does not validate a real Codex or Claude account.
 */

const TIPS_URL = 'https://raw.githubusercontent.com/mwaskom/seaborn-data/master/tips.csv'
const TIPS_SHA256 = 'e54cc4d2ce1bff65d32ca60b3e4b802e06bde1d7e7caf6f796f6bf7370e863b0'
const POLL = { timeout: 30_000, intervals: [250, 500, 1000] }
const DAYS = ['Thur', 'Fri', 'Sat', 'Sun'] as const

interface Totals {
  records: number
  bill: number
  tip: number
  byDay: Record<string, { bill: number; tip: number }>
}

async function tipsCsv(): Promise<string> {
  const local = process.env.FARIV_TIPS_CSV
  const bytes = local
    ? await readFile(local)
    : Buffer.from(await (await fetch(TIPS_URL)).arrayBuffer())
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== TIPS_SHA256) throw new Error(`tips.csv changed upstream (sha256 ${digest})`)
  return bytes.toString('utf8')
}

/** independent totals in integer cents (no floating point) */
function totalsOf(csv: string): Totals {
  const cents = (value: string) => {
    const [whole, fraction = ''] = value.split('.')
    return Number(whole) * 100 + Number(fraction.padEnd(2, '0').slice(0, 2))
  }
  const rows = csv
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.split(','))
  const byDay: Totals['byDay'] = {}
  let bill = 0
  let tip = 0
  for (const row of rows) {
    const day = row[4]!.replaceAll('"', '')
    const entry = (byDay[day] ??= { bill: 0, tip: 0 })
    entry.bill += cents(row[0]!)
    entry.tip += cents(row[1]!)
    bill += cents(row[0]!)
    tip += cents(row[1]!)
  }
  return { records: rows.length, bill, tip, byDay }
}

/** the pt-BR variant: `;`, decimal comma in both amount columns, UTF-8 BOM, CRLF */
function ptbrVariant(csv: string): string {
  const lines = csv
    .trim()
    .split(/\r?\n/)
    .map((line) =>
      line
        .split(',')
        .map((field, column) => {
          const value = field.replaceAll('"', '')
          return column <= 1 ? value.replace('.', ',') : value
        })
        .join(';'),
    )
  return '﻿' + lines.join('\r\n') + '\r\n'
}

function tsvVariant(csv: string): string {
  return csv
    .trim()
    .split(/\r?\n/)
    .map((line) =>
      line
        .split(',')
        .map((field) => field.replaceAll('"', ''))
        .join('\t'),
    )
    .join('\n')
}

type Control = (request: unknown) => Promise<{ status?: string; result?: { values?: unknown[][] } }>

/** values of a range, read through the app's control hook (the grid is a canvas) */
async function range(page: Page, address: string): Promise<unknown[][]> {
  const selected = await page.evaluate(async (target) => {
    const control = (window as unknown as { __genofficeControl: Control }).__genofficeControl
    const moved = await control({ cmd: 'goto', target: { kind: 'sheets', range: target } })
    if (moved.status !== 'ok') return { result: { values: [] } }
    return control({ cmd: 'selection' })
  }, address)
  return selected.result?.values ?? []
}

async function cell(page: Page, address: string): Promise<unknown> {
  return (await range(page, address))[0]?.[0] ?? ''
}

async function openedSheets(
  app: Awaited<ReturnType<typeof launchShell>>,
  header = 'total_bill',
): Promise<Page> {
  const page = await waitForPageWithUrl(app.app, '://sheets/')
  await expect(page.locator('[data-u-comp="defined-name"] input')).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => cell(page, 'A1'), POLL).toBe(header)
  return page
}

const toCents = (value: unknown) => Math.round(Number(value) * 100)

/** rows `from`..`to` of two columns, in blocks (the control hook returns ≤ 200 values) */
async function rows(page: Page, columns: string, from: number, to: number): Promise<unknown[][]> {
  const [first, last] = columns.split(':')
  const out: unknown[][] = []
  for (let start = from; start <= to; start += 100) {
    const end = Math.min(to, start + 99)
    out.push(...(await range(page, `${first}${start}:${last}${end}`)))
  }
  return out
}

/** every amount is a number, and they add up to the independent totals */
async function expectNumericTotals(page: Page, expected: Totals): Promise<void> {
  const values = await rows(page, 'A:B', 2, expected.records + 1)
  expect(values).toHaveLength(expected.records)
  for (const [bill, tip] of values) {
    expect(typeof bill, `total_bill ${String(bill)}`).toBe('number')
    expect(typeof tip, `tip ${String(tip)}`).toBe('number')
  }
  expect(values.reduce((sum, row) => sum + toCents(row[0]), 0)).toBe(expected.bill)
  expect(values.reduce((sum, row) => sum + toCents(row[1]), 0)).toBe(expected.tip)
  // identifiers and text stay as they were
  expect(await cell(page, 'E2')).toBe('Sun')
  expect(await cell(page, 'G2')).toBe(2)
}

/** the pivot's rows by day, read from the grid: day → [bill, tip] in cents */
async function pivotByDay(page: Page): Promise<Record<string, [number, number]>> {
  const grid = await range(page, 'K1:M8')
  const out: Record<string, [number, number]> = {}
  for (const row of grid) {
    const day = String(row[0] ?? '')
    if ((DAYS as readonly string[]).includes(day)) out[day] = [toCents(row[1]), toCents(row[2])]
  }
  return out
}

const expectedByDay = (totals: Totals) =>
  Object.fromEntries(DAYS.map((day) => [day, [totals.byDay[day]!.bill, totals.byDay[day]!.tip]]))

let source = ''
let totals: Totals
let dir = ''

test.beforeAll(async () => {
  source = await tipsCsv()
  totals = totalsOf(source)
  expect(totals.records).toBe(244)
  expect(totals.bill).toBe(482_777)
  expect(totals.tip).toBe(73_158)
  dir = await mkdtemp(join(tmpdir(), 'fariv-csv-ptbr-'))
  await writeFile(join(dir, 'tips.csv'), source)
  await writeFile(join(dir, 'tips-ptbr.csv'), ptbrVariant(source))
  await writeFile(join(dir, 'tips.tsv'), tsvVariant(source))
})

test('CSV: original, pt-BR e TSV abrem com números em todas as 244 linhas', async () => {
  test.setTimeout(240_000)
  for (const file of ['tips.csv', 'tips-ptbr.csv', 'tips.tsv']) {
    const app = await launchShell({
      onboardingSeen: true,
      videoDir: 'fariv-csv-open',
      openFile: join(dir, file),
      lang: 'pt',
    })
    try {
      const page = await openedSheets(app)
      await expectNumericTotals(page, totals)
      if (file === 'tips-ptbr.csv') {
        await expect(page.locator('.csv-format-notice')).toContainText(
          'tips-ptbr.csv aberto: números com vírgula decimal reconhecidos em 2 colunas',
        )
        await page.screenshot({ path: screenshotPath('fariv-csv-ptbr-opened') })
      }
    } finally {
      await closeAndSaveVideo(app, 'fariv-csv-open')
    }
  }
})

for (const file of ['tips.csv', 'tips-ptbr.csv'] as const) {
  test(`CSV ${file}: a IA lê os números, cria fórmulas e dinâmica; aceitar, salvar XLSX e reabrir`, async () => {
    test.setTimeout(240_000)
    const results: string[] = []
    const { server, port } = await startScriptedModel((run) => {
      const step = run.toolResults.length
      results.splice(0, results.length, ...run.toolResults)
      const id = /id=([^,)\s]+)/.exec(run.toolResults[0] ?? '')?.[1]
      const steps = [
        { tool: 'get_workbook_context', args: {} },
        { tool: 'aggregate_range', args: { sheetId: id, range: 'A2:A245' } },
        { tool: 'aggregate_range', args: { sheetId: id, range: 'B2:B245' } },
        {
          tool: 'propose_operations',
          args: {
            summary: 'Totais com fórmulas editáveis',
            operations: [
              { op: 'set_cell', sheetId: id, address: 'H2', value: 'Total das contas' },
              { op: 'set_formula', sheetId: id, address: 'I2', formula: '=SUM(A2:A245)' },
              { op: 'set_cell', sheetId: id, address: 'H3', value: 'Total das gorjetas' },
              { op: 'set_formula', sheetId: id, address: 'I3', formula: '=SUM(B2:B245)' },
              { op: 'set_cell', sheetId: id, address: 'H4', value: 'Registros' },
              { op: 'set_formula', sheetId: id, address: 'I4', formula: '=COUNT(A2:A245)' },
            ],
          },
        },
        {
          tool: 'propose_operations',
          args: {
            summary: 'Resumo por dia',
            operations: [
              {
                op: 'add_pivot',
                sheetId: id,
                sourceRange: 'A1:G245',
                targetCell: 'K1',
                rowFields: 'day',
                values: [
                  { field: 'total_bill', agg: 'sum' },
                  { field: 'tip', agg: 'sum' },
                ],
              },
            ],
          },
        },
      ]
      return step < steps.length ? steps[step]! : { text: 'Pronto: totais e resumo por dia.' }
    })
    const userDataDir = await mkdtemp(join(tmpdir(), 'fariv-csv-ai-'))
    await useScriptedModel(userDataDir, port)
    const saved = join(dir, `${file}-analise.xlsx`)
    const app = await launchShell({
      userDataDir,
      onboardingSeen: true,
      settings: { autoSaveDefault: false },
      videoDir: 'fariv-csv-ai',
      openFile: join(dir, file),
      lang: 'pt',
    })
    try {
      const page = await openedSheets(app)
      const expand = page.locator('.copilot.collapsed .expand-copilot')
      if (await expand.isVisible()) await expand.click()
      const composer = page.locator('.copilot textarea')
      await composer.fill(
        'Some contas e gorjetas e faça um resumo por dia com fórmulas e tabela dinâmica.',
      )
      await composer.press('Enter')
      const card = page.locator('.copilot .ai-review-card').last()
      await expect(card).toHaveAttribute('data-review', 'pending', { timeout: 60_000 })

      // what the AI saw: the import notes, and sums over the real numbers
      if (file === 'tips-ptbr.csv') {
        expect(results[0]).toContain('semicolon-separated, decimal comma')
        expect(results[0]).toContain(
          'Numeric columns: A "total_bill" (decimal comma), B "tip" (decimal comma)',
        )
      }
      expect(results[1]).toContain('4,827.77')
      expect(results[2]).toContain('731.58')

      await expect.poll(async () => toCents(await cell(page, 'I2')), POLL).toBe(totals.bill)
      expect(toCents(await cell(page, 'I3'))).toBe(totals.tip)
      expect(await cell(page, 'I4')).toBe(244)
      await expect.poll(() => pivotByDay(page), POLL).toEqual(expectedByDay(totals))
      await page.screenshot({ path: screenshotPath(`fariv-csv-ai-${file}`) })
      await card.locator('.ai-review-accept').click()
      await expect(card).toHaveAttribute('data-review', 'accepted')

      await app.app.evaluate(({ dialog, webContents }, path) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
        webContents
          .getAllWebContents()
          .find((w) => w.getURL().includes('://sheets/'))
          ?.send('menu:action', 'save-as')
      }, saved)
      await expect
        .poll(async () => (await readFile(saved).catch(() => Buffer.alloc(0))).length, POLL)
        .toBeGreaterThan(1000)
      const zip = await JSZip.loadAsync(await readFile(saved))
      expect(
        Object.keys(zip.files).some((name) => /^xl\/pivotTables\/pivotTable\d+\.xml$/.test(name)),
      ).toBe(true)
      const sheetXml = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
      expect(sheetXml).toContain('SUM(A2:A245)')
      // the amounts are stored as numbers in the .xlsx (A2 = 16.99, not the text "16,99")
      expect(sheetXml).toMatch(/<c r="A2"[^>]*><v>16\.99<\/v>/)
    } finally {
      await closeAndSaveVideo(app, 'fariv-csv-ai')
      server.close()
    }

    const reopened = await launchShell({
      onboardingSeen: true,
      videoDir: 'fariv-csv-reopen',
      openFile: saved,
      lang: 'pt',
    })
    try {
      const page = await openedSheets(reopened)
      await expectNumericTotals(page, totals)
      await expect.poll(async () => toCents(await cell(page, 'I2')), POLL).toBe(totals.bill)
      expect(toCents(await cell(page, 'I3'))).toBe(totals.tip)
      await expect.poll(() => pivotByDay(page), POLL).toEqual(expectedByDay(totals))
    } finally {
      await closeAndSaveVideo(reopened, 'fariv-csv-reopen')
    }
  })
}

test('CSV pt-BR salvo no lugar mantém `;` e a vírgula decimal', async () => {
  test.setTimeout(120_000)
  const path = join(dir, 'tips-ptbr-salvar.csv')
  await writeFile(path, ptbrVariant(source))
  const app = await launchShell({
    onboardingSeen: true,
    settings: { autoSaveDefault: false },
    videoDir: 'fariv-csv-save',
    openFile: path,
    lang: 'pt',
  })
  try {
    const page = await openedSheets(app)
    const nameBox = page.locator('[data-u-comp="defined-name"] input')
    await nameBox.click()
    await nameBox.fill('E2')
    await nameBox.press('Enter')
    await expect(nameBox).toHaveValue('E2')
    // the first key opens the cell editor; give the grid its focus back first
    await page.waitForTimeout(500)
    await page.keyboard.type('Dom', { delay: 20 })
    await page.keyboard.press('Enter')
    await expect.poll(() => cell(page, 'E2'), POLL).toBe('Dom')
    await app.app.evaluate(({ dialog, webContents }) => {
      // "Keep saving as CSV?" → Continue as CSV
      dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as never
      webContents
        .getAllWebContents()
        .find((w) => w.getURL().includes('://sheets/'))
        ?.send('menu:action', 'save')
    })
    await expect.poll(async () => (await readFile(path, 'utf8')).includes('Dom'), POLL).toBe(true)
    const lines = (await readFile(path, 'utf8')).replace(/^﻿/, '').split(/\r?\n/)
    expect(lines[0]).toBe('total_bill;tip;sex;smoker;day;time;size')
    expect(lines[1]).toBe('16,99;1,01;Female;No;Dom;Dinner;2')
    expect(lines[244]).toBe(ptbrVariant(source).split(/\r\n/)[244])
  } finally {
    await closeAndSaveVideo(app, 'fariv-csv-save')
  }
})

test('CSV com coluna ambígua: o dado fica como escrito e o aviso explica', async () => {
  test.setTimeout(120_000)
  const path = join(dir, 'pesos.csv')
  await writeFile(path, 'Peso;Lote\r\n1.250;0012\r\n2.500;0345\r\n')
  const app = await launchShell({
    onboardingSeen: true,
    videoDir: 'fariv-csv-ambiguous',
    openFile: path,
    lang: 'pt',
  })
  try {
    const page = await openedSheets(app, 'Peso')
    // 1.250 is 1250 in pt-BR and 1.25 in English: nothing decides it, so it stays as written
    expect(await cell(page, 'A2')).toBe('1.250')
    expect(await cell(page, 'A3')).toBe('2.500')
    // codes keep their leading zeros
    expect(await cell(page, 'B2')).toBe('0012')
    const notice = page.locator('.csv-format-notice')
    await expect(notice).toContainText('Mantido como texto (ambíguo): A (Peso)')
    await expect(notice).toContainText('Valores como “1.250” servem às duas convenções decimais')
    await page.waitForTimeout(800)
    await page.screenshot({ path: screenshotPath('fariv-csv-ambiguous') })
  } finally {
    await closeAndSaveVideo(app, 'fariv-csv-ambiguous')
  }
})
