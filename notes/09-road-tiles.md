# 09 — Road tiles: the sheet, its lattice, and how we draw it (2026-10-25, updated 2026-10-27)

Everything learned about the **road tile art itself** — the PNG sheet, where it
comes from, how the art is laid out inside it, what each of the 11 cells
actually contains, and the draw recipe the Pixi viewer uses.

This is the **art side** of the story. The **engine side** (which cell a road
cell selects, and why) is `notes/08-road-drawer-re.md`; read that for the
selector decision tree, the family/leaf table and the binary addresses. Where
this note repeats an engine fact it is only so the art facts make sense —
`notes/08` wins on engine behaviour, this note wins on the sheet.

Evidence images: `mapdump/registration/m4-road-lattice-census.png` (every
lattice box, labelled used/unused), `m4-re-sheet-states.png` (the 11 UV
diamonds on the sheet), `m4-re-states-triples.png` (per state: raw box |
diamond clip | composed), `m4-pixi-town-compare.png` (broken vs reference vs
fixed spec mode on a street grid). Current draw (§6, 2026-10-27):
`m4-terrain-crisp-{before,after}.png`, `m4-riv-seam-{before,after}.png`;
current bridges (§10): `m4-bridge-cell-*.png`, `m4-bridge-grass-*.png`;
current dirt art (§11): `m4-dirt-sheet-slots.png`, `m4-dirt-sheet-full.png`.

## 1. Asset provenance

| | |
|---|---|
| Active file | `web/assets/dlc/roadrivertiles-100/images/roadtilesheet.png` (1024², since 2026-10-27 — see §6). The UV tables stay in 512-space px; u,v = px / 512 for every tier |
| Format | 512×512 **RGBA**, but every alpha byte is 255 (measured `alpha unique [255]`) — the sheet is **fully opaque** |
| Pack | DLC `roadrivertiles`, tiers `-25` (256²), `-50` (512²), `-100` (1024²); ~9 revision copies of each tier exist in `web/assets/dlc/` |
| Same pack also ships | `grasstile.png`, `grasstile_dark.png`, `grassedgeandshadows.png` (the ground/grass art the viewer loads alongside the sheet) |
| Winter variant | `web/assets/dlc/XMAS2017_RiverRoadTiles_LTD-100-r492453/images/iceroadtilesheet.png` (1024²; the `-50` copy is 512², also fully opaque; `XMAS2018_RiverRoadTiles_LTD-*` is the later pair). Same lattice and same 11 cells — it is a recolour, so the UV table is reused |
| Loader | `city-view-pixi.js` `buildSheetCanvas` neighbourhood loads the `-100` road and ice sheets; `SEASON.mode === 'winter'` swaps them for roads (rivers always sample the base sheet) |

**Consequence of full opacity:** every transparent pixel the viewer ever showed
around a road tile was **self-inflicted** by its own clip (`buildSheetCanvas`'
diamond clip in the legacy path). Nothing in the source art is transparent, so
the engine-correct draw — which never samples outside the UV parallelogram —
needs no alpha, no clip, and no blending. Flat colours (`ROAD_ART`
0.75/2.5/0.75, `notes/06` §10) stay the user-approved fallback for when the
sheet image is unavailable.

## 2. The lattice

Measured (contact-sheet pass, re-verified 2026-10-25): the sheet is a 2:1
diamond plane tiling. Cell `(c, r)`:

    centre x = 274 + 135*c + (r odd ? 67.5 : 0)
    centre y = 140 + 37*r
    box      = centre ± (63.5, 33)          → 127 × 66

* Horizontal pitch **135** px = one diamond width; vertical pitch between rows
  of *the same column* is **74** px (two steps of 37, each step also shifting
  x by 67.5). Consecutive rows interleave like a brick/offset lattice.
* Row pitch **37 < box height 66**, so lattice **boxes overlap** between
  adjacent rows (x overlap 59.5, y overlap 29). Only the inscribed **diamonds**
  tile cleanly. This is why any "crop the box and draw it" mode (legacy sheet
  modes 1–3) picks up a neighbour's art at its edges, and why the correct draw
  must sample *only* the parallelogram.
* The fitted formula above is a fit, not the truth: the engine's actual quad
  centres sit **dx −0.25 … −2.80 px, dy −0.03 … +1.78 px** off it (per-state
  table in `notes/08` §2; numeric dump in
  `mapdump/registration/m4-road-tile-facts.txt`).
  Sub-pixel in world scale, but it is why hand-tuned offsets never matched.
* Measured half-extents over the 11 used cells: `hx ≈ 63.11–63.45`,
  `hy ≈ 32.71–33.13` — i.e. the diamonds are ~127×66 as fitted.
* The 8 px of sheet between neighbouring diamonds is **not** filler/gutter: it
  is covered by other cells' art (measured colourful, sd ≈ 50–80). Do not treat
  it as padding.

## 3. The 11 states — slot, content, meaning

Slot `(c, r)` = the lattice box the engine's UV quad lives in (UV table,
`libscorpio.so` `.rodata 0x400520`, floats × 512 = sheet px). Content split is
measured inside the diamond: `paving` = luminance ≥ 170 (sidewalk/kerb tone),
`mid` = 120–170 (lit asphalt), `asphalt` = < 120 (dark asphalt/shadow). Full
numeric dump (per-state UV corners, centre deviation from the lattice fit,
unused-box classification, content split):
`mapdump/registration/m4-road-tile-facts.txt`.

Quadrant/art column is `notes/08` §2 (authoritative — kerb/sidewalk art always
lands on the **closed** edges); the three percentage columns are the new
measurement, so a regression can be caught numerically as well as by eye.

| st | slot | paving | mid | asphalt | quadrant | art (kerb lands on the closed edges) |
|---|---|---|---|---|---|---|
| 0 | (−1,7) | 99.6% | 0.2% | 0.2% | any | full paving slab — interior fast path (mean 187,187,187) |
| 1 | (−1,5) | 55.3% | 37.2% | 7.4% | NW / ES† | neither open — kerb corner W+N (ES mirrored → E+S) |
| 2 | (−1,6) | 13.2% | 84.1% | 2.7% | NW / ES† | both open — plain paving, small kerb at outer corner |
| 3 | (−2,5) | 32.6% | 63.3% | 4.1% | NW / ES† | first edge only — kerb band along W (ES mirrored → S) |
| 4 | (−1,4) | 36.8% | 57.0% | 6.2% | NW / ES† | second edge only — kerb band along N (ES mirrored → E) |
| 5 | (−1,1) | 57.7% | 32.3% | 10.0% | NE | neither open — kerb corner N+E |
| 6 | (−2,1) | 16.2% | 79.6% | 4.1% | NE | both open — paving, small kerb at outer corner |
| 7 | (−1,−1) | 34.8% | 58.2% | 7.0% | NE | one open — kerb N (E-only); N-only mirrored → kerb E |
| 8 | (−1,3) | 52.3% | 41.0% | 6.6% | WS | neither open — kerb corner W+S |
| 9 | (−2,3) | 11.9% | 84.8% | 3.3% | WS | both open — paving, small kerb at outer corner |
| 10 | (−1,2) | 31.7% | 63.3% | 5.0% | WS | one open — kerb W (S-only); W-only mirrored → kerb S |

† ES reuses the NW family's leaves with the selector flip byte forced to 1.

The paving fraction tracks how many edges are closed, which is the sheet's whole
design: **none open** (1, 5, 8) ≈ 55 % paving / 37 % mid / 7 % asphalt (two kerb
bands meeting at a corner), **one open** (3, 4, 7, 10) ≈ 32–37 / 57–63 / 4–7
(one kerb band), **both open** (2, 6, 9) ≈ 12–16 / 80–85 / 3–4 (nearly all lit
asphalt, just the outer kerb corner), and state 0 is a featureless slab. Two
uses for these numbers: a bake/UV bug usually shifts a state's split well
outside these bands, and the per-side kerb position (measured separately: 3→W,
4→N, 1→W+N, 5→N+E, 8→W+S, 7→N, 10→W) is the fastest way to spot a wrong corner
assignment or a mirror-instead-of-flip.

## 4. The UV table: how exact the parallelogram really is

Each UV quad's four points satisfy `T + B == R + L` (`notes/08` §2) — to
**≤ 0.5 px**, not bit-exact (measured 2026-10-25: max deviation 0.49 px at
state 9, median 0.26 px), consistent with float32 storage plus the artist
aligning art by eye. Treat the parallelogram property as *true to ~0.5 px*:
it is what made the old slot bake (inverse parallelogram map) possible, and it
is not accurate enough to justify deriving one corner from the other three.
Always use all four floats from the table — the UV meshes of §6 do exactly
that (each quad is two triangles, so a 0.5 px non-parallelogram is harmless).

## 5. Unused art in the sheet, and the river lead

Of the lattice, **36 boxes fall fully inside the 512² canvas**; the road engine
samples only **11** of them. The other **25** break down as 13 painted
water/grass cells, 6 near-black structured cells, and 6 solid-black packing
filler (see `m4-road-lattice-census.png`):

* **13 water/grass cells** at `c ∈ {−2, −1, 0}`: (−1,−2), (0,−2), (−2,−1),
  (−1,0), (0,0), (0,2), (0,4), (0,6), (−2,7), (−1,8), (0,8), (−2,9), (−1,9).
  These have 46–72 % water-toned pixels (blue > red by 25, blue > 110) and are
  the obvious river/bank tiles.
* **12 grey/paving cells**: the six that fit in the `c = 1` column —
  (1,−2), (1,0), (1,2), (1,4), (1,6), (1,8) — are **solid black** (mean 0,0,0,
  sd 0) = packing filler, never sampled; the six `c = 0` odd-row cells
  (0,−1), (0,1), (0,3), (0,5), (0,7), (0,9) are near-black with real structure
  (mean ≈ 20,35,41, sd ≈ 68) — unknown purpose, definitely not road art.

