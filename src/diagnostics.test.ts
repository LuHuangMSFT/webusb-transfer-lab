import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDiagnostics, diagnosticError, diagnosticSnapshot, diagnosticsEnabled, setDiagnosticsEnabled, trace } from './diagnostics'

beforeEach(() => {
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  setDiagnosticsEnabled(false)
  clearDiagnostics()
})
afterEach(() => {
  setDiagnosticsEnabled(false)
  clearDiagnostics()
  vi.restoreAllMocks()
})

describe('bounded, privacy-filtered diagnostics', () => {
  it('does no console output or timestamp collection for disabled traces', () => {
    const clock = vi.spyOn(performance, 'now')
    trace('test.idle', { bytes: 1024 })
    expect(diagnosticsEnabled()).toBe(false)
    expect(console.debug).not.toHaveBeenCalled()
    expect(clock).not.toHaveBeenCalled()
    expect(diagnosticSnapshot().entries).toEqual([])
  })

  it('records actionable errors when tracing is off, without raw messages or unknown properties', () => {
    const native = new DOMException('secret serial, seed, and payload', 'NetworkError')
    const error = new Error('private notes / private filename', { cause: native })
    error.stack = 'Error: private notes\n at read (https://example.test/webusb-transfer-lab/src/adb-client.ts:42:9)\n at unrelated (C:\\Users\\private\\file.ts:3:1)'
    diagnosticError('test.failed', 'Reconnect before retrying.', error, {
      bytes: 4, operation: 'read file', ...{ serialNumber: 'private-serial', payload: new Uint8Array([1, 2, 3]) },
    })
    const snapshot = diagnosticSnapshot()
    expect(snapshot.entries[0]).toMatchObject({
      level: 'error', action: 'Reconnect before retrying.', context: { bytes: 4, operation: 'read file' },
      errors: [{ name: 'Error', sources: ['/webusb-transfer-lab/src/adb-client.ts:42:9'] }, { name: 'NetworkError', code: native.code }],
    })
    expect(console.error).toHaveBeenCalledOnce()
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|private|serialNumber|payload/)
    expect(vi.mocked(console.error).mock.calls[0]).toHaveLength(1)
    expect(typeof vi.mocked(console.error).mock.calls[0][0]).toBe('string')
  })

  it('preserves known errno values and suppresses re-reporting wrapped causes', () => {
    const native = new Error('EACCES')
    diagnosticError('test.root', 'Allow access before retrying.', native)
    diagnosticError('test.wrapper', 'Stop.', new Error('Untrusted wrapper', { cause: native }))
    expect(diagnosticSnapshot().entries).toHaveLength(1)
    expect(diagnosticSnapshot().entries[0].errors?.[0]).toMatchObject({ code: 'EACCES', reason: 'access-denied' })
  })

  it('bounds cyclic causes and redacts thrown values without calling toString', () => {
    const cyclic = new Error('private message')
    cyclic.cause = cyclic
    diagnosticError('test.cycle', 'Stop.', cyclic)
    diagnosticError('test.object', 'Stop.', { toString() { throw new Error('Do not inspect') }, privateKey: 'secret' })
    expect(diagnosticSnapshot().entries[0].errors).toHaveLength(1)
    expect(diagnosticSnapshot().entries[1].errors?.[0].reason).toBe('thrown-value-redacted')
    expect(JSON.stringify(diagnosticSnapshot())).not.toMatch(/private|secret/)
  })

  it('keeps only 500 immutable snapshots and exposes the dropped-event count', () => {
    setDiagnosticsEnabled(true)
    clearDiagnostics()
    const context = { bytes: 5 }
    for (let index = 0; index < 510; index++) trace('test.progress', { ...context, index })
    context.bytes = 99
    const snapshot = diagnosticSnapshot()
    expect(snapshot.entries).toHaveLength(500)
    expect(snapshot.dropped).toBe(10)
    expect(snapshot.entries[0].context).toEqual({ bytes: 5, index: 10 })
    snapshot.entries[0].context.bytes = 101
    expect(diagnosticSnapshot().entries[0].context.bytes).toBe(5)
    clearDiagnostics()
    expect(diagnosticSnapshot().entries).toEqual([])
    expect(diagnosticSnapshot().dropped).toBe(0)
  })
})
