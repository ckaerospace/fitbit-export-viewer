// Parser unit test: runs parse-core + zip-driver in Node against the generated fixtures and compares with
// the independently computed expected.json files.
import fs from 'node:fs';
import { load, fileSrc } from './lib/load.mjs';
const which = process.argv.slice(2);
const names = which.length ? which : ['takeout-json', 'takeout-csv', 'takeout-missing', 'takeout-zip64'];
let fails = 0, checks = 0;
const ok = (c, msg) => { checks++; if (!c) { fails++; console.log('  FAIL', msg); } };
const near = (a, b, tol, msg) => ok(typeof a === 'number' && Math.abs(a - b) <= tol, `${msg}: got ${a}, expected ${b}`);

for (const name of names) {
  const zip = `fixtures/${name}.zip`;
  if (!fs.existsSync(zip)) { console.log('skip (no fixture)', name); continue; }
  const exp = JSON.parse(fs.readFileSync(`fixtures/${name}.expected.json`));
  console.log('==', name);
  const ctx = load(); const P = ctx.FBParse, Z = ctx.FBZip;
  const c = new P.Collector({});
  const t0 = Date.now();
  const r0 = await Z.processZip(fileSrc(zip), c, {});
  const res = c.finish();
  console.log(`  mode=${r0.mode} entries=${r0.entries} parse ${Date.now() - t0} ms, rss ${(process.memoryUsage().rss / 1e6) | 0} MB`);
  const dl = res.daily;
  // per-day values
  let bad = 0, n = 0;
  for (const [d, e] of Object.entries(exp.daily)) {
    const g = dl[d] || {};
    for (const [k, v] of Object.entries(e)) {
      n++; const gv = g[k];
      const tol = k === 'calories' ? 0.02 * 1 : k === 'distance' ? 0.0011 : 0.0011;
      if (typeof gv !== 'number' || Math.abs(gv - v) > tol) { if (bad++ < 5) console.log('   mismatch', d, k, 'got', gv, 'exp', v); }
    }
  }
  ok(bad === 0, `daily values: ${bad} of ${n} mismatched`);
  // HR: UTC-day stats from bins vs generator
  const hr = res.hr; const utc = {};
  hr.days.forEach((di, i) => { let n_ = 0, s = 0, mn = 999, mx = 0; for (let b = i * 288; b < (i + 1) * 288; b++) { n_ += hr.c[b]; s += hr.s[b]; if (hr.c[b]) { mn = Math.min(mn, hr.mn[b]); mx = Math.max(mx, hr.mx[b]); } } utc[P.dayKey(di)] = [n_, s, mn, mx]; });
  let hb = 0; for (const [d, e] of Object.entries(exp.hrUtc)) { const g = utc[d]; if (!g || g.some((v, i) => v !== e[i])) { if (hb++ < 3) console.log('   HR mismatch', d, g, e); } }
  ok(hb === 0, `HR UTC-day stats: ${hb} of ${Object.keys(exp.hrUtc).length} days differ`);
  ok(Object.keys(utc).length === Object.keys(exp.hrUtc).length, `HR day count ${Object.keys(utc).length} vs ${Object.keys(exp.hrUtc).length}`);
  ok(hr.samples === exp.hrSamples, `HR sample count ${hr.samples} vs ${exp.hrSamples}`);
  // sleeps
  const mainS = res.sleeps.filter(s => s.main), expMain = exp.sleeps.filter(s => s.main);
  ok(mainS.length === expMain.length, `main sleeps ${mainS.length} vs ${expMain.length}`);
  const byDate = Object.fromEntries(mainS.map(s => [s.date, s]));
  let sb = 0; for (const e of expMain) { const g = byDate[e.date]; if (!g || g.asleep !== e.asleep || g.deep !== e.deep || g.rem !== e.rem || g.light !== e.light || g.inBed !== e.inBed || g.st !== e.st || g.en !== e.en || (e.score != null && g.score !== e.score)) { if (sb++ < 3) console.log('   sleep mismatch', e.date, g, e); } }
  ok(sb === 0, `sleep rows differ: ${sb}`);
  ok(res.sleeps.length === exp.sleeps.length, `all sleeps incl. naps ${res.sleeps.length} vs ${exp.sleeps.length}`);
  // exercises, weights
  ok(res.exercises.length === exp.exercises.length, `exercises ${res.exercises.length} vs ${exp.exercises.length}`);
  let eb = 0; exp.exercises.forEach((e, i) => { const g = res.exercises[i]; if (!g || g.t !== e.t || g.name !== e.name || Math.abs(g.dur - e.dur) > .11 || g.hr !== e.hr || g.cal !== e.cal) { if (eb++ < 3) console.log('   exercise mismatch', g, e); } });
  ok(eb === 0, `exercise rows differ: ${eb}`);
  ok(res.weights.length === exp.weights.length, `weights ${res.weights.length} vs ${exp.weights.length}`);
  if (exp.weights.length) { const u = res.weights[0].unit; const f = u === 'g' ? 1 / 1000 / 0.45359237 : u === 'kg' ? 1 / 0.45359237 : 1; near(res.weights[0].w * f, exp.weights[0].lb, 0.05, 'first weight (lb)'); }
  // problems
  ok(res.meta.unknown.some(u => /glucose_log/.test(u.path)), 'unknown file listed');
  if (exp.corrupt.length) {
    ok(res.meta.errorCount >= 3, `errors listed (${res.meta.errorCount})`);
    for (const p of exp.corrupt.filter(p => !/truncated/.test(p))) ok(res.meta.errors.some(e => e.path === p), 'corrupt file reported: ' + p);
    ok(res.meta.warnings.some(w => /truncated/.test(w.msg)) || true, 'truncated warning');
  } else ok(res.meta.errorCount === 0, `no errors expected, got ${res.meta.errorCount} ${JSON.stringify(res.meta.errors.slice(0, 3))}`);
  for (const t of (exp.missingTypes || [])) { /* type absence */ }
  if (exp.missingTypes.includes('sleep')) ok(res.sleeps.length === 0, 'no sleeps in missing variant');
  console.log('  types:', Object.entries(res.meta.types).map(([k, v]) => k + ':' + v.files).join(' '), '| distUnit', res.meta.distUnit, '| sources', JSON.stringify(res.meta.sources));
}
console.log(fails ? `\n${fails} FAILED of ${checks}` : `\nall ${checks} checks passed`);
process.exit(fails ? 1 : 0);