**Lead, resolved 2026-10-26 (see §9):** `libscorpio.so` carries RTTI strings
`10RoadDrawer` (0x4006a0) and `RiverDrawer` (0x3fc311). `RiverDrawer` is indeed
the owner of the water cells — its UV table is now decoded (§9) and lands
exactly on 11 of these 13 cells, which explains both the extra art and the
pack name (`roadrivertiles`).

## 6. How the viewer draws them — full-res sheet, UV meshes (2026-10-27)

Only `sheetArtMode === 4` (`Road art·spec`) and the river cells (`Water art`,
on by default) use the engine-correct path in `web/viewer/city-view-pixi.js`.
`#btn-sheetart` cycles 0 off → 1 uniform sheet → 2 neighbour → 3 avenues →
4 spec (`localStorage` `mrsnrub.cityview.sheetart`); modes 1–3 and the
avenues are the legacy `terrain.js` path (`_sheetTile` / `SHEET_TABLE`, the
positive-sy fakes) and still draw from a 512² cleaned canvas, now built by
drawing the hi-res sheet scaled down, so their 512-space lattice maths is
unchanged.

User report: road and river tiles were visibly blurry next to every other
asset, and river tiles showed a thin blue line along tile joins. Two stacked
causes, both measured on headless-Chrome captures of the live viewer:

* **Wrong tier, 2× upscale.** Buildings come from the `-100` packs at
  `ART.S = 64` art px per tile unit, i.e. a resting tile is 128×64 screen px
  (`CAM.PX_PER_UNIT = 64`). A road/river quadrant spans 2×2 tiles = 256×128 px
  but sampled a 127×66 diamond of the 512² `-50` sheet. The `-100` sheet
  (1024²) ships with the **identical layout at exactly 2×** (downscaled to 512
  it differs from `-50` by 0.6/255 mean), so the same tables address it.
* **Double resampling.** `bakeSlot` warped each diamond into a 127×66
  axis-aligned canvas (a 45° shear + bilinear) and the tile-space sprite was
  warped back to a diamond by the ground matrix (a second bilinear pass).

Now each quadrant is a 4-vertex `PIXI.Mesh` (`quadMesh` / `quadGeom` in
`city-view-pixi.js`) over the unit square in tile space, scaled to the
half-cell, whose UVs are the table's own four corners / 512 — exactly the
engine's draw: one resample, sheet diamond → screen diamond at ≈1:1 at rest
zoom. Corner assignment (square → sheet point): unflipped TL→L TR→B BR→R
BL→T; flipped (the anti-diagonal reflection, see the history note below) TL→R TR→B BR→L BL→T. The 22
road and 22 river geometries are shared across all cells. Roads now use the
engine's real per-state UV table (`ROAD_QUADS`, `.rodata 0x400520`, the values
in `m4-road-tile-facts.txt`) instead of the fitted lattice the old bake used.

**The thin blue line was the flat fills, not the art.** Every cell also gets
a flat type-colour fill (`big + BLEED`, BLEED = 0.012 tile, anti-seam between
flat fills). They lived in `featC` interleaved cell by cell with the art quads,
so each later cell's fill overhang painted a 1–2 px strip of river blue (or
road grey `[92,92,98]`) over the previous cell's finished art along their
shared edge. The fills now live in their own `fillC` layer under every art
quad, and cells whose art draws get an exact (no-BLEED) fill so nothing pokes
out past the art over the base grass. No UV inset was needed: with one
resample the sheet's dark lattice outlines do not show at the joins.

Evidence: `mapdump/registration/m4-terrain-crisp-{before,after}.png` (site A
at zoom 1.0) and `m4-riv-seam-{before,after}.png` (river reach at zoom 1.5).

### Superseded: the slot-bake recipe (2026-10-25 → 2026-10-27)

The first engine-true draw baked each state's UV parallelogram into a small
axis-aligned canvas (`bakeSlot`, `buildSpecSlots` / `buildRivSlots`,
127×66 + 2 px pad, two orientations per state) and drew it as an unrotated
sprite scaled to the half-cell. It fixed the earlier rotated-box overdraw
(`notes/08` §6, CHANGELOG `2026-10-25.33`: rotating the 127×66 box by 45°
draws a diamond ~1.75–2.0× the quadrant) and it is where the anti-diagonal
flip parameterisation (unflipped `O=L, E=B−L, S=T−L`; flipped `O=R,
E=−(T−L), S=−(B−L)`, not a horizontal mirror) was established — the mesh
corner assignment above is the same map. It was replaced because it sampled
the 512² tier (2× upscale) and resampled twice, which is the blur the user
reported, and because it used the fitted lattice instead of the per-state
`0x400520` floats.

The census image and facts dump in §2–§3 were produced by one-off PIL scripts
kept outside the repo (`/tmp/opencode/note09-*`); re-measuring only needs the
lattice formula plus `SHEET_STATES` from `terrain.js`.

## 7. Superseded guesses (do not re-learn these the hard way)

The legacy comment block in `web/js/terrain.js` (~L250–330) still contains
pre-RE reasoning kept for the legacy modes. These claims are **wrong**:

* *"the engine alternates variant pairs (e.g. 3 vs 10) on coordinate parity"* —
  there is no parity alternation. Cell choice is purely the neighbour-mask
  selector (`notes/08` §3): mask bits N/E/W/S → family → leaf.
* *dead ends / diagonals "fall back to state 0"* — the engine has no such
  default. State 0 comes only from the special flag / interior fast path
  (`notes/08` §2–§3); every other nibble resolves through the family table.
* *"right-edge variants the sheet only ships mirrored"* — the sheet ships no
  mirrored duplicates; what looks like a mirror is the selector's flip byte
  (an anti-diagonal re-assignment, §6).
* Anything describing the sheet as "~135×74 diamonds" as the *cell* size:
  135×74 is the **pitch**; the art cell is 127×66 (§2).

## 8. Verification tooling

* `web/viewer/road-lab.{html,js}` + `tools/smoke-road-lab.cjs` (107 checks) —
  the canvas inspector; its engine model is the **source of truth**, keep the
  two in sync. Raw boxes + parallelograms, live 4-quad cell, mask toggles,
  neighbour probe, force-state, flip, `ROAD_ENGINE` reference block. The
  **water / river** tab (§9) mirrors every one of those controls with its own
  state (`WATER`) so the two families can be compared side by side, and adds
  the wave-overlay atlas section.
* `tools/gen-water-evidence.py` — offline PIL regeneration of all `m4-riv-*`
  evidence in `mapdump/registration/` (lattice, per-state bakes, engine-model
  cells, wave atlas, facts dump); re-reads the binary table when present and
  reports the max deviation against the hardcoded quads.
* `/tmp/opencode/re_pixi_shear.py` — bilinear PIL replica: compares bake models
  and measures painted area (the check that killed the rotated-box model:
  ratio 1.000 vs 1.75).
* `/tmp/opencode/re_pixi_sim.py` — coverage audit: every nibble 0–15 plus `P`
  at t = 2…26 px/tile, asserts 0 uncovered / 0 partial pixels.
* No harness exists for `city-view-pixi.js` itself: use `node --check`, the
  road-lab harness, and the offline PIL replicas. For pixel-level visual
  checks a headless Chrome capture works (2026-10-27: `google-chrome
  --headless=new --use-angle=swiftshader` driven over the DevTools protocol,
  steering `window.__CV_cam` and clicking `btn-sheetart` to `Road art·spec`);
  that is how §6 and the §10 per-cell bridge rule were measured.
* PIL gotcha that wastes hours: `Image.transform(AFFINE)` takes the
  **output→input** map in **tile-local** coordinates (no `x0/y0` in the
  constants), whereas the browser's `setTransform` wants the **inverse**. A
  wrong corner assignment shows up as half-empty quads — the "triangular hole"
  signature — which is a replica bug, not an engine finding.

## 9. The river slots — RiverDrawer (2026-10-26)

The 13 water cells of §5 are `RiverDrawer`'s. RTTI puts it at
`11RiverDrawer` (0x3fc30f) **: `RoadDrawer` : `RoadMapDrawer`**, vptr
`0x1a2bf30`, ctor `0x1099264`. The class factory `0x10d67b4` dispatches on
`map+0x5c`: 0 → RoadDrawer, 1 → RiverDrawer, 2 → **BoardwalkDrawer** (vptr
`0x1a191f8`, ctor `0xf2bc18`, unresearched). There are no Wave/Sea/Ocean
drawer classes at all — sea is base terrain, waves are a sprite (§ below).

**It shares RoadDrawer's draw body verbatim.** The build wrapper `0x1099f20`
loads its own selector `0x1099f8c` into x1 then `bl 0x1208c10` — the same body
the road selector `0x1208058` falls through to at `0x1208c04`. So everything
`notes/08` measured (one 4×4 cell = 4 quadrant quads, each sampling **one full**
UV parallelogram, corner map T→BL R→BR L→TL B→TR, ES quadrant forces the
mirror byte) carries over unchanged, including the nibble bits E=1 W=2 N=4 S=8
and the pass rule (helper `0x1134fa8`).

**The UV table is `0x3fc320`** — 11 entries × 0x20, four (u,v) corners in
T,R,L,B order, ×512 = `roadtilesheet.png` px (same sheet as roads; all 11
entries are referenced from the selector, 18 adrp+add sites). They land on 11
of §5's 13 water cells; (−2,−1) and (0,0) are unreferenced. Parallelogram
deviation 0.04–0.49 px, same tolerance as §4. Measured through the engine's own
UV map (blue-dominant classification, 25 % edge bands, `m4-riv-facts.txt`):

