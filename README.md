# WebUSB Transfer Lab

A static Android file-transfer lab for Windows Chromium performance comparisons.
Connect a phone using **ADB directly over WebUSB**, send generated binary files,
read the actual files back, and verify byte counts and SHA-256.

Public site: **https://luhuangmsft.github.io/webusb-transfer-lab/**

## Phone and laptop setup

1. Use a desktop Chromium-based browser with WebUSB support.
2. Connect the Android phone directly to the laptop with a data-capable USB
   cable. Unlock it, enable Developer options, and enable USB debugging.
3. On Windows, install the phone manufacturer's supported ADB driver so the
   ADB interface uses WinUSB. On an ARM64 laptop use an ARM64-compatible driver.
   Do not replace drivers for unrelated composite-device interfaces.
4. Close other clients that claim ADB: Android Studio, native ADB sessions,
   other WebUSB sites, and browser USB discovery. In `chrome://inspect`, disable
   **Discover USB devices**. A native ADB server may need to be stopped manually
   with `adb kill-server` if you use one. The site cannot do this for you.
5. Open the site over HTTPS, click **Connect**, choose the phone, and approve
   the USB-debugging prompt on its screen.
6. Configure a small workload first. Run it and require successful readback
   verification and cleanup before using a larger workload for profiling.

No Android app, root privileges, native ADB executable, network bridge, or access
to your personal files is needed. USB file-transfer/MTP mode is not the protocol
used here. This site needs a working USB-debugging/ADB interface.
The phone must support ADB `shell_v2` and `stat_v2`, and expose a USB serial number
so leftover cleanup can be restricted to that device.

### Authorization and data

USB debugging grants broad access to the phone's ADB daemon. Authorize only sites
and computers you trust. This application restricts its own operations to unique
test directories under `/data/local/tmp` and does not provide a shell or personal
file browser.

ADB private keys are kept in memory for the page session, not uploaded or saved.
A new page session may require a new authorization prompt. Browser USB device
permissions are separate and can persist; revoke them in the browser's site
settings. On the phone, use **Revoke USB debugging authorizations** when finished
if desired. GitHub project sites on the same `luhuangmsft.github.io` hostname
share a web origin, not independent path-level security boundaries.

The site bundles its code and dependencies. It does not send generated file
contents, keys, device identifiers, or measurements to a server. Configuration,
local cleanup records and reports may be stored in your browser. Reports leave
the browser only when you explicitly export them.

## Workloads

| Setting | Default | Limit |
| --- | --- | --- |
| Files per round | 10 | 100 |
| Bytes per file | 1 MiB | 1 GiB |
| Total file payload per round | 10 MiB | 1 GiB |
| Repetitions | 3 | Positive integer; aggregate totals must be safe |
| Pattern | Per-file round trip | Per-file or batch |

All limits apply together: one 1 GiB file or two 512 MiB files are allowed per
round, but two 1 GiB files exceed the per-round cap. MiB means 1,048,576 bytes;
GiB means 1,073,741,824 bytes. Both are available in the size-unit selector.
Traffic estimates include both upload and download; ADB/USB protocol overhead
is additional.

Generation, readback and SHA-256 hashing still buffer whole files in the
browser. A 1 GiB file can require several GiB of RAM, and memory pressure or
garbage collection can affect profiles. Close unnecessary tabs and use a smaller
file if memory is limited. Phone free-space checks still require the peak
payload plus 64 MiB headroom.

File uploads and downloads time out after 120 seconds without stream progress,
not after 120 seconds of total transfer time. Uploads feed SYNC in its existing
64 KiB packet size, with backpressure; downloads reset the deadline only on
nonempty data. Integrity verification and scoped cleanup are unchanged.

- **Per-file:** generate, upload, read back, verify, delete; then the next file.
  Peak phone payload storage is one file.
- **Batch:** upload every file, then read back, verify and delete each file.
  Peak phone payload storage is the complete batch.

