/* terrain.js — textured terrain (ground) renderer for the city view
   (Phase 2, M2). Classic script, no modules, no build, no network.

   Depends on camera.js (global CAM) for the oblique projection.
   Data: window.MAP_DATA (js/map-explorer-data.js) — the seven raster
   terrain layers (ocean/sand/dirt/river/road/dirtroad/klsroad), the two
   recovered ocean-brush layers (boardwalk/pier, generator-classified)
   + grass colour.
   DECODE (CORRECTED 2026-10-19, road-spec.json verified against the
   save, notes/01 "Terrain grids: cell semantics"): a layer string is
   NOT one tile per char. 16 consecutive chars are one 4x4-tile CELL
   BLOCK (byte k -> cell row k/4, col k%4); blocks are row-major, 37
   blocks per row (verified: E/W/N/S neighbour-mask reciprocity is
   exactly 1.000 at stride 37 and 0.82-0.88 at every other stride).
   A non-'G' char is one cell: 'P' = solid filled cell (plaza, no
   connectivity); 'a'..'p' = value = byte-97 is the cell's 4-bit
   neighbour mask (E=1, W=2, N=4, S=8). Cell (c,r) covers TOWN tiles
   [CELL_OX+4c .. +4) x [CELL_OY+4r .. +4). The block part of the
   origin is pinned by InnerLandData landBlockPosition (-3,-7 blocks)
   x 16 — but that check is invariant to 16-tile shifts (48 = 3 blocks
   hid the x error). The tile-exact origin, CELL_OX/OY = 0/-112, was
   calibrated against the save's own oracles (notes/06, walk-path
   oracle): rasterised pathCache walk tiles must land on road cells
   and building anchors must not — sweep best at (+48,0) over the old
   (-48,-112): walk hit 22.5% -> 80.7%, building-anchor purity
   87.6% -> 91.0%, and every shared-origin layer improved (buildings
   on river 2.5% -> 0.9%, on sand 4.1% -> 3.6%, on road
   13.1% -> 9.3%). Only the 3072-char ocean
   sea-patch keeps the legacy per-tile frame (its reciprocity is 0.87,
   i.e. not this codebook; the notes/06 §10 water-prop anchoring for
   it stands). town = grid - (ox, oy) (legacy frames only).

   Model (occupancy-driven — documented, notes/06):
     The ground is a flat oblique plane. The base is grass, filling the
     whole viewport (an effectively infinite lawn). Every non-grass tile
     from the terrain layers is drawn as its own 2:1 diamond on top, in
     painter's order (back-to-front by the oriented world row,
     CAM.depth). Roads additionally get a per-tile manhole so the
     street surface reads as paved. The tile-space orientation
     (ORIENT {fx,fy,swap} = {1,−1,1}, ocean along the upper-left edge
     — notes/06 §9) lives in
     camera.js CAM.ORIENT; this renderer derives everything from it.

     Why cell-driven rendering: with the corrected decode the save IS
     the engine's cell model — every non-'G' char is one 4x4-tile
     RoadDrawer cell whose nibble is exactly the neighbour mask the
     RoadDrawer state machine selects art with (notes/06 §10, .rodata
     0x400520). So cells paint as ONE 4x4 diamond each, sheet states
     are selected from the SAVED nibble (Terrain#cellStateFor — no
     occupancy guess needed), and 'P' plazas paint flat full-asphalt
     interiors. The pre-2026-10-19 justification for tile-occupancy
     ("roads are 1-2 tiles wide at arbitrary phases") was an artefact
     of the wrong per-tile decode and is retracted; occupancy maps
     remain, derived from the cells, only for point lookup (typesAt)
     and the avenue/synth overlays.

   Pure: no DOM. `node -e "require('./web/js/terrain.js')"` is safe. */
'use strict';

