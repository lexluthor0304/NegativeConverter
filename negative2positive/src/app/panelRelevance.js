// Visibility only. A non-default effect must remain discoverable and undoable.
export const PANEL_RULES = {
  studioFlatField: c => ['camera-raw', 'phone'].includes(c.sourceKind),
  studioLabMatch: c => c.filmType === 'color',
  paperSection: c => c.filmType !== 'positive',
  enlargerSection: () => false,
  studioTestStrip: () => false,
  studioDodgeBurn: () => false,
  consoleSection: () => true, // Primary CMYD controls always precede basic adjustments.
  studioMergeAverage: c => c.fileCount >= 2,
  studioMergeHdr: c => c.fileCount >= 2,
  expiredSection: c => c.expiredEnabled,
  sprocketSettingsSection: c => c.hasRebate,
  filmEdgeGroup: c => c.hasRebate,
};
export function panelRelevance(context, { advanced = false, active = {} } = {}) {
  return Object.fromEntries(Object.entries(PANEL_RULES).map(([id, predicate]) => [id, Boolean(advanced || active[id] || predicate(context))]));
}
export function inferSourceKind({ name = '', type = '', make = '', model = '' } = {}) {
  const camera = `${make} ${model}`;
  if (/EPSON|Nikon Scan|SilverFast|VueScan|Plustek|CanoScan/i.test(camera)) return 'scanner';
  if (/hei[cf]/i.test(type) || /\.(heic|heif|hif)$/i.test(name) || /iPhone|iPad|Pixel|Samsung/i.test(camera)) return 'phone';
  if (/\.(cr2|cr3|crw|nef|nrw|arw|dng|raf|raw|rw2|pef|srw|3fr|mef|orf|rwl|iiq|x3f|mrw|kdc|dcr)$/i.test(name)) return 'camera-raw';
  return 'unknown';
}
