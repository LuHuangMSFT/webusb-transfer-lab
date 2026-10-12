import { afterEach, expect, it, vi } from 'vitest'
import type { PayloadReply, PayloadRequest } from './payload'
import { hashPayload } from './workload'

afterEach(() => vi.unstubAllGlobals())

it('executes the worker handler with actual generation/SHA-256 and transferable replies', async () => {
  const replies: PayloadReply[] = []
  const scope = {
    onmessage: null as ((event: MessageEvent<PayloadRequest>) => void) | null,
    postMessage(message: PayloadReply, transfers: Transferable[] = []) {
      replies.push(structuredClone(message, { transfer: transfers }))
    },
  }
  vi.stubGlobal('self', scope)
  await import('./payload.worker')
  scope.onmessage?.({ data: { id: 1, operation: 'prepare', size: 32, seed: 'webusb-lab', index: 1 } } as MessageEvent<PayloadRequest>)
  await vi.waitFor(() => expect(replies).toHaveLength(1))
  const prepared = replies[0]
  if ('error' in prepared || prepared.operation !== 'prepare') throw new Error('Expected generated reply')
  expect(prepared.sha256).toBe('ff2af7ef52f4400146fe08774a5e49e3912180591336f5787a1aa3c05197777e')
  expect(await hashPayload(new Uint8Array(prepared.buffer))).toBe(prepared.sha256)
  scope.onmessage?.({ data: { id: 2, operation: 'hash', buffer: prepared.buffer } } as MessageEvent<PayloadRequest>)
  await vi.waitFor(() => expect(replies).toHaveLength(2))
  expect(replies[1]).toEqual({ id: 2, operation: 'hash', sha256: prepared.sha256 })
  scope.onmessage?.({ data: { id: 3, operation: 'prepare', size: 0, seed: 'seed', index: 0 } } as MessageEvent<PayloadRequest>)
  await vi.waitFor(() => expect(replies).toHaveLength(3))
  expect(replies[2]).toMatchObject({ id: 3, error: expect.stringContaining('Payload size') })
})
