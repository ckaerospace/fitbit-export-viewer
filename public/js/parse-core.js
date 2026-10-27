/*
 * parse-core.js - tolerant, discovery-based parser for Google Takeout "Fitbit" / Google Health exports.
 * Runs inside a Web Worker (and in Node for unit tests). No DOM, no network.
 *
 * Files are recognised by folder + file name patterns, never by exact paths. JSON arrays and CSV are both
 * handled, several timestamp formats are accepted, and anything not understood is listed instead of
 * failing. Entries are processed one at a time, in a streaming fashion, so raw samples are never kept:
 * heart rate is folded into 5-minute bins on the fly.
 */
(function (root, factory) { root.FBParse = factory(); })(typeof self !== 'undefined' ? self : globalThis, function () {
'use strict';

// ---------------------------------------------------------------- groups the user can switch off
const GROUPS = {
  activity: 'Daily activity (steps, distance, calories, active minutes)',
  hr: 'Heart rate, intraday (largest part of the export)',
  hrsum: 'Resting heart rate, heart-rate zones',
  sleep: 'Sleep (stages, scores)',
  workouts: 'Workouts / exercise logs',
  body: 'Weight, body fat, VO2 max',
  vitals: 'HRV, SpO2, respiratory rate, temperature',
  scores: 'Readiness and stress scores'
};

const TYPE_GROUP = {
  steps: 'activity', calories: 'activity', distance: 'activity', floors: 'activity', sedentary: 'activity',
  lightly: 'activity', moderately: 'activity', very: 'activity', azm: 'activity', activemin: 'activity',
  hr: 'hr', rhr: 'hrsum', zones: 'hrsum', exercise: 'workouts',
  sleep: 'sleep', sleepstages: 'sleep', sleepscore: 'sleep',
  weight: 'body', bodyfat: 'body', vo2: 'body',
  hrv_daily: 'vitals', hrv_detail: 'vitals', spo2_daily: 'vitals', spo2_min: 'vitals', resp: 'vitals',
  temp_skin: 'vitals', temp_dev: 'vitals', readiness: 'scores', stress: 'scores'
};

const TYPE_LABEL = {
  steps: 'Steps', calories: 'Calories', distance: 'Distance', floors: 'Floors', sedentary: 'Sedentary minutes',
  lightly: 'Lightly active minutes', moderately: 'Moderately active minutes', very: 'Very active minutes',
  azm: 'Active Zone Minutes', activemin: 'Active minutes (CSV)', hr: 'Heart rate (intraday)',
  rhr: 'Resting heart rate', zones: 'Time in heart-rate zones', exercise: 'Exercise logs', sleep: 'Sleep logs',
  sleepstages: 'Sleep stages (CSV)', sleepscore: 'Sleep scores', weight: 'Weight', bodyfat: 'Body fat',
  vo2: 'VO2 max', hrv_daily: 'HRV (daily)', hrv_detail: 'HRV (detail)', spo2_daily: 'SpO2 (daily)',
  spo2_min: 'SpO2 (per minute)', resp: 'Respiratory rate', temp_skin: 'Skin temperature (nightly)',
  temp_dev: 'Device temperature', readiness: 'Daily readiness', stress: 'Stress score'
};

// Normalised base names (lower case, separators -> single space, trailing date/number removed).
const NAME_TABLE = [
  [/^steps$/, 'steps'], [/^calories$/, 'calories'], [/^distance$/, 'distance'], [/^floors?$/, 'floors'],
  [/^sedentary minutes$/, 'sedentary'], [/^lightly active minutes$/, 'lightly'],
  [/^(moderately|fairly) active minutes$/, 'moderately'], [/^very active minutes$/, 'very'],
  [/^active zone minutes$/, 'azm'], [/^active minutes$/, 'activemin'],
  [/^heart rate$/, 'hr'], [/^(daily )?resting heart rate$/, 'rhr'], [/^time in heart rate zones?$/, 'zones'],
  [/^demographic vo2 ?max$/, 'vo2'], [/^exercise$|^user exercises$/, 'exercise'],
  [/^sleep$|^user sleeps$/, 'sleep'], [/^user sleep stages$/, 'sleepstages'],
  [/^sleep score$|^user sleep scores$/, 'sleepscore'], [/^weight$/, 'weight'], [/^(body )?fat$/, 'bodyfat'],
  [/^daily (heart rate variability|hrv)( summary)?$/, 'hrv_daily'],
  [/^(heart rate variability( details)?|minute hrv|hrv details)$/, 'hrv_detail'],
  [/^daily (spo2|oxygen saturation)$/, 'spo2_daily'], [/^(minute spo2|oxygen saturation)$/, 'spo2_min'],
  [/^(daily )?respiratory rate( summary| sleep summary)?$/, 'resp'],
  [/^computed temperature$|^body temperature$/, 'temp_skin'], [/^device temperature$/, 'temp_dev'],
  [/^daily readiness( score)?$/, 'readiness'], [/^stress score$/, 'stress']
];
// Known but not charted (recognised so they are not reported as "unreadable").
const KNOWN_UNUSED = [
  /^altitude$/, /^swim lengths data$/, /^height$/, /^heart rate variability histogram$/, /^sleep profile$/,
  /^estimated oxygen variation$/, /^badge$/, /^profile$/, /^devices?$/, /^trackers?$/, /^scales?$/,
  /^activity goals?$/, /^user (app|legacy|mbd|demographic|profile|goal|irn)/, /^goal settings/,
  /^calibration status/, /^takeout irn/, /^account (access|management) events$/, /^user (email|retired)/,
  /^menstrual/, /^heart rate notifications/, /^afib/, /^tracker optional/, /^ios app notification/,
  /^daily readiness user properties$/, /^live pace$/, /^sedentary period$/, /^activity level$/,
  /^calories in heart rate zone$/, /^cardio (load|acute)/, /^time in heart rate zone$/, /^daily heart rate zones$/,
  /^stress journal/, /^survey data$/, /^readme$/, /^stress score readme$/, /^mood/, /^programs?$/, /^food/, /^water/
];
const KNOWN_FOLDERS = /(^|\/)(personal (&|and) account|application|social|menstrual health|programs|stress journal|fitbit care|badges?)(\/|$)/i;
const NON_DATA_EXT = /^(txt|pdf|html?|png|jpe?g|gif|tcx|gpx|md|xml|ini|log)$/;

function normName(stem) {
  let s = stem.replace(/([a-z])(?=[A-Z][a-z])/g, '$1 ').toLowerCase().replace(/[_\-\s.]+/g, ' ').trim();
  // strip up to 3 trailing numeric tokens (dates, part numbers)
  for (let i = 0; i < 6; i++) { const t = s.replace(/\s\d{1,4}$/, ''); if (t === s) break; s = t; }
  return s;
}

function classify(path) {
  const parts = path.split('/').filter(Boolean);
  const base = parts[parts.length - 1] || '';
  const folder = parts.slice(0, -1).join('/');
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const norm = normName(stem);
  const out = { path, folder, base, ext, norm, kind: 'unknown', type: null };
  if (NON_DATA_EXT.test(ext)) { out.kind = 'ignored'; out.why = 'not a data file'; return out; }
  for (const [re, type] of NAME_TABLE) {
    if (re.test(norm)) { out.kind = 'data'; out.type = type; out.group = TYPE_GROUP[type]; return out; }
  }
  for (const re of KNOWN_UNUSED) if (re.test(norm)) { out.kind = 'ignored'; out.why = 'recognised, not charted'; return out; }
  if (KNOWN_FOLDERS.test(folder)) { out.kind = 'ignored'; out.why = 'account / profile data, not charted'; return out; }
  if (ext && ext !== 'json' && ext !== 'csv') { out.kind = 'unknown'; out.why = 'unsupported file type ".' + ext + '"'; return out; }
  out.why = 'file name not recognised';
  return out;
}

// ---------------------------------------------------------------- dates
function daysFromCivil(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400), yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}
function civilFromDays(z) {
  z += 719468;
  const era = Math.floor(z / 146097), doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400, doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153), d = doy - Math.floor((153 * mp + 2) / 5) + 1, m = mp < 10 ? mp + 3 : mp - 9;
  return [y + (m <= 2 ? 1 : 0), m, d];
}
const _dk = new Map();
function dayKey(dayIdx) {
  let k = _dk.get(dayIdx);
  if (k === undefined) {
    const c = civilFromDays(dayIdx);
    k = c[0] + '-' + (c[1] < 10 ? '0' : '') + c[1] + '-' + (c[2] < 10 ? '0' : '') + c[2];
    _dk.set(dayIdx, k);
  }
  return k;
}
function dayIdxOfKey(k) { return daysFromCivil(+k.slice(0, 4), +k.slice(5, 7), +k.slice(8, 10)); }

