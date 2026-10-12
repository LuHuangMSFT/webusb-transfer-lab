import type { Payload, PayloadProgress, PayloadService, Settings } from './types'
import { validateSettings } from './workload'

export class PreparedFiles {
  readonly #settings: Settings
  readonly #files = new Map<number, Payload>()
  #probe: Payload | undefined
  #claimed = false

  private constructor(settings: Settings) {
    this.#settings = validateSettings(settings)
  }

  static async prepare(
    settings: Settings,
    service: PayloadService,
    signal: AbortSignal,
    onProgress: (completed: number, total: number, current?: PayloadProgress & { file: number }) => void,
  ): Promise<PreparedFiles> {
    const result = new PreparedFiles(settings)
    if (!result.#settings.preGenerate) throw new Error('Pre-generation is not enabled.')
    const { fileCount, fileSizeBytes, rounds, reuseAcrossRounds } = result.#settings
    const total = fileCount * (reuseAcrossRounds ? 1 : rounds)
    let rejectCanceled!: (error: Error) => void
    const canceled = new Promise<never>((_, reject) => { rejectCanceled = reject })
    void canceled.catch(() => {})
    const abort = (): void => {
      rejectCanceled(new Error('File preparation canceled.'))
      service.dispose()
    }
    async function generate(size: number, index: number, file: number): Promise<Payload> {
      signal.throwIfAborted()
      const payload = await Promise.race([service.prepare(size, result.#settings.seed, index, (progress) => {
        if (!signal.aborted) onProgress(Math.max(0, file - 1), total, { ...progress, file })
      }), canceled])
      signal.throwIfAborted()
      if (payload.bytes.byteLength !== size || !/^[a-f0-9]{64}$/.test(payload.sha256)) {
        throw new Error('Prepared payload has an invalid size or SHA-256.')
      }
      return payload
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      onProgress(0, total)
      result.#probe = await generate(Math.min(64, fileSizeBytes), 0, 0)
      for (let slot = 0; slot < total; slot++) {
        result.#files.set(slot, await generate(fileSizeBytes, slot % fileCount + 1, slot + 1))
        onProgress(slot + 1, total)
      }
      signal.throwIfAborted()
      return result
    } catch (error) {
      result.dispose()
      throw error
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  matches(settings: Settings): boolean {
    return !this.#claimed && this.#probe !== undefined && Boolean(settings.preGenerate) &&
      Boolean(this.#settings.reuseAcrossRounds) === Boolean(settings.reuseAcrossRounds) &&
      (['fileCount', 'fileSizeBytes', 'rounds', 'seed'] as const).every((key) => this.#settings[key] === settings[key])
  }

  claim(settings: Settings): void {
    if (!this.matches(settings)) throw new Error('Prepare all files for the current settings before starting transfer.')
    this.#claimed = true
  }

  get probe(): Payload {
    if (!this.#claimed || !this.#probe) throw new Error('Prepared capability probe is unavailable.')
    return this.#probe
  }

  take(round: number, index: number): Payload {
    if (!this.#claimed || !Number.isInteger(round) || round < 1 || round > this.#settings.rounds ||
        !Number.isInteger(index) || index < 1 || index > this.#settings.fileCount) {
      throw new Error('Prepared file does not match this run.')
    }
    const key = (this.#settings.reuseAcrossRounds ? 0 : round - 1) * this.#settings.fileCount + index - 1
    const payload = this.#files.get(key)
    if (!payload) throw new Error('Prepared file is missing or already consumed.')
    if (!this.#settings.reuseAcrossRounds || round === this.#settings.rounds) this.#files.delete(key)
    return payload
  }

  dispose(): void {
    this.#files.clear()
    this.#probe = undefined
  }
}
