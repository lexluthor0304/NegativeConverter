# iPhone and iPad App Store automation

`.github/workflows/ios-release.yml` builds, signs, verifies and uploads the iOS
app on GitHub's macOS runner. The App Store lane submits for review and sets
`automatic_release: true`: Apple approval releases the version without a
separate manual publish action. Apple's review is still required.

This is the same application record as the Mac app: Apple ID `6797694070`,
bundle ID `com.neoanaloglab.negativeconverter`, team `X93Y44J36C`. Adding iOS
to this record establishes universal purchase after both platforms are
approved. Pricing and shared app information are not modified by this lane.

## Current delivery state (2026-10-19)

The workflow, independent version generation, IPA validation and English store
copy are prepared. They have **not** completed a signed GitHub Actions run,
TestFlight upload, Apple review or public release. The App Store Connect page
could not be accessed because the browser's administrator-policy check failed;
this preparation did not add an iOS platform or change the store release option.

`fastlane/ios/release.json` deliberately records
`appStoreSubmissionReady: false`. Both the workflow preflight and the Fastlane
App Store lane reject submission while it is false. The workflow has no
automatic push effect until the repository variable `IOS_RELEASE_CHANNEL` is
configured. This is a first-release acceptance gate, not manual publishing
after approval.

The physical iPhone run in [P2 evidence](ios-p2-recovery.md#physical-device-harness)
passed JPEG, HEIC, native NEF/DNG decode, 8-bit PNG export and whole-app
termination/recovery. The exact P2 head `e6a89c95` passed all four
[iOS CI jobs](https://github.com/lexluthor0304/NegativeConverter/actions/runs/39223945265)
and all five [desktop CI jobs](https://github.com/lexluthor0304/NegativeConverter/actions/runs/39223945317).
These are development-build results, not signed distribution validation.

Complete the following before changing submission readiness:

- Validate a physical iPad, lower-memory admission/refusal, touch, rotation and
  background/foreground behavior, plus separate WKWebView WebContent termination.
- Complete native import/save/share integration and 16-bit export acceptance.
- Run and install the distribution candidate through TestFlight on iPhone and
  iPad; retain import, conversion, editing, export and recovery evidence.
- Add the iOS platform to the existing record, initially version `1.0.0`, and
  verify the current pricing, availability, privacy labels, export compliance,
  review contact information and support URL. These shared record details have
  not been freshly verified in this preparation.
- Capture native iPhone and iPad screenshots and review the description against
  the final tested feature set. Store asset validation must pass.

## Credentials and activation

The uploader reuses `ASC_API_KEY_ID`, `ASC_API_ISSUER_ID` and base64
`ASC_API_KEY_P8` from the existing Mac release. The build maps
`MAS_CERT_DIST_P12` and `MAS_CERT_PASSWORD` to Tauri's `IOS_CERTIFICATE` and
`IOS_CERTIFICATE_PASSWORD`. The identity must be **Apple Distribution** with
its private key; the Mac installer certificate is not used.

Add `IOS_PROVISION_PROFILE`: base64 of an **iOS App Store Connect distribution**
`.mobileprovision` for this exact team and bundle ID, containing the distribution
certificate above. A Mac `.provisionprofile`, development profile, ad-hoc or
enterprise profile is rejected before building. The current repository's secret
values and existence were not inspected. No private keys belong in the repo,
logs or build artifacts.

After adding iOS to the record and configuring the profile, run the workflow
on `main` with channel `testflight` for the first distribution validation.
Alternatively, set the repository variable `IOS_RELEASE_CHANNEL=testflight`
to upload automatically on each main push. This uploads and waits for processing;
it does not invite external testers or submit to App Review. Configure an
internal TestFlight group with automatic distribution in App Store Connect.

After the acceptance evidence and store assets above are complete, set
`appStoreSubmissionReady` to `true` in a reviewed change and set
`IOS_RELEASE_CHANNEL=app-store`. Subsequent main pushes run the entire release
sequence automatically. A workflow dispatch is also available for retries.
Missing credentials fail an enabled run rather than reporting a successful
publish. Existing submissions are not automatically withdrawn: Fastlane uses
`reject_if_possible: false` and stops if Apple does not permit another version.

The current work is stacked on the iOS branches. Do not merge the unfinished
mobile feature stack merely to make a release workflow dispatch available;
main merges also trigger the existing desktop/Mac App Store release.

## Independent versioning

The first iOS version is `fastlane/ios/release.json`'s `initialVersion` (`1.0.0`).
After a successful App Store **submission**, the workflow creates an `ios/v*`
tag pointing to the uploaded commit. A later run bumps the highest iOS version's
patch. Raising `initialVersion` above that sequence starts a new minor/major
series. Desktop `v*` tags are ignored; Mac versions and files are not rewritten.

`CFBundleVersion` is `<github.run_number>.<github.run_attempt>`, independently
tracked by this workflow. A retry gets a different build number. Four/two-digit
limits are enforced instead of silently generating invalid Apple build numbers.
Do not rename/recreate the workflow or reset the sequence without checking
previous iOS uploads. An older workflow rerun can have a lower run number than
a newer upload; use a new dispatch instead in that case.

TestFlight runs do not tag a submitted version. Further test uploads and the
eventual App Store upload use the same next marketing version, with distinct
build numbers. The App Store lane builds a fresh candidate from its selected
commit; preserve the validated source commit when doing the first submission.

Generated version overlays live only in `output/ios-release`. Tauri automatically
merges `tauri.ios.conf.json`; the generated overlay changes the iOS version and
bundle number. The archive is a release build exported with
`--export-method app-store-connect`, suitable for both upload channels. The
development project's `debugging` export setting is overridden explicitly.

## Verification and artifacts

Before upload, the workflow runs the shared JS tests and Studio/mobile layout
regressions, builds the production web assets without `NC_P0_FIXTURES=1`, then
builds and verifies the exact exported IPA. `scripts/verify-ios-package.py`
checks ZIP integrity, a distribution profile, its expiry/team/bundle identity,
`codesign --verify --deep --strict`, signed entitlements, arm64 device code,
both device families, minimum iOS 17.0, exact version/build and absence of
`p0-fixtures`. A simulator or development-signed app is refused.

The workflow artifact contains the verified IPA, SHA-256/signature report and
release plan with source SHA. A green upload or review submission does not prove
approval or public availability. After Apple approves, verify the public listing
and install from the App Store on both iPhone and iPad.

Local checks that do not sign, build, contact Apple or need a phone:

```sh
node .github/scripts/prepare_ios_release.test.mjs
python3 scripts/test-ios-package.py
ruby -c fastlane/Fastfile
npm test
```

`node scripts/check-ios-store-assets.mjs` is a submission check and currently
fails because no native store screenshots have been supplied. Do not replace
them with desktop screenshots or Chromium layout mocks.

## Store copy and screenshots

The iOS lane reads only `fastlane/ios/metadata` and `fastlane/ios/screenshots`;
it never uploads `fastlane/screenshots`, the Mac set. The first locale is en-US.
App description and keywords avoid unverified claims about RAW model coverage
or 16-bit mobile export. Name, privacy policy, pricing and review contact data
remain in the shared record and need the live checks above.

The screenshot checker requires native iPhone medium Dynamic Island captures
and iPad 13-inch captures, one to ten opaque RGB PNGs per family. Exact accepted
sizes are in the screenshot directory's README. It fully decodes each image,
checks dimensions and rejects blank or missing sets before any upload can
replace existing screenshots. Fastlane skips What's New for the first platform
version; later releases use `release_notes.txt`, which should describe their
actual user-visible changes.

## References

- [GitHub: Apple signing on macOS runners](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications)
- [Tauri: iOS code signing and CI environment variables](https://v2.tauri.app/distribute/sign/ios/)
- [Tauri: App Store export and bundle versions](https://v2.tauri.app/distribute/app-store/)
- [Fastlane: App Store upload and automatic release](https://docs.fastlane.tools/actions/upload_to_app_store/)
- [Apple: platform records](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-platforms/)
- [Apple: release after approval](https://developer.apple.com/help/app-store-connect/manage-your-apps-availability/select-an-app-store-version-release-option/)
- [Apple: screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/)
