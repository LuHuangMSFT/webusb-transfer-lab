import { expect, test } from '@playwright/test'

const KEY = 'webusb-transfer-lab.settings.v1'
const values = {
  fileCount: '5', fileSize: '128', sizeUnit: '1048576', rounds: '1',
  pattern: 'batch', seed: 'private-seed', tags: 'private-tags', notes: 'private-notes\nsecond line',
}

test('remembers the complete configuration on refresh and in another tab without USB access', async ({ page, context }) => {
  const messages: string[] = []
  const errors: string[] = []
  page.on('console', (message) => messages.push(message.text()))
  page.on('pageerror', (error) => errors.push(error.message))
  await context.addInitScript(() => Object.defineProperty(navigator, 'usb', {
    configurable: true, value: {
      addEventListener() {}, removeEventListener() {},
      async getDevices() { throw new Error('Unexpected automatic USB access') },
      async requestDevice() { throw new Error('Unexpected automatic USB access') },
    },
  }))
  await page.goto('./')
  await page.evaluate(() => localStorage.setItem('webusb-transfer-lab.cleanup.v1', '[]'))
  await page.locator('#file-count').fill(values.fileCount)
  await page.locator('#file-size').fill(values.fileSize)
  await page.locator('#rounds').fill(values.rounds)
  await page.locator('#pattern').selectOption(values.pattern)
  await page.locator('#seed').fill(values.seed)
  await page.locator('#tags').fill(values.tags)
  await page.locator('#notes').fill(values.notes)
  await expect(page.locator('#settings-error')).toHaveText('Workload is valid.')
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), KEY)).toEqual({
    version: 1, values: { ...values, preGenerate: false, reuseAcrossRounds: false },
  })
  await page.locator('#diagnostics summary').click()
  await page.locator('#diagnostic-tracing').check()
  await page.reload()
  const another = await context.newPage()
  await another.goto('./')
  for (const current of [page, another]) {
    await expect(current.locator('#file-count')).toHaveValue('5')
    await expect(current.locator('#file-size')).toHaveValue('128')
    await expect(current.locator('#size-unit')).toHaveValue('1048576')
    await expect(current.locator('#rounds')).toHaveValue('1')
    await expect(current.locator('#pattern')).toHaveValue('batch')
    await expect(current.locator('#seed')).toHaveValue(values.seed)
    await expect(current.locator('#tags')).toHaveValue(values.tags)
    await expect(current.locator('#notes')).toHaveValue(values.notes)
    await expect(current.locator('#estimate-round')).toHaveText('640 MiB')
    await expect(current.locator('#settings-error')).toHaveText('Workload is valid.')
    await expect(current.locator('#connection-badge')).toHaveText('Disconnected')
    await expect(current.locator('#start')).toBeDisabled()
    await expect(current.locator('#diagnostic-tracing')).not.toBeChecked()
    await expect(current.locator('#settings-storage-error')).toBeHidden()
    await expect(current.locator('#app-error')).toBeHidden()
  }
  expect(await page.evaluate(() => localStorage.getItem('webusb-transfer-lab.cleanup.v1'))).toBe('[]')
  expect(messages.join('\n')).not.toContain('private-')
  expect(errors).toEqual([])
})

for (const [unit, size] of [['1', '257'], ['1024', '1.5'], ['1073741824', '0.125']]) {
  test(`preserves the entered size ${size} and unit ${unit}`, async ({ page }) => {
    await page.goto('./')
    await page.locator('#file-count').fill('1')
    await page.locator('#size-unit').selectOption(unit)
    await page.locator('#file-size').fill(size)
    await page.reload()
    await expect(page.locator('#file-size')).toHaveValue(size)
    await expect(page.locator('#size-unit')).toHaveValue(unit)
    await expect(page.locator('#settings-error')).toHaveText('Workload is valid.')
  })
}

