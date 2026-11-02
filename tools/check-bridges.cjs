// Headless check of the Pixi viewer's road-bridge pass (notes/09 §10).
// Boots the real bridge module source out of web/viewer/city-view-pixi.js
// against the shipped MAP_DATA + terrain.js decode and prints the placements,
// so they can be compared with tools/bridge-sites.py — the Python reference
// the rule was calibrated against on the full-resolution export.
//
// Expected (this save): 14 pieces = ONE 3-lamppost bridgetop section per road
// cell over water per row (A, B, D: 2 cells x 2 rows; the 4-wide inlet C at
// (252..255, 48..51): 1 cell x 2 rows). Sections butt-join 4 tiles apart,
// which is what puts the game's DOUBLED lampposts at every join (measured
// 2026-10-27 by globe detection on the game screenshot, notes/09 §10). The
// two rows share their along position; the render pass emits one sprite per
// piece, the near row into the layer over the road art and the far row into
// the one under it. The anchors must match
// `python3 tools/bridge-sites.py --place` to the centile.
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = process.argv[2] || path.join(__dirname, '..');
const W = path.join(ROOT, 'web');

global.window = {};
new Function('window', fs.readFileSync(path.join(W, 'js/map-explorer-data.js'), 'utf8'))(global.window);
const M = global.window.MAP_DATA;
global.CAM = require(path.join(W, 'js/camera.js'));
const T = require(path.join(W, 'js/terrain.js'));
const CityTerrain = T.CityTerrain;
let terrain;
try {
    terrain = new CityTerrain(M, {});
} catch (e) {
    console.error('CityTerrain(M) failed: ' + e.message);
    process.exit(1);
}

/* Pull the bridge section out of the viewer verbatim (no copy of the rule
   lives here — if the viewer changes, this check changes with it). */
