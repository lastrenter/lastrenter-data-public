// Dependency-free zip reader with a STREAMING line mode.
//
// Why streaming: a GTFS feed's stop_times.txt is the biggest file in Australian open data that
// we touch - VIC's regional coach feed alone inflates to hundreds of MB. Reading it into a
// Buffer works right up until the day it doesn't, on someone else's machine, with a confusing
// out-of-memory error. streamLines() never holds more than one chunk plus a partial line.

const zlib = require('zlib');
const { StringDecoder } = require('string_decoder');

function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record');

  const entries = new Map();
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (p === 0xffffffff) throw new Error('ZIP64 archive - reader does not support it');

  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry ' + k);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const fnLen = buf.readUInt16LE(p + 28);
    const exLen = buf.readUInt16LE(p + 30);
    const cmLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + fnLen).toString('utf8');
    entries.set(name, { method, compSize, local });
    p += 46 + fnLen + exLen + cmLen;
  }

  // The local header's own lengths are authoritative - its extra field can differ in size from
  // the central directory's, and trusting the wrong one shifts the data start by a few bytes.
  function slice(name) {
    const e = entries.get(name);
    if (!e) return null;
    if (buf.readUInt32LE(e.local) !== 0x04034b50) throw new Error('bad local header for ' + name);
    const fnLen = buf.readUInt16LE(e.local + 26);
    const exLen = buf.readUInt16LE(e.local + 28);
    const start = e.local + 30 + fnLen + exLen;
    return { raw: buf.slice(start, start + e.compSize), method: e.method };
  }

  return {
    names: () => [...entries.keys()],
    has: (name) => entries.has(name),

    read(name) {
      const s = slice(name);
      if (!s) return null;
      if (s.method === 0) return s.raw;
      if (s.method === 8) return zlib.inflateRawSync(s.raw);
      throw new Error('unsupported compression method ' + s.method + ' for ' + name);
    },

    /** Feed `onLine(line)` one line at a time without materialising the whole entry. */
    streamLines(name, onLine) {
      const s = slice(name);
      if (!s) return Promise.reject(new Error('no such entry: ' + name));
      return new Promise((resolve, reject) => {
        // ⚠️ StringDecoder, not chunk.toString(): a UTF-8 character split across two chunks
        // would otherwise become two replacement characters. Stop names carry accents.
        const dec = new StringDecoder('utf8');
        let rem = '';
        const feed = (text) => {
          const parts = (rem + text).split('\n');
          rem = parts.pop();
          for (const line of parts) onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
        };
        const finish = () => {
          feed(dec.end());
          if (rem) onLine(rem.endsWith('\r') ? rem.slice(0, -1) : rem);
          resolve();
        };
        if (s.method === 0) { feed(dec.write(s.raw)); finish(); return; }
        if (s.method !== 8) { reject(new Error('unsupported compression method ' + s.method)); return; }
        const inf = zlib.createInflateRaw();
        inf.on('data', (c) => feed(dec.write(c)));
        inf.on('end', finish);
        inf.on('error', reject);
        inf.end(s.raw);
      });
    },
  };
}

/**
 * Split one CSV line. GTFS is RFC4180: fields may be quoted and contain commas and doubled
 * quotes. A naive line.split(',') silently shifts every column after a stop name like
 * "Smith St/Jones Rd, Fitzroy" - which is extremely common in GTFS stop data.
 */
function csvSplit(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

module.exports = { readZip, csvSplit };
