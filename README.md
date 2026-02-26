# 🎞️ Film Negative → Positive Converter

This is a browser-based tool built with HTML and JavaScript that converts scanned film negatives into positive images. It features real-time image adjustments such as rotation, cropping, white balance, temperature, tint, vibrance, saturation, and **cyan/magenta/yellow (CMY) fine-tuning** — all styled in a nostalgic 1980s American cyberpunk aesthetic.

## 🌟 Features

- 📷 **Supports PNG/JPG file uploads** (including 16-bit PNGs via UPNG.js and .cr2, .nef, .arw, .dng, .raw, .rw2 raw files via LibRaw-Wasm)
- 🔄 **Rotation correction** via slider or number input
- ✂️ **Visual cropping** with drag-and-drop overlay
- ⚖️ **One-click white balance** by clicking a gray area in the image
- 🎛️ **Live controls** for:
  - Temperature & Tint
  - Vibrance & Saturation
  - Cyan / Magenta / Yellow (CMY) channels
- 🎞️ **Film presets** for color negative, B&W negative, and positive slide stocks across Kodak / Fujifilm / Ilford
- 🗂️ **Data-driven preset system** loaded from `negative2positive/presets/film_presets.json` (supports alias fallback for older preset IDs)
- 🛡️ **Privacy-friendly**: all image processing happens locally in your browser
- 💾 **One-click download** of the final corrected image

## 🚀 How to Use

1. Open `index.html` in any modern browser (Chrome/Edge/Firefox recommended)
2. Click **Choose File** to upload your scanned film negative (PNG, JPG, or DNG)
3. Use the **Rotation** slider or number box to align your image, then click **Apply Rotation**
4. Click **Start Crop**, draw a box with your mouse, and click **Apply** to crop
5. Click on a neutral gray area in the image to perform **White Balance**
6. Use sliders or number inputs to fine-tune:
   - **Temperature**, **Tint**
   - **Vibrance**, **Saturation**
   - **Cyan**, **Magenta**, **Yellow**
7. Click **Download Corrected Image** to save your final result

## ⚙️ Technical Highlights

- Uses [`UPNG.js`](https://github.com/photopea/UPNG.js) to decode 16-bit PNGs  
- Uses a custom WebAssembly module based on [`LibRaw-Wasm`](https://github.com/ybouane/LibRaw-Wasm) to support `.cr2`, `.nef`, `.arw`, `.dng`, `.raw`, `.rw2` formats  
- Includes a simplified AHD demosaicing algorithm for Bayer-pattern raw data  
- Color adjustment logic is based on RGB ↔ HSL and RGB ↔ CMY conversions  
- Film preset metadata is loaded from JSON and grouped dynamically by film type in the UI  
- Auto frame detection uses OpenCV.js from `negative2positive/vendor/opencv/opencv-4.12.0.js`  
- Performance optimizations include:
  - Cached DOM access
  - Offscreen canvas reuse
  - Throttled rendering with `requestAnimationFrame`

## Live Demo

[Film Negative → Positive Converter](https://negative-converter.tokugai.com)

## 🖥️ Desktop App (Tauri)

This repo includes a Tauri wrapper to package the web app as an offline desktop application for Windows / macOS / Linux.

### Development

```bash
npm ci
npm run tauri:dev
```

### Build installers

```bash
npm run tauri:build
```

Build outputs are placed under:
- `src-tauri/target/release/bundle/`

### Release (GitHub Actions)

1. Update versions:
   - `src-tauri/tauri.conf.json`
   - `src-tauri/Cargo.toml`
2. Merge to `main`
3. GitHub Actions automatically:
   - creates a `vX.Y.Z` tag
   - publishes a GitHub Release with the installers

## 💡 Development & Contributions

Feel free to fork, open issues, or submit pull requests with ideas or improvements.  
This tool is designed to be simple, fast, and modifiable.

## 📄 License

MIT License

## 🙏 Acknowledgments

Special thanks to [LibRaw-Wasm by ybouane](https://github.com/ybouane/LibRaw-Wasm),  
which made it possible to support various raw image formats such as `.cr2`, `.nef`, `.arw`, `.dng`, `.raw`, and `.rw2` directly in the browser via WebAssembly.  
Your work was an essential reference and greatly accelerated development.
