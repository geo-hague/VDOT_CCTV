#!/usr/bin/env node
// build-highways.js <input.geojsonseq> <outDir>
// ---------------------------------------------------------------------------
// Turns an osmium GeoJSON export of a state's motorway/trunk ways into small
// static map tiles the website can fetch on demand (replacing Overpass).
//
//   outDir/t_<iy>_<ix>.json   one file per 0.2° x 0.2° square that has highway
//                             in it: [{ "r": "I 95", "p": [[lat,lon],...] }, ...]
//                             ("n" = road name, used only when a way has no ref)
//   outDir/meta.json          build info (the app checks it exists)
//
// Each segment is added to every tile its bounding box (plus a ~300 m margin)
// touches, so the tile you are standing in always contains every way within
// SNAP_RADIUS_M of you — the app only ever needs ONE tile at a time.
// TILE_DEG must match HIGHWAY_TILE_DEG in 03_highway.js.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const INPUT = process.argv[2] || 'hw.geojsonseq';
const OUT_DIR = process.argv[3] || 'docs/highways';
const TILE_DEG = 0.2;
const MARGIN_DEG = 0.003;
const WANTED = new Set(['motorway', 'trunk']);
const r5 = (n) => Math.round(n * 1e5) / 1e5;      // ~1 m precision
const tileIdx = (v) => Math.floor(v / TILE_DEG);

async function main() {
  const tiles = new Map();                          // "iy_ix" -> [ {r|n, p}, ... ]
  let ways = 0, skipped = 0;

  const rl = readline.createInterface({ input: fs.createReadStream(INPUT), crlfDelay: Infinity });
  for await (let line of rl) {
    line = line.replace(/\x1e/g, '').trim();         // geojsonseq may prefix each record with RS
    if (!line) continue;
    let f; try { f = JSON.parse(line); } catch (e) { skipped++; continue; }
    if (!f.geometry || f.geometry.type !== 'LineString') continue;
    const props = f.properties || {};
    if (!WANTED.has(props.highway)) continue;

    const ref = props.ref ? String(props.ref).trim() : '';
    const name = !ref && props.name ? String(props.name).trim() : '';
    if (!ref && !name) { skipped++; continue; }      // nothing the app could display
    const label = ref ? { r: ref } : { n: name };

    const pts = [];
    for (const [lon, lat] of f.geometry.coordinates) {
      const a = [r5(lat), r5(lon)];
      const l = pts[pts.length - 1];
      if (!l || l[0] !== a[0] || l[1] !== a[1]) pts.push(a);
    }
    if (pts.length < 2) continue;
    ways++;

    const perTile = new Map();                       // tiles this way touches -> its runs there
    for (let i = 0; i < pts.length - 1; i++) {
      const A = pts[i], B = pts[i + 1];
      const y0 = tileIdx(Math.min(A[0], B[0]) - MARGIN_DEG), y1 = tileIdx(Math.max(A[0], B[0]) + MARGIN_DEG);
      const x0 = tileIdx(Math.min(A[1], B[1]) - MARGIN_DEG), x1 = tileIdx(Math.max(A[1], B[1]) + MARGIN_DEG);
      for (let iy = y0; iy <= y1; iy++) for (let ix = x0; ix <= x1; ix++) {
        const key = `${iy}_${ix}`;
        let runs = perTile.get(key);
        if (!runs) { runs = []; perTile.set(key, runs); }
        const last = runs[runs.length - 1];
        const lp = last && last[last.length - 1];
        if (lp && lp[0] === A[0] && lp[1] === A[1]) last.push(B); else runs.push([A, B]);
      }
    }
    for (const [key, runs] of perTile) {
      let t = tiles.get(key);
      if (!t) { t = []; tiles.set(key, t); }
      for (const run of runs) t.push({ ...label, p: run });
    }
  }

  if (!ways) { console.error('No motorway/trunk ways found in input — refusing to wipe existing data.'); process.exit(1); }

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let bytes = 0, biggest = 0;
  for (const [key, arr] of tiles) {
    const s = JSON.stringify(arr);
    fs.writeFileSync(path.join(OUT_DIR, `t_${key}.json`), s);
    bytes += s.length; biggest = Math.max(biggest, s.length);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'meta.json'),
    JSON.stringify({ updated: new Date().toISOString(), tileDeg: TILE_DEG, tiles: tiles.size, ways }));
  console.log(`ways=${ways} skipped=${skipped} tiles=${tiles.size} total=${(bytes / 1048576).toFixed(2)} MB biggest=${(biggest / 1024).toFixed(0)} KB -> ${OUT_DIR}`);
}
main().catch(e => { console.error(e); process.exit(1); });
