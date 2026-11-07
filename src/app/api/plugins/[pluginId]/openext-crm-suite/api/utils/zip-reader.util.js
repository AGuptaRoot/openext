'use strict';

/**
 * Minimal, dependency-free ZIP reader for small text packages.
 *
 * Reads the central directory, then each local entry, and inflates with
 * Node's zlib. Supports the two methods every zip tool writes (stored and
 * deflate). Rejects what a CRM extension package never needs: encryption,
 * zip64, multi-disk archives, directory traversal and oversized content.
 */

const zlib = require('zlib');

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x0008;

function zipError(message, code = 'INVALID_ZIP') {
  const error = new Error(message);
  error.status = 400;
  error.code = code;
  return error;
}

function findEndOfCentralDirectory(buffer) {
  // EOCD is at least 22 bytes and may be followed by a comment up to 65535 bytes.
  const minPos = Math.max(0, buffer.length - 22 - 65535);
  for (let pos = buffer.length - 22; pos >= minPos; pos -= 1) {
    if (buffer.readUInt32LE(pos) === SIG_EOCD) return pos;
  }
  return -1;
}

/** Normalise an entry path and refuse anything that could escape the package. */
function safeEntryPath(raw) {
  const path = String(raw || '').replace(/\\/g, '/');
  if (!path) throw zipError('Zip entry has an empty name', 'UNSAFE_PATH');
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) {
    throw zipError(`Zip entry uses an absolute path: ${path}`, 'UNSAFE_PATH');
  }
  const parts = path.split('/');
  if (parts.some((part) => part === '..')) {
    throw zipError(`Zip entry escapes the package: ${path}`, 'UNSAFE_PATH');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(path)) throw zipError(`Zip entry has control characters: ${path}`, 'UNSAFE_PATH');
  return path;
}

/**
 * @param {Buffer} buffer
 * @param {{ maxEntries?: number, maxTotalBytes?: number, maxEntryBytes?: number }} [limits]
 * @returns {Array<{ path: string, data: Buffer, isDirectory: boolean }>}
 */
function readZipEntries(buffer, limits = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw zipError('File is not a zip archive');
  const maxEntries = limits.maxEntries || 200;
  const maxTotalBytes = limits.maxTotalBytes || 5 * 1024 * 1024;
  const maxEntryBytes = limits.maxEntryBytes || 2 * 1024 * 1024;

  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw zipError('File is not a zip archive (no central directory)');

  const diskNumber = buffer.readUInt16LE(eocd + 4);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);

  if (diskNumber !== 0) throw zipError('Multi-disk zip archives are not supported', 'UNSUPPORTED_ZIP');
  if (entryCount === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    throw zipError('Zip64 archives are not supported', 'UNSUPPORTED_ZIP');
  }
  if (entryCount > maxEntries) throw zipError(`Zip has ${entryCount} entries; at most ${maxEntries} allowed`, 'TOO_MANY_ENTRIES');
  if (centralOffset + centralSize > buffer.length) throw zipError('Zip central directory is truncated');

  const entries = [];
  let pos = centralOffset;
  let totalBytes = 0;

  for (let i = 0; i < entryCount; i += 1) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== SIG_CENTRAL) {
      throw zipError('Zip central directory is corrupt');
    }
    const flags = buffer.readUInt16LE(pos + 8);
    const method = buffer.readUInt16LE(pos + 10);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const uncompressedSize = buffer.readUInt32LE(pos + 24);
    const nameLength = buffer.readUInt16LE(pos + 28);
    const extraLength = buffer.readUInt16LE(pos + 30);
    const commentLength = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    const name = buffer.toString('utf8', pos + 46, pos + 46 + nameLength);
    pos += 46 + nameLength + extraLength + commentLength;

    if (flags & FLAG_ENCRYPTED) throw zipError(`Zip entry is encrypted: ${name}`, 'UNSUPPORTED_ZIP');
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      throw zipError(`Zip entry uses an unsupported compression method: ${name}`, 'UNSUPPORTED_ZIP');
    }
    if (uncompressedSize > maxEntryBytes) {
      throw zipError(`Zip entry is too large (${uncompressedSize} bytes): ${name}`, 'ENTRY_TOO_LARGE');
    }
    totalBytes += uncompressedSize;
    if (totalBytes > maxTotalBytes) throw zipError('Zip contents exceed the size limit', 'ARCHIVE_TOO_LARGE');

    const path = safeEntryPath(name);
    const isDirectory = path.endsWith('/');

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw zipError(`Zip local header is corrupt: ${name}`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    // Sizes in the local header may be zero when a data descriptor follows;
    // the central directory values are authoritative either way.
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw zipError(`Zip entry data is truncated: ${name}`);
    void FLAG_DATA_DESCRIPTOR;

    let data = buffer.subarray(dataStart, dataEnd);
    if (!isDirectory) {
      if (method === METHOD_DEFLATE) {
        try {
          data = zlib.inflateRawSync(data, { maxOutputLength: maxEntryBytes });
        } catch (error) {
          throw zipError(`Zip entry could not be decompressed: ${name}`);
        }
      } else {
        data = Buffer.from(data);
      }
      if (data.length !== uncompressedSize) {
        throw zipError(`Zip entry size mismatch: ${name}`);
      }
    } else {
      data = Buffer.alloc(0);
    }

    entries.push({ path, data, isDirectory });
  }

  return entries;
}

/**
 * Build a zip buffer (stored entries, no compression). Used by tests and by
 * tooling that wants to produce a package without extra dependencies.
 * @param {Array<{ path: string, data: Buffer | string }>} files
 */
function writeStoredZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(String(file.path), 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data ?? ''), 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(METHOD_STORED, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(METHOD_STORED, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    localParts.push(local, name, data);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }

  const centralBuffer = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuffer, eocd]);
}

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

module.exports = {
  readZipEntries,
  writeStoredZip,
  safeEntryPath
};
