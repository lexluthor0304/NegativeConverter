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
directly.

Until #240 the worker's 16-bit result never reached the export: the bridge
wrapped it as bytes, `ImageData` rejected the doubled length, a silent catch
returned null and the main thread ran the same pass again in one long task.
The bridge now resolves a `bits: 16` result as a `Uint16Array` view, the
worker builds the 8-bit mirror with the same `downconvertPlane16`, and the
result is checked (type, 4·w·h samples, size) before use; a failure warns
once per session and falls back. `{ planeOnly: true }` returns only the
plane, for the gain map, and the main-thread fallback has the matching
`applyPreparedAdjustmentsToPlane16`. The kept input plane is copied for the
worker in 32 MiB slices, one per task. Tests: `workerBridge.test.mjs` (an
`ImageData` stub that throws on the wrong length, as browsers do) and
`exportWorkerParity.test.mjs` (the real worker handler behind the real
bridge, through structured clone, bit-identical to the main-thread path for
identity, separable, HSL with highlights/shadows, a look and expired rescue
with the fog surface). The 8-bit preview is unchanged, the `bitDepth8BitData` warning is
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
- ブラシは通常修復で即時表示し、離した後に筆跡の範囲に掛かるタイルだけを
  MI-GAN で置き換える（#259、`dust-removal.md`）。
  写真切替・マスク変更・取り消し後の古い結果は適用しない。
- 現在の写真の PNG/JPEG/TIFF 書き出しは、確定した修復結果のレシピが現在の
  状態と一致すればその結果を使い、一致しなければ現在のマスクで修復し直す。
  ブラシ直後の通常修復プレビューにはレシピがないため、そのまま書き出されることはない。
  一括書き出しは各写真で再検出してから MI-GAN を適用する。
  Linear DNG は従来どおり修復を焼き込まない。

### 確定間の再利用（#246）

60 MP でも一筆ごとに全画面を作り直さないための仕組み。書き出しの画素は変えない
（WASM では 1703835 とバイト単位で同一。WebGPU のみ下記の例外）。

- **修復マスク**: `buildRepairMask`（`repairBrush.js`）は各ストロークの外接矩形の中だけ
  8-bit マスクを書き、選択範囲の矩形を返す。覆い度は `forEachStrokeCoverage`
  （`localExposure.js`、覆い焼き・焼き込みと共有）。レンズ補正時は Lensfun の格子セル
  単位で見て、四隅の像の範囲（±1 px）が選択の 16 px ブロックに届かないセルを飛ばし、
  残るセルは `lensSourcePoint` と同じ式順で標本化する。`repairBrush.parity.test.mjs` が
  1703835 の実装と 300 通りのジオメトリ・レンズで一致を確認する。
- **枠の走査**: `maskBoundingBoxes` は選択矩形のヒントがあればその中だけを走査する。
  `inpaintWithModel` は枠と最初のタイルを先に作って推論を始め、その間に画像を
  8 MB ずつ譲りながら複製する。
- **タイルのメモ**: `createInpaintSession` がセッションごとに持つ LRU。キーはタイル寸法と
  入力（uint8 の RGB とマスク）の MurmurHash3 x86_128。値は出力の uint8 の写しで、
  AI ワーカーでは 192 MB、ページ内のセッションでは 48 MB まで。新しいセッション・
  WebGPU から WASM への作り直し・`release` で空になり、`trim(bytes)` で縮める（#258）。
  一括書き出しとサムネイルは参照だけで登録しない（`insert: false`）。
  離れた場所への 11 筆目は自分のタイル 1 枚だけを推論する。
- **ゴミ除去パスの保持**: 同じクリーン画像・同じマスク内容（ゴミワーカーが検出の
  応答でハッシュを返す）・同じ修復方式・同じモデル版なら、前回のパスが
  書き換えた 64 px ブロックだけを元画像の写しに書き戻す。ページ側 OpenCV の
  フォールバックで作ったマスクにはハッシュがなく、常に実行する。
  ゴミブラシ（#259）がマスクをその場で書き換えると、そのマスクのハッシュは捨てる。
  `resetDustForCleanSource` で破棄する。
- **書き出しのレシピ**: 確定した修復結果には元画像・トークン・ゴミ除去の有無と
  マスク・ゴミの版（`state.dustRemoval.revision`）・ストローク・レンズ補正・
  モデル版・ゴミの修復方式を記録する（`repairReuse.js`）。途中でモデル版が変わった
  結果や、確定の途中でブラシがマスクを動かした結果には記録しない。ゴミブラシの
  一筆とその取り消し・やり直しは修復結果をその場で書き換えるので、その記録を消す。
  写真セッションの復元では、同じストロークなら記録を引き継ぐ。
- **WebGPU**: 推論が完全には再現しない可能性があるため、メモは同じセッション内の
  以前の出力を返す。書き出しは画面と一致する（1703835 は書き出しで推論し直し、
  一致を保証しなかった）。WASM の書き出しは変わらない。
- 計測: `node scripts/bench-repair-mask.mjs`（既定 9504×6320、予算付き）。

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
