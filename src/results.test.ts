import { describe, expect, it } from 'vitest'
import {
  aggregateResults, compareReports, csvCell, MAX_IMPORT_BYTES, MAX_IMPORT_FILES,
  nearestRank, parseReportJson, reportLabel, reportToCsv, validateReport,
} from './results'
import type { FileResult, RunReport } from './types'

function fixture(): RunReport {
  const id = 'c793f117-4316-4280-841c-4239d8a29616'
  const files: FileResult[] = []
  for (let round = 1; round <= 2; round++) {
    for (let index = 1; index <= 2; index++) {
      files.push({
        runId: id, round, index, name: `r${String(round).padStart(6, '0')}-f${String(index).padStart(3, '0')}.bin`,
        bytes: 1048576,
        expectedSha256: String(index).repeat(64), actualSha256: String(index).repeat(64),
        uploadedBytes: 1048576, downloadedBytes: 1048576,
        prepareMs: 4, uploadMs: 10 * round * index, downloadMs: 20 * round * index,
        verifyMs: 3, cleanupMs: 1, passed: true,
      })
    }
  }
  return {
    schemaVersion: 1,
    run: {
      schemaVersion: 1, id,
      settings: {
        fileCount: 2, fileSizeBytes: 1048576, rounds: 2, pattern: 'round-trip',
        seed: 'repeatable', buildLabel: 'baseline', architecture: 'arm64', notes: '',
      },
      device: { model: 'Test phone', manufacturer: 'Test OEM', features: ['shell_v2', 'stat_v2'], maxPayloadSize: 1048576 },
      environment: {
        siteCommit: 'abc123', siteVersion: '0.1.0', browser: 'Chromium 157.0.8081.0',
        dependencies: { '@yume-chan/adb': '2.6.4', '@yume-chan/adb-daemon-webusb': '2.3.2', '@yume-chan/stream-extra': '2.6.1' },
      },
      startedAt: '2026-10-11T01:00:00.000Z', completedAt: '2026-10-11T01:00:01.000Z',
      timeOrigin: 1791680000000, status: 'completed', completedFiles: 4, expectedFiles: 4,
      totals: {
        uploadedBytes: 4194304, downloadedBytes: 4194304,
        prepareMs: 16, uploadMs: 90, downloadMs: 180, verifyMs: 12, cleanupMs: 6, setupMs: 10, wallMs: 1000,
      },
      leftovers: [],
    },
    files,
  }
}

function candidate(): RunReport {
  const result = fixture()
  result.run.id = 'baf6f36f-4e30-4f43-b755-e4471f2352ad'
  result.run.settings.buildLabel = 'with-fix'
  for (const file of result.files) {
    file.runId = result.run.id
    file.uploadMs /= 2
    file.downloadMs /= 2
  }
  result.run.totals.uploadMs /= 2
  result.run.totals.downloadMs /= 2
  result.run.totals.wallMs = 800
  return result
}

function partial(): RunReport {
  const result = fixture()
  result.run.status = 'failed'
  result.run.error = 'Injected failed download'
  result.run.completedFiles = 0
  result.files = [{
    ...result.files[0]!,
    passed: false, actualSha256: '', downloadedBytes: 0, downloadMs: 9,
    verifyMs: 0, cleanupMs: 0, error: result.run.error,
  }]
  result.run.totals = {
    uploadedBytes: 1048576, downloadedBytes: 0, prepareMs: 4, uploadMs: 10, downloadMs: 9,
    verifyMs: 0, cleanupMs: 2, setupMs: 10, wallMs: 100,
  }
  return result
}