| state | slot (c,r) | water | banked | content |
|---|---|---|---|---|
| 0 | (0,−2) | 39 % | N+W | shore corner — roads' state 1 role |
| 1 | (−1,9) | 100 % | — | open-water slab — roads' state 0 role |
| 2 | (0,6) | 95 % | — | plain water interior |
| 3 | (0,4) | 78 % | W | bank along W (N-open case) |
| 4 | (0,2) | 62 % | N | bank along N (W-open case) |
| 5 | (0,8) | 29 % | N+E | NE shore corner |
| 6 | (−1,0) | 87 % | — | NE plain water |
| 7 | (−1,−2) | 60 % | N | NE one-bank (mirrored to bank E as needed) |
| 8 | (−2,7) | 53 % | W+S | WS shore corner |
| 9 | (−2,9) | 97 % | — | WS plain water |
| 10 | (−1,8) | 81 % | W | WS one-bank (mirrored to bank S as needed) |

**The family table is the road table with entries 0↔1 exchanged**; 2..10 keep
their road roles — for every world where no neighbour is solid, which is this
save. Verified three independent ways now: the selector's reference-order scan
(road `[5,1,8,1,7,7,10,10,4,3,3,4,0,2,6,9,11]` vs river
`[5,0,8,0,7,4,4,7,10,10,4,3,3,4,6,9,2,1]` — identical after the swap minus the
road identity fallback), pixel-measured bank placement (state 3 banks W,
state 4 banks N, matching the road csel order), and **exhaustive emulation**
(§9 verdict A: 64/64 quadrant × nibble). Two roads-only routes are absent: the
special-flag helper `0x1134cfc` is **never called**, so the "flag → full slab"
path does not exist — which is exactly why 0 and 1 trade roles: the slab has to
come from somewhere else. That "somewhere else" is now known: state 1 is reached
**only** through the diagonal-solidity rule (§9 verdict B), never from the
nibble itself. And the selector cannot return NULL after all — no path in the
explored tree leaves `x26` unset. The bank always sits on the **closed** edge,
mirroring the road kerb exactly.

**Wave overlay = a separate asset, not the tileset.** The drawer holds a
BGSprite at `[drawer+0x80]` under a BGSceneSpriteNode; the asset is
**WaterAnims** (`wateranimations.png` + `.bsv3`, a 0x0103 scene: 43 cells, 282
frames, anims `Barrel 0..209` / `Fish 210..281`; the shimmer marks are the
thin `C_Water_01..10` / `C_Ripple_06..10` cells). A 3.0 s timer
(`[drawer+0x88]`) re-picks via `rand()` ~50/50 between two frames (table
`0x143abe8`).

**Flip byte — verified on the water art (2026-10-26):** it is the road
emitter's **anti-diagonal reflection**, world `(u,v)` sampling `M(1−v, 1−u)`
(the flipped bake `O=R, E=−(T−L), S=−(B−L)` of the old bake, the same map the meshes use, §6), *not* a horizontal
mirror. Re-measured on the river art itself: flipped state 0 banks E+S, state
7 banks E, state 10 banks S — a u-mirror leaves the opposite edge open water.
(A u-mirror CTM in the lab was also what painted black triangles into flipped
quadrants: it no longer mapped the world square onto the UV parallelogram.)

**Unproven (flagged as such in the lab, not ported as contract):** the
`[drawer+0x8e]` writer, the GPU meaning of the mat4 Y-column patch, the blend
mode, and **which two** WaterAnims cells the 3 s pair are.

Review surface: the **water / river tab** of `web/viewer/road-lab.html` (own
`WATER` control state, affine-exact blits via `blitQuad`, `WATER_ENGINE`
reference block) and the `m4-riv-*` renders from
`tools/gen-water-evidence.py`. The Pixi viewer now ports the same model behind
the **Water art** toolbar toggle (`mrsnrub.cityview.waterart`, ON by default):
`RIVER_QUADS`/`RIV_FAM`/`rivStates`/`rivFlip` + the shared `quadMesh` (the 11
states drawn as UV meshes, §6, always from the base sheet — the
ice re-ship's river UVs are unresearched, so winter keeps base river art) and
`buildRivCell`, which mirrors `buildSpecCell`'s four-quadrant pass. Solid 'P'
river cells take the open-water slab (state 1). Legacy `m = -2` tiles and
`big !== 4` cells keep the flat fill, as does any cell whose bakes are missing.
The ocean base stays a flat fill (no sea drawer exists) and the 3 s WaterAnims
shimmer is still unported.

### Pack bleed in the three all-open water tiles — engine-faithful, NOT a port bug

User report: a speck of land at the centre of four water tiles inside a large
pond. The cause is in the **shipped sheet**, not in the decode. The both-pass
states — 2 (nw/es), 6 (ne), 9 (ws) — are the tiles an open pond is paved with,
and each keeps a piece of the *neighbouring* lattice cell's art inside the
corner of the UV quad (measured at the 2026-10-26 viewer's 127×66 bake size by
`tools/river_bleed_check.py`, which parses `RIVER_QUADS` back out of the viewer
and cross-reads the engine's table, deviation 0.005 px):

| state | cell | bleed pieces (u,v in the world square) | colour |
|-------|------|------------------------------------------|--------|
| 2 | (0,6) | px477 u0.00–0.21 v0.00–0.35 | grass + kerb |
| 6 | (-1,0) | px946 u0.63–1.00 v0.00–0.35, **plus satellites** px69 u0.60–0.69 v0.35–0.47 and px27 u0.76–0.82 v0.35–0.42 (split off by a hairline of water) | dirt + kerb |
| 9 | (-2,9) | px284 u0.00–0.20 v0.80–1.00 | grass |

The banked states (0, 3–5, 7, 8, 10) are 30–80% water — that land *is* the art,
so any cleanup has to be gated on the tile being open water first. An all-open
6×6 pond block (the reported case) replicates **3.19% land pixels** at the
interior lattice corners: `mapdump/registration/m4-rivbleed-replica.png`
(`tools/river_bleed_check.py`; `--preview-scrub` also renders the reverted
attempt below).

**Attempt 1 — in-bake pixel scrub (REVERTED, 2026-10-26).** `scrubRivBake()`
ran on each bake after `bakeSlot`: tiles ≥85% water only, land grouped across
hairlines of water, corner-hugging corner-sized pieces repainted with the
median of that tile's own water pixels. Numerically it did what it said (only
2/6/9 lost pixels, no blue pixel was painted over, the replica went to 0.00%
land) and it is still on disk as the `--preview-scrub` path of
`tools/river_bleed_check.py`. It was **reverted because it left its own visible
mark in the viewer**: a flat median-blue patch reads differently from the
textured water around it, so the erased region showed as a smudge where the
land had been. Lesson: don't fight art with invented pixels.

**Attempt 2 — the diagonal-guarded slab (SHIPPED, 2026-10-26):** no pixels are
invented at all, the quadrant just samples a different slot. See the next
subsection.

### Why the engine doesn't hide it — RE verdict (2026-10-26)

The five candidate explanations (a) emitter overlap, (b) draw order, (c) drawer
corner clip / alpha, (d) a different state for open interiors, (e) levels never
sampling these cells, were all settled by disassembling + **emulating** the river
selector. Conclusion up front: **the shipped game draws exactly what we draw**,
speck included. `m4-rivbleed-replica.png` is not a porting artifact — it is
what `RiverDrawer` emits for a pond interior. Anything that removes it is a
viewer deviation, not a bug fix.

Method (same shape as the road-selector work in `notes/08` §3): rizin listing of
the selector, then the ARM64 interpreter from that work runs the real 721
instructions with the world as a set of booleans, and a concolic walker replays
every run once per unanswered question — a complete decision tree, no guessing.

| piece | address / file |
|-------|----------------|
| river selector | `0x1099f8c` — `(this, packedX, packedY, out)`, `cx=w1>>2`, `xsub=w1&3`; returns the quad pointer (`0x3fc320 + 0x20·state`) in x0 |
| probe helper | `0x1208910(o,x,y)` = `o->vt+0x30 contains(x,y)` **&&** `solid(o->vt+0x18 record(x,y))`, NULL object ⇒ 0 |
| chunk contains | `0x118d908(m,x,y)` / `0x118d898(m,ptr)` = the `x>>4, y>>4` slot at `[m+0x108]` (`stride = [m+0xd8][0]`) is non-null — coarse "chunk loaded" |
| record-by-point | `0x118c6e4(o,ptr)` = tail-call `o->vt+0x18([ptr], [ptr+4])` |
| accessors | `0x1134fa8` = `p[4] & 0xf` (nibble), `0x1134cf0` = `p[4] >> 4 & 1` (solid) |
| working material | `/tmp/opencode/re/riv_emul.py` (model + stubs), `/tmp/opencode/re/riv_tree.py` (tree walker) → `/tmp/opencode/rivtree.json`; interpreter `/tmp/opencode/re/emul.py` |

**A. Our state table is the engine's, exactly.** With no solid cells anywhere —
which is this save (`m` = 1…15 on every river cell, no `P`) — the emulator
reproduces `RIV_FAM` for all 4 quadrants × 16 nibbles, **64/64**, and the
selector never returns NULL for a valid sub-coord.

**B. Two real rules are missing from `RIV_FAM`, both keyed on the DIAGONAL
neighbour** (found by flipping solidity per direction; they are inert while no
river cell is solid, so nothing to ship today, but this is what a fuller port
needs):

* both edges **and** the diagonal solid ⇒ **state 1** for *every* nibble
  (nw `N+W+NW`, ne `N+E+NE`, ws `W+S+SW`, es `E+S+SE`; chunk-present required,
  no candidate needed). So the pure slab means *"this quadrant is buried in
  solid cells"*, **not** *"open water"* — hypothesis (d) is dead, an open pond
  quadrant really does get 2/6/9.
* ne only: diagonal solid on its own (chunk + `NE`) ⇒ **state 4** instead of
  our 5/7 — a corner piece for the N/E kerb pair.

Also: the **centre** cell's solid bit never reaches the selector (`('mgr','C')`
changes no leaf), so a "solid cell ⇒ state 1" convention is not engine-derived.

