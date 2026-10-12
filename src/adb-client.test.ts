import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReadableStream } from '@yume-chan/stream-extra'
import type { AdbCredentialStore, AdbPrivateKey } from '@yume-chan/adb'
import { AdbClient, parseAvailableBytes } from './adb-client'
import { clearDiagnostics, diagnosticSnapshot, setDiagnosticsEnabled } from './diagnostics'
import { hashPayload } from './workload'

// These are protocol-boundary mocks, not real USB or phone verification.
const boundary = vi.hoisted(() => ({
  manager: vi.fn(),
  requestDevice: vi.fn(),
  authenticate: vi.fn(),
  constructAdb: vi.fn(),
  adb: {} as Record<string, unknown>,
}))
vi.mock('@yume-chan/adb-daemon-webusb', () => ({
  AdbDaemonWebUsbDeviceManager: class {
    constructor(usb: unknown) { boundary.manager(usb) }
    requestDevice() { return boundary.requestDevice() }
  },
}))
vi.mock('@yume-chan/adb', () => ({
  ADB_SYNC_MAX_PACKET_SIZE: 64 * 1024,
  LinuxFileType: { Directory: 4, File: 8, Link: 10 },
  AdbDaemonTransport: { authenticate: boundary.authenticate },
  Adb: class {
    constructor(transport: unknown) {
      boundary.constructAdb(transport)
      Object.assign(this, boundary.adb)
    }
  },
}))

const RUN = '11111111-1111-4111-8111-111111111111'
const DIRECTORY = '22222222-2222-4222-8222-222222222222'
const ROOT = '/data/local/tmp'
const PATH = `${ROOT}/webusb-transfer-lab-${DIRECTORY}`
const NAME = 'r000001-f001.bin'
const KEY = 'webusb-transfer-lab.cleanup.v1'
const DF = 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/block/dm-1 2097152 1048576 1048576 50% /data\n'

interface Entry {
  type: number
  permission: number
  size: bigint
  dev: bigint
  ino: bigint
  nlink: number
  data?: Uint8Array<ArrayBuffer>
}

interface Saved {
  runId: string
  directoryId: string
  deviceId: string
  deviceName: string
  directory: { dev: string; ino: string } | null
  files: string[]
}

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes); controller.close() },
  })
}

function makeFixture() {
  let inode = 1n
  const entries = new Map<string, Entry>()
  const memory = new Map<string, string>()
  const storage = {
    getItem: vi.fn((key: string) => memory.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { memory.set(key, value) }),
  }
  const entry = (type: number, data?: Uint8Array<ArrayBuffer>): Entry => ({
    type, data, size: BigInt(data?.length ?? 0),
    permission: type === 4 ? 0o700 : 0o600, dev: 12n, ino: inode++, nlink: 1,
  })
  for (const parent of ['/data', '/data/local', ROOT]) entries.set(parent, entry(4))
  const fixture = {
    entries, memory, storage, entry,
    df: DF,
    onClose: undefined as (() => void) | undefined,
    failShell: false,
    commands: [] as string[][],
    usb: {
      vendorId: 1234, productId: 5678, serialNumber: 'private-device-serial',
      productName: 'USB phone', manufacturerName: 'Test manufacturer',
      close: vi.fn(async () => { fixture.onClose?.() }),
    },
    sync: {
      supportsStat: true,
      dispose: vi.fn(async () => {}),
      lstat: vi.fn(async (path: string) => {
        const value = entries.get(path)
        if (!value) throw new Error('ENOENT')
        return { ...value }
      }),
      read: vi.fn((path: string) => stream(entries.get(path)!.data!.slice())),
      write: vi.fn(async (options: {
        filename: string
        file: ReadableStream<Uint8Array>
        dryRun: boolean
        type: number
        permission: number
      }) => {
        const records = JSON.parse(memory.get(KEY)!) as Saved[]
        expect(records.some((record) => record.files.includes(options.filename.split('/').at(-1)!))).toBe(true)
        const chunks: Uint8Array[] = []
        let length = 0
        for await (const chunk of options.file) {
          chunks.push(chunk.slice())
          length += chunk.byteLength
        }
        const bytes = new Uint8Array(length)
        let offset = 0
        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.byteLength
        }
        entries.set(options.filename, entry(8, bytes))
      }),
    },
    spawn: vi.fn(async (command: string[]) => {
      fixture.commands.push(command)
      let output = ''
      let status = 0
      const path = command.at(-1)!
      if (fixture.failShell) {
        status = 1
      } else if (command[0] === 'df') {
        output = fixture.df
      } else if (command[0] === 'mkdir') {
        if (entries.has(path)) status = 1
        else entries.set(path, entry(4))
      } else if (command[0] === 'rm') {
        if (!entries.delete(path)) status = 1
      } else if (command[0] === 'rmdir') {
        if ([...entries.keys()].some((name) => name.startsWith(`${path}/`))) status = 1
        else if (!entries.delete(path)) status = 1
      } else throw new Error('Unexpected command in test')
      return {
        stdout: stream(new TextEncoder().encode(output)),
        stderr: stream(new Uint8Array()),
        exited: Promise.resolve(status),
        kill: vi.fn(async () => {}),
      }
    }),
  }
  const connection = { testConnection: true }
  boundary.requestDevice.mockResolvedValue({
    raw: fixture.usb, serial: fixture.usb.serialNumber,
    connect: vi.fn(async () => connection),
  })
  boundary.authenticate.mockResolvedValue({ testTransport: true, close: vi.fn(async () => {}) })
  boundary.adb = {
    sync: vi.fn(async () => fixture.sync),
    close: vi.fn(async () => {}),
    disconnected: new Promise<void>(() => {}),
    banner: { model: 'Test phone' },
    clientFeatures: ['shell_v2', 'stat_v2'],
    deviceFeatures: ['shell_v2', 'stat_v2', 'unnegotiated'],
    maxPayloadSize: 1024 * 1024,
    subprocess: { shellProtocol: { isSupported: true, spawn: fixture.spawn } },
  }
  return fixture
}

