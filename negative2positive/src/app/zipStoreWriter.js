const ZIP_MAX_U16 = 0xFFFF;
const ZIP_MAX_U32 = 0xFFFFFFFF;
const ZIP_VERSION_NEEDED = 20;
const ZIP_VERSION_ZIP64 = 45;
const ZIP_GENERAL_PURPOSE_UTF8 = 0x0800;
const ZIP_METHOD_STORE = 0;
const ZIP64_EXTRA_ID = 0x0001;

const textEncoder = new TextEncoder();

const crc32Table = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function ensureZipU16(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > ZIP_MAX_U16) {
    const err = new Error(`${label} exceeds the ZIP32 limit.`);
    err.code = 'ZIP_LIMIT';
    throw err;
  }
  return value;
}

function ensureSafeSize(value, label) {
  // ZIP64 lifts the 4 GB ceiling; what remains is the exact-integer range of a
  // JS number, which every real archive stays far below.
  if (!Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    const err = new Error(`${label} is not a valid ZIP size.`);
    err.code = 'ZIP_LIMIT';
    throw err;
  }
  return value;
}

/**
 * Append ` (2)`, ` (3)`… before the extension until the name is unused.
 * Comparison is case-insensitive because the archive is usually extracted onto
 * a case-insensitive filesystem, where `DSC_0001.tif` and `dsc_0001.tif` from
 * two different rolls would still collide.
 */
export function dedupeEntryName(name, usedLowerCaseNames) {
  const base = normalizeZipEntryName(name);
  if (!usedLowerCaseNames || !usedLowerCaseNames.has(base.toLowerCase())) return base;

  const slash = base.lastIndexOf('/');
  const dir = slash >= 0 ? base.slice(0, slash + 1) : '';
  const file = slash >= 0 ? base.slice(slash + 1) : base;
  const dot = file.lastIndexOf('.');
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : '';

  for (let n = 2; n < 100000; n++) {
    const candidate = `${dir}${stem} (${n})${ext}`;
    if (!usedLowerCaseNames.has(candidate.toLowerCase())) return candidate;
  }
  return `${dir}${stem} (${Date.now()})${ext}`;
}

/**
 * Name allocator shared by every export path (streamed ZIP, JSZip, individual
 * downloads) so same-named frames from different folders never overwrite each
 * other.
 */
export function createZipNameDeduper() {
  const used = new Set();
  return function claim(name) {
    const unique = dedupeEntryName(name, used);
    used.add(unique.toLowerCase());
    return unique;
  };
}

function normalizeZipEntryName(name) {
  const normalized = String(name || 'export.bin').replace(/\\/g, '/');
  const parts = normalized
    .split('/')
    .filter(part => part && part !== '.' && part !== '..');
  return parts.length ? parts.join('/') : 'export.bin';
}

function encodeEntryName(name) {
  const bytes = textEncoder.encode(normalizeZipEntryName(name));
  ensureZipU16(bytes.length, 'ZIP entry name length');
  return bytes;
}

function toUint8Array(chunk) {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new Error('Unsupported ZIP stream chunk type.');
}

async function* readBlobChunks(blob) {
  if (blob && typeof blob.stream === 'function') {
    const reader = blob.stream().getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) yield toUint8Array(value);
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }

  if (blob && typeof blob.arrayBuffer === 'function') {
    yield new Uint8Array(await blob.arrayBuffer());
    return;
  }

  throw new Error('ZIP entry payload is not a Blob.');
}

