import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInProcessPayloadService } from './payload'
import { PreparedFiles } from './prepared-files'
import { runWorkload } from './runner'
import type { DeviceStorage, FileResult, PayloadService, RunnerOptions, RunSummary } from './types'
import { DEFAULT_SETTINGS } from './workload'
import { clearDiagnostics, diagnosticSnapshot, setDiagnosticsEnabled } from './diagnostics'

class SimulatedDevice implements DeviceStorage {
  readonly info = { model: 'Simulated phone', manufacturer: 'Test only', features: ['simulated'], maxPayloadSize: 65536 }
  connected = true
  files = new Map<string, Uint8Array<ArrayBuffer>>()
  events: string[] = []
  clock = 0
  fail = ''
  durations: Record<string, number> = {}
  busy = false
  maxFiles = 0
  readTransform?: (bytes: Uint8Array<ArrayBuffer>, name: string) => Uint8Array<ArrayBuffer>
  onCall?: (event: string) => void

  async call<T>(event: string, duration: number, action: () => T): Promise<T> {
    if (this.busy) throw new Error('Overlapping simulated SYNC calls')
    if (!this.connected) throw new Error('Disconnected')
    this.busy = true
    try {
      this.events.push(event)
      this.clock += this.durations[event] ?? duration
      this.onCall?.(event)
      await Promise.resolve()
      if (event === this.fail) throw new Error(`Injected ${event} failure`)
      if (!this.connected) throw new Error('Disconnected')
      return action()
    } finally { this.busy = false }
  }
  createRun(_id: string): Promise<void> { return this.call('create', 4, () => {}) }
  checkSpace(bytes: number): Promise<void> { return this.call(`space:${bytes}`, 2, () => {}) }
  writeFile(_id: string, name: string, data: Uint8Array<ArrayBuffer>): Promise<void> {
    return this.call(`write:${name}`, 10, () => {
      this.files.set(name, data.slice())
      this.maxFiles = Math.max(this.maxFiles, this.files.size)
    })
  }
  readFile(_id: string, name: string, _expectedBytes: number): Promise<Uint8Array<ArrayBuffer>> {
    return this.call(`read:${name}`, 20, () => {
      const received = this.files.get(name)!.slice()
      return this.readTransform?.(received, name) ?? received
    })
  }
  statFile(_id: string, name: string): Promise<number> { return this.call(`stat:${name}`, 3, () => this.files.get(name)!.byteLength) }
  removeFile(_id: string, name: string): Promise<void> { return this.call(`remove:${name}`, 5, () => { this.files.delete(name) }) }
  cleanupRun(_id: string): Promise<void> { return this.call('cleanup', 7, () => { this.files.clear() }) }
  abort(): void { this.events.push('abort'); this.connected = false }
}

function fixture(overrides: Partial<RunnerOptions['settings']> = {}) {
  const device = new SimulatedDevice()
  const service = createInProcessPayloadService()
  const payloads: PayloadService = {
    async prepare(size, seed, index) {
      device.events.push(`prepare:${index}`)
      device.clock += 11
      return service.prepare(size, seed, index)
    },
    async hash(bytes) {
      device.events.push('hash')
      device.clock += 13
      return service.hash(bytes)
    },
    dispose() { device.events.push('dispose'); service.dispose() },
  }
  const controller = new AbortController()
  const records: FileResult[] = []
  const starts: RunSummary[] = []
  const options: RunnerOptions = {
    device, payloads, signal: controller.signal,
    settings: { ...DEFAULT_SETTINGS, fileCount: 3, fileSizeBytes: 8, rounds: 2, ...overrides },
    environment: { siteCommit: 'simulated-test', siteVersion: 'test', browser: 'test browser', dependencies: { adb: 'test' } },
    onProgress: vi.fn(),
    async onFile(result) { device.events.push(`persist:${result.name}`); device.clock += 17; records.push(result) },
    async onStart(summary) { starts.push(summary); device.clock += 19 },
  }
  vi.spyOn(performance, 'now').mockImplementation(() => device.clock)
  return { device, controller, records, starts, options }
}

