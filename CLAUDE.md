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

Live demo: https://negative-converter.tokugai.com

## Architecture

### File Structure
```
negative2positive/
├── index.html                  # App shell + DOM markup
├── src/
│   ├── app/main.js             # Main app runtime (module entry)
│   ├── pipeline/               # Conversion routing + adapters
│   ├── render/                 # Histogram/render services
│   └── silvercore/             # Core conversion engine modules
├── index.js                    # LibRaw ES module wrapper
├── worker.js                   # Web Worker for async WASM processing
├── libraw.js                   # WASM module binding
└── libraw.wasm                 # Compiled LibRaw library for RAW format support
```

### Key Technologies
- **HTML5 Canvas** for image rendering and manipulation
- **WebAssembly (LibRaw)** for RAW file decoding (CR2, NEF, ARW, DNG, RW2)
- **Web Workers** for non-blocking RAW processing
- **jQuery 3.6.0** for DOM manipulation
- **UPNG.js** (npm: `upng-js`) for 16-bit PNG support
- **UTIF.js** (npm: `utif`) for TIFF/DNG parsing (iPhone ProRaw)
- **OpenCV.js** (npm: `@techstark/opencv-js`) for automatic border detection / auto crop / auto rotation

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
