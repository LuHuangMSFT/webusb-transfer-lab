import type { DeviceStorage, FileResult, Phase, RunnerOptions, RunSummary } from './types'
import { estimateWorkload, validateSettings } from './workload'

const activeDevices = new WeakSet<DeviceStorage>()
const SETTLEMENT_TIMEOUT_MS = 1000

interface ActiveFile {
  result: FileResult
  persistenceAttempted: boolean
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function runWorkload(options: RunnerOptions): Promise<RunSummary> {
  const settings = validateSettings(options.settings)
  const estimate = estimateWorkload(settings)
  const { device, payloads, signal } = options
  if (activeDevices.has(device)) throw new Error('This device already has an active run.')
  const wallStart = performance.now()
  const summary: RunSummary = {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    settings,
    device: Object.freeze({
      model: device.info.model,
      manufacturer: device.info.manufacturer,
      features: Object.freeze([...device.info.features]) as string[],
      maxPayloadSize: device.info.maxPayloadSize,
    }),
    environment: Object.freeze({
      siteCommit: options.environment.siteCommit,
      siteVersion: options.environment.siteVersion,
      browser: options.environment.browser,
      dependencies: Object.freeze({ ...options.environment.dependencies }),
    }),
    startedAt: new Date().toISOString(),
    completedAt: '',
    timeOrigin: performance.timeOrigin,
    status: 'running',
    completedFiles: 0,
    expectedFiles: estimate.totalFiles,
    totals: {
      uploadedBytes: 0, downloadedBytes: 0, prepareMs: 0, uploadMs: 0,
      downloadMs: 0, verifyMs: 0, cleanupMs: 0, setupMs: 0, wallMs: 0,
    },
    leftovers: [],
  }
  activeDevices.add(device)
  const filesOnDevice = new Set<string>()
  const activeFiles: ActiveFile[] = []
  const outstanding = new Set<Promise<unknown>>()
  let current: ActiveFile | undefined
  let runCreated = false
  let creationAttempted = false
  let cleanupAttempted = false
  let invalidated = false
  let persistenceFailed = false
  let lastProgress = -Infinity
  let round = 0
  let file = 0
  let rejectCanceled!: (error: Error) => void
  const canceled = new Promise<never>((_, reject) => { rejectCanceled = reject })
  void canceled.catch(() => {})

  function abort(): void {
    if (invalidated) return
    invalidated = true
    try { device.abort() } catch { /* The session must still never be reused. */ }
    try { payloads.dispose() } catch { /* Rejection below still stops the runner. */ }
    rejectCanceled(new Error('Run canceled. Connection invalidated; reconnect before cleanup.'))
  }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()

  function checkCanceled(): void {
    if (invalidated || signal.aborted) throw new Error('Run canceled. Connection invalidated; reconnect before cleanup.')
  }

  function track<T>(action: () => Promise<T>): Promise<T> {
    let operation: Promise<T>
    try { operation = Promise.resolve(action()) } catch (error) { operation = Promise.reject(error) }
    outstanding.add(operation)
    void operation.then(() => outstanding.delete(operation), () => outstanding.delete(operation))
    return operation
  }

  async function operation<T>(action: () => Promise<T>): Promise<T> {
    checkCanceled()
    return await Promise.race([track(action), canceled])
  }

  function progress(phase: Phase, message: string, force = false): void {
    checkCanceled()
    const now = performance.now()
    if (!force && now - lastProgress < 100) return
    lastProgress = now
    options.onProgress({ phase, round, file, completed: summary.completedFiles, total: estimate.totalFiles, message })
  }

  async function timed<T>(phase: Phase, action: () => Promise<T>, target?: FileResult): Promise<T> {
    const label = `${summary.id}:${phase}`
    const start = performance.now()
    performance.mark(`${label}:start`)
    try {
      return await action()
    } finally {
      const elapsed = Math.max(0, performance.now() - start)
      const key = `${phase}Ms` as keyof RunSummary['totals']
      summary.totals[key] += elapsed
      if (target && phase !== 'setup') target[`${phase}Ms`] += elapsed
      performance.mark(`${label}:end`)
      performance.measure(label, `${label}:start`, `${label}:end`)
      performance.clearMarks(`${label}:start`)
      performance.clearMarks(`${label}:end`)
      performance.clearMeasures(label)
    }
  }

  async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Pending operation did not settle within teardown timeout.')), SETTLEMENT_TIMEOUT_MS)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  async function persist(active: ActiveFile): Promise<void> {
    active.persistenceAttempted = true
    try {
      const snapshot = Object.freeze({ ...active.result })
      // A storage commit can still succeed after Stop. Await its outcome before
      // counting it or finalizing the report, instead of racing cancellation.
      await track(() => options.onFile(snapshot))
    } catch (error) {
      persistenceFailed = true
      if (invalidated) throw new Error(`Result persistence interrupted: ${errorMessage(error)}`)
      throw new Error(`Result persistence failed: ${errorMessage(error)}`)
    }
  }