const RE_US = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?\s*$/;
const RE_ISO = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[T ]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?\s*([AaPp][Mm])?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?\s*$/;
const RE_DE = /^\s*(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*$/;
let _fd8 = '~', _fv8 = 0;
let lastTz = 0; // 1 when the last parsed string carried an explicit zone (Z or offset)

function hms(h, mi, s, ap) {
  h = +h || 0;
  if (ap) { const pm = ap[0] === 'P' || ap[0] === 'p'; if (pm && h < 12) h += 12; else if (!pm && h === 12) h = 0; }
  return h * 3600 + (+mi || 0) * 60 + (+s || 0);
}
/** Parse a timestamp. Returns seconds since epoch (wall clock read as UTC when no zone given) or NaN. */
function parseDT(s) {
  lastTz = 0;
  if (typeof s !== 'string') {
    if (typeof s === 'number' && isFinite(s)) { lastTz = 1; return s > 1e11 ? Math.floor(s / 1000) : s; }
    return NaN;
  }
  const n = s.length;
  // fast path: "MM/dd/yy HH:mm:ss"
  if (n === 17 && s.charCodeAt(2) === 47 && s.charCodeAt(5) === 47 && s.charCodeAt(8) === 32) {
    if (!s.startsWith(_fd8)) { _fd8 = s.slice(0, 8); _fv8 = daysFromCivil(2000 + +s.slice(6, 8), +s.slice(0, 2), +s.slice(3, 5)) * 86400; }
    const c = i => s.charCodeAt(i) - 48;
    return _fv8 + (c(9) * 10 + c(10)) * 3600 + (c(12) * 10 + c(13)) * 60 + c(15) * 10 + c(16);
  }
  let m = RE_ISO.exec(s);
  if (m) {
    let sec = daysFromCivil(+m[1], +m[2], +m[3]) * 86400 + (m[4] !== undefined ? hms(m[4], m[5], m[6], m[7]) : 0);
    const z = m[8];
    if (z) {
      lastTz = 1;
      if (z !== 'Z') {
        const sign = z[0] === '-' ? -1 : 1, d = z.slice(1).replace(':', '');
        sec -= sign * ((+d.slice(0, 2)) * 3600 + (+(d.slice(2, 4) || 0)) * 60);
      }
    }
    return sec;
  }
  m = RE_US.exec(s);
  if (m) {
    let y = +m[3]; if (y < 100) y += y < 70 ? 2000 : 1900;
    return daysFromCivil(y, +m[1], +m[2]) * 86400 + (m[4] !== undefined ? hms(m[4], m[5], m[6], m[7]) : 0);
  }
  m = RE_DE.exec(s);
  if (m) return daysFromCivil(+m[3], +m[2], +m[1]) * 86400 + (m[4] !== undefined ? hms(m[4], m[5], m[6]) : 0);
  if (/^\d{10,13}$/.test(s.trim())) { lastTz = 1; const v = +s; return v > 1e11 ? Math.floor(v / 1000) : v; }
  return NaN;
}
function dateOf(s) { const t = parseDT(s); return t === t ? dayKey(Math.floor(t / 86400)) : null; }
function minutesOfDay(sec) { return Math.floor((sec - Math.floor(sec / 86400) * 86400) / 60); }
function isoLocalMinute(sec) { const d = Math.floor(sec / 86400), m = minutesOfDay(sec); return dayKey(d) + 'T' + String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
function parseOffset(v) {
  if (v == null || v === '') return 0;
  const s = String(v).trim();
  let m = /^([+-])?(\d{1,2}):?(\d{2})$/.exec(s);
  if (m && s.length >= 4 && /[:+]/.test(s)) return (m[1] === '-' ? -1 : 1) * (+m[2] * 3600 + +m[3] * 60);
  m = /^(-?\d+(?:\.\d+)?)s?$/.exec(s);
  if (m) { const x = +m[1]; return Math.abs(x) > 1000 ? x : x * 3600; }
  return 0;
}
function num(v) {
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return v;
  const x = parseFloat(String(v).replace(',', '.'));
  return x;
}

// ---------------------------------------------------------------- streaming scanners
/** Emits every element of a top-level JSON array (or the single top-level object) as parsed objects. */
class JsonStream {
  constructor(onElem) { this.onElem = onElem; this.depth = 0; this.inStr = false; this.esc = false; this.inEl = false; this.part = ''; this.arrayTop = false; this.count = 0; this.bad = 0; this.partLen = 0; }
  feed(text) {
    let elStart = this.inEl ? 0 : -1;
    const n = text.length;
    let depth = this.depth, inStr = this.inStr, esc = this.esc, inEl = this.inEl;
    for (let i = 0; i < n; i++) {
      const c = text.charCodeAt(i);
      if (inStr) { if (esc) esc = false; else if (c === 92) esc = true; else if (c === 34) inStr = false; continue; }
      if (c === 34) { inStr = true; continue; }
      if (c === 123 || c === 91) {
        if (!inEl && c === 91 && !this.arrayTop) { this.arrayTop = true; continue; }
        if (!inEl) { inEl = true; elStart = i; depth = 0; }
        depth++;
      } else if ((c === 125 || c === 93) && inEl) {
        depth--;
        if (depth === 0) {
          const s = this.part + text.slice(elStart, i + 1);
          this.part = ''; this.partLen = 0; inEl = false; elStart = -1;
          this.count++;
          let o; try { o = JSON.parse(s); } catch (e) { this.bad++; continue; }
          this.onElem(o);
        }
      }
    }
    if (inEl) {
      this.part += text.slice(elStart < 0 ? 0 : elStart);
      if (this.part.length > 64e6) throw new Error('single JSON element larger than 64 MB');
    }
    this.depth = depth; this.inStr = inStr; this.esc = esc; this.inEl = inEl;
  }
  truncated() { return this.inEl || this.inStr; }
}

/** Quote-aware streaming CSV reader. */
class CsvStream {
  constructor(onRow) { this.onRow = onRow; this.carry = ''; this.pending = ''; this.rows = 0; }
  feed(text, final) {
    const data = this.carry + text;
    let start = 0;
    for (;;) {
      const nl = data.indexOf('\n', start);
      if (nl < 0) break;
      this._line(data.slice(start, nl));
      start = nl + 1;
    }
    this.carry = data.slice(start);
    if (final) { if (this.carry.length) this._line(this.carry); this.carry = ''; if (this.pending) { this._emit(this.pending); this.pending = ''; } }
  }
  _line(line) {
    if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
    if (this.pending) {
      this.pending += '\n' + line;
      if (quoteCount(this.pending) % 2 === 0) { const p = this.pending; this.pending = ''; this._emit(p); }
      return;
    }
    if (line.indexOf('"') < 0) { if (line.length) this.onRow(line.split(',')); this.rows++; return; }
    if (quoteCount(line) % 2 === 1) { this.pending = line; return; }
    this._emit(line);
  }
  _emit(line) {
    const out = []; let i = 0; const n = line.length;
    while (i <= n) {
      if (line.charCodeAt(i) === 34) {
        let j = i + 1, s = '';
        for (;;) {
          const q = line.indexOf('"', j);
          if (q < 0) { s += line.slice(j); i = n + 1; break; }
          if (line.charCodeAt(q + 1) === 34) { s += line.slice(j, q + 1); j = q + 2; continue; }
          s += line.slice(j, q); i = q + 1; break;
        }
        const c = line.indexOf(',', i);
        out.push(s); if (c < 0) break; i = c + 1;
      } else {
        const c = line.indexOf(',', i);
        if (c < 0) { out.push(line.slice(i)); break; }
        out.push(line.slice(i, c)); i = c + 1;
      }
    }
    this.rows++;
    this.onRow(out);
  }
}
function quoteCount(s) { let c = 0, i = -1; while ((i = s.indexOf('"', i + 1)) >= 0) c++; return c; }

// ---------------------------------------------------------------- accumulator
class Acc {
  constructor(opts) {
    opts = opts || {};
    this.groups = new Set(opts.groups || Object.keys(GROUPS));
    this.fields = {};            // field -> src -> Map(date -> value | stat)
    this.hrDays = new Map();     // utc day index -> {s,c,mn,mx}
    this._hd = NaN; this._hb = null;
    this.hrSamples = 0;
    this.sleeps = []; this.stages = new Map(); this.scores = []; this.exercises = []; this.weights = []; this.bodyfat = [];
    this.types = {};             // type -> {files, rows}
    this.diag = new Map();       // pattern -> {pattern, status, files, bytes, rows, header}
    this.unknown = [];           // {path,size,why}
    this.errors = [];            // {path,msg}
    this.warnings = [];
    this.skippedByGroup = {};    // group -> files
    this.fileCount = 0; this.dataFiles = 0; this.zips = 0;
    this.notes = {};
  }
  _f(field, src) { const f = this.fields[field] || (this.fields[field] = {}); return f[src] || (f[src] = new Map()); }
  sum(field, src, date, v) { if (v !== v) return; const m = this._f(field, src); m.set(date, (m.get(date) || 0) + v); }
  set(field, src, date, v) { if (v !== v) return; this._f(field, src).set(date, v); }
  stat(field, src, date, v) {
    if (v !== v) return; const m = this._f(field, src); const o = m.get(date);
    if (o) { o.n++; o.s += v; if (v < o.mn) o.mn = v; if (v > o.mx) o.mx = v; } else m.set(date, { n: 1, s: v, mn: v, mx: v });
  }
  hrAdd(sec, bpm) {
    if (!(bpm >= 25 && bpm <= 250)) return;
    const day = Math.floor(sec / 86400);
    if (day !== this._hd) {
      let b = this.hrDays.get(day);
      if (!b) { b = { s: new Uint32Array(288), c: new Uint16Array(288), mn: new Uint8Array(288).fill(255), mx: new Uint8Array(288) }; this.hrDays.set(day, b); }
      this._hd = day; this._hb = b;
    }
    const b = this._hb, i = ((sec - day * 86400) / 300) | 0;
    b.s[i] += bpm; b.c[i]++; if (bpm < b.mn[i]) b.mn[i] = bpm; if (bpm > b.mx[i]) b.mx[i] = bpm;
    this.hrSamples++;
  }
  diagFor(c, size) {
    const pat = diagPattern(c.path);
    let d = this.diag.get(pat);
    if (!d) { d = { pattern: pat, status: c.kind === 'data' ? 'read' : c.kind === 'ignored' ? 'skipped' : 'unrecognised', type: c.type, files: 0, bytes: 0, rows: 0, failed: 0, header: null }; this.diag.set(pat, d); }
    d.files++; d.bytes += size || 0;
    return d;
  }
}

function diagPattern(path) {
  let parts = path.split('/').filter(Boolean);
  const ti = parts.findIndex(p => /^takeout$/i.test(p));
  if (ti >= 0) parts = parts.slice(ti); else if (parts.length >= 3) parts = parts.slice(1);
  return parts.join('/').replace(/\d{4}-\d{2}-\d{2}/g, '<date>').replace(/\d{4}-\d{2}/g, '<month>').replace(/\d{5,}/g, '<id>').replace(/([-_ ])\d+(?=\.|$)/g, '$1<n>');
}

// ---------------------------------------------------------------- per-type handlers
const nrm = h => String(h).replace(/^\uFEFF/, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function findCol(hdr, pats) {
  for (const p of pats) {
    for (let i = 0; i < hdr.length; i++) if (typeof p === 'string' ? hdr[i] === p : p.test(hdr[i])) return i;
  }
  return -1;
}
const TS_COLS = ['timestamp', 'date time', 'datetime', 'date', 'time', 'recorded time', 'start time', /timestamp|date time|\bdate\b/];

const SCALAR_FIELD = { steps: 'steps', calories: 'calories', distance: 'distanceRaw', floors: 'floors', sedentary: 'sedentary', lightly: 'lightly', moderately: 'moderately', very: 'very' };
const US_FAST = {
  scalar: /"dateTime"\s*:\s*"([^"]+)"\s*,\s*"value"\s*:\s*"?(-?\d+(?:\.\d+)?)"?\s*[,}]/g,
  hr: /"dateTime"\s*:\s*"([^"]+)"\s*,\s*"value"\s*:\s*\{\s*"bpm"\s*:\s*(\d+)\s*[,}]/g
};