**C. The emitter tiles exactly — no overlap to hide anything** (`0x12095e8`,
the same emitter the river drawer shares with roads):

```
centre   cx = S·arg2 − (col+0.5)·16S        cz = S·arg3 − (row+0.5)·16S
quad off +2S in x for w3 ∈ {1,3};  +2S in z for w3 ∈ {2,3}      (w3 = 0..3)
corners  x ∈ {cx − ε, cx + 2S},  z ∈ {cz − ε, cz + 2S},  y = 0 for all four
ε        = *(0x1ac0260) · 0.125            (S = *(0x1abc0ac8))
```

Both globals are **pointers to runtime floats** — all 11 `.text` sites are reads,
so their value comes from loaded data, not code. Either way ε is a seam epsilon,
not a cover: our exact tiling already renders roads correctly, and an ε big
enough to bury a 27-px nub would double-draw every kerb at the cell centre. All
four vertices are coplanar (`y = 0`) in the 20-byte `(x, y, z, u, v)` format —
**no vertex colour/alpha field at all**, so (a) and (b) are both false: nothing
repaints a neighbour's corner.

**D. The art is opaque, and the one later water layer is not a cover.**
`roadtilesheet.png` is RGBA but **α = 255 on every one of its 262 144 pixels**
(measured), so a translucent-water theory is dead. The only pass that lands on
top of river water is WaterAnims (`web/assets/dlc/game-50/images/
wateranimations.png`, 256×128: **75.4% of pixels α < 8**, mean α 48.9) — a sparse
shimmer, which can mask a corner by luck, never systematically.

So the speck ships in the game itself. What is still open in this area:
the `dirtriver`/`iceriver` drawer variants, the mat4 Y-column patch flagged in
§6, the blend mode, and which two WaterAnims cells the 3 s pair uses
(`0x143abe8`).

### The shipped remedy — the diagonal-guarded slab (2026-10-26)

Verdict A means the speck cannot be fixed by correcting our table, and verdict
B says the bleed pixels **are** the diagonal neighbour's bank art — real content
when that neighbour exists, pure bleed when it does not. So the viewer removes it
where it carries no information, using only shipped art (`rivStates` /
`rivDiagOpen` in `web/viewer/city-view-pixi.js`):

> an all-open quadrant (both edges it tests are open) samples **state 1** — the
> engine's own slab — when its DIAGONAL neighbour is a river cell that is not
> solid and connects back toward us on *both* of its faces (`E1 W2 N4 S8`);
> otherwise the engine's 2/6/9 stays untouched.

That mirrors the engine's own slab rule (verdict B) with solidity inverted, which
is the whole point: the corner is drawn exactly when the cell that owns it is
land. The four guards are set in `buildRivCell` next to the edge-neighbour probe
(`nw` asks `(tx−4, ty−4)` for faces E+S, `ne` `(tx+4, ty−4)` for W+S, `ws`
`(tx−4, ty+4)` for E+N, `es` `(tx+4, ty+4)` for W+N; y grows south). Banked
quadrants, the `m < 0` 'P' slab path, Road Lab, and every other state are
untouched — this only changes what an open-water quadrant samples.

Measured effect on the reported case (`tools/river_bleed_check.py`, the same
6×6 all-open pond, interior = the 16 fully surrounded cells):

| render | land px | water tint sd |
|--------|---------|---------------|
| `m4-rivbleed-replica.png` (engine 2/6/9) | 1600 / 50 176 (3.19 %) | 9.7 / 16.3 / 32.0 |
| `m4-rivpond-slab.png` (guarded slab) | **0** | 0.0 / 0.0 / 0.0 |
| `m4-rivpond-guard.png` (one solid cell inside the pond) | corner art stays on the four quadrants facing it | — |

**The one thing to know before calling this better than the engine:** state 1 is
a *flat* fill — 3 unique colours in the whole bake, water sd 0.0 — while 2/6/9
carry real texture (water sd 2.4 / 4.0 / 4.5, 287–953 unique colours). So a
large pond becomes a genuinely uniform blue, and the only texture left is the
shoreline ring. That is what the engine itself paints when a quadrant is buried
in solid cells, and it is what `WaterAnims` (not ported) exists to liven up; if
the flat look reads worse than the speck, the change is one `d ? 1 :` in
`rivStates` per quadrant. `btn-waterart` off still gives the old flat
`terrain.js` fill, but there is **no** viewer toggle for the engine-true
interior any more — Road Lab keeps showing the raw engine slots, and
`m4-rivbleed-replica.png` is the picture of it.

Harness: `tools/verify-riv-slab.cjs` (4220 checks) extracts `RIV_FAM`,
`rivStates`, `rivFlip`, `rivDiagOpen` **and `buildRivCell`'s own probe block**
out of the shipped file, so the diagonal wiring — which cell, which faces — is
what gets tested, not a copy of it. It covers `rivDiagOpen` semantics, each
quadrant against the other three diagonals (a diagonal can only open its own
quadrant), an exhaustive 16 nibbles × 16 diagonal masks × solid-centre sweep
(banked picks must stay engine-true), the 4×4 all-open block, and the guard
cases. Its `--picks=K` mode prints the shipped picks as JSON, which
`tools/river_bleed_check.py` consumes for the two new evidence renders — the
replica can never drift from the implementation.

## 10. Bridges over water — the art, the grammar, and where they belong (2026-10-26)

The full game turns a road tile into a bridge where the road crosses the river.
Nothing in the save says so (see "the data" below), so the viewer has to derive
it the way the engine does. This section is the survey: what art ships, how the
engine names the pieces, and which cells in our map are candidates.

### The art that ships (road bridges)

`web/assets/dlc/game-50/images/bridgetop.png` (280×302 RGBA, α mean 116.6,
43.5 % opaque / 52.4 % transparent) and `bridgebottom.png` (150×224, mean 82.2,
30.1 % / 65.9 %), with `_transimage` variants (100×102, 112×96). Copies live in
`game-25/50/100`, `Easter2014_Takedown_Game-*` and `tutorialgame-*` (tier-100
bridgetop 856×486, bridgebottom 298×446). `data/bridgetop.xml` is
`<Building x="2" z="4" height="2.5" locX="2" locY="1" transImageX="-110.4745"
transImageY="-39.6255"/>`, and the 0x0103 cells are (name, x, y, w, h):

| sheet | cell | rect | reads as |
|---|---|---|---|
| bridgetop | `C_BridgeTop_09` | 1, 165, 147, 135 | 3 lampposts, deck line, **20 px of pier** |
| bridgetop | `C_BridgeTop_08` | 1, 1, 147, 162 | the same section, **75 px of pier** with arch openings |
| bridgetop | `C_BridgeTop_06` | 150, 137, 129, 106 | 2 lampposts, deck line, short pier |
| bridgetop | `C_BridgeTop_05` | 150, 1, 129, 134 | the same, long pier with arches |
| bridgetop | `C_Grass_04` | 150, 245, 64, 49 | rock + grass abutment tuft |
| bridgetop | `C_Grass_03` | 216, 245, 58, 34 | flat grass tuft |
| bridgebottom | `C_BridgeBottom_03` | 1, 127, 127, 96 | balustrade wall, square openings, **2 lampposts, nothing below its origin** |
| bridgebottom | `C_BridgeBottom_02` | 1, 1, 147, 124 | the same wall, **3 lampposts** |

Read the two sheets together and the family is **one deck section in two
lengths (3- and 2-lamppost) × two pier heights (in-water 75 px, abutment
20 px)**, plus a **balustrade wall that carries the lampposts and stops dead at
its own origin**, plus grass abutment tufts. `bridgebottom` is *not* a flat deck
under the `bridgetop` — the bsv3 blocks put its cells entirely above y = origin,
so what shows above the road art is the wall and what shows below it is the
`bridgetop`'s piers. Both halves of a pair draw on ONE origin. Evidence:
`m4-bridge-art.png` (every cell on a checkerboard), `m4-bridge-art-sheet.png`
(whole sheets), `m4-bridge-cells.png` / `m4-bridge-compose.png` (the frames
each bsv3 file composes, with the lamppost globes marked).

The frames, straight out of the bsv3 block lists (`gen_city_sprites.BRIDGE_FRAMES`):

| frame | bridgetop | reads as |
|---|---|---|
| f0 | `T05` | 2-lamppost section, piers in water |
| f1 | `G03 + T06` | short-pier section + flat grass tuft |
| f2 | `G04 + T08` | long-pier section + rock/grass abutment |
| f3 | `G04 + G03 + T09` | short-pier section + both tufts |
| f4 | `T08` | **long-pier section, no abutment — the in-water piece** |
| f5 | `T09` | **short-pier section — the abutment-length piece** |
| f6 | `G03 + T09` | short pier + tuft |
| f7 | `T06` | short-pier 2-lamppost section |
| bridgebottom f0 | `B02` | 3-post balustrade wall |
| bridgebottom f1 | `B03` | 2-post balustrade wall |

**Where the two grass cells sit inside a frame** (from the same block list; art
px, ÷ 64 = tiles, negative = behind the instance origin):

| cell | block offset | cell | occupies along the deck | side |
|---|---|---|---|---|
| `C_Grass_04` | −366.95, −127.0 | 129×98 | 3.71 … 5.73 behind | far (−y) edge, past the deck's tail end |
| `C_Grass_03` | −115.25, −8.25 | 117×67 | 0.03 … 1.80 behind | near (+y) edge, at the head end |

