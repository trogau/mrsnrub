// Headless tests for web/js/camera.js (Phase 2, M0 camera model).
// Covers the M0 gate invariants: tile/world round-trip, pan invariance,
// zoom-at-point stability, the narrow zoom-in-biased base-game clamps,
// the unclamped full-town convenience fit, depth sort, and inertia.
//
//   node tools/smoke-camera.cjs
'use strict';
const fs = require('fs');
const path = require('path');
const CAM = require(path.join(__dirname, '..', 'web', 'js', 'camera.js'));

let failures = 0;
function check(name, cond, info) {
    if (cond) { console.log('  ok  ' + name); }
    else { failures++; console.log('FAIL  ' + name + (info !== undefined ? '  [' + info + ']' : '')); }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const VW = 1280, VH = 800;

console.log('tile <-> world round-trip:');
for (const [tx, ty] of [[0, 0], [12, 136], [255, 480], [-3.5, 2.25], [10.5, -7.5]]) {
    const w = CAM.tileToWorld(tx, ty);
    const t = CAM.worldToTile(w.x, w.y);
    check(`round-trip (${tx},${ty})`, near(t.x, tx) && near(t.y, ty), JSON.stringify(t));
}

console.log('2:1 oblique diamond:');
{
    const a = CAM.tileToWorld(0, 0);
    // tile (0,0) occupies [-0.5,0.5]^2 in tile space; map its 4 corners
    const cs = [[0.5, -0.5], [0.5, 0.5], [-0.5, 0.5], [-0.5, -0.5]]
        .map(([x, y]) => CAM.tileToWorld(x, y));
    const xs = cs.map(p => p.x), ys = cs.map(p => p.y);
    const wide = Math.max(...xs) - Math.min(...xs);
    const tall = Math.max(...ys) - Math.min(...ys);
    check('tile diamond is 2:1 (w=2hw, h=2hh)',
        near(wide, 2 * CAM.TILE.hw) && near(tall, 2 * CAM.TILE.hh) && near(wide / tall, 2),
        `wide=${wide} tall=${tall}`);
    check('tile centre at world origin for (0,0)', near(a.x, 0) && near(a.y, 0));
    // adjacent centres sit at (±hw, ±hh) — the diamond edges, 2:1 slope.
    // By definition (via CAM.oriented): swap=0 → (1,0)=(fx·hw, fx·hh),
    // (0,1)=(−fy·hw, fy·hh); swap=1 swaps which axis gets which pair.
    const o = CAM.ORIENT;
    const b = CAM.tileToWorld(1, 0);
    const c = CAM.tileToWorld(0, 1);
    const bE = o.swap ? { x: -o.fy * CAM.TILE.hw, y: o.fy * CAM.TILE.hh }
                      : { x: o.fx * CAM.TILE.hw, y: o.fx * CAM.TILE.hh };
    const cE = o.swap ? { x: o.fx * CAM.TILE.hw, y: o.fx * CAM.TILE.hh }
                      : { x: -o.fy * CAM.TILE.hw, y: o.fy * CAM.TILE.hh };
    check('adjacent centre offset has 2:1 slope', near(b.x, bE.x) && near(b.y, bE.y)
        && near(Math.abs(b.x / b.y), 2) && near(c.x, cE.x) && near(c.y, cE.y),
        JSON.stringify({ b, c, bE, cE }));
}

console.log('depth sort (painter order, oriented):');
{
    const o = CAM.ORIENT;
    // sort order must agree with increasing world-Y of the tile centre
    const wy = t => CAM.tileToWorld(t.x, t.y).y;
    const a = { x: 10, y: 40 }, b = { x: 5, y: 20 };
    check('painter order follows increasing world-Y',
        Math.sign(CAM.compareDepth(a, b)) === Math.sign(wy(a) - wy(b)),
        `${CAM.compareDepth(a, b)} vs ${wy(a) - wy(b)}`);
    // tie group: tiles with equal oriented depth (u+v). Stepping along
    // (fy, −fx) keeps u+v constant for either swap state (fx,fy = ±1).
    const ties = [0, 1, 2, 3].map(k => ({ x: 30 + k * o.fy, y: 30 - k * o.fx }));
    const ukey = t => (o.swap ? t.y : t.x) * o.fx;      // oriented u, spelled out
    const expected = ties.slice().sort((p, q) => ukey(p) - ukey(q))
        .map(t => t.x + ',' + t.y).join('|');
    const got = ties.slice().sort(CAM.compareDepth).map(t => t.x + ',' + t.y).join('|');
    check('same-depth tie broken by oriented u', got === expected, got);
    // ocean anchor (notes/06 §9/§10, ORIENT {1,−1,1}): the sea patch is
    // COLUMN-major and sits WEST of the town frame (grid x ≈ −64..0,
    // wave marks −31..−7 running the coast y 0..512 — Squid Port side;
    // water props at x −44..1, road min x = 0), so under the shipped
    // ORIENT the sea band renders LEFT-and-below the town centre. (The
    // final world orientation vs the Android export is pending landmark
    // calibration; this anchor pins the shipped default against silent
    // regressions.)
    const oceanMid = CAM.tileToWorld(-38, 120), townMid = CAM.tileToWorld(280, 340);
    check('ocean band renders left-below of town centre (ORIENT {1,-1,1})',
        oceanMid.x < townMid.x && oceanMid.y > townMid.y,
        JSON.stringify({ oceanMid, townMid }));
    // data asymmetry: wave marks hug the frame's outer edge — 1483/1582
    // marks sit at frame cols 2..13 (deep-water side, grid x ≈ −31..−20)
    // vs 99 at cols 14..26 (shore side). So the dense sub-band is
    // FARTHER from the town.
    const dense = CAM.tileToWorld(-38, 120), sparse = CAM.tileToWorld(-25, 120);
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    check('dense wave-mark sub-band is the deep-water (outer) edge',
        d(dense, townMid) > d(sparse, townMid), JSON.stringify({ dense, sparse }));
}

console.log('pan invariance (point under the pointer stays put):');
{
    const cam = CAM.createCamera({ x: 10, y: 20 });
    const px = 431, py = 217;
    const before = CAM.screenToWorld(cam, px, py, VW, VH);
    CAM.panByScreen(cam, 123.4, -56.7);
    const after = CAM.screenToWorld(cam, px + 123.4, py - 56.7, VW, VH);
    check('world point follows the pointer', near(before.x, after.x) && near(before.y, after.y),
        JSON.stringify({ before, after }));
    const s0 = CAM.PX_PER_UNIT * CAM.ZOOM.rest;
    check('centre shifted exactly by -delta/scale',
        near(cam.x, 10 - 123.4 / s0) && near(cam.y, 20 + 56.7 / s0),
        `cam=(${cam.x},${cam.y})`);
}

console.log('zoom-at-point stability:');
{
    const cam = CAM.createCamera({ x: 10, y: 20 });
    const px = 812, py = 333;
    const before = CAM.screenToWorld(cam, px, py, VW, VH);
    CAM.zoomAt(cam, 1.5, px, py, VW, VH);
    const after = CAM.screenToWorld(cam, px, py, VW, VH);
    check('cursor world point fixed across zoom', near(before.x, after.x) && near(before.y, after.y),
        JSON.stringify({ before, after }));
    check('zoom applied', near(cam.zoom, 1.5), cam.zoom);
}

console.log('zoom clamps (workbench range, base-game fidelity kept):');
{
    const cam = CAM.createCamera();
    check('rests at 1.0', near(cam.zoom, 1.0));
    CAM.wheel(cam, +20000, VW / 2, VH / 2, VW, VH); // scroll out hard (past the floor)
    check('wheel out bottoms out at ZOOM.wbMin', near(cam.zoom, CAM.ZOOM.wbMin), cam.zoom);
    CAM.wheel(cam, -20000, VW / 2, VH / 2, VW, VH); // scroll in hard (past the ceiling)
    check('wheel in clamps at ZOOM.max', near(cam.zoom, CAM.ZOOM.max), cam.zoom);
    check('base-game fidelity constants kept (rest/min/max/ladder)',
        CAM.ZOOM.rest === 1.0 && CAM.ZOOM.min === 1.0 && CAM.ZOOM.max <= 1.5 &&
        JSON.stringify(CAM.ZOOM.steps) === '[1,1.25,1.5]', JSON.stringify(CAM.ZOOM));
    CAM.zoomAt(cam, 1.0 / cam.zoom, VW / 2, VH / 2, VW, VH); // back to rest
    CAM.zoomStep(cam, VW / 2, VH / 2, VW, VH); // rest → step 1
    check('double-click at rest steps in (ladder)', near(cam.zoom, CAM.ZOOM.steps[1]), cam.zoom);
    CAM.zoomStep(cam, VW / 2, VH / 2, VW, VH); // → max
    check('steps climb to max', near(cam.zoom, CAM.ZOOM.max), cam.zoom);
    CAM.zoomStep(cam, VW / 2, VH / 2, VW, VH); // at max → wrap back to rest
    check('double-click at max wraps back to rest', near(cam.zoom, 1.0), cam.zoom);
    // zoom-at-point still holds while stepping (cursor fixed)
    const w0 = CAM.screenToWorld(cam, 300, 200, VW, VH);
    CAM.zoomStep(cam, 300, 200, VW, VH);
    const w1 = CAM.screenToWorld(cam, 300, 200, VW, VH);
    check('step zoom keeps the cursor point fixed', near(w0.x, w1.x) && near(w0.y, w1.y));
    CAM.zoomAt(cam, 1.4 / cam.zoom, VW / 2, VH / 2, VW, VH); // wheel → mid-ladder (1.4)
    CAM.zoomStep(cam, VW / 2, VH / 2, VW, VH);
    check('step from mid-ladder (1.4) snaps up to max', near(cam.zoom, CAM.ZOOM.max), cam.zoom);

    // regression (user report 2026-10-17): from an unclamped preset scale,
    // the FIRST wheel notch must move zoom continuously — the old
    // [ZOOM.min, ZOOM.max] gesture clamp snapped 0.02 → 1.0 in one jump —
    // and the user must be able to wheel back OUT to the preset scale.
    const p = CAM.createCamera();
    CAM.fitTileRect(p, { x0: 0, y0: 0, x1: 470, y1: 500 }, VW, VH);   // whole-town fit
    const z0 = p.zoom;
    check('preset sits below rest zoom (precondition)', z0 < 1.0, z0);
    CAM.wheel(p, -100, VW / 2, VH / 2, VW, VH);                       // one notch in
    check('one notch from a zoomed-out preset is continuous (no clamp jump)',
        p.zoom > z0 && p.zoom < z0 * 1.5, `${z0} -> ${p.zoom}`);
    CAM.wheel(p, +1200, VW / 2, VH / 2, VW, VH);                      // scroll out hard
    check('can zoom back out to (and below) the preset scale', p.zoom < z0, p.zoom);
    const zPre = p.zoom;
    CAM.zoomStep(p, VW / 2, VH / 2, VW, VH);                          // dblclick from floor
    check('double-click from preset scale steps in smoothly (no leap to rest)',
        p.zoom > zPre && p.zoom < zPre * 1.6, `${zPre} -> ${p.zoom}`);
    for (let i = 0; i < 40 && p.zoom < 1.0 - 1e-9; i++) CAM.zoomStep(p, VW / 2, VH / 2, VW, VH);
    check('repeated double-clicks land exactly on the rest ladder', near(p.zoom, 1.0), p.zoom);
}

console.log('full-town convenience fit (unclamped, outside base clamps):');
{
    // the Map Explorer town crop is ~470x500 tiles; fit must go well below rest
    const cam = CAM.createCamera();
    CAM.fitTileRect(cam, { x0: 0, y0: 0, x1: 470, y1: 500 }, VW, VH);
    check('fit zoom is below rest zoom', cam.zoom < CAM.ZOOM.rest && cam.zoom > 0, cam.zoom);
    const z2 = CAM.fitZoom(CAM.tileRectToWorldRect({ x0: 0, y0: 0, x1: 470, y1: 500 }), VW, VH);
    check('fitZoom agrees with fitTileRect', near(z2, cam.zoom), z2);
    // unclamped zoomAt may leave the base range when asked to
    const cam2 = CAM.createCamera();
    CAM.zoomAt(cam2, 0.2, VW / 2, VH / 2, VW, VH, { unclamped: true });
    check('unclamped zoomAt leaves the range when asked', near(cam2.zoom, 0.2), cam2.zoom);
}

console.log('inertia (released drag):');
{
    const cam = CAM.createCamera({ x: 0, y: 0 });
    CAM.setFling(cam, 99999, 0);
    check('fling velocity clamped to maxSpeed', near(cam.vx, CAM.PAN.maxSpeed), cam.vx);
    const x0 = cam.x;
    for (let i = 0; i < 600; i++) CAM.tick(cam, 1 / 60);
    check('inertia stops below minSpeed', cam.vx === 0 && cam.vy === 0, cam.vx);
    check('camera actually moved during the fling', cam.x !== x0, cam.x);
    const cam2 = CAM.createCamera({ x: 0, y: 0 });
    CAM.tick(cam2, 1 / 60); // no fling: no-op
    check('tick is a no-op with no velocity', near(cam2.x, 0) && near(cam2.y, 0));
}

console.log('screen mapping sanity:');
{
    const cam = CAM.createCamera({ x: 0, y: 0 });
    const c = CAM.worldToScreen(cam, 0, 0, VW, VH);
    check('world centre maps to viewport centre', near(c.x, VW / 2) && near(c.y, VH / 2));
    const p = CAM.worldToScreen(cam, 1, 0, VW, VH);
    check('one world unit = PX_PER_UNIT px at rest', near(p.x - VW / 2, CAM.PX_PER_UNIT), p.x);
    const rt = CAM.screenToWorld(cam, c.x, c.y, VW, VH);
    check('screen round-trip at centre', near(rt.x, 0) && near(rt.y, 0));
    // culling rect: world rect fully inside viewport
    const sr = CAM.worldRectToScreenRect(cam, { x0: -1, y0: -1, x1: 1, y1: 1 }, VW, VH);
    check('worldRectToScreenRect sane', sr.x0 < sr.x1 && sr.y0 < sr.y1
        && sr.x0 >= 0 && sr.y1 <= VH, JSON.stringify(sr));
}

console.log('orientation rig (swap, dihedral group, groundTransform):');
{
    const save = CAM.ORIENT;
    const key = x => [x.fx, x.fy, x.swap].join(',');
    // group closure from a canonical start: rotate90 cycles 4, mirror doubles to 8
    let o = { fx: 1, fy: 1, swap: 0 };
    const states = [];
    for (let i = 0; i < 4; i++) { states.push(o); o = CAM.orientRotate90(o); }
    check('rotate90 cycles 4 states back to start', key(o) === '1,1,0', key(o));
    check('rotate90 states distinct', new Set(states.map(key)).size === 4);
    check('mirror is an involution', key(CAM.orientMirror(CAM.orientMirror(states[2]))) === key(states[2]));
    const all = states.concat(states.map(s => CAM.orientMirror(s)));
    check('8 distinct orientations reachable', new Set(all.map(key)).size === 8, all.map(key).join(' '));

    // every state: tile round-trip + depth/world consistency via CAM.oriented
    let ok = true;
    for (const st of all) {
        CAM.ORIENT = st;
        for (const [x, y] of [[0, 0], [137, 421], [-8, 33.5]]) {
            const w = CAM.tileToWorld(x, y), t = CAM.worldToTile(w.x, w.y);
            const uv = CAM.oriented(x, y);
            if (!(near(t.x, x) && near(t.y, y)
                && near(w.x, (uv[0] - uv[1]) * CAM.TILE.hw)
                && near(w.y, (uv[0] + uv[1]) * CAM.TILE.hh)
                && near(CAM.depth(x, y), uv[0] + uv[1]))) ok = false;
        }
    }
    CAM.ORIENT = save;
    check('round-trip + depth agree with oriented() in all 8 states', ok);

    // terrain.js groundTransform (the grass/matrix path) must equal the CAM
    // projection's tile->px matrix in every state — one projection, two paths.
    global.CAM = CAM;
    global.window = global.window || {};
    const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'js', 'map-explorer-data.js'), 'utf8');
    global.window.MAP_DATA = JSON.parse(src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1));
    const { CityTerrain } = require(path.join(__dirname, '..', 'web', 'js', 'terrain.js'));
    const terr = new CityTerrain(global.window.MAP_DATA);
    const cam = CAM.createCamera({ x: 3, y: -7, zoom: 1.25 });
    let gok = true;
    for (const st of all) {
        CAM.ORIENT = st;
        const tf = terr.groundTransform(cam, VW, VH);
        const s = CAM.scale(cam);
        const c0 = CAM.tileToWorld(0, 0), ex = CAM.tileToWorld(1, 0), ey = CAM.tileToWorld(0, 1);
        if (!(near(tf[0], (ex.x - c0.x) * s) && near(tf[1], (ex.y - c0.y) * s)
            && near(tf[2], (ey.x - c0.x) * s) && near(tf[3], (ey.y - c0.y) * s))) gok = false;
    }
    CAM.ORIENT = save;
    check('terrain groundTransform follows CAM projection in all 8 states', gok);
}

