#!/usr/bin/env node
/**
 * GTFS → public transport SERVICE FREQUENCY per stop, emitted as CDN tiles.
 *
 * The point of this row: "400 m to a bus stop" is what a listing site says. It is nearly
 * useless - a stop served six times a day and a stop served every four minutes look identical.
 * This answers the question a renter actually has: how often does anything actually turn up.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ WHAT A HEADWAY NUMBER IS AND IS NOT
 * "Every 9 minutes" here means departures-per-hour averaged across a window, NOT a guaranteed
 * interval. A stop with 14 buses clustered into three bunches averages the same as one with 14
 * evenly spread. The honest rendering is "about every 9 min (7-9am average)" - never a timetable
 * promise, and never "frequent"/"poor" as a verdict, which is a display decision, not data.
 * Weekend counts ship separately BECAUSE the weekday number alone flatters an area badly:
 * plenty of Melbourne stops run every 10 minutes on a Wednesday and 4 times on a Sunday.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 WHY THIS FILE CAME BACK FROM THE DEAD (8 Sep 2026). READ BEFORE EDITING.
 *
 * This builder was written on 29 Aug 2026 and immediately shelved with a DO-NOT-UPLOAD.md,
 * because the Python adapters POSTing to the Xano `transit_stop` table were STRICTLY BETTER:
 * they also emit `routes`, `route_count` and `destinations` ("to City, St Kilda"), and they
 * cover four states where this file covered only VIC. That judgement was correct and the folder
 * was never uploaded. Its two real findings (weekend counts, and the sub-4-departure averaging
 * floor) were folded into the Python adapters instead, which is where they live now.
 *
 * WHAT CHANGED IS THE PRICE, NOT THE QUALITY. On 8 Sep the Xano account hit its 100,000-record
 * ceiling and EVERY WRITE ON THE PLATFORM began failing: the beachwatch and NSW DA caches, the
 * ingest crons, and in all likelihood review submission. `transit_stop` alone was 82,806 of
 * those records. A static, read-only, monthly-refreshed dataset queried by bounding box is a
 * CDN workload wearing a database's clothes, and it was crowding out the actual product.
 *
 * So this file is now the primary path, and it had to EARN that by reaching field parity with
 * the Python adapters first. Hence routes / route_count / destinations below, and NSW + SA.
 * ⚠️ That file is now `lastrenter-data-UPLOAD/vic-transit-frequency/HISTORY.md`, carrying the
 * original reasoning verbatim plus a dated amendment. A decision that changed gets an amendment,
 * never an erasure.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Usage: node ingest/gtfs_frequency.js [--feed vic|nsw|sa] [--offline] [--tile 0.1] [--out DIR]
 *
 * ⚠️ NSW NEEDS A CREDENTIAL AND THIS FILE NEVER HOLDS ONE. TfNSW requires an API key, read from
 * the environment as TFNSW_KEY (already a GitHub Actions secret for the Python adapter). It is
 * sent as an Authorization header and is never logged, cached or written to any output file.
 */

const fs = require('fs');
const path = require('path');
// ⚠️ TWO LOCATIONS ON PURPOSE. In THIS repo the zip reader lives at ingest/lib/zip.js. In the
// lastrenter-data-public repo it sits FLAT beside this file, because that repo has no folders and
// GitHub's web upload flattens them anyway (see the FLAT note in CLAUDE.md - a file called
// index.json nearly overwrote the live Defence ANEF index). Trying both keeps one copy of this
// script working in both places, so there is no forked version to drift.
let lrZip;
try { lrZip = require('./lib/zip'); } catch (e) { lrZip = require('./zip'); }
const { readZip, csvSplit } = lrZip;

