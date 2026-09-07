# Film Negative → Positive Converter

<p align="center">
  <img src="img/SAMPLE.jpg" alt="Negative Converter sample output" width="100%">
</p>

Negative Converter helps film photographers turn scanned or camera-digitized film into clean, natural-looking positives with a workflow made for everyday editing. It brings frame cleanup, film-aware conversion, roll consistency, finishing controls, and export into one focused workspace.

Whether you are reviewing a fresh roll, restoring family negatives, or preparing a consistent set for sharing, the app is designed to make film conversion feel fast, approachable, and dependable while keeping your photos private.

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
- 🔍 **Film edge reader**: whole-strip scans that show the perforations get their DX edge barcode decoded (ISO 1007), the stock named from The Big Film Database, a matching preset suggested and the film base sampled from the unexposed rebate (see `docs/film-edge-reader.md`)
- 🎞️ **Roll analysis**: analyse the selected frames together like a minilab — one film base and one tone analysis for the roll, a per-frame exposure offset, and frames that do not belong flagged as outliers (see `docs/roll-analysis.md`)
- 🗂️ **Light table**: grow the film strip into a thumbnail grid of the whole roll with stock and outlier badges, RAW thumbnails and keyboard navigation (see `docs/light-table.md`)
- 🔬 **Darkroom paradigm**: a test strip of patches along one axis (click to apply), enlarger controls with CMY filtration, exposure in stops and multigrade paper grades, a dodge & burn brush applied in linear light before the curves and at full resolution on export, and paper emulation for RA-4 and B&W papers with toning (see `docs/darkroom.md`)
- 📷 **Camera scanning**: a flat field from a blank light-pad frame removes the pad's falloff before inversion, a lab scan of the same frame is aligned and its look fitted as a colour matrix plus curves, 2–5 shots of one frame merge as a noise-averaged or HDR 16-bit file, and a live loupe converts the camera feed through the current recipe and captures into the photo list (see `docs/camera-scanning.md`)
- 🗃️ **The roll's home**: film stock, ISO, camera, lens, lab and frame numbers written into EXIF/XMP (AnalogExif schema) on every export, a printable 300 dpi contact sheet with sprockets and frame numbers, a project file that saves and reopens the whole roll (with an IndexedDB recovery copy), and shareable conversion recipes as short codes or QR (see `docs/roll-home.md`)
- 🔬 **Technical depth**: the Step-3 adjustments run at 16 bits on export so 16-bit PNG/TIFF carry real 16-bit data, a linear DNG export (inverted, film-base normalised, no tone curve) for Lightroom / Capture One, and on-device AI dust repair with bundled MI-GAN over the mask's tiles, falling back to TELEA (see `docs/technical-depth.md`)
- 🧪 **Expired film rescue**: a separate entry and flow for aged rolls, negatives and positives alike — fog, overall cast, shadow/highlight crossover and lost speed are measured on the positive and corrected by density (a colour table over luminance plus one shared tone curve), and OpenCV.js measures what varies across the frame (uneven fog surface, local contrast), with a diagnosis and seven strengths on the preview, the 16-bit export and batch exports (see `docs/expired-film-rescue.md`)
- 🗂️ **Data-driven preset system** defined in `negative2positive/src/silvercore/engine/FilmPresets.js` (supports alias fallback for older preset IDs)
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

- Studio is the only workspace: automatic conversion, color-first controls, and dedicated Crop / Retouch / Border / Convert tabs.

## ⚙️ Technical Highlights

- Uses [`UPNG.js`](https://github.com/photopea/UPNG.js) to decode 16-bit PNGs  
- Uses the [`libraw-wasm`](https://www.npmjs.com/package/libraw-wasm) npm package to support `.cr2`, `.nef`, `.arw`, `.dng`, `.raw`, `.rw2` formats
- Uses UTIF.js + an in-app PNG encoder path to support TIFF export and 16-bit PNG/TIFF output options  
- Color adjustment logic is based on RGB ↔ HSL and RGB ↔ CMY conversions  
- Film preset metadata lives in `FilmPresets.js` and is grouped dynamically by film type in the UI
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

### Vercel deployment (important)

This app must be deployed from the **Vite build output**, not by serving source files directly.

Required settings (as recorded in `.vercel/project.json`):

- Root Directory: `negative2positive`
- Install Command: `npm ci`
- Build Command: `npm run build:web`
- Output Directory: `negative2positive/dist`

`npm run build:web` generates `negative2positive/dist` (for local/Tauri) and also syncs it to root `dist`.

Because the Root Directory is `negative2positive`, Vercel reads `negative2positive/vercel.json` (cache and security headers); the repository-root `vercel.json` is not applied to the deployment.

If Vercel serves `negative2positive/index.html` directly, module imports like `pako` / `utif` / `jszip` will not resolve in browser and upload buttons can stop working.

#### Feedback endpoint

The header Feedback button posts to `negative2positive/api/feedback.mjs` (a Vercel serverless function). The Vercel project's Root Directory is `negative2positive`, so functions MUST live under `negative2positive/api/` — an `api/` directory at the repository root is silently ignored. The function files the message as a GitHub issue labeled `feedback`. Configure in Vercel → Project → Settings → Environment Variables:

- `FEEDBACK_GITHUB_TOKEN` (required): fine-grained personal access token with **Issues: Read and write** and **Contents: Read and write** on the target repo. Contents is what lets attached screenshots be uploaded to the orphan `feedback-assets` branch, which must already exist — without it the issue is still filed but the images are silently dropped. Without the token entirely the endpoint returns 503 and the form shows the error state.
- `FEEDBACK_GITHUB_REPO` (optional): `owner/repo` to file issues in; defaults to `lexluthor0304/NegativeConverter`.

The endpoint allows cross-origin calls only from the production domain, Tauri desktop webviews, and localhost dev servers.

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

### macOS installation troubleshooting

If macOS shows **"Negative Converter is damaged and can't be opened"**, this is because the app is not yet notarized by Apple. Use one of these methods:

**Method 1 — Terminal command (recommended):**
```bash
xattr -cr /Applications/Negative\ Converter.app
```

**Method 2 — Right-click open:**
Right-click (or Control-click) the app → select **Open** → click **Open** in the confirmation dialog.

**Method 3 — System Settings:**
Go to **System Settings → Privacy & Security**, scroll down and click **Open Anyway** next to the blocked app message.

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
