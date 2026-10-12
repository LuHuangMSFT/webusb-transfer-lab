import type { DeviceInfo, Environment, FileResult, RunReport, RunSummary, Settings } from './types'
import { validateSettings } from './workload'

export const MAX_IMPORT_BYTES = 16 * 1024 * 1024
export const MAX_IMPORT_FILES = 20_000
const MIB = 1024 * 1024
const MAX = Number.MAX_SAFE_INTEGER
const dependencyNames = ['@yume-chan/adb', '@yume-chan/adb-daemon-webusb', '@yume-chan/stream-extra']
const fileTimings = ['prepareMs', 'uploadMs', 'downloadMs', 'verifyMs', 'cleanupMs'] as const
const totalFields = ['uploadedBytes', 'downloadedBytes', ...fileTimings, 'setupMs', 'wallMs'] as const

function invalid(message: string): never {
  throw new Error(`Invalid report: ${message}`)
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${label} must be an object.`)
  return value as Record<string, unknown>
}

function fields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) invalid(`missing ${key}.`)
  }
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) invalid(`unexpected field "${key}".`)
  }
}

function text(value: unknown, label: string, maxLength = 256, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maxLength || (!allowEmpty && !value.trim())) {
    invalid(`${label} must be ${allowEmpty ? 'text' : 'nonempty text'} of at most ${maxLength} characters.`)
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) invalid(`${label} contains control characters.`)
  return value
}

function number(value: unknown, label: string, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX ||
      (integer && !Number.isSafeInteger(value))) invalid(`${label} must be a finite nonnegative ${integer ? 'safe integer' : 'number'}.`)
  return value
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') invalid(`${label} must be a boolean.`)
  return value
}

function timestamp(value: unknown, label: string): string {
  const result = text(value, label, 32)
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/u.test(result) ||
      !Number.isFinite(Date.parse(result)) ||
      new Date(result).toISOString().slice(0, 19) !== result.slice(0, 19)) invalid(`${label} must be a valid UTC ISO timestamp.`)
  return result
}

function identifier(value: unknown, label: string): string {
  const result = text(value, label, 100)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(result)) invalid(`${label} contains an unsafe identifier.`)
  return result
}

function strings(value: unknown, label: string, limit: number, maxLength = 256): string[] {
  if (!Array.isArray(value) || value.length > limit) invalid(`${label} must be an array of at most ${limit} items.`)
  return value.map((item: unknown) => text(item, label, maxLength))
}

function parseSettings(value: unknown): Settings {
  const source = object(value, 'settings')
  fields(source, ['fileCount', 'fileSizeBytes', 'rounds', 'pattern', 'seed', 'notes'],
    ['tags', 'buildLabel', 'architecture', 'preGenerate', 'reuseAcrossRounds'])
  const pattern = source.pattern
  const architecture = source.architecture
  if (pattern !== 'round-trip' && pattern !== 'batch') invalid('unknown transfer pattern.')
  if (architecture !== undefined && architecture !== 'arm64' && architecture !== 'x64' && architecture !== 'other') invalid('unknown architecture.')
  const settings: Settings = {
    fileCount: number(source.fileCount, 'file count', true),
    fileSizeBytes: number(source.fileSizeBytes, 'file size', true),
    rounds: number(source.rounds, 'rounds', true),
    pattern,
    seed: text(source.seed, 'seed', 256),
    ...(Object.hasOwn(source, 'preGenerate') ? { preGenerate: boolean(source.preGenerate, 'preGenerate') } : {}),
    ...(Object.hasOwn(source, 'reuseAcrossRounds') ? { reuseAcrossRounds: boolean(source.reuseAcrossRounds, 'reuseAcrossRounds') } : {}),
    ...(source.tags === undefined ? {} : { tags: text(source.tags, 'tags', 512, true) }),
    ...(source.buildLabel === undefined ? {} : { buildLabel: text(source.buildLabel, 'build label', 128) }),
    ...(architecture === undefined ? {} : { architecture }),
    notes: text(source.notes, 'notes', 4096, true),
  }
  try {
    return validateSettings(settings)
  } catch (error) {
    invalid(error instanceof Error ? error.message : 'invalid workload.')
  }
}

function parseDevice(value: unknown): DeviceInfo {
  const source = object(value, 'device')
  fields(source, ['model', 'manufacturer', 'features', 'maxPayloadSize'])
  const maxPayloadSize = number(source.maxPayloadSize, 'maximum transport payload', true)
  if (maxPayloadSize === 0) invalid('maximum transport payload must be positive.')
  const features = strings(source.features, 'protocol features', 128, 128)
  if (new Set(features).size !== features.length) invalid('duplicate protocol features.')
  return {
    model: text(source.model, 'device model', 256),
    manufacturer: text(source.manufacturer, 'device manufacturer', 256),
    features,
    maxPayloadSize,
  }
}

function parseEnvironment(value: unknown): Environment {
  const source = object(value, 'environment')
  fields(source, ['siteCommit', 'siteVersion', 'browser', 'dependencies'], ['diagnosticsEnabled'])
  if (source.diagnosticsEnabled !== undefined && typeof source.diagnosticsEnabled !== 'boolean') invalid('diagnosticsEnabled must be a boolean.')
  const dependencies = object(source.dependencies, 'dependencies')
  fields(dependencies, dependencyNames)
  const result: Record<string, string> = {}
  for (const name of dependencyNames) result[name] = text(dependencies[name], name, 64)
  return {
    siteCommit: text(source.siteCommit, 'site commit', 100),
    siteVersion: text(source.siteVersion, 'site version', 32),
    browser: text(source.browser, 'browser', 1024),
    dependencies: result,
    ...(source.diagnosticsEnabled === undefined ? {} : { diagnosticsEnabled: source.diagnosticsEnabled }),
  }
}

function parseSummary(value: unknown): RunSummary {
  const source = object(value, 'run')
  fields(source, ['schemaVersion', 'id', 'settings', 'device', 'environment', 'startedAt', 'completedAt',
    'timeOrigin', 'status', 'completedFiles', 'expectedFiles', 'totals', 'leftovers'], ['error'])
  if (source.schemaVersion !== 1) invalid('unsupported run schema version; expected 1.')
  const status = source.status
  if (status !== 'running' && status !== 'completed' && status !== 'failed' && status !== 'canceled') invalid('unknown run status.')
  const settings = parseSettings(source.settings)
  const rawTotals = object(source.totals, 'totals')
  fields(rawTotals, totalFields)
  const totals: RunSummary['totals'] = {
    uploadedBytes: number(rawTotals.uploadedBytes, 'total uploaded bytes', true),
    downloadedBytes: number(rawTotals.downloadedBytes, 'total downloaded bytes', true),
    prepareMs: number(rawTotals.prepareMs, 'preparation time'),
    uploadMs: number(rawTotals.uploadMs, 'upload time'),
    downloadMs: number(rawTotals.downloadMs, 'download time'),
    verifyMs: number(rawTotals.verifyMs, 'verification time'),
    cleanupMs: number(rawTotals.cleanupMs, 'cleanup time'),
    setupMs: number(rawTotals.setupMs, 'setup time'),
    wallMs: number(rawTotals.wallMs, 'wall time'),
  }
  const startedAt = timestamp(source.startedAt, 'start time')
  const completedAt = status === 'running' && source.completedAt === '' ? '' : timestamp(source.completedAt, 'completion time')
  if (completedAt && Date.parse(completedAt) < Date.parse(startedAt)) invalid('completion predates the start.')
  const expectedFiles = number(source.expectedFiles, 'expected files', true)
  const completedFiles = number(source.completedFiles, 'completed files', true)
  if (expectedFiles !== settings.fileCount * settings.rounds || completedFiles > expectedFiles) invalid('file counts do not match the workload.')
  const leftovers = strings(source.leftovers, 'leftover records', 102, 256)
  const error = source.error === undefined ? undefined : text(source.error, 'run error', 4000)
  if (status === 'completed' && (completedFiles !== expectedFiles || error || leftovers.length)) invalid('a completed report has incomplete files, an error, or leftovers.')
  return {
    schemaVersion: 1,
    id: identifier(source.id, 'run ID'),
    settings,
    device: parseDevice(source.device),
    environment: parseEnvironment(source.environment),
    startedAt,
    completedAt,
    timeOrigin: number(source.timeOrigin, 'performance time origin'),
    status,
    completedFiles,
    expectedFiles,
    totals,
    ...(error === undefined ? {} : { error }),
    leftovers,
  }
}

function hash(value: unknown, label: string): string {
  const result = text(value, label, 64, true)
  if (result !== '' && !/^[a-f0-9]{64}$/u.test(result)) invalid(`${label} is not a SHA-256 digest.`)
  return result
}

function parseFile(value: unknown, run: RunSummary): FileResult {
  const source = object(value, 'file result')
  fields(source, ['runId', 'round', 'index', 'name', 'bytes', 'expectedSha256', 'actualSha256',
    'uploadedBytes', 'downloadedBytes', ...fileTimings, 'passed'], ['error'])
  const runId = identifier(source.runId, 'file run ID')
  const round = number(source.round, 'file round', true)
  const index = number(source.index, 'file index', true)
  const bytes = number(source.bytes, 'file bytes', true)
  if (runId !== run.id || round < 1 || round > run.settings.rounds || index < 1 || index > run.settings.fileCount ||
      bytes !== run.settings.fileSizeBytes) invalid('file record does not match its run or workload.')
  const name = text(source.name, 'file name', 128)
  if (name !== `r${String(round).padStart(6, '0')}-f${String(index).padStart(3, '0')}.bin`) invalid('generated filename does not match its round and index.')
  const uploadedBytes = number(source.uploadedBytes, 'uploaded bytes', true)
  const downloadedBytes = number(source.downloadedBytes, 'downloaded bytes', true)
  if (uploadedBytes > bytes || downloadedBytes > bytes) invalid('transferred byte count exceeds the file size.')
  if (typeof source.passed !== 'boolean') invalid('passed must be a boolean.')
  const expectedSha256 = hash(source.expectedSha256, 'expected hash')
  const actualSha256 = hash(source.actualSha256, 'actual hash')
  const error = source.error === undefined ? undefined : text(source.error, 'file error', 4000)
  if (source.passed && (!expectedSha256 || expectedSha256 !== actualSha256 || error ||
      uploadedBytes !== bytes || downloadedBytes !== bytes)) invalid('a passed file has inconsistent integrity evidence.')
  return {
    runId, round, index, name, bytes, expectedSha256, actualSha256, uploadedBytes, downloadedBytes,
    prepareMs: number(source.prepareMs, 'preparation time'),
    uploadMs: number(source.uploadMs, 'upload time'),
    downloadMs: number(source.downloadMs, 'download time'),
    verifyMs: number(source.verifyMs, 'verification time'),
    cleanupMs: number(source.cleanupMs, 'file cleanup time'),
    passed: source.passed,
    ...(error === undefined ? {} : { error }),
  }
}

interface Evidence {
  count: number
  passed: number
  uploadedBytes: number
  downloadedBytes: number
  prepareMs: number
  uploadMs: number
  downloadMs: number
  verifyMs: number
  cleanupMs: number
}

function evidence(): Evidence {
  return { count: 0, passed: 0, uploadedBytes: 0, downloadedBytes: 0, prepareMs: 0, uploadMs: 0, downloadMs: 0, verifyMs: 0, cleanupMs: 0 }
}

function addEvidence(target: Evidence, file: FileResult): void {
  target.count++
  target.passed += Number(file.passed)
  target.uploadedBytes += file.uploadedBytes
  target.downloadedBytes += file.downloadedBytes
  for (const key of fileTimings) target[key] += file[key]
}

function closeEnough(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(0.000001, Math.abs(left) * Number.EPSILON * 128)
}

function checkEvidence(run: RunSummary, collected: Evidence): void {
  if (collected.count > run.expectedFiles || collected.passed !== run.completedFiles ||
      (run.status === 'completed' && collected.count !== run.expectedFiles)) invalid('summary file counts do not match the records.')
  for (const key of ['uploadedBytes', 'downloadedBytes'] as const) {
    if (run.totals[key] !== collected[key]) invalid(`summary ${key} does not match the records.`)
  }
  for (const key of ['prepareMs', 'uploadMs', 'downloadMs', 'verifyMs'] as const) {
    if (!closeEnough(run.totals[key], collected[key])) invalid(`summary ${key} does not match the records.`)
  }
  // Run-directory cleanup is additional to the per-file delete timings.
  if (run.totals.cleanupMs + 0.001 < collected.cleanupMs) invalid('summary cleanup time is shorter than the recorded deletes.')
}

/** Validates and reconstructs a versioned report; unknown fields are rejected. */
export function validateReport(value: unknown): RunReport {
  const source = object(value, 'report')
  fields(source, ['schemaVersion', 'run', 'files'])
  if (source.schemaVersion !== 1) invalid('unsupported schema version; expected 1.')
  const run = parseSummary(source.run)
  if (!Array.isArray(source.files) || source.files.length > MAX_IMPORT_FILES) {
    invalid(`files must be an array of at most ${MAX_IMPORT_FILES.toLocaleString('en-US')} records.`)
  }
  const files = source.files.map((item: unknown) => parseFile(item, run))
  const seen = new Set<string>()
  const hashes = new Map<number, string>()
  const collected = evidence()
  for (const file of files) {
    const key = `${file.round}:${file.index}`
    if (seen.has(key)) invalid('duplicate file result.')
    seen.add(key)
    const previousHash = hashes.get(file.index)
    if (previousHash && file.expectedSha256 && previousHash !== file.expectedSha256) invalid('expected file hashes differ across repeated rounds.')
    if (file.expectedSha256) hashes.set(file.index, file.expectedSha256)
    addEvidence(collected, file)
  }
  checkEvidence(run, collected)
  return { schemaVersion: 1, run, files }
}

export function parseReportJson(json: string): RunReport {
  if (json.length > MAX_IMPORT_BYTES || new TextEncoder().encode(json).byteLength > MAX_IMPORT_BYTES) {
    throw new Error('Import is too large. The limit is 16 MiB and 20,000 file records per report.')
  }
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    throw new Error('Import is not valid JSON. Choose a WebUSB Transfer Lab JSON report.')
  }
  return validateReport(value)
}

export interface DirectionStatistics {
  count: number
  bytes: number
  totalMs: number
  medianMs: number | null
  p95Ms: number | null
  mibPerSecond: number | null
}

export interface RunStatistics {
  recorded: number
  passed: number
  failed: number
  upload: DirectionStatistics
  download: DirectionStatistics
}

function direction(): DirectionStatistics {
  return { count: 0, bytes: 0, totalMs: 0, medianMs: null, p95Ms: null, mibPerSecond: null }
}

function statistics(): RunStatistics {
  return { recorded: 0, passed: 0, failed: 0, upload: direction(), download: direction() }
}

function addStatistics(stats: RunStatistics, file: FileResult): void {
  stats.recorded++
  stats.passed += Number(file.passed)
  stats.failed += Number(!file.passed)
  for (const name of ['upload', 'download'] as const) {
    const bytes = name === 'upload' ? file.uploadedBytes : file.downloadedBytes
    const elapsed = name === 'upload' ? file.uploadMs : file.downloadMs
    if (bytes === 0 && elapsed === 0) continue
    const target = stats[name]
    target.count++
    target.bytes += bytes
    target.totalMs += elapsed
    target.mibPerSecond = target.totalMs > 0 ? target.bytes / MIB / (target.totalMs / 1000) : null
  }
}

/** Nearest-rank percentile: sorted sample at ceil(p * N), using one-based ranks. */
export function nearestRank(values: readonly number[], percentile: number): number | null {
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 1) throw new Error('Percentile must be in (0, 1].')
  if (!values.length) return null
  if (values.some((value) => !Number.isFinite(value) || value < 0)) throw new Error('Timings must be finite and nonnegative.')
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(percentile * sorted.length) - 1] ?? null
}

export function aggregateResults(files: readonly FileResult[]): RunStatistics {
  const stats = statistics()
  for (const file of files) addStatistics(stats, file)
  for (const name of ['upload', 'download'] as const) {
    const values = files.filter((file) => name === 'upload'
      ? file.uploadedBytes > 0 || file.uploadMs > 0 : file.downloadedBytes > 0 || file.downloadMs > 0)
      .map((file) => name === 'upload' ? file.uploadMs : file.downloadMs)
    stats[name].medianMs = nearestRank(values, 0.5)
    stats[name].p95Ms = nearestRank(values, 0.95)
  }
  return stats
}

export interface Comparison {
  compatible: boolean
  differences: string[]
  warnings: string[]
  uploadTimeDeltaPercent: number | null
  downloadTimeDeltaPercent: number | null
  wallTimeDeltaPercent: number | null
}

export function reportLabel(run: RunSummary): string {
  return run.settings.tags?.trim()
    || [run.settings.buildLabel, run.settings.architecture].filter(Boolean).join(' · ')
    || `Untagged run ${run.id.slice(0, 8)}`
}

export function compareSummaries(left: RunSummary, right: RunSummary): Comparison {
  const differences: string[] = []
  const display = (value: string | number | boolean): string => {
    const result = JSON.stringify(value)
    return result.length > 180 ? `${result.slice(0, 177)}…` : result
  }
  const difference = (label: string, before: string | number | boolean, after: string | number | boolean): void => {
    if (before !== after) differences.push(`Different ${label}: A = ${display(before)}; B = ${display(after)}.`)
  }
  const warnings = [
    'Descriptive comparison of two runs, not a claim of statistical significance or a WinUSB cause.',
    'Confirm the same physical phone, cable, USB port, driver, power and thermal conditions; model names do not identify a unique phone.',
    'Tags and notes are bookkeeping only and are not checked for compatibility. Review the test conditions yourself.',
  ]
  if (left.id === right.id) differences.push('The same run was selected twice.')
  for (const run of [left, right]) {
    if (run.environment.diagnosticsEnabled) {
      differences.push(`${reportLabel(run)}: diagnostic tracing was enabled. Repeat with tracing off for a performance comparison.`)
    }
    if (run.status !== 'completed' || run.completedFiles !== run.expectedFiles || run.leftovers.length || run.error) {
      differences.push(`${reportLabel(run)}: the run is partial, failed, canceled, or has pending cleanup.`)
    }
  }
  for (const key of ['fileCount', 'fileSizeBytes', 'rounds', 'pattern', 'seed'] as const) {
    difference(key, left.settings[key], right.settings[key])
  }
  for (const key of ['preGenerate', 'reuseAcrossRounds'] as const) {
    difference(key, left.settings[key] ?? false, right.settings[key] ?? false)
  }
  for (const key of ['model', 'manufacturer', 'maxPayloadSize'] as const) {
    difference(`device ${key}`, left.device[key], right.device[key])
  }
  difference('negotiated protocol features', JSON.stringify([...left.device.features].sort()), JSON.stringify([...right.device.features].sort()))
  for (const key of ['siteCommit', 'siteVersion', 'browser'] as const) {
    difference(`environment ${key}`, left.environment[key], right.environment[key])
  }
  for (const name of dependencyNames) {
    difference(`${name} version`, left.environment.dependencies[name] ?? '', right.environment.dependencies[name] ?? '')
  }
  if (left.environment.siteCommit === 'local-development' || right.environment.siteCommit === 'local-development') {
    warnings.push('The local-development build has no immutable commit identity; independently confirm identical site code.')
  }
  const compatible = differences.length === 0
  const delta = (before: number, after: number): number | null => compatible && before > 0 ? (after - before) / before * 100 : null
  return {
    compatible, differences, warnings,
    uploadTimeDeltaPercent: delta(left.totals.uploadMs, right.totals.uploadMs),
    downloadTimeDeltaPercent: delta(left.totals.downloadMs, right.totals.downloadMs),
    wallTimeDeltaPercent: delta(left.totals.wallMs, right.totals.wallMs),
  }
}

export function compareReports(left: RunReport, right: RunReport): Comparison {
  return compareSummaries(validateReport(left).run, validateReport(right).run)
}

/** Quote every cell, and neutralize spreadsheet formulas even after whitespace. */
export function csvCell(value: string | number | boolean): string {
  let result = String(value)
  if (typeof value === 'string' && (/^[\s\uFEFF]*[=+\-@]/u.test(result) || /^[\t\r\n]/u.test(result))) result = `'${result}`
  return `"${result.replaceAll('"', '""')}"`
}

