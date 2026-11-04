/** Experimental adapter in the real Sheets renderer. Runs the candidate native
 * process from Electron's main process and paints at most 100 rows in Univer.
 * The production file-open, editing, undo and XLSX paths are NOT replaced.
 */
import { _electron as electron } from 'playwright-core'
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, mkdtemp, open } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { parseCsv, sniffDelimiter } from '../../packages/xlsx-gateway/src/gateway/csv-import.ts'
import { analyzeCsvColumns } from '../../packages/xlsx-gateway/src/gateway/csv-number-format.ts'

const [input, out, binary] = process.argv.slice(2).map((x) => resolve(x))
await mkdir(out, { recursive: true })
const f = await open(input, 'r')
const sample = Buffer.alloc(256 * 1024)
const { bytesRead } = await f.read(sample, 0, sample.length, 0)
await f.close()
let text = sample.subarray(0, bytesRead).toString('utf8')
text = text.slice(0, text.lastIndexOf('\n') + 1)
const delimiter = sniffDelimiter(text),
  typing = analyzeCsvColumns(parseCsv(text, delimiter), delimiter)
const report = {
  kind: 'EXPERIMENTAL native engine + 201-row window adapter in real Sheets; absolute source row labels and navigation control; production workflow unchanged',
  provider: 'No LLM used',
  input: {
    path: input,
    sha256: createHash('sha256')
      .update(await readFile(input))
      .digest('hex'),
  },
  stages: [],
  errors: [],
  samples: [],
  typing: typing.report,
}
const xvfb = process.env.FARIV_TEST_XVFB
  ? spawn(
      process.env.FARIV_TEST_XVFB,
      [':113', '-screen', '0', '1440x1000x24', '-ac', '-nolisten', 'unix', '-listen', 'tcp'],
      { env: process.env, stdio: 'ignore' },
    )
  : null
if (xvfb) await new Promise((r) => setTimeout(r, 700))
let app,
  page,
  timer,
  phase = 'startup'
