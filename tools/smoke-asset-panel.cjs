// Behaviour smoke for asset-variants-pixi.js endpoint tiles: routing mirrors
// the map's __CV_DYNC (per-category cfg, preflight inventory, 25-failure
// breaker), failures fall back to pre-baked files and count on the shared
// breaker, and dynamic anim strips reconcile geometry via mode=meta.
// Stubs just enough DOM/Image/fetch to run render()/tile()/animTile().
// Usage: node tools/smoke-asset-panel.cjs
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const ROOT = path.join(__dirname, '..');

function mkEl(tag, dead) {
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
        set textContent(v) { this._text = v; if (v === '') this.children = []; },
        get textContent() { return this._text; },
        getContext() { return this._ctx = this._ctx || {
            draws: [], clears: 0, imageSmoothingEnabled: true,
            clearRect() { this.clears++; },
            drawImage() { this.draws.push(Array.from(arguments).map(Number)); },
        }; },
    };
    if (tag === 'img') {           // <img> loads like Image: next microtask,
        e.complete = false;        // honouring the run's dead() predicate
        e.naturalWidth = 0;
        Object.defineProperty(e, 'src', {
            set(u) {
                e._src = u;
                const bad = dead && dead(u);
                Promise.resolve().then(() => {
                    if (bad) {
                        e.complete = false; e.naturalWidth = 0;
                        if (e.onerror) e.onerror();
                    } else {
                        e.complete = true; e.naturalWidth = 50;
                        if (e.onload) e.onload();
                    }
                });
            },
            get() { return e._src; },
        });
    }
    return e;
}

// Image stub: loads are deferred a microtask so handlers wired AFTER the
// src assignment (as tile() does) still fire; Image.dead(url) -> error.
function freshImg(dead) {
    return class Image {
        constructor() { this.complete = false; this.naturalWidth = 0; }
        set src(u) {
            this._src = u;
            Image.requested.push(u);
            const bad = dead && dead(u);
            Promise.resolve().then(() => {
                if (bad) {
                    this.complete = false; this.naturalWidth = 0;
                    if (this.onerror) this.onerror();
                } else {
                    this.complete = true; this.naturalWidth = 50;
                    if (this.onload) this.onload();
                }
            });
        }
        get src() { return this._src; }
    };
}

function rows() {   // fresh objects per run (anim meta memoises on the row)
    return [
        { path: 'city/tree01.png', kind: 'sprite', w: 40, h: 60, res: 'city' },
        { path: 'city/grasstile.png', kind: 'sprite' },
        { path: 'menu/tree01_menu.png', kind: 'menu', res: 'menu' },
        { path: 'city/tree01_flipped.png', kind: 'flipped' },
        { path: 'city/nobake.png', kind: 'sprite' },
        { path: 'city/seasons/winter/tree01.png', kind: 'sprite' },
        { path: 'city/stacks/aircraftcarrier.png', kind: 'sprite' },
        { path: 'city/anims/tree01__Active.png', kind: 'anim', name: 'Active',
          frames: 4, cols: 2, cellw: 100, cellh: 80, fps: 12, ax: 0, ay: 0 },
    ];
}
const INV = { inv: { tree01: 3, tree01_flipped: 3, aircraftcarrier: 3 },
              flags: ['flag_sweden'] };
const META = { frames: 4, cols: 2, cellw: 101, cellh: 80, ax: 1, ay: 2,
               fps: 12, sparse: 1,
               sub: [[{ sx: 0, sy: 0, w: 50, h: 40, ox: 5, oy: 6 }]] };

