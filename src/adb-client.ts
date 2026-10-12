import { Adb, AdbDaemonTransport, LinuxFileType } from '@yume-chan/adb'
import type { AdbCredentialStore, AdbPrivateKey, AdbSync, AdbSyncStat } from '@yume-chan/adb'
import { AdbDaemonWebUsbDeviceManager } from '@yume-chan/adb-daemon-webusb'
import { ReadableStream } from '@yume-chan/stream-extra'
import type { DeviceInfo, DeviceStorage } from './types'

const ROOT = '/data/local/tmp'
const PREFIX = `${ROOT}/webusb-transfer-lab-`
const STORAGE_KEY = 'webusb-transfer-lab.cleanup.v1'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const FILE = /^r([0-9]{6,16})-f([0-9]{3})\.bin$/
const MAX_FILE = 16 * 1024 * 1024
const HEADROOM = 64 * 1024 * 1024
const IO_TIMEOUT = 120_000
const SHELL_TIMEOUT = 15_000
const CLOSE_TIMEOUT = 10_000

interface DirectoryIdentity {
  dev: string
  ino: string
}

interface Ownership {
  runId: string
  directoryId: string
  deviceId: string
  deviceName: string
  directory: DirectoryIdentity | null
  files: string[]
}

interface Session {
  active: boolean
  cancellation: AbortController
  usb?: USBDevice
  adb?: Adb
  sync?: AdbSync
  deviceId?: string
}

function validName(name: string): boolean {
  if (name === 'probe.bin') return true
  const match = FILE.exec(name)
  if (!match || match[0] !== name) return false
  const round = Number(match[1])
  const index = Number(match[2])
  return Number.isSafeInteger(round) && round > 0
    && match[1] === String(round).padStart(6, '0') && index >= 1 && index <= 100
}

function requireUuid(value: string): void {
  if (typeof value !== 'string' || value.length !== 36 || !UUID.test(value)) throw new Error('Invalid generated run ID.')
}

function requireName(value: string): void {
  if (typeof value !== 'string' || !validName(value)) throw new Error('Invalid generated filename.')
}

function requireSize(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_FILE) {
    throw new Error('File size must be between 1 byte and 16 MiB.')
  }
}

function displayName(value: string | null | undefined): string {
  return (value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120) || 'Android device'
}

function dictionary(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function decimal(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && /^(0|[1-9][0-9]{0,19})$/.test(value)
}

function validRecord(value: unknown): value is Ownership {
  if (!dictionary(value) || Object.keys(value).sort().join(',') !==
    'deviceId,deviceName,directory,directoryId,files,runId') return false
  if (typeof value.runId !== 'string' || value.runId.length !== 36 || !UUID.test(value.runId)
    || typeof value.directoryId !== 'string' || value.directoryId.length !== 36 || !UUID.test(value.directoryId)
    || typeof value.deviceId !== 'string' || value.deviceId.length !== 64 || !/^[0-9a-f]{64}$/.test(value.deviceId)
    || typeof value.deviceName !== 'string' || !value.deviceName
    || value.deviceName !== displayName(value.deviceName)
    || !Array.isArray(value.files) || value.files.length > 100
    || !value.files.every((name: unknown) => typeof name === 'string' && validName(name))
    || new Set(value.files).size !== value.files.length) return false
  return value.directory === null ? value.files.length === 0 :
    dictionary(value.directory)
      && Object.keys(value.directory).sort().join(',') === 'dev,ino'
      && decimal(value.directory.dev) && decimal(value.directory.ino)
      && value.directory.ino !== '0'
}

/** Only accepts the unambiguous POSIX, 1024-byte-block output requested below. */
export function parseAvailableBytes(output: string): number {
  const lines = output.trim().split(/\r?\n/)
  if (lines.length !== 2 || !/^Filesystem\s+(?:1024-blocks|1K-blocks)\s+Used\s+Available\s+(?:Capacity|Use%)\s+Mounted on$/.test(lines[0]!.trim())) {
    throw new Error('Cannot reliably determine available phone storage.')
  }
  const fields = lines[1]!.trim().split(/\s+/)
  const [filesystem, total, used, available, percent, mount] = fields
  if (fields.length !== 6 || !filesystem || !decimal(total) || !decimal(used)
    || !decimal(available) || !percent || !/^(?:[0-9]|[1-9][0-9]|100)%$/.test(percent)
    || !mount?.startsWith('/') || BigInt(total) === 0n
    || BigInt(used) + BigInt(available) > BigInt(total)
    || BigInt(available) * 1024n > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Cannot reliably determine available phone storage.')
  }
  return Number(BigInt(available) * 1024n)
}

class SessionCredentials implements AdbCredentialStore {
  #key?: Promise<AdbPrivateKey>

  generateKey(): Promise<AdbPrivateKey> {
    this.#key ??= (async () => {
      const pair = await crypto.subtle.generateKey({
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      }, true, ['sign', 'verify'])
      // The stable library requires PKCS#8 bytes, not a CryptoKey. This conversion
      // stays in memory; neither the key nor these bytes enter storage or reports.
      return {
        buffer: new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
        name: 'webusb-transfer-lab',
      }
    })()
    return this.#key
  }

  async *iterateKeys(): AsyncGenerator<AdbPrivateKey> {
    if (this.#key) yield await this.#key
  }
}

