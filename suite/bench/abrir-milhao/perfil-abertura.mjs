/* global window */
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const [file, out] = process.argv.slice(2)
const app = await electron.launch({
  args: ['--no-sandbox', '--disable-gpu', resolve('apps/sheets')],
  env: {
    ...process.env,
    GENOFFICE_USER_DATA: mkdtempSync(join(tmpdir(), 'x')),
    GENOFFICE_LANG: 'pt',
    GENOFFICE_DEBUG_HOOKS: '1',
  },
})
const page = await app.firstWindow()
await page.locator('.copilot textarea').waitFor({ timeout: 60000 })
await page.waitForTimeout(1500)
const cdp = await page.context().newCDPSession(page)
await cdp.send('Profiler.enable')
await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
await cdp.send('Profiler.start')
await page.evaluate(() => {
  const w = window
  w.__long = []
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) w.__long.push([Math.round(e.startTime), Math.round(e.duration)])
  }).observe({ type: 'longtask', buffered: false })
})
await app.evaluate(({ dialog }, p) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
}, resolve(file))
const t0 = await page.evaluate(() => performance.now())
await app.evaluate(({ Menu }) => {
  const f = (it) => {
    for (const i of it) {
      if (/^Abrir/.test(i.label ?? '')) return i
      const c = i.submenu && f(i.submenu.items)
      if (c) return c
    }
  }
  f(Menu.getApplicationMenu().items).click()
})
await page.waitForTimeout(7000)
const { profile } = await cdp.send('Profiler.stop')
const longs = await page.evaluate(() => window.__long)
console.log(
  'long tasks (start rel ms, dur):',
  longs.map(([s, d]) => [s - Math.round(t0), d]).filter(([, d]) => d > 50),
)
// self time by function+url
const byId = new Map(profile.nodes.map((n) => [n.id, n]))
const self = new Map()
const dt = profile.timeDeltas
for (let i = 0; i < profile.samples.length; i++) {
  const n = byId.get(profile.samples[i])
  const cf = n.callFrame
  const key = `${cf.functionName || '(anon)'} ${cf.url.split('/').pop()}:${cf.lineNumber}`
  self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000)
}
console.log(
  [...self]
    .filter(([k]) => !k.startsWith('(idle)') && !k.startsWith('(program)'))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([k, v]) => `${v.toFixed(0)}ms ${k}`)
    .join('\n'),
)
writeFileSync(out, JSON.stringify(profile))
await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
process.exit(0)
