# Restart render lifetime follow-up

Tracking: [#218](https://github.com/lexluthor0304/NegativeConverter/issues/218), following performance PR #217 and tracker #198.

## Failure and cause

The exact PR tree passed all pre-merge tests and platform builds, but the second, post-merge CI run [35799333350](https://github.com/lexluthor0304/NegativeConverter/actions/runs/35799333350) failed the existing exact-pixel manual-repair/restart assertion. This was a real ordering defect, not a reason to weaken the assertion or repeatedly retry CI.

Turning dust removal off starts a full render with the current adjustments. Restart resets those adjustments and converts the same original image object again. Previously, an older full render could complete after restart and pass both the token and source-reference checks, overwriting the new pixels with the discarded exposure. An extracted-function test forces this ordering: the controls say exposure 0 while the last committed pixels carry exposure 24.

## Fix

- Restart advances a dedicated render generation as well as the slider token, cancels scheduled work and clears discarded queued requests. A dedicated generation is needed because normal slider updates may intentionally display an older preview while a newer preview is pending; restart must not permit that behavior.
- In-flight and queued renders retain their generation, source and token. Replies from a discarded generation cannot commit full or preview pixels.
- Initial-conversion and full-resolution promises only clear state they still own. An old conversion cannot hide the new loading overlay or schedule repair work for the restarted image.
- The export barrier includes direct full/preview renders, such as the dust-off handler, and is notified when they settle. It does not treat a direct asynchronous render as idle merely because it bypassed the debounced wrapper.

The conversion algorithms, export resolution, sample precision, repair masks and existing exact-pixel assertions are unchanged.

## Release chronology

v1.0.27 web and direct-download desktop artifacts were already published by the main release workflow when the second CI run revealed this race. Its production UI and download/update metadata checks passed, but those checks do not negate this defect. The Mac App Store job was cancelled during package build; upload/submission steps were skipped and signing-keychain cleanup succeeded. A corrected patch release requires a separate fully validated PR.

## Verification

The permanent Node tests execute the actual lifecycle functions with controlled asynchronous dependencies. They cover full/preview replies, queued preview supersession, direct-render export barriers on success/error, timer cancellation, locked exports, and ownership of initial/full-resolution promises. The old runtime fails; the corrected runtime passes. All 112 Node test files and the production web build pass on the follow-up tree.

The identical browser regression holds one real 1400×1284 exposure-24 worker reply until after the restarted exposure-0 preview. No pixels are mocked. The old runtime then exports the exact exposure-24 pixels; the fix exports all 7,190,400 RGBA bytes equal to the original exposure-0 baseline. The watchdog did not fire in either comparison.

| Decoded RGBA | SHA-256 |
| --- | --- |
| Exposure-0 baseline and corrected restart | `af22e1d683afcd27888759e1a962de961827911b43ae7dccb8ef04f7b17e68f9` |
| Exposure-24 edit and old defective restart | `ed306cb2a721873d2a710d6af4f80a2254e4023a7040867e9f7cde695e308ddb` |

Reproduce the focused checks with `node negative2positive/src/app/restartRender.test.mjs` and `node scripts/smoke-test.mjs --restart-only`. The held-reply scenario is also included in the complete `npm run test:smoke` suite; the existing exact-pixel manual-brush/restart assertion is retained unchanged. Full browser/RAW, compiled-build, four-platform CI and actual corrected-release gates are recorded in #218 rather than inferred from these focused results.
