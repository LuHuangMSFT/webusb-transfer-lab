import { describe, expect, it, vi } from 'vitest'
import { createInProcessPayloadService } from './payload'
import { PreparedFiles } from './prepared-files'
import { DEFAULT_SETTINGS } from './workload'

const settings = { ...DEFAULT_SETTINGS, preGenerate: true, fileCount: 2, fileSizeBytes: 8, rounds: 3 }

describe('explicit in-memory payload preparation', () => {
  it.each([false, true])('prepares the probe and every required file with reuse=%s', async (reuseAcrossRounds) => {
    const service = createInProcessPayloadService()
    const prepare = vi.spyOn(service, 'prepare')
    const progress = vi.fn()
    const configured = { ...settings, reuseAcrossRounds }
    const files = await PreparedFiles.prepare(configured, service, new AbortController().signal, progress)
    expect(prepare).toHaveBeenCalledTimes(1 + (reuseAcrossRounds ? 2 : 6))
    expect(progress).toHaveBeenLastCalledWith(reuseAcrossRounds ? 2 : 6, reuseAcrossRounds ? 2 : 6)
    expect(files.matches(configured)).toBe(true)
    expect(() => files.take(1, 1)).toThrow('does not match')
    files.claim(configured)
    expect(files.matches(configured)).toBe(false)
    expect(files.probe.bytes.byteLength).toBe(8)
    const first = files.take(1, 1)
    const next = files.take(2, 1)
    expect(first.sha256).toBe(next.sha256)
    expect(first.bytes).toEqual(next.bytes)
    expect(first === next).toBe(reuseAcrossRounds)
    if (!reuseAcrossRounds) expect(() => files.take(1, 1)).toThrow('already consumed')
    expect(() => files.claim(configured)).toThrow('Prepare all files')
    expect(() => files.take(0, 1)).toThrow()
    expect(() => files.take(1, 3)).toThrow()
    files.take(3, 1)
    expect(() => files.take(3, 1)).toThrow('already consumed')
    files.dispose()
    expect(() => files.take(2, 2)).toThrow('missing')
    expect(() => files.probe).toThrow('unavailable')
    service.dispose()
  })

  it('keeps readiness for metadata/pattern changes but rejects payload or mode changes', async () => {
    const service = createInProcessPayloadService()
    const files = await PreparedFiles.prepare(settings, service, new AbortController().signal, () => {})
    expect(files.matches({ ...settings, tags: 'different', notes: 'different', pattern: 'batch' })).toBe(true)
    for (const changes of [
      { seed: 'new' }, { rounds: 4 }, { fileCount: 1 }, { fileSizeBytes: 9 },
      { preGenerate: false }, { reuseAcrossRounds: true },
    ]) expect(files.matches({ ...settings, ...changes })).toBe(false)
    const legacy = { ...settings }
    delete legacy.reuseAcrossRounds
    expect(files.matches(legacy)).toBe(true)
    settings.seed = 'mutated'
    expect(files.matches(settings)).toBe(false)
    settings.seed = DEFAULT_SETTINGS.seed
    files.dispose()
    expect(files.matches(settings)).toBe(false)
    service.dispose()
  })

  it('cancels stalled generation promptly and rejects late completion without reporting ready', async () => {
    const controller = new AbortController()
    const service = createInProcessPayloadService()
    let complete!: (value: Awaited<ReturnType<typeof service.prepare>>) => void
    const pending = new Promise<Awaited<ReturnType<typeof service.prepare>>>((resolve) => { complete = resolve })
    vi.spyOn(service, 'prepare').mockReturnValue(pending)
    const dispose = vi.spyOn(service, 'dispose')
    const progress = vi.fn()
    const preparation = PreparedFiles.prepare(settings, service, controller.signal, progress)
    controller.abort()
    await expect(preparation).rejects.toThrow('canceled')
    expect(dispose).toHaveBeenCalledOnce()
    complete({ bytes: new Uint8Array(8), sha256: 'a'.repeat(64) })
    await Promise.resolve()
    expect(progress).toHaveBeenCalledOnce()
  })

  it('handles cancellation from progress before the first worker request', async () => {
    const service = createInProcessPayloadService()
    const prepare = vi.spyOn(service, 'prepare')
    const controller = new AbortController()
    await expect(PreparedFiles.prepare(settings, service, controller.signal, () => {
      controller.abort(new Error('stopped before generation'))
    })).rejects.toThrow('stopped before generation')
    expect(prepare).not.toHaveBeenCalled()
  })

  it('rejects pre-aborted, disabled, oversized and malformed preparation', async () => {
    const service = createInProcessPayloadService()
    const prepare = vi.spyOn(service, 'prepare')
    const canceled = new AbortController()
    canceled.abort(new Error('stopped'))
    await expect(PreparedFiles.prepare(settings, service, canceled.signal, () => {})).rejects.toThrow('stopped')
    await expect(PreparedFiles.prepare({ ...settings, preGenerate: false }, service, new AbortController().signal, () => {})).rejects.toThrow('not enabled')
    await expect(PreparedFiles.prepare({ ...settings, fileCount: 1, fileSizeBytes: 1024 ** 3 }, service, new AbortController().signal, () => {})).rejects.toThrow('1 GiB')
    expect(prepare).not.toHaveBeenCalled()
    prepare.mockResolvedValue({ bytes: new Uint8Array(7), sha256: 'a'.repeat(64) })
    await expect(PreparedFiles.prepare(settings, service, new AbortController().signal, () => {})).rejects.toThrow('invalid size')
    prepare.mockRejectedValue(new Error('worker failed'))
    await expect(PreparedFiles.prepare(settings, service, new AbortController().signal, () => {})).rejects.toThrow('worker failed')
    service.dispose()
  })
})
