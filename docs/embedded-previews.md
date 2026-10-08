# Embedded RAW previews (#235)

Camera RAWs in TIFF containers carry baseline JPEG previews. The Studio uses
them only for presentation: a provisional frame in the switch veil during a
cold open or import, and provisional filmstrip / light-table tiles. They are
never an editing, analysis or export source (see `photo-sessions.md`).

## Locator (`app/rawEmbeddedPreview.js`)

`locateEmbeddedPreviews(blob)` reads only `Blob.slice(a, b).arrayBuffer()`:
a 16 KiB head, a 4 KiB chunk for any IFD outside it (IFD0 at the file tail on
some M11 files, NEF SubIFDs past 256 KiB), and a 2 KiB head of each candidate
JPEG (extended up to 64 KiB when APP segments push the SOF further).

- `II`/`MM` with magic 0x2A, or RW2's 0x55. IFD0, the SubIFD arrays (tag 330,
  recursively) and every next-IFD chain are walked with a visited set, at most
  64 IFDs and 4096 entries per IFD, and bounds checks against `blob.size`.
  Malformed or non-TIFF input, or a container without a usable preview,
  returns null and never throws.
- Candidates: single-strip 273/279 with Compression 6 or 7 and Photometric 6,
  2 or absent (never 32803 CFA or 34892 LinearRaw, so the M11's 72 MB
  Compression-7 raw strip in IFD0 is rejected before any read), and
  513/514 JPEGInterchangeFormat. NewSubFileType is not required (CR2 IFD0).
- Each candidate must start with SOI and reach SOF0/1/2 at 8-bit precision;
  width and height come from the SOF (`jpegHeader.js`, shared with the HE NEF
  fallback, which keeps its 1000 px floor). Lossless SOF3 strips, JPEG XL
  (52546) and lossy-DNG previews are rejected on every platform.
- Returns `{ previews: [{ offset, length, width, height, exifOrientation }],
  orientation, rawSize, bytesRead }`; `orientation` is IFD0 tag 274 and
  `rawSize` the full-resolution CFA/LinearRaw IFD, used to scale crops.
- `pickForViewer(previews, longSidePx)`: among previews of at most 4 MP, the
  smallest whose long side reaches 0.8 × the viewer's device-pixel long side,
  else the largest of at most 4 MP (M11 2112 × 1408, NEF 1620 × 1080; the 60 MP
  and 24 MP previews are never displayed). `pickForTile(previews, 288)`: the
  smallest with a long side of at least 288 px (M11 720 × 480).

On the repo fixtures the IFD walk plus SOF checks read 23-27 KB
(`rawEmbeddedPreview.test.mjs` checks them when they sit at the repo root).
Adobe DNG Converter's `_DSC5290.dng` has JPEG XL previews, which are skipped,
and one baseline 1024 × 683 preview, which is used.

## Worker (`workers/scanDecodeWorker.js`, `app/scanDecodeClient.js`)

The scan-decode worker probes its capability at startup by decoding a real
1 × 1 JPEG with `createImageBitmap` and drawing it into an `OffscreenCanvas`
2D context, then posts `{ ready: true, canDecodeImages }`. PNG/TIFF scan jobs
keep one worker per decode and today's ready handshake; UPNG and UTIF load
lazily.

- `embedded-preview` jobs receive the `File` by reference, locate (unless the
  client passes a cached location), decode the picked preview slice, apply the
  TIFF Orientation only when the JPEG has no Exif Orientation of its own
  (`createImageBitmap` applies that one; never both), map base → rotation →
  mirror → crop, tone it (`embeddedPreviewRender.js`) and return an
  `ImageBitmap` (viewer) or a JPEG data URL (tiles, `FileReaderSync`).
- `createEmbeddedPreviewPool` keeps at most two workers and four jobs in
  flight, lower priority first (viewer frame, first photo, visible rows, the
  rest). One worker stays warm while the queue holds TIFF RAWs; clearing the
  queue terminates the pool. Without the capability, viewer frames are skipped
  and tiles are rendered on the main thread one per animation frame.
- The HE NEF fallback (`decodeNefPreviewJpeg`) tries a `jpeg` job first: a
  `willReadFrequently` OffscreenCanvas readback and the ×257 mirror in the
  worker, both planes transferred. The client resolves null before
  transferring when the capability is missing, so the stashed bytes stay
  intact for today's main-thread decoder; a failed worker decode hands them
  back. It still decodes the same JPEG `extractNefPreviewJpeg` picks (the
  largest at least 1000 px wide); the two paths must produce identical planes.

WebKit decodes `createImageBitmap(Blob)` on the calling thread, so none of this
runs on the page's main thread wherever the capability exists.

## Verification

```sh
npm test    # rawEmbeddedPreview, embeddedPreviewRender, scanDecodeClient,
            # nefJpegPreview.parity, provisionalPreview, thumbnailRank,
            # rollTileProvenance, ...
PORT=5215 CDP_PORT=9239 npm run test:smoke -- --embedded-preview-only
AUTOFRAME_RAW_DIR=/path/to/nefs npm run test:smoke -- --embedded-preview-only
node scripts/check-embedded-previews.mjs /path/to/m11-roll --expect-m11
```

The smoke builds synthetic `.dng` containers in the page (a UTIF-decodable RGB
IFD0 plus browser-encoded JPEG previews) and checks the capability, the read
budget, worker/main-thread HE NEF plane hashes (also on the repo NEFs when a
directory is given), the provisional import frame while the container read is
held, embedded tiles at import, forward-only tile ranks and the cold-switch
thumbnail → embedded → exact sequence. A second import then commits a roll
analysis while two frames still show embedded tiles and undoes it: those
tiles come back `embedded` and pending, and a cold switch to one posts its
provisional frame without a colour-match target. `check-embedded-previews.mjs` walks a
real folder (header slices only) and, with `--expect-m11`, requires the
2112 × 1408 viewer and 720 × 480 tile picks within the read budget on every
file (`L1009967.dng`: tile path 100 KB, viewer path 560 KB). Timing targets (≤ 300 ms import,
≤ 200 ms p95 cold switch, tiles ≤ 3 s for 151 DNGs) belong to the #230
benchmark on the real roll.