describe('strict, privacy-bounded report import', () => {
  it('round trips tagged and untagged reports without fabricating legacy labels', () => {
    for (const tags of ['', 'trial 2, cable A', '試験, تجربة']) {
      const report = fixture()
      delete report.run.settings.buildLabel
      delete report.run.settings.architecture
      report.run.settings.tags = tags
      const parsed = parseReportJson(JSON.stringify(report))
      expect(parsed).toEqual(report)
      expect(parsed.run.settings).not.toHaveProperty('buildLabel')
      expect(parsed.run.settings).not.toHaveProperty('architecture')
      expect(reportLabel(parsed.run)).toBe(tags || `Untagged run ${report.run.id.slice(0, 8)}`)
    }
  })

  it('keeps original metadata intact when reading older reports', () => {
    const report = fixture()
    expect(report.run.settings).not.toHaveProperty('tags')
    const parsed = parseReportJson(JSON.stringify(report))
    expect(parsed).toEqual(report)
    expect(reportLabel(parsed.run)).toBe('baseline · arm64')
    expect(reportToCsv(parsed)).toContain('"baseline","arm64"')
  })

  it('rejects malformed or oversized optional tags', () => {
    for (const tags of [null, [], 12, 'x'.repeat(513), 'bad\u0000tag']) {
      const report = fixture()
      expect(() => validateReport({ ...report, run: { ...report.run, settings: { ...report.run.settings, tags } } })).toThrow()
    }
  })

  it('accepts legacy reports and validates optional diagnostic metadata', () => {
    expect(validateReport(fixture()).run.environment.diagnosticsEnabled).toBeUndefined()
    const report = fixture()
    report.run.environment.diagnosticsEnabled = true
    expect(validateReport(report).run.environment.diagnosticsEnabled).toBe(true)
    expect(reportToCsv(report).split('\r\n')[1]).toMatch(/,"true"$/)
    expect(() => validateReport({
      ...report, run: { ...report.run, environment: { ...report.run.environment, diagnosticsEnabled: 'yes' } },
    })).toThrow('diagnosticsEnabled')
    expect(compareReports(report, candidate())).toMatchObject({ compatible: false, uploadTimeDeltaPercent: null })
    const second = candidate()
    second.run.environment.diagnosticsEnabled = true
    expect(compareReports(report, second).differences.join(' ')).toContain('diagnostic tracing')
  })

  it('round trips a valid versioned report and reconstructs a separate typed object', () => {
    const source = fixture()
    const parsed = parseReportJson(JSON.stringify(source))
    expect(parsed).toEqual(source)
    expect(parsed).not.toBe(source)
    expect(parsed.run.settings).not.toBe(source.run.settings)
  })

  it('preserves 1 GiB files and multi-GiB totals in JSON and CSV', () => {
    const report = fixture()
    report.run.settings.fileCount = 1
    report.run.settings.fileSizeBytes = 1024 ** 3
    report.files = report.files.filter((file) => file.index === 1).map((file) => ({
      ...file, bytes: 1024 ** 3, uploadedBytes: 1024 ** 3, downloadedBytes: 1024 ** 3,
    }))
    report.run.expectedFiles = report.run.completedFiles = 2
    Object.assign(report.run.totals, {
      uploadedBytes: 2 * 1024 ** 3, downloadedBytes: 2 * 1024 ** 3,
      prepareMs: 8, uploadMs: 30, downloadMs: 60, verifyMs: 6, cleanupMs: 4,
    })
    const parsed = parseReportJson(JSON.stringify(report))
    expect(parsed).toEqual(report)
    expect(reportToCsv(parsed)).toContain('"1073741824"')
    expect(reportToCsv(parsed)).toContain('"2147483648"')
    report.run.settings.fileSizeBytes++
    expect(() => validateReport(report)).toThrow('File size')
  })

  it('accepts failed partial evidence without claiming it completed', () => {
    expect(validateReport(partial()).run.status).toBe('failed')
  })

  it('rejects malformed JSON and unsupported schema versions', () => {
    expect(() => parseReportJson('{ nope')).toThrow('not valid JSON')
    expect(() => validateReport({ ...fixture(), schemaVersion: 2 })).toThrow('unsupported schema')
    const report = fixture()
    expect(() => validateReport({ ...report, run: { ...report.run, schemaVersion: 2 } })).toThrow('unsupported run schema')
  })

  it.each([null, [], true, 'report', 12])('rejects non-object reports: %j', (value) => {
    expect(() => validateReport(value)).toThrow('report must be an object')
  })

  it('rejects missing and unknown fields, including serials, keys and payloads', () => {
    const report = fixture()
    expect(() => validateReport({ run: report.run, files: report.files })).toThrow('missing schemaVersion')
    expect(() => validateReport({ ...report, privateKey: 'do not export' })).toThrow('unexpected field')
    expect(() => validateReport({ ...report, run: { ...report.run, device: { ...report.run.device, serialNumber: 'private' } } })).toThrow('unexpected field')
    expect(() => validateReport({ ...report, files: [{ ...report.files[0], payload: [1, 2] }] })).toThrow('unexpected field')
    expect(() => parseReportJson('{"schemaVersion":1,"run":{},"files":[],"__proto__":{}}')).toThrow('unexpected field')
  })

  it.each([NaN, Infinity, -Infinity, -1, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe timing values: %s', (value) => {
    const report = fixture()
    report.files[0]!.uploadMs = value
    expect(() => validateReport(report)).toThrow('finite nonnegative')
    const summary = fixture()
    summary.run.totals.wallMs = value
    expect(() => validateReport(summary)).toThrow('finite nonnegative')
  })

  it('rejects unsafe settings and byte arithmetic', () => {
    const report = fixture()
    report.run.settings.fileCount = 101
    expect(() => validateReport(report)).toThrow('File count')
    report.run.settings.fileCount = 65
    report.run.settings.fileSizeBytes = 16 * 1024 * 1024
    expect(() => validateReport(report)).toThrow('1 GiB')
    report.run.settings.fileCount = 1
    report.run.settings.fileSizeBytes = 1
    report.run.settings.rounds = Number.MAX_SAFE_INTEGER
    expect(() => validateReport(report)).toThrow('safe integers')
    const fractional = fixture()
    fractional.files[0]!.uploadedBytes = 0.5
    expect(() => validateReport(fractional)).toThrow('safe integer')
  })

  it('rejects mismatched run identity, index, round, filename and payload size', () => {
    const changes: Array<Partial<FileResult>> = [
      { runId: 'different-run' }, { round: 0 }, { round: 3 }, { index: 0 }, { index: 3 },
      { name: '../personal.txt' }, { name: 'r000002-f001.bin' }, { bytes: 7 },
    ]
    for (const change of changes) {
      const report = fixture()
      Object.assign(report.files[0]!, change)
      expect(() => validateReport(report)).toThrow()
    }
  })

  it('rejects duplicate records and missing completed evidence', () => {
    const report = fixture()
    report.files[1] = { ...report.files[0]! }
    expect(() => validateReport(report)).toThrow('duplicate file result')
    const missing = fixture()
    missing.files.pop()
    expect(() => validateReport(missing)).toThrow('file counts')
  })

  it('rejects false integrity claims and inconsistent repeated hashes', () => {
    const report = fixture()
    report.files[0]!.actualSha256 = 'f'.repeat(64)
    expect(() => validateReport(report)).toThrow('integrity evidence')
    const repeated = fixture()
    repeated.files[2]!.actualSha256 = 'f'.repeat(64)
    repeated.files[2]!.expectedSha256 = 'f'.repeat(64)
    expect(() => validateReport(repeated)).toThrow('repeated rounds')
    const missingHash = fixture()
    missingHash.files[0]!.actualSha256 = ''
    missingHash.files[0]!.expectedSha256 = ''
    expect(() => validateReport(missingHash)).toThrow('integrity evidence')
  })

  it('requires exact byte sums and matching timing sums', () => {
    for (const field of ['uploadedBytes', 'downloadedBytes', 'prepareMs', 'uploadMs', 'downloadMs', 'verifyMs'] as const) {
      const report = fixture()
      report.run.totals[field]++
      expect(() => validateReport(report)).toThrow(`summary ${field}`)
    }
    const report = fixture()
    report.run.totals.cleanupMs = 0
    expect(() => validateReport(report)).toThrow('cleanup time')
  })

  it('rejects completed reports with pending cleanup or errors', () => {
    const report = fixture()
    report.run.leftovers.push('r000001-f001.bin')
    expect(() => validateReport(report)).toThrow('completed report')
    report.run.leftovers = []
    report.run.error = 'cleanup failed'
    expect(() => validateReport(report)).toThrow('completed report')
  })

  it('rejects malformed timestamps, status, protocol metadata, and control text', () => {
    const report = fixture()
    report.run.completedAt = 'yesterday'
    expect(() => validateReport(report)).toThrow('timestamp')
    report.run.completedAt = '2027-02-30T01:00:00.000Z'
    expect(() => validateReport(report)).toThrow('timestamp')
    report.run.completedAt = '2026-10-10T01:00:00.000Z'
    expect(() => validateReport(report)).toThrow('predates')
    expect(() => validateReport({ ...fixture(), run: { ...fixture().run, status: 'success' } })).toThrow('status')
    const device = fixture()
    device.run.device.features = ['shell_v2', 'shell_v2']
    expect(() => validateReport(device)).toThrow('duplicate protocol')
    const text = fixture()
    text.run.settings.notes = 'bad\u0000value'
    expect(() => validateReport(text)).toThrow('control')
  })

  it('caps serialized import bytes and record counts before processing records', () => {
    expect(() => parseReportJson(' '.repeat(MAX_IMPORT_BYTES + 1))).toThrow('16 MiB')
    expect(() => parseReportJson('é'.repeat(MAX_IMPORT_BYTES / 2 + 1))).toThrow('16 MiB')
    expect(() => validateReport({ ...fixture(), files: new Array(MAX_IMPORT_FILES + 1).fill(null) })).toThrow('20,000')
  })
})