Operations are sequential. Reuse the same seed and settings for identical
payloads in A/B runs. File identity is part of the deterministic content. A small
capability probe and a phone free-space check precede the workload; the probe is
not a measured file.

The app fails rather than silently switching paths or simulating a transfer when
`/data/local/tmp` is unavailable. It stops on the first failure or mismatch and
reports partial results. Cleanup removes only the exact test files created by
that run. If the phone disconnects, reconnect the same device and use the cleanup
control. Do not interpret a failed cleanup as a fully completed run.

**Stop** immediately stops scheduling new work and invalidates an interrupted
connection when needed. A stuck OS USB request may need the cable disconnected;
the UI cannot force the Windows kernel to complete it. Reconnect before another
run if prompted.

### Remembered configuration

All **Configure** fields are saved locally as you edit: file count, rounds,
file-size value and unit, transfer pattern, seed, tags, and notes. Refreshing or
reopening the site in the same browser profile restores them, even before you
have connected a phone or run a test. The initial defaults apply when no saved
configuration exists. Quick-start presets are saved too; as before, they change
the file count, size/unit and rounds without clearing the pattern, seed, tags or
notes.

Unfinished edits, including blank or out-of-range numbers, survive refresh and
must pass the normal workload validation before a run can start. Unsupported
or damaged saved data produces a visible warning and leaves the defaults in
place. If browser storage is blocked or full, a warning explains that current
edits could not be saved; they remain usable on the page.

These preferences use `localStorage` under `webusb-transfer-lab.settings.v1`,
separately from reports and cleanup ownership. They stay in this browser
profile, are not uploaded or logged, and do not sync to another browser or
computer. Restoring configuration never reconnects a phone, resumes a run, or
enables diagnostic tracing. To reset just these preferences without deleting
reports or cleanup records, remove that key in DevTools Application > Local
Storage and refresh.

### Optional tags and notes

**Tags** is a freeform text field (up to 512 characters), for example
`morning run, cable A, trial 2`. Commas are just a convention: the app saves the
text as entered, without predefined categories or special syntax. Leave tags
and notes blank to run a test without any bookkeeping.

Tags and notes are saved with each report in this browser's IndexedDB and
included in JSON/CSV exports. They never change transfers, generated bytes, or
verification, and differences in them do not block report comparisons. Review
the actual test conditions yourself. They are excluded from diagnostic logs.

Reports without tags are identified by their run ID and start time. Older saved
or imported reports keep their original build labels and architecture metadata;
these remain readable and exportable, but are no longer comparison gates.
New reports do not assign a build label or architecture. CSV retains the legacy
columns (blank for new runs) and includes a separate `tags` column.

## Profiling and A/B comparisons

1. Keep the laptop, phone, cable, port, phone USB/tethering configuration,
   power conditions and browser/site version constant. Avoid unrelated phone
   activity; record any thermal or battery differences in notes.
2. If comparing browser builds, close all instances of the previous build before
   switching installer. You can record build identity or architecture in your
   optional tags. Identical browser version numbers do not identify a patch.
3. Connect and authorize before starting a trace. Use a small unprofiled check
   first. The initial connection/probe can warm phone caches.
4. Start Windows Performance Recorder or the chosen browser tracing tool
   manually. Keep its configuration consistent across runs.
5. Run the same workload and seed. Stop the trace and export the site's
   JSON report. Save the Windows trace with that report's run ID.
6. Repeat for the other build, preferably alternating A/B order. Retain the
   matching symbols for each browser binary when resolving Windows stacks.
7. Import the two reports locally for comparisons. Investigate incompatible
   settings or failed runs before treating their numbers as an A/B result.