// GTFS route_type → the mode tokens the property page's `labels` map understands
// (train / tram / bus / ferry). Anything else becomes "other" and is still counted, so an
// unmapped mode can never silently delete a stop's service.
// ⚠️ 1 = metro/subway maps to "train" deliberately: Sydney Metro is a train to a renter, and
// inventing a fifth row for it would leave that row unlabelled on the page.
//
// 🔴 THESE ARE TWO SEPARATE NAMESPACES AND MERGING THEM SHIPS WRONG ROWS. GTFS has the basic
// types 0 to 12, and the EXTENDED types (100 to 1799) where the hundreds digit is the family.
// The small integers mean different things in each: basic 4 is a ferry, extended bucket 4 is
// Urban Railway. Caught 8 Sep 2026 by probing the real feeds instead of assuming:
//
//   route_type 400 (VIC Urban Railway)  bucket 4 -> "ferry"  🔴 every Melbourne metro train
//   route_type 204 (Coach)              bucket 2 -> "train"  🔴 The Overland, a coach
//   route_type 712 (School Bus)         bucket 7 -> "other"  🔴 164 SA routes, unlabelled
//   route_type 701 (Regional Bus)       bucket 7 -> "other"  🔴 409 VIC + SA routes
//
// A single merged table produced all four. The probe that found it is worth repeating for any
// new feed: count route_type values in routes.txt before trusting a mapping.
const BASIC_MODES = { 0: 'tram', 1: 'train', 2: 'train', 3: 'bus', 4: 'ferry', 5: 'tram', 6: 'other', 7: 'other', 11: 'bus', 12: 'train' };
const EXTENDED_MODES = {
  1: 'train',   // 100-199 Railway Service (e.g. 102 long distance, The Overland)
  2: 'bus',     // 200-299 Coach Service. A coach is a bus to a renter, NOT a train.
  3: 'train',   // 300-399 Suburban Railway
  4: 'train',   // 400-499 Urban Railway (VIC metro is 400)
  5: 'train',   // 500-599 Metro Service
  6: 'train',   // 600-699 Underground Service
  7: 'bus',     // 700-799 Bus Service (701 regional, 712 school)
  8: 'bus',     // 800-899 Trolleybus
  9: 'tram',    // 900-999 Tram Service
  10: 'ferry',  // 1000-1099 Water Transport
  12: 'ferry',  // 1200-1299 Ferry Service
};
// 11xx air, 13xx aerial lift, 14xx funicular, 15xx taxi, 17xx misc all fall through to "other".
function modeForRouteType(rt) {
  if (!Number.isFinite(rt)) return 'other';
  if (rt <= 12) return BASIC_MODES[rt] || 'other';
  if (rt >= 100) return EXTENDED_MODES[Math.floor(rt / 100)] || 'other';
  return 'other';
}

const FEEDS = {
  vic: {
    name: 'Victoria (PTV)',
    url: 'https://opendata.transport.vic.gov.au/dataset/3f4e292e-7f8a-4ffe-831f-1953be0fe448/resource/fb152201-859f-4882-9206-b768060b50ad/download/gtfs.zip',
    cache: 'vic_gtfs.zip',
    out: 'vic-transit-frequency',
    jurisdiction: 'VIC',
    licence: 'CC BY 4.0',
    attribution: 'Based on Public Transport Victoria GTFS data',
    source: 'Department of Transport and Planning Victoria - GTFS Schedule',
    source_url: 'https://discover.data.vic.gov.au/dataset/gtfs-schedule',
    // VIC ships a zip-of-zips, one inner GTFS feed per mode, so the mode is the folder number.
    nested: true,
    modes: { 1: 'train', 2: 'train', 3: 'tram', 4: 'bus', 5: 'bus', 6: 'bus', 10: 'bus', 11: 'bus' },
    // ⚠️ Interstate coach routes terminate OUTSIDE Victoria - the feed genuinely contains
    // Adelaide, Canberra and Sydney stops. Serving those from a dataset labelled Victoria
    // would show an Adelaide renter one Sunday coach as if it were their transit service,
    // i.e. fabricated coverage in a state we do not cover. Clipped to the state bounds.
    bbox: { minLat: -39.3, maxLat: -33.9, minLon: 140.9, maxLon: 150.1 },
  },
  nsw: {
    name: 'New South Wales (TfNSW)',
    url: 'https://api.transport.nsw.gov.au/v1/publictransport/timetables/complete/gtfs',
    cache: 'nsw_gtfs.zip',
    out: 'nsw-transit-frequency',
    jurisdiction: 'NSW',
    licence: 'CC BY 4.0',
    attribution: 'Based on Transport for NSW GTFS data',
    source: 'Transport for NSW - GTFS Schedule (complete)',
    source_url: 'https://opendata.transport.nsw.gov.au',
    // ONE combined feed, so mode comes from each route's route_type rather than a folder.
    nested: false,
    // 🔴 CREDENTIAL, FROM THE ENVIRONMENT ONLY. Never inline a key here.
    authEnv: 'TFNSW_KEY',
    authHeader: (k) => ({ Authorization: 'apikey ' + k }),
    // NSW's feed carries interstate coach termini the same way VIC's does (Canberra, Brisbane,
    // Melbourne). Same reasoning, same clip.
    bbox: { minLat: -37.6, maxLat: -28.1, minLon: 140.9, maxLon: 153.7 },
  },
  sa: {
    name: 'South Australia (Adelaide Metro)',
    url: 'https://gtfs.adelaidemetro.com.au/v1/static/latest/google_transit.zip',
    cache: 'sa_gtfs.zip',
    out: 'sa-transit-frequency',
    jurisdiction: 'SA',
    licence: 'CC BY 4.0',
    attribution: 'Based on Adelaide Metro GTFS data',
    source: 'Department for Infrastructure and Transport - Adelaide Metro GTFS',
    source_url: 'https://data.sa.gov.au/data/dataset/https-gtfs-adelaidemetro-com-au',
    nested: false,
    bbox: { minLat: -38.1, maxLat: -25.9, minLon: 128.9, maxLon: 141.1 },
  },
  // ⛔ ACT is deliberately absent. Transport Canberra moved static GTFS behind the MyWay+ API in
  // June 2025 and it needs ACT_GTFS_ID / ACT_GTFS_SECRET from the MuleSoft portal, which we do
  // not have. Adding a config that cannot run would look like coverage we do not have.
};

