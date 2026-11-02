// Headless DOM test for the map explorer page (web/map-explorer.html).
// Drives the real web/js/map-explorer.js in Node with a minimal DOM:
// boots the map (terrain + all building/character objects), then exercises
// hover -> details pane, click-to-pin + Esc, search (dim/highlight/center),
// view presets, wheel zoom clamping, drag-pan with click suppression,
// and double-click zoom. Catches the class of "page only breaks in a
// browser" runtime errors that a syntax check cannot.
//
//   node tools/smoke-map-explorer-dom.cjs
'use strict';
const path = require('path');
const ROOT = process.argv[2] || path.join(__dirname, '..', 'web');

// ---- minimal DOM -------------------------------------------------------------
class FakeEl {
    constructor(tag) {
        this.tagName = String(tag || 'div').toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.style = {};
        this.dataset = {};
        this.textContent = '';
        this.value = '';
        this.listeners = {};
        this._html = '';
        if (this.tagName === 'CANVAS') { this.width = 300; this.height = 150; }
        const self = this;
        this._cls = new Set();
        // className string and classList stay in sync (the page sets one or the other)
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
    set innerHTML(v) { this._html = v; this.children = []; }
    appendChild(c) {
        if (c && c.isFragment) {
            for (const k of c.children.slice()) { this.appendChild(k); }
            return c;
        }
        c.parentNode = this;
        this.children.push(c);
        return c;
    }
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
    dispatch(ev, arg) {
        const a = arg || {};
        if (!a.stopPropagation) { a.stopPropagation = () => {}; }
        if (!a.preventDefault) { a.preventDefault = () => {}; }
        (this.listeners[ev] || []).slice().forEach(fn => fn(a));
    }
    closest(sel) {
        const cls = sel.split(',').map(s => s.trim().replace(/^\./, ''));
        for (let n = this; n && n.classList; n = n.parentNode) {
            if (cls.some(c => n.classList.contains(c))) { return n; }
        }
        return null;
    }
    setPointerCapture() {}
    getBoundingClientRect() { return { width: 1000, height: 800, left: 0, top: 0 }; }
    // building/char divs are positioned via style left/top/width/height
    get offsetLeft() { return parseFloat(this.style.left) || 0; }
    get offsetTop() { return parseFloat(this.style.top) || 0; }
    get offsetWidth() { return parseFloat(this.style.width) || 0; }
    get offsetHeight() { return parseFloat(this.style.height) || 0; }
    getContext() {
        return {
            fillStyle: '',
            fillRect(x, y, w, h) { global.CTX_AREA += w * h; global.CTX_RECTS++; },
            clearRect() {},
            drawImage() {},
            imageSmoothingEnabled: true
        };
    }
}

global.CTX_AREA = 0;
global.CTX_RECTS = 0;
global.window = global;
const winListeners = {};
global.addEventListener = (ev, fn) => { (winListeners[ev] = winListeners[ev] || []).push(fn); };
const fireWin = (ev, arg) => (winListeners[ev] || []).slice().forEach(fn => fn(arg || {}));
let rafQueue = [];
global.requestAnimationFrame = cb => { rafQueue.push(cb); return rafQueue.length; };
const flushRaf = () => { const q = rafQueue; rafQueue = []; q.forEach(cb => cb()); };
global.cancelAnimationFrame = () => {};
global.Image = class {                 // the variant strip's atlas loader
    constructor() { this.complete = false; this.naturalWidth = 0; }
    set src(v) { this._src = v; }
    get src() { return this._src; }
};

const named = {};
['terrain', 'bwrap', 'world', 'stage', 'details', 'legend', 'statsbar',
 'search', 'matchinfo', 'btn-full', 'btn-downtown', 'btn-reset']
    .forEach(id => { named[id] = new FakeEl(id === 'terrain' ? 'canvas' : 'div'); });
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
require(path.join(ROOT, 'js/asset-variants.js'));
require(path.join(ROOT, 'js/map-explorer.js'));
flushRaf(); // boot fitAll

// ---- drive -----------------------------------------------------------------------
const tick = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(label, cond, extra) {
    if (cond) { console.log('  ok  ' + label); }
    else { failures++; console.log('  FAIL ' + label + (extra ? ' — ' + extra : '')); }
}
const D = global.window.MAP_DATA;
const bEls = named.bwrap.children.filter(e => e.classList.contains('bld'));
const cEls = named.bwrap.children.filter(e => e.classList.contains('char'));
const scaleOf = () => {
    const m = /scale\(([\d.eE+-]+)\)/.exec(String(named.world.style.transform));
    return m ? parseFloat(m[1]) : null;
};
// same haystack map-explorer.js builds for search
const hayOf = i => {
    const e = D.binfo[D.buildings[i][0]];
    return e ? (e[0] + ' ' + (e[1] || '') + ' ' + (e[2] || '')).toLowerCase() : '';
};

(async () => {
    console.log('layout:');
    check('all buildings rendered as hoverable divs',
        bEls.length === D.buildings.length, bEls.length + '/' + D.buildings.length);
    check('all characters rendered as hoverable dots',
        cEls.length === D.chars.length, cEls.length + '/' + D.chars.length);
    check('terrain drawn (canvas fillRect area > 0)', global.CTX_AREA > 0,
        global.CTX_RECTS + ' rects');
    check('world sized to the town crop',
        named.world.style.width === D.gw + 'px' && named.world.style.height === D.gh + 'px',
        named.world.style.width + 'x' + named.world.style.height);
    check('statsbar has the save counts',
        String(named.statsbar.innerHTML).replace(/,/g, '').indexOf('5261') >= 0,
        named.statsbar.innerHTML);
    check('legend lists terrain layers + palette note',
        ['klsroad', 'mono rail', 'id mod 10'].every(s =>
            String(named.legend.innerHTML).indexOf(s) >= 0));
    check('fit-all view applied a transform',
        String(named.world.style.transform).indexOf('scale(') >= 0,
        named.world.style.transform);
    check('data-tip on every object (project tooltip convention)',
        bEls.concat(cEls).every(e => e.dataset.tip && e.dataset.tip.length > 5));
    check('no title attributes used',
        bEls.concat(cEls).every(e => e.title === undefined));

    console.log('hover -> details pane:');
    const simpson = bEls.find(e => e.dataset.tip.indexOf('SimpsonHome') >= 0);
    check('SimpsonHome object present', !!simpson);
    named.bwrap.dispatch('mouseover', { target: simpson });
    check('details show name + asset + footprint fields',
        ['SimpsonHome', 'SimpsonsHouse', 'simpsonshouse', 'footprint',
         'resolved via'].every(s => String(named.details.innerHTML).indexOf(s) >= 0),
        String(named.details.innerHTML).slice(0, 120));
    const homerC = cEls.find(e => D.chars[+e.dataset.ci][0] === 3); // char id 3 = Homer
    check('Homer character object present', !!homerC);
    if (homerC) {
        named.bwrap.dispatch('mouseover', { target: homerC });
        check('character details show name + position',
            ['Homer', '<b>#3</b>', 'position'].every(s =>
                String(named.details.innerHTML).indexOf(s) >= 0));
    }
    named.bwrap.dispatch('mouseleave', {});
    check('mouse-out restores placeholder',
        String(named.details.innerHTML).indexOf('Hover a building') >= 0);

    console.log('sprite variants strip (Tree01):');
    const treeI = D.buildings.findIndex(b =>
        (D.binfo[b[0]] || [])[2] === 'tree01');
    check('save contains a tree01 building', treeI >= 0);
    const treeEl = bEls[treeI];
    named.bwrap.dispatch('mouseover', { target: treeEl });
    const vbox = named.details.children.find(e => e.classList.contains('variants'));
    check('tree01 details append a variants strip', !!vbox);
    if (vbox) {
        const vrow = vbox.children.find(e => e.classList.contains('vrow'));
        const kinds = (D.variants.tree01 || []).map(v => v.kind);
        check('strip lists one tile per variant kind (' + kinds.join(',') + ')',
            vrow && vrow.children.length === kinds.length,
            vrow ? vrow.children.length + '/' + kinds.length : 'no vrow');
        check('variant tiles are checkerboard pics with lazy imgs',
            vrow && vrow.children.every(t => {
                const pic = t.children.find(c => c.classList.contains('vpic'));
                const img = pic && pic.children[0];
                return pic && img && img.tagName === 'IMG' &&
                    img.loading === 'lazy' && /^assets\//.test(img.src);
            }));
        check('variant tiles deep-link into the Asset Explorer',
            vrow && vrow.children.every(t =>
                t.tagName === 'A' &&
                t.href.indexOf('assets-explorer.php?path=') === 0));
        check('variant tiles use data-tip (no title attr)',
            vrow && vrow.children.every(t => t.dataset.tip && t.title === undefined) &&
            vrow.children.some(t => t.dataset.tip.indexOf('transimage') >= 0));
    }
    check('character hover shows no variants strip', (() => {
        named.bwrap.dispatch('mouseover', { target: cEls[0] });
        const had = named.details.children.some(e => e.classList.contains('variants'));
        named.bwrap.dispatch('mouseleave', {});
        return !had;
    })());

    console.log('bsv3 animation tile (GolfCourseFountain):');
    const animI = D.buildings.findIndex(b =>
        (D.variants[(D.binfo[b[0]] || [])[2]] || []).some(v => v.kind === 'anim'));
    check('save places an asset with a bsv3 animation', animI >= 0,
        Object.keys(D.variants).filter(s =>
            D.variants[s].some(v => v.kind === 'anim')).length + ' animated slugs');
    if (animI >= 0) {
        named.bwrap.dispatch('mouseover', { target: bEls[animI] });
        flushRaf();                                   // start the player loop
        const vrow2 = named.details.children
            .find(e => e.classList.contains('variants'))
            ?.children.find(e => e.classList.contains('vrow'));
        const atile = vrow2 && vrow2.children.find(
            e => e.classList.contains('anim'));
        check('animation tile renders with a canvas + controls', !!atile,
            'row children=' + (vrow2 ? vrow2.children.length : 'none'));
        if (atile) {
            const cv = atile.children.find(c => c.tagName === 'CANVAS');
            const arow = (D.variants[(D.binfo[D.buildings[animI][0]] || [])[2]] || [])
                .find(v => v.kind === 'anim');
            check('canvas is cell-sized (capped)', !!cv &&
                cv.width <= 160 && cv.height <= 140 && cv.width > 0,
                cv && (cv.width + 'x' + cv.height));
            const bar = atile.children.find(c => c.classList.contains('vbar'));
            check('player has play + speed buttons', !!bar &&
                bar.children.length === 2 &&
                bar.children[0].textContent === '\u23f8');
            atile.dispatch('click', {});               // pause via tile click
            check('tile click toggles play/pause',
                bar.children[0].textContent === '\u25b6');
            atile.dispatch('click', {});               // resume
            bar.children[1].dispatch('click', {});     // speed button
            check('speed button cycles 1x -> 2x',
                bar.children[1].textContent.indexOf('2\u00d7') >= 0,
                bar.children[1].textContent);
            check('animation frames/cell metadata present',
                arow.frames >= 2 && arow.cols >= 1 && arow.cellw > 0 &&
                /^city\/anims\//.test(arow.path), JSON.stringify(arow));
        }
    }

    console.log('pin + Esc:');
    named.stage.dispatch('click', { target: simpson });
    check('click pins (sel class + pinnote)',
        simpson.classList.contains('sel') &&
        String(named.details.innerHTML).indexOf('Pinned') >= 0);
    named.bwrap.dispatch('mouseleave', {});
    check('pinned item survives mouse-out',
        String(named.details.innerHTML).indexOf('SimpsonHome') >= 0);
    fireWin('keydown', { key: 'Escape', preventDefault() {} });
    check('Esc unpins',
        !simpson.classList.contains('sel') &&
        String(named.details.innerHTML).indexOf('Hover a building') >= 0);

    console.log('search:');
    const q = 'spookywall';
    const nSpooky = D.buildings.reduce(
        (n, b, i) => n + (String(b[0]) === q || hayOf(i).includes(q) ? 1 : 0), 0);
    check('save actually contains spookywall instances', nSpooky > 0, nSpooky);
    named.search.value = q;
    named.search.dispatch('input', {});
    await tick(160);
    const hl = named.bwrap.children.filter(e => e.classList.contains('hl'));
    check('search highlights exactly the matching instances',
        hl.length === nSpooky, hl.length + '/' + nSpooky);
    check('others dimmed + match count shown',
        named.bwrap.classList.contains('dimmed') &&
        String(named.matchinfo.textContent).indexOf('match') >= 0,
        named.matchinfo.textContent);
    const t0 = String(named.world.style.transform);
    named.search.dispatch('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {} });
    check('Enter centers first match (view changed, zoomed in)',
        String(named.world.style.transform) !== t0 && scaleOf() > 1.2,
        named.world.style.transform + ' s=' + scaleOf());
    named.search.value = '';
    named.search.dispatch('input', {});
    await tick(160);
    check('clearing search restores',
        !named.bwrap.classList.contains('dimmed') && named.matchinfo.textContent === '');

    console.log('view presets + zoom:');
    named['btn-full'].dispatch('click', {});
    const sFull = scaleOf();
    named['btn-downtown'].dispatch('click', {});
    const sDowntown = scaleOf();
    check('downtown preset zooms in', sDowntown > sFull * 1.5,
        'full=' + sFull + ' downtown=' + sDowntown);
    named['btn-full'].dispatch('click', {});
    check('full-town preset back out', scaleOf() < sDowntown, scaleOf());
    for (let i = 0; i < 5; i++) {
        named.stage.dispatch('wheel',
            { clientX: 500, clientY: 400, deltaY: -240, preventDefault() {} });
    }
    check('wheel zooms in', scaleOf() > sFull, scaleOf());
    for (let i = 0; i < 60; i++) {
        named.stage.dispatch('wheel',
            { clientX: 500, clientY: 400, deltaY: 240, preventDefault() {} });
    }
    check('zoom clamps at S_MIN', scaleOf() <= 0.2001 && scaleOf() >= 0.1999, scaleOf());
    const sBeforeDbl = scaleOf();
    named.stage.dispatch('dblclick', { clientX: 500, clientY: 400 });
    check('double-click zooms in', scaleOf() > sBeforeDbl, scaleOf());

    console.log('drag-pan + click suppression:');
    const tBefore = String(named.world.style.transform);
    named.stage.dispatch('pointerdown', { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    named.stage.dispatch('pointermove', { clientX: 160, clientY: 140 });
    named.stage.dispatch('pointermove', { clientX: 200, clientY: 160 });
    check('drag pans the world',
        named.world.style.transform !== tBefore &&
        named.stage.classList.contains('panning'), named.world.style.transform);
    named.stage.dispatch('pointerup', {});
    named.stage.dispatch('click', { target: named.bwrap });
    check('click after drag does not select',
        !named.bwrap.children.some(e => e.classList.contains('sel')));
    const tArr = String(named.world.style.transform);
    fireWin('keydown', { key: 'ArrowRight', preventDefault() {} });
    check('arrow keys nudge the view',
        named.world.style.transform !== tArr, named.world.style.transform);

    console.log('fence/track per-instance dims in data:');
    const t0v = D.buildings.find(b => b[0] === 109500 && b[5] === 0);
    const t1v = D.buildings.find(b => b[0] === 109500 && b[5] === 1);
    check('StraightTrack fs0 = 4x2, fs1 = 2x4 (flipped asset)',
        t0v && t1v && t0v[3] === 4 && t0v[4] === 2 && t1v[3] === 2 && t1v[4] === 4,
        JSON.stringify([t0v, t1v]));
    const nTrack = D.buildings.filter(b => D.tracks.includes(b[0])).length;
    check('track instances coloured as tracks',
        bEls.filter(e => e.classList.contains('track')).length === nTrack,
        'el=' + bEls.filter(e => e.classList.contains('track')).length + ' data=' + nTrack);

    console.log('legend layer toggles:');
    const legendClick = key => {
        const r = new FakeEl('span');
        r.className = 'row';
        r.dataset.key = key;
        r.dataset.label = key;
        named.legend.dispatch('click', { target: r, stopPropagation() {} });
        return r;
    };
    // terrain redraws: hiding a layer must paint strictly fewer rects/area
    const rectsBefore = global.CTX_RECTS;
    const rOceanOff = legendClick('ocean');               // hide
    const rectsOceanOff = global.CTX_RECTS - rectsBefore;
    const rectsMid = global.CTX_RECTS;
    const rOceanOn = legendClick('ocean');                // show
    const rectsOceanOn = global.CTX_RECTS - rectsMid;
    check('terrain layer toggle redraws with fewer tiles when hidden',
        rectsOceanOff < rectsOceanOn, 'off=' + rectsOceanOff + ' on=' + rectsOceanOn);
    check('legend row tracks off class',
        rOceanOff.classList.contains('off') && !rOceanOn.classList.contains('off'));
    const areaBefore = global.CTX_AREA;
    legendClick('grass');                                 // hide
    const areaGrassOff = global.CTX_AREA - areaBefore;
    const areaMid = global.CTX_AREA;
    legendClick('grass');                                 // show
    const areaGrassOn = global.CTX_AREA - areaMid;
    check('grass toggle drops the full-canvas base fill',
        areaGrassOff < areaGrassOn, 'off=' + areaGrassOff + ' on=' + areaGrassOn);
    const nBld = bEls.length - nTrack;
    legendClick('bld');
    check('buildings toggle hides every non-track block',
        bEls.filter(e => e.classList.contains('eloff')).length === nBld &&
        !bEls.some(e => e.classList.contains('track') && e.classList.contains('eloff')),
        'off=' + bEls.filter(e => e.classList.contains('eloff')).length + '/' + nBld);
    legendClick('bld');
    check('buildings toggle back restores all blocks',
        !bEls.some(e => e.classList.contains('eloff')));
    legendClick('track');
    check('mono rail toggle hides exactly the track blocks',
        bEls.every(e =>
            e.classList.contains('eloff') === (e.classList.contains('track'))),
        'off=' + bEls.filter(e => e.classList.contains('eloff')).length + '/' + nTrack);
    legendClick('track');
    legendClick('chars');
    check('characters toggle hides every character dot',
        cEls.every(e => e.classList.contains('eloff')));
    named.search.value = 'barney';                        // chars-only matches
    named.search.dispatch('input', {});
    await tick(160);
    check('hidden characters are excluded from search matches',
        String(named.matchinfo.textContent).indexOf('0 match') === 0,
        named.matchinfo.textContent);
    named.search.value = '';
    named.search.dispatch('input', {});
    await tick(160);
    legendClick('chars');
    check('characters toggle back restores all dots',
        !cEls.some(e => e.classList.contains('eloff')));
    const trackPin = bEls.find(e => e.classList.contains('track'));
    named.stage.dispatch('pointerdown', { button: 0, clientX: 5, clientY: 5, pointerId: 1 });
    named.stage.dispatch('pointerup', {});                // click without drag
    named.stage.dispatch('click', { target: trackPin });
    check('track instance pinned first', trackPin.classList.contains('sel'));
    legendClick('track');
    check('hiding a layer unpins an element on it',
        !trackPin.classList.contains('sel') &&
        String(named.details.innerHTML).indexOf('Hover a building') >= 0);
    legendClick('track');

    console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL CHECKS PASSED');
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
