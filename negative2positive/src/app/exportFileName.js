const clean = text => String(text || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/\s+/g, '_').replace(/[. ]+$/, '').slice(0, 100);
export function exportNameStem(sourceName, settings = {}, roll = {}, position = null) {
  const stock = clean(settings.filmEdge?.shortName || settings.filmEdge?.filmName || roll.stock);
  const frame = String(settings.frameMetadata?.frameNumber || (position == null ? '' : position));
  if (!stock || !frame) return sourceName ? sourceName.replace(/\.[^.]+$/, '_converted') : 'converted_negative';
  const number = /^\d+[A-Z]?$/.test(frame) ? frame.replace(/^\d+/, n => n.padStart(2, '0')) : clean(frame);
  return `${clean(roll.rollName || sourceName.replace(/\.[^.]+$/, ''))}_${number}_${stock}_converted`;
}