async function crc32OfBlob(blob) {
  let crc = 0xFFFFFFFF;
  for await (const chunk of readBlobChunks(blob)) {
    for (let i = 0; i < chunk.length; i++) {
      crc = crc32Table[(crc ^ chunk[i]) & 0xFF] ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function getDosDateTime(date = new Date()) {
  const safeDate = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date();
  const year = Math.max(1980, Math.min(2107, safeDate.getFullYear()));
  const month = Math.max(1, Math.min(12, safeDate.getMonth() + 1));
  const day = Math.max(1, Math.min(31, safeDate.getDate()));
  const hours = Math.max(0, Math.min(23, safeDate.getHours()));
  const minutes = Math.max(0, Math.min(59, safeDate.getMinutes()));
  const seconds = Math.max(0, Math.min(58, Math.floor(safeDate.getSeconds() / 2) * 2));

  return {
    time: (hours << 11) | (minutes << 5) | (seconds / 2),
    date: ((year - 1980) << 9) | (month << 5) | day
  };
}

function createLocalFileHeader(entry) {
  // ZIP64 keeps the 32-bit size fields at 0xFFFFFFFF and puts the real values
  // in the 0x0001 extra field. The local record carries sizes only — never the
  // offset — per APPNOTE 4.5.3.
  const extraLength = entry.zip64 ? 20 : 0;
  const header = new Uint8Array(30 + entry.nameBytes.length + extraLength);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034B50, true);
  view.setUint16(4, entry.zip64 ? ZIP_VERSION_ZIP64 : ZIP_VERSION_NEEDED, true);
  view.setUint16(6, ZIP_GENERAL_PURPOSE_UTF8, true);
  view.setUint16(8, ZIP_METHOD_STORE, true);
  view.setUint16(10, entry.dosTime, true);
  view.setUint16(12, entry.dosDate, true);
  view.setUint32(14, entry.crc32, true);
  view.setUint32(18, entry.zip64 ? ZIP_MAX_U32 : entry.size, true);
  view.setUint32(22, entry.zip64 ? ZIP_MAX_U32 : entry.size, true);
  view.setUint16(26, entry.nameBytes.length, true);
  view.setUint16(28, extraLength, true);
  header.set(entry.nameBytes, 30);
  if (entry.zip64) {
    const at = 30 + entry.nameBytes.length;
    view.setUint16(at, ZIP64_EXTRA_ID, true);
    view.setUint16(at + 2, 16, true);
    view.setBigUint64(at + 4, BigInt(entry.size), true);
    view.setBigUint64(at + 12, BigInt(entry.size), true);
  }
  return header;
}

function createCentralDirectoryHeader(entry) {
  const bigSize = entry.zip64;
  const bigOffset = entry.localHeaderOffset > ZIP_MAX_U32 || entry.zip64;
  const extraValues = (bigSize ? 2 : 0) + (bigOffset ? 1 : 0);
  const extraLength = extraValues ? 4 + extraValues * 8 : 0;

  const header = new Uint8Array(46 + entry.nameBytes.length + extraLength);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x02014B50, true);
  view.setUint16(4, extraValues ? ZIP_VERSION_ZIP64 : ZIP_VERSION_NEEDED, true);
  view.setUint16(6, extraValues ? ZIP_VERSION_ZIP64 : ZIP_VERSION_NEEDED, true);
  view.setUint16(8, ZIP_GENERAL_PURPOSE_UTF8, true);
  view.setUint16(10, ZIP_METHOD_STORE, true);
  view.setUint16(12, entry.dosTime, true);
  view.setUint16(14, entry.dosDate, true);
  view.setUint32(16, entry.crc32, true);
  view.setUint32(20, bigSize ? ZIP_MAX_U32 : entry.size, true);
  view.setUint32(24, bigSize ? ZIP_MAX_U32 : entry.size, true);
  view.setUint16(28, entry.nameBytes.length, true);
  view.setUint16(30, extraLength, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, bigOffset ? ZIP_MAX_U32 : entry.localHeaderOffset, true);
  header.set(entry.nameBytes, 46);
  if (extraValues) {
    // Order is fixed: uncompressed size, compressed size, local header offset,
    // and only the ones whose 32-bit slot was set to 0xFFFFFFFF.
    let at = 46 + entry.nameBytes.length;
    view.setUint16(at, ZIP64_EXTRA_ID, true);
    view.setUint16(at + 2, extraValues * 8, true);
    at += 4;
    if (bigSize) {
      view.setBigUint64(at, BigInt(entry.size), true);
      view.setBigUint64(at + 8, BigInt(entry.size), true);
      at += 16;
    }
    if (bigOffset) view.setBigUint64(at, BigInt(entry.localHeaderOffset), true);
  }
  return header;
}

function createEndOfCentralDirectory(entryCount, centralDirectorySize, centralDirectoryOffset, forceZip64) {
  ensureSafeSize(centralDirectorySize, 'ZIP central directory size');
  ensureSafeSize(centralDirectoryOffset, 'ZIP central directory offset');

  const needsZip64 = Boolean(forceZip64)
    || entryCount > ZIP_MAX_U16
    || centralDirectorySize > ZIP_MAX_U32
    || centralDirectoryOffset > ZIP_MAX_U32;

  const header = new Uint8Array(needsZip64 ? 22 + 56 + 20 : 22);
  const view = new DataView(header.buffer);
  let at = 0;

  if (needsZip64) {
    const zip64EocdOffset = centralDirectoryOffset + centralDirectorySize;
    view.setUint32(0, 0x06064B50, true);
    view.setBigUint64(4, BigInt(44), true);        // size of the record that follows
    view.setUint16(12, ZIP_VERSION_ZIP64, true);
    view.setUint16(14, ZIP_VERSION_ZIP64, true);
    view.setUint32(16, 0, true);
    view.setUint32(20, 0, true);
    view.setBigUint64(24, BigInt(entryCount), true);
    view.setBigUint64(32, BigInt(entryCount), true);
    view.setBigUint64(40, BigInt(centralDirectorySize), true);
    view.setBigUint64(48, BigInt(centralDirectoryOffset), true);

    view.setUint32(56, 0x07064B50, true);          // ZIP64 EOCD locator
    view.setUint32(60, 0, true);
    view.setBigUint64(64, BigInt(zip64EocdOffset), true);
    view.setUint32(72, 1, true);
    at = 76;
  }

  view.setUint32(at, 0x06054B50, true);
  view.setUint16(at + 4, 0, true);
  view.setUint16(at + 6, 0, true);
  view.setUint16(at + 8, Math.min(entryCount, ZIP_MAX_U16), true);
  view.setUint16(at + 10, Math.min(entryCount, ZIP_MAX_U16), true);
  view.setUint32(at + 12, needsZip64 ? ZIP_MAX_U32 : centralDirectorySize, true);
  view.setUint32(at + 16, needsZip64 ? ZIP_MAX_U32 : centralDirectoryOffset, true);
  view.setUint16(at + 20, 0, true);
  return header;
}

export function canUseBrowserZipStreaming(globalObject = globalThis) {
  return Boolean(
    globalObject
    && typeof globalObject.showSaveFilePicker === 'function'
  );
}

export class ZipStoreWriter {
  constructor(writable, options = {}) {
    if (!writable || typeof writable.write !== 'function') {
      throw new Error('A writable file stream is required for ZIP export.');
    }
    this.writable = writable;
    this.entries = [];
    this.position = 0;
    this.closed = false;
    this.now = options.now instanceof Date ? options.now : null;
    // Emit ZIP64 records even for a small archive. Only used by tests — real
    // archives switch automatically once a field overflows.
    this.forceZip64 = options.forceZip64 === true;
    this.usedNames = new Set();
  }

  async writeChunk(chunk) {
    const bytes = toUint8Array(chunk);
    ensureSafeSize(this.position + bytes.byteLength, 'ZIP archive size');
    await this.writable.write(bytes);
    this.position += bytes.byteLength;
  }

  async addBlob(name, blob) {
    if (this.closed) throw new Error('ZIP writer is already closed.');
    if (!(blob instanceof Blob)) {
      throw new Error('ZIP entry payload is not a Blob.');
    }

    const size = ensureSafeSize(blob.size, 'ZIP entry size');
    const crc32 = await crc32OfBlob(blob);
    const { time, date } = getDosDateTime(this.now || new Date());
    // Two frames from different folders can share a basename; without this the
    // archive gets duplicate entries and extractors silently drop one.
    const uniqueName = dedupeEntryName(name, this.usedNames);
    const nameBytes = encodeEntryName(uniqueName);
    const localHeaderOffset = ensureSafeSize(this.position, 'ZIP local header offset');
    const entry = {
      nameBytes,
      size,
      crc32,
      dosTime: time,
      dosDate: date,
      localHeaderOffset,
      zip64: this.forceZip64 || size > ZIP_MAX_U32 || localHeaderOffset > ZIP_MAX_U32
    };

    await this.writeChunk(createLocalFileHeader(entry));
    for await (const chunk of readBlobChunks(blob)) {
      await this.writeChunk(chunk);
    }
    this.entries.push(entry);
    this.usedNames.add(uniqueName.toLowerCase());
    return uniqueName;
  }

  async close() {
    if (this.closed) return;

    const centralDirectoryOffset = ensureSafeSize(this.position, 'ZIP central directory offset');
    let centralDirectorySize = 0;
    for (const entry of this.entries) {
      const header = createCentralDirectoryHeader(entry);
      centralDirectorySize += header.byteLength;
      ensureSafeSize(centralDirectorySize, 'ZIP central directory size');
      await this.writeChunk(header);
    }

    await this.writeChunk(createEndOfCentralDirectory(
      this.entries.length,
      centralDirectorySize,
      centralDirectoryOffset,
      this.forceZip64
    ));

    if (typeof this.writable.close === 'function') {
      await this.writable.close();
    }
    this.closed = true;
  }

  async abort() {
    if (this.closed) return;
    this.closed = true;
    if (typeof this.writable.abort === 'function') {
      await this.writable.abort();
    }
  }
}
