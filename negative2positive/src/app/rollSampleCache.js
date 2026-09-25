// Keep the exact, geometry-applied samples from import analysis, not full RAW
// frames. The byte cap also bounds memory when a folder contains many rolls.
// The light-table lane keeps trickled watch-folder frames' samples here until
// a roll import takes them (#247).
// The planes a sample holds: its own, and the tile context a roll sample
// carries (#247).
function samplePlanes(sample) {
  return [sample, sample.__image16, sample.__analysisReference, sample.__tileWorking, sample.__tileWorking?.__image16]
    .map(plane => plane?.data).filter(data => data?.buffer);
}

export function createRollSampleCache(maxBytes = 128 * 1024 * 1024) {
  const entries = new Map();
  let bytes = 0;
  const take = key => {
    const entry = entries.get(key);
    if (!entry) return null;
    entries.delete(key); bytes -= entry.bytes;
    return entry.sample;
  };
  return {
    put(key, sample) {
      take(key);
      const size = samplePlanes(sample).reduce((sum, data) => sum + data.byteLength, 0);
      if (size > maxBytes) return;
      while (bytes + size > maxBytes) take(entries.keys().next().value);
      entries.set(key, { sample, bytes: size }); bytes += size;
    },
    take,
    clear() { entries.clear(); bytes = 0; },
    retainKeys(keys) {
      const retained = new Set(keys);
      for (const key of [...entries.keys()]) if (!retained.has(key)) take(key);
    },
    buffers() {
      const buffers = new Set();
      for (const { sample } of entries.values()) for (const data of samplePlanes(sample)) buffers.add(data.buffer);
      return buffers;
    },
    get bytes() { return bytes; }
  };
}
