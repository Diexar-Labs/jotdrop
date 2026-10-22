// Minimal zip writer for import fixtures: stored or deflated entries, optional
// ZIP64 records, DOS timestamps and the Info-ZIP "UT" (0x5455) extended time.
const zlib = require("node:zlib");

function dosTime(date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** entries: [name, content, deflate, { mtime?: Date, unixTime?: Date }] */
function makeZip(entries, { zip64 = false } = {}) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content, deflate, options = {}] of entries) {
    const raw = Buffer.from(content);
    const data = deflate ? zlib.deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name, "utf8");
    const crc = zlib.crc32(raw);
    const stamp = options.mtime ? dosTime(options.mtime) : { time: 0, date: 0 };
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(deflate ? 8 : 0, 8); local.writeUInt16LE(stamp.time, 10); local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const extras = [];
    if (zip64) {
      const extra = Buffer.alloc(28);
      extra.writeUInt16LE(1, 0); extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(raw.length), 4); extra.writeBigUInt64LE(BigInt(data.length), 12); extra.writeBigUInt64LE(BigInt(offset), 20);
      extras.push(extra);
    }
    if (options.unixTime) {
      const extra = Buffer.alloc(9);
      extra.writeUInt16LE(0x5455, 0); extra.writeUInt16LE(5, 2); extra.writeUInt8(1, 4);
      extra.writeUInt32LE(Math.floor(options.unixTime.getTime() / 1000), 5);
      extras.push(extra);
    }
    const extra = Buffer.concat(extras);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(45, 4); central.writeUInt16LE(45, 6); central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(deflate ? 8 : 0, 10); central.writeUInt16LE(stamp.time, 12); central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(zip64 ? 0xffffffff : data.length, 20); central.writeUInt32LE(zip64 ? 0xffffffff : raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28); central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes, extra);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const tail = [];
  if (zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0); record.writeBigUInt64LE(44n, 4); record.writeUInt16LE(45, 12); record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(entries.length), 24); record.writeBigUInt64LE(BigInt(entries.length), 32);
    record.writeBigUInt64LE(BigInt(directory.length), 40); record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0); locator.writeBigUInt64LE(BigInt(offset + directory.length), 8); locator.writeUInt32LE(1, 16);
    tail.push(record, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 8); end.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  end.writeUInt32LE(zip64 ? 0xffffffff : directory.length, 12); end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  return new Blob([Buffer.concat([...locals, directory, ...tail, end])]);
}

/** Bundles a TypeScript module from src/ for node checks, with the Obsidian mock. */
async function loadSource(file) {
  const esbuild = require("esbuild");
  const path = require("node:path");
  const result = await esbuild.build({
    stdin: { contents: `export * from "./${file}";`, resolveDir: path.join(__dirname, "..") },
    bundle: true, platform: "node", format: "cjs", write: false,
    alias: { obsidian: path.join(__dirname, "mock-obsidian.cjs") },
  });
  const loaded = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(loaded, loaded.exports, require);
  return loaded.exports;
}

module.exports = { makeZip, loadSource };
