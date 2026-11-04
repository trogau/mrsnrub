// Behaviour smoke for char-variants-pixi.js tile players (dynamic sheets +
// pre-baked fallback). Stubs just enough DOM/Image/fetch to run fill()/tile()
// and asserts the boot draw's drawImage geometry against the manifest by
// hand (playback timing itself mirrors charFrameIdx, covered map-side).
// Usage: node tools/smoke-char-panel.cjs
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.join(__dirname, '..');

function mkEl(tag) {
    const e = {
        tag, children: [], style: {}, dataset: {}, attrs: {}, _text: '',
        className: '', isConnected: true, width: 0, height: 0,
        classList: { _s: {},
                     add(c) { this._s[c] = 1; },
                     remove(c) { delete this._s[c]; },
                     toggle(c, on) { if (on) this._s[c] = 1; else delete this._s[c]; },
                     contains(c) { return !!this._s[c]; } },
        appendChild(c) { this.children.push(c); return c; },
        addEventListener(ev, fn) { (this._ev = this._ev || {})[ev] = fn; },
        setAttribute(k, v) { this.attrs[k] = v; },
        getAttribute(k) { return this.attrs[k]; },
        querySelectorAll(sel) {           // syncPreview only
            const out = [];
            (function walk(n) {
                if (n.className && String(n.className).includes('vtile canim')) out.push(n);
                (n.children || []).forEach(walk);
            })(e);
            return out;
        },
        set textContent(v) { this._text = v; if (v === '') this.children = []; },
        get textContent() { return this._text; },
        getContext() { return this._ctx = this._ctx || {
            draws: [], clears: 0, imageSmoothingEnabled: true,
            clearRect() { this.clears++; },
            drawImage() { this.draws.push(Array.from(arguments).map(Number)); },
        }; },
    };
    return e;
}

const draws = [];                                    // all ctx.drawImage calls
function freshImg() {
    return class Image {
        constructor() { this.complete = false; this.naturalWidth = 0; }
        set src(u) { this._src = u; Image.requested.push(u);
            if (Image.autoLoad) { this.complete = true; this.naturalWidth = 40;
                if (this.onload) this.onload(); } }
        get src() { return this._src; }
    };
}

const MAN = {   // hand-computed below
    name: 'x_test_cell', type: 'bcell13',
    sheet: { w: 38, h: 30 },
    images: [
        { src: 'a', w: 20, h: 30, x: 0, y: 0 },
        { src: 'b', w: 18, h: 28, x: 20, y: 0 },
    ],
    frames: [
        { i: 0, image: 0, delay_ms: 100, x_off: 10, y_off: -5 },
        { i: 1, image: 1, delay_ms: 200, x_off: -4, y_off: 0 },
    ],
    total_delay_ms: 300,
};
const CELL = {
    key: 'xtestcell', stem: 'x_test_cell', png: 'xtestcell.png',
    w: 20, h: 30, anchor: [10, 30], kind: 'action', outfit: '', dir: '',
    ms: 300,
    frames: [{ file: 'xtestcell.png', delay: 100 },
             { file: 'xtestcell_1.png', delay: 200 }],
};

function boot(dynFor, cells) {
    const img = freshImg(); img.requested = []; img.autoLoad = true;
    const sandbox = {
        document: { createElement: mkEl },
        Image: img,
        requestAnimationFrame: () => 1,
        cancelAnimationFrame: () => {},
        fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(
            { cid: '9', name: 'Test', cells: cells || [CELL] }) }),
        console, setTimeout,
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    const src = fs.readFileSync(path.join(ROOT, 'web/viewer/char-variants-pixi.js'), 'utf8');
    vm.runInContext(src, sandbox, { filename: 'char-variants-pixi.js' });
    const box = sandbox.CharVariants.render('9', 'Test',
        { onPreview: () => {}, dynFor: dynFor });
    return new Promise(r => setTimeout(() => r({ box, img }), 30));
}

let fails = 0;
function check(cond, label) {
    console.log((cond ? 'ok   ' : 'FAIL ') + label);
    if (!cond) fails++;
}

