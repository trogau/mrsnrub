/* smoke-calib.cjs — static checks for tools/calib-pick.html (no browser):
   1. the inline <script> parses;
   2. both calibration PNGs referenced by the page exist on disk;
   3. the coordinate transforms in the page cannot silently drift from
      tools/calib-images.py (S / XLO / px-per-tile constants are pinned). */
'use strict';
const fs = require('fs');
const path = require('path');

let failures = 0;
function check(name, ok, extra) {
    console.log((ok ? '  ok  ' : '  FAIL ') + name + (ok || extra === undefined ? '' : '  ' + extra));
    if (!ok) failures++;
}

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(__dirname, 'calib-pick.html'), 'utf8');
const py = fs.readFileSync(path.join(__dirname, 'calib-images.py'), 'utf8');

console.log('calib-pick.html:');

// 1. inline script parses
const m = html.match(/<script>([\s\S]*?)<\/script>/);
check('has one inline script', !!m);
if (m) {
    let parsed = true, err = '';
    try { new Function(m[1]); } catch (e) { parsed = false; err = String(e); }
    check('inline script parses', parsed, err);
}

// 2. referenced images exist (relative to tools/)
const srcs = [...html.matchAll(/<img[^>]*src="([^"]+)"/g)].map(x => x[1]);
check('references both calib images',
    srcs.some(s => s.endsWith('calib-export.png')) &&
    srcs.some(s => s.endsWith('calib-world.png')), srcs.join(','));
for (const s of srcs) {
    const p = path.join(__dirname, s);
    check('image exists: ' + s, fs.existsSync(p), p);
}
// 2b. freshness: the PNGs must be regenerated whenever calib-images.py
// changes (pins/labels/transforms live there; a stale image silently
// hands the user an outdated world).
const pyMtime = fs.statSync(path.join(__dirname, 'calib-images.py')).mtimeMs;
for (const s of srcs) {
    const p = path.join(__dirname, s);
    if (!fs.existsSync(p)) continue;
    check('generated after calib-images.py: ' + path.basename(s),
        fs.statSync(p).mtimeMs >= pyMtime - 1000);
}

// 3. transforms pinned to calib-images.py
const pyS = /(^|\n)S = (\d+)/m.exec(py);
const pyXLO = /XLO, XHI, GW, GH = (-?\d+), (\d+), (\d+), (\d+)/.exec(py);
const pyPX = /PX = lambda x: \(x - XLO\) \* (\d+)/.exec(py);
check('python side exposes S/XLO/PX', !!pyS && !!pyXLO && !!pyPX);
if (pyS && pyXLO && pyPX) {
    const js = k => { const r = new RegExp(k + ' = (-?[\\d.]+)').exec(html); return r ? +r[1] : NaN; };
    check('EXPORT_SCALE == python S', js('EXPORT_SCALE') === +pyS[2], js('EXPORT_SCALE') + ' vs ' + pyS[2]);
    check('WORLD_XLO == python XLO', js('WORLD_XLO') === +pyXLO[1], js('WORLD_XLO') + ' vs ' + pyXLO[1]);
    check('WORLD_PPT == python PX factor', js('WORLD_PPT') === +pyPX[1], js('WORLD_PPT') + ' vs ' + pyPX[1]);
    // town offset constants must match the generated data (ox/oy)
    const data = fs.readFileSync(path.join(root, 'web', 'js', 'map-explorer-data.js'), 'utf8');
    const ox = /"ox":\s*(-?\d+)/.exec(data), oy = /"oy":\s*(-?\d+)/.exec(data);
    check('TOWN_OX == data ox', js('TOWN_OX') === +ox[1], js('TOWN_OX') + ' vs ' + ox[1]);
    check('TOWN_OY == data oy', js('TOWN_OY') === +oy[1], js('TOWN_OY') + ' vs ' + oy[1]);
}

