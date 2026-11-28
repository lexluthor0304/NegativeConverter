# 胶片縁の描画

## 参考と範囲

参考資料: [elsamuko-slide-with-sprockets.scm](https://github.com/elsamuko/gimp-elsamuko/blob/master/scripts/elsamuko-slide-with-sprockets.scm)。上流は GPL-3.0-or-later。本実装は Script-Fu のソースを取り込まず、物理的な配置とマスク合成の考え方を JavaScript の既存描画経路で実装する。

上流は写真全体を幅 35 mm のフィルムとして扱い、画像の上に穴・文字・にじみを重ねる。一方、このアプリの既存モードは写真の外に縁を追加する。写真が齿孔の奥まで広がる全幅露光と、黒い縁の追加は異なる表現。外付け縁では写真を引き伸ばしたり、存在しない周辺画像を生成したりしない。

## 描画規則

- 横長の写真でも穴を伸ばさない。24 mm の成像部の高さを基準に、縦横同じスケールで穴と 4.75 mm ピッチを配置する。縦写真は既存の回転経路を使う。
- ブランド文字・帧番号・半コマ番号はサイズを分ける。文字の各ドットを独立発光させず、一枚の被覆マスクにまとめて柔らかく描く。
- DX は隙間のない上下二段。外縁まで印字し、齿孔の外端に少し重ねる。最後に齿孔を描くので、印字が穴の中に残らない。
- 白い穴の中心は指定色を維持。細い輪郭だけをアンチエイリアスし、透明穴も部分アルファに対応する。
- 過曝は既存の任意スイッチを使用。広い低密度の光と狭い暖色の光を合成し、写真領域には触れない。
- ノイズは固定シード。再描画や色調整のたびに縁がちらつかない。
- 通常合成と高速プレビュー用の背景合成を共通化。写真領域は元の画素をそのままコピーし、背景合成ではその領域を透明にする。

## 書き出しでの合成（2026-11-23）

フルサイズの書き出しは `composeSprocketFrameAsync` で縁を合成する。同じ画素を同じ順序で描く段階（行・穴・印字）に分け、12 ms ごとにタスク境界（`scheduler.yield()`、なければ MessageChannel）で一度譲る。以前は `composeSprocketFrame` がメインスレッドの一つのタスクで全体を描き、60 MP・文字/帧番号/DX/過曝ありで 5.1 秒間ページが止まった（JPEG 書き出し 6.4 秒、縁なしは 3.0 秒で長いタスクなし）。変更後は同じ書き出しが 2.8 秒、PNG は 8.7 → 4.3 秒、50 ms を超えるタスクはない。プレビューと表示サイズの合成は従来どおり同期の `composeSprocketFrame`（同じ段階を続けて実行するだけ）。

合成そのものも、出力を 1 バイトも変えずに速くした（`sprocketFrame.test.mjs` が変更前の FNV ハッシュに固定している）：

- 片基：列だけ・行だけで決まる項（放射状の落ち込み、コマと穴の濃淡、粗いノイズの格子位置と重み）を一度だけ計算し、粗いノイズの格子ハッシュは格子の行ごとに一度。1 画素ごとの配列生成をやめた。
- 印字マスクのぼかし：空の行は加算しない（何も足さない）。タップごとに行全体を足し、各画素の加算順は従来と同じ。
- `roundedRectDistance`：角の外側以外では `Math.hypot(a, 0)` が a そのものなので平方根を省く。
- 過曝のハローと印字の粒状ノイズ：行ごとに表から求める（`smoothNoiseRows`）。

合成時間（Node、M5 Pro）：縁だけなら 9.4 MP で 216 → 68 ms、36 MP で 757 → 185 ms、60 MP で 1.2 s → 0.3 s。文字・帧番号・DX・過曝ありは 60 MP で 3.9 → 1.8〜2.0 s。印字の段階はマスクを一度に作り、合成（`compositeMarkingMask`）だけを順番に後回しにして段階実行する。この段階は途中で譲らないので、同時に合成している別のフレームと混ざらない。

## 回帰確認

`node negative2positive/src/app/sprocketFrame.test.mjs` で通常/過曝の写真画素保持、背景一致、透明穴の柔辺、文字の過剰発光防止、DX の孔内クリップ、パノラマのピッチ維持、縦写真を検証する。

`npm run test:smoke` で Studio の齿孔・文字・帧番号・DX の実クリック、プレビュー、一括処理、齿孔付き PNG 書き出しを確認する。

## Edge marking styles (2026-11-28)

The border panel's first control, **Edge marking style**, draws the rebate the
way a brand prints it: the text, its letters, the frame numbers on both edges,
the half-frame marks, the DX code, where each sits and the colour the print
takes in a positive. One dropdown; the text, colour, switches and DX fields
below it stay as fine adjustments.

- `src/app/edgeMarkingStyles.js`: the styles as data (positions in
  perforations along the film from the frame's main number, bands in mm in
  from the film's outer edge), the film-name → style rules, "auto".
- `src/app/edgeGlyphs.js`: the letters, drawn from strokes (straight strokes
  with square ends, elliptical arcs) on a box one cap height tall, as a
  function of width and stroke so a set can be narrow or wide, thin or bold.
  Two sets: `grotesk` (Kodak and Ilford's bold sans-serif) and `grid`
  (Fujifilm's monoline chamfered letters). No system font is used: the same
  border must come out of Chrome, WebView2, WKWebView and WebKitGTK, in the
  preview and in the export, and be pinned by hashes.
- `src/app/sprocketFrame.js`: `paintStyledEdgeMarkings` reads a style and
  draws its elements per frame; `styledFrameSlots` gives the frames (one per
  eight perforations, numbered on from the photo's own number), and a caller
  composing several photos on one film passes `frameSlots` itself. Glyph
  masks are built inside the stepped composite (one glyph per step), so a
  60 MP export keeps its slices short (Node, M5 Pro: longest slice 24–45 ms,
  the custom border 46 ms; whole border 0.6–0.8 s).

Legibility: at a contact sheet's real size (cap heights of about 13 px) a
5 must not read as a 6. In every set the 5's left side is open between its
stem and the end of its bowl, where the 6 is closed; `edgeMarkingStyles.test.mjs`
checks it on the rasterised glyphs. Diagonal strokes that reach the cap line
or the baseline end flat there (feet of A, V, K), not round.

### Settings and compatibility

`sprocketEdge.style` is one of `auto`, `kodakColor`, `ilford`, `fujiSlide`,
`plain`, `custom`. A setting without it (a project, photo snapshot, history
step or interrupted batch job saved before styles) and any unknown id are
`custom`: the border drawn before, byte for byte (`sprocketFrame.test.mjs`
pins it). A new session starts on `auto`. The layout, letters and marks come
from the style at compose time; only the text, colour, DX number and switches
are stored, so a corrected style corrects old projects too. Choosing a style
puts its text, colour, DX number and switches in the controls; editing them
afterwards keeps the style.

**Auto** draws, per photo, the brand of the film the app knows it to be: the
film-edge read first (ignored when it is a light code on a colour negative,
which is a border drawn on a positive, as the reader itself does), then the
roll's stock. Its text is the film's edge print where a reference shows it
("KODAK GC 400" for Ultra Max, "KODAK EKTAR 100", "ILFORD HP5 PLUS",
"FUJI RDPIII"), otherwise brand and trade name in capitals; the DX code is the
number read from the film; the frame number is the one printed beside the
photo when the reader saw it. Text, colour, DX and number typed by the user
win. A film whose brand has no style, or no film at all, draws the border as
before (custom), so the panel says "Auto · no film recognised". Film presets
are not used: they name looks ("Portra Classic"), not films.

### What each style rests on

Measured means read off the reference images in perforation units (pitch
4.75 mm) and millimetres from the film edge; positions along the film are
relative to the frame's main number. The comparison images (reference above,
rendering below, same scale, perforations aligned) are under
`.cache/edge-styles/compare/` of the working copy that made them.

**Kodak colour negative (`kodakColor`)** — wording read on the rebates
(two Flickr scans each): Portra 160 "KODAK PORTRA 160", Portra 400 "KODAK
PORTRA 400", Portra 800 "KODAK PORTRA 800-3", Gold 200 "KODAK GB 200-7",
ColorPlus "KODAK 200-8". Gold 200 and ColorPlus turn their text round on odd
frames like Ultra Max; Portra does not. Their text sits 1.76–1.97
perforations after the number, as measured on Ultra Max (1.78).

**Kodak colour negative (`kodakColor`)**

- Local: `DSC_8800.NEF`, `DSC_8798.NEF`, `DSC_8806.NEF` (Kodak Ultra Max 400,
  Nikon Zf camera scans, frames 21, 30A–32, 35–36A).
- Commons: [Color print film strip 01 - negative](https://commons.wikimedia.org/wiki/File:Color_print_film_strip_01_-_negative.jpg)
  and [03 - positive with tonal correction](https://commons.wikimedia.org/wiki/File:Color_print_film_strip_03_-_positive_with_tonal_correction.jpg)
  (Kodak Ektar 100, LoMit, 2018, CC BY 4.0).
- Older generations for contrast only: [Kodak Gold 200-4](https://commons.wikimedia.org/wiki/File:Kodak_Gold_200-4.png),
  [Gold 400-6](https://commons.wikimedia.org/wiki/File:Film_-_Kodak_Gold_400-6.jpg) (1990s: "KODAK 200-4" / "GOLD 200-4", orange lines in the perforation rows).
- Measured (Ultra Max): text edge: the frame number and the text, solid bold
  sans-serif, cap height 1.16 mm from 0.42 to 1.58 mm in from the edge (centred
  between the edge and the holes); number digits as wide as tall, the text's
  digits 0.72; letter gap 0.21, word gap 0.65, the brand set apart by 1.1 cap
  heights (Ektar: 0.78 and 1.28). The text starts 1.78 perforations after the
  number (Ektar 1.93; both 1.37–1.43 after the number's end). Ultra Max prints
  "KODAK GC 400" after even numbers and "GC 400 KODAK" after odd ones (frames
  21, 30, 31, 35, 36); Ektar prints "KODAK EKTAR 100" every frame. DX edge:
  the number again, larger (1.34 mm, 0.40–1.74 mm), 0.2 perforations earlier;
  the DX code 0.65 perforations after it, 12.5 mm long (module 0.405 mm), two
  rows of 1.08 mm from the edge inwards; half a frame on (3.9 perforations)
  "nA" at 0.87 mm over a right-pointing arrow 3.6 mm long (shaft 0.13 mm, solid
  head 0.67 mm), then the code again. The number sits half a perforation past
  a hole's left edge. Colour: Ektar's corrected positive shows the print pale
  gold on black (236, 209, 139); on the negatives it is a dense brown-purple
  (density above the mask about 0.55 / 0.73 / 0.44 in R / G / B).
- Approximate: the letterforms are drawn to look like Kodak's, not traced from
  a font file; the small dots Kodak prints inside "KO.DAK" (a manufacturing
  code) are not drawn; the text of stocks other than Ultra Max and Ektar (Portra,
  Gold, ColorPlus) is the trade name, not a verified edge print; the colour
  comes from one corrected positive; which hole of the frame the number falls
  on depends on the camera (1.5 perforations, as on the Nikon that exposed the
  Ultra Max); on the Ektar photograph the number sits 0.78–0.86 of a
  perforation past a hole (a hand-held photograph at an angle, so less sure
  than the flat Ultra Max scans' 0.50).

**Ilford (`ilford`)** — current production (HP5 Plus, FP4 Plus)

References (Flickr unless noted; images kept locally, not in the repository):
HP5 Plus [55344157940](https://www.flickr.com/photos/jacklandau/55344157940/) (2026) and
[51717341141](https://www.flickr.com/photos/188462897@N03/51717341141/) (2021);
FP4 Plus [52193807748](https://www.flickr.com/photos/sergiorosy/52193807748/) (2022) and
[29791258114](https://www.flickr.com/photos/placid_casual/29791258114/) (2016); an HP5 Plus
contact sheet of 2004 (Kyppi archive, V.-P. Suhonen) shows the same DX code and wedge.

- Measured (2026 scan, 21.7 px/mm, perforation units from the frame number):
  text edge "ILFORD HP5 PLUS" from −1.27, once every 8 perforations (8.0 on
  the 2021 scan, 8.1 on the 2026 one), 19.1 mm long, bottom of the letters
  1.91 mm from the film edge; emulsion code "5051-11" at +3.66 (FP4 Plus:
  "3803-11"). DX edge: the number 0.41 of a pitch past a hole's left edge, top
  1.91 mm from the edge, digits 1.4 mm wide; a DX code from +0.84 to +3.35;
  a small filled wedge at +3.83 (0.65 mm long); "nA" at +4.21, its top 1.68
  mm from the edge; the half-frame DX code from +4.94 to +7.75. The bars
  reach from the edge to the perforations and stand apart (thin bars).
  Square, stepped capitals (drawn with the `grid` set). Print white.
- Approximate: both modern scans cut the film edge off, so cap heights and
  the lower ends of numbers, wedge and bars are inferred (text cap 1.25 mm
  from its length; number cap about 1.45 mm); the wedge's height; the DX
  number drawn is HP5 Plus's database code (109-9), not read off the bars;
  the letters are the chamfered `grid` set, the film's are stepped.
- The earlier look of this style (heavy round letters, no DX code, from a
  2008 strip and a 2018 scan) is the older print (also seen on a 1998-expiry
  roll) and is no longer drawn. Delta and Kentmere wordings are not offered:
  current Delta 400 ("DELTA 400 PROFESSIONAL") and Delta 100 rest on one
  readable image each, Kentmere 400 ("K 400", no DX code) on one complete
  image; Delta films get this layout with their trade name.

**Kodak black and white (`kodakBw`)** — Tri-X, T-Max

- Tri-X [50787267562](https://www.flickr.com/photos/rotabaga/50787267562/) (2020) and
  [31607007404](https://www.flickr.com/photos/145901000@N05/31607007404/) (2017): "KODAK 400TX";
  T-Max 100 [41914972164](https://www.flickr.com/photos/40814057@N00/41914972164/): "KODAK 100TMX";
  T-Max 400 [51318381513](https://www.flickr.com/photos/senpatientulo/51318381513/) and
  [51104105113](https://www.flickr.com/photos/62089820@N03/51104105113/) (2021): "KODAK 400-2TMY"
  (2008 rolls read "KODAK 400TMY", 1998 "KODAK 5053 TMY"; the current one is drawn).
- Measured (Tri-X): Kodak's colour-negative numbering — the number on both
  edges, the text 1.76 perforations after it, "nA" 3.89 after the number over
  an arrow starting at 3.68 — and no DX code; the number starts at a hole's
  left edge (phase 0). Print white.
- Approximate: letter sizes and bands are Kodak colour negative's (measured
  on Ultra Max), not measured on these scans.

**Kodak slide (`kodakSlide`)** — Ektachrome E100

- [51657970731](https://www.flickr.com/photos/melodiedawn/51657970731/) (2021) and
  [54759621693](https://www.flickr.com/photos/diversey/54759621693/) (2023): "KODAK E100".
- Measured: text 2.0 perforations after the number, "nA" about 4.0 after it
  over an arrow, no DX code, cream print (about 239, 217, 164) on the black
  rebate. Approximate: the number's phase to the holes (0.15–0.35 between
  the scans; 0.35 drawn), sizes from Kodak colour negative. Elite Chrome
  ("KODAK EBX") rests on one clear image and is not offered.

**Fujifilm reversal (`fujiSlide`)**

- [Kodakcamsrip1](https://commons.wikimedia.org/wiki/File:Kodakcamsrip1.jpg),
  [Kodakcamsrip2](https://commons.wikimedia.org/wiki/File:Kodakcamsrip2.jpg),
  [Vmcamstrip](https://commons.wikimedia.org/wiki/File:Vmcamstrip.jpg),
  [R45strip](https://commons.wikimedia.org/wiki/File:R45strip.jpg)
  (Provia 100F RDP III, John Elson, 2009, CC BY-SA 4.0). Four strips, but one
  photographer and possibly one batch (emulsion 043).
- Measured: the same bold number on both edges at the same place (cap 1.67 mm
  on the text edge, 1.61 mm on the other), 0.65 perforations past a hole's
  edge; the text in thin monoline letters 0.93 mm tall, 0.9 cap heights wide,
  pitch 1.1, word gap 1.8, its bottom level with the number's, 3.1–3.4
  perforations after the number: "FUJI RDPⅢ" after odd numbers, "RDPⅢ-043"
  (stock code and emulsion number) after even ones; half a frame on, a small
  "36" (0.5 mm), an outlined pentagon arrow 2.57 × 1.16 mm and a bold "nA"
  (1.22 mm) at 3.0, 3.3 and 3.9 perforations. No DX code on these strips. The
  rebate is black and the print amber (mean of three strips: 202, 162, 60).
- Approximate: the number's phase to the perforations differs between the
  strips (0.65 on Vmcamstrip, 0.19 on Kodakcamsrip1); the style uses 0.65. The
  reference numbers are a little bolder and rounder than the grid letters.
  The emulsion number "043" is copied from the reference; the
  roll-end marks ("E", "264PF5") are not drawn; Velvia's and Astia's own edge
  prints were not seen (they get this style with their trade name).

**Unbranded (`plain`)**: Kodak's numbering (numbers, arrows, measured as
above) without text or DX code, for re-spooled and rebranded rolls.

### Left out

A second collection of 85 rebate images (37 stocks, two credited sources each)
was gathered on 2026-11-28; from it Ilford current production, Kodak B&W,
Kodak E100 and the Kodak colour negative wordings were measured. Still not
drawn:

- Fujifilm colour negative (C200, Superia, Fujifilm 200/400, Pro 400H): the
  coloured stripes between the perforations differ per stock (Superia and
  C200 red/green, Pro 400H red, Fujifilm 200/400 none) and the renderer has
  no stripe marking yet.
- Fomapan: numbers every four perforations without "A", widely spaced
  letters, and an old/new print whose changeover is not dated.
- Agfa Vista (two print generations, discontinued) and AgfaPhoto APX (wedge
  before "nA", no DX): not measured in this round.
- Kodak Vision3 (KeyKode every 64 perforations, one edge only) and CineStill
  (its own still numbering and wordmark on later rolls): not measured in this
  round; they need a layout of their own.
- Kodak Elite Chrome, Ilford Delta, Kentmere: one readable image of the
  current print each.

### Adding a style

Add a record to `EDGE_MARKING_STYLES` (a new id, never a renamed one), its
label key in `i18n.js` (zh, en, ja), its `<option>` in `index.html`, its brand
words in `STYLE_RULES`, its verified edge prints in `KNOWN_EDGE_PRINTS`; new
letters go into a set in `edgeGlyphs.js`. Measure on images of real film
first and list them here; pin the new style's frame in
`sprocketFrame.test.mjs`.
