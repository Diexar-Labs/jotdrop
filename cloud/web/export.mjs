const encoder = new TextEncoder();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Uncompressed ZIP keeps exported Markdown and attachments usable without JotDrop. */
export function exportZip(files) {
  // ponytail: ZIP32 only; add streaming ZIP64 when exports can exceed 4 GiB.
  if (files.length > 65535) throw new Error('Export too large. Download smaller selections.');
  const local = [], central = [], names = new Set();
  let offset = 0;
  let centralSize = 0;
  for (const { path, bytes } of files) {
    if (typeof path !== 'string' || !path || path.startsWith('/') || /[\\\x00-\x1f:]/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..') || names.has(path)) throw new Error('Unsafe or duplicate export filename.');
    names.add(path);
    const name = encoder.encode(path);
    if (name.length > 65535 || !(bytes instanceof Uint8Array) || bytes.length > 0xffffffff) throw new Error('Export entry too large.');
    const checksum = crc32(bytes);
    const header = new Uint8Array(30 + name.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x800, true);
    view.setUint16(12, 33, true); // DOS date: 1980-01-01.
    view.setUint32(14, checksum, true);
    view.setUint32(18, bytes.length, true);
    view.setUint32(22, bytes.length, true);
    view.setUint16(26, name.length, true);
    header.set(name, 30);
    local.push(header, bytes);
    const directory = new Uint8Array(46 + name.length);
    const index = new DataView(directory.buffer);
    index.setUint32(0, 0x02014b50, true);
    index.setUint16(4, 20, true);
    index.setUint16(6, 20, true);
    index.setUint16(8, 0x800, true);
    index.setUint16(14, 33, true);
    index.setUint32(16, checksum, true);
    index.setUint32(20, bytes.length, true);
    index.setUint32(24, bytes.length, true);
    index.setUint16(28, name.length, true);
    index.setUint32(42, offset, true);
    directory.set(name, 46);
    central.push(directory);
    centralSize += directory.length;
    offset += header.length + bytes.length;
    if (offset + centralSize + 22 > 0xffffffff) throw new Error('Export too large. Download smaller selections.');
  }
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, files.length, true);
  view.setUint16(10, files.length, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, offset, true);
  return new Blob([...local, ...central, end], { type: 'application/zip' });
}
