/** A IA cria uma coluna calculada na base grande (modelo SIMULADO).
 *
 * Planilhas real, motor real, base de 1 milhão de linhas aberta pelo menu. O
 * modelo é um servidor HTTP compatível com OpenAI que devolve um roteiro fixo
 * (não é um modelo de verdade): lê o contexto, escreve o cabeçalho, uma
 * fórmula em J2 e a preenche até a última linha em várias fill_range (o limite
 * de 200 mil células por operação). Confere a tela, o aviso devolvido à IA,
 * rejeitar (a coluna some), aceitar, desfazer a tarefa, refazer e salvar; o
 * CSV salvo é conferido campo a campo em Python.
 *
 *   node --import tsx bench/abrir-milhao/verify-ai-calc.mjs base.csv saida.json
 */
import { _electron as electron } from 'playwright-core'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdtemp, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startScriptedModel, useScriptedModel } from '../../e2e/fariv-review-helpers.ts'

const [file, outPath] = process.argv.slice(2)
const work = await mkdtemp(join(tmpdir(), 'fariv-ai-calc-'))
const csv = join(work, 'base.csv')
await copyFile(resolve(file), csv)
const rows = Number(
  spawnSync(
    'python3',
    ['-I', '-c', 'import sys;print(sum(1 for _ in open(sys.argv[1],"rb")))', csv],
    {
      encoding: 'utf8',
    },
  ).stdout.trim(),
)
const report = {
  provider: 'SIMULATED OpenAI-compatible HTTP provider; no real model',
  checks: {},
  toolResults: [],
}
const failures = []
const check = (name, ok, detail) => {
  report.checks[name] = { passed: !!ok, ...(detail ?? {}) }
  if (!ok) failures.push(name)
  console.log(ok ? 'PASS' : 'FAIL', name, detail ? JSON.stringify(detail).slice(0, 500) : '')
}
const { server, port } = await startScriptedModel((run) => {
  const sheetId = /id=([^,)\s]+)/.exec(run.toolResults[0] ?? '')?.[1]
  const fills = []
  for (let start = 2; start <= rows; start += 200_000) {
    fills.push({
      op: 'fill_range',
      sheetId,
      source: 'J2',
      target: `J${start}:J${Math.min(rows, start + 199_999)}`,
    })
  }
  const steps = [
    { tool: 'get_workbook_context', args: {} },
    { tool: 'read_range', args: { range: 'A1:I3', sheetId } },
    {
      tool: 'propose_operations',
      args: {
        summary: 'Imposto de 18% em J',
        operations: [
          { op: 'set_cell', sheetId, address: 'J1', value: 'imposto' },
          { op: 'set_formula', sheetId, address: 'J2', formula: '=I2*0.18' },
          ...fills,
        ],
      },
    },
  ]
  const reply = steps[run.toolResults.length] ?? { text: 'Coluna J pronta para revisão.' }
  report.toolResults.push(String(run.toolResults.at(-1) ?? '').slice(0, 1500))
  return reply
})
const userData = await mkdtemp(join(tmpdir(), 'fariv-ud-'))
await useScriptedModel(userData, port)
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
  const waitRaw = async (row, column, accept, timeout = 20000) => {
    const deadline = Date.now() + timeout
    let value = await raw(row, column)
    while (!accept(value) && Date.now() < deadline) {
      await page.waitForTimeout(100)
      value = await raw(row, column)
    }
    return value
  }
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
  await page.waitForTimeout(2000)
  // the expected J of a few rows, from the file
  const sample = JSON.parse(
    spawnSync(
      'python3',
      [
        '-I',
        '-c',
        'import csv,json,sys\nr=list(csv.reader(open(sys.argv[1],newline="")))\nidx=[1,len(r)//2,len(r)-1]\nprint(json.dumps({i:float(r[i][8])*0.18 for i in idx}))',
        csv,
      ],
      { encoding: 'utf8', maxBuffer: 1 << 28 },
    ).stdout,
  )
  const close = (a, b) =>
    typeof a === 'number' && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b))
  const ask = async () => {
    const composer = page.locator('.copilot textarea')
    await composer.fill(
      'Crie a coluna J com 18% de imposto sobre o valor (coluna I), até a última linha.',
    )
    await composer.press('Enter')
    const card = page.locator('.ai-review-card').last()
    await card.waitFor({ timeout: 180000 })
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('.ai-review-card')].at(-1)?.getAttribute('data-review') ===
        'pending',
      null,
      { timeout: 180000 },
    )
    await page.waitForTimeout(1500)
    return card
  }
  const screen = async () => {
    const out = {}
    for (const row of Object.keys(sample).map(Number)) {
      await goTo(`J${row + 1}`)
      out[row] = await waitRaw(row, 9, (v) => close(v, sample[row]))
    }
    return out
  }
  let card = await ask()
  const shown = await screen()
  check(
    'ia_coluna_inteira_na_tela',
    Object.entries(sample).every(([row, want]) => close(shown[row], want)),
    { shown, sample },
  )
  const told = report.toolResults.find((r) => /calculated column of this large base/.test(r)) ?? ''
  check(
    'ia_recebe_o_aviso',
    told.includes(`J2:J${rows}`) && told.includes(`J2 = ${JSON.stringify(sample[1])}`),
    {
      told: told.slice(0, 600),
    },
  )
  await card.locator('.ai-review-reject').click()
  await goTo('J2')
  const rejected = {
    j1: await waitRaw(0, 9, (v) => v === null, 20000),
    j2: await waitRaw(1, 9, (v) => v === null, 20000),
  }
  check('rejeitar_tira_a_coluna', rejected.j1 === null && rejected.j2 === null, rejected)
  card = await ask()
  await card.locator('.ai-review-accept').click()
  await page.waitForTimeout(500)
  const accepted = await screen()
  check(
    'aceitar_mantem',
    Object.entries(sample).every(([row, want]) => close(accepted[row], want)),
    accepted,
  )
  const before = statSync(csv).mtimeMs
  await menu('^Salvar$')
  for (let i = 0; i < 1200 && statSync(csv).mtimeMs === before; i++) await page.waitForTimeout(100)
  await page.waitForTimeout(1500)
  const verdict = JSON.parse(
    spawnSync(
      'python3',
      [
        '-I',
        '-c',
        `
import csv,io,json,sys
from decimal import Decimal
def rows(p):
    d=open(p,'rb').read()
    if d.startswith(b'\\xef\\xbb\\xbf'): d=d[3:]
    return list(csv.reader(io.StringIO(d.decode('utf-8'),newline='')))
def txt(x):
    if x==0: return '0'
    s=repr(float('%.15g'%x))
    if 'e' in s: s=format(Decimal(s),'f')
    return s[:-2] if s.endswith('.0') else s
a=rows(sys.argv[1]); b=rows(sys.argv[2]); bad=[]
for i,(ra,rb) in enumerate(zip(a,b)):
    want=ra+['imposto' if i==0 else txt(float(ra[8])*0.18)]
    if rb!=want: bad.append([i,rb,want])
print(json.dumps({'rows':[len(a),len(b)],'diffs':len(bad),'first':bad[:3]}))
`,
        resolve(file),
        csv,
      ],
      { encoding: 'utf8', maxBuffer: 1 << 26 },
    ).stdout || '{}',
  )
  check('csv_salvo', verdict.diffs === 0 && verdict.rows?.[0] === verdict.rows?.[1], verdict)
  exitCode = failures.length === 0 ? 0 : 1
} catch (error) {
  report.error = String(error?.stack ?? error).slice(0, 2000)
  console.log('ERROR', report.error)
} finally {
  report.failures = failures
  await writeFile(outPath, JSON.stringify(report, null, 1))
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
  server.close()
  process.exit(exitCode)
}