describe('transfer statistics', () => {
  it('uses nearest rank for median and p95, including even and singleton samples', () => {
    expect(nearestRank([30, 10, 40, 20], 0.5)).toBe(20)
    expect(nearestRank([30, 10, 40, 20], 0.95)).toBe(40)
    expect(nearestRank(Array.from({ length: 20 }, (_, index) => index + 1), 0.95)).toBe(19)
    expect(nearestRank([7], 0.5)).toBe(7)
    expect(nearestRank([], 0.5)).toBeNull()
    expect(() => nearestRank([1], 0)).toThrow()
    expect(() => nearestRank([NaN], 0.95)).toThrow()
  })

  it('calculates total bytes / total duration rather than averaging per-file rates', () => {
    const stats = aggregateResults(fixture().files)
    expect(stats.recorded).toBe(4)
    expect(stats.passed).toBe(4)
    expect(stats.failed).toBe(0)
    expect(stats.upload.count).toBe(4)
    expect(stats.upload.totalMs).toBe(90)
    expect(stats.upload.mibPerSecond).toBeCloseTo(4 / 0.09)
    expect(stats.upload.medianMs).toBe(20)
    expect(stats.upload.p95Ms).toBe(40)
    expect(stats.download.mibPerSecond).toBeCloseTo(4 / 0.18)
  })

  it('includes elapsed failed attempts but excludes unattempted zero-time operations', () => {
    const stats = aggregateResults(partial().files)
    expect(stats.failed).toBe(1)
    expect(stats.download.count).toBe(1)
    expect(stats.download.bytes).toBe(0)
    expect(stats.download.totalMs).toBe(9)
    expect(stats.download.mibPerSecond).toBe(0)
    const untouched = { ...fixture().files[0]!, uploadMs: 0, uploadedBytes: 0, downloadMs: 0, downloadedBytes: 0, passed: false }
    expect(aggregateResults([untouched]).upload.count).toBe(0)
    expect(aggregateResults([untouched]).download.medianMs).toBeNull()
  })

  it('never emits an infinite throughput for a zero-duration timer', () => {
    const file = { ...fixture().files[0]!, uploadMs: 0, downloadMs: 0 }
    expect(aggregateResults([file]).upload.mibPerSecond).toBeNull()
    expect(aggregateResults([file]).upload.medianMs).toBe(0)
    expect(aggregateResults([]).upload.count).toBe(0)
  })
})

