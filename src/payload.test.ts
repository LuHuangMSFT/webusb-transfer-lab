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
