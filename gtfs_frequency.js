#!/usr/bin/env node
/**
 * GTFS → public transport SERVICE FREQUENCY per stop.
 *
 * The point of this row: "400 m to a bus stop" is what a listing site says. It is nearly
 * useless — a stop served six times a day and a stop served every four minutes look identical.
 * This answers the question a renter actually has: how often does anything actually turn up.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ WHAT A HEADWAY NUMBER IS AND IS NOT
 * "Every 9 minutes" here means departures-per-hour averaged across a window, NOT a guaranteed
 * interval. A stop with 14 buses clustered into three bunches averages the same as one with 14
 * evenly spread. The honest rendering is "about every 9 min (7–9am average)" — never a timetable
 * promise, and never "frequent"/"poor" as a verdict, which is a display decision, not data.
 * Weekend counts ship separately BECAUSE the weekday number alone flatters an area badly:
 * plenty of Melbourne stops run every 10 minutes on a Wednesday and 4 times on a Sunday.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Usage: node ingest/gtfs_frequency.js [--feed vic] [--offline]
 */

const fs = require('fs');
const path = require('path');
const { readZip, csvSplit } = require('./lib/zip');

const FEEDS = {
  vic: {
    name: 'Victoria (PTV)',
    url: 'https://opendata.transport.vic.gov.au/dataset/3f4e292e-7f8a-4ffe-831f-1953be0fe448/resource/fb152201-859f-4882-9206-b768060b50ad/download/gtfs.zip',
    cache: 'vic_gtfs.zip',
    out: 'vic-transit-frequency',
    licence: 'CC BY 4.0',
    attribution: 'Based on Public Transport Victoria GTFS data',
    source: 'Department of Transport and Planning Victoria — GTFS Schedule',
    source_url: 'https://discover.data.vic.gov.au/dataset/gtfs-schedule',
    // VIC ships a zip-of-zips, one inner GTFS feed per mode.
    modes: { 1: 'regional train', 2: 'train', 3: 'tram', 4: 'bus', 5: 'coach', 6: 'regional bus', 10: 'bus', 11: 'bus' },
    // ⚠️ Interstate coach routes terminate OUTSIDE Victoria — the feed genuinely contains
    // Adelaide, Canberra and Sydney stops. Serving those from a dataset labelled Victoria
    // would show an Adelaide renter one Sunday coach as if it were their transit service,
    // i.e. fabricated coverage in a state we do not cover. Clipped to the state bounds.
    bbox: { minLat: -39.3, maxLat: -33.9, minLon: 140.9, maxLon: 150.1 },
  },
};

const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const FEED = FEEDS[arg('--feed', 'vic')];
const OFFLINE = process.argv.includes('--offline');
const CACHE = path.join(__dirname, '.cache');
const TILE = 0.1;                      // ~11 km tiles, matching the existing index.json pattern

// ---- csv helper ---------------------------------------------------------
// Header-driven, never positional: GTFS column order is not fixed between feeds or versions.
function headerIndex(line, wanted) {
  const cols = csvSplit(line).map((c) => c.trim().replace(/^﻿/, ''));
  const idx = {};
  for (const w of wanted) idx[w] = cols.indexOf(w);
  return idx;
}

// ---- reference days -----------------------------------------------------

const dnum = (s) => ({ y: +s.slice(0, 4), m: +s.slice(4, 6), d: +s.slice(6, 8) });
const toDate = (s) => { const { y, m, d } = dnum(s); return new Date(Date.UTC(y, m - 1, d)); };
const fmt = (dt) => dt.toISOString().slice(0, 10).replace(/-/g, '');
const DOW = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Which service_ids run on a given yyyymmdd, honouring calendar_dates exceptions.
 * ⚠️ calendar_dates is not optional decoration — public holidays and school-holiday timetables
 * live there. Ignoring it is how you end up publishing Good Friday as a typical Wednesday.
 */
