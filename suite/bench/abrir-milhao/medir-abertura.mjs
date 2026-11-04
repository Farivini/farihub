/* global window, requestAnimationFrame */
/** Abre um arquivo pelo menu normal do Planilhas real e mede: tempo até a
 * primeira célula, pausas entre quadros, memória somada da árvore do app e
 * navegação (Ctrl+End, Ctrl+Home, rolagem). Rodar a partir de suite/:
 *   xvfb-run -a node bench/abrir-milhao/probe.mjs ARQUIVO SAIDA.json [A1_ESPERADO]
 */
import { _electron as electron } from 'playwright-core'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const [file, outPath, a1Expected] = process.argv.slice(2)
const input = resolve(file)
const report = { input, stages: {}, memory: [], frames: {}, checks: {} }
const userData = await mkdtemp(join(tmpdir(), 'fariv-probe-'))

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
    for (const p of procs)
      if (!keep.has(p.pid) && keep.has(p.ppid)) {
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

const app = await electron.launch({
  args: [
    ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : []),
    resolve('apps/sheets'),
  ],
  env: {
    ...process.env,
    GENOFFICE_USER_DATA: userData,
    GENOFFICE_LANG: 'pt',
    GENOFFICE_DEBUG_HOOKS: '1',
  },
  timeout: 60000,
})
const rootPid = app.process().pid
let peak = 0
const memTimer = setInterval(() => {
  const v = treePssMiB(rootPid)
  peak = Math.max(peak, v)
  report.memory.push(v)
}, 250)
const page = await app.firstWindow()
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message))
page.on('console', (m) => m.type() === 'error' && console.log('CONSOLE', m.text().slice(0, 300)))
await page.locator('.copilot textarea').waitFor({ timeout: 60000 })
await page.evaluate(() => {
  const w = window
  w.__gaps = { max: 0, over100: 0, over300: 0, last: performance.now(), mark: 'idle', byMark: {} }
  const tick = (t) => {
    const g = w.__gaps
    const d = t - g.last
    g.last = t
    if (d > g.max) g.max = d
    g.byMark[g.mark] = Math.max(g.byMark[g.mark] ?? 0, d)
    if (d > 100) g.over100++
    if (d > 300) g.over300++
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})
const mark = (m) => page.evaluate((m) => (window.__gaps.mark = m), m)
const baseline = treePssMiB(rootPid)
report.memoryBeforeOpenMiB = baseline
await app.evaluate(({ dialog }, p) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
}, input)
await mark('open')
const t0 = performance.now()
await app.evaluate(({ Menu }) => {
  const find = (items) => {
    for (const item of items) {
      if (/Abrir Pasta|Abrir/i.test(item.label ?? '')) return item
      const c = item.submenu && find(item.submenu.items)
      if (c) return c
    }
  }
  find(Menu.getApplicationMenu().items).click()
})
try {
  await page.waitForFunction(
    (exp) => {
      const v = window.__genofficeDebug?.univerAPI
        .getActiveWorkbook()
        ?.getActiveSheet()
        ?.getRange('A1')
        .getValue()
      return exp ? v === exp : v !== undefined && v !== null && v !== ''
    },
    a1Expected ?? null,
    { timeout: 40000 },
  )
  report.stages.openToFirstCellMs = Math.round(performance.now() - t0)
} catch (e) {
  report.stages.openError = String(e).slice(0, 300)
  const body = await page
    .locator('body')
    .innerText()
    .catch(() => '')
  report.stages.screenText = body.slice(0, 800)
}
await page.waitForTimeout(1500)
report.stages.sheet = await page.evaluate(() => {
  const s = window.__genofficeDebug?.univerAPI.getActiveWorkbook()?.getActiveSheet()
  return s
    ? { rows: s.getMaxRows(), columns: s.getMaxColumns(), a1: s.getRange('A1').getValue() }
    : null
})
await mark('ctrlEnd')
const t1 = performance.now()
await page.keyboard.press('Control+End')
await page.waitForTimeout(2500)
report.stages.ctrlEnd = await page.evaluate(() => {
  const r = window.__genofficeDebug?.univerAPI
    .getActiveWorkbook()
    ?.getActiveSheet()
    ?.getSelection()
    ?.getActiveRange()
  return r ? { row: r.getRow(), column: r.getColumn(), value: r.getValue() } : null
})
report.stages.ctrlEndWaitMs = Math.round(performance.now() - t1)
await mark('ctrlHome')
await page.keyboard.press('Control+Home')
await page.waitForTimeout(1500)
await mark('wheel')
for (let i = 0; i < 40; i++) {
  await page.mouse.move(600, 500)
  await page.mouse.wheel(0, 3000)
  await page.waitForTimeout(30)
}
await page.waitForTimeout(1500)
report.frames = await page.evaluate(() => window.__gaps)
report.memoryPeakMiB = peak
report.memoryAfterMiB = treePssMiB(rootPid)
clearInterval(memTimer)
report.memory = undefined
await writeFile(outPath, JSON.stringify(report, null, 1))
console.log(JSON.stringify(report, null, 1))
await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
process.exit(0)
