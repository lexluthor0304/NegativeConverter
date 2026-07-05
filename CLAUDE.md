# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NegativeConverter is a browser-based film negative to positive converter. It processes scanned film negatives entirely client-side (no server uploads) with real-time adjustments. The application has a 1980s cyberpunk aesthetic and supports Chinese, English, and Japanese.

## Development

This project now uses **Vite** for web dev/build and Tauri for desktop packaging.

Run locally:
```bash
npm ci
npm run dev:web
```

Build web assets:
```bash
npm run build:web
```

Run tests (standalone Node assert scripts, colocated as `*.test.mjs`, plus an
SEO-head consistency check over the static pages):
```bash
npm test
```

End-to-end smoke test (drives the real app in headless Chrome via CDP: loads
`negative2positive/test-fixtures/negative-sample.jpg`, converts it through
Step 3, asserts canvas pixels changed and no page errors). Run this after any
change to `main.js`, the pipeline, or the app shell:
```bash
npm run test:smoke
```

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
- **Fonts** bundled via `@fontsource/*` (Inter, Orbitron, Share Tech Mono) — no CDN, offline-safe for Tauri

### UI Theme
The app uses a 1980s American retro (synthwave/darkroom) theme. All design tokens live
in `:root` of `negative2positive/src/styles/app.css`: violet-navy surfaces, magenta
`--accent` for interactive states, cyan `--info` for guidance, gold `--warning`,
`--font-display` (Orbitron) for structural labels, `--font-mono` (Share Tech Mono) for
numeric/OSD readouts. Keep magenta for actions and cyan for information when adding UI.

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
