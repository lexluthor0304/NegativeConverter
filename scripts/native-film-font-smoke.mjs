import { join } from 'node:path';

// Exercise a cold native font through the real input, preview and PNG export.
export async function runNativeFilmFontSmoke({ send, evaluate, waitFor, wait, fail, port, root }) {
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await waitFor('native font app boot', `!!document.getElementById('studioImportAutoCrop')`);
  await evaluate(`document.getElementById('studioImportAutoCrop').checked && document.getElementById('studioImportAutoCrop').click()`);
  const doc = await send('DOM.getDocument');
  const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
  await send('DOM.setFileInputFiles', { files: [join(root, 'negative2positive/test-fixtures/negative-sample.jpg')], nodeId: input.result.nodeId });
  await waitFor('native font photo ready', `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`, 120000);
  await evaluate(`(() => {
    window.__nativeDownloads = [];
    window.__nativeGlyph = null;
    window.showSaveFilePicker = undefined;
    const oldLoad = FontFace.prototype.load;
    FontFace.prototype.load = function() {
      const loaded = oldLoad.call(this);
      if (!this.family.includes('NC Film Edge')) return loaded;
      return loaded.then(face => new Promise(resolve => { window.__releaseNativeFont = () => resolve(face); }));
    };
    window.__restoreNativeLoad = () => { FontFace.prototype.load = oldLoad; };
    const oldFill = OffscreenCanvasRenderingContext2D.prototype.fillText;
    OffscreenCanvasRenderingContext2D.prototype.fillText = function(...args) {
      oldFill.apply(this, args);
      if (args[0] === '中' && this.font.includes('NC Film Edge')) {
        const pixels = this.getImageData(0, 0, this.canvas.width, this.canvas.height).data;
        window.__nativeGlyph = Array.from({length:this.canvas.height},(_,y)=>Array.from({length:this.canvas.width},(_,x)=>pixels[(y*this.canvas.width+x)*4+3]>=128?'1':'0').join(''));
      }
    };
    const oldClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function() {
      if (!this.download || !this.href.startsWith('blob:')) return oldClick.call(this);
      window.__nativeDownloads.push(fetch(this.href).then(r=>r.blob()).then(createImageBitmap).then(bitmap=>{
        const canvas=document.createElement('canvas'); canvas.width=bitmap.width; canvas.height=bitmap.height;
        const ctx=canvas.getContext('2d'); ctx.drawImage(bitmap,0,0); bitmap.close();
        return ctx.getImageData(0,0,canvas.width,canvas.height);
      }));
    };
    document.getElementById('studioTab-border').click();
    const input=document.getElementById('sprocketTextInput'); input.value='中文日本語한국어'; input.dispatchEvent(new Event('input',{bubbles:true}));
    if (!document.getElementById('sprocketTextEnabledInput').checked) document.getElementById('sprocketTextEnabledInput').click();
  })()`);
  await waitFor('native font request', `typeof window.__releaseNativeFont === 'function'`);
  await evaluate(`window.__pendingNativePreview = document.getElementById('canvas').toDataURL()`);
  await evaluate(`document.getElementById('exportSprocketBtn').click(); document.getElementById('exportSingleBtn').click()`);
  await wait(200);
  if (await evaluate(`window.__nativeDownloads.length !== 0`)) fail('CJK export completed before its native font loaded');
  await evaluate(`window.__restoreNativeLoad(); window.__releaseNativeFont()`);
  await waitFor('native CJK PNG', `window.__nativeDownloads.length === 1 && !document.body.dataset.studioBusy`, 120000);
  await waitFor('native preview repainted', `document.getElementById('canvas').toDataURL() !== window.__pendingNativePreview`);
  // Independently read from the bundled font's 100-unit outlines at 12px.
  const expected = ['000001000000','000001000000','111111111110','100001000010','100001000010','100001000010','111111111110','000001000000','000001000000','000001000000','000001000000','000000000000'];
  const glyph = await evaluate(`window.__nativeGlyph`);
  if (JSON.stringify(glyph) !== JSON.stringify(expected)) fail('CJK grid differs from the native Fusion Pixel outline: ' + JSON.stringify(glyph));
  await evaluate(`(() => {
    const input=document.getElementById('sprocketTextInput'); input.value='????????'; input.dispatchEvent(new Event('input',{bubbles:true}));
    document.getElementById('exportSingleBtn').click();
  })()`);
  await waitFor('question-mark reference PNG', `window.__nativeDownloads.length === 2`, 120000);
  const result = await evaluate(`(async()=>{
    const [native,question]=await Promise.all(window.__nativeDownloads);
    let changed=0; for(let i=0;i<native.data.length;i+=4) if(native.data[i]!==question.data[i] || native.data[i+1]!==question.data[i+1] || native.data[i+2]!==question.data[i+2]) changed++;
    return {width:native.width,height:native.height,changed,sameSize:native.width===question.width&&native.height===question.height};
  })()`);
  if (!result.sameSize || result.changed < 100) fail('Native CJK export did not replace question marks: ' + JSON.stringify(result));
  console.log('ok: cold CJK export waits for Fusion Pixel, preview repaints, the 12px glyph matches its native outline, and PNG contains CJK:', JSON.stringify(result));
}
