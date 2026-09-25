# Fusion Pixel

アプリ UI 用の 12px proportional 字体。英数字と CJK を同じピクセル書体で表示する。

- 配布元: https://github.com/TakWolf/fusion-pixel-font
- 固定リリース: 2026.09.01
- 配布 ZIP: fusion-pixel-font-12px-proportional-otf.woff2-v2026.09.01.zip
- ZIP SHA-256: 96a105bf90600c9f589629b7e9cf61ab4d498f1a9af33b6ac6f517d217a3393c
- ライセンス: OFL.txt、および LICENSES/ 内の構成フォントのライセンス。

原字体を改変せず、簡体字・繁体字・日本語・韓国語優先の四種類を同梱する。
WOFF2 本体は `negative2positive/src/assets/fonts/fusion-pixel/` に置き、Vite が
内容ハッシュ付きの `/assets/*-[hash].woff2`（immutable キャッシュ）として配信する。
このディレクトリにはライセンスと本 README のみを残す。
外部 CDN は使わず、Web・デスクトップの両方でローカル配信する。

UI の表示にはビルド時に生成する言語別サブセットを使う（#262）。
`scripts/build-ui-fonts.mjs` が dev / build の開始時に UI の文字列
（i18n.js、studioText、index.html、src/app・src/ui の文字列リテラル、CSS の
`content`）を `scripts/ui-font-glyphs.mjs` で集め、HarfBuzz（`subset-font`）で
各言語の原字体から切り出す。レイアウト機能とヒンティングは保持し、ファミリー名を
変更して `src/assets/fonts/ui/`（git 管理外）へ WOFF2 と `@font-face` を書き出す。

- `Fusion Pixel SC UI`: zh_hans 原字体から。`NC Studio Latin` にない文字を担当（既定・zh）。
- `Fusion Pixel JP UI`: ja 原字体から。ラテン文字も含む（JP は U+00B7 と曲引用符の字形が SC と異なる）。

原字体はサブセットの後ろのフォールバックとして残る。サブセット外の文字（CJK の
ファイル名など）は原字体のダウンロードになるだけで、字形は変わらない。
U+2212（−）と U+2260（≠）はどの原字体にもないため、従来どおり monospace で表示する。
原字体の `unicode-range` はグリフのない U+2200–U+230B を除外し、これらの文字のために
原字体を取得しない。`uiFontCoverage.test.mjs` が、UI の文字がすべて原字体にあるか
フォールバック一覧にあること、どの `unicode-range` もフォールバック文字を含まないことを検査する。
ja・ko・zh-Hant の字体指定は SC を後ろに持たない（同じ cmap なので字形を補えない）。

Film Edge Pixel の CJK 端文字にもこの原字体を使用する。12px の原生グリッドで
字形を読み、従来の露光マスクで合成する。プレビューはロード完了後に再描画し、
単体・一括・コンタクトシートの書き出しは字体のロードを待つ。原字体にない
拡張漢字のみシステム字体へフォールバックする。従来の英数字 5×7 字形は維持する。
文字カバレッジは `scripts/inspect-native-pixel-font.py` で同梱 WOFF2 から再生成する。

2026-09-07: 英語の初期画面用に、同じ SC 原字体から Latin / punctuation /
arrows の約 10 KB のサブセット `nc-studio-latin.woff2` を追加した。
派生字体の名前は `NC Studio Latin` に変更し、元の字形と OFL ライセンスを保持する。
再生成: fonttools[woff] 4.60.1 を用意し、`python3 scripts/subset-studio-font.py`。
言語切替リンクはシステム字体を使い、その数文字のために CJK 全体を取得しない。

2026-09-25: `NC Studio Latin` に Studio が描く幾何図形 5 字（▶ ▸ ▼ ▾ ●）を追加し、
グリフのない U+2212 を範囲から外した。英語 UI は写真を開いても CJK 原字体を取得しない。
UI サブセットの派生字体も同じく OFL に従い、原字形・メトリクス・カーニングを保持する
（OFL.txt は Reserved Font Name を宣言していないため、名前に "Fusion Pixel" を残す）。