afterEach(() => {
  setDiagnosticsEnabled(false)
  clearDiagnostics()
  vi.restoreAllMocks()
})

describe('runner with simulated device storage (not hardware coverage)', () => {
  it.each([
    [false, false, 'round-trip'], [false, true, 'round-trip'], [true, false, 'round-trip'], [true, true, 'round-trip'],
    [false, false, 'batch'], [false, true, 'batch'], [true, false, 'batch'], [true, true, 'batch'],
  ] as const)('separates generation and preserves verification: pre=%s reuse=%s pattern=%s', async (preGenerate, reuseAcrossRounds, pattern) => {
    const { options, device, records, controller } = fixture({ preGenerate, reuseAcrossRounds, pattern })
    if (preGenerate) {
      options.prepared = await PreparedFiles.prepare(options.settings, options.payloads, controller.signal, () => {})
      expect(device.events.filter((event) => event.startsWith('prepare:'))).toHaveLength(reuseAcrossRounds ? 4 : 7)
      expect(device.events.some((event) => /^(write|read|space|create)/.test(event))).toBe(false)
      device.events.length = 0
      vi.spyOn(options.payloads, 'prepare').mockRejectedValue(new Error('Generation must not run during pre-generated transfer'))
    }
    const receivedBuffers: ArrayBuffer[] = []
    const hash = options.payloads.hash.bind(options.payloads)
    options.payloads.hash = async (received) => {
      receivedBuffers.push(received.buffer)
      const sha256 = await hash(received)
      structuredClone(received.buffer, { transfer: [received.buffer] })
      return sha256
    }
    const summary = await runWorkload(options)
    expect(summary.status).toBe('completed')
    expect(summary.completedFiles).toBe(6)
    expect(summary.totals.prepareMs).toBe(preGenerate ? 0 : reuseAcrossRounds ? 33 : 66)
    expect(summary.totals.uploadedBytes).toBe(48)
    expect(summary.totals.downloadedBytes).toBe(48)
    expect(records.every((record) => record.passed && record.expectedSha256 === record.actualSha256)).toBe(true)
    expect(new Set(receivedBuffers).size).toBe(7)
    expect(device.events.filter((event) => event.startsWith('prepare:'))).toHaveLength(preGenerate ? 0 : reuseAcrossRounds ? 4 : 7)
    expect(records.slice(3).every((record) => record.prepareMs === (preGenerate || reuseAcrossRounds ? 0 : 11))).toBe(true)
    expect(device.files.size).toBe(0)
    if (options.prepared) expect(() => options.prepared!.probe).toThrow('unavailable')
  })

  it('rejects missing or stale prepared files before touching USB or saving a report', async () => {
    const { options, device, starts, controller } = fixture({ preGenerate: true })
    await expect(runWorkload(options)).rejects.toThrow('Prepare all files')
    options.prepared = await PreparedFiles.prepare(options.settings, options.payloads, controller.signal, () => {})
    device.events.length = 0
    options.settings.seed = 'changed'
    await expect(runWorkload(options)).rejects.toThrow('current settings')
    expect(device.events).toEqual([])
    expect(starts).toEqual([])
    options.prepared.dispose()
  })

  it.each(['failure', 'stop'] as const)('releases prepared files after transfer %s', async (scenario) => {
    const { options, device, controller } = fixture({ preGenerate: true, reuseAcrossRounds: true })
    options.prepared = await PreparedFiles.prepare(options.settings, options.payloads, controller.signal, () => {})
    if (scenario === 'failure') device.fail = 'read:r000001-f001.bin'
    else device.onCall = (event) => { if (event === 'write:r000001-f001.bin') controller.abort() }
    const summary = await runWorkload(options)
    expect(summary.status).toBe(scenario === 'failure' ? 'failed' : 'canceled')
    expect(() => options.prepared!.probe).toThrow('unavailable')
    expect(() => options.prepared!.take(2, 1)).toThrow('missing')
  })

  it('marks diagnostic runs and records phase, file, and completion context without user input', async () => {
    setDiagnosticsEnabled(true)
    clearDiagnostics()
    const { options } = fixture({ fileCount: 1, rounds: 1, seed: 'private-seed', notes: 'private-notes', tags: 'private-tags' })
    const summary = await runWorkload(options)
    expect(summary.environment.diagnosticsEnabled).toBe(true)
    const log = diagnosticSnapshot()
    expect(log.entries).toContainEqual(expect.objectContaining({
      event: 'run.phase.start', context: expect.objectContaining({ runId: summary.id, phase: 'upload', round: 1, index: 1 }),
    }))
    expect(log.entries).toContainEqual(expect.objectContaining({
      event: 'run.file.verified', context: { runId: summary.id, round: 1, index: 1, bytes: 8 },
    }))
    expect(log.entries.at(-1)).toMatchObject({ event: 'run.end', context: { status: 'completed', files: 1 } })
    expect(JSON.stringify(log)).not.toMatch(/private-seed|private-notes|private-tags|Simulated phone/)
  })

  it('logs failed run phase and file context with tracing disabled', async () => {
    clearDiagnostics()
    const { options, device } = fixture({ fileCount: 1, rounds: 1 })
    device.fail = 'read:r000001-f001.bin'
    const summary = await runWorkload(options)
    expect(summary.environment.diagnosticsEnabled).toBe(false)
    expect(diagnosticSnapshot().entries).toContainEqual(expect.objectContaining({
      event: 'run.failed', context: expect.objectContaining({ runId: summary.id, phase: 'download', round: 1, index: 1 }),
    }))
  })

  it.each(['round-trip', 'batch'] as const)('performs real independent receive verification in %s order for every round', async (pattern) => {
    const { device, records, starts, options } = fixture({ pattern })
    const summary = await runWorkload(options)
    expect(summary.status).toBe('completed')
    expect(summary.completedFiles).toBe(6)
    expect(summary.expectedFiles).toBe(6)
    expect(summary.leftovers).toEqual([])
    expect(summary.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(records.map(({ round, index }) => [round, index])).toEqual([[1, 1], [1, 2], [1, 3], [2, 1], [2, 2], [2, 3]])
    expect(records.every((record) => record.passed && record.expectedSha256 === record.actualSha256)).toBe(true)
    expect(records[0].expectedSha256).toBe(records[3].expectedSha256)
    expect(records[0].expectedSha256).not.toBe(records[1].expectedSha256)
    expect(starts[0].status).toBe('running')
    expect(starts[0].totals.uploadedBytes).toBe(0)
    expect(device.events.slice(0, 9)).toEqual([
      `space:${pattern === 'batch' ? 24 : 8}`, 'create', 'prepare:0', 'write:probe.bin',
      'stat:probe.bin', 'read:probe.bin', 'hash', 'remove:probe.bin', `space:${pattern === 'batch' ? 24 : 8}`,
    ])
    const transfers = device.events.filter((event) => /^(write|read|remove):r000001/.test(event))
    const names = ['r000001-f001.bin', 'r000001-f002.bin', 'r000001-f003.bin']
    expect(transfers).toEqual(pattern === 'round-trip'
      ? names.flatMap((name) => [`write:${name}`, `read:${name}`, `remove:${name}`])
      : [...names.map((name) => `write:${name}`), ...names.flatMap((name) => [`read:${name}`, `remove:${name}`])])
    expect(device.maxFiles).toBe(pattern === 'batch' ? 3 : 1)
    expect(device.files.size).toBe(0)
  })

  it('isolates transfer timers, sums bytes/time once, and includes persistence only in wall time', async () => {
    const { options, records } = fixture({ pattern: 'batch' })
    const summary = await runWorkload(options)
    expect(summary.totals).toEqual({
      uploadedBytes: 48, downloadedBytes: 48,
      prepareMs: 66, uploadMs: 60, downloadMs: 120, verifyMs: 96,
      cleanupMs: 37, setupMs: 72, wallMs: 572,
    })
    expect(records[0]).toMatchObject({ prepareMs: 11, uploadMs: 10, downloadMs: 20, verifyMs: 16, cleanupMs: 5 })
    expect(summary.totals.uploadedBytes / summary.totals.uploadMs).toBe(0.8)
    expect(summary.totals.downloadedBytes / summary.totals.downloadMs).toBe(0.4)
    expect(performance.getEntries().filter((entry) => entry.name.startsWith(summary.id))).toHaveLength(0)
    expect(vi.mocked(options.onProgress).mock.calls.length).toBeLessThanOrEqual(7)
  })

  it('runs identically with or without optional bookkeeping and freezes the saved tags', async () => {
    const untagged = fixture({ fileCount: 1, rounds: 1 })
    const first = await runWorkload(untagged.options)
    const tagged = fixture({ fileCount: 1, rounds: 1, tags: 'cable A, trial 2', notes: 'For my records' })
    const start = tagged.options.onStart
    tagged.options.onStart = async (summary) => {
      await start(summary)
      tagged.options.settings.tags = 'changed after start'
    }
    const second = await runWorkload(tagged.options)
    expect(first.status).toBe('completed')
    expect(second.status).toBe('completed')
    expect(first.settings.tags).toBe('')
    expect(second.settings.tags).toBe('cable A, trial 2')
    expect(second.settings).not.toHaveProperty('buildLabel')
    expect(second.settings).not.toHaveProperty('architecture')
    expect(second.totals).toEqual(first.totals)
    expect(tagged.device.events).toEqual(untagged.device.events)
    expect(tagged.records[0].expectedSha256).toBe(untagged.records[0].expectedSha256)
  })

  it('retains summed timing counters for weighted, not averaged, throughput', async () => {
    const { options, device, records } = fixture({ fileCount: 2, rounds: 1 })
    device.durations['write:r000001-f002.bin'] = 30
    device.durations['read:r000001-f002.bin'] = 60
    const summary = await runWorkload(options)
    expect(summary.totals.uploadedBytes / summary.totals.uploadMs).toBe(16 / 40)
    expect(summary.totals.downloadedBytes / summary.totals.downloadMs).toBe(16 / 80)
    expect(summary.totals.uploadMs).toBe(records.reduce((sum, record) => sum + record.uploadMs, 0))
    expect(summary.totals.downloadMs).toBe(records.reduce((sum, record) => sum + record.downloadMs, 0))
    expect(summary.totals.uploadedBytes / summary.totals.uploadMs)
      .not.toBe(records.reduce((sum, record) => sum + record.uploadedBytes / record.uploadMs, 0) / records.length)
  })

  it('copies immutable settings and environment before the first persistence callback', async () => {
    const { options } = fixture({ fileCount: 1, rounds: 1 })
    options.onStart = async () => {
      options.settings.seed = 'changed'
      options.environment.browser = 'changed'
      options.environment.dependencies.adb = 'changed'
    }
    const summary = await runWorkload(options)
    expect(summary.status).toBe('completed')
    expect(summary.settings.seed).toBe('webusb-lab')
    expect(summary.environment.browser).toBe('test browser')
    expect(summary.environment.dependencies.adb).toBe('test')
    expect(Object.isFrozen(summary.settings)).toBe(true)
    expect(Object.isFrozen(summary.environment.dependencies)).toBe(true)
  })

  it('validates limits before any storage or persistence call', async () => {
    const { options, device, starts } = fixture({ fileCount: 65, fileSizeBytes: 16 * 1024 ** 2 })
    await expect(runWorkload(options)).rejects.toThrow('1 GiB')
    expect(device.events).toEqual([])
    expect(starts).toEqual([])
  })

  it.each(['space:8', 'create', 'write:probe.bin', 'read:probe.bin', 'remove:probe.bin'])('fails setup honestly at %s before measured file counts', async (failure) => {
    const { options, device, records } = fixture()
    device.fail = failure
    const summary = await runWorkload(options)
    expect(summary.status).toBe('failed')
    expect(summary.completedFiles).toBe(0)
    expect(summary.totals.uploadedBytes).toBe(0)
    expect(summary.totals.downloadedBytes).toBe(0)
    expect(records).toEqual([])
    expect(device.events.some((event) => event.startsWith('write:r'))).toBe(false)
    if (failure === 'space:8') expect(device.events).toEqual(['space:8'])
  })

  it('checks storage again before each round and stops before the next upload', async () => {
    const { options, device, records } = fixture()
    let checks = 0
    device.onCall = (event) => { if (event.startsWith('space:') && ++checks === 3) device.fail = event }
    const summary = await runWorkload(options)
    expect(summary.status).toBe('failed')
    expect(records).toHaveLength(3)
    expect(summary.completedFiles).toBe(3)
    expect(device.events.some((event) => event.startsWith('write:r000002'))).toBe(false)
  })

  it.each(['corrupt', 'truncated', 'extra', 'swapped'] as const)('detects %s device data and never substitutes upload bytes', async (kind) => {
    const { options, device, records } = fixture({ pattern: 'batch' })
    device.readTransform = (bytes, name) => {
      if (name === 'probe.bin') return bytes
      if (kind === 'corrupt') { bytes[0] ^= 0xff; return bytes }
      if (kind === 'truncated') return bytes.slice(0, -1)
      if (kind === 'extra') return new Uint8Array([...bytes, 42])
      return device.files.get('r000001-f002.bin')!.slice()
    }
    const summary = await runWorkload(options)
    expect(summary.status).toBe('failed')
    expect(summary.completedFiles).toBe(0)
    expect(summary.error).toContain(kind === 'corrupt' || kind === 'swapped' ? 'SHA-256 mismatch' : 'size mismatch')
    expect(summary.totals.uploadedBytes).toBe(24)
    expect(records).toHaveLength(3)
    expect(records.every((record) => !record.passed && !!record.error)).toBe(true)
    expect(device.events.filter((event) => event.startsWith('read:r'))).toEqual(['read:r000001-f001.bin'])
    expect(summary.leftovers).toEqual([])
  })

  it.each(['write', 'stat', 'read'] as const)('records %s failure and stops scheduling further files', async (stage) => {
    const { options, device, records } = fixture()
    device.fail = `${stage}:r000001-f002.bin`
    const summary = await runWorkload(options)
    expect(summary.status).toBe('failed')
    expect(summary.completedFiles).toBe(1)
    expect(records).toHaveLength(2)
    expect(records[0].passed).toBe(true)
    expect(records[1]).toMatchObject({ passed: false, error: expect.stringContaining('Injected') })
    expect(summary.totals.uploadedBytes).toBe(stage === 'write' ? 8 : 16)
    expect(summary.totals.downloadedBytes).toBe(8)
    expect(device.events.some((event) => event.includes('f003'))).toBe(false)
  })

  it('preserves partial batch upload records without counting successful uploads twice', async () => {
    const { options, device, records } = fixture({ pattern: 'batch' })
    device.fail = 'write:r000001-f003.bin'
    const summary = await runWorkload(options)
    expect(summary.totals.uploadedBytes).toBe(16)
    expect(summary.totals.downloadedBytes).toBe(0)
    expect(records.map((record) => record.uploadedBytes)).toEqual([8, 8, 0])
    expect(records.every((record) => !record.passed)).toBe(true)
    expect(summary.completedFiles).toBe(0)
  })

  it('treats wrong stat size and probe corruption as failures outside transfer intervals', async () => {
    const { options, device, records } = fixture()
    const stat = device.statFile.bind(device)
    device.statFile = async (id, name) => (await stat(id, name)) + (name === 'probe.bin' ? 0 : 1)
    let summary = await runWorkload(options)
    expect(summary.error).toContain('Uploaded size mismatch')
    expect(records[0].uploadedBytes).toBe(8)
    expect(records[0].downloadedBytes).toBe(0)
    device.readTransform = (bytes) => { bytes[0] ^= 1; return bytes }
    summary = await runWorkload(options)
    expect(summary.error).toContain('Capability probe integrity')
  })

  it('stops on initial or per-file persistence failure rather than silently dropping records', async () => {
    const { options, device } = fixture()
    options.onStart = async () => { throw new Error('database unavailable') }
    let summary = await runWorkload(options)
    expect(summary.status).toBe('failed')
    expect(summary.error).toContain('database unavailable')
    expect(device.events).toEqual([])
    options.onStart = async () => {}
    options.onFile = vi.fn(async () => { throw new Error('quota exceeded') })
    summary = await runWorkload(options)
    expect(summary.status).toBe('failed')
    expect(summary.error).toContain('Result persistence failed: quota exceeded')
    expect(summary.completedFiles).toBe(0)
    expect(options.onFile).toHaveBeenCalledTimes(1)
    expect(device.events.some((event) => event.includes('f002'))).toBe(false)
  })

  it.each(['prepare', 'hash'] as const)('stops and records worker %s failures outside transfer intervals', async (stage) => {
    const { options, device, records } = fixture()
    if (stage === 'prepare') {
      const prepare = options.payloads.prepare.bind(options.payloads)
      options.payloads.prepare = (size, seed, index) => {
        if (index === 1) return Promise.reject(new Error('generation failed'))
        return prepare(size, seed, index)
      }
    } else {
      const hash = options.payloads.hash.bind(options.payloads)
      let calls = 0
      options.payloads.hash = (bytes) => {
        if (++calls === 2) return Promise.reject(new Error('hash failed'))
        return hash(bytes)
      }
    }
    const summary = await runWorkload(options)
    expect(summary.status).toBe('failed')
    expect(records).toHaveLength(1)
    expect(records[0].passed).toBe(false)
    expect(summary.completedFiles).toBe(0)
    expect(summary.totals.uploadedBytes).toBe(stage === 'prepare' ? 0 : 8)
    expect(summary.totals.downloadedBytes).toBe(stage === 'prepare' ? 0 : 8)
    expect(device.events.some((event) => event.includes('f002'))).toBe(false)
  })

  it('waits for each successful persistence write before scheduling the next file', async () => {
    const { options, device } = fixture({ rounds: 1 })
    options.onFile = async (result) => {
      expect(device.events.some((event) => event.includes(`f00${result.index + 1}`))).toBe(false)
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    expect((await runWorkload(options)).status).toBe('completed')
  })

  it('reports cleanup failure and conservative owned leftovers', async () => {
    const { options, device, records } = fixture({ pattern: 'batch' })
    device.fail = 'remove:r000001-f001.bin'
    device.cleanupRun = async () => { throw new Error('cleanup denied') }
    const summary = await runWorkload(options)
    expect(summary.status).toBe('failed')
    expect(summary.error).toContain('cleanup denied')
    expect(records[0].passed).toBe(false)
    expect(summary.leftovers).toEqual(['r000001-f001.bin', 'r000001-f002.bin', 'r000001-f003.bin'])
    expect(device.events.some((event) => event === 'read:r000001-f002.bin')).toBe(false)
  })

  it('reports directory-only cleanup failure without inventing file leftovers', async () => {
    const { options, device } = fixture({ fileCount: 1, rounds: 1 })
    device.fail = 'cleanup'
    const summary = await runWorkload(options)
    expect(summary.status).toBe('failed')
    expect(summary.completedFiles).toBe(1)
    expect(summary.leftovers).toEqual([`${summary.id}/`])
    expect(device.events.filter((event) => event === 'cleanup')).toHaveLength(1)
  })

  it.each(['write', 'read'] as const)('invalidates immediately on mid-%s stop and never schedules another SYNC call', async (stage) => {
    const { options, device, controller, records } = fixture({ pattern: 'batch' })
    const stoppedAt = `${stage}:r000001-f001.bin`
    device.onCall = (event) => { if (event === stoppedAt) controller.abort() }
    const summary = await runWorkload(options)
    expect(summary.status).toBe('canceled')
    expect(summary.error).toContain('reconnect')
    expect(device.connected).toBe(false)
    expect(device.events.slice(device.events.indexOf(stoppedAt) + 1).filter((event) => !event.startsWith('persist:')))
      .toEqual(['abort', 'dispose'])
    expect(summary.leftovers).toContain('r000001-f001.bin')
    expect(records.every((record) => !record.passed)).toBe(true)
  })

  it('handles permanently stalled transfer teardown without reuse or unhandled late rejection', async () => {
    const { options, device, controller } = fixture({ fileCount: 1, rounds: 1 })
    const write = device.writeFile.bind(device)
    let rejectPending!: (error: Error) => void
    device.writeFile = (id, name, bytes) => {
      if (name === 'probe.bin') return write(id, name, bytes)
      const stalled = new Promise<void>((_, reject) => { rejectPending = reject })
      queueMicrotask(() => controller.abort())
      return stalled
    }
    const summary = await runWorkload(options)
    expect(summary.status).toBe('canceled')
    expect(summary.error).toContain('teardown timeout')
    expect(summary.leftovers).toEqual(['r000001-f001.bin'])
    rejectPending(new Error('late transport rejection'))
    await Promise.resolve()
    expect(device.events).not.toContain('cleanup')
  })

  it('cancels an already-stopped run without touching storage or persistence', async () => {
    const { options, device, controller, starts } = fixture()
    controller.abort()
    const summary = await runWorkload(options)
    expect(summary.status).toBe('canceled')
    expect(device.events).toEqual(['abort', 'dispose'])
    expect(starts).toHaveLength(0)
    expect(summary.leftovers).toEqual([])
  })

  it('preserves completed records when stop follows a successful persistence callback', async () => {
    const { options, device, records, controller } = fixture()
    const persist = options.onFile
    options.onFile = async (result) => {
      await persist(result)
      queueMicrotask(() => controller.abort())
    }
    const summary = await runWorkload(options)
    expect(summary.status).toBe('canceled')
    expect(records[0].passed).toBe(true)
    expect(summary.completedFiles).toBe(1)
    expect(device.events.some((event) => event.includes('f002'))).toBe(false)
  })

  it('waits for a successful in-flight commit after Stop before finalizing counts', async () => {
    const { options, device, records, controller } = fixture()
    const persist = options.onFile
    options.onFile = async (result) => {
      controller.abort()
      await new Promise((resolve) => setTimeout(resolve, 10))
      await persist(result)
    }
    const summary = await runWorkload(options)
    expect(summary.status).toBe('canceled')
    expect(summary.completedFiles).toBe(1)
    expect(records).toHaveLength(1)
    expect(records[0].passed).toBe(true)
    expect(records[0].error).toBeUndefined()
    expect(summary.totals.uploadedBytes).toBe(records[0].uploadedBytes)
    expect(device.events.some((event) => event.includes('f002'))).toBe(false)
  })

  it('refuses overlapping runs on the same device', async () => {
    const { options, device, controller } = fixture()
    let started!: () => void
    const waiting = new Promise<void>((resolve) => { started = resolve })
    options.onStart = async () => { started(); await new Promise<void>(() => {}) }
    const first = runWorkload(options)
    await waiting
    await expect(runWorkload(options)).rejects.toThrow('already has an active run')
    controller.abort()
    expect((await first).status).toBe('canceled')
    expect(device.events).toEqual(['abort', 'dispose'])
  })
})
