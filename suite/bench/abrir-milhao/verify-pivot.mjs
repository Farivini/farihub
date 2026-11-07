/* global window, document, requestAnimationFrame */
/** Etapa B: tabela dinâmica da base inteira, calculada pelo motor.
 *
 * Planilhas real, base aberta pelo menu (numa cópia). Inserir → Tabela
 * dinâmica abre a dinâmica do motor; dez trocas de campo pelo painel de
 * campos, cada uma medida (resposta e maior pausa da tela); a dinâmica
 * copiada é conferida linha a linha em Python contra a base; contagem
 * distinta pela janela de configurações do campo de valor; Pareto ABC e
 * gráfico. Só contagens, tempos e diferenças vão para o relatório.
 *
 *   xvfb-run -a node bench/abrir-milhao/verify-pivot.mjs bank_transactions.csv saida.json
 */
import { _electron as electron } from 'playwright-core'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const [file, outPath] = process.argv.slice(2)
const work = await mkdtemp(join(tmpdir(), 'fariv-pivot-'))
const csv = join(work, 'base.csv')
await copyFile(resolve(file), csv)
const report = { steps: {}, checks: {} }
const failures = []
const check = (name, ok, detail) => {
  report.checks[name] = { passed: !!ok, ...(detail ?? {}) }
  if (!ok) failures.push(name)
  console.log(ok ? 'PASS' : 'FAIL', name, detail ? JSON.stringify(detail).slice(0, 300) : '')
}
const python = (code, input, ...args) =>
  JSON.parse(
    spawnSync('python3', ['-I', '-c', code, ...args], {
      encoding: 'utf8',
      input,
      maxBuffer: 1 << 28,
    }).stdout || '{}',
  )
