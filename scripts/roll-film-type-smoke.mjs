// Pause the real background import at an asynchronous boundary, then use the
// editor. This catches stale automatic commits and manual/DX precedence bugs.
export async function runRollFilmTypeSmoke({send,evaluate,waitFor,wait,fail,installDialogAutoAccept,port}) {
  const ready = `document.body.classList.contains('studio-ready')&&!document.body.dataset.studioBusy`;
  await send('Page.navigate',{url:`http://127.0.0.1:${port}/?lang=en`});
  await waitFor('roll film type boot',`!!document.getElementById('applyFilmTypeToRollBtn')`);
  await installDialogAutoAccept(); await wait(1500);
  await evaluate(`(async()=>{
    window.__projects=[];
    const revoke=URL.revokeObjectURL.bind(URL), pending=new Set();
    URL.revokeObjectURL=url=>{if(!pending.has(url))revoke(url)};
    HTMLAnchorElement.prototype.click=function(){if(this.download.endsWith('.ncroll.json')){const url=this.href;pending.add(url);window.__projects.push(fetch(url).then(r=>r.json()).finally(()=>{pending.delete(url);revoke(url)}))}};
    const read=File.prototype.arrayBuffer;
    File.prototype.arrayBuffer=async function(...args){if(this.name==='interact-2.png'&&!window.__held){window.__held=true;await new Promise(r=>window.__release=r)}return read.apply(this,args)};
    const bytes=await(await fetch('/test-fixtures/negative-strip-dx.png')).arrayBuffer();const dt=new DataTransfer();
    for(let i=1;i<=3;i++)dt.items.add(new File([bytes],'interact-'+i+'.png',{type:'image/png',lastModified:i}));
    const input=document.getElementById('folderInput');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await waitFor('background import paused',`${ready}&&!!window.__release`,120000);
  await evaluate(`document.querySelector('.file-list-checkbox[data-index="2"]').click()`);
  await evaluate(`document.querySelector('.film-type-btn[data-type="bw"]').click()`);
  await wait(1200);
  await evaluate(`document.getElementById('applyFilmTypeToRollBtn').click()`);
  await wait(1200);
  const save = async () => {
    await evaluate(`document.getElementById('studioSaveProject').click()`);
    await waitFor('roll project snapshot',`window.__projects.length>0`);
    return evaluate(`window.__projects.shift()`);
  };
  const applied=await save();
  if(!applied.files.every(f=>f.filmTypeOverride?.filmType==='bw'))fail('roll film type did not include unopened frames');
  await evaluate(`document.getElementById('undoBtn').click()`); await wait(500);
  const undone=await save();
  if(undone.files.some(f=>f.filmTypeOverride))fail('roll film type undo was not atomic');
  await evaluate(`document.getElementById('redoBtn').click()`); await wait(500);
  const redone=await save();
  if(!redone.files.every(f=>f.filmTypeOverride?.filmType==='bw'))fail('roll film type redo missed unopened frames');
  await evaluate(`window.__release()`); await wait(1800);
  if(!await evaluate(`document.getElementById('rollAnalysisStatus').textContent.includes('Not analysed')`))fail('cancelled background import committed stale roll analysis');
  await evaluate(`document.querySelector('.file-list-name[data-index="2"]').click()`);
  await waitFor('unopened frame uses roll type',`${ready}&&document.getElementById('studioFilename').textContent==='interact-3.png'`,120000);
  const result=await save();
  const third=result.files[2].settings;
  if(third?.filmType!=='bw'||third?.filmTypeSource!=='manual')fail('DX or automatic import overwrote explicit roll film type');
  console.log('ok: background analysis cancels on manual edits; whole-roll film type includes unopened frames, survives DX and supports atomic undo/redo');
}
