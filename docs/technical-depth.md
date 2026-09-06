# Technical depth: true 16-bit, linear DNG, on-device AI repair

Roadmap items #161, #162 and #163.

## True 16-bit end-to-end (#161)

The Step-3 adjustment stage (white balance and exposure gains, contrast,
highlights / shadows, temperature and tint, saturation and vibrance, CMY,
curves, the lab-match look) used to run only as an 8-bit LUT pipeline, so a
16-bit export carried 8-bit data whenever any of those controls was active,
and the export menu said so.

`workers/pixelAdjustments16.js` is the same maths on the engine's 16-bit
RGBA plane: every stage is evaluated in floating point on the 0..255 scale
the controls are defined on, and the 256-entry curve LUTs (the user's curve,
the look curves) are interpolated linearly instead of looked up. Separable
chains (no highlights / shadows, no HSL, no look matrix) build three
65536-entry LUTs once; the rest runs per pixel. `adjustmentPipeline.js`
exposes `applyPreparedAdjustmentsToBuffer16`, the export worker has an
`applyAdjustments16` message, and `main.js` chooses the 16-bit path when the
export asks for 16 bits and the conversion produced a plane
(`applyAdjustmentsWithSettings(…, { bitDepth: 16 })`, for the open photo and
for every batch file). PNG16 and TIFF16 then encode the adjusted plane
directly. The 8-bit preview is unchanged, the `bitDepth8BitData` warning is
gone, and the dead `original16 / cropped16 / processed16` state fields with
it.

Timing on a 24 MP frame (`scripts` benchmark, Node 26, Apple silicon):

| chain | 8-bit | 16-bit |
|---|---|---|
| separable (WB, contrast, temperature, CMY, curves) | 121 ms | 170 ms |
| per pixel (vibrance, highlights, look matrix) | 655 ms | 1470 ms |

Tests: `pixelAdjustments16.test.mjs` (a 16-bit gradient with curves, WB and
CMY keeps thousands of distinct levels per channel and stays monotone; the
per-pixel path agrees with the 8-bit path within rounding). Smoke
(`scripts/technical-depth-smoke.mjs`, `--technical-only`): a 16-bit negative
exported as 16-bit PNG with a cyan shift and an exposure change decodes to
far more than 256 distinct values per channel on a row.

## Linear DNG export (#162)

**DNG** in the export format toggle writes `<name>_linear.dng`: the
geometry-applied negative inverted and film-base normalised in linear light
(`linearDng.js`: `positive = base / negative` per channel, scaled so the
99.9th percentile sits at white; slides pass through with only the white
normalisation), as a 16-bit RGB LinearRaw DNG built on the shared TIFF writer:
`DNGVersion 1.4.0.0`, `DNGBackwardVersion 1.1.0.0`, `PhotometricInterpretation
34892`, `UniqueCameraModel`, `ColorMatrix1` = XYZ→linear-sRGB with
`CalibrationIlluminant1` D65, `AsShotNeutral 1/1/1` (the base normalisation
already balanced the frame), `WhiteLevel 65535`, `BlackLevel 0`,
`BaselineExposure 0`, `DefaultCropOrigin/Size`, plus the analog metadata
(Model, DateTime, ImageDescription, XMP). No tone curve is baked in, so the
raw converter keeps its white balance and exposure latitude. Batch export
writes DNGs through the same path; sprocket borders do not apply.

Verified here by structure: `linearDng.test.mjs` parses the tags back and
checks the inversion (a dense negative becomes a bright, neutral, linear
positive), and the smoke exports one from the app and reads the tags and a
bright / dark sample. Opening in Lightroom Classic and Capture One was not
possible in this environment; the file follows the DNG 1.4 LinearRaw
requirements, and the comparison of Lightroom's default rendering with the
app's neutral rendering is still to be recorded once a licence is at hand.

## On-device AI repair (#163): MI-GAN

2026-09-06: 標準モデルを LaMa から **MI-GAN Places2 Pipeline v2** に変更。
Studio の Retouch → Dust cleanup → **AI repair · MI-GAN** で有効化する。
モデルは `public/models/migan_pipeline_v2.onnx`（約 27 MiB）に同梱し、
Web / Tauri のビルドに含める。初回読み込み後は IndexedDB にキャッシュする。
外部ホストのモデル配信や写真のアップロードは不要。

### 入出力と処理経路

- 公式 Pipeline の入力は `image`: uint8 NCHW RGB、`mask`: uint8 NCHW。
  **255 = 保持、0 = 修復**。アプリ内部の `1 = 修復` を境界で反転する。
- `result` は uint8 NCHW。必ず 255 で割って正規化し、暗い画像の値域を推測しない。
  別形式の ONNX は明示的に拒否する。ローカル選択も同じ Pipeline 形式に限定。
- マスク周辺を 512 px タイルで推論し、4 px の境界フェザーで合成する。
  マスクとフェザー領域外は元の画素を保持する。16-bit 出力でも非修復領域の
  精度を保持するが、モデル自身の入出力は 8-bit であり、失われた原画素の復元ではない。
- GPU と CPU の両方を実際の小さなマスクでウォームアップする。
  WebGPU が失敗すれば WASM を試し、両方失敗すれば通常修復とエラー表示へ戻る。
- 推論はセッションごとに直列化し、テンソルと置き換えたセッションを解放する。
- ブラシは通常修復で即時表示し、離した後に MI-GAN で置き換える。
  写真切替・マスク変更・取り消し後の古い結果は適用しない。
- 現在の写真の PNG/JPEG/TIFF 書き出しは現在のマスクで再推論するため、
  ブラシ直後の通常修復プレビューがそのまま書き出されることはない。
  一括書き出しは各写真で再検出してから MI-GAN を適用する。
  Linear DNG は従来どおり修復を焼き込まない。

### モデルの出典と検証

モデルの固定リビジョン・SHA-256・ライセンスは
`negative2positive/public/models/README.md` に記録。
`aiInpaint.migan.test.mjs` でバンドルのハッシュ、マスクの向き、RGB 配置、
暗部の正規化、空マスク、エラー時の解放を検証する。
`technical-depth-smoke.mjs` は壊れたモデルからの復帰、標準モデルの読み込み、
実推論、PNG 書き出しへの反映、WASM 推論と非マスク領域の 16-bit 保持を検証。

初回の実測（Apple silicon / headless Chrome、ONNX Runtime Web 1.19.2）:
WebGPU 読み込み約 2.5 秒、13 タイル約 3.3 秒（約 254 ms / タイル）。
端末・ブラウザ・マスクの分布で時間は変わり、200 ms 目標の達成は保証しない。
実際のフィルムの粒子・毛髪・細い構造物については目視評価を継続する。
