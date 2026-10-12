import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

async function controlInstallPrompt(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.addEventListener('beforeinstallprompt', (event) => {
      if (event.isTrusted) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    }, true)
  })
}

async function offerInstall(page: Page, outcome: 'accepted' | 'dismissed' | 'fail' = 'accepted'): Promise<void> {
  const prevented = await page.evaluate((outcome) => {
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      async prompt() {
        document.body.dataset.installPrompts = String(Number(document.body.dataset.installPrompts ?? 0) + 1)
        if (outcome === 'fail') throw new DOMException('private-install-details', 'NotAllowedError')
      },
      userChoice: new Promise((resolve) => {
        window.addEventListener('finish-test-install', () => resolve({ outcome, platform: 'web' }), { once: true })
      }),
    })
    window.dispatchEvent(event)
    return event.defaultPrevented
  }, outcome)
  expect(prevented).toBe(true)
}

test('Chromium recognizes the scoped PWA manifest and installable local icons', async ({ page, request }) => {
  await page.goto('./')
  const cdp = await page.context().newCDPSession(page)
  const manifest = await cdp.send('Page.getAppManifest')
  expect(manifest.errors).toEqual([])
  expect(new URL(manifest.url).pathname).toBe('/webusb-transfer-lab/manifest.webmanifest')
  const data = JSON.parse(manifest.data!)
  expect(data.name).toBe('WebUSB Transfer Lab')
  expect(data.display).toBe('standalone')
  expect(data.prefer_related_applications).toBe(false)
  for (const key of ['id', 'scope', 'start_url']) {
    const url = new URL(data[key], manifest.url)
    expect(url.origin).toBe(new URL(page.url()).origin)
    expect(url.pathname).toBe('/webusb-transfer-lab/')
    expect(url.search).toBe('')
  }
  for (const size of [192, 512]) {
    const icon = data.icons.find((icon: { sizes: string }) => icon.sizes === `${size}x${size}`)
    expect(icon.type).toBe('image/png')
    const url = new URL(icon.src, manifest.url)
    expect(url.origin).toBe(new URL(page.url()).origin)
    expect(url.pathname).toMatch(/^\/webusb-transfer-lab\/icons\//)
    const response = await request.get(url.href)
    expect(response.ok()).toBe(true)
    const png = await response.body()
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(png.readUInt32BE(16)).toBe(size)
    expect(png.readUInt32BE(20)).toBe(size)
  }
  expect(data.icons.some((icon: { purpose: string }) => icon.purpose.includes('maskable'))).toBe(true)
  expect((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors).toEqual([])
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0)
  expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull()
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', '/webusb-transfer-lab/icons/app.svg')
  await expect(page.locator('#connection-badge')).toHaveText('Disconnected')
})

test('install prompt requires a click and acceptance is not reported as completed installation', async ({ page }) => {
  await controlInstallPrompt(page)
  await page.goto('./')
  await offerInstall(page)
  await expect(page.locator('#install-app')).toBeVisible()
  expect(await page.getAttribute('body', 'data-install-prompts')).toBeNull()
  await page.locator('#install-app').click()
  await expect(page.locator('#install-app')).toBeDisabled()
  await expect(page.locator('#connect')).toBeDisabled()
  await expect(page.locator('#install-status')).toContainText('Finish installation')
  await page.evaluate(() => window.dispatchEvent(new Event('finish-test-install')))
  await expect(page.locator('#install-status')).toContainText('Installation requested')
  await expect(page.locator('#install-app')).toBeHidden()
  await expect(page.locator('#connect')).toBeEnabled()
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')))
  await expect(page.locator('#install-status')).toContainText('App installed')
  await expect(page.locator('#connection-badge')).toHaveText('Disconnected')
  expect(await page.getAttribute('body', 'data-install-prompts')).toBe('1')
})

test('installation completion wins a race with the prompt choice callback', async ({ page }) => {
  await controlInstallPrompt(page)
  await page.goto('./')
  await offerInstall(page)
  await page.locator('#install-app').click()
  await page.evaluate(() => {
    window.dispatchEvent(new Event('appinstalled'))
    window.dispatchEvent(new Event('finish-test-install'))
  })
  await expect(page.locator('#install-status')).toContainText('App installed')
  await expect(page.locator('#install-app')).toBeHidden()
})

test('dismissal consumes the prompt without automatically prompting again', async ({ page }) => {
  await controlInstallPrompt(page)
  await page.goto('./')
  await offerInstall(page, 'dismissed')
  await page.locator('#install-app').click()
  await page.evaluate(() => window.dispatchEvent(new Event('finish-test-install')))
  await expect(page.locator('#install-status')).toContainText('Installation canceled')
  await expect(page.locator('#install-app')).toBeHidden()
  await expect(page.locator('#connect')).toBeEnabled()
  expect(await page.getAttribute('body', 'data-install-prompts')).toBe('1')
  await offerInstall(page)
  await expect(page.locator('#install-app')).toBeEnabled()
})

test('install failures are visible, sanitized and do not block ordinary use', async ({ page }) => {
  const messages: string[] = []
  page.on('console', (message) => messages.push(message.text()))
  await controlInstallPrompt(page)
  await page.goto('./')
  await offerInstall(page, 'fail')
  await page.locator('#install-app').click()
  await expect(page.locator('#install-status')).toContainText('browser install menu')
  await expect(page.locator('#connect')).toBeEnabled()
  await expect(page.locator('#install-app')).toBeHidden()
  expect(messages.join('\n')).toContain('app.install.failed')
  expect(messages.join('\n')).not.toContain('private-install-details')
})

test('standalone app mode keeps the normal WebUSB UI without offering another install', async ({ page }) => {
  await page.addInitScript(() => {
    const matchMedia = window.matchMedia.bind(window)
    window.matchMedia = (query) => {
      const result = matchMedia(query)
      if (query === '(display-mode: standalone)') Object.defineProperty(result, 'matches', { value: true })
      return result
    }
  })
  await page.goto('./')
  await expect(page.locator('#install-status')).toContainText('Running as an app')
  await expect(page.locator('#install-app')).toBeHidden()
  await expect(page.locator('#connect')).toBeEnabled()
  await expect(page.locator('#connection-badge')).toHaveText('Disconnected')
  await expect(page.locator('#start')).toBeDisabled()
})

test('installation events cannot reload or interrupt an active transfer (simulated device)', async ({ page }) => {
  await controlInstallPrompt(page)
  await page.route('**/src/adb-client.ts', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: `
      import { SimulatedDevice } from '/webusb-transfer-lab/tests/harness.ts';
      export class AdbClient extends SimulatedDevice {
        constructor() { super('success'); this.connected = false; }
        async connect() { this.connected = true; }
        async disconnect() { this.connected = false; }
        getLeftovers() { return []; }
        async cleanupLeftovers() {}
        async writeFile(runId, name, bytes) {
          if (name !== 'probe.bin') {
            document.body.dataset.transferPaused = 'true';
            await new Promise(resolve => window.addEventListener('resume-test-transfer', resolve, {once:true}));
          }
          return super.writeFile(runId, name, bytes);
        }
      }
    `,
  }))
  await page.goto('http://127.0.0.1:4174/webusb-transfer-lab/')
  await page.locator('#file-count').fill('1')
  await page.locator('#rounds').fill('1')
  await page.locator('#size-unit').selectOption('1')
  await page.locator('#file-size').fill('1024')
  await offerInstall(page)
  await expect(page.locator('#install-app')).toBeEnabled()
  await page.locator('#connect').click()
  await expect(page.locator('#start')).toBeEnabled()
  await expect(page.locator('#install-app')).toBeDisabled()
  await page.locator('#disconnect').click()
  await expect(page.locator('#install-app')).toBeEnabled()
  await page.locator('#connect').click()
  await page.locator('#start').click()
  await expect(page.locator('body')).toHaveAttribute('data-transfer-paused', 'true')
  await expect(page.locator('#stop')).toBeEnabled()
  await offerInstall(page)
  await expect(page.locator('#install-app')).toBeDisabled()
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')))
  await expect(page.locator('#stop')).toBeEnabled()
  await expect(page.locator('body')).toHaveAttribute('data-transfer-paused', 'true')
  await page.evaluate(() => window.dispatchEvent(new Event('resume-test-transfer')))
  await expect(page.locator('#run-badge')).toHaveText('Completed · verified')
  await expect(page.locator('#file-size')).toHaveValue('1024')
})
