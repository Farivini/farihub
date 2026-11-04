// Exercise the existing menu/renderer/main file-open path without changing it.
import { _electron as electron } from 'playwright-core'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
const [input, out] = process.argv.slice(2).map((x) => resolve(x))
await mkdir(out, { recursive: true })
let app
const xvfb = spawn(
  process.env.FARIV_TEST_XVFB,
  [':114', '-screen', '0', '1440x1000x24', '-ac', '-nolisten', 'unix', '-listen', 'tcp'],
  { env: process.env, stdio: 'ignore' },
)
await new Promise((r) => setTimeout(r, 700))
const report = {
  kind: 'Production open path; no source edits',
  bytes: (await stat(input)).size,
  platform: process.platform,
  sourceCommit: '24dafbd81376cfc5af51cb315fbb7fe55b523eff',
}
try {
  const profile = await mkdtemp(join(tmpdir(), 'fariv-bank-normal-'))
  app = await electron.launch({
    executablePath: process.env.ELECTRON_TEST_EXECUTABLE,
    args: ['--no-sandbox', '--disable-gpu', resolve('apps/sheets')],
    env: {
      ...process.env,
      DISPLAY: '127.0.0.1:114',
      GENOFFICE_USER_DATA: profile,
      GENOFFICE_LANG: 'pt',
      GENOFFICE_DEBUG_HOOKS: '1',
    },
    timeout: 60000,
  })
  const page = await app.firstWindow()
  await page.locator('.copilot textarea').waitFor({ timeout: 60000 })
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, input)
  await app.evaluate(({ Menu }) => {
    const find = (items) => {
      for (const i of items) {
        if (i.label?.includes('Abrir Pasta')) return i
        if (i.submenu) {
          const r = find(i.submenu.items)
          if (r) return r
        }
      }
    }
    find(Menu.getApplicationMenu().items).click()
  })
  await page.waitForFunction(
    () => document.body.innerText.includes('O arquivo excede o limite de tamanho'),
    null,
    { timeout: 30000 },
  )
  report.rejectedBySizeLimit = true
  report.observedMessage = 'O arquivo excede o limite de tamanho'
} catch (e) {
  report.failure = String(e)
  process.exitCode = 1
} finally {
  await writeFile(join(out, 'normal-open.json'), JSON.stringify(report, null, 2))
  console.log(report)
  if (app) await app.close().catch(() => {})
  xvfb.kill()
}
