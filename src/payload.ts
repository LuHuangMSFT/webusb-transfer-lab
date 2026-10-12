import type { PayloadService } from './types'
import { generatePayloadBytes, hashPayload } from './workload'
import { diagnosticError } from './diagnostics'

export type PayloadRequest =
  | { id: number; operation: 'prepare'; size: number; seed: string; index: number }
  | { id: number; operation: 'hash'; buffer: ArrayBuffer }

export type PayloadReply =
  | { id: number; operation: 'prepare'; buffer: ArrayBuffer; sha256: string }
  | { id: number; operation: 'hash'; sha256: string }
  | { id: number; error: string }

export function createPayloadService(): PayloadService {
  const worker = new Worker(new URL('./payload.worker.ts', import.meta.url), { type: 'module' })
  const pending = new Map<number, { operation: PayloadRequest['operation']; resolve(value: PayloadReply): void; reject(error: Error): void }>()
  let nextId = 0
  let disposed = false

  function stop(error: Error): void {
    if (disposed) return
    disposed = true
    worker.terminate()
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }

  worker.onmessage = (event: MessageEvent<PayloadReply>) => {
    const reply = event.data
    const request = pending.get(reply.id)
    if (!request) return
    pending.delete(reply.id)
    if ('error' in reply) {
      const error = new Error(reply.error)
      diagnosticError('worker.operation.failed', 'Payload generation or hashing failed. The run cannot continue.',
        error, { operation: request.operation })
      request.reject(error)
    } else request.resolve(reply)
  }
  worker.onerror = (event) => {
    event.preventDefault()
    const error = new Error(`Payload worker failed: ${event.message}`, { cause: event.error })
    diagnosticError('worker.failed', 'The payload worker failed. Reload before another run.', error, { pending: pending.size })
    stop(error)
  }
  worker.onmessageerror = () => {
    const error = new Error('Payload worker response could not be decoded.')
    diagnosticError('worker.message.failed', 'Worker communication failed. Reload before another run.', error)
    stop(error)
  }

  function request(message: PayloadRequest, transfers: Transferable[] = []): Promise<PayloadReply> {
    if (disposed) return Promise.reject(new Error('Payload service disposed.'))
    return new Promise((resolve, reject) => {
      pending.set(message.id, { operation: message.operation, resolve, reject })
      try {
        worker.postMessage(message, transfers)
      } catch (error) {
        pending.delete(message.id)
        diagnosticError('worker.send.failed', 'The payload request could not reach the worker. The run cannot continue.',
          error, { operation: message.operation })
        reject(error)
      }
    })
  }

  function id(): number {
    nextId = nextId === Number.MAX_SAFE_INTEGER ? 1 : nextId + 1
    return nextId
  }

  return {
    async prepare(size, seed, index) {
      const reply = await request({ id: id(), operation: 'prepare', size, seed, index })
      if ('error' in reply || reply.operation !== 'prepare') throw new Error('Unexpected payload worker response.')
      return { bytes: new Uint8Array(reply.buffer), sha256: reply.sha256 }
    },
    async hash(bytes) {
      const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer
        : bytes.slice().buffer
      const reply = await request({ id: id(), operation: 'hash', buffer }, [buffer])
      if ('error' in reply || reply.operation !== 'hash') throw new Error('Unexpected payload worker response.')
      return reply.sha256
    },
    dispose() {
      stop(new Error('Payload service disposed.'))
    },
  }
}

// Explicitly injected by simulated tests; production uses the browser worker.
export function createInProcessPayloadService(): PayloadService {
  let disposed = false
  function check(): void {
    if (disposed) throw new Error('Payload service disposed.')
  }
  return {
    async prepare(size, seed, index) {
      check()
      const bytes = generatePayloadBytes(size, seed, index)
      const sha256 = await hashPayload(bytes)
      check()
      return { bytes, sha256 }
    },
    async hash(bytes) {
      check()
      const sha256 = await hashPayload(bytes)
      check()
      return sha256
    },
    dispose() { disposed = true },
  }
}
