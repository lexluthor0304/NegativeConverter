// Planes the app may give back under memory pressure (#250 Part 5). The
// active editor's planes are never evicted, with one exception: the
// full-resolution `processedImageData` an export leaves resident, which can be
// demoted to the preview plane (the next export converts again). Whether and
// when to evict is the memory budget's policy (#258); this registry only says
// what can be evicted, how large it is and how to do it.

const planes = new Map();

/**
 * @param {string} name
 * @param {{bytes: () => number, canEvict: () => boolean, evict: () => number}} handlers
 *   `bytes`: what the plane holds now (0 when absent); `canEvict`: nothing that
 *   needs it is running; `evict`: evicts and returns the bytes let go (0 when
 *   refused).
 */
export function registerEvictablePlane(name, handlers) {
  if (!name || !handlers || typeof handlers.evict !== 'function') throw new TypeError('An evictable plane needs a name and an evict handler');
  planes.set(name, handlers);
  return () => { if (planes.get(name) === handlers) planes.delete(name); };
}

/** [{ name, bytes, evictable }] for every registered plane. */
export function listEvictablePlanes() {
  return Array.from(planes, ([name, handlers]) => ({
    name,
    bytes: Number(handlers.bytes?.()) || 0,
    evictable: Boolean(handlers.canEvict?.())
  }));
}

/** Evict one plane by name; returns the bytes let go (0 when refused or unknown). */
export function evictPlane(name) {
  const handlers = planes.get(name);
  if (!handlers || (handlers.canEvict && !handlers.canEvict())) return 0;
  return Number(handlers.evict()) || 0;
}