const csvHeader = ['row_type', 'run_id', 'build_label', 'architecture', 'device_model', 'notes', 'run_status',
  'round', 'file_index', 'file_name', 'verified_files', 'recorded_files', 'uploaded_bytes', 'downloaded_bytes',
  'prepare_ms', 'upload_ms', 'download_ms', 'verify_ms', 'cleanup_ms', 'setup_ms', 'wall_ms',
  'upload_MiB_s', 'download_MiB_s', 'expected_sha256', 'actual_sha256', 'error',
  'schema_version', 'seed', 'pattern', 'files_per_round', 'file_size_bytes', 'rounds', 'browser',
  'site_version', 'site_commit', 'device_manufacturer', 'adb_max_payload_bytes', 'adb_features',
  'adb_version', 'webusb_version', 'stream_extra_version', 'started_at_utc', 'completed_at_utc',
  'performance_time_origin_ms', 'tags', 'pre_generate', 'reuse_across_rounds', 'diagnostics_enabled']

function csvLine(values: Array<string | number | boolean>): string {
  return `${values.map(csvCell).join(',')}\r\n`
}

function csvPrefix(run: RunSummary, kind: string): Array<string | number> {
  return [kind, run.id, run.settings.buildLabel ?? '', run.settings.architecture ?? '', run.device.model, run.settings.notes, run.status]
}

