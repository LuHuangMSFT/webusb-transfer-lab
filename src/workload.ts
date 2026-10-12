import type { Settings } from './types'

export const LIMITS = Object.freeze({
  maxFiles: 100,
  maxFileBytes: 1024 ** 3,
  maxRoundBytes: 1024 ** 3,
  maxPreparedBytes: 1024 ** 3,
  maxPreparedFiles: 20_000,
})

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  fileCount: 10,
  fileSizeBytes: 1024 ** 2,
  rounds: 3,
  pattern: 'round-trip',
  seed: 'webusb-lab',
  preGenerate: false,
  reuseAcrossRounds: false,
  tags: '',
  notes: '',
})

function positiveInteger(value: number, name: string, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`)
  }
}

function boundedText(value: string, name: string, maximum: number, required: boolean): void {
  if (typeof value !== 'string' || value.length > maximum || (required && !value.trim())) {
    throw new Error(`${name} must ${required ? 'be nonempty and ' : ''}contain at most ${maximum} characters.`)
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new Error(`${name} must not contain control characters.`)
  }
}

export function validateSettings(settings: Settings): Settings {
  if (!settings || typeof settings !== 'object') throw new Error('Workload settings are required.')
  positiveInteger(settings.fileCount, 'File count', LIMITS.maxFiles)
  positiveInteger(settings.fileSizeBytes, 'File size in bytes', LIMITS.maxFileBytes)
  positiveInteger(settings.rounds, 'Rounds')
  if (settings.fileCount * settings.fileSizeBytes > LIMITS.maxRoundBytes) {
    throw new Error('A round cannot exceed 1 GiB of unique file payload.')
  }
  const totalFiles = settings.fileCount * settings.rounds
  const totalTrafficBytes = totalFiles * settings.fileSizeBytes * 2
  if (!Number.isSafeInteger(totalFiles) || !Number.isSafeInteger(totalTrafficBytes)) {
    throw new Error('Aggregate file count and bidirectional traffic must be safe integers.')
  }
  for (const key of ['preGenerate', 'reuseAcrossRounds'] as const) {
    if (settings[key] !== undefined && typeof settings[key] !== 'boolean') {
      throw new Error(`${key} must be a boolean.`)
    }
  }
  if (settings.preGenerate && settings.fileCount * settings.fileSizeBytes *
      (settings.reuseAcrossRounds ? 1 : settings.rounds) > LIMITS.maxPreparedBytes) {
    throw new Error('Pre-generated payloads cannot exceed 1 GiB total. Reuse files across rounds or reduce the workload.')
  }
  if (settings.preGenerate && settings.fileCount * (settings.reuseAcrossRounds ? 1 : settings.rounds) > LIMITS.maxPreparedFiles) {
    throw new Error('Pre-generation cannot exceed 20,000 files. Reuse files across rounds or reduce the workload.')
  }
  if (settings.pattern !== 'round-trip' && settings.pattern !== 'batch') {
    throw new Error('Transfer pattern must be round-trip or batch.')
  }
  if (settings.architecture !== undefined && !['arm64', 'x64', 'other'].includes(settings.architecture)) {
    throw new Error('Architecture must be arm64, x64, or other.')
  }
  boundedText(settings.seed, 'Seed', 256, true)
  if (settings.tags !== undefined) boundedText(settings.tags, 'Tags', 512, false)
  if (settings.buildLabel !== undefined) boundedText(settings.buildLabel, 'Build label', 128, true)
  boundedText(settings.notes, 'Notes', 4096, false)
  return Object.freeze({
    fileCount: settings.fileCount,
    fileSizeBytes: settings.fileSizeBytes,
    rounds: settings.rounds,
    pattern: settings.pattern,
    seed: settings.seed,
    ...(settings.preGenerate === undefined ? {} : { preGenerate: settings.preGenerate }),
    ...(settings.reuseAcrossRounds === undefined ? {} : { reuseAcrossRounds: settings.reuseAcrossRounds }),
    ...(settings.tags === undefined ? {} : { tags: settings.tags }),
    ...(settings.buildLabel === undefined ? {} : { buildLabel: settings.buildLabel }),
    ...(settings.architecture === undefined ? {} : { architecture: settings.architecture }),
    notes: settings.notes,
  })
}

export function retainedPayloadBytes(settings: Settings): number {
  const validated = validateSettings(settings)
  return validated.preGenerate
    ? validated.fileCount * validated.fileSizeBytes * (validated.reuseAcrossRounds ? 1 : validated.rounds)
    : validated.reuseAcrossRounds ? validated.fileCount * validated.fileSizeBytes : 0
}

export function estimateWorkload(settings: Settings): {
  roundBytes: number
  totalTrafficBytes: number
  peakDeviceBytes: number
  totalFiles: number
} {
  const validated = validateSettings(settings)
  const roundBytes = validated.fileCount * validated.fileSizeBytes
  return {
    roundBytes,
    totalTrafficBytes: roundBytes * validated.rounds * 2,
    peakDeviceBytes: validated.pattern === 'batch' ? roundBytes : validated.fileSizeBytes,
    totalFiles: validated.fileCount * validated.rounds,
  }
}

// Versioned FNV-1a seeding and Mulberry32 output, stored little-endian.
// This is reproducible synthetic data, not a cryptographic random generator.
export function generatePayloadBytes(size: number, seed: string, index: number): Uint8Array<ArrayBuffer> {
  positiveInteger(size, 'Payload size', LIMITS.maxFileBytes)
  boundedText(seed, 'Seed', 256, true)
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('File index must be a nonnegative safe integer.')
  let state = 0x811c9dc5
  const encoder = new TextEncoder()
  const identity = encoder.encode(`webusb-transfer-lab:v1:${seed.length}:${seed}:`)
  for (const byte of identity) state = Math.imul(state ^ byte, 0x01000193) >>> 0
  const identityByte = (state ^ index) & 0xff
  for (const byte of encoder.encode(String(index))) state = Math.imul(state ^ byte, 0x01000193) >>> 0
  const bytes = new Uint8Array(size)
  for (let offset = 0; offset < size; offset += 4) {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    value = (value ^ (value >>> 14)) >>> 0
    for (let lane = 0; lane < 4 && offset + lane < size; lane++) {
      bytes[offset + lane] = (value >>> (lane * 8)) & 0xff
    }
  }
  // Keep all 100 workload file identities distinct even for one-byte files.
  bytes[0] = identityByte
  return bytes
}

export async function hashPayload(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
