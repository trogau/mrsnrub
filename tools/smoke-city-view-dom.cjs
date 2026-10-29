// Headless DOM test for the City View page (web/city-view.html).
// Drives the real js/camera.js + terrain.js + objects.js + walks.js + city-view.js in
// Node with a minimal DOM (canvas ctx = recording no-op proxy), then exercises
// the click-to-inspect + details pane, Esc/background deselect, drag-then-click
// suppression, character dot picking, and the search box (matchinfo, Enter
// selects first match, Esc clears). The selection/search outlines are pinned
// via ctx.stroke counting (terrain/people only fill).
//
//   node tools/smoke-city-view-dom.cjs
'use strict';
const path = require('path');
const GLMODE = process.argv.includes('--gl');    // child run: fake GL renderer
const ROOT = process.argv[2] && !process.argv[2].startsWith('--')
    ? process.argv[2] : path.join(__dirname, '..', 'web');

// ---- minimal DOM -------------------------------------------------------------
class FakeEl {
    constructor(tag) {
        this.tagName = String(tag || 'div').toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.style = {};
        this.dataset = {};
        this.attrs = {};
        this.textContent = '';
        this.value = '';
        this.listeners = {};
        this._html = '';
        this.clientWidth = 1000;
        this.clientHeight = 800;
        const self = this;
        this._cls = new Set();
        Object.defineProperty(this, 'className', {
            get() { return [...this._cls].join(' '); },
            set(v) {
                this._cls.clear();
                String(v || '').split(/\s+/).filter(Boolean)
                    .forEach(c => this._cls.add(c));
            }
        });
        this.classList = {
            _set: this._cls,
            toggle(c, on) {
                if (on === undefined) { on = !self.classList._set.has(c); }
                if (on) { self.classList._set.add(c); } else { self.classList._set.delete(c); }
                return on;
            },
            add(c) { this._set.add(c); },
            remove(...cs) { cs.forEach(c => this._set.delete(c)); },
            contains(c) { return this._set.has(c); }
        };
    }
    get innerHTML() { return this._html; }
    set innerHTML(v) { this._html = v; if (v === '') { this.children = []; } }
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
    dispatch(ev, arg) { (this.listeners[ev] || []).slice().forEach(fn => fn(arg || {})); }
    closest(sel) {
        const parts = sel.split(',').map(s => {
            const m = /^\s*([A-Za-z][\w-]*)?((?:\.[\w-]+)*)/.exec(s);
            return {
                tag: m[1] ? m[1].toUpperCase() : null,
                cls: (m[2].match(/[\w-]+/g) || [])
            };
        });
        for (let n = this; n && n.classList; n = n.parentNode) {
            if (parts.some(p => (!p.tag || n.tagName === p.tag) &&
                p.cls.every(c => n.classList.contains(c)))) { return n; }
        }
        return null;
    }
    querySelectorAll() { return []; }        // legend rows are innerHTML-only here
    getAttribute(n) { return this.attrs[n] !== undefined ? this.attrs[n] : null; }
    setAttribute(n, v) { this.attrs[n] = String(v); }
    setPointerCapture() {}
    getBoundingClientRect() { return { width: this.clientWidth, height: this.clientHeight, left: 0, top: 0 }; }
    getContext() { return makeCtx(); }
}

// canvas 2D context: records strokes (the only ones on the page come from
// drawMarks), no-ops everything else; chained calls (createPattern etc.) get
// the same all-purpose proxy back.
global.STROKES = 0;
global.DRAWIMG = 0;
function makeCtx() {
    const store = {};
    const h = {
        get(t, p) {
            if (p in t) return t[p];
            if (p === 'stroke') return function () { global.STROKES++; };
            if (p === 'drawImage') return function () { global.DRAWIMG++; };
            return function () { return u; };
        },
        set(t, p, v) { t[p] = v; return true; }
    };
    const u = new Proxy(store, h);
    return u;
}

global.window = global;
global.devicePixelRatio = 1;
global.Image = class {
    constructor() { this.onload = null; this.onerror = null;
        this.complete = false; this.naturalWidth = 0; }
    set src(v) {
        this._src = v;
        this.complete = true; this.naturalWidth = 10; this.naturalHeight = 10;
        const f = this.onload; if (f) setTimeout(() => f(), 0);
    }
    get src() { return this._src; }
};
global.__LSTORE = { 'mrsnrub.cityview.markers': '' };   // boot with an
global.localStorage = {                                  // empty marker box
    getItem: k => (k in global.__LSTORE ? global.__LSTORE[k] : null),
    setItem(k, v) { global.__LSTORE[k] = String(v); },
    removeItem(k) { delete global.__LSTORE[k]; }
};
// sprite-manifest fetches are served from __ART_SEED (filled after the data
// script loads — see the load section) so the billboard branches get the
// real page's code path with deterministic content.
global.fetch = url => Promise.resolve({ ok: true, json: () => Promise.resolve(
    String(url).indexOf('city-anims') >= 0 ? global.__ART_SEED.anims
        : String(url).indexOf('city-sprites') >= 0 ? global.__ART_SEED.city
        : global.__ART_SEED.chars) });
const winListeners = {};
global.addEventListener = (ev, fn) => { (winListeners[ev] = winListeners[ev] || []).push(fn); };
const fireWin = (ev, arg) => (winListeners[ev] || []).slice().forEach(fn => fn(arg || {}));
let rafQueue = [];
global.requestAnimationFrame = cb => { rafQueue.push(cb); return rafQueue.length; };
const flushRaf = () => { const q = rafQueue; rafQueue = []; q.forEach(cb => cb(performance.now())); };

const named = {};
['stage', 'cv', 'glcv', 'legend', 'objlegend', 'statsbar', 'zoomread', 'orientread',
  'assets',
 'btn-rest', 'btn-springfield', 'btn-downtown', 'btn-full', 'btn-ocean', 'btn-reset', 'btn-rot',
 'btn-flip', 'btn-sheetart', 'btn-frags', 'btn-roadnet', 'btn-proposed', 'btn-art', 'btn-anim', 'btn-season', 'btn-grid', 'btn-tune', 'btn-wire', 'arttune', 'proplegend',
 'details', 'results', 'search', 'matchinfo']
    .forEach(id => { named[id] = new FakeEl(id === 'cv' || id === 'glcv' ? 'canvas' : 'div'); });
named.details.innerHTML =
    '<div class="placeholder">Click a building or character&hellip;</div>';  // as in the HTML
global.document = {
    readyState: 'complete',
    activeElement: null,
    getElementById: id => named[id] || null,
    createElement: tag => new FakeEl(tag),
    createDocumentFragment: () => Object.assign(new FakeEl('#frag'), { isFragment: true }),
    body: new FakeEl('body'),
    addEventListener() {}
};

