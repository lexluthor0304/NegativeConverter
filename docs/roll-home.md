# The roll's home: metadata, contact sheet, project file, recipes

Roadmap items #157, #158, #159 and #160. Once a roll is converted the app is
where its digital life begins, so it also writes what a film photographer
cares about into the files, prints the roll as a contact sheet, keeps the
whole roll state in one project file and lets a conversion travel as a
short recipe code. Nothing leaves the browser.

## Analog metadata in EXIF and XMP (#157)

**Roll & frame** drawer in the Edit tab. Roll fields (roll name, stock,
ISO, camera, lens, process / developer, lab, date) are session-wide; frame
fields (frame number, notes) are a per-file setting (`settings.frameMetadata`).
The DX read prefills the stock; an empty frame number becomes the frame's
position in the export order, so a batch numbers its frames in roll order.

Every export carries the data, whatever the container:

- **TIFF** — IFD0 gets ImageDescription, Model, Software, DateTime and the
  XMP packet (tag 700); an Exif sub-IFD holds ISOSpeedRatings,
  DateTimeOriginal / Digitized, LensModel and a UNICODE UserComment.
  `workers/tiffWriter.js` lays out IFDs, out-of-line values and data blocks,
  and `encodeTiffBlob` is built on it (`buildTiffParts` keeps the pixel
  strip out of any second copy).
- **PNG** — an `eXIf` chunk with the same TIFF-structured payload and an
  `iTXt` chunk under `XML:com.adobe.xmp`, spliced in after IHDR
  (`exportMetadata.js`), so the encoded image is not touched.
- **JPEG** — APP1 EXIF and APP1 XMP segments spliced after the JFIF APP0.

The XMP packet (`analogMetadata.buildXmpPacket`) uses the AnalogExif
community schema, `http://analogexif.sourceforge.net/ns` (Film, RollId,
ExposureNumber, DevelopProcess, Lab, ScannerSoftware), `dc:subject`
keywords for the stock and the lab (Lightroom shows them as keywords),
`dc:description` for the notes, and the exif / tiff / aux basics. The
sprocket border's edge text and frame number default to the stock and the
frame number while the user has not typed their own. `exiftool -a -G1` on
an export lists every field; `tiffWriter.test.mjs` and
`exifWriter.test.mjs` parse the containers back in Node.

## Contact sheet (#158)

**Contact sheet** in the export menu. The selected photos, in roll order,
on A4 (2480 × 3508) or Letter (2550 × 3300) pages at 300 dpi: a header from
the roll metadata, frames in a grid with the frame number under each, and
optionally the sprocket border with the frame number on the rebate. Layouts:
35mm 6 × 6, half-frame 8 × 9, 120 in 6×6 (4 × 5), 6×7 (4 × 4) and 6×9
(3 × 4) grids, panoramic 2 × 6; more frames continue on further pages.
Frames go through the batch conversion path, are downscaled to twice the
cell size and drawn with a neutral sans; the sheet is a PNG, or a TIFF when
that is the export format, with the roll's XMP attached. `contactSheet.js`
holds the layout maths (tested) and draws through any 2D context. A sheet
renders in about half a second once the frames are converted.

## Roll project file (#159)

**Save project…** / **Open project…** in the batch menu write and read
`<roll>.ncroll.json`: a version field, the photo list (name, size, content
hash over the first megabyte plus the size, path where the platform gives
one), each frame's sanitised settings and colour copy, selection, roll
order, the roll reference, the roll analysis, the lens parameters and the
roll metadata (`rollProject.js`). Reopen by dropping the project file
together with the originals (or through **Open project…**, which accepts
both): files are matched by hash, then by name and size, then by name alone
and reported as changed; missing originals are listed. Curve LUTs and
strokes survive as plain arrays and pass through the same sanitisers as a
live edit. A version bump gets a step in `MIGRATIONS` and a case in
`rollProject.test.mjs` (the unversioned prototype layout migrates today).

A recovery copy of the roll is written to IndexedDB a few seconds after
every change; on the next launch a toast points at **Restore last roll** in
the batch menu, which waits for the originals like a project file. Clearing
the photo list or closing the session drops the copy.

## Shareable recipes (#160)

**Recipe** drawer in the Edit tab. **Copy recipe code** packs this photo's
conversion (film type, preset, colour model, paper, curves, colour
controls, WB, look, sharpening; never crop, rotation, mirror or file data)
into `NC1.<base64url(deflate(json))>` (`recipes.js`): keys travel as their
index in the schema list, curves as point pairs, numbers to four decimals,
and values equal to the photo's automatic defaults are left out, so a
typical recipe is well under 300 characters. Tags (stock, lab, note) ride
along. **Show QR** renders the code with `qrcode-generator`; **Scan QR**
appears where the browser has a `BarcodeDetector` and reads one from the
camera. Pasting a code and **Read recipe** validates it through the
existing sanitisers and lists what would change; **Apply to this photo** or
**Apply to selected** applies it with one undo entry. A code from a newer
schema or a damaged code fails with a message.

## Tests

- `analogMetadata`, `tiffWriter`, `exifWriter`, `contactSheet`,
  `rollProject`, `recipes` — unit tests (`npm test`).
- `scripts/roll-home-smoke.mjs` (`npm run test:smoke -- --roll-home-only`):
  the strip's stock is prefilled, typed fields reach the PNG, TIFF and JPEG
  exports; a contact sheet measures A4 and Letter; the project saves and
  restores the metadata in a fresh page; a recipe copies as a short code
  with a QR, reads back with a diff, applies, and a newer version is refused.
