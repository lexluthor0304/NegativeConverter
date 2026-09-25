// The film-edge read of a worker's 8-bit plane: perforation lanes and the DX
// edge barcode (no OpenCV), then the edge text through OpenCV. Shared by the
// auto-frame worker and the roll-frame worker (#252), so both read the same.
import { readTextInBands, borderTextBands } from '../app/filmEdgeText.js';
import { readFilmEdge, rectifyLaneBand } from '../app/filmEdgeReader.js';

// The result is plain data (no ImageData), so it clones without transfers.
export function createFilmEdgeReader(loadCv) {
  return async function readEdge(image, options) {
    const result = readFilmEdge(image, options || {});
    try {
      await loadCv();
      const textBands = result.geometry
        ? result.geometry.lanes.map(lane => rectifyLaneBand(image, result.geometry, lane, { columnStepMm: 0.04, rowStepMm: 0.04 }))
        : borderTextBands(image);
      const text = readTextInBands(textBands, { cv: globalThis.cv });
      if (text) { result.text = text; result.found = true; }
    } catch (error) { console.warn('Film edge text unavailable:', error.message); }
    return result;
  };
}
