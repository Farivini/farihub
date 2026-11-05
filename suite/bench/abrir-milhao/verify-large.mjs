/* global window, requestAnimationFrame */
/** Abre um CSV grande pelo menu normal do Planilhas real (Electron, sidecar,
 * motor de dados) e prova:
 *  - tempo até a primeira tela, pausas entre quadros, memória somada do app;
 *  - navegação normal: Ctrl+End, Ctrl+Home, Ctrl+↓, caixa de nome, rolagem;
 *  - cada célula da base inteira (lida pelo mesmo canal da grade) igual à
 *    importação de hoje (parseCsv + analyzeCsvColumns) e, para o texto bruto,
 *    a um leitor independente (Python csv);
 *  - busca (Ctrl+F) com a mesma contagem do oráculo;
 *  - só leitura: editar e salvar são recusados com aviso.
 * Rodar a partir de suite/, com apps/sheets construído:
 *   xvfb-run -a node --import tsx bench/abrir-milhao/verify-large.mjs ARQUIVO.csv SAIDA.json [busca]
 */
import { _electron as electron } from 'playwright-core'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  decodeCsvBuffer,
  parseCsv,
  resolveImportDelimiter,
} from '../../packages/xlsx-gateway/src/gateway/csv-import.ts'
import { analyzeCsvColumns } from '../../packages/xlsx-gateway/src/gateway/csv-number-format.ts'

const [file, outPath, findQuery] = process.argv.slice(2)
const input = resolve(file)
const report = {
  input: { name: input.split('/').pop(), bytes: (await stat(input)).size },
  environment: {
    platform: `${process.platform} ${process.arch}`,
    node: process.version,
    cpus: (await import('node:os')).cpus().length,
    totalMemGiB: Math.round((await import('node:os')).totalmem() / 2 ** 30),
  },
  stages: {},
  frames: {},
  memory: {},
  checks: {},
}
const failures = []
const check = (name, ok, detail) => {
  report.checks[name] = { passed: !!ok, ...(detail ?? {}) }
  if (!ok) failures.push(name)
  console.log(ok ? 'PASS' : 'FAIL', name, detail ? JSON.stringify(detail).slice(0, 300) : '')
}
report.input.sha256 = createHash('sha256')
  .update(await readFile(input))
  .digest('hex')

// ---- memória: PSS somado da árvore do processo principal do Electron ----
function processTree(rootPid) {
  const procs = []
  for (const id of readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    try {
      const s = readFileSync(`/proc/${id}/status`, 'utf8')
      procs.push({
        pid: Number(id),
        ppid: Number(/^PPid:\s+(\d+)/m.exec(s)?.[1]),
        name: /^Name:\s+(.+)$/m.exec(s)?.[1] ?? '?',
      })
    } catch {}
  }
  const keep = new Map([[rootPid, 'root']])
  let grew = true
  while (grew) {
    grew = false
    for (const p of procs) {
      if (keep.has(p.pid) || !keep.has(p.ppid)) continue
      keep.set(p.pid, p.name)
      grew = true
    }
  }
  let total = 0
  const byName = {}
  for (const [pid, name] of keep) {
    try {
      const m = /^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'))
      if (!m) continue
      const kib = Number(m[1])
      total += kib
      const key =
        name === 'data-engine'
          ? 'data-engine'
          : name.startsWith('xlsx-sidecar')
            ? 'xlsx-sidecar'
            : 'electron'
      byName[key] = (byName[key] ?? 0) + kib
    } catch {}
  }
  return {
    totalMiB: Math.round(total / 1024),
    byName: Object.fromEntries(Object.entries(byName).map(([k, v]) => [k, Math.round(v / 1024)])),
  }
}

