// Headless DOM test for the Byte Map page (web/pb-layout.html).
// Drives the real web/js/pb-layout.js in Node with a minimal DOM against
// the REAL generated dataset (web/js/pb-layout-data.js — rebuild it first
// with python3 tools/gen_pb_layout.py). Checks: header/stats render, one
// bar row with a segment per top-level field whose widths sum to ~100%,
// click-to-drill into roadsData shows its TerrainData interior (decoded
// mapData child), breadcrumb truncation, Esc up, and the details pane.
// classList is browser-strict (empty tokens THROW).
//
//   node tools/smoke-pb-layout-dom.cjs
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const FAILS = [];
function check(cond, msg) {
    if (cond) { console.log('  ok   ' + msg); }
    else { console.log('  FAIL ' + msg); FAILS.push(msg); }
}

class FakeEl {
    constructor(tag) {
        this.tagName = String(tag || 'div').toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.style = {};
        this.dataset = {};
        this.textContent = '';
        this.listeners = {};
        this._html = '';
        this._cls = new Set();
        const self = this;
        Object.defineProperty(this, 'className', {
            get() { return [...self._cls].join(' '); },
            set(v) {
                self._cls.clear();
                String(v || '').split(/\s+/).filter(Boolean)
                    .forEach(c => self._cls.add(c));
            },
        });
        this.classList = {
            add(...cs) {
                for (const c of cs) {
                    if (!c || /\s/.test(c)) {
                        throw new Error('DOMTokenList.add: empty token');
                    }
                    self._cls.add(c);
                }
            },
            remove(...cs) { cs.forEach(c => self._cls.delete(c)); },
            contains(c) { return self._cls.has(c); },
        };
    }
    get innerHTML() { return this._html; }
    set innerHTML(v) { this._html = v; if (v === '') { this.children = []; } }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    setAttribute(k, v) { (this._attrs = this._attrs || {})[k] = String(v); }
    getAttribute(k) { return (this._attrs || {})[k]; }
    getContext() {
        const self = this;
        this._ctx = this._ctx || {
            createImageData(w, h) {
                return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
            },
            putImageData(img) { self._put = (self._put || 0) + 1; self._img = img; },
        };
        return this._ctx;
    }
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
    dispatch(ev, arg) {
        (this.listeners[ev] || []).slice().forEach(fn => fn(arg || {}));
    }
    all(cls) {
        const out = [];
        (function walk(n) {
            for (const c of n.children) {
                if (c.classList.contains(cls)) { out.push(c); }
                walk(c);
            }
        })(this);
        return out;
    }
}
const byId = {};
function el(id) { return (byId[id] = byId[id] || new FakeEl('div')); }
const docListeners = {};
global.document = {
    getElementById: (id) => el(id),
    createElement: (t) => new FakeEl(t),
    addEventListener(ev, fn) { (docListeners[ev] = docListeners[ev] || []).push(fn); },
};
global.window = {};

// load generated data, then the page script
vm.runInThisContext(
    fs.readFileSync(path.join(ROOT, 'web/js/pb-layout-data.js'), 'utf8'),
    { filename: 'pb-layout-data.js' });
const D = global.window.PBLAYOUT;
if (!D) { console.log('  FAIL pb-layout-data.js missing — run gen first'); process.exit(1); }

vm.runInThisContext(
    fs.readFileSync(path.join(ROOT, 'web/js/pb-layout.js'), 'utf8'),
    { filename: 'pb-layout.js' });

console.log('== initial render ==');
check(new RegExp(D.file.replace(/\./g, '\\.')).test(el('fileinfo').textContent),
      'header names the .pb file');
check(/decoded/.test(el('statsbar').textContent) &&
      /schema-only/.test(el('statsbar').textContent),
      'stats bar shows RE-status breakdown');
const rows = el('rows').children;
check(rows.length === 1, 'one drill-down row at boot (' + rows.length + ')');
const segs = rows[0].children;
check(segs.length === D.fields,
      'one segment per top-level field (' + segs.length + '/' + D.fields + ')');
const totalW = segs.reduce((a, s, i) =>
    a + Math.max(D.root[i].size / D.size * 100, 0.15), 0);
const actualW = segs.reduce((a, s) => a + parseFloat(s.style.width), 0);
check(Math.abs(actualW - totalW) < 0.5, 'segment widths match size (with ' +
      'min-width floor): ' + actualW.toFixed(1) + ' vs ' + totalW.toFixed(1));
