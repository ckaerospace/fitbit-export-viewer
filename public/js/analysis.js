/* analysis.js - turns the worker's summary into chart-ready series. Pure functions, no DOM. */
(function (root, factory) { root.FBAnalysis = factory(root.FBParse); })(typeof self !== 'undefined' ? self : globalThis, function (P) {
'use strict';
const idx = P.dayIdxOfKey, key = P.dayKey;
const addDays = (k, n) => key(idx(k) + n);
const dateRange = (a, b) => { const o = []; for (let i = idx(a), e = idx(b); i <= e; i++) o.push(key(i)); return o; };
const weekday = k => ((idx(k) + 3) % 7 + 7) % 7; // 0 = Monday
const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const isNum = v => typeof v === 'number' && v === v;
function mean(a) { let s = 0, n = 0; for (const v of a) if (isNum(v)) { s += v; n++; } return n ? s / n : null; }
function sum(a) { let s = 0; for (const v of a) if (isNum(v)) s += v; return s; }
function count(a) { let n = 0; for (const v of a) if (isNum(v)) n++; return n; }
function minOf(a) { let m = null; for (const v of a) if (isNum(v) && (m === null || v < m)) m = v; return m; }
function maxOf(a) { let m = null; for (const v of a) if (isNum(v) && (m === null || v > m)) m = v; return m; }
function median(a) { const s = a.filter(isNum).sort((x, y) => x - y); if (!s.length) return null; const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; }
function pearson(xs, ys) {
  const p = []; for (let i = 0; i < xs.length; i++) if (isNum(xs[i]) && isNum(ys[i])) p.push([xs[i], ys[i]]);
  const n = p.length; if (n < 3) return { r: null, n, slope: null, intercept: null };
  const mx = mean(p.map(a => a[0])), my = mean(p.map(a => a[1])); let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of p) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  if (!sxx || !syy) return { r: null, n, slope: null, intercept: null };
  return { r: sxy / Math.sqrt(sxx * syy), n, slope: sxy / sxx, intercept: my - sxy / sxx * mx };
}

// ---- time zones (only heart rate needs them: the legacy heart-rate files are documented as UTC) ----
function tzOffsetFn(tz) {
  if (!tz || tz === 'none' || tz === 'UTC') return () => 0;
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  return t => { const o = {}; for (const x of f.formatToParts(new Date(t * 1000))) o[x.type] = +x.value; return Date.UTC(o.year, o.month - 1, o.day, o.hour === 24 ? 0 : o.hour, o.minute, o.second) / 1000 - t; };
}
/** Re-bin UTC 5-minute heart-rate bins into local days of a time zone. */
function rebinHr(hr, tz) {
  const off = tzOffsetFn(tz), days = new Map(), N = hr ? hr.days.length : 0;
  const get = d => { let o = days.get(d); if (!o) { o = { s: new Uint32Array(288), c: new Uint16Array(288), mn: new Uint8Array(288).fill(255), mx: new Uint8Array(288) }; days.set(d, o); } return o; };
  for (let i = 0; i < N; i++) {
    const t0 = hr.days[i] * 86400, o0 = off(t0), o1 = off(t0 + 86399);
    let tb = 288; if (o0 !== o1) for (let b = 1; b < 288; b++) if (off(t0 + b * 300) !== o0) { tb = b; break; }
    const base = i * 288;
    for (let b = 0; b < 288; b++) {
      const c = hr.c[base + b]; if (!c) continue;
      const loc = t0 + b * 300 + (b < tb ? o0 : o1), ld = Math.floor(loc / 86400), lb = ((loc - ld * 86400) / 300) | 0, o = get(ld);
      o.s[lb] += hr.s[base + b]; o.c[lb] += c; if (hr.mn[base + b] < o.mn[lb]) o.mn[lb] = hr.mn[base + b]; if (hr.mx[base + b] > o.mx[lb]) o.mx[lb] = hr.mx[base + b];
    }
  }
  const daily = {};
  for (const [d, o] of days) {
    let n = 0, s = 0, mn = 999, mx = 0;
    for (let b = 0; b < 288; b++) if (o.c[b]) { n += o.c[b]; s += o.s[b]; if (o.mn[b] < mn) mn = o.mn[b]; if (o.mx[b] > mx) mx = o.mx[b]; }
    if (n) daily[key(d)] = { n, avg: s / n, min: mn, max: mx };
  }
  return { days, daily };
}

function guessWeightUnit(weights) {
  if (!weights.length) return 'lb';
  const u = weights[0].unit; if (u === 'json') return 'lb'; if (u === 'g' || u === 'kg' || u === 'lb') return u;
  const med = median(weights.map(w => w.w)); return med > 1000 ? 'g' : med > 140 ? 'lb' : 'kg';
}
const toKg = (w, unit) => unit === 'g' ? w / 1000 : unit === 'lb' ? w * 0.45359237 : w;

function buildModel(raw, opts) {
  opts = opts || {};
  const tz = opts.tz || 'UTC';
  const hr = raw.hr && raw.hr.days && raw.hr.days.length ? rebinHr(raw.hr, tz) : { days: new Map(), daily: {} };
  const D = {};
  for (const d in raw.daily) D[d] = Object.assign({}, raw.daily[d]);
  const mk = d => D[d] || (D[d] = {});
  for (const d in hr.daily) { const o = mk(d), h = hr.daily[d]; o.hrAvg = h.avg; o.hrMin = h.min; o.hrMax = h.max; o.hrN = h.n; }
  if (raw.hrDaily) for (const d in raw.hrDaily) if (!hr.daily[d]) { const o = mk(d), h = raw.hrDaily[d]; o.hrAvg = h[1] / h[0]; o.hrMin = h[2]; o.hrMax = h[3]; o.hrN = h[0]; }
  // sleep
  const nights = {}, naps = [];
  for (const s of raw.sleeps) {
    const asleep = isNum(s.asleep) ? s.asleep : (isNum(s.inBed) && isNum(s.awake) ? s.inBed - s.awake : null);
    const st = s.st, bedMin = ((+st.slice(11, 13)) * 60 + (+st.slice(14, 16)) - 1080 + 1440) % 1440, wakeMin = (+s.en.slice(11, 13)) * 60 + (+s.en.slice(14, 16));
    const e = Object.assign({}, s, { asleep, bedMin, wakeMin, effPct: isNum(s.eff) ? s.eff : (asleep != null && s.inBed ? asleep / s.inBed * 100 : null) });
    if (s.main) { const o = nights[s.date]; if (!o || (asleep || 0) > (o.asleep || 0)) nights[s.date] = e; } else naps.push(e);
  }
  for (const d in nights) { const n = nights[d], o = mk(d); o.sleepMin = n.asleep; if (isNum(n.effPct)) o.effPct = n.effPct; if (isNum(n.score)) o.sleepScore = n.score; o.bedMin = n.bedMin; o.wakeMin = n.wakeMin; }
  // weight
  const wUnit = opts.weightSource && opts.weightSource !== 'auto' ? opts.weightSource : guessWeightUnit(raw.weights);
  const wByDay = {};
  for (const w of raw.weights) { const d = w.t.slice(0, 10); wByDay[d] = w; }
  for (const d in wByDay) { const o = mk(d), w = wByDay[d]; o.weightKg = toKg(w.w, wUnit); if (isNum(w.bmi)) o.bmi = w.bmi; if (isNum(w.fat)) o.fat = w.fat; }
  for (const f of raw.bodyfat || []) { const o = mk(f.t.slice(0, 10)); if (!isNum(o.fat)) o.fat = f.f; }
  for (const d in D) { const o = D[d]; if (isNum(o.moderately) || isNum(o.very)) o.activeMin = (o.moderately || 0) + (o.very || 0); if (isNum(o.azmFat) || isNum(o.azmCardio) || isNum(o.azmPeak)) o.azm = (o.azmFat || 0) + (o.azmCardio || 0) + (o.azmPeak || 0); }
  const dates = Object.keys(D).sort();
  const wk = raw.exercises.map(e => Object.assign({ date: e.t.slice(0, 10) }, e));
  return { raw, tz, daily: D, dates, first: dates[0] || null, last: dates[dates.length - 1] || null, nights, naps, exercises: wk, weights: raw.weights, weightUnit: wUnit, hr, meta: raw.meta };
}

function values(model, field, dates) { return dates.map(d => { const o = model.daily[d]; const v = o && o[field]; return isNum(v) ? v : null; }); }
function movingAvg(vals, win) {
  const out = new Array(vals.length).fill(null); let s = 0, n = 0; const q = [];
  for (let i = 0; i < vals.length; i++) {
    q.push(vals[i]); if (isNum(vals[i])) { s += vals[i]; n++; }
    if (q.length > win) { const x = q.shift(); if (isNum(x)) { s -= x; n--; } }
    if (n >= Math.max(2, Math.ceil(win / 3))) out[i] = s / n;
  }
  return out;
}
/** Bucket daily values (mean, or sum) into days / weeks / months so long ranges stay readable. */
function bucket(dates, vals, mode, how) {
  if (mode === 'day') return { labels: dates, values: vals, keys: dates };
  const g = new Map();
  dates.forEach((d, i) => { const k = mode === 'week' ? addDays(d, -weekday(d)) : d.slice(0, 7); let o = g.get(k); if (!o) g.set(k, o = []); o.push(vals[i]); });
  const labels = [], out = [];
  for (const [k, a] of g) { labels.push(k); out.push(how === 'sum' ? (count(a) ? sum(a) : null) : mean(a)); }
  return { labels, values: out, keys: labels };
}
function autoBucket(n) { return n <= 150 ? 'day' : n <= 800 ? 'week' : 'month'; }

function stat(model, field, dates, best) {
  const vals = values(model, field, dates), n = count(vals);
  const avg = mean(vals); let bi = -1;
  vals.forEach((v, i) => { if (isNum(v) && (bi < 0 || (best === 'min' ? v < vals[bi] : v > vals[bi]))) bi = i; });
  return { avg, n, min: minOf(vals), max: maxOf(vals), best: bi >= 0 ? vals[bi] : null, bestDate: bi >= 0 ? dates[bi] : null, total: sum(vals) };
}
function compareWindows(model, field, endDate, n) {
  const cur = dateRange(addDays(endDate, -(n - 1)), endDate), prev = dateRange(addDays(endDate, -(2 * n - 1)), addDays(endDate, -n));
  const a = mean(values(model, field, cur)), b = mean(values(model, field, prev));
  return { cur: a, prev: b, delta: a != null && b != null ? a - b : null, pct: a != null && b ? (a - b) / b * 100 : null };
}
function weekdayMeans(model, field, dates) {
  const b = [[], [], [], [], [], [], []]; dates.forEach(d => { const v = model.daily[d] && model.daily[d][field]; if (isNum(v)) b[weekday(d)].push(v); });
  return b.map(mean);
}
function heatmap(model, field, endDate, weeks) {
  const endMon = addDays(endDate, -weekday(endDate)), start = addDays(endMon, -(weeks - 1) * 7), cells = [];
  for (let w = 0; w < weeks; w++) for (let r = 0; r < 7; r++) { const d = addDays(start, w * 7 + r); const v = model.daily[d] && model.daily[d][field]; cells.push({ d, w, r, v: isNum(v) ? v : null, inRange: d <= endDate }); }
  return { start, weeks, cells };
}
function workoutStats(list) {
  const by = {};
  for (const e of list) { const o = by[e.name] || (by[e.name] = { name: e.name, n: 0, min: 0, cal: 0, km: 0, hrs: [] }); o.n++; o.min += e.dur || 0; o.cal += e.cal || 0; o.km += e.dist || 0; if (isNum(e.hr)) o.hrs.push(e.hr); }
  return Object.values(by).map(o => Object.assign(o, { avgHr: mean(o.hrs) })).sort((a, b) => b.min - a.min);
}
function weeklyVolume(list, from, to) {
  const weeks = []; for (let k = addDays(from, -weekday(from)); k <= to; k = addDays(k, 7)) weeks.push(k);
  const types = Array.from(new Set(list.map(e => e.name))), M = new Map(weeks.map(w => [w, {}]));
  for (const e of list) { const w = addDays(e.date, -weekday(e.date)), o = M.get(w); if (o) o[e.name] = (o[e.name] || 0) + (e.dur || 0); }
  return { weeks, types, data: types.map(t => weeks.map(w => (M.get(w)[t] || 0))) };
}
const fmtClock = m => { m = ((Math.round(m) % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
const fmtHM = m => isNum(m) ? Math.floor(m / 60) + 'h ' + String(Math.round(m % 60)).padStart(2, '0') + 'm' : '–';

return { addDays, dateRange, weekday, WD, mean, sum, count, minOf, maxOf, median, pearson, tzOffsetFn, rebinHr, buildModel, values, movingAvg, bucket, autoBucket, stat, compareWindows, weekdayMeans, heatmap, workoutStats, weeklyVolume, fmtClock, fmtHM, isNum, guessWeightUnit, toKg };
});
