// Where an image edge lies on screen, to a fraction of a pixel, for the smoke
// checks of layers drawn over the photo (#279 follow-up: the before/after
// comparison and the detail layer). A layer and the photo under it show the
// same image, sharp or soft, negative or positive: a step edge of the image
// (a patch's side) is where each of them crosses halfway between the two sides
// of the step, whatever the blur. Screenshots clip whole CSS pixels: Chrome
// rounds a fractional clip's origin and truncates its size, in CSS pixels at
// any device pixel ratio (a clip 20.5 px wide at DPR 2 gave 40 device px).
import { createRequire } from 'node:module';

const UPNG = createRequire(import.meta.url)('upng-js');

function decode(base64) {
  const png = UPNG.decode(Buffer.from(base64, 'base64'));
  return { width: png.width, height: png.height, data: new Uint8Array(UPNG.toRGBA8(png)[0]) };
}

export function createScreenEdges({ send, evaluate }) {
  const nextFrames = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');

  // The step edge along `axis` ('x': a vertical edge, found along a row) near
  // client position `at`, averaged over `band` CSS px across it around
  // `across`, searched within `reach` CSS px. The profile of the channel with
  // the largest step crosses the mean of its outer quarters; the crossing
  // nearest `at` is interpolated between device pixels.
  async function edgeAt({ axis, at, across, reach, band }) {
    const dpr = await evaluate('window.devicePixelRatio || 1');
    const along = axis === 'x';
    const lo = Math.floor(at - reach), hi = Math.ceil(at + reach);
    const a0 = Math.floor(across - band / 2), a1 = Math.ceil(across + band / 2);
    const clip = along ? { x: lo, y: a0, width: hi - lo, height: a1 - a0, scale: 1 } : { x: a0, y: lo, width: a1 - a0, height: hi - lo, scale: 1 };
    const image = decode((await send('Page.captureScreenshot', { format: 'png', clip })).result.data);
    if (image.width !== Math.round(clip.width * dpr) || image.height !== Math.round(clip.height * dpr)) {
      return { error: 'the screenshot is not the clip\'s device pixels', clip, size: [image.width, image.height] };
    }
    const length = along ? image.width : image.height, depth = along ? image.height : image.width;
    const profiles = [0, 1, 2].map(channel => {
      const profile = new Float64Array(length);
      for (let i = 0; i < length; i++) {
        let sum = 0;
        for (let j = 0; j < depth; j++) sum += image.data[((along ? j * image.width + i : i * image.width + j) * 4) + channel];
        profile[i] = sum / depth;
      }
      return profile;
    });
    const quarter = Math.max(1, Math.floor(length / 4));
    const mean = (profile, from, to) => { let s = 0; for (let i = from; i < to; i++) s += profile[i]; return s / (to - from); };
    let best = null;
    for (const [channel, profile] of profiles.entries()) {
      const first = mean(profile, 0, quarter), last = mean(profile, length - quarter, length);
      if (!best || Math.abs(last - first) > best.contrast) best = { channel, profile, first, last, contrast: Math.abs(last - first) };
    }
    const { profile, first, last } = best;
    const half = (first + last) / 2;
    const centre = (at - (along ? clip.x : clip.y)) * dpr - 0.5;
    let crossing = null;
    for (let i = 0; i + 1 < length; i++) {
      const p = profile[i] - half, q = profile[i + 1] - half;
      // Sample i stands at device pixel i + 0.5; the crossing lies between i and i + 1.
      const position = (p < 0 && q >= 0) || (p > 0 && q <= 0) ? i + p / (p - q) : p === 0 && q !== 0 ? i : null;
      if (position !== null && (crossing === null || Math.abs(position - centre) < Math.abs(crossing - centre))) crossing = position;
    }
    if (crossing === null) return { error: 'no crossing', contrast: best.contrast };
    return { position: (along ? clip.x : clip.y) + (crossing + 0.5) / dpr, contrast: Math.round(best.contrast * 10) / 10, channel: best.channel };
  }

  // The same edge with the layer `id` shown and hidden (what is under it):
  // where each draws it, in client px.
  async function layerEdges(id, edge) {
    const shown = await edgeAt(edge);
    await evaluate(`document.getElementById(${JSON.stringify(id)}).style.visibility = 'hidden'`);
    await nextFrames();
    await new Promise(resolve => setTimeout(resolve, 100));
    const under = await edgeAt(edge);
    await evaluate(`document.getElementById(${JSON.stringify(id)}).style.visibility = ''`);
    await nextFrames();
    return { shown, under };
  }

  return { edgeAt, layerEdges };
}