function makeJson(type, acc, d) {
  const fld = SCALAR_FIELD[type];
  switch (type) {
    case 'steps': case 'calories': case 'distance': case 'floors': case 'sedentary': case 'lightly': case 'moderately': case 'very':
      return {
        fast: US_FAST.scalar,
        onMatch(m) { const date = dateOf(m[1]); if (date) { acc.sum(fld, 'j', date, +m[2]); d.rows++; } },
        rec(o) { const v = num(o && o.value), date = o && dateOf(o.dateTime); if (date && v === v) { acc.sum(fld, 'j', date, v); d.rows++; } }
      };
    case 'hr':
      return {
        fast: US_FAST.hr,
        onMatch(m) { const t = parseDT(m[1]); if (t === t) { acc.hrAdd(t, +m[2]); d.rows++; } },
        rec(o) { const t = o && parseDT(o.dateTime); const b = o && o.value && (o.value.bpm != null ? o.value.bpm : o.value); if (t === t && typeof b !== 'object') { acc.hrAdd(t, num(b)); d.rows++; } }
      };
    case 'rhr':
      return { rec(o) {
        const v = o && o.value; if (!v) return;
        const val = typeof v === 'object' ? num(v.value) : num(v);
        const date = dateOf(typeof v === 'object' && v.date ? v.date : o.dateTime);
        if (date && val > 20 && val < 200) { acc.set('rhr', 'j', date, val); d.rows++; }
      } };
    case 'zones':
      return { rec(o) {
        const z = o && o.value && o.value.valuesInZones, date = o && dateOf(o.dateTime); if (!z || !date) return;
        const g = k => { for (const key in z) if (key.toUpperCase().indexOf(k) >= 0) return num(z[key]); return NaN; };
        acc.set('zOut', 'j', date, g('BELOW')); acc.set('zFat', 'j', date, g('IN_DEFAULT_ZONE_1'));
        acc.set('zCardio', 'j', date, g('IN_DEFAULT_ZONE_2')); acc.set('zPeak', 'j', date, g('IN_DEFAULT_ZONE_3'));
        d.rows++;
      } };
    case 'vo2':
      return { rec(o) {
        const v = o && o.value, date = o && dateOf(o.dateTime); if (!v || !date) return;
        let x = typeof v === 'object' ? num(v.filteredDemographicVO2Max != null ? v.filteredDemographicVO2Max : v.demographicVO2Max) : num(v);
        if (x > 5 && x < 100) { acc.set('vo2', 'j', date, x); d.rows++; }
      } };
    case 'exercise':
      return { rec(o) { addExerciseJson(acc, o); d.rows++; } };
    case 'sleep':
      return { rec(o) { addSleepJson(acc, o); d.rows++; } };
    case 'weight':
      return { rec(o) {
        if (!o) return; const w = num(o.weight); if (!(w > 0)) return;
        const t = parseDT(((o.date || '') + ' ' + (o.time || '')).trim() || o.dateTime);
        if (t !== t) return;
        acc.weights.push({ t, w, bmi: num(o.bmi), fat: num(o.fat), unit: 'json', src: o.source || null }); d.rows++;
      } };
    case 'bodyfat':
      return { rec(o) {
        if (!o) return; const f = num(o.fat != null ? o.fat : o.value);
        const t = parseDT(((o.date || '') + ' ' + (o.time || '')).trim() || o.dateTime);
        if (f > 0 && t === t) { acc.bodyfat.push({ t, f }); d.rows++; }
      } };
  }
  return null;
}