describe('safe flat CSV exports', () => {
  it.each(['=SUM(1,2)', '+cmd', '-1+2', '@SUM(A1)', '   =1', '\tvalue', '\rvalue', '\nvalue', '\uFEFF=1'])('neutralizes spreadsheet text: %j', (value) => {
    expect(csvCell(value)).toBe(`"'${value.replaceAll('"', '""')}"`)
  })

  it('quotes delimiters, quotes, newlines and numeric data without altering measurement signs', () => {
    expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"')
    expect(csvCell(-5)).toBe('"-5"')
    expect(csvCell(false)).toBe('"false"')
  })

  it('includes one file row per record, round sums, and a run row', () => {
    const csv = reportToCsv(fixture())
    const lines = csv.trimEnd().split('\r\n')
    expect(lines).toHaveLength(1 + 4 + 2 + 1)
    expect(lines.filter((line) => line.startsWith('"file"'))).toHaveLength(4)
    expect(lines.filter((line) => line.startsWith('"round"'))).toHaveLength(2)
    expect(lines.at(-1)).toContain('"run"')
    expect(lines[0]).toContain('"recorded_files"')
    expect(lines[0]).toContain('"diagnostics_enabled"')
    expect(lines[0]).toContain('"tags"')
    expect(lines.every((line) => line.split(',').length === 46)).toBe(true)
  })

  it('protects tags, legacy labels and notes and has no payload, serial or private-key columns', () => {
    const report = fixture()
    report.run.settings.buildLabel = '=HYPERLINK("bad")'
    report.run.settings.notes = '@formula'
    report.run.settings.tags = '+SUM(1,2), "trial"'
    const csv = reportToCsv(report)
    expect(csv).toContain('"\'=HYPERLINK(""bad"")"')
    expect(csv).toContain('"\'@formula"')
    expect(csv).toContain(`"'+SUM(1,2), ""trial"""`)
    expect(csv.split('\r\n')[0]).not.toMatch(/private|serial|payload_contents/iu)
  })

  it('retains a partial failure explicitly in the export', () => {
    const csv = reportToCsv(partial())
    expect(csv).toContain('"failed"')
    expect(csv).toContain('"Injected failed download"')
    expect(csv).toContain('"0","1"')
  })
})

