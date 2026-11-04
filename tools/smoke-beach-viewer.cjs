// Headless smoke test for the Pixi city view's fixed beach coast sets
// (landinfo.xml <LandEdge>, 2026-10-30).
//
// Four layers:
//  1. MANIFEST invariants — both bsv3 assets, both sheet PNGs on disk with
//     every crop inside them, the per-tile metadata the placement reads
//     (tilebox / coverRows / opaqueX), and the two-set coast claim.
//  2. VIEWER integration — the Pixi page fetches the manifest, registers both
//     sheets, hooks the layer into makeScene + render + setOrient + boot, and
//     ships the two viewbar toggles and the tune panel.
//  3. BEHAVIOUR — the beach block is sliced out of the viewer VERBATIM (no
//     copy of the rule lives here) and run against the shipped MAP_DATA and
//     terrain.js: the two sets' instance anchors, the tiles their art paints,
//     gap-free coverage at the coverRows pitch, the same-columns "they meet,
//     they don't stack" claim, and the real draw pass against stubs — booted
//     twice, with the art toggle persisted off and on (the v30 lesson: an
//     invisible pass sails through every derive-only check).
//  4. PAGE + CSS — buttons carry data-tip (never title), #beachtune is styled,
//     the cache busters are bumped.
//
//   node tools/smoke-beach-viewer.cjs
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const W = path.join(root, 'web');

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
const fin = v => typeof v === 'number' && isFinite(v);

/* ---- 1. the manifest ----------------------------------------------------- */
const MAN = 'web/assets/city/beach-tiles.json';
check('manifest exists', fs.existsSync(path.join(root, MAN)));
const J = JSON.parse(read(MAN));
check('manifest is the generator output',
    J.gen === 'tools/gen_beach_tiles.py' && J.pxPerTile === 64, J.gen);
check('both coast assets are in it',
    !!J.assets.beach && !!J.assets.heights &&
    J.assets.beach.sheet.endsWith('images/beach.png') &&
    J.assets.heights.sheet.endsWith('images/springfieldheightsnobeach.png'));
for (const k of ['beach', 'heights']) {
    const a = J.assets[k], rel = 'web/' + a.sheet;
    check('sheet on disk: ' + a.sheet, fs.existsSync(path.join(root, rel)));
    if (!fs.existsSync(path.join(root, rel))) continue;
    const sz = pngSize(rel);
    const bad = [];
    for (const c of a.cells)
        if (c[1] < 0 || c[2] < 0 || c[1] + c[3] > sz.w || c[2] + c[4] > sz.h) bad.push(c[0]);
    check('every ' + k + ' crop is inside the ' + sz.w + 'x' + sz.h + ' sheet',
        !bad.length, bad.slice(0, 4).join(','));
}
for (const kind of ['shore', 'buildarea', 'h_shore', 'h_beach', 'h_overlay']) {
    const t = J.tiles[kind];
    check('tile ' + kind + ' has placement metadata',
        !!t && !!t.anim && !!J.anims[t.anim] && !!J.anims[t.anim].tilebox &&
        !!t.coverRows && !!t.opaqueX, t && t.anim);
}
check('the two LandEdge sets are documented as two sets',
    /twoSets/.test(JSON.stringify(J.coast)) &&
    J.tiles.shore.landedge.repeat === '-1' &&
    J.tiles.h_shore.landedge.repeat === '6' &&
    J.tiles.h_shore.landedge.offsety === '-7');

/* ---- 2. viewer integration ------------------------------------------------ */
const pv = read('web/viewer/city-view-pixi.js');
check('viewer fetches the beach manifest',
    pv.includes("fetch(B + 'assets/city/beach-tiles.json')"));
check('viewer registers BOTH sheets with the texture cache',
    /for \(var k in j\.assets\)[\s\S]{0,200}ALOAD\.artKnown\+\+; ALOAD\.strips\+\+;[\s\S]{0,80}texFor\(B \+ j\.assets\[k\]\.sheet\)/.test(pv));
check('viewer rebuilds once the sheets decode (settle poll)',
    /function settle\(\)[\s\S]{0,300}setTimeout\(settle, 100\)[\s\S]{0,200}beachBuild\(\);\s*\n\s*markDirty\(\);/.test(pv));
check('the layer is an art container with its bg fill and the cloud wall',
    /beachArtC = new PIXI\.Container\(\);/.test(pv) &&
    /beachBgG = new PIXI\.Graphics\(\);/.test(pv) &&
    /beachCloudG = new PIXI\.Graphics\(\);/.test(pv));
check('the containers are in the stage order the comment promises',
    pv.indexOf('app.stage.addChild(beachArtC);') > pv.indexOf('app.stage.addChild(propG);') &&
    pv.indexOf('app.stage.addChild(beachCloudG);') > pv.indexOf('app.stage.addChild(beachArtC);') &&
    pv.indexOf('app.stage.addChild(beachArtC);') < pv.indexOf('app.stage.addChild(bridgeG);'));
check('the draw pass runs every frame with the frame affine',
    /beachDraw\(A, s, T\);/.test(pv));
check('an ORIENT press and the boot path both wire it up',
    /beachBuild\(\);\s+\/\/ coast anchors read terrain/.test(pv) &&
    /bindBeachUI\(\);/.test(pv));
check('the art blits through subTex + one matrix per block',
    /subTex\(url, sx, sy, w, h\)/.test(pv) &&
    /sp\.setFromMatrix\(new PIXI\.Matrix\(W \/ bl\.sw, 0, 0, H \/ bl\.sh, X, Y\)\)/.test(pv));
check('the block rect is the documented road-lab formula',
    /dx: blk\[1\] - \(blk\[3\] < 0 \? c\[3\] \* mx : 0\), dy: blk\[2\],\s*\n\s*w: c\[3\] \* mx, h: c\[4\] \* my/.test(pv));
check('the tile rule is the centre-in-opaque-box rule',
    /Math\.ceil\(b\[0\] - 0\.5 \+ ax\)[\s\S]{0,120}Math\.floor\(b\[2\] - 0\.5 \+ ax\)/.test(pv));