(async () => {
    // ---- dynamic mode -----------------------------------------------------
    let { box, img } = await boot(() => ({ st: 1, man: MAN, url: 'SHEETURL' }));
    check(img.requested.includes('SHEETURL'), 'dynamic: tile fetched the sheet');
    const tile = box.querySelectorAll('.vtile canim')[0];
    const cv = tile.children.find(c => c.tag === 'canvas');
    check(cv.width === 34 && cv.height === 33,
          `dynamic: canvas = union bbox 34x33 (got ${cv.width}x${cv.height})`);
    // draw() already ran once at boot with p.i=0 → frame 0 slice:
    const d = cv._ctx.draws;
    const f0 = d.find(a => a[1] === 0 && a[2] === 0 && a[3] === 20 && a[4] === 30
                          && a[5] === 14 && a[6] === 0 && a[7] === 20 && a[8] === 30);
    check(!!f0, 'dynamic: frame 0 drawn as sheet rect (0,0,20,30) -> (14,0,20,30)');
    check(!img.requested.some(u => /^..\//.test(u) && /assets\/characters\/xtestcell/.test(u)),
          'dynamic: per-frame pre-baked PNGs not fetched when sheet serves');

    // ---- pre-baked fallback ------------------------------------------------
    ({ box, img } = await boot(() => ({ st: 0 })));          // still loading
    const tile2 = box.querySelectorAll('.vtile canim')[0];
    const cv2 = tile2.children.find(c => c.tag === 'canvas');
    check(cv2.width === 20 && cv2.height === 30,
          `fallback: canvas stays cell-sized ${cv2.width}x${cv2.height}`);
    check(img.requested.some(u => /assets\/characters\/xtestcell\.png$/.test(u)),
          'fallback: pre-baked frame PNG requested while manifest loads');
    const d2 = cv2._ctx.draws;
    check(d2.length >= 1 && d2[0][1] === 0 && d2[0][3] === 20 && d2[0][4] === 30,
          'fallback: pre-baked image drawn to fill canvas');

    // ---- dead dynamic -> fallback + red flag --------------------------------
    ({ box, img } = await boot(() => ({ st: -1, err: 'missing companion' })));
    const tile3 = box.querySelectorAll('.vtile canim')[0];
    check(img.requested.some(u => /assets\/characters\/xtestcell/.test(u)),
          'dead cell (st=-1): pre-baked art still plays');
    check(tile3.classList.contains('cdead'),
          'dead cell (st=-1): tile flagged red for triage');

    // ---- healthy dynamic -> no red flag --------------------------------------
    ({ box } = await boot(() => ({ st: 1, man: MAN, url: 'SHEETURL' })));
    check(!box.querySelectorAll('.vtile canim')[0].classList.contains('cdead'),
          'live cell: no red flag');

    console.log('the tile budget is shared between the groups:');
    /* Homer's real shape: 194 walks and 247 actions against a 150-tile card.
       A head slice let the first group to fill eat the whole card, which is
       how the correctly-labelled walks pushed the actions off it — every
       group a character has has to be reachable. */
    const FAT = [];
    const fat = { idle: 56, walk: 194, action: 247, standby: 47 };
    Object.keys(fat).forEach(k => {
        for (let n = 0; n < fat[k]; n++)
            FAT.push(Object.assign({}, CELL, {
                key: k + n, stem: k + '_' + n, kind: k,
                dir: k === 'walk' ? (n % 2 ? 'front' : 'back') : '' }));
    });
    const big = await boot(undefined, FAT);
    /* the fake DOM's querySelectorAll is a stub for syncPreview only, so the
       card is read off box.children the way fill() laid it out */
    const kids = big.box.children;
    const heads = kids.filter(n => n.className === 'vgroup')
                      .map(n => String(n.textContent));
    check(['idle / blinks', 'walks', 'actions', 'poses']
              .every(t => heads.some(h => h.indexOf(t) === 0)),
          'all four groups the character has get a heading: ' + heads.join(' | '));
    const per = {};
    let cur = null;
    kids.forEach(n => {
        if (n.className === 'vgroup') { cur = String(n.textContent).split(' ')[0]; per[cur] = per[cur] || 0; }
        else if (n.className === 'vrow' && cur)
            per[cur] = (per[cur] || 0) + n.querySelectorAll('.vtile').length;
    });
    check(Object.keys(per).length === 4 &&
          Object.keys(per).every(k => per[k] > 0),
          'and every one of them gets tiles (none starved out): ' +
          JSON.stringify(per));
    const dim = kids.filter(n => n.className === 'vdim')
                    .map(n => String(n.textContent)).join(' ');
    check(Object.keys(per).reduce((s, k) => s + per[k], 0) <= 150 &&
          /of 544 animated cells/.test(dim),
          'the card stays inside the cap and says so: ' + JSON.stringify(per) +
          ' — ' + dim);

    console.log('FAILURES: %d', fails);
    process.exit(fails ? 1 : 0);
})();
