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
    var ASSET_V = '?v=20261025.8';
    /* Manifest-only buster: the bridge frame entries (bridgetop_f0/f5,
       bridgebottom_f0/f1) landed after ASSET_V's last bump, and the four new
       PNGs are new filenames. Bumping ASSET_V instead would re-download all
       12k city sprites to pick up four entries. */
    var MANIFEST_V = '?v=20261026.1';
    function cityUrl(p) { return B + 'assets/city/' + p + ASSET_V; }

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
       exposes the counters for console + harness. */
    var ALOAD = { boot: 4, bootDone: 0, pend: 0, artGot: 0, artKnown: 0, artDead: 0 };
    window.__ASSETS = ALOAD;
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
                (ALOAD.artDead ? ' \u00b7 ' + ALOAD.artDead + ' dead' : '');
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
    aPaint();                               // "assets 0/4" before anything lands

    /* ---- texture cache ---------------------------------------------------------
       Every sprite texture comes from a plain Image element (file:// safe —
       PIXI.Assets.load's fetch path is not), wrapped in a PIXI.Texture once
       it decodes. texFor(url) returns null while loading/failed and marks
       the scene dirty on settle, mirroring city-view.js's imgFor. */
    var texs = {};
    function texFor(url) {
        var r = texs[url];
        if (r === undefined) {
            ALOAD.pend++; aPaintSoon();     // streams through the asset pill
            r = texs[url] = { st: 0, tex: null, subs: {} };
            var im = new Image();
            im.onload = function () {
                try { r.tex = PIXI.Texture.from(im); r.st = 1; }
                catch (e) { r.st = -1; ALOAD.artDead++; }
                ALOAD.pend--; ALOAD.artGot++; markDirty(); aPaintSoon();
            };
            im.onerror = function () {      // degrade to block/dot
                r.st = -1;
                ALOAD.pend--; ALOAD.artDead++; markDirty(); aPaintSoon();
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
    function dropTex(url) {                 // anim LRU eviction: free the decode
        var r = texs[url];
        if (!r) return;
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
       Placement re-uses the sheet-cell transform: box space = sheet px / 4
       in the 127x66 sheet box whose inscribed diamond IS the tile, so one
       block is one sprite at anchor 0.5 / rotation 45deg / scale
       (SHEET_SX, SHEET_SY) / 4, centred at the same linear box->tile map
       the pass sprites use: (ux, uy) -> (cx + ux - uy, cy + ux + uy).
       The calibration (ox, oy) comes from C_Shadow, which fills its crop
       exactly with the diamond; the deck crops sit ~30 px ABOVE it (the
       deck is elevated), so calibrating on them would sink the tile.
       State rule (art-derived — the binary's setter was not pinned, notes/09
       §12): the Normal_* states pick their legs by which lower edge faces
       water — PostLeft iff the lower-LEFT neighbour (tx, ty+1) is water,
       PostRight iff (tx+1, ty) is. */
    var PIERART_KEY = 'mrsnrub.cityview.pierart';
    var pierArtOn = true;                         // ships ON: fills alone are unreadable
    var PIER = null;                              // assets/city/pier-tiles.json
    var pierRecs = [];
    (function () {
        if (typeof fetch !== 'function') return;
        fetch(B + 'assets/city/pier-tiles.json')
            .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
            .then(function (j) {
                PIER = j;
                for (var k in j.assets) texFor(B + j.assets[k].sheet);
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
        /* box -> tile map from the live camera: box px are SCREEN-aligned
           (the frame is a billboard whose deck is raised straight up), so
           scale the 127x66 box onto the cell's screen diamond and pull that
           back through the inverse of the ground matrix's linear part. Same
           result as a fixed 45deg rotation under the default ORIENT, but it
           stays upright under Rotate/Mirror too. The ratio is
           zoom-independent; setOrient rebuilds the ground. */
        var A = CAM.tileAffine(cam, VW, VH);
        var det = A.a * A.e - A.b * A.d;
        var i00 = A.e / det, i01 = -A.b / det, i10 = -A.d / det, i11 = A.a / det;
        var kx = big * (Math.abs(A.a) + Math.abs(A.b)) / 127,   // screen px per box px
            ky = big * (Math.abs(A.d) + Math.abs(A.e)) / 66;
        for (var i = 0; i < blocks.length; i++) {
            var k = blocks[i], sx = k.m[0], sy = k.m[3];
            var t = subTex(sheet, k.c[0], k.c[1], k.c[2], k.c[3]);
            if (!t) continue;
            var s = new PIXI.Sprite(t);
            s.anchor.set(0.5);
            /* drawn-block centre in box px; a<0 mirrors about the anchor, so
               x is the block's RIGHT edge there */
            var bx = (k.p[0] + (sx >= 0 ? 1 : -1) * k.c[2] * Math.abs(sx) / 2) / 4 + a.calib.ox;
            var by = (k.p[1] + (sy >= 0 ? 1 : -1) * k.c[3] * Math.abs(sy) / 2) / 4 + a.calib.oy;
            var ex = (bx - 63.5) * kx, ey = (by - 33) * ky;      // screen offset
            var fx = sx * kx / 4, fy = sy * ky / 4;              // sheet px -> screen
            s.setFromMatrix(new PIXI.Matrix(i00 * fx, i10 * fx, i01 * fy, i11 * fy,
                tx + big / 2 + i00 * ex + i01 * ey, ty + big / 2 + i10 * ex + i11 * ey));
            s.visible = false;
            parent.addChild(s);
            arr.push(s);
            out.push(s);
        }
        return out.length ? out : null;
    }
    function applyPierMode() {
        /* brush art: the opaque C_Shadow block covers the whole diamond, so
           the flat fill only has to stop bleeding past its tile (same trick
           applyDirtMode uses) */
        for (var i = 0; i < pierRecs.length; i++) {
            var r = pierRecs[i];
            var vis = pierArtOn && !!pierTexReady(r.tn) && !terrain.hidden[r.tn];
            for (var k = 0; k < r.art.length; k++) r.art[k].visible = vis;
            r.fill.width = r.fill.height = vis ? 1 : 1 + BLEED;
        }
        var b = $('btn-pierart');
        if (b) b.classList.toggle('on', pierArtOn && !!pierTexReady('boardwalk'));
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
    var togglers = {};                    // slug -> engine click-state-machine
    var behav = null;                     // slug -> {idle, tap} (v2 manifest)
    var animNow = 0;                      // ms, one clock per rendered frame
    var animLive = 0;                     // animated sprites in the last frame
    var charAnimLive = 0;                 // animating character sprites
    var charPreview = null;               // {cid, cell} — card-driven preview
                                          // (CharVariants tile click)
    var CHAR_ANIM_MIN_PX = QP.get('charAnimMinPx') !== null
        ? (Math.abs(QP.get('charAnimMinPx') | 0)) : 24;
    var animNextT = 0;
    var ANIM_MAX_BLITS = QP.get('animMax') !== null
        ? Math.max(0, parseInt(QP.get('animMax'), 10) || 0) : 96;
    var animBudget = 0;                   // blits left this rendered frame
    var ANIM_MIN_PX = QP.get('animMinPx') !== null
        ? Math.max(0, parseInt(QP.get('animMinPx'), 10) || 0) : 48;
    var ANIM_MAX_ATLAS_PX = 16e6;
    var ANIM_BIG_ATLAS_PX = 6e6;
    var ANIM_BIG_MAX = 8;
    var ANIM_CACHE_MAX = 40;
    var animBigLive = 0;
    var ANIM_HUGE_MAX = 4;
    var animHuge = {};                    // oversize filmstrip url -> strip png
    var animLru = [];                     // filmstrip urls, most-recent last
    (function loadAnims() {
        fetch(cityUrl('city-anims.json')).then(function (r) {
            return r.ok ? r.json() : null;
        }).then(function (j) {
            if (!j || !j.anims) return;
            anims = {}; taps = {}; togglers = {};
            behav = j.behavior || null;
            for (var s in j.anims) {
                var list = j.anims[s];     // generator sorts loops longest-first
                if (!list || !list.length) continue;
                var loop = behav ? pickAnim(list, behav[s] && behav[s].idle)
                                 : list[0];
                var tap = behav ? pickAnim(list, behav[s] && behav[s].tap)
                                : null;
                if (loop && loop.frames > 1) anims[s] = { cells: [loop], base: 0 };
                else if (behav && behav[s] && behav[s].layers) {
                    var cs = [], seen = [], li;
                    for (li = 0; li < behav[s].layers.length; li++) {
                        var e = pickAnim(list, behav[s].layers[li]);
                        if (e && e.frames >= 1 && seen.indexOf(e.anim) < 0) {
                            seen.push(e.anim); cs.push(e);
                        }
                    }
                    if (cs.length) anims[s] = { cells: cs, base: 1 };
                }
                if (tap && tap.frames > 1 && tap !== loop) taps[s] = tap;
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
                    if (rec2) togglers[s] = rec2;
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
    function animKey(b) {                 // strips follow the DRAWN sprite
        if (!b.slug) return null;
        if (!b.flip) return b.slug;
        return (citySprites && citySprites[b.slug + 'flipped'])
            ? b.slug + 'flipped' : null;
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
            var tfi = Math.floor((animNow - tp.t0) * tp.a.fps / 1000);
            if (tfi >= tp.a.frames) {
                b._tap = null;
                if (tp.then !== undefined) b._tog = tp.then;
            }
            else {
                // taps skip the blit budget; every one-shot is click-driven,
                // so like the toggle transitions it is exempt from the
                // huge-atlas cap — the big rotor strips of the police/
                // attack/burns helis are plain taps
                var r = animCell(tp.a, k, tfi, true);
                if (r) { r.tap = 1; return { cells: [r], base: 0, tap: 1 }; }
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
                    : (Math.floor(animNow * a.fps / 1000) + ph) % a.frames,
                    true);
                return c ? { cells: [c], base: 0 } : null;
            }
        }
        var rec = anims[key];
        if (!rec) return null;
        var cells = null;
        for (var i = 0; i < rec.cells.length; i++) {
            var a2 = rec.cells[i];
            var c2 = animCell(a2, k, (Math.floor(animNow * a2.fps / 1000) + ph) % a2.frames);
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
        return { a: a, fi: fi };
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
        return (Math.floor((nowMs === undefined ? animNow : nowMs) *
                           a.fps / 1000) + ph) % a.frames;
    }
    window.__CV_ANIM_FI = function (slug, b, nowMs) {   // smoke-test probe
        if (!anims || !anims[slug]) return -1;
        return animFrame(anims[slug].cells[0], b, nowMs);
    };
    window.__CV_ANIM_layers = function (slug) {         // smoke-test probe
        var r = anims && anims[slug];
        return r ? { n: r.cells.length, base: r.base,
                     anims: r.cells.map(function (a) { return a.anim; }) } : null;
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
                    ? { a: tg.out, t0: performance.now(), then: 0 }
                    : { a: tg['in'], t0: performance.now(), then: 1 };
            } else if (tg.kind === 'active') {
                b._tog = b._tog ? 0 : 1;
            } else {
                b._tog = ((b._tog | 0) + 1) % tg.poses.length;
            }
            markDirty();
            return true;
        }
        var t = taps[key];
        if (!t) return false;
        b._tap = { a: t, t0: performance.now() };
        markDirty();
        return true;
    }
    function blockAtTile(tx, ty) {
        for (var k = buildings.length - 1; k >= 0; k--) {   // front-to-back
            var b = buildings[k];
            if (objHidden[b.cat]) continue;
            if (tx >= b.x0 && tx < b.x1 && ty >= b.y0 && ty < b.y1) return b;
        }
        return null;
    }
    window.__CV_TAP = function (mi, fire) {  // console/harness: inspect/fire
        var b = byMi[mi];
        if (!b) return -1;
        if (fire) tapBuilding(b);
        if (!b._tap) return -1;
        var fi = Math.floor((performance.now() - b._tap.t0) *
                            b._tap.a.fps / 1000);
        return fi < b._tap.a.frames ? fi : -1;
    };
    window.__CV_TAP_at = function (tx, ty, fire) {  // harness: lot rule
        var b = blockAtTile(tx, ty);
        if (!b) return -1;
        if (fire) tapBuilding(b);
        if (!b._tap) return -1;
        var fi = Math.floor((performance.now() - b._tap.t0) *
                            b._tap.a.fps / 1000);
        return fi < b._tap.a.frames ? fi : -1;
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
        if (b._tap) return b._tap.a.anim;
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
    /* the huge-slot budget is a SESSION cap and click-driven one-shots keep
       arriving (heli rotor taps): recycle the oldest huge entry that no
       building is mid-animation on. */
    function freeHugeSlot() {
        var i, b, live = {};
        for (i = 0; i < buildings.length; i++) {
            b = buildings[i];
            if (b._tap) live[b._tap.a.png] = 1;
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
            if (!animHuge[old] || live[animHuge[old]]) continue;
            delete animHuge[old];               // frees the oversize slot
            animLru.splice(i, 1);
            dropTex(old);                       // a still-visible one reloads
            return true;
        }
        return false;
    }
    /* filmstrip request point: enforces the big-atlas session budget and
       the LRU bound. Returns the decoded texture, null = draw the static
       PNG instead (budget spent / still decoding). */
    function animAtlasFor(a, click) {
        var url = cityUrl(a.png);
        if (!(url in texs)) {                 // first request this session
            if (a.px > ANIM_MAX_ATLAS_PX ||
                (click && a.px > ANIM_BIG_ATLAS_PX)) {
                // oversize: only the click-driven paths (toggle machines
                // and tap one-shots) ever ask, so it rides the small
                // oversize session pool — recycled by freeHugeSlot(), not
                // the big-tier budget (which is for loops the map picked
                // on its own and is never released: the ziffcorp heli tap
                // at 15.7M sat just under MAX and starved there)
                if (!animHuge[url]) {
                    if (Object.keys(animHuge).length >= ANIM_HUGE_MAX &&
                        !freeHugeSlot()) return null;
                    animHuge[url] = a.png;
                }
            } else if (a.px > ANIM_BIG_ATLAS_PX) {
                if (animBigLive >= ANIM_BIG_MAX) return null;
                animBigLive++;
            }
            animLru.push(url);
            while (animLru.length > ANIM_CACHE_MAX) {
                var old = animLru.shift();    // oldest touched url dies first
                delete animHuge[old];
                dropTex(old);                 // a still-visible one reloads
            }
        } else {                              // touch -> most-recently-used
            var i = animLru.indexOf(url);
            if (i < 0) animLru.push(url);
            else if (i < animLru.length - 1) {
                animLru.splice(i, 1);
                animLru.push(url);
            }
        }
        return texFor(url);
    }
    window.__CV_ANIM_stats = function () {    // console/harness telemetry
        return { big: animBigLive, bigMax: ANIM_BIG_MAX,
                 lru: animLru.length, lruMax: ANIM_CACHE_MAX,
                 capPx: ANIM_MAX_ATLAS_PX, bigPx: ANIM_BIG_ATLAS_PX };
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
    function saveCam() {
        try {
            var t = CAM.worldToTile(cam.x, cam.y);
            localStorage.setItem(CAM_KEY, JSON.stringify(
                { tx: t.x, ty: t.y, zoom: cam.zoom }));
        } catch (e) { /* private mode */ }
    }
    function restoreCam() {              // true if a saved view was applied
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
                depth: front[0] + front[1],
                ox1: front[0]
            };
            buildings.push(blk);
            byMi[i] = blk;
            catOfMi[i] = blk.cat;
        }
        buildings.sort(function (a, b) { return a.depth - b.depth || a.ox1 - b.ox1; });
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
    function charFrameFile(as, id, k) {
        var fr = as.frames;
        if (!fr || !fr.length) return as.png;
        if (fr.length < 2 || !animOn || !artMode ||
            Math.max(as.w, as.h) * k < CHAR_ANIM_MIN_PX) return fr[0].file;
        if (as._tot === undefined) {
            var tot = 0, i;
            for (i = 0; i < fr.length; i++) tot += fr[i].delay || 100;
            as._tot = tot || 1;
        }
        var h = 0, s = String(id), j;
        for (j = 0; j < s.length; j++) h = (h * 31 + s.charCodeAt(j)) | 0;
        h = Math.abs(h);
        // one play, then a randomised hold on the standby frame (2-7 s,
        // like the client's time-between-anims); loops long enough to read
        // as an "active" idle wait at least another loop-length before
        // replaying, so long gags don't run back-to-back
        var gap = 2000 + (h >>> 4) % 5000 + (as._tot > 1200 ? as._tot : 0);
        var t = ((animNow || performance.now()) + h) % (as._tot + gap);
        if (t >= as._tot) return fr[0].file;    // standby between plays
        for (j = 0; j < fr.length; j++) {
            t -= (fr[j].delay || 100);
            if (t < 0) return fr[j].file;
        }
        return fr[fr.length - 1].file;
    }
    function charAnimating(as, k) {
        return !!(as.frames && as.frames.length > 1 && animOn && artMode &&
                  Math.max(as.w, as.h) * k >= CHAR_ANIM_MIN_PX);
    }
    /* the art asset to draw for a character: the card's preview cell wins
       over the manifest pick — shared by the scene pass and the click
       hit-test so both agree on the drawn sprite rect */
    function charArtOf(c) {
        if (!artMode || !charMan) return null;
        if (charPreview && String(charPreview.cid) === String(c[0]))
            return charPreview.cell;
        var rec = charMan.characters[c[0]];
        return (rec && charMan.assets[rec.slug]) || null;
    }
    /* preview playback: replay the chosen cell continuously (one pass on
       its own delays, 1.2 s hold on the standby frame) — steadier than
       the crowd's 2-7 s randomised blink gaps, this is an inspection loop */
    function charPreviewFrame(as) {
        var fr = as.frames;
        if (!fr || !fr.length || !animOn)
            return (fr && fr[0] || { file: as.png }).file;
        if (as._ptot === undefined) {
            var tot = 0, i;
            for (i = 0; i < fr.length; i++) tot += fr[i].delay || 100;
            as._ptot = tot || 1;
        }
        var t = (animNow || performance.now()) % (as._ptot + 1200);
        for (i = 0; i < fr.length; i++) {
            t -= (fr[i].delay || 100);
            if (t < 0) return fr[i].file;
        }
        return fr[0].file;
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
        grassFillS, seaFillS, sceneG, fragG, propG, walkG, gridG, markG, outG,
        txtGrid, txtMark, bridgeG, raisedG, bridgeNearG;
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

        walkG = new PIXI.Graphics();
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
        app.stage.addChild(bridgeG);
        app.stage.addChild(raisedG);
        app.stage.addChild(bridgeNearG);
        app.stage.addChild(sceneG);
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
        for (i = 0; i < pierCells.length; i++) {
            var pc = pierCells[i];
            /* the brushes are 4x4 cells on the land's cell lattice (town
               x = -48 + 4c, y = -112 + 4r): one frame per cell, at its
               origin tile; the other 15 tiles keep only their fills */
            if ((pc.tx & 3) || (pc.ty & 3)) continue;
            var art = buildPierCell(featC, pc.tn, pc.tx, pc.ty, pc.occ, pc.arr, 4);
            if (art) pierRecs.push({ art: art, tn: pc.tn, fill: pc.fill });
        }
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
        pool: 0, ver: '2026-10-28.1'
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

    function render() {
        var t0 = performance.now();
        animNow = t0;                     // one clock per frame: instances agree
        animLive = 0;
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

    /* ---- scene pass: buildings + people in ONE depth-ordered pool ----------- */
    function renderScene(A, s, T, lod) {
        var i, b;
        if (!lod) {
            renderBridges(A, s, T);           // deck art into bridgeG (under sceneG)
            var art = !!artMode && !!citySprites;
            var k = s / ART.S;
            var mgn = art ? 6 : 2;
            for (i = 0; i < buildings.length; i++) {
                b = buildings[i];
                if (objHidden[b.cat]) continue;
                if (b.x1 < T.x0 - mgn || b.x0 > T.x1 + mgn ||
                    b.y1 < T.y0 - mgn || b.y0 > T.y1 + mgn) continue;
                if (art && emitBuilding(b, k, A)) continue;
                emitBlock(b, A, s);
            }
        }
        if (!objHidden.people) {
            var artC = !!artMode && !!charMan;
            var kc = s / ART.S;
            var rpx = Math.max(1.6, CityObjects.PEOPLE_R * Math.min(2.2, s / 40));
            var dots = null, ch = M.chars;
            for (i = 0; i < ch.length; i++) {
                var c = ch[i];
                if (c[1] < T.x0 - 1 || c[1] > T.x1 + 1 ||
                    c[2] < T.y0 - 1 || c[2] > T.y1 + 1) continue;
                var cxw = c[1], cyw = c[2];
                var x = A.a * cxw + A.b * cyw + A.c,
                    y = A.d * cxw + A.e * cyw + A.f;
                if (x < -4 || x > VW + 4 || y < -4 || y > VH + 4) continue;
                if (artC && !lod) {
                    var as2 = charArtOf(c);
                    if (as2 && !(as2.w * kc < 12 && as2.h * kc < 12)) {
                        var url = B + 'assets/characters/' +
                            (charPreview && charPreview.cell === as2
                                ? charPreviewFrame(as2)
                                : charFrameFile(as2, c[0], kc));
                        if (charAnimating(as2, kc)) charAnimLive++;
                        var t = texFor(url);
                        if (t) { emitSpr(t, x - as2.anchor[0] * kc,
                                         y - as2.anchor[1] * kc,
                                         as2.w * kc, as2.h * kc); continue; }
                    }
                }
                if (!dots) dots = [];
                dots.push(x, y);
            }
            peopleDots = dots ? dots.length / 2 : 0;
            for (i = 0; dots && i < dots.length; i += 2)
                emitDot(dots[i], dots[i + 1], rpx, rgbHex(M.charcol));
        } else peopleDots = 0;
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
        var sp = spriteEntry(key);
        if (!sp) return false;
        if (sp.w * k < 12 && sp.h * k < 12) return false;   // readability gate
        var url = cityUrl(sp.png);
        var baseTex = texFor(url);
        if (!baseTex) return false;
        var gx = ART.ref === 'origin' ? b.x0 : b.px;
        var gy = ART.ref === 'origin' ? b.y0 : b.py;
        var wx = gx + ART.ax, wy = gy + ART.ay;
        var px = A.a * wx + A.b * wy + A.c;
        var py = A.d * wx + A.e * wy + A.f;
        var bl = px - (mir ? sp.w - sp.anchor[0] : sp.anchor[0]) * k;
        var an = animOf(b, k);            // filmstrip cells instead of the PNG?
        if (an) {
            var drew = 0, i, j, ok = 1;
            // a layer cell may legitimately be as big as the body it hides
            var cap = an.base ? Math.max(4096, Math.max(sp.w, sp.h) * k) : 2048;
            for (i = 0; i < an.cells.length; i++) {
                var c0 = an.cells[i], st = c0.a;
                if (!animAtlasFor(st, c0.tap) ||
                    Math.max(st.cellw, st.cellh) * k > cap) {
                    if (an.base) ok = 0;  // stack must draw whole, or not at all
                }
            }
            if (ok) {
                if (an.base) {            // multi-part body: PNG under the cells
                    emitSpr(baseTex, bl, py - sp.anchor[1] * k,
                            sp.w * k, sp.h * k, mir);
                    drew = 1;
                }
                for (i = 0; i < an.cells.length; i++) {
                    var c = an.cells[i], a = c.a, fi = c.fi;
                    if (!animAtlasFor(a, c.tap)) continue;   // decoding / budget spent
                    if (a.sub) {                      // sparse strip: blit its rects
                        var rs = a.sub[fi] || [];
                        for (j = 0; j < rs.length; j++) {
                            var r = rs[j], rw = r.w * k, rh = r.h * k;
                            var rx = px + r.ox * k, ry = py + r.oy * k;
                            if (rx + rw < -4 || rx > VW + 4 ||
                                ry + rh < -4 || ry > VH + 4) continue;
                            var rt = subTex(cityUrl(a.png),
                                            r.sx, r.sy, r.w, r.h);
                            if (!rt) continue;
                            emitSpr(rt, rx, ry, rw, rh);
                            drew++;
                        }
                        continue;
                    }
                    var aw = a.cellw * k, ah = a.cellh * k;
                    var ax0 = px - a.ax * k, ay0 = py - a.ay * k;
                    if (ax0 + aw < -4 || ax0 > VW + 4 || ay0 + ah < -4 || ay0 > VH + 4)
                        continue;         // truly off-screen: skip
                    var ct = subTex(cityUrl(a.png),
                                    (fi % a.cols) * a.cellw,
                                    Math.floor(fi / a.cols) * a.cellh,
                                    a.cellw, a.cellh);
                    if (!ct) continue;
                    emitSpr(ct, ax0, ay0, aw, ah);
                    drew++;
                }
            }
            if (drew) { animLive++; if (!an.tap) animBudget--; return true; }
            // nothing blitted (decoding / off-screen / stack rejected):
            // fall through to the static PNG
        }
        emitSpr(baseTex, bl, py - sp.anchor[1] * k, sp.w * k, sp.h * k, mir);
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
                if (objHidden[wb.cat]) continue;
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
    window.addEventListener('pagehide', function () {
        if (started) saveCam();                  // flush on refresh/close
    });
    function loop(t) {
        requestAnimationFrame(loop);
        var dt = lastT ? Math.min(0.05, (t - lastT) / 1000) : 0;
        lastT = t;
        if (cam.vx || cam.vy) { CAM.tick(cam, dt); markDirty(); }
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
        } else if ((animLive || charAnimLive) && artMode && animOn && t >= animNextT) {
            // keep the filmstrips and character idle loops moving: last
            // frame drew animated sprites, so schedule the next cell swap
            animNextT = t + 90;
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
                ' · v' + DIAG.ver;
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
            '<div class="pinnote">Selected — Esc or clicking a ground tile deselects.' +
            ' Enter in the search box centers matches.</div>';
    }
    function charHtml(i) {
        var c = M.chars[i];
        var name = M.charNames[c[0]];
        var count = 0;
        for (var k = 0; k < M.chars.length; k++) if (M.chars[k][0] === c[0]) count++;
        var rec = charMan && charMan.characters[c[0]];
        return '<h3>' + esc(name || 'char #' + c[0]) + '</h3>' +
            '<div class="tagrow"><span class="tag">character <b>#' + c[0] + '</b></span>' +
            '<span class="tag"><b>' + count + '</b>&times; in save</span></div>' +
            '<table><tr><td>position</td><td>' + c[1] + ', ' + c[2] + '</td></tr>' +
            '<tr><td>name resolved</td><td>' +
            (name ? 'yes (character catalog)' : 'no') + '</td></tr>' +
            '<tr><td>map asset</td><td>' +
            (rec ? esc(rec.slug) : 'none &mdash; drawn as a dot') + '</td></tr></table>' +
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
            var v = AssetVariants.render(e && e[2]);
            if (v) details.appendChild(v);
        }
        // family strip under the character card (families/<cid>.json sidecar)
        if (sel && sel.kind === 'c' && window.CharVariants) {
            var ch = M.chars[sel.i];
            var fv = CharVariants.render(ch[0], M.charNames[ch[0]], {
                onPreview: function (cell) {
                    charPreview = cell ? { cid: ch[0], cell: cell } : null;
                    markDirty();
                }
            });
            if (fv) details.appendChild(fv);
        }
        markResultSel();
        markDirty();
    }
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
                var as4 = art ? charArtOf(M.chars[i]) : null;
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
            if (objHidden[b.cat]) continue;
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
        var rows = ['<span class="head">' + head + '</span>'];
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            rows.push('<button type="button" class="row" data-type="' + it.key +
                '" aria-pressed="true" data-tip="click to hide/show this layer">' +
                '<span class="sw" style="background:rgb(' + it.rgb.join(',') + ')"></span>' +
                it.key + (it.count != null ? ' <b class="n">' + it.count + '</b>' : '') +
                '</button>');
        }
        el.innerHTML = rows.join('');
        var btns = el.querySelectorAll('button.row');
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