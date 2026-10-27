/* road-lab — standalone footpath / carriageway tuning sandbox.
 *
 * Self-contained (no camera/terrain/data deps): shows enlarged examples of the
 * saved road-cell types from road-spec.json — N/S (mask m), E/W (mask d) and
 * 'P' pavement — with steppers for footpath width/side per orientation. The
 * live reference block below the canvases is the output: copy it and hand it
 * over to port into spec-view / terrain art.
 *
 * Geometry is in TOWN TILES inside one 4x4 cell (a cell is 4x4 tiles; nibble
 * masks use E=1 W=2 N=4 S=8, rows grow south):
 *   ns.w1 = west footpath width, ns.w2 = east footpath width (0..3, sum <= 3)
 *   ew.w1 = north footpath, ew.w2 = south footpath
 *   carriageway = whatever is left (>= 1 tile).
 *
 * Examples are placed on a (col,row) cell grid so cells abut seamlessly in
 * both top-down and 2:1 iso modes (same oblique transform as camera.js).
 */
(function () {
    'use strict';

    var P = {
        tile: 4,                    // tiles per cell edge
        ns:  { w1: 1, w2: 1 },      // west / east footpath widths
        ew:  { w1: 1, w2: 1 },      // north / south footpath widths
        colors: {
            asphalt: '#5c5c62',
            footpath: '#9c9ca3',
            pavement: '#7e7e85',
            grass: 'rgb(74,128,66)',
            kerb: 'rgba(20,20,24,0.55)',
            lattice: 'rgba(255,255,255,0.18)',
            cellEdge: 'rgba(0,0,0,0.35)',
            dim: '#ffe86e',
            label: '#cfd6df',
        },
        footTone: 0,                // shade steps on footpath (−4..+4)
        paveTone: 0,                // shade steps on pavement (−4..+4)
        kerb: true,
        lattice: true,
        dims: true,
        iso: false,                 // 2:1 oblique (matches camera.js) vs top-down
    };

    var S = 28;                     // px per tile

    function $(id) { return document.getElementById(id); }
    function fmt(n) { return (Math.round(n * 1000) / 1000).toString(); }

    function shade(hex, steps) {
        // steps of ±6% lightness, clamped to [8, 247].
        var m3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
        var r, g, b;
        if (m3) {
            r = parseInt(m3[1] + m3[1], 16); g = parseInt(m3[2] + m3[2], 16); b = parseInt(m3[3] + m3[3], 16);
        } else {
            r = parseInt(hex.substr(1, 2), 16); g = parseInt(hex.substr(3, 2), 16); b = parseInt(hex.substr(5, 2), 16);
        }
        var d = steps * 15;
        function cl(v) { return Math.max(8, Math.min(247, v + d)); }
        function hx(v) { return ('0' + cl(v).toString(16)).slice(-2); }
        return '#' + hx(r) + hx(g) + hx(b);
    }

    /* ---------------- the mapper ----------------
     * Cell-local tile coords (fractional OK) -> canvas px. Top-down for
     * measuring; iso applies the same 2:1 oblique as camera.js
     * (hw = S/2, hh = S/4) so the artist sees what the engine draws. */
    function mapper(ctx, ox, oy) {
        var hw = S / 2, hh = S / 4;
        function pt(tx, ty) {
            if (P.iso) return [ox + (tx - ty) * hw, oy + (tx + ty) * hh];
            return [ox + tx * S, oy + ty * S];
        }
        return {
            poly: function (pts) {
                ctx.beginPath();
                for (var j = 0; j < pts.length; j++) {
                    var p = pt(pts[j][0], pts[j][1]);
                    if (j) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]);
                }
                ctx.closePath();
            },
            fill: function (color) { ctx.fillStyle = color; ctx.fill(); },
            rect: function (x0, y0, x1, y1, color) {
                this.poly([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
                this.fill(color);
            },
            line: function (x1, y1, x2, y2) {
                var a = pt(x1, y1), b = pt(x2, y2);
                ctx.beginPath();
                ctx.moveTo(a[0], a[1]);
                ctx.lineTo(b[0], b[1]);
                ctx.stroke();
            },
            pt: pt,
        };
    }

    /* Cell-grid placement: cells at integer (col,row) abut seamlessly.
     * gutter adds px between separate examples only. */
    function origin(base, col, row, gutter) {
        gutter = gutter || [0, 0];
        if (P.iso) {
            return [
                base[0] + (col - row) * P.tile * (S / 2) + gutter[0],
                base[1] + (col + row) * P.tile * (S / 4) + gutter[1],
            ];
        }
        return [base[0] + col * P.tile * S + gutter[0], base[1] + row * P.tile * S + gutter[1]];
    }

    /* ---------------- cell drawing ----------------
     * Road axes run through the carriageway strip left over by the footpaths;
     * junction arms use the same axes so neighbouring cells meet. */

    function carAxisNS() { return P.ns.w1 + (P.tile - P.ns.w1 - P.ns.w2) / 2; } // x-centre
    function carAxisEW() { return P.ew.w1 + (P.tile - P.ew.w1 - P.ew.w2) / 2; } // y-centre

    /* kind: 'ns' | 'ew' | 'pave'; conn: edges to extend asphalt stubs to. */
    function drawCell(ctx, ox, oy, kind, conn) {
        var m = mapper(ctx, ox, oy);
        var T = P.tile;
        var asphalt = P.colors.asphalt;
        var foot = shade(P.colors.footpath, P.footTone);
        var pave = shade(P.colors.pavement, P.paveTone);
        conn = conn || {};

        if (kind === 'pave') {
            m.rect(0, 0, T, T, pave);
        } else if (kind === 'ns') {
            var w1 = P.ns.w1, w2 = P.ns.w2, cw = T - w1 - w2;
            if (w1 > 0) m.rect(0, 0, w1, T, foot);
            if (w2 > 0) m.rect(T - w2, 0, T, T, foot);
            m.rect(w1, 0, w1 + cw, T, asphalt);
            if (conn.w) m.rect(0, carAxisNS() - cw / 2, w1, carAxisNS() + cw / 2, asphalt);
            if (conn.e) m.rect(w1 + cw, carAxisNS() - cw / 2, T, carAxisNS() + cw / 2, asphalt);
        } else { // ew
            var v1 = P.ew.w1, v2 = P.ew.w2, ch = T - v1 - v2;
            if (v1 > 0) m.rect(0, 0, T, v1, foot);
            if (v2 > 0) m.rect(0, T - v2, T, T, foot);
            m.rect(0, v1, T, v1 + ch, asphalt);
            if (conn.n) m.rect(carAxisEW() - ch / 2, 0, carAxisEW() + ch / 2, v1, asphalt);
            if (conn.s) m.rect(carAxisEW() - ch / 2, v1 + ch, carAxisEW() + ch / 2, T, asphalt);
        }

        // sub-tile lattice (top-down only; iso lattice would need axis-aligned lines)
        if (P.lattice && !P.iso && kind !== 'pave') {
            ctx.strokeStyle = P.colors.lattice;
            ctx.lineWidth = 1;
            for (var i = 1; i < T; i++) {
                m.line(i, 0, i, T);
                m.line(0, i, T, i);
            }
        }
        // kerb lines between footpath and carriageway
        if (P.kerb && kind !== 'pave') {
            ctx.strokeStyle = P.colors.kerb;
            ctx.lineWidth = 2;
            if (kind === 'ns') {
                if (P.ns.w1 > 0) m.line(P.ns.w1, 0, P.ns.w1, T);
                if (P.ns.w2 > 0) m.line(T - P.ns.w2, 0, T - P.ns.w2, T);
            } else {
                if (P.ew.w1 > 0) m.line(0, P.ew.w1, T, P.ew.w1);
                if (P.ew.w2 > 0) m.line(0, T - P.ew.w2, T, T - P.ew.w2);
            }
        }
        // cell edge (so individual cells stay readable when abutting)
        ctx.strokeStyle = P.colors.cellEdge;
        ctx.lineWidth = 1;
        m.line(0, 0, T, 0); m.line(T, 0, T, T); m.line(T, T, 0, T); m.line(0, T, 0, 0);
    }

    /* ---------------- section helpers ---------------- */

    function clear(cv) {
        var ctx = cv.getContext('2d');
        ctx.fillStyle = P.colors.grass;
        ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.font = '12px ui-monospace, Menlo, Consolas, monospace';
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';
        return ctx;
    }

    /* Draw one example cell; label sits above the cell's top-left corner. */
    function cell(ctx, base, col, row, gutter, kind, conn, label) {
        var o = origin(base, col, row, gutter);
        drawCell(ctx, o[0], o[1], kind, conn);
        if (label) {
            ctx.fillStyle = P.colors.label;
            var ty = P.iso ? o[1] - 18 : o[1] - 16;
            ctx.fillText(label, P.iso ? o[0] - 30 : o[0], ty);
        }
        return o;
    }

    function dimArrowH(ctx, x0, y, x1, label) {
        if (!P.dims || P.iso) return;
        ctx.strokeStyle = P.colors.dim;
        ctx.fillStyle = P.colors.dim;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x0 + 2, y); ctx.lineTo(x1 - 2, y);
        ctx.moveTo(x0 + 2, y - 3); ctx.lineTo(x0 + 2, y + 3);
        ctx.moveTo(x1 - 2, y - 3); ctx.lineTo(x1 - 2, y + 3);
        ctx.stroke();
        ctx.textAlign = 'center';
        ctx.fillText(label, (x0 + x1) / 2, y + 4);
        ctx.textAlign = 'left';
    }

    function dimArrowV(ctx, x, y0, y1, label) {
        if (!P.dims || P.iso) return;
        ctx.strokeStyle = P.colors.dim;
        ctx.fillStyle = P.colors.dim;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y0 + 2); ctx.lineTo(x, y1 - 2);
        ctx.moveTo(x - 3, y0 + 2); ctx.lineTo(x + 3, y0 + 2);
        ctx.moveTo(x - 3, y1 - 2); ctx.lineTo(x + 3, y1 - 2);
        ctx.stroke();
        ctx.fillText(label, x + 6, (y0 + y1) / 2 - 6);
    }

    /* width callouts under an N/S cell: w1 | carriageway | w2 */
    function dimsNS(ctx, o) {
        var y = o[1] + P.tile * S + 10;
        var w1 = P.ns.w1, w2 = P.ns.w2, cw = P.tile - w1 - w2;
        var x = o[0];
        if (w1 > 0) { dimArrowH(ctx, x, y, x + w1 * S, fmt(w1)); x += w1 * S; }
        dimArrowH(ctx, x, y, x + cw * S, fmt(cw));
        x += cw * S;
        if (w2 > 0) dimArrowH(ctx, x, y, x + w2 * S, fmt(w2));
    }

    /* width callouts beside an E/W cell: w1 / carriageway / w2 */
    function dimsEW(ctx, o) {
        var x = o[0] + P.tile * S + 8;
        var v1 = P.ew.w1, v2 = P.ew.w2, ch = P.tile - v1 - v2;
        var y = o[1];
        if (v1 > 0) { dimArrowV(ctx, x, y, y + v1 * S, fmt(v1)); y += v1 * S; }
        dimArrowV(ctx, x, y, y + ch * S, fmt(ch));
        y += ch * S;
        if (v2 > 0) dimArrowV(ctx, x, y, y + v2 * S, fmt(v2));
    }

    /* ---------------- sections ---------------- */

    function renderNS() {
        var ctx = clear($('cv-ns'));
        var base = [24, 46 + (P.iso ? 40 : 0)];
        var g = [P.tile * S + 40, 0];   // px gutter between examples

        // 1) through road: 3 cells stacked south (continuous N+S)
        cell(ctx, base, 0, 0, [0, 0], 'ns', { n: 1, s: 1 });
        cell(ctx, base, 0, 1, [0, 0], 'ns', { n: 1, s: 1 });
        cell(ctx, base, 0, 2, [0, 0], 'ns', { n: 1, s: 1 }, 'through road (N+S)');
        dimsNS(ctx, origin(base, 0, 1, [0, 0]));

        // 2) N+S with an east junction arm
        var b2 = [base[0] + g[0], base[1]];
        cell(ctx, b2, 0, 0, [0, 0], 'ns', { n: 1, s: 1, e: 1 }, 'N+S + E arm');
        cell(ctx, b2, 1, 0, [0, 0], 'ns', { n: 1, s: 1 });

        // 3) flanked by pavement on both sides
        var b3 = [base[0] + 2 * g[0] + P.tile * S, base[1]];
        cell(ctx, b3, 0, 0, [0, 0], 'pave', {}, 'flanked by pavement');
        cell(ctx, b3, 1, 0, [0, 0], 'ns', { n: 1, s: 1 });
        cell(ctx, b3, 2, 0, [0, 0], 'pave', {});
    }

    function renderEW() {
        var ctx = clear($('cv-ew'));
        var base = [24, 46 + (P.iso ? 40 : 0)];
        var g = [P.tile * S + 56, 0];

        // 1) through road: 3 cells stacked east (continuous E+W)
        cell(ctx, base, 0, 0, [0, 0], 'ew', { e: 1, w: 1 });
        cell(ctx, base, 1, 0, [0, 0], 'ew', { e: 1, w: 1 });
        cell(ctx, base, 2, 0, [0, 0], 'ew', { e: 1, w: 1 }, 'through road (E+W)');
        dimsEW(ctx, origin(base, 1, 0, [0, 0]));

        // 2) E+W with a south junction arm
        var b2 = [base[0] + g[0] + P.tile * S, base[1]];
        cell(ctx, b2, 0, 0, [0, 0], 'ew', { e: 1, w: 1, s: 1 }, 'E+W + S arm');
        cell(ctx, b2, 0, 1, [0, 0], 'ew', { e: 1, w: 1 });

        // 3) flanked by pavement above and below
        var b3 = [base[0] + 2 * g[0] + 2 * P.tile * S, base[1]];
        cell(ctx, b3, 0, 0, [0, 0], 'pave', {}, 'flanked by pavement');
        cell(ctx, b3, 0, 1, [0, 0], 'ew', { e: 1, w: 1 });
        cell(ctx, b3, 0, 2, [0, 0], 'pave', {});
    }

    function renderPave() {
        var ctx = clear($('cv-pave'));
        var base = [24, 46 + (P.iso ? 40 : 0)];

        // 1) 3×3 slab
        for (var r = 0; r < 3; r++) {
            for (var c = 0; c < 3; c++) {
                cell(ctx, base, c, r, [0, 0], 'pave', {},
                    (r === 0 && c === 0) ? '3×3 slab' : null);
            }
        }

        // 2) road abutting a pavement block (road keeps its own footpath)
        var b2 = [base[0] + 4 * P.tile * S + 72, base[1]];
        cell(ctx, b2, 0, 0, [0, 0], 'ns', { n: 1, s: 1 }, 'road + pavement');
        cell(ctx, b2, 1, 0, [0, 0], 'pave', {});
        cell(ctx, b2, 1, 1, [0, 0], 'pave', {});
        cell(ctx, b2, 0, 1, [0, 0], 'pave', {});
    }

    /* ---------------- road art sheet inspector ----------------
     * Loads the real roadrivertiles packs and shows:
     *   1. the full 512x512 sheet with the 135x74 diamond-lattice overlaid
     *      (every tile the pack ships, used ones numbered),
     *   2. the 11 RE'd RoadDrawer states enlarged, raw box vs diamond clip,
     *   3. how the viewer composes a cell from them: the base slot drawn as
     *      the full-cell diamond + one kerb/paving band piece per grass
     *      side, the piece clipped between the outer diamond and a copy
     *      scaled S about the centre (S = 1 - FW/2 puts the strip exactly
     *      on the footpath width above).
     * Slot geometry (js/terrain.js + notes/06 s10): slot (c,r) centre =
     * (274 + 135c + (r odd ? 67.5 : 0), 140 + 37r), 127x66 inset box; -100
     * packs are 2x resolution (scale by w/512).
     */
    var PACKS = [
        ['roadrivertiles-50 (viewer base)', '../assets/dlc/roadrivertiles-50/images/roadtilesheet.png'],
        ['roadrivertiles-100 (hi-res)', '../assets/dlc/roadrivertiles-100/images/roadtilesheet.png'],
        ['ice — XMAS2017 LTD (viewer winter)', '../assets/dlc/XMAS2017_RiverRoadTiles_LTD-50-r492453/images/iceroadtilesheet.png'],
        ['GreenRivers (XMAS2014)', '../assets/dlc/GreenRiversGame-50-r72858/images/roadtilesheet.png'],
        ['StPatricks2015', '../assets/dlc/StPatricks2015Game_LTD-50-r177279/images/roadtilesheet.png'],
        ['ChristmasGame', '../assets/dlc/ChristmasGame-50/images/roadtilesheet.png'],
        ['Blargsgiving RiverRoadTiles', '../assets/dlc/Blargsgiving_RiverRoadTiles-50-r490898/images/roadtilesheet.png'],
        ['AtomSmasher RiverRoadTiles', '../assets/dlc/TheAtomSmasher_RiverRoadTiles-50-r490898/images/roadtilesheet.png'],
        ['tutorialgame', '../assets/dlc/tutorialgame-50-r457914/images/roadtilesheet.png'],
        ['XMAS2015 snow', '../assets/dlc/XMAS2015_Environment_Snow-50-r272024/images/roadtilesheet.png'],
    ];
    var STATES = [
        [-1, 7], [-1, 5], [-1, 6], [-2, 5], [-1, 4], [-1, 1],
        [-2, 1], [-1, -1], [-1, 3], [-2, 3], [-1, 2],
    ];
    /* Art content measured pixel-by-pixel from roadtilesheet.png against the
       engine UV->corner map (2026-10-25): sheet diamond vertex L->screen TL,
       T->BL, B->TR, R->BR, so each diamond edge-triangle lands on one world
       edge of the quadrant square. 'kerb X' = bright sidewalk/kerb art fills
       that edge's triangle; the closed edge always gets the kerb. */
    var STATE_WHAT = [
        'full paving slab (flag-byte interior)',
        'both edges closed — kerb corner W+N (NW/ES shared; ES draws it flipped -> E+S)',
        'both edges open — plain paving, small kerb at outer corner',
        'one edge open — kerb along W (NW: N-only; ES draws flipped -> kerb S)',
        'one edge open — kerb along N (NW: W-only; ES draws flipped -> kerb E)',
        'NE both closed — kerb corner N+E',
        'NE both open — paving, small kerb at outer corner',
        'NE one edge open — kerb N (E-only); N-only case draws flipped -> kerb E',
        'WS both closed — kerb corner W+S',
        'WS both open — paving, small kerb at outer corner',
        'WS one edge open — kerb W (S-only); W-only case draws flipped -> kerb S',
    ];
    /* The RE'd engine model (libscorpio.so RoadDrawer selector 0x1208058 +
       draw pass 0x1208c04/0x12095e8, 2026-10-25, notes/08): every road cell
       (4x4 tiles) draws ONE UV rect per QUADRANT — sub-coords (x&3,y&3) in
       {(0,0),(2,0),(0,2),(2,2)} — chosen from the quadrant's two cell edges.
       There is NO base+clip composition and NO second kerb pass: the paving
       and kerb live inside the state art itself. Edge "pass" = connectivity
       nibble bit (record byte[4] & 0xf; E=1,W=2,N=4,S=8) OR (neighbour
       contains-test && neighbour record solid). Flag byte bit5 picks state 0
       (full slab) outright. No coordinate-parity variant selection exists.
       The selector ALSO emits a flip byte (w5 bit0 at the emitter: swaps the
       UV pair (f2,f3)<->(f4,f5), i.e. mirrors the sampled rect): forced to 1
       on the whole (2,2) path (0x1208644) — that is how the ES quadrant
       reuses the NW corner family mirrored — and set on the NE/WS
       "one-edge-open" cmp routes (0x12087cc / 0x120883c) so state 7/10 can
       put their single kerb band on the closed edge for both sub-cases
       (art itself has kerb N in 7 and kerb W in 10, pixel-measured).
       Family table exactly as decoded (leaf addresses in notes/08): */
    var ENGINE_FAM = {
        nw: { both: 2, first: 3, second: 4, none: 1 },   // first=N, second=W
        ne: { both: 6, one: 7, none: 5 },                 // N,E
        ws: { both: 9, one: 10, none: 8 },                // W,S
        es: { both: 2, first: 3, second: 4, none: 1 },    // first=E, second=S
    };
    function engStates(pass) {
        function fam2(f, a, b) { return a && b ? f.both : a ? f.first : b ? f.second : f.none; }
        function fam1(f, a, b) { return a && b ? f.both : (a || b) ? f.one : f.none; }
        return {
            nw: fam2(ENGINE_FAM.nw, pass.n, pass.w),
            ne: fam1(ENGINE_FAM.ne, pass.n, pass.e),
            ws: fam1(ENGINE_FAM.ws, pass.w, pass.s),
            es: fam2(ENGINE_FAM.es, pass.e, pass.s),
        };
    }
    /* Selector flip byte per quadrant (out flag at the emitter, w5 & 1):
       (2,2)/ES forces out=1 for every result (0x1208644), mirroring the
       reused NW corner family onto the E/S edges; NE/WS set it on the
       one-edge-open route when the FIRST edge passes, so the single kerb
       band of state 7/10 lands on the CLOSED edge (measured: 7=kerb N,
       10=kerb W un-mirrored). Verified against the sheet art, 2026-10-25. */
    function engFlip(pass, q) {
        if (q === 'es') return true;
        if (q === 'ne') return !!pass.n && !pass.e;   // N-only -> mirror (kerb E)
        if (q === 'ws') return !!pass.w && !pass.s;   // W-only -> mirror (kerb S)
        return false;
    }
    var ART = {
        pack: 0, img: null, failed: false,
        zoom: 2, grid: true, raw: false,
        mask: { e: true, w: true, n: false, s: false },  // cell nibble
        probe: { e: false, w: false, n: false, s: false }, // neighbour-solid OR-in
        force: -1, forceAuto: true,                       // -1 = engine table
        flip: false,
    };
    function effPass() {
        var o = {};
        for (var d of ['e', 'w', 'n', 's']) o[d] = !!(ART.mask[d] || ART.probe[d]);
        return o;
    }
    function quadPick(pass, q) {
        if (ART.forceAuto) return engStates(pass)[q];
        return ART.force;
    }

    function loadPack() {
        ART.failed = false; ART.img = null;
        if (typeof Image === 'undefined') { renderArt(); return; }   // harness
        var im = new Image();
        im.onload = function () { ART.img = im; renderArt(); };
        im.onerror = function () { ART.failed = true; renderArt(); };
        im.src = PACKS[ART.pack][1];
    }

    /* slot source rect in image px */
    function slotRect(im, st) {
        var k = im.naturalWidth / 512;
        var s = STATES[st];
        return {
            x: (274 + 135 * s[0] + ((((s[1] % 2) + 2) % 2)) * 67.5 - 63.5) * k,
            y: (140 + 37 * s[1] - 33) * k,
            w: 127 * k, h: 66 * k, k: k,
        };
    }
    /* blit one state slot into a square, exactly as the engine GPU does it:
       the world square samples the state's UV PARALLELOGRAM — the sheet UV
       quad is the 127x66 inset box's inscribed diamond, and the emitter maps
       its vertices (f0,f1)=top -> (minX,maxZ), (f2,f3)=right -> (maxX,maxZ),
       (f4,f5)=left -> (minX,minZ), (f6,f7)=bottom -> (maxX,minZ). On a
       north-up screen that is x=k(u+v), y=k(u-v): rot45 with the box's v
       axis NEGATED (plain rot45 transposes the art across the main diagonal
       — pixel-measured against the kerb art, 2026-10-25). flip mirrors u
       (the emitter's (f2,f3)<->(f4,f5) corner swap). raw=true draws the
       un-rotated sheet box so you can see the slot's sheet packing. */
    function blitSlot(ctx, im, st, x0, y0, size, flip) {
        var r = slotRect(im, st);
        ctx.save();
        if (ART.raw) {
            ctx.beginPath();
            ctx.rect(x0, y0, size, size);
            ctx.clip();
            ctx.drawImage(im, r.x, r.y, r.w, r.h, x0, y0, size, size);
        } else {
            /* the rot45+v-flip transform maps the box's inscribed DIAMOND
               exactly onto the square, but canvas draws the whole 127x66
               rect — the corner junk lands in a 2x-oversized diamond around
               the square. Clip to the square so only the sampled art shows
               (matches the engine, and stops neighbouring slots bleeding
               into each other). */
            ctx.beginPath();
            ctx.rect(x0, y0, size, size);
            ctx.clip();
            ctx.translate(x0 + size / 2, y0 + size / 2);
            ctx.rotate(Math.PI / 4);
            ctx.scale((flip ? -1 : 1) * size * Math.SQRT2 / 127, -size * Math.SQRT2 / 66);
            ctx.drawImage(im, r.x, r.y, r.w, r.h, -63.5, -33, 127, 66);
        }
        ctx.restore();
    }
    /* engine-model cell: 4 quadrant quads (2x2 tiles each), each sampling
       one full state rect chosen by engStates for its edge pair, drawn with
       the selector's flip byte (engFlip) XOR the user mirror toggle */
    function blitEngineCell(ctx, im, pass, x0, y0, size) {
        function q(qn) {
            var f = engFlip(pass, qn) !== ART.flip;   // engine byte XOR user mirror
            blitSlot(ctx, im, quadPick(pass, qn), x0 + (qn === 'ne' || qn === 'es' ? size / 2 : 0),
                y0 + (qn === 'ws' || qn === 'es' ? size / 2 : 0), size / 2, f);
        }
        q('nw'); q('ne'); q('ws'); q('es');
    }

    /* ---------------- water / river model (RiverDrawer) ----------------
       RiverDrawer is RoadDrawer's own subclass in the engine (RTTI
       11RiverDrawer @0x3fc30f -> 10RoadDrawer -> 13RoadMapDrawer; vptr
       0x1a2bf30, ctor 0x1099264). Its build wrapper 0x1099f20 loads the
       river selector 0x1099f8c into x1 and branches into 0x1208c10 — the
       SAME body the road selector 0x1208058 falls through to (0x1208c04) —
       so everything measured for roads in notes/08 carries over verbatim:
       one 4x4 cell draws 4 quadrant quads, each sampling ONE full UV
       parallelogram, corner map T->BL R->BR L->TL B->TR, and the (2,2)/ES
       quadrant forces the mirror byte.
       The 11 quads below are the float table at .rodata 0x3fc320 (11 x 32B,
       four (u,v) corners in T,R,L,B order, x512 = roadtilesheet.png px).
       They land on the 13 sheet cells the road census left unused, i.e.
       river art is the other half of the same lattice on the same sheet
       (which is why the pack is called roadrivertiles). All 11 entries are
       referenced from the selector (18 adrp+add sites); unlike roads there
       is no identity fallback entry, and the selector never calls the
       special-flag helper 0x1134cfc — so roads' "flag -> full slab" route
       is absent and entries 0/1 have traded roles: river 1 is the open-water
       slab (roads' 0) and river 0 the two-bank shore corner (roads' 1).
       Everything else matches the road family table index-for-index. */
    var RIVER_QUADS = [
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
    /* lattice slot (col,row) of each quad, for the captions */
    var RIVER_SLOTS = [
        [0, -2], [-1, 9], [0, 6], [0, 4], [0, 2], [0, 8],
        [-1, 0], [-1, -2], [-2, 7], [-2, 9], [-1, 8],
    ];
    /* Art content pixel-measured from roadtilesheet.png through the engine's
       UV->corner map (2026-10-26): the baked world square is classified
       blue-dominant (water) vs the rest, and each edge's 25% band decides
       OPEN (>=50% water) or BANKED (<25% water). Percent = whole-square
       water coverage. The bank always sits on the CLOSED edge, exactly like
       the road kerb does. */
    var RIVER_WHAT = [
        'both edges banked — shore corner N+W (roads’ state 1 role)',
        'full open-water slab (roads’ state 0 role)',
        'all edges open — plain water interior',
        'one edge banked — bank along W (N-open case)',
        'one edge banked — bank along N (W-open case)',
        'NE both banked — shore corner N+E',
        'NE all open — plain water',
        'NE one edge banked — bank N',
        'WS both banked — shore corner W+S',
        'WS all open — plain water',
        'WS one edge banked — bank W',
    ];
    var RIVER_COVER = [39, 100, 95, 78, 62, 29, 87, 60, 53, 97, 81];
    /* Quadrant family table: the road model with 0/1 exchanged (see above).
       first/second follow the selector's csel order, verified against the
       bank art (3 banks W, 4 banks N). */
    var RIVER_FAM = {
        nw: { both: 2, first: 3, second: 4, none: 0 },   // first=N, second=W
        ne: { both: 6, one: 7, none: 5 },                 // N,E
        ws: { both: 9, one: 10, none: 8 },                // W,S
        es: { both: 2, first: 3, second: 4, none: 0 },    // first=E, second=S
    };
    function rivStates(pass) {
        function fam2(f, a, b) { return a && b ? f.both : a ? f.first : b ? f.second : f.none; }
        function fam1(f, a, b) { return a && b ? f.both : (a || b) ? f.one : f.none; }
        return {
            nw: fam2(RIVER_FAM.nw, pass.n, pass.w),
            ne: fam1(RIVER_FAM.ne, pass.n, pass.e),
            ws: fam1(RIVER_FAM.ws, pass.w, pass.s),
            es: fam2(RIVER_FAM.es, pass.e, pass.s),
        };
    }
    /* Flip byte: the emitter code is shared with roads, so the same rules
       apply — the ES quadrant always mirrors (reusing the NW corner family
       onto E/S), and the NE/WS one-edge-banked cases mirror so the single
       bank lands on the CLOSED edge. The mirror is the road emitter's
       ANTI-DIAGONAL reflection, not a u-mirror: 2026-10-26 re-measure on the
       water art itself confirmed it (flipped state 0 banks E+S, 7 banks E,
       10 banks S; a u-mirror leaves the S/E band open water instead). */
    function rivFlip(pass, q) {
        if (q === 'es') return true;
        if (q === 'ne') return !!pass.n && !pass.e;
        if (q === 'ws') return !!pass.w && !pass.s;
        return false;
    }
    /* The wave overlay is a SEPARATE asset (the RE's BGSprite under the
       drawer's [drawer+0x80] BGSceneSpriteNode): WaterAnims =
       wateranimations.png + .bsv3, a 0x0103 scene whose cells include the
       thin C_Water_ / C_Ripple_ strips used as shimmer marks. The engine
       re-picks one every 3 s (timer [drawer+0x88]) with rand() ~50/50
       between two frames (0x143abe8). Exact frame binding is UNPROVEN —
       shown here for review, not as a ported contract. */
    var WAVE_ASSET = '../assets/dlc/game-50/images/wateranimations.png';
    var WAVE_CELLS = [
        ['C_Water_01', 154, 21, 32, 8], ['C_Water_02', 153, 11, 33, 8],
        ['C_Water_03', 153, 1, 33, 8], ['C_Water_04', 79, 37, 34, 8],
        ['C_Water_05', 115, 13, 34, 8], ['C_Water_06', 149, 53, 14, 2],
        ['C_Water_07', 107, 59, 20, 3], ['C_Water_08', 94, 64, 23, 5],
        ['C_Water_09', 35, 18, 34, 6], ['C_Water_10', 75, 17, 33, 5],
        ['C_Ripple_06', 1, 27, 42, 16], ['C_Ripple_07', 35, 1, 38, 15],
        ['C_Ripple_08', 35, 72, 36, 14], ['C_Ripple_09', 117, 23, 35, 14],
        ['C_Ripple_10', 75, 1, 38, 14],
    ];

    var WATER = {
        pack: 0, img: null, failed: false,
        zoom: 2, grid: true, raw: false,
        mask: { e: true, w: true, n: false, s: false },
        probe: { e: false, w: false, n: false, s: false },
        force: -1, forceAuto: true,
        flip: false,
        wave: null, waveFailed: false,
    };
    function wEffPass() {
        var o = {};
        for (var d of ['e', 'w', 'n', 's']) o[d] = !!(WATER.mask[d] || WATER.probe[d]);
        return o;
    }
    function rivPick(pass, q) {
        if (WATER.forceAuto) return rivStates(pass)[q];
        return WATER.force;
    }
    function loadWaterPack() {
        WATER.failed = false; WATER.img = null;
        if (typeof Image === 'undefined') { renderWater(); return; }   // harness
        var im = new Image();
        im.onload = function () { WATER.img = im; renderWater(); };
        im.onerror = function () { WATER.failed = true; renderWater(); };
        im.src = PACKS[WATER.pack][1];
        var wv = new Image();
        wv.onload = function () { WATER.wave = wv; renderWater(); };
        wv.onerror = function () { WATER.waveFailed = true; renderWater(); };
        wv.src = WAVE_ASSET;
    }
    /* source bbox of one state quad, in sheet px (512 space); tbl defaults
       to the river table (water tab), the dirt tab passes ROAD_QUADS */
    function quadBox(st, tbl) {
        tbl = tbl || RIVER_QUADS;
        var xs = [0, 1, 2, 3].map(function (i) { return tbl[st][i][0]; });
        var ys = [0, 1, 2, 3].map(function (i) { return tbl[st][i][1]; });
        var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
        var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
        return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    /* The sheet->device CTM that blits one state exactly as the GPU samples
       it. The world square (u,v) maps to sheet point L + u*(B-L) + v*(T-L)
       — the corner map the road emitter proved (L->TL T->BL B->TR R->BR).
       The engine's flip is NOT a horizontal mirror: the road bake recipe
       (notes/09 §6 step 3, verified here against the bank art) samples the
       flipped state as O=R, E=-(T-L), S=-(B-L), i.e. the world square is
       reflected in the ANTI-DIAGONAL: (u,v) -> M(1-v,1-u). Corner check:
       (0,0)->R (1,0)->B (0,1)->T (1,1)->L — B/T keep their corners, L/R
       swap — and the 2026-10-26 re-check showed this puts the bank exactly
       on the closed edge (state 0 flipped banks E+S, 7 banks E, 10 banks S)
       while a u-mirror leaves the S band open. In canvas terms the flip
       swaps the two rows of the CTM and negates them (the road tab reaches
       the same map by negating x inside a rotate(45) frame). */
    function uvCTM(st, x0, y0, size, flip, tbl) {
        var q = (tbl || RIVER_QUADS)[st];
        var L = q[2], T = q[0], B = q[3];
        var Ex = B[0] - L[0], Ey = B[1] - L[1];       // u axis
        var Sx = T[0] - L[0], Sy = T[1] - L[1];       // v axis
        var det = Ex * Sy - Ey * Sx;
        var m00 = size * Sy / det, m01 = -size * Sx / det;   // device-X row
        var m10 = -size * Ey / det, m11 = size * Ex / det;   // device-Y row
        var a, b, c, d, ox, oy;
        if (flip) {
            a = -m10; c = -m11; b = -m00; d = -m01;   // anti-diagonal
            ox = x0 + size; oy = y0 + size;
        } else {
            a = m00; c = m01; b = m10; d = m11;
            ox = x0; oy = y0;
        }
        return [a, b, c, d, ox - (a * L[0] + c * L[1]), oy - (b * L[0] + d * L[1])];
    }
    /* Blit one state. The destination rect carries the source bbox in sheet
       space so only the CTM has to be right; the clip to the world square
       keeps the corner junk around the parallelogram from ever showing. */
    /* Base CTM for the quadrant blits: the sheet/water tabs run on identity
       (null here); the bridge tab sets it to the ground tileAffine so its
       cells draw in TILE space under the 2:1 oblique, exactly like the
       viewer's groundC children. blitQuad composes onto this and restores
       it, instead of the old hard reset to identity. */
    var LAB_BASE_MTX = null;
    function labSetBase(ctx) {
        if (LAB_BASE_MTX) ctx.setTransform(LAB_BASE_MTX[0], LAB_BASE_MTX[1],
            LAB_BASE_MTX[2], LAB_BASE_MTX[3], LAB_BASE_MTX[4], LAB_BASE_MTX[5]);
        else ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    function blitQuad(ctx, im, st, x0, y0, size, flip, raw, tbl) {
        var k = (im.naturalWidth || im.width) / 512;   // Image, or a decoded .rgb canvas
        var bx = quadBox(st, tbl);
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, y0, size, size);
        ctx.clip();
        if (raw) {
            ctx.drawImage(im, bx.x * k, bx.y * k, bx.w * k, bx.h * k, x0, y0, size, size);
        } else {
            var m = uvCTM(st, x0, y0, size, flip, tbl);
            ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
            ctx.drawImage(im, bx.x * k, bx.y * k, bx.w * k, bx.h * k,
                bx.x, bx.y, bx.w, bx.h);
        }
        ctx.restore();
        labSetBase(ctx);
    }
    /* water cell in the engine model: 4 quadrant quads, one state each */
    function blitWaterCell(ctx, im, pass, x0, y0, size) {
        ['nw', 'ne', 'ws', 'es'].forEach(function (qn) {
            var f = rivFlip(pass, qn) !== WATER.flip;
            blitQuad(ctx, im, rivPick(pass, qn),
                x0 + (qn === 'ne' || qn === 'es' ? size / 2 : 0),
                y0 + (qn === 'ws' || qn === 'es' ? size / 2 : 0), size / 2, f, WATER.raw);
        });
    }

    /* ---------------- dirt sheet (DirtRoadDrawing / DirtRiverDrawing) ----
       The engine's dirt tile sheet: landinfo.xml names ONE static texture,
       <RoadMap texture="DirtRoadTileSheet.rgb" type="dirt" drawer="road"
       origin="0,-7" size="37,64"> (plus the type="dirtriver" drawer="river"
       twin), unchanged from gamescripts r308122 through the current
       r497432 — the art is resolved from whichever pack ships the file, so
       PACKS layer it: WildWest_RiverRoadTiles (sandy .rgb) is the permanent
       normal-season art in the live game, and the XMAS2016/2017 LTD packs
       re-ship the same name as a brown, snow-speckled .png that overrides
       it during Christmas. Base manifests ship neither.
       landinfo.xml (gamescripts): RoadEntry type="dirt" SaveInfo map="dirt"
       savedType="road" drawer DirtRoadDrawing, and type="dirtriver" drawer
       DirtRiverDrawing — the viewer's dirtroad (park footpaths) and dirt
       (dirt-river scatter) layers respectively. DirtRoadDrawing is Road-
       Drawer's own subclass (same selector body, own UV table 0x400520 —
       the ROAD_QUADS below, byte-identical to the road table the viewer
       ports) and DirtRiverDrawing likewise the RiverDrawer body with the
       0x3fc320 table: the dirt sheet sits on the SAME 13-cell lattice as
       roadrivertiles — landinfo declares the same origin/size as road/
       river, per-slot dark-boundary ray measurements matched the road
       sheet within ±1–2 px at all 11 states (2026-10-27, evidence
       mapdump/registration/m4-dirt-sheet-slots.png and
       m4-dirt-ww-vs-xmas-slots.png) — and a full .rodata
       parallelogram-quad scan of libscorpio.so found only the two known
       tables. So both dirt layers are the proven quadrant models with a
       different texture; nothing new to prove. ------------------------- */
    var DIRT_PACKS = [   // engine pack-priority: normal art + winter override
        ['WildWest (base / normal)', '../assets/dlc/WildWest_RiverRoadTiles-100-r308122/data/dirtroadtilesheet.rgb'],
        ['XMAS2017 LTD (winter override)', '../assets/dlc/XMAS2017_RiverRoadTiles_LTD-100-r492453/images/dirtroadtilesheet.png'],
    ];
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
    /* Two INDEPENDENT views: the viewer's `dirtroad` (landinfo type="dirt",
       DirtRoadDrawing = RoadDrawer body) and `dirt` (type="dirtriver",
       DirtRiverDrawing = RiverDrawer body) are different layers with
       different selector bodies, so each gets its own tab, state and sheet
       choice. (The engine shares one texture name between them, but the
       per-view sheet button lets you test e.g. "dirtroad winter-only art?"
       against "dirt has normal-season art".) */
    function newDirtView(model, cvId, pre) {
        return {
            model: model, cv: cvId, pre: pre,
            img: null, failed: false, pack: 0, sheet: DIRT_PACKS[0][1],
            zoom: 2, grid: true, raw: false,
            mask: { e: true, w: true, n: false, s: false },
            probe: { e: false, w: false, n: false, s: false },
            force: -1, forceAuto: true,
            flip: false,
        };
    }
    var DIRT = newDirtView('road', 'cv-dirt', 'd');       // viewer dirtroad
    var DIRTR = newDirtView('river', 'cv-dirt2', 'dr');    // viewer dirt
    function dEffPass(S) {
        var o = {};
        for (var d of ['e', 'w', 'n', 's']) o[d] = !!(S.mask[d] || S.probe[d]);
        return o;
    }
    function dPick(S, pass, q) {
        if (S.forceAuto)
            return (S.model === 'road' ? engStates(pass) : rivStates(pass))[q];
        return S.force;
    }
    function dFlip(S, pass, q) {
        return (S.model === 'road' ? engFlip(pass, q) : rivFlip(pass, q)) !== S.flip;
    }
    function dTable(S) { return S.model === 'road' ? ROAD_QUADS : RIVER_QUADS; }
    /* .rgb = the game's raw texture blob, per tools/extract_assets.py
       rgb_to_rgba (the oracle — it produced every PNG under web/assets):
       header u32 flags LE, u16 w, u16 h; payload w*h*4 = straight 8-bit
       RGBA, payload w*h*2 = RGBA4444 pairs byte0=(B<<4)|A, byte1=(R<<4)|G
       with nibbles expanded x17. Header flag 0x2000 claims premultiplied
       and 0x4000 straight — the claim lies on some files (the dirt sheet
       sets 0x2000 yet stores c4 > a4, impossible under premultiplication),
       so scan for that violation and trust the data. An RGB565 read of
       4444 data is what made the dirt tiles pink/purple.
       Pure: returns {w, h, data} (RGBA Uint8ClampedArray). The viewer
       loader carries the identical core; smoke drift-guards the two. */
    function decodeRgb(buf) {
        var dv = new DataView(buf);
        var flags = dv.getUint32(0, true), w = dv.getUint16(4, true), h = dv.getUint16(6, true);
        var n = w * h, len = buf.byteLength - 8;
        if (len !== n * 2 && len !== n * 4) throw new Error('bad .rgb payload ' + len + ' for ' + w + 'x' + h);
        var data = new Uint8ClampedArray(n * 4), o = 8, i, p;
        if (len === n * 4) {
            for (i = 0; i < n * 4; i++) data[i] = dv.getUint8(8 + i);
            return { w: w, h: h, data: data };
        }
        var premul = !!(flags & 0x2000) && !(flags & 0x4000);
        if (premul) {
            for (i = 0; i < n; i++) {
                var b0 = dv.getUint8(8 + i * 2), b1 = dv.getUint8(8 + i * 2 + 1), a4 = b0 & 15;
                if (a4 && a4 < 15 && ((b0 >> 4) > a4 || (b1 >> 4) > a4 || (b1 & 15) > a4)) { premul = false; break; }
            }
        }
        for (i = 0, p = 0; i < n; i++, o += 2, p += 4) {
            var c0 = dv.getUint8(o), c1 = dv.getUint8(o + 1), a = c0 & 15;
            var r = (c1 >> 4) * 17, g = (c1 & 15) * 17, b = (c0 >> 4) * 17;
            if (premul && a && a < 15) {          // un-premultiply the semi-transparent subset
                r = Math.min(255, Math.round((c1 >> 4) * 255 / a));
                g = Math.min(255, Math.round((c1 & 15) * 255 / a));
                b = Math.min(255, Math.round((c0 >> 4) * 255 / a));
            }
            data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = a * 17;
        }
        return { w: w, h: h, data: data };
    }
    var DIRT_IMGS = {};                      // decoded-sheet cache by path (views share it)
    function loadDirtPack(S) {
        S.failed = false; S.img = null;
        S.sheet = DIRT_PACKS[S.pack][1];
        var cached = DIRT_IMGS[S.sheet];
        if (cached) { S.img = cached; renderDirt(S); return; }
        if (typeof Image === 'undefined') { renderDirt(S); return; }   // harness
        if (/\.rgb$/.test(S.sheet) && typeof fetch === 'function') {
            fetch(S.sheet)
                .then(function (r) { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
                .then(function (buf) {
                    var d = decodeRgb(buf), cv = document.createElement('canvas');
                    cv.width = d.w; cv.height = d.h;
                    var cx = cv.getContext('2d');
                    cx.putImageData(new ImageData(d.data, d.w, d.h), 0, 0);
                    cv._src = S.sheet;               // smoke: source tag
                    DIRT_IMGS[S.sheet] = cv; S.img = cv; renderDirt(S);
                })
                .catch(function () { S.failed = true; renderDirt(S); });
            return;
        }
        var im = new Image();
        im.onload = function () { DIRT_IMGS[S.sheet] = im; S.img = im; renderDirt(S); };
        im.onerror = function () { S.failed = true; renderDirt(S); };
        im.src = S.sheet;
    }
    /* dirt cell in the engine model: 4 quadrant quads on the dirt sheet */
    function blitDirtCell(ctx, im, S, pass, x0, y0, size) {
        var tbl = dTable(S);
        ['nw', 'ne', 'ws', 'es'].forEach(function (qn) {
            blitQuad(ctx, im, dPick(S, pass, qn),
                x0 + (qn === 'ne' || qn === 'es' ? size / 2 : 0),
                y0 + (qn === 'ws' || qn === 'es' ? size / 2 : 0), size / 2,
                dFlip(S, pass, qn), S.raw, tbl);
        });
    }

    function renderArt() {
        var cv = $('cv-art'), ctx = cv.getContext('2d');
        var W = cv.width;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = '#101216';
        ctx.fillRect(0, 0, W, cv.height);
        ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';
        if (!ART.img) {
            ctx.fillStyle = '#cfd6df';
            ctx.fillText(ART.failed ? 'sheet failed to load: ' + PACKS[ART.pack][1]
                : 'loading sheet…', 12, 12);
            return;
        }
        var im = ART.img, k = im.naturalWidth / 512;
        var y = 6;
        function label(t, x, yy) { ctx.fillStyle = '#cfd6df'; ctx.fillText(t, x, yy); }

        /* --- 1. full sheet + lattice --- */
        label('full sheet ' + im.naturalWidth + '×' + im.naturalHeight +
            ' — lattice overlaid; numbers = RE’d state index', 8, y);
        y += 14;
        var sx = 8, sy = y;
        ctx.drawImage(im, sx, sy);
        if (ART.grid) {
            ctx.strokeStyle = 'rgba(120,200,255,0.35)';
            ctx.lineWidth = 1;
            for (var r = -5; r <= 9; r++) {
                for (var c = -4; c <= 4; c++) {
                    var cx = sx + (274 + 135 * c + ((((r % 2) + 2) % 2)) * 67.5) * k;
                    var cy = sy + (140 + 37 * r) * k;
                    ctx.strokeRect(cx - 63.5 * k, cy - 33 * k, 127 * k, 66 * k);
                }
            }
            for (var st = 0; st < STATES.length; st++) {
                var ux = sx + (274 + 135 * STATES[st][0] + ((((STATES[st][1] % 2) + 2) % 2)) * 67.5) * k;
                var uy = sy + (140 + 37 * STATES[st][1]) * k;
                ctx.strokeStyle = '#ffe86e';
                ctx.beginPath();
                ctx.moveTo(ux - 63.5 * k, uy); ctx.lineTo(ux, uy - 33 * k);
                ctx.lineTo(ux + 63.5 * k, uy); ctx.lineTo(ux, uy + 33 * k);
                ctx.closePath(); ctx.stroke();
                ctx.fillStyle = '#ffe86e';
                ctx.fillText(String(st), ux - 63.5 * k + 2, uy - 33 * k + 2);
            }
        }
        y += im.naturalHeight + 10;

        /* --- 2. the 11 states enlarged: raw box | as-sampled parallelogram --- */
        var zw = 127 * ART.zoom, zh = 66 * ART.zoom;
        label('the 11 RE’d slots — left: raw 127×66 sheet box (corner junk lives outside the diamond); right: the parallelogram the GPU actually samples', 8, y);
        y += 14;
        for (st = 0; st < STATES.length; st++) {
            var tags = '';
            if (ART.forceAuto) {
                var es0 = engStates(effPass());
                if (es0.nw === st || es0.ne === st || es0.ws === st || es0.es === st) tags += '  [in use]';
            } else if (st === ART.force) tags += '  [FORCED]';
            label('state ' + st + ' — ' + STATE_WHAT[st] + ' (c,r=' + STATES[st] + ')' + tags, 8, y);
            y += 14;
            ctx.fillStyle = P.colors.grass;
            ctx.fillRect(8, y, zw, zh);
            var dx = 24 + zw;
            ctx.fillRect(dx, y, zh, zh);
            ctx.drawImage(im, slotRect(im, st).x, slotRect(im, st).y, 127 * k, 66 * k, 8, y, zw, zh);
            blitSlot(ctx, im, st, dx, y, zh, false);   // square of the diamond's height
            ctx.strokeStyle = '#3a414c';
            ctx.strokeRect(8.5, y + 0.5, zw - 1, zh - 1);
            ctx.strokeRect(dx + 0.5, y + 0.5, zh - 1, zh - 1);
            label('as sampled', dx, y + zh + 2);
            y += zh + 18;
        }

        /* --- 3. engine model: one cell = 4 quadrant quads, one state each --- */
        var pass = effPass();
        label('engine model — cell = 4 quadrant quads, each sampling one full state (notes/08). mask E/W/N/S = ' +
            (pass.e ? 'E' : '-') + (pass.w ? 'W' : '-') + (pass.n ? 'N' : '-') + (pass.s ? 'S' : '-') +
            (ART.forceAuto ? ' — engine table' : ' — FORCED state ' + ART.force), 8, y);
        y += 16;
        var size = 132, gap = 16;
        var live = [{ e: pass.e, w: pass.w, n: pass.n, s: pass.s, lbl: 'live' }];
        var demo = [{ e: 1, w: 1, n: 0, s: 0, lbl: 'E+W street' },
            { e: 0, w: 0, n: 1, s: 1, lbl: 'N+S street' },
            { e: 1, w: 0, n: 0, s: 1, lbl: 'E+S bend' },
            { e: 0, w: 0, n: 0, s: 0, lbl: 'isolated' }];
        for (var di = 0; di < live.length + demo.length; di++) {
            var dcase = di < live.length ? live[di] : demo[di - live.length];
            var x0 = 8 + di * (size + gap), yy = y + 15;
            label(dcase.lbl, x0, y);                       // caption ABOVE the cell
            ctx.fillStyle = P.colors.grass;
            ctx.fillRect(x0, yy, size, size);
            blitEngineCell(ctx, im, { e: !!dcase.e, w: !!dcase.w, n: !!dcase.n, s: !!dcase.s }, x0, yy, size);
            ctx.strokeStyle = 'rgba(255,255,255,0.3)';
            ctx.strokeRect(x0 + 0.5, yy + 0.5, size - 1, size - 1);
            ctx.beginPath();                       // quadrant seams
            ctx.moveTo(x0 + size / 2, yy); ctx.lineTo(x0 + size / 2, yy + size);
            ctx.moveTo(x0, yy + size / 2); ctx.lineTo(x0 + size, yy + size / 2);
            ctx.stroke();
            var dsp = { e: !!dcase.e, w: !!dcase.w, n: !!dcase.n, s: !!dcase.s };
            var st = ART.forceAuto ? engStates(dsp)
                : { nw: ART.force, ne: ART.force, ws: ART.force, es: ART.force };
            var mk = function (qn) { return qn + st[qn] + (engFlip(dsp, qn) ? '*' : ''); };
            label([mk('nw'), mk('ne'), mk('ws'), mk('es')].join(' '), x0, yy + size + 2);
            // * = engine flip byte mirrors the sampled rect (see engFlip)
        }
        y += 15 + size + 20;

        /* --- 4. quadrant family reference --- */
        label('quadrant families — what each quadrant draws for its two-edge pass pair; * = engine flip byte mirrors the rect', 8, y);
        y += 16;
        var fams = [
            ['NW (tests N,W)', [[1, 'none, kerb W+N'], [3, 'N-only, kerb W'],
                [4, 'W-only, kerb N'], [2, 'both, no kerb']]],
            ['NE (tests N,E)', [[5, 'none, kerb N+E'], [7, 'N-only, kerb E', 1],
                [7, 'E-only, kerb N'], [6, 'both, no kerb']]],
            ['WS (tests W,S)', [[8, 'none, kerb W+S'], [10, 'W-only, kerb S', 1],
                [10, 'S-only, kerb W'], [9, 'both, no kerb']]],
            ['ES (tests E,S) — flip=1 always', [[1, 'none, kerb E+S', 1],
                [3, 'E-only, kerb S', 1], [4, 'S-only, kerb E', 1], [2, 'both, no kerb', 1]]],
        ];
        for (var fi = 0; fi < fams.length; fi++) {
            x0 = 8 + fi * (zw / 2 + 22);
            label(fams[fi][0], x0, y);
            for (var pi = 0; pi < 4; pi++) {
                var yy2 = y + 15 + pi * (zh / 2 + 22);
                var ent = fams[fi][1][pi];
                ctx.fillStyle = P.colors.grass;
                ctx.fillRect(x0, yy2, zw / 2, zh / 2);
                blitSlot(ctx, im, ent[0], x0, yy2, zw / 2, (ent[2] ? 1 : 0) !== (ART.flip ? 1 : 0));
                ctx.strokeStyle = 'rgba(255,255,255,0.25)';
                ctx.strokeRect(x0 + 0.5, yy2 + 0.5, zw / 2 - 1, zh / 2 - 1);
                label('state ' + ent[0] + ' ' + ent[1] + (ent[2] ? '*' : ''), x0, yy2 + zh / 2 + 2);
            }
        }
        y += 15 + 4 * (zh / 2 + 22) + 12;
        /* grow to content — but assigning canvas.height CLEARS the bitmap,
         * so never do it after painting: resize, then re-run the whole
         * render into the fresh canvas (second pass sees need === height
         * and just draws + syncs). */
        var need = Math.max(400, y);
        if (need !== cv.height) {
            cv.height = need;
            if (ART._redo) return;                   // pathological ping-pong guard
            ART._redo = true;
            try { renderArt(); } finally { ART._redo = false; }
            return;
        }
        syncArtReadouts();
    }

    /* ---------------- water tab render ---------------- */

    function renderWater() {
        var cv = $('cv-water'), ctx = cv.getContext('2d');
        var W1 = cv.width;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = '#101216';
        ctx.fillRect(0, 0, W1, cv.height);
        ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';
        if (!WATER.img) {
            ctx.fillStyle = '#cfd6df';
            ctx.fillText(WATER.failed ? 'sheet failed to load: ' + PACKS[WATER.pack][1]
                : 'loading sheet…', 12, 12);
            return;
        }
        var im = WATER.img, k = im.naturalWidth / 512;
        var y = 6;
        function label(t, x, yy) { ctx.fillStyle = '#cfd6df'; ctx.fillText(t, x, yy); }
        function latticeRect(cx, cy, col) {
            ctx.strokeStyle = col;
            ctx.strokeRect(cx - 63.5 * k, cy - 33 * k, 127 * k, 66 * k);
        }

        /* --- 1. the sheet with the river diamonds on the shared lattice --- */
        label('roadtilesheet.png ' + im.naturalWidth + '×' + im.naturalHeight +
            ' — the 11 RE’d river slots (cyan) sit on the SAME lattice as the road slots (grey)', 8, y);
        y += 14;
        var sx = 8, sy = y;
        ctx.drawImage(im, sx, sy);
        if (WATER.grid) {
            for (var r = -5; r <= 9; r++) {
                for (var c = -4; c <= 4; c++) {
                    latticeRect(sx + (274 + 135 * c + ((((r % 2) + 2) % 2)) * 67.5) * k,
                        sy + (140 + 37 * r) * k, 'rgba(120,200,255,0.18)');
                }
            }
            for (var rs = 0; rs < STATES.length; rs++) {
                var rx = sx + (274 + 135 * STATES[rs][0] + ((((STATES[rs][1] % 2) + 2) % 2)) * 67.5) * k;
                var ry = sy + (140 + 37 * STATES[rs][1]) * k;
                latticeRect(rx, ry, 'rgba(255,255,255,0.22)');
            }
            for (var st = 0; st < RIVER_QUADS.length; st++) {
                var bx = quadBox(st);
                ctx.strokeStyle = '#7ee0ff';
                ctx.strokeRect(sx + bx.x * k, sy + bx.y * k, bx.w * k, bx.h * k);
                var ux = sx + (274 + 135 * RIVER_SLOTS[st][0] + ((((RIVER_SLOTS[st][1] % 2) + 2) % 2)) * 67.5) * k;
                var uy = sy + (140 + 37 * RIVER_SLOTS[st][1]) * k;
                ctx.beginPath();                       // the inscribed diamond = the UV quad
                ctx.moveTo(ux - 63.5 * k, uy); ctx.lineTo(ux, uy - 33 * k);
                ctx.lineTo(ux + 63.5 * k, uy); ctx.lineTo(ux, uy + 33 * k);
                ctx.closePath(); ctx.stroke();
                ctx.fillStyle = '#7ee0ff';
                ctx.fillText(String(st), ux - 63.5 * k + 2, uy - 33 * k + 2);
            }
        }
        y += im.naturalHeight + 10;

        /* --- 2. the 11 slots enlarged: raw box | as the GPU samples it --- */
        var zw = 127 * WATER.zoom, zh = 66 * WATER.zoom;
        label('the 11 RE’d river slots — left: raw sheet box; right: the parallelogram the GPU samples (water/bank measured off the bake)', 8, y);
        y += 14;
        for (st = 0; st < RIVER_QUADS.length; st++) {
            var tags = '';
            if (WATER.forceAuto) {
                var es0 = rivStates(wEffPass());
                if (es0.nw === st || es0.ne === st || es0.ws === st || es0.es === st) tags += '  [in use]';
            } else if (st === WATER.force) tags += '  [FORCED]';
            label('state ' + st + ' — ' + RIVER_WHAT[st] + ' (c,r=' + RIVER_SLOTS[st] +
                ', water ' + RIVER_COVER[st] + '%)' + tags, 8, y);
            y += 14;
            ctx.fillStyle = P.colors.grass;
            ctx.fillRect(8, y, zw, zh);
            var dx = 24 + zw;
            ctx.fillRect(dx, y, zh, zh);
            var b2 = quadBox(st);
            ctx.drawImage(im, b2.x * k, b2.y * k, b2.w * k, b2.h * k, 8, y, zw, zh);
            blitQuad(ctx, im, st, dx, y, zh, false, false);
            ctx.strokeStyle = '#3a414c';
            ctx.strokeRect(8.5, y + 0.5, zw - 1, zh - 1);
            ctx.strokeRect(dx + 0.5, y + 0.5, zh - 1, zh - 1);
            label('as sampled', dx, y + zh + 2);
            y += zh + 18;
        }

        /* --- 3. engine model: one cell = 4 quadrant quads, one state each --- */
        var pass = wEffPass();
        label('engine model — same code path as roads: cell = 4 quadrant quads, one state each (RiverDrawer shares RoadDrawer’s draw body). mask E/W/N/S = ' +
            (pass.e ? 'E' : '-') + (pass.w ? 'W' : '-') + (pass.n ? 'N' : '-') + (pass.s ? 'S' : '-') +
            (WATER.forceAuto ? ' — engine table' : ' — FORCED state ' + WATER.force), 8, y);
        y += 16;
        var size = 132, gap = 16;
        var live = [{ e: pass.e, w: pass.w, n: pass.n, s: pass.s, lbl: 'live' }];
        var demo = [{ e: 1, w: 1, n: 0, s: 0, lbl: 'E+W channel' },
            { e: 0, w: 0, n: 1, s: 1, lbl: 'N+S channel' },
            { e: 1, w: 0, n: 0, s: 1, lbl: 'E+S bend' },
            { e: 0, w: 0, n: 0, s: 0, lbl: 'isolated pool' }];
        for (var di = 0; di < live.length + demo.length; di++) {
            var dcase = di < live.length ? live[di] : demo[di - live.length];
            var x0 = 8 + di * (size + gap), yy = y + 15;
            label(dcase.lbl, x0, y);
            ctx.fillStyle = P.colors.grass;
            ctx.fillRect(x0, yy, size, size);
            blitWaterCell(ctx, im, { e: !!dcase.e, w: !!dcase.w, n: !!dcase.n, s: !!dcase.s }, x0, yy, size);
            ctx.strokeStyle = 'rgba(255,255,255,0.3)';
            ctx.strokeRect(x0 + 0.5, yy + 0.5, size - 1, size - 1);
            ctx.beginPath();
            ctx.moveTo(x0 + size / 2, yy); ctx.lineTo(x0 + size / 2, yy + size);
            ctx.moveTo(x0, yy + size / 2); ctx.lineTo(x0 + size, yy + size / 2);
            ctx.stroke();
            var dsp = { e: !!dcase.e, w: !!dcase.w, n: !!dcase.n, s: !!dcase.s };
            var stt = WATER.forceAuto ? rivStates(dsp)
                : { nw: WATER.force, ne: WATER.force, ws: WATER.force, es: WATER.force };
            var mk = function (qn) { return qn + stt[qn] + (rivFlip(dsp, qn) ? '*' : ''); };
            label([mk('nw'), mk('ne'), mk('ws'), mk('es')].join(' '), x0, yy + size + 2);
        }
        y += 15 + size + 20;

        /* --- 4. quadrant family reference --- */
        label('quadrant families — what each quadrant draws for its two-edge pass pair; * = mirror byte (the road emitter’s anti-diagonal reflection; bank placement verified on this art)', 8, y);
        y += 16;
        var fams = [
            ['NW (tests N,W)', [[0, 'none, banks W+N'], [3, 'N-only, bank W'],
                [4, 'W-only, bank N'], [2, 'both, open water']]],
            ['NE (tests N,E)', [[5, 'none, banks N+E'], [7, 'N-only, bank E', 1],
                [7, 'E-only, bank N'], [6, 'both, open water']]],
            ['WS (tests W,S)', [[8, 'none, banks W+S'], [10, 'W-only, bank S', 1],
                [10, 'S-only, bank W'], [9, 'both, open water']]],
            ['ES (tests E,S) — flip=1 always', [[0, 'none, banks E+S', 1],
                [3, 'E-only, bank S', 1], [4, 'S-only, bank E', 1], [2, 'both, open water', 1]]],
        ];
        for (var fi = 0; fi < fams.length; fi++) {
            x0 = 8 + fi * (zw / 2 + 22);
            label(fams[fi][0], x0, y);
            for (var pi = 0; pi < 4; pi++) {
                var yy2 = y + 15 + pi * (zh / 2 + 22);
                var ent = fams[fi][1][pi];
                ctx.fillStyle = P.colors.grass;
                ctx.fillRect(x0, yy2, zw / 2, zh / 2);
                blitQuad(ctx, im, ent[0], x0, yy2, zw / 2,
                    (ent[2] ? 1 : 0) !== (WATER.flip ? 1 : 0), WATER.raw);
                ctx.strokeStyle = 'rgba(255,255,255,0.25)';
                ctx.strokeRect(x0 + 0.5, yy2 + 0.5, zw / 2 - 1, zh / 2 - 1);
                label('state ' + ent[0] + ' ' + ent[1] + (ent[2] ? '*' : ''), x0, yy2 + zh / 2 + 2);
            }
        }
        y += 15 + 4 * (zh / 2 + 22) + 12;

        /* --- 5. the wave overlay asset (separate sprite, not the tileset) --- */
        if (!WATER.wave) {
            label('wave overlay: ' + (WATER.waveFailed ? 'wateranimations.png failed to load'
                : 'loading wateranimations.png…'), 8, y);
            y += 20;
        } else {
            var wv = WATER.wave, wk = wv.naturalWidth / 256;
            label('wave overlay — WaterAnims (wateranimations.png, a SEPARATE BGSprite the drawer keeps at ' +
                '[drawer+0x80]; C_Water_*/C_Ripple_ cells from its .bsv3, outlined here)', 8, y);
            y += 14;
            var wx = 8, wy = y;
            ctx.fillStyle = 'rgb(40,80,140)';               // water behind the shimmer marks
            ctx.fillRect(wx, wy, wv.naturalWidth * 2, wv.naturalHeight * 2);
            ctx.drawImage(wv, wx, wy, wv.naturalWidth * 2, wv.naturalHeight * 2);
            for (var ci = 0; ci < WAVE_CELLS.length; ci++) {
                var cc = WAVE_CELLS[ci];
                ctx.strokeStyle = '#ffe86e';
                ctx.strokeRect(wx + cc[1] * wk * 2, wy + cc[2] * wk * 2, cc[3] * wk * 2, cc[4] * wk * 2);
                ctx.fillStyle = '#ffe86e';
                ctx.fillText(cc[0], wx + cc[1] * wk * 2, wy + cc[2] * wk * 2 + cc[4] * wk * 2 + 1);
            }
            y += wv.naturalHeight * 2 + 6;
            label('engine picks one frame every 3 s (timer [drawer+0x88], rand() ~50/50, frame table 0x143abe8) and patches it into', 8, y);
            y += 13;
            label('the sprite node’s mat4 — UNPROVEN which two cells those two frames are; needs the WaterAnims bind confirmed', 8, y);
            y += 20;
        }

        var need = Math.max(400, y);
        if (need !== cv.height) {
            cv.height = need;
            if (WATER._redo) return;
            WATER._redo = true;
            try { renderWater(); } finally { WATER._redo = false; }
            return;
        }
        syncWaterReadouts();
    }

    /* ---------------- dirt tabs render (one view per dirt layer) -------- */

    function renderDirt(S) {
        S = S || DIRT;
        var cv = $(S.cv), ctx = cv.getContext('2d');
        var W1 = cv.width;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = '#101216';
        ctx.fillRect(0, 0, W1, cv.height);
        ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';
        if (!S.img) {
            ctx.fillStyle = '#cfd6df';
            ctx.fillText(S.failed ? 'sheet failed to load: ' + S.sheet
                : 'loading sheet…', 12, 12);
            return;
        }
        var road = S.model === 'road';
        var tbl = dTable(S), slots = road ? STATES : RIVER_SLOTS;
        var whats = road ? STATE_WHAT : RIVER_WHAT;
        var im = S.img, iw = im.naturalWidth || im.width, ih = im.naturalHeight || im.height;
        var k = iw / 512;                              // Image or decoded .rgb canvas
        var y = 6;
        function label(t, x, yy) { ctx.fillStyle = '#cfd6df'; ctx.fillText(t, x, yy); }
        function latticeRect(cx, cy, col) {
            ctx.strokeStyle = col;
            ctx.strokeRect(cx - 63.5 * k, cy - 33 * k, 127 * k, 66 * k);
        }

        /* --- 1. the dirt sheet with the active table's quads on the shared
           lattice (same origin/formula as the water tab's roadrivertiles) --- */
        label('dirtroadtilesheet ' + iw + '×' + ih +
            ' — ' + (road ? 'road' : 'river') + ' slots (cyan) on the SAME lattice as ' +
            'roadrivertiles (±1–2 px at all 11 states, rays 2026-10-27)', 8, y);
        y += 14;
        var sx = 8, sy = y;
        ctx.drawImage(im, sx, sy);
        if (S.grid) {
            for (var r = -5; r <= 9; r++) {
                for (var c = -4; c <= 4; c++) {
                    latticeRect(sx + (274 + 135 * c + ((((r % 2) + 2) % 2)) * 67.5) * k,
                        sy + (140 + 37 * r) * k, 'rgba(120,200,255,0.18)');
                }
            }
            for (var st = 0; st < tbl.length; st++) {
                var bx = quadBox(st, tbl);
                ctx.strokeStyle = '#7ee0ff';
                ctx.strokeRect(sx + bx.x * k, sy + bx.y * k, bx.w * k, bx.h * k);
                var ux = sx + (274 + 135 * slots[st][0] + ((((slots[st][1] % 2) + 2) % 2)) * 67.5) * k;
                var uy = sy + (140 + 37 * slots[st][1]) * k;
                ctx.beginPath();                       // the inscribed diamond = the UV quad
                ctx.moveTo(ux - 63.5 * k, uy); ctx.lineTo(ux, uy - 33 * k);
                ctx.lineTo(ux + 63.5 * k, uy); ctx.lineTo(ux, uy + 33 * k);
                ctx.closePath(); ctx.stroke();
                ctx.fillStyle = '#7ee0ff';
                ctx.fillText(String(st), ux - 63.5 * k + 2, uy - 33 * k + 2);
            }
        }
        y += ih + 10;

        /* --- 2. the 11 slots enlarged: raw box | as the GPU samples it --- */
        var zw = 127 * S.zoom, zh = 66 * S.zoom;
        label('the 11 ' + (road ? 'RoadDrawer (0x400520)' : 'RiverDrawer (0x3fc320)') +
            ' slots on the dirt sheet — left: raw sheet box; right: the parallelogram the GPU samples', 8, y);
        y += 14;
        for (st = 0; st < tbl.length; st++) {
            var tags = '';
            if (S.forceAuto) {
                var es0 = road ? engStates(dEffPass(S)) : rivStates(dEffPass(S));
                if (es0.nw === st || es0.ne === st || es0.ws === st || es0.es === st) tags += '  [in use]';
            } else if (st === S.force) tags += '  [FORCED]';
            label('state ' + st + ' — ' + whats[st] + ' (c,r=' + slots[st] + ')' + tags, 8, y);
            y += 14;
            ctx.fillStyle = P.colors.grass;
            ctx.fillRect(8, y, zw, zh);
            var dx = 24 + zw;
            ctx.fillRect(dx, y, zh, zh);
            var b2 = quadBox(st, tbl);
            ctx.drawImage(im, b2.x * k, b2.y * k, b2.w * k, b2.h * k, 8, y, zw, zh);
            blitQuad(ctx, im, st, dx, y, zh, false, false, tbl);
            ctx.strokeStyle = '#3a414c';
            ctx.strokeRect(8.5, y + 0.5, zw - 1, zh - 1);
            ctx.strokeRect(dx + 0.5, y + 0.5, zh - 1, zh - 1);
            label('as sampled', dx, y + zh + 2);
            y += zh + 18;
        }

        /* --- 3. engine model: one cell = 4 quadrant quads, one state each --- */
        var pass = dEffPass(S);
        label('engine model — ' + (road
            ? 'dirtroad footpaths: DirtRoadDrawing runs RoadDrawer’s body (nibble OR neighbour-solid, kerb inside the art)'
            : 'dirt-river scatter: DirtRiverDrawing runs RiverDrawer’s body (bank on the closed edge, diagonal guards)') +
            '. mask E/W/N/S = ' +
            (pass.e ? 'E' : '-') + (pass.w ? 'W' : '-') + (pass.n ? 'N' : '-') + (pass.s ? 'S' : '-') +
            (S.forceAuto ? ' — engine table' : ' — FORCED state ' + S.force), 8, y);
        y += 16;
        var size = 132, gap = 16;
        var live = [{ e: pass.e, w: pass.w, n: pass.n, s: pass.s, lbl: 'live' }];
        var demo = [{ e: 1, w: 1, n: 0, s: 0, lbl: 'E+W run' },
            { e: 0, w: 0, n: 1, s: 1, lbl: 'N+S run' },
            { e: 1, w: 0, n: 0, s: 1, lbl: 'E+S bend' },
            { e: 0, w: 0, n: 0, s: 0, lbl: 'isolated' }];
        for (var di = 0; di < live.length + demo.length; di++) {
            var dcase = di < live.length ? live[di] : demo[di - live.length];
            var x0 = 8 + di * (size + gap), yy = y + 15;
            label(dcase.lbl, x0, y);
            ctx.fillStyle = P.colors.grass;
            ctx.fillRect(x0, yy, size, size);
            blitDirtCell(ctx, im, S, { e: !!dcase.e, w: !!dcase.w, n: !!dcase.n, s: !!dcase.s }, x0, yy, size);
            ctx.strokeStyle = 'rgba(255,255,255,0.3)';
            ctx.strokeRect(x0 + 0.5, yy + 0.5, size - 1, size - 1);
            ctx.beginPath();
            ctx.moveTo(x0 + size / 2, yy); ctx.lineTo(x0 + size / 2, yy + size);
            ctx.moveTo(x0, yy + size / 2); ctx.lineTo(x0 + size, yy + size / 2);
            ctx.stroke();
            var dsp = { e: !!dcase.e, w: !!dcase.w, n: !!dcase.n, s: !!dcase.s };
            var stt = S.forceAuto
                ? (road ? engStates(dsp) : rivStates(dsp))
                : { nw: S.force, ne: S.force, ws: S.force, es: S.force };
            var mk = function (qn) {
                return qn + stt[qn] + ((road ? engFlip(dsp, qn) : rivFlip(dsp, qn)) ? '*' : '');
            };
            label([mk('nw'), mk('ne'), mk('ws'), mk('es')].join(' '), x0, yy + size + 2);
        }
        y += 15 + size + 20;

        var need = Math.max(400, y);
        if (need !== cv.height) {
            cv.height = need;
            if (S._redo) return;
            S._redo = true;
            try { renderDirt(S); } finally { S._redo = false; }
            return;
        }
        syncDirtReadouts(S);
    }

    function formatDirtRef(S, tag) {
        S = S || DIRT;
        var dp = dEffPass(S);
        var road = S.model === 'road';
        var tbl = dTable(S), slots = road ? STATES : RIVER_SLOTS;
        return '\n' + (tag || 'DIRT_ART') + ' = {' + (road ? '                   // RE’d dirt model — DirtRoadDrawing, notes/09 §11' : '                // RE’d dirt model — DirtRiverDrawing, notes/09 §11') + '\n' +
            '  sheet: "dirtroadtilesheet",          // landinfo texture="DirtRoadTileSheet.rgb", static name; packs layer it: WildWest_RiverRoadTiles .rgb = permanent normal-season art (RGBA4444), XMAS2016/17 LTD .png = winter override; base ships none\n' +
            '  lattice: "identical to roadrivertiles (dark-boundary rays ±1–2 px at all 11 states, 2026-10-27; .rodata quad scan found only the two known tables)",\n' +
            '  layers: {\n' +
            '    dirtroad: { landinfo: "dirt / DirtRoadDrawing (RoadDrawer subclass)", uvTable: "0x400520", model: "road" },\n' +
            '    dirt:     { landinfo: "dirtriver / DirtRiverDrawing (RiverDrawer subclass)", uvTable: "0x3fc320", model: "river" },\n' +
            '  },\n' +
            '  view: "' + (road ? 'dirtroad' : 'dirt') + '",                       // lab view; model button removed — one tab per layer\n' +
            '  model: "' + S.model + '",                       // dirtroad = road quadrants, dirt = river quadrants\n' +
            '  slots: {   // [T,R,L,B] in sheet px, sampled from the engine table\n' +
            tbl.map(function (q, i) {
                return '    ' + i + ': [' + q.map(function (p) { return '[' + p[0] + ', ' + p[1] + ']'; }).join(', ') +
                    '],   // (c,r=' + slots[i] + ')';
            }).join('\n') + '\n' +
            '  },\n' +
            '  cellMask: [' + ((dp.e ? 1 : 0) | (dp.w ? 2 : 0) | (dp.n ? 4 : 0) | (dp.s ? 8 : 0)) + '],                    // live dirt mask\n' +
            '  force: ' + (S.forceAuto ? '-1' : S.force) + ',                          // -1 = engine table\n' +
            '  flip: ' + (S.flip ? 'true' : 'false') + ',                       // user mirror; engine flip = anti-diagonal (u,v)->(1-v,1-u)\n' +
            '}\n';
    }

    function syncDirtReadouts(S) {
        var p = S.pre;
        $(p + '-zoom-v').textContent = String(S.zoom);
        $(p + '-force-v').textContent = S.forceAuto ? 'auto' : String(S.force);
        $(p + '-force-auto').className = S.forceAuto ? 'on' : '';
        $(p + '-flip').className = S.flip ? 'on' : '';
        $(p + '-raw').className = S.raw ? 'on' : '';
        $(p + '-grid').className = S.grid ? 'on' : '';
        var dirs = ['e', 'w', 'n', 's'];
        for (var i = 0; i < dirs.length; i++) {
            $(p + 'btn-mask-' + dirs[i]).className = S.mask[dirs[i]] ? 'on' : '';
            $(p + 'btn-probe-' + dirs[i]).className = S.probe[dirs[i]] ? 'on' : '';
        }
        if ($(p + '-pack')) $(p + '-pack').textContent = 'sheet: ' + DIRT_PACKS[S.pack][0];
    }

    /* ---------------- reference block ---------------- */

    function formatRef() {
        var c = P.colors;
        var nsCw = P.tile - P.ns.w1 - P.ns.w2;
        var ewCw = P.tile - P.ew.w1 - P.ew.w2;
        var footHex = shade(c.footpath, P.footTone);
        var paveHex = shade(c.pavement, P.paveTone);
        return 'ROAD_ART = {\n' +
            '  tile: 4,                       // tiles per saved-cell edge\n' +
            '  ns: {                          // mask m (N+S): carriageway vertical\n' +
            '    footWest: ' + fmt(P.ns.w1) + ',  footEast: ' + fmt(P.ns.w2) + ',  carriageway: ' + fmt(nsCw) + ',   // axis x = ' + fmt(carAxisNS()) + '\n' +
            '  },\n' +
            '  ew: {                          // mask d (E+W): carriageway horizontal\n' +
            '    footNorth: ' + fmt(P.ew.w1) + ', footSouth: ' + fmt(P.ew.w2) + ', carriageway: ' + fmt(ewCw) + ',   // axis y = ' + fmt(carAxisEW()) + '\n' +
            '  },\n' +
            '  pavement: "uniform",           // char P: one flat tone, no footpath/kerb\n' +
            '  colors: {\n' +
            '    asphalt:  "' + c.asphalt + '",\n' +
            '    footpath: "' + footHex + '"' + (P.footTone ? ',   // base ' + c.footpath + ' ' + (P.footTone > 0 ? '+' : '') + P.footTone : '') + ',\n' +
            '    pavement: "' + paveHex + '"' + (P.paveTone ? ',   // base ' + c.pavement + ' ' + (P.paveTone > 0 ? '+' : '') + P.paveTone : '') + ',\n' +
            '    kerb:     "' + c.kerb + '",\n' +
            '  },\n' +
            '  kerb: ' + (P.kerb ? 'true' : 'false') + ',\n' +
            '}\n' +
            'ROAD_ENGINE = {                    // RE’d engine model — notes/08\n' +
            '  pack: "' + PACKS[ART.pack][0] + '",\n' +
            '  src: "' + PACKS[ART.pack][1] + '",\n' +
            '  // per 4x4-cell: 4 quadrant quads, each samples ONE full 127x66\n' +
            '  // state rect (the inscribed diamond parallelogram). No base+clip,\n' +
            '  // no second kerb pass — paving/kerb live inside the state art.\n' +
            '  nibbleBits: { E: 1, W: 2, N: 4, S: 8 },   // record byte[4] & 0xf\n' +
            '  passRule: "bit OR (neighbour contains AND neighbour solid)",\n' +
            '  flagBit5State0: true,                      // interior flag -> full slab\n' +
            '  quadrantStates: {\n' +
            '    nw: { both: 2, nOnly: 3, wOnly: 4, none: 1 },        // tests N,W, flip=0\n' +
            '    ne: { both: 6, nOnly: [7, 1], eOnly: [7, 0], none: 5 },  // [state, flip]\n' +
            '    ws: { both: 9, wOnly: [10, 1], sOnly: [10, 0], none: 8 },\n' +
            '    es: { both: [2, 1], eOnly: [3, 1], sOnly: [4, 1], none: [1, 1] }, // (2,2) path\n' +
            '  },                                                      // forces flip=1 (0x1208644)\n' +
            '  // UV->corner map: (f0,f1)->(minX,maxZ) (f2,f3)->(maxX,maxZ)\n' +
            '  //                  (f4,f5)->(minX,minZ) (f6,f7)->(maxX,minZ)\n' +
            '  // screen square (north-up): sheet diamond L->TL T->BL B->TR R->BR\n' +
            '  // (rot45 with the box v axis negated; plain rot45 transposes it)\n' +
            '  cellMask: [' + nibbleVal() + '],                    // live lab mask (E|W|N|S)\n' +
            '  probes: [' + probeVal() + '],                       // solid-neighbour OR-ins\n' +
            '  force: ' + (ART.forceAuto ? '-1' : ART.force) + ',                          // -1 = engine table\n' +
            '  flip: ' + (ART.flip ? 'true' : 'false') + ',                        // mirror the sampled rect (w5 swap)\n' +
            '}\n' +
            formatWaterRef() +
            formatDirtRef(DIRT, 'DIRT_ART') +
            formatDirtRef(DIRTR, 'DIRT_ART_RIVER');
    }
    function formatWaterRef() {
        var wp = wEffPass();
        return 'WATER_ENGINE = {                   // RE’d river model — RiverDrawer, notes/09\n' +
            '  pack: "' + PACKS[WATER.pack][0] + '",\n' +
            '  src: "' + PACKS[WATER.pack][1] + '",\n' +
            '  // RiverDrawer (vptr 0x1a2bf30) : RoadDrawer : RoadMapDrawer. Build wrapper\n' +
            '  // 0x1099f20 loads selector 0x1099f8c then bl 0x1208c10 — the road draw body —\n' +
            '  // so the cell model is roads’ verbatim: 4 quadrant quads, one UV parallelogram\n' +
            '  // each, T->BL R->BR L->TL B->TR, ES quadrant forces the mirror byte.\n' +
            '  uvTable: "0x3fc320 (11 x 32B floats, T,R,L,B, x512 = sheet px)",\n' +
            '  nibbleBits: { E: 1, W: 2, N: 4, S: 8 },   // same helper 0x1134fa8\n' +
            '  passRule: "bit OR (neighbour contains AND neighbour solid)",\n' +
            '  flagBit5State0: false,                     // roads-only; river never calls 0x1134cfc\n' +
            '  identityFallback: false,                   // selector can return NULL (no 12th entry)\n' +
            '  quadrantStates: {\n' +
            '    nw: { both: 2, nOnly: 3, wOnly: 4, none: 0 },        // tests N,W, flip=0\n' +
            '    ne: { both: 6, nOnly: [7, 1], eOnly: [7, 0], none: 5 },  // [state, flip]\n' +
            '    ws: { both: 9, wOnly: [10, 1], sOnly: [10, 0], none: 8 },\n' +
            '    es: { both: [2, 1], eOnly: [3, 1], sOnly: [4, 1], none: [0, 1] }, // (2,2) path\n' +
            '  },\n' +
            '  // vs roads: entries 0 and 1 exchange roles (1 = open-water slab, 0 = W+N shore\n' +
            '  // corner); 2..10 keep the road roles. Bank always sits on the CLOSED edge.\n' +
            '  slots: {   // [T,R,L,B] in sheet px, measured off the engine table\n' +
            RIVER_QUADS.map(function (q, i) {
                return '    ' + i + ': [' + q.map(function (p) { return '[' + p[0] + ', ' + p[1] + ']'; }).join(', ') +
                    '],   // (c,r=' + RIVER_SLOTS[i] + ') water ' + RIVER_COVER[i] + '%';
            }).join('\n') + '\n' +
            '  },\n' +
            '  cellMask: [' + ((wp.e ? 1 : 0) | (wp.w ? 2 : 0) | (wp.n ? 4 : 0) | (wp.s ? 8 : 0)) + '],                    // live water mask\n' +
            '  force: ' + (WATER.forceAuto ? '-1' : WATER.force) + ',                          // -1 = engine table\n' +
            '  flip: ' + (WATER.flip ? 'true' : 'false') + ',                       // user mirror; engine flip = anti-diagonal (u,v)->(1-v,1-u)\n' +
            '  wave: { asset: "wateranimations.png (WaterAnims, separate BGSprite)",\n' +
            '          period: 3.0, cells: [' + WAVE_CELLS.map(function (c) { return '"' + c[0] + '"'; }).join(', ') + '],\n' +
            '          frameBinding: "UNPROVEN" },\n' +
            '}\n';
    }
    function nibbleVal() {
        var p = ART.mask;
        return (p.e ? 1 : 0) | (p.w ? 2 : 0) | (p.n ? 4 : 0) | (p.s ? 8 : 0);
    }
    function probeVal() {
        var p = ART.probe;
        return (p.e ? 1 : 0) | (p.w ? 2 : 0) | (p.n ? 4 : 0) | (p.s ? 8 : 0);
    }

    /* ---------------- wiring ---------------- */

    function renderAll() {
        renderNS();
        renderEW();
        renderPave();
        renderArt();
        renderWater();
        renderDirt(DIRT);
        renderDirt(DIRTR);
        $('refout').textContent = formatRef();
        syncReadouts();
    }

    function syncReadouts() {
        $('ns-a-v').textContent = fmt(P.ns.w1);
        $('ns-b-v').textContent = fmt(P.ns.w2);
        $('ew-a-v').textContent = fmt(P.ew.w1);
        $('ew-b-v').textContent = fmt(P.ew.w2);
        $('ns-car').textContent = fmt(P.tile - P.ns.w1 - P.ns.w2);
        $('ew-car').textContent = fmt(P.tile - P.ew.w1 - P.ew.w2);
        $('foot-tone').textContent = (P.footTone > 0 ? '+' : '') + P.footTone;
        $('pave-tone').textContent = (P.paveTone > 0 ? '+' : '') + P.paveTone;
        $('btn-iso').className = P.iso ? 'on' : '';
        $('btn-lattice').className = P.lattice ? 'on' : '';
        $('btn-kerb').className = P.kerb ? 'on' : '';
        $('btn-dims').className = P.dims ? 'on' : '';
    }

    function syncArtReadouts() {
        $('art-zoom-v').textContent = String(ART.zoom);
        $('art-force-v').textContent = ART.forceAuto ? 'auto' : String(ART.force);
        $('art-force-auto').className = ART.forceAuto ? 'on' : '';
        $('art-flip').className = ART.flip ? 'on' : '';
        $('art-raw').className = ART.raw ? 'on' : '';
        $('art-grid').className = ART.grid ? 'on' : '';
        var dirs = ['e', 'w', 'n', 's'];
        for (var i = 0; i < dirs.length; i++) {
            $('btn-mask-' + dirs[i]).className = ART.mask[dirs[i]] ? 'on' : '';
            $('btn-probe-' + dirs[i]).className = ART.probe[dirs[i]] ? 'on' : '';
        }
    }

    function syncWaterReadouts() {
        $('w-zoom-v').textContent = String(WATER.zoom);
        $('w-force-v').textContent = WATER.forceAuto ? 'auto' : String(WATER.force);
        $('w-force-auto').className = WATER.forceAuto ? 'on' : '';
        $('w-flip').className = WATER.flip ? 'on' : '';
        $('w-raw').className = WATER.raw ? 'on' : '';
        $('w-grid').className = WATER.grid ? 'on' : '';
        var dirs = ['e', 'w', 'n', 's'];
        for (var i = 0; i < dirs.length; i++) {
            $('wbtn-mask-' + dirs[i]).className = WATER.mask[dirs[i]] ? 'on' : '';
            $('wbtn-probe-' + dirs[i]).className = WATER.probe[dirs[i]] ? 'on' : '';
        }
    }

    /* ±step on one side; the other side is preserved and the carriageway
     * never drops below 1 tile. Steps are eighths of a tile (0.125) so the
     * in-between widths (0.25 / 0.75 / 1.25 …) are directly reachable. */
    function bumpSide(kind, key, delta) {
        var o = P[kind];
        var other = key === 'w1' ? 'w2' : 'w1';
        var v = Math.round((o[key] + delta) * 8) / 8;
        v = Math.max(0, Math.min(P.tile - 1 - o[other], v));
        o[key] = v;
        renderAll();
    }

    function setPreset(name) {
        var pr = {
            current: [1, 1], hair: [0.25, 0.25], narrow: [0.5, 0.5],
            mid: [0.75, 0.75], midwide: [1.25, 1.25], wide: [1.5, 1.5],
            oneside: [0, 1], none: [0, 0],
        }[name];
        if (!pr) return;
        P.ns.w1 = pr[0]; P.ns.w2 = pr[1];
        P.ew.w1 = pr[0]; P.ew.w2 = pr[1];
        renderAll();
    }

    function bindToggle(id, key) {
        $(id).addEventListener('click', function () {
            P[key] = !P[key];
            renderAll();
        });
    }

    function bindStepper(btnId, fn) {
        $(btnId).addEventListener('click', fn);
    }

    bindToggle('btn-iso', 'iso');
    bindToggle('btn-lattice', 'lattice');
    bindToggle('btn-kerb', 'kerb');
    bindToggle('btn-dims', 'dims');

    var arr = document.querySelectorAll('[data-preset]');
    for (var i = 0; i < arr.length; i++) {
        (function (btn) {
            btn.addEventListener('click', function () { setPreset(btn.getAttribute('data-preset')); });
        })(arr[i]);
    }

    bindStepper('ns-a-minus', function () { bumpSide('ns', 'w1', -0.125); });
    bindStepper('ns-a-plus', function () { bumpSide('ns', 'w1', 0.125); });
    bindStepper('ns-b-minus', function () { bumpSide('ns', 'w2', -0.125); });
    bindStepper('ns-b-plus', function () { bumpSide('ns', 'w2', 0.125); });
    bindStepper('ew-a-minus', function () { bumpSide('ew', 'w1', -0.125); });
    bindStepper('ew-a-plus', function () { bumpSide('ew', 'w1', 0.125); });
    bindStepper('ew-b-minus', function () { bumpSide('ew', 'w2', -0.125); });
    bindStepper('ew-b-plus', function () { bumpSide('ew', 'w2', 0.125); });

    bindStepper('foot-minus', function () { P.footTone = Math.max(-4, P.footTone - 1); renderAll(); });
    bindStepper('foot-plus', function () { P.footTone = Math.min(4, P.footTone + 1); renderAll(); });
    bindStepper('pave-minus', function () { P.paveTone = Math.max(-4, P.paveTone - 1); renderAll(); });
    bindStepper('pave-plus', function () { P.paveTone = Math.min(4, P.paveTone + 1); renderAll(); });

    /* ---- sheet inspector wiring ---- */
    (function fillPackSel() {
        var sel = $('sel-pack');
        for (var pi = 0; pi < PACKS.length; pi++) {
            var o = document.createElement('option');
            o.value = String(pi);
            o.textContent = PACKS[pi][0];
            sel.appendChild(o);
        }
        sel.value = String(ART.pack);
        sel.addEventListener('change', function () {
            ART.pack = +sel.value | 0;
            loadPack();
        });
    })();
    bindStepper('art-zoom-minus', function () { ART.zoom = Math.max(1, ART.zoom - 1); renderArt(); });
    bindStepper('art-zoom-plus', function () { ART.zoom = Math.min(3, ART.zoom + 1); renderArt(); });
    bindStepper('art-force-minus', function () {
        ART.force = ART.forceAuto ? 0 : Math.max(0, ART.force - 1);
        ART.forceAuto = false;
        renderArt();
    });
    bindStepper('art-force-plus', function () {
        ART.force = ART.forceAuto ? 0 : Math.min(10, ART.force + 1);
        ART.forceAuto = false;
        renderArt();
    });
    bindStepper('art-force-auto', function () { ART.forceAuto = !ART.forceAuto; renderArt(); });
    bindStepper('art-flip', function () { ART.flip = !ART.flip; renderArt(); });
    bindStepper('art-raw', function () { ART.raw = !ART.raw; renderArt(); });
    bindStepper('art-grid', function () { ART.grid = !ART.grid; renderArt(); });
    var DIRS = ['e', 'w', 'n', 's'];
    for (var di = 0; di < DIRS.length; di++) {
        (function (d) {
            bindStepper('btn-mask-' + d, function () { ART.mask[d] = !ART.mask[d]; renderArt(); });
            bindStepper('btn-probe-' + d, function () { ART.probe[d] = !ART.probe[d]; renderArt(); });
        })(DIRS[di]);
    }

    /* ---- water inspector wiring (same controls as the sheet tab, own state:
       the river slots share the road sheet but the two tabs are meant to be
       comparable side by side, so forcing a state on one must not move the
       other) ---- */
    (function fillWaterPackSel() {
        var sel = $('sel-water-pack');
        for (var pi = 0; pi < PACKS.length; pi++) {
            var o = document.createElement('option');
            o.value = String(pi);
            o.textContent = PACKS[pi][0];
            sel.appendChild(o);
        }
        sel.value = String(WATER.pack);
        sel.addEventListener('change', function () {
            WATER.pack = +sel.value | 0;
            loadWaterPack();
        });
    })();
    bindStepper('w-zoom-minus', function () { WATER.zoom = Math.max(1, WATER.zoom - 1); renderWater(); });
    bindStepper('w-zoom-plus', function () { WATER.zoom = Math.min(3, WATER.zoom + 1); renderWater(); });
    bindStepper('w-force-minus', function () {
        WATER.force = WATER.forceAuto ? 0 : Math.max(0, WATER.force - 1);
        WATER.forceAuto = false;
        renderWater();
    });
    bindStepper('w-force-plus', function () {
        WATER.force = WATER.forceAuto ? 0 : Math.min(10, WATER.force + 1);
        WATER.forceAuto = false;
        renderWater();
    });
    bindStepper('w-force-auto', function () { WATER.forceAuto = !WATER.forceAuto; renderWater(); });
    bindStepper('w-flip', function () { WATER.flip = !WATER.flip; renderWater(); });
    bindStepper('w-raw', function () { WATER.raw = !WATER.raw; renderWater(); });
    bindStepper('w-grid', function () { WATER.grid = !WATER.grid; renderWater(); });
    for (var wi = 0; wi < DIRS.length; wi++) {
        (function (d) {
            bindStepper('wbtn-mask-' + d, function () { WATER.mask[d] = !WATER.mask[d]; renderWater(); });
            bindStepper('wbtn-probe-' + d, function () { WATER.probe[d] = !WATER.probe[d]; renderWater(); });
        })(DIRS[wi]);
    }

    /* ---- dirt inspector wiring: one control cluster per view (dirtroad
       tab = DIRT, dirt tab = DIRTR), bound through a shared factory ---- */
    function bindDirtView(S) {
        var p = S.pre;
        bindStepper(p + '-zoom-minus', function () { S.zoom = Math.max(1, S.zoom - 1); renderDirt(S); });
        bindStepper(p + '-zoom-plus', function () { S.zoom = Math.min(3, S.zoom + 1); renderDirt(S); });
        bindStepper(p + '-force-minus', function () {
            S.force = S.forceAuto ? 0 : Math.max(0, S.force - 1);
            S.forceAuto = false;
            renderDirt(S);
        });
        bindStepper(p + '-force-plus', function () {
            S.force = S.forceAuto ? 0 : Math.min(10, S.force + 1);
            S.forceAuto = false;
            renderDirt(S);
        });
        bindStepper(p + '-force-auto', function () { S.forceAuto = !S.forceAuto; renderDirt(S); });
        bindStepper(p + '-flip', function () { S.flip = !S.flip; renderDirt(S); });
        bindStepper(p + '-raw', function () { S.raw = !S.raw; renderDirt(S); });
        bindStepper(p + '-grid', function () { S.grid = !S.grid; renderDirt(S); });
        bindStepper(p + '-pack', function () { S.pack = (S.pack + 1) % DIRT_PACKS.length; loadDirtPack(S); });
        for (var di2 = 0; di2 < DIRS.length; di2++) {
            (function (d) {
                bindStepper(p + 'btn-mask-' + d, function () { S.mask[d] = !S.mask[d]; renderDirt(S); });
                bindStepper(p + 'btn-probe-' + d, function () { S.probe[d] = !S.probe[d]; renderDirt(S); });
            })(DIRS[di2]);
        }
    }
    bindDirtView(DIRT);
    bindDirtView(DIRTR);

    $('btn-copy').addEventListener('click', function () {
        var txt = formatRef();
        var done = function () {
            $('copied').textContent = 'copied ✓';
            setTimeout(function () { $('copied').textContent = ''; }, 1500);
        };
        function fallback() {
            var ta = document.createElement('textarea');
            ta.value = txt;
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); done(); } catch (e) { /* ignore */ }
            document.body.removeChild(ta);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(txt).then(done, fallback);
        } else {
            fallback();
        }
    });

    /* ---------------- tabs ----------------
       tab 1 = road sprite-sheet inspector (default), tab 2 = the river
       slots presented the same way (RiverDrawer reuses the road model),
       tab 3 = the original footpath/carriageway tuning rig. Panes use
       display:contents so their sections remain flex items of <main>;
       [hidden] collapses the pane. */
    var TABS = ['tab-sheet', 'tab-water', 'tab-dirt', 'tab-dirt2', 'tab-bridge', 'tab-tune'];
    var TABBTN = { 'tab-sheet': 'tab-btn-sheet', 'tab-water': 'tab-btn-water', 'tab-dirt': 'tab-btn-dirt', 'tab-dirt2': 'tab-btn-dirt2', 'tab-bridge': 'tab-btn-bridge', 'tab-tune': 'tab-btn-tune' };
    var activeTab = 'tab-sheet';
    function setTab(id) {
        if (TABS.indexOf(id) < 0) return;
        activeTab = id;
        for (var ti = 0; ti < TABS.length; ti++) $(TABS[ti]).hidden = (TABS[ti] !== id);
        for (var t in TABBTN) $(TABBTN[t]).className = (t === id) ? 'on' : '';
    }
    (function bindTabs() {
        var arr = document.querySelectorAll('[data-tab]');
        for (var i = 0; i < arr.length; i++) {
            (function (btn) {
                btn.addEventListener('click', function () { setTab(btn.getAttribute('data-tab')); });
            })(arr[i]);
        }
    })();

    /* ---- Bridge study (tab 4) — reproduce one real road×river crossing in
       the engine model so the deck/road stacking can be debugged outside the
       viewer (v32 shipped the viewer's bridge pass with the west rows' decks
       missing; reproduce-and-fix here first). The composite mirrors the
       viewer's three containers: water cells (groundC twin) → bridge pieces
       (bridgeG, screen-space affine = here: tiles × zoom × 64 with the real
       manifest anchors) → road cells (raisedG twin, drawn OVER the deck —
       hiding each row's inner rail is the model's defining behaviour). ---- */
    const BRIDGE_S = 64;                    // art px per tile (city-sprites.json)
    /* Reference block — the 14 pieces the viewer's deriveBridges() produces for
       the four crossings it paints (tools/bridge-sites.py, notes/09 §10).
       DO NOT hand-edit: `node tools/check-bridges.cjs` prints the viewer's
       derive, and the smoke harness fails if this table ever disagrees with it
       (same drift guard as the engine table). Two rows per crossing (constant
       x for +y roads, constant y for +x roads) 4.5 tiles apart, ONE 3-lamppost
       bridgetop_f4 section per road cell over water, both rows on the same
       along position: sections butt-join 4 tiles apart, so the lampposts
       double at every join exactly as the game screenshot shows (globe
       detection 2026-10-27). No bridgebottom pieces: the base pass is empty. */
    const BRIDGE_REF = [
      { site: 'A (road 157,16)', axis: 'y', cells: [[156,16],[156,20]], wband: [16,23], segs: [
        { x: 155.40, y: 20, mir: 0, top: 'bridgetop_f4' },
        { x: 155.40, y: 24, mir: 0, top: 'bridgetop_f4' },
        { x: 159.90, y: 20, mir: 0, top: 'bridgetop_f4' },
        { x: 159.90, y: 24, mir: 0, top: 'bridgetop_f4' } ] },
      { site: 'D (road 226,67)', axis: 'y', cells: [[224,64],[224,68]], wband: [64,71], segs: [
        { x: 223.40, y: 68, mir: 0, top: 'bridgetop_f4' },
        { x: 223.40, y: 72, mir: 0, top: 'bridgetop_f4' },
        { x: 227.90, y: 68, mir: 0, top: 'bridgetop_f4' },
        { x: 227.90, y: 72, mir: 0, top: 'bridgetop_f4' } ] },
      { site: 'B (road 168,48)', axis: 'x', cells: [[168,48],[172,48]], wband: [168,175], segs: [
        { x: 168, y: 48.10, mir: 1, top: 'bridgetop_f4' },
        { x: 172, y: 48.10, mir: 1, top: 'bridgetop_f4' },
        { x: 168, y: 52.60, mir: 1, top: 'bridgetop_f4' },
        { x: 172, y: 52.60, mir: 1, top: 'bridgetop_f4' } ] },
      { site: 'C (inlet 252,49)', axis: 'x', cells: [[252,48]], wband: [252,255], segs: [
        { x: 252, y: 48.10, mir: 1, top: 'bridgetop_f4' },
        { x: 252, y: 52.60, mir: 1, top: 'bridgetop_f4' } ] },
    ];
    /* anchors from web/assets/city/city-sprites.json (art px, 64/tile) — the
       five frames the rule uses; the manifest also carries f0/f1/f7 (the
       two-lamppost pieces) and bridgebottom_f1 for the pieces the rule may
       still want */
    const BRIDGE_ART = {
        bridgetop_f2:     { w: 404, h: 325, ax: 366.95, ay: 248 },
        bridgetop_f3:     { w: 404, h: 306, ax: 366.95, ay: 247.75 },
        bridgetop_f4:     { w: 294, h: 325, ax: 257.2,  ay: 248 },
        bridgetop_f5:     { w: 294, h: 270, ax: 256.95, ay: 247.75 },
        bridgetop_f6:     { w: 294, h: 306, ax: 256.95, ay: 247.75 },
        bridgebottom_f0:  { w: 294, h: 249, ax: 257,    ay: 249 },
    };
    /* per-piece draw order (the viewer: bottom then top per segment); the
       rail-over-road toggle moves every road cell to the front instead */
    const BRIDGE_ORDER = [
        { key: 'bot', label: 'base' },
        { key: 'top', label: 'deck' },
    ];
    const BRIDGE_IMGS = ['bridgetop_f2.png', 'bridgetop_f3.png', 'bridgetop_f4.png',
                         'bridgetop_f5.png', 'bridgetop_f6.png',
                         'bridgebottom_f0.png'];
    var BRIDGE = {
        site: 0, zoom: 0.5,
        railOverRoad: false, bottom: true, top: true, grid: true, anchor: true,
        imgs: {}, failed: false, loaded: 0,
        segOff: [], segBase: [], pieceVis: [], segSel: 0, rowKeys: [],
    };
    /* export-fitted per-span deltas. EMPTY on purpose: the row offsets, the
       4.5-tile row separation, the lattice phase and the deep/shallow choice
       are all measured off the export's lamppost lattice now and live in the
       rule itself (tools/bridge-sites.py / the viewer's BRIDGE_* constants),
       so the reference block already sits on the fitted anchors. Anything left
       here would be a per-span nudge still to be explained; the steppers above
       are how those get explored. */
    var BRIDGE_FIT = {
    };
    function loadBridgeImgs() {
        if (typeof Image === 'undefined') return;
        BRIDGE.failed = false; BRIDGE.loaded = 0;
        BRIDGE_IMGS.forEach(function (f) {
            var name = f.replace(/\.png$/, '');
            var im = new Image();
            im.onload = function () { BRIDGE.imgs[name] = im; BRIDGE.loaded++; renderBridge(); };
            im.onerror = function () { BRIDGE.failed = true; renderBridge(); };
            im.src = '../assets/city/' + f;
        });
    }
    /* tile-space origin of the study area (20×20 tiles centred on the deck) */
    function bridgeOrigin() {
        var site = BRIDGE_REF[BRIDGE.site];
        var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (var i = 0; i < site.segs.length; i++) {
            x0 = Math.min(x0, site.segs[i].x); x1 = Math.max(x1, site.segs[i].x);
            y0 = Math.min(y0, site.segs[i].y); y1 = Math.max(y1, site.segs[i].y);
        }
        return {
            x: Math.floor((x0 + x1) / 2) - 10,
            y: Math.floor((y0 + y1) / 2) - 10,
        };
    }
    /* land road cells one block past the crossing cells, so the road reads as
       continuous through the crossing (drawn with the same pass/art) */
    function roadContextCells() {
        var site = BRIDGE_REF[BRIDGE.site];
        var xs = site.cells.map(function (c) { return c[0]; });
        var ys = site.cells.map(function (c) { return c[1]; });
        if (site.axis === 'y') {
            return [[xs[0], Math.min.apply(null, ys) - 4],
                    [xs[0], Math.max.apply(null, ys) + 4]];
        }
        return [[Math.min.apply(null, xs) - 4, ys[0]],
                [Math.max.apply(null, xs) + 4, ys[0]]];
    }
    /* rebuild BRIDGE.segOff/pieceVis from the reference block: every segment
       (span) carries its own offset + visibility; rowKeys stay for labels
       only (rows = west/east or south/north groupings) */
    function bridgeSiteReset() {
        var site = BRIDGE_REF[BRIDGE.site];
        BRIDGE.rowKeys = [];
        BRIDGE.segOff = [];
        BRIDGE.segBase = [];
        BRIDGE.pieceVis = [];
        BRIDGE.segSel = 0;
        for (var i = 0; i < site.segs.length; i++) {
            var key = site.axis + ':' + (site.axis === 'y' ? site.segs[i].x : site.segs[i].y);
            if (BRIDGE.rowKeys.indexOf(key) < 0) BRIDGE.rowKeys.push(key);
            BRIDGE.segOff.push({ x: 0, y: 0 });
            BRIDGE.segBase.push({ x: 0, y: 0 });
            BRIDGE.pieceVis.push(true);
        }
        buildRowBtns();
    }
    /* apply the export-fitted deltas for the current site (no-op when the
       site has no fit yet — B/D sweeps still pending the user's eye test) */
    function bridgeApplyFit() {
        var f = BRIDGE_FIT[BRIDGE.site];
        if (!f) return false;
        for (var i = 0; i < BRIDGE.segOff.length; i++) {
            BRIDGE.segOff[i].x = f.off[i][0]; BRIDGE.segOff[i].y = f.off[i][1];
            BRIDGE.segBase[i].x = f.base[i][0]; BRIDGE.segBase[i].y = f.base[i][1];
        }
        return true;
    }
    /* the row nearer the viewer (lower on screen): drawn over the road art,
       its mate under it — the viewer's bridgeNearG / bridgeG split. Default
       orientation: a +y road's west row, a +x road's south row. */
    function bridgeNearRow() {
        var site = BRIDGE_REF[BRIDGE.site], best = -1, bv = -Infinity;
        for (var i = 0; i < site.segs.length; i++) {
            var v = site.axis === 'y' ? -site.segs[i].x : site.segs[i].y;
            if (v > bv) { bv = v; best = bridgeRowOf(i); }
        }
        return best;
    }
    function bridgeRowOf(i) {
        var site = BRIDGE_REF[BRIDGE.site];
        return BRIDGE.rowKeys.indexOf(site.axis + ':' + (site.axis === 'y'
            ? site.segs[i].x : site.segs[i].y));
    }
    function waterStateB(x, y) {              // river band from the site table
        var site = BRIDGE_REF[BRIDGE.site];
        var c = site.axis === 'y' ? y : x;    // +y roads cross a horizontal band
        // river slot 1 is the open-water slab (notes: 0 = two-bank shore corner)
        return (c >= site.wband[0] && c <= site.wband[1]) ? 1 : -1;
    }
    /* Screen view: the viewer's own ground projection — CAM.tileAffine, the
       canonical 2:1 oblique (ORIENT fx=1, fy=-1, swap=1: +x runs upper-right,
       +y lower-right). Ground cells draw through this matrix in TILE space
       (groundC/raisedG twins); bridge pieces are screen-space billboards
       placed from the same A, exactly like the viewer's bridgeG. */
    function bridgeView() {
        var org = bridgeOrigin();
        var cols = 20, rows = 20;
        var zoom = BRIDGE.zoom;
        var s = CAM.scale({ zoom: zoom });
        var cv = $('cv-bridge');
        var wc = CAM.tileToWorld(org.x + cols / 2, org.y + rows / 2);
        var A = CAM.tileAffine({ x: wc.x, y: wc.y, zoom: zoom }, cv.width, cv.height);
        return { A: A, s: s, org: org, cols: cols, rows: rows,
                 k: s / BRIDGE_S,
                 base: [A.a, A.d, A.b, A.e, A.c, A.f] };
    }
    /* piece rectangles for one draw pass — the viewer's bridgePiece rule:
       project the segment anchor with the ground affine, then lay an
       axis-aligned billboard about the (mirrored) anchor, k = s/64 px per
       art px. Pure function of BRIDGE_REF + steppers → the harness asserts
       against this. */
    function bridgePieceRects(pass) {
        var site = BRIDGE_REF[BRIDGE.site];
        var v = bridgeView();
        var A = v.A, k = v.k;
        var out = [];
        for (var i = 0; i < site.segs.length; i++) {
            var s = site.segs[i];
            var r = bridgeRowOf(i);
            if (!BRIDGE.pieceVis[i]) continue;
            if (pass === 'bot' && !BRIDGE.bottom) continue;
            if (pass === 'top' && !BRIDGE.top) continue;
            var name = pass === 'bot' ? s.bot : s.top;
            if (!name) continue;              // no base piece in the per-cell model
            if ((pass === 'near' || pass === 'far') &&
                (r === bridgeNearRow()) !== (pass === 'near')) continue;
            var art = BRIDGE_ART[name];
            var ox = s.x + BRIDGE.segOff[i].x + (pass === 'bot' ? BRIDGE.segBase[i].x : 0);
            var oy = s.y + BRIDGE.segOff[i].y + (pass === 'bot' ? BRIDGE.segBase[i].y : 0);
            var px = A.a * ox + A.b * oy + A.c;
            var py = A.d * ox + A.e * oy + A.f;
            out.push({
                name: name, key: pass, seg: i, row: r, mir: s.mir,
                x: px - (s.mir ? art.w - art.ax : art.ax) * k,
                y: py - art.ay * k,
                w: art.w * k, h: art.h * k, px: px, py: py,
            });
        }
        return out;
    }
    function renderBridge() {
        var cv = $('cv-bridge'), ctx = cv.getContext('2d');
        var org = bridgeOrigin();
        var cols = 20, rows = 20;
        var s = CAM.scale({ zoom: BRIDGE.zoom });
        var need = { w: (cols + rows) * CAM.TILE.hw * s + 40,
                     h: (cols + rows) * CAM.TILE.hh * s + 110 };
        if (cv.width < need.w || cv.height < need.h) {
            cv.width = need.w; cv.height = need.h;
        }
        LAB_BASE_MTX = null;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = '#101216';
        ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';
        $('bridge-zoom-v').textContent = Math.round(s) + 'px/unit';
        $('bridge-row-v').textContent = BRIDGE.segOff.length
            ? 'span ' + (BRIDGE.segSel % BRIDGE.segOff.length + 1) + '/' + BRIDGE.segOff.length +
              ' Δ(' + BRIDGE.segOff[BRIDGE.segSel % BRIDGE.segOff.length].x + ',' +
              BRIDGE.segOff[BRIDGE.segSel % BRIDGE.segOff.length].y + ')' +
              ' b(' + BRIDGE.segBase[BRIDGE.segSel % BRIDGE.segBase.length].x + ',' +
              BRIDGE.segBase[BRIDGE.segSel % BRIDGE.segBase.length].y + ')'
            : '—';
        if (BRIDGE.failed) {
            ctx.fillStyle = '#f88';
            ctx.fillText('bridge art failed to load (../assets/city/*)', 12, 12);
            return;
        }
        if (BRIDGE.loaded < BRIDGE_IMGS.length && typeof Image !== 'undefined') {
            ctx.fillStyle = '#cfd6df';
            ctx.fillText('loading bridge art…', 12, 12);
            return;
        }
        var v = bridgeView();
        function chip(txt, x, y) {
            var w = ctx.measureText(txt).width + 8;
            ctx.fillStyle = 'rgba(10,12,15,0.88)';
            ctx.fillRect(x - 2, y - 1, w, 14);
            ctx.fillStyle = '#cfd6df';
            ctx.fillText(txt, x + 2, y + 1);
        }

        /* 1. ground under the ground affine: water cells in TILE space — the
           same matrix the viewer gives groundC (2:1 diamonds; no flat quads) */
        LAB_BASE_MTX = v.base;
        labSetBase(ctx);
        if (WATER.img)
            for (var ty = org.y; ty < org.y + rows; ty++)
                for (var tx = org.x; tx < org.x + cols; tx++) {
                    var ws = waterStateB(tx, ty);
                    if (ws >= 0) blitQuad(ctx, WATER.img, ws, tx, ty, 1, false, false);
                }
        if (BRIDGE.grid) {
            ctx.strokeStyle = 'rgba(255,255,255,0.13)';
            ctx.lineWidth = 1 / v.s;
            for (var gx = org.x; gx <= org.x + cols; gx++) {
                ctx.beginPath(); ctx.moveTo(gx, org.y);
                ctx.lineTo(gx, org.y + rows); ctx.stroke();
            }
            for (var gy = org.y; gy <= org.y + rows; gy++) {
                ctx.beginPath(); ctx.moveTo(org.x, gy);
                ctx.lineTo(org.x + cols, gy); ctx.stroke();
            }
            ctx.lineWidth = 1;
        }

        /* 2. far deck row, the road cells, then the near deck row — the
           viewer's order: bridgeG, raisedG's crossing cells, bridgeNearG */
        var site = BRIDGE_REF[BRIDGE.site];
        /* far row, road cells, near row (the viewer's bridgeG / raisedG /
           bridgeNearG); the rail toggle draws the road under everything */
        var order = BRIDGE.railOverRoad ? ['road', 'bot', 'top']
            : ['bot', 'far', 'road', 'near'];
        for (var oi = 0; oi < order.length; oi++) {
            var pass = order[oi];
            if (pass === 'road') {
                /* engine road cell = 4x4-tile block, 4 quadrant quads, drawn
                   in tile space (blitSlot composes onto the base CTM); the
                   pass bits follow the crossing's road direction */
                labSetBase(ctx);
                var rpass = site.axis === 'y'
                    ? { e: false, w: false, n: true, s: true }
                    : { e: true, w: true, n: false, s: false };
                var rcells = site.cells.concat(roadContextCells());
                for (var ci = 0; ci < rcells.length; ci++) {
                    var c = rcells[ci];
                    ctx.fillStyle = 'rgba(255,255,255,0.03)';
                    ctx.fillRect(c[0], c[1], 4, 4);
                    if (!ART.img) continue;   // sheet still loading (harness: absent)
                    blitEngineCell(ctx, ART.img, rpass, c[0], c[1], 4);
                }
                continue;
            }
            LAB_BASE_MTX = null;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            var rects = bridgePieceRects(pass);
            for (var qi = 0; qi < rects.length; qi++) {
                var rq = rects[qi];
                var bim = BRIDGE.imgs[rq.name];
                if (!bim) continue;           // art not loaded yet (harness-safe)
                if (rq.mir) {
                    ctx.save();
                    ctx.translate(rq.x + rq.w / 2, 0);
                    ctx.scale(-1, 1);
                    ctx.drawImage(bim, -rq.w / 2, rq.y, rq.w, rq.h);
                    ctx.restore();
                } else {
                    ctx.drawImage(bim, rq.x, rq.y, rq.w, rq.h);
                }
                if (BRIDGE.anchor) {
                    ctx.strokeStyle = pass === 'bot' ? '#4dd0e1' : '#ffb74d';
                    ctx.beginPath();
                    ctx.moveTo(rq.px - 4, rq.py); ctx.lineTo(rq.px + 4, rq.py);
                    ctx.moveTo(rq.px, rq.py - 4); ctx.lineTo(rq.px, rq.py + 4);
                    ctx.stroke();
                }
            }
        }
        /* 3. labels (screen space, always) */
        LAB_BASE_MTX = null;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = '#8a93a0';
        ctx.fillText('crossing ' + site.site + ' — 2:1 oblique · order: ' + order.join(' → ') +
            ' — anchors: bottom cyan, top orange', 8, 6);
        chip('centre tile ' + Math.round(org.x + cols / 2) + ',' +
            Math.round(org.y + rows / 2), 8, 24);
        for (var ri = 0; ri < BRIDGE.rowKeys.length; ri++) {
            chip('row ' + BRIDGE.rowKeys[ri].split(':')[1], 8, 44 + ri * 16);
        }
    }
    /* per-span controls: one row per segment — a SELECT button (the steppers
       then move that span) and an ON/OFF visibility toggle */
    function buildRowBtns() {
        var host = $('bridge-rows');
        if (!host) return;
        host.textContent = '';
        var site = BRIDGE_REF[BRIDGE.site];
        var btns = [];
        function sync() {
            for (var j = 0; j < btns.length; j++) {
                var o = btns[j];
                if (o._role === 'sel') o.className = (BRIDGE.segSel === o._seg) ? 'on' : '';
                if (o._role === 'vis') o.className = BRIDGE.pieceVis[o._seg] ? 'on' : '';
            }
        }
        for (var i = 0; i < site.segs.length; i++) {
            (function (i) {
                var s = site.segs[i];
                var sel = document.createElement('button');
                sel.type = 'button';
                sel.textContent = 'span ' + (i + 1) + ' ' + (s.mir ? 'y' : 'x') + s.x + '/' + s.y;
                sel._role = 'sel'; sel._seg = i;
                sel.className = (BRIDGE.segSel === i) ? 'on' : '';
                sel.addEventListener('click', function () {
                    BRIDGE.segSel = i; sync(); renderBridge();
                });
                btns.push(sel);
                host.appendChild(sel);
                var vis = document.createElement('button');
                vis.type = 'button';
                vis.textContent = 'show';
                vis._role = 'vis'; vis._seg = i;
                vis.className = BRIDGE.pieceVis[i] ? 'on' : '';
                vis.addEventListener('click', function () {
                    BRIDGE.pieceVis[i] = !BRIDGE.pieceVis[i]; sync(); renderBridge();
                });
                btns.push(vis);
                host.appendChild(vis);
            })(i);
        }
    }
    /* span nudges: the SELECTED span moves 0.05 tiles per step.
       span ◀▶ = across the road, along ◀▶ = along the road,
       base ◀▶ = extra cross-axis offset applied to the span's BASE piece only
       (the export sweeps show base pieces want to sit west of their deck). */
    (function wireBridge() {
        $('bridge-site').addEventListener('change', function () {
            BRIDGE.site = +$('bridge-site').value | 0;
            bridgeSiteReset();
            renderBridge();
        });
        bindStepper('bridge-zoom-minus', function () { BRIDGE.zoom = Math.max(0.25, BRIDGE.zoom - 0.25); renderBridge(); });
        bindStepper('bridge-zoom-plus', function () { BRIDGE.zoom = Math.min(3, BRIDGE.zoom + 0.25); renderBridge(); });
        function stepSel(step, mode) {
            var site = BRIDGE_REF[BRIDGE.site];
            if (!BRIDGE.segOff.length) return;
            var off = BRIDGE.segOff[BRIDGE.segSel % BRIDGE.segOff.length];
            var cross = site.axis === 'y' ? 'x' : 'y';
            var along = site.axis === 'y' ? 'y' : 'x';
            if (mode === 'base') {
                var b = BRIDGE.segBase[BRIDGE.segSel % BRIDGE.segBase.length];
                b[cross] = Math.round((b[cross] + step) * 100) / 100;
            } else {
                off[mode === 'along' ? along : cross] =
                    Math.round((off[mode === 'along' ? along : cross] + step) * 100) / 100;
            }
            renderBridge();
        }
        bindStepper('bridge-row-minus', function () { stepSel(-0.05, 'cross'); });
        bindStepper('bridge-row-plus', function () { stepSel(0.05, 'cross'); });
        bindStepper('bridge-along-minus', function () { stepSel(-0.05, 'along'); });
        bindStepper('bridge-along-plus', function () { stepSel(0.05, 'along'); });
        bindStepper('bridge-base-minus', function () { stepSel(-0.05, 'base'); });
        bindStepper('bridge-base-plus', function () { stepSel(0.05, 'base'); });
        bindStepper('bridge-fit', function () { bridgeApplyFit(); renderBridge(); });
        bindStepper('bridge-rail', function () { BRIDGE.railOverRoad = !BRIDGE.railOverRoad; renderBridge(); });
        bindStepper('bridge-bottom', function () { BRIDGE.bottom = !BRIDGE.bottom; renderBridge(); });
        bindStepper('bridge-top', function () { BRIDGE.top = !BRIDGE.top; renderBridge(); });
        bindStepper('bridge-grid', function () { BRIDGE.grid = !BRIDGE.grid; renderBridge(); });
        bindStepper('bridge-anchor', function () { BRIDGE.anchor = !BRIDGE.anchor; renderBridge(); });
        bindStepper('bridge-reset', function () { bridgeSiteReset(); renderBridge(); });
        bridgeSiteReset();
    })();

    renderAll();
    loadPack();                              // inspector sheet (async; no-op in harness)
    loadWaterPack();                         // water tab sheet + wave atlas
    loadDirtPack(DIRT);                      // dirtroad tab sheet (async; no-op in harness)
    loadDirtPack(DIRTR);                     // dirt tab sheet
    loadBridgeImgs();                        // bridge tab art (async; no-op in harness)
    setTab('tab-sheet');                     // default tab

    // exposed for the smoke harness
    window.__LAB = {
        P: P, ART: ART, render: renderAll, formatRef: formatRef, setPreset: setPreset,
        engStates: engStates, engFlip: engFlip, ENGINE_FAM: ENGINE_FAM,
        effPass: effPass, quadPick: quadPick,
        WATER: WATER, renderWater: renderWater, rivStates: rivStates, rivFlip: rivFlip,
        RIVER_FAM: RIVER_FAM, RIVER_QUADS: RIVER_QUADS, RIVER_WHAT: RIVER_WHAT,
        RIVER_COVER: RIVER_COVER, RIVER_SLOTS: RIVER_SLOTS, WAVE_CELLS: WAVE_CELLS,
        uvCTM: uvCTM,
        wEffPass: wEffPass, rivPick: rivPick, quadBox: quadBox,
        DIRT: DIRT, DIRTR: DIRTR, DIRT_PACKS: DIRT_PACKS, ROAD_QUADS: ROAD_QUADS,
        decodeRgb: decodeRgb,
        renderDirt: renderDirt, formatDirtRef: formatDirtRef, blitDirtCell: blitDirtCell,
        dEffPass: dEffPass, dPick: dPick, dFlip: dFlip, dTable: dTable,
        BRIDGE: BRIDGE, BRIDGE_REF: BRIDGE_REF, BRIDGE_ART: BRIDGE_ART,
        BRIDGE_FIT: BRIDGE_FIT, bridgeApplyFit: bridgeApplyFit,
        renderBridge: renderBridge, bridgePieceRects: bridgePieceRects,
        bridgeOrigin: bridgeOrigin, bridgeSiteReset: bridgeSiteReset,
        bridgeView: bridgeView,
        setTab: setTab, getTab: function () { return activeTab; },
    };
})();