(function (global) {

    /* terrain type style; array order = draw priority (later overpaints
       earlier), matching the Phase-1 map-explorer layer order. */
    var TYPE_ORDER = ['ocean', 'sand', 'dirt', 'river', 'road', 'dirtroad', 'klsroad',
        'boardwalk', 'pier'];
    /* LOD atlas resolution: atlas px per town tile (Terrain#drawAtlas). */
    var ATLAS_TS = 2;
    /* RE'd solid sea base: mean colour of the sea in the in-game
       full-map export = (84,170,252) (notes/06 §10). Painted as one
       parallelogram under the wave marks; see Terrain#seaFill*. */
    var SEA_RGB = [84, 170, 252];
    var TYPE_STYLE = {
        ocean:    { c: [120, 190, 255] },   /* wave-mark placeholder: the
            solid base (SEA_RGB) carries the RE'd export blue; the game's
            mark art is not yet extracted, so marks render as a lighter
            documented stand-in to keep the RE'd pattern visible. */
        sand:     { c: [223, 206, 138] },
        dirt:     { c: [150, 112, 70] },
        river:    { c: [92, 150, 220] },
        road:     { c: [92, 92, 98], road: true },
        dirtroad: { c: [132, 96, 60], road: true },
        klsroad:  { c: [176, 158, 128], road: true },
        /* brush tiles recovered from the ocean frame (gen_map_explorer
           "brush tiles" block): warm plank tan for boardwalk, weathered
           grey-brown for pier. Flat fills — the plank art is not in the
           extracted packs. */
        boardwalk: { c: [190, 140, 90] },
        pier:      { c: [126, 110, 96] }
    };
    var TYPE_IDX = {};
    TYPE_ORDER.forEach(function (n, i) { TYPE_IDX[n] = i; });
    var EMPTY_TYPES = [];
    /* expose the draw-priority order (city-view details pane + tests) */
    Terrain.TYPE_ORDER = TYPE_ORDER;
    Terrain.SEA_RGB = SEA_RGB;          // WebGL base layer paints the sea quad
    Terrain.FLAT_GRASS_S = 4;           // px/tile under which grass draws flat

    /* Cell-grid constants for the CORRECTED decode (doc block at the top
       of the file). 34784-char layers = 2174 blocks of 16 cell bytes,
       37 blocks per row => 148 x 236 cells; cell (c,r) covers town tiles
       [CELL_OX+4c,+4) x [CELL_OY+4r,+4). Block part pinned by
       InnerLandData landBlockPosition (-3,-7) x 16 (notes/01); tile-
       exact x calibrated to 0 by the walk/building-oracle sweep
       (2026-10-25, notes/06) — the land check is blind to 16-multiples. */
    var CELL_STRIDE = 37;                    // blocks per block-row
    var CELL_OX = 0, CELL_OY = -112;         // town tile of cell (0,0)

    /* Decode a cell-codebook string. Returns [{x, y, m, p}] where
       (x,y) = town tile of the cell's top-left corner, m = neighbour
       nibble (E=1,W=2,N=4,S=8) or -1 for 'P', p = 'P'-solid flag. */
    function decodeCells(str) {
        var out = [];
        for (var i = 0; i < str.length; i++) {
            var c = str.charCodeAt(i);
            if (c === 0x47) continue;                      // 'G' empty
            var blk = (i / 16) | 0, k = i % 16;
            var col = (blk % CELL_STRIDE) * 4 + (k % 4);
            var row = ((blk / CELL_STRIDE) | 0) * 4 + ((k / 4) | 0);
            var solid = c === 0x50;                        // 'P'
            var m = solid ? -1 : c - 0x61;
            if (!solid && (m < 0 || m > 15)) continue;     // unknown char
            out.push({ x: CELL_OX + col * 4, y: CELL_OY + row * 4,
                m: m, p: solid });
        }
        return out;
    }

    /* Saved nibble (E=1,W=2,N=4,S=8; rows grow south) -> SHEET_TABLE's
       tile-space convention (1=+x, 2=-x, 4=+y, 8=-y road neighbours in
       tile space). W->-x, N->-y, S->+y; verified against occupancy
       reciprocity on the shipped save (1173/1173 exact among pure-
       nibble adjacencies; mismatches only where a 'P' neighbour is
       road-derived). NOTE: W keeps bit 2 — an earlier build mapped it
       with <<1 to +y, which turned every E-W straight (nibble 3) into
       a bend half-split and left the visible streets without their
       band/sidewalk art. */
    Terrain.cellStateFor = function (m) {
        if (m < 0) return [0, false];                      // 'P' -> flat
        var t = (m & 3) | ((m & 4) << 1) | ((m & 8) >> 1);
        return Terrain.SHEET_TABLE[t];
    };

    /* Decode a layer string to a flat [x0, y0, x1, y1, ...] grid list.
       LEGACY per-tile codebook — retained ONLY for the 3072-char ocean
       sea-patch (reciprocity 0.87: not the cell codebook) and the
       pre-decoded brush layers. Normal layers: char i covers row y=i/32,
       16 sub-columns along x.
       The sea patch (vert=true, the 3072-char oceanData frame) is stored
       COLUMN-major: each char covers column x=i/32, 16 sub-cells along
       y — and it is anchored OUTSIDE the town frame, offshore west of
       grid x=0 (Terrain#seaColOffset; Squid Port water props at x
       -44..1, boardwalk at x -11..0, road min x = 0, river mouths at
       x=3 — notes/06 §10). Proof it cannot be row-major: with row-major
       the sea sits at grid rows 0..33 where ZERO water props, river
       mouths or coastline furniture exist, while 127 floating props sit
       at negative x along the left edge. */
    function decodeTiles(str, vert, pout) {
        var out = [];
        for (var i = 0; i < str.length; i++) {
            var c = str.charCodeAt(i);
            if (c === 0x47) continue;                 // 'G' -> none
            var r = (i / 32) | 0, x0 = (i % 32) * 16;
            if (c === 0x50) {                          // 'P' -> all 16
                for (var k = 0; k < 16; k++) {
                    if (vert) out.push(r, x0 + k); else out.push(x0 + k, r);
                    if (pout) { if (vert) pout.push(r, x0 + k); else pout.push(x0 + k, r); }
                }
            } else {
                var kk = c - 0x61;
                if (kk >= 0 && kk < 16) { if (vert) out.push(r, x0 + kk); else out.push(x0 + kk, r); }
            }
        }
        return out;
    }

    /* Speckle filter (2026-10-19, CORRECTED): the original "filler"
       classifications (sand/dirtroad/klsroad drop, road anchor) were
       artefacts of the WRONG per-tile decode — lattice phases like
       "x≡3 mod 16" were index-calculation shadows. Under the verified
       cell decode every non-ocean layer has neighbour-mask reciprocity
       1.000 at stride 37 and forms genuine connected shapes (DIRT_ROADS
       = one 94-cell footpath, KLSROAD = one 16-cell path, SAND = three
       beach masses, max 547 cells, DIRT = 11 tracks). Nothing in these
       layers is generator filler, so the policy table is EMPTY and the
       filter ships as an inert no-op (legend row + persistence kept for
       A/B while the corrected look is eye-tested; setSpeckleFilter
       stays wired). The 'anchor'/'drop' machinery below is retained in
       case a future layer earns a policy. */
    var SPECKLE_POLICY = {};
    Terrain.SPECKLE_POLICY = SPECKLE_POLICY;

    /* keep[i] = true when tile i of pts belongs to an 8-connected
       component that contains at least one tile also present in pkeys
       (a "key set" of "x,y" strings — the 'P'-derived tiles).
       four=true switches the component growth to 4-connectivity: under
       the orthogonal road-network reading of ROADS (Terrain#roadNetwork)
       a street has no diagonal edges, so a filler single that only
       touches authored ground on a corner is NOT anchored and drops. */
    function anchoredKeep(pts, pkeys, four) {
        var n = pts.length >> 1, first = {}, i, k;
        for (i = 0; i < n; i++) {
            k = pts[2 * i] + ',' + pts[2 * i + 1];
            if (first[k] == null) first[k] = i;
        }
        var comp = new Array(n), compHasP = [], cid = 0;
        for (i = 0; i < n; i++) {
            if (comp[i] != null) continue;
            var stack = [i]; comp[i] = cid; var hasP = false;
            while (stack.length) {
                var cur = stack.pop(), cx = pts[2 * cur], cy = pts[2 * cur + 1];
                if (pkeys[cx + ',' + cy]) hasP = true;
                for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
                    if (!dx && !dy) continue;
                    if (four && dx && dy) continue;   // orthogonal: no diagonal edges
                    var j = first[(cx + dx) + ',' + (cy + dy)];
                    if (j != null && comp[j] == null) { comp[j] = cid; stack.push(j); }
                }
            }
            compHasP[cid] = hasP; cid++;
        }
        var keep = new Array(n);
        for (i = 0; i < n; i++) keep[i] = compHasP[comp[i]];
        return keep;
    }

    /* Terrain wraps a MAP_DATA object and renders its ground.
       opts.grassImg  — optional HTMLImageElement for the grass texture
       opts.grassRepeat — world tiles per one grass-texture repeat (default 8) */
    function Terrain(M, opts) {
        opts = opts || {};
        this.ox = M.ox;
        this.oy = M.oy;
        this.grass = M.grass;
        this.grassImg = opts.grassImg || null;
        this.grassRepeat = opts.grassRepeat != null ? opts.grassRepeat : 8;
        /* minimum on-screen feature-tile width in CSS px (see render) */
        this.minTilePx = opts.minTilePx != null ? opts.minTilePx : 4;
        /* Solid sea base (notes/06 §10): the game paints a continuous
           water-blue under the ocean wave-mark layer. The sea-patch
           frame (oceanData, 3072 chars) is COLUMN-major (char i covers
           16 sub-cells along y of column i/32) and sits OUTSIDE the
           town frame, WEST of grid x=0 (proven 2026-10-17: 127 water
           props — yachts, submarines, whales, 8 private islands,
           Skull/Garbage Island, SquidportEntrance, BarnacleBayMarina,
           boardwalk stalls/railings — occupy x -44..+1, y 30..500;
           the road layer's min x is exactly 0; zero water or road
           cells near the top rows). The shoreline runs at grid x ≈ 0,
           the coast spans y 0..512 (the frame's long axis), and the
           wave marks (cols 2..26) sit on the water via seaColOffset.
           SEA base blue sampled from the export = (84,170,252).
           Documented knobs; re-tune edges with the M4 landmark
           calibration. */
        this.seaFill = opts.seaFill !== false;
        this.seaColOffset = opts.seaColOffset != null ? opts.seaColOffset : -33;  // grid x = frame col + this
        this.seaFillX0 = opts.seaFillX0 != null ? opts.seaFillX0 : -64;           // water's offshore edge
        this.seaFillX1 = opts.seaFillX1 != null ? opts.seaFillX1 : 0;             // shoreline
        this.seaFillY0 = opts.seaFillY0 != null ? opts.seaFillY0 : 0;             // coast start (grid)
        this.seaFillY1 = opts.seaFillY1 != null ? opts.seaFillY1 : 512;           // coast end (grid)
        /* Road sheet art (2026-10-17, M4 fix): the REAL in-game base
           tiles from web/assets/dlc/roadrivertiles-50/images/
           roadtilesheet.png. The 512x512 sheet is a plane tiling of
           ~135x74 2:1 diamonds; cell (c, r) centre sits at
             x = 274 + 135*c + (r mod 2)*67.5,  y = 140 + 37*r
           (lattice measured via the contact-sheet pass, notes/06 s10).
           M4 RE (notes/06 s10): the engine's RoadDrawer ships 11
           pre-composited cell states as UV quads at libscorpio.so
           .rodata 0x400520 (11 x 32 bytes = top/right/left/bottom
           (u,v) corners, x512 = sheet px). Each quad is the cell
           diamond INSET to 127x66 (centre +/- 63.5, 33) — sampling the
           full 135x74 box bleeds neighbouring cells into the diamond
           corners (the green/cliff triangles the eye test caught).
           The 11 state cells: 0=(-1,7) FULL ASPHALT, 1=(-1,5),
           2=(-1,6), 3=(-2,5), 4=(-1,4), 5=(-1,1), 6=(-2,1),
           7=(-1,-1), 8=(-1,3), 9=(-2,3), 10=(-1,2). NOTE: (-1,4) —
           the original 2026-10-17 pick, mis-catalogued as "plain
           asphalt" — is state 4, a COMPOSITE cell (half lavender
           paving-grid + asphalt); that was the "wrong tile art" the
           user rejected. state 0 (-1,7) is the true plain asphalt
           (light grey + sparse manhole dots) and is the default.
           terrain.js stays DOM-free, so the CALLER owns the
           HTMLImageElement and assigns it to Terrain#roadSheetImg;
           while it is null/not complete, roads keep the flat Phase-1
           fills. sheetSlots maps layer -> [c, r]. The sheet holds no
           dirt-road variants, so dirtroad/klsroad keep flat fills —
           deliberate, not an oversight.
           SELECTION (2026-10-17, M4): Terrain#sheetSelect picks how a
           road tile chooses its state cell. 'uniform' (shipped
           default) draws every road tile as sheetSlots.road (state 0,
           flat asphalt). 'neighbor' runs the RE'd selection model of
           the RoadDrawer base-tile selector (libscorpio.so 0x1208058,
           notes/06 s10): the engine branches on a per-cell 4-bit
           neighbour-connectivity nibble (record byte 4 & 0xf, helper
           0x1134fa8) confirmed by +/-1-cell neighbour queries, and
           mirrors left/right state variants on a coordinate parity
           (the csel/tst w21,1 sites at 0x1208234/0x12084d4). We
           reproduce that as: mask = which of the 4 tile-space
           neighbours (bits 1=+x, 2=-x, 4=+y, 8=-y) are road tiles;
           Terrain.SHEET_TABLE[mask] gives [state, flip]. Sheet
           quadrant semantics (u = sheet image column, drawn along
           q2-q0 = screen right; v = image row, along q3-q1 = screen
           down; see _sheetTile): the quadrant facing tile +x is
           (u>0,v<0), +y
           is (u>0,v>0), -x is (u<0,v>0), -y is (u<0,v<0); classifying
           each state's quadrants by material (asphalt grey vs
           lavender paving) gives state 1 = right-half asphalt
           ({+x,+y}), state 5 = top-half ({+x,-y}), state 8 =
           bottom-half ({-x,+y}), states 3/4 = 3-of-4 asphalt with a
           paving+kerb strip on the -y/-x edge; flip = horizontal
           mirror (tile-space +x<->-y, +y<->-x), supplying the
           right-edge variants the sheet only ships mirrored. Dead
           ends and diagonals have no art in the 11 states and fall
           back to state 0. The engine additionally alternates variant
           pairs (e.g. 3 vs 10) on coordinate parity — not modelled
           yet; documented simplification.
           Terrain#useSheetArt=false forces flat colours (the manhole
           ellipses then return).
           STATUS 2026-10-17 (M4): shipped OFF by default until the
           user approves the corrected look; the City View "Road art"
           toolbar button cycles OFF -> uniform sheet -> neighbour-
           selected sheet live (localStorage mrsnrub.cityview.sheetart
           stores 0/1/2). */
        this.useSheetArt = opts.useSheetArt === true;
        this.roadSheetImg = opts.roadSheetImg || null;
        this.sheetSlots = opts.sheetSlots || { road: [-1, 7] };
        this.sheetSelect = opts.sheetSelect || 'uniform';
        /* Experimental N–S avenues (M4 TODO 1b): the game renders
           continuous 2-cell-wide N–S streets that are NOT in the save
           road layer at all (2026-10-17 investigation, notes/06 s10) —
           verified streets at grid x 66-67 & 90-91 (y 221-258),
           114-115 (y 263-272) and 30-31 (y 235-250) — per-block,
           hand-placed, client-side
           (see Terrain.AVENUE + notes/06 §10 RE findings) — so they are
           template roads the server never persists. Turning this on
           (requires useSheetArt + sheetSelect='neighbor') synthesises
           those cells: they then select masks 13/14 = kerb states 4 /
           3+flip from the existing SHEET_TABLE. See Terrain.AVENUE. */
        this.useAvenues = opts.useAvenues === true;
        /* Debug overlay: magenta diamonds on the saved 1-wide N–S
           fragments — road cells with no road at ±x but road at ±y
           (driveway/frontage stubs, notes/06 s10) — to tell them apart
           from the 2-wide streets (boulevards + synthesised avenues). */
        this.debugFrags = opts.debugFrags === true;
        /* Overlay for CANDIDATE N–S streets awaiting user eye-test
           (Terrain.PROPOSED + the City View verdict panel, M4 tool
           2026-10-18): per-cell fills tinted by verdict — pending cyan
           / ok green / bad red. Never affects occupancy or masks. */
        this.showProposed = opts.showProposed === true;
        /* id of the candidate currently hovered in the verdict panel
           (js/city-view.js row mouseenter): rendered in high-visibility
           yellow with outlines while the rest dim back, so an off-screen
           candidate can be found at a glance. null = none. */
        this.hoverProposed = opts.hoverProposed != null ? +opts.hoverProposed : null;
        /* Per-type visibility (City View legend toggles): keys are layer
           type names ('grass', 'ocean', 'sand', ...); hiding 'ocean'
           hides the wave marks AND the solid sea base. See
           Terrain#setVisible. */
        this.hidden = {};

        /* Raw decoded layers, kept so the ACTIVE feature set can be
           rebuilt on toggle (Terrain#_rebuild). Cell-codebook layers get
           `cells`: [{x,y,m,p}] in TOWN tiles (top-left tile of the
           4x4 cell, mask nibble, P-solid flag). Legacy layers (ocean
           sea-patch, pre-decoded brush) keep `pts`: flat [tx,ty,...]
           town tiles + `p` {"tx,ty":true} P-derived keys. */
        this._raw = [];
        for (var li = 0; li < M.layers.length; li++) {
            var L = M.layers[li];
            var ti = TYPE_IDX[L.n];
            if (ti == null) continue;
            if (L.pts) {
                /* brush layers ship pre-decoded (pts already in grid
                   coords, seaColOffset applied) — legacy frame */
                var t0 = L.pts.slice(), pts0 = new Array(t0.length);
                for (var i0 = 0; i0 < t0.length; i0 += 2) {
                    pts0[i0] = t0[i0] - this.ox; pts0[i0 + 1] = t0[i0 + 1] - this.oy;
                }
                this._raw.push({ ti: ti, pts: pts0, p: {} });
                continue;
            }
            if (L.s.length === 3072) {
                /* the sea-patch frame is not the cell codebook (legacy
                   column-major per-tile decode; see decodeTiles) */
                var pout = [];
                var t = decodeTiles(L.s, true, pout);
                for (var j = 0; j < t.length; j += 2) t[j] += this.seaColOffset;
                for (var pj = 0; pj < pout.length; pj += 2) pout[pj] += this.seaColOffset;
                var pts = new Array(t.length), pkeys = {};
                for (var i = 0; i < t.length; i += 2) {
                    pts[i] = t[i] - this.ox; pts[i + 1] = t[i + 1] - this.oy;
                }
                for (var pi = 0; pi < pout.length; pi += 2) {
                    pkeys[(pout[pi] - this.ox) + ',' + (pout[pi + 1] - this.oy)] = true;
                }
                this._raw.push({ ti: ti, pts: pts, p: pkeys });
                continue;
            }
            this._raw.push({ ti: ti, cells: decodeCells(L.s), p: null });
        }
        /* Speckle filter (see SPECKLE_POLICY): ON by default — hides the
           engine-generated filler grids. City View exposes it as a
           legend row and persists it (mrsnrub.cityview.speckle). */
        this.speckleFilter = opts.speckleFilter !== false;
        /* Road network model (2026-10-19 A/B): reads ROADS as an
           ORTHOGONAL network — 4-connected streets with corners,
           T-junctions and solid 'P' plazas — rather than an
           unstructured tile soup. Two consequences, both only active
           when on:
             1. the speckle anchor grows 4-connected (anchoredKeep
                `four`): a filler single that only DIAGONALLY touches
                authored ground no longer survives the 'anchor' policy;
             2. 'P'-derived road tiles keep their provenance in
                Terrain#_plazaOcc and render as flat full-asphalt plaza
                INTERIORS (sheet state 0), bypassing the neighbour-mask
                kerb/corner selection — a solid plaza has no kerb edge
                to fake. Visible with sheet art on (Road art·edges).
           Ships OFF; the City View "Road network" button flips it live
           (mrsnrub.cityview.roadnet), _rebuild() re-runs on toggle. */
        this.roadNetwork = opts.roadNetwork === true;
        this._rebuild();
        this._pat = null; // grass pattern, built lazily (needs a ctx)
    }

    Terrain.prototype = {
        /* The oblique tile->screen transform (tile coords -> device px),
           as a [a,b,c,d,e,f] for ctx.setTransform. Derives from the same
           world mapping as CAM.worldToScreen so ground and sprites share
           one projection. */
        groundTransform: function (cam, vw, vh) {
            var s = CAM.scale(cam), t = CAM.TILE;
            var ex = CAM.oriented(1, 0), ey = CAM.oriented(0, 1);   // tile-basis images (u,v)
            return [s * (ex[0] - ex[1]) * t.hw, s * (ex[0] + ex[1]) * t.hh,
                s * (ey[0] - ey[1]) * t.hw, s * (ey[0] + ey[1]) * t.hh,
                vw / 2 - cam.x * s, vh / 2 - cam.y * s];
        },

        /* Town-tile rect that covers the (axis-aligned) screen viewport,
           with a one-tile margin. Used to bound the grass fill and to
           cull feature tiles. */
        visibleTileRect: function (cam, vw, vh) {
            var c = [CAM.screenToWorld(cam, 0, 0, vw, vh),
                     CAM.screenToWorld(cam, vw, 0, vw, vh),
                     CAM.screenToWorld(cam, 0, vh, vw, vh),
                     CAM.screenToWorld(cam, vw, vh, vw, vh)];
            var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
            for (var i = 0; i < 4; i++) {
                var p = CAM.worldToTile(c[i].x, c[i].y);
                if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
                if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
            }
            x0 = Math.floor(x0) - 1; y0 = Math.floor(y0) - 1;
            x1 = Math.ceil(x1) + 1;  y1 = Math.ceil(y1) + 1;
            return { x0: x0, y0: y0, x1: x1, y1: y1 };
        },

        /* One 2:1 diamond (screen px) for the tile rect
           [x,x+big) x [y,y+big) at town tile (x,y): [T,R,B,L]. */
        quad: function (cam, vw, vh, x, y, big) {
            big = big || 1;
            var p = [CAM.tileToWorld(x, y), CAM.tileToWorld(x + big, y),
                     CAM.tileToWorld(x + big, y + big), CAM.tileToWorld(x, y + big)];
            var out = [];
            for (var i = 0; i < 4; i++)
                out.push(CAM.worldToScreen(cam, p[i].x, p[i].y, vw, vh));
            return out;
        },

        _grassPattern: function (ctx) {
            if (!this.grassImg) return null;
            if (!this._pat) {
                this._pat = ctx.createPattern(this.grassImg, 'repeat');
                // pattern px -> tile units: one 1024px texture spans
                // grassRepeat tiles, so it tiles on the (skewed) grid.
                var k = this.grassRepeat / 1024;
                if (this._pat.setTransform && typeof DOMMatrix !== 'undefined')
                    this._pat.setTransform(new DOMMatrix().scale(k, k));
            }
            return this._pat;
        },

        /* Toggle a ground type on/off (legend UI). type is a layer name
           ('grass', 'ocean', 'sand', 'dirt', 'river', 'road',
           'dirtroad', 'klsroad'); 'ocean' covers the wave marks and the
           solid sea base together. */
        setVisible: function (type, on) {
            if (on) delete this.hidden[type];
            else this.hidden[type] = true;
        },
        isHidden: function (type) { return !!this.hidden[type]; },

        /* Rebuild the ACTIVE feature set from this._raw honouring the
           current speckleFilter. Sets features / _occ / _roadOcc /
           bbox / typeBBox. features is in TOWN coords, pre-sorted in
           painter's order (CAM.depth row, tie oriented x) so the
           per-frame pass just culls; each entry [tx, ty, typeIndex].
           _occ is the same occupancy keyed "tx,ty" -> typeIndices in
           LAYER push order (later = painted on top), for point lookups
           (Terrain#typesAt / Terrain#topTypeAt — click-to-inspect). */
        _rebuild: function () {
            var feat = [];
            this._occ = {};
            this._plazaOcc = {};   // 'P'-derived ROAD tiles kept (plaza interiors)
            this._fragCells = null;   // re-derived from the road occ below
            for (var li = 0; li < this._raw.length; li++) {
                var L = this._raw[li];
                var isRoad = TYPE_ORDER[L.ti] === 'road';
                if (L.cells) {
                    if (SPECKLE_POLICY[TYPE_ORDER[L.ti]]) continue;
                    for (var ci = 0; ci < L.cells.length; ci++) {
                        var cl = L.cells[ci];
                        feat.push([cl.x, cl.y, L.ti, cl.m, cl.p ? 1 : 0, 4]);
                        for (var dy = 0; dy < 4; dy++)
                            for (var dx = 0; dx < 4; dx++) {
                                var ok = (cl.x + dx) + ',' + (cl.y + dy);
                                if (this._occ[ok]) this._occ[ok].push(L.ti);
                                else this._occ[ok] = [L.ti];
                                if (cl.p && isRoad) this._plazaOcc[ok] = 1;
                            }
                    }
                    continue;
                }
                for (var i = 0; i < L.pts.length; i += 2) {
                    var gx = L.pts[i], gy = L.pts[i + 1];
                    feat.push([gx, gy, L.ti, -2, 0, 1]);   // legacy tile
                    var ok2 = gx + ',' + gy;
                    if (this._occ[ok2]) this._occ[ok2].push(L.ti); else this._occ[ok2] = [L.ti];
                    if (L.p[ok2] && isRoad) this._plazaOcc[ok2] = 1;
                }
            }
            feat.sort(function (a, b) {
                var ua = CAM.oriented(a[0] + (a[5] - 1) / 2, a[1] + (a[5] - 1) / 2),
                    ub = CAM.oriented(b[0] + (b[5] - 1) / 2, b[1] + (b[5] - 1) / 2);
                var d = (ua[0] + ua[1]) - (ub[0] + ub[1]);
                return d !== 0 ? d : ua[0] - ub[0];
            });
            this.features = feat;

            /* Road occupancy lookup for sheetSelect='neighbor': the
               selector RE (notes/06 s10) confirms adjacency with +/-1
               neighbour queries, so we keep a "tx,ty" set of ROAD-layer
               tiles (town coords) for the mask. dirtroad/klsroad do not
               count — they keep flat fills and are not roadrivertiles.
               Built from the ACTIVE (filtered) tiles so the neighbour
               masks match what is actually painted. _roadOccAll keeps
               the UNfiltered saved roads for diagnostics (debugFrags —
               the overlay exists to inspect the very fragments the
               filter hides, so it must see the raw save). */
            this._roadOcc = {};
            this._roadOccAll = {};
            for (var li2 = 0; li2 < this._raw.length; li2++) {
                var R = this._raw[li2];
                if (TYPE_ORDER[R.ti] !== 'road') continue;
                if (R.cells) {
                    for (var rci = 0; rci < R.cells.length; rci++) {
                        var rc = R.cells[rci];
                        for (var ry = 0; ry < 4; ry++)
                            for (var rx = 0; rx < 4; rx++)
                                this._roadOccAll[(rc.x + rx) + ',' + (rc.y + ry)] = 1;
                    }
                    continue;
                }
                for (var ri = 0; ri < R.pts.length; ri += 2)
                    this._roadOccAll[R.pts[ri] + ',' + R.pts[ri + 1]] = 1;
            }
            for (var fi = 0; fi < feat.length; fi++) {
                if (TYPE_ORDER[feat[fi][2]] !== 'road') continue;
                var ff = feat[fi], fb = ff[5] || 1;
                for (var fy = 0; fy < fb; fy++)
                    for (var fx = 0; fx < fb; fx++)
                        this._roadOcc[(ff[0] + fx) + ',' + (ff[1] + fy)] = 1;
            }

            /* feature bounding box in town coords, for coarse culling
               (cell features span f[5] tiles from their origin) */
            if (feat.length) {
                this.bbox = {
                    x0: feat[0][0], y0: feat[0][1], x1: feat[0][0], y1: feat[0][1]
                };
                for (var j = 1; j < feat.length; j++) {
                    var f = feat[j], sp = f[5] - 1;
                    if (f[0] < this.bbox.x0) this.bbox.x0 = f[0];
                    if (f[1] < this.bbox.y0) this.bbox.y0 = f[1];
                    if (f[0] + sp > this.bbox.x1) this.bbox.x1 = f[0] + sp;
                    if (f[1] + sp > this.bbox.y1) this.bbox.y1 = f[1] + sp;
                }
            } else {
                this.bbox = null;
            }
            /* per-type bounding boxes (indexed by TYPE_IDX), used by the
               Ocean view preset to frame a single terrain layer */
            this.typeBBox = {};
            for (var k = 0; k < feat.length; k++) {
                var g = feat[k], sp2 = g[5] - 1, tb = this.typeBBox[g[2]];
                if (!tb) tb = this.typeBBox[g[2]] = { x0: g[0], y0: g[1], x1: g[0], y1: g[1] };
                if (g[0] < tb.x0) tb.x0 = g[0];
                if (g[1] < tb.y0) tb.y0 = g[1];
                if (g[0] + sp2 > tb.x1) tb.x1 = g[0] + sp2;
                if (g[1] + sp2 > tb.y1) tb.y1 = g[1] + sp2;
            }
            /* ground changed shape: the LOD atlas (Terrain#drawAtlas) is stale */
            this._atlas = null;
            this._atlasFlat = null;
        },

        /* ---- zoomed-out LOD atlas (2026-10-20.3) ------------------------------
           At orbit zoom every frame re-submitted ~4.3k tiny AA diamonds as
           paths. Canvas2D may be GPU-accelerated (Firefox WebRender), but
           path RECORDING/tessellation stays CPU and per-primitive, so that
           dominated zoomed-out pan/fling cost. The ground is static in
           TILE space, so rasterise it once per layer type into an offscreen
           canvas (ATLAS_TS px per town tile) and blit each frame under the
           tile->screen affine: whole-town pan = ~9 textured quads + the
           grass/ocean rects instead of 4.3k fills. Survives orientation
           changes (the atlas is ORIENT-independent — the affine changes)
           and legend toggles (hidden layers just skip their blit); any
           feature rebuild (_rebuild) drops it. */
        /* flattened per-visible-layer atlas bitmap + tile origin, shared by
           the 2D drawAtlas blit and the WebGL base layer (flatInfo). */
        _flat: function () {
            var at = this._buildAtlas();
            if (!at) return null;
            var sig = '', t;
            for (t = 0; t < TYPE_ORDER.length; t++)
                sig += this.hidden[TYPE_ORDER[t]] ? '1' : '0';
            if (!this._atlasFlat || this._atlasFlatSig !== sig) {
                if (typeof document === 'undefined' || !document.createElement)
                    return null;
                var flat = document.createElement('canvas');
                flat.width = at.W; flat.height = at.H;
                var fc = flat.getContext('2d');
                for (t = 0; t < at.byType.length; t++)
                    if (at.byType[t] && !this.hidden[TYPE_ORDER[t]])
                        fc.drawImage(at.byType[t], 0, 0);
                this._atlasFlat = flat; this._atlasFlatSig = sig;
            }
            return { img: this._atlasFlat, x0: at.x0, y0: at.y0,
                     W: at.W, H: at.H };
        },

        /* CityGL (WebGL base layer) access: {img,x0,y0,W,H,ts} or null */
        flatInfo: function () {
            var f = this._flat();
            if (!f) return null;
            f.ts = ATLAS_TS;
            return f;
        },

        drawAtlas: function (ctx, A, dpr) {
            var at = this._flat();
            if (!at) return false;               // no canvas (headless) -> caller batches
            var k = ATLAS_TS, d = dpr || 1,
                tcx = A.c + A.a * at.x0 + A.b * at.y0,
                tcy = A.f + A.d * at.x0 + A.e * at.y0;
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'low';    // fast minify path
            ctx.save();
            ctx.setTransform(d * A.a / k, d * A.d / k, d * A.b / k, d * A.e / k,
                d * tcx, d * tcy);
            ctx.drawImage(at.img, 0, 0, at.W, at.H, 0, 0, at.W, at.H);
            ctx.restore();
            return true;
        },

        _buildAtlas: function () {
            if (this._atlas) return this._atlas;
            if (this._atlasFail || !this.features.length ||
                typeof document === 'undefined' || !document.createElement)
                return null;
            var bb = this.bbox;
            var x0 = bb.x0 - 1, y0 = bb.y0 - 1, x1 = bb.x1 + 1, y1 = bb.y1 + 1;
            var W = Math.max(1, Math.ceil((x1 - x0) * ATLAS_TS)),
                H = Math.max(1, Math.ceil((y1 - y0) * ATLAS_TS));
            if (W * H > 40e6) { this._atlasFail = 1; return null; }   // sanity
            var byType = [], t, i, f, cv, c, big, bleed = 0.5;
            for (t = 0; t < TYPE_ORDER.length; t++) {
                var any = 0;
                for (i = 0; i < this.features.length; i++)
                    if (this.features[i][2] === t) { any = 1; break; }
                if (!any) { byType.push(null); continue; }
                cv = document.createElement('canvas');
                cv.width = W; cv.height = H;
                c = cv.getContext('2d');
                c.fillStyle = 'rgb(' + TYPE_STYLE[TYPE_ORDER[t]].c.join(',') + ')';
                for (i = 0; i < this.features.length; i++) {
                    f = this.features[i];
                    if (f[2] !== t) continue;
                    big = f[5] || 1;
                    /* bleed each tile half an atlas px: bilinear magnify
                       then leaves no coverage seams between neighbours */
                    c.fillRect((f[0] - x0) * ATLAS_TS - bleed,
                        (f[1] - y0) * ATLAS_TS - bleed,
                        big * ATLAS_TS + bleed * 2, big * ATLAS_TS + bleed * 2);
                }
                byType.push(cv);
            }
            this._atlas = { x0: x0, y0: y0, W: W, H: H, byType: byType };
            return this._atlas;
        },

        /* Toggle the speckle filter live (City View legend row). */
        setSpeckleFilter: function (on) {
            on = !!on;
            if (on === this.speckleFilter) return;
            this.speckleFilter = on;
            this._rebuild();
        },

        /* Toggle the road network model live (City View "Road network"
           button, Terrain#roadNetwork): re-runs the anchor pass with
           4- vs 8-connectivity; plaza painting follows the flag. */
        setRoadNetwork: function (on) {
            on = !!on;
            if (on === this.roadNetwork) return;
            this.roadNetwork = on;
            this._rebuild();
        },

        /* Town-tile terrain lookup: typeIndices of the layers covering
           (x,y), in layer draw order (last = painted on top); [] = pure
           grass. Occupancy is cell [x,x+1)×[y,y+1) in tile-space — the
           same cell quad() draws. */
        typesAt: function (x, y) { return this._occ[x + ',' + y] || EMPTY_TYPES; },

        /* Top-most VISIBLE terrain type name at town tile (x,y),
           honouring the ground-legend toggles: 'grass' for the base fill,
           null when every layer at that tile (grass included) is hidden. */
        topTypeAt: function (x, y) {
            var a = this._occ[x + ',' + y];
            if (a) for (var i = a.length - 1; i >= 0; i--) {
                var n = TYPE_ORDER[a[i]];
                if (!this.hidden[n]) return n;
            }
            return this.hidden['grass'] ? null : 'grass';
        },

        /* Render the whole ground: grass base + non-grass feature tiles.
           The caller's base transform (e.g. a DPR scale) is left intact on
           return; all coordinates are in CSS px, so feature tiles are drawn
           under that base transform while the grass fill bakes `dpr` into its
           own absolute transform. */
        render: function (ctx, cam, vw, vh, dpr) {
            dpr = dpr || 1;
            var T = this.visibleTileRect(cam, vw, vh);

            /* 1 — grass base (skewed, filling the viewport). Skipped when
               the WebGL base layer owns the frame (this.glBase). Below
               FLAT_GRASS_S the lawn texture is minified beyond
               recognition (one 1024px pattern spans 8 tiles = a couple of
               screen px per tuft) and the skewed full-viewport pattern
               fill is the last heavy Canvas2D raster call in a zoomed-out
               frame — paint the flat lawn colour instead (the GL layer
               samples the tile as a mipmapped quad and keeps it). */
            var tf = this.groundTransform(cam, vw, vh);
            if (!this.glBase && !this.hidden['grass']) {
                if (CAM.scale(cam) < Terrain.FLAT_GRASS_S) {
                    ctx.save();
                    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                    ctx.fillStyle = 'rgb(' + this.grass.join(',') + ')';
                    ctx.fillRect(0, 0, vw, vh);
                    ctx.restore();
                } else {
                    ctx.save();
                    ctx.setTransform(tf[0] * dpr, tf[1] * dpr, tf[2] * dpr, tf[3] * dpr,
                        tf[4] * dpr, tf[5] * dpr);
                    var pat = this._grassPattern(ctx);
                    if (pat) ctx.fillStyle = pat;
                    else ctx.fillStyle = 'rgb(' + this.grass.join(',') + ')';
                    ctx.fillRect(T.x0, T.y0, T.x1 - T.x0, T.y1 - T.y0);
                    ctx.restore();   // back to the caller's base transform (e.g. DPR)
                }
            }

            /* 1b — solid sea base: one parallelogram over the water
               polygon west of the shoreline — grid x seaFillX0..X1
               (offshore..shoreline), y seaFillY0..Y1 along the coast —
               in town coords, using the same ground transform as the
               grass fill. Under the wave-mark tiles so their pattern
               survives. */
            if (!this.glBase && this.seaFill && this.seaFillX1 > this.seaFillX0 && !this.hidden['ocean']) {
                var sx0 = this.seaFillX0 - this.ox, sy0 = this.seaFillY0 - this.oy;
                var sx1 = this.seaFillX1 - this.ox, sy1 = this.seaFillY1 - this.oy;
                if (sx0 < T.x1 && sx1 > T.x0 && sy0 < T.y1 && sy1 > T.y0) {
                    ctx.save();
                    ctx.setTransform(tf[0] * dpr, tf[1] * dpr, tf[2] * dpr, tf[3] * dpr,
                        tf[4] * dpr, tf[5] * dpr);
                    ctx.fillStyle = 'rgb(' + SEA_RGB.join(',') + ')';
                    ctx.fillRect(sx0, sy0, sx1 - sx0, sy1 - sy0);
                    ctx.restore();
                }
            }

            /* 2 — feature tiles (culled to the visible rect + bbox) */
            if (!this.features.length) return;
            var bb = this.bbox;
            var cx0 = Math.max(T.x0, bb.x0 - 2), cx1 = Math.min(T.x1, bb.x1 + 2);
            var cy0 = Math.max(T.y0, bb.y0 - 2), cy1 = Math.min(T.y1, bb.y1 + 2);
            var s = CAM.scale(cam);
            /* minimum on-screen tile width (CSS px): sparse small layers
               (ocean/sand/river are only a few % coverage) vanish at
               whole-town zoom — ~2 px diamonds on grass — so under-
               threshold tiles are painted as a fixed-size 2:1 diamond at
               the tile centre. Roads (dense + contiguous) already read
               as lines, but the same rule keeps them crisp at any zoom. */
            var minHw = this.minTilePx / 2, hhRatio = CAM.TILE.hh / CAM.TILE.hw;
            var hwPx = s * CAM.TILE.hw, hhPx = s * CAM.TILE.hh;
            var tiny = hwPx < minHw;
            if (tiny) { hwPx = minHw; hhPx = minHw * hhRatio; }
            /* LOD batch (tiny == whole-town orbit, s < minTilePx/2): every
               feature is the same fixed-size 2:1 diamond, so per-tile
               beginPath/fill was ~4.3k path fills per frame — the frame
               cost of zoomed-out pans. Collect the diamonds per type
               through the tile->screen affine (4 mul-adds/corner, no
               per-point allocation) and paint ONE path per type in
               TYPE_ORDER, which is the documented layer paint order —
               indistinguishable at sub-pixel tile size. Above tiny, the
               exact per-quad path below stays in charge (sheet art,
               manholes, and the depth-sorted multi-tile cells live there). */
            var A = null, buckets = null, atlasBlit = false;
            if (tiny) {
                A = CAM.tileAffine(cam, vw, vh);
                /* one blit per layer from the tile-space atlas (preferred);
                   if no canvas is available, fall back to batched paths */
                atlasBlit = this.glBase ? true : this.drawAtlas(ctx, A, dpr);
                if (!atlasBlit) {
                    buckets = [];
                    for (var bi = 0; bi < TYPE_ORDER.length; bi++) buckets.push([]);
                }
            }
            for (var i = 0; !atlasBlit && i < this.features.length; i++) {
                var f = this.features[i], tx = f[0], ty = f[1],
                    big = f[5] || 1, sp = big - 1;
                if (this.hidden[TYPE_ORDER[f[2]]]) continue;   // legend toggle
                if (tx + sp < cx0 || tx > cx1 || ty + sp < cy0 || ty > cy1) continue;
                var st = TYPE_STYLE[TYPE_ORDER[f[2]]];
                var q;
                if (buckets) {
                    var mx = tx + big / 2, my = ty + big / 2;
                    var ccx = A.a * mx + A.b * my + A.c,
                        ccy = A.d * mx + A.e * my + A.f;
                    buckets[f[2]].push(
                        ccx, ccy - hhPx, ccx + hwPx, ccy,
                        ccx, ccy + hhPx, ccx - hwPx, ccy);
                    continue;
                } else {
                    q = this.quad(cam, vw, vh, tx, ty, big);
                }
                ctx.beginPath();
                ctx.moveTo(q[0].x, q[0].y);
                ctx.lineTo(q[1].x, q[1].y);
                ctx.lineTo(q[2].x, q[2].y);
                ctx.lineTo(q[3].x, q[3].y);
                ctx.closePath();
                ctx.fillStyle = 'rgb(' + st.c.join(',') + ')';
                ctx.fill();
                if (st.road && !tiny) {
                    /* sheet art over the flat fill (opaque cell, clipped to
                       the diamond); flat fill underneath avoids AA seams. */
                    var slot = this.useSheetArt && this.roadSheetImg &&
                        this.roadSheetImg.complete &&
                        this.sheetSlots[TYPE_ORDER[f[2]]];
                    if (slot) {
                        if (f[3] >= -1) {
                            /* Cell-codebook road (corrected decode): the
                               SAVED nibble drives the state directly for
                               nibbled cells (the RoadDrawer state the
                               engine itself would select). 'P' cells
                               (m=-1) are full-coverage road cells — E-W
                               avenues INCLUDING their sidewalk columns
                               plus plaza slabs — and are NOT inherently
                               flat: export transects (2026-10-25,
                               mapdump/registration/m4-av-*.png) show the
                               outer rows of every road band are paved
                               sidewalk cells, so they select art from
                               the occupancy union via _pavePick (kerb/
                               paving pieces at band edges, flat inside
                               interiors and plaza slabs). */
                            var pickc;
                            if (f[3] < 0) pickc = this._pavePick(tx, ty);
                            else {
                                var tn = (f[3] & 3) | ((f[3] & 4) << 1) |
                                    ((f[3] & 8) >> 1);
                                /* 1-wide straights are a FULL cross-section
                                   (grass both sides of a cell-wide road):
                                   flat asphalt under, strip-clipped kerb/
                                   paving pieces along the two grass edges
                                   (Terrain.SHEET_CLIP_S). One full band
                                   piece stacks paving and reads
                                   sidewalk-heavy (user eye test
                                   2026-10-25). */
                                if (tn === 3)
                                    pickc = [[0, false, null],
                                        [3, false, 'ny'], [4, true, 'py']];
                                else if (tn === 12)
                                    pickc = [[0, false, null],
                                        [4, false, 'nx'], [3, true, 'px']];
                                else {
                                    var pn = Terrain.SHEET_TABLE[tn];
                                    pickc = [[pn[0], pn[1], null]];
                                }
                            }
                            if (!pickc) pickc = [[0, false, null]];
                            for (var pi = 0; pi < pickc.length; pi++) {
                                if (pickc[pi][2]) {
                                    ctx.save();
                                    this._halfClip(ctx, q, pickc[pi][2]);
                                    this._sheetTile(ctx, q, this.roadSheetImg,
                                        Terrain.SHEET_STATES[pickc[pi][0]],
                                        pickc[pi][1]);
                                    ctx.restore();
                                } else {
                                    this._sheetTile(ctx, q, this.roadSheetImg,
                                        Terrain.SHEET_STATES[pickc[pi][0]],
                                        pickc[pi][1]);
                                }
                            }
                        } else if (this.roadNetwork && this._plazaOcc[tx + ',' + ty]) {
                            /* Solid 'P' plaza interior (legacy tiles): a
                               plaza is a contiguous slab, so it gets flat
                               full-asphalt state 0 and never the
                               neighbour-mask kerb/corner art. */
                            this._sheetTile(ctx, q, this.roadSheetImg,
                                Terrain.SHEET_STATES[0], false);
                        } else if (this.sheetSelect === 'neighbor') {
                            var pick = Terrain.sheetStateFor(this._roadOcc, tx, ty,
                                this.useAvenues ? this._avenueProbe() : null);
                            this._sheetTile(ctx, q, this.roadSheetImg,
                                Terrain.SHEET_STATES[pick[0]], pick[1]);
                        } else {
                            this._sheetTile(ctx, q, this.roadSheetImg, slot, false);
                        }
                    }
                    else this._manhole(ctx, cam, vw, vh,
                        tx + sp / 2, ty + sp / 2, s);
                }
            }

            /* path-batch fallback flush (only when the atlas was
               unavailable): one fill per terrain type. */
            if (buckets) {
                for (var ti = 0; ti < buckets.length; ti++) {
                    var bk = buckets[ti];
                    if (!bk.length) continue;
                    ctx.beginPath();
                    for (var k = 0; k < bk.length; k += 8) {
                        ctx.moveTo(bk[k], bk[k + 1]);
                        ctx.lineTo(bk[k + 2], bk[k + 3]);
                        ctx.lineTo(bk[k + 4], bk[k + 5]);
                        ctx.lineTo(bk[k + 6], bk[k + 7]);
                        ctx.closePath();
                    }
                    ctx.fillStyle = 'rgb(' +
                        TYPE_STYLE[TYPE_ORDER[ti]].c.join(',') + ')';
                    ctx.fill();
                }
            }

            /* Experimental N–S avenues (M4 TODO 1b, Terrain.AVENUE): draw
               the synthesised avenue cells that the save layer lacks, with
               the same flat-under-sheet treatment as saved roads. Masks
               come from the union of save roads + avenues, so cells get
               13/14 (kerb 4 / 3+flip) along the flanks and 15 (interior)
               where an avenue crosses a saved E–W band. */
            if (this.useAvenues && this.useSheetArt && this.roadSheetImg &&
                this.roadSheetImg.complete && !tiny) {
                var A = Terrain.AVENUE, occ2 = this._roadOcc,
                    probe = this._avenueProbe();
                var yLo = A.streets[0][2], yHi = A.streets[0][3], si;
                var xLo = A.streets[0][0], xHi = A.streets[0][1];
                for (si = 1; si < A.streets.length; si++) {
                    if (A.streets[si][2] < yLo) yLo = A.streets[si][2];
                    if (A.streets[si][3] > yHi) yHi = A.streets[si][3];
                    if (A.streets[si][0] < xLo) xLo = A.streets[si][0];
                    if (A.streets[si][1] > xHi) xHi = A.streets[si][1];
                }
                var ay0 = Math.max(cy0, yLo - this.oy),
                    ay1 = Math.min(cy1, yHi - this.oy),
                    ax0 = Math.max(cx0, xLo - this.ox),
                    ax1 = Math.min(cx1, xHi - this.ox);
                for (var ay = ay0; ay <= ay1; ay++) {
                    for (var ax = ax0; ax <= ax1; ax++) {
                        if (!probe(ax, ay) || occ2[ax + ',' + ay]) continue;
                        var aq = this.quad(cam, vw, vh, ax, ay);
                        ctx.beginPath();
                        ctx.moveTo(aq[0].x, aq[0].y);
                        ctx.lineTo(aq[1].x, aq[1].y);
                        ctx.lineTo(aq[2].x, aq[2].y);
                        ctx.lineTo(aq[3].x, aq[3].y);
                        ctx.closePath();
                        ctx.fillStyle = 'rgb(' + TYPE_STYLE.road.c.join(',') + ')';
                        ctx.fill();
                        var apick = Terrain.sheetStateFor(occ2, ax, ay, probe);
                        this._sheetTile(ctx, aq, this.roadSheetImg,
                            Terrain.SHEET_STATES[apick[0]], apick[1]);
                    }
                }
            }

            /* Debug overlay (Terrain#debugFrags): highlight the saved
               1-wide N–S fragment cells in translucent magenta. The
               classification is computed once from the road occupancy:
               no road at ±x, road at ±y. These are the driveways/
               frontage stubs — NOT streets; the game draws them as
               plain grey slivers too (no 1-wide kerb art exists). */
            if (this.debugFrags) {
                if (!this._fragCells) {
                    var occF = this._roadOccAll, cells = [], k;
                    for (k in occF) {
                        if (!occF.hasOwnProperty(k)) continue;
                        var pp = k.split(','), fx = +pp[0], fy = +pp[1];
                        if (!occF[(fx - 1) + ',' + fy] && !occF[(fx + 1) + ',' + fy] &&
                            (occF[fx + ',' + (fy - 1)] || occF[fx + ',' + (fy + 1)])) {
                            cells.push([fx, fy]);
                        }
                    }
                    this._fragCells = cells;
                }
                ctx.fillStyle = 'rgba(255,0,255,0.55)';
                for (var gi = 0; gi < this._fragCells.length; gi++) {
                    var gc = this._fragCells[gi];
                    if (gc[0] < cx0 || gc[0] > cx1 || gc[1] < cy0 || gc[1] > cy1) continue;
                    var gq = this.quad(cam, vw, vh, gc[0], gc[1]);
                    ctx.beginPath();
                    ctx.moveTo(gq[0].x, gq[0].y);
                    ctx.lineTo(gq[1].x, gq[1].y);
                    ctx.lineTo(gq[2].x, gq[2].y);
                    ctx.lineTo(gq[3].x, gq[3].y);
                    ctx.closePath();
                    ctx.fill();
                }
            }

            /* Proposed-street overlay (Terrain#showProposed): candidate
               N–S streets from Terrain.PROPOSED, drawn per-cell in
               verdict colour — pending cyan, ok green, bad red — so the
               user can eye-test them in City View against the game look
               without touching the shipped street table (avenueAt /
               _roadOcc are deliberately NOT consulted). Streets carry
               GRID coords; quads need town tiles, hence the ox/oy shift.
               Fills are depth-agnostic debug tint — painter order of the
               ground pass is already done here. While Terrain#hoverProposed
               names a candidate (verdict-panel row mouseover) that street
               is repainted LAST in loud yellow with dark cell outlines and
               the rest dim to ghost alpha, so it can be found instantly. */
            if (this.showProposed) {
                var PS = Terrain.PROPOSED.streets;
                var hov = this.hoverProposed, hovFound = null;
                for (var ph = 0; ph < 2; ph++) {
                    for (var pi = 0; pi < PS.length; pi++) {
                        var st = PS[pi];
                        var isHov = hov != null && st.id === hov;
                        if (isHov) hovFound = 1;
                        if (ph === 0 ? isHov : !isHov) continue;
                        var sx0 = st.x0 - this.ox, sx1 = st.x1 - this.ox,
                            sy0 = st.ylo - this.oy, sy1 = st.yhi - this.oy;
                        if (sx1 < cx0 || sx0 > cx1 || sy1 < cy0 || sy0 > cy1) continue;
                        var pv = Terrain.PROPOSED.verdicts[st.id];
                        ctx.fillStyle = isHov ? 'rgba(255,214,10,0.80)' :
                            hov != null ? 'rgba(150,150,170,0.18)' :
                                pv === 'ok' ? 'rgba(70,220,120,0.50)' :
                                    pv === 'bad' ? 'rgba(230,70,70,0.35)' :
                                        'rgba(0,200,255,0.45)';
                        if (isHov) { ctx.strokeStyle = 'rgba(15,15,22,0.9)'; ctx.lineWidth = 1; }
                        var qx0 = Math.max(sx0, cx0), qx1 = Math.min(sx1, cx1),
                            qy0 = Math.max(sy0, cy0), qy1 = Math.min(sy1, cy1);
                        for (var qy = qy0; qy <= qy1; qy++)
                            for (var qx = qx0; qx <= qx1; qx++) {
                                var pq = this.quad(cam, vw, vh, qx, qy);
                                ctx.beginPath();
                                ctx.moveTo(pq[0].x, pq[0].y);
                                ctx.lineTo(pq[1].x, pq[1].y);
                                ctx.lineTo(pq[2].x, pq[2].y);
                                ctx.lineTo(pq[3].x, pq[3].y);
                                ctx.closePath();
                                ctx.fill();
                                if (isHov) ctx.stroke();
                            }
                    }
                    if (ph === 0 && !hovFound) break;    // hover id not on list
                }
            }
        },

        /* Paint the sheet cell (slot=[c,r]) over the diamond quad q.
           Lattice constants are documented at Terrain#useSheetArt. The
           source box is the cell diamond INSET to 127x66 (centre
           +/- 63.5, 33) — exactly the engine's RoadDrawer UV quads
           (.rodata 0x400520), which avoids sampling the neighbouring
           cells that crowd the lattice cell's corners. The box is
           mapped by an affine so the cell's diamond maps exactly onto
           q (the oblique projection is affine, so this is exact, not
           an approximation); ctx.transform COMPOSES, keeping the
           caller's DPR base transform intact. AXES (fixed 2026-10-17
           .20): quad() returns [corner(x,y)=LEFT, (x+1,y)=TOP,
           (x+1,y+1)=RIGHT, (x,y+1)=BOTTOM], so the SHEET's horizontal
           (image-column) axis must follow q2-q0 (screen right) and
           its vertical (image-row) axis q1-q3 (screen down). The
           original mapping had these swapped, rendering every
           composite state rotated 90 degrees — kerb strips facing
           across the band instead of along it. flip = horizontal
           mirror of the sheet box (screen-left/right swap). */
        _sheetTile: function (ctx, q, img, slot, flip) {
            var cx = 274 + 135 * slot[0] + (((slot[1] % 2) + 2) % 2) * 67.5;
            var cy = 140 + 37 * slot[1];
            var Cx = (q[0].x + q[2].x) / 2, Cy = (q[0].y + q[2].y) / 2;
            var ux = (q[2].x - q[0].x) / 127, uy = (q[2].y - q[0].y) / 127;
            if (flip) { ux = -ux; uy = -uy; }   // horizontal mirror in-cell
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(q[0].x, q[0].y);
            ctx.lineTo(q[1].x, q[1].y);
            ctx.lineTo(q[2].x, q[2].y);
            ctx.lineTo(q[3].x, q[3].y);
            ctx.closePath();
            ctx.clip();
            ctx.transform(ux, uy,
                (q[3].x - q[1].x) / 66, (q[3].y - q[1].y) / 66, Cx, Cy);
            ctx.drawImage(img, cx - 63.5, cy - 33, 127, 66, -63.5, -33, 127, 66);
            ctx.restore();
        },

        /* Neighbour-art pick for saved 'P' cells (m=-1). 'P' means all
           16 sub-cells are road, which covers the E-W paved avenues,
           plaza slabs and crossings. Returns an array of sheet passes
           [[state, flip, clipTri|null]] or null for the caller's flat
           state 0. Interiors (union mask 15) and lone cells are flat;
           plaza-style slabs (vertical run >=8 through the origin) stay
           flat as the RE says a solid plaza fakes no kerb. Band-edge
           rows (mask 7/11: road E+W, grass on one of N/S — the
           export-verified sidewalk lanes) pick the kerb/paving pieces
           from SHEET_TABLE, and when the band is exactly ONE cell tall
           (no road cell above/below on the cell lattice) the opposite
           edge gets a second pass clipped to the far half-diamond, so
           the road wears sidewalks on both sides like the export
           cross-sections (m4-av-avenue90.png: L-A-A-L). */
        _pavePick: function (tx, ty) {
            var occ = this._roadOcc,
                probe = this.useAvenues ? this._avenueProbe() : null;
            function at(x, y) {
                return (occ[x + ',' + y] || (probe && probe(x, y))) ? 1 : 0;
            }
            var m = at(tx + 1, ty) | (at(tx - 1, ty) << 1) |
                (at(tx, ty + 1) << 2) | (at(tx, ty - 1) << 3);
            if (m === 15 || m === 0) return null;
            if (m === 7 || m === 11) {
                var n = 1, y = ty - 1;
                while (n < 8 && at(tx, y)) { n++; y--; }
                y = ty + 1;
                while (n < 8 && at(tx, y)) { n++; y++; }
                if (n >= 8) return null;            // plaza slab interior edge
                var r = 1, x = tx - 1;
                while (r < 8 && at(x, ty)) { r++; x--; }
                x = tx + 1;
                while (r < 8 && at(x, ty)) { r++; x++; }
                if (r < 8) return null;             // stub, not a street edge
            }
            var base = Terrain.SHEET_TABLE[m];
            /* one-cell-tall/wide band: the grass side sits INSIDE the
               cell's footprint too. Paint the whole cell flat asphalt
               first, then lay the kerb/paving piece over each grass-side
               strip ONLY (sheetClipPoly) — full pieces stack their
               paving bands and drown the road (user eye test 2026-10-25). */
            if (m === 7 && !at(tx, ty + 4))
                return [[0, false, null], [3, false, 'ny'], [4, true, 'py']];
            if (m === 11 && !at(tx, ty - 4))
                return [[0, false, null], [3, false, 'ny'], [4, true, 'py']];
            return [[base[0], base[1], null]];
        },

        /* Strip clip for the 3-pass composites (nibble straights +
           _pavePick bands). q order is [LEFT, TOP, RIGHT, BOTTOM] (see
           _sheetTile); 'ny'/'py'/'nx'/'px' selects the strip along that
           edge. The strip runs from the diamond's outer edges to an
           inner diamond scaled by Terrain.SHEET_CLIP_S about the
           centre — NOT the full half-diamond: the state 3/4 paving art
           measures ~2/3 of the way into the cell (row scan of the
           sheet, 2026-10-25), so a full-half clip shows all of it and
           reads sidewalk-heavy (user eye test). Shared with the Pixi
           viewer, which bakes these polygons into its cleaned sheet
           copy — see Terrain.sheetClipPoly. */
        _halfClip: function (ctx, q, side) {
            var tri = Terrain.sheetClipPoly(q, side);
            ctx.beginPath();
            ctx.moveTo(tri[0].x, tri[0].y);
            for (var i = 1; i < tri.length; i++) ctx.lineTo(tri[i].x, tri[i].y);
            ctx.closePath();
            ctx.clip();
        },

        /* A small 2:1 manhole ellipse at a road tile centre. */
        /* bound town->grid avenue test for sheetStateFor's `extra` */
        _avenueProbe: function () {
            var ox = this.ox, oy = this.oy;
            return function (tx, ty) {
                return Terrain.avenueAt(tx + ox, ty + oy) ? 1 : 0;
            };
        },

        _manhole: function (ctx, cam, vw, vh, x, y, s) {
            var t = CAM.TILE, uv = CAM.oriented(x, y);
            var c = CAM.worldToScreen(cam,
                (uv[0] - uv[1]) * t.hw, (uv[0] + uv[1] + 1) * t.hh, vw, vh);
            var rx = 4 * s / 64, ry = 2 * s / 64;
            ctx.beginPath();
            ctx.ellipse(c.x, c.y, rx, ry, 0, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(20,20,26,0.85)';
            ctx.fill();
        }
    };

    /* RE'd RoadDrawer state catalogue + selection table (M4, notes/06 s10).
       SHEET_STATES[k] = sheet lattice cell (c, r) of UV-quad k at
       .rodata 0x400520 (quadrant material classification, doc block at
       Terrain#useSheetArt). SHEET_TABLE[mask] = [state, flip] for the
       4-bit neighbour mask (1=+x, 2=-x, 4=+y, 8=-y road neighbours in
       tile space). Mask semantics recap: 15 interior -> 0 flat
       asphalt; 3-of-4 band-edge rows -> 3/4 (+flips for the grass on
       the mirrored side); corner bends -> half-split states 1/5/8;
       dead ends have no art -> 0. 1-wide straights (mask 3 E-W, mask
       12 N-S) reuse the band states: the engine (FUN_01308058) draws
       each cell as 4 iso quadrant quads choosing from this same
       catalogue, composing straights from the state 3/4 diagonal band
       art; one band piece per cell is our single-piece equivalent.
       Mirrors: flip maps
       +x<->-y, +y<->-x, so 3(flip)=mask 14, 4(flip)=mask 11,
       1(flip)=mask 10. */
    Terrain.SHEET_STATES = [
        [-1, 7], [-1, 5], [-1, 6], [-2, 5], [-1, 4], [-1, 1],
        [-2, 1], [-1, -1], [-1, 3], [-2, 3], [-1, 2]
    ];
    Terrain.SHEET_TABLE = [
        [0, false], [0, false], [0, false], [3, false],  // 0..2 dead-end, 3 E-W 1-wide straight
        [0, false], [1, false], [8, false], [3, false],  // 4..7 dead-end, bend-R, bend-B, edge -y
        [0, false], [5, false], [1, true], [4, true],    // 8..11 dead-end, bend-T, bend-L, edge +y
        [4, false], [4, false], [3, true], [0, false]    // 12 N-S 1-wide straight, edge -x, edge +x, interior
    ];
    /* Sidewalk strip width for the 3-pass composite pieces: the piece
       shows the region between its diamond and a copy scaled S about
       the centre, cut to the grass side (hexagon). Per-side visible
       area fraction = (1 - S²)/2 — S = 0.71 gives sidewalk ≈ 25% per
       edge and an asphalt core ≈ 50%, matching the export L-A-A-L
       transects; a full half (S = 0) reads ~50% sidewalk. The Pixi
       viewer bakes these polygons into its cleaned sheet copy, so the
       geometry lives here once. q order = [LEFT, TOP, RIGHT, BOTTOM]. */
    Terrain.SHEET_CLIP_S = 0.71;
    Terrain.sheetClipPoly = function (q, side) {
        var s = Terrain.SHEET_CLIP_S;
        var cx = (q[0].x + q[2].x) / 2, cy = (q[0].y + q[2].y) / 2;
        function k(p) {
            return { x: cx + (p.x - cx) * s, y: cy + (p.y - cy) * s };
        }
        var iL = k(q[0]), iT = k(q[1]), iR = k(q[2]), iB = k(q[3]);
        return side === 'ny' ? [q[0], q[1], q[2], iR, iT, iL] :
            side === 'py' ? [iL, q[0], q[3], q[2], iR, iT] :
            side === 'px' ? [iT, q[1], q[2], q[3], iB, iR] :
                            [iT, q[1], q[0], q[3], iB, iL];  // 'nx'
    };
    Terrain.sheetStateFor = function (occ, tx, ty, extra) {
        function at(x, y) {
            return (occ[x + ',' + y] || (extra && extra(x, y))) ? 1 : 0;
        }
        var m = at(tx + 1, ty) | (at(tx - 1, ty) << 1) |
            (at(tx, ty + 1) << 2) | (at(tx, ty - 1) << 3);
        return Terrain.SHEET_TABLE[m];
    };

    /* Experimental procedural N–S avenues (M4 TODO 1b). The save's
       road layer holds continuous streets in the E–W (tile-x) family
       ONLY; the game's N–S avenues are client-side. Per the 2026-10-17
       RE pass (notes/06 §10): the original server's starter land (HAR
       captures, server/payloads) stores just ONE 'P' E–W run + 7 frags,
       and the client owns a full XML land format (`tile x y road ...`
       seeded by StartingLand.xml, loader 0x10b4784) that the server
       never sees. Streets are HAND-PLACED per block, so the knob ships
       measured streets explicitly ([x0, x1, yLo, yHi] grid cells,
       inclusive; export local-affine walk, <4 px near the west anchors)
       rather than a generalised pitch grid — 114/115 has no street in
       the 221-258 band, it sits at y 263-272. 30/31 @ 235-250 added
       after the user eye test (2026-10-17.25); 78/79 REJECTED (plaza
       paving — the plaza grey passes the asphalt key); 118/119 is
       "partially correct" per the user and awaits re-measure under
       fixed east-side registration (M4 item 3). Evidence crops
       mapdump/registration/m4-av-cand-*.png.
       Generator RE pending, so OFF by default. */
    Terrain.AVENUE = {
        /* each entry [x0, x1, yLo, yHi] inclusive; hand-placed streets.
           Entries are FULL 4-column road bands: 2 asphalt columns (the
           ghost-overlay-verified cores) + 1-wide lavender sidewalk
           column each side — export transect across the 90/91 avenue
           measures L-A-A-L at cols 89..92 (2026-10-25, notes/06 s10),
           and the E-W saved P bands are the same 2+2 structure. The
           avenue draw pass selects flank masks 13/14 (kerb 4 / 3+flip)
           from the union occupancy, so the outer columns render as
           paving, the inner two as flat asphalt. */
        streets: [
            [65, 68, 221, 258],   // core 66/67, ghost-overlay verified 2026-10-16
            [89, 92, 221, 258],   // core 90/91 (transect-verified sidewalks 89/92)
            [113, 116, 263, 272], // core 114/115, 9/9 crisp rows 2026-10-17
            [29, 32, 235, 250],   // core 30/31, user eye-tested 2026-10-17.25
            [125, 128, 146, 208]  // core 126/127, user eye-tested 2026-10-18
                                   // (verdict id 1: four-way with crossings
                                   //  by the police stn)
        ]
    };
    /* grid-coord test (pure); render call sites convert town -> grid
       via Terrain#_avenueProbe */
    Terrain.avenueAt = function (gx, gy) {
        var S = Terrain.AVENUE.streets, i, s;
        for (i = 0; i < S.length; i++) {
            s = S[i];
            if (gx >= s[0] && gx <= s[1] && gy >= s[2] && gy <= s[3])
                return true;
        }
        return false;
    };

    /* Candidate N–S streets awaiting the user eye test (M4 verdict tool,
       2026-10-18; notes/06 §10 "Road system-of-record, CLOSED"). These
       are NOT streets: never consulted by avenueAt/_roadOcc, drawn only
       when Terrain#showProposed is on. Candidates + verdicts live in
       api/streets.php (SQLite) when served over HTTP — the page then
       replaces this list from the server; this built-in list is the
       offline/file:// fallback and MUST mirror the PHP seed. Each entry:
       {id, x0, x1, ylo, yhi} grid coords inclusive + src note. Rationale
       per seed: pitch-24 continuation of the verified 66/90/114 set
       (notes/06 §10), the crosswalk-straddle boulevard at x=126, and the
       118/119 re-measure ("partially correct", 2026-10-17). Promotion of
       an 'ok' verdict to Terrain.AVENUE.streets stays a manual,
       per-street code change. */
    Terrain.PROPOSED = {
        streets: [
            { id: 1, x0: 126, x1: 127, ylo: 146, yhi: 208,
              src: 'PROMOTED to Terrain.AVENUE 2026-10-18 (was crosswalk-straddle candidate)' },
            { id: 2, x0: 118, x1: 119, ylo: 263, yhi: 272,
              src: 're-measure — partially correct 2026-10-17' },
            { id: 3, x0: 138, x1: 139, ylo: 146, yhi: 282, src: 'pitch-24 from 114' },
            { id: 4, x0: 162, x1: 163, ylo: 146, yhi: 282, src: 'pitch-24 from 114' },
            { id: 5, x0: 186, x1: 187, ylo: 146, yhi: 282, src: 'pitch-24 from 114' },
            { id: 6, x0: 210, x1: 211, ylo: 146, yhi: 282, src: 'pitch-24 from 114' },
            { id: 7, x0: 234, x1: 235, ylo: 146, yhi: 282, src: 'pitch-24 from 114' },
            { id: 8, x0: 258, x1: 259, ylo: 146, yhi: 282, src: 'pitch-24 from 114' },
            { id: 9, x0: 282, x1: 283, ylo: 146, yhi: 282, src: 'pitch-24 from 114' },
            { id: 10, x0: 42, x1: 43, ylo: 146, yhi: 282, src: 'fills 30→66 gap' },
            { id: 11, x0: 6, x1: 7, ylo: 146, yhi: 282, src: 'pitch-24 west of 30' },
            /* east arm — the saved E–W avenues + dense road cells run to
               x≈511 with sand/beach to the north-east (notes/06 §10 east
               coast); pitch-24 continuation past 282 plus half-pitch
               samples testing whether the east grid is +12-offset like
               the x 126 case. */
            { id: 12, x0: 306, x1: 307, ylo: 146, yhi: 282, src: 'pitch-24 east to the coast' },
            { id: 13, x0: 330, x1: 331, ylo: 146, yhi: 282, src: 'pitch-24 east to the coast' },
            { id: 14, x0: 354, x1: 355, ylo: 146, yhi: 282, src: 'pitch-24 east to the coast' },
            { id: 15, x0: 378, x1: 379, ylo: 146, yhi: 282, src: 'pitch-24 east to the coast' },
            { id: 16, x0: 402, x1: 403, ylo: 146, yhi: 282, src: 'pitch-24 east to the coast' },
            { id: 17, x0: 426, x1: 427, ylo: 146, yhi: 282, src: 'pitch-24 east to the coast' },
            { id: 18, x0: 450, x1: 451, ylo: 146, yhi: 282, src: 'pitch-24 east to the coast' },
            { id: 19, x0: 474, x1: 475, ylo: 146, yhi: 282, src: 'pitch-24 east to the coast' },
            { id: 20, x0: 498, x1: 499, ylo: 146, yhi: 282, src: 'pitch-24 east to the coast' },
            { id: 21, x0: 318, x1: 319, ylo: 146, yhi: 282, src: 'half-pitch sample — east grid +12-offset?' },
            { id: 22, x0: 390, x1: 391, ylo: 146, yhi: 282, src: 'half-pitch sample — east grid +12-offset?' },
            { id: 23, x0: 462, x1: 463, ylo: 146, yhi: 282, src: 'half-pitch sample — east grid +12-offset?' },
            /* first E–W candidate (horizontal row — the panel/overlay handle
               any grid rect): the true template road beside the police
               station. f5 saves a 170–171 row that slices the station's
               north rows (player edit, also drawn in-game) while the
               station (grid x 135–141, y 168–172) sits with its crossings
               (KLCrosswalk grid y 173–174) on a SOUTH-side road. Extent
               data-derived (2026-10-18): the saved south row's own runs
               end at 143 next to the station (y 175 = 0–47/64–111/128–143),
               so the beside-station stretch is x 124–143, crossroads-to-
               end — NOT the full 100-cell guess the first pass shipped. */
            { id: 24, x0: 124, x1: 143, ylo: 174, yhi: 175,
              src: 'E-W road — police stn south, saved-row twin x 128–143' }
        ],
        verdicts: {}          // id -> 'ok' | 'bad'; absent/other = pending
    };

    global.CityTerrain = Terrain;
    if (typeof module !== 'undefined' && module.exports)
        module.exports = { CityTerrain: Terrain, decodeTiles: decodeTiles,
            decodeCells: decodeCells, CELL_STRIDE: CELL_STRIDE,
            CELL_OX: CELL_OX, CELL_OY: CELL_OY,
            anchoredKeep: anchoredKeep, SEA_RGB: SEA_RGB };

})(typeof window !== 'undefined' ? window : globalThis);
