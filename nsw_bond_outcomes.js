#!/usr/bin/env node
/**
 * NSW bond refund OUTCOMES → lastrenter-data-public/nsw-bond-outcomes/
 *
 * Source : NSW Fair Trading, "Rental bond data" (nsw.gov.au). Licence: CC BY.
 * Cadence: quarterly. Pools the most recent N quarters.
 * Output : one row per postcode — what share of bonds came back to the tenant in full.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ THE FRAMING RULE, AND IT IS NOT NEGOTIABLE
 * "Payment to agent" includes entirely LEGITIMATE deductions: unpaid rent, real damage,
 * cleaning that genuinely was required. This is an OUTCOME rate, not a fault rate, and it
 * must never be rendered as a measure of landlords behaving badly. The honest sentence is
 * "in this postcode, X% of bonds were returned in full" — never "X% of landlords withheld".
 * Getting this wrong converts a factual row into an accusation about identifiable people,
 * which is precisely the defamation exposure the law firms are being asked about.
 * The emitted JSON carries this warning in a `framing` field so it travels with the data.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Honesty guards implemented here (not left to the client):
 *   1. Thin postcodes are OMITTED, not emitted-with-a-flag. A client cannot render what it
 *      never receives, so no future edit can accidentally surface a 12-sample "rate".
 *   2. Rates are pooled across several quarters — one quarter in a small postcode is noise.
 *   3. The state baseline ships alongside, so a postcode is always shown against context
 *      rather than as a bare number.
 *   4. No good/bad labelling. The file carries rates; wording is the client's problem and
 *      is reviewed separately.
 *
 * Usage:  node ingest/nsw_bond_outcomes.js [--quarters 4] [--min-n 200] [--offline]
 */

const fs = require('fs');
const path = require('path');
const { readSheet } = require('./lib/xlsx');

const PAGE = 'https://www.nsw.gov.au/housing-and-construction/rental-forms-surveys-and-data/rental-bond-data';
const ORIGIN = 'https://www.nsw.gov.au';
const OUT_DIR = path.join(__dirname, '..', 'lastrenter-data-UPLOAD', 'nsw-bond-outcomes');
const CACHE = path.join(__dirname, '.cache');