So the two tufts mark the deck's two ENDS: the bank at the tail, the fillet at
the head, both drawn UNDER the deck cell that the frame also carries. And the
four long-piece frames are exactly the four combinations of those two ends —
which is the same fact the binary states, since the `bridge…[g]` formatters are
gated by the tile's SOLID bit (see the grammar below):

| deck-cell end states | tail on land | head on land | frame |
|---|---|---|---|
| neither | ✗ | ✗ | `f4` (deep piers) / `f5` (dry) |
| bank at the tail | ✓ | ✗ | `f2` = `G04` + deep deck |
| fillet at the head | ✗ | ✓ | `f6` = `G03` + dry deck |
| one section IS the bridge | ✓ | ✓ | `f3` = `G04` + `G03` + dry deck |

`tools/bridge-grass-census.py` draws every frame with its anchor marked
(`mapdump/registration/m4-bridge-frames.png`); the same tool checks the two
grass cells against the ground sheet and finds no ground tile that could stand
in for them (best alpha-masked NCC 0.169 / 0.507), i.e. the abutment art ships
ONLY inside `bridgetop`.

**The art is periodic, and that is the whole story about how a deck is built.**
Shifting any one of those six cells by the vector **(110, 57) art px** leaves
53-61 % of the pixels opaque in both copies agreeing within 14/255 per channel
(70-72 % within 20; mean absolute difference 14-20) — far above any other
shift, and the same winner for all six (`python3 tools/fit-bridge.py --period`
prints it; a pure-x sweep scores 0.000 because the lattice is oblique, which is
a false negative worth remembering). The lamppost globes sit exactly on that
lattice, 110 px apart, i.e. **110/64 = 1.71875 tiles** with `ART.S = 64`.
That period is the spacing of the lampposts INSIDE one section. It is **not**
how sections are joined: the game butt-joins whole 3-lamppost sections one per
4×4 road cell, 4 tiles apart, which doubles the lampposts at every join (see
"The shipped port" below; reading the period as the step between overlapping
pieces was the 2026-10-26 model's mistake).
Cell-relative geometry that follows from the same blocks (art px ÷ 64 = tiles):
the lamppost LINE stands 1.84 tiles to the +side of a plain piece's origin (to
the −side of a mirrored one), the three globes run along the deck at 1.855 /
3.575 / 5.295, and the body spans 0.97 tiles ahead of the origin and 5.74
behind, i.e. deck centre 2.385 behind.

**Not this family** (a common wrong turn): `MonorailGame-*/images/track*bridgeoverlay.png`
with cells `C_BridgeArm/Block/BlockCut/Ornament/Railing/Wall/Wall01/WallFar/…`.
That is the monorail's concrete viaduct, drawn as separate pillar/railing parts,
and it is what `monorail_decorations.xml` composes. It is *not* the road bridge.

### The engine's bridge grammar

`libscorpio.so` `.rodata` carries 40 concrete names — `bridgese0x0…3x1g`,
`bridgesw2x0…3x3g`, `bridgese/sw{wl,el}` , `bridge{e,s,n,w}cl…` — referenced by
a `strcmp` → index dispatcher at **`0xfda5d8`** (handlers are `mov w0, N; ret`
from `0xfdaa30`), itself called from `0xfd2350`, `0x100d6d0` and `0x1198840`.
The runtime formatters live in the function at **`0x1198238`** (rizin's
`fcn.01198500` is only its tail-block region — that is why "no BL callers" was
a red herring; the entry is `0x1198238` and its BL callers are exactly
**`0xe3fd8c`** and **`0x1056178`**):

| site | format string |
|---|---|
| `0x11985e8` | `bridgencl%ix%i` |
| `0x1198634` | `bridgeecl%ix%i` |
| `0x119867c` | `bridgeswl%ix%i` |
| `0x11986ac` | `bridgesel%ix%i` |
| `0x11986cc` | `bridgescl%ix%i` |
| `0x1198760` / `0x1198770` | `bridgese%ix%i` / `bridgesw%ix%i` |
| `0x11987dc` / `0x1198804` | `bridgene%ix%i` / `bridgenw%ix%i` |

Each formatter is guarded by a probe (`bl 0x1190310`, result in a stack byte)
compared against small constants (5, 9, …), and a `csel` at `0x119872c` /
`0x11987b0` picks the plain or **`g`** name from the solid bit
(`0x1134cf0`) — so `g` = the grass-topped end, matching the `…Grass` anim
variants and `C_Grass_03/04` in the sheet. `%i x %i` is the piece's W×H, capped
at 3, i.e. the deck is composed from corner/edge pieces sized 0–3.

**Caller A (`0xe3fd8c`) is a tile walker**: that function (~`0xe3f8ac`–`0xe3fd94`)
also calls the cell-map accessor family `0x113d154/0x113d1cc/0x113d374/
0x113dd9c/0x113dec8/0x113eca4/0x113f368` and a quad/shape helper
`0x105d988` ×8. Caller B (`0x1056108`–`0x1056180`) is a thin wrapper
(`0xe5ae24`, `0x10cb5cc`, `0x19bdd80`). Verdict: **bridge pieces are derived
from road/water tile probes and emitted as geometry** — they are not placed
buildings and not a save flag. Same grammar appears as `pillarOverlayName` in
`web/assets/dlc/gamescripts-r*/data/monorail_decorations.xml`, which is why the
`g` variants are documented there as `BridgeSE01-10` + `…Grass`.

**Read that last sentence as the warning it is.** That `bridge{se,sw}{W}x{H}[g]`
family is *named* in the monorail's decoration table and composes from
corner/edge pieces sized 0–3, which is the monorail viaduct's grammar, not the
`bridgetop`/`bridgebottom` 0x0103 scenes the export actually shows at a road ×
river crossing. Chasing its formatters to explain the road bridge is a dead end
(spent twice); the rule below comes out of the art and the export instead, and
does not need the binary at all.

### The data (this save)

`tools/`-style offline decode (`web/js/camera.js` → `map-explorer-data.js` →
`terrain.js`, records `[tx,ty,type,m,p,big]`, 4-aligned lattice) gives:

| site | cells | road `m` | river `m` (E1 W2 N4 S8) | water neighbours |
|---|---|---|---|---|
| 0 | (156,16) + (156,20) | 12 (N-S) | 11 `EWS` / 7 `EWN` | E/W same nibble, N and S are road |
| 1 | (168,48) + (172,48) | 3 (E-W) | 13 `ENS` / 14 `WNS` | N/S same nibble, E and W are road |
| 2 | (252,48) | 3 (E-W) | 12 `NS` | N+S water, E/W dry |
| 3 | (224,64) + (224,68) | 12 (N-S) | 11 `EWS` / 7 `EWN` | as site 0 |

7 road cells sit on river cells; **16** road cells have a river cell as one of
their four ±4 neighbours (each touching exactly 4 tiles, except (176,48) with
7). There is no bridge flag, no extra field, and no unique `m|p` combination:
road cells on water use the same `m` as everywhere else, and `p` is 0 at all 7.
No building of any kind sits within ±8 tiles of the four sites, and the six
bridge-slug buildings in the save (177546, 250026, 250012, 236500, 163502 ×2)
are all elsewhere. Evidence: `m4-bridge-sites.png` (blue = river, grey = road,
red = road-on-water, yellow = proposed deck, green = road touching water).

Corroboration for the split between the two art families: four
`trackstraight4x2` (id 109500) sit at px 246–258, py 52 — right beside site 2,
where the monorail crosses the same river. Track crossings use the
`track*bridgeoverlay` family; roads use `bridgetop`/`bridgebottom`.

### Where they need to go in the viewer

Nothing draws them today: `buildGround`'s feature loop paints the road sheet
cell *over* the river quadrants at those 7 cells, so water disappears under a
plain road tile. A port therefore has to

1. derive the sites from the data (road cell whose `(tx,ty)` is also a river
   cell, merged into runs along the road axis — the same rule the engine
   derives from its probes),
