import '../styles/studio.css';
import '../styles/pixel-fonts.css';
import '../styles/studio-pixel.css';

export const studioText = {
  zh: {
    preview: '本地胶片暗房', add: '添加照片', menu: '帮助与设置',
    loupe: '实时放大镜', loupeHint: '把相机对准底片，实时看到转正后的画面；拍下即加入照片列表。',
    title: '免费胶片负片转换', subtitle: '在本机转换负片、校正正片，无需上传照片。',
    importBatch: '可多选照片，也可把一组照片拖到这里',
    importHint: '自动取景与转换 · 保留原文件 · 照片不上传', formats: '支持 RAW、TIFF、PNG 和 JPEG',
    edit: '调色', editHint: '从自然的正片开始，找到你的色彩。', look: '色彩风格',
    natural: '自然', warm: '暖调', frontier: '鲜明', noritsu: '柔和',
    basic: '基本调整', brightness: '亮度', contrast: '对比', temperature: '冷暖', tint: '色偏', saturation: '饱和',
    cool: '冷', warmEnd: '暖', green: '绿', magenta: '洋红',
    balance: '校正偏色', reset: '重置调色', more: '更多调整', repair: '修复',
    conversion: '转换', conversionHint: '胶片类型、片基与引擎。默认自动处理，需要时可以手动校正。',
    processing: '正在处理照片…', ready: '正片已就绪', failed: '转换未完成，请在“转换”中重试',
    empty: '添加照片后开始调色', photos: '照片', sync: '同步调色', selected: '已选 {count} 张',
    syncHint: '只同步色彩，不改变其他照片的裁切、片基和修复。', synced: '已同步到 {count} 张照片',
    export: '导出', sampleHint: '在照片上点击应为中性灰的区域；按 Esc 取消。',
    retry: '重新转换', advancedHint: '只在需要时展开。这里保留原来的精细控制。',
    exportSettings: '文件格式与质量', exportSelected: '导出所选 {count} 张', exportCurrent: '导出当前照片', exportCurrentDng: '导出当前照片（线性 DNG）', undo: '撤销', redo: '重做',
    exportIndividualSelected: '逐张下载所选 {count} 张', selectionHint: '勾选照片；按住 Shift 可连续选择。',
    composition: '构图', border: '边框', curves: '曲线', fine: 'RGB / CMY 精调', looks: '全部风格与预设',
    lens: '镜头校正', autoFrame: '自动取景设置', compositionHint: '导入时自动识别成像区域。支持 135、半格、宽幅及 120 多种画幅；识别不可靠时保留完整画面，供你确认。',
    borderHint: '添加模拟胶片齿孔与边码；不是恢复原片上被裁掉的信息。预览与导出可分别设置。',
    borderPreview: '预览胶片边框', borderExport: '导出时包含边框与边码', borderExportAction: '导出带边框照片',
    batch: '批量工具', batchHint: '同步调色只复制色彩。处理设置还包括片基、白平衡校正和镜头等；两者都保留各照片的构图。',
    allSettings: '同步片基与处理设置…', saveSettings: '保存当前照片设置', clearQueue: '清空照片列表…', newSession: '关闭照片，重新开始…',
    mergeHint: '把同一格底片的 2–5 次拍摄合成一个 16 位文件：平均叠加降噪，HDR 合并不同曝光。', mergeAverage: '合成已选：平均叠加', mergeHdr: '合成已选：HDR 包围曝光',
    clearConfirm: '清空照片列表后，将无法再切换到这些照片。请先导出需要保留的结果。继续吗？',
    newConfirm: '关闭当前照片和列表？未导出的结果将丢失，原始文件不会被删除。',
    hidePanel: '收起调整', showPanel: '展开调整', hideStrip: '收起照片条', showStrip: '展开照片条', tabs: '照片工具',
    recipe: '配方', recipeHint: '把这张照片的转换设置压缩成一段短代码或二维码分享；粘贴别人的代码即可套用。不含裁切与文件信息。',
    projectHint: '工程文件记录整卷：照片列表、每张的设置、片基参考和元数据。之后把它和原片一起拖进来即可恢复。', saveProject: '保存工程文件…', openProject: '打开工程文件…', restoreProject: '恢复上次的胶卷',
    metadata: '胶卷与画格', metadataHint: '胶片、ISO、相机、镜头、冲洗、冲印店、日期和画格号会写进导出文件的 EXIF 与 XMP。',
    lightTable: '光桌', stripView: '照片条', lightTableHint: '以网格查看整卷，颜色是否统一一眼可见。',
    cyan: '青 / 红', testStrip: '试条', dodgeBurn: '加减光', flatField: '平场校正', labMatch: '匹配店扫',
    baseSampleHint: '点击未曝光的胶片边缘采样；按 Esc 取消。', resetAll: '重置全部调整',
    scope: '当前照片', fullResetConfirm: '重置当前照片的色彩、白平衡和引擎调整？此操作可以撤销。',
    restart: '从原片重新处理…', restartConfirm: '清除当前照片的构图、调色和历史记录，从原片重新转换？请先导出需要保留的结果。',
    settingsConfirm: '将当前照片的处理设置（包括片基、白平衡校正、镜头等）应用到其他所选照片？各照片的构图会保留。',
    borderScope: '边框与边码设置用于本次导出的所有所选照片。', quickColor: '快速定位调色工具',
    autoCrop: '自动裁切成像区域（关闭则保留边字与齿孔）', restoreFrame: '恢复完整画面', frameApplied: '已自动裁切 · 查看构图', frameReview: '未自动裁切 · 请确认构图',
    detectingFrame: '正在识别成像区域与倾斜角度…', frameAnalysis: '颜色仅分析成像区域',
    frameIncomplete: '画格边界不完整 · 已保留全图，请手动确认构图',
    confirmAnalysis: '确认成像区域', analysisHint: '框住要处理的那一格画面，避开片边和齿孔。这里只改变颜色分析范围，不裁切输出，也不重新取样片基。', analysisReview: '成像区域待确认 · 保留原有颜色基准'
  },
  en: {
    preview: 'Your local darkroom', add: 'Add photos', menu: 'Help & settings',
    loupe: 'Live loupe', loupeHint: 'Point a camera at the negative and see it converted live; capture adds the frame to the photos.',
    title: 'Free film negative converter', subtitle: 'Convert negatives and correct slides on your device. No photo uploads.',
    importBatch: 'Select multiple photos, or drop a batch here',
    importHint: 'Auto frame & convert · Originals preserved · No uploads', formats: 'RAW, TIFF, PNG and JPEG welcome',
    edit: 'Color', editHint: 'A natural starting point. A look that is yours.', look: 'Color style',
    natural: 'Natural', warm: 'Warm', frontier: 'Vivid', noritsu: 'Soft',
    basic: 'Adjustments', brightness: 'Brightness', contrast: 'Contrast', temperature: 'Warmth', tint: 'Tint', saturation: 'Saturation',
    cool: 'Cool', warmEnd: 'Warm', green: 'Green', magenta: 'Magenta',
    balance: 'Correct color cast', reset: 'Reset color', more: 'More adjustments', repair: 'Retouch',
    conversion: 'Convert', conversionHint: 'Film type, film base and engine. Start automatically, refine when needed.',
    processing: 'Processing photo…', ready: 'Positive ready', failed: 'Conversion incomplete. Open Convert to retry.',
    empty: 'Add a photo to start editing', photos: 'Photos', sync: 'Sync color', selected: '{count} selected',
    syncHint: 'Only color is synced. Each photo keeps its crop, film base and retouching.', synced: 'Color synced to {count} photos',
    export: 'Export', sampleHint: 'Click an area that should be neutral gray. Press Esc to cancel.',
    retry: 'Convert again', advancedHint: 'Optional controls for a more precise finish.',
    exportSettings: 'File format & quality', exportSelected: 'Export {count} selected', exportCurrent: 'Export current photo', exportCurrentDng: 'Export current photo (linear DNG)', undo: 'Undo', redo: 'Redo',
    exportIndividualSelected: 'Download {count} selected individually', selectionHint: 'Check photos to select. Shift-click selects a range.',
    composition: 'Crop', border: 'Border', curves: 'Curves', fine: 'RGB / CMY fine tuning', looks: 'All styles & presets',
    lens: 'Lens correction', autoFrame: 'Auto frame settings', compositionHint: 'Detect the image area on import: 135, half frame, panoramic and 120 formats. Uncertain detections keep the full image for review.',
    borderHint: 'Add simulated sprockets and edge markings, not recovered film data. Preview and export are separate choices.',
    borderPreview: 'Preview film border', borderExport: 'Include border & markings in export', borderExportAction: 'Export with film border',
    batch: 'Batch tools', batchHint: 'Sync color copies color only. Processing settings also copy film base, WB gains and lens settings. Both preserve each photo’s geometry.',
    allSettings: 'Sync base & processing settings…', saveSettings: 'Save current photo settings', clearQueue: 'Clear photo list…', newSession: 'Close photos & start again…',
    mergeHint: 'Merge 2–5 shots of the same frame into one 16-bit file: average stacks for less noise, HDR combines exposure brackets.', mergeAverage: 'Merge selected: average', mergeHdr: 'Merge selected: HDR brackets',
    clearConfirm: 'Clear the photo list? Export any results you want to keep first.', newConfirm: 'Close this photo and the list? Unexported results will be lost. Original files will not be deleted.',
    hidePanel: 'Hide controls', showPanel: 'Show controls', hideStrip: 'Hide photos', showStrip: 'Show photos', tabs: 'Photo tools',
    recipe: 'Recipe', recipeHint: 'Share this photo’s conversion as a short code or QR; paste someone else’s code to apply it. No crop or file data travels.',
    projectHint: 'A project file records the roll: the photo list, every frame’s settings, the roll reference and the metadata. Drop it back in with the originals to restore everything.', saveProject: 'Save project…', openProject: 'Open project…', restoreProject: 'Restore last roll',
    metadata: 'Roll & frame', metadataHint: 'Film, ISO, camera, lens, process, lab, date and frame number go into the EXIF and XMP of every export.',
    lightTable: 'Light table', stripView: 'Film strip', lightTableHint: 'Show the whole roll as a grid so colour consistency is visible at a glance.',
    cyan: 'Cyan / red', testStrip: 'Test strip', dodgeBurn: 'Dodge and burn', flatField: 'Flat field', labMatch: 'Match a lab scan',
    baseSampleHint: 'Click an unexposed film edge to sample it. Press Esc to cancel.', resetAll: 'Reset all adjustments',
    scope: 'Current photo', fullResetConfirm: 'Reset color, white balance and engine adjustments for this photo? You can undo this change.',
    restart: 'Reprocess from original…', restartConfirm: 'Clear geometry, color and history for this photo and convert the original again? Export any results you want to keep first.',
    settingsConfirm: 'Copy film base, WB gains, lens and other processing settings to the other selected photos? Their geometry will be preserved.',
    borderScope: 'These border and marking settings apply to all photos in this export.', quickColor: 'Jump to color tools',
    autoCrop: 'Crop image area (off: keep original film edges)', restoreFrame: 'Restore full image', frameApplied: 'Auto-cropped · Review framing', frameReview: 'Not auto-cropped · Review framing',
    detectingFrame: 'Detecting the image area and tilt…', frameAnalysis: 'Color analysis uses the image area only',
    frameIncomplete: 'Incomplete frame edges · Full image kept; review framing manually',
    confirmAnalysis: 'Confirm image area', analysisHint: 'Frame the intended image, excluding film edges and holes. This changes color analysis only, not output framing or film-base sampling.', analysisReview: 'Confirm image area · Previous color reference retained'
  },
  ja: {
    preview: 'ローカルのフィルム暗室', add: '写真を追加', menu: 'ヘルプと設定',
    loupe: 'ライブルーペ', loupeHint: 'カメラを原板に向けると変換後の画面がライブで見え、撮影すると写真一覧に加わります。',
    title: '無料のフィルムネガ変換', subtitle: 'ネガ変換もポジ補正も端末内で。写真のアップロードは不要です。',
    importBatch: '複数選択、または写真をまとめてドロップ',
    importHint: '自動取景・変換 · 元画像を保持 · 写真の送信なし', formats: 'RAW・TIFF・PNG・JPEG に対応',
    edit: '色調整', editHint: '自然な仕上がりから、自分らしい色へ。', look: '色のスタイル',
    natural: '自然', warm: '暖色', frontier: '鮮やか', noritsu: '柔らか',
    basic: '基本調整', brightness: '明るさ', contrast: 'コントラスト', temperature: '色温度', tint: '色かぶり', saturation: '彩度',
    cool: '寒色', warmEnd: '暖色', green: '緑', magenta: 'マゼンタ',
    balance: '色かぶりを補正', reset: '色調整をリセット', more: '詳細な調整', repair: '修復',
    conversion: '変換', conversionHint: 'フィルム種類・ベース・エンジン。自動変換を出発点に、必要なところを調整できます。',
    processing: '写真を処理しています…', ready: '変換完了', failed: '変換が完了していません。「変換」から再試行してください。',
    empty: '写真を追加すると色調整できます', photos: '写真', sync: '色調整を同期', selected: '{count} 枚選択中',
    syncHint: '色だけを同期します。切り抜き・フィルムベース・修復は各写真の設定を保ちます。', synced: '{count} 枚に色調整を同期しました',
    export: '書き出し', sampleHint: '写真の中の無彩色の部分をクリック。Esc で終了します。',
    retry: '再変換', advancedHint: '必要なときだけ使える、細かな仕上げのための設定。',
    exportSettings: '形式と画質', exportSelected: '選択した {count} 枚を書き出す', exportCurrent: '現在の写真を書き出す', exportCurrentDng: '現在の写真を書き出す（リニア DNG）', undo: '取り消す', redo: 'やり直す',
    exportIndividualSelected: '選択した {count} 枚を個別に保存', selectionHint: 'チェックで選択。Shift を押しながらクリックで範囲を選べます。',
    composition: '構図', border: '枠', curves: 'カーブ', fine: 'RGB / CMY 微調整', looks: '全スタイルとプリセット',
    lens: 'レンズ補正', autoFrame: '自動フレーム設定', compositionHint: '読み込み時に画像領域を検出。135・ハーフ・パノラマ・120 各画幅に対応。不確かな場合は全体を保持して確認を促します。',
    borderHint: 'パーフォレーションと端文字の再現です。失われた情報の復元ではありません。表示と書き出しは別々に設定できます。',
    borderPreview: 'フィルム枠を表示', borderExport: '枠と端文字を書き出しに含める', borderExportAction: '枠付きで書き出す',
    batch: '一括操作', batchHint: '色同期は色だけをコピーします。処理設定はベース・WB補正・レンズなども同期します。どちらも各写真の構図を保ちます。',
    allSettings: 'ベースと処理設定を同期…', saveSettings: '現在の写真の設定を保存', clearQueue: '写真一覧を空にする…', newSession: '写真を閉じてやり直す…',
    mergeHint: '同じコマの 2〜5 枚の撮影を 1 つの 16 bit ファイルに合成します。平均でノイズを減らし、HDR で露出ブラケットを統合します。', mergeAverage: '選択を合成：平均', mergeHdr: '選択を合成：HDR ブラケット',
    clearConfirm: '写真一覧を空にしますか？必要な結果を先に書き出してください。', newConfirm: '現在の写真と一覧を閉じますか？未保存の結果は失われますが、元ファイルは削除しません。',
    hidePanel: '調整を隠す', showPanel: '調整を表示', hideStrip: '写真一覧を隠す', showStrip: '写真一覧を表示', tabs: '写真ツール',
    recipe: 'レシピ', recipeHint: 'この写真の変換設定を短いコードや QR で共有し、他の人のコードを貼り付けて適用できます。切り抜きやファイル情報は含みません。',
    projectHint: 'プロジェクトには写真一覧・各コマの設定・ロール基準・メタデータが入ります。原板と一緒に戻せば復元できます。', saveProject: 'プロジェクトを保存…', openProject: 'プロジェクトを開く…', restoreProject: '前回のロールを復元',
    metadata: 'ロールとコマ', metadataHint: 'フィルム・ISO・カメラ・レンズ・現像・ラボ・日付・コマ番号を書き出しファイルの EXIF と XMP に書き込みます。',
    lightTable: 'ライトテーブル', stripView: 'フィルムストリップ', lightTableHint: 'ロール全体をサムネイルの一覧で表示し、色の統一を一目で確認します。',
    cyan: 'シアン / 赤', testStrip: 'テストストリップ', dodgeBurn: '覆い焼き・焼き込み', flatField: 'フラットフィールド', labMatch: 'ラボスキャンに合わせる',
    baseSampleHint: '未露光のフィルム端をクリック。Esc で終了します。', resetAll: '全調整をリセット',
    scope: '現在の写真', fullResetConfirm: '色・ホワイトバランス・エンジンの調整をリセットしますか？取り消し可能です。',
    restart: '元画像から再処理…', restartConfirm: '現在の写真の構図・色・履歴を消去して再変換しますか？必要な結果を先に書き出してください。',
    settingsConfirm: 'ベース・WB補正・レンズなどの処理設定を他の選択写真にコピーしますか？各写真の構図は保持します。',
    borderScope: '枠と端文字の設定は、今回書き出す選択写真すべてに適用します。', quickColor: '色調整ツールへの移動',
    autoCrop: '撮影窓を切り抜く（オフで元の端文字・穴を保持）', restoreFrame: '画像全体に戻す', frameApplied: '自動切り抜き済み · 構図確認', frameReview: '未切り抜き · 構図を確認',
    detectingFrame: '撮影窓と傾きを検出しています…', frameAnalysis: '撮影窓のみで色を解析',
    frameIncomplete: '画枠の端が不足 · 全体を保持しました。構図を確認してください',
    confirmAnalysis: '撮影窓を確認', analysisHint: '目的の一コマを、端や穴を除いて囲んでください。色の解析範囲のみ変更し、出力の構図やベース採取は変更しません。', analysisReview: '撮影窓の確認が必要 · 前の色基準を維持'
  }
};

