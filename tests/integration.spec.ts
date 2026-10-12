import { expect, test } from '@playwright/test'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type {} from './harness'
import type { PayloadReply } from '../src/payload'

test('production worker loads at the Pages base and hashes actual returned bytes', async ({ page }) => {
  const filename = (await readdir(join('dist', 'assets'))).find((name) => name.startsWith('payload.worker-') && name.endsWith('.js'))
  expect(filename).toBeDefined()
  await page.goto('./')
  const result = await page.evaluate(async (url) => {
    const worker = new Worker(url, { type: 'module' })
    try {
      const prepared = await new Promise<PayloadReply>((resolve, reject) => {
        worker.onmessage = (event) => resolve(event.data)
        worker.onerror = (event) => reject(new Error(event.message))
        worker.postMessage({ id: 1, operation: 'prepare', size: 1024, seed: 'test', index: 1 })
      })
      if ('error' in prepared || prepared.operation !== 'prepare') throw new Error('Unexpected worker reply')
      const digest = await crypto.subtle.digest('SHA-256', prepared.buffer)
      const expected = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
      const received = new Uint8Array(prepared.buffer).slice()
      received[0] ^= 1
      const hashed = await new Promise<PayloadReply>((resolve, reject) => {
        worker.onmessage = (event) => resolve(event.data)
        worker.onerror = (event) => reject(new Error(event.message))
        worker.postMessage({ id: 2, operation: 'hash', buffer: received.buffer }, [received.buffer])
      })
      if ('error' in hashed) throw new Error(hashed.error)
      return { originalMatches: prepared.sha256 === expected, corruptionDetected: prepared.sha256 !== hashed.sha256 }
    } finally {
      worker.terminate()
    }
  }, `/webusb-transfer-lab/assets/${filename}`)
  expect(result).toEqual({ originalMatches: true, corruptionDetected: true })
})

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
