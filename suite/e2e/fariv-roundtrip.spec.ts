import { test, expect, type Page } from '@playwright/test'
import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl, screenshotPath } from './helpers'

/**
 * Fariv acceptance: each of the three editors opens a real file in the one shell, takes an
 * edit typed on the keyboard, saves to the same path, and a second launch reopens the file
 * with the edit in it. Checked in the saved package (XML), not only on screen.
 */

const POLL = { timeout: 20_000, intervals: [250, 500, 1000] }

async function part(path: string, name: string): Promise<string> {
  const zip = await JSZip.loadAsync(await readFile(path))
  const file = zip.file(name)
  if (!file) throw new Error(`${name} missing from ${path}`)
  return file.async('string')
}

// ---------------------------------------------------------------- Planilhas (.xlsx)

const XLSX_FIXTURE = resolve(__dirname, '../apps/sheets/fixtures/generated/compatibility-basic.xlsx')

async function gridOrigin(page: Page): Promise<{ x: number; y: number }> {
  await page.waitForFunction(() => document.body.textContent?.includes('Sheet1'), null, { timeout: 30_000 })
  await page.waitForTimeout(1_500)
  const grid = await page.evaluate(() => {
    for (const canvas of document.querySelectorAll('canvas')) {
      const rect = canvas.getBoundingClientRect()
      if (rect.width > 500 && rect.height > 300) return { x: rect.x, y: rect.y }
    }
    return null
  })
  if (!grid) throw new Error('worksheet canvas not found')
  // A1: right of the ~46px row header, below the ~24px column header
  return { x: grid.x + 46 + 43, y: grid.y + 24 + 12 }
}

/** A3 from A1 with the keyboard, as a person would (row heights depend on the file). */
async function gotoA3(page: Page): Promise<void> {
  const a1 = await gridOrigin(page)
  await page.mouse.click(a1.x, a1.y)
  await expect(page.locator('[data-u-comp="defined-name"] input')).toHaveValue('A1')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('[data-u-comp="defined-name"] input')).toHaveValue('A3')
}

test('planilha: editar, salvar e reabrir um .xlsx', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fariv-xlsx-'))
  const workbook = join(dir, 'vendas.xlsx')
  await copyFile(XLSX_FIXTURE, workbook)

  const first = await launchShell({ onboardingSeen: true, videoDir: 'fariv-xlsx', openFile: workbook })
  try {
    const sheets = await waitForPageWithUrl(first.app, '://sheets/')
    await gotoA3(sheets)
    await sheets.keyboard.type('Ação São João', { delay: 30 })
    await sheets.keyboard.press('Enter')
    await sheets.screenshot({ path: screenshotPath('fariv-xlsx-edited') })
    await first.app.evaluate(({ webContents }) => {
      webContents.getAllWebContents().find((w) => w.getURL().includes('://sheets/'))?.send('menu:action', 'save')
    })
    // the text lands in the shared strings (or inline) of the saved package
    await expect
      .poll(async () => (await part(workbook, 'xl/sharedStrings.xml').catch(() => '')) + (await part(workbook, 'xl/worksheets/sheet1.xml')), POLL)
      .toContain('Ação São João')
    expect(await part(workbook, 'xl/worksheets/sheet1.xml')).toContain('<v>10</v>')
  } finally {
    await closeAndSaveVideo(first, 'fariv-xlsx')
  }

  const second = await launchShell({ onboardingSeen: true, videoDir: 'fariv-xlsx-reopen', openFile: workbook })
  try {
    const sheets = await waitForPageWithUrl(second.app, '://sheets/')
    await gotoA3(sheets)
    // the app's own control hook reads the selected cell (the grid is a canvas)
    const selected = await sheets.evaluate(async () => {
      const control = (window as unknown as { __genofficeControl(r: { cmd: 'selection' }): Promise<{ status: string; result?: { values?: unknown[][] } }> }).__genofficeControl
      return control({ cmd: 'selection' })
    })
    expect(selected.result?.values).toEqual([['Ação São João']])
    await sheets.screenshot({ path: screenshotPath('fariv-xlsx-reopened') })
  } finally {
    await closeAndSaveVideo(second, 'fariv-xlsx-reopen')
  }
})

// ---------------------------------------------------------------- Documentos (.docx)

const DOCX_FIXTURE = resolve(__dirname, '../fixtures/generated/simple.docx')

interface DocsWindow {
  __aidocs?: { editor?: { commands: { focus(pos: string): void }; getText(): string }; save(): Promise<unknown> }
}

async function docsReady(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as unknown as DocsWindow).__aidocs?.editor, null, { timeout: 30_000 })
  await page.waitForTimeout(1_000)
}

