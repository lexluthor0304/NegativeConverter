# iOS P0 feasibility (#298)

Date: 2026-10-18 (JST). Baseline: origin/main `cbb50773`, worktree branch
`ios/298-p0-feasibility`. Device: iPhone 15 Pro Max (iPhone16,2, 8 GB RAM,
A17 Pro), iOS 27.0 (24A5408d), wired, Developer Mode on. Host: macOS 27.0.1,
Xcode 27.1 (27A9275) with the iOS 27.1 SDK, Rust 1.95, Tauri CLI 2.11.4 /
tauri 2.11.5, tao 0.35.3, wry 0.55.1 (the `nc/0.55.1-memory-pressure` fork).

## Verdict

The existing app runs on iOS as a Tauri iOS build without a rewrite: the
Studio page, its workers, the HEIF decoder, the conversion engine, the Rust
I/O layer and the native LibRaw decoder work on the device from bundled,
offline assets, and the conversions are pixel-identical to the desktop web
build. P0 found four blockers; three are fixed in this branch, one (the
UIScene lifecycle on tao 0.35.3) needs the Tauri 2.12 upgrade before any
release build, so P1 starts there.

Not verified by P0: iPad (no device; no simulator runtime on this Mac),
Photos picker and share sheet (P2), release builds (blocked by the tao issue
below), App Store signing with the company team, devices with less RAM.

## What was run

1. `cargo check --target aarch64-apple-ios-sim` of the unmodified tree.
2. The dependency isolation and the native-decoder build of this branch,
   checked for iOS, macOS default and macOS `--no-default-features`;
   `cargo test` (78/78), `npm test` (379/379).
3. `tauri ios init` → debug, development-signed IPAs (`tauri ios build
   --debug --export-method debugging`) installed with `devicectl`.
4. The on-device self-test (`p0SelfTest.js`, 10 runs): each bundled fixture
   through the real `<input type=file>` → automatic conversion → Export
   Current → Documents; JSON events in `Documents/p0-diagnostics.log`, the
   memory plan and the native-decoder override switched per run through the
   launch environment (`NC_P0_SELFTEST=<GiB>`, `NC_P0_NATIVE_RAW=off|on`).
5. The same NEF converted in headless Chrome on the Mac (libraw-wasm,
   threaded) for a pixel comparison with the device exports.

Fixtures: `negative-sample.jpg` (1400×1284 JPEG with a DX strip),
`negative-sample.heic`, `_DSC3111.NEF` (Nikon, 4000×2672, 10.6 MP),
`_DSC5290.dng` (Harman Phoenix scan, 6048×4024, 24 MP), `L1009967.dng`
(Leica M11, 9536×6336, 60 MP).

## Blockers and fixes

