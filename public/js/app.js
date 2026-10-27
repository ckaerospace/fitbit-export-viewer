/* app.js - UI. Everything runs locally; the worker reads the ZIP in slices. */
(function () {
'use strict';
const P = FBParse, A = FBAnalysis;
const $ = (s, r) => (r || document).querySelector(s), $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isNum = A.isNum;
const fmt = (v, d) => isNum(v) ? v.toLocaleString('en-US', { maximumFractionDigits: d || 0, minimumFractionDigits: d || 0 }) : '–';
const MB = b => (b / 1048576).toFixed(b > 1e8 ? 0 : 1) + ' MB';
const VERSION = '1.0.0';

const S = { files: [], raw: null, model: null, range: null, tab: 'overview', charts: {}, dirty: {}, worker: null,
  settings: { tz: 'browser', wunit: 'kg', wsrc: 'auto', dunit: 'km', theme: null }, timings: {}, maxFrameGap: 0, intradayDate: null, wkFilter: 'all', wkLimit: 60 };
const GROUPS = [
  ['activity', 'Activity', 'Steps, distance, calories, floors, active minutes'],
  ['hr', 'Heart rate (intraday)', 'Per-second or per-minute samples. Usually the largest part. Summarised on the fly, raw samples are discarded'],
  ['hrsum', 'Heart-rate summaries', 'Resting heart rate, time in zones, VO2 max'],
  ['sleep', 'Sleep', 'Nights, stages, scores'],
  ['workouts', 'Workouts', 'Logged exercises and Active Zone Minutes'],
  ['body', 'Body', 'Weight, body fat'],
  ['vitals', 'Vitals', 'SpO2, HRV, respiratory rate, temperature'],
  ['scores', 'Scores', 'Stress and readiness']
];
const TZS = [['browser', ''], ['none', 'No conversion (times are already local)'], ['UTC', 'UTC'], ['Europe/Berlin', 'Europe/Berlin'], ['Europe/London', 'Europe/London'], ['Europe/Paris', 'Europe/Paris'], ['Europe/Moscow', 'Europe/Moscow'], ['America/New_York', 'America/New York'], ['America/Chicago', 'America/Chicago'], ['America/Denver', 'America/Denver'], ['America/Los_Angeles', 'America/Los Angeles'], ['America/Sao_Paulo', 'America/Sao Paulo'], ['Asia/Dubai', 'Asia/Dubai'], ['Asia/Kolkata', 'Asia/Kolkata'], ['Asia/Singapore', 'Asia/Singapore'], ['Asia/Tokyo', 'Asia/Tokyo'], ['Australia/Sydney', 'Australia/Sydney'], ['Pacific/Auckland', 'Pacific/Auckland']];
const browserTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } })();
const effTz = () => S.settings.tz === 'browser' ? browserTz : S.settings.tz;

// ---------- persistence of display preferences only ----------
try { const t = JSON.parse(localStorage.getItem('fbv-settings') || '{}'); for (const k of ['tz', 'wunit', 'wsrc', 'dunit', 'theme']) if (t[k]) S.settings[k] = t[k]; } catch (e) {}
const saveSettings = () => { try { localStorage.setItem('fbv-settings', JSON.stringify(S.settings)); } catch (e) {} };

// ---------- theme ----------
function applyTheme() {
  const t = S.settings.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = t;
  if (window.Chart) { Chart.defaults.color = cssv('--muted'); }
}
const cssv = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const PAL = () => [cssv('--c1'), cssv('--c2'), cssv('--c3'), cssv('--c4'), cssv('--c5'), cssv('--c6')];

// ---------- stage handling ----------
function stage(name) {
  document.body.dataset.stage = name;
  for (const s of ['pick', 'options', 'progress', 'error', 'results']) $('#stage-' + s).hidden = s !== name;
  window.scrollTo(0, 0);
}
function showError(title, msg) { $('#err-title').textContent = title; $('#err-msg').textContent = msg; stage('error'); }

// ---------- file selection ----------
function onFiles(list) {
  const files = Array.from(list || []).filter(f => f && f.name);
  if (!files.length) return;
  if (files.length === 1 && /\.json$/i.test(files[0].name)) return importSummary(files[0]);
  const bad = files.filter(f => !/\.zip$/i.test(f.name) && f.type !== 'application/zip' && f.type !== 'application/x-zip-compressed');
  if (bad.length) return showError('That is not a ZIP file', 'Selected: ' + bad.map(f => f.name).join(', ') + '. Choose the ZIP that Google Takeout produced (or a summary .json saved from this page).');
  S.files = files;
  $('#opt-files').textContent = files.map(f => f.name + ' (' + MB(f.size) + ')').join(', ');
  $('#opt-groups').innerHTML = GROUPS.map(g => `<label><input type="checkbox" data-group="${g[0]}" checked><span>${esc(g[1])}<small>${esc(g[2])}</small></span></label>`).join('');
  stage('options');
}
$('#file-input').addEventListener('change', e => { onFiles(e.target.files); e.target.value = ''; });
$('#summary-input').addEventListener('change', e => { onFiles(e.target.files); e.target.value = ''; });
const drop = $('#drop');
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => onFiles(e.dataTransfer.files));
drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file-input').click(); } });
$('#btn-back').onclick = () => stage('pick');
$('#btn-err-back').onclick = () => stage('pick');
$('#btn-new').onclick = () => { disposeCharts(); S.raw = S.model = null; stage('pick'); };

// ---------- parsing in a worker ----------
let frameRaf = 0;
function watchFrames(on) {
  cancelAnimationFrame(frameRaf); if (!on) return;
  let last = performance.now(); S.maxFrameGap = 0;
  const loop = t => { S.maxFrameGap = Math.max(S.maxFrameGap, t - last); last = t; frameRaf = requestAnimationFrame(loop); };
  frameRaf = requestAnimationFrame(loop);
}
$('#btn-start').onclick = () => {
  const groups = $$('#opt-groups input:checked').map(i => i.dataset.group);
  if (!groups.length) return alert('Tick at least one group of data.');
  startParse(groups);
};
function startParse(groups) {
  stage('progress'); $('#pbar').style.width = '0'; $('#ppct').textContent = '0%'; $('#pfile').textContent = 'starting...'; $('#pcount').textContent = ''; $('#ptime').textContent = '';
  const t0 = performance.now(); S.timings = {}; S.groups = groups;
  let w; try { w = new Worker('js/worker.js'); } catch (e) { return showError('Your browser blocked the background worker', String(e && e.message || e)); }
  S.worker = w; watchFrames(true);
  const tick = setInterval(() => { $('#ptime').textContent = 'Elapsed ' + ((performance.now() - t0) / 1000).toFixed(0) + ' s'; }, 500);
  const done = () => { clearInterval(tick); watchFrames(false); w.terminate(); S.worker = null; };
  w.onmessage = ev => {
    const m = ev.data;
    if (m.type === 'progress') {
      const pct = Math.min(100, Math.floor(m.frac * 100));
      $('#pbar').style.width = (m.frac * 100).toFixed(1) + '%'; $('#ppct').textContent = pct + '%';
      $('#pfile').textContent = m.file; $('#pcount').textContent = 'file ' + fmt(m.fileIndex) + ' of ' + fmt(m.fileCount) + (m.zipCount > 1 ? ' (ZIP ' + m.zipIndex + '/' + m.zipCount + ')' : '');
    } else if (m.type === 'done') {
      done(); S.timings.parseMs = Math.round(performance.now() - t0); S.timings.workerMs = m.result.meta.parseMs;
      try { setData(m.result); } catch (e) { console.error(e); showError('Could not build the charts', String(e && e.message || e)); }
    } else if (m.type === 'cancelled') { done(); stage('options'); }
    else if (m.type === 'fatal') { done(); showError('This file could not be read', m.message + '. If this is a Takeout ZIP, try downloading it again. ZIPs that are still being synced from cloud storage can also fail.'); }
  };
  w.onerror = e => { done(); showError('The background worker crashed', e.message || 'unknown error'); };
  w.postMessage({ cmd: 'parse', files: S.files, groups });
}
$('#btn-cancel').onclick = () => { if (S.worker) S.worker.postMessage({ cmd: 'cancel' }); };

