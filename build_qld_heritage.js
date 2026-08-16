// Build the self-hosted QLD Heritage Register dataset for lastrenter-data-public.
// Source: qhr.detsi.qld.gov.au FlatGeobuf (CC BY 4.0) → scout extract heritage_qhr_clean.json.
// Output: 1-degree bbox tiles + an index, mirroring the Defence ANEF pattern (client fetches the index,
// picks one tile, does point-in-polygon / radius). Records whose bbox spans tiles are written to each
// tile they touch, so a property near a tile edge can still see a polygon from the next tile over.
const fs = require('fs');
const path = require('path');

const SRC = require('./heritage_qhr_clean.json');
const OUT = path.join(__dirname, 'qld-heritage');
fs.mkdirSync(OUT, { recursive: true });

const R = (n) => Math.round(n * 1e5) / 1e5;          // ~1 m precision
const STEP = 0.25;   // quarter-degree tiles (~28 km)
const tix = (lng) => Math.floor(lng / STEP);
const tiy = (lat) => Math.floor(lat / STEP);

function ringsOf(geom) {
  if (!geom || !geom.coordinates) return null;
  if (geom.type === 'Polygon') return [geom.coordinates[0]];          // outer ring only
  if (geom.type === 'MultiPolygon') return geom.coordinates.map((p) => p[0]);
  return null;
}

// Drop vertices closer than ~4 m to the previous kept one. Heritage curtilages are metre-scale features,
// and the source carries far more precision than a "is this address inside" test can use.
const TOL = 0.00004;                                 // ~4 m in degrees
function thin(ring) {
  if (ring.length <= 4) return ring;
  const out = [ring[0]];
  for (let i = 1; i < ring.length - 1; i++) {
    const p = ring[i], q = out[out.length - 1];
    if (Math.abs(p[0] - q[0]) > TOL || Math.abs(p[1] - q[1]) > TOL) out.push(p);
  }
  out.push(ring[ring.length - 1]);                   // keep the ring closed
  return out.length >= 4 ? out : ring;
}

const tiles = {};
let withPoly = 0, pointOnly = 0;

for (const rec of SRC) {
  if (!isFinite(rec.lon) || !isFinite(rec.lat)) continue;
  const rings = ringsOf(rec.boundary);
  // compact record: [id, name, lng, lat, rings|0]
  let out;
  let minL = rec.lon, maxL = rec.lon, minA = rec.lat, maxA = rec.lat;
  if (rings && rings.length) {
    const packed = rings.map((r0) => {
      const r = thin(r0);
      const pts = [];
      for (const c of r) {
        const x = R(c[0]), y = R(c[1]);
        if (x < minL) minL = x; if (x > maxL) maxL = x;
        if (y < minA) minA = y; if (y > maxA) maxA = y;
        pts.push(x, y);                                   // flat [x,y,x,y,...] — smaller than nested pairs
      }
      return pts;
    });
    out = [rec.qhr_id, rec.place_name, R(rec.lon), R(rec.lat), packed];
    withPoly++;
  } else {
    out = [rec.qhr_id, rec.place_name, R(rec.lon), R(rec.lat), 0];
    pointOnly++;
  }
  // assign to every 1-degree tile the record's bbox touches (pad by ~0.001 deg so edges are safe)
  const pad = 0.001;
  for (let x = tix(minL - pad); x <= tix(maxL + pad); x++) {
    for (let y = tiy(minA - pad); y <= tiy(maxA + pad); y++) {
      const k = `${x}_${y}`;
      (tiles[k] = tiles[k] || []).push(out);
    }
  }
}

let total = 0;
const index = {};
for (const k of Object.keys(tiles).sort()) {
  const body = JSON.stringify(tiles[k]);
  fs.writeFileSync(path.join(OUT, `qld-heritage-${k}.json`), body);
  index[k] = tiles[k].length;
  total += body.length;
}
fs.writeFileSync(path.join(OUT, 'qld-heritage-index.json'), JSON.stringify(index));

const sizes = Object.keys(index).map((k) => fs.statSync(path.join(OUT, `qld-heritage-${k}.json`)).size).sort((a, b) => a - b);
console.log(`records: ${SRC.length} (polygon ${withPoly}, point-only ${pointOnly})`);
console.log(`tiles: ${Object.keys(index).length}, total ${(total / 1024).toFixed(0)}k (source 1721k)`);
console.log(`tile size: median ${(sizes[Math.floor(sizes.length / 2)] / 1024).toFixed(1)}k, max ${(sizes[sizes.length - 1] / 1024).toFixed(1)}k`);
console.log(`index: ${(fs.statSync(path.join(OUT, 'qld-heritage-index.json')).size / 1024).toFixed(1)}k`);
const busiest = Object.entries(index).sort((a, b) => b[1] - a[1]).slice(0, 5);
console.log('busiest tiles:', busiest.map(([k, n]) => `${k}=${n}`).join(' '));
