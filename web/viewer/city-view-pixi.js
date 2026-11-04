/* city-view-pixi.js — City View rebuilt on PixiJS (Phase 2, M3/P).
   Same workbench as js/city-view.js (chrome, toggles, panels, hit-testing,
   presets, verdict tools all ported), but the whole scene renders through
   ONE PixiJS canvas instead of the Canvas2D + hybrid-WebGL stack:

     · ground  — one Container whose per-frame matrix is CAM.tileAffine, so
       everything static IN TILE SPACE is placed once and never re-projected:
       the grass TilingSprite, the sea quad, ~4k flat feature quads, the
       road sheet cells (diamond-cleaned sprites, rotate 45° + scale — the
       engine's own inset UV quads, pre-masked on a copy of the sheet), the
       manholes, the avenue cells, and the two zoomed-out flat atlas blits.
     · scene   — a screen-space sprite POOL refilled from index 0 each
       frame in depth order (prism faces are UNIT-quad sprites driven by a
       parallelogram matrix; billboards and people dots are ordinary
       sprites), so painter order needs no sorting and one Pixi batch
       covers the whole town.
     · overlays— grid / wire / walks / markers / proposed / frags /
       selection outlines are per-frame Pixi Graphics + pooled Text,
       stacked in the original draw order.

   Shared modules (../js/) are reused verbatim for everything DOM-free:
   camera.js, terrain.js (data model only — terrain.render() is NEVER
   called), objects.js (legend classifier), walks.js (census), markers.js
   (parse). Their canvas-draw functions are re-implemented here on Pixi.

   No custom shaders and no Assets.load for the sprite PNGs: every texture
   comes from an Image element wrapped in PIXI.Texture, so the page keeps
   the original's file:// compatibility. The renderer is WebGL-only.

   Data: window.MAP_DATA (js/map-explorer-data.js). */
'use strict';

(function () {
    var M = window.MAP_DATA;
    var $ = function (id) { return document.getElementById(id); };
    var B = '../';                        // page lives in web/viewer/
    /* cache-buster for the generated city art: the sprite/atlas PNGs are
       re-written in place by tools/gen_city_sprites.py, so bump this (and the
       ?v= of this script in index.html) whenever the pipeline regenerates
       them — otherwise the browser keeps the previous render (e.g. a
       building's old snowy art) whatever the pool says */
    var ASSET_V = '?v=20261102.1';
    // Bump whenever city/*.png art changes — the sprites, filmstrip atlases
    // and stack sheets all load through cityUrl(), and a stale cached PNG
    // against fresh city-anims.json sub-rects draws sparse water from wrong
    // shelf spots (the "water attached incorrectly" report, round 6).
    var MANIFEST_V = '?v=20261104.2';           // city-sprites/-anims.json
    function cityUrl(p) { return dynCityUrl(p) || preUrl(p); }

    var stage = $('stage');
    var cv = $('cv');
    var dpr = 1, VW = 0, VH = 0;

    /* perf-debug URL params (subset of city-view.js's knobs): ?dpr=1 caps
       the backing store; the ART/anim knobs are read with their own code
       below. There is no nogl knob — this page is WebGL-only. */
    var QP = (function () {
        try { return new URLSearchParams(location.search); }
        catch (e) { return { get: function () { return null; } }; }
    })();

    if (!window.PIXI) {
        $('statsbar').textContent = 'PixiJS failed to load (vendor/pixi.min.js)';
        return;
    }

    function rgbHex(a) { return (a[0] << 16) | (a[1] << 8) | a[2]; }
    function esc(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    /* ---- asset loading indicator ---------------------------------------------
       One toolbar pill tracks every remote pull: the two boot textures and
       two art manifests get a counted progress bar (assets 2/4), then the
       Art layer's on-demand sprite PNGs stream through the same pill.
       Failed assets count as settled — every one of them has a degrade
       path (flat grass / flat roads / blocks / dots). window.__ASSETS
       exposes the counters for console + harness.

       The counters count ART FILES, not HTTP hits. A filmstrip the LRU
       dropped and the player panned back to is the same file, so it must not
       move the number a second time — seen[] is what keeps "got" from
       outrunning "known". The known total is every file the viewer can ask
       for: body PNGs, season variants, character sheets, pier sheets and the
       filmstrips it registered from city-anims.json. */
    var ALOAD = { boot: 5, bootDone: 0, pend: 0, artGot: 0, artKnown: 0,
                  artDead: 0, dynErr: 0, strips: 0, req: 0, seen: {}, hist: [],
                  trace: 0, tr: [] };
    window.__ASSETS = ALOAD;
    function artCounted(url) {              // true once per art file
        if (ALOAD.seen[url]) return false;
        ALOAD.seen[url] = 1;
        if (ALOAD.hist.length < 40000) ALOAD.hist.push(url);
        return true;
    }
    function aPaint() {
        var el = $('assets');
        if (!el) return;
        var html = null;
        if (ALOAD.bootDone < ALOAD.boot) {
            var p = Math.round(ALOAD.bootDone * 100 / ALOAD.boot);
            html = '<i style="width:' + Math.max(3, p) + '%"></i>assets ' +
                ALOAD.bootDone + '/' + ALOAD.boot;
        } else if (ALOAD.pend > 0 || (artMode === 1 && ALOAD.artKnown)) {
            var q = ALOAD.artKnown
                ? Math.round(ALOAD.artGot * 100 / ALOAD.artKnown) : 0;
            html = '<i style="width:' + Math.max(3, q) + '%"></i>art ' +
                ALOAD.artGot.toLocaleString() + '/' + ALOAD.artKnown.toLocaleString() +
                (ALOAD.pend ? ' \u00b7 ' + ALOAD.pend + ' loading' : '') +
                (ALOAD.artDead ? ' \u00b7 ' + ALOAD.artDead + ' dead' : '') +
                (ALOAD.dynErr ? ' \u00b7 ' + ALOAD.dynErr +
                                 ' dyn err' : '');
        }
        if (html === null) { el.classList.add('off'); return; }
        el.classList.remove('off');
        el.innerHTML = html;
    }
    var aT = 0;
    function aPaintSoon() {                 // throttle the per-PNG settle storm
        var n = Date.now();
        if (n - aT > 120) { aT = n; aPaint(); }
        else setTimeout(aPaint, 125);       // trailing paint so the bar settles
    }
    function aBootSettled() { ALOAD.bootDone++; aPaintSoon(); }
    aPaint();                               // "assets 0/5" before anything lands

    /* ---- texture cache ---------------------------------------------------------
       Every sprite texture comes from a plain Image element (file:// safe —
       PIXI.Assets.load's fetch path is not), wrapped in a PIXI.Texture once
       it decodes. texFor(url) returns null while loading/failed and marks
       the scene dirty on settle, mirroring city-view.js's imgFor. */
    var texs = {};
    function texFor(url) {
        if (ALOAD.trace && ALOAD.tr.length < 8000) ALOAD.tr.push(url);
        var r = texs[url];
        if (r === undefined) {
            ALOAD.pend++; ALOAD.req++; aPaintSoon();  // streams through the asset pill
            r = texs[url] = { st: 0, tex: null, subs: {} };
            var im = new Image();
            if (ALOAD.seen[url]) animReloads++;     // evicted, now asked for again
            im.onload = function () {
                var dead = 0;
                try { r.tex = PIXI.Texture.from(im); r.st = 1; }
                catch (e) { r.st = -1; dead = 1; }
                ALOAD.pend--;
                if (artCounted(url)) { if (dead) ALOAD.artDead++; else ALOAD.artGot++; }
                markDirty(); aPaintSoon();
            };
            im.onerror = function () {      // degrade to block/dot
                r.st = -1;
                ALOAD.pend--;
                if (artCounted(url)) ALOAD.artDead++;
                markDirty(); aPaintSoon();
            };
            im.src = url;
        }
        return r.st === 1 ? r.tex : null;
    }
    function texDead(url) { return texs[url] && texs[url].st === -1; }
    /* sub-texture of an already-decoded texture (filmstrip cells / sparse
       rects / sheet cells): cached per (url, rect) — the cells are ordinary
       Textures sharing the decoded source upload. */
    function subTex(url, x, y, w, h) {
        var r = texs[url];
        if (!r || r.st !== 1) return null;
        var key = x + ',' + y + ',' + w + ',' + h;
        var t = r.subs[key];
        if (t === undefined) {
            t = r.tex;
            if (x || y || w !== r.tex.width || h !== r.tex.height)
                t = new PIXI.Texture({ source: r.tex.source,
                                       frame: new PIXI.Rectangle(x, y, w, h) });
            r.subs[key] = t;
        }
        return t;
    }
    /* free the decode behind a url. counted=1 from the eviction paths (the
       telemetry the console reads: a resident strip that comes back is a
       re-decode, so drops and reloads must be countable). */
    function dropTex(url, counted) {
        var r = texs[url];
        if (animBig[url]) { delete animBig[url]; animBigLive--; }
        if (!r) return;
        if (counted) animDrops++;           // telemetry: decodes freed by eviction
        for (var k in r.subs) delete r.subs[k];
        if (r.tex) { try { r.tex.destroy(true); } catch (e) { /* GC */ } }
        delete texs[url];
    }

    /* ---- grass texture (optional; flat grass if it fails to load) ---------- */
    var grassTex = null;
    (function () {
        var im = new Image();
        im.onload = function () { grassTex = PIXI.Texture.from(im); markDirty(); aBootSettled(); };
        im.onerror = function () { aBootSettled(); /* keep flat grass */ };
        im.src = cityUrl('grasstile.png');
    })();

    /* ---- season mode (2026-10-25, ported from city-view.js) -------------------
       TSTO shipped no season switch: during an event the CDN RE-SHIPPED the
       same building slugs with themed art (snow, fall leaves, halloween
       costumes). The generator filed the byte-different re-ships as per-slug
       variants under assets/city/seasons/<class>/<slug>.png, listed in each
       city-sprites.json entry's `seasons` map. The toggle is a pure data
       overlay: swap the sprite entry + the road sheet. Event-only art
       (holidaytree) has no base twin and shows as-is in every mode.
       Filmstrip anims were cut from the BASE sheet, so a building drawn
       from a season sprite stays static (animOf gates it). Shares the
       localStorage key with the Canvas page. */
    var SEASON = { mode: 'base', present: {} };       // present: class -> slug count
    window.__CV_SEASON = SEASON;                      // harness/debug hook
    var SEASON_ORDER = ['winter', 'fall', 'halloween', 'easter', 'valentine',
                        'july4th', 'stpatricks', 'pride', 'summer'];
    var SEASON_LABEL = { winter: 'Winter', fall: 'Autumn', halloween: 'Halloween',
        easter: 'Easter', valentine: 'Valentine', july4th: 'July 4th',
        stpatricks: "St Patrick's", pride: 'Pride', summer: 'Summer' };
    var SEASON_KEY = 'mrsnrub.cityview.season';
    try {
        var _sm = localStorage.getItem(SEASON_KEY);
        if (_sm) SEASON.mode = _sm;
    } catch (e) { /* private mode */ }
    function spriteEntry(key) {                        // season-aware manifest entry
        var sp = citySprites && citySprites[key];
        if (sp && SEASON.mode !== 'base' && sp.seasons) {
            var v = sp.seasons[SEASON.mode];
            if (v) return v;
        }
        return sp;
    }
    function applySeasonMode() {
        var b = $('btn-season');
        if (b) {
            b.classList.toggle('on', SEASON.mode !== 'base');
            b.textContent = 'Season\u00b7' + (SEASON.mode === 'base'
                ? 'base' : (SEASON_LABEL[SEASON.mode] || SEASON.mode));
        }
        applyRoadSheet();
    }

    /* ---- road sheet art (real roadrivertiles base tiles, notes/06 §10) -----
       terrain.js stays DOM-free, so the page owns the Image. The 512x512
       sheet (loaded from the 1024² -100 tier, the same tier as the building
       art; tables stay in 512-space) is a tessellation of 135x74 2:1 cell diamonds; the engine draws
       each cell from its 127x66 INSET box (the RoadDrawer UV quads at
       .rodata 0x400520), which on the Canvas page was clipped to the
       diamond per tile. Pixi sprites cannot clip, so once the sheet decodes
       we build ONE cleaned copy: each used cell slot is clipped to its
       inscribed diamond once, offscreen. Sprites blitting a cleaned slot
       then need no mask — the corner garbage the lattice packing leaves
       outside the diamond is already transparent.
       Winter: the XMAS RiverRoadTiles pack re-shipped the same 512x512
       layout as icy tiles, so winter mode rebuilds the cleaned copy from
       that sheet instead (grass stays green, matching the game). */
    var sheetReady = false;
    var sheetCanvas = null;
    var SHEET_UE = {};                       // "c,r" -> [c,r] used by SHEET_STATES
    (function () {
        var S = CityTerrain.SHEET_STATES;
        for (var i = 0; i < S.length; i++) SHEET_UE[S[i][0] + ',' + S[i][1]] = S[i];
    })();
    var roadSheetImg = null, iceSheetImg = null;
    /* Strip pieces for the 3-pass composites (states 3/4 clipped to
       the grass-side strip, js/terrain.js sheetClipPoly): pixi sprites
       cannot clip at runtime, so bake them ONCE into a small canvas,
       one 127x66 slot per (state, side). The 4th entry is the
       PRE-MIRROR clip for the flipped px pass: a negative-scaleX
       sprite mirrors the texture together with its baked alpha, so
       baking nx and flipping yields the canvas page's px clip. */
    var PIECE_DEFS = [[3, 'ny'], [4, 'py'], [4, 'nx'], [3, 'nx']];
    var PIECE_IX = {};
    (function () {
        for (var i = 0; i < PIECE_DEFS.length; i++)
            PIECE_IX[PIECE_DEFS[i][0] + PIECE_DEFS[i][1]] = i;
    })();
    /* ---- Road art·spec constants (road-lab tuned 2026-10-25) ---------------
       Carriageway 2.5 tiles wide on each axis centred in the 4x4 cell,
       0.75-tile footpath strips on the non-connected sides; 'P' = one
       uniform pavement slab. With the sheet loaded the cell is drawn the
       way the RE'd engine draws it (see buildSpecCell): FOUR half-cell
       quadrant quads, each sampling one full state diamond from the
       engine selector table (notes/08). Without the sheet, flat UNIT
       rects in these colours. Declared here for the flat fallback. */
    var SPEC = { FW: 0.75, foot: 0x9c9ca3, asphalt: 0x5c5c62, pave: 0x7e7e85 };
    var pieceCanvas = null;
    /* river quads are ready once the full-res base sheet texture exists
       (see buildSheetCanvas / rivSheetTex) */
    var rivReady = false;
    /* ---- engine-true quadrant model (road-lab 2026-10-25, notes/08) --------
       Selector 0x1208058 family table + flip byte, kerb orientations
       pixel-verified against roadtilesheet.png: state 3 kerb W / 4 kerb N
       (1 = both), 5 = N+E corner, 8 = W+S corner, 7 kerb N, 10 kerb W.
       The ES quadrant ALWAYS draws mirrored (out=1 forced on the (2,2)
       path 0x1208644); NE mirrors its 7 for the N-only case, WS mirrors
       10 for the W-only case, so the kerb band always sits on the CLOSED
       edge. Blit orientation: rot45 with the box v axis NEGATED —
       sheet diamond L->TL T->BL B->TR R->BR (plain rot45 transposes the
       art across the main diagonal). Keep in sync with road-lab.js. */
    var ENG_FAM = {
        nw: { both: 2, first: 3, second: 4, none: 1 },   // tests N, W
        ne: { both: 6, one: 7, none: 5 },                 // tests N, E
        ws: { both: 9, one: 10, none: 8 },                // tests W, S
        es: { both: 2, first: 3, second: 4, none: 1 },    // tests E, S
    };
    function engStates(p) {
        function f2(f, a, b) { return a && b ? f.both : a ? f.first : b ? f.second : f.none; }
        function f1(f, a, b) { return a && b ? f.both : (a || b) ? f.one : f.none; }
        return {
            nw: f2(ENG_FAM.nw, p.n, p.w), ne: f1(ENG_FAM.ne, p.n, p.e),
            ws: f1(ENG_FAM.ws, p.w, p.s), es: f2(ENG_FAM.es, p.e, p.s),
        };
    }
    function engFlip(p, q) {
        if (q === 'es') return true;
        if (q === 'ne') return !!p.n && !p.e;
        if (q === 'ws') return !!p.w && !p.s;
        return false;
    }
    /* ---- engine-true RIVER model (road-lab water tab 2026-10-26, notes/09 §9) --
       RiverDrawer (vptr 0x1a2bf30) is RoadDrawer's subclass and its build
       wrapper 0x1099f20 loads selector 0x1099f8c then bl 0x1208c10 — the SAME
       draw body the roads reach — so the cell model carries over verbatim:
       four half-cell quadrant quads, one UV parallelogram each, ES quadrant
       forces the flip byte, pass rule = nibble OR (neighbour contains AND
       solid). Differences from roads, both re-measured on the art itself:
       the quadrant family table is the road table with entries 0<->1
       exchanged (river 1 = open-water slab, river 0 = W+N shore corner —
       no identity fallback and no special-flag route, so the slab must come
       from the family table), and the 11 UV quads come from their own float
       table .rodata 0x3fc320 (NOT the fitted lattice): they land on the 13
       water cells of the SAME roadrivertiles sheet that the road census
       left unused. The flip is the same ANTI-DIAGONAL reflection (baked as
       the second orientation per state); verified on water art — flipped
       state 0 banks E+S, 7 banks E, 10 banks S. Keep in sync with the
       road-lab water tab (road-lab.js WATER/RIVER_*). */
    var RIVER_QUADS = [    // [T, R, L, B] in 512-space sheet px, x512 = px
        [[272.74, 32.58], [336.54, 65.82], [209.32, 65.82], [272.99, 98.79]],
        [[206.07, 441.77], [269.62, 474.79], [142.29, 474.73], [205.95, 507.71]],
        [[272.86, 329.69], [336.73, 362.79], [209.45, 362.72], [272.96, 395.88]],
        [[274.55, 256.04], [337.66, 288.98], [211.52, 289.01], [274.52, 321.80]],
        [[273.87, 181.62], [337.53, 214.75], [210.15, 214.72], [273.90, 247.89]],
        [[272.81, 404.74], [336.49, 437.74], [209.30, 437.77], [272.94, 470.80]],
        [[136.66, 107.56], [200.17, 140.74], [73.27, 140.77], [136.71, 173.90]],
        [[135.38, 34.11], [198.49, 67.03], [72.28, 66.99], [135.55, 99.78]],
        [[69.61, 367.99], [132.74, 401.06], [6.19, 401.02], [69.48, 433.67]],
        [[70.43, 443.16], [133.52, 476.08], [7.74, 475.96], [70.47, 508.53]],
        [[137.26, 405.15], [200.09, 437.92], [74.39, 437.97], [137.22, 470.69]],
    ];
    var RIV_FAM = {
        nw: { both: 2, first: 3, second: 4, none: 0 },   // tests N, W (first=N, second=W)
        ne: { both: 6, one: 7, none: 5 },                 // tests N, E
        ws: { both: 9, one: 10, none: 8 },                // tests W, S
        es: { both: 2, first: 3, second: 4, none: 0 },    // tests E, S (first=E, second=S)
    };
    function rivStates(p) {
        /* d* = the quadrant's DIAGONAL neighbour is open water toward us on
           both of its faces (see buildRivCell). The engine reaches the pure
           open-water slab (state 1) only when that diagonal is solid, and
           otherwise uses the both-pass tiles 2/6/9, whose corner carries the
           diagonal cell's bank art (notes/09 §9 "Pack bleed"). Inside an open
           pond there is no bank there, so that corner is neighbouring-cell
           bleed — the reported "land speck" — and we take the slab instead:
           still 100% shipped art, and state 1 is the only slot that is fully
           water, so the pond stops showing a grid of three different blues.
           Where the diagonal IS land/solid the 2/6/9 corner art is meaningful,
           so it stays exactly as the engine picks it. */
        function f2(f, a, b, d) { return a && b ? (d ? 1 : f.both) : a ? f.first : b ? f.second : f.none; }
        function f1(f, a, b, d) { return a && b ? (d ? 1 : f.both) : (a || b) ? f.one : f.none; }
        return {
            nw: f2(RIV_FAM.nw, p.n, p.w, p.dnw), ne: f1(RIV_FAM.ne, p.n, p.e, p.dne),
            ws: f1(RIV_FAM.ws, p.w, p.s, p.dws), es: f2(RIV_FAM.es, p.e, p.s, p.des),
        };
    }
    function rivFlip(p, q) {          // same rules as engFlip (shared emitter)
        if (q === 'es') return true;
        if (q === 'ne') return !!p.n && !p.e;
        if (q === 'ws') return !!p.w && !p.s;
        return false;
    }
    /* ---- the engine-true quadrant draw: UV meshes ---------------------------
       The engine's quadrant quad IS the UV parallelogram: its four vertices
       carry the sheet diamond's UVs, so nothing outside that parallelogram is
       ever rasterised and nothing is ever blended (the quads are opaque).
       We do exactly that: each quadrant is a 4-vertex PIXI.Mesh over the
       unit square (tile space, scaled to the half-cell), with the table's
       four UV corners. One resample, straight from the FULL-RES sheet to the
       screen. (Until 2026-10-27 each slot was first baked into a 127x66
       axis-aligned canvas from the 512² tier and the sprite warped back by
       the ground matrix: a 2x upscale plus two bilinear passes — the
       "blurry roads" report. notes/09 §6.)
       Corner assignment (square corner -> sheet point): unflipped
       TL->L TR->B BR->R BL->T; the selector's flip byte swaps the UV pairs
       to the ANTI-DIAGONAL reflection TL->R TR->B BR->L BL->T — not a
       horizontal mirror (notes/09 §6 step 3). Tables are in 512-space sheet
       px, so u,v = px / 512 for every tier. */
    var ROAD_QUADS = [    // [T, R, L, B], RoadDrawer UV table .rodata 0x400520 x512
        [[205.72, 367.73], [269.22, 400.71], [142.38, 400.72], [205.77, 433.83]],
        [[205.50, 292.78], [268.59, 325.77], [142.22, 325.78], [205.57, 358.56]],
        [[137.28, 329.73], [200.84, 362.76], [74.27, 362.78], [137.39, 395.94]],
        [[69.79, 292.81], [133.03, 325.81], [6.81, 325.86], [69.91, 358.81]],
        [[137.34, 255.60], [200.85, 288.64], [74.25, 288.68], [137.43, 321.62]],
        [[205.76, 144.61], [269.14, 177.66], [142.24, 177.62], [205.79, 210.74]],
        [[68.65, 144.68], [132.12, 177.71], [5.35, 177.70], [68.75, 210.82]],
        [[203.73, 70.57], [267.20, 103.69], [140.49, 103.74], [203.70, 136.71]],
        [[206.29, 218.26], [269.53, 251.08], [142.68, 251.17], [206.21, 283.68]],
        [[69.45, 218.63], [133.13, 251.75], [6.56, 251.68], [69.75, 284.89]],
        [[137.71, 181.61], [200.92, 214.74], [74.38, 214.77], [137.62, 247.63]],
    ];
    var quadGeoms = {};                      // 'r3f' -> shared MeshGeometry
    function quadGeom(kind, st, flip) {
        var key = kind + st + (flip ? 'f' : '');
        if (quadGeoms[key]) return quadGeoms[key];
        var q = (kind === 'r' ? ROAD_QUADS : RIVER_QUADS)[st];
        if (!q) return null;
        var T = q[0], R = q[1], L = q[2], Bo = q[3];
        var c = flip ? [R, Bo, L, T] : [L, Bo, R, T];   // TL, TR, BR, BL
        var uv = new Float32Array(8);
        for (var i = 0; i < 4; i++) { uv[2 * i] = c[i][0] / 512; uv[2 * i + 1] = c[i][1] / 512; }
        return (quadGeoms[key] = new PIXI.MeshGeometry({
            positions: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
            uvs: uv, indices: new Uint32Array([0, 1, 2, 0, 2, 3]) }));
    }
    /* one quadrant quad in tile space: unit square at (x, y) scaled to hs */
    function quadMesh(parent, kind, st, flip, tex, x, y, hs) {
        var g = quadGeom(kind, st, flip);
        if (!g || !tex) return null;
        var me = new PIXI.Mesh({ geometry: g, texture: tex });
        me.position.set(x, y);
        me.scale.set(hs, hs);
        parent.addChild(me);
        return me;
    }
    var roadHiTex = null, iceHiTex = null;   // full-res sheets as Pixi textures
    function buildSheetCanvas() {            // cleaned copy of the ACTIVE sheet
        var im = (SEASON.mode === 'winter' && iceSheetImg) ? iceSheetImg : roadSheetImg;
        if (!im) return;
        /* the legacy modes' lattice maths is in 512-space: their cleaned
           copies are built at 512 from whatever tier loaded (k = tier scale) */
        var k512 = im.naturalWidth / 512;
        try {
            sheetCanvas = document.createElement('canvas');
            sheetCanvas.width = 512; sheetCanvas.height = 512;
            var c2 = sheetCanvas.getContext('2d');
            for (var k in SHEET_UE) {
                var slot = SHEET_UE[k];
                var cx = 274 + 135 * slot[0] + (((slot[1] % 2) + 2) % 2) * 67.5;
                var cy = 140 + 37 * slot[1];
                c2.save();
                c2.beginPath();
                c2.moveTo(cx - 63.5, cy); c2.lineTo(cx, cy - 33);
                c2.lineTo(cx + 63.5, cy); c2.lineTo(cx, cy + 33);
                c2.closePath();
                c2.clip();
                c2.drawImage(im, 0, 0, 512, 512);
                c2.restore();
            }
            /* strip pieces for the LEGACY sheet-composite modes (1–3):
               the 127x66 box's inscribed diamond IS the tile diamond, so
               the shared polygon applies verbatim in box space. */
            var bq = [{ x: -63.5, y: 0 }, { x: 0, y: -33 },
                { x: 63.5, y: 0 }, { x: 0, y: 33 }];
            function bakePieces(cv, clipFn) {
                cv.width = 128 * PIECE_DEFS.length;
                cv.height = 66;
                var g = cv.getContext('2d');
                for (var pi = 0; pi < PIECE_DEFS.length; pi++) {
                    var ps = CityTerrain.SHEET_STATES[PIECE_DEFS[pi][0]];
                    var pcx = 274 + 135 * ps[0] + (((ps[1] % 2) + 2) % 2) * 67.5;
                    var pcy = 140 + 37 * ps[1];
                    var poly = clipFn(bq, PIECE_DEFS[pi][1]);
                    g.save();
                    g.translate(pi * 128 + 63.5, 33);
                    g.beginPath();
                    g.moveTo(poly[0].x, poly[0].y);
                    for (var pv = 1; pv < poly.length; pv++) g.lineTo(poly[pv].x, poly[pv].y);
                    g.closePath();
                    g.clip();
                    g.drawImage(im, (pcx - 63.5) * k512, (pcy - 33) * k512,
                        127 * k512, 66 * k512, -63.5, -33, 127, 66);
                    g.restore();
                }
            }
            pieceCanvas = document.createElement('canvas');
            bakePieces(pieceCanvas, CityTerrain.sheetClipPoly);
            /* full-res textures for the engine-true quadrant meshes. River
               quads always sample the BASE sheet: the 0x3fc320 table and all
               bank art were measured there, and winter keeps base ground art
               (same reasoning as the green grass). The ice re-ship's river
               slots are unresearched. */
            if (roadSheetImg && !roadHiTex) roadHiTex = PIXI.Texture.from(roadSheetImg);
            if (iceSheetImg && !iceHiTex) iceHiTex = PIXI.Texture.from(iceSheetImg);
            rivReady = !!roadHiTex;
            sheetReady = true;
        } catch (e) { sheetReady = false; }
        if (texs['__sheet']) dropTex('__sheet');     // stale slot textures
        if (texs['__pieces']) dropTex('__pieces');
        if (sheetReady) {                            // (re)register for subTex
            texs['__sheet'] = { st: 1, tex: PIXI.Texture.from(sheetCanvas), subs: {} };
            texs['__pieces'] = { st: 1, tex: PIXI.Texture.from(pieceCanvas), subs: {} };
        }
        if (started) buildGround();            // sheet sprites get their texture
        markDirty();
    }
    function applyRoadSheet() { buildSheetCanvas(); }
    (function () {
        var im = new Image();
        im.onload = function () { roadSheetImg = im; buildSheetCanvas(); aBootSettled(); };
        im.onerror = function () { aBootSettled(); /* keep flat roads */ };
        im.src = B + 'assets/dlc/roadrivertiles-100/images/roadtilesheet.png';
    })();
    (function () {
        var im = new Image();
        im.onload = function () { iceSheetImg = im; applyRoadSheet(); };
        im.onerror = function () { /* winter keeps the normal sheet */ };
        im.src = B + 'assets/dlc/XMAS2017_RiverRoadTiles_LTD-100-r492453/images/iceroadtilesheet.png';
    })();
    /* ---- dirt sheet art (DirtRoadDrawing / DirtRiverDrawing, 2026-10-27) ----
       dirtroadtilesheet.png/.rgb re-uses the roadrivertiles lattice EXACTLY:
       per-slot dark-boundary ray measurements on the two sheets agree within
       ±1–2 px at all 11 road states (mapdump/registration/m4-dirt-sheet-*.png),
       so ROAD_QUADS (0x400520) and RIVER_QUADS (0x3fc320) address it as-is —
       no third UV table exists in the binary (full .rodata parallelogram scan
       finds only the two; ray + contact evidence mapdump/registration/
       m4-dirt-sheet-*.png and m4-dirt-ww-vs-xmas-*.png).
       landinfo.xml is the provenance authority: <RoadMap
       texture="DirtRoadTileSheet.rgb" type="dirt" drawer="road"
       origin="0,-7" size="37,64"> (and the type="dirtriver" drawer="river"
       twin) — the texture NAME is static across seasons (identical in
       gamescripts r308122 → r497432; the types appeared with WildWest-2016,
       absent in 2015's r61251) and origin/size match road/river exactly.
       "DirtRoadTileSheet" resolves from the installed pack set, so the art
       is PACK LAYERING, not code branching: exactly two packs ship it —
       WildWest_RiverRoadTiles (sandy .rgb, RGBA4444, avg RGB 177,146,83 —
       permanent normal-season art in the live game) and XMAS2016/2017_
       RiverRoadTiles_LTD (brown PNG with 0.7% snow specks, the Christmas
       override); base manifests ship none. dirtSheetTex() mirrors that
       layering: winter → XMAS PNG, everything else → WildWest .rgb.
       landinfo.xml: Dirt type="dirt" SaveInfo map="dirt" savedType="road"
       (drawer DirtRoadDrawing) and DirtRiver type="dirtriver"
       (drawer DirtRiverDrawing) — the viewer's `dirtroad` and `dirt` layers
       respectively. */
    var dirtHiTex = null, dirtReady = false;        // XMAS winter override
    var dirtBaseTex = null, dirtBaseReady = false;  // WildWest normal art
    (function () {
        var im = new Image();
        im.onload = function () {
            dirtHiTex = PIXI.Texture.from(im);
            dirtReady = true;
            if (started) buildGround();        // cells pick up the texture
            markDirty();
        };
        im.onerror = function () { /* winter falls back to the WildWest art */ };
        im.src = B + 'assets/dlc/XMAS2017_RiverRoadTiles_LTD-100-r492453/images/dirtroadtilesheet.png';
    })();
    (function () {
        /* .rgb = the game's raw texture blob; decode mirrors
           tools/extract_assets.py rgb_to_rgba (the oracle that produced
           every PNG under web/assets): u32 flags LE, u16 w, u16 h, then
           payload w*h*4 = straight 8-bit RGBA or w*h*2 = RGBA4444 pairs
           byte0=(B<<4)|A, byte1=(R<<4)|G, nibbles expanded x17. Header
           flag 0x2000 claims premultiplied but the dirt sheet stores
           c4 > a4 (impossible for premul), so verify against the data.
           An RGB565 read of 4444 data is what made the tiles pink/purple. */
        if (typeof fetch !== 'function') return;
        fetch(B + 'assets/dlc/WildWest_RiverRoadTiles-100-r308122/data/dirtroadtilesheet.rgb')
            .then(function (r) { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
            .then(function (buf) {
                var dv = new DataView(buf);
                var flags = dv.getUint32(0, true), w = dv.getUint16(4, true), h = dv.getUint16(6, true);
                var n = w * h, len = buf.byteLength - 8;
                if (len !== n * 2 && len !== n * 4) throw new Error('bad .rgb payload ' + len + ' for ' + w + 'x' + h);
                var cv = document.createElement('canvas');
                cv.width = w; cv.height = h;
                var cx = cv.getContext('2d'), id = cx.createImageData(w, h), data = id.data, o = 8, i, p;
                var premul = len === n * 2 && !!(flags & 0x2000) && !(flags & 0x4000);
                if (premul) {
                    for (i = 0; i < n; i++) {           // trust the data over the header
                        var b0 = dv.getUint8(8 + i * 2), b1 = dv.getUint8(8 + i * 2 + 1), a4 = b0 & 15;
                        if (a4 && a4 < 15 && ((b0 >> 4) > a4 || (b1 >> 4) > a4 || (b1 & 15) > a4)) { premul = false; break; }
                    }
                }
                for (i = 0, p = 0; i < n; i++, p += 4) {
                    if (len === n * 4) {                 // straight 8-bit RGBA
                        data[p] = dv.getUint8(o); data[p + 1] = dv.getUint8(o + 1);
                        data[p + 2] = dv.getUint8(o + 2); data[p + 3] = dv.getUint8(o + 3);
                        o += 4;
                        continue;
                    }
                    var c0 = dv.getUint8(o), c1 = dv.getUint8(o + 1), a = c0 & 15;
                    var r = (c1 >> 4) * 17, g = (c1 & 15) * 17, b = (c0 >> 4) * 17;
                    if (premul && a && a < 15) {         // un-premultiply the semi-transparent subset
                        r = Math.min(255, Math.round((c1 >> 4) * 255 / a));
                        g = Math.min(255, Math.round((c1 & 15) * 255 / a));
                        b = Math.min(255, Math.round((c0 >> 4) * 255 / a));
                    }
                    data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = a * 17;
                    o += 2;
                }
                cx.putImageData(id, 0, 0);
                dirtBaseTex = PIXI.Texture.from(cv);
                dirtBaseReady = true;
                if (started) buildGround();        // cells pick up the texture
                markDirty();
            })
            .catch(function () { /* keep flat dirt fills */ });
    })();
    /* Engine pack-priority mirrored: winter takes the Christmas LTD sheet
       when present, everything else the permanent WildWest sheet. */
    function dirtSheetTex() {
        if (SEASON.mode === 'winter') return dirtReady ? dirtHiTex : (dirtBaseReady ? dirtBaseTex : null);
        return dirtBaseReady ? dirtBaseTex : null;
    }
    /* ---- boardwalk / pier brush art (BoardwalkDrawer tiles, 2026-10-27) ----
       The two ocean-grid brushes are NOT RoadMap tiles: landinfo.xml gives
       them PathBrush textures boardwalktiles / ornatepiertiles and SaveInfo
       map="ocean", so their art ships as ordinary building-sprite bsv3
       scenes (notes/09 §12). tools/gen_pier_tiles.py parses both with
       gen_city_sprites.parse_bsv3 and emits assets/city/pier-tiles.json:
       per state, the engine's block list ALREADY IN DRAW ORDER (the engine
       paints the list reversed — its C_Shadow block, listed last, is the
       tile diamond and goes down first), each block a sheet crop rect, a
       float top-left and a 2x2 matrix in 100-tier sheet px.
       Placement (2026-10-30.23): 1:1 art px (ART.S per tile unit, the
       building scale), with the frame ORIGIN pinned to the cell's front
       corner (x0, y1) — the same pivot rule as every building sprite. That
       puts the deck's top surface on the cell itself, which is what the game
       does: registered against the full-res in-game export (by the buildings
       around it, not by the deck), the BarnacleBayMarina brush L lands on its
       save cells to within 0.2 tile at this placement, and was 0.75 tile
       (~48 art px) too high under the .21 "leg-ring ground corner" rule.
       Rules tried and measured wrong: centring C_Shadow on the cell (.19,
       ~70 px too high) and the leg-ring ground corner (.21/.22, ~50 px too
       high). The old 127x66 box mapping also stretched the art (x1.008,
       y0.97).
       State rule (art-derived — the binary's setter was not pinned, notes/09
       §12): the Normal_* states pick their legs by which lower edge faces
       water — PostLeft iff the lower-LEFT neighbour (tx, ty+1) is water,
       PostRight iff (tx+1, ty) is. */
    /* art-px nudge of every brush frame, for registration sweeps:
       ?pierDx=&pierDy= (screen-aligned art px, +y = down) */
    var PIER_NUDGE = (function () {
        var n = { x: 0, y: 0 };
        try {
            var q = new URLSearchParams(location.search);
            if (isFinite(parseFloat(q.get('pierDx')))) n.x = parseFloat(q.get('pierDx'));
            if (isFinite(parseFloat(q.get('pierDy')))) n.y = parseFloat(q.get('pierDy'));
        } catch (e) { /* no URL (headless harness) */ }
        return n;
    })();
    /* live nudge for the Road Lab "marina align" tab (it embeds this page):
       moves every brush frame together by (dx, dy) screen-aligned art px and
       rebuilds the ground so the sprites pick it up. Returns the live value */
    window.__CV_PIER_NUDGE = function (dx, dy) {
        if (isFinite(dx) && isFinite(dy)) {
            PIER_NUDGE.x = +dx; PIER_NUDGE.y = +dy;
            if (started) { buildGround(); pierOver = null; markDirty(); }
        }
        return { x: PIER_NUDGE.x, y: PIER_NUDGE.y };
    };
    var PIERART_KEY = 'mrsnrub.cityview.pierart';
    var pierArtOn = true;                         // ships ON: fills alone are unreadable
    var PIER = null;                              // assets/city/pier-tiles.json
    var pierRecs = [];
    (function () {
        if (typeof fetch !== 'function') return;
        fetch(B + 'assets/city/pier-tiles.json?v=20261030.23')
            .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
            .then(function (j) {
                PIER = j;
                var shSeen = {}, sh;
                for (var k in j.assets) {
                    sh = j.assets[k].sheet;
                    if (!shSeen[sh]) {
                        shSeen[sh] = 1; ALOAD.artKnown++; ALOAD.strips++;
                    }
                    texFor(B + sh);
                }
                /* texFor only STARTS the sheet loads: rebuild once they have
                   decoded (or died), else the brush cells keep the flat
                   fills until some unrelated rebuild happens along */
                (function settle() {
                    for (var k2 in j.assets) {
                        var u = B + j.assets[k2].sheet;
                        if (!texFor(u) && !texDead(u)) { setTimeout(settle, 100); return; }
                    }
                    if (started) buildGround();   // brush cells pick up the art
                    markDirty();
                })();
            })
            .catch(function () { /* keep the flat brush fills */ });
    })();
    function pierAsset(tn) { return (PIER && PIER.assets[tn]) || null; }
    function pierTexReady(tn) {
        var a = pierAsset(tn);
        return !!a && !!texFor(B + a.sheet);
    }
    function pierState(a, tx, ty, occ, big) {
        /* water probe: inside the RE'd sea base and not another brush tile */
        var t = terrain;
        function water(x, y) {
            if (occ[x + ',' + y]) return false;
            return x >= t.seaFillX0 - t.ox && x < t.seaFillX1 - t.ox &&
                   y >= t.seaFillY0 - t.oy && y < t.seaFillY1 - t.oy;
        }
        var ix = (water(tx, ty + big) ? 1 : 0) | (water(tx + big, ty) ? 2 : 0);
        var n = ['Normal_None', 'Normal_PostLeft', 'Normal_PostRight',
                 'Normal_PostLeftAndRight'][ix];
        return a.states[n] ? n : 'Normal_None';
    }
    function buildPierCell(parent, tn, tx, ty, occ, arr, big) {
        /* one brush CELL (big = 4 tiles square) == one bsv3 frame: blit its
           blocks in list order. The frame's C_Shadow diamond is 507x265
           100-tier px = a 4x4-tile cell at the 128x64 px tile every other
           -100 asset uses, and the save stores the brushes as 4x4 cells
           (gen_map_explorer.py), so one frame spans one cell at 1:1 */
        var a = pierAsset(tn);
        if (!a) return null;
        var sheet = B + a.sheet;
        if (!texFor(sheet)) return null;
        var blocks = a.states[pierState(a, tx, ty, occ, big)], out = [];
        /* art px -> tile map from the live camera: art px are SCREEN-aligned
           (the frame is a billboard, like any building), so scale them by the
           building blit's screen-px-per-art-px and pull that back through the
           inverse of the ground matrix's linear part — the parent is in tile
           space. Stays upright under Rotate/Mirror; the ratio is
           zoom-independent; setOrient rebuilds the ground. */
        var A = CAM.tileAffine(cam, VW, VH);
        var det = A.a * A.e - A.b * A.d;
        var i00 = A.e / det, i01 = -A.b / det, i10 = -A.d / det, i11 = A.a / det;
        var K = CAM.scale(cam) / ART.S;                     // screen px per art px
        var px = tx, py = ty + big;                         // the cell's front corner (x0, y1)
        for (var i = 0; i < blocks.length; i++) {
            var k = blocks[i], sx = k.m[0], sy = k.m[3];
            var t = subTex(sheet, k.c[0], k.c[1], k.c[2], k.c[3]);
            if (!t) continue;
            var s = new PIXI.Sprite(t);
            s.anchor.set(0.5);
            /* drawn-block centre in art px from the frame origin; a<0 mirrors
               about the anchor, so x is the block's RIGHT edge there */
            var bx = k.p[0] + (sx >= 0 ? 1 : -1) * k.c[2] * Math.abs(sx) / 2;
            var by = k.p[1] + (sy >= 0 ? 1 : -1) * k.c[3] * Math.abs(sy) / 2;
            /* from the frame origin, which sits on the front corner */
            var ex = (bx + PIER_NUDGE.x) * K, ey = (by + PIER_NUDGE.y) * K;
            var fx = sx * K, fy = sy * K;                        // art px -> screen
            s.setFromMatrix(new PIXI.Matrix(i00 * fx, i10 * fx, i01 * fy, i11 * fy,
                px + i00 * ex + i01 * ey, py + i10 * ex + i11 * ey));
            s.visible = false;
            parent.addChild(s);
            arr.push(s);
            out.push(s);
        }
        out.blocks = blocks;                                // the over pass re-blits these
        return out.length ? out : null;
    }
    function applyPierMode() {
        /* brush art: the frame paints the deck, its posts and the shadow it
           casts on the water, so with the art on the flat type fill goes
           entirely — the shadow is not on the cell (see buildPierCell), and a
           fill left under it shows as a plank-coloured sliver */
        for (var i = 0; i < pierRecs.length; i++) {
            var r = pierRecs[i];
            var vis = pierArtOn && !!pierTexReady(r.tn) && !terrain.hidden[r.tn];
            for (var k = 0; k < r.art.length; k++) r.art[k].visible = vis;
            for (k = 0; k < r.fills.length; k++) {
                r.fills[k].visible = !vis && !terrain.hidden[r.tn];
                r.fills[k].width = r.fills[k].height = 1 + BLEED;
            }
        }
        var b = $('btn-pierart');
        if (b) b.classList.toggle('on', pierArtOn && !!pierTexReady('boardwalk'));
    }
    /* ---- fixed beach coast sets (landinfo.xml LandEdge art, 2026-10-30) ------
       The beach is not paintable: landinfo.xml stamps it from <LandEdge> blocks,
       and the west coast has TWO of them, one per side of the mountain band.
       Below the ridge the coast stamps filename="Beach" (BEACHSHORE1 /
       BEACHBUILDAREA1, repeat="-1" = stamp until the edge ends); the Springfield
       Heights coast NORTH of it stamps filename="springfieldheightsnobeach"
       (beach1 / beachshore1 / beachmtnoverlay, repeat="6" = SIX strips then
       stop). tools/gen_beach_tiles.py parses both bsv3s into
       assets/city/beach-tiles.json; the art is PRE-SHEARED oblique (64 art px =
       1 town tile, +y along the coast, +x inland), so each block is a billboard
       blitted in screen space at its instance's anchor tile.
       PLACEMENT IS THE FILE'S, read literally (2026-10-30.16):
         - the anchor is the land's own origin, TILE (0, 0). The save's props
           are in that same space — Mountain03/LowerMountainBeach sits at x 0..16
           rows -16..0, Mountain04/LowerMountainBeachShoreline at x -6..0, the
           beach chairs and towels at x 0..3 — so the shoreline is x 0 here
           (GridTypeMap: shoreline -3..0, beach 0..4). The terrain's sea fill
           now ends on that same x 0 (terrain.js SEA_TILE); it used to end 12
           tiles further west, and anchoring on it put the coast out to sea.
         - offsetx/offsety count 16-tile LAND BLOCKS, not tiles
           (LandBlockPosition y="-7" is the same unit): the lower set's
           offsety="-1" starts it at y -16 and repeat="-1" runs it to the land's
           south end; the Heights set's offsety="-7" starts it at y -112 and
           repeat="6" x width 16 ends it at -16 — exactly where the lower set
           begins, on Mountain03's north edge, and exactly GridTypeMap's split
           between its two beach ranges. The step is the edge's own width (16);
           the art paints 17 rows, so neighbours overlap by one, drawn far end
           first.
         - hasBackground: Heights beach1 asks the engine for a solid EEDDCC fill
           13.5 x 16 tiles at x -0.5 UNDER each strip. The beach1 art is only
           cliff, rocks and sand patches on top of that fill, which is why the
           Heights coast read as grass with sand blotches until it was drawn.
         - only <LandSprite> edges are stamped: BEACHBORDEROVERLAY lives in
           <AlternateLandSprite> (the pre-v28 land), so it stays in the manifest
           for reference and off the map.
       Static frame 0 everywhere (the wave loop is not ported — same choice as
       the road art and the pier brush). */
    var BEACHART_KEY = 'mrsnrub.cityview.beachart';
    /* v2: the v1 params (seam/pitch steppers, the sea-fill anchor) would land
       the coast back where it was — a stale save must not override the file */
    var BEACHP_KEY = 'mrsnrub.cityview.beach.params.v2';
    var beachArtOn = false;                 // the art is the loud one — opt in
    var BEACH = null, beachFailed = false;
    var BEACH_S = 64;                       // art px per town tile (manifest pxPerTile)
    var BEACH_MAX_STAMPS = 64;              // fill cap, and a hostile manifest cap
    var BEACH_LAND_END = 700;               // fallback: landinfo Region "Springfield" y2
    var beachP = {
        ax: 0, ay: 0, block: 16, fill: true, copies: 4,
        heights: true, hinst: 6, bg: true,
        edgeAt: 0, useOffsets: true,
        north: true, sky: true
    };
    /* back to front — the manifest's own pair order (road-lab BEACH_KINDS).
       `north` is the `Land` set: the shoreline up the coast past the Heights,
       the mountain row across the top of the land, and its water-end rocks
       (nearer the viewer than the row, so after it) */
    var BEACH_KINDS = {
        lower: ['buildarea', 'shore', 'border'],
        heights: ['h_beach', 'h_shore', 'h_overlay'],
        north: ['n_shore', 'n_mountains', 'n_mtnwater']
    };
    /* past the mountain row is off the land, and the game covers it with a
       flat wall of cloud. Read off the in-game full-map export
       (mapdump/registration/calib-export.png, mapped to tiles through the
       g2e homography): #EFFFFF everywhere outside the land, its edge a
       straight iso line with small puffs and a blue-grey rim on the land
       side. Along the north it runs 16 rows BEHIND the mountain row's foot
       (y -128 — the export reads -124..-136 through the homography's
       north-edge drift, and -16 is the row's own bgOffsetY in its Snow
       variant), so it cuts across the back of the mountains; along the east
       it starts on the land's own edge (x 592). It is drawn OVER the
       mountain art, as the game draws it. The Land sheet's C_Cloud_* crops
       are the clouds INSIDE the mountain art, not this wall. */
    var BEACH_CLOUD = 0xefffff;             // export-sampled cloud white
    var BEACH_CLOUD_RIM = 0xbac7dd;         // export-sampled rim on the land side
    var BEACH_CLOUD_BACK = 16;              // rows behind the mountain row's foot
    var BEACH_PUFF_STEP = 1.5;              // puff pitch along the edge (tiles)
    var BEACH_RIM = 0.22;                   // rim depth on the land side (tiles)
    /* the instance records + the art pool (child order IS painter order, so the
       pool refills from 0 every frame like the scene pool) */
    var beachInsts = [], beachArtPool = [], beachArtN = 0;
    (function () {
        try {
            beachArtOn = localStorage.getItem(BEACHART_KEY) === '1';
            var p = JSON.parse(localStorage.getItem(BEACHP_KEY) || 'null');
            if (p) for (var k in beachP) if (p[k] !== undefined) beachP[k] = p[k];
        } catch (e) { /* private mode */ }
    })();
    (function () {
        if (typeof fetch !== 'function') return;
        fetch(B + 'assets/city/beach-tiles.json')
            .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
            .then(function (j) {
                BEACH = j;
                for (var k in j.assets) {           // three sheets: beach, heights, land
                    ALOAD.artKnown++; ALOAD.strips++;
                    texFor(B + j.assets[k].sheet);
                }
                /* texFor only STARTS the loads: rebuild once both have decoded
                   (or died), else the coast keeps only its tints */
                (function settle() {
                    for (var k2 in j.assets) {
                        var u = B + j.assets[k2].sheet;
                        if (!texFor(u) && !texDead(u)) { setTimeout(settle, 100); return; }
                    }
                    beachBuild();
                    markDirty();
                })();
            })
            .catch(function () { beachFailed = true; });
    })();
    function beachSave() {
        try { localStorage.setItem(BEACHP_KEY, JSON.stringify(beachP)); } catch (e) { /* private mode */ }
    }
    /* the land's origin, which every LandEdge offset counts from: tile (0, 0),
       nudged by the ax/ay steppers for A/B-ing against the map */
    function beachAnchorX() { return beachP.ax | 0; }
    function beachAnchorY() { return beachP.ay | 0; }
    /* the land's frame in tiles (LandBlockPosition + LandBlockSize x 16) */
    function beachLandBox() {
        var b = (BEACH && BEACH.landBlocks) || { tiles: 16, x: -3, y: -7, w: 40, h: 64 };
        var u = b.tiles || 16;
        return { x0: b.x * u, y0: b.y * u, x1: (b.x + b.w) * u, y1: (b.y + b.h) * u };
    }
    /* where a repeat="-1" edge ends: the land's south edge (Region Springfield) */
    function beachLandEnd() {
        var r = BEACH && BEACH.regions, i;
        if (r) for (i = 0; i < r.length; i++)
            if (r[i].name === 'Springfield' && isFinite(r[i].y1)) return r[i].y1;
        return BEACH_LAND_END;
    }
    function beachTile(kind) { return (BEACH && BEACH.tiles && BEACH.tiles[kind]) || null; }
    function beachAnim(name) { return (BEACH && BEACH.anims && BEACH.anims[name]) || null; }
    function beachAnimName(kind) { var t = beachTile(kind); return t ? t.anim : null; }
    function beachAssetOf(name) {
        var a = beachAnim(name), k = (a && a.asset) || 'beach';
        return (BEACH && BEACH.assets && BEACH.assets[k]) || null;
    }
    function beachSheetReady(name) {
        var a = beachAssetOf(name);
        return !!a && !!texFor(B + a.sheet);
    }
    /* one bsv3 block -> sheet crop + rect in ART px, relative to the anchor
       tile's top-left (a<0 mirrors about the anchor, so the stored x is the
       crop's RIGHT edge). k=1 here: the draw pass scales by screen px per art px
       — identical to road-lab's beachRectAt(cell, blk, 0, 0, k) */
    function beachBlocks(name) {
        var a = beachAnim(name), sh = beachAssetOf(name), out = [];
        if (!a || !sh || !a.frames || !a.frames.length) return out;
        for (var i = 0; i < a.frames[0].length; i++) {
            var blk = a.frames[0][i], c = sh.cells[blk[0]];
            if (!c) continue;
            var mx = Math.abs(blk[3]), my = Math.abs(blk[6]);
            out.push({
                url: B + sh.sheet, n: c[0], sx: c[1], sy: c[2], sw: c[3], sh: c[4],
                dx: blk[1] - (blk[3] < 0 ? c[3] * mx : 0), dy: blk[2],
                w: c[3] * mx, h: c[4] * my
            });
        }
        return out;
    }
    /* the tiles an anim PAINTS for one instance: a tile counts when its CENTRE
       falls inside the measured opaque box (manifest tilebox) — the same rule as
       road-lab's beachPlaceTilesAt, so the two views agree tile for tile.
       Flat [x0,y0,x1,y1,...]; a contiguous rectangle by construction. */
    function beachTilesOf(name, ax, ay) {
        var a = beachAnim(name), out = [];
        if (!a || !a.tilebox) return out;
        var b = a.tilebox;
        for (var tx = Math.ceil(b[0] - 0.5 + ax); tx <= Math.floor(b[2] - 0.5 + ax); tx++)
            for (var ty = Math.ceil(b[1] - 0.5 + ay); ty <= Math.floor(b[3] - 0.5 + ay); ty++)
                out.push(tx, ty);
        return out;
    }
    /* ---- stamping: EVERY anim gets its own <LandEdge> stamp list -----------
       landinfo.xml stamps each piece of a set separately and each one carries its
       own repeat/width/offset (the manifest keeps them per kind as `landedge`):
         repeat="-1"  stamp until the edge ends — BEACHSHORE1, BEACHBUILDAREA1
         repeat="6"   six stamps then stop       — Heights beachshore1, beach1
         repeat="1"   ONE stamp                  — Heights beachmtnoverlay
       Stamp i of a direction="y" edge sits at
         (offsetx * block, offsety * block + i * step)
       from the land origin, and of a direction="x" edge (the Land set's
       MOUNTAINS row) at (offsetx * block + i * step, offsety * block). `step`
       is width + padding: MOUNTAINS is width 16 + padding 32 = 48, which is
       what both <AlternateLandSprite> rows sum to too (39+9, 48+0) — the
       mountain art is 56 tiles wide, so neighbours overlap by 8. A repeat="-1"
       y edge runs to the land's south edge, an x edge to its east edge.
       `block` (16) is the land-block unit the offsets count in. `offsets` off
       drops the file's offsets for A/B-ing; `edgeAt` nudges the repeat="1"
       overlay along the coast. */
    function beachEdge(kind) {
        var t = beachTile(kind), e = (t && t.landedge) || {};
        function num(v, d) { var n = parseFloat(v); return isFinite(n) ? n : d; }
        var blk = Math.max(1, beachP.block | 0);
        return {
            anim: t ? t.anim : null,
            sprite: !t || !t.landedgeBlock || t.landedgeBlock === 'LandSprite',
            repeat: num(e.repeat, -1),
            dir: e.direction === 'x' ? 'x' : 'y',
            width: Math.max(1, num(e.width, 16)),
            step: Math.max(1, num(e.width, 16) + num(e.padding, 0)),
            offX: beachP.useOffsets ? num(e.offsetx, 0) * blk : 0,
            offY: beachP.useOffsets ? num(e.offsety, 0) * blk : 0,
            /* the engine's solid fill under the strip (tiles, from the anchor) */
            bg: e.hasBackground === 'true' && e.bgColor ? {
                color: parseInt(String(e.bgColor).slice(0, 6), 16),
                x: num(e.bgOffsetX, 0), y: num(e.bgOffsetY, 0),
                w: num(e.bgWidth, 0), h: num(e.bgHeight, 0)
            } : null
        };
    }
    function beachStampsOf(set) {
        var kinds = BEACH_KINDS[set] || [], out = [];
        for (var j = 0; j < kinds.length; j++) {
            var kind = kinds[j], ed = beachEdge(kind), list = [], i;
            if (!ed.anim || !ed.sprite) continue;
            var x0 = beachAnchorX() + ed.offX, y0 = beachAnchorY() + ed.offY;
            var alongX = ed.dir === 'x';
            var n = ed.repeat >= 0 ? ed.repeat
                : alongX ? Math.ceil((beachLandBox().x1 - x0) / ed.step)
                    : (beachP.fill || set !== 'lower') ? Math.ceil((beachLandEnd() - y0) / ed.step)
                        : Math.max(1, beachP.copies | 0);
            if (set === 'heights') n = Math.min(n, Math.max(0, beachP.hinst | 0));
            n = Math.min(BEACH_MAX_STAMPS, Math.max(0, n));
            var blocks = beachBlocks(ed.anim);
            var nudge = ed.repeat === 1 && set === 'heights' ? (beachP.edgeAt | 0) : 0;
            for (i = 0; i < n; i++) {
                var ax = alongX ? x0 + i * ed.step : x0;
                var ay = alongX ? y0 : y0 + i * ed.step + nudge;
                list.push({ ax: ax, ay: ay, set: set, kind: kind, anim: ed.anim,
                            blocks: blocks, bg: ed.bg, tiles: beachTilesOf(ed.anim, ax, ay) });
            }
            /* far end first: +x runs up-screen (farther) and +y down-screen
               (nearer) on the shipped camera, so depth is ay - ax */
            list.sort(function (p, q) { return (p.ay - p.ax) - (q.ay - q.ax); });
            out = out.concat(list);
        }
        return out;
    }
    /* where each set starts and ends along the coast (labels + the harness) */
    function beachSpan(set) {
        var lo = Infinity, hi = -Infinity;
        for (var i = 0; i < beachInsts.length; i++) {
            var r = beachInsts[i];
            if (r.set !== set || beachEdge(r.kind).repeat === 1) continue;
            if (r.ay < lo) lo = r.ay;
            if (r.ay + beachEdge(r.kind).step > hi) hi = r.ay + beachEdge(r.kind).step;
        }
        return lo === Infinity ? null : [lo, hi];
    }
    /* rebuild the stamp records: params, the manifest, an ORIENT press or a
       fresh terrain all land here */
    function beachBuild() {
        beachInsts = [];
        if (!BEACH) return;
        /* the Land set first: the mountain row is the farthest thing on the
           map, and the Heights cliff art rises up-screen over its foot */
        if (beachP.north) beachInsts = beachStampsOf('north');
        beachInsts = beachInsts.concat(beachStampsOf('lower'));
        if (beachP.heights) beachInsts = beachInsts.concat(beachStampsOf('heights'));
    }
    function beachArtTake(url, sx, sy, w, h) {
        /* NO placeholder: a stretched UNIT texture is a solid rectangle over the
           coast (the exact failure the Road Lab's black canvases had). A block
           whose sheet has not decoded simply does not draw this frame. */
        var t = subTex(url, sx, sy, w, h);
        if (!t) return null;
        var s = beachArtPool[beachArtN];
        if (!s) {
            s = new PIXI.Sprite();
            s.anchor.set(0);
            beachArtC.addChild(s);
            beachArtPool.push(s);
        }
        if (s.__tex !== t) { s.texture = t; s.__tex = t; }
        s.visible = false;
        beachArtN++;
        return s;
    }
    /* the cloud wall's edge in tiles: north of y `north`, east of x `east` */
    function beachCloudEdge() {
        var ed = beachEdge('n_mountains');
        return { north: beachAnchorY() + ed.offY - BEACH_CLOUD_BACK,
                 east: beachLandBox().x1 };
    }
    /* the wall, clipped to the visible tile rect T: two tile-space rects
       (north band, east band), then along each inner edge a thin continuous
       rim strip and a row of small irregular puffs — rim-coloured ones nudged
       toward the land, white ones on the line — which is the export's soft
       wavy edge rather than a row of scallops */
    function beachCloudDraw(P, box, k, T) {
        var E = beachCloudEdge(), g = beachCloudG, m = 4;
        var x0 = T.x0 - m, x1 = T.x1 + m, y0 = T.y0 - m, y1 = T.y1 + m;
        var r0 = 40 * k;                                   // ~0.55 tile across the screen
        function puffs(pts, dx, dy, col, rs) {
            for (var i = 0; i < pts.length; i++) {
                var p = P(pts[i][0] + dx, pts[i][1] + dy);
                g.circle(p[0], p[1], r0 * pts[i][2] * rs).fill({ color: col, alpha: 1 });
            }
        }
        function hash(n) { n = (n * 2654435761) >>> 0; return (n % 1000) / 1000; }
        var drew = false;
        if (y0 < E.north) {                                 // north band
            g.poly(box(x0, y0, x1, Math.min(y1, E.north)), true).fill({ color: BEACH_CLOUD, alpha: 1 });
            drew = true;
        }
        if (x1 > E.east && y1 > E.north) {                  // east band
            g.poly(box(Math.max(x0, E.east), Math.max(y0, E.north), x1, y1), true)
                .fill({ color: BEACH_CLOUD, alpha: 1 });
            drew = true;
        }
        if (!drew) return;
        var st = BEACH_PUFF_STEP, nPts = [], ePts = [], t, w = BEACH_RIM;
        /* each puff: a jitter ACROSS the edge too, so the line wanders */
        if (E.north >= y0 - 2 && E.north <= y1 + 2) {
            for (t = Math.floor(x0 / st) * st; t <= Math.min(x1, E.east); t += st) {
                var hn = Math.round(t / st);
                nPts.push([t + 0.6 * hash(hn + 31), E.north - 0.15 + 0.3 * hash(hn + 97),
                           0.6 + 0.9 * hash(hn)]);
            }
            g.poly(box(x0, E.north, Math.min(x1, E.east), E.north + w), true)
                .fill({ color: BEACH_CLOUD_RIM, alpha: 1 });
        }
        if (E.east >= x0 - 2 && E.east <= x1 + 2) {
            for (t = Math.max(E.north, Math.floor(y0 / st) * st); t <= y1; t += st) {
                var he = Math.round(t / st) + 7919;
                ePts.push([E.east + 0.15 - 0.3 * hash(he + 97), t + 0.6 * hash(he + 31),
                           0.6 + 0.9 * hash(he)]);
            }
            g.poly(box(E.east - w, Math.max(y0, E.north), E.east, y1), true)
                .fill({ color: BEACH_CLOUD_RIM, alpha: 1 });
        }
        /* land side: +y of the north edge, -x of the east edge */
        puffs(nPts, 0, w, BEACH_CLOUD_RIM, 1);
        puffs(ePts, -w, 0, BEACH_CLOUD_RIM, 1);
        puffs(nPts, 0, 0, BEACH_CLOUD, 1);
        puffs(ePts, 0, 0, BEACH_CLOUD, 1);
    }
    function beachHideRest() {
        for (var i = beachArtN; i < beachArtPool.length; i++) beachArtPool[i].visible = false;
    }
    /* the per-frame pass: art billboards in beachArtC with their hasBackground
       fills under them in beachBgG, and the cloud wall past the land. Screen-space
       like drawGrid/drawMarkers: project, never shear a container */
    function beachDraw(A, s, T) {
        beachBgG.clear();
        beachCloudG.clear();
        beachArtN = 0;
        if (!BEACH || !beachArtOn) { beachHideRest(); return; }
        var k = s / BEACH_S;                               // screen px per art px
        function P(x, y) { return [A.a * x + A.b * y + A.c, A.d * x + A.e * y + A.f]; }
        function box(x0, y0, x1, y1) {
            var a = P(x0, y0), b = P(x1, y0), c = P(x1, y1), d = P(x0, y1);
            return [a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1]];
        }
        var i, t, st, tl, x0, y0, x1, y1;
        for (i = 0; i < beachInsts.length; i++) {
            st = beachInsts[i]; tl = st.tiles;
            if (!tl.length) continue;
            x0 = y0 = Infinity; x1 = y1 = -Infinity;
            for (t = 0; t < tl.length; t += 2) {
                if (tl[t] < x0) x0 = tl[t];
                if (tl[t] > x1) x1 = tl[t];
                if (tl[t + 1] < y0) y0 = tl[t + 1];
                if (tl[t + 1] > y1) y1 = tl[t + 1];
            }
            if (x1 + 1 < T.x0 || x0 > T.x1 || y1 + 1 < T.y0 || y0 > T.y1) continue;
            if (beachP.bg && st.bg) {
                /* the engine's hasBackground fill: a flat tile-space rect
                   under the strip (beachBgG is beachArtC's bottom child) */
                var g = st.bg;
                beachBgG.poly(box(st.ax + g.x, st.ay + g.y, st.ax + g.x + g.w, st.ay + g.y + g.h), true)
                    .fill({ color: g.color, alpha: 1 });
            }
            if (beachSheetReady(st.anim)) {
                var o = P(st.ax, st.ay), bs = st.blocks;
                for (var q = 0; q < bs.length; q++) {
                    var bl = bs[q];
                    var X = o[0] + bl.dx * k, Y = o[1] + bl.dy * k,
                        W = bl.w * k, H = bl.h * k;
                    if (!bl.sw || !bl.sh) continue;
                    if (X + W < 0 || Y + H < 0 || X > VW || Y > VH) continue;
                    var sp = beachArtTake(bl.url, bl.sx, bl.sy, bl.sw, bl.sh);
                    if (!sp) continue;              // sheet not decoded yet
                    sp.visible = true;
                    /* A Sprite's matrix SCALES its texture frame (the drawn box
                       is frame * matrix), and beachArtC is on the stage, so the
                       local space here is screen px. The linear part is
                       therefore target px PER FRAME PX, not the target size:
                       passing W/H drew every crop sw x sh times too big (an
                       87x62 shore cell became ~7,500 px, the 669x384 Heights
                       overlay ~447,000 px) — one opaque slab over the whole
                       map, which is the "massive tile" complaint. The Road Lab
                       never showed it because ctx.drawImage takes the source
                       rect and the dest rect separately, so the same W/H are
                       sizes there. */
                    sp.setFromMatrix(new PIXI.Matrix(W / bl.sw, 0, 0, H / bl.sh, X, Y));
                }
            }
        }
        beachHideRest();
        /* the wall of cloud the game puts over everything off the land, drawn
           OVER the mountain row */
        if (beachP.sky && beachP.north) beachCloudDraw(P, box, k, T);
    }
    function applyBeachMode() {
        if (beachArtC) beachArtC.visible = beachArtOn;
        if (beachCloudG) beachCloudG.visible = beachArtOn;
        var b2 = $('btn-beachart');
        if (b2) {
            b2.classList.toggle('on', beachArtOn && !!(BEACH && beachSheetReady(beachAnimName('shore'))));
            b2.textContent = beachArtOn ? 'Beach art·on' : 'Beach art';
        }
    }
    window.__CV_BEACH = {
        params: beachP,
        manifest: function () { return BEACH; },
        failed: function () { return beachFailed; },
        instances: function () {
            return beachInsts.map(function (r) {
                return { ax: r.ax, ay: r.ay, set: r.set, kind: r.kind, anim: r.anim };
            });
        },
        counts: function () {
            var m = {};
            for (var i = 0; i < beachInsts.length; i++)
                m[beachInsts[i].kind] = (m[beachInsts[i].kind] || 0) + 1;
            return m;
        },
        tiles: function (set, kind) {
            var out = [];
            for (var i = 0; i < beachInsts.length; i++) {
                if (set && beachInsts[i].set !== set) continue;
                if (kind && beachInsts[i].kind !== kind) continue;
                out = out.concat(beachInsts[i].tiles);
            }
            return out;
        },
        rects: function (s) {
            var A = CAM.tileAffine(cam, VW, VH), k = (s || CAM.scale(cam)) / BEACH_S, out = [];
            for (var i = 0; i < beachInsts.length; i++) {
                var r = beachInsts[i];
                var o = [A.a * r.ax + A.b * r.ay + A.c,
                         A.d * r.ax + A.e * r.ay + A.f];
                for (var q = 0; q < r.blocks.length; q++) {
                    var bl = r.blocks[q];
                    out.push({ anim: r.anim, kind: r.kind, cell: bl.n, set: r.set,
                               x: o[0] + bl.dx * k, y: o[1] + bl.dy * k,
                               w: bl.w * k, h: bl.h * k });
                }
            }
            return out;
        },
        state: function () {
            return { art: beachArtOn, insts: beachInsts.length,
                     lower: beachSpan('lower'), heights: beachSpan('heights'),
                     anchor: beachAnchorX(), anchorY: beachAnchorY(),
                     offsets: beachP.useOffsets, edgeAt: beachP.edgeAt };
        },
        cloudEdge: function () { return beachCloudEdge(); },
        rebuild: function () { beachBuild(); markDirty(); },
        set: function (k, v) { beachP[k] = v; beachSave(); beachBuild(); applyBeachMode(); markDirty(); }
    };
    /* ---- beach tune panel: A/B steppers against the file's own placement
       (each one defaults to what landinfo.xml states) ------------------- */
    function bindBeachUI() {
        if ($('btn-beachart')) $('btn-beachart').addEventListener('click', function () {
            beachArtOn = !beachArtOn;
            try { localStorage.setItem(BEACHART_KEY, beachArtOn ? '1' : '0'); } catch (e) { /* private mode */ }
            applyBeachMode(); markDirty();
        });
        if ($('btn-beachtune')) $('btn-beachtune').addEventListener('click', function () {
            var p = $('beachtune');
            if (!p) return;
            var show = p.style.display === 'none' || p.style.display === undefined;
            p.style.display = show ? '' : 'none';
            $('btn-beachtune').classList.toggle('on', show);
            markDirty();
        });
        var panel = $('beachtune');
        if (!panel || !document.createElement) { applyBeachMode(); return; }
        var nums = {}, tgls = [];
        function row(label) {
            var r = document.createElement('div');
            r.className = 'trow';
            var l = document.createElement('span');
            l.className = 'tlab';
            l.textContent = label;
            r.appendChild(l);
            panel.appendChild(r);
            return r;
        }
        function btn(txt, fn, tip) {
            var b = document.createElement('button');
            b.className = 'tbtn';
            b.textContent = txt;
            if (tip) b.setAttribute('data-tip', tip);
            b.addEventListener('click', fn);
            return b;
        }
        function paint() {
            for (var k in nums)
                nums[k].textContent = k === 'ax'
                    ? beachP.ax + '  (tile x ' + beachAnchorX() + ')'
                    : String(beachP[k]);
            for (var i = 0; i < tgls.length; i++) tgls[i].textContent = tgls[i].label();
            beachSave();
            beachBuild();
            applyBeachMode();
            markDirty();
        }
        function stepper(label, key, step, min, max, tip) {
            var r = row(label);
            var v = document.createElement('span');
            v.className = 'tval';
            r.appendChild(btn('\u2212', function () {
                beachP[key] = Math.max(min, +(beachP[key] - step).toFixed(2)); paint();
            }, tip));
            r.appendChild(v);
            nums[key] = v;
            r.appendChild(btn('+', function () {
                beachP[key] = Math.min(max, +(beachP[key] + step).toFixed(2)); paint();
            }, tip));
        }
        function toggle(rowEl, key, name, kind, tip) {
            var b = btn(name, function () {
                if (kind === 'cycle') beachP[key] = beachP[key] === 'replace' ? 'over' : 'replace';
                else beachP[key] = !beachP[key];
                paint();
            }, tip);
            b.label = kind === 'cycle'
                ? function () { return name + ': ' + beachP[key]; }
                : function () { return name + ': ' + (beachP[key] ? 'ON' : 'off'); };
            tgls.push(b);
            rowEl.appendChild(b);
            return b;
        }
        stepper('anchor x', 'ax', 1, -24, 24,
            'shift the whole coast east/west of the land origin. 0 = tile x 0, the frame the save\'s props live in (Mountain04/LowerMountainBeachShoreline ends on x 0, the beach chairs stand on x 0..3) and where the terrain\'s sea ends; when the two differ the sea edge is drawn as a cyan line');
        stepper('anchor y', 'ay', 1, -64, 64,
            'shift the whole coast along the shore. 0 = the land origin every LandEdge offset counts from');
        stepper('block', 'block', 1, 1, 32,
            'tiles per LandEdge offset unit: the offsets count 16-tile land blocks (lower offsety -1 = y -16, Heights offsety -7 = y -112). 1 reads them as plain tiles, which is how the coast was misplaced before');
        stepper('strips', 'copies', 1, 1, 64,
            'strip count with the lower fill off (isolates one repeat)');
        stepper('h inst', 'hinst', 1, 0, 24,
            'how many of the Heights set\'s repeat="6" strips to draw (0 hides the set)');
        stepper('edge y', 'edgeAt', 1, -200, 200,
            'nudge the repeat="1" Heights mountain overlay along the coast from where the file puts it');
        toggle(row('lower fill'), 'fill', 'fill to land end', false,
            'repeat="-1" = stamp until the edge ends: fill from y -16 to the land\'s south edge (Region Springfield y2)');
        toggle(row('north set'), 'heights', 'heights set', false,
            'draw the springfieldheightsnobeach coast at all');
        toggle(row('north edge'), 'north', 'mountain row', false,
            'the `Land` LandEdges across the top of the land: MOUNTAINS (direction x from y -112, every 48 tiles to the land\'s east edge x 592), MOUNTAINSTOWATER where the row meets the sea, SHORELINE2 up the coast behind it');
        toggle(row('clouds'), 'sky', 'cloud wall', false,
            'the flat wall of cloud the game puts over everything off the land (read off the in-game full-map export): north of y -128, 16 rows behind the mountain row\'s foot, so it covers the back of the ridge, and east of the land\'s edge x 592');
        toggle(row('bg sand'), 'bg', 'bg fill', false,
            'the solid EEDDCC fill Heights beach1 asks for (hasBackground, 13.5 x 16 tiles at x -0.5): without it the Heights beach is grass with sand patches');
        toggle(row('landinfo offs'), 'useOffsets', 'offsets', false,
            'apply each LandEdge\'s own offsetx/offsety (lower offsety="-1", Heights offsety="-7") — off lands every piece on the origin row instead, to A/B the file\'s offsets against the map');
        row('go').appendChild(btn('\u2316 seam', function () {
            var lo = beachSpan('lower');
            centerOnTile(beachAnchorX() + 4, (lo ? lo[0] : beachAnchorY()) + 4);
            if (cam.zoom < 0.6) cam.zoom = 0.8;
            markDirty();
        }, 'centre the view where the two sets meet (Mountain03)'));
        row('reset').appendChild(btn('file values', function () {
            beachP.ax = 0; beachP.ay = 0; beachP.block = 16; beachP.edgeAt = 0;
            beachP.useOffsets = true; beachP.fill = true; beachP.heights = true;
            beachP.hinst = 6; beachP.bg = true; beachP.north = true; beachP.sky = true;
            paint();
        }, 'back to the placement landinfo.xml states'));
        paint();
    }

    applySeasonMode();
    if ($('btn-season')) $('btn-season').addEventListener('click', function () {
        var modes = ['base'], i;
        for (i = 0; i < SEASON_ORDER.length; i++)
            if (SEASON.present[SEASON_ORDER[i]]) modes.push(SEASON_ORDER[i]);
        i = modes.indexOf(SEASON.mode);
        SEASON.mode = modes.length < 2 ? 'base'
            : (i < 0 ? modes[1] : modes[(i + 1) % modes.length]);
        try { localStorage.setItem(SEASON_KEY, SEASON.mode); } catch (e) { /* private mode */ }
        applySeasonMode();
        buildGround();            // ground quads bake their sheet tex at build
                                  // time: winter swaps ice/dirt sheets in (and
                                  // back out), so rebuild the ground now
        markDirty();
    });
    /* sheet cell -> tile-space placement (js/terrain.js _sheetTile): the
       127x66 box's inscribed diamond maps onto the UNIT tile square, which
       in tile space is rotation +45deg and scale (sqrt2/127, sqrt2/66).
       These constants are the big=1 mapping (the avenue pass draws real
       1-tile cells); a saved road cell spans big x big tiles, and the
       canvas reference feeds quad(..., big) to _sheetTile, so every box
       midpoint must reach the CELL square's corner — the scale is linear
       in big (roadSpec: each cell paints as ONE big x big diamond). */
    var SHEET_SX = Math.SQRT2 / 127, SHEET_SY = Math.SQRT2 / 66;
    function sheetSlotTex(slot) {
        if (!sheetReady) return null;
        var cx = 274 + 135 * slot[0] + (((slot[1] % 2) + 2) % 2) * 67.5;
        var cy = 140 + 37 * slot[1];
        return subTex('__sheet', cx - 63.5, cy - 33, 127, 66);
    }
    /* full-res sheet texture the quadrant meshes sample (see quadMesh):
       roads follow the season (icy sheet in winter), rivers always the base */
    function specSheetTex() {
        if (!sheetReady) return null;
        return (SEASON.mode === 'winter' && iceHiTex) ? iceHiTex : roadHiTex;
    }
    function rivSheetTex() { return rivReady ? roadHiTex : null; }
    /* baked strip piece for a composite pass (see PIECE_DEFS): a
       flipped sprite mirrors its baked clip too, so the px pass reads
       the pre-mirror nx bake (py is symmetric, unchanged). */
    function pieceTex(state, side, flip) {
        if (!sheetReady) return null;
        var ix = PIECE_IX[state + (flip && side === 'px' ? 'nx' : side)];
        if (ix === undefined) return null;
        return subTex('__pieces', ix * 128, 0, 127, 66);
    }

    /* ---- sprite art (M4 items 4/5): billboard sprites ----------------------
       Ported from city-view.js: buildings draw their extracted city sprite,
       people their .bcell idle pose; manifests fetched at boot; a missing
       manifest or PNG degrades that layer to its primitive. ART knobs
       (S/ax/ay/ref) live in localStorage like the Canvas page — the same
       keys are shared, so tuning carries between the two pages. */
    var ART_KEY = 'mrsnrub.cityview.art';
    var artMode = 1;                        // ships ON (M4 item 4): 0 blocks/dots, 1 sprites
    var ART = {
        S: 64,          // art px per tile unit — measured 2026-10-25
                        // (tools/fit-sprite-scale.py edge-NCC fit vs the
                        // full-res export; notes/06 "Sprite scale S pinned")
        ax: 0, ay: 0,   // ground-point nudge in tile units
        ref: 'anchor'   // 'anchor' = pin at tile (px,py); 'origin' = footprint origin
    };
    var TUNE_KEY = 'mrsnrub.cityview.arttune.v2';   // v2: corner-pin defaults
    (function readArtUrl() {           // saved panel tuning, then ?artS= &artAx= &artAy= &artRef=origin
        try {
            var t = JSON.parse(localStorage.getItem(TUNE_KEY));
            if (t) {
                if (isFinite(t.S)) ART.S = t.S;
                if (isFinite(t.ax)) ART.ax = t.ax;
                if (isFinite(t.ay)) ART.ay = t.ay;
                if (t.ref === 'origin' || t.ref === 'anchor') ART.ref = t.ref;
            }
        } catch (e) { /* no saved tuning */ }
        try {
            var qp = new URLSearchParams(location.search);
            var n = function (k) { var v = parseFloat(qp.get(k)); return isFinite(v) ? v : null; };
            if (n('artS') !== null) ART.S = n('artS');
            if (n('artAx') !== null) ART.ax = n('artAx');
            if (n('artAy') !== null) ART.ay = n('artAy');
            if (qp.get('artRef') === 'origin') ART.ref = 'origin';
        } catch (e) { /* no URL (headless harness) */ }
    })();
    window.ART = ART;                  // console: ART.ay = 1; __ART_tweak()
    window.__ART_tweak = function (patch) {
        for (var k in patch) ART[k] = patch[k];
        markDirty();
    };
    var citySprites = null;                 // city-sprites.json sprites map
    var cityFlags = null;                   // city-flags.json flags map (cloths)
    var charMan = null;                     // characters.json {assets, characters}
    (function loadManifests() {
        fetch(B + 'assets/city/city-sprites.json' + MANIFEST_V).then(function (r) {
            return r.ok ? r.json() : null;
        }).then(function (j) {
            if (j && j.sprites) {
                citySprites = j.sprites;
                ALOAD.artKnown += Object.keys(j.sprites).length;
                // season variants stream through the same art pill count
                for (var sk in j.sprites) {
                    var ss = j.sprites[sk].seasons;
                    if (!ss) continue;
                    for (var cc in ss) {
                        SEASON.present[cc] = (SEASON.present[cc] || 0) + 1;
                        ALOAD.artKnown++;
                    }
                }
                applySeasonMode();          // label the button with real data
                markDirty();
            }
            aBootSettled();
        }).catch(function () { aBootSettled(); /* blocks only */ });
        fetch(B + 'assets/city/city-flags.json' + MANIFEST_V).then(function (r) {
            return r.ok ? r.json() : null;
        }).then(function (j) {
            if (j && j.flags) {
                cityFlags = j.flags;
                ALOAD.artKnown += Object.keys(j.flags).length;
                markDirty();
            }
        }).catch(function () { /* no cloth overlay, poles only */ });
        fetch(B + 'assets/characters/characters.json').then(function (r) {
            return r.ok ? r.json() : null;
        }).then(function (j) {
            if (j && j.assets) {
                charMan = j;
                ALOAD.artKnown += Object.keys(j.assets).length;
                markDirty();
            }
            aBootSettled();
        }).catch(function () { aBootSettled(); /* dots only */ });
    })();
    function applyArtMode() {
        var b = $('btn-art');
        if (b) {
            b.classList.toggle('on', artMode === 1);
            b.textContent = artMode === 1 ? 'Art\u00b7sprites' : 'Art\u00b7blocks';
        }
        aPaint();                       // the art stream readout rides the toggle
    }
    (function loadArt() {
        var av = null;
        try { av = localStorage.getItem(ART_KEY); } catch (e) { /* private mode */ }
        artMode = (av === null || parseInt(av, 10) === 1) ? 1 : 0;   // default ON (M4 item 4)
        applyArtMode();
    })();
    if ($('btn-art')) $('btn-art').addEventListener('click', function () {
        artMode = artMode ? 0 : 1;
        try { localStorage.setItem(ART_KEY, String(artMode)); } catch (e) { /* private mode */ }
        applyArtMode();
        markDirty();
    });

    /* ---- in-place bsv3 animation --------------------------------------------
       Ported verbatim from city-view.js (behaviour map gating, togglers,
       tap one-shots, blit budget, readability floor, big-atlas tiers and
       the LRU bound). Cells are sub-textures of the decoded filmstrip
       instead of GL atlas cells, so the agl machinery is gone — texFor /
       subTex / dropTex carry the decode + eviction. */
    var ANIM_KEY = 'mrsnrub.cityview.anim';
    var animOn = true;
    var anims = null;                     // slug -> {cells:[strip…], base:0|1}
    var taps = {};                        // slug -> one-shot tap filmstrip
    var tapsA = {};                       // slug -> the SECOND one-shot of an
                                          // engine 'TapTwoRandom' verb: the
                                          // BuildingTouched script picks one
                                          // of the two at random per click
                                          // (CircusLion's Tap01/Tap02)
    var tapsL = {};                       // slug -> [strip…] layered one-shot
                                          // (behavior tapLayers: the Active
                                          // pair of a part stack, played
                                          // together over the body)
    var togglers = {};                    // slug -> engine click-state-machine
    var behav = null;                     // slug -> {idle, tap} (v2 manifest)
    var animNow = 0;                      // ms, one clock per rendered frame
    var animLive = 0;                     // animated sprites in the last frame
    var animTickMs = 90;                  // the fastest tick any strip drew
                                          // last frame, in ms at 1x: the
                                          // repaint throttle runs on it, so a
                                          // strip the generator re-timed onto
                                          // a 24 ticks/s clock is not sampled
                                          // at the 12 fps the floor assumes
                                          // (2026-11-04: a re-timed dragon
                                          // still turned only half its cells)
    var animPending = 0;                  // anims wanted but not drawable
                                          // (atlas decoding / big pool spent):
                                          // keeps the 90 ms anim tick alive so
                                          // the strip draws the moment it can
                                          // — without this the loop parked
                                          // with a half-loaded ship frozen
                                          // static until the next click
    var charAnimLive = 0;                 // animating character sprites
    var charPreview = null;               // {cid, cell} — card-driven preview
                                          // (CharVariants tile click)
    /* one global playback rate for the building filmstrips. The art carries no
       timing anywhere — bsv3 frames have no delay and none of the city pool's
       3 634 building XMLs has an fps/delay attribute (notes/01 "bsv3 playback
       rate — still unmeasured") — so the 12 fps the manifest stamps on all
       5 359 strips is OUR empirical constant, calibrated once against a
       screenshot. Scaling it is how a single object that reads wrong gets
       A/B'd against the game instead of guessed at.
       The rate multiplies a CLOCK (animClock), not each strip's fps: a
       one-shot already playing keeps its place when the rate changes instead of
       snapping to another frame, and the crowd's per-instance phase offsets
       (which are counted in ticks) stay put. Characters are NOT on this clock:
       their bcell art ships a real per-frame delay_ms, so their loops keep
       running on animNow at the authored speed.
       The shipped default is 2×. That is an eye calibration, not a measurement
       (2026-11-03): with the control in place the town was compared against the
       game screenshot, the bare 12 fps read slow and 2× — 24 ticks/s — read
       right. 1× stays on the ladder as the manifest's unmodified rate, which is
       the reference any future ANIM_FPS argument has to be made against. */
    var ANIMSPEED_KEY = 'mrsnrub.cityview.animspeed';
    var ANIM_SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];   // the button ladder
    var ANIM_SPEED_DEFAULT = 2;         // 2× the manifest's 12 fps; see above
    var animSpeed = ANIM_SPEED_DEFAULT;
    var animClock = 0;                  // ms, animNow scaled by animSpeed
    var animClockT = 0;                 // real ms animClock last advanced at
    var CHAR_ANIM_MIN_PX = QP.get('charAnimMinPx') !== null
        ? (Math.abs(QP.get('charAnimMinPx') | 0)) : 24;
    var animNextT = 0;
    var ANIM_MAX_BLITS = QP.get('animMax') !== null
        ? Math.max(0, parseInt(QP.get('animMax'), 10) || 0) : 96;
    var animBudget = 0;                   // blits left this rendered frame
    var ANIM_MIN_PX = QP.get('animMinPx') !== null
        ? Math.max(0, parseInt(QP.get('animMinPx'), 10) || 0) : 48;
    var ANIM_MAX_ATLAS_PX = 16e6;
    /* A page over the GPU's texture side limit uploads INCOMPLETE and
       WebGL samples an incomplete texture as opaque black — privateisland05's
       first 22-frame sparse atlas (769x20161) rendered the whole building
       black on a 16384-side GPU (2026-10-30). Refuse such strips (the
       building falls back to its body PNG instead); the generator caps
       its sparse pages at 4096 a side, this guards against manifests
       that predate or outgrow that. Probe the real limit once (the
       harness has no GL: fall back to the common desktop floor). */
    var ANIM_MAX_SIDE = (function () {
        var m = 0;
        try {
            var c = document.createElement('canvas');
            var gl = c.getContext('webgl2') || c.getContext('webgl');
            if (gl) {
                m = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0;
                var ext = gl.getExtension &&
                          gl.getExtension('WEBGL_lose_context');
                if (ext) ext.loseContext();   // hand the context slot back
            }
        } catch (e) { /* no GL to ask */ }
        return m > 0 ? m : 16384;
    })();
    var ANIM_BIG_ATLAS_PX = 6e6;
    var ANIM_BIG_MAX = 8;
    var ANIM_CACHE_MAX = 40;
    var animBigLive = 0;
    var animBig = {};                     // big-tier resident urls (the
                                          // budget releases on LRU eviction:
                                          // with the over-cap fleet thinned
                                          // into this tier, a never-released
                                          // 8-slot budget starved whoever
                                          // panned in second)
    var ANIM_HUGE_MAX = 4;
    var animHuge = {};                    // oversize filmstrip url -> strip png
    var animLru = [];                     // filmstrip urls, most-recent last
    /* the pill's "known" total must cover the filmstrips too, not just the
       body PNGs: they are art files the viewer asks for by the hundred and
       leaving them out is how the readout could read "art 16,274/7,844" */
    var artStripKnown = {};
    function artKnownStrip(e) {
        if (!e) return;
        var u = cityUrl(e.png);
        if (artStripKnown[u]) return;
        artStripKnown[u] = 1;
        ALOAD.artKnown++;
        ALOAD.strips++;                 // harness: the filmstrip share of known
    }
    function artKnownTog(t) {
        if (!t) return;
        artKnownStrip(t['in']);
        artKnownStrip(t.out);
        artKnownStrip(t.loop);
        for (var i = 0; t.poses && i < t.poses.length; i++) artKnownStrip(t.poses[i]);
    }
    (function loadAnims() {
        fetch(B + 'assets/city/city-anims.json' + MANIFEST_V).then(function (r) {
            return r.ok ? r.json() : null;
        }).then(function (j) {
            if (!j || !j.anims) return;
            anims = {}; taps = {}; tapsA = {}; tapsL = {}; togglers = {};
            behav = j.behavior || null;
            for (var s in j.anims) {
                var list = j.anims[s];     // generator sorts loops longest-first
                if (!list || !list.length) continue;
                var loop = behav ? pickAnim(list, behav[s] && behav[s].idle)
                                 : list[0];
                var tap = behav ? pickAnim(list, behav[s] && behav[s].tap)
                                : null;
                /* layers first: a part stack always owns the idle slot,
                   even if the gate also carries an idle (a lone part strip
                   would REPLACE the body and blank the object's other half) */
                if (behav && behav[s] && behav[s].layers) {
                    var cs = [], seen = [], li;
                    for (li = 0; li < behav[s].layers.length; li++) {
                        var e = pickAnim(list, behav[s].layers[li]);
                        if (e && e.frames >= 1 && seen.indexOf(e.anim) < 0) {
                            seen.push(e.anim); cs.push(e); artKnownStrip(e);
                        }
                    }
                    if (cs.length) anims[s] = { cells: cs, base: 1 };
                }
                if (!anims[s] && loop && loop.frames > 1) {
                    anims[s] = { cells: [loop], base: 0 };
                    artKnownStrip(loop);
                }
                if (tap && tap.frames > 1 && tap !== loop) {
                    taps[s] = tap;
                    artKnownStrip(tap);
                    // 'TapTwoRandom' ships a second one-shot: register it
                    // too, tapBuilding picks one of the two at random
                    var tapB = behav ? pickAnim(list, behav[s] &&
                                                 behav[s].tapAlt) : null;
                    if (tapB && tapB.frames > 1 && tapB !== tap &&
                            tapB !== loop) {
                        tapsA[s] = tapB;
                        artKnownStrip(tapB);
                    }
                }
                if (behav && behav[s] && behav[s].layers &&
                        behav[s].tapLayers) {
                    // layered click one-shot: every part's Active strip
                    // must resolve, or the pair is not a pair — fall back
                    // to the plain tap (or none) rather than play half
                    var tls = [], tlseen = [], ti;
                    for (ti = 0; ti < behav[s].tapLayers.length; ti++) {
                        var te = pickAnim(list, behav[s].tapLayers[ti]);
                        if (!te || te.frames < 2 ||
                                tlseen.indexOf(te.anim) >= 0) {
                            tls = null;
                            break;
                        }
                        tlseen.push(te.anim);
                        tls.push(te);
                    }
                    if (tls && tls.length > 1) {
                        tapsL[s] = tls;
                        for (var tj2 = 0; tj2 < tls.length; tj2++)
                            artKnownStrip(tls[tj2]);
                    }
                }
                var tg = behav && behav[s] && behav[s].toggle;
                if (tg) {
                    var kind = tg.kind || 'inout', a2, i2, rec2 = null;
                    if (kind === 'inout') {
                        var aIn = pickAnim(list, tg['in']),
                            aLp = pickAnim(list, tg.loop),
                            aOut = pickAnim(list, tg.out);
                        if (aIn && aOut && aIn.frames > 1 && aOut.frames > 1)
                            rec2 = { kind: 'inout', 'in': aIn, out: aOut,
                                     loop: (aLp && aLp.frames > 1) ? aLp : null };
                    } else if (kind === 'active') {
                        a2 = pickAnim(list, tg.loop);
                        if (a2 && a2.frames > 1)
                            rec2 = { kind: 'active', loop: a2 };
                    } else if (kind === 'cycle' && tg.poses) {
                        var ps = [];
                        for (i2 = 0; i2 < tg.poses.length; i2++)
                            ps.push(tg.poses[i2] ? pickAnim(list, tg.poses[i2]) : null);
                        for (i2 = 1; i2 < ps.length; i2++)
                            if (ps[i2] && ps[i2].frames > 1) rec2 = { kind: 'cycle', poses: ps };
                    }
                    if (rec2) { togglers[s] = rec2; artKnownTog(rec2); }
                }
            }
            window.__CV_ANIM = anims;
            applyAnimMode();
            markDirty();
        }).catch(function () { /* static sprites only */ });
    })();
    function togLabel(t) {
        if (!t) return '';
        var k = t.kind || 'inout';
        if (k === 'active') return t.loop + ' on/off';
        if (k === 'cycle')
            return (t.poses || []).map(function (p) { return p || 'static'; })
                .join(' \u2192 ');
        return t['in'] + ' \u2192 ' + (t.loop || '(hold ' + t['in'] + ')') +
            ' \u2192 ' + t.out;
    }
    function pickAnim(list, name) {
        if (!name) return null;
        var n = String(name).toLowerCase(), i;
        for (i = 0; i < list.length; i++)
            if (list[i].anim.toLowerCase() === n) return list[i];
        if (n.length > 6 && n.slice(-6) === 'noloop') {
            n = n.slice(0, -6).replace(/[_-]+$/, '');
            for (i = 0; i < list.length; i++)
                if (list[i].anim.toLowerCase() === n) return list[i];
        }
        return null;
    }
    function applyAnimMode() {
        var b = $('btn-anim');
        if (b) b.classList.toggle('on', !!(animOn && anims));
    }
    (function loadAnimPref() {
        try { animOn = localStorage.getItem(ANIM_KEY) !== '0'; } catch (e) { /* private mode */ }
    })();
    if ($('btn-anim')) $('btn-anim').addEventListener('click', function () {
        animOn = !animOn;
        try { localStorage.setItem(ANIM_KEY, animOn ? '1' : '0'); } catch (e) { /* private mode */ }
        applyAnimMode();
        markDirty();
    });
    /* the playback rate: the shipped default first, then any saved choice, then
       ?animSpeed= over both so a rate worth quoting can be pasted as a URL (same
       habit as the camera/orientation knobs). Outside the ladder a URL value is
       still honoured, clamped — 8× is well past anything the art was authored
       for and below it the strips just crawl, so the clamp only stops a typo
       starving the frame. */
    /* the ladder and its label are plain functions of the rate so the harness
       can run them verbatim out of this file (the pattern the other Pixi checks
       use) rather than reimplementing them and drifting */
    function animSpeedStep(cur, back) {   // the button's steps, wrapping at both
                                          // ends; a ?animSpeed= that is not on
                                          // the ladder rejoins it at the default
        var i = ANIM_SPEEDS.indexOf(cur);
        if (i < 0) i = ANIM_SPEEDS.indexOf(ANIM_SPEED_DEFAULT);
        i += back ? -1 : 1;
        if (i < 0) i = ANIM_SPEEDS.length - 1;
        if (i >= ANIM_SPEEDS.length) i = 0;
        return ANIM_SPEEDS[i];
    }
    function animSpeedX(v) {              // the bare rate as text: 2 → "2×"
        v = (v === undefined) ? animSpeed : v;
        return (v === Math.floor(v) ? v : v.toFixed(2).replace(/0$/, '')) +
            '\u00d7';
    }
    function animSpeedLabel() {           // the button's whole label
        return 'Speed ' + animSpeedX(animSpeed);
    }
    function applyAnimSpeed() {
        var b = $('btn-animspeed');
        if (b) b.textContent = animSpeedLabel();
    }
    (function loadAnimSpeed() {
        var v = NaN;
        try { v = parseFloat(localStorage.getItem(ANIMSPEED_KEY)); } catch (e) { /* private mode */ }
        var q = parseFloat(QP.get('animSpeed'));
        if (isFinite(q) && q > 0) v = q;
        if (isFinite(v) && v > 0) animSpeed = Math.min(8, Math.max(0.1, v));
        applyAnimSpeed();
    })();
    if ($('btn-animspeed')) $('btn-animspeed').addEventListener('click', function (ev) {
        animSpeed = animSpeedStep(animSpeed, !!(ev && ev.shiftKey));
        try { localStorage.setItem(ANIMSPEED_KEY, String(animSpeed)); } catch (e) { /* private mode */ }
        applyAnimSpeed();
        markDirty();                      // re-show the new rate even on a still frame
    });
    function animKey(b) {                 // strips follow the DRAWN sprite:
        if (!b.slug) return null;         // a mirrored instance needs the
        if (!b.flip) return b.slug;       // mirrored filmstrip, never the
        if (citySprites && citySprites[b.slug + 'flipped'])
            return b.slug + 'flipped';    // unmirrored one
        // flipState-1 with no baked <slug>flipped twin (the Dragon of
        // Springfieldia, 2026-11-04): the body pass already mirrors the
        // base PNG in place (emitBuilding's mir), which is exactly what
        // the shipped twin's art shows — so the strips ride the same
        // stand-in, blitted mirrored about the pin column, instead of the
        // building sitting frozen with no idle and no click one-shot.
        return b.flip === 1 ? b.slug : null;
    }
    function animOf(b, k) {
        if (!anims || !animOn || !artMode) return null;
        var key = animKey(b);
        if (!key) return null;
        // season-mode art: the filmstrips were cut from the BASE sheet, so
        // overlaying their cells on a snowy/fall body would mix seasons —
        // the building draws its static season PNG instead
        var base = citySprites && citySprites[key];
        if (base && base.seasons && base.seasons[SEASON.mode]) return null;
        var tp = b._tap;              // a tapped building plays its one-shot
        if (tp) {
            var tfi = Math.floor((animClock - tp.t0) * tp.a.fps / 1000);
            if (tfi >= (tp.n || tickCount(tp.a))) {   // one loop of the
                b._tap = null;                        // ENGINE's ticks, not
                if (tp.then !== undefined) b._tog = tp.then;
            }
            else {
                // taps skip the blit budget; every one-shot is click-driven,
                // so like the toggle transitions it is exempt from the
                // huge-atlas cap — the big rotor strips of the police/
                // attack/burns helis are plain taps. A layered one-shot
                // (tapsL) blits every part's cell at the same frame (short
                // strips hold their last cell), the body underneath them
                var tls = tp.list || [tp.a], trs = [], tj;
                for (tj = 0; tj < tls.length; tj++) {
                    var ta = tls[tj], tn = tickCount(ta);
                    var tr = animCell(ta, k, cellAt(ta, Math.min(tfi, tn - 1)),
                                      true);
                    if (!tr) {
                        if (tp.base) trs = null;   // stack draws whole, or
                        break;                     // not at all: idle answers
                    }
                    tr.tap = 1;
                    trs.push(tr);
                }
                if (trs && trs.length)
                    return { cells: trs, base: tp.base || 0, tap: 1 };
                // gated (under the readability floor): the one-shot can't
                // draw — let the idle path answer instead
            }
        }
        if (animBudget <= 0) return null;
        var ph = Math.abs(Math.round((b.px || 0) * 3 + (b.py || 0) * 7));
        var tg = togglers[key];
        if (tg) {
            var st = b._tog | 0, a = null, hold = 0;
            if (tg.kind === 'cycle') {
                if (st >= tg.poses.length) st = 0;
                a = tg.poses[st];
            } else if (st) {
                a = tg.loop || tg['in'];
                hold = tg.loop ? 0 : 1;
            }
            if (a) {
                var c = animCell(a, k, hold ? a.frames - 1
                    : animIdx(a, animClock, ph), true);
                return c ? { cells: [c], base: 0 } : null;
            }
        }
        var rec = anims[key];
        if (!rec) return null;
        var cells = null;
        for (var i = 0; i < rec.cells.length; i++) {
            var a2 = rec.cells[i];
            var c2 = animCell(a2, k, animIdx(a2, animClock, ph));
            if (!c2) {
                if (rec.base) return null;    // a layered stack composites whole
                continue;
            }
            if (!cells) cells = [];
            cells.push(c2);
        }
        if (!cells) return null;
        return { cells: cells, base: rec.base };
    }
    function animCell(a, k, fi, oversize) {
        if (a.px === undefined)
            a.px = a.w ? a.w * a.h
                       : a.cols * a.cellw * Math.ceil(a.frames / a.cols) * a.cellh;
        if ((a.px > ANIM_MAX_ATLAS_PX && !oversize) ||
            Math.min(a.cellw, a.cellh) * k < ANIM_MIN_PX) return null;
        if (Math.max(a.w || a.cols * a.cellw,
                     a.h || Math.ceil(a.frames / a.cols) * a.cellh) > ANIM_MAX_SIDE)
            return null;              // over the GPU's texture side limit
        return { a: a, fi: fi };
    }
    /* Is any of this cell's art inside the viewport? Asked BEFORE the atlas is
       requested: a cell that cannot be seen must not spend a cache slot (nor
       veto a part stack). Same bounds the blit itself culls by. */
    /* Would any pixel of this instance's art land in the window? The instance
       cull works in TILE space with a +-6 tile ring (a tall sprite whose lot
       sits just off camera does paint in), which is right for drawing but was
       also what asked for the FILE — so the ring requested, and decoded, art
       that could not be seen. Checked before texFor/imgFor, with the same
       bounds the blits themselves cull by; a filmstrip counts as well, since
       its cells can overhang the body it sits on.
       A band AROUND the window counts as inside: art about to scroll in is
       asked for one quarter-viewport early, so a pan does not pop sprites in
       after their decode latency. It is a band, not the tile ring — the whole
       map is never inside it (knob: __CV_ART_prefetch(0) for the strict
       case, which is also how the harness measures). */
    var ART_PREFETCH = 0.25;
    function artMargin() {
        return Math.round(Math.min(VW, VH) * ART_PREFETCH) + 4;
    }
    function quadIn(x, y, w, h) {
        var m = artMargin();
        return !(x + w < -m || x > VW + m || y + h < -m || y > VH + m);
    }
    function artReachable(sp, px, py, bl, k, key) {
        if (quadIn(bl, py - sp.anchor[1] * k, sp.w * k, sp.h * k)) return true;
        if (sp.stack) {                         // the baked stack (the sea
            var s2 = sp.stack;                  // fleet) can be larger than
            if (quadIn(px - Math.max(sp.anchor[0], s2.anchor[0]) * k,
                       py - Math.max(sp.anchor[1], s2.anchor[1]) * k,   // the body
                       Math.max(sp.w, s2.w) * k,                        // it replaces
                       Math.max(sp.h, s2.h) * k)) return true;
        }
        var an = (typeof anims !== 'undefined' && anims) ? anims[key] : null;
        var list = an && an.cells ? an.cells : null;      // the registry is a
        for (var ci = 0; list && ci < list.length; ci++) {  // side-effect-free
            var st = list[ci].a || list[ci];                 // read of the strips
            var cw = st.cellw || st.w, ch = st.cellh || st.h;
            if (st.sub) {                 // sparse strip: any rect of any cell
                for (var fi in st.sub) {
                    var rs = st.sub[fi] || [];
                    for (var j = 0; j < rs.length; j++)
                        if (quadIn(px + rs[j].ox * k, py + rs[j].oy * k,
                                   rs[j].w * k, rs[j].h * k)) return true;
                }
                continue;
            }
            if (cw && ch && quadIn(px - (st.ax || 0) * k, py - (st.ay || 0) * k,
                                   cw * k, ch * k)) return true;
        }
        return false;
    }
    function cellOnScreen(a, fi, px, py, k, mir) {
        // mir: the instance draws its base strips mirrored about the pin
        // column (animKey's no-twin flip stand-in) — the cell lands at the
        // reflected rect, so that's the rect the cull must test
        if (a.sub) {                        // sparse strip: any rect of the cell
            var rs = a.sub[fi] || [];
            for (var j = 0; j < rs.length; j++) {
                var r = rs[j];
                var rx = mir ? px - r.ox * k - r.w * k : px + r.ox * k;
                if (rx + r.w * k >= -4 && rx <= VW + 4 &&
                    py + r.oy * k + r.h * k >= -4 && py + r.oy * k <= VH + 4)
                    return true;
            }
            return false;
        }
        var aw = a.cellw * k;
        var ax0 = mir ? px + a.ax * k - aw : px - a.ax * k;
        var ay0 = py - a.ay * k;
        return !(ax0 + aw < -4 || ax0 > VW + 4 ||
                 ay0 + a.cellh * k < -4 || ay0 > VH + 4);
    }
    /* keep the 90 ms anim tick alive only while an atlas this building wants is
       genuinely still decoding: a strip refused for lack of a slot retries on
       the next natural frame (the fleet around it ticks anyway), so it does not
       need the whole page repainting forever */
    function animDecoding(an) {
        for (var i = 0; i < an.cells.length; i++) {
            var r = texs[animUrlFor(an.cells[i].a)];
            if (r && r.st === 0) return 1;
        }
        return 0;
    }
    function ubOf(a) {                    // anchor-relative drawing bounds
        if (!a.sub) {
            if (!a.ub) a.ub = [-a.ax, -a.ay, -a.ax + a.cellw,
                               -a.ay + a.cellh];
            return a.ub;
        }
        if (a.ub === undefined) {
            var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
            for (var f = 0; f < a.sub.length; f++)
                for (var q = a.sub[f], j = 0; j < q.length; j++) {
                    var r = q[j];
                    if (r.ox < x0) x0 = r.ox;
                    if (r.oy < y0) y0 = r.oy;
                    if (r.ox + r.w > x1) x1 = r.ox + r.w;
                    if (r.oy + r.h > y1) y1 = r.oy + r.h;
                }
            a.ub = x1 > x0 ? [x0, y0, x1, y1] : null;
        }
        return a.ub;
    }
    function animFrame(a, b, nowMs) {
        var ph = Math.abs(Math.round((b.px || 0) * 3 + (b.py || 0) * 7));
        return animIdx(a, nowMs === undefined ? animClock : nowMs, ph);
    }
    function animIdx(a, clockMs, ph) {   // shared clock -> this strip's cell
        return cellAt(a, (Math.floor(clockMs * a.fps / 1000) + ph) %
                         tickCount(a));
    }
    function tickCount(a) {              // ticks in the strip's engine loop
        return a.lt || a.lf || a.frames;
    }
    function tickCell(a, t) {            // cell to show on tick t of that loop
        var rp = a.rp, k = -1, bv = -1, i;
        // the engine holds each raw frame for a tick and the atlas only keeps
        // the frames that differ, so tick t shows the newest cell at or before
        // it — wrapping to the last cell for the ticks before the first
        for (i = 0; i < rp.length; i++)
            if (rp[i] <= t && rp[i] > bv) { bv = rp[i]; k = i; }
        return k < 0 ? rp.length - 1 : k;
    }
    function cellAt(a, t) {              // cell to show on engine tick t
        var n = tickCount(a);
        if (t >= n) return -1;
        if (a.rp) return tickCell(a, t);
        return a.lf && n !== a.frames    // pre-rp thinning: spread the cells
            ? Math.min(Math.floor(t * a.frames / n), a.frames - 1)
            : t;                         // evenly over the loop
    }
    window.__CV_ANIM_FI = function (slug, b, nowMs) {   // smoke-test probe
        if (!anims || !anims[slug]) return -1;
        return animFrame(anims[slug].cells[0], b, nowMs);
    };
    /* the scaled clock and the rate as probes: the harness can then prove a
       rate change really runs the strips faster, not just the label */
    window.__CV_ANIM_CLOCK = function () { return animClock; };
    window.__CV_ANIM_SPEED = function () { return animSpeed; };
    window.__CV_ANIM_cell = function (slug, b, i, nowMs) {  // harness: clock
        var r = anims && anims[slug];                        // mapping per
        if (!r || !r.cells[i]) return -1;                    // registered part
        return animIdx(r.cells[i], nowMs || 0,
            Math.abs(Math.round((b.px || 0) * 3 + (b.py || 0) * 7)));
    };
    window.__CV_ANIM_layers = function (slug) {         // smoke-test probe
        var r = anims && anims[slug];
        return r ? { n: r.cells.length, base: r.base,
                     anims: r.cells.map(function (a) { return a.anim; }) } : null;
    };
    window.__CV_ANIM_tapLayers = function (slug) {      // smoke-test probe
        var r = tapsL[slug];
        return r ? r.map(function (a) { return a.anim; }) : null;
    };
    window.__CV_ANIM_tap = function (slug) {        // smoke-test probe: the
        var r = taps[slug];                         // registered one-shot(s)
        return r ? { a: r.anim,                     // tap + the random-of-two
                     alt: tapsA[slug] ? tapsA[slug].anim : null } : null;
    };
    /* the cadence AS THE PLAYER RUNS it: ticks per cell and real seconds per
       pose at the current rate, for every strip registered for a slug. The
       numbers a "that reads slow" report is really about — the manifest can
       say 12 cells and the player can still be holding each one for half a
       second (2026-11-04, the Dragon of Springfieldia) */
    window.__CV_ANIM_hold = function (slug) {
        var r = anims && anims[slug], a, i, n, c, list = [], out = [];
        if (r) for (i = 0; i < r.cells.length; i++) list.push(r.cells[i]);
        if (taps[slug]) list.push(taps[slug]);
        if (tapsA[slug]) list.push(tapsA[slug]);
        if (tapsL[slug]) for (i = 0; i < tapsL[slug].length; i++)
            list.push(tapsL[slug][i]);
        for (i = 0; i < list.length; i++) {
            a = list[i];
            n = tickCount(a);
            c = (a.rp ? a.rp.length : a.frames) || 1;
            out.push({ anim: a.anim, cells: c, ticks: n, raw: a.lt0 || n,
                       ticksPerCell: n / c,
                       secPerPose: n / c / (a.fps * animSpeed),
                       loopSec: n / (a.fps * animSpeed) });
        }
        return out.length ? out : null;
    };
    function tapBuilding(b) {
        if (!b || !anims || !animOn || !artMode) return false;
        var key = animKey(b);
        if (!key) return false;
        var tg = togglers[key];
        if (tg) {
            if (b._tap) return false;
            if (tg.kind === 'inout') {
                b._tap = b._tog
                    ? { a: tg.out, t0: animClock, then: 0 }
                    : { a: tg['in'], t0: animClock, then: 1 };
            } else if (tg.kind === 'active') {
                b._tog = b._tog ? 0 : 1;
            } else {
                b._tog = ((b._tog | 0) + 1) % tg.poses.length;
            }
            markDirty();
            return true;
        }
        var tl = tapsL[key];
        if (tl) {
            if (b._tap) return false;
            var n = 0, i3;
            for (i3 = 0; i3 < tl.length; i3++)
                if (tickCount(tl[i3]) > n) n = tickCount(tl[i3]);
            b._tap = { a: tl[0], list: tl, n: n, base: 1,
                       t0: animClock };
            markDirty();
            return true;
        }
        var t = taps[key];
        if (!t) return false;
        // the engine's random-of-two tap: half the clicks play the other strip
        if (tapsA[key] && Math.random() < 0.5) t = tapsA[key];
        // a single-strip tap on a LAYERED asset (the Active verb never
        // paired): draw the body under it too, or the object blanks down
        // to one part for the length of the one-shot
        b._tap = { a: t, t0: animClock,
                   base: (anims[key] && anims[key].base) ? 1 : 0 };
        markDirty();
        return true;
    }
    function blockAtTile(tx, ty) {
        for (var k = buildings.length - 1; k >= 0; k--) {   // front-to-back
            var b = buildings[k];
            if (objHidden[b.cat] || hiddenObjs[b.hkey]) continue;
            if (tx >= b.x0 && tx < b.x1 && ty >= b.y0 && ty < b.y1) return b;
        }
        return null;
    }
    window.__CV_TAP = function (mi, fire) {  // console/harness: inspect/fire
        var b = byMi[mi];
        if (!b) return -1;
        if (fire) tapBuilding(b);
        if (!b._tap) return -1;
        var fi = Math.floor((animClock - b._tap.t0) *
                            b._tap.a.fps / 1000);
        return fi < (b._tap.n || tickCount(b._tap.a)) ? fi : -1;
    };
    window.__CV_TAP_at = function (tx, ty, fire) {  // harness: lot rule
        var b = blockAtTile(tx, ty);
        if (!b) return -1;
        if (fire) tapBuilding(b);
        if (!b._tap) return -1;
        var fi = Math.floor((animClock - b._tap.t0) *
                            b._tap.a.fps / 1000);
        return fi < (b._tap.n || tickCount(b._tap.a)) ? fi : -1;
    };
    window.__CV_TOG = function (mi) {
        var b = byMi[mi];
        if (!b) return null;
        if (b._tap) return 'play';
        var k = animKey(b);
        var tg = k && togglers[k];
        if (tg && tg.kind === 'cycle') return 'pose' + (b._tog | 0);
        return b._tog ? 'active' : 'neutral';
    };
    window.__CV_TOG_strip = function (mi) {
        var b = byMi[mi];
        if (!b) return null;
        if (b._tap) return b._tap.list
            ? b._tap.list.map(function (x) { return x.anim; }).join('+')
            : b._tap.a.anim;
        var k = animKey(b);
        var tg = k && togglers[k];
        if (!tg) return null;
        var st = b._tog | 0;
        if (tg.kind === 'cycle')
            return st < tg.poses.length && tg.poses[st] ? tg.poses[st].anim : null;
        return st ? (tg.loop || tg['in']).anim : null;
    };
    window.__CV_TILE_screen = function (tx, ty) {  // harness: tile -> screen
        var w = CAM.tileToWorld(tx, ty);
        return CAM.worldToScreen(cam, w.x, w.y, VW, VH);
    };
    window.__CV_ANIM_max = function (n) {
        if (n !== undefined) ANIM_MAX_BLITS = Math.max(0, n | 0);
        return ANIM_MAX_BLITS;
    };
    window.__CV_ANIM_minPx = function (n) {
        if (n !== undefined) ANIM_MIN_PX = Math.max(0, n | 0);
        return ANIM_MIN_PX;
    };
    /* ---- filmstrip atlas cache ------------------------------------------------
       Three caps bound what the player keeps decoded: the big-atlas tier
       (ANIM_BIG_MAX strips over ANIM_BIG_ATLAS_PX), the oversize pool
       (ANIM_HUGE_MAX — only the click-driven paths reach it) and the LRU
       bound (ANIM_CACHE_MAX decoded filmstrips). A full cap is a REASON TO
       WAIT, never a licence to drop a strip the player is looking at.

       animUse records the last frame the renderer asked for each url and every
       eviction path refuses to touch a strip asked for on THIS frame or the
       last — the last frame matters, because when an arrival needs a slot the
       buildings drawn later in the same frame have not stamped yet, so a
       one-frame test would drop them and re-decode them in the same breath.
       When the whole cache is on screen the arrival is refused instead: it
       draws its static PNG this frame and asks again on the next tick.
       Evicting a visible strip frees nothing anyway — the next frame asks for
       it back — so a wide zoom over the ocean fleet (96 blit budget against 8
       big-tier and 40 LRU slots) used to churn one multi-megapixel decode per
       frame, forever, and count each one as new art in the pill. */
    var animFrameId = 0;                  // bumped once per rendered frame
    var animUse = {};                     // url -> last frame the renderer drew it
    var animRefused = 0;                  // arrivals that had to wait for a slot
    var animReloads = 0;                  // re-decodes of an already-settled file
    var animDrops = 0;                    // decodes freed by eviction
    var animRetryT = 0;                   // one-shot retry deadline
    var animTried = {};                   // url -> asked for a slot once already
    function animInUse(url) {             // asked for now, or a frame ago
        var u = animUse[url];
        return u === animFrameId || u === animFrameId - 1;
    }
    /* no slot this frame: draw static and ask again soon. The retry window is
       armed once per url (animTried) so a strip that can never get in — the
       whole cache is on screen and nobody moves — does not keep the page
       repainting forever, which is what the "always loading" pill looked like
       from the outside. */
    function animWait(url) {
        animRefused++;
        if (!animTried[url]) {
            animTried[url] = 1;
            if (animNow >= animRetryT) animRetryT = animNow + 2000;
        }
        return null;
    }
    /* the tier budgets are SESSION caps and arrivals keep coming (heli rotor
       taps, the thinned over-cap fleet crowding the big tier): recycle the
       oldest entry of the tier that nothing on screen wants. */
    function freeSlot(tier) {
        var i, b, live = {};
        for (i = 0; i < buildings.length; i++) {
            b = buildings[i];
            if (b._tap) {
                if (b._tap.list)            // layered one-shot: every part
                    for (var q = 0; q < b._tap.list.length; q++)
                        live[b._tap.list[q].png] = 1;
                else live[b._tap.a.png] = 1;
            }
            if (b._tog) {                       // an engaged toggle machine
                var tgx = togglers[animKey(b)]; // still blits its state strip
                if (!tgx) continue;
                var pa = tgx.kind === 'cycle'
                    ? tgx.poses[(b._tog | 0) % tgx.poses.length]
                    : tgx.loop || tgx['in'];
                if (pa) live[pa.png] = 1;
            }
        }
        for (i = 0; i < animLru.length; i++) {
            var old = animLru[i];
            if (!tier[old] || live[tier[old]] || animInUse(old)) continue;
            delete tier[old];                   // frees the tier slot
            animLru.splice(i, 1);
            dropTex(old, 1);
            return true;
        }
        return false;
    }
    /* one LRU slot for a new arrival; false = every resident strip is on
       screen right now, so the arrival waits instead of evicting one */
    function freeCacheSlot(click) {
        if (animLru.length < ANIM_CACHE_MAX) return true;
        for (var i = 0; i < animLru.length; i++) {
            var old = animLru[i];
            if (animInUse(old)) continue;
            animLru.splice(i, 1);
            delete animHuge[old];
            dropTex(old, 1);
            if (animNow >= animRetryT) animRetryT = animNow + 2000;
            return true;                    // a strip just freed: retry soon
        }
        /* nothing to spare: a click-driven one-shot still gets in, up to the
           oversize pool's own slack — it is what the player just asked to see
           and it is gone in a second, while what it would displace is only an
           idle loop that would re-decode the moment it came back */
        return !!click && animLru.length < ANIM_CACHE_MAX + ANIM_HUGE_MAX;
    }
    /* filmstrip request point: enforces the big-atlas session budget and the
       LRU bound. Returns the decoded texture, null = draw the static PNG
       instead (still decoding / no slot free yet). */
    function animAtlasFor(a, click) {
        var url = animUrlFor(a);
        animUse[url] = animFrameId;         // the renderer wants it THIS frame
        if (url in texs) {                  // touch -> most-recently-used
            var i = animLru.indexOf(url);
            if (i < 0) animLru.push(url);
            else if (i < animLru.length - 1) {
                animLru.splice(i, 1);
                animLru.push(url);
            }
            return texFor(url);
        }
        if (a.px > ANIM_MAX_ATLAS_PX ||
            (click && a.px > ANIM_BIG_ATLAS_PX)) {
            // oversize: only the click-driven paths (toggle machines
            // and tap one-shots) ever ask, so it rides the small
            // oversize session pool — recycled by freeSlot() on
            // demand (the ziffcorp heli tap at 15.7M sat just under
            // the big-tier cap and starved there), while the big tier
            // is for loops the map picked on its own
            if (!animHuge[url]) {
                if (Object.keys(animHuge).length >= ANIM_HUGE_MAX &&
                    !freeSlot(animHuge)) return animWait(url);
                animHuge[url] = a.png;
            }
        } else if (a.px > ANIM_BIG_ATLAS_PX) {
            if (!animBig[url]) {
                // full is not fatal: recycle the big strip nobody is watching
                // — off-screen ones only, since animUse protects a visible
                // one. Without this the pool filled once and every later ship
                // (the thinned fleet!) drew static forever; with this but
                // without that protection it churned instead.
                if (animBigLive >= ANIM_BIG_MAX && !freeSlot(animBig))
                    return animWait(url);
                animBig[url] = 1;
                animBigLive++;
            }
        }
        if (!freeCacheSlot(click)) {        // full of visible strips: wait
            if (animBig[url]) { delete animBig[url]; animBigLive--; }
            delete animHuge[url];
            return animWait(url);
        }
        animLru.push(url);
        return texFor(url);
    }
    function animWanted() {                 // distinct strips drawn last frame
        var n = 0, u;
        for (u in animUse) if (animInUse(u)) n++;
        return n;
    }
    window.__CV_ANIM_stats = function () {    // console/harness telemetry
        return { big: animBigLive, bigMax: ANIM_BIG_MAX,
                 lru: animLru.length, lruMax: ANIM_CACHE_MAX,
                 capPx: ANIM_MAX_ATLAS_PX, bigPx: ANIM_BIG_ATLAS_PX,
                 wanted: animWanted(), refused: animRefused,
                 reloads: animReloads, drops: animDrops };
    };
    window.__CV_ANIM_clear = function () {    // harness: forget every filmstrip
        var us = animLru.slice();             // decode, so an arrival under a
        animLru.length = 0;                   // shrunk cap can be re-watched
        for (var u in animBig) delete animBig[u];
        for (var u2 in animHuge) delete animHuge[u2];
        animBigLive = 0;
        for (var i = 0; i < us.length; i++) dropTex(us[i]);
        return 0;
    };
    window.__CV_ANIM_cache = function (n) {   // harness: shrink the bound and
        if (n !== undefined) ANIM_CACHE_MAX = Math.max(1, n | 0);
        return ANIM_CACHE_MAX;                // watch it honour it calmly
    };
    window.__CV_ANIM_bigmax = function (n) {  // harness: same for the big tier
        if (n !== undefined) ANIM_BIG_MAX = Math.max(0, n | 0);
        return ANIM_BIG_MAX;
    };
    /* ---- "is it loading the whole map?" audit (console: __CV_ART_audit()) ----
       Answers the question the pill cannot: the pill counts files ever asked
       for, which correctly rises as you zoom out and more of the map is on
       screen. What must NOT happen is asking for art the player cannot see.
       So: rebuild the set of art the CURRENT viewport legitimately owns and
       classify each art file requested against it. offScreen counts should
       stay at zero — a non-zero one is an un-gated request path. */
    /* Does any of this instance's art reach the window? The LOT alone is not
       enough: a tall sprite is drawn from its anchor and paints far outside
       its footprint, and a filmstrip cell has its own bounds again. Test all
       three with the same maths the blits use, so the audit blames a request
       only when nothing of it could have been seen. */
    function artOwnedByWindow(b, A, mgn) {
        var x0 = A.a * b.x0 + A.b * b.y0 + A.c, y0 = A.d * b.x0 + A.e * b.y0 + A.f;
        var x1 = A.a * b.x1 + A.b * b.y1 + A.c, y1 = A.d * b.x1 + A.e * b.y1 + A.f;
        if (!(Math.max(x0, x1) < -mgn || Math.min(x0, x1) > VW + mgn ||
              Math.max(y0, y1) < -mgn || Math.min(y0, y1) > VH + mgn)) return true;
        var key = (animKey(b) || b.slug || '').toLowerCase();
        if (!key) return false;
        var k = CAM.scale(cam) / ART.S;
        var sp = (typeof spriteEntry === 'function' && spriteEntry(key)) ||
                 (citySprites && citySprites[key]);
        var an = (typeof anims !== 'undefined' && anims) ? anims[key] : null;
        if (!sp && !an) return false;
        var gx = ART.ref === 'origin' ? b.x0 : b.px,
            gy = ART.ref === 'origin' ? b.y0 : b.py;
        var w = CAM.tileToWorld(gx + ART.ax, gy + ART.ay);
        var p = CAM.worldToScreen(cam, w.x, w.y, VW, VH);
        // the SAME test the request gate uses, plus the margin: whatever the
        // page is allowed to ask for, the audit must accept
        return artReachable(sp || { w: 0, h: 0, anchor: [1e9, 1e9] },
                            p.x, p.y, p.x - (sp ? sp.anchor[0] : 0) * k, k, key);
    }
    function artAudit(urls, recentN) {
        var A = CAM.tileAffine(cam, VW, VH);
        var mgn = 40;                       // generous: tall sprites overhang
        var visSlug = {}, visChar = {}, i, b, key, n = 0;
        for (i = 0; i < buildings.length; i++) {
            b = buildings[i];
            if (objHidden[b.cat]) continue;
            if (!artOwnedByWindow(b, A, mgn)) continue;
            n++;
            key = (animKey(b) || b.slug || '').toLowerCase();
            if (key) visSlug[key] = 1;
        }
        var ch = M.chars, kc = CAM.scale(cam) / ART.S;
        for (i = 0; i < ch.length; i++) {
            var c = ch[i];
            var cx = A.a * c[1] + A.b * c[2] + A.c, cy = A.d * c[1] + A.e * c[2] + A.f;
            var pk = charMan && charMan.characters && charMan.characters[c[0]]
                     ? charRecPick(c, i) : null;
            var as2 = (pk && pk.as) || null;
            var mx = mgn + (as2 ? (dynReady(as2)
                                   ? as2._dyn.ex
                                   : Math.max(as2.anchor[0], as2.w - as2.anchor[0])) * kc : 0);
            var my = mgn + (as2 ? (dynReady(as2)
                                   ? as2._dyn.ey
                                   : Math.max(as2.anchor[1], as2.h - as2.anchor[1])) * kc : 0);
            if (cx + mx < -mx || cx - mx > VW + mx ||   // its sheet can paint in
                cy + my < -my || cy - my > VH + my) continue;
            if (pk && pk.slug) visChar[String(pk.slug).toLowerCase()] = 1;
        }
        var cat = { body: 0, season: 0, char: 0, film: 0, other: 0 };
        var off = { body: [], season: [], char: [], film: [], other: [] };
        var offN = 0, seen = {}, asked = 0;
        for (i = Math.max(0, urls.length - recentN); i < urls.length; i++) {
            var u = urls[i];
            if (seen[u]) continue;
            seen[u] = 1; asked++;
            var f = u.slice(u.lastIndexOf('/') + 1).replace(/\?[^/]*$/, '');
            var base = f.replace(/\.png$/i, '').toLowerCase();
            var kind = 'other', hit = 0;
            if (u.indexOf('/dlc/') > -1 || f.indexOf('__') === 0) {
                hit = 1;                      // ground sheets / atlas keys:
                kind = 'other';               // not per-object art
            } else if (u.indexOf('api/bcell.php') > -1) {
                kind = 'char';                // dynamic .bcell sheet fetch
                var mq = /[?&]name=([^&]+)/.exec(u);
                base = mq ? decodeURIComponent(mq[1]).toLowerCase() : '';
                hit = visChar[base] === 1;
            } else if (u.indexOf('api/bsprite.php') > -1) {
                kind = 'other';               // dynamic bsv3 bake fetch
                var mk = /[?&]kind=([a-z]+)/.exec(u);
                var mn = /[?&]name=([^&]+)/.exec(u);
                base = mn ? decodeURIComponent(mn[1]).toLowerCase() : '';
                if (mk) kind = mk[1] === 'season' ? 'season'
                       : (mk[1] === 'anim' ? 'film' : 'body');
                hit = visSlug[base] === 1;
            } else if (/(^|\/)characters\//.test(u)) {
                kind = 'char';
                base = base.replace(/_\d+$/, '');
                hit = visChar[base] === 1;
            } else if (u.indexOf('/seasons/') > -1) {
                kind = 'season';
                hit = visSlug[base] === 1;
            } else if (u.indexOf('/anims/') > -1) {
                kind = 'film';
                hit = visSlug[base.split('__')[0]] === 1;
            } else if (/(^|\/)assets\/city\//.test(u)) {
                kind = 'body';
                hit = visSlug[base] === 1;
            }
            cat[kind]++;
            if (!hit) { offN++; if (off[kind].length < 12) off[kind].push(f); }
        }
        return { zoom: Math.round(cam.zoom * 1000) / 1000,
                 scale: Math.round(CAM.scale(cam) * 100) / 100,
                 lod: CAM.scale(cam) < BUILD_LOD_S, vw: VW, vh: VH,
                 buildingsOnScreen: n, charsOnScreen: Object.keys(visChar).length,
                 artEverAsked: urls.length, askedChecked: asked,
                 offScreen: offN, byKind: cat, offSamples: off,
                 margin: mgn + artMargin(), prefetch: ART_PREFETCH,
                 req: ALOAD.req, artGot: ALOAD.artGot, artKnown: ALOAD.artKnown };
    }
    window.__CV_ART_audit = function (opt) {   // console/harness: the above
        opt = opt || {};                        // over the real request log
        return artAudit(ALOAD.hist, opt.recent || 600);
    };
    window.__CV_ART_audit_urls = function (urls, n) {   // harness: explicit list
        return artAudit(urls || [], n || 600);
    };
    window.__CV_ART_prefetch = function (f) {  // console/harness: the band as
        if (f !== undefined) ART_PREFETCH = Math.max(0, +f || 0);   // a fraction
        return ART_PREFETCH;                   // of the shorter viewport side
    };
    window.__CV_ART_requests = function () {   // console: the log itself
        return ALOAD.hist.slice();
    };
    /* Live trace (console/harness): record EVERY request call, not just the
       first sight of a file — a settled camera asks for the same art every
       frame, which is exactly the storm the pill cannot show. Switch it on,
       let the view settle, then audit __ASSETS.tr against the window. */
    window.__CV_ART_trace = function (on) {
        ALOAD.trace = on ? 1 : 0;
        ALOAD.tr.length = 0;
        return ALOAD.trace;
    };

    /* ---- art tune panel: pin-convention A/B without reloads ------------------
       Ported verbatim (pure DOM + camera moves). */
    (function buildTunePanel() {
        var p = $('arttune');
        if (!p || !document.createElement) return;
        var vals = {}, refs = [];
        function row(label) {
            var r = document.createElement('div');
            r.className = 'trow';
            var l = document.createElement('span');
            l.className = 'tlab';
            l.textContent = label;
            r.appendChild(l);
            p.appendChild(r);
            return r;
        }
        function btn(txt, fn, tip) {
            var b = document.createElement('button');
            b.className = 'tbtn';
            b.textContent = txt;
            if (tip) b.setAttribute('data-tip', tip);
            b.addEventListener('click', fn);
            return b;
        }
        function paint() {
            for (var i = 0; i < refs.length; i++)
                refs[i].classList.toggle('on', ART.ref === refs[i].textContent);
            vals.ax.textContent = ART.ax.toFixed(2);
            vals.ay.textContent = ART.ay.toFixed(2);
            vals.S.textContent = String(Math.round(ART.S));
            try {
                localStorage.setItem(TUNE_KEY, JSON.stringify(
                    { S: ART.S, ax: ART.ax, ay: ART.ay, ref: ART.ref }));
            } catch (e) { /* private mode */ }
            markDirty();
        }
        var rPin = row('pin');
        refs.push(btn('anchor', function () { ART.ref = 'anchor'; paint(); },
            'pin sprite anchor at the catalog anchor tile (px,py)'));
        refs.push(btn('origin', function () { ART.ref = 'origin'; paint(); },
            'pin sprite anchor at the footprint origin (catalog pos − loc + 1)'));
        rPin.appendChild(refs[0]); rPin.appendChild(refs[1]);
        function stepper(label, key, step, min) {
            var r = row(label);
            var v = document.createElement('span');
            v.className = 'tval';
            r.appendChild(btn('−', function () {
                ART[key] = Math.max(min, ART[key] - step); paint();
            }));
            r.appendChild(v);
            vals[key] = v;
            r.appendChild(btn('+', function () {
                ART[key] = ART[key] + step; paint();
            }));
        }
        stepper('ax', 'ax', 0.25, -4);
        stepper('ay', 'ay', 0.25, -4);
        stepper('S', 'S', 1, 8);
        function bySlug(list) {
            var seen = {}, out = [];
            for (var i = 0; i < list.length; i++)
                if (!seen[list[i].slug]) { seen[list[i].slug] = 1; out.push(list[i]); }
            return out;
        }
        function makeWalker(label, tip, pick) {
            var r = row(label);
            r.className += ' wide';
            var st = { list: null, i: 0 };
            var b = btn('⏭ ' + label, function () {
                if (!st.list) st.list = pick();
                if (!st.list.length) { b.textContent = '⏭ none'; return; }
                var e = st.list[st.i % st.list.length];
                st.i++;
                centerOnTile((e.x0 + e.x1) / 2, (e.y0 + e.y1) / 2);
                if (cam.zoom < 1) cam.zoom = CAM.ZOOM.rest;
                setSel({ kind: 'b', i: e.mi });
                b.textContent = '⏭ ' + e.slug.slice(0, 16) + ' ' +
                    st.i + '/' + st.list.length;
                markDirty();
            }, tip);
            r.appendChild(b);
        }
        makeWalker('singles',
            'one instance of every 1x1 prop (pivot-centred art): the base corner must sit exactly on the wire\'s front ground edge — any residual offset is the tile-internal pin, dial ax/ay once against these',
            function () {
                return bySlug(buildings.filter(function (b) {
                    return b.slug && b.x1 - b.x0 === 1 && b.y1 - b.y0 === 1;
                }));
            });
        makeWalker('anchored',
            'one instance per slug of multi-tile buildings: judge the three visible base corners against the wire ground edges (the prism must sit under the art, not beside it)',
            function () {
                return bySlug(buildings.filter(function (b) {
                    return b.slug && (b.x1 - b.x0 > 1 || b.y1 - b.y0 > 1);
                }));
            });
        makeWalker('offsets',
            'one instance per slug of the widest footprints first: the diamond corners must match the sprite base at full size — if big buildings drift off the wire, S (art px per tile) is the knob to correct',
            function () {
                return bySlug(buildings.filter(function (b) {
                    return b.slug && (b.x1 - b.x0) + (b.y1 - b.y0) >= 8;
                }).sort(function (a, c) {
                    return ((c.x1 - c.x0) + (c.y1 - c.y0)) -
                        ((a.x1 - a.x0) + (a.y1 - a.y0));
                }));
            });
        row('reset').appendChild(btn('defaults', function () {
            ART.S = 64; ART.ax = 0; ART.ay = 0; ART.ref = 'anchor';
            paint();
        }, 'back to the shipped defaults'));
        paint();
    })();
    if ($('btn-tune')) $('btn-tune').addEventListener('click', function () {
        var p = $('arttune');
        if (!p) return;
        var show = p.style.display === 'none' || p.style.display === undefined;
        p.style.display = show ? '' : 'none';
        $('btn-tune').classList.toggle('on', show);
        if (show && !artMode) {          // tuning sprites you cannot see is no fun
            artMode = 1;
            try { localStorage.setItem(ART_KEY, '1'); } catch (e) { /* private mode */ }
            applyArtMode();
        }
        markDirty();
    });

    /* ---- view-state flags (all persisted under the shared cityview keys) ---- */
    var SPECK_KEY = 'mrsnrub.cityview.speckle';
    var speckOn = true;
    try { speckOn = localStorage.getItem(SPECK_KEY) !== '0'; } catch (e) { /* private mode */ }

    var ROADNET_KEY = 'mrsnrub.cityview.roadnet';
    var roadNetOn = false;
    try { roadNetOn = localStorage.getItem(ROADNET_KEY) === '1'; } catch (e) { /* private mode */ }

    var WALK_KEY = 'mrsnrub.cityview.walks';
    var walksOn = false;
    try { walksOn = localStorage.getItem(WALK_KEY) === '1'; } catch (e) { /* private mode */ }

    var MARKER_KEY = 'mrsnrub.cityview.markers';
    var MARKER_SEED = '';
    var markerText = MARKER_SEED;
    try {
        var mt = localStorage.getItem(MARKER_KEY);
        if (mt !== null) markerText = mt;
    } catch (e) { /* private mode */ }
    var markerPts = (typeof CityMarkers !== 'undefined')
        ? CityMarkers.parse(markerText) : [];

    var ORIENT_KEY = 'mrsnrub.cityview.orient';
    (function loadOrient() {           // must run BEFORE terrain/buildings
        try {
            var so = JSON.parse(localStorage.getItem(ORIENT_KEY));
            if (so && (so.fx === 1 || so.fx === -1) && (so.fy === 1 || so.fy === -1) &&
                (so.swap === 0 || so.swap === 1)) CAM.ORIENT = so;
        } catch (e) { /* defaults */ }
    })();

    var terrain = new CityTerrain(M, { speckleFilter: speckOn, roadNetwork: roadNetOn });

    /* per-layer tile counts for the terrain details card */
    var terrainCounts = {};
    (function () {
        var f = terrain.features, TO = CityTerrain.TYPE_ORDER;
        for (var i = 0; i < f.length; i++) {
            var n = TO[f[i][2]];
            terrainCounts[n] = (terrainCounts[n] || 0) + 1;
        }
    })();

    /* candidate street census from the cached walk paths */
    var walkCensus = (M.walks && M.walks.length && typeof CityWalks !== 'undefined')
        ? CityWalks.census(M.walks, terrain._roadOccAll, M.ox, M.oy)
        : null;

    /* ---- camera + presets --------------------------------------------------- */
    var DT = M.downtown[0];                 // [x0,x1,y0,y1] town tiles
    var TOWN = {
        x0: -64 - M.ox, y0: -M.oy, x1: 512 - M.ox, y1: 1087 - M.oy
    };
    var cam = CAM.createCamera({ zoom: CAM.ZOOM.rest });
    window.__CV_cam = cam;               // console/harness: steer the view directly

    /* ---- camera persistence: resume where you left off on reload -------------
       Tile position + zoom are stored (tile coords, not world, so the saved
       view survives an ORIENT change, which is persisted too). The Canvas
       page never reads this key, so the two pages stay independent. */
    var CAM_KEY = 'mrsnrub.cityview.cam';
    /* ?camTx=&camTy=&camZ= opens on that view and never writes it back, so
       an embedding page (Road Lab marina align) can frame its own spot
       without moving the user's saved City View camera */
    var CAM_URL = (function () {
        var x = parseFloat(QP.get('camTx')), y = parseFloat(QP.get('camTy')),
            z = parseFloat(QP.get('camZ'));
        return (isFinite(x) && isFinite(y)) ? { tx: x, ty: y, zoom: isFinite(z) && z > 0 ? z : 1 } : null;
    })();
    window.__CV_CAM = function () {
        var t = CAM.worldToTile(cam.x, cam.y);
        return { tx: t.x, ty: t.y, zoom: cam.zoom };
    };
    function saveCam() {
        if (CAM_URL) return;
        try {
            var t = CAM.worldToTile(cam.x, cam.y);
            localStorage.setItem(CAM_KEY, JSON.stringify(
                { tx: t.x, ty: t.y, zoom: cam.zoom }));
        } catch (e) { /* private mode */ }
    }
    function restoreCam() {              // true if a saved view was applied
        if (CAM_URL) {
            var wu = CAM.tileToWorld(CAM_URL.tx, CAM_URL.ty);
            cam.x = wu.x; cam.y = wu.y; cam.zoom = CAM_URL.zoom;
            cam.vx = 0; cam.vy = 0;
            return true;
        }
        try {
            var s = JSON.parse(localStorage.getItem(CAM_KEY));
            if (s && isFinite(s.tx) && isFinite(s.ty) &&
                isFinite(s.zoom) && s.zoom > 0) {
                var w = CAM.tileToWorld(s.tx, s.ty);
                cam.x = w.x; cam.y = w.y; cam.zoom = s.zoom;
                cam.vx = 0; cam.vy = 0;
                return true;
            }
        } catch (e) { /* no saved camera */ }
        return false;
    }

    function centerOnTile(tx, ty) {
        var w = CAM.tileToWorld(tx, ty);
        cam.x = w.x; cam.y = w.y; cam.vx = 0; cam.vy = 0;
    }
    function presetRest() {
        cam.zoom = CAM.ZOOM.rest;
        centerOnTile((DT[0] + DT[1]) / 2, (DT[2] + DT[3]) / 2);
    }
    function presetDowntown() {
        CAM.fitTileRect(cam, { x0: DT[0], y0: DT[2], x1: DT[1], y1: DT[3] }, VW, VH);
    }
    function presetFull() {
        CAM.fitTileRect(cam, TOWN, VW, VH);
    }
    function presetOcean() {
        var OCEAN_BB = terrain.typeBBox[0];    // terrain TYPE_IDX.ocean = 0
        if (!OCEAN_BB) return;
        CAM.fitTileRect(cam, {
            x0: OCEAN_BB.x0 - 8, y0: OCEAN_BB.y0 - 8,
            x1: OCEAN_BB.x1 + 8, y1: OCEAN_BB.y1 + 8
        }, VW, VH);
    }
    function presetSpringfield() {
        for (var i = 0; i < buildings.length; i++) {
            var e = M.binfo[buildings[i].id];
            if (e && e[0] === 'SpringfieldDowns') {
                var b = buildings[i];
                CAM.fitTileRect(cam, {
                    x0: b.x0 - 6, y0: b.y0 - 6, x1: b.x1 + 6, y1: b.y1 + 6
                }, VW, VH);
                return;
            }
        }
        presetDowntown();
    }

    var lastPreset = null;              // re-applied after an orientation change

    /* ---- buildings (raised blocks), precomputed + depth-sorted -------------- */
    var pal = M.pal;
    var HEIGHT_SCALE = 0.5;
    function shade(c, f) {
        return 'rgb(' + Math.min(255, c[0] * f | 0) + ',' +
            Math.min(255, c[1] * f | 0) + ',' + Math.min(255, c[2] * f | 0) + ')';
    }
    var buildings = [];
    var charGrid = null;                  // oriented-space coarse grid: cell
                                          // 'gu,gv' -> [building index..] for
                                          // the char-vs-building occlusion test
    var byMi = [];                      // M.buildings index -> drawn block
    var catOfMi = [];                   // M.buildings index -> object bucket
    function buildBuildings() {         // re-run after an ORIENT change (depth keys)
        buildings = [];
        bAtlas = null;                  // flat-LOD atlas stale (rebuilt lazily)
        for (var i = 0; i < M.buildings.length; i++) {
            var b = M.buildings[i];
            var info = M.binfo[b[0]];
            var hgt = info ? (info[7] || 3) : 3;
            var px = b[6], py = b[7];           // ground pivot tile corner (RE-pinned)
            var front = CAM.oriented(px, py);   // true screen-front corner (x0,y1)
            var col = pal[b[0] % pal.length];
            var blk = {
                mi: i,
                id: b[0],
                x0: px, y0: py - b[4], x1: px + b[3], y1: py,
                hgt: hgt * HEIGHT_SCALE,
                col: col,
                fR: shade(col, 1.0),
                fL: shade(col, 0.62),
                fT: shade(col, 1.28),
                /* numeric face colours for the Pixi prism sprites (tint) */
                cR: rgbHex(col),
                cL: rgbHex([col[0] * 0.62 | 0, col[1] * 0.62 | 0, col[2] * 0.62 | 0]),
                cT: rgbHex([Math.min(255, col[0] * 1.28 | 0),
                            Math.min(255, col[1] * 1.28 | 0),
                            Math.min(255, col[2] * 1.28 | 0)]),
                cat: CityObjects.classify(info ? info[0] : ''),
                slug: (b[8] || (info ? (info[2] || '') : '')),
                flip: b[8] ? 0 : b[5], px: b[6], py: b[7],
                hkey: b[0] + '@' + Math.round(b[6]) + ',' + Math.round(b[7]),
                depth: front[0] + front[1],
                ox1: front[0]
            };
            blk.bu0 = blk.bv0 = 0; blk.bu1 = blk.bv1 = 0;
            var oc0 = CAM.oriented(blk.x0, blk.y0), oc1 = CAM.oriented(blk.x1, blk.y1);
            blk.bu0 = Math.min(oc0[0], oc1[0]); blk.bu1 = Math.max(oc0[0], oc1[0]);
            blk.bv0 = Math.min(oc0[1], oc1[1]); blk.bv1 = Math.max(oc0[1], oc1[1]);
            buildings.push(blk);
            byMi[i] = blk;
            catOfMi[i] = blk.cat;
        }
        buildings.sort(function (a, b) { return a.depth - b.depth || a.ox1 - b.ox1; });
        buildCharGrid();                    // char-occlusion lookup (below)
    }
    /* coarse oriented-space grid for the scene pass' char-vs-building
       occlusion test. CH_* bounds in tile units: CH_H/CH_W a character
       sprite's generous visible envelope (the art ships tall transparent
       filmstrip cells; the body is well inside), CH_PAD the reach of a
       screen-space overlap along one oriented axis (biggest footprint
       13x12 + wall 4 + char 6 rounds up). */
    var CH_CS = 8, CH_PAD = 40, CH_H = 6, CH_W = 2;
    function buildCharGrid() {
        charGrid = {};
        for (var i = 0; i < buildings.length; i++) {
            var b = buildings[i];
            for (var gu = Math.floor(b.bu0 / CH_CS); gu <= Math.floor(b.bu1 / CH_CS); gu++)
                for (var gv = Math.floor(b.bv0 / CH_CS); gv <= Math.floor(b.bv1 / CH_CS); gv++) {
                    var kk = gu + ',' + gv, a = charGrid[kk];
                    if (a) a.push(i); else charGrid[kk] = [i];
                }
        }
    }
    buildBuildings();

    /* screen-space quads of one block (shared by hitTest and the outlines so
       all agree on the silhouette). */
    function blockPolys(b) {
        var h = b.hgt * CAM.scale(cam);
        function g(x, y) { var w = CAM.tileToWorld(x, y); return CAM.worldToScreen(cam, w.x, w.y, VW, VH); }
        var g00 = g(b.x0, b.y0), g10 = g(b.x1, b.y0),
            g11 = g(b.x1, b.y1), g01 = g(b.x0, b.y1);
        function up(p) { return { x: p.x, y: p.y - h }; }
        var r00 = up(g00), r10 = up(g10), r11 = up(g11), r01 = up(g01);
        return {
            right: [r10, r11, g11, g10],
            left: [r11, r01, g01, g11],
            top: [r00, r10, r11, r01]
        };
    }

    /* screen centre + radius of one character dot. M.chars rows carry the
       save's exact float positions (tile units, feet-on-ground point). */
    function charScreen(c) {
        var w = CAM.tileToWorld(c[1], c[2]);
        var p = CAM.worldToScreen(cam, w.x, w.y, VW, VH);
        p.r = Math.max(1.6, CityObjects.PEOPLE_R * Math.min(2.2, CAM.scale(cam) / 40));
        return p;
    }

    /* ---- character idle loops (characters.json v3 animated idle cells) -----
       Original-game semantics: a cell like <name>IdleBlink stores ONE pass
       of the animation — its per-frame delay_ms values are that single play
       (tsto2rgb, the format's own reference writer, puts them straight into
       a GIF's frame durations) — and the client holds the standby frame
       while it waits to re-trigger the cell (the binary's IdleAnimation /
       timeBetweenAnimsMin / timeBetweenAnimsMax idle-trigger properties,
       notes/01). Modulo-looping the cell (the old behaviour) replayed a
       ~208 ms blink ~5x/second. Now: play the frames once per cycle and
       hold fr[0] (standby) through a randomised per-character gap; the
       per-character hash of the save id offsets both phase and gap so the
       crowd does not blink in lockstep. */
    function frameDelay(f) {
        var d = f.delay_ms !== undefined ? f.delay_ms : f.delay;
        return d > 0 ? d : 100;
    }
    /* fr is optional: pass the dynamic manifest's frames[] to time/place
       off the endpoint's frame list (count and delays can differ from the
       pre-baked frames[] — the pipeline drops empty frames); defaults to
       the asset's own frames. Totals cache per frame-array identity.
       loop = replay back-to-back instead of holding the standby frame: a
       walking character's striding cycle is a continuous loop (the engine
       keeps it playing for the whole move), unlike the idle one-play-and-hold
       above. */
    function charFrameIdx(as, id, k, fr, loop) {
        fr = (fr && fr.length) ? fr : as.frames;
        if (!fr || !fr.length) return 0;
        if (fr.length < 2 || !animOn || !artMode ||
            Math.max(as.w, as.h) * k < CHAR_ANIM_MIN_PX) return 0;
        if (as._tot === undefined || as._totfr !== fr) {
            var tot = 0, i;
            for (i = 0; i < fr.length; i++) tot += frameDelay(fr[i]);
            as._tot = tot || 1; as._totfr = fr;
        }
        var h = 0, s = String(id), j;
        for (j = 0; j < s.length; j++) h = (h * 31 + s.charCodeAt(j)) | 0;
        h = Math.abs(h);
        // one play, then a randomised hold on the standby frame (2-7 s,
        // like the client's time-between-anims); loops long enough to read
        // as an "active" idle wait at least another loop-length before
        // replaying, so long gags don't run back-to-back
        var gap = loop ? 0
            : 2000 + (h >>> 4) % 5000 + (as._tot > 1200 ? as._tot : 0);
        var t = ((animNow || performance.now()) + h) % (as._tot + gap);
        if (t >= as._tot) return 0;                 // standby between plays
        for (j = 0; j < fr.length; j++) {
            t -= frameDelay(fr[j]);
            if (t < 0) return j;
        }
        return fr.length - 1;
    }
    function charFrameFile(as, id, k) {
        var fr = as.frames;
        if (!fr || !fr.length) return as.png;
        return fr[charFrameIdx(as, id, k)].file;
    }
    function charAnimating(as, k, fr) {
        var n = (fr && fr.length) || (as.frames && as.frames.length) || 0;
        return !!(n > 1 && animOn && artMode &&
                  Math.max(as.w, as.h) * k >= CHAR_ANIM_MIN_PX);
    }
    /* randomSkin="true" crowd (KrustylandNPC, Zombies, …): the manifest
       ships characters[id].pool — the skins the engine dresses each spawn
       in at random. Pick one deterministically from the row INDEX (hash,
       not Math.random: a reroll per frame would strobe, and the scene
       pass, the walk plan and the hit-test must agree on the same skin).
       Returns {slug, as} — the asset or null when it never rendered. */
    function charRecPick(c, i) {
        var rec = charMan && charMan.characters[c[0]];
        if (!rec) return null;
        if (!rec.pool || rec.pool.length < 2)
            return { slug: rec.slug, as: charMan.assets[rec.slug] || null };
        if (i === undefined || i < 0) i = 0;
        var h = ((i + 1) * 0x01000193) >>> 0;
        h ^= c[0]; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13;
        var s = rec.pool[h % rec.pool.length];
        return { slug: s, as: charMan.assets[s] || null };
    }
    /* the art asset to draw for a character: the card's preview cell wins
       over the manifest pick — shared by the scene pass and the click
       hit-test so both agree on the drawn sprite rect */
    function charArtOf(c, i) {
        if (!artMode || !charMan) return null;
        if (charPreview && String(charPreview.cid) === String(c[0]))
            return charPreview.cell;
        var p = charRecPick(c, i);
        return (p && p.as) || null;
    }
    /* preview playback: replay the chosen cell continuously (one pass on
       its own delays, 1.2 s hold on the standby frame) — steadier than
       the crowd's 2-7 s randomised blink gaps, this is an inspection loop */
    function charPreviewIdx(as, fr) {
        fr = (fr && fr.length) ? fr : as.frames;
        if (!fr || !fr.length || !animOn) return 0;
        if (as._ptot === undefined || as._ptotfr !== fr) {
            var tot = 0, i;
            for (i = 0; i < fr.length; i++) tot += frameDelay(fr[i]);
            as._ptot = tot || 1; as._ptotfr = fr;
        }
        var t = (animNow || performance.now()) % (as._ptot + 1200);
        for (i = 0; i < fr.length; i++) {
            t -= frameDelay(fr[i]);
            if (t < 0) return i;
        }
        return 0;
    }
    function charPreviewFrame(as) {
        var fr = as.frames;
        if (!fr || !fr.length || !animOn)
            return (fr && fr[0] || { file: as.png }).file;
        return fr[charPreviewIdx(as)].file;
    }

    /* ---- idle wander (js/wander.js, notes/13) ------------------------------
       The engine walks its idle characters on its own, no job involved: stand
       at the post, then A* to a nearby tile over the <RoadGridSettings>
       cost grid (streets 10-19, grass 32, water 196) — the cost table, not a
       rule, is what keeps the crowd on the pavements. Characters whose
       <Character> definition names no <MovementBehavior mode> get the
       engine's built-in default, RandomRelaxed; the ones that do (Sneak,
       RandomRush, RandomHover) get that mode's feel. Speeds come from the
       per-character <WalkSpeed>, clamped into <WalkDefaultSpeeds slow fast>.

       Positions are written straight into the M.chars rows, so the scene
       pass, the click hit-test and the details card all follow the walker;
       switching the toggle off restores the save's layout. The walk cycles
       are the pool's <skin>_front_walk/_back_walk cells (the manifest ships
       idle cells only), so they stream from the same dynamic .bcell endpoint
       as the idles — and a skin with no walk cell, or a page without the
       endpoint, walks in its idle pose instead of failing. */
    var WANDER_KEY = 'mrsnrub.cityview.idlewalk';
    var wanderOn = true;
    try { wanderOn = localStorage.getItem(WANDER_KEY) !== '0'; } catch (e) { /* private mode */ }
    var wander = (typeof CityWander === 'undefined') ? null : new CityWander({
        chars: M.chars, terrain: terrain, buildings: M.buildings,
        typeNames: (typeof CityTerrain !== 'undefined' && CityTerrain.TYPE_ORDER) || null,
        speeds: (typeof WALK_DATA !== 'undefined' && WALK_DATA) ? WALK_DATA.chars : null
    });
    if (wander) wander.setEnabled(wanderOn);
    function applyWanderMode() {
        var b = $('btn-idlewalk');
        if (!b) return;
        b.classList.toggle('on', wanderOn);
        b.setAttribute('aria-pressed', wanderOn ? 'true' : 'false');
    }
    applyWanderMode();
    if ($('btn-idlewalk')) $('btn-idlewalk').addEventListener('click', function () {
        wanderOn = !wanderOn;
        try { localStorage.setItem(WANDER_KEY, wanderOn ? '1' : '0'); }
        catch (e) { /* private mode */ }
        if (wander) wander.setEnabled(wanderOn);
        applyWanderMode();
        markDirty();
    });
    window.__CV_WANDER = function (on) {           // console/harness probe
        if (!wander) return null;
        if (on !== undefined) {
            wanderOn = !!on;
            wander.setEnabled(wanderOn);
            applyWanderMode();
            markDirty();
        }
        var i = wander.info();
        i.walking = walkLive;                       // walkers on screen
        i.walkCells = Object.keys(walkArts).length; // skin|kind combos resolved
        i.walkMiss = walkMiss;                      // …of which have no cell
        return i;
    };

    /* walk cells: the engine picks the cycle from the movement vector in its
       own grid, and the shipped content carries the table —
         <MovePick x="-1" y="0" speed="1"><PriorityList>
           <Animation name="Front_Walk_Left"/><Animation name="Front_Walk"/>
       (jobs.xml and ~200 other job files; the census of all 461 locomotion
       names is notes/13 §6):

         tile (-1,0) → Front_Walk_Left    tile (0,+1) → Front_Walk_Right
         tile (+1,0) → Back_Walk_Right    tile (0,-1) → Back_Walk_Left

       So the facing half is the DEPTH component and the side half the
       sideways one, and in the 2:1 oblique the two tile axes land on the two
       down-diagonals: walking down the screen is walking toward the camera.
       Read off the DRAWN vector (the tile→screen affine), so Rotate and
       Mirror keep a character facing the way it visibly travels — and NOT by
       "dominant axis", which in a 2:1 projection is always the horizontal
       one and would leave every character in one cycle.
       The PriorityList is the ask order too: the AUTHORED side cell first and
       drawn exactly as authored — the engine never mirrors a walk (§8), and
       mirroring art already drawn for that side would double-flip it — then
       the plain cycle of the SAME family, then the other family.
       One viewer-side addition to the plain cycles, from the user's walk-lab
       ruling (2026-11-04, notes/13 §6): a horizontal MIRROR on two of the
       four steps. The mirrored plain cycle is "the only way it looks right" for
       Back_Walk_Right and Front_Walk_Left, the two rows of that table whose art
       a flat-authored crowd skin does not have; the other two steps play the
       plain cycle as drawn. Read it as an eye-test ruling, not as a facing fix:
       those plain cycles measure square-on (§8, and the lab's own lean
       column), so nothing in the art says which way it travels and no wrong turn
       is being corrected. The mirror is therefore a property of the STEP, not of
       the cell, and only ever of a plain (_walk/_run) one:
          mirror = (back and right) || (front and left)
       That is a deliberate deviation from how the engine does it: the engine
       fills those two steps by AUTHORING two cells, which is why the sided
       skins ship both twins (§8), never by a transform. So the mirror is
       suppressed the moment that art exists: tier 1 wins and is never flipped.
       Why the plain fallback is not a moonwalk (notes/13 §8): the crowd's
       plain cycles are drawn squarely on and are symmetric about the
       character origin (measured: 0.3-2.5 px of lean for homer/marge/bart/
       lisa/apu/...), so they read correctly either way and ship no side
       variants at all. Cycles that ARE drawn in profile ship both sides as
       separate cells (6 214 *_walk_left / 6 204 *_walk_right under
       web/assets), and the engine asks for them by composing the name at
       runtime — the resolver at libscorpio.so 0x1207430 appends the .rodata
       "_left"/"_right" suffixes to the base name, looks each up, and only on
       a miss falls back to the unsuffixed cell. The mirror is the viewer's
       stand-in for the art the game authored by name, so: never scale.x = -1
       an authored _left/_right cell.
       The viewer's slugs are flattened lowercase (homeridleblink) and
       bcell.php resolves a slug to a pool stem by alphanumeric-only compare,
       so homerfrontwalk finds homer_front_walk.bcell. */
    var WALK_STEM_SUF = ['idleblinkleft', 'idleblinkright', 'idleblink',
        'idleleft', 'idleright', 'idleactive', 'active', 'idle', 'left',
        'right', 'pose'];
    var walkArts = {};                    // 'stem|fam+side' -> asset | 0 (none)
    var walkMiss = 0;                     // skins resolved as having no walk cell
    var walkProbes = {};                  // 'stem|fam+side' -> probe assets
    var walkInv = {};                     // stem -> {tail: pool stem} | null
    var WALK_PENDING = {};                // inventory request in flight
    function walkStem(slug) {
        for (var i = 0; i < WALK_STEM_SUF.length; i++) {
            var s = WALK_STEM_SUF[i];
            if (slug.length > s.length + 2 &&
                slug.slice(slug.length - s.length) === s)
                return slug.slice(0, slug.length - s.length);
        }
        return slug;
    }
    /* The ask order for one movement vector, as {tail, mir} pairs — the single
       source of the rule (see the block above). Tier 1 is the AUTHORED side
       cell, drawn exactly as authored (mir: false, always); the plain cycles
       carry the lab's mirror, which belongs to the step: back-going-right and
       front-going-left are the two steps a flat-authored skin has no art for.
       The tails are spelled exactly as bcell.php's WALK_TAILS spells them, so
       mode=anims answers can be read off this list. */
    function walkPlan(fam, side) {
        var o = fam === 'back' ? 'front' : 'back';
        function mir(f) { return (f === 'back') === (side === 'right'); }
        return [
            { tail: fam + '_walk_' + side, mir: false },
            { tail: fam + '_walk', mir: mir(fam) },
            { tail: o + '_walk_' + side, mir: false },
            { tail: o + '_walk', mir: mir(o) },
            { tail: fam + '_run', mir: mir(fam) },
            { tail: o + '_run', mir: mir(o) }
        ];
    }
    /* the same plan as guessed pool slugs (used when the endpoint's anims
       inventory is unavailable): a cell's slug is its stem plus the tail with
       the underscores dropped, which is how bcell.php matches slugs to stems.
       The mirror rides along, so both paths draw the same thing */
    function walkCandidates(stem, fam, side) {
        return walkPlan(fam, side).map(function (p) {
            return { slug: stem + p.tail.replace(/_/g, ''), mir: p.mir };
        });
    }
    /* One small listing request per skin instead of eight guessed probes:
       the endpoint reports which of the WALK_TAILS cells really exist for
       the stem (bcell.php mode=anims). null = unavailable (pack art, the
       endpoint is off, or it failed) → fall back to probing names, which is
       what the page did before the listing existed. Asked once per skin, and
       the answer always lands before the first probe is built (walkArtOf
       paints the idle pose while PENDING), so a probe is never built from a
       guess that the listing would have contradicted. Walking characters move
       every frame, so they redraw anyway — no markDirty needed. */
    function walkAsk(stem) {
        if (walkInv[stem] !== undefined) return;    // asked already
        walkInv[stem] = WALK_PENDING;                // in flight: don't re-ask
        if (dynSrc !== 'pool' || !DYNB.characters) { walkInv[stem] = null; return; }
        fetch(B + 'api/bcell.php?src=pool&mode=anims&name=' +
              encodeURIComponent(stem))
            .then(function (r) { return r.json().catch(function () { return null; }); })
            .then(function (j) {
                if (!j || !j.anims) { walkInv[stem] = null; return; }
                var m = {};
                for (var i = 0; i < j.anims.length; i++)
                    m[j.anims[i].tail] = j.anims[i].stem;
                walkInv[stem] = m;
            })
            .catch(function () { walkInv[stem] = null; });
    }
    function walkArtOf(c, dir, i) {
        if (!DYNB.characters || !dir || !charMan) return null;
        var pk = charRecPick(c, i);
        var idle = pk && pk.as;
        if (!idle || !idle.png) return null;
        var stem = walkStem(String(idle.png).replace(/\.png$/i, ''));
        var key = stem + '|' + dir.fam + dir.side;
        var hit = walkArts[key];
        if (hit !== undefined) return hit || null;
        var inv = walkInv[stem];
        if (inv === undefined) { walkAsk(stem); return null; }
        if (inv === WALK_PENDING) return null;      // listing on its way: idle now
        var plan = walkPlan(dir.fam, dir.side);
        var names = null;
        if (inv) {
            names = [];
            for (var t = 0; t < plan.length; t++) {
                var s = inv[plan[t].tail];
                /* the plan already puts the authored side cell first, so a
                   skin that ships its own left/right art is drawn as authored
                   and its mir is false (§8: the engine never mirrors a walk) */
                if (s && names.indexOf(s) < 0)
                    names.push({ slug: s, mir: plan[t].mir });
            }
            if (!names.length) { walkArts[key] = 0; walkMiss++; return null; }
        }
        var probes = walkProbes[key];
        if (!probes) {
            probes = walkProbes[key] = (names ||
                walkCandidates(stem, dir.fam, dir.side)).map(function (p) {
                /* the walk cell is drawn in the idle cell's box: the shipped
                   front/back walk cells are the same rig, and the hit-test
                   (which only knows the idle asset) has to agree with what is
                   drawn. mir = draw this cell flipped about the character
                   origin (walkPlan's ruling); the hit-test still uses the
                   unmirrored idle box, which the eye does not notice at this
                   scale — the two boxes differ by at most the frame's offset */
                return { png: p.slug + '.png', w: idle.w, h: idle.h,
                         anchor: idle.anchor, _walk: 1, mir: p.mir };
            });
        }
        var pending = 0;
        for (var i = 0; i < probes.length; i++) {
            var probe = probes[i];
            var d = dynCell(probe);
            if (!d) return null;                    // static-art mode: no cells
            if (d.st === -1 || (d.st === 1 && texDead(d.url))) continue;
            if (dynReady(probe)) { walkArts[key] = probe; return probe; }
            pending = 1;                            // decoding: idle paints now
        }
        if (!pending) { walkArts[key] = 0; walkMiss++; }
        return null;
    }
    /* facing from the screen-vertical component (down-screen = toward the
       camera = front), side from the screen-horizontal one — see the
       MovePick table above. Both components matter at once: every grid step
       lands on a 2:1 diagonal, so a step is always partly sideways AND
       partly toward/away. */
    function walkDirOf(s, A) {
        var dx = A.a * s.vx + A.b * s.vy, dy = A.d * s.vx + A.e * s.vy;
        return { fam: dy < 0 ? 'back' : 'front', side: dx < 0 ? 'left' : 'right' };
    }

    /* ---- dynamic .bcell endpoint (selective rollout) ---------------------
       window.VIEWER_DYNAMIC_BCELL = { characters: true, src: 'pool' } turns
       character sprites over to web/api/bcell.php: one sprite-sheet PNG +
       JSON manifest per cell (sliced with subTex, timed off the cell's own
       delay_ms, placed per-frame at x_off/y_off from the character origin —
       the engine's own rule) instead of the pre-baked per-frame PNGs under
       assets/characters. While a cell is loading or switched off, the
       pre-baked path draws; when the endpoint REJECTS a cell (404/422 or a
       dead sheet), the character instead gets a red wireframe box (errors
       stay visible for triage — console names each cell). src: 'pool'
       (citypool) | 'pack'. Serves both the map sprites and the family-strip
       panel tiles (opts.dynFor, which outlines dead tiles in red). */
    var DYNB = window.VIEWER_DYNAMIC_BCELL || {};
    var dynSrc = DYNB.src || 'pool';
    var dynCells = {};                    // slug -> {st: 0 loading|1 ok|-1 dead, man, url, err}
    var dynErrLive = 0;                   // wireframe boxes this frame
    window.__CV_DYNB = { cfg: DYNB, cells: dynCells };    // harness/debug hook
    function dynDead(d, slug, msg) {
        d.st = -1;
        if (d.err === undefined) {        // once per cell: name it for later
            d.err = msg || 'load failed';
            ALOAD.dynErr++;
            console.warn('[dynbcell] ' + slug + ': ' + d.err);
            aPaintSoon();
        }
        markDirty();
    }
    function texDead(url) {
        var r = texs[url];
        return !!(r && r.st === -1);
    }
    function dynErrBox(x, y, as, k) {
        if (!dynErrG) return;
        var w = Math.max(10, (as.w || 24) * k), h = Math.max(14, (as.h || 32) * k);
        var ax = as.anchor ? as.anchor[0] * k : w / 2,
            ay = as.anchor ? as.anchor[1] * k : h;
        dynErrG.rect(x - ax, y - ay, w, h)
              .stroke({ width: 1.5, color: 0xff5040, alpha: 0.95 });
        dynErrG.moveTo(x - ax, y - ay).lineTo(x - ax + w, y - ay + h)
              .moveTo(x - ax + w, y - ay).lineTo(x - ax, y - ay + h)
              .stroke({ width: 1, color: 0xff5040, alpha: 0.45 });
    }

    /* ---- dynamic city endpoint (bsprite.php, selective rollout) ---------
       window.VIEWER_DYNAMIC_CITY = { sprites: true, seasons: true,
       anims: true, stacks: true } hands the four bakeable city families to
       web/api/bsprite.php, which bakes bsv3+rgb through the pipeline's OWN
       bake helpers (tools/city_render.py imports gen_city_sprites), so the
       served PNG matches the pre-baked file it replaces. Per-category
       flags; pre-baked art under assets/city keeps drawing whenever a
       category is off, before the boot preflight (assets/city/
       city-source.json) lands, or after 25 failures in one category trip
       the circuit breaker (endpoint/python down -> whole city stays
       pre-baked). The SoccerCup2015 nation flag cloths (kind=flag,
       city-flags.json) ride the sprites switch. Body sprites the pool
       cannot render get a red wireframe (preflight miss or dead endpoint
       response) + one console line, like dead character cells;
       season/filmstrip/stack/flag failures degrade to the pre-baked file
       silently-but-named — the building stays on screen.
       The working pipeline may sit a pixel ahead of the shipped manifests
       (uncommitted bake-rule edits), so every dynamic filmstrip also
       pulls its own mode=meta once and overwrites the entry's slicing
       fields (cols/cellw/cellh/ax/ay/sub/…) before the next draw. */
    var DCITY = window.VIEWER_DYNAMIC_CITY || {};
    var dynC = { sprites: !!DCITY.sprites, seasons: !!DCITY.seasons,
                 anims: !!DCITY.anims, stacks: !!DCITY.stacks };
    (function () {              // ?dyn=0 / ?dyn=1 / ?dyn=sprites,anims A/B
        var dv = QP.get('dyn');
        if (dv === null || dv === undefined) return;
        if (dv === '0') { dynC.sprites = dynC.seasons = dynC.anims = dynC.stacks = false; return; }
        if (dv === '1') { dynC.sprites = dynC.seasons = dynC.anims = dynC.stacks = true; return; }
        var w = dv.split(',');
        dynC.sprites = w.indexOf('sprites') > -1;
        dynC.seasons = w.indexOf('seasons') > -1;
        dynC.anims = w.indexOf('anims') > -1;
        dynC.stacks = w.indexOf('stacks') > -1;
    })();
    var BSU = B + 'api/bsprite.php';
    /* the endpoint's own cache-buster. It rides its own version rather than
       ASSET_V because what it answers is not just bytes: a strip's timing
       fields (fps/rp/lt/lf) come back on its mode=meta call and OVERWRITE the
       manifest entry (animMeta), so a bake-rule edit on the server has to
       refetch that answer without making the whole city re-download its
       pre-baked PNGs. The bsprite cache key now covers the pipeline sources,
       so the same edit also re-bakes the atlas behind this URL (2026-11-04,
       the dragon's thinned loop served at its raw 132-tick clock) */
    var BSERVE_V = '?v=20261104.1';
    var AMP_V = BSERVE_V.replace(/^\?/, '&');    // bsprite URLs already carry a ?
    var DINV = null;                        // preflight {inv:{stem:bits}} | null
    var DINV_WAIT = true;                   // hold city art until it settles
    var dynCFail = { sprite: 0, season: 0, anim: 0, stack: 0, flag: 0 };
    var dynCWarn = {};
    var dynCBox = {};                       // stem -> err (red-boxed bodies)
    window.__CV_DYNC = { cfg: dynC, box: dynCBox, fails: dynCFail,
                         urlv: AMP_V,
                         inv: function () { return DINV; } };
    (function () {                          // boot: preflight inventory
        fetch(B + 'assets/city/city-source.json' + MANIFEST_V)
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) {
                DINV = (j && j.inv) ? j : null;
                DINV_WAIT = false;
                aBootSettled(); markDirty();
            }).catch(function () { DINV_WAIT = false; aBootSettled(); /* all pre-baked */ });
    })();
    function dynCon(kind) {         // dynC keys are plural, dynCFail singular
        return dynC[kind] && dynCFail[kind.replace(/s$/, '')] < 25;
    }
    function preUrl(p) { return B + 'assets/city/' + p + ASSET_V; }
    function stemOfCity(p) {
        return p.slice(p.lastIndexOf('/') + 1).replace(/\.png$/i, '');
    }
    function dynCityUrl(p) {                // endpoint URL or null = pre-baked
        if (!DINV) return null;
        var m;
        if ((m = /^seasons\/([a-z]+)\/([^/]+)\.png$/.exec(p))) {
            return dynCon('seasons') ? BSU + '?kind=season&name=' + m[2] +
                   '&cls=' + m[1] + AMP_V : null;
        }
        if ((m = /^anims\/([^/]+)__[^/]+\.png$/.exec(p))) {
            return dynCon('anims') ? BSU + '?kind=anim&name=' + m[1] +
                   '&png=' + p + AMP_V : null;
        }
        if ((m = /^stacks\/([^/]+)\.png$/.exec(p))) {
            return dynCon('stacks') ? BSU + '?kind=stack&name=' + m[1] +
                   AMP_V : null;
        }
        if ((m = /^flags\/([^/]+)\.png$/.exec(p))) {
            /* nation flag cloth: same sprites switch + the preflight's
               flags list (city-flags.json ∩ pool) is the request gate */
            if (!dynCon('sprites') || !DINV.flags ||
                    DINV.flags.indexOf(m[1]) < 0) return null;
            return BSU + '?kind=flag&name=' + m[1] + AMP_V;
        }
        if ((m = /^([^/]+)\.png$/.exec(p))) {
            if (!dynCon('sprites') || m[1] === 'grasstile') return null;
            /* preflight bit 1 = bsv3+rgb+xml all present; misses draw the
               pre-baked file while emitBuilding flags them */
            if (!(DINV.inv[m[1]] & 1)) return null;
            return BSU + '?kind=sprite&name=' + m[1] + AMP_V;
        }
        return null;
    }
    function cityWarn1(msg) {
        if (dynCWarn[msg]) return;
        dynCWarn[msg] = 1;
        console.warn('[dyn-city] ' + msg);
    }
    function cityBox(stem, sp, px, py, k, msg) {
        dynErrBox(px, py, sp, k);           // red wireframe over the lot
        if (dynCBox[stem]) return;
        dynCBox[stem] = msg || 'not renderable';
        ALOAD.dynErr++;
        console.warn('[dyn-city] ' + stem + ': ' + dynCBox[stem]);
        aPaintSoon();
    }
    function cityFail(kind, p, msg) {       // dead-end art that has a fallback
        dynCFail[kind]++;
        cityWarn1(p + ': ' + (msg || 'endpoint failed'));
        if (dynCFail[kind] === 25)
            console.warn('[dyn-city] dynamic ' + kind +
                         's switched off after 25 failures (endpoint down?)');
        markDirty();
    }
    function cityTex(p, kind) {             // season/stack: endpoint, pre-baked on death
        var u = dynCityUrl(p), pre = preUrl(p);
        if (u === null) return texFor(pre);
        var t = texFor(u);
        if (t || !texDead(u)) return t;
        cityFail(kind, p);
        return texFor(pre);
    }
    var POLE_SLUG = 'flag_pole';            // Flag_Pole asset: bids like
    function flagClothFor(b) {              // SwedenFlag add flag_<country>
        if (!cityFlags) return null;
        var info = M.binfo && b.id !== undefined ? M.binfo[b.id] : null;
        var nm = info && info[0];
        if (!nm || !/Flag$/.test(nm)) return null;
        return cityFlags['flag_' + nm.replace(/Flag$/, '').toLowerCase()] || null;
    }
    function emitFlagCloth(b, px, py, k, ax, ay) { // the engine composites
        if (!cityFlags) return;             // the nation cloth onto the pole
        var cf = flagClothFor(b);
        if (!cf || cf.w * k < 4 || cf.h * k < 4) return;
        var u = dynCityUrl(cf.png), pre = preUrl(cf.png), t;
        if (u === null) t = texFor(pre);
        else {
            t = texFor(u);
            if (!t && texDead(u)) {         // endpoint dead: the pole stands
                cityFail('flag', cf.png);   // on its shipped file
                t = texFor(pre);
            }
        }
        if (!t) return;                     // loading: retries next tick
        var fx = px - cf.anchor[0] * k, fy = py - cf.anchor[1] * k;
        emitSpr(t, fx, fy, cf.w * k, cf.h * k);
        if (flagDbg)                        // console forensics: __CV_FLAG(1)
            flagLog.push({ stem: cf.png, x: Math.round(fx * 10) / 10,
                           y: Math.round(fy * 10) / 10,
                           w: Math.round(cf.w * k), h: Math.round(cf.h * k),
                           a: cf.anchor, pole: [ax, ay], k: Math.round(k * 1000) / 1000,
                           url: (u === null ? pre : u) });
    }
    var flagDbg = 0, flagLog = [];          // __CV_FLAG forensics (off by default)
    window.__CV_FLAG = function (on) {      // console: __CV_FLAG(1) then pan
        if (on !== undefined) { flagDbg = on ? 1 : 0; flagLog = []; }
        return { on: flagDbg, n: flagLog.length, drawn: flagLog.slice(0, 40),
                 man: cityFlags ? cityFlags.flag_sweden : null };
    };
    function animUrlFor(a) {                // strip source: endpoint until dead
        var u = dynCityUrl(a.png);
        if (u === null) return preUrl(a.png);
        if (texDead(u)) {
            cityFail('anim', a.png);
            return preUrl(a.png);
        }
        animMeta(a);                        // one-shot geometry reconcile
        return u;
    }
    function animMeta(a) {
        if (a._dmq || a._dm) return;
        a._dmq = 1;
        var m = /^anims\/([^/]+)__/.exec(a.png);
        fetch(BSU + '?kind=anim&name=' + m[1] + '&png=' + a.png +
              '&mode=meta' + AMP_V)
            .then(function (r) {
                return r.json().catch(function () { return null; });
            }).then(function (j) {
                a._dmq = 0;
                if (!j || j.error) {
                    cityWarn1(a.png + ': ' +
                              ((j && j.error) || 'meta fetch failed'));
                    return;
                }
                a._dm = j;
                var F = ['frames', 'cols', 'cellw', 'cellh', 'ax', 'ay',
                         'fps', 'rp', 'lt', 'lf', 'sub', 'sparse', 'nc',
                         'w', 'h'];
                var ch = 0, kk, i;
                for (i = 0; i < F.length; i++) {
                    kk = F[i];
                    if (j[kk] !== undefined && j[kk] !== a[kk]) {
                        a[kk] = j[kk];
                        ch = 1;
                    }
                }
                if (ch) { delete a.ub; markDirty(); }   // re-slice next frame
            }).catch(function () { a._dmq = 0; });
    }
    function dynCell(as) {
        if (!DYNB.characters || !as || !as.png) return null;
        if (as._dyn !== undefined) return as._dyn;
        var slug = String(as.png).replace(/\.png$/i, '');
        var d = dynCells[slug];
        if (d === undefined) {
            d = dynCells[slug] = { st: 0, man: null, url: null, ex: 0, ey: 0 };
            var q = 'api/bcell.php?src=' + encodeURIComponent(dynSrc) +
                    '&name=' + encodeURIComponent(slug);
            fetch(B + q + '&mode=manifest').then(function (r) {
                /* parse even on 404/422: the endpoint's {"error":…} body is
                   exactly what we want on the console for later triage */
                return r.json().catch(function () { return null; });
            }).then(function (j) {
                if (!j || j.error || !j.frames || !j.frames.length || !j.images) {
                    dynDead(d, slug, (j && j.error) || 'manifest error'); return;
                }
                d.man = j;
                d.url = B + q + '&mode=sheet';
                texFor(d.url);                       // kick the sheet decode
                var i, f, im;
                for (i = 0; i < j.frames.length; i++) {   // max extent from origin
                    f = j.frames[i]; im = j.images[f.image];
                    if (!im) continue;
                    d.ex = Math.max(d.ex, Math.abs(f.x_off),
                                    Math.abs(f.x_off + im.w));
                    d.ey = Math.max(d.ey, Math.abs(f.y_off),
                                    Math.abs(f.y_off + im.h));
                }
                d.st = 1;
                markDirty();
            }).catch(function () { dynDead(d, slug, 'fetch failed'); });
        }
        as._dyn = d;
        return d;
    }
    function dynReady(as) {
        return !!(as._dyn && as._dyn.st === 1 && texFor(as._dyn.url));
    }

    /* ---- tile grid overlay (debug) + wireframe toggles ---------------------- */
    var GRID_KEY = 'mrsnrub.cityview.grid';
    var gridOn = false;
    var hoverTile = null;
    function applyGridMode() {
        var b = $('btn-grid');
        if (b) b.classList.toggle('on', gridOn);
    }
    (function loadGrid() {
        try { gridOn = localStorage.getItem(GRID_KEY) === '1'; } catch (e) { /* private mode */ }
        applyGridMode();
    })();
    if ($('btn-grid')) $('btn-grid').addEventListener('click', function () {
        gridOn = !gridOn;
        if (!gridOn) hoverTile = null;
        try { localStorage.setItem(GRID_KEY, gridOn ? '1' : '0'); } catch (e) { /* private mode */ }
        applyGridMode();
        markDirty();
    });

    var WIRE_KEY = 'mrsnrub.cityview.wire';
    var wireOn = false;
    function applyWireMode() {
        var b = $('btn-wire');
        if (b) b.classList.toggle('on', wireOn);
    }
    (function loadWire() {
        try { wireOn = localStorage.getItem(WIRE_KEY) === '1'; } catch (e) { /* private mode */ }
        applyWireMode();
    })();
    if ($('btn-wire')) $('btn-wire').addEventListener('click', function () {
        wireOn = !wireOn;
        try { localStorage.setItem(WIRE_KEY, wireOn ? '1' : '0'); } catch (e) { /* private mode */ }
        applyWireMode();
        markDirty();
    });

    /* cursor tile readout for the grid */
    stage.addEventListener('pointermove', function (e) {
        if (!gridOn) return;
        var r = stage.getBoundingClientRect();
        var wpt = CAM.screenToWorld(cam, e.clientX - r.left, e.clientY - r.top, VW, VH);
        var tp = CAM.worldToTile(wpt.x, wpt.y);
        var nx = Math.floor(tp.x), ny = Math.floor(tp.y);
        if (!hoverTile || hoverTile[0] !== nx || hoverTile[1] !== ny) {
            hoverTile = [nx, ny]; markDirty();
        }
    });
    stage.addEventListener('pointerleave', function () {
        if (hoverTile) { hoverTile = null; markDirty(); }
    });

    /* ---- render ------------------------------------------------------------- */
    var needsRender = true;
    function markDirty() { needsRender = true; }

    /* per-bucket visibility (object legend); see CityObjects.classify */
    var objHidden = {};

    /* ---- per-instance hide (the building card's toggle) --------------------
       Occlusion debugging: an object drawn in FRONT of another claims both
       pixels and clicks, so the back one cannot be inspected. Hiding it here
       skips its scene blit, its outlines, its tap/hit-test and its wire, but
       NEVER its selection outline — so a hidden object you selected stays
       ghost-boxed. Keys are catalog-id + ground-pivot tile, stable across
       reloads; persisted like the other view prefs. */
    var OBJHIDE_KEY = 'mrsnrub.cityview.hiddenobjs';
    var hiddenObjs = {};                  // hkey -> true
    try {
        var _ho = JSON.parse(localStorage.getItem(OBJHIDE_KEY));
        if (_ho && typeof _ho === 'object')
            for (var _hk in _ho)
                if (Object.prototype.hasOwnProperty.call(_ho, _hk))
                    hiddenObjs[_hk] = true;
    } catch (e) { /* private mode */ }
    function hiddenCount() {
        var n = 0;
        for (var k in hiddenObjs)
            if (Object.prototype.hasOwnProperty.call(hiddenObjs, k)) n++;
        return n;
    }
    function setHidden(blk, on) {
        if (on) hiddenObjs[blk.hkey] = true;
        else delete hiddenObjs[blk.hkey];
        try {
            localStorage.setItem(OBJHIDE_KEY, JSON.stringify(hiddenObjs));
        } catch (e) { /* private mode */ }
        bAtlas = null;                    // orbit-LOD flat atlas is stale now
        bFlatDirty = true;
        markDirty();
    }
    function unhideAllObjs() {
        hiddenObjs = {};
        try { localStorage.removeItem(OBJHIDE_KEY); } catch (e) { /* private mode */ }
        bAtlas = null;
        bFlatDirty = true;
        markDirty();
    }
    window.__CV_HIDE = function (mi, on) {  // console/harness: query/toggle
        var b = byMi[mi];
        if (!b) return false;
        if (on === undefined) return !!hiddenObjs[b.hkey];
        setHidden(b, !!on);
        return !!hiddenObjs[b.hkey];
    };

    /* The TYPE_STYLE colours are terrain.js's private table (documented in
       js/terrain.js); the Pixi renderer needs them as tints, and terrain.js
       never exports the styles themselves. Keep in sync with terrain.js. */
    var TYPE_STYLE = {
        ocean:    [120, 190, 255],
        sand:     [223, 206, 138],
        dirt:     [150, 112, 70],
        river:    [92, 150, 220],
        road:     [92, 92, 98],
        dirtroad: [132, 96, 60],
        klsroad:  [176, 158, 128],
        boardwalk: [190, 140, 90],
        pier:      [126, 110, 96]
    };
    var TI_ROAD = CityTerrain.TYPE_ORDER.indexOf('road');
    var TI_RIVER = CityTerrain.TYPE_ORDER.indexOf('river');
    var TI_DIRT = CityTerrain.TYPE_ORDER.indexOf('dirt');
    var TI_DIRTROAD = CityTerrain.TYPE_ORDER.indexOf('dirtroad');
    var TI_KLSROAD = CityTerrain.TYPE_ORDER.indexOf('klsroad');
    var TI_BOARDWALK = CityTerrain.TYPE_ORDER.indexOf('boardwalk');
    var TI_PIER = CityTerrain.TYPE_ORDER.indexOf('pier');
    var FLAT_GRASS_S = CityTerrain.FLAT_GRASS_S;   // grass pattern floor
    var BUILD_LOD_S = 2;                            // orbit LOD threshold
    var MANH_R = 4 / (64 * Math.SQRT2);             // manhole radius, tile units
    var BLEED = 0.012;                              // anti-seam bleed on flat quads

    /* ============================ Pixi scene ================================= */
    var app = new PIXI.Application();
    var started = false;
    var UNIT, DISC, groundC, fillC, featC, avenC, terrFlatS, buildFlatS, grassTil,
        grassFillS, seaFillS, sceneG, fragG, propG, dynErrG, walkG, gridG, markG, outG,
        txtGrid, txtMark, bridgeG, raisedG, bridgeNearG,
        beachArtC, beachBgG, beachCloudG;
    var pool = [], pn = 0;
    /* bridge decals, one pool per layer: [0] far row in bridgeG (under the
       raised road art), [1] near row in bridgeNearG (over it) */
    var bridgePools = [[], []], bpns = [0, 0];
    var Mtx = new PIXI.Matrix();

    function mkSprite(tex, parent, x, y, w, h, hex, alpha) {
        var s = new PIXI.Sprite(tex);
        s.anchor.set(0);
        s.position.set(x, y);
        s.width = w; s.height = h;
        if (hex !== undefined) s.tint = hex;
        if (alpha !== undefined) s.alpha = alpha;
        parent.addChild(s);
        return s;
    }

    function makeScene() {
        /* 1x1 white unit texture: every flat fill and every prism face is a
           UNIT rect pushed through a matrix, so parallelograms are one
           setFromMatrix call away (see emitQuad). */
        var u = document.createElement('canvas');
        u.width = u.height = 1;
        u.getContext('2d').fillStyle = '#fff';
        u.getContext('2d').fillRect(0, 0, 1, 1);
        UNIT = PIXI.Texture.from(u);
        /* small AA disc for the manholes */
        var d = document.createElement('canvas');
        d.width = d.height = 24;
        var dc = d.getContext('2d');
        dc.fillStyle = '#fff';
        dc.beginPath(); dc.arc(12, 12, 11, 0, 6.2832); dc.fill();
        DISC = PIXI.Texture.from(d);

        groundC = new PIXI.Container();
        featC = new PIXI.Container();       // flat feature quads + sheet cells
        avenC = new PIXI.Container();       // procedural avenue cells
        groundC.addChild(featC);
        groundC.addChild(avenC);
        terrFlatS = mkSprite(UNIT, groundC, 0, 0, 1, 1);
        buildFlatS = mkSprite(UNIT, groundC, 0, 0, 1, 1);
        /* grass FIRST (canvas page paints sea on top of the lawn), then the
           solid sea base, then the feature quads (added by buildGround) */
        grassFillS = mkSprite(UNIT, groundC, -3000, -3000, 6000, 6000,
                              rgbHex(M.grass));
        grassTil = new PIXI.TilingSprite({ texture: UNIT, x: -3000, y: -3000,
                                           width: 6000, height: 6000 });
        seaFillS = mkSprite(UNIT, groundC, 0, 0, 1, 1,
                            rgbHex(CityTerrain.SEA_RGB));
        groundC.addChild(grassTil);
        groundC.addChild(grassFillS);
        groundC.addChild(seaFillS);
        /* flat type fills sit in their OWN layer under every art quad: their
           BLEED overhang (anti-seam between flat fills) must never paint over
           a neighbouring cell's finished art — interleaved per cell, it drew
           a 1-2 px river-blue / road-grey line along every cell edge */
        fillC = new PIXI.Container();
        groundC.addChild(fillC);
        groundC.addChild(featC);
        groundC.addChild(avenC);
        groundC.addChild(terrFlatS);
        groundC.addChild(buildFlatS);

        /* frag + proposed overlays: ground-level tints, UNDER the buildings
           (they were the tail of terrain.render() on the canvas page) */
        fragG = new PIXI.Graphics();
        propG = new PIXI.Graphics();

        /* road bridges (rule comment at the deriveBridges pass): the deck
           art is a screen-space billboard layer BETWEEN the ground (water
           art below) and the buildings; the crossing cells' own road art is
           REPARENTED from featC into raisedG, a tile-space twin of groundC
           drawn just above the bridges — reproducing the game's
           water -> bridge -> road stacking without touching z-order inside
           the projected ground container */
        bridgeG = new PIXI.Container();
        raisedG = new PIXI.Container();
        bridgeNearG = new PIXI.Container();

        sceneG = new PIXI.Container();      // pooled prisms/billboards/dots

        /* the two fixed beach coast sets: art billboards just above the ground,
           their hasBackground fills under them, the cloud wall past the land */
        beachArtC = new PIXI.Container();
        beachBgG = new PIXI.Graphics();     // hasBackground fills, under every art sprite
        beachCloudG = new PIXI.Graphics();  // the cloud wall past the land, OVER the coast art
        beachArtC.addChild(beachBgG);

        walkG = new PIXI.Graphics();
        dynErrG = new PIXI.Graphics();    // red wireframes over chars whose
                                          // dynamic .bcell cell failed
        gridG = new PIXI.Graphics();
        markG = new PIXI.Graphics();
        outG = new PIXI.Graphics();
        var tc = new PIXI.Container();      // pooled grid numbers
        var mc = new PIXI.Container();      // pooled marker labels
        txtGrid = txtPool(tc, { fontFamily: 'monospace', fontSize: 10,
                                fill: 0x00e5ff });
        txtMark = txtPool(mc, { fontFamily: 'monospace', fontSize: 11,
                                fill: '#f4d03f', stroke: '#0a0e16',
                                strokeThickness: 3 });

        app.stage.addChild(groundC);
        app.stage.addChild(fragG);
        app.stage.addChild(propG);
        app.stage.addChild(beachArtC);      // coast art, over the ground
        app.stage.addChild(beachCloudG);    // cloud wall over the back of the mountain row
        app.stage.addChild(bridgeG);
        app.stage.addChild(raisedG);
        app.stage.addChild(bridgeNearG);
        app.stage.addChild(sceneG);
        app.stage.addChild(dynErrG);      // error wireframes over the char art
        app.stage.addChild(walkG);
        app.stage.addChild(gridG);
        app.stage.addChild(markG);
        app.stage.addChild(mc);
        app.stage.addChild(tc);
        app.stage.addChild(outG);
    }
    function txtPool(container, style) {
        var arr = [], n = 0;
        return {
            begin: function () { n = 0; },
            put: function (t, x, y) {
                var o = arr[n];
                if (!o) { o = new PIXI.Text({ text: '', style: style }); container.addChild(o); arr.push(o); }
                o.text = t; o.x = x; o.y = y; o.visible = true;
                n++;
            },
            end: function () { for (var i = n; i < arr.length; i++) arr[i].visible = false; }
        };
    }
    /* scene pool: refill from index 0 every frame — child order IS painter
       order, so no sorting and no add/remove churn. */
    function take() {
        var s = pool[pn];
        if (!s) {
            s = new PIXI.Sprite(UNIT);
            s.anchor.set(0);
            sceneG.addChild(s);
            pool.push(s);
        }
        pn++;
        s.visible = true;
        s.rotation = 0; s.skew.set(0, 0); s.alpha = 1; s.tint = 0xffffff;
        return s;
    }
    function poolEnd() { for (var i = pn; i < pool.length; i++) pool[i].visible = false; }
    function emitQuad(x0, y0, x1, y1, x3, y3, hex) {
        /* parallelogram p0..p3 with p2 = p1+p3-p0 (all prism faces satisfy
           it) driven through the unit-quad matrix */
        var s = take();
        s.texture = UNIT; s.tint = hex;
        Mtx.a = x1 - x0; Mtx.b = y1 - y0;
        Mtx.c = x3 - x0; Mtx.d = y3 - y0;
        Mtx.tx = x0; Mtx.ty = y0;
        s.setFromMatrix(Mtx);
    }
    function emitSpr(tex, x, y, w, h, mir) {
        var s = take();
        s.texture = tex;
        /* mir: mirror the texture within the SAME screen rect — the
           negative scale mirrors about the sprite origin, so shift the
           draw x by the width to land back over [x, x+w]. Used as the
           flipState-1 stand-in when no <slug>flipped twin shipped. */
        s.setFromMatrix(Mtx.set(1, 0, 0, 1, mir ? x + w : x, y));
        s.width = w; s.height = h;
        if (mir) s.scale.x = -Math.abs(s.scale.x);
    }
    function bridgeTake(ly) {
        /* pool twin of take() for the bridge layers (ly 0 far, 1 near) */
        var s = bridgePools[ly][bpns[ly]];
        if (!s) {
            s = new PIXI.Sprite(UNIT);
            s.anchor.set(0);
            (ly ? bridgeNearG : bridgeG).addChild(s);
            bridgePools[ly].push(s);
        }
        bpns[ly]++;
        s.visible = true;
        s.rotation = 0; s.skew.set(0, 0); s.alpha = 1; s.tint = 0xffffff;
        return s;
    }
    function bridgeHideRest() {
        for (var ly = 0; ly < 2; ly++)
            for (var h = bpns[ly]; h < bridgePools[ly].length; h++)
                bridgePools[ly][h].visible = false;
    }
    function emitBridgeSpr(tex, x, y, w, h, mir, ly) {
        var s = bridgeTake(ly);
        s.texture = tex;
        s.setFromMatrix(Mtx.set(1, 0, 0, 1, mir ? x + w : x, y));
        s.width = w; s.height = h;
        if (mir) s.scale.x = -Math.abs(s.scale.x);
    }
    function emitDot(x, y, r, hex) {
        var s = take();
        s.texture = UNIT; s.tint = hex; s.alpha = 1;
        s.setFromMatrix(Mtx.set(1, 0, 0, 1, x - r, y - r));
        s.width = 2 * r; s.height = 2 * r;
    }

    /* ---- ground sprites (tile-space, rebuilt only when the data changes) --- */
    var byType = [];                        // typeIdx -> [sprites] (legend toggles)
    var sheetRecs = [];                     // {sheets[sprite..], spec[sprite..], manh} road cells (sheet-mode)
    var waterRecs = [];                     // [sprite..] per river cell (water art, notes/09 §9)
    var WATERART_KEY = 'mrsnrub.cityview.waterart';
    var waterArtOn = true;                  // ships ON: RE'd RiverDrawer art over the flat fills
    try { if (localStorage.getItem(WATERART_KEY) === '0') waterArtOn = false; } catch (e) { /* private mode */ }
    var DIRTART_KEY = 'mrsnrub.cityview.dirtart';
    var dirtArtOn = true;                   // ships ON: RE'd dirt-sheet art over the flat dirt fills
    try { if (localStorage.getItem(DIRTART_KEY) === '0') dirtArtOn = false; } catch (e) { /* private mode */ }
    var dirtArtRecs = [];                   // {art, fill, big, tn, manh} per dirt cell (notes/09 §11)
    function buildSpecCell(parent, tx, ty, big, m, arr, recs, tex) {
        var S = [], F = SPEC.FW, B = BLEED;
        /* tex !== undefined selects the DIRT sheet mode (DirtRoadDrawing):
           same quadrant model, same ROAD_QUADS, different texture; no
           legacy bake and no flat-colour fallback — null returns here and
           the caller keeps the flat fill. */
        var dirt = tex !== undefined;
        var stex = dirt ? tex : specSheetTex();
        /* textured draw = the engine-true model (notes/08, road-lab
           2026-10-25): the cell is drawn as FOUR half-cell quadrant quads,
           each sampling one full state diamond chosen by the selector
           family table (engStates) from the cell's pass bits — saved
           nibble bits (E=1 W=2 N=4 S=8) OR'd with the neighbour probe
           (record exists && solid 'P') exactly like the engine's
           Pass_d = bit OR (contains AND solid). Solid 'P' cells are the
           state-0 full slab (the engine's flag-byte fast path). Geometry:
           each quad is a quadMesh over its half-cell square carrying the
           ROAD_QUADS UV corners — exactly the engine's four-vertex UV
           diamond, with no corner overdraw and no alpha. The selector flip
           byte (engFlip) picks the anti-diagonal corner assignment
           TL->R TR->B BR->L BL->T (quadGeom). */
        if (dirt ? !!stex : sheetReady) {
            var pass = { e: m >= 0 && !!(m & 1), w: m >= 0 && !!(m & 2),
                n: m >= 0 && !!(m & 4), s: m >= 0 && !!(m & 8) };
            if (m >= 0) {
                var nb = [[pass, 'e', recs[(tx + big) + ',' + ty]],
                    [pass, 'w', recs[(tx - big) + ',' + ty]],
                    [pass, 'n', recs[tx + ',' + (ty - big)]],
                    [pass, 's', recs[tx + ',' + (ty + big)]]];
                for (var ni = 0; ni < nb.length; ni++)
                    if (nb[ni][2] && nb[ni][2].p) nb[ni][0][nb[ni][1]] = true;
            }
            var picks;
            if (m < 0) picks = [[0, false, 0, 0, big]];
            else {
                var es = engStates(pass);
                picks = [[es.nw, engFlip(pass, 'nw'), 0, 0, big / 2],
                    [es.ne, engFlip(pass, 'ne'), big / 2, 0, big / 2],
                    [es.ws, engFlip(pass, 'ws'), 0, big / 2, big / 2],
                    [es.es, engFlip(pass, 'es'), big / 2, big / 2, big / 2]];
            }
            if (stex) {
                for (var pi = 0; pi < picks.length; pi++) {
                    var st = picks[pi];
                    var sh = quadMesh(parent, 'r', st[0], st[1], stex,
                        tx + st[2], ty + st[3], st[4]);
                    if (sh) S.push(sh);
                }
                for (var i = 0; i < S.length; i++) { S[i].visible = false; arr.push(S[i]); }
                return S;
            }
        }
        if (dirt) return null;      // dirt cells never draw flat SPEC rects
        /* flat fallback: no sheet (file:// without the DLC copy, decode
           error) — plain-colour rects, same 0.75/2.5/0.75 geometry */
        if (m < 0) {                                        // 'P': uniform slab
            S.push(mkSprite(UNIT, parent, tx, ty, big + B, big + B, SPEC.pave));
        } else {
            S.push(mkSprite(UNIT, parent, tx, ty, big + B, big + B, SPEC.foot));
            S.push(mkSprite(UNIT, parent, tx + F, ty + F, big - 2 * F, big - 2 * F, SPEC.asphalt));
            if (m & 1) S.push(mkSprite(UNIT, parent, tx + big - F - B, ty + F, F + 2 * B, big - 2 * F, SPEC.asphalt));  // E
            if (m & 2) S.push(mkSprite(UNIT, parent, tx - B, ty + F, F + 2 * B, big - 2 * F, SPEC.asphalt));            // W
            if (m & 4) S.push(mkSprite(UNIT, parent, tx + F, ty - B, big - 2 * F, F + 2 * B, SPEC.asphalt));            // N
            if (m & 8) S.push(mkSprite(UNIT, parent, tx + F, ty + big - F - B, big - 2 * F, F + 2 * B, SPEC.asphalt));  // S
        }
        for (var j = 0; j < S.length; j++) { S[j].visible = false; arr.push(S[j]); }
        return S;
    }
    /* River cell in the engine model (RiverDrawer, notes/09 §9): the same
       four-quadrant-quads pass as buildSpecCell (shared draw body 0x1208c10),
       driven by the RIVER family/flip table and the 0x3fc320 slot bakes.
       The saved river nibble (E=1 W=2 N=4 S=8) gives the pass bits, OR'd
       with the neighbour-solid probe over the RIVER cell records exactly
       like roads. Solid 'P' cells are the open-water slab (river state 1 —
       the 0<->1 exchange vs roads, re-measured on the art). Returns null
       (flat fill stays) when the sheet bakes are not ready. */
    /* the quadrant's DIAGONAL neighbour: a river cell that is not solid and
       connects back toward us on BOTH of its faces (E1 W2 N4 S8). */
    function rivDiagOpen(rec, fA, fB) {
        return !!rec && !rec.p && rec.m >= 0 && (rec.m & fA) !== 0 && (rec.m & fB) !== 0;
    }
    function buildRivCell(parent, tx, ty, big, m, arr, recs, tex) {
        /* tex !== undefined selects the DIRT sheet mode (DirtRiverDrawing):
           same quadrant model, same RIVER_QUADS, different texture */
        var dirt = tex !== undefined;
        if (dirt ? !tex : !rivReady) return null;
        var S = [], picks;
        if (m < 0) picks = [[1, false, 0, 0, big]];             // 'P': full slab
        else {
            var pass = { e: !!(m & 1), w: !!(m & 2), n: !!(m & 4), s: !!(m & 8) };
            var nb = [[pass, 'e', recs[(tx + big) + ',' + ty]],
                [pass, 'w', recs[(tx - big) + ',' + ty]],
                [pass, 'n', recs[tx + ',' + (ty - big)]],
                [pass, 's', recs[tx + ',' + (ty + big)]]];
            for (var ni = 0; ni < nb.length; ni++)
                if (nb[ni][2] && nb[ni][2].p) nb[ni][0][nb[ni][1]] = true;
            /* diagonal guards (y grows south): each neighbour must face us on
               both of its sides — nw cell reaches E+S, ne W+S, ws E+N, es W+N */
            pass.dnw = rivDiagOpen(recs[(tx - big) + ',' + (ty - big)], 1, 8);
            pass.dne = rivDiagOpen(recs[(tx + big) + ',' + (ty - big)], 2, 8);
            pass.dws = rivDiagOpen(recs[(tx - big) + ',' + (ty + big)], 1, 4);
            pass.des = rivDiagOpen(recs[(tx + big) + ',' + (ty + big)], 2, 4);
            var es = rivStates(pass);
            picks = [[es.nw, rivFlip(pass, 'nw'), 0, 0, big / 2],
                [es.ne, rivFlip(pass, 'ne'), big / 2, 0, big / 2],
                [es.ws, rivFlip(pass, 'ws'), 0, big / 2, big / 2],
                [es.es, rivFlip(pass, 'es'), big / 2, big / 2, big / 2]];
        }
        var rtex = dirt ? tex : rivSheetTex();
        if (!rtex) return null;
        for (var pi = 0; pi < picks.length; pi++) {
            var st = picks[pi];
            var sh = quadMesh(parent, 'v', st[0], st[1], rtex,
                tx + st[2], ty + st[3], st[4]);       // quad == quadrant
            if (sh) S.push(sh);
        }
        for (var ri = 0; ri < S.length; ri++) { S[ri].visible = false; arr.push(S[ri]); }
        return S;
    }
    function applyDirtMode() {
        /* Dirt art visibility: the dirt-sheet quadrant art for dirtroad
           (road model, notes/08) and dirt (river model, notes/09 §9) cells.
           Runs after applySheetMode so it can pull the legacy manhole from
           under the art; with the art off everything falls back to whatever
           applySheetMode decided (legacy road-sheet passes or the disc). */
        for (var i = 0; i < dirtArtRecs.length; i++) {
            var r = dirtArtRecs[i];
            var vis = dirtArtOn && !!dirtSheetTex() && !terrain.hidden[r.tn];
            for (var k = 0; k < r.art.length; k++) r.art[k].visible = vis;
            r.fill.width = r.fill.height = vis ? r.big : r.big + BLEED;
            if (r.manh && vis) r.manh.visible = false;
        }
        var b = $('btn-dirtart');
        if (b) b.classList.toggle('on', dirtArtOn && !!dirtSheetTex());
    }
    function applyWaterMode() {
        var vis = waterArtOn && rivReady && !terrain.hidden['river'];
        for (var i = 0; i < waterRecs.length; i++)
            for (var k = 0; k < waterRecs[i].length; k++)
                waterRecs[i][k].visible = vis;
        var b = $('btn-waterart');
        if (b) b.classList.toggle('on', waterArtOn);
    }
    function raiseRoadCell(sheets, spec, manh) {
        /* the game draws the crossing's carriageway art OVER the deck art
           (hiding each row's inner rail, leaving the outer one visible).
           Reparent the cell's road sprites from featC into raisedG, the
           tile-space twin container drawn right above the bridge layer;
           their tile-space coords carry over unchanged, and every visibility
           toggle keeps working through the sheetRecs/byType references. */
        var list = sheets || spec || [];
        for (var i = 0; i < list.length; i++) raisedG.addChild(list[i]);
        if (manh) raisedG.addChild(manh);
    }
    function buildGround() {
        /* the top-level Road-network toggle applies its state at page-parse
           time, before app.init() has resolved and makeScene() exists — the
           boot sequence re-runs us once the containers are live */
        if (!featC) return;
        for (var i = featC.children.length - 1; i >= 0; i--) featC.children[i].destroy();
        for (i = fillC.children.length - 1; i >= 0; i--) fillC.children[i].destroy();
        /* crossing cells reparented into raisedG are no longer featC
           children: drop them here too or a rebuild would leak the old art */
        for (i = raisedG.children.length - 1; i >= 0; i--) raisedG.children[i].destroy();
        byType = []; sheetRecs = []; waterRecs = []; dirtArtRecs = [];
        pierRecs = [];
        var pierCells = [];
        var f = terrain.features;
        /* cell-record map for the spec-mode neighbour probe (engine
           Pass_d = nibble bit OR (contains AND solid)): keyed by cell
           ORIGIN tile — cell codebooks share one multiples-of-4 lattice
           (terrain.js decodeCells), so a cell's neighbour record in a
           direction is the origin at ±big tiles on that axis. River cells
           get their own map (RiverDrawer probes RIVERS, not ROADS). */
        var recs = {}, rivRecs = {}, dirtRecs = {}, dirtRivRecs = {}, brushOcc = {};
        for (var ri = 0; ri < f.length; ri++) {
            var fe = f[ri];
            if (fe[2] === TI_ROAD && (fe[5] || 1) === 4)
                recs[fe[0] + ',' + fe[1]] = { m: fe[3], p: fe[4] };
            else if (fe[2] === TI_RIVER && (fe[5] || 1) === 4 && fe[3] >= -1 && fe[3] <= 15)
                rivRecs[fe[0] + ',' + fe[1]] = { m: fe[3], p: fe[4] };
            else if (fe[2] === TI_DIRTROAD && (fe[5] || 1) === 4 && fe[3] >= -1 && fe[3] <= 15)
                dirtRecs[fe[0] + ',' + fe[1]] = { m: fe[3], p: fe[4] };
            else if (fe[2] === TI_DIRT && (fe[5] || 1) === 4 && fe[3] >= -1 && fe[3] <= 15)
                dirtRivRecs[fe[0] + ',' + fe[1]] = { m: fe[3], p: fe[4] };
            else if (fe[2] === TI_BOARDWALK || fe[2] === TI_PIER)
                (brushOcc[fe[2]] || (brushOcc[fe[2]] = {}))[fe[0] + ',' + fe[1]] = 1;
        }
        for (i = 0; i < f.length; i++) {
            var e = f[i], tx = e[0], ty = e[1], ti = e[2],
                m = e[3], big = e[5] || 1;
            var arr = byType[ti] || (byType[ti] = []);
            var hex = rgbHex(TYPE_STYLE[CityTerrain.TYPE_ORDER[ti]]);
            var fill = mkSprite(UNIT, fillC, tx, ty, big + BLEED, big + BLEED, hex);
            arr.push(fill);
            if (ti === TI_DIRT && big === 4 && m >= -1 && m <= 15) {
                /* Dirt art: dirt (DIRT = landinfo "dirtriver", DirtRiver-
                   Drawing) is the engine's river-model drawer on the dirt
                   sheet — same quadrant quads as Water art, its own saved-
                   grid probe map (dirtRivRecs), NOT the RIVERS map. The
                   cell is built regardless of the sheet state (it may
                   finish loading after the grid); applyDirtMode drops the
                   record when the sheet never arrives. */
                var wr2 = buildRivCell(featC, tx, ty, big, m, arr,
                    dirtRivRecs, dirtSheetTex());
                if (wr2) {
                    dirtArtRecs.push({ art: wr2, fill: fill, big: big,
                        tn: 'dirt', manh: null });
                    fill.width = fill.height = big;
                }
                continue;
            }
            if (ti === TI_RIVER && big === 4 && m >= -1 && m <= 15) {
                /* Water art: the engine-true RiverDrawer quadrant draw
                   (notes/09 §9) over the flat fill; applyWaterMode decides
                   visibility so the toggle never needs a rebuild */
                var wr = buildRivCell(featC, tx, ty, big, m, arr, rivRecs);
                if (wr) { waterRecs.push(wr); fill.width = fill.height = big; }
                continue;
            }
            if ((ti === TI_BOARDWALK || ti === TI_PIER) && big === 1) {
                /* brush tile on the ocean grid: the flat fill stays (it is
                   what the page drew before the art existed) and the bsv3
                   block art is assembled after the loop, so the tiles
                   overlap in screen order; applyPierMode decides */
                pierCells.push({ tn: CityTerrain.TYPE_ORDER[ti], tx: tx, ty: ty,
                                 occ: brushOcc[ti] || {}, fill: fill, arr: arr });
                continue;
            }
            if (ti !== TI_ROAD && ti !== TI_DIRTROAD && ti !== TI_KLSROAD) continue;
            /* road-like: manhole when the sheet does not cover the cell
               (js/terrain.js: sheet art OR manhole, never both) */
            var sheets = null, spec = null, manh = null;
            var dspec = null;
            var cell = m >= -1;              // cell-codebook record?
            if (ti === TI_DIRTROAD && big === 4 && cell) {
                /* Dirt art: dirtroad (DIRT_ROADS = landinfo "dirt",
                   DirtRoadDrawing) draws through the same road function as
                   paved roads — its sheet art IS the quadrant model, so it
                   replaces the legacy sheet passes / manhole here exactly
                   like TI_ROAD's spec mode does, but on the dirt sheet and
                   always (no Road-art cycle gating). dirtRecs is the
                   saved dirtroad grid's own record map (the engine probes
                   its own layer for solid sides, notes/08). Built even
                   before the sheet loads; the record is dropped if the
                   sheet never arrives. */
                dspec = buildSpecCell(featC, tx, ty, big, m, arr,
                    dirtRecs, dirtSheetTex());
                if (dspec) fill.width = fill.height = big;
            }
            if (ti === TI_ROAD && cell && sheetArtMode === 4) {
                /* Road art·spec: the engine-true quadrant draw (notes/08)
                   replaces the sheet passes entirely (flat fill below,
                   no manhole); recs gives the neighbour-solid probe */
                spec = buildSpecCell(featC, tx, ty, big, m, arr, recs);
                /* art covers the cell exactly: no fill overhang to show
                   past its edge over the base grass */
                if (specSheetTex()) fill.width = fill.height = big;
            } else if (ti === TI_ROAD && cell) {
                /* same multi-pass pick as the canvas page (terrain.js
                   f[3] >= -1 branch): nibble straights (masks 3/12) and
                   _pavePick's one-cell-tall bands paint a flat state-0
                   asphalt base plus strip-clipped kerb/paving pieces on
                   the grass edges; other nibbles and slab interiors are
                   a single full-diamond piece. The strip clips are
                   baked ('__pieces'), so a pass is just one sprite. */
                var passes;
                if (m < 0) passes = terrain._pavePick(tx, ty);
                else {
                    var tn = (m & 3) | ((m & 4) << 1) | ((m & 8) >> 1);
                    if (tn === 3)
                        passes = [[0, false, null], [3, false, 'ny'], [4, true, 'py']];
                    else if (tn === 12)
                        passes = [[0, false, null], [4, false, 'nx'], [3, true, 'px']];
                    else {
                        var pn = CityTerrain.SHEET_TABLE[tn];
                        passes = [[pn[0], pn[1], null]];
                    }
                }
                if (!passes) passes = [[0, false, null]];
                sheets = [];
                for (var pp = 0; pp < passes.length; pp++) {
                    var sh = new PIXI.Sprite(UNIT);
                    sh.anchor.set(0.5);
                    sh.position.set(tx + big / 2, ty + big / 2);
                    sh.rotation = Math.PI / 4;
                    /* linear in big: a cell's sheet art must span the WHOLE
                       4x4 cell (inscribed diamond = the cell square), like
                       the canvas page's quad(..., big) in _sheetTile. The
                       bare SHEET_SX/SY (big=1) drew every cell's art at
                       quarter scale — a 1-tile diamond floating in the
                       middle of the flat fill, corners landing at cell
                       centres (road-spec.json layout mismatch, 2026-10-25) */
                    sh.scale.set(passes[pp][1] ? -big * SHEET_SX : big * SHEET_SX,
                        big * SHEET_SY);
                    sh._pass = passes[pp];
                    sh.visible = false;
                    featC.addChild(sh);
                    sheets.push(sh);
                }
            }
            var cx = tx + (big - 1) / 2, cy = ty + (big - 1) / 2;
            manh = new PIXI.Sprite(DISC);
            manh.anchor.set(0.5);
            manh.position.set(cx + manhOff.x, cy + manhOff.y);
            manh.width = manh.height = 2 * MANH_R + BLEED;
            manh.tint = 0x14141a; manh.alpha = 0.85;
            manh.visible = false;
            if (bridgeCells && bridgeCells[tx + ',' + ty])
                raiseRoadCell(sheets, spec, manh);
            sheetRecs.push({ sheets: sheets, spec: spec, manh: manh,
                arr: arr, tx: tx, ty: ty, dirtArt: !!dspec });
            arr.push(sheets ? sheets[0] : manh);
            if (sheets && manh) arr.push(manh);
            if (dspec) {
                /* dirtroad cell: the dirt-sheet quadrant art rides the
                   same record (legacy sheet/manh stay usable when the
                   Dirt-art toggle is off) */
                dirtArtRecs.push({ art: dspec, fill: fill, big: big,
                    tn: 'dirtroad', manh: manh });
            }
        }
        /* brush art last, back to front: a cell's raised deck, legs and
           splash must overdraw the cell BEHIND it, and its C_Shadow must
           never land on a nearer deck. Screen depth is the ORIENTED tile
           sum (the terrain feature sort's key) — plain tx + ty only holds
           for one orientation, and under the default ORIENT it drew the
           far cells last, their shadows striping every deck row blue */
        pierCells.sort(function (p, q) {
            var up = CAM.oriented(p.tx, p.ty), uq = CAM.oriented(q.tx, q.ty);
            return (up[0] + up[1]) - (uq[0] + uq[1]) || up[0] - uq[0];
        });
        /* every tile's flat fill, by its 4x4 cell: the cell's frame owns all
           sixteen (applyPierMode hides them together when the art shows) */
        var cellFills = {};
        for (i = 0; i < pierCells.length; i++) {
            var cf = pierCells[i], ck = cf.tn + ':' + (cf.tx & ~3) + ',' + (cf.ty & ~3);
            (cellFills[ck] = cellFills[ck] || []).push(cf.fill);
        }
        for (i = 0; i < pierCells.length; i++) {
            var pc = pierCells[i];
            /* the brushes are 4x4 cells on the land's cell lattice (town
               x = -48 + 4c, y = -112 + 4r): one frame per cell, at its
               origin tile */
            if ((pc.tx & 3) || (pc.ty & 3)) continue;
            var art = buildPierCell(featC, pc.tn, pc.tx, pc.ty, pc.occ, pc.arr, 4);
            if (art) pierRecs.push({ art: art, tn: pc.tn, tx: pc.tx, ty: pc.ty,
                                     fills: cellFills[pc.tn + ':' + pc.tx + ',' + pc.ty] || [pc.fill] });
        }
        pierOver = null;                    // the over pass re-derives against the new cells
        applySheetMode();
        applyTypeVisibility();
        applyWaterMode();
        applyDirtMode();
        applyPierMode();
        buildAvenues();
    }
    /* manholes: the canvas page projects the tile centre with a +hh world
       nudge (js/terrain.js _manhole). In tile space that is the constant
       offset worldToTile(0, hh) — recompute when ORIENT changes. */
    var manhOff = { x: 0, y: 0 };
    function recomputeManhOff() {
        var t = CAM.worldToTile(0, CAM.TILE.hh);
        manhOff.x = t.x; manhOff.y = t.y;
    }
    function applyTypeVisibility() {
        var TO = CityTerrain.TYPE_ORDER;
        for (var t = 0; t < TO.length; t++) {
            var arr = byType[t];
            if (!arr) continue;
            var vis = !terrain.hidden[TO[t]];
            for (var i = 0; i < arr.length; i++)
                if (arr[i]._force !== 0) arr[i].visible = vis;
        }
        applySheetMode();
        applyWaterMode();          // water quads live in byType[river] too:
        applyDirtMode();           // dirt art likewise — last word on the
        applyPierMode();           // brush art likewise (notes/09 §12)
    }                              // cell after the legend pass
    /* sheet art ON (road cells): the cleaned diamond sprites cover the
       flat fill and the manhole retires; OFF: flat fill + manhole.
       Multi-pass records (nibble straights, pave bands) assign each
       sprite its full-slot or baked-piece texture here — after any
       season/sheet rebuild the textures are re-fetched from subTex. */
    function applySheetMode() {
        var on = terrain.useSheetArt && sheetReady;
        var specOn = sheetArtMode === 4;        // road-lab tuned spec art
        for (var i = 0; i < sheetRecs.length; i++) {
            var r = sheetRecs[i];
            var vis = !terrain.hidden['road'];
            /* dirtroad cell whose dirt-sheet art is showing: the legacy
               road-sheet passes / manhole stay under it (applyDirtMode
               owns the cell; the toggle re-runs us to hand it back) */
            var dirtVis = r.dirtArt && dirtArtOn && !!dirtSheetTex();
            if (r.spec) {
                for (var k = 0; k < r.spec.length; k++) r.spec[k].visible = specOn && vis;
                if (r.manh) r.manh.visible = false;
            } else if (r.sheets) {
                for (var j = 0; j < r.sheets.length; j++) {
                    var sh = r.sheets[j], p = sh._pass;
                    sh.visible = on && vis && !dirtVis;
                    if (!on) continue;
                    var t = p[2] ? pieceTex(p[0], p[2], p[1])
                        : sheetSlotTex(CityTerrain.SHEET_STATES[p[0]]);
                    if (t && sh.texture !== t) sh.texture = t;
                }
                r.manh.visible = !on && vis && !dirtVis;
            } else if (r.manh) {
                var tn = r.arr === byType[TI_DIRTROAD] ? 'dirtroad' :
                    (r.arr === byType[TI_KLSROAD] ? 'klsroad' : 'road');
                r.manh.visible = !on && !terrain.hidden[tn] && !dirtVis;
            }
        }
    }
    /* Experimental procedural N–S avenues: static cells (hand-placed
       street table), built once; visibility follows the Road-art cycle. */
    function buildAvenues() {
        for (var i = avenC.children.length - 1; i >= 0; i--) avenC.children[i].destroy();
        var A = CityTerrain.AVENUE, occ = terrain._roadOcc;
        var ox = terrain.ox, oy = terrain.oy;
        var probe = function (tx, ty) {
            return CityTerrain.avenueAt(tx + ox, ty + oy) ? 1 : 0;
        };
        var yLo = A.streets[0][2], yHi = A.streets[0][3];
        var xLo = A.streets[0][0], xHi = A.streets[0][1];
        for (var si = 1; si < A.streets.length; si++) {
            if (A.streets[si][2] < yLo) yLo = A.streets[si][2];
            if (A.streets[si][3] > yHi) yHi = A.streets[si][3];
            if (A.streets[si][0] < xLo) xLo = A.streets[si][0];
            if (A.streets[si][1] > xHi) xHi = A.streets[si][1];
        }
        var ay0 = yLo - oy, ay1 = yHi - oy, ax0 = xLo - ox, ax1 = xHi - ox;
        var hex = rgbHex(TYPE_STYLE.road);
        for (var ay = ay0; ay <= ay1; ay++) {
            for (var ax = ax0; ax <= ax1; ax++) {
                if (!probe(ax, ay) || occ[ax + ',' + ay]) continue;
                mkSprite(UNIT, avenC, ax, ay, 1 + BLEED, 1 + BLEED, hex);
                var pick = CityTerrain.sheetStateFor(occ, ax, ay, probe);
                var sh = new PIXI.Sprite(UNIT);
                sh.anchor.set(0.5);
                sh.position.set(ax + 0.5, ay + 0.5);
                sh.rotation = Math.PI / 4;
                sh.width = 127; sh.height = 66;
                sh.scale.set(pick[1] ? -SHEET_SX : SHEET_SX, SHEET_SY);
                var t = sheetSlotTex(CityTerrain.SHEET_STATES[pick[0]]);
                if (t) sh.texture = t;
                avenC.addChild(sh);
            }
        }
    }

    /* ---- zoomed-out flat atlas blits (LOD) ----------------------------------
       Below BUILD_LOD_S a block is a pile of sub-pixel fills and the feature
       pass a pile of sub-pixel diamonds: both pages collapse to TWO
       bilinear atlas blits through the ground matrix — terrain.flatInfo()
       (reused from terrain.js, it only builds offscreen canvases) and a
       ported buildBuildFlat (one tile-space bitmap per object bucket,
       flattened honouring the legend toggles). */
    var bAtlas = null, bFlatCanvas = null, bFlatTex = null, bFlatSig = null;
    var BAtlasTS = 2;
    var terrFlatCache = null;               // {img, tex}
    var terrFlatDirty = true, bFlatDirty = true;
    function buildBuildFlat() {
        var i, b, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        if (!buildings.length || !document.createElement) return null;
        for (i = 0; i < buildings.length; i++) {
            b = buildings[i];
            if (b.x0 < x0) x0 = b.x0;
            if (b.y0 < y0) y0 = b.y0;
            if (b.x1 > x1) x1 = b.x1;
            if (b.y1 > y1) y1 = b.y1;
        }
        x0 -= 1; y0 -= 1; x1 += 1; y1 += 1;
        var k = BAtlasTS, bleed = 0.5,
            W = Math.max(1, Math.ceil((x1 - x0) * k)),
            H = Math.max(1, Math.ceil((y1 - y0) * k));
        if (W * H > 40e6) return null;                  // sanity
        if (!bAtlas || bAtlas.x0 !== x0 || bAtlas.W !== W || bAtlas.H !== H) {
            var byCat = {}, cats = [];
            for (i = 0; i < buildings.length; i++) {    // depth-sorted already
                b = buildings[i];
                if (hiddenObjs[b.hkey]) continue;       // per-instance hide
                var rec = byCat[b.cat];
                if (!rec) {
                    rec = byCat[b.cat] = document.createElement('canvas');
                    rec.width = W; rec.height = H;
                    rec._c = rec.getContext('2d');
                    cats.push(b.cat);
                }
                rec._c.fillStyle = b.fT;
                rec._c.fillRect((b.x0 - x0) * k - bleed, (b.y0 - y0) * k - bleed,
                    (b.x1 - b.x0) * k + bleed * 2, (b.y1 - b.y0) * k + bleed * 2);
            }
            bAtlas = { x0: x0, y0: y0, W: W, H: H, byCat: byCat, cats: cats };
            bFlatDirty = true;
        }
        var sig = '', ci;
        for (ci = 0; ci < bAtlas.cats.length; ci++)
            sig += bAtlas.cats[ci] + (objHidden[bAtlas.cats[ci]] ? '1' : '0') + ';';
        if (bFlatDirty || bFlatSig !== sig || !bFlatCanvas) {
            if (!bFlatCanvas) {
                bFlatCanvas = document.createElement('canvas');
                bFlatCanvas.width = W; bFlatCanvas.height = H;
            }
            var fc = bFlatCanvas.getContext('2d');
            fc.clearRect(0, 0, W, H);
            for (ci = 0; ci < bAtlas.cats.length; ci++)
                if (!objHidden[bAtlas.cats[ci]])
                    fc.drawImage(bAtlas.byCat[bAtlas.cats[ci]], 0, 0);
            bFlatSig = sig; bFlatDirty = false;
            if (!bFlatTex) bFlatTex = PIXI.Texture.from(bFlatCanvas);
            else bFlatTex.source.update();
        }
        return { img: bFlatCanvas, x0: bAtlas.x0, y0: bAtlas.y0,
                 W: bAtlas.W, H: bAtlas.H, ts: k };
    }

    /* ============================ render ===================================== */
    var DIAG = {
        mode: 'Pixi', ms: 0, fps: 0, maxMs: 0, anims: 0, charAnims: 0,
        pool: 0, ver: '2026-11-04'
    };
    window.__CV_DIAG = DIAG;
    window.__CV_VER = DIAG.ver;                    // console sanity check
    var diagFrames = 0, diagMsAcc = 0, diagLastT = 0;

    window.__CV_PROBE = function () {              // console: frame contents
        var s = CAM.scale(cam);
        var T = terrain.visibleTileRect(cam, VW, VH);
        return {
            s: Math.round(s * 100) / 100, lod: s < BUILD_LOD_S,
            pool: DIAG.pool, dots: peopleDots,
            art: { sprites: !!citySprites, chars: !!charMan, pend: ALOAD.pend,
                   got: ALOAD.artGot, dead: ALOAD.artDead, known: ALOAD.artKnown },
            T: T
        };
    };
    var peopleDots = 0;
    var walkLive = 0;                     // walking characters on screen this frame

    function render() {
        var t0 = performance.now();
        animNow = t0;                     // one clock per frame: instances agree
        animFrameId++;                    // the atlas cache's "is it on screen" tick
        animLive = 0;
        animTickMs = 90;                  // the frame's fastest strip, below
        animPending = 0;
        charAnimLive = 0;
        animBudget = ANIM_MAX_BLITS;
        var s = CAM.scale(cam);
        var lod = s < BUILD_LOD_S;
        var A = CAM.tileAffine(cam, VW, VH);
        Mtx.set(1, 0, 0, 1, 0, 0);
        var GM = new PIXI.Matrix(A.a, A.d, A.b, A.e, A.c, A.f);
        groundC.setFromMatrix(GM);
        raisedG.setFromMatrix(GM);          // holds reparented crossing
                                            // road cells: same tile-space
        var T = terrain.visibleTileRect(cam, VW, VH);

        /* --- ground ------------------------------------------------------- */
        var showGrass = !terrain.hidden['grass'];
        grassFillS.visible = showGrass && (s < FLAT_GRASS_S || !grassTex);
        if (grassTex && grassTil.texture !== grassTex) {
            grassTil.texture = grassTex;
            grassTil.tileScale.set(terrain.grassRepeat / 1024,
                                   terrain.grassRepeat / 1024);
        }
        grassTil.visible = showGrass && s >= FLAT_GRASS_S && !!grassTex;
        seaFillS.visible = terrain.seaFill &&
            terrain.seaFillX1 > terrain.seaFillX0 && !terrain.hidden['ocean'];
        if (seaFillS.visible) {
            seaFillS.position.set(terrain.seaFillX0 - terrain.ox,
                                  terrain.seaFillY0 - terrain.oy);
            seaFillS.width = terrain.seaFillX1 - terrain.seaFillX0;
            seaFillS.height = terrain.seaFillY1 - terrain.seaFillY0;
        }
        featC.visible = !lod;
        fillC.visible = !lod;
        raisedG.visible = !lod;             // reparented crossing road cells
        avenC.visible = !lod && terrain.useAvenues && terrain.useSheetArt &&
                        sheetReady;
        terrFlatS.visible = false; buildFlatS.visible = false;
        if (lod) {
            var fi = terrain.flatInfo();
            if (fi) {
                if (!terrFlatCache || terrFlatCache.img !== fi.img)
                    terrFlatCache = { img: fi.img, tex: PIXI.Texture.from(fi.img) };
                if (terrFlatDirty) { terrFlatCache.tex.source.update(); terrFlatDirty = false; }
                terrFlatS.texture = terrFlatCache.tex;
                terrFlatS.position.set(fi.x0, fi.y0);
                terrFlatS.width = fi.W / fi.ts; terrFlatS.height = fi.H / fi.ts;
                terrFlatS.visible = true;
            }
            var bf = buildBuildFlat();
            if (bf && bFlatTex) {
                buildFlatS.texture = bFlatTex;
                buildFlatS.position.set(bf.x0, bf.y0);
                buildFlatS.width = bf.W / bf.ts; buildFlatS.height = bf.H / bf.ts;
                buildFlatS.visible = true;
            }
        }

        /* --- ground-level overlays (under the buildings) ------------------- */
        drawFrags(T);
        drawProposed(T);
        beachDraw(A, s, T);                 // fixed coast sets (art)

        /* --- scene pool ---------------------------------------------------- */
        pn = 0;
        renderScene(A, s, T, lod);
        poolEnd();
        if (lod) {                          // bridges live outside the main
            bpns[0] = bpns[1] = 0;          // pool: clear them under LOD too
            bridgeHideRest();
        }

        /* --- overlays above the scene -------------------------------------- */
        drawWalks(T);
        drawGrid(A, s, T);
        drawMarkers(T);
        drawOutlines();

        /* --- diagnostics --------------------------------------------------- */
        DIAG.ms = performance.now() - t0;
        DIAG.anims = animLive;
        DIAG.charAnims = charAnimLive;
        DIAG.pool = pn;
        DIAG.mode = lod ? 'Pixi·LOD' : 'Pixi';
        diagFrames++; diagMsAcc += DIAG.ms;
        if (DIAG.ms > DIAG.maxMs) DIAG.maxMs = DIAG.ms;
        $('zoomread').textContent = 'zoom ' + cam.zoom.toFixed(2) + '  ·  tile ' +
            CAM.TILE.hw + ':' + CAM.TILE.hh + ' · ' + Math.round(CAM.scale(cam)) + 'px/unit' + (gridOn && hoverTile
            ? '  ·  hover ' + hoverTile[0] + ',' + hoverTile[1] : '');
    }

    /* ---- brush cells IN FRONT of a building (2026-10-30.25) -----------------
       The brush art lives in the ground layer, under every building. That is
       right for whatever stands ON a deck (the Squidport shops), but wrong for
       a building the deck lies wholly in front of: BarnacleBayMarina's own
       dock ends at x = -8, the brush cell x -12..-8 butts against it on the
       viewer's side, and the marina's dock end (side face, legs, shadow) was
       painted over that cell's deck. In game the cell covers it.
       A single scalar depth key cannot serve both cases, so the cells keep
       their ground copy and, where needed, are BLITTED AGAIN in the scene pool
       right after the last building they are in front of:
         * "in front" is the iso separating-axis test on oriented footprints
           (cell.u0 >= B.u1 or cell.v0 >= B.v1), and only counts when the
           two drawn rects overlap on screen (world-space bounds);
         * a cell redrawn late drags every brush cell in front of it that it
           overlaps along (else its C_Shadow lands on a nearer deck);
         * a building already drawn that stands ON or in front of a redrawn
           cell and overlaps it is emitted again after the cells.
       Derived lazily (needs the sprite manifest), again on every ground
       rebuild (ORIENT changes rebuild the ground). */
    var pierOver = null;                // { at: {bIdx: [rec..]}, re: {bIdx: [b..]}, cells, conflicts }
    var PIER_OVER_ON = QP.get('pierOver') !== '0';
    function obox(x0, y0, x1, y1) {     // oriented box of a tile rect
        var a = CAM.oriented(x0, y0), b = CAM.oriented(x1, y1);
        return { u0: Math.min(a[0], b[0]), u1: Math.max(a[0], b[0]),
                 v0: Math.min(a[1], b[1]), v1: Math.max(a[1], b[1]) };
    }
    function inFront(p, q) {            // p wholly in front of q
        return p.u0 >= q.u1 - 1e-9 || p.v0 >= q.v1 - 1e-9;
    }
    function wOverlap(p, q) {
        return p.x0 < q.x1 && q.x0 < p.x1 && p.y0 < q.y1 && q.y0 < p.y1;
    }
    function bldWorldRect(b) {
        var sp = b.slug ? spriteEntry(b.slug) : null, S = ART.S;
        var w = CAM.tileToWorld(b.px + ART.ax, b.py + ART.ay);
        if (sp) {
            var ax = Math.max(sp.anchor[0], sp.w - sp.anchor[0]);
            return { x0: w.x - ax / S, x1: w.x + ax / S,
                     y0: w.y - sp.anchor[1] / S, y1: w.y + (sp.h - sp.anchor[1]) / S };
        }
        var r = CAM.tileRectToWorldRect(b);
        return { x0: r.x0, x1: r.x1, y0: r.y0 - b.hgt, y1: r.y1 };
    }
    function cellWorldRect(rec) {
        var bl = rec.art.blocks, S = ART.S, x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
        for (var i = 0; i < bl.length; i++) {
            var k = bl[i], w = k.c[2] * Math.abs(k.m[0]), h = k.c[3] * Math.abs(k.m[3]);
            var l = k.m[0] < 0 ? k.p[0] - w : k.p[0], t = k.m[3] < 0 ? k.p[1] - h : k.p[1];
            x0 = Math.min(x0, l); x1 = Math.max(x1, l + w);
            y0 = Math.min(y0, t); y1 = Math.max(y1, t + h);
        }
        var f = CAM.tileToWorld(rec.tx, rec.ty + 4);
        return { x0: f.x + (x0 + PIER_NUDGE.x) / S, x1: f.x + (x1 + PIER_NUDGE.x) / S,
                 y0: f.y + (y0 + PIER_NUDGE.y) / S, y1: f.y + (y1 + PIER_NUDGE.y) / S };
    }
    function derivePierOver() {
        var out = { at: {}, re: {}, cells: 0, conflicts: 0 };
        if (!PIER_OVER_ON || !pierRecs.length) return out;
        var C = [], i, j, b;
        for (i = 0; i < pierRecs.length; i++) {
            var r = pierRecs[i];
            C.push({ rec: r, ob: obox(r.tx, r.ty, r.tx + 4, r.ty + 4),
                     wr: cellWorldRect(r), after: -1 });
        }
        /* buildings near any brush cell (cheap prefilter on tile distance) */
        var bx0 = 1e9, bx1 = -1e9, by0 = 1e9, by1 = -1e9;
        for (i = 0; i < C.length; i++) {
            bx0 = Math.min(bx0, C[i].rec.tx); bx1 = Math.max(bx1, C[i].rec.tx + 4);
            by0 = Math.min(by0, C[i].rec.ty); by1 = Math.max(by1, C[i].rec.ty + 4);
        }
        var near = [];
        for (i = 0; i < buildings.length; i++) {
            b = buildings[i];
            if (b.x1 < bx0 - 24 || b.x0 > bx1 + 24 || b.y1 < by0 - 24 || b.y0 > by1 + 24) continue;
            near.push({ i: i, b: b, ob: obox(b.x0, b.y0, b.x1, b.y1), wr: bldWorldRect(b) });
        }
        for (i = 0; i < C.length; i++)
            for (j = 0; j < near.length; j++)
                if (inFront(C[i].ob, near[j].ob) && wOverlap(C[i].wr, near[j].wr) &&
                    near[j].i > C[i].after) C[i].after = near[j].i;
        /* a late cell drags the overlapping cells in front of it along
           (C is in ground draw order, back to front: one forward sweep
           propagates, repeat until stable) */
        for (var pass = 0, moved = 1; moved && pass < 64; pass++) {
            moved = 0;
            for (i = 0; i < C.length; i++) {
                if (C[i].after < 0) continue;
                for (j = 0; j < C.length; j++) {
                    if (j === i || C[j].after >= C[i].after) continue;
                    if (inFront(C[j].ob, C[i].ob) && wOverlap(C[j].wr, C[i].wr)) {
                        C[j].after = C[i].after; moved = 1;
                    }
                }
            }
        }
        for (i = 0; i < C.length; i++) {      // ground order kept within a slot
            if (C[i].after < 0) continue;
            (out.at[C[i].after] = out.at[C[i].after] || []).push(C[i].rec);
            out.cells++;
            /* buildings drawn BEFORE the slot that stand on / in front of the
               cell and overlap it: emit them again after the cells */
            for (j = 0; j < near.length; j++) {
                var n = near[j];
                if (n.i >= C[i].after || !wOverlap(C[i].wr, n.wr)) continue;
                if (inFront(C[i].ob, n.ob)) continue;          // genuinely behind it
                var lst = out.re[C[i].after] = out.re[C[i].after] || [];
                if (lst.indexOf(n.b) < 0) { lst.push(n.b); out.conflicts++; }
            }
        }
        for (var key in out.re)                // re-emit in the scene's own order
            out.re[key].sort(function (p, q) { return buildings.indexOf(p) - buildings.indexOf(q); });
        return out;
    }
    window.__CV_PIER_OVER = function () {          // harness/console probe
        var o = derivePierOver(), slots = [];
        for (var k in o.at) slots.push({ after: buildings[k].slug, at: +k,
            cells: o.at[k].map(function (r) { return r.tn + '@' + r.tx + ',' + r.ty; }),
            reemit: (o.re[k] || []).map(function (b) { return b.slug; }) });
        return { recs: pierRecs.length, cells: o.cells, reemit: o.conflicts, slots: slots };
    };
    function emitPierOver(slot, A, s, k) {
        var list = pierOver.at[slot];
        if (list) {
            var K = s / ART.S;
            for (var i = 0; i < list.length; i++) {
                var r = list[i];
                if (!(pierArtOn && pierTexReady(r.tn) && !terrain.hidden[r.tn])) continue;
                var sheet = B + pierAsset(r.tn).sheet, bl = r.art.blocks;
                var fx = r.tx, fy = r.ty + 4;
                var Px = A.a * fx + A.b * fy + A.c, Py = A.d * fx + A.e * fy + A.f;
                for (var j = 0; j < bl.length; j++) {
                    var kb = bl[j], t = subTex(sheet, kb.c[0], kb.c[1], kb.c[2], kb.c[3]);
                    if (!t) continue;
                    var w = kb.c[2] * Math.abs(kb.m[0]), h = kb.c[3] * Math.abs(kb.m[3]);
                    var l = kb.m[0] < 0 ? kb.p[0] - w : kb.p[0];
                    var tp = kb.m[3] < 0 ? kb.p[1] - h : kb.p[1];
                    var x = Px + (l + PIER_NUDGE.x) * K, y = Py + (tp + PIER_NUDGE.y) * K;
                    if (x > VW + 4 || y > VH + 4 || x + w * K < -4 || y + h * K < -4) continue;
                    emitSpr(t, x, y, w * K, h * K, kb.m[0] < 0);
                }
            }
        }
        var re = pierOver.re[slot];
        for (var q = 0; re && q < re.length; q++) {
            var b = re[q];
            if (objHidden[b.cat] || hiddenObjs[b.hkey]) continue;
            if (!(artMode && citySprites && emitBuilding(b, k, A))) emitBlock(b, A, s);
        }
    }

    /* ---- scene pass: buildings + people in ONE depth-ordered pool -----------
       People MERGE into the buildings' painter-order stream instead of always
       drawing after the last block (the old code made every char float over
       every roof, e.g. Dimwillie over the Springfield firehouse). Each
       on-screen char gets an emit index: its position in the blocks'
       pivot-depth order, corrected per the oriented separating-axis test
       against the blocks that can visually touch it (see the grid note in
       buildBuildings) — behind BOTH viewer-facing faces (or standing on the
       lot) sends it under the block, otherwise it stays over. Chars are
       bucketed by emit index and flushed as the block loop passes it. */
    function renderScene(A, s, T, lod) {
        var i, b;
        var art = !!artMode && !!citySprites;
        var k = s / ART.S;
        var nq = 0, chq = null, buck = null;
        peopleDots = 0;
        walkLive = 0;
        dynErrLive = 0;
        if (dynErrG) dynErrG.clear();
        if (!objHidden.people) {
            var ch = M.chars;
            for (i = 0; i < ch.length; i++) {
                var c = ch[i];
                if (c[1] < T.x0 - 1 || c[1] > T.x1 + 1 ||
                    c[2] < T.y0 - 1 || c[2] > T.y1 + 1) continue;
                var cxw = c[1], cyw = c[2];
                var x = A.a * cxw + A.b * cyw + A.c,
                    y = A.d * cxw + A.e * cyw + A.f;
                if (x < -4 || x > VW + 4 || y < -4 || y > VH + 4) continue;
                var u = CAM.oriented(cxw, cyw);
                if (!chq) chq = [];
                /* the walk state rides along so emitChar can pick the stride
                   cell: null when the character is standing (idle art), else
                   the screen-space direction of movement */
                var ws = wanderOn && wander ? wander.get(i) : null;
                if (ws) walkLive++;
                chq.push({ d: u[0] + u[1], u: u[0], v: u[1], c: c, i: i,
                           x: x, y: y,
                           dir: ws ? walkDirOf(ws, A) : null });
            }
            if (chq) {
                chq.sort(function (p, q) { return p.d - q.d || p.u - q.u; });
                nq = chq.length;
                /* Emit index: the scalar pivot-depth position, corrected
                   against the grid candidates whose screen silhouette can
                   actually touch the char sprite (oriented-rect overlap on
                   sy=(u+v), sx=(u-v)). Behind BOTH viewer-facing faces
                   (u < bu1 && v < bv1) — incl. standing on the lot — pulls
                   the emit index down before that block; otherwise the
                   nearest candidate that should sit UNDER the char pushes
                   it up. Conflicts keep the occlusion (hidden wins). */
                var sp = 0;
                for (i = 0; i < nq; i++) {
                    var e = chq[i];
                    while (sp < buildings.length && buildings[sp].depth <= e.d) sp++;
                    var ei = sp, lo = -1, hi = -1, seen = {};
                    for (var gu = Math.floor((e.u - CH_PAD) / CH_CS);
                             gu <= Math.floor((e.u + CH_PAD) / CH_CS); gu++)
                        for (var gv = Math.floor((e.v - CH_PAD) / CH_CS);
                                 gv <= Math.floor((e.v + CH_PAD) / CH_CS); gv++) {
                            var a = charGrid && charGrid[gu + ',' + gv];
                            for (var j = 0; a && j < a.length; j++) {
                                var jj = a[j];
                                if (seen[jj]) continue;
                                seen[jj] = 1;
                                var bb = buildings[jj];
                                if (objHidden[bb.cat] || hiddenObjs[bb.hkey]) continue;
                                if (e.d < bb.bu0 + bb.bv0 - bb.hgt - CH_H ||
                                    e.d - CH_H > bb.bu1 + bb.bv1 ||
                                    e.u - e.v < bb.bu0 - bb.bv1 - CH_W ||
                                    e.u - e.v > bb.bu1 - bb.bv0 + CH_W) continue;
                                if (e.u < bb.bu1 && e.v < bb.bv1) {
                                    if (lo < 0 || jj < lo) lo = jj;
                                } else if (jj > hi) hi = jj;
                            }
                        }
                    if (lo >= 0 && lo < ei) ei = lo;
                    if (hi >= 0 && hi + 1 > ei && !(lo >= 0 && hi >= lo)) ei = hi + 1;
                    if (!buck) buck = [];
                    (buck[ei] || (buck[ei] = [])).push(e);    // d-ordered in
                }                                             // push order
            }
        }
        var artC = !!artMode && !!charMan;
        var kc = k;
        var rpx = Math.max(1.6, CityObjects.PEOPLE_R * Math.min(2.2, s / 40));
        var dotHex = rgbHex(M.charcol);
        /* one character sprite from the dynamic .bcell sheet; false = the
           caller falls through (pre-baked PNG / dot). loop = replay the cell
           back to back (a walking striding cycle) instead of the idle's
           play-once-then-hold. */
        function emitCharDyn(e, as2, loop) {
            if (!as2 || (as2.w * kc < 12 && as2.h * kc < 12)) return false;
            var dv = dynCell(as2);
            if (!dv || dv.st === -1 || (dv.st === 1 && texDead(dv.url)))
                return false;
            if (!dynReady(as2)) return false;
            var mfr = dv.man.frames;
            var di = (charPreview && charPreview.cell === as2)
                     ? charPreviewIdx(as2, mfr)
                     /* both paths hash the character's slot index: once a
                         randomSkin crowd shares 19 skins across dozens
                         of instances, twins must not stride — or
                         blink — in lockstep either */
                      : charFrameIdx(as2, e.c[0] + ':' + e.i,
                                    kc, mfr, loop);
            var df = mfr[di];
            var dim2 = df && dv.man.images[df.image];
            var dt = dim2 && subTex(dv.url, dim2.x, dim2.y, dim2.w, dim2.h);
            if (!dt) return false;
            if (charAnimating(as2, kc, mfr)) charAnimLive++;
            /* as2.mir (from walkPlan): draw the cell flipped about the CHARACTER
               ORIGIN rather than inside its own box — a frame hangs off the
               origin at x_off, so its box [x_off, x_off+w] mirrors to
               [-(x_off+w), -x_off], and emitSpr's mir flag then flips the
               texture within that box. Same rule the walk lab's stage uses
               (translate to the origin, then scale(-1,1)) */
            var wmir = !!as2.mir;
            emitSpr(dt, e.x + (wmir ? -(df.x_off + dim2.w) : df.x_off) * kc,
                    e.y + df.y_off * kc, dim2.w * kc, dim2.h * kc, wmir);
            return true;
        }
        function emitChar(e) {
            if (artC && !lod) {
                /* Walking: the pool's <skin>_front_walk / _back_walk stride
                   cell, chosen by the movement vector AS DRAWN so Rotate and
                   Mirror stay honest. The card's preview cell always wins.
                   No walk cell for this skin, still decoding, or the endpoint
                   switched off → fall through to the idle sprite, which is
                   what the walk's absence must look like (never a red X). */
                var wk = (e.dir && !(charPreview &&
                        String(charPreview.cid) === String(e.c[0])))
                        ? walkArtOf(e.c, e.dir, e.i) : null;
                if (wk && emitCharDyn(e, wk, true)) return;
                var as2 = charArtOf(e.c, e.i);
                if (as2 && !(as2.w * kc < 12 && as2.h * kc < 12)) {
                    var dv = dynCell(as2);
                    if (dv && (dv.st === -1 || (dv.st === 1 && texDead(dv.url)))) {
                        // endpoint said no (or the sheet died): flag the spot
                        // with a red wireframe instead of hiding it behind
                        // pre-baked art — see console for the cell's error
                        dynErrLive++;
                        dynErrBox(e.x, e.y, as2, kc);
                        return;
                    }
                    if (emitCharDyn(e, as2, false)) return;
                    var url = B + 'assets/characters/' +
                        (charPreview && charPreview.cell === as2
                            ? charPreviewFrame(as2)
                            : charFrameFile(as2, e.c[0] + ':' + e.i, kc));
                    if (charAnimating(as2, kc)) charAnimLive++;
                    var t = texFor(url);
                    if (t) { emitSpr(t, e.x - as2.anchor[0] * kc,
                                     e.y - as2.anchor[1] * kc,
                                     as2.w * kc, as2.h * kc); return; }
                }
            }
            emitDot(e.x, e.y, rpx, dotHex);
            peopleDots++;
        }
        function emitBucket(ei) {
            var bk = buck && buck[ei];
            if (!bk) return;
            for (var j = 0; j < bk.length; j++) emitChar(bk[j]);
        }
        if (!lod) {
            renderBridges(A, s, T);           // deck art into bridgeG (under sceneG)
            var mgn = art ? 6 : 2;
            if ((!pierOver || pierOver.recs !== pierRecs || pierOver.spr !== citySprites) &&
                (citySprites || !artMode)) {
                pierOver = derivePierOver();
                pierOver.recs = pierRecs;       // a new ground build or sprite
                pierOver.spr = citySprites;     // manifest re-derives
                DIAG.pierOver = { cells: pierOver.cells, reemit: pierOver.conflicts };
            }
            var po = pierOver && (pierOver.cells ? pierOver : null);
            for (i = 0; i < buildings.length; i++) {
                if (po && i && (po.at[i - 1] || po.re[i - 1])) emitPierOver(i - 1, A, s, k);
                emitBucket(i);
                b = buildings[i];
                if (objHidden[b.cat] || hiddenObjs[b.hkey]) continue;
                if (b.x1 < T.x0 - mgn || b.x0 > T.x1 + mgn ||
                    b.y1 < T.y0 - mgn || b.y0 > T.y1 + mgn) continue;
                if (art && emitBuilding(b, k, A)) continue;
                emitBlock(b, A, s);
            }
            if (po && buildings.length) emitPierOver(buildings.length - 1, A, s, k);
            emitBucket(buildings.length);       // chars nearer than every block
        } else for (i = 0; i < nq; i++) emitChar(chq[i]);
    }
    function emitBlock(b, A, s) {
        var ax0 = A.a * b.x0 + A.b * b.y0 + A.c, ay0 = A.d * b.x0 + A.e * b.y0 + A.f;
        var ax1 = A.a * b.x1 + A.b * b.y0 + A.c, ay1 = A.d * b.x1 + A.e * b.y0 + A.f;
        var ax2 = A.a * b.x1 + A.b * b.y1 + A.c, ay2 = A.d * b.x1 + A.e * b.y1 + A.f;
        var ax3 = A.a * b.x0 + A.b * b.y1 + A.c, ay3 = A.d * b.x0 + A.e * b.y1 + A.f;
        var h = b.hgt * s;
        var mnx = Math.min(ax0, ax1, ax2, ax3), mxx = Math.max(ax0, ax1, ax2, ax3);
        var mny = Math.min(ay0, ay1, ay2, ay3) - h, mxy = Math.max(ay0, ay1, ay2, ay3);
        if (mxx < -4 || mnx > VW + 4 || mxy < -4 || mny > VH + 4) return;
        emitQuad(ax1, ay1 - h, ax2, ay2 - h, ax1, ay1, b.cR);      // right (lit)
        emitQuad(ax2, ay2 - h, ax3, ay3 - h, ax2, ay2, b.cL);      // left (shadow)
        emitQuad(ax0, ay0 - h, ax1, ay1 - h, ax3, ay3 - h, b.cT);  // roof
    }
    /* one building as its city sprite; returns false when the block path
       should draw instead (manifest miss / no asset / below the readability
       gate / PNG not decoded yet). Ported from drawSprite, filmstrip cells
       included. */
    /* ---- road bridges ------------------------------------------------------
       Where a road crosses the river the game keeps the road cells and adds
       its bridgetop deck sections along both sides of the carriageway.
       Neither slug is a building instance (no binfo/instance rows), so
       `gen_city_sprites.py bridges` bakes the frames and this pass derives
       the placements from the saved ground layers at runtime
       (tools/bridge-sites.py is the reference implementation; notes/09 §10):

         * a road is ONE cell of the save's 4x4 lattice wide: a +y (N-S) road
           occupies columns [cx, cx+3] with cx % 4 == 0, a +x (E-W) road rows
           [cy, cy+3] with cy % 4 == 0;
         * the road and water layers are independent occupancy sets, so a
           crossing is water UNDER the deck: the water band is the corridor
           rows/columns the water layer covers across the FULL 4-tile
           corridor. That single test is what drops the shoreline quays —
           water runs beside those, never under them;
         * the water must actually be CROSSED, not just touched: the fully-road
           run has to extend past the water band at BOTH ends (7 of the 11 raw
           candidates are one real crossing read on the other axis);
         * ONE section per road cell the band covers, per row. Each section is
           a 3-lamppost bridgetop frame (C_BridgeTop_08: arches, deck line,
           balustrade, piers into the water); consecutive sections butt-join
           4 tiles apart, so the game shows DOUBLED lampposts at every join
           (110 px globe pitch inside a section, 2 x 110 + 36 = 256 px = 4
           tiles per section). Measured 2026-10-27 by globe detection on the
           game screenshot registered against the viewer: site A 12 globes and
           site B 12 globes all within 0.1 tile of this rule. (The previous
           model stepped overlapping pieces by one globe pitch — evenly spaced
           lampposts, which the game never shows.);
         * the two rows sit on the same along position; the row nearer the
           viewer is drawn OVER the road art (its lampposts and rail cover the
           kerb), the far row UNDER it (the kerb covers its base and its arches
           hang under the carriageway): far row into `bridgeG`, the crossing
           cells' road art reparented into `raisedG` (a tile-space twin of
           groundC), near row into `bridgeNearG` above that.

       Anchors are terrain-anchored decals like the water art: no ART.ax/ay
       nudge (those correct the building art's own ground point). */
    var BRIDGE_KEY = 'mrsnrub.cityview.bridges';
    var bridgesOn = true;                   // ships ON: the game bridges every wide crossing
    try { if (localStorage.getItem(BRIDGE_KEY) === '0') bridgesOn = false; } catch (e) { /* private mode */ }
    var BRIDGE_MIN_SPAN = 4;                // water must at least be as wide as
                                            // the road itself: 11 raw candidates,
                                            // the 7 rejects are all the same
                                            // crossing read on the other axis
                                            // (dropped by the bank test below)
    /* per-cell placement: the section's pivot sits on the cell's far edge
       along the road (y = cy + 4 for a +y road — the bridgetop footprint is
       2 x 4 with its pivot on the max-y corner like every building). Rows
       sit BRIDGE_ROW / +BRIDGE_ROW_SEP off the corridor's west edge; a +x
       corridor is the mirror image about the cell, (a, b) -> (4 - b, 4 - a):
       pivot on the cell's min-x edge, rows at cy + 4 - BRIDGE_ROW -
       r * BRIDGE_ROW_SEP (= cy + 4.6 / cy + 0.1, the old B fit exactly). */
    var BRIDGE_ROW = -0.6;                  // near row pivot off the west edge
    var BRIDGE_ROW_SEP = 4.5;               // far row 4.5 further (A, B, D fits)
    var BRIDGE_ALONG = 0;                   // pivot nudge along the deck
    var BRIDGE_TOP_DEEP = 'bridgetop_f4';   // C_BridgeTop_08: piers into the water
    var BRIDGE_TOP_BANK = 'bridgetop_f2';   // + C_Grass_04 at the tail: deck on the bank
    var BRIDGE_TOP_FILLET = 'bridgetop_f6'; // + C_Grass_03 at the head (dry deck)
    var BRIDGE_TOP_BOTH = 'bridgetop_f3';   // both grasses: the whole bridge is one piece
    var BRIDGE_GRASS_ENDS = false;          // grass-abutment frames on the end
                                            // sections: off — the export's bank
                                            // ends show the plain deep deck
    var bridgeSegs = null;                  // derived once, on first draw
    var bridgeCells = null;                 // 'tx,ty' -> 1 for the road cells
                                            // over water (+ one past each
                                            // end): their art is raised
                                            // above the bridge container
    var bridgeLive = 0;                     // DIAG: pieces emitted last frame

    function bridgeOcc() {
        /* tile occupancy ('x,y' -> 1) of the layers the rule reads, from the
           decoded cell records CityTerrain already keeps (4x4 tiles at
           multiples of 4; pts layers are single legacy tiles) */
        var road = {}, water = {}, TO = CityTerrain.TYPE_ORDER;
        for (var li = 0; li < terrain._raw.length; li++) {
            var R = terrain._raw[li], nm = TO[R.ti];
            var t = nm === 'road' ? road
                : (nm === 'river' || nm === 'ocean') ? water : null;
            if (!t) continue;
            var i, dx, dy;
            if (R.cells) {
                for (i = 0; i < R.cells.length; i++)
                    for (dy = 0; dy < 4; dy++)
                        for (dx = 0; dx < 4; dx++)
                            t[(R.cells[i].x + dx) + ',' + (R.cells[i].y + dy)] = 1;
            } else if (R.pts) {
                for (i = 0; i < R.pts.length; i += 2) t[R.pts[i] + ',' + R.pts[i + 1]] = 1;
            }
        }
        return { road: road, water: water };
    }

    function occRuns(occ, key) {
        /* maximal consecutive runs of an int list, as [a, b] pairs */
        var out = [], a = null, b = null;
        for (var i = 0; i < occ.length; i++) {
            var v = occ[i];
            if (a === null) { a = b = v; }
            else if (v === b + 1) { b = v; }
            else { out.push([a, b]); a = b = v; }
        }
        if (a !== null) out.push([a, b]);
        return out;
    }

    function bridgeRun(out, axis, c, wa, wb) {
        /* one crossing: `c` is the corridor's west edge (+y) or north edge
           (+x), wa..wb the water rows (+y) or columns (+x) under the deck.
           One section per 4x4 road cell the band covers, per row; the end
           sections may carry the grass-abutment frames */
        var c0 = wa & ~3, c1 = wb & ~3;
        for (var cc = c0; cc <= c1; cc += 4) {
            var top = BRIDGE_TOP_DEEP;
            if (BRIDGE_GRASS_ENDS) {
                /* +y: the tail (C_Grass_04) is the low-y end; +x mirrors it
                   to the high-x end */
                var tail = axis === 'y' ? cc === c0 : cc === c1;
                var head = axis === 'y' ? cc === c1 : cc === c0;
                top = tail && head ? BRIDGE_TOP_BOTH : tail ? BRIDGE_TOP_BANK
                    : head ? BRIDGE_TOP_FILLET : BRIDGE_TOP_DEEP;
            }
            var pair = [];
            for (var r = 0; r < 2; r++) {
                var off = BRIDGE_ROW + r * BRIDGE_ROW_SEP;
                pair.push(axis === 'y'
                    ? { x: c + off, y: cc + 4 + BRIDGE_ALONG, mir: 0, top: top, row: r, i: cc }
                    : { x: cc - BRIDGE_ALONG, y: c + 4 - off, mir: 1, top: top, row: r, i: cc });
            }
            pair[0].mate = pair[1]; pair[1].mate = pair[0];
            out.push(pair[0], pair[1]);
        }
    }

    function deriveBridges() {
        var o = bridgeOcc(), road = o.road, water = o.water;
        var k, pp, x, y, i, j, out = [];
        bridgeCells = {};
        var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (k in road) {
            if (!road.hasOwnProperty(k)) continue;
            pp = k.split(','); x = +pp[0]; y = +pp[1];
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
        if (!isFinite(x0)) return [];
        var CELL = 4;
        function allRoad(cols, rows) {          // every tile of the patch is road
            for (var a = 0; a < cols.length; a++)
                for (var b2 = 0; b2 < rows.length; b2++)
                    if (!road[cols[a] + ',' + rows[b2]]) return false;
            return true;
        }
        function allWater(cols, rows) {         // ... and the same for water
            for (var a = 0; a < cols.length; a++)
                for (var b2 = 0; b2 < rows.length; b2++)
                    if (!water[cols[a] + ',' + rows[b2]]) return false;
            return true;
        }
        /* +y corridors: cell-aligned column groups, rows fully road */
        for (var cx = x0 - (x0 % CELL); cx <= x1; cx += CELL) {
            var cols = [cx, cx + 1, cx + 2, cx + 3];
            var rr = [];
            for (y = y0; y <= y1; y++) if (allRoad(cols, [y])) rr.push(y);
            var runs = occRuns(rr);
            for (i = 0; i < runs.length; i++) {
                if (runs[i][1] - runs[i][0] + 1 < CELL) continue;
                var a0 = runs[i][0], a1 = runs[i][1], band = [];
                /* the road and water layers are independent occupancy sets, so
                   a crossing reads as water UNDER the deck tiles. Testing the
                   whole corridor (not the columns beside it) is what drops the
                   shoreline quays: water runs next to those, never under them */
                for (y = a0; y <= a1; y++) if (allWater(cols, [y])) band.push(y);
                var br = occRuns(band);
                for (j = 0; j < br.length; j++) {
                    var wa = br[j][0], wb = br[j][1], span = wb - wa + 1;
                    if (span < BRIDGE_MIN_SPAN) continue;
                    /* the road must reach both banks: a band that IS the whole
                       road run is a road end on the water, or the same crossing
                       read on the other axis (where the "corridor" is only the
                       crossing patch itself) */
                    if (a0 >= wa || a1 <= wb) continue;
                    bridgeRun(out, 'y', cx, wa, wb);
                    /* + the road cell past each end: the far row's end
                       section (the grass abutments most of all) reaches a
                       few px over that boundary and must tuck under the
                       road art there too, not paint over it */
                    for (var wy = (wa & ~3) - 4; wy <= (wb & ~3) + 4; wy += 4)
                        bridgeCells[(cx & ~3) + ',' + wy] = 1;
                }
            }
        }
        /* +x corridors: cell-aligned row groups, columns fully road */
        for (var cy = y0 - (y0 % CELL); cy <= y1; cy += CELL) {
            var rows = [cy, cy + 1, cy + 2, cy + 3];
            var rc = [];
            for (x = x0; x <= x1; x++) if (allRoad([x], rows)) rc.push(x);
            var runs2 = occRuns(rc);
            for (i = 0; i < runs2.length; i++) {
                if (runs2[i][1] - runs2[i][0] + 1 < CELL) continue;
                var b0 = runs2[i][0], b1 = runs2[i][1], band2 = [];
                for (x = b0; x <= b1; x++) if (allWater([x], rows)) band2.push(x);
                var br2 = occRuns(band2);
                for (j = 0; j < br2.length; j++) {
                    var xa = br2[j][0], xb = br2[j][1], span2 = xb - xa + 1;
                    if (span2 < BRIDGE_MIN_SPAN) continue;
                    if (b0 >= xa || b1 <= xb) continue;   // both banks, as above
                    bridgeRun(out, 'x', cy, xa, xb);
                    for (var wx = (xa & ~3) - 4; wx <= (xb & ~3) + 4; wx += 4)
                        bridgeCells[wx + ',' + (cy & ~3)] = 1;   // + end cells
                }
            }
        }
        /* painter's order: the nearer piece of a row (and the nearer row) must
           be emitted last, so the deck's overlapping sections shade each other
           the way the engine's own draw order does */
        out.sort(function (p, q) { return (p.x + p.y) - (q.x + q.y); });
        return out;
    }

    function bridgePiece(key, px, py, k, mir, ly) {
        var sp = spriteEntry(key);
        if (!sp || (sp.w * k < 12 && sp.h * k < 12)) return;
        var t = texFor(cityUrl(sp.png));
        if (!t) return;
        /* screen-space billboard (same convention as emitBuilding's mirrored
           twin in sceneG): bl lands the (mirrored) anchor on the placement
           point, emitBridgeSpr mirrors the texture within [bl, bl+w] */
        var bl = px - (mir ? sp.w - sp.anchor[0] : sp.anchor[0]) * k;
        emitBridgeSpr(t, bl, py - sp.anchor[1] * k, sp.w * k, sp.h * k, mir, ly);
        bridgeLive++;
    }

    function bridgeList() {
        if (!bridgeSegs) {
            bridgeSegs = deriveBridges();
            /* the rule derives after the first draw, i.e. after buildGround:
               raise the crossing cells' road art now (fresh builds raise at
               creation time instead) */
            for (var i = 0; i < sheetRecs.length; i++) {
                var r = sheetRecs[i];
                if (bridgeCells[r.tx + ',' + r.ty])
                    raiseRoadCell(r.sheets, r.spec, r.manh);
            }
        }
        return bridgeSegs;
    }

    function renderBridges(A, s, T) {
        bridgeLive = 0;
        bpns[0] = bpns[1] = 0;
        if (!bridgesOn || !artMode || !citySprites || terrain.hidden['road'] ||
            !bridgeG) {
            bridgeHideRest();
            return;
        }
        var segs = bridgeList(), k = s / ART.S;
        for (var i = 0; i < segs.length; i++) {
            var g = segs[i];
            if (g.x < T.x0 - 6 || g.x > T.x1 + 6 || g.y < T.y0 - 6 || g.y > T.y1 + 6)
                continue;
            var px = A.a * g.x + A.b * g.y + A.c, py = A.d * g.x + A.e * g.y + A.f;
            /* the row nearer the viewer (lower on screen than its mate, so
               any Rotate/Mirror orientation) stands OVER the raised road art,
               its mate under it — the game's layering at site A: the near
               row's lampposts and rail cover the kerb, the far row's base
               is covered by it */
            var mpy = A.d * g.mate.x + A.e * g.mate.y + A.f;
            var near = py > mpy;
            bridgePiece(g.top, px, py, k, g.mir, near ? 1 : 0);
        }
        bridgeHideRest();
    }
    function applyBridgeMode() {
        var b = $('btn-bridges');
        if (b) b.classList.toggle('on', bridgesOn);
    }
    window.__CV_BRIDGES = function (patch) {          // smoke-test / console probe
        if (patch) {                                  // {on, minSpan, grassEnds, row, rowSep, along, recalc}
            if ('on' in patch) bridgesOn = !!patch.on;
            if ('minSpan' in patch) { BRIDGE_MIN_SPAN = patch.minSpan; bridgeSegs = null; }
            if ('row' in patch) { BRIDGE_ROW = patch.row; bridgeSegs = null; }
            if ('rowSep' in patch) { BRIDGE_ROW_SEP = patch.rowSep; bridgeSegs = null; }
            if ('along' in patch) { BRIDGE_ALONG = patch.along; bridgeSegs = null; }
            if ('grassEnds' in patch) {
                BRIDGE_GRASS_ENDS = !!patch.grassEnds; bridgeSegs = null;
                var gb = $('btn-bridgegrass');
                if (gb) gb.classList.toggle('on', BRIDGE_GRASS_ENDS);
            }
            if (patch.recalc) bridgeSegs = null;
        }
        return { segs: bridgeList().length, live: bridgeLive, on: bridgesOn,
                 minSpan: BRIDGE_MIN_SPAN, row: BRIDGE_ROW, rowSep: BRIDGE_ROW_SEP,
                 along: BRIDGE_ALONG,
                 grassEnds: BRIDGE_GRASS_ENDS };
    };

    function emitBuilding(b, k, A) {
        if (!b.slug) return false;
        var twin = !!(b.flip && citySprites && citySprites[b.slug + 'flipped']);
        var key = twin ? b.slug + 'flipped' : b.slug;
        /* flipState-1 (mirror) but the mirrored twin art never shipped
           (e.g. GoldenBuddha, AngelFossil, Flowers02): the engine still
           places the instance with the twin's semantics — swapped
           footprint/loc (dims_for) and the mirrored art anchored at
           (w-ax, ay) about the position point, exactly what the shipped
           pixel-mirrored twins do.  Mirror the base PNG in place about
           that twin-equivalent rect: bl below uses the mirrored anchor,
           emitSpr's negative scale mirrors within [bl, bl+w]. */
        var mir = !!(b.flip === 1 && !twin);
        var pole = key === POLE_SLUG;       // gets the nation cloth on top
        var sp = spriteEntry(key);
        if (!sp) return false;
        if (sp.w * k < 12 && sp.h * k < 12) return false;   // readability gate
        if (DINV_WAIT && (dynC.sprites || dynC.seasons || dynC.anims || dynC.stacks))
            return false;    /* preflight unsettled: draw blocks this tick
                                rather than fire pre-baked requests that the
                                inventory would flip to endpoint URLs a
                                moment later (the double-fetch the network
                                panel read as "exoticpond still loading .png") */
        var gx = ART.ref === 'origin' ? b.x0 : b.px;
        var gy = ART.ref === 'origin' ? b.y0 : b.py;
        var wx = gx + ART.ax, wy = gy + ART.ay;
        var px = A.a * wx + A.b * wy + A.c;
        var py = A.d * wx + A.e * wy + A.f;
        var bl = px - (mir ? sp.w - sp.anchor[0] : sp.anchor[0]) * k;
        /* ask the window before the file (see artReachable): the tile ring
           that got us here is drawn for painting, not for requesting */
        if (!artReachable(sp, px, py, bl, k, key)) return true;
        var url = cityUrl(sp.png);
        var baseTex = texFor(url);
        if (!baseTex && url !== preUrl(sp.png) && texDead(url)) {
            /* the endpoint refused this body: seasons quietly keep their
               shipped file (the building still draws), plain bodies get
               the red wireframe like dead character cells */
            if (sp.png.indexOf('seasons/') === 0) {
                cityFail('season', sp.png);
                baseTex = texFor(preUrl(sp.png));
            } else {
                cityBox(stemOfCity(sp.png), sp, px, py, k, 'endpoint failed');
                return false;
            }
        }
        if (!baseTex) {
            if (DINV && dynCon('sprites') && sp.png.indexOf('seasons/') !== 0 &&
                    sp.png.indexOf('/') < 0 && !(DINV.inv[stemOfCity(sp.png)] & 1))
                cityBox(stemOfCity(sp.png), sp, px, py, k, 'not in source pool');
            return false;
        }
        var an = animOf(b, k);            // filmstrip cells instead of the PNG?
        if (an) {
            var drew = 0, i, j, ok = 1, vis = 0, cov = 0;
            // the no-twin flip stand-in draws its strips mirrored about the
            // pin column, exactly as it mirrors the body PNG below: cell
            // [x, x+w] lands at [2*px-x-w, 2*px-x] with the texture flipped
            var m2 = mir ? 2 * px : 0;
            // a layer cell may legitimately be as big as the body it hides
            var cap = an.base ? Math.max(4096, Math.max(sp.w, sp.h) * k) : 2048;
            for (i = 0; i < an.cells.length; i++) {
                var c0 = an.cells[i], st = c0.a;
                if (!cellOnScreen(st, c0.fi, px, py, k, mir)) continue;
                vis = 1;
                if (!animAtlasFor(st, c0.tap) ||
                    Math.max(st.cellw, st.cellh) * k > cap) {
                    if (an.base) ok = 0;  // stack must draw whole, or not at all
                } else if (st.nc && st.sub && (st.sub[c0.fi] || []).length) {
                    // self-contained sparse strip: the generator measured
                    // its frames against the body PNG and confirmed they
                    // re-blit the whole scene, so the flattened body under
                    // one only re-exposes the stale Neutral pose — the top
                    // loop's balloon moved, the body's frozen one peeked
                    // out from under it (privateisland05, 2026-10-30).
                    // Draw the cells alone. An overlay strip (a thin spray
                    // layer) never carries the flag, so it keeps the body.
                    cov = 1;
                }
            }
            var bodyVis = !(bl + sp.w * k < -4 || bl > VW + 4 ||
                            (py - sp.anchor[1] * k) + sp.h * k < -4 ||
                            (py - sp.anchor[1] * k) > VH + 4);
            if (ok && (vis || bodyVis)) {
                if (an.base && bodyVis && !cov) {   // multi-part body: PNG under the cells
                    emitSpr(baseTex, bl, py - sp.anchor[1] * k,
                            sp.w * k, sp.h * k, mir);
                    drew = 1;
                }
                for (i = 0; i < an.cells.length; i++) {
                    var c = an.cells[i], a = c.a, fi = c.fi;
                    if (!cellOnScreen(a, fi, px, py, k, mir)) continue;
                    if (!animAtlasFor(a, c.tap)) continue;   // decoding / no slot
                    if (a.sub) {                      // sparse strip: blit its rects
                        var rs = a.sub[fi] || [];
                        for (j = 0; j < rs.length; j++) {
                            var r = rs[j], rw = r.w * k, rh = r.h * k;
                            var rx = mir ? m2 - px - r.ox * k - rw
                                         : px + r.ox * k;
                            var ry = py + r.oy * k;
                            if (rx + rw < -4 || rx > VW + 4 ||
                                ry + rh < -4 || ry > VH + 4) continue;
                            var rt = subTex(animUrlFor(a),
                                            r.sx, r.sy, r.w, r.h);
                            if (!rt) continue;
                            emitSpr(rt, rx, ry, rw, rh, mir);
                            drew++;
                        }
                        continue;
                    }
                    var aw = a.cellw * k, ah = a.cellh * k;
                    var ax0 = mir ? m2 - (px - a.ax * k) - aw : px - a.ax * k;
                    var ay0 = py - a.ay * k;
                    if (ax0 + aw < -4 || ax0 > VW + 4 || ay0 + ah < -4 || ay0 > VH + 4)
                        continue;         // truly off-screen: skip
                    var ct = subTex(animUrlFor(a),
                                    (fi % a.cols) * a.cellw,
                                    Math.floor(fi / a.cols) * a.cellh,
                                    a.cellw, a.cellh);
                    if (!ct) continue;
                    emitSpr(ct, ax0, ay0, aw, ah, mir);
                    drew++;
                }
            }
            if (drew) { animLive++; if (!an.tap) animBudget--;
                    // the repaint throttle runs at the frame's fastest strip,
                    // not at the 12 fps constant: a strip the generator put
                    // back on a town cadence turns a cell every 3 ticks
                    // (41.7 ms at the default rate) and a 45 ms repaint would
                    // skip a third of them — the fix would be invisible
                    for (i = 0; i < an.cells.length; i++) {
                        var tm = 1000 / (an.cells[i].fps || 12);
                        if (tm < animTickMs) animTickMs = tm;
                    }
                    if (pole) emitFlagCloth(b, px, py, k, sp.anchor[0], sp.anchor[1]);
                    return true; }
            // nothing blitted (decoding / off-screen / stack rejected): keep the
            // anim tick alive while the atlas is still in flight so this retries
            // the moment it lands (the clock-driven tap expires on its own
            // meanwhile); a strip refused for lack of a cache slot does not
            // hold the page rendering, it retries on the next real frame
            if (vis && animDecoding(an)) animPending = 1;
        }
        /* Oversized part stacks (the sea fleet above all) can never blit
           their strips on the map — a 24 Mpx hull filmstrip is over the
           decode cap, and the stack draws whole or not at all. For those
           the plain body PNG is NOT the whole object: AircraftCarrier's
           hull sides and wake live only in its oversized Neutral_Base
           strip. The generator bakes body + every over-cap layer's cell 0
           into `stack`; draw it in place of the body once decoded (the
           normal body until then). Never touches the animating path. */
        var st = sp, stex = baseTex;
        if (sp.stack) {
            var st2 = cityTex(sp.stack.png, 'stack');
            if (st2) { st = sp.stack; stex = st2; }
        }
        emitSpr(stex, px - (mir ? st.w - st.anchor[0] : st.anchor[0]) * k,
                py - st.anchor[1] * k, st.w * k, st.h * k, mir);
        /* Flag_Pole ships the pole only: composite this bid's nation cloth
           (city-flags.json) at the same ground pin — proven against the
           shipped pole anchor in mapdump/registration/m4-flag-overlay-* */
        if (pole && !mir) emitFlagCloth(b, px, py, k, st.anchor[0], st.anchor[1]);
        return true;
    }

    /* ---- ground-level debug overlays (under the buildings) ------------------ */
    function quadPts(gs, T, x, y, big, ox, oy) {
        /* tile-space rect [x,x+big)×[y,y+big) as a closed poly — the ground
           container's matrix turns it into the oblique diamond */
        big = big || 1; ox = ox || 0; oy = oy || 0;
        gs.poly([x + ox, y + oy, x + big + ox, y + oy,
                 x + big + ox, y + big + oy, x + ox, y + big + oy], true);
    }
    var fragCache = null, fragTerrain = null;
    function drawFrags(T) {
        fragG.clear();
        if (!terrain.debugFrags) return;
        if (fragTerrain !== terrain) { fragCache = null; fragTerrain = terrain; }
        if (!fragCache) {
            var occF = terrain._roadOccAll, cells = [], k;
            for (k in occF) {
                if (!occF.hasOwnProperty(k)) continue;
                var pp = k.split(','), fx = +pp[0], fy = +pp[1];
                if (!occF[(fx - 1) + ',' + fy] && !occF[(fx + 1) + ',' + fy] &&
                    (occF[fx + ',' + (fy - 1)] || occF[fx + ',' + (fy + 1)])) {
                    cells.push([fx, fy]);
                }
            }
            fragCache = cells;
        }
        var i, gc;
        var pts = [];
        for (i = 0; i < fragCache.length; i++) {
            gc = fragCache[i];
            if (gc[0] < T.x0 || gc[0] > T.x1 || gc[1] < T.y0 || gc[1] > T.y1) continue;
            pts.push(gc[0], gc[1], gc[0] + 1, gc[1], gc[0] + 1, gc[1] + 1, gc[0], gc[1] + 1);
        }
        if (!pts.length) return;
        for (i = 0; i < pts.length; i += 8)
            fragG.poly(pts.slice(i, i + 8), true);
        fragG.fill({ color: 0xff00ff, alpha: 0.55 });
    }
    function drawProposed(T) {
        propG.clear();
        if (!terrain.showProposed) return;
        var PS = CityTerrain.PROPOSED.streets;
        var hov = terrain.hoverProposed, hovFound = null;
        for (var ph = 0; ph < 2; ph++) {
            for (var pi = 0; pi < PS.length; pi++) {
                var st = PS[pi];
                var isHov = hov != null && st.id === hov;
                if (isHov) hovFound = 1;
                if (ph === 0 ? isHov : !isHov) continue;
                var sx0 = st.x0 - terrain.ox, sx1 = st.x1 - terrain.ox,
                    sy0 = st.ylo - terrain.oy, sy1 = st.yhi - terrain.oy;
                if (sx1 < T.x0 || sx0 > T.x1 || sy1 < T.y0 || sy0 > T.y1) continue;
                var pv = CityTerrain.PROPOSED.verdicts[st.id];
                var fill = isHov ? { color: 0xffd60a, alpha: 0.80 } :
                    hov != null ? { color: 0x9696aa, alpha: 0.18 } :
                        pv === 'ok' ? { color: 0x46dc78, alpha: 0.50 } :
                            pv === 'bad' ? { color: 0xe64646, alpha: 0.35 } :
                                { color: 0x00c8ff, alpha: 0.45 };
                var qx0 = Math.max(sx0, T.x0), qx1 = Math.min(sx1, T.x1),
                    qy0 = Math.max(sy0, T.y0), qy1 = Math.min(sy1, T.y1);
                for (var qy = qy0; qy <= qy1; qy++)
                    for (var qx = qx0; qx <= qx1; qx++) {
                        propG.poly([qx, qy, qx + 1, qy, qx + 1, qy + 1, qx, qy + 1], true);
                        propG.fill(fill);
                        if (isHov) propG.stroke({ width: 1 / Math.max(1, CAM.scale(cam)),
                                                 color: 0x0f0f16, alpha: 0.9 });
                    }
            }
            if (ph === 0 && !hovFound) break;    // hover id not on list
        }
    }

    /* ---- overlays above the scene (ported Canvas2D draw calls) -------------- */
    function drawWalks(T) {
        walkG.clear();
        if (!walksOn || !M.walks || typeof CityWalks === 'undefined') return;
        var A = CAM.tileAffine(cam, VW, VH);
        function tp(x, y) { return [A.a * x + A.b * y + A.c, A.d * x + A.e * y + A.f]; }
        var i, j, w, hit, pts;
        for (i = 0; i < M.walks.length; i++) {
            w = M.walks[i];
            hit = false;
            for (j = 0; j < w.length; j += 2)
                if (w[j] >= T.x0 - 2 && w[j] <= T.x1 + 2 &&
                    w[j + 1] >= T.y0 - 2 && w[j + 1] <= T.y1 + 2) { hit = true; break; }
            if (!hit) continue;
            pts = [];
            for (j = 0; j < w.length; j += 2) {
                var p = tp(w[j] + 0.5, w[j + 1] + 0.5);
                pts.push(p[0], p[1]);
            }
            walkG.poly(pts, false).stroke({ width: 1.5, color: 0x00e5ff, alpha: 0.55 });
        }
        var cand = walkCensus;
        if (!cand) return;
        for (i = 0; i < cand.cols.length; i++) {
            var c = cand.cols[i];
            candQuad(c.x - 0.5, c.y0 - 0.5, 1, c.y1 - c.y0 + 1);
        }
        for (i = 0; i < cand.rows.length; i++) {
            var r = cand.rows[i];
            candQuad(r.x0 - 0.5, r.y - 0.5, r.x1 - r.x0 + 1, 1);
        }
        function candQuad(x, y, wd, ht) {
            var a = tp(x, y), b = tp(x + wd, y), d = tp(x + wd, y + ht), e = tp(x, y + ht);
            walkG.poly([a[0], a[1], b[0], b[1], d[0], d[1], e[0], e[1]], true)
                .fill({ color: 0xffd60a, alpha: 0.14 })
                .stroke({ width: 1, color: 0xffd60a, alpha: 0.55 });
        }
    }
    function drawGrid(A, s, T) {
        gridG.clear(); txtGrid.begin();
        if (!gridOn || s < 0.6) { txtGrid.end(); return; }   // sub-pixel lattice
        var x0 = Math.floor(T.x0) - 1, x1 = Math.ceil(T.x1) + 2;
        var y0 = Math.floor(T.y0) - 1, y1 = Math.ceil(T.y1) + 2;
        var minors = s >= 12;
        function P(x, y) { return [A.a * x + A.b * y + A.c, A.d * x + A.e * y + A.f]; }
        var x, y, major, pts;
        function lineTo(pts, xa, ya, xb, yb) {
            var a = P(xa, ya), b = P(xb, yb);
            pts.push(a[0], a[1], b[0], b[1]);
        }
        var maj = [], min = [];
        for (x = x0; x <= x1; x++) {
            major = ((x % 10) + 10) % 10 === 0;
            if (!major && !minors) continue;
            lineTo(major ? maj : min, x, y0, x, y1);
        }
        for (y = y0; y <= y1; y++) {
            major = ((y % 10) + 10) % 10 === 0;
            if (!major && !minors) continue;
            lineTo(major ? maj : min, x0, y, x1, y);
        }
        for (x = 0; x < maj.length; x += 4)
            gridG.moveTo(maj[x], maj[x + 1]).lineTo(maj[x + 2], maj[x + 3]);
        gridG.stroke({ width: 1, color: 0x00e5ff, alpha: 0.75 });
        for (x = 0; x < min.length; x += 4)
            gridG.moveTo(min[x], min[x + 1]).lineTo(min[x + 2], min[x + 3]);
        gridG.stroke({ width: 1, color: 0x00e5ff, alpha: 0.28 });
        if (s >= 40) {                                // major-line numbering
            for (x = x0; x <= x1; x++)
                if (((x % 10) + 10) % 10 === 0) { var p = P(x, y0); txtGrid.put(String(x), p[0] + 2, p[1] - 12); }
            for (y = y0; y <= y1; y++)
                if (((y % 10) + 10) % 10 === 0) { var q = P(x0, y); txtGrid.put(String(y), q[0] + 2, q[1] - 12); }
        }
        if (hoverTile) {                              // cursor tile diamond
            var a = P(hoverTile[0], hoverTile[1]), b = P(hoverTile[0] + 1, hoverTile[1]),
                c = P(hoverTile[0] + 1, hoverTile[1] + 1), d = P(hoverTile[0], hoverTile[1] + 1);
            gridG.poly([a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1]], true)
                .fill({ color: 0x00e5ff, alpha: 0.22 })
                .stroke({ width: 1.5, color: 0x00e5ff, alpha: 0.95 });
        }
        txtGrid.end();
    }
    function drawMarkers(T) {
        markG.clear(); txtMark.begin();
        if (!markerPts.length || typeof CityMarkers === 'undefined') { txtMark.end(); return; }
        var A = CAM.tileAffine(cam, VW, VH);
        function P(x, y) { return [A.a * x + A.b * y + A.c, A.d * x + A.e * y + A.f]; }
        for (var i = 0; i < markerPts.length; i++) {
            var x = markerPts[i][0], y = markerPts[i][1];
            if (x + 1 < T.x0 || x > T.x1 || y + 1 < T.y0 || y > T.y1) continue;
            var a = P(x, y), b = P(x + 1, y), c = P(x + 1, y + 1), d = P(x, y + 1);
            markG.poly([a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1]], true)
                .fill({ color: 0xf4d03f, alpha: 0.35 })
                .stroke({ width: 1.5, color: 0xf4d03f });
            var q = P(x + 0.5, y + 0.5);
            markG.moveTo(q[0] - 4, q[1]).lineTo(q[0] + 4, q[1]);
            markG.moveTo(q[0], q[1] - 4).lineTo(q[0], q[1] + 4);
            markG.stroke({ width: 1.5, color: 0xf4d03f });
            txtMark.put(x + ',' + y, q[0] + 7, q[1] - 14);
        }
        txtMark.end();
    }
    function strokePts(gs, pts, hex, w, alpha) {
        var arr = [];
        for (var i = 0; i < pts.length; i++) arr.push(pts[i].x, pts[i].y);
        gs.poly(arr, true).stroke({ width: w, color: hex, alpha: alpha });
    }
    function drawOutlines() {
        outG.clear();
        if (wireOn) {                       // full 12-edge prism wireframe
            var s = CAM.scale(cam);
            var A = CAM.tileAffine(cam, VW, VH);
            function P(x, y) { return [A.a * x + A.b * y + A.c, A.d * x + A.e * y + A.f]; }
            for (var wi = 0; wi < buildings.length; wi++) {
                var wb = buildings[wi];
                if (objHidden[wb.cat] || hiddenObjs[wb.hkey]) continue;
                if (wb.x1 < 0 || wb.x0 > 0) { /* cull below via screen box */ }
                var g0 = P(wb.x0, wb.y0), g1 = P(wb.x1, wb.y0),
                    g2 = P(wb.x1, wb.y1), g3 = P(wb.x0, wb.y1);
                var mnx = Math.min(g0[0], g1[0], g2[0], g3[0]),
                    mxx = Math.max(g0[0], g1[0], g2[0], g3[0]),
                    mny = Math.min(g0[1], g1[1], g2[1], g3[1]) - wb.hgt * s,
                    mxy = Math.max(g0[1], g1[1], g2[1], g3[1]);
                if (mxx < -4 || mnx > VW + 4 || mxy < -4 || mny > VH + 4) continue;
                var h = wb.hgt * s;
                var t0 = [g0[0], g0[1] - h], t1 = [g1[0], g1[1] - h],
                    t2 = [g2[0], g2[1] - h], t3 = [g3[0], g3[1] - h];
                g0 = [g0[0], g0[1]]; g1 = [g1[0], g1[1]];
                g2 = [g2[0], g2[1]]; g3 = [g3[0], g3[1]];
                outG.poly([g0[0], g0[1], g1[0], g1[1], g2[0], g2[1], g3[0], g3[1]], true)
                    .stroke({ width: 1, color: 0x00e5ff, alpha: 0.9 });     // ground edges
                outG.poly([t0[0], t0[1], t1[0], t1[1], t2[0], t2[1], t3[0], t3[1]], true)
                    .stroke({ width: 1, color: 0xffffff, alpha: 0.55 });    // top rim
                outG.moveTo(g0[0], g0[1]).lineTo(t0[0], t0[1]);
                outG.moveTo(g1[0], g1[1]).lineTo(t1[0], t1[1]);
                outG.moveTo(g2[0], g2[1]).lineTo(t2[0], t2[1]);
                outG.moveTo(g3[0], g3[1]).lineTo(t3[0], t3[1]);
                outG.stroke({ width: 1, color: 0xffffff, alpha: 0.55 });    // verticals
            }
        }
        var i, m, b;
        for (i = 0; i < Math.min(searchMatches.length, MATCH_DRAW_CAP); i++) {
            m = searchMatches[i];
            if (m.kind === 'b') {
                b = byMi[m.i];
                if (objHidden[b.cat]) continue;
                // NB: hidden instances DO outline — search is how you find
                // one again to unhide it (the card's toggle brings it back)
                strokePts(outG, blockPolys(b).top, 0x6aa9d9, 2, 0.9);
            } else if (!objHidden.people) {
                var p = charScreen(M.chars[m.i]);
                outG.circle(p.x, p.y, p.r + 3).stroke({ width: 2, color: 0x6aa9d9, alpha: 0.9 });
            }
        }
        if (selected) {
            if (selected.kind === 'b') {
                b = byMi[selected.i];
                var q = blockPolys(b);
                strokePts(outG, q.top, 0xf4d03f, 2.5, 1);
                strokePts(outG, q.right, 0xf4d03f, 2.5, 1);
                strokePts(outG, q.left, 0xf4d03f, 2.5, 1);
            } else if (selected.kind === 'c') {
                var c = charScreen(M.chars[selected.i]);
                outG.circle(c.x, c.y, c.r + 3).stroke({ width: 2.5, color: 0xf4d03f });
            } else {
                var quad = terrain.quad(cam, VW, VH, selected.x, selected.y);
                strokePts(outG, quad, 0xf4d03f, 2.5, 1);
            }
        }
    }

    /* ---- main loop ----------------------------------------------------------- */
    var lastT = 0;
    var camSaveDue = 0;                          // throttle: persist ~2.5x/sec
    var lastSavedCam = null;
    var wanderNextT = 0;                // repaint throttle while the crowd walks
    window.addEventListener('pagehide', function () {
        if (started) saveCam();                  // flush on refresh/close
    });
    function loop(t) {
        requestAnimationFrame(loop);
        var dt = lastT ? Math.min(0.05, (t - lastT) / 1000) : 0;
        lastT = t;
        /* the filmstrips' playback clock: real elapsed ms × the global rate.
           Taken off performance.now() rather than the frame stamp — the two
           share a timebase in the browser, but a rAF stamp frozen across a
           replayed queue (the DOM harness flushes every callback on one stamp)
           would stall the loops. Uncapped like the animNow it mirrors: every
           consumer is a modulo of this clock or a one-shot age, so the long
           delta a backgrounded tab comes back with just lands the loops on a
           different cell, which is what they already did before the rate
           existed */
        var an = performance.now();
        animClock += (animClockT ? an - animClockT : 0) * animSpeed;
        animClockT = an;
        if (cam.vx || cam.vy) { CAM.tick(cam, dt); markDirty(); }
        /* idle wander (js/wander.js): the sim is cheap (one pass over the
           crowd; an A* run only when a dwell expires, capped at
           KNOBS.maxSearch per tick), so it runs every frame — but the CROWD
           repaints on a throttle. Redrawing all 870 characters at 60 Hz for a
           1.3 tile/s walk is invisible work; 16 Hz reads as smooth walking and
           only when a walker is actually on screen (walkLive) */
        if (wanderOn && wander && wander.tick(dt) &&
            walkLive && t >= wanderNextT) {
            wanderNextT = t + 60;
            markDirty();
        }
        if (t >= camSaveDue) {                   // persist any camera move
            camSaveDue = t + 400;
            if (!lastSavedCam || lastSavedCam.x !== cam.x ||
                lastSavedCam.y !== cam.y || lastSavedCam.zoom !== cam.zoom) {
                lastSavedCam = { x: cam.x, y: cam.y, zoom: cam.zoom };
                saveCam();
            }
        }
        if (needsRender) {
            needsRender = false;
            render();
            app.render();
        } else if ((animLive || charAnimLive || animPending ||
                    (artMode && animOn && animNow >= animRetryT)) &&
                artMode && animOn && t >= animNextT) {
            // keep the filmstrips and character idle loops moving: last
            // frame drew animated sprites, is still waiting on one to
            // decode, or has a strip that was refused a cache slot and is
            // owed one retry (animRetryT, armed once per arrival)
            //
            // 90 ms is ~11 Hz, the ceiling on a strip at the shared 12 fps:
            // speed the loops up and the repaint, not the art, is what would
            // stutter. So the interval follows the rate — but only upward —
            // AND the frame's fastest strip (animTickMs): the generator can
            // stamp a faster clock on one asset (a re-timed dragon turns at
            // 24 ticks/s at the default rate), and sampling that at 45 ms
            // would drop every other pose. The min() keeps 90 ms as the floor
            // for slow rates, since the character idle loops and the decode
            // retries still run on the real clock and would go choppy if we
            // starved them of repaints.
            animNextT = t + Math.max(16, Math.min(90,
                animTickMs / animSpeed));
            markDirty();
        }
        if (t - diagLastT > 500) {                 // statsbar at 2 Hz
            var win = t - diagLastT || 500;
            diagLastT = t;
            DIAG.fps = Math.round(diagFrames * 1000 / win);
            var pr = $('perfread');
            if (pr) pr.textContent = DIAG.mode + ' · ' +
                DIAG.fps + 'fps · ' +
                (diagFrames ? (diagMsAcc / diagFrames).toFixed(1) : '0.0') +
                '/' + DIAG.maxMs.toFixed(1) + 'ms' +
                ' · a' + DIAG.anims + ' · p' + DIAG.pool +
                (animSpeed === ANIM_SPEED_DEFAULT ? '' : ' \u00b7 ' + animSpeedLabel()) +
                (wanderOn && walkLive ? ' \u00b7 \u21c8' + walkLive : '') +
                ' \u00b7 v' + DIAG.ver;
            diagFrames = 0; diagMsAcc = 0; DIAG.maxMs = 0;
        }
    }

    /* ---- input: pan / fling / zoom ------------------------------------------ */
    function overUI(e) {
        var t = e.target;
        return !!(t && t.closest && t.closest('.legend'));
    }
    var down = false, moved = false, lx = 0, ly = 0, dx0 = 0, dy0 = 0;
    var mvT = 0, flingX = 0, flingY = 0;     // release velocity, screen px/s
    stage.addEventListener('pointerdown', function (e) {
        if (e.button !== 0 || overUI(e)) return;
        down = true; moved = false;
        lx = dx0 = e.clientX; ly = dy0 = e.clientY;
        mvT = 0; flingX = flingY = 0;
        cam.vx = 0; cam.vy = 0;
        stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener('pointermove', function (e) {
        if (!down) return;
        var now = performance.now();
        var dx = e.clientX - lx, dy = e.clientY - ly;
        if (!moved && Math.hypot(e.clientX - dx0, e.clientY - dy0) > 3) {
            moved = true; stage.classList.add('panning');
        }
        if (moved) {
            CAM.panByScreen(cam, dx, dy);
            var dt = mvT ? Math.max(4, now - mvT) / 1000 : 0.016;
            flingX = flingX * 0.5 + (dx / dt) * 0.5;   // smoothed release velocity
            flingY = flingY * 0.5 + (dy / dt) * 0.5;
            mvT = now; lx = e.clientX; ly = e.clientY; markDirty();
        }
    });
    stage.addEventListener('pointerup', function (e) {
        if (!down) return;
        down = false; stage.classList.remove('panning');
        if (moved) { CAM.setFling(cam, flingX, flingY); markDirty(); }  // release -> fling
    });
    stage.addEventListener('wheel', function (e) {
        if (overUI(e)) return;
        e.preventDefault();
        var r = stage.getBoundingClientRect();
        CAM.wheel(cam, e.deltaY, e.clientX - r.left, e.clientY - r.top, VW, VH);
        markDirty();
    }, { passive: false });
    stage.addEventListener('dblclick', function (e) {
        if (overUI(e)) return;
        /* on a marked tile, dblclick centers the mark instead of stepping
           zoom (the mark is what the user is looking at) */
        if (markerPts.length) {
            var rr = stage.getBoundingClientRect();
            var wq = CAM.screenToWorld(cam, e.clientX - rr.left,
                e.clientY - rr.top, VW, VH);
            var tq = CAM.worldToTile(wq.x, wq.y);
            var bx = Math.round(tq.x), by = Math.round(tq.y);
            for (var mi = 0; mi < markerPts.length; mi++)
                if (markerPts[mi][0] === bx && markerPts[mi][1] === by) {
                    centerOnTile(bx + 0.5, by + 0.5);
                    markDirty();
                    return;
                }
        }
        var r = stage.getBoundingClientRect();
        CAM.zoomStep(cam, e.clientX - r.left, e.clientY - r.top, VW, VH);
        markDirty();
    });

    window.addEventListener('keydown', function (e) {
        var t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;  // search typing
        var n = 40;
        if (e.key === 'Escape') { setSel(null); }
        else if ((e.key === 'h' || e.key === 'H') && selected && selected.kind === 'b') {
            var hb = byMi[selected.i];               // toggle hide on the card object
            if (hb) { setHidden(hb, !hiddenObjs[hb.hkey]); setSel(selected); }
            e.preventDefault();
        }
        else if (e.key === 'ArrowLeft') { CAM.panByScreen(cam, n, 0); markDirty(); e.preventDefault(); }
        else if (e.key === 'ArrowRight') { CAM.panByScreen(cam, -n, 0); markDirty(); e.preventDefault(); }
        else if (e.key === 'ArrowUp') { CAM.panByScreen(cam, 0, n); markDirty(); e.preventDefault(); }
        else if (e.key === 'ArrowDown') { CAM.panByScreen(cam, 0, -n); markDirty(); e.preventDefault(); }
    });

    /* ---- select + details pane + search --------------------------------------- */
    var details = $('details');
    var search = $('search');
    var matchinfo = $('matchinfo');
    var results = $('results');
    var PLACEHOLDER = '<div class="placeholder">Click a building or character&hellip;</div>';
    var selected = null;              // {kind:'b'|'c'|'t', i|x,y,type}
    var searchMatches = [];           // [{kind, i}]
    var searchQ = '';                 // last applied query (for result ranking)
    var searchTimer = null;
    var MATCH_DRAW_CAP = 600;         // outline cap — keeps render cheap for huge buckets
    var RESULT_CAP = 100;             // result-list cap (grouped by catalog id)

    function buildingHtml(i) {
        var b = M.buildings[i];
        var e = M.binfo[b[0]];
        if (!e) return '<h3>unknown</h3><p class="dim">No catalog entry for #' + b[0] + '.</p>';
        var name = e[0], asset = e[1], slug = e[2], x = e[3], z = e[4],
            locX = e[5], locY = e[6], height = e[7], via = e[8], count = e[9];
        var viaCls = via === 'asset' ? 'via-asset' :
            (via === 'flip' || via === 'rotated') ? 'via-flip' : 'via-other';
        var bv = behav && behav[String(slug).toLowerCase()];   // gate readout
        return '<h3>' + esc(name) + '</h3>' +
            '<div class="tagrow"><span class="tag">building <b>#' + b[0] + '</b></span>' +
            '<span class="tag"><b>' + count + '</b>&times; in save</span>' +
            '<span class="tag">bucket <b>' + esc(catOfMi[i]) + '</b></span></div>' +
            '<table>' +
            '<tr><td>asset</td><td>' + esc(asset) + '</td></tr>' +
            '<tr><td>slug</td><td>' + esc(slug) + '</td></tr>' +
            '<tr><td>footprint</td><td>' + b[3] + ' &times; ' + b[4] + ' tiles (drawn)</td></tr>' +
            '<tr><td>catalog dims</td><td>' + x + ' &times; ' + z + ', anchor ' + locX + ', ' + locY + '</td></tr>' +
            '<tr><td>height</td><td>' + height + '</td></tr>' +
            '<tr><td>position</td><td>' + b[6] + ', ' + b[7] + '</td></tr>' +
            '<tr><td>covers tiles</td><td>X ' + Math.round(b[1]) + '..' + Math.round(b[1] + b[3] - 1) +
            ', Y ' + Math.round(b[2]) + '..' + Math.round(b[2] + b[4] - 1) + '</td></tr>' +
            '<tr><td>resolved via</td><td class="' + viaCls + '">' + esc(via) + '</td></tr>' +
            (bv ? '<tr><td>engine anims</td><td>' +
                  (bv.idle ? 'idle <b>' + esc(bv.idle) + '</b>'
                           : (bv.layers ? 'part loops <b>' +
                              esc(bv.layers.join(' + ')) + '</b>' : 'idle static')) +
                  (bv.toggle ? ' · click <b>' + esc(togLabel(bv.toggle)) +
                       '</b> (toggle)'
                      : bv.tap ? ' · tap <b>' + esc(bv.tap) + '</b> (click)'
                      : ' · no tap anim') + '</td></tr>'
                 : '') +
            '</table>' +
            '<button type="button" class="hidebtn" data-act="hideobj"' +
            ' aria-pressed="' + (hiddenObjs[byMi[i].hkey] ? 'true' : 'false') + '"' +
            ' data-tip="hide just this instance (key h): it stops drawing and' +
            ' stops claiming clicks, so what sits under it can be inspected;' +
            ' survives reloads — find it again by name, or use unhide all">' +
            (hiddenObjs[byMi[i].hkey] ? '&#128065; show object'
                                       : '&#128584; hide object') +
            '</button>' +
            '<div class="pinnote">Selected — Esc or clicking a ground tile deselects.' +
            ' Enter in the search box centers matches.</div>';
    }
    function charHtml(i) {
        var c = M.chars[i];
        var name = M.charNames[c[0]];
        var count = 0;
        for (var k = 0; k < M.chars.length; k++) if (M.chars[k][0] === c[0]) count++;
        var rec = charMan && charMan.characters[c[0]];
        /* the idle wander moves the row in place, so the card says where the
           save put the character as well as where it is standing now */
        var home = wanderOn && wander ? wander.home[i] : null;
        var away = home && (home[0] !== c[1] || home[1] !== c[2]);
        var wr = null;
        if (wanderOn && wander) {
            var wd = (typeof WALK_DATA !== 'undefined' && WALK_DATA.chars)
                     ? WALK_DATA.chars[c[0]] : null;
            var st = wander.st[i];
            wr = '<tr><td>idle wander</td><td>' +
                esc((wd && wd.mode) ||
                    (typeof WALK_DATA !== 'undefined' && WALK_DATA.defaults
                        ? WALK_DATA.defaults.mode : 'RandomRelaxed')) +
                ' · ' + (st ? (st.speed || 0).toFixed(2) + ' tiles/s' : '') +
                ' · ' + (st ? (st.skip ? 'off the land'
                             : st.path ? 'walking' : 'standing') : 'not simmed') +
                (home ? ' · post ' + home[0] + ', ' + home[1] : '') + '</td></tr>';
        }
        return '<h3>' + esc(name || 'char #' + c[0]) + '</h3>' +
            '<div class="tagrow"><span class="tag">character <b>#' + c[0] + '</b></span>' +
            '<span class="tag"><b>' + count + '</b>&times; in save</span></div>' +
            '<table><tr><td>position</td><td>' + c[1] + ', ' + c[2] +
            (away ? ' <span class="dim">(save ' + home[0] + ', ' + home[1] +
                    ')</span>' : '') + '</td></tr>' +
            (wr || '') +
            '<tr><td>name resolved</td><td>' +
            (name ? 'yes (character catalog)' : 'no') + '</td></tr>' +
            '<tr><td>map asset</td><td>' +
            (rec ? (function () {
                var pk = charRecPick(c, i);
                return esc((pk && pk.slug) || rec.slug) +
                    (rec.pool && rec.pool.length > 1
                        ? ' <span class="dim">(randomSkin pool of ' +
                          rec.pool.length + ': one skin per instance)</span>'
                        : '');
            })() : 'none &mdash; drawn as a dot') + '</td></tr></table>' +
            '<div class="pinnote">Selected &mdash; Esc or clicking a ground tile deselects.' +
            ' Click an animation tile below to play it on the map.</div>';
    }
    function terrainHtml(x, y, type) {
        var isGrass = type === 'grass';
        var ti = isGrass ? -1 : CityTerrain.TYPE_ORDER.indexOf(type);
        var bb = ti >= 0 ? terrain.typeBBox[ti] : null;
        var layer = null;
        for (var i = 0; !isGrass && i < M.layers.length; i++)
            if (M.layers[i].n === type) layer = M.layers[i];
        return '<h3>' + esc(type) + ' tile</h3>' +
            '<div class="tagrow"><span class="tag">terrain <b>' + esc(type) + '</b></span>' +
            (isGrass
                ? '<span class="tag">base fill</span>'
                : '<span class="tag"><b>' + (terrainCounts[type] || 0) +
                  '</b> tiles in layer</span>') +
            '</div>' +
            '<table>' +
            '<tr><td>town tile</td><td>' + x + ', ' + y + '</td></tr>' +
            '<tr><td>grid tile</td><td>' + (x + M.ox) + ', ' + (y + M.oy) + '</td></tr>' +
            (bb ? '<tr><td>layer bbox (town)</td><td>X ' + bb.x0 + '..' + bb.x1 +
                  ', Y ' + bb.y0 + '..' + bb.y1 + '</td></tr>' : '') +
            (layer ? '<tr><td>layer source</td><td>' + esc(layer.n) +
                  (layer.s ? ' frame, ' + layer.s.length + ' chars</td></tr>'
                           : ' (recovered brush tiles, generator-classified)</td></tr>') : '') +
            (isGrass ? '<tr><td>note</td><td>base lawn — any tile no layer covers</td></tr>' : '') +
            '</table>' +
            '<div class="pinnote">Selected — Esc or click the tile again to deselect.</div>';
    }

    function selCatalogId() {
        if (!selected) return null;
        return selected.kind === 'b' ? M.buildings[selected.i][0]
            : selected.kind === 'c' ? M.chars[selected.i][0] : null;
    }
    function setSel(sel) {
        selected = sel;
        charPreview = null;                        // preview follows the card
        if (window.AssetVariants && AssetVariants.stop) AssetVariants.stop();
        if (window.CharVariants && CharVariants.stop) CharVariants.stop();
        details.innerHTML = !sel ? PLACEHOLDER
            : sel.kind === 'c' ? charHtml(sel.i)
            : sel.kind === 't' ? terrainHtml(sel.x, sel.y, sel.type)
            : buildingHtml(sel.i);
        // sprite-variant strip under the building card
        if (sel && sel.kind === 'b' && window.AssetVariants) {
            var e = M.binfo[M.buildings[sel.i][0]];
            var v = AssetVariants.render(e && e[2], e && e[0]);
            if (v) details.appendChild(v);
        }
        // family strip under the character card (families/<cid>.json sidecar)
        if (sel && sel.kind === 'c' && window.CharVariants) {
            var ch = M.chars[sel.i];
            var fv = CharVariants.render(ch[0], M.charNames[ch[0]], {
                onPreview: function (cell) {
                    charPreview = cell ? { cid: ch[0], cell: cell } : null;
                    markDirty();
                },
                dynFor: DYNB.characters ? dynCell : null
            });
            if (fv) details.appendChild(fv);
        }
        markResultSel();
        markDirty();
        if (hiddenCount()) details.appendChild(hiddenBar());
    }
    /* "hidden objects" bar: the recovery path — hidden instances release
       clicks, so this list (or a name search) is how you find one again */
    function hiddenBar() {
        var el = document.createElement('div');
        el.className = 'hidebar';
        var rows = [];
        for (var mi = 0; mi < byMi.length; mi++) {
            var b = byMi[mi];
            if (!b || !hiddenObjs[b.hkey]) continue;
            var info = M.binfo[b.id];
            rows.push('<div class="hiderow">' +
                '<button type="button" data-act="gohide" data-mi="' + mi +
                '" data-tip="select + centre: the yellow box marks where the hidden object sits">' +
                esc(info ? info[0] : 'object #' + b.id) +
                ' <b class="n">@' + Math.round(b.px) + ',' + Math.round(b.py) +
                '</b></button>' +
                '<button type="button" class="un" data-act="showone" data-mi="' + mi +
                '" data-tip="unhide just this one">&#10005;</button></div>');
        }
        el.innerHTML = '<div class="hhead">hidden objects <b>' + hiddenCount() +
            '</b><button type="button" class="unall" data-act="unhideall"' +
            ' data-tip="restore every hidden instance">unhide all</button></div>' +
            rows.join('');
        return el;
    }
    details.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest && e.target.closest('[data-act]');
        if (!btn) return;
        var act = btn.getAttribute('data-act');
        if (act === 'hideobj') {                     // the card's toggle
            if (!selected || selected.kind !== 'b') return;
            var b = byMi[selected.i];
            if (!b) return;
            setHidden(b, !hiddenObjs[b.hkey]);
            setSel(selected);                        // re-label the button
        } else if (act === 'unhideall') {
            unhideAllObjs();
            setSel(selected);
        } else if (act === 'showone') {
            var m1 = parseInt(btn.getAttribute('data-mi'), 10);
            if (byMi[m1]) { setHidden(byMi[m1], false); setSel(selected); }
        } else if (act === 'gohide') {
            var m2 = parseInt(btn.getAttribute('data-mi'), 10);
            if (byMi[m2]) { setSel({ kind: 'b', i: m2 }); centerSel(); }
        }
    });
    function centerSel() {
        if (!selected) return;
        if (selected.kind === 'c') {
            centerOnTile(M.chars[selected.i][1], M.chars[selected.i][2]);
        } else {
            var b = byMi[selected.i];
            centerOnTile((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
        }
        if (cam.zoom < CAM.ZOOM.rest) cam.zoom = CAM.ZOOM.rest;   // don't inspect from orbit
        markDirty();
    }

    /* ---- canvas hit-test (front-to-back, mirrors the draw order) ------------- */
    function pointInPoly(px, py, q) {
        var inside = false;
        for (var i = 0, j = q.length - 1; i < q.length; j = i++) {
            if ((q[i].y > py) !== (q[j].y > py) &&
                px < (q[j].x - q[i].x) * (py - q[i].y) / (q[j].y - q[i].y) + q[i].x)
                inside = !inside;
        }
        return inside;
    }
    function hitTest(sx, sy) {
        if (!objHidden.people) {           // people draw on top -> claim clicks first
            // In Art mode the character is a billboard, not a dot: test the
            // drawn sprite rect (same geometry renderScene blits) — the old
            // dot-sized box made visible characters near-unclickable.
            var s = CAM.scale(cam);
            var ka = s / ART.S;
            var art = artMode && charMan && s >= BUILD_LOD_S;
            for (var i = M.chars.length - 1; i >= 0; i--) {
                var p = charScreen(M.chars[i]);
                var as4 = art ? charArtOf(M.chars[i], i) : null;
                if (as4 && !(as4.w * ka < 12 && as4.h * ka < 12)) {
                    var hx = p.x - as4.anchor[0] * ka,
                        hy = p.y - as4.anchor[1] * ka;
                    if (sx >= hx - 2 && sx <= hx + as4.w * ka + 2 &&
                        sy >= hy - 2 && sy <= hy + as4.h * ka + 2)
                        return { kind: 'c', i: i };
                } else if (Math.abs(sx - p.x) <= p.r + 2 &&
                           Math.abs(sy - p.y) <= p.r + 2)
                    return { kind: 'c', i: i };
            }
        }
        for (var k = buildings.length - 1; k >= 0; k--) {   // depth-sorted back-to-front
            var b = buildings[k];
            if (objHidden[b.cat] || hiddenObjs[b.hkey]) continue;
            var q = blockPolys(b);
            if (pointInPoly(sx, sy, q.top) || pointInPoly(sx, sy, q.right) ||
                pointInPoly(sx, sy, q.left))
                return { kind: 'b', i: b.mi, b: b };
        }
        var wpt = CAM.screenToWorld(cam, sx, sy, VW, VH);
        var tp = CAM.worldToTile(wpt.x, wpt.y);
        var tx = Math.floor(tp.x), ty = Math.floor(tp.y);
        var tt = terrain.topTypeAt(tx, ty);
        return tt ? { kind: 't', x: tx, y: ty, type: tt } : null;
    }
    stage.addEventListener('click', function (e) {
        if (moved || overUI(e)) return;    // pan-drag and legend rows are not picks
        if (proposedOn && e.shiftKey) { proposeStreet(e); return; }
        var r = stage.getBoundingClientRect();
        var hit = hitTest(e.clientX - r.left, e.clientY - r.top);
        // BuildingTouched: play the tap anim once — on the block itself,
        // or on any tile of the lot under it
        if (hit && hit.kind === 'b') tapBuilding(hit.b);
        else if (hit && hit.kind === 't') {
            var bb = blockAtTile(hit.x, hit.y);
            if (bb) tapBuilding(bb);
        }
        // ground fills the whole plane — clicking the SAME tile again deselects
        if (hit && selected && hit.kind === 't' && selected.kind === 't' &&
            hit.x === selected.x && hit.y === selected.y && hit.type === selected.type)
            hit = null;
        setSel(hit);
    });

    /* ---- search ---------------------------------------------------------------- */
    search.addEventListener('input', function () {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(doSearch, 120);
    });
    search.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && searchMatches.length) {
            setSel(searchMatches[0]);
            centerSel();
            e.preventDefault();
        }
        if (e.key === 'Escape') { search.value = ''; doSearch(); }
        e.stopPropagation();               // arrows/Esc while typing must not pan
    });
    function resultGroups() {
        var map = {}, order = [];
        for (var i = 0; i < searchMatches.length; i++) {
            var m = searchMatches[i];
            var id = m.kind === 'b' ? M.buildings[m.i][0] : M.chars[m.i][0];
            var key = m.kind + ':' + id;
            var g = map[key];
            if (!g) {
                g = map[key] = {
                    kind: m.kind, id: id, n: 0, first: m.i,
                    name: m.kind === 'b'
                        ? (M.binfo[id] ? M.binfo[id][0] : 'unknown #' + id)
                        : (M.charNames[id] || 'char #' + id)
                };
                order.push(g);
            }
            g.n++;
        }
        var q = searchQ;
        function rank(g) {                       // exact id/name first, then prefix, then rest
            var nm = g.name.toLowerCase();
            if (q === String(g.id) || nm === q) return 0;
            if (nm.indexOf(q) === 0) return 1;
            return 2;
        }
        order.sort(function (a, b) {
            return rank(a) - rank(b) ||
                a.name.localeCompare(b.name) ||
                (a.kind === b.kind ? 0 : a.kind === 'b' ? -1 : 1);
        });
        return order;
    }
    function renderResults() {
        if (!searchMatches.length) { results.innerHTML = ''; return; }
        var gs = resultGroups();
        var rows = ['<div class="reshead"><b>' + gs.length + '</b> item' +
            (gs.length === 1 ? '' : 's') + ' &middot; click to select &amp; center</div>'];
        for (var i = 0; i < Math.min(gs.length, RESULT_CAP); i++) {
            var g = gs[i];
            var sw = g.kind === 'b' ? M.pal[g.id % M.pal.length] : M.charcol;
            rows.push('<button type="button" class="res" data-kind="' + g.kind +
                '" data-id="' + g.id + '">' +
                '<span class="sw" style="background:rgb(' + sw.join(',') + ')"></span>' +
                esc(g.name) + ' <b class="n">' + g.n + '&times;</b>' +
                ' <span class="cid">#' + g.id + '</span></button>');
        }
        if (gs.length > RESULT_CAP)
            rows.push('<div class="dim">&hellip;and ' + (gs.length - RESULT_CAP) +
                ' more &mdash; refine the search</div>');
        results.innerHTML = rows.join('');
        markResultSel();
    }
    function markResultSel() {
        var btns = results.querySelectorAll('button.res');
        var selId = selCatalogId();
        for (var i = 0; i < btns.length; i++) {
            var on = !!selected && btns[i].getAttribute('data-kind') === selected.kind &&
                +btns[i].getAttribute('data-id') === selId;
            btns[i].classList.toggle('sel', on);
        }
    }
    results.addEventListener('click', function (e) {
        var btn = e.target.closest && e.target.closest('button.res');
        if (!btn) return;
        var kind = btn.getAttribute('data-kind');
        var id = +btn.getAttribute('data-id');
        for (var i = 0; i < searchMatches.length; i++) {
            var m = searchMatches[i];
            var mid = m.kind === 'b' ? M.buildings[m.i][0] : M.chars[m.i][0];
            if (m.kind === kind && mid === id) {
                setSel({ kind: kind, i: m.i });
                centerSel();
                return;
            }
        }
    });
    function doSearch() {
        var q = search.value.trim().toLowerCase();
        searchQ = q;
        searchMatches = [];
        if (!q) { matchinfo.textContent = ''; results.innerHTML = ''; markDirty(); return; }
        for (var i = 0; i < M.buildings.length; i++) {
            var b = M.buildings[i], e = M.binfo[b[0]];
            var hay = e ? (e[0] + ' ' + (e[1] || '') + ' ' + (e[2] || '')).toLowerCase() : '';
            if ((q === String(b[0]) || hay.indexOf(q) >= 0) && !objHidden[catOfMi[i]])
                searchMatches.push({ kind: 'b', i: i });
        }
        if (!objHidden.people) {
            for (var j = 0; j < M.chars.length; j++) {
                var c = M.chars[j];
                var nm = (M.charNames[c[0]] || '').toLowerCase();
                if (q === String(c[0]) || nm.indexOf(q) >= 0)
                    searchMatches.push({ kind: 'c', i: j });
            }
        }
        matchinfo.textContent = searchMatches.length + ' match' +
            (searchMatches.length === 1 ? '' : 'es') +
            (searchMatches.length ? ' — Enter centers first' : '');
        renderResults();
        markDirty();
    }

    /* ---- view buttons -------------------------------------------------------- */
    function setOn(id) {
        ['btn-rest', 'btn-springfield', 'btn-downtown', 'btn-full', 'btn-ocean',
         'btn-reset'].forEach(function (b) {
            $(b).classList.toggle('on', b === id);
        });
    }
    function usePreset(fn, id) { fn(); lastPreset = fn; setOn(id); markDirty(); }
    $('btn-rest').addEventListener('click', function () { usePreset(presetRest, 'btn-rest'); });
    $('btn-springfield').addEventListener('click', function () {
        usePreset(presetSpringfield, 'btn-springfield');
    });
    $('btn-downtown').addEventListener('click', function () { usePreset(presetDowntown, 'btn-downtown'); });
    $('btn-full').addEventListener('click', function () { usePreset(presetFull, 'btn-full'); });
    $('btn-ocean').addEventListener('click', function () { usePreset(presetOcean, 'btn-ocean'); });
    $('btn-reset').addEventListener('click', function () {
        usePreset(presetDowntown, 'btn-downtown');
        setSel(null);
        search.value = '';
        doSearch();
    });

    /* ---- orientation buttons + paste-back readout --------------------------- */
    function setOrient(o) {
        CAM.ORIENT = { fx: o.fx, fy: o.fy, swap: o.swap };
        try { localStorage.setItem(ORIENT_KEY, JSON.stringify(CAM.ORIENT)); } catch (e) { /* private mode */ }
        var wasHidden = Object.keys(terrain.hidden);   // legend toggles survive a rig press
        terrain = new CityTerrain(M, { speckleFilter: speckOn, roadNetwork: roadNetOn });
        wasHidden.forEach(function (t) { terrain.setVisible(t, false); });
        applySheetArtMode();                   // the Road-art toggle survives a rig press
        applyRoadNetMode();                    // ...and so does the road-network model
        buildBuildings();                      // re-key + re-sort building depth
        recomputeManhOff();
        terrFlatDirty = true; bFlatDirty = true;
        buildGround();                         // re-place the tile-space ground
        beachBuild();                          // coast anchors read terrain
        if (lastPreset) lastPreset();          // re-frame the preset in the new projection
        updateOrientReadout();
        markDirty();
    }
    function updateOrientReadout() {
        var o = CAM.ORIENT;
        $('orientread').textContent = 'ORIENT = { fx: ' + o.fx + ', fy: ' + o.fy +
            ', swap: ' + o.swap + ' }';
    }
    $('btn-rot').addEventListener('click', function () { setOrient(CAM.orientRotate90(CAM.ORIENT)); });
    $('btn-flip').addEventListener('click', function () { setOrient(CAM.orientMirror(CAM.ORIENT)); });

    /* ---- road sheet art toggle ------------------------------------------------ */
    var SHEETART_KEY = 'mrsnrub.cityview.sheetart';
    var sheetArtMode = 0;   // 0 off, 1 uniform sheet, 2 neighbour, 3 neighbour+avenues, 4 spec-grid footpath art
    function applySheetArtMode() {
        terrain.useSheetArt = sheetArtMode >= 1 && sheetArtMode <= 3;
        terrain.sheetSelect = sheetArtMode >= 2 && sheetArtMode <= 3 ? 'neighbor' : 'uniform';
        terrain.useAvenues = sheetArtMode === 3;
        /* rebuild rather than just toggle: the per-cell pick runs
           terrain._pavePick, whose probe depends on useAvenues — and mode 4
           swaps the sheet passes for the road-lab spec composition */
        buildGround();
        applySheetMode();
        var b = $('btn-sheetart');
        if (b) {
            b.classList.toggle('on', sheetArtMode > 0);
            b.textContent = sheetArtMode === 4 ? 'Road art·spec' :
                sheetArtMode === 3 ? 'Road art·av' :
                sheetArtMode === 2 ? 'Road art·edges' : 'Road art';
        }
    }
    (function loadSheetArt() {
        try { sheetArtMode = parseInt(localStorage.getItem(SHEETART_KEY), 10) || 0; } catch (e) { /* private mode */ }
        if (!(sheetArtMode >= 0 && sheetArtMode <= 4)) sheetArtMode = 0;
        applySheetArtMode();
    })();
    if ($('btn-sheetart')) $('btn-sheetart').addEventListener('click', function () {
        sheetArtMode = (sheetArtMode + 1) % 5;
        try { localStorage.setItem(SHEETART_KEY, String(sheetArtMode)); } catch (e) { /* private mode */ }
        applySheetArtMode();
        markDirty();
    });

    /* ---- water art toggle: RE'd RiverDrawer cells (notes/09 §9, lab water
       tab) — quadrant quads from the 0x3fc320 table over the flat river
       fills. Independent of Road art; 'P' cells get the open-water slab.
       The ocean base/wave marks are NOT this layer (engine: base terrain —
       there is no sea drawer), and the 3 s WaterAnims shimmer is unproven,
       so no wave overlay ships here. */
    if ($('btn-waterart')) $('btn-waterart').addEventListener('click', function () {
        waterArtOn = !waterArtOn;
        try { localStorage.setItem(WATERART_KEY, waterArtOn ? '1' : '0'); } catch (e) { /* private mode */ }
        applyWaterMode();
        markDirty();
    });

    /* ---- dirt art toggle: the same two quadrant models on the dirt tile
       sheet (notes/09 §11) — dirtroad cells get the RoadDrawer quadrants
       (DIRT_ROADS / DirtRoadDrawing), dirt cells the RiverDrawer quadrants
       (DIRT / DirtRiverDrawing), both from dirtroadtilesheet (WildWest .rgb
       normally, XMAS .png in winter). The sheet is the same lattice as
       roadrivertiles (ray-measured ±1-2 px at all 11 states) so the shared
       ROAD_QUADS/RIVER_QUADS tables carry over unchanged; only the texture
       differs. */
    if ($('btn-dirtart')) $('btn-dirtart').addEventListener('click', function () {
        dirtArtOn = !dirtArtOn;
        try { localStorage.setItem(DIRTART_KEY, dirtArtOn ? '1' : '0'); } catch (e) { /* private mode */ }
        applySheetMode();                        // hand the legacy passes back
        applyDirtMode();
        markDirty();
    });

    /* ---- pier / boardwalk art toggle: the bsv3 tile art the engine draws
       for the two ocean-grid brushes (notes/09 §12) — off = the flat plank
       fill the page drew before the art was extracted. */
    if ($('btn-pierart')) $('btn-pierart').addEventListener('click', function () {
        pierArtOn = !pierArtOn;
        try { localStorage.setItem(PIERART_KEY, pierArtOn ? '1' : '0'); } catch (e) { /* private mode */ }
        applyPierMode();
        markDirty();
    });
    (function () {                 // ON by default: only an explicit "0" hides it
        try { pierArtOn = localStorage.getItem(PIERART_KEY) !== '0'; } catch (e) { /* private mode */ }
    })();

    /* ---- road bridges toggle: the RoadDrawer's own deck art on the crossings
       this save produces (notes/09 §10) — off = the flat road fill over the
       river, which is what the engine does NOT do on a real crossing. */
    if ($('btn-bridges')) $('btn-bridges').addEventListener('click', function () {
        bridgesOn = !bridgesOn;
        try { localStorage.setItem(BRIDGE_KEY, bridgesOn ? '1' : '0'); } catch (e) { /* private mode */ }
        applyBridgeMode();
        markDirty();
    });
    applyBridgeMode();

    /* ---- bridge grass-ends toggle: the end section of each row swaps the
       plain deck (bridgetop_f4, what the game screenshot shows at the bank)
       for the grass-abutment frames the art ships (f2 = C_Grass_04 bank at
       the tail end, f6 = C_Grass_03 fillet at the head end, f3 = both on a
       one-cell crossing). Off by default; notes/09 §10. */
    var BRIDGE_GRASS_KEY = 'mrsnrub.cityview.bridgegrass';
    function applyBridgeGrassMode() {
        var b = $('btn-bridgegrass');
        if (b) b.classList.toggle('on', BRIDGE_GRASS_ENDS);
    }
    try { BRIDGE_GRASS_ENDS = localStorage.getItem(BRIDGE_GRASS_KEY) === '1'; } catch (e) { /* private mode */ }
    if ($('btn-bridgegrass')) $('btn-bridgegrass').addEventListener('click', function () {
        BRIDGE_GRASS_ENDS = !BRIDGE_GRASS_ENDS;
        try { localStorage.setItem(BRIDGE_GRASS_KEY, BRIDGE_GRASS_ENDS ? '1' : '0'); } catch (e) { /* private mode */ }
        bridgeSegs = null;                  // re-derive with the new end frames
        applyBridgeGrassMode();
        markDirty();
    });
    applyBridgeGrassMode();

    /* ---- 1-wide N-S fragment debug overlay ----------------------------------- */
    var FRAGS_KEY = 'mrsnrub.cityview.frags';
    var fragsOn = false;
    function applyFragsMode() {
        terrain.debugFrags = fragsOn;
        var b = $('btn-frags');
        if (b) b.classList.toggle('on', fragsOn);
    }
    (function loadFrags() {
        try { fragsOn = localStorage.getItem(FRAGS_KEY) === '1'; } catch (e) { /* private mode */ }
        applyFragsMode();
    })();
    if ($('btn-frags')) $('btn-frags').addEventListener('click', function () {
        fragsOn = !fragsOn;
        try { localStorage.setItem(FRAGS_KEY, fragsOn ? '1' : '0'); } catch (e) { /* private mode */ }
        applyFragsMode();
        markDirty();
    });

    /* ---- road network model toggle -------------------------------------------- */
    function applyRoadNetMode() {
        terrain.setRoadNetwork(roadNetOn);
        terrFlatDirty = true;
        buildGround();
        var b = $('btn-roadnet');
        if (b) b.classList.toggle('on', roadNetOn);
    }
    applyRoadNetMode();
    if ($('btn-roadnet')) $('btn-roadnet').addEventListener('click', function () {
        roadNetOn = !roadNetOn;
        try { localStorage.setItem(ROADNET_KEY, roadNetOn ? '1' : '0'); } catch (e) { /* private mode */ }
        applyRoadNetMode();
        markDirty();
    });

    /* ---- candidate-street verdict tool ----------------------------------------
       Ported verbatim; the map overlay lives in drawProposed() here, the API
       endpoint moves with the page (../api/streets.php). */
    var PROPSW_KEY = 'mrsnrub.cityview.propshow';
    var PROPVR_KEY = 'mrsnrub.cityview.propverdicts';
    var proposedOn = false;
    var propApi = false;              // true once api/streets.php answered
    function localVerdicts() {
        try { return JSON.parse(localStorage.getItem(PROPVR_KEY)) || {}; }
        catch (e) { return {}; }
    }
    function applyProposedMode() {
        terrain.showProposed = proposedOn;
        var b = $('btn-proposed');
        if (b) b.classList.toggle('on', proposedOn);
        var p = $('proplegend');
        if (p) p.style.display = proposedOn ? '' : 'none';
    }
    function propTint(v) {
        return v === 'ok' ? 'rgb(70,220,120)' :
            v === 'bad' ? 'rgb(230,70,70)' : 'rgb(0,200,255)';
    }
    function escAttr(s) {
        return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
            .replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function buildPropPanel() {
        var el = $('proplegend');
        if (!el) return;
        var S = CityTerrain.PROPOSED.streets, rows = [];
        var counts = { ok: 0, bad: 0, pending: 0 };
        for (var i = 0; i < S.length; i++) {
            var st = S[i];
            var v = CityTerrain.PROPOSED.verdicts[st.id] || 'pending';
            counts[v === 'ok' || v === 'bad' ? v : 'pending']++;
            rows.push('<button type="button" class="row" data-pid="' + st.id +
                '" data-tip="' + escAttr(st.src || '') + '">' +
                '<span class="sw" style="background:' + propTint(v) + '"></span>' +
                'x ' + st.x0 + '\u2013' + st.x1 + ' \u00b7 y ' + st.ylo +
                '\u2013' + st.yhi +
                ' <b class="n">' + v + '</b>' +
                '<b class="go" data-act="go" style="pointer-events:auto">\u2316</b></button>');
        }
        el.innerHTML = '<span class="head">candidate streets ' +
            '(' + counts.ok + ' ok / ' + counts.bad + ' bad / ' +
            counts.pending + ' pending' + (propApi ? ' \u00b7 sqlite' : ' \u00b7 local') +
            ')</span>' + rows.join('');
        var btns = el.querySelectorAll('button.row');
        for (var j = 0; j < btns.length; j++) {
            (function (btn) {
                var id = parseInt(btn.getAttribute('data-pid'), 10);
                btn.addEventListener('click', function (e) {
                    var t = e && e.target;
                    if (t && t.classList && t.classList.contains('go')) {
                        gotoStreet(id);       // ⌖ = center camera on the street
                        return;
                    }
                    var cur = CityTerrain.PROPOSED.verdicts[id];
                    var next = !cur ? 'ok' : (cur === 'ok' ? 'bad' : 'pending');
                    setPropVerdict(id, next);
                });
                btn.addEventListener('mouseenter', function () {
                    terrain.hoverProposed = id;
                    markDirty();
                });
                btn.addEventListener('mouseleave', function () {
                    if (terrain.hoverProposed === id) terrain.hoverProposed = null;
                    markDirty();
                });
            })(btns[j]);
        }
    }
    function gotoStreet(id) {
        var S = CityTerrain.PROPOSED.streets;
        for (var i = 0; i < S.length; i++) {
            if (S[i].id !== id) continue;
            var st = S[i];
            if (!proposedOn) {              // the point is to SEE the street
                proposedOn = true;
                try { localStorage.setItem(PROPSW_KEY, '1'); } catch (e) { /* private mode */ }
                applyProposedMode();
            }
            centerOnTile((st.x0 + st.x1 + 1) / 2 - M.ox,
                (st.ylo + st.yhi + 1) / 2 - M.oy);
            cam.zoom = CAM.ZOOM.rest;
            markDirty();
            return;
        }
    }
    function setPropVerdict(id, verdict) {
        var lv = localVerdicts();
        if (verdict === 'pending') delete lv[id]; else lv[id] = verdict;
        try { localStorage.setItem(PROPVR_KEY, JSON.stringify(lv)); }
        catch (e) { /* private mode */ }
        if (verdict === 'pending') delete CityTerrain.PROPOSED.verdicts[id];
        else CityTerrain.PROPOSED.verdicts[id] = verdict;
        if (propApi && typeof fetch === 'function') {
            fetch(B + 'api/streets.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'verdict', id: id, verdict: verdict })
            }).catch(function () { /* offline mirror already saved */ });
        }
        buildPropPanel();
        markDirty();
    }
    function applyLocalVerdicts() {
        var lv = localVerdicts();
        for (var id in lv)
            if (Object.prototype.hasOwnProperty.call(lv, id))
                CityTerrain.PROPOSED.verdicts[id] = lv[id];
    }
    function refreshProposed() {
        if (!propApi || typeof fetch !== 'function') return;
        fetch(B + 'api/streets.php', { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
            .then(function (d) {
                if (!d || !Array.isArray(d.streets) || !d.streets.length) return;
                CityTerrain.PROPOSED.streets = d.streets.map(function (s) {
                    return {
                        id: +s.id, x0: +s.x0, x1: +s.x1,
                        ylo: +s.ylo, yhi: +s.yhi, src: s.src || ''
                    };
                });
                for (var vid in CityTerrain.PROPOSED.verdicts)
                    if (Object.prototype.hasOwnProperty.call(CityTerrain.PROPOSED.verdicts, vid))
                        delete CityTerrain.PROPOSED.verdicts[vid];
                if (d.verdicts)
                    for (var id in d.verdicts)
                        if (Object.prototype.hasOwnProperty.call(d.verdicts, id))
                            CityTerrain.PROPOSED.verdicts[id] = d.verdicts[id];
                applyLocalVerdicts();           // offline edits win until re-POST
                buildPropPanel();
                markDirty();
            })
            .catch(function () { /* keep current list */ });
    }
    function proposeStreet(e) {
        var r = stage.getBoundingClientRect();
        var w = CAM.screenToWorld(cam, e.clientX - r.left, e.clientY - r.top, VW, VH);
        var t = CAM.worldToTile(w.x, w.y);
        var gx = Math.floor(t.x) + M.ox, gy = Math.floor(t.y) + M.oy;
        var T = terrain.visibleTileRect(cam, VW, VH);
        var ylo = Math.max(0, Math.min(T.y0, gy) + M.oy);
        var yhi = Math.min(1086, Math.max(T.y1, gy) + M.oy);
        if (propApi && typeof fetch === 'function') {
            fetch(B + 'api/streets.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'add', x0: gx, x1: gx + 1, ylo: ylo, yhi: yhi,
                    src: 'user shift+click @ y' + gy
                })
            }).then(function (r2) { return r2.ok ? r2.json() : Promise.reject(); })
                .then(refreshProposed)
                .catch(function () { /* server said no; nothing to show */ });
        } else {
            var S = CityTerrain.PROPOSED.streets;
            for (var i = 0; i < S.length; i++)
                if (S[i].x0 === gx && S[i].ylo === ylo) return;   // dedupe
            S.push({
                id: -((Date.now() / 1000) | 0) % 1000000,
                x0: gx, x1: gx + 1, ylo: ylo, yhi: yhi,
                src: 'user shift+click @ y' + gy + ' (local — offline)'
            });
            buildPropPanel();
            markDirty();
        }
    }
    (function initProposed() {
        try { proposedOn = localStorage.getItem(PROPSW_KEY) === '1'; }
        catch (e) { /* private mode */ }
        applyLocalVerdicts();
        applyProposedMode();
        buildPropPanel();                       // built-in list, sync
        if (typeof fetch === 'function') {      // server list wins when present
            fetch(B + 'api/streets.php', { cache: 'no-store' })
                .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
                .then(function (d) {
                    if (d && Array.isArray(d.streets) && d.streets.length) {
                        propApi = true;
                        refreshProposed();
                    }
                })
                .catch(function () { /* built-in list stays */ });
        }
    })();
    if ($('btn-proposed')) $('btn-proposed').addEventListener('click', function () {
        proposedOn = !proposedOn;
        try { localStorage.setItem(PROPSW_KEY, proposedOn ? '1' : '0'); }
        catch (e) { /* private mode */ }
        applyProposedMode();
        markDirty();
    });

    /* ---- HUD (legend panels) --------------------------------------------------- */
    function togglePanel(el, head, items, isOff, setVis) {
        var rows = ['<span class="headbar"><span class="head">' + head + '</span>' +
            '<button type="button" class="mini" data-all="1" ' +
            'data-tip="show every layer in this panel">show all</button>' +
            '<button type="button" class="mini" data-all="0" ' +
            'data-tip="hide every layer in this panel">hide all</button></span>'];
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            rows.push('<button type="button" class="row" data-type="' + it.key +
                '" aria-pressed="true" data-tip="click to hide/show this layer">' +
                '<span class="sw" style="background:rgb(' + it.rgb.join(',') + ')"></span>' +
                it.key + (it.count != null ? ' <b class="n">' + it.count + '</b>' : '') +
                '</button>');
        }
        el.innerHTML = rows.join('');
        var btns = el.querySelectorAll('button.row');   // same order as items
        for (var j = 0; j < btns.length; j++) {
            (function (btn) {
                btn.addEventListener('click', function () {
                    var t = btn.getAttribute('data-type');
                    var show = isOff(t);                      // toggle
                    setVis(t, show);
                    btn.setAttribute('aria-pressed', show ? 'true' : 'false');
                    btn.classList.toggle('off', !show);
                    markDirty();
                });
            })(btns[j]);
        }
        var minis = el.querySelectorAll('button.mini');
        for (var k = 0; k < minis.length; k++) {
            minis[k].addEventListener('click', function () {
                var on = this.getAttribute('data-all') === '1';
                for (var n = 0; n < items.length; n++) {
                    setVis(items[n].key, on);
                    btns[n].setAttribute('aria-pressed', on ? 'true' : 'false');
                    btns[n].classList.toggle('off', !on);
                }
                markDirty();
            });
        }
    }
    function buildLegend() {
        var items = [{ key: 'grass', rgb: M.grass }];
        for (var i = 0; i < M.layers.length; i++)
            items.push({ key: M.layers[i].n, rgb: M.layers[i].c });
        togglePanel($('legend'), 'ground', items,
            function (t) { return terrain.isHidden(t); },
            function (t, on) {
                terrain.setVisible(t, on);
                terrFlatDirty = true;
                applyTypeVisibility();           // tile-space sprites honour the toggle
                // a tile whose layer was just hidden must not stay selected
                if (!on && selected && selected.kind === 't' && selected.type === t)
                    setSel(null);
            });
        var fbtn = document.createElement('button');
        fbtn.type = 'button';
        fbtn.className = 'row';
        fbtn.setAttribute('data-tip',
            'hide engine-generated filler grids: SAND lattice, park-path/KLSROAD ' +
            'singles, road dashes not touching a full road segment');
        fbtn.innerHTML = '<span class="sw" style="background:#b9a76a"></span>speckle filter';
        function markSpeck() {
            fbtn.setAttribute('aria-pressed', terrain.speckleFilter ? 'true' : 'false');
            fbtn.classList.toggle('off', !terrain.speckleFilter);
        }
        fbtn.addEventListener('click', function () {
            speckOn = !terrain.speckleFilter;
            terrain.setSpeckleFilter(speckOn);
            terrFlatDirty = true;
            buildGround();
            try { localStorage.setItem(SPECK_KEY, speckOn ? '1' : '0'); }
            catch (e) { /* private mode */ }
            // filler tiles must not stay selected once filtered out
            if (speckOn && selected && selected.kind === 't') setSel(null);
            markSpeck();
            markDirty();
        });
        markSpeck();
        $('legend').appendChild(fbtn);
    }
    function buildObjLegend() {
        var counts = CityObjects.countCats(M.buildings, M.binfo);
        var items = [{ key: 'buildings', rgb: M.pal[0], count: counts[CityObjects.FALLBACK] }];
        for (var i = 0; i < CityObjects.CATS.length; i++)
            items.push({ key: CityObjects.CATS[i].key, rgb: CityObjects.CATS[i].sw,
                count: counts[CityObjects.CATS[i].key] });
        items.push({ key: 'people', rgb: M.charcol, count: M.chars.length });
        togglePanel($('objlegend'), 'objects', items,
            function (t) { return !!objHidden[t]; },
            function (t, on) {
                if (on) delete objHidden[t]; else objHidden[t] = true;
                bAtlas = null;          // orbit LOD blits per-bucket canvases
                bFlatDirty = true;
                // an element on a hidden bucket must not stay selected/outlined
                if (!on && selected) {
                    if (selected.kind === 'c' && t === 'people') setSel(null);
                    else if (selected.kind === 'b' && byMi[selected.i].cat === t) setSel(null);
                }
            });
        if (M.walks && M.walks.length && typeof CityWalks !== 'undefined') {
            var wbtn = document.createElement('button');
            wbtn.type = 'button';
            wbtn.className = 'row';
            wbtn.setAttribute('data-tip',
                'cyan = cached character walk paths from the save (pathCache); ' +
                'amber = candidate template streets they reveal (off saved roads, ' +
                'grid x\u22613 mod 4 cols / y\u22610 mod 4 rows)');
            var nc = walkCensus ? walkCensus.cols.length : 0,
                nr = walkCensus ? walkCensus.rows.length : 0;
            wbtn.innerHTML = '<span class="sw" style="background:#00e5ff"></span>walk paths' +
                ' <b class="n">' + M.walks.length + ' \u00b7 ' + nc + 'c/' + nr + 'r</b>';
            function markWalk() {
                wbtn.setAttribute('aria-pressed', walksOn ? 'true' : 'false');
                wbtn.classList.toggle('off', !walksOn);
            }
            wbtn.addEventListener('click', function () {
                walksOn = !walksOn;
                try { localStorage.setItem(WALK_KEY, walksOn ? '1' : '0'); }
                catch (e) { /* private mode */ }
                markWalk();
                markDirty();
            });
            markWalk();
            $('objlegend').appendChild(wbtn);
        }
        if (typeof CityMarkers !== 'undefined') {
            var head = document.createElement('div');
            head.className = 'mhead';
            head.textContent = 'mark tiles';
            var ta = document.createElement('textarea');
            ta.id = 'markinput';
            ta.rows = 2;
            ta.spellcheck = false;
            ta.placeholder = '(120,12) (116,20) …';
            ta.value = markerText;
            ta.setAttribute('data-tip',
                'paste tile coordinates — every pair is marked with a yellow ' +
                'diamond; town tiles, the same numbers the tile-grid hover ' +
                'readout shows (grid = town + ' + M.ox + ',' + M.oy + ')');
            var mstat = document.createElement('div');
            mstat.className = 'mstat';
            function updateStat() {
                mstat.textContent = markerPts.length
                    ? markerPts.length + ' marked · '
                      + 'double-click a mark to centre' : '';
            }
            ta.addEventListener('input', function () {
                markerPts = CityMarkers.parse(ta.value);
                try { localStorage.setItem(MARKER_KEY, ta.value); }
                catch (e) { /* private mode */ }
                updateStat();
                markDirty();
            });
            updateStat();
            $('objlegend').appendChild(head);
            $('objlegend').appendChild(ta);
            $('objlegend').appendChild(mstat);
        }
    }
    function buildStats() {
        $('statsbar').innerHTML =
            '<b>' + M.buildings.length.toLocaleString() + '</b> buildings · ' +
            '<b>' + M.chars.length + '</b> characters · ' +
            '<b>' + buildings.length + '</b> drawn · ' +
            '<b id="perfread">…</b>';              // frame diagnostics (loop)
    }

    /* ---- resize -------------------------------------------------------------- */
    function resize() {
        dpr = window.devicePixelRatio || 1;
        VW = stage.clientWidth; VH = stage.clientHeight;
        markDirty();
    }
    window.addEventListener('resize', resize);

    /* ---- boot ---------------------------------------------------------------- */
    var resOpt = QP.get('dpr') ? (parseFloat(QP.get('dpr')) || 1)
                               : Math.min(window.devicePixelRatio || 1, 2);
    app.init({
        canvas: cv,
        resizeTo: stage,
        background: 0x000000,
        backgroundAlpha: 0,
        antialias: true,
        autoDensity: true,
        resolution: resOpt,
        autoStart: false,
        preference: 'webgl'               // WebGL-only: no Canvas fallback
    }).then(function () {
        makeScene();
        recomputeManhOff();
        buildGround();
        buildLegend();
        buildObjLegend();
        bindBeachUI();
        buildStats();
        resize();
        if (restoreCam()) {
            lastPreset = null;                   // resumed view: no active preset
            setOn(null);
        } else {
            presetSpringfield();
            lastPreset = presetSpringfield;
            setOn('btn-springfield');
        }
        updateOrientReadout();
        started = true;
        try {
            console.info('[city-view-pixi] renderer: ' +
                (app.renderer.type || app.renderer.constructor.name) +
                ' · resolution ' + resOpt);
        } catch (e) { /* no console */ }
        requestAnimationFrame(loop);
    }).catch(function (err) {
        $('statsbar').textContent = 'PixiJS init failed (WebGL required): ' + err;
    });
})();