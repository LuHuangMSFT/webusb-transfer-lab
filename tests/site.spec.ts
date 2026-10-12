import { expect, test } from '@playwright/test'
import type { RunReport } from '../src/types'

function simulatedReport(withFix = false): RunReport {
  const id = withFix ? 'cf6a2db7-15fb-4f73-97ba-c3f58d607c9a' : '0ec5f56b-ef37-4c88-a186-b527203536b2'
  const uploadMs = withFix ? 10 : 20
  return {
    schemaVersion: 1,
    run: {
      schemaVersion: 1,
      id,
      settings: {
        fileCount: 1, fileSizeBytes: 1024, rounds: 1, pattern: 'round-trip',
        seed: 'browser-test', buildLabel: withFix ? 'with-fix' : 'baseline', architecture: 'arm64', notes: 'Simulated browser-test fixture',
      },
      device: { model: 'Simulated phone', manufacturer: 'Test', features: ['shell_v2', 'stat_v2'], maxPayloadSize: 1048576 },
      environment: {
        siteCommit: 'test', siteVersion: '0.1.0', browser: 'Chromium test fixture',
        dependencies: {
          '@yume-chan/adb': '2.6.4',
          '@yume-chan/adb-daemon-webusb': '2.3.2',
          '@yume-chan/stream-extra': '2.6.1',
        },
      },
      startedAt: '2026-10-11T01:00:00.000Z', completedAt: '2026-10-11T01:00:01.000Z',
      timeOrigin: 1791680000000, status: 'completed', completedFiles: 1, expectedFiles: 1,
      totals: {
        uploadedBytes: 1024, downloadedBytes: 1024, prepareMs: 1, uploadMs, downloadMs: 30,
        verifyMs: 1, cleanupMs: 2, setupMs: 10, wallMs: 1000,
      },
      leftovers: [],
    },
    files: [{
      runId: id, round: 1, index: 1, name: 'r000001-f001.bin', bytes: 1024,
      expectedSha256: 'a'.repeat(64), actualSha256: 'a'.repeat(64),
      uploadedBytes: 1024, downloadedBytes: 1024, prepareMs: 1, uploadMs, downloadMs: 30,
      verifyMs: 1, cleanupMs: 1, passed: true,
    }],
  }
}

test('production page boots with local assets, defaults and no automatic device access', async ({ page }) => {
  const errors: string[] = []
  const external: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:4173/')) external.push(request.url())
  })
  await page.goto('./')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('round trip')
  await expect(page.locator('#file-count')).toHaveValue('10')
  await expect(page.locator('#file-size')).toHaveValue('1')
  await expect(page.locator('#rounds')).toHaveValue('3')
  await expect(page.locator('#estimate-traffic')).toHaveText('60 MiB')
  await expect(page.locator('#start')).toBeDisabled()
  await expect(page.locator('#connection-badge')).toHaveText('Disconnected')
  await expect(page.locator('#report-status')).not.toHaveText('Opening local report storage…')
  expect(errors).toEqual([])
  expect(external).toEqual([])
})

test('all file and aggregate bounds are visible before connection', async ({ page }) => {
  await page.goto('./')
  await page.locator('#build-label').selectOption('baseline')
  await page.locator('#architecture').selectOption('arm64')
  await page.locator('#file-size').fill('16')
  await page.locator('#file-count').fill('64')
  await expect(page.locator('#settings-error')).toHaveText('Workload is valid.')
  await expect(page.locator('#estimate-round')).toHaveText('1 GiB')
  await page.locator('#file-count').fill('65')
  await expect(page.locator('#settings-error')).not.toHaveText('Workload is valid.')
  await page.locator('#file-count').fill('101')
  await expect(page.locator('#file-count')).toHaveAttribute('aria-invalid', 'true')
  await page.locator('#file-count').fill('1')
  await page.locator('#file-size').fill('17')
  await expect(page.locator('#file-size')).toHaveAttribute('aria-invalid', 'true')
  await page.locator('#file-size').fill('0')
  await expect(page.locator('#file-size')).toHaveAttribute('aria-invalid', 'true')
  await expect(page.locator('#start')).toBeDisabled()
})

test('pattern estimates distinguish batch storage from per-file storage', async ({ page }) => {
  await page.goto('./')
  await expect(page.locator('#estimate-peak')).toHaveText('1 MiB')
  await page.locator('#pattern').selectOption('batch')
  await expect(page.locator('#estimate-peak')).toHaveText('10 MiB')
  await expect(page.locator('#estimate-traffic')).toHaveText('60 MiB')
})

test('unsupported WebUSB is explained and cannot start', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'usb', { value: undefined, configurable: true }))
  await page.goto('./')
  await expect(page.locator('#connection-status')).toContainText(/WebUSB|Chromium/)
  await expect(page.locator('#connect')).toBeDisabled()
  await expect(page.locator('#start')).toBeDisabled()
})

test('canceled native chooser is not a successful connection', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'usb', {
    configurable: true,
    value: {
      addEventListener() {},
      removeEventListener() {},
      async getDevices() { return [] },
      async requestDevice() { throw new DOMException('Canceled by test', 'NotFoundError') },
    },
  }))
  await page.goto('./')
  await page.locator('#connect').click()
  await expect(page.locator('#connection-badge')).toHaveText('Disconnected')
  await expect(page.locator('#app-error')).toBeVisible()
  await expect(page.locator('#start')).toBeDisabled()
  await expect(page.locator('#connect')).toBeEnabled()
})

test('simulated JSON reports produce a matched comparison without a USB device', async ({ page }) => {
  await page.goto('./')
  await page.locator('#import-a').setInputFiles({ name: 'baseline.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(simulatedReport())) })
  await page.locator('#import-b').setInputFiles({ name: 'fixed.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(simulatedReport(true))) })
  await expect(page.locator('#comparison-result')).toContainText(/50/)
  await expect(page.locator('#comparison-result')).not.toContainText('not comparable')
})

test('malformed and incompatible imports fail explicitly', async ({ page }) => {
  await page.goto('./')
  await page.locator('#import-a').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"schemaVersion":1,"privateKey":"not allowed"}') })
  await expect(page.locator('#report-error')).toBeVisible()
  await page.locator('#import-a').setInputFiles({ name: 'baseline.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(simulatedReport())) })
  const incompatible = simulatedReport(true)
  incompatible.run.settings.seed = 'different'
  await page.locator('#import-b').setInputFiles({ name: 'different.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(incompatible)) })
  await expect(page.locator('#comparison-result')).toContainText(/seed/i)
  await expect(page.locator('#comparison-result')).not.toContainText('50.0%')
})

test('local storage failure does not silently enable measurement', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { value: { open() { throw new DOMException('Storage blocked', 'SecurityError') } } })
  })
  await page.goto('./')
  await expect(page.locator('#storage-error')).toBeVisible()
  await expect(page.locator('#start')).toBeDisabled()
})

test('development CSS works without weakening the production content policy', async ({ page }) => {
  const violations: string[] = []
  page.on('console', (message) => {
    if (/violates.*Content Security Policy/i.test(message.text())) violations.push(message.text())
  })
  await page.goto('http://127.0.0.1:4174/webusb-transfer-lab/')
  await expect(page.locator('#connect')).toBeVisible()
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(244, 247, 247)')
  expect(violations).toEqual([])
  await page.goto('./')
  expect(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')).not.toContain("'unsafe-inline'")
})
