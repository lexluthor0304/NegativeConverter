Add reviewed captures from the native iOS app (device or simulator) under
`en-US/` before enabling App Store submission. No placeholder images are shipped.

- `iphone-medium-*.png`: 1179 x 2556 or 1206 x 2622, or landscape equivalents.
- `ipad13-*.png`: 2064 x 2752 or 2048 x 2732, or landscape equivalents.

Use one to ten screenshots for each family, opaque RGB PNGs. The checker decodes
each image and rejects invalid dimensions, blank images and missing families.
These are separate from `fastlane/screenshots`, which contains Mac assets.

Capture the import screen and a real film conversion with editing controls.
Browser layout regression screenshots are not native App Store captures.

Source (checked 2026-10-19):
https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/

Producing them: the two `Store screenshots (… simulator)` jobs in
`.github/workflows/ios-ci.yml` (one per family) build the self-test simulator
app with `negative2positive/test-fixtures/store-negative.jpg`, capture the
import screen and the editor after a real conversion on an iPhone 17 Pro or an
iPad Pro 13-inch simulator (`scripts/ios-store-screenshots.sh`, `FAMILIES`),
strip the alpha channel and run `scripts/check-ios-store-assets.mjs`. Download
the `ios-store-screenshots-iphone` and `ios-store-screenshots-ipad` artifacts,
review every image, then commit the PNGs here with their `iphone-medium-*` /
`ipad13-*` names.