test('remembers preparation options but never restores ready payloads or starts generation', async ({ page }) => {
  await page.goto('./')
  await page.locator('#pre-generate').check()
  await page.locator('#reuse-across-rounds').check()
  await page.reload()
  await expect(page.locator('#pre-generate')).toBeChecked()
  await expect(page.locator('#reuse-across-rounds')).toBeChecked()
  await expect(page.locator('#prepare-files')).toBeEnabled()
  await expect(page.locator('#preparation-status')).toContainText('No prepared files')
  await expect(page.locator('#discard-prepared')).toBeDisabled()
  await expect(page.locator('#start')).toBeDisabled()
  await expect(page.locator('#payload-memory')).toContainText('10 MiB')
  await page.locator('#preset-small').click()
  await page.reload()
  await expect(page.locator('#pre-generate')).toBeChecked()
  await expect(page.locator('#reuse-across-rounds')).toBeChecked()
})

test('restores old preferences with both new options off and without rewriting them', async ({ page }) => {
  await page.goto('./')
  const raw = JSON.stringify({ version: 1, values })
  await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key: KEY, raw })
  await page.reload()
  await expect(page.locator('#file-count')).toHaveValue('5')
  await expect(page.locator('#pre-generate')).not.toBeChecked()
  await expect(page.locator('#reuse-across-rounds')).not.toBeChecked()
  await expect(page.locator('#settings-storage-error')).toBeHidden()
  expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).toBe(raw)
})

for (const [preset, count, size] of [['default', '10', '1'], ['small', '100', '0.0625'], ['large', '8', '16']]) {
  test(`remembers the ${preset} preset without clearing the seed or bookkeeping`, async ({ page }) => {
    await page.goto('./')
    await page.locator('#seed').fill(values.seed)
    await page.locator('#tags').fill(values.tags)
    await page.locator('#notes').fill(values.notes)
    await page.locator('#pattern').selectOption('batch')
    await page.locator('#file-count').fill('1')
    await page.locator('#size-unit').selectOption('1073741824')
    await page.locator(`#preset-${preset}`).click()
    await page.reload()
    await expect(page.locator('#file-count')).toHaveValue(count)
    await expect(page.locator('#file-size')).toHaveValue(size)
    await expect(page.locator('#size-unit')).toHaveValue('1048576')
    await expect(page.locator('#rounds')).toHaveValue('3')
    await expect(page.locator('#pattern')).toHaveValue('batch')
    await expect(page.locator('#seed')).toHaveValue(values.seed)
    await expect(page.locator('#tags')).toHaveValue(values.tags)
    await expect(page.locator('#notes')).toHaveValue(values.notes)
    await expect(page.locator('#settings-error')).toHaveText('Workload is valid.')
  })
}

test('preserves unfinished edits but still rejects invalid workloads', async ({ page }) => {
  await page.goto('./')
  await page.locator('#file-count').fill('101')
  await page.locator('#rounds').fill('')
  await page.locator('#seed').fill('')
  await page.locator('#tags').fill(values.tags)
  await page.locator('#tags').fill('')
  await page.reload()
  await expect(page.locator('#file-count')).toHaveValue('101')
  await expect(page.locator('#rounds')).toHaveValue('')
  await expect(page.locator('#seed')).toHaveValue('')
  await expect(page.locator('#tags')).toHaveValue('')
  await expect(page.locator('#settings-error')).not.toHaveText('Workload is valid.')
  await expect(page.locator('#start')).toBeDisabled()
  await expect(page.locator('#settings-storage-error')).toBeHidden()
  await page.locator('#file-count').fill('5')
  await page.locator('#rounds').fill('1')
  await page.locator('#seed').fill('corrected')
  await page.reload()
  await expect(page.locator('#seed')).toHaveValue('corrected')
  await expect(page.locator('#settings-error')).toHaveText('Workload is valid.')
})