function addExerciseJson(acc, o) {
  if (!o || typeof o !== 'object') return;
  const t = parseDT(o.startTime); if (t !== t) return;
  let durMs = num(o.duration); if (!(durMs > 0)) durMs = num(o.activeDuration);
  const dur = durMs > 0 ? (durMs > 1e5 || o.duration === undefined ? durMs / 60000 : durMs / 60) : 0; // ms in the export; seconds are a guess for tiny values
  let dist = num(o.distance); const unit = String(o.distanceUnit || 'Kilometer').trim().toLowerCase();
  if (dist === dist) { if (unit.startsWith('mile')) dist *= 1.609344; else if (unit.startsWith('meter')) dist /= 1000; else if (unit.startsWith('yard')) dist *= 0.0009144; }
  const zm = {};
  if (Array.isArray(o.heartRateZones)) for (const z of o.heartRateZones) { if (z && z.name) zm[String(z.name).trim().toLowerCase()] = num(z.minutes); }
  acc.exercises.push({
    id: o.logId != null ? String(o.logId) : null, t, name: String(o.activityName || 'Workout').trim() || 'Workout',
    dur, cal: num(o.calories), hr: num(o.averageHeartRate), steps: num(o.steps), dist, kind: o.logType || null,
    zFat: zm['fat burn'], zCardio: zm['cardio'], zPeak: zm['peak']
  });
}
function addSleepJson(acc, o) {
  if (!o || typeof o !== 'object') return;
  const st = parseDT(o.startTime), en = parseDT(o.endTime); if (st !== st) return;
  const sm = o.levels && o.levels.summary || {}; const g = k => sm[k] && sm[k].minutes != null ? num(sm[k].minutes) : NaN;
  const classic = o.type === 'classic' || (sm.asleep || sm.restless);
  const durMs = num(o.duration);
  acc.sleeps.push({
    id: o.logId != null ? String(o.logId) : null, date: o.dateOfSleep ? dateOf(o.dateOfSleep) : dayKey(Math.floor((en === en ? en : st) / 86400)),
    st, en: en === en ? en : st + (durMs || 0) / 1000, inBed: num(o.timeInBed) === num(o.timeInBed) ? num(o.timeInBed) : durMs / 60000,
    asleep: num(o.minutesAsleep), awake: num(o.minutesAwake), eff: num(o.efficiency),
    deep: classic ? NaN : g('deep'), light: classic ? NaN : g('light'), rem: classic ? NaN : g('rem'), wake: classic ? NaN : g('wake'),
    classic: !!classic, main: o.mainSleep !== false, src: 'json'
  });
}

