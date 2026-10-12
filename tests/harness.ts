import { createPayloadService } from '../src/payload'
import { ReportStore, parseReportJson } from '../src/results'
import { runWorkload } from '../src/runner'
import { DEFAULT_SETTINGS } from '../src/workload'
import type { DeviceStorage, Pattern } from '../src/types'
import { diagnosticSnapshot, setDiagnosticsEnabled } from '../src/diagnostics'

type Scenario = 'success' | 'corrupt' | 'cancel-commit' | 'fail-commit'

class SimulatedDevice implements DeviceStorage {
  readonly info = { model: 'Simulated phone', manufacturer: 'Test fixture', features: ['simulated'], maxPayloadSize: 65536 }
  connected = true
  readonly files = new Map<string, Uint8Array<ArrayBuffer>>()
  peakFiles = 0
  private readonly scenario: Scenario
  constructor(scenario: Scenario) { this.scenario = scenario }
  async createRun() {}
  async checkSpace() {}
  async writeFile(_runId: string, name: string, data: Uint8Array<ArrayBuffer>) {
    this.files.set(name, data.slice())
    this.peakFiles = Math.max(this.peakFiles, this.files.size)
  }
  async readFile(_runId: string, name: string) {
    const bytes = this.files.get(name)!.slice()
    if (this.scenario === 'corrupt' && name !== 'probe.bin') bytes[0] ^= 0xff
    return bytes
  }
  async statFile(_runId: string, name: string) { return this.files.get(name)!.byteLength }
  async removeFile(_runId: string, name: string) { this.files.delete(name) }
  async cleanupRun() { this.files.clear() }
  abort() { this.connected = false }
}

async function simulate(pattern: Pattern, scenario: Scenario, tracing = false) {
  setDiagnosticsEnabled(tracing)
  const store = new ReportStore()
  await store.ready()
  const device = new SimulatedDevice(scenario)
  const payloads = createPayloadService()
  const controller = new AbortController()
  try {
    const summary = await runWorkload({
      device, payloads, signal: controller.signal,
      settings: { ...DEFAULT_SETTINGS, fileCount: 3, fileSizeBytes: 64 * 1024, rounds: 2, pattern },
      environment: {
        siteCommit: 'integration-test', siteVersion: '0.1.0', browser: navigator.userAgent,
        dependencies: { '@yume-chan/adb': '2.6.4', '@yume-chan/adb-daemon-webusb': '2.3.2', '@yume-chan/stream-extra': '2.6.1' },
      },
      onProgress() {},
      onStart: (run) => store.start(run),
      onFile: async (file) => {
        if (scenario === 'fail-commit') throw new Error('Injected storage failure before commit')
        if (scenario === 'cancel-commit') {
          controller.abort()
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        await store.appendFile(file)
      },
    })
    let finishError = ''
    try { await store.finish(summary) } catch (error) {
      finishError = error instanceof Error ? error.message : String(error)
    }
    const json = await (await store.export(summary.id, 'json')).text()
    const csv = await (await store.export(summary.id, 'csv')).text()
    const report = parseReportJson(json)
    return { report, csv, statistics: await store.stats(summary.id), peakFiles: device.peakFiles, phoneFiles: device.files.size, finishError,
      diagnostics: diagnosticSnapshot() }
  } finally {
    payloads.dispose()
  }
}

declare global {
  interface Window { simulate: typeof simulate }
}
window.simulate = simulate
