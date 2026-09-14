# Fusion Pixel

アプリ UI 用の 12px proportional 字体。英数字と CJK を同じピクセル書体で表示する。

- 配布元: https://github.com/TakWolf/fusion-pixel-font
- 固定リリース: 2026.09.01
- 配布 ZIP: fusion-pixel-font-12px-proportional-otf.woff2-v2026.09.01.zip
- ZIP SHA-256: 96a105bf90600c9f589629b7e9cf61ab4d498f1a9af33b6ac6f517d217a3393c
- ライセンス: OFL.txt、および LICENSES/ 内の構成フォントのライセンス。

原字体を改変せず、簡体字・繁体字・日本語・韓国語優先の四種類を同梱する。
各ファイルはラテン文字も含む。言語に必要なファイルのみブラウザーが読み込む。
外部 CDN は使わず、Web・デスクトップの両方でローカル配信する。

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
