# Fitbit / Google Health export viewer

Pick your Google Takeout Fitbit export (the ZIP, 100+ MB is fine) and get interactive charts for sleep, heart rate,
activity, body metrics and a few descriptive patterns. Works on desktop and phone.

**Privacy.** Everything runs in your browser. The ZIP is read from your disk in 1 MB slices by a Web Worker, nothing is uploaded, nothing is
stored remotely, there is no analytics and no cookie. The page ships a Content-Security-Policy that forbids every network origin except
itself, and the test-suite blocks and counts all non-origin requests (zero seen). Charts are descriptive summaries of your own numbers, not medical advice.

## How it handles 100+ MB ZIPs

- Reads the ZIP central directory from the end of the file, then inflates one entry at a time (fflate streaming `Inflate`) from `File.slice` chunks. The whole ZIP is never in memory. ZIP64 is supported. Truncated ZIPs fall back to a sequential local-header scan.
- Entries of data types you untick on the options screen are never read at all.
- Intraday heart rate (the bulk of a real export) is aggregated on the fly into 5-minute bins (count, sum, min, max), raw samples are discarded.
- Parsing happens in a Web Worker, the UI thread only draws the progress bar (file name, percentage, count, elapsed time) and has a Cancel button.
- Time zone: heart-rate timestamps are bucketed in UTC 5-minute bins and re-binned into local days in the browser for the zone you pick in Settings (default: your device). "No conversion" is available for exports whose times are already local.

## What it recognises

Files are matched by folder + file-name pattern, not exact paths, so renamed folders (`Global Export Data`, `Physical Activity`, `Google Data/...`) and date suffixes are tolerated. JSON arrays (including pretty-printed ones) and CSV are both handled, with several timestamp formats (`MM/DD/YY HH:MM:SS`, ISO 8601 with or without `Z`/offset, `YYYY-MM-DD`).

| Data | Legacy JSON layout (`Takeout/Fitbit/...`) | Newer CSV layout (`Google Data/...`) |
|---|---|---|
| Steps, calories, distance, floors, active/sedentary minutes | `steps-*.json`, `calories-*.json`, `distance-*.json`, `floors-*.json`, `*_active_minutes-*.json`, `sedentary_minutes-*.json` | `steps_*.csv`, `calories_*.csv`, `distance_*.csv`, `active_minutes_*.csv`, ... |
| Intraday heart rate | `heart_rate-*.json` (`dateTime`, `value.bpm`, `value.confidence`) | `heart_rate_*.csv` (`timestamp,beats per minute,data source`) |
| Resting HR, time in HR zones, VO2 max | `resting_heart_rate-*.json`, `time_in_heart_rate_zones-*.json`, `demographic_vo2_max-*.json` | `daily_resting_heart_rate*.csv`, `demographic_vo2max*.csv` |
| Sleep, stages, score | `sleep-*.json` (`levels.summary`, `dateOfSleep`), `sleep_score.csv` | `UserSleeps_*`, `UserSleepStages_*`, `UserSleepScores_*` (extensionless CSV) |
| Workouts | `exercise-N.json`, Active Zone Minutes CSV | `UserExercises_*` |
| Weight, body fat | `weight-*.json` | `weight*.csv` |
| SpO2, HRV, respiratory rate, skin temperature | `Daily SpO2`, `Heart Rate Variability` (Daily Summary), `Daily Respiratory Rate Summary`, temperature CSVs | `daily_oxygen_saturation_*`, `daily_heart_rate_variability*`, `daily_respiratory_rate*`, `body_temperature_*` |
| Stress, readiness | `Stress Score`, `Daily Readiness Score` CSVs | n/a |

Anything else is listed on the **Data** tab as "not recognised" (with its CSV column headers or JSON key names), and files that fail to parse are listed under "Files I could not read" with the reason. Nothing aborts the load.

### Sources for the formats (honest caveat)

The layouts were reconstructed from third-party documentation and community importers, not from a real personal export (there is no public one):