function makeCsv(type, acc, d, hdr) {
  const C = pats => findCol(hdr, pats);
  const ti = C(TS_COLS);
  switch (type) {
    case 'steps': case 'calories': case 'distance': case 'floors': {
      const vi = C({ steps: ['steps', 'step count', /steps/], calories: ['calories', /calories|kcal/], distance: [/distance|meters|millimeters|kilometers/], floors: [/floors/] }[type].concat([/value/]));
      if (ti < 0 || vi < 0) return null;
      const fld = SCALAR_FIELD[type];
      if (type === 'distance') acc.notes.distCsvHeader = hdr[vi];
      return row => { const t = parseDT(row[ti]); const v = num(row[vi]); if (t === t && v === v) { acc.sum(fld, 'c', dayKey(Math.floor(t / 86400)), v); d.rows++; } };
    }
    case 'hr': {
      const vi = C(['beats per minute', /beats per minute|^bpm$|heart rate/, 'value']); if (ti < 0 || vi < 0) return null;
      return row => { const t = parseDT(row[ti]); if (t === t) { acc.hrAdd(t, num(row[vi])); d.rows++; } };
    }
    case 'rhr': {
      const vi = C(['beats per minute', /beats per minute|resting|value/]); if (ti < 0 || vi < 0) return null;
      return row => { const date = dateOf(row[ti]), v = num(row[vi]); if (date && v > 20 && v < 200) { acc.set('rhr', 'c', date, v); d.rows++; } };
    }
    case 'activemin': {
      const li = C([/light/]), mi = C([/moderate|fairly/]), vi = C([/^very|vigorous/]); if (ti < 0) return null;
      return row => { const date = dateOf(row[ti]); if (!date) return; if (li >= 0) acc.sum('lightly', 'c', date, num(row[li])); if (mi >= 0) acc.sum('moderately', 'c', date, num(row[mi])); if (vi >= 0) acc.sum('very', 'c', date, num(row[vi])); d.rows++; };
    }
    case 'azm': {
      const zi = C(['heart zone id', 'heart rate zone', /zone/]), vi = C(['total minutes', /minutes/]); if (ti < 0 || vi < 0) return null;
      return row => {
        const date = dateOf(row[ti]), v = num(row[vi]); if (!date || v !== v) return;
        const z = zi >= 0 ? String(row[zi]).toUpperCase() : '';
        const f = z.indexOf('PEAK') >= 0 ? 'azmPeak' : z.indexOf('CARDIO') >= 0 ? 'azmCardio' : z.indexOf('FAT') >= 0 ? 'azmFat' : 'azmOther';
        acc.sum(f, 'c', date, v); d.rows++;
      };
    }
    case 'hrv_daily': {
      const ri = C(['rmssd', /^rmssd$|daily rmssd|average.*(rmssd|variab)|root mean square/]), di = C([/deep.*rmssd/]); if (ti < 0 || ri < 0) return null;
      return row => { const date = dateOf(row[ti]), v = num(row[ri]); if (date && v > 0) { acc.set('hrv', 'c', date, v); if (di >= 0) acc.set('hrvDeep', 'c', date, num(row[di])); d.rows++; } };
    }
    case 'hrv_detail': {
      const ri = C(['rmssd', /rmssd|root mean square/]); if (ti < 0 || ri < 0) return null;
      return row => { const date = dateOf(row[ti]), v = num(row[ri]); if (date && v > 0) { acc.stat('hrvD', 'c', date, v); d.rows++; } };
    }
    case 'spo2_daily': {
      const ai = C(['average value', /average.*(value|percentage)|^average$|spo2/]), lo = C([/lower bound/]), hi = C([/upper bound/]); if (ti < 0 || ai < 0) return null;
      return row => { const date = dateOf(row[ti]), v = num(row[ai]); if (date && v > 50 && v <= 100) { acc.set('spo2', 'c', date, v); if (lo >= 0) acc.set('spo2Min', 'c', date, num(row[lo])); if (hi >= 0) acc.set('spo2Max', 'c', date, num(row[hi])); d.rows++; } };
    }
    case 'spo2_min': {
      const vi = C(['value', /oxygen saturation percentage|spo2|value/]); if (ti < 0 || vi < 0) return null;
      return row => { const date = dateOf(row[ti]), v = num(row[vi]); if (date && v > 50 && v <= 100) { acc.stat('spo2m', 'c', date, v); d.rows++; } };
    }
    case 'resp': {
      const ri = C([/daily respiratory rate|^daily.*breathing/, /full sleep.*(breath|rate)/, /respiratory rate|breathing rate|breaths/]); if (ti < 0 || ri < 0) return null;
      const milli = /milli/.test(hdr[ri]);
      return row => { let v = num(row[ri]); if (milli) v /= 1000; const date = dateOf(row[ti]); if (date && v > 3 && v < 60) { acc.set('resp', 'c', date, v); d.rows++; } };
    }
    case 'temp_skin': {
      const ei = C(['sleep end', /sleep end/]), vi = C(['nightly temperature', /nightly temperature|temperature celsius|^temperature$|temperature/]); const di = ei >= 0 ? ei : ti; if (di < 0 || vi < 0) return null;
      return row => { const date = dateOf(row[di]), v = num(row[vi]); if (date && v > 20 && v < 45) { acc.set('temp', 'c', date, v); d.rows++; } };
    }
    case 'temp_dev': {
      const vi = C(['temperature', /temperature/]); if (ti < 0 || vi < 0) return null;
      return row => { const date = dateOf(row[ti]), v = num(row[vi]); if (date && v > 20 && v < 45) { acc.stat('tempD', 'c', date, v); d.rows++; } };
    }
    case 'readiness': {
      const vi = C(['readiness score value', /readiness score( value)?$|readiness.*score/, /score/]); if (ti < 0 || vi < 0) return null;
      return row => { const date = dateOf(row[ti]), v = num(row[vi]); if (date && v >= 0) { acc.set('readiness', 'c', date, v); d.rows++; } };
    }
    case 'stress': {
      const di = C(['date', /date/]), vi = C(['stress score', /stress score/]); if (di < 0 || vi < 0) return null;
      return row => { const date = dateOf(row[di]), v = num(row[vi]); if (date && v >= 0) { acc.set('stress', 'c', date, v); d.rows++; } };
    }
    case 'sleepscore': {
      const ii = C(['sleep log entry id', 'sleep id']), ci = ti >= 0 ? ti : C(['score time']), oi = C(['overall score']);
      const si = C(['score time', 'timestamp']); const tIdx = si >= 0 ? si : ci;
      if (tIdx < 0 || oi < 0) return null;
      const cp = C(['composition score']), rv = C(['revitalization score']), du = C(['duration score']), ds = C(['deep sleep in minutes', 'deep sleep minutes']), rh = C(['resting heart rate']), rs = C(['restlessness', 'restlessness normalized']);
      const oi2 = C(['score utc offset']);
      return row => {
        const t = parseDT(row[tIdx]); const v = num(row[oi]); if (t !== t || !(v >= 0)) return;
        acc.scores.push({ id: ii >= 0 ? String(row[ii]) : null, t, off: oi2 >= 0 ? parseOffset(row[oi2]) : 0, overall: v, comp: cp >= 0 ? num(row[cp]) : NaN, rev: rv >= 0 ? num(row[rv]) : NaN, dur: du >= 0 ? num(row[du]) : NaN, deep: ds >= 0 ? num(row[ds]) : NaN, rhr: rh >= 0 ? num(row[rh]) : NaN, rest: rs >= 0 ? num(row[rs]) : NaN });
        d.rows++;
      };
    }
    case 'sleep': { // Google "UserSleeps"
      const ii = C(['sleep id']), si = C(['sleep start']), ei = C(['sleep end']), so = C(['start utc offset']), eo = C(['end utc offset']);
      const asl = C(['minutes asleep']), awk = C(['minutes awake']), sp = C(['minutes in sleep period']), ty = C(['sleep type']);
      if (si < 0) return null;
      return row => {
        const st = parseDT(row[si]); if (st !== st) return; let en = ei >= 0 ? parseDT(row[ei]) : NaN;
        const o1 = so >= 0 ? parseOffset(row[so]) : 0, o2 = eo >= 0 ? parseOffset(row[eo]) : o1;
        const stl = lastTz ? st + o1 : st; if (en !== en) en = st + (sp >= 0 ? num(row[sp]) * 60 : 0); const enl = en + (lastTz ? o2 : 0);
        acc.sleeps.push({ id: ii >= 0 ? String(row[ii]) : null, date: dayKey(Math.floor(enl / 86400)), st: stl, en: enl, inBed: sp >= 0 ? num(row[sp]) : (enl - stl) / 60, asleep: asl >= 0 ? num(row[asl]) : NaN, awake: awk >= 0 ? num(row[awk]) : NaN, eff: NaN, deep: NaN, light: NaN, rem: NaN, wake: NaN, classic: false, main: ty >= 0 ? !/nap|classic_nap/i.test(row[ty]) : true, src: 'csv' });
        d.rows++;
      };
    }
    case 'sleepstages': {
      const ii = C(['sleep id']), ty = C(['sleep stage type']), s0 = C(['sleep stage start']), s1 = C(['sleep stage end']); if (ii < 0 || ty < 0 || s0 < 0 || s1 < 0) return null;
      return row => {
        const a = parseDT(row[s0]), b = parseDT(row[s1]); if (a !== a || b !== b) return;
        const id = String(row[ii]); let o = acc.stages.get(id); if (!o) { o = { deep: 0, light: 0, rem: 0, wake: 0 }; acc.stages.set(id, o); }
        const t = String(row[ty]).toUpperCase(), m = (b - a) / 60;
        if (t.indexOf('DEEP') >= 0) o.deep += m; else if (t.indexOf('REM') >= 0) o.rem += m; else if (t.indexOf('LIGHT') >= 0 || t.indexOf('ASLEEP') >= 0) o.light += m; else if (t.indexOf('AWAKE') >= 0 || t.indexOf('WAKE') >= 0 || t.indexOf('RESTLESS') >= 0) o.wake += m;
        d.rows++;
      };
    }
    case 'exercise': { // Google "UserExercises"
      const s0 = C(['exercise start']), s1 = C(['exercise end']), of = C(['utc offset']), nm = C(['activity name']), id = C(['exercise id']);
      const cal = C(['tracker total calories']), st = C(['tracker total steps']), di = C(['tracker total distance mm']), hr = C(['tracker avg heart rate']), lt = C(['log type']);
      if (s0 < 0) return null;
      return row => {
        const a = parseDT(row[s0]); if (a !== a) return; const b = s1 >= 0 ? parseDT(row[s1]) : NaN; const off = of >= 0 && lastTz ? parseOffset(row[of]) : 0;
        acc.exercises.push({ id: id >= 0 ? String(row[id]) : null, t: a + off, name: nm >= 0 ? String(row[nm]).trim() || 'Workout' : 'Workout', dur: b === b ? (b - a) / 60 : 0, cal: cal >= 0 ? num(row[cal]) : NaN, hr: hr >= 0 ? num(row[hr]) : NaN, steps: st >= 0 ? num(row[st]) : NaN, dist: di >= 0 ? num(row[di]) / 1e6 : NaN, kind: lt >= 0 ? row[lt] : null, zFat: NaN, zCardio: NaN, zPeak: NaN });
        d.rows++;
      };
    }
    case 'weight': {
      const vi = C([/weight/]), bi = C([/bmi/]), fi = C([/fat/]); if (ti < 0 || vi < 0) return null;
      const unit = /gram/.test(hdr[vi]) && !/kilo/.test(hdr[vi]) ? 'g' : /kilo|\bkg\b/.test(hdr[vi]) ? 'kg' : /pound|\blb/.test(hdr[vi]) ? 'lb' : 'csv';
      return row => { const t = parseDT(row[ti]), w = num(row[vi]); if (t === t && w > 0) { acc.weights.push({ t, w, bmi: bi >= 0 ? num(row[bi]) : NaN, fat: fi >= 0 ? num(row[fi]) : NaN, unit, src: null }); d.rows++; } };
    }
    case 'vo2': {
      const vi = C([/vo2/]); if (ti < 0 || vi < 0) return null;
      return row => { const date = dateOf(row[ti]), v = num(row[vi]); if (date && v > 5 && v < 100) { acc.set('vo2', 'c', date, v); d.rows++; } };
    }
  }
  return null;
}

