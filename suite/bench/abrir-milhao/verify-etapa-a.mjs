/* global window, document, requestAnimationFrame */
/** Etapa A: nada trava na base grande.
 *
 * Planilhas real, base aberta pelo menu (numa cópia). Mede a maior pausa da
 * tela e confere o resultado de cada ação que travava no teste do Windows:
 * selecionar até o fim (Ctrl+Shift+→/↓) com a barra de status, copiar a base
 * inteira, apagar uma coluna inteira e desfazer, apagar e salvar, apagar uma
 * coluna calculada inteira e desfazer. Os arquivos salvos são conferidos em
 * Python contra o original.
 *
 *   xvfb-run -a node bench/abrir-milhao/verify-etapa-a.mjs base.csv saida.json
 */
import { _electron as electron } from 'playwright-core'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdtemp, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const [file, outPath] = process.argv.slice(2)
const work = await mkdtemp(join(tmpdir(), 'fariv-etapa-a-'))
const csv = join(work, 'base.csv')
await copyFile(resolve(file), csv)
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const originalSha = sha(csv)
const report = { steps: {}, checks: {} }
const failures = []
const check = (name, ok, detail) => {
  report.checks[name] = { passed: !!ok, ...(detail ?? {}) }
  if (!ok) failures.push(name)
  console.log(ok ? 'PASS' : 'FAIL', name, detail ? JSON.stringify(detail).slice(0, 300) : '')
}
const python = (code, ...args) =>
  JSON.parse(
    spawnSync('python3', ['-I', '-c', code, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 })
      .stdout || '{}',
  )