// ---------- model ----------
function resetViews() { $$('.view').forEach(v => { delete v.dataset.built; v.innerHTML = ''; }); disposeCharts(); }
function setData(raw) {
  resetViews(); S.range = null; S.intradayDate = null; S.raw = raw; rebuild(true);
}
function rebuild(reset) {
  const t0 = performance.now();
  S.model = A.buildModel(S.raw, { tz: effTz(), weightSource: S.settings.wsrc });
  S.timings.modelMs = Math.round(performance.now() - t0);
  const M = S.model;
  if (!M.dates.length && !M.hr.days.size) {
    return showError('No health data found', 'I read ' + fmt(M.meta.files) + ' files but found nothing I can chart. Open the Data tab after loading another file, or copy the diagnostics from there and send them to whoever maintains this tool.' + (M.meta.files ? ' (' + fmt(M.meta.unknownCount) + ' unrecognised files.)' : ''));
  }
  if (reset || !S.range) { setPreset('90', true); }
  stage('results'); S.dirty = {}; renderTab(S.tab);
}
function setPreset(p, silent) {
  const M = S.model; if (!M.last) return;
  const to = M.last, from = p === 'all' ? M.first : (A.addDays(to, -(+p - 1)) < M.first ? M.first : A.addDays(to, -(+p - 1)));
  setRange(from, to, p, silent);
}
function setRange(from, to, preset, silent) {
  const M = S.model; if (from < M.first) from = M.first; if (to > M.last) to = M.last; if (from > to) from = to;
  S.range = { from, to, preset: preset || null };
  $('#r-from').value = from; $('#r-to').value = to; $('#r-from').min = $('#r-to').min = M.first; $('#r-from').max = $('#r-to').max = M.last;
  $$('.range button').forEach(b => b.classList.toggle('on', b.dataset.range === String(preset)));
  const n = A.dateRange(from, to).length;
  $('#range-note').textContent = n + ' days, ' + from + ' to ' + to + '. Data in the export spans ' + M.first + ' to ' + M.last + '.';
  if (!silent) { S.dirty = {}; renderTab(S.tab); }
}
$$('.range button').forEach(b => b.onclick = () => setPreset(b.dataset.range));
$('#r-from').onchange = () => setRange($('#r-from').value || S.model.first, S.range.to);
$('#r-to').onchange = () => setRange(S.range.from, $('#r-to').value || S.model.last);

