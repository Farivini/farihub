/**
 * Fariv app icon set, rendered from apps/shell/build/fariv-icon.svg with headless Chromium:
 * icon.png / icon-mac.png (1024), icons/<n>x<n>.png (Linux hicolor sizes), icon.ico
 * (16–256, PNG entries) and icon.icns (PNG entries). Run: node tools/gen-fariv-icons.mjs
 */
import { chromium } from 'playwright-core'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const build = join(here, '../apps/shell/build')
const svg = readFileSync(join(build, 'fariv-icon.svg'), 'utf8')

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
).catch(() => chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }))
const page = await browser.newPage()
const png = {}
for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`,
  )
  png[size] = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } })
}
await browser.close()

mkdirSync(join(build, 'icons'), { recursive: true })
for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) writeFileSync(join(build, 'icons', `${size}x${size}.png`), png[size])
writeFileSync(join(build, 'icon.png'), png[1024])
writeFileSync(join(build, 'icon-mac.png'), png[1024])

// ICO with PNG-compressed entries (Windows Vista+).
const icoSizes = [16, 32, 48, 64, 128, 256]
const header = Buffer.alloc(6 + 16 * icoSizes.length)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(icoSizes.length, 4)
let offset = header.length
icoSizes.forEach((size, i) => {
  const at = 6 + 16 * i
  header.writeUInt8(size >= 256 ? 0 : size, at)
  header.writeUInt8(size >= 256 ? 0 : size, at + 1)
  header.writeUInt16LE(1, at + 4)
  header.writeUInt16LE(32, at + 6)
  header.writeUInt32LE(png[size].length, at + 8)
  header.writeUInt32LE(offset, at + 12)
  offset += png[size].length
})
writeFileSync(join(build, 'icon.ico'), Buffer.concat([header, ...icoSizes.map((s) => png[s])]))

// ICNS with PNG entries: ic07 128, ic08 256, ic09 512, ic10 1024 (512@2x).
const icns = [['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]].map(([type, size]) => {
  const head = Buffer.alloc(8)
  head.write(type, 0, 'ascii')
  head.writeUInt32BE(8 + png[size].length, 4)
  return Buffer.concat([head, png[size]])
})
const body = Buffer.concat(icns)
const icnsHead = Buffer.alloc(8)
icnsHead.write('icns', 0, 'ascii')
icnsHead.writeUInt32BE(8 + body.length, 4)
writeFileSync(join(build, 'icon.icns'), Buffer.concat([icnsHead, body]))
console.log('Fariv icons written to apps/shell/build')
