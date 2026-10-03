# Supplemental dispatch admission for #229

Assigned branch: `perf229/fix-background-admission`; base:
`0ce681ea891e685d529bde2b4d8e1993a63843e4`. The complete
`review-background-postfix.json` and `.md` were read before source edits;
`background-postfix-review-state.json` recorded the reviewer done. R2-054 was
the only concrete residual. R1-136 is independently resolved at the base and
its archive/geometry implementation is unchanged.

## Implementation and caller audit

- The UI loader passes its existing claim into PNG and standard-image loaders.
  The scan client waits for admission at ready immediately before transfer.
  Duplicate ready messages cannot duplicate input dispatch. Abort or generic
  admission rejection terminates the idle worker and rejects. Startup failure
  while admission is pending cannot swallow the later rejection.
- PNG8 checks after content sniffing before `createImageBitmap`; PNG16 checks
  after the lazy client import and at worker readiness. UPNG retries check
  again after their own lazy import. TIFF and iPhone-DNG scan paths carry the
  same gate into the scan client and their UTIF retry. A rejected iPhone-DNG
  admission cannot become an automatic LibRaw retry.
- Standard bitmaps check after their header read. The `<img>` retry checks
  after its factory, handles cancellation and revokes its URL exactly once.
  Late bitmaps close before canvas readback. HEIF carries the signal and gate
  through its import, worker factory, library-ready handshake and file read.
  The served worker announces initialized WASM before the page reads and
  transfers the input; no lazy factory/read remains inside dispatch. Ordinary JPEG/HEIF remain excluded
  from decode-ahead offers; supported names with those actual containers still
  use the guarded fallback paths.
- RAW retains its metadata-size admission and extracted-JPEG gates. It also
  rechecks after decode-slot acquisition, threaded readiness, native-to-WASM
  retry factory/open waits and post-decode readiness or page retry. These
  adapters are tested with simulated tiny inputs; no native decoder was run.
- Scan callback arguments remain `{ kind: 'scan' }`; RAW metadata sizes and
  embedded-JPEG extracted dimensions retain their contracts. Every gate uses
  the existing claim, releasing superseded prepare handles once. Every prepare
  exit cancels any late gate left waiting by worker failure before releasing
  its final handle. Ready frames still hand ownership to the held-frame ledger.
- Integration must apply only the assigned base-to-head range after
  background-postfix. Parallel release-preview source `710e56e` was inspected
  read-only: its RAW/JPEG signal chain and PNG post-import abort guard are
  preserved, and standard-loader signal propagation is included here. No other
  branch was replayed or edited.

## Evidence and validation

The negligible 4x4 PNG caller negative control executed the actual batch
prepare, UI loader, PNG loader and scan client at the base. It dispatched with
foreground=1 and reserved=292 (192 prepare + 100 foreground), failing the zero
dispatch assertion. `background-admission-tiny-before-png.log` retains it.
The initial after control waited with zero starts and dispatched at foreground=0
with a counted 192-byte prepare; it preserved sample `0x1234`, released the
worker and claim, and disposed the held base. Log:
`background-admission-tiny-after-png.log`.

New real-caller tests use 4x4 encoded PNG16/TIFF16, simulated browser transports
and actual codec retries. They cover factory/readiness races, counted prepares,
duplicate ready, low sample bits, abort before readiness/at the gate/after
transfer, decode errors, refusal, generic rejection and held-frame disposal.
RAW tests exercise actual orchestration and post-decode transport, plus the
threaded and native retry adapters. Existing reservation assertions are
strengthened to require both demosaic and post-decode gates with identical
metadata arguments; the prior single-gate count no longer describes two real
dispatch boundaries.

Initial expanded-test runs exposed test-fixture issues (pako has no default
export, wrapping UPNG.decode must preserve its static helpers, native adapters
return promises, and the before snapshot needs a larger git-show output buffer),
then a misplaced PNG error guard in the first patch and a missing pre-admission
abort check after the UPNG import. All were corrected, with attempt logs retained.
The next locked invocations were refused by the shared resource guard with
exit 78 after free disk dipped below 3 GiB. The parent later cleared the guard.
No pause file was changed by this lane.

Current negligible caller proofs pass in under a second on 4x4 fixtures:
`background-admission-tiny-loaders-after-5.log`,
`background-admission-tiny-raw-after-2.log`,
`background-admission-tiny-imports-after-2.log` and
`background-admission-tiny-heif-protocol.log`. These exercise actual caller and
served-worker code with simulated codec/IPC transports, not a real RAW heap.
The additional old-head RAW-slot control fails with foreground=1 at actual
demosaic and post-decode dispatch; see
`background-admission-tiny-before-raw-slot-2.log`.

The fresh locked targeted suite passed all 22 files, recorded in
`background-admission-targeted.json`. The first targeted attempt passed 15 files
then exposed a new DOMException-global dependency in the export VM harness.
Using AbortController's own default abort reason preserves withdrawal semantics
and removes that dependency without changing any assertion. The full targeted
retry passed, including exact geometry archive/history precision, brush parking,
RAW reservation and cancellation, real scan-worker transfer and export ownership.
Earlier logs/JSON remain in `background-admission-targeted-attempt-1/`.

All suites, builds and browser checks use the shared test lock. Browsers
also use `LOCK_OWNER=codex-background-admission PORT=5561 CDP_PORT=9561`, the
workspace browser lock and `caffeinate -di`. Final pinned-head full `npm test`
and png16, batch-pipeline and memory-budget browser results, commands, exit
codes, timing and source-clean/head-stable checks are recorded in
`background-admission-validation.json`; `background-admission-result.json`
records final disposition. The smokes use at most 4.08 MP generated frames
(PNG16 stress is 3.84 MP), not real 60 MP RAWs. No assertion is relaxed to hide
a failure. R1-136 source is unchanged; its geometry/history precision tests
remain part of the fresh full suite.

## Limits

No real 60 MP decode/benchmark, native/WebKit measurement, dependency install,
cache deletion, external message, push/PR/GitHub write, deployment, agent spawn
or other worktree edit. Empirical native, 60 MP throughput/peak and
budget-plus-one-frame targets remain unmeasured. The parent independently
reviews and integrates the explicit range after all fresh checks pass.