for (const [name, raw] of [
  ['malformed JSON', 'private-invalid-json'],
  ['future version', JSON.stringify({ version: 2, values })],
  ['unknown field', JSON.stringify({ version: 1, values: { ...values, autoStart: 'true' } })],
  ['wrong field type', JSON.stringify({ version: 1, values: { ...values, notes: 42 } })],
  ['wrong preparation type', JSON.stringify({ version: 1, values: { ...values, preGenerate: 'true' } })],
  ['null reuse option', JSON.stringify({ version: 1, values: { ...values, reuseAcrossRounds: null } })],
  ['unsupported unit', JSON.stringify({ version: 1, values: { ...values, sizeUnit: '1000' } })],
  ['oversized input', ' '.repeat(32_769)],
]) {
  test(`warns and leaves defaults intact for ${name} without overwriting stored data`, async ({ page }) => {
    const messages: string[] = []
    page.on('console', (message) => messages.push(message.text()))
    await page.goto('./')
    await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key: KEY, raw })
    await page.reload()
    await expect(page.locator('#settings-storage-error')).toContainText('Defaults are shown')
    await expect(page.locator('#file-count')).toHaveValue('10')
    await expect(page.locator('#file-size')).toHaveValue('1')
    await expect(page.locator('#seed')).toHaveValue('webusb-lab')
    await expect(page.locator('#pattern')).toHaveValue('round-trip')
    expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).toBe(raw)
    expect(messages.join('\n')).toContain('app.settings.restore.failed')
    expect(messages.join('\n')).not.toContain('private-')
    await page.locator('#file-count').fill('5')
    await expect(page.locator('#settings-storage-error')).toBeHidden()
    await page.reload()
    await expect(page.locator('#file-count')).toHaveValue('5')
    await expect(page.locator('#settings-storage-error')).toBeHidden()
  })
}

test('reports blocked reads without breaking the form', async ({ page }) => {
  await page.addInitScript((key) => {
    const getItem = Storage.prototype.getItem
    Storage.prototype.getItem = function (name) {
      if (name === key) throw new DOMException('Storage blocked', 'SecurityError')
      return getItem.call(this, name)
    }
  }, KEY)
  await page.goto('./')
  await expect(page.locator('#settings-storage-error')).toContainText('could not be restored')
  await expect(page.locator('#settings-error')).toHaveText('Workload is valid.')
  await expect(page.locator('#connect')).toBeEnabled()
  await page.locator('#file-count').fill('5')
  await expect(page.locator('#file-count')).toHaveValue('5')
  await expect(page.locator('#settings-storage-error')).toContainText('could not be saved')
})

for (const mode of ['quota', 'unconfirmed']) {
  test(`warns about ${mode} writes and recovers on the next edit`, async ({ page }) => {
    const messages: string[] = []
    page.on('console', (message) => messages.push(message.text()))
    await page.addInitScript(({ key, mode }) => {
      let blocked = true
      window.addEventListener('allow-settings-save', () => { blocked = false })
      const setItem = Storage.prototype.setItem
      Storage.prototype.setItem = function (name, value) {
        if (name === key && blocked) {
          if (mode === 'quota') throw new DOMException('private-details', 'QuotaExceededError')
          return
        }
        setItem.call(this, name, value)
      }
    }, { key: KEY, mode })
    await page.goto('./')
    await page.locator('#seed').fill(values.seed)
    await expect(page.locator('#settings-storage-error')).toContainText('could not be saved')
    await expect(page.locator('#seed')).toHaveValue(values.seed)
    expect(messages.join('\n')).toContain('app.settings.save.failed')
    expect(messages.join('\n')).not.toContain('private-')
    await page.evaluate(() => window.dispatchEvent(new Event('allow-settings-save')))
    await page.locator('#file-count').fill('5')
    await expect(page.locator('#settings-storage-error')).toBeHidden()
    await page.reload()
    await expect(page.locator('#file-count')).toHaveValue('5')
    await expect(page.locator('#seed')).toHaveValue(values.seed)
    await expect(page.locator('#settings-storage-error')).toBeHidden()
  })
}