// ---------- tabs ----------
$('#tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab); });
function showTab(t) {
  S.tab = t;
  $$('#tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
  $$('.view').forEach(v => v.hidden = v.id !== 'view-' + t);
  if (S.model) renderTab(t);
}
const RENDERERS = {};
function renderTab(t) {
  if (!S.model) return;
  if (S.dirty[t] === false) return;
  const t0 = performance.now(); S.dirty[t] = false;
  RENDERERS[t]($('#view-' + t));
  S.timings['render_' + t] = Math.round(performance.now() - t0);
}

// ---------- charts ----------
function disposeCharts() { for (const k in S.charts) { try { S.charts[k].destroy(); } catch (e) {} } S.charts = {}; }
function merge(a, b) { for (const k in b) { if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object') merge(a[k], b[k]); else a[k] = b[k]; } return a; }
function card(id, title, o) { o = o || {}; return `<section class="card ${o.tall ? 'tall' : ''}" data-card="${id}"><header><h3>${esc(title)}</h3><button class="png" data-png="${id}" title="Download this chart as a PNG">PNG</button></header><div class="cv"><canvas id="${id}" role="img" aria-label="${esc(title)}"></canvas></div><p class="nodata-msg">No data for this in the selected range or export.</p><p class="note" data-note="${id}">${o.note || ''}</p></section>`; }
function mkChart(id, type, data, extra, hasData) {
  const el = document.getElementById(id); if (!el) return;
  const cardEl = el.closest('.card');
  if (S.charts[id]) { S.charts[id].destroy(); delete S.charts[id]; }
  if (hasData === false) { cardEl.classList.add('nodata'); return; }
  cardEl.classList.remove('nodata');
  const grid = cssv('--grid'), text = cssv('--muted');
  const opts = { animation: false, responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, normalized: true,
    plugins: { legend: { labels: { color: text, boxWidth: 10, usePointStyle: true } }, tooltip: { enabled: true } },
    scales: { x: { ticks: { color: text, maxTicksLimit: 8, maxRotation: 0, autoSkip: true }, grid: { color: grid } }, y: { ticks: { color: text }, grid: { color: grid } } } };
  S.charts[id] = new Chart(el.getContext('2d'), { type, data, options: merge(opts, extra || {}) });
}
function setNote(id, t) { const n = document.querySelector(`[data-note="${id}"]`); if (n) n.textContent = t || ''; }
document.addEventListener('click', e => {
  const b = e.target.closest('[data-png]'); if (!b) return;
  const c = document.getElementById(b.dataset.png); if (!c) return;
  const t = document.createElement('canvas'); t.width = c.width; t.height = c.height; const x = t.getContext('2d');
  x.fillStyle = cssv('--card'); x.fillRect(0, 0, t.width, t.height); x.drawImage(c, 0, 0);
  t.toBlob(bl => download(bl, b.dataset.png + '.png'), 'image/png');
});
function download(blob, name) { const u = URL.createObjectURL(blob), a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000); }

// unit helpers
const wFactor = () => S.settings.wunit === 'lb' ? 2.2046226218 : 1;
const dFactor = () => S.settings.dunit === 'mi' ? 0.621371 : 1;
const wLabel = () => S.settings.wunit, dLabel = () => S.settings.dunit;
const rangeDates = () => A.dateRange(S.range.from, S.range.to);
function series(field, o) {
  o = o || {}; const ds = rangeDates(); let vals = A.values(S.model, field, ds);
  if (o.scale) vals = vals.map(v => isNum(v) ? v * o.scale : v);
  const mode = o.mode || A.autoBucket(ds.length), b = A.bucket(ds, vals, mode, 'mean');
  return { mode, labels: b.labels, values: b.values, daily: vals, dates: ds };
}
const bucketNote = m => m === 'week' ? 'Weekly averages (weeks start Monday).' : m === 'month' ? 'Monthly averages.' : '';
const any = a => a.some(isNum);

function trend(id, field, o) {
  o = o || {}; const s = series(field, o), c = o.color || PAL()[0];
  const ds = [];
  if (o.type === 'line') ds.push({ label: o.label, data: s.values, borderColor: c, backgroundColor: c + '33', pointRadius: s.values.length > 120 ? 0 : 2, borderWidth: 2, tension: .25, spanGaps: true });
  else ds.push({ label: o.label, data: s.values, backgroundColor: c + 'cc', borderRadius: 2, maxBarThickness: 18 });
  if (o.ma !== false && s.mode === 'day') ds.push({ type: 'line', label: '7-day average', data: A.movingAvg(s.daily, 7), borderColor: PAL()[2], borderWidth: 2, pointRadius: 0, tension: .3, spanGaps: true });
  const extra = merge({ scales: { y: { beginAtZero: o.zero !== false && field !== 'rhr' && field !== 'weightKg' } } }, o.extra || {});
  mkChart(id, o.type === 'line' ? 'line' : 'bar', { labels: s.labels, datasets: ds }, extra, any(s.values));
  setNote(id, bucketNote(s.mode));
  return s;
}
function stacked(id, defs, o) {
  o = o || {}; const ds = rangeDates(), mode = A.autoBucket(ds.length); let labels = null, any_ = false;
  const sets = defs.map((d, i) => { const vals = A.values(S.model, d.field, ds).map(v => isNum(v) && d.scale ? v * d.scale : v), b = A.bucket(ds, vals, mode, 'mean'); labels = b.labels; if (any(b.values)) any_ = true; return { label: d.label, data: b.values, backgroundColor: PAL()[d.ci != null ? d.ci : i] + 'dd', borderRadius: 1, maxBarThickness: 18 }; });
  mkChart(id, 'bar', { labels: labels || [], datasets: sets }, { scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, title: { display: !!o.unit, text: o.unit || '', color: cssv('--muted') } } } }, any_);
  setNote(id, bucketNote(mode));
}
function statCard(id, label, v, sub, delta) { return `<div class="stat" data-stat="${id}"><div class="l">${esc(label)}</div><div class="v" data-v>${v}</div><div class="s">${sub || ''}</div>${delta ? `<div class="d">${delta}</div>` : ''}</div>`; }
function deltaText(cur, prev, d, unit, n) {
  if (!isNum(cur) || !isNum(prev) || !n) return '';
  const diff = cur - prev, pct = prev ? diff / prev * 100 : 0, arrow = Math.abs(pct) < 0.5 ? '=' : diff > 0 ? '▲' : '▼';
  return `<b>${arrow} ${fmt(Math.abs(diff), d)}${unit || ''}</b> (${diff >= 0 ? '+' : '-'}${Math.abs(pct).toFixed(1)}%) vs previous ${n} days`;
}
function prevWindow() { const n = rangeDates().length, to = A.addDays(S.range.from, -1), from = A.addDays(to, -(n - 1)); return { n, dates: A.dateRange(from, to) }; }
const dateShort = d => d;

// ---------- Overview ----------
const OV = [
  { id: 'steps', label: 'Steps per day', field: 'steps', d: 0, best: 'max' },
  { id: 'rhr', label: 'Resting heart rate', field: 'rhr', d: 1, unit: ' bpm', best: 'min', bestLabel: 'lowest' },
  { id: 'sleep', label: 'Sleep per night', field: 'sleepMin', fmtv: v => A.fmtHM(v), best: 'max' },
  { id: 'score', label: 'Sleep score', field: 'sleepScore', d: 0, best: 'max' },
  { id: 'active', label: 'Active minutes', field: 'activeMin', d: 0, unit: ' min', best: 'max', hint: 'moderate + very active' },
  { id: 'calories', label: 'Calories per day', field: 'calories', d: 0, best: 'max' },
  { id: 'weight', label: 'Weight', field: 'weightKg', d: 1, scaleFn: true, best: null }
];
RENDERERS.overview = function (el) {
  const M = S.model, ds = rangeDates(), pw = prevWindow();
  if (!el.dataset.built) {
    el.dataset.built = 1;
    el.innerHTML = `<div class="grid stats" id="ov-stats"></div>
      <h2 class="sec">Last 7, 30 and 90 days compared with the period before</h2><div class="card"><div class="tw"><table id="ov-cmp"></table></div><p class="note">Ends on the last day with data in the export. Averages per day.</p></div>
      <h2 class="sec">Trends</h2><div class="grid charts">${card('ch-ov-steps', 'Steps per day')}${card('ch-ov-rhr', 'Resting heart rate')}${card('ch-ov-sleep', 'Sleep per night (hours)')}${card('ch-ov-weight', 'Weight')}</div>`;
  }
  $('#ov-stats').innerHTML = OV.map(o => {
    const st = A.stat(M, o.field, ds, o.best === 'min' ? 'min' : 'max'), pv = A.mean(A.values(M, o.field, pw.dates));
    const k = o.scaleFn ? wFactor() : 1, f = v => isNum(v) ? (o.fmtv ? o.fmtv(v * k) : fmt(v * k, o.d) + (o.unit || '') + (o.scaleFn ? ' ' + wLabel() : '')) : '–';
    let v, sub, delta = '';
    if (o.id === 'weight') {
      const vals = A.values(M, o.field, ds), idxs = vals.map((x, i) => isNum(x) ? i : -1).filter(i => i >= 0);
      if (!idxs.length) { v = '–'; sub = 'no weigh-ins in range'; } else { const a = vals[idxs[0]], b = vals[idxs[idxs.length - 1]]; v = f(b); sub = 'latest, ' + ds[idxs[idxs.length - 1]]; delta = idxs.length > 1 ? `<b>${b - a >= 0 ? '+' : '-'}${fmt(Math.abs(b - a) * k, 1)} ${wLabel()}</b> since ${ds[idxs[0]]}` : ''; }
    } else {
      v = f(st.avg); sub = st.n ? (st.bestDate ? `${o.bestLabel || 'best'}: ${f(st.best)} on ${dateShort(st.bestDate)}` : '') + (o.hint ? ` (${o.hint})` : '') + ` · ${st.n} days` : 'no data in range';
      delta = deltaText(st.avg * k, isNum(pv) ? pv * k : null, o.d || 0, o.unit && !o.fmtv ? o.unit : (o.fmtv ? ' min' : ''), pw.n);
      if (o.fmtv && isNum(st.avg) && isNum(pv)) delta = deltaText(st.avg, pv, 0, ' min', pw.n);
    }
    return statCard(o.id, o.label, v, sub, delta);
  }).join('');
  // comparison table
  const end = M.last, rows = [['Steps', 'steps', 0, ''], ['Resting HR', 'rhr', 1, ' bpm'], ['Sleep (min)', 'sleepMin', 0, ' min'], ['Active min', 'activeMin', 0, ' min'], ['Calories', 'calories', 0, '']];
  let h = '<thead><tr><th>Metric</th>' + [7, 30, 90].map(n => `<th class="n">${n} days</th><th class="n">before</th><th class="n">change</th>`).join('') + '</tr></thead><tbody>';
  for (const [name, f, d, u] of rows) {
    h += `<tr data-cmp="${f}"><td>${name}</td>`;
    for (const n of [7, 30, 90]) { const c = A.compareWindows(M, f, end, n); h += `<td class="n">${fmt(c.cur, d)}</td><td class="n">${fmt(c.prev, d)}</td><td class="n">${c.pct == null ? '–' : (c.pct >= 0 ? '+' : '') + c.pct.toFixed(1) + '%'}</td>`; }
    h += '</tr>';
  }
  $('#ov-cmp').innerHTML = h + '</tbody>';
  trend('ch-ov-steps', 'steps', { label: 'Steps' });
  trend('ch-ov-rhr', 'rhr', { label: 'Resting HR (bpm)', type: 'line', color: PAL()[3], zero: false });
  trend('ch-ov-sleep', 'sleepMin', { label: 'Hours asleep', scale: 1 / 60, color: PAL()[4] });
  trend('ch-ov-weight', 'weightKg', { label: 'Weight (' + wLabel() + ')', scale: wFactor(), type: 'line', color: PAL()[1], ma: false, zero: false });
};

// ---------- Sleep ----------
RENDERERS.sleep = function (el) {
  const M = S.model, ds = rangeDates(), nights = ds.map(d => M.nights[d]).filter(Boolean);
  if (!el.dataset.built) {
    el.dataset.built = 1;
    el.innerHTML = `<div class="grid stats" id="sl-stats"></div><div class="grid charts" style="margin-top:12px">
      ${card('ch-sl-dur', 'Nightly sleep (hours)')}${card('ch-sl-stages', 'Sleep stages (minutes)')}${card('ch-sl-bed', 'Bedtime')}${card('ch-sl-eff', 'Sleep efficiency (%)')}${card('ch-sl-wd', 'Sleep by weekday of waking up (hours)')}</div>
      <div class="card" style="margin-top:12px"><h3>Weekdays and weekends</h3><div class="tw"><table id="sl-wk"></table></div><p class="note">A "weekend night" is a night you woke up on a Saturday or Sunday (Friday and Saturday night).</p></div>`;
  }
  const avg = f => A.mean(nights.map(n => n[f]));
  $('#sl-stats').innerHTML = statCard('sl-dur', 'Average sleep', fmt(avg('asleep') != null ? avg('asleep') : null) === '–' ? '–' : A.fmtHM(avg('asleep')), nights.length + ' nights') +
    statCard('sl-eff', 'Efficiency', isNum(avg('effPct')) ? fmt(avg('effPct'), 1) + '%' : '–', 'asleep / time in bed') +
    statCard('sl-bed', 'Typical bedtime', isNum(avg('bedMin')) ? A.fmtClock(avg('bedMin') + 1080) : '–', 'average start of the main sleep') +
    statCard('sl-wake', 'Typical wake time', isNum(avg('wakeMin')) ? A.fmtClock(avg('wakeMin')) : '–', 'average end of the main sleep') +
    statCard('sl-score', 'Average score', isNum(avg('score')) ? fmt(avg('score'), 0) : '–', 'from sleep scores, if present');
  trend('ch-sl-dur', 'sleepMin', { label: 'Hours asleep', scale: 1 / 60, color: PAL()[4] });
  const mode = A.autoBucket(ds.length), sd = (f) => A.bucket(ds, ds.map(d => { const n = M.nights[d]; return n && isNum(n[f]) ? n[f] : null; }), mode, 'mean');
  const st = [['deep', 'Deep', 0], ['light', 'Light', 5], ['rem', 'REM', 4], ['wake', 'Awake', 2]].map(([f, l, ci]) => ({ f, l, ci, b: sd(f) }));
  mkChart('ch-sl-stages', 'bar', { labels: st[0].b.labels, datasets: st.map(s => ({ label: s.l, data: s.b.values, backgroundColor: PAL()[s.ci] + 'dd', maxBarThickness: 18 })) }, { scales: { x: { stacked: true }, y: { stacked: true } } }, st.some(s => any(s.b.values)));
  setNote('ch-sl-stages', bucketNote(mode) + (mode === 'day' ? '' : ''));
  const bedPts = ds.map((d, i) => M.nights[d] ? { x: i, y: M.nights[d].bedMin, d } : null).filter(Boolean);
  const stepsLab = i => ds[i] || '';
  mkChart('ch-sl-bed', 'scatter', { datasets: [{ label: 'Bedtime', data: bedPts, backgroundColor: PAL()[4] + 'cc', pointRadius: bedPts.length > 400 ? 1.5 : 3 }] },
    { interaction: { mode: 'nearest', intersect: true }, plugins: { legend: { display: false }, tooltip: { callbacks: { title: it => it[0].raw.d, label: it => 'Bedtime ' + A.fmtClock(it.raw.y + 1080) } } },
      scales: { x: { type: 'linear', min: 0, max: Math.max(1, ds.length - 1), ticks: { callback: v => stepsLab(Math.round(v)).slice(0, 10), maxTicksLimit: 6 } }, y: { reverse: true, ticks: { callback: v => A.fmtClock(v + 1080) } } } }, bedPts.length > 0);
  trend('ch-sl-eff', 'effPct', { label: 'Efficiency %', type: 'line', color: PAL()[1], zero: false });
  // weekday
  const byWd = [[], [], [], [], [], [], []]; nights.forEach(n => { if (isNum(n.asleep)) byWd[A.weekday(n.date)].push(n.asleep / 60); });
  mkChart('ch-sl-wd', 'bar', { labels: A.WD, datasets: [{ label: 'Hours asleep', data: byWd.map(A.mean), backgroundColor: PAL()[4] + 'cc', borderRadius: 4 }] }, { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }, byWd.some(a => a.length));
  const wkd = nights.filter(n => A.weekday(n.date) < 5), wke = nights.filter(n => A.weekday(n.date) >= 5);
  const row = (name, l) => `<tr><td>${name}</td><td class="n">${l.length}</td><td class="n">${A.fmtHM(A.mean(l.map(n => n.asleep)))}</td><td class="n">${isNum(A.mean(l.map(n => n.bedMin))) ? A.fmtClock(A.mean(l.map(n => n.bedMin)) + 1080) : '–'}</td><td class="n">${isNum(A.mean(l.map(n => n.wakeMin))) ? A.fmtClock(A.mean(l.map(n => n.wakeMin))) : '–'}</td><td class="n">${fmt(A.mean(l.map(n => n.effPct)), 1)}</td></tr>`;
  $('#sl-wk').innerHTML = '<thead><tr><th></th><th class="n">Nights</th><th class="n">Asleep</th><th class="n">Bedtime</th><th class="n">Wake</th><th class="n">Eff. %</th></tr></thead><tbody>' + row('Sun to Thu nights', wkd) + row('Fri and Sat nights', wke) + '</tbody>';
};

// ---------- Heart ----------
RENDERERS.heart = function (el) {
  const M = S.model, ds = rangeDates();
  if (!el.dataset.built) {
    el.dataset.built = 1;
    el.innerHTML = `<div class="grid charts">${card('ch-hr-rhr', 'Resting heart rate (bpm)')}${card('ch-hr-band', 'Daily heart rate: lowest, average, highest (bpm)')}${card('ch-hr-zones', 'Minutes in heart-rate zones')}${card('ch-hr-azm', 'Active Zone Minutes')}${card('ch-hr-hrv', 'Heart rate variability (ms)')}</div>
      <h2 class="sec">One day, 5-minute view</h2>
      <div class="card tall"><div class="day-ctl"><button class="ghost" id="id-prev" aria-label="Previous day">&lt;</button><input type="date" id="id-date" aria-label="Day to show"><button class="ghost" id="id-next" aria-label="Next day">&gt;</button><span class="muted small" id="id-info"></span></div>
      <div class="cv"><canvas id="ch-hr-day" role="img" aria-label="Heart rate during one day"></canvas></div><p class="nodata-msg">No heart-rate samples for this day.</p><p class="note" data-note="ch-hr-day"></p></div>`;
    $('#id-date').onchange = () => { S.intradayDate = $('#id-date').value; drawIntraday(); };
    $('#id-prev').onclick = () => { S.intradayDate = A.addDays(S.intradayDate, -1); drawIntraday(); };
    $('#id-next').onclick = () => { S.intradayDate = A.addDays(S.intradayDate, 1); drawIntraday(); };
  }
  trend('ch-hr-rhr', 'rhr', { label: 'Resting HR', type: 'line', color: PAL()[3], zero: false });
  // band
  const mode = A.autoBucket(ds.length), b = f => A.bucket(ds, A.values(M, f, ds), mode, 'mean');
  const mn = b('hrMin'), av = b('hrAvg'), mx = b('hrMax');
  mkChart('ch-hr-band', 'line', { labels: av.labels, datasets: [
    { label: 'Lowest', data: mn.values, borderColor: PAL()[5], pointRadius: 0, borderWidth: 1.5, spanGaps: true },
    { label: 'Highest', data: mx.values, borderColor: PAL()[3], backgroundColor: PAL()[3] + '22', pointRadius: 0, borderWidth: 1.5, fill: '-1', spanGaps: true },
    { label: 'Average', data: av.values, borderColor: PAL()[0], pointRadius: 0, borderWidth: 2, spanGaps: true }] }, { scales: { y: { beginAtZero: false } } }, any(av.values));
  setNote('ch-hr-band', (bucketNote(mode) || '') + ' Needs the intraday heart-rate files.');
  stacked('ch-hr-zones', [{ field: 'zFat', label: 'Fat burn', ci: 2 }, { field: 'zCardio', label: 'Cardio', ci: 3 }, { field: 'zPeak', label: 'Peak', ci: 4 }], { unit: 'minutes' });
  stacked('ch-hr-azm', [{ field: 'azmFat', label: 'Fat burn', ci: 2 }, { field: 'azmCardio', label: 'Cardio', ci: 3 }, { field: 'azmPeak', label: 'Peak', ci: 4 }], { unit: 'minutes' });
  const hv = trend('ch-hr-hrv', 'hrv', { label: 'HRV (RMSSD, ms)', type: 'line', color: PAL()[4], zero: false });
  if (!S.intradayDate || !(S.intradayDate >= M.first && S.intradayDate <= M.last)) { const withHr = ds.filter(d => M.daily[d] && M.daily[d].hrN), med = A.median(withHr.map(d => M.daily[d].hrN)) || 0, full = withHr.filter(d => M.daily[d].hrN >= med * 0.6); S.intradayDate = full.length ? full[full.length - 1] : withHr.length ? withHr[withHr.length - 1] : S.range.to; }
  drawIntraday();
};
function drawIntraday() {
  const M = S.model, d = S.intradayDate; $('#id-date').value = d;
  const o = M.hr.days.get(P.dayIdxOfKey(d));
  if (!o) { mkChart('ch-hr-day', 'line', { labels: [], datasets: [] }, {}, false); $('#id-info').textContent = M.daily[d] && M.daily[d].hrN ? 'Only daily totals were saved for this day.' : ''; return; }
  const labels = [], avg = [], mn = [], mx = []; let n = 0, s = 0, lo = 999, hi = 0;
  for (let b = 0; b < 288; b++) {
    labels.push(String(Math.floor(b / 12)).padStart(2, '0') + ':' + String((b % 12) * 5).padStart(2, '0'));
    if (o.c[b]) { avg.push(o.s[b] / o.c[b]); mn.push(o.mn[b]); mx.push(o.mx[b]); n += o.c[b]; s += o.s[b]; lo = Math.min(lo, o.mn[b]); hi = Math.max(hi, o.mx[b]); } else { avg.push(null); mn.push(null); mx.push(null); }
  }
  mkChart('ch-hr-day', 'line', { labels, datasets: [
    { label: 'Lowest', data: mn, borderColor: PAL()[5] + '99', pointRadius: 0, borderWidth: 1, spanGaps: false },
    { label: 'Highest', data: mx, borderColor: PAL()[3] + '99', backgroundColor: PAL()[3] + '1c', pointRadius: 0, borderWidth: 1, fill: '-1', spanGaps: false },
    { label: 'Average', data: avg, borderColor: PAL()[0], pointRadius: 0, borderWidth: 2, spanGaps: false }] }, { scales: { x: { ticks: { maxTicksLimit: 9 } }, y: { beginAtZero: false } } }, true);
  $('#id-info').textContent = fmt(n) + ' samples · min ' + lo + ' · avg ' + fmt(s / n, 1) + ' · max ' + hi + ' bpm (' + (effTz() === 'none' ? 'no conversion' : effTz()) + ')';
  setNote('ch-hr-day', 'Each point is the average of one 5-minute slice, the band is its lowest and highest sample.');
}

// ---------- Activity ----------
RENDERERS.activity = function (el) {
  const M = S.model, ds = rangeDates();
  if (!el.dataset.built) {
    el.dataset.built = 1;
    el.innerHTML = `<div class="grid charts">${card('ch-ac-steps', 'Steps per day')}${card('ch-ac-dist', 'Distance per day')}${card('ch-ac-min', 'Active minutes')}${card('ch-ac-cal', 'Calories per day')}${card('ch-ac-azm', 'Active Zone Minutes')}${card('ch-ac-floors', 'Floors per day')}</div>
      <h2 class="sec">Steps calendar</h2><div class="card"><div class="hm-wrap"><canvas id="hm-canvas" role="img" aria-label="Steps per day calendar heatmap"></canvas></div><div class="hm-legend">less <i style="background:var(--hm0)"></i><i style="background:var(--hm1)"></i><i style="background:var(--hm2)"></i><i style="background:var(--hm3)"></i><i style="background:var(--hm4)"></i> more · last 53 weeks up to the end of the range</div><p class="hm-read" id="hm-read" data-testid="hm-read">Tap a square to see that day.</p></div>
      <h2 class="sec">Workouts</h2><div class="grid charts">${card('ch-ac-wkvol', 'Weekly workout minutes by type')}<section class="card"><h3>Totals by type</h3><div class="tw"><table id="wk-types"></table></div></section></div>
      <div class="card" style="margin-top:12px"><div class="filters"><label>Type <select id="wk-filter"></select></label><span class="muted small" id="wk-count"></span></div><div class="tw"><table id="wk-list"></table></div><p><button class="ghost" id="wk-more">Show more</button></p></div>`;
    $('#wk-filter').onchange = () => { S.wkFilter = $('#wk-filter').value; S.wkLimit = 60; drawWorkoutList(); };
    $('#wk-more').onclick = () => { S.wkLimit += 100; drawWorkoutList(); };
    $('#hm-canvas').addEventListener('click', hmClick);
  }
  trend('ch-ac-steps', 'steps', { label: 'Steps' });
  trend('ch-ac-dist', 'distance', { label: 'Distance (' + dLabel() + ')', scale: dFactor(), color: PAL()[5] });
  stacked('ch-ac-min', [{ field: 'lightly', label: 'Lightly', ci: 5 }, { field: 'moderately', label: 'Moderately', ci: 2 }, { field: 'very', label: 'Very', ci: 3 }], { unit: 'minutes' });
  trend('ch-ac-cal', 'calories', { label: 'Calories', color: PAL()[3] });
  stacked('ch-ac-azm', [{ field: 'azmFat', label: 'Fat burn', ci: 2 }, { field: 'azmCardio', label: 'Cardio', ci: 3 }, { field: 'azmPeak', label: 'Peak', ci: 4 }], { unit: 'minutes' });
  trend('ch-ac-floors', 'floors', { label: 'Floors', color: PAL()[1] });
  drawHeatmap();
  const list = M.exercises.filter(e => e.date >= S.range.from && e.date <= S.range.to);
  const types = A.workoutStats(list);
  $('#wk-types').innerHTML = types.length ? '<thead><tr><th>Type</th><th class="n">Count</th><th class="n">Minutes</th><th class="n">Calories</th><th class="n">' + dLabel() + '</th><th class="n">Avg HR</th></tr></thead><tbody>' + types.map(t => `<tr data-wktype="${esc(t.name)}"><td>${esc(t.name)}</td><td class="n">${t.n}</td><td class="n">${fmt(t.min)}</td><td class="n">${fmt(t.cal)}</td><td class="n">${t.km ? fmt(t.km * dFactor(), 1) : '–'}</td><td class="n">${fmt(t.avgHr)}</td></tr>`).join('') + '</tbody>' : '<tbody><tr><td class="muted">No workouts in this range.</td></tr></tbody>';
  const wv = A.weeklyVolume(list, S.range.from, S.range.to), pal = PAL();
  mkChart('ch-ac-wkvol', 'bar', { labels: wv.weeks, datasets: wv.types.map((t, i) => ({ label: t, data: wv.data[i], backgroundColor: pal[i % pal.length] + 'dd', maxBarThickness: 20 })) }, { scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } } }, wv.types.length > 0);
  const sel = $('#wk-filter'), cur = S.wkFilter; sel.innerHTML = '<option value="all">All types</option>' + types.map(t => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join(''); sel.value = types.some(t => t.name === cur) ? cur : 'all'; S.wkFilter = sel.value;
  drawWorkoutList();
};
function drawWorkoutList() {
  const list = S.model.exercises.filter(e => e.date >= S.range.from && e.date <= S.range.to && (S.wkFilter === 'all' || e.name === S.wkFilter)).sort((a, b) => b.t < a.t ? -1 : 1);
  $('#wk-count').textContent = list.length + ' workouts';
  $('#wk-list').innerHTML = '<thead><tr><th>Date</th><th>Type</th><th class="n">Min</th><th class="n">Calories</th><th class="n">Avg HR</th><th class="n">Steps</th><th class="n">' + dLabel() + '</th></tr></thead><tbody>' +
    list.slice(0, S.wkLimit).map(e => `<tr><td>${esc(e.t.replace('T', ' '))}</td><td>${esc(e.name)}</td><td class="n">${fmt(e.dur)}</td><td class="n">${fmt(e.cal)}</td><td class="n">${fmt(e.hr)}</td><td class="n">${fmt(e.steps)}</td><td class="n">${isNum(e.dist) && e.dist ? fmt(e.dist * dFactor(), 2) : '–'}</td></tr>`).join('') + '</tbody>';
  $('#wk-more').hidden = list.length <= S.wkLimit;
}
let HM = null;
function drawHeatmap() {
  const cv = $('#hm-canvas'), M = S.model, weeks = 53, wrap = cv.parentElement.clientWidth || 340, cell = Math.max(6, Math.floor((wrap - 30) / weeks)), gap = cell > 9 ? 2 : 1;
  const h = A.heatmap(M, 'steps', S.range.to, weeks), W = 30 + weeks * cell, H = 18 + 7 * cell, dpr = window.devicePixelRatio || 1;
  cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px';
  const x = cv.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, W, H);
  const vals = h.cells.filter(c => c.v != null && c.v > 0).map(c => c.v).sort((a, b) => a - b), q = p => vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] : 0, th = [q(.2), q(.4), q(.6), q(.8)];
  const col = [cssv('--hm0'), cssv('--hm1'), cssv('--hm2'), cssv('--hm3'), cssv('--hm4')];
  x.font = '10px system-ui'; x.fillStyle = cssv('--muted'); x.textBaseline = 'middle';
  ['Mon', 'Wed', 'Fri'].forEach((l, i) => x.fillText(l, 0, 18 + (i * 2 + .5) * cell));
  let lastMonth = '';
  for (const c of h.cells) {
    if (c.d > S.range.to) continue;
    const px = 30 + c.w * cell, py = 18 + c.r * cell;
    if (c.r === 0 && c.d.slice(0, 7) !== lastMonth && c.d.slice(8) <= '07') { lastMonth = c.d.slice(0, 7); x.fillStyle = cssv('--muted'); x.fillText(c.d.slice(0, 7), px, 8); }
    let lv = 0; if (c.v != null && c.v > 0) lv = c.v <= th[0] ? 1 : c.v <= th[1] ? 2 : c.v <= th[2] ? 3 : c.v <= th[3] ? 3 : 4; if (c.v != null && c.v > th[3]) lv = 4; else if (c.v != null && c.v > 0 && lv === 0) lv = 1;
    x.fillStyle = col[lv]; x.fillRect(px, py, cell - gap, cell - gap);
  }
  HM = { h, cell, th };
}
function hmClick(e) {
  if (!HM) return; const r = e.target.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, w = Math.floor((x - 30) / HM.cell), rr = Math.floor((y - 18) / HM.cell);
  const c = HM.h.cells.find(c => c.w === w && c.r === rr); if (!c || c.d > S.range.to) return;
  $('#hm-read').textContent = c.d + ' (' + A.WD[c.r] + '): ' + (c.v != null ? fmt(c.v) + ' steps' : 'no data');
}