check(segs.every(s => s.className.split(/\s+/)
    .filter(c => c.startsWith('st-')).length === 1),
      'every segment carries exactly one RE status class');
check(segs.every(s => (s.getAttribute('data-tip') || '').includes('0x')),
      'every segment tooltip carries hex byte offsets');

console.log('== drill-down ==');
const roads = D.root.find(k => k.f === 5);
const roadsSeg = segs[D.root.indexOf(roads)];
roadsSeg.dispatch('click');
const rows2 = el('rows').children;
check(rows2.length === 2, 'drilling in added a second row (' + rows2.length + ')');
const kids = rows2[1].children;
check(kids.length === roads.kids.length,
      'interior shows the TerrainData subfields (' + kids.length + ')');
const mapDataKid = kids.find(k => (k.getAttribute('data-tip') || '')
    .startsWith('mapData ·'));
check(!!mapDataKid && mapDataKid.className.includes('st-decoded'),
      'mapData child renders as decoded');
check(/click to drill in/.test(el('pane-body').innerHTML) ||
      /field/.test(el('pane-body').innerHTML), 'details pane populated');
check(/<dt>overview<\/dt>/.test(el('pane-body').innerHTML) &&
      /Main road grid/.test(el('pane-body').innerHTML),
      'pane leads with the curated overview block');
check(/Main road grid/.test(roadsSeg.getAttribute('data-tip')) &&
      !/libscorpio/.test(roadsSeg.getAttribute('data-tip')),
      'tooltip carries the truncated overview (first clause only)');
check(/LandMessage/.test(el('crumbs').textContent) ||
      el('crumbs').children.length >= 2, 'breadcrumb shows the path');

console.log('== keyboard up ==');
(docListeners['keydown'] || []).forEach(fn => fn({ key: 'Escape' }));
check(el('rows').children.length === 1, 'Esc returns to the top level');