Upload and download timers span complete device-storage operations, including
their safety checks and ownership bookkeeping, SYNC write acknowledgement and
read-through-EOF respectively. They are not bare SYNC-call durations. Preparation,
SHA-256 verification, post-upload metadata checks, setup and cleanup are measured
separately, outside those transfer intervals. Failed transfers may contribute
elapsed time while partial bytes cannot be counted reliably; partial-run
throughput is not a complete measurement. User Timing markers, run ID, UTC timestamps and
`performance.timeOrigin` help correlate phases with a browser recording.

These measurements still include ADB protocol work, JavaScript scheduling,
stream handling, buffer copies and phone filesystem behavior. They are **not
individual WinUSB request latencies**, nor proof of durable flash writes.
Readback may come from the phone's filesystem cache. Only the Windows profiles
can attribute a change to the Chromium USB-completion path. The website cannot
start WPR or capture privileged OS stacks.

Throughput is total transferred bytes divided by total transfer duration, not an
unweighted average of file rates. Median/p95 summaries include sample counts.
Short runs and background activity can produce noisy comparisons.

## Diagnosing problems in DevTools

Errors always produce a contextual **`[WebUSB Lab]`** Console entry, including
the operation, timestamps, run/file identifiers when available, safe error types
and codes, and bounded application source locations. Related error causes are
preserved internally and summarized without logging arbitrary error messages or
raw exception objects. The on-page error still supplies the user-facing detail.

For a reproduction, enable **Diagnostics & console logging > Enable diagnostic
tracing** before connecting, or open the site with `?diagnostics=1`. From the
DevTools Console you can enable it with a reload:

```js
location.search = '?diagnostics=1'
```

Select **Verbose** in the Console's level filter, filter by **`[WebUSB Lab]`**,
and enable **Preserve log** before reproducing. Tracing covers device selection,
interface opening, phone authorization, SYNC, storage probes, file operations,
phase durations, cancellation, timeouts, and teardown. A metadata wait ending
with `status: "missing"` is an expected `ENOENT` probe, not itself a failure.
`run.phase.start` without its corresponding end helps identify stuck work.

After stopping, **Download diagnostic log** saves the latest 500 events as local
JSON, with the deployed commit and a dropped-event count. It is separate from
the performance report. History is memory-only, disappears on reload, and never
goes to a server. **Clear diagnostic log** clears that history, not the Console.
No generated bytes, authentication keys, USB serials, device names, user-entered
seed/tags/notes, shell output, or arbitrary error messages are included.
This deliberate redaction can leave unknown failures classified as
`message-redacted`; operation, error type/codes, and source locations remain.
Browser-generated Console messages are outside the app's diagnostic filter.

**Turn tracing off before profiling.** It affects scheduling and measured
durations. Diagnostic runs carry `environment.diagnosticsEnabled: true` in JSON
and `diagnostics_enabled` in CSV, and are excluded from A/B performance
comparisons even if both runs have tracing on. Controls are locked during active
work. Closing DevTools also avoids its own profiling overhead.

User Timing marks are streamed into browser recordings and cleared to keep
long runs bounded; `performance.getEntriesByType('measure')` is not a retained
history. Use the diagnostic log for a readable phase timeline.

## Development

Use Node.js 24 and npm:

```powershell
npm ci
npm run dev
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

The production site is built in `dist`. Browser integration tests additionally
use a development-only harness with simulated device storage; the harness is
not included in the production build. The Vite base path is
`/webusb-transfer-lab/`, including worker and asset URLs. The deployed commit is
shown on the page. No service worker is installed.

Unit and browser tests use fake transports where hardware is needed. They test
validation, ordering, corruption, error handling and UI behavior, **not actual
USB transfers**. Real-phone acceptance on both patterns, unplug/reconnect and
cleanup must still be performed on the hardware used for profiling.

## Hosting

GitHub Actions validates pushes and pull requests. Only a successful main-branch
build deploys through the official Pages artifact/deployment actions. Repository
Settings > Pages must use **GitHub Actions** as its source. No secrets, test
payloads or recorded performance profiles belong in this repository.

Dependencies are locked. Review updates before changing the versions used in
matched profiling experiments.
