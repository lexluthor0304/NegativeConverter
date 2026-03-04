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
- 🔍 **Optional lens profile workflow**: search/select Lensfun profiles manually, or skip lens correction and continue
- 🧷 **Roll-level lens settings**: lens correction on/off and parameters can be applied to selected files or reused via roll reference
- 🛡️ **Privacy-friendly**: all image processing happens locally in your browser
- 💾 **Flexible export**: PNG / JPEG / TIFF with selectable bit depth (8-bit, plus 16-bit for PNG/TIFF)

## 🚀 How to Use

### Workflow (Step 1 → 3)

1. **Step 1: Crop**
   - Rotate / Auto Frame / Crop until only the film area remains
   - Click **Next: Film Settings** (negatives) or **Next: Positive Mode** (slides)
2. **Step 2: Film Settings**
   - Pick film type: **Color**, **B&W**, or **Positive**
   - **Color negatives**: set the mask baseline (sample manually / auto-detect / roll reference)
   - Click **Next: Convert and Continue**
3. **Step 3: Adjust & Export**
   - White balance + sliders + curves to taste
   - Export PNG / JPEG / TIFF

### Film type quickstart

- **Color negative**: Step 1 → **Next: Film Settings** → keep **Color** → set mask → **Next: Convert and Continue** → Step 3
- **B&W negative**: Step 1 → **Next: Film Settings** → select **B&W** → **Next: Convert and Continue** (no mask) → Step 3
- **Positive slide**: Step 1 → **Next: Positive Mode** (or select **Positive** in Step 2) → **Next: Convert and Continue** → Step 3

### Batch workflow (multiple files)

1. Click **Add** and choose multiple images (File List appears)
2. Process one frame fully to Step 3
3. Use **Save Settings** for the current frame, or **Apply to Selected** for roll-wide settings
4. (Optional) Use **Set Current as Reference** + **Apply Reference to Selected** for roll reference
5. Export via **Export All (ZIP)** or **Download All Individually**

### Guided Mode

- The Workflow panel includes a **Guide** toggle to show/hide in-app instructions (stored in localStorage)

## ⚙️ Technical Highlights

- Uses [`UPNG.js`](https://github.com/photopea/UPNG.js) to decode 16-bit PNGs  
- Uses a custom WebAssembly module based on [`LibRaw-Wasm`](https://github.com/ybouane/LibRaw-Wasm) to support `.cr2`, `.nef`, `.arw`, `.dng`, `.raw`, `.rw2` formats  
- Uses UTIF.js + an in-app PNG encoder path to support TIFF export and 16-bit PNG/TIFF output options  
- Includes a simplified AHD demosaicing algorithm for Bayer-pattern raw data  
- Color adjustment logic is based on RGB ↔ HSL and RGB ↔ CMY conversions  
- Film preset metadata is loaded from JSON and grouped dynamically by film type in the UI  
- Optional lens correction uses [`@neoanaloglabkk/lensfun-wasm`](https://www.jsdelivr.com/package/npm/@neoanaloglabkk/lensfun-wasm) with **npm local assets first + CDN fallback**  
- Auto frame detection uses [`@techstark/opencv-js`](https://www.npmjs.com/package/@techstark/opencv-js) loaded dynamically from the npm package asset URL  
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
npm run dev:web
```

### Desktop dev (Tauri)

```bash
npm run tauri:dev
```

### Build installers

```bash
npm run tauri:build
```

Build outputs are placed under:
- `src-tauri/target/release/bundle/`

### Linux AppImage troubleshooting

- Run AppImage directly, not with `sudo`.
- The desktop app now applies AppImage-only runtime guards:
  - isolates GIO module loading to avoid host `gvfs`/GLib ABI mismatches
  - standard AppImage keeps DMABUF when render nodes are usable, and auto-falls back when not
  - compatibility AppImage (`*_legacy-glibc235.AppImage`) defaults DMABUF off for startup stability
- Optional override for DMABUF behavior:
  - force enable: `NEGATIVE_CONVERTER_DMABUF=on ./Negative\ Converter*.AppImage`
  - force disable: `NEGATIVE_CONVERTER_DMABUF=off ./Negative\ Converter*.AppImage`
- If startup still fails on older distros, use the compatibility AppImage (`*_legacy-glibc235.AppImage`).

### Release (GitHub Actions)

1. Update versions:
   - `src-tauri/tauri.conf.json`
   - `src-tauri/Cargo.toml`
2. Merge to `main`
3. GitHub Actions automatically:
   - creates a `vX.Y.Z` tag
   - publishes a GitHub Release with the installers
   - (optional) syncs installers to Cloudflare R2 under `negative-converter/release/vX.Y.Z/`

#### Cloudflare R2 sync (optional)

If you want the release workflow to upload installers to R2, add **one** of these GitHub Actions secret sets:

**Option A: R2 S3 API token**

- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET`
- `R2_ENDPOINT` (e.g. `https://<accountid>.r2.cloudflarestorage.com/`)

**Option B: Cloudflare API token (no S3 keys)**

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `R2_BUCKET`

## 💡 Development & Contributions

Feel free to fork, open issues, or submit pull requests with ideas or improvements.  
This tool is designed to be simple, fast, and modifiable.

## 📄 License

MIT License

## 🙏 Acknowledgments

Special thanks to [LibRaw-Wasm by ybouane](https://github.com/ybouane/LibRaw-Wasm),  
which made it possible to support various raw image formats such as `.cr2`, `.nef`, `.arw`, `.dng`, `.raw`, and `.rw2` directly in the browser via WebAssembly.  
Your work was an essential reference and greatly accelerated development.