function servicesOn(cal, calDates, yyyymmdd) {
  const dt = toDate(yyyymmdd);
  const dow = DOW[dt.getUTCDay()];
  const on = new Set();
  for (const c of cal) {
    if (c[dow] === '1' && yyyymmdd >= c.start && yyyymmdd <= c.end) on.add(c.id);
  }
  const ex = calDates.get(yyyymmdd);
  if (ex) {
    for (const [id, type] of ex) {
      if (type === '1') on.add(id);
      else if (type === '2') on.delete(id);
    }
  }
  return on;
}

// ---- per-feed parse -----------------------------------------------------

async function parseFeed(zip, modeLabel, acc, refDays) {
  // calendar.txt
  const cal = [];
  let ci = null;
  await zip.streamLines('calendar.txt', (line) => {
    if (ci === null) { ci = headerIndex(line, ['service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'start_date', 'end_date']); return; }
    if (!line.trim()) return;
    const c = csvSplit(line);
    cal.push({
      id: c[ci.service_id], start: c[ci.start_date], end: c[ci.end_date],
      monday: c[ci.monday], tuesday: c[ci.tuesday], wednesday: c[ci.wednesday],
      thursday: c[ci.thursday], friday: c[ci.friday], saturday: c[ci.saturday], sunday: c[ci.sunday],
    });
  });

  // calendar_dates.txt
  const calDates = new Map();
  let di = null;
  if (zip.has('calendar_dates.txt')) {
    await zip.streamLines('calendar_dates.txt', (line) => {
      if (di === null) { di = headerIndex(line, ['service_id', 'date', 'exception_type']); return; }
      if (!line.trim()) return;
      const c = csvSplit(line);
      const d = c[di.date];
      if (!calDates.has(d)) calDates.set(d, []);
      calDates.get(d).push([c[di.service_id], c[di.exception_type]]);
    });
  }

  // service_ids active on each reference day
  const svc = refDays.map((d) => servicesOn(cal, calDates, d));

  // trips.txt → trip_id → bitmask over reference days
  const tripMask = new Map();
  let ti = null;
  await zip.streamLines('trips.txt', (line) => {
    if (ti === null) { ti = headerIndex(line, ['trip_id', 'service_id']); return; }
    if (!line.trim()) return;
    const c = csvSplit(line);
    const sid = c[ti.service_id];
    let mask = 0;
    for (let k = 0; k < svc.length; k++) if (svc[k].has(sid)) mask |= (1 << k);
    if (mask) tripMask.set(c[ti.trip_id], mask);
  });

  // stops.txt
  let si = null;
  await zip.streamLines('stops.txt', (line) => {
    if (si === null) { si = headerIndex(line, ['stop_id', 'stop_name', 'stop_lat', 'stop_lon', 'parent_station', 'location_type']); return; }
    if (!line.trim()) return;
    const c = csvSplit(line);
    const id = c[si.stop_id];
    if (!id) return;
    const lat = parseFloat(c[si.stop_lat]);
    const lon = parseFloat(c[si.stop_lon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const parent = si.parent_station > -1 ? (c[si.parent_station] || '') : '';
    acc.stops.set(id, {
      name: (c[si.stop_name] || '').trim(),
      lat, lon, parent,
      isStation: si.location_type > -1 && c[si.location_type] === '1',
    });
  });

  // stop_times.txt — the big one, streamed.
  let sti = null;
  await zip.streamLines('stop_times.txt', (line) => {
    if (sti === null) { sti = headerIndex(line, ['trip_id', 'stop_id', 'departure_time', 'arrival_time']); return; }
    if (!line.trim()) return;
    const c = csvSplit(line);
    const mask = tripMask.get(c[sti.trip_id]);
    if (!mask) return;
    const t = c[sti.departure_time] || c[sti.arrival_time] || '';
    const hh = parseInt(t.slice(0, 2), 10);
    if (!Number.isFinite(hh)) return;
    const sid = c[sti.stop_id];

    let e = acc.counts.get(sid);
    if (!e) { e = { hours: new Int32Array(30), sat: 0, sun: 0, modes: new Set() }; acc.counts.set(sid, e); }
    if (mask & 1) e.hours[Math.min(hh, 29)]++;      // reference weekday
    if (mask & 2) e.sat++;
    if (mask & 4) e.sun++;
    e.modes.add(modeLabel);
  });
}

// ---- reference-day choice ----------------------------------------------
/**
 * Pick a typical Wednesday/Saturday/Sunday from the feed's own active window.
 * Uses the MEDIAN candidate by active-service count, not the maximum: the max is whichever week
 * has the most special events layered on, and the min is a holiday. The median is the ordinary
 * week a renter would actually experience.
 */
function pickReferenceDays(zip) {
  const cal = [];
  let ci = null;
  const lines = zip.read('calendar.txt').toString('utf8').split(/\r?\n/);
  for (const line of lines) {
    if (ci === null) { ci = headerIndex(line, ['service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'start_date', 'end_date']); continue; }
    if (!line.trim()) continue;
    const c = csvSplit(line);
    cal.push({
      id: c[ci.service_id], start: c[ci.start_date], end: c[ci.end_date],
      monday: c[ci.monday], tuesday: c[ci.tuesday], wednesday: c[ci.wednesday],
      thursday: c[ci.thursday], friday: c[ci.friday], saturday: c[ci.saturday], sunday: c[ci.sunday],
    });
  }
  const calDates = new Map();
  let di = null;
  if (zip.has('calendar_dates.txt')) {
    for (const line of zip.read('calendar_dates.txt').toString('utf8').split(/\r?\n/)) {
      if (di === null) { di = headerIndex(line, ['service_id', 'date', 'exception_type']); continue; }
      if (!line.trim()) continue;
      const c = csvSplit(line);
      const d = c[di.date];
      if (!calDates.has(d)) calDates.set(d, []);
      calDates.get(d).push([c[di.service_id], c[di.exception_type]]);
    }
  }

  const starts = cal.map((c) => c.start).filter(Boolean).sort();
  const ends = cal.map((c) => c.end).filter(Boolean).sort();
  if (!starts.length) throw new Error('calendar.txt has no date range');
  const from = toDate(starts[0]);
  const to = toDate(ends[ends.length - 1]);

  const best = {};
  for (const [label, targetDow] of [['wed', 3], ['sat', 6], ['sun', 0]]) {
    const cands = [];
    const cur = new Date(from);
    while (cur.getUTCDay() !== targetDow) cur.setUTCDate(cur.getUTCDate() + 1);
    while (cur <= to && cands.length < 10) {
      const key = fmt(cur);
      cands.push({ key, n: servicesOn(cal, calDates, key).size });
      cur.setUTCDate(cur.getUTCDate() + 7);
    }
    const live = cands.filter((c) => c.n > 0).sort((a, b) => a.n - b.n);
    if (!live.length) throw new Error('no active ' + label + ' found in feed window');
    best[label] = live[Math.floor(live.length / 2)].key;   // median, not max
  }
  return best;
}

// Pure helpers are exported for tests/test_gtfs_ingest.js. MIN_FOR_AVG and interval()
// live in main() because they are only meaningful there, so the test re-declares the rule
// and asserts the EMITTED FILE obeys it — which is the thing that actually matters.
module.exports = { headerIndex, servicesOn, pickReferenceDays, FEEDS };

if (require.main !== module) return;   // importing must not run the ingest

// ---- main ---------------------------------------------------------------

(async () => {
  console.log(`GTFS frequency — ${FEED.name}`);
  console.log('='.repeat(64));

  fs.mkdirSync(CACHE, { recursive: true });
  const zipPath = path.join(CACHE, FEED.cache);
  if (!fs.existsSync(zipPath)) {
    if (OFFLINE) throw new Error('no cached feed and --offline given');
    console.log('downloading feed …');
    const r = await fetch(FEED.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    fs.writeFileSync(zipPath, Buffer.from(await r.arrayBuffer()));
  }
  console.log(`feed: ${(fs.statSync(zipPath).size / 1048576).toFixed(0)} MB`);

  const outer = readZip(fs.readFileSync(zipPath));
  const inners = outer.names().filter((n) => n.endsWith('.zip'));
  const acc = { stops: new Map(), counts: new Map() };

  // Reference days come from the largest inner feed, then are applied to ALL of them, so every
  // mode is counted on the same calendar day. Picking per-feed would compare a school-term bus
  // day against a holiday train day at the same interchange.
  const probe = readZip(outer.read(inners.sort((a, b) => outer.read(b).length - outer.read(a).length)[0]));
  const ref = pickReferenceDays(probe);
  console.log(`reference days: Wed ${ref.wed} · Sat ${ref.sat} · Sun ${ref.sun}`);
  const refDays = [ref.wed, ref.sat, ref.sun];

  for (const inner of inners.sort()) {
    const modeNum = inner.split('/')[0];
    const label = FEED.modes[modeNum] || 'other';
    process.stdout.write(`  mode ${modeNum} (${label}) … `);
    const iz = readZip(outer.read(inner));
    await parseFeed(iz, label, acc, refDays);
    console.log(`stops so far ${acc.stops.size.toLocaleString()}`);
  }

  // ── roll platforms up to their parent station ──────────────────────────
  // ⚠️ A metro station is many stop_ids (one per platform). Left alone, each platform shows a
  // fraction of the station's trains and the busiest station in Melbourne looks quiet.
  const rolled = new Map();
  for (const [sid, c] of acc.counts) {
    const s = acc.stops.get(sid);
    if (!s) continue;
    const key = s.parent && acc.stops.has(s.parent) ? s.parent : sid;
    let e = rolled.get(key);
    if (!e) e = { hours: new Int32Array(30), sat: 0, sun: 0, modes: new Set() };
    for (let h = 0; h < 30; h++) e.hours[h] += c.hours[h];
    e.sat += c.sat; e.sun += c.sun;
    for (const m of c.modes) e.modes.add(m);
    rolled.set(key, e);
  }
  console.log(`stops with service: ${rolled.size.toLocaleString()} (from ${acc.counts.size.toLocaleString()} before platform roll-up)`);

  // ── merge duplicate stops across mode feeds ────────────────────────────
  // ⚠️ VIC ships one inner feed per mode and the SAME physical stop carries a different
  // stop_id in each. Keying on stop_id alone leaves "Anzac Station/St Kilda Rd #20" in the
  // output twice, each showing a fraction of the trams that actually stop there. Merge on
  // name + position (4 dp ≈ 11 m), which joins the duplicates without merging the two kerbs
  // of a road — those carry different stop names ("#20" vs "#21").
  const byPlace = new Map();
  for (const [sid, c] of rolled) {
    const s = acc.stops.get(sid);
    if (!s) continue;
    const pk = `${s.name}|${s.lat.toFixed(4)}|${s.lon.toFixed(4)}`;
    let e = byPlace.get(pk);
    if (!e) { e = { name: s.name, lat: s.lat, lon: s.lon, hours: new Int32Array(30), sat: 0, sun: 0, modes: new Set() }; byPlace.set(pk, e); }
    for (let h = 0; h < 30; h++) e.hours[h] += c.hours[h];
    e.sat += c.sat; e.sun += c.sun;
    for (const m of c.modes) e.modes.add(m);
  }
  console.log(`distinct places: ${byPlace.size.toLocaleString()} (merged ${(rolled.size - byPlace.size).toLocaleString()} cross-feed duplicates)`);

  // ── build tiles ────────────────────────────────────────────────────────
  const sum = (h, a, b) => { let t = 0; for (let i = a; i < b; i++) t += h[i]; return t; };

  // 🔴 An "average interval" computed from one or two departures is not an interval, it is a
  // single event wearing a statistic's clothes. "Every 720 minutes" reads as a timetable; the
  // truth is "one bus all day". Below this many departures in the window we emit null and ship
  // the raw count instead, so the client has to say the honest thing.
  const MIN_FOR_AVG = 4;
  const interval = (deps, windowMin) => {
    if (deps < MIN_FOR_AVG) return null;
    return Math.max(1, Math.round(windowMin / deps));   // never 0 — see Flinders Street
  };

  const tiles = new Map();
  let emitted = 0;
  let outOfBounds = 0;
  for (const e of byPlace.values()) {
    const wk = sum(e.hours, 0, 30);
    if (!wk && !e.sat && !e.sun) continue;
    const bb = FEED.bbox;
    if (bb && (e.lat < bb.minLat || e.lat > bb.maxLat || e.lon < bb.minLon || e.lon > bb.maxLon)) { outOfBounds++; continue; }
    const peak = sum(e.hours, 7, 9);
    const day = sum(e.hours, 7, 19);
    emitted++;
    const key = `${Math.floor(e.lat / TILE)}_${Math.floor(e.lon / TILE)}`;
    if (!tiles.has(key)) tiles.set(key, []);
    tiles.get(key).push([
      Math.round(e.lat * 1e5) / 1e5,
      Math.round(e.lon * 1e5) / 1e5,
      e.name,
      wk,                              // weekday departures, whole service day
      peak,                            // raw count 7–9am
      interval(peak, 120),             // avg min between, or null if too few to average
      day,                             // raw count 7am–7pm
      interval(day, 720),
      e.sat,
      e.sun,
      [...e.modes].sort().join('/'),
    ]);
  }

  if (outOfBounds) console.log(`dropped ${outOfBounds} stop(s) outside the ${FEED.name} bounding box (interstate coach termini)`);

  const OUT_DIR = path.join(__dirname, '..', 'lastrenter-data-UPLOAD', FEED.out);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const f of fs.readdirSync(OUT_DIR)) if (/^t_.*\.json$/.test(f)) fs.unlinkSync(path.join(OUT_DIR, f));

  const index = [];
  for (const [key, arr] of [...tiles.entries()].sort()) {
    const file = `t_${key}.json`;
    fs.writeFileSync(path.join(OUT_DIR, file), JSON.stringify(arr));
    const [la, lo] = key.split('_').map(Number);
    index.push({ file, lat: la * TILE, lon: lo * TILE, size: TILE, stops: arr.length });
  }

  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify({
    dataset: FEED.out,
    description: 'Public transport service frequency by stop. Departures on a typical weekday, Saturday and Sunday, plus average minutes between services.',
    fields: ['lat', 'lon', 'name', 'weekday_departures', 'peak_departures', 'peak_avg_min', 'daytime_departures', 'daytime_avg_min', 'saturday_departures', 'sunday_departures', 'modes'],
    caveat: 'Average interval, not a guaranteed timetable: bunched services average the same as evenly spread ones. An avg_min field is null when fewer than 4 departures fall in the window — too few to average, so show the raw count instead. Counts are for one representative day of each type, chosen as the median of candidate days in the feed window. Not a service guarantee.',
    reference_days: ref,
    source: FEED.source,
    source_url: FEED.source_url,
    licence: FEED.licence,
    attribution: FEED.attribution,
    tile_size_deg: TILE,
    generated: new Date().toISOString().slice(0, 10),
    stops: emitted,
    tiles: index,
  }));

  const bytes = fs.readdirSync(OUT_DIR).reduce((a, f) => a + fs.statSync(path.join(OUT_DIR, f)).size, 0);
  console.log('');
  console.log(`wrote ${index.length} tiles + index.json → ${OUT_DIR}`);
  console.log(`${emitted.toLocaleString()} stops, ${(bytes / 1048576).toFixed(1)} MB total, largest tile ${Math.max(...index.map((i) => i.stops)).toLocaleString()} stops`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