const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const FEED_KEY = arg('--feed', 'vic');
const FEED = FEEDS[FEED_KEY];
const OFFLINE = process.argv.includes('--offline');
const CACHE = path.join(__dirname, '.cache');
// 🔴 THE DATA REPO IS FLAT. Every file sits at the repo ROOT, no folders. Verified live 8 Sep 2026:
// /index.json is 200 and IS the Defence ANEF index; /defence-anef/index.json is 404. The local
// lastrenter-data-UPLOAD/defence-anef/ folder is a STAGING convention only, and GitHub's web upload
// flattens folders anyway.
//
// 🔴 SO A FILE CALLED index.json WOULD HAVE OVERWRITTEN THE LIVE ANEF INDEX and broken Defence
// aircraft noise nationally. Every file this script writes is therefore PREFIXED with its
// jurisdiction and dataset, is unique across all three feeds, and is safe to drop at the root.
//
// ⚠️ Tile lat/lon indices OVERLAP between states (the Albury/Wodonga border sits in both the VIC and
// NSW grids), so an unprefixed t_-360_1470.json would collide between feeds too.
//
// TILE SIZE: 0.1 deg (~11 km). Measured on SA, which is the trade-off in miniature:
//
//   0.1  deg -> 190 files, largest tile 175 kB raw (~35 kB gzipped)
//   0.15 deg -> 142 files, largest tile 266 kB
//   0.25 deg ->  99 files, largest tile 648 kB   <-- too heavy for a page fetch
//
// The client's query box is ~3.3 km, far smaller than any of these, so it fetches 1 to 4 tiles
// whichever is chosen. The only things that move are FILE COUNT and the weight of a dense city
// tile. File count briefly looked decisive because the tiles were being uploaded BY HAND, but the
// GitHub Action builds and commits them now, so it costs nothing and the renter gets the small
// fetch. Tune with --tile if a feed ever gets dense enough to matter.
const TILE = parseFloat(arg('--tile', '0.1'));

// Daytime and peak windows, in whole hours. The WEEKEND COUNTS USE THE DAYTIME WINDOW TOO.
// ⚠️ That is deliberate and it is a change from this file's 29 Aug version, which counted the
// whole weekend service day. The live property page renders "every ~2 min · weekend: 144 Sun,
// 144 Sat departures", and Frankie found on 7 Sep that two numbers measured over DIFFERENT
// windows sitting on one line makes a reader distrust both. The Python adapters already scope
// weekend counts to the daytime window; matching them keeps the page's arithmetic honest.
const DAY_FROM = 7, DAY_TO = 19, PEAK_FROM = 7, PEAK_TO = 9;

