// Keep the exact, geometry-applied samples from import analysis, not full RAW
// frames. The byte cap also bounds memory when a folder contains many rolls.
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
      const size = sample.data.byteLength + (sample.__image16?.data.byteLength || 0);
      if (size > maxBytes) return;
      while (bytes + size > maxBytes) take(entries.keys().next().value);
      entries.set(key, { sample, bytes: size }); bytes += size;
    },
    take,
    clear() { entries.clear(); bytes = 0; },
    get bytes() { return bytes; }
  };
}