// ---------- Body ----------
RENDERERS.body = function (el) {
  const M = S.model;
  if (!el.dataset.built) {
    el.dataset.built = 1;
    el.innerHTML = `<div class="grid charts">${card('ch-bd-w', 'Weight')}${card('ch-bd-fat', 'Body fat (%) and BMI')}${card('ch-bd-spo2', 'Blood oxygen, SpO2 (%)')}${card('ch-bd-resp', 'Respiratory rate (breaths per minute)')}${card('ch-bd-temp', 'Skin temperature (relative to your baseline)')}${card('ch-bd-vo2', 'VO2 max estimate')}</div><p class="hint">These are the values Fitbit stored. Descriptive only, not medical advice.</p>`;
  }
  trend('ch-bd-w', 'weightKg', { label: 'Weight (' + wLabel() + ')', scale: wFactor(), type: 'line', color: PAL()[1], ma: false, zero: false });
  const ds = rangeDates(), mode = A.autoBucket(ds.length), f = n => A.bucket(ds, A.values(M, n, ds), mode, 'mean'), fat = f('fat'), bmi = f('bmi');
  mkChart('ch-bd-fat', 'line', { labels: fat.labels, datasets: [{ label: 'Body fat %', data: fat.values, borderColor: PAL()[2], spanGaps: true, pointRadius: 2, yAxisID: 'y' }, { label: 'BMI', data: bmi.values, borderColor: PAL()[0], spanGaps: true, pointRadius: 2, yAxisID: 'y1' }] }, { scales: { y: { position: 'left' }, y1: { position: 'right', grid: { drawOnChartArea: false }, ticks: { color: cssv('--muted') } } } }, any(fat.values) || any(bmi.values));
  const sp = f('spo2'), sl = f('spo2Min'), sh = f('spo2Max');
  mkChart('ch-bd-spo2', 'line', { labels: sp.labels, datasets: [{ label: 'Lowest', data: sl.values, borderColor: PAL()[5], pointRadius: 0, spanGaps: true }, { label: 'Highest', data: sh.values, borderColor: PAL()[3], backgroundColor: PAL()[3] + '22', fill: '-1', pointRadius: 0, spanGaps: true }, { label: 'Average', data: sp.values, borderColor: PAL()[0], pointRadius: 0, borderWidth: 2, spanGaps: true }].filter(d => any(d.data)) }, { scales: { y: { suggestedMin: 88, suggestedMax: 100 } } }, any(sp.values) || any(sl.values));
  trend('ch-bd-resp', 'resp', { label: 'Breaths per minute', type: 'line', color: PAL()[1], zero: false });
  trend('ch-bd-temp', 'temp', { label: 'Relative temperature', type: 'line', color: PAL()[3], zero: false });
  trend('ch-bd-vo2', 'vo2', { label: 'VO2 max', type: 'line', color: PAL()[4], zero: false });
};

