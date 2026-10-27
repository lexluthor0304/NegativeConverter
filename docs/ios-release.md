# iPhone and iPad App Store automation

`.github/workflows/ios-release.yml` builds, signs, verifies and uploads the iOS
app on GitHub's macOS runner and submits it for review with
`automatic_release: true`: Apple's approval releases the version without a
separate publish action. Apple's review is still required.

This is the same application record as the Mac app: Apple ID `6797694070`,
bundle ID `com.neoanaloglab.negativeconverter`, team `X93Y44J36C`. Both
platforms on one record form a universal purchase once both are approved.
Pricing and shared app information are not modified by this lane.

## How a release happens

Every push to `main` runs the workflow; so does a schedule (`53 */2 * * *`)
and a manual dispatch. The cheap `check` job on Ubuntu runs
`.github/scripts/prepare_ios_release.mjs`, which plans the next version and
decides; only on `publish` does the macOS `publish` job build and submit.

| decision | when | run |
| --- | --- | --- |
| `publish` | something app-relevant changed since the last submitted `ios/v*` tag and no iOS version is in flight at App Store Connect | build, verify, upload, submit for review, tag `ios/vX.Y.Z` |
| `skip` | the diff since the last `ios/v*` tag only touches tests, fixtures, benchmarks, docs, CI or the desktop/Mac lanes (`IGNORED_PATHS` in the script, the counterpart of `desktop-release.yml`'s `paths-ignore`) | notice, nothing built |
| `blocked` | the previous iOS version is `WAITING_FOR_REVIEW`, `IN_REVIEW`, `PENDING_*`, `PROCESSING_*` … (App Store Connect allows one version per platform in flight; deliver would die on "You cannot create a new version of the App in the current state") | a push gets a "deferred" warning; the next scheduled run that finds Apple done submits `main` |
| `paused` | `fastlane/ios/release.json` has `appStoreSubmissionReady: false` | notice; the committed switch to stop App Store submissions |
| `done` | the planned version already exists at App Store Connect and is not editable, i.e. a submission succeeded but its tag was never pushed | notice; tag that commit as `ios/v<version>` by hand so the sequence moves on |

The in-flight question is `decideStorePublish` from
`.github/scripts/asc_mas_state.mjs`, the same code the Mac App Store lane uses
(`docs/mas-release.md`), asked for the `IOS` platform. A version Apple
rejected (`DEVELOPER_REJECTED`, `METADATA_REJECTED`, …) does not block:
deliver renames it to the new number and re-submits with the new build.

The workflow holds one concurrency group (`ios-release`), so a scheduled or
dispatched run waits for a running build and then sees the fresh App Store
Connect state, a newer pending run replaces an older pending one (main's head
carries that commit anyway), and a running upload is never cancelled. The
publish job runs the planner again and fails loudly if the decision changed
in between, which the group makes impossible in practice. A pull request that
changes the lane files runs the check only, in its own group, and reports
what it would do.

Manual runs: `gh workflow run ios-release.yml --ref main -f channel=testflight`
uploads a TestFlight build to the internal group (no store gates, no tag);
`-f channel=app-store` is the same path as a push. Pushes always use
`app-store`; there is no repository variable to set.

## Current delivery state (2026-10-27)

iOS 1.0.0 (build 14.1) was submitted for review on 2026-10-27 from commit
`10294962` (tag `ios/v1.0.0`) after the TestFlight build was tried on an
iPhone and an iPad. Approval and public availability were not yet verified at
that time; once Apple approves, install from the App Store on both devices
and check the listing. Earlier device evidence: [P2](ios-p2-recovery.md#physical-device-harness).

## Credentials

The uploader reuses `ASC_API_KEY_ID`, `ASC_API_ISSUER_ID` and base64
`ASC_API_KEY_P8` from the Mac release. The build maps `MAS_CERT_DIST_P12`
and `MAS_CERT_PASSWORD` to Tauri's `IOS_CERTIFICATE` and
`IOS_CERTIFICATE_PASSWORD`. The identity must be **Apple Distribution** with
its private key; the Mac installer certificate is not used.

No provisioning profile secret is needed: the lane fetches or creates a
manually managed **iOS App Store** profile named `Negative Converter iOS App
Store` through the App Store Connect API (`scripts/ios-ensure-store-profile.mjs`)
for the exact Apple Distribution certificate inside `MAS_CERT_DIST_P12`, and
recreates it when that certificate changes or the profile stops being active.
Xcode-managed profiles (`iOS Team Store Provisioning Profile: …`) are rejected
by `scripts/verify-ios-package.py --profile`, because `tauri ios build --ci`
configures manual signing and xcodebuild refuses them (the first dispatch on
2026-10-26 failed that way). The API key therefore needs a role that can manage
provisioning (Admin, or Developer with access to certificates and profiles).

Missing credentials fail a publish rather than reporting a successful
submission. Without the App Store Connect key the check job cannot ask about
versions in flight and lets the publish job go ahead; deliver then reports
the state itself. Existing submissions are never withdrawn: deliver runs with
`reject_if_possible: false`.

## Independent versioning

The first iOS version is `fastlane/ios/release.json`'s `initialVersion` (`1.0.0`).
After a successful App Store **submission**, the workflow creates an `ios/v*`
tag pointing to the submitted commit. A later run bumps the highest iOS
version's patch. Raising `initialVersion` above that sequence starts a new
minor/major series. Desktop `v*` tags are ignored; Mac versions and files are
not rewritten.

`CFBundleVersion` is `<github.run_number>.<github.run_attempt>`, independently
tracked by this workflow. A retry gets a different build number. Four/two-digit
limits are enforced instead of silently generating invalid Apple build numbers.
Do not rename/recreate the workflow or reset the sequence without checking
previous iOS uploads. An older workflow rerun can have a lower run number than
a newer upload; use a new dispatch instead in that case.

TestFlight runs do not tag a submitted version. Further test uploads and the
eventual App Store upload use the same next marketing version, with distinct
build numbers.

Generated version overlays live only in `output/ios-release`. Tauri automatically
merges `tauri.ios.conf.json`; the generated overlay changes the iOS version and
bundle number. The archive is a release build exported with
`--export-method app-store-connect`, suitable for both upload channels. The
development project's `debugging` export setting is overridden explicitly.

## What's New

For every version after the first, the planner writes
`fastlane/ios/metadata/en-US/release_notes.txt` in the runner's checkout from
the commit subjects since the previous `ios/v*` tag (`whatsNew`): `ci`,
`docs`, `test`, `chore`, `build`, `refactor`, `style`, `release` and `revert`
subjects are dropped, `feat:` prefixes go, `fix:` becomes "Fixed:", `perf:`
becomes "Performance:", PR numbers are removed and the text stays under
Apple's 4000 characters. When nothing user-facing remains, the committed
sentence in that file is uploaded instead. Nothing is committed back; the
file in git is the fallback and the first version has no What's New.

## Verification and artifacts

Before upload, the workflow runs the shared JS tests and Studio/mobile layout
regressions, builds the production web assets without `NC_P0_FIXTURES=1`, then
builds and verifies the exact exported IPA. `scripts/verify-ios-package.py`
checks ZIP integrity, a distribution profile, its expiry/team/bundle identity,
`codesign --verify --deep --strict` with an Apple trust requirement, an exact
match between the signing certificate and the profile's permitted certificates,
signed entitlements, arm64 device code,
both device families, minimum iOS 17.0, exact version/build and absence of
`p0-fixtures` files in the package. Vite and the native build guard additionally
prevent fixture assets from being embedded into the executable. A simulator or
development-signed app is refused.

The workflow artifact contains the verified IPA, SHA-256/signature report and
release plan with source SHA, decision and the app-relevant changes. A green
upload or review submission does not prove approval or public availability.
After Apple approves, verify the public listing and install from the App Store
on both iPhone and iPad.

Local checks that do not sign, build, contact Apple or need a phone:

```sh
node .github/scripts/prepare_ios_release.test.mjs
node .github/scripts/asc_mas_state.test.mjs
IOS_RELEASE_CHANNEL=app-store node .github/scripts/prepare_ios_release.mjs   # plan + decision without Apple
python3 scripts/test-ios-package.py
ruby -c fastlane/Fastfile
npm test
```

`node scripts/check-ios-store-assets.mjs` checks the store copy and the native
screenshot sets before any upload can replace them. Do not replace the
captures with desktop screenshots or Chromium layout mocks; the `Store
screenshots (simulator)` job in `ios-ci.yml` captures them from the iOS
Simulator at the required sizes (`fastlane/ios/screenshots/README.md`).

## Store copy and screenshots

The iOS lane reads only `fastlane/ios/metadata` and `fastlane/ios/screenshots`;
it never uploads `fastlane/screenshots`, the Mac set. The first locale is en-US.
App description and keywords avoid unverified claims about RAW model coverage
or 16-bit mobile export. Name, privacy policy, pricing and review contact data
remain in the shared record. A change to the store copy or screenshots counts
as an app change and goes out with the next version.

The screenshot checker requires native iPhone medium Dynamic Island captures
and iPad 13-inch captures, one to ten opaque RGB PNGs per family. Exact accepted
sizes are in the screenshot directory's README. It fully decodes each image,
checks dimensions and rejects blank or missing sets.

## References

- [GitHub: Apple signing on macOS runners](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications)
- [Tauri: iOS code signing and CI environment variables](https://v2.tauri.app/distribute/sign/ios/)
- [Tauri: App Store export and bundle versions](https://v2.tauri.app/distribute/app-store/)
- [Fastlane: App Store upload and automatic release](https://docs.fastlane.tools/actions/upload_to_app_store/)
- [Apple: platform records](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-platforms/)
- [Apple: release after approval](https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/select-an-app-store-version-release-option/)
- [Apple: screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/)
