    import pako from 'pako';
    import UPNGImport from 'upng-js';
    import UTIFImport from 'utif';
    import JSZipImport from 'jszip';
    import opencvScriptUrl from '@techstark/opencv-js/dist/opencv.js?url';
    import {
      createLensfun,
      LF_SEARCH_SORT_AND_UNIQUIFY
    } from '@neoanaloglabkk/lensfun-wasm';
    import createLensfunCoreModule from '@neoanaloglabkk/lensfun-wasm/core';
    import lensfunCoreWasmUrl from '@neoanaloglabkk/lensfun-wasm/core-wasm?url';
    import lensfunCoreDataUrl from '@neoanaloglabkk/lensfun-wasm/core-data?url';
    import '@fontsource/inter/400.css';
    import '@fontsource/inter/500.css';
    import '@fontsource/inter/600.css';

    import { convertFrameWithRouter } from '../pipeline/conversionRouter.js';
    import { invalidateSilverCoreCache } from '../pipeline/silverAdapter.js';
    import { Histogram } from '../silvercore/ui/Histogram.js';
    import {
      detectDust, updateDustStrength, inpaintMasked,
      refineMaskIntelligent, refineMaskDirect, refineMaskRemove
    } from '../silvercore/engine/DustRemoval.js';
    import { getLoadingOverlay } from '../ui/LoadingOverlay.js';
    import {
      workerApplyAdjustments,
      workerEncodePng16,
      workerEncodeTiff,
      isWorkerAvailable
    } from '../workers/workerBridge.js';

    const UPNG = (UPNGImport && typeof UPNGImport.decode === 'function')
      ? UPNGImport
      : (UPNGImport && UPNGImport.default && typeof UPNGImport.default.decode === 'function'
        ? UPNGImport.default
        : UPNGImport);
    const UTIF = (UTIFImport && typeof UTIFImport.decode === 'function')
      ? UTIFImport
      : (UTIFImport && UTIFImport.default && typeof UTIFImport.default.decode === 'function'
        ? UTIFImport.default
        : UTIFImport);
    const JSZipCtor = (typeof JSZipImport === 'function')
      ? JSZipImport
      : (JSZipImport && typeof JSZipImport.default === 'function' ? JSZipImport.default : null);

    // ===========================================
    // Internationalization
    // ===========================================
    const i18n = {
      zh: {
        title: "负片转正片",
        privacyBannerTitle: "纯前端运行 · 不上传照片",
        privacyBannerBody: "你选择的照片只在你的浏览器里处理，我们的服务器收不到。",
        privacyBannerLink: "查看隐私说明",
        offlineDownloadLink: "下载离线版",
        privacyBannerToggleLabel: "隐藏隐私说明横幅",
        desktopUpdateTitle: "发现新版本",
        desktopUpdateBody: "当前版本 {current}，最新版本 {latest}。",
        desktopUpdateAction: "前往下载更新",
        desktopUpdateLater: "稍后提醒",
        dropHint: "拖放图片到此处或点击读取",
        selectFile: "选择文件",
        applyRotate: "应用",
        mirror: "镜像",
        crop: "裁剪",
        applyCrop: "应用裁剪",
	        cancelCrop: "取消",
	        autoFrame: "自动识别边框",
	        autoFrameSelected: "批量自动识别",
	        beforeAfter: "前后对比",
	        convert: "下一步：胶片设置",
	        convertPositive: "下一步：正片模式",
	        histogram: "直方图",
	        histogramDragHint: "可拖动",
	        loadError: "加载文件失败",
	        rawUnsupported: "当前 Safari 版本不支持 RAW 解码，请升级 Safari（建议 iOS 16.4+）或先转为 TIFF/JPEG。",
        workflow: "工作流程",
        stepCrop: "裁剪图像（移除胶片外区域）",
        stepBase: "设置色罩基准（新手按步骤即可）",
        stepAdjust: "调整颜色并导出",
        step1: "第1步：裁剪",
        step2: "第2步：色罩",
        step3: "第3步：调整",
        step2ModeBorder: "有边框",
        step2ModeNoBorder: "无边框 / ES-2",
        filmSettings: "胶片设置",
        colorFilm: "彩色",
        bwFilm: "黑白",
        positiveFilm: "正片",
	        filmBaseInfo: "看得到橙色未曝光边缘：请手动采样。看不到边缘（如 ES-2）：请点“自动检测色罩”或“使用整卷参考值”。",
	        positiveModeInfo: "色罩采样只用于彩色负片。黑白负片或正片不需要色罩采样：选择片种后，直接点击“下一步：转换并进入调整”。",
	        guideToggleOn: "引导：开",
	        guideToggleOff: "引导：关",
        noviceGuideTitle: "新手引导",
        noviceGuidePhaseStep1: "第1步：裁剪",
        noviceGuidePhaseStep2: "第2步：胶片设置",
        noviceGuidePhaseStep3: "第3步：调整与导出",
        noviceGuidePrimaryStep1: "先把画面裁到只剩胶片有效区域，再进入下一步。",
        noviceGuidePrimaryStep2ColorBorder: "当前是彩色负片（有边框）：优先手动采样色罩，结果会更稳定。",
        noviceGuidePrimaryStep2ColorNoBorder: "当前是彩色负片（无边框 / ES-2）：优先自动检测或套用整卷参考。",
        noviceGuidePrimaryStep2Bw: "当前是黑白负片：无需色罩采样，确认片种后会自动进入调整。",
        noviceGuidePrimaryStep2Positive: "当前是正片：无需色罩采样，点击“下一步：转换并进入调整”。",
        noviceGuidePrimaryStep3Single: "现在做细调并导出当前图片。",
        noviceGuidePrimaryStep3Batch: "现在进入批处理收尾：统一设置并批量导出。",
        noviceGuideChecklistStep1Crop: "需要时先用自动识别边框，再手动微调裁剪。",
        noviceGuideChecklistStep1Next: "裁剪完成后点击“下一步：胶片设置”或“下一步：正片模式”。",
        noviceGuideChecklistStep2ColorBorderSample: "点击“手动采样色罩”，在未曝光橙色边缘取样。",
        noviceGuideChecklistStep2ColorBorderFallback: "找不到可靠边缘时，改用“自动检测色罩”。",
        noviceGuideChecklistStep2ColorNoBorderAuto: "先点“自动检测色罩”。",
        noviceGuideChecklistStep2ColorNoBorderReference: "有参考帧时，点“使用整卷参考值”会更稳定。",
        noviceGuideChecklistStep2BwSelect: "确认片种为“黑白”。",
        noviceGuideChecklistStep2BwAuto: "系统会自动转换并进入第3步。",
        noviceGuideChecklistStep2PositiveConvert: "点击“下一步：转换并进入调整”进入第3步。",
        noviceGuideChecklistStep3SampleGray: "颜色偏差时先“采样灰点”，再微调参数。",
        noviceGuideChecklistStep3Export: "完成后从底部导出（单张或 ZIP）。",
        noviceGuideChecklistStep3BatchSave: "调好当前图后点“保存设置”。",
        noviceGuideChecklistStep3BatchApply: "需要整卷统一参数时点“应用到已选中”。",
        noviceGuideChecklistStep3BatchExport: "最后执行“批量导出 (ZIP)”或“逐个下载全部”。",
        noviceGuideStatusAutoToStep3: "完成采样/自动检测后会自动进入第3步（无需再点下一步）。",
        noviceGuideStatusAutoToStep3Ready: "色罩已就绪，系统将自动进入第3步；你也可手动点“下一步：转换并进入调整”。",
        noviceGuideStatusManualConvert: "此模式不会自动跳转，请手动点击转换按钮进入第3步。",
        noviceGuideStatusStep3Collapsed: "为降低新手复杂度，第3步面板已默认折叠；按需展开即可。",
        noviceGuideWarningMaskUnset: "还未设置色罩，直接转换可能偏色。",
        noviceGuideWarningReferenceMissing: "尚未设置整卷参考值；自动检测结果不稳定时建议先设参考。",
	        quickGuide: "快速引导：\n• 彩色负片：第1步裁剪 → 下一步：胶片设置 →（第2步）设置色罩（手动/自动/整卷参考）→ 下一步：转换并进入调整 → 第3步调色导出\n• 黑白负片：第1步裁剪 → 下一步：胶片设置 → 片种选“黑白”→ 下一步：转换并进入调整（无需色罩）\n• 正片：第1步裁剪 → 下一步：正片模式 → 下一步：转换并进入调整（无需色罩）\n批处理：添加多张 → 处理一张作为参考 →「保存设置/应用到已选中」→ 最后「批量导出 (ZIP)」。\n提示：两个“下一步”按钮只在第1步显示；看左上角步骤徽标确认当前在哪一步。",
	        sampleBase: "手动采样色罩",
	        autoDetect: "自动检测色罩",
	        useRollReference: "使用整卷参考值",
        step2FirstHint: "提示：如果你找不到橙色边缘，请切换到“无边框 / ES-2”再继续。",
        guideStep2Title: "第一次用？按下面 3 步做",
        guideStep2Intro: "先选择“有边框”或“无边框 / ES-2”，再按步骤执行。",
        guideTermMaskHelp: "“色罩”就是胶片未曝光的橙色底片区域，常在齿孔附近或画面边缘。",
        guideBorderStep1: "点击“手动采样色罩”。",
        guideBorderStep2: "在图上点击橙色未曝光边缘（尽量避开画面内容）。",
        guideBorderStep3: "点击“下一步：转换并进入调整”。",
        guideNoBorderStep1: "点击“自动检测色罩”。",
        guideNoBorderStep2: "如果你有参考图，点击“使用整卷参考值”。",
        guideNoBorderStep3: "点击“下一步：转换并进入调整”。",
        guideTipMismatch: "如果采样后颜色怪异，通常是点到了画面内容。请重新采样或切到“无边框 / ES-2”。",
        guideTipFallback: "没有参考值也没关系，先点“自动检测色罩”；不满意可再微调。",
        guideTipReady: "色罩已设置完成，可以直接进入下一步。",
        guideTipReferenceReady: "检测不到边缘时，优先使用“整卷参考值”通常更稳定。",
        guideAutoDetectFallback: "未手动采样色罩，系统已自动尝试检测。若颜色仍异常，请切换到“无边框 / ES-2”并重试。",
        guideReferenceSuggestion: "如果自动检测不稳定，建议先把一张参考图设置为“整卷参考值”再转换。",
        rollReferenceTitle: "整卷参考",
        rollReferenceNone: "尚未设置整卷参考。",
        rollReferenceActive: "参考来源：{file}",
        setRollReference: "将当前图设为参考",
        applyRollReference: "应用参考到已选中",
        clearRollReference: "清除参考",
        lockRollReference: "新增文件自动套用参考",
        applyCropWithReference: "同时套用参考裁剪",
        rollReferenceSet: "已将当前图片设为整卷参考。",
        rollReferenceCleared: "已清除整卷参考。",
        rollReferenceApplied: "已将整卷参考应用到 {count} 张图片。",
        rollReferenceMissing: "尚未设置整卷参考。",
        rollReferenceAppliedCurrent: "已将整卷参考应用到当前图片。",
        applyConvert: "下一步：转换并进入调整",
        whiteBalance: "白平衡",
        wbInfo: "点击图像中应为中性灰的区域，或手动调整",
        sampleWB: "采样灰点",
        sectionColorModel: "色彩模型",
        coreColorModelLabel: "色彩模型",
        coreEnhancedProfile: "增强配置",
        coreProfileStrength: "配置强度",
        coreProfileNone: "无",
        coreProfileFrontier: "Frontier",
        coreProfileCrystal: "Crystal",
        coreProfileNatural: "Natural",
        coreProfilePakon: "Pakon",
        coreModelStandard: "标准",
        coreModelWarm: "暖调",
        coreModelMono: "单色",
        coreModelCineLog: "电影 Log",
        coreModelCineRich: "电影浓郁",
        coreModelCineFlat: "电影平坦",
        coreModelNoritsu: "Noritsu",
        coreModelNeutral: "中性",
        filmPresetLabel: "胶片预设",
        presetNone: "无（手动）",
        presetGroupColor: "彩色",
        presetGroupBW: "黑白",
        presetGroupPositive: "正片",
        corePreSaturation: "预饱和度",
        coreBorderBuffer: "边框缓冲 %",
        coreBrightness: "亮度",
        coreWhites: "白色色阶",
        coreBlacks: "黑色色阶",
        sectionColor: "颜色",
        coreWbModeLabel: "白平衡模式",
        wbAutoLinearFixed: "自动（线性固定）",
        wbLinearDynamic: "线性动态",
        wbShadowWeighted: "阴影加权",
        wbHighlightWeighted: "高光加权",
        wbMidtoneWeighted: "中间调加权",
        sectionEffects: "效果",
        coreGlow: "辉光",
        coreFade: "褪色",
        sectionEngine: "引擎",
        sectionDustRemoval: "除尘",
        dustRemovalEnable: "启用除尘",
        dustStrength: "灵敏度",
        dustShowMask: "显示蒙版",
        dustBrushSize: "笔刷大小",
        dustBrushHint: "点击=智能 | Alt+点击=直接 | Shift+点击=擦除",
        dustClearMask: "清除蒙版",
        dustStatusIdle: "就绪",
        dustStatusProcessing: "处理中...",
        dustStatusDone: "检测到 {count} 个灰尘颗粒",
        dustStatusNone: "未检测到灰尘",
        coreCurvePrecision: "曲线精度",
        curvePrecisionAuto30: "自动（30 点）",
        curvePrecisionSmooth70: "平滑（70 点）",
        curvePrecisionPrecise128: "精细（128 点）",
        coreUseWebGL: "WebGL 加速",
        cyan: "青色",
        magenta: "洋红",
        yellow: "黄色",
        toneAdjustments: "色调调整",
        exposure: "曝光",
        contrast: "对比度",
        highlights: "高光",
        shadows: "阴影",
        colorBalance: "色彩平衡",
        temperature: "色温",
        tint: "色调",
        vibrance: "活力",
        saturation: "饱和度",
        advanced: "高级",
        linear: "线性",
        sCurve: "S曲线",
        log: "对数",
        curveHint: "点击添加控制点，拖动调整，双击删除",
        resetCurve: "重置",
        reset: "重置调整",
        startOver: "重新开始",
        newImage: "选择新图片",
        undo: "撤销",
        redo: "重做",
        undone: "已撤销: {action}",
        redone: "已重做: {action}",
        nothingToUndo: "没有可撤销的操作",
        nothingToRedo: "没有可重做的操作",
        cancelledCrop: "已取消裁剪",
        cancelledSampling: "已退出取样模式",
        cancelledBrush: "已取消笔刷",
        exportPng: "导出 PNG",
        colorFilms: "彩色负片",
        bwFilms: "黑白负片",
        positiveFilms: "正片",
        processing: "处理中...",
        currentFile: "当前文件",
        selectFolder: "选择文件夹",
        folderPickerUnsupported: "当前浏览器不支持文件夹选择，请改用“选择文件”。",
        fileList: "文件列表",
        selectAll: "全选",
        selectNone: "全不选",
        addFiles: "添加",
        clearList: "清空",
        batchProcess: "批量处理",
        batchProcessing: "批量处理中...",
        saveSettings: "保存设置",
        settingsSaved: "当前图片设置已保存。",
        applyToSelected: "应用到已选中",
        appliedToSelected: "已将当前设置应用到 {count} 张图片。",
        noSelectedFiles: "没有选中的图片可应用设置。",
        batchStep3Guide: "批处理第3步指南：\n1) 调整当前图片。\n2) 切换图片或导出时会自动保存。\n3) 也可手动点击“保存设置”。\n4) 如需整卷统一参数，可点“应用到已选中”。\n5) 最后点击“批量导出 (ZIP)”或“逐个下载全部”。",
        autoFrameAnalyzing: "正在自动识别边框...",
        autoFramePreviewTitle: "检测到可用边框，是否应用？",
        autoFramePreviewDetail: "将旋转 {angle}°，裁剪到 {width}×{height}，置信度 {confidence}",
        autoFrameLowConfidenceTitle: "检测到低置信度边框，是否仍按建议应用裁剪？",
        autoFrameNoReliableBorder: "未检测到可靠边框，请手动裁剪。",
        autoFrameCvLoadError: "OpenCV 加载失败，无法使用自动识别。",
        autoFrameBatchDone: "自动识别完成：成功 {success} 张，失败 {failed} 张。",
        autoFrameBatchDoneExtended: "自动识别完成：成功裁剪 {success} 张（其中低置信度 {lowApplied} 张），仅旋转 {rotated} 张，失败 {failed} 张。",
        autoFrameRotateOnlyApplied: "低置信度：已仅应用旋转 {angle}°。",
        autoFrameLowConfidenceApplied: "低置信度：已应用自动裁剪，请检查结果（置信度 {confidence}）。",
        autoFrameSettings: "自动边框设置",
        autoFrameEnabled: "启用自动边框识别",
        autoFrameAutoApplyHigh: "高置信度时自动应用",
        autoFrameFormatLabel: "胶片格式",
        autoFrameFormatAuto: "自动（135/120）",
        autoFrameFormat135: "优先 135",
        autoFrameFormat120: "优先 120",
        autoFrame120Formats: "120 子格式",
        autoFrameLowConfidenceBehavior: "低置信度处理",
        autoFrameSuggestOnly: "低置信度也尝试裁剪",
        autoFrameRotateOnly: "只应用旋转",
        autoFrameNoAction: "不执行操作",
        autoFrameDiagnostics: "检测详情：方法 {method} | 格式 {format} | 置信度 {confidence} | 应用 {mode}",
        autoFrameModeCrop: "裁剪",
        autoFrameModeRotateOnly: "仅旋转",
        autoFrameModeNone: "未应用",
        exportCurrent: "导出当前图片 (PNG)",
        exportZip: "批量导出 (ZIP)",
        exportIndividual: "逐个下载全部",
        pending: "等待处理",
        processingStatus: "处理中",
        done: "已完成",
        error: "错误",
        unsaved: "未保存",
        configured: "已配置",
        customSettings: "已设置",
        autoDetect: "自动检测色罩",
        finishProcessing: "请先完成当前图片的处理流程（到第3步）",
        exportFormat: "导出格式",
        exportBitDepth: "导出位深",
        jpegQuality: "JPEG 质量",
        exportJpeg: "导出 JPEG",
        exportTiff: "导出 TIFF",
        exportCurrentJpeg: "导出当前图片 (JPEG)",
        exportCurrentTiff: "导出当前图片 (TIFF)",
        exportZipJpeg: "批量导出 (ZIP/JPEG)",
        lensSectionTitle: "镜头矫正（可选）",
        lensEnable: "启用镜头矫正",
        lensSkipBtn: "跳过镜头矫正",
        lensStatusIdle: "镜头矫正是可选步骤，不选择也可继续。",
        lensStatusLoading: "正在初始化 Lensfun...",
        lensStatusReadyCdn: "Lensfun 已就绪（CDN 资源）。",
        lensStatusReadyLocal: "Lensfun 已就绪（本地回退资源）。",
        lensStatusSearchCount: "已找到 {count} 个候选镜头。",
        lensStatusNoResult: "未找到匹配镜头，你可以继续并跳过镜头矫正。",
        lensStatusNeedModel: "请先输入镜头型号再搜索。",
        lensStatusNeedProfile: "已启用镜头矫正，请先选择镜头 profile，或点击“跳过镜头矫正”。",
        lensStatusSelected: "已选择镜头：{lens}",
        lensStatusSkipped: "已跳过镜头矫正。",
        lensStatusApplied: "镜头矫正已应用。",
        lensStatusApplyFailed: "镜头矫正失败：{reason}。已自动跳过并继续转换。",
        lensStatusInitFailed: "Lensfun 初始化失败：{reason}。可继续转换但不做镜头矫正。",
        lensLensModel: "镜头型号",
        lensLensMaker: "镜头厂商",
        lensCameraModel: "机身型号",
        lensCameraMaker: "机身厂商",
        lensSearchBtn: "搜索镜头 Profile",
        lensUseSelectedBtn: "使用选中 Profile",
        lensResults: "搜索结果",
        lensNoResult: "尚未加载候选镜头",
        lensSelectedNone: "已选镜头：无",
        lensSelectedPrefix: "已选镜头：{lens}",
        lensScoreLabel: "评分",
        lensResultItemTemplate: "{lens} | {scoreLabel} {score} | {minFocal}-{maxFocal}mm",
        lensFocal: "焦距 (mm)",
        lensCrop: "裁切系数",
        lensAperture: "光圈 (f)",
        lensDistance: "对焦距离 (m)",
        lensStepMode: "映射精度",
        lensStepAuto: "自动",
        lensStepManual: "手动",
        bitDepthJpegLocked: "JPEG 仅支持 8-bit 导出。",
        zoomIn: "放大",
        zoomOut: "缩小",
        zoomReset: "重置缩放",
        loadingExporting: "导出中...",
        loadingProcessing: "处理图片中...",
        loadingEncoding: "编码中...",
        loadingBatchFile: "正在处理第 {current} / {total} 张",
        loadingBatchZip: "正在创建 ZIP 压缩包...",
        loadingAdjusting: "正在应用调整...",
        loadingConverting: "正在转换底片...",
        loadingComplete: "完成！",
        loadingCancelled: "已取消",
        loadingLoading: "加载中..."
      },
      en: {
        title: "Negative Converter",
        privacyBannerTitle: "Runs locally · No photo uploads",
        privacyBannerBody: "Your photos are processed in your browser. Our server never receives your images.",
        privacyBannerLink: "Privacy details",
        offlineDownloadLink: "Download offline app",
        privacyBannerToggleLabel: "Hide privacy notice",
        desktopUpdateTitle: "New version available",
        desktopUpdateBody: "Current version {current}, latest version {latest}.",
        desktopUpdateAction: "Download update",
        desktopUpdateLater: "Later",
        dropHint: "Drop image here or click to open",
        selectFile: "Select File",
        applyRotate: "Apply",
        mirror: "Mirror",
        crop: "Crop",
        applyCrop: "Apply Crop",
	        cancelCrop: "Cancel",
	        autoFrame: "Auto Frame",
	        autoFrameSelected: "Auto Frame Selected",
	        beforeAfter: "Before/After",
	        convert: "Next: Film Settings",
	        convertPositive: "Next: Positive Mode",
	        histogram: "Histogram",
	        histogramDragHint: "Drag to move",
	        loadError: "Error loading file",
	        rawUnsupported: "RAW decode is not supported in this Safari version. Update Safari (iOS 16.4+) or convert to TIFF/JPEG first.",
        workflow: "Workflow",
        stepCrop: "Crop image (remove non-film areas)",
        stepBase: "Set Film Mask Baseline (Beginner Friendly)",
        stepAdjust: "Adjust colors and export",
        step1: "Step 1: Crop",
        step2: "Step 2: Mask",
        step3: "Step 3: Adjust",
        step2ModeBorder: "Border Available",
        step2ModeNoBorder: "No Border / ES-2",
        filmSettings: "Film Settings",
        colorFilm: "Color",
        bwFilm: "B&W",
        positiveFilm: "Positive",
	        filmBaseInfo: "If you can see unexposed orange border, sample it manually. If border is cropped out (for example ES-2), use Auto Detect Mask or Roll Reference.",
	        positiveModeInfo: "Mask sampling is only for color negatives. For B&W negatives or positive slides, select the film type and go straight to “Next: Convert and Continue”.",
	        guideToggleOn: "Guide: On",
	        guideToggleOff: "Guide: Off",
        noviceGuideTitle: "Beginner Guide",
        noviceGuidePhaseStep1: "Step 1: Crop",
        noviceGuidePhaseStep2: "Step 2: Film Settings",
        noviceGuidePhaseStep3: "Step 3: Adjust & Export",
        noviceGuidePrimaryStep1: "Crop the frame to the effective film area first, then move on.",
        noviceGuidePrimaryStep2ColorBorder: "Color negative with border: manual mask sampling is the most stable start.",
        noviceGuidePrimaryStep2ColorNoBorder: "Color negative without border (ES-2): start with auto mask detection or roll reference.",
        noviceGuidePrimaryStep2Bw: "B&W negative: no mask sampling needed. Confirm film type and it will proceed to adjustment.",
        noviceGuidePrimaryStep2Positive: "Positive mode: no mask sampling needed. Click “Next: Convert and Continue”.",
        noviceGuidePrimaryStep3Single: "Fine-tune and export the current image.",
        noviceGuidePrimaryStep3Batch: "Finish batch workflow: unify settings and export in bulk.",
        noviceGuideChecklistStep1Crop: "Use Auto Frame first if available, then fine-tune crop manually.",
        noviceGuideChecklistStep1Next: "After crop, click “Next: Film Settings” or “Next: Positive Mode”.",
        noviceGuideChecklistStep2ColorBorderSample: "Click “Sample Mask Manually” and pick an unexposed orange edge.",
        noviceGuideChecklistStep2ColorBorderFallback: "If edge sampling is unreliable, use “Auto Detect Mask”.",
        noviceGuideChecklistStep2ColorNoBorderAuto: "Start with “Auto Detect Mask”.",
        noviceGuideChecklistStep2ColorNoBorderReference: "If you have a reference frame, “Use Roll Reference Value” is more stable.",
        noviceGuideChecklistStep2BwSelect: "Confirm Film Type is set to B&W.",
        noviceGuideChecklistStep2BwAuto: "The app will auto-convert and enter Step 3.",
        noviceGuideChecklistStep2PositiveConvert: "Click “Next: Convert and Continue” to enter Step 3.",
        noviceGuideChecklistStep3SampleGray: "If color is off, sample a gray point first, then fine-tune.",
        noviceGuideChecklistStep3Export: "Export from the footer when ready (single image or ZIP).",
        noviceGuideChecklistStep3BatchSave: "After tuning current image, click “Save Settings”.",
        noviceGuideChecklistStep3BatchApply: "Use “Apply to Selected” for roll-wide consistency.",
        noviceGuideChecklistStep3BatchExport: "Finish with “Export All (ZIP)” or “Download All Individually”.",
        noviceGuideStatusAutoToStep3: "After sampling or auto-detect, conversion proceeds to Step 3 automatically.",
        noviceGuideStatusAutoToStep3Ready: "Mask baseline is ready. The app will enter Step 3 automatically; manual convert is still available.",
        noviceGuideStatusManualConvert: "This mode does not auto-jump. Click the convert button to enter Step 3.",
        noviceGuideStatusStep3Collapsed: "Step 3 panels are collapsed by default for beginners. Expand only what you need.",
        noviceGuideWarningMaskUnset: "Mask baseline is not set yet. Converting now may cause color cast.",
        noviceGuideWarningReferenceMissing: "No roll reference is set. If auto-detect is unstable, set one reference frame first.",
	        quickGuide: "Quick Guide:\n• Color negative: Step 1 Crop → Next: Film Settings → (Step 2) set Mask (sample / auto-detect / roll reference) → Next: Convert and Continue → Step 3 Adjust & Export\n• B&W negative: Step 1 Crop → Next: Film Settings → set Film Type = B&W → Next: Convert and Continue (no mask)\n• Positive slide: Step 1 Crop → Next: Positive Mode → Next: Convert and Continue (no mask)\nBatch: Add multiple files → process one frame → Save Settings / Apply to Selected → Export All (ZIP) when ready.\nTip: The “Next” buttons only appear in Step 1. Check the badge to see your current step.",
	        sampleBase: "Sample Mask Manually",
	        autoDetect: "Auto Detect Mask",
	        useRollReference: "Use Roll Reference Value",
        step2FirstHint: "Tip: If you cannot find orange border area, switch to “No Border / ES-2”.",
        guideStep2Title: "First time here? Follow these 3 steps",
        guideStep2Intro: "Pick the mode that matches your scan setup, then do the steps below.",
        guideTermMaskHelp: "Film mask means the unexposed orange base area, usually near sprocket holes or frame edge.",
        guideBorderStep1: "Click “Sample Mask Manually”.",
        guideBorderStep2: "Click an unexposed orange edge area (avoid image content).",
        guideBorderStep3: "Click “Next: Convert and Continue”.",
        guideNoBorderStep1: "Click “Auto Detect Mask”.",
        guideNoBorderStep2: "If you already have a reference frame, click “Use Roll Reference Value”.",
        guideNoBorderStep3: "Click “Next: Convert and Continue”.",
        guideTipMismatch: "If colors look strange, you probably sampled picture content. Re-sample or switch to “No Border / ES-2”.",
        guideTipFallback: "No reference yet is fine. Start with “Auto Detect Mask”, then fine tune if needed.",
        guideTipReady: "Mask baseline is ready. You can continue to conversion.",
        guideTipReferenceReady: "When border is missing, roll reference is usually the most stable choice.",
        guideAutoDetectFallback: "Mask was not sampled manually, so auto-detect was applied. If colors still look off, switch to “No Border / ES-2” and try again.",
        guideReferenceSuggestion: "If auto-detect is unstable, set one frame as roll reference first, then convert.",
        rollReferenceTitle: "Roll Reference",
        rollReferenceNone: "No roll reference set.",
        rollReferenceActive: "Reference source: {file}",
        setRollReference: "Set Current as Reference",
        applyRollReference: "Apply Reference to Selected",
        clearRollReference: "Clear Reference",
        lockRollReference: "Lock reference for newly added files",
        applyCropWithReference: "Also apply crop from reference",
        rollReferenceSet: "Current image has been set as the roll reference.",
        rollReferenceCleared: "Roll reference cleared.",
        rollReferenceApplied: "Applied roll reference to {count} image(s).",
        rollReferenceMissing: "No roll reference is set.",
        rollReferenceAppliedCurrent: "Roll reference applied to current image.",
        applyConvert: "Next: Convert and Continue",
        whiteBalance: "White Balance",
        wbInfo: "Click on a neutral gray area in the image, or adjust manually",
        sampleWB: "Sample Gray Point",
        sectionColorModel: "Color Model",
        coreColorModelLabel: "Color Model",
        coreEnhancedProfile: "Enhanced Profile",
        coreProfileStrength: "Profile Strength",
        coreProfileNone: "None",
        coreProfileFrontier: "Frontier",
        coreProfileCrystal: "Crystal",
        coreProfileNatural: "Natural",
        coreProfilePakon: "Pakon",
        coreModelStandard: "Standard",
        coreModelWarm: "Warm",
        coreModelMono: "Mono",
        coreModelCineLog: "Cine Log",
        coreModelCineRich: "Cine Rich",
        coreModelCineFlat: "Cine Flat",
        coreModelNoritsu: "Noritsu",
        coreModelNeutral: "Neutral",
        filmPresetLabel: "Film Preset",
        presetNone: "None (Manual)",
        presetGroupColor: "Color",
        presetGroupBW: "B&W",
        presetGroupPositive: "Positive",
        corePreSaturation: "Pre-Saturation",
        coreBorderBuffer: "Border Buffer %",
        coreBrightness: "Brightness",
        coreWhites: "Whites",
        coreBlacks: "Blacks",
        sectionColor: "Color",
        coreWbModeLabel: "White Balance Mode",
        wbAutoLinearFixed: "Auto (Linear Fixed)",
        wbLinearDynamic: "Linear Dynamic",
        wbShadowWeighted: "Shadow Weighted",
        wbHighlightWeighted: "Highlight Weighted",
        wbMidtoneWeighted: "Midtone Weighted",
        sectionEffects: "Effects",
        coreGlow: "Glow",
        coreFade: "Fade",
        sectionEngine: "Engine",
        sectionDustRemoval: "Dust Removal",
        dustRemovalEnable: "Enable Dust Removal",
        dustStrength: "Sensitivity",
        dustShowMask: "Show Mask",
        dustBrushSize: "Brush Size",
        dustBrushHint: "Click = Smart | Alt+Click = Direct | Shift+Click = Erase",
        dustClearMask: "Clear Mask",
        dustStatusIdle: "Ready",
        dustStatusProcessing: "Processing...",
        dustStatusDone: "Detected {count} dust particles",
        dustStatusNone: "No dust detected",
        coreCurvePrecision: "Curve Precision",
        curvePrecisionAuto30: "Auto (30 points)",
        curvePrecisionSmooth70: "Smooth (70 points)",
        curvePrecisionPrecise128: "Precise (128 points)",
        coreUseWebGL: "WebGL Acceleration",
        cyan: "Cyan",
        magenta: "Magenta",
        yellow: "Yellow",
        toneAdjustments: "Tone",
        exposure: "Exposure",
        contrast: "Contrast",
        highlights: "Highlights",
        shadows: "Shadows",
        colorBalance: "Color Balance",
        temperature: "Temperature",
        tint: "Tint",
        vibrance: "Vibrance",
        saturation: "Saturation",
        advanced: "Advanced",
        linear: "Linear",
        sCurve: "S-Curve",
        log: "Log",
        curveHint: "Click to add point, drag to adjust, double-click to remove",
        resetCurve: "Reset",
        reset: "Reset Adjustments",
        startOver: "Start Over",
        newImage: "New Image",
        undo: "Undo",
        redo: "Redo",
        undone: "Undone: {action}",
        redone: "Redone: {action}",
        nothingToUndo: "Nothing to undo",
        nothingToRedo: "Nothing to redo",
        cancelledCrop: "Crop cancelled",
        cancelledSampling: "Exited sampling mode",
        cancelledBrush: "Brush cancelled",
        exportPng: "Export PNG",
        colorFilms: "Color Films",
        bwFilms: "B&W Films",
        positiveFilms: "Positive Slides",
        processing: "Processing...",
        currentFile: "Current File",
        selectFolder: "Select Folder",
        folderPickerUnsupported: "Folder selection is not supported in this browser. Please use Select File.",
        fileList: "File List",
        selectAll: "All",
        selectNone: "None",
        addFiles: "Add",
        clearList: "Clear",
        batchProcess: "Batch Process",
        batchProcessing: "Batch Processing...",
        saveSettings: "Save Settings",
        settingsSaved: "Settings saved for current image.",
        applyToSelected: "Apply to Selected",
        appliedToSelected: "Applied current settings to {count} image(s).",
        noSelectedFiles: "No selected images to apply settings.",
        batchStep3Guide: "Batch Step 3 Guide:\n1) Adjust the current image.\n2) Settings auto-save when switching files or exporting.\n3) You can still click \"Save Settings\" manually.\n4) Use \"Apply to Selected\" for roll-wide baseline settings.\n5) When finished, use \"Export All (ZIP)\" or \"Download All Individually\".",
        autoFrameAnalyzing: "Analyzing frame borders...",
        autoFramePreviewTitle: "Reliable frame detected. Apply auto rotation and crop?",
        autoFramePreviewDetail: "Rotate {angle}°, crop to {width}×{height}, confidence {confidence}",
        autoFrameLowConfidenceTitle: "Low-confidence frame detected. Apply suggested crop anyway?",
        autoFrameNoReliableBorder: "No reliable frame border detected. Please crop manually.",
        autoFrameCvLoadError: "OpenCV failed to load. Auto frame is unavailable.",
        autoFrameBatchDone: "Auto frame finished: {success} succeeded, {failed} failed.",
        autoFrameBatchDoneExtended: "Auto frame finished: {success} crop success ({lowApplied} low-confidence), {rotated} rotation-only, {failed} failed.",
        autoFrameRotateOnlyApplied: "Low confidence: applied rotation only ({angle}°).",
        autoFrameLowConfidenceApplied: "Low confidence: crop applied. Please verify the result (confidence {confidence}).",
        autoFrameSettings: "Auto Frame Settings",
        autoFrameEnabled: "Enable Auto Frame",
        autoFrameAutoApplyHigh: "Auto-apply high confidence",
        autoFrameFormatLabel: "Film Format",
        autoFrameFormatAuto: "Auto (135/120)",
        autoFrameFormat135: "Prefer 135",
        autoFrameFormat120: "Prefer 120",
        autoFrame120Formats: "120 sub-formats",
        autoFrameLowConfidenceBehavior: "Low confidence",
        autoFrameSuggestOnly: "Try crop on low confidence",
        autoFrameRotateOnly: "Rotate only",
        autoFrameNoAction: "Do nothing",
        autoFrameDiagnostics: "Detection: method {method} | format {format} | confidence {confidence} | applied {mode}",
        autoFrameModeCrop: "Crop",
        autoFrameModeRotateOnly: "Rotate only",
        autoFrameModeNone: "None",
        exportCurrent: "Export Current (PNG)",
        exportZip: "Export All (ZIP)",
        exportIndividual: "Download All Individually",
        pending: "Pending",
        processingStatus: "Processing",
        done: "Done",
        error: "Error",
        unsaved: "Unsaved",
        configured: "configured",
        customSettings: "Custom",
        autoDetect: "Auto Detect Mask",
        finishProcessing: "Please complete the workflow (step 3) before saving settings",
        exportFormat: "Export Format",
        exportBitDepth: "Bit Depth",
        jpegQuality: "JPEG Quality",
        exportJpeg: "Export JPEG",
        exportTiff: "Export TIFF",
        exportCurrentJpeg: "Export Current (JPEG)",
        exportCurrentTiff: "Export Current (TIFF)",
        exportZipJpeg: "Export All (ZIP/JPEG)",
        lensSectionTitle: "Lens Correction (Optional)",
        lensEnable: "Enable Lens Correction",
        lensSkipBtn: "Skip Lens Correction",
        lensStatusIdle: "Lens correction is optional. You can continue without selecting a profile.",
        lensStatusLoading: "Initializing Lensfun...",
        lensStatusReadyCdn: "Lensfun ready (CDN assets).",
        lensStatusReadyLocal: "Lensfun ready (local fallback assets).",
        lensStatusSearchCount: "Found {count} lens profile candidates.",
        lensStatusNoResult: "No matching lens profile found. You can continue and skip lens correction.",
        lensStatusNeedModel: "Enter a lens model before searching.",
        lensStatusNeedProfile: "Lens correction is enabled. Select a lens profile or click skip.",
        lensStatusSelected: "Selected lens: {lens}",
        lensStatusSkipped: "Lens correction skipped.",
        lensStatusApplied: "Lens correction applied.",
        lensStatusApplyFailed: "Lens correction failed: {reason}. Continuing without lens correction.",
        lensStatusInitFailed: "Lensfun initialization failed: {reason}. Continuing without lens correction.",
        lensLensModel: "Lens Model",
        lensLensMaker: "Lens Maker",
        lensCameraModel: "Camera Model",
        lensCameraMaker: "Camera Maker",
        lensSearchBtn: "Search Profiles",
        lensUseSelectedBtn: "Use Selected Profile",
        lensResults: "Search Results",
        lensNoResult: "No profiles loaded yet",
        lensSelectedNone: "Selected profile: none",
        lensSelectedPrefix: "Selected profile: {lens}",
        lensScoreLabel: "score",
        lensResultItemTemplate: "{lens} | {scoreLabel} {score} | {minFocal}-{maxFocal}mm",
        lensFocal: "Focal (mm)",
        lensCrop: "Crop Factor",
        lensAperture: "Aperture (f)",
        lensDistance: "Distance (m)",
        lensStepMode: "Map Detail",
        lensStepAuto: "Auto",
        lensStepManual: "Manual",
        bitDepthJpegLocked: "JPEG export is limited to 8-bit.",
        zoomIn: "Zoom In",
        zoomOut: "Zoom Out",
        zoomReset: "Reset Zoom",
        loadingExporting: "Exporting...",
        loadingProcessing: "Processing image...",
        loadingEncoding: "Encoding...",
        loadingBatchFile: "Processing file {current} of {total}",
        loadingBatchZip: "Creating ZIP archive...",
        loadingAdjusting: "Applying adjustments...",
        loadingConverting: "Converting negative...",
        loadingComplete: "Complete!",
        loadingCancelled: "Cancelled",
        loadingLoading: "Loading..."
      },
      ja: {
        title: "ネガポジ変換",
        privacyBannerTitle: "ローカル処理 · 写真はアップロードしません",
        privacyBannerBody: "写真はブラウザ内で処理され、サーバーに送信されません。",
        privacyBannerLink: "プライバシー詳細",
        offlineDownloadLink: "オフライン版をダウンロード",
        privacyBannerToggleLabel: "プライバシー通知を非表示",
        desktopUpdateTitle: "新しいバージョンがあります",
        desktopUpdateBody: "現在のバージョン {current}、最新バージョン {latest}。",
        desktopUpdateAction: "ダウンロードページへ",
        desktopUpdateLater: "後で",
        dropHint: "画像をドロップまたはクリックして読み込み",
        selectFile: "ファイル選択",
        applyRotate: "適用",
        mirror: "ミラー",
        crop: "トリミング",
        applyCrop: "適用",
	        cancelCrop: "キャンセル",
	        autoFrame: "自動フレーム検出",
	        autoFrameSelected: "選択画像を自動検出",
	        beforeAfter: "ビフォー/アフター",
	        convert: "次へ：フィルム設定",
	        convertPositive: "次へ：ポジモード",
	        histogram: "ヒストグラム",
	        histogramDragHint: "ドラッグで移動",
	        loadError: "ファイルの読み込みに失敗しました",
	        rawUnsupported: "この Safari バージョンでは RAW デコードに対応していません。Safari（iOS 16.4+ 推奨）へ更新するか、先に TIFF/JPEG に変換してください。",
        workflow: "ワークフロー",
        stepCrop: "画像をトリミング（フィルム外を除去）",
        stepBase: "マスク基準を設定（初回でも簡単）",
        stepAdjust: "色調整とエクスポート",
        step1: "ステップ1：トリミング",
        step2: "ステップ2：マスク",
        step3: "ステップ3：調整",
        step2ModeBorder: "端あり",
        step2ModeNoBorder: "端なし / ES-2",
        filmSettings: "フィルム設定",
        colorFilm: "カラー",
        bwFilm: "白黒",
        positiveFilm: "ポジ",
	        filmBaseInfo: "未露光のオレンジ端が見える場合は手動サンプリング。端がない（ES-2 など）場合は「マスク自動検出」または「ロール参照値」を使ってください。",
	        positiveModeInfo: "マスクサンプリングが必要なのはカラー・ネガのみです。白黒ネガ／ポジはマスク不要：種類を選んで「次へ：変換して調整へ」を押してください。",
	        guideToggleOn: "ガイド：ON",
	        guideToggleOff: "ガイド：OFF",
        noviceGuideTitle: "初心者ガイド",
        noviceGuidePhaseStep1: "ステップ1：トリミング",
        noviceGuidePhaseStep2: "ステップ2：フィルム設定",
        noviceGuidePhaseStep3: "ステップ3：調整と書き出し",
        noviceGuidePrimaryStep1: "まず有効なフィルム領域までトリミングしてから次へ進みます。",
        noviceGuidePrimaryStep2ColorBorder: "カラーネガ（端あり）：まず手動でマスクをサンプリングすると安定します。",
        noviceGuidePrimaryStep2ColorNoBorder: "カラーネガ（端なし / ES-2）：自動検出またはロール参照値から開始します。",
        noviceGuidePrimaryStep2Bw: "白黒ネガ：マスクサンプリングは不要です。種類を確認すると自動で調整へ進みます。",
        noviceGuidePrimaryStep2Positive: "ポジ：マスクサンプリングは不要です。「次へ：変換して調整へ」を押してください。",
        noviceGuidePrimaryStep3Single: "現在の画像を微調整して書き出します。",
        noviceGuidePrimaryStep3Batch: "一括処理の仕上げです。設定を揃えてまとめて書き出します。",
        noviceGuideChecklistStep1Crop: "必要なら先に自動フレーム検出を使い、最後に手動で微調整します。",
        noviceGuideChecklistStep1Next: "トリミング後に「次へ：フィルム設定」または「次へ：ポジモード」を押します。",
        noviceGuideChecklistStep2ColorBorderSample: "「マスクを手動サンプリング」で未露光のオレンジ端をクリックします。",
        noviceGuideChecklistStep2ColorBorderFallback: "端の取得が難しい場合は「マスク自動検出」を使います。",
        noviceGuideChecklistStep2ColorNoBorderAuto: "まず「マスク自動検出」を実行します。",
        noviceGuideChecklistStep2ColorNoBorderReference: "参照コマがある場合は「ロール参照値を使用」の方が安定します。",
        noviceGuideChecklistStep2BwSelect: "フィルム種類が「白黒」になっているか確認します。",
        noviceGuideChecklistStep2BwAuto: "そのまま自動でステップ3に進みます。",
        noviceGuideChecklistStep2PositiveConvert: "「次へ：変換して調整へ」を押してステップ3へ進みます。",
        noviceGuideChecklistStep3SampleGray: "色がずれる場合は先にグレーポイントをサンプリングします。",
        noviceGuideChecklistStep3Export: "調整後、フッターから書き出します（単体または ZIP）。",
        noviceGuideChecklistStep3BatchSave: "現在画像の調整後に「設定を保存」を押します。",
        noviceGuideChecklistStep3BatchApply: "ロール全体に揃える場合は「選択中に適用」を使います。",
        noviceGuideChecklistStep3BatchExport: "最後に「一括出力 (ZIP)」または個別ダウンロードを実行します。",
        noviceGuideStatusAutoToStep3: "サンプリングまたは自動検出が完了すると、自動でステップ3へ進みます。",
        noviceGuideStatusAutoToStep3Ready: "マスク基準が準備できました。自動でステップ3へ進みます（手動変換も可能です）。",
        noviceGuideStatusManualConvert: "このモードは自動遷移しません。変換ボタンを押してステップ3へ進んでください。",
        noviceGuideStatusStep3Collapsed: "初心者向けにステップ3の各パネルは初回のみ折りたたまれます。必要な項目だけ展開してください。",
        noviceGuideWarningMaskUnset: "マスク基準が未設定です。このまま変換すると色かぶりの可能性があります。",
        noviceGuideWarningReferenceMissing: "ロール参照値が未設定です。自動検出が不安定な場合は先に参照コマを設定してください。",
	        quickGuide: "クイックガイド：\n• カラーネガ：ステップ1 トリミング → 次へ：フィルム設定 →（ステップ2）マスク設定（手動/自動/ロール参照）→ 次へ：変換して調整へ → ステップ3 調整・書き出し\n• 白黒ネガ：ステップ1 → 次へ：フィルム設定 → 種類を「白黒」に → 次へ：変換して調整へ（マスク不要）\n• ポジ：ステップ1 → 次へ：ポジモード → 次へ：変換して調整へ（マスク不要）\n一括：複数追加 → 1枚を基準に調整 →「設定を保存/選択中に適用」→ 最後に ZIP 書き出し。\nヒント：「次へ」ボタンはステップ1でのみ表示。左上のバッジで現在のステップを確認。",
	        sampleBase: "マスクを手動サンプリング",
	        autoDetect: "マスク自動検出",
	        useRollReference: "ロール参照値を使用",
        step2FirstHint: "ヒント：オレンジ端が見つからない場合は「端なし / ES-2」に切り替えてください。",
        guideStep2Title: "初めての方へ：この 3 ステップでOK",
        guideStep2Intro: "まずスキャン方法に合うモードを選び、次の手順を実行してください。",
        guideTermMaskHelp: "マスクとは、未露光のオレンジ色のベース部分（パーフォレーション付近やコマ端）です。",
        guideBorderStep1: "「マスクを手動サンプリング」をクリック。",
        guideBorderStep2: "画像内容ではなく、未露光のオレンジ端をクリック。",
        guideBorderStep3: "「次へ：変換して調整へ」をクリック。",
        guideNoBorderStep1: "「マスク自動検出」をクリック。",
        guideNoBorderStep2: "参照コマがある場合は「ロール参照値を使用」をクリック。",
        guideNoBorderStep3: "「次へ：変換して調整へ」をクリック。",
        guideTipMismatch: "色が不自然な場合は、画像部分をサンプリングした可能性があります。再サンプリングするか「端なし / ES-2」に切り替えてください。",
        guideTipFallback: "参照値がなくても大丈夫です。まず「マスク自動検出」を使い、必要なら後で微調整してください。",
        guideTipReady: "マスク基準の設定が完了しました。次へ進めます。",
        guideTipReferenceReady: "端がない場合は「ロール参照値」を使うと安定しやすいです。",
        guideAutoDetectFallback: "手動サンプリングが未実施のため、自動検出を適用しました。色がおかしい場合は「端なし / ES-2」に切り替えて再試行してください。",
        guideReferenceSuggestion: "自動検出が不安定な場合は、先に1枚をロール参照値として設定してから変換してください。",
        rollReferenceTitle: "ロール参照",
        rollReferenceNone: "ロール参照は未設定です。",
        rollReferenceActive: "参照元: {file}",
        setRollReference: "現在画像を参照に設定",
        applyRollReference: "参照を選択画像へ適用",
        clearRollReference: "参照をクリア",
        lockRollReference: "追加ファイルへ参照を自動適用",
        applyCropWithReference: "参照のトリミングも適用",
        rollReferenceSet: "現在の画像をロール参照に設定しました。",
        rollReferenceCleared: "ロール参照をクリアしました。",
        rollReferenceApplied: "ロール参照を {count} 枚に適用しました。",
        rollReferenceMissing: "ロール参照が設定されていません。",
        rollReferenceAppliedCurrent: "ロール参照を現在の画像に適用しました。",
        applyConvert: "次へ：変換して調整へ",
        whiteBalance: "ホワイトバランス",
        wbInfo: "画像内のニュートラルグレー部分をクリック、または手動調整",
        sampleWB: "グレーポイントを取得",
        sectionColorModel: "カラーモデル",
        coreColorModelLabel: "カラーモデル",
        coreEnhancedProfile: "拡張プロファイル",
        coreProfileStrength: "プロファイル強度",
        coreProfileNone: "なし",
        coreProfileFrontier: "Frontier",
        coreProfileCrystal: "Crystal",
        coreProfileNatural: "Natural",
        coreProfilePakon: "Pakon",
        coreModelStandard: "標準",
        coreModelWarm: "ウォーム",
        coreModelMono: "モノクロ",
        coreModelCineLog: "シネログ",
        coreModelCineRich: "シネリッチ",
        coreModelCineFlat: "シネフラット",
        coreModelNoritsu: "Noritsu",
        coreModelNeutral: "ニュートラル",
        filmPresetLabel: "フィルムプリセット",
        presetNone: "なし（手動）",
        presetGroupColor: "カラー",
        presetGroupBW: "白黒",
        presetGroupPositive: "ポジ",
        corePreSaturation: "事前彩度",
        coreBorderBuffer: "境界バッファ %",
        coreBrightness: "明るさ",
        coreWhites: "ホワイト",
        coreBlacks: "ブラック",
        sectionColor: "カラー",
        coreWbModeLabel: "ホワイトバランスモード",
        wbAutoLinearFixed: "自動（線形固定）",
        wbLinearDynamic: "線形ダイナミック",
        wbShadowWeighted: "シャドウ重み付け",
        wbHighlightWeighted: "ハイライト重み付け",
        wbMidtoneWeighted: "中間調重み付け",
        sectionEffects: "エフェクト",
        coreGlow: "グロー",
        coreFade: "フェード",
        sectionEngine: "エンジン",
        sectionDustRemoval: "ダスト除去",
        dustRemovalEnable: "ダスト除去を有効にする",
        dustStrength: "感度",
        dustShowMask: "マスク表示",
        dustBrushSize: "ブラシサイズ",
        dustBrushHint: "クリック=スマート | Alt+クリック=直接 | Shift+クリック=消去",
        dustClearMask: "マスクをクリア",
        dustStatusIdle: "準備完了",
        dustStatusProcessing: "処理中...",
        dustStatusDone: "{count} 個のダスト粒子を検出",
        dustStatusNone: "ダストは検出されませんでした",
        coreCurvePrecision: "カーブ精度",
        curvePrecisionAuto30: "自動（30ポイント）",
        curvePrecisionSmooth70: "スムーズ（70ポイント）",
        curvePrecisionPrecise128: "高精度（128ポイント）",
        coreUseWebGL: "WebGL 加速",
        cyan: "シアン",
        magenta: "マゼンタ",
        yellow: "イエロー",
        toneAdjustments: "トーン調整",
        exposure: "露出",
        contrast: "コントラスト",
        highlights: "ハイライト",
        shadows: "シャドウ",
        colorBalance: "カラーバランス",
        temperature: "色温度",
        tint: "色合い",
        vibrance: "バイブランス",
        saturation: "彩度",
        advanced: "詳細",
        linear: "リニア",
        sCurve: "Sカーブ",
        log: "ログ",
        curveHint: "クリックでポイント追加、ドラッグで調整、ダブルクリックで削除",
        resetCurve: "リセット",
        reset: "調整をリセット",
        startOver: "最初から",
        newImage: "新しい画像",
        undo: "元に戻す",
        redo: "やり直し",
        undone: "取り消し: {action}",
        redone: "やり直し: {action}",
        nothingToUndo: "元に戻す操作はありません",
        nothingToRedo: "やり直す操作はありません",
        cancelledCrop: "トリミングをキャンセル",
        cancelledSampling: "サンプリングモードを終了",
        cancelledBrush: "ブラシをキャンセル",
        exportPng: "PNG出力",
        colorFilms: "カラーフィルム",
        bwFilms: "白黒フィルム",
        positiveFilms: "ポジフィルム",
        processing: "処理中...",
        currentFile: "現在のファイル",
        selectFolder: "フォルダ選択",
        folderPickerUnsupported: "このブラウザはフォルダ選択に対応していません。ファイル選択を使用してください。",
        fileList: "ファイル一覧",
        selectAll: "全選択",
        selectNone: "全解除",
        addFiles: "追加",
        clearList: "クリア",
        batchProcess: "一括処理",
        batchProcessing: "一括処理中...",
        saveSettings: "設定を保存",
        settingsSaved: "現在の画像の設定を保存しました。",
        applyToSelected: "選択中に適用",
        appliedToSelected: "現在の設定を {count} 枚に適用しました。",
        noSelectedFiles: "設定を適用できる選択画像がありません。",
        batchStep3Guide: "一括処理ステップ3ガイド：\n1) 現在の画像を調整します。\n2) 画像切替または書き出し時に自動保存されます。\n3) 必要なら「設定を保存」も使えます。\n4) ロール全体に適用する場合は「選択中に適用」を使います。\n5) 最後に「一括出力 (ZIP)」または「すべて個別にダウンロード」を実行します。",
        autoFrameAnalyzing: "フレーム境界を解析中...",
        autoFramePreviewTitle: "信頼できるフレームを検出しました。自動回転とトリミングを適用しますか？",
        autoFramePreviewDetail: "{angle}°回転、{width}×{height} にトリミング、信頼度 {confidence}",
        autoFrameLowConfidenceTitle: "低信頼度のフレーム候補です。提案どおり適用しますか？",
        autoFrameNoReliableBorder: "信頼できるフレーム境界を検出できませんでした。手動でトリミングしてください。",
        autoFrameCvLoadError: "OpenCV の読み込みに失敗したため、自動検出は利用できません。",
        autoFrameBatchDone: "自動検出が完了しました: 成功 {success} 枚、失敗 {failed} 枚。",
        autoFrameBatchDoneExtended: "自動検出が完了しました: トリミング成功 {success} 枚（低信頼度 {lowApplied} 枚を含む）、回転のみ {rotated} 枚、失敗 {failed} 枚。",
        autoFrameRotateOnlyApplied: "低信頼度のため回転のみを適用しました（{angle}°）。",
        autoFrameLowConfidenceApplied: "低信頼度でしたがトリミングを適用しました（信頼度 {confidence}）。結果を確認してください。",
        autoFrameSettings: "自動フレーム設定",
        autoFrameEnabled: "自動フレーム検出を有効化",
        autoFrameAutoApplyHigh: "高信頼度は自動適用",
        autoFrameFormatLabel: "フィルム形式",
        autoFrameFormatAuto: "自動（135/120）",
        autoFrameFormat135: "135 を優先",
        autoFrameFormat120: "120 を優先",
        autoFrame120Formats: "120 サブ形式",
        autoFrameLowConfidenceBehavior: "低信頼度時の動作",
        autoFrameSuggestOnly: "低信頼度でもトリミングを試す",
        autoFrameRotateOnly: "回転のみ適用",
        autoFrameNoAction: "何もしない",
        autoFrameDiagnostics: "検出情報: 手法 {method} | 形式 {format} | 信頼度 {confidence} | 適用 {mode}",
        autoFrameModeCrop: "トリミング",
        autoFrameModeRotateOnly: "回転のみ",
        autoFrameModeNone: "未適用",
        exportCurrent: "現在の画像を出力 (PNG)",
        exportZip: "一括出力 (ZIP)",
        exportIndividual: "すべて個別にダウンロード",
        pending: "待機中",
        processingStatus: "処理中",
        done: "完了",
        error: "エラー",
        unsaved: "未保存",
        configured: "設定済",
        customSettings: "設定済",
        autoDetect: "マスク自動検出",
        finishProcessing: "設定を保存する前にワークフロー（ステップ3）を完了してください",
        exportFormat: "出力形式",
        exportBitDepth: "出力ビット深度",
        jpegQuality: "JPEG品質",
        exportJpeg: "JPEG出力",
        exportTiff: "TIFF出力",
        exportCurrentJpeg: "現在の画像を出力 (JPEG)",
        exportCurrentTiff: "現在の画像を出力 (TIFF)",
        exportZipJpeg: "一括出力 (ZIP/JPEG)",
        lensSectionTitle: "レンズ補正（任意）",
        lensEnable: "レンズ補正を有効化",
        lensSkipBtn: "レンズ補正をスキップ",
        lensStatusIdle: "レンズ補正は任意です。選択しなくても続行できます。",
        lensStatusLoading: "Lensfun を初期化中...",
        lensStatusReadyCdn: "Lensfun 準備完了（CDN）。",
        lensStatusReadyLocal: "Lensfun 準備完了（ローカルフォールバック）。",
        lensStatusSearchCount: "{count} 件の候補レンズが見つかりました。",
        lensStatusNoResult: "一致するレンズが見つかりません。スキップして続行できます。",
        lensStatusNeedModel: "検索前にレンズ名を入力してください。",
        lensStatusNeedProfile: "レンズ補正が有効です。プロファイルを選択するかスキップしてください。",
        lensStatusSelected: "選択中レンズ: {lens}",
        lensStatusSkipped: "レンズ補正をスキップしました。",
        lensStatusApplied: "レンズ補正を適用しました。",
        lensStatusApplyFailed: "レンズ補正に失敗: {reason}。補正なしで続行します。",
        lensStatusInitFailed: "Lensfun 初期化失敗: {reason}。補正なしで続行します。",
        lensLensModel: "レンズ名",
        lensLensMaker: "レンズメーカー",
        lensCameraModel: "カメラ機種",
        lensCameraMaker: "カメラメーカー",
        lensSearchBtn: "プロファイル検索",
        lensUseSelectedBtn: "選択したプロファイルを使用",
        lensResults: "検索結果",
        lensNoResult: "候補レンズはまだありません",
        lensSelectedNone: "選択中プロファイル: なし",
        lensSelectedPrefix: "選択中プロファイル: {lens}",
        lensScoreLabel: "スコア",
        lensResultItemTemplate: "{lens} | {scoreLabel} {score} | {minFocal}-{maxFocal}mm",
        lensFocal: "焦点距離 (mm)",
        lensCrop: "クロップ係数",
        lensAperture: "絞り (f)",
        lensDistance: "撮影距離 (m)",
        lensStepMode: "マップ精度",
        lensStepAuto: "自動",
        lensStepManual: "手動",
        bitDepthJpegLocked: "JPEG は 8-bit 出力のみ対応です。",
        zoomIn: "拡大",
        zoomOut: "縮小",
        zoomReset: "ズームリセット",
        loadingExporting: "書き出し中...",
        loadingProcessing: "画像処理中...",
        loadingEncoding: "エンコード中...",
        loadingBatchFile: "{total}枚中{current}枚目を処理中",
        loadingBatchZip: "ZIPアーカイブを作成中...",
        loadingAdjusting: "調整を適用中...",
        loadingConverting: "ネガ変換中...",
        loadingComplete: "完了！",
        loadingCancelled: "キャンセル",
        loadingLoading: "読み込み中..."
      }
    };

    const DEBUG_UI = new URLSearchParams(window.location.search).get('debug') === '1';
    const BUILD_ID = '2026-02-22-auto-frame-detect-4';
    const OPENCV_SCRIPT_CANDIDATES = [opencvScriptUrl];
    const AUTO_FRAME_MAX_SIDE = 1600;
    const AUTO_FRAME_FORMAT_RATIOS = {
      '135': 1.5,
      '120-6x4.5': 1.33,
      '120-6x6': 1.0,
      '120-6x7': 1.17,
      '120-6x9': 1.5
    };
    const AUTO_FRAME_DEFAULT_120_FORMATS = ['6x4.5', '6x6', '6x7', '6x9'];
    const AUTO_FRAME_SCORE_WEIGHTS = {
      area: 0.18,
      rectangularity: 0.20,
      orthogonality: 0.14,
      parallelism: 0.10,
      edgeSupport: 0.18,
      centerPrior: 0.08,
      aspect: 0.12
    };
    const CORE_ENHANCED_PROFILE_OPTIONS = new Set(['none', 'frontier', 'crystal', 'natural', 'pakon']);
    const CORE_COLOR_MODEL_OPTIONS = new Set(['frontier', 'standard', 'warm', 'mono', 'noritsu', 'cine-log', 'cine-rich', 'cine-flat', 'neutral']);
    const CORE_COLOR_MODEL_MIGRATION_MAP = Object.freeze({});
    let opencvReadyPromise = null;
    let opencvActiveSource = null;
    const STEP3_GUIDE_COLLAPSED_SESSION_KEY = 'nc_step3_guide_collapsed_v1';
    const PRIVACY_BANNER_COLLAPSED_STORAGE_KEY = 'nc_privacy_banner_collapsed_v1';
    const GUIDE_MODE_STORAGE_KEY = 'nc_guide_mode_enabled_v1';
    const HISTOGRAM_POSITION_STORAGE_KEY = 'nc_histogram_position_v1';
    const HISTOGRAM_DRAG_HINT_DISMISSED_STORAGE_KEY = 'nc_histogram_drag_hint_dismissed_v1';
    const DESKTOP_UPDATE_LAST_CHECK_TS_KEY = 'nc_desktop_update_last_check_ts';
    const DESKTOP_UPDATE_LAST_SEEN_LATEST_KEY = 'nc_desktop_update_last_seen_latest';
    const DESKTOP_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
    const DESKTOP_UPDATE_FETCH_TIMEOUT_MS = 5000;
    const DESKTOP_UPDATE_MANIFEST_URLS = [
      'https://download.neoanaloglab.com/negative-converter/release/latest.json',
      'https://negative-converter.tokugai.com/negative-converter/release/latest.json'
    ];
    const DESKTOP_UPDATE_PAGE_URL = 'https://negative-converter.tokugai.com/download.html';
    const LENSFUN_PACKAGE_VERSION = '0.1.3';
    const LENSFUN_CDN_BASE = `https://cdn.jsdelivr.net/npm/@neoanaloglabkk/lensfun-wasm@${LENSFUN_PACKAGE_VERSION}/dist`;
    const lensScriptLoadPromises = new Map();
    const lensMapCache = new Map();
    const lensfunRuntime = {
      initPromise: null,
      client: null,
      source: null,
      lastError: ''
    };

    let currentLang = 'en';
    let guideModeEnabled = true;
    let stateReady = false;
    let step3GuideCollapsedOnce = false;
    const desktopUpdateState = {
      visible: false,
      currentVersion: '',
      latestVersion: ''
    };

    function getLocalizedText(key, fallback = '') {
      const dict = i18n[currentLang] || i18n.en || {};
      if (Object.prototype.hasOwnProperty.call(dict, key) && dict[key]) {
        return dict[key];
      }
      return fallback;
    }

    function setLanguage(lang) {
      currentLang = lang;
      document.querySelectorAll('.lang-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.lang === lang);
      });
      document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.dataset.i18n;
        if (i18n[lang][key]) {
          el.textContent = i18n[lang][key];
        }
      });
      document.querySelectorAll('[data-i18n-label]').forEach(el => {
        const key = el.dataset.i18nLabel;
        if (i18n[lang][key]) {
          el.label = i18n[lang][key];
        }
      });
      document.title = getLocalizedText('title', document.title || 'Negative Converter');
      const privacyLink = document.getElementById('privacyDetailsLink');
      if (privacyLink) {
        privacyLink.href = `./privacy.html?lang=${encodeURIComponent(lang)}`;
      }
      const offlineLink = document.getElementById('offlineDownloadLink');
      if (offlineLink) {
        offlineLink.href = `./download.html?lang=${encodeURIComponent(lang)}`;
      }
      updateDesktopUpdateBannerText();
      updateGuideModeUI();
      if (stateReady) {
        updateCurrentFileLabel();
        updateRollReferenceUI();
        updateAutoFrameConfigUI();
        updateAutoFrameDiagnosticsUI();
        updateAutoFrameButtons();
        renderNoviceGuide({ applyStep3Collapse: false });
        if (typeof updateLensCorrectionUI === 'function') updateLensCorrectionUI();
        if (typeof updateExportUI === 'function') updateExportUI();
      }
    }

    // Detect language
    const browserLang = navigator.language.startsWith('ja') ? 'ja'
      : navigator.language.startsWith('zh') ? 'zh' : 'en';
    setLanguage(browserLang);

    if (DEBUG_UI) {
      const badge = document.getElementById('buildBadge');
      if (badge) {
        badge.style.display = 'inline-flex';
        badge.textContent = `build ${BUILD_ID}`;
      }
    }

    // Language selector
    document.querySelectorAll('.lang-btn').forEach(btn => {
      btn.addEventListener('click', () => setLanguage(btn.dataset.lang));
    });

    function safeStorageGet(key) {
      try {
        return localStorage.getItem(key);
      } catch (err) {
        return null;
      }
    }

	    function safeStorageSet(key, value) {
	      try {
	        localStorage.setItem(key, value);
	      } catch (err) {
	        // ignore
	      }
	    }

    function clearRecommendedActions() {
      [
        'autoFrameBtn',
        'cropBtn',
        'convertBtn',
        'convertPositiveBtn',
        'sampleBaseBtn',
        'autoDetectBtn',
        'useReferenceBtn',
        'applyConvertBtn',
        'sampleWBBtn',
        'saveSettingsBtn',
        'applyToSelectedBtn',
        'exportBtn'
      ].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.classList.remove('recommended-action');
      });
    }

    function setRecommendedActions(actionIds = []) {
      clearRecommendedActions();
      if (!guideModeEnabled || !Array.isArray(actionIds)) return;
      actionIds.forEach(id => {
        const btn = document.getElementById(id);
        if (!btn || btn.disabled) return;
        if (btn.style.display === 'none') return;
        btn.classList.add('recommended-action');
      });
    }

    function setSectionCollapsed(section, collapsed) {
      const header = document.querySelector(`.section-header[data-section="${section}"]`);
      const toggle = header ? header.querySelector('.section-toggle') : null;
      const content = document.getElementById(section + 'SectionContent')
        || document.getElementById(section + 'Section');
      if (toggle) toggle.classList.toggle('collapsed', Boolean(collapsed));
      if (content) content.classList.toggle('collapsed', Boolean(collapsed));
    }

    function collapseStep3SectionsForGuideIfNeeded() {
      if (!guideModeEnabled) return;
      if (state.currentStep < 3) return;
      if (step3GuideCollapsedOnce) return;
      ['conversion', 'tone', 'color', 'effects', 'engine'].forEach(section => {
        setSectionCollapsed(section, true);
      });
      step3GuideCollapsedOnce = true;
      try {
        sessionStorage.setItem(STEP3_GUIDE_COLLAPSED_SESSION_KEY, '1');
      } catch (err) {
        // ignore
      }
    }

    function updateGuideModeUI() {
      const toggleBtn = document.getElementById('guideToggleBtn');
      if (toggleBtn) {
        toggleBtn.setAttribute('aria-pressed', guideModeEnabled ? 'true' : 'false');
        toggleBtn.textContent = guideModeEnabled
          ? getLocalizedText('guideToggleOn', 'Guide: On')
          : getLocalizedText('guideToggleOff', 'Guide: Off');
      }

      const card = document.getElementById('noviceGuideCard');
      if (card) card.style.display = guideModeEnabled ? 'flex' : 'none';
      if (!guideModeEnabled) {
        clearRecommendedActions();
      }

      if (stateReady) {
        renderNoviceGuide({ applyStep3Collapse: true });
      }
    }

    function setGuideModeEnabled(enabled, options = {}) {
      const { persist = true } = options;
      guideModeEnabled = Boolean(enabled);
      if (persist) safeStorageSet(GUIDE_MODE_STORAGE_KEY, guideModeEnabled ? '1' : '0');
      updateGuideModeUI();
    }

    guideModeEnabled = safeStorageGet(GUIDE_MODE_STORAGE_KEY) !== '0';
    try {
      step3GuideCollapsedOnce = sessionStorage.getItem(STEP3_GUIDE_COLLAPSED_SESSION_KEY) === '1';
    } catch (err) {
      step3GuideCollapsedOnce = false;
    }
    const guideToggleBtn = document.getElementById('guideToggleBtn');
    if (guideToggleBtn) {
      guideToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setGuideModeEnabled(!guideModeEnabled);
      });
    }
    updateGuideModeUI();

	    function applyTemplate(template, vars = {}) {
	      let output = String(template || '');
	      Object.entries(vars).forEach(([key, value]) => {
	        output = output.replaceAll(`{${key}}`, String(value));
      });
      return output;
    }

    function formatLensLabel(lens) {
      if (!lens || typeof lens !== 'object') return '';
      const maker = String(lens.maker || '').trim();
      const model = String(lens.model || '').trim();
      return `${maker} ${model}`.trim() || model || maker || '';
    }

    function sanitizeLensRuntimeError(err) {
      const raw = String(err?.message || err || '').replace(/\s+/g, ' ').trim();
      if (!raw) return 'unknown';
      return raw.slice(0, 180);
    }

    function getLensSourceAssets(source) {
      if (source === 'local') {
        return {
          source: 'local',
          moduleFactory: createLensfunCoreModule,
          wasmUrl: lensfunCoreWasmUrl,
          dataUrl: lensfunCoreDataUrl
        };
      }
      return {
        source: 'cdn',
        iifeUrl: `${LENSFUN_CDN_BASE}/umd/index.iife.js`,
        moduleJsUrl: `${LENSFUN_CDN_BASE}/assets/lensfun-core.js`,
        wasmUrl: `${LENSFUN_CDN_BASE}/assets/lensfun-core.wasm`,
        dataUrl: `${LENSFUN_CDN_BASE}/assets/lensfun-core.data`
      };
    }

    function loadLensScript(url) {
      if (lensScriptLoadPromises.has(url)) return lensScriptLoadPromises.get(url);

      const promise = new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[data-lensfun-src="${url}"]`);
        if (existing) {
          existing.addEventListener('load', () => resolve(url), { once: true });
          existing.addEventListener('error', () => reject(new Error(`failed to load ${url}`)), { once: true });
          return;
        }

        const script = document.createElement('script');
        script.src = url;
        script.async = true;
        script.dataset.lensfunSrc = url;
        script.onload = () => resolve(url);
        script.onerror = () => reject(new Error(`failed to load ${url}`));
        document.head.appendChild(script);
      }).catch((err) => {
        lensScriptLoadPromises.delete(url);
        throw err;
      });

      lensScriptLoadPromises.set(url, promise);
      return promise;
    }

    async function initLensfunClientFromSource(source) {
      const assets = getLensSourceAssets(source);
      if (source === 'local') {
        const client = await createLensfun({
          moduleFactory: assets.moduleFactory,
          wasmUrl: assets.wasmUrl,
          dataUrl: assets.dataUrl
        });
        return { client, source: assets.source };
      }

      await loadLensScript(assets.iifeUrl);
      if (!window.LensfunWasm || typeof window.LensfunWasm.createLensfun !== 'function') {
        throw new Error('LensfunWasm global is unavailable');
      }

      const client = await window.LensfunWasm.createLensfun({
        moduleJsUrl: assets.moduleJsUrl,
        wasmUrl: assets.wasmUrl,
        dataUrl: assets.dataUrl
      });
      return { client, source: assets.source };
    }

    async function ensureLensfunClient() {
      if (lensfunRuntime.client) {
        return { client: lensfunRuntime.client, source: lensfunRuntime.source };
      }
      if (lensfunRuntime.initPromise) {
        return lensfunRuntime.initPromise;
      }

      lensfunRuntime.initPromise = (async () => {
        try {
          const runtime = await initLensfunClientFromSource('local');
          lensfunRuntime.client = runtime.client;
          lensfunRuntime.source = runtime.source;
          lensfunRuntime.lastError = '';
          return runtime;
        } catch (localErr) {
          try {
            const runtime = await initLensfunClientFromSource('cdn');
            lensfunRuntime.client = runtime.client;
            lensfunRuntime.source = runtime.source;
            lensfunRuntime.lastError = '';
            return runtime;
          } catch (cdnErr) {
            const localReason = sanitizeLensRuntimeError(localErr);
            const cdnReason = sanitizeLensRuntimeError(cdnErr);
            lensfunRuntime.lastError = `local: ${localReason}; CDN: ${cdnReason}`;
            throw new Error(lensfunRuntime.lastError);
          }
        }
      })();

      try {
        return await lensfunRuntime.initPromise;
      } finally {
        if (!lensfunRuntime.client) lensfunRuntime.initPromise = null;
      }
    }

    function resolveLensStatusKeyForSource(source) {
      return source === 'cdn' ? 'lensStatusReadyCdn' : 'lensStatusReadyLocal';
    }

    function setLensStatus(statusKey, statusVars = {}) {
      if (!state || !state.lensCorrection) return;
      state.lensCorrection.statusKey = statusKey || 'lensStatusIdle';
      state.lensCorrection.statusVars = statusVars && typeof statusVars === 'object'
        ? { ...statusVars }
        : {};
      if (stateReady) updateLensCorrectionUI();
    }

    function getAutoLensMapStep(width, height) {
      const maxSide = Math.max(width, height);
      if (maxSide >= 5200) return 8;
      if (maxSide >= 3600) return 6;
      if (maxSide >= 2400) return 4;
      if (maxSide >= 1500) return 3;
      return 2;
    }

    function resolveLensMapStep(params, width, height) {
      if (params.stepMode === 'manual') {
        return Math.round(clampBetween(params.step || 2, 1, 16));
      }
      return getAutoLensMapStep(width, height);
    }

    function buildLensMapCacheKey(lensHandle, width, height, params, modes) {
      return [
        lensHandle,
        width,
        height,
        params.focal.toFixed(4),
        params.crop.toFixed(4),
        params.aperture.toFixed(4),
        params.distance.toFixed(4),
        params.step,
        params.stepMode,
        modes.includeTca ? 1 : 0,
        modes.includeVignetting ? 1 : 0
      ].join('|');
    }

    function bilerp(a00, a10, a01, a11, fx, fy) {
      const x0 = a00 + (a10 - a00) * fx;
      const x1 = a01 + (a11 - a01) * fx;
      return x0 + (x1 - x0) * fy;
    }

    function sampleImageChannelBilinear(data, width, height, x, y, channel) {
      if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return 0;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const x1 = Math.min(x0 + 1, width - 1);
      const y1 = Math.min(y0 + 1, height - 1);
      const fx = x - x0;
      const fy = y - y0;

      const i00 = (y0 * width + x0) * 4 + channel;
      const i10 = (y0 * width + x1) * 4 + channel;
      const i01 = (y1 * width + x0) * 4 + channel;
      const i11 = (y1 * width + x1) * 4 + channel;

      return bilerp(data[i00], data[i10], data[i01], data[i11], fx, fy);
    }

    function sampleGridPair(grid, gridWidth, x0, x1, y0, y1, fx, fy) {
      const p00 = (y0 * gridWidth + x0) * 2;
      const p10 = (y0 * gridWidth + x1) * 2;
      const p01 = (y1 * gridWidth + x0) * 2;
      const p11 = (y1 * gridWidth + x1) * 2;
      return {
        x: bilerp(grid[p00], grid[p10], grid[p01], grid[p11], fx, fy),
        y: bilerp(grid[p00 + 1], grid[p10 + 1], grid[p01 + 1], grid[p11 + 1], fx, fy)
      };
    }

    function sampleGridTriple(grid, gridWidth, x0, x1, y0, y1, fx, fy) {
      const p00 = (y0 * gridWidth + x0) * 3;
      const p10 = (y0 * gridWidth + x1) * 3;
      const p01 = (y1 * gridWidth + x0) * 3;
      const p11 = (y1 * gridWidth + x1) * 3;
      return {
        r: bilerp(grid[p00], grid[p10], grid[p01], grid[p11], fx, fy),
        g: bilerp(grid[p00 + 1], grid[p10 + 1], grid[p01 + 1], grid[p11 + 1], fx, fy),
        b: bilerp(grid[p00 + 2], grid[p10 + 2], grid[p01 + 2], grid[p11 + 2], fx, fy)
      };
    }

    function sampleGridTca(grid, gridWidth, x0, x1, y0, y1, fx, fy) {
      const p00 = (y0 * gridWidth + x0) * 6;
      const p10 = (y0 * gridWidth + x1) * 6;
      const p01 = (y1 * gridWidth + x0) * 6;
      const p11 = (y1 * gridWidth + x1) * 6;
      return {
        rx: bilerp(grid[p00], grid[p10], grid[p01], grid[p11], fx, fy),
        ry: bilerp(grid[p00 + 1], grid[p10 + 1], grid[p01 + 1], grid[p11 + 1], fx, fy),
        gx: bilerp(grid[p00 + 2], grid[p10 + 2], grid[p01 + 2], grid[p11 + 2], fx, fy),
        gy: bilerp(grid[p00 + 3], grid[p10 + 3], grid[p01 + 3], grid[p11 + 3], fx, fy),
        bx: bilerp(grid[p00 + 4], grid[p10 + 4], grid[p01 + 4], grid[p11 + 4], fx, fy),
        by: bilerp(grid[p00 + 5], grid[p10 + 5], grid[p01 + 5], grid[p11 + 5], fx, fy)
      };
    }

    function applyLensMapsToImage(imageData, maps, modes) {
      const { width, height, data } = imageData;
      const output = new ImageData(new Uint8ClampedArray(data.length), width, height);
      const outData = output.data;
      const gridWidth = maps.gridWidth;
      const gridHeight = maps.gridHeight;
      const step = Math.max(1, maps.step || 1);
      const geometry = maps.geometry;
      const tca = (modes.includeTca && maps.tca) ? maps.tca : null;
      const vignetting = (modes.includeVignetting && maps.vignetting) ? maps.vignetting : null;

      for (let y = 0; y < height; y++) {
        const gyRaw = y / step;
        const y0 = clampBetween(Math.floor(gyRaw), 0, gridHeight - 1);
        const y1 = clampBetween(y0 + 1, 0, gridHeight - 1);
        const fy = clampBetween(gyRaw - y0, 0, 1);

        for (let x = 0; x < width; x++) {
          const gxRaw = x / step;
          const x0 = clampBetween(Math.floor(gxRaw), 0, gridWidth - 1);
          const x1 = clampBetween(x0 + 1, 0, gridWidth - 1);
          const fx = clampBetween(gxRaw - x0, 0, 1);

          let rX, rY, gX, gY, bX, bY;
          if (tca) {
            const tcaCoords = sampleGridTca(tca, gridWidth, x0, x1, y0, y1, fx, fy);
            rX = tcaCoords.rx; rY = tcaCoords.ry;
            gX = tcaCoords.gx; gY = tcaCoords.gy;
            bX = tcaCoords.bx; bY = tcaCoords.by;
          } else {
            const geometryCoords = sampleGridPair(geometry, gridWidth, x0, x1, y0, y1, fx, fy);
            rX = geometryCoords.x; rY = geometryCoords.y;
            gX = geometryCoords.x; gY = geometryCoords.y;
            bX = geometryCoords.x; bY = geometryCoords.y;
          }

          let r = sampleImageChannelBilinear(data, width, height, rX, rY, 0);
          let g = sampleImageChannelBilinear(data, width, height, gX, gY, 1);
          let b = sampleImageChannelBilinear(data, width, height, bX, bY, 2);

          if (vignetting) {
            const gains = sampleGridTriple(vignetting, gridWidth, x0, x1, y0, y1, fx, fy);
            r *= gains.r;
            g *= gains.g;
            b *= gains.b;
          }

          const outIdx = (y * width + x) * 4;
          outData[outIdx] = clampBetween(Math.round(r), 0, 255);
          outData[outIdx + 1] = clampBetween(Math.round(g), 0, 255);
          outData[outIdx + 2] = clampBetween(Math.round(b), 0, 255);
          outData[outIdx + 3] = 255;
        }
      }
      return output;
    }

    async function applyLensCorrectionWithSettings(imageData, settings, options = {}) {
      const { updateUi = false } = options;
      const safeSettings = sanitizeSettings(settings, {
        fallbackSettings: state,
        includeCurvePoints: false,
        includeCurves: false
      });
      const lensCorrection = safeSettings.lensCorrection;
      const selectedLens = lensCorrection.selectedLens;

      if (!lensCorrection.enabled) {
        if (updateUi) setLensStatus('lensStatusSkipped');
        return imageData;
      }

      if (!selectedLens || !selectedLens.handle) {
        if (updateUi) setLensStatus('lensStatusNeedProfile');
        return imageData;
      }

      if (updateUi) setLensStatus('lensStatusLoading');

      let runtime;
      try {
        runtime = await ensureLensfunClient();
      } catch (err) {
        const reason = sanitizeLensRuntimeError(err);
        if (updateUi) {
          state.lensCorrection.lastError = reason;
          setLensStatus('lensStatusInitFailed', { reason });
        }
        return imageData;
      }

      if (updateUi) {
        state.lensCorrection.source = runtime.source;
        setLensStatus(resolveLensStatusKeyForSource(runtime.source));
      }

      try {
        const params = {
          focal: lensCorrection.params.focal,
          crop: lensCorrection.params.crop,
          aperture: lensCorrection.params.aperture,
          distance: lensCorrection.params.distance,
          stepMode: lensCorrection.params.stepMode,
          step: resolveLensMapStep(lensCorrection.params, imageData.width, imageData.height)
        };
        const cacheKey = buildLensMapCacheKey(
          selectedLens.handle,
          imageData.width,
          imageData.height,
          params,
          lensCorrection.modes
        );
        let maps = lensMapCache.get(cacheKey);
        if (!maps) {
          maps = runtime.client.buildCorrectionMaps({
            lensHandle: selectedLens.handle,
            width: imageData.width,
            height: imageData.height,
            focal: params.focal,
            crop: params.crop,
            step: params.step,
            reverse: false,
            includeTca: lensCorrection.modes.includeTca,
            includeVignetting: lensCorrection.modes.includeVignetting,
            aperture: params.aperture,
            distance: params.distance
          });
          lensMapCache.set(cacheKey, maps);
          if (lensMapCache.size > 12) {
            const oldestKey = lensMapCache.keys().next().value;
            if (oldestKey) lensMapCache.delete(oldestKey);
          }
        }

        const corrected = applyLensMapsToImage(imageData, maps, lensCorrection.modes);
        if (updateUi) {
          state.lensCorrection.lastError = '';
          setLensStatus('lensStatusApplied');
        }
        return corrected;
      } catch (err) {
        const reason = sanitizeLensRuntimeError(err);
        if (updateUi) {
          state.lensCorrection.lastError = reason;
          setLensStatus('lensStatusApplyFailed', { reason });
        }
        return imageData;
      }
    }

    function parseMetadataNumber(value) {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value !== 'string') return NaN;
      const text = value.trim();
      if (!text) return NaN;

      const ratio = text.match(/(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/);
      if (ratio) {
        const num = Number(ratio[1]);
        const den = Number(ratio[2]);
        if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) return num / den;
      }

      const direct = text.match(/-?\d+(?:\.\d+)?/);
      if (!direct) return NaN;
      const parsed = Number(direct[0]);
      return Number.isFinite(parsed) ? parsed : NaN;
    }

    function normalizeMetadataKey(key) {
      return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    }

    function findMetadataValue(metadata, candidateKeys) {
      if (!metadata || typeof metadata !== 'object') return null;
      const target = new Set(candidateKeys.map(normalizeMetadataKey));
      const queue = [metadata];
      const visited = new Set();
      let depth = 0;

      while (queue.length && depth < 3000) {
        const node = queue.shift();
        depth++;
        if (!node || typeof node !== 'object' || visited.has(node)) continue;
        visited.add(node);

        for (const [rawKey, rawValue] of Object.entries(node)) {
          const normalizedKey = normalizeMetadataKey(rawKey);
          if (target.has(normalizedKey) && rawValue !== null && rawValue !== undefined && rawValue !== '') {
            return rawValue;
          }
          if (rawValue && typeof rawValue === 'object') queue.push(rawValue);
        }
      }
      return null;
    }

    function extractRawLensMetadata(metadata) {
      if (!metadata || typeof metadata !== 'object') return null;
      const lensModelRaw = findMetadataValue(metadata, ['lensModel', 'lens', 'lensName', 'lensDescription', 'lensInfo']);
      const lensMakerRaw = findMetadataValue(metadata, ['lensMaker', 'lensMake']);
      const cameraModelRaw = findMetadataValue(metadata, ['cameraModel', 'model', 'camera']);
      const cameraMakerRaw = findMetadataValue(metadata, ['cameraMaker', 'make', 'cameraMake']);
      const focalRaw = findMetadataValue(metadata, ['focalLength', 'focalLen', 'focal', 'focalMm']);
      const apertureRaw = findMetadataValue(metadata, ['aperture', 'fNumber', 'fstop', 'fStop']);

      const focal = parseMetadataNumber(focalRaw);
      const aperture = parseMetadataNumber(apertureRaw);

      const output = {
        lensModel: lensModelRaw ? String(lensModelRaw).trim() : '',
        lensMaker: lensMakerRaw ? String(lensMakerRaw).trim() : '',
        cameraModel: cameraModelRaw ? String(cameraModelRaw).trim() : '',
        cameraMaker: cameraMakerRaw ? String(cameraMakerRaw).trim() : '',
        focal: Number.isFinite(focal) ? focal : NaN,
        aperture: Number.isFinite(aperture) ? aperture : NaN
      };
      return output;
    }

    function applyLensMetadataPrefill(metadata) {
      if (!metadata || typeof metadata !== 'object') return;
      const search = state.lensCorrection.search;
      if (!search.lensModel && metadata.lensModel) search.lensModel = metadata.lensModel;
      if (!search.lensMaker && metadata.lensMaker) search.lensMaker = metadata.lensMaker;
      if (!search.cameraModel && metadata.cameraModel) search.cameraModel = metadata.cameraModel;
      if (!search.cameraMaker && metadata.cameraMaker) search.cameraMaker = metadata.cameraMaker;

      if (!state.lensCorrection.paramTouched.focal && Number.isFinite(metadata.focal)) {
        state.lensCorrection.params.focal = clampBetween(metadata.focal, 1, 10_000);
      }
      if (!state.lensCorrection.paramTouched.aperture && Number.isFinite(metadata.aperture)) {
        state.lensCorrection.params.aperture = clampBetween(metadata.aperture, 0.5, 512);
      }

      updateLensCorrectionUI();
    }

    function guessFocalFromLensProfile(lens) {
      if (!lens || typeof lens !== 'object') return 50;
      const minFocal = sanitizeNumeric(lens.minFocal, NaN, 0, 10_000);
      const maxFocal = sanitizeNumeric(lens.maxFocal, NaN, 0, 10_000);
      if (Number.isFinite(minFocal) && Number.isFinite(maxFocal) && maxFocal >= minFocal && maxFocal > 0) {
        if (minFocal > 0 && maxFocal > 0) return (minFocal + maxFocal) / 2;
      }
      if (Number.isFinite(minFocal) && minFocal > 0) return minFocal;
      if (Number.isFinite(maxFocal) && maxFocal > 0) return maxFocal;
      return 50;
    }

    function syncLensStepInputState() {
      const stepModeSelect = document.getElementById('lensStepModeSelect');
      const stepInput = document.getElementById('lensStepInput');
      if (!stepModeSelect || !stepInput) return;
      const manual = stepModeSelect.value === 'manual';
      stepInput.disabled = !manual;
    }

    function renderLensSearchResults() {
      const select = document.getElementById('lensResultSelect');
      if (!select) return;
      const results = Array.isArray(state.lensCorrection.searchResults)
        ? state.lensCorrection.searchResults
        : [];
      const selectedHandle = state.lensCorrection.selectedLens?.handle || null;

      select.innerHTML = '';
      if (!results.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = getLocalizedText('lensNoResult', 'No profiles loaded yet');
        select.appendChild(opt);
        select.disabled = true;
        return;
      }

      results.forEach((lens, idx) => {
        const option = document.createElement('option');
        option.value = String(idx);
        const maker = String(lens.maker || '').trim();
        const model = String(lens.model || '').trim();
        const lensLabel = `${maker} ${model}`.trim() || '-';
        const score = Number.isFinite(lens.score) ? Number(lens.score).toFixed(3) : '0.000';
        const minFocal = Number.isFinite(lens.minFocal) ? Number(lens.minFocal).toFixed(1) : '-';
        const maxFocal = Number.isFinite(lens.maxFocal) ? Number(lens.maxFocal).toFixed(1) : '-';
        const scoreLabel = getLocalizedText('lensScoreLabel', 'score');
        const template = getLocalizedText(
          'lensResultItemTemplate',
          '{lens} | {scoreLabel} {score} | {minFocal}-{maxFocal}mm'
        );
        option.textContent = applyTemplate(template, {
          lens: lensLabel,
          scoreLabel,
          score,
          minFocal,
          maxFocal
        }).trim();
        if (selectedHandle && lens.handle === selectedHandle) {
          option.selected = true;
        }
        select.appendChild(option);
      });
      select.disabled = false;
      if (select.selectedIndex < 0) select.selectedIndex = 0;
    }

    function updateLensCorrectionUI() {
      const panel = document.getElementById('lensCorrectionPanel');
      if (!panel) return;

      const enableInput = document.getElementById('lensEnableInput');
      const lensModelInput = document.getElementById('lensLensModelInput');
      const lensMakerInput = document.getElementById('lensLensMakerInput');
      const cameraModelInput = document.getElementById('lensCameraModelInput');
      const cameraMakerInput = document.getElementById('lensCameraMakerInput');
      const focalInput = document.getElementById('lensFocalInput');
      const cropInput = document.getElementById('lensCropInput');
      const apertureInput = document.getElementById('lensApertureInput');
      const distanceInput = document.getElementById('lensDistanceInput');
      const stepModeSelect = document.getElementById('lensStepModeSelect');
      const stepInput = document.getElementById('lensStepInput');
      const useSelectedBtn = document.getElementById('lensUseSelectedBtn');
      const statusBox = document.getElementById('lensStatusBox');
      const selectedText = document.getElementById('lensSelectedText');

      enableInput.checked = Boolean(state.lensCorrection.enabled);
      lensModelInput.value = state.lensCorrection.search.lensModel || '';
      lensMakerInput.value = state.lensCorrection.search.lensMaker || '';
      cameraModelInput.value = state.lensCorrection.search.cameraModel || '';
      cameraMakerInput.value = state.lensCorrection.search.cameraMaker || '';

      focalInput.value = String(Number(state.lensCorrection.params.focal).toFixed(2)).replace(/\.00$/, '');
      cropInput.value = String(Number(state.lensCorrection.params.crop).toFixed(3)).replace(/\.?0+$/, '');
      apertureInput.value = String(Number(state.lensCorrection.params.aperture).toFixed(2)).replace(/\.00$/, '');
      distanceInput.value = String(Number(state.lensCorrection.params.distance).toFixed(2)).replace(/\.00$/, '');
      stepModeSelect.value = state.lensCorrection.params.stepMode === 'manual' ? 'manual' : 'auto';
      stepInput.value = String(Math.round(state.lensCorrection.params.step || 2));
      syncLensStepInputState();

      renderLensSearchResults();
      const hasResults = Array.isArray(state.lensCorrection.searchResults) && state.lensCorrection.searchResults.length > 0;
      useSelectedBtn.disabled = !hasResults;

      const selectedLens = state.lensCorrection.selectedLens;
      if (selectedLens) {
        selectedText.textContent = applyTemplate(
          getLocalizedText('lensSelectedPrefix', 'Selected profile: {lens}'),
          { lens: formatLensLabel(selectedLens) || `#${selectedLens.handle}` }
        );
      } else {
        selectedText.textContent = getLocalizedText('lensSelectedNone', 'Selected profile: none');
      }

      const statusKey = state.lensCorrection.statusKey || 'lensStatusIdle';
      const template = getLocalizedText(statusKey, getLocalizedText('lensStatusIdle', 'Lens correction is optional.'));
      statusBox.textContent = applyTemplate(template, state.lensCorrection.statusVars || {});
      statusBox.classList.remove('error', 'ready');
      if (statusKey === 'lensStatusInitFailed' || statusKey === 'lensStatusApplyFailed') {
        statusBox.classList.add('error');
      } else if (statusKey === 'lensStatusReadyCdn' || statusKey === 'lensStatusReadyLocal' || statusKey === 'lensStatusApplied') {
        statusBox.classList.add('ready');
      }
    }

    function parseSemver(value) {
      if (typeof value !== 'string') return null;
      const normalized = value.trim().replace(/^v/i, '');
      const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)$/);
      if (!match) return null;
      return {
        normalized,
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3])
      };
    }

    function compareSemver(a, b) {
      if (a.major !== b.major) return a.major - b.major;
      if (a.minor !== b.minor) return a.minor - b.minor;
      return a.patch - b.patch;
    }

    function updateDesktopUpdateBannerText() {
      const body = document.getElementById('desktopUpdateBody');
      if (!body) return;
      const template = getLocalizedText(
        'desktopUpdateBody',
        'Current version {current}, latest version {latest}.'
      );
      const current = desktopUpdateState.currentVersion || '0.0.0';
      const latest = desktopUpdateState.latestVersion || '0.0.0';
      body.textContent = applyTemplate(template, { current, latest });
    }

    function showDesktopUpdateBanner(currentVersion, latestVersion) {
      const banner = document.getElementById('desktopUpdateBanner');
      if (!banner) return;
      desktopUpdateState.visible = true;
      desktopUpdateState.currentVersion = currentVersion;
      desktopUpdateState.latestVersion = latestVersion;
      updateDesktopUpdateBannerText();
      banner.style.display = 'flex';
    }

    function hideDesktopUpdateBanner() {
      const banner = document.getElementById('desktopUpdateBanner');
      if (!banner) return;
      desktopUpdateState.visible = false;
      banner.style.display = 'none';
    }

    function shouldSkipDesktopUpdateCheck() {
      const raw = safeStorageGet(DESKTOP_UPDATE_LAST_CHECK_TS_KEY);
      const lastCheck = Number(raw);
      if (!Number.isFinite(lastCheck) || lastCheck <= 0) return false;
      return (Date.now() - lastCheck) < DESKTOP_UPDATE_CHECK_INTERVAL_MS;
    }

    function markDesktopUpdateChecked() {
      safeStorageSet(DESKTOP_UPDATE_LAST_CHECK_TS_KEY, String(Date.now()));
    }

    async function fetchLatestDesktopVersion() {
      let lastError = null;
      for (const url of DESKTOP_UPDATE_MANIFEST_URLS) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), DESKTOP_UPDATE_FETCH_TIMEOUT_MS);
        try {
          const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const payload = await response.json();
          const fromVersion = typeof payload.version === 'string' ? payload.version : '';
          const fromTag = typeof payload.tag === 'string' ? payload.tag : '';
          const parsed = parseSemver(fromVersion) || parseSemver(fromTag);
          if (!parsed) throw new Error('invalid version in latest.json');
          return parsed.normalized;
        } catch (err) {
          lastError = err;
        } finally {
          clearTimeout(timeout);
        }
      }
      throw lastError || new Error('failed to load release manifest');
    }

    function buildDesktopUpdateDownloadUrl() {
      const url = new URL(DESKTOP_UPDATE_PAGE_URL);
      url.searchParams.set('lang', currentLang || 'en');
      url.searchParams.set('from', 'desktop-update');
      if (desktopUpdateState.currentVersion) url.searchParams.set('current', desktopUpdateState.currentVersion);
      if (desktopUpdateState.latestVersion) url.searchParams.set('latest', desktopUpdateState.latestVersion);
      return url.toString();
    }

    async function openDownloadPageForUpdate() {
      const url = buildDesktopUpdateDownloadUrl();
      if (isTauriDesktop()) {
        try {
          await window.__TAURI__.core.invoke('open_external_url', { url });
          return;
        } catch (err) {
          console.warn('Desktop open_external_url failed, falling back to window.open:', err);
        }
      }
      window.open(url, '_blank', 'noopener');
    }

    async function checkDesktopUpdate(options = {}) {
      if (!isTauriDesktop()) return;
      const force = Boolean(options.force);
      if (!force && shouldSkipDesktopUpdateCheck()) return;

      try {
        const currentRaw = await window.__TAURI__.core.invoke('get_app_version');
        const currentParsed = parseSemver(String(currentRaw || ''));
        if (!currentParsed) return;

        const latest = await fetchLatestDesktopVersion();
        const latestParsed = parseSemver(latest);
        if (!latestParsed) return;

        if (compareSemver(latestParsed, currentParsed) > 0) {
          safeStorageSet(DESKTOP_UPDATE_LAST_SEEN_LATEST_KEY, latestParsed.normalized);
          showDesktopUpdateBanner(currentParsed.normalized, latestParsed.normalized);
        }
      } catch (err) {
        console.info('Desktop update check skipped:', err);
      } finally {
        markDesktopUpdateChecked();
      }
    }

    function initDesktopUpdateCheck() {
      const actionBtn = document.getElementById('desktopUpdateActionBtn');
      const laterBtn = document.getElementById('desktopUpdateLaterBtn');
      if (actionBtn) {
        actionBtn.addEventListener('click', () => {
          openDownloadPageForUpdate().catch((err) => {
            console.warn('Failed to open download page:', err);
          });
        });
      }
      if (laterBtn) {
        laterBtn.addEventListener('click', () => {
          hideDesktopUpdateBanner();
        });
      }
      checkDesktopUpdate().catch((err) => {
        console.info('Desktop update check failed:', err);
      });
    }

    function initPrivacyBannerToggle() {
      const banner = document.querySelector('.privacy-banner');
      const toggle = document.getElementById('privacyBannerToggle');
      if (!banner || !toggle) return;

      const collapsed = safeStorageGet(PRIVACY_BANNER_COLLAPSED_STORAGE_KEY) === '1';
      banner.classList.toggle('collapsed', collapsed);

      toggle.addEventListener('click', () => {
        banner.classList.add('collapsed');
        safeStorageSet(PRIVACY_BANNER_COLLAPSED_STORAGE_KEY, '1');
      });
    }

    initPrivacyBannerToggle();
    initDesktopUpdateCheck();
    window.addEventListener('beforeunload', () => {
      if (lensfunRuntime.client && typeof lensfunRuntime.client.dispose === 'function') {
        try {
          lensfunRuntime.client.dispose();
        } catch (err) {
          // ignore
        }
      }
    });

    // ===========================================
    // Film Type
    // ===========================================
    const PRESET_TYPES = ['color', 'bw', 'positive'];

    function sanitizePresetType(type) {
      return PRESET_TYPES.includes(type) ? type : 'color';
    }

    function inferFilmTypeFromLegacyPreset(presetId, fallback = 'color') {
      const fallbackType = sanitizePresetType(fallback);
      const normalized = String(presetId || '').trim().toLowerCase();
      if (!normalized) return fallbackType;

      if (
        normalized.endsWith('_positive')
        || normalized.includes('positive')
        || normalized.includes('provia')
        || normalized.includes('velvia')
        || normalized.includes('ektachrome')
        || normalized.includes('slide')
      ) {
        return 'positive';
      }

      if (
        normalized.endsWith('_bw')
        || normalized.includes('bw')
        || normalized.includes('ilford')
        || normalized.includes('trix')
        || normalized.includes('tri-x')
        || normalized.includes('tmax')
        || normalized.includes('acros')
        || normalized.includes('hp5')
        || normalized.includes('fp4')
        || normalized.includes('panf')
        || normalized.includes('delta')
        || normalized.includes('sfx')
        || normalized.includes('xp2')
        || normalized.includes('neopan')
      ) {
        return 'bw';
      }

      return 'color';
    }

    function sanitizeCoreEnhancedProfile(value, fallback = 'none') {
      const normalizedFallback = CORE_ENHANCED_PROFILE_OPTIONS.has(fallback) ? fallback : 'none';
      const normalized = String(value || normalizedFallback);
      return CORE_ENHANCED_PROFILE_OPTIONS.has(normalized) ? normalized : normalizedFallback;
    }

    function sanitizeCoreColorModel(value, fallback = 'standard') {
      const fallbackRaw = String(fallback || 'standard').trim().toLowerCase();
      const fallbackMigrated = CORE_COLOR_MODEL_MIGRATION_MAP[fallbackRaw] || fallbackRaw;
      const normalizedFallback = CORE_COLOR_MODEL_OPTIONS.has(fallbackMigrated) ? fallbackMigrated : 'standard';

      const raw = String(value || normalizedFallback).trim().toLowerCase();
      const migrated = CORE_COLOR_MODEL_MIGRATION_MAP[raw] || raw;
      return CORE_COLOR_MODEL_OPTIONS.has(migrated) ? migrated : normalizedFallback;
    }

    function createDefaultLensCorrectionSettings() {
      return {
        enabled: false,
        selectedLens: null,
        params: {
          focal: 50,
          crop: 1,
          aperture: 8,
          distance: 1000,
          stepMode: 'auto',
          step: 2
        },
        modes: {
          includeTca: true,
          includeVignetting: true
        },
        lastError: ''
      };
    }

    function createInitialLensCorrectionState() {
      const base = createDefaultLensCorrectionSettings();
      return {
        enabled: base.enabled,
        selectedLens: base.selectedLens,
        params: { ...base.params },
        modes: { ...base.modes },
        lastError: base.lastError,
        search: {
          lensModel: '',
          lensMaker: '',
          cameraModel: '',
          cameraMaker: ''
        },
        searchResults: [],
        statusKey: 'lensStatusIdle',
        statusVars: {},
        source: null,
        paramTouched: {
          focal: false,
          crop: false,
          aperture: false,
          distance: false,
          stepMode: false,
          step: false
        }
      };
    }

    function sanitizeLensSelection(input, fallback = null) {
      const source = (input && typeof input === 'object') ? input : fallback;
      if (!source || typeof source !== 'object') return null;
      const handleRaw = Number(source.handle);
      const handle = Number.isFinite(handleRaw) ? Math.trunc(handleRaw) : NaN;
      if (!Number.isFinite(handle) || handle < 1) return null;
      return {
        handle,
        maker: String(source.maker || '').trim(),
        model: String(source.model || '').trim(),
        score: sanitizeNumeric(source.score, 0, 0, 1_000_000),
        minFocal: sanitizeNumeric(source.minFocal, 0, 0, 10_000),
        maxFocal: sanitizeNumeric(source.maxFocal, 0, 0, 10_000),
        minAperture: sanitizeNumeric(source.minAperture, 0, 0, 512),
        maxAperture: sanitizeNumeric(source.maxAperture, 0, 0, 512),
        cropFactor: sanitizeNumeric(source.cropFactor, 1, 0.1, 10)
      };
    }

    function sanitizeLensCorrection(input, fallback = null) {
      const fallbackValue = (fallback && typeof fallback === 'object')
        ? fallback
        : createDefaultLensCorrectionSettings();
      const source = (input && typeof input === 'object') ? input : {};
      const selectedLens = sanitizeLensSelection(source.selectedLens, fallbackValue.selectedLens);

      const fallbackParams = (fallbackValue.params && typeof fallbackValue.params === 'object')
        ? fallbackValue.params
        : createDefaultLensCorrectionSettings().params;
      const sourceParams = (source.params && typeof source.params === 'object') ? source.params : {};
      const stepMode = sourceParams.stepMode === 'manual'
        ? 'manual'
        : (fallbackParams.stepMode === 'manual' ? 'manual' : 'auto');

      const fallbackModes = (fallbackValue.modes && typeof fallbackValue.modes === 'object')
        ? fallbackValue.modes
        : createDefaultLensCorrectionSettings().modes;
      const sourceModes = (source.modes && typeof source.modes === 'object') ? source.modes : {};

      return {
        enabled: Boolean(source.enabled ?? fallbackValue.enabled),
        selectedLens,
        params: {
          focal: sanitizeNumeric(sourceParams.focal, fallbackParams.focal ?? 50, 1, 10_000),
          crop: sanitizeNumeric(sourceParams.crop, fallbackParams.crop ?? 1, 0.1, 10),
          aperture: sanitizeNumeric(sourceParams.aperture, fallbackParams.aperture ?? 8, 0.5, 512),
          distance: sanitizeNumeric(sourceParams.distance, fallbackParams.distance ?? 1000, 0.1, 100_000),
          stepMode,
          step: Math.round(sanitizeNumeric(sourceParams.step, fallbackParams.step ?? 2, 1, 16))
        },
        modes: {
          includeTca: sourceModes.includeTca !== false,
          includeVignetting: sourceModes.includeVignetting !== false
        },
        lastError: String(source.lastError || fallbackValue.lastError || '').slice(0, 300)
      };
    }

    // ===========================================
    // Application State
    // ===========================================
    const state = {
      // Workflow state
      currentStep: 1,  // 1=crop, 2=film base, 3=adjust

      // Image data
      loadedBaseImageData: null,    // File-loaded baseline (never transformed)
      originalImageData: null,      // Current working base image (may include rotation)
      croppedImageData: null,       // After cropping (still negative)
      processedImageData: null,     // After negative conversion
      displayImageData: null,       // After all adjustments
      conversionSourceImageData: null, // Lens-corrected source used for core conversion rerender
      conversionPreviewImageData: null, // Downscaled conversionSourceImageData for preview-resolution SilverCore
      previewSourceImageData: null, // Downscaled source for preview renders
      histogramSourceImageData: null, // Further downscaled source for histogram updates
      webglSourceImageData: null,   // Downscaled source for WebGL preview renders

      // Film settings
      filmType: 'color',
      filmBase: { r: 210, g: 140, b: 90 },
      filmBaseSet: false,
      step2Mode: 'border', // 'border' | 'noBorder'
      lensCorrection: createInitialLensCorrectionState(),
      rawMetadata: null,

      // SilverCore conversion controls (for color/bw negatives)
      coreFilmPreset: 'none',
      coreColorModel: 'standard',
      coreEnhancedProfile: 'none',
      coreProfileStrength: 100,
      corePreSaturation: 100,
      coreBorderBuffer: 10,
      coreBorderBufferBorderValue: 10,
      coreBrightness: 0,
      coreExposure: 0,
      coreContrast: 0,
      coreHighlights: 0,
      coreShadows: 0,
      coreWhites: 0,
      coreBlacks: 0,
      coreWbMode: 'auto',
      coreTemperature: 0,
      coreTint: 0,
      coreSaturation: 100,
      coreGlow: 0,
      coreFade: 0,
      coreCurvePrecision: 'auto',
      coreUseWebGL: true,

      // White balance multipliers
      wbR: 1.0,
      wbG: 1.0,
      wbB: 1.0,

      // Tone adjustments
      exposure: 0,
      contrast: 0,
      highlights: 0,
      shadows: 0,

      // Color adjustments
      temperature: 0,
      tint: 0,
      vibrance: 0,
      saturation: 0,

      // CMY
      cyan: 0,
      magenta: 0,
      yellow: 0,

      // Curves (256-value lookup tables)
      curves: { r: null, g: null, b: null },
      // Control points for each channel [{x, y}, ...] sorted by x
      curvePoints: {
        r: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
        g: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
        b: [{ x: 0, y: 0 }, { x: 255, y: 255 }]
      },

      // Zoom/Pan state
      zoomLevel: 1,
      panX: 0,
      panY: 0,
      isPanning: false,
      panStartX: 0,
      panStartY: 0,
      panStartPanX: 0,
      panStartPanY: 0,

      // UI state
      cropping: false,
      cropStart: null,
      croppingActive: false,
      samplingMode: null,  // null, 'filmBase', 'whiteBalance'
      rotationAngle: 0,
      beforeAfterActive: false,
      beforeAfterSource: null, // null | 'button' | 'keyboard'

      autoFrame: {
        enabled: true,
        marginRatio: 0.02,
        minConfidence: 0.55,
        highConfidence: 0.72,
        autoApplyHighConfidence: true,
        formatPreference: 'auto', // 'auto' | '135' | '120'
        allowed120Formats: {
          '6x4.5': true,
          '6x6': true,
          '6x7': true,
          '6x9': true
        },
        lowConfidenceBehavior: 'suggest', // 'suggest' | 'rotateOnly' | 'ignore'
        lastDiagnostics: null
      },

      // Batch mode state
      batchMode: false,
      batchSessionActive: false,
      // fileQueue item: {id, file, selected, status, error, settings: null | {...}, isDirty: boolean}
      // settings = null means use auto-detect for film base
      fileQueue: [],
      currentFileIndex: 0,
      // Saved crop region for current image (used when saving settings)
      cropRegion: null,

      // Roll-level reference profile (session scoped)
      rollReference: {
        enabled: false,
        sourceFileId: null,
        settingsSnapshot: null,
        applyLock: false,
        applyCrop: false
      },

      // Dust removal
      dustRemoval: {
        enabled: false,
        strength: 3,
        mask: null,          // Uint8Array (h*w)
        showMask: false,
        processing: false,
        particleCount: 0,
        _state: null,        // Internal state for updateDustStrength
        inpaintedImageData: null, // ImageData after inpainting
        brushSize: 5,
      },

      // Export settings
      exportFormat: 'png',  // 'png' | 'jpeg' | 'tiff'
      exportBitDepth: 8,    // 8 | 16
      jpegQuality: 92,      // 1-100

      // Render state
      lastRenderQuality: 'full' // 'full' | 'preview' | 'gl'
    };
    stateReady = true;
    updateGuideModeUI();

    // ===========================================
    // Toast Notification System
    // ===========================================
    function showToast(message, durationMs = 2000) {
      const container = document.getElementById('toastContainer');
      if (!container) return;
      const el = document.createElement('div');
      el.className = 'toast-message';
      el.textContent = message;
      container.appendChild(el);
      requestAnimationFrame(() => el.classList.add('toast-visible'));
      setTimeout(() => {
        el.classList.remove('toast-visible');
        el.addEventListener('transitionend', () => el.remove(), { once: true });
      }, durationMs);
    }

    // ===========================================
    // Undo / Redo System
    // ===========================================
    const undoStack = [];
    const redoStack = [];
    const MAX_UNDO = 30;

    const undoLabelMap = {
      zh: {
        rotation: '旋转', mirror: '镜像', crop: '裁剪', filmType: '胶片类型',
        curveEdit: '曲线编辑', curvePointDelete: '删除曲线点', curvePreset: '曲线预设',
        curveReset: '重置曲线', dustBrushStroke: '除尘笔刷', dustToggle: '除尘开关',
        filmBase: '色罩基准', whiteBalance: '白平衡', autoDetectBase: '自动检测色罩',
        coreExposure: '曝光', coreContrast: '对比度', coreHighlights: '高光',
        coreShadows: '阴影', coreWhites: '白色', coreBlacks: '黑色',
        coreBrightness: '亮度', coreTemperature: '色温', coreTint: '色调',
        coreSaturation: '饱和度', coreGlow: '辉光', coreFade: '褪色',
        coreWbMode: '白平衡模式', coreFilmPreset: '胶片预设',
        coreColorModel: '色彩模型', coreEnhancedProfile: '增强曲线',
        coreProfileStrength: '曲线强度', corePreSaturation: '预饱和度',
        coreBorderBuffer: '边框缓冲', coreBorderBufferBorderValue: '边框阈值',
        coreCurvePrecision: '曲线精度', coreUseWebGL: 'WebGL渲染',
        exposure: '曝光微调', contrast: '对比度微调', highlights: '高光微调',
        shadows: '阴影微调', temperature: '色温微调', tint: '色调微调',
        vibrance: '自然饱和度', saturation: '饱和度微调',
        cyan: '青色', magenta: '品红', yellow: '黄色',
        dustStrength: '除尘灵敏度', dustBrushSize: '笔刷大小',
      },
      en: {
        rotation: 'Rotation', mirror: 'Mirror', crop: 'Crop', filmType: 'Film Type',
        curveEdit: 'Curve Edit', curvePointDelete: 'Delete Curve Point', curvePreset: 'Curve Preset',
        curveReset: 'Reset Curves', dustBrushStroke: 'Dust Brush', dustToggle: 'Dust Toggle',
        filmBase: 'Film Base', whiteBalance: 'White Balance', autoDetectBase: 'Auto Detect Base',
        coreExposure: 'Exposure', coreContrast: 'Contrast', coreHighlights: 'Highlights',
        coreShadows: 'Shadows', coreWhites: 'Whites', coreBlacks: 'Blacks',
        coreBrightness: 'Brightness', coreTemperature: 'Temperature', coreTint: 'Tint',
        coreSaturation: 'Saturation', coreGlow: 'Glow', coreFade: 'Fade',
        coreWbMode: 'WB Mode', coreFilmPreset: 'Film Preset',
        coreColorModel: 'Color Model', coreEnhancedProfile: 'Enhanced Profile',
        coreProfileStrength: 'Profile Strength', corePreSaturation: 'Pre-Saturation',
        coreBorderBuffer: 'Border Buffer', coreBorderBufferBorderValue: 'Border Threshold',
        coreCurvePrecision: 'Curve Precision', coreUseWebGL: 'WebGL',
        exposure: 'Exposure Fine', contrast: 'Contrast Fine', highlights: 'Highlights Fine',
        shadows: 'Shadows Fine', temperature: 'Temperature Fine', tint: 'Tint Fine',
        vibrance: 'Vibrance', saturation: 'Saturation Fine',
        cyan: 'Cyan', magenta: 'Magenta', yellow: 'Yellow',
        dustStrength: 'Dust Sensitivity', dustBrushSize: 'Brush Size',
      },
      ja: {
        rotation: '回転', mirror: 'ミラー', crop: 'トリミング', filmType: 'フィルムタイプ',
        curveEdit: 'カーブ編集', curvePointDelete: 'カーブポイント削除', curvePreset: 'カーブプリセット',
        curveReset: 'カーブリセット', dustBrushStroke: '除塵ブラシ', dustToggle: '除塵切替',
        filmBase: 'フィルムベース', whiteBalance: 'ホワイトバランス', autoDetectBase: '自動検出',
        coreExposure: '露出', coreContrast: 'コントラスト', coreHighlights: 'ハイライト',
        coreShadows: 'シャドウ', coreWhites: 'ホワイト', coreBlacks: 'ブラック',
        coreBrightness: '明るさ', coreTemperature: '色温度', coreTint: '色合い',
        coreSaturation: '彩度', coreGlow: 'グロー', coreFade: 'フェード',
        coreWbMode: 'WBモード', coreFilmPreset: 'フィルムプリセット',
        coreColorModel: 'カラーモデル', coreEnhancedProfile: '強化プロファイル',
        coreProfileStrength: 'プロファイル強度', corePreSaturation: 'プリサチュレーション',
        coreBorderBuffer: 'ボーダーバッファ', coreBorderBufferBorderValue: 'ボーダー閾値',
        coreCurvePrecision: 'カーブ精度', coreUseWebGL: 'WebGL',
        exposure: '露出微調整', contrast: 'コントラスト微調整', highlights: 'ハイライト微調整',
        shadows: 'シャドウ微調整', temperature: '色温度微調整', tint: '色合い微調整',
        vibrance: '自然な彩度', saturation: '彩度微調整',
        cyan: 'シアン', magenta: 'マゼンタ', yellow: 'イエロー',
        dustStrength: '除塵感度', dustBrushSize: 'ブラシサイズ',
      }
    };

    function getUndoLabel(label) {
      const map = undoLabelMap[currentLang] || undoLabelMap.en;
      return map[label] || label;
    }

    // Snapshot keys for Category A (lightweight, deep-copied)
    const SNAPSHOT_SCALAR_KEYS = [
      'exposure', 'contrast', 'highlights', 'shadows', 'temperature', 'tint',
      'vibrance', 'saturation', 'cyan', 'magenta', 'yellow',
      'coreFilmPreset', 'coreColorModel', 'coreEnhancedProfile', 'coreProfileStrength',
      'corePreSaturation', 'coreBorderBuffer', 'coreBorderBufferBorderValue',
      'coreBrightness', 'coreExposure', 'coreContrast', 'coreHighlights', 'coreShadows',
      'coreWhites', 'coreBlacks', 'coreWbMode', 'coreTemperature', 'coreTint',
      'coreSaturation', 'coreGlow', 'coreFade', 'coreCurvePrecision', 'coreUseWebGL',
      'wbR', 'wbG', 'wbB', 'filmType', 'filmBaseSet', 'step2Mode', 'rotationAngle',
      'currentStep',
    ];

    // Category B: heavy image data (stored by reference)
    const SNAPSHOT_REF_KEYS = [
      'originalImageData', 'croppedImageData', 'processedImageData',
      'conversionSourceImageData', 'conversionPreviewImageData', 'previewSourceImageData',
      'histogramSourceImageData', 'webglSourceImageData',
    ];

    function captureSnapshot(label) {
      const settings = {};
      for (const key of SNAPSHOT_SCALAR_KEYS) {
        settings[key] = state[key];
      }
      // Deep copy objects
      settings.filmBase = state.filmBase ? { ...state.filmBase } : null;
      settings.cropRegion = state.cropRegion ? { ...state.cropRegion } : null;
      // Deep copy curves
      settings.curves = {
        r: state.curves.r ? new Uint8Array(state.curves.r) : null,
        g: state.curves.g ? new Uint8Array(state.curves.g) : null,
        b: state.curves.b ? new Uint8Array(state.curves.b) : null,
      };
      settings.curvePoints = {
        r: state.curvePoints.r.map(p => ({ ...p })),
        g: state.curvePoints.g.map(p => ({ ...p })),
        b: state.curvePoints.b.map(p => ({ ...p })),
      };
      // Dust removal settings
      settings.dustRemoval = {
        enabled: state.dustRemoval.enabled,
        strength: state.dustRemoval.strength,
        brushSize: state.dustRemoval.brushSize,
        showMask: state.dustRemoval.showMask,
      };

      // Category B: references
      const refs = {};
      for (const key of SNAPSHOT_REF_KEYS) {
        refs[key] = state[key];
      }
      // Dust refs
      refs.dustMask = state.dustRemoval.mask;
      refs.dustInpaintedImageData = state.dustRemoval.inpaintedImageData;
      refs.dustCleanSource = state.dustRemoval.cleanSource || null;
      refs.dustState = state.dustRemoval._state;

      return { label, settings, refs };
    }

    function cancelPendingTimers() {
      if (fullUpdateTimer) { clearTimeout(fullUpdateTimer); fullUpdateTimer = null; }
      if (coreReprocessTimer) { clearTimeout(coreReprocessTimer); coreReprocessTimer = null; }
      if (step2AutoConvertTimer) { clearTimeout(step2AutoConvertTimer); step2AutoConvertTimer = null; }
      if (dustDetectionTimer) { clearTimeout(dustDetectionTimer); dustDetectionTimer = null; }
    }

    function restoreSnapshot(snapshot) {
      cancelPendingTimers();

      // Restore Category A
      const s = snapshot.settings;
      for (const key of SNAPSHOT_SCALAR_KEYS) {
        state[key] = s[key];
      }
      state.filmBase = s.filmBase ? { ...s.filmBase } : { r: 210, g: 140, b: 90 };
      state.cropRegion = s.cropRegion ? { ...s.cropRegion } : null;
      state.curves = {
        r: s.curves.r ? new Uint8Array(s.curves.r) : null,
        g: s.curves.g ? new Uint8Array(s.curves.g) : null,
        b: s.curves.b ? new Uint8Array(s.curves.b) : null,
      };
      state.curvePoints = {
        r: s.curvePoints.r.map(p => ({ ...p })),
        g: s.curvePoints.g.map(p => ({ ...p })),
        b: s.curvePoints.b.map(p => ({ ...p })),
      };
      state.dustRemoval.enabled = s.dustRemoval.enabled;
      state.dustRemoval.strength = s.dustRemoval.strength;
      state.dustRemoval.brushSize = s.dustRemoval.brushSize;
      state.dustRemoval.showMask = s.dustRemoval.showMask;

      // Restore Category B refs
      const r = snapshot.refs;
      for (const key of SNAPSHOT_REF_KEYS) {
        state[key] = r[key];
      }
      state.dustRemoval.mask = r.dustMask;
      state.dustRemoval.inpaintedImageData = r.dustInpaintedImageData;
      state.dustRemoval.cleanSource = r.dustCleanSource;
      state.dustRemoval._state = r.dustState;

      // Sync UI
      updateSlidersFromState();
      renderCurve();
      updateDustControlsVisibility();

      // Re-render
      if (state.processedImageData) {
        applyProcessedImageToState(state.processedImageData);
        if (usesSilverCoreConversion(state)) {
          rerenderWithCoreControls({ full: true }).catch(() => {});
        } else {
          updateFull();
        }
      } else {
        const sourceData = state.croppedImageData || state.originalImageData;
        if (sourceData) {
          displayNegative(sourceData);
          updateCanvasVisibility();
        }
      }
      goToStep(s.currentStep);
    }

    function pushUndo(label) {
      undoStack.push(captureSnapshot(label));
      if (undoStack.length > MAX_UNDO) undoStack.shift();
      redoStack.length = 0;
      updateUndoRedoButtons();
    }

    function performUndo() {
      if (undoStack.length === 0) {
        showToast(getLocalizedText('nothingToUndo', 'Nothing to undo'));
        return;
      }
      redoStack.push(captureSnapshot('redo'));
      const snapshot = undoStack.pop();
      restoreSnapshot(snapshot);
      const actionName = getUndoLabel(snapshot.label);
      const tmpl = getLocalizedText('undone', 'Undone: {action}');
      showToast(tmpl.replace('{action}', actionName));
      updateUndoRedoButtons();
    }

    function performRedo() {
      if (redoStack.length === 0) {
        showToast(getLocalizedText('nothingToRedo', 'Nothing to redo'));
        return;
      }
      undoStack.push(captureSnapshot('undo'));
      const snapshot = redoStack.pop();
      restoreSnapshot(snapshot);
      const actionName = getUndoLabel(snapshot.label);
      const tmpl = getLocalizedText('redone', 'Redone: {action}');
      showToast(tmpl.replace('{action}', actionName));
      updateUndoRedoButtons();
    }

    function clearUndoHistory() {
      undoStack.length = 0;
      redoStack.length = 0;
      updateUndoRedoButtons();
    }

    function updateUndoRedoButtons() {
      const undoBtn = document.getElementById('undoBtn');
      const redoBtn = document.getElementById('redoBtn');
      if (undoBtn) undoBtn.disabled = undoStack.length === 0;
      if (redoBtn) redoBtn.disabled = redoStack.length === 0;
    }

    // Initialize curves
    function initCurves(markDirty = false) {
      state.curves.r = new Uint8Array(256);
      state.curves.g = new Uint8Array(256);
      state.curves.b = new Uint8Array(256);
      // Reset control points to linear
      state.curvePoints.r = [{ x: 0, y: 0 }, { x: 255, y: 255 }];
      state.curvePoints.g = [{ x: 0, y: 0 }, { x: 255, y: 255 }];
      state.curvePoints.b = [{ x: 0, y: 0 }, { x: 255, y: 255 }];
      // Fill curves with linear values
      for (let i = 0; i < 256; i++) {
        state.curves.r[i] = i;
        state.curves.g[i] = i;
        state.curves.b[i] = i;
      }

      if (markDirty && webglState.gl) webglState.curveDirty = true;
    }
    initCurves(false);

    // ===========================================
    // Canvas & Context
    // ===========================================
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const glCanvas = document.getElementById('glCanvas');
    const canvasContainer = document.getElementById('canvasContainer');
    const canvasTransformWrapper = document.getElementById('canvasTransformWrapper');
    const zoomIndicator = document.getElementById('zoomIndicator');
    const zoomControls = document.getElementById('zoomControls');
    const ZOOM_MIN = 1;
    const ZOOM_MAX = 8;
    const previewSection = canvasContainer.closest('.preview-section');
    const beforeAfterBtn = document.getElementById('beforeAfterBtn');
    const histogramContainer = document.getElementById('histogramContainer');
    const histogramHandle = histogramContainer?.querySelector('.histogram-label') || null;
    const histogramDragHint = document.getElementById('histogramDragHint');
    const histogramCanvas = document.getElementById('histogramCanvas');
    const histogram = new Histogram(histogramCanvas);
    const HISTOGRAM_MAX_SAMPLES = 24_576;
    const HISTOGRAM_UPDATE_INTERVAL_MS = 260;
    const curveCanvas = document.getElementById('curveCanvas');
    const curveCtx = curveCanvas.getContext('2d');
    const loupe = document.getElementById('loupe');
    const loupeCanvas = document.getElementById('loupeCanvas');
    const loupeCtx = loupeCanvas.getContext('2d');
    const loupeInfo = document.getElementById('loupeInfo');

    const loupeSrcCanvas = document.createElement('canvas');
    const loupeSrcCtx = loupeSrcCanvas.getContext('2d', { willReadFrequently: true });
    const beforeAfterScratchCanvas = document.createElement('canvas');
    const beforeAfterScratchCtx = beforeAfterScratchCanvas.getContext('2d', { willReadFrequently: true });

    let transformCanvas = document.createElement('canvas');
    let transformCtx = transformCanvas.getContext('2d');

    // ===========================================
    // Workflow Management
    // ===========================================
    const debugUI = {
      fileListSetCalls: 0,
      lastFileListVisible: null,
      lastFileListReason: ''
    };

    function ensureDebugWidget() {
      if (!DEBUG_UI) return null;
      let el = document.getElementById('debugWidget');
      if (el) return el;
      el = document.createElement('div');
      el.id = 'debugWidget';
      el.className = 'debug-widget';
      document.body.appendChild(el);
      return el;
    }

    function updateDebugWidget() {
      if (!DEBUG_UI) return;
      const el = ensureDebugWidget();
      if (!el) return;

      const fileListEl = document.getElementById('fileListSection');
      const fileListDisplay = fileListEl
        ? (fileListEl.style.display || getComputedStyle(fileListEl).display)
        : 'n/a';
      const fileListRect = fileListEl ? fileListEl.getBoundingClientRect() : null;
      const fileListH = fileListRect ? Math.round(fileListRect.height) : 0;

      el.textContent =
        `BUILD ${BUILD_ID}\n` +
        `step=${state.currentStep} queue=${state.fileQueue.length} idx=${state.currentFileIndex}\n` +
        `batchSessionActive=${state.batchSessionActive} batchMode=${state.batchMode}\n` +
        `fileList display=${fileListDisplay} h=${fileListH}\n` +
        `fileList last=${debugUI.lastFileListVisible} reason=${debugUI.lastFileListReason}\n` +
        `fileList setCalls=${debugUI.fileListSetCalls}`;
    }

    function setFileListVisible(visible, reason) {
      const fileListEl = document.getElementById('fileListSection');
      if (!fileListEl) return;

      // Once a batch session is active, keep the list visible unless the session is explicitly cleared.
      if (!visible && state.batchSessionActive) {
        visible = true;
        reason = `${reason || 'unknown'} (blocked)`;
      }

      const nextDisplay = visible ? 'block' : 'none';
      if (fileListEl.style.display !== nextDisplay) {
        fileListEl.style.display = nextDisplay;
      }

      if (DEBUG_UI) {
        debugUI.fileListSetCalls++;
        debugUI.lastFileListVisible = visible;
        debugUI.lastFileListReason = reason || '';
        updateDebugWidget();
      }
    }

    function updateBatchStep3GuideVisibility() {
      renderNoviceGuide({ applyStep3Collapse: false });
    }

    function syncBatchUIState(options = {}) {
      if (state.fileQueue.length > 1) state.batchSessionActive = true;

      state.batchMode = state.batchSessionActive;
      showBatchUI(state.batchSessionActive, options.reason || 'syncBatchUIState');

      const saveSettingsBtn = document.getElementById('saveSettingsBtn');
      const applyToSelectedBtn = document.getElementById('applyToSelectedBtn');
      const showBatchStep3Actions = state.batchSessionActive && state.currentStep >= 3;
      if (saveSettingsBtn) {
        saveSettingsBtn.style.display = showBatchStep3Actions ? 'inline-flex' : 'none';
      }
      if (applyToSelectedBtn) {
        applyToSelectedBtn.style.display = showBatchStep3Actions ? 'inline-flex' : 'none';
      }

      updateCurrentFileLabel();
      updateRollReferenceUI();
      updateAutoFrameButtons();
      updateDebugWidget();
    }

    function revealBatchFileList(reason = 'revealBatchFileList') {
      if (!state.batchSessionActive) return;

      const controlsPanel = document.getElementById('controlsPanel');
      if (!controlsPanel) return;

      setFileListVisible(true, reason);
      controlsPanel.scrollTop = 0;
    }

    function getCurrentQueueItem() {
      if (state.currentFileIndex < 0 || state.currentFileIndex >= state.fileQueue.length) return null;
      return state.fileQueue[state.currentFileIndex];
    }

    function getQueueItemById(id) {
      if (!id) return null;
      return state.fileQueue.find(item => item.id === id) || null;
    }

    function hasRollReference() {
      return Boolean(state.rollReference.enabled && state.rollReference.settingsSnapshot);
    }

    function resetRollReferenceState() {
      state.rollReference.enabled = false;
      state.rollReference.sourceFileId = null;
      state.rollReference.settingsSnapshot = null;
      state.rollReference.applyLock = false;
      state.rollReference.applyCrop = false;
    }

    function updateCurrentFileLabel() {
      const label = document.getElementById('currentFileLabel');
      if (!label) return;

      const item = getCurrentQueueItem();
      if (!item || !item.file) {
        label.style.display = 'none';
        label.textContent = '';
        return;
      }

      const prefix = i18n[currentLang].currentFile || 'Current File';
      const unsavedText = item.isDirty ? ` • ${i18n[currentLang].unsaved || 'Unsaved'}` : '';
      label.textContent = `${prefix}: ${item.file.name}${unsavedText}`;
      label.style.display = 'inline-flex';
    }

    function updateRollReferenceUI() {
      const statusEl = document.getElementById('rollReferenceStatus');
      const setBtn = document.getElementById('setRollReferenceBtn');
      const applyBtn = document.getElementById('applyRollReferenceBtn');
      const clearBtn = document.getElementById('clearRollReferenceBtn');
      const useBtn = document.getElementById('useReferenceBtn');
      const lockInput = document.getElementById('lockRollReference');
      const cropInput = document.getElementById('applyCropWithReference');
      const controlsEl = document.getElementById('rollReferenceControls');
      if (!statusEl || !setBtn || !applyBtn || !clearBtn || !lockInput || !cropInput || !controlsEl) return;

      const showControls = requiresFilmBase();
      controlsEl.style.display = showControls ? 'flex' : 'none';
      if (!showControls) return;

      const hasReference = hasRollReference();
      const sourceItem = getQueueItemById(state.rollReference.sourceFileId);
      const sourceName = sourceItem ? sourceItem.file.name : 'n/a';

      statusEl.textContent = hasReference
        ? (i18n[currentLang].rollReferenceActive || 'Reference source: {file}').replace('{file}', sourceName)
        : (i18n[currentLang].rollReferenceNone || 'No roll reference set.');

      setBtn.disabled = !(state.currentStep >= 3 && state.processedImageData);
      applyBtn.disabled = !hasReference;
      clearBtn.disabled = !hasReference;
      if (useBtn) useBtn.disabled = !hasReference;
      lockInput.checked = Boolean(state.rollReference.applyLock);
      cropInput.checked = Boolean(state.rollReference.applyCrop);
      lockInput.disabled = !hasReference;
      cropInput.disabled = !hasReference;
    }

    function updateWorkflowUI() {
      const steps = ['step1', 'step2', 'step3'];
      const badge = document.getElementById('statusBadge');

      steps.forEach((stepId, idx) => {
        const stepEl = document.getElementById(stepId);
        if (!stepEl) return;
        stepEl.classList.remove('active', 'completed');
        if (idx + 1 < state.currentStep) {
          stepEl.classList.add('completed');
        } else if (idx + 1 === state.currentStep) {
          stepEl.classList.add('active');
        }
      });

      // Update badge
      badge.className = 'status-badge step' + state.currentStep;
      badge.setAttribute('data-i18n', 'step' + state.currentStep);
      badge.textContent = i18n[currentLang]['step' + state.currentStep];

      // Show/hide sections based on step
      document.getElementById('autoFrameSettingsSection').style.display =
        state.currentStep === 1 ? 'block' : 'none';
      document.getElementById('filmSettingsSection').style.display =
        state.currentStep >= 2 ? 'block' : 'none';
      updateStep3SectionVisibility();

      // Show convert button after cropping is done
      document.getElementById('convertSeparator').style.display =
        state.currentStep === 1 ? 'inline-block' : 'none';
      document.getElementById('convertBtn').style.display =
        state.currentStep === 1 ? 'inline-flex' : 'none';
      document.getElementById('convertPositiveBtn').style.display =
        state.currentStep === 1 ? 'inline-flex' : 'none';

      syncBatchUIState({ reason: 'updateWorkflowUI' });
      updateAutoFrameButtons();
      updateBeforeAfterButtonState();
      renderNoviceGuide({ applyStep3Collapse: true });
    }

    function updateStep3SectionVisibility() {
      const inStep3 = state.currentStep >= 3;
      const showCore = inStep3 && usesSilverCoreConversion(state);
      const dustSection = document.getElementById('dustRemovalSection');
      if (dustSection) dustSection.style.display = inStep3 ? 'block' : 'none';

      ['whiteBalanceSection', 'toneSection', 'colorSection', 'cmySection', 'advancedSection'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.display = showCore ? 'block' : 'none';
      });

      const additional = document.getElementById('additionalSection');
      if (additional) {
        additional.style.display = inStep3 ? 'block' : 'none';
      }
    }

    function goToStep(step) {
      state.currentStep = step;
      if (step === 2 && requiresFilmBase()) {
        setStep2Mode(suggestStep2Mode());
      }
      updateWorkflowUI();
      updateCanvasVisibility();
    }

    function getBeforeAfterReferenceImageData() {
      if (state.currentStep >= 3) {
        return state.conversionSourceImageData || state.croppedImageData || state.originalImageData || null;
      }
      return state.croppedImageData || state.originalImageData || null;
    }

    function canActivateBeforeAfter() {
      if (state.cropping || state.samplingMode) return false;
      return Boolean(getBeforeAfterReferenceImageData());
    }

    function renderBeforeAfterReference(referenceImageData) {
      if (!referenceImageData) return false;

      if (isWebGLActive()) {
        glCanvas.style.display = 'none';
        canvas.style.display = 'block';
      }

      if (canvas.width === referenceImageData.width && canvas.height === referenceImageData.height) {
        ctx.putImageData(referenceImageData, 0, 0);
      } else {
        beforeAfterScratchCanvas.width = referenceImageData.width;
        beforeAfterScratchCanvas.height = referenceImageData.height;
        beforeAfterScratchCtx.putImageData(referenceImageData, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(beforeAfterScratchCanvas, 0, 0, canvas.width, canvas.height);
      }

      renderHistogram(referenceImageData);
      return true;
    }

    function enterBeforeAfter(source = 'button') {
      if (state.beforeAfterActive) return;
      if (!canActivateBeforeAfter()) return;

      const referenceImageData = getBeforeAfterReferenceImageData();
      if (!referenceImageData) return;

      state.beforeAfterActive = true;
      state.beforeAfterSource = source;
      if (beforeAfterBtn) beforeAfterBtn.classList.add('active');
      renderBeforeAfterReference(referenceImageData);
    }

    function exitBeforeAfter() {
      if (!state.beforeAfterActive) return;

      state.beforeAfterActive = false;
      state.beforeAfterSource = null;
      if (beforeAfterBtn) beforeAfterBtn.classList.remove('active');

      if (state.currentStep >= 3 && state.processedImageData) {
        updatePreview();
        return;
      }

      const sourceData = state.croppedImageData || state.originalImageData;
      if (sourceData) {
        displayNegative(sourceData);
        renderHistogram(sourceData);
      }
    }

    function updateBeforeAfterButtonState() {
      if (!beforeAfterBtn) return;

      const enabled = canActivateBeforeAfter();
      if (!enabled && state.beforeAfterActive) {
        exitBeforeAfter();
      }
      beforeAfterBtn.disabled = !enabled;
      beforeAfterBtn.classList.toggle('active', state.beforeAfterActive);
    }

    function isEditableTarget(target) {
      if (!(target instanceof Element)) return false;
      return Boolean(target.closest('input, textarea, select, [contenteditable]'));
    }

    // ===========================================
    // Core Negative Processing Algorithm
    // ===========================================
    function sampleFilmBase(imageData, x, y, radius = 10) {
      const { width, height, data } = imageData;
      let rSum = 0, gSum = 0, bSum = 0, count = 0;

      const startX = Math.max(0, x - radius);
      const endX = Math.min(width - 1, x + radius);
      const startY = Math.max(0, y - radius);
      const endY = Math.min(height - 1, y + radius);

      for (let py = startY; py <= endY; py++) {
        for (let px = startX; px <= endX; px++) {
          const idx = (py * width + px) * 4;
          rSum += data[idx];
          gSum += data[idx + 1];
          bSum += data[idx + 2];
          count++;
        }
      }

      return {
        r: Math.round(rSum / count),
        g: Math.round(gSum / count),
        b: Math.round(bSum / count)
      };
    }

    function autoDetectFilmBase(imageData, borderBufferPct = 10) {
      const { width, height } = imageData;
      const minSide = Math.max(1, Math.min(width, height));
      const bufferPct = sanitizeNumeric(borderBufferPct, 10, 0, 30);
      const edgeBand = Math.max(1, Math.round(minSide * (bufferPct / 100)));
      const edgeOffset = Math.max(1, Math.round(edgeBand * 0.5));
      const sampleRadius = Math.max(1, Math.min(80, Math.round(edgeBand * 0.5)));

      let candidates = [];
      const regions = [
        { x: width / 2, y: edgeOffset },
        { x: width / 2, y: height - edgeOffset },
        { x: edgeOffset, y: height / 2 },
        { x: width - edgeOffset, y: height / 2 },
        { x: edgeOffset, y: edgeOffset },
        { x: width - edgeOffset, y: edgeOffset },
        { x: edgeOffset, y: height - edgeOffset },
        { x: width - edgeOffset, y: height - edgeOffset }
      ];

      for (const region of regions) {
        const sample = sampleFilmBase(imageData, Math.floor(region.x), Math.floor(region.y), sampleRadius);
        const brightness = (sample.r + sample.g + sample.b) / 3;
        candidates.push({ ...sample, brightness });
      }

      candidates.sort((a, b) => b.brightness - a.brightness);
      return { r: candidates[0].r, g: candidates[0].g, b: candidates[0].b };
    }

    // ===========================================
    // Pixel Adjustments (Optimized)
    // ===========================================
    function ensureImageDataBuffer(buffer, width, height) {
      if (buffer && buffer.width === width && buffer.height === height) return buffer;
      return new ImageData(new Uint8ClampedArray(width * height * 4), width, height);
    }

    function hue2rgb(p, q, t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }

    const channelLutR = new Uint8Array(256);
    const channelLutG = new Uint8Array(256);
    const channelLutB = new Uint8Array(256);

    function makeLinearCurveLut() {
      const curve = new Uint8Array(256);
      for (let i = 0; i < 256; i++) curve[i] = i;
      return curve;
    }

    function makeLinearCurvePoints() {
      return [{ x: 0, y: 0 }, { x: 255, y: 255 }];
    }

    function sanitizeNumeric(value, fallback, min = -Infinity, max = Infinity) {
      const n = Number(value);
      const base = Number.isFinite(n) ? n : fallback;
      if (!Number.isFinite(base)) return Number.isFinite(fallback) ? fallback : 0;
      return clampBetween(base, min, max);
    }

    function sanitizeFilmBase(input, fallback = null) {
      const source = (input && typeof input === 'object')
        ? input
        : (fallback && typeof fallback === 'object' ? fallback : { r: 210, g: 140, b: 90 });
      return {
        r: Math.round(sanitizeNumeric(source.r, 210, 1, 255)),
        g: Math.round(sanitizeNumeric(source.g, 140, 1, 255)),
        b: Math.round(sanitizeNumeric(source.b, 90, 1, 255))
      };
    }

    function sanitizeCurvePointChannel(points, fallbackPoints = null) {
      const source = Array.isArray(points) ? points : (Array.isArray(fallbackPoints) ? fallbackPoints : null);
      if (!source || source.length < 2) return makeLinearCurvePoints();

      const normalized = [];
      source.forEach((point) => {
        if (!point || typeof point !== 'object') return;
        const x = sanitizeNumeric(point.x, NaN, 0, 255);
        const y = sanitizeNumeric(point.y, NaN, 0, 255);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        normalized.push({ x: Math.round(x), y: Math.round(y) });
      });
      if (normalized.length < 2) return makeLinearCurvePoints();

      normalized.sort((a, b) => a.x - b.x);
      const deduped = [];
      normalized.forEach((point) => {
        if (!deduped.length) {
          deduped.push(point);
          return;
        }
        const last = deduped[deduped.length - 1];
        if (point.x === last.x) {
          last.y = point.y;
        } else {
          deduped.push(point);
        }
      });
      if (deduped.length < 2) return makeLinearCurvePoints();

      if (deduped[0].x !== 0) {
        deduped.unshift({ x: 0, y: deduped[0].y });
      } else {
        deduped[0].y = Math.round(sanitizeNumeric(deduped[0].y, 0, 0, 255));
      }

      const tail = deduped[deduped.length - 1];
      if (tail.x !== 255) {
        deduped.push({ x: 255, y: tail.y });
      } else {
        tail.y = Math.round(sanitizeNumeric(tail.y, 255, 0, 255));
      }

      if (deduped.length < 2 || deduped[0].x !== 0 || deduped[deduped.length - 1].x !== 255) {
        return makeLinearCurvePoints();
      }
      return deduped;
    }

    function buildCurveLutFromPoints(points) {
      const safePoints = sanitizeCurvePointChannel(points, null);
      const curve = new Uint8Array(256);
      let spline = null;
      try {
        spline = computeSpline(safePoints);
      } catch (err) {
        spline = null;
      }
      if (!spline) return makeLinearCurveLut();

      for (let i = 0; i < 256; i++) {
        const value = Math.round(spline(i));
        curve[i] = clampBetween(value, 0, 255);
      }
      return curve;
    }

    function sanitizeCurveLut(channelCurve, fallbackCurve = null) {
      if (channelCurve instanceof Uint8Array && channelCurve.length >= 256) {
        return channelCurve;
      }
      const source = (channelCurve && typeof channelCurve.length === 'number' && channelCurve.length >= 256)
        ? channelCurve
        : ((fallbackCurve && typeof fallbackCurve.length === 'number' && fallbackCurve.length >= 256)
          ? fallbackCurve
          : null);
      if (!source) return null;

      const next = new Uint8Array(256);
      for (let i = 0; i < 256; i++) {
        const value = Number(source[i]);
        if (!Number.isFinite(value)) return null;
        next[i] = clampBetween(Math.round(value), 0, 255);
      }
      return next;
    }

    function sanitizeSettings(rawSettings, options = {}) {
      const fallbackSettings = (options.fallbackSettings && typeof options.fallbackSettings === 'object')
        ? options.fallbackSettings
        : state;
      const source = (rawSettings && typeof rawSettings === 'object') ? rawSettings : {};
      const includeCurvePoints = options.includeCurvePoints !== false;
      const includeCurves = options.includeCurves !== false;

      const fallbackType = sanitizePresetType(fallbackSettings.filmType || 'color');
      const inferredType = inferFilmTypeFromLegacyPreset(source.filmPreset, fallbackType);
      const filmType = sanitizePresetType(source.filmType || inferredType || fallbackType);

      const safe = {
        cropRegion: source.cropRegion ? { ...source.cropRegion } : (fallbackSettings.cropRegion ? { ...fallbackSettings.cropRegion } : null),
        rotationAngle: normalizeAngleDegrees(sanitizeNumeric(source.rotationAngle, fallbackSettings.rotationAngle || 0, -3600, 3600)),
        autoFrameMeta: source.autoFrameMeta ? { ...source.autoFrameMeta } : (fallbackSettings.autoFrameMeta ? { ...fallbackSettings.autoFrameMeta } : null),
        filmType,
        filmBase: sanitizeFilmBase(source.filmBase, fallbackSettings.filmBase),
        lensCorrection: sanitizeLensCorrection(source.lensCorrection, fallbackSettings.lensCorrection),
        coreFilmPreset: String(source.coreFilmPreset || fallbackSettings.coreFilmPreset || 'none'),
        coreColorModel: sanitizeCoreColorModel(
          source.coreColorModel,
          sanitizeCoreColorModel(fallbackSettings.coreColorModel, 'standard')
        ),
        coreEnhancedProfile: sanitizeCoreEnhancedProfile(source.coreEnhancedProfile, sanitizeCoreEnhancedProfile(fallbackSettings.coreEnhancedProfile, 'none')),
        coreProfileStrength: sanitizeNumeric(source.coreProfileStrength, fallbackSettings.coreProfileStrength ?? 100, 0, 200),
        corePreSaturation: sanitizeNumeric(source.corePreSaturation, fallbackSettings.corePreSaturation ?? 100, 0, 200),
        coreBorderBuffer: sanitizeNumeric(source.coreBorderBuffer, fallbackSettings.coreBorderBuffer ?? 10, 0, 30),
        coreBorderBufferBorderValue: sanitizeNumeric(
          source.coreBorderBufferBorderValue,
          source.coreBorderBuffer ?? fallbackSettings.coreBorderBufferBorderValue ?? fallbackSettings.coreBorderBuffer ?? 10,
          0,
          30
        ),
        coreBrightness: sanitizeNumeric(source.coreBrightness, fallbackSettings.coreBrightness ?? 0, -100, 100),
        coreExposure: sanitizeNumeric(source.coreExposure, fallbackSettings.coreExposure ?? 0, -300, 300),
        coreContrast: sanitizeNumeric(source.coreContrast, fallbackSettings.coreContrast ?? 0, -100, 100),
        coreHighlights: sanitizeNumeric(source.coreHighlights, fallbackSettings.coreHighlights ?? 0, -100, 100),
        coreShadows: sanitizeNumeric(source.coreShadows, fallbackSettings.coreShadows ?? 0, -100, 100),
        coreWhites: sanitizeNumeric(source.coreWhites, fallbackSettings.coreWhites ?? 0, -100, 100),
        coreBlacks: sanitizeNumeric(source.coreBlacks, fallbackSettings.coreBlacks ?? 0, -100, 100),
        coreWbMode: String(source.coreWbMode || fallbackSettings.coreWbMode || 'auto'),
        coreTemperature: sanitizeNumeric(source.coreTemperature, fallbackSettings.coreTemperature ?? 0, -100, 100),
        coreTint: sanitizeNumeric(source.coreTint, fallbackSettings.coreTint ?? 0, -100, 100),
        coreSaturation: sanitizeNumeric(source.coreSaturation, fallbackSettings.coreSaturation ?? 100, 0, 200),
        coreGlow: sanitizeNumeric(source.coreGlow, fallbackSettings.coreGlow ?? 0, 0, 100),
        coreFade: sanitizeNumeric(source.coreFade, fallbackSettings.coreFade ?? 0, 0, 100),
        coreCurvePrecision: String(source.coreCurvePrecision || fallbackSettings.coreCurvePrecision || 'auto'),
        coreUseWebGL: typeof source.coreUseWebGL === 'boolean'
          ? source.coreUseWebGL
          : (typeof fallbackSettings.coreUseWebGL === 'boolean' ? fallbackSettings.coreUseWebGL : true),
        exposure: sanitizeNumeric(source.exposure, fallbackSettings.exposure ?? 0, -3, 3),
        contrast: sanitizeNumeric(source.contrast, fallbackSettings.contrast ?? 0, -100, 100),
        highlights: sanitizeNumeric(source.highlights, fallbackSettings.highlights ?? 0, -100, 100),
        shadows: sanitizeNumeric(source.shadows, fallbackSettings.shadows ?? 0, -100, 100),
        temperature: sanitizeNumeric(source.temperature, fallbackSettings.temperature ?? 0, -100, 100),
        tint: sanitizeNumeric(source.tint, fallbackSettings.tint ?? 0, -100, 100),
        vibrance: sanitizeNumeric(source.vibrance, fallbackSettings.vibrance ?? 0, -100, 100),
        saturation: sanitizeNumeric(source.saturation, fallbackSettings.saturation ?? 0, -100, 100),
        cyan: sanitizeNumeric(source.cyan, fallbackSettings.cyan ?? 0, -100, 100),
        magenta: sanitizeNumeric(source.magenta, fallbackSettings.magenta ?? 0, -100, 100),
        yellow: sanitizeNumeric(source.yellow, fallbackSettings.yellow ?? 0, -100, 100),
        wbR: sanitizeNumeric(source.wbR, fallbackSettings.wbR ?? 1, 0.5, 2),
        wbG: sanitizeNumeric(source.wbG, fallbackSettings.wbG ?? 1, 0.5, 2),
        wbB: sanitizeNumeric(source.wbB, fallbackSettings.wbB ?? 1, 0.5, 2)
      };

      if (includeCurvePoints) {
        const fallbackPoints = fallbackSettings.curvePoints || {};
        const sourcePoints = source.curvePoints || {};
        safe.curvePoints = {
          r: sanitizeCurvePointChannel(sourcePoints.r, fallbackPoints.r),
          g: sanitizeCurvePointChannel(sourcePoints.g, fallbackPoints.g),
          b: sanitizeCurvePointChannel(sourcePoints.b, fallbackPoints.b)
        };
      }

      if (includeCurves) {
        const sourceCurves = source.curves || {};
        const fallbackCurves = fallbackSettings.curves || {};
        let rCurve = sanitizeCurveLut(sourceCurves.r, fallbackCurves.r);
        let gCurve = sanitizeCurveLut(sourceCurves.g, fallbackCurves.g);
        let bCurve = sanitizeCurveLut(sourceCurves.b, fallbackCurves.b);

        if (!rCurve || !gCurve || !bCurve) {
          const curvePoints = safe.curvePoints || {
            r: sanitizeCurvePointChannel((source.curvePoints || {}).r, (fallbackSettings.curvePoints || {}).r),
            g: sanitizeCurvePointChannel((source.curvePoints || {}).g, (fallbackSettings.curvePoints || {}).g),
            b: sanitizeCurvePointChannel((source.curvePoints || {}).b, (fallbackSettings.curvePoints || {}).b)
          };
          if (!rCurve) rCurve = buildCurveLutFromPoints(curvePoints.r);
          if (!gCurve) gCurve = buildCurveLutFromPoints(curvePoints.g);
          if (!bCurve) bCurve = buildCurveLutFromPoints(curvePoints.b);
        }

        safe.curves = { r: rCurve, g: gCurve, b: bCurve };
      }

      return safe;
    }

    function getEffectiveFilmType(settings = state) {
      return sanitizePresetType(settings.filmType || 'color');
    }

    function usesSilverCoreConversion(settings = state) {
      const type = getEffectiveFilmType(settings);
      return type === 'color' || type === 'bw' || type === 'positive';
    }

    function buildCoreConversionSettings(settings = state) {
      const safe = sanitizeSettings(settings, {
        fallbackSettings: state,
        includeCurvePoints: false,
        includeCurves: false
      });

      return {
        ...safe,
        filmPreset: safe.coreFilmPreset || 'none',
        colorModel: safe.coreColorModel,
        enhancedProfile: safe.coreEnhancedProfile,
        profileStrength: safe.coreProfileStrength,
        preSaturation: safe.corePreSaturation,
        borderBuffer: safe.coreBorderBuffer,
        brightness: safe.coreBrightness,
        exposure: safe.coreExposure,
        contrast: safe.coreContrast,
        highlights: safe.coreHighlights,
        shadows: safe.coreShadows,
        whites: safe.coreWhites,
        blacks: safe.coreBlacks,
        wbMode: safe.coreWbMode,
        temperature: safe.coreTemperature,
        tint: safe.coreTint,
        saturation: safe.coreSaturation,
        glow: safe.coreGlow,
        fade: safe.coreFade,
        curvePrecision: safe.coreCurvePrecision,
        useWebGL: safe.coreUseWebGL
      };
    }

    function buildRouterSettings(settings = state) {
      return usesSilverCoreConversion(settings)
        ? buildCoreConversionSettings(settings)
        : settings;
    }

    function buildChannelLuts({
      lutR,
      lutG,
      lutB,
      curveR,
      curveG,
      curveB,
      rMult,
      gMult,
      bMult,
      contrastFactor,
      doContrast,
      doTempTint,
      tempRMult,
      tintGMult,
      tempBMult,
      doCMY,
      cmyRShift,
      cmyGShift,
      cmyBShift
    }) {
      for (let v = 0; v < 256; v++) {
        let r = v * rMult;
        let g = v * gMult;
        let b = v * bMult;

        if (doContrast) {
          r = (r - 127.5) * contrastFactor + 127.5;
          g = (g - 127.5) * contrastFactor + 127.5;
          b = (b - 127.5) * contrastFactor + 127.5;
        }

        if (doTempTint) {
          r *= tempRMult;
          g *= tintGMult;
          b *= tempBMult;
        }

        if (r < 0) r = 0; else if (r > 255) r = 255;
        if (g < 0) g = 0; else if (g > 255) g = 255;
        if (b < 0) b = 0; else if (b > 255) b = 255;

        if (doCMY) {
          r -= cmyRShift;
          g -= cmyGShift;
          b -= cmyBShift;

          if (r < 0) r = 0; else if (r > 255) r = 255;
          if (g < 0) g = 0; else if (g > 255) g = 255;
          if (b < 0) b = 0; else if (b > 255) b = 255;
        }

        lutR[v] = curveR[(r + 0.5) | 0];
        lutG[v] = curveG[(g + 0.5) | 0];
        lutB[v] = curveB[(b + 0.5) | 0];
      }
    }

    function applyAdjustmentsToBuffer(imageData, settings, output, quality = 'full') {
      const { data } = imageData;
      const outData = output.data;
      const safeSettings = sanitizeSettings(settings, {
        fallbackSettings: state,
        includeCurvePoints: false,
        includeCurves: true
      });

      const useLegacyTone = !usesSilverCoreConversion(safeSettings);

      const legacyExposure = useLegacyTone ? safeSettings.exposure : 0;
      const legacyContrast = useLegacyTone ? safeSettings.contrast : 0;
      const legacyHighlights = useLegacyTone ? safeSettings.highlights : 0;
      const legacyShadows = useLegacyTone ? safeSettings.shadows : 0;
      const legacyTemperature = useLegacyTone ? safeSettings.temperature : 0;
      const legacyTint = useLegacyTone ? safeSettings.tint : 0;
      const legacySaturation = useLegacyTone ? safeSettings.saturation : 0;

      const exposureMult = Math.pow(2, legacyExposure);
      const contrastFactor = 1 + (legacyContrast / 100);
      const tempFactor = legacyTemperature / 100;
      const tintFactor = legacyTint / 100;
      const satFactor = 1 + (legacySaturation / 100);
      const vibFactor = safeSettings.vibrance / 100;
      const highlightsFactor = legacyHighlights / 100;
      const shadowsFactor = legacyShadows / 100;

      const rMult = safeSettings.wbR * exposureMult;
      const gMult = safeSettings.wbG * exposureMult;
      const bMult = safeSettings.wbB * exposureMult;

      const tempRMult = 1 + tempFactor * 0.3;
      const tempBMult = 1 - tempFactor * 0.3;
      const tintGMult = 1 + tintFactor * 0.3;

      const cmyRShift = safeSettings.cyan * 2.55;
      const cmyGShift = safeSettings.magenta * 2.55;
      const cmyBShift = safeSettings.yellow * 2.55;

      const curveR = safeSettings.curves.r;
      const curveG = safeSettings.curves.g;
      const curveB = safeSettings.curves.b;

      const doContrast = contrastFactor !== 1;
      const doHighlights = highlightsFactor !== 0;
      const doShadows = shadowsFactor !== 0;
      const doTempTint = tempFactor !== 0 || tintFactor !== 0;
      const doHsl = satFactor !== 1 || vibFactor !== 0;
      const doCMY = cmyRShift !== 0 || cmyGShift !== 0 || cmyBShift !== 0;

      const lumaScale = 2 / 255;

      // Fast path: when adjustments are per-channel only, precompute LUTs once and do 3 lookups per pixel.
      if (!doHighlights && !doShadows && !doHsl) {
        buildChannelLuts({
          lutR: channelLutR,
          lutG: channelLutG,
          lutB: channelLutB,
          curveR,
          curveG,
          curveB,
          rMult,
          gMult,
          bMult,
          contrastFactor,
          doContrast,
          doTempTint,
          tempRMult,
          tintGMult,
          tempBMult,
          doCMY,
          cmyRShift,
          cmyGShift,
          cmyBShift
        });

        for (let i = 0; i < data.length; i += 4) {
          outData[i] = channelLutR[data[i]];
          outData[i + 1] = channelLutG[data[i + 1]];
          outData[i + 2] = channelLutB[data[i + 2]];
          outData[i + 3] = 255;
        }
        return;
      }

      for (let i = 0; i < data.length; i += 4) {
        let r = data[i] * rMult;
        let g = data[i + 1] * gMult;
        let b = data[i + 2] * bMult;

        if (doContrast) {
          r = (r - 127.5) * contrastFactor + 127.5;
          g = (g - 127.5) * contrastFactor + 127.5;
          b = (b - 127.5) * contrastFactor + 127.5;
        }

        if (doHighlights || doShadows) {
          const luma = (r * 0.299 + g * 0.587 + b * 0.114);
          if (doHighlights && luma > 127.5) {
            const mult = 1 + highlightsFactor * (luma - 127.5) * lumaScale;
            r *= mult; g *= mult; b *= mult;
          }
          if (doShadows && luma < 127.5) {
            const mult = 1 + shadowsFactor * (127.5 - luma) * lumaScale;
            r *= mult; g *= mult; b *= mult;
          }
        }

        if (doTempTint) {
          r *= tempRMult;
          b *= tempBMult;
          g *= tintGMult;
        }

        if (r < 0) r = 0; else if (r > 255) r = 255;
        if (g < 0) g = 0; else if (g > 255) g = 255;
        if (b < 0) b = 0; else if (b > 255) b = 255;

        // The old pipeline always rounded here (via an HSL round-trip),
        // so keep rounding even when saturation/vibrance is neutral.
        if (!doHsl) {
          r = (r + 0.5) | 0;
          g = (g + 0.5) | 0;
          b = (b + 0.5) | 0;
        }

        if (doHsl) {
          if (quality === 'preview') {
            // Fast approximation in RGB space (much cheaper than HSL), used only for interactive previews.
            const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
            const min = r < g ? (r < b ? r : b) : (g < b ? g : b);

            // Per-pixel saturation measure (HSV saturation) to modulate vibrance.
            const hsvSat = max <= 0 ? 0 : (max - min) / max;
            let vibScale = 1;
            if (vibFactor >= 0) vibScale = 1 + vibFactor * (1 - hsvSat);
            else vibScale = 1 + vibFactor;

            const scale = satFactor * vibScale;
            const gray = (r * 0.299 + g * 0.587 + b * 0.114);

            r = gray + (r - gray) * scale;
            g = gray + (g - gray) * scale;
            b = gray + (b - gray) * scale;

            if (r < 0) r = 0; else if (r > 255) r = 255;
            if (g < 0) g = 0; else if (g > 255) g = 255;
            if (b < 0) b = 0; else if (b > 255) b = 255;

            r = (r + 0.5) | 0;
            g = (g + 0.5) | 0;
            b = (b + 0.5) | 0;
          } else {
          let rn = r / 255;
          let gn = g / 255;
          let bn = b / 255;

          const max = rn > gn ? (rn > bn ? rn : bn) : (gn > bn ? gn : bn);
          const min = rn < gn ? (rn < bn ? rn : bn) : (gn < bn ? gn : bn);
          let h = 0;
          let s = 0;
          const l = (max + min) / 2;

          if (max !== min) {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
            else if (max === gn) h = (bn - rn) / d + 2;
            else h = (rn - gn) / d + 4;
            h /= 6;
          }

          // Saturation + vibrance adjustments (same semantics as the original HSL approach)
          s *= satFactor;
          if (vibFactor >= 0) s += (1 - s) * vibFactor;
          else s *= (1 + vibFactor);
          if (s < 0) s = 0; else if (s > 1) s = 1;

          if (s === 0) {
            const v = Math.round(l * 255);
            r = v; g = v; b = v;
          } else {
            const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;
            rn = hue2rgb(p, q, h + 1 / 3);
            gn = hue2rgb(p, q, h);
            bn = hue2rgb(p, q, h - 1 / 3);
            r = Math.round(rn * 255);
            g = Math.round(gn * 255);
            b = Math.round(bn * 255);
          }
          }
        }

        if (doCMY) {
          r -= cmyRShift;
          g -= cmyGShift;
          b -= cmyBShift;

          if (r < 0) r = 0; else if (r > 255) r = 255;
          if (g < 0) g = 0; else if (g > 255) g = 255;
          if (b < 0) b = 0; else if (b > 255) b = 255;
        }

        r = curveR[(r + 0.5) | 0];
        g = curveG[(g + 0.5) | 0];
        b = curveB[(b + 0.5) | 0];

        outData[i] = r;
        outData[i + 1] = g;
        outData[i + 2] = b;
        outData[i + 3] = 255;
      }
    }

    function buildPreviewSourceImageData(imageData) {
      const { width, height, data } = imageData;
      const totalPixels = width * height;
      // Keep interactive preview responsive on slower machines.
      const maxPixels = 250_000;

      if (totalPixels <= maxPixels) return imageData;

      const step = Math.ceil(Math.sqrt(totalPixels / maxPixels));
      const outW = Math.max(1, Math.floor(width / step));
      const outH = Math.max(1, Math.floor(height / step));

      const out = new ImageData(new Uint8ClampedArray(outW * outH * 4), outW, outH);
      const outData = out.data;

      for (let y = 0; y < outH; y++) {
        const sy = Math.min(height - 1, y * step);
        for (let x = 0; x < outW; x++) {
          const sx = Math.min(width - 1, x * step);
          const srcIdx = (sy * width + sx) * 4;
          const dstIdx = (y * outW + x) * 4;
          outData[dstIdx] = data[srcIdx];
          outData[dstIdx + 1] = data[srcIdx + 1];
          outData[dstIdx + 2] = data[srcIdx + 2];
          outData[dstIdx + 3] = 255;
        }
      }

      return out;
    }

    function buildHistogramSourceImageData(imageData) {
      if (!imageData) return null;

      const { width, height, data } = imageData;
      const totalPixels = width * height;
      const maxPixels = HISTOGRAM_MAX_SAMPLES;

      if (totalPixels <= maxPixels) return imageData;

      const step = Math.ceil(Math.sqrt(totalPixels / maxPixels));
      const outW = Math.max(1, Math.floor(width / step));
      const outH = Math.max(1, Math.floor(height / step));

      const out = new ImageData(new Uint8ClampedArray(outW * outH * 4), outW, outH);
      const outData = out.data;

      for (let y = 0; y < outH; y++) {
        const sy = Math.min(height - 1, y * step);
        for (let x = 0; x < outW; x++) {
          const sx = Math.min(width - 1, x * step);
          const srcIdx = (sy * width + sx) * 4;
          const dstIdx = (y * outW + x) * 4;
          outData[dstIdx] = data[srcIdx];
          outData[dstIdx + 1] = data[srcIdx + 1];
          outData[dstIdx + 2] = data[srcIdx + 2];
          outData[dstIdx + 3] = 255;
        }
      }

      return out;
    }

    function buildWebglSourceImageData(imageData, maxDim = 2048) {
      if (!imageData) return null;
      const { width, height, data } = imageData;
      const scale = Math.max(width / maxDim, height / maxDim, 1);
      const step = Math.ceil(scale);
      if (step <= 1) return imageData;

      const outW = Math.max(1, Math.floor(width / step));
      const outH = Math.max(1, Math.floor(height / step));
      const out = new ImageData(new Uint8ClampedArray(outW * outH * 4), outW, outH);
      const outData = out.data;

      for (let y = 0; y < outH; y++) {
        const sy = Math.min(height - 1, y * step);
        for (let x = 0; x < outW; x++) {
          const sx = Math.min(width - 1, x * step);
          const srcIdx = (sy * width + sx) * 4;
          const dstIdx = (y * outW + x) * 4;
          outData[dstIdx] = data[srcIdx];
          outData[dstIdx + 1] = data[srcIdx + 1];
          outData[dstIdx + 2] = data[srcIdx + 2];
          outData[dstIdx + 3] = 255;
        }
      }

      return out;
    }

    // ===========================================
    // Histogram (Lightroom-style)
    // ===========================================
    const HISTOGRAM_BINS = 256;
    const histogramR = new Uint32Array(HISTOGRAM_BINS);
    const histogramG = new Uint32Array(HISTOGRAM_BINS);
    const histogramB = new Uint32Array(HISTOGRAM_BINS);
    const histogramL = new Uint32Array(HISTOGRAM_BINS);
    const histogramSmoothR = new Float32Array(HISTOGRAM_BINS);
    const histogramSmoothG = new Float32Array(HISTOGRAM_BINS);
    const histogramSmoothB = new Float32Array(HISTOGRAM_BINS);
    const histogramSmoothL = new Float32Array(HISTOGRAM_BINS);
    const histogramX = new Float32Array(HISTOGRAM_BINS);
    let histogramXWidth = 0;

    function smoothHistogram(src, dst) {
      dst[0] = (src[0] * 4 + src[1] * 2 + src[2]) / 7;
      for (let i = 1; i < 255; i++) {
        dst[i] = (src[i - 1] + src[i] * 2 + src[i + 1]) * 0.25;
      }
      dst[255] = (src[253] + src[254] * 2 + src[255] * 4) / 7;
    }

    function ensureHistogramX(width) {
      if (histogramXWidth === width) return;
      const scale = (width - 1) / 255;
      for (let i = 0; i < HISTOGRAM_BINS; i++) {
        histogramX[i] = i * scale;
      }
      histogramXWidth = width;
    }

    function renderHistogram(imageData) {
      histogram.draw(imageData);
    }

    const histogramDragState = {
      active: false,
      pointerId: null,
      startPointerX: 0,
      startPointerY: 0,
      startLeft: 0,
      startTop: 0
    };

    function isHistogramDragHintDismissed() {
      return safeStorageGet(HISTOGRAM_DRAG_HINT_DISMISSED_STORAGE_KEY) === '1';
    }

    function updateHistogramDragHintVisibility() {
      if (!histogramDragHint || !histogramContainer) return;
      const shouldShow = histogramContainer.style.display !== 'none' && !isHistogramDragHintDismissed();
      histogramDragHint.classList.toggle('is-hidden', !shouldShow);
      histogramDragHint.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
    }

    function dismissHistogramDragHint() {
      if (!histogramDragHint || isHistogramDragHintDismissed()) return;
      safeStorageSet(HISTOGRAM_DRAG_HINT_DISMISSED_STORAGE_KEY, '1');
      updateHistogramDragHintVisibility();
    }

    function parseHistogramStoredPosition() {
      const raw = safeStorageGet(HISTOGRAM_POSITION_STORAGE_KEY);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        const xRatio = Number(parsed?.xRatio);
        const yRatio = Number(parsed?.yRatio);
        if (!Number.isFinite(xRatio) || !Number.isFinite(yRatio)) return null;
        return {
          xRatio: Math.max(0, Math.min(1, xRatio)),
          yRatio: Math.max(0, Math.min(1, yRatio))
        };
      } catch (err) {
        return null;
      }
    }

    function getHistogramDragBounds() {
      if (!previewSection || !histogramContainer) return null;
      const parentWidth = previewSection.clientWidth;
      const parentHeight = previewSection.clientHeight;
      const histWidth = histogramContainer.offsetWidth;
      const histHeight = histogramContainer.offsetHeight;
      if (parentWidth <= 0 || parentHeight <= 0 || histWidth <= 0 || histHeight <= 0) return null;
      return {
        maxLeft: Math.max(0, parentWidth - histWidth),
        maxTop: Math.max(0, parentHeight - histHeight)
      };
    }

    function getDefaultHistogramPosition(bounds) {
      const left = Math.min(bounds.maxLeft, 14);
      const top = Math.max(0, bounds.maxTop - 14);
      return { left, top };
    }

    function saveHistogramPosition(left, top, bounds) {
      if (!bounds) return;
      const xRatio = bounds.maxLeft > 0 ? left / bounds.maxLeft : 0;
      const yRatio = bounds.maxTop > 0 ? top / bounds.maxTop : 0;
      safeStorageSet(HISTOGRAM_POSITION_STORAGE_KEY, JSON.stringify({
        xRatio: Math.max(0, Math.min(1, xRatio)),
        yRatio: Math.max(0, Math.min(1, yRatio))
      }));
    }

    function applyHistogramPosition(left, top, options = {}) {
      if (!histogramContainer) return;
      const { persist = false } = options;
      const bounds = getHistogramDragBounds();
      if (!bounds) return;

      const clampedLeft = Math.max(0, Math.min(bounds.maxLeft, Number.isFinite(left) ? left : 0));
      const clampedTop = Math.max(0, Math.min(bounds.maxTop, Number.isFinite(top) ? top : 0));
      histogramContainer.style.left = `${Math.round(clampedLeft)}px`;
      histogramContainer.style.top = `${Math.round(clampedTop)}px`;
      histogramContainer.style.bottom = 'auto';
      histogramContainer.style.right = 'auto';

      if (persist) {
        saveHistogramPosition(clampedLeft, clampedTop, bounds);
      }
    }

    function restoreHistogramPositionOrDefault(retry = 0) {
      if (!histogramContainer) return;
      const bounds = getHistogramDragBounds();
      if (!bounds) {
        if (retry < 2) {
          requestAnimationFrame(() => restoreHistogramPositionOrDefault(retry + 1));
        }
        return;
      }

      const stored = parseHistogramStoredPosition();
      if (stored) {
        applyHistogramPosition(stored.xRatio * bounds.maxLeft, stored.yRatio * bounds.maxTop, { persist: false });
        return;
      }

      const defaults = getDefaultHistogramPosition(bounds);
      applyHistogramPosition(defaults.left, defaults.top, { persist: false });
    }

    function reclampHistogramPosition() {
      if (!histogramContainer) return;
      const currentLeft = Number.parseFloat(histogramContainer.style.left);
      const currentTop = Number.parseFloat(histogramContainer.style.top);
      if (Number.isFinite(currentLeft) && Number.isFinite(currentTop)) {
        applyHistogramPosition(currentLeft, currentTop, { persist: false });
      } else {
        restoreHistogramPositionOrDefault();
      }
    }

    function beginHistogramDrag(event) {
      if (!histogramContainer || !histogramHandle) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;

      const bounds = getHistogramDragBounds();
      if (!bounds) return;
      event.preventDefault();
      event.stopPropagation();
      dismissHistogramDragHint();

      const currentLeft = Number.parseFloat(histogramContainer.style.left);
      const currentTop = Number.parseFloat(histogramContainer.style.top);
      const defaults = getDefaultHistogramPosition(bounds);

      histogramDragState.active = true;
      histogramDragState.pointerId = event.pointerId;
      histogramDragState.startPointerX = event.clientX;
      histogramDragState.startPointerY = event.clientY;
      histogramDragState.startLeft = Number.isFinite(currentLeft) ? currentLeft : defaults.left;
      histogramDragState.startTop = Number.isFinite(currentTop) ? currentTop : defaults.top;
      histogramContainer.classList.add('dragging');

      if (typeof histogramHandle.setPointerCapture === 'function') {
        histogramHandle.setPointerCapture(event.pointerId);
      }
    }

    function moveHistogramDrag(event) {
      if (!histogramDragState.active || histogramDragState.pointerId !== event.pointerId) return;
      event.preventDefault();

      const dx = event.clientX - histogramDragState.startPointerX;
      const dy = event.clientY - histogramDragState.startPointerY;
      applyHistogramPosition(histogramDragState.startLeft + dx, histogramDragState.startTop + dy, { persist: false });
    }

    function endHistogramDrag(event) {
      if (!histogramDragState.active || histogramDragState.pointerId !== event.pointerId) return;

      histogramDragState.active = false;
      histogramDragState.pointerId = null;
      histogramContainer?.classList.remove('dragging');

      if (histogramHandle && typeof histogramHandle.hasPointerCapture === 'function' &&
          histogramHandle.hasPointerCapture(event.pointerId)) {
        histogramHandle.releasePointerCapture(event.pointerId);
      }

      const currentLeft = Number.parseFloat(histogramContainer?.style.left || '');
      const currentTop = Number.parseFloat(histogramContainer?.style.top || '');
      if (Number.isFinite(currentLeft) && Number.isFinite(currentTop)) {
        applyHistogramPosition(currentLeft, currentTop, { persist: true });
      }
    }

    function initHistogramDragging() {
      if (!histogramHandle || !histogramContainer || !previewSection) return;
      if (histogramHandle.dataset.histDragReady === '1') return;
      histogramHandle.dataset.histDragReady = '1';

      histogramHandle.addEventListener('pointerdown', beginHistogramDrag, { passive: false });
      histogramHandle.addEventListener('pointermove', moveHistogramDrag, { passive: false });
      histogramHandle.addEventListener('pointerup', endHistogramDrag);
      histogramHandle.addEventListener('pointercancel', endHistogramDrag);
    }

    // ===========================================
    // Curve Editor (Lightroom-style with control points)
    // ===========================================
    let currentCurveChannel = 'r';
    let draggingPoint = null;
    let hoveredPoint = null;

    // Monotonic cubic spline interpolation
    function computeSpline(points) {
      const n = points.length;
      if (n < 2) return (x) => x;

      // Sort points by x
      points = [...points].sort((a, b) => a.x - b.x);

      const xs = points.map(p => p.x);
      const ys = points.map(p => p.y);

      // Calculate slopes
      const dxs = [], dys = [], ms = [];
      for (let i = 0; i < n - 1; i++) {
        dxs.push(xs[i + 1] - xs[i]);
        dys.push(ys[i + 1] - ys[i]);
        ms.push(dys[i] / dxs[i]);
      }

      // Calculate degree-1 coefficients
      const c1s = [ms[0]];
      for (let i = 0; i < dxs.length - 1; i++) {
        const m = ms[i], mNext = ms[i + 1];
        if (m * mNext <= 0) {
          c1s.push(0);
        } else {
          const dx = dxs[i], dxNext = dxs[i + 1], common = dx + dxNext;
          c1s.push(3 * common / ((common + dxNext) / m + (common + dx) / mNext));
        }
      }
      c1s.push(ms[ms.length - 1]);

      // Calculate degree-2 and degree-3 coefficients
      const c2s = [], c3s = [];
      for (let i = 0; i < c1s.length - 1; i++) {
        const c1 = c1s[i], m = ms[i], invDx = 1 / dxs[i], common = c1 + c1s[i + 1] - 2 * m;
        c2s.push((m - c1 - common) * invDx);
        c3s.push(common * invDx * invDx);
      }

      // Return interpolation function
      return function(x) {
        let i = xs.length - 1;
        if (x <= xs[0]) return ys[0];
        if (x >= xs[n - 1]) return ys[n - 1];

        // Binary search
        let low = 0, high = c3s.length - 1;
        while (low <= high) {
          const mid = Math.floor((low + high) / 2);
          if (xs[mid] < x) low = mid + 1;
          else high = mid - 1;
        }
        i = Math.max(0, high);

        const diff = x - xs[i];
        return ys[i] + c1s[i] * diff + c2s[i] * diff * diff + c3s[i] * diff * diff * diff;
      };
    }

    // Update the 256-value curve from control points
    function updateCurveFromPoints(channel) {
      const points = state.curvePoints[channel];
      const curve = state.curves[channel];
      const spline = computeSpline(points);

      for (let i = 0; i < 256; i++) {
        curve[i] = Math.max(0, Math.min(255, Math.round(spline(i))));
      }

      if (webglState.gl) webglState.curveDirty = true;
    }

    function renderCurve() {
      const cw = curveCanvas.width = curveCanvas.offsetWidth * 2;
      const ch = curveCanvas.height = curveCanvas.offsetHeight * 2;

      curveCtx.fillStyle = '#111';
      curveCtx.fillRect(0, 0, cw, ch);

      // Grid lines
      curveCtx.strokeStyle = '#333';
      curveCtx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const x = (i / 4) * cw;
        const y = (i / 4) * ch;
        curveCtx.beginPath();
        curveCtx.moveTo(x, 0);
        curveCtx.lineTo(x, ch);
        curveCtx.stroke();
        curveCtx.beginPath();
        curveCtx.moveTo(0, y);
        curveCtx.lineTo(cw, y);
        curveCtx.stroke();
      }

      // Diagonal reference line
      curveCtx.strokeStyle = '#444';
      curveCtx.beginPath();
      curveCtx.moveTo(0, ch);
      curveCtx.lineTo(cw, 0);
      curveCtx.stroke();

      // Draw the curve
      const colors = { r: '#ff6b6b', g: '#69db7c', b: '#74c0fc' };
      curveCtx.strokeStyle = colors[currentCurveChannel];
      curveCtx.lineWidth = 2;
      curveCtx.beginPath();

      const curve = state.curves[currentCurveChannel];
      for (let i = 0; i < 256; i++) {
        const x = (i / 255) * cw;
        const y = ch - (curve[i] / 255) * ch;
        if (i === 0) curveCtx.moveTo(x, y);
        else curveCtx.lineTo(x, y);
      }
      curveCtx.stroke();

      // Draw control points
      const points = state.curvePoints[currentCurveChannel];
      points.forEach((point, index) => {
        const px = (point.x / 255) * cw;
        const py = ch - (point.y / 255) * ch;
        const isHovered = hoveredPoint === index;
        const isDragging = draggingPoint === index;

        // Point circle
        curveCtx.beginPath();
        curveCtx.arc(px, py, isHovered || isDragging ? 8 : 6, 0, Math.PI * 2);
        curveCtx.fillStyle = isDragging ? '#fff' : (isHovered ? colors[currentCurveChannel] : '#222');
        curveCtx.fill();
        curveCtx.strokeStyle = colors[currentCurveChannel];
        curveCtx.lineWidth = 2;
        curveCtx.stroke();
      });
    }

    function setCurvePreset(preset) {
      pushUndo('curvePreset');
      let points;
      switch (preset) {
        case 'linear':
          points = [{ x: 0, y: 0 }, { x: 255, y: 255 }];
          break;
        case 'scurve':
          points = [{ x: 0, y: 0 }, { x: 64, y: 48 }, { x: 192, y: 208 }, { x: 255, y: 255 }];
          break;
        case 'log':
          points = [{ x: 0, y: 0 }, { x: 64, y: 128 }, { x: 128, y: 192 }, { x: 255, y: 255 }];
          break;
        default:
          points = [{ x: 0, y: 0 }, { x: 255, y: 255 }];
      }
      state.curvePoints[currentCurveChannel] = points;
      updateCurveFromPoints(currentCurveChannel);
      renderCurve();
      markCurrentFileDirty();
      scheduleFullUpdate();
    }

    document.querySelectorAll('.curve-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.curve-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentCurveChannel = tab.dataset.channel;
        draggingPoint = null;
        hoveredPoint = null;
        renderCurve();
      });
    });

    document.querySelectorAll('.curve-preset-btn').forEach(btn => {
      btn.addEventListener('click', () => setCurvePreset(btn.dataset.preset));
    });

    document.getElementById('resetCurveBtn').addEventListener('click', () => {
      pushUndo('curveReset');
      // Reset ALL channels, not just the current one
      ['r', 'g', 'b'].forEach(channel => {
        state.curvePoints[channel] = [{ x: 0, y: 0 }, { x: 255, y: 255 }];
        updateCurveFromPoints(channel);
      });
      renderCurve();
      markCurrentFileDirty();
      scheduleFullUpdate();
    });

    // Get canvas position from mouse event
    function getCurvePosition(e) {
      const rect = curveCanvas.getBoundingClientRect();
      const scaleX = curveCanvas.width / rect.width;
      const scaleY = curveCanvas.height / rect.height;
      const canvasX = (e.clientX - rect.left) * scaleX;
      const canvasY = (e.clientY - rect.top) * scaleY;
      return {
        x: Math.max(0, Math.min(255, Math.round((canvasX / curveCanvas.width) * 255))),
        y: Math.max(0, Math.min(255, 255 - Math.round((canvasY / curveCanvas.height) * 255))),
        canvasX,
        canvasY
      };
    }

    // Find point near position
    function findNearPoint(canvasX, canvasY, threshold = 15) {
      const points = state.curvePoints[currentCurveChannel];
      const cw = curveCanvas.width;
      const ch = curveCanvas.height;

      for (let i = 0; i < points.length; i++) {
        const px = (points[i].x / 255) * cw;
        const py = ch - (points[i].y / 255) * ch;
        const dist = Math.sqrt((canvasX - px) ** 2 + (canvasY - py) ** 2);
        if (dist < threshold) return i;
      }
      return -1;
    }

    let curvePreUndoSnapshot = null;

    curveCanvas.addEventListener('mousedown', (e) => {
      curvePreUndoSnapshot = captureSnapshot('curveEdit');
      const pos = getCurvePosition(e);
      const nearPoint = findNearPoint(pos.canvasX, pos.canvasY);

      if (nearPoint >= 0) {
        // Start dragging existing point
        draggingPoint = nearPoint;
      } else {
        // Add new point
        const points = state.curvePoints[currentCurveChannel];
        const newPoint = { x: pos.x, y: pos.y };

        // Insert in sorted order
        let insertIndex = points.findIndex(p => p.x > pos.x);
        if (insertIndex === -1) insertIndex = points.length;
        points.splice(insertIndex, 0, newPoint);

        draggingPoint = insertIndex;
        updateCurveFromPoints(currentCurveChannel);
        markCurrentFileDirty();
      }
      renderCurve();
    });

    curveCanvas.addEventListener('mousemove', (e) => {
      const pos = getCurvePosition(e);

      if (draggingPoint !== null) {
        const points = state.curvePoints[currentCurveChannel];
        const point = points[draggingPoint];

        // Endpoints can only move vertically
        if (draggingPoint === 0) {
          point.y = pos.y;
        } else if (draggingPoint === points.length - 1) {
          point.y = pos.y;
        } else {
          // Middle points: constrain x between neighbors
          const prevX = points[draggingPoint - 1].x + 1;
          const nextX = points[draggingPoint + 1].x - 1;
          point.x = Math.max(prevX, Math.min(nextX, pos.x));
          point.y = pos.y;
        }

        updateCurveFromPoints(currentCurveChannel);
        renderCurve();
        markCurrentFileDirty();
        schedulePreviewUpdate();
      } else {
        // Update hover state
        const nearPoint = findNearPoint(pos.canvasX, pos.canvasY);
        if (nearPoint !== hoveredPoint) {
          hoveredPoint = nearPoint;
          renderCurve();
        }
        curveCanvas.style.cursor = nearPoint >= 0 ? 'grab' : 'crosshair';
      }
    });

    curveCanvas.addEventListener('mouseup', () => {
      if (draggingPoint !== null) {
        if (curvePreUndoSnapshot) {
          undoStack.push(curvePreUndoSnapshot);
          if (undoStack.length > MAX_UNDO) undoStack.shift();
          redoStack.length = 0;
          curvePreUndoSnapshot = null;
          updateUndoRedoButtons();
        }
        draggingPoint = null;
        scheduleFullUpdate();
      }
    });

    curveCanvas.addEventListener('mouseleave', () => {
      if (draggingPoint !== null) {
        if (curvePreUndoSnapshot) {
          undoStack.push(curvePreUndoSnapshot);
          if (undoStack.length > MAX_UNDO) undoStack.shift();
          redoStack.length = 0;
          curvePreUndoSnapshot = null;
          updateUndoRedoButtons();
        }
        draggingPoint = null;
        scheduleFullUpdate();
      }
      hoveredPoint = null;
      renderCurve();
    });

    // Double-click to remove point (except endpoints)
    curveCanvas.addEventListener('dblclick', (e) => {
      const pos = getCurvePosition(e);
      const nearPoint = findNearPoint(pos.canvasX, pos.canvasY);

      if (nearPoint > 0 && nearPoint < state.curvePoints[currentCurveChannel].length - 1) {
        pushUndo('curvePointDelete');
        state.curvePoints[currentCurveChannel].splice(nearPoint, 1);
        updateCurveFromPoints(currentCurveChannel);
        renderCurve();
        markCurrentFileDirty();
        scheduleFullUpdate();
      }
    });

    // Touch-friendly pointer support for iOS Safari. Keep mouse path above unchanged for PC.
    let activeCurvePointerId = null;

    curveCanvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      e.preventDefault();
      curvePreUndoSnapshot = captureSnapshot('curveEdit');

      const pos = getCurvePosition(e);
      const nearPoint = findNearPoint(pos.canvasX, pos.canvasY);

      if (nearPoint >= 0) {
        draggingPoint = nearPoint;
      } else {
        const points = state.curvePoints[currentCurveChannel];
        const newPoint = { x: pos.x, y: pos.y };
        let insertIndex = points.findIndex(p => p.x > pos.x);
        if (insertIndex === -1) insertIndex = points.length;
        points.splice(insertIndex, 0, newPoint);
        draggingPoint = insertIndex;
        updateCurveFromPoints(currentCurveChannel);
        markCurrentFileDirty();
      }

      activeCurvePointerId = e.pointerId;
      curveCanvas.setPointerCapture(e.pointerId);
      renderCurve();
    }, { passive: false });

    curveCanvas.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse') return;
      if (activeCurvePointerId !== e.pointerId || draggingPoint === null) return;
      e.preventDefault();

      const pos = getCurvePosition(e);
      const points = state.curvePoints[currentCurveChannel];
      const point = points[draggingPoint];

      if (draggingPoint === 0 || draggingPoint === points.length - 1) {
        point.y = pos.y;
      } else {
        const prevX = points[draggingPoint - 1].x + 1;
        const nextX = points[draggingPoint + 1].x - 1;
        point.x = Math.max(prevX, Math.min(nextX, pos.x));
        point.y = pos.y;
      }

      updateCurveFromPoints(currentCurveChannel);
      renderCurve();
      markCurrentFileDirty();
      schedulePreviewUpdate();
    }, { passive: false });

    function finishCurvePointerDrag(pointerId) {
      if (activeCurvePointerId !== pointerId) return;
      if (draggingPoint !== null) {
        if (curvePreUndoSnapshot) {
          undoStack.push(curvePreUndoSnapshot);
          if (undoStack.length > MAX_UNDO) undoStack.shift();
          redoStack.length = 0;
          curvePreUndoSnapshot = null;
          updateUndoRedoButtons();
        }
        draggingPoint = null;
        scheduleFullUpdate();
      }
      if (curveCanvas.hasPointerCapture(pointerId)) {
        curveCanvas.releasePointerCapture(pointerId);
      }
      activeCurvePointerId = null;
    }

    curveCanvas.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'mouse') return;
      finishCurvePointerDrag(e.pointerId);
    });

    curveCanvas.addEventListener('pointercancel', (e) => {
      if (e.pointerType === 'mouse') return;
      finishCurvePointerDrag(e.pointerId);
    });

    // ===========================================
    // Image Processing Pipeline
    // ===========================================
    // WebGL is used to keep Step 3 adjustments responsive (WB/Tone/CMY/Curves) on large scans.
    // CPU rendering is still used for fallback + batch export.

    const webglState = {
      gl: null,
      program: null,
      quadBuffer: null,
      sourceTex: null,
      curveTex: null,
      disabledByError: false,
      lastError: null,
      curveDirty: true,
      sourceDirty: true,
      sourceSize: { w: 0, h: 0 },
      maxTextureSize: 0,
      handlersAttached: false,
      locations: {
        aPos: null,
        uImage: null,
        uCurve: null,
        uWb: null,
        uExposure: null,
        uContrast: null,
        uHighlights: null,
        uShadows: null,
        uTemp: null,
        uTint: null,
        uSat: null,
        uVib: null,
        uCmy: null
      }
    };

    const webglCurveRgba = new Uint8Array(256 * 4);

    function disableWebGLByError(err) {
      const message = err && err.message ? err.message : String(err);
      if (!webglState.disabledByError) {
        console.error('WebGL render failed. Falling back to CPU preview:', message, err);
      }
      webglState.disabledByError = true;
      webglState.lastError = message;
      updateCanvasVisibility();
    }

    function compileShader(gl, type, source) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(shader) || 'Unknown shader compile error';
        gl.deleteShader(shader);
        throw new Error(info);
      }
      return shader;
    }

    function createProgram(gl, vsSource, fsSource) {
      const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
      const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
      const program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const info = gl.getProgramInfoLog(program) || 'Unknown program link error';
        gl.deleteProgram(program);
        throw new Error(info);
      }
      return program;
    }

    function initWebGLRenderer() {
      if (webglState.disabledByError) return false;
      if (webglState.gl) return true;

      let gl = null;
      try {
        gl = glCanvas.getContext('webgl', {
          alpha: false,
          depth: false,
          stencil: false,
          antialias: false,
          preserveDrawingBuffer: false,
          premultipliedAlpha: false
        });
      } catch {
        gl = null;
      }

      if (!gl) return false;

      const vsSource = `
        attribute vec2 a_pos;
        varying vec2 v_uv;
        void main() {
          v_uv = (a_pos + 1.0) * 0.5;
          gl_Position = vec4(a_pos, 0.0, 1.0);
        }
      `;

      const fsSource = `
        #ifdef GL_FRAGMENT_PRECISION_HIGH
        precision highp float;
        #else
        precision mediump float;
        #endif
        varying vec2 v_uv;
        uniform sampler2D u_image;
        uniform sampler2D u_curve;

        uniform vec3 u_wb;
        uniform float u_exposure;
        uniform float u_contrast;
        uniform float u_highlights;
        uniform float u_shadows;
        uniform float u_temp;
        uniform float u_tint;
        uniform float u_sat;
        uniform float u_vib;
        uniform vec3 u_cmy;

        float hue2rgb(float p, float q, float t) {
          if (t < 0.0) t += 1.0;
          if (t > 1.0) t -= 1.0;
          if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
          if (t < 1.0 / 2.0) return q;
          if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
          return p;
        }

        vec3 rgbToHsl(vec3 c) {
          float r = c.r, g = c.g, b = c.b;
          float maxc = max(r, max(g, b));
          float minc = min(r, min(g, b));
          float h = 0.0;
          float s = 0.0;
          float l = (maxc + minc) * 0.5;

          if (maxc != minc) {
            float d = maxc - minc;
            s = l > 0.5 ? d / (2.0 - maxc - minc) : d / (maxc + minc);

            if (maxc == r) {
              h = (g - b) / d + (g < b ? 6.0 : 0.0);
            } else if (maxc == g) {
              h = (b - r) / d + 2.0;
            } else {
              h = (r - g) / d + 4.0;
            }
            h /= 6.0;
          }

          return vec3(h, s, l);
        }

        vec3 hslToRgb(float h, float s, float l) {
          float r, g, b;
          if (s == 0.0) {
            r = g = b = l;
          } else {
            float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
            float p = 2.0 * l - q;
            r = hue2rgb(p, q, h + 1.0 / 3.0);
            g = hue2rgb(p, q, h);
            b = hue2rgb(p, q, h - 1.0 / 3.0);
          }
          return vec3(r, g, b);
        }

        vec3 applyCurves(vec3 c) {
          float rIdx = floor(c.r * 255.0 + 0.5);
          float gIdx = floor(c.g * 255.0 + 0.5);
          float bIdx = floor(c.b * 255.0 + 0.5);
          vec4 cr = texture2D(u_curve, vec2((rIdx + 0.5) / 256.0, 0.5));
          vec4 cg = texture2D(u_curve, vec2((gIdx + 0.5) / 256.0, 0.5));
          vec4 cb = texture2D(u_curve, vec2((bIdx + 0.5) / 256.0, 0.5));
          return vec3(cr.r, cg.g, cb.b);
        }

        void main() {
          vec3 c = texture2D(u_image, v_uv).rgb;

          float exposureMult = pow(2.0, u_exposure);
          c *= u_wb * exposureMult;

          c = (c - 0.5) * u_contrast + 0.5;

          float luma = dot(c, vec3(0.299, 0.587, 0.114));
          if (u_highlights != 0.0 && luma > 0.5) {
            float mult = 1.0 + u_highlights * (luma - 0.5) * 2.0;
            c *= mult;
          }
          if (u_shadows != 0.0 && luma < 0.5) {
            float mult = 1.0 + u_shadows * (0.5 - luma) * 2.0;
            c *= mult;
          }

          c.r *= (1.0 + u_temp * 0.3);
          c.b *= (1.0 - u_temp * 0.3);
          c.g *= (1.0 + u_tint * 0.3);
          c = clamp(c, 0.0, 1.0);

          if (u_sat != 1.0 || u_vib != 0.0) {
            vec3 hsl = rgbToHsl(c);
            float s = hsl.y * u_sat;
            if (u_vib >= 0.0) {
              s += (1.0 - s) * u_vib;
            } else {
              s *= (1.0 + u_vib);
            }
            hsl.y = clamp(s, 0.0, 1.0);
            c = hslToRgb(hsl.x, hsl.y, hsl.z);
          }

          vec3 cmy = vec3(1.0) - c;
          cmy = clamp(cmy + u_cmy, 0.0, 1.0);
          c = vec3(1.0) - cmy;

          c = applyCurves(c);

          gl_FragColor = vec4(c, 1.0);
        }
      `;

      try {
        webglState.program = createProgram(gl, vsSource, fsSource);
      } catch (err) {
        console.warn('WebGL shader init failed:', err);
        return false;
      }

      webglState.gl = gl;
      webglState.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0;

      if (!webglState.handlersAttached) {
        glCanvas.addEventListener('webglcontextlost', (e) => {
          e.preventDefault();
          // Mark renderer as unavailable; fall back to CPU.
          webglState.gl = null;
          webglState.program = null;
          webglState.quadBuffer = null;
          webglState.sourceTex = null;
          webglState.curveTex = null;
          webglState.sourceSize = { w: 0, h: 0 };
          webglState.maxTextureSize = 0;
          webglState.curveDirty = true;
          webglState.sourceDirty = true;
          webglState.lastError = null;
          updateCanvasVisibility();
          schedulePreviewUpdate();
        }, false);

        glCanvas.addEventListener('webglcontextrestored', () => {
          // Resources are lost; re-init lazily on next render.
          webglState.gl = null;
          webglState.program = null;
          webglState.quadBuffer = null;
          webglState.sourceTex = null;
          webglState.curveTex = null;
          webglState.sourceSize = { w: 0, h: 0 };
          webglState.maxTextureSize = 0;
          webglState.curveDirty = true;
          webglState.sourceDirty = true;
          webglState.lastError = null;
          schedulePreviewUpdate();
        }, false);

        webglState.handlersAttached = true;
      }

      // Full-screen quad
      webglState.quadBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, webglState.quadBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1,
         1, -1,
        -1,  1,
         1,  1
      ]), gl.STATIC_DRAW);

      gl.useProgram(webglState.program);

      webglState.locations.aPos = gl.getAttribLocation(webglState.program, 'a_pos');
      webglState.locations.uImage = gl.getUniformLocation(webglState.program, 'u_image');
      webglState.locations.uCurve = gl.getUniformLocation(webglState.program, 'u_curve');
      webglState.locations.uWb = gl.getUniformLocation(webglState.program, 'u_wb');
      webglState.locations.uExposure = gl.getUniformLocation(webglState.program, 'u_exposure');
      webglState.locations.uContrast = gl.getUniformLocation(webglState.program, 'u_contrast');
      webglState.locations.uHighlights = gl.getUniformLocation(webglState.program, 'u_highlights');
      webglState.locations.uShadows = gl.getUniformLocation(webglState.program, 'u_shadows');
      webglState.locations.uTemp = gl.getUniformLocation(webglState.program, 'u_temp');
      webglState.locations.uTint = gl.getUniformLocation(webglState.program, 'u_tint');
      webglState.locations.uSat = gl.getUniformLocation(webglState.program, 'u_sat');
      webglState.locations.uVib = gl.getUniformLocation(webglState.program, 'u_vib');
      webglState.locations.uCmy = gl.getUniformLocation(webglState.program, 'u_cmy');

      // Textures
      webglState.sourceTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, webglState.sourceTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      webglState.curveTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, webglState.curveTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

      // Bind samplers
      gl.uniform1i(webglState.locations.uImage, 0);
      gl.uniform1i(webglState.locations.uCurve, 1);

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);

      webglState.curveDirty = true;
      webglState.sourceDirty = true;
      webglState.lastError = null;

      return true;
    }

    function isWebGLActive() {
      if (usesSilverCoreConversion(state)) return false;
      if (state.dustRemoval.enabled && state.dustRemoval.showMask) return false;
      return !!webglState.gl && !webglState.disabledByError && state.currentStep >= 3 && !!state.processedImageData;
    }

    function resizeWebGLCanvas() {
      if (!webglState.gl) return;
      // Use pre-transform CSS dimensions to avoid bloating the buffer when zoomed
      const cssW = parseFloat(glCanvas.style.width) || 0;
      const cssH = parseFloat(glCanvas.style.height) || 0;
      if (cssW <= 0 || cssH <= 0) return;

      const dpr = window.devicePixelRatio || 1;
      let targetW = Math.max(1, Math.round(cssW * dpr));
      let targetH = Math.max(1, Math.round(cssH * dpr));

      // Limit interactive draw resolution to keep things smooth on very large displays.
      const maxDim = 2048;
      const maxCurrent = Math.max(targetW, targetH);
      if (maxCurrent > maxDim) {
        const scale = maxDim / maxCurrent;
        targetW = Math.max(1, Math.floor(targetW * scale));
        targetH = Math.max(1, Math.floor(targetH * scale));
      }

      if (glCanvas.width !== targetW) glCanvas.width = targetW;
      if (glCanvas.height !== targetH) glCanvas.height = targetH;
    }

    function getWebglSourceImageData() {
      const full = state.processedImageData;
      if (!full) return null;

      const maxTex = webglState.maxTextureSize || 0;
      const targetMaxDim = Math.min(2048, maxTex || 2048);

      let src = state.webglSourceImageData;
      if (!src || src.width !== Math.min(src.width, targetMaxDim) || src.height !== Math.min(src.height, targetMaxDim)) {
        // If cached source is missing or too large for the current device, rebuild from full-res.
        src = buildWebglSourceImageData(full, targetMaxDim);
        state.webglSourceImageData = src;
      }

      // Safety: if the result still doesn't fit (very old GPUs), force it down.
      if (maxTex && (src.width > maxTex || src.height > maxTex)) {
        src = buildWebglSourceImageData(full, maxTex);
        state.webglSourceImageData = src;
      }

      return src;
    }

    function webglUploadSource(imageData) {
      if (!webglState.gl) return;
      if (!imageData) return;

      const gl = webglState.gl;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, webglState.sourceTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        imageData.width,
        imageData.height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        imageData.data
      );
      webglState.sourceSize.w = imageData.width;
      webglState.sourceSize.h = imageData.height;
      webglState.sourceDirty = false;
    }

    function webglUploadCurves() {
      if (!webglState.gl) return;
      const gl = webglState.gl;

      for (let i = 0; i < 256; i++) {
        const idx = i * 4;
        webglCurveRgba[idx] = state.curves.r[i];
        webglCurveRgba[idx + 1] = state.curves.g[i];
        webglCurveRgba[idx + 2] = state.curves.b[i];
        webglCurveRgba[idx + 3] = 255;
      }

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, webglState.curveTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        256,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        webglCurveRgba
      );

      webglState.curveDirty = false;
    }

    function webglSetUniforms() {
      const gl = webglState.gl;
      if (!gl) return;
      const safe = sanitizeSettings(state, {
        fallbackSettings: state,
        includeCurvePoints: false,
        includeCurves: false
      });

      const useLegacyTone = !usesSilverCoreConversion(safe);

      const legacyExposure = useLegacyTone ? safe.exposure : 0;
      const legacyContrast = useLegacyTone ? safe.contrast : 0;
      const legacyHighlights = useLegacyTone ? safe.highlights : 0;
      const legacyShadows = useLegacyTone ? safe.shadows : 0;
      const legacyTemperature = useLegacyTone ? safe.temperature : 0;
      const legacyTint = useLegacyTone ? safe.tint : 0;
      const legacySaturation = useLegacyTone ? safe.saturation : 0;

      const exposure = legacyExposure;
      const contrast = 1 + (legacyContrast / 100);
      const highlights = legacyHighlights / 100;
      const shadows = legacyShadows / 100;
      const tempFactor = legacyTemperature / 100;
      const tintFactor = legacyTint / 100;
      const satFactor = 1 + (legacySaturation / 100);
      const vibFactor = safe.vibrance / 100;

      gl.uniform3f(webglState.locations.uWb, safe.wbR, safe.wbG, safe.wbB);
      gl.uniform1f(webglState.locations.uExposure, exposure);
      gl.uniform1f(webglState.locations.uContrast, contrast);
      gl.uniform1f(webglState.locations.uHighlights, highlights);
      gl.uniform1f(webglState.locations.uShadows, shadows);
      gl.uniform1f(webglState.locations.uTemp, tempFactor);
      gl.uniform1f(webglState.locations.uTint, tintFactor);
      gl.uniform1f(webglState.locations.uSat, satFactor);
      gl.uniform1f(webglState.locations.uVib, vibFactor);
      gl.uniform3f(webglState.locations.uCmy, safe.cyan / 100, safe.magenta / 100, safe.yellow / 100);
    }

    function renderWebGL() {
      if (!webglState.gl || webglState.disabledByError || !state.processedImageData) return false;

      try {
        resizeWebGLCanvas();

        const gl = webglState.gl;
        gl.viewport(0, 0, glCanvas.width, glCanvas.height);
        gl.useProgram(webglState.program);

        // Uploads if needed
        const source = getWebglSourceImageData();
        if (!source) return false;
        if (webglState.sourceDirty || webglState.sourceSize.w !== source.width || webglState.sourceSize.h !== source.height) {
          webglUploadSource(source);
        }
        if (webglState.curveDirty) {
          webglUploadCurves();
        }

        // Bind geometry
        gl.bindBuffer(gl.ARRAY_BUFFER, webglState.quadBuffer);
        gl.enableVertexAttribArray(webglState.locations.aPos);
        gl.vertexAttribPointer(webglState.locations.aPos, 2, gl.FLOAT, false, 0, 0);

        // Bind textures
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, webglState.sourceTex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, webglState.curveTex);

        webglSetUniforms();

        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        const errCode = gl.getError();
        if (errCode !== gl.NO_ERROR) {
          throw new Error(`WebGL draw error code: ${errCode}`);
        }
        return true;
      } catch (err) {
        disableWebGLByError(err);
        return false;
      }
    }

    function updateCanvasVisibility() {
      const showGL = isWebGLActive();
      glCanvas.style.display = showGL ? 'block' : 'none';
      canvas.style.display = showGL ? 'none' : 'block';
    }

    let updateScheduled = false;
    let fullUpdateTimer = null;

    const previewCanvas = document.createElement('canvas');
    const previewCtx = previewCanvas.getContext('2d', { willReadFrequently: true });
    let fullAdjustedBuffer = null;
    let previewAdjustedBuffer = null;
    let histogramAdjustedBuffer = null;
    let lastHistogramUpdateTime = 0;

    function renderHistogramForWebGL(force = false) {
      if (!state.processedImageData) return;
      const now = performance.now();
      if (!force && (now - lastHistogramUpdateTime) < HISTOGRAM_UPDATE_INTERVAL_MS) return;

      const source = state.histogramSourceImageData || state.previewSourceImageData || state.processedImageData;
      histogramAdjustedBuffer = ensureImageDataBuffer(histogramAdjustedBuffer, source.width, source.height);
      applyAdjustmentsToBuffer(source, state, histogramAdjustedBuffer, 'preview');
      renderHistogram(histogramAdjustedBuffer);
      lastHistogramUpdateTime = now;
    }

    function schedulePreviewUpdate() {
      if (!updateScheduled) {
        updateScheduled = true;
        requestAnimationFrame(() => {
          updatePreview();
          updateScheduled = false;
        });
      }
    }

    function scheduleFullUpdate() {
      if (fullUpdateTimer) clearTimeout(fullUpdateTimer);
      // Full-res CPU rendering can be expensive on large scans; debounce aggressively.
      fullUpdateTimer = setTimeout(() => {
        fullUpdateTimer = null;
        // If SilverCore mode and we were using preview-resolution, run full reprocess
        if (usesSilverCoreConversion(state) && state.conversionSourceImageData
          && state.conversionPreviewImageData && state.conversionPreviewImageData !== state.conversionSourceImageData) {
          void rerenderWithCoreControls({ full: true }).catch((err) => {
            console.error('Full reprocess from scheduleFullUpdate failed:', err);
          });
          return;
        }
        updateFull();
      }, 1200);
    }

    function updatePreview() {
      if (!state.processedImageData) return;
      if (state.beforeAfterActive) return;

      // Prefer GPU rendering in Step 3 when available.
      if (state.currentStep >= 3 && initWebGLRenderer()) {
        updateCanvasVisibility();
        if (isWebGLActive() && renderWebGL()) {
          renderHistogramForWebGL(false);
          state.lastRenderQuality = 'gl';
          return;
        }
      }

      updateCanvasVisibility();
      updatePreviewCpu();
    }

    function updatePreviewCpu() {
      if (!state.processedImageData) return;

      const source = state.previewSourceImageData || state.processedImageData;
      previewAdjustedBuffer = ensureImageDataBuffer(previewAdjustedBuffer, source.width, source.height);
      applyAdjustmentsToBuffer(source, state, previewAdjustedBuffer, 'preview');

      if (source !== state.processedImageData) {
        if (previewCanvas.width !== source.width) previewCanvas.width = source.width;
        if (previewCanvas.height !== source.height) previewCanvas.height = source.height;
        previewCtx.putImageData(previewAdjustedBuffer, 0, 0);

        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(previewCanvas, 0, 0, canvas.width, canvas.height);
        state.lastRenderQuality = 'preview';
      } else {
        ctx.putImageData(previewAdjustedBuffer, 0, 0);
        state.displayImageData = previewAdjustedBuffer;
        state.lastRenderQuality = 'full';
      }
      // Histogram updates are deferred to full renders for responsiveness.
      if (state.dustRemoval.showMask && state.dustRemoval.mask) renderDustMaskOverlay();
    }

    function updateFull() {
      if (!state.processedImageData) return;
      if (state.beforeAfterActive) return;

      // Prefer GPU rendering in Step 3 when available.
      if (state.currentStep >= 3 && initWebGLRenderer()) {
        updateCanvasVisibility();
        if (isWebGLActive() && renderWebGL()) {
          renderHistogramForWebGL(true);
          state.lastRenderQuality = 'gl';
          return;
        }
      }

      updateCanvasVisibility();
      updateFullCpu();
    }

    function updateFullCpu() {
      if (!state.processedImageData) return;

      const source = state.processedImageData;
      fullAdjustedBuffer = ensureImageDataBuffer(fullAdjustedBuffer, source.width, source.height);
      applyAdjustmentsToBuffer(source, state, fullAdjustedBuffer, 'full');
      state.displayImageData = fullAdjustedBuffer;
      ctx.putImageData(fullAdjustedBuffer, 0, 0);
      renderHistogram(fullAdjustedBuffer);

      transformCanvas.width = canvas.width;
      transformCanvas.height = canvas.height;
      transformCtx.putImageData(fullAdjustedBuffer, 0, 0);
      state.lastRenderQuality = 'full';
      if (state.dustRemoval.showMask && state.dustRemoval.mask) renderDustMaskOverlay();
    }

    function renderFullWebGL() {
      if (!webglState.gl || !state.processedImageData) return false;
      // WebGL only usable for legacy tone path (non-SilverCore)
      if (usesSilverCoreConversion(state)) return false;
      if (state.dustRemoval.enabled && state.dustRemoval.showMask) return false;

      const source = state.processedImageData;
      const gl = webglState.gl;
      const maxTex = webglState.maxTextureSize || 0;
      if (maxTex && (source.width > maxTex || source.height > maxTex)) return false;

      try {
        // Save original canvas size
        const origW = glCanvas.width;
        const origH = glCanvas.height;

        // Resize to full resolution
        glCanvas.width = source.width;
        glCanvas.height = source.height;
        gl.viewport(0, 0, source.width, source.height);
        gl.useProgram(webglState.program);

        // Upload full-res source
        webglUploadSource(source);
        webglUploadCurves();
        webglSetUniforms();

        // Bind geometry
        gl.bindBuffer(gl.ARRAY_BUFFER, webglState.quadBuffer);
        gl.enableVertexAttribArray(webglState.locations.aPos);
        gl.vertexAttribPointer(webglState.locations.aPos, 2, gl.FLOAT, false, 0, 0);

        // Bind textures
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, webglState.sourceTex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, webglState.curveTex);

        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.finish();

        // Read back pixels
        const pixels = new Uint8Array(source.width * source.height * 4);
        gl.readPixels(0, 0, source.width, source.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

        // WebGL readPixels returns Y-flipped data — flip it
        const rowSize = source.width * 4;
        const tempRow = new Uint8Array(rowSize);
        for (let y = 0; y < (source.height >> 1); y++) {
          const topOffset = y * rowSize;
          const bottomOffset = (source.height - 1 - y) * rowSize;
          tempRow.set(pixels.subarray(topOffset, topOffset + rowSize));
          pixels.set(pixels.subarray(bottomOffset, bottomOffset + rowSize), topOffset);
          pixels.set(tempRow, bottomOffset);
        }

        const imageData = new ImageData(new Uint8ClampedArray(pixels.buffer), source.width, source.height);

        // Restore canvas size
        glCanvas.width = origW;
        glCanvas.height = origH;

        // Mark source as dirty so next preview re-uploads the preview-sized texture
        webglState.sourceDirty = true;

        return imageData;
      } catch (err) {
        console.warn('WebGL full-res render failed, falling back to CPU:', err);
        return false;
      }
    }

    function ensureFullRender() {
      if (!state.processedImageData) return;

      // Try WebGL for 8-bit export (legacy tone path only)
      if (!usesSilverCoreConversion(state) && webglState.gl && !webglState.disabledByError) {
        const result = renderFullWebGL();
        if (result && result instanceof ImageData) {
          state.displayImageData = result;
          ctx.putImageData(result, 0, 0);
          renderHistogram(result);
          transformCanvas.width = canvas.width;
          transformCanvas.height = canvas.height;
          transformCtx.putImageData(result, 0, 0);
          state.lastRenderQuality = 'full';
          return;
        }
      }

      // Fallback to CPU
      updateFullCpu();
    }

    function applyProcessedImageToState(processed) {
      if (!processed) return;
      state.processedImageData = processed;
      state.previewSourceImageData = buildPreviewSourceImageData(processed);
      state.histogramSourceImageData = buildHistogramSourceImageData(state.previewSourceImageData || processed);
      state.webglSourceImageData = buildWebglSourceImageData(processed);
      if (initWebGLRenderer()) {
        webglState.sourceDirty = true;
        webglState.curveDirty = true;
      }
      canvas.width = processed.width;
      canvas.height = processed.height;
    }

    async function convertFromCurrentSource(settings = state, { preview = false } = {}) {
      const fullSource = state.conversionSourceImageData || state.croppedImageData || state.originalImageData;
      if (!fullSource) return null;
      const source = (preview && state.conversionPreviewImageData) ? state.conversionPreviewImageData : fullSource;
      return await convertFrameWithRouter({
        imageData: source,
        settings: buildRouterSettings(settings),
        options: {
          preview,
          forceFullProcess: !preview
        }
      });
    }

    let coreReprocessTimer = null;
    let coreReprocessToken = 0;
    let step2AutoConvertTimer = null;
    let step2AutoConvertToken = 0;
    let processNegativeInFlight = null;

    function canAutoConvertFromStep2() {
      if (state.currentStep < 2 || state.currentStep >= 3) return false;
      if (!usesSilverCoreConversion(state)) return false;
      const sourceData = state.croppedImageData || state.originalImageData;
      if (!sourceData) return false;
      if (requiresFilmBase(state) && !state.filmBaseSet) return false;
      if (state.samplingMode === 'filmBase' || state.cropping) return false;
      return true;
    }

    async function runAutoConvertFromStep2(options = {}) {
      const token = Number.isInteger(options.token) ? options.token : null;
      if (token !== null && token !== step2AutoConvertToken) return;
      if (!canAutoConvertFromStep2()) return;

      await processNegative();
    }

    function scheduleAutoConvertFromStep2(options = {}) {
      if (!canAutoConvertFromStep2()) return;
      const immediate = Boolean(options.immediate);
      const token = ++step2AutoConvertToken;

      if (step2AutoConvertTimer) clearTimeout(step2AutoConvertTimer);
      step2AutoConvertTimer = setTimeout(() => {
        step2AutoConvertTimer = null;
        void runAutoConvertFromStep2({ token }).catch((err) => {
          console.error('Step2 auto convert failed:', err);
        });
      }, immediate ? 0 : 70);
    }

    function scheduleSilverSourceRefresh(options = {}) {
      if (!usesSilverCoreConversion(state)) return;
      if (state.currentStep >= 3) {
        scheduleCoreReprocess({ full: false });
        return;
      }
      scheduleAutoConvertFromStep2(options);
    }

    function applyPreviewProcessedImageToState(processed) {
      if (!processed) return;
      // Only update preview-related state; leave processedImageData untouched
      // so that full-resolution export remains correct.
      state.previewSourceImageData = buildPreviewSourceImageData(processed);
      state.webglSourceImageData = buildWebglSourceImageData(processed);
      if (initWebGLRenderer()) {
        webglState.sourceDirty = true;
        webglState.curveDirty = true;
      }
      const fullW = state.processedImageData ? state.processedImageData.width : processed.width;
      const fullH = state.processedImageData ? state.processedImageData.height : processed.height;
      canvas.width = fullW;
      canvas.height = fullH;
    }

    let _coreReprocessInFlight = false;
    let _coreReprocessPending = null;

    async function rerenderWithCoreControls(options = {}) {
      const full = Boolean(options.full);
      const token = Number.isInteger(options.token) ? options.token : null;
      if (!usesSilverCoreConversion(state)) return;
      if (!state.conversionSourceImageData) return;

      // In-flight guard: if a reprocess is already running, queue the latest request
      if (_coreReprocessInFlight) {
        _coreReprocessPending = options;
        return;
      }
      _coreReprocessInFlight = true;

      try {
        if (full) {
          // Full-resolution path
          const processed = await convertFromCurrentSource(state, { preview: false });
          if (!processed) return;
          if (token !== null && token !== coreReprocessToken) return;
          applyProcessedImageToState(processed);
          updateFull();
        } else {
          // Check if preview source is actually smaller than full source
          const hasSmallPreview = state.conversionPreviewImageData
            && state.conversionPreviewImageData !== state.conversionSourceImageData;

          // Preview-resolution path: run SilverCore on small image
          const previewProcessed = await convertFromCurrentSource(state, { preview: hasSmallPreview });
          if (!previewProcessed) return;
          if (token !== null && token !== coreReprocessToken) return;

          if (hasSmallPreview) {
            // Preview source is smaller — update preview display path only
            applyPreviewProcessedImageToState(previewProcessed);
            updatePreview();
            scheduleFullUpdate();
          } else {
            // No downscaled preview (image already small) — treat as full
            applyProcessedImageToState(previewProcessed);
            updatePreview();
            // No need to schedule full update; we already processed at full resolution
          }
        }
      } finally {
        _coreReprocessInFlight = false;
        // If a new request came in while we were processing, run the latest one
        if (_coreReprocessPending) {
          const pending = _coreReprocessPending;
          _coreReprocessPending = null;
          void rerenderWithCoreControls(pending).catch((err) => {
            console.error('Core reprocess (pending) failed:', err);
          });
        }
      }
    }

    function scheduleCoreReprocess(options = {}) {
      const full = Boolean(options.full);
      if (!usesSilverCoreConversion(state)) return;
      if (!state.conversionSourceImageData || state.currentStep < 3) return;

      const token = ++coreReprocessToken;
      if (coreReprocessTimer) clearTimeout(coreReprocessTimer);
      coreReprocessTimer = setTimeout(() => {
        coreReprocessTimer = null;
        void rerenderWithCoreControls({ full, token }).catch((err) => {
          console.error('Core reprocess failed:', err);
        });
      }, full ? 70 : 80);
    }

    async function processNegative() {
      if (processNegativeInFlight) return processNegativeInFlight;

      processNegativeInFlight = (async () => {
        const sourceData = state.croppedImageData || state.originalImageData;
        if (!sourceData) return;

        const overlay = getLoadingOverlay();
        const lang = i18n[currentLang];
        await overlay.show({ title: lang.loadingConverting });

        try {
          overlay.updateProgress(10, lang.loadingConverting);
          const correctedSourceData = await applyLensCorrectionWithSettings(sourceData, state, { updateUi: true });
          invalidateSilverCoreCache();
          state.conversionSourceImageData = correctedSourceData;
          state.conversionPreviewImageData = buildPreviewSourceImageData(correctedSourceData);
          overlay.updateProgress(40, lang.loadingConverting);
          const processed = await convertFromCurrentSource(state, { preview: false });
          if (!processed) return;
          overlay.updateProgress(85, lang.loadingProcessing);
          applyProcessedImageToState(processed);
          // Reset dust removal state for new conversion
          state.dustRemoval._state = null;
          state.dustRemoval.mask = null;
          state.dustRemoval.inpaintedImageData = null;
          state.dustRemoval.particleCount = 0;
          state.dustRemoval.cleanSource = null;
          goToStep(3);
          syncBatchUIState({ reason: 'processNegative' });
          revealBatchFileList('processNegative');
          updatePreview();
          scheduleFullUpdate();
          overlay.updateProgress(100, lang.loadingComplete);
          await new Promise(r => setTimeout(r, 250));
          // Auto-run dust detection if enabled
          if (state.dustRemoval.enabled) {
            scheduleDustDetection();
          }
        } finally {
          overlay.hide();
        }
      })();

      try {
        return await processNegativeInFlight;
      } finally {
        processNegativeInFlight = null;
      }
    }

    // ===========================================
    // Dust Removal Pipeline
    // ===========================================
    let dustDetectionTimer = null;
    let dustDrawing = false;
    let dustBrushMode = 'intelligent';

    function getDustSource() {
      return state.dustRemoval.cleanSource || state.processedImageData;
    }

    function updateDustStatusUI(text) {
      const el = document.getElementById('dustStatus');
      if (el) el.textContent = text;
    }

    function updateDustControlsVisibility() {
      const controls = document.getElementById('dustRemovalControls');
      if (controls) controls.style.display = state.dustRemoval.enabled ? 'block' : 'none';
      const brushControls = document.getElementById('dustBrushControls');
      if (brushControls) brushControls.style.display = state.dustRemoval.showMask ? 'block' : 'none';
    }

    async function runDustDetection() {
      const source = getDustSource();
      if (!source) return;
      if (state.dustRemoval.processing) return;

      state.dustRemoval.processing = true;
      updateDustStatusUI(getLocalizedText('dustStatusProcessing', 'Processing...'));

      await ensureOpenCvReady();

      // Use a short timeout to let the UI update
      await new Promise(r => setTimeout(r, 10));

      try {
        // Save original source before inpainting overwrites processedImageData
        if (!state.dustRemoval.cleanSource) {
          state.dustRemoval.cleanSource = source;
        }

        const prevState = state.dustRemoval._state;
        const { mask, particleCount, _state } = prevState
          ? updateDustStrength(source, prevState, state.dustRemoval.strength)
          : detectDust(source, { strength: state.dustRemoval.strength });
        state.dustRemoval.mask = mask;
        state.dustRemoval.particleCount = particleCount;
        state.dustRemoval._state = _state;

        if (particleCount > 0) {
          const inpainted = inpaintMasked(source, mask, 3);
          state.dustRemoval.inpaintedImageData = inpainted;
          const tmpl = getLocalizedText('dustStatusDone', 'Detected {count} dust particles');
          updateDustStatusUI(tmpl.replace('{count}', String(particleCount)));
        } else {
          state.dustRemoval.inpaintedImageData = null;
          updateDustStatusUI(getLocalizedText('dustStatusNone', 'No dust detected'));
        }
      } catch (err) {
        console.error('Dust detection failed:', err);
        state.dustRemoval.mask = null;
        state.dustRemoval.inpaintedImageData = null;
        updateDustStatusUI('Error: ' + (err.message || err));
      } finally {
        state.dustRemoval.processing = false;
      }

      // Refresh display to show inpainted result
      applyDustResultToState();
      updatePreview();
      scheduleFullUpdate();
    }

    function applyDustResultToState() {
      if (!state.dustRemoval.enabled || !state.dustRemoval.inpaintedImageData) return;
      // Replace processedImageData with inpainted version for downstream adjustments
      const inpainted = state.dustRemoval.inpaintedImageData;
      applyProcessedImageToState(inpainted);
    }

    function scheduleDustDetection() {
      if (dustDetectionTimer) clearTimeout(dustDetectionTimer);
      dustDetectionTimer = setTimeout(() => {
        dustDetectionTimer = null;
        void runDustDetection();
      }, 300);
    }

    function clearDustState() {
      state.dustRemoval.mask = null;
      state.dustRemoval.inpaintedImageData = null;
      state.dustRemoval.particleCount = 0;
      state.dustRemoval._state = null;
      state.dustRemoval.cleanSource = null;
      updateDustStatusUI(getLocalizedText('dustStatusIdle', 'Ready'));
    }

    function renderDustMaskOverlay() {
      if (!state.dustRemoval.showMask || !state.dustRemoval.mask || !state.processedImageData) return;

      const { width, height } = state.processedImageData;
      const mask = state.dustRemoval.mask;

      // Draw red semi-transparent overlay on the canvas for masked areas
      const overlayData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const scaleX = width / canvas.width;
      const scaleY = height / canvas.height;

      for (let cy = 0; cy < canvas.height; cy++) {
        for (let cx = 0; cx < canvas.width; cx++) {
          const mx = Math.min(width - 1, Math.round(cx * scaleX));
          const my = Math.min(height - 1, Math.round(cy * scaleY));
          if (mask[my * width + mx] > 0) {
            const idx = (cy * canvas.width + cx) * 4;
            // Red overlay at 50% opacity
            overlayData.data[idx] = Math.min(255, overlayData.data[idx] * 0.5 + 255 * 0.5) | 0;
            overlayData.data[idx + 1] = (overlayData.data[idx + 1] * 0.5) | 0;
            overlayData.data[idx + 2] = (overlayData.data[idx + 2] * 0.5) | 0;
          }
        }
      }
      ctx.putImageData(overlayData, 0, 0);
    }

    // ── Dust Removal UI Event Handlers ───────────────────────────────────────

    document.getElementById('dustRemovalEnabled')?.addEventListener('change', function () {
      pushUndo('dustToggle');
      state.dustRemoval.enabled = this.checked;
      updateDustControlsVisibility();

      if (state.dustRemoval.enabled && state.processedImageData) {
        // Re-run detection on the original converted image (before inpainting)
        // Need to reconvert to get clean processedImageData
        scheduleDustDetection();
      } else if (!state.dustRemoval.enabled) {
        // Disabled: restore original processedImageData by reconverting
        state.dustRemoval.showMask = false;
        const showMaskCheckbox = document.getElementById('dustShowMask');
        if (showMaskCheckbox) showMaskCheckbox.checked = false;
        clearDustState();
        updateCanvasVisibility();
        void rerenderWithCoreControls({ full: true });
      }
    });

    let dustStrengthPreSnapshot = null;
    document.getElementById('dustStrength')?.addEventListener('pointerdown', function () {
      dustStrengthPreSnapshot = captureSnapshot('dustStrength');
    });
    document.getElementById('dustStrength')?.addEventListener('input', function () {
      const val = parseInt(this.value, 10);
      state.dustRemoval.strength = val;
      const numInput = document.getElementById('dustStrengthValue');
      if (numInput) numInput.value = String(val);

      if (state.dustRemoval.enabled) {
        scheduleDustDetection();
      }
    });
    document.getElementById('dustStrength')?.addEventListener('change', function () {
      if (dustStrengthPreSnapshot) {
        undoStack.push(dustStrengthPreSnapshot);
        if (undoStack.length > MAX_UNDO) undoStack.shift();
        redoStack.length = 0;
        dustStrengthPreSnapshot = null;
        updateUndoRedoButtons();
      }
    });

    document.getElementById('dustStrengthValue')?.addEventListener('change', function () {
      pushUndo('dustStrength');
      const val = Math.max(1, Math.min(10, parseInt(this.value, 10) || 3));
      this.value = String(val);
      state.dustRemoval.strength = val;
      const slider = document.getElementById('dustStrength');
      if (slider) slider.value = String(val);

      if (state.dustRemoval.enabled) {
        scheduleDustDetection();
      }
    });

    document.getElementById('dustShowMask')?.addEventListener('change', function () {
      state.dustRemoval.showMask = this.checked;
      updateDustControlsVisibility();
      updateCanvasVisibility();
      if (state.dustRemoval.showMask) {
        updatePreview();           // render image on 2D canvas first
        requestAnimationFrame(() => renderDustMaskOverlay());
      } else {
        updatePreview();           // restore normal render path (may switch back to WebGL)
      }
    });

    document.getElementById('dustBrushSize')?.addEventListener('input', function () {
      const val = parseInt(this.value, 10);
      state.dustRemoval.brushSize = val;
      const numInput = document.getElementById('dustBrushSizeValue');
      if (numInput) numInput.value = String(val);
    });

    document.getElementById('dustBrushSizeValue')?.addEventListener('change', function () {
      const val = Math.max(1, Math.min(50, parseInt(this.value, 10) || 5));
      this.value = String(val);
      state.dustRemoval.brushSize = val;
      const slider = document.getElementById('dustBrushSize');
      if (slider) slider.value = String(val);
    });

    document.getElementById('dustClearMaskBtn')?.addEventListener('click', () => {
      if (!state.dustRemoval.enabled) return;
      clearDustState();
      // Re-run fresh detection
      scheduleDustDetection();
    });

    // ── Brush drawing on canvas ──────────────────────────────────────────────

    function canvasToImageCoords(canvasX, canvasY) {
      const source = state.processedImageData;
      if (!source) return null;
      const scaleX = source.width / canvas.width;
      const scaleY = source.height / canvas.height;
      return {
        x: Math.round(canvasX * scaleX),
        y: Math.round(canvasY * scaleY)
      };
    }

    function createBrushMask(points, brushRadius, width, height) {
      const mask = new Uint8Array(width * height);
      const r = brushRadius;

      for (const pt of points) {
        const cx = pt.x, cy = pt.y;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (dx * dx + dy * dy > r * r) continue;
            const nx = cx + dx, ny = cy + dy;
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
              mask[ny * width + nx] = 255;
            }
          }
        }
      }

      // Also fill lines between consecutive points
      for (let i = 1; i < points.length; i++) {
        const p0 = points[i - 1], p1 = points[i];
        const dist = Math.sqrt((p1.x - p0.x) ** 2 + (p1.y - p0.y) ** 2);
        const steps = Math.max(1, Math.ceil(dist));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const ix = Math.round(p0.x + (p1.x - p0.x) * t);
          const iy = Math.round(p0.y + (p1.y - p0.y) * t);
          for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
              if (dx * dx + dy * dy > r * r) continue;
              const nx = ix + dx, ny = iy + dy;
              if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                mask[ny * width + nx] = 255;
              }
            }
          }
        }
      }

      return mask;
    }

    let dustBrushPoints = [];

    function onDustBrushStart(e) {
      if (!state.dustRemoval.enabled || !state.dustRemoval.showMask) return;
      if (!state.dustRemoval.mask || !state.processedImageData) return;
      if (state.samplingMode || state.cropping) return;

      e.preventDefault();
      dustDrawing = true;
      dustBrushPoints = [];

      // Determine mode
      if (e.altKey) {
        dustBrushMode = 'direct';
      } else if (e.shiftKey) {
        dustBrushMode = 'remove';
      } else {
        dustBrushMode = 'intelligent';
      }

      const target = e.currentTarget;
      const rect = target.getBoundingClientRect();
      const cx = (e.clientX - rect.left) * (canvas.width / rect.width);
      const cy = (e.clientY - rect.top) * (canvas.height / rect.height);
      const imgCoord = canvasToImageCoords(cx, cy);
      if (imgCoord) dustBrushPoints.push(imgCoord);
    }

    function onDustBrushMove(e) {
      if (!dustDrawing) return;
      const activeCanvas = isWebGLActive() ? glCanvas : canvas;
      const rect = activeCanvas.getBoundingClientRect();
      const cx = (e.clientX - rect.left) * (canvas.width / rect.width);
      const cy = (e.clientY - rect.top) * (canvas.height / rect.height);
      const imgCoord = canvasToImageCoords(cx, cy);
      if (imgCoord) dustBrushPoints.push(imgCoord);

      // Visual feedback: draw brush stroke on canvas
      if (state.dustRemoval.showMask) {
        renderDustMaskOverlay();
        // Draw brush points
        const scaleX = canvas.width / (state.processedImageData?.width || 1);
        const scaleY = canvas.height / (state.processedImageData?.height || 1);
        const r = state.dustRemoval.brushSize * scaleX;
        ctx.save();
        ctx.globalAlpha = 0.4;
        ctx.fillStyle = dustBrushMode === 'direct' ? '#ff0000'
          : dustBrushMode === 'remove' ? '#0066ff' : '#ffff00';
        for (const pt of dustBrushPoints) {
          ctx.beginPath();
          ctx.arc(pt.x * scaleX, pt.y * scaleY, r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }

    function onDustBrushEnd(e) {
      if (!dustDrawing) return;
      dustDrawing = false;

      if (dustBrushPoints.length === 0 || !state.processedImageData || !state.dustRemoval.mask) return;
      pushUndo('dustBrushStroke');

      const source = getDustSource();
      if (!source) return;

      const { width, height } = source;
      const brushMask = createBrushMask(dustBrushPoints, state.dustRemoval.brushSize, width, height);

      let newMask;
      if (dustBrushMode === 'intelligent') {
        newMask = refineMaskIntelligent(source, state.dustRemoval.mask, brushMask);
      } else if (dustBrushMode === 'direct') {
        newMask = refineMaskDirect(state.dustRemoval.mask, brushMask);
      } else {
        newMask = refineMaskRemove(state.dustRemoval.mask, brushMask);
      }

      state.dustRemoval.mask = newMask;

      // Re-inpaint with updated mask
      // We need the original pre-inpaint source.
      // Re-convert to get clean source, then re-inpaint
      const cleanSource = state.conversionSourceImageData || state.croppedImageData || state.originalImageData;
      if (cleanSource) {
        convertFromCurrentSource(state, { preview: false }).then(processed => {
          if (!processed) return;
          const inpainted = inpaintMasked(processed, newMask, 3);
          state.dustRemoval.inpaintedImageData = inpainted;

          // Count particles
          const c = window.cv;
          if (c && c.Mat) {
            try {
              const maskMat = new c.Mat(height, width, c.CV_8UC1);
              maskMat.data.set(newMask);
              const contours = new c.MatVector();
              const hierarchy = new c.Mat();
              c.findContours(maskMat, contours, hierarchy, c.RETR_EXTERNAL, c.CHAIN_APPROX_SIMPLE);
              state.dustRemoval.particleCount = contours.size();
              maskMat.delete();
              contours.delete();
              hierarchy.delete();
            } catch (_e) { /* ignore */ }
          }

          const tmpl = getLocalizedText('dustStatusDone', 'Detected {count} dust particles');
          updateDustStatusUI(tmpl.replace('{count}', String(state.dustRemoval.particleCount)));

          applyProcessedImageToState(inpainted);
          updatePreview();
          if (state.dustRemoval.showMask) {
            // Need to re-render after updatePreview finishes
            requestAnimationFrame(() => renderDustMaskOverlay());
          }
        });
      }

      dustBrushPoints = [];
    }

    // Attach brush handlers
    canvas.addEventListener('mousedown', onDustBrushStart);
    glCanvas.addEventListener('mousedown', onDustBrushStart);
    document.addEventListener('mousemove', onDustBrushMove);
    document.addEventListener('mouseup', onDustBrushEnd);

    // Ctrl+scroll to adjust brush size
    const dustWheelHandler = (e) => {
      if (!state.dustRemoval.enabled || !state.dustRemoval.showMask) return;
      if (!e.ctrlKey) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? -1 : 1;
      state.dustRemoval.brushSize = Math.max(1, Math.min(50, state.dustRemoval.brushSize + delta));
      const slider = document.getElementById('dustBrushSize');
      const numInput = document.getElementById('dustBrushSizeValue');
      if (slider) slider.value = String(state.dustRemoval.brushSize);
      if (numInput) numInput.value = String(state.dustRemoval.brushSize);
    };
    canvas.addEventListener('wheel', dustWheelHandler, { passive: false });
    glCanvas.addEventListener('wheel', dustWheelHandler, { passive: false });

    // ===========================================
    // Canvas Display
    // ===========================================
    function adjustCanvasDisplay(w, h) {
      const container = document.getElementById('canvasContainer');
      const maxWidth = container.clientWidth - 20;
      const maxHeight = container.clientHeight - 20;
      const scale = Math.min(maxWidth / w, maxHeight / h, 1);
      const cssW = (w * scale) + 'px';
      const cssH = (h * scale) + 'px';
      canvas.style.width = cssW;
      canvas.style.height = cssH;
      glCanvas.style.width = cssW;
      glCanvas.style.height = cssH;
      canvasTransformWrapper.style.width = cssW;
      canvasTransformWrapper.style.height = cssH;
      if (isWebGLActive()) resizeWebGLCanvas();
      if (state.zoomLevel > 1) {
        clampPan();
        applyZoomPanTransform();
      }
    }

    // ===========================================
    // Zoom / Pan
    // ===========================================
    function applyZoomPanTransform() {
      const z = state.zoomLevel;
      canvasTransformWrapper.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${z})`;
      if (z > 1) {
        zoomIndicator.textContent = Math.round(z * 100) + '%';
        zoomIndicator.style.display = 'block';
        canvasContainer.classList.add('zoom-pan-active');
      } else {
        zoomIndicator.style.display = 'none';
        canvasContainer.classList.remove('zoom-pan-active');
      }
    }

    function clampPan() {
      const z = state.zoomLevel;
      const wrapperW = parseFloat(canvasTransformWrapper.style.width) || 0;
      const wrapperH = parseFloat(canvasTransformWrapper.style.height) || 0;
      const containerW = canvasContainer.clientWidth;
      const containerH = canvasContainer.clientHeight;
      const scaledW = wrapperW * z;
      const scaledH = wrapperH * z;

      if (scaledW <= containerW) {
        state.panX = (containerW - scaledW) / 2;
      } else {
        const minX = containerW - scaledW;
        const maxX = 0;
        state.panX = Math.max(minX, Math.min(maxX, state.panX));
      }

      if (scaledH <= containerH) {
        state.panY = (containerH - scaledH) / 2;
      } else {
        const minY = containerH - scaledH;
        const maxY = 0;
        state.panY = Math.max(minY, Math.min(maxY, state.panY));
      }
    }

    function resetZoomPan() {
      state.zoomLevel = 1;
      state.panX = 0;
      state.panY = 0;
      state.isPanning = false;
      canvasTransformWrapper.style.transform = '';
      zoomIndicator.style.display = 'none';
      canvasContainer.classList.remove('zoom-pan-active', 'zoom-panning');
    }

    function zoomAtPoint(newZoom, clientX, clientY) {
      const oldZoom = state.zoomLevel;
      newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom));
      if (newZoom === oldZoom) return;

      const containerRect = canvasContainer.getBoundingClientRect();
      const cursorX = clientX - containerRect.left;
      const cursorY = clientY - containerRect.top;

      // Content position under cursor in pre-transform space
      const contentX = (cursorX - state.panX) / oldZoom;
      const contentY = (cursorY - state.panY) / oldZoom;

      state.zoomLevel = newZoom;
      state.panX = cursorX - contentX * newZoom;
      state.panY = cursorY - contentY * newZoom;

      clampPan();
      applyZoomPanTransform();
    }

    function canPan() {
      return state.zoomLevel > 1 && !state.cropping && !state.samplingMode;
    }

    function displayNegative(imageData) {
      resetZoomPan();
      canvas.width = imageData.width;
      canvas.height = imageData.height;
      ctx.putImageData(imageData, 0, 0);
      adjustCanvasDisplay(imageData.width, imageData.height);

      transformCanvas.width = imageData.width;
      transformCanvas.height = imageData.height;
      transformCtx.putImageData(imageData, 0, 0);
    }

    // ===========================================
    // File Loading
    // ===========================================
    async function loadFile(file) {
      const placeholder = document.getElementById('uploadPlaceholder');
      placeholder.innerHTML = `<p>${i18n[currentLang].processing}</p>`;
      const fileName = file.name.toLowerCase();
      const isRawLikeFile = ['.cr2', '.nef', '.arw', '.dng', '.raw', '.rw2', '.tif', '.tiff'].some(ext => fileName.endsWith(ext));

      const overlay = getLoadingOverlay();
      const lang = i18n[currentLang];

      try {
        if (isRawLikeFile) {
          await overlay.show({ title: lang.loadingLoading });
          overlay.updateProgress(10, lang.loadingLoading);
        }

        const arrayBuffer = await file.arrayBuffer();

        let imageData;
        let extractedRawMeta = null;

        if (isRawLikeFile) {
          overlay.updateProgress(30, lang.loadingProcessing);
          imageData = await loadRawFile(arrayBuffer, fileName, {
            onMetadata(meta) {
              extractedRawMeta = meta;
            }
          });
          overlay.updateProgress(90, lang.loadingProcessing);
        } else if (file.type === 'image/png') {
          imageData = loadPngFile(arrayBuffer);
        } else {
          imageData = await loadStandardImage(file);
        }

        if (imageData) {
          state.loadedBaseImageData = imageData;
          state.originalImageData = imageData;
          state.croppedImageData = null;
          state.cropRegion = null;
          state.rotationAngle = 0;
          state.processedImageData = null;
          state.displayImageData = null;
          invalidateSilverCoreCache();
          state.conversionSourceImageData = null;
          state.conversionPreviewImageData = null;
          state.previewSourceImageData = null;
          state.histogramSourceImageData = null;
          state.webglSourceImageData = null;
          state.lastRenderQuality = 'full';
          state.filmBaseSet = false;
          state.autoFrame.lastDiagnostics = null;
          state.rawMetadata = extractedRawMeta;
          if (webglState.gl) {
            webglState.sourceDirty = true;
            webglState.sourceSize = { w: 0, h: 0 };
          }

          if (extractedRawMeta) {
            applyLensMetadataPrefill(extractedRawMeta);
          } else {
            updateLensCorrectionUI();
          }
          displayNegative(imageData);
          showImageUI();
          goToStep(1);
          clearUndoHistory();
          updateAutoFrameDiagnosticsUI();
          syncBatchUIState({ reason: 'loadFile' });
          updateAutoFrameButtons();
        }
        if (isRawLikeFile) {
          overlay.updateProgress(100, lang.loadingComplete);
          await new Promise(r => setTimeout(r, 200));
          overlay.hide();
        }
      } catch (err) {
        overlay.hide();
        console.error('Error loading file:', err);
        const text = String(err?.message || err || '');
        const isRawSupportIssue = isRawLikeFile && /module worker|worker|webassembly|wasm/i.test(text);
        const message = isRawSupportIssue
          ? (i18n[currentLang].rawUnsupported || 'RAW decode is not supported in this Safari version. Update Safari or convert to TIFF/JPEG first.')
          : (i18n[currentLang].loadError || 'Error loading file');
        placeholder.innerHTML = `<p style="color: var(--danger);">${message}</p>`;
      }
    }

    async function loadRawFile(buffer, fileName, options = {}) {
      const onMetadata = typeof options.onMetadata === 'function' ? options.onMetadata : null;

      // Handle TIF/TIFF files directly with UTIF.js
      if (fileName.endsWith('.tif') || fileName.endsWith('.tiff')) {
        try {
          const ifds = UTIF.decode(buffer);
          UTIF.decodeImage(buffer, ifds[0]);
          const rgba = UTIF.toRGBA8(ifds[0]);
          if (onMetadata) onMetadata(null);
          return new ImageData(new Uint8ClampedArray(rgba), ifds[0].width, ifds[0].height);
        } catch (err) {
          console.error('UTIF.js failed for TIFF:', err);
          throw err;
        }
      }

      // Handle iPhone DNG (ProRaw) with UTIF.js
      if (fileName.endsWith('.dng')) {
        const textSnippet = new TextDecoder().decode(buffer.slice(0, 1000));
        if (textSnippet.includes('iPhone')) {
          try {
            const ifds = UTIF.decode(buffer);
            UTIF.decodeImage(buffer, ifds[0]);
            const rgba = UTIF.toRGBA8(ifds[0]);
            if (onMetadata) onMetadata(null);
            return new ImageData(new Uint8ClampedArray(rgba), ifds[0].width, ifds[0].height);
          } catch (err) {
            console.error('UTIF.js failed:', err);
          }
        }
      }

      let raw;
      try {
        raw = new LibRaw();
      } catch (err) {
        throw new Error(`module worker not supported: ${err?.message || err}`);
      }
      await raw.open(new Uint8Array(buffer), {
        noInterpolation: false,
        useAutoWb: true,
        useCameraWb: true,
        useCameraMatrix: 3,
        outputColor: 1,
        outputBps: 8
      });

      if (onMetadata) {
        let rawMetadata = null;
        try {
          rawMetadata = await raw.metadata(true);
        } catch (err) {
          rawMetadata = null;
        }
        onMetadata(extractRawLensMetadata(rawMetadata));
      }

      const result = await raw.imageData();
      const { width, height, data: rgbData } = result;

      const pixelCount = width * height;
      const rgbaData = new Uint8ClampedArray(pixelCount * 4);
      for (let i = 0; i < pixelCount; i++) {
        rgbaData[i * 4] = rgbData[i * 3];
        rgbaData[i * 4 + 1] = rgbData[i * 3 + 1];
        rgbaData[i * 4 + 2] = rgbData[i * 3 + 2];
        rgbaData[i * 4 + 3] = 255;
      }

      return new ImageData(rgbaData, width, height);
    }

    function loadPngFile(buffer) {
      const decoded = UPNG.decode(buffer);
      const { width, height, ctype, depth, data } = decoded;

      const channelCount = (ctype & 2 ? 3 : 1) + (ctype & 4 ? 1 : 0);
      const pixelCount = width * height;

      let raw16 = new Uint16Array(pixelCount * channelCount);
      if (depth <= 8) {
        for (let i = 0; i < raw16.length; i++) raw16[i] = data[i] * 257;
      } else {
        for (let i = 0; i < raw16.length; i++) raw16[i] = (data[2 * i] << 8) | data[2 * i + 1];
      }

      const final8 = new Uint8ClampedArray(pixelCount * 4);
      for (let i = 0; i < pixelCount; i++) {
        const idx16 = i * channelCount;
        const idx8 = i * 4;
        final8[idx8] = raw16[idx16] >>> 8;
        if (channelCount >= 3) {
          final8[idx8 + 1] = raw16[idx16 + 1] >>> 8;
          final8[idx8 + 2] = raw16[idx16 + 2] >>> 8;
        } else {
          final8[idx8 + 1] = final8[idx8];
          final8[idx8 + 2] = final8[idx8];
        }
        final8[idx8 + 3] = channelCount === 4 ? (raw16[idx16 + 3] >>> 8) : 255;
      }

      return new ImageData(final8, width, height);
    }

    async function loadStandardImage(file) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const tempCanvas = document.createElement('canvas');
          tempCanvas.width = img.width;
          tempCanvas.height = img.height;
          const tempCtx = tempCanvas.getContext('2d');
          tempCtx.drawImage(img, 0, 0);
          resolve(tempCtx.getImageData(0, 0, img.width, img.height));
        };
        img.onerror = reject;
        img.src = URL.createObjectURL(file);
      });
    }

    function showImageUI() {
      document.getElementById('uploadPlaceholder').style.display = 'none';
      document.getElementById('previewToolbar').style.display = 'flex';
      document.getElementById('histogramContainer').style.display = 'block';
      updateHistogramDragHintVisibility();
      document.getElementById('controlsPanel').style.display = 'flex';
      document.getElementById('appFooter').style.display = 'flex';

      // Show zoom controls and update i18n titles
      zoomControls.style.display = 'flex';
      const lang = i18n[currentLang] || i18n.en;
      document.getElementById('zoomInBtn').title = lang.zoomIn || 'Zoom In';
      document.getElementById('zoomOutBtn').title = lang.zoomOut || 'Zoom Out';
      document.getElementById('zoomResetBtn').title = lang.zoomReset || 'Reset Zoom';

      initHistogramDragging();
      restoreHistogramPositionOrDefault();
      updateCanvasVisibility();
      adjustCanvasDisplay(canvas.width, canvas.height);
      updateAutoFrameConfigUI();
      updateAutoFrameDiagnosticsUI();
      updateLensCorrectionUI();
      updateBeforeAfterButtonState();
    }

    // ===========================================
    // Film Base Sampling
    // ===========================================
    function requiresFilmBase(settings = state) {
      return sanitizePresetType(settings?.filmType || state.filmType || 'color') === 'color';
    }

    function suggestStep2Mode() {
      if (!requiresFilmBase()) return 'border';
      if (state.cropRegion) return 'noBorder';

      const sourceData = state.croppedImageData || state.originalImageData;
      if (!sourceData) return 'border';
      const suggestionBuffer = state.step2Mode === 'noBorder'
        ? state.coreBorderBufferBorderValue
        : state.coreBorderBuffer;
      const sample = autoDetectFilmBase(sourceData, suggestionBuffer);
      const orangeBias = (sample.r - sample.b) + ((sample.r - sample.g) * 0.5);
      return orangeBias > 10 ? 'border' : 'noBorder';
    }

    function setStep2Mode(mode) {
      const nextMode = mode === 'noBorder' ? 'noBorder' : 'border';
      if (requiresFilmBase()) {
        if (nextMode === 'noBorder') {
          if (state.step2Mode !== 'noBorder') {
            state.coreBorderBufferBorderValue = sanitizeNumeric(state.coreBorderBuffer, 10, 0, 30);
          } else {
            state.coreBorderBufferBorderValue = sanitizeNumeric(state.coreBorderBufferBorderValue, 10, 0, 30);
          }
          state.coreBorderBuffer = 0;
        } else {
          const restoredBuffer = sanitizeNumeric(state.coreBorderBufferBorderValue, 10, 0, 30);
          state.coreBorderBufferBorderValue = restoredBuffer;
          state.coreBorderBuffer = restoredBuffer;
        }
      }

      state.step2Mode = nextMode;
      const borderBtn = document.getElementById('step2ModeBorderBtn');
      const noBorderBtn = document.getElementById('step2ModeNoBorderBtn');
      if (borderBtn) borderBtn.classList.toggle('active', state.step2Mode === 'border');
      if (noBorderBtn) noBorderBtn.classList.toggle('active', state.step2Mode === 'noBorder');
      syncSliderFromState('coreBorderBuffer');
      updateFilmModeUI();
    }

    function applyRollReferenceToCurrentForStep2() {
      if (!hasRollReference()) return false;
      const ref = state.rollReference.settingsSnapshot;
      if (!ref) return false;

      state.filmType = sanitizePresetType(ref.filmType || inferFilmTypeFromLegacyPreset(ref.filmPreset, 'color'));
      state.filmBase = { ...ref.filmBase };
      state.filmBaseSet = true;
      if (ref.lensCorrection) {
        const safeLens = sanitizeLensCorrection(ref.lensCorrection, state.lensCorrection);
        state.lensCorrection.enabled = Boolean(safeLens.enabled);
        state.lensCorrection.selectedLens = safeLens.selectedLens ? { ...safeLens.selectedLens } : null;
        state.lensCorrection.params = { ...safeLens.params };
        state.lensCorrection.modes = { ...safeLens.modes };
        state.lensCorrection.lastError = safeLens.lastError || '';
        if (state.lensCorrection.selectedLens) {
          state.lensCorrection.search.lensModel = state.lensCorrection.selectedLens.model || state.lensCorrection.search.lensModel;
          state.lensCorrection.search.lensMaker = state.lensCorrection.selectedLens.maker || state.lensCorrection.search.lensMaker;
        }
      }

      updateSlidersFromState();
      updateLensCorrectionUI();
      updateFilmBasePreview();
      updateStep2GuideCard();
      markCurrentFileDirty();
      return true;
    }

    function buildNoviceGuideViewModel() {
      const filmType = sanitizePresetType(state.filmType || 'color');
      const inBatch = Boolean(state.batchSessionActive);
      const model = {
        phaseKey: 'noviceGuidePhaseStep1',
        primaryKey: 'noviceGuidePrimaryStep1',
        checklistKeys: ['noviceGuideChecklistStep1Crop', 'noviceGuideChecklistStep1Next'],
        statusKey: '',
        warningKey: '',
        recommendedActionIds: []
      };

      if (state.currentStep <= 1) {
        model.recommendedActionIds = state.cropRegion
          ? ['convertBtn']
          : ['autoFrameBtn', 'cropBtn'];
        return model;
      }

      if (state.currentStep === 2) {
        model.phaseKey = 'noviceGuidePhaseStep2';
        if (filmType === 'color') {
          const isNoBorder = state.step2Mode === 'noBorder';
          const hasReference = hasRollReference();
          if (isNoBorder) {
            model.primaryKey = 'noviceGuidePrimaryStep2ColorNoBorder';
            model.checklistKeys = [
              'noviceGuideChecklistStep2ColorNoBorderAuto',
              'noviceGuideChecklistStep2ColorNoBorderReference'
            ];
            model.recommendedActionIds = hasReference
              ? ['useReferenceBtn', 'autoDetectBtn']
              : ['autoDetectBtn'];
            if (!state.filmBaseSet && !hasReference) {
              model.warningKey = 'noviceGuideWarningReferenceMissing';
            }
          } else {
            model.primaryKey = 'noviceGuidePrimaryStep2ColorBorder';
            model.checklistKeys = [
              'noviceGuideChecklistStep2ColorBorderSample',
              'noviceGuideChecklistStep2ColorBorderFallback'
            ];
            model.recommendedActionIds = ['sampleBaseBtn', 'autoDetectBtn'];
            if (!state.filmBaseSet) {
              model.warningKey = 'noviceGuideWarningMaskUnset';
            }
          }

          if (state.filmBaseSet) {
            model.statusKey = 'noviceGuideStatusAutoToStep3Ready';
            model.recommendedActionIds = ['applyConvertBtn'];
          } else {
            model.statusKey = 'noviceGuideStatusAutoToStep3';
          }
          return model;
        }

        if (filmType === 'bw') {
          model.primaryKey = 'noviceGuidePrimaryStep2Bw';
          model.checklistKeys = [
            'noviceGuideChecklistStep2BwSelect',
            'noviceGuideChecklistStep2BwAuto'
          ];
          model.statusKey = 'noviceGuideStatusAutoToStep3';
          model.recommendedActionIds = ['applyConvertBtn'];
          return model;
        }

        model.primaryKey = 'noviceGuidePrimaryStep2Positive';
        model.checklistKeys = ['noviceGuideChecklistStep2PositiveConvert'];
        model.statusKey = 'noviceGuideStatusManualConvert';
        model.recommendedActionIds = ['applyConvertBtn'];
        return model;
      }

      model.phaseKey = 'noviceGuidePhaseStep3';
      model.primaryKey = inBatch
        ? 'noviceGuidePrimaryStep3Batch'
        : 'noviceGuidePrimaryStep3Single';
      model.checklistKeys = inBatch
        ? [
            'noviceGuideChecklistStep3BatchSave',
            'noviceGuideChecklistStep3BatchApply',
            'noviceGuideChecklistStep3BatchExport'
          ]
        : [
            'noviceGuideChecklistStep3SampleGray',
            'noviceGuideChecklistStep3Export'
          ];
      model.statusKey = step3GuideCollapsedOnce ? 'noviceGuideStatusStep3Collapsed' : '';
      model.recommendedActionIds = inBatch
        ? ['saveSettingsBtn', 'applyToSelectedBtn', 'exportBtn']
        : ['sampleWBBtn', 'exportBtn'];
      return model;
    }

    function renderNoviceGuide(options = {}) {
      const { applyStep3Collapse = false } = options;
      const card = document.getElementById('noviceGuideCard');
      const phaseEl = document.getElementById('noviceGuidePhase');
      const primaryEl = document.getElementById('noviceGuidePrimary');
      const checklistEl = document.getElementById('noviceGuideChecklist');
      const statusEl = document.getElementById('noviceGuideStatus');
      const warningEl = document.getElementById('noviceGuideWarning');
      if (!card || !phaseEl || !primaryEl || !checklistEl || !statusEl || !warningEl) return;

      if (!guideModeEnabled) {
        card.style.display = 'none';
        clearRecommendedActions();
        return;
      }
      card.style.display = 'flex';

      if (applyStep3Collapse) {
        collapseStep3SectionsForGuideIfNeeded();
      }

      const model = buildNoviceGuideViewModel();
      phaseEl.textContent = getLocalizedText(model.phaseKey, '');
      primaryEl.textContent = getLocalizedText(model.primaryKey, '');

      checklistEl.innerHTML = '';
      model.checklistKeys.forEach(key => {
        const text = getLocalizedText(key, '');
        if (!text) return;
        const item = document.createElement('li');
        item.textContent = text;
        checklistEl.appendChild(item);
      });

      const statusText = model.statusKey ? getLocalizedText(model.statusKey, '') : '';
      statusEl.textContent = statusText;
      statusEl.style.display = statusText ? 'block' : 'none';

      const warningText = model.warningKey ? getLocalizedText(model.warningKey, '') : '';
      warningEl.textContent = warningText;
      warningEl.style.display = warningText ? 'block' : 'none';

      setRecommendedActions(model.recommendedActionIds);
    }

    function updateStep2GuideCard() {
      renderNoviceGuide({ applyStep3Collapse: false });
    }

    function updateFilmModeUI() {
      const filmBaseControls = document.getElementById('filmBaseControls');
      const positiveFilmInfo = document.getElementById('positiveFilmInfo');
      const modeToggle = document.getElementById('step2ModeToggle');
      const step2CoreColorModelControl = document.getElementById('coreColorModelStep2Control');
      const sampleBaseBtn = document.getElementById('sampleBaseBtn');
      const autoDetectBtn = document.getElementById('autoDetectBtn');
      const useReferenceBtn = document.getElementById('useReferenceBtn');
      const showFilmBase = requiresFilmBase();
      const showStep2CoreModel = usesSilverCoreConversion(state);
      updateStep3SectionVisibility();

      modeToggle.style.display = showFilmBase ? 'flex' : 'none';
      filmBaseControls.style.display = showFilmBase ? 'block' : 'none';
      positiveFilmInfo.style.display = showFilmBase ? 'none' : 'block';
      if (step2CoreColorModelControl) {
        step2CoreColorModelControl.style.display = showStep2CoreModel ? 'block' : 'none';
      }

      if (!showFilmBase) {
        if (state.samplingMode === 'filmBase') {
          state.samplingMode = null;
          sampleBaseBtn.classList.remove('active');
          canvas.style.cursor = 'default';
          glCanvas.style.cursor = 'default';
          hideLoupe();
        }
        document.getElementById('filmBasePreview').style.display = 'none';
        updateRollReferenceUI();
        updateStep2GuideCard();
        updateLensCorrectionUI();
        updateBeforeAfterButtonState();
        return;
      }

      if (state.samplingMode === 'filmBase' && state.step2Mode === 'noBorder') {
        state.samplingMode = null;
        sampleBaseBtn.classList.remove('active');
        canvas.style.cursor = 'default';
        glCanvas.style.cursor = 'default';
        hideLoupe();
      }

      sampleBaseBtn.style.display = state.step2Mode === 'border' ? 'inline-flex' : 'none';
      autoDetectBtn.style.display = 'inline-flex';
      useReferenceBtn.style.display = state.step2Mode === 'noBorder' ? 'inline-flex' : 'none';

      updateFilmBasePreview();
      updateRollReferenceUI();
      updateStep2GuideCard();
      updateLensCorrectionUI();
      updateBeforeAfterButtonState();
    }

    function updateFilmBasePreview() {
      const preview = document.getElementById('filmBasePreview');
      const colorBox = document.getElementById('filmBaseColor');
      const values = document.getElementById('filmBaseValues');

      if (!requiresFilmBase()) {
        preview.style.display = 'none';
        return;
      }

      if (state.filmBaseSet) {
        preview.style.display = 'flex';
        colorBox.style.backgroundColor = `rgb(${state.filmBase.r}, ${state.filmBase.g}, ${state.filmBase.b})`;
        values.textContent = `R: ${state.filmBase.r} G: ${state.filmBase.g} B: ${state.filmBase.b}`;
      } else {
        preview.style.display = 'none';
      }
    }

    document.getElementById('sampleBaseBtn').addEventListener('click', () => {
      if (!requiresFilmBase()) return;
      if (state.step2Mode !== 'border') return;
      exitBeforeAfter();
      state.samplingMode = 'filmBase';
      document.getElementById('sampleBaseBtn').classList.add('active');
      canvas.style.cursor = 'crosshair';
      glCanvas.style.cursor = 'crosshair';
      updateBeforeAfterButtonState();
    });

    document.getElementById('autoDetectBtn').addEventListener('click', () => {
      if (!requiresFilmBase()) return;
      const sourceData = state.croppedImageData || state.originalImageData;
      if (!sourceData) return;
      pushUndo('autoDetectBase');
      state.filmBase = autoDetectFilmBase(sourceData, state.coreBorderBuffer);
      state.filmBaseSet = true;
      updateFilmBasePreview();
      updateStep2GuideCard();
      markCurrentFileDirty();
      scheduleSilverSourceRefresh({ immediate: true });
    });

    document.getElementById('useReferenceBtn').addEventListener('click', () => {
      if (!hasRollReference()) {
        alert(i18n[currentLang].rollReferenceMissing || 'No roll reference is set.');
        return;
      }
      if (applyRollReferenceToCurrentForStep2()) {
        updateStep2GuideCard();
        scheduleSilverSourceRefresh({ immediate: true });
        alert(i18n[currentLang].rollReferenceAppliedCurrent || 'Roll reference applied to current image.');
      }
    });

    document.getElementById('applyConvertBtn').addEventListener('click', () => {
      if (requiresFilmBase() && !state.filmBaseSet) {
        const usedReference = state.step2Mode === 'noBorder' ? applyRollReferenceToCurrentForStep2() : false;
        if (!usedReference) {
          // Auto detect if not set
          const sourceData = state.croppedImageData || state.originalImageData;
          state.filmBase = autoDetectFilmBase(sourceData, state.coreBorderBuffer);
          state.filmBaseSet = true;
          updateFilmBasePreview();
          updateStep2GuideCard();
          markCurrentFileDirty();
          if (state.step2Mode === 'border') {
            alert(getLocalizedText('guideAutoDetectFallback', 'Mask was not sampled manually, so auto-detect was applied.'));
          } else if (!hasRollReference()) {
            alert(getLocalizedText('guideReferenceSuggestion', 'If auto-detect is unstable, set one frame as roll reference first.'));
          }
        }
      }
      void processNegative();
    });

    function readLensSearchInputsFromUI() {
      const lensModelInput = document.getElementById('lensLensModelInput');
      const lensMakerInput = document.getElementById('lensLensMakerInput');
      const cameraModelInput = document.getElementById('lensCameraModelInput');
      const cameraMakerInput = document.getElementById('lensCameraMakerInput');
      state.lensCorrection.search = {
        lensModel: String(lensModelInput?.value || '').trim(),
        lensMaker: String(lensMakerInput?.value || '').trim(),
        cameraModel: String(cameraModelInput?.value || '').trim(),
        cameraMaker: String(cameraMakerInput?.value || '').trim()
      };
      return state.lensCorrection.search;
    }

    function applyLensProfileSelection(lens) {
      const selected = sanitizeLensSelection(lens, null);
      if (!selected) return false;
      state.lensCorrection.selectedLens = selected;
      state.lensCorrection.enabled = true;
      state.lensCorrection.search.lensModel = selected.model || state.lensCorrection.search.lensModel;
      state.lensCorrection.search.lensMaker = selected.maker || state.lensCorrection.search.lensMaker;
      if (!state.lensCorrection.paramTouched.crop && Number.isFinite(selected.cropFactor) && selected.cropFactor > 0) {
        state.lensCorrection.params.crop = clampBetween(selected.cropFactor, 0.1, 10);
      }
      if (!state.lensCorrection.paramTouched.focal) {
        state.lensCorrection.params.focal = clampBetween(guessFocalFromLensProfile(selected), 1, 10_000);
      }
      if (!state.lensCorrection.paramTouched.aperture && Number.isFinite(selected.maxAperture) && selected.maxAperture > 0) {
        state.lensCorrection.params.aperture = clampBetween(selected.maxAperture, 0.5, 512);
      }
      state.lensCorrection.lastError = '';
      setLensStatus('lensStatusSelected', { lens: formatLensLabel(selected) || `#${selected.handle}` });
      updateLensCorrectionUI();
      markCurrentFileDirty();
      return true;
    }

    async function runLensProfileSearch() {
      const searchBtn = document.getElementById('lensSearchBtn');
      const query = readLensSearchInputsFromUI();
      if (!query.lensModel) {
        setLensStatus('lensStatusNeedModel');
        updateLensCorrectionUI();
        return;
      }

      const previousText = searchBtn.textContent;
      searchBtn.disabled = true;
      setLensStatus('lensStatusLoading');
      updateLensCorrectionUI();

      try {
        const runtime = await ensureLensfunClient();
        state.lensCorrection.source = runtime.source;
        setLensStatus(resolveLensStatusKeyForSource(runtime.source));

        const searchFlags = Number.isFinite(LF_SEARCH_SORT_AND_UNIQUIFY)
          ? LF_SEARCH_SORT_AND_UNIQUIFY
          : ((window.LensfunWasm && Number.isFinite(window.LensfunWasm.LF_SEARCH_SORT_AND_UNIQUIFY))
            ? window.LensfunWasm.LF_SEARCH_SORT_AND_UNIQUIFY
            : 2);
        const results = runtime.client.searchLenses({
          lensModel: query.lensModel,
          lensMaker: query.lensMaker || undefined,
          cameraMaker: query.cameraMaker || undefined,
          cameraModel: query.cameraModel || undefined,
          searchFlags
        });

        state.lensCorrection.searchResults = Array.isArray(results) ? results.slice(0, 200) : [];
        renderLensSearchResults();

        if (!state.lensCorrection.searchResults.length) {
          setLensStatus('lensStatusNoResult');
          updateLensCorrectionUI();
          return;
        }

        setLensStatus('lensStatusSearchCount', {
          count: state.lensCorrection.searchResults.length
        });
        updateLensCorrectionUI();
      } catch (err) {
        const reason = sanitizeLensRuntimeError(err);
        state.lensCorrection.lastError = reason;
        setLensStatus('lensStatusInitFailed', { reason });
        updateLensCorrectionUI();
      } finally {
        searchBtn.disabled = false;
        if (previousText) searchBtn.textContent = previousText;
      }
    }

    document.getElementById('lensEnableInput').addEventListener('change', (e) => {
      state.lensCorrection.enabled = Boolean(e.target.checked);
      if (state.lensCorrection.enabled && !state.lensCorrection.selectedLens) {
        setLensStatus('lensStatusNeedProfile');
      } else if (!state.lensCorrection.enabled) {
        setLensStatus('lensStatusSkipped');
      } else if (state.lensCorrection.selectedLens) {
        setLensStatus('lensStatusSelected', {
          lens: formatLensLabel(state.lensCorrection.selectedLens) || `#${state.lensCorrection.selectedLens.handle}`
        });
      }
      updateLensCorrectionUI();
      markCurrentFileDirty();
    });

    document.getElementById('lensSkipBtn').addEventListener('click', () => {
      state.lensCorrection.enabled = false;
      setLensStatus('lensStatusSkipped');
      updateLensCorrectionUI();
      markCurrentFileDirty();
    });

    document.getElementById('lensSearchBtn').addEventListener('click', () => {
      void runLensProfileSearch();
    });

    document.getElementById('lensUseSelectedBtn').addEventListener('click', () => {
      const select = document.getElementById('lensResultSelect');
      const idx = Number(select.value);
      if (!Number.isFinite(idx) || idx < 0 || idx >= state.lensCorrection.searchResults.length) {
        setLensStatus('lensStatusNeedProfile');
        updateLensCorrectionUI();
        return;
      }
      applyLensProfileSelection(state.lensCorrection.searchResults[idx]);
    });

    document.getElementById('lensResultSelect').addEventListener('change', (e) => {
      const idx = Number(e.target.value);
      if (!Number.isFinite(idx) || idx < 0 || idx >= state.lensCorrection.searchResults.length) return;
      const candidate = state.lensCorrection.searchResults[idx];
      setLensStatus('lensStatusSelected', { lens: formatLensLabel(candidate) || `#${candidate.handle}` });
      updateLensCorrectionUI();
    });

    const lensTextInputs = ['lensLensModelInput', 'lensLensMakerInput', 'lensCameraModelInput', 'lensCameraMakerInput'];
    lensTextInputs.forEach((id) => {
      const input = document.getElementById(id);
      if (!input) return;
      input.addEventListener('input', () => {
        readLensSearchInputsFromUI();
      });
    });

    function bindLensNumericParamInput(id, key, min, max, decimals = 3) {
      const input = document.getElementById(id);
      if (!input) return;
      const handler = () => {
        const value = sanitizeNumeric(input.value, state.lensCorrection.params[key], min, max);
        state.lensCorrection.params[key] = value;
        input.value = String(Number(value).toFixed(decimals)).replace(/\.?0+$/, '');
        state.lensCorrection.paramTouched[key] = true;
        markCurrentFileDirty();
      };
      input.addEventListener('change', handler);
      input.addEventListener('blur', handler);
    }

    bindLensNumericParamInput('lensFocalInput', 'focal', 1, 10_000, 2);
    bindLensNumericParamInput('lensCropInput', 'crop', 0.1, 10, 3);
    bindLensNumericParamInput('lensApertureInput', 'aperture', 0.5, 512, 2);
    bindLensNumericParamInput('lensDistanceInput', 'distance', 0.1, 100_000, 2);
    bindLensNumericParamInput('lensStepInput', 'step', 1, 16, 0);

    document.getElementById('lensStepModeSelect').addEventListener('change', (e) => {
      state.lensCorrection.params.stepMode = e.target.value === 'manual' ? 'manual' : 'auto';
      state.lensCorrection.paramTouched.stepMode = true;
      syncLensStepInputState();
      markCurrentFileDirty();
    });

    updateLensCorrectionUI();

    // ===========================================
    // White Balance Sampling
    // ===========================================
    document.getElementById('sampleWBBtn').addEventListener('click', () => {
      exitBeforeAfter();
      state.samplingMode = 'whiteBalance';
      document.getElementById('sampleWBBtn').classList.add('active');
      canvas.style.cursor = 'crosshair';
      glCanvas.style.cursor = 'crosshair';
      updateBeforeAfterButtonState();
    });

    // ===========================================
    // Sampling Loupe (Magnifier)
    // ===========================================
    const LOUPE_PATCH_SIZE = 31;
    const LOUPE_HALF = (LOUPE_PATCH_SIZE - 1) / 2;
    const loupePatchData = new Uint8ClampedArray(LOUPE_PATCH_SIZE * LOUPE_PATCH_SIZE * 4);
    const loupePatch = new ImageData(loupePatchData, LOUPE_PATCH_SIZE, LOUPE_PATCH_SIZE);
    const loupePatchAdjustedData = new Uint8ClampedArray(LOUPE_PATCH_SIZE * LOUPE_PATCH_SIZE * 4);
    const loupePatchAdjusted = new ImageData(loupePatchAdjustedData, LOUPE_PATCH_SIZE, LOUPE_PATCH_SIZE);

    loupeSrcCanvas.width = LOUPE_PATCH_SIZE;
    loupeSrcCanvas.height = LOUPE_PATCH_SIZE;

    let loupeRaf = 0;
    let loupePending = null;

    function clampBetween(v, min, max) {
      if (v < min) return min;
      if (v > max) return max;
      return v;
    }

    function showLoupe() {
      loupe.style.display = 'block';
    }

    function hideLoupe() {
      if (loupeRaf) cancelAnimationFrame(loupeRaf);
      loupeRaf = 0;
      loupePending = null;
      loupe.style.display = 'none';
      loupeInfo.textContent = '';
    }

    function positionLoupe(clientX, clientY) {
      const containerRect = canvasContainer.getBoundingClientRect();
      const loupeRect = loupe.getBoundingClientRect();

      const offset = 18;
      const margin = 6;
      let left = clientX - containerRect.left + offset;
      let top = clientY - containerRect.top + offset;

      if (left + loupeRect.width + margin > containerRect.width) {
        left = clientX - containerRect.left - loupeRect.width - offset;
      }
      if (top + loupeRect.height + margin > containerRect.height) {
        top = clientY - containerRect.top - loupeRect.height - offset;
      }

      const maxLeft = Math.max(margin, containerRect.width - loupeRect.width - margin);
      const maxTop = Math.max(margin, containerRect.height - loupeRect.height - margin);
      loupe.style.left = clampBetween(left, margin, maxLeft) + 'px';
      loupe.style.top = clampBetween(top, margin, maxTop) + 'px';
    }

    function fillLoupePatchFromSource(sourceData, cx, cy) {
      const { width, height, data } = sourceData;
      let dstIdx = 0;
      for (let py = 0; py < LOUPE_PATCH_SIZE; py++) {
        const sy = clampBetween(cy + py - LOUPE_HALF, 0, height - 1);
        const row = sy * width * 4;
        for (let px = 0; px < LOUPE_PATCH_SIZE; px++) {
          const sx = clampBetween(cx + px - LOUPE_HALF, 0, width - 1);
          const srcIdx = row + sx * 4;
          loupePatchData[dstIdx] = data[srcIdx];
          loupePatchData[dstIdx + 1] = data[srcIdx + 1];
          loupePatchData[dstIdx + 2] = data[srcIdx + 2];
          loupePatchData[dstIdx + 3] = 255;
          dstIdx += 4;
        }
      }
    }

    function drawLoupeOverlay() {
      const pixelSize = loupeCanvas.width / LOUPE_PATCH_SIZE;
      const center = LOUPE_HALF * pixelSize + pixelSize / 2;
      const centerPixel = LOUPE_HALF * pixelSize;

	      // Center pixel outline
	      loupeCtx.lineWidth = 2;
	      loupeCtx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
	      loupeCtx.strokeRect(centerPixel, centerPixel, pixelSize, pixelSize);
	      loupeCtx.lineWidth = 1;
	      loupeCtx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
	      loupeCtx.strokeRect(centerPixel + 0.5, centerPixel + 0.5, pixelSize - 1, pixelSize - 1);

      // Crosshair (with outline for contrast)
      loupeCtx.lineCap = 'butt';
      loupeCtx.beginPath();
      loupeCtx.lineWidth = 3;
      loupeCtx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
      loupeCtx.moveTo(center, 0);
      loupeCtx.lineTo(center, loupeCanvas.height);
      loupeCtx.moveTo(0, center);
      loupeCtx.lineTo(loupeCanvas.width, center);
      loupeCtx.stroke();

      loupeCtx.beginPath();
      loupeCtx.lineWidth = 1;
      loupeCtx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
      loupeCtx.moveTo(center, 0);
      loupeCtx.lineTo(center, loupeCanvas.height);
      loupeCtx.moveTo(0, center);
      loupeCtx.lineTo(loupeCanvas.width, center);
      loupeCtx.stroke();
    }

    function updateLoupe() {
      loupeRaf = 0;
      const pending = loupePending;
      loupePending = null;

      if (!pending || !state.samplingMode || state.cropping) {
        hideLoupe();
        return;
      }

      const target = pending.target;
      const rect = target.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        hideLoupe();
        return;
      }

      const relX = (pending.clientX - rect.left) / rect.width;
      const relY = (pending.clientY - rect.top) / rect.height;
      if (relX < 0 || relX > 1 || relY < 0 || relY > 1) {
        hideLoupe();
        return;
      }

      let sourceData = null;
      const showAdjusted = state.samplingMode === 'whiteBalance';
      if (state.samplingMode === 'filmBase') {
        sourceData = state.croppedImageData || state.originalImageData;
      } else if (state.samplingMode === 'whiteBalance') {
        sourceData = state.processedImageData;
      }
      if (!sourceData) {
        hideLoupe();
        return;
      }

      const cx = clampBetween(Math.floor(relX * sourceData.width), 0, sourceData.width - 1);
      const cy = clampBetween(Math.floor(relY * sourceData.height), 0, sourceData.height - 1);

      fillLoupePatchFromSource(sourceData, cx, cy);

      let centerR = 0, centerG = 0, centerB = 0;
      const centerIdx = (LOUPE_HALF * LOUPE_PATCH_SIZE + LOUPE_HALF) * 4;

      if (showAdjusted) {
        applyAdjustmentsToBuffer(loupePatch, state, loupePatchAdjusted, 'full');
        loupeSrcCtx.putImageData(loupePatchAdjusted, 0, 0);
        centerR = loupePatchAdjustedData[centerIdx];
        centerG = loupePatchAdjustedData[centerIdx + 1];
        centerB = loupePatchAdjustedData[centerIdx + 2];
      } else {
        loupeSrcCtx.putImageData(loupePatch, 0, 0);
        centerR = loupePatchData[centerIdx];
        centerG = loupePatchData[centerIdx + 1];
        centerB = loupePatchData[centerIdx + 2];
      }

      loupeCtx.imageSmoothingEnabled = false;
      loupeCtx.clearRect(0, 0, loupeCanvas.width, loupeCanvas.height);
      loupeCtx.drawImage(loupeSrcCanvas, 0, 0, loupeCanvas.width, loupeCanvas.height);
      drawLoupeOverlay();

      loupeInfo.textContent = `x ${cx}  y ${cy}   RGB ${centerR} ${centerG} ${centerB}`;

      showLoupe();
      positionLoupe(pending.clientX, pending.clientY);
    }

    function handleLoupePointer(e) {
      if (!state.samplingMode || state.cropping) {
        hideLoupe();
        return;
      }

      loupePending = {
        clientX: e.clientX,
        clientY: e.clientY,
        target: e.currentTarget
      };

      if (!loupeRaf) {
        loupeRaf = requestAnimationFrame(updateLoupe);
      }
    }

    [canvas, glCanvas].forEach(el => {
      el.addEventListener('pointermove', handleLoupePointer);
      el.addEventListener('pointerdown', handleLoupePointer);
      el.addEventListener('pointerleave', hideLoupe);
      el.addEventListener('pointercancel', hideLoupe);
    });

    // ===========================================
    // Canvas Click Handler (Sampling)
    // ===========================================
    function handleSamplingClick(e) {
      if (state.cropping) return;
      if (!state.samplingMode) return;

      const target = e.currentTarget;
      const rect = target.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const relX = (e.clientX - rect.left) / rect.width;
      const relY = (e.clientY - rect.top) / rect.height;
      if (relX < 0 || relX > 1 || relY < 0 || relY > 1) return;

      if (state.samplingMode === 'filmBase') {
        const sourceData = state.croppedImageData || state.originalImageData;
        if (!sourceData) return;

        pushUndo('filmBase');
        const x = Math.floor(relX * sourceData.width);
        const y = Math.floor(relY * sourceData.height);

        state.filmBase = sampleFilmBase(sourceData, x, y, 10);
        state.filmBaseSet = true;
        state.samplingMode = null;
        document.getElementById('sampleBaseBtn').classList.remove('active');
        canvas.style.cursor = 'default';
        glCanvas.style.cursor = 'default';
        hideLoupe();
        updateFilmBasePreview();
        updateStep2GuideCard();
        markCurrentFileDirty();
        updateBeforeAfterButtonState();
        scheduleSilverSourceRefresh({ immediate: true });
      } else if (state.samplingMode === 'whiteBalance') {
        // Sample from processed image (post-inversion)
        if (!state.processedImageData) return;

        pushUndo('whiteBalance');
        const x = Math.floor(relX * state.processedImageData.width);
        const y = Math.floor(relY * state.processedImageData.height);

        const sample = sampleFilmBase(state.processedImageData, x, y, 5);
        const gray = (sample.r + sample.g + sample.b) / 3;

        // Calculate multipliers to make sampled point neutral
        state.wbR = sample.r > 0 ? gray / sample.r : 1;
        state.wbG = sample.g > 0 ? gray / sample.g : 1;
        state.wbB = sample.b > 0 ? gray / sample.b : 1;

        // Normalize so G=1
        const norm = state.wbG;
        state.wbR /= norm;
        state.wbG = 1;
        state.wbB /= norm;

        state.samplingMode = null;
        document.getElementById('sampleWBBtn').classList.remove('active');
        canvas.style.cursor = 'default';
        glCanvas.style.cursor = 'default';
        hideLoupe();
        updateWBSliders();
        markCurrentFileDirty();
        updateBeforeAfterButtonState();
        updateFull();
      }
    }

    canvas.addEventListener('click', handleSamplingClick);
    glCanvas.addEventListener('click', handleSamplingClick);

    // ===========================================
    // Film Type & Preset Selection
    // ===========================================
    function setFilmTypeButtons(type) {
      document.querySelectorAll('.film-type-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.type === type);
      });
    }

    document.querySelectorAll('.step2-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        setStep2Mode(btn.dataset.mode);
      });
    });

    document.querySelectorAll('.film-type-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        pushUndo('filmType');
        state.filmType = btn.dataset.type;
        setFilmTypeButtons(state.filmType);
        let modeUpdated = false;
        if (requiresFilmBase()) {
          setStep2Mode(suggestStep2Mode());
          modeUpdated = true;
        }
        if (!modeUpdated) {
          updateFilmModeUI();
        }

        markCurrentFileDirty();
        if (usesSilverCoreConversion(state)) {
          scheduleSilverSourceRefresh();
        } else {
          schedulePreviewUpdate();
        }
      });
    });

    setFilmTypeButtons(state.filmType);

    // ===========================================
    // Slider Controls
    // ===========================================
    const sliderBindings = [];
    const sliderBindingMap = new Map();
    const selectBindings = [];
    const checkboxBindings = [];

    function getStepDecimals(step) {
      const text = String(step);
      if (text.includes('e-')) {
        const exp = Number.parseInt(text.split('e-')[1], 10);
        return Number.isFinite(exp) ? exp : 0;
      }
      const dotIndex = text.indexOf('.');
      return dotIndex >= 0 ? (text.length - dotIndex - 1) : 0;
    }

    function normalizeSliderValue(value, min, max, step, decimals) {
      if (!Number.isFinite(value)) return min;

      let nextValue = Math.min(max, Math.max(min, value));
      if (Number.isFinite(step) && step > 0) {
        nextValue = min + (Math.round((nextValue - min) / step) * step);
      }
      return Number(nextValue.toFixed(decimals));
    }

    function formatSliderValue(value, decimals) {
      return decimals > 0 ? value.toFixed(decimals) : String(Math.round(value));
    }

    function setupSlider(id, stateKey, options = {}) {
      const slider = document.getElementById(id);
      const valueInput = document.getElementById(id + 'Value');
      if (!slider || !valueInput) return;

      const min = Number.parseFloat(slider.min);
      const max = Number.parseFloat(slider.max);
      const step = Number.parseFloat(slider.step || '1');
      const decimals = Number.isInteger(options.decimals) ? options.decimals : getStepDecimals(step);
      const format = options.format || ((value) => formatSliderValue(value, decimals));
      const normalize = (rawValue) => normalizeSliderValue(rawValue, min, max, step, decimals);
      const onInput = typeof options.onInput === 'function' ? options.onInput : null;
      const onCommit = typeof options.onCommit === 'function' ? options.onCommit : null;

      const syncUI = (value) => {
        slider.value = String(value);
        valueInput.value = format(value);
      };

      const applyValue = (rawValue, commitFull = false) => {
        const value = normalize(rawValue);
        state[stateKey] = value;
        syncUI(value);
        markCurrentFileDirty();
        if (onInput) {
          onInput(value);
        } else {
          schedulePreviewUpdate();
        }
        if (commitFull) {
          if (onCommit) onCommit(value);
          else scheduleFullUpdate();
        }
      };

      // Undo: capture snapshot before drag starts
      let preDragSnapshot = null;

      slider.addEventListener('pointerdown', () => {
        preDragSnapshot = captureSnapshot(stateKey);
      });

      slider.addEventListener('input', () => {
        applyValue(Number.parseFloat(slider.value), false);
      });

      slider.addEventListener('change', () => {
        if (preDragSnapshot) {
          undoStack.push(preDragSnapshot);
          if (undoStack.length > MAX_UNDO) undoStack.shift();
          redoStack.length = 0;
          preDragSnapshot = null;
          updateUndoRedoButtons();
        }
        applyValue(Number.parseFloat(slider.value), true);
      });

      valueInput.addEventListener('input', () => {
        const parsed = Number.parseFloat(valueInput.value);
        if (!Number.isFinite(parsed)) return;
        const value = normalize(parsed);
        state[stateKey] = value;
        slider.value = String(value);
        markCurrentFileDirty();
        if (onInput) onInput(value);
        else schedulePreviewUpdate();
      });

      const commitFromInput = () => {
        pushUndo(stateKey);
        const parsed = Number.parseFloat(valueInput.value);
        const sourceValue = Number.isFinite(parsed) ? parsed : state[stateKey];
        applyValue(sourceValue, true);
      };

      valueInput.addEventListener('blur', commitFromInput);
      valueInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commitFromInput();
        }
      });

      const binding = { id, stateKey, slider, valueInput, normalize, format };
      sliderBindings.push(binding);
      sliderBindingMap.set(id, binding);
      syncUI(normalize(state[stateKey]));
    }

    function syncSliderFromState(id) {
      const binding = sliderBindingMap.get(id);
      if (!binding) return;
      const value = binding.normalize(Number.parseFloat(state[binding.stateKey]));
      state[binding.stateKey] = value;
      binding.slider.value = String(value);
      binding.valueInput.value = binding.format(value);
    }

    function syncAllSlidersFromState() {
      sliderBindings.forEach(binding => syncSliderFromState(binding.id));
    }

    function setupSelect(id, stateKey, options = {}) {
      const select = document.getElementById(id);
      if (!select) return;
      const onChange = typeof options.onChange === 'function' ? options.onChange : null;

      if (typeof state[stateKey] === 'string' && select.value !== state[stateKey]) {
        select.value = state[stateKey];
      }

      select.addEventListener('input', () => {
        state[stateKey] = select.value;
        markCurrentFileDirty();
        if (onChange) onChange(select.value);
        else schedulePreviewUpdate();
      });

      select.addEventListener('change', () => {
        pushUndo(stateKey);
        state[stateKey] = select.value;
        markCurrentFileDirty();
        if (onChange) onChange(select.value);
        else scheduleFullUpdate();
      });

      selectBindings.push({ id, stateKey, select });
    }

    function setupCheckbox(id, stateKey, options = {}) {
      const checkbox = document.getElementById(id);
      if (!checkbox) return;
      const onChange = typeof options.onChange === 'function' ? options.onChange : null;

      checkbox.checked = Boolean(state[stateKey]);
      checkbox.addEventListener('change', () => {
        pushUndo(stateKey);
        state[stateKey] = Boolean(checkbox.checked);
        markCurrentFileDirty();
        if (onChange) onChange(state[stateKey]);
        else schedulePreviewUpdate();
      });

      checkboxBindings.push({ id, stateKey, checkbox });
    }

    function syncAllSelectsFromState() {
      selectBindings.forEach(({ select, stateKey }) => {
        const value = String(state[stateKey] ?? '');
        if (select.value !== value) select.value = value;
      });
    }

    function syncAllCheckboxesFromState() {
      checkboxBindings.forEach(({ checkbox, stateKey }) => {
        checkbox.checked = Boolean(state[stateKey]);
      });
    }

    function updateWBSliders() {
      ['wbR', 'wbG', 'wbB'].forEach(syncSliderFromState);
    }

    const coreReprocessHandlers = {
      onInput: () => scheduleCoreReprocess({ full: false }),
      onCommit: () => scheduleCoreReprocess({ full: true })
    };

    function cacheBorderBufferValueForBorderMode(value) {
      if (!requiresFilmBase()) return;
      if (state.step2Mode === 'noBorder') return;
      state.coreBorderBufferBorderValue = sanitizeNumeric(value, state.coreBorderBufferBorderValue ?? 10, 0, 30);
    }

    const coreBorderBufferHandlers = {
      onInput: (value) => {
        cacheBorderBufferValueForBorderMode(value);
        scheduleSilverSourceRefresh();
      },
      onCommit: (value) => {
        cacheBorderBufferValueForBorderMode(value);
        scheduleSilverSourceRefresh({ immediate: true });
      }
    };

    function handleCoreColorModelChange() {
      scheduleSilverSourceRefresh();
    }

    function handleFilmPresetChange(presetId) {
      if (!presetId || presetId === 'none') {
        // Switching back to manual - just reprocess
        scheduleSilverSourceRefresh();
        return;
      }
      // Import preset data dynamically (it's already bundled)
      import('../silvercore/engine/FilmPresets.js').then(({ filmPresets }) => {
        const preset = filmPresets[presetId];
        if (!preset) {
          scheduleSilverSourceRefresh();
          return;
        }
        const s = preset.settings;
        // Update enhanced profile
        if (s.enhancedProfile) {
          state.coreEnhancedProfile = s.enhancedProfile;
          const epSelect = document.getElementById('coreEnhancedProfile');
          if (epSelect) epSelect.value = s.enhancedProfile;
        }
        // Update saturation slider
        if (s.saturation !== undefined) {
          state.coreSaturation = s.saturation;
          syncSliderFromState('coreSaturation');
        }
        // Update glow/fade sliders
        if (s.glow !== undefined) { state.coreGlow = s.glow; syncSliderFromState('coreGlow'); }
        if (s.fade !== undefined) { state.coreFade = s.fade; syncSliderFromState('coreFade'); }
        // Update tone sliders
        if (s.shadows !== undefined) { state.coreShadows = s.shadows; syncSliderFromState('coreShadows'); }
        if (s.highlights !== undefined) { state.coreHighlights = s.highlights; syncSliderFromState('coreHighlights'); }
        if (s.blacks !== undefined) { state.coreBlacks = s.blacks; syncSliderFromState('coreBlacks'); }
        if (s.whites !== undefined) { state.coreWhites = s.whites; syncSliderFromState('coreWhites'); }

        scheduleSilverSourceRefresh();
      });
    }

    setupSlider('coreProfileStrength', 'coreProfileStrength', coreReprocessHandlers);
    setupSlider('corePreSaturation', 'corePreSaturation', coreReprocessHandlers);
    setupSlider('coreBorderBuffer', 'coreBorderBuffer', coreBorderBufferHandlers);
    setupSlider('coreBrightness', 'coreBrightness', coreReprocessHandlers);
    setupSlider('coreExposure', 'coreExposure', coreReprocessHandlers);
    setupSlider('coreContrast', 'coreContrast', coreReprocessHandlers);
    setupSlider('coreHighlights', 'coreHighlights', coreReprocessHandlers);
    setupSlider('coreShadows', 'coreShadows', coreReprocessHandlers);
    setupSlider('coreWhites', 'coreWhites', coreReprocessHandlers);
    setupSlider('coreBlacks', 'coreBlacks', coreReprocessHandlers);
    setupSlider('coreTemperature', 'coreTemperature', coreReprocessHandlers);
    setupSlider('coreTint', 'coreTint', coreReprocessHandlers);
    setupSlider('coreSaturation', 'coreSaturation', coreReprocessHandlers);
    setupSlider('coreGlow', 'coreGlow', coreReprocessHandlers);
    setupSlider('coreFade', 'coreFade', coreReprocessHandlers);
    setupSelect('coreColorModelStep2', 'coreColorModel', {
      onChange: handleCoreColorModelChange
    });
    setupSelect('filmPreset', 'coreFilmPreset', {
      onChange: handleFilmPresetChange
    });
    setupSelect('coreEnhancedProfile', 'coreEnhancedProfile', {
      onChange: () => scheduleCoreReprocess({ full: true })
    });
    setupSelect('coreWbMode', 'coreWbMode', {
      onChange: () => scheduleCoreReprocess({ full: true })
    });
    setupSelect('coreCurvePrecision', 'coreCurvePrecision', {
      onChange: () => scheduleCoreReprocess({ full: true })
    });
    setupCheckbox('coreUseWebGL', 'coreUseWebGL', {
      onChange: () => scheduleCoreReprocess({ full: true })
    });

    setupSlider('wbR', 'wbR', { decimals: 2 });
    setupSlider('wbG', 'wbG', { decimals: 2 });
    setupSlider('wbB', 'wbB', { decimals: 2 });
    setupSlider('cyan', 'cyan');
    setupSlider('magenta', 'magenta');
    setupSlider('yellow', 'yellow');

    // Initialize step2 mode only after slider bindings exist.
    // setStep2Mode() syncs coreBorderBuffer via syncSliderFromState().
    setStep2Mode(suggestStep2Mode());

    // ===========================================
    // Section Toggle
    // ===========================================
    document.querySelectorAll('.section-header').forEach(header => {
      header.addEventListener('click', () => {
        const toggle = header.querySelector('.section-toggle');
        const section = header.dataset.section;
        if (!section) return;

        const content = document.getElementById(section + 'SectionContent') ||
                       document.getElementById(section + 'Section');
        if (content && toggle) {
          toggle.classList.toggle('collapsed');
          content.classList.toggle('collapsed');
        }
      });
    });

    // ===========================================
    // Rotation
    // ===========================================
    function normalizeAngleDegrees(angle) {
      let normalized = Number.isFinite(angle) ? angle : 0;
      while (normalized > 180) normalized -= 360;
      while (normalized <= -180) normalized += 360;
      return normalized;
    }

    function applyRotationToImageData(imageData, angle) {
      if (!imageData) return null;
      const normalized = normalizeAngleDegrees(Number(angle) || 0);
      if (Math.abs(normalized) < 0.001) return imageData;

      const rad = normalized * Math.PI / 180;
      const w = imageData.width;
      const h = imageData.height;
      const cos = Math.abs(Math.cos(rad));
      const sin = Math.abs(Math.sin(rad));
      const newW = Math.max(1, Math.ceil(w * cos + h * sin));
      const newH = Math.max(1, Math.ceil(w * sin + h * cos));

      const srcCanvas = document.createElement('canvas');
      srcCanvas.width = w;
      srcCanvas.height = h;
      const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
      srcCtx.putImageData(imageData, 0, 0);

      const dstCanvas = document.createElement('canvas');
      dstCanvas.width = newW;
      dstCanvas.height = newH;
      const dstCtx = dstCanvas.getContext('2d', { willReadFrequently: true });
      dstCtx.translate(newW / 2, newH / 2);
      dstCtx.rotate(rad);
      dstCtx.drawImage(srcCanvas, -w / 2, -h / 2);

      return dstCtx.getImageData(0, 0, newW, newH);
    }

    function resizeImageDataForDetection(imageData, maxSide = AUTO_FRAME_MAX_SIDE) {
      if (!imageData) return null;
      const longest = Math.max(imageData.width, imageData.height);
      if (longest <= maxSide) return imageData;

      const scale = maxSide / longest;
      const targetW = Math.max(1, Math.round(imageData.width * scale));
      const targetH = Math.max(1, Math.round(imageData.height * scale));

      const srcCanvas = document.createElement('canvas');
      srcCanvas.width = imageData.width;
      srcCanvas.height = imageData.height;
      const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
      srcCtx.putImageData(imageData, 0, 0);

      const dstCanvas = document.createElement('canvas');
      dstCanvas.width = targetW;
      dstCanvas.height = targetH;
      const dstCtx = dstCanvas.getContext('2d', { willReadFrequently: true });
      dstCtx.drawImage(srcCanvas, 0, 0, targetW, targetH);
      return dstCtx.getImageData(0, 0, targetW, targetH);
    }

    function getOpenCvScriptBySource(src) {
      return Array.from(document.querySelectorAll('script[data-opencv-loader="1"]'))
        .find(script => script.dataset.opencvSource === src) || null;
    }

    function waitForScriptLoad(script, src) {
      return new Promise((resolve, reject) => {
        const loadState = script.dataset.loadState;
        if (loadState === 'loaded') {
          resolve();
          return;
        }
        if (loadState === 'failed') {
          reject(new Error(`OpenCV script load failed: ${src}`));
          return;
        }

        const onLoad = () => {
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new Error(`OpenCV script load failed: ${src}`));
        };
        const cleanup = () => {
          script.removeEventListener('load', onLoad);
          script.removeEventListener('error', onError);
        };

        script.addEventListener('load', onLoad);
        script.addEventListener('error', onError);
      });
    }

    function waitForOpenCvRuntime(timeoutMs = 15000) {
      return new Promise((resolve, reject) => {
        if (!window.cv) {
          reject(new Error('OpenCV global is unavailable'));
          return;
        }
        if (window.cv.Mat) {
          resolve(true);
          return;
        }

        let settled = false;
        const timeoutId = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error('OpenCV runtime init timeout'));
        }, timeoutMs);

        const prev = window.cv.onRuntimeInitialized;
        window.cv.onRuntimeInitialized = () => {
          if (typeof prev === 'function') {
            try {
              prev();
            } catch (err) {
              console.warn('Previous OpenCV runtime hook failed:', err);
            }
          }
          if (settled) return;
          settled = true;
          window.clearTimeout(timeoutId);
          if (window.cv && window.cv.Mat) {
            resolve(true);
          } else {
            reject(new Error('OpenCV initialized without Mat API'));
          }
        };
      });
    }

    async function loadOpenCvFromSource(src) {
      if (window.cv && window.cv.Mat) {
        opencvActiveSource = src;
        return true;
      }

      let script = getOpenCvScriptBySource(src);
      if (script && script.dataset.loadState === 'failed') {
        script.remove();
        script = null;
      }

      if (!script) {
        script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.defer = true;
        script.dataset.opencvLoader = '1';
        script.dataset.opencvSource = src;
        script.dataset.loadState = 'loading';
        script.onload = () => {
          script.dataset.loadState = 'loaded';
        };
        script.onerror = () => {
          script.dataset.loadState = 'failed';
        };
        document.head.appendChild(script);
      }

      await waitForScriptLoad(script, src);

      if (!window.cv) {
        throw new Error(`OpenCV global unavailable after loading ${src}`);
      }
      if (!window.cv.Mat) {
        await waitForOpenCvRuntime();
      }
      if (!(window.cv && window.cv.Mat)) {
        throw new Error(`OpenCV runtime incomplete after loading ${src}`);
      }

      opencvActiveSource = src;
      return true;
    }

    async function ensureOpenCvReady() {
      if (window.cv && window.cv.Mat) return true;
      if (opencvReadyPromise) return opencvReadyPromise;

      opencvReadyPromise = (async () => {
        const errors = [];
        for (const src of OPENCV_SCRIPT_CANDIDATES) {
          try {
            await loadOpenCvFromSource(src);
            if (opencvActiveSource) {
              console.info('OpenCV loaded from:', opencvActiveSource);
            }
            return true;
          } catch (err) {
            const message = err?.message || String(err);
            errors.push(`[${src}] ${message}`);
            console.warn('OpenCV source failed:', src, message);
          }
        }

        console.error('OpenCV unavailable. Tried sources:', errors.join(' | '));
        return false;
      })();

      const ready = await opencvReadyPromise;
      if (!ready) {
        opencvReadyPromise = null;
      }
      return ready;
    }

    function getAutoFrameAspectTargets() {
      const pref = state.autoFrame && state.autoFrame.formatPreference ? state.autoFrame.formatPreference : 'auto';
      const allowed120Map = (state.autoFrame && state.autoFrame.allowed120Formats) || {};
      const enabled120 = AUTO_FRAME_DEFAULT_120_FORMATS.filter(fmt => allowed120Map[fmt] !== false);
      const safe120 = enabled120.length ? enabled120 : ['6x6'];

      const targets = [];
      const addTarget = (key, weight = 1) => {
        const ratio = AUTO_FRAME_FORMAT_RATIOS[key];
        if (!Number.isFinite(ratio)) return;
        targets.push({ key, ratio, weight: clampBetween(weight, 0.4, 1.2) });
      };

      if (pref === '135') {
        addTarget('135', 1.05);
        safe120.forEach(fmt => addTarget(`120-${fmt}`, 0.78));
      } else if (pref === '120') {
        safe120.forEach(fmt => addTarget(`120-${fmt}`, 1.05));
        addTarget('135', 0.78);
      } else {
        addTarget('135', 1);
        safe120.forEach(fmt => addTarget(`120-${fmt}`, 1));
      }
      return targets.length ? targets : [{ key: '135', ratio: 1.5, weight: 1 }];
    }

    function scoreAspectAgainstTargets(ratio, targets) {
      const safeRatio = Math.max(0.01, Number(ratio) || 1);
      let best = { score: 0, format: 'unknown' };
      targets.forEach(target => {
        const delta = Math.abs(safeRatio - target.ratio) / target.ratio;
        const normalized = 1 - clampBetween(delta / 0.45, 0, 1);
        const weighted = clampBetween(normalized * target.weight, 0, 1);
        if (weighted > best.score) {
          best = { score: weighted, format: target.key };
        }
      });
      return best;
    }

    function sanitizeBound(bound, imageWidth, imageHeight) {
      if (!bound) return null;
      const left = clampBetween(Math.floor(Number(bound.x) || 0), 0, imageWidth - 1);
      const top = clampBetween(Math.floor(Number(bound.y) || 0), 0, imageHeight - 1);
      const maxWidth = imageWidth - left;
      const maxHeight = imageHeight - top;
      if (maxWidth < 1 || maxHeight < 1) return null;
      const width = clampBetween(Math.floor(Number(bound.width) || 0), 1, maxWidth);
      const height = clampBetween(Math.floor(Number(bound.height) || 0), 1, maxHeight);
      if (width < 1 || height < 1) return null;
      return { x: left, y: top, width, height };
    }

    function orderPointsClockwise(points) {
      if (!Array.isArray(points) || points.length !== 4) return [];
      const center = points.reduce((acc, p) => {
        acc.x += p.x;
        acc.y += p.y;
        return acc;
      }, { x: 0, y: 0 });
      center.x /= points.length;
      center.y /= points.length;
      return [...points].sort((a, b) => {
        const angleA = Math.atan2(a.y - center.y, a.x - center.x);
        const angleB = Math.atan2(b.y - center.y, b.x - center.x);
        return angleA - angleB;
      });
    }

    function computeOrthogonality(points) {
      if (!Array.isArray(points) || points.length !== 4) return 0.65;
      const ordered = orderPointsClockwise(points);
      if (ordered.length !== 4) return 0.65;

      let deviationSum = 0;
      for (let i = 0; i < 4; i++) {
        const prev = ordered[(i + 3) % 4];
        const curr = ordered[i];
        const next = ordered[(i + 1) % 4];
        const v1x = prev.x - curr.x;
        const v1y = prev.y - curr.y;
        const v2x = next.x - curr.x;
        const v2y = next.y - curr.y;
        const len1 = Math.hypot(v1x, v1y);
        const len2 = Math.hypot(v2x, v2y);
        if (len1 < 0.001 || len2 < 0.001) {
          deviationSum += 45;
          continue;
        }
        const cosTheta = clampBetween((v1x * v2x + v1y * v2y) / (len1 * len2), -1, 1);
        const angle = Math.acos(cosTheta) * 180 / Math.PI;
        deviationSum += Math.abs(90 - angle);
      }
      const avgDeviation = deviationSum / 4;
      return 1 - clampBetween(avgDeviation / 30, 0, 1);
    }

    function computeParallelism(points) {
      if (!Array.isArray(points) || points.length !== 4) return 0.65;
      const ordered = orderPointsClockwise(points);
      if (ordered.length !== 4) return 0.65;

      const edges = [];
      for (let i = 0; i < 4; i++) {
        const p1 = ordered[i];
        const p2 = ordered[(i + 1) % 4];
        let orientation = Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180 / Math.PI;
        if (orientation < 0) orientation += 180;
        edges.push(orientation);
      }

      const pairDelta = (a, b) => {
        let delta = Math.abs(a - b);
        if (delta > 90) delta = 180 - delta;
        return delta;
      };

      const dev1 = pairDelta(edges[0], edges[2]);
      const dev2 = pairDelta(edges[1], edges[3]);
      const avgDeviation = (dev1 + dev2) / 2;
      return 1 - clampBetween(avgDeviation / 20, 0, 1);
    }

    function extractApproxPoints(approxMat) {
      if (!approxMat || !approxMat.data32S) return [];
      const data = approxMat.data32S;
      const points = [];
      for (let i = 0; i + 1 < data.length; i += 2) {
        points.push({ x: data[i], y: data[i + 1] });
      }
      return points;
    }

    function edgePixelAt(mat, x, y) {
      if (!mat || !Number.isFinite(x) || !Number.isFinite(y)) return 0;
      const safeX = clampBetween(Math.round(x), 0, mat.cols - 1);
      const safeY = clampBetween(Math.round(y), 0, mat.rows - 1);
      return mat.ucharPtr(safeY, safeX)[0] > 0 ? 1 : 0;
    }

    function computeEdgeSupport(edges, bound) {
      if (!edges || !bound) return 0;
      const left = bound.x;
      const right = bound.x + bound.width - 1;
      const top = bound.y;
      const bottom = bound.y + bound.height - 1;
      if (right <= left || bottom <= top) return 0;

      const step = Math.max(1, Math.round(Math.min(bound.width, bound.height) / 120));
      let hits = 0;
      let total = 0;

      for (let x = left; x <= right; x += step) {
        hits += edgePixelAt(edges, x, top);
        hits += edgePixelAt(edges, x, bottom);
        total += 2;
      }
      for (let y = top; y <= bottom; y += step) {
        hits += edgePixelAt(edges, left, y);
        hits += edgePixelAt(edges, right, y);
        total += 2;
      }

      return total > 0 ? clampBetween(hits / total, 0, 1) : 0;
    }

    function scoreFrameCandidate(candidate, context) {
      if (!candidate || !context) return null;
      const { imageWidth, imageHeight, imageArea, edges, aspectTargets } = context;
      const bound = sanitizeBound(candidate.bound, imageWidth, imageHeight);
      if (!bound) return null;

      const area = Math.max(1, Number(candidate.area) || (bound.width * bound.height));
      const areaRatio = area / imageArea;
      const rectWidth = Math.max(1, Number(candidate.minRectWidth) || bound.width);
      const rectHeight = Math.max(1, Number(candidate.minRectHeight) || bound.height);
      const rectArea = Math.max(1, rectWidth * rectHeight);
      const rectangularity = clampBetween(area / rectArea, 0, 1);

      const areaCoverage = clampBetween(areaRatio / 0.88, 0, 1);
      const overshootPenalty = areaRatio > 0.97 ? clampBetween((areaRatio - 0.97) / 0.03, 0, 1) * 0.35 : 0;
      const areaScore = clampBetween(areaCoverage - overshootPenalty, 0, 1);

      const points = Array.isArray(candidate.points) ? candidate.points : [];
      const orthogonality = clampBetween(Number(candidate.orthogonalityHint), 0, 1) || computeOrthogonality(points);
      const parallelism = clampBetween(Number(candidate.parallelismHint), 0, 1) || computeParallelism(points);
      const edgeSupport = computeEdgeSupport(edges, bound);

      const centerX = bound.x + (bound.width / 2);
      const centerY = bound.y + (bound.height / 2);
      const centerDist = Math.hypot(centerX - (imageWidth / 2), centerY - (imageHeight / 2));
      const centerPrior = 1 - clampBetween(centerDist / (Math.hypot(imageWidth, imageHeight) * 0.45), 0, 1);

      const ratio = Math.max(rectWidth, rectHeight) / Math.max(1, Math.min(rectWidth, rectHeight));
      const aspect = scoreAspectAgainstTargets(ratio, aspectTargets);

      const score = (
        areaScore * AUTO_FRAME_SCORE_WEIGHTS.area +
        rectangularity * AUTO_FRAME_SCORE_WEIGHTS.rectangularity +
        orthogonality * AUTO_FRAME_SCORE_WEIGHTS.orthogonality +
        parallelism * AUTO_FRAME_SCORE_WEIGHTS.parallelism +
        edgeSupport * AUTO_FRAME_SCORE_WEIGHTS.edgeSupport +
        centerPrior * AUTO_FRAME_SCORE_WEIGHTS.centerPrior +
        aspect.score * AUTO_FRAME_SCORE_WEIGHTS.aspect
      );

      return {
        ...candidate,
        bound,
        score: clampBetween(score, 0, 1),
        areaRatio,
        detectedFormat: aspect.format,
        scoreBreakdown: {
          area: Number(areaScore.toFixed(3)),
          rectangularity: Number(rectangularity.toFixed(3)),
          orthogonality: Number(orthogonality.toFixed(3)),
          parallelism: Number(parallelism.toFixed(3)),
          edgeSupport: Number(edgeSupport.toFixed(3)),
          centerPrior: Number(centerPrior.toFixed(3)),
          aspect: Number(aspect.score.toFixed(3))
        },
        minRect: {
          angle: Number(candidate.minRectAngle) || 0,
          width: rectWidth,
          height: rectHeight
        }
      };
    }

    function buildHoughCandidate(edges, imageWidth, imageHeight) {
      if (!window.cv.HoughLinesP) return null;
      const lines = new window.cv.Mat();
      try {
        const minDim = Math.min(imageWidth, imageHeight);
        window.cv.HoughLinesP(
          edges,
          lines,
          1,
          Math.PI / 180,
          70,
          Math.max(40, Math.round(minDim * 0.25)),
          Math.max(8, Math.round(minDim * 0.02))
        );

        if (!lines.rows || !lines.data32S) return null;
        const data = lines.data32S;
        let left = Infinity;
        let top = Infinity;
        let right = -Infinity;
        let bottom = -Infinity;
        let hCount = 0;
        let vCount = 0;

        for (let i = 0; i < lines.rows; i++) {
          const idx = i * 4;
          const x1 = data[idx];
          const y1 = data[idx + 1];
          const x2 = data[idx + 2];
          const y2 = data[idx + 3];
          const dx = x2 - x1;
          const dy = y2 - y1;
          const length = Math.hypot(dx, dy);
          if (length < minDim * 0.18) continue;

          let angle = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI);
          if (angle > 90) angle = 180 - angle;

          if (angle <= 16) {
            hCount++;
          } else if (angle >= 74) {
            vCount++;
          } else {
            continue;
          }

          left = Math.min(left, x1, x2);
          right = Math.max(right, x1, x2);
          top = Math.min(top, y1, y2);
          bottom = Math.max(bottom, y1, y2);
        }

        if (hCount < 2 || vCount < 2) return null;
        if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(right) || !Number.isFinite(bottom)) {
          return null;
        }

        const margin = Math.round(minDim * 0.006);
        const bound = sanitizeBound({
          x: left - margin,
          y: top - margin,
          width: (right - left) + margin * 2,
          height: (bottom - top) + margin * 2
        }, imageWidth, imageHeight);
        if (!bound) return null;

        return {
          method: 'hough',
          area: bound.width * bound.height,
          bound,
          minRectWidth: bound.width,
          minRectHeight: bound.height,
          minRectAngle: 0,
          points: [
            { x: bound.x, y: bound.y },
            { x: bound.x + bound.width, y: bound.y },
            { x: bound.x + bound.width, y: bound.y + bound.height },
            { x: bound.x, y: bound.y + bound.height }
          ],
          orthogonalityHint: 1,
          parallelismHint: 1
        };
      } catch (err) {
        console.warn('Hough candidate failed:', err);
        return null;
      } finally {
        lines.delete();
      }
    }

    function detectFrameCandidatesWithCv(imageData, options = {}) {
      if (!(window.cv && window.cv.Mat) || !imageData) return [];

      const minAreaRatio = Number.isFinite(options.minAreaRatio) ? options.minAreaRatio : 0.05;
      const retrievalMode = options.retrievalMode === 'external' ? window.cv.RETR_EXTERNAL : window.cv.RETR_LIST;
      const aspectTargets = getAutoFrameAspectTargets();
      const src = window.cv.matFromImageData(imageData);
      const imageWidth = src.cols;
      const imageHeight = src.rows;
      const imageArea = Math.max(1, imageWidth * imageHeight);

      let gray = null;
      let claheEnhanced = null;
      let topHat = null;
      let blackHat = null;
      let merged = null;
      let blurred = null;
      let edges = null;
      let kernel3 = null;
      let kernel7 = null;
      let contours = null;
      let hierarchy = null;

      try {
        gray = new window.cv.Mat();
        claheEnhanced = new window.cv.Mat();
        topHat = new window.cv.Mat();
        blackHat = new window.cv.Mat();
        merged = new window.cv.Mat();
        blurred = new window.cv.Mat();
        edges = new window.cv.Mat();
        kernel3 = window.cv.getStructuringElement(window.cv.MORPH_RECT, new window.cv.Size(3, 3));
        kernel7 = window.cv.getStructuringElement(window.cv.MORPH_RECT, new window.cv.Size(7, 7));
        contours = new window.cv.MatVector();
        hierarchy = new window.cv.Mat();

        window.cv.cvtColor(src, gray, window.cv.COLOR_RGBA2GRAY);
        let claheApplied = false;
        let clahe = null;
        try {
          if (window.cv.createCLAHE && typeof window.cv.createCLAHE === 'function') {
            clahe = window.cv.createCLAHE(2.0, new window.cv.Size(8, 8));
          } else if (window.cv.CLAHE && typeof window.cv.CLAHE === 'function') {
            clahe = new window.cv.CLAHE(2.0, new window.cv.Size(8, 8));
          }
          if (clahe && typeof clahe.apply === 'function') {
            clahe.apply(gray, claheEnhanced);
            claheApplied = true;
          }
        } catch (err) {
          claheApplied = false;
        } finally {
          if (clahe && typeof clahe.delete === 'function') {
            clahe.delete();
          }
        }
        if (!claheApplied) {
          window.cv.equalizeHist(gray, claheEnhanced);
        }
        window.cv.morphologyEx(claheEnhanced, topHat, window.cv.MORPH_TOPHAT, kernel7);
        window.cv.morphologyEx(claheEnhanced, blackHat, window.cv.MORPH_BLACKHAT, kernel7);
        window.cv.addWeighted(claheEnhanced, 1.0, topHat, 0.7, 0, merged);
        window.cv.addWeighted(merged, 1.0, blackHat, -0.45, 0, merged);
        window.cv.GaussianBlur(merged, blurred, new window.cv.Size(5, 5), 0, 0, window.cv.BORDER_DEFAULT);
        window.cv.Canny(blurred, edges, 40, 140, 3, false);
        window.cv.dilate(edges, edges, kernel3, new window.cv.Point(-1, -1), 1);

        const candidates = [];
        window.cv.findContours(edges, contours, hierarchy, retrievalMode, window.cv.CHAIN_APPROX_SIMPLE);
        for (let i = 0; i < contours.size(); i++) {
          const contour = contours.get(i);
          let approx = null;
          try {
            const area = Math.abs(window.cv.contourArea(contour));
            if (area < imageArea * minAreaRatio) continue;

            const bound = window.cv.boundingRect(contour);
            const minRect = window.cv.minAreaRect(contour);
            const perimeter = window.cv.arcLength(contour, true);
            approx = new window.cv.Mat();
            window.cv.approxPolyDP(contour, approx, Math.max(2, perimeter * 0.02), true);
            const approxPoints = extractApproxPoints(approx);

            const scored = scoreFrameCandidate({
              method: 'contour',
              area,
              bound,
              minRectWidth: minRect.size.width,
              minRectHeight: minRect.size.height,
              minRectAngle: minRect.angle,
              points: approxPoints.length === 4 ? approxPoints : []
            }, {
              imageWidth,
              imageHeight,
              imageArea,
              edges,
              aspectTargets
            });
            if (scored) candidates.push(scored);
          } finally {
            contour.delete();
            if (approx) approx.delete();
          }
        }

        const houghCandidate = buildHoughCandidate(edges, imageWidth, imageHeight);
        if (houghCandidate) {
          const scoredHough = scoreFrameCandidate(houghCandidate, {
            imageWidth,
            imageHeight,
            imageArea,
            edges,
            aspectTargets
          });
          if (scoredHough) candidates.push(scoredHough);
        }

        return candidates
          .filter(candidate => candidate.areaRatio >= minAreaRatio)
          .sort((a, b) => b.score - a.score)
          .slice(0, 10);
      } catch (err) {
        console.error('OpenCV border analysis failed:', err);
        return [];
      } finally {
        src.delete();
        if (gray) gray.delete();
        if (claheEnhanced) claheEnhanced.delete();
        if (topHat) topHat.delete();
        if (blackHat) blackHat.delete();
        if (merged) merged.delete();
        if (blurred) blurred.delete();
        if (edges) edges.delete();
        if (kernel3) kernel3.delete();
        if (kernel7) kernel7.delete();
        if (contours) contours.delete();
        if (hierarchy) hierarchy.delete();
      }
    }

    function buildRotationCandidates(baseCandidates = []) {
      const angleSet = new Set([0]);
      baseCandidates.slice(0, 4).forEach(candidate => {
        const minRect = candidate && candidate.minRect ? candidate.minRect : null;
        if (!minRect) return;
        let angle = Number(minRect.angle) || 0;
        const width = Number(minRect.width) || 0;
        const height = Number(minRect.height) || 0;
        if (width < height) angle += 90;
        [angle, -angle, angle + 90, angle - 90, angle + 180].forEach(raw => {
          const normalized = normalizeAngleDegrees(raw);
          const quantized = Math.round(normalized * 10) / 10;
          if (Math.abs(quantized) <= 0.1) {
            angleSet.add(0);
          } else {
            angleSet.add(quantized);
          }
        });
      });
      return Array.from(angleSet);
    }

    function getAutoFrameTargetRatiosForFormat(formatKey = 'unknown') {
      const direct = AUTO_FRAME_FORMAT_RATIOS[formatKey];
      if (Number.isFinite(direct)) return [direct];
      const fallback = getAutoFrameAspectTargets()
        .map(target => target.ratio)
        .filter(ratio => Number.isFinite(ratio) && ratio > 0.01);
      return fallback.length ? fallback : [AUTO_FRAME_FORMAT_RATIOS['135'] || 1.5];
    }

    function evaluateAutoFrameCropRegion(cropRegion, imageData, detectedFormat = 'unknown', candidate = null) {
      if (!cropRegion || !imageData) {
        return {
          isValid: false,
          areaRatio: 0,
          aspectDelta: 1,
          aspectScore: 0,
          areaScore: 0,
          edgeSupport: 0,
          shortEdgeCoverage: 0
        };
      }

      const totalArea = Math.max(1, imageData.width * imageData.height);
      const cropArea = Math.max(1, cropRegion.width * cropRegion.height);
      const areaRatio = cropArea / totalArea;
      const ratio = Math.max(cropRegion.width, cropRegion.height) / Math.max(1, Math.min(cropRegion.width, cropRegion.height));
      const targetRatios = getAutoFrameTargetRatiosForFormat(detectedFormat);
      let bestAspectDelta = Infinity;
      targetRatios.forEach((targetRatio) => {
        const delta = Math.abs(ratio - targetRatio) / targetRatio;
        if (delta < bestAspectDelta) bestAspectDelta = delta;
      });
      if (!Number.isFinite(bestAspectDelta)) bestAspectDelta = 1;

      const hasKnownFormat = Number.isFinite(AUTO_FRAME_FORMAT_RATIOS[detectedFormat]);
      const aspectTolerance = hasKnownFormat ? 0.34 : 0.42;
      const areaScore = clampBetween((areaRatio - 0.08) / 0.86, 0, 1);
      const aspectScore = 1 - clampBetween(bestAspectDelta / aspectTolerance, 0, 1);
      const shortEdgeCoverage = Math.min(cropRegion.width / imageData.width, cropRegion.height / imageData.height);
      const edgeSupport = candidate && candidate.scoreBreakdown
        ? clampBetween(Number(candidate.scoreBreakdown.edgeSupport) || 0, 0, 1)
        : 0.5;

      const isValid = areaRatio >= 0.10
        && areaRatio <= 0.975
        && bestAspectDelta <= aspectTolerance
        && shortEdgeCoverage >= 0.22
        && edgeSupport >= 0.12;

      return {
        isValid,
        areaRatio: Number(areaRatio.toFixed(4)),
        aspectDelta: Number(bestAspectDelta.toFixed(4)),
        aspectScore: Number(aspectScore.toFixed(3)),
        areaScore: Number(areaScore.toFixed(3)),
        edgeSupport: Number(edgeSupport.toFixed(3)),
        shortEdgeCoverage: Number(shortEdgeCoverage.toFixed(3)),
        aspectTolerance: Number(aspectTolerance.toFixed(3))
      };
    }

    function computeAutoFrameAnglePenalty(angle) {
      const absAngle = Math.abs(normalizeAngleDegrees(Number(angle) || 0));
      if (absAngle <= 0.12) return 0;
      const remainder = absAngle % 90;
      const distanceToRightAngle = Math.min(remainder, 90 - remainder);
      const offAxisPenalty = clampBetween(distanceToRightAngle / 22, 0, 1) * 0.16;
      const magnitudePenalty = clampBetween(absAngle / 120, 0, 1) * 0.07;
      return clampBetween(offAxisPenalty + magnitudePenalty, 0, 0.25);
    }

    function buildCropRegionFromBound(bound, imageData, marginRatio = 0.02) {
      if (!bound || !imageData) return null;
      const margin = Math.round(Math.min(imageData.width, imageData.height) * Math.max(0, marginRatio));
      const left = clampBetween(bound.x - margin, 0, imageData.width - 1);
      const top = clampBetween(bound.y - margin, 0, imageData.height - 1);
      const maxWidth = imageData.width - left;
      const maxHeight = imageData.height - top;
      const width = clampBetween(bound.width + margin * 2, 1, maxWidth);
      const height = clampBetween(bound.height + margin * 2, 1, maxHeight);
      return sanitizeCropRegionForImage({ left, top, width, height }, imageData);
    }

    function detectAxisAlignedCropRegion(imageData, marginRatio = 0.02) {
      const candidates = detectFrameCandidatesWithCv(imageData, {
        minAreaRatio: 0.04,
        retrievalMode: 'external'
      });
      if (!candidates.length) return null;

      for (const candidate of candidates) {
        const cropRegion = buildCropRegionFromBound(candidate.bound, imageData, marginRatio);
        if (!cropRegion) continue;
        const validation = evaluateAutoFrameCropRegion(cropRegion, imageData, candidate.detectedFormat, candidate);
        if (!validation.isValid) continue;
        const confidence = clampBetween(
          (candidate.score * 0.62) +
          (Math.min(validation.areaRatio / 0.92, 1) * 0.16) +
          (validation.aspectScore * 0.16) +
          (validation.edgeSupport * 0.06),
          0,
          1
        );
        return {
          cropRegion,
          confidence,
          candidate,
          validation
        };
      }
      return null;
    }

    function inferConfidenceLevel(confidence) {
      const high = Number.isFinite(state.autoFrame.highConfidence) ? state.autoFrame.highConfidence : 0.72;
      const min = Number.isFinite(state.autoFrame.minConfidence) ? state.autoFrame.minConfidence : 0.55;
      if (confidence >= high) return 'high';
      if (confidence >= min) return 'medium';
      return 'low';
    }

    async function detectFrameAndRotation(imageData) {
      if (!imageData) return null;
      const ready = await ensureOpenCvReady();
      if (!ready) return null;

      const previewData = resizeImageDataForDetection(imageData, AUTO_FRAME_MAX_SIDE);
      const previewCandidates = detectFrameCandidatesWithCv(previewData, { minAreaRatio: 0.04 });
      if (!previewCandidates.length) return null;

      const angleCandidates = buildRotationCandidates(previewCandidates);
      let bestPreview = null;
      for (const angle of angleCandidates) {
        const rotatedPreview = Math.abs(angle) < 0.001 ? previewData : applyRotationToImageData(previewData, angle);
        const cropPreview = detectAxisAlignedCropRegion(rotatedPreview, state.autoFrame.marginRatio);
        if (!cropPreview) continue;
        const baseScore = previewCandidates[0] ? previewCandidates[0].score : 0.5;
        const anglePenalty = computeAutoFrameAnglePenalty(angle);
        const validationAspect = cropPreview.validation ? cropPreview.validation.aspectScore : 0.6;
        const score = clampBetween(
          (baseScore * 0.24) +
          (cropPreview.confidence * 0.66) +
          (validationAspect * 0.10) -
          anglePenalty,
          0,
          1
        );
        const isBetter = !bestPreview
          || score > (bestPreview.score + 0.001)
          || (Math.abs(score - bestPreview.score) <= 0.001 && Math.abs(angle) < Math.abs(bestPreview.angle));
        if (isBetter) {
          bestPreview = { angle, score, cropPreview, anglePenalty };
        }
      }

      if (!bestPreview) return null;
      const normalizedAngle = Math.abs(bestPreview.angle) < 0.15 ? 0 : Number(bestPreview.angle.toFixed(2));
      const rotatedFull = Math.abs(normalizedAngle) < 0.001 ? imageData : applyRotationToImageData(imageData, normalizedAngle);
      const cropFull = detectAxisAlignedCropRegion(rotatedFull, state.autoFrame.marginRatio);
      if (!cropFull || !cropFull.validation || !cropFull.validation.isValid) return null;

      const fullAnglePenalty = computeAutoFrameAnglePenalty(normalizedAngle);
      const confidence = Number(clampBetween(
        (bestPreview.score * 0.34) +
        (cropFull.confidence * 0.56) +
        (cropFull.validation.aspectScore * 0.10) -
        (fullAnglePenalty * 0.4),
        0,
        1
      ).toFixed(2));
      const confidenceLevel = inferConfidenceLevel(confidence);
      const detectedFormat = cropFull.candidate && cropFull.candidate.detectedFormat
        ? cropFull.candidate.detectedFormat
        : 'unknown';

      return {
        angle: normalizedAngle,
        cropRegion: cropFull.cropRegion,
        confidence,
        confidenceLevel,
        detectedFormat,
        rotatedImageData: rotatedFull,
        diagnostics: {
          method: cropFull.candidate ? cropFull.candidate.method : 'unknown',
          scoreBreakdown: cropFull.candidate ? cropFull.candidate.scoreBreakdown : null,
          anglePenalty: Number(fullAnglePenalty.toFixed(3)),
          cropValidation: cropFull.validation || null
        }
      };
    }

    function formatAutoFrameDetail(result) {
      const detailTemplate = i18n[currentLang].autoFramePreviewDetail
        || 'Rotate {angle}°, crop to {width}x{height}, confidence {confidence}';
      const base = detailTemplate
        .replace('{angle}', String(result.angle))
        .replace('{width}', String(result.cropRegion.width))
        .replace('{height}', String(result.cropRegion.height))
        .replace('{confidence}', String(result.confidence.toFixed(2)));
      const formatPart = result.detectedFormat ? `\nformat: ${result.detectedFormat}` : '';
      return `${base}${formatPart}`;
    }

    function applyAutoFrameResult(result) {
      if (!result || !state.originalImageData) return false;

      state.rotationAngle = normalizeAngleDegrees(result.angle || 0);
      state.croppedImageData = null;
      state.cropRegion = null;
      state.originalImageData = result.rotatedImageData
        || (Math.abs(state.rotationAngle) < 0.001
          ? state.originalImageData
          : applyRotationToImageData(state.originalImageData, state.rotationAngle));
      applyCropRegionToLoadedImage(result.cropRegion, { refreshDisplay: true });
      state.autoFrame.lastDiagnostics = {
        confidence: result.confidence,
        detectedFormat: result.detectedFormat || 'unknown',
        method: result.diagnostics && result.diagnostics.method ? result.diagnostics.method : 'unknown',
        confidenceLevel: result.confidenceLevel || inferConfidenceLevel(result.confidence || 0),
        rotateOnly: false,
        appliedMode: 'crop',
        lowConfidenceApplied: (result.confidenceLevel || inferConfidenceLevel(result.confidence || 0)) === 'low'
      };
      updateAutoFrameDiagnosticsUI();
      setStep2Mode(suggestStep2Mode());
      return true;
    }

    function applyAutoFrameRotationOnly(result) {
      if (!result || !state.originalImageData) return false;
      state.rotationAngle = normalizeAngleDegrees(result.angle || 0);
      state.cropRegion = null;
      state.croppedImageData = null;
      state.originalImageData = result.rotatedImageData
        || (Math.abs(state.rotationAngle) < 0.001
          ? state.originalImageData
          : applyRotationToImageData(state.originalImageData, state.rotationAngle));
      displayNegative(state.originalImageData);
      state.autoFrame.lastDiagnostics = {
        confidence: result.confidence,
        detectedFormat: result.detectedFormat || 'unknown',
        method: result.diagnostics && result.diagnostics.method ? result.diagnostics.method : 'unknown',
        confidenceLevel: result.confidenceLevel || inferConfidenceLevel(result.confidence || 0),
        rotateOnly: true,
        appliedMode: 'rotateOnly',
        lowConfidenceApplied: false
      };
      updateAutoFrameDiagnosticsUI();
      setStep2Mode(suggestStep2Mode());
      return true;
    }

    function mapCropRegionAfterRotation(cropRegion, sourceWidth, sourceHeight, rotatedWidth, rotatedHeight, angleDegrees) {
      if (!cropRegion) return null;
      const rad = (Number(angleDegrees) || 0) * Math.PI / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const srcCx = sourceWidth / 2;
      const srcCy = sourceHeight / 2;
      const dstCx = rotatedWidth / 2;
      const dstCy = rotatedHeight / 2;

      const corners = [
        { x: cropRegion.left, y: cropRegion.top },
        { x: cropRegion.left + cropRegion.width, y: cropRegion.top },
        { x: cropRegion.left + cropRegion.width, y: cropRegion.top + cropRegion.height },
        { x: cropRegion.left, y: cropRegion.top + cropRegion.height }
      ];

      const rotated = corners.map((point) => {
        const relX = point.x - srcCx;
        const relY = point.y - srcCy;
        const x = relX * cos - relY * sin + dstCx;
        const y = relX * sin + relY * cos + dstCy;
        return { x, y };
      });

      const minX = Math.min(...rotated.map(point => point.x));
      const maxX = Math.max(...rotated.map(point => point.x));
      const minY = Math.min(...rotated.map(point => point.y));
      const maxY = Math.max(...rotated.map(point => point.y));

      return sanitizeCropRegionForImage({
        left: Math.floor(minX),
        top: Math.floor(minY),
        width: Math.ceil(maxX - minX),
        height: Math.ceil(maxY - minY)
      }, { width: rotatedWidth, height: rotatedHeight });
    }

    function invalidateProcessedPipelineState() {
      state.processedImageData = null;
      state.displayImageData = null;
      invalidateSilverCoreCache();
      state.conversionSourceImageData = null;
      state.conversionPreviewImageData = null;
      state.previewSourceImageData = null;
      state.histogramSourceImageData = null;
      state.webglSourceImageData = null;
      state.lastRenderQuality = 'full';
      if (webglState.gl) {
        webglState.sourceDirty = true;
        webglState.sourceSize = { w: 0, h: 0 };
      }
      if (coreReprocessTimer) {
        clearTimeout(coreReprocessTimer);
        coreReprocessTimer = null;
      }
      if (step2AutoConvertTimer) {
        clearTimeout(step2AutoConvertTimer);
        step2AutoConvertTimer = null;
      }
    }

    function applyRotation(angle) {
      if (!state.originalImageData || !Number.isFinite(angle) || angle === 0) return;

      const normalizedAngle = normalizeAngleDegrees(Number(angle) || 0);
      if (Math.abs(normalizedAngle) < 0.001) return;

      pushUndo('rotation');
      const sourceOriginal = state.originalImageData;
      const sourceCrop = state.cropRegion ? { ...state.cropRegion } : null;
      const shouldPreserveCrop = state.currentStep >= 3 && Boolean(sourceCrop);

      const rotatedData = applyRotationToImageData(sourceOriginal, normalizedAngle);
      if (!rotatedData) return;

      state.originalImageData = rotatedData;

      if (shouldPreserveCrop) {
        const mappedCrop = mapCropRegionAfterRotation(
          sourceCrop,
          sourceOriginal.width,
          sourceOriginal.height,
          rotatedData.width,
          rotatedData.height,
          normalizedAngle
        );
        state.cropRegion = mappedCrop;
        state.croppedImageData = mappedCrop ? cropImageData(state.originalImageData, mappedCrop) : null;
      } else {
        state.croppedImageData = null;
        state.cropRegion = null;
      }

      state.rotationAngle = normalizeAngleDegrees((state.rotationAngle || 0) + normalizedAngle);
      invalidateProcessedPipelineState();
      resetZoomPan();

      if (state.currentStep >= 3) {
        void processNegative();
      } else {
        displayNegative(state.croppedImageData || rotatedData);
        updateCanvasVisibility();
      }
      setStep2Mode(suggestStep2Mode());
      markCurrentFileDirty();
    }

    function applyMirror() {
      const sourceData = state.croppedImageData || state.originalImageData;
      if (!sourceData) return;

      pushUndo('mirror');
      const w = canvas.width;
      const h = canvas.height;
      const offCanvas = document.createElement('canvas');
      offCanvas.width = w;
      offCanvas.height = h;
      const offCtx = offCanvas.getContext('2d');

      offCtx.translate(w, 0);
      offCtx.scale(-1, 1);
      offCtx.drawImage(canvas, 0, 0);

      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(offCanvas, 0, 0);

      const newImageData = ctx.getImageData(0, 0, w, h);
      if (state.croppedImageData) {
        state.croppedImageData = newImageData;
      } else {
        state.originalImageData = newImageData;
      }

      transformCanvas.width = w;
      transformCanvas.height = h;
      transformCtx.drawImage(offCanvas, 0, 0);
      adjustCanvasDisplay(w, h);
      markCurrentFileDirty();
    }

    document.getElementById('rotateLeftBtn').addEventListener('click', () => applyRotation(-90));
    document.getElementById('rotateRightBtn').addEventListener('click', () => applyRotation(90));
    document.getElementById('mirrorBtn').addEventListener('click', () => applyMirror());

    document.getElementById('applyRotateBtn').addEventListener('click', () => {
      const angle = parseFloat(document.getElementById('rotateAngle').value) || 0;
      if (angle !== 0) {
        applyRotation(angle);
        document.getElementById('rotateAngle').value = 0;
      }
    });

    async function applyAutoFrameToCurrent() {
      if (state.currentStep !== 1) return;
      const source = state.loadedBaseImageData || state.originalImageData;
      if (!source) return;

      const button = document.getElementById('autoFrameBtn');
      const previousText = button ? button.textContent : '';
      if (button) {
        button.disabled = true;
        button.textContent = i18n[currentLang].autoFrameAnalyzing || 'Analyzing frame borders...';
      }

      try {
        const ready = await ensureOpenCvReady();
        if (!ready) {
          alert(i18n[currentLang].autoFrameCvLoadError || 'OpenCV failed to load. Auto frame is unavailable.');
          return;
        }

        const result = await detectFrameAndRotation(source);
        if (!result) {
          alert(i18n[currentLang].autoFrameNoReliableBorder || 'No reliable frame border detected. Please crop manually.');
          return;
        }

        const detail = formatAutoFrameDetail(result);
        state.originalImageData = source;
        const lowBehavior = state.autoFrame.lowConfidenceBehavior || 'suggest';
        let applied = false;

        if (result.confidenceLevel === 'low') {
          if (lowBehavior === 'rotateOnly') {
            if (Math.abs(result.angle) > 0.05) {
              applied = applyAutoFrameRotationOnly(result);
              if (applied) {
                const template = i18n[currentLang].autoFrameRotateOnlyApplied
                  || 'Low confidence: applied rotation only ({angle}°).';
                alert(template.replace('{angle}', String(result.angle)));
              }
            } else {
              alert(i18n[currentLang].autoFrameNoReliableBorder || 'No reliable frame border detected. Please crop manually.');
            }
          } else if (lowBehavior === 'ignore') {
            alert(i18n[currentLang].autoFrameNoReliableBorder || 'No reliable frame border detected. Please crop manually.');
          } else {
            applied = applyAutoFrameResult(result);
            if (applied) {
              const template = i18n[currentLang].autoFrameLowConfidenceApplied
                || 'Low confidence: crop applied. Please verify the result (confidence {confidence}).';
              const confidenceText = Number.isFinite(result.confidence) ? result.confidence.toFixed(2) : '0.00';
              alert(template.replace('{confidence}', confidenceText));
            }
          }
        } else if (result.confidenceLevel === 'high' && state.autoFrame.autoApplyHighConfidence) {
          applied = applyAutoFrameResult(result);
        } else {
          const title = i18n[currentLang].autoFramePreviewTitle || 'Reliable frame detected. Apply auto rotation and crop?';
          if (window.confirm(`${title}\n${detail}`)) {
            applied = applyAutoFrameResult(result);
          }
        }

        if (applied) {
          markCurrentFileDirty();
        } else {
          state.autoFrame.lastDiagnostics = {
            confidence: result.confidence,
            detectedFormat: result.detectedFormat || 'unknown',
            method: result.diagnostics && result.diagnostics.method ? result.diagnostics.method : 'unknown',
            confidenceLevel: result.confidenceLevel || inferConfidenceLevel(result.confidence || 0),
            rotateOnly: false,
            appliedMode: 'none',
            lowConfidenceApplied: false
          };
          updateAutoFrameDiagnosticsUI();
        }
      } finally {
        if (button) {
          button.textContent = previousText || (i18n[currentLang].autoFrame || 'Auto Frame');
          updateAutoFrameButtons();
        }
      }
    }

    async function applyAutoFrameToSelected() {
      if (state.currentStep !== 1) return;
      const selectedItems = state.fileQueue.filter(item => item.selected);
      if (selectedItems.length < 1) return;

      const ready = await ensureOpenCvReady();
      if (!ready) {
        alert(i18n[currentLang].autoFrameCvLoadError || 'OpenCV failed to load. Auto frame is unavailable.');
        return;
      }

      const button = document.getElementById('autoFrameSelectedBtn');
      const previousText = button ? button.textContent : '';
      if (button) {
        button.disabled = true;
        button.textContent = i18n[currentLang].autoFrameAnalyzing || 'Analyzing frame borders...';
      }

      let successCount = 0;
      let lowAppliedCount = 0;
      let rotateOnlyCount = 0;
      let failCount = 0;
      showBatchProgress(true);

      try {
        for (let i = 0; i < selectedItems.length; i++) {
          const item = selectedItems[i];
          updateBatchProgress(i + 1, selectedItems.length, item.file.name);

          try {
            const imageData = await loadFileToImageData(item.file);
            const result = await detectFrameAndRotation(imageData);
            if (!result) {
              failCount++;
              continue;
            }

            const existing = item.settings ? cloneSettings(item.settings) : createDefaultSettings(imageData);
            const lowBehavior = state.autoFrame.lowConfidenceBehavior || 'suggest';
            let appliedMode = 'none';
            if (result.confidenceLevel === 'low') {
              if (lowBehavior === 'rotateOnly' && Math.abs(result.angle) > 0.05) {
                existing.rotationAngle = result.angle;
                existing.cropRegion = null;
                rotateOnlyCount++;
                appliedMode = 'rotateOnly';
              } else if (lowBehavior === 'suggest') {
                existing.rotationAngle = result.angle;
                existing.cropRegion = result.cropRegion ? { ...result.cropRegion } : null;
                successCount++;
                lowAppliedCount++;
                appliedMode = 'crop';
              } else {
                failCount++;
                continue;
              }
            } else {
              existing.rotationAngle = result.angle;
              existing.cropRegion = result.cropRegion ? { ...result.cropRegion } : null;
              successCount++;
              appliedMode = 'crop';
            }

            existing.autoFrameMeta = {
              confidence: result.confidence,
              confidenceLevel: result.confidenceLevel || inferConfidenceLevel(result.confidence || 0),
              detectedFormat: result.detectedFormat || 'unknown',
              method: result.diagnostics && result.diagnostics.method ? result.diagnostics.method : 'unknown',
              rotateOnly: appliedMode === 'rotateOnly',
              appliedMode,
              lowConfidenceApplied: result.confidenceLevel === 'low' && appliedMode === 'crop',
              detectedAt: Date.now()
            };
            item.settings = existing;
            item.isDirty = false;
          } catch (err) {
            console.error('Auto frame batch item failed:', item.file.name, err);
            failCount++;
          }
        }
      } finally {
        showBatchProgress(false);
        if (button) {
          button.textContent = previousText || (i18n[currentLang].autoFrameSelected || 'Auto Frame Selected');
          updateAutoFrameButtons();
        }
      }

      const currentItem = getCurrentQueueItem();
      if (currentItem && currentItem.settings && currentItem.selected) {
        restoreSettings(currentItem.settings);
      }

      updateFileListUI();
      const template = i18n[currentLang].autoFrameBatchDoneExtended
        || i18n[currentLang].autoFrameBatchDone
        || 'Auto frame finished: {success} succeeded, {failed} failed.';
      alert(template
        .replace('{success}', String(successCount))
        .replace('{lowApplied}', String(lowAppliedCount))
        .replace('{rotated}', String(rotateOnlyCount))
        .replace('{failed}', String(failCount)));
    }

    document.getElementById('autoFrameBtn').addEventListener('click', () => {
      applyAutoFrameToCurrent();
    });

    document.getElementById('autoFrameSelectedBtn').addEventListener('click', () => {
      applyAutoFrameToSelected();
    });

    // ===========================================
    // Before / After (hold to preview original)
    // ===========================================
    let beforeAfterPointerId = null;

    function releaseBeforeAfterPointerCapture(pointerId) {
      if (!beforeAfterBtn || pointerId == null) return;
      if (typeof beforeAfterBtn.hasPointerCapture === 'function'
          && beforeAfterBtn.hasPointerCapture(pointerId)) {
        beforeAfterBtn.releasePointerCapture(pointerId);
      }
    }

    if (beforeAfterBtn) {
      beforeAfterBtn.addEventListener('pointerdown', (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        if (beforeAfterBtn.disabled) return;
        event.preventDefault();
        beforeAfterPointerId = event.pointerId;
        if (typeof beforeAfterBtn.setPointerCapture === 'function') {
          beforeAfterBtn.setPointerCapture(event.pointerId);
        }
        enterBeforeAfter('button');
      });

      const endBeforeAfterFromButton = (event) => {
        if (beforeAfterPointerId !== null && event.pointerId !== beforeAfterPointerId) return;
        exitBeforeAfter();
        releaseBeforeAfterPointerCapture(beforeAfterPointerId);
        beforeAfterPointerId = null;
      };

      beforeAfterBtn.addEventListener('pointerup', endBeforeAfterFromButton);
      beforeAfterBtn.addEventListener('pointercancel', endBeforeAfterFromButton);
      beforeAfterBtn.addEventListener('pointerleave', endBeforeAfterFromButton);
      beforeAfterBtn.addEventListener('contextmenu', (event) => event.preventDefault());
    }

    document.addEventListener('keydown', (event) => {
      if (event.code !== 'Space' || event.repeat) return;
      if (isEditableTarget(event.target)) return;
      if (!canActivateBeforeAfter()) return;
      event.preventDefault();
      enterBeforeAfter('keyboard');
    });

    document.addEventListener('keyup', (event) => {
      if (event.code !== 'Space') return;
      if (state.beforeAfterSource !== 'keyboard') return;
      event.preventDefault();
      exitBeforeAfter();
    });

    window.addEventListener('blur', () => {
      if (state.beforeAfterActive) exitBeforeAfter();
      releaseBeforeAfterPointerCapture(beforeAfterPointerId);
      beforeAfterPointerId = null;
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) return;
      if (state.beforeAfterActive) exitBeforeAfter();
      releaseBeforeAfterPointerCapture(beforeAfterPointerId);
      beforeAfterPointerId = null;
    });

    // Keyboard zoom shortcuts
    document.addEventListener('keydown', (event) => {
      if (isEditableTarget(event.target)) return;
      if (state.cropping || state.samplingMode) return;
      const key = event.key;
      if (key === '+' || key === '=') {
        event.preventDefault();
        const containerRect = canvasContainer.getBoundingClientRect();
        const cx = containerRect.left + containerRect.width / 2;
        const cy = containerRect.top + containerRect.height / 2;
        zoomAtPoint(state.zoomLevel * 1.5, cx, cy);
      } else if (key === '-') {
        event.preventDefault();
        const containerRect = canvasContainer.getBoundingClientRect();
        const cx = containerRect.left + containerRect.width / 2;
        const cy = containerRect.top + containerRect.height / 2;
        zoomAtPoint(state.zoomLevel / 1.5, cx, cy);
      } else if (key === '0') {
        event.preventDefault();
        resetZoomPan();
      }
    });

    // Undo/Redo keyboard shortcuts
    document.addEventListener('keydown', (event) => {
      if (isEditableTarget(event.target)) return;

      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key === 'z') {
        event.preventDefault();
        performUndo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 'z' || event.key === 'Z')) {
        event.preventDefault();
        performRedo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'y') {
        event.preventDefault();
        performRedo();
        return;
      }
    });

    // Undo/Redo button click handlers
    document.getElementById('undoBtn').addEventListener('click', () => performUndo());
    document.getElementById('redoBtn').addEventListener('click', () => performRedo());

    // Escape key handler
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (isEditableTarget(event.target)) return;

      if (state.beforeAfterActive) {
        event.preventDefault();
        exitBeforeAfter();
        return;
      }
      if (state.cropping) {
        event.preventDefault();
        document.getElementById('cancelCropBtn').click();
        showToast(getLocalizedText('cancelledCrop', 'Crop cancelled'));
        return;
      }
      if (state.samplingMode) {
        event.preventDefault();
        state.samplingMode = null;
        document.getElementById('sampleBaseBtn')?.classList.remove('active');
        document.getElementById('sampleWBBtn')?.classList.remove('active');
        canvas.style.cursor = '';
        const glCanvas = document.getElementById('glCanvas');
        if (glCanvas) glCanvas.style.cursor = '';
        hideLoupe();
        updateBeforeAfterButtonState();
        showToast(getLocalizedText('cancelledSampling', 'Exited sampling mode'));
        return;
      }
      if (dustDrawing) {
        event.preventDefault();
        dustDrawing = false;
        dustBrushPoints = [];
        if (state.dustRemoval.showMask) renderDustMaskOverlay();
        showToast(getLocalizedText('cancelledBrush', 'Brush cancelled'));
        return;
      }
    });

    // Zoom control buttons
    document.getElementById('zoomInBtn').addEventListener('click', () => {
      const containerRect = canvasContainer.getBoundingClientRect();
      const cx = containerRect.left + containerRect.width / 2;
      const cy = containerRect.top + containerRect.height / 2;
      zoomAtPoint(state.zoomLevel * 1.5, cx, cy);
    });

    document.getElementById('zoomOutBtn').addEventListener('click', () => {
      const containerRect = canvasContainer.getBoundingClientRect();
      const cx = containerRect.left + containerRect.width / 2;
      const cy = containerRect.top + containerRect.height / 2;
      zoomAtPoint(state.zoomLevel / 1.5, cx, cy);
    });

    document.getElementById('zoomResetBtn').addEventListener('click', () => {
      resetZoomPan();
    });

    // ===========================================
    // Cropping
    // ===========================================
    const cropOverlay = document.getElementById('cropOverlay');

    document.getElementById('cropBtn').addEventListener('click', () => {
      exitBeforeAfter();
      state.cropping = true;
      state.croppingActive = false;
      state.cropStart = null;
      activeCropPointerId = null;
      cropOverlay.style.display = 'block';
      cropOverlay.style.left = '0';
      cropOverlay.style.top = '0';
      cropOverlay.style.width = '0';
      cropOverlay.style.height = '0';
      canvasContainer.style.touchAction = 'none';

      document.getElementById('cropBtn').style.display = 'none';
      document.getElementById('applyCropBtn').style.display = 'inline-flex';
      document.getElementById('cancelCropBtn').style.display = 'inline-flex';
      updateBeforeAfterButtonState();
    });

    let activeCropPointerId = null;

    function getCropDisplayScale() {
      // Pre-transform CSS size of the canvas (unaffected by zoom)
      const cssW = parseFloat(canvas.style.width) || canvas.width;
      const cssH = parseFloat(canvas.style.height) || canvas.height;
      return {
        scaleX: canvas.width / cssW,
        scaleY: canvas.height / cssH,
        cssW,
        cssH
      };
    }

    function screenToWrapperLocal(clientX, clientY) {
      const wrapperRect = canvasTransformWrapper.getBoundingClientRect();
      const z = state.zoomLevel;
      return {
        x: (clientX - wrapperRect.left) / z,
        y: (clientY - wrapperRect.top) / z
      };
    }

    function startCropDrag(clientX, clientY) {
      if (!state.cropping) return;

      const { scaleX, scaleY } = getCropDisplayScale();
      const local = screenToWrapperLocal(clientX, clientY);

      state.cropStart = {
        x: local.x * scaleX,
        y: local.y * scaleY
      };
      state.croppingActive = true;
    }

    function updateCropDrag(clientX, clientY) {
      if (!state.cropping || !state.croppingActive || !state.cropStart) return;

      const { scaleX, scaleY } = getCropDisplayScale();
      const local = screenToWrapperLocal(clientX, clientY);

      const current = {
        x: local.x * scaleX,
        y: local.y * scaleY
      };

      const left = Math.min(state.cropStart.x, current.x);
      const top = Math.min(state.cropStart.y, current.y);
      const width = Math.abs(current.x - state.cropStart.x);
      const height = Math.abs(current.y - state.cropStart.y);

      // Overlay is inside wrapper, so use pre-transform (wrapper-local) coords
      const leftDisp = left / scaleX;
      const topDisp = top / scaleY;
      const widthDisp = width / scaleX;
      const heightDisp = height / scaleY;

      cropOverlay.style.left = leftDisp + 'px';
      cropOverlay.style.top = topDisp + 'px';
      cropOverlay.style.width = widthDisp + 'px';
      cropOverlay.style.height = heightDisp + 'px';
    }

    function finishCropDrag() {
      if (!state.cropping) return;
      state.croppingActive = false;
    }

    canvasContainer.addEventListener('mousedown', (e) => {
      if (state.cropping) {
        startCropDrag(e.clientX, e.clientY);
      } else if (canPan()) {
        state.isPanning = true;
        state.panStartX = e.clientX;
        state.panStartY = e.clientY;
        state.panStartPanX = state.panX;
        state.panStartPanY = state.panY;
        canvasContainer.classList.add('zoom-panning');
        e.preventDefault();
      }
    });

    canvasContainer.addEventListener('mousemove', (e) => {
      if (state.cropping) {
        updateCropDrag(e.clientX, e.clientY);
      } else if (state.isPanning) {
        state.panX = state.panStartPanX + (e.clientX - state.panStartX);
        state.panY = state.panStartPanY + (e.clientY - state.panStartY);
        clampPan();
        applyZoomPanTransform();
      }
    });

    function finishPan() {
      if (state.isPanning) {
        state.isPanning = false;
        canvasContainer.classList.remove('zoom-panning');
      }
    }

    canvasContainer.addEventListener('mouseup', () => { finishCropDrag(); finishPan(); });
    canvasContainer.addEventListener('mouseleave', () => { finishCropDrag(); finishPan(); });

    canvasContainer.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      if (state.cropping) {
        e.preventDefault();
        activeCropPointerId = e.pointerId;
        canvasContainer.setPointerCapture(e.pointerId);
        startCropDrag(e.clientX, e.clientY);
      } else if (canPan()) {
        e.preventDefault();
        state.isPanning = true;
        state.panStartX = e.clientX;
        state.panStartY = e.clientY;
        state.panStartPanX = state.panX;
        state.panStartPanY = state.panY;
        canvasContainer.setPointerCapture(e.pointerId);
        canvasContainer.classList.add('zoom-panning');
      }
    }, { passive: false });

    canvasContainer.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse') return;
      if (state.cropping && activeCropPointerId === e.pointerId) {
        e.preventDefault();
        updateCropDrag(e.clientX, e.clientY);
      } else if (state.isPanning) {
        e.preventDefault();
        state.panX = state.panStartPanX + (e.clientX - state.panStartX);
        state.panY = state.panStartPanY + (e.clientY - state.panStartY);
        clampPan();
        applyZoomPanTransform();
      }
    }, { passive: false });

    function finishCropPointer(e) {
      if (e.pointerType === 'mouse') return;
      if (activeCropPointerId === e.pointerId) {
        finishCropDrag();
        if (canvasContainer.hasPointerCapture(e.pointerId)) {
          canvasContainer.releasePointerCapture(e.pointerId);
        }
        activeCropPointerId = null;
      }
      if (state.isPanning) {
        finishPan();
        if (canvasContainer.hasPointerCapture(e.pointerId)) {
          canvasContainer.releasePointerCapture(e.pointerId);
        }
      }
    }

    canvasContainer.addEventListener('pointerup', finishCropPointer);
    canvasContainer.addEventListener('pointercancel', finishCropPointer);

    // Wheel zoom
    canvasContainer.addEventListener('wheel', (e) => {
      if (state.cropping || state.samplingMode) return;
      e.preventDefault();
      const delta = e.ctrlKey ? -e.deltaY * 0.01 : -e.deltaY * 0.003;
      const factor = Math.pow(2, delta);
      zoomAtPoint(state.zoomLevel * factor, e.clientX, e.clientY);
    }, { passive: false });

    // Double-click: toggle zoom
    canvasContainer.addEventListener('dblclick', (e) => {
      if (state.cropping || state.samplingMode) return;
      if (state.zoomLevel > 1) {
        resetZoomPan();
      } else {
        zoomAtPoint(2, e.clientX, e.clientY);
      }
    });

    // Touch pinch zoom
    let pinchStartDist = 0;
    let pinchStartZoom = 1;

    canvasContainer.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        pinchStartDist = Math.hypot(dx, dy);
        pinchStartZoom = state.zoomLevel;
      }
    }, { passive: false });

    canvasContainer.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && pinchStartDist > 0) {
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.hypot(dx, dy);
        const centerX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const centerY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        const newZoom = pinchStartZoom * (dist / pinchStartDist);
        zoomAtPoint(newZoom, centerX, centerY);
      }
    }, { passive: false });

    canvasContainer.addEventListener('touchend', () => {
      pinchStartDist = 0;
    });

    document.getElementById('cancelCropBtn').addEventListener('click', () => {
      state.cropping = false;
      state.croppingActive = false;
      state.cropStart = null;
      activeCropPointerId = null;
      cropOverlay.style.display = 'none';
      canvasContainer.style.touchAction = '';
      document.getElementById('cropBtn').style.display = 'inline-flex';
      document.getElementById('applyCropBtn').style.display = 'none';
      document.getElementById('cancelCropBtn').style.display = 'none';
      updateBeforeAfterButtonState();
    });

    document.getElementById('applyCropBtn').addEventListener('click', () => {
      pushUndo('crop');
      // Overlay coords are wrapper-local (pre-transform), convert to canvas pixels
      const { scaleX, scaleY } = getCropDisplayScale();

      const left = Math.floor(parseFloat(cropOverlay.style.left) * scaleX);
      const top = Math.floor(parseFloat(cropOverlay.style.top) * scaleY);
      const width = Math.floor(parseFloat(cropOverlay.style.width) * scaleX);
      const height = Math.floor(parseFloat(cropOverlay.style.height) * scaleY);

      if (width <= 0 || height <= 0) return;

      const baseCrop = state.cropRegion;
      const hasNestedCropBase = Boolean(state.croppedImageData && baseCrop);
      const absoluteCrop = {
        left: hasNestedCropBase ? baseCrop.left + left : left,
        top: hasNestedCropBase ? baseCrop.top + top : top,
        width,
        height
      };
      applyCropRegionToLoadedImage(absoluteCrop, { refreshDisplay: true });
      resetZoomPan();
      setStep2Mode(suggestStep2Mode());
      markCurrentFileDirty();

      state.cropping = false;
      state.croppingActive = false;
      state.cropStart = null;
      activeCropPointerId = null;
      cropOverlay.style.display = 'none';
      canvasContainer.style.touchAction = '';
      document.getElementById('cropBtn').style.display = 'inline-flex';
      document.getElementById('applyCropBtn').style.display = 'none';
      document.getElementById('cancelCropBtn').style.display = 'none';
      updateBeforeAfterButtonState();
    });

    // Convert button (skip to step 2)
    document.getElementById('convertBtn').addEventListener('click', () => {
      goToStep(2);
    });

    // Convert positive button (skip to step 2 with positive mode selected)
    document.getElementById('convertPositiveBtn').addEventListener('click', () => {
      state.filmType = 'positive';
      setFilmTypeButtons(state.filmType);
      updateFilmModeUI();
      markCurrentFileDirty();
      goToStep(2);
    });

    // ===========================================
    // Reset & Start Over
    // ===========================================
    document.getElementById('resetBtn').addEventListener('click', () => {
      // Reset adjustments only
      state.coreFilmPreset = 'none';
      state.coreColorModel = 'standard';
      state.coreEnhancedProfile = 'none';
      state.coreProfileStrength = 100;
      state.corePreSaturation = 100;
      state.coreBorderBuffer = 10;
      state.coreBorderBufferBorderValue = 10;
      state.coreBrightness = 0;
      state.coreExposure = 0;
      state.coreContrast = 0;
      state.coreHighlights = 0;
      state.coreShadows = 0;
      state.coreWhites = 0;
      state.coreBlacks = 0;
      state.coreWbMode = 'auto';
      state.coreTemperature = 0;
      state.coreTint = 0;
      state.coreSaturation = 100;
      state.coreGlow = 0;
      state.coreFade = 0;
      state.coreCurvePrecision = 'auto';
      state.coreUseWebGL = true;

      state.exposure = 0;
      state.contrast = 0;
      state.highlights = 0;
      state.shadows = 0;
      state.temperature = 0;
      state.tint = 0;
      state.vibrance = 0;
      state.saturation = 0;
      state.cyan = 0;
      state.magenta = 0;
      state.yellow = 0;
      state.wbR = 1;
      state.wbG = 1;
      state.wbB = 1;

      updateSlidersFromState();
      initCurves(true);
      renderCurve();
      markCurrentFileDirty();
      if (usesSilverCoreConversion(state) && state.conversionSourceImageData) {
        void rerenderWithCoreControls({ full: true }).catch((err) => {
          console.error('Core rerender failed:', err);
        });
      } else {
        updateFull();
      }
    });

    document.getElementById('startOverBtn').addEventListener('click', () => {
      clearUndoHistory();
      exitBeforeAfter();
      resetZoomPan();
      if (state.loadedBaseImageData || state.originalImageData) {
        state.originalImageData = state.loadedBaseImageData || state.originalImageData;
        state.rotationAngle = 0;
        state.cropRegion = null;
        state.croppedImageData = null;
        state.processedImageData = null;
        state.displayImageData = null;
        invalidateSilverCoreCache();
        state.conversionSourceImageData = null;
        state.conversionPreviewImageData = null;
        state.previewSourceImageData = null;
        state.histogramSourceImageData = null;
        state.webglSourceImageData = null;
        state.filmBaseSet = false;
        state.lastRenderQuality = 'full';
        if (webglState.gl) {
          webglState.sourceDirty = true;
          webglState.sourceSize = { w: 0, h: 0 };
        }
        if (fullUpdateTimer) {
          clearTimeout(fullUpdateTimer);
          fullUpdateTimer = null;
        }
        if (coreReprocessTimer) {
          clearTimeout(coreReprocessTimer);
          coreReprocessTimer = null;
        }
        if (step2AutoConvertTimer) {
          clearTimeout(step2AutoConvertTimer);
          step2AutoConvertTimer = null;
        }
        displayNegative(state.originalImageData);
        updateAutoFrameButtons();
        goToStep(1);
        document.getElementById('resetBtn').click();
        markCurrentFileDirty();
      }
    });

    document.getElementById('newImageBtn').addEventListener('click', () => {
      clearUndoHistory();
      exitBeforeAfter();
      resetZoomPan();
      zoomControls.style.display = 'none';
      // Reset all state
      state.loadedBaseImageData = null;
      state.originalImageData = null;
      state.croppedImageData = null;
      state.cropRegion = null;
      state.rotationAngle = 0;
      state.processedImageData = null;
      state.displayImageData = null;
      invalidateSilverCoreCache();
      state.conversionSourceImageData = null;
      state.conversionPreviewImageData = null;
      state.previewSourceImageData = null;
      state.histogramSourceImageData = null;
      state.webglSourceImageData = null;
      state.filmBaseSet = false;
      state.rawMetadata = null;
      state.currentStep = 1;
      state.lastRenderQuality = 'full';
      state.fileQueue = [];
      state.currentFileIndex = 0;
      state.batchSessionActive = false;
      state.batchMode = false;
      state.lensCorrection = createInitialLensCorrectionState();
      resetRollReferenceState();
      fullAdjustedBuffer = null;
      previewAdjustedBuffer = null;
      if (webglState.gl) {
        webglState.sourceDirty = true;
        webglState.sourceSize = { w: 0, h: 0 };
      }
      if (fullUpdateTimer) {
        clearTimeout(fullUpdateTimer);
        fullUpdateTimer = null;
      }
      if (coreReprocessTimer) {
        clearTimeout(coreReprocessTimer);
        coreReprocessTimer = null;
      }
      if (step2AutoConvertTimer) {
        clearTimeout(step2AutoConvertTimer);
        step2AutoConvertTimer = null;
      }

      // Reset UI
      canvas.style.display = 'none';
      glCanvas.style.display = 'none';
      document.getElementById('uploadPlaceholder').style.display = 'flex';
      document.getElementById('previewToolbar').style.display = 'none';
      document.getElementById('histogramContainer').style.display = 'none';
      document.getElementById('controlsPanel').style.display = 'none';
      document.getElementById('appFooter').style.display = 'none';
      updateBeforeAfterButtonState();

      // Reset adjustments
      document.getElementById('resetBtn').click();
      syncBatchUIState({ reason: 'newImageBtn' });

      // Trigger file selection
      fileInput.value = '';
      fileInput.click();
    });

    // ===========================================
    // Export
    // ===========================================
    const exportBtn = document.getElementById('exportBtn');
    const exportDropdownMenu = document.getElementById('exportDropdownMenu');

    // Toggle dropdown on main export button click
    exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      exportDropdownMenu.classList.toggle('show');
    });

    // Prevent dropdown from closing when clicking inside it (for export settings)
    exportDropdownMenu.addEventListener('click', (e) => {
      if (
        e.target.closest('.export-format-section')
        || e.target.closest('.export-bitdepth-section')
        || e.target.closest('.export-quality-section')
      ) {
        e.stopPropagation();
      }
    });

    // Close dropdown when clicking elsewhere
    document.addEventListener('click', () => {
      exportDropdownMenu.classList.remove('show');
    });

    function isTauriDesktop() {
      return typeof window !== 'undefined'
        && !!window.__TAURI__
        && !!window.__TAURI__.core
        && typeof window.__TAURI__.core.invoke === 'function';
    }

    function downloadBlobInBrowser(blob, fileName) {
      const link = document.createElement('a');
      link.download = fileName;
      link.href = URL.createObjectURL(blob);
      link.click();
      URL.revokeObjectURL(link.href);
    }

    function blobToBase64(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = typeof reader.result === 'string' ? reader.result : '';
          const commaIndex = result.indexOf(',');
          if (commaIndex < 0) {
            reject(new Error('Invalid export payload encoding.'));
            return;
          }
          resolve(result.slice(commaIndex + 1));
        };
        reader.onerror = () => {
          reject(reader.error || new Error('Failed to encode export payload.'));
        };
        reader.readAsDataURL(blob);
      });
    }

    async function saveBlob(blob, fileName, mimeType = 'application/octet-stream') {
      if (!(blob instanceof Blob)) {
        throw new Error('Export payload is not a Blob.');
      }

      const normalizedBlob = blob.type ? blob : new Blob([blob], { type: mimeType });
      if (isTauriDesktop()) {
        const bytesBase64 = await blobToBase64(normalizedBlob);
        const result = await window.__TAURI__.core.invoke('save_export_file', {
          suggestedName: fileName,
          bytesBase64
        });
        return {
          saved: Boolean(result && result.saved),
          path: result && result.path ? result.path : null
        };
      }

      downloadBlobInBrowser(normalizedBlob, fileName);
      return { saved: true, path: null };
    }

    function canvasToBlobWithType(targetCanvas, mimeType, quality) {
      return new Promise((resolve, reject) => {
        targetCanvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error('Failed to render export image.'));
            return;
          }
          resolve(blob);
        }, mimeType, quality);
      });
    }

    const pngCrcTable = (() => {
      const table = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
          c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c >>> 0;
      }
      return table;
    })();

    function crc32OfBytes(bytes) {
      let crc = 0xFFFFFFFF;
      for (let i = 0; i < bytes.length; i++) {
        crc = pngCrcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
      }
      return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    function createPngChunk(type, data) {
      const dataBytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      const chunk = new Uint8Array(12 + dataBytes.length);
      const view = new DataView(chunk.buffer);
      view.setUint32(0, dataBytes.length, false);
      for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
      chunk.set(dataBytes, 8);
      const crc = crc32OfBytes(chunk.subarray(4, 8 + dataBytes.length));
      view.setUint32(8 + dataBytes.length, crc, false);
      return chunk;
    }

    function encodePng16Blob(imageData) {
      const width = imageData.width;
      const height = imageData.height;
      const src = imageData.data;
      const rowBytes = width * 4 * 2;
      const raw = new Uint8Array((rowBytes + 1) * height);
      let srcIndex = 0;
      let rawIndex = 0;
      for (let y = 0; y < height; y++) {
        raw[rawIndex++] = 0; // filter type: None
        for (let x = 0; x < width * 4; x++) {
          const u16 = src[srcIndex++] * 257;
          raw[rawIndex++] = (u16 >>> 8) & 0xFF;
          raw[rawIndex++] = u16 & 0xFF;
        }
      }

      const compressed = pako.deflate(raw, { level: 6 });
      const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
      const ihdr = new Uint8Array(13);
      const ihdrView = new DataView(ihdr.buffer);
      ihdrView.setUint32(0, width, false);
      ihdrView.setUint32(4, height, false);
      ihdr[8] = 16; // bit depth
      ihdr[9] = 6;  // RGBA
      ihdr[10] = 0; // compression
      ihdr[11] = 0; // filter
      ihdr[12] = 0; // interlace

      const ihdrChunk = createPngChunk('IHDR', ihdr);
      const idatChunk = createPngChunk('IDAT', compressed);
      const iendChunk = createPngChunk('IEND', new Uint8Array(0));

      const totalLength = signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length;
      const png = new Uint8Array(totalLength);
      let offset = 0;
      png.set(signature, offset); offset += signature.length;
      png.set(ihdrChunk, offset); offset += ihdrChunk.length;
      png.set(idatChunk, offset); offset += idatChunk.length;
      png.set(iendChunk, offset);

      return new Blob([png], { type: 'image/png' });
    }

    function encodeTiffBlob(imageData, bitDepth = 8) {
      const width = imageData.width;
      const height = imageData.height;
      const pixels = imageData.data;
      const channels = 4;
      const bytesPerSample = bitDepth === 16 ? 2 : 1;
      const stripByteCount = width * height * channels * bytesPerSample;
      const pixelData = new Uint8Array(stripByteCount);

      if (bitDepth === 16) {
        let p = 0;
        for (let i = 0; i < pixels.length; i++) {
          const value = pixels[i] * 257;
          pixelData[p++] = value & 0xFF;
          pixelData[p++] = (value >>> 8) & 0xFF;
        }
      } else {
        pixelData.set(pixels);
      }

      const headerSize = 8;
      const pixelOffset = headerSize;
      const ifdOffset = pixelOffset + pixelData.length;
      const entryCount = 12;
      const ifdSize = 2 + (entryCount * 12) + 4;
      const bitsArrayOffset = ifdOffset + ifdSize;
      const sampleFormatOffset = bitsArrayOffset + 8;
      const totalSize = sampleFormatOffset + 8;
      const out = new Uint8Array(totalSize);
      const view = new DataView(out.buffer);

      const writeU16 = (off, val) => view.setUint16(off, val, true);
      const writeU32 = (off, val) => view.setUint32(off, val, true);

      // Header
      out[0] = 0x49; out[1] = 0x49; // little-endian
      writeU16(2, 42);
      writeU32(4, ifdOffset);
      out.set(pixelData, pixelOffset);

      // IFD
      writeU16(ifdOffset, entryCount);
      let entryOffset = ifdOffset + 2;
      const writeEntry = (tag, type, count, valueOrOffset) => {
        writeU16(entryOffset, tag);
        writeU16(entryOffset + 2, type);
        writeU32(entryOffset + 4, count);
        writeU32(entryOffset + 8, valueOrOffset);
        entryOffset += 12;
      };
      const shortInline = (value) => value & 0xFFFF;

      writeEntry(256, 4, 1, width);                 // ImageWidth
      writeEntry(257, 4, 1, height);                // ImageLength
      writeEntry(258, 3, 4, bitsArrayOffset);       // BitsPerSample
      writeEntry(259, 3, 1, shortInline(1));        // Compression = none
      writeEntry(262, 3, 1, shortInline(2));        // Photometric = RGB
      writeEntry(273, 4, 1, pixelOffset);           // StripOffsets
      writeEntry(277, 3, 1, shortInline(channels)); // SamplesPerPixel
      writeEntry(278, 4, 1, height);                // RowsPerStrip
      writeEntry(279, 4, 1, stripByteCount);        // StripByteCounts
      writeEntry(284, 3, 1, shortInline(1));        // PlanarConfiguration
      writeEntry(338, 3, 1, shortInline(1));        // ExtraSamples (associated alpha)
      writeEntry(339, 3, 4, sampleFormatOffset);    // SampleFormat

      writeU32(entryOffset, 0); // next IFD offset

      // Extra value arrays
      const sampleBit = bitDepth === 16 ? 16 : 8;
      for (let i = 0; i < 4; i++) {
        writeU16(bitsArrayOffset + (i * 2), sampleBit);
        writeU16(sampleFormatOffset + (i * 2), 1); // unsigned integer
      }

      return new Blob([out], { type: 'image/tiff' });
    }

    function getEffectiveExportBitDepth(format = state.exportFormat, requestedBitDepth = state.exportBitDepth) {
      if (format === 'jpeg') return 8;
      return Number(requestedBitDepth) === 16 ? 16 : 8;
    }

    function getExportInfo(format = state.exportFormat, requestedBitDepth = state.exportBitDepth) {
      const normalizedFormat = format === 'jpeg' || format === 'tiff' ? format : 'png';
      const bitDepth = getEffectiveExportBitDepth(normalizedFormat, requestedBitDepth);
      if (normalizedFormat === 'jpeg') {
        return { format: normalizedFormat, bitDepth, extension: '.jpg', mimeType: 'image/jpeg' };
      }
      if (normalizedFormat === 'tiff') {
        return { format: normalizedFormat, bitDepth, extension: '.tiff', mimeType: 'image/tiff' };
      }
      return { format: 'png', bitDepth, extension: '.png', mimeType: 'image/png' };
    }

    function buildExportFileName(sourceName, exportInfo) {
      const withConverted = sourceName
        ? sourceName.replace(/\.[^.]+$/, '_converted')
        : 'converted_negative';
      const depthSuffix = exportInfo.bitDepth === 16 && exportInfo.format !== 'jpeg' ? '_16bit' : '';
      return `${withConverted}${depthSuffix}${exportInfo.extension}`;
    }

    async function getCurrentExportImageData() {
      if (state.displayImageData && state.currentStep >= 3) {
        return state.displayImageData;
      }
      if (state.processedImageData && state.currentStep >= 3) {
        return await applyAdjustmentsWithSettings(state.processedImageData, state);
      }
      if (canvas.width > 0 && canvas.height > 0) {
        return ctx.getImageData(0, 0, canvas.width, canvas.height);
      }
      return null;
    }

    function notifyExportError(err) {
      console.error('Export failed:', err);
      const message = err && err.message ? err.message : String(err || 'Unknown error');
      alert(`Export failed: ${message}`);
    }

    async function exportSingle() {
      const lang = i18n[currentLang];
      const overlay = getLoadingOverlay();
      const exportInfo = getExportInfo();
      let fileName = buildExportFileName(null, exportInfo);
      let blob;

      await overlay.show({ title: lang.loadingExporting });
      try {
        overlay.updateProgress(5, lang.loadingAdjusting);

        const currentItem = getCurrentQueueItem();
        if (currentItem && state.currentStep >= 3 && state.processedImageData) {
          persistCurrentFileSettings({ silent: true });
          const adjusted = await processFileWithSettings(currentItem.file, currentItem.settings);
          overlay.updateProgress(60, lang.loadingEncoding);
          blob = await imageDataToBlob(adjusted, exportInfo.format, state.jpegQuality, exportInfo.bitDepth, (pct) => {
            overlay.updateProgress(60 + pct * 0.35, lang.loadingEncoding);
          });
          fileName = buildExportFileName(currentItem.file.name, exportInfo);
        } else {
          ensureFullRender();
          overlay.updateProgress(50, lang.loadingEncoding);
          const imageData = await getCurrentExportImageData();
          if (!imageData) throw new Error('No image available for export.');
          blob = await imageDataToBlob(imageData, exportInfo.format, state.jpegQuality, exportInfo.bitDepth, (pct) => {
            overlay.updateProgress(50 + pct * 0.45, lang.loadingEncoding);
          });
        }

        overlay.updateProgress(100, lang.loadingComplete);
        await new Promise(r => setTimeout(r, 300));
      } finally {
        overlay.hide();
      }

      return await saveBlob(blob, fileName, exportInfo.mimeType);
    }

    document.getElementById('exportSingleBtn').addEventListener('click', async () => {
      try {
        await exportSingle();
      } catch (err) {
        notifyExportError(err);
      }
    });

    document.getElementById('exportZipBtn').addEventListener('click', async () => {
      try {
        await exportBatchAsZip();
      } catch (err) {
        notifyExportError(err);
      }
    });

    document.getElementById('exportAllBtn').addEventListener('click', async () => {
      try {
        await exportBatchIndividually();
      } catch (err) {
        notifyExportError(err);
      }
    });

    // Format toggle buttons
    document.querySelectorAll('.format-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.exportFormat = btn.dataset.format;
        updateExportUI();
      });
    });

    // Bit depth toggle buttons
    document.querySelectorAll('.bitdepth-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.classList.contains('disabled')) return;
        document.querySelectorAll('.bitdepth-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.exportBitDepth = parseInt(btn.dataset.bitdepth, 10) === 16 ? 16 : 8;
        updateExportUI();
      });
    });

    // Quality slider
    document.getElementById('exportQualitySlider').addEventListener('input', (e) => {
      state.jpegQuality = parseInt(e.target.value);
      document.getElementById('exportQualityValue').textContent = state.jpegQuality + '%';
    });

    function updateExportUI() {
      const format = state.exportFormat;
      const isJpeg = format === 'jpeg';
      if (isJpeg) state.exportBitDepth = 8;
      const qualitySection = document.getElementById('exportQualitySection');
      qualitySection.classList.toggle('show', isJpeg);

      const bitDepthNote = document.getElementById('exportBitDepthNote');
      bitDepthNote.classList.toggle('show', isJpeg);
      document.querySelectorAll('.bitdepth-btn').forEach(btn => {
        const depth = parseInt(btn.dataset.bitdepth, 10) === 16 ? 16 : 8;
        const disabled = isJpeg && depth === 16;
        btn.classList.toggle('disabled', disabled);
        btn.classList.toggle('active', depth === state.exportBitDepth);
      });

      // Update export button text
      const exportBtn = document.getElementById('exportBtn');
      const exportKey = isJpeg ? 'exportJpeg' : (format === 'tiff' ? 'exportTiff' : 'exportPng');
      exportBtn.textContent = i18n[currentLang][exportKey];
      exportBtn.setAttribute('data-i18n', exportKey);

      // Update export current button text
      const exportSingleBtn = document.getElementById('exportSingleBtn');
      const exportSingleKey = isJpeg ? 'exportCurrentJpeg' : (format === 'tiff' ? 'exportCurrentTiff' : 'exportCurrent');
      exportSingleBtn.textContent = i18n[currentLang][exportSingleKey];
      exportSingleBtn.setAttribute('data-i18n', exportSingleKey);

      const bitDepthButtons = document.querySelectorAll('.bitdepth-btn');
      bitDepthButtons.forEach((btn) => {
        const depth = parseInt(btn.dataset.bitdepth, 10) === 16 ? 16 : 8;
        btn.textContent = depth === 16 ? '16-bit' : '8-bit';
      });
    }

    updateExportUI();

    // ===========================================
    // Batch Processing
    // ===========================================
    function extractCurrentSettings() {
      const safe = sanitizeSettings(state, { fallbackSettings: state });
      return {
        cropRegion: safe.cropRegion ? { ...safe.cropRegion } : null,
        rotationAngle: safe.rotationAngle || 0,
        autoFrameMeta: state.autoFrame.lastDiagnostics ? { ...state.autoFrame.lastDiagnostics } : null,
        filmType: safe.filmType,
        filmBase: { ...safe.filmBase },
        lensCorrection: {
          enabled: Boolean(safe.lensCorrection.enabled),
          selectedLens: safe.lensCorrection.selectedLens ? { ...safe.lensCorrection.selectedLens } : null,
          params: { ...safe.lensCorrection.params },
          modes: { ...safe.lensCorrection.modes },
          lastError: safe.lensCorrection.lastError || ''
        },
        coreFilmPreset: safe.coreFilmPreset,
        coreColorModel: safe.coreColorModel,
        coreEnhancedProfile: safe.coreEnhancedProfile,
        coreProfileStrength: safe.coreProfileStrength,
        corePreSaturation: safe.corePreSaturation,
        coreBorderBuffer: safe.coreBorderBuffer,
        coreBorderBufferBorderValue: safe.coreBorderBufferBorderValue,
        coreBrightness: safe.coreBrightness,
        coreExposure: safe.coreExposure,
        coreContrast: safe.coreContrast,
        coreHighlights: safe.coreHighlights,
        coreShadows: safe.coreShadows,
        coreWhites: safe.coreWhites,
        coreBlacks: safe.coreBlacks,
        coreWbMode: safe.coreWbMode,
        coreTemperature: safe.coreTemperature,
        coreTint: safe.coreTint,
        coreSaturation: safe.coreSaturation,
        coreGlow: safe.coreGlow,
        coreFade: safe.coreFade,
        coreCurvePrecision: safe.coreCurvePrecision,
        coreUseWebGL: safe.coreUseWebGL,
        exposure: safe.exposure,
        contrast: safe.contrast,
        highlights: safe.highlights,
        shadows: safe.shadows,
        temperature: safe.temperature,
        tint: safe.tint,
        vibrance: safe.vibrance,
        saturation: safe.saturation,
        cyan: safe.cyan,
        magenta: safe.magenta,
        yellow: safe.yellow,
        wbR: safe.wbR,
        wbG: safe.wbG,
        wbB: safe.wbB,
        curvePoints: {
          r: safe.curvePoints.r.map(p => ({ ...p })),
          g: safe.curvePoints.g.map(p => ({ ...p })),
          b: safe.curvePoints.b.map(p => ({ ...p }))
        },
        curves: {
          r: new Uint8Array(safe.curves.r),
          g: new Uint8Array(safe.curves.g),
          b: new Uint8Array(safe.curves.b)
        }
      };
    }

    function cloneSettings(settings) {
      if (!settings) return null;
      const safe = sanitizeSettings(settings, { fallbackSettings: state });
      return {
        cropRegion: safe.cropRegion ? { ...safe.cropRegion } : null,
        rotationAngle: safe.rotationAngle,
        autoFrameMeta: safe.autoFrameMeta ? { ...safe.autoFrameMeta } : null,
        filmType: safe.filmType,
        filmBase: { ...safe.filmBase },
        lensCorrection: {
          enabled: Boolean(safe.lensCorrection.enabled),
          selectedLens: safe.lensCorrection.selectedLens ? { ...safe.lensCorrection.selectedLens } : null,
          params: { ...safe.lensCorrection.params },
          modes: { ...safe.lensCorrection.modes },
          lastError: safe.lensCorrection.lastError || ''
        },
        coreFilmPreset: safe.coreFilmPreset,
        coreColorModel: safe.coreColorModel,
        coreEnhancedProfile: safe.coreEnhancedProfile,
        coreProfileStrength: safe.coreProfileStrength,
        corePreSaturation: safe.corePreSaturation,
        coreBorderBuffer: safe.coreBorderBuffer,
        coreBorderBufferBorderValue: safe.coreBorderBufferBorderValue,
        coreBrightness: safe.coreBrightness,
        coreExposure: safe.coreExposure,
        coreContrast: safe.coreContrast,
        coreHighlights: safe.coreHighlights,
        coreShadows: safe.coreShadows,
        coreWhites: safe.coreWhites,
        coreBlacks: safe.coreBlacks,
        coreWbMode: safe.coreWbMode,
        coreTemperature: safe.coreTemperature,
        coreTint: safe.coreTint,
        coreSaturation: safe.coreSaturation,
        coreGlow: safe.coreGlow,
        coreFade: safe.coreFade,
        coreCurvePrecision: safe.coreCurvePrecision,
        coreUseWebGL: safe.coreUseWebGL,
        exposure: safe.exposure,
        contrast: safe.contrast,
        highlights: safe.highlights,
        shadows: safe.shadows,
        temperature: safe.temperature,
        tint: safe.tint,
        vibrance: safe.vibrance,
        saturation: safe.saturation,
        cyan: safe.cyan,
        magenta: safe.magenta,
        yellow: safe.yellow,
        wbR: safe.wbR,
        wbG: safe.wbG,
        wbB: safe.wbB,
        curvePoints: {
          r: safe.curvePoints.r.map(p => ({ ...p })),
          g: safe.curvePoints.g.map(p => ({ ...p })),
          b: safe.curvePoints.b.map(p => ({ ...p }))
        },
        curves: {
          r: new Uint8Array(safe.curves.r),
          g: new Uint8Array(safe.curves.g),
          b: new Uint8Array(safe.curves.b)
        }
      };
    }

    function markCurrentFileDirty() {
      const item = getCurrentQueueItem();
      if (!item) return;
      if (item.isDirty) return;
      item.isDirty = true;
      if (state.batchSessionActive) {
        updateFileListUI();
      } else {
        updateCurrentFileLabel();
      }
    }

    function persistCurrentFileSettings(options = {}) {
      const { silent = false, force = false } = options;
      const item = getCurrentQueueItem();
      if (!item) return false;
      if (!state.originalImageData) return false;
      if (!force && !item.isDirty && item.settings) return false;

      item.settings = extractCurrentSettings();
      item.isDirty = false;
      updateFileListUI();

      if (!silent) {
        alert(i18n[currentLang].settingsSaved || 'Settings saved for current image');
      }
      return true;
    }

    function applySettingsToItems(baseSettings, items, options = {}) {
      const includeCrop = Boolean(options.includeCrop);
      const copied = cloneSettings(baseSettings);
      if (!copied) return 0;

      let count = 0;
      items.forEach(item => {
        const next = cloneSettings(copied);
        if (!includeCrop) {
          const existingCrop = item.settings && item.settings.cropRegion ? { ...item.settings.cropRegion } : null;
          const existingRotation = item.settings && Number.isFinite(item.settings.rotationAngle)
            ? item.settings.rotationAngle
            : 0;
          next.cropRegion = existingCrop;
          next.rotationAngle = existingRotation;
        }
        item.settings = next;
        item.isDirty = false;
        count++;
      });
      return count;
    }

    function applyCurrentSettingsToSelected() {
      if (state.currentStep < 3 || !state.processedImageData) {
        alert(i18n[currentLang].finishProcessing || 'Please complete the workflow (step 3) before saving settings.');
        return;
      }

      const selectedItems = state.fileQueue.filter(item => item.selected);
      if (selectedItems.length < 1) {
        alert(i18n[currentLang].noSelectedFiles || 'No selected images to apply settings.');
        return;
      }

      const baseSettings = extractCurrentSettings();
      applySettingsToItems(baseSettings, selectedItems, { includeCrop: false });

      updateFileListUI();
      const template = i18n[currentLang].appliedToSelected || 'Applied current settings to {count} image(s).';
      alert(template.replace('{count}', String(selectedItems.length)));
    }

    function setRollReferenceFromCurrent() {
      if (state.currentStep < 3 || !state.processedImageData) {
        alert(i18n[currentLang].finishProcessing || 'Please complete the workflow (step 3) before saving settings.');
        return;
      }
      const currentItem = getCurrentQueueItem();
      state.rollReference.enabled = true;
      state.rollReference.sourceFileId = currentItem ? currentItem.id : null;
      state.rollReference.settingsSnapshot = extractCurrentSettings();
      persistCurrentFileSettings({ silent: true, force: true });
      updateRollReferenceUI();
      updateStep2GuideCard({ skipFirstHint: true });
      alert(i18n[currentLang].rollReferenceSet || 'Current image has been set as the roll reference.');
    }

    function applyRollReferenceToSelected() {
      if (!hasRollReference()) {
        alert(i18n[currentLang].rollReferenceMissing || 'No roll reference is set.');
        return;
      }
      const selectedItems = state.fileQueue.filter(item => item.selected);
      if (selectedItems.length < 1) {
        alert(i18n[currentLang].noSelectedFiles || 'No selected images to apply settings.');
        return;
      }
      const applied = applySettingsToItems(
        state.rollReference.settingsSnapshot,
        selectedItems,
        { includeCrop: state.rollReference.applyCrop }
      );

      const currentItem = getCurrentQueueItem();
      if (currentItem && currentItem.selected && currentItem.settings) {
        restoreSettings(currentItem.settings);
        if (state.currentStep >= 3 && state.originalImageData) {
          void processNegative();
        }
      }

      updateFileListUI();
      const template = i18n[currentLang].rollReferenceApplied || 'Applied roll reference to {count} image(s).';
      alert(template.replace('{count}', String(applied)));
    }

    function clearRollReference() {
      resetRollReferenceState();
      updateRollReferenceUI();
      updateStep2GuideCard({ skipFirstHint: true });
      alert(i18n[currentLang].rollReferenceCleared || 'Roll reference cleared.');
    }

    function getSettingsForExport(index, item) {
      if (!item) return null;
      if (index === state.currentFileIndex && (item.isDirty || !item.settings)) {
        persistCurrentFileSettings({ silent: true, force: true });
      }
      return item.settings || null;
    }

    async function applyAdjustmentsWithSettings(imageData, settings) {
      const safeSettings = sanitizeSettings(settings, {
        fallbackSettings: state,
        includeCurvePoints: false,
        includeCurves: true
      });

      // Try Worker for large images (>1MP)
      if (isWorkerAvailable() && imageData.width * imageData.height > 1_000_000) {
        // Mirror the useLegacyTone logic from applyAdjustmentsToBuffer
        const workerSettings = { ...safeSettings };
        if (usesSilverCoreConversion(safeSettings)) {
          workerSettings.exposure = 0;
          workerSettings.contrast = 0;
          workerSettings.highlights = 0;
          workerSettings.shadows = 0;
          workerSettings.temperature = 0;
          workerSettings.tint = 0;
          workerSettings.saturation = 0;
        }
        const result = await workerApplyAdjustments(imageData, workerSettings, 'full');
        if (result) return result;
      }

      // Fallback to main thread
      const output = new ImageData(new Uint8ClampedArray(imageData.data.length), imageData.width, imageData.height);
      applyAdjustmentsToBuffer(imageData, safeSettings, output, 'full');
      return output;
    }

    function sanitizeCropRegionForImage(cropRegion, imageData) {
      if (!cropRegion || !imageData) return null;
      const imageWidth = imageData.width | 0;
      const imageHeight = imageData.height | 0;
      if (imageWidth < 1 || imageHeight < 1) return null;

      const leftRaw = Number(cropRegion.left);
      const topRaw = Number(cropRegion.top);
      const widthRaw = Number(cropRegion.width);
      const heightRaw = Number(cropRegion.height);
      if (!Number.isFinite(leftRaw) || !Number.isFinite(topRaw) || !Number.isFinite(widthRaw) || !Number.isFinite(heightRaw)) {
        return null;
      }

      const left = clampBetween(Math.floor(leftRaw), 0, imageWidth - 1);
      const top = clampBetween(Math.floor(topRaw), 0, imageHeight - 1);
      const maxWidth = imageWidth - left;
      const maxHeight = imageHeight - top;
      if (maxWidth < 1 || maxHeight < 1) return null;

      const width = clampBetween(Math.floor(widthRaw), 1, maxWidth);
      const height = clampBetween(Math.floor(heightRaw), 1, maxHeight);
      if (width < 1 || height < 1) return null;

      return { left, top, width, height };
    }

    function applyCropRegionToLoadedImage(cropRegion, options = {}) {
      const { refreshDisplay = false } = options;
      if (!state.originalImageData) {
        state.cropRegion = null;
        state.croppedImageData = null;
        return false;
      }

      const sanitized = sanitizeCropRegionForImage(cropRegion, state.originalImageData);
      state.cropRegion = sanitized;
      state.croppedImageData = sanitized ? cropImageData(state.originalImageData, sanitized) : null;

      if (refreshDisplay) {
        displayNegative(state.croppedImageData || state.originalImageData);
      }
      return Boolean(sanitized);
    }

    function cropImageData(imageData, cropRegion) {
      const sanitized = sanitizeCropRegionForImage(cropRegion, imageData);
      if (!sanitized) return imageData;
      const { left, top, width, height } = sanitized;
      const croppedData = new ImageData(
        new Uint8ClampedArray(width * height * 4),
        width,
        height
      );

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const srcIdx = ((top + y) * imageData.width + left + x) * 4;
          const dstIdx = (y * width + x) * 4;
          croppedData.data[dstIdx] = imageData.data[srcIdx];
          croppedData.data[dstIdx + 1] = imageData.data[srcIdx + 1];
          croppedData.data[dstIdx + 2] = imageData.data[srcIdx + 2];
          croppedData.data[dstIdx + 3] = 255;
        }
      }

      return croppedData;
    }

    async function loadFileToImageData(file) {
      const arrayBuffer = await file.arrayBuffer();
      const fileName = file.name.toLowerCase();

      if (['.cr2', '.nef', '.arw', '.dng', '.raw', '.rw2', '.tif', '.tiff'].some(ext => fileName.endsWith(ext))) {
        return await loadRawFile(arrayBuffer, fileName);
      } else if (file.type === 'image/png') {
        return loadPngFile(arrayBuffer);
      } else {
        return await loadStandardImage(file);
      }
    }

    async function imageDataToBlob(imageData, format = null, quality = null, bitDepth = null, onProgress = null) {
      const exportInfo = getExportInfo(format || state.exportFormat, bitDepth ?? state.exportBitDepth);
      const jpegQuality = quality !== null ? quality : state.jpegQuality;

      if (exportInfo.format === 'tiff') {
        // Try Worker first for TIFF encoding
        if (isWorkerAvailable()) {
          const workerBlob = await workerEncodeTiff(imageData, exportInfo.bitDepth, onProgress);
          if (workerBlob) return workerBlob;
        }
        return encodeTiffBlob(imageData, exportInfo.bitDepth);
      }
      if (exportInfo.format === 'png' && exportInfo.bitDepth === 16) {
        // Try Worker first for 16-bit PNG encoding
        if (isWorkerAvailable()) {
          const workerBlob = await workerEncodePng16(imageData, onProgress);
          if (workerBlob) return workerBlob;
        }
        return encodePng16Blob(imageData);
      }

      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = imageData.width;
      tempCanvas.height = imageData.height;
      const tempCtx = tempCanvas.getContext('2d');
      tempCtx.putImageData(imageData, 0, 0);

      if (exportInfo.format === 'jpeg') {
        return canvasToBlobWithType(tempCanvas, 'image/jpeg', jpegQuality / 100);
      }
      return canvasToBlobWithType(tempCanvas, 'image/png');
    }

    function updateBatchProgress(current, total, fileName) {
      const percent = Math.round((current / total) * 100);
      document.getElementById('batchProgressFill').style.width = percent + '%';
      document.getElementById('batchProgressText').textContent = `${current} / ${total}`;
      document.getElementById('batchProgressCurrent').textContent = fileName || '';
    }

    function showBatchProgress(show) {
      document.getElementById('batchProgressOverlay').style.display = show ? 'flex' : 'none';
    }

    // Process a single file with given settings (streaming - no memory accumulation)
    async function processOneFile(file, settings) {
      const safeSettings = sanitizeSettings(settings, { fallbackSettings: state });
      const imageData = await loadFileToImageData(file);

      let workingData = imageData;
      const rotationAngle = Number.isFinite(safeSettings.rotationAngle) ? safeSettings.rotationAngle : 0;
      if (Math.abs(rotationAngle) > 0.001) {
        workingData = applyRotationToImageData(workingData, rotationAngle);
      }
      if (safeSettings.cropRegion) {
        const cropRegion = sanitizeCropRegionForImage(safeSettings.cropRegion, workingData);
        if (cropRegion) {
          workingData = cropImageData(workingData, cropRegion);
        }
      }
      workingData = await applyLensCorrectionWithSettings(workingData, safeSettings, { updateUi: false });

      const processed = await convertFrameWithRouter({
        imageData: workingData,
        settings: buildRouterSettings(safeSettings)
      });

      return applyAdjustmentsWithSettings(processed, safeSettings);
    }

    // Get selected files for batch processing
    function getSelectedFiles() {
      return state.fileQueue
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => item.selected);
    }

    // Create default settings with auto-detected film base
    function createDefaultSettings(imageData) {
      const filmBase = autoDetectFilmBase(imageData, 10);
      return {
        cropRegion: null,
        rotationAngle: 0,
        autoFrameMeta: null,
        filmType: 'color',
        filmBase: filmBase,
        lensCorrection: createDefaultLensCorrectionSettings(),
        coreFilmPreset: 'none',
        coreColorModel: 'standard',
        coreEnhancedProfile: 'none',
        coreProfileStrength: 100,
        corePreSaturation: 100,
        coreBorderBuffer: 10,
        coreBorderBufferBorderValue: 10,
        coreBrightness: 0,
        coreExposure: 0,
        coreContrast: 0,
        coreHighlights: 0,
        coreShadows: 0,
        coreWhites: 0,
        coreBlacks: 0,
        coreWbMode: 'auto',
        coreTemperature: 0,
        coreTint: 0,
        coreSaturation: 100,
        coreGlow: 0,
        coreFade: 0,
        coreCurvePrecision: 'auto',
        coreUseWebGL: true,
        exposure: 0,
        contrast: 0,
        highlights: 0,
        shadows: 0,
        temperature: 0,
        tint: 0,
        vibrance: 0,
        saturation: 0,
        cyan: 0,
        magenta: 0,
        yellow: 0,
        wbR: 1,
        wbG: 1,
        wbB: 1,
        curvePoints: {
          r: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
          g: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
          b: [{ x: 0, y: 0 }, { x: 255, y: 255 }]
        },
        curves: {
          r: makeLinearCurveLut(),
          g: makeLinearCurveLut(),
          b: makeLinearCurveLut()
        }
      };
    }

    // Process a file with its own settings or auto-detect
    async function processFileWithSettings(file, savedSettings) {
      // Load the image
      const imageData = await loadFileToImageData(file);

      // Use saved settings or create default with auto-detect
      const settings = sanitizeSettings(savedSettings || createDefaultSettings(imageData), {
        fallbackSettings: state
      });

      // Apply crop if set
      let workingData = imageData;
      const rotationAngle = Number.isFinite(settings.rotationAngle) ? settings.rotationAngle : 0;
      if (Math.abs(rotationAngle) > 0.001) {
        workingData = applyRotationToImageData(workingData, rotationAngle);
      }
      if (settings.cropRegion) {
        const cropRegion = sanitizeCropRegionForImage(settings.cropRegion, workingData);
        if (cropRegion) {
          workingData = cropImageData(workingData, cropRegion);
        }
      }
      workingData = await applyLensCorrectionWithSettings(workingData, settings, { updateUi: false });

      // Convert negative/positive via unified conversion router.
      let processed = await convertFrameWithRouter({
        imageData: workingData,
        settings: buildRouterSettings(settings)
      });

      // Apply dust removal if enabled (full resolution for export)
      if (state.dustRemoval.enabled && processed) {
        await ensureOpenCvReady();
        const { mask } = detectDust(processed, { strength: state.dustRemoval.strength });
        processed = inpaintMasked(processed, mask, 3);
      }

      // Apply adjustments
      return applyAdjustmentsWithSettings(processed, settings);
    }

    // Streaming ZIP export: process → add to zip → free memory → next
    async function exportBatchAsZip() {
      const selectedFiles = getSelectedFiles();
      if (selectedFiles.length < 1) return;

      if (typeof JSZipCtor !== 'function') {
        throw new Error('JSZip module is unavailable');
      }
      const zip = new JSZipCtor();
      const exportInfo = getExportInfo();
      let processedCount = 0;
      const lang = i18n[currentLang];
      const overlay = getLoadingOverlay();
      const total = selectedFiles.length;

      await overlay.show({ title: lang.loadingExporting });

      try {
        for (const { item, index } of selectedFiles) {
          item.status = 'processing';
          updateFileListUI();
          processedCount++;
          const fileProgress = ((processedCount - 1) / total) * 90;
          const fileSlice = 90 / total;
          overlay.updateProgress(fileProgress, lang.loadingBatchFile.replace('{current}', processedCount).replace('{total}', total));

          try {
            const settingsForFile = getSettingsForExport(index, item);
            const adjusted = await processFileWithSettings(item.file, settingsForFile);
            overlay.updateProgress(fileProgress + fileSlice * 0.6, lang.loadingEncoding);
            const blob = await imageDataToBlob(
              adjusted,
              exportInfo.format,
              state.jpegQuality,
              exportInfo.bitDepth
            );

            const name = buildExportFileName(item.file.name, exportInfo);
            zip.file(name, blob);
            item.status = 'done';
          } catch (err) {
            console.error(`Error processing ${item.file.name}:`, err);
            item.status = 'error';
            item.error = err.message;
          }

          overlay.updateProgress(fileProgress + fileSlice, lang.loadingBatchFile.replace('{current}', processedCount).replace('{total}', total));
          updateFileListUI();
          await new Promise(r => setTimeout(r, 10));
        }

        overlay.updateProgress(92, lang.loadingBatchZip);
        const zipBlob = await zip.generateAsync({
          type: 'blob',
          compression: 'DEFLATE',
          compressionOptions: { level: 6 }
        });

        overlay.updateProgress(100, lang.loadingComplete);
        await new Promise(r => setTimeout(r, 300));
        await saveBlob(zipBlob, 'converted_negatives.zip', 'application/zip');
      } finally {
        overlay.hide();
      }
    }

    // Streaming individual download: process → download → free → next
    async function exportBatchIndividually() {
      const selectedFiles = getSelectedFiles();
      if (selectedFiles.length < 1) return;

      const exportInfo = getExportInfo();
      let processedCount = 0;
      let cancelledByUser = false;
      const lang = i18n[currentLang];
      const overlay = getLoadingOverlay();
      const total = selectedFiles.length;

      await overlay.show({ title: lang.loadingExporting });

      try {
        for (const { item, index } of selectedFiles) {
          item.status = 'processing';
          updateFileListUI();
          processedCount++;
          const fileProgress = ((processedCount - 1) / total) * 100;
          const fileSlice = 100 / total;
          overlay.updateProgress(fileProgress, lang.loadingBatchFile.replace('{current}', processedCount).replace('{total}', total));

          try {
            const settingsForFile = getSettingsForExport(index, item);
            const adjusted = await processFileWithSettings(item.file, settingsForFile);
            overlay.updateProgress(fileProgress + fileSlice * 0.6, lang.loadingEncoding);
            const blob = await imageDataToBlob(
              adjusted,
              exportInfo.format,
              state.jpegQuality,
              exportInfo.bitDepth
            );

            const name = buildExportFileName(item.file.name, exportInfo);
            overlay.hide(); // Hide overlay before save dialog
            const result = await saveBlob(blob, name, exportInfo.mimeType);
            if (!result.saved) {
              cancelledByUser = true;
              item.status = 'pending';
              item.error = null;
              updateFileListUI();
              break;
            }
            // Re-show overlay for next file
            if (processedCount < total) {
              await overlay.show({ title: lang.loadingExporting });
            }

            item.status = 'done';
          } catch (err) {
            console.error(`Error processing ${item.file.name}:`, err);
            item.status = 'error';
          }

          updateFileListUI();
          await new Promise(r => setTimeout(r, 100));
        }
        if (cancelledByUser) {
          console.info('Batch individual export cancelled by user.');
        }
      } finally {
        overlay.hide();
      }
    }

    // ===========================================
    // File List UI
    // ===========================================
    function updateFileListUI() {
      const container = document.getElementById('fileListItems');
      const countEl = document.getElementById('fileListCount');
      const selectedCount = state.fileQueue.filter(f => f.selected).length;
      const settingsCount = state.fileQueue.filter(f => f.settings).length;

      // Show: selected/total (settings saved count)
      countEl.textContent = `${selectedCount}/${state.fileQueue.length} (${settingsCount} ${i18n[currentLang].configured || 'configured'})`;
      container.innerHTML = '';

      state.fileQueue.forEach((item, index) => {
        const el = document.createElement('div');
        el.className = 'file-list-item';
        if (index === state.currentFileIndex) el.classList.add('active');
        if (item.settings) el.classList.add('has-settings');
        if (item.isDirty) el.classList.add('is-dirty');

        const statusClass = item.status;
        const statusText = i18n[currentLang][item.status === 'processing' ? 'processingStatus' : item.status] || item.status;
        const settingsBadge = item.settings ? `<span class="file-list-settings-badge">${i18n[currentLang].customSettings || 'Custom'}</span>` : '';
        const unsavedBadge = item.isDirty ? `<span class="file-list-unsaved-badge">${i18n[currentLang].unsaved || 'Unsaved'}</span>` : '';

        el.innerHTML = `
          <input type="checkbox" class="file-list-checkbox" ${item.selected ? 'checked' : ''} data-index="${index}">
          <span class="file-list-name">${item.file.name}${settingsBadge}${unsavedBadge}</span>
          <span class="file-list-status ${statusClass}">${statusText}</span>
        `;

        // Checkbox toggle
        el.querySelector('.file-list-checkbox').addEventListener('click', (e) => {
          e.stopPropagation();
          state.fileQueue[index].selected = e.target.checked;
          updateFileListUI();
          updateExportButtons();
        });

        // Click on item to view/edit
        el.addEventListener('click', (e) => {
          if (e.target.classList.contains('file-list-checkbox')) return;
          switchToFile(index);
        });

        container.appendChild(el);
      });

      updateAutoFrameButtons();
      syncBatchUIState({ reason: 'updateFileListUI' });
    }

    async function switchToFile(index) {
      if (index < 0 || index >= state.fileQueue.length) return;
      if (index === state.currentFileIndex) return;

      clearUndoHistory();
      resetZoomPan();
      persistCurrentFileSettings({ silent: true });
      state.currentFileIndex = index;
      const fileItem = state.fileQueue[index];

      // Load the file
      await loadFile(fileItem.file);

      // If this file has saved settings, restore them
      if (fileItem.settings) {
        restoreSettings(fileItem.settings);
        fileItem.isDirty = false;
      }

      updateFileListUI();
    }

    // Save current settings to the current file's queue entry
    function saveCurrentFileSettings() {
      persistCurrentFileSettings({ silent: false, force: true });
    }

    // Restore settings from a saved settings object
    function restoreSettings(settings) {
      if (!settings) return;
      const safe = sanitizeSettings(settings, { fallbackSettings: state });

      state.rotationAngle = Number.isFinite(safe.rotationAngle) ? normalizeAngleDegrees(safe.rotationAngle) : 0;

      if (state.loadedBaseImageData) {
        state.originalImageData = state.loadedBaseImageData;
      }

      if (state.originalImageData && Math.abs(state.rotationAngle) > 0.001) {
        state.originalImageData = applyRotationToImageData(state.originalImageData, state.rotationAngle);
      }

      // Restore crop region after rotation
      applyCropRegionToLoadedImage(safe.cropRegion, { refreshDisplay: true });
      if (state.originalImageData) {
        safe.rotationAngle = state.rotationAngle;
        safe.cropRegion = state.cropRegion ? { ...state.cropRegion } : null;
      }

      if (safe.autoFrameMeta) {
        const restoredMode = safe.autoFrameMeta.appliedMode
          || (Boolean(safe.autoFrameMeta.rotateOnly) ? 'rotateOnly' : 'none');
        state.autoFrame.lastDiagnostics = {
          confidence: safe.autoFrameMeta.confidence,
          detectedFormat: safe.autoFrameMeta.detectedFormat || 'unknown',
          method: safe.autoFrameMeta.method || 'unknown',
          confidenceLevel: safe.autoFrameMeta.confidenceLevel || inferConfidenceLevel(safe.autoFrameMeta.confidence || 0),
          rotateOnly: restoredMode === 'rotateOnly',
          appliedMode: restoredMode,
          lowConfidenceApplied: Boolean(safe.autoFrameMeta.lowConfidenceApplied)
        };
      } else {
        state.autoFrame.lastDiagnostics = null;
      }
      updateAutoFrameDiagnosticsUI();

      // Restore film settings
      state.filmType = sanitizePresetType(safe.filmType || 'color');
      state.filmBase = { ...safe.filmBase };
      state.filmBaseSet = true;
      state.lensCorrection.enabled = Boolean(safe.lensCorrection.enabled);
      state.lensCorrection.selectedLens = safe.lensCorrection.selectedLens ? { ...safe.lensCorrection.selectedLens } : null;
      state.lensCorrection.params = { ...safe.lensCorrection.params };
      state.lensCorrection.modes = { ...safe.lensCorrection.modes };
      state.lensCorrection.lastError = safe.lensCorrection.lastError || '';
      if (state.lensCorrection.selectedLens) {
        state.lensCorrection.search.lensModel = state.lensCorrection.selectedLens.model || state.lensCorrection.search.lensModel;
        state.lensCorrection.search.lensMaker = state.lensCorrection.selectedLens.maker || state.lensCorrection.search.lensMaker;
      }
      state.lensCorrection.statusKey = state.lensCorrection.enabled
        ? (state.lensCorrection.selectedLens ? 'lensStatusSelected' : 'lensStatusNeedProfile')
        : 'lensStatusSkipped';
      state.lensCorrection.statusVars = state.lensCorrection.selectedLens
        ? { lens: formatLensLabel(state.lensCorrection.selectedLens) }
        : {};

      // Restore adjustments
      state.coreFilmPreset = safe.coreFilmPreset || 'none';
      state.coreColorModel = safe.coreColorModel;
      state.coreEnhancedProfile = safe.coreEnhancedProfile;
      state.coreProfileStrength = safe.coreProfileStrength;
      state.corePreSaturation = safe.corePreSaturation;
      state.coreBorderBuffer = safe.coreBorderBuffer;
      state.coreBorderBufferBorderValue = safe.coreBorderBufferBorderValue;
      state.coreBrightness = safe.coreBrightness;
      state.coreExposure = safe.coreExposure;
      state.coreContrast = safe.coreContrast;
      state.coreHighlights = safe.coreHighlights;
      state.coreShadows = safe.coreShadows;
      state.coreWhites = safe.coreWhites;
      state.coreBlacks = safe.coreBlacks;
      state.coreWbMode = safe.coreWbMode;
      state.coreTemperature = safe.coreTemperature;
      state.coreTint = safe.coreTint;
      state.coreSaturation = safe.coreSaturation;
      state.coreGlow = safe.coreGlow;
      state.coreFade = safe.coreFade;
      state.coreCurvePrecision = safe.coreCurvePrecision;
      state.coreUseWebGL = safe.coreUseWebGL;

      state.exposure = safe.exposure;
      state.contrast = safe.contrast;
      state.highlights = safe.highlights;
      state.shadows = safe.shadows;
      state.temperature = safe.temperature;
      state.tint = safe.tint;
      state.vibrance = safe.vibrance;
      state.saturation = safe.saturation;
      state.cyan = safe.cyan;
      state.magenta = safe.magenta;
      state.yellow = safe.yellow;
      state.wbR = safe.wbR;
      state.wbG = safe.wbG;
      state.wbB = safe.wbB;

      // Restore curves
      state.curvePoints = {
        r: safe.curvePoints.r.map(p => ({ ...p })),
        g: safe.curvePoints.g.map(p => ({ ...p })),
        b: safe.curvePoints.b.map(p => ({ ...p }))
      };
      ['r', 'g', 'b'].forEach(ch => updateCurveFromPoints(ch));

      // Update UI to reflect restored settings
      updateSlidersFromState();
      renderCurve();
      updateLensCorrectionUI();
    }

    // Update all slider UI elements from state
    function updateSlidersFromState() {
      syncAllSlidersFromState();
      syncAllSelectsFromState();
      syncAllCheckboxesFromState();

      // Update film type buttons
      setFilmTypeButtons(state.filmType);
      updateFilmModeUI();
      updateLensCorrectionUI();
    }

    function updateExportButtons() {
      // Enable batch export when there are selected files
      const selectedCount = state.fileQueue.filter(f => f.selected).length;
      document.getElementById('exportZipBtn').disabled = selectedCount < 1;
      document.getElementById('exportAllBtn').disabled = selectedCount < 1;
      updateAutoFrameButtons();
    }

    function normalizeAutoFrame120Options() {
      const map = state.autoFrame.allowed120Formats || {};
      const anyEnabled = AUTO_FRAME_DEFAULT_120_FORMATS.some(fmt => map[fmt] !== false);
      if (!anyEnabled) {
        map['6x6'] = true;
      }
      AUTO_FRAME_DEFAULT_120_FORMATS.forEach(fmt => {
        if (typeof map[fmt] !== 'boolean') {
          map[fmt] = true;
        }
      });
      state.autoFrame.allowed120Formats = map;
    }

    function updateAutoFrameConfigUI() {
      const enabledInput = document.getElementById('autoFrameEnabledInput');
      const autoApplyInput = document.getElementById('autoFrameAutoApplyInput');
      const formatSelect = document.getElementById('autoFrameFormatSelect');
      const lowSelect = document.getElementById('autoFrameLowConfidenceSelect');
      const option645 = document.getElementById('autoFrame120_645');
      const option66 = document.getElementById('autoFrame120_66');
      const option67 = document.getElementById('autoFrame120_67');
      const option69 = document.getElementById('autoFrame120_69');
      const optionsContainer = document.getElementById('autoFrame120Options');
      if (!enabledInput || !autoApplyInput || !formatSelect || !lowSelect) return;

      normalizeAutoFrame120Options();
      enabledInput.checked = Boolean(state.autoFrame.enabled);
      autoApplyInput.checked = Boolean(state.autoFrame.autoApplyHighConfidence);
      formatSelect.value = state.autoFrame.formatPreference || 'auto';
      lowSelect.value = state.autoFrame.lowConfidenceBehavior || 'suggest';
      if (option645) option645.checked = state.autoFrame.allowed120Formats['6x4.5'] !== false;
      if (option66) option66.checked = state.autoFrame.allowed120Formats['6x6'] !== false;
      if (option67) option67.checked = state.autoFrame.allowed120Formats['6x7'] !== false;
      if (option69) option69.checked = state.autoFrame.allowed120Formats['6x9'] !== false;
      if (optionsContainer) {
        optionsContainer.style.opacity = formatSelect.value === '135' ? '0.55' : '1';
      }
    }

    function formatDetectedFormatLabel(formatKey) {
      if (!formatKey || formatKey === 'unknown') return 'unknown';
      if (formatKey === '135') return '135';
      if (String(formatKey).startsWith('120-')) return formatKey.replace('120-', '120 ');
      return String(formatKey);
    }

    function formatAppliedModeLabel(mode) {
      const normalized = mode === 'crop' || mode === 'rotateOnly' ? mode : 'none';
      if (normalized === 'crop') {
        return getLocalizedText('autoFrameModeCrop', 'Crop');
      }
      if (normalized === 'rotateOnly') {
        return getLocalizedText('autoFrameModeRotateOnly', 'Rotate only');
      }
      return getLocalizedText('autoFrameModeNone', 'None');
    }

    function updateAutoFrameDiagnosticsUI() {
      const box = document.getElementById('autoFrameDiagnosticsBox');
      if (!box) return;
      const diag = state.autoFrame.lastDiagnostics;
      if (!diag) {
        box.style.display = 'none';
        box.textContent = '';
        return;
      }
      const template = i18n[currentLang].autoFrameDiagnostics
        || 'Detection: method {method} | format {format} | confidence {confidence}';
      const appliedMode = diag.appliedMode || (diag.rotateOnly ? 'rotateOnly' : 'none');
      box.textContent = template
        .replace('{method}', String(diag.method || 'unknown'))
        .replace('{format}', formatDetectedFormatLabel(diag.detectedFormat))
        .replace('{confidence}', Number.isFinite(diag.confidence) ? diag.confidence.toFixed(2) : '0.00')
        .replace('{mode}', formatAppliedModeLabel(appliedMode));
      box.style.display = 'block';
    }

    function applyAutoFrameConfigFromUI() {
      const enabledInput = document.getElementById('autoFrameEnabledInput');
      const autoApplyInput = document.getElementById('autoFrameAutoApplyInput');
      const formatSelect = document.getElementById('autoFrameFormatSelect');
      const lowSelect = document.getElementById('autoFrameLowConfidenceSelect');
      const option645 = document.getElementById('autoFrame120_645');
      const option66 = document.getElementById('autoFrame120_66');
      const option67 = document.getElementById('autoFrame120_67');
      const option69 = document.getElementById('autoFrame120_69');

      if (enabledInput) state.autoFrame.enabled = Boolean(enabledInput.checked);
      if (autoApplyInput) state.autoFrame.autoApplyHighConfidence = Boolean(autoApplyInput.checked);
      if (formatSelect) state.autoFrame.formatPreference = formatSelect.value === '135' || formatSelect.value === '120' ? formatSelect.value : 'auto';
      if (lowSelect) {
        const value = lowSelect.value;
        state.autoFrame.lowConfidenceBehavior = (value === 'rotateOnly' || value === 'ignore') ? value : 'suggest';
      }

      state.autoFrame.allowed120Formats = {
        '6x4.5': option645 ? Boolean(option645.checked) : true,
        '6x6': option66 ? Boolean(option66.checked) : true,
        '6x7': option67 ? Boolean(option67.checked) : true,
        '6x9': option69 ? Boolean(option69.checked) : true
      };
      normalizeAutoFrame120Options();
      updateAutoFrameConfigUI();
      updateAutoFrameButtons();
    }

    function updateAutoFrameButtons() {
      const currentBtn = document.getElementById('autoFrameBtn');
      const selectedBtn = document.getElementById('autoFrameSelectedBtn');
      if (!currentBtn || !selectedBtn) return;

      const stepReady = state.currentStep === 1;
      currentBtn.disabled = !state.originalImageData || !state.autoFrame.enabled || !stepReady;
      const selectedCount = state.fileQueue.filter(f => f.selected).length;
      selectedBtn.disabled = !state.autoFrame.enabled || selectedCount < 1 || !stepReady;
      updateAutoFrameConfigUI();
    }

    function showBatchUI(show, reason) {
      setFileListVisible(show, reason || 'showBatchUI');
      updateBatchStep3GuideVisibility();
    }

    // Select all button
    document.getElementById('selectAllBtn').addEventListener('click', () => {
      state.fileQueue.forEach(item => item.selected = true);
      updateFileListUI();
      updateExportButtons();
    });

    // Select none button
    document.getElementById('selectNoneBtn').addEventListener('click', () => {
      state.fileQueue.forEach(item => item.selected = false);
      updateFileListUI();
      updateExportButtons();
    });

    // Save settings button
    document.getElementById('saveSettingsBtn').addEventListener('click', () => {
      if (state.currentStep < 3) {
        alert(i18n[currentLang].finishProcessing || 'Please complete the workflow (step 3) before saving settings.');
        return;
      }
      saveCurrentFileSettings();
    });

    document.getElementById('applyToSelectedBtn').addEventListener('click', () => {
      applyCurrentSettingsToSelected();
    });

    document.getElementById('setRollReferenceBtn').addEventListener('click', () => {
      setRollReferenceFromCurrent();
    });

    document.getElementById('applyRollReferenceBtn').addEventListener('click', () => {
      applyRollReferenceToSelected();
    });

    document.getElementById('clearRollReferenceBtn').addEventListener('click', () => {
      clearRollReference();
    });

    document.getElementById('lockRollReference').addEventListener('change', (e) => {
      state.rollReference.applyLock = Boolean(e.target.checked);
      updateRollReferenceUI();
    });

    document.getElementById('applyCropWithReference').addEventListener('change', (e) => {
      state.rollReference.applyCrop = Boolean(e.target.checked);
      updateRollReferenceUI();
    });

    ['autoFrameEnabledInput', 'autoFrameAutoApplyInput', 'autoFrameFormatSelect', 'autoFrameLowConfidenceSelect',
      'autoFrame120_645', 'autoFrame120_66', 'autoFrame120_67', 'autoFrame120_69']
      .forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('change', applyAutoFrameConfigFromUI);
      });
    updateAutoFrameConfigUI();

    function openAddFilesPicker() {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = '.cr2,.nef,.arw,.dng,.raw,.rw2,.tif,.tiff,image/*';
      input.onchange = (e) => {
        if (e.target.files.length > 0) {
          addFilesToQueue(Array.from(e.target.files));
          if (!state.originalImageData && state.fileQueue.length > 0) {
            loadFile(state.fileQueue[state.currentFileIndex].file);
          }
        }
      };
      input.click();
    }

    // Add more files button
    document.getElementById('addMoreFilesBtn').addEventListener('click', () => {
      openAddFilesPicker();
    });

    // Add files button in toolbar (single image + batch)
    document.getElementById('addFilesToolbarBtn').addEventListener('click', () => {
      openAddFilesPicker();
    });

    // Clear file list button
    document.getElementById('clearFileListBtn').addEventListener('click', () => {
      state.fileQueue = [];
      state.currentFileIndex = 0;
      state.batchSessionActive = false;
      resetRollReferenceState();
      updateFileListUI();
      syncBatchUIState({ reason: 'clearFileListBtn' });
      updateExportButtons();
    });

    function createQueueItemId(file) {
      return `${file.name}::${file.size}::${file.lastModified || 0}`;
    }

    function addFilesToQueue(files) {
      // Filter for supported image files
      const supportedExtensions = ['.cr2', '.nef', '.arw', '.dng', '.raw', '.rw2', '.tif', '.tiff', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
      const validFiles = files.filter(file => {
        const ext = '.' + file.name.split('.').pop().toLowerCase();
        return supportedExtensions.includes(ext) || file.type.startsWith('image/');
      });

      if (validFiles.length === 0) return;

      // Add files to queue
      for (const file of validFiles) {
        // Avoid duplicates
        const id = createQueueItemId(file);
        if (!state.fileQueue.some(f => f.id === id)) {
          const newItem = {
            id,
            file: file,
            selected: true,  // Selected by default
            status: 'pending',
            error: null,
            settings: null,  // null = use auto-detect, otherwise saved settings
            isDirty: false
          };
          if (hasRollReference() && state.rollReference.applyLock) {
            const applied = applySettingsToItems(
              state.rollReference.settingsSnapshot,
              [newItem],
              { includeCrop: state.rollReference.applyCrop }
            );
            if (applied > 0) {
              newItem.status = 'pending';
            }
          }
          state.fileQueue.push(newItem);
        }
      }

      if (state.fileQueue.length > 1) {
        state.batchSessionActive = true;
      }
      syncBatchUIState({ reason: 'addFilesToQueue' });

      updateFileListUI();
      updateExportButtons();
    }

    // ===========================================
    // File Input Handling
    // ===========================================
    const fileInput = document.getElementById('fileInput');
    const folderInput = document.getElementById('folderInput');
    const uploadBtn = document.getElementById('uploadBtn');
    const uploadFolderBtn = document.getElementById('uploadFolderBtn');
    const folderPickerHint = document.getElementById('folderPickerHint');

    function supportsFolderPicker() {
      return !!(folderInput && ('webkitdirectory' in folderInput));
    }

    function handleUploadLabelKeydown(e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const label = e.currentTarget;
      if (!label || label.getAttribute('aria-disabled') === 'true') return;
      const inputId = label.getAttribute('for');
      if (!inputId) return;
      const input = document.getElementById(inputId);
      if (!input) return;
      e.preventDefault();
      input.value = '';
      input.click();
    }

    function applyFolderPickerAvailability() {
      if (!uploadFolderBtn) return;
      if (supportsFolderPicker()) {
        uploadFolderBtn.classList.remove('is-disabled');
        uploadFolderBtn.removeAttribute('aria-disabled');
        uploadFolderBtn.setAttribute('for', 'folderInput');
        uploadFolderBtn.tabIndex = 0;
        if (folderPickerHint) folderPickerHint.classList.remove('visible');
        return;
      }
      uploadFolderBtn.classList.add('is-disabled');
      uploadFolderBtn.setAttribute('aria-disabled', 'true');
      uploadFolderBtn.removeAttribute('for');
      uploadFolderBtn.tabIndex = -1;
      if (folderPickerHint) folderPickerHint.classList.add('visible');
    }

    [uploadBtn, uploadFolderBtn].forEach(label => {
      if (!label) return;
      label.addEventListener('keydown', handleUploadLabelKeydown);
    });

    applyFolderPickerAvailability();

    fileInput.addEventListener('click', () => {
      fileInput.value = '';
    });
    folderInput.addEventListener('click', () => {
      folderInput.value = '';
    });

    fileInput.addEventListener('change', (e) => {
      const files = Array.from(e.target.files);
      if (files.length === 0) return;

      // Reset state for new batch
      state.fileQueue = [];
      state.currentFileIndex = 0;
      state.cropRegion = null;
      state.rotationAngle = 0;
      state.loadedBaseImageData = null;
      state.batchSessionActive = false;
      resetRollReferenceState();
      syncBatchUIState({ reason: 'fileInput_change_reset' });

      addFilesToQueue(files);

      // Load the first file
      if (state.fileQueue.length > 0) {
        loadFile(state.fileQueue[0].file);
      }
    });

    folderInput.addEventListener('change', (e) => {
      const files = Array.from(e.target.files);
      if (files.length === 0) return;

      // Reset state for new batch
      state.fileQueue = [];
      state.currentFileIndex = 0;
      state.cropRegion = null;
      state.rotationAngle = 0;
      state.loadedBaseImageData = null;
      state.batchSessionActive = false;
      resetRollReferenceState();
      syncBatchUIState({ reason: 'folderInput_change_reset' });

      addFilesToQueue(files);

      // Load the first file
      if (state.fileQueue.length > 0) {
        loadFile(state.fileQueue[0].file);
      }
    });

    canvasContainer.addEventListener('dragover', (e) => {
      e.preventDefault();
      canvasContainer.style.borderColor = 'var(--accent)';
    });

    canvasContainer.addEventListener('dragleave', () => {
      canvasContainer.style.borderColor = '';
    });

    canvasContainer.addEventListener('drop', (e) => {
      e.preventDefault();
      canvasContainer.style.borderColor = '';

      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;

      // Reset state for new batch
      state.fileQueue = [];
      state.currentFileIndex = 0;
      state.cropRegion = null;
      state.rotationAngle = 0;
      state.loadedBaseImageData = null;
      state.batchSessionActive = false;
      resetRollReferenceState();
      syncBatchUIState({ reason: 'drop_reset' });

      addFilesToQueue(files);

      // Load the first file
      if (state.fileQueue.length > 0) {
        loadFile(state.fileQueue[0].file);
      }
    });

    // ===========================================
    // Window Resize
    // ===========================================
    window.addEventListener('resize', () => {
      if (canvas.width > 0 && canvas.height > 0) {
        adjustCanvasDisplay(canvas.width, canvas.height);
      }
      reclampHistogramPosition();
    });