  function newFile(index: number): ActiveFile {
    const active: ActiveFile = {
      persistenceAttempted: false,
      result: {
        runId: summary.id, round, index,
        name: `r${String(round).padStart(6, '0')}-f${String(index).padStart(3, '0')}.bin`,
        bytes: settings.fileSizeBytes, expectedSha256: '', actualSha256: '',
        uploadedBytes: 0, downloadedBytes: 0,
        prepareMs: 0, uploadMs: 0, downloadMs: 0, verifyMs: 0, cleanupMs: 0,
        passed: false,
      },
    }
    activeFiles.push(active)
    current = active
    file = index
    return active
  }

  async function upload(active: ActiveFile): Promise<void> {
    const result = active.result
    progress('prepare', 'Generating one file and its expected SHA-256.')
    const payload = await timed('prepare',
      () => operation(() => payloads.prepare(settings.fileSizeBytes, settings.seed, result.index)), result)
    if (payload.bytes.byteLength !== settings.fileSizeBytes) throw new Error('Generated payload has the wrong size.')
    result.expectedSha256 = payload.sha256
    progress('upload', `Uploading ${result.name}.`)
    checkCanceled()
    filesOnDevice.add(result.name)
    await timed('upload', () => operation(() => device.writeFile(summary.id, result.name, payload.bytes)), result)
    result.uploadedBytes = settings.fileSizeBytes
    summary.totals.uploadedBytes += result.uploadedBytes
    await timed('verify', async () => {
      const size = await operation(() => device.statFile(summary.id, result.name))
      if (size !== settings.fileSizeBytes) throw new Error(`Uploaded size mismatch for ${result.name}: expected ${settings.fileSizeBytes}, got ${size}.`)
    }, result)
  }

  async function downloadAndRemove(active: ActiveFile): Promise<void> {
    current = active
    const result = active.result
    file = result.index
    progress('download', `Reading ${result.name} from the device.`)
    const received = await timed('download',
      () => operation(() => device.readFile(summary.id, result.name, settings.fileSizeBytes)), result)
    result.downloadedBytes = received.byteLength
    summary.totals.downloadedBytes += received.byteLength
    progress('verify', `Verifying ${result.name}.`)
    await timed('verify', async () => {
      if (received.byteLength !== settings.fileSizeBytes) {
        throw new Error(`Downloaded size mismatch for ${result.name}: expected ${settings.fileSizeBytes}, got ${received.byteLength}.`)
      }
      result.actualSha256 = await operation(() => payloads.hash(received))
      if (result.actualSha256 !== result.expectedSha256) throw new Error(`SHA-256 mismatch for ${result.name}.`)
    }, result)
    progress('cleanup', `Removing verified file ${result.name}.`)
    await timed('cleanup', () => operation(() => device.removeFile(summary.id, result.name)), result)
    filesOnDevice.delete(result.name)
    result.passed = true
    await persist(active)
    summary.completedFiles++
    activeFiles.shift()
    current = undefined
  }

