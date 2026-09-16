import {writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';

export async function runFolderImportSmoke({send,evaluate,waitFor,wait,fail,installDialogAutoAccept,port,root}) {
  await send('Page.navigate',{url:`http://127.0.0.1:${port}/?lang=en`});
  await waitFor('folder import boot',`!!document.getElementById('autoRollOnImport')`);
  await installDialogAutoAccept();
  await wait(1500); // Static controls exist before asynchronous app startup finishes.
  await evaluate(`(() => {
    const p=window.__folderProbe={reads:[],decodes:[],thumbs:[],firstReady:null,busyAfterReady:0,start:performance.now()};
    const post=Worker.prototype.postMessage;
    Worker.prototype.postMessage=function(message,...args){if(message?.fn==='imageData')p.decodes.push({at:performance.now()-p.start,beforeReady:!document.body.classList.contains('studio-ready')});return post.call(this,message,...args)};
    const read=File.prototype.arrayBuffer;
    File.prototype.arrayBuffer=function(...args){if(this.name.startsWith('folder-'))p.reads.push({name:this.name,at:performance.now()-p.start});return read.apply(this,args)};
    const bitmap=window.createImageBitmap;
    window.createImageBitmap=function(file,options,...args){if(file?.name?.startsWith('folder-')&&options?.resizeWidth===144)p.thumbs.push({name:file.name,beforeReady:!document.body.classList.contains('studio-ready')||!!document.body.dataset.studioBusy});return bitmap.call(this,file,options,...args)};
    p.timer=setInterval(()=>{const ready=document.body.classList.contains('studio-ready')&&!document.body.dataset.studioBusy;if(ready&&p.firstReady===null)p.firstReady=performance.now()-p.start;if(p.firstReady!==null&&document.body.dataset.studioBusy)p.busyAfterReady++},10);
  })()`);
  const rawFixture = process.env.NC_FOLDER_RAW_FIXTURE;
  const count = rawFixture ? 3 : 12;
  if (rawFixture) {
    await evaluate(`(()=>{const input=document.createElement('input');input.type='file';input.id='rawFixture';document.body.append(input)})()`);
    const {result:{root:doc}}=await send('DOM.getDocument');
    const {result:{nodeId}}=await send('DOM.querySelector',{nodeId:doc.nodeId,selector:'#rawFixture'});
    await send('DOM.setFileInputFiles',{nodeId,files:[rawFixture]});
  }
  await evaluate(`(async()=>{
    const raw=${Boolean(rawFixture)};const bytes=raw?document.getElementById('rawFixture').files[0]:await(await fetch('/test-fixtures/negative-strip-dx.png')).arrayBuffer();const dt=new DataTransfer();
    for(let i=1;i<=${count};i++)dt.items.add(new File([bytes],'folder-'+i+(raw?'.dng':'.png'),{type:raw?'':'image/png',lastModified:i}));
    window.__folderProbe.start=performance.now();
    const input=document.getElementById('folderInput');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await waitFor('folder automatic roll',`!document.body.dataset.studioBusy&&document.getElementById('rollAnalysisStatus').textContent.includes('${count}/${count}')`,600000);
  await wait(800);
  const result=await evaluate(`(()=>{const p=window.__folderProbe;clearInterval(p.timer);return {...p,timer:undefined,totalMs:performance.now()-p.start,selected:document.querySelectorAll('.file-list-checkbox:checked').length,counts:p.reads.reduce((a,r)=>(a[r.name]=(a[r.name]||0)+1,a),{})}})()`);
  mkdirSync(join(root,'output','verification'),{recursive:true});
  writeFileSync(join(root,'output','verification','folder-import.json'),JSON.stringify(result,null,2));
  console.log('folder import:',JSON.stringify(result));
  if(result.selected!==count)fail('folder import changed selection');
  if(result.thumbs.some(t=>t.beforeReady))fail('folder thumbnails compete with first photo');
  if(!rawFixture&&Object.values(result.counts).some(n=>n>1))fail('automatic roll decodes the same file twice');
  if(rawFixture&&(result.decodes.length!==count||result.decodes.filter(d=>d.beforeReady).length!==1))fail('RAW folder must decode each frame once and prioritize the first photo');
  if(result.busyAfterReady)fail('automatic roll locks the ready editor');
  console.log('ok: first photo has priority; automatic roll reuses samples without duplicate decodes or locking the editor');
  if (!rawFixture) {
    // Compare actual exported pixels with a fresh, uncached manual analysis.
    await evaluate(`(()=>{
      window.__folderExports=[];const revoke=URL.revokeObjectURL.bind(URL),pending=new Set();
      URL.revokeObjectURL=url=>{if(!pending.has(url))revoke(url)};
      HTMLAnchorElement.prototype.click=function(){if(this.download&&this.href.startsWith('blob:')){const url=this.href;pending.add(url);window.__folderExports.push((async()=>{const bitmap=await createImageBitmap(await(await fetch(url)).blob());const c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;const ctx=c.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();const digest=await crypto.subtle.digest('SHA-256',ctx.getImageData(0,0,c.width,c.height).data);pending.delete(url);revoke(url);return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('')})())}};
      document.querySelector('.format-btn[data-format="png"]').click();
    })()`);
    const exportHash=async()=>{
      await evaluate(`document.getElementById('exportSingleBtn').click()`);
      await waitFor('folder PNG export',`window.__folderExports.length>0&&!document.getElementById('exportSingleBtn').disabled`,120000);
      return evaluate(`window.__folderExports.shift()`);
    };
    const cached=await exportHash();
    await evaluate(`document.getElementById('analyzeRollBtn').click()`);
    await waitFor('uncached roll starts',`!!document.body.dataset.studioBusy`);
    await waitFor('uncached roll finishes',`!document.body.dataset.studioBusy`,120000);
    await wait(500);
    const uncached=await exportHash();
    if(cached!==uncached)fail('sample reuse changed exported PNG pixels: '+JSON.stringify({cached,uncached}));
    console.log('ok: cached and freshly decoded roll analysis export identical PNG pixels',cached);
  }

}
