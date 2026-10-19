# iOS P1 platform and editor integration (#298)

This continues the P0/Tauri 2.12 work on the v1.0.42 baseline (`a59414a3`).
The shared Studio now asks the native shell for its OS and capabilities.
Native export, memory reporting and RAW decode still use the common Tauri
bridge; folder watching and in-app updates require separate capabilities.
The browser's `?shell=mobile` layout preview cannot override a real shell.
A failed/invalid platform query leaves desktop-only features disabled, with
no touchscreen or user-agent heuristic. Store builds do not fetch desktop
update manifests. Feedback preserves `ios`/`android` as its source.

## Mobile editor

The mobile shell keeps the existing Studio, neutral palette and pixel fonts.
It hides the desktop folder picker, watch-folder controls, update banner,
marketing bar and camera loupe (camera permission is not part of the first
release). Feedback, privacy and help remain reachable through the menu.
Safe-area padding accounts for the notch and home indicator. Primary controls
have 44 px touch targets; text/number fields use 16 px to avoid focus zoom.
On compact windows the Photos button expands the filmstrip on demand. Short
landscape windows use the side inspector. The photo-processing algorithms
and desktop layout are shared with the existing app.

`npm run test:smoke -- --mobile-shell-only` exercises import/conversion and
real touch input on the editor tabs at 375x667, 390x844, 844x390, 820x1180,
1180x820 and 540x900, for English, Chinese and Japanese. Screenshots are written
to `output/mobile-shell/`. This is Chromium layout coverage, not iOS/device
acceptance, Photos/Files picker coverage or a native export test.

## Permissions and recovery

The iOS config selects both `default` and `mobile`. Merely collecting a
capability in `build.rs` is insufficient when the config explicitly selects
capabilities. The mobile opener allows HTTPS URLs through the system browser;
no filesystem-opening permission or updater permission is granted. Desktop
updater capabilities are restricted to their own targets.

On iOS, repeated WebContent terminations are coalesced into one pending
reload with delays of 0.5, 1, 2, 4, 10 and at most 30 seconds; a minute without
a termination resets the delay. Native resources owned by the dead page are
released immediately. Desktop retains immediate recovery. This addresses the
P0 reload storm; persistent source-file recovery remains a separate P2 item.

## Build verification

The independent `iOS CI` workflow builds unsigned device and simulator apps,
including native Swift/plugin linkage. It uses Xcode 26.6 on `macos-26`, Rust
1.95.0, Node 24 and the committed dependency locks. It does not use signing
credentials, register devices, upload TestFlight builds or publish a release.
The regular Desktop CI remains required for regressions.

References: [Tauri capabilities](https://v2.tauri.app/security/capabilities/),
[Tauri opener](https://v2.tauri.app/plugin/opener/), and
[GitHub runner toolchains](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-Readme.md).

Local validation on 2026-10-19: 82 Rust unit tests passed; both
`aarch64-apple-ios` and `aarch64-apple-ios-sim` passed `cargo check --locked
--offline --no-default-features`. Web build passed. Local Chrome smoke could
not start: Chrome exited with SIGABRT before loading the app. The computer-use
browser also could not load its request-header policy. Native install/launch
and the new opener/reload behavior have not been revalidated on a device.

## Remaining roadmap work

- P2: Photos/Files native import, persistent source copies and atomic edit
  checkpoints, Files/share/Photos export with cancellation and success semantics.
- Lifecycle: whole-app and WebContent recovery, background pause/resume,
  cancellation and durable export reconciliation.
- iPhone/iPad native acceptance, including 4/6 GB devices, split view,
  external keyboards and VoiceOver; RAW/16-bit quality and memory matrix.
- Store record/universal-purchase decision before any TestFlight upload,
  independent iOS build numbers, privacy metadata, screenshots, review and
  installation from the public App Store on both device families.

P0/P1 development is not an iPhone/iPad App Store release.