const arg = (flag, def) => {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const QUARTERS = +arg('--quarters', 4);
const MIN_N = +arg('--min-n', 200);
const OFFLINE = process.argv.includes('--offline');

const QNUM = { '1st': 1, '2nd': 2, '3rd': 3, '4th': 4 };

// ---- discovery ----------------------------------------------------------
// ⚠️ The URLs are NOT constructible. The filename is semi-predictable but the directory is
// the publication month (…/2026-07/… vs …/2026-04/…) and filenames drift
// ("…_june_2025_0.xlsx", "…_september25.xlsx"). So we discover links from the page.
async function discover() {
  const res = await fetch(PAGE, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error('bond data page returned HTTP ' + res.status);
  const html = await res.text();
  const all = parseLinks(html);              // ignores refunds_year_*.xlsx — annual files
  if (!all.length) throw new Error('no quarterly refund files found — page structure changed');
  return all;
}

async function download(item) {
  fs.mkdirSync(CACHE, { recursive: true });
  const dest = path.join(CACHE, item.file);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 10000) return dest;
  process.stdout.write(`  fetching ${item.file} … `);
  const r = await fetch(item.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${item.url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(dest, buf);
  console.log((buf.length / 1048576).toFixed(2) + ' MB');
  return dest;
}

// ---- parse --------------------------------------------------------------

const REQUIRED = ['Postcode', 'Payment To Agent', 'Payment To Tenant', 'Days Bond Held'];

function parseQuarter(file) {
  const { headers, rows } = readSheet(file, (r) => r.join('|').includes('Payment To Agent'));
  // ⚠️ Fail loudly rather than pool mismatched files. A quarter with a renamed column would
  // otherwise contribute silent zeroes and drag every rate toward "returned in full".
  const missing = REQUIRED.filter((h) => !headers.includes(h));
  if (missing.length) throw new Error(`${path.basename(file)} missing column(s): ${missing.join(', ')}`);
  return rows;
}

const num = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : 0; };
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

// ---- aggregate ----------------------------------------------------------

function classify(r) {
  const toAgent = num(r['Payment To Agent']);
  const toTenant = num(r['Payment To Tenant']);
  if (toAgent === 0 && toTenant > 0) return 'full';
  if (toAgent > 0 && toTenant > 0) return 'partial';
  if (toAgent > 0 && toTenant === 0) return 'none';
  return null;                                  // both zero — not a meaningful refund row
}

function aggregate(all) {
  const state = { n: 0, full: 0, partial: 0, none: 0, withheld: [], days: [] };
  const byPc = new Map();

  for (const r of all) {
    const cls = classify(r);
    if (!cls) continue;
    const pc = String(r['Postcode'] || '').trim();
    if (!/^\d{4}$/.test(pc)) continue;

    const withheld = num(r['Payment To Agent']);
    const days = num(r['Days Bond Held']);

    state.n++; state[cls]++;
    if (cls !== 'full') state.withheld.push(withheld);
    if (days > 0) state.days.push(days);

    let e = byPc.get(pc);
    if (!e) { e = { n: 0, full: 0, partial: 0, none: 0, withheld: [], days: [] }; byPc.set(pc, e); }
    e.n++; e[cls]++;
    if (cls !== 'full') e.withheld.push(withheld);
    if (days > 0) e.days.push(days);
  }
  return { state, byPc };
}

const pct1 = (a, b) => Math.round((a / b) * 1000) / 10;

// ---- main ---------------------------------------------------------------

// Discovery is a pure function of the page HTML so it can be tested without a network call —
// in particular that annual `refunds_year_*.xlsx` files never enter the pool (double-counting).
function parseLinks(html) {
  const found = new Map();
  for (const m of html.matchAll(/\/sites\/default\/files\/noindex\/[0-9-]+\/(rentalbond_refunds_(\w+)_quarter_(\d{4})\.xlsx)/g)) {
    const [href, file, q, year] = [m[0], m[1], m[2], m[3]];
    const qn = QNUM[q];
    if (!qn) continue;
    found.set(file, { url: ORIGIN + href, file, quarter: qn, year: +year, key: `${year}Q${qn}` });
  }
  return [...found.values()].sort((a, b) => b.year - a.year || b.quarter - a.quarter);
}

module.exports = { classify, aggregate, median, pct1, parseLinks, parseQuarter, REQUIRED };

if (require.main !== module) return;

(async () => {
  console.log('NSW bond refund outcomes — ingest');
  console.log('='.repeat(64));

  let picked;
  if (OFFLINE) {
    picked = fs.readdirSync(CACHE)
      .filter((f) => /^rentalbond_refunds_\w+_quarter_\d{4}\.xlsx$/.test(f))
      .map((f) => {
        const m = f.match(/refunds_(\w+)_quarter_(\d{4})/);
        return { file: f, quarter: QNUM[m[1]], year: +m[2], key: `${m[2]}Q${QNUM[m[1]]}` };
      })
      .sort((a, b) => b.year - a.year || b.quarter - a.quarter)
      .slice(0, QUARTERS);
    console.log('offline mode — using cached files');
  } else {
    const avail = await discover();
    console.log(`discovered ${avail.length} quarterly refund files; newest ${avail[0].key}`);
    picked = avail.slice(0, QUARTERS);
    for (const p of picked) await download(p);
  }

  if (picked.length < QUARTERS) {
    console.log(`⚠️  only ${picked.length} quarters available (wanted ${QUARTERS})`);
  }

  const all = [];
  const perQuarter = [];
  for (const p of picked) {
    const rows = parseQuarter(path.join(CACHE, p.file));
    perQuarter.push({ key: p.key, rows: rows.length });
    console.log(`  ${p.key}: ${rows.length.toLocaleString()} rows`);
    all.push(...rows);
  }
  console.log(`pooled: ${all.length.toLocaleString()} refunds across ${picked.length} quarters`);

  const { state, byPc } = aggregate(all);
  console.log('');
  console.log('STATEWIDE');
  console.log(`  returned in full : ${state.full.toLocaleString()}  ${pct1(state.full, state.n)}%`);
  console.log(`  partly withheld  : ${state.partial.toLocaleString()}  ${pct1(state.partial, state.n)}%`);
  console.log(`  none to tenant   : ${state.none.toLocaleString()}  ${pct1(state.none, state.n)}%`);
  console.log(`  median withheld  : $${median(state.withheld)}`);
  console.log(`  median tenancy   : ${median(state.days)} days`);

  // Coverage curve — how many postcodes survive each threshold. Printed so the MIN_N choice
  // is made against the real distribution rather than guessed.
  console.log('');
  console.log('COVERAGE BY THRESHOLD (pooled n)');
  const counts = [...byPc.values()].map((v) => v.n);
  for (const t of [50, 100, 200, 300, 500]) {
    const k = counts.filter((c) => c >= t).length;
    const share = pct1(counts.filter((c) => c >= t).reduce((a, b) => a + b, 0), state.n);
    console.log(`  n>=${String(t).padStart(3)} : ${String(k).padStart(3)} postcodes  (${share}% of all refunds)`);
  }

  const postcodes = {};
  let kept = 0, dropped = 0;
  for (const [pc, v] of [...byPc.entries()].sort()) {
    if (v.n < MIN_N) { dropped++; continue; }
    kept++;
    postcodes[pc] = {
      n: v.n,
      full_pct: pct1(v.full, v.n),
      partial_pct: pct1(v.partial, v.n),
      none_pct: pct1(v.none, v.n),
      median_withheld: median(v.withheld),
      median_days_held: median(v.days),
    };
  }

  const ranked = Object.entries(postcodes).sort((a, b) => b[1].full_pct - a[1].full_pct);
  console.log('');
  console.log(`emitting ${kept} postcodes (min n=${MIN_N}); ${dropped} below threshold omitted`);
  if (ranked.length) {
    console.log(`  best  ${ranked[0][0]} ${ranked[0][1].full_pct}% (n=${ranked[0][1].n})`);
    console.log(`  worst ${ranked[ranked.length - 1][0]} ${ranked[ranked.length - 1][1].full_pct}% (n=${ranked[ranked.length - 1][1].n})`);
    console.log(`  spread ${(ranked[0][1].full_pct - ranked[ranked.length - 1][1].full_pct).toFixed(1)} percentage points`);
  }

  const out = {
    dataset: 'nsw-bond-outcomes',
    description: 'Share of residential rental bonds returned in full to the tenant, by NSW postcode.',
    framing: 'OUTCOME RATE, NOT A FAULT RATE. Money paid to an agent or landlord includes legitimate deductions (unpaid rent, damage, required cleaning). Render as "X% of bonds were returned in full" and never as a measure of landlord or agent behaviour.',
    coverage: 'NSW only. Postcode level — area context, never a statement about an individual property. Postcodes with fewer than ' + MIN_N + ' pooled refunds are omitted entirely.',
    source: 'NSW Fair Trading — Rental bond data',
    source_url: PAGE,
    licence: 'CC BY',
    attribution: 'Based on NSW Fair Trading rental bond data',
    quarters_pooled: picked.map((p) => p.key).sort(),
    min_sample: MIN_N,
    generated: new Date().toISOString().slice(0, 10),
    state: {
      n: state.n,
      full_pct: pct1(state.full, state.n),
      partial_pct: pct1(state.partial, state.n),
      none_pct: pct1(state.none, state.n),
      median_withheld: median(state.withheld),
      median_days_held: median(state.days),
    },
    postcodes,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, 'nsw-bond-outcomes.json');
  fs.writeFileSync(outFile, JSON.stringify(out));
  const kb = (fs.statSync(outFile).size / 1024).toFixed(0);
  console.log('');
  console.log(`wrote ${outFile}  (${kb} kB)`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
