import { test, expect } from '@playwright/test'
import { launchShell, closeAndSaveVideo, waitForPageWithUrl, screenshotPath } from './helpers'

/**
 * Fariv identity: the title row carries the Fariv wordmark and the central switcher
 * between Planilhas, Documentos and Apresentações; picking a space starts a document of
 * that kind or returns to the last one; editors open with the compact (lean) ribbon.
 */

test('seletor central: Planilhas, Documentos e Apresentações', async () => {
  const launched = await launchShell({ onboardingSeen: true, videoDir: 'fariv-switcher', lang: 'pt' })
  const { app, page } = launched
  try {
    const switcher = page.locator('[data-testid=space-switcher]')
    await expect(switcher).toBeVisible()
    await expect(switcher.locator('.fariv-space')).toHaveText(['Planilhas', 'Documentos', 'Apresentações'])
    await expect(page.locator('.fariv-wordmark')).toContainText('FARIV')
    await expect(page).toHaveTitle(/Fariv/)
    // Home: no space selected
    await expect(switcher.locator('.fariv-space.active')).toHaveCount(0)
    await page.screenshot({ path: screenshotPath('fariv-home') })

    const documentTabs = page.locator('.tab-bar .tab-item:not(.tab-home)')

    // no spreadsheet open: Planilhas starts one
    await switcher.locator('[data-space=sheets]').click()
    const sheets = await waitForPageWithUrl(app, '://sheets/')
    await expect(documentTabs).toHaveCount(1)
    await expect(switcher.locator('.fariv-space.active')).toHaveText('Planilhas')
    // lean bar: the ribbon starts compact
    await expect(sheets.locator('.ribbon-collapsible.ribbon-compact').first()).toBeVisible({ timeout: 30_000 })
    await page.screenshot({ path: screenshotPath('fariv-switcher-sheets') })
    // the editor is its own view under the shell chrome: capture it separately
    await sheets.waitForTimeout(1_000)
    await sheets.screenshot({ path: screenshotPath('fariv-sheets-compact') })

    await switcher.locator('[data-space=docs]').click()
    const docs = await waitForPageWithUrl(app, '://docs/')
    await expect(documentTabs).toHaveCount(2)
    await expect(switcher.locator('.fariv-space.active')).toHaveText('Documentos')
    await expect(docs.locator('.ribbon-collapsible.ribbon-compact').first()).toBeVisible({ timeout: 30_000 })
    await docs.waitForTimeout(1_000)
    await docs.screenshot({ path: screenshotPath('fariv-docs-compact') })

    await switcher.locator('[data-space=slides]').click()
    const slides = await waitForPageWithUrl(app, '://slides/')
    await expect(documentTabs).toHaveCount(3)
    await expect(switcher.locator('.fariv-space.active')).toHaveText('Apresentações')
    await expect(slides.locator('.ribbon-collapsible.ribbon-compact').first()).toBeVisible({ timeout: 30_000 })
    await slides.waitForTimeout(1_000)
    await slides.screenshot({ path: screenshotPath('fariv-slides-compact') })

    // back to Planilhas: the open spreadsheet, not a new one
    await switcher.locator('[data-space=sheets]').click()
    await expect(switcher.locator('.fariv-space.active')).toHaveText('Planilhas')
    await expect(documentTabs).toHaveCount(3)
    await expect(page.locator('.tab-bar .tab-item.active')).toHaveCount(1)
    await page.screenshot({ path: screenshotPath('fariv-switcher-back') })
  } finally {
    await closeAndSaveVideo(launched, 'fariv-switcher')
  }
})