const DEST_SHARE = 0.05;   // drop a headsign below 5% of a stop's weekday trips (depot runs, short workings)
const DEST_MAX = 8;        // cap the stored destination list

// ---- csv helper ---------------------------------------------------------
// Header-driven, never positional: GTFS column order is not fixed between feeds or versions.
function headerIndex(line, wanted) {
  const cols = csvSplit(line).map((c) => c.trim().replace(/^﻿/, ''));
  const idx = {};
  for (const w of wanted) idx[w] = cols.indexOf(w);
  return idx;
}

const clean = (s) => String(s == null ? '' : s).trim().replace(/^"|"$/g, '');

/** Natural sort so route labels read 1, 3, 16, 96 and not 1, 16, 3, 96. */
function routeSortKey(s) {
  return /^\d+$/.test(s) ? [0, parseInt(s, 10), ''] : [1, 0, s.toLowerCase()];
}
function routeSort(a, b) {
  const ka = routeSortKey(a), kb = routeSortKey(b);
  return ka[0] - kb[0] || ka[1] - kb[1] || (ka[2] < kb[2] ? -1 : ka[2] > kb[2] ? 1 : 0);
}

/**
 * Dominant termini for a stop, ordered by how many services actually go there.
 * Ported from the Python adapters so the tiles read the same as what is live today, with ONE
 * deliberate difference: this returns an ARRAY, not a comma-joined string. See the note on the
 * emit below - route and destination names genuinely contain commas, so joining them is lossy.
 * ⚠️ The `max(2, share)` floor is what keeps a single depot run out of "where it goes".
 */
function summarizeDest(headCounts, total) {
  if (!total) return [];
  const floor = Math.max(2, DEST_SHARE * total);
  const kept = [...headCounts.entries()].filter(([h, c]) => h && c >= floor).sort((a, b) => b[1] - a[1]);
  const seen = new Set(), out = [];
  for (const [h] of kept) {
    const hn = h.trim();
    if (hn && !seen.has(hn.toLowerCase())) { seen.add(hn.toLowerCase()); out.push(hn); }
    if (out.length >= DEST_MAX) break;
  }
  return out;
}

// ---- reference days -----------------------------------------------------

const dnum = (s) => ({ y: +s.slice(0, 4), m: +s.slice(4, 6), d: +s.slice(6, 8) });
const toDate = (s) => { const { y, m, d } = dnum(s); return new Date(Date.UTC(y, m - 1, d)); };
const fmt = (dt) => dt.toISOString().slice(0, 10).replace(/-/g, '');
const DOW = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Which service_ids run on a given yyyymmdd, honouring calendar_dates exceptions.
 * ⚠️ calendar_dates is not optional decoration - public holidays and school-holiday timetables
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

/**
 * @param fixedMode  a mode token for zip-of-zips feeds (VIC), or null to derive it per route
 *                   from route_type (NSW, SA).
 */
