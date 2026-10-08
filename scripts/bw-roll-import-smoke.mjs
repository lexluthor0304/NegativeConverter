// A camera-scanned B&W roll without rebates (#231). Every frame is borderless
// grey, and the leader also shows a dark bluish holder edge, so it carries no
// film evidence of its own (noMask), like L1000617. The roll decision must type
// all five frames B&W, flip the open leader, show one toast with a correction,
// raise no film-type review flags and run roll analysis from the pass-1
// samples. "These are positives" is one undo step on exactly those frames.
export async function runBwRollImportSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port }) {
  const count = 5;
  const ready = `document.body.classList.contains('studio-ready')&&!document.body.dataset.studioBusy`;
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await waitFor('bw roll boot', `!!document.getElementById('autoRollOnImport')&&!!document.getElementById('studioImportAutoCrop')`);
  await installDialogAutoAccept();
  await wait(1500);
  // The roll decision needs automatic roll import. Earlier scenarios (photo
  // sessions, light table, camera) switch it off and the choice is persisted.
  // The app reads the stored value when an import starts, so set it there
  // instead of clicking the checkbox, whose listener may not be bound yet.
  // The previous value is restored at the end for the scenarios after this.
  const autoRollBefore = await evaluate(`(()=>{const key='nc_auto_roll_import_v1',before=localStorage.getItem(key);localStorage.setItem(key,'on');document.getElementById('autoRollOnImport').checked=true;return before})()`);
  await evaluate(`(async()=>{
    const crop=document.getElementById('studioImportAutoCrop'); if(crop.checked) crop.click();
    const p=window.__bwRoll={toasts:[],actions:[],rollReads:0,projects:[]};
    new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes){
      if(!node.classList?.contains('toast-message'))continue;
      const action=node.querySelector('.toast-action');
      p.toasts.push({text:node.firstChild?.textContent||node.textContent,action:action?.dataset.toastAction||null});
      if(action)p.actions.push(action);
    }}).observe(document.getElementById('toastContainer'),{childList:true});
    Error.stackTraceLimit=50;
    const fromRollAnalysis=()=>/\\brunRollAnalysis\\b/.test(new Error().stack);
    const read=File.prototype.arrayBuffer;
    File.prototype.arrayBuffer=function(...args){if(this.name.startsWith('bw-roll-')&&fromRollAnalysis())p.rollReads++;return read.apply(this,args)};
    const bitmap=window.createImageBitmap;
    window.createImageBitmap=function(source,...args){if(source?.name?.startsWith?.('bw-roll-')&&fromRollAnalysis())p.rollReads++;return bitmap.call(this,source,...args)};
    const revoke=URL.revokeObjectURL.bind(URL),pending=new Set();
    URL.revokeObjectURL=url=>{if(!pending.has(url))revoke(url)};
    HTMLAnchorElement.prototype.click=function(){if(this.download.endsWith('.ncroll.json')){const url=this.href;pending.add(url);p.projects.push(fetch(url).then(r=>r.json()).finally(()=>{pending.delete(url);revoke(url)}))}};
    const dt=new DataTransfer();
    for(let n=1;n<=${count};n++){
      const canvas=document.createElement('canvas');canvas.width=200;canvas.height=150;
      const ctx=canvas.getContext('2d'),image=ctx.createImageData(200,150);
      for(let y=0;y<150;y++)for(let x=0;x<200;x++){
        const v=40+(x+y*2+n*17)%170;
        image.data.set(n===1&&x<32?[34,44,70,255]:[v,v,v,255],(y*200+x)*4);
      }
      ctx.putImageData(image,0,0);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      dt.items.add(new File([blob],'bw-roll-'+n+'.png',{type:'image/png',lastModified:n}));
    }
    const input=document.getElementById('folderInput');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await waitFor('bw roll analysed', `${ready}&&document.getElementById('rollAnalysisStatus').textContent.includes('${count}/${count}')`, 180000);
  await waitFor('leader flipped to B&W', `${ready}&&document.querySelector('.film-type-btn.active')?.dataset.type==='bw'`, 30000);
  const save = async () => {
    await evaluate(`document.getElementById('studioSaveProject').click()`);
    await waitFor('bw roll project snapshot', `window.__bwRoll.projects.length>0`);
    return evaluate(`window.__bwRoll.projects.shift()`);
  };
  const decided = await save();
  const settings = decided.files.map(file => file.settings);
  if (settings.length !== count || settings.some(s => s?.filmType !== 'bw' || s.filmTypeSource !== 'auto'
    || s.filmTypeConfidence !== 'medium' || s.filmTypeReason !== 'rollMonochrome')) {
    fail('roll decision did not type every frame as B&W: ' + JSON.stringify(settings.map(s => s && [s.filmType, s.filmTypeSource, s.filmTypeConfidence, s.filmTypeReason])));
  }
  if (settings.some(s => !s.rollFrame?.locked)) fail('B&W frames were not analysed as one roll');
  const flags = await evaluate(`import('/src/app/reviewQueue.js').then(({frameNeedsReview})=>${JSON.stringify(settings)}.filter(settings=>frameNeedsReview({settings}).reasons.includes('reviewFilmType')).length)`);
  if (flags !== 0) fail(`frames agreeing with the roll raised ${flags} film-type review flag(s)`);
  if (await evaluate(`document.getElementById('filmTypeDetectionStatus').dataset.i18n`) !== 'filmTypeRollMonochrome') fail('leader does not show the roll status');
  const probe = await evaluate(`({toasts:window.__bwRoll.toasts,rollReads:window.__bwRoll.rollReads})`);
  const rollToasts = probe.toasts.filter(toast => toast.action === 'rollPositives');
  if (rollToasts.length !== 1 || !rollToasts[0].text.includes(`${count} photos treated as B&W negatives`)) fail('expected exactly one roll toast: ' + JSON.stringify(probe.toasts));
  if (probe.toasts.some(toast => /^Monochrome:/.test(toast.text))) fail('per-frame monochrome prompt was not replaced by the roll toast: ' + JSON.stringify(probe.toasts));
  if (probe.rollReads !== 0) fail(`roll analysis decoded ${probe.rollReads} frame(s) again instead of reusing pass-1 samples`);
  console.log('ok: B&W roll typed by the roll decision, leader flipped, one toast, no review flags, analysis from pass-1 samples');

  await evaluate(`window.__bwRoll.actions[0].click()`);
  await waitFor('roll corrected to positive', `${ready}&&document.querySelector('.film-type-btn.active')?.dataset.type==='positive'`, 30000);
  const corrected = await save();
  if (corrected.files.some(file => file.filmTypeOverride?.filmType !== 'positive' || file.settings?.filmType !== 'positive')) {
    fail('These are positives missed a frame: ' + JSON.stringify(corrected.files.map(file => [file.filmTypeOverride, file.settings?.filmType])));
  }
  await evaluate(`document.getElementById('undoBtn').click()`);
  await wait(800);
  const undone = await save();
  if (undone.files.some(file => file.filmTypeOverride || file.settings?.filmType !== 'bw')) fail('undoing the correction did not restore B&W on every frame');
  console.log('ok: These are positives sets exactly the typed frames in one undo step');
  try {
    await runMixedRollPositivesSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port });
  } finally {
    await evaluate(`(()=>{const key='nc_auto_roll_import_v1',before=${JSON.stringify(autoRollBefore ?? null)};if(before===null)localStorage.removeItem(key);else localStorage.setItem(key,before)})()`);
  }
}

// #229 review R1-014: "These are positives" while a mixed import's rolls are
// still to be analysed. A colour roll leads the folder (its first frame is the
// open photo) and three B&W frames without rebates follow. The roll toast's
// action is clicked as soon as the toast appears, at the end of the first
// pass. The B&W frames become positives; the colour roll is still analysed,
// and its frames export byte-identical (PNG 8-bit, TIFF 16-bit) to the same
// import without the click. 5f23eb0 bumped the roll revision: neither roll of
// the import was analysed.
export async function runMixedRollPositivesSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port }) {
  const ready = `document.body.classList.contains('studio-ready')&&!document.body.dataset.studioBusy`;
  const name = n => `mixed-roll-${n}.png`;
  const run = async click => {
    const label = click ? 'with These are positives' : 'reference';
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
    await waitFor('mixed roll boot', `!!document.getElementById('autoRollOnImport')&&!!document.getElementById('studioImportAutoCrop')&&!!document.getElementById('exportAllBtn')`);
    await installDialogAutoAccept();
    await wait(1500);
    await evaluate(`(async()=>{
      localStorage.setItem('nc_auto_roll_import_v1','on');document.getElementById('autoRollOnImport').checked=true;
      const crop=document.getElementById('studioImportAutoCrop'); if(crop.checked) crop.click();
      window.showSaveFilePicker=undefined;
      const p=window.__mixedRoll={click:${click},clicked:0,toasts:[],downloads:[],projects:[]};
      new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes){
        if(!node.classList?.contains('toast-message'))continue;
        p.toasts.push(node.firstChild?.textContent||node.textContent);
        const action=node.querySelector('.toast-action');
        if(p.click&&action?.dataset.toastAction==='rollPositives'){p.clicked++;action.click()}
      }}).observe(document.getElementById('toastContainer'),{childList:true});
      const revoke=URL.revokeObjectURL.bind(URL),pending=new Set();
      URL.revokeObjectURL=url=>{if(!pending.has(url))revoke(url)};
      HTMLAnchorElement.prototype.click=function(){
        if(!this.download||!this.href.startsWith('blob:'))return;
        const url=this.href,file=this.download;pending.add(url);
        const read=fetch(url).then(r=>r.arrayBuffer()).then(async bytes=>{
          const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
          return {name:file,sha256:digest,text:file.endsWith('.ncroll.json')?new TextDecoder().decode(bytes):null};
        }).finally(()=>{pending.delete(url);revoke(url)});
        (file.endsWith('.ncroll.json')?p.projects:p.downloads).push(read);
      };
      const dt=new DataTransfer();
      for(let n=1;n<=6;n++){
        const canvas=document.createElement('canvas');canvas.width=200;canvas.height=150;
        const ctx=canvas.getContext('2d'),image=ctx.createImageData(200,150);
        for(let y=0;y<150;y++)for(let x=0;x<200;x++){
          // Frames 1-3: an orange-masked colour negative; 4-6: borderless grey.
          const t=((x+y*2+n*23)%160)/159,r=Math.round(120+100*t),v=40+(x+y*2+n*17)%170;
          image.data.set(n<=3?[r,Math.round(r*.7),Math.round(r*.7*.62),255]:[v,v,v,255],(y*200+x)*4);
        }
        ctx.putImageData(image,0,0);
        const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
        dt.items.add(new File([blob],'mixed-roll-'+n+'.png',{type:'image/png',lastModified:n}));
      }
      const input=document.getElementById('folderInput');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    // One roll analysis after the click (the colour roll), two without it.
    await waitFor(`mixed roll analysed (${label})`, `${ready}&&window.__mixedRoll.toasts.filter(text=>/^Roll analysis: 3 of 3 /.test(text)).length>=${click ? 1 : 2}`, 180000);
    await wait(2000);
    await waitFor(`mixed roll settled (${label})`, ready, 60000);
    await evaluate(`document.getElementById('studioSaveProject').click()`);
    await waitFor('mixed roll project', `window.__mixedRoll.projects.length>0`);
    const project = JSON.parse((await evaluate(`window.__mixedRoll.projects.shift()`)).text);
    const exports = {};
    for (const [format, depth] of [['png', 8], ['tiff', 16]]) {
      await evaluate(`document.querySelector('.format-btn[data-format="${format}"]').click(); document.querySelector('.bitdepth-btn[data-bitdepth="${depth}"]').click()`);
      await wait(300);
      await evaluate(`window.__mixedRoll.downloads.length=0; document.getElementById('exportAllBtn').click()`);
      await waitFor(`mixed roll Export All ${format}${depth} (${label})`, `window.__mixedRoll.downloads.length>=6`, 180000);
      for (const entry of await evaluate(`Promise.all(window.__mixedRoll.downloads)`)) exports[`${entry.name} ${format}${depth}`] = entry.sha256;
      await waitFor('mixed roll Export All settled', `${ready}&&!document.getElementById('exportAllBtn').disabled`, 180000);
      await wait(500);
    }
    return { project, exports, clicked: await evaluate(`window.__mixedRoll.clicked`) };
  };
  const corrected = await run(true);
  const reference = await run(false);
  const settings = (result, n) => result.project.files.find(file => file.name === name(n)) || {};
  if (corrected.clicked !== 1) fail(`expected one roll toast to click, clicked ${corrected.clicked}`);
  for (const n of [4, 5, 6]) {
    const file = settings(corrected, n);
    if (file.filmTypeOverride?.filmType !== 'positive' || file.settings?.filmType !== 'positive' || file.settings?.rollFrame) {
      fail(`${name(n)} is not a positive outside any roll after These are positives: ` + JSON.stringify([file.filmTypeOverride, file.settings?.filmType, file.settings?.rollFrame]));
    }
    if (settings(reference, n).settings?.filmTypeReason !== 'rollMonochrome' || !settings(reference, n).settings?.rollFrame?.locked) fail(`reference: ${name(n)} was not analysed as a B&W roll`);
  }
  const recipe = file => JSON.stringify([file.settings, file.filmTypeOverride || null]).replace(/"rollId":"[^"]*"/g, '"rollId":"*"');
  for (const n of [1, 2, 3]) {
    const file = settings(corrected, n);
    if (file.settings?.filmType !== 'color' || !file.settings?.rollFrame?.locked) fail(`the colour roll was not analysed after These are positives (${name(n)}): ` + JSON.stringify(file.settings?.rollFrame || null));
    if (recipe(file) !== recipe(settings(reference, n))) fail(`${name(n)}: the recipe differs from the import without the click`);
  }
  const colourExports = Object.keys(reference.exports).filter(key => /^mixed-roll-[123][_.]/.test(key));
  if (colourExports.length !== 6) fail('expected 3 colour frames x 2 exports: ' + JSON.stringify(Object.keys(reference.exports)));
  const different = colourExports.filter(key => corrected.exports[key] !== reference.exports[key]);
  if (different.length) fail('colour-roll exports differ after These are positives: ' + JSON.stringify(different.map(key => [key, corrected.exports[key], reference.exports[key]])));
  console.log('ok: These are positives during a mixed import: B&W frames positive, the colour roll still analysed and its exports (PNG8, TIFF16) identical to the import without the click');
}