function memory() {
  if (!app) return
  try {
    const all = []
    for (const id of readdirSync('/proc').filter((x) => /^\d+$/.test(x)))
      try {
        const s = readFileSync(`/proc/${id}/status`, 'utf8')
        all.push({
          pid: Number(id),
          ppid: Number(/^PPid:\s+(\d+)/m.exec(s)?.[1]),
          nsPid: Number(/^NSpid:\s+(.+)/m.exec(s)?.[1].trim().split(/\s+/).at(-1)),
          rss: Number(/^VmRSS:\s+(\d+)/m.exec(s)?.[1]) * 1024,
          name: /^Name:\s+(.+)/m.exec(s)?.[1],
        })
      } catch {}
    const root = all.find((p) => p.nsPid === app.process().pid)?.pid
    if (!root) throw Error('Could not map namespace PID')
    const own = new Set([root])
    let changed = true
    while (changed) {
      changed = false
      for (const p of all)
        if (own.has(p.ppid) && !own.has(p.pid)) {
          own.add(p.pid)
          changed = true
        }
    }
    const ps = all.filter((p) => own.has(p.pid))
    let pss = null
    if (report.samples.length % 4 === 0)
      try {
        pss = ps.reduce(
          (sum, p) =>
            sum +
            Number(
              /^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${p.pid}/smaps_rollup`, 'utf8'))?.[1],
            ) *
              1024,
          0,
        )
      } catch {}
    report.samples.push({
      phase,
      at: performance.now(),
      rss: ps.reduce((s, p) => s + p.rss, 0),
      pss,
      processes: ps,
    })
  } catch (e) {
    report.memoryError = String(e)
  }
}
async function beginMonitor() {
  await page.evaluate(() => {
    window.__liveMonitor = {
      raf: [],
      timer: [],
      longTasks: [],
      start: performance.now(),
      stopped: false,
    }
    const m = window.__liveMonitor
    let frame = performance.now(),
      tick = frame
    const next = (now) => {
      if (m.stopped) return
      m.raf.push(now - frame)
      frame = now
      requestAnimationFrame(next)
    }
    requestAnimationFrame(next)
    m.interval = setInterval(() => {
      const now = performance.now()
      m.timer.push(now - tick)
      tick = now
    }, 25)
    try {
      m.observer = new PerformanceObserver((list) =>
        m.longTasks.push(...list.getEntries().map((x) => x.duration)),
      )
      m.observer.observe({ entryTypes: ['longtask'] })
    } catch {}
  })
}
async function endMonitor() {
  return page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const m = window.__liveMonitor
    m.stopped = true
    clearInterval(m.interval)
    m.observer?.disconnect()
    return {
      raf: m.raf,
      timer: m.timer,
      longTasks: m.longTasks,
      elapsed: performance.now() - m.start,
    }
  })
}
async function request(req) {
  return app.evaluate((_, req) => globalThis.__million.request(req), req)
}
async function stage(name, fn) {
  console.log('STAGE', name)
  phase = name
  memory()
  await beginMonitor()
  const start = performance.now()
  try {
    const result = await fn()
    report.stages.push({ name, ms: performance.now() - start, result, ui: await endMonitor() })
    return result
  } catch (e) {
    report.stages.push({
      name,
      ms: performance.now() - start,
      error: String(e),
      ui: await endMonitor(),
    })
    throw e
  } finally {
    memory()
    phase = 'idle'
  }
}
async function paint(result, meta) {
  await page.evaluate(
    ({ result, meta }) => {
      const api = window.__genofficeDebug.univerAPI
      const workbook = api.getActiveWorkbook()
      let sheet = workbook.getSheets().find((s) => s.getSheetName() === 'Base — ensaio')
      if (!sheet) {
        workbook.insertSheet('Base — ensaio', {
          sheet: {
            rowCount: 201,
            columnCount: meta.columns.length + 2,
            defaultRowHeight: 24,
            defaultColumnWidth: 140,
          },
        })
        sheet = workbook.getSheets().find((s) => s.getSheetName() === 'Base — ensaio')
      }
      workbook.setActiveSheet(sheet)
      if (window.__millionPrevious) {
        const p = window.__millionPrevious
        sheet.getRange(p.start, 0, p.rows, p.columns).clearContent()
      }
      sheet
        .getRange(0, 0, 1, meta.columns.length + 1)
        .setValues([['Linha da fonte', ...meta.columns]])
      if (result.rows.length)
        sheet
          .getRange(1, 0, result.rows.length, result.rows[0].length + 1)
          .setValues(
            result.rows.map((r, i) =>
              [result.offset + i + 2, ...r].map((v) => ({
                v,
                t: typeof v === 'string' ? 1 : 2,
                f: null,
                si: null,
              })),
            ),
          )
      window.__millionPrevious = {
        start: 1,
        rows: result.rows.length,
        columns: (result.rows[0]?.length ?? 0) + 1,
      }
      sheet.getRange(1, 0).activate()
    },
    { result, meta },
  )
  const name = page.locator('[data-u-comp="defined-name"] input')
  await name.fill('A2')
  await name.press('Enter')
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  )
  const actual = await page.evaluate(
    ({ rows, columns }) =>
      window.__genofficeDebug.univerAPI
        .getActiveWorkbook()
        .getActiveSheet()
        .getRange(1, 0, rows, columns)
        .getRawValues(),
    { rows: result.rows.length, columns: result.rows[0].length + 1 },
  )
  for (let i = 0; i < result.rows.length; i++)
    for (let j = 0; j < actual[i].length; j++) {
      const expected = j === 0 ? result.offset + i + 2 : result.rows[i][j - 1],
        got = actual[i][j]
      if (
        typeof expected === 'number'
          ? typeof got !== 'number' || Math.abs(got - expected) > 1e-8
          : got !== expected
      )
        throw Error(
          `Rendered value mismatch at source row ${result.offset + i + 2}, col ${j}: ${JSON.stringify(got)} vs ${JSON.stringify(expected)}`,
        )
    }
  report.uiCellsChecked = (report.uiCellsChecked ?? 0) + result.rows.length * actual[0].length
}
try {
  const profile = await mkdtemp(join(tmpdir(), 'fariv-million-profile-'))
  app = await electron.launch({
    executablePath: process.env.ELECTRON_TEST_EXECUTABLE,
    args: ['--no-sandbox', '--disable-gpu', resolve('apps/sheets')],
    env: {
      ...process.env,
      DISPLAY: xvfb ? '127.0.0.1:113' : process.env.DISPLAY,
      GENOFFICE_USER_DATA: profile,
      GENOFFICE_LANG: 'pt',
      GENOFFICE_DEBUG_HOOKS: '1',
    },
    timeout: 60000,
  })
  page = await app.firstWindow()
  page.on('pageerror', (e) => report.errors.push(e.message))
  await page.locator('.copilot textarea').waitFor({ timeout: 60000 })
  // Boot a tiny real workbook to install the existing built-app Facade hooks.
  // The candidate data is subsequently painted into an added sheet, not into
  // the source's streamed sheet. This setup is excluded from stage timings.
  const boot = join(out, 'boot.csv')
  await writeFile(boot, 'nota;quantidade;preco_unitario_gbp\n1;2;1,50\n')
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, boot)
  await app.evaluate(({ Menu }) => {
    const find = (items) => {
      for (const x of items) {
        if (x.label?.includes('Abrir Pasta')) return x
        if (x.submenu) {
          const f = find(x.submenu.items)
          if (f) return f
        }
      }
    }
    find(Menu.getApplicationMenu().items).click()
  })
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
  await page.waitForTimeout(2000)
  timer = setInterval(memory, 50)
  await app.evaluate(
    (_, { binary, dir }) => {
      const child = process
        .getBuiltinModule('node:child_process')
        .spawn(binary, [dir, '512'], { stdio: ['pipe', 'pipe', 'pipe'] })
      let id = 0
      const pending = new Map()
      let stderr = ''
      child.stderr.on('data', (b) => (stderr = (stderr + String(b)).slice(-8000)))
      child.on('exit', (code) => {
        for (const p of pending.values()) p.reject(Error(`Native engine exited ${code}: ${stderr}`))
        pending.clear()
      })
      process
        .getBuiltinModule('node:readline')
        .createInterface({ input: child.stdout })
        .on('line', (line) => {
          const r = JSON.parse(line)
          const p = pending.get(r.id)
          if (!p) return
          pending.delete(r.id)
          r.ok ? p.resolve(r) : p.reject(Error(r.error))
        })
      globalThis.__million = {
        child,
        request: (params) =>
          new Promise((resolve, reject) => {
            const n = ++id
            const timer = setTimeout(() => {
              pending.delete(n)
              reject(Error('Native request timed out after 180 s'))
            }, 180000)
            pending.set(n, {
              resolve: (r) => {
                clearTimeout(timer)
                resolve(r)
              },
              reject: (e) => {
                clearTimeout(timer)
                reject(e)
              },
            })
            child.stdin.write(JSON.stringify({ ...params, id: n }) + '\n')
          }),
      }
    },
    { binary, dir: join(out, 'work') },
  )
  // This experiment has a declared arithmetic schema. Mixed identifier columns
  // remain text; production's per-cell mixed typing is deliberately not claimed.
  const numericColumns = ['quantidade', 'preco_unitario_gbp']
  report.appliedNumericSchema = numericColumns
  const meta = (
    await stage('import', async () => {
      let nativeDone = false
      const pending = request({
        op: 'open',
        path: input,
        delimiter,
        numericColumns,
        decimal: typing.report.decimal ?? '.',
      }).then((r) => {
        nativeDone = true
        return r
      })
      // Probe the actual composer during import; do not send a chat/model request.
      const start = performance.now()
      await page.locator('.copilot textarea').fill('Interface responde durante a importação')
      const inputMs = performance.now() - start
      const inputOverlapped = !nativeDone
      const r = await pending
      return { ...r, inputProbeMs: inputMs, inputCompletedBeforeEngine: inputOverlapped }
    })
  ).result
  report.metadata = meta
  report.rendererWindowRows = 201
  const first = await stage('first-viewport', async () => {
    const r = await request({ op: 'read', offset: 0, limit: 100 })
    await paint(r.result, meta)
    return r
  })
  // A real navigation control drives the candidate adapter. Absolute source
  // row numbers live in the first column; Univer itself keeps only 201 rows.
  await page.exposeFunction('farivReadWindow', async (offset) => {
    const r = await request({ op: 'read', offset, limit: 100 })
    await paint(r.result, meta)
    return { ...r.result, engineMs: r.engineMs }
  })
  await page.evaluate((n) => {
    const form = document.createElement('form')
    form.id = 'fariv-window-nav'
    form.setAttribute('aria-label', 'Navegação da base')
    form.style.cssText =
      'position:fixed;bottom:38px;left:60px;z-index:9999;padding:8px;display:flex;gap:8px;align-items:center;background:var(--surface);color:var(--text);border:1px solid var(--border)'
    form.innerHTML =
      '<label>Ir à linha da fonte <input id="fariv-window-row" type="number" min="2" value="2" aria-label="Linha da fonte"></label><button type="submit">Ir para linha</button><output id="fariv-window-status"></output>'
    const input = form.querySelector('input'),
      status = form.querySelector('output')
    input.max = String(n + 1)
    status.textContent = Number(n).toLocaleString('pt-BR') + ' registros'
    form.onsubmit = async (event) => {
      event.preventDefault()
      const offset = Math.max(0, Math.min(n - 100, Number(input.value) - 2))
      status.textContent = 'Carregando trecho…'
      window.__millionNav = null
      try {
        const result = await window.farivReadWindow(offset)
        window.__millionNav = result
        status.textContent = `Linhas ${offset + 2}–${offset + result.rows.length + 1} de ${n + 1}`
      } catch (e) {
        window.__millionNav = { error: String(e) }
        status.textContent = String(e)
      }
    }
    document.body.append(form)
  }, meta.rows)
  for (const offset of [Math.floor(meta.rows / 2), meta.rows - 100, 0, meta.rows - 100])
    await stage(`viewport-${offset}`, async () => {
      await page.locator('#fariv-window-row').fill(String(offset + 2))
      await page.locator('#fariv-window-nav button').click()
      await page.waitForFunction((offset) => window.__millionNav?.offset === offset, offset, {
        timeout: 30000,
      })
      const result = await page.evaluate(() => window.__millionNav)
      const displayed = await page.evaluate(() =>
        window.__genofficeDebug.univerAPI
          .getActiveWorkbook()
          .getActiveSheet()
          .getRange('A2')
          .getRawValue(),
      )
      if (displayed !== offset + 2)
        throw Error(`Viewport label mismatch: ${displayed} vs ${offset + 2}`)
      return {
        engineMs: result.engineMs,
        first: result.rows[0],
        last: result.rows.at(-1),
        displayedSourceRow: displayed,
      }
    })
  const calculation = await stage('calculate', async () => {
    let nativeDone = false
    const pending = request({
      op: 'calculate',
      left: 'quantidade',
      right: 'preco_unitario_gbp',
      name: 'valor_linha',
    }).then((r) => {
      nativeDone = true
      return r
    })
    const start = performance.now()
    await page.locator('.copilot textarea').fill('Interface responde durante o cálculo')
    const inputProbeMs = performance.now() - start
    const inputOverlapped = !nativeDone
    return { ...(await pending), inputProbeMs, inputCompletedBeforeEngine: inputOverlapped }
  })
  meta.columns.push('valor_linha')
  await stage('calculated-viewport', async () => {
    const r = await request({ op: 'read', offset: meta.rows - 100, limit: 100 })
    await paint(r.result, meta)
    return r
  })
  await stage('save-parquet', () => request({ op: 'save', path: join(out, 'base.parquet') }))
  await stage('reopen-parquet', () => request({ op: 'reopen', path: join(out, 'base.parquet') }))
  await stage('reopened-viewport', async () => {
    const r = await request({ op: 'read', offset: meta.rows - 100, limit: 100 })
    await paint(r.result, meta)
    return r
  })
  await stage('audit-export', () => request({ op: 'audit', path: join(out, 'audit.csv') }))
  report.calculation = calculation
  await page.screenshot({ path: join(out, 'million.png') })
} catch (e) {
  report.failure = String(e)
  console.error(e)
} finally {
  clearInterval(timer)
  memory()
  await writeFile(join(out, 'evidence.json'), JSON.stringify(report, null, 2))
  if (app) {
    await app.evaluate(() => globalThis.__million?.child.kill()).catch(() => {})
    await app.close().catch(() => {})
  }
  xvfb?.kill()
  console.log(
    'RESULT',
    report.failure ?? 'completed',
    report.stages.map((s) => ({
      name: s.name,
      ms: s.ms,
      maxFrameGapMs: Math.max(0, ...s.ui.raf),
      error: s.error,
    })),
  )
}

if (report.failure || report.errors.length) process.exitCode = 1
