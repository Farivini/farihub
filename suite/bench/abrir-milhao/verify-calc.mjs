/* global window, document, requestAnimationFrame */
/** Coluna calculada na base grande, no Planilhas real.
 *
 * Copia o CSV para uma pasta nova (o original nunca é tocado), abre pelo
 * menu e digita fórmulas em colunas vazias: cada uma preenche a coluna
 * inteira pelo motor. Confere valores na tela (início, meio, fim), recusa de
 * função ainda não suportada, recálculo depois de editar uma célula lida,
 * desfazer e refazer (da edição e da coluna), e salva. O CSV salvo é
 * conferido campo a campo por um oráculo independente em Python
 * (oraculo-coluna-calculada.py), que refaz cada fórmula sobre o original.
 *
 * Rodar a partir de suite/, com apps/sheets construído:
 *   xvfb-run -a node bench/abrir-milhao/verify-calc.mjs base.csv saida.json
 */
import { _electron as electron } from 'playwright-core'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdtemp, writeFile } from 'node:fs/promises'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const [file, outPath] = process.argv.slice(2)
const work = await mkdtemp(join(tmpdir(), 'fariv-calc-'))
const csv = join(work, 'base.csv')
await copyFile(resolve(file), csv)
const report = { stages: {}, frames: {}, memory: {}, checks: {} }
const failures = []
const check = (name, ok, detail) => {
  report.checks[name] = { passed: !!ok, ...(detail ?? {}) }
  if (!ok) failures.push(name)
  console.log(ok ? 'PASS' : 'FAIL', name, detail ? JSON.stringify(detail).slice(0, 400) : '')
}

function treePssMiB(rootPid) {
  const procs = []
  for (const id of readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    try {
      const s = readFileSync(`/proc/${id}/status`, 'utf8')
      procs.push({ pid: Number(id), ppid: Number(/^PPid:\s+(\d+)/m.exec(s)?.[1]) })
    } catch {}
  }
  const keep = new Set([rootPid])
  let grew = true
  while (grew) {
    grew = false
    for (const p of procs) {
      if (keep.has(p.pid) || !keep.has(p.ppid)) continue
      keep.add(p.pid)
      grew = true
    }
  }
  let pss = 0
  for (const pid of keep) {
    try {
      const m = /^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'))
      if (m) pss += Number(m[1])
    } catch {}
  }
  return Math.round(pss / 1024)
}

// the oracle's expected text for a few rows, before the app runs
const oracle = (saved, edits) =>
  JSON.parse(
    spawnSync(
      'python3',
      [
        '-I',
        join(here, 'oraculo-coluna-calculada.py'),
        resolve(file),
        saved,
        JSON.stringify(edits),
      ],
      { encoding: 'utf8', maxBuffer: 1 << 26 },
    ).stdout || '{}',
  )

