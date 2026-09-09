# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NegativeConverter is a browser-based film negative to positive converter. It processes scanned film negatives entirely client-side (no server uploads) with real-time adjustments. The application has a 1980s cyberpunk aesthetic and supports Chinese, English, and Japanese.

## Development

This project now uses **Vite** for web dev/build and Tauri for desktop packaging.

Merging to `main` auto-releases the desktop app (GitHub Release + R2), and —
when the App Store secrets are configured — builds, uploads, and submits the
Mac App Store version too (see `docs/mas-release.md`). The direct-download
builds then update themselves in-app from `updater.json` on R2
(`docs/desktop-updater.md`); the App Store build is compiled without the
`updater` cargo feature.

Run locally:
```bash
npm ci
npm run dev:web
```

Build web assets:
```bash
npm run build:web
```

Run tests (standalone Node assert scripts, colocated as `*.test.mjs`, plus
repo-wide consistency checks: SEO heads and FAQ structured data over the static
pages, pinned dependency versions, and the two Vercel header configs):
```bash
npm test
```

Rust unit tests for the desktop layer (URL validation, export path grants):
```bash
npm run test:rust
```

実際の Chrome / CDP で唯一の Studio 画面に画像を読み込み、自動変換・除塵・曲線・
履歴・一括書き出し・裁切時の色解析・ピクセル字体を検証する。
`main.js`、パイプライン、画面構成を変更したら実行する:
```bash
npm run test:smoke
```

CI (`.github/workflows/desktop-ci.yml`) runs all three on every pull request
before the four-platform Tauri build.

When several agents or worktrees edit `negative2positive/` at once, the smoke
test cannot be trusted: the Vite dev server hot-reloads mid-run and it fails on
someone else's half-written file. Run it from an isolated `git worktree` with
its own `PORT`/`CDP_PORT` instead.

Known issues that were reviewed but not fixed are queued in
`docs/audit-backlog.md`; delete an entry when it is done.

Live demo: https://negative-converter.tokugai.com

## Architecture

### File Structure
```
negative2positive/
├── index.html                  # App shell + DOM markup (SEO pages: guide.html etc. alongside)
├── vite.config.js              # Multi-page Vite build (app + SEO pages)
├── src/
│   ├── app/main.js             # Main app runtime (module entry, all UI wiring)
│   ├── app/i18n.js             # zh/en/ja translation dictionary (data-i18n keys)
│   ├── app/*.js                # Loaders, encoders, analyzers (+ colocated *.test.mjs)
│   ├── styles/app.css          # All app styles — 1980s retro theme, design tokens in :root
│   ├── pipeline/               # Conversion routing + adapters
│   ├── render/                 # Histogram/render services
│   ├── silvercore/             # Core conversion engine modules
│   ├── ui/                     # UI components (loading overlay)
│   └── workers/                # Export worker + full-res conversion worker + bridges
scripts/                        # run-tests.mjs, sync-web-dist.mjs, LUT derivation
src-tauri/                      # Tauri desktop packaging
```

### Key Technologies
- **HTML5 Canvas / WebGL** for image rendering and manipulation
- **libraw-wasm** (npm) for RAW file decoding (CR2, NEF, ARW, DNG, RW2)
- **Web Workers** for non-blocking RAW processing and export encoding
- **UPNG.js** (npm: `upng-js`) for 16-bit PNG support
- **UTIF.js** (npm: `utif`) for TIFF/DNG parsing (iPhone ProRaw)
- **OpenCV.js** (npm: `@techstark/opencv-js`) for automatic border detection / auto crop / auto rotation
- **Fonts**: Fusion Pixel 12px proportional を `public/fonts/fusion-pixel/` にライセンスとともに同梱。英字・CJK 対応、CDN 不要、Tauri オフライン対応。

### UI Theme
Studio が唯一の画面。旧 `workspace=classic` パラメーターも同じ画面を開く。
`negative2positive/src/styles/studio.css` の中立的なダークグレーと暖色アクセントを使う。
`pixel-fonts.css` で英字・CJK のピクセル字体を指定し、基本 12px、見出し 24px / 36px とする。
`studio-pixel.css` は方角の部品と `steps()` の 8-bit 動作を担当。写真の描画にピクセル化を適用しない。
旧ヘッダー・フッター・段階ガイド・表示モード切替の DOM は削除済み。再導入しない。
空状態の `canvasTransformWrapper` はレイアウトから外し、アップロード欄を押し出さない。
ブランド名は NeoAnalogLab。既存の共用コントロール・画像処理・履歴・一括処理を再利用し、旧画面への分岐を追加しない。

### Geometry Chain
Transforms compose in one fixed order, and every path that rebuilds an image
must follow it: **base → rotation → mirror → crop**. `state.rotationAngle` is
measured on the unmirrored base, so an angle the user applies to a mirrored view
is stored negated (`storedRotationDelta` in `main.js`) — mirroring reverses the
sense of rotation. `state.cropRegion` is relative to the post-mirror
`originalImageData`. `rebuildGeometryFromBase()` is the reference
implementation; `restoreSettings` and the batch export path reproduce it.

### Expired Film Rescue
A separate entry (welcome button / menu) and Studio tab for aged rolls. It is
a post-conversion stage on the positive: `pipeline/expiredRescue.js` measures
fog, cast, crossover and exposure by density, and its colour table (over
luminance) plus shared tone curve run first in the Step-3 adjustment chain
(8-bit and 16-bit); `app/expiredRescueOpenCv.js` adds the OpenCV fog surface.
Negatives convert as usual first; positives are rescued directly. See
`docs/expired-film-rescue.md`.

### Rendering Strategy
The app keeps dual-path rendering behavior:
1. **Preview path** for responsive slider feedback.
2. **Full-resolution path** for export correctness.

### Image Processing Pipeline
1. File upload → Format detection → Decoder dispatch (LibRaw/UTIF/Canvas API)
2. Color inversion (negative to positive)
3. Transformations: Rotation → Cropping → White Balance
4. Color adjustments: Temperature, Tint, Vibrance, Saturation, CMY channels
5. Download as PNG

### Color Space Conversions
The codebase includes RGB ↔ HSL and RGB ↔ CMY conversions applied per-pixel during adjustments. These functions exist in both preview and full-res update paths.

## Supported Formats
- Standard: PNG, JPG/JPEG
- 16-bit PNG (via UPNG.js)
- RAW: CR2 (Canon), NEF (Nikon), ARW (Sony), DNG (Adobe), RW2 (Panasonic)
- iPhone DNG (ProRaw) - Special handling via UTIF.js
