#!/usr/bin/env python3
"""
Synthetic Google Takeout "Fitbit" export generator + independent expected values.

The layouts imitate what third-party documentation describes (see README, "Formats"):
  json     legacy layout: Takeout/Fitbit/{Global Export Data,Sleep,Heart Rate Variability,...}  (JSON + CSV mix)
  csv      newer "Google Data" layout: date-suffixed CSVs + extensionless Health Fitness Data tables
  missing  json layout with whole data types absent and a handful of corrupt files
  big      json layout, ~1,100+ daily per-5-second heart-rate files, ~150 MB zipped
  zip64    json layout written with ZIP64 entries

ZIPs are written to a NON-seekable stream so every entry uses a data descriptor, like a streamed Takeout.
For each fixture an `<name>.expected.json` is written. Its numbers are computed here from the model and
from the emitted samples, never by the parser under test. Timezone of the simulated person: Europe/Berlin.
Heart-rate timestamps are emitted in UTC (as documented for the legacy export); other legacy files use
local wall-clock time; Google-Data CSVs use real UTC with a Z suffix.
"""
import argparse, json, math, os, sys, zipfile, datetime as dt
from zoneinfo import ZoneInfo
import numpy as np

BER = ZoneInfo('Europe/Berlin')
END = dt.date(2026, 10, 19)
EPOCH = dt.date(1970, 1, 1)


class NonSeekable:
    def __init__(self, f): self.f = f; self.pos = 0
    def write(self, b): self.f.write(b); self.pos += len(b); return len(b)
    def tell(self): return self.pos
    def flush(self): self.f.flush()


def local_epoch(naive):  # naive local datetime -> UTC epoch seconds
    return int(naive.replace(tzinfo=BER).timestamp())

def off_at(t):  # Berlin UTC offset (seconds) at epoch t
    return int(dt.datetime.fromtimestamp(t, BER).utcoffset().total_seconds())

def us_dt(d): return d.strftime('%m/%d/%y %H:%M:%S')
def us_d(d): return d.strftime('%m/%d/%y')
def iso_z(t): return dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
def day_s(d): return d.isoformat()
def pretty(o): return json.dumps(o, indent=2, separators=(',', ' : '))