describe('conservative two-run comparison', () => {
  it('accepts different manual build labels with exactly matching environment and workload', () => {
    const result = compareReports(fixture(), candidate())
    expect(result.compatible).toBe(true)
    expect(result.uploadTimeDeltaPercent).toBe(-50)
    expect(result.downloadTimeDeltaPercent).toBe(-50)
    expect(result.wallTimeDeltaPercent).toBe(-20)
    expect(result.warnings.join(' ')).toContain('not a claim of statistical significance')
  })

  it('ignores all bookkeeping, including different legacy architecture values', () => {
    const first = fixture()
    const second = candidate()
    first.run.settings.tags = 'morning run, trial 1'
    second.run.settings.tags = 'afternoon run, trial 2'
    second.run.settings.notes = 'different wording'
    second.run.settings.architecture = 'x64'
    expect(compareReports(first, second)).toMatchObject({ compatible: true, uploadTimeDeltaPercent: -50 })
    delete first.run.settings.buildLabel
    delete first.run.settings.architecture
    first.run.settings.tags = ''
    expect(compareReports(first, second).compatible).toBe(true)
  })

  it('accepts reordered protocol capabilities without assuming physical identity', () => {
    const second = candidate()
    second.run.device.features.reverse()
    const result = compareReports(fixture(), second)
    expect(result.compatible).toBe(true)
    expect(result.warnings.join(' ')).toContain('same physical phone')
  })

  it('flags partial reports and suppresses all deltas', () => {
    const result = compareReports(partial(), candidate())
    expect(result.compatible).toBe(false)
    expect(result.differences.join(' ')).toContain('partial')
    expect(result.uploadTimeDeltaPercent).toBeNull()
    expect(result.downloadTimeDeltaPercent).toBeNull()
  })

  it('rejects comparing a run to itself', () => {
    expect(compareReports(fixture(), fixture()).differences).toContain('The same run was selected twice.')
  })

  it('flags seed, pattern, device, site, dependency and browser differences', () => {
    const mutations: Array<(report: RunReport) => void> = [
      (report) => { report.run.settings.seed = 'other seed' },
      (report) => { report.run.settings.pattern = 'batch' },
      (report) => { report.run.device.model = 'Different phone' },
      (report) => { report.run.device.manufacturer = 'Different OEM' },
      (report) => { report.run.device.maxPayloadSize = 65536 },
      (report) => { report.run.device.features = ['other'] },
      (report) => { report.run.environment.siteCommit = 'def456' },
      (report) => { report.run.environment.siteVersion = '0.2.0' },
      (report) => { report.run.environment.browser = 'Other Chromium' },
      (report) => { report.run.environment.dependencies['@yume-chan/adb'] = '3.0.0' },
    ]
    for (const mutate of mutations) {
      const second = candidate()
      mutate(second)
      const result = compareReports(fixture(), second)
      expect(result.compatible).toBe(false)
      expect(result.differences.length).toBeGreaterThan(0)
      expect(result.uploadTimeDeltaPercent).toBeNull()
    }
  })

  it('validates both reports before producing a comparison', () => {
    const report = candidate()
    report.files[0]!.passed = false
    expect(() => compareReports(fixture(), report)).toThrow('file counts')
  })

  it('warns about unknown local site revision and never divides by zero', () => {
    const first = fixture()
    const second = candidate()
    first.run.environment.siteCommit = second.run.environment.siteCommit = 'local-development'
    first.run.totals.uploadMs = 0
    first.files.forEach((file) => { file.uploadMs = 0 })
    const result = compareReports(first, second)
    expect(result.compatible).toBe(true)
    expect(result.uploadTimeDeltaPercent).toBeNull()
    expect(result.warnings.join(' ')).toContain('no immutable commit identity')
  })
})
