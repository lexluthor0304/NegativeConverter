# iOS P2: originals and recovery checkpoints (#298)

This change is stacked on the platform/editor work in #310. It adds recovery
for the current roll through the existing file-input import path. It is not
the completion of P2: native Photos/Files pickers, save/share destinations,
durable export reconciliation and physical-device lifecycle acceptance remain.

## Persistence contract

The mobile shell advertises `sourceRecovery`; desktop/web keep their existing
IndexedDB recipe recovery. Browser `?shell=mobile` cannot enable native storage.
Original bytes are copied sequentially through 1 MiB binary IPC chunks into
`app_data_dir/mobile-recovery-v1/sources`. Filenames are opaque native IDs,
not display names or externally supplied paths. Same-name originals have
separate queue/source identities. Streaming SHA-256 checksums are verified
before an original is restored. No photo is uploaded to a server.

The source file is synced and renamed before its metadata is published.
Only complete sources may enter a checkpoint. The checkpoint wraps an
unchanged `.ncroll.json` v1 project plus ordered source/queue IDs and the
active index. It is written to a sibling temporary file, synced and renamed;
there is no in-place fallback. Two alternating generations retain the
previous valid recipe and all originals it references. Unreadable/future
schemas preserve originals; a valid older generation can recover from a
damaged latest one. These are app-owned files, outside the disposable proxy
cache. There is no new backup exclusion for originals.

Editing schedules a checkpoint after 750 ms of inactivity. The native menu
shows saving/saved/failure; saved is shown only after the native commit is
acknowledged and no later edit is pending. Background/pagehide requests are
best-effort flushes, not the only save trigger. Original copying can still be
in progress while a newly selected photo is being edited: it is recoverable
only when the menu says it is saved. Disk/read/write failures preserve the
previous committed roll and the selected source in the live page. Editing
again retries. A new page lease invalidates writes from a terminated page,
and checkpoint revisions reject stale replacements.

On restart, the empty editor offers **Restore project** in the menu, where it
is reachable before importing photos. Restoration reads original bytes and
the applied recipe on explicit user action, keeping the active frame and
stable identities. It does not automatically decode a potentially unsafe
image every time WebContent restarts. **New session** and **Clear roll** clear
both generations and reclaim the copies; ordinary cleanup retains both
generations. Uncommitted copies and abandoned `.part` files are reclaimed at
the next healthy open. Nothing outside this store is deleted.

## Current limits

- At most 256 source files, 512 MiB per source, 16 MiB of project text, and
  512 MiB of free-space reserve. A copy is refused if free space is unknown.
- The shared loaders currently need compressed `File` objects. Restore checks
  the total first and refuses rolls above **256 MiB** before reading any
  source; the originals remain saved. This is a conservative software limit,
  not a measured iPhone capacity. A lazy native file-backed loader remains
  necessary for larger rolls and the native picker work.
- This persists the portable project's applied settings. It does not persist
  undo/redo stacks, unapplied crop drafts, flat-field gain-map buffers, custom
  in-memory AI models, or an export/share task journal. Existing export
  markers are not an exactly-once external-delivery guarantee.
- Autosave and the existing WebKit reload hook are wired together, but a
  browser reload and host Rust tests do not prove iOS whole-app/WebContent
  termination, locked-device protection, background suspension, iCloud
  downloads or upgrade behavior. Those need physical-device acceptance.

## Verification

`mobileRecovery.test.mjs` covers fresh-controller restart, exact byte/identity
recovery, duplicate names, bounded binary transfers, newer edits superseding
an in-flight save, clear during copying, failed writes/retry, and restore
memory admission. Native tests exercise actual files, restart, incomplete
copies, stale leases/revisions, wrong ranges/traversal, low disk, failed atomic
replacement, torn snapshots, two-generation GC, schema downgrade protection
and same-size corruption detection. They use private temporary directories.

`npm run test:smoke -- --mobile-shell-only` also runs the real editor with a
test-only browser IPC adapter: import two same-name files, edit, navigate,
restore through the empty editor's touch menu, verify edits/identities,
inject a commit failure, retry and clear before another reload. Its storage
adapter is not native-I/O acceptance. The iOS CI still compiles and links the
device and simulator app; Desktop CI retains the full shared regression.

Implementation follows Tauri's [raw request and binary response API](https://v2.tauri.app/develop/calling-rust/).

## Physical-device harness

`scripts/ios-device-validation.py` prepares a debug app and runs it from a
normal macOS terminal with working CoreDevice and signing access. It uses the
existing P0 fixture mechanism and `p0DeviceRecovery.js`; the editor retains its
real Rust IPC bridge. Preparation freezes a static library with
`tauri/custom-protocol`, copies the generated Xcode project into an ignored
output directory and records source/library hashes. Xcode signs and links that
copy for `generic/platform=iOS`, without needing a simulator runtime. The
ordinary web output is rebuilt without test fixtures after preparation.

The local fixture directory needs `negative-sample.jpg`, `negative-sample.heic`,
`_DSC3111.NEF` and `_DSC5290.dng` (24 MP). The original fixture plan is restored,
and the unused 60 MP original is excluded from the generated test assets.

```sh
python3 scripts/ios-device-validation.py prepare --output output/ios-device-validation
python3 -I scripts/ios-device-validation.py run --output output/ios-device-validation --device <UDID>
```

