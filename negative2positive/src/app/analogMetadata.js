// Analog metadata for exports: the roll (stock, ISO, camera, lens, process,
// lab, date, roll name) and the frame (frame number, notes). Pure helpers:
// sanitising, EXIF field selection and the XMP packet. The XMP uses the
// AnalogExif community schema (http://analogexif.sourceforge.net/ns) so
// AnalogExif, exiftool and Lightroom keyword search all see the same fields.

export const ROLL_FIELDS = Object.freeze(['rollName', 'stock', 'iso', 'camera', 'lens', 'process', 'lab', 'date']);
export const FRAME_FIELDS = Object.freeze(['frameNumber', 'notes']);
export const ANALOGEXIF_NS = 'http://analogexif.sourceforge.net/ns';

const MAX_TEXT = 120;
const MAX_NOTES = 500;

function cleanText(value, max = MAX_TEXT) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

export function sanitizeRollMetadata(input) {
  const source = input && typeof input === 'object' ? input : {};
  const iso = cleanText(source.iso, 12).replace(/[^0-9]/g, '');
  const date = cleanText(source.date, 10);
  return {
    rollName: cleanText(source.rollName),
    stock: cleanText(source.stock),
    iso,
    camera: cleanText(source.camera),
    lens: cleanText(source.lens),
    process: cleanText(source.process),
    lab: cleanText(source.lab),
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : ''
  };
}

export function sanitizeFrameMetadata(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    frameNumber: cleanText(source.frameNumber, 8).replace(/\s+/g, '').toUpperCase(),
    notes: cleanText(source.notes, MAX_NOTES)
  };
}

export function isEmptyRollMetadata(roll) {
  const safe = sanitizeRollMetadata(roll);
  return ROLL_FIELDS.every((key) => !safe[key]);
}

export function hasAnalogMetadata(roll, frame) {
  const safeFrame = sanitizeFrameMetadata(frame);
  return !isEmptyRollMetadata(roll) || Boolean(safeFrame.frameNumber || safeFrame.notes);
}

// The frame number written for a frame: its own when set, otherwise its
// 1-based position in the roll order.
export function frameNumberFor(frame, index) {
  const safe = sanitizeFrameMetadata(frame);
  if (safe.frameNumber) return safe.frameNumber;
  return Number.isInteger(index) && index >= 0 ? String(index + 1) : '';
}

// EXIF dates are "YYYY:MM:DD HH:MM:SS"; the roll only knows the day.
export function exifDateFromIso(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return '';
  return `${date.replace(/-/g, ':')} 00:00:00`;
}

/**
 * Standard EXIF fields that fit the analog data. Everything film-specific
 * lives in the XMP packet.
 */
export function buildExifFields({ roll, frame, index, software = 'NeoAnalogLab Negative Converter' } = {}) {
  const safeRoll = sanitizeRollMetadata(roll);
  const safeFrame = sanitizeFrameMetadata(frame);
  const frameNumber = frameNumberFor(safeFrame, index);
  const descriptionParts = [];
  if (safeRoll.stock) descriptionParts.push(safeRoll.stock);
  if (frameNumber) descriptionParts.push(`frame ${frameNumber}`);
  if (safeFrame.notes) descriptionParts.push(safeFrame.notes);
  return {
    make: '',
    model: safeRoll.camera,
    software,
    dateTime: exifDateFromIso(safeRoll.date),
    dateTimeOriginal: exifDateFromIso(safeRoll.date),
    iso: safeRoll.iso ? Number(safeRoll.iso) : 0,
    lensModel: safeRoll.lens,
    imageDescription: descriptionParts.join(' · '),
    userComment: safeFrame.notes
  };
}

export function escapeXml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function xmpElement(name, value) {
  return value ? `      <${name}>${escapeXml(value)}</${name}>\n` : '';
}

/**
 * XMP packet with dc (keywords, description), xmp (creator tool, date), exif,
 * tiff and aux basics, and the AnalogExif film schema.
 */
export function buildXmpPacket({ roll, frame, index, software = 'NeoAnalogLab Negative Converter' } = {}) {
  const safeRoll = sanitizeRollMetadata(roll);
  const safeFrame = sanitizeFrameMetadata(frame);
  const frameNumber = frameNumberFor(safeFrame, index);
  const keywords = [safeRoll.stock, safeRoll.lab].filter(Boolean);
  const description = safeFrame.notes;
  let body = '';
  body += xmpElement('xmp:CreatorTool', software);
  if (safeRoll.date) body += xmpElement('xmp:CreateDate', safeRoll.date);
  if (safeRoll.date) body += xmpElement('exif:DateTimeOriginal', `${safeRoll.date}T00:00:00`);
  if (safeRoll.iso) body += `      <exif:ISOSpeedRatings><rdf:Seq><rdf:li>${escapeXml(safeRoll.iso)}</rdf:li></rdf:Seq></exif:ISOSpeedRatings>\n`;
  body += xmpElement('tiff:Model', safeRoll.camera);
  body += xmpElement('aux:Lens', safeRoll.lens);
  body += xmpElement('AnalogExif:Film', safeRoll.stock);
  body += xmpElement('AnalogExif:RollId', safeRoll.rollName);
  body += xmpElement('AnalogExif:ExposureNumber', frameNumber);
  body += xmpElement('AnalogExif:DevelopProcess', safeRoll.process);
  body += xmpElement('AnalogExif:Lab', safeRoll.lab);
  body += xmpElement('AnalogExif:ScannerSoftware', software);
  if (keywords.length) {
    body += '      <dc:subject><rdf:Bag>\n';
    for (const keyword of keywords) body += `        <rdf:li>${escapeXml(keyword)}</rdf:li>\n`;
    body += '      </rdf:Bag></dc:subject>\n';
  }
  if (description) {
    body += `      <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(description)}</rdf:li></rdf:Alt></dc:description>\n`;
  }
  return '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>\n'
    + '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="NeoAnalogLab">\n'
    + '  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
    + '    <rdf:Description rdf:about=""\n'
    + '      xmlns:dc="http://purl.org/dc/elements/1.1/"\n'
    + '      xmlns:xmp="http://ns.adobe.com/xap/1.0/"\n'
    + '      xmlns:exif="http://ns.adobe.com/exif/1.0/"\n'
    + '      xmlns:tiff="http://ns.adobe.com/tiff/1.0/"\n'
    + '      xmlns:aux="http://ns.adobe.com/exif/1.0/aux/"\n'
    + `      xmlns:AnalogExif="${ANALOGEXIF_NS}">\n`
    + body
    + '    </rdf:Description>\n'
    + '  </rdf:RDF>\n'
    + '</x:xmpmeta>\n'
    + '<?xpacket end="w"?>';
}

/** Everything an export needs for one frame, ready for the writers. */
export function buildExportMetadata({ roll, frame, index, software } = {}) {
  if (!hasAnalogMetadata(roll, frame)) return null;
  return {
    exif: buildExifFields({ roll, frame, index, software }),
    xmp: buildXmpPacket({ roll, frame, index, software })
  };
}
