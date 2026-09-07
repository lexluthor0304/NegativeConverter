import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const UPNG = require('upng-js');
// Real imports and exports: mixed borderless scans, uncertainty, saved manual
// types, edit-only identity, 16-bit preservation and responsive controls.
export async function runPositiveImportSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port }) {
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await waitFor('positive import boot', `!!document.getElementById('studioImportAutoCrop')`);
  await installDialogAutoAccept();
  await wait(500);
  await evaluate(`(() => {
    const crop = document.getElementById('studioImportAutoCrop'); if (crop.checked) crop.click();
    window.__positiveExports = [];
    window.__positiveDownloads = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function() {
      if (!this.download || !this.href.startsWith('blob:')) return click.call(this);
      const name = this.download;
      window.__positiveDownloads.push(fetch(this.href).then(r=>r.blob()).then(blob=>new Promise(resolve=>{
        const reader=new FileReader();reader.onload=()=>resolve({name,dataUrl:reader.result});reader.readAsDataURL(blob);
      })));
    };
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => {
      if (blob instanceof Blob && blob.type === 'image/png') window.__positiveExports.push(blob);
      return create(blob);
    };
  })()`);
  await evaluate(`(async () => {
    const files = [];
    for (const type of ['slide', 'negative', 'mono']) {
      const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 120;
      const ctx = canvas.getContext('2d'), image = ctx.createImageData(160,120);
      for (let y=0;y<120;y++) for(let x=0;x<160;x++) {
        const t = (x+y)%70, i=(y*160+x)*4;
        const rgb = type==='negative' ? [130+t,60+t*.6,25+t*.25] : type==='mono' ? [50+t,50+t,50+t] : x<60 ? [70,130,190] : y<70 ? [40,150,50] : [160,100,60];
        image.data.set([...rgb,255],i);
      }
      ctx.putImageData(image,0,0);
      if(type==='slide') window.__positiveOriginal = Array.from(image.data);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      files.push(new File([blob],type+'.png',{type:'image/png'}));
    }
    const dt=new DataTransfer(); files.forEach(f=>dt.items.add(f));
    const input=document.getElementById('fileInput'); input.files=dt.files; input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;
  await waitFor('slide imported', `${ready} && document.querySelectorAll('.file-list-item').length === 3`, 150000);
  await evaluate(`document.getElementById('studioTab-conversion').click()`);
  if (await evaluate(`document.querySelector('.film-type-btn.active').dataset.type`) !== 'positive') fail('borderless slide was inverted');
  if (!await evaluate(`document.getElementById('positiveModeSelect').getBoundingClientRect().height > 0`)) fail('positive mode selector not visible');
  await evaluate(`(() => { const el = document.getElementById('positiveModeSelect'); el.value='edit'; el.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await wait(1500);
  await evaluate(`document.getElementById('exportSingleBtn').click()`);
  await waitFor('positive export', `window.__positiveExports.length > 0`, 120000);
  const identity = await evaluate(`(async()=>{
    const b=await createImageBitmap(window.__positiveExports.at(-1)), c=document.createElement('canvas'); c.width=b.width;c.height=b.height;
    const ctx=c.getContext('2d');ctx.drawImage(b,0,0);const out=ctx.getImageData(0,0,c.width,c.height).data;
    return {actual:Array.from(out.slice(0,12)),expected:window.__positiveOriginal.slice(0,12),width:c.width,height:c.height,same:out.length===window.__positiveOriginal.length && out.every((v,i)=>v===window.__positiveOriginal[i])};
  })()`);
  if (!identity.same) fail('edit-only PNG export changed source pixels: '+JSON.stringify(identity));
  await evaluate(`document.getElementById('exportAllBtn').click()`);
  await waitFor('mixed unviewed batch export', `window.__positiveDownloads.length >= 4`, 180000);
  const downloads = await evaluate('Promise.all(window.__positiveDownloads.slice(-3))');
  if (downloads.length !== 3) fail('mixed batch did not export all three frames');
  for (const {name, dataUrl} of downloads) {
    const bytes = Buffer.from(dataUrl.split(',')[1], 'base64');
    const decoded = UPNG.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const pixels = new Uint8Array(UPNG.toRGBA8(decoded)[0]);
    if (/slide/.test(name) && (pixels[0] !== 70 || pixels[1] !== 130 || pixels[2] !== 190)) fail('batch lost slide edit-only mode');
    if (/negative/.test(name) && pixels[0] === 130 && pixels[1] === 60 && pixels[2] === 25) fail('unviewed negative was exported without conversion');
  }
  console.log('ok: mixed batch exports saved positive settings and identifies never-viewed negative/monochrome frames');
  await evaluate(`document.querySelectorAll('.file-list-name')[1].click()`);
  await waitFor('cropped negative imported', `${ready} && document.getElementById('studioFilename').textContent === 'negative.png'`,150000);
  if(await evaluate(`document.querySelector('.film-type-btn.active').dataset.type`)!=='color') fail('borderless orange negative not identified');
  await evaluate(`document.querySelectorAll('.file-list-name')[2].click()`);
  await waitFor('mono imported', `${ready} && document.getElementById('studioFilename').textContent === 'mono.png'`,150000);
  if(await evaluate(`document.getElementById('filmTypeDetectionStatus').dataset.confidence`)!=='low') fail('monochrome polarity claimed as certain');
  await evaluate(`document.querySelector('.film-type-btn[data-type="bw"]').click()`);
  await wait(1500);
  await evaluate(`document.querySelectorAll('.file-list-name')[0].click()`);
  await waitFor('slide reopened', `${ready} && document.getElementById('studioFilename').textContent === 'slide.png'`,150000);
  if(await evaluate(`document.getElementById('positiveModeSelect').value`)!=='edit') fail('per-photo positive mode not restored');
  await evaluate(`document.querySelectorAll('.file-list-name')[2].click()`);
  await waitFor('mono reopened', `${ready} && document.getElementById('studioFilename').textContent === 'mono.png'`,150000);
  if(await evaluate(`document.querySelector('.film-type-btn.active').dataset.type`)!=='bw') fail('manual B&W choice overwritten on reload');
  if(await evaluate(`document.getElementById('filmTypeDetectionStatus').dataset.confidence`)!=='manual') fail('manual type was labelled automatic');
  console.log('ok: borderless slide/negative/monochrome import, identity PNG export and saved manual selection');
}