// 4. paste block keeps its documented shape (solver regex depends on it)
check('paste block header present', /# name \| export px x,y \| grid tile x,y/.test(html));
// 4b. actually run the inline script against a minimal DOM shim and assert
//     the textarea gets the header even with zero pairs (a runtime throw in
//     the build path is invisible to every other static check here).
{
    const store = {};
    const mk = (id) => ({ id, style: {}, _text: '', children: [],
        parentNode: { appendChild(c) { return c; } },
        set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html || ''; },
        set value(v) { this._value = v; }, get value() { return this._value || ''; },
        set textContent(v) { this._text = v; }, get textContent() { return this._text; },
        appendChild(c) { this.children.push(c); return c; },
        addEventListener() {}, setAttribute() {}, getAttribute() { return null; },
        querySelectorAll() { return []; }, classList: { toggle() {} } });
    const els = {};
    ['imgA', 'imgB', 'status', 'pairs', 'paste', 'hint', 'copymsg',
     'btn-copy', 'btn-clear'].forEach(id => els[id] = mk(id));
    els.imgA.parentNode = els.imgB.parentNode = { appendChild(c) { return c; } };
    els.imgA.naturalWidth = 4050; els.imgA.naturalHeight = 2092;
    els.imgB.naturalWidth = 1440; els.imgB.naturalHeight = 2174;
    global.document = {
        getElementById: id => els[id] || mk(id),
        createElement: t => mk(t),
        querySelectorAll: () => [],
        addEventListener: () => {},
    };
    Object.keys(els).forEach(id => { els[id].ownerDocument = global.document; });
    global.localStorage = { getItem: k => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); } };
    global.window = global;
    let ran = true, err = '';
    try { new Function(m[1])(); } catch (e) { ran = false; err = String(e); }
    check('inline script runs under a DOM shim', ran, err);
    check('paste box has the header with 0 pairs',
        /^# CITY-VIEW CALIB/.test(els.paste.value) &&
        /# name \| export px/.test(els.paste.value),
        JSON.stringify(els.paste.value));
    check('hint counts pairs live', /\(0 pairs\)/.test(els.hint.textContent),
        els.hint.textContent);
}
// 5. marker placement contract: the % -positioned markers live in the wrapper,
//    so the wrapper must shrink-wrap the img (a block div would take the pane
//    width and dots would land far left of the click).
check('wrapper shrink-wraps the img (markers are % of it)',
    /\.wrap\s*{[^}]*fit-content/.test(html));
check('default zoom present', /DEFAULT_ZOOM = \{ a: ([\d.]+), b: ([\d.]+) \}/.test(html));

// 6. registration artefacts (M4 item 3, tools/calib-solve.py): the shipped
//    homography JSON must reproduce the calib-pairs.txt correspondences.
//    The ground plane under a perspective camera maps exactly via a
//    homography, so this is the principled model; the affine JSON is kept
//    as the M2/M3 baseline. Thresholds: homography RMS < 40 px, and it may
//    not be worse than the affine (2026-10-17: 30.7 vs 40.3).
const pairsTxt = fs.readFileSync(path.join(root, 'mapdump', 'registration', 'calib-pairs.txt'), 'utf8');
const pairs = [];
for (const line of pairsTxt.split('\n')) {
    const p = line.split('|').map(s => s.trim());
    if (p.length !== 3) continue;
    const e = /^(-?[\d.]+)\s*,\s*(-?[\d.]+)$/.exec(p[1]);
    const g = /^(-?[\d.]+)\s*,\s*(-?[\d.]+)$/.exec(p[2]);
    if (e && g) pairs.push([p[0], +e[1], +e[2], +g[1], +g[2]]);
}
check('calib-pairs.txt has >= 9 pairs', pairs.length >= 9, String(pairs.length));
function projRMS(k) {
    const j = JSON.parse(fs.readFileSync(path.join(root, 'mapdump', 'registration', k), 'utf8'));
    const v = j.a || j.h;
    if (!Array.isArray(v) || v.length !== 6 && v.length !== 8) return NaN;
    // robust homography fits the kept subset; scored pairs = kept (or all).
    const use = j.kept ? pairs.filter(pr => j.kept.includes(pr[0])) : pairs;
    let s2 = 0;
    for (const [, ex, ey, gx, gy] of use) {
        let x, y;
        if (v.length === 6) { x = v[0] * gx + v[1] * gy + v[2]; y = v[3] * gx + v[4] * gy + v[5]; }
        else {
            const den = v[6] * gx + v[7] * gy + 1;
            x = (v[0] * gx + v[1] * gy + v[2]) / den;
            y = (v[3] * gx + v[4] * gy + v[5]) / den;
        }
        s2 += (x - ex) * (x - ex) + (y - ey) * (y - ey);
    }
    return Math.sqrt(s2 / use.length);
}
const rmsH = projRMS('g2e-homog.json'), rmsA = projRMS('g2e-affine.json');
check('g2e-homog.json reproduces its kept pairs (RMS < 40 px)', isFinite(rmsH) && rmsH < 40, rmsH.toFixed(1));
check('homography no worse than affine baseline', isFinite(rmsH) && isFinite(rmsA) && rmsH <= rmsA,
    rmsH.toFixed(1) + ' vs ' + rmsA.toFixed(1));

console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
