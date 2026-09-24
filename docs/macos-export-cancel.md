# macOS Save cancellation and ONNX memory growth

Cancelling the native Save panel must retain the selected photo, preview and
adjustments. The single-export handler opens the panel before any full-size
render or encoding, returns immediately on cancellation, and prevents duplicate
export requests. A confirmed path is reused by the chunked writer.

## WebKit runtime compatibility

The apparent navigation to the import screen was a WebContent process restart.
On macOS 26.6.2 / WebKit 21624.5.1.11.3, the ONNX JSEP runtime continued compiling
WASM after inference, exceeded the process's 8 GB limit and was killed. It
reproduced while idle with both a 60 MP DNG and a 9 KB PNG. Native sampling
identified `parseAndCompileOMG` / `allocateRegistersByGreedy` worklist threads.

This matches [ONNX Runtime #26827](https://github.com/microsoft/onnxruntime/issues/26827)
and [WebKit #304810](https://bugs.webkit.org/show_bug.cgi?id=304810). Merely setting
`executionProviders: ['wasm']` in the WebGPU bundle does not avoid JSEP.

`inferenceRuntime.js` chooses the **non-JSEP** runtime and its matching bundled
WASM binary on WebKit, for both MI-GAN and semantic analysis. Other browsers
retain the WebGPU runtime and CPU fallback. Each realm loads only one runtime,
so provider registrations cannot overwrite each other. No model is sent off-device.

A WebContent kill is now recorded by the native
`on_web_content_process_terminate` hook before it reloads the page, unfinished
export streams and their `.part` files are dropped when a page starts loading,
and an interrupted batch export or roll analysis is named at boot and resumed
from its job marker (`docs/hidden-window-jobs.md`). The window also runs with
background throttling disabled, so a hidden export is no longer suspended.

Large images also defer automatic full-resolution conversion until export or
repair needs it. The RAW decoder and large conversion-worker caches are released
as soon as their owned results are available. Preview and export keep their
existing bit depth and resolution.

## Regression checks

- `scripts/export-cancel-smoke.mjs`: real click handler, native IPC substituted;
  repeated PNG/JPEG/TIFF/DNG cancellation, duplicate clicks, picker failure,
  retry and confirmed write. Cancellation preserves preview pixels and settings
  with no worker, encoder or write activity. Since #257 it also holds one
  `append_export_chunk` open: the overlay must show "Saving… x / y MB" and
  Cancel until `finish_export_write`, close without a dwell, and toast the
  saved file name. Cancel during the write must call `abort_export_write`
  and never `finish_export_write`.
- Real native app: import `L1009967.dng`, set C +1, cancel Save twice, then save.
  The photo and adjustment stay open; the PNG is 9536 × 6336. In the local check,
  idle footprint fell from 2439 MB to 1690 MB instead of growing to 8 GB.
- Run the full Chrome smoke suite as well: the repair model loading only on
  intent (Retouch tab, dust removal, brush; never on photo import), actual
  inference, manual brush, CPU fallback, 16-bit preservation, and
  full-resolution export.