// ---- load the real page scripts ------------------------------------------------
require(path.join(ROOT, 'js/map-explorer-data.js'));
global.CAM = require(path.join(ROOT, 'js/camera.js'));
global.CityTerrain = require(path.join(ROOT, 'js/terrain.js')).CityTerrain;
require(path.join(ROOT, 'js/objects.js'));            // sets globalThis.CityObjects
require(path.join(ROOT, 'js/walks.js'));              // sets globalThis.CityWalks
require(path.join(ROOT, 'js/markers.js'));            // sets globalThis.CityMarkers
require(path.join(ROOT, 'js/gl-base.js'));            // sets globalThis.CityGL (null ctx headless)
if (GLMODE) {
    // fake renderer: the point is NOT to test GL itself but that the quad
    // streams and the atlas the page hands drawTop are well-formed
    globalThis.CityGL = {
        create() { return {
            draw: () => true,
            drawTop: st => { global.__TOP = st; return true; },
            maxTex: 8192
        }; },
        lastError: () => 'fake-gl'
    };
}
// one real building slug + one real character id -> sprites exist for both,
// so artMode exercises drawSprite + drawPeopleArt loaded branches, while
// everything else exercises the block/dot fallbacks.
(() => {
    const M0 = global.MAP_DATA;
    let slug = '';
    for (const b of M0.buildings) { const e = M0.binfo[b[0]];
        if (e && e[2]) { slug = e[2]; break; } }
    const cid = Object.keys(M0.charNames)[0];
    global.__SEED_CID = cid;              // the character-idle-loop check centres on this one
    global.__ART_SEED = {
        city: { sprites: { [slug]: { png: 'seed.png', w: 200, h: 100,
            anchor: [100, 90] } } },
        chars: { assets: { seedchar: { png: 'seed.png', w: 76, h: 208,
            anchor: [38, 205], frames: [{ file: 'seed.png', delay: 200 },
                { file: 'seed.png', delay: 200 },
                { file: 'seed.png', delay: 200 }] } },
            characters: { [cid]: { name: M0.charNames[cid], slug: 'seedchar' } } }
    };
    /* giant second sprite on the slugged building NEAREST the rest-preset
       camera centre (downtown centre, zoom 1.0 -> drawn 4000*1.03): the
       deep-zoom blur guard (drawn > 1536 -> 2D 'art') then fires on a
       deterministic building instead of the accidental data order */
    const RD = M0.downtown[0];
    const rmx = (RD[0] + RD[1]) / 2, rmy = (RD[2] + RD[3]) / 2;
    let bslug = '', bslugD = 1e18;
    for (const b of M0.buildings) {
        const e = M0.binfo[b[0]];
        const sg = b[8] || (e && e[2]) || '';
        if (!sg) continue;
        const d = (b[6] - rmx) * (b[6] - rmx) + (b[7] - rmy) * (b[7] - rmy);
        if (d < bslugD) { bslugD = d; bslug = sg; }
    }
    if (bslug && !GLMODE) {
        global.__ART_SEED.city.sprites[bslug] =
            { png: 'seed2.png', w: 4000, h: 2200, anchor: [2000, 1980],
              // season variant (2026-10-25): the generator files the
              // seasonal re-ship under seasons/<class>/ and mirrors its
              // geometry here; the winter mode must draw THIS png instead
              seasons: { winter: { png: 'seasons/winter/seed2.png',
                  w: 4000, h: 2200, anchor: [2000, 1980], season: 'winter' } } };
    }
    if (GLMODE) {
        /* seed several static sprites around the boot (SpringfieldDowns)
           camera so the GL atlas packer has >= 4 distinct cells to place:
           the shared-atlas-slot regression (all sprites sampling one cell)
           is invisible with a single seeded slug */
        const sd = M0.buildings.find(b => M0.binfo[b[0]] &&
            M0.binfo[b[0]][0] === 'SpringfieldDowns');
        if (sd) {
            const near = M0.buildings
                .map(b => ({ b, d: Math.hypot(b[6] - sd[6], b[7] - sd[7]) }))
                .filter(o => o.d <= 40)
                .sort((p, q) => p.d - q.d);
            let seeded = 0;
            for (const { b } of near) {
                if (seeded >= 8) break;
                const e = M0.binfo[b[0]];
                const sg = b[8] || (e && e[2]) || '';
                if (!sg || global.__ART_SEED.city.sprites[sg]) continue;
                global.__ART_SEED.city.sprites[sg] =
                    { png: sg + '.png', w: 200, h: 100, anchor: [100, 90] };
                seeded++;
            }
        }
    }
    /* one real bsv3 filmstrip on a SAVE-PLACED asset: the map animation
       path (filmstrip cell blits instead of the static PNG) exercises on
       a deterministic building; the static seed sprite lets it past the
       readability gate, the loop entry drives the cell geometry */
    const animMan = require(path.join(ROOT, 'assets/city/city-anims.json'));
    global.__ART_SEED.anims = { anims: {}, behavior: {} };
    // ANIM_FORCE=slug debug knob: seed exactly that save-placed asset
    // (bypassing the size filters) to reproduce a user-reported no-anim
    const AF = process.env.ANIM_FORCE;
    for (const [mi, b] of M0.buildings.entries()) {
        const e = M0.binfo[b[0]];
        const sg = ((e && e[2]) || '').toLowerCase();
        const rows = animMan.anims[sg];
        const a = rows && rows[0];
        if (!sg || !a || sg === slug || sg === bslug) continue;
        // pick a loop that PASSES the perf gates: small enough atlas to
        // decode, cell short edge readable at rest zoom (k≈1.03) but not at
        // the 0.33 overview zoom — so both sides of the floor get exercised
        const minD = Math.min(a.cellw, a.cellh);
        const atlasPx = a.cols * a.cellw * Math.ceil(a.frames / a.cols) * a.cellh;
        if (AF ? sg !== AF
            : !(minD >= 80 && minD <= 150 && atlasPx <= 6e6)) continue;
        // prefer an asset with a SECOND multi-frame strip: that one seeds
        // the behaviour tap filmstrip (the click-to-play regression)
        const multi = rows.length > 1 && rows[1].frames > 1;
        if (global.__ANIM_SEED && (!multi || global.__ANIM_SEED.multi)) continue;
        if (global.__ANIM_SEED) {       // upgrade: drop the replaced seed's
            delete global.__ART_SEED.anims.anims[global.__ANIM_SEED.slug];
            delete global.__ART_SEED.anims.behavior[global.__ANIM_SEED.slug];
            delete global.__ART_SEED.city.sprites[global.__ANIM_SEED.slug];
        }
        global.__ART_SEED.anims.anims[sg] = rows;   // keep the manifest's
        global.__ART_SEED.anims.behavior[sg] =
            { idle: a.anim, tap: multi ? rows[1].anim : null };
        global.__ART_SEED.city.sprites[sg] =
            { png: 'animseed.png', w: a.cellw, h: a.cellh, anchor: [a.ax, a.ay] };
        global.__ANIM_SEED = { slug: sg, mi, px: b[6], py: b[7], entry: a,
                               fw: b[3], fh: b[4], rows, multi: !!multi };
    }
    /* decode-cap tiering regression (shark tank): the first blanket 6 Mpx
       filmstrip cap froze ~2/3 of the catalogue on the MAP while the sidebar
       player ignored it. Seed one placed asset whose longest loop is BIG
       (6–16 Mpx: must animate on the map) and one GIANT (> 16 Mpx: must
       stay static); both cell-sized like the small seed so the readability
       floor and the 0.33-overview checks behave identically around them. */
    for (const b of M0.buildings) {
        const e = M0.binfo[b[0]];
        const sg = ((e && e[2]) || '').toLowerCase();
        const rows = animMan.anims[sg];
        const a = rows && rows[0];
        if (!sg || !a || global.__ANIM_BIG_SEED || sg === slug || sg === bslug ||
            (global.__ANIM_SEED && sg === global.__ANIM_SEED.slug)) continue;
        const minD = Math.min(a.cellw, a.cellh);
        const atlasPx = a.cols * a.cellw * Math.ceil(a.frames / a.cols) * a.cellh;
        if (!(minD >= 80 && minD <= 1200 && atlasPx > 6e6 && atlasPx <= 16e6)) continue;
        // stay clear of BOTH cameras the earlier checks park at rest zoom:
        // the small seed's wc (0.33 overview asserts anims === 0) and the
        // far-off-screen spot (+60000 world px ≈ 937 tiles past it)
        const AS = global.__ANIM_SEED;
        if (AS && (Math.max(Math.abs(b[6] - AS.px), Math.abs(b[7] - AS.py)) < 150 ||
                   Math.max(Math.abs(b[6] - (AS.px + 937)),
                            Math.abs(b[7] - (AS.py + 937))) < 150)) continue;
        global.__ART_SEED.anims.anims[sg] = rows;
        global.__ART_SEED.anims.behavior[sg] = { idle: a.anim, tap: null };
        global.__ART_SEED.city.sprites[sg] =
            { png: 'animbig.png', w: a.cellw, h: a.cellh, anchor: [a.ax, a.ay] };
        global.__ANIM_BIG_SEED = { slug: sg, px: b[6], py: b[7], entry: a };
    }
    /* eviction-thrash regression (the "art 16,274/7,844 forever" bug): a
       second big filmstrip placed NEAR the big seed, so one camera shows two
       of them competing for one cache slot. The old LRU evicted whatever sat
       at its head — a visible strip — and re-decoded it next frame, forever;
       the cache must instead refuse the arrival and leave the visible one
       alone. Rival exclusions mirror the giant seed's camera rules. */
    const ABs0 = global.__ANIM_BIG_SEED;
    if (ABs0) {
        let best = null, bestD = 1e18;
        for (const b of M0.buildings) {
            const e = M0.binfo[b[0]];
            const sg = ((e && e[2]) || '').toLowerCase();
            const rows = animMan.anims[sg];
            const a = rows && rows[0];
            if (!sg || !a || sg === slug || sg === bslug ||
                sg === ABs0.slug || (global.__ANIM_SEED && sg === global.__ANIM_SEED.slug))
                continue;
            const minD = Math.min(a.cellw, a.cellh);
            const atlasPx = a.cols * a.cellw * Math.ceil(a.frames / a.cols) * a.cellh;
            if (!(minD >= 80 && minD <= 1200 && atlasPx > 6e6 && atlasPx <= 16e6)) continue;
            const d = Math.max(Math.abs(b[6] - ABs0.px), Math.abs(b[7] - ABs0.py));
            if (d < 10 || d > 120 || d >= bestD) continue;
            const AS = global.__ANIM_SEED;
            if (AS && Math.max(Math.abs(b[6] - AS.px), Math.abs(b[7] - AS.py)) < 150)
                continue;
            best = { sg, rows, a, b, d }; bestD = d;
        }
        if (best) {
            global.__ART_SEED.anims.anims[best.sg] = best.rows;
            global.__ART_SEED.anims.behavior[best.sg] = { idle: best.a.anim, tap: null };
            global.__ART_SEED.city.sprites[best.sg] =
                { png: 'animbig.png', w: best.a.cellw, h: best.a.cellh,
                  anchor: [best.a.ax, best.a.ay] };
            global.__ANIM_RIVAL_SEED = { slug: best.sg, px: best.b[6],
                                         py: best.b[7], entry: best.a, d: bestD };
        }
    }
    for (const b of M0.buildings) {
        const e = M0.binfo[b[0]];
        const sg = ((e && e[2]) || '').toLowerCase();
        const rows = animMan.anims[sg];
        const a = rows && rows[0];
        if (!sg || !a || global.__ANIM_GIANT_SEED || sg === slug || sg === bslug ||
            (global.__ANIM_SEED && sg === global.__ANIM_SEED.slug) ||
            (global.__ANIM_BIG_SEED && sg === global.__ANIM_BIG_SEED.slug)) continue;
        const minD = Math.min(a.cellw, a.cellh);
        const atlasPx = a.w ? a.w * a.h      // sparse: the PACKED atlas is what the
                      : a.cols * a.cellw * Math.ceil(a.frames / a.cols) * a.cellh;
                                        // player decodes (and exempts)
        if (a.sub || a.sparse) continue;   // cluster rects: not the grid gate
        if (!(minD >= 80 && minD <= 1200 && atlasPx > 16e6)) continue;
        // a layered asset is the composites-own-body case below, not a
        // giant-idle one: seeding it here would fake an idle gate it lacks;
        // a toggle asset (the helicopter class) is click-driven, and
        // overriding its gate with a longest-strip idle would erase that
        if (animMan.behavior && animMan.behavior[sg] &&
            (animMan.behavior[sg].layers || animMan.behavior[sg].toggle)) continue;
        // its own check centres HERE and asserts anims === 0: no other seed
        // may be in view, and this camera spot must not disturb the others'
        const AS = global.__ANIM_SEED, ABs = global.__ANIM_BIG_SEED;
        if (AS && Math.max(Math.abs(b[6] - AS.px), Math.abs(b[7] - AS.py)) < 150) continue;
        if (ABs && (Math.max(Math.abs(b[6] - ABs.px), Math.abs(b[7] - ABs.py)) < 150 ||
                    Math.max(Math.abs(b[6] - (ABs.px + 937)),
                             Math.abs(b[7] - (ABs.py + 937))) < 150)) continue;
        const RV = global.__ANIM_RIVAL_SEED;   // the thrash rival shares the
        if (RV && Math.max(Math.abs(b[6] - RV.px), Math.abs(b[7] - RV.py)) < 150)
            continue;                          // big seed's camera: stay clear
        global.__ART_SEED.anims.anims[sg] = rows;
        global.__ART_SEED.anims.behavior[sg] = { idle: a.anim, tap: null };
        global.__ART_SEED.city.sprites[sg] =
            { png: 'animgiant.png', w: a.cellw, h: a.cellh, anchor: [a.ax, a.ay] };
        global.__ANIM_GIANT_SEED = { slug: sg, px: b[6], py: b[7], entry: a };
    }
    /* layered-asset regression (escalator fix): assets with NO controller
       loop animate as stacked <AnimationLayerOrder> part loops over their
       static body PNG. Seed one save-placed slug the gate marks layers, with
       at least one layer inside the map's decode gates (any oversized layer
       stays in the record to exercise the per-layer skip) */
    // the escalator is the asset that motivated the fix: try it first
    const layPref = b => ((((M0.binfo[b[0]] || [])[2] || '') + '')
                          .toLowerCase() === 'escalatortonowhere' ? 0 : 1);
    for (const b of [...M0.buildings].sort((p, q) => layPref(p) - layPref(q))) {
        const e = M0.binfo[b[0]];
        const sg = ((e && e[2]) || '').toLowerCase();
        const rows = animMan.anims[sg];
        const lay = animMan.behavior && animMan.behavior[sg] &&
                    animMan.behavior[sg].layers;
        if (!sg || !rows || !lay || b[5] || b[8] || global.__ANIM_LAY_SEED ||
            sg === slug || sg === bslug ||
            (global.__ANIM_SEED && sg === global.__ANIM_SEED.slug) ||
            (global.__ANIM_BIG_SEED && sg === global.__ANIM_BIG_SEED.slug) ||
            (global.__ANIM_GIANT_SEED && sg === global.__ANIM_GIANT_SEED.slug)) continue;
        const pass = [], gated = [], reg = [];
        const pxOf = a => a.w ? a.w * a.h
                              : a.cols * a.cellw * Math.ceil(a.frames / a.cols) * a.cellh;
        for (const nm of lay) {
            const a = rows.find(x => x.anim === nm && x.frames >= 1);
            if (!a) continue;
            reg.push(a.anim);             // what the player registers on load
            (Math.min(a.cellw, a.cellh) >= 80 && pxOf(a) <= 16e6
                ? pass : gated).push(a.anim);
        }
        if (!pass.length) continue;
        // no camera that asserts anims === 0 may land near this one: the
        // small seed's (overview + off-screen checks) and the giant's —
        // the big-seed camera expects anims > 0 anyway, so it's harmless
        const near = [global.__ANIM_SEED, global.__ANIM_GIANT_SEED]
            .filter(Boolean)
            .map(S => [S.px, S.py, S.px + 937, S.py + 937])
            .some(q => Math.max(Math.abs(b[6] - q[0]), Math.abs(b[7] - q[1])) < 150 ||
                       Math.max(Math.abs(b[6] - q[2]), Math.abs(b[7] - q[3])) < 150);
        if (near) continue;
        global.__ART_SEED.anims.anims[sg] = rows;
        global.__ART_SEED.anims.behavior[sg] = { idle: null, tap: null,
                                                 layers: lay };
        global.__ART_SEED.city.sprites[sg] =
            { png: 'animlay.png', w: 1600, h: 2400, anchor: [320, 2300] };
        global.__ANIM_LAY_SEED = { slug: sg, px: b[6], py: b[7],
                                   pass: pass, gated: gated, reg: reg };
    }
    /* engine-builtin toggle class (the helicopter): the gate has NO idle and
       no tap — a click plays the manifest's Active_In one-shot, the building
       then loops Active, and the next click plays Active_Out back to static
       Neutral (the DecorationTapped_WithActiveInOut semantics). Seed one
       save-placed toggle slug (the helicopter first) with its trio, outside
       every other anim camera. Oversize atlases exercise the click-driven
       exception to the 16 Mpx map cap too. */
    const togPref = b => ((((M0.binfo[b[0]] || [])[2] || '') + '')
                          .toLowerCase() === 'redstarhelicopter' ? 0 : 1);
    for (const b of [...M0.buildings].sort((p, q) => togPref(p) - togPref(q))) {
        const e = M0.binfo[b[0]];
        const sg = ((e && e[2]) || '').toLowerCase();
        const rows = animMan.anims[sg];
        const tg = animMan.behavior && animMan.behavior[sg] &&
                   animMan.behavior[sg].toggle;
        if (!sg || !rows || !tg || b[5] || global.__ANIM_TOG_SEED ||
            sg === slug || sg === bslug ||
            (global.__ANIM_SEED && sg === global.__ANIM_SEED.slug) ||
            (global.__ANIM_BIG_SEED && sg === global.__ANIM_BIG_SEED.slug) ||
            (global.__ANIM_GIANT_SEED && sg === global.__ANIM_GIANT_SEED.slug) ||
            (global.__ANIM_LAY_SEED && sg === global.__ANIM_LAY_SEED.slug)) continue;
        const strips = ['in', 'loop', 'out'].map(x =>
            rows.find(r => r.anim && r.frames > 1 &&
                           r.anim.toLowerCase() === String(tg[x]).toLowerCase()));
        if (strips.some(x => !x)) continue;
        // no anim camera may see this building: ours asserts anims === 0
        // at rest and > 0 when active, the others assert the opposite near
        // their own centres
        const near = [global.__ANIM_SEED, global.__ANIM_BIG_SEED,
                      global.__ANIM_GIANT_SEED, global.__ANIM_LAY_SEED]
            .filter(Boolean)
            .map(S => [S.px, S.py, S.px + 937, S.py + 937])
            .some(q => Math.max(Math.abs(b[6] - q[0]), Math.abs(b[7] - q[1])) < 150 ||
                       Math.max(Math.abs(b[6] - q[2]), Math.abs(b[7] - q[3])) < 150);
        if (near) continue;
        const a = strips[1];
        global.__ART_SEED.anims.anims[sg] = rows;
        global.__ART_SEED.anims.behavior[sg] = { idle: null, tap: null,
                                                 toggle: tg };
        global.__ART_SEED.city.sprites[sg] =
            { png: 'animtog.png', w: a.cellw, h: a.cellh, anchor: [a.ax, a.ay] };
        global.__ANIM_TOG_SEED = { slug: sg, mi: M0.buildings.indexOf(b),
                                   px: b[6], py: b[7],
                                   tog: { 'in': strips[0], loop: strips[1],
                                          out: strips[2] } };
    }
    /* state-machine shapes beyond the helicopter's trio: k9unit = cycle
       (ToggleState poses) and deprivationtank = inout with NO Active loop
       (state 1 holds In's final frame), both seeded from their real saved
       gates; and the 'active' on/off toggle. The real active asset
       (giantlobsterscorpion) sits 8 tiles from the small seed's camera, so
       the two would contaminate each other's anims counts — the player path
       is instead exercised on a synthetic active record over any placed,
       otherwise-static asset, while the generator's real gates for all
       three slugs are pinned by manifest checks below. Missing data skips
       the kind. */
    global.__ANIM_TOG2_SEEDS = {};
    // camera clearances: only the small/big seeds park an 0.33-overview
    // camera at +937 tiles that asserts anims === 0 (view ±47 tiles) — keep
    // the 150-tile margin there. The giant/layer/heli cameras assert at
    // rest zoom (view ±8 tiles), so a smaller margin still rules out any
    // in-view contamination.
    const TGCAM = [[global.__ANIM_SEED, 150, 1],
                   [global.__ANIM_BIG_SEED, 40, 1],
                   [global.__ANIM_GIANT_SEED, 150, 0], [global.__ANIM_LAY_SEED, 60, 0],
                   [global.__ANIM_TOG_SEED, 40, 0]].filter(S => S[0]);
    const tgFar = (px, py, off) => !TGCAM.some(([S, d, o]) =>
        [[S.px, S.py], ...(o && off !== false ? [[S.px + 937, S.py + 937]] : [])]
            .some(q => Math.max(Math.abs(px - q[0]), Math.abs(py - q[1])) < d));
    const tgClaim = mi => Object.keys(global.__ANIM_TOG2_SEEDS)
        .some(k => global.__ANIM_TOG2_SEEDS[k].mi === mi);
    const TOG2_WANT = [
        ['k9unit', 'cycle'],
        ['giantlobsterscorpion', 'active'],
        ['deprivationtank', 'inout'],
    ];
    for (const [want, wantKind] of TOG2_WANT) {
        for (const b of M0.buildings) {
            const e = M0.binfo[b[0]];
            const sg = ((e && e[2]) || '').toLowerCase();
            if (sg !== want || b[5] || b[8]) continue;
            const rows = animMan.anims[sg];
            const gate = animMan.behavior && animMan.behavior[sg];
            const tg = gate && gate.toggle;
            if (!rows || !tg || (tg.kind || 'inout') !== wantKind) continue;
            const byName = {};
            for (const r of rows) byName[String(r.anim).toLowerCase()] = r;
            const need = [];
            if (wantKind === 'cycle') need.push(...(tg.poses || []));
            else if (wantKind === 'active') need.push(tg.loop);
            else { need.push(tg['in'], tg.out); if (tg.loop) need.push(tg.loop); }
            if (gate.idle) need.push(gate.idle);
            const strips = need.map(n => byName[String(n).toLowerCase()]);
            if (strips.some(x => !x || x.frames < 1)) continue;
            // every state's strip must read at rest zoom (the checks
            // assert blits, not gate rejections)
            if (strips.some(x => Math.min(x.cellw, x.cellh) < 80)) continue;
            if (tgClaim(M0.buildings.indexOf(b)) || !tgFar(b[6], b[7])) continue;
            const big = strips.reduce((m, x) => Math.max(m, x.cellw, x.cellh), 0);
            global.__ART_SEED.anims.anims[sg] = rows;
            global.__ART_SEED.anims.behavior[sg] = JSON.parse(JSON.stringify(gate));
            global.__ART_SEED.city.sprites[sg] =
                { png: 'animtog2.png', w: big, h: big, anchor: [big / 2, big / 2] };
            global.__ANIM_TOG2_SEEDS[wantKind] =
                { slug: sg, kind: wantKind, mi: M0.buildings.indexOf(b),
                  px: b[6], py: b[7], gate: gate, byName: byName };
            break;
        }
    }
    if (!global.__ANIM_TOG2_SEEDS.active) {           // synthetic active toggle
        for (const b of M0.buildings) {
            const e = M0.binfo[b[0]];
            const sg = ((e && e[2]) || '').toLowerCase();
            if (!sg || b[5] || b[8] || sg === slug || sg === bslug) continue;
            if (tgClaim(M0.buildings.indexOf(b))) continue;
            const rows = animMan.anims[sg];
            const gate = animMan.behavior && animMan.behavior[sg];
            if (!rows || (gate && (gate.toggle || gate.layers))) continue;
            const a = rows.reduce((m, x) => (x.frames > (m ? m.frames : 0) ? x : m), null);
            if (!a || a.frames < 5 || Math.min(a.cellw, a.cellh) < 80) continue;
            if (!tgFar(b[6], b[7])) continue;
            // other placed instances of the same slug gate identically (the
            // behavior map is per slug) and could contaminate a zero-assert
            // camera — require every instance to keep its distance
            let clash = false;
            for (const o of M0.buildings) {
                const oe = M0.binfo[o[0]];
                if (oe && String(oe[2] || '').toLowerCase() === sg &&
                        !o[5] && !tgFar(o[6], o[7], false)) clash = true;
            }
            if (clash) continue;
            const byName = {};
            for (const r of rows) byName[String(r.anim).toLowerCase()] = r;
            const fake = { idle: null, tap: null,
                           toggle: { kind: 'active', loop: a.anim } };
            global.__ART_SEED.anims.anims[sg] = rows;
            global.__ART_SEED.anims.behavior[sg] = fake;
            global.__ART_SEED.city.sprites[sg] =
                { png: 'animtog2.png', w: a.cellw, h: a.cellh, anchor: [a.ax, a.ay] };
            global.__ANIM_TOG2_SEEDS.active =
                { slug: sg, kind: 'active', mi: M0.buildings.indexOf(b),
                  px: b[6], py: b[7], gate: fake, byName: byName };
            break;
        }
    }
    global.__ANIM_MAN = animMan;                      // real manifest, for the
                                                      // generator gate checks
    if (!global.__ANIM_SEED && !global.__ANIM_BIG_SEED &&
        !global.__ANIM_GIANT_SEED && !global.__ANIM_TOG_SEED)
        global.__ART_SEED.anims = { anims: {} };   // no animated asset placed:
                                                   // keep the registry checks honest
    global.__ART_SLUG = slug;
})();
require(path.join(ROOT, 'js/city-view.js'));
flushRaf(); flushRaf();          // boot loop + first render

