/*
 * zip-driver.js - reads a (possibly >100 MB) ZIP without ever holding it in memory.
 * Primary path: read the central directory from the end of the file (ZIP64 aware), then visit the wanted
 * entries one at a time in file order, streaming each one through fflate's Inflate in ~1 MB slices.
 * Entries the user switched off are never read. Fallback (broken or missing central directory):
 * fflate's streaming Unzip over sequential slices.
 *
 * src: { size:number, name:string, read(start,end)->Promise<Uint8Array> }
 */
(function (root, factory) { root.FBZip = factory(root.fflate); })(typeof self !== 'undefined' ? self : globalThis, function (fflate) {
'use strict';
const CH = 1 << 20;

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function u64(b, o) { return u32(b, o) + u32(b, o + 4) * 4294967296; }
const td = new TextDecoder('utf-8');

async function readCentralDirectory(src) {
  const tailLen = Math.min(src.size, 66000), tail = await src.read(src.size - tailLen, src.size);
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 5 && tail[i + 3] === 6) { e = i; break; }
  if (e < 0) throw new Error('no end-of-central-directory record');
  let count = u16(tail, e + 10), cdSize = u32(tail, e + 12), cdOff = u32(tail, e + 16);
  if (count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOff === 0xFFFFFFFF) {
    const lo = e - 20;
    if (lo >= 0 && u32(tail, lo) === 0x07064b50) {
      const z64off = u64(tail, lo + 8);
      const z = await src.read(z64off, z64off + 56);
      if (u32(z, 0) !== 0x06064b50) throw new Error('bad ZIP64 end record');
      count = u64(z, 32); cdSize = u64(z, 40); cdOff = u64(z, 48);
    } else throw new Error('ZIP64 locator missing');
  }
  if (cdOff + cdSize > src.size) throw new Error('central directory outside file');
  const cd = await src.read(cdOff, cdOff + cdSize);
  const out = []; let p = 0;
  while (p + 46 <= cd.length && u32(cd, p) === 0x02014b50) {
    const flags = u16(cd, p + 8), method = u16(cd, p + 10);
    let csize = u32(cd, p + 20), usize = u32(cd, p + 24), nl = u16(cd, p + 28), xl = u16(cd, p + 30), cl = u16(cd, p + 32), off = u32(cd, p + 42);
    const name = td.decode(cd.subarray(p + 46, p + 46 + nl));
    let x = p + 46 + nl; const xe = x + xl;
    while (x + 4 <= xe) {
      const id = u16(cd, x), sz = u16(cd, x + 2);
      if (id === 1) { let q = x + 4; if (usize === 0xFFFFFFFF) { usize = u64(cd, q); q += 8; } if (csize === 0xFFFFFFFF) { csize = u64(cd, q); q += 8; } if (off === 0xFFFFFFFF) { off = u64(cd, q); q += 8; } }
      x += 4 + sz;
    }
    out.push({ name, method, csize, usize, off, flags });
    p += 46 + nl + xl + cl;
  }
  if (!out.length) throw new Error('empty central directory');
  return out;
}

/** Stream one entry's decoded bytes into handler.push(). */
async function streamEntry(src, ent, handler, opts) {
  const maxFirst = 30 + 600 + ent.name.length * 3;
  let want = Math.min(src.size - ent.off, maxFirst + ent.csize, CH + maxFirst);
  let buf = await src.read(ent.off, ent.off + want);
  if (u32(buf, 0) !== 0x04034b50) throw new Error('bad local header');
  const dataStart = 30 + u16(buf, 26) + u16(buf, 28);
  if (dataStart > buf.length) buf = await src.read(ent.off, ent.off + dataStart + Math.min(ent.csize, CH));
  let pos = ent.off + buf.length, first = buf.subarray(dataStart, Math.min(buf.length, dataStart + ent.csize));
  let remaining = ent.csize - first.length;
  let dec = null, ended = false;
  if (ent.method === 8) { dec = new fflate.Inflate(); dec.ondata = (chunk) => { if (chunk.length) handler.push(chunk, false); }; }
  else if (ent.method !== 0) throw new Error('unsupported compression method ' + ent.method);
  const feed = (chunk, final) => { if (dec) dec.push(chunk, final); else handler.push(chunk, false); };
  if (ent.csize === 0) { handler.push(new Uint8Array(0), true); return; }
  let chunk = first;
  for (;;) {
    const last = remaining <= 0;
    if (handler.failed) return;
    feed(chunk, last);
    if (opts.onBytes) opts.onBytes(chunk.length);
    if (last) break;
    if (opts.isCancelled && opts.isCancelled()) throw new Error('cancelled');
    const n = Math.min(CH, remaining);
    chunk = await src.read(pos, pos + n); pos += n; remaining -= n;
  }
  handler.push(new Uint8Array(0), true);
}

async function processZip(src, collector, opts) {
  opts = opts || {};
  const head = await src.read(0, Math.min(4, src.size));
  if (!(head[0] === 0x50 && head[1] === 0x4b)) {
    if (head[0] === 0x1f && head[1] === 0x8b) throw new Error('This is a .tgz/.gz archive. Please re-export from Google Takeout as .zip (File type: .zip).');
    throw new Error('This does not look like a ZIP file.');
  }
  let entries = null;
  try { entries = await readCentralDirectory(src); } catch (e) { entries = null; collector.acc.warnings.push({ path: src.name, msg: 'central directory unreadable (' + e.message + '); using sequential fallback' }); }
  if (entries) return processByDirectory(src, entries, collector, opts);
  return processSequential(src, collector, opts);
}

async function processByDirectory(src, entries, collector, opts) {
  entries = entries.filter(e => !e.name.endsWith('/')).sort((a, b) => a.off - b.off);
  let bytesDone = 0, total = entries.reduce((s, e) => s + e.csize, 0) || 1, nFile = 0;
  for (const ent of entries) {
    if (opts.isCancelled && opts.isCancelled()) throw new Error('cancelled');
    nFile++;
    const h = collector.start(ent.name, ent.usize);
    if (opts.onProgress) opts.onProgress({ file: ent.name, fileIndex: nFile, fileCount: entries.length, frac: bytesDone / total });
    if (!h) { bytesDone += ent.csize; continue; }
    const before = bytesDone;
    try {
      await streamEntry(src, ent, h, { isCancelled: opts.isCancelled, onBytes: n => { bytesDone += n; if (opts.onProgress) opts.onProgress({ file: ent.name, fileIndex: nFile, fileCount: entries.length, frac: bytesDone / total, tick: true }); } });
    } catch (e) {
      if (e && e.message === 'cancelled') throw e;
      h.failed = h.failed || ('corrupt entry: ' + (e && e.message || e));
    }
    bytesDone = before + ent.csize;
    h.end();
  }
  if (opts.onProgress) opts.onProgress({ file: '', fileIndex: nFile, fileCount: entries.length, frac: 1 });
  return { mode: 'central-directory', entries: entries.length };
}

async function processSequential(src, collector, opts) {
  const uz = new fflate.Unzip(); uz.register(fflate.UnzipInflate); if (fflate.UnzipPassThrough) uz.register(fflate.UnzipPassThrough);
  let n = 0, cur = null, pos = 0;
  uz.onfile = f => {
    n++;
    const h = collector.start(f.name, f.originalSize || 0);
    if (!h) return;
    cur = f.name;
    f.ondata = (err, chunk, final) => {
      if (err) { h.failed = h.failed || 'corrupt entry: ' + err.message; h.end(); return; }
      if (chunk && chunk.length) h.push(chunk, false);
      if (final) { h.push(new Uint8Array(0), true); h.end(); }
    };
    try { f.start(); } catch (e) { h.failed = 'unsupported entry: ' + e.message; h.end(); }
  };
  while (pos < src.size) {
    if (opts.isCancelled && opts.isCancelled()) throw new Error('cancelled');
    const end = Math.min(src.size, pos + CH), chunk = await src.read(pos, end); pos = end;
    try { uz.push(chunk, pos >= src.size); } catch (e) { collector.acc.errors.push({ path: src.name, msg: 'zip stream error near byte ' + pos + ': ' + e.message }); break; }
    if (opts.onProgress) opts.onProgress({ file: cur || '', fileIndex: n, fileCount: 0, frac: pos / src.size });
  }
  return { mode: 'sequential', entries: n };
}

return { processZip, readCentralDirectory };
});
