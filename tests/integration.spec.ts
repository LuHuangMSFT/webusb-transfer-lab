import { expect, test } from '@playwright/test'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {} from './harness'
import type { PayloadReply } from '../src/payload'
import type { PayloadProgress } from '../src/types'

for (const size of [1024, 1024 ** 3]) {
  test(`production worker generates and verifies ${size} bytes at the Pages base`, async ({ page }) => {
    test.setTimeout(180_000)
    const filename = (await readdir(join('dist', 'assets'))).find((name) => name.startsWith('payload.worker-') && name.endsWith('.js'))
    expect(filename).toBeDefined()
    await page.goto('./')
    const result = await page.evaluate(async ({ url, size }) => {
      const worker = new Worker(url, { type: 'module' })
      try {
        const progress: PayloadProgress[] = []
        const prepared = await new Promise<PayloadReply>((resolve, reject) => {
          worker.onmessage = (event: MessageEvent<PayloadReply>) => {
            if ('operation' in event.data && event.data.operation === 'progress') progress.push(event.data.progress)
            else resolve(event.data)
          }
          worker.onerror = (event) => reject(new Error(event.message))
          worker.postMessage({ id: 1, operation: 'prepare', size, seed: 'test', index: 1, reportProgress: true })
        })
        if ('error' in prepared || prepared.operation !== 'prepare') throw new Error('Unexpected worker reply')
        const digest = await crypto.subtle.digest('SHA-256', prepared.buffer)
        const expected = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
        const byteLength = prepared.buffer.byteLength
        const received = new Uint8Array(prepared.buffer)
        received[0] ^= 1
        const hashed = await new Promise<PayloadReply>((resolve, reject) => {
          worker.onmessage = (event) => resolve(event.data)
          worker.onerror = (event) => reject(new Error(event.message))
          worker.postMessage({ id: 2, operation: 'hash', buffer: received.buffer }, [received.buffer])
        })
        if ('error' in hashed || hashed.operation !== 'hash') throw new Error('Unexpected hash reply')
        return { byteLength, originalMatches: prepared.sha256 === expected, corruptionDetected: prepared.sha256 !== hashed.sha256,
          sha256: prepared.sha256, progress }
      } finally {
        worker.terminate()
      }
    }, { url: `/webusb-transfer-lab/assets/${filename}`, size })
    expect(result).toMatchObject({ byteLength: size, originalMatches: true, corruptionDetected: true })
    expect(result.progress[0]).toEqual({ stage: 'generate', completedBytes: 0, totalBytes: size })
    expect(result.progress.at(-1)).toEqual({ stage: 'hash', completedBytes: size, totalBytes: size })
    const byteCounts = result.progress.filter((update) => update.stage === 'generate').map((update) => update.completedBytes)
    expect(byteCounts).toEqual([...new Set(byteCounts)].sort((a, b) => a - b))
    expect(byteCounts.at(-1)).toBe(size)
    if (size === 1024 ** 3) {
      expect(byteCounts.some((completed) => completed > 0 && completed < size)).toBe(true)
      expect(result.sha256).toBe('ae2e10fef8f6f5ad247402078f1e3f0e28c0fa15fbd5b684fea91b143c9c5331')
    }
  })
}

for (const pattern of ['round-trip', 'batch'] as const) {
  test(`browser worker, ${pattern} runner and real IndexedDB round-trip through exports (simulated device)`, async ({ page }) => {
    await page.goto('http://127.0.0.1:4174/webusb-transfer-lab/tests/harness.html')
    await page.waitForFunction(() => typeof window.simulate === 'function')
    const result = await page.evaluate((mode) => window.simulate(mode, 'success'), pattern)
    expect(result.finishError).toBe('')
    expect(result.report.run.status).toBe('completed')
    expect(result.report.files).toHaveLength(6)
    expect(result.report.run.totals.uploadedBytes).toBe(6 * 65536)
    expect(result.report.run.totals.downloadedBytes).toBe(6 * 65536)
    expect(result.report.files.every((file) => file.passed && file.expectedSha256 === file.actualSha256)).toBe(true)
    expect(result.peakFiles).toBe(pattern === 'batch' ? 3 : 1)
    expect(result.phoneFiles).toBe(0)
    expect(result.statistics.passed).toBe(6)
    expect(result.csv.split('\r\n').filter((line) => line.startsWith('"round"'))).toHaveLength(2)
  })
}

test('actual browser worker detects corrupted simulated data and persists partial evidence', async ({ page }) => {
  await page.goto('http://127.0.0.1:4174/webusb-transfer-lab/tests/harness.html')
  await page.waitForFunction(() => typeof window.simulate === 'function')
  const result = await page.evaluate(() => window.simulate('batch', 'corrupt'))
  expect(result.finishError).toBe('')
  expect(result.report.run.status).toBe('failed')
  expect(result.report.run.error).toContain('SHA-256 mismatch')
  expect(result.statistics.passed).toBe(0)
  expect(result.report.files).toHaveLength(3)
  expect(result.phoneFiles).toBe(0)
})

