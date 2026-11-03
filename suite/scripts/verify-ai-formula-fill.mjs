/** Real Sheets renderer + native sidecar; model and native file pickers are scripted.
 * Build apps/sheets first. Run from suite:
 * node --import tsx scripts/verify-ai-formula-fill.mjs CSV OUTPUT_DIR
 * Optional ELECTRON_TEST_EXECUTABLE and FARIV_TEST_XVFB (for Linux hosts).
 * FARIV_BASELINE=1 records failures without requiring the fixed behavior.
 */
import { _electron as electron } from 'playwright-core'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import { startScriptedModel, useScriptedModel } from '../e2e/fariv-review-helpers.ts'

const csv = resolve(process.argv[2])
const out = resolve(process.argv[3])
await mkdir(out, { recursive: true })
const expected = JSON.parse(
  spawnSync(
    'python3',
    [
      '-c',
      `
import csv,json,sys
from decimal import Decimal
with open(sys.argv[1],encoding='utf-8-sig',newline='') as f:
 rows=list(csv.DictReader(f,delimiter=';'))
print(json.dumps([{'quantity':int(r['quantidade']), 'price':float(Decimal(r['preco_unitario_gbp'].replace(',','.'))), 'cents':int(Decimal(r['preco_unitario_gbp'].replace(',','.'))*100)*int(r['quantidade'])} for r in rows]))
`,
      csv,
    ],
    { encoding: 'utf8' },
  ).stdout,
)
assert.equal(expected.length, 10000)
const report = {
  provider: 'SIMULATED OpenAI-compatible HTTP provider; no real model',
  application:
    'real Electron Sheets, native XLSX sidecar, production renderer; file pickers return test paths',
  platform: process.platform,
  csvSha256: createHash('sha256')
    .update(await readFile(csv))
    .digest('hex'),
  records: expected.length,
  expectedTotal: expected.reduce((n, r) => n + r.cents, 0) / 100,
  requests: [],
  checks: {},
  memory: {},
  timingsMs: {},
}
let proposeAt
const { server, port } = await startScriptedModel((run) => {
  const sheetId = /id=([^,)\s]+)/.exec(run.toolResults[0] ?? '')?.[1]
  const steps = [
    { tool: 'get_workbook_context', args: {} },
    { tool: 'load_guide', args: { guides: ['writing'] } },
    { tool: 'read_range', args: { range: 'A1:H3', sheetId } },
    { tool: 'read_range', args: { range: 'D9999:F10001', sheetId } },
    {
      tool: 'propose_operations',
      args: {
        summary: 'Acrescentar valor_linha em I1:I10001',
        operations: [
          { op: 'set_cell', sheetId, address: 'I1', value: 'valor_linha' },
          { op: 'set_formula', sheetId, address: 'I2', formula: '=D2*F2' },
          { op: 'fill_range', sheetId, source: 'I2', target: 'I2:I10001' },
        ],
      },
    },
  ]
  const reply = steps[run.toolResults.length] ?? {
    text: 'Coluna preparada para revisão. Aceite para manter ou rejeite para desfazer.',
  }
  if (reply.tool === 'propose_operations') proposeAt = performance.now()
  else if (!reply.tool && proposeAt) {
    ;(report.timingsMs.proposeToToolReturn ??= []).push(performance.now() - proposeAt)
    proposeAt = undefined
  }
  report.requests.push({ ...reply, lastResult: run.toolResults.at(-1) })
  return reply
})
const userData = await mkdtemp(join(tmpdir(), 'fariv-formula-'))
await useScriptedModel(userData, port)
const workbook = join(out, 'source.csv')
await copyFile(csv, workbook)
const saved = join(out, 'saved.xlsx')
let xvfb, app, sampleTimer, cdp
const heapSamples = []
const failures = []
const check = (name, condition, detail) => {
  report.checks[name] = { passed: !!condition, ...detail }
  if (!condition) failures.push(name)
  console.log(name, condition ? 'PASS' : 'FAIL', detail ?? '')
}
const menu = async (pattern) =>
  app.evaluate(({ Menu }, pattern) => {
    const find = (items) => {
      for (const item of items) {
        if (new RegExp(pattern, 'i').test(item.label ?? '')) return item
        const child = item.submenu && find(item.submenu.items)
        if (child) return child
      }
    }
    const item = find(Menu.getApplicationMenu().items)
    if (!item) throw new Error(`Menu not found: ${pattern}`)
    item.click()
  }, pattern)