let fixture: ReturnType<typeof makeFixture>
let client: AdbClient
let disconnected: ReturnType<typeof vi.fn<() => void>>

beforeEach(() => {
  setDiagnosticsEnabled(false)
  clearDiagnostics()
  vi.clearAllMocks()
  fixture = makeFixture()
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('navigator', { usb: {} })
  vi.stubGlobal('localStorage', fixture.storage)
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(DIRECTORY)
  disconnected = vi.fn()
  client = new AdbClient(disconnected)
})

afterEach(async () => {
  client.abort()
  try { await client.disconnect() } catch { /* intentional teardown-failure tests */ }
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function createRun(): Promise<void> {
  await client.connect()
  await client.createRun(RUN)
}

function saved(): Saved[] {
  return JSON.parse(fixture.memory.get(KEY)!) as Saved[]
}

describe('strict remote df parser', () => {
  it('parses real POSIX 1024-byte blocks and the Android 1K-block header', () => {
    expect(parseAvailableBytes(DF)).toBe(1024 * 1024 * 1024)
    expect(parseAvailableBytes(DF.replace('1024-blocks', '1K-blocks').replace('Capacity', 'Use%'))).toBe(1024 * 1024 * 1024)
  })

  it.each([
    '', 'df: permission denied', DF + '/dev/other 10 5 5 50% /other',
    DF.replace('1024-blocks', 'Size'), DF.replace('1048576 50%', '-1 50%'),
    DF.replace('1048576 50%', '1048576oops 50%'),
    DF.replace('1048576 50%', '3145728 50%'),
    DF.replace('50%', '101%'),
    DF.replace('2097152 1048576 1048576', '99999999999999999999 0 99999999999999999999'),
  ])('refuses ambiguous or malformed output %#', (output) => {
    expect(() => parseAvailableBytes(output)).toThrow(/reliably/)
  })
})

describe('native WebUSB connection', () => {
  it('uses the actual library connection chain and exposes no serial', async () => {
    await client.connect()
    expect(boundary.manager).toHaveBeenCalledWith(navigator.usb)
    expect(boundary.requestDevice).toHaveBeenCalledOnce()
    expect(boundary.authenticate).toHaveBeenCalledWith(expect.objectContaining({
      connection: { testConnection: true }, initialDelayedAckBytes: 0, preserveConnection: false,
    }))
    expect(boundary.constructAdb).toHaveBeenCalledWith(expect.objectContaining({ testTransport: true }))
    expect(client.info.features).toEqual(['shell_v2', 'stat_v2'])
    expect(JSON.stringify(client.info)).not.toContain(fixture.usb.serialNumber)
    expect(client.connected).toBe(true)
  })

  it('generates only session-memory RSA2048 credentials for the stable interface', async () => {
    let store: AdbCredentialStore | undefined
    const keys = async (credentials: AdbCredentialStore): Promise<AdbPrivateKey[]> => {
      const result: AdbPrivateKey[] = []
      for await (const key of credentials.iterateKeys()) result.push(key)
      return result
    }
    boundary.authenticate.mockImplementationOnce(async (options: { credentialStore: AdbCredentialStore }) => {
      store = options.credentialStore
      expect(await keys(store)).toHaveLength(0)
      const key = await store.generateKey()
      const imported = await crypto.subtle.importKey('pkcs8', new Uint8Array(key.buffer),
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
      expect((imported.algorithm as RsaHashedKeyAlgorithm).modulusLength).toBe(2048)
      expect((await keys(store))[0]).toBe(key)
      expect(await store.generateKey()).toBe(key)
      return { close: async () => {} }
    })
    await client.connect()
    expect(store).toBeDefined()
    expect(fixture.storage.setItem).not.toHaveBeenCalled()
  })

  it('refuses unsupported browsers and does not prompt', async () => {
    vi.stubGlobal('navigator', {})
    await expect(client.connect()).rejects.toThrow(/WebUSB/)
    expect(boundary.requestDevice).not.toHaveBeenCalled()
  })

  it('handles chooser cancellation without leaving a live session', async () => {
    boundary.requestDevice.mockResolvedValueOnce(undefined)
    await expect(client.connect()).rejects.toThrow(/cancel/)
    expect(client.connected).toBe(false)
    expect(boundary.authenticate).not.toHaveBeenCalled()
  })

  it('refuses devices without a stable serial rather than guessing ownership', async () => {
    fixture.usb.serialNumber = ''
    await expect(client.connect()).rejects.toThrow()
    expect(boundary.authenticate).not.toHaveBeenCalled()
  })

  it('requires stat_v2 rather than mistaking permission errors for absence', async () => {
    fixture.sync.supportsStat = false
    await expect(client.connect()).rejects.toThrow(/stat_v2/)
    expect(client.connected).toBe(false)
  })

  it('times out authorization and closes the underlying USB connection', async () => {
    vi.useFakeTimers()
    let rejectAuth: (reason: Error) => void = () => {}
    boundary.authenticate.mockImplementationOnce(() => new Promise((_, reject) => { rejectAuth = reject }))
    fixture.onClose = () => rejectAuth(new Error('Closed'))
    const connection = expect(client.connect()).rejects.toThrow(/authorization.*timed out/i)
    await vi.waitFor(() => expect(boundary.authenticate).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(120_001)
    await connection
    expect(fixture.usb.close).toHaveBeenCalled()
    expect(client.connected).toBe(false)
    expect(diagnosticSnapshot().entries).toContainEqual(expect.objectContaining({
      event: 'adb.timeout', context: expect.objectContaining({ timeoutMs: 120_000 }),
    }))
  })

  it('records teardown rejection without an unhandled promise or a live connection', async () => {
    await client.connect()
    fixture.usb.close.mockRejectedValueOnce(new Error('Injected USB close error'))
    client.abort()
    expect(client.connected).toBe(false)
    await expect(client.disconnect()).rejects.toThrow(/teardown/)
    expect(client.lastError).toMatch(/teardown/)
    expect(diagnosticSnapshot().entries).toContainEqual(expect.objectContaining({
      event: 'adb.teardown.failed', context: expect.objectContaining({ operation: 'USB close' }),
    }))
  })
})

describe('owned paths and capability checks', () => {
  it.each(['../escape', RUN + '/..', RUN + '\n', RUN.toUpperCase().replace('1111', 'AAAA'), 'not-a-uuid'])('rejects unsafe run IDs %s', async (run) => {
    await expect(client.createRun(run)).rejects.toThrow(/run ID/)
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it.each(['../personal.bin', '/sdcard/photo.jpg', 'probe.bin/../x', 'r000001-f001.bin;rm', NAME + '\n',
    'r000000-f001.bin', 'r000001-f000.bin', 'r000001-f101.bin',
    'r0000001-f001.bin', 'r9007199254740992-f001.bin'])('rejects invalid file names %s', async (name) => {
    await expect(client.writeFile(RUN, name, new Uint8Array(1))).rejects.toThrow(/filename/)
    expect(fixture.sync.write).not.toHaveBeenCalled()
  })

  it('probes real SYNC write/read/delete before making the run available', async () => {
    await createRun()
    expect(fixture.sync.write).toHaveBeenCalledWith(expect.objectContaining({
      filename: `${PATH}/probe.bin`, dryRun: false, permission: 0o600, type: 8,
    }))
    expect(fixture.sync.read).toHaveBeenCalledWith(`${PATH}/probe.bin`)
    expect(fixture.entries.has(`${PATH}/probe.bin`)).toBe(false)
    expect(saved()[0]!.files).toEqual([])
    expect(saved()[0]!.directory).toEqual({ dev: '12', ino: fixture.entries.get(PATH)!.ino.toString() })
    expect(client.getLeftovers()).toEqual([{ runId: RUN, deviceName: 'Test phone' }])
    expect(fixture.memory.get(KEY)).not.toContain(fixture.usb.serialNumber)
  })

  it.each(['/data', '/data/local', ROOT])('refuses a symlink in ancestor %s', async (path) => {
    fixture.entries.set(path, fixture.entry(10))
    await client.connect()
    await expect(client.createRun(RUN)).rejects.toThrow(/symbolic link/)
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it.each([4, 10, 8])('never adopts a preexisting directory path (type %i)', async (type) => {
    fixture.entries.set(PATH, fixture.entry(type))
    await client.connect()
    await expect(client.createRun(RUN)).rejects.toThrow(/already exists/)
    expect(fixture.storage.setItem).not.toHaveBeenCalled()
    expect(fixture.sync.write).not.toHaveBeenCalled()
  })

  it('refuses replaced directories and symlink files before touching their targets', async () => {
    await createRun()
    const directory = fixture.entries.get(PATH)!
    directory.ino++
    await expect(client.writeFile(RUN, NAME, new Uint8Array(1))).rejects.toThrow(/identity changed/)
    directory.ino--
    fixture.entries.set(`${PATH}/${NAME}`, fixture.entry(10))
    await expect(client.writeFile(RUN, NAME, new Uint8Array(1))).rejects.toThrow(/already exists/)
    expect(fixture.sync.write).toHaveBeenCalledTimes(1)
  })

  it('does not treat an unknown metadata/permission error as a missing file', async () => {
    await client.connect()
    fixture.sync.lstat.mockRejectedValueOnce(new Error('EACCES'))
    await expect(client.createRun(RUN)).rejects.toThrow(/permission/)
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('checks free storage on every call with exact 64 MiB headroom', async () => {
    await createRun()
    fixture.df = 'Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/data 100000 34463 65537 35% /data'
    await client.checkSpace(1024)
    await expect(client.checkSpace(1025)).rejects.toThrow(/64 MiB/)
    expect(fixture.commands.filter((command) => command[0] === 'df')).toHaveLength(3)
  })

  it('requires 1 GiB plus headroom for a maximum-sized workload', async () => {
    await client.connect()
    await expect(client.checkSpace(1024 ** 3)).rejects.toThrow('64 MiB')
    fixture.df = 'Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/data 2097152 983040 1114112 47% /data'
    await client.checkSpace(1024 ** 3)
    await expect(client.checkSpace(1024 ** 3 + 1)).rejects.toThrow('Invalid peak')
  })

  it('fails rather than assuming space when df is malformed or denied', async () => {
    await createRun()
    fixture.df = 'unknown'
    await expect(client.checkSpace(1)).rejects.toThrow(/reliably/)
    fixture.failShell = true
    await expect(client.checkSpace(1)).rejects.toThrow(/permission/)
    expect(client.connected).toBe(false)
  })

  it('caps shell output rather than buffering an unbounded device response', async () => {
    await client.connect()
    fixture.spawn.mockImplementationOnce(async () => ({
      stdout: stream(new Uint8Array(64 * 1024 + 1)),
      stderr: stream(new Uint8Array()),
      exited: Promise.resolve(0),
      kill: vi.fn(async () => {}),
    }))
    await expect(client.checkSpace(1)).rejects.toThrow(/large shell response/)
    expect(client.connected).toBe(false)
  })

  it('times out a stalled shell command and invalidates the connection', async () => {
    await client.connect()
    vi.useFakeTimers()
    let rejectExit: (error: Error) => void = () => {}
    fixture.spawn.mockImplementationOnce(async () => ({
      stdout: stream(new Uint8Array()),
      stderr: stream(new Uint8Array()),
      exited: new Promise<number>((_, reject) => { rejectExit = reject }),
      kill: vi.fn(async () => {}),
    }))
    fixture.onClose = () => rejectExit(new Error('USB closed'))
    const rejected = expect(client.checkSpace(1)).rejects.toThrow(/timed out/)
    await vi.waitFor(() => expect(fixture.spawn).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(15_001)
    await rejected
    expect(client.connected).toBe(false)
  })
})

describe('bounded actual SYNC transfers', () => {
  it('retains the failing file identity and native errno without serials or payloads', async () => {
    await createRun()
    clearDiagnostics()
    fixture.sync.write.mockRejectedValue(new Error('EIO'))
    await expect(client.writeFile(RUN, NAME, new Uint8Array([91, 92, 93]))).rejects.toThrow('upload failed')
    const log = diagnosticSnapshot()
    expect(log.entries.filter((entry) => entry.level === 'error')).toHaveLength(1)
    expect(log.entries[0]).toMatchObject({
      event: 'adb.operation.failed',
      context: { runId: RUN, round: 1, index: 1, bytes: 3, operation: 'write file' },
    })
    expect(log.entries[0].errors?.some((error) => error.code === 'EIO')).toBe(true)
    expect(JSON.stringify(log)).not.toMatch(/private-device-serial|Test phone|91,92,93/)
  })

  it('keeps a successful real-adapter mock workload quiet by default', async () => {
    await createRun()
    await client.writeFile(RUN, NAME, new Uint8Array([1, 2, 3]))
    await client.readFile(RUN, NAME, 3)
    await client.removeFile(RUN, NAME)
    await client.cleanupRun(RUN)
    await client.disconnect()
    expect(diagnosticSnapshot().entries).toEqual([])
  })

  it('accepts canonical filenames for rounds beyond six digits', async () => {
    await createRun()
    const name = 'r1000000-f001.bin'
    await client.writeFile(RUN, name, new Uint8Array([7]))
    expect(await client.readFile(RUN, name, 1)).toEqual(new Uint8Array([7]))
    await client.removeFile(RUN, name)
  })

  it('accepts the numeric STAT2 link count and rejects multiple hard links', async () => {
    await createRun()
    await client.writeFile(RUN, NAME, new Uint8Array([7]))
    expect(await client.readFile(RUN, NAME, 1)).toEqual(new Uint8Array([7]))
    fixture.entries.get(`${PATH}/${NAME}`)!.nlink = 2
    await expect(client.readFile(RUN, NAME, 1)).rejects.toThrow(/linked/)
    await expect(client.removeFile(RUN, NAME)).rejects.toThrow(/linked/)
  })

  it('writes to SYNC, reads independent device bytes, and checks stat size', async () => {
    await createRun()
    const bytes = new Uint8Array([1, 2, 3, 4])
    await client.writeFile(RUN, NAME, bytes)
    bytes.fill(9)
    expect(await client.readFile(RUN, NAME, 4)).toEqual(new Uint8Array([1, 2, 3, 4]))
    expect(await client.statFile(RUN, NAME)).toBe(4)
    expect(saved()[0]!.files).toEqual([NAME])
  })

  it('preserves a partial final SYNC packet above the former 16 MiB cap', async () => {
    await createRun()
    const data = new Uint8Array(16 * 1024 ** 2 + 7)
    data[0] = 7
    data[data.length - 1] = 9
    const expectedHash = await hashPayload(data)
    await client.writeFile(RUN, NAME, data)
    data.fill(0)
    expect(await hashPayload(await client.readFile(RUN, NAME, data.length))).toBe(expectedHash)
  })

  it('uploads and independently reads exactly 1 GiB through the actual adapter', async () => {
    await createRun()
    const data = new Uint8Array(1024 ** 3)
    data[0] = 7
    data[data.length - 1] = 9
    const expectedHash = await hashPayload(data)
    let uploaded = 0
    let packets = 0
    fixture.sync.write.mockImplementationOnce(async ({ filename, file }) => {
      for await (const chunk of file) {
        expect(chunk.byteLength).toBe(64 * 1024)
        expect(chunk.buffer).toBe(data.buffer)
        expect(chunk.byteOffset).toBe(uploaded)
        uploaded += chunk.byteLength
        packets++
      }
      fixture.entries.set(filename, { ...fixture.entry(8), size: BigInt(uploaded) })
    })
    await client.writeFile(RUN, NAME, data)
    expect(uploaded).toBe(1024 ** 3)
    expect(packets).toBe(16384)
    expect(await client.statFile(RUN, NAME)).toBe(1024 ** 3)
    let offset = 0
    fixture.sync.read.mockReturnValueOnce(new ReadableStream({
      pull(controller) {
        controller.enqueue(data.subarray(offset, offset + 64 * 1024))
        offset += 64 * 1024
        if (offset === data.length) controller.close()
      },
    }))
    const returned = await client.readFile(RUN, NAME, data.length)
    expect(returned.buffer).not.toBe(data.buffer)
    expect(returned.byteLength).toBe(1024 ** 3)
    expect(await hashPayload(returned)).toBe(expectedHash)
    fixture.entries.get(`${PATH}/${NAME}`)!.size++
    await expect(client.statFile(RUN, NAME)).rejects.toThrow('1 GiB')
    await client.removeFile(RUN, NAME)
    await client.cleanupRun(RUN)
    expect(saved()).toEqual([])
  }, 60_000)

  it.each([0, -1, 0.5, NaN, Infinity, 1024 ** 3 + 1])('rejects invalid expected byte limits %s before reading', async (size) => {
    await expect(client.readFile(RUN, NAME, size)).rejects.toThrow(/size/)
    expect(fixture.sync.read).not.toHaveBeenCalled()
  })

  it.each([
    { bytes: [1, 2], error: /truncated/ },
    { bytes: [1, 2, 3, 4, 5], error: /exceeded/ },
  ])('rejects $bytes.length received bytes when four were expected', async ({ bytes, error }) => {
    await createRun()
    await client.writeFile(RUN, NAME, new Uint8Array(4))
    fixture.sync.read.mockReturnValueOnce(stream(new Uint8Array(bytes)))
    await expect(client.readFile(RUN, NAME, 4)).rejects.toThrow(error)
    expect(client.connected).toBe(false)
    expect(fixture.usb.close).toHaveBeenCalled()
  })

  it('rejects a stream failure and keeps exact file ownership for cleanup', async () => {
    await createRun()
    await client.writeFile(RUN, NAME, new Uint8Array(4))
    fixture.sync.read.mockReturnValueOnce(new ReadableStream({
      start(controller) { controller.error(new Error('Injected I/O failure')) },
    }))
    await expect(client.readFile(RUN, NAME, 4)).rejects.toThrow(/download failed/)
    expect(saved()[0]!.files).toEqual([NAME])
    expect(client.connected).toBe(false)
  })

  it('rejects a SYNC write failure without untracking a partially created file', async () => {
    await createRun()
    fixture.sync.write.mockRejectedValueOnce(new Error('Injected write failure'))
    await expect(client.writeFile(RUN, NAME, new Uint8Array(4))).rejects.toThrow(/upload failed/)
    expect(saved()[0]!.files).toEqual([NAME])
    expect(client.connected).toBe(false)
  })

  it('cancels a pending upload and does not schedule later writes', async () => {
    await createRun()
    let rejectWrite: (error: Error) => void = () => {}
    fixture.sync.write.mockImplementationOnce(() => new Promise((_, reject) => { rejectWrite = reject }))
    fixture.onClose = () => rejectWrite(new Error('USB closed'))
    const rejected = expect(client.writeFile(RUN, NAME, new Uint8Array(4))).rejects.toThrow(/canceled/)
    await vi.waitFor(() => expect(fixture.sync.write).toHaveBeenCalledTimes(2))
    client.abort()
    expect(client.connected).toBe(false)
    await rejected
    expect(saved()[0]!.files).toEqual([NAME])
    await expect(client.writeFile(RUN, 'r000001-f002.bin', new Uint8Array(4))).rejects.toThrow(/disconnected/)
    expect(fixture.sync.write).toHaveBeenCalledTimes(2)
  })

  it('invalidates synchronously on cancel, closes USB rather than draining, and refuses concurrent work', async () => {
    await createRun()
    await client.writeFile(RUN, NAME, new Uint8Array(4))
    const cancel = vi.fn()
    fixture.sync.read.mockReturnValueOnce(new ReadableStream({
      start(controller) { fixture.onClose = () => controller.error(new Error('USB closed')) },
      cancel,
    }))
    const reading = client.readFile(RUN, NAME, 4)
    const rejected = expect(reading).rejects.toThrow(/canceled/)
    await vi.waitFor(() => expect(fixture.sync.read).toHaveBeenCalledWith(`${PATH}/${NAME}`))
    await expect(client.checkSpace(1)).rejects.toThrow(/Concurrent/)
    client.abort()
    expect(client.connected).toBe(false)
    expect(fixture.usb.close).toHaveBeenCalled()
    await rejected
    expect(cancel).not.toHaveBeenCalled()
    expect(disconnected).toHaveBeenCalledOnce()
    await expect(client.readFile(RUN, NAME, 4)).rejects.toThrow(/disconnected/)
  })

  it('times out a stuck file read and rejects before the connection can be reused', async () => {
    await createRun()
    await client.writeFile(RUN, NAME, new Uint8Array(4))
    vi.useFakeTimers()
    fixture.sync.read.mockReturnValueOnce(new ReadableStream({
      start(controller) { fixture.onClose = () => controller.error(new Error('USB closed')) },
    }))
    const rejected = expect(client.readFile(RUN, NAME, 4)).rejects.toThrow(/timed out/)
    await vi.waitFor(() => expect(fixture.sync.read).toHaveBeenCalledWith(`${PATH}/${NAME}`))
    await vi.advanceTimersByTimeAsync(120_001)
    await rejected
    expect(client.connected).toBe(false)
  })

  it('allows an upload to exceed two minutes while SYNC consumes chunks', async () => {
    await createRun()
    vi.useFakeTimers()
    const data = new Uint8Array(4 * 64 * 1024)
    let uploaded = 0
    fixture.sync.write.mockImplementationOnce(async ({ filename, file }) => {
      for await (const chunk of file) {
        await new Promise((resolve) => setTimeout(resolve, 45_000))
        uploaded += chunk.byteLength
      }
      fixture.entries.set(filename, { ...fixture.entry(8), size: BigInt(uploaded) })
    })
    const completed = expect(client.writeFile(RUN, NAME, data)).resolves.toBeUndefined()
    await vi.advanceTimersByTimeAsync(180_001)
    await completed
    expect(uploaded).toBe(data.length)
    expect(client.connected).toBe(true)
  })

  it('allows a download to exceed two minutes while receiving data', async () => {
    await createRun()
    await client.writeFile(RUN, NAME, new Uint8Array([1, 2, 3, 4]))
    vi.useFakeTimers()
    let next = 1
    fixture.sync.read.mockReturnValueOnce(new ReadableStream({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 45_000))
        controller.enqueue(new Uint8Array([next++]))
        if (next === 5) controller.close()
      },
    }))
    const completed = expect(client.readFile(RUN, NAME, 4)).resolves.toEqual(new Uint8Array([1, 2, 3, 4]))
    await vi.advanceTimersByTimeAsync(180_001)
    await completed
    expect(client.connected).toBe(true)
  })

  it('times out two minutes after the last download progress', async () => {
    await createRun()
    await client.writeFile(RUN, NAME, new Uint8Array(4))
    vi.useFakeTimers()
    fixture.sync.read.mockReturnValueOnce(new ReadableStream({
      start(controller) {
        setTimeout(() => controller.enqueue(new Uint8Array([1])), 90_000)
        fixture.onClose = () => controller.error(new Error('USB closed'))
      },
    }))
    const rejected = expect(client.readFile(RUN, NAME, 4)).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(120_001)
    expect(client.connected).toBe(true)
    await vi.advanceTimersByTimeAsync(90_000)
    await rejected
    expect(client.connected).toBe(false)
  })

  it('does not count empty download chunks as progress', async () => {
    await createRun()
    await client.writeFile(RUN, NAME, new Uint8Array(4))
    vi.useFakeTimers()
    fixture.sync.read.mockReturnValueOnce(new ReadableStream({
      start(controller) {
        const interval = setInterval(() => controller.enqueue(new Uint8Array()), 30_000)
        fixture.onClose = () => {
          clearInterval(interval)
          controller.error(new Error('USB closed'))
        }
      },
    }))
    const rejected = expect(client.readFile(RUN, NAME, 4)).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(120_001)
    await rejected
    expect(client.connected).toBe(false)
  })

  it('times out a stuck upload despite readable-stream prefetch', async () => {
    await createRun()
    vi.useFakeTimers()
    fixture.sync.write.mockImplementationOnce(() => new Promise((_, reject) => {
      fixture.onClose = () => reject(new Error('USB closed'))
    }))
    const rejected = expect(client.writeFile(RUN, NAME, new Uint8Array(256 * 1024))).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(120_001)
    await rejected
    expect(client.connected).toBe(false)
    expect(saved()[0]!.files).toEqual([NAME])
  })
})

describe('persistent, scoped cleanup', () => {
  it('deletes only exact tracked paths and the empty directory after reconnect', async () => {
    await createRun()
    await client.writeFile(RUN, NAME, new Uint8Array(4))
    const unrelated = '/sdcard/DCIM/personal.jpg'
    fixture.entries.set(unrelated, fixture.entry(8, new Uint8Array([99])))
    await client.disconnect()
    client = new AdbClient()
    await client.connect()
    await client.cleanupLeftovers()
    expect(fixture.commands.filter((command) => command[0] === 'rm')).toEqual([
      ['rm', `${PATH}/probe.bin`], ['rm', `${PATH}/${NAME}`],
    ])
    expect(fixture.commands).toContainEqual(['rmdir', PATH])
    expect(fixture.entries.has(unrelated)).toBe(true)
    expect(fixture.entries.has(PATH)).toBe(false)
    expect(client.getLeftovers()).toEqual([])
    expect(fixture.commands.flat().some((part) => ['-rf', '-r', '*'].includes(part))).toBe(false)
  })

  it('refuses cleanup of valid records on a different device', async () => {
    await createRun()
    await client.writeFile(RUN, NAME, new Uint8Array(4))
    await client.disconnect()
    fixture.usb.serialNumber = 'a-different-phone'
    client = new AdbClient()
    await client.connect()
    fixture.commands.length = 0
    await expect(client.cleanupLeftovers()).rejects.toThrow(/different phone/)
    await expect(client.cleanupRun(RUN)).rejects.toThrow(/same phone/)
    expect(fixture.commands).toEqual([])
    expect(fixture.entries.has(`${PATH}/${NAME}`)).toBe(true)
  })

  it('cleans the connected phone without deleting another phone’s persisted ownership', async () => {
    await createRun()
    const other: Saved = {
      ...saved()[0]!,
      runId: '33333333-3333-4333-8333-333333333333',
      directoryId: '44444444-4444-4444-8444-444444444444',
      deviceId: 'a'.repeat(64), deviceName: 'Other phone', files: [NAME],
    }
    fixture.memory.set(KEY, JSON.stringify([...saved(), other]))
    await client.cleanupLeftovers()
    expect(saved()).toEqual([other])
    expect(fixture.commands.flat()).not.toContain(`${ROOT}/webusb-transfer-lab-${other.directoryId}`)
  })

  it('refuses deletion of untracked files and of tracked files replaced by symlinks', async () => {
    await createRun()
    await expect(client.removeFile(RUN, NAME)).rejects.toThrow(/not tracked/)
    await client.writeFile(RUN, NAME, new Uint8Array(4))
    fixture.entries.set(`${PATH}/${NAME}`, fixture.entry(10))
    await expect(client.cleanupRun(RUN)).rejects.toThrow(/linked/)
    expect(fixture.entries.has(`${PATH}/${NAME}`)).toBe(true)
    expect(saved()[0]!.files).toEqual([NAME])
  })

  it('uses rmdir without recursion and retains the record if unexpected files prevent removal', async () => {
    await createRun()
    const unexpected = `${PATH}/untracked.bin`
    fixture.entries.set(unexpected, fixture.entry(8, new Uint8Array([7])))
    await expect(client.cleanupRun(RUN)).rejects.toThrow(/Remove empty/)
    expect(fixture.entries.has(unexpected)).toBe(true)
    expect(saved()).toHaveLength(1)
    expect(fixture.commands).not.toContainEqual(['rm', unexpected])
  })

  it.each([
    '{broken', '{}',
    JSON.stringify([{ runId: RUN, directoryId: '../../sdcard', deviceId: 'a'.repeat(64),
      deviceName: 'Phone', directory: { dev: '1', ino: '2' }, files: [] }]),
  ])('refuses unsafe persisted ownership %#', async (value) => {
    fixture.memory.set(KEY, value)
    expect(() => client.getLeftovers()).toThrow(/malformed/)
    await client.connect()
    await expect(client.cleanupLeftovers()).rejects.toThrow(/malformed/)
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('validates persisted filename traversal instead of trusting localStorage', async () => {
    await createRun()
    const records = saved()
    records[0]!.files.push('../../personal.jpg')
    fixture.memory.set(KEY, JSON.stringify(records))
    fixture.commands.length = 0
    await expect(client.cleanupLeftovers()).rejects.toThrow(/malformed/)
    expect(fixture.commands).toEqual([])
  })

  it('refuses to write if cleanup records cannot be persisted', async () => {
    await createRun()
    fixture.storage.setItem.mockImplementationOnce(() => { throw new Error('Quota exceeded') })
    await expect(client.writeFile(RUN, NAME, new Uint8Array(4))).rejects.toThrow(/persist/)
    expect(fixture.sync.write).toHaveBeenCalledTimes(1)
    expect(fixture.entries.has(`${PATH}/${NAME}`)).toBe(false)
    expect(saved()[0]!.files).toEqual([])
  })

  it('reserves the directory before mkdir and never adopts unconfirmed ownership', async () => {
    await client.connect()
    fixture.spawn.mockImplementationOnce(async () => { throw new Error('Lost mkdir acknowledgement') })
    await expect(client.createRun(RUN)).rejects.toThrow()
    expect(saved()[0]!.directory).toBeNull()
    fixture.entries.set(PATH, fixture.entry(4))
    await client.disconnect()
    await client.connect()
    await expect(client.cleanupRun(RUN)).rejects.toThrow(/unconfirmed/)
    expect(fixture.entries.has(PATH)).toBe(true)
  })

  it('forgets already absent owned paths without issuing broad deletion', async () => {
    await createRun()
    await client.writeFile(RUN, NAME, new Uint8Array(4))
    fixture.entries.delete(`${PATH}/${NAME}`)
    fixture.entries.delete(PATH)
    fixture.commands.length = 0
    await client.cleanupRun(RUN)
    expect(client.getLeftovers()).toEqual([])
    expect(fixture.commands).toEqual([])
  })
})