const READ = `
import csv,io,json,sys
def rows(p):
    d=open(p,'rb').read()
    if d.startswith(b'\\xef\\xbb\\xbf'): d=d[3:]
    return list(csv.reader(io.StringIO(d.decode('utf-8'),newline='')))
`
const original = python(
  READ +
    "r=rows(sys.argv[1])\nprint(json.dumps({'rows':len(r),'nonEmpty':sum(1 for x in r for v in x if v!='')}))",
  csv,
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
let exitCode = 1
try {
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message))
  await page.locator('.copilot textarea').waitFor({ timeout: 60000 })
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
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
  }, csv)
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
  await page.waitForTimeout(3000)
  await page.evaluate(() => {
    window.__gap = { last: performance.now(), max: 0 }
    const tick = (now) => {
      window.__gap.max = Math.max(window.__gap.max, now - window.__gap.last)
      window.__gap.last = now
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const nameBox = page.locator('[data-u-comp="defined-name"] input')
  const goTo = async (address) => {
    await nameBox.click()
    await nameBox.fill(address)
    await nameBox.press('Enter')
    await page.waitForTimeout(700)
  }
  const raw = (r, c) =>
    page.evaluate(
      ({ r, c }) =>
        window.__genofficeDebug.univerAPI
          .getActiveWorkbook()
          .getActiveSheet()
          .getSheet()
          .getCellRaw(r, c)?.v ?? null,
      { r, c },
    )
  const step = async (name, run, settleMs = 3000) => {
    await page.evaluate(() => {
      window.__gap.max = 0
      window.__gap.last = performance.now()
    })
    const started = performance.now()
    await run()
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())))
    const responsiveMs = Math.round(performance.now() - started)
    await page.waitForTimeout(settleMs)
    const maxGapMs = Math.round(await page.evaluate(() => window.__gap.max))
    report.steps[name] = { responsiveMs, maxGapMs }
    console.log(name, responsiveMs, 'ms; pausa máxima', maxGapMs, 'ms')
  }
  const save = async () => {
    const before = statSync(csv).mtimeMs
    await menu('^Salvar$')
    for (let i = 0; i < 1200 && statSync(csv).mtimeMs === before; i++)
      await page.waitForTimeout(100)
    await page.waitForTimeout(1500)
  }
  const rows = original.rows
  const last = rows - 1

  // ---- selecionar até o fim, barra de status pelo motor ----
  await goTo('A1')
  await step('ctrlShiftRight', () => page.keyboard.press('Control+Shift+ArrowRight'))
  await step('ctrlShiftDown', () => page.keyboard.press('Control+Shift+ArrowDown'), 6000)
  const status = (await page.locator('body').innerText()).match(/Contagem: [\d.,]+/)?.[0] ?? ''
  const shown = Number(status.replace(/\D/g, ''))
  check('barra_de_status_conta_a_base_inteira', shown === original.nonEmpty, {
    barra: status,
    esperado: original.nonEmpty,
  })

  // ---- copiar a base inteira ----
  await step('copiar', () => page.keyboard.press('Control+c'), 8000)
  const clip = await app.evaluate(({ clipboard }) => {
    const text = clipboard.readText()
    const lines = text.split('\n')
    return { chars: text.length, lines: lines.length, first: lines[0], last: lines.at(-1) }
  })
  const ends = python(
    READ +
      "r=rows(sys.argv[1])\nprint(json.dumps({'first':'\\t'.join(r[0]),'last':'\\t'.join(r[-1])}))",
    csv,
  )
  check(
    'copiar_traz_todas_as_linhas',
    clip.lines === rows && clip.first === ends.first && clip.last === ends.last,
    {
      linhas: clip.lines,
      caracteres: clip.chars,
    },
  )

  // ---- apagar a coluna C inteira e desfazer, antes de salvar ----
  await goTo('C1:C1048568')
  await step('apagarColuna', () => page.keyboard.press('Delete'))
  const afterDelete = await raw(last, 2)
  await step('desfazerApagar', () => page.keyboard.press('Control+z'))
  const afterUndo = await raw(last, 2)
  await save()
  check(
    'apagar_e_desfazer_volta_o_arquivo_identico',
    sha(csv) === originalSha && afterDelete === null && afterUndo !== null,
    {
      telaDepoisDeApagar: afterDelete,
      telaDepoisDeDesfazer: afterUndo,
    },
  )

  // ---- apagar e salvar: só a coluna C fica vazia ----
  await goTo('C1:C1048568')
  await page.keyboard.press('Delete')
  await page.waitForTimeout(2000)
  await save()
  const cleared = python(
    READ +
      "a=rows(sys.argv[1]);b=rows(sys.argv[2])\nbad=sum(1 for x,y in zip(a,b) if (x[:2]+x[3:])!=(y[:2]+y[3:]) or (len(y)>2 and y[2]!=''))\nprint(json.dumps({'rows':len(b),'bad':bad}))",
    resolve(file),
    csv,
  )
  check('apagar_e_salvar_esvazia_so_a_coluna', cleared.rows === rows && cleared.bad === 0, cleared)

  // ---- apagar uma coluna calculada inteira e desfazer ----
  await goTo('J2')
  await page.keyboard.type('=I2*0.18')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => /Coluna J calculada/.test(document.body.innerText), null, {
    timeout: 120000,
  })
  await goTo('J1:J1048568')
  await step('apagarColunaCalculada', () => page.keyboard.press('Delete'))
  const calcCleared = await raw(last, 9)
  await step('desfazerColunaCalculada', () => page.keyboard.press('Control+z'), 6000)
  const calcBack = await raw(last, 9)
  await save()
  const calc = python(
    READ +
      "from decimal import Decimal\ndef t(x):\n s=repr(float('%.15g'%x)) if x else '0'\n s=format(Decimal(s),'f') if 'e' in s else s\n return s[:-2] if s.endswith('.0') else s\nb=rows(sys.argv[1])\nbad=sum(1 for y in b[1:] if len(y)<10 or y[9]!=t(float(y[8])*0.18))\nprint(json.dumps({'bad':bad}))",
    csv,
  )
  check(
    'apagar_coluna_calculada_e_desfazer',
    calcCleared === null && calcBack !== null && calc.bad === 0,
    {
      telaDepoisDeApagar: calcCleared,
      linhasErradas: calc.bad,
    },
  )

  const worst = Math.max(...Object.values(report.steps).map((s) => s.maxGapMs))
  check('nenhuma_pausa_acima_de_1s', worst < 1000, { piorPausaMs: worst })
  exitCode = failures.length === 0 ? 0 : 1
} catch (error) {
  report.error = String(error?.stack ?? error).slice(0, 2000)
  console.log('ERROR', report.error)
} finally {
  report.failures = failures
  await writeFile(outPath, JSON.stringify(report, null, 1))
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
  process.exit(exitCode)
}
