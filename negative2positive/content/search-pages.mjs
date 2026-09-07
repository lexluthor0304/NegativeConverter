export const searchPages = [
  {
    path: 'slide-film-correction.html', lang: 'en', title: 'Slide Film Color Correction | Negative Converter',
    description: 'Correct positive slide scans locally with highlight-preserving tone control, or use Edit only. Includes 16-bit export and guidance for scans without film borders.',
    heading: 'Correct slide film without inverting it',
    lead: 'Negative Converter corrects positive slide scans on your device. Choose Positive, then Correct slide for automatic tone and reliable neutral balance, or Edit only to keep the original rendering and make manual adjustments.',
    sections: [
      ['Which positive mode should I use?', '<table><thead><tr><th>Mode</th><th>What it does</th><th>Use it for</th></tr></thead><tbody><tr><td>Correct slide</td><td>Analyzes the image, lifts compressed tones with a bounded highlight shoulder, and balances reliable neutrals.</td><td>Camera scans of reversal film that need tonal correction.</td></tr><tr><td>Edit only</td><td>Skips automatic tone and white-balance analysis. Existing manual edits still apply.</td><td>Finished scans, digital photos and negatives already converted elsewhere.</td></tr></tbody></table><p>Neither mode inverts the image or removes an orange negative mask. At neutral settings, Edit only preserves the decoded 16-bit pixel values through the conversion stage. JPEG export, manual adjustments and image repairs can change those values.</p>'],
      ['How to correct a slide scan', '<ol><li>Import a JPG, PNG, TIFF or supported camera RAW scan. Check the suggested film type.</li><li>Open Conversion and select Positive. You can make this choice even when the scan has no film border.</li><li>Select Correct slide. Inspect the brightest textured areas and neutral objects before changing exposure, highlights or white balance.</li><li>Use Edit only if the scan already looks right. Apply a deliberate preset or color adjustment only when you want that additional rendering.</li><li>Export PNG or TIFF at 16-bit for further editing, or JPEG for sharing.</li></ol>'],
      ['Why use a common tone mapping?', '<p>Stretching red, green and blue independently can shift the colors of a positive scan. The positive pipeline uses a shared tonal mapping and a neutral default color model. Automatic white balance requires strong neutral evidence; scenes without it retain their existing balance. The highlight shoulder avoids discarding bright values simply because they lie above a histogram percentile.</p><p>This protects detail present in the scan. It cannot reconstruct highlights already clipped by the camera, scanner or earlier software. Keep the original RAW or high-bit-depth scan.</p>'],
      ['Scans with no border', '<p>A film border is optional. Import detection can inspect the image itself, while the Positive button always provides an explicit choice. A warm positive scene can resemble the orange mask of a negative, and a grayscale positive can resemble a B&amp;W negative. Treat a suggestion as something to inspect, not a guaranteed identification.</p><p>See <a href="/film-type-detection.html">how automatic film-type detection handles cropped scans</a>.</p>'],
      ['Source and implementation', '<p>The implementation and tests are public in the <a href="https://github.com/lexluthor0304/NegativeConverter">Negative Converter repository</a>. The workflow is inspired by the distinction between Positive and Edit Only described in <a href="https://forums.negativelabpro.com/t/negative-lab-pro-v3-1-new-color-processing-support-for-slide-film-improved-batch-editing-and-more/8492">Negative Lab Pro’s v3.1 announcement</a>. Negative Converter uses its own processing pipeline; it does not reproduce or claim identical results to that product.</p>']
    ],
    faqs: [
      ['Do I need to invert slide film?', 'No. A developed slide is already positive. Use Positive mode to correct it, or Edit only to apply manual adjustments without automatic analysis.'],
      ['Can I correct slides without photographing the film border?', 'Yes. Positive processing works on the image area alone. Select Positive manually if automatic film-type detection is uncertain.'],
      ['Does Edit only change the original scan?', 'With neutral controls, the conversion stage preserves decoded pixel values. Manual edits, repairs and the selected export format can change the exported image. The source file is retained.'],
      ['Can this recover blown highlights?', 'It preserves highlight differences present in the decoded scan. It cannot recover detail that the input file has already clipped.']
    ]
  },
  {
    path: 'ai-film-photo-repair.html', lang: 'en', title: 'AI Dust Removal & Film Photo Repair | Negative Converter',
    description: 'Repair selected areas of film scans with a local MI-GAN brush. Learn AI dust removal, zoomed mouse and touch editing, undo, export, and reconstruction limits.',
    heading: 'Repair dust and selected areas of a film scan locally',
    lead: 'Negative Converter includes a standalone AI repair brush and AI-assisted dust removal. Paint an area in Retouch and release the pointer to reconstruct it with MI-GAN. Photo processing runs on your device.',
    sections: [
      ['Brush repair or automatic dust removal?', '<p>Use the AI repair brush for a specific mark or damaged area you can identify yourself. Automatic dust removal first detects candidate spots and then repairs its selected mask. AI is the default repair option when dust removal is enabled; importing a photo does not automatically apply dust removal.</p><p>The shared MI-GAN model begins loading in the background after you open a photo. Wait for the model-ready status before painting. The initial model download requires a connection in the web app; inference then uses local WebGPU or WebAssembly according to device support.</p>'],
      ['How to use the repair brush', '<ol><li>Import and convert a scan, then open Retouch.</li><li>Enable the AI repair brush and wait for the model-ready status.</li><li>Set a brush size slightly wider than the defect. Zoom in and paint the area with a mouse or touch.</li><li>Release the pointer and inspect the repaired texture. Undo an unsuitable result and try a smaller selection.</li><li>Export the photo after processing completes. Saved repair selections follow the photo’s crop, rotation and mirror settings.</li></ol>'],
      ['What does AI reconstruction change?', '<p>MI-GAN predicts plausible replacement texture from the surrounding image. It does not recover a hidden historical original and may invent detail. Be especially careful with faces, lettering, fine branches, wires, stars and documentary evidence. Preserve the source scan and compare the result at full resolution.</p><p>Automated spot detection can mistake real subject detail for damage. Inspect the mask and use manual selection when a detector cannot separate a defect from the scene.</p>'],
      ['Precision and export', '<p>Pixels outside the selected repair region retain their existing 16-bit values in the AI repair stage. The model operates on 8-bit input tiles, so reconstructed pixels are not newly recovered 16-bit sensor data. PNG and TIFF can carry the final 16-bit image; JPEG is an 8-bit format.</p><p>For groups of scans, <a href="/batch-film-negative-converter.html">batch conversion</a> keeps each photo’s own repair selections. Copying a color treatment does not stamp one photo’s defect locations onto another.</p>'],
      ['Model and source', '<p>The shipped model is the MI-GAN pipeline from <a href="https://github.com/Picsart-AI-Research/MI-GAN">Picsart AI Research</a>. Model provenance, license and checksum are documented in the <a href="https://github.com/lexluthor0304/NegativeConverter/tree/main/negative2positive/public/models">project’s model directory</a>. The application is published by NeoAnalogLab and its source is available for inspection.</p>']
    ],
    faqs: [
      ['Does AI repair upload my film scan?', 'No. The model runs on the device. The web app downloads model and application assets, but does not send selected photo pixels to an inference server.'],
      ['Can I use AI repair without automatic dust detection?', 'Yes. The standalone AI repair brush lets you paint the area you want to repair without running automatic detection.'],
      ['Can I undo an AI repair?', 'Yes. Use Undo to restore the previous editing state. Keep the original scan when you need an unmodified archival copy.'],
      ['Is the reconstructed detail guaranteed to be accurate?', 'No. Inpainting generates plausible content. Inspect the result and avoid treating generated texture as recovered evidence.']
    ]
  },
  {
    path: 'film-type-detection.html', lang: 'en', title: 'Positive or Negative? Film Scan Detection Guide',
    description: 'Identify color negatives, B&W negatives and positive scans, including photos without film borders. Learn confidence labels, manual overrides and mixed-batch import.',
    heading: 'Identify a film scan with or without its border',
    lead: 'Negative Converter suggests a film type when you import a new photo. It can use image-wide orange-mask evidence even if you did not photograph the film edge. The result is a suggestion: some positive and negative images cannot be distinguished from pixels alone.',
    sections: [
      ['What evidence does detection use?', '<table><thead><tr><th>Scan evidence</th><th>Likely interpretation</th><th>Limitation</th></tr></thead><tbody><tr><td>A consistent orange mask across the image</td><td>Color negative</td><td>A very warm positive scene can look similar.</td></tr><tr><td>A uniform orange rebate brighter than the image</td><td>Stronger color-negative evidence</td><td>The photographed edge must actually be film rebate.</td></tr><tr><td>A clear neutral rebate around a grayscale image</td><td>B&amp;W negative suggestion</td><td>A white border on a positive image can resemble it.</td></tr><tr><td>Consistent readable DX film information</td><td>Film type from the film database</td><td>Unreadable or contradictory markings are not automatically trusted.</td></tr><tr><td>No mask and varied colors</td><td>Positive suggestion</td><td>A previously color-balanced negative may have no orange mask.</td></tr></tbody></table>'],
      ['What if my scan has no film edge?', '<p>You do not have to recapture the border. Detection inspects the whole image and supports cropped orange-mask negatives. After choosing Color negative, use the No Border / ES-2 mask workflow, automatic film-base estimation, or a reference from the same roll if available.</p><p>For an already color-corrected scan, inspect the preview and set the type yourself. File extensions and camera model names do not establish positive or negative polarity: a RAW file can contain either kind of photograph.</p>'],
      ['Why is a borderless black-and-white scan uncertain?', '<p>Both a B&amp;W negative and its positive inversion contain only gray values. Without additional evidence, the image does not provide a unique answer. The app therefore keeps the positive orientation and prompts you to select B&amp;W negative or Positive in Conversion.</p><p>This avoids pretending a contrast or brightness heuristic is a reliable identification. There is no published accuracy percentage for a representative real-film dataset.</p>'],
      ['Correct a suggestion and keep the decision', '<ol><li>Open Conversion and inspect the confidence message and preview.</li><li>Select Color, B&amp;W or Positive explicitly if the suggestion is wrong.</li><li>For positives, choose Correct slide or Edit only.</li><li>Continue editing. Saved settings preserve that photo’s manual type when you switch away and return.</li></ol><p>For a known uniform batch, disable Detect film type on import and choose the type to apply to new photos. With automatic detection enabled, never-viewed batch exports are assessed individually instead of inheriting the preceding photo’s type.</p>'],
      ['Related workflow guides', '<p>Read the <a href="/film-orange-mask.html">orange-mask guide</a>, <a href="/slide-film-correction.html">positive slide correction guide</a> and <a href="/batch-film-negative-converter.html">batch export guide</a>. Implementation and tests are public in the <a href="https://github.com/lexluthor0304/NegativeConverter">source repository</a>.</p>']
    ],
    faqs: [
      ['Must I photograph the film border for automatic detection?', 'No. The detector also uses the image area, including broad orange-mask evidence. A visible rebate or readable DX code can provide stronger evidence but is not required.'],
      ['Can every B&W scan be identified automatically?', 'No. A borderless grayscale positive and negative can both fit the same pixel evidence. The app prompts you to choose the polarity instead of claiming certainty.'],
      ['Does a RAW file mean the photo is a negative?', 'No. RAW describes the file encoding, not the subject. A camera RAW file can contain a negative scan, a positive slide or an ordinary digital photograph.'],
      ['Will the app overwrite my manual film-type choice?', 'Saved per-photo settings retain the selected type. Automatic detection applies to new photos and never-viewed batch items.']
    ]
  },
  {
    path: 'about.html', lang: 'en', title: 'About Negative Converter by NeoAnalogLab',
    description: 'Product facts, source code, privacy, licenses and support for Negative Converter by NeoAnalogLab: a free local film conversion and scan-editing application.',
    heading: 'Negative Converter by NeoAnalogLab',
    lead: 'Negative Converter is a free, open-source application for converting film negatives and editing film scans locally. NeoAnalogLab publishes the project for photographers using camera scans, scanner files and desktop workflows.',
    sections: [
      ['Product facts', '<dl><dt>Product</dt><dd>Negative Converter</dd><dt>Publisher</dt><dd>NeoAnalogLab</dd><dt>Cost</dt><dd>Free; no account, watermark or paid conversion tier.</dd><dt>Processing</dt><dd>On the user’s device, in the browser or Tauri desktop app.</dd><dt>Source license</dt><dd>MIT for the application. Included components retain their own licenses.</dd><dt>Languages</dt><dd>English, Chinese and Japanese interface.</dd><dt>Platforms</dt><dd>Modern browsers, with desktop downloads for macOS, Windows and Linux.</dd></dl>'],
      ['What the application does', '<p>Color negative conversion removes a film-base mask and inverts tone. B&amp;W mode converts monochrome negatives. Positive processing corrects slides or skips automatic analysis in Edit only. The editor also includes curves, color controls, roll workflows, local exposure, AI repair and PNG, JPEG and TIFF export.</p><p>16-bit PNG and TIFF export can preserve precision already present in the pipeline. Exporting an 8-bit input as 16-bit does not create missing source detail. RAW compatibility depends on the actual camera format and decoder support.</p>'],
      ['Privacy and network use', '<p>Selected photos are processed locally and are not uploaded to the server for conversion or AI inference. The web version fetches application assets and AI model files. It also uses Vercel Web Analytics for page-view measurement; this does not inspect photo content. Read the <a href="/privacy.html">privacy policy</a> for access logs and other network details.</p>'],
      ['Source, releases and support', '<p>Inspect the <a href="https://github.com/lexluthor0304/NegativeConverter">public source repository</a>, review the <a href="https://github.com/lexluthor0304/NegativeConverter/releases">release history</a>, or report a reproducible problem through <a href="https://github.com/lexluthor0304/NegativeConverter/issues">GitHub Issues</a>. The <a href="/download.html">download page</a> links to the available desktop distribution channels.</p><p>Product documentation is maintained alongside the source code. Feature descriptions should match the application and its regression tests; they are not comparative laboratory claims or guarantees about every film stock.</p>'],
      ['Known boundaries', '<p>Automatic film identification can be uncertain without a mask or border. AI repair predicts replacement texture. Image processing cannot recover data already clipped or absent from the source file. Device memory and browser capabilities limit the size and speed of a session. Keep original scans and inspect results before relying on them.</p>']
    ],
    faqs: [
      ['Who publishes Negative Converter?', 'Negative Converter is published under the NeoAnalogLab brand. Its implementation and issue tracker are available in the public GitHub repository.'],
      ['Is Negative Converter open source?', 'Yes. The application source is available under the MIT license. Included libraries, fonts and models retain their respective license notices.'],
      ['Is it a Lightroom plugin?', 'No. It is a standalone browser and desktop application. It does not integrate with a Lightroom catalog.']
    ]
  },
  {
    path: 'zh/index.html', lang: 'zh-Hans', homeAlternate: true, title: '免费胶片负片转正片与正片校正工具 | NeoAnalogLab',
    description: 'Negative Converter 在本机转换彩色与黑白负片、校正反转片，支持无片边扫描、RAW、AI 修复和 16 位导出。无需账号，不上传照片。',
    heading: '免费胶片负片转换与正片校正',
    lead: 'Negative Converter 是 NeoAnalogLab 提供的免费开源胶片处理工具。彩色负片、黑白负片和正片均可在设备上处理，无需注册，也无需将照片上传到服务器。',
    sections: [
      ['如何开始', '<ol><li>打开转换器，选择相机翻拍或扫描得到的照片。可使用 JPG、PNG、TIFF 或支持的 RAW 文件。</li><li>检查导入时建议的片种。不必为了识别重新拍摄片边；缺少片边时也会检查画面中的色罩特征。</li><li>彩色负片需要去除色罩；黑白负片不需要橙色色罩补偿。反转片选择正片模式，避免反转已经正确的明暗。</li><li>调整曝光、白平衡、曲线和颜色，检查细节后导出 PNG、JPEG 或 TIFF。</li></ol>'],
      ['正片校正与仅编辑', '<p>正片校正会分析照片的色调和可信的中性色，使用共用亮度映射，保留输入已有的高光层次。仅编辑跳过自动分析，适合已经调整过的扫描图、数码照片和已转换的负片。手动调整仍然生效。</p><p>默认设置下，仅编辑不会在转换阶段改变解码后的像素。JPEG 压缩、手动编辑和修复可能改变最终输出。输入已经过曝丢失的细节无法凭空找回。</p>'],
      ['没有片边也能使用', '<p>有片边时，可以利用片基和一致的 DX 信息；没有片边时，可以使用画面中的橙色色罩证据。偏暖的正片、已经去过色罩的负片，以及没有片边的黑白图像，都可能无法可靠判断正负。</p><p>识别结果会显示置信度。无可靠正负证据的黑白图像暂按正片方向显示，请在转换面板选择黑白负片或正片。你保存的手动选择会随照片保留，切换照片后不会被重新识别覆盖。</p>'],
      ['局部 AI 修复与批量导出', '<p>在修复面板启用 AI 画笔，等待模型就绪后涂抹缺陷，松开鼠标或手指即可修复。除尘功能也可使用同一模型。MI-GAN 在设备上运行，生成的是合理的替代纹理，并不保证恢复原本隐藏的真实内容。</p><p>批量处理会保留每张照片自己的裁切、修复位置和已保存片种。PNG 与 TIFF 支持 16 位导出；把 8 位输入存成 16 位并不会增加原始信息。</p>'],
      ['隐私、来源与帮助', '<p>照片像素不发送到转换或 AI 推理服务器。网页版会下载程序和模型，并使用 Vercel Web Analytics 统计页面访问；这不读取照片内容。应用源码采用 MIT 许可证，第三方组件保留各自许可。</p><p><a href="https://github.com/lexluthor0304/NegativeConverter">查看源码</a> · <a href="https://github.com/lexluthor0304/NegativeConverter/issues">反馈问题</a> · <a href="/privacy.html?lang=zh">隐私政策</a> · <a href="/download.html?lang=zh">桌面版下载</a></p>']
    ],
    faqs: [
      ['必须拍摄胶片边缘吗？', '不必。工具支持没有片边的扫描图，也会分析画面中的色罩证据。缺少可靠正负证据时，请手动选择片种。'],
      ['黑白照片能百分之百识别正负吗？', '不能。没有片边的灰度正片和负片都可能符合相同的像素特征，工具会提示你选择，而不假装确定。'],
      ['照片会上传到服务器吗？', '不会。转换、颜色调整和 AI 推理在设备上执行。网页版会联网下载程序和模型，并统计不包含照片内容的页面访问。'],
      ['是否收费或需要账号？', '不收费，无需账号，没有导出水印。实际处理速度与容量取决于设备和浏览器。']
    ]
  },
  {
    path: 'ja/index.html', lang: 'ja', homeAlternate: true, title: '無料のフィルムネガ変換・ポジ補正 | NeoAnalogLab',
    description: 'Negative Converter は写真をアップロードせずにカラー・白黒ネガを変換し、ポジを補正。縁なしスキャン、RAW、AI修復、16bit書き出しに対応。',
    heading: '無料のフィルムネガ変換とポジ補正',
    lead: 'Negative Converter は NeoAnalogLab が提供する無料のオープンソース写真処理ツールです。カラー・白黒ネガとポジを端末内で処理でき、アカウント登録や写真のアップロードは不要です。',
    sections: [
      ['使い始めるには', '<ol><li>変換ツールを開き、カメラで複写した写真やスキャナー画像を選びます。JPG、PNG、TIFF、対応するカメラ RAW を読み込めます。</li><li>読み込み時に提案されるフィルム種類とプレビューを確認します。フィルムの縁を撮り直す必要はありません。</li><li>カラーネガでは色マスクを補正します。白黒ネガにはオレンジマスク補正を適用しません。リバーサルフィルムはポジを選びます。</li><li>露出、ホワイトバランス、カーブ、色を調整し、PNG、JPEG、TIFF で書き出します。</li></ol>'],
      ['ポジ補正と編集のみ', '<p>ポジ補正は階調と信頼できる中性色を解析し、共通の階調マッピングで入力に残るハイライトの差を保持します。編集のみは自動解析を省き、調整済みスキャン、デジタル写真、変換済みネガに向いています。手動調整は引き続き適用されます。</p><p>中立設定の編集のみでは、変換段階の復号済み画素値を維持します。JPEG 圧縮、手動編集、修復は最終出力を変える場合があります。入力で失われた白飛びの情報は復元できません。</p>'],
      ['フィルムの縁がない場合', '<p>縁があれば片基や矛盾のない DX 情報を利用できます。縁がなくても画像全体のオレンジマスクを調べます。ただし、暖色のポジ、マスク補正済みのネガ、縁のない白黒画像では正負を確定できないことがあります。</p><p>判定の信頼度を表示します。根拠のない白黒画像は暫定的にポジの向きで表示するため、変換パネルで白黒ネガかポジを選んでください。保存した手動選択は写真ごとに維持されます。</p>'],
      ['AI 修復と一括書き出し', '<p>レタッチで AI ブラシを有効にし、モデルの準備ができたら傷の範囲を塗ります。マウスや指を離すと修復します。自動除塵でも同じモデルを利用できます。MI-GAN は端末内で周囲から自然に見える内容を推定するため、隠れた元の情報を正確に復元する保証はありません。</p><p>一括処理でも各写真のトリミング、修復位置、保存済みの種類を維持します。PNG と TIFF は 16bit 書き出しに対応しますが、8bit 入力を 16bit に保存しても元の情報量は増えません。</p>'],
      ['プライバシーとサポート', '<p>写真の画素は変換サーバーや AI 推論サーバーに送信しません。Web 版はプログラムとモデルを取得し、Vercel Web Analytics でページ閲覧を計測しますが、写真内容は読み取りません。アプリのソースは MIT ライセンスで、第三者の構成要素にはそれぞれのライセンスが適用されます。</p><p><a href="https://github.com/lexluthor0304/NegativeConverter">ソースコード</a> · <a href="https://github.com/lexluthor0304/NegativeConverter/issues">不具合報告</a> · <a href="/privacy.html?lang=ja">プライバシー</a> · <a href="/download.html?lang=ja">デスクトップ版</a></p>']
    ],
    faqs: [
      ['フィルムの縁も撮影する必要がありますか？', 'ありません。縁なし画像でもマスクの特徴を調べます。正負を判断する根拠が不足する場合は、種類を手動で選んでください。'],
      ['白黒写真の正負を必ず自動判定できますか？', 'できません。縁のない白黒ポジとネガは同じ画素上の特徴を持ち得るため、判定できないときは選択を求めます。'],
      ['写真はアップロードされますか？', '写真はアップロードしません。変換、色補正、AI 推論は端末内で実行します。Web 版のプログラム取得と写真内容を含まない閲覧計測には通信を利用します。'],
      ['料金やアカウントは必要ですか？', '無料でアカウントも不要です。透かしは入りません。処理速度や扱える画像サイズは端末とブラウザーによって異なります。']
    ]
  }
];
