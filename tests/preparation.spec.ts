import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import type { RunReport } from '../src/types'

async function setup(page: Page, workerMode: 'normal' | 'stall' | 'fail' = 'normal'): Promise<void> {
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
