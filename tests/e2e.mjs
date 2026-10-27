// End-to-end tests (Playwright library, no runner). Usage:
//   node tests/e2e.mjs [--base URL] [--device chromium,iphone,pixel] [--big] [--label local] [--shots]
// Without --base a local static server for public/ is started. Every non-origin request is blocked AND counted.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium, webkit, devices } from '@playwright/test';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const LABEL = opt('label', 'local');
const WANT = String(opt('device', 'chromium,iphone,pixel')).split(',');
const BIG = !!opt('big', false);
const BIGONLY = !!opt('bigonly', false);
const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'e2e-out'); fs.mkdirSync(OUT, { recursive: true });
const SHOTS = path.join(ROOT, 'docs', 'screenshots'); fs.mkdirSync(SHOTS, { recursive: true });
const FIX = n => path.join(ROOT, 'fixtures', n);
const exp = n => JSON.parse(fs.readFileSync(FIX(n + '.expected.json')));

// ---------- tiny assertion layer ----------
let pass = 0, fail = 0; const failures = []; let cur = '';
const check = (name, cond, detail) => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; failures.push(`${cur}: ${name} ${detail !== undefined ? JSON.stringify(detail) : ''}`); console.log(`  FAIL ${name}`, detail !== undefined ? JSON.stringify(detail) : ''); } };
const fmt = (v, d = 0) => v.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });

// ---------- static server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain' };
function serve() {
  const pub = path.join(ROOT, 'public');
  return new Promise(res => { const s = http.createServer((q, r) => { let p = decodeURIComponent(q.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html'; const f = path.join(pub, p); if (!f.startsWith(pub) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end('nf'); } r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }); fs.createReadStream(f).pipe(r); }).listen(0, '127.0.0.1', () => res({ s, url: 'http://127.0.0.1:' + s.address().port + '/' })); });
}

// ---------- memory sampler: sums PSS/RSS of every descendant of this node process ----------
function descendants() {
  const kids = new Map(); let pids = [];
  try { pids = fs.readdirSync('/proc').filter(x => /^\d+$/.test(x)); } catch { return []; }
  for (const p of pids) { try { const st = fs.readFileSync(`/proc/${p}/stat`, 'utf8'); const ppid = +st.slice(st.lastIndexOf(')') + 2).split(' ')[1]; (kids.get(ppid) || kids.set(ppid, []).get(ppid)).push(+p); } catch {} }
  const out = []; const stack = [...(kids.get(process.pid) || [])];
  while (stack.length) { const p = stack.pop(); out.push(p); for (const k of kids.get(p) || []) stack.push(k); }
  return out;
}
function memSnapshot() {
  let rss = 0, pss = 0, big = 0, bigName = '';
  for (const p of descendants()) {
    try {
      const r = +fs.readFileSync(`/proc/${p}/statm`, 'utf8').split(' ')[1] * 4096; rss += r;
      if (r > big) { big = r; try { bigName = fs.readFileSync(`/proc/${p}/comm`, 'utf8').trim(); } catch {} }
      try { const m = /Pss:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${p}/smaps_rollup`, 'utf8')); if (m) pss += +m[1] * 1024; } catch {}
    } catch {}
  }
  return { rss, pss, big, bigName };
}
function startSampler() {
  const s = { peakRss: 0, peakPss: 0, peakProc: 0, peakProcName: '', base: memSnapshot() }; let stop = false;
  const tick = () => { if (stop) return; const m = memSnapshot(); s.peakRss = Math.max(s.peakRss, m.rss); s.peakPss = Math.max(s.peakPss, m.pss); if (m.big > s.peakProc) { s.peakProc = m.big; s.peakProcName = m.bigName; } setTimeout(tick, 250); };
  tick(); s.stop = () => { stop = true; return s; }; return s;
}
const MB = b => Math.round(b / 1048576);

// ---------- page helpers ----------
const DEVICES = {
  chromium: { label: 'Desktop Chromium', type: chromium, ctx: { viewport: { width: 1280, height: 900 } } },
  iphone: { label: 'iPhone 14 (WebKit)', type: webkit, ctx: { ...devices['iPhone 14'] } },
  pixel: { label: 'Pixel 7 (Chromium)', type: chromium, ctx: { ...devices['Pixel 7'] } }
};

async function newPage(browser, d, base) {
  const context = await browser.newContext({ ...d.ctx, timezoneId: 'Europe/Berlin', locale: 'en-US', acceptDownloads: true });
  const origin = new URL(base).origin; const foreign = [];
  await context.route('**/*', route => { const u = route.request().url(); if (u.startsWith('data:') || u.startsWith('blob:') || new URL(u).origin === origin) return route.continue(); foreign.push(u); return route.abort(); });
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('response', r => { if (r.status() >= 400) errors.push('http ' + r.status() + ' ' + r.url()); });
  page.foreign = foreign; page.errors = errors; page.ctx = context;
  await page.goto(base); await page.waitForSelector('#file-input', { state: 'attached' });
  return page;
}
const visibleStage = async page => page.evaluate(() => ['pick', 'options', 'progress', 'error', 'results'].find(s => !document.getElementById('stage-' + s).hidden));

async function load(page, file, { deselect = [], watch = true, timeout = 600000, mem = false } = {}) {
  await page.setInputFiles('#file-input', file);
  await page.waitForSelector('#stage-options:not([hidden])', { timeout: 30000 });
  for (const g of deselect) await page.locator(`#opt-groups input[data-group="${g}"]`).uncheck();
  if (watch) await page.evaluate(() => { window.__prog = []; clearInterval(window.__pt); window.__pt = setInterval(() => { const st = document.getElementById('stage-progress'); if (st.hidden) return; window.__prog.push({ t: performance.now(), pct: document.getElementById('ppct').textContent, file: document.getElementById('pfile').textContent, w: document.getElementById('pbar').getBoundingClientRect().width || +document.getElementById('pbar').value || 0 }); }, 60); });
  const sampler = mem ? startSampler() : null; const t0 = Date.now();
  await page.click('#btn-start');
  await page.waitForSelector('#stage-results:not([hidden]), #stage-error:not([hidden])', { timeout });
  const wall = Date.now() - t0; const peak = sampler ? sampler.stop() : null;
  return { wall, peak, stage: await visibleStage(page) };
}
const stat = (page, id) => page.locator(`[data-stat="${id}"] [data-v]`).first().innerText();
async function tab(page, t) { await page.evaluate(t_ => window.FBApp.showTab(t_), t); await page.waitForTimeout(150); }
async function canvasReport(page) {
  return page.evaluate(() => [...document.querySelectorAll('.view:not([hidden]) canvas, [id^=view-]:not([hidden]) canvas')].map(c => {
    const card = c.closest('.card'); const nodata = !!(card && card.classList.contains('nodata'));
    let n = 0; if (!nodata && c.width > 0) { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 28) if (d[i] > 0) n++; }
    return { id: c.id, nodata, painted: n, w: c.width, h: c.height };
  }));
}
const TABS = ['overview', 'sleep', 'heart', 'activity', 'body', 'patterns', 'data'];

// ---------- scenario: full numeric verification on one export ----------
async function verifyExport(page, name, e, { shots, calories = true } = {}) {
  const S = e.summary;
  await page.evaluate(() => window.FBApp.setPreset('all'));
  await page.waitForTimeout(200);
  // Overview numbers
  const steps = await stat(page, 'steps');
  check(`${name}: avg steps ${fmt(Math.round(S.avgSteps))}`, steps.replace(/\s/g, '') === fmt(Math.round(S.avgSteps)), steps);
  const stText = await page.locator('[data-stat="steps"]').innerText();
  check(`${name}: best steps day ${S.bestStepsDay} / ${fmt(S.bestSteps)}`, stText.includes(fmt(S.bestSteps)), stText);
  const rhr = await stat(page, 'rhr');
  check(`${name}: avg resting HR ${S.avgRhr.toFixed(1)}`, rhr.startsWith(fmt(S.avgRhr, 1)), rhr);
  if (S.nights) {
    const sl = await stat(page, 'sleep'); const want = await page.evaluate(v => window.FBApp.A.fmtHM(v), S.avgAsleep);
    check(`${name}: avg sleep ${want}`, sl.replace(/\s/g, '') === want.replace(/\s/g, ''), [sl, want]);
  }
  const mdl = await page.evaluate(() => ({ first: window.FBApp.state.model.first, last: window.FBApp.state.model.last }));
  check(`${name}: date range ${e.startDate}..${e.endDate} covered`, mdl.first <= e.startDate && mdl.last >= e.endDate, mdl);
  if (shots) await page.screenshot({ path: path.join(SHOTS, `${shots}-overview.png`) });
  let rep = await canvasReport(page);
  check(`${name}: overview charts painted`, rep.length >= 3 && rep.filter(r => !r.nodata).every(r => r.painted > 30), rep);

  // Sleep
  await tab(page, 'sleep');
  if (S.nights) {
    const cnt = await page.locator('[data-stat="sl-dur"]').innerText();
    check(`${name}: sleep nights count ${S.nights}`, cnt.includes(String(S.nights) + ' nights'), cnt);
    rep = await canvasReport(page);
    check(`${name}: sleep charts painted`, rep.length >= 4 && rep.filter(r => !r.nodata).length >= 4 && rep.filter(r => !r.nodata).every(r => r.painted > 30), rep);
    if (shots) await page.screenshot({ path: path.join(SHOTS, `${shots}-sleep.png`) });
  } else {
    rep = await canvasReport(page);
    check(`${name}: sleep tab shows "no data" cards when sleep is missing`, rep.length > 0 && rep.every(r => r.nodata), rep);
  }

  // Heart: intraday day vs generator local-day stats
  await tab(page, 'heart');
  await page.click('#btn-settings'); await page.selectOption('#set-tz', 'Europe/Berlin'); await page.click('#btn-settings');
  await page.evaluate(() => window.FBApp.setPreset('all')); await tab(page, 'heart');
  const keys = Object.keys(e.hrLocal).filter(k => k > e.startDate && k < e.endDate).sort();
  for (const day of [keys[Math.floor(keys.length * 0.3)], keys[Math.floor(keys.length * 0.7)]]) {
    const [n, s, mn, mx] = e.hrLocal[day];
    await page.fill('#id-date', day); await page.dispatchEvent('#id-date', 'change'); await page.waitForTimeout(150);
    const info = await page.locator('#id-info').innerText();
    const want = `${fmt(n)} samples · min ${mn} · avg ${fmt(s / n, 1)} · max ${mx} bpm`;
    check(`${name}: intraday ${day} => ${want}`, info.includes(want), info);
  }
  rep = await canvasReport(page);
  check(`${name}: heart charts painted`, rep.filter(r => !r.nodata).length >= 4 && rep.filter(r => !r.nodata).every(r => r.painted > 30), rep.map(r => [r.id, r.nodata, r.painted]));
  if (shots) await page.screenshot({ path: path.join(SHOTS, `${shots}-heart.png`) });

  // Activity: workouts
  await tab(page, 'activity');
  await page.selectOption('#wk-filter', 'all');
  const wc = await page.locator('#wk-count').innerText();
  check(`${name}: workout count ${S.workouts}`, wc.trim() === `${S.workouts} workouts`, wc);
  const rows = await page.locator('#wk-types tbody tr').evaluateAll(trs => trs.map(t => [t.children[0].textContent.trim(), +t.children[1].textContent.replace(/,/g, '')]));
  const byType = Object.fromEntries(rows);
  check(`${name}: per-type counts`, JSON.stringify(Object.entries(S.workoutsByType).sort()) === JSON.stringify(Object.entries(byType).sort()), [byType, S.workoutsByType]);
  await page.selectOption('#wk-filter', 'Run');
  check(`${name}: Run filter => ${S.workoutsByType.Run}`, (await page.locator('#wk-count').innerText()).trim() === `${S.workoutsByType.Run} workouts`);
  await page.selectOption('#wk-filter', 'all');
  const hm = await page.evaluate(() => { const c = document.getElementById('hm-canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 16) if (d[i] > 0) n++; return { n, w: c.width, h: c.height, cw: c.clientWidth, pw: c.parentElement.clientWidth }; });
  check(`${name}: heatmap painted`, hm.n > 200, hm);
  rep = await canvasReport(page);
  check(`${name}: activity charts painted`, rep.filter(r => !r.nodata).length >= 3 && rep.filter(r => !r.nodata).every(r => r.painted > 30 || r.id === 'hm-canvas'), rep.map(r => [r.id, r.nodata, r.painted]));
  if (shots) await page.screenshot({ path: path.join(SHOTS, `${shots}-activity.png`) });

  // Remaining tabs: render without errors
  for (const t of ['body', 'patterns', 'data']) { await tab(page, t); }
  if (shots) { await tab(page, 'body'); await page.screenshot({ path: path.join(SHOTS, `${shots}-body.png`) }); await tab(page, 'patterns'); await page.screenshot({ path: path.join(SHOTS, `${shots}-patterns.png`) }); }
  await tab(page, 'data');
  const types = await page.locator('[data-testid="types-table"]').innerText().catch(() => '');
  check(`${name}: data tab lists types`, /Heart rate/i.test(types) && /Steps/i.test(types), types.slice(0, 200));
  const bad = await page.locator('[data-testid="bad-files"]').innerText();
  const diag = await page.locator('[data-testid="diag-text"]').inputValue();
  for (const u of e.unknown) check(`${name}: unrecognised file listed (${path.basename(u)})`, bad.includes(path.basename(u)) && diag.includes(path.basename(u)), bad.slice(0, 300));
  for (const c of e.corrupt) { const base = path.basename(c.replace(/\s+\(.*$/, '')); check(`${name}: corrupt file listed (${base})`, bad.includes(base), bad.slice(0, 300)); const mm = /truncated, (\d+) complete/.exec(c); if (mm) check(`${name}: truncated file reports ${mm[1]} records read`, bad.includes(`${mm[1]} records read before`), bad.slice(-300)); }
  check(`${name}: diagnostics contain no health values (no 'beats per minute' rows / numbers lines)`, !/\d{2}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}/.test(diag), diag.slice(0, 200));
}

async function suite(key, base) {
  const d = DEVICES[key]; cur = d.label; console.log(`\n=== ${d.label} @ ${base}`);
  const browser = await d.type.launch({ args: key === 'iphone' ? [] : ['--enable-precise-memory-info'] });
  const report = { device: d.label, base, measurements: {} };
  const shotKey = { chromium: 'desktop', iphone: 'iphone14', pixel: 'pixel7' }[key];
  try {
    if (!BIGONLY) {
      // --- privacy + JSON export
      let page = await newPage(browser, d, base);
      const csp = await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || '');
      check('CSP meta present and limits connect-src to self', /connect-src 'self'/.test(csp) || /default-src 'self'/.test(csp), csp);
      const r = await load(page, FIX('takeout-json.zip'), { mem: true });
      check('json export: results stage reached', r.stage === 'results', r);
      const prog = await page.evaluate(() => window.__prog);
      check('progress UI updated while parsing', prog.length >= 3, prog.length);
      check('progress shows a current file name', new Set(prog.map(p => p.file)).size >= 3, [...new Set(prog.map(p => p.file))].slice(0, 5));
      const pcts = prog.map(p => parseFloat(p.pct)).filter(x => !isNaN(x));
      check('progress percentage monotonic and reaches >= 90', pcts.every((x, i) => i === 0 || x >= pcts[i - 1]) && Math.max(...pcts) >= 90, [pcts[0], Math.max(...pcts)]);
      report.measurements.smallJson = { wallMs: r.wall, peakProcMB: MB(r.peak.peakProc), peakTreePssMB: MB(r.peak.peakPss) };
      await verifyExport(page, 'json', exp('takeout-json'), { shots: shotKey });
      // mobile layout: no horizontal overflow
      for (const t of TABS) { await tab(page, t); const ov = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); check(`no horizontal overflow on ${t}`, ov <= 1, ov); }
      // summary export / import
      await tab(page, 'data');
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#dt-sum')]);
      const sumPath = path.join(OUT, `summary-${key}.json`); await dl.saveAs(sumPath);
      const sumSize = fs.statSync(sumPath).size; check(`summary json is small (${(sumSize / 1e6).toFixed(2)} MB)`, sumSize < 12e6 && sumSize > 1e3);
      // diagnostics copy button
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
      await page.click('#dt-copy'); await page.waitForFunction(() => document.getElementById('dt-copied').textContent.length > 0, null, { timeout: 5000 }).catch(() => {}); const copied = await page.locator('#dt-copied').innerText(); check('copy diagnostics gives feedback', /Copied|blocked/.test(copied), copied);
      check('no foreign requests (all blocked requests would be listed)', page.foreign.length === 0, page.foreign);
      check('no console/page errors', page.errors.length === 0, page.errors);
      const avgBefore = await page.evaluate(() => window.FBApp.state.model && window.FBApp.A.mean(window.FBApp.A.values(window.FBApp.state.model, 'steps', window.FBApp.A.dateRange(window.FBApp.state.model.first, window.FBApp.state.model.last))));
      await page.context().close();
      page = await newPage(browser, d, base);
      await page.setInputFiles('#summary-input', sumPath);
      await page.waitForSelector('#stage-results:not([hidden])', { timeout: 30000 });
      await page.evaluate(() => window.FBApp.setPreset('all'));
      const steps2 = await stat(page, 'steps'); const e = exp('takeout-json');
      check('summary import: avg steps equal', steps2.replace(/\s/g, '') === fmt(Math.round(e.summary.avgSteps)), steps2);
      await tab(page, 'activity'); check('summary import: workouts count', (await page.locator('#wk-count').innerText()).trim() === `${e.summary.workouts} workouts`);
      check('summary import: no foreign requests', page.foreign.length === 0, page.foreign);
      await page.context().close();

      // --- CSV variant
      page = await newPage(browser, d, base);
      const rc = await load(page, FIX('takeout-csv.zip'));
      check('csv export: results stage reached', rc.stage === 'results', rc);
      await verifyExport(page, 'csv', exp('takeout-csv'), { shots: key === 'chromium' ? 'desktop-csv' : null });
      check('csv: no foreign requests', page.foreign.length === 0, page.foreign);
      check('csv: no console/page errors', page.errors.length === 0, page.errors);
      await page.context().close();

      // --- ZIP64 variant
      page = await newPage(browser, d, base);
      const r64 = await load(page, FIX('takeout-zip64.zip'));
      check('zip64 export: results stage reached', r64.stage === 'results', r64);
      await page.evaluate(() => window.FBApp.setPreset('all'));
      const e64 = exp('takeout-zip64'); const s64 = await stat(page, 'steps');
      check('zip64: avg steps', s64.replace(/\s/g, '') === fmt(Math.round(e64.summary.avgSteps)), [s64, e64.summary.avgSteps]);
      await page.context().close();

      // --- missing types + corrupt files
      page = await newPage(browser, d, base);
      const rm = await load(page, FIX('takeout-missing.zip'));
      check('missing/corrupt export: still reaches results (no crash)', rm.stage === 'results', rm);
      await verifyExport(page, 'missing', exp('takeout-missing'), { shots: key === 'chromium' ? 'desktop-missing' : null });
      await tab(page, 'body');
      const brep = await canvasReport(page);
      check('missing: body tab shows no-data cards for missing types', brep.some(x => x.nodata), brep.map(x => [x.id, x.nodata]));
      check('missing: no console/page errors', page.errors.length === 0, page.errors);
      await page.context().close();

      // --- deselect HR group
      page = await newPage(browser, d, base);
      const groups = await (async () => { await page.setInputFiles('#file-input', FIX('takeout-json.zip')); await page.waitForSelector('#stage-options:not([hidden])'); return page.locator('#opt-groups input').evaluateAll(l => l.map(i => i.dataset.group)); })();
      check('options screen offers a heart-rate group', groups.includes('hr'), groups);
      const hrg = 'hr';
      await page.locator(`#opt-groups input[data-group="${hrg}"]`).uncheck();
      const tSkip = Date.now(); await page.click('#btn-start'); await page.waitForSelector('#stage-results:not([hidden])', { timeout: 120000 });
      const skipMs = Date.now() - tSkip; report.measurements.smallJsonNoHrMs = skipMs;
      const hrN = await page.evaluate(() => window.FBApp.state.model.hr ? window.FBApp.state.model.hr.days.size : 0);
      check('deselected heart-rate group is skipped entirely', hrN === 0, hrN);
      await tab(page, 'heart'); const hrep = await canvasReport(page);
      check('heart tab degrades gracefully when HR skipped (daily resting HR still drawn)', hrep.some(x => !x.nodata), hrep.map(x => [x.id, x.nodata]));
      await page.context().close();

      // --- bad input
      page = await newPage(browser, d, base);
      const junk = path.join(OUT, 'junk.zip'); fs.writeFileSync(junk, Buffer.from(Array.from({ length: 200000 }, (_, i) => (i * 7919 + 13) & 255)));
      await page.setInputFiles('#file-input', junk);
      await page.waitForSelector('#stage-error:not([hidden]), #stage-options:not([hidden])', { timeout: 20000 });
      let st = await visibleStage(page);
      if (st === 'options') { await page.click('#btn-start'); await page.waitForSelector('#stage-error:not([hidden])', { timeout: 30000 }); st = 'error'; }
      check('random bytes named .zip => friendly error stage', st === 'error' && (await page.locator('#err-msg').innerText()).length > 20, await page.locator('#err-msg').innerText());
      await page.click('#btn-err-back'); check('error "back" returns to the picker', (await visibleStage(page)) === 'pick');
      const trunc = path.join(OUT, 'truncated.zip'); const fd = fs.openSync(FIX('takeout-json.zip'), 'r'); const buf = Buffer.alloc(3e6); fs.readSync(fd, buf, 0, 3e6, 0); fs.closeSync(fd); fs.writeFileSync(trunc, buf);
      await page.setInputFiles('#file-input', trunc);
      await page.waitForSelector('#stage-error:not([hidden]), #stage-options:not([hidden])', { timeout: 20000 });
      st = await visibleStage(page); if (st === 'options') { await page.click('#btn-start'); await page.waitForSelector('#stage-error:not([hidden]), #stage-results:not([hidden])', { timeout: 60000 }); st = await visibleStage(page); }
      check('truncated ZIP => error or partial results, never a hang/crash', st === 'error' || st === 'results', st);
      check('truncated: no uncaught page errors', page.errors.length === 0, page.errors);
      await page.context().close();
    }

    // --- big ZIP (150 MB)
    if (BIG || BIGONLY) {
      const page = await newPage(browser, d, base);
      let cdp = null;
      if (key === 'pixel') { cdp = await page.context().newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 }); }
      const bigSize = fs.statSync(FIX('takeout-big.zip')).size;
      const eb = exp('takeout-big');
      const r = await load(page, FIX('takeout-big.zip'), { mem: true });
      check(`big (${MB(bigSize)} MB): results stage reached`, r.stage === 'results', r);
      const frame = await page.evaluate(() => window.FBApp.state.maxFrameGap);
      const tm = await page.evaluate(() => window.FBApp.state.timings);
      const prog = await page.evaluate(() => window.__prog);
      const gaps = prog.map((p, i) => i ? p.t - prog[i - 1].t : 0);
      report.measurements.big = { zipMB: MB(bigSize), wallSec: +(r.wall / 1000).toFixed(1), peakTreeRssMB: MB(r.peak.peakRss), peakTreePssMB: MB(r.peak.peakPss), baselineTreeRssMB: MB(r.peak.base.rss), peakSingleProcessMB: MB(r.peak.peakProc), peakProcessName: r.peak.peakProcName, maxFrameGapMs: Math.round(frame), maxProgressTickGapMs: Math.round(Math.max(0, ...gaps)), timings: tm, cpuThrottle: key === 'pixel' ? '4x (CDP)' : 'none' };
      console.log('  big:', JSON.stringify(report.measurements.big));
      check('big: UI never frozen (max rAF gap < 1500 ms)', frame < 1500, frame);
      check('big: progress ticks kept coming (max gap < 1500 ms)', Math.max(0, ...gaps) < 1500, Math.max(...gaps));
      check('big: peak single process under 1.5 GB', r.peak.peakProc < 1.5e9, MB(r.peak.peakProc));
      await verifyExport(page, 'big', eb, { shots: key === 'chromium' ? 'desktop-big' : null });
      check('big: no foreign requests', page.foreign.length === 0, page.foreign);
      check('big: no console/page errors', page.errors.length === 0, page.errors);
      await page.context().close();

      if (key === 'chromium') {
        // cancel mid-way
        const p2 = await newPage(browser, d, base);
        await p2.setInputFiles('#file-input', FIX('takeout-big.zip')); await p2.waitForSelector('#stage-options:not([hidden])');
        await p2.click('#btn-start'); await p2.waitForFunction(() => parseFloat(document.getElementById('ppct').textContent) >= 3, null, { timeout: 120000 });
        await p2.screenshot({ path: path.join(SHOTS, 'desktop-progress.png') });
        await p2.click('#btn-cancel');
        await p2.waitForSelector('#stage-options:not([hidden]), #stage-pick:not([hidden])', { timeout: 15000 });
        check('cancel mid-parse returns to options/pick screen', ['options', 'pick'].includes(await visibleStage(p2)), await visibleStage(p2));
        check('cancel: no page errors', p2.errors.length === 0, p2.errors);
        await p2.context().close();
      }
    }
  } catch (err) { fail++; failures.push(`${cur}: EXCEPTION ${err.stack || err}`); console.log('  EXCEPTION', err.stack || err); }
  await browser.close();
  return report;
}

// ---------- main ----------
let base = opt('base', null), srv = null;
if (!base || base === true) { const s = await serve(); srv = s.s; base = s.url; }
const reports = [];
for (const k of WANT) { if (DEVICES[k]) reports.push(await suite(k, base)); }
if (srv) srv.close();
const summary = { label: LABEL, base, date: new Date().toISOString(), pass, fail, failures, reports };
fs.writeFileSync(path.join(OUT, `report-${LABEL}.json`), JSON.stringify(summary, null, 2));
console.log(`\n${pass} passed, ${fail} failed`); if (fail) { console.log(failures.join('\n')); process.exit(1); }
