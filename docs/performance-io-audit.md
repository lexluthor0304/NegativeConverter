# Import, scheduling, and export performance audit

Verified on 2026-09-22 with Node 26.5.1. These deterministic synthetic fixtures
isolate codec and scheduling costs; they are not real-camera RAW benchmarks.
The baseline was the unchanged `/Users/lex/NegativeConverter` checkout and the
implementation was its isolated `NegativeConverter-performance` worktree.

Reproduce against any preserved baseline checkout:

```sh
node scripts/performance-io-benchmark.mjs /path/to/baseline
```

## Findings and measured changes

| Issue | Trigger and cause | Verified result |
| --- | --- | --- |
| #199 | A slow first job let later completed payloads release their scheduler lanes before their ordered sink ran. | With 100 jobs, 2 lanes, and 1 MiB payloads, started jobs fell from 100 to 2 and queued output from 99 MiB to 1 MiB while the first decode remained stalled. |
| #209 | UPNG inflate/unpacking and UTIF scanner TIFF decoding ran synchronously on the UI thread. | A disposable worker receives the input by transfer, returns exact 8/16-bit planes by transfer, and terminates on success, error, or timeout. PNG decode dispatch fell from 1520 ms to 2 ms; TIFF from 157 ms to 1 ms. |
| #210 | ZIP computed CRC by reading the complete Blob, then reread the Blob to write it; ready streams could monopolize the task queue. | The same 64 MiB payload is now read once (64 MiB vs 128 MiB), CRC is written in standard ZIP32/ZIP64 data descriptors, writes are at most 256 KiB, and timer callbacks increased from 1 to 27. |
| #211 | Opaque PNG16/TIFF exports stored redundant alpha; PNG16 used no row filter and copied compressed IDAT data into another full chunk allocation. | RGB removes 25% of opaque sample/strip bytes; PNG Sub filtering reduces correlated data; multipart IDAT avoids the extra compressed-size buffer. Real transparency from 8-bit sources remains RGBA. |

The 12 MP decode benchmark used the identical baseline-encoded image in both
paths. Total PNG decode time was 1520 ms before and 1581 ms in the worker;
TIFF was 157 ms before and 181 ms in the worker. The improvement is UI
responsiveness: the largest 8 ms timer gap fell from 1520 to 11 ms for PNG and
158 to 10 ms for TIFF. Worker startup is included. The worker is released per
decode instead of retaining inflate/UTIF heaps across a roll. Unsupported
worker construction falls back to the existing synchronous decoder.

The one-pass ZIP fixture took 354 ms before and 395 ms after. Cooperative
yields add elapsed-time overhead while halving payload reads and allowing
input/paint tasks to run; this is not claimed as a wall-clock speedup.

Encoder fixtures were 2400 × 1600 RGBA16. `ramp` uses `(sampleIndex * 37) &
65535`; `grain` uses a seeded LCG, with opaque alpha in both.

| Fixture | PNG before | PNG after | Encode time before → after | TIFF before → after |
| --- | ---: | ---: | ---: | ---: |
| Ramp | 26,149,821 B | 112,362 B | 1683 → 294 ms | 30,720,666 → 23,040,650 B |
| Seeded grain | 26,460,896 B | 23,048,698 B | 1620 → 1003 ms | 30,720,666 → 23,040,650 B |

TIFF encoding was 63 → 48 ms for ramp and 55 → 53 ms for grain. The extreme
ramp PNG reduction is fixture-specific; real film grain reduces that benefit.

## Validation

Targeted tests cover stalled decode/sink backpressure, ordered failure and
cancellation behavior; ZIP32/ZIP64 extraction and CRC, single-read payloads,
empty entries and cooperative yields; actual worker-thread PNG/TIFF decoding,
input transfer, exact low-byte precision and disposal; multi-row Sub filtering,
RGB opaque output, retained transparency, and EXIF/ICC metadata paths.

```sh
node negative2positive/src/app/batchExportScheduler.test.mjs
node negative2positive/src/app/zipStoreWriter.test.mjs
node negative2positive/src/app/scanDecodeClient.test.mjs
node negative2positive/src/app/pngFileLoader.test.mjs
node negative2positive/src/app/rawFileLoader.test.mjs
node negative2positive/src/app/exportImageEncoders.test.mjs
node negative2positive/src/workers/exportWorker.test.mjs
node negative2positive/src/workers/exifWriter.test.mjs
```
