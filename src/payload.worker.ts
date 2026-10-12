import type { PayloadReply, PayloadRequest } from './payload'
import { generatePayloadBytes, hashPayload } from './workload'

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<PayloadRequest>) => void) | null
  postMessage(message: PayloadReply, transfers?: Transferable[]): void
}

scope.onmessage = (event) => {
  void handle(event.data)
}

async function handle(request: PayloadRequest): Promise<void> {
  try {
    if (request.operation === 'prepare') {
      const bytes = generatePayloadBytes(request.size, request.seed, request.index, request.reportProgress
        ? (completedBytes) => scope.postMessage({
          id: request.id, operation: 'progress', progress: { stage: 'generate', completedBytes, totalBytes: request.size },
        }) : undefined)
      if (request.reportProgress) scope.postMessage({
        id: request.id, operation: 'progress', progress: { stage: 'hash', completedBytes: request.size, totalBytes: request.size },
      })
      const sha256 = await hashPayload(bytes)
      scope.postMessage({ id: request.id, operation: 'prepare', buffer: bytes.buffer, sha256 }, [bytes.buffer])
    } else {
      const sha256 = await hashPayload(new Uint8Array(request.buffer))
      scope.postMessage({ id: request.id, operation: 'hash', sha256 })
    }
  } catch (error) {
    scope.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) })
  }
}
