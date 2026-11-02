// Regression test: drives the real boot -> splash -> loading -> city flow
// of web/js/*.js in Node with a minimal DOM stub, at a simulated 60 fps.
//
// Catches the infinite-loop bug where the loading scene re-fired
// setScene('city') + playSfx('10_next_segment.wav') every frame during the
// exit fade (the fade was reset to 0 each frame and never completed, and a
// fresh Audio element — and network request — was created ~60x/sec).
//
// Usage: node smoke-scene.cjs [root]   (root defaults to the real web/)
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || path.join(__dirname, '..', 'web');

// ---- minimal XML parser (splashscreen.xml subset) --------------------------
function parseXml(text) {
    const stack = [];
    const els = {};
    const re = /<([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>|<\/([A-Za-z][\w:-]*)>/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        if (m[4]) {
            const top = stack[stack.length - 1];
            if (top && top.tagName === m[4]) { stack.pop(); }
            continue;
        }
        const name = m[1];
        const attrs = {};
        const am = /([\w:-]+)="([^"]*)"/g;
        let a;
        while ((a = am.exec(m[2])) !== null) { attrs[a[1]] = a[2]; }
        const el = {
            tagName: name,
            attributes: attrs,
            children: [],
            parent: stack[stack.length - 1] || null,
            getAttribute(n) { return this.attributes[n] !== undefined ? this.attributes[n] : null; },
            getElementsByTagName(n) {
                const out = [];
                (function walk(e) {
                    e.children.forEach(c => {
                        if (c.tagName === n) { out.push(c); }
                        walk(c);
                    });
                })(el);
                return out;
            }
        };
        (els[name] = els[name] || []).push(el);
        if (stack.length) { stack[stack.length - 1].children.push(el); }
        if (!m[3]) { stack.push(el); }
    }
    return { getElementsByTagName: (n) => (els[n] || []).slice() };
}

// ---- controllable clock + rAF queue ------------------------------------------
let clockNow = 0;
global.performance = { now: () => clockNow };
let rafQueue = [];
global.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
global.cancelAnimationFrame = () => {};

// ---- window / document / canvas ----------------------------------------------
global.window = global;
window.innerWidth = 1280;
window.innerHeight = 720;
window.devicePixelRatio = 1;
window.addEventListener = () => {};

const canvasListeners = {};
const gradStub = { addColorStop() {} };
const ctxTarget = {};
const fakeCtx = new Proxy(ctxTarget, {
    get(t, k) {
        if (typeof k === 'symbol') { return undefined; }
        if (k === 'measureText') { return (s) => ({ width: String(s || '').length * 8 }); }
        if (k === 'createLinearGradient' || k === 'createRadialGradient') { return () => gradStub; }
        if (k === 'getImageData') { return () => ({ data: [10, 20, 30, 255], width: 1, height: 1 }); }
        if (k in t) { return t[k]; }
        return () => {};
    },
    set(t, k, v) { t[k] = v; return true; }
});

function makeCanvasStub() {
    return {
        width: 0, height: 0,
        getContext: () => fakeCtx,
        addEventListener: (ev, fn) => { canvasListeners[ev] = fn; },
        getBoundingClientRect: () => ({ left: 0, top: 0 })
    };
}
const canvasStub = makeCanvasStub();
const bootEl = { classes: new Set(), classList: { add(c) { bootEl.classes.add(c); }, remove() {} } };
const bootMsg = { textContent: '' };
global.document = {
    readyState: 'complete',
    getElementById: (id) =>
        id === 'game' ? canvasStub :
        id === 'boot' ? bootEl :
        id === 'bootmsg' ? bootMsg : null,
    createElement: () => makeCanvasStub(),
    addEventListener: () => {}
};
// no document.fonts -> boot.js takes its Promise.resolve() branch

// ---- Image stub (fires onload async, real PNG dimensions) ---------------------
function pngDims(p) {
    try {
        const b = fs.readFileSync(p);
        if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) { return null; }
        return [b.readUInt32BE(16), b.readUInt32BE(20)];
    } catch (e) { return null; }
}
const DIMS = {};
const imgDir = path.join(ROOT, 'assets/images');
fs.readdirSync(imgDir).forEach((f) => {
    if (f.endsWith('.png')) { DIMS[f] = pngDims(path.join(imgDir, f)) || [64, 64]; }
});
global.Image = class {
    constructor() { this.naturalWidth = 0; this.naturalHeight = 0; this._src = ''; }
    get src() { return this._src; }
    set src(v) {
        this._src = v;
        const d = DIMS[v.split('/').pop()] || [64, 64];
        this.naturalWidth = d[0];
        this.naturalHeight = d[1];
        setTimeout(() => { if (this.onload) { this.onload(); } }, 0);
    }
};