The runner verifies the target bundle, development signature and device entry
in the provisioning profile before installing. An existing installation is
updated and opened normally; automatic fixture imports are skipped. A fresh
installation imports the four samples in one file selection (a subsequent
selection replaces the roll), visits and exports each, saves separate exposure
edits, and waits for a durable checkpoint. The host copies the native store and
exports, verifies source SHA-256 values, checkpoint identities and complete PNG
pixel streams, then sends SIGKILL to the app PID returned by that launch. A new
app process restores through the editor's existing recovery control; the host
checks original/queue identities, applied settings and an additional export.
Existing or interrupted test rolls are preserved rather than cleared.

For a failed fresh-install fixture run, preparation accepts
`--retry-from <previous-output>/run-<timestamp>`. It freezes the previous test
ID, device and installed-app URL into the new manifest. Before installing, the
runner copies both checkpoint generations, originals and Documents to
`retry-backup`, and verifies that every stored original is byte-identical to a
bundled fixture. A fully empty source directory is accepted only when both
checkpoint generations also have no files, source IDs or queue IDs. The
native-page harness also requires the prior incomplete
test marker and matching source metadata. Unknown data stops the retry. The
new file selection replaces only that backed-up fixture roll; native clear and
uninstall are never used. Export validation counts new files separately from
the previous run's exports.

The 2026-10-19 retry passed on a physical **iPhone 15 Pro Max, iOS 27.0
(24A5408d)**. The native/frontend sources match `d967bc37`; the terminal runner
also received the empty-checkpoint backup fix described above. The complete
local JavaScript suite passed **382/382** test files, including the one-selection
fixture regression. The native test imported all four originals, converted
and exported each, saved exposure 17 on the first image and 31 on the second,
and persisted the second image as active.

| Source | Decoder dimensions | Verified PNG dimensions | PNG precision |
| --- | --- | --- | --- |
| JPEG | 1400 x 1284 | 1400 x 1284 | 8-bit |
| HEIC | 1400 x 1284 | 1400 x 1284 | 8-bit |
| NEF | 4000 x 2672 (native LibRaw) | 3625 x 2448 | 8-bit |
| DNG | 6048 x 4024 (native LibRaw) | 4557 x 3025 | 8-bit |

Export dimensions reflect the editor's applied crop. Native LibRaw decode
reported 532 ms for NEF and 1080 ms for DNG on this run; these are observations,
not performance acceptance thresholds. All PNG chunks/CRCs and full decompressed
pixel streams were independently checked. The JPEG and DNG output images were
also visually inspected for coherent, nonblank image content.

After SIGKILL of the verified app PID and launch of a different app process,
the editor restored four originals, their stable queue/source IDs, both exposure
edits and the active image. Source SHA-256 values matched the bundled originals
before and after termination. A fifth fresh export after restoration also
passed PNG verification. Checkpoint revisions advanced from 13 to 16. The
copied files and final `result.json` were independently read back again on the
Mac. Local evidence is in
`output/ios298-device-handoff-20261019-v4/run-20261019-173048/`;
the frozen library SHA-256 is
`668659f0cb0e4f2af06d252f44a4c9365bd4d13030ce56a50cdf71b54f2390ea`.
The runner records its own hash separately from the preparation-time script
hash and does not rerun a completed output directory.

The same harness passed on a physical **iPad Air 11-inch (M2), iPadOS 26.6.2
(23G90)** on 2026-10-25 from the stack head `d1ba86bc` (frozen library SHA-256
`03964708369478efd0e9f479614d7f1d062e784b43aba0e21a4c43644dd60928`, evidence
`output/ios-device-validation/run-20261025-201632/`). The iPad was paired with
`xcrun devicectl manage pair`, Developer Mode was switched on by hand on the
device (`devmodectl` refuses devices with a passcode), and one
`xcodebuild … -destination id=<udid> -allowProvisioningDeviceRegistration`
on the prepared project copy added it to the team profile. The memory plan
reported half of the device RAM (`ramBytes` 4007231488, budget 1803254169) via
the native memory command. All four originals imported as one roll in 3.0 s,
native LibRaw decoded the NEF in 431 ms and the DNG in 1038 ms, exports took
0.5 s (JPEG, HEIC), 0.9 s (NEF) and 1.1 s (DNG) with the same verified PNG
dimensions as the iPhone table above, and the whole-app SIGKILL/relaunch restored
all four sources, both exposure edits and the active image; checkpoint revisions
advanced from 9 to 12. WKWebView on iPadOS reports a desktop Safari user agent
(`Macintosh; Intel Mac OS X 10_15_7`, platform `MacIntel`), which is why
`platform.js` must not rely on user-agent heuristics. The runner now names the
validated device in its pass line and `result.json`.

Evidence is written to a timestamped `run-*` directory: device/build/install
results, launch PIDs, reassembled device events, copied originals/checkpoints,
exported files and a final `result.json`. A prepared library or installed app
alone is not a passing test. Programmatic editor controls on a physical phone
still leave manual touch, rotation/background, a separate WebContent termination
and lower-memory-device acceptance outstanding. This run used the
default **8-bit** export; it does not establish 16-bit export acceptance.
ResizeObserver loop notifications are retained in the device log. No upload
or App Store action occurs.