function csvMetadata(run: RunSummary): Array<string | number | boolean> {
  return [run.schemaVersion, run.settings.seed, run.settings.pattern, run.settings.fileCount, run.settings.fileSizeBytes,
    run.settings.rounds, run.environment.browser, run.environment.siteVersion, run.environment.siteCommit,
    run.device.manufacturer, run.device.maxPayloadSize, run.device.features.join(';'),
    ...dependencyNames.map((name) => run.environment.dependencies[name] ?? ''),
    run.startedAt, run.completedAt, run.timeOrigin, run.settings.tags ?? '',
    run.settings.preGenerate ?? false, run.settings.reuseAcrossRounds ?? false, run.environment.diagnosticsEnabled ? 'true' : 'false']
}

function speed(bytes: number, milliseconds: number): number | string {
  return milliseconds > 0 ? bytes / MIB / (milliseconds / 1000) : ''
}

function fileCsv(run: RunSummary, file: FileResult): string {
  return csvLine([...csvPrefix(run, 'file'), file.round, file.index, file.name, Number(file.passed), 1,
    file.uploadedBytes, file.downloadedBytes, ...fileTimings.map((key) => file[key]), '', '',
    speed(file.uploadedBytes, file.uploadMs), speed(file.downloadedBytes, file.downloadMs),
    file.expectedSha256, file.actualSha256, file.error ?? '', ...csvMetadata(run)])
}

