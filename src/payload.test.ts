import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPayloadService } from './payload'
import type { PayloadReply, PayloadRequest } from './payload'

class FakeWorker {
  static latest: FakeWorker
  onmessage: ((event: MessageEvent<PayloadReply>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: (() => void) | null = null
  messages: PayloadRequest[] = []
  terminated = false
  failPost = false
  constructor() { FakeWorker.latest = this }
  postMessage(message: PayloadRequest, transfers: Transferable[]): void {
    if (this.failPost) throw new Error('post failed')
    this.messages.push(structuredClone(message, { transfer: transfers }))
  }
  terminate(): void { this.terminated = true }
  respond(reply: PayloadReply): void {
    this.onmessage?.({ data: reply } as MessageEvent<PayloadReply>)
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('browser worker payload service (simulated worker transport)', () => {
  it('delivers intermediate progress without settling the request or dropping its eventual payload', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const service = createPayloadService()
    const progress = vi.fn()
    let settled = false
    const prepared = service.prepare(8, 'seed', 1, progress).then((value) => { settled = true; return value })
    const worker = FakeWorker.latest
    const { id } = worker.messages[0]
    expect(worker.messages[0]).toMatchObject({ reportProgress: true })
    worker.respond({ id, operation: 'progress', progress: { stage: 'generate', completedBytes: 4, totalBytes: 8 } })
    worker.respond({ id, operation: 'progress', progress: { stage: 'hash', completedBytes: 8, totalBytes: 8 } })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(progress).toHaveBeenCalledTimes(2)
    expect(progress).toHaveBeenLastCalledWith({ stage: 'hash', completedBytes: 8, totalBytes: 8 })
    worker.respond({ id, operation: 'prepare', buffer: new ArrayBuffer(8), sha256: 'expected' })
    expect((await prepared).bytes.byteLength).toBe(8)
    worker.respond({ id, operation: 'progress', progress: { stage: 'generate', completedBytes: 8, totalBytes: 8 } })
    expect(progress).toHaveBeenCalledTimes(2)
    service.dispose()
  })

  it('ignores queued progress after disposal and rejects a throwing progress consumer', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    let service = createPayloadService()
    const progress = vi.fn()
    const canceled = expect(service.prepare(8, 'seed', 1, progress)).rejects.toThrow('disposed')
    let worker = FakeWorker.latest
    let id = worker.messages[0].id
    service.dispose()
    worker.respond({ id, operation: 'progress', progress: { stage: 'hash', completedBytes: 8, totalBytes: 8 } })
    await canceled
    expect(progress).not.toHaveBeenCalled()
    service = createPayloadService()
    const failed = expect(service.prepare(8, 'seed', 1, () => { throw new Error('progress failed') })).rejects.toThrow('progress failed')
    worker = FakeWorker.latest
    id = worker.messages[0].id
    worker.respond({ id, operation: 'progress', progress: { stage: 'generate', completedBytes: 0, totalBytes: 8 } })
    await failed
    service.dispose()
  })

  it('returns generated buffers and transfers receive buffers to hashing', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const service = createPayloadService()
    const prepared = service.prepare(3, 'seed', 1)
    const worker = FakeWorker.latest
    expect(worker.messages[0]).toMatchObject({ operation: 'prepare', size: 3, seed: 'seed', index: 1 })
    worker.respond({ id: worker.messages[0].id, operation: 'prepare', buffer: new Uint8Array([1, 2, 3]).buffer, sha256: 'expected' })
    const payload = await prepared
    expect(payload.bytes).toEqual(new Uint8Array([1, 2, 3]))
    const hashed = service.hash(payload.bytes)
    expect(payload.bytes.byteLength).toBe(0)
    const request = worker.messages[1]
    expect(request.operation).toBe('hash')
    if (request.operation === 'hash') expect(new Uint8Array(request.buffer)).toEqual(new Uint8Array([1, 2, 3]))
    worker.respond({ id: request.id, operation: 'hash', sha256: 'actual' })
    expect(await hashed).toBe('actual')
    service.dispose()
  })

  it('hashes only a supplied view, not unrelated bytes in its backing buffer', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const service = createPayloadService()
    const bytes = new Uint8Array([99, 1, 2, 88])
    const hashed = service.hash(bytes.subarray(1, 3))
    const worker = FakeWorker.latest
    const request = worker.messages[0]
    if (request.operation !== 'hash') throw new Error('Expected hash')
    expect(new Uint8Array(request.buffer)).toEqual(new Uint8Array([1, 2]))
    expect(bytes.byteLength).toBe(4)
    worker.respond({ id: request.id, operation: 'hash', sha256: 'view' })
    expect(await hashed).toBe('view')
    service.dispose()
  })

  it('rejects all pending and future requests when disposed', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const service = createPayloadService()
    const first = expect(service.prepare(1, 'seed', 0)).rejects.toThrow('disposed')
    const second = expect(service.hash(new Uint8Array(1))).rejects.toThrow('disposed')
    service.dispose()
    service.dispose()
    await Promise.all([first, second])
    expect(FakeWorker.latest.terminated).toBe(true)
    await expect(service.prepare(1, 'seed', 0)).rejects.toThrow('disposed')
  })

  it('handles worker errors and message/post failures without stranded promises', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    let service = createPayloadService()
    let rejected = expect(service.prepare(1, 'seed', 0)).rejects.toThrow('worker failed')
    FakeWorker.latest.onerror?.({ message: 'crash', preventDefault() {} } as ErrorEvent)
    await rejected
    expect(FakeWorker.latest.terminated).toBe(true)

    service = createPayloadService()
    rejected = expect(service.prepare(1, 'seed', 0)).rejects.toThrow('decoded')
    FakeWorker.latest.onmessageerror?.()
    await rejected

    service = createPayloadService()
    FakeWorker.latest.failPost = true
    await expect(service.prepare(1, 'seed', 0)).rejects.toThrow('post failed')
    FakeWorker.latest.failPost = false
    rejected = expect(service.prepare(1, 'seed', 0)).rejects.toThrow('bad size')
    FakeWorker.latest.respond({ id: FakeWorker.latest.messages[0].id, error: 'bad size' })
    await rejected
    service.dispose()
  })
})