// the oracle: plain Python over the CSV; the copied pivot comes on stdin
const ORACLE = `
import csv,io,json,sys,math
from collections import defaultdict
rows=list(csv.reader(open(sys.argv[1],newline='',encoding='utf-8-sig')))
head,rows=rows[0],rows[1:]
by=sys.argv[2]; val=sys.argv[3]; agg=sys.argv[4]
k=head.index(by); v=head.index(val)
acc=defaultdict(float); seen=defaultdict(set)
for r in rows:
    if agg=='sum':
        try: acc[r[k]]+=float(r[v])
        except: pass
    else:
        if r[v]!='': seen[r[k]].add(r[v])
want={key:(acc[key] if agg=='sum' else len(seen[key])) for key in (acc if agg=='sum' else seen)}
lines=sys.stdin.read().split('\\r\\n')
got={}
for line in lines[1:]:
    cells=line.split('\\t')
    if len(cells)<2 or cells[0]=='Total geral': continue
    key='' if cells[0]=='(vazio)' else cells[0]
    got[key]=float(cells[1].replace(',','.')) if cells[1] else None
bad=[x for x in set(want)|set(got) if x not in got or x not in want or not math.isclose(got[x],want[x],rel_tol=1e-12,abs_tol=1e-6)]
print(json.dumps({'linhas':len(got),'esperadas':len(want),'diferencas':len(bad)}))
`

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
  await page.evaluate(() => {
    window.__gap = { last: performance.now(), max: 0 }
    const tick = (now) => {
      window.__gap.max = Math.max(window.__gap.max, now - window.__gap.last)
      window.__gap.last = now
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const settled = () =>
    page.waitForFunction(
      () => {
        const title = document.querySelector('.large-pivot-title span')?.textContent ?? ''
        return title !== '' && !title.includes('Calculando')
      },
      null,
      { timeout: 120000 },
    )
  const step = async (name, run) => {
    await page.evaluate(() => {
      window.__gap.max = 0
      window.__gap.last = performance.now()
    })
    const started = Date.now()
    await run()
    await page.waitForTimeout(30)
    await settled()
    const responsiveMs = Date.now() - started
    await page.waitForTimeout(300)
    const maxGapMs = Math.round(await page.evaluate(() => window.__gap.max))
    const summary = await page.locator('.large-pivot-title span').innerText()
    report.steps[name] = { responsiveMs, maxGapMs }
    console.log(name, responsiveMs, 'ms; pausa máxima', maxGapMs, 'ms;', summary)
  }
  const field = (label) =>
    page.locator('.large-pivot .pivot-field-list li', { hasText: label }).locator('input')
  const copied = async () => {
    await page.locator('.large-pivot').getByRole('button', { name: 'Copiar', exact: true }).click()
    await page.waitForTimeout(500)
    return app.evaluate(({ clipboard }) => clipboard.readText())
  }

  // ---- abrir a dinâmica pelo menu Inserir ----
  const opening = Date.now()
  await page.getByRole('button', { name: 'Inserir', exact: true }).first().click()
  await page.locator('.ribbon button', { hasText: 'Tabela Dinâmica' }).first().click()
  await page.locator('.large-pivot .pivot-field-list li').first().waitFor({ timeout: 60000 })
  report.steps.abrir = { responsiveMs: Date.now() - opening }
  const fieldNames = await page.locator('.large-pivot .pivot-field-list li').allInnerTexts()
  check('abre_a_dinamica_do_motor', fieldNames.length === 9, { campos: fieldNames.length })
  // the engine reads the columns in the background meanwhile
  await page.waitForTimeout(8000)

  // ---- dez trocas de campo ----
  const amount = 'TransactionAmount (INR)'
  await step('1_cidade', () => field('CustLocation').check())
  await step('2_soma_valor', () => field(amount).check())
  const cityText = await copied()
  const city = python(ORACLE, cityText, csv, 'CustLocation', amount, 'sum')
  check('cidade_soma_igual_ao_python', city.diferencas === 0 && city.linhas > 9000, city)
  await step('3_genero', () => field('CustGender').check())
  await step('4_tira_cidade', () => field('CustLocation').uncheck())
  await step('5_data', () => field('TransactionDate').check())
  await step('6_tira_genero', () => field('CustGender').uncheck())
  await step('7_cliente', () => field('CustomerID').check())
  await step('8_tira_cliente', () => field('CustomerID').uncheck())
  await step('9_saldo', () => field('CustAccountBalance').check())
  await step('10_tira_valor', () => field(amount).uncheck())
  const changes = Object.entries(report.steps).filter(([name]) => /^\d+_/.test(name))
  const slowest = Math.max(...changes.map(([, s]) => s.responsiveMs))
  const worstGap = Math.max(...changes.map(([, s]) => s.maxGapMs))
  check('dez_trocas_abaixo_de_1s', slowest < 1000 && worstGap < 1000, {
    piorRespostaMs: slowest,
    piorPausaMs: worstGap,
  })

  // ---- contagem distinta de clientes por gênero ----
  await field('TransactionDate').uncheck()
  await settled()
  await field('CustAccountBalance').uncheck()
  await field('CustGender').check()
  await field('CustomerID').check()
  await page.getByRole('button', { name: 'Menu do campo CustomerID', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Mover para Valores' }).click()
  await page
    .getByRole('button', { name: 'Menu do campo Contagem de CustomerID', exact: true })
    .click()
  await page.getByRole('menuitem', { name: /Configurações do Campo de Valor/ }).click()
  await page.locator('.gs-dd-btn').first().click()
  await page.getByRole('option', { name: 'Contagem distinta' }).click()
  await step('contagem_distinta', () =>
    page.getByRole('button', { name: 'Aplicar', exact: true }).last().click(),
  )
  const distinctText = await copied()
  const distinct = python(ORACLE, distinctText, csv, 'CustGender', 'CustomerID', 'distinct')
  check(
    'contagem_distinta_igual_ao_python',
    distinct.diferencas === 0 && distinct.linhas >= 2,
    distinct,
  )

  // ---- Pareto ABC e gráfico ----
  await field('CustGender').uncheck()
  await field('CustLocation').check()
  await settled()
  await page.locator('.large-pivot').getByRole('checkbox', { name: 'Pareto ABC' }).check()
  await page.locator('.large-pivot').getByRole('checkbox', { name: 'Gráfico' }).check()
  await page.waitForTimeout(500)
  const bars = await page.locator('.large-pivot-chart .mark').count()
  // every row (Copy asks the engine again): shares of the sum of the rows,
  // the cumulative ends at 100%, classes run A then B then C
  const paretoLines = (await copied()).split('\r\n').slice(1, -1)
  const classes = paretoLines.map((line) => line.split('\t').at(-1)).join('')
  const lastCumulative = paretoLines.at(-1)?.split('\t').at(-2)
  const inOrder = /^A+B*C*$/.test(classes)
  check(
    'pareto_e_grafico',
    inOrder && lastCumulative === '100%' && bars === 20 && paretoLines.length > 9000,
    {
      linhas: paretoLines.length,
      classesEmOrdem: inOrder,
      ultimoAcumulado: lastCumulative,
      barras: bars,
    },
  )
  if (process.env.PIVOT_VIEW_SHOT) await page.screenshot({ path: process.env.PIVOT_VIEW_SHOT })

  // ---- voltar para a base ----
  await page.getByRole('button', { name: 'Voltar para a base' }).click()
  const closed = (await page.locator('.large-pivot').count()) === 0
  // reabrir traz a mesma dinâmica (o layout fica na sessão)
  await page.locator('.ribbon button', { hasText: 'Tabela Dinâmica' }).first().click()
  await page.locator('.large-pivot-table').waitFor({ timeout: 30000 })
  await settled()
  const header = await page.locator('.large-pivot-table thead th').first().innerText()
  check('volta_e_reabre_a_mesma_dinamica', closed && header === 'CustLocation', {
    fechou: closed,
    reabriuComOsCampos: header === 'CustLocation',
  })
  exitCode = failures.length === 0 ? 0 : 1
} catch (error) {
  if (process.env.PIVOT_SHOT)
    await (await app.firstWindow()).screenshot({ path: process.env.PIVOT_SHOT }).catch(() => {})
  report.error = String(error?.stack ?? error).slice(0, 2000)
  console.log('ERROR', report.error)
} finally {
  report.failures = failures
  await writeFile(outPath, JSON.stringify(report, null, 1))
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
  process.exit(exitCode)
}
