const MAX_ENTRIES = 500
const errorNames = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'NotFoundError',
  'NetworkError', 'SecurityError', 'NotAllowedError', 'InvalidStateError',
  'TimeoutError', 'QuotaExceededError', 'DataCloneError', 'NotSupportedError',
  'OperationError', 'ConstraintError', 'UnknownError', 'TransactionInactiveError',
])
const errorCodes = new Set(['EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'EIO', 'EBUSY', 'ENODEV', 'EINVAL', 'EPIPE', 'ETIMEDOUT'])

export interface DiagnosticContext {
  operation?: string
  phase?: string
  status?: string
  runId?: string
  session?: number
  round?: number
  index?: number
  bytes?: number
  actualBytes?: number
  durationMs?: number
  timeoutMs?: number
  exitCode?: number
  pending?: number
  files?: number
  fileCount?: number
  rounds?: number
  maxPayloadSize?: number
  enabled?: boolean
  connected?: boolean
}

interface ErrorDetail {
  name: string
  reason: string
  code?: string | number
  sources: string[]
}

interface Entry {
  sequence: number
  timestamp: string
  elapsedMs: number
  level: 'debug' | 'info' | 'error'
  event: string
  action: string
  context: DiagnosticContext
  errors?: ErrorDetail[]
}

let enabled = false
let sequence = 0
let dropped = 0
let reported = new WeakSet<object>()
const entries: Entry[] = []

export function diagnosticsEnabled(): boolean { return enabled }

function safeContext(context: DiagnosticContext): DiagnosticContext {
  const result: DiagnosticContext = {}
  for (const key of ['operation', 'phase', 'status'] as const) {
    const value = context[key]
    if (typeof value === 'string' && /^[a-zA-Z0-9 .:()_-]{1,120}$/.test(value)) result[key] = value
  }
  if (typeof context.runId === 'string' && /^[a-f0-9-]{36}$/.test(context.runId)) result.runId = context.runId
  for (const key of ['session', 'round', 'index', 'bytes', 'actualBytes', 'durationMs', 'timeoutMs',
    'exitCode', 'pending', 'files', 'fileCount', 'rounds', 'maxPayloadSize'] as const) {
    const value = context[key]
    if (typeof value === 'number' && Number.isFinite(value)) result[key] = value
  }
  for (const key of ['enabled', 'connected'] as const) {
    if (typeof context[key] === 'boolean') result[key] = context[key]
  }
  return result
}

function describeError(error: Error): ErrorDetail {
  // Never emit arbitrary messages, object properties or raw stacks: libraries,
  // devices and imported reports can put private data in all three.
  const message = error.message.slice(0, 2048)
  const reason = /timed out|timeout/i.test(message) ? 'timeout'
    : /denied|permission|EACCES|EPERM/i.test(message) ? 'access-denied'
      : /space|quota|ENOSPC/i.test(message) ? 'storage-capacity'
        : /busy|claim|EBUSY/i.test(message) ? 'interface-busy-or-unavailable'
          : /disconnect|lost|ENODEV/i.test(message) ? 'disconnected'
            : /cancel|abort/i.test(message) ? 'canceled'
              : /SHA-256|mismatch|corrupt/i.test(message) ? 'integrity-mismatch'
                : /truncated|exceeded.*byte/i.test(message) ? 'transfer-length'
                  : /ownership|owned|symbolic|linked|identity/i.test(message) ? 'ownership-check'
                    : /storage|IndexedDB|persist/i.test(message) ? 'local-storage'
                      : 'message-redacted'
  const code = errorCodes.has(message) ? message
    : typeof DOMException !== 'undefined' && error instanceof DOMException ? error.code : undefined
  const sources = (error.stack ?? '').slice(0, 16_384).split('\n').slice(1, 12).flatMap((line) => {
    const match = line.match(/\/(?:webusb-transfer-lab\/)?(?:assets\/(?:index|payload\.worker)-[\w-]+\.js|src\/(?:adb-client|runner|payload|main|results|workload|diagnostics)\.ts):\d+:\d+/)
    return match ? [match[0]] : []
  }).slice(0, 4)
  return { name: errorNames.has(error.name) ? error.name : 'Error', reason, ...(code === undefined ? {} : { code }), sources }
}

function emit(level: Entry['level'], event: string, action: string, context: DiagnosticContext, errors?: ErrorDetail[]): void {
  const entry: Entry = {
    sequence: ++sequence, timestamp: new Date().toISOString(), elapsedMs: performance.now(),
    level, event, action, context: safeContext(context), ...(errors ? { errors } : {}),
  }
  if (entries.length === MAX_ENTRIES) { entries.shift(); dropped++ }
  entries.push(entry)
  // A string snapshot cannot expose subsequently mutated objects in DevTools.
  console[level](`[WebUSB Lab] ${JSON.stringify(entry)}`)
}

export function setDiagnosticsEnabled(value: boolean): void {
  if (value === enabled) return
  enabled = value
  emit('info', 'diagnostics.mode', value
    ? 'Diagnostic tracing enabled. Do not use this run for performance comparisons.'
    : 'Diagnostic tracing disabled. Errors remain available.', { enabled })
}

export function trace(event: string, context: DiagnosticContext = {}): void {
  if (enabled) emit('debug', event, '', context)
}

export function diagnosticError(event: string, action: string, error: unknown, context: DiagnosticContext = {}): void {
  if (typeof error === 'object' && error !== null && reported.has(error)) return
  const errors: ErrorDetail[] = []
  const seen = new Set<unknown>()
  let cause = error
  for (let depth = 0; depth < 4 && !seen.has(cause); depth++) {
    seen.add(cause)
    if (!(cause instanceof Error)) break
    if (reported.has(cause)) return
    reported.add(cause)
    errors.push(describeError(cause))
    cause = cause.cause
    if (cause === undefined) break
  }
  emit('error', event, action, context, errors.length ? errors : [{ name: 'Unknown', reason: 'thrown-value-redacted', sources: [] }])
}

export function diagnosticSnapshot() {
  return {
    schemaVersion: 1, enabled, timeOrigin: performance.timeOrigin, dropped,
    entries: structuredClone(entries),
  }
}

export function clearDiagnostics(): void {
  entries.length = 0
  dropped = 0
  reported = new WeakSet()
}