const src = fs.readFileSync(path.join(W, 'viewer/city-view-pixi.js'), 'utf8');
const a = src.indexOf('/* ---- road bridges');
const b = src.indexOf('window.__CV_BRIDGES');
if (a < 0 || b < 0) { console.error('bridge section markers not found'); process.exit(1); }
const slice = src.slice(a, b)
    .replace(/try \{ if \(localStorage[^\n]*\n/, '')                  // no localStorage
    .replace(/function applyBridgeMode\(\)[\s\S]*?\n    \}\n/, '');   // needs $()
const run = new Function('CityTerrain', 'terrain', 'ART',
    slice + '\nvar segs = deriveBridges();\nreturn { segs: segs, cells: bridgeCells };')(
        CityTerrain, terrain, { S: 64 });
const derive = run.segs;

/* render-pass smoke: run the REAL renderBridges against stubs and fail if
   pieces do not emit at finite screen coords (the v30 lesson: an invisible
   bridge pass sails through every derive-only check) */
const emitted = [];
const fakeTerrain2 = { hidden: {}, _raw: terrain._raw };
const bridgeG = { addChild() {} };
new Function('CityTerrain', 'terrain', 'spriteEntry', 'texFor', 'cityUrl',
    'ART', 'emitBridgeSpr', 'sheetRecs', 'bridgeG', 'artMode', 'citySprites',
    'bridgePools', 'bpns', 'bridgeHideRest',
    slice + '\nrenderBridges({a: 2, b: 1, c: 100, d: 0.5, e: 2, f: 80}, 28,' +
    ' {x0: 140, x1: 262, y0: 10, y1: 90});' +
    '\nreturn { live: bridgeLive };')(
        CityTerrain, fakeTerrain2,
        k => ({ w: 258, h: 267, anchor: [221, 191], png: k + '.png' }),
        () => ({}),
        u => 'assets/city/' + u,
        { S: 64 },
        (t, x, y, w, h, mir, ly) => emitted.push({ x, y, w, h, mir, ly }),
        [],
        bridgeG,
        true,
        true,
        [[], []], [0, 0], () => {});
let rfail = 0;
if (emitted.length !== derive.length) {
    console.error('render pass emitted ' + emitted.length + ' pieces, expected ' +
        derive.length + ' (one sprite per piece)');
    rfail++;
}
const nNear = emitted.filter(e => e.ly === 1).length;
if (nNear * 2 !== emitted.length) {
    console.error('render pass put ' + nNear + ' of ' + emitted.length +
        ' pieces in the near layer, expected exactly half (one row per crossing)');
    rfail++;
}
for (const e of emitted)
    if (!isFinite(e.x) || !isFinite(e.y) || !isFinite(e.w) || !isFinite(e.h) ||
        e.w <= 0 || e.h <= 0 || e.x < 0 || e.y < 0) {
    console.error('render pass emitted a bad sprite: ' + JSON.stringify(e));
    rfail++;
    break;
}
if (rfail === 0) console.log('  render pass: ' + emitted.length + ' pieces OK');
else { console.error('FAIL'); process.exit(1); }

/* The calibration set: the crossings tools/bridge-sites.py derives (A/B/D,
   lamppost lattice of A and B checked against the game screenshot to 0.1
   tile), plus the inlet (C). Two rows per crossing (constant x for +y roads,
   constant y for +x roads), one section per road cell over water, both rows
   on the same along position: the pivot on the cell's max-y edge for +y
   roads, its min-x edge for the mirrored +x ones. `tops` in order of
   increasing along-coordinate (all the deep-piered f4: the export's bank
   ends show the plain deck). `lo`/`hi` bound the along-coordinate: B and C
   are both mirrored +x crossings whose rows sit at 48.10 and 52.60, so the
   row alone does not identify a site.
   DO NOT hand-edit: `node tools/check-bridges.cjs` prints the viewer's derive
   and fails if this table ever disagrees with it. */
const F4 = 'bridgetop_f4';
const WANT = [
    { tag: 'A (road 157,16)', axis: 'y', rows: [155.40, 159.90], mir: 0,
      alongs: [20, 24], tops: [F4, F4] },
    { tag: 'B (road 168..176,49)', axis: 'x', rows: [52.60, 48.10], mir: 1,
      lo: 160, hi: 178, alongs: [168, 172], tops: [F4, F4] },
    { tag: 'C (inlet 252..255,49)', axis: 'x', rows: [52.60, 48.10], mir: 1,
      lo: 248, hi: 258, alongs: [252], tops: [F4] },
    { tag: 'D (road 225,64)', axis: 'y', rows: [223.40, 227.90], mir: 0,
      alongs: [68, 72], tops: [F4, F4] },
];
let fail = 0;
console.log(derive.length + ' bridge pieces derived');
for (const w of WANT) {
    for (let r = 0; r < 2; r++) {
        const key = w.axis === 'y' ? 'x' : 'y';
        const ak = w.axis === 'y' ? 'y' : 'x';
        const got = derive.filter(g => !!g.mir === !!w.mir &&
            Math.abs(g[key] - w.rows[r]) < 0.02 &&
            g[ak] >= (w.lo === undefined ? -Infinity : w.lo) &&
            g[ak] <= (w.hi === undefined ? Infinity : w.hi))
            .sort((p, q) => p[ak] - q[ak]);
        const alongs = got.map(g => +g[ak].toFixed(2));
        const ok = got.length === w.alongs.length &&
            got.every((g, i) => Math.abs(alongs[i] - w.alongs[i]) < 0.02 &&
                g.top === w.tops[i]);
        console.log(`  site ${w.tag} row ${r} @${w.rows[r]}: ${got.length}/` +
            `${w.alongs.length} pieces ${ok ? 'OK' : 'MISMATCH ' +
             JSON.stringify({ alongs, tops: got.map(g => g.top) })}`);
        if (!ok) fail++;
    }
}
if (derive.length !== 14) { console.error('expected 14 pieces, got ' + derive.length); fail++; }
// the road cells whose art must paint over the deck art: the cells over water
// (156,16),(156,20) at A, (168,48),(172,48) at B, (252,48) at C, (224,64),
// (224,68) at D, plus the road cell past each end of every crossing (the far
// row's end section reaches a few px over that boundary; raised, the road
// covers it instead of the bridge layer painting a hairline over the road)
const WANT_CELLS = ['156,12', '156,16', '156,20', '156,24',
                    '164,48', '168,48', '172,48', '176,48',
                    '224,60', '224,64', '224,68', '224,72',
                    '248,48', '252,48', '256,48'];
const cells = Object.keys(run.cells).sort();
if (cells.join(',') !== WANT_CELLS.slice().sort().join(',')) {
    console.error('crossing cells mismatch: got ' + cells.join(',') +
                  ' want ' + WANT_CELLS.join(','));
    fail++;
} else console.log('  crossing cells: ' + WANT_CELLS.length + '/' +
                   WANT_CELLS.length + ' OK');
if (fail) { console.error('FAIL'); process.exit(1); }
console.log('bridge check OK');
