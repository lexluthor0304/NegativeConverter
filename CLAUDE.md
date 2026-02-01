# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NegativeConverter is a browser-based film negative to positive converter. It processes scanned film negatives entirely client-side (no server uploads) with real-time adjustments. The application has a 1980s cyberpunk aesthetic and supports Chinese, English, and Japanese.

## Development

**No build system required.** This is a zero-build static web application.

To run locally, serve the `negative2positive/` directory with any static web server:
```bash
npx serve negative2positive
# or
python -m http.server -d negative2positive
```

Live demo: https://neoanaloglab.com

## Architecture

### File Structure
```
negative2positive/
├── index.html    # Complete UI + application logic (~1,265 lines)
├── index.js      # LibRaw ES module wrapper
├── worker.js     # Web Worker for async WASM processing
├── libraw.js     # WASM module binding
└── libraw.wasm   # Compiled LibRaw library for RAW format support
```

### Key Technologies
- **HTML5 Canvas** for image rendering and manipulation
- **WebAssembly (LibRaw)** for RAW file decoding (CR2, NEF, ARW, DNG, RW2)
- **Web Workers** for non-blocking RAW processing
- **jQuery 3.6.0** for DOM manipulation
- **UPNG.js** for 16-bit PNG support
- **UTIF.js** for TIFF/DNG parsing (iPhone ProRaw)

### Dual-Canvas Rendering Strategy
The app uses two canvases for performance:
1. **Preview canvas** (1/4 scale) - Real-time slider feedback
2. **Base pixels** (full resolution) - Final output quality

Slider adjustments update the preview immediately, with debounced (300ms) full-resolution updates after the user stops adjusting.

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