test('documento: editar, salvar e reabrir um .docx', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fariv-docx-'))
  const doc = join(dir, 'relatorio.docx')
  await copyFile(DOCX_FIXTURE, doc)

  const first = await launchShell({ onboardingSeen: true, videoDir: 'fariv-docx', openFile: doc })
  try {
    const docs = await waitForPageWithUrl(first.app, '://docs/')
    await docsReady(docs)
    await docs.evaluate(() => (window as unknown as DocsWindow).__aidocs!.editor!.commands.focus('end'))
    await docs.keyboard.type(' Relatório revisado em português.', { delay: 20 })
    await docs.screenshot({ path: screenshotPath('fariv-docx-edited') })
    await docs.evaluate(() => (window as unknown as DocsWindow).__aidocs!.save())
    await expect.poll(() => part(doc, 'word/document.xml'), POLL).toContain('Relatório revisado em português.')
  } finally {
    await closeAndSaveVideo(first, 'fariv-docx')
  }

  const second = await launchShell({ onboardingSeen: true, videoDir: 'fariv-docx-reopen', openFile: doc })
  try {
    const docs = await waitForPageWithUrl(second.app, '://docs/')
    await docsReady(docs)
    expect(await docs.evaluate(() => (window as unknown as DocsWindow).__aidocs!.editor!.getText())).toContain(
      'Relatório revisado em português.',
    )
    await docs.screenshot({ path: screenshotPath('fariv-docx-reopened') })
  } finally {
    await closeAndSaveVideo(second, 'fariv-docx-reopen')
  }
})

// ---------------------------------------------------------------- Apresentações (.pptx)

const W = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'

/** One slide with a text box across the middle of the stage, so a double click lands on it. */
async function buildDeck(path: string): Promise<void> {
  const slide =
    `<?xml version="1.0"?><p:sld ${P} ${R} ${W}><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>` +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Titulo"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="914400" y="1828800"/><a:ext cx="7315200" cy="1485900"/></a:xfrm><a:prstGeom prst="rect"/></p:spPr>' +
    '<p:txBody><a:bodyPr wrap="square"/><a:lstStyle/><a:p><a:r><a:rPr lang="pt-BR" sz="4000"/><a:t>Resultados</a:t></a:r></a:p></p:txBody></p:sp>' +
    '</p:spTree></p:cSld></p:sld>'
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
      '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' +
      '</Types>',
  )
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
      '</Relationships>',
  )
  zip.file(
    'ppt/presentation.xml',
    `<?xml version="1.0"?><p:presentation ${P} ${R} ${W}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>` +
      '<p:sldSz cx="9144000" cy="5143500"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>',
  )
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>' +
      '</Relationships>',
  )
  zip.file('ppt/slides/slide1.xml', slide)
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }))
}

interface SlidesWindow {
  slidesApi: { save(): Promise<{ ok: boolean; error?: string }> }
}

test('apresentação: editar, salvar e reabrir um .pptx', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fariv-pptx-'))
  const deck = join(dir, 'apresentacao.pptx')
  await buildDeck(deck)

  const first = await launchShell({ onboardingSeen: true, videoDir: 'fariv-pptx', openFile: deck })
  try {
    const slides = await waitForPageWithUrl(first.app, '://slides/')
    const stage = slides.locator('.stage-wrap').first()
    await expect(slides.locator('.stage-wrap canvas').first()).toBeVisible({ timeout: 30_000 })
    await slides.waitForTimeout(1_000)
    // the text box covers the stage centre: double click enters text editing
    await stage.dblclick()
    await slides.keyboard.press('ControlOrMeta+a')
    await slides.keyboard.type('Resultados de Março', { delay: 30 })
    await slides.keyboard.press('Escape')
    await slides.screenshot({ path: screenshotPath('fariv-pptx-edited') })
    const saved = await slides.evaluate(() => (window as unknown as SlidesWindow).slidesApi.save())
    expect(saved.ok, saved.error).toBe(true)
    await expect.poll(() => part(deck, 'ppt/slides/slide1.xml'), POLL).toContain('Resultados de Março')
  } finally {
    await closeAndSaveVideo(first, 'fariv-pptx')
  }

  const second = await launchShell({ onboardingSeen: true, videoDir: 'fariv-pptx-reopen', openFile: deck })
  try {
    const slides = await waitForPageWithUrl(second.app, '://slides/')
    await expect(slides.locator('.stage-wrap canvas').first()).toBeVisible({ timeout: 30_000 })
    await slides.waitForTimeout(1_000)
    await slides.screenshot({ path: screenshotPath('fariv-pptx-reopened') })
    // the reopened deck saves again without losing the edit
    const saved = await slides.evaluate(() => (window as unknown as SlidesWindow).slidesApi.save())
    expect(saved.ok, saved.error).toBe(true)
    expect(await part(deck, 'ppt/slides/slide1.xml')).toContain('Resultados de Março')
  } finally {
    await closeAndSaveVideo(second, 'fariv-pptx-reopen')
  }
})
