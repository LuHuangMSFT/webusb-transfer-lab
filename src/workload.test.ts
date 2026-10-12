import { describe, expect, it } from 'vitest'
import { createInProcessPayloadService } from './payload'
import { DEFAULT_SETTINGS, estimateWorkload, generatePayloadBytes, hashPayload, LIMITS, validateSettings } from './workload'

describe('workload validation and deterministic synthetic data', () => {
  it('uses the approved defaults and exact limits', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      fileCount: 10, fileSizeBytes: 1024 ** 2, rounds: 3, pattern: 'round-trip',
      seed: 'webusb-lab', tags: '', notes: '',
    })
    expect(LIMITS).toEqual({ maxFiles: 100, maxFileBytes: 1024 ** 3, maxRoundBytes: 1024 ** 3 })
    expect(validateSettings({ ...DEFAULT_SETTINGS, fileCount: 100 })).toBeTruthy()
    expect(validateSettings({ ...DEFAULT_SETTINGS, fileCount: 64, fileSizeBytes: 16 * 1024 ** 2 })).toBeTruthy()
    expect(() => validateSettings({ ...DEFAULT_SETTINGS, fileCount: 65, fileSizeBytes: 16 * 1024 ** 2 })).toThrow('1 GiB')
    expect(() => validateSettings({ ...DEFAULT_SETTINGS, fileCount: 101 })).toThrow()
    expect(() => validateSettings({ ...DEFAULT_SETTINGS, fileCount: 1, fileSizeBytes: 1024 ** 3 + 1 })).toThrow('File size')
    expect(() => generatePayloadBytes(1024 ** 3 + 1, 'seed', 1)).toThrow('Payload size')
  })

  it.each(['round-trip', 'batch'] as const)('accepts exactly 1 GiB per file with correct %s estimates', (pattern) => {
    const settings = { ...DEFAULT_SETTINGS, fileCount: 1, fileSizeBytes: 1024 ** 3, pattern }
    expect(estimateWorkload(settings)).toEqual({
      roundBytes: 1024 ** 3, totalTrafficBytes: 6 * 1024 ** 3,
      peakDeviceBytes: 1024 ** 3, totalFiles: 3,
    })
    expect(validateSettings({ ...settings, fileCount: 2, fileSizeBytes: 512 * 1024 ** 2 })).toBeTruthy()
    expect(() => validateSettings({ ...settings, fileCount: 2 })).toThrow('1 GiB')
  })

  it.each([0, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid numerical input %s', (value) => {
    for (const key of ['fileCount', 'fileSizeBytes', 'rounds'] as const) {
      expect(() => validateSettings({ ...DEFAULT_SETTINGS, [key]: value })).toThrow()
    }
  })

  it('rejects unsafe aggregate arithmetic rather than capping rounds', () => {
    const settings = { ...DEFAULT_SETTINGS, fileCount: 1, fileSizeBytes: 1, rounds: Math.floor(Number.MAX_SAFE_INTEGER / 2) }
    expect(estimateWorkload(settings).totalFiles).toBe(settings.rounds)
    expect(() => estimateWorkload({ ...settings, rounds: settings.rounds + 1 })).toThrow('safe integers')
  })

  it('bounds text and rejects unsupported settings', () => {
    for (const overrides of [
      { seed: '' }, { seed: '  ' }, { seed: 'a'.repeat(257) },
      { buildLabel: '' }, { buildLabel: 'a'.repeat(129) }, { notes: 'a'.repeat(4097) },
      { tags: 'a'.repeat(513) }, { tags: 'bad\u0000tag' }, { tags: null },
      { pattern: 'echo' }, { architecture: 'guessed' }, { seed: null },
    ]) {
      expect(() => validateSettings({ ...DEFAULT_SETTINGS, ...overrides } as typeof DEFAULT_SETTINGS)).toThrow()
    }
  })

  it('accepts blank or omitted tags and preserves freeform text without interpreting it', () => {
    expect(validateSettings(DEFAULT_SETTINGS).tags).toBe('')
    const settings = { ...DEFAULT_SETTINGS }
    delete settings.tags
    expect(validateSettings(settings).tags).toBeUndefined()
    for (const tags of ['  ', 'morning run, cable A', ' =SUM(1,2), "trial" ', '試験, تجربة']) {
      const tagged = validateSettings({ ...settings, tags })
      expect(tagged.tags).toBe(tags)
      expect(tagged).not.toHaveProperty('buildLabel')
      expect(tagged).not.toHaveProperty('architecture')
      expect(estimateWorkload(tagged)).toEqual(estimateWorkload(settings))
    }
  })

  it('estimates each pattern without buffering batches or multiplying peak by rounds', () => {
    const settings = { ...DEFAULT_SETTINGS, fileCount: 64, fileSizeBytes: 16 * 1024 ** 2 }
    expect(estimateWorkload(settings)).toEqual({
      roundBytes: 1024 ** 3, totalTrafficBytes: 6 * 1024 ** 3,
      peakDeviceBytes: 16 * 1024 ** 2, totalFiles: 192,
    })
    expect(estimateWorkload({ ...settings, pattern: 'batch' }).peakDeviceBytes).toBe(1024 ** 3)
    const validated = validateSettings(settings)
    expect(Object.isFrozen(validated)).toBe(true)
    expect(validated).not.toBe(settings)
  })

  it('locks the versioned PRNG identity and SHA-256 fixture', async () => {
    const bytes = generatePayloadBytes(32, 'webusb-lab', 1)
    expect(Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join(''))
      .toBe('58af6496ce365f30f796faaa3f7bdc07a20231395da84b5bb0cff5794c0282f3')
    expect(await hashPayload(bytes)).toBe('ff2af7ef52f4400146fe08774a5e49e3912180591336f5787a1aa3c05197777e')
    expect(generatePayloadBytes(32, 'webusb-lab', 1)).toEqual(bytes)
    expect(generatePayloadBytes(32, 'webusb-lab', 2)).not.toEqual(bytes)
    expect(generatePayloadBytes(32, 'other-seed', 1)).not.toEqual(bytes)
    expect(generatePayloadBytes(7, 'webusb-lab', 1)).toEqual(bytes.slice(0, 7))
    expect(new Set(Array.from({ length: 100 }, (_, index) => generatePayloadBytes(1, 'webusb-lab', index + 1)[0])).size).toBe(100)
  })

  it('supports an explicitly in-process test service and disposal', async () => {
    const service = createInProcessPayloadService()
    const first = await service.prepare(17, 'repeatable', 1)
    const second = await service.prepare(17, 'repeatable', 1)
    expect(first).toEqual(second)
    expect(first.bytes).not.toBe(second.bytes)
    expect(await service.hash(first.bytes)).toBe(first.sha256)
    service.dispose()
    await expect(service.prepare(1, 'seed', 0)).rejects.toThrow('disposed')
    await expect(service.hash(second.bytes)).rejects.toThrow('disposed')
  })
})
