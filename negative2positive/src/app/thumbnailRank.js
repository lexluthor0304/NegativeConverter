// Filmstrip / light-table tile ranks: embedded < analysis < processed.
//
// `embedded` tiles are provisional camera-JPEG inversions published at import;
// per-frame `analysis` tiles come from roll-import samples. Both may only fill
// an empty or `embedded` tile, so a tile never moves back from `processed` or
// `analysis` to `embedded`. The roll commit and the canonical lane keep their
// existing replacement rules. `embedded` tiles never carry a thumbnailKey and
// never count as ready.
export const THUMBNAIL_RANK = Object.freeze({ embedded: 1, analysis: 2, processed: 3 });

export function canPublishThumbnail(item, kind) {
  if (!item || !(kind in THUMBNAIL_RANK) || kind === 'processed') return false;
  return !item.thumbnail || item.thumbnailKind === 'embedded';
}