const userData = await mkdtemp(join(tmpdir(), 'fariv-large-'))
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
let peak = { totalMiB: 0 }
const memTimer = setInterval(() => {
  const m = processTree(rootPid)
  if (m.totalMiB > peak.totalMiB) peak = m
}, 200)
let exitCode = 1
try {
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message))
  await page.locator('.copilot textarea').waitFor({ timeout: 60000 })
  await page.waitForTimeout(1500)
  report.memory.beforeOpen = processTree(rootPid)
  await page.evaluate(() => {
    const w = window
    w.__gaps = { last: performance.now(), mark: 'idle', byMark: {}, over100: {}, over300: {} }
    const tick = (now) => {
      const g = w.__gaps
      const d = now - g.last
      g.last = now
      g.byMark[g.mark] = Math.max(g.byMark[g.mark] ?? 0, d)
      if (d > 100) g.over100[g.mark] = (g.over100[g.mark] ?? 0) + 1
      if (d > 300) g.over300[g.mark] = (g.over300[g.mark] ?? 0) + 1
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const mark = (m) => page.evaluate((m) => (window.__gaps.mark = m), m)

  // ---- abrir pelo menu ----
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
  }, input)
  const firstLine = parseCsv(
    decodeCsvBuffer(readFileSync(input).subarray(0, 64 * 1024)).split(/\r?\n/)[0] + '\n',
  )[0]
  await mark('open')
  const t0 = performance.now()
  await app.evaluate(({ Menu }) => {
    const find = (items) => {
      for (const item of items) {
        if (/^Abrir/i.test(item.label ?? '')) return item
        const c = item.submenu && find(item.submenu.items)
        if (c) return c
      }
    }
    find(Menu.getApplicationMenu().items).click()
  })
  await page.waitForFunction(
    (expected) => {
      try {
        const s = window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet()
        return s.getRange('A1').getValue() === expected && s.getMaxRows() > 1000
      } catch {
        return false
      }
    },
    firstLine[0],
    { timeout: 300000, polling: 50 },
  )
  report.stages.openToFirstCellMs = Math.round(performance.now() - t0)
  await mark('settle')
  await page.waitForTimeout(2000)
  report.memory.afterOpen = processTree(rootPid)
  report.stages.notice = await page
    .locator('.csv-format-notice')
    .innerText()
    .catch(() => null)

  // ---- oráculo: a importação de hoje sobre o arquivo inteiro ----
  const tOracle = performance.now()
  const text = decodeCsvBuffer(await readFile(input))
  const delimiter = resolveImportDelimiter(text)
  const rows = parseCsv(text, delimiter)
  const typing = analyzeCsvColumns(rows, delimiter)
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0)
  report.stages.oracleMs = Math.round(performance.now() - tOracle)
  report.oracle = {
    rows: rows.length,
    columns: width,
    delimiter,
    columnKinds: typing.report.columns.map(
      (c) => `${c.header || c.column}:${c.kind}${c.decimal ? c.decimal : ''}`,
    ),
  }
  const expectedValue = (r, c) => {
    const raw = rows[r]?.[c] ?? ''
    if (raw === '') return null
    return typing.numberAt(c, raw) ?? raw
  }
  // leitor independente (Python csv) para o texto bruto: resumo por linha
  const py = spawnSync(
    'python3',
    [
      '-I',
      '-c',
      `
import csv,hashlib,sys,io
data=open(sys.argv[1],'rb').read()
if data.startswith(b'\\xef\\xbb\\xbf'): data=data[3:]
t=data.decode('utf-8')
d=sys.argv[2]
h=hashlib.sha256(); n=0
for row in csv.reader(io.StringIO(t,newline=''),delimiter=d):
    h.update(('\\x1f'.join(row)+'\\x1e').encode()); n+=1
print(n, h.hexdigest())
`,
      input,
      delimiter,
    ],
    { encoding: 'utf8', maxBuffer: 1 << 20 },
  )
  const [pyRows, pyDigest] = py.stdout.trim().split(' ')
  const jsDigest = createHash('sha256')
  for (const r of rows) jsDigest.update(r.join('\x1f') + '\x1e')
  check(
    'oraculos_concordam_texto_bruto',
    Number(pyRows) === rows.length && pyDigest === jsDigest.digest('hex'),
    {
      python: Number(pyRows),
      importacaoAtual: rows.length,
    },
  )

  // ---- tamanho e navegação ----
  const sheetSize = await page.evaluate(() => {
    const s = window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet()
    return { rows: s.getMaxRows(), columns: s.getMaxColumns() }
  })
  check('grade_com_todas_as_linhas', sheetSize.rows >= rows.length, {
    grade: sheetSize.rows,
    base: rows.length,
  })

  const activeCell = () =>
    page.evaluate(() => {
      const r = window.__genofficeDebug.univerAPI
        .getActiveWorkbook()
        .getActiveSheet()
        .getSelection()
        .getActiveRange()
      return { row: r.getRow(), column: r.getColumn(), value: r.getValue() }
    })
  const waitActiveValue = async (expected, label) => {
    const t = performance.now()
    try {
      await page.waitForFunction(
        (exp) => {
          const r = window.__genofficeDebug.univerAPI
            .getActiveWorkbook()
            .getActiveSheet()
            .getSelection()
            .getActiveRange()
          return r.getValue() === exp
        },
        expected,
        { timeout: 20000, polling: 25 },
      )
    } catch {}
    report.stages[`${label}Ms`] = Math.round(performance.now() - t)
    return activeCell()
  }
  const lastRow = rows.length - 1
  const lastColumn = width - 1
  await page.mouse.click(700, 300)
  await page.keyboard.press('Control+Home')
  await mark('ctrlEnd')
  await page.keyboard.press('Control+End')
  let cell = await waitActiveValue(expectedValue(lastRow, lastColumn), 'ctrlEnd')
  check(
    'ctrl_end_ultima_celula',
    cell.row === lastRow &&
      cell.column === lastColumn &&
      cell.value === expectedValue(lastRow, lastColumn),
    {
      cell,
      esperado: { row: lastRow, column: lastColumn, value: expectedValue(lastRow, lastColumn) },
    },
  )
  await mark('ctrlHome')
  await page.keyboard.press('Control+Home')
  cell = await waitActiveValue(expectedValue(0, 0), 'ctrlHome')
  check('ctrl_home', cell.row === 0 && cell.column === 0, { cell })
  // Ctrl+↓ na coluna A: última linha antes do primeiro vazio
  let downTarget = 0
  while (downTarget + 1 < rows.length && expectedValue(downTarget + 1, 0) !== null) downTarget += 1
  await mark('ctrlDown')
  await page.keyboard.press('Control+ArrowDown')
  cell = await waitActiveValue(expectedValue(downTarget, 0), 'ctrlDown')
  check('ctrl_seta_baixo', cell.row === downTarget && cell.value === expectedValue(downTarget, 0), {
    cell,
    esperado: downTarget,
  })

  // caixa de nome: meio da base
  const middle = Math.floor(rows.length / 2)
  const nameBox = page.locator('[data-u-comp="defined-name"] input')
  await mark('goto')
  await nameBox.click()
  await nameBox.fill(`C${middle + 1}`)
  await nameBox.press('Enter')
  cell = await waitActiveValue(expectedValue(middle, 2), 'gotoMiddle')
  check(
    'caixa_de_nome_meio',
    cell.row === middle && cell.column === 2 && cell.value === expectedValue(middle, 2),
    { cell },
  )

  // a tela inteira em volta do meio, lida da grade
  // as linhas visíveis a partir da célula ativa (a tela mostra ~30)
  const screenRows = await page.evaluate(() => {
    const s = window.__genofficeDebug.univerAPI.getActiveWorkbook().getActiveSheet()
    const r = s.getVisibleRange?.()
    return r ? r.endRow - r.startRow + 1 : 25
  })
  const shown = Math.max(5, Math.min(screenRows - 3, 25))
  const readScreen = () =>
    page.evaluate(
      // o valor guardado na célula (getCellRaw); getValues devolve o texto
      // exibido, que o formato Geral encurta para caber na coluna, como o Excel
      ({ start, n, w }) => {
        const sheet = window.__genofficeDebug.univerAPI
          .getActiveWorkbook()
          .getActiveSheet()
          .getSheet()
        return Array.from({ length: n }, (_, i) =>
          Array.from({ length: w }, (_, c) => sheet.getCellRaw(start + i, c)?.v ?? null),
        )
      },
      { start: middle, n: shown, w: width },
    )
  const diff = (screen) => {
    const out = []
    screen.forEach((line, i) =>
      line.forEach((v, c) => {
        const e = expectedValue(middle + i, c)
        if (!(v === null || v === '' ? e === null : v === e)) out.push({ row: middle + i, c, v, e })
      }),
    )
    return out
  }
  let screenDiff = diff(await readScreen())
  for (let i = 0; i < 40 && screenDiff.length > 0; i++) {
    await page.waitForTimeout(50)
    screenDiff = diff(await readScreen())
  }
  check('tela_do_meio_igual', screenDiff.length === 0, {
    celulas: shown * width,
    divergencias: screenDiff.length,
    primeiras: screenDiff.slice(0, 5),
  })

  // rolagem com a roda
  await mark('wheel')
  const tw = performance.now()
  for (let i = 0; i < 60; i++) {
    await page.mouse.move(600, 500)
    await page.mouse.wheel(0, 4000)
    await page.waitForTimeout(20)
  }
  report.stages.wheel60Ms = Math.round(performance.now() - tw)
  await page.waitForTimeout(1500)
  await mark('after')
  report.frames = await page.evaluate(() => window.__gaps)

  // ---- só leitura ----
  await page.keyboard.press('Control+Home')
  await page.waitForTimeout(300)
  await page.keyboard.press('ArrowDown')
  const before = expectedValue(1, 0)
  await page.keyboard.type('XYZ')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(500)
  const after = await page.evaluate(() =>
    window.__genofficeDebug.univerAPI
      .getActiveWorkbook()
      .getActiveSheet()
      .getRange('A2')
      .getValue(),
  )
  check('edicao_recusada', after === before, { a2: after })
  await page.keyboard.press('Control+s')
  await page.waitForTimeout(1500)
  const bodyText = await page.locator('body').innerText()
  check('salvar_recusado_com_aviso', /só para leitura/i.test(bodyText), {
    trecho: (bodyText.match(/[^\n]*só para leitura[^\n]*/i) ?? [''])[0].slice(0, 200),
  })

  // pico do uso normal (abrir, navegar, rolar, buscar na tela); a conferência
  // abaixo passa a base inteira pelo renderizador e não é uso normal
  report.memory.peakDuringUse = peak
  // ---- cada célula da base, pelo mesmo canal da grade ----
  const tFull = performance.now()
  const chunkRows = Math.max(1, Math.floor(100_000 / width))
  let compared = 0
  let mismatches = 0
  const firstMismatches = []
  const meta = await page.evaluate(() => {
    const wb = window.__genofficeDebug.univerAPI.getActiveWorkbook()
    return { sheetId: wb.getActiveSheet().getSheetId() }
  })
  const session = await page.evaluate(() => window.__genofficeDebug.currentSessionId?.() ?? null)
  report.stages.sessionKnown = session !== null
  if (session) {
    for (let start = 0; start < rows.length; start += chunkRows) {
      const end = Math.min(rows.length - 1, start + chunkRows - 1)
      const got = await page.evaluate(
        ({ sessionId, sheetId, start, end, w }) =>
          window.desktopApi
            .readWorkbookRange({
              sessionId,
              sheetId,
              range: { startRow: start, endRow: end, startColumn: 0, endColumn: w - 1 },
            })
            .then((r) => r.cells.map((c) => [c.row, c.column, c.value])),
        { sessionId: session, sheetId: meta.sheetId, start, end, w: width },
      )
      const seen = new Map(got.map(([r, c, v]) => [`${r}:${c}`, v]))
      for (let r = start; r <= end; r++) {
        for (let c = 0; c < width; c++) {
          const e = expectedValue(r, c)
          const g = seen.get(`${r}:${c}`)
          compared += 1
          const same = e === null ? g === undefined : g === e
          if (!same) {
            mismatches += 1
            if (firstMismatches.length < 10) firstMismatches.push({ r, c, esperado: e, obtido: g })
          }
        }
      }
      if (seen.size > 0 && got.some(([r]) => r < start || r > end)) mismatches += 1
    }
  }
  report.stages.fullCompareMs = Math.round(performance.now() - tFull)
  check(
    'todas_as_celulas_iguais_a_importacao_atual',
    session !== null && mismatches === 0 && compared === rows.length * width,
    {
      comparadas: compared,
      divergencias: mismatches,
      primeiras: firstMismatches,
    },
  )

  // ---- busca ----
  if (findQuery && session) {
    let expectedHits = 0
    const q = findQuery.toLowerCase()
    for (let r = 0; r < rows.length; r++)
      for (let c = 0; c < width; c++) {
        const e = expectedValue(r, c)
        if (e === null) continue
        if (String(e).toLowerCase().includes(q)) expectedHits += 1
      }
    const tf = performance.now()
    let hits = 0
    let resumeAt
    for (;;) {
      const pageResult = await page.evaluate(
        ({ sessionId, query, resumeAt }) =>
          window.desktopApi.findWorkbookCells({
            sessionId,
            query,
            matchCase: false,
            matchEntireCell: false,
            lookIn: 'values',
            wildcards: false,
            limit: 100000,
            ...(resumeAt ? { resumeAt } : {}),
          }),
        { sessionId: session, query: findQuery, resumeAt },
      )
      hits += pageResult.matches.length
      if (pageResult.complete) break
      resumeAt = pageResult.nextCursor
    }
    report.stages.findAllMs = Math.round(performance.now() - tf)
    check('busca_mesma_contagem', hits === expectedHits, {
      busca: findQuery,
      achados: hits,
      esperado: expectedHits,
    })
  }
  exitCode = failures.length === 0 ? 0 : 1
} catch (error) {
  report.error = String(error?.stack ?? error).slice(0, 2000)
  console.log('ERROR', report.error)
} finally {
  clearInterval(memTimer)
  report.memory.peak = peak
  report.failures = failures
  await writeFile(outPath, JSON.stringify(report, null, 1))
  console.log(
    JSON.stringify(
      { stages: report.stages, frames: report.frames?.byMark, memory: report.memory, failures },
      null,
      1,
    ),
  )
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
  process.exit(exitCode)
}
