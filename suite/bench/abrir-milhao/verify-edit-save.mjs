/* global window, document, requestAnimationFrame */
/** Editar, desfazer e salvar uma base grande no Planilhas real.
 *
 * Copia o CSV para uma pasta nova (o original nunca é tocado), abre pelo
 * menu, edita pelo teclado (início, meio, fim, apagar, preencher várias
 * células), tenta uma fórmula numa coluna com dados (tem de ser recusada:
 * a coluna calculada exige coluna vazia), desfaz e refaz, salva
 * com Ctrl+S, desfaz depois de salvar e salva de novo, e faz Salvar como
 * .xlsx. A conferência do arquivo salvo é campo a campo, contra o original
 * lido por um leitor independente (Python csv): só as células editadas mudam.
 *
 * Rodar a partir de suite/, com apps/sheets construído:
 *   xvfb-run -a node bench/abrir-milhao/verify-edit-save.mjs base.csv saida.json
 */
import { _electron as electron } from 'playwright-core'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdtemp, writeFile } from 'node:fs/promises'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const [file, outPath] = process.argv.slice(2)
const work = await mkdtemp(join(tmpdir(), 'fariv-edit-'))
const csv = join(work, 'base.csv')
await copyFile(resolve(file), csv)
const xlsxPath = join(work, 'base-salva.xlsx')
const report = { stages: {}, frames: {}, memory: {}, checks: {} }
const failures = []
const check = (name, ok, detail) => {
  report.checks[name] = { passed: !!ok, ...(detail ?? {}) }
  if (!ok) failures.push(name)
  console.log(ok ? 'PASS' : 'FAIL', name, detail ? JSON.stringify(detail).slice(0, 300) : '')
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
  const waitRaw = async (row, column, expected, timeout = 15000) => {
    try {
      await page.waitForFunction(
        ({ row, column, expected }) =>
          (window.__genofficeDebug.univerAPI
            .getActiveWorkbook()
            .getActiveSheet()
            .getSheet()
            .getCellRaw(row, column)?.v ?? null) === expected,
        { row, column, expected },
        { timeout, polling: 50 },
      )
    } catch {}
    return raw(row, column)
  }
  const typeAt = async (address, text) => {
    await goTo(address)
    await page.keyboard.type(text)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)
  }
  const bodyText = () => page.locator('body').innerText()

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

  // ---- editar ----
  await mark('edit')
  await typeAt('A2', 'EDITADO_TOPO')
  await typeAt('C524285', 'texto no meio')
  await typeAt(`I${rows}`, '777')
  await goTo('B10')
  await page.keyboard.press('Delete')
  await page.waitForTimeout(300)
  // várias células de uma vez: D100:D120 (na tela) com Ctrl+Enter
  await goTo('D100:D120')
  await page.keyboard.type('X')
  await page.keyboard.press('Control+Enter')
  await page.waitForTimeout(500)
  // fórmula numa coluna com dados: a coluna calculada exige coluna vazia,
  // então a fórmula é recusada com aviso e a célula fica intacta
  await goTo('E5')
  const e5Before = await raw(4, 4)
  await page.keyboard.type('=A2')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1500)
  const formulaNotice = /use uma coluna vazia/.test(await bodyText())
  check('formula_recusada', (await raw(4, 4)) === e5Before && formulaNotice, {
    e5: await raw(4, 4),
    aviso: formulaNotice,
  })
  // cada edição conferida com a célula na tela (fora dela a grade descarrega)
  const onScreen = {}
  await goTo('A2')
  onScreen.a2 = await waitRaw(1, 0, 'EDITADO_TOPO')
  await goTo('C524285')
  onScreen.c524285 = await waitRaw(524284, 2, 'texto no meio')
  await goTo(`I${rows}`)
  onScreen.ultima = await waitRaw(last, 8, 777)
  await goTo('B10')
  onScreen.b10 = await waitRaw(9, 1, null)
  check(
    'edicoes_na_tela',
    onScreen.a2 === 'EDITADO_TOPO' &&
      onScreen.c524285 === 'texto no meio' &&
      onScreen.ultima === 777 &&
      onScreen.b10 === null,
    onScreen,
  )
  await goTo('D110')
  check('preencher_varias', (await waitRaw(109, 3, 'X')) === 'X', { d110: await raw(109, 3) })

  // ---- desfazer e refazer (o preenchimento D100:D200) ----
  await mark('undo')
  await page.mouse.click(900, 400)
  await goTo('D110')
  const original110 = spawnSync(
    'python3',
    [
      '-I',
      '-c',
      'import csv,sys\nrows=csv.reader(open(sys.argv[1],newline=""))\nfor i,r in enumerate(rows):\n  if i==109: print(r[3]); break',
      resolve(file),
    ],
    { encoding: 'utf8' },
  ).stdout.trim()
  await page.keyboard.press('Control+z')
  const undone = await waitRaw(109, 3, original110, 5000)
  await page.keyboard.press('Control+y')
  const redone = await waitRaw(109, 3, 'X', 5000)
  check('desfazer_refazer', undone === original110 && redone === 'X', {
    original: original110,
    desfeito: undone,
    refeito: redone,
  })

  // ---- salvar ----
  await mark('save')
  const ts = performance.now()
  await menu('^Salvar$')
  await page.waitForFunction(() => /Salvo\./.test(document.body.innerText), null, {
    timeout: 300000,
  })
  report.stages.saveMs = Math.round(performance.now() - ts)
  await page.waitForTimeout(2500)
  report.stages.afterSaveValues = {
    a2: await waitRaw(1, 0, 'EDITADO_TOPO', 20000),
  }

  // ---- conferência do CSV salvo contra o original (Python, campo a campo) ----
  const expectedEdits = {
    [`1:0`]: 'EDITADO_TOPO',
    [`524284:2`]: 'texto no meio',
    [`${last}:8`]: '777',
    [`9:1`]: '',
  }
  for (let r = 99; r <= 119; r++) expectedEdits[`${r}:3`] = 'X'
  const compare = (saved, edits) => {
    const py = spawnSync(
      'python3',
      [
        '-I',
        '-c',
        `
import csv,json,sys
orig_path,saved_path,edits=sys.argv[1],sys.argv[2],json.loads(sys.argv[3])
def rows(p):
    data=open(p,'rb').read()
    if data.startswith(b'\\xef\\xbb\\xbf'): data=data[3:]
    import io
    return list(csv.reader(io.StringIO(data.decode('utf-8'),newline=''),delimiter=sys.argv[4]))
a=rows(orig_path); b=rows(saved_path)
diff=[]; n=0
for r in range(max(len(a),len(b))):
    ra=a[r] if r<len(a) else []; rb=b[r] if r<len(b) else []
    for c in range(max(len(ra),len(rb))):
        va=ra[c] if c<len(ra) else ''; vb=rb[c] if c<len(rb) else ''
        n+=1
        exp=edits.get(f'{r}:{c}', va)
        if vb!=exp: diff.append([r,c,va,vb,exp])
print(json.dumps({'rows_orig':len(a),'rows_saved':len(b),'fields':n,'diffs':len(diff),'first':diff[:5]}))
`,
        resolve(file),
        saved,
        JSON.stringify(edits),
        ',',
      ],
      { encoding: 'utf8', maxBuffer: 1 << 24 },
    )
    return JSON.parse(py.stdout || '{}')
  }
  const firstSave = compare(csv, expectedEdits)
  check(
    'csv_salvo_so_muda_o_editado',
    firstSave.diffs === 0 && firstSave.rows_saved === firstSave.rows_orig,
    firstSave,
  )

  // ---- desfazer depois de salvar e salvar de novo ----
  await mark('undoAfterSave')
  await page.mouse.click(900, 400)
  await goTo('D110')
  await page.keyboard.press('Control+z')
  report.stages.undoAfterSaveD110 = await waitRaw(109, 3, original110, 5000)
  // o segundo salvamento é reconhecido pelo arquivo: espera ele mudar
  const before = statSync(csv).mtimeMs
  await menu('^Salvar$')
  for (let i = 0; i < 600 && statSync(csv).mtimeMs === before; i++) await page.waitForTimeout(100)
  await page.waitForTimeout(2500)
  const reverted = { ...expectedEdits }
  for (let r = 99; r <= 119; r++) delete reverted[`${r}:3`]
  const secondSave = compare(csv, reverted)
  check('desfazer_depois_de_salvar_e_salvar_de_novo', secondSave.diffs === 0, secondSave)

  // ---- Salvar como .xlsx ----
  await mark('saveAs')
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p })
  }, xlsxPath)
  const tx = performance.now()
  await menu('^Salvar Como')
  await page.waitForFunction(() => /Salvo\./.test(document.body.innerText), null, {
    timeout: 300000,
  })
  report.stages.saveAsXlsxMs = Math.round(performance.now() - tx)
  await page.waitForTimeout(1000)
  const xlsxCheck = spawnSync(
    'python3',
    [
      '-I',
      '-c',
      `
import zipfile,re,sys,json
z=zipfile.ZipFile(sys.argv[1])
names=z.namelist()
sheet=[n for n in names if n.startswith('xl/worksheets/sheet')][0]
rows=0; a2=None; last=None
with z.open(sheet) as f:
    buf=f.read().decode('utf-8')
rows=buf.count('<row ')
m=re.search(r'<c r="A2"[^>]*>(.*?)</c>',buf)
a2=m.group(1) if m else None
m=re.search(r'<c r="I'+sys.argv[2]+r'"[^>]*>(.*?)</c>',buf)
last=m.group(0) if m else None
print(json.dumps({'rows':rows,'a2':a2,'last':last,'bytes':__import__('os').path.getsize(sys.argv[1])}))
`,
      xlsxPath,
      String(rows),
    ],
    { encoding: 'utf8', maxBuffer: 1 << 24 },
  )
  const xlsxInfo = JSON.parse(xlsxCheck.stdout || '{}')
  check(
    'xlsx_salvo',
    xlsxInfo.rows === rows &&
      /EDITADO_TOPO/.test(xlsxInfo.a2 ?? '') &&
      /<v>777<\/v>/.test(xlsxInfo.last ?? ''),
    xlsxInfo,
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