class Model:
    def __init__(self, seed, days):
        r = self.rng = np.random.default_rng(seed)
        self.days = [END - dt.timedelta(days=days - 1 - i) for i in range(days)]
        self.day = {}
        n = days
        for i, d in enumerate(self.days):
            we = d.weekday() >= 5
            steps = int(max(900, r.lognormal(math.log(8800 if not we else 7600), 0.38)))
            inbed = float(np.clip(r.normal(452 + (18 if we else 0), 48), 300, 600))
            bed_off = r.normal(0, 48) + (55 if we else 0)  # minutes after 23:00 on previous evening
            st = dt.datetime.combine(d - dt.timedelta(days=1), dt.time(23, 0)) + dt.timedelta(minutes=float(bed_off))
            st = st.replace(second=0, microsecond=0)
            inbed = int(round(inbed))
            en = st + dt.timedelta(minutes=inbed)
            wake = int(round(inbed * r.uniform(.06, .11))); deep = int(round(inbed * r.uniform(.12, .2)))
            rem = int(round(inbed * r.uniform(.17, .25))); light = inbed - wake - deep - rem
            asleep = deep + light + rem
            has_sleep = r.random() > 0.04
            rhr = round(57.0 + (7.5 - asleep / 60) * 1.4 + r.normal(0, .8), 1)
            self.day[d] = dict(i=i, we=we, steps=steps, has_sleep=has_sleep, st=st, en=en, inbed=inbed, wake=wake, deep=deep, rem=rem,
                               light=light, asleep=asleep, eff=int(round(asleep / inbed * 100 + 8)), rhr=rhr,
                               rhr_missing=r.random() < 0.03,
                               spo2=round(float(r.normal(96.4, .8)), 1), spo2_ok=r.random() > .06,
                               hrv=round(float(38 + (asleep / 60 - 7) * 3 + r.normal(0, 4)), 1), resp=round(float(r.normal(14.6, .6)), 1),
                               temp=round(float(r.normal(34.6, .35)), 2), vo2=round(46 + i * 0.004 + float(r.normal(0, .3)), 1),
                               lightly=int(150 + steps / 90 + r.normal(0, 15)), moderately=int(max(0, steps / 700 + r.normal(0, 4))),
                               very=int(max(0, steps / 1500 + r.normal(0, 3))), floors=int(max(0, steps / 900 + r.normal(0, 2))),
                               stress=int(np.clip(r.normal(70, 8), 20, 100)), readiness=int(np.clip(r.normal(72, 10), 20, 100)),
                               nap=r.random() < .05)
            x = self.day[d]
            x['sedentary'] = 1440 - x['lightly'] - x['moderately'] - x['very'] - inbed
            x['score'] = int(np.clip(58 + (asleep / 60 - 6.5) * 9 + r.normal(0, 4), 30, 98))
            # exercise
            x['ex'] = None
            if r.random() < .36:
                name = str(r.choice(['Run', 'Walk', 'Bike', 'Workout', 'Swim', 'Weights'], p=[.28, .26, .16, .12, .08, .10]))
                dur = int(r.integers(25, 71)); h0 = dt.datetime.combine(d, dt.time(int(r.integers(17, 20)), int(r.integers(0, 60)), int(r.integers(0, 60))))
                hr = int(r.integers(122, 162))
                dist = round(float(r.uniform(4, 9)) * (dur / 45), 2) if name in ('Run', 'Walk', 'Bike') else None
                x['ex'] = dict(name=name, dur=dur, start=h0, hr=hr, cal=int(dur * r.uniform(7, 11)), dist=dist,
                               steps=int(dur * 150) if name in ('Run', 'Walk') else None, id=int(r.integers(10**10, 10**11)))
            x['weight'] = round(float(182 - 0.012 * i + 1.2 * math.sin(i / 21) + r.normal(0, .7)), 1) if i % 3 == 0 else None
        # sleep windows (epoch) for HR synthesis
        ds = [d for d in self.days if self.day[d]['has_sleep']]
        self.sl_st = np.array([local_epoch(self.day[d]['st']) for d in ds]); self.sl_en = np.array([local_epoch(self.day[d]['en']) for d in ds])
        self.sl_rhr = np.array([self.day[d]['rhr'] for d in ds])
        ex = [self.day[d]['ex'] for d in self.days if self.day[d]['ex']]
        self.ex_st = np.array([local_epoch(e['start']) for e in ex]); self.ex_en = self.ex_st + np.array([e['dur'] * 60 for e in ex]); self.ex_hr = np.array([e['hr'] for e in ex])

    def hr_samples(self, utc_day_idx, step):
        """-> (t epoch array, bpm int array, conf array) for one UTC day."""
        r = self.rng
        t0 = utc_day_idx * 86400
        t = t0 + np.arange(0, 86400, step)
        keep = r.random(len(t)) > 0.03
        if r.random() < .3:
            a = int(r.integers(0, len(t) - 2400 // step * 2)); keep[a:a + (3600 * 2 // step)] = False
        t = t[keep]
        off = off_at(t0 + 43200)
        h = ((t + off) % 86400) / 3600.0
        base = 71 + 9 * np.sin(2 * np.pi * (h - 9) / 24)
        eps = r.normal(0, 1, len(t) + 8); eps = np.convolve(eps, np.ones(8) / 8, 'valid')[:len(t)] * 9
        v = base + eps
        if len(self.sl_st):
            idx = np.searchsorted(self.sl_st, t, 'right') - 1
            ok = (idx >= 0)
            idc = np.clip(idx, 0, None)
            sl = ok & (t < self.sl_en[idc])
            v = np.where(sl, self.sl_rhr[idc] + 1 + eps * .45, v)
        if len(self.ex_st):
            j = np.searchsorted(self.ex_st, t, 'right') - 1; jc = np.clip(j, 0, None)
            inx = (j >= 0) & (t < self.ex_en[jc])
            v = np.where(inx, self.ex_hr[jc] + eps * .9, v)
        bpm = np.clip(np.rint(v), 40, 185).astype(np.int64)
        conf = np.where(r.random(len(t)) < .8, 3, r.integers(0, 3, len(t)))
        return t, bpm, conf


class Out:
    """ZIP writer on a non-seekable stream + bookkeeping of what was emitted."""
    def __init__(self, path, zip64=False, level=6):
        self.fh = open(path, 'wb'); self.zf = zipfile.ZipFile(NonSeekable(self.fh), 'w', zipfile.ZIP_DEFLATED, compresslevel=level)
        self.zip64 = zip64; self.paths = []; self.root = 'Takeout/Fitbit/'
    def add(self, rel, data):
        if isinstance(data, str): data = data.encode('utf-8')
        zi = zipfile.ZipInfo(self.root + rel if not rel.startswith('Takeout/') else rel, (2026, 10, 19, 12, 0, 0)); zi.compress_type = zipfile.ZIP_DEFLATED
        with self.zf.open(zi, 'w', force_zip64=self.zip64) as w:
            for i in range(0, len(data), 1 << 22): w.write(data[i:i + (1 << 22)])
        self.paths.append(zi.filename)
    def add_stream(self, rel, chunks):
        zi = zipfile.ZipInfo(self.root + rel, (2026, 10, 19, 12, 0, 0)); zi.compress_type = zipfile.ZIP_DEFLATED
        with self.zf.open(zi, 'w', force_zip64=self.zip64) as w:
            for c in chunks: w.write(c.encode())
        self.paths.append(zi.filename)
    def close(self): self.zf.close(); self.fh.close()


def chunks30(days):
    return [days[i:i + 30] for i in range(0, len(days), 30)]


def build(variant, out_path, days, seed, hr_5s_days=30, zip64=False, hr_step_old=60, hr_noise=False):
    m = Model(seed, days)
    o = Out(out_path, zip64=zip64, level=6 if variant != 'big' else 4)
    csv_layout = variant == 'csv'
    missing = variant == 'missing'
    skip = {'sleep', 'weight', 'spo2', 'hrv', 'temp'} if missing else set()
    ex = dict(variant=variant, tz='Europe/Berlin', startDate=day_s(m.days[0]), endDate=day_s(m.days[-1]), dayCount=days, daily={}, sleeps=[],
              exercises=[], weights=[], hrUtc={}, hrLocal={}, corrupt=[], missingTypes=sorted(skip), unknown=[], notes=[])
    D = lambda d: ex['daily'].setdefault(day_s(d), {})
    ds = m.days

    # ---------- HR ----------
    corrupt_hr_html = ds[10]; corrupt_hr_trunc = ds[200] if days > 220 else ds[-5]
    first_utc = (local_epoch(dt.datetime.combine(ds[0], dt.time(0))) // 86400)
    last_utc = (local_epoch(dt.datetime.combine(ds[-1], dt.time(23, 59))) // 86400)
    hr_n = 0
    for ui in range(first_utc, last_utc + 1):
        d = EPOCH + dt.timedelta(days=ui)
        recent = (last_utc - ui) < hr_5s_days
        step = 5 if (recent or variant == 'big') else hr_step_old
        t, bpm, conf = m.hr_samples(ui, step)
        if len(t) == 0: continue
        name_d = day_s(d)
        if csv_layout:
            lines = ['timestamp,beats per minute,data source'] + ['%s,%d,Fitbit' % (iso_z(int(a)), b) for a, b in zip(t.tolist(), bpm.tolist())]
            body = '\n'.join(lines) + '\n'
            rel = 'Google Data/Physical Activity/heart_rate_%s.csv' % name_d
            emit_n = len(t)
        else:
            base = ui * 86400; pfx = d.strftime('%m/%d/%y ')
            secs = (t - base).tolist()
            tab = '%02d:%02d:%02d'
            items = ['{"dateTime" : "%s%02d:%02d:%02d","value" : {"bpm" : %d,"confidence" : %d}}' % (pfx, s // 3600, s % 3600 // 60, s % 60, b, c) for s, b, c in zip(secs, bpm.tolist(), conf.tolist())]
            rel = 'Global Export Data/heart_rate-%s.json' % name_d
            emit_n = len(items)
            if missing and d == corrupt_hr_html:
                o.add(rel, '<html><body>Service temporarily unavailable</body></html>'); ex['corrupt'].append(o.paths[-1]); continue
            if missing and d == corrupt_hr_trunc:
                keep = max(10, len(items) // 3); body = '[' + ','.join(items[:keep]) + ',{"dateTime" : "' + pfx + '12:0'  # cut mid-record
                t = t[:keep]; bpm = bpm[:keep]; emit_n = keep; ex['corrupt'].append('Takeout/Fitbit/' + rel + '  (truncated, %d complete records)' % keep)
            else:
                body = '[' + ','.join(items) + ']'
        o.add(rel, body)
        # expected HR stats (independent of parser): per UTC day and per Berlin day
        hr_n += len(t)
        ex['hrUtc'][name_d] = [int(len(t)), int(bpm.sum()), int(bpm.min()), int(bpm.max())]
        off = np.array([off_at(int(x)) for x in (t[0], t[-1])])
        if off[0] == off[1]: loc = t + off[0]
        else:  # DST switch inside this UTC day (01:00 UTC)
            loc = t + np.where(t < ui * 86400 + 3600, off[0], off[1])
        ld = loc // 86400
        for k in np.unique(ld):
            sel = ld == k; b = bpm[sel]; key = day_s(EPOCH + dt.timedelta(days=int(k)))
            a = ex['hrLocal'].get(key)
            if a: a[0] += int(sel.sum()); a[1] += int(b.sum()); a[2] = min(a[2], int(b.min())); a[3] = max(a[3], int(b.max()))
            else: ex['hrLocal'][key] = [int(sel.sum()), int(b.sum()), int(b.min()), int(b.max())]
    ex['hrSamples'] = hr_n

    # ---------- steps / calories / distance (per-minute or coarser) ----------
    r = m.rng
    step_chunks = chunks30(ds); cal_utc = {}
    for ch in step_chunks:
        steps_e, dist_e, cal_e = [], [], []; csv_steps = ['timestamp,steps,data source']; csv_dist = ['timestamp,millimeters,data source']; csv_cal = ['timestamp,calories,data source']
        for d in ch:
            x = m.day[d]; S = x['steps']
            k = min(900, S // 12 + 30); mins = np.sort(r.choice(np.arange(7 * 60, 22 * 60), size=k, replace=False))
            w = r.dirichlet(np.ones(k) * .7); parts = np.floor(w * S).astype(int); parts[0] += S - parts.sum()
            D(d)['steps'] = S; tot_cal = 0.0
            dist_cm = 0
            for mi, p in zip(mins.tolist(), parts.tolist()):
                ts = dt.datetime.combine(d, dt.time(mi // 60, mi % 60))
                if csv_layout:
                    tu = local_epoch(ts); csv_steps.append('%s,%d,Fitbit' % (iso_z(tu), p)); csv_dist.append('%s,%d,Fitbit' % (iso_z(tu), p * 700))
                else:
                    steps_e.append({'dateTime': us_dt(ts), 'value': str(p)}); dist_e.append({'dateTime': us_dt(ts), 'value': str(p * 70)})
                dist_cm += p * 70
            for q in range(96):  # 15-minute calorie records
                c = round(float((x['steps'] * 0.045 + 1500) / 96 * (1.6 if 28 <= q < 88 else 0.55)), 2); tot_cal += c
                ts = dt.datetime.combine(d, dt.time(q // 4, (q % 4) * 15))
                if csv_layout:
                    ue = local_epoch(ts); csv_cal.append('%s,%.2f,Fitbit' % (iso_z(ue), c)); ku = day_s(EPOCH + dt.timedelta(days=ue // 86400)); cal_utc[ku] = round(cal_utc.get(ku, 0) + c, 2)
                else: cal_e.append({'dateTime': us_dt(ts), 'value': '%.2f' % c})
            D(d)['calories'] = round(tot_cal, 2) if not csv_layout else None; D(d)['distance'] = round(dist_cm / 1e5, 3)
        n0 = day_s(ch[0])
        if csv_layout:
            o.add('Google Data/Physical Activity/steps_%s.csv' % n0, '\n'.join(csv_steps) + '\n'); o.add('Google Data/Physical Activity/distance_%s.csv' % n0, '\n'.join(csv_dist) + '\n')
            o.add('Google Data/Physical Activity/calories_%s.csv' % n0, '\n'.join(csv_cal) + '\n')
        else:
            o.add('Global Export Data/steps-%s.json' % n0, pretty(steps_e)); o.add('Global Export Data/distance-%s.json' % n0, pretty(dist_e))
            o.add('Global Export Data/calories-%s.json' % n0, pretty(cal_e))
    for k_, v_ in cal_utc.items():
        if k_ in ex['daily']: ex['daily'][k_]['calories'] = v_
    for v_ in ex['daily'].values():
        if v_.get('calories', 0) is None: v_.pop('calories')
    # daily activity minutes + zones + rhr + vo2 (JSON) or CSV
    for ch in step_chunks:
        n0 = day_s(ch[0]); lt, md, vy, sd, fl, rh, zn, vo = [], [], [], [], [], [], [], []
        csv_rhr = ['timestamp,beats per minute']; csv_am = ['timestamp,light,moderate,vigorous']
        for d in ch:
            x = m.day[d]; ts = us_dt(dt.datetime.combine(d, dt.time(0)))
            D(d).update(lightly=x['lightly'], moderately=x['moderately'], very=x['very'], floors=x['floors'], sedentary=x['sedentary'])
            if csv_layout: csv_am.append('%sT00:00:00Z,%d,%d,%d' % (day_s(d), x['lightly'], x['moderately'], x['very']))
            else:
                lt.append({'dateTime': ts, 'value': str(x['lightly'])}); md.append({'dateTime': ts, 'value': str(x['moderately'])}); vy.append({'dateTime': ts, 'value': str(x['very'])})
                sd.append({'dateTime': ts, 'value': str(x['sedentary'])}); fl.append({'dateTime': ts, 'value': str(x['floors'])})
            if not x['rhr_missing']:
                D(d)['rhr'] = x['rhr']
                if csv_layout: csv_rhr.append('%sT00:00:00Z,%s' % (day_s(d), x['rhr']))
                else: rh.append({'dateTime': ts, 'value': {'date': us_d(d), 'value': x['rhr'], 'error': 2.1}})
            elif not csv_layout: rh.append({'dateTime': ts, 'value': {'date': us_d(d), 'value': None, 'error': 0.0}})
            zo = int(1440 - x['inbed'] - 200 - x['moderately'] * 3); zf = 140 + x['lightly'] // 4 ; zc = x['moderately'] * 2 + 4; zp = x['very'] // 2
            for k_, v_ in (('zOut', zo), ('zFat', zf), ('zCardio', zc), ('zPeak', zp)): D(d)[k_] = v_
            zn.append({'dateTime': ts, 'value': {'valuesInZones': {'IN_DEFAULT_ZONE_1': float(zf), 'IN_DEFAULT_ZONE_2': float(zc), 'IN_DEFAULT_ZONE_3': float(zp), 'BELOW_DEFAULT_ZONE_1': float(zo)}}})
            if d.weekday() == 0:
                D(d)['vo2'] = x['vo2']
                vo.append({'dateTime': ts, 'value': {'demographicVO2Max': x['vo2'], 'demographicVO2MaxError': 2.0, 'filteredDemographicVO2Max': x['vo2'], 'filteredDemographicVO2MaxError': 2.0}})
        if csv_layout:
            P = 'Google Data/Physical Activity/'
            o.add(P + 'active_minutes_%s.csv' % n0, '\n'.join(csv_am) + '\n')
            if ch is step_chunks[0]: pass
            o.add(P + 'daily_resting_heart_rate_%s.csv' % n0 if False else P + 'daily_resting_heart_rate.csv' if ch is step_chunks[0] else P + 'daily_resting_heart_rate_%s.csv' % n0, '\n'.join(csv_rhr) + '\n') if False else None
            ex['_csv_rhr'] = ex.get('_csv_rhr', []) + csv_rhr[1:]
            ex['_csv_vo2'] = ex.get('_csv_vo2', []) + ['%sT00:00:00Z,%s' % (day_s(d), m.day[d]['vo2']) for d in ch if d.weekday() == 0]
        else:
            G = 'Global Export Data/'
            for nm, arr in (('lightly_active_minutes', lt), ('moderately_active_minutes', md), ('very_active_minutes', vy), ('sedentary_minutes', sd), ('floors', fl), ('resting_heart_rate', rh), ('time_in_heart_rate_zones', zn), ('demographic_vo2_max', vo)):
                o.add(G + '%s-%s.json' % (nm, n0), pretty(arr))
            o.add(G + 'altitude-%s.json' % n0, pretty([{'dateTime': us_dt(dt.datetime.combine(ch[0], dt.time(8))), 'value': '3'}]))
    if csv_layout:
        P = 'Google Data/Physical Activity/'
        o.add(P + 'daily_resting_heart_rate.csv', 'timestamp,beats per minute\n' + '\n'.join(ex.pop('_csv_rhr')) + '\n')
        o.add(P + 'demographic_vo2max.csv', 'timestamp,demographic vo2max\n' + '\n'.join(ex.pop('_csv_vo2')) + '\n')
        # floors for CSV layout are not emitted -> not expected
        for d in ds: ex['daily'][day_s(d)].pop('floors', None); [ex['daily'][day_s(d)].pop(k, None) for k in ('sedentary', 'zOut', 'zFat', 'zCardio', 'zPeak')]

    # ---------- exercises ----------
    exl = [(d, m.day[d]['ex']) for d in ds if m.day[d]['ex']]
    jx = []
    csvx = ['exercise_id,exercise_start,exercise_end,utc_offset,activity_name,log_type,tracker_total_calories,tracker_total_steps,tracker_total_distance_mm,tracker_avg_heart_rate']
    for d, e in exl:
        rec = dict(t=e['start'].strftime('%Y-%m-%dT%H:%M'), name=e['name'], dur=float(e['dur']), cal=e['cal'], hr=e['hr'], steps=e['steps'], dist=e['dist'])
        ex['exercises'].append(rec)
        if csv_layout:
            u = local_epoch(e['start']); csvx.append('%d,%s,%s,%s,%s,auto,%d,%s,%s,%d' % (e['id'], iso_z(u), iso_z(u + e['dur'] * 60), '+%02d:00' % (off_at(u) // 3600), e['name'], e['cal'], e['steps'] if e['steps'] else '', int(e['dist'] * 1e6) if e['dist'] else '', e['hr']))
        else:
            o_ = {'logId': e['id'], 'activityName': e['name'], 'activityTypeId': 90009, 'averageHeartRate': e['hr'], 'calories': e['cal'], 'duration': e['dur'] * 60000, 'activeDuration': e['dur'] * 60000,
                  'logType': 'auto_detected', 'startTime': us_dt(e['start']), 'lastModified': us_dt(e['start']), 'steps': e['steps'] if e['steps'] else 0,
                  'heartRateZones': [{'name': 'Out of Range', 'min': 30, 'max': 98, 'minutes': 1}, {'name': 'Fat Burn', 'min': 98, 'max': 137, 'minutes': e['dur'] // 2}, {'name': 'Cardio', 'min': 137, 'max': 167, 'minutes': e['dur'] // 3}, {'name': 'Peak', 'min': 167, 'max': 220, 'minutes': 0}]}
            if e['dist']: o_['distance'] = e['dist']; o_['distanceUnit'] = 'Kilometer'
            jx.append(o_)
    if csv_layout: o.add('Google Data/Health Fitness Data/UserExercises_%s' % day_s(ds[0]), '\n'.join(csvx) + '\n')
    else:
        for i in range(0, len(jx), 100): o.add('Global Export Data/exercise-%d.json' % i, pretty(jx[i:i + 100]))

    # ---------- sleep ----------
    if 'sleep' not in skip:
        sj = {}; u_sl = ['sleep_id,sleep_type,minutes_in_sleep_period,minutes_asleep,minutes_awake,sleep_start,start_utc_offset,sleep_end,end_utc_offset']
        u_st = ['sleep_id,sleep_stage_type,sleep_stage_start,sleep_stage_end']; u_sc = ['sleep_id,score_time,overall_score,composition_score,revitalization_score,duration_score,deep_sleep_in_minutes,resting_heart_rate,restlessness']
        sc_csv = ['sleep_log_entry_id,timestamp,overall_score,composition_score,revitalization_score,duration_score,deep_sleep_in_minutes,resting_heart_rate,restlessness']
        for d in ds:
            x = m.day[d]
            if not x['has_sleep']: continue
            sid = 40000000000 + x['i'] * 17
            ex['sleeps'].append(dict(date=day_s(d), st=x['st'].strftime('%Y-%m-%dT%H:%M'), en=x['en'].strftime('%Y-%m-%dT%H:%M'), inBed=x['inbed'], asleep=x['asleep'], awake=x['wake'], deep=x['deep'], light=x['light'], rem=x['rem'], wake=x['wake'], eff=x['eff'], main=True, score=x['score']))
            # stage segments
            segs = []; cur = x['st']; order = ['light', 'deep', 'light', 'rem', 'wake'] * 20
            left = dict(deep=x['deep'], light=x['light'], rem=x['rem'], wake=x['wake']); tot = {k: 0 for k in left}
            kinds = ['light', 'deep', 'rem', 'wake']; i = 0
            while sum(left.values()) > 0:
                k = kinds[i % 4] if left[kinds[i % 4]] > 0 else next(q for q in kinds if left[q] > 0)
                ln = min(left[k], int(r.integers(8, 40))); segs.append((k, cur, ln)); cur += dt.timedelta(minutes=ln); left[k] -= ln; i += 1
            if csv_layout:
                us = local_epoch(x['st']); ue = local_epoch(x['en']); o1 = '+%02d:00' % (off_at(us) // 3600); o2 = '+%02d:00' % (off_at(ue) // 3600)
                u_sl.append('%d,stages,%d,%d,%d,%s,%s,%s,%s' % (sid, x['inbed'], x['asleep'], x['wake'], iso_z(us), o1, iso_z(ue), o2))
                for k, c0, ln in segs:
                    k2 = {'light': 'LIGHT', 'deep': 'DEEP', 'rem': 'REM', 'wake': 'AWAKE'}[k]; a = local_epoch(c0); u_st.append('%d,%s,%s,%s' % (sid, k2, iso_z(a), iso_z(a + ln * 60)))
                u_sc.append('%d,%s,%d,%d,%d,%d,%d,%s,%.3f' % (sid, iso_z(ue), x['score'], x['score'] - 3, x['score'] - 5, x['score'] - 2, x['deep'], x['rhr'], 0.1))
            else:
                lv = {'summary': {k: {'count': 4, 'minutes': x[k], 'thirtyDayAvgMinutes': x[k]} for k in ('deep', 'light', 'rem', 'wake')}, 'data': [{'dateTime': c0.strftime('%Y-%m-%dT%H:%M:%S.000'), 'level': k, 'seconds': ln * 60} for k, c0, ln in segs], 'shortData': []}
                rec = {'logId': sid, 'dateOfSleep': day_s(d), 'startTime': x['st'].strftime('%Y-%m-%dT%H:%M:%S.000'), 'endTime': x['en'].strftime('%Y-%m-%dT%H:%M:%S.000'), 'duration': x['inbed'] * 60000,
                       'minutesToFallAsleep': 0, 'minutesAsleep': x['asleep'], 'minutesAwake': x['wake'], 'minutesAfterWakeup': 0, 'timeInBed': x['inbed'], 'efficiency': x['eff'], 'type': 'stages', 'infoCode': 0, 'logType': 'auto_detected', 'levels': lv, 'mainSleep': True}
                sj.setdefault((x['i'] // 30), []).append(rec)
                sc_csv.append('%d,%sT%s.000Z,%d,%d,%d,%d,%d,%s,%.3f' % (sid, day_s(d), x['en'].strftime('%H:%M:%S'), x['score'], x['score'] - 3, x['score'] - 5, x['score'] - 2, x['deep'], x['rhr'], 0.1))
            if x['nap'] and not csv_layout:
                nst = dt.datetime.combine(d, dt.time(14, 10)); rec = {'logId': sid + 1, 'dateOfSleep': day_s(d), 'startTime': nst.strftime('%Y-%m-%dT%H:%M:%S.000'), 'endTime': (nst + dt.timedelta(minutes=35)).strftime('%Y-%m-%dT%H:%M:%S.000'), 'duration': 35 * 60000, 'minutesAsleep': 31, 'minutesAwake': 4, 'timeInBed': 35, 'efficiency': 88, 'type': 'classic', 'logType': 'manual', 'levels': {'summary': {'asleep': {'count': 0, 'minutes': 31}, 'restless': {'count': 4, 'minutes': 4}, 'awake': {'count': 0, 'minutes': 0}}, 'data': []}, 'mainSleep': False}
                sj.setdefault((x['i'] // 30), []).append(rec)
                ex['sleeps'].append(dict(date=day_s(d), st=nst.strftime('%Y-%m-%dT%H:%M'), en=(nst + dt.timedelta(minutes=35)).strftime('%Y-%m-%dT%H:%M'), inBed=35, asleep=31, awake=4, deep=None, light=None, rem=None, wake=None, eff=88, main=False, score=None))
        if csv_layout:
            H = 'Google Data/Health Fitness Data/'
            o.add(H + 'UserSleeps_%s' % day_s(ds[0]), '\n'.join(u_sl) + '\n'); o.add(H + 'UserSleepStages_%s' % day_s(ds[0]), '\n'.join(u_st) + '\n'); o.add(H + 'UserSleepScores_%s' % day_s(ds[0]), '\n'.join(u_sc) + '\n')
        else:
            for k, arr in sj.items(): o.add('Sleep/sleep-%s.json' % day_s(ds[k * 30]), pretty(arr))
            o.add('Sleep/sleep_score.csv', '\n'.join(sc_csv) + '\n')
    # ---------- vitals ----------
    spo, hrv, rsp, tmp, hrvd, azm, stress, ready = ['timestamp,average_value,lower_bound,upper_bound'], ['timestamp,rmssd,nremhr,entropy'], ['timestamp,daily_respiratory_rate'], ['type,sleep_start,sleep_end,temperature_samples,nightly_temperature,baseline_relative_sample_sum,baseline_relative_sample_sum_of_squares,baseline_relative_nightly_standard_deviation,baseline_relative_sample_count'], ['timestamp,rmssd,coverage,low_frequency,high_frequency'], ['date_time,heart_zone_id,total_minutes'], ['DATE,UPDATED_AT,STRESS_SCORE,SLEEP_POINTS,RESPONSIVENESS_POINTS,EXERTION_POINTS,STATUS,CALCULATION_FAILED'], ['date,readiness_score_value,sleep_readiness_score,activity_readiness_score']
    g_spo, g_hrv, g_rsp, g_tmp = ['timestamp,average percentage,lower bound,upper bound'], ['timestamp,root mean square of successive differences milliseconds'], ['timestamp,full sleep stats - milli breaths per minute'], ['timestamp,temperature celsius']
    for d in ds:
        x = m.day[d]; z = day_s(d)
        if x['spo2_ok'] and 'spo2' not in skip:
            D(d)['spo2'] = x['spo2']; D(d)['spo2Min'] = round(x['spo2'] - 2.4, 1); D(d)['spo2Max'] = round(x['spo2'] + 1.4, 1)
            spo.append('%sT00:00:00Z,%s,%s,%s' % (z, x['spo2'], D(d)['spo2Min'], D(d)['spo2Max'])); g_spo.append('%sT04:00:00Z,%s,%s,%s' % (z, x['spo2'], D(d)['spo2Min'], D(d)['spo2Max']))
        if 'hrv' not in skip:
            D(d)['hrv'] = x['hrv']; hrv.append('%sT00:00:00,%s,%.1f,%.3f' % (z, x['hrv'], x['rhr'], 2.1)); g_hrv.append('%sT03:00:00Z,%s' % (z, x['hrv']))
            D(d)['resp'] = x['resp']; rsp.append('%sT00:00:00,%s' % (z, x['resp'])); g_rsp.append('%sT00:00:00Z,%d' % (z, round(x['resp'] * 1000)))
        if 'temp' not in skip:
            D(d)['temp'] = x['temp']; tmp.append('NIGHTLY,%sT23:30:00,%sT07:00:00,300,%s,0,0,0,0' % (day_s(d - dt.timedelta(days=1)), z, x['temp'])); g_tmp.append('%sT05:00:00Z,%s' % (z, x['temp']))
        if not csv_layout:
            D(d)['azmFat'] = x['lightly'] // 10 * 2; D(d)['azmCardio'] = x['moderately'] // 2; D(d)['azmPeak'] = x['very'] // 3
            azm += ['%s,FAT_BURN,%d' % (z, D(d)['azmFat']), '%s,CARDIO,%d' % (z, D(d)['azmCardio']), '%s,PEAK,%d' % (z, D(d)['azmPeak'])]
            D(d)['stress'] = x['stress']; stress.append('%s,%sT08:00:00Z,%d,20,20,20,READY,false' % (z, z, x['stress']))
            D(d)['readiness'] = x['readiness']; ready.append('%s,%d,70,70' % (z, x['readiness']))
    if csv_layout:
        P = 'Google Data/Physical Activity/'
        if 'spo2' not in skip: o.add(P + 'daily_oxygen_saturation_%s.csv' % day_s(ds[0]), '\n'.join(g_spo) + '\n')
        o.add(P + 'daily_heart_rate_variability.csv', '\n'.join(g_hrv) + '\n'); o.add(P + 'daily_respiratory_rate.csv', '\n'.join(g_rsp) + '\n'); o.add(P + 'body_temperature_%s.csv' % day_s(ds[0]), '\n'.join(g_tmp) + '\n')
        for d in ds:
            for k in ('azmFat', 'azmCardio', 'azmPeak', 'stress', 'readiness'): ex['daily'][day_s(d)].pop(k, None)
    else:
        for i, ch in enumerate(chunks30(ds)):
            a, b = 1 + ds.index(ch[0]), 1 + ds.index(ch[-1])
        if 'spo2' not in skip: o.add('Sleep/Daily SpO2 - %s.csv' % day_s(ds[0]), '\n'.join(spo) + '\n')
        if 'hrv' not in skip:
            o.add('Heart Rate Variability/Daily Heart Rate Variability Summary - %s.csv' % day_s(ds[0]), '\n'.join(hrv) + '\n'); o.add('Heart Rate Variability/Daily Respiratory Rate Summary - %s.csv' % day_s(ds[0]), '\n'.join(rsp) + '\n')
        if 'temp' not in skip: o.add('Sleep/Computed Temperature - %s.csv' % day_s(ds[0]), '\n'.join(tmp) + '\n')
        o.add('Physical Activity/Active Zone Minutes - %s.csv' % day_s(ds[0]), '\n'.join(azm) + '\n'); o.add('Stress Score/Stress Score.csv', '\n'.join(stress) + '\n'); o.add('Daily Readiness Score/Daily Readiness Score - %s.csv' % day_s(ds[0]), '\n'.join(ready) + '\n')
    # ---------- weight ----------
    if 'weight' not in skip:
        wl = {}; wc = ['timestamp,weight grams,bmi']
        for d in ds:
            x = m.day[d]
            if x['weight'] is None: continue
            ex['weights'].append(dict(t='%sT07:%02d' % (day_s(d), x['i'] % 60), lb=x['weight'], kg=round(x['weight'] * 0.45359237, 2)))
            if csv_layout: wc.append('%sT%02d:%02d:00Z,%d,%.1f' % (day_s(d), 6, x['i'] % 60, round(x['weight'] * 453.59237), x['weight'] * 0.45359237 / 3.2))
            else: wl.setdefault(x['i'] // 30, []).append({'logId': 1600000000000 + x['i'], 'weight': x['weight'], 'bmi': round(x['weight'] * 0.45359237 / 3.2, 2), 'date': us_d(d), 'time': '07:%02d:00' % (x['i'] % 60), 'source': 'API'})
        if csv_layout: o.add('Google Data/Physical Activity/weight.csv', '\n'.join(wc) + '\n')
        else:
            for k, arr in wl.items(): o.add('Personal & Account/weight-%s.json' % day_s(ds[k * 30]), pretty(arr))
    # ---------- noise: ignored / unknown / corrupt ----------
    o.add('Personal & Account/Profile.csv', 'id,full_name,date_of_birth\n1,Test Person,1990-01-01\n'); o.add('Devices/Devices.csv', 'device_version,type,last_sync_time\nCharge 5,TRACKER,2026-10-19T08:00:00Z\n')
    o.add('Takeout/archive_browser.html', '<html></html>') if False else None
    o.paths.append('Takeout/archive_browser.html'); o.zf.writestr('Takeout/archive_browser.html', '<html>index</html>')
    o.add('Mystery Metrics/glucose_log_2025.csv', 'time,mmol\n2025-01-01T08:00:00Z,5.1\n'); ex['unknown'].append('Takeout/Fitbit/Mystery Metrics/glucose_log_2025.csv')
    if missing:
        o.add('Global Export Data/steps-1999-01-01.json', '{{{not json at all'); ex['corrupt'].append('Takeout/Fitbit/Global Export Data/steps-1999-01-01.json')
        o.add('Global Export Data/calories-1999-01-01.json', ''); ex['corrupt'].append('Takeout/Fitbit/Global Export Data/calories-1999-01-01.json')
        o.add('Physical Activity/Active Zone Minutes - 1999-01-01.csv', 'foo,bar\n1,2\n'); ex['corrupt'].append('Takeout/Fitbit/Physical Activity/Active Zone Minutes - 1999-01-01.csv')
    o.close()
    for k in ex['daily']:
        pass
    # derived summary
    sd_ = ex['daily']; st = [v['steps'] for v in sd_.values() if 'steps' in v]
    ex['summary'] = dict(totalSteps=sum(st), avgSteps=sum(st) / len(st), bestStepsDay=max(sd_.items(), key=lambda kv: kv[1].get('steps', 0))[0], bestSteps=max(st),
                         nights=len([s for s in ex['sleeps'] if s['main']]), avgAsleep=(sum(s['asleep'] for s in ex['sleeps'] if s['main']) / max(1, len([s for s in ex['sleeps'] if s['main']]))),
                         avgRhr=(lambda v: sum(v) / len(v))([v['rhr'] for v in sd_.values() if 'rhr' in v]), workouts=len(ex['exercises']),
                         workoutsByType={n: len([e for e in ex['exercises'] if e['name'] == n]) for n in sorted({e['name'] for e in ex['exercises']})},
                         zipBytes=os.path.getsize(out_path), entries=len(o.paths) + 0)
    json.dump(ex, open(out_path.replace('.zip', '.expected.json'), 'w'), separators=(',', ':'))
    return ex


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='fixtures'); ap.add_argument('--only', default='')
    ap.add_argument('--big-days', type=int, default=1180)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    plan = [('json', 'takeout-json', 780, 1, {}), ('csv', 'takeout-csv', 780, 2, {}), ('missing', 'takeout-missing', 420, 3, {}), ('zip64', 'takeout-zip64', 120, 4, {'zip64': True}), ('big', 'takeout-big', a.big_days, 5, {})]
    for variant, name, days, seed, kw in plan:
        if a.only and name != a.only and a.only != variant: continue
        p = os.path.join(a.out, name + '.zip'); v = 'json' if variant == 'zip64' else variant
        e = build(v, p, days, seed, **kw)
        print(name, '%.1f MB' % (os.path.getsize(p) / 1e6), 'hr samples', e['hrSamples'], flush=True)
