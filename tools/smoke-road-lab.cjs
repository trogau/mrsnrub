// Headless smoke test for the road-lab tuning page
// (web/viewer/road-lab.{html,js}).
//
// Boots the page script under a minimal DOM/canvas shim whose
// addEventListener stores handlers, then drives the controls: initial render
// paints footpath/asphalt/pavement, the steppers move footpath widths with
// the carriageway clamp, presets set both orientations, tone steppers change
// the reference colours, and the reference block stays well-formed.
//
//   node tools/smoke-road-lab.cjs
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

let failures = 0;
function check(name, cond, info) {
    if (cond) { console.log('  ok  ' + name); }
    else { failures++; console.log('FAIL  ' + name + (info !== undefined ? '  [' + info + ']' : '')); }
}

/* ---- minimal DOM/canvas shim ------------------------------------------------ */
const styles = new Set();
let drawImageCalls = 0;
let clipCalls = 0;
function ctxStub() {
    return {
        beginPath() {}, rect() {}, moveTo() {}, lineTo() {}, closePath() {},
        stroke() {}, fill() { if (this.fillStyle) styles.add(this.fillStyle); },
        measureText(t) { return { width: String(t).length * 6.2 }; },
        fillText() {}, fillRect() {}, strokeRect() {},
        save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
        clip() { clipCalls++; }, drawImage() { drawImageCalls++; }, setTransform() {},
        putImageData() {}, createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; },
        transform() {},
        set font(v) {}, set textAlign(v) {}, set textBaseline(v) {},
        fillStyle: '', strokeStyle: '', lineWidth: 1,
    };
}
function el(id) {
    const e = {
        id, style: {}, className: '', textContent: '', value: '', width: 760, height: 320,
        options: [], _h: {}, _attr: {}, _lastOp: '',
        addEventListener(type, fn) { (this._h[type] = this._h[type] || []).push(fn); },
        click() { (this._h.click || []).forEach(f => f()); },
        change() { (this._h.change || []).forEach(f => f()); },
        getAttribute(a) { return this._attr[a]; },
        getContext() {
            const self = this;
            const c = ctxStub();
            // record every label so layout checks can look for collisions
            self._labels = [];
            c.fillText = function (t, x, y) {
                self._labels.push({ t: String(t), x: x, y: y, w: String(t).length * 6.2, h: 11 });
            };
            c.scale = function (a, b) { (self._scales = self._scales || []).push([a, b]); };
            c.transform = function (a, b, cc, d, e, f) {
                (self._xforms = self._xforms || []).push([a, b, cc, d, e, f]);
            };
            c.setTransform = function (a, b, cc, d, e, f) {
                (self._xforms = self._xforms || []).push([a, b, cc, d, e, f]);
            };
            for (const k of Object.keys(c)) {
                if (typeof c[k] === 'function') {
                    const v = c[k];
                    c[k] = function () { self._lastOp = 'draw'; return v.apply(this, arguments); };
                }
            }
            return c;
        },
        appendChild(node) { this.options.push(node); },
    };
    // intercept the height assignment: assigning canvas.height clears the
    // bitmap in real browsers, so a resize must never be the LAST op of a
    // render pass (the _lastOp trail is what the checks assert).
    let _w = 760, _ht = 320;
    Object.defineProperty(e, 'width', { get: () => _w, set(v) { _w = v; e._lastOp = 'resize'; } });
    Object.defineProperty(e, 'height', { get: () => _ht, set(v) { _ht = v; e._lastOp = 'resize'; } });
    if (id !== 'tmp') els[id] = e;   // shim-built buttons share identity with getElementById
    return e;
}
const els = {};
const presets = ['current', 'hair', 'narrow', 'mid', 'midwide', 'wide', 'oneside', 'none'].map(p => {
    const b = el('preset-' + p);
    b._attr['data-preset'] = p;
    return b;
});
const tabBtns = [['tab-sheet', 'tab-btn-sheet'], ['tab-water', 'tab-btn-water'], ['tab-dirt', 'tab-btn-dirt'], ['tab-dirt2', 'tab-btn-dirt2'], ['tab-bw', 'tab-btn-bw'], ['tab-pier', 'tab-btn-pier'], ['tab-bridge', 'tab-btn-bridge'], ['tab-tune', 'tab-btn-tune']].map(([t, id]) => {
    const b = el(id);
    b._attr['data-tab'] = t;
    return b;
});
function preset(name) {
    const b = presets.find(p => p._attr['data-preset'] === name);
    if (!b) throw new Error('no preset button: ' + name);
    return b;
}
global.document = {
    getElementById: id => (els[id] || (els[id] = el(id))),
    querySelectorAll: sel => (sel === '[data-preset]' ? presets : sel === '[data-tab]' ? tabBtns : []),
    createElement: () => el('tmp'),
    body: { appendChild() {}, removeChild() {} },
};
// fake Image: firing onload synchronously from the src setter drives the
// sheet-inspector paint path (blits, lattice overlay, resize/re-run guard)
// headless — a post-paint canvas.height assignment would blow away draws.
// Sizes mirror the real packs (road sheet 512², wave atlas 256×128) so the
// water blits exercise their real scale factors.
// Synchronous fetch: the WildWest dirt sheet is an .rgb pulled via fetch +
// decodeRgb; serving the REAL pack files keeps DIRT.img populated within
// the caller's stack so the paint-path assertions hold.
const fakeP = v => ({ then(f) { const r = f(v); return (r && typeof r.then === 'function') ? r : fakeP(r); }, catch() { return fakeP(v); } });
global.fetch = u => {
    const b = fs.readFileSync(path.join(root, 'web', String(u).replace(/^\.\.\//, '')));
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    return fakeP({ ok: true, arrayBuffer: () => fakeP(ab) });
};
global.ImageData = function (data, w, h) { this.data = data; this.width = w; this.height = h; };
global.Image = function () {
    const self = this;
    this.naturalWidth = 512; this.naturalHeight = 512;
    Object.defineProperty(this, 'src', {
        set(v) {
            self._src = v;
            if (/wateranimations\.png$/.test(v)) { self.naturalWidth = 256; self.naturalHeight = 128; }
            const bs = { 'bridgetop_f2.png': [404, 325], 'bridgetop_f3.png': [404, 306],
                         'bridgetop_f4.png': [294, 325], 'bridgetop_f5.png': [294, 270],
                         'bridgetop_f6.png': [294, 306],
                         'bridgebottom_f0.png': [294, 249] };
            for (const k in bs) if (v.endsWith(k)) { self.naturalWidth = bs[k][0]; self.naturalHeight = bs[k][1]; }
            if (self.onload) self.onload();
        },
        get() { return self._src; },
    });
};
global.window = global;
// road-lab's bridge tab projects with the real camera model (script tag in
// road-lab.html loads camera.js; the harness provides the same global)
global.CAM = require(path.join(root, 'web', 'js', 'camera.js'));

/* ---- boot the page script ---------------------------------------------------- */
eval(fs.readFileSync(path.join(root, 'web', 'viewer', 'road-lab.js'), 'utf8'));

console.log('road-lab (web/viewer/road-lab.html):');
const L = global.window.__LAB;
check('page script boots (window.__LAB)', !!L && !!L.P && !!L.formatRef);
if (!L) { console.log('1 FAILURES'); process.exit(1); }
const P = L.P;

/* ---- initial render ------------------------------------------------------------ */
check('current preset is 1/2/1 in both orientations',
    P.ns.w1 === 1 && P.ns.w2 === 1 && P.ew.w1 === 1 && P.ew.w2 === 1);
check('initial render paints footpath, asphalt and pavement',
    styles.has('#9c9ca3') && styles.has('#5c5c62') && styles.has('#7e7e85'),
    [...styles].join(','));
check('reference block shows the geometry contract',
    /footWest: 1,/.test(L.formatRef()) && /footNorth: 1,/.test(L.formatRef()) &&
    /carriageway: 2/.test(L.formatRef()) && /pavement: "uniform"/.test(L.formatRef()));
check('readouts mirror state',
    els['ns-a-v'].textContent === '1' && els['ns-car'].textContent === '2' &&
    els['ew-b-v'].textContent === '1');

/* ---- steppers + carriageway clamp ---------------------------------------------- */
els['ns-a-plus'].click();
check('+ on west path moves by an eighth tile', P.ns.w1 === 1.125, P.ns.w1);
check('reference block updates with the new width',
    /footWest: 1\.125/.test(L.formatRef()) && /carriageway: 1\.875/.test(L.formatRef()));
for (let i = 0; i < 20; i++) els['ns-a-plus'].click();
check('west path clamps so carriageway stays >= 1 tile',
    P.ns.w1 + P.ns.w2 === 3 && P.ns.w1 === 2 && P.ns.w2 === 1,
    P.ns.w1 + '/' + P.ns.w2);
els['ns-a-minus'].click();
check('− steps back down by an eighth tile', P.ns.w1 === 1.875, P.ns.w1);
els['ns-a-minus'].click(); els['ns-a-minus'].click();
check('state stays on the 0.125 grid', P.ns.w1 === 1.625, P.ns.w1);

/* ---- presets -------------------------------------------------------------------- */
for (let i = 0; i < 40; i++) els['ew-b-plus'].click();
preset('mid').click();
check('mid preset sets both orientations to 0.75/2.5/0.75',
    P.ns.w1 === 0.75 && P.ns.w2 === 0.75 && P.ew.w1 === 0.75 && P.ew.w2 === 0.75,
    [P.ns.w1, P.ns.w2, P.ew.w1, P.ew.w2].join('/'));
preset('hair').click();
check('hair preset gives 0.25/3.5/0.25',
    P.ns.w1 === 0.25 && P.ns.w2 === 0.25 && P.ew.w1 === 0.25 && P.ew.w2 === 0.25);
preset('midwide').click();
check('midwide preset gives 1.25/1.5/1.25',
    P.ns.w1 === 1.25 && P.ns.w2 === 1.25 && P.ew.w1 === 1.25 && P.ew.w2 === 1.25);
preset('wide').click();
check('wide preset sets both orientations to 1.5/1.5',
    P.ns.w1 === 1.5 && P.ns.w2 === 1.5 && P.ew.w1 === 1.5 && P.ew.w2 === 1.5,
    [P.ns.w1, P.ns.w2, P.ew.w1, P.ew.w2].join('/'));
preset('oneside').click();
check('oneside preset gives 0/1 on both axes',
    P.ns.w1 === 0 && P.ns.w2 === 1 && P.ew.w1 === 0 && P.ew.w2 === 1);
preset('none').click();
check('none preset zeroes the footpaths',
    P.ns.w1 === 0 && P.ns.w2 === 0 && P.ew.w1 === 0 && P.ew.w2 === 0);
styles.clear();
L.render();
check('no-footpath mode stops painting footpath tone',
    !styles.has('#9c9ca3') && styles.has('#5c5c62'), [...styles].join(','));
preset('current').click();   // back to current

/* ---- tone steppers ---------------------------------------------------------------- */
els['foot-plus'].click();
check('footpath tone stepper shades the reference colour',
    P.footTone === 1 && /footpath: "#(?!9c9ca3)/.test(L.formatRef()), L.formatRef());
for (let i = 0; i < 10; i++) els['foot-plus'].click();
check('footpath tone clamps at +4', P.footTone === 4, P.footTone);
els['pave-minus'].click();
check('pavement tone shades independently',
    P.paveTone === -1 && /pavement: "#(?!7e7e85)/.test(L.formatRef()));
for (let i = 0; i < 4; i++) els['foot-minus'].click();   // back to neutral
els['pave-plus'].click();
check('tone steppers return to neutral', P.footTone === 0 && P.paveTone === 0);

/* ---- view toggles ------------------------------------------------------------------- */
els['btn-iso'].click();
check('iso toggle flips state and keeps rendering', P.iso === true);
styles.clear();
L.render();
check('iso mode still paints all three surface tones',
    styles.has('#9c9ca3') && styles.has('#5c5c62') && styles.has('#7e7e85'));
els['btn-iso'].click();
els['btn-kerb'].click();
check('kerb toggle flips state', P.kerb === false);
els['btn-kerb'].click();
els['btn-lattice'].click(); els['btn-lattice'].click();
els['btn-dims'].click(); els['btn-dims'].click();
check('toggles return to their defaults',
    P.iso === false && P.kerb === true && P.lattice === true && P.dims === true);

/* ---- sheet inspector ------------------------------------------------------------- */
const A = L.ART;
check('inspector state starts on the viewer pack with engine-table picks',
    A && A.pack === 0 && A.zoom === 2 && A.forceAuto === true && A.force === -1 &&
    A.flip === false && A.grid === true && A.raw === false,
    A && [A.pack, A.zoom, A.forceAuto, A.force, A.flip, A.grid, A.raw].join('/'));
check('cell mask defaults to an E+W street, probes all off',
    A.mask.e === true && A.mask.w === true && A.mask.n === false && A.mask.s === false &&
    !A.probe.e && !A.probe.w && !A.probe.n && !A.probe.s,
    JSON.stringify(A.mask) + JSON.stringify(A.probe));
check('pack select is populated with every verified sheet',
    els['sel-pack'].options.length === 10, els['sel-pack'].options.length);
check('sheet image loads and drives the inspector',
    !!A.img && /roadtilesheet\.png$/.test(A.img._src || ''), A.img && A.img._src);
check('full paint path blits the sheet (full view + states + demo + families)',
    drawImageCalls > 20, drawImageCalls);
check('inspector canvas grew to content', els['cv-art'].height > 1000,
    els['cv-art'].height);
els['sel-pack'].value = '2'; els['sel-pack'].change();
check('switching the pack select changes the active pack', A.pack === 2, A.pack);
els['sel-pack'].value = '0'; els['sel-pack'].change();

/* ---- RE'd quadrant family table ---------------------------------------------------- */
function es(p) { return L.engStates(p); }
check('E+W street picks the RE’d family (nw4 ne7 ws10 es3)',
    JSON.stringify(es({ e: 1, w: 1, n: 0, s: 0 })) ===
    JSON.stringify({ nw: 4, ne: 7, ws: 10, es: 3 }),
    JSON.stringify(es({ e: 1, w: 1, n: 0, s: 0 })));
check('N+S street mirrors it (nw3 ne7 ws10 es4)',
    JSON.stringify(es({ e: 0, w: 0, n: 1, s: 1 })) ===
    JSON.stringify({ nw: 3, ne: 7, ws: 10, es: 4 }),
    JSON.stringify(es({ e: 0, w: 0, n: 1, s: 1 })));
check('isolated cell draws the four paved-corner states (1/5/8/1)',
    JSON.stringify(es({ e: 0, w: 0, n: 0, s: 0 })) ===
    JSON.stringify({ nw: 1, ne: 5, ws: 8, es: 1 }),
    JSON.stringify(es({ e: 0, w: 0, n: 0, s: 0 })));
check('fully open cell draws the interior states (2/6/9/2)',
    JSON.stringify(es({ e: 1, w: 1, n: 1, s: 1 })) ===
    JSON.stringify({ nw: 2, ne: 6, ws: 9, es: 2 }),
    JSON.stringify(es({ e: 1, w: 1, n: 1, s: 1 })));
check('E+S bend picks nw1 ne7 ws10 es2',
    JSON.stringify(es({ e: 1, w: 0, n: 0, s: 1 })) ===
    JSON.stringify({ nw: 1, ne: 7, ws: 10, es: 2 }),
    JSON.stringify(es({ e: 1, w: 0, n: 0, s: 1 })));

/* ---- flip byte (selector out flag) + blit orientation ------------------- */
const ef = (p, q) => L.engFlip(p, q);
check('ES quadrant always flips (out=1 forced on the (2,2) path)',
    ef({ e: 1, w: 1, n: 1, s: 1 }, 'es') === true &&
    ef({ e: 0, w: 0, n: 0, s: 0 }, 'es') === true);
check('NE flips only for N-only (state 7 kerb must land on closed E edge)',
    ef({ n: 1, e: 0 }, 'ne') === true && ef({ n: 1, e: 1 }, 'ne') === false &&
    ef({ n: 0, e: 1 }, 'ne') === false && ef({ n: 0, e: 0 }, 'ne') === false);
check('WS flips only for W-only (state 10 kerb must land on closed S edge)',
    ef({ w: 1, s: 0 }, 'ws') === true && ef({ w: 1, s: 1 }, 'ws') === false &&
    ef({ w: 0, s: 1 }, 'ws') === false && ef({ w: 0, s: 0 }, 'ws') === false);
check('NW never flips (corner family art is authored for W/N kerbs)',
    ef({ n: 1, w: 0 }, 'nw') === false && ef({ n: 0, w: 1 }, 'nw') === false &&
    ef({ n: 0, w: 0 }, 'nw') === false && ef({ n: 1, w: 1 }, 'nw') === false);
L.render();
check('engine blits mirror the sampled rect (rot45 with NEGATED v scale)',
    (els['cv-art']._scales || []).length > 0 &&
    els['cv-art']._scales.every(s => s[1] < 0),
    JSON.stringify((els['cv-art']._scales || []).slice(0, 2)));

const refEng = L.formatRef();
check('reference block carries the ROAD_ENGINE contract',
    /ROAD_ENGINE = \{/.test(refEng) && /nibbleBits: \{ E: 1, W: 2, N: 4, S: 8 \}/.test(refEng) &&
    /quadrantStates:/.test(refEng) && /nw: \{ both: 2, nOnly: 3, wOnly: 4, none: 1 \}/.test(refEng) &&
    /force: -1/.test(refEng) && !/ROAD_SHEET/.test(refEng),
    refEng.slice(refEng.indexOf('ROAD_ENGINE')));

/* ---- mask / probe / force / flip controls ------------------------------------------- */
els['btn-mask-w'].click();   // E+W -> E only
check('mask toggle clears the W bit and the quadrant picks follow',
    A.mask.w === false && L.quadPick(L.effPass(), 'nw') === 1 &&
    els['btn-mask-w'].className === '', [A.mask.w, els['btn-mask-w'].className].join('/'));
els['btn-probe-w'].click();  // neighbour-solid OR restores W
check('neighbour-solid probe ORs the W edge back in (pass rule)',
    A.probe.w === true && A.mask.w === false &&
    L.quadPick(L.effPass(), 'nw') === 4 &&
    els['btn-probe-w'].className === 'on', L.quadPick(L.effPass(), 'nw'));
els['btn-probe-w'].click(); els['btn-mask-w'].click();   // restore
check('mask restores the E+W street', A.mask.w === true &&
    L.quadPick(L.effPass(), 'nw') === 4);
check('reference quotes the live mask/probe nibbles',
    /cellMask: \[3\]/.test(L.formatRef()) && /probes: \[0\]/.test(L.formatRef()),
    L.formatRef().match(/cellMask.*\n.*probes.*/)[0]);

els['art-force-plus'].click();   // exits auto: -1 -> 0
check('force stepper leaves the engine table',
    A.forceAuto === false && A.force === 0 && els['art-force-v'].textContent === '0',
    [A.forceAuto, A.force, els['art-force-v'].textContent].join('/'));
check('forced state overrides every quadrant pick',
    L.quadPick(L.effPass(), 'nw') === 0 && L.quadPick(L.effPass(), 'es') === 0);
for (let i = 0; i < 15; i++) els['art-force-plus'].click();
check('force clamps at state 10', A.force === 10, A.force);
check('reference quotes the forced state', /force: 10,/.test(L.formatRef()));
els['art-force-auto'].click();
check('auto returns to the engine table',
    A.forceAuto === true && L.quadPick(L.effPass(), 'nw') === 4 &&
    /force: -1/.test(L.formatRef()));

els['art-flip'].click();
check('flip toggle mirrors the sampled rect and flips its button class',
    A.flip === true && els['art-flip'].className === 'on');
els['art-flip'].click();

els['art-zoom-plus'].click(); els['art-zoom-plus'].click();
check('zoom clamps at 3', A.zoom === 3, A.zoom);
els['art-zoom-minus'].click(); els['art-zoom-minus'].click(); els['art-zoom-minus'].click();
check('zoom clamps at 1', A.zoom === 1, A.zoom);
els['art-zoom-plus'].click();   // back to 2

els['art-raw'].click();
check('raw-boxes toggle flips state', A.raw === true);
els['art-raw'].click();
els['art-grid'].click();
check('lattice toggle flips state', A.grid === false);
els['art-grid'].click();
check('inspector toggles return to defaults',
    A.raw === false && A.grid === true && A.zoom === 2 && A.flip === false &&
    A.forceAuto === true);
styles.clear();
L.render();
check('inspector render keeps the main canvases painting',
    styles.has('#9c9ca3') && styles.has('#5c5c62') && styles.has('#7e7e85'));
check('last op on the inspector canvas is a draw, not a bitmap-clearing resize',
    els['cv-art']._lastOp === 'draw', els['cv-art']._lastOp);

/* ---- tabs ------------------------------------------------------------------------- */
check('slot blits clip to their square (engine samples only the inscribed diamond)',
    clipCalls > 20, clipCalls);
check('sprite-sheet tab is the default; tuning pane hidden',
    L.getTab() === 'tab-sheet' && els['tab-sheet'].hidden === false &&
    els['tab-tune'].hidden === true && els['tab-btn-sheet'].className === 'on',
    [L.getTab(), els['tab-sheet'].hidden, els['tab-tune'].hidden].join('/'));
els['tab-btn-tune'].click();
check('tuning tab button swaps panes and classes',
    L.getTab() === 'tab-tune' && els['tab-tune'].hidden === false &&
    els['tab-sheet'].hidden === true && els['tab-btn-tune'].className === 'on' &&
    els['tab-btn-sheet'].className === '');
els['tab-btn-sheet'].click();
check('returning to the sprite-sheet tab restores the initial view',
    L.getTab() === 'tab-sheet' && els['tab-sheet'].hidden === false &&
    els['tab-tune'].hidden === true);
styles.clear();
L.render();
check('hidden-tab canvases still repaint so switching back is never stale',
    styles.has('#9c9ca3') && styles.has('#5c5c62') && styles.has('#7e7e85'));

/* ---- water / river inspector ---------------------------------------------------- */
const WA = L.WATER;
check('water inspector starts on the viewer pack with engine-table picks',
    WA && WA.pack === 0 && WA.zoom === 2 && WA.forceAuto === true && WA.force === -1 &&
    WA.flip === false && WA.grid === true && WA.raw === false,
    WA && [WA.pack, WA.zoom, WA.forceAuto, WA.force, WA.flip, WA.grid, WA.raw].join('/'));
check('water cell mask defaults to an E+W channel, probes all off',
    WA.mask.e === true && WA.mask.w === true && WA.mask.n === false && WA.mask.s === false &&
    !WA.probe.e && !WA.probe.w && !WA.probe.n && !WA.probe.s,
    JSON.stringify(WA.mask) + JSON.stringify(WA.probe));
check('water pack select is populated with the same sheets as roads',
    els['sel-water-pack'].options.length === 10, els['sel-water-pack'].options.length);
check('water tab draws from the shared roadrivertiles sheet',
    !!WA.img && /roadtilesheet\.png$/.test(WA.img._src || ''), WA.img && WA.img._src);
check('wave atlas loads as its own image (WaterAnims, not the tile sheet)',
    !!WA.wave && /wateranimations\.png$/.test(WA.wave._src || ''), WA.wave && WA.wave._src);
check('the 11 river quads are parallelograms (T+B == R+L, <=0.5 px)',
    L.RIVER_QUADS.length === 11 && L.RIVER_QUADS.every(q => {
        const dx = Math.abs((q[0][0] + q[3][0]) - (q[1][0] + q[2][0]));
        const dy = Math.abs((q[0][1] + q[3][1]) - (q[1][1] + q[2][1]));
        return dx <= 0.5 && dy <= 0.5;
    }));
check('state 1 is the open-water slab, state 0 the most banked corner',
    L.RIVER_WHAT[1].includes('open-water slab') && L.RIVER_WHAT[0].includes('both edges banked') &&
    L.RIVER_COVER[1] === 100 && L.RIVER_COVER[0] < 45,
    JSON.stringify(L.RIVER_COVER));

function rs(p) { return L.rivStates(p); }
check('E+W channel picks the river family (nw4 ne7 ws10 es3) — roads’ table with 0/1 exchanged',
    JSON.stringify(rs({ e: 1, w: 1, n: 0, s: 0 })) ===
    JSON.stringify({ nw: 4, ne: 7, ws: 10, es: 3 }),
    JSON.stringify(rs({ e: 1, w: 1, n: 0, s: 0 })));
check('N+S channel mirrors it (nw3 ne7 ws10 es4)',
    JSON.stringify(rs({ e: 0, w: 0, n: 1, s: 1 })) ===
    JSON.stringify({ nw: 3, ne: 7, ws: 10, es: 4 }),
    JSON.stringify(rs({ e: 0, w: 0, n: 1, s: 1 })));
check('isolated cell banks on all four edges (0/5/8/0)',
    JSON.stringify(rs({ e: 0, w: 0, n: 0, s: 0 })) ===
    JSON.stringify({ nw: 0, ne: 5, ws: 8, es: 0 }),
    JSON.stringify(rs({ e: 0, w: 0, n: 0, s: 0 })));
check('fully open cell is plain water everywhere (2/6/9/2)',
    JSON.stringify(rs({ e: 1, w: 1, n: 1, s: 1 })) ===
    JSON.stringify({ nw: 2, ne: 6, ws: 9, es: 2 }),
    JSON.stringify(rs({ e: 1, w: 1, n: 1, s: 1 })));
check('E+S bend picks nw0 ne7 ws10 es2',
    JSON.stringify(rs({ e: 1, w: 0, n: 0, s: 1 })) ===
    JSON.stringify({ nw: 0, ne: 7, ws: 10, es: 2 }),
    JSON.stringify(rs({ e: 1, w: 0, n: 0, s: 1 })));
const wf = (p, q) => L.rivFlip(p, q);
check('water flips follow the inherited emitter: ES always, NE for N-only, WS for W-only, NW never',
    wf({ e: 0, w: 0, n: 0, s: 0 }, 'es') === true &&
    wf({ n: 1, e: 0 }, 'ne') === true && wf({ n: 1, e: 1 }, 'ne') === false &&
    wf({ w: 1, s: 0 }, 'ws') === true && wf({ w: 1, s: 1 }, 'ws') === false &&
    wf({ n: 1, w: 1 }, 'nw') === false);
check('water state 0/1 are the exchanged pair: banked corner vs slab',
    L.rivStates({ e: 0, w: 0, n: 0, s: 0 }).nw === 0 &&
    L.RIVER_QUADS[1][0][1] > 400 && L.RIVER_QUADS[0][0][1] < 100);
L.render();
check('water blits warp the square with the affine UV map (rot45-like, not axis-aligned)',
    (els['cv-water']._xforms || []).length > 0 &&
    els['cv-water']._xforms.some(x => Math.abs(x[1]) > 1e-6 && Math.abs(x[2]) > 1e-6),
    JSON.stringify((els['cv-water']._xforms || []).slice(0, 2)));
/* uvCTM contract — the 2026-10-26 black-triangle bug: the flipped CTM
   negated the wrong matrix entries, so flipped quadrants no longer sampled
   the UV parallelogram (black sheet corners bled in) and the bank landed on
   open edges. The engine's flip is the ANTI-DIAGONAL reflection (notes/09
   §6 step 3: flipped bake O=R, E=-(T-L), S=-(B-L)) -> under the CTM, sheet
   corner M(u,v) = L + u(B-L) + v(T-L) must land at device
   (x0 + size*u, y0 + size*v) unflipped and (x0 + size*(1-v), y0 + size*(1-u))
   flipped: B/T keep their corners, L/R swap. */
function devOf(m, p) { return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]]; }
function near(a, b, tol) { tol = tol || 1e-6; return Math.abs(a[0] - b[0]) < tol && Math.abs(a[1] - b[1]) < tol; }
(function () {
    var st = 0, x0 = 100, y0 = 50, sz = 66;          // ES quadrant of the isolated pool
    var q = L.RIVER_QUADS[st], T = q[0], R = q[1], Lp = q[2], B = q[3];
    var U0 = devOf(L.uvCTM(st, x0, y0, sz, false), Lp);
    var U1 = devOf(L.uvCTM(st, x0, y0, sz, false), B);
    var U2 = devOf(L.uvCTM(st, x0, y0, sz, false), T);
    var U3 = devOf(L.uvCTM(st, x0, y0, sz, false), R);
    check('uvCTM unflipped maps sheet corners L->TL B->TR T->BL R->BR (notes/08 corner map)',
        near(U0, [x0, y0]) && near(U1, [x0 + sz, y0]) &&
        near(U2, [x0, y0 + sz]) && near(U3, [x0 + sz, y0 + sz], 0.55),
        [U0, U1, U2, U3].map(function (p) { return p.map(Math.round).join(','); }).join(' | '));
    var F0 = devOf(L.uvCTM(st, x0, y0, sz, true), Lp);
    var F1 = devOf(L.uvCTM(st, x0, y0, sz, true), B);
    var F2 = devOf(L.uvCTM(st, x0, y0, sz, true), T);
    var F3 = devOf(L.uvCTM(st, x0, y0, sz, true), R);
    check('uvCTM flipped is the engine anti-diagonal: L->BR B->TR T->BL R->TL (B/T fixed, L/R swap)',
        near(F0, [x0 + sz, y0 + sz]) && near(F1, [x0 + sz, y0]) &&
        near(F2, [x0, y0 + sz]) && near(F3, [x0, y0], 0.55),
        [F0, F1, F2, F3].map(function (p) { return p.map(Math.round).join(','); }).join(' | '));
    var C0 = devOf(L.uvCTM(st, x0, y0, sz, false), [(T[0] + B[0]) / 2, (T[1] + B[1]) / 2]);
    var C1 = devOf(L.uvCTM(st, x0, y0, sz, true), [(T[0] + B[0]) / 2, (T[1] + B[1]) / 2]);
    check('both CTMs map the parallelogram centre to the square centre (no spill outside the diamond)',
        near(C0, [x0 + sz / 2, y0 + sz / 2]) && near(C1, [x0 + sz / 2, y0 + sz / 2]),
        [C0, C1].map(function (p) { return p.join(','); }).join(' | '));
})();
check('water blits clip to their square (only the parallelogram interior shows)',
    (els['cv-water']._labels || []).length > 0);
check('water canvas grew to content (sheet + 11 states + cell + families + wave atlas)',
    els['cv-water'].height > 1500, els['cv-water'].height);
check('last op on the water canvas is a draw, not a bitmap-clearing resize',
    els['cv-water']._lastOp === 'draw', els['cv-water']._lastOp);

const refW = L.formatRef();
check('reference block carries the WATER_ENGINE contract',
    /WATER_ENGINE = \{/.test(refW) && /uvTable: "0x3fc320/.test(refW) &&
    /nibbleBits: \{ E: 1, W: 2, N: 4, S: 8 \}/.test(refW) &&
    /flagBit5State0: false/.test(refW) && /identityFallback: false/.test(refW) &&
    /nw: \{ both: 2, nOnly: 3, wOnly: 4, none: 0 \}/.test(refW) &&
    /frameBinding: "UNPROVEN"/.test(refW),
    refW.slice(refW.indexOf('WATER_ENGINE')));
check('reference block lists all 11 measured river quads with their lattice slots',
    (refW.slice(refW.indexOf('WATER_ENGINE'), refW.indexOf('DIRT_ART')).match(/\/\/ \(c,r=/g) || []).length === 11,
    (refW.match(/\/\/ \(c,r=/g) || []).length);

els['wbtn-mask-w'].click();
check('water mask toggle clears W and the quadrant picks follow (nw 4 -> 0)',
    WA.mask.w === false && L.rivPick(L.wEffPass(), 'nw') === 0 &&
    els['wbtn-mask-w'].className === '', L.rivPick(L.wEffPass(), 'nw'));
els['wbtn-probe-w'].click();
check('neighbour-water probe ORs the W edge back in (pass rule)',
    WA.probe.w === true && WA.mask.w === false &&
    L.rivPick(L.wEffPass(), 'nw') === 4 && els['wbtn-probe-w'].className === 'on',
    L.rivPick(L.wEffPass(), 'nw'));
els['wbtn-probe-w'].click(); els['wbtn-mask-w'].click();
check('water mask restores the E+W channel', WA.mask.w === true &&
    L.rivPick(L.wEffPass(), 'nw') === 4);
els['w-force-plus'].click();
check('water force stepper leaves the engine table',
    WA.forceAuto === false && WA.force === 0 && els['w-force-v'].textContent === '0');
check('forced state overrides every water quadrant pick',
    L.rivPick(L.wEffPass(), 'nw') === 0 && L.rivPick(L.wEffPass(), 'es') === 0);
for (let i = 0; i < 15; i++) els['w-force-plus'].click();
check('water force clamps at state 10', WA.force === 10, WA.force);
els['w-force-auto'].click();
check('auto returns to the river table',
    WA.forceAuto === true && L.rivPick(L.wEffPass(), 'nw') === 4);
els['w-flip'].click();
check('water flip toggle mirrors the sampled rect', WA.flip === true && els['w-flip'].className === 'on');
els['w-flip'].click();
els['w-zoom-plus'].click(); els['w-zoom-plus'].click();
check('water zoom clamps at 3', WA.zoom === 3, WA.zoom);
els['w-zoom-minus'].click(); els['w-zoom-minus'].click(); els['w-zoom-minus'].click();
check('water zoom clamps at 1', WA.zoom === 1, WA.zoom);
els['w-zoom-plus'].click();
els['w-raw'].click();
check('water raw-boxes toggle flips state', WA.raw === true);
els['w-raw'].click();
els['w-grid'].click();
check('water lattice toggle flips state', WA.grid === false);
els['w-grid'].click();
check('water toggles return to defaults',
    WA.raw === false && WA.grid === true && WA.zoom === 2 && WA.flip === false && WA.forceAuto === true);

/* ---- dirt sheet inspector --------------------------------------------------------- */
const DT = L.DIRT;
check('dirt inspector starts on the road model (dirtroad) with engine-table picks',
    DT && DT.model === 'road' && DT.zoom === 2 && DT.forceAuto === true && DT.force === -1 &&
    DT.flip === false && DT.grid === true && DT.raw === false,
    DT && [DT.model, DT.zoom, DT.forceAuto, DT.force, DT.flip, DT.grid, DT.raw].join('/'));
check('dirt cell mask defaults to an E+W run, probes all off',
    DT.mask.e === true && DT.mask.w === true && DT.mask.n === false && DT.mask.s === false &&
    !DT.probe.e && !DT.probe.w && !DT.probe.n && !DT.probe.s,
    JSON.stringify(DT.mask) + JSON.stringify(DT.probe));
check('dirt tab draws from the dirt sheet (WildWest normal art by default), not the road sheet',
    !!DT.img && /dirtroadtilesheet\.(rgb|png)$/.test(DT.img._src || '') &&
    DT.img._src === DT.sheet && /WildWest_RiverRoadTiles-100/.test(DT.img._src),
    DT.img && DT.img._src);
check('the 11 road quads are parallelograms (T+B == R+L, <=0.5 px)',
    L.ROAD_QUADS.length === 11 && L.ROAD_QUADS.every(q => {
        const dx = Math.abs((q[0][0] + q[3][0]) - (q[1][0] + q[2][0]));
        const dy = Math.abs((q[0][1] + q[3][1]) - (q[1][1] + q[2][1]));
        return dx <= 0.5 && dy <= 0.5;
    }));
/* drift guard: the lab's ROAD_QUADS must be the exact table the viewer's
   spec/dirt quadMesh samples — one source of truth (notes/08) */
(function () {
    const vsrc = fs.readFileSync(path.join(root, 'web', 'viewer', 'city-view-pixi.js'), 'utf8');
    const m = /var ROAD_QUADS = \[[\s\S]*?\];/.exec(vsrc);
    let same = false;
    try {
        const V = new Function(m[0] + '; return ROAD_QUADS;')();
        same = JSON.stringify(V) === JSON.stringify(L.ROAD_QUADS);
    } catch (e) { same = false; }
    check('lab ROAD_QUADS == viewer ROAD_QUADS (drift guard)', same);
    check('viewer loads the same dirt sheets as the lab (drift guard)',
        vsrc.includes("assets/dlc/XMAS2017_RiverRoadTiles_LTD-100-r492453/images/dirtroadtilesheet.png") &&
        vsrc.includes("assets/dlc/WildWest_RiverRoadTiles-100-r308122/data/dirtroadtilesheet.rgb") &&
        L.DIRT_PACKS.length === 2 &&
        L.DIRT_PACKS[0][1].endsWith('WildWest_RiverRoadTiles-100-r308122/data/dirtroadtilesheet.rgb') &&
        L.DIRT_PACKS[1][1].endsWith('XMAS2017_RiverRoadTiles_LTD-100-r492453/images/dirtroadtilesheet.png'));
    /* Season alignment = engine pack-priority: landinfo names ONE static
       texture (DirtRoadTileSheet.rgb); WildWest_RiverRoadTiles is the
       permanent normal-season art and the XMAS LTD packs override it at
       Christmas. The viewer must mirror exactly that layering. */
    check('viewer mirrors engine pack-priority for the dirt sheets (winter=XMAS, else=WildWest)',
        /function dirtSheetTex\(\) \{\s*if \(SEASON\.mode === 'winter'\) return dirtReady \? dirtHiTex : \(dirtBaseReady \? dirtBaseTex : null\);\s*return dirtBaseReady \? dirtBaseTex : null;\s*\}/.test(vsrc));
    check('viewer dirt visibility keys off dirtSheetTex(), not raw dirtReady',
        !/dirtArtOn && dirtReady/.test(vsrc) &&
        /dirtArtOn && !!dirtSheetTex\(\)/.test(vsrc));
    check('viewer season toggle rebuilds the ground so the winter swap lands',
        /btn-season[\s\S]*?applySeasonMode\(\);\s*\n\s*buildGround\(\);/.test(vsrc));
    /* Decoder drift guard: the viewer's inline .rgb decode must keep the
       lab oracle's RGBA4444 core (header w/h, byte0=(B<<4)|A, byte1=(R<<4)|G,
       nibbles x17) — the pink/purple regression was a 565 read. */
    check('viewer .rgb decode keeps the lab RGBA4444 core (drift guard, no RGB565 leftovers)',
        /w = dv\.getUint16\(4, true\), h = dv\.getUint16\(6, true\)/.test(vsrc) &&
        /\(c1 >> 4\) \* 17/.test(vsrc) && /\(c0 >> 4\) \* 17/.test(vsrc) &&
        /a \* 17/.test(vsrc) && !/getUint16\(o, true\)/.test(vsrc));
})();
(function () {
    /* the .rgb decoder against the real 25-tier WildWest pack. Oracle =
       tools/extract_assets.py (_expand4444, straight alpha): 256², 47.1%
       visible, avg RGB (179,148,86). An RGB565 read of the 4444 data (the
       original bug) shows a purple-ish avg and breaks all three numbers. */
    const b = fs.readFileSync(path.join(root, 'web', 'assets', 'dlc',
        'WildWest_RiverRoadTiles-25-r308122', 'data', 'dirtroadtilesheet.rgb'));
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    const d = L.decodeRgb(ab);
    let vis = 0, sr = 0, sg = 0, sb = 0;
    for (let i = 0; i < d.w * d.h; i++) {
        if (d.data[i * 4 + 3] > 0) { vis++; sr += d.data[i * 4]; sg += d.data[i * 4 + 1]; sb += d.data[i * 4 + 2]; }
    }
    const avg = [sr / vis, sg / vis, sb / vis];
    const ok = d.w === 256 && d.h === 256 && d.data.length === 256 * 256 * 4 &&
        Math.abs(100 * vis / (256 * 256) - 47.1) < 0.5 &&
        Math.abs(avg[0] - 179) < 3 && Math.abs(avg[1] - 148) < 3 && Math.abs(avg[2] - 86) < 3 &&
        (b.readUInt8(8) & 15) * 17 === d.data[3] &&               // A from byte0 low nibble
        (b.readUInt8(9) >> 4) * 17 === d.data[0] &&               // R from byte1 high nibble
        (b.readUInt8(9) & 15) * 17 === d.data[1] &&               // G from byte1 low nibble
        (b.readUInt8(8) >> 4) * 17 === d.data[2];                 // B from byte0 high nibble
    check('decodeRgb decodes the WildWest 25-tier sheet (RGBA4444 straight, oracle vs extract_assets.py)',
        ok, d && [d.w, d.h, (100 * vis / (256 * 256)).toFixed(1), avg.map(v => v.toFixed(0)).join(',')].join('/'));
    els['d-pack'].click();
    check('d-pack button cycles to the XMAS winter-override sheet',
        /XMAS2017/.test(DT.sheet) && !!DT.img && /XMAS2017/.test(DT.img._src || ''), DT.sheet);
    els['d-pack'].click();
    check('d-pack button cycles back to the WildWest normal sheet',
        /WildWest/.test(DT.sheet) && !!DT.img && /WildWest/.test(DT.img._src || ''), DT.sheet);
})();
check('road model picks follow engStates: isolated cell closes with state 1 slabs',
    L.dPick(DT, { e: 0, w: 0, n: 0, s: 0 }, 'es') === 1 &&
    L.dPick(DT, { e: 0, w: 0, n: 0, s: 0 }, 'nw') === 1 &&
    L.dPick(DT, { e: 0, w: 0, n: 0, s: 0 }, 'ne') === 5);
check('road-model flips follow engFlip: ES always, NE for N-only, NW never',
    L.dFlip(DT, { e: 0, w: 0, n: 0, s: 0 }, 'es') === true &&
    L.dFlip(DT, { n: 1, e: 0 }, 'ne') === true && L.dFlip(DT, { n: 1, w: 1 }, 'nw') === false);
/* ---- dirt (river) tab: the SECOND view, own state — the layers are
   different drawers, so the lab gives each tab a fixed model ---- */
const DR = L.DIRTR;
check('dirt river view starts on the river model with engine-table picks',
    DR && DR.model === 'river' && DR.zoom === 2 && DR.forceAuto === true && DR.force === -1 &&
    DR.flip === false && DR.grid === true && DR.raw === false,
    DR && [DR.model, DR.zoom, DR.forceAuto, DR.force].join('/'));
check('dirt river view draws the same WildWest sheet as the dirt road view',
    !!DR.img && /WildWest_RiverRoadTiles-100/.test(DR.img._src || ''), DR.img && DR.img._src);
check('river model picks follow rivStates: isolated cell closes with state 0 banks',
    L.dPick(DR, { e: 0, w: 0, n: 0, s: 0 }, 'es') === 0 &&
    L.dPick(DR, { e: 0, w: 0, n: 0, s: 0 }, 'nw') === 0);
check('river-model flips follow rivFlip: ES always, WS for W-only',
    L.dFlip(DR, { e: 0, w: 0, n: 0, s: 0 }, 'es') === true &&
    L.dFlip(DR, { w: 1, s: 0 }, 'ws') === true && L.dFlip(DR, { w: 1, s: 1 }, 'ws') === false);
check('the two dirt views are independent: the tabs fixed-split what the model button used to swap',
    DT.model === 'road' && DR.model === 'river' && DT !== DR &&
    L.dTable(DT) === L.ROAD_QUADS && L.dTable(DR) === L.RIVER_QUADS);
L.render();
check('dirt blits warp the square with the affine UV map (road table)',
    (els['cv-dirt']._xforms || []).length > 0 &&
    els['cv-dirt']._xforms.some(x => Math.abs(x[1]) > 1e-6 && Math.abs(x[2]) > 1e-6),
    JSON.stringify((els['cv-dirt']._xforms || []).slice(0, 2)));
check('dirt canvas grew to content (sheet + 11 states + cell demos)',
    els['cv-dirt'].height > 1200, els['cv-dirt'].height);
check('last op on the dirt canvas is a draw, not a bitmap-clearing resize',
    els['cv-dirt']._lastOp === 'draw', els['cv-dirt']._lastOp);
const refD = L.formatRef();
check('reference block carries the DIRT_ART contract (both views)',
    /DIRT_ART = \{/.test(refD) && /DIRT_ART_RIVER = \{/.test(refD) && /uvTable: "0x400520"/.test(refD) &&
    /uvTable: "0x3fc320"/.test(refD) && /dirtroadtilesheet/.test(refD) &&
    /DirtRoadDrawing/.test(refD) && /DirtRiverDrawing/.test(refD) &&
    /lattice: "identical to roadrivertiles/.test(refD) && /force: -1/.test(refD),
    refD.slice(refD.indexOf('DIRT_ART')));
check('reference block lists the road view\'s 11 quads in the DIRT_ART slots block',
    (refD.slice(refD.indexOf('DIRT_ART = {'), refD.indexOf('DIRT_ART_RIVER')).match(/\/\/ \(c,r=/g) || []).length === 11,
    (refD.slice(refD.indexOf('DIRT_ART = {'), refD.indexOf('DIRT_ART_RIVER')).match(/\/\/ \(c,r=/g) || []).length);
check('reference block lists the river view\'s 11 quads in the DIRT_ART_RIVER slots block',
    (refD.slice(refD.indexOf('DIRT_ART_RIVER')).match(/\/\/ \(c,r=/g) || []).length === 11,
    (refD.slice(refD.indexOf('DIRT_ART_RIVER')).match(/\/\/ \(c,r=/g) || []).length);
els['dbtn-mask-w'].click();
check('dirt mask toggle clears W and the quadrant picks follow (nw 4 -> 1)',
    DT.mask.w === false && L.dPick(DT, L.dEffPass(DT), 'nw') === 1 &&
    els['dbtn-mask-w'].className === '', L.dPick(DT, L.dEffPass(DT), 'nw'));
els['dbtn-probe-w'].click();
check('neighbour-solid probe ORs the W edge back in (pass rule)',
    DT.probe.w === true && DT.mask.w === false &&
    L.dPick(DT, L.dEffPass(DT), 'nw') === 4 && els['dbtn-probe-w'].className === 'on',
    L.dPick(DT, L.dEffPass(DT), 'nw'));
els['dbtn-probe-w'].click(); els['dbtn-mask-w'].click();
check('dirt mask restores the E+W run', DT.mask.w === true && L.dPick(DT, L.dEffPass(DT), 'nw') === 4);
els['d-force-plus'].click();
check('dirt force stepper leaves the engine table',
    DT.forceAuto === false && DT.force === 0 && els['d-force-v'].textContent === '0');
check('forced state overrides every dirt quadrant pick',
    L.dPick(DT, L.dEffPass(DT), 'nw') === 0 && L.dPick(DT, L.dEffPass(DT), 'es') === 0);
for (let i = 0; i < 15; i++) els['d-force-plus'].click();
check('dirt force clamps at state 10', DT.force === 10, DT.force);
els['d-force-auto'].click();
check('auto returns to the road table',
    DT.forceAuto === true && L.dPick(DT, L.dEffPass(DT), 'nw') === 4);
els['d-flip'].click();
check('dirt flip toggle mirrors the sampled rect', DT.flip === true && els['d-flip'].className === 'on');
els['d-flip'].click();
els['d-zoom-plus'].click(); els['d-zoom-plus'].click();
check('dirt zoom clamps at 3', DT.zoom === 3, DT.zoom);
els['d-zoom-minus'].click(); els['d-zoom-minus'].click(); els['d-zoom-minus'].click();
check('dirt zoom clamps at 1', DT.zoom === 1, DT.zoom);
els['d-zoom-plus'].click();
els['d-raw'].click();
check('dirt raw-boxes toggle flips state', DT.raw === true);
els['d-raw'].click();
els['d-grid'].click();
check('dirt lattice toggle flips state', DT.grid === false);
els['d-grid'].click();
check('dirt toggles return to defaults',
    DT.raw === false && DT.grid === true && DT.zoom === 2 && DT.flip === false && DT.forceAuto === true);

/* ---- water tab switching ---------------------------------------------------------- */
els['tab-btn-water'].click();
check('water tab button swaps all three panes and classes',
    L.getTab() === 'tab-water' && els['tab-water'].hidden === false &&
    els['tab-sheet'].hidden === true && els['tab-tune'].hidden === true &&
    els['tab-dirt'].hidden === true && els['tab-dirt2'].hidden === true &&
    els['tab-btn-water'].className === 'on' && els['tab-btn-sheet'].className === '',
    [L.getTab(), els['tab-water'].hidden, els['tab-sheet'].hidden].join('/'));
els['tab-btn-dirt'].click();
check('dirt tab button swaps panes and classes',
    L.getTab() === 'tab-dirt' && els['tab-dirt'].hidden === false &&
    els['tab-sheet'].hidden === true && els['tab-water'].hidden === true &&
    els['tab-btn-dirt'].className === 'on' && els['tab-btn-water'].className === '',
    [L.getTab(), els['tab-dirt'].hidden, els['tab-water'].hidden].join('/'));
els['tab-btn-dirt2'].click();
check('dirt (river) tab button shows its own pane, hides the dirt road pane',
    L.getTab() === 'tab-dirt2' && els['tab-dirt2'].hidden === false &&
    els['tab-dirt'].hidden === true && els['tab-water'].hidden === true &&
    els['tab-btn-dirt2'].className === 'on' && els['tab-btn-dirt'].className === '',
    [L.getTab(), els['tab-dirt2'].hidden, els['tab-dirt'].hidden].join('/'));
/* the river view paints through the same recipe, and its controls are
   independent of the dirt road view's */
L.renderDirt(DR);
check('dirt river canvas drew and grew to content', els['cv-dirt2']._lastOp === 'draw' &&
    els['cv-dirt2'].height > 1200, els['cv-dirt2']._lastOp + '/' + els['cv-dirt2'].height);
els['dr-force-plus'].click();
check('river view force stepper is its own state (dirt road view unaffected)',
    DR.forceAuto === false && DR.force === 0 && DT.forceAuto === true &&
    els['dr-force-v'].textContent === '0' && els['d-force-v'].textContent === 'auto');
els['dr-force-auto'].click();
els['drbtn-mask-w'].click();
check('river view mask is its own state',
    DR.mask.w === false && DT.mask.w === true && L.dPick(DR, L.dEffPass(DR), 'nw') !== 4);
els['drbtn-mask-w'].click();
els['dr-pack'].click();
check('river view sheet button is its own state (dirt road view keeps WildWest)',
    /XMAS2017/.test(DR.sheet) && /WildWest/.test(DT.sheet), DR.sheet + ' | ' + DT.sheet);
els['dr-pack'].click();
check('river sheet button cycles back', /WildWest/.test(DR.sheet));
els['tab-btn-sheet'].click();
check('returning to the sheet tab hides the water pane again',
    L.getTab() === 'tab-sheet' && els['tab-water'].hidden === true &&
    els['tab-sheet'].hidden === false);
check('reference block is still one balanced literal set',
    (refW.match(/{/g) || []).length === (refW.match(/}/g) || []).length);

/* ---- inspector layout: no overlapping labels (the sections above the
   copy-reference button previously drew captions on top of each other) ---- */
function labelCollisions(labels) {
    const out = [];
    for (let i = 0; i < labels.length; i++) {
        for (let j = i + 1; j < labels.length; j++) {
            const a = labels[i], b = labels[j];
            const xOver = a.x < b.x + b.w && b.x < a.x + a.w;
            const yOver = Math.abs(a.y - b.y) < 10;
            if (xOver && yOver) {
                out.push('"' + a.t + '"@' + a.x + ',' + a.y + ' vs "' + b.t + '"@' + b.x + ',' + b.y);
            }
        }
    }
    return out;
}
const coll = labelCollisions(els['cv-art']._labels || []);
check('no overlapping labels on the sheet inspector',
    coll.length === 0, coll.slice(0, 3).join(' | '));
const collW = labelCollisions(els['cv-water']._labels || []);
check('no overlapping labels on the water inspector',
    collW.length === 0, collW.slice(0, 3).join(' | '));
const collD = labelCollisions(els['cv-dirt']._labels || []);
check('no overlapping labels on the dirt inspector',
    collD.length === 0, collD.slice(0, 3).join(' | '));

/* ---- reference block parses-ish ------------------------------------------------------ */
const ref = L.formatRef();
check('reference block is a balanced ROAD_ART literal',
    ref.startsWith('ROAD_ART = {') && ref.trim().endsWith('}') &&
    (ref.match(/{/g) || []).length === (ref.match(/}/g) || []).length);

/* ---- bridge tab: model checks -------------------------------------------------
   The drift guard re-derives the viewer's bridge pass (same extraction as
   tools/check-bridges.cjs) and fails if the lab's BRIDGE_REF table ever
   disagrees — the table is a snapshot of derive output, not a second rule. */
els['tab-btn-bridge'].click();
check('bridge tab button swaps panes and classes',
    L.getTab() === 'tab-bridge' && els['tab-bridge'].hidden === false &&
    els['tab-sheet'].hidden === true && els['tab-btn-bridge'].className === 'on',
    [L.getTab(), els['tab-bridge'].hidden].join('/'));
els['tab-btn-sheet'].click();
check('returning to the sheet tab hides the bridge pane',
    L.getTab() === 'tab-sheet' && els['tab-bridge'].hidden === true);

let drift = 'boot failed';
try {
    global.CAM = require(path.join(root, 'web', 'js', 'camera.js'));
    new Function('window', fs.readFileSync(path.join(root, 'web', 'js', 'map-explorer-data.js'), 'utf8'))(global.window);
    const T = require(path.join(root, 'web', 'js', 'terrain.js'));
    const terrain = new T.CityTerrain(global.window.MAP_DATA, {});
    const vsrc = fs.readFileSync(path.join(root, 'web', 'viewer', 'city-view-pixi.js'), 'utf8');
    const va = vsrc.indexOf('/* ---- road bridges');
    const vb = vsrc.indexOf('window.__CV_BRIDGES');
    const vslice = vsrc.slice(va, vb)
        .replace(/try \{ if \(localStorage[^\n]*\n/, '')
        .replace(/function applyBridgeMode\(\)[\s\S]*?\n    \}\n/, '');
    const drv = new Function('CityTerrain', 'terrain', 'ART',
        vslice + '\nvar segs = deriveBridges();\nreturn segs;')(
            T.CityTerrain, terrain, { S: 64 });
    const bkey = g => [g.x.toFixed(2), g.y.toFixed(2), g.mir ? 1 : 0, g.top, g.bot].join('|');
    const want = drv.map(bkey).sort().join(',');
    const have = L.BRIDGE_REF.reduce((acc, s) => acc.concat(s.segs.map(bkey)), []).sort().join(',');
    drift = want === have ? '' : 'viewer:\n  ' + want + '\nlab:\n  ' + have;
} catch (e) { drift = e.message; }
check('BRIDGE_REF matches the viewer deriveBridges() (drift guard)', drift === '', drift);

const BB = L.BRIDGE;
const vB = L.bridgeView();
const tops = L.bridgePieceRects('top');
const bots = L.bridgePieceRects('bot');
check('site A composites 4 deck pieces (2 rows x 2 road cells) and no base pieces',
    tops.length === 4 && bots.length === 0, tops.length + '/' + bots.length);
check('every bridge piece rect is finite with positive size',
    tops.every(q => isFinite(q.x) && isFinite(q.y) && q.w > 0 && q.h > 0),
    JSON.stringify(tops[0] || null));
check('piece anchors land exactly on the segment point projected by the ground affine',
    tops.every(q => {
        const s = L.BRIDGE_REF[BB.site].segs[q.seg];
        const off = BB.segOff[q.seg];
        const A = vB.A;
        return Math.abs(q.px - (A.a * (s.x + off.x) + A.b * (s.y + off.y) + A.c)) < 0.01 &&
               Math.abs(q.py - (A.d * (s.x + off.x) + A.e * (s.y + off.y) + A.f)) < 0.01;
    }),
    JSON.stringify(tops.slice(0, 2)));
check('ground affine is the canonical 2:1 oblique (hw=1, hh=0.5)',
    Math.abs(vB.A.a - vB.A.b) < 1e-9 && Math.abs(vB.A.d + vB.A.e) < 1e-9 &&
    Math.abs(vB.A.a / vB.A.e - 2) < 1e-9,
    JSON.stringify([vB.A.a, vB.A.b, vB.A.d, vB.A.e]));
check('the two rows group by constant x (west/east), 2 sections each',
    tops.slice(0, 2).every(q => q.row === tops[0].row) &&
    tops.slice(2).every(q => q.row === tops[2].row) && tops[0].row !== tops[2].row &&
    new Set(tops.map(q => q.row)).size === 2,
    tops.map(q => q.row).join(','));
check('one section per road cell: rows step 4 tiles along the deck, in phase, 4.5 apart',
    (() => {
        const site = L.BRIDGE_REF[BB.site], rows = {};
        const rk = s => (site.axis === 'y' ? s.x : s.y);
        const ak = s => (site.axis === 'y' ? s.y : s.x);
        for (const s of site.segs) (rows[rk(s)] = rows[rk(s)] || []).push(ak(s));
        const rs = Object.keys(rows).map(Number).sort((a, b) => a - b);
        const col = rows[rs[0]].sort((a, b) => a - b);
        const col2 = rows[rs[1]].sort((a, b) => a - b);
        return Math.abs(rs[1] - rs[0] - 4.5) < 0.02 &&
            Math.abs(col[1] - col[0] - 4) < 0.01 &&
            col2.every((v, i) => Math.abs(v - col[i]) < 0.01);   // in phase
    })(),
    JSON.stringify(L.BRIDGE_REF[BB.site].segs.map(s => [s.x, s.y])));
check('the near (west) row draws over the road, the far row under it',
    L.bridgePieceRects('near').length === 2 && L.bridgePieceRects('far').length === 2 &&
    L.bridgePieceRects('near').every(q => L.BRIDGE_REF[BB.site].segs[q.seg].x < 157),
    JSON.stringify(L.bridgePieceRects('near').map(q => q.seg)));
const topX0 = L.bridgePieceRects('top')[0].x;
els['bridge-row-plus'].click();
check('span nudge steps the SELECTED span by 0.05 tiles across the road',
    Math.abs(L.bridgePieceRects('top')[0].x - (topX0 + 0.05 * vB.A.a)) < 0.01,
    [topX0, L.bridgePieceRects('top')[0].x].join('/'));
els['bridge-reset'].click();
// per-span independence: select span 3 (east far), step it, only its rects move
const nSegA = L.BRIDGE_REF[BB.site].segs.length;
const segBtns = els['bridge-rows'].options.slice(-2 * nSegA);  // latest build (sel+vis per seg)
const selBtn3 = segBtns.find(o => o._role === 'sel' && o._seg === 2);
const before = L.bridgePieceRects('top').map(q => q.x);
selBtn3.click();
els['bridge-row-plus'].click();
const after = L.bridgePieceRects('top').map(q => q.x);
check('steppers move only the selected span',
    Math.abs(after[2] - (before[2] + 0.05 * vB.A.a)) < 0.01 &&
    after.every((v, i) => i === 2 || v === before[i]),
    JSON.stringify([before, after]));
check('span select button highlights the selection',
    selBtn3.className === 'on' && segBtns.filter(o => o._role === 'sel')[0].className === '',
    [selBtn3.className, segBtns[0].className].join('/'));
els['bridge-reset'].click();
check('reset returns every span offset to zero',
    BB.segOff.every(o => o.x === 0 && o.y === 0) &&
    BB.segBase.every(o => o.x === 0 && o.y === 0) && BB.segSel === 0);
const segBtns2 = els['bridge-rows'].options.slice(-2 * nSegA);
segBtns2.find(o => o._role === 'sel' && o._seg === 2).click();
// along-axis stepper: moves the selected span ALONG the road (0.05 tiles in y
// for the +y crossing)
const aTops = L.bridgePieceRects('top');
const ab0 = aTops.map(q => q.y);
els['bridge-along-plus'].click();
const aTops2 = L.bridgePieceRects('top');
check('along stepper moves the selected span along the road',
    Math.abs(aTops2[2].y - (ab0[2] + 0.05 * vB.A.e)) < 0.01 &&
    aTops2.every((q, i) => i === 2 || q.y === ab0[i]),
    [ab0[2], aTops2[2].y].join('/'));
els['bridge-reset'].click();
els['bridge-fit'].click();
check('apply export fit is a no-op while the rule carries the fit',
    Object.keys(L.BRIDGE_FIT).length === 0 && L.bridgeApplyFit() === false &&
    BB.segOff.every(o => o.x === 0 && o.y === 0) &&
    BB.segBase.every(o => o.x === 0 && o.y === 0));
/* every section is the plain deep-piered deck: the export's bank ends show
   the balustrade simply stopping at the shore (notes/09 §10) */
const gotA = L.BRIDGE_REF[BB.site].segs.map(s => s.top);
check('every section of a row is the deep-piered bridgetop_f4',
    gotA.length === 4 && gotA.every(t => t === 'bridgetop_f4'), gotA.join(','));
els['bridge-top'].click();
check('deck toggle hides every top piece',
    L.bridgePieceRects('top').length === 0);
els['bridge-top'].click();
const nSeg = L.BRIDGE_REF[BB.site].segs.length;
const nAll = L.BRIDGE_REF.reduce((n, s) => n + s.segs.length, 0);
const build = els['bridge-rows'].options.slice(-2 * nSeg);  // latest build (sel+vis per seg)
check('select + visibility button per span (rebuilt on every reset)',
    build.length === 2 * nSeg && els['bridge-rows'].options.length % (2 * nSeg) === 0 &&
    build.filter(o => o._role === 'sel').length === nSeg &&
    build.filter(o => o._role === 'vis').length === nSeg,
    els['bridge-rows'].options.length);
const vis0 = build.find(o => o._role === 'vis' && o._seg === 0);
vis0.click();
check('span visibility button drops that piece',
    L.bridgePieceRects('top').length === 3);
vis0.click();
els['bridge-site'].value = '2';
els['bridge-site'].change();
check('site B loads the mirrored +x crossing',
    BB.site === 2 && L.bridgePieceRects('top').length === 4 &&
    L.bridgePieceRects('top').every(q => q.mir === 1));
check('site B: the near (south) row draws over the road',
    L.bridgePieceRects('near').every(q => L.BRIDGE_REF[BB.site].segs[q.seg].y > 50) &&
    L.bridgePieceRects('near').length === 2);
/* the inlet: a band as narrow as the road is ONE road cell, so one section
   per row. Mirrored like every +x crossing. */
els['bridge-site'].value = String(L.BRIDGE_REF.length - 1);
els['bridge-site'].change();
check('the 4-wide inlet composites one section per row',
    BB.site === L.BRIDGE_REF.length - 1 && nAll === 14 &&
    L.bridgePieceRects('top').length === 2 &&
    L.bridgePieceRects('top').every(q => q.mir === 1 && q.name === 'bridgetop_f4') &&
    L.BRIDGE_REF[BB.site].segs.every(s => Math.abs(s.x - 252) < 0.01) &&
    new Set(L.bridgePieceRects('top').map(q => q.row)).size === 2,
    JSON.stringify(L.bridgePieceRects('top').map(q => [q.px, q.py, q.name])));
els['bridge-site'].value = '0';
els['bridge-site'].change();
check('site select returns to A and resets the steppers',
    BB.site === 0 && BB.segOff.every(o => o.x === 0 && o.y === 0));
L.renderBridge();
check('bridge canvas drew pieces (drawImage on cv-bridge)',
    els['cv-bridge']._lastOp === 'draw', els['cv-bridge']._lastOp);
check('road cells composite via the quadrant rotate/scale recipe (cell = 4x4 block)',
    (els['cv-bridge']._scales || []).some(sc => sc[0] > 0 && sc[0] < 1 && sc[1] < 0) &&
    (els['cv-bridge']._xforms || []).length > 100,
    JSON.stringify((els['cv-bridge']._scales || []).slice(0, 2)) + ' ' +
    (els['cv-bridge']._xforms || []).length);
check('bridge art loads from the shared city assets dir (../ prefix: page lives in viewer/)',
    ['bridgetop_f2', 'bridgetop_f3', 'bridgetop_f4', 'bridgetop_f5', 'bridgetop_f6',
     'bridgebottom_f0'].every(
        n => BB.imgs[n] && /^\.\.\/assets\/city\//.test(BB.imgs[n]._src)),
    Object.keys(BB.imgs).map(n => BB.imgs[n]._src).join(' '));
const collB = labelCollisions(els['cv-bridge']._labels || []);
check('no overlapping labels on the bridge inspector',
    collB.length === 0, collB.slice(0, 3).join(' | '));

/* ---------------- pier / boardwalk tab (notes/09 §12) ----------------
   The manifest loads synchronously through the fetch shim, so by boot the
   tab already has its data; drive type/water/state/zoom controls and make
   sure both the sheet pass and the tile-space previews actually paint. */
const PJ = L.getPierManifest();
check('pier tab: manifest fetched (assets/city/pier-tiles.json)',
    !!PJ && PJ.gen === 'tools/gen_pier_tiles.py' &&
    Object.keys(PJ.assets).join(',') === 'boardwalk,pier',
    PJ && Object.keys(PJ.assets).join(','));
check('pier tab: states complete per type',
    PJ && Object.keys(PJ.assets.boardwalk.states).length === 9 &&
    Object.keys(PJ.assets.pier.states).length === 5 &&
    ['Normal_None', 'Normal_PostLeft', 'Normal_PostRight',
     'Normal_PostLeftAndRight'].every(s => PJ.assets.boardwalk.states[s] &&
        PJ.assets.pier.states[s]));
check('pier tab: block lists stored in engine draw order (C_Shadow first)',
    ['Normal_None', 'Normal_PostLeft', 'Normal_PostRight',
     'Normal_PostLeftAndRight', 'Neutral'].every(
        s => PJ.assets.boardwalk.states[s][0].n === 'C_Shadow' &&
             PJ.assets.pier.states[s][0].n === 'C_Shadow'));
check('pier tab: block counts match the bsv3 frames',
    PJ.assets.boardwalk.states.Normal_None.length === 15 &&
    PJ.assets.boardwalk.states.Normal_PostLeftAndRight.length === 23 &&
    PJ.assets.pier.states.Normal_PostLeftAndRight.length === 21);
const PP = L.BW, QQ = L.PW, diP0 = drawImageCalls;
L.setTab('tab-bw');
check('boardwalk tab selects and hides the others',
    L.getTab() === 'tab-bw' && els['tab-bw'].hidden === false &&
    els['tab-sheet'].hidden === true && els['tab-pier'].hidden === true &&
    els['tab-bridge'].hidden === true,
    [L.getTab(), els['tab-bw'].hidden, els['tab-pier'].hidden].join('/'));
check('boardwalk canvas rendered on boot (sheet + previews painted)',
    els['cv-bw']._lastOp === 'draw', els['cv-bw']._lastOp);
check('pier canvas rendered on boot too (independent views, both painted)',
    els['cv-pier']._lastOp === 'draw', els['cv-pier']._lastOp);
check('boardwalk tab: own type + fixed Waterfront sheet',
    PP.type === 'boardwalk' && PP.cv === 'cv-bw' &&
    /assets\/dlc\/WaterfrontGame-100-r146180\/images\/boardwalktiles\.png$/.test(
        PJ.assets.boardwalk.sheet));
check('boardwalk tab auto-state reads its water edges',
    L.pierAutoState(PP) === 'Normal_PostLeftAndRight' &&
    L.pierFocus(PP) === 'Normal_PostLeftAndRight', L.pierFocus(PP));
els['bw-water-l'].click();
check('boardwalk water-L off drops to PostRight',
    L.pierAutoState(PP) === 'Normal_PostRight' && L.pierFocus(PP) === 'Normal_PostRight');
els['bw-water-r'].click();
check('boardwalk both edges dry -> Normal_None',
    L.pierAutoState(PP) === 'Normal_None' && L.pierFocus(PP) === 'Normal_None');
els['bw-water-l'].click(); els['bw-water-r'].click();
els['bw-force-plus'].click();
check('boardwalk state stepper forces the first state and leaves auto',
    PP.forceAuto === false && PP.force === 0 &&
    L.pierFocus(PP) === 'Normal_None' &&
    els['bw-force-auto'].className === '', els['bw-force-v'].textContent);
els['bw-force-auto'].click();
check('boardwalk auto returns', PP.forceAuto === true && els['bw-force-auto'].className === 'on');
check('boardwalk sheet zoom stepper clamps with ×-readout',
    (els['bw-zoom-plus'].click(), PP.zoom === 2 && els['bw-zoom-v'].textContent === '×1') &&
    (els['bw-zoom-minus'].click(), PP.zoom === 1 && els['bw-zoom-v'].textContent === '×0.5') &&
    (els['bw-zoom-minus'].click(), PP.zoom === 1));
els['bw-grid'].click(); els['bw-calib'].click();
check('boardwalk overlay toggles flip and repaint',
    PP.grid === false && PP.calib === false &&
    els['cv-bw']._lastOp === 'draw');
els['bw-grid'].click(); els['bw-calib'].click();
/* ---- the pier tab: same rig, own state, ornate asset ---- */
L.setTab('tab-pier');
check('pier tab selects and hides the others',
    L.getTab() === 'tab-pier' && els['tab-pier'].hidden === false &&
    els['tab-bw'].hidden === true && els['tab-sheet'].hidden === true,
    [L.getTab(), els['tab-pier'].hidden, els['tab-bw'].hidden].join('/'));
check('pier tab: own type + fixed SpringfieldHeights sheet',
    QQ.type === 'pier' && QQ.cv === 'cv-pier' && L.pierStates(QQ).length === 5 &&
    /ornatepiertiles\.png$/.test(PJ.assets.pier.sheet) &&
    /SpringfieldHeights2BuildDecoGame/.test(PJ.assets.pier.sheet));
check('the two tabs are independent (boardwalk controls never move the pier view)',
    QQ.zoom === 1 && QQ.forceAuto === true && QQ.grid === true && QQ.calib === true &&
    QQ.waterL === true && QQ.waterR === true);
els['pw-water-l'].click();
check('pier tab auto-state reads its own water edges',
    L.pierAutoState(QQ) === 'Normal_PostRight' && L.pierFocus(QQ) === 'Normal_PostRight');
els['pw-water-l'].click();
els['pw-force-plus'].click();
check('pier state stepper forces the first state and leaves auto',
    QQ.forceAuto === false && QQ.force === 0 &&
    L.pierFocus(QQ) === 'Normal_None' &&
    els['pw-force-auto'].className === '', els['pw-force-v'].textContent);
els['pw-force-auto'].click();
els['pw-zoom-plus'].click();
check('pier zoom stepper is independent of the boardwalk zoom',
    QQ.zoom === 2 && PP.zoom === 1);
els['pw-zoom-minus'].click();
check('pier overlay toggles flip without touching the boardwalk view',
    (els['pw-calib'].click(), QQ.calib === false && PP.calib === true &&
     els['cv-pier']._lastOp === 'draw') &&
    (els['pw-calib'].click(), true));
check('tile-space previews run the viewer chain: box->2:1 transform + rot45 + /4 scale',
    L.PIER_SHEET_S === Math.SQRT2 / 127 && L.PIER_SHEET_T === Math.SQRT2 / 66 &&
    (els['cv-pier']._scales || []).some(sc =>
        Math.abs(Math.abs(sc[0]) - L.PIER_SHEET_S / 4) < 1e-9 &&
        Math.abs(sc[1] - L.PIER_SHEET_T / 4) < 1e-9) &&
    (els['cv-bw']._scales || []).some(sc =>
        Math.abs(Math.abs(sc[0]) - L.PIER_SHEET_S / 4) < 1e-9),
    JSON.stringify((els['cv-pier']._scales || []).slice(0, 2)));
check('both tabs blit their sheets + every state preview',
    drawImageCalls - diP0 >= 2 + 9 + 5, String(drawImageCalls - diP0));

console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