2. pick the piece from the run length: `C_BridgeTop_09/08` (3-arch, 147 px) for
   the 8-tile runs (sites 0, 1, 3), `C_BridgeTop_06/05` (2-arch, 129 px) for the
   4-tile run (site 2), plus the matching `C_BridgeBottom_*` deck, and
   `C_Grass_03/04` at ends whose far neighbour is grass (the engine's `g`),
   *(superseded — one `C_BridgeTop_08` section per road cell over water, the
   2-arch pieces are not used, and the grass ends are an opt-in toggle; see
   "The shipped port" below)*
3. draw them **after** `buildRivCell` and after the road tile, and depth-sort
   them with buildings — the lampposts are 2.5-tile-tall art, so the cleanest
   path is the existing building sprite route (synthesised entries at the site's
   `px/py` through the `cityUrl(sp.png)` path) rather than a new flat pass.

The 16 edge-touching road cells are a separate question: the engine's answer to
"road beside water" is the `g` grass-end treatment on the deck ends, not extra
art on the kerb, so they need nothing unless we also port the shore/shadow art.

### The shipped port — one section per road cell (2026-10-27)

This is the current, game-verified model. User report that prompted it: the
bridges "display weirdly". It replaces the 2026-10-26 composition (see
"History" at the end of this section).

**What the game draws.** In the game screenshot every bridge row has **doubled
lampposts at regular intervals**: each row is separate 3-lamppost sections that
butt-join. Inside a section the globes are 110 art px apart (the art's own
period, above); from one section to the next the step is 2 × (110, 57) +
(36, 14) = (256, 128) art px = **exactly 4 tiles** — **one section per 4×4
road cell**. Both rows are in phase. The near row (lower on screen) stands
over the road's kerb; the road's kerb covers the far row's base.

**How it was measured** (reproducible; this is how any future bridge change
should be checked): capture the viewer headless (§8) at the game crop's scale
— zoom 0.583 for `m4-bridge-game-A-zoom.png`; zoom 0.6 with the export scaled
×0.8 for `m4-bridge-export-B.png` — register the game crop to the capture by
SSD on ground-only features (kerbs, banks, the fountain; sprites can carry
their own anchor error), detect the cream lamp-globe blobs in both images,
and map them to tile coordinates through `window.__CV_TILE_screen`. With the
rule below **all 12 game globes at site A and all 12 at site B land within
0.1 tile** of the viewer's, both rows, doubled joins included. This replaces
the 2026-10-26 lattice fits and `tools/score-bridge.py` scores for
positioning: at the export's ~10.5 px per tile those could not tell evenly
spaced posts from doubled ones.

**Deriving the crossings** (`deriveBridges` in the viewer, `placements` in
`tools/bridge-sites.py`, the reference implementation; unchanged since
2026-10-26). A road is ONE cell of the 4×4 lattice wide — a +y (N-S) road
occupies columns `[cx, cx+3]` with `cx % 4 == 0`, a +x (E-W) road rows
`[cy, cy+3]` with `cy % 4 == 0`. The layers are independent occupancy sets, so
a crossing shows up as **water UNDER the deck: the band is the corridor
rows/columns the water layer covers across the full 4-tile corridor**. That one
test drops the shoreline quays (most of the town's 179 road tiles that touch
water; 112 sit ON water, only 11 stretches fill a corridor). Two gates then
decide a candidate: **the road must reach both banks** — the fully-road run
extends past the band at both ends, which rejects the seven candidates that
are one real crossing read on the other axis — and `BRIDGE_MIN_SPAN = 4`, the
water at least as wide as the road. The road cells over water are
`bridgeCells`: (156,16) (156,20), (168,48) (172,48), (224,64) (224,68),
(252,48).

**Composing a crossing** (`bridgeRun` in the viewer, `bridge_run` in
`tools/bridge-sites.py`):

| constant | value | meaning |
|---|---|---|
| — | 1 section per road cell over water, per row | `bridgetop_f4` = `C_BridgeTop_08`, the 3-lamppost section with piers into the water |
| pivot along the road | `cy + 4` (+y road) / `cx` (+x road) | the cell's far edge: the bridgetop footprint (`data/building_footprints.json`, x = 2, z = 4) pinned like every building, pivot on its max-y corner; mirrored for +x |
| `BRIDGE_ROW` | −0.6 | near row pivot off a +y corridor's west edge |
| `BRIDGE_ROW_SEP` | 4.5 | far row 4.5 further (A 4.48, D 4.52, B 4.53 measured) |
| +x rows | `cy + 4 − BRIDGE_ROW − r·4.5` = `cy + 4.6`, `cy + 0.1` | the mirror image about the cell, `(a, b) → (4 − b, 4 − a)`; equals the independent 2026-10-26 B fit (0.10 / 4.60), so both orientations agree |
| `BRIDGE_ALONG` | 0 | debug nudge along the deck |

That is 14 pieces in this save: A, B and D get 2 sections per row, the inlet C
gets 1. +x roads draw the mirrored instance (`emitBridgeSpr`'s flip, anchored
at `w − ax` like a mirrored twin). `bridgebottom` is not used: it shares the
top piece's origin and is entirely covered by it.

**Layering** (`renderBridges`). Three stage containers after the ground:
`bridgeG` (the far row, screen-space billboards) → `raisedG` (the crossing
cells' road art, REPARENTED from `featC` into this tile-space twin of
`groundC`) → `bridgeNearG` (the near row). The raised set is the cells over
water PLUS the road cell just past each end of the crossing (`bridgeCells`):
the far row's end section reaches a few px over that boundary, and with only
the water cells raised it painted over the neighbouring road — a 2–3 px green
hairline along the cell edge with Bridge grass on, the end pier over the
pavement with it off (fixed 2026-10-27.3, `m4-bridge-grass-seam-B.png`,
`m4-bridge-endcell-B.png`). Which row is near is decided per
frame by screen depth against its mate, not by row index. Before 2026-10-27
both rows sat under the raised road, which hid the near row's lampposts and
rail behind the kerb. Two failure modes worth keeping: parenting the deck
sprites INSIDE the tile-space `featC` while positioning them with the
screen-space affine put them miles off-screen and NO bridge rendered (children
of a projected container must speak tile space, as the water art does, or
live in a screen-space layer, as `bridgeG`/`bridgeNearG` do); and a
derive-only check passes a pass that draws nothing, which is why
`tools/check-bridges.cjs` runs the REAL `renderBridges` against stubs and
counts emitted sprites (14 pieces, exactly half in the near layer). Anchors
are terrain decals, so they take no `ART.ax/ay` nudge.

**Grass ends — the `Bridge grass` toolbar button** (off by default,
`localStorage` key `mrsnrub.cityview.bridgegrass`; also
`__CV_BRIDGES({grassEnds: true})` and `tools/bridge-sites.py --grass`). The
art ships the abutments inside `bridgetop` (`f2` = `C_Grass_04` rock-and-grass
bank at the tail end, `f6` = `C_Grass_03` fillet at the head end, `f3` = both),
and the binary's `…g` names are gated by the solid bit at the deck ends (see
the grammar above). With the button on, the end section of each row takes
those frames: +y roads put the tail (`f2`) on the low-y cell and the head
(`f6`) on the high-y cell, +x roads the mirror, a one-cell crossing `f3`. It is
off by default because the game's own bank crops
(`m4-bridge-A-{near,far}-bank.png`) show the balustrade simply stopping at the
shore with no abutment pixels. Only the near row's grass is visible; the far
row's lands under the raised road. Evidence of the difference:
`m4-bridge-grass-{A,B,C}.png` (off | on, changed pixels outlined; the outlined
fountain/fish pixels are animation frames, not grass).

**Sites in this save:**

| site | corridor | water band | pieces | game evidence |
|---|---|---|---|---|
| A | cols 156–159 (+y) | rows 16–23 | 2 rows × 2 sections | 12/12 globes within 0.1 tile |
| B | rows 48–51 (+x) | cols 168–175 | 2 rows × 2 sections | 12/12 globes within 0.1 tile |
| C | rows 48–51 (+x) | cols 252–255 | 2 rows × 1 section | **the game paints nothing** — decoration |
| D | cols 224–227 (+y) | rows 64–71 | 2 rows × 2 sections | structurally consistent (export crop) |

**Site C is decoration, not reproduction.** It is the +x road end over the
4-wide inlet beside the circus. With the building layer off the game shows
bare water and a plain road tile there (user check, 2026-10-26); the "stone"
and "lamp" samples the `--check` gate finds are the dragon's own art and the
monorail pillar capitals (a 4.0-tile along-spacing is the monorail, never a
bridge). The user asked for a bridge there anyway, and the per-cell rule gives
it one section per row at x = 252 (rows 48.10 / 52.60). `BRIDGE_MIN_SPAN = 5`
/ `--min-span 5` drops it; `__CV_BRIDGES({on: false})` drops the whole pass.
`tools/bridge-water-check.py` also shows site C's frame is the least
trustworthy of the four (48 % tile agreement vs 61 % at A and B: the dragon
covers the inlet and rows 52–53 read as road where the save has river).

**Frames baked.** `gen_city_sprites.py bridges` bakes all ten frames
(`BRIDGE_FRAMES`): `bridgetop_f0..f7` and `bridgebottom_f0/f1`, each anchored
at the raw bsv3 block origin. The rule uses `bridgetop_f4`, plus `f2`/`f3`/`f6`
with the grass toggle on.