- Google Help, "How do I export my Fitbit data?" https://support.google.com/fitbit/answer/14236615
- "Parsing Fitbit HR from Google Takeout" https://medium.com/@abhik.ch6/parsing-fitbit-hr-from-google-takeout-9d9e98ce6aee
- Community Fitbit Takeout importer (field names for sleep, heart rate) https://github.com/mikepsinn/optimitron/blob/main/packages/data/src/importers/fitbit.ts
- TrackerSync guides on Fitbit sleep/CSV exports https://trackersync.app/guides/fitbit-sleep-data-export

`tools/gen_fixtures.py` writes synthetic exports that follow those descriptions faithfully (including the quirks: pretty-printed ` : ` JSON, per-5-second HR, Z-timestamped CSV rows, extensionless CSV, ZIP64). Passing the tests proves the parser agrees with the documented shape, not that Google never changes it.

### If your export is not recognised

Open the **Data** tab, press **Copy diagnostics** and send the text to whoever maintains the tool. It contains file names, row counts, CSV column headers and JSON key names only, never values. The parser rules are small pattern tables in `public/js/parse-core.js`.

## Views

Overview (stat cards, 7/30/90 day vs previous period), Sleep (duration, stacked stages, bedtime scatter, efficiency, weekday vs weekend), Heart (resting HR, daily min/avg/max band, zone minutes, HRV, single-day intraday viewer), Activity (steps, distance, active zone minutes, workouts filterable by type, weekly volume, steps heatmap calendar), Body (weight, SpO2, respiratory rate, skin temperature, VO2 max), Patterns (weekday patterns, sleep vs next-day resting HR, moving averages), Data (what was found, diagnostics, processed-summary export). Each chart has a PNG button. A small processed summary (`fitbit-summary.json`, about 1 MB) can be downloaded and re-opened later without the ZIP (it keeps daily values and recent heart-rate detail only).

## Tests

```
pip install numpy && npm install && npx playwright install chromium webkit
npm run gen                 # fixtures/ (json, csv, missing+corrupt, zip64, 150 MB)
npm run test:unit           # parser vs independently computed expectations
node tests/e2e.mjs --big    # Playwright: Desktop Chromium, iPhone 14 (WebKit), Pixel 7
node tests/e2e.mjs --base https://<live-url>/ --label live
```

The generator simulates a person for 2+ years (steps, sleep with stages, per-5-second HR files, exercises, weight, SpO2, HRV, ...) and writes the expected aggregates computed independently of the parser (`*.expected.json`). The e2e suite loads each ZIP through the file input and asserts the numbers shown on screen (average steps, best day, resting HR, sleep, night count, workout counts per type, intraday HR sample count/min/avg/max for a chosen day), that every chart canvas is painted, the progress UI, error handling for junk and truncated ZIPs, deselecting types, cancel, summary export/import, no horizontal overflow, and that no non-origin request is made.

Measured on the 150 MB ZIP (1,950 days, 2,880 entries, 31.9M HR samples), this Linux box, headless:

| Device profile | Parse time | Peak single browser process | Max UI frame gap |
|---|---|---|---|
| Desktop Chromium | 26 s | 247 MB | 17 ms |
| iPhone 14 viewport, WebKit | 41 s | 628 MB (baseline of an idle WebKit page here was already ~640 MB across processes) | 40 ms |
| Pixel 7 viewport, Chromium, 4x CPU throttle on the main thread | 25 s | 251 MB | 19 ms |

Limitations of that measurement: emulation changes viewport and user agent, not memory limits or CPU speed of a real phone, and the CDP CPU throttle does not slow the worker. Expect a real phone to take several times longer on a 150 MB export; the progress bar and Cancel button keep working. Real iOS Safari was not tested.

## Known limitations

- Layouts are reconstructed from documentation (see above), not verified against a real export.
- CSV rows with `Z` timestamps for daily metrics are bucketed per UTC day, so a day boundary can be off by the UTC offset.
- Distance and weight units are guessed (override in Settings).
- Only the most recent heart-rate days are kept in the exported summary.

## Deploy

Static site, no build: publish directory `public`.

Licence: MIT. Vendored libraries: see THIRD-PARTY.md.
