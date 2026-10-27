/* Web Worker: parses one or more Takeout ZIPs. Nothing leaves the browser. */
importScripts('vendor/fflate.js', 'parse-core.js', 'zip-driver.js');
let cancelled = false;
self.onmessage = async (ev) => {
  const m = ev.data;
  if (m.cmd === 'cancel') { cancelled = true; return; }
  if (m.cmd !== 'parse') return;
  cancelled = false;
  const t0 = performance.now();
  const collector = new FBParse.Collector({ groups: m.groups });
  let last = 0, zipsDone = 0;
  try {
    for (const file of m.files) {
      const src = { size: file.size, name: file.name, read: async (a, b) => new Uint8Array(await file.slice(a, b).arrayBuffer()) };
      await FBZip.processZip(src, collector, {
        isCancelled: () => cancelled,
        onProgress: p => {
          const now = performance.now();
          if (p.tick && now - last < 100) return;
          last = now;
          self.postMessage({ type: 'progress', file: p.file, fileIndex: p.fileIndex, fileCount: p.fileCount, frac: (zipsDone + p.frac) / m.files.length, zip: file.name, zipIndex: zipsDone + 1, zipCount: m.files.length, ms: now - t0 });
        }
      });
      zipsDone++;
    }
    const res = collector.finish();
    res.meta.parseMs = Math.round(performance.now() - t0);
    const tr = [res.hr.days.buffer, res.hr.s.buffer, res.hr.c.buffer, res.hr.mn.buffer, res.hr.mx.buffer];
    self.postMessage({ type: 'done', result: res }, tr);
  } catch (e) {
    self.postMessage({ type: e && e.message === 'cancelled' ? 'cancelled' : 'fatal', message: e && e.message || String(e) });
  }
};