console.log('solid sea base fill:');
{
    const { CityTerrain, SEA_RGB } = require(path.join(__dirname, '..', 'web', 'js', 'terrain.js'));
    const M = global.window.MAP_DATA;
    const terr = new CityTerrain(global.window.MAP_DATA);
    const w = CAM.tileToWorld(-44, 120);   // centre of the water polygon (west of the shoreline)
    const cam = CAM.createCamera({ x: w.x, y: w.y, zoom: 0.1 });
    const fills = [];
    const state = { f: null, tf: [] };
    const ctx = new Proxy({}, {
        get(_t, k) {
            if (k === 'fillRect') return (x, y, w, h) => fills.push({ x, y, w, h, f: state.f, tf: state.tf.slice() });
            if (k === 'save' || k === 'restore' || k === 'beginPath' || k === 'moveTo' || k === 'lineTo' || k === 'closePath' || k === 'fill') return () => {};
            if (k === 'setTransform') return (...a) => { state.tf = a; };
            if (k === 'createPattern') return () => null;
            return () => {};   // any other canvas op is a no-op
        },
        set(_t, k, v) { if (k === 'fillStyle') state.f = v; return true; }
    });
    terr.render(ctx, cam, VW, VH, 1);
    const want = 'rgb(' + SEA_RGB.join(',') + ')';
    const sea = fills.find(f => f.f === want);
    check('sea base fill painted with RE export blue', !!sea, fills.map(f => f.f).join('|'));
    if (sea) {
        check('sea base spans the water polygon west of the shoreline',
            near(sea.x, terr.seaFillX0 - M.ox) && near(sea.y, terr.seaFillY0 - M.oy) &&
            near(sea.w, terr.seaFillX1 - terr.seaFillX0) && near(sea.h, terr.seaFillY1 - terr.seaFillY0),
            JSON.stringify(sea));
        // ground transform must be the same skewed basis as the grass fill
        const tf = terr.groundTransform(cam, VW, VH);
        check('sea base uses the shared ground transform',
            sea.tf.map((v, i) => near(v, tf[i] * 1)).every(Boolean));
    }
    // invariant: every wave mark must sit on the water polygon
    const OB = terr.typeBBox[0];   // ocean marks (town coords)
    check('wave marks lie on the water polygon',
        OB.x0 >= terr.seaFillX0 - M.ox - 1 && OB.x1 <= terr.seaFillX1 - M.ox + 1 &&
        OB.y0 >= terr.seaFillY0 - M.oy - 1 && OB.y1 <= terr.seaFillY1 - M.oy + 1,
        JSON.stringify(OB));
    // the water polygon must not swallow any road cell. seaFill* are GRID
    // (town + ox), so compare in town tiles: the shoreline is tile x 0
    // (landinfo GridTypeMap shoreline -3..0) and the roads start at x 4
    const RB = terr.typeBBox[4];   // road (town coords)
    check('shoreline stays west of the road grid',
        terr.seaFillX1 - M.ox === 0 && RB && terr.seaFillX1 - M.ox <= RB.x0,
        (terr.seaFillX1 - M.ox) + ' vs road x0 ' + (RB && RB.x0));
    // and the sea is landinfo's, in TOWN TILES (the old defaults were tile
    // numbers stored as grid, which drew it 12 west / 136 north)
    check('sea spans landinfo bounds in town tiles (x -80..0, y -160..704)',
        terr.seaFillX0 - M.ox === -80 && terr.seaFillY0 - M.oy === -160 &&
        terr.seaFillY1 - M.oy === 704,
        [terr.seaFillX0 - M.ox, terr.seaFillX1 - M.ox, terr.seaFillY0 - M.oy, terr.seaFillY1 - M.oy].join());
}

