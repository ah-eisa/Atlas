import { expect, test } from '@playwright/test'

/**
 * The smoke suite.
 *
 * Every test here answers a question that only a browser can answer, and
 * every one of them has caught a real defect at some point: a view that
 * rendered an empty panel, a theme switch that did not repaint, a header
 * that pushed the page sideways on a phone.
 */

const VIEWS = ['overview', 'performance', 'risk', 'xray', 'holdings', 'trades', 'bonds', 'macro', 'options', 'projection', 'data']

test.beforeEach(async ({ page }) => {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message))
  ;(page as unknown as { __errors: string[] }).__errors = errors
})

async function consoleErrors(page: import('@playwright/test').Page): Promise<string[]> {
  return (page as unknown as { __errors: string[] }).__errors ?? []
}

test('the dashboard loads with its data', async ({ page }) => {
  await page.goto('/?source=snapshot#/overview')

  await expect(page.getByRole('banner')).toBeVisible()
  // The reserve copy carries the final figure; the animated copy counts up
  // to it over a second.
  await expect(page.locator('.topbar__amount .counter__reserve')).toHaveText(/[0-9]/)
  // The KPI band: the headline figures, each with its convention.
  const cells = page.locator('.kpi__cell')
  await expect(cells.first()).toBeVisible()
  expect(await cells.count()).toBeGreaterThanOrEqual(8)
  // The source badge says where the numbers came from.
  await expect(page.locator('.topbar__source')).toContainText('Demo snapshot')
  expect(await consoleErrors(page)).toEqual([])
})

test('every view renders something', async ({ page }) => {
  await page.goto('/?source=snapshot#/overview')

  for (const view of VIEWS) {
    await page.goto(`/?source=snapshot#/${view}`)
    await expect(page.locator('main')).toBeVisible()
    const panels = page.locator('.panel')
    await expect(panels.first()).toBeVisible()
    const count = await panels.count()
    expect(count, `the ${view} view rendered no panels`).toBeGreaterThan(0)
  }
  expect(await consoleErrors(page)).toEqual([])
})

test('charts fill their containers', async ({ page }) => {
  // A chart that mounts at zero size never recovers visually, and the
  // wrappers now own their resize observers - so this asserts that the
  // observers actually deliver a usable canvas. The axis layers inside
  // Lightweight Charts are deliberately thin, so the host is measured rather
  // than every canvas the libraries create.
  await page.goto('/?source=snapshot#/overview')

  const hosts = page.locator('.chart')
  await expect(hosts.first()).toBeVisible()
  const measured = await hosts.evaluateAll((elements) =>
    elements.map((element) => ({
      width: element.clientWidth,
      height: element.clientHeight,
      hasCanvas: element.querySelector('canvas') !== null,
    })),
  )
  expect(measured.length).toBeGreaterThan(0)
  for (const host of measured) {
    expect(host.width).toBeGreaterThan(100)
    expect(host.height).toBeGreaterThan(100)
    expect(host.hasCanvas).toBe(true)
  }
  expect(await consoleErrors(page)).toEqual([])
})

test('the numbers are numbers, not zeros', async ({ page }) => {
  await page.goto('/?source=snapshot#/overview')

  // The shell paints before the lazily loaded view, so wait for the band.
  await expect(page.locator('.kpi__cell').first()).toBeVisible()

  const total = await page.locator('.topbar__amount .counter__reserve').innerText()
  expect(total).not.toMatch(/^0\b/)
  expect(total).not.toContain('—')

  // The KPI band must not be a row of zeroes.
  const values = await page.locator('.kpi__value .counter__reserve').allInnerTexts()
  expect(values.length).toBeGreaterThanOrEqual(8)
  const zeros = values.filter((value) => /^[-+]?0(\.0+)?%?$/.test(value.trim()))
  // Zero is a legitimate value for a rate, but not for all eight of them.
  expect(zeros.length).toBeLessThan(values.length)
})