// ---------- Patterns ----------
RENDERERS.patterns = function (el) {
  const M = S.model, ds = rangeDates();
  if (!el.dataset.built) {
    el.dataset.built = 1;
    el.innerHTML = `<div class="warn">These are descriptive patterns in your own numbers. A correlation does not show cause, and none of this is medical advice. Talk to a clinician about health questions.</div>
      <h2 class="sec">Average by weekday</h2><div class="grid charts">${card('ch-pt-steps', 'Steps')}${card('ch-pt-sleep', 'Sleep (hours)')}${card('ch-pt-rhr', 'Resting heart rate')}${card('ch-pt-act', 'Active minutes')}</div>
      <h2 class="sec">Relationships</h2><div class="grid charts">${card('ch-pt-c1', 'Sleep length vs resting heart rate')}${card('ch-pt-c2', 'Steps vs sleep that night')}</div>
      <h2 class="sec">Smoothed trends (7-day and 28-day averages)</h2><div class="grid charts">${card('ch-pt-t-steps', 'Steps')}${card('ch-pt-t-rhr', 'Resting heart rate')}${card('ch-pt-t-sleep', 'Sleep (hours)')}</div>`;
  }
  const wd = (id, f, label, scale, ci) => { const m = A.weekdayMeans(M, f, ds).map(v => isNum(v) ? v * scale : v); mkChart(id, 'bar', { labels: A.WD, datasets: [{ label, data: m, backgroundColor: PAL()[ci] + 'cc', borderRadius: 4 }] }, { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }, any(m)); };
  wd('ch-pt-steps', 'steps', 'Steps', 1, 0); wd('ch-pt-sleep', 'sleepMin', 'Hours', 1 / 60, 4); wd('ch-pt-rhr', 'rhr', 'bpm', 1, 3); wd('ch-pt-act', 'activeMin', 'Minutes', 1, 2);
  const scat = (id, xs, ys, xl, yl, lab, cx, cy) => {
    const pts = []; for (let i = 0; i < xs.length; i++) if (isNum(xs[i]) && isNum(ys[i])) pts.push({ x: xs[i], y: ys[i], d: ds[i] });
    const r = A.pearson(pts.map(p => p.x), pts.map(p => p.y)); const sets = [{ label: lab, data: pts, backgroundColor: PAL()[cx] + '99', pointRadius: pts.length > 500 ? 1.5 : 3 }];
    if (r.r != null && pts.length) { const xsr = pts.map(p => p.x), a = A.minOf(xsr), b = A.maxOf(xsr); sets.push({ type: 'line', label: 'Trend', data: [{ x: a, y: r.intercept + r.slope * a }, { x: b, y: r.intercept + r.slope * b }], borderColor: PAL()[cy], pointRadius: 0, borderWidth: 2 }); }
    mkChart(id, 'scatter', { datasets: sets }, { interaction: { mode: 'nearest', intersect: true }, plugins: { legend: { display: false } }, scales: { x: { type: 'linear', title: { display: true, text: xl, color: cssv('--muted') } }, y: { title: { display: true, text: yl, color: cssv('--muted') } } } }, pts.length > 2);
    setNote(id, r.r == null ? 'Not enough overlapping days (need at least 3).' : `${pts.length} days, correlation r = ${r.r.toFixed(2)} (${Math.abs(r.r) < .2 ? 'very weak' : Math.abs(r.r) < .4 ? 'weak' : Math.abs(r.r) < .6 ? 'moderate' : 'strong'}). Descriptive only.`);
    return r;
  };
  const sleepH = A.values(M, 'sleepMin', ds).map(v => isNum(v) ? v / 60 : null);
  S.corr = {}; S.corr.sleepRhr = scat('ch-pt-c1', sleepH, A.values(M, 'rhr', ds), 'Hours asleep (night ending that day)', 'Resting HR (bpm) the same day', 'Days', 0, 3);
  const stepsPrev = ds.map(d => { const v = M.daily[A.addDays(d, -1)]; return v && isNum(v.steps) ? v.steps : null; });
  S.corr.stepsSleep = scat('ch-pt-c2', stepsPrev, sleepH, 'Steps the day before', 'Hours asleep', 'Days', 2, 4);
  const tr = (id, f, label, scale, ci, zero) => {
    const vals = A.values(M, f, ds).map(v => isNum(v) ? v * scale : v);
    mkChart(id, 'line', { labels: ds, datasets: [{ label: 'Daily', data: vals, borderColor: PAL()[ci] + '55', pointRadius: 0, borderWidth: 1, spanGaps: true }, { label: '7-day', data: A.movingAvg(vals, 7), borderColor: PAL()[ci], pointRadius: 0, borderWidth: 2, spanGaps: true }, { label: '28-day', data: A.movingAvg(vals, 28), borderColor: PAL()[2], pointRadius: 0, borderWidth: 2.5, spanGaps: true }] }, { scales: { y: { beginAtZero: zero } } }, any(vals));
  };
  tr('ch-pt-t-steps', 'steps', 'Steps', 1, 0, true); tr('ch-pt-t-rhr', 'rhr', 'RHR', 1, 3, false); tr('ch-pt-t-sleep', 'sleepMin', 'Sleep', 1 / 60, 4, false);
};