| # | Blocker | Fix in this branch | Status |
| --- | --- | --- | --- |
| 1 | `rfd` 0.15 has no iOS backend: the only crate that fails to compile for iOS. | `rfd`, `notify`, the updater and process plugins move to a `cfg(not(any(target_os = "ios", target_os = "android")))` dependency table; `import_folder_mobile.rs` stubs the watch-folder commands; the mobile export commands write to the app's Documents directory (`UIFileSharingEnabled`, `Info.ios.plist`); `build.rs` leaves the updater capability out on mobile; `get_memory_info` reads `hw.memsize` on iOS; the WebContent-termination hook covers iOS. | fixed |
| 2 | Tauri CLI 2.11 refuses `tauri ios build` for a physical device when no simulator runtime is installed (`xcrun simctl list runtimes --json` is empty). | Session-only PATH shim answering that one query; the real fix is the 8 GB runtime download once the disk allows it. Not committed. | worked around |
| 3 | The generated Xcode project runs `npm run -- tauri ios xcode-script`, which needs a `tauri` npm script. | `"tauri": "tauri"` in package.json. | fixed |
| 4 | **iOS 27 SDK traps apps without the UIScene lifecycle at launch** (`EXC_BREAKPOINT` in `_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`, TN3187). | `UIApplicationSceneManifest` (`UIApplicationSupportsMultipleScenes` true, `UISceneDelegateClassName` `TaoSceneDelegate`) in `Info.ios.plist`: tao 0.35.3 engages its scene delegate only in that configuration. Debug builds launch. **Release builds crash on tao 0.35.3** (`UISceneConfiguration` use-after-free, tauri-apps/tao#1340); the fix is tao 0.37, which ships with Tauri 2.12. | debug fixed; release needs Tauri 2.12 |
| 5 | Both vendored libraw-wasm builds (`libraw.js`, `libraw-threaded.js`) create `shared: true` WebAssembly memory. iOS WKWebView reports `crossOriginIsolated` without a `SharedArrayBuffer`; the single-thread module instantiates only sometimes (the startup probe saw `Out of memory`) and failed on the 24 MP DNG in the control run. | The native LibRaw decoder now builds for iOS (`build_libraw.rs`: one thread, no OpenMP, libc++) and `nativeRawDecoder.js` lists `ios-aarch64`; the page decodes natively, the WASM build stays the fallback. | fixed |

Tauri 2.12 (tauri-runtime-wry 2.12.0) requires tao ^0.37 and wry ^0.57.
wry 0.57.0 still has no memory-pressure settings API, so the wry fork branch
has to be rebased onto wry 0.57.0 as part of that upgrade, with the desktop
regression the fork's docs ask for.

## Measurements (iPhone 15 Pro Max, debug build, one thread)

Boot to the self-test's first event: 0.2–0.4 s after page load. Page facts:
viewport 430×932 @3x, `hardwareConcurrency` 4, `deviceMemory` absent,
`crossOriginIsolated` true, `SharedArrayBuffer` absent, WebGL2 "Apple GPU"
(max texture 16384), WebGPU present, OffscreenCanvas present; the Rust side
reports 8.03 GB RAM, `wkwebview`, `os: ios`; native RAW available
(LibRaw 0.22.1-Release, 1 thread).

| Fixture | Import → Studio settled | Decode path | Export (PNG, Documents) | Retained after import / export |
| --- | --- | --- | --- | --- |
| JPEG 1400×1284 | 1.8 s | canvas | 0.5 s, 2.8 MB | 16 / 36 MiB |
| HEIC 1400×1284 | 1.6 s | HEIF worker (reserves 1.8 GB foreground, see notes) | 0.5 s, 2.6 MB | 16 / 36 MiB |
| NEF 10.6 MP | 3.0 s | native, decode 0.40–0.42 s + transfer 0.04–0.06 s | 0.9 s, 17.8 MB (3625×2448 after auto-crop) | 235 / 336 MiB |
| DNG 24 MP | 3.9–4.1 s | native, decode 0.95–0.97 s + transfer 0.09–0.11 s | 0.9 s, 24.1 MB (4557×3025) | 447 / 604 MiB |
| DNG 60 MP | — | see the memory plan below | — | — |

Memory plan (`IOS_PLAN_RAM_BYTES` → `budgetFor()`; the RAW admission allows
35 % of the planned RAM, `checkRawDecodeBudget`):

| Planned RAM | Budget | NEF 10.6 MP | DNG 24 MP (est. 901 MB) | DNG 60 MP (est. 1.84 GB) |
| --- | --- | --- | --- | --- |
| 2 GiB (the P0 placeholder) | 922 MiB | decoded | **rejected** (admission 752 MB) with the "not enough memory" toast | rejected |
| 4 GiB | 1843 MiB | decoded | decoded | rejected cleanly (admission 1.5 GB) |
| 8 GiB (the device's real RAM) | 3686 MiB | decoded | decoded | admitted → **WebContent process terminated** three times within 250 ms; the reload hook relaunched the page each time and the run never recovered |

So for an 8 GB iPhone the plan should be 4 GiB: every file up to 24 MP
converts, 60 MP is refused with the existing message instead of a crash.
Smaller devices need their own run before the matrix is frozen.

Parity: the iPhone's native export of `_DSC3111.NEF` is pixel-identical
(decoded RGBA SHA-256 `aa8ee22e…`) to Chrome-on-macOS's libraw-wasm export
of the same file with the same import order, and to the iPhone's own
WASM-path export; the two 24 MP native exports of different runs are
byte-identical. No page errors or unhandled rejections in any run except one
`ResizeObserver loop completed with undelivered notifications` on the first
import.

Notes: the HEIF import reserves 1,800,000,000 bytes in the foreground for a
283 KB file (harmless under the foreground rule, worth a look). The
`Error loading file` toast after a refused RAW is followed by the memory
message; the refused file never enters the photo list.

## Signing and device facts

- The company team (X93Y44J36C) had only an Apple Distribution certificate on
  this Mac and the Xcode account session had expired, so P0 signed with the
  Personal Team (P58DZWHN3V) under the identifier
  `com.neoanaloglab.negativeconverter.iosdev` (the real App ID belongs to the
  company team), through a scratch `--config` file. After the account was
  renewed, a build with the committed config (company team, real identifier)
  reached Apple and failed only because the team has no registered devices:
  one `xcodebuild … -destination id=<udid> -allowProvisioningUpdates
  -allowProvisioningDeviceRegistration build` on `src-tauri/gen/apple`
  registered the iPhone, created the team's development certificate and the
  profile for `com.neoanaloglab.negativeconverter`; the company-signed build
  then installed and launched with no trust prompt. The Xcode account session
  had expired and had to be renewed in Xcode → Settings → Accounts, and the
  developer profile had to be trusted on the phone (Settings → General → VPN
  & Device Management) before the first launch; uninstalling the app removes
  that trust again.
- `devicectl device process launch --console` shows none of the app's
  stderr; `ios_webkit_debug_proxy` cannot reach iOS 17+ Web Inspector. The
  self-test therefore logs through `log_webview_diagnostics`, which the
  debug mobile build also appends to `Documents/p0-diagnostics.log` when
  `NC_P0_SELFTEST` is in the launch environment.
- Opening Xcode with the phone attached copies 6.8 GB of device symbols into
  `~/Library/Developer/Xcode/iOS DeviceSupport`; a debug iOS build with the
  230 MB fixture bundle embedded leaves 7–8 GB under
  `target/aarch64-apple-ios`. Both are safe to delete.

## Running the device self-test again

1. Copy the fixtures into `negative2positive/public/p0-fixtures/` (ignored by
   git): `negative-sample.jpg`, `negative-sample.heic` from
   `negative2positive/test-fixtures/`, the real RAWs from the repo root, and
   a `plan.json` listing them (`{"fixtures": [{"file": "...", "type": "..."}]}`,
   optional `timeoutMs`, `export: false`).
2. `NC_P0_FIXTURES=1 npm run build:web` (the sync step refuses a build that
   carries the fixtures without that variable), then
   `npx tauri ios build --debug --export-method debugging`, with
   `--config <file>` setting a personal `identifier` and
   `bundle.iOS.developmentTeam` when the company team is not in Xcode.
3. `xcrun devicectl device install app --device <udid> "src-tauri/gen/apple/build/arm64/Negative Converter.ipa"`,
   then launch with the self-test environment:
   `xcrun devicectl device process launch --terminate-existing -e '{"NC_P0_SELFTEST":"4"}' --device <udid> <bundle id>`
   (`NC_P0_SELFTEST=1` keeps the page's own memory plan; a number above 1 is
   the RAM in GiB to plan with; `NC_P0_NATIVE_RAW=off|on` forces the RAW
   decoder). Keep the phone unlocked with the app in front.
4. Read the events: `xcrun devicectl device copy from --device <udid>
   --domain-type appDataContainer --domain-identifier <bundle id>
   --source Documents/p0-diagnostics.log --destination p0.log`; each
   `[webview] P0 <id> <i>/<n> <chunk>` line is one piece of a JSON event
   (`start`, `probe`, `importing`, `imported`, `exported`, `import-failed`,
   `done`); the exports are in `Documents` next to it.

The self-test code is `negative2positive/src/app/p0SelfTest.js` (loaded only
for `?p0=1`) and the `NC_P0_SELFTEST` branch of `run()` in
`src-tauri/src/lib.rs`, compiled only into debug mobile builds.

## Recommended next steps (P1)

1. Upgrade to Tauri 2.12.x: tao 0.37 (UIScene lifecycle, the release crash),
   wry 0.57 (rebase `nc/0.55.1-memory-pressure`), tauri-runtime-wry 2.12;
   run the desktop smoke and the macOS/Windows/Linux release checks.
2. Decide the store identity (add iOS to the macOS record or a separate
   record) and get the company team into Xcode or an App Store Connect API
   key into CI, so the real identifier signs.
3. Commit `src-tauri/gen/apple` regenerated with the real identifier (not
   the `.iosdev` one), without `build/`, `Externals/` and `xcuserdata/`.
4. Platform capability layer (`isTauriDesktop()` is true on iOS; the Rust
   commands do the right thing, the page still shows desktop-only controls
   such as the watch folder and the update check).
5. The memory plan now follows the measurement (half of the RAM, at most
   4 GiB, `memoryBudget.js`); measure a 6 GB and a 4 GB device before the
   matrix is frozen, and give the WebContent reload after a termination a
   back-off on iOS instead of the immediate reload loop.
6. Native RAW on iOS: add the `ios-aarch64` hashes to the parity tests
   (`wasm-parity-hashes.json`), decide whether to ship the WASM fallback at
   all on iOS, and look at the HEIF foreground reservation.
7. Photos picker, share sheet and saving to Photos (a small Swift plugin),
   then the iPad layout pass on a simulator or device.
