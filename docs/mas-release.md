# Mac App Store auto-release

Every push to `main` runs `.github/workflows/desktop-release.yml`. After the
GitHub Release + R2 sync succeed, the `mas-appstore` job builds the sandboxed
Mac App Store package (`scripts/build-mas.sh`), uploads it with fastlane
(`fastlane/Fastfile`, lane `mac mas_upload`), submits it for review, and lets
it release automatically once Apple approves. If any required secret is
missing the job skips with a notice instead of failing.

The web app on Vercel deploys on every merge regardless; this pipeline only
concerns the packaged desktop app.

The App Store package is built with `--no-default-features`, which drops the
`updater` cargo feature: the in-app updater of the direct-download builds
(`docs/desktop-updater.md`) is not allowed in App Store apps, and `build.rs`
leaves the `updater` capability out of the ACL for that build.

## Required GitHub secrets

| Secret | Content |
| --- | --- |
| `ASC_API_KEY_ID` | App Store Connect API key ID |
| `ASC_API_ISSUER_ID` | App Store Connect issuer ID |
| `ASC_API_KEY_P8` | **base64** of the `AuthKey_*.p8` file |
| `MAS_CERT_DIST_P12` | **base64** of the `Apple Distribution: NEO ANALOG LABO K.K.` identity (.p12 with private key) |
| `MAS_CERT_INSTALLER_P12` | **base64** of the `3rd Party Mac Developer Installer: NEO ANALOG LABO K.K.` identity (.p12 with private key) |
| `MAS_CERT_PASSWORD` | export password shared by both .p12 files |
| `MAS_PROVISION_PROFILE` | **base64** of `embedded.provisionprofile` (Mac App Store provisioning profile) |

Create the API key in App Store Connect → Users and Access → Integrations →
App Store Connect API → Team Keys → Generate (role: App Manager). Export the
two identities from Keychain Access → My Certificates (use one password for
both). The provisioning profile is the same file as the local, gitignored
`src-tauri/embedded.provisionprofile`.

## Versioning

- The `prepare` job computes the release version by bumping the patch against
  existing `v*` tags; `set_tauri_version.mjs` writes it into
  `tauri.conf.json` / `Cargo.toml` as usual.
- `set_mas_bundle_version.mjs` sets `CFBundleVersion` to
  `major*100000000 + minor*100000 + patch*100 + (run_attempt - 1)`
  (e.g. `1.0.13` → `100001300`). Mac App Store build numbers must increase
  across **all** uploads, and the attempt digit lets a re-run re-upload the
  same version after a failed submission. Three digits for patch keep
  `1.0.100` below `1.1.0`; the script fails loudly if minor/patch exceed 999.
- "What's New" is generated from `git log` between the previous tag and HEAD
  (capped at 3500 chars, fallback "Bug fixes and improvements."), applied to
  all locales.

## ストア画像

`fastlane/screenshots/en-US/` の 4 枚を新しい編集可能バージョンへアップロードし、
古いスクリーンショットを置き換える。公開済みバージョンの画像は Apple の承認まで変わらない。
アップロード前に `node scripts/check-appstore-screenshots.mjs` で全 4 枚の存在、
2880×1800、RGB・透過なし、デコード可否を検証する。失敗時は提出を中止する。

2026-09-06 の画像は L1009967.dng を実際の Studio で自動変換して撮影したもの。
調色、CMYD／曲線、片基・変換、インポートを表示する。元 DNG はコミットしない。
再撮影: `node scripts/appstore-screenshots.mjs`。まず `output/playwright/appstore/en-US/`
で実画面を目視確認し、確認済み PNG だけを上記リリース用ディレクトリへコピーする。
既存ストアのロケール en-US に合わせる。中国語・日本語 UI 自体は引き続き使用可能。

仕様: https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/

## Renewals

- Signing certificates expire **2027-08-04**; the provisioning profile
  expires annually. Re-export/download and update the secrets, and refresh
  the local `src-tauri/embedded.provisionprofile` too.
- The WWDR G3 intermediate is fetched from apple.com during the job; if Apple
  rotates the issuing CA for renewed certificates, update that URL in the
  `Import signing assets` step.

## TestFlight

Every uploaded build automatically becomes available to **internal** TestFlight
testers (no extra CI work): create an internal group once in App Store Connect
→ TestFlight and add yourself. Internal builds need no beta review, so this is
the fastest way to run the latest merge on a Mac.

## Manual fallback

`npm run tauri:build:mas` still produces the signed .pkg locally, uploadable
with Transporter.app — nothing in the pipeline removes the manual path.
