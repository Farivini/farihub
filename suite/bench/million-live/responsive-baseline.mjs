// App baseline on PR12. No production changes; scripted provider, real Electron/sidecar.
import { _electron as electron } from 'playwright-core'
import { readFile, writeFile, mkdir, mkdtemp, stat } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { startScriptedModel, useScriptedModel } from '../../e2e/fariv-review-helpers.ts'
const [csv, output, countArg] = process.argv.slice(2)
const n = Number(countArg),
  last = n + 1
await mkdir(output, { recursive: true })
const report = {
  commit: '24dafbd81376cfc5af51cb315fbb7fe55b523eff',
  platform: process.platform,
  electron: '38.0.0 (test runtime, production dependency is 43.8.3)',
  provider: 'SIMULATED, no real model',
  scope: 'Standalone Sheets, production renderer + native sidecar, automated file picker',
  input: {
    records: n,
    bytes: (await stat(csv)).size,
    sha256: createHash('sha256')
      .update(await readFile(csv))
      .digest('hex'),
  },
  stages: {},
  toolResults: [],
  samples: [],
  errors: [],
}
let app,
  phase = 'launch',
  sampler,
  samplingError
const xvfb = spawn(
  process.env.FARIV_TEST_XVFB || '/usr/bin/Xvfb',
  [':111', '-screen', '0', '1440x1000x24', '-ac', '-nolisten', 'unix', '-listen', 'tcp'],
  { env: process.env, stdio: 'ignore' },
)
await new Promise((r) => setTimeout(r, 700))
const sample = () => {
  if (!app) return
  const root = app.process().pid
  const all = new Map()
  try {
    for (const pid of readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
      try {
        const s = readFileSync(`/proc/${pid}/status`, 'utf8')
        const ppid = Number(/^PPid:\s+(\d+)/m.exec(s)?.[1])
        const rss = Number(/^VmRSS:\s+(\d+)/m.exec(s)?.[1]) * 1024
        const nsPid = Number(/^NSpid:\s+(.+)/m.exec(s)?.[1]?.trim().split(/\s+/).at(-1))
        all.set(Number(pid), {
          pid: Number(pid),
          nsPid,
          ppid,
          rss,
          name: /^Name:\s+(.+)/m.exec(s)?.[1],
        })
      } catch {}
    }
    const rootPid = [...all.values()].find((p) => p.nsPid === root)?.pid
    if (!rootPid) throw Error('Root PID could not be mapped through NSpid')
    const owned = new Set([rootPid])
    let changed = true
    while (changed) {
      changed = false
      for (const p of all.values())
        if (owned.has(p.ppid) && !owned.has(p.pid)) {
          owned.add(p.pid)
          changed = true
        }
    }
    const processes = [...owned].map((pid) => all.get(pid)).filter(Boolean)
    let pssBytes = null
    if (report.samples.length % 4 === 0) {
      let sum = 0,
        complete = true
      for (const p of processes)
        try {
          const rollup = readFileSync(`/proc/${p.pid}/smaps_rollup`, 'utf8')
          const match = /^Pss:\s+(\d+)/m.exec(rollup)
          if (!match) complete = false
          else sum += Number(match[1]) * 1024
        } catch {
          complete = false
        }
      if (complete) pssBytes = sum
    }
    report.samples.push({
      atMs: performance.now(),
      phase,
      rssBytes: processes.reduce((a, p) => a + p.rss, 0),
      pssBytes,
      processes,
    })
  } catch (e) {
    samplingError = String(e)
  }
}
async function stage(name, fn) {
  console.log('STAGE', name, new Date().toISOString())
  if (page)
    await page.evaluate(() => {
      const m = (window.__responsiveness = { frames: [], ticks: [], longTasks: [], stopped: false })
      let frame = performance.now(),
        tick = frame
      const next = (now) => {
        if (m.stopped) return
        m.frames.push(now - frame)
        frame = now
        requestAnimationFrame(next)
      }
      requestAnimationFrame(next)
      m.interval = setInterval(() => {
        const now = performance.now()
        m.ticks.push(now - tick)
        tick = now
      }, 25)
      try {
        m.observer = new PerformanceObserver((list) =>
          m.longTasks.push(...list.getEntries().map((x) => x.duration)),
        )
        m.observer.observe({ entryTypes: ['longtask'] })
      } catch {}
    })
  phase = name
  sample()
  const start = performance.now()
  try {
    const detail = await fn()
    report.stages[name] = { ok: true, ms: performance.now() - start, detail }
    return detail
  } catch (e) {
    report.stages[name] = { ok: false, ms: performance.now() - start, error: String(e) }
    throw e
  } finally {
    if (page && name !== 'launch')
      report.stages[name].ui = await page.evaluate(async () => {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        const m = window.__responsiveness
        m.stopped = true
        clearInterval(m.interval)
        m.observer?.disconnect()
        return { frames: m.frames, ticks: m.ticks, longTasks: m.longTasks }
      })
    sample()
    phase = 'idle'
  }
}
async function menu(pattern) {
  await app.evaluate(({ Menu }, pattern) => {
    const find = (items) => {
      for (const x of items) {
        if (x.label?.match(new RegExp(pattern))) return x
        if (x.submenu) {
          const f = find(x.submenu.items)
          if (f) return f
        }
      }
    }
    const item = find(Menu.getApplicationMenu().items)
    if (!item) throw Error(`Menu ${pattern} missing`)
    item.click()
  }, pattern)
}
const { server, port } = await startScriptedModel((run) => {
  const id = /id=([^,)\s]+)/.exec(run.toolResults[0] ?? '')?.[1]
  const steps = [
    { tool: 'get_workbook_context', args: {} },
    { tool: 'load_guide', args: { guides: ['writing'] } },
    { tool: 'read_range', args: { range: 'A1:H3', sheetId: id } },
    {
      tool: 'propose_operations',
      args: {
        summary: `Coluna calculada ${n} linhas`,
        operations: [
          { op: 'set_cell', sheetId: id, address: 'I1', value: 'valor_linha' },
          { op: 'set_formula', sheetId: id, address: 'I2', formula: '=D2*F2' },
          { op: 'fill_range', sheetId: id, source: 'I2', target: `I2:I${last}` },
        ],
      },
    },
  ]
  report.toolResults = run.toolResults
  return steps[run.toolResults.length] ?? { text: 'Teste concluído.' }
})
const userData = await mkdtemp(join(tmpdir(), 'fariv-baseline-'))
await useScriptedModel(userData, port)
let page
try {
  await stage('launch', async () => {
    app = await electron.launch({
      executablePath: process.env.ELECTRON_TEST_EXECUTABLE,
      args: ['--no-sandbox', '--disable-gpu', resolve('apps/sheets')],
      env: {
        ...process.env,
        GENOFFICE_USER_DATA: userData,
        GENOFFICE_LANG: 'pt',
        GENOFFICE_DEBUG_HOOKS: '1',
      },
      timeout: 60000,
    })
    sampler = setInterval(sample, 50)
    page = await app.firstWindow()
    page.on('pageerror', (e) => report.errors.push(e.message))
    await page.locator('.copilot textarea').waitFor({ timeout: 60000 })
  })
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, resolve(csv))
  const opened = await stage('open', async () => {
    await menu('Abrir Pasta')
    const deadline = Date.now() + 90000
    while (Date.now() < deadline) {
      const state = await page.evaluate(() => ({
        opened:
          window.__genofficeDebug?.univerAPI
            .getActiveWorkbook()
            ?.getActiveSheet()
            ?.getRange('A1')
            .getValue() === 'nota',
        text: document.body.innerText.slice(-2200),
      }))
      if (state.opened) return state
      if (
        /32\s*MB|muito grande|too large|grande demais|excede.*limite|exceeds.*limit|limite.*tamanho|ultrapassa.*limite/i.test(
          state.text,
        )
      )
        return state
      await page.waitForTimeout(100)
    }
    throw Error('Open timeout after 90 s: ' + (await page.locator('body').innerText()).slice(-1500))
  })
  if (!opened.opened) {
    report.blocked = 'CSV import limit'
    await page.screenshot({ path: join(output, 'blocked.png') })
  } else {
    await page.waitForTimeout(1200)
    report.idleRss = report.samples.at(-1)
    await stage('scroll', async () => {
      const name = page.locator('[data-u-comp="defined-name"] input')
      await name.fill(`A${last}`)
      await name.press('Enter')
      await page.waitForFunction(
        ({ last }) =>
          window.__genofficeDebug?.univerAPI
            .getActiveWorkbook()
            .getActiveSheet()
            .getRange(`D${last}`)
            .getRawValue() != null,
        { last },
        { timeout: 20000 },
      )
      return page.evaluate((last) => {
        const s = window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet()
        return {
          address: `D${last}`,
          quantity: s.getRange(`D${last}`).getRawValue(),
          price: s.getRange(`F${last}`).getRawValue(),
        }
      }, last)
    })
    await stage('calculate', async () => {
      const composer = page.locator('.copilot textarea')
      await composer.fill(
        `Acrescente valor_linha com fórmula editável quantidade × preco_unitario_gbp nas ${n} linhas, até I${last}.`,
      )
      await composer.press('Enter')
      const deadline = Date.now() + 60000
      while (Date.now() < deadline) {
        if (await page.locator('.ai-review-card[data-review="pending"]').count())
          return { applied: true }
        if (
          report.toolResults.length >= 4 &&
          /^(Error:|Rejected)/i.test(report.toolResults.at(-1) ?? '')
        )
          return { applied: false, result: report.toolResults.at(-1) }
        await page.waitForTimeout(100)
      }
      throw Error('No review or tool result after 60 s')
    })
    if (report.stages.calculate.detail.applied) {
      await page.waitForTimeout(600)
      report.audit = await page.evaluate((n) => {
        const s = window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet()
        const v = s.getRange(`I2:I${n + 1}`).getRawValues()
        const f = s.getRange(`I2:I${n + 1}`).getFormulas()
        const q = s.getRange(`D2:D${n + 1}`).getRawValues()
        const p = s.getRange(`F2:F${n + 1}`).getRawValues()
        let errors = 0
        for (let i = 0; i < n; i++)
          if (
            f[i]?.[0]?.replace(/^=/, '') !== `D${i + 2}*F${i + 2}` ||
            Math.abs(v[i]?.[0] - q[i]?.[0] * p[i]?.[0]) > 1e-8 ||
            typeof v[i]?.[0] !== 'number'
          )
            errors++
        return {
          rows: n,
          errors,
          first: { formula: f[0]?.[0], value: v[0]?.[0] },
          last: { formula: f.at(-1)?.[0], value: v.at(-1)?.[0] },
        }
      }, n)
      await page.locator('.ai-review-card').last().locator('.ai-review-accept').click()
    }
    const saved = resolve(output, 'saved.xlsx')
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
    }, saved)
    await stage('save', async () => {
      await menu('Salvar Como')
      const deadline = Date.now() + 90000
      while (Date.now() < deadline) {
        try {
          const s = await stat(saved)
          if (s.size > 0)
            return { bytes: s.size, calculated: report.stages.calculate.detail.applied }
        } catch {}
        await page.waitForTimeout(100)
      }
      throw Error('Save timeout')
    })
    await page.screenshot({ path: join(output, 'result.png') })
  }
} catch (e) {
  report.failure = String(e)
  console.error(e)
} finally {
  clearInterval(sampler)
  sample()
  report.samplingError = samplingError
  for (const [name, s] of Object.entries(report.stages)) {
    const rows = report.samples.filter((x) => x.phase === name)
    s.peakRssBytes = rows.length ? Math.max(...rows.map((x) => x.rssBytes)) : null
  }
  const peaks = report.samples.filter((x) => x.rssBytes > 0).sort((a, b) => b.rssBytes - a.rssBytes)
  report.overallPeak = peaks[0]
  report.sampleCount = report.samples.length
  await writeFile(join(output, 'evidence.json'), JSON.stringify(report, null, 2))
  console.log(
    JSON.stringify(
      {
        records: n,
        stages: report.stages,
        audit: report.audit,
        blocked: report.blocked,
        failure: report.failure,
        peak: report.overallPeak,
      },
      null,
      2,
    ),
  )
  if (app) await app.close().catch(() => {})
  server.close()
  xvfb.kill()
}

if (report.failure || report.errors.length) process.exitCode = 1
