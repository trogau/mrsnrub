// Headless smoke test for the boardwalk / pier brush tile art (notes/09 §12).
//
// Four layers:
//  1. DRIFT GUARD — re-parses both .bsv3 assets with gen_city_sprites.parse_bsv3
//     (via python3, the same parser tools/gen_pier_tiles.py imports) and
//     diffs every manifest block (cell, crop, pos, matrix), the calib and
//     the state list against web/assets/city/pier-tiles.json.
//  2. MANIFEST invariants — draw order (C_Shadow first), crops inside the
//     sheet PNG (sizes read from the PNG headers), sheet paths exist, the
//     flip block exists, calib equals the shadow-derived values.
//  3. VIEWER integration — the Pixi page loads the manifest, blits through
//     the documented transform chain, hooks applyPierMode everywhere the
//     other art modes hook, and ships the btn-pierart toggle.
//  4. LAB + page integration — the Road Lab pier tab (tab-pier, pt-*) and
//     the cache busters.
//
//   node tools/smoke-pier-tiles.cjs
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.join(__dirname, '..');

let failures = 0;
function check(name, cond, info) {
    if (cond) { console.log('  ok  ' + name); }
    else { failures++; console.log('FAIL  ' + name + (info !== undefined ? '  [' + info + ']' : '')); }
}
function read(p) { return fs.readFileSync(path.join(root, p), 'utf8'); }
function pngSize(p) {
    const b = fs.readFileSync(path.join(root, p));
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

const MAN = 'web/assets/city/pier-tiles.json';
check('manifest exists', fs.existsSync(path.join(root, MAN)));
const man = JSON.parse(read(MAN));

/* ---- 1. drift guard: re-parse the bsv3s with the shared parser ---------- */
const PY = `
import importlib.util, json, os, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__FN__)))
spec = importlib.util.spec_from_file_location('gcs', os.path.join(ROOT, 'tools', 'gen_city_sprites.py'))
gcs = importlib.util.module_from_spec(spec); spec.loader.exec_module(gcs)
out = {}
for key, pack, asset in ((sys.argv[1], sys.argv[2], sys.argv[3]), (sys.argv[4], sys.argv[5], sys.argv[6])):
    blob = open(os.path.join(ROOT, 'web', 'assets', 'dlc', pack, 'data', asset + '.bsv3'), 'rb').read()
    d = gcs.parse_bsv3(blob, asset + '.bsv3')
    first = {n: f0 for n, f0, f1 in d['anims']}
    out[key] = {
        'cells': len(d['cells']), 'frames': d['nf'], 'anims': len(d['anims']),
        'states': {n: [[d['cells'][ci][0], list(d['cells'][ci][1:]),
                        [round(x, 2), round(y, 2)], [a, b, c, e]]
                       for ci, x, y, a, b, c, e in reversed(d['frames'][f0])]
                   for n, f0 in first.items()},
    }
print(json.dumps(out, allow_nan=False))
`.replace('__FN__', JSON.stringify(__filename));
const py = spawnSync('python3', ['-c', PY,
    'boardwalk', 'WaterfrontGame-100-r146180', 'boardwalktiles',
    'pier', 'SpringfieldHeights2BuildDecoGame-100-r284665', 'ornatepiertiles'],
    { encoding: 'utf8', maxBuffer: 64 << 20 });
check('bsv3 re-parse ran', py.status === 0, (py.stderr || '').split('\n').slice(-2).join(' | '));
const fresh = py.status === 0 ? JSON.parse(py.stdout) : {};

for (const t of ['boardwalk', 'pier']) {
    const a = man.assets[t];
    const f = fresh[t] || {};
    check(t + ': sheet + pack files exist',
        fs.existsSync(path.join(root, 'web', a.sheet)) &&
        fs.existsSync(path.join(root, 'web', 'assets', 'dlc', a.pack, 'data',
            (t === 'boardwalk' ? 'boardwalktiles' : 'ornatepiertiles') + '.bsv3')));
    check(t + ': parse stats (drift guard)',
        f.cells && f.frames && f.anims, JSON.stringify(f && { c: f.cells, f: f.frames }));
    for (const s of Object.keys(a.states)) {
        check(t + '/' + s + ': manifest blocks == re-parsed frame (drift guard)',
            JSON.stringify(f.states && f.states[s]) === JSON.stringify(
                a.states[s].map(b => [b.n, b.c, b.p, b.m])),
            'manifest ' + a.states[s].length + ' vs fresh ' +
            ((f.states && f.states[s]) || []).length);
    }
}

/* ---- 2. manifest invariants --------------------------------------------- */
check('manifest names its generator', man.gen === 'tools/gen_pier_tiles.py');
const NORMAL = ['Normal_None', 'Normal_PostLeft', 'Normal_PostRight',
    'Normal_PostLeftAndRight'];
for (const t of ['boardwalk', 'pier']) {
    const a = man.assets[t];
    const f = fresh[t] || {};
    check(t + ': all four Normal states present',
        NORMAL.every(s => Array.isArray(a.states[s]) && a.states[s].length > 0));
    check(t + ': draw order — C_Shadow first in every frame that has it',
        Object.keys(a.states).every(s =>
            !a.states[s].some(b => b.n === 'C_Shadow') ||
            a.states[s][0].n === 'C_Shadow'));
    const sz = pngSize('web/' + a.sheet);
    check(t + ': every crop rect inside the sheet (' + sz.w + 'x' + sz.h + ')',
        Object.keys(a.states).every(s => a.states[s].every(b =>
            b.c[0] >= 0 && b.c[1] >= 0 && b.c[0] + b.c[2] <= sz.w &&
            b.c[1] + b.c[3] <= sz.h)));
    check(t + ': shadow crop matches the PNG',
        a.shadow[0] === 1 && a.shadow[1] === 1 && a.shadow[2] > 500 && a.shadow[3] > 260,
        JSON.stringify(a.shadow));
    const sh = (f.states && f.states.Normal_None || [])
        .filter(b => b[0] === 'C_Shadow')[0];
    check(t + ': calib = -shadow.xy / 4 (the shadow fills the box)',
        sh && Math.abs(a.calib.ox * 4 + sh[2][0]) < 0.02 &&
        Math.abs(a.calib.oy * 4 + sh[2][1]) < 0.02,
        JSON.stringify(a.calib) + ' vs ' + (sh && sh[2]));
    check(t + ': block fields well-formed',
        Object.keys(a.states).every(s => a.states[s].every(b =>
            typeof b.n === 'string' && b.c.length === 4 && b.p.length === 2 &&
            b.m.length === 4 && b.m[1] === 0 && b.m[2] === 0 &&
            b.m[0] !== 0 && b.m[3] !== 0 && b.c[2] > 0 && b.c[3] > 0)));
}
const pierFlips = Object.keys(man.assets.pier.states)
    .filter(s => man.assets.pier.states[s].some(b => b.m[0] < 0));
check('pier art exercises the a<0 mirror case (wave6a)',
    pierFlips.length >= 1 &&
    man.assets.pier.states.Normal_PostRight.some(b => b.n === 'C_PierWave6a' && b.m[0] < 0),
    pierFlips.join(','));
check('boardwalk keeps the extra editor/half states for the lab',
    ['TopOnly', 'PostOnly_PostLeft', 'PostOnly_PostRight',
     'PostOnly_PostLeftAndRight', 'Neutral'].every(s => man.assets.boardwalk.states[s]));

/* ---- 3. viewer integration ---------------------------------------------- */
const pv = read('web/viewer/city-view-pixi.js');
check('viewer fetches the manifest', pv.includes("assets/city/pier-tiles.json"));
check('viewer gates the art behind the pierart pref (ON by default)',
    pv.includes("PIERART_KEY = 'mrsnrub.cityview.pierart'") &&
    pv.includes("!== '0'"));
check('viewer blits one frame per 4x4 brush cell (camera-derived box map)',
    /CAM\.tileAffine\(cam, VW, VH\)/.test(pv) &&
    /s\.setFromMatrix\(new PIXI\.Matrix\(i00 \* fx/.test(pv) &&
    /buildPierCell\(featC, pc\.tn, pc\.tx, pc\.ty, pc\.occ, pc\.arr, 4\)/.test(pv) &&
    /if \(\(pc\.tx & 3\) \|\| \(pc\.ty & 3\)\) continue;/.test(pv));
/* 2026-10-30.23: the frame ORIGIN pins to the cell's front corner (x0, y1)
   at 1:1 art px — the building pivot rule. Measured against the full-res
   in-game export registered by the surrounding BUILDINGS: the
   BarnacleBayMarina brush L lands on its save cells (residual 0 tile); the
   .21/.22 leg-ring "ground corner" offset put it ~48 art px too high and
   centring C_Shadow (.19) ~70 px too high. Guard against both coming back */
check('viewer pins each frame ORIGIN to the cell front corner at 1:1 art px',
    /var K = CAM\.scale\(cam\) \/ ART\.S;/.test(pv) &&
    /var px = tx, py = ty \+ big;/.test(pv) &&
    /pier-tiles\.json\?v=/.test(pv) &&
    /var ex = \(bx \+ PIER_NUDGE\.x\) \* K, ey = \(by \+ PIER_NUDGE\.y\) \* K;/.test(pv) &&
    /px \+ i00 \* ex \+ i01 \* ey, py \+ i10 \* ex \+ i11 \* ey/.test(pv) &&
    !/pierGround|\.ground\b/.test(pv) &&
    !/63\.5|a\.calib\./.test(pv.slice(pv.indexOf('function buildPierCell'), pv.indexOf('function applyPierMode'))));
check('the nudge knob ships at zero (it is for sweeps, not a fudge)',
    /var n = \{ x: 0, y: 0 \};/.test(pv));
for (const t of ['boardwalk', 'pier']) {
    const a = man.assets[t];
    check(t + ': manifest carries no ground-corner offset (the origin IS the pivot)', !('ground' in a));
    /* the deck top's front (bottom) vertex sits within a few art px of the
       origin, so origin-on-corner == deck surface on the cell */
    const tops = a.states.Normal_None.filter(b => /_Top_Crop/.test(b.n));
    const minY = Math.min(...tops.map(b => b.p[1]));
    check(t + ': deck top spans one 256-px cell diamond ending at the origin row',
        minY < -255 && minY > -268, 'deck top y0 ' + minY);
}
/* 2026-10-30.25: a brush cell wholly IN FRONT of a building it overlaps on
   screen is blitted again in the scene pool right after that building
   (BarnacleBayMarina's dock end was painted over the brush L); cells in
   front of a late cell follow it, and buildings standing on it re-emit */
check('viewer redraws brush cells that lie in front of a building (scene over pass)',
    /function inFront\(p, q\)/.test(pv) &&
    /p\.u0 >= q\.u1 - 1e-9 \|\| p\.v0 >= q\.v1 - 1e-9/.test(pv) &&
    /function derivePierOver\(\)/.test(pv) &&
    /if \(po && i && \(po\.at\[i - 1\] \|\| po\.re\[i - 1\]\)\) emitPierOver\(i - 1, A, s, k\);/.test(pv) &&
    /if \(po && buildings\.length\) emitPierOver\(buildings\.length - 1, A, s, k\);/.test(pv) &&
    /pierOver\.recs !== pierRecs/.test(pv));
check('viewer state rule probes the two lower neighbour cells',
    /water\(tx, ty \+ big\)/.test(pv) && /water\(tx \+ big, ty\)/.test(pv) &&
    pv.includes("'Normal_PostLeftAndRight'"));
check('brush cells collected in buildGround and depth-sorted by oriented depth',
    /TI_BOARDWALK = CityTerrain\.TYPE_ORDER\.indexOf\('boardwalk'\)/.test(pv) &&
    /TI_PIER = CityTerrain\.TYPE_ORDER\.indexOf\('pier'\)/.test(pv) &&
    /pierCells\.push/.test(pv) &&
    /CAM\.oriented\(p\.tx, p\.ty\)/.test(pv));
check('viewer rebuilds once the brush sheets have decoded',
    /function settle\(\)/.test(pv));
check('applyPierMode hooks both buildGround and the legend pass',
    (pv.match(/applyPierMode\(\);/g) || []).length >= 2 &&
    pv.includes('function applyPierMode'));
check('a cell\'s frame owns all 16 tile fills and hides them while the art shows',
    /var cellFills = \{\};/.test(pv) &&
    /fills: cellFills\[pc\.tn \+ ':' \+ pc\.tx \+ ',' \+ pc\.ty\]/.test(pv) &&
    /r\.fills\[k\]\.visible = !vis && !terrain\.hidden\[r\.tn\];/.test(pv));

/* ---- 4. page + lab integration ------------------------------------------ */
const html = read('web/viewer/index.html');
check('page ships the pier art toggle', /id="btn-pierart"/.test(html) &&
    /data-tip="[^"]*boardwalk and pier brush tiles/.test(html));
check('page cache-buster bumped for the pier art',
    (html.match(/city-view-pixi\.js\?v=(\d+)/) || [])[1] * 1 >= 43,
    (html.match(/city-view-pixi\.js\?v=(\d+)/) || [])[1]);
const labHtml = read('web/viewer/road-lab.html');
check('lab ships two brush tabs (boardwalk + pier), one per context',
    /id="tab-btn-bw" data-tab="tab-bw"/.test(labHtml) &&
    /id="tab-btn-pier" data-tab="tab-pier"/.test(labHtml) &&
    /id="cv-bw"/.test(labHtml) && /id="cv-pier"/.test(labHtml));
check('each brush tab carries its own control cluster',
    ['bw-zoom-minus', 'bw-zoom-plus', 'bw-water-l', 'bw-water-r', 'bw-force-minus',
     'bw-force-plus', 'bw-force-auto', 'bw-grid', 'bw-calib',
     'pw-zoom-minus', 'pw-zoom-plus', 'pw-water-l', 'pw-water-r', 'pw-force-minus',
     'pw-force-plus', 'pw-force-auto', 'pw-grid', 'pw-calib']
        .every(id => labHtml.includes('id="' + id + '"')));
check('lab cache-buster bumped for the tab split',
    (labHtml.match(/road-lab\.js\?v=(\d+)/) || [])[1] * 1 >= 25,
    (labHtml.match(/road-lab\.js\?v=(\d+)/) || [])[1]);
const lab = read('web/viewer/road-lab.js');
check('lab tab wiring includes both brush panes',
    lab.includes("'tab-bw'") && lab.includes("'tab-pier'") &&
    lab.includes("'tab-btn-bw'") && lab.includes("'tab-btn-pier'") &&
    lab.includes('renderPier(BW);') && lab.includes('renderPier(PW);') &&
    lab.includes('bindPierView(BW);') && lab.includes('bindPierView(PW);') &&
    lab.includes('loadPierManifest();'));
check('the two views are separate objects (own zoom/water/state per tab)',
    /function newPierView\(type, cvId, pre\)/.test(lab) &&
    /BW = newPierView\('boardwalk', 'cv-bw', 'bw'\)/.test(lab) &&
    /PW = newPierView\('pier', 'cv-pier', 'pw'\)/.test(lab) &&
    !/var PIER = \{/.test(lab));
check('lab previews use the viewer transform constants',
    lab.includes('var PIER_SHEET_S = Math.SQRT2 / 127, PIER_SHEET_T = Math.SQRT2 / 66') &&
    lab.includes('pierBlockCTM'));
check('terrain.js points the legacy fills at the Pixi art',
    read('web/js/terrain.js').includes('pier-tiles.json'));

/* ---- evidence files (project rule: user-facing evidence lives in
   mapdump/registration, never only under /tmp) ---------------------------- */
for (const ev of ['mapdump/registration/pier-boardwalk-states.png',
                  'mapdump/registration/pier-pier-states.png']) {
    check('evidence present: ' + ev,
        fs.existsSync(path.join(root, ev)) &&
        fs.statSync(path.join(root, ev)).size > 1000);
}

console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