function roundCsv(run: RunSummary, round: number, totals: Evidence): string {
  return csvLine([...csvPrefix(run, 'round'), round, '', '', totals.passed, totals.count,
    totals.uploadedBytes, totals.downloadedBytes, ...fileTimings.map((key) => totals[key]), '', '',
    speed(totals.uploadedBytes, totals.uploadMs), speed(totals.downloadedBytes, totals.downloadMs), '', '', '', ...csvMetadata(run)])
}

function runCsv(run: RunSummary, count: number): string {
  return csvLine([...csvPrefix(run, 'run'), '', '', '', run.completedFiles, count,
    run.totals.uploadedBytes, run.totals.downloadedBytes, ...fileTimings.map((key) => run.totals[key]),
    run.totals.setupMs, run.totals.wallMs, speed(run.totals.uploadedBytes, run.totals.uploadMs),
    speed(run.totals.downloadedBytes, run.totals.downloadMs), '', '', run.error ?? '', ...csvMetadata(run)])
}

export function reportToCsv(value: RunReport): string {
  const report = validateReport(value)
  const parts = [csvLine(csvHeader)]
  let round = 0
  let totals = evidence()
  for (const file of [...report.files].sort((a, b) => a.round - b.round || a.index - b.index)) {
    if (round && file.round !== round) {
      parts.push(roundCsv(report.run, round, totals))
      totals = evidence()
    }
    round = file.round
    addEvidence(totals, file)
    parts.push(fileCsv(report.run, file))
  }
  if (round) parts.push(roundCsv(report.run, round, totals))
  parts.push(runCsv(report.run, report.files.length))
  return parts.join('')
}