try {
  if (process.env.FARIV_TEST_XVFB) {
    xvfb = spawn(
      process.env.FARIV_TEST_XVFB,
      [':110', '-screen', '0', '1440x1000x24', '-ac', '-nolisten', 'unix', '-listen', 'tcp'],
      { env: process.env, stdio: 'ignore' },
    )
    await new Promise((r) => setTimeout(r, 700))
  }
  app = await electron.launch({
    ...(process.env.ELECTRON_TEST_EXECUTABLE
      ? { executablePath: process.env.ELECTRON_TEST_EXECUTABLE }
      : {}),
    args: [
      ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : []),
      resolve('apps/sheets'),
    ],
    env: {
      ...process.env,
      ...(xvfb ? { DISPLAY: '127.0.0.1:110' } : {}),
      GENOFFICE_USER_DATA: userData,
      GENOFFICE_LANG: 'pt',
      GENOFFICE_DEBUG_HOOKS: '1',
    },
    timeout: 60000,
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message))
  await page.locator('.copilot textarea').waitFor({ timeout: 60000 })
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, workbook)
  const openAt = performance.now()
  await menu('Abrir Pasta')
  await page.waitForFunction(
    () =>
      window.__genofficeDebug?.univerAPI
        .getActiveWorkbook()
        ?.getActiveSheet()
        ?.getRange('A1')
        .getValue() === 'nota',
    null,
    { timeout: 60000 },
  )
  report.timingsMs.importToFirstPaint = performance.now() - openAt
  await page.waitForTimeout(1000)
  cdp = await page.context().newCDPSession(page)
  const sample = async () => {
    try {
      heapSamples.push({ at: performance.now(), ...(await cdp.send('Runtime.getHeapUsage')) })
    } catch {
      /* closed */
    }
  }
  await sample()
  report.memory.jsHeapBefore = heapSamples.at(-1)
  sampleTimer = setInterval(() => void sample(), 100)
  const audit = async () => {
    const rows = await page.evaluate(() => {
      const sheet = window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet()
      const values = sheet.getRange('I2:I10001').getRawValues()
      const displayed = sheet.getRange('I2:I10001').getValues()
      const formulas = sheet.getRange('I2:I10001').getFormulas()
      const missing = formulas.flatMap((r, i) => (r[0] ? [] : [`I${i + 2}`]))
      const cells = missing.length
        ? (window.__genofficeDebug.readCells?.(missing, sheet.getSheetId()) ?? {})
        : {}

      return values.map((r, i) => ({
        value: r[0] ?? Number(displayed[i]?.[0]),
        formula: formulas[i]?.[0] || cells[`I${i + 2}`]?.formula || '',
      }))
    })
    for (const row of rows) {
      if (row.formula && !row.formula.startsWith('=')) row.formula = '=' + row.formula
    }
    const wrong = rows.flatMap((r, i) =>
      r.formula !== `=D${i + 2}*F${i + 2}` ||
      !Number.isFinite(r.value) ||
      Math.abs(r.value - expected[i].cents / 100) > 1e-8
        ? [{ row: i + 2, ...r, expected: expected[i].cents / 100 }]
        : [],
    )
    return {
      count: rows.length,
      errors: wrong.length,
      examples: wrong.slice(0, 8),
      first: rows[0],
      last: rows.at(-1),
      total: rows.reduce((n, r) => n + (typeof r.value === 'number' ? r.value : 0), 0),
    }
  }
  const ask = async () => {
    const start = performance.now()
    const composer = page.locator('.copilot textarea')
    await composer.fill(
      'Preserve a base original e acrescente valor_linha com fórmula editável quantidade × preco_unitario_gbp até o último registro. Prepare a alteração para eu aceitar ou rejeitar.',
    )
    await composer.press('Enter')
    const card = page.locator('.ai-review-card').last()
    await card.waitFor({ timeout: 120000 })
    await page.waitForFunction(
      () =>
        document.querySelector('.ai-review-card:last-of-type')?.getAttribute('data-review') ===
          'pending' ||
        [...document.querySelectorAll('.ai-review-card')].at(-1)?.getAttribute('data-review') ===
          'pending',
      null,
      { timeout: 120000 },
    )
    report.timingsMs.chatToReview ??= performance.now() - start
    await page.waitForTimeout(2000)
    return card
  }
  let card = await ask()
  report.auditInitial = await audit()
  await sample()
  report.memory.jsHeapFirstOperationLargestSample = Math.max(...heapSamples.map((x) => x.usedSize))
  check('all10000Initial', report.auditInitial.errors === 0, report.auditInitial)
  const sourceValues = await page.evaluate(() => {
    const s = window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet()
    return {
      qty: s.getRange('D2:D10001').getRawValues(),
      price: s.getRange('F2:F10001').getRawValues(),
    }
  })
  check(
    'sourceValuesPreserved',
    sourceValues.qty.every((r, i) => r[0] === expected[i].quantity) &&
      sourceValues.price.every((r, i) => r[0] === expected[i].price),
  )
  await page.screenshot({ path: join(out, 'pending.png') })
  // Evict the first window and cause a fresh calculation. A fill that merely
  // loaded neighbors initially can look correct before this step.
  await page.evaluate(() => {
    const api = window.__genofficeDebug.univerAPI
    const sheet = api.getActiveWorkbook().getActiveSheet()
    sheet.getRange('A9000').activate()
    api.getActiveWorkbook().setActiveSheet(sheet)
  })
  const name = page.locator('[data-u-comp="defined-name"] input')
  await name.fill('A9000')
  await name.press('Enter')
  await page.waitForTimeout(1500)
  await page.evaluate(() => {
    const api = window.__genofficeDebug.univerAPI
    // This is a calculation trigger, not a data modification.
    return api.executeCommand(
      'formula.mutation.set-formula-calculation-start',
      { forceCalculation: true },
      { onlyLocal: true },
    )
  })
  await page.waitForTimeout(2500)
  report.auditAfterScroll = await audit()
  check(
    'all10000AfterScrollAndRecalc',
    report.auditAfterScroll.errors === 0,
    report.auditAfterScroll,
  )
  await card.locator('.ai-review-reject').click()
  await page.waitForTimeout(1200)
  const rejected = await page.evaluate(() => {
    const sheet = window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet()
    return {
      header: sheet.getRange('I1').getValue(),
      formulas: sheet
        .getRange('I2:I10001')
        .getFormulas()
        .filter((r) => !!r[0]).length,
    }
  })
  check('rejectRemovesWholeColumn', !rejected.header && rejected.formulas === 0, rejected)
  if (!process.env.FARIV_BASELINE) {
    report.manualWarmComparison = await page.evaluate(async () => {
      const api = window.__genofficeDebug.univerAPI
      const sheet = api.getActiveWorkbook().getActiveSheet()
      sheet.getRange('I2').setFormula('=D2*F2')
      sheet.getRange('I2:I10001').activate()
      const start = performance.now()
      await api.executeCommand('sheet.command.copy-down')
      return {
        milliseconds: performance.now() - start,
        condition:
          'Native fill-down, with precedents already resident from the AI task; excludes source loading and model latency',
      }
    })
    await page.waitForTimeout(1500)
    report.manualWarmComparison.audit = await audit()
    check('manualWarmFillResults', report.manualWarmComparison.audit.errors === 0)
    await page.evaluate(async () => {
      const api = window.__genofficeDebug.univerAPI
      await api.undo()
      await api.undo()
    })
    await page.waitForTimeout(500)
    card = await ask()
    await card.locator('.ai-review-accept').click()
    await page.waitForTimeout(300)
    check('acceptKeepsFormulas', (await audit()).errors === 0)
    const undo = card.locator('.ai-review-undo')
    if (await undo.count()) await undo.click()
    else await page.evaluate(() => window.__genofficeDebug.univerAPI.undo())
    await page.waitForTimeout(1200)
    check(
      'undoRemovesWholeColumn',
      await page.evaluate(() =>
        window.__genofficeDebug.univerAPI
          .getActiveWorkbook()
          .getActiveSheet()
          .getRange('I2:I10001')
          .getFormulas()
          .every((r) => !r[0]),
      ),
    )
    card = await ask()
    await card.locator('.ai-review-accept').click()
    await page.waitForTimeout(500)
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
    }, saved)
    const saveAt = performance.now()
    await menu('Salvar Como')
    for (let i = 0; i < 120; i++) {
      try {
        await readFile(saved)
        break
      } catch {
        await page.waitForTimeout(250)
      }
    }
    report.timingsMs.save = performance.now() - saveAt
    const zip = await JSZip.loadAsync(await readFile(saved))
    const xml = await zip.file('xl/worksheets/sheet1.xml').async('string')
    check(
      'saved10000EditableFormulas',
      (xml.match(/<f(?:\s[^>]*)?>/g) ?? []).length === 10000 && xml.includes('D10001*F10001'),
    )
    const cached = [...xml.matchAll(/<c\b[^>]*\br="I(\d+)"[^>]*>([\s\S]*?)<\/c>/g)]
      .filter((m) => Number(m[1]) >= 2)
      .map((m) => ({ row: Number(m[1]), value: /<v>([^<]*)<\/v>/.exec(m[2])?.[1] }))
    check(
      'saved10000CachedResults',
      cached.length === 10000 &&
        cached.every(
          (c) =>
            c.value !== undefined &&
            Math.abs(Number(c.value) - expected[c.row - 2].cents / 100) < 1e-8,
        ),
    )

    await page.waitForTimeout(3500)
    // Saving reopens a new native session; explicitly open the saved path again.
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, saved)
    await menu('Abrir Pasta')
    await page.waitForTimeout(2000)
    await page.waitForFunction(
      () =>
        window.__genofficeDebug.univerAPI
          .getActiveWorkbook()
          .getActiveSheet()
          .getRange('I10001')
          .getFormula() === '=D10001*F10001',
      null,
      { timeout: 45000 },
    )
    await page.waitForFunction(
      () =>
        Number(
          window.__genofficeDebug.univerAPI
            .getActiveWorkbook()
            .getActiveSheet()
            .getRange('I10001')
            .getValue(),
        ) === 0.78,
      null,
      { timeout: 45000 },
    )
    report.auditReopened = await audit()
    check('all10000AfterSaveReopen', report.auditReopened.errors === 0, report.auditReopened)
    await name.fill('I10001')
    await name.press('Enter')
    report.formulaStateBeforeEdit = await page.evaluate(() =>
      window.__genofficeDebug.formulaState(),
    )
    await page.keyboard.type('=D10001*F10001+1', { delay: 5 })
    await page.keyboard.press('Enter')
    await page.waitForFunction(
      () =>
        Number(
          window.__genofficeDebug.univerAPI
            .getActiveWorkbook()
            .getActiveSheet()
            .getRange('I10001')
            .getValue(),
        ) === 1.78,
      null,
      { timeout: 15000 },
    )
    await page.evaluate(() => window.__genofficeDebug.univerAPI.undo())
    await page.waitForFunction(
      () =>
        Number(
          window.__genofficeDebug.univerAPI
            .getActiveWorkbook()
            .getActiveSheet()
            .getRange('I10001')
            .getValue(),
        ) === 0.78,
      null,
      { timeout: 15000 },
    )
    await page.waitForTimeout(1500)
    const editedAudit = await audit()
    check('lastFormulaEditableThroughUIAndUndo', editedAudit.errors === 0, editedAudit)

    await page.screenshot({ path: join(out, 'reopened.png') })
  }
  await sample()
  report.memory.jsHeapLargestSample = Math.max(...heapSamples.map((x) => x.usedSize))
  report.memory.sampleCount = heapSamples.length
  report.memory.electronMainMaxRssKiB = await app.evaluate(() => process.resourceUsage().maxRSS)
  report.memory.note =
    'JS heap is sampled, not total app RSS. Main-process maxRSS excludes renderer/sidecar. getAppMetrics RSS is zero in this host; no aggregate 1 GB comparison is claimed.'
} catch (e) {
  report.error = String(e.stack ?? e)
  failures.push('driver')
  console.error(report.error)
} finally {
  if (sampleTimer) clearInterval(sampleTimer)
  if (app) {
    try {
      await app.evaluate(({ app }) => app.exit(0))
    } catch {
      /* exited */
    }
  }
  xvfb?.kill()
  server.closeAllConnections()
  server.close()
  report.failures = failures
  await writeFile(join(out, 'evidence.json'), JSON.stringify(report, null, 2))
}
if (failures.length && !process.env.FARIV_BASELINE) process.exitCode = 1