// ---------------------------------------------------------------- per-file driver
class FileHandler {
  constructor(acc, c, size, d) {
    this.acc = acc; this.c = c; this.size = size; this.d = d; this.dec = new TextDecoder('utf-8'); this.mode = null;
    this.buf = ''; this.chars = 0; this.final = false; this.failed = null; this.sink = null; this.carry = ''; this.bad = 0; this.seen = 0;
  }
  push(u8, final) {
    if (this.failed) return;
    try {
      let text = u8 && u8.length ? this.dec.decode(u8, { stream: !final }) : (final ? this.dec.decode() : '');
      if (this.mode === null) {
        this.buf += text; this.chars += text.length;
        if (!final && this.chars < 4000) return;
        this._start(this.buf, final); this.buf = '';
        return;
      }
      this._feed(text, final);
    } catch (e) { this.failed = e && e.message || String(e); }
  }
  _start(text, final) {
    let i = 0; if (text.charCodeAt(0) === 0xFEFF) i = 1;
    while (i < text.length && text.charCodeAt(i) <= 32) i++;
    const ch = text[i];
    const forceCsv = this.c.ext === 'csv', forceJson = this.c.ext === 'json';
    const isJson = forceJson ? true : forceCsv ? false : (ch === '[' || ch === '{');
    if (i >= text.length) { this.mode = 'empty'; this.failed = 'file is empty'; return; }
    if (isJson && ch !== '[' && ch !== '{') { this.mode = 'bad'; this.failed = 'expected JSON, found other content'; return; }
    const type = this.c.type, acc = this.acc, d = this.d;
    if (isJson) {
      this.mode = 'json';
      const h = makeJson(type, acc, d);
      if (!h) { this.mode = 'bad'; this.failed = 'this data type is not supported as JSON'; return; }
      this.h = h;
      if (h.fast) { h.fast.lastIndex = 0; this.useFast = h.fast.test(text); h.fast.lastIndex = 0; }
      if (!this.useFast) { this.js = new JsonStream(h.rec); }
      if (!d.header) d.header = jsonKeys(text);
      this._feed(text, final);
    } else {
      this.mode = 'csv';
      this.hdrDone = false; this.csvType = type;
      this.cs = new CsvStream(row => this._csvRow(row));
      this._feed(text, final);
    }
  }
  _csvRow(row) {
    if (!this.hdrDone) {
      this.hdrDone = true; const hdr = row.map(nrm);
      if (!this.d.header) this.d.header = row.map(x => String(x).replace(/^\uFEFF/, '').trim()).slice(0, 40);
      this.rowFn = makeCsv(this.csvType, this.acc, this.d, hdr);
      if (!this.rowFn) { this.failed = 'required columns not found in header'; }
      return;
    }
    if (this.rowFn) { try { this.rowFn(row); } catch (e) { this.bad++; } }
  }
  _feed(text, final) {
    if (this.mode === 'json') {
      if (this.useFast) {
        const t = this.carry + text, re = this.h.fast; re.lastIndex = 0; let m, last = 0;
        while ((m = re.exec(t)) !== null) { this.h.onMatch(m); last = re.lastIndex; this.seen++; }
        this.carry = t.slice(Math.max(last, t.length - 300));
        const tl = text.slice(-16).trimEnd(); if (tl) this.tailChar = tl[tl.length - 1];
      } else this.js.feed(text);
    } else if (this.mode === 'csv') {
      this.cs.feed(text, final);
      if (this.failed) return;
    }
  }
  end() {
    const acc = this.acc, d = this.d;
    if (this.mode === null) { try { this._start(this.buf, true); } catch (e) { this.failed = e.message; } }
    if (this.mode === 'json' && !this.useFast && this.js) {
      if (this.js.count > 0 && this.js.truncated()) acc.warnings.push({ path: this.c.path, msg: 'file ends mid-record (truncated); ' + this.js.count + ' records read before that' });
      if (this.js.bad) acc.warnings.push({ path: this.c.path, msg: this.js.bad + ' unreadable record(s) skipped' });
      if (this.js.count === 0 && !this.failed) this.failed = 'no JSON records found';
    }
    if (this.mode === 'json' && this.useFast && !this.seen && !this.failed) this.failed = 'no records matched';
    if (this.mode === 'json' && this.useFast && this.seen && this.tailChar && this.tailChar !== ']' && this.tailChar !== '}') acc.warnings.push({ path: this.c.path, msg: 'file ends mid-record (truncated); ' + this.seen + ' records read before that' });
    if (this.failed) { d.failed++; acc.errors.push({ path: this.c.path, msg: this.failed }); }
    return !this.failed;
  }
}
function jsonKeys(text) {
  try {
    const m = /\[\s*(\{[\s\S]{0,4000}?\})\s*[,\]]/.exec(text) || /^\s*(\{[\s\S]{0,4000}\})/.exec(text);
    if (!m) return null;
    const keys = new Set(); let depth = 0;
    const re = /"([^"\\]{1,40})"\s*:|[{}]/g; let k; const s = m[1];
    while ((k = re.exec(s))) { if (k[0] === '{') depth++; else if (k[0] === '}') depth--; else if (depth <= 2) keys.add(k[1]); }
    return Array.from(keys).slice(0, 40);
  } catch (e) { return null; }
}

