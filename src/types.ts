export type Pattern = 'round-trip' | 'batch'
export type Architecture = 'arm64' | 'x64' | 'other'

export interface Settings {
  fileCount: number
  fileSizeBytes: number
  rounds: number
  pattern: Pattern
  seed: string
  buildLabel: string
  architecture: Architecture
  notes: string
}

export interface DeviceInfo {
  model: string
  manufacturer: string
  features: string[]
  maxPayloadSize: number
}

export interface DeviceStorage {
  readonly info: DeviceInfo
  readonly connected: boolean
  createRun(runId: string): Promise<void>
  checkSpace(peakBytes: number): Promise<void>
  writeFile(runId: string, name: string, data: Uint8Array<ArrayBuffer>): Promise<void>
  readFile(runId: string, name: string, expectedBytes: number): Promise<Uint8Array<ArrayBuffer>>
  statFile(runId: string, name: string): Promise<number>
  removeFile(runId: string, name: string): Promise<void>
  cleanupRun(runId: string): Promise<void>
  // Immediately invalidates the session; transport teardown may finish later.
  abort(): void
}

export interface PayloadService {
  prepare(size: number, seed: string, index: number): Promise<{ bytes: Uint8Array<ArrayBuffer>; sha256: string }>
  hash(bytes: Uint8Array<ArrayBuffer>): Promise<string>
  dispose(): void
}

export type Phase = 'setup' | 'prepare' | 'upload' | 'download' | 'verify' | 'cleanup'
export interface Progress {
  phase: Phase
  round: number
  file: number
  completed: number
  total: number
  message: string
}

export interface FileResult {
  runId: string
  round: number
  index: number
  name: string
  bytes: number
  expectedSha256: string
  actualSha256: string
  uploadedBytes: number
  downloadedBytes: number
  prepareMs: number
  uploadMs: number
  downloadMs: number
  verifyMs: number
  cleanupMs: number
  passed: boolean
  error?: string
}

export interface Environment {
  siteCommit: string
  siteVersion: string
  browser: string
  dependencies: Record<string, string>
  diagnosticsEnabled?: boolean
}

export interface RunSummary {
  schemaVersion: 1
  id: string
  settings: Settings
  device: DeviceInfo
  environment: Environment
  startedAt: string
  completedAt: string
  timeOrigin: number
  status: 'running' | 'completed' | 'failed' | 'canceled'
  completedFiles: number
  expectedFiles: number
  totals: {
    uploadedBytes: number
    downloadedBytes: number
    prepareMs: number
    uploadMs: number
    downloadMs: number
    verifyMs: number
    cleanupMs: number
    setupMs: number
    wallMs: number
  }
  error?: string
  leftovers: string[]
}

export interface RunReport {
  schemaVersion: 1
  run: RunSummary
  files: FileResult[]
}

export interface RunnerOptions {
  device: DeviceStorage
  settings: Settings
  environment: Environment
  payloads: PayloadService
  signal: AbortSignal
  onProgress(progress: Progress): void
  onFile(result: FileResult): Promise<void>
  onStart(summary: RunSummary): Promise<void>
}