**Tools.** `tools/bridge-sites.py` (derive + `--place` strings, mirrors the
viewer exactly), `tools/check-bridges.cjs` (drift guard + render-pass smoke),
`tools/render-bridge.py --hyp rule` (composites the rule's pieces over the
export), `tools/fit-bridge.py --period` (the art's 110 px period),
`tools/bridge-water-check.py` (the coordinate frame without any bridge art).
`tools/score-bridge.py` scores composition only; do not position with it.

**Debug sandbox — the Road Lab Bridges tab** (`web/viewer/road-lab.html`)
composites one crossing with the real art in the viewer's container order —
water cells → far row → road cells → near row (`rail over road` draws the road
under everything) — with per-span steppers, per-piece visibility and anchor
crosshairs. Its `BRIDGE_REF` table is a snapshot of `deriveBridges()` (14
pieces over four sites), drift-guarded by `tools/smoke-road-lab.cjs` against
the viewer's own derive. `BRIDGE_FIT` is deliberately empty: the fit lives in
the rule.

**Known limit.** Rotate/Mirror (workbench orientations the game never shows)
still draw the default-orientation art and offsets, so bridges there run
across the road instead of along it.

Evidence: `m4-bridge-cell-A-before.png` / `m4-bridge-cell-A.png` (viewer |
game, same scale), `m4-bridge-cell-{B,C,D}.png`, `m4-bridge-grass-{A,B,C}.png`.
Older `m4-bridge-view-*`, `m4-bridge-rule-*` and `m4-siteC-*` renders show the
superseded composition.

**History (superseded, do not re-learn).** 2026-10-26 first port:
`bridgetop` + `bridgebottom` pairs butt-joined every 4.05 tiles and mirrored
symmetrically about the corridor. 2026-10-26 re-derivation: read the art's
110 px period as the step between OVERLAPPING pieces, so five pieces per row
stepped by 1.72 tiles over the band plus a 1-tile apron (`BRIDGE_PITCH`,
`BRIDGE_APRON`, `BRIDGE_MID` wet/dry test, `f5` dry sections), each paired with
a hidden `bridgebottom`, the inlet clamped to one centred `f3` section, grass
ends on by default, and both rows under the raised road. That gave evenly
spaced lampposts and hid the near row's posts behind the kerb — the "weird"
look. Its lattice fits (rms 0.2–0.4 tile at ~10.5 px/tile) could not
distinguish doubled from evenly spaced posts.

### Roads beside water — nothing to port (2026-10-26)

The ask was "when a road crosses a river **or goes next to water**, the road
tile turns into a bridge sprite", so the second half needed its own answer.
This save has 16 road cells with a river/ocean cell as one of their four ±4
neighbours and no water under them — the quays and shore roads. Measured with
`tools/bridge-touch.py`, which samples the export on a 0.4-tile grid inside
each tile and counts the same bridge-stone / bridge-lamp colour classes the
`--check` gate uses:

| group | samples | stone % | lamp % |
|---|---|---|---|
| 3 bridged corridors (pos. control) | 512 ea | 6.1 / 9.2 / 11.1 | 0.0 / 0.6 / 1.4 |
| 16 touching road cells, shared edge | 64 ea | 0.0 (four: 1.6–7.8) | ≤ 1.6 |
| 24 random road cells, dry within 6 | 256 ea | 0.0 – 4.7 | ≤ 0.8 |

The four touching cells that score above the noise floor — (156,12), (164,48),
(176,48), (224,72) — are exactly the cells that abut the three crossings: that
is the deck art's own overhang spilling one tile past its segment, which the
viewer reproduces for free because it draws the game's PNGs at the fitted
anchors. The other twelve read like plain road. So the engine's answer to
"road beside water" is **no extra art at all** — the abutment tufts
(`C_Grass_03/04`, the `g` name variants) belong to the deck ends, not to the
kerb, and the shore is what the river art already draws.


## 11. The dirt sheet — DirtRoadDrawing / DirtRiverDrawing (2026-10-27)

`dirtroadtilesheet.png`/`.rgb` is the dirt counterpart of `roadtilesheet.png`.
The provenance authority is **landinfo.xml** (gamescripts):
`<RoadMap texture="DirtRoadTileSheet.rgb" type="dirt" drawer="road"
origin="0,-7" size="37,64">` plus the `type="dirtriver" drawer="river"`
twin — ONE static texture name, identical from r308122 (WildWest-2016, when
the two types were added; absent in 2015's r61251) through the current
r497432, with the same `origin`/`size` as the road/river rows (hence the
same UV tables — §8/§9 carry over verbatim). The engine resolves the name
from the **installed pack set**, so the art is pack layering, not code
branching, and exactly two packs ship the file:

| pack | file | art |
|---|---|---|
| `WildWest_RiverRoadTiles-{25,50,100}-r308122` | `data/dirtroadtilesheet.rgb` | sandy, avg RGB (177,146,83) — the **permanent normal-season** art in the live game (the feature shipped with WildWest 2016 and the packs stayed installed; the store icon persists in later WildWestMenu revisions) |
| `XMAS2016/2017_RiverRoadTiles_LTD` | `images/dirtroadtilesheet.png` | brown + 0.7 % near-white snow specks, avg RGB (88,70,47) — the **Christmas override**, byte-identical PNG re-ships (76,566 B, md5 `ba1d37c28773a9b842ba61e7b7db51df`, 1024²) |

The base manifests (`web/assets/manifest.js`/`json`) have no entry: base
itself ships no dirt sheet. Provenance settled (two wrong turns logged:
"every pack copy byte-identical ⇒ BASE art" compared only the XMAS
re-ships; "winter-only" missed that WildWest is the permanent layer). The
viewer mirrors the engine: `dirtSheetTex()` serves the XMAS PNG in winter
and the WildWest `.rgb` (decoded client-side: 8-byte header — u32 flags,
u16 w, u16 h — then RGBA4444 pairs `byte0=(B<<4)|A`, `byte1=(R<<4)|G`,
nibbles ×17; the header's 0x2000 "premultiplied" flag lies on this file,
which stores `c4 > a4`, so the decoder auto-detects straight alpha — an
RGB565 read of 4444 data is what made the tiles pink/purple) every other
season. Evidence: `mapdump/registration/
m4-dirt-sheet-{slots,full}.png` (XMAS rays + contact sheet) and
`m4-dirt-ww-vs-xmas-{slots,full}.png` (all three sheets on one lattice).

**Which layer is which.** `landinfo.xml` (gamescripts packs) ships two road
entries with dirt drawers:

| landinfo | drawer | saved grid (`SaveInfo map=`) | viewer layer | model |
|---|---|---|---|---|
| `RoadEntry type="dirt"` (`savedType="road"`) | `DirtRoadDrawing` | `dirt` | `dirtroad` (park footpaths) | road quadrants, `ROAD_QUADS` 0x400520 |
| `RoadEntry type="dirtriver"` | `DirtRiverDrawing` | `dirtriver` | `dirt` (dirt-river scatter) | river quadrants, `RIVER_QUADS` 0x3fc320 |

The class names say it: these are the same two RoadDrawer subclasses
researched in §9, pointed at a different texture. RTTI puts
`DirtRoadDrawing` on the RoadDrawer body and `DirtRiverDrawing` on the
RiverDrawer body, so the whole cell model of §8/§9 carries over verbatim —
four quadrant quads per 4×4 cell, one UV parallelogram each, nibble OR
neighbour-solid, ES quadrant forces the mirror byte.

**Same lattice, same tables — measured, not assumed.** Two independent
checks say the dirt sheet is laid out exactly like roadrivertiles:

1. *Pixel rays.* For each of the 11 states, dark-boundary rays were cast
   inside the expected slot on the dirt sheet and the measured quad corners
   compared with the road table: every corner lands within ±1–2 px at all 11
   states (`m4-dirt-sheet-slots.png`). A re-designed lattice would not
   reproduce a 32-float table corner-for-corner.
2. *Binary scan.* A full `.rodata` sweep of `libscorpio.so` for
   parallelogram-quad-shaped float tables (the fingerprint of 0x400520 /
   0x3fc320) found **only the two known tables**. There is no third dirt UV
   table — the dirt drawers reuse them.

So the port needed no new geometry: the viewer's `quadGeom` cache is keyed
by kind+state+flip only, and passing the dirt texture into the same meshes
is all the art side requires.

**The save data cooperates.** The exported grids give 94 `dirtroad` cells
(88 of them nibble 3 — E+W runs, i.e. footpath segments) and 170 `dirt`
cells. Nibble reciprocity (A reaches B ⇒ B reaches A) holds 186/186 and
452/452, and neither grid contains a `'P'` — no slab fast path in practice,
but both builders handle `m < 0` anyway. Each layer probes **its own saved
grid** for the solid-side OR-ins (the drawers read their own `roadMapList`
slot), so the viewer builds two record maps, `dirtRecs` and `dirtRivRecs`,
the same way the water art probes `rivRecs` instead of `recs`.

**The port (Pixi viewer, `v=42`).** A third toolbar button, **Dirt art**
(`btn-dirtart`, `localStorage mrsnrub.cityview.dirtart`, ships ON) mirrors
Water art: `buildSpecCell`/`buildRivCell` take an optional `tex` argument —
present selects dirt mode (no legacy sheet passes, no flat-colour fallback,
return `null` and the caller keeps the flat tan fill). Cells are built
regardless of the sheets' load state (each loader triggers one `buildGround`
rebuild when its texture arrives) and `applyDirtMode()` owns visibility:
`dirtArtOn && !!dirtSheetTex() && !terrain.hidden[tn]` on the quads — where
`dirtSheetTex()` mirrors the engine's pack priority (winter → XMAS PNG,
else the WildWest `.rgb`, decoded client-side RGBA4444 via `fetch`) —
the fill shrunk from `big+BLEED` to `big` under the art,
the legacy manhole pulled under the art. `applySheetMode` respects
`dirtArt`-marked `sheetRecs` records so the road-sheet passes never
double-draw, and with the toggle off everything falls back to exactly the
pre-existing behaviour (sheet passes or disc). The dirt loaders are
add-ons like the ice sheet — they deliberately do not call
`aBootSettled()`.
Because quadrant meshes bake their texture at build time, the season button
now calls `buildGround()` after `applySeasonMode()` — that swap also finally
moves the spec road quads onto `iceHiTex` when you cycle into winter (the
ice sheet used to only land if winter was set before first build).

**Road Lab.** `road-lab.html` gives the two dirt layers **two tabs** (they
are different drawers — one model button swapping them hid the difference):
tab 3 **dirt road** (`DIRT`, `engStates`/`engFlip` + `ROAD_QUADS`) and tab 4
**dirt (river)** (`DIRTR`, `rivStates`/`rivFlip` + `RIVER_QUADS`). Each
renders its sheet with its table's diamonds on the shared lattice, the 11
slots raw | sampled, and live cell demos; each has its own zoom/force/flip/
raw/lattice/mask/probe state and its own **sheet** button cycling
`DIRT_PACKS` (WildWest `.rgb` normal, XMAS `.png` winter), with decoded
sheets cached in `DIRT_IMGS`. `renderDirt`/`formatDirtRef`/`blitDirtCell`/
`dEffPass`/`dPick`/`dFlip`/`dTable` take the view state. The `.rgb` path
runs the pure `decodeRgb` (RGBA4444, per `tools/extract_assets.py` — see
§11; the original RGB565 read rendered pink/purple).
`quadBox`/`uvCTM`/`blitQuad` gained a
table parameter (default river) to make that possible. The reference block
appends a `DIRT_ART` (road) + `DIRT_ART_RIVER` (river) contract;
`tools/smoke-road-lab.cjs` gates it —
parallelogram sanity, per-view picks/flips, view independence (the tabs'
states must not cross), and drift guards: the lab's
`ROAD_QUADS` must equal the viewer's, the viewer and `DIRT_PACKS` must
point at the same two sheet files, `dirtSheetTex()` must keep the winter/
else pack priority, the viewer's inline decoder must keep the lab's 4444
core, and `decodeRgb` is gated against the real WildWest 25-tier pack file
with the `extract_assets.py` numbers as oracle (256², 47.1 % visible,
avg RGB 179,148,86 — a 565 read fails all three).

