// Headless DOM test for the (server-backed) asset explorer page. Drives the
// real web/js/explorer.js in Node with a minimal DOM. The page no longer
// loads the 3.5M-entry manifest: every browse/search/variant/string/data
// query goes to the PHP API, which the harness stubs by running
// web/api/assets.php via the php CLI against the real assets.sqlite. So
// this exercises explorer.js <-> assets.php <-> assets.sqlite end to end:
// renders every tab, pages the grid, clicks through a stratified sample of
// tiles (audio/video/font/i18n/data samples, splash variants, multi-pack
// DLC files, animation drill-down + search), plays the Motion tab frames,
// and exercises search. Full manifest integrity remains
// tools/smoke-explorer.cjs's job.
//
//   node tools/smoke-explorer-dom.cjs [web-dir] [assets.sqlite]
//
// js/audio.js plays short clips from pre-decoded Web Audio buffers and only
// falls back to HTMLAudioElement when AudioContext is missing, so each engine
// is a different code path — and the page in a real browser uses the buffer
// one. With no AudioContext the harness could only ever see the fallback, which
// is how a buffer-engine throw blanked the audio pane unnoticed. So this file
// runs itself twice, once per engine (AUDIO_ENGINE=element|buffer); run it
// directly with that variable set to debug a single engine.
'use strict';
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');

const ROOT = process.argv[2] || path.join(__dirname, '..', 'web');
const DB = process.argv[3] || path.join(ROOT, 'api', 'assets.sqlite');
const API_PHP = path.join(ROOT, 'api', 'assets.php');
const PAGE = 240;                         // must match explorer.js
const ENGINE = process.env.AUDIO_ENGINE || '';

if (!ENGINE) {
    let bad = 0;
    for (const eng of ['element', 'buffer']) {
        console.log('\n=== audio engine: ' + eng + ' ===');
        const r = spawnSync(process.execPath, [__filename, ROOT, DB], {
            stdio: 'inherit',
            env: Object.assign({}, process.env, { AUDIO_ENGINE: eng }),
        });
        if (r.status !== 0) { bad++; }
    }
    if (bad) {
        console.error('\n' + bad + ' audio engine(s) failed');
        process.exit(1);
    }
    process.exit(0);
}

if (!fs.existsSync(DB)) {
    console.error('no assets database at ' + DB +
                  ' — run: php tools/build_assets_db.php');
    process.exit(2);
}
const db = new DatabaseSync(DB, { readOnly: true });
const dbGet = (sql, ...a) => db.prepare(sql).get(...a);
const dbAll = (sql, ...a) => db.prepare(sql).all(...a);