  async function cleanupRun(): Promise<void> {
    cleanupAttempted = true
    await timed('cleanup', () => operation(() => device.cleanupRun(summary.id)))
    filesOnDevice.clear()
    runCreated = false
    creationAttempted = false
  }

  try {
    // Give persistence a detached initial snapshot before touching device storage.
    await operation(() => options.onStart({
      ...summary, totals: { ...summary.totals }, leftovers: [],
    }))
    progress('setup', 'Checking storage and probing real device write/read/delete support.', true)
    await timed('setup', async () => {
      if (!device.connected) throw new Error('Device is disconnected.')
      await operation(() => device.checkSpace(estimate.peakDeviceBytes))
      creationAttempted = true
      await operation(() => device.createRun(summary.id))
      runCreated = true
      const size = Math.min(64, settings.fileSizeBytes)
      const probe = await operation(() => payloads.prepare(size, settings.seed, 0))
      filesOnDevice.add('probe.bin')
      await operation(() => device.writeFile(summary.id, 'probe.bin', probe.bytes))
      if (await operation(() => device.statFile(summary.id, 'probe.bin')) !== size) {
        throw new Error('Capability probe uploaded size mismatch.')
      }
      const received = await operation(() => device.readFile(summary.id, 'probe.bin', size))
      if (received.byteLength !== size || await operation(() => payloads.hash(received)) !== probe.sha256) {
        throw new Error('Capability probe integrity verification failed.')
      }
      await operation(() => device.removeFile(summary.id, 'probe.bin'))
      filesOnDevice.delete('probe.bin')
    })

    for (round = 1; round <= settings.rounds; round++) {
      checkCanceled()
      file = 0
      await timed('setup', () => operation(() => device.checkSpace(estimate.peakDeviceBytes)))
      if (settings.pattern === 'round-trip') {
        for (let index = 1; index <= settings.fileCount; index++) {
          checkCanceled()
          const active = newFile(index)
          await upload(active)
          await downloadAndRemove(active)
        }
      } else {
        for (let index = 1; index <= settings.fileCount; index++) {
          checkCanceled()
          await upload(newFile(index))
        }
        while (activeFiles.length) {
          checkCanceled()
          await downloadAndRemove(activeFiles[0])
        }
      }
    }
    current = undefined
    progress('cleanup', 'Removing the empty run directory.')
    await cleanupRun()
    summary.status = 'completed'
  } catch (error) {
    summary.status = invalidated || signal.aborted ? 'canceled' : 'failed'
    summary.error = errorMessage(error)
    if (current) {
      current.result.passed = false
      current.result.error = summary.error
    }
    if (runCreated && !cleanupAttempted && !invalidated && device.connected) {
      try { await cleanupRun() } catch (cleanupError) {
        summary.error += ` Cleanup failed: ${errorMessage(cleanupError)}`
      }
    }
    for (const active of activeFiles) {
      if (persistenceFailed) break
      if (active.persistenceAttempted) continue
      active.result.passed = false
      active.result.error ??= `Not verified; run stopped: ${summary.error}`
      try { await persist(active) } catch (persistenceError) {
        summary.error += ` ${errorMessage(persistenceError)}`
      }
    }
  } finally {
    signal.removeEventListener('abort', abort)
    if (invalidated) {
      summary.status = 'canceled'
      if (!summary.error?.includes('reconnect')) {
        summary.error = `${summary.error ?? 'Run canceled.'} Connection invalidated; reconnect before cleanup.`
      }
      try { await bounded(Promise.allSettled([...outstanding])) } catch (error) {
        summary.error += ` ${errorMessage(error)}`
      }
    }
    summary.leftovers = [...filesOnDevice]
    if ((runCreated || creationAttempted) && !summary.leftovers.length) summary.leftovers.push(`${summary.id}/`)
    summary.completedAt = new Date().toISOString()
    summary.totals.wallMs = Math.max(0, performance.now() - wallStart)
    activeDevices.delete(device)
  }
  return summary
}