// ---- Audio stub (records every element created = every "network request") ----
global.AUDIO_LOG = [];
global.Audio = class {
    constructor(src) {
        this.src = src;
        global.AUDIO_LOG.push(src);
        this.volume = 0.5; this.loop = false; this.paused = true;
        this.ended = false; this.muted = false; this.readyState = 4;
    }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    load() {}
    addEventListener() {}
};

// ---- DOMParser (for splashscreen.xml) -----------------------------------------
global.DOMParser = function () {
    this.parseFromString = (t) => parseXml(t);
};

// ---- load the app (boot.js starts the boot sequence synchronously) -------------
require(path.join(ROOT, 'assets/manifest.js'));
require(path.join(ROOT, 'assets/data/webdata.js'));
require(path.join(ROOT, 'js/i18n.js'));
require(path.join(ROOT, 'js/assets.js'));
require(path.join(ROOT, 'js/splashlayout.js'));
require(path.join(ROOT, 'js/audio.js'));
require(path.join(ROOT, 'js/ui.js'));
require(path.join(ROOT, 'js/scenes.js'));
require(path.join(ROOT, 'js/boot.js'));

// ---- driver ---------------------------------------------------------------------
const G = global.G;
const Scenes = global.Scenes;
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle(n) { for (let i = 0; i < n; i++) { await tick(1); } }
function drain() {
    const q = rafQueue.splice(0, rafQueue.length);
    for (const cb of q) { cb(clockNow); }
}
async function stepFrames(n) {
    for (let i = 0; i < n; i++) {
        clockNow += 1000 / 60;
        drain();
        await tick(1);
    }
}

let failures = 0;
function check(label, cond, extra) {
    if (cond) { console.log('  ok  ' + label); }
    else { failures++; console.log('  FAIL ' + label + (extra ? ' — ' + extra : '')); }
}

(async () => {
    // Phase A: boot sequence (critical images + font)
    await settle(40);
    console.log('boot:');
    check('boot overlay dismissed', bootEl.classes.has('done'));
    check('no image load errors', Assets.errors.length === 0, Assets.errors.join(','));
    check('splash scene active', G.scene === Scenes.splash);
    check('11 rulesets parsed', SplashLayout.rulesets.length === 11);

    // Phase B: tap the splash
    canvasListeners['mousedown']({ clientX: 640, clientY: 360 });
    console.log('splash tap:');
    check('tap SFX played', AUDIO_LOG.some((s) => s.endsWith('01_general_button.wav')));
    check('main music started', AUDIO_LOG.some((s) => s.endsWith('mainmusic.wav')));
    check('fade to loading in flight', G.fade && G.fade.to === Scenes.loading,
          G.fade ? (G.fade.from.name + ' -> ' + G.fade.to.name) : 'no fade');

    // Phase C: run the frame loop until the city scene (cap = regression tripwire)
    let frames = 0;
    while (frames < 800 && G.scene !== Scenes.city) {
        frames++;
        clockNow += 1000 / 60;
        drain();
        await tick(1);
    }
    console.log('flow (after ' + frames + ' simulated frames):');
    check('reaches city scene (finite)', G.scene === Scenes.city,
          'still on ' + (G.scene && G.scene.name) + ' after 800 frames');
    check('fade cleared', G.fade === null);

    // Phase D: audio must have fired exactly once (the reported bug spammed it)
    const count = (frag) => AUDIO_LOG.filter((s) => s.includes(frag)).length;
    console.log('audio (each file may be created exactly once):');
    check('10_next_segment.wav once (was N/frame before fix)', count('10_next_segment') === 1,
          'n=' + count('10_next_segment'));
    check('bgloop.wav once', count('bgloop') === 1, 'n=' + count('bgloop'));
    check('mainmusic.wav once', count('mainmusic') === 1, 'n=' + count('mainmusic'));
    check('total audio elements small', AUDIO_LOG.length <= 8,
          'n=' + AUDIO_LOG.length + ': ' + AUDIO_LOG.join(', '));

    // Phase E: a few more frames in the city — nothing new may fire
    const before = AUDIO_LOG.length;
    await stepFrames(30);
    console.log('steady state:');
    check('no further audio created after arrival', AUDIO_LOG.length === before,
          '+ ' + (AUDIO_LOG.length - before));
    check('still on city', G.scene === Scenes.city);

    console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL CHECKS PASSED');
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
