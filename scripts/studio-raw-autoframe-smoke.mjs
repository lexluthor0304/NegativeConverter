// 任意のローカル RAW 回帰。原画像はコミット・アップロードしない。
// AUTOFRAME_RAW_DIR=/path/to/raw npm run test:smoke
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export async function runStudioRawAutoFrameSmoke({ send, evaluate, waitFor, fail, port, root, directory }) {
  const examples = [
    { file: 'DSC_4127.NEF', incomplete: true },
    { file: 'DSC_8798.NEF', bounds: [488, 261, 1215, 756] },
    { file: 'DSC_8800.NEF', bounds: [377, 309, 1100, 795] },
    { file: 'DSC_8806.NEF', bounds: [485, 315, 1214, 811] },
    { file: '_DSC5290.dng', bounds: [193, 145, 1425, 970], tolerance: 18 }
  ];
  const output = join(root, 'output', 'playwright', 'raw-autoframe-regression');
  mkdirSync(output, { recursive: true });
  const evidence = [];
  for (const example of examples) {
    const path = resolve(directory, example.file);
    if (!existsSync(path)) fail('RAW 回帰用ファイルがありません: ' + path);
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=zh` });
    await waitFor('RAW workspace boot', `!!document.getElementById('studioBasic')`);
    await evaluate(`(() => {
      const input = document.createElement('input'); input.type = 'file'; input.id = 'rawRegressionInput'; input.hidden = true; document.body.append(input);
      const format = document.getElementById('autoFrameFormatSelect'); format.value = 'auto'; format.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    const doc = await send('DOM.getDocument');
    const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#rawRegressionInput' });
    await send('DOM.setFileInputFiles', { nodeId: input.result.nodeId, files: [path] });
    const row = await evaluate(`(async () => {
      const {loadRawFile} = await import('/src/app/rawFileLoader.js');
      const {analyzeFrameInWorker} = await import('/src/app/autoFrameWorkerClient.js');
      const {resizeImageDataToMaxSide} = await import('/src/app/imageDataOps.js');
      const {canAutoApplyImportFrame} = await import('/src/app/autoFrameFormats.js');
      const file = document.getElementById('rawRegressionInput').files[0];
      const raw = await loadRawFile(await file.arrayBuffer(), file.name, {preview:true});
      const start = performance.now();
      const result = await analyzeFrameInWorker(raw, {settings:{marginRatio:.02, formatPreference:'auto', filmType:'color'}, maxSide:1600});
      const ms = performance.now() - start;
      const preview = resizeImageDataToMaxSide(raw, 1600);
      const canvas = document.createElement('canvas'); canvas.width = preview.width; canvas.height = preview.height;
      const ctx = canvas.getContext('2d'); ctx.putImageData(preview,0,0);
      let bounds = null;
      if (result?.cropRegion) {
        const r = result.cropRegion, theta = -result.angle * Math.PI / 180;
        const rw = result.rotatedImageData.width, rh = result.rotatedImageData.height;
        const points = [[r.left,r.top],[r.left+r.width,r.top],[r.left+r.width,r.top+r.height],[r.left,r.top+r.height]].map(([x,y]) => {
          x -= rw/2; y -= rh/2;
          return [(x*Math.cos(theta)-y*Math.sin(theta)+raw.width/2)*preview.width/raw.width,(x*Math.sin(theta)+y*Math.cos(theta)+raw.height/2)*preview.height/raw.height];
        });
        bounds = [Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))];
        ctx.strokeStyle = '#00ff88'; ctx.lineWidth = 3; ctx.beginPath(); points.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y)); ctx.closePath();ctx.stroke();
      }
      const summary = result ? {angle:result.angle, confidence:result.confidence, confidenceLevel:result.confidenceLevel, detectedFormat:result.detectedFormat, cropRegion:result.cropRegion, requiresReview:result.requiresReview, diagnostics:result.diagnostics} : null;
      return {file:file.name, ms, rawSize:[raw.width,raw.height], result:summary, autoApply:canAutoApplyImportFrame(result), bounds, overlay:canvas.toDataURL('image/png')};
    })()`);
    writeFileSync(join(output, example.file + '-detected.png'), Buffer.from(row.overlay.split(',')[1], 'base64'));
    delete row.overlay;
    if (example.incomplete) {
      if (!row.result?.requiresReview || !row.result.diagnostics?.incomplete || row.result.cropRegion || row.autoApply) fail('不完全な RAW の切り抜きを停止できません: ' + JSON.stringify(row));
    } else {
      const a = row.bounds, b = example.bounds;
      if (!a || !row.autoApply || row.result.detectedFormat !== '135') fail('RAW の実画格を検出できません: ' + JSON.stringify(row));
      const intersection = Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0])) * Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));
      row.boundsIoU = intersection / ((a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-intersection);
      if (row.boundsIoU < .94 || a.some((value,i)=>Math.abs(value-b[i])>(example.tolerance || 12))) fail('実画格とのずれが大きすぎます: ' + JSON.stringify(row));
    }
    // 同じファイルを通常のインポートへ渡し、実画面で自動適用・要確認を検証。
    await evaluate(`(() => {
      const input = document.getElementById('fileInput'); input.files = document.getElementById('rawRegressionInput').files;
      input.dispatchEvent(new Event('change', {bubbles:true}));
    })()`);
    await waitFor('RAW import ' + example.file, `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy && document.getElementById('studioFilename').textContent === ${JSON.stringify(example.file)}`, 120_000);
    await waitFor('RAW overlay dismissed', `[...document.querySelectorAll('.loading-overlay')].every(element => getComputedStyle(element).display === 'none' || Number(getComputedStyle(element).opacity) === 0)`, 30_000);
    row.ui = await evaluate(`(() => ({status:document.getElementById('studioFrameNotice').dataset.status, notice:document.getElementById('studioFrameNotice').textContent, size:[document.getElementById('canvas').width,document.getElementById('canvas').height]}))()`);
    if (example.incomplete ? row.ui.status === 'crop' || !row.ui.notice.includes('边界不完整') : row.ui.status !== 'crop') fail('RAW の画面反映が正しくありません: ' + JSON.stringify(row));
    const screenshot = await send('Page.captureScreenshot', {format:'png'});
    writeFileSync(join(output, example.file + '-studio.png'), Buffer.from(screenshot.result.data, 'base64'));
    evidence.push(row);
    writeFileSync(join(output, 'results.json'), JSON.stringify(evidence,null,2));
    console.log('RAW auto crop evidence:', JSON.stringify(row));
  }
}