test('Stop during an IndexedDB commit preserves consistent partial counters', async ({ page }) => {
  await page.goto('http://127.0.0.1:4174/webusb-transfer-lab/tests/harness.html')
  await page.waitForFunction(() => typeof window.simulate === 'function')
  const result = await page.evaluate(() => window.simulate('round-trip', 'cancel-commit'))
  expect(result.finishError).toBe('')
  expect(result.report.run.status).toBe('canceled')
  expect(result.report.run.completedFiles).toBe(1)
  expect(result.statistics.passed).toBe(1)
  expect(result.report.files).toHaveLength(1)
})

test('failed file persistence leaves the last consistent report exportable', async ({ page }) => {
  await page.goto('http://127.0.0.1:4174/webusb-transfer-lab/tests/harness.html')
  await page.waitForFunction(() => typeof window.simulate === 'function')
  const result = await page.evaluate(() => window.simulate('round-trip', 'fail-commit'))
  expect(result.finishError).toContain('does not match')
  expect(result.report.run.status).toBe('running')
  expect(result.report.run.error).toContain('Unfinalized')
  expect(result.report.files).toHaveLength(0)
  expect(result.report.run.completedFiles).toBe(0)
  expect(result.phoneFiles).toBe(0)
})

test('diagnostic runner markers survive real IndexedDB and JSON/CSV exports', async ({ page }) => {
  await page.goto('http://127.0.0.1:4174/webusb-transfer-lab/tests/harness.html')
  await page.waitForFunction(() => typeof window.simulate === 'function')
  const result = await page.evaluate(() => window.simulate('round-trip', 'success', true))
  expect(result.report.run.status).toBe('completed')
  expect(result.report.run.environment.diagnosticsEnabled).toBe(true)
  expect(result.csv.split('\r\n')[0]).toContain('"diagnostics_enabled"')
  expect(result.csv.split('\r\n')[1]).toMatch(/,"true"$/)
  expect(result.diagnostics.entries.some((entry) => entry.event === 'run.phase.end'
    && entry.context.phase === 'download' && entry.context.round === 1 && entry.context.index === 1)).toBe(true)
})

for (const tags of ['', '=SUM(1,2), cable A']) {
  test(`UI starts and saves a ${tags ? 'tagged' : 'completely untagged'} run (simulated device)`, async ({ page }) => {
    // Only replace the device boundary in this development-server test. The
    // production UI, worker, runner and IndexedDB reporting still execute.
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
        }
      `,
    }))
    await page.goto('http://127.0.0.1:4174/webusb-transfer-lab/')
    await page.locator('#file-count').fill('1')
    await page.locator('#rounds').fill('1')
    await page.locator('#size-unit').selectOption('1')
    await page.locator('#file-size').fill('1024')
    await page.locator('#tags').fill(tags)
    await expect(page.locator('#notes')).toHaveValue('')
    await expect(page.locator('#settings-error')).toHaveText('Workload is valid.')
    await page.locator('#connect').click()
    await expect(page.locator('#start')).toBeEnabled()
    await page.locator('#start').click()
    await expect(page.locator('#run-badge')).toHaveText('Completed · verified')
    await expect(page.locator('#saved-reports')).toContainText(tags || 'Untagged run')
    await page.reload()
    await expect(page.locator('#saved-reports')).toContainText(tags || 'Untagged run')
    await expect(page.locator('#file-count')).toHaveValue('1')
    await expect(page.locator('#rounds')).toHaveValue('1')
    await expect(page.locator('#file-size')).toHaveValue('1024')
    await expect(page.locator('#size-unit')).toHaveValue('1')
    await expect(page.locator('#tags')).toHaveValue(tags)
    await expect(page.locator('#connection-badge')).toHaveText('Disconnected')
    await expect(page.locator('#start')).toBeDisabled()
    const jsonPromise = page.waitForEvent('download')
    await page.locator('#saved-reports button').filter({ hasText: /^JSON$/ }).click()
    const jsonFile = await jsonPromise
    const report = JSON.parse(await readFile((await jsonFile.path())!, 'utf8'))
    expect(report.run.settings.tags).toBe(tags)
    expect(report.run.settings.notes).toBe('')
    expect(report.run.settings).not.toHaveProperty('buildLabel')
    expect(report.run.settings).not.toHaveProperty('architecture')
    expect(report.run.completedFiles).toBe(1)
    expect(report.files[0].expectedSha256).toBe(report.files[0].actualSha256)
    const csvPromise = page.waitForEvent('download')
    await page.locator('#saved-reports button').filter({ hasText: /^CSV$/ }).click()
    const csvFile = await csvPromise
    const csv = await readFile((await csvFile.path())!, 'utf8')
    expect(csv.split('\r\n')[0]).toContain('"tags"')
    if (tags) expect(csv).toContain(`"'${tags}"`)
  })
}