// ---- drive -----------------------------------------------------------------------
const tick = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(label, cond, extra) {
    if (cond) { console.log('  ok  ' + label); }
    else { failures++; console.log('  FAIL ' + label + (extra ? ' — ' + extra : '')); }
}
const CAM = global.CAM, M = global.MAP_DATA;
const VW = 1000, VH = 800;

// camera state the boot preset produced (pure replay of presetDowntown)
const cam = { x: 0, y: 0, zoom: 1, vx: 0, vy: 0 };
const DT = M.downtown[0];
CAM.fitTileRect(cam, { x0: DT[0], y0: DT[2], x1: DT[1], y1: DT[3] }, VW, VH);

// top-face centroid of a M.buildings row = guaranteed inside its screen block
function topCentroid(b) {
    const info = M.binfo[b[0]];
    const hgt = (info ? (info[7] || 3) : 3) * 0.5 * CAM.scale(cam);
    let x = 0, y = 0;
    for (const [cx, cy] of [[b[6], b[7] - b[4]], [b[6] + b[3], b[7] - b[4]],
                            [b[6] + b[3], b[7]], [b[6], b[7]]]) {
        const w = CAM.tileToWorld(cx, cy);
        const p = CAM.worldToScreen(cam, w.x, w.y, VW, VH);
        x += p.x; y += p.y - hgt;
    }
    return { x: x / 4, y: y / 4 };
}
const clickAt = (x, y) => named.stage.dispatch('click',
    { clientX: x, clientY: y, target: named.stage });
const clickBuilding = b => { const p = topCentroid(b); clickAt(p.x, p.y); flushRaf(); };
const hayOf = i => {
    const e = M.binfo[M.buildings[i][0]];
    return e ? (e[0] + ' ' + (e[1] || '') + ' ' + (e[2] || '')).toLowerCase() : '';
};

// --gl child: art mode on the boot camera with a fake GL renderer; pins the
// atlas shelf-packer contract (the bug this guards: aglCell never advanced
// agl.cx, so EVERY cell landed at the same atlas slot and every sprite
// billboard sampled the last image packed there).
async function glChecks() {
    console.log('GL sprite atlas (fake renderer, child run):');
    check('GL top pass took the boot frames (mode GL·bld)',
        global.__CV_DIAG.mode === 'GL·bld' && !!global.__TOP,
        'mode=' + global.__CV_DIAG.mode + ' block=' + global.__CV_DIAG.block);
    if (!named['btn-art'].classList.contains('on'))  // Art ships on (M4 item 4);
        named['btn-art'].dispatch('click', {});       // ensure sprites regardless
    await tick(250);                                   // manifests + stub images
    for (let i = 0; i < 60; i++) { flushRaf(); await tick(16); }
    const A = global.__AGL, TOP = global.__TOP;
    check('atlas page sized from maxTex', A.page === 4096, 'page=' + A.page);
    const cells = Object.values(A.map);
    check('packer packed several sprite cells', cells.length >= 4,
        'n=' + cells.length);
    const pos = new Set(cells.map(c =>
        c.u0.toFixed(6) + ',' + c.v0.toFixed(6)));
    check('shelf cursor advances: every cell owns its atlas slot',
        pos.size === cells.length,
        'cells=' + cells.length + ' slots=' + pos.size);
    check('cells sit inside the page with guard borders',
        cells.every(c => c.u0 > 0 && c.v0 > 0 && c.u1 < 1 && c.v1 < 1 &&
            c.u1 > c.u0 && c.v1 > c.v0));
    const q = TOP && TOP.quads, a = q && q.arr, nv = q ? q.n : 0;
    let spr = 0; const uvs = new Set();
    if (a) for (let v = 0; v + 6 <= nv; v += 6) {
        const u = a[v * 8 + 2];                        // first vertex's u
        if (u !== A.wuv[0]) { spr++; uvs.add(u.toFixed(6)); }
    }
    check('sprite quads sample several distinct cells (not one shared slot)',
        spr >= 8 && uvs.size >= 4,
        'spriteVerts=' + spr + ' distinctU=' + uvs.size);
}

