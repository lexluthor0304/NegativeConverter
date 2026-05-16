const ZIP_MAX_U16 = 0xFFFF;
const ZIP_MAX_U32 = 0xFFFFFFFF;
const ZIP_VERSION_NEEDED = 20;
const ZIP_GENERAL_PURPOSE_UTF8 = 0x0800;
const ZIP_METHOD_STORE = 0;

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
    throw new Error(`${label} exceeds the ZIP32 limit.`);
  }
  return value;
}

function ensureZipU32(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > ZIP_MAX_U32) {
    throw new Error(`${label} exceeds the ZIP32 limit.`);
  }
  return value;
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
  const header = new Uint8Array(30 + entry.nameBytes.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034B50, true);
  view.setUint16(4, ZIP_VERSION_NEEDED, true);
  view.setUint16(6, ZIP_GENERAL_PURPOSE_UTF8, true);
  view.setUint16(8, ZIP_METHOD_STORE, true);
  view.setUint16(10, entry.dosTime, true);
  view.setUint16(12, entry.dosDate, true);
  view.setUint32(14, entry.crc32, true);
  view.setUint32(18, entry.size, true);
  view.setUint32(22, entry.size, true);
  view.setUint16(26, entry.nameBytes.length, true);
  view.setUint16(28, 0, true);
  header.set(entry.nameBytes, 30);
  return header;
}

function createCentralDirectoryHeader(entry) {
  const header = new Uint8Array(46 + entry.nameBytes.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x02014B50, true);
  view.setUint16(4, ZIP_VERSION_NEEDED, true);
  view.setUint16(6, ZIP_VERSION_NEEDED, true);
  view.setUint16(8, ZIP_GENERAL_PURPOSE_UTF8, true);
  view.setUint16(10, ZIP_METHOD_STORE, true);
  view.setUint16(12, entry.dosTime, true);
  view.setUint16(14, entry.dosDate, true);
  view.setUint32(16, entry.crc32, true);
  view.setUint32(20, entry.size, true);
  view.setUint32(24, entry.size, true);
  view.setUint16(28, entry.nameBytes.length, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, entry.localHeaderOffset, true);
  header.set(entry.nameBytes, 46);
  return header;
}

function createEndOfCentralDirectory(entryCount, centralDirectorySize, centralDirectoryOffset) {
  ensureZipU16(entryCount, 'ZIP entry count');
  ensureZipU32(centralDirectorySize, 'ZIP central directory size');
  ensureZipU32(centralDirectoryOffset, 'ZIP central directory offset');

  const header = new Uint8Array(22);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x06054B50, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, entryCount, true);
  view.setUint16(10, entryCount, true);
  view.setUint32(12, centralDirectorySize, true);
  view.setUint32(16, centralDirectoryOffset, true);
  view.setUint16(20, 0, true);
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
  }

  async writeChunk(chunk) {
    const bytes = toUint8Array(chunk);
    ensureZipU32(this.position + bytes.byteLength, 'ZIP archive size');
    await this.writable.write(bytes);
    this.position += bytes.byteLength;
  }

  async addBlob(name, blob) {
    if (this.closed) throw new Error('ZIP writer is already closed.');
    if (!(blob instanceof Blob)) {
      throw new Error('ZIP entry payload is not a Blob.');
    }
    ensureZipU16(this.entries.length + 1, 'ZIP entry count');

    const size = ensureZipU32(blob.size, 'ZIP entry size');
    const crc32 = await crc32OfBlob(blob);
    const { time, date } = getDosDateTime(this.now || new Date());
    const nameBytes = encodeEntryName(name);
    ensureZipU32(this.position + 30 + nameBytes.length + size, 'ZIP archive size');
    const entry = {
      nameBytes,
      size,
      crc32,
      dosTime: time,
      dosDate: date,
      localHeaderOffset: ensureZipU32(this.position, 'ZIP local header offset')
    };

    await this.writeChunk(createLocalFileHeader(entry));
    for await (const chunk of readBlobChunks(blob)) {
      await this.writeChunk(chunk);
    }
    this.entries.push(entry);
  }

  async close() {
    if (this.closed) return;

    const centralDirectoryOffset = ensureZipU32(this.position, 'ZIP central directory offset');
    let centralDirectorySize = 0;
    for (const entry of this.entries) {
      const header = createCentralDirectoryHeader(entry);
      centralDirectorySize += header.byteLength;
      ensureZipU32(centralDirectorySize, 'ZIP central directory size');
      await this.writeChunk(header);
    }

    await this.writeChunk(createEndOfCentralDirectory(
      this.entries.length,
      centralDirectorySize,
      centralDirectoryOffset
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
