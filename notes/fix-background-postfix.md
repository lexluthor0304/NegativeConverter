# Background postfix for #229

Assigned branch: `perf229/fix-background-postfix`. Base:
`dd180f10abb3578d342a5a63599ad72bd0a668e4`. Integrate only this base-to-head
range after the original background-followup range. Independent review read
before edits: `/private/tmp/nc229-codex-handoff/review-background-followup.json`
and `.md`, including the exact 4x4 fallback and 2x2 geometry sample repros.
R1-021 was independently resolved at the base and is unchanged here.

## R2-054: embedded-preview dispatch admission

- RAW-open timeout, decode timeout, empty output, garbled output and lost
  post-decode output now carry the caller's gate to the shared JPEG helper.
  Admission uses the extracted preview dimensions after the lazy source read.
  It is checked before worker startup, again at ready/transfer, and before a
  worker-to-browser retry. IIQ's preview shortcut uses the same options.
- An admission failure or abort cannot be mistaken for worker unavailability.
  No extra RAW decode, new accounting constant or statistics request was added.
  Existing reservation-to-held-frame ownership and disposal are preserved.
- `rawFallbackAdmission.test.mjs` executes the real batch prepare, loader,
  RAW fallback orchestration, JPEG extraction, preview helper and (for the
  startup race) scan-worker client. Only codec/transport boundaries are faked.
  Its header is 128 bytes; the simulated preview is 1000x300 (the extractor's
  minimum usable size), and no real RAW is decoded.
- Before: the open-timeout assertion failed with `1 !== 0` while foreground
  owned the budget. Evidence: `background-postfix-tiny-before-fallback-2.log`.
  This negligible before-repro exits before allocating preview pixels and was
  run outside the heavy lock, as permitted. Earlier invalid harness runs
  remain recorded; they are not bug evidence.
- After: all fallback routes, worker startup, browser retry, IIQ, abort during
  read/admission/decode, generic admission rejection, failure and disposal
  assertions pass. Dispatch has zero foreground owners and a counted prepare
  sized to the preview; completion transfers to the held-frame ledger.

## R1-136: exact lazy geometry archives

- Classify a real `__geometryFrame` before looking at `data`. Store the recipe
  graph (base, key, existing pixels), then reconstruct it with the production
  constructor. Preserve descriptor/recipe/pixel aliases, ordinary nonenumerable
  `__image16`, backing-buffer views, the derived-8-bit sampling flag, and the
  WeakMap geometry memos needed by hot Undo/Redo.
- The retained base stays external, each buffer is deduplicated and storage
  remains <=8 MiB per chunk. An unavailable geometry restorer rejects before
  a save can release live history. Partial writes roll back without changing
  the live lazy descriptor or brush data. Existing read failures retain the
  parked record for retry under foreground ownership.
- Before: real `restoreSettings` constructed a lazy geometry frame and archive
  save failed `storage never materializes a lazy frame`, `1 !== 0`.
  Evidence: `background-postfix-before-geometryArchive.log`.
- After: real right-angle and 17.3-degree rotation/mirror/crop construction,
  `renderFrameSample({with16:true})`, lazy/already-materialized aliases, hot
  geometry Undo/Redo, nonenumerable precision, TIFF16 decoded color samples,
  and exact PNG16/TIFF16 encoded bytes pass. The actual park/unpark functions
  also preserve the lazy descriptor, sample precision and 16-bit brush patch
  Undo/Redo, including a partial-write rollback.
- Existing assertions are preserved. Two new fixture assumptions were corrected:
  the established 16-bit RGB export contract has opaque alpha, and Mirror maps
  the crop rectangle. Color sample bits and geometry outputs remain strict.

## Validation and integration evidence

All suites/browser work uses `/private/tmp/nc229-codex-handoff/with-test-lock.sh`;
browsers additionally use `LOCK_OWNER=codex-background-postfix PORT=5521
CDP_PORT=9521`, the workspace browser lock and `caffeinate -di`.

Fourteen relevant Node files passed in `background-postfix-targeted-3.json`.
Final exact-head validation, commands, exit codes and logs are recorded in
`background-postfix-validation.json`; final disposition is
`background-postfix-result.json`, both under the handoff directory. Required
gates are fresh `npm test` and geometry, hidden-job, photo-session, dust-undo,
batch-pipeline and RAW-parity targeted browser checks. The geometry smoke adds
real IndexedDB parking of its existing 4.08 MP genuine 16-bit tilted scan,
requiring lazy semantics, lower retained bytes and exact PNG16/TIFF16 brush
Undo/Redo exports. Original PNG8/TIFF16 brush smoke assertions are retained.

Targeted read-only integration inspection of `perf229/fix-roll-followup`:
`noteDustWorkerMemory` counts page-independent worker copies, excludes a shared
16-bit source already counted by its owner, and the dust resident becomes zero
when disposed (no pending work or mask tag). Parking still unpins/disposes the
worker; restore pins the exact hydrated repair. This patch does not change that
ledger or edit the roll branch. `backingBuffers` continues to avoid lazy getters
and deduplicate the retained base/existing pixels; geometry memos are WeakMaps.

## Limitations

No real 60 MP decode, benchmark, native/WebKit run, cargo/build, install, cache
deletion, remote write or deployment. Small-fixture correctness and retained-byte
reduction do not establish #230 performance, native parity, WebKit footprint,
budget-plus-one-frame peak or throughput targets. Hidden parking and WebKit
decode-ahead keep their existing measurement gates. A renderer kill or failed
cleanup may leave temporary IndexedDB records; history is never cache-evicted.
Only this worktree and its own handoff/workspace notes are changed. New commits
have English conventional messages and issue refs without false attribution.