console.log('legend visibility toggles:');
{
    const { CityTerrain, SEA_RGB } = require(path.join(__dirname, '..', 'web', 'js', 'terrain.js'));
    /* raw path: the paint pipeline must still be able to draw EVERY
       layer, so test it with the speckle filter off (its own block below
       covers the filter). CORRECTED 2026-10-19: with the true cell
       decode the sand beaches sit NE of town (typeBBox x 412..543) —
       the old camera framing followed the per-tile-decode artefacts, so
       frame the whole map instead. */
    const terr = new CityTerrain(global.window.MAP_DATA, { speckleFilter: false });
    const w = CAM.tileToWorld(150, 60);   // whole-map frame: sea, town, NE beaches
    const cam = CAM.createCamera({ x: w.x, y: w.y, zoom: 0.04 });
    function styles() {
        const seen = [];
        const state = { tf: [] };
        const ctx = new Proxy({}, {
            get(_t, k) {
                if (k === 'setTransform') return (...a) => { state.tf = a; };
                if (k === 'createPattern') return () => null;
                return () => {};
            },
            set(_t, k, v) { if (k === 'fillStyle') seen.push(String(v)); return true; }
        });
        terr.render(ctx, cam, 1600, 900, 1);
        return seen;
    }
    const rgb = a => 'rgb(' + a.join(',') + ')';
    const SAND = rgb([223, 206, 138]), MARKS = rgb([120, 190, 255]);
    const GRASS = rgb(global.window.MAP_DATA.grass), SEA = rgb(SEA_RGB);
    let s = styles();
    check('all types paint when visible',
        s.includes(GRASS) && s.includes(SAND) && s.includes(SEA),
        [s.includes(GRASS), s.includes(SAND), s.includes(SEA)].join(','));
    /* 2026-10-28: oceanData is the boardwalk/pier brush cell grid, not a
       wave-mark frame (notes/09 §12) — the ocean layer paints no tiles */
    check('no wave-mark tiles (oceanData is brush cells)', !s.includes(MARKS));
    terr.setVisible('sand', false);
    terr.setVisible('ocean', false);
    s = styles();
    check('hiding sand drops its diamonds', !s.includes(SAND));
    check('hiding ocean drops wave marks AND the sea base',
        !s.includes(MARKS) && !s.includes(SEA));
    check('hiding other types keeps the grass base', s.includes(GRASS));
    terr.setVisible('ocean', true);
    s = styles();
    check('re-showing ocean restores the sea base', s.includes(SEA));
    check('isHidden mirrors setVisible', terr.isHidden('sand') && !terr.isHidden('ocean'));

    // static guard (no browser here): the legend overlays the stage, so
    // every stage input gesture must bail out over a .legend panel or the
    // pan gesture + setPointerCapture steals the legend buttons' clicks.
    const cvjs = fs.readFileSync(path.join(__dirname, '..', 'web', 'js', 'city-view.js'), 'utf8');
    check('stage gestures skip presses over the legends (overUI guard)',
        /function overUI\(/.test(cvjs) && /closest\(['"]\.legend['"]\)/.test(cvjs) &&
        /pointerdown[\s\S]{0,200}overUI\(e\)/.test(cvjs) &&
        /wheel[\s\S]{0,120}overUI\(e\)/.test(cvjs) &&
        /dblclick[\s\S]{0,120}overUI\(e\)/.test(cvjs),
        'overUI guard missing from a stage handler');
    check('render() honours the object-legend buckets',
        /objHidden\[b\.cat\]/.test(cvjs) && /objHidden\.people/.test(cvjs) &&
        /CityObjects\.classify/.test(cvjs));
}

console.log('cell decode + inert speckle filter (road-spec.json, notes/01):');
{
    const { CityTerrain, decodeCells, CELL_OX, CELL_OY } =
        require(path.join(__dirname, '..', 'web', 'js', 'terrain.js'));
    const M = global.window.MAP_DATA;
    const t0 = new CityTerrain(M, { speckleFilter: false });
    const t1 = new CityTerrain(M, { speckleFilter: true });
    const cnt = (t, n) => t.features.filter(f => CityTerrain.TYPE_ORDER[f[2]] === n).length;
    check('filter toggle still ships ON (inert while policy table is empty)',
        new CityTerrain(M).speckleFilter === true &&
        Object.keys(CityTerrain.SPECKLE_POLICY).length === 0);
    const L = n => M.layers.find(l => l.n === n).s;
    const rc = decodeCells(L('road')), vc = decodeCells(L('river'));
    check('roadsData = 1647 cells (392 P + 1255 nibbled), riversData = 170',
        rc.length === 1647 && rc.filter(c => c.p).length === 392 &&
        vc.length === 170, rc.length + '/' + vc.length);
    check('stride-37 nibble reciprocity is exact (roads)', (() => {
        const map = {};
        rc.forEach(c => { map[(c.x - CELL_OX) / 4 + ',' + (c.y - CELL_OY) / 4] = c; });
        let ok = 0, tot = 0;
        rc.forEach(c => {
            if (c.p) return;
            const x = (c.x - CELL_OX) / 4, y = (c.y - CELL_OY) / 4;
            [[1, 1, 0, 2], [2, -1, 0, 1], [4, 0, -1, 8], [8, 0, 1, 4]].forEach(([b, dx, dy, nb]) => {
                if (c.m & b) { tot++; const n = map[(x + dx) + ',' + (y + dy)];
                    if (n && (n.m & nb)) ok++; }
            });
        });
        return tot > 2000 && ok === tot;
    })());
    check('filter on/off identical now — sand/dirtroad/klsroad were real',
        t0.features.length === t1.features.length &&
        cnt(t1, 'sand') === 632 && cnt(t1, 'dirtroad') === 94 &&
        cnt(t1, 'klsroad') === 16 && cnt(t1, 'road') === 1647 &&
        cnt(t1, 'river') === 170);
    check('cell features carry nibble+span (road entry [x,y,ti,m,p,4])', (() => {
        const f = t0.features.find(f => CityTerrain.TYPE_ORDER[f[2]] === 'road' && f[3] >= 0);
        return !!f && f[5] === 4 && f[3] >= 1;
    })());
    check('river cells hug SpringfieldLake south shore + east outlet (calibrated origin)', (() => {
        const R = i => CityTerrain.TYPE_ORDER[i] === 'river';
        return t0.typesAt(264, 20).some(R) && t0.typesAt(294, 14).some(R) &&
            // old (-48) origin put the river THROUGH the lake (anchor 264,14)
            // and left the shore dry — reject that frame explicitly:
            !t0.typesAt(264, 14).some(R) && !t0.typesAt(216, 20).some(R);
    })(), JSON.stringify(t0.typesAt(264, 20)) + '/' + JSON.stringify(t0.typesAt(294, 14)));
    check('road nibble selects RoadDrawer states (W->-x fixed); P -> flat state 0',
        JSON.stringify(CityTerrain.cellStateFor(3)) === '[3,false]' &&   // E-W straight
        JSON.stringify(CityTerrain.cellStateFor(12)) === '[4,false]' &&  // N-S straight
        JSON.stringify(CityTerrain.cellStateFor(-1)) === '[0,false]',
        JSON.stringify([CityTerrain.cellStateFor(3), CityTerrain.cellStateFor(12)]));
    check('road occupancy = every tile of every road cell (1647*16)',
        Object.keys(new CityTerrain(M, {})._roadOccAll).length === 1647 * 16);
    t1.setSpeckleFilter(false);
    check('setSpeckleFilter round-trips live without changing the set',
        t1.features.length === t0.features.length);
    t1.setSpeckleFilter(true);
    check('...and back', t1.features.length === t0.features.length);
    const cvjs2 = fs.readFileSync(path.join(__dirname, '..', 'web', 'js', 'city-view.js'), 'utf8');
    check('city-view wires the legend row + persistence + re-construct opts',
        /mrsnrub\.cityview\.speckle/.test(cvjs2) &&
        /setSpeckleFilter\(/.test(cvjs2) &&
        /new CityTerrain\(M, \{ speckleFilter: speckOn, roadNetwork: roadNetOn \}\)/.test(cvjs2));
}

console.log('walk paths oracle (notes/06, walks.js):');
{
    const { CityTerrain } = require(path.join(__dirname, '..', 'web', 'js', 'terrain.js'));
    const CityWalks = require(path.join(__dirname, '..', 'web', 'js', 'walks.js'));
    const M = global.window.MAP_DATA;
    check('generator exports deduped pathCache polylines',
        Array.isArray(M.walks) && M.walks.length === 846 &&
        M.walks.every(w => w.length >= 4 && w.length % 2 === 0),
        M.walks && M.walks.length + ' polylines');
    const t = new CityTerrain(M, {});
    const c = CityWalks.census(M.walks, t._roadOccAll, M.ox, M.oy);
    const colXs = c.cols.map(o => o.x), rowYs = c.rows.map(o => o.y);
    check('census candidate lattice is exact (cols x≡3 mod 4, rows y≡0 mod 4)',
        colXs.every(x => ((x % 4) + 4) % 4 === 3) && rowYs.every(y => y % 4 === 0));
    check('census is town-frame + on-road filter bites: saved-road avenues excluded, only unsaved lines survive',
        JSON.stringify(colXs) === JSON.stringify([-21, -17, 187]) &&
        JSON.stringify(rowYs) === JSON.stringify([-60]) &&
        // the measured walk avenues ride SAVED road cells under the
        // calibrated origin (the "unsaved grid" story was the old shifted
        // filter probing 12/136 tiles away) — they must NOT be candidates:
        [183, 203, 143, 115, 99, 63, 27].every(x => !colXs.includes(x)),
        colXs.join(',') + ' | ' + rowYs.join(','));
    check('census lattice is filter-invariant now (filter inert: raw == active roads) + raw is wired',
        JSON.stringify(CityWalks.census(M.walks, t._roadOcc, M.ox, M.oy)) ===
        JSON.stringify(c) &&
        /_roadOccAll/.test(fs.readFileSync(path.join(__dirname, '..', 'web', 'js', 'city-view.js'), 'utf8')));
    check('every segment axis-aligned in the source data (0 diagonals)',
        M.walks.every(w => {
            for (let j = 0; j + 3 < w.length; j += 2)
                if (w[j] !== w[j + 2] && w[j + 1] !== w[j + 3]) return false;
            return true;
        }));
    // World-alignment oracle (2026-10-25): the cell-grid origin must sit so
    // characters' cached walks land ON road cells and building anchors stay
    // OFF them. The land-block check pins the origin only mod 16, so this
    // is the sole guard against 16-multiple x/y drift (a 48-tile westward
    // error shipped unnoticed for months).
    const T2 = require(path.join(__dirname, '..', 'web', 'js', 'terrain.js'));
    check('cell origin pinned by walk/building oracles (CELL_OX=0, CELL_OY=-112)',
        T2.CELL_OX === 0 && T2.CELL_OY === -112,
        [T2.CELL_OX, T2.CELL_OY].join(','));
    check('>=75% of in-grid walk tiles ride on saved road cell tiles', (() => {
        const occ = t._roadOccAll;
        let inG = 0, hit = 0;
        const seen = new Set();
        for (const w of M.walks)
            for (let j = 0; j + 3 < w.length; j += 2) {
                const x0 = Math.min(w[j], w[j + 2]), x1 = Math.max(w[j], w[j + 2]);
                const y0 = Math.min(w[j + 1], w[j + 3]), y1 = Math.max(w[j + 1], w[j + 3]);
                for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
                    const k = x + ',' + y;
                    if (seen.has(k)) continue;
                    seen.add(k);
                    if (x < T2.CELL_OX || y < T2.CELL_OY ||
                        x >= T2.CELL_OX + 592 || y >= T2.CELL_OY + 944) continue;
                    inG++; if (occ[k]) hit++;
                }
            }
        return inG > 4000 && hit / inG >= 0.75;
    })());
    check('>=85% of building anchors sit OFF road cell tiles', (() => {
        const occ = t._roadOccAll;
        let on = 0;
        for (const b of M.buildings) if (occ[b[6] + ',' + b[7]]) on++;
        return on / M.buildings.length <= 0.15;
    })());
    {
        let strokes = 0, fills = 0;
        const ctx = new Proxy({}, {
            get(_t, k) {
                if (k === 'stroke') return () => { strokes++; };
                if (k === 'fill') return () => { fills++; };
                return () => {};
            },
            set() { return true; }
        });
        const w = CAM.tileToWorld(0, 0);
        const cam = CAM.createCamera({ x: w.x, y: w.y, zoom: 0.05 });
        CityWalks.draw(ctx, CAM, M.walks, cam, 1600, 900,
            { x0: -300, x1: 400, y0: -300, y1: 600 }, c);
        check('draw() strokes the polylines + fills one band per candidate',
            strokes >= 2 && fills === c.cols.length + c.rows.length,
            strokes + '/' + fills);
    }
    const cvjs = fs.readFileSync(path.join(__dirname, '..', 'web', 'js', 'city-view.js'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'city-view.html'), 'utf8');
    check('city-view wires census + render hook + persisted legend row',
        /mrsnrub\.cityview\.walks/.test(cvjs) &&
        /CityWalks\.census\(M\.walks, terrain\._roadOccAll, M\.ox, M\.oy\)/.test(cvjs) &&
        /CityWalks\.draw\(ctx, CAM, M\.walks, cam, VW, VH, T, walkCensus\)/.test(cvjs) &&
        /js\/walks\.js/.test(html));
}

console.log('tile markers (notes/01 "riversData is building-adjacent scatter", markers.js):');
{
    const CityMarkers = require(path.join(__dirname, '..', 'web', 'js', 'markers.js'));
    check('parse: the five evidence tiles, in ANY pasted punctuation style',
        JSON.stringify(CityMarkers.parse(
            '(130,20) (144,17) (128,36) (161,54) (170,54)')) ===
        JSON.stringify([[130, 20], [144, 17], [128, 36], [161, 54], [170, 54]]) &&
        JSON.stringify(CityMarkers.parse(
            '130,20\n144,17 and 128 36; town 161/54 -- (170, 54)\n')) ===
        JSON.stringify([[130, 20], [144, 17], [128, 36], [161, 54], [170, 54]]) &&
        CityMarkers.parse('(-3,7) 4,-5').length === 2,
        'formats + negatives');
    check('parse: unpaired trailing number dropped, junk -> []',
        CityMarkers.parse('5,6 7').length === 1 &&
        CityMarkers.parse('no coords here').length === 0 &&
        CityMarkers.parse(null).length === 0);
    {
        let strokes = 0, fills = 0, texts = 0;
        const ctx = new Proxy({}, {
            get(_t, k) {
                if (k === 'stroke') return () => { strokes++; };
                if (k === 'fill') return () => { fills++; };
                if (k === 'strokeText') return () => { texts++; };
                return () => {};
            },
            set() { return true; }
        });
        const w = CAM.tileToWorld(130.5, 20.5);
        const cam = CAM.createCamera({ x: w.x, y: w.y, zoom: 0.5 });
        CityMarkers.draw(ctx, CAM, CityMarkers.parse('(130,20) (144,17)'),
            cam, 1600, 900, { x0: 129, x1: 132, y0: 19, y1: 22 });
        check('draw(): one diamond + label per IN-VIEW mark, off-screen culled',
            fills === 1 && strokes === 2 && texts === 2,
            fills + '/' + strokes + '/' + texts);
    }
    const cvjs = fs.readFileSync(path.join(__dirname, '..', 'web', 'js', 'city-view.js'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'city-view.html'), 'utf8');
    check('city-view wires the legend textarea + persisted value + render hook + seed',
        /mrsnrub\.cityview\.markers/.test(cvjs) &&
        /CityMarkers\.parse\(ta\.value\)/.test(cvjs) &&
        /CityMarkers\.draw\(ctx, CAM, markerPts, cam, VW, VH, T\)/.test(cvjs) &&
        /var MARKER_SEED = '';/.test(cvjs) &&
        /js\/markers\.js/.test(html));
}

console.log('object categories (objects.js):');
{
    const CO = require(path.join(__dirname, '..', 'web', 'js', 'objects.js'));
    const M = global.window.MAP_DATA;
    const expect = {
        SimpsonHome: 'buildings', PowerPlant: 'buildings', 'Kwik-E-Mart': 'buildings',
        KrustyBurger: 'buildings', PostOffice: 'buildings', BartsTreehouse: 'buildings',
        LuxuryYacht: 'vehicles', PirateShip: 'vehicles', SchoolBus: 'vehicles',
        StraightTrack: 'rail', MonorailStation: 'rail',
        Whale: 'nature', BoardwalkTree: 'nature', RoseBush: 'nature',
        BoardwalkLampPost: 'decor', ChainFence: 'decor', Dumpster: 'decor', Fountain: 'decor'
    };
    let bad = [];
    for (const [n, want] of Object.entries(expect))
        if (CO.classify(n) !== want) bad.push(n + '->' + CO.classify(n));
    check('spot-classifications', bad.length === 0, bad.join(','));
    // every CATS bucket must actually occur in the placed data (no dead words)
    const counts = CO.countCats(M.buildings, M.binfo);
    check('all buckets non-empty',
        [CO.FALLBACK].concat(CO.CATS.map(c => c.key)).every(k => counts[k] > 0),
        JSON.stringify(counts));
    check('counts partition every placed object',
        Object.values(counts).reduce((a, b) => a + b, 0) === M.buildings.length,
        JSON.stringify(counts));

    // people dots: fake ctx counts fills with the charcol colour
    const CAMx = CAM;
    const terr = require(path.join(__dirname, '..', 'web', 'js', 'terrain.js')).CityTerrain;
    const t = new terr(M);
    const cw = CAMx.tileToWorld(0, 0);
    const cam = CAMx.createCamera({ x: cw.x, y: cw.y, zoom: 0.4 });
    const T = t.visibleTileRect(cam, 1600, 900);
    let fills = 0, style = null;
    const ctx = new Proxy({}, {
        get(_o, k) {
            if (k === 'fill') return () => { fills++; };
            return () => {};
        },
        set(_o, k, v) { if (k === 'fillStyle') style = String(v); return true; }
    });
    CO.drawPeople(ctx, CAMx, M.chars, M.charcol, cam, 1600, 900, T);
    check('people dots paint in the char colour',
        fills > 0 && style === 'rgb(' + M.charcol.join(',') + ')', String(fills) + ' ' + style);
    check('people dots are culled to the viewport', fills < M.chars.length,
        fills + '/' + M.chars.length);
}

console.log('road sheet art (roadrivertiles-50 roadtilesheet.png):');
{
    const { CityTerrain } = require(path.join(__dirname, '..', 'web', 'js', 'terrain.js'));
    const M = global.window.MAP_DATA;
    const DT = M.downtown[0];
    const w = CAM.tileToWorld((DT[0] + DT[1]) / 2, (DT[2] + DT[3]) / 2);
    const cam = CAM.createCamera({ x: w.x, y: w.y, zoom: 1 });
    // CORRECTED 2026-10-19: road sheet art is now selected per cell from
    // the SAVED nibble (Terrain#cellStateFor), so any of the 11 RE'd
    // state cells may appear — every drawImage must use one of the 11
    // engine UV boxes (.rodata 0x400520, 127x66 inset, notes/06 s10).
    const SRC = CityTerrain.SHEET_STATES.map(([c, r]) =>
        [274 + 135 * c + (((r % 2) + 2) % 2) * 67.5 - 63.5, 140 + 37 * r - 33, 127, 66]);
    function run(opts) {
        const terr = new CityTerrain(M, opts);
        const rec = { fills: 0, imgs: [], ellipses: 0, xf: [] };
        const ctx = new Proxy({}, {
            get(_t, k) {
                if (k === 'fill') return () => { rec.fills++; };
                if (k === 'drawImage') return (...a) => { rec.imgs.push(a.slice(1)); };
                if (k === 'ellipse') return () => { rec.ellipses++; };
                if (k === 'transform') return (...a) => { rec.xf.push(a); };
                return () => {};
            },
            set() { return true; }
        });
        terr.render(ctx, cam, VW, VH, 1);
        return rec;
    }
    const IMG = { complete: true };
    const on = run({ roadSheetImg: IMG, useSheetArt: true });
    check('road tiles paint from the sheet (useSheetArt=true)',
        on.imgs.length > 0, on.imgs.length);
    check("every drawImage uses one of the 11 RE'd road state UV boxes",
        on.imgs.length > 0 && on.imgs.every(a =>
            SRC.some(s => a[0] === s[0] && a[1] === s[1] &&
                a[2] === s[2] && a[3] === s[3])),
        JSON.stringify(on.imgs[0]));
    check('sheet tiles suppress the drawn manhole (art has its own)',
        on.ellipses === 0, on.ellipses);
    const off = run({ roadSheetImg: IMG, useSheetArt: false });
    check('flat fill still goes down under the sheet (one per road cell, ' +
        'both-edge composites reuse it — extra art-off fills are manholes)',
        on.fills > 0 && on.imgs.length >= on.fills &&
        off.fills - on.fills === off.ellipses,
        on.fills + ' fills / ' + on.imgs.length + ' imgs / off+' + off.ellipses + ' manholes');
    check('useSheetArt=false falls back to flat fills + manholes',
        off.imgs.length === 0 && off.ellipses > 0,
        off.imgs.length + '/' + off.ellipses);
    const late = run({ roadSheetImg: { complete: false }, useSheetArt: true });
    check('unloaded sheet keeps flat roads (no broken drawImage)',
        late.imgs.length === 0 && late.ellipses > 0,
        late.imgs.length + '/' + late.ellipses);
    const noRoads = run({ roadSheetImg: IMG, useSheetArt: true, sheetSlots: {} });
    check('sheetSlots={} paints no sheet tiles (knob honoured)',
        noRoads.imgs.length === 0, noRoads.imgs.length);
    const def = run({ roadSheetImg: IMG });
    check('shipped default is FLAT roads (sheet art deferred to M4)',
        def.imgs.length === 0 && def.ellipses > 0,
        def.imgs.length + '/' + def.ellipses);
    check('default road sheet slot = RE RoadDrawer state 0, cell (-1,7)',
        JSON.stringify(new CityTerrain(M, {}).sheetSlots.road) === '[-1,7]',
        JSON.stringify(new CityTerrain(M, {}).sheetSlots.road));
    // M4 neighbour-selection (RE'd base-tile selector model, notes/06 s10)
    check('default sheetSelect = uniform (edge selection behind knob)',
        new CityTerrain(M, {}).sheetSelect === 'uniform',
        new CityTerrain(M, {}).sheetSelect);
    const T = CityTerrain.SHEET_TABLE;
    check('SHEET_TABLE band-edge rows pick kerb states 3/4 (+mirror flips)',
        JSON.stringify(T[7]) === '[3,false]' && JSON.stringify(T[11]) === '[4,true]' &&
        JSON.stringify(T[13]) === '[4,false]' && JSON.stringify(T[14]) === '[3,true]',
        JSON.stringify([T[7], T[11], T[13], T[14]]));
    check('SHEET_TABLE bends pick half-split states 1/5/8; 1-wide straights reuse band states 3/4; interior/dead-ends fall back to 0',
        JSON.stringify(T[5]) === '[1,false]' && JSON.stringify(T[6]) === '[8,false]' &&
        JSON.stringify(T[9]) === '[5,false]' && JSON.stringify(T[10]) === '[1,true]' &&
        JSON.stringify(T[3]) === '[3,false]' && JSON.stringify(T[12]) === '[4,false]' &&
        T[15][0] === 0 && T[0][0] === 0 && T[1][0] === 0 && T[2][0] === 0 &&
        T[4][0] === 0 && T[8][0] === 0,
        JSON.stringify([T[5], T[6], T[9], T[10], T[3], T[12], T[15]]));
    check('SHEET_STATES = the 11 RE-ed UV-quad cells (.rodata 0x400520 order)',
        JSON.stringify(CityTerrain.SHEET_STATES) ===
        JSON.stringify([[-1, 7], [-1, 5], [-1, 6], [-2, 5], [-1, 4], [-1, 1],
            [-2, 1], [-1, -1], [-1, 3], [-2, 3], [-1, 2]]),
        JSON.stringify(CityTerrain.SHEET_STATES[0]));
    function cellSrc(k) {
        const s = CityTerrain.SHEET_STATES[k];
        const cx = 274 + 135 * s[0] + (((s[1] % 2) + 2) % 2) * 67.5;
        const cy = 140 + 37 * s[1];
        return [cx - 63.5, cy - 33];
    }
    const nb = run({ roadSheetImg: IMG, useSheetArt: true, sheetSelect: 'neighbor' });
    check('sheetSelect=neighbor draws varied edge states (kerb composites)',
        nb.imgs.length > 0 &&
        new Set(nb.imgs.map(a => a[0] + ',' + a[1])).size > 1,
        nb.imgs.length + ' imgs, ' +
        new Set(nb.imgs.map(a => a[0] + ',' + a[1])).size + ' distinct cells');
    const legal = new Set(Array.from({ length: 11 }, (_, k) => cellSrc(k).join(',')));
    check('every neighbour-mode source rect is one of the 11 state cells',
        nb.imgs.every(a => legal.has(a[0] + ',' + a[1])),
        JSON.stringify(nb.imgs.find(a => !legal.has(a[0] + ',' + a[1]) || 0) || 'ok'));
    // Sheet box AXES pin (2026-10-17 .20): quad() returns
    // [corner(x,y)=LEFT, (x+1,y)=TOP, (x+1,y+1)=RIGHT, (x,y+1)=BOTTOM], so
    // the affine's 1st column (image-column axis) must follow q2-q0 = the
    // horizontal diagonal and the 2nd column (image-row axis) q3-q1 = the
    // vertical one. The original mapping had these swapped and rendered
    // every composite state rotated 90 degrees (kerbs across the band).
    check('sheet affine maps image cols horizontal / rows vertical (no 90deg skew)',
        nb.xf.length > 0 && nb.xf.every(a =>
            Math.abs(a[1]) <= Math.abs(a[0]) + 1e-9 &&   // |uy| <= |ux|
            Math.abs(a[2]) <= Math.abs(a[3]) + 1e-9),    // |vx| <= |vy|
        JSON.stringify(nb.xf[0] || 'none'));

    // M4 TODO 1b: experimental N-S avenues (client-side template streets;
    // save road layer lacks them — hand-placed streets, see Terrain.AVENUE).
    check('default useAvenues=false (experimental grid behind knob)',
        new CityTerrain(M, {}).useAvenues === false,
        String(new CityTerrain(M, {}).useAvenues));
    check('avenueAt: verified streets only, 4-col bands, each with own y extent',
        CityTerrain.avenueAt(65, 240) && CityTerrain.avenueAt(68, 240) &&
        !CityTerrain.avenueAt(64, 240) && !CityTerrain.avenueAt(69, 240) &&
        CityTerrain.avenueAt(89, 240) && CityTerrain.avenueAt(92, 240) &&
        !CityTerrain.avenueAt(88, 240) && !CityTerrain.avenueAt(93, 240) &&
        CityTerrain.avenueAt(113, 263) && CityTerrain.avenueAt(116, 272) &&
        CityTerrain.avenueAt(29, 240) && CityTerrain.avenueAt(32, 244) &&
        !CityTerrain.avenueAt(29, 234) && !CityTerrain.avenueAt(29, 251) &&
        !CityTerrain.avenueAt(113, 262) && !CityTerrain.avenueAt(113, 273) &&
        !CityTerrain.avenueAt(113, 240) && !CityTerrain.avenueAt(78, 240) &&
        !CityTerrain.avenueAt(118, 240) &&
        !CityTerrain.avenueAt(65, 200) && !CityTerrain.avenueAt(65, 100) &&
        !CityTerrain.avenueAt(65, 300) &&
        // promoted 2026-10-18: police-stn four-way boulevard (verdict id 1)
        CityTerrain.avenueAt(125, 150) && CityTerrain.avenueAt(128, 208) &&
        !CityTerrain.avenueAt(125, 209) && !CityTerrain.avenueAt(124, 150) &&
        !CityTerrain.avenueAt(129, 150),
        'streets [[65,68,221,258],[89,92,221,258],[113,116,263,272],[29,32,235,250],[125,128,146,208]]');
    check('avenue interior cols flat (mask 15), flank cols kerb 13/14 (states 4 / 3+flip)',
        JSON.stringify(CityTerrain.sheetStateFor({}, 54, 104,
            new CityTerrain(M, {})._avenueProbe())) === '[0,false]' &&
        JSON.stringify(CityTerrain.sheetStateFor({}, 53, 104,
            new CityTerrain(M, {})._avenueProbe())) === '[4,false]' &&
        JSON.stringify(CityTerrain.sheetStateFor({}, 56, 104,
            new CityTerrain(M, {})._avenueProbe())) === '[3,true]',
        'grid 66(int)/65(W flank)/68(E flank) of the 65-68 band via town 54/53/56');
    {
        // 'P' cell art selection (2026-10-25): thin E-W bands wear kerb
        // art both edges; plaza slabs and interiors stay flat.
        const tp = new CityTerrain(M, {});
        const occ = {};
        for (let x = 50; x <= 90; x++)
            for (let y = 100; y <= 103; y++) occ[x + ',' + y] = 1;   // one cell row tall
        for (let x = 50; x <= 90; x++)
            for (let y = 120; y <= 131; y++) occ[x + ',' + y] = 1;   // plaza slab (12 tall)
        tp._roadOcc = occ; tp.useAvenues = false;
        check('_pavePick: one-cell-tall P band = asphalt base + strip-clipped kerbs both edges',
            JSON.stringify(tp._pavePick(60, 100)) ===
            JSON.stringify([[0, false, null], [3, false, 'ny'], [4, true, 'py']]),
            JSON.stringify(tp._pavePick(60, 100)));
        check('sheetClipPoly: edge strip hexagon, ~25% of the diamond per side',
            (function () {
                var q = [{ x: 0, y: 1 }, { x: 1, y: 0 }, { x: 2, y: 1 }, { x: 1, y: 2 }];
                function area(p) {
                    var a = 0;
                    for (var i = 0; i < p.length; i++) {
                        var r = p[(i + 1) % p.length];
                        a += p[i].x * r.y - r.x * p[i].y;
                    }
                    return Math.abs(a) / 2;
                }
                var p = CityTerrain.sheetClipPoly(q, 'ny');
                return p.length === 6 && Math.abs(area(p) - (1 -
                    CityTerrain.SHEET_CLIP_S * CityTerrain.SHEET_CLIP_S) *
                    area(q) / 2) < 1e-9;
            })());
        check('_pavePick: band interior and lone cells stay flat (null)',
            tp._pavePick(60, 101) === null && tp._pavePick(200, 200) === null,
            JSON.stringify([tp._pavePick(60, 101), tp._pavePick(200, 200)]));
        check('_pavePick: plaza-slab edge rows stay flat (vertical run >= 8)',
            tp._pavePick(60, 120) === null,
            JSON.stringify(tp._pavePick(60, 120)));
    }
    {
        // camera over open grass at grid (66-67, 240) = town (54, 104)
        const w2 = CAM.tileToWorld(54.5, 104.5);
        const camA = CAM.createCamera({ x: w2.x, y: w2.y, zoom: 1 });
        function runA(opts) {
            const tt = new CityTerrain(M, opts);
            const rec = { fills: 0, imgs: [], ellipses: 0 };
            const ctx = new Proxy({}, {
                get(_t, k) {
                    if (k === 'fill') return () => { rec.fills++; };
                    if (k === 'drawImage') return (...a) => { rec.imgs.push(a.slice(1)); };
                    if (k === 'ellipse') return () => { rec.ellipses++; };
                    return () => {};
                },
                set() { return true; }
            });
            tt.render(ctx, camA, VW, VH, 1);
            return rec;
        }
        const avOn = runA({ roadSheetImg: IMG, useSheetArt: true, sheetSelect: 'neighbor', useAvenues: true });
        const avOff = runA({ roadSheetImg: IMG, useSheetArt: true, sheetSelect: 'neighbor' });
        check('useAvenues paints kerb tiles on the empty avenue columns',
            avOn.imgs.length > avOff.imgs.length && avOn.ellipses === 0,
            avOn.imgs.length + ' vs ' + avOff.imgs.length + ' imgs');
        check('avenue-mode source rects stay within the 11 state cells',
            avOn.imgs.every(a => legal.has(a[0] + ',' + a[1])),
            JSON.stringify(avOn.imgs.find(a => !legal.has(a[0] + ',' + a[1])) || 'ok'));
    }
    {
        // Road-cell sheet FOOTPRINT (road-spec.json layout fix, 2026-10-25):
        // every cell paints as ONE big x big diamond — the 127x66 box's
        // edge midpoints must land on the cell square's corners. The canvas
        // page gets this from _sheetTile(quad(..., big)) for free; the Pixi
        // viewer emulates it in tile space with rotation +45deg + scale,
        // which is only exact when the scale is big*(√2/127, √2/66). With
        // the bare unit-tile constants every cell's art drew at quarter
        // scale (a 1-tile diamond floating in the middle of the flat fill,
        // bends landing at cell centres).
        const half = big => big / 2;
        function canvasMap(big, p) {   // _sheetTile affine, tile space
            const U = [big / 127, big / 127], V = [-big / 66, big / 66];
            return [p[0] * U[0] + p[1] * V[0], p[0] * U[1] + p[1] * V[1]];
        }
        function pixiMap(sx, sy, p) {  // R(+45deg) * diag(sx, sy)
            const x = p[0] * sx, y = p[1] * sy;
            return [(x - y) / Math.SQRT2, (x + y) / Math.SQRT2];
        }
        const MID = [[63.5, 0], [-63.5, 0], [0, 33], [0, -33]];
        const near2 = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
        check('sheet box edge midpoints map to the cell square corners ' +
            '(canvas affine == pixi big-scaled sprite, big=1 and big=4)',
            [1, 4].every(big => MID.every(p => {
                const want = canvasMap(big, p).map(v => Math.sign(v) * half(big));
                const c = canvasMap(big, p), s = pixiMap(
                    big * Math.SQRT2 / 127, big * Math.SQRT2 / 66, p);
                return near2(c, want) && near2(s, want);
            })));
        check('the unit-tile scale is WRONG for 4x4 cells (regression guard)',
            !MID.every(p => near2(
                pixiMap(Math.SQRT2 / 127, Math.SQRT2 / 66, p),
                canvasMap(4, p))),
            JSON.stringify(pixiMap(Math.SQRT2 / 127, Math.SQRT2 / 66, [63.5, 0])));
    }

    // 1-wide N-S fragment debug overlay (Terrain#debugFrags).
    check('default debugFrags=false (debug overlay behind knob)',
        new CityTerrain(M, {}).debugFrags === false,
        String(new CityTerrain(M, {}).debugFrags));
    {
        function runFrag(on) {
            const tF = new CityTerrain(M, { debugFrags: on });
            const rec = { fills: 0 };
            const ctxF = new Proxy({}, {
                get(_t, k) {
                    if (k === 'fill') return () => { rec.fills++; };
                    return () => {};
                },
                set() { return true; }
            });
            const wf = CAM.tileToWorld(279.5, 55.5);   // grid (291,191) fragment gang
            tF.render(ctxF, CAM.createCamera({ x: wf.x, y: wf.y, zoom: 1 }), VW, VH, 1);
            return { rec: rec, cells: tF._fragCells || [] };
        }
        const onF = runFrag(true), offF = runFrag(false);
        // CORRECTED 2026-10-19: every saved road cell covers a full 4x4
        // tile block, so no road tile can be x-isolated with a y road
        // neighbour — the old "1-wide N-S fragment" columns (grid x 291
        // etc.) were artefacts of the wrong per-tile decode. The overlay
        // now provably paints nothing on this save.
        check('_fragCells is empty — the fragment gang was a decode artefact',
            onF.cells.length === 0, JSON.stringify(onF.cells.slice(0, 8)));
        check('debugFrags adds no overlay fills anymore (classification empty)',
            onF.rec.fills === offF.rec.fills,
            onF.rec.fills + ' vs ' + offF.rec.fills + ' fills');
    }
}

console.log('candidate-street verdict tool (M4, 2026-10-18):');
{
    // Candidates live OUTSIDE Terrain.AVENUE until the user eye test passes
    // (notes/06 §10 "Road system-of-record, CLOSED"); api/streets.php (SQLite)
    // stores verdicts when served, terrain.js carries the offline seeds.
    const { CityTerrain } = require(path.join(__dirname, '..', 'web', 'js', 'terrain.js'));
    const M = global.window.MAP_DATA;
    check('PROPOSED ships seed candidates, verdicts empty, no avenueAt leak',
        Array.isArray(CityTerrain.PROPOSED.streets) &&
        CityTerrain.PROPOSED.streets.length >= 24 &&
        Object.keys(CityTerrain.PROPOSED.verdicts).length === 0 &&
        CityTerrain.PROPOSED.streets.every(s =>
            s.x0 >= 0 && s.x1 < 512 && s.ylo >= 0 && s.yhi <= 1086) &&
        !CityTerrain.avenueAt(138, 200) &&
        !CityTerrain.avenueAt(498, 200) && CityTerrain.avenueAt(114, 263),
        CityTerrain.PROPOSED.streets.length + ' candidates');
    check('E-W candidate seed (police stn south side, saved-row twin x 124-143)',
        CityTerrain.PROPOSED.streets.some(s =>
            s.x0 === 124 && s.x1 === 143 && s.ylo === 174 && s.yhi === 175) &&
        !CityTerrain.avenueAt(150, 174),      // candidate, not yet a street
        'ew candidate present + not promoted');
    check('east arm seeds reach the coast (x 498 pitch-24 + 318 half-pitch)',
        CityTerrain.PROPOSED.streets.some(s => s.x0 === 498 && s.x1 === 499) &&
        CityTerrain.PROPOSED.streets.some(s => s.x0 === 318 && s.x1 === 319),
        'east candidates present');
    check('showProposed defaults off (candidates never ship on)',
        new CityTerrain(M, {}).showProposed === false,
        String(new CityTerrain(M, {}).showProposed));
    {
        function runProp(on, hover) {
            const tP = new CityTerrain(M, { showProposed: on, hoverProposed: hover });
            const rec = { fills: 0, strokes: 0 };
            const ctxP = new Proxy({}, {
                get(_t, k) {
                    if (k === 'fill') return () => { rec.fills++; };
                    if (k === 'stroke') return () => { rec.strokes++; };
                    return () => {};
                },
                set() { return true; }
            });
            // town (114.5, 41.5) = grid (126.5, 177.5): the crosswalk-straddle
            // candidate x 126-127 @ y 146-208 sits under this camera
            const wp = CAM.tileToWorld(114.5, 41.5);
            tP.render(ctxP, CAM.createCamera({ x: wp.x, y: wp.y, zoom: 1 }), VW, VH, 1);
            return rec;
        }
        const pOn = runProp(true), pOff = runProp(false);
        check('showProposed paints candidate fills over the base pass only',
            pOn.fills > pOff.fills && pOff.fills > 0,
            pOn.fills + ' vs ' + pOff.fills + ' fills');
        const pHov = runProp(true, 1);     // seed id 1 = x 126-127 under camera
        check('hoverProposed outlines the hovered street (per-cell strokes)',
            pHov.strokes > 0 && pOn.strokes === 0 && pHov.fills >= pOn.fills,
            pHov.strokes + ' strokes vs ' + pOn.strokes);
        const pHovGhost = runProp(true, 99999);   // id not on list: same as no hover
        check('hoverProposed with unknown id is inert (no phantom strokes)',
            pHovGhost.strokes === 0 && pHovGhost.fills === pOn.fills,
            pHovGhost.fills + ' vs ' + pOn.fills + ' fills');
    }
}

console.log('landmark calibration anchor (mapdump/registration/calib-pairs.txt):');
{
    // The 9 user-picked export<->world correspondences from 2026-10-17
    // (notes/06 §9). [exportX, exportY, gridX, gridY], full-res px.
    // This block is the permanent regression anchor for the projection:
    // any change to ORIENT/TILE/oriented()/tileToWorld must keep these
    // reprojecting, and must keep {1,-1,1} the best physically valid
    // orientation of the 8.
    const PAIRS = [
        [944.0, 3174.9, 6.8, 53.8], [2154.7, 3825.6, -0.7, 184.3],
        [1133.3, 3268.3, 5.8, 78.3], [3290.7, 3057.6, 139.0, 170.3],
        [2688.0, 3462.9, 65.5, 176.8], [3170.7, 4334.9, -2.0, 290.8],
        [4898.7, 2225.6, 308.5, 172.8], [6360.0, 2919.2, 316.8, 313.1],
        [6288.0, 3263.2, 279.5, 355.1]
    ];
    const O0 = { fx: CAM.ORIENT.fx, fy: CAM.ORIENT.fy, swap: CAM.ORIENT.swap };
    const M = global.window.MAP_DATA;
    // Model-consistent least squares: px = A*(u-v)+c, py = B*(u+v)+d,
    // with (u,v) from CAM.oriented — the production convention (grid
    // tiles converted to town coords first).
    function fitOrient(o) {
        CAM.ORIENT = o;
        const rows = PAIRS.map(([, , gx, gy]) => {
            const uv = CAM.oriented(gx - M.ox, gy - M.oy);
            return [uv[0] - uv[1], uv[0] + uv[1]];
        });
        const lin = (col, ys) => {
            const n = col.length;
            const sx = col.reduce((a, x) => a + x, 0), sy = ys.reduce((a, y) => a + y, 0);
            const sxx = col.reduce((a, x) => a + x * x, 0);
            const sxy = col.reduce((a, x, i) => a + x * ys[i], 0);
            const a = (n * sxx - sx * sx) !== 0 ? (n * sxy - sx * sy) / (n * sxx - sx * sx) : 0;
            return [a, (sy - a * sx) / n];
        };
        const [A, c] = lin(rows.map(r => r[0]), PAIRS.map(p => p[0]));
        const [B, d] = lin(rows.map(r => r[1]), PAIRS.map(p => p[1]));
        let sq = 0;
        for (let i = 0; i < PAIRS.length; i++) {
            const dx = PAIRS[i][0] - (A * rows[i][0] + c);
            const dy = PAIRS[i][1] - (B * rows[i][1] + d);
            sq += dx * dx + dy * dy;
        }
        return { rms: Math.sqrt(sq / PAIRS.length), A, B };
    }
    const shipped = fitOrient(O0);
    check('shipped ORIENT reprojects the 9 landmarks (RMS < 60 px)',
        shipped.rms < 60, shipped.rms.toFixed(1) + ' px');
    // Enumerate the 8 dihedral states through the group generators; a
    // state is physically valid only with s,hw,hh > 0, i.e. A,B > 0.
    const keyOf = o => o.fx + ',' + o.fy + ',' + o.swap;
    const valid = [];
    const seen = new Set();
    const queue = [O0];
    while (queue.length) {
        const o = queue.pop();
        const k = keyOf(o);
        if (seen.has(k)) continue;
        seen.add(k);
        const f = fitOrient(o);
        if (f.A > 0 && f.B > 0) valid.push({ k: k, rms: f.rms });
        queue.push(CAM.orientRotate90(o), CAM.orientMirror(o));
    }
    CAM.ORIENT = O0;   // restore (smoke order independence)
    check('all 8 dihedral states enumerated', seen.size === 8, seen.size);
    check('shipped ORIENT is physically valid and beats every other valid state by >10x',
        valid.some(v => v.k === keyOf(O0) && v.rms < 60) &&
        valid.every(v => v.k === keyOf(O0) || v.rms > 10 * shipped.rms),
        JSON.stringify(valid) + ' shipped=' + keyOf(O0));
}

console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