class Collector {
  constructor(opts) { this.acc = new Acc(opts); }
  /** Returns a FileHandler (push(u8, final) / end()) or null when the entry is skipped. */
  start(path, size) {
    const acc = this.acc; if (path.endsWith('/')) return null;
    acc.fileCount++;
    const c = classify(path);
    const d = acc.diagFor(c, size);
    if (c.kind !== 'data') {
      if (c.kind === 'unknown') acc.unknown.push({ path, size, why: c.why });
      return null;
    }
    if (c.type === 'zones' && c.ext === 'csv') { d.status = 'skipped'; return null; }
    if (!acc.groups.has(c.group)) { acc.skippedByGroup[c.group] = (acc.skippedByGroup[c.group] || 0) + 1; d.status = 'skipped'; return null; }
    acc.dataFiles++;
    const t = acc.types[c.type] || (acc.types[c.type] = { files: 0, rows: 0 }); t.files++;
    const h = new FileHandler(acc, c, size, d);
    h.t = t; h.rows0 = d.rows;
    const end = h.end.bind(h);
    h.end = function () { const r = end(); t.rows += d.rows - h.rows0; return r; };
    return h;
  }
  /** Reduce everything into a compact, JSON-friendly summary. */
  finish() { return finalize(this.acc); }
}