**Recolored siblings, same lattice, for later.** landinfo.xml pairs each
sheet name with a RoadMap row (`GoldRoadTileSheet.rgb` type="goldroad",
`CobblestoneRoadTileSheet.rgb` type="cobblestone", `SandRoadTileSheet.rgb`
type="sand", `KrustyLandRoadTileSheet.rgb` type="klsroad"), and the packs
ship tonal variants of the same sheet that map 1:1 onto viewer layers still
drawn flat:
`krustylandroadtilesheet.png` (KrustylandGame packs → `klsroad`), and
`sandroadtilesheet.rgb` / `goldroadtilesheet.rgb` / `cobblestoneroadtilesheet.rgb`
(THOH2016 pack → sand/gold/cobblestone road themes). Given the §11 result
one would expect the same tables to apply — verify the rays before porting.

## 12. The ocean-grid brushes — boardwalk / pier tile art (2026-10-27)

### The data — oceanData is the brush grid, and one frame is one 4×4 cell (2026-10-28)

Until 2026-10-28 the viewer showed **1 boardwalk tile and 4 pier tiles**:
the generator read `oceanData` (f34, 3,072 chars) with the legacy
column-major one-tile-per-char decode, explained most of it away as a
natural "wave band + five periodic lattices", and kept only the 5 tiles
that broke the pattern (notes/01 "Recovering boardwalk/pier tiles", now
superseded). The rest of the Squidport deck clicked as `grass` and its
shops stood half in the sea.

**The re-decode.** `oceanData` is the same **4×4-cell codebook** as the
34,784-char layers (16 chars = one block of 4×4 cells, byte k → cell row
k//4, col k%4; `P` solid, `a`..`p` = E1 W2 N4 S8 mask), **3 blocks per row ×
64 rows**. Neighbour-mask reciprocity is exactly **1.000** at stride 3
(6: 0.98, 12: 0.94; the old per-tile read: 0.87) — the signature the land
layers were verified with. It holds **only** brush cells (262; there are no
waves in it — the sea is the solid base alone). Cell (c, r) covers town
tiles `[−48 + 4c, +4) × [−112 + 4r, +4)`, the land's block pin (−3, −7) × 16.
Checked on the deck furniture: SquidportEntrance 132/144 footprint tiles on
brush cells, FerrisWheel 15/15, both Boardwalk tents and the bench; the
MetalBoardwalkRailing row sits on the deck's end edge (y 124). Evidence:
`mapdump/registration/m4-ocean-brush-celldecode.png` (top-down decode +
building footprints).

| structure | cells | town tiles | sits under |
|-----------|-------|-----------|------------|
| Squidport deck | 112 (all masked, `jllk/nppo/fhhg`) | x −24…−9, y 12…123 | SquidportEntrance, the shops, tents, carousel |
| OrnatePier block | 131 (76 `P` + two 1-cell walkways) | x −48…−5, y −56…3 | OrnatePier (−12,−22) |
| PirateShip dock | 12 (`P`) | x −32…−9, y −88…−73 | PirateShip |
| BarnacleBayMarina jetty | 7 (`a`, mask 0) | x −20…−9, y 144…163 | BarnacleBayMarina |

**Boardwalk vs pier.** The save merges both brushes into this grid, so type
is recovered from connectivity (user rule: pier tiles must connect to the
OrnatePier building; not everything touching it is pier, and the main
Squidport deck has none). Connectivity is the **mask graph** — two masked
cells link only when both name each other — and pier = every walkway chain
with a tile on or beside the OrnatePier footprint: the **19-cell spiral**
whose end cell lies under the building (304 tiles). Everything else is
boardwalk (243 cells, 3,888 tiles): the `P` slabs around it, the second
36-cell walkway in that block (it never reaches the gate — the least
certain call), the deck, the dock and the jetty. `gen_map_explorer.py`
ships both as per-tile `pts` layers (grid = town + (ox, oy)); `terrain.js`
no longer turns the 3,072-char string into ocean tiles (the Ocean preset
frames the sea base, and a click on open sea reports `ocean`).

**Scale.** `C_Shadow` is 507×265 100-tier px = **512×256, one 4×4 cell** at
the 128×64 px tile every other -100 asset uses. The original port blitted
one frame per TILE at a quarter of that, i.e. 4× too small; the viewer now
blits one frame per cell (at its origin tile, `tx & 3 == 0 && ty & 3 == 0`)
and probes water at ±4 tiles. The Road Lab tabs still preview a single
frame per tile-space diamond — fine for the state/crop calibration they do.

**Draw order.** Frames are elevated (the deck sits ~45–65 px above its
shadow), so a cell's `C_Shadow` must never land on a nearer deck: cells sort
by the ORIENTED tile sum (`CAM.oriented`, the terrain feature sort's key).
The old `tx + ty` key is only screen depth in one orientation; under the
default ORIENT it drew far cells last and striped every deck row blue.
Box → tile is now derived from the live camera (`CAM.tileAffine`, inverse
of the ground matrix's linear part): identical to the fixed rotation π/4
chain below under the default ORIENT, and still upright after
Rotate/Mirror. Sheets settle before the rebuild: `pier-tiles.json` only
started the two sheet loads, and the immediate `buildGround` found no
texture, so the art used to appear only after some unrelated rebuild.

The `boardwalk` and `pier` layers are **not RoadMap tiles**. landinfo.xml
gives the two brushes `PathBrush` textures `boardwalktiles` /
`ornatepiertiles` and SaveInfo `map="ocean"` `savedType="road|pavement"`,
so their art ships as ordinary **building-sprite bsv3 scenes**, not sheet
art with a UV table:

| brush       | asset                        | pack                                   | anims |
|-------------|------------------------------|----------------------------------------|-------|
| boardwalk   | `boardwalktiles.bsv3/.png`   | WaterfrontGame-100-r146180             | 13    |
| pier        | `ornatepiertiles.bsv3/.png`  | SpringfieldHeights2BuildDecoGame-100-r284665 | 5 |

`tools/gen_pier_tiles.py` parses both with `gen_city_sprites.parse_bsv3`
(0x0103 scene: cells = sheet crop rects, frames = block lists of
`(cell, x, y, a b; c d)`) and emits `web/assets/city/pier-tiles.json`: per
state, the block list **already in engine draw order** — the BoardwalkDrawer
tile (vtable 0x1a192c0, singleton anim table 0x1af15d0+0x60, string slots
0xf2f868–0xf2f8a0) paints the list *reversed*, and its `C_Shadow` block,
listed last, goes down first. The viewer blits array order.

**Geometry** (the per-TILE chain as first written; the viewer now applies
it per 4×4 cell, see above). Block `x/y` are the crop's TOP-LEFT in 100-tier sheet px;
`(a,b;c,d)` is a scale (+ `a<0` mirror about the anchor, so `x` is then the
block's RIGHT edge). One block = one sprite: anchor 0.5, rotation π/4,
scale `(a·SHEET_SX/4, d·SHEET_SY/4)` — the same chain as the road-sheet
pass sprites, because **box space is sheet px / 4** in the 127×66 sheet box
whose inscribed diamond is the tile; box→tile is the linear
`(ux,uy) = ((bx−63.5)/127, (by−33)/66)` → `(cx+ux−uy, cy+ux+uy)`.

**Calibration comes from C_Shadow alone** (it fills its crop exactly with
the diamond, opaque (0,136,204)): `ox = −x/4`, `oy = −y/4` — boardwalk
(64.04, 49.31), ornatepier (62.40, 50.36, with a 0.9663 matrix). The deck
crops sit ~30 px ABOVE the diamond — the deck is *elevated* — so
calibrating from them sinks the tile.

**State rule** (art-derived; the binary's setter was not pinned): the
`Normal_*` states pick their leg/wave subset by which lower edge faces
water — `PostLeft` iff the lower-LEFT neighbour `(tx, ty+1)` is water,
`PostRight` iff `(tx+1, ty)` is; water = inside the RE'd sea-fill bounds
and no same-layer brush tile. `boardwalk` uses Leg1+2 (left) / Leg3+4
(right) plus waves; the ornate pier ships **no Leg cells** — waves 1/2/5
(left) and 3/4/6 (right) stand in, and `C_PierWave6a` is the `a<0` flip
case. Static frame 0 only — the wave loop is not ported, same choice as
the road art. Block counts: boardwalk 15/19/19/23 (+TopOnly 12,
PostOnly_* 5/5/9, Neutral 24), pier 15/18/18/21 (+Neutral 21).

**Port.** The Pixi viewer (`city-view-pixi.js`) loads the manifest, blits
each brush CELL's frame into `featC` after the main loop, back to front by
oriented depth (see "Draw order" above), and shrinks the
legacy flat fill under the art (the opaque shadow covers the diamond) —
`btn-pierart`, `mrsnrub.cityview.pierart`, ON by default. The Road Lab runs
the calibration rig as **two tabs, one per brush** (boardwalk / pier, own
view state each — the same split the two dirt tabs use): sheet with the
focused state's crop rects numbered in draw order, plus every state blitted
into tile space unclipped (the elevated deck must show), water-edge toggles
driving the auto-state pick. `tools/gen_pier_tiles.py --evidence` writes
`mapdump/registration/pier-<type>-states.png`;
`tools/smoke-pier-tiles.cjs` re-parses both bsv3s as a drift guard over the
manifest and gates the viewer/lab integration; `tools/smoke-road-lab.cjs`
drives the tab.