export function mountStudioWorkspace({ getState, getLanguage, isExportLocked, onStyle, onReset, onResetAll, onRestart, onNewSession, onSync, onRetry, onConfirm, onExportBorder, onAutoCrop, onRestoreFrame, onConfirmAnalysis, onMergeShots, onLoupe, onSaveProject, onOpenProject, onRestoreProject }) {
  const $ = id => document.getElementById(id);
  const t = key => (studioText[getLanguage()] || studioText.en)[key];
  const move = (id, target) => target.append($(id));
  const body = document.body;
  body.classList.add('studio');
  const header = document.createElement('header');
  header.className = 'studio-header';
  header.innerHTML = `
    <div class="studio-brand"><span class="studio-mark">NeoAnalogLab</span><span>Negative Converter</span></div>
    <nav id="studioPublicLinks" class="studio-public-links"></nav>
    <nav class="studio-actions"><button id="studioAdd" type="button" data-studio="add"></button><button id="studioLoupe" type="button" data-studio="loupe"></button><span id="studioHistory"></span><div id="studioExport"></div>
      <details id="studioMenu"><summary data-studio="menu"></summary><div class="studio-menu-content"><div id="studioLanguages"></div><div id="studioLinks"></div><button id="studioNewSession" type="button" data-studio="newSession"></button></div></details>
    </nav>`;
  body.prepend(header);
  // GitHub はヘルプ内ではなく、編集中も常に見えるトップバーに置く。
  const github = document.querySelector('.github-link');
  if (github) {
    $('studioMenu').before(github);
    const link = github.querySelector('.github-star-btn-main');
    for (const node of link.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) node.textContent = '';
    }
    const label = document.createElement('span');
    label.className = 'studio-github-label';
    label.textContent = 'GitHub';
    link.append(label);
    link.setAttribute('aria-label', 'GitHub: NegativeConverter');
  }
  move('headerExportProgress', header);
  move('undoBtn', $('studioHistory'));
  move('redoBtn', $('studioHistory'));
  $('studioExport').append(document.querySelector('.export-dropdown'));
  const exportSettings = document.createElement('details');
  exportSettings.id = 'studioExportSettings';
  exportSettings.innerHTML = '<summary data-studio="exportSettings"></summary>';
  ['.export-format-section', '.export-bitdepth-section', '.export-quality-section'].forEach(selector => {
    exportSettings.append(document.querySelector(selector));
  });
  $('exportDropdownMenu').append(exportSettings);
  const exportBorder = document.createElement('label');
  exportBorder.className = 'studio-export-border';
  exportBorder.innerHTML = '<input type="checkbox" id="studioExportBorder"><span data-studio="borderExport"></span>';
  $('exportDropdownMenu').prepend(exportBorder);
  exportBorder.addEventListener('click', event => event.stopPropagation());
  $('studioExportBorder').addEventListener('change', event => onExportBorder(event.target.checked));
  exportSettings.addEventListener('click', event => event.stopPropagation());
  move('exportAllBtn', exportSettings);
  const mobileHistory = document.createElement('div');
  mobileHistory.id = 'studioMobileHistory';
  mobileHistory.innerHTML = '<button type="button" id="studioUndo" data-studio="undo"></button><button type="button" id="studioRedo" data-studio="redo"></button>';
  $('studioLanguages').before(mobileHistory);
  $('studioUndo').addEventListener('click', () => $('undoBtn').click());
  $('studioRedo').addEventListener('click', () => $('redoBtn').click());
  const languages = document.querySelector('.lang-btn')?.parentElement;
  if (languages) $('studioLanguages').append(languages);
  move('buildBadge', $('studioLanguages'));
  ['offlineDownloadLink', 'feedbackBtn', 'privacyDetailsLink', 'shopLink'].forEach(id => move(id, $('studioPublicLinks')));
  const guide = document.querySelector('.header-site-links');
  if (guide) $('studioLinks').append(guide);

  const welcome = $('studioWelcome');
  const importActions = document.createElement('div');
  importActions.className = 'studio-import-actions';
  welcome.after(importActions);
  ['uploadBtn', 'uploadFolderBtn'].forEach(id => move(id, importActions));
  const batchHint = document.createElement('p');
  batchHint.className = 'studio-import-hint';
  batchHint.dataset.studio = 'importBatch';
  importActions.after(batchHint);
  const formatNote = document.createElement('p');
  formatNote.className = 'studio-formats';
  formatNote.dataset.studio = 'formats';
  $('uploadPlaceholder').append(formatNote);
  const makeAutoCropOption = id => {
    const label = document.createElement('label');
    label.className = 'studio-auto-crop';
    label.innerHTML = `<input type="checkbox" id="${id}" checked><span data-studio="autoCrop"></span>`;
    label.querySelector('input').addEventListener('change', event => onAutoCrop(event.target.checked));
    return label;
  };
  $('uploadPlaceholder').append(makeAutoCropOption('studioImportAutoCrop'));
  $('uploadPlaceholder').append($('uploadPlaceholder').querySelector('.upload-privacy-note'));

  const panel = $('controlsPanel');
  const tabs = document.createElement('div');
  tabs.className = 'studio-tabs';
  tabs.setAttribute('role', 'tablist');
  const panes = {};
  for (const key of ['edit', 'composition', 'repair', 'border', 'conversion']) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.id = `studioTab-${key}`;
    tab.dataset.studio = key;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `studioPane-${key}`);
    tab.addEventListener('click', () => selectTab(key));
    tabs.append(tab);
    const pane = document.createElement('section');
    pane.id = `studioPane-${key}`;
    pane.className = 'studio-pane';
    pane.setAttribute('role', 'tabpanel');
    pane.setAttribute('aria-labelledby', tab.id);
    pane.tabIndex = 0;
    panel.append(pane);
    panes[key] = pane;
  }
  panel.prepend(tabs);
  const quickColor = document.createElement('nav');
  quickColor.className = 'studio-color-jumps';
  quickColor.innerHTML = '<button type="button" data-jump="studioBasic" data-studio="basic"></button><button type="button" data-jump="consoleSection">CMYD</button><button type="button" data-jump="studioCurves" data-studio="curves"></button>';
  quickColor.querySelectorAll('button').forEach(button => button.addEventListener('click', () => {
    const target = $(button.dataset.jump);
    if (target.tagName === 'DETAILS') target.open = true;
    target.scrollIntoView({ block: 'start' });
    resize();
  }));
  panes.edit.append(quickColor);
  let activeTab = 'edit';
  function selectTab(key) {
    activeTab = key;
    for (const [name, pane] of Object.entries(panes)) {
      pane.hidden = name !== key;
      $(`studioTab-${name}`).setAttribute('aria-selected', String(name === key));
      $(`studioTab-${name}`).tabIndex = name === key ? 0 : -1;
    }
    panel.scrollTop = 0;
    requestAnimationFrame(resize);
  }
  tabs.addEventListener('keydown', event => {
    const keys = Object.keys(panes);
    let index = keys.indexOf(activeTab);
    if (event.key === 'ArrowRight') index = (index + 1) % keys.length;
    else if (event.key === 'ArrowLeft') index = (index + keys.length - 1) % keys.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = keys.length - 1;
    else return;
    event.preventDefault();
    selectTab(keys[index]);
    $(`studioTab-${keys[index]}`).focus();
  });
  move('histogramContainer', panes.edit);
  const basic = document.createElement('section');
  basic.id = 'studioBasic';
  basic.className = 'studio-basic';
  basic.innerHTML = `<fieldset id="studioColorControls"><legend class="studio-section-label" data-studio="look"></legend>
    <div class="studio-looks">${[['standard', 'natural'], ['warm', 'warm'], ['frontier', 'frontier'], ['noritsu', 'noritsu']].map(([model, key]) => `<button type="button" data-model="${model}" aria-pressed="false"><span class="studio-look-swatch ${model}" aria-hidden="true"></span><span data-studio="${key}"></span></button>`).join('')}</div>
    <h3 class="studio-section-label" data-studio="basic"></h3><div id="studioSliders"></div>
    <div class="studio-color-actions" id="studioColorActions"><button id="studioReset" type="button" data-studio="reset"></button></div>
    </fieldset><p id="studioSampleHint" role="status" data-studio="sampleHint" hidden></p>`;
  panes.edit.append(basic);
  const sliderLabels = { coreExposure: 'brightness', coreContrast: 'contrast', coreTemperature: 'temperature', coreTint: 'tint', coreCyan: 'cyan', coreSaturation: 'saturation' };
  for (const [id, key] of Object.entries(sliderLabels)) {
    const control = $(id).closest('.slider-control');
    $(id + 'Label').dataset.studio = key;
    $('studioSliders').append(control);
    if (id === 'coreTemperature' || id === 'coreTint') {
      const ends = document.createElement('div');
      ends.className = 'studio-slider-ends';
      ends.innerHTML = id === 'coreTemperature'
        ? '<span data-studio="cool"></span><span data-studio="warmEnd"></span>'
        : '<span data-studio="green"></span><span data-studio="magenta"></span>';
      control.append(ends);
    }
  }
  move('sampleWBBtn', $('studioColorActions'));
  $('sampleWBBtn').dataset.studio = 'balance';

  // Enlarger paradigm (filtration, stops, grade) lives beside the digital
  // sliders; the toggle inside it switches body.studio-enlarger.
  $('studioSliders').after($('enlargerSection'));
  const makeDrawer = (target, id, label, items, hint) => {
    const drawer = document.createElement('details');
    drawer.id = id;
    drawer.className = 'studio-drawer';
    drawer.innerHTML = `<summary data-studio="${label}"></summary><div class="studio-drawer-body">${hint ? `<p class="studio-drawer-hint" data-studio="${hint}"></p>` : ''}</div>`;
    target.append(drawer);
    items.forEach(item => move(item, drawer.lastElementChild));
    return drawer;
  };
  move('consoleSection', panes.edit);
  makeDrawer(panes.edit, 'studioTestStrip', 'testStrip', ['testStripSection']);
  makeDrawer(panes.edit, 'studioLabMatch', 'labMatch', ['labMatchSection']);
  makeDrawer(panes.edit, 'studioMetadata', 'metadata', ['metadataSection'], 'metadataHint');
  makeDrawer(panes.edit, 'studioRecipe', 'recipe', ['recipeSection'], 'recipeHint');
  const curve = makeDrawer(panes.edit, 'studioCurves', 'curves', []);
  curve.lastElementChild.append($('curveCanvas').closest('.control-group'));
  const looks = makeDrawer(panes.edit, 'studioLooks', 'looks', []);
  looks.lastElementChild.append($('coreColorModelStep2').closest('.control-group'));
  move('cmySection', looks.lastElementChild);
  move('paperSection', looks.lastElementChild);
  makeDrawer(panes.edit, 'studioMore', 'more', ['toneSection', 'colorSection', 'additionalSection']);
  $('additionalSection').querySelector('.section-title').dataset.studio = 'fine';
  const composition = panes.composition;
  composition.innerHTML = '<p class="studio-pane-hint" data-studio="compositionHint"></p><div class="studio-tool-actions" id="studioGeometryActions"></div>';
  composition.prepend(makeAutoCropOption('studioAutoCrop'));
  const restoreFrame = document.createElement('button');
  restoreFrame.type = 'button';
  restoreFrame.id = 'studioRestoreFrame';
  restoreFrame.className = 'toolbar-btn';
  restoreFrame.dataset.studio = 'restoreFrame';
  restoreFrame.addEventListener('click', onRestoreFrame);
  $('studioGeometryActions').append(restoreFrame);
  const analysisButton = document.createElement('button');
  analysisButton.type = 'button';
  analysisButton.id = 'studioConfirmAnalysis';
  analysisButton.className = 'toolbar-btn';
  analysisButton.dataset.studio = 'confirmAnalysis';
  analysisButton.addEventListener('click', onConfirmAnalysis);
  composition.append(analysisButton);
  const analysisStatus = document.createElement('p');
  analysisStatus.id = 'studioAnalysisStatus';
  analysisStatus.className = 'studio-pane-hint';
  analysisStatus.setAttribute('role', 'status');
  composition.append(analysisStatus);
  for (const [key, source] of [['crop', 'cropBtn'], ['rotateLeft', 'rotateLeftBtn'], ['rotateRight', 'rotateRightBtn'], ['mirror', 'mirrorBtn']]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toolbar-btn';
    button.dataset.i18n = key;
    button.textContent = $(source).textContent.trim();
    button.dataset.studioProxy = source;
    button.addEventListener('click', () => $(source).click());
    $('studioGeometryActions').append(button);
  }
  move('autoFrameBtn', $('studioGeometryActions'));
  move('autoFrameSelectedBtn', $('studioGeometryActions'));
  makeDrawer(composition, 'studioAutoFrame', 'autoFrame', ['autoFrameSettingsSection']);
  move('aiBrushSection', panes.repair);
  move('dustRemovalSection', panes.repair);
  makeDrawer(panes.repair, 'studioDodgeBurn', 'dodgeBurn', ['dodgeBurnSection']);
  makeDrawer(panes.repair, 'studioFlatField', 'flatField', ['flatFieldSection']);
  const lens = makeDrawer(panes.repair, 'studioLens', 'lens', []);
  lens.lastElementChild.append($('lensCorrectionPanel').closest('.control-group'));
  const applyLens = document.createElement('button');
  applyLens.type = 'button';
  applyLens.id = 'studioApplyLens';
  applyLens.className = 'toolbar-btn';
  applyLens.dataset.studio = 'retry';
  applyLens.addEventListener('click', onRetry);
  lens.lastElementChild.append(applyLens);
  panes.border.innerHTML = '<p class="studio-pane-hint" data-studio="borderHint"></p><div id="studioBorderActions" class="studio-tool-actions"></div><p class="studio-pane-hint" data-studio="borderScope"></p>';
  move('sprocketPreviewBtn', $('studioBorderActions'));
  $('sprocketPreviewBtn').querySelector('span').dataset.studio = 'borderPreview';
  move('exportSprocketBtn', $('studioBorderActions'));
  $('exportSprocketBtn').dataset.studio = 'borderExportAction';
  move('sprocketSettingsSection', panes.border);
  panes.conversion.innerHTML = '<p class="studio-pane-hint" data-studio="conversionHint"></p>';
  move('filmSettingsSection', panes.conversion);
  move('advancedSection', panes.conversion);
  const retry = document.createElement('button');
  retry.id = 'studioRetry';
  retry.type = 'button';
  retry.dataset.studio = 'retry';
  panes.conversion.append(retry);
  const resetAll = document.createElement('button');
  resetAll.type = 'button';
  resetAll.id = 'studioResetAll';
  resetAll.className = 'toolbar-btn';
  resetAll.dataset.studio = 'resetAll';
  resetAll.addEventListener('click', async () => {
    if (await onConfirm(t('fullResetConfirm'))) onResetAll();
  });
  panes.conversion.append(resetAll);
  const restart = document.createElement('button');
  restart.type = 'button';
  restart.id = 'studioRestart';
  restart.className = 'toolbar-btn';
  restart.dataset.studio = 'restart';
  restart.addEventListener('click', async () => {
    if (await onConfirm(t('restartConfirm'))) onRestart();
  });
  panes.conversion.append(restart);

  const status = document.createElement('div');
  status.className = 'studio-image-status';
  status.innerHTML = `<span id="studioStatus" role="status"></span><span id="studioFilename"></span><button id="studioFrameNotice" type="button" hidden></button><button id="studioTogglePanel" type="button" aria-controls="controlsPanel" aria-expanded="true"></button>`;
  status.querySelector('#studioFrameNotice').addEventListener('click', () => {
    body.classList.remove('studio-panel-hidden');
    panel.hidden = false;
    selectTab('composition');
    $('studioTab-composition').focus();
    syncLayout();
  });
  document.querySelector('.preview-section').prepend(status);
  const strip = document.createElement('section');
  strip.className = 'studio-filmstrip';
  strip.id = 'studioFilmstrip';
  strip.innerHTML = `<div class="studio-strip-header"><button id="studioToggleStrip" type="button" aria-controls="fileListSection" aria-expanded="true" data-studio="photos"></button><button id="studioToggleLightTable" type="button" aria-pressed="false" data-studio="lightTable"></button><span id="studioSelection"></span><button id="studioSync" type="button" data-studio="sync"></button><details id="studioBatchMenu"><summary data-studio="batch"></summary><div class="studio-batch-content"><p data-studio="batchHint"></p><div id="studioBatchActions"></div><p data-studio="mergeHint"></p><button id="studioMergeAverage" type="button" data-studio="mergeAverage"></button><button id="studioMergeHdr" type="button" data-studio="mergeHdr"></button><p data-studio="projectHint"></p><button id="studioSaveProject" type="button" data-studio="saveProject"></button><button id="studioOpenProject" type="button" data-studio="openProject"></button><button id="studioRestoreProject" type="button" data-studio="restoreProject" hidden></button><button id="studioClearQueue" type="button" data-studio="clearQueue"></button></div></details></div>`;
  document.querySelector('.app-main').append(strip);
  move('fileListSection', strip);
  $('studioSync').title = t('syncHint');
  move('saveSettingsBtn', $('studioBatchActions'));
  move('applyToSelectedBtn', $('studioBatchActions'));
  $('saveSettingsBtn').dataset.studio = 'saveSettings';
  $('applyToSelectedBtn').dataset.studio = 'allSettings';
  $('studioClearQueue').addEventListener('click', async () => {
    if (await onConfirm(t('clearConfirm'))) $('clearFileListBtn').click();
  });
  for (const [id, mode] of [['studioMergeAverage', 'average'], ['studioMergeHdr', 'hdr']]) {
    $(id).addEventListener('click', () => { $('studioBatchMenu').open = false; onMergeShots?.(mode); });
  }
  $('studioSaveProject').addEventListener('click', () => { $('studioBatchMenu').open = false; onSaveProject?.(); });
  $('studioOpenProject').addEventListener('click', () => { $('studioBatchMenu').open = false; onOpenProject?.(); });
  $('studioRestoreProject').addEventListener('click', () => { $('studioBatchMenu').open = false; onRestoreProject?.(); });
  $('studioNewSession').addEventListener('click', async () => {
    if (!getState().originalImageData || await onConfirm(t('newConfirm'))) onNewSession();
  });
  const syncLayout = () => {
    const panelHidden = body.classList.contains('studio-panel-hidden');
    const stripHidden = body.classList.contains('studio-strip-hidden');
    panel.hidden = panelHidden;
    $('studioTogglePanel').textContent = t(panelHidden ? 'showPanel' : 'hidePanel');
    $('studioTogglePanel').setAttribute('aria-expanded', String(!panelHidden));
    $('studioToggleStrip').setAttribute('aria-expanded', String(!stripHidden));
    $('studioToggleStrip').title = t(stripHidden ? 'showStrip' : 'hideStrip');
    const lightTable = body.classList.contains('studio-lighttable');
    $('studioToggleLightTable').setAttribute('aria-pressed', String(lightTable));
    $('studioToggleLightTable').dataset.studio = lightTable ? 'stripView' : 'lightTable';
    $('studioToggleLightTable').textContent = t(lightTable ? 'stripView' : 'lightTable');
    $('studioToggleLightTable').title = t('lightTableHint');
  };
  // The light table is the film strip grown into a grid: turning it on also
  // brings a hidden strip back.
  $('studioToggleLightTable').addEventListener('click', () => {
    const on = body.classList.toggle('studio-lighttable');
    if (on) body.classList.remove('studio-strip-hidden');
    syncLayout();
    requestAnimationFrame(resize);
  });
  for (const [id, className] of [['studioTogglePanel', 'studio-panel-hidden'], ['studioToggleStrip', 'studio-strip-hidden']]) {
    $(id).addEventListener('click', () => {
      body.classList.toggle(className);
      syncLayout();
      requestAnimationFrame(resize);
    });
  }

  $('studioAdd').addEventListener('click', () => $('addFilesToolbarBtn').click());
  $('studioLoupe').hidden = !(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function');
  $('studioLoupe').addEventListener('click', () => onLoupe?.());
  $('studioReset').addEventListener('click', onReset);
  $('studioSync').addEventListener('click', onSync);
  $('studioRetry').addEventListener('click', onRetry);
  basic.querySelectorAll('[data-model]').forEach(button => button.addEventListener('click', () => onStyle(button.dataset.model)));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      for (const id of ['studioMenu', 'studioBatchMenu']) {
        if ($(id).open && $(id).contains(document.activeElement)) $(id).querySelector('summary').focus();
        $(id).open = false;
      }
    }
  });
  document.addEventListener('click', event => {
    if (!$('studioMenu').contains(event.target)) $('studioMenu').open = false;
    if (!$('studioBatchMenu').contains(event.target)) $('studioBatchMenu').open = false;
  });
  const resize = () => window.dispatchEvent(new Event('resize'));
  document.querySelectorAll('.studio-drawer').forEach(drawer => drawer.addEventListener('toggle', resize));
  selectTab('edit');
  // 新 UI へ部品を配置したら、受け渡し用の空コンテナーを破棄する。
  $('studioHeaderSource')?.remove();
  $('studioExportSource')?.remove();
  let observedReady;
  return {
    text: t,
    sync() {
      const state = getState();
      const loaded = Boolean(state.originalImageData);
      const ready = loaded && state.currentStep >= 3 && Boolean(state.processedImageData);
      body.classList.toggle('studio-loaded', loaded);
      body.classList.toggle('studio-ready', ready);
      document.querySelectorAll('[data-studio]').forEach(el => { el.textContent = t(el.dataset.studio); });
      const busy = body.dataset.studioBusy === 'true';
      const locked = busy || state.cropping || isExportLocked();
      for (const id of ['studioImportAutoCrop', 'studioAutoCrop']) $(id).checked = Boolean(state.autoFrame.onImport);
      $('studioRestoreFrame').disabled = !loaded || locked || !(state.cropRegion || state.rotationAngle || state.mirrored);
      const frameMeta = state.autoFrame.lastDiagnostics;
      $('studioConfirmAnalysis').disabled = !loaded || locked || state.cropping || busy;
      $('studioAnalysisStatus').textContent = t(frameMeta?.analysisNeedsReview ? 'analysisReview' : 'analysisHint');
      $('studioFrameNotice').hidden = !ready || !frameMeta?.importAuto || state.samplingMode;
      $('studioFrameNotice').textContent = t(frameMeta?.analysisNeedsReview ? 'analysisReview' : frameMeta?.appliedMode === 'crop' ? 'frameApplied' : frameMeta?.frameIncomplete ? 'frameIncomplete' : frameMeta?.imageArea ? 'frameAnalysis' : 'frameReview');
      $('studioFrameNotice').dataset.status = frameMeta?.appliedMode || '';
      $('studioFrameNotice').disabled = state.cropping || busy;
      panel.inert = busy;
      strip.inert = busy;
      tabs.setAttribute('aria-label', t('tabs'));
      quickColor.setAttribute('aria-label', t('quickColor'));
      syncLayout();
      $('studioColorControls').disabled = !ready || busy || state.cropping;
      $('studioHistory').hidden = !loaded;
      $('studioExport').hidden = !loaded;
      $('studioStatus').textContent = t(busy ? 'processing' : ready ? 'ready' : loaded ? 'failed' : 'empty');
      $('studioFilename').textContent = state.loadedFile?.name || '';
      $('studioSampleHint').hidden = !state.samplingMode;
      $('studioSampleHint').textContent = t(state.samplingMode === 'filmBase' ? 'baseSampleHint' : 'sampleHint');
      if (state.samplingMode) $('studioStatus').textContent = $('studioSampleHint').textContent;
      const count = state.fileQueue.filter(item => item.selected).length;
      $('studioSelection').textContent = t('selected').replace('{count}', count);
      $('studioSync').disabled = !ready || busy || state.cropping || isExportLocked() || !state.fileQueue.some(item => item.selected && item.file !== state.loadedFile);
      $('studioSync').title = t('syncHint');
      $('exportZipBtn').textContent = t('exportSelected').replace('{count}', count);
      $('exportSingleBtn').textContent = t(state.exportFormat === 'dng' ? 'exportCurrentDng' : 'exportCurrent');
      $('exportAllBtn').textContent = t('exportIndividualSelected').replace('{count}', count);
      $('studioSelection').title = t('selectionHint');
      $('studioUndo').disabled = $('undoBtn').disabled;
      $('studioRedo').disabled = $('redoBtn').disabled;
      $('studioRetry').disabled = !loaded || busy || state.cropping;
      $('studioApplyLens').disabled = !loaded || locked;
      $('studioResetAll').disabled = !ready || locked;
      $('studioRestart').disabled = !loaded || locked;
      $('exportSprocketBtn').disabled = !ready || locked || state.exportFormat === 'dng';
      $('studioExportBorder').checked = Boolean(state.exportSprocketHolesEnabled);
      $('studioExportBorder').disabled = !ready || locked;
      $('studioClearQueue').disabled = locked || !state.fileQueue.length;
      $('studioSaveProject').disabled = locked || !state.fileQueue.length;
      $('studioOpenProject').disabled = locked;
      $('studioRestoreProject').hidden = !state.projectRecoveryAvailable;
      const mergeable = !locked && count >= 2 && count <= 5;
      $('studioMergeAverage').disabled = !mergeable;
      $('studioMergeHdr').disabled = !mergeable;
      $('studioNewSession').disabled = locked;
      $('studioAdd').disabled = locked;
      $('studioLoupe').disabled = locked;
      $('studioLoupe').title = t('loupeHint');
      $('studioTogglePanel').disabled = state.cropping;
      $('studioToggleStrip').disabled = state.cropping;
      $('studioToggleLightTable').disabled = state.cropping;
      $('saveSettingsBtn').style.display = 'inline-flex';
      $('applyToSelectedBtn').style.display = 'inline-flex';
      $('saveSettingsBtn').disabled = !ready || locked;
      $('applyToSelectedBtn').disabled = !ready || locked || !state.fileQueue.some(item => item.selected && item.file !== state.loadedFile);
      document.querySelectorAll('[data-studio-proxy]').forEach(button => {
        button.disabled = !loaded || locked || $(button.dataset.studioProxy).disabled;
      });
      $('exportBtn').disabled = !ready || busy || state.cropping || isExportLocked();
      $('exportBtn').textContent = t('export');
      $('uploadPlaceholder').querySelector('.upload-text')?.setAttribute('hidden', '');
      const privacy = $('uploadPlaceholder').querySelector('[data-i18n="privacyBannerTitle"]');
      if (privacy) privacy.textContent = t('importHint');
      basic.querySelectorAll('[data-model]').forEach(button => {
        button.setAttribute('aria-pressed', String(state.coreColorModel === button.dataset.model));
      });
      if (loaded) {
        panel.style.display = 'flex';
        $('filmSettingsSection').style.display = 'block';
        ['autoFrameSettingsSection', 'sprocketSettingsSection'].forEach(id => { $(id).style.display = 'block'; });
        ['toneSection', 'colorSection', 'cmySection', 'additionalSection', 'consoleSection', 'aiBrushSection', 'dustRemovalSection', 'advancedSection', 'enlargerSection', 'testStripSection', 'paperSection', 'dodgeBurnSection', 'flatFieldSection', 'labMatchSection', 'metadataSection', 'recipeSection'].forEach(id => {
          $(id).style.display = ready ? 'block' : 'none';
        });
      }
      if (ready !== observedReady) {
        observedReady = ready;
        requestAnimationFrame(resize);
      }
    }
  };
}
