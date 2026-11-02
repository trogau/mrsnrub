// Headless smoke test for the spec viewer (web/viewer/spec-view.{html,js}).
// Boots the page script under a minimal DOM/canvas shim and checks that
// the ground-truth grid renders completely: every one of the spec's
// 1,647 non-empty cells takes a draw pass, the embedded data file matches
// road-spec.json row-for-row, and the camera fits the road bbox at boot.
//
//   node tools/smoke-spec-view.cjs
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

let failures = 0;
function check(name, cond, info) {
    if (cond) { console.log('  ok  ' + name); }
    else { failures++; console.log('FAIL  ' + name + (info !== undefined ? '  [' + info + ']' : '')); }
}

/* ---- minimal DOM/canvas shim ------------------------------------------------- */
const calls = { fill: 0, dotFillRect: 0, fillText: 0, stroke: 0 };
const styles = new Set();
const hist = [];                                  // fillStyle per fill(), in order
function ctxStub() {
    return {
        setTransform() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
        arc() {}, stroke() { calls.stroke++; },
        fill() {
            calls.fill++;
            if (this.fillStyle) { styles.add(this.fillStyle); hist.push(this.fillStyle); }
        },
        fillText() { calls.fillText++; },
        fillRect(x, y, w, h) {
            if (w === 2 && h === 2) calls.dotFillRect++;   // sub-pixel cell dot
        },
        fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', font: '',
        textAlign: '', textBaseline: ''
    };
}
function el() {
    return {
        style: {}, classList: { add() {}, remove() {} }, value: '', checked: false,
        textContent: '', innerHTML: '',
        addEventListener() {}, setPointerCapture() {},
        getBoundingClientRect() { return { left: 0, top: 0 }; },
        clientWidth: 1280, clientHeight: 800, width: 0, height: 0,
        getContext() { return ctxStub(); }
    };
}
const els = {};
global.document = { getElementById: id => (els[id] || (els[id] = el())) };
global.window = { devicePixelRatio: 1, addEventListener() {} };
let frameFn = null, t = 0;
global.requestAnimationFrame = f => { frameFn = f; };
global.performance = { now: () => t };
global.CAM = require(path.join(root, 'web', 'js', 'camera.js'));
function step(n) {                          // drive n frames of the rAF loop
    for (let i = 0; i < (n || 1); i++) {
        const f = frameFn; frameFn = null; t += 16;
        if (f) f(t);
    }
}

/* ---- boot the page script ----------------------------------------------------- */
eval(fs.readFileSync(path.join(root, 'web', 'viewer', 'spec-view-data.js'), 'utf8'));
eval(fs.readFileSync(path.join(root, 'web', 'viewer', 'spec-view.js'), 'utf8'));

console.log('spec viewer (web/viewer/spec-view.html):');
const V = global.window.__SPEC_view;
check('page script boots (window.__SPEC_view)', !!V);
const S = V && V.spec;
check('embedded grid is the spec grid (148x236, calibrated origin 0,-112, stride 37)',
    S && S.cols === 148 && S.rows === 236 && S.cell_ox === 0 &&
    S.cell_oy === -112 && S.cell_stride === 37,
    S && [S.cols, S.rows, S.cell_ox, S.cell_oy, S.cell_stride].join('/'));

/* ground truth straight from road-spec.json (the data file must match) */
const spec = JSON.parse(fs.readFileSync(path.join(root, 'road-spec.json'), 'utf8'));
const truth = spec.road_data.grid_rows_ascii.map(r => r.padEnd(148, 'G'));
check('grid matches road-spec.json row-for-row (after truncation re-pad)',
    S && truth.every((r, i) => S.grid[i] === r));
let n = 0;
for (const r of truth) for (const c of r) if (c !== 'G') n++;
check('non-empty cell count is the spec total (1,647)', n === 1647, n);

/* ---- render pass after the boot Fit -------------------------------------------- */
check('boot Fit frames the road bbox (finite zoom)',
    V && isFinite(V.cam.zoom) && V.cam.zoom > 0, V && V.cam.zoom);
step();
check('the whole spec network is visible at Fit (all 1,647 cells drawn)',
    calls.fill + calls.dotFillRect >= 1647,
    calls.fill + ' fills + ' + calls.dotFillRect + ' dots');
/* chars appear once cells are big enough (labels have a >20px gate) */
if (V) {
    outer:
    for (let r = 0; r < S.rows; r++)
        for (let c = 0; c < S.cols; c++)
            if (S.grid[r][c] !== 'G') {
                const w = CAM.tileToWorld(S.cell_ox + 4 * c + 2, S.cell_oy + 4 * r + 2);
                V.cam.x = w.x; V.cam.y = w.y; V.cam.zoom = 3;
                break outer;
            }
    V.redraw();
    step();
    check('cell chars are labelled once cells are big enough',
        calls.fillText > 0, calls.fillText);

    /* presentation model at zoom where the 4x4 sub-tiles resolve */
    function centerOn(ch) {
        outer:
        for (let r = 0; r < S.rows; r++)
            for (let c = 0; c < S.cols; c++)
                if (S.grid[r][c] === ch) {
                    const w = CAM.tileToWorld(S.cell_ox + 4 * c + 2, S.cell_oy + 4 * r + 2);
                    V.cam.x = w.x; V.cam.y = w.y; V.cam.zoom = 3;
                    return true;
                }
        return false;
    }
    const mark = () => (styles.clear(), hist.length = 0, new Set());
    if (centerOn('d')) {
        mark();
        V.redraw(); step();
        const added = [...styles];
        check('nibble road cell paints footpath base + asphalt carriageway',
            added.includes('#9c9ca3') && added.includes('#5c5c62'),
            added.join(','));
        /* road-lab tuned 2026-10-25: footpath base, then exactly core +
         * one 0.75-wide strip per connected edge ('d' = E+W -> 3 asphalt
         * quads) before the fill sequence moves on */
        let ok = false;
        for (let i = 0; i + 3 < hist.length; i++)
            if (hist[i] === '#9c9ca3' && hist[i + 1] === '#5c5c62' &&
                hist[i + 2] === '#5c5c62' && hist[i + 3] === '#5c5c62' &&
                hist[i + 4] !== '#5c5c62') { ok = true; break; }
        check("'d' cell composes footpath + 2.5-tile core + 2 edge stubs", ok,
            hist.slice(0, 12).join(','));
    }
    if (centerOn('P')) {
        mark();
        V.redraw(); step();
        const added = [...styles];
        check("'P' cell paints uniform pavement grey (no footpath/kerb)",
            added.includes('#7e7e85') && !added.includes('#9c9ca3'),
            added.join(','));
    }
}

/* culling: park the camera far off-map — the next frame draws (almost) nothing */
if (V) {
    V.cam.x += 5e6; V.cam.y += 5e6;
    const before = calls.fill + calls.dotFillRect;
    V.redraw();
    step();
    check('off-map camera culls the cell pass (<10 cells drawn)',
        calls.fill + calls.dotFillRect - before < 10,
        calls.fill + calls.dotFillRect - before);
    V.fit();
    step();
    check('Fit again brings the whole network back',
        calls.fill + calls.dotFillRect - before >= 1647,
        calls.fill + calls.dotFillRect - before);
}

console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
