import { join } from 'node:path';
export async function runSimplicitySmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root }) {
  const url = `http://127.0.0.1:${port}`;
  await send('Page.navigate', { url: `${url}/?lang=en` });
  await waitFor('simplicity boot', `!!document.getElementById('studioAdvancedPanels')`);
  await installDialogAutoAccept();
  await evaluate(`localStorage.removeItem('nc_advanced_panels_v1'); localStorage.removeItem('nc_auto_roll_import_v1')`);
  if (await evaluate(`document.getElementById('studioAdvancedPanels').getAttribute('aria-pressed') === 'true'`)) await evaluate(`document.getElementById('studioAdvancedPanels').click()`);
  await wait(300);
  // Exercise the real Chrome decoder fallback, not a mocked HEIF wrapper.
  const heif = await evaluate(`(async () => {
    const { loadStandardImage } = await import('/src/app/imageFileLoaders.js');
    const blob = await (await fetch('/test-fixtures/negative-sample.heic')).blob();
    const image = await loadStandardImage(new File([blob], 'phone.HEIC', { type: 'image/heic' }));
    let sum = 0; for (let i = 0; i < image.data.length; i += 4) sum += image.data[i];
    return { width: image.width, height: image.height, mean: sum / (image.width * image.height) };
  })()`);
  if (!(heif.width > 100 && heif.height > 100 && heif.mean > 10 && heif.mean < 245)) fail('HEIF decode failed: '+JSON.stringify(heif));
  console.log('HEIF Chrome WASM:', JSON.stringify(heif));
  const document = await send('DOM.getDocument');
  const input = await send('DOM.querySelector', { nodeId: document.result.root.nodeId, selector: '#fileInput' });
  await send('DOM.setFileInputFiles', { files: [join(root, 'negative2positive/test-fixtures/negative-sample.heic')], nodeId: input.result.nodeId });
  await waitFor('HEIC imported and converted', `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy && document.getElementById('studioFilename').textContent.includes('.heic')`, 150000);
  const contextual = await evaluate(`({ phoneFlatField: !document.getElementById('studioFlatField').hidden, mergeHidden: document.getElementById('studioMergeAverage').hidden, webHasNoWatcher: !document.getElementById('studioWatchFolder'), learnedLine: !!document.getElementById('learnedDefaultsCount') })`);
  if (!Object.values(contextual).every(Boolean)) fail('contextual panels: '+JSON.stringify(contextual));
  await evaluate(`document.getElementById('studioAdvancedPanels').click()`);
  if (!await evaluate(`!document.getElementById('studioTestStrip').hidden && !document.getElementById('studioDodgeBurn').hidden`)) fail('Advanced did not reveal tools');
  await evaluate(`document.getElementById('studioAdvancedPanels').click()`);
  if (!await evaluate(`!document.getElementById('consoleSection').hidden && document.getElementById('consoleKeypad').getBoundingClientRect().height > 0 && !!(document.getElementById('consoleSection').compareDocumentPosition(document.getElementById('studioBasic')) & Node.DOCUMENT_POSITION_FOLLOWING)`)) fail('CMYD must stay above basic adjustments with Advanced off');
  const liveReview = await evaluate(`(() => {
    const filter=document.getElementById('studioReviewFilter');
    const before=!filter.hidden;
    if(before) { filter.click(); document.querySelector('#fileListItems .file-review-menu button')?.click(); }
    return {before,after:!filter.hidden};
  })()`);
  if (liveReview.before && liveReview.after) fail('Mark as reviewed did not clear the real imported frame');
  const semantic = await evaluate(`(async () => {
    const { analyzeSemanticPreview } = await import('/src/app/semanticModel.js');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#78a6d6';ctx.fillRect(0,0,128,64);ctx.fillStyle='#658638';ctx.fillRect(0,64,128,64);
    const start=performance.now(), result = await analyzeSemanticPreview(ctx.getImageData(0,0,128,128));
    return result && { width: result.width, height: result.height, confidence: result.confidence, labels: result.labels.length, provider: result.provider, ms: Math.round(performance.now()-start) };
  })()`);
  if (!semantic || semantic.width !== 64 || semantic.labels !== 4096) fail('real semantic inference failed: '+JSON.stringify(semantic));
  console.log('semantic inference:', JSON.stringify(semantic));
  const review = await evaluate(`(async () => {
    const { renderFileList } = await import('/src/app/fileListView.js');
    const { frameNeedsReview } = await import('/src/app/reviewQueue.js');
    const container=document.createElement('div'), countEl=document.createElement('span'); document.body.append(container);
    const items=[{file:{name:'ambiguous.jpg'},settings:{filmTypeConfidence:'low',filmTypeSource:'auto'},selected:true}, {file:{name:'good.jpg'},settings:{filmTypeConfidence:'high'},selected:true}];
    const render=()=>renderFileList({container,countEl,items,currentFileIndex:0,visible:item=>frameNeedsReview(item).needs,labels:{statusText:()=>'',markReviewed:'Mark as reviewed',canReview:item=>frameNeedsReview(item).needs},onToggleSelected:()=>{},onOpenFile:()=>{},onMarkReviewed:index=>{items[index].settings.reviewed=true;render();}});
    render();const before=container.querySelectorAll('.file-list-item').length;container.querySelector('.file-review-menu button').click();const after=container.querySelectorAll('.file-list-item').length;
    container.remove(); return {before,after};
  })()`);
  if (review.before !== 1 || review.after !== 0) fail('review queue interactions: '+JSON.stringify(review));
  const exportResult = await evaluate(`(async () => {
    const { packGainMapJpeg } = await import('/src/app/gainMapJpeg.js');
    const { attachMetadataToBlob, listJpegSegments } = await import('/src/app/exportMetadata.js');
    const canvas=document.createElement('canvas');canvas.width=canvas.height=32;canvas.getContext('2d').fillRect(0,0,32,32);
    const jpeg=await new Promise(r=>canvas.toBlob(r,'image/jpeg'));
    const base=await attachMetadataToBlob(jpeg,'jpeg',null), hdr=await packGainMapJpeg(base,jpeg,{gainMax:1});
    const bitmap=await createImageBitmap(hdr); const segments=listJpegSegments(new Uint8Array(await hdr.arrayBuffer()));
    const result={width:bitmap.width,icc:segments.some(s=>s.marker===226&&new TextDecoder().decode(s.data).startsWith('ICC_PROFILE')),mpf:segments.some(s=>s.marker===226&&new TextDecoder().decode(s.data).startsWith('MPF'))};bitmap.close();return result;
  })()`);
  if (exportResult.width !== 32 || !exportResult.icc || !exportResult.mpf) fail('HDR JPEG browser decode: '+JSON.stringify(exportResult));
  // A fresh import of three matching negative strips runs the same roll
  // analysis as the button, without modifying checkbox selection.
  await send('Page.navigate', { url: `${url}/?lang=en` });
  await waitFor('automatic roll boot', `!!document.getElementById('autoRollOnImport')`);
  await installDialogAutoAccept(); await wait(300);
  await evaluate(`(async () => {
    const bytes=await (await fetch('/test-fixtures/negative-strip-dx.png')).arrayBuffer();
    const transfer=new DataTransfer();
    for(let i=1;i<=3;i++) transfer.items.add(new File([bytes],'auto-roll-'+i+'.png',{type:'image/png',lastModified:i}));
    const input=document.getElementById('fileInput'); input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await waitFor('automatic roll result', `!document.body.dataset.studioBusy && document.getElementById('rollAnalysisStatus').textContent.includes('3/3')`, 180000);
  const roll=await evaluate(`({status:document.getElementById('rollAnalysisStatus').textContent, selected:document.querySelectorAll('.file-list-checkbox:checked').length})`);
  if(roll.selected!==3) fail('automatic roll changed selection');
  console.log('automatic roll:', JSON.stringify(roll));
  await evaluate(`document.getElementById('undoBtn').click()`);
  await waitFor('one undo clears automatic roll', `document.getElementById('rollAnalysisStatus').textContent.includes('Not analysed')`, 10000);
  console.log('simplicity UI: HEIC import, contextual panels, actual model inference, review menu and HDR JPEG passed');
}