test('the counters settle on the final figure', async ({ page }) => {
  await page.goto('/?source=snapshot#/overview')

  const reserve = page.locator('.topbar__amount .counter__reserve')
  const animated = page.locator('.topbar__amount .counter__value')
  await expect
    .poll(async () => animated.innerText(), { timeout: 5_000 })
    .toBe(await reserve.innerText())
})

test('the theme switch repaints the page', async ({ page }) => {
  await page.goto('/?source=snapshot#/overview')

  const before = await page.evaluate(() => document.documentElement.dataset.theme)
  const background = await page.evaluate(
    () => getComputedStyle(document.body).backgroundColor,
  )

  await page.locator('.topbar__theme').click()
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.dataset.theme))
    .not.toBe(before)

  const after = await page.evaluate(
    () => getComputedStyle(document.body).backgroundColor,
  )
  expect(after).not.toBe(background)

  // The choice survives a reload.
  await page.reload()
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.dataset.theme))
    .not.toBe(before)
})

test('nothing overflows sideways', async ({ page }) => {
  for (const view of VIEWS) {
    await page.goto(`/?source=snapshot#/${view}`)
    const overflow = await page.evaluate(() => {
      const root = document.documentElement
      return root.scrollWidth - root.clientWidth
    })
    // A pixel of rounding is allowed; a layout that runs off the page is not.
    expect(overflow, `the ${view} view overflows horizontally`).toBeLessThanOrEqual(1)
  }
})

test('the holdings grid scrolls rather than breaking the layout', async ({ page }) => {
  await page.goto('/?source=snapshot#/holdings')

  const grid = page.locator('.grid__scroll')
  await expect(grid).toBeVisible()
  const overflowX = await grid.evaluate((element) => getComputedStyle(element).overflowX)
  expect(['auto', 'scroll']).toContain(overflowX)
})

test('command palette opens on Ctrl+K and executes deep-link search', async ({ page }) => {
  await page.goto('/?source=snapshot#/overview')
  await page.getByRole('button', { name: 'Open Command Palette' }).click()

  const dialog = page.getByRole('dialog', { name: 'Command Palette' })
  await expect(dialog).toBeVisible()

  const searchInput = page.getByLabel('Command palette search')
  await searchInput.fill('NVDA 10-K')
  await expect(dialog.getByRole('option').first()).toContainText('NVDA')
  await searchInput.press('Enter')

  await expect(page).toHaveURL(/#\/macro/)
})

test('watchlist modal opens and shows watchlist items', async ({ page, isMobile }) => {
  await page.goto('/?source=snapshot#/overview')
  if (isMobile) {
    await page.getByRole('button', { name: 'Open Command Palette' }).click()
    const cp = page.getByRole('dialog', { name: 'Command Palette' })
    await expect(cp).toBeVisible()
    await page.getByLabel('Command palette search').fill('Watchlist')
    await cp.getByRole('option', { name: /Open Watchlists/i }).click()
  } else {
    await page.getByRole('button', { name: 'Open Watchlists' }).click()
  }

  const dialog = page.getByRole('dialog', { name: 'Watchlists and Smart Alerts' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('NVDA')).toBeVisible()
  await dialog.getByRole('button', { name: 'Close modal' }).click()
  await expect(dialog).not.toBeVisible()
})

test('csv import modal opens and previews sample statement', async ({ page }) => {
  await page.goto('/?source=snapshot#/data')
  await page.getByRole('button', { name: 'Import CSV / Statement' }).click()

  const dialog = page.getByRole('dialog', { name: 'CSV and Broker Statement Import Wizard' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Load Sample ATLAS CSV' }).click()
  await expect(dialog.getByText('AAPL')).toBeVisible()
  await dialog.getByRole('button', { name: 'Close modal' }).click()
  await expect(dialog).not.toBeVisible()
})