check('placement is the file\'s: offsets x block, step = width + padding, origin tile 0',
    /offY: beachP\.useOffsets \? num\(e\.offsety, 0\) \* blk : 0/.test(pv) &&
    /step: Math\.max\(1, num\(e\.width, 16\) \+ num\(e\.padding, 0\)\)/.test(pv) &&
    /var ay = alongX \? y0 : y0 \+ i \* ed\.step \+ nudge;/.test(pv) &&
    /var ax = alongX \? x0 \+ i \* ed\.step : x0;/.test(pv) &&
    /function beachAnchorX\(\) \{ return beachP\.ax \| 0; \}/.test(pv) &&
    !/beachP\.seam|beachP\.pitch|beachP\.hpitch|hmode/.test(pv));
check('stale v1 params (seam/pitch steppers, sea-fill anchor) cannot override the file',
    /'mrsnrub\.cityview\.beach\.params\.v2'/.test(pv));
check('only <LandSprite> edges are stamped (BEACHBORDEROVERLAY is AlternateLandSprite)',
    /sprite: !t \|\| !t\.landedgeBlock \|\| t\.landedgeBlock === 'LandSprite'/.test(pv) &&
    /if \(!ed\.anim \|\| !ed\.sprite\) continue;/.test(pv));
check('the hasBackground fill is drawn under the art, in the art container',
    /beachArtC\.addChild\(beachBgG\);/.test(pv) &&
    /bg: e\.hasBackground === 'true' && e\.bgColor/.test(pv));
/* THE BUG THIS PINS: the repeat="1" mountain overlay is ONE stamp for the
   whole edge. Attaching every part of a set to every strip drew the Heights
   overlay — two crops of 669x384 and 574x382 ART px — six times, which read as
   one massive tile over the map. So the stamp count must come from each anim's
   own landedge.repeat. */
check('stamping reads each anim\'s own landedge.repeat',
    /repeat: num\(e\.repeat, -1\)/.test(pv) &&
    /var n = ed\.repeat >= 0 \? ed\.repeat/.test(pv) &&
    /ed\.repeat === 1/.test(pv) &&
    !/beachLowerInstances\(\)/.test(pv));
