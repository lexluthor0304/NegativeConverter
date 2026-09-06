// 実際の PNG 書き出しを比較し、解析範囲と出力範囲の分離を検証する。
export async function runStudioColorAnalysisSmoke({ send, evaluate, waitFor, wait, fail, port, installDialogAutoAccept }) {
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=zh` });
  await waitFor('color analysis boot', `!!document.getElementById('studioConfirmAnalysis')`);
  await installDialogAutoAccept(); await wait(300);
  await evaluate(`(async () => {
    document.getElementById('studioImportAutoCrop').click();
    window.__colorExports = []; window.showSaveFilePicker = undefined;
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (!this.download || !this.href.startsWith('blob:')) return click.call(this);
      window.__colorExports.push(fetch(this.href).then(r => r.blob()).then(createImageBitmap).then(bitmap => {
        const c = document.createElement('canvas'); c.width = bitmap.width; c.height = bitmap.height;
        const ctx = c.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
        return { width: c.width, height: c.height, data: ctx.getImageData(0, 0, c.width, c.height).data };
      }));
    };
    const c = document.createElement('canvas'); c.width = 640; c.height = 480;
    const ctx = c.getContext('2d'); ctx.fillStyle = 'rgb(230,160,90)'; ctx.fillRect(0,0,640,480);
    ctx.fillStyle = 'rgb(30,20,10)'; ctx.fillRect(80,80,480,320);
    for (let y=84;y<396;y+=4) for(let x=84;x<556;x+=4) {
      const n=(x*17+y*23)%80; ctx.fillStyle='rgb('+(40+n)+','+(20+n/2)+','+(12+n/3)+')'; ctx.fillRect(x,y,4,4);
    }
    const blob = await new Promise(r=>c.toBlob(r)); const dt=new DataTransfer();
    dt.items.add(new File([blob], 'color-reference.png', {type:'image/png'}));
    dt.items.add(new File([blob], 'color-reference-2.png', {type:'image/png'}));
    document.getElementById('fileInput').files=dt.files; document.getElementById('fileInput').dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await waitFor('color analysis ready', `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`, 120000);
  const exportImage = async () => {
    const n = await evaluate('window.__colorExports.length');
    await evaluate(`document.getElementById('exportSingleBtn').click()`);
    await waitFor('color reference export', `window.__colorExports.length > ${n}`, 120000);
    return evaluate(`window.__colorExports[${n}].then(p=>[p.width,p.height])`);
  };
  const initial = await exportImage();
  if (String(initial) !== '640,480') fail('color analysis cropped the retained edges');
  const beforeWB = await evaluate(`['wbR','wbG','wbB'].map(id=>document.getElementById(id).value)`);
  await evaluate(`document.getElementById('studioTab-composition').click(); document.getElementById('cropBtn').click()`);
  await wait(400);
  for (const [corner, tx, ty] of [[0,84/640,84/480],[1,556/640,396/480]]) {
    const p = await evaluate(`(()=>{const a=document.getElementById('cropOverlay').getBoundingClientRect(),b=document.getElementById('canvas').getBoundingClientRect();return {x:${corner ? 'a.right-2' : 'a.left+2'},y:${corner ? 'a.bottom-2' : 'a.top+2'},tx:b.left+b.width*${tx},ty:b.top+b.height*${ty}}})()`);
    await send('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left',clickCount:1});
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:p.tx,y:p.ty,button:'left',buttons:1});
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.tx,y:p.ty,button:'left',clickCount:1});
  }
  await evaluate(`document.getElementById('applyCropBtn').click()`);
  await waitFor('color crop completed', `!document.body.dataset.studioBusy && !document.getElementById('canvasContainer').classList.contains('crop-mode')`,120000);
  await wait(600);
  const cropped = await exportImage();
  const afterWB = await evaluate(`['wbR','wbG','wbB'].map(id=>document.getElementById(id).value)`);
  if (JSON.stringify(beforeWB) !== JSON.stringify(afterWB)) fail('output cropping changed automatic WB');
  const delta = await evaluate(`(async()=>{
    const [a,b]=await Promise.all(window.__colorExports); let best=Infinity;
    // ポインタと CSS の丸めは一画素以内。対応する領域の画素値を直接比較する。
    for(let dy=81;dy<=86;dy++)for(let dx=81;dx<=86;dx++){
      let error=0,count=0;
      for(let y=20;y<b.height-20;y+=7)for(let x=20;x<b.width-20;x+=7)for(let c=0;c<3;c++){
        error+=Math.abs(a.data[((y+dy)*a.width+x+dx)*4+c]-b.data[(y*b.width+x)*4+c]);count++;
      }
      best=Math.min(best,error/count);
    }
    return best;
  })()`);
  if (!(delta < 1)) fail('retained-edge/cropped PNG colors differ: ' + delta);
  await evaluate(`document.getElementById('studioConfirmAnalysis').click()`);
  await wait(300);
  await evaluate(`document.getElementById('applyCropBtn').click()`);
  await waitFor('analysis confirmed', `!document.body.dataset.studioBusy && !document.getElementById('canvasContainer').classList.contains('crop-mode')`,120000);
  const confirmed = await exportImage();
  if (String(confirmed) !== String(cropped)) fail('confirming analysis changed output geometry');
  await evaluate(`document.getElementById('undoBtn').click()`); await wait(300);
  if (String(await exportImage()) !== String(cropped)) fail('undo analysis changed geometry');
  await evaluate(`document.getElementById('redoBtn').click()`); await wait(300);
  if (String(await exportImage()) !== String(cropped)) fail('redo analysis changed geometry');
  const confirmedIndex = await evaluate('window.__colorExports.length - 1');
  await evaluate(`document.querySelectorAll('.file-list-name')[1].click()`);
  await waitFor('second color reference', `document.getElementById('studioFilename').textContent === 'color-reference-2.png' && !document.body.dataset.studioBusy`,120000);
  if (String(await exportImage()) !== '640,480') fail('analysis confirmation leaked output geometry to the second photo');
  await evaluate(`document.querySelectorAll('.file-list-name')[0].click()`);
  await waitFor('reopened color reference', `document.getElementById('studioFilename').textContent === 'color-reference.png' && !document.body.dataset.studioBusy`,120000);
  if (String(await exportImage()) !== String(cropped)) fail('reopening lost per-photo geometry');
  const reopeningMatches = await evaluate(`(async()=>{const a=await window.__colorExports[${confirmedIndex}],b=await window.__colorExports.at(-1);return a.data.every((v,i)=>v===b.data[i]);})()`);
  if (!reopeningMatches) fail('reopening lost the color analysis reference');
  const batchStart = await evaluate('window.__colorExports.length');
  await evaluate(`document.getElementById('exportAllBtn').click()`);
  await waitFor('analysis-aware batch exports', `window.__colorExports.length >= ${batchStart + 2}`,120000);
  const batchMatches = await evaluate(`(async()=>{const a=await window.__colorExports[${confirmedIndex}],b=await window.__colorExports[${batchStart}];return a.width===b.width&&a.height===b.height&&a.data.every((v,i)=>v===b.data[i]);})()`);
  if (!batchMatches) fail('batch export differs from the saved per-photo color reference');
  console.log('ok: retained-edge and cropped PNGs match (mean error '+delta+'); WB stable; analysis confirmation/undo/redo preserve output geometry');
  console.log('ok: switching/reopening retains color analysis; the second photo keeps its own geometry; batch and individual PNGs match');
}