// ---------------------------------------------------------------- finalisation
const MEAN_FIELDS = { hrvD: 'hrv', spo2m: 'spo2', tempD: 'temp' };
function finalize(acc) {
  const daily = {}; const sources = {};
  const put = (date, k, v) => { (daily[date] || (daily[date] = {}))[k] = v; };
  for (const field in acc.fields) {
    const srcs = acc.fields[field]; let best = null, bn = -1;
    for (const s in srcs) if (srcs[s].size > bn || (srcs[s].size === bn && s === 'j')) { best = s; bn = srcs[s].size; }
    sources[field] = best;
    const isStat = field in MEAN_FIELDS; const out = isStat ? MEAN_FIELDS[field] : field;
    for (const [date, v] of srcs[best]) {
      if (isStat) {
        if (field === 'spo2m') { put(date, 'spo2m', +(v.s / v.n).toFixed(2)); put(date, 'spo2mMin', v.mn); }
        else put(date, field, +(v.s / v.n).toFixed(3));
      } else put(date, out, typeof v === 'number' ? +v.toFixed(3) : v);
    }
  }
  // fall back from detail series to the daily series when the daily one is absent
  for (const date in daily) {
    const o = daily[date];
    if (o.hrv == null && o.hrvD != null) o.hrv = o.hrvD; delete o.hrvD;
    if (o.spo2 == null && o.spo2m != null) { o.spo2 = o.spo2m; if (o.spo2Min == null) o.spo2Min = o.spo2mMin; } delete o.spo2m; delete o.spo2mMin;
    if (o.temp == null && o.tempD != null) o.temp = o.tempD; delete o.tempD;
  }
  // distance: pick the unit that gives a plausible stride length
  let distNote = null;
  const dsrc = acc.fields.distanceRaw && acc.fields.distanceRaw[sources.distanceRaw];
  let distUnit = null;
  if (dsrc) {
    let td = 0, ts = 0;
    for (const [date, v] of dsrc) { const s = daily[date] && daily[date].steps; if (s > 0) { td += v; ts += s; } }
    const cands = { centimeters: 1e-5, meters: 1e-3, millimeters: 1e-6, miles: 1.609344, kilometers: 1 };
    const hdr = acc.notes.distCsvHeader ? nrm(acc.notes.distCsvHeader) : '';
    const forced = /millimeter/.test(hdr) ? 'millimeters' : /centimeter/.test(hdr) ? 'centimeters' : /kilometer/.test(hdr) ? 'kilometers' : /meter/.test(hdr) ? 'meters' : /mile/.test(hdr) ? 'miles' : null;
    if (forced) distUnit = forced;
    else if (ts > 2000 && td > 0) {
      let bestE = Infinity;
      for (const u in cands) { const mPerStep = td * cands[u] * 1000 / ts, e = Math.abs(Math.log(mPerStep / 0.75)); if (e < bestE) { bestE = e; distUnit = u; } }
      distNote = 'unit guessed from stride length';
    } else distUnit = sources.distanceRaw === 'c' ? 'millimeters' : 'centimeters';
    const f = cands[distUnit];
    for (const [date, v] of dsrc) put(date, 'distance', +(v * f).toFixed(3));
  }
  // sleep: de-duplicate, attach stages and scores
  const seen = new Map();
  for (const s of acc.sleeps) {
    const k = Math.round(s.st / 60) + '|' + Math.round(s.en / 600);
    const prev = seen.get(k); if (!prev || (prev.src !== 'json' && s.src === 'json')) seen.set(k, s);
  }
  const sleeps = [];
  const scoreById = new Map(), scoreByDate = new Map();
  for (const sc of acc.scores) { if (sc.id) scoreById.set(sc.id, sc); scoreByDate.set(dayKey(Math.floor((sc.t + (sc.off || 0)) / 86400)), sc); }
  for (const s of seen.values()) {
    const stg = s.id && acc.stages.get(s.id);
    if (stg && !(s.deep === s.deep)) { s.deep = Math.round(stg.deep); s.light = Math.round(stg.light); s.rem = Math.round(stg.rem); s.wake = Math.round(stg.wake); }
    const sc = (s.id && scoreById.get(s.id)) || (s.main ? scoreByDate.get(s.date) : null);
    sleeps.push({
      id: s.id, date: s.date, st: isoLocalMinute(s.st), en: isoLocalMinute(s.en), inBed: r1(s.inBed), asleep: r1(s.asleep), awake: r1(s.awake), eff: r1(s.eff),
      deep: r1(s.deep), light: r1(s.light), rem: r1(s.rem), wake: r1(s.wake), classic: s.classic, main: s.main,
      score: sc ? sc.overall : null, scoreDur: sc ? nz(sc.dur) : null, scoreComp: sc ? nz(sc.comp) : null, scoreRev: sc ? nz(sc.rev) : null, rest: sc ? nz(sc.rest) : null
    });
  }
  sleeps.sort((a, b) => a.st < b.st ? -1 : 1);
  // sleep-score file rhr as fallback
  if (!sources.rhr) for (const sc of acc.scores) if (sc.rhr > 20 && sc.rhr < 200) { const date = dayKey(Math.floor((sc.t + (sc.off || 0)) / 86400)); put(date, 'rhr', sc.rhr); sources.rhr = 'sleepscore'; }
  // exercises (de-duplicate by id or by start+name)
  const exSeen = new Map();
  for (const e of acc.exercises) exSeen.set(e.id || (Math.round(e.t / 60) + e.name), e);
  const exercises = Array.from(exSeen.values()).sort((a, b) => a.t - b.t).map(e => ({ id: e.id, t: isoLocalMinute(e.t), name: e.name, dur: r1(e.dur), cal: nz(e.cal), hr: nz(e.hr), steps: nz(e.steps), dist: nz(r2(e.dist)), zFat: nz(e.zFat), zCardio: nz(e.zCardio), zPeak: nz(e.zPeak) }));
  // weights
  const weights = acc.weights.sort((a, b) => a.t - b.t).map(w => ({ t: isoLocalMinute(w.t), w: w.w, bmi: nz(w.bmi), fat: nz(w.fat), unit: w.unit }));
  const fats = acc.bodyfat.sort((a, b) => a.t - b.t).map(w => ({ t: isoLocalMinute(w.t), f: w.f }));
  // heart-rate bins -> packed
  const days = Array.from(acc.hrDays.keys()).sort((a, b) => a - b);
  const nd = days.length;
  const hr = { days: new Int32Array(days), s: new Uint32Array(nd * 288), c: new Uint16Array(nd * 288), mn: new Uint8Array(nd * 288), mx: new Uint8Array(nd * 288), samples: acc.hrSamples };
  days.forEach((d, i) => { const b = acc.hrDays.get(d); hr.s.set(b.s, i * 288); hr.c.set(b.c, i * 288); hr.mn.set(b.mn, i * 288); hr.mx.set(b.mx, i * 288); });
  // data tab
  const diag = Array.from(acc.diag.values()).sort((a, b) => (a.status < b.status ? -1 : a.status > b.status ? 1 : b.files - a.files));
  let first = null, last = null;
  for (const date in daily) { if (first === null || date < first) first = date; if (last === null || date > last) last = date; }
  return {
    version: 1, daily, sleeps, exercises, weights, bodyfat: fats, hr,
    meta: { sources, distUnit, distNote, types: acc.types, typeLabels: TYPE_LABEL, files: acc.fileCount, dataFiles: acc.dataFiles, skippedByGroup: acc.skippedByGroup, unknown: acc.unknown.slice(0, 500), unknownCount: acc.unknown.length, errors: acc.errors.slice(0, 300), errorCount: acc.errors.length, warnings: acc.warnings.slice(0, 100), diag, firstDate: first, lastDate: last }
  };
}
const r1 = v => v === v && v != null ? Math.round(v * 10) / 10 : null;
const r2 = v => v === v && v != null ? Math.round(v * 100) / 100 : null;
const nz = v => v === v && v != null ? v : null;

return { GROUPS, TYPE_GROUP, TYPE_LABEL, classify, parseDT, dateOf, dayKey, dayIdxOfKey, daysFromCivil, civilFromDays, JsonStream, CsvStream, Collector, Acc, normName, diagPattern };
});