(async () => {
    console.log('boot:');
    check('statsbar has the save counts',
        String(named.statsbar.innerHTML).replace(/,/g, '').indexOf('5261') >= 0,
        named.statsbar.innerHTML);
    check('zoom readout updated (render ran)',
        String(named.zoomread.textContent).indexOf('zoom') >= 0,
        named.zoomread.textContent);
    check('ground + object legend panels built',
        String(named.legend.innerHTML).indexOf('ground') >= 0 &&
        ['buildings', 'people', 'vehicles'].every(s =>
            String(named.objlegend.innerHTML).indexOf(s) >= 0));
    check('details pane starts on the placeholder',
        String(named.details.innerHTML).indexOf('Click a building') >= 0);

    // boot preset = SpringfieldDowns fit (pure replay of presetSpringfield)
    const sd = M.buildings.find(b => M.binfo[b[0]] && M.binfo[b[0]][0] === 'SpringfieldDowns');
    check('SpringfieldDowns instance in the save', !!sd);
    const sdcam = { x: 0, y: 0, zoom: 1, vx: 0, vy: 0 };
    CAM.fitTileRect(sdcam, { x0: sd[6] - 6, y0: sd[7] - sd[4] - 6,
        x1: sd[6] + sd[3] + 6, y1: sd[7] + 6 }, VW, VH);
    check('boot opens zoomed in on SpringfieldDowns',
        String(named.zoomread.textContent).indexOf('zoom ' + sdcam.zoom.toFixed(2)) === 0 &&
        named['btn-springfield'].classList.contains('on') &&
        !named['btn-downtown'].classList.contains('on'),
        named.zoomread.textContent + ' / ' + named['btn-springfield'].className);
    if (GLMODE) {
        await glChecks();
        console.log(failures ? '\n' + failures + ' GL FAILURES' : '\nGL CHECKS PASSED');
        process.exit(failures ? 1 : 0);
    }
    named['btn-downtown'].dispatch('click', {});     // frame downtown for the click tests
    flushRaf();

    // whole-town LOD: terrain + buildings must render through the tile-space
    // atlases (offscreen canvas blits), not per-tile paths
    const di0 = global.DRAWIMG;
    named['btn-full'].dispatch('click', {});
    flushRaf();                                      // lazy atlas build + blit frame
    check('whole-town LOD renders via atlas blits without errors',
        global.DRAWIMG > di0, 'drawImage=' + (global.DRAWIMG - di0));
    // WebGL base layer must self-deactivate headless (CityGL stubs the
    // context probe -> Canvas2D base path above is what really rendered)
    check('CityGL falls back cleanly without a real WebGL context',
        typeof CityGL === 'function' ||
        (typeof CityGL === 'object' && CityGL.create(named.glcv) === null));
    // frame diagnostics (statsbar perfread): the only telemetry that
    // distinguishes "GL took over" from "silent Canvas2D fallback"
    check('frame diagnostics live (statsbar perfread + __CV_DIAG)',
        String(named.statsbar.innerHTML).indexOf('perfread') > -1 &&
        !!global.__CV_DIAG &&
        ['2D', '2D·LOD', 'GL'].indexOf(global.__CV_DIAG.mode) > -1,
        'mode=' + (global.__CV_DIAG && global.__CV_DIAG.mode));
    // GL refusal must name itself: boot reason + live per-frame blocker
    check('GL boot failure names its reason (__CV_DIAG.glReason/block)',
        !!global.__CV_DIAG &&
        global.__CV_DIAG.glReason === 'no-WebGLRenderingContext' &&
        global.__CV_DIAG.block === 'no-WebGLRenderingContext',
        'glReason=' + (global.__CV_DIAG && global.__CV_DIAG.glReason) +
        ' block=' + (global.__CV_DIAG && global.__CV_DIAG.block));
    check('build version stamp (__CV_VER) for cache-staleness triage',
        global.__CV_VER === (global.__CV_DIAG && global.__CV_DIAG.ver) &&
        /^\d{4}-\d{2}-\d{2}/.test(String(global.__CV_VER)),
        'ver=' + global.__CV_VER);
    await tick(160);        // let the boot asset settles land (fetch + Image stubs)
    {
        let seasN = 0;
        for (const sp of Object.values(global.__ART_SEED.city.sprites))
            if (sp.seasons) seasN += Object.keys(sp.seasons).length;
        check('asset tracker counted the four boot assets (+ season variants)',
            !!global.__ASSETS && global.__ASSETS.bootDone === global.__ASSETS.boot &&
            global.__ASSETS.artKnown === Object.keys(global.__ART_SEED.city.sprites).length +
                Object.keys(global.__ART_SEED.chars.assets).length + seasN +
                global.__ASSETS.strips,
            'bootDone=' + (global.__ASSETS && global.__ASSETS.bootDone) +
            ' artKnown=' + (global.__ASSETS && global.__ASSETS.artKnown) +
            ' strips=' + (global.__ASSETS && global.__ASSETS.strips));
        /* the counter counts ART FILES, not HTTP hits: a filmstrip the LRU
           dropped and the view asked for again is the same file, so the sum
           of settled files must equal the number of distinct urls ever asked
           for — and it can never exceed what the manifests say exists */
        const seenN = Object.keys(global.__ASSETS.seen).length;
        check('art counters count files, not fetches (got + dead = distinct seen)',
            global.__ASSETS.artGot + global.__ASSETS.artDead === seenN,
            'got=' + global.__ASSETS.artGot + ' dead=' + global.__ASSETS.artDead +
            ' seen=' + seenN);
        check('the art readout can never outrun what is known (got <= known)',
            global.__ASSETS.artGot <= global.__ASSETS.artKnown,
            'got=' + global.__ASSETS.artGot + ' known=' + global.__ASSETS.artKnown);
    }
    check('asset pill stays visible with the art readout after boot (Art ships on)',
        !!global.__ASSETS && global.__ASSETS.pend === 0 &&
        !named.assets.classList.contains('off') &&
        String(named.assets.innerHTML).indexOf('art ') > -1,
        named.assets.innerHTML);
    named['btn-downtown'].dispatch('click', {});
    flushRaf();

    console.log('click to inspect:');
    const si = M.buildings.findIndex(b => M.binfo[b[0]] && M.binfo[b[0]][0] === 'SimpsonHome');
    check('SimpsonHome instance in the save', si >= 0);
    clickBuilding(M.buildings[si]);
    check('clicking a block shows its details card',
        ['SimpsonHome', 'SimpsonsHouse', 'asset', 'footprint', 'resolved via',
         'Selected', 'bucket'].every(s => String(named.details.innerHTML).indexOf(s) >= 0),
        String(named.details.innerHTML).slice(0, 140));
    check('selection draws outlines (ctx.stroke)', global.STROKES >= 3,
        'strokes=' + global.STROKES);
    const s0 = global.STROKES;
    clickAt(-1000, -1000);                          // open ground far out
    flushRaf();
    check('background click selects a grass tile',
        String(named.details.innerHTML).indexOf('grass tile') >= 0 &&
        String(named.details.innerHTML).indexOf('base lawn') >= 0 &&
        global.STROKES > s0, 'strokes=' + global.STROKES);
    const s1 = global.STROKES;
    clickAt(-1000, -1000);                          // same tile again
    flushRaf();
    check('clicking the same ground tile again deselects',
        String(named.details.innerHTML).indexOf('Click a building') >= 0 &&
        global.STROKES === s1, 'strokes=' + global.STROKES);
    clickBuilding(M.buildings[si]);
    fireWin('keydown', { key: 'Escape', preventDefault() {} });
    check('Esc deselects',
        String(named.details.innerHTML).indexOf('Click a building') >= 0);

    console.log('drag then click does not select:');
    clickBuilding(M.buildings[si]);
    check('select first works', String(named.details.innerHTML).indexOf('SimpsonHome') >= 0);
    named.stage.dispatch('pointerdown', { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    named.stage.dispatch('pointermove', { clientX: 200, clientY: 180 });
    named.stage.dispatch('pointerup', {});          // moved=true + fling armed
    fireWin('keydown', { key: 'Escape', preventDefault() {} });
    check('drag left the pane deselected',
        String(named.details.innerHTML).indexOf('Click a building') >= 0);
    clickBuilding(M.buildings[si]);                 // same spot, but moved=true
    check('click after a drag is ignored',
        String(named.details.innerHTML).indexOf('Click a building') >= 0);
    named.stage.dispatch('pointerdown', { button: 0, clientX: 5, clientY: 5, pointerId: 1 });
    named.stage.dispatch('pointerup', {});           // fresh press: no drag, kills fling
    named['btn-downtown'].dispatch('click', {});     // restore cam to the replayed preset
    clickBuilding(M.buildings[si]);
    check('clicks work again after a fresh press',
        String(named.details.innerHTML).indexOf('SimpsonHome') >= 0,
        String(named.details.innerHTML).slice(0, 140));
    fireWin('keydown', { key: 'Escape', preventDefault() {} });

    console.log('character dot picking:');
    // pick a named character whose dot position is unique among all dots
    const seen = {};
    M.chars.forEach((c, i) => { seen[c[1] + ',' + c[2]] = (seen[c[1] + ',' + c[2]] || 0) + 1; });
    const ci = M.chars.findIndex((c, i) =>
        M.charNames[c[0]] && seen[c[1] + ',' + c[2]] === 1);
    check('a uniquely-placed named character exists', ci >= 0);
    const c = M.chars[ci];
    const w = CAM.tileToWorld(c[1] + 0.5, c[2] + 0.5);
    const p = CAM.worldToScreen(cam, w.x, w.y, VW, VH);
    clickAt(p.x, p.y);
    flushRaf();
    check('clicking a dot shows the character card',
        String(named.details.innerHTML).indexOf(M.charNames[c[0]]) >= 0 &&
        String(named.details.innerHTML).indexOf('character') >= 0,
        String(named.details.innerHTML).slice(0, 140));
    fireWin('keydown', { key: 'Escape', preventDefault() {} });

    console.log('terrain tiles:');
    const T2 = new CityTerrain(M);                  // fresh instance for the API pins
    const TO = CityTerrain.TYPE_ORDER;
    const roadIdx = TO.indexOf('road');
    const rf = T2.features.find(f => f[2] === roadIdx);
    check('typesAt reports layer coverage for a tile',
        !!rf && T2.typesAt(rf[0], rf[1]).indexOf(roadIdx) >= 0);
    check('topTypeAt = top drawn layer while all are visible',
        !!rf && T2.topTypeAt(rf[0], rf[1]) ===
            TO[T2.typesAt(rf[0], rf[1]).slice(-1)[0]]);
    let grassOk = false;
    for (let x = 300; x < 330 && !grassOk; x++)
        for (let y = 700; y < 730 && !grassOk; y++)
            if (!T2.typesAt(x, y).length) grassOk = T2.topTypeAt(x, y) === 'grass';
    check('uncovered tile: typesAt empty -> topTypeAt grass', grassOk);
    T2.setVisible('road', false);
    check('hidden layer falls through to what is beneath',
        !!rf && T2.topTypeAt(rf[0], rf[1]) !== 'road');
    T2.setVisible('road', true);

    console.log('ocean brush layers (boardwalk / pier):');
    const bwIdx = TO.indexOf('boardwalk'), prIdx = TO.indexOf('pier');
    check('TYPE_ORDER carries the two brush layers', bwIdx === 7 && prIdx === 8);
    check('legend carries boardwalk + pier rows',
        String(named.legend.innerHTML).indexOf('boardwalk') >= 0 &&
        String(named.legend.innerHTML).indexOf('pier') >= 0,
        String(named.legend.innerHTML).slice(0, 120));
    const bwf = T2.features.filter(f => f[2] === bwIdx);
    const prf = T2.features.filter(f => f[2] === prIdx);
    /* oceanData re-decoded 2026-10-28 (notes/09 §12): 262 brush cells x 16
       tiles; pier = the 19-cell walkway under OrnatePier, the rest boardwalk */
    const sq = M.buildings.find(b => M.binfo[b[0]] && M.binfo[b[0]][0] === 'SquidportEntrance');
    check('boardwalk layer = the Squidport deck + docks (243 cells)',
        bwf.length === 243 * 16 && !!sq &&
        bwf.some(f => f[0] === sq[1] + (sq[3] >> 1) && f[1] === sq[2] + (sq[4] >> 1)),
        bwf.length + ' tiles');
    const prL = M.layers.find(l => l.n === 'pier');
    const prWant = [];
    for (let i = 0; prL && i < prL.pts.length; i += 2)
        prWant.push((prL.pts[i] - M.ox) + ',' + (prL.pts[i + 1] - M.oy));
    check('pier layer = the OrnatePier walkway (19 cells)',
        !!prL && prf.length === 19 * 16 && prWant.length === prf.length &&
        prf.map(f => f[0] + ',' + f[1]).sort().join(' ') === prWant.sort().join(' '),
        prf.length + ' tiles');
    check('brush tile draws on top of the ocean marks',
        prf.length && T2.topTypeAt(prf[0][0], prf[0][1]) === 'pier');
    {   // click a pier tile no building/character covers -> details card
        const free = (tx, ty) =>
            !M.chars.some(ch => Math.abs(ch[1] - tx) < 3 && Math.abs(ch[2] - ty) < 3) &&
            !M.buildings.some(b => tx >= b[1] - 2 && tx < b[1] + b[3] + 2 &&
                                   ty >= b[2] - 2 && ty < b[2] + b[4] + 6);
        const f = prf.find(g => free(g[0], g[1])) || prf[0];
        const wc = CAM.tileToWorld(f[0] + 0.5, f[1] + 0.5);
        const pc = CAM.worldToScreen(cam, wc.x, wc.y, VW, VH);
        clickAt(pc.x, pc.y);
        flushRaf();
        check('clicking a pier tile shows its terrain card',
            ['pier tile', 'recovered brush tiles'].every(
                s => String(named.details.innerHTML).indexOf(s) >= 0),
            String(named.details.innerHTML).slice(0, 140));
        fireWin('keydown', { key: 'Escape', preventDefault() {} });
    }
    T2.setVisible('pier', false);
    check('pier hides via the legend toggle',
        prf.length && T2.topTypeAt(prf[0][0], prf[0][1]) !== 'pier');
    T2.setVisible('pier', true);

    // click a road tile that no block/people could steal the click from
    const covered = (tx, ty) =>
        M.chars.some(ch => ch[1] === tx && ch[2] === ty) ||
        M.buildings.some(b => tx >= b[1] - 2 && tx < b[1] + b[3] + 2 &&
                              ty >= b[2] - 2 && ty < b[2] + b[4] + 6);
    const roadCands = T2.features
        .filter(f => f[2] === roadIdx && !covered(f[0], f[1])).slice(0, 40);
    let hitTile = null;
    for (const f of roadCands) {
        const wc = CAM.tileToWorld(f[0] + 0.5, f[1] + 0.5);
        const pc = CAM.worldToScreen(cam, wc.x, wc.y, VW, VH);
        clickAt(pc.x, pc.y);
        flushRaf();
        if (String(named.details.innerHTML).indexOf('road tile') >= 0) { hitTile = f; break; }
    }
    check('clicking a road tile shows its terrain card', !!hitTile,
        String(named.details.innerHTML).slice(0, 140));
    if (hitTile) {
        const dh = () => String(named.details.innerHTML);
        check('terrain card has town + grid coords and layer size',
            dh().indexOf('town tile') >= 0 &&
            dh().indexOf(hitTile[0] + ', ' + hitTile[1]) >= 0 &&
            dh().indexOf((hitTile[0] + M.ox) + ', ' + (hitTile[1] + M.oy)) >= 0 &&
            dh().indexOf('tiles in layer') >= 0,
            dh().slice(0, 160));
        const s2 = global.STROKES;
        clickAt(...(() => { const wc = CAM.tileToWorld(hitTile[0] + 0.5, hitTile[1] + 0.5);
                            const pc = CAM.worldToScreen(cam, wc.x, wc.y, VW, VH);
                            return [pc.x, pc.y]; })());   // same tile again
        flushRaf();
        check('clicking the same tile again deselects',
            String(named.details.innerHTML).indexOf('Click a building') >= 0 &&
            global.STROKES === s2, 'strokes=' + global.STROKES);
    }

    console.log('search:');
    const q = 'spookywall';
    const nB = M.buildings.reduce((n, b, i) =>
        n + (String(b[0]) === q || hayOf(i).includes(q) ? 1 : 0), 0);
    const nC = M.chars.filter(c =>
        String(c[0]) === q || (M.charNames[c[0]] || '').toLowerCase().includes(q)).length;
    check('save contains spookywall instances', nB > 0, nB);
    named.search.value = q;
    named.search.dispatch('input', {});
    await tick(160);
    check('match count shown',
        String(named.matchinfo.textContent).indexOf((nB + nC) + ' match') === 0,
        named.matchinfo.textContent);
    const first = M.buildings.findIndex((b, i) => String(b[0]) === q || hayOf(i).includes(q));
    named.search.dispatch('keydown',
        { key: 'Enter', preventDefault() {}, stopPropagation() {} });
    check('Enter selects + details show the first match',
        String(named.details.innerHTML).indexOf(M.binfo[M.buildings[first][0]][0]) >= 0,
        String(named.details.innerHTML).slice(0, 140));
    const resHtml = () => String(named.results.innerHTML);
    const firstId = M.buildings[first][0];
    const firstName = M.binfo[firstId][0];
    check('right pane lists grouped results',
        resHtml().indexOf('click to select') >= 0 &&
        resHtml().indexOf(firstName) >= 0 &&
        resHtml().indexOf('data-id="' + firstId + '"') >= 0,
        resHtml().slice(0, 140));
    fireWin('keydown', { key: 'Escape', preventDefault() {} });   // deselect first
    check('deselected before the result-click check',
        String(named.details.innerHTML).indexOf('Click a building') >= 0);
    const rbtn = new FakeEl('button');
    rbtn.className = 'res';
    rbtn.attrs['data-kind'] = 'b';
    rbtn.attrs['data-id'] = String(firstId);
    named.results.dispatch('click', { target: rbtn });
    check('clicking a result row selects it (details card returns)',
        String(named.details.innerHTML).indexOf(firstName) >= 0,
        String(named.details.innerHTML).slice(0, 140));
    named.search.value = 'a';                                     // >RESULT_CAP groups
    named.search.dispatch('input', {});
    await tick(160);
    check('oversized result sets cap with a refine hint',
        resHtml().indexOf('refine the search') >= 0 &&
        resHtml().indexOf('class="res"') >= 0, resHtml().slice(-90));
    named.search.value = 'homer';
    named.search.dispatch('input', {});
    await tick(160);
    check('character-name search reports matches',
        /[1-9]\d* match/.test(String(named.matchinfo.textContent)),
        named.matchinfo.textContent);
    named.search.value = 'zzznosuchthing';
    named.search.dispatch('input', {});
    await tick(160);
    check('no-match search reports zero',
        String(named.matchinfo.textContent).indexOf('0 matches') === 0,
        named.matchinfo.textContent);
    named.search.dispatch('keydown',
        { key: 'Escape', preventDefault() {}, stopPropagation() {} });
    check('Esc in the search box clears it + empties the result list',
        named.search.value === '' && named.matchinfo.textContent === '' &&
        named.results.innerHTML === '');

    console.log('reset button clears selection + search:');
    named.search.value = q;
    named.search.dispatch('input', {});
    await tick(160);
    named['btn-reset'].dispatch('click', {});
    check('reset restores placeholder + clears matches',
        String(named.details.innerHTML).indexOf('Click a building') >= 0 &&
        named.matchinfo.textContent === '');

    console.log('candidate-street verdict panel (M4, 2026-10-18):');
    const propHtml = String(named.proplegend.innerHTML);
    check('prop-streets panel built from the built-in PROPOSED seeds (offline)',
        propHtml.indexOf('candidate streets') >= 0 &&
        propHtml.indexOf('x 126\u2013127') >= 0 &&
        propHtml.indexOf('x 118\u2013119') >= 0 &&
        propHtml.indexOf('\u00b7 local') > 0 &&
        propHtml.indexOf('24 pending') >= 0,
        propHtml.slice(0, 160));
    check('every row carries the \u2316 go-to affordance + east seeds present',
        propHtml.indexOf('\u2316') >= 0 &&
        propHtml.indexOf('x 498\u2013499') >= 0 &&
        propHtml.indexOf('x 318\u2013319') >= 0,
        'go buttons / east arm rows');
    check('proplegend starts hidden (overlay behind the Prop streets button)',
        named.proplegend.style.display === 'none',
        String(named.proplegend.style.display));
    named['btn-proposed'].dispatch('click', {});
    check('Prop streets button shows the panel + marks itself on',
        named['btn-proposed'].classList.contains('on') &&
        named.proplegend.style.display === '',
        named['btn-proposed'].className + ' / ' + named.proplegend.style.display);

    console.log('sprite art toggle (M4 items 4/5):');
    check('art button ships on (sprites are the default view, M4 item 4)',
        named['btn-art'].textContent === 'Art\u00b7sprites' &&
        named['btn-art'].classList.contains('on'),
        named['btn-art'].textContent);
    const d0 = global.DRAWIMG;
    named['btn-art'].dispatch('click', {});
    check('art button toggles off (blocks/dots)',
        named['btn-art'].textContent === 'Art\u00b7blocks' &&
        !named['btn-art'].classList.contains('on'),
        named['btn-art'].textContent);
    named['btn-art'].dispatch('click', {});
    check('art button toggles back on',
        named['btn-art'].textContent === 'Art\u00b7sprites' &&
        named['btn-art'].classList.contains('on'),
        named['btn-art'].textContent);
    await tick(30);                                     // fetch + Image onload
    flushRaf();
    check('zoomed-out Art frames (all sprites under the 12px gate) are GL-eligible',
        global.__CV_DIAG.block !== 'art',
        'block=' + global.__CV_DIAG.block);
    for (var wI = 0; wI < 2; wI++)                       // zoom in until the art
        named.stage.dispatch('wheel', { deltaY: -300,   // passes the 12px sprite
            clientX: 500, clientY: 400,                 // LOD gate (blocks below)
            preventDefault: function () {} });
    flushRaf(); flushRaf();
    check('sprite mode renders billboards (drawImage) without errors',
        global.DRAWIMG > d0, 'drawImage=' + (global.DRAWIMG - d0));
    check('mid-band Art frames no longer refuse the GL building pass',
        global.__CV_DIAG.mode === '2D' && global.__CV_DIAG.block !== 'art',
        'mode=' + global.__CV_DIAG.mode + ' block=' + global.__CV_DIAG.block);
    check('asset pill shows the art stream readout while Art mode is on',
        !named.assets.classList.contains('off') &&
        String(named.assets.innerHTML).indexOf('art ') > -1,
        named.assets.innerHTML);
    named['btn-rest'].dispatch('click', {});           // s = 64: giant seed is
    flushRaf();                                         // painted 4000+ px wide
    check('deep-zoom Art frames keep the sharp 2D sprite path',
        global.__CV_DIAG.block === 'art' && global.__CV_DIAG.artBlock === 'big',
        'block=' + global.__CV_DIAG.block + ' artBlock=' + global.__CV_DIAG.artBlock);
    named['btn-downtown'].dispatch('click', {});        // restore for later checks
    flushRaf();
    named['btn-art'].dispatch('click', {});
    check('art button toggles back to blocks',
        named['btn-art'].textContent === 'Art\u00b7blocks' &&
        !named['btn-art'].classList.contains('on'),
        named['btn-art'].textContent);
    await tick(160);                            // in-flight seed PNGs land
                                                // (+ throttled trailing paint)
    check('asset pill hides again after Art mode off and queue drains',
        named.assets.classList.contains('off'),
        named.assets.innerHTML);
    flushRaf();

    console.log('season mode toggle (2026-10-25):');
    check('season button ships on base; cycle list built from the manifest',
        named['btn-season'].textContent === 'Season\u00b7base' &&
        !named['btn-season'].classList.contains('on') &&
        global.__CV_SEASON.present.winter === 1,
        named['btn-season'].textContent + ' / ' +
        JSON.stringify(global.__CV_SEASON.present));
    named['btn-art'].dispatch('click', {});      // sprites on: season PNGs draw
    flushRaf();
    const ag0 = global.__ASSETS.artGot;
    named['btn-season'].dispatch('click', {});
    check('click cycles base -> winter (label, on-class, persistence)',
        global.__CV_SEASON.mode === 'winter' &&
        named['btn-season'].textContent === 'Season\u00b7Winter' &&
        named['btn-season'].classList.contains('on') &&
        global.__LSTORE['mrsnrub.cityview.season'] === 'winter',
        named['btn-season'].textContent + ' / ' +
        global.__LSTORE['mrsnrub.cityview.season']);
    flushRaf(); await tick(30); flushRaf();
    check('the winter variant PNG streams through the art loader',
        global.__ASSETS.artGot > ag0, 'artGot+=' + (global.__ASSETS.artGot - ag0));
    named['btn-season'].dispatch('click', {});
    check('cycles back to base + persists',
        global.__CV_SEASON.mode === 'base' &&
        named['btn-season'].textContent === 'Season\u00b7base' &&
        !named['btn-season'].classList.contains('on') &&
        global.__LSTORE['mrsnrub.cityview.season'] === 'base',
        named['btn-season'].textContent);
    named['btn-art'].dispatch('click', {});      // back to blocks for the anim section
    await tick(160);
    flushRaf();

    console.log('in-place bsv3 filmstrips on the map (M4 .20):');
    const AS = global.__ANIM_SEED;
    check('a save-placed asset has a bsv3 filmstrip to animate',
        !!AS && !!AS.entry && AS.entry.frames > 1, JSON.stringify(AS && AS.slug));
    await tick(30);                                 // the anims fetch settles
    check('city-anims manifest populates the map animation registry',
        !!(AS && global.__CV_ANIM && global.__CV_ANIM[AS.slug]),
        'registry=' + (global.__CV_ANIM && Object.keys(global.__CV_ANIM).length));
    const fiSeq = [];
    for (let t = 0; t <= 3000; t += 91)
        fiSeq.push(global.__CV_ANIM_FI(AS.slug, { px: AS.px, py: AS.py }, t));
    check('frame probe: stable per instance, advances with the clock',
        new Set(fiSeq).size > 1 &&
        global.__CV_ANIM_FI(AS.slug, { px: AS.px, py: AS.py }, 1000) ===
        global.__CV_ANIM_FI(AS.slug, { px: AS.px, py: AS.py }, 1000),
        'distinct=' + new Set(fiSeq).size);
    named['btn-art'].dispatch('click', {});          // Art on: sprites draw
    const wc = global.CAM.tileToWorld(AS.px, AS.py); // centre the animation
    global.__CV_cam.x = wc.x; global.__CV_cam.y = wc.y;
    global.__CV_cam.zoom = global.CAM.ZOOM.rest;
    await tick(30);
    flushRaf(); flushRaf();
    check('the animated building blits filmstrip cells instead of the PNG',
        global.__CV_DIAG.anims > 0, 'anims=' + global.__CV_DIAG.anims);
    const dA = global.DRAWIMG;
    await tick(120);
    flushRaf(); flushRaf();                           // repaint scheduled by the loop
    check('the filmstrip keeps repainting on its own (dirty-driven clock)',
        global.DRAWIMG > dA && global.__CV_DIAG.anims > 0,
        'drawImage=' + (global.DRAWIMG - dA) + ' anims=' + global.__CV_DIAG.anims);
    /* the user-reported stall: overview zoom (0.33, k≈0.34) must park
       small-cell loops under the readability floor — static PNGs, no
       repaint clock — and they must return at rest zoom */
    named['btn-rest'].dispatch('click', {});
    global.__CV_cam.x = wc.x; global.__CV_cam.y = wc.y;
    global.__CV_cam.zoom = 0.33;
    flushRaf(); flushRaf();
    check('overview zoom parks filmstrips under the readability floor',
        global.__CV_DIAG.anims === 0, 'anims=' + global.__CV_DIAG.anims);
    named['btn-rest'].dispatch('click', {});          // zoom back to rest
    global.__CV_cam.x = wc.x; global.__CV_cam.y = wc.y;
    flushRaf(); flushRaf();
    check('at rest zoom the loops replay', global.__CV_DIAG.anims > 0,
        'anims=' + global.__CV_DIAG.anims);
    /* character idle loops (2026-10-23): the seeded 3-frame char must
       animate, and its loop alone must keep the repaint clock alive */
    {
        const ch = global.MAP_DATA.chars.find(
            c => String(c[0]) === String(global.__SEED_CID));
        const cw = global.CAM.tileToWorld(ch[1] + 0.5, ch[2] + 0.5);
        global.__CV_cam.x = cw.x; global.__CV_cam.y = cw.y;
        global.__CV_cam.zoom = global.CAM.ZOOM.rest;
        flushRaf(); flushRaf();           // drain the old-camera frame
        await tick(120);                  // past animNextT: the loop repaints
        flushRaf(); flushRaf();           // on its own at the new camera
        check('the seeded character sits on an idle loop (charAnims)',
            global.__CV_DIAG.charAnims > 0,
            'charAnims=' + global.__CV_DIAG.charAnims);
        const dC = global.DRAWIMG;
        await tick(120);
        flushRaf(); flushRaf();
        check('the character loop keeps repainting on its own (dirty clock)',
            global.DRAWIMG > dC && global.__CV_DIAG.charAnims > 0,
            'drawImage=' + (global.DRAWIMG - dC) +
            ' charAnims=' + global.__CV_DIAG.charAnims);
    }
    /* viewport gate: the same building far past the viewport edge must not
       animate (and so must not keep the scene repainting) */
    named['btn-rest'].dispatch('click', {});
    global.__CV_cam.x = wc.x + 60000; global.__CV_cam.y = wc.y + 60000;
    flushRaf(); flushRaf();
    check('sprites outside the viewport do not animate',
        global.__CV_DIAG.anims === 0, 'anims=' + global.__CV_DIAG.anims);
    named['btn-rest'].dispatch('click', {});
    global.__CV_cam.x = wc.x; global.__CV_cam.y = wc.y;
    flushRaf(); flushRaf();
    check('back in view the filmstrips resume', global.__CV_DIAG.anims > 0,
        'anims=' + global.__CV_DIAG.anims);
    const cap0 = global.__CV_ANIM_max();            // blit cap A/B knob
    global.__CV_ANIM_max(0);
    named['btn-rest'].dispatch('click', {});
    global.__CV_cam.x = wc.x; global.__CV_cam.y = wc.y;
    flushRaf(); flushRaf();
    check('the per-frame blit cap falls back to static PNGs at 0',
        global.__CV_DIAG.anims === 0, 'anims=' + global.__CV_DIAG.anims);
    global.__CV_ANIM_max(cap0);
    named['btn-rest'].dispatch('click', {});
    global.__CV_cam.x = wc.x; global.__CV_cam.y = wc.y;
    flushRaf(); flushRaf();
    check('raising the cap again replays the loops', global.__CV_DIAG.anims > 0,
        'anims=' + global.__CV_DIAG.anims);
    /* behaviour-gate click-to-play (.27): the seed's SECOND strip is
       registered as the BuildingTouched tap anim — the idle loop keeps
       playing, firing the tap plays the one-shot, then the building
       reverts to the idle (engine ActiveNoLoop semantics) */
    /* a strip's one-shot plays one loop of the ENGINE's ticks, not of its
       atlas cells: generation drops runs of identical frames and samples long
       loops, and records the mapping (rp/lt) so the player keeps the game's
       timing. Any wait for a one-shot to run out must use the tick count. */
    const tickN = a => (a && (a.lt || a.lf || a.frames)) || 0;
    const TR = AS && AS.rows && AS.rows.length > 1 && AS.rows[1].frames > 1
        ? AS.rows[1] : null;
    if (TR) {
        check('the seed asset registers its behaviour tap filmstrip',
            global.__ART_SEED.anims.behavior[AS.slug].tap === TR.anim,
            JSON.stringify(global.__ART_SEED.anims.behavior[AS.slug]));
        const f0 = global.__CV_TAP(AS.mi, true);
        check('firing the tap starts the one-shot at its first frame',
            f0 >= 0 && f0 < tickN(TR), 'fi=' + f0);
        flushRaf(); flushRaf();
        check('the tapped building keeps blitting (budget-exempt)',
            global.__CV_DIAG.anims > 0, 'anims=' + global.__CV_DIAG.anims);
        await tick(tickN(TR) * (1000 / TR.fps) + 250);   // let it run out
        flushRaf(); flushRaf();
        check('the tap anim reverts to the idle loop once it finishes',
            global.__CV_TAP(AS.mi, false) === -1);
        check('the idle loop still plays afterwards',
            global.__CV_DIAG.anims > 0, 'anims=' + global.__CV_DIAG.anims);
        /* lot-coverage tap rule: the prism hit-test only claims the drawn
           faces, but the real game lets you touch a building anywhere on
           its lot — a ground click on any tile under it must tap it too */
        const cx = Math.floor(AS.px + AS.fw / 2),
              cy = Math.floor(AS.py - AS.fh / 2);
        const lotFi = global.__CV_TAP_at(cx, cy, true);
        check('a tile under the building is its touch target (lot rule)',
            lotFi >= 0, 'fi=' + lotFi);
        const cp = global.__CV_TILE_screen(AS.px + AS.fw / 2, AS.py - AS.fh / 2);
        clickAt(cp.x, cp.y);
        check('a canvas click on the building lot fires its tap anim',
            global.__CV_TAP(AS.mi, false) >= 0,
            'fi=' + global.__CV_TAP(AS.mi, false));
    } else {
        console.log('  tap-anim checks skipped: seed asset has no second strip');
    }
    /* decode-cap tiering (shark-tank regression): a 6–16 Mpx filmstrip must
       animate on the map — the first 6 Mpx blanket cap froze it there while
       the sidebar card played it; a > 16 Mpx one must stay static. */
    const AB = global.__ANIM_BIG_SEED;
    check('a shark-tank-class (6–16 Mpx) filmstrip is seeded from the save',
        !!AB, AB && AB.slug);
    if (AB) {
        const wb = global.CAM.tileToWorld(AB.px, AB.py);
        named['btn-rest'].dispatch('click', {});
        global.__CV_cam.x = wb.x; global.__CV_cam.y = wb.y;
        global.__CV_cam.zoom = global.CAM.ZOOM.rest;
        await tick(30);                                // the big decode lands
        flushRaf(); flushRaf();
        check('the big filmstrip plays on the map under the raised cap',
            global.__CV_DIAG.anims > 0, 'anims=' + global.__CV_DIAG.anims);
        const st = global.__CV_ANIM_stats();
        check('the big-atlas session budget registers it',
            st.big >= 1 && st.lru >= 1, JSON.stringify(st));
    }
    /* eviction-thrash regression (the pill that never settled): with ONE
       cache slot and two big strips in view, the visible one must keep its
       slot — the old LRU evicted its head (a strip on screen) and re-decoded
       it every frame, forever, counting each re-decode as new art. */
    const RV = global.__ANIM_RIVAL_SEED;
    if (AB && RV) {
        const wb = global.CAM.tileToWorld(AB.px, AB.py);
        const cap0 = global.__CV_ANIM_cache();
        const big0 = global.__CV_ANIM_bigmax();
        named['btn-rest'].dispatch('click', {});
        global.__CV_cam.x = wb.x; global.__CV_cam.y = wb.y;
        global.__CV_cam.zoom = global.CAM.ZOOM.rest;
        for (const tierTest of [
            { name: 'one-slot cache', cache: 1, big: 2 },      // the LRU bound
            { name: 'one-slot big tier', cache: 8, big: 1 } ]) // the tier budget
        {
            global.__CV_ANIM_cache(tierTest.cache);   // two strips want in
            global.__CV_ANIM_bigmax(tierTest.big);
            global.__CV_ANIM_clear();                 // arrivals are what we watch
            await tick(30); flushRaf(); flushRaf();
            const s0 = global.__CV_ANIM_stats();
            await tick(400);                          // ~4 anim ticks, no panning
            for (let i = 0; i < 5; i++) flushRaf();
            const s1 = global.__CV_ANIM_stats();
            check('a ' + tierTest.name + ' shows one big strip and refuses the other',
                global.__CV_DIAG.anims > 0 && s1.lru <= s1.lruMax &&
                s0.wanted >= 2 && s0.refused >= 1 && s1.lru <= tierTest.cache,
                JSON.stringify(s0) + ' -> ' + JSON.stringify(s1));
            check('the visible strip is never evicted under ' + tierTest.name +
                ': no drops, no re-decodes',
                s1.drops === s0.drops && s1.reloads === s0.reloads &&
                s1.big <= s1.bigMax,
                JSON.stringify(s0) + ' -> ' + JSON.stringify(s1));
        }
        check('the refused arrival draws static while the resident one moves',
            global.DRAWIMG > 0 && global.__CV_DIAG.anims > 0,
            'anims=' + global.__CV_DIAG.anims);
        global.__CV_ANIM_cache(cap0);
        global.__CV_ANIM_bigmax(big0);
        await tick(60); flushRaf();           // let the caps re-admit them
    } else {
        console.log('  cache-thrash checks skipped: no rival big seed');
    }
    const AG = global.__ANIM_GIANT_SEED;
    if (AG) {
        const wg = global.CAM.tileToWorld(AG.px, AG.py);
        named['btn-rest'].dispatch('click', {});
        global.__CV_cam.x = wg.x; global.__CV_cam.y = wg.y;
        flushRaf(); flushRaf();
        check('a > 16 Mpx filmstrip stays static on the map',
            global.__CV_DIAG.anims === 0, 'anims=' + global.__CV_DIAG.anims);
    }
    /* layered asset (escalator fix): no controller loop — the engine's
       <AnimationLayerOrder> part loops blit over the static body. The body
       must stay drawn, every in-gate layer must blit its current cell, and
       an over-cap layer must not veto the others */
    const AL = global.__ANIM_LAY_SEED;
    check('a layered (no controller loop) asset is seeded from the save',
        !!AL, AL && AL.slug);
    if (AL) {
        const wl = global.CAM.tileToWorld(AL.px, AL.py);
        named['btn-rest'].dispatch('click', {});
        global.__CV_cam.x = wl.x; global.__CV_cam.y = wl.y;
        await tick(30);                                // the layer decodes land
        flushRaf(); flushRaf();
        check('the layered record keeps the body and registers every part loop',
            JSON.stringify(global.__CV_ANIM_layers(AL.slug)) ===
            JSON.stringify({ n: AL.reg.length, base: 1, anims: AL.reg }),
            JSON.stringify(global.__CV_ANIM_layers(AL.slug)) +
            ' want=' + JSON.stringify({ n: AL.reg.length, base: 1,
                                        anims: AL.reg }));
        check('the layered asset blits cells over its static body',
            global.__CV_DIAG.anims > 0, 'anims=' + global.__CV_DIAG.anims);
        const dl = global.DRAWIMG;
        await tick(120);
        flushRaf(); flushRaf();
        check('the part loops keep repainting on their own',
            global.DRAWIMG > dl && global.__CV_DIAG.anims > 0,
            'drawImage=' + (global.DRAWIMG - dl) +
            ' anims=' + global.__CV_DIAG.anims);
        /* every part plays the ENGINE's tick, not its own cell count: the
           generator records rp (each cell's tick in the loop) + lt (the loop's
           tick count), and a strip that ignores them wraps on its frames — the
           GreenpeaceBoat bug, where a 10-cell hull and an 8-cell superstructure
           bobbed at different rates. Walk one loop of the clock and require the
           cell shown at tick t to be the newest cell whose recorded tick is
           still at or before it, advancing monotonically round the loop. */
        const rowsL = (require(path.join(ROOT, 'assets/city/city-anims.json'))
                       .anims[AL.slug] || []);
        /* no ground pin: __CV_ANIM_cell adds a per-instance phase from it, and
           the point here is the cell the CLOCK picks, so walk it from tick 0 */
        const ph = { px: 0, py: 0 };
        let tracks = true, why = '';
        for (let i = 0; i < AL.reg.length && tracks; i++) {
            const a = rowsL.find(x => x.anim === AL.reg[i]);
            if (!a || !a.rp || !a.lt) continue;         // identity: cells ARE
            const f = a.fps || 12;                      // the engine's ticks
            let prevT = -1;
            for (let t = 0; t < a.lt; t++) {
                const k = global.__CV_ANIM_cell(AL.slug, ph, i, t * 1000 / f);
                const want = a.rp.reduce((m, v, j) => (v <= t % a.lt && v > m.v
                                                       ? { v: v, j: j } : m),
                                         { v: -1, j: a.rp.length - 1 }).j;
                if (k !== want) {
                    tracks = false;
                    why = AL.reg[i] + ' tick ' + t + ' shows cell ' + k +
                          ' (tick ' + a.rp[k] + '), want cell ' + want +
                          ' (tick ' + a.rp[want] + ')';
                    break;
                }
                if (a.rp[k] < prevT) {
                    tracks = false;
                    why = AL.reg[i] + ' rewound at tick ' + t +
                          ' (cell ' + k + ' = tick ' + a.rp[k] + ' < ' +
                          prevT + '): wrapped on its ' + a.frames + ' cells';
                    break;
                }
                prevT = a.rp[k];
            }
        }
        check('each part loop follows the recorded engine tick (rp/lt), not its ' +
              'own cell count', tracks, why);
    }
    /* the clock lives in BOTH page scripts (this deprecated one and the Pixi
       viewer, which is the source of truth) — a fix applied to only one of
       them is how the two pages drift apart. Pin the four clock helpers to the
       same text and require both blit paths to use them. */
    (() => {
        const fs = require('fs');
        const src = {
            legacy: fs.readFileSync(path.join(ROOT, 'js/city-view.js'), 'utf8'),
            pixi: fs.readFileSync(path.join(ROOT, 'viewer/city-view-pixi.js'),
                                   'utf8')
        };
        const fn = (text, name) => {
            const at = text.indexOf('function ' + name + '(');
            if (at < 0) return null;
            const end = text.indexOf('\n    }', at);
            return end < 0 ? null : text.slice(at, end).replace(/\/\/.*$/gm, '')
                .replace(/\s+/g, ' ').trim();
        };
        const names = ['tickCount', 'tickCell', 'cellAt', 'animIdx'];
        let same = true, why = '';
        for (const n of names) {
            const l = fn(src.legacy, n), p = fn(src.pixi, n);
            if (!l || !p) { same = false; why = n + ' missing (' +
                (!l ? 'legacy ' : '') + (!p ? 'pixi' : '') + ')'; break; }
            if (l !== p) { same = false; why = n + ' differs:\n    legacy: ' +
                l + '\n    pixi:   ' + p; break; }
        }
        check('the Pixi viewer and the legacy page share one clock (rp/lt) ' +
              'implementation', same, why);
        const wrapped = Object.keys(src).filter(k =>
            /animNow \* a\.fps \/ 1000\) \+ ph\) % a\.frames/.test(src[k]));
        check('no idle blit path wraps a strip on its own cell count',
            wrapped.length === 0, wrapped.join(','));
    })();
    /* engine-builtin toggle class (the helicopter): sits static at Neutral
       until clicked; the first click plays the Active_In one-shot and the
       building then loops Active (oversize atlases included — the click
       path is exempt from the 16 Mpx map cap); the next click plays
       Active_Out and it goes static again. Re-clicks while a one-shot is
       playing are ignored, like the engine's ActiveIn/ActiveOut guard. */
    const AT = global.__ANIM_TOG_SEED;
    check('a save-placed engine-toggle asset is seeded from the save',
        !!AT, AT && AT.slug);
    if (AT) console.log('  (toggle seed: ' + AT.slug + ')');
    if (AT) {
        const wt = global.CAM.tileToWorld(AT.px, AT.py);
        named['btn-rest'].dispatch('click', {});
        global.__CV_cam.x = wt.x; global.__CV_cam.y = wt.y;
        global.__CV_cam.zoom = global.CAM.ZOOM.rest;
        await tick(30); flushRaf(); flushRaf();
        check('the toggle asset sits static until clicked',
            global.__CV_DIAG.anims === 0 && global.__CV_TOG(AT.mi) === 'neutral',
            'anims=' + global.__CV_DIAG.anims + ' state=' + global.__CV_TOG(AT.mi));
        const fIn = global.__CV_TAP(AT.mi, true);
        check('the first click starts the Active_In one-shot',
            fIn >= 0 && global.__CV_TOG(AT.mi) === 'play', 'fi=' + fIn);
        await tick(30);                                // the oversize decode lands
        flushRaf(); flushRaf();
        check('the oversize one-shot blits (budget-exempt)',
            global.__CV_DIAG.anims > 0, 'anims=' + global.__CV_DIAG.anims);
        check('a re-click while the one-shot plays is ignored',
            global.__CV_TAP(AT.mi, false) >= 0 &&
            global.__CV_TOG(AT.mi) === 'play');
        await tick(tickN(AT.tog.in) * (1000 / AT.tog.in.fps) + 250);
        flushRaf(); flushRaf();
        check('after Active_In the building loops its Active state',
            global.__CV_TOG(AT.mi) === 'active' &&
            global.__CV_DIAG.anims > 0,
            'state=' + global.__CV_TOG(AT.mi) + ' anims=' + global.__CV_DIAG.anims);
        const fOut = global.__CV_TAP(AT.mi, true);
        check('the next click plays the Active_Out one-shot',
            fOut >= 0 && global.__CV_TOG(AT.mi) === 'play', 'fi=' + fOut);
        await tick(tickN(AT.tog.out) * (1000 / AT.tog.out.fps) + 250);
        flushRaf(); flushRaf();
        check('Active_Out returns the building to static Neutral',
            global.__CV_TOG(AT.mi) === 'neutral' &&
            global.__CV_DIAG.anims === 0,
            'state=' + global.__CV_TOG(AT.mi) + ' anims=' + global.__CV_DIAG.anims);
    }
    /* state-machine shapes beyond the helicopter's trio (parsed from
       buildingcontrollers.xml): cycle advances one pose loop per click,
       active toggles its loop on/off, and an inout machine with NO Active
       loop holds In's final frame while active */
    const bg = (global.__ANIM_MAN || {}).behavior || {};
    check('the generator parses the k9unit cycle machine',
        !!bg.k9unit && !!bg.k9unit.toggle && bg.k9unit.toggle.kind === 'cycle' &&
        (bg.k9unit.toggle.poses || []).join() ===
            ['Neutral', 'Toggle_02', 'Toggle_01'].join() &&
        bg.k9unit.idle === 'Neutral', JSON.stringify(bg.k9unit));
    check('the generator parses the lobster-scorpion active machine',
        !!bg.giantlobsterscorpion && !!bg.giantlobsterscorpion.toggle &&
        bg.giantlobsterscorpion.toggle.kind === 'active' &&
        bg.giantlobsterscorpion.toggle.loop === 'Active' &&
        bg.giantlobsterscorpion.idle === 'Neutral',
        JSON.stringify(bg.giantlobsterscorpion));
    check('the generator parses the tank inout machine without a hold loop',
        !!bg.deprivationtank && !!bg.deprivationtank.toggle &&
        bg.deprivationtank.toggle.kind === 'inout' &&
        bg.deprivationtank.toggle['in'] === 'In' &&
        bg.deprivationtank.toggle.out === 'Out' &&
        !bg.deprivationtank.toggle.loop, JSON.stringify(bg.deprivationtank));
    const TGS = global.__ANIM_TOG2_SEEDS || {};
    for (const kindWant of ['cycle', 'active', 'inout']) {
        const S = TGS[kindWant];
        check('the ' + kindWant + ' state machine is seeded from the save',
            !!S, S && S.slug);
        if (!S) continue;
        const w2 = global.CAM.tileToWorld(S.px, S.py);
        named['btn-rest'].dispatch('click', {});
        global.__CV_cam.x = w2.x; global.__CV_cam.y = w2.y;
        global.__CV_cam.zoom = global.CAM.ZOOM.rest;
        await tick(30); flushRaf(); flushRaf();
        const idleS = S.gate.idle && S.byName[String(S.gate.idle).toLowerCase()];
        const nameOf = () => global.__CV_TOG_strip(S.mi);
        check('the ' + kindWant + ' asset rests in state 0' +
                (idleS ? ' on its idle loop' : ' static'),
            idleS ? global.__CV_DIAG.anims > 0 : global.__CV_DIAG.anims === 0,
            'anims=' + global.__CV_DIAG.anims + ' idle=' + S.gate.idle);
        if (kindWant === 'cycle') {
            global.__CV_TAP(S.mi, true); flushRaf(); flushRaf();
            check('click 1 loops the first pose strip',
                global.__CV_TOG(S.mi) === 'pose1' &&
                nameOf() === S.gate.toggle.poses[1] &&
                global.__CV_DIAG.anims > 0,
                global.__CV_TOG(S.mi) + ' ' + nameOf() +
                ' anims=' + global.__CV_DIAG.anims);
            global.__CV_TAP(S.mi, true); flushRaf(); flushRaf();
            check('click 2 loops the second pose strip',
                global.__CV_TOG(S.mi) === 'pose2' &&
                nameOf() === S.gate.toggle.poses[2] &&
                global.__CV_DIAG.anims > 0,
                global.__CV_TOG(S.mi) + ' ' + nameOf() +
                ' anims=' + global.__CV_DIAG.anims);
            global.__CV_TAP(S.mi, true); flushRaf(); flushRaf();
            check('click 3 wraps back to the state-0 pose loop',
                global.__CV_TOG(S.mi) === 'pose0' &&
                nameOf() === S.gate.toggle.poses[0] &&
                global.__CV_DIAG.anims > 0,
                global.__CV_TOG(S.mi) + ' ' + nameOf() +
                ' anims=' + global.__CV_DIAG.anims);
        } else if (kindWant === 'active') {
            global.__CV_TAP(S.mi, true); flushRaf(); flushRaf();
            check('the click switches on the Active loop',
                global.__CV_TOG(S.mi) === 'active' &&
                nameOf() === S.gate.toggle.loop &&
                global.__CV_DIAG.anims > 0,
                global.__CV_TOG(S.mi) + ' ' + nameOf() +
                ' anims=' + global.__CV_DIAG.anims);
            global.__CV_TAP(S.mi, true); flushRaf(); flushRaf();
            check('the next click switches back to the state-0 look',
                global.__CV_TOG(S.mi) === 'neutral' && nameOf() === null &&
                (idleS ? global.__CV_DIAG.anims > 0 : global.__CV_DIAG.anims === 0),
                global.__CV_TOG(S.mi) + ' anims=' + global.__CV_DIAG.anims);
        } else {
            const fin = S.byName[String(S.gate.toggle['in']).toLowerCase()];
            const fout = S.byName[String(S.gate.toggle.out).toLowerCase()];
            global.__CV_TAP(S.mi, true);
            check('the click starts the In one-shot',
                global.__CV_TOG(S.mi) === 'play' && nameOf() === fin.anim,
                global.__CV_TOG(S.mi) + ' ' + nameOf());
            await tick(tickN(fin) * (1000 / fin.fps) + 250);
            flushRaf(); flushRaf();
            check('with no Active loop the active state holds In\u2019s last frame',
                global.__CV_TOG(S.mi) === 'active' && nameOf() === fin.anim &&
                global.__CV_DIAG.anims > 0,
                global.__CV_TOG(S.mi) + ' ' + nameOf() +
                ' anims=' + global.__CV_DIAG.anims);
            global.__CV_TAP(S.mi, true);
            check('the next click plays the Out one-shot',
                global.__CV_TOG(S.mi) === 'play' && nameOf() === fout.anim,
                global.__CV_TOG(S.mi) + ' ' + nameOf());
            await tick(tickN(fout) * (1000 / fout.fps) + 250);
            flushRaf(); flushRaf();
            check('Out returns the asset to its state-0 look',
                global.__CV_TOG(S.mi) === 'neutral' && nameOf() === null &&
                (idleS ? global.__CV_DIAG.anims > 0 : global.__CV_DIAG.anims === 0),
                global.__CV_TOG(S.mi) + ' anims=' + global.__CV_DIAG.anims);
        }
    }
    named['btn-rest'].dispatch('click', {});           // the Anim-toggle checks
    global.__CV_cam.x = wc.x; global.__CV_cam.y = wc.y; // below expect the small seed
    flushRaf(); flushRaf();
    named['btn-anim'].dispatch('click', {});          // Anim off -> static PNGs
    flushRaf();
    check('Anim off falls back to the static sprite',
        global.__CV_DIAG.anims === 0, 'anims=' + global.__CV_DIAG.anims);
    check('Anim button reflects the toggle and persists the preference',
        !named['btn-anim'].classList.contains('on') &&
        global.__LSTORE['mrsnrub.cityview.anim'] === '0',
        named['btn-anim'].className + ' / ' + global.__LSTORE['mrsnrub.cityview.anim']);
    named['btn-anim'].dispatch('click', {});          // restore for later checks
    flushRaf();
    check('Anim back on replays the loops', global.__CV_DIAG.anims > 0,
        'anims=' + global.__CV_DIAG.anims);
    named['btn-art'].dispatch('click', {});           // back to blocks
    await tick(160);
    flushRaf();

    console.log('tile grid toggle (sprite-alignment debug):');
    check('grid button starts off',
        !named['btn-grid'].classList.contains('on'),
        named['btn-grid'].className);
    named['btn-grid'].dispatch('click', {});
    check('grid button toggles on',
        named['btn-grid'].classList.contains('on'),
        named['btn-grid'].className);
    const gs0 = global.STROKES;
    named.stage.dispatch('pointermove', { clientX: 300, clientY: 200 });
    flushRaf(); flushRaf();
    check('grid renders a lattice + hover diamond (strokes) without errors',
        global.STROKES > gs0, 'strokes=' + (global.STROKES - gs0));
    check('hover tile shows in the readout',
        /hover -?\d+,-?\d+/.test(named.zoomread.textContent || ''),
        named.zoomread.textContent);
    named['btn-grid'].dispatch('click', {});
    flushRaf();
    check('grid button toggles back off',
        !named['btn-grid'].classList.contains('on') &&
        !/hover/.test(named.zoomread.textContent || ''),
        named['btn-grid'].className + ' / ' + named.zoomread.textContent);
    flushRaf();

    console.log('art tune panel (pin-convention A/B):');
    named.arttune.style.display = 'none';               // as in the HTML
    check('tune button opens the panel + auto-enables sprite art',
        !named['btn-tune'].classList.contains('on') &&
        named.arttune.style.display === 'none',
        named['btn-tune'].className);
    named['btn-tune'].dispatch('click', {});
    const allBtns = [];
    (function walkPanel(el) {
        (el.children || []).forEach(c => {
            if (c.tagName === 'BUTTON') allBtns.push(c);
            walkPanel(c);
        });
    })(named.arttune);
    const byText = t => allBtns.find(b => b.textContent === t);
    const WALKERS = ['⏭ singles', '⏭ anchored', '⏭ offsets'];
    check('panel built: pin steppers + three walkers + reset present',
        !!byText('anchor') && !!byText('origin') && !!byText('−') &&
        !!byText('+') && !!byText('defaults') &&
        WALKERS.every(t => allBtns.some(b => b.textContent === t)),
        allBtns.map(b => b.textContent).join(','));
    byText('origin').dispatch('click', {});
    check('pin=origin applies live (ART.ref) and marks the button on',
        global.ART.ref === 'origin' && byText('origin').classList.contains('on'),
        global.ART.ref + ' / ' + byText('origin').className);
    const ay0 = global.ART.ay;
    allBtns.filter(b => b.textContent === '+')[1].dispatch('click', {});   // ay row
    check('ay stepper nudges the ground point', global.ART.ay === ay0 + 0.25,
        String(global.ART.ay));
    const dBefore = named.details.innerHTML;
    for (const wt of WALKERS) {
        const wb = allBtns.find(b => b.textContent === wt);
        wb.dispatch('click', {});
        flushRaf();
        check('walker "' + wt.replace('⏭ ', '') + '" centres a candidate + selects it (details card)',
            /1\/\d+/.test(wb.textContent) && !/none/.test(wb.textContent) &&
            named.details.innerHTML !== dBefore &&
            !/placeholder/.test(named.details.innerHTML),
            String(wb.textContent));
    }
    byText('defaults').dispatch('click', {});
    check('reset restores shipped defaults',
        global.ART.S === 64 && global.ART.ax === 0 && global.ART.ay === 0 &&
        global.ART.ref === 'anchor',
        JSON.stringify(global.ART));
    named['btn-tune'].dispatch('click', {});
    check('tune button closes the panel',
        named.arttune.style.display === 'none' &&
        !named['btn-tune'].classList.contains('on'),
        named.arttune.style.display + ' / ' + named['btn-tune'].className);
    flushRaf();

    console.log('building wireframe toggle:');
    check('wire button starts off',
        !named['btn-wire'].classList.contains('on'),
        named['btn-wire'].className);
    const w0 = global.STROKES;
    named['btn-wire'].dispatch('click', {});
    flushRaf(); flushRaf();
    check('wire on strokes the full boxes (12 edges incl. hidden base)',
        named['btn-wire'].classList.contains('on') && global.STROKES > w0 + 6,
        'strokes=' + (global.STROKES - w0));
    named['btn-wire'].dispatch('click', {});
    flushRaf();
    check('wire button toggles back off',
        !named['btn-wire'].classList.contains('on'),
        named['btn-wire'].className);
    flushRaf();

    console.log('tile-marker textarea (markers.js):');
    const ta = named.objlegend.children.find(c => c.tagName === 'TEXTAREA');
    const mstat = named.objlegend.children.find(
        c => c.className === 'mstat');
    check('objects legend carries the marker textarea + status row',
        !!ta && !!mstat, named.objlegend.children.map(c => c.tagName).join(','));
    check('empty stored value -> empty textarea, nothing marked',
        ta && ta.value === '' && mstat.textContent === '', ta && ta.value);
    named['btn-downtown'].dispatch('click', {});     // all 5 marks sit in DT
    flushRaf();
    const ms0 = global.STROKES;
    ta.value = '(130,20) (144,17) (128,36) (161,54) (170,54)';
    ta.dispatch('input', {});
    flushRaf(); flushRaf();
    check('paste marks all five evidence tiles (diamond+cross strokes each)',
        global.STROKES - ms0 >= 10 && /5 marked/.test(mstat.textContent || ''),
        'strokes=' + (global.STROKES - ms0) + ' stat=' + mstat.textContent);
    check('raw text persisted for reload',
        global.__LSTORE['mrsnrub.cityview.markers'] === ta.value,
        JSON.stringify(global.__LSTORE['mrsnrub.cityview.markers']));
    const ms1 = global.STROKES;
    ta.value = 'garbage, not coords';
    ta.dispatch('input', {});
    ta.value = '';
    ta.dispatch('input', {});
    flushRaf(); flushRaf();
    check('clearing the box removes the marks and the status text',
        mstat.textContent === '' &&
        (global.STROKES - ms1) < 10, 'stat=' + mstat.textContent);
    flushRaf();

    console.log('road network model (terrain.js Terrain#roadNetwork):');
    {
        const TM = require(path.join(ROOT, 'js/terrain.js'));
        const ak = TM.anchoredKeep;
        const pk = { '0,0': true };
        const diag = [0, 0, 1, 1, 4, 4];      // P tile + corner-touching single + far single
        const k8 = ak(diag, pk), k4 = ak(diag, pk, true);
        check('anchoredKeep 8-conn anchors the corner-touching single',
            k8[0] && k8[1] && !k8[2], JSON.stringify(k8));
        check('anchoredKeep 4-conn drops it (orthogonal network: no diagonal edges)',
            k4[0] && !k4[1] && !k4[2], JSON.stringify(k4));
        const TO = global.CityTerrain.TYPE_ORDER;
        const rc = t => t.features.reduce((n, f) => n + (TO[f[2]] === 'road' ? 1 : 0), 0);
        const t8 = new global.CityTerrain(M, { speckleFilter: true });
        const t4 = new global.CityTerrain(M, { speckleFilter: true, roadNetwork: true });
        const n8 = rc(t8), n4 = rc(t4);
        check('4-conn anchoring never keeps more road tiles than 8-conn',
            n4 <= n8, n8 + ' vs ' + n4);
        let plaza = 0, orphan = 0;
        for (const k in t8._plazaOcc) { plaza++; if (!t8._roadOcc[k]) orphan++; }
        check('P provenance: 6,272 plaza tiles recorded, all road-occupied',
            plaza === 6272 && orphan === 0, 'plaza=' + plaza + ' orphan=' + orphan);
        t8.setRoadNetwork(true);
        check('setRoadNetwork flips the model + rebuilds (road count stable here)',
            t8.roadNetwork === true && rc(t8) === n8, String(rc(t8)));
        t8.setRoadNetwork(false);
        check('setRoadNetwork flips back', t8.roadNetwork === false, 'off');
    }
    named['btn-roadnet'].dispatch('click', {});
    flushRaf();
    check('Road network button toggles on + persists',
        named['btn-roadnet'].classList.contains('on') &&
        global.__LSTORE['mrsnrub.cityview.roadnet'] === '1',
        named['btn-roadnet'].className + ' / ' + global.__LSTORE['mrsnrub.cityview.roadnet']);
    named['btn-roadnet'].dispatch('click', {});
    flushRaf();
    check('Road network button toggles back off',
        !named['btn-roadnet'].classList.contains('on') &&
        global.__LSTORE['mrsnrub.cityview.roadnet'] === '0',
        named['btn-roadnet'].className);
    flushRaf();

    // GL sprite atlas regression pass: same DOM, fake GL renderer, art on
    // (kept out-of-process because a live glR would flip every other
    // rendering expectation in this file to the GL paths)
    const { spawnSync } = require('child_process');
    const cargs = [__filename];
    if (process.argv[2] && !process.argv[2].startsWith('--')) cargs.push(ROOT);
    cargs.push('--gl');
    const child = spawnSync(process.execPath, cargs, { stdio: 'inherit' });
    if (child.status !== 0) { failures++; console.log('  FAIL gl child run (exit ' + child.status + ')'); }

    console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL CHECKS PASSED');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
