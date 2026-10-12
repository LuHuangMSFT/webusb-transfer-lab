import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import type { RunReport } from '../src/types'

async function setup(page: Page, workerMode: 'normal' | 'stall' | 'fail' | 'progress' = 'normal'): Promise<void> {
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
        async writeFile(id, name, data) {
          document.body.dataset.usbWrites = String(Number(document.body.dataset.usbWrites || 0) + 1);
          return super.writeFile(id, name, data);
        }
      }
    `,
  }))
  await page.route('**/src/payload.ts', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: `
      import { createPayloadService as original } from '/webusb-transfer-lab/src/payload.ts?actual-worker';
      export function createPayloadService() {
        const service = original();
        return {
          ...service,
          async prepare(...args) {
            document.body.dataset.generations = String(Number(document.body.dataset.generations || 0) + 1);
            if (${JSON.stringify(workerMode)} === 'fail') throw new Error('Injected preparation failure');
            if (${JSON.stringify(workerMode)} === 'stall') await new Promise(() => {});
            const [size, seed, index, onProgress] = args;
            if (${JSON.stringify(workerMode)} === 'progress' && index > 0) {
              const advance = name => new Promise(resolve => window.addEventListener(name, resolve, {once:true}));
              onProgress?.({stage:'generate', completedBytes:0, totalBytes:size});
              await advance('test-generation-half');
              onProgress?.({stage:'generate', completedBytes:Math.floor(size / 2), totalBytes:size});
              await advance('test-generation-hash');
              onProgress?.({stage:'hash', completedBytes:size, totalBytes:size});
              await advance('test-generation-done');
              return service.prepare(size, seed, index);
            }
            return service.prepare(...args);
          }
        };
      }
    `,
  }))
  await page.goto('http://127.0.0.1:4174/webusb-transfer-lab/')
  await page.locator('#file-count').fill('2')
  await page.locator('#rounds').fill('3')
  await page.locator('#size-unit').selectOption('1')
  await page.locator('#file-size').fill('1024')
}

test('shows within-file bytes, hashing activity and elapsed time before a single file is ready', async ({ page }) => {
  await setup(page, 'progress')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.locator('#file-count').fill('1')
  await page.locator('#rounds').fill('1')
  await page.locator('#pre-generate').check()
  await page.locator('#prepare-files').click()
  await expect(page.locator('#preparation-status')).toHaveText('Generating file 1 / 1.')
  await expect(page.locator('#preparation-active')).toBeVisible()
  await expect(page.locator('#preparation-active')).toHaveCSS('animation-name', 'none')
  const elapsed = await page.locator('#preparation-elapsed').textContent()
  await expect(page.locator('#preparation-elapsed')).not.toHaveText(elapsed!)
  await page.evaluate(() => window.dispatchEvent(new Event('test-generation-half')))
  await expect(page.locator('#preparation-detail')).toContainText('512 B / 1 KiB generated (50%)')
  await expect(page.locator('#preparation-file-progress')).toHaveAttribute('value', '512')
  await expect(page.locator('#preparation-progress')).toHaveAttribute('value', '0')
  await expect(page.locator('#preparation-count')).toContainText('0 / 1')
  await expect(page.locator('#start')).toBeDisabled()
  await page.evaluate(() => window.dispatchEvent(new Event('test-generation-hash')))
  await expect(page.locator('#preparation-status')).toHaveText('Computing expected SHA-256 for file 1 / 1.')
  await expect(page.locator('#preparation-file-progress')).not.toHaveAttribute('value')
  await expect(page.locator('#preparation-detail')).toContainText('does not report hash progress')
  await expect(page.locator('#preparation-progress')).toHaveAttribute('value', '0')
  await page.evaluate(() => window.dispatchEvent(new Event('test-generation-done')))
  await expect(page.locator('#preparation-status')).toContainText('Ready.')
  await expect(page.locator('#preparation-count')).toContainText('1 / 1')
  await expect(page.locator('#preparation-current')).toBeHidden()
  await expect(page.locator('#preparation-active')).toBeHidden()
  const finished = await page.locator('#preparation-elapsed').textContent()
  await page.waitForTimeout(350)
  await expect(page.locator('#preparation-elapsed')).toHaveText(finished!)
  await expect(page.locator('body')).not.toHaveAttribute('data-usb-writes')
})

test('production UI advances within a real 256 MiB file before it is ready', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('./')
  await page.locator('#file-count').fill('1')
  await page.locator('#rounds').fill('1')
  await page.locator('#file-size').fill('256')
  await page.locator('#pre-generate').check()
  const observed = page.evaluate(() => new Promise<Array<{ status: string; value: number | null; ready: number }>>((resolve) => {
    const samples: Array<{ status: string; value: number | null; ready: number }> = []
    const current = document.querySelector<HTMLProgressElement>('#preparation-file-progress')!
    const total = document.querySelector<HTMLProgressElement>('#preparation-progress')!
    const status = document.querySelector('#preparation-status')!
    const observer = new MutationObserver(() => {
      samples.push({ status: status.textContent!, value: current.hasAttribute('value') ? current.value : null, ready: total.value })
      if (status.textContent!.startsWith('Ready.')) { observer.disconnect(); resolve(samples) }
    })
    observer.observe(document.querySelector('#preparation-panel')!, { subtree: true, childList: true, attributes: true })
  }))
  await page.locator('#prepare-files').click()
  await expect(page.locator('#preparation-status')).toContainText('Ready.', { timeout: 90_000 })
  const samples = await observed
  expect(samples.some((sample) => sample.status === 'Generating file 1 / 1.'
    && sample.value !== null && sample.value > 0 && sample.value < 256 * 1024 ** 2 && sample.ready === 0)).toBe(true)
  expect(samples.some((sample) => sample.status === 'Computing expected SHA-256 for file 1 / 1.'
    && sample.value === null && sample.ready === 0)).toBe(true)
  await expect(page.locator('#preparation-count')).toContainText('1 / 1')
  await expect(page.locator('#connection-badge')).toHaveText('Disconnected')
  await page.locator('#discard-prepared').click()
})

test('cancels during expected hashing and ignores late progress/completion', async ({ page }) => {
  await setup(page, 'progress')
  await page.locator('#pre-generate').check()
  await page.locator('#prepare-files').click()
  await expect(page.locator('#preparation-status')).toContainText('Generating file 1')
  await page.evaluate(() => window.dispatchEvent(new Event('test-generation-half')))
  await expect(page.locator('#preparation-detail')).toContainText('(50%)')
  await page.evaluate(() => window.dispatchEvent(new Event('test-generation-hash')))
  await expect(page.locator('#preparation-status')).toContainText('Computing expected SHA-256')
  await page.locator('#cancel-preparation').click()
  await expect(page.locator('#preparation-status')).toContainText('canceled')
  await expect(page.locator('#preparation-current')).toBeHidden()
  await expect(page.locator('#preparation-active')).toBeHidden()
  await expect(page.locator('#preparation-elapsed')).toBeHidden()
  await page.evaluate(() => window.dispatchEvent(new Event('test-generation-done')))
  await expect(page.locator('#discard-prepared')).toBeDisabled()
  await expect(page.locator('#preparation-status')).toContainText('canceled')
  await expect(page.locator('#app-error')).toBeHidden()
})

test('on-demand generation exposes byte/hash stages without changing verified transfer progress', async ({ page }) => {
  await setup(page, 'progress')
  await page.locator('#file-count').fill('1')
  await page.locator('#rounds').fill('1')
  await page.locator('#connect').click()
  await page.locator('#start').click()
  await expect(page.locator('#live-payload')).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new Event('test-generation-half')))
  await expect(page.locator('#live-payload-detail')).toContainText('(50%)')
  await expect(page.locator('#run-progress')).toHaveAttribute('value', '0')
  await page.evaluate(() => window.dispatchEvent(new Event('test-generation-hash')))
  await expect(page.locator('#live-payload-detail')).toContainText('Computing expected SHA-256')
  await expect(page.locator('#live-payload-progress')).not.toHaveAttribute('value')
  await page.evaluate(() => window.dispatchEvent(new Event('test-generation-done')))
  await expect(page.locator('#run-badge')).toHaveText('Completed · verified')
  await expect(page.locator('#live-payload')).toBeHidden()
})

for (const pattern of ['batch', 'round-trip']) {
  for (const preGenerate of [false, true]) {
    for (const reuse of [false, true]) {
      test(`real worker and UI ${pattern}: pre=${preGenerate} reuse=${reuse} (simulated USB)`, async ({ page }) => {
        await setup(page)
        await page.locator('#pattern').selectOption(pattern)
        await page.locator('#pre-generate').setChecked(preGenerate)
        await page.locator('#reuse-across-rounds').setChecked(reuse)
        await page.locator('#connect').click()
        if (preGenerate) {
          await expect(page.locator('#start')).toBeDisabled()
          await page.locator('#prepare-files').click()
          await expect(page.locator('#preparation-status')).toContainText('Ready.')
          await expect(page.locator('body')).not.toHaveAttribute('data-usb-writes')
          await expect(page.locator('body')).toHaveAttribute('data-generations', reuse ? '3' : '7')
          await expect(page.locator('#discard-prepared')).toBeEnabled()
        }
        await expect(page.locator('#start')).toBeEnabled()
        await page.locator('#start').click()
        await expect(page.locator('#run-badge')).toHaveText('Completed · verified')
        await expect(page.locator('body')).toHaveAttribute('data-generations', reuse ? '3' : '7')
        await expect(page.locator('body')).toHaveAttribute('data-usb-writes', '7')
        const downloaded = page.waitForEvent('download')
        await page.locator('#saved-reports button').filter({ hasText: /^JSON$/ }).click()
        const report: RunReport = JSON.parse(await readFile((await (await downloaded).path())!, 'utf8'))
        expect(report.run.settings.preGenerate).toBe(preGenerate)
        expect(report.run.settings.reuseAcrossRounds).toBe(reuse)
        expect(report.run.completedFiles).toBe(6)
        expect(report.files.every((file) => file.passed && file.actualSha256 === file.expectedSha256)).toBe(true)
        const generated = preGenerate ? 0 : reuse ? 2 : 6
        expect(report.files.filter((file) => file.prepareMs > 0)).toHaveLength(generated)
        if (preGenerate) {
          expect(report.run.totals.prepareMs).toBe(0)
          await expect(page.locator('#preparation-status')).toContainText('released')
          await expect(page.locator('#start')).toBeDisabled()
          await expect(page.locator('#discard-prepared')).toBeDisabled()
        } else await expect(page.locator('#start')).toBeEnabled()
      })
    }
  }
}

test('prepares while disconnected and preserves readiness only for non-payload edits', async ({ page }) => {
  await setup(page)
  await page.locator('#pre-generate').check()
  await page.locator('#prepare-files').click()
  await expect(page.locator('#preparation-status')).toContainText('Ready.')
  await expect(page.locator('#connection-badge')).toHaveText('Disconnected')
  await expect(page.locator('#start')).toBeDisabled()
  await page.locator('#tags').fill('keep ready')
  await page.locator('#notes').fill('metadata only')
  await page.locator('#pattern').selectOption('batch')
  await expect(page.locator('#preparation-status')).toContainText('Ready.')
  await page.locator('#connect').click()
  await expect(page.locator('#start')).toBeEnabled()
  for (const edit of [
    () => page.locator('#seed').fill('new-seed'),
    () => page.locator('#rounds').fill('2'),
    () => page.locator('#file-count').fill('1'),
    () => page.locator('#file-size').fill('2048'),
    () => page.locator('#reuse-across-rounds').check(),
  ]) {
    await edit()
    await expect(page.locator('#preparation-status')).toContainText('Settings changed')
    await expect(page.locator('#start')).toBeDisabled()
    await expect(page.locator('#discard-prepared')).toBeDisabled()
    await page.locator('#prepare-files').click()
    await expect(page.locator('#start')).toBeEnabled()
  }
  await page.locator('#discard-prepared').click()
  await expect(page.locator('#preparation-status')).toContainText('discarded')
  await expect(page.locator('#start')).toBeDisabled()
  await page.locator('#prepare-files').click()
  await expect(page.locator('#start')).toBeEnabled()
  await page.reload()
  await expect(page.locator('#pre-generate')).toBeChecked()
  await expect(page.locator('#reuse-across-rounds')).toBeChecked()
  await expect(page.locator('#preparation-status')).toContainText('No prepared files')
  await expect(page.locator('body')).not.toHaveAttribute('data-generations')
})

test('cancels stalled preparation without USB or a partial run and restores controls', async ({ page }) => {
  await setup(page, 'stall')
  await page.locator('#connect').click()
  await page.locator('#pre-generate').check()
  await page.locator('#prepare-files').click()
  await expect(page.locator('#cancel-preparation')).toBeEnabled()
  await expect(page.locator('#start')).toBeDisabled()
  await expect(page.locator('#file-count')).toBeDisabled()
  await expect(page.locator('#pre-generate')).toBeDisabled()
  await expect(page.locator('#disconnect')).toBeDisabled()
  await page.locator('#cancel-preparation').click()
  await expect(page.locator('#preparation-status')).toContainText('canceled')
  await expect(page.locator('#prepare-files')).toBeEnabled()
  await expect(page.locator('#file-count')).toBeEnabled()
  await expect(page.locator('#pre-generate')).toBeEnabled()
  await expect(page.locator('#disconnect')).toBeEnabled()
  await expect(page.locator('#app-error')).toBeHidden()
  await expect(page.locator('#saved-reports')).toContainText('No local reports')
  await expect(page.locator('body')).not.toHaveAttribute('data-usb-writes')
  await page.locator('#pre-generate').uncheck()
  await expect(page.locator('#start')).toBeEnabled()
})

test('preparation failures are explicit and cannot silently start on-demand generation', async ({ page }) => {
  await setup(page, 'fail')
  const errors: string[] = []
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  await page.locator('#connect').click()
  await page.locator('#pre-generate').check()
  await page.locator('#prepare-files').click()
  await expect(page.locator('#preparation-status')).toContainText('failed')
  await expect(page.locator('#app-error')).toContainText('Injected preparation failure')
  await expect(page.locator('#start')).toBeDisabled()
  await expect(page.locator('#prepare-files')).toBeEnabled()
  await expect(page.locator('#discard-prepared')).toBeDisabled()
  expect(errors.join('\n')).toContain('app.prepare.failed')
  await expect(page.locator('body')).not.toHaveAttribute('data-usb-writes')
})

test('pre-generation limits total retained bytes and file count, not transferred rounds with reuse', async ({ page }) => {
  await setup(page)
  await page.locator('#pre-generate').check()
  await page.locator('#file-count').fill('1')
  await page.locator('#size-unit').selectOption('1073741824')
  await page.locator('#file-size').fill('1')
  await expect(page.locator('#settings-error')).toContainText('1 GiB total')
  await expect(page.locator('#prepare-files')).toBeDisabled()
  await page.locator('#reuse-across-rounds').check()
  await expect(page.locator('#settings-error')).toHaveText('Workload is valid.')
  await expect(page.locator('#payload-memory')).toContainText('1 GiB for one round')
  await expect(page.locator('#prepare-files')).toBeEnabled()
  await page.locator('#size-unit').selectOption('1')
  await page.locator('#reuse-across-rounds').uncheck()
  await page.locator('#rounds').fill('20001')
  await expect(page.locator('#settings-error')).toContainText('20,000 files')
  await expect(page.locator('#prepare-files')).toBeDisabled()
  await page.locator('#reuse-across-rounds').check()
  await expect(page.locator('#prepare-files')).toBeEnabled()
})
