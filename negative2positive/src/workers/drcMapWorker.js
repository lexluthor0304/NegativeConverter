// Dynamic range compression's maps for the GPU preview (main.js): the solve
// of pipeline/dynamicRange.js off the page's thread (50-100 ms on 512 px).
// The same function, the same sample and preparation as a conversion's, so
// the same map.
import './isolationProbe.js'; // first: answers the page's isolation probe (#264)
import { solveDrcMap } from '../pipeline/dynamicRange.js';

const samples = new Map(); // key -> sample, the last few

self.onmessage = (event) => {
  const { id, sampleKey, sample, prep, settings, inverted, picture } = event.data || {};
  try {
    if (sample) {
      samples.set(sampleKey, sample);
      while (samples.size > 3) samples.delete(samples.keys().next().value);
    }
    const known = samples.get(sampleKey);
    if (!known) { self.postMessage({ id, error: 'unknown sample' }); return; }
    const map = solveDrcMap(known, settings, { prep, inverted: Boolean(inverted), picture: picture || null });
    if (!map) { self.postMessage({ id, map: null }); return; }
    self.postMessage({ id, map: { width: map.width, height: map.height, logGain: map.logGain, guide: map.guide, limits: map.limits } },
      [map.logGain.buffer, map.guide.buffer]);
  } catch (error) {
    self.postMessage({ id, error: String(error?.message || error) });
  }
};