export class AdbClient implements DeviceStorage {
  #session?: Session
  #credentials = new SessionCredentials()
  #busy = false
  #pending = new Set<Promise<unknown>>()
  #closing?: Promise<void>
  #lastError?: string
  #onDisconnect?: () => void
  #info: DeviceInfo = { model: 'Not connected', manufacturer: '', features: [], maxPayloadSize: 0 }

  constructor(onDisconnect?: () => void) {
    this.#onDisconnect = onDisconnect
  }

  get info(): DeviceInfo {
    return { ...this.#info, features: [...this.#info.features] }
  }

  get connected(): boolean {
    return !!(this.#session?.active && this.#session.sync)
  }

  get lastError(): string | undefined {
    return this.#lastError
  }

  async connect(): Promise<void> {
    if (this.#session || this.#busy || this.#closing || this.#pending.size) {
      throw new Error('A connection or USB operation is still active. Wait for it to stop before reconnecting.')
    }
    if (!globalThis.isSecureContext || !globalThis.navigator?.usb) {
      throw new Error('WebUSB requires HTTPS and a compatible Chromium browser.')
    }
    const session: Session = { active: true, cancellation: new AbortController() }
    this.#session = session
    this.#lastError = undefined
    let phase: 'selection' | 'interface' | 'authorization' | 'sync' = 'selection'
    try {
      const manager = new AdbDaemonWebUsbDeviceManager(navigator.usb)
      // Invoke the chooser before the first await, retaining the button's activation.
      const choice = manager.requestDevice()
      const device = await this.#wait(session, 'Device selection canceled or timed out', () => choice, 120_000)
      this.#assert(session)
      if (!device) throw new Error('Device selection canceled. Select an Android ADB interface to connect.')
      phase = 'interface'
      session.usb = device.raw
      const serial = device.raw.serialNumber
      if (!serial || serial.length > 256) {
        throw new Error('The device has no reliable USB identity; safe reconnection cleanup is unavailable.')
      }
      const identity = JSON.stringify([device.raw.vendorId, device.raw.productId, serial])
      const digest = await this.#wait(session, 'Device identity', () =>
        crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity)), SHELL_TIMEOUT)
      session.deviceId = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
      const connection = await this.#wait(session, 'USB interface open (check driver or another ADB client)', async () => {
        const result = await device.connect()
        if (!session.active) {
          await device.raw.close()
          throw new Error('USB connection was canceled.')
        }
        return result
      }, SHELL_TIMEOUT)
      phase = 'authorization'
      const transport = await this.#wait(session, 'Phone authorization (unlock the phone and approve USB debugging)', async () => {
        const result = await AdbDaemonTransport.authenticate({
          serial: device.serial,
          connection,
          credentialStore: this.#credentials,
          initialDelayedAckBytes: 0,
          preserveConnection: false,
          readTimeLimit: IO_TIMEOUT,
        })
        if (!session.active) {
          await result.close()
          throw new Error('Phone authorization was canceled.')
        }
        return result
      }, 120_000)
      this.#assert(session)
      const adb = new Adb(transport)
      session.adb = adb
      void adb.disconnected.then(
        () => this.#invalidate(session, new Error('The phone disconnected. Reconnect to clean up leftover test files.')),
        () => this.#invalidate(session, new Error('The USB connection failed. Reconnect to clean up leftover test files.')),
      )
      if (!adb.subprocess.shellProtocol?.isSupported) {
        throw new Error('This phone requires ADB shell_v2 support for reliable storage checks.')
      }
      phase = 'sync'
      session.sync = await this.#wait(session, 'ADB SYNC connection', async () => {
        const sync = await adb.sync()
        if (!session.active) {
          await sync.dispose()
          throw new Error('ADB SYNC connection was canceled.')
        }
        return sync
      }, SHELL_TIMEOUT)
      if (!session.sync.supportsStat) {
        throw new Error('This phone requires ADB stat_v2 support for safe file ownership checks.')
      }
      this.#info = {
        model: displayName(adb.banner.model ?? device.raw.productName),
        manufacturer: displayName(device.raw.manufacturerName),
        features: adb.deviceFeatures.filter((feature) => adb.clientFeatures.includes(feature)),
        maxPayloadSize: adb.maxPayloadSize,
      }
    } catch (error) {
      const messages = {
        selection: 'USB device selection failed or permission was denied. Select an Android ADB interface.',
        interface: 'The USB ADB interface is busy or unavailable. Close competing ADB clients and check the WinUSB/OEM driver.',
        authorization: 'Android ADB authorization failed. Unlock the phone and approve this browser’s USB debugging request.',
        sync: 'The phone could not open an ADB SYNC session. Reconnect and check USB debugging.',
      }
      const failure = session.cancellation.signal.aborted
        ? session.cancellation.signal.reason as Error
        : new Error(error instanceof Error && /^(This phone|The device has no|Device selection canceled)/.test(error.message)
            ? error.message
            : messages[phase])
      this.#invalidate(session, failure)
      throw failure
    }
  }

  abort(): void {
    if (this.#session) this.#invalidate(this.#session, new Error('Transfer canceled; the USB connection is no longer reusable. Reconnect for cleanup.'))
  }

  async disconnect(): Promise<void> {
    const session = this.#session
    if (session) this.#invalidate(session, new Error('Disconnected. Reconnect to clean up any leftover test files.'))
    const closing = this.#closing
    if (closing) await closing
    if (this.#pending.size) throw new Error('USB teardown is still pending. Unplug the phone before reconnecting.')
    if (this.#lastError?.startsWith('USB teardown')) throw new Error(this.#lastError)
  }

  getLeftovers(): Array<{ runId: string; deviceName: string }> {
    return this.#load().map(({ runId, deviceName }) => ({ runId, deviceName }))
  }

  async cleanupLeftovers(): Promise<void> {
    await this.#operate(async (session) => {
      const records = this.#load()
      const matching = records.filter((record) => record.deviceId === session.deviceId)
      if (records.length && !matching.length) {
        throw new Error('Leftovers belong to a different phone. Connect that same phone; no files were removed.')
      }
      for (const record of matching) await this.#cleanup(session, record)
    })
  }

  async createRun(runId: string): Promise<void> {
    requireUuid(runId)
    await this.#operate(async (session) => {
      if (this.#load().some((record) => record.runId === runId)) throw new Error('This run already has cleanup ownership.')
      await this.#parents(session)
      const record: Ownership = {
        runId, directoryId: crypto.randomUUID(), deviceId: session.deviceId!,
        deviceName: this.#info.model, directory: null, files: [],
      }
      const path = this.#directoryPath(record)
      if (await this.#lstat(session, path)) throw new Error('The generated directory already exists; refusing to reuse it.')
      // A write-ahead reservation survives losing the mkdir reply. Without an inode
      // confirmation it is reported, but never automatically treated as owned.
      this.#save(record)
      await this.#shell(session, ['mkdir', '-m', '700', path], 'Create test directory')
      const stat = await this.#lstat(session, path)
      if (!stat || stat.type !== LinuxFileType.Directory || stat.permission !== 0o700) {
        throw new Error('The generated directory is not a private regular directory.')
      }
      record.directory = this.#identity(stat)
      this.#save(record)
      await this.#space(session, 4096)
      const probe = crypto.getRandomValues(new Uint8Array(4096))
      await this.#write(session, record, 'probe.bin', probe)
      const returned = await this.#read(session, record, 'probe.bin', probe.byteLength)
      if (returned.some((byte, index) => byte !== probe[index])) throw new Error('Phone storage capability probe returned corrupted data.')
      await this.#remove(session, record, 'probe.bin')
    })
  }

  async checkSpace(peakBytes: number): Promise<void> {
    if (!Number.isSafeInteger(peakBytes) || peakBytes < 1 || peakBytes > 1024 * 1024 * 1024) {
      throw new Error('Invalid peak storage requirement.')
    }
    await this.#operate((session) => this.#space(session, peakBytes))
  }

  async writeFile(runId: string, name: string, data: Uint8Array<ArrayBuffer>): Promise<void> {
    requireName(name)
    if (!(data instanceof Uint8Array)) throw new Error('Expected a binary file payload.')
    requireSize(data.byteLength)
    await this.#operate((session) => this.#write(session, this.#owned(session, runId), name, data))
  }

  async readFile(runId: string, name: string, expectedBytes: number): Promise<Uint8Array<ArrayBuffer>> {
    requireName(name)
    requireSize(expectedBytes)
    return this.#operate((session) => this.#read(session, this.#owned(session, runId), name, expectedBytes))
  }

  async statFile(runId: string, name: string): Promise<number> {
    requireName(name)
    return this.#operate(async (session) => {
      const record = this.#owned(session, runId)
      await this.#directory(session, record)
      return this.#size(await this.#file(session, record, name))
    })
  }

  async removeFile(runId: string, name: string): Promise<void> {
    requireName(name)
    await this.#operate((session) => this.#remove(session, this.#owned(session, runId), name))
  }

  async cleanupRun(runId: string): Promise<void> {
    requireUuid(runId)
    await this.#operate(async (session) => {
      const record = this.#load().find((item) => item.runId === runId)
      if (record) await this.#cleanup(session, record)
    })
  }

  async #operate<T>(operation: (session: Session) => Promise<T>): Promise<T> {
    if (this.#busy) throw new Error('Concurrent storage operations are not permitted.')
    const session = this.#session
    if (!session?.active || !session.sync) throw new Error('The phone is disconnected. Reconnect before accessing test storage.')
    this.#busy = true
    try {
      const value = await operation(session)
      this.#assert(session)
      return value
    } finally {
      this.#busy = false
    }
  }

  #assert(session: Session): void {
    if (!session.active || session !== this.#session) {
      throw session.cancellation.signal.reason ?? new Error('The USB session is no longer active.')
    }
  }

  async #wait<T>(session: Session, label: string, operation: () => PromiseLike<T>, timeout = IO_TIMEOUT): Promise<T> {
    this.#assert(session)
    let timer: ReturnType<typeof setTimeout> | undefined
    let canceled: (() => void) | undefined
    const stopped = new Promise<never>((_, reject) => {
      canceled = () => reject(session.cancellation.signal.reason)
      session.cancellation.signal.addEventListener('abort', canceled, { once: true })
      timer = setTimeout(() => this.#invalidate(session,
        new Error(`${label} timed out. USB was invalidated; reconnect before retrying.`)), timeout)
    })
    const work = Promise.resolve().then(() => {
      this.#assert(session)
      return operation()
    })
    this.#pending.add(work)
    void work.then(() => this.#pending.delete(work), () => this.#pending.delete(work))
    try {
      const value = await Promise.race([work, stopped])
      this.#assert(session)
      return value
    } finally {
      clearTimeout(timer)
      if (canceled) session.cancellation.signal.removeEventListener('abort', canceled)
    }
  }

  #invalidate(session: Session, reason: Error): void {
    if (!session.active) return
    session.active = false
    this.#lastError = reason.message
    session.cancellation.abort(reason)
    if (this.#session === session) this.#session = undefined
    // SYNC read cancellation drains rather than aborts. Close the actual USB
    // device immediately, including during authentication, to stop pending I/O.
    const close = async (operation: () => PromiseLike<unknown> | unknown): Promise<void> => {
      try { await operation() } catch {
        this.#lastError = 'USB teardown reported an error. Unplug the phone before reconnecting.'
      }
    }
    const tasks = Promise.all([
      close(() => session.usb?.close()),
      close(() => session.sync?.dispose()),
      close(() => session.adb?.close()),
    ])
    this.#pending.add(tasks)
    void tasks.then(() => this.#pending.delete(tasks), () => this.#pending.delete(tasks))
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.#lastError = 'USB teardown timed out. Unplug the phone before reconnecting.'
        resolve()
      }, CLOSE_TIMEOUT)
    })
    const closing = Promise.race([tasks, timeout]).then(() => { clearTimeout(timer) })
    this.#closing = closing
    void closing.then(() => {
      if (this.#closing === closing) this.#closing = undefined
    })
    try { this.#onDisconnect?.() } catch {
      this.#lastError = 'The disconnect notification failed; the USB session has still been invalidated.'
    }
  }

  #load(): Ownership[] {
    let text: string | null
    try { text = localStorage.getItem(STORAGE_KEY) } catch {
      throw new Error('Local cleanup ownership storage is unavailable. No test files will be written.')
    }
    if (text === null) return []
    try {
      if (text.length > 1024 * 1024) throw new Error()
      const value: unknown = JSON.parse(text)
      if (!Array.isArray(value) || value.length > 100 || !value.every(validRecord)
        || new Set(value.map((record) => record.runId)).size !== value.length
        || new Set(value.map((record) => record.directoryId)).size !== value.length) throw new Error()
      return value
    } catch {
      throw new Error('Saved cleanup ownership is malformed. Refusing to use or overwrite unsafe records.')
    }
  }

  #save(record: Ownership, remove = false): void {
    const current = this.#load()
    const existing = current.find((item) => item.runId === record.runId)
    if (existing && (existing.deviceId !== record.deviceId || existing.directoryId !== record.directoryId)) {
      throw new Error('Cleanup ownership changed in another session. Refusing to overwrite it.')
    }
    const records = current.filter((item) => item.runId !== record.runId)
    if (!remove) records.push(record)
    if (records.length > 100 || !records.every(validRecord)
      || new Set(records.map((item) => item.directoryId)).size !== records.length) {
      throw new Error('Cleanup ownership limit exceeded or invalid ownership.')
    }
    const text = JSON.stringify(records)
    try {
      localStorage.setItem(STORAGE_KEY, text)
      if (localStorage.getItem(STORAGE_KEY) !== text) throw new Error()
    } catch {
      throw new Error('Could not persist cleanup ownership. No further test files will be written.')
    }
  }

  #owned(session: Session, runId: string): Ownership {
    requireUuid(runId)
    const record = this.#load().find((item) => item.runId === runId)
    if (!record || record.deviceId !== session.deviceId || !record.directory) {
      throw new Error('This run is not confirmed as owned on the connected phone.')
    }
    return record
  }

  #directoryPath(record: Ownership): string {
    requireUuid(record.directoryId)
    return PREFIX + record.directoryId
  }

  #filePath(record: Ownership, name: string): string {
    requireName(name)
    return `${this.#directoryPath(record)}/${name}`
  }

  #identity(stat: AdbSyncStat): DirectoryIdentity {
    if (!('dev' in stat) || typeof stat.dev !== 'bigint'
      || !('ino' in stat) || typeof stat.ino !== 'bigint' || stat.ino <= 0n) {
      throw new Error('The phone did not provide reliable file identity.')
    }
    return { dev: stat.dev.toString(), ino: stat.ino.toString() }
  }

  async #lstat(session: Session, path: string): Promise<AdbSyncStat | undefined> {
    try {
      return await this.#wait(session, 'File metadata', () => session.sync!.lstat(path), SHELL_TIMEOUT)
    } catch (error) {
      this.#assert(session)
      if (error instanceof Error && error.message === 'ENOENT') return undefined
      throw new Error('Cannot inspect test storage: permission denied or ADB metadata failure.')
    }
  }

  async #parents(session: Session): Promise<void> {
    for (const path of ['/data', '/data/local', ROOT]) {
      const stat = await this.#lstat(session, path)
      if (!stat || stat.type !== LinuxFileType.Directory) {
        throw new Error('Test storage is missing, inaccessible, or a symbolic link. No alternate storage will be used.')
      }
    }
  }

  async #directory(session: Session, record: Ownership): Promise<boolean> {
    if (record.deviceId !== session.deviceId) throw new Error('Cleanup requires the same phone that owns this run.')
    await this.#parents(session)
    const stat = await this.#lstat(session, this.#directoryPath(record))
    if (!stat) return false
    if (!record.directory || stat.type !== LinuxFileType.Directory || stat.permission !== 0o700) {
      throw new Error('Test directory ownership is unconfirmed, changed, or a symbolic link. Refusing access.')
    }
    const identity = this.#identity(stat)
    if (identity.dev !== record.directory.dev || identity.ino !== record.directory.ino) {
      throw new Error('Test directory identity changed. Refusing access.')
    }
    return true
  }

  async #file(session: Session, record: Ownership, name: string): Promise<AdbSyncStat> {
    if (!record.files.includes(name)) throw new Error('The file is not tracked as owned by this run.')
    const stat = await this.#lstat(session, this.#filePath(record, name))
    if (!stat || stat.type !== LinuxFileType.File
      || ('nlink' in stat && stat.nlink !== 1)) {
      throw new Error('Test file is missing, linked, or not a regular file.')
    }
    return stat
  }

  #size(stat: AdbSyncStat): number {
    if (stat.size < 0n || stat.size > BigInt(MAX_FILE)) throw new Error('Phone file exceeds the 16 MiB limit.')
    return Number(stat.size)
  }

  async #space(session: Session, peakBytes: number): Promise<void> {
    await this.#parents(session)
    const result = await this.#shell(session, ['df', '-kP', ROOT], 'Phone storage check')
    if (parseAvailableBytes(result) < peakBytes + HEADROOM) {
      throw new Error('Insufficient phone storage: the workload plus 64 MiB headroom is required.')
    }
  }

  async #shell(session: Session, command: string[], label: string): Promise<string> {
    return this.#wait(session, label, async () => {
      const process = await session.adb!.subprocess.shellProtocol!.spawn(command).catch(() => {
        const failure = new Error(`${label} failed: ADB shell connection was lost.`)
        this.#invalidate(session, failure)
        throw failure
      })
      // Observe exit even when cancellation wins while spawn is still pending.
      void process.exited.catch(() => {
        if (session.active) this.#lastError = `${label} did not exit successfully.`
      })
      const collect = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
        const reader = stream.getReader()
        const buffer = new Uint8Array(64 * 1024)
        let length = 0
        try {
          while (true) {
            this.#assert(session)
            const { done, value } = await reader.read()
            this.#assert(session)
            if (done) return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))
            if (value.byteLength > buffer.length - length) throw new Error('Unexpectedly large shell response.')
            buffer.set(value, length)
            length += value.byteLength
          }
        } finally {
          reader.releaseLock()
        }
      }
      try {
        this.#assert(session)
        const [stdout, stderr, status] = await Promise.all([
          collect(process.stdout), collect(process.stderr), process.exited,
        ])
        this.#assert(session)
        if (status !== 0 || stderr.trim()) throw new Error(`${label} failed: storage permission, access, or device command failure.`)
        return stdout
      } catch (error) {
        // A failed or oversized shell stream must not leave ADB backpressured.
        const failure = error instanceof Error
          && (error.message === 'Unexpectedly large shell response.' || error.message.startsWith(`${label} failed:`))
          ? error : new Error(`${label} failed: ADB shell I/O error.`)
        this.#invalidate(session, failure)
        throw failure
      } finally {
        try { await process.kill() } catch {
          const failure = new Error(`${label} failed: ADB shell did not close cleanly.`)
          this.#invalidate(session, failure)
          throw failure
        }
      }
    }, SHELL_TIMEOUT)
  }

  async #write(session: Session, record: Ownership, name: string, data: Uint8Array<ArrayBuffer>): Promise<void> {
    if (!await this.#directory(session, record)) throw new Error('The owned test directory is missing.')
    const path = this.#filePath(record, name)
    if (record.files.includes(name) || await this.#lstat(session, path)) {
      throw new Error('The generated file already exists; refusing to overwrite it or follow a link.')
    }
    record.files.push(name)
    this.#save(record)
    const file = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data)
        controller.close()
      },
    })
    try {
      // Stable SYNC v2 defaults to no compression; do not use dry-run or retry.
      await this.#wait(session, 'File upload', () => session.sync!.write({
        filename: path, file, type: LinuxFileType.File, permission: 0o600, dryRun: false,
      }))
    } catch (error) {
      this.#invalidate(session, new Error('Phone file upload failed; reconnect for scoped cleanup.'))
      throw error instanceof Error && session.cancellation.signal.reason !== error
        ? new Error('Phone file upload failed; reconnect for scoped cleanup.') : error
    }
    const actual = this.#size(await this.#file(session, record, name))
    if (actual !== data.byteLength) throw new Error('Phone file size does not match the uploaded byte count.')
  }

  async #read(session: Session, record: Ownership, name: string, expected: number): Promise<Uint8Array<ArrayBuffer>> {
    if (!await this.#directory(session, record)) throw new Error('The owned test directory is missing.')
    if (this.#size(await this.#file(session, record, name)) !== expected) {
      throw new Error('Phone file size does not match the expected byte count.')
    }
    const buffer = new Uint8Array(expected)
    return this.#wait(session, 'File download', async () => {
      const reader = session.sync!.read(this.#filePath(record, name)).getReader()
      let offset = 0
      try {
        while (true) {
          this.#assert(session)
          const { done, value } = await reader.read()
          this.#assert(session)
          if (done) {
            if (offset !== expected) throw new Error('Phone file download was truncated.')
            return buffer
          }
          if (value.byteLength > expected - offset) throw new Error('Phone file download exceeded the expected byte count.')
          buffer.set(value, offset)
          offset += value.byteLength
        }
      } catch (error) {
        const failure = error instanceof Error && /download (was truncated|exceeded)/.test(error.message)
          ? error : new Error('Phone file download failed; reconnect for scoped cleanup.')
        this.#invalidate(session, failure)
        throw failure
      } finally {
        // Never call cancel(): this library drains the remainder of a SYNC pull.
        reader.releaseLock()
      }
    })
  }

  async #remove(session: Session, record: Ownership, name: string): Promise<void> {
    if (!record.files.includes(name)) throw new Error('Refusing to remove a file not tracked by this run.')
    if (await this.#directory(session, record)) {
      const path = this.#filePath(record, name)
      const stat = await this.#lstat(session, path)
      if (stat) {
        await this.#file(session, record, name)
        await this.#shell(session, ['rm', path], 'Remove owned test file')
        if (await this.#lstat(session, path)) throw new Error('Owned test file was not removed.')
      }
    }
    record.files = record.files.filter((item) => item !== name)
    this.#save(record)
  }

  async #cleanup(session: Session, record: Ownership): Promise<void> {
    if (!await this.#directory(session, record)) {
      this.#save(record, true)
      return
    }
    for (const name of [...record.files]) await this.#remove(session, record, name)
    if (await this.#directory(session, record)) {
      await this.#shell(session, ['rmdir', this.#directoryPath(record)], 'Remove empty owned test directory')
      if (await this.#lstat(session, this.#directoryPath(record))) throw new Error('Owned test directory was not removed.')
    }
    this.#save(record, true)
  }
}