function storageError(error: unknown): Error {
  const detail = error instanceof Error ? error.message : 'Browser storage is unavailable.'
  return new Error(`Local report storage failed: ${detail} No results are uploaded. Free site storage or allow IndexedDB, then reload.`, { cause: error })
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result)
    value.onerror = () => reject(storageError(value.error))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(storageError(transaction.error))
    transaction.onerror = () => reject(storageError(transaction.error))
  })
}

/** Stores one completed file at a time. No repeated-run result arrays are retained. */
export class ReportStore {
  private readonly database: Promise<IDBDatabase>

  constructor() {
    this.database = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(storageError(new Error('IndexedDB is not supported.')))
        return
      }
      const open = indexedDB.open('webusb-transfer-lab', 1)
      open.onupgradeneeded = () => {
        const db = open.result
        const runs = db.createObjectStore('runs', { keyPath: 'id' })
        runs.createIndex('startedAt', 'startedAt')
        const files = db.createObjectStore('files', { keyPath: ['runId', 'round', 'index'] })
        files.createIndex('runId', 'runId')
        files.createIndex('uploadMs', ['runId', 'uploadMs'])
        files.createIndex('downloadMs', ['runId', 'downloadMs'])
      }
      open.onerror = () => reject(storageError(open.error))
      open.onblocked = () => reject(storageError(new Error('Another tab is blocking the report database. Close other lab tabs.')))
      open.onsuccess = () => {
        open.result.onversionchange = () => open.result.close()
        resolve(open.result)
      }
    })
  }

  async ready(): Promise<void> {
    await this.database
  }

  async start(summary: RunSummary): Promise<void> {
    const db = await this.database
    const transaction = db.transaction('runs', 'readwrite')
    const done = transactionDone(transaction)
    transaction.objectStore('runs').add(summary)
    await done
  }

  async appendFile(result: FileResult): Promise<void> {
    const db = await this.database
    const transaction = db.transaction(['runs', 'files'], 'readwrite')
    const done = transactionDone(transaction)
    const runs = transaction.objectStore('runs')
    const get: IDBRequest<RunSummary | undefined> = runs.get(result.runId)
    get.onsuccess = () => {
      const summary = get.result
      if (!summary || summary.status !== 'running') {
        transaction.abort()
        return
      }
      transaction.objectStore('files').add(result)
      summary.completedFiles += Number(result.passed)
      summary.totals.uploadedBytes += result.uploadedBytes
      summary.totals.downloadedBytes += result.downloadedBytes
      for (const key of fileTimings) summary.totals[key] += result[key]
      summary.completedAt = new Date().toISOString()
      summary.totals.wallMs = Math.max(0, Date.parse(summary.completedAt) - Date.parse(summary.startedAt))
      runs.put(summary)
    }
    await done
  }

  async finish(summary: RunSummary): Promise<void> {
    const db = await this.database
    const collected = evidence()
    await this.visit(summary.id, (file) => addEvidence(collected, file))
    // Preserve the last consistent partial snapshot if a file record failed to
    // commit. Never replace it with counters that claim unavailable evidence.
    try {
      checkEvidence(summary, collected)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Local report storage could not finalize this run: ${summary.error ?? reason} The last committed partial report is preserved. ${reason}`)
    }
    const transaction = db.transaction('runs', 'readwrite')
    const done = transactionDone(transaction)
    transaction.objectStore('runs').put(summary)
    await done
  }

  async list(limit = 20): Promise<RunSummary[]> {
    const db = await this.database
    return new Promise((resolve, reject) => {
      const rows: RunSummary[] = []
      const cursor = db.transaction('runs').objectStore('runs').index('startedAt').openCursor(null, 'prev')
      cursor.onerror = () => reject(storageError(cursor.error))
      cursor.onsuccess = () => {
        const entry = cursor.result
        if (!entry || rows.length >= limit) {
          resolve(rows)
          return
        }
        rows.push(entry.value as RunSummary)
        entry.continue()
      }
    })
  }

  async get(id: string): Promise<RunSummary> {
    const db = await this.database
    const result = await request<RunSummary | undefined>(db.transaction('runs').objectStore('runs').get(id))
    if (!result) throw new Error('This local report no longer exists.')
    if (result.status !== 'running') return parseSummary(result)
    return parseSummary({
      ...result,
      error: 'Unfinalized partial snapshot: the run may still be active in another tab or may have been interrupted. Final setup, cleanup and wall timings are not available. Check cleanup records after the original run stops.',
    })
  }

  private async visit(id: string, consume: (file: FileResult) => void, timing?: 'uploadMs' | 'downloadMs'): Promise<void> {
    const db = await this.database
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('files')
      const store = transaction.objectStore('files')
      const cursor = timing
        ? store.index(timing).openCursor(IDBKeyRange.bound([id, 0], [id, MAX]))
        : store.openCursor(IDBKeyRange.bound([id, 0, 0], [id, MAX, MAX]))
      cursor.onerror = () => reject(storageError(cursor.error))
      transaction.onabort = () => reject(storageError(transaction.error))
      cursor.onsuccess = () => {
        const entry = cursor.result
        if (!entry) {
          resolve()
          return
        }
        try {
          consume(entry.value as FileResult)
          entry.continue()
        } catch (error) {
          reject(error)
          transaction.abort()
        }
      }
    })
  }

  async stats(id: string): Promise<RunStatistics> {
    const run = await this.get(id)
    const result = statistics()
    const collected = evidence()
    await this.visit(id, (value) => {
      const file = parseFile(value, run)
      addStatistics(result, file)
      addEvidence(collected, file)
    })
    checkEvidence(run, collected)
    for (const name of ['upload', 'download'] as const) {
      let rank = 0
      const target = result[name]
      await this.visit(id, (file) => {
        if (name === 'upload' ? file.uploadedBytes === 0 && file.uploadMs === 0 : file.downloadedBytes === 0 && file.downloadMs === 0) return
        rank++
        const value = name === 'upload' ? file.uploadMs : file.downloadMs
        if (rank === Math.ceil(target.count * 0.5)) target.medianMs = value
        if (rank === Math.ceil(target.count * 0.95)) target.p95Ms = value
      }, name === 'upload' ? 'uploadMs' : 'downloadMs')
    }
    return result
  }

  /** Export work is explicit and separate from transfer. Records are read one by one. */
  async export(id: string, format: 'json' | 'csv'): Promise<Blob> {
    const run = await this.get(id)
    const parts: BlobPart[] = [format === 'json' ? `{"schemaVersion":1,"run":${JSON.stringify(run)},"files":[` : csvLine(csvHeader)]
    const collected = evidence()
    let round = 0
    let roundTotals = evidence()
    let buffer = ''
    await this.visit(id, (value) => {
      const file = parseFile(value, run)
      if (format === 'json') {
        buffer += `${collected.count ? ',' : ''}${JSON.stringify(file)}`
      } else {
        if (round && round !== file.round) {
          buffer += roundCsv(run, round, roundTotals)
          roundTotals = evidence()
        }
        round = file.round
        addEvidence(roundTotals, file)
        buffer += fileCsv(run, file)
      }
      addEvidence(collected, file)
      if (buffer.length >= 64 * 1024) {
        parts.push(new Blob([buffer]))
        buffer = ''
      }
    })
    checkEvidence(run, collected)
    parts.push(buffer)
    if (format === 'json') parts.push(']}')
    else {
      if (round) parts.push(roundCsv(run, round, roundTotals))
      parts.push(runCsv(run, collected.count))
    }
    return new Blob(parts, { type: format === 'json' ? 'application/json' : 'text/csv;charset=utf-8' })
  }

  async remove(id: string): Promise<void> {
    const db = await this.database
    const transaction = db.transaction(['runs', 'files'], 'readwrite')
    const done = transactionDone(transaction)
    transaction.objectStore('runs').delete(id)
    const cursor = transaction.objectStore('files').index('runId').openCursor(IDBKeyRange.only(id))
    cursor.onsuccess = () => {
      if (cursor.result) {
        cursor.result.delete()
        cursor.result.continue()
      }
    }
    await done
  }
}