// ---------- Data / export ----------
function diagnosticText() {
  const m = S.raw.meta, L = [];
  L.push('fitbit-export-viewer diagnostics v' + VERSION);
  L.push('Contains: file and folder names (dates and long numbers replaced by placeholders), counts, sizes, CSV column headers and JSON key names. No values, no health data.');
  L.push('files=' + m.files + ' recognised=' + m.dataFiles + ' unrecognised=' + m.unknownCount + ' unreadable=' + m.errorCount + ' parse_ms=' + (m.parseMs || ''));
  L.push('range=' + (m.firstDate || '-') + '..' + (m.lastDate || '-') + ' distUnitGuess=' + (m.distUnit || '-') + ' (' + (m.distNote || '') + ')');
  L.push('');
  L.push('## File patterns (status | type | files | rows | bytes | failed | headers/keys)');
  for (const d of m.diag) L.push([d.status, d.type || '-', d.files, d.rows || 0, d.bytes || 0, d.failed || 0, (d.header || []).join(',')].join(' | ') + ' | ' + d.pattern);
  if (m.unknown.length) { L.push(''); L.push('## Unrecognised files (' + m.unknownCount + ', first ' + m.unknown.length + ' shown)'); for (const u of m.unknown) L.push(u.size + ' B | ' + u.path + ' | ' + u.why); }
  if (m.errors.length) { L.push(''); L.push('## Unreadable files (' + m.errorCount + ', first ' + m.errors.length + ' shown)'); for (const u of m.errors) L.push(u.path + ' | ' + u.msg); }
  if (m.warnings.length) { L.push(''); L.push('## Warnings'); for (const u of m.warnings) L.push(u.path + ' | ' + u.msg); }
  return L.join('\n');
}
RENDERERS.data = function (el) {
  const m = S.raw.meta, skipped = Object.keys(m.skippedByGroup || {});
  const rows = Object.entries(m.types).map(([t, o]) => `<tr><td>${esc(m.typeLabels[t] || t)}</td><td class="n">${fmt(o.files)}</td><td class="n">${fmt(o.rows)}</td></tr>`).join('');
  el.innerHTML = `<div class="grid charts">
  <section class="card"><h3>What I found</h3>${rows ? `<div class="tw"><table data-testid="types-table"><thead><tr><th>Data type</th><th class="n">Files</th><th class="n">Records</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="muted">No known data types.</p>'}
    <p class="note">${fmt(m.files)} files in the ZIP, ${fmt(m.dataFiles)} recognised and read${skipped.length ? ', skipped on request: ' + esc(skipped.map(k => k + ' (' + m.skippedByGroup[k] + ')').join(', ')) : ''}.<br>Read in ${((S.timings.parseMs || m.parseMs || 0) / 1000).toFixed(1)} s on this device.${m.distNote ? '<br>Distance unit: ' + esc(m.distUnit) + ' (' + esc(m.distNote) + ').' : ''}</p></section>
  <section class="card"><h3>Files I could not read</h3><div id="dt-bad" data-testid="bad-files"></div></section></div>
  <h2 class="sec">Help me support your layout</h2>
  <div class="card"><p>If something is missing, copy this and send it to the person who maintains this tool. It contains <strong>file and folder names (dates and long numbers replaced), counts, sizes, CSV column headers and JSON key names</strong>. It contains no values and no health data.</p>
  <div class="row"><button class="primary" id="dt-copy">Copy diagnostics</button><button class="ghost" id="dt-dl">Download .txt</button><span id="dt-copied" class="muted small" role="status"></span></div>
  <p><textarea id="dt-text" class="diag" readonly aria-label="Diagnostics text" data-testid="diag-text"></textarea></p></div>
  <h2 class="sec">Export</h2>
  <div class="card"><p><strong>Save a small summary.</strong> The raw export is large and slow to read. The summary (daily numbers, sleeps, workouts, weights and heart-rate detail for the last 90 days) is typically under a few MB. Load it next time with "Load a saved summary" and skip the ZIP. Older heart-rate days keep only their daily totals. The file stays on your device.</p>
  <div class="row"><button class="primary" id="dt-sum">Download summary (.json)</button></div>
  <p class="note">Each chart also has a PNG button.</p></div>`;
  const bad = [].concat(m.errors.map(e => ['unreadable', e.path, e.msg]), m.unknown.map(u => ['not recognised', u.path, u.why]), (m.warnings || []).map(w => ['partly read', w.path, w.msg]));
  $('#dt-bad').innerHTML = bad.length ? `<p class="note">${fmt(m.errorCount)} unreadable, ${fmt(m.unknownCount)} not recognised${bad.length < m.errorCount + m.unknownCount + (m.warnings || []).length ? ' (first ' + bad.length + ' shown)' : ''}${(m.warnings || []).length ? ', ' + fmt(m.warnings.length) + ' partly read' : ''}.</p><div class="tw"><table><tbody>${bad.map(b => `<tr><td><span class="pill">${b[0]}</span></td><td class="mono">${esc(b[1])}</td><td class="muted">${esc(b[2])}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">None. Every file in the ZIP was either read or deliberately skipped.</p>';
  const txt = diagnosticText(); $('#dt-text').value = txt;
  $('#dt-copy').onclick = async () => {
    let ok = false; try { await navigator.clipboard.writeText(txt); ok = true; } catch (e) { try { const t = $('#dt-text'); t.focus(); t.select(); ok = document.execCommand('copy'); } catch (e2) {} }
    $('#dt-copied').textContent = ok ? 'Copied (' + txt.length + ' characters).' : 'Copy was blocked. Select the text below and copy it manually.';
  };
  $('#dt-dl').onclick = () => download(new Blob([txt], { type: 'text/plain' }), 'fitbit-viewer-diagnostics.txt');
  $('#dt-sum').onclick = () => download(new Blob([JSON.stringify(exportSummary())], { type: 'application/json' }), 'fitbit-summary.json');
};
// ---------- summary export / import ----------
function b64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
function unb64(s) { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
function exportSummary() {
  const r = S.raw, h = r.hr, N = h.days.length, keep = Math.min(N, 90), order = Array.from(h.days).map((d, i) => [d, i]).sort((a, b) => a[0] - b[0]);
  const recent = order.slice(order.length - keep), old = order.slice(0, order.length - keep), hrDaily = Object.assign({}, r.hrDaily || {});
  for (const [d, i] of old) { let n = 0, s = 0, mn = 255, mx = 0; for (let b = 0; b < 288; b++) { const c = h.c[i * 288 + b]; if (c) { n += c; s += h.s[i * 288 + b]; mn = Math.min(mn, h.mn[i * 288 + b]); mx = Math.max(mx, h.mx[i * 288 + b]); } } if (n) hrDaily[P.dayKey(d)] = [n, s, mn, mx]; }
  const s32 = new Uint32Array(keep * 288), c16 = new Uint16Array(keep * 288), mn8 = new Uint8Array(keep * 288), mx8 = new Uint8Array(keep * 288);
  recent.forEach(([d, i], j) => { s32.set(h.s.subarray(i * 288, i * 288 + 288), j * 288); c16.set(h.c.subarray(i * 288, i * 288 + 288), j * 288); mn8.set(h.mn.subarray(i * 288, i * 288 + 288), j * 288); mx8.set(h.mx.subarray(i * 288, i * 288 + 288), j * 288); });
  const m = r.meta, bin = new Uint8Array(keep * 288 * 8); bin.set(new Uint8Array(s32.buffer), 0); bin.set(new Uint8Array(c16.buffer), keep * 288 * 4); bin.set(mn8, keep * 288 * 6); bin.set(mx8, keep * 288 * 7);
  return { format: 'fitbit-export-viewer-summary', version: 1, created: new Date().toISOString(), app: VERSION, daily: r.daily, sleeps: r.sleeps, exercises: r.exercises, weights: r.weights, bodyfat: r.bodyfat || [],
    hrDaily, hrDays: recent.map(x => x[0]), hrBins: b64(bin), meta: { sources: m.sources, distUnit: m.distUnit, distNote: m.distNote, types: m.types, typeLabels: m.typeLabels, files: m.files, dataFiles: m.dataFiles, skippedByGroup: m.skippedByGroup || {}, unknown: m.unknown, unknownCount: m.unknownCount, errors: m.errors, errorCount: m.errorCount, warnings: m.warnings, diag: m.diag, firstDate: m.firstDate, lastDate: m.lastDate, parseMs: m.parseMs } };
}
async function importSummary(file) {
  try {
    const j = JSON.parse(await file.text());
    if (j.format !== 'fitbit-export-viewer-summary') throw new Error('This JSON file was not saved by this viewer. For a Takeout export, choose the ZIP instead.');
    const n = (j.hrDays || []).length, bin = n ? unb64(j.hrBins) : new Uint8Array(0), cp = (a, b) => bin.slice(a, b).buffer;
    const hr = { days: Int32Array.from(j.hrDays || []), s: new Uint32Array(cp(0, n * 288 * 4)), c: new Uint16Array(cp(n * 288 * 4, n * 288 * 6)), mn: new Uint8Array(cp(n * 288 * 6, n * 288 * 7)), mx: new Uint8Array(cp(n * 288 * 7, n * 288 * 8)), samples: 0 };
    S.groups = null; S.timings = {}; setData({ daily: j.daily || {}, sleeps: j.sleeps || [], exercises: j.exercises || [], weights: j.weights || [], bodyfat: j.bodyfat || [], hr, hrDaily: j.hrDaily || {}, meta: Object.assign({ files: 0, dataFiles: 0, unknown: [], errors: [], warnings: [], diag: [], types: {}, typeLabels: {}, skippedByGroup: {} }, j.meta || {}) });
  } catch (e) { showError('Could not load that summary', String(e && e.message || e)); }
}

// ---------- settings ----------
(function initSettings() {
  const tz = $('#set-tz'); tz.innerHTML = TZS.map(([v, l]) => `<option value="${v}">${v === 'browser' ? 'This device (' + esc(browserTz) + ')' : esc(l)}</option>`).join('');
  tz.value = S.settings.tz; $('#set-wunit').value = S.settings.wunit; $('#set-wsrc').value = S.settings.wsrc; $('#set-dunit').value = S.settings.dunit;
  $('#btn-settings').onclick = e => { const s = $('#settings'); s.hidden = !s.hidden; e.currentTarget.setAttribute('aria-expanded', String(!s.hidden)); };
  $('#btn-theme').onclick = () => { S.settings.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; saveSettings(); applyTheme(); if (S.model) { S.dirty = {}; renderTab(S.tab); } };
  const upd = (k, rebuildNeeded) => e => { S.settings[k] = e.target.value; saveSettings(); if (!S.raw) return; if (rebuildNeeded) { const r = S.range; S.dirty = {}; S.model = A.buildModel(S.raw, { tz: effTz(), weightSource: S.settings.wsrc }); S.range = r; stage('results'); } S.dirty = {}; renderTab(S.tab); };
  tz.onchange = upd('tz', true); $('#set-wsrc').onchange = upd('wsrc', true); $('#set-wunit').onchange = upd('wunit'); $('#set-dunit').onchange = upd('dunit');
})();
if (window.matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener && matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (!S.settings.theme) applyTheme(); });
applyTheme();

window.FBApp = { state: S, get charts() { return S.charts; }, A, P, showTab, setRange: (f, t) => setRange(f, t, null), setPreset, exportSummary, diagnosticText, loadSummaryFile: importSummary };
})();