async function parseFeed(zip, fixedMode, acc, refDays) {
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

  // routes.txt → route_id → { label, mode }
  // Label prefers the short name ("96", "246") and falls back to the long name, which is what
  // rail lines carry. Same rule as the Python adapters.
  const routes = new Map();
  let ri = null;
  if (zip.has('routes.txt')) {
    await zip.streamLines('routes.txt', (line) => {
      if (ri === null) { ri = headerIndex(line, ['route_id', 'route_short_name', 'route_long_name', 'route_type']); return; }
      if (!line.trim()) return;
      const c = csvSplit(line);
      const short = ri.route_short_name > -1 ? clean(c[ri.route_short_name]) : '';
      const long = ri.route_long_name > -1 ? clean(c[ri.route_long_name]) : '';
      const rt = ri.route_type > -1 ? parseInt(clean(c[ri.route_type]), 10) : NaN;
      routes.set(clean(c[ri.route_id]), {
        label: short || long,
        // ⚠️ fixedMode wins for zip-of-zips feeds (VIC), where the folder already says the mode
        // and is more reliable than the per-route type. Otherwise derive it, honouring the
        // basic-versus-extended namespace split documented at modeForRouteType.
        mode: fixedMode || modeForRouteType(rt),
      });
    });
  }

  // trips.txt → trip_id → { mask, label, headsign, mode }
  const tripInfo = new Map();
  let ti = null;
  await zip.streamLines('trips.txt', (line) => {
    if (ti === null) { ti = headerIndex(line, ['trip_id', 'service_id', 'route_id', 'trip_headsign']); return; }
    if (!line.trim()) return;
    const c = csvSplit(line);
    const sid = c[ti.service_id];
    let mask = 0;
    for (let k = 0; k < svc.length; k++) if (svc[k].has(sid)) mask |= (1 << k);
    if (!mask) return;
    const r = routes.get(clean(c[ti.route_id])) || {};
    tripInfo.set(c[ti.trip_id], {
      mask,
      label: r.label || '',
      headsign: ti.trip_headsign > -1 ? clean(c[ti.trip_headsign]) : '',
      mode: r.mode || fixedMode || 'other',
    });
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
      name: clean(c[si.stop_name]),
      lat, lon, parent,
      isStation: si.location_type > -1 && c[si.location_type] === '1',
    });
  });

  // stop_times.txt - the big one, streamed.
  let sti = null;
  await zip.streamLines('stop_times.txt', (line) => {
    if (sti === null) { sti = headerIndex(line, ['trip_id', 'stop_id', 'departure_time', 'arrival_time']); return; }
    if (!line.trim()) return;
    const c = csvSplit(line);
    const info = tripInfo.get(c[sti.trip_id]);
    if (!info) return;
    const t = c[sti.departure_time] || c[sti.arrival_time] || '';
    const hh = parseInt(t.slice(0, 2), 10);
    if (!Number.isFinite(hh)) return;
    const sid = c[sti.stop_id];
    const inDay = hh >= DAY_FROM && hh < DAY_TO;

    // 🔴 KEYED BY STOP **AND MODE**, and that is load-bearing. Merging a place's modes into one
    // row sums their departures, so an interchange served by trams every 3 min and trains every
    // 5 min reports BOTH rows as "every ~2 min". The page renders a per-mode line ("🚊 Trams
    // every ~2 min"), so a combined count is a quiet overstatement at exactly the busiest,
    // most-viewed stops. The Xano schema keyed on (stop, mode) for this reason; the tiles now do
    // too. Only 105 of 24,717 VIC places are multi-mode, but they are the major interchanges.
    const ckey = sid + '\u0000' + info.mode;
    let e = acc.counts.get(ckey);
    if (!e) { e = { sid, mode: info.mode, hours: new Int32Array(30), sat: 0, sun: 0, routes: new Set(), heads: new Map() }; acc.counts.set(ckey, e); }
    if (info.mask & 1) e.hours[Math.min(hh, 29)]++;   // reference weekday
    // ⚠️ Weekend counts are scoped to the daytime window so they are directly comparable with
    // deps_daytime on the same page line. See the DAY_FROM comment above.
    if (inDay && (info.mask & 2)) e.sat++;
    if (inDay && (info.mask & 4)) e.sun++;
    // 🔴 MODE, ROUTES AND DESTINATIONS COME FROM ANY REFERENCE DAY, NOT JUST THE WEEKDAY.
    // Collecting them weekday-only left 2,954 Victorian stops with a service but NO route label,
    // every one of them weekend-only (rural Princes Hwy stops with one Saturday or Sunday coach).
    // The Python adapters never hit this because they DROP a stop whose weekday daytime count is
    // below the minimum, so those stops simply never existed there. We emit them, so we owe them
    // a label: "which route serves this stop" is a fact about the stop, not about Wednesday.
    if (info.label) e.routes.add(info.label);
    if (info.headsign) e.heads.set(info.headsign, (e.heads.get(info.headsign) || 0) + 1);
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
// and asserts the EMITTED FILE obeys it - which is the thing that actually matters.
module.exports = { headerIndex, servicesOn, pickReferenceDays, summarizeDest, routeSort, modeForRouteType, FEEDS, BASIC_MODES, EXTENDED_MODES };

if (require.main !== module) return;   // importing must not run the ingest

// ---- main ---------------------------------------------------------------

(async () => {
  if (!FEED) throw new Error(`unknown feed "${FEED_KEY}". Known: ${Object.keys(FEEDS).join(', ')}`);
  console.log(`GTFS frequency - ${FEED.name}`);
  console.log('='.repeat(64));

  fs.mkdirSync(CACHE, { recursive: true });
  const zipPath = path.join(CACHE, FEED.cache);
  if (!fs.existsSync(zipPath)) {
    if (OFFLINE) throw new Error('no cached feed and --offline given');
    const headers = { 'User-Agent': 'Mozilla/5.0' };
    if (FEED.authEnv) {
      // 🔴 The key lives in the environment and nowhere else. It is not echoed, not cached
      // alongside the zip, and not written into index.json.
      const key = process.env[FEED.authEnv];
      if (!key) throw new Error(`${FEED.authEnv} is not set. This feed needs an API key; export it in the environment (it is already a GitHub Actions secret). It is never stored in this repo.`);
      Object.assign(headers, FEED.authHeader(key));
      console.log(`using ${FEED.authEnv} from the environment (not logged)`);
    }
    console.log('downloading feed …');
    const r = await fetch(FEED.url, { headers });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    fs.writeFileSync(zipPath, Buffer.from(await r.arrayBuffer()));
  }
  console.log(`feed: ${(fs.statSync(zipPath).size / 1048576).toFixed(0)} MB`);

  const outer = readZip(fs.readFileSync(zipPath));
  const acc = { stops: new Map(), counts: new Map() };
  let ref;

  if (FEED.nested) {
    // VIC: a zip of per-mode GTFS zips. The mode is the folder number.
    const inners = outer.names().filter((n) => n.endsWith('.zip'));
    if (!inners.length) throw new Error('feed is marked nested but contains no inner zips');
    // Reference days come from the largest inner feed, then are applied to ALL of them, so every
    // mode is counted on the same calendar day. Picking per-feed would compare a school-term bus
    // day against a holiday train day at the same interchange.
    const probe = readZip(outer.read(inners.slice().sort((a, b) => outer.read(b).length - outer.read(a).length)[0]));
    ref = pickReferenceDays(probe);
    console.log(`reference days: Wed ${ref.wed} · Sat ${ref.sat} · Sun ${ref.sun}`);
    const refDays = [ref.wed, ref.sat, ref.sun];
    for (const inner of inners.sort()) {
      const modeNum = inner.split('/')[0];
      const label = FEED.modes[modeNum] || 'other';
      process.stdout.write(`  mode ${modeNum} (${label}) … `);
      await parseFeed(readZip(outer.read(inner)), label, acc, refDays);
      console.log(`stops so far ${acc.stops.size.toLocaleString()}`);
    }
  } else {
    // NSW / SA: one combined feed. Mode comes from each route's route_type.
    ref = pickReferenceDays(outer);
    console.log(`reference days: Wed ${ref.wed} · Sat ${ref.sat} · Sun ${ref.sun}`);
    process.stdout.write('  single combined feed (mode from route_type) … ');
    await parseFeed(outer, null, acc, [ref.wed, ref.sat, ref.sun]);
    console.log(`stops ${acc.stops.size.toLocaleString()}`);
  }

  // ── roll platforms up to their parent station ──────────────────────────
  // ⚠️ A metro station is many stop_ids (one per platform). Left alone, each platform shows a
  // fraction of the station's trains and the busiest station in Melbourne looks quiet.
  const blank = (mode) => ({ mode, hours: new Int32Array(30), sat: 0, sun: 0, routes: new Set(), heads: new Map() });
  const mergeInto = (e, c) => {
    for (let h = 0; h < 30; h++) e.hours[h] += c.hours[h];
    e.sat += c.sat; e.sun += c.sun;
    for (const r of c.routes) e.routes.add(r);
    for (const [h, n] of c.heads) e.heads.set(h, (e.heads.get(h) || 0) + n);
  };

  const rolled = new Map();
  for (const c of acc.counts.values()) {
    const s = acc.stops.get(c.sid);
    if (!s) continue;
    // Platforms roll up to their parent station WITHIN a mode, never across modes.
    const base = s.parent && acc.stops.has(s.parent) ? s.parent : c.sid;
    const key = base + '\u0000' + c.mode;
    let e = rolled.get(key);
    if (!e) { e = blank(c.mode); e.sid = base; rolled.set(key, e); }
    mergeInto(e, c);
  }
  console.log(`stops with service: ${rolled.size.toLocaleString()} (from ${acc.counts.size.toLocaleString()} before platform roll-up)`);

  // ── merge duplicate stops across mode feeds ────────────────────────────
  // ⚠️ VIC ships one inner feed per mode and the SAME physical stop carries a different
  // stop_id in each. Keying on stop_id alone leaves "Anzac Station/St Kilda Rd #20" in the
  // output twice, each showing a fraction of the trams that actually stop there. Merge on
  // name + position (4 dp ≈ 11 m), which joins the duplicates without merging the two kerbs
  // of a road - those carry different stop names ("#20" vs "#21").
  const byPlace = new Map();
  for (const c of rolled.values()) {
    const s = acc.stops.get(c.sid);
    if (!s) continue;
    // ⚠️ The mode is part of the place key, so the SAME physical stop appearing in two mode feeds
    // still merges within each mode (which is what this dedupe exists for) but keeps its tram
    // departures separate from its train departures.
    const pk = `${s.name}|${s.lat.toFixed(4)}|${s.lon.toFixed(4)}|${c.mode}`;
    let e = byPlace.get(pk);
    if (!e) { e = Object.assign(blank(c.mode), { name: s.name, lat: s.lat, lon: s.lon }); byPlace.set(pk, e); }
    mergeInto(e, c);
  }
  console.log(`place+mode rows: ${byPlace.size.toLocaleString()} (merged ${(rolled.size - byPlace.size).toLocaleString()} cross-feed duplicates)`);

  // ── build tiles ────────────────────────────────────────────────────────
  const sum = (h, a, b) => { let t = 0; for (let i = a; i < b; i++) t += h[i]; return t; };

  // 🔴 An "average interval" computed from one or two departures is not an interval, it is a
  // single event wearing a statistic's clothes. "Every 720 minutes" reads as a timetable; the
  // truth is "one bus all day". Below this many departures in the window we emit null and ship
  // the raw count instead, so the client has to say the honest thing.
  const MIN_FOR_AVG = 4;
  const interval = (deps, windowMin) => {
    if (deps < MIN_FOR_AVG) return null;
    return Math.max(1, Math.round(windowMin / deps));   // never 0 - see Flinders Street
  };

  const tiles = new Map();
  let emitted = 0;
  let outOfBounds = 0;
  for (const e of byPlace.values()) {
    const wk = sum(e.hours, 0, 30);
    if (!wk && !e.sat && !e.sun) continue;
    const bb = FEED.bbox;
    if (bb && (e.lat < bb.minLat || e.lat > bb.maxLat || e.lon < bb.minLon || e.lon > bb.maxLon)) { outOfBounds++; continue; }
    const peak = sum(e.hours, PEAK_FROM, PEAK_TO);
    const day = sum(e.hours, DAY_FROM, DAY_TO);
    emitted++;
    const labels = [...e.routes].sort(routeSort);
    const totalWd = [...e.heads.values()].reduce((a, b) => a + b, 0);
    const key = `${Math.floor(e.lat / TILE)}_${Math.floor(e.lon / TILE)}`;
    if (!tiles.has(key)) tiles.set(key, []);
    tiles.get(key).push([
      Math.round(e.lat * 1e5) / 1e5,
      Math.round(e.lon * 1e5) / 1e5,
      e.name,
      wk,                              // weekday departures, whole service day
      peak,                            // raw count 7-9am
      interval(peak, (PEAK_TO - PEAK_FROM) * 60),   // avg min between, or null if too few to average
      day,                             // raw count 7am-7pm
      interval(day, (DAY_TO - DAY_FROM) * 60),
      e.sat,                           // Saturday departures, DAYTIME window
      e.sun,                           // Sunday departures, DAYTIME window
      e.mode,                          // ONE mode per row. See the (stop, mode) note above.
      // 🔴 ARRAYS, NOT COMMA-JOINED STRINGS, AND THIS IS A BUG FIX NOT A STYLE CHOICE.
      // Route and destination names genuinely contain commas: Victoria ships the single route
      // "Mildura - Horsham Via Warracknabeal, Ouyen". Joined with ", " that is indistinguishable
      // from two routes, and 231 VIC stops had a route_count that disagreed with their own
      // string. The live Xano rows have the same defect (the Python adapters join identically)
      // and the property page splits BOTH fields on "," to render them, so a comma in a name
      // silently invents a route and a destination on screen today.
      labels,                          // routes, natural-sorted
      labels.length,                   // route_count, always === routes.length
      summarizeDest(e.heads, totalWd), // destinations, "where it goes", most-served first
    ]);
  }

  if (outOfBounds) console.log(`dropped ${outOfBounds} stop(s) outside the ${FEED.name} bounding box (interstate coach termini)`);

  // One STAGING folder for all feeds, holding files named exactly as they must appear at the repo
  // ROOT. Uploading its CONTENTS (which is what the web UI does to a folder anyway) is then correct
  // rather than destructive. Only this feed's own files are cleared, so VIC and SA can coexist here.
  // --out lets the GitHub Action write straight into the data repo root. Default is the local
  // staging folder. Either way the files are named as they must appear at the repo ROOT.
  const OUT_DIR = path.resolve(arg('--out', path.join(__dirname, '..', 'lastrenter-data-UPLOAD', 'transit-tiles')));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const PREFIX = FEED.out.replace(/-frequency$/, '');          // "vic-transit-frequency" -> "vic-transit"
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (f.startsWith(PREFIX + '-')) fs.unlinkSync(path.join(OUT_DIR, f));
  }

  const index = [];
  for (const [key, arr] of [...tiles.entries()].sort()) {
    const file = `${PREFIX}-t_${key}.json`;
    fs.writeFileSync(path.join(OUT_DIR, file), JSON.stringify(arr));
    const [la, lo] = key.split('_').map(Number);
    // ⚠️ `key` is what the client matches on. It looks the filename up from HERE rather than
    // rebuilding it, so the naming scheme stays entirely this script's business and a future rename
    // cannot desynchronise the two.
    index.push({ key, file, lat: la * TILE, lon: lo * TILE, size: TILE, stops: arr.length });
  }

  fs.writeFileSync(path.join(OUT_DIR, PREFIX + '-index.json'), JSON.stringify({
    dataset: FEED.out,
    jurisdiction: FEED.jurisdiction,
    description: 'Public transport service frequency by stop and mode. One row per stop per mode, so an interchange carries separate tram and train figures. Departures on a typical weekday, Saturday and Sunday, plus average minutes between services, the routes serving the stop and where they go.',
    fields: ['lat', 'lon', 'name', 'weekday_departures', 'peak_departures', 'peak_avg_min', 'daytime_departures', 'daytime_avg_min', 'saturday_departures', 'sunday_departures', 'mode', 'routes', 'route_count', 'destinations'],
    caveat: 'Average interval, not a guaranteed timetable: bunched services average the same as evenly spread ones. An avg_min field is null when fewer than 4 departures fall in the window - too few to average, so show the raw count instead. Counts are for one representative day of each type, chosen as the median of candidate days in the feed window. Saturday and Sunday counts use the SAME 7am to 7pm window as daytime_departures so the two are directly comparable. routes and destinations are ARRAYS because route names contain commas. Not a service guarantee.',
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

  const mine = fs.readdirSync(OUT_DIR).filter((f) => f.startsWith(PREFIX + '-'));
  const bytes = mine.reduce((a, f) => a + fs.statSync(path.join(OUT_DIR, f)).size, 0);
  const biggest = mine.map((f) => fs.statSync(path.join(OUT_DIR, f)).size).sort((a, b) => b - a)[0];
  console.log('');
  console.log(`wrote ${index.length} tiles + ${PREFIX}-index.json → ${OUT_DIR}`);
  console.log(`${emitted.toLocaleString()} stops, ${mine.length} files, ${(bytes / 1048576).toFixed(1)} MB total`);
  console.log(`largest tile ${Math.max(...index.map((i) => i.stops)).toLocaleString()} stops (${(biggest / 1024).toFixed(0)} kB raw, gzips to roughly a fifth)`);
  console.log(`tile size ${TILE} deg. All files are root-safe: upload the CONTENTS of transit-tiles/ to the repo root.`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
