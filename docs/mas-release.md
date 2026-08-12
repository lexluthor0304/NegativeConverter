# Mac App Store auto-release

Every push to `main` runs `.github/workflows/desktop-release.yml`. After the
GitHub Release + R2 sync succeed, the `mas-appstore` job builds the sandboxed
Mac App Store package (`scripts/build-mas.sh`), uploads it with fastlane
(`fastlane/Fastfile`, lane `mac mas_upload`), submits it for review, and lets
it release automatically once Apple approves. If any required secret is
missing the job skips with a notice instead of failing.

The web app on Vercel deploys on every merge regardless; this pipeline only
concerns the packaged desktop app.

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
  `(major*10000 + minor*100 + patch) * 100 + (run_attempt - 1)`
  (e.g. `1.0.2` → `1000200`). Mac App Store build numbers must increase
  across **all** uploads, and the attempt digit lets a re-run re-upload the
  same version after a failed submission.
- "What's New" is generated from `git log` between the previous tag and HEAD
  (capped at 3500 chars, fallback "Bug fixes and improvements."), applied to
  all locales.

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