function boot(o) {
    o = o || {};
    const img = freshImg(o.dead);
    img.requested = [];
    const fetches = [];
    const D = {
        cfg: Object.assign({ sprites: true, seasons: true, anims: true,
                             stacks: true }, o.cfg),
        box: {}, fails: Object.assign({ sprite: 0, season: 0, anim: 0,
                                        stack: 0, flag: 0 }, o.fails),
        urlv: '?v=test',
        inv: () => (o.noInv ? null : INV),
    };
    const sandbox = {
        document: { createElement: (tag) => mkEl(tag, o.dead) },
        Image: img,
        requestAnimationFrame: () => 1,
        cancelAnimationFrame: () => {},
        console, setTimeout,
        fetch: (url, opt) => {
            fetches.push({ url, method: (opt && opt.method) || 'GET' });
            if (/mode=meta/.test(url)) {
                return Promise.resolve({ ok: true,
                    json: () => Promise.resolve(o.meta === null ? null : META) });
            }
            return Promise.resolve({ ok: true, headers: {
                get: (h) => (h === 'content-length' ? '2048' : null) } });
        },
        MAP_DATA: { variants: { [o.slug || 'test']: rows() } },
        CITY_FLAGS: o.noFlags ? null : {
            flag_sweden: { png: 'flags/flag_sweden.png', w: 89, h: 114,
                           anchor: [3, 409] } },
        __CV_DYNC: D,
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    const src = fs.readFileSync(
        path.join(ROOT, 'web/viewer/asset-variants-pixi.js'), 'utf8');
    vm.runInContext(src, sandbox, { filename: 'asset-variants-pixi.js' });
    const box = sandbox.AssetVariants.render(o.slug || 'test', o.name);
    const tiles = box.children[1].children;
    const flush = () => new Promise((r) => setTimeout(r, 20));
    return { box, tiles, img, fetches, D, flush, sandbox };
}

let fails = 0;
function check(cond, label) {
    console.log((cond ? 'ok   ' : 'FAIL ') + label);
    if (!cond) fails++;
}
const srcOf = (t) => t.children[0].children[0].src;    // .vpic > img
const sizeOf = (t) => t.children[t.children.length - 1];

(async () => {
    // ---- all categories on ---------------------------------------------------
    let S = boot();
    await S.flush();
    const tSprite = S.tiles[0], tGrass = S.tiles[1], tMenu = S.tiles[2],
          tFlip = S.tiles[3], tNoBake = S.tiles[4], tSeason = S.tiles[5],
          tStack = S.tiles[6], tAnim = S.tiles[7];
    check(/api\/bsprite\.php\?kind=sprite&name=tree01&v=test$/.test(srcOf(tSprite)),
          'sprite row routes to the endpoint');
    check(srcOf(tGrass) === '../assets/city/grasstile.png',
          'grasstile stays a plain file (endpoint-exempt)');
    check(srcOf(tMenu) === '../assets/menu/tree01_menu.png',
          'manifest-pack copy stays a plain file');
    check(/kind=sprite&name=tree01_flipped/.test(srcOf(tFlip)),
          'flipped twin routes through the endpoint (pool stem)');
    check(srcOf(tNoBake) === '../assets/city/nobake.png',
          'stem missing from the preflight inventory stays pre-baked');
    check(/kind=season&name=tree01&cls=winter/.test(srcOf(tSeason)),
          'season row routes to kind=season');
    check(/kind=stack&name=aircraftcarrier/.test(srcOf(tStack)),
          'stack row routes to kind=stack');
    check(S.img.requested.some((u) =>
          /kind=anim&name=tree01&png=anims\/tree01__Active\.png/.test(u)),
          'anim row routes to kind=anim');
    check(tSprite.href === '../assets-explorer.php?path=city%2Ftree01.png',
          'deep link still points at the pre-baked file');

    let F;
    // ---- flag cloth row (SwedenFlag bid on the shared Flag_Pole asset) --------
    F = boot({ slug: 'flag_pole', name: 'SwedenFlag' });
    await F.flush();
    check(F.tiles.length === 9, `flag_pole card gains the cloth tile (${F.tiles.length})`);
    const tFlag = F.tiles[8];
    check(/api\/bsprite\.php\?kind=flag&name=flag_sweden&v=test$/.test(srcOf(tFlag)),
          'cloth row routes to kind=flag');
    check(tFlag.href === '../assets-explorer.php?path=city%2Fflags%2Fflag_sweden.png',
          'cloth deep link points at the pre-baked file');
    F = boot({ slug: 'flag_pole', name: 'SwedenFlag', cfg: { sprites: false } });
    await F.flush();
    check(srcOf(F.tiles[8]) === '../assets/city/flags/flag_sweden.png',
          'cfg.sprites=false → cloth tile draws the pre-baked file');
    F = boot({ slug: 'flag_pole', name: 'SwedenFlag', noFlags: true });
    await F.flush();
    check(F.tiles.length === 8, 'no city-flags.json → no cloth row');
    F = boot({ slug: 'flag_pole', name: 'RainbowFlag' });
    await F.flush();
    check(F.tiles.length === 8, 'bid whose own slug is the art gets no cloth row');
    F = boot({ slug: 'flag_pole', name: 'SwedenFlag', noInv: true });
    await F.flush();
    check(srcOf(F.tiles[8]) === '../assets/city/flags/flag_sweden.png',
          'inventory not settled → cloth stays pre-baked');
    F = boot({ slug: 'flag_pole', name: 'SwedenFlag', dead: (u) => /bsprite\.php/.test(u) });
    await F.flush();
    check(srcOf(F.tiles[8]) === '../assets/city/flags/flag_sweden.png' &&
          F.D.fails.flag >= 1,
          `dead endpoint → cloth falls back and counts on the breaker (${F.D.fails.flag})`);

    // ---- sizes: dynamic HEADs only after the tile warmed the cache ----------
    const heads = S.fetches.filter((f) => f.method === 'HEAD');
    check(heads.some((f) => /kind=sprite&name=tree01&v=test$/.test(f.url)),
          'dynamic tile size HEADs the endpoint URL (after its own load)');
    // the shipped ASSET_V starts with '?' — a second '?' would fold into the
    // previous param's value and PHP would 404 the request (mounthomermore01)
    const epUrls = S.img.requested
        .concat(S.tiles.filter((t) => t.children[0].tag !== 'canvas').map(srcOf))
        .concat(S.fetches.map((f) => f.url))
        .filter((u) => /bsprite\.php/.test(u));
    check(epUrls.length > 0 && epUrls.every((u) => /^[^?]+\?[^?]*$/.test(u)),
          'every endpoint URL has exactly one ? (cache-buster joins with &)');
    check(heads.some((f) => f.url === '../assets/city/nobake.png'),
          'pre-baked tile HEADs the file immediately');
    await S.flush();
    check(sizeOf(tSprite).textContent === '2 KB',
          `dynamic size line renders served bytes (${sizeOf(tSprite).textContent})`);

    // ---- anim meta reconcile --------------------------------------------------
    const metas = S.fetches.filter((f) => /mode=meta/.test(f.url));
    check(metas.length === 1 && /kind=anim&name=tree01/.test(metas[0].url),
          'anim strip pulled mode=meta exactly once');
    const cv = tAnim.children.find((c) => c.tag === 'canvas');
    const row = S.sandbox.MAP_DATA.variants.test[7];
    check(row.cellw === 101 && cv.width === 101,
          `meta geometry applied to row + canvas (cellw ${row.cellw}, cv ${cv.width})`);
    check(cv._ctx.draws.some((a) => a[5] === 6 && a[6] === 8),
          'sparse shelf drawn from meta sub (ox+ax, oy+ay)');

    // ---- per-category config off ----------------------------------------------
    S = boot({ cfg: { sprites: false, anims: false } });
    await S.flush();
    check(S.tiles[0].children[0].children[0].src === '../assets/city/tree01.png',
          'cfg.sprites=false → pre-baked body');
    check(S.tiles[7].children.find((c) => c.tag === 'canvas') &&
          S.img.requested.some((u) => u === '../assets/city/anims/tree01__Active.png'),
          'cfg.anims=false → pre-baked strip, no meta fetch');
    check(!S.fetches.some((f) => /mode=meta/.test(f.url)),
          'cfg.anims=false → strip not asked for meta either');

    // ---- inventory not settled (boot race) ------------------------------------
    S = boot({ noInv: true });
    await S.flush();
    check(S.tiles.filter((t) => t.children[0].tag !== 'canvas')
              .every((t) => !/bsprite/.test(srcOf(t))) &&
          S.img.requested.length > 0 &&
          S.img.requested.every((u) => !/bsprite/.test(u)),
          'inventory not settled → every tile pre-baked');

    // ---- endpoint dead → pre-baked swap + shared breaker ----------------------
    S = boot({ dead: (u) => /bsprite\.php/.test(u) });
    await S.flush();
    check(srcOf(S.tiles[0]) === '../assets/city/tree01.png',
          'dead endpoint → sprite tile falls back to the file');
    check(S.D.fails.sprite >= 1 && S.D.fails.anim >= 1,
          `fallbacks counted on the shared breaker (sprite ${S.D.fails.sprite}, anim ${S.D.fails.anim})`);
    check(S.img.requested[S.img.requested.length - 1] ===
          '../assets/city/anims/tree01__Active.png',
          'dead endpoint → anim strip falls back to the file');
    const row7 = S.sandbox.MAP_DATA.variants.test[7];
    const cv7 = S.tiles[7].children.find((c) => c.tag === 'canvas');
    check(row7.cellw === 100 && cv7.width === 100,
          `fallback restores manifest geometry (cellw ${row7.cellw}, cv ${cv7.width})`);

    // ---- breaker tripped → straight to files ----------------------------------
    S = boot({ cfg: { seasons: false, stacks: false },
               fails: { sprite: 25, anim: 25 } });
    await S.flush();
    const allSrc = S.tiles.filter((t) => t.children[0].tag !== 'canvas')
        .map(srcOf).concat(S.img.requested);
    check(!allSrc.some((u) => /bsprite\.php/.test(u)),
          'breaker at 25 → no endpoint requests at all');
    check(!S.fetches.some((f) => /mode=meta/.test(f.url)),
          'breaker at 25 → no meta requests either');

    console.log('FAILURES: %d', fails);
    process.exit(fails ? 1 : 0);
})();