const app = await electron.launch({
  args: [
    ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : []),
    resolve('apps/sheets'),
  ],
  env: {
    ...process.env,
    GENOFFICE_USER_DATA: await mkdtemp(join(tmpdir(), 'fariv-ud-')),
    GENOFFICE_LANG: 'pt',
    GENOFFICE_DEBUG_HOOKS: '1',
  },
  timeout: 60000,
})
const rootPid = app.process().pid
let peak = 0
const memTimer = setInterval(() => (peak = Math.max(peak, treePssMiB(rootPid))), 250)
let exitCode = 1
try {
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message))
  await page.locator('.copilot textarea').waitFor({ timeout: 60000 })
  await page.evaluate(() => {
    const w = window
    w.__gaps = { last: performance.now(), mark: 'idle', byMark: {} }
    const tick = (now) => {
      const g = w.__gaps
      g.byMark[g.mark] = Math.max(g.byMark[g.mark] ?? 0, now - g.last)
      g.last = now
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const mark = (m) => page.evaluate((m) => (window.__gaps.mark = m), m)
  const menu = (pattern) =>
    app.evaluate(({ Menu }, pattern) => {
      const find = (items) => {
        for (const item of items) {
          if (new RegExp(pattern).test(item.label ?? '')) return item
          const c = item.submenu && find(item.submenu.items)
          if (c) return c
        }
      }
      find(Menu.getApplicationMenu().items).click()
    }, pattern)
  const raw = (row, column) =>
    page.evaluate(
      ({ row, column }) =>
        window.__genofficeDebug.univerAPI
          .getActiveWorkbook()
          .getActiveSheet()
          .getSheet()
          .getCellRaw(row, column)?.v ?? null,
      { row, column },
    )
  const nameBox = page.locator('[data-u-comp="defined-name"] input')
  const goTo = async (address) => {
    await nameBox.click()
    await nameBox.fill(address)
    await nameBox.press('Enter')
    await page.waitForTimeout(700)
  }
  const waitRaw = async (row, column, accept, timeout = 15000) => {
    const deadline = Date.now() + timeout
    let value = await raw(row, column)
    while (!accept(value) && Date.now() < deadline) {
      await page.waitForTimeout(100)
      value = await raw(row, column)
    }
    return value
  }
  const typeAt = async (address, text) => {
    await goTo(address)
    await page.keyboard.type(text)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)
  }
  const bodyText = () => page.locator('body').innerText()
  const waitText = async (pattern, timeout = 120000) => {
    await page.waitForFunction(
      (source) => new RegExp(source).test(document.body.innerText),
      pattern,
      {
        timeout,
      },
    )
  }
  const close = (a, b) =>
    typeof a === 'number' && typeof b === 'number'
      ? Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b))
      : a === b

  // ---- abrir ----
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
  }, csv)
  const t0 = performance.now()
  await menu('^Abrir')
  await page.waitForFunction(
    () => {
      try {
        return (
          window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getMaxRows() > 1000
        )
      } catch {
        return false
      }
    },
    null,
    { timeout: 300000 },
  )
  report.stages.openMs = Math.round(performance.now() - t0)
  await page.waitForTimeout(2000)
  const rows = await page.evaluate(() =>
    window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet().getMaxRows(),
  )
  const last = rows - 1
  const mid = Math.floor(rows / 2)

  // the expected values come from the oracle over the original, no edits
  const before = oracle(resolve(file), {}).sample
  const expect = (row, column) => {
    const text = before?.[String(row)]?.[String(column)]
    if (text === undefined) return undefined
    return /^-?[0-9]+(\.[0-9]+)?$/.test(text) ? Number(text) : text
  }

  // ---- colunas calculadas ----
  const headers = {
    J: 'Imposto',
    K: 'Acumulado',
    L: 'Total cidade',
    M: 'Ocorrência',
    N: 'Situação',
    O: 'Primeiro valor',
  }
  const formulas = {
    J: '=I2*0.18',
    K: '=SUM($I$2:I2)',
    L: '=SUMIF(E:E,E2,I:I)',
    M: '=COUNTIF($B$2:B2,B2)',
    N: '=IF(I2>F2,"acima","ok")',
    O: `=VLOOKUP(B2,$B$2:$I$${rows},8,FALSE)`,
  }
  report.stages.createMs = {}
  for (const [letter, formula] of Object.entries(formulas)) {
    await mark(`create${letter}`)
    await typeAt(`${letter}1`, headers[letter])
    const started = performance.now()
    await typeAt(`${letter}2`, formula)
    await waitText(`Coluna ${letter} calculada`)
    report.stages.createMs[letter] = Math.round(performance.now() - started)
  }
  // on screen: first, middle and last rows of every column
  const sampled = {}
  let screenOk = true
  for (const [row, label] of [
    [1, 'primeira'],
    [mid, 'meio'],
    [last, 'ultima'],
  ]) {
    for (const [index, letter] of ['J', 'K', 'L', 'M', 'N', 'O'].entries()) {
      const column = 9 + index
      await goTo(`${letter}${row + 1}`)
      const want = expect(row, column)
      const got = await waitRaw(row, column, (v) => close(v, want))
      sampled[`${letter}${row + 1}`] = { got, want }
      if (!close(got, want)) screenOk = false
    }
    void label
  }
  check('colunas_na_tela', screenOk, sampled)

  // unsupported function: refused, cell empty
  await mark('refused')
  await typeAt('P2', '=TEXT(I2,"0")')
  await page.waitForTimeout(800)
  const refused = /A função TEXT ainda não roda/.test(await bodyText())
  check('funcao_nao_suportada_recusada', refused && (await raw(1, 15)) === null, {
    aviso: refused,
    p2: await raw(1, 15),
  })

  // ---- recálculo: editar I3 refaz J3 (linha) e K3 em diante (acumulado) ----
  await mark('refresh')
  await goTo('I3')
  const i3 = Number((await raw(2, 8)) ?? 0)
  const k3Before = expect(2, 10)
  const tr = performance.now()
  await typeAt('I3', '1000')
  await goTo('J3')
  const j3 = await waitRaw(2, 9, (v) => close(v, 180))
  report.stages.refreshRowMs = Math.round(performance.now() - tr)
  await goTo('K3')
  const k3 = await waitRaw(2, 10, (v) => close(v, k3Before - i3 + 1000), 60000)
  report.stages.refreshRunningMs = Math.round(performance.now() - tr)
  check('recalculo_depois_de_editar', close(j3, 180) && close(k3, k3Before - i3 + 1000), {
    j3,
    k3,
    k3Esperado: k3Before - i3 + 1000,
  })
  // undo the edit: both come back
  await page.mouse.click(900, 400)
  await goTo('J3')
  await page.keyboard.press('Control+z')
  const j3Undone = await waitRaw(2, 9, (v) => close(v, expect(2, 9)), 60000)
  check('desfazer_edicao_refaz_calculo', close(j3Undone, expect(2, 9)), {
    j3: j3Undone,
    esperado: expect(2, 9),
  })
  await page.waitForTimeout(3000)

  // ---- desfazer e refazer a coluna O ----
  await mark('undoCalc')
  // the last steps on the stack: the O formula, then the edit of I3 (undone)
  await goTo('O2')
  await page.keyboard.press('Control+z')
  const oUndone = await waitRaw(1, 14, (v) => v === null, 30000)
  await page.keyboard.press('Control+y')
  const oRedone = await waitRaw(1, 14, (v) => close(v, expect(1, 14)), 30000)
  check('desfazer_refazer_coluna', oUndone === null && close(oRedone, expect(1, 14)), {
    desfeito: oUndone,
    refeito: oRedone,
  })

  // ---- uma edição que fica: I5 = 2000 ----
  await typeAt('I5', '2000')
  await goTo('J5')
  check('edicao_que_fica', close(await waitRaw(4, 9, (v) => close(v, 360)), 360), {
    j5: await raw(4, 9),
  })
  await page.waitForTimeout(4000)

  // ---- salvar e conferir com o oráculo ----
  await mark('save')
  const ts = performance.now()
  const savedBefore = statSync(csv).mtimeMs
  await menu('^Salvar$')
  for (let i = 0; i < 1200 && statSync(csv).mtimeMs === savedBefore; i++) {
    await page.waitForTimeout(100)
  }
  report.stages.saveMs = Math.round(performance.now() - ts)
  await page.waitForTimeout(2000)
  const edits = { '4:8': '2000' }
  for (const [index, letter] of ['J', 'K', 'L', 'M', 'N', 'O'].entries()) {
    edits[`0:${9 + index}`] = headers[letter]
  }
  const verdict = oracle(csv, edits)
  report.oracle = verdict
  check(
    'csv_salvo_igual_ao_oraculo',
    verdict.diffs === 0 && verdict.rows_saved === verdict.rows_orig,
    {
      fields: verdict.fields,
      diffs: verdict.diffs,
      first: verdict.first,
      warnings: verdict.warnings,
    },
  )
  report.stages.csvBytes = statSync(csv).size
  report.frames = await page.evaluate(() => window.__gaps.byMark)
  exitCode = failures.length === 0 ? 0 : 1
} catch (error) {
  report.error = String(error?.stack ?? error).slice(0, 2000)
  console.log('ERROR', report.error)
} finally {
  clearInterval(memTimer)
  report.memory.peakMiB = peak
  report.failures = failures
  report.savedCsv = csv
  await writeFile(outPath, JSON.stringify(report, null, 1))
  console.log(
    JSON.stringify(
      { stages: report.stages, frames: report.frames, memory: report.memory, failures },
      null,
      1,
    ),
  )
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
  process.exit(exitCode)
}