console.log('== terrain grid analysis ==');
const topSegs = () => el('rows').children[0].children;
const rivers = D.root.find(k => k.f === 6);
check(/RIVERS grid · .* tiles \(/.test(topSegs()[D.root.indexOf(rivers)]
    .getAttribute('data-tip')), 'riversData tooltip carries the grid summary');
topSegs()[D.root.indexOf(rivers)].dispatch('click');
let pane = el('pane-body').innerHTML;
check(/grid analysis/.test(pane) && /RIVERS/.test(pane),
      'pane renders grid analysis with terrainType');
check(/mapDataSize [\d,]+ = len ✓/.test(pane), 'pane cross-checks mapDataSize');
check(/tiles filled/.test(pane) && /non-empty chars/.test(pane),
      'pane shows tile ratio and non-empty char count');
const riverHist = (pane.match(/class="hr"/g) || []).length;
check(riverHist === rivers.det.hist.length,
      'histogram has one row per distinct char (' + riverHist + ')');
check(/empty — no tiles/.test(pane) && /1 tile @ x=/.test(pane),
      'histogram rows carry codebook meanings');
check(/first filled chars/.test(pane), 'pane lists the first filled chars');
check(/id="gc0"/.test(pane), 'pane embeds the tile-map canvas');
const cv0 = el('gc0');
check((cv0._put || 0) > 0, 'tile map painted via putImageData');
check(cv0._img && cv0._img.width === 512 && cv0._img.height === 1087,
      'rivers canvas is 512x1087 tiles (verified geometry)');
const opaque = (() => {
    let n = 0;
    const d = cv0._img.data;
    for (let i = 3; i < d.length; i += 4) { if (d[i]) { n++; } }
    return n;
})();
check(opaque === rivers.det.tiles,
      'one opaque pixel per filled tile (' + opaque + '/' + rivers.det.tiles + ')');
// the mapData child inherits the parent layer's identity
const rRow = el('rows').children[1];
const mapSeg = rRow.children.find(k => (k.getAttribute('data-tip') || '')
    .startsWith('mapData ·'));
mapSeg.dispatch('click');
pane = el('pane-body').innerHTML;
check(/grid analysis/.test(pane) && /RIVERS/.test(pane),
      'mapData child pane inherits the RIVERS layer analysis');
// the 7 overlay layers aggregate into one array-det
const rmaps = D.root.find(k => k.f === 47);
topSegs()[D.root.indexOf(rmaps)].dispatch('click');
const lmRow = el('rows').children[1];
const lmSeg = lmRow.children.find(k => (k.getAttribute('data-tip') || '')
    .startsWith('roadMapList ·'));
lmSeg.dispatch('click');
pane = el('pane-body').innerHTML;
check(new RegExp('grid layers \\(' + rmaps.kids[0].det.length + '\\)')
    .test(pane), 'overlay layer list renders one row per grid layer');
check(/DIRT_ROADS/.test(pane) && /SAND/.test(pane) && /COBBLESTONE/.test(pane),
      'overlay rows name every TerrainType layer');
check(/SandDrawing/.test(pane) && /GoldRoadDrawing/.test(pane) &&
      /LOCKED here — layer empty/.test(pane) &&
      /KrustylandSpringfieldPath/.test(pane),
      'overlay rows annotate the controlling brush + ledger state');
// landinfo SaveInfo: boardwalk/pier tiles are stored in the OCEAN grid
const ocean = D.root.find(k => k.f === 34);
check(ocean.det && /BoardwalkDrawing/.test(ocean.det.bn || '') &&
      /PierDrawing/.test(ocean.det.bn || ''),
      'ocean grid annotated as the boardwalk/pier storage grid');
check(rmaps.kids[0].det.some(x => x.tt === 10 &&
      /KrustylandSpringfieldPath/.test(x.bn || '')),
      'KLSROAD layer maps to its named brush (landinfo consumableName)');
check(/id="gct6"/.test(pane), 'each overlay layer row gets a thumbnail canvas');
const th = el('gct6');
check((th._put || 0) > 0 && th._img && th._img.width === 64,
      'overlay thumbnails painted (SAND thumb 64 px wide)');
// STATUS_TOP notes surfaced as tooltips on the top bar
const inner4 = D.root.find(k => k.f === 4);
check(/township footprint/.test(topSegs()[D.root.indexOf(inner4)]
      .getAttribute('data-tip') || ''),
      'innerLandData tooltip carries the landBlocks footprint decode');
const eclist = D.root.find(k => k.f === 16);
check(/Union-typed analytics counter ledger/.test(topSegs()[D.root.indexOf(eclist)]
      .getAttribute('data-tip') || ''),
      'eventCountListData tooltip carries the analytics-ledger decode');
check(/39 a complete-subset mirror of 35/.test((function () {
      topSegs()[D.root.indexOf(eclist)].dispatch('click');
      return el('pane-body').innerHTML;
    })()),
    'eventCountListData overview records the 35/39 subset relation');
check(/zero positional\/raster data/.test(el('pane-body').innerHTML),
      'eventCountListData overview states the no-terrain-raster finding');

// buildingData field audit (2026-10-19)
const bdata = D.root.find(k => k.f === 7);
check(!!bdata.kids && bdata.kids.length === 16 &&
      bdata.kids.every(k => k.st === 'decoded'),
      'buildingData children all render as decoded (16 fields incl. header)');
const vandal = bdata.kids.find(k => k.f === 17);
check(!!vandal && /self-tagged/.test(vandal.note || ''),
      'vandalName child note carries the self-vandalism finding');
const bskin = bdata.kids.find(k => k.f === 20);
check(!!bskin && /Decorated_Festive/.test(bskin.note || ''),
      'skin child note lists the resolved variant families');
check(/OrnatePier/.test(bdata.note || '') && /SquidportEntrance/.test(bdata.note || ''),
      'buildingData note cites the two brush-gate buildings from the road/river sweep');
// segment sweep 2026-10-19: bundle terrain patches + brush links
const b53 = D.root.find(k => k.f === 53);
check(/ABSENT from the main rasters/.test(b53.note || ''),
      'groupStorageBundle note records stashed terrain patches absent from main grids');
const inv = D.root.find(k => k.f === 13);
check(/BoardwalkDrawing x365/.test(inv.note || ''),
      'inventory note records the brush consumables still in stock');
const quest = D.root.find(k => k.f === 11);
check(/PaveParadise/.test(quest.note || '') && /RiverRun/.test(quest.note || ''),
      'questData note records the completed pavement/river brush gates');

console.log();
if (FAILS.length) { console.log(FAILS.length + ' FAILURE(S)'); process.exit(1); }
console.log('all pb-layout-dom smoke checks passed');