check('window.__CV_BEACH exposes the probe',
    /window\.__CV_BEACH = \{/.test(pv) &&
    /rects: function \(s\)/.test(pv) && /instances: function/.test(pv));
check('the controls are all guarded (a missing button cannot black out the page)',
    pv.split('\n').filter(function (l) {
        return /btn-beach/.test(l) && /addEventListener/.test(l);
    }).length === 2 &&
    pv.split('\n').every(function (l) {
        return !(/btn-beach/.test(l) && /addEventListener/.test(l)) || /if \(\$\(/.test(l);
    }) &&
    /if \(\$\('btn-beachart'\)\)/.test(pv) && /if \(\$\('btn-beachtune'\)\)/.test(pv) &&
    !/btn-beachsets/.test(pv));

/* ---- 3. behaviour: slice the block out and run it ------------------------- */
global.window = {};
new Function('window', read('web/js/map-explorer-data.js'))(global.window);
const M = global.window.MAP_DATA;
const CAM = require(path.join(W, 'js/camera.js'));
global.CAM = CAM;                       // terrain.js reads the global, as the page does
const CityTerrain = require(path.join(W, 'js/terrain.js')).CityTerrain;
const terrain = new CityTerrain(M, {});

const A1 = pv.indexOf('/* ---- fixed beach coast sets');
const A2 = pv.indexOf('function bindBeachUI');
if (A1 < 0 || A2 < 0) { console.error('beach block markers not found'); process.exit(1); }
const slice = pv.slice(A1, A2);

function syncp(v) {
    return {
        then: function (cb) {
            let out;
            try { out = cb(v); } catch (e) { return { catch: function (f) { f(e); return syncp(null); } }; }
            while (out && typeof out.then === 'function') {
                let d; out.then(x => { d = x; }); out = d;
            }
            return syncp(out);
        },
        catch: function () { return syncp(null); }
    };
}
/* boot the sliced block against the shipped data; `artOn` is persisted the way
   the toggle persists it, so the closure reads it at boot */
function boot(artOn, size, noTex) {
    const stored = { 'mrsnrub.cityview.beachart': artOn ? '1' : '0' };
    const urls = [], PX = [];
    let dirtyN = 0;
    function FakeSprite() {
        this.anchor = { set: function () {} };
        this.visible = false; this.m = null; this.texture = null;
        this.setFromMatrix = function (m) { this.m = m; };
        PX.push(this);
    }
    function FakeMatrix(a, b, c, d, e, f) {
        this.a = a; this.b = b; this.c = c; this.d = d; this.e = e; this.f = f;
    }
    const bgops = [];
    const BG = { clear: function () { bgops.length = 0; } };
    BG.poly = function (pts) { bgops.push(['poly', pts]); return BG; };
    BG.fill = function (o) { bgops.push(['fill', o]); return BG; };
    const stubs = {
        M: M, terrain: terrain, CAM: CAM, B: '../',
        UNIT: { unit: 1 },
        beachArtC: { addChild: function () {} },
        beachBgG: BG,
        beachCloudG: { clear: function () {}, poly: function () { return this; },
                       circle: function () { return this; }, fill: function () { return this; } },
        subTex: function (u, x, y, w, h) {
            return noTex ? null : { u: u, x: x, y: y, w: w, h: h };
        },
        texFor: function (u) { urls.push(u); return { tex: u }; },
        texDead: function () { return false; },
        ALOAD: { artKnown: 0, strips: 0 },
        localStorage: {
            getItem: function (k) { return stored[k] === undefined ? null : stored[k]; },
            setItem: function (k, v) { stored[k] = v; }
        },
        fetch: function (u) {
            return u.indexOf('beach-tiles.json') >= 0
                ? syncp({ ok: true, json: function () { return J; } })
                : syncp({ ok: false });
        },
        setTimeout: function (fn) { fn(); return 0; },
        markDirty: function () { dirtyN++; },
        __isDirty: function () { return dirtyN; },
        console: console,
        PIXI: { Sprite: FakeSprite, Matrix: FakeMatrix },
        $: function () { return null; },        // no DOM: applyBeachMode must cope
        cam: { zoom: 1, x: 0, y: 0 }, VW: (size && size.VW) || 1200, VH: (size && size.VH) || 800,
        __urls: urls, __PX: PX, __bgops: bgops,
        __VW: (size && size.VW) || 1200, __VH: (size && size.VH) || 800
    };
    const names = Object.keys(stubs);
    /* the viewer file is 'use strict', so run the slice that way too: an
       undeclared assignment (a dropped `var`) is a ReferenceError on the page,
       and the page would die exactly the way the road-lab tab once did */
    const body = "'use strict';\n" + slice + '\nvar __probe = window.__CV_BEACH;\nreturn { p: beachP, artOn: function () { return beachArtOn; },' +
        ' beach: function () { return BEACH; }, stamps: beachStampsOf,' +
        ' span: beachSpan, edge: beachEdge, landEnd: beachLandEnd,' +
        ' tiles: beachTilesOf,' +
        ' blocks: beachBlocks,' +
        ' anchorX: beachAnchorX,' +
        ' build: beachBuild, draw: beachDraw, urls: __urls, sprites: __PX,' +
        ' bgops: __bgops, dirty: __isDirty,' +
        ' setCloudG: function (g) { beachCloudG = g; },' +
        ' probe: function () { return __probe; }, VW: __VW, VH: __VH };';
    return new Function(names.join(','), body).apply(null, names.map(n => stubs[n]));
}

const R = boot(false);
const RA = boot(true);
const RB = boot(true, { VW: 1e9, VH: 1e9 });        // nothing culled: every block must blit
check('the block boots and the manifest lands', !!R.beach(), 'BEACH null');
check('all three sheets went to the texture cache (registration + the settle poll)',
    R.urls.filter(u => /\/beach\.png$/.test(u)).length >= 1 &&
    R.urls.filter(u => /\/springfieldheightsnobeach\.png$/.test(u)).length >= 1 &&
    R.urls.filter(u => /\/land\.png$/.test(u)).length >= 1 &&
    R.urls.length === 6, R.urls.join(' '));
check('the probe exists and reports the layer',
    R.probe() && typeof R.probe().rects === 'function' && R.probe().state().insts > 0,
    JSON.stringify(R.probe() && R.probe().state()));
check('the art toggle ships off, and persists on',
    R.artOn() === false && RA.artOn() === true,
    R.artOn() + '/' + RA.artOn());

check('the default params are the file\'s (origin 0,0, 16-tile blocks, offsets on)',
    R.p.ax === 0 && R.p.ay === 0 && R.p.block === 16 && R.p.useOffsets === true &&
    R.p.hinst === 6 && R.p.fill === true && R.p.bg === true && R.p.edgeAt === 0,
    JSON.stringify(R.p));
check('a repeat="-1" edge runs to the land\'s south end (Region Springfield y2)',
    R.landEnd() === 700, R.landEnd());

/* stamps: what each piece's own <LandEdge …> produces ---------------------- */
function st(set, kind) { return R.stamps(set).filter(x => !kind || x.kind === kind); }
check('the file\'s own repeats drive the stamp counts',
    (function () {
        const c = R.probe().counts();
        return c.buildarea === 45 && c.shore === 45 && !c.border &&
            c.h_shore === 6 && c.h_beach === 6 && c.h_overlay === 1;
    })(), JSON.stringify(R.probe().counts()));
check('BEACHBORDEROVERLAY stays off the map (AlternateLandSprite, the pre-v28 land)',
    R.beach().tiles.border.landedgeBlock === 'AlternateLandSprite' &&
    R.edge('border').sprite === false && st('lower', 'border').length === 0);
check('the repeat="1" Heights overlay is ONE stamp, not one per strip',
    st('heights', 'h_overlay').length === 1 &&
    R.edge('h_overlay').repeat === 1 &&
    R.edge('shore').repeat === -1 && R.edge('h_shore').repeat === 6,
    JSON.stringify([R.edge('h_overlay'), R.edge('h_shore')]));
check('the Heights mountain overlay draws 2 crops once, not 12 (the massive-tile bug)',
    (function () {
        const r = R.probe().rects(64).filter(x => x.kind === 'h_overlay');
        return r.length === 2 && Math.max.apply(null, r.map(x => x.w)) > 500;
    })(), R.probe().rects(64).filter(x => x.kind === 'h_overlay').length + ' crops');
/* THE BUG THIS PINS (2026-10-30.16): offsety counts 16-tile land blocks. Read
   as plain tiles, the lower set started at y -1 and the Heights set at -109
   stepping 17 — both off the mountain band, and the 17-row step drifted the
   strips a row per repeat against the file's 16 */
check('the landedge offsets are 16-tile blocks (lower -1 -> y -16, Heights -7 -> y -112)',
    R.edge('shore').offY === -16 && R.edge('h_shore').offY === -112 &&
    R.edge('h_beach').offY === -112 && R.edge('h_overlay').offY === -112 &&
    st('lower', 'shore')[0].ay === -16 && st('heights', 'h_shore')[0].ay === -112,
    JSON.stringify([st('lower', 'shore')[0].ay, st('heights', 'h_shore')[0].ay]));
const low = st('lower', 'shore'), hi = st('heights', 'h_shore');
check('the lower set steps by its LandEdge width (16) from y -16 to the land end',
    low.length === 45 && low[0].ay === -16 && low[1].ay === 0 &&
    low[low.length - 1].ay === 688 && low[low.length - 1].ay + 16 >= R.landEnd(),
    low.length + ' ' + low.slice(0, 3).map(x => x.ay).join());
check('the Heights set is six 16-row strips, y -112..-16',
    hi.length === 6 && hi.map(h => h.ay).join() === '-112,-96,-80,-64,-48,-32',
    hi.map(h => h.ay).join());
check('the two sets MEET on Mountain03\'s north edge (= GridTypeMap\'s beach split)',
    (function () {
        const s = R.probe().state();
        const split = R.beach().gridtype.ranges.filter(r => r.type === 'beach' && r.y1 != null)[0].y1;
        return s.lower[0] === -16 && s.heights[1] === -16 && split === -16;
    })(), JSON.stringify(R.probe().state()));
check('the Heights beach1 strips share the shore strips\' rows',
    st('heights', 'h_beach').map(x => x.ay).join() === hi.map(x => x.ay).join());
check('the overlay sits at the north end of the Heights coast (offsety -7)',
    st('heights', 'h_overlay')[0].ay === -112, st('heights', 'h_overlay')[0].ay);
check('the offsets toggle lands every piece on the origin row instead',
    (function () {
        R.p.useOffsets = false; R.build();
        const a = R.probe().instances().filter(x => x.kind === 'shore').map(x => x.ay);
        const b = R.probe().instances().filter(x => x.kind === 'h_shore').map(x => x.ay);
        R.p.useOffsets = true; R.build();
        return a[0] === 0 && a[1] === 16 && b.join() === '0,16,32,48,64,80';
    })(), 'shore/h_shore rows with the file\'s offsets ignored');
check('block 1 reproduces the old misreading (offsets as plain tiles)',
    (function () {
        R.p.block = 1; R.build();
        const a = st('lower', 'shore')[0].ay, b = st('heights', 'h_shore')[0].ay;
        R.p.block = 16; R.build();
        return a === -1 && b === -7;
    })());
/* THE OTHER BUG THIS PINS: the anchor is the land origin, the frame the save's
   props are in. It is NOT derived from the terrain's sea fill: that is how the
   coast once went 12 tiles out to sea, when the sea's bounds were tile numbers
   stored as grid. Now the two agree — the sea's shoreline is tile x 0 too —
   and they must, or the shore art's foam sits on grass */
check('the anchor is tile x 0 (the props\' frame) and the sea meets it there',
    R.anchorX() === 0 && low[0].ax === 0 && hi[0].ax === 0 &&
    terrain.seaFillX1 - terrain.ox === 0,
    JSON.stringify(R.probe().state()));
check('the sea runs the whole coast the beach strips cover (y -112..704)',
    terrain.seaFillY0 - terrain.oy <= -112 && terrain.seaFillY1 - terrain.oy >= 704,
    (terrain.seaFillY0 - terrain.oy) + '..' + (terrain.seaFillY1 - terrain.oy));
check('the beach chairs and towels in the save stand on the lower buildarea',
    (function () {
        const t = R.probe().tiles('lower', 'buildarea'), on = new Set();
        for (let i = 0; i < t.length; i += 2) on.add(t[i] + ',' + t[i + 1]);
        let n = 0, hit = 0;
        for (const b of M.buildings) {
            const e = M.binfo[b[0]];
            if (!e || !/^Beach(Chair|TowelUmbrella)$/.test(e[1])) continue;
            n++;
            if (on.has(b[6] + ',' + b[7])) hit++;
        }
        return n >= 3 && hit === n;
    })(), 'beach props on buildarea tiles');
check('the footprints straddle x 0: buildarea 0..3 inland, shore -4..-1 into the water',
    (function () {
        const bb = R.probe().tiles('lower', 'buildarea');
        const sb = R.probe().tiles('lower', 'shore');
        const mn = t => Math.min.apply(null, t.filter((_, i) => i % 2 === 0));
        const mx = t => Math.max.apply(null, t.filter((_, i) => i % 2 === 0));
        return mn(bb) === 0 && mx(bb) === 3 && mn(sb) === -4 && mx(sb) === -1;
    })(), JSON.stringify([R.probe().tiles('lower', 'buildarea').slice(0, 2),
                          R.probe().tiles('lower', 'shore').slice(0, 2)]));
check('no BEACH footprint reaches past the Heights cliff (GridTypeMap cliff ends x 16)',
    (function () {
        const t = R.probe().tiles('lower', null).concat(R.probe().tiles('heights', null));
        for (let i = 0; i < t.length; i += 2) if (t[i] > 16) return false;
        return true;
    })(), 'a footprint east of tile x 16 is on the town, not the coast');
check('anchor x / anchor y dial the whole coast',
    (function () {
        const kx = R.p.ax, ky = R.p.ay; R.p.ax = 5; R.p.ay = -3; R.build();
        const s = st('lower', 'shore')[0];
        R.p.ax = kx; R.p.ay = ky; R.build();
        return s.ax === 5 && s.ay === -19;
    })(), 'ax 5 / ay -3');
check('within a kind the stamps are drawn far end first (the 1-row overlap)',
    (function () {
        const h = st('heights', 'h_shore').map(x => x.ay);
        return h.join() === h.slice().sort((a, b) => a - b).join();
    })(), st('heights', 'h_shore').map(x => x.ay).join());
check('turning the north set off leaves only the lower stamps',
    (function () {
        R.p.heights = false; R.build();
        const ii = R.probe().instances();
        R.p.heights = true; R.build();
        return ii.every(x => x.set !== 'heights') &&
            ii.filter(x => x.set === 'lower').length === 90;
    })());
check('the strip count follows the fill toggle',
    (function () {
        const k = R.p.fill, c = R.p.copies;
        R.p.fill = false; R.p.copies = 4; R.build();
        const n = R.probe().counts();
        R.p.fill = k; R.p.copies = c; R.build();
        return n.shore === 4 && n.buildarea === 4;
    })());
check('hinst dials the Heights set down without touching the file\'s repeat',
    (function () {
        const k = R.p.hinst; R.p.hinst = 2; R.build();
        const n = R.probe().counts();
        R.p.hinst = k; R.build();
        return n.h_shore === 2 && n.h_beach === 2 && n.h_overlay === 1;
    })());
check('edgeAt nudges the single repeat="1" stamp along the coast',
    (function () {
        const k = R.p.edgeAt; R.p.edgeAt = 40; R.build();
        const o = R.probe().instances().filter(x => x.kind === 'h_overlay')[0].ay;
        R.p.edgeAt = k; R.build();
        return o === -72;
    })(), 'overlay at edgeAt=40');
check('a manifest that says repeat="-1" fills, whatever the kind',
    (function () {
        const save = R.beach().tiles.h_overlay.landedge.repeat, hk = R.p.hinst;
        R.beach().tiles.h_overlay.landedge.repeat = '-1'; R.p.hinst = 99; R.build();
        const n = R.probe().counts().h_overlay;
        R.beach().tiles.h_overlay.landedge.repeat = save; R.p.hinst = hk; R.build();
        return n === Math.ceil((700 + 112) / 16);
    })(), 'h_overlay with repeat forced to -1');
/* the hasBackground fill: Heights beach1's LandEdge asks for a solid EEDDCC
   rect 13.5 x 16 tiles at x -0.5 under each strip — the beach1 art itself is
   only cliff, rocks and sand PATCHES, so without it the beach reads as grass */
check('the manifest carries beach1\'s hasBackground fill',
    (function () {
        const e = R.edge('h_beach').bg;
        return !!e && e.color === 0xeeddcc && e.x === -0.5 && e.y === 0 &&
            e.w === 13.5 && e.h === 16 && !R.edge('h_shore').bg && !R.edge('shore').bg;
    })(), JSON.stringify(R.edge('h_beach').bg));

/* tiles */
function cols(flat) {
    const xs = new Set(), ys = new Set();
    for (let i = 0; i < flat.length; i += 2) { xs.add(flat[i]); ys.add(flat[i + 1]); }
    return { xs: [...xs].sort((a, b) => a - b), ys: [...ys].sort((a, b) => a - b) };
}
const sh = cols(R.tiles('beachShore1', 0, 0));
const hs = cols(R.tiles('heights.BeachShore1', 0, 0));
check('the lower shore paints the 4 water columns, 17 rows',
    sh.xs.join() === '-4,-3,-2,-1' && sh.ys.length === 17, sh.xs.join() + ' | ' + sh.ys.length);
check('the two shores measure the SAME columns — neighbours, not a stack',
    sh.xs.join() === hs.xs.join(), sh.xs.join() + ' vs ' + hs.xs.join());
const ba = cols(R.tiles('beachBuildArea1', 0, 0));
check('the buildarea reaches 4 tiles inland', ba.xs.join() === '0,1,2,3', ba.xs.join());
const hb = cols(R.tiles('heights.Beach1', 0, 0));
check('the Heights beach1 is the piece that reaches inland (the cliff)',
    hb.xs[0] >= 1 && hb.xs[hb.xs.length - 1] >= 14, hb.xs.join());
function shoreRows(set, kind) {
    R.build();
    const t = R.probe().tiles(set, kind), rows = new Set();
    for (let i = 0; i < t.length; i += 2) rows.add(t[i + 1]);
    return [...rows].sort((a, b) => a - b);
}
function gapFree(ys) {
    for (let i = 1; i < ys.length; i++) if (ys[i] !== ys[i - 1] + 1) return false;
    return true;
}
check('the lower shore covers every row from the seam to the land end, gap-free',
    (function () {
        const ys = shoreRows('lower', 'shore');
        return gapFree(ys) && ys[0] === -16 && ys[ys.length - 1] >= 700;
    })(), (function () { const y = shoreRows('lower', 'shore'); return y[0] + '..' + y[y.length - 1]; })());
check('the Heights shore covers y -112..-16 gap-free, and the lower one carries on',
    (function () {
        const ys = shoreRows('heights', 'h_shore');
        return gapFree(ys) && ys[0] === -112 && ys[ys.length - 1] >= -16;
    })(), (function () { const y = shoreRows('heights', 'h_shore'); return y[0] + '..' + y[y.length - 1]; })());

/* art blocks. THE POINT OF THIS GROUP: the art px space and the tile space are
   not the same axes. The art is pre-sheared oblique (gen_beach_tiles.tile_basis):
   tile (1,0) is art px (64,-32) and tile (0,1) is (64,+32), so a strip's opaque
   box reads 4 tiles wide ALONG THE COAST but its block rects read 18 art px
   across — comparing the two in raw px (the first version of this check) was
   simply the wrong test. Everything below goes through the basis. */
const bl = R.blocks('beachShore1');
check('every block of the lower shore resolves to a crop',
    bl.length === J.anims.beachShore1.frames[0].length &&
    bl.every(b => b.sw > 0 && b.sh > 0 && b.w > 0 && b.h > 0 && fin(b.dx) && fin(b.dy)),
    bl.length + '/' + J.anims.beachShore1.frames[0].length);
/* the generator's basis, verbatim (tools/gen_beach_tiles.py tile_basis) */
function tb(ax, ay) { return [(ax / 64 - ay / 32) / 2, (ax / 64 + ay / 32) / 2]; }
function tileBox(blocks) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of blocks)
        for (const p of [[b.dx, b.dy], [b.dx + b.w, b.dy], [b.dx, b.dy + b.h], [b.dx + b.w, b.dy + b.h]]) {
            const t = tb(p[0], p[1]);
            x0 = Math.min(x0, t[0]); y0 = Math.min(y0, t[1]);
            x1 = Math.max(x1, t[0]); y1 = Math.max(y1, t[1]);
        }
    return [x0, y0, x1, y1];
}
for (const [kind, anim] of [['shore', 'beachShore1'], ['buildarea', 'beachBuildArea1'],
                            ['h_shore', 'heights.BeachShore1'], ['h_beach', 'heights.Beach1'],
                            ['h_overlay', 'heights.BeachMtnOverlay']]) {
    const bb = tileBox(R.blocks(anim)), o = J.anims[anim].tilebox;
    check('the ' + kind + ' block rects bracket the measured opaque box (tile space)',
        bb[0] <= o[0] + 0.05 && bb[1] <= o[1] + 0.05 &&
        bb[2] >= o[2] - 0.05 && bb[3] >= o[3] - 0.05,
        JSON.stringify(bb.map(v => +v.toFixed(2))) + ' vs ' + JSON.stringify(o));
}
check('the shear transposes the axes: 18 art px across, 17 grid rows painted',
    (function () {
        let x1 = -Infinity;
        for (const b of bl) x1 = Math.max(x1, b.dx + b.w);
        return x1 / 64 > 16 && R.beach().tiles.shore.coverRows === 17;
    })(), 'art reaches tx=' + (Math.max.apply(null, bl.map(b => b.dx + b.w)) / 64).toFixed(1));
check('the two shores cover the same tile columns and the same 17 rows',
    (function () {
        const a = tileBox(R.blocks('beachShore1')), b = tileBox(R.blocks('heights.BeachShore1'));
        return Math.abs(a[0] - b[0]) < 0.2 && Math.abs(a[2] - b[2]) < 0.2 &&
            Math.abs(a[1] - b[1]) < 0.2 && Math.abs(a[3] - b[3]) < 0.3;
    })(), JSON.stringify(tileBox(R.blocks('beachShore1'))) + ' vs ' +
        JSON.stringify(tileBox(R.blocks('heights.BeachShore1'))));
check('the shore art straddles the anchor column; the buildarea is the inland half',
    (function () {
        const sh = J.anims.beachShore1.tilebox, ba = J.anims.beachBuildArea1.tilebox;
        return sh[0] < -3 && sh[2] <= 0.2 && ba[0] > -0.5 && ba[2] >= 3.5;
    })(), JSON.stringify(J.anims.beachShore1.tilebox) + ' / ' +
        JSON.stringify(J.anims.beachBuildArea1.tilebox));
check('rects() reports every block of every instance with finite geometry',
    (function () {
        const rr = R.probe().rects(64);
        return rr.length > 1000 && rr.every(r => fin(r.x) && fin(r.y) && r.w > 0 && r.h > 0);
    })(), R.probe().rects(64).length);
check('the rects name real cells of the right sheet',
    R.probe().rects(64).every(r => J.assets[/^heights\./.test(r.anim) ? 'heights'
        : /^land\./.test(r.anim) ? 'land' : 'beach'].cells.some(c => c[0] === r.cell)));
/* the blit must be the affine-consistent one: screen = A(anchor) + art px x k,
   which inverts (through the shipped ORIENT's A) to exactly tile_basis(art px).
   That is what makes the art land ON the tiles the tints cover. */
let bad;
check('the blit is affine-consistent: inverting a rect gives tile_basis(art px)',
    (function () {
        const A = CAM.tileAffine({ zoom: 1, x: 0, y: 0 }, 1200, 800), k = 64 / 64;
        const det = A.a * A.e - A.b * A.d;
        const inv = (sx, sy) => [((sx - A.c) * A.e - (sy - A.f) * A.b) / det,
                                 ((sy - A.f) * A.a - (sx - A.c) * A.d) / det];
        const inst = R.probe().instances().filter(r => r.set === 'lower')[0];
        const blocks = R.blocks('beachShore1');
        /* rects() walks the instance records in order, so the first N of this
           anim are the first instance's N blocks */
        const rr = R.probe().rects(64).filter(r => r.set === 'lower' &&
            r.anim === 'beachShore1').slice(0, blocks.length);
        if (rr.length !== blocks.length) { bad = 'count ' + rr.length + '/' + blocks.length; return false; }
        for (let i = 0; i < rr.length; i++) {
            const r = rr[i], b = blocks[i];
            const p = inv(r.x, r.y), e = tb(b.dx * k, b.dy * k);
            if (Math.abs(p[0] - (inst.ax + e[0])) > 1e-6 || Math.abs(p[1] - (inst.ay + e[1])) > 1e-6 ||
                Math.abs(r.w - b.w * k) > 1e-6 || Math.abs(r.h - b.h * k) > 1e-6) {
                bad = r.cell + ' got ' + [p[0], p[1], r.w, r.h] + ' want ' +
                    [inst.ax + e[0], inst.ay + e[1], b.w * k, b.h * k];
                return false;
            }
        }
        return true;
    })(), bad);

/* the real draw pass, twice: art toggle off, then persisted on */
function drawPass(Rr, T, s, centre) {
    const before = Rr.sprites.length;
    const w = centre ? CAM.tileToWorld(centre.tx, centre.ty) : { x: 0, y: 0 };
    const A = CAM.tileAffine({ zoom: 1, x: w.x, y: w.y }, Rr.VW, Rr.VH);
    Rr.build();
    Rr.draw(A, s || 64, T);
    return { sprites: Rr.sprites.slice(before) };
}
/* the coast, not the town: the band straddles tile x 0 from y -112 south, so
   the camera frames the seam there */
const COAST = { x0: -14, x1: 22, y0: -120, y1: 400 };
const ONCOAST = { tx: 0, ty: -16 };
const pass = drawPass(R, COAST, 64, ONCOAST);
check('with the art toggle off the pass emits no art sprites',
    pass.sprites.length === 0, pass.sprites.length);
const passA = drawPass(RA, COAST, 64, ONCOAST);
check('with the art toggle on the on-screen pass blits the strips near the seam',
    passA.sprites.length > 20, passA.sprites.length);
/* the sky's clouds are sprites that are not blocks of any instance: the
   block-for-block checks run with the sky off, and the sky has its own below */
RB.p.sky = false;
const passB = drawPass(RB, { x0: -1e6, x1: 1e6, y0: -1e6, y1: 1e6 }, 64);
check('unculled, the pass blits EXACTLY one sprite per block of every instance',
    passB.sprites.length === RB.probe().rects(64).length && passB.sprites.length > 1000,
    passB.sprites.length + ' vs ' + RB.probe().rects(64).length);
check('every art billboard has a finite placement matrix and a crop texture',
    passB.sprites.every(sp => sp.m && fin(sp.m.a) && fin(sp.m.d) && fin(sp.m.e) && fin(sp.m.f) &&
        sp.visible === true && sp.texture && fin(sp.texture.x) && sp.texture.w > 0));
check('the billboards sample all three sheets',
    new Set(passB.sprites.map(sp => sp.texture.u)).size === 3,
    [...new Set(passB.sprites.map(sp => sp.texture.u))].join(' '));
/* THE CHECK THAT WAS MISSING, and the reason two rounds of geometry fixes did
   not find this: everything above compares the INTENDED rect. A PIXI Sprite's
   matrix scales its texture frame (drawn box = frame * matrix) and beachArtC is
   on the stage, so a matrix of W/H draws the crop sw x sh times too big -- an
   87x62 shore cell became ~7,500 px and the 669x384 Heights overlay ~447,000,
   one opaque slab over the map. The Road Lab cannot show this: ctx.drawImage
   takes source and dest rects separately, so the same numbers are sizes there.
   So: measure what PIXI would actually paint. */
check('the billboards RENDER at the intended rect (matrix is a scale, not a size)',
    (function () {
        const rr = RB.probe().rects(64);
        if (passB.sprites.length !== rr.length) return false;
        for (let i = 0; i < rr.length; i++) {
            const sp = passB.sprites[i], r = rr[i];
            if (Math.abs(sp.m.a * sp.texture.w - r.w) > 0.5) return false;
            if (Math.abs(sp.m.d * sp.texture.h - r.h) > 0.5) return false;
            if (Math.abs(sp.m.e - r.x) > 0.5 || Math.abs(sp.m.f - r.y) > 0.5) return false;
        }
        return true;
    })(), 'drawn box = texture frame * matrix, per sprite');
check('no art blit is bigger than its own art (the massive-tile regression)',
    (function () {
        const rr = RB.probe().rects(64);
        const want = Math.max.apply(null, rr.map(r => r.w));
        const got = Math.max.apply(null, passB.sprites.map(sp => sp.m.a * sp.texture.w));
        return Math.abs(got - want) < 1 && got < 2000;
    })(), 'widest rendered sprite px vs widest art px');
check('the art pool is reused, not grown, across frames',
    (function () {
        const n = RB.sprites.length;
        const again = drawPass(RB, { x0: -1e6, x1: 1e6, y0: -1e6, y1: 1e6 }, 64);
        return RB.sprites.length === n && again.sprites.length === 0;
    })(), RB.sprites.length);
check('culling: a window over the town emits nothing',
    (function () { const p = drawPass(R, { x0: 200, x1: 260, y0: 100, y1: 160 }); return p.sprites.length === 0; })(),
    JSON.stringify(drawPass(R, { x0: 200, x1: 260, y0: 100, y1: 160 }).sprites.length));
/* a sheet that has not decoded (or was evicted) must draw NOTHING: a stretched
   placeholder texture is a solid rectangle over the coast — the same class of
   failure the Road Lab's black canvases were */
const RN = boot(true, { VW: 1e9, VH: 1e9 }, true);
check('an undecoded sheet draws no art at all (no placeholder rectangles)',
    (function () {
        const p = drawPass(RN, { x0: -1e6, x1: 1e6, y0: -1e6, y1: 1e6 }, 64);
        return p.sprites.length === 0;
    })(), RN.sprites.length + ' sprites');
check('the probe stays usable after a set() (params stay live)',
    (function () { const d = R.dirty(); R.probe().set('ax', 0); return R.p.ax === 0 && R.dirty() > d; })());
/* the bg fill rides with the art: one EEDDCC quad per on-screen beach1 strip,
   none with the art off, none with the bg toggle off */
check('art on: the Heights strips get their solid sand fill under the art',
    (function () {
        drawPass(RB, { x0: -1e6, x1: 1e6, y0: -1e6, y1: 1e6 }, 64);
        const f = RB.bgops.filter(o => o[0] === 'fill'), p = RB.bgops.filter(o => o[0] === 'poly');
        return f.length === 6 && p.length === 6 && f.every(o => o[1].color === 0xeeddcc) &&
            p.every(o => o[1].length === 8 && o[1].every(fin));
    })(), RB.bgops.length + ' bg ops');
check('art off, or bg off: no sand fill',
    (function () {
        drawPass(R, { x0: -1e6, x1: 1e6, y0: -1e6, y1: 1e6 }, 64);
        const off = R.bgops.length;
        RB.p.bg = false;
        drawPass(RB, { x0: -1e6, x1: 1e6, y0: -1e6, y1: 1e6 }, 64);
        const nobg = RB.bgops.length;
        RB.p.bg = true;
        return off === 0 && nobg === 0;
    })());

/* ---- 3b. the north edge: the `Land` LandEdges + the sky past them ---------
   MOUNTAINS (direction x, offsety -7, width 16 + padding 32) is the row of
   mountains across the top of the land where the Heights beach ends; past it
   the land stops, and this viewer paints sky + clouds */
const LE = J.tiles.n_mountains.landedge;
check('the manifest carries the default-season MOUNTAINS edge (not the Snow=1 one)',
    LE.animname === 'MOUNTAINS' && LE.direction === 'x' && LE.offsety === '-7' &&
    LE.repeat === '-1' && LE.width === '16' && LE.padding === '32' &&
    !LE.hasBackground && LE.snowBgColor === 'A2CEE2FF' &&
    J.tiles.n_mtnwater.landedge.repeat === '1' &&
    J.tiles.n_shore.landedge.offsety === '-10' && J.tiles.n_shore.landedge.repeat === '3',
    JSON.stringify(LE));
check('the Land anims ship frame 0 only, the friends-map card not at all',
    J.anims['land.mountains'].frames.length === 1 &&
    J.anims['land.mountains'].framesTotal === 132 &&
    !Object.keys(J.anims).some(k => /Friendsmap/.test(k)) &&
    J.landBlocks.x === -3 && J.landBlocks.y === -7 && J.landBlocks.w === 40,
    JSON.stringify(J.landBlocks));
check('the mountain row runs y -112 from x 0, every 48 tiles, to the land\'s east edge',
    (function () {
        const m = st('north', 'n_mountains');
        const xs = m.map(x => x.ax).sort((a, b) => a - b);
        return R.edge('n_mountains').step === 48 && R.edge('n_mountains').dir === 'x' &&
            m.every(x => x.ay === -112) && xs[0] === 0 &&
            xs.every((x, i) => x === i * 48) &&
            xs[xs.length - 1] < 592 && xs[xs.length - 1] + 56 >= 592;
    })(), st('north', 'n_mountains').map(x => x.ax).join());
check('MOUNTAINSTOWATER is one stamp at the water end; SHORELINE2 runs y -160..-112',
    (function () {
        const w = st('north', 'n_mtnwater'), sh = st('north', 'n_shore');
        return w.length === 1 && w[0].ax === 0 && w[0].ay === -112 &&
            sh.map(x => x.ay).join() === '-160,-144,-128' && sh.every(x => x.ax === 0);
    })(), JSON.stringify(st('north', 'n_shore').map(x => [x.ax, x.ay])));
check('the mountain art covers the row: 56 wide, 46 rows north of y -112',
    (function () {
        const t = R.probe().tiles('north', 'n_mountains');
        let y0 = Infinity, y1 = -Infinity;
        for (let i = 0; i < t.length; i += 2) { y0 = Math.min(y0, t[i + 1]); y1 = Math.max(y1, t[i + 1]); }
        const b = J.anims['land.mountains'].tilebox;
        return b[2] - b[0] > 55 && y1 === -113 && y0 <= -157;
    })(), JSON.stringify(J.anims['land.mountains'].tilebox));
check('the Land set is drawn first (farthest), and far-first within the row',
    (function () {
        const ii = R.probe().instances();
        const m = ii.filter(x => x.kind === 'n_mountains').map(x => x.ax);
        return ii[0].set === 'north' &&
            ii.findIndex(x => x.set !== 'north') > ii.map(x => x.set).lastIndexOf('north') - 1 &&
            m.join() === m.slice().sort((a, b) => b - a).join();
    })(), R.probe().instances().slice(0, 3).map(x => x.kind).join());
check('the mountain-row toggle drops exactly the Land set',
    (function () {
        R.p.north = false; R.build();
        const n = R.probe().instances().filter(x => x.set === 'north').length;
        R.p.north = true; R.build();
        return n === 0 && R.probe().instances().filter(x => x.set === 'north').length === 17;
    })());
/* the cloud wall (2026-10-30.19): read off the in-game full-map export
   (calib-export.png through the g2e homography) — flat #EFFFFF over all of
   the off-land ground, its north edge 16 rows behind the mountain row's foot
   (y -128, the row's own Snow bgOffsetY), its east edge the land's (x 592),
   drawn OVER the mountain art. It replaced a sky fill + scattered C_Cloud
   sprites, which was the wrong look: the C_Cloud crops are the clouds inside
   the mountain art, not the wall */
check('the cloud wall edge: y -128 (16 behind the row at -112), x 592 (the land\'s east edge)',
    (function () {
        const e = R.probe().cloudEdge();
        return e.north === -128 && e.east === 592 &&
            e.north === st('north', 'n_mountains')[0].ay - 16;
    })(), JSON.stringify(R.probe().cloudEdge()));
check('the wall is its own Graphics, stacked right ABOVE the coast art',
    /app\.stage\.addChild\(beachArtC\);[^\n]*\n\s*app\.stage\.addChild\(beachCloudG\);/.test(pv) &&
    /beachHideRest\(\);[\s\S]{0,200}?if \(beachP\.sky && beachP\.north\) beachCloudDraw/.test(pv) &&
    /var BEACH_CLOUD = 0xefffff;/.test(pv));
const RS = boot(true, { VW: 1e9, VH: 1e9 });
/* the draw pass with a stub that records the wall's own Graphics */
function cloudPass(Rr, T, centre) {
    const ops = [];
    const CG = { clear: () => { ops.length = 0; } };
    CG.poly = p => { ops.push(['poly', p]); return CG; };
    CG.circle = (x, y, r) => { ops.push(['circle', x, y, r]); return CG; };
    CG.fill = o => { ops.push(['fill', o]); return CG; };
    Rr.setCloudG(CG);
    drawPass(Rr, T, 64, centre);
    return ops;
}
const cloudSrc = pv.slice(pv.indexOf('function beachCloudDraw'), pv.indexOf('function beachHideRest'));
check('art on: white wall bands + a rim strip + puffs, all vector — no sprites',
    (function () {
        const ops = cloudPass(RS, { x0: -40, x1: 40, y0: -200, y1: -80 }, { tx: 0, ty: -128 });
        const fills = ops.filter(o => o[0] === 'fill').map(o => o[1].color);
        const circ = ops.filter(o => o[0] === 'circle');
        return fills.filter(c => c === 0xefffff).length > 20 &&
            fills.filter(c => c === 0xbac7dd).length > 20 &&
            circ.length > 40 && circ.every(c => fin(c[1]) && fin(c[2]) && c[3] > 0) &&
            !/beachArtTake|subTex/.test(cloudSrc);
    })());
check('the wall is culled with the view: nothing over the town',
    cloudPass(RA, { x0: 200, x1: 260, y0: 100, y1: 160 }, { tx: 230, ty: 130 }).length === 0);
check('the east band only starts at x 592: a view on the land\'s east edge gets both sides',
    (function () {
        const ops = cloudPass(RA, { x0: 570, x1: 620, y0: 0, y1: 40 }, { tx: 592, ty: 20 });
        return ops.filter(o => o[0] === 'poly').length >= 2 && ops.some(o => o[0] === 'circle');
    })());
check('cloud wall off, or the mountain row off: no wall',
    (function () {
        RS.p.sky = false;
        const a = cloudPass(RS, { x0: -40, x1: 40, y0: -200, y1: -80 }, { tx: 0, ty: -128 }).length;
        RS.p.sky = true; RS.p.north = false;
        const b = cloudPass(RS, { x0: -40, x1: 40, y0: -200, y1: -80 }, { tx: 0, ty: -128 }).length;
        RS.p.north = true;
        return a === 0 && b === 0;
    })());

/* ---- 4. the page + the sheet --------------------------------------------- */
const html = read('web/viewer/index.html');
check('page ships the two beach toggles (the sets overlay is gone)',
    !/id="btn-beachsets"/.test(html) && /id="btn-beachart"/.test(html) && /id="btn-beachtune"/.test(html));
check('the beach buttons use data-tip, never title (project rule)',
    !/<button[^>]*id="btn-beach[^"]*"[^>]*\stitle=/.test(html) &&
    /id="btn-beachart"[^>]*data-tip="the two beach sets/.test(html));
check('tips name both LandEdge filenames and the repeat values',
    /filename=&quot;Beach&quot;/.test(html) &&
    /filename=&quot;springfieldheightsnobeach&quot;/.test(html) &&
    /repeat=&quot;6&quot;/.test(html) && /repeat=&quot;-1&quot;/.test(html));
check('page ships the tune panel div', /id="beachtune" class="legend"/.test(html));
const cb = (html.match(/city-view-pixi\.js\?v=(\d+)/) || [])[1] * 1;
check('viewer cache-buster bumped for the Beach sets removal (>= 102)', cb >= 102, cb);
const css = read('web/css/city-view.css');
check('the tune panel is styled (and shares the arttune widgets)',
    /#beachtune \{/.test(css) && /#arttune \.tbtn, #beachtune \.tbtn \{/.test(css));
check('the css cache-buster matches the stylesheet change', /city-view\.css\?v=15/.test(html));

/* ---- 5. the lab still agrees with the viewer ------------------------------ */
const lab = read('web/viewer/road-lab.js');
check('the lab measures tiles with the same rule',
    /Math\.ceil\(b\[0\] - 0\.5 \+ ax\); tx <= Math\.floor\(b\[2\] - 0\.5 \+ ax\)/.test(lab));
check('the lab blits blocks with the same formula',
    /dx: ax \+ \(blk\[1\] - \(blk\[3\] < 0 \? cell\[3\] \* mx : 0\)\) \* k/.test(lab));
check('both views read the same manifest',
    lab.includes('assets/city/beach-tiles.json') && pv.includes('assets/city/beach-tiles.json'));

console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