// ---- fetch stub: run the real PHP API, cache responses (read-only) ------
const fetchLog = [];
const cache = new Map();
const AUDIO_DIR = path.join(ROOT, 'assets', 'audio');
globalThis.fetch = (url) => {
    url = String(url);
    // The buffer engine fetches the .m4a itself (fetchArrayBuffer in audio.js);
    // everything else is an API query.
    if (url.indexOf('assets/') === 0) {
        const rel = decodeURIComponent(url.split('?')[0]).replace(/^assets\//, '');
        const file = path.join(ROOT, 'assets', rel);
        if (!fs.existsSync(file)) {
            return Promise.resolve({ ok: false, status: 404 });
        }
        const buf = fs.readFileSync(file);
        return Promise.resolve({
            ok: true, status: 200,
            arrayBuffer: () => Promise.resolve(
                buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
            json: () => Promise.reject(new Error('not json')),
        });
    }
    const qs = url.split('?')[1] || '';
    fetchLog.push(qs);
    let json = cache.get(qs);
    if (!json) {
        const out = execFileSync('php', [API_PHP, qs], {
            maxBuffer: 256 << 20,
            env: Object.assign({}, process.env, { ASSETS_DB: DB }),
        }).toString();
        json = JSON.parse(out);
        cache.set(qs, json);
    }
    return Promise.resolve({ ok: true, status: 200,
                             json: () => Promise.resolve(json) });
};

// ---- Web Audio stub (buffer engine only) ------------------------------------
// The buffer engine is what a real browser uses; the element engine is the
// fallback. Stubbing AudioContext makes the harness drive the same path Chrome
// does, and decodeAudioData probes the genuine .m4a with ffprobe, so the
// duration/channel values the engine reasons about are the real ones.
const TMP = fs.mkdtempSync('/tmp/opencode/explorer-dom-');
process.on('exit', () => { try { fs.rmdirSync(TMP); } catch (e) { /* best effort */ } });
let stubDecodeSeq = 0;
let stubDecodeFailures = 0;
const stubSrcs = [];

class StubAudioBuffer {
    constructor(ch, len, rate) {
        this.numberOfChannels = ch;
        this.length = len;
        this.sampleRate = rate;
        this.duration = len / rate;
        this._data = [];
        for (let i = 0; i < ch; i++) { this._data.push(new Float32Array(len)); }
    }
    getChannelData(i) { return this._data[i]; }
}

class StubAudioContext {
    constructor() {
        this.state = 'running';
        this.sampleRate = 48000;
        this.destination = {};
        this._t0 = process.hrtime.bigint();
    }
    get currentTime() { return Number(process.hrtime.bigint() - this._t0) / 1e9; }
    createBuffer(ch, len, rate) { return new StubAudioBuffer(ch, len, rate); }
    createGain() {
        return { gain: { value: 1, setValueAtTime() { } }, connect() { } };
    }
    createBufferSource() {
        const ctx = this;
        const src = {
            buffer: null, loop: false, playbackRate: { value: 1 }, onended: null,
            _start: 0, _offset: 0, _started: false,
            connect() { }, disconnect() { },
            start(when, offset) { this._started = true; this._start = when; this._offset = offset || 0; },
            stop() {
                if (!this._started) { return; }
                const cb = this.onended;
                if (cb) { setTimeout(cb, 0); }
            },
        };
        Object.defineProperty(src, 'position', {
            get() {
                if (!this._started || !this.buffer) { return 0; }
                const p = ctx.currentTime - this._start + this._offset;
                return Math.max(0, Math.min(this.buffer.duration, p));
            },
        });
        stubSrcs.push(src);
        return src;
    }
    resume() { return Promise.resolve(); }
    decodeAudioData(buf, ok, err) {
        const file = path.join(TMP, `decode-${stubDecodeSeq++}.m4a`);
        fs.writeFileSync(file, Buffer.from(buf));
        let info = null;
        try {
            info = JSON.parse(execFileSync('ffprobe', [
                '-v', 'error', '-select_streams', 'a:0', '-show_entries',
                'stream=channels,sample_rate:format=duration', '-of', 'json', file,
            ], { encoding: 'utf8' }));
        } catch (e) { info = null; }
        fs.unlinkSync(file);
        const st = info && info.streams && info.streams[0];
        const fmt = info && info.format;
        if (!st || !st.sample_rate) {
            stubDecodeFailures++;
            if (err) { err(new Error('stub decode failed')); }
            return;
        }
        const dur = Number((fmt && fmt.duration) || st.duration || 0);
        // a real decodeAudioData resamples to the context rate, so the buffer
        // is dur seconds *of the context rate*; matching that keeps pos()/dur()
        // honest for the checks below.
        const len = Math.max(1, Math.round(dur * this.sampleRate));
        const out = this.createBuffer(Number(st.channels || 1), len, this.sampleRate);
        if (ok) { ok(out); }
    }
}
if (ENGINE === 'buffer') { globalThis.AudioContext = StubAudioContext; }

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
                    e.children.forEach((c) => {
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

// ---- canvas 2d stub (counts draw calls) -------------------------------------
const CTX_CALLS = { drawImage: 0, clearRect: 0, fillRect: 0 };
const gradStub = { addColorStop() {} };
function makeCtx() {
    return new Proxy({}, {
        get(t, k) {
            if (typeof k === 'symbol') { return undefined; }
            if (k === 'measureText') { return () => ({ width: 10 }); }
            if (k === 'createLinearGradient' || k === 'createRadialGradient') {
                return () => gradStub;
            }
            if (k === 'getImageData') { return () => ({ data: [10, 20, 30, 255] }); }
            if (k === 'drawImage' || k === 'clearRect' || k === 'fillRect') {
                return () => { CTX_CALLS[k]++; };
            }
            if (k in t) { return t[k]; }
            return () => {};
        },
        set(t, k, v) { t[k] = v; return true; }
    });
}

// ---- element stub -------------------------------------------------------------
class FakeEl {
    constructor(tag) {
        this.tagName = String(tag || 'div').toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.style = {};
        this.dataset = {};
        this._classes = new Set();
        this.textContent = '';
        this.value = '';
        this.checked = false;
        this.scrollTop = 0;
        this.listeners = {};
        this._html = '';
        if (this.tagName === 'CANVAS') {
            this.width = 300;
            this.height = 150;
        }
        const self = this;
        this.classList = {
            toggle(c, on) {
                if (on === undefined) { on = !self._classes.has(c); }
                if (on) { self._classes.add(c); } else { self._classes.delete(c); }
                return on;
            },
            add(c) { self._classes.add(c); },
            remove(c) { self._classes.delete(c); },
            contains(c) { return self._classes.has(c); }
        };
    }
    get className() { return Array.from(this._classes).join(' '); }
    set className(v) {
        this._classes = new Set(String(v).split(/\s+/).filter(Boolean));
    }
    get innerHTML() { return this._html; }
    set innerHTML(v) {
        this._html = v;
        if (v === '') { this.children = []; }
    }
    appendChild(c) {
        if (c && c.isFragment) {
            const kids = c.children.slice();
            for (const k of kids) { this.appendChild(k); }
            return c;
        }
        c.parentNode = this;
        this.children.push(c);
        return c;
    }
    removeChild(c) {
        const i = this.children.indexOf(c);
        if (i >= 0) { this.children.splice(i, 1); }
        return c;
    }
    insertBefore(c, ref) {
        const i = ref ? this.children.indexOf(ref) : -1;
        if (i < 0) { return this.appendChild(c); }
        c.parentNode = this;
        this.children.splice(i, 0, c);
        return c;
    }
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
    dispatch(ev, arg) {
        (this.listeners[ev] || []).slice().forEach((fn) => fn(arg || {}));
    }
    // media-ish element methods (video/audio) the detail panes rely on
    removeAttribute(n) { delete this[n]; if (this._attrs) { delete this._attrs[n]; } }
    setAttribute(n, v) { (this._attrs = this._attrs || {})[n] = String(v); }
    getAttribute(n) {
        return this._attrs && this._attrs[n] !== undefined ? this._attrs[n] : null;
    }
    load() {}
    pause() { this.paused = true; }
    getContext() { return makeCtx(); }
    querySelector(sel) {
        const pred = sel.startsWith('.')
            ? (n) => n.className && n.className.split(/\s+/).indexOf(sel.slice(1)) >= 0
            : sel.startsWith('#')
                ? (n) => n.dataset && n.dataset.id === sel.slice(1)
                : (n) => n.tagName === sel.toUpperCase();
        const walk = (n) => {
            for (const c of (n.children || [])) {
                if (pred(c)) { return c; }
                const r = walk(c);
                if (r) { return r; }
            }
            return null;
        };
        return walk(this);
    }
    descend(n) {
        const out = [n];
        for (const c of (n.children || [])) { out.push(...this.descend(c)); }
        return out;
    }
}

// ---- globals --------------------------------------------------------------------
globalThis.window = globalThis;
let rafQueue = [];
globalThis.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
globalThis.cancelAnimationFrame = () => {};
let clockNow = 0;
globalThis.performance = { now: () => clockNow };
globalThis.DOMParser = function () { this.parseFromString = (t) => parseXml(t); };

const named = {};
function mkNamed(tag) {
    const e = new FakeEl(tag);
    named[tag] = e;
    return e;
}
['grid', 'detail', 'tabs', 'search', 'counts', 'main', 'crumb'].forEach(mkNamed);
globalThis.document = {
    readyState: 'complete',
    getElementById: (id) => named[id] || null,
    querySelector: (sel) => named[sel] || named[sel.slice(1)] || null,
    createElement: (tag) => new FakeEl(tag),
    createDocumentFragment: () => Object.assign(new FakeEl('#frag'), { isFragment: true }),
    createTextNode: (t) => ({ nodeType: 3, text: t }),
    body: new FakeEl('body'),
    addEventListener: () => {}
};

globalThis.AUDIO_LOG = [];
globalThis.AUDIO_ELS = [];
globalThis.AUDIO_COLD = false;         // harness: pretend the file is not buffered
globalThis.Audio = class {
    constructor(src) {
        this.src = src;
        globalThis.AUDIO_LOG.push(src);
        globalThis.AUDIO_ELS.push(this);
        this.volume = 0.8; this.loop = false; this.paused = true;
        this.duration = 1; this.currentTime = 0;
        this.readyState = globalThis.AUDIO_COLD ? 0 : 4;    // buffered?
        this._ls = {}; this.plays = 0; this.playedAt = null;
    }
    addEventListener(ev, fn) { (this._ls[ev] = this._ls[ev] || []).push(fn); }
    dispatch(ev) { (this._ls[ev] || []).slice().forEach((fn) => fn({})); }
    play() { this.paused = false; this.plays++; this.playedAt = this.currentTime;
             return Promise.resolve(); }
    pause() { this.paused = true; }
};

// manifest dims for the Image stub (lazy per-path lookups against the DB)
const DIMS = {};
const dimsOf = (p) => {
    if (!(p in DIMS)) {
        const r = dbGet('SELECT w, h FROM assets WHERE path = ?', p);
        DIMS[p] = r && r.w != null ? [r.w, r.h] : [64, 64];
    }
    return DIMS[p];
};
globalThis.Image = class {
    constructor() { this.naturalWidth = 0; this.naturalHeight = 0; this._src = ''; }
    get src() { return this._src; }
    set src(v) {
        this._src = v;
        const p = v.replace(/^assets\//, '');
        const d = dimsOf(p);
        this.naturalWidth = d[0];
        this.naturalHeight = d[1];
        setTimeout(() => { if (this.onload) { this.onload(); } }, 0);
    }
};

// ---- load the app ---------------------------------------------------------------
// the page inlines the core (non-DLC) manifest entries via PHP; the harness
// pulls the same set from the API (op=core) before loading the modules
const core = fetchStubJson('op=core');
globalThis.window.MANIFEST = { files: core.files };
globalThis.window.EXPLORER_API = 'api/assets.php';

function fetchStubJson(qs) {
    if (!cache.has(qs)) { globalThis.fetch('api/assets.php?' + qs); }
    return cache.get(qs);
}

require(path.join(ROOT, 'assets/data/webdata.js'));
delete globalThis.global;             // browser-faithful: see the note above
require(path.join(ROOT, 'js/i18n.js'));
require(path.join(ROOT, 'js/assets.js'));
require(path.join(ROOT, 'js/audio.js'));
require(path.join(ROOT, 'js/splashlayout.js'));
require(path.join(ROOT, 'js/ui.js'));
require(path.join(ROOT, 'js/scenes.js'));
require(path.join(ROOT, 'js/explorer.js'));


// ---- drive -------------------------------------------------------------------------
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
// settle: let fetch promises + the 250ms search debounce run out
const settle = async (ms = 60) => { await tick(ms); await tick(10); };
let failures = 0;
function check(label, cond, extra) {
    if (cond) { console.log('  ok  ' + label); }
    else { failures++; console.log('  FAIL ' + label + (extra ? ' — ' + extra : '')); }
}
const tiles = () => named.grid.children.filter((t) => t.classList.contains('tile'));
const tab = (label) => named.tabs.children.find((b) =>
    b._html.indexOf(label) === 0 || String(b.textContent).indexOf(label) === 0);

async function openTab(label) {
    tab(label).dispatch('click');
    await settle(120);
}
async function search(q) {
    named.search.value = q;
    named.search.dispatch('input');
    await settle(360);                    // > the 250 ms debounce
}
function findTile(path_, char, fam) {
    return tiles().find((t) =>
        (path_ != null && t.dataset.path === path_) ||
        (char != null && t.dataset.char === char) ||
        (fam != null && t.dataset.fam === fam));
}
const metaText = () => named.detail.descend(named.detail)
    .map((n) => String(n.textContent || '')).join('|');

(async () => {
    await tick(20); // let critical images "load"

    console.log('layout:');
    check('11 tabs rendered', named.tabs.children.length === 11,
          named.tabs.children.length);
    const cats = {};
    dbAll('SELECT cat, COUNT(*) n FROM assets GROUP BY cat')
        .forEach((r) => { cats[r.cat] = Number(r.n); });
    const total = Object.values(cats).reduce((a, b) => a + b, 0);
    const apiCounts = fetchStubJson('op=counts&q=').counts;
    check('API counts agree with the database',
          apiCounts.all === total && apiCounts.image === cats.image &&
          apiCounts.dlc === (cats.dlc || 0),
          JSON.stringify(apiCounts));
    const nTab = (label) => {
        const b = tab(label);
        const m = String(b._html).match(/<span class="n">(\d+)<\/span>/);
        return m ? Number(m[1]) : -1;
    };
    check('All tab shows the DB total', nTab('All') === total, nTab('All'));

    console.log('all tab: paged grid');
    check('first page caps at ' + PAGE + ' tiles', tiles().length === PAGE,
          tiles().length);
    const more = named.grid.children.find((t) => t.className === 'more');
    check('load-more button present', !!more);
    if (more) {
        more.dispatch('click');
        await settle(150);
        check('load-more appends a second page', tiles().length === PAGE * 2,
              tiles().length);
    }

    console.log('images tab: splash variants + zoom controls');
    await openTab('Images');
    check('Images tab = core game images', tiles().length === Math.min(PAGE, cats.image),
          tiles().length + '/' + cats.image);
    await search('splashscreen.png');
    const stripTile = findTile('images/splashscreen.png');
    check('search finds the splash strip', !!stripTile);
    if (stripTile) {
        stripTile.dispatch('click');
        await settle();
        const variantBtns = (named.detail.querySelector('.vrow') || { children: [] }).children;
        const nClasses = dbGet(
            "SELECT COUNT(*) c FROM assets WHERE family=(" +
            "SELECT family FROM assets WHERE path='images/splashscreen.png')" +
            " AND type='image'").c;
        check('splash strip shows its ' + nClasses + ' resolution classes',
              variantBtns.length === Number(nClasses), variantBtns.length);
        check('fit/100% zoom buttons present', !!named.detail.querySelector('.zoombar'));
        const variant100 = variantBtns.find((b) => String(b.textContent).indexOf('large') === 0);
        if (variant100) {
            variant100.dispatch('click');
            await settle();
            check('variant switch selects the large strip',
                  metaText().indexOf('splashscreen_large.png') >= 0);
        }
    }
    await search('');

    console.log('strings detail: (DB-backed)');
    await openTab('Strings');
    const enTile = findTile('i18n/en.json');
    check('strings tab lists the 16 tables', tiles().length === 16, tiles().length);
    if (enTile) {
        enTile.dispatch('click');
        await settle(150);
        const keyCells = named.detail.descend(named.detail)
            .filter((n) => n.className === 'k').length;
        const nEn = Number(dbGet("SELECT COUNT(*) c FROM strings WHERE lang='en'").c);
        check('en table has ' + nEn + ' key rows from the database',
              keyCells === nEn, keyCells);
    }

    console.log('audio detail (' + ENGINE + ' engine):');
    if (ENGINE === 'element') {
        // The web server runs this API under a pool whose open_basedir stops at
        // web/, so the pre-conversion backup tree (var/audio-adpcm) is barred:
        // the stat calls used to print "open_basedir restriction in effect"
        // warnings into the JSON body and only op=asset for audio ever touched
        // that tree — the browser's r.json() then threw and the audio detail
        // pane went blank. Prove the API stays pure JSON with display_errors on.
        const restricted = execFileSync('php', [
            '-d', 'open_basedir=' + ROOT, '-d', 'display_errors=1',
            '-d', 'error_reporting=32767', API_PHP,
            'op=asset&path=audio/01_general_button.m4a',
        ], {
            maxBuffer: 16 << 20,
            env: Object.assign({}, process.env, { ASSETS_DB: DB }),
        }).toString();
        let parsed = null;
        try { parsed = JSON.parse(restricted); } catch (e) { /* reported below */ }
        check('op=asset stays pure JSON under a restricted (open_basedir) pool',
              !!parsed && parsed.entry && parsed.entry.codec === 'aac',
              restricted.slice(0, 160).replace(/\n/g, ' '));
        check('the restricted response carries no warning text',
              restricted.indexOf('Warning') < 0 &&
              restricted.indexOf('open_basedir') < 0,
              restricted.slice(0, 160));
    }
    const diagTxt = () => {
        const d = named.detail.querySelector('.diag');
        return d ? d.textContent : '';
    };
    await openTab('Audio');
    const audBefore = AUDIO_LOG.length;
    const someAudio = tiles().slice(0, 5);
    const engines = [];
    for (const t of someAudio) {           // settle between clicks: explorer
        t.dispatch('click');               // drops superseded detail fetches
        await settle(150);
        engines.push(diagTxt());
    }
    await settle(150);
    if (ENGINE === 'element') {
        check('5 audio tiles create 5 players',
              AUDIO_LOG.length === audBefore + 5, AUDIO_LOG.length - audBefore);
    } else {
        // The browser path: every click must decode a Web Audio buffer and say
        // so. A fallback to 'element' here means the buffer engine threw, and a
        // blank diag means detailAudio() never built the pane at all.
        check('5 audio tiles decode 5 buffers, none fall back',
              stubDecodeFailures === 0 && engines.length === 5 &&
              engines.every((t) => /buffer$/.test(t)),
              'decode failures=' + stubDecodeFailures + ' | ' + engines.join(' | '));
    }
    const nInputs = named.detail.descend(named.detail)
        .filter((n) => n.tagName === 'INPUT').length;
    check('player has seek + volume + loop inputs', nInputs >= 3, nInputs);

    // download links in the side panel: the AAC file the page plays, and the
    // game's own IMA ADPCM file kept by tools/convert_audio_pcm.py
    const audPath = 'audio/01_general_button.m4a';
    const audTile = findTile(audPath);
    if (audTile) {
        audTile.dispatch('click');
        await settle(150);
        const row = named.detail.querySelector('.dl-row');
        const dls = row ? row.children.filter((n) => n.tagName === 'A') : [];
        check('audio detail offers 2 download links', dls.length === 2, dls.length);
        check('playable link serves the asset file with a download name',
              dls[0] && dls[0].href === 'assets/' + audPath &&
              dls[0].download === '01_general_button.m4a',
              dls[0] && dls[0].href + ' / ' + dls[0].download);
        check('original link uses op=original, names itself, and tips',
              dls[1] && dls[1].href.indexOf('op=original&path=' +
                                             encodeURIComponent(audPath)) > 0 &&
              dls[1].download === '01_general_button-original.wav' &&
              !!dls[1].getAttribute('data-tip'),
              dls[1] && dls[1].href + ' / ' + dls[1].download);
        check('detail lists the pre-conversion file',
              metaText().indexOf('Pre-conversion file') >= 0);
        check('player reports where it starts and which engine it uses',
              diagTxt().indexOf('start') === 0 &&
              new RegExp('\\b' + ENGINE + '\\b').test(diagTxt()),
              diagTxt());
    } else {
        console.log('  (' + audPath + ' not on the first audio page — skipped)');
    }

    if (ENGINE === 'element') {
        // cold start: play() must wait for data and rewind, not start mid-file
        // (the reported bug: with loop ticked the file is buffered and the head
        // plays; a cold play lost its attack).
        globalThis.AUDIO_COLD = true;
        const coldTile = findTile('audio/02_close_or_back.m4a') || audTile;
        coldTile.dispatch('click');
        await settle(150);
        const cold = globalThis.AUDIO_ELS[globalThis.AUDIO_ELS.length - 1];
        const playBtn = named.detail.querySelector('.big');
        check('cold audio element exists to test', !!cold && !!playBtn);
        cold.currentTime = 1.2;                // a playhead that wandered
        playBtn.dispatch('click');
        await settle(30);
        check('cold play waits for data instead of starting mid-file',
              cold.plays === 0 && cold.paused === true,
              'plays=' + cold.plays + ' paused=' + cold.paused);
        cold.readyState = 4;
        cold.dispatch('canplay');
        await settle(30);
        check('canplay starts it from the top',
              cold.plays === 1 && cold.playedAt === 0,
              'plays=' + cold.plays + ' at ' + cold.playedAt);
        globalThis.AUDIO_COLD = false;
    } else {
        // Buffer engine cold start: the clip is fetched and decoded on demand,
        // so a click has to end up playing from sample 0 quickly and to the
        // very end — the exact complaint the AAC move was meant to settle.
        const srcBefore = stubSrcs.length;
        const playBtn = named.detail.querySelector('.big');
        check('play button present', !!playBtn);
        if (playBtn) {
            playBtn.dispatch('click');         // first play of this clip
            await settle(1200);                // a real ffprobe decode runs here
            const diag = diagTxt();
            const m = diag.match(/start ([\d.]+) s · wait (\d+) ms · buf ([\d.]+) s/);
            check('cold play reports start/wait/buf: ' + diag, !!m);
            if (m) {
                check('buffer engine starts within 0.3 s of the click',
                      Number(m[1]) < 0.3, m[1] + 's');
                const dur = dbGet('SELECT duration_s d FROM assets WHERE path = ?',
                                  audPath);
                if (dur && dur.d) {
                    // the board rounds duration_s to 0.1 s and AAC carries priming
                    // padding, so a tenth or so apart is the two agreeing
                    check('buffer engine covers the whole clip',
                          Math.abs(Number(m[3]) - dur.d) < 0.15,
                          'buf ' + m[3] + 's vs board ' + dur.d + 's');
                }
            }
            check('play started a buffer source from 0',
                  stubSrcs.length === srcBefore + 1 &&
                  stubSrcs[stubSrcs.length - 1]._offset === 0,
                  stubSrcs.length - srcBefore);
            playBtn.dispatch('click');         // pause again
            await settle(60);
        }
    }

    console.log('dlc tab:');
    await openTab('DLC');
    const nFams = Number(dbGet('SELECT COUNT(*) c FROM dlc_fam').c);
    check('DLC tab = ' + Math.min(PAGE, nFams) + ' family tiles',
          tiles().length === Math.min(PAGE, nFams), tiles().length);
    const famTile = tiles().find((t) =>
        Number(dbGet('SELECT packs p FROM dlc_fam WHERE fam=?', t.dataset.fam).p) > 1 &&
        Number(dbGet('SELECT n_assets n FROM dlc_fam WHERE fam=?', t.dataset.fam).n) > 1) ||
        tiles()[0];
    const fam0 = famTile.dataset.fam;
    check('family tiles carry dataset.fam', typeof fam0 === 'string' && fam0.length > 0, fam0);
    famTile.dispatch('click');
    await settle(150);
    const famAssets = Number(dbGet('SELECT n_assets n FROM dlc_fam WHERE fam=?', fam0).n);
    check('family page = ' + Math.min(PAGE, famAssets) + ' asset tiles',
          tiles().length === Math.min(PAGE, famAssets), tiles().length);
    const crumbText = named.crumb.descend(named.crumb)
        .map((n) => String(n.textContent || '')).join(' ').toLowerCase();
    check('crumb names the chosen family + asset count',
          crumbText.indexOf(String(fam0).toLowerCase()) >= 0, crumbText);
    // a multi-pack file for the variant-row + provenance checks
    const multi = dbGet(
        "SELECT name, type FROM dlc_group WHERE fam=? AND packs>1 AND type IN " +
        "('image','data','audio') ORDER BY name LIMIT 1", fam0);
    if (multi) {
        await search(multi.name);
        const want = tiles().find((t) =>
            t.dataset.path.split('/').pop() === multi.name);
        check('DLC search finds ' + multi.name, !!want,
              tiles().map((t) => t.dataset.path)[0]);
        if (want) {
            want.dispatch('click');
            await settle();
            const e0 = dbGet('SELECT * FROM assets WHERE path=?', want.dataset.path);
            const pack = dbGet('SELECT p.* FROM packs p WHERE p.id=?', e0.pack_id);
            check('DLC detail tags the pack filename',
                  metaText().indexOf(pack.pack) >= 0, pack.pack);
            check('DLC detail shows season + tier' +
                  (pack.revision != null ? ' + revision' : ' (unrevised pack)') +
                  ' + source URL',
                  metaText().indexOf(String(pack.season)) >= 0 &&
                  metaText().indexOf(String(pack.tier)) >= 0 &&
                  metaText().indexOf(String(pack.url)) >= 0);
            const nVariants = Number(dbGet(
                'SELECT COUNT(*) c FROM assets WHERE family=? AND base=? AND type=?',
                fam0, multi.name, multi.type).c);
            const vBtns = (named.detail.querySelector('.vrow') || { children: [] }).children;
            check('DLC variant row = the file\'s own tiers/revisions (' + nVariants + ')',
                  vBtns.length === nVariants, vBtns.length || 'none rendered');
        }
        await search('');
    } else {
        console.log('  (no multi-pack file in this family — skipping variant row)');
    }
    const backBtn = named.crumb.children.find((n) => n.tagName === 'BUTTON');
    if (backBtn) {
        backBtn.dispatch('click');
        await settle(150);
        check('breadcrumb back returns to the family list',
              tiles().length === Math.min(PAGE, nFams) &&
              named.crumb.children.length === 0, tiles().length);
    }

    console.log('animations tab:');
    await openTab('Animations');
    const nChars = Number(dbGet('SELECT COUNT(*) c FROM anim_char').c);
    check('Animations tab = ' + Math.min(PAGE, nChars) + ' character tiles',
          tiles().length === Math.min(PAGE, nChars), tiles().length);
    const charTile = tiles().find((t) =>
        Number(dbGet('SELECT n_anims n FROM anim_char WHERE char=?', t.dataset.char).n) > 3) ||
        tiles()[0];
    const c0 = charTile.dataset.char;
    check('character tiles carry dataset.char', typeof c0 === 'string' && c0.length > 0, c0);
    charTile.dispatch('click');
    await settle(150);
    check('crumb appears on the character page',
          named.crumb.children.length === 2, named.crumb.children.length);
    const charAnims = Number(dbGet('SELECT n_anims n FROM anim_char WHERE char=?', c0).n);
    check('character page = ' + Math.min(PAGE, charAnims) + ' animation tiles',
          tiles().length === Math.min(PAGE, charAnims), tiles().length);
    const animTile = tiles()[0];
    animTile.dispatch('click');
    await settle();
    const eAnim = dbGet('SELECT * FROM assets WHERE path=?', animTile.dataset.path);
    const imgEls = named.detail.descend(named.detail).filter((n) => n.tagName === 'IMG');
    check('anim detail renders a stage with one <img>',
          !!named.detail.querySelector('.anim-stage') && imgEls.length === 1,
          imgEls.length);
    check('anim <img> points at the first frame',
          String(imgEls[0].src) === 'assets/' + eAnim.path, String(imgEls[0].src));
    const packAnim = dbGet('SELECT p.* FROM packs p WHERE p.id=?', eAnim.pack_id);
    check('anim detail names character + pack + season + tier + URL',
          metaText().indexOf(eAnim.char) >= 0 &&
          metaText().indexOf(packAnim.pack) >= 0 &&
          metaText().indexOf(String(packAnim.season)) >= 0 &&
          metaText().indexOf(String(packAnim.tier)) >= 0 &&
          metaText().indexOf(String(packAnim.url)) >= 0);
    await search('front_walk');
    const hits = tiles().map((t) => t.dataset.path);
    check('anim search "front_walk" lists matching distinct animations',
          hits.length >= 5 && hits.every((p) => p.indexOf('front_walk') >= 0),
          hits.length + ' hits: ' + hits.slice(0, 3).join(','));
    await search('');
    check('clearing search returns to the character page',
          tiles().length === Math.min(PAGE, charAnims), tiles().length);
    const back2 = named.crumb.children.find((n) => n.tagName === 'BUTTON');
    back2.dispatch('click');
    await settle(150);
    check('breadcrumb back returns to the character list',
          tiles().length === Math.min(PAGE, nChars) &&
          named.crumb.children.length === 0, tiles().length);

    console.log('movies tab:');
    await openTab('Movies');
    const nVid = cats.video || 0;
    check('Movies tab = ' + Math.min(PAGE, nVid) + ' tiles',
          tiles().length === Math.min(PAGE, nVid), tiles().length);
    const vidTile = tiles()[0];
    if (vidTile) {
        vidTile.dispatch('click');
        await settle();
        const e0 = dbGet('SELECT * FROM assets WHERE path=?', vidTile.dataset.path);
        const pack0 = dbGet('SELECT p.* FROM packs p WHERE p.id=?', e0.pack_id);
        const vidEls = named.detail.descend(named.detail).filter((n) => n.tagName === 'VIDEO');
        check('movie detail creates one <video> element', vidEls.length === 1, vidEls.length);
        check('movie <video> points at the mp4 asset',
              String(vidEls[0].src) === 'assets/' + e0.path, String(vidEls[0].src));
        check('movie detail tags the pack + season + tier',
              metaText().indexOf(pack0.pack) >= 0 &&
              metaText().indexOf(String(pack0.season)) >= 0 &&
              metaText().indexOf(String(pack0.tier)) >= 0);
    }

    console.log('data tab: (DB-backed text)');
    await openTab('Data');
    const dataTile = tiles().find((t) =>
        dbGet('SELECT 1 x FROM data_text WHERE path=?', t.dataset.path));
    check('a data tile with stored text exists', !!dataTile);
    if (dataTile) {
        dataTile.dispatch('click');
        await settle(150);
        const pre = named.detail.descend(named.detail)
            .find((n) => n.className === 'data-text');
        check('data detail shows the stored text', !!pre && pre.textContent.length > 0,
              pre && pre.textContent.slice(0, 30));
    }

    console.log('android tab:');
    await openTab('Android shell');
    check('Android tab = ' + Math.min(PAGE, cats.android || 0) + ' tiles',
          tiles().length === Math.min(PAGE, cats.android || 0), tiles().length);

    console.log('motion tab:');
    await openTab('Motion');
    const cvs = named.detail.descend(named.detail).filter((n) => n.tagName === 'CANVAS');
    check('3 motion canvases', cvs.length === 3, cvs.length);
    for (let i = 0; i < 5; i++) {
        clockNow += 16;
        const q = rafQueue.splice(0, rafQueue.length);
        q.forEach((cb) => cb(clockNow));
        await tick(1);
    }
    check('motion frames drew (drawImage > 0)', CTX_CALLS.drawImage > 0, CTX_CALLS.drawImage);
    const splashCard = named.detail.children[1];
    const selA = splashCard.querySelector('h3').children
        .find((c) => c.tagName === 'SELECT');
    selA.value = '4:3';
    selA.dispatch('change');
    check('aspect switch resizes splash canvas',
          cvs[0].width === 960 && cvs[0].height === 720, cvs[0].width + 'x' + cvs[0].height);

    console.log('search:');
    await openTab('All');
    await search('donut');
    const hits2 = tiles().map((t) => t.dataset.path);
    check('search "donut" finds the donut classes + every hit mentions it',
          hits2.length >= 12 && hits2.every((p) => {
              const e = dbGet('SELECT path, origin, family, res_class rc, kind FROM assets' +
                              ' WHERE path=?', p);
              return (e.path + ' ' + (e.origin || '') + ' ' + (e.family || '') + ' ' +
                      (e.rc || '') + ' ' + (e.kind || '')).toLowerCase()
                  .indexOf('donut') >= 0;
          }),
          hits2.length + ' hits: ' + hits2.slice(0, 4).join(','));

    console.log('detail API: one entry per sampled DLC pack');
    const packs = dbAll('SELECT pack FROM packs ORDER BY id LIMIT 40');
    let packMisses = 0;
    for (const pk of packs) {
        const r = dbGet('SELECT a.path, p.pack FROM assets a JOIN packs p ON p.id=a.pack_id' +
                        ' WHERE p.pack=? LIMIT 1', pk.pack);
        if (!r) { packMisses++; continue; }
        const j = fetchStubJson('op=asset&path=' + encodeURIComponent(r.path));
        if (!j.entry || !j.entry.dlc || j.entry.dlc.pack !== pk.pack) { packMisses++; }
    }
    check('sampled packs resolve via op=asset with dlc context',
          packMisses === 0, packMisses + ' misses');

    console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL CHECKS PASSED');
    process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
