# 11 — Ocean, boardwalk and pier: how they work (2026-10-30)

This note covers the sea, the boardwalk brush and the ornate-pier brush, as
they stand after CHANGELOG `2026-10-30.17` → `.25`. It is meant as the one
place to read before touching any of them.

**Related notes:**
- `10-boardwalk-analysis.md`: how the brush grid was found in the save.
- `09-road-tiles.md` §12: the brush art and manifest.
- `06-camera-and-movement.md`: the camera and the building pivot rule.

**Status:**
- **Settled:** the sea base, the brush data and placement, the draw order.
- **Open:** the user reports the marina join is "almost perfect but still
  slightly off" (§7).

## 1. Coordinates you need

- **Town tiles.** The save's building frame: `positionX/Y`. Everything
  below is in town tiles unless it says grid.
  - Grid = town + (ox, oy) = town + (12, 136) (`MAP_DATA.ox/oy`).
  - `terrain.js` stores its sea bounds in grid. The viewer's `tx, ty` are
    town tiles.
- **One tile = 128 × 64 art px.** That is `CAM.PX_PER_UNIT` 64 with
  `TILE.hw` 1 / `hh` 0.5, and `ART.S` 64 art px per world unit. At zoom z,
  1 art px = z screen px.
- **Shipped `ORIENT {fx 1, fy −1, swap 1}`:**
  - +x runs up-right on screen, +y down-right.
  - A tile rect's screen-FRONT (bottom) corner is (x0, y1).
  - Screen depth is the oriented sum (y − x under the default ORIENT).
- **Screen ↔ ground conversion (art px):**
  - +1 tile in x = (+64, −32); +1 tile in y = (+64, +32).
  - The reverse, a screen nudge (ax, ay) as a tile shift:
    x = (ax/64 − ay/32)/2, y = (ax/64 + ay/32)/2.
  - So a pure screen-down move of 32 art px is (−0.5, +0.5) tile.
- **Building pivot rule** (notes/06, "Block rect vs sprite base"):
  - A building sprite's anchor sits on its footprint's front corner
    `(px, py)` = (x0, y1).
  - The footprint is `[px, px+w] × [py−d, py]`.
  - The brush frames now use the same rule (§4).

## 2. The ocean

**The sea base: a solid fill.** The sea is one solid colour, `SEA_RGB`
(84, 170, 252), over a fixed rectangle west of the shoreline:

```
terrain.js  SEA_TILE = { x0: -80, x1: 0, y0: -160, y1: 704 }   // TOWN tiles
            seaFillX0..Y1 = SEA_TILE + (ox, oy)                // stored as grid
```

- **x 0 is the shoreline.** It is the same x the save's coast props sit
  on: Mountain03 / LowerMountainBeach at x 0..16, the beach chairs at
  x 0..3. The beach LandEdge sets are anchored on it too (CHANGELOG `.16`).
- **The `.17` bug:** before `.17` the defaults were tile numbers stored as
  if they were grid, which pushed the sea 12 tiles west and left a gap at
  the coast.
- **Bounds:** y −160 is the north end, under the mountain row and cloud
  wall (`.18`, `.19`). y 704 is just past the land's south end (Region
  Springfield y2 = 700).

**`oceanData` holds no water.** It is not a wave map. It holds only the two
brushes (§3). The 2026-10-19 "wave band + periodic lattices" reading is
superseded (notes/10).

**Who reads the sea rect:**
- **Water test:** `topTypeAt` returns `ocean` inside it, and the viewer
  uses the same rect to decide which brush edges face water (§5).
- **Ocean preset:** frames this rect.
- **Both pages:** the Canvas page and the Pixi viewer share `terrain.js`
  (`terrain.js?v=16` on both). `smoke-camera` checks the sea against tiles.

**Not done:** there is no wave or foam animation on open sea. Shore foam
belongs to the beach art (`BEACHSHORE*`, `C_Wave_*`), which is static at
frame 0.

## 3. The brush data: where the boardwalk and pier are

Full proof in notes/10; the essentials:

- **Decode.** `oceanData` (LandMessage f34, 3,072 chars) is the land
  layers' 4×4-cell codebook at **3 blocks per row × 64 rows**.
  - Codes: `G` empty, `P` solid cell, `a`..`p` neighbour masks
    (E1 W2 N4 S8).
  - Neighbour-mask reciprocity is 1.000 at stride 3.
- **Cell position.** Cell (c, r) covers town tiles
  `[−48 + 4c, +4) × [−112 + 4r, +4)`: the land's block pin (−3, −7) × 16.
- **Contents:** 262 cells:

  | structure | cells | town tiles |
  |---|---|---|
  | Squidport deck | 112 | x −24…−9, y 12…123 |
  | OrnatePier block | 131 | x −48…−5, y −56…3 |
  | PirateShip dock | 12 | x −32…−9, y −88…−73 |
  | BarnacleBayMarina jetty (the L) | 7 | x −20…−9, y 144…163 |

- **Boardwalk vs pier.** The save merges both brushes, so the type is
  recovered from the mask graph (`gen_map_explorer._mask_chains`):
  - **pier** (ornate) = the 19-cell walkway chain whose end lies under the
    OrnatePier building;
  - **boardwalk** = everything else (243 cells).
  - The second, 36-cell walkway in the OrnatePier block is the least
    certain call (notes/10 §3).
- **Shipping.** `gen_map_explorer.py` ships both as per-tile `pts` layers.
  The viewer regroups them into 4×4 cells and draws one frame per cell, at
  the cell's origin tile (`tx & 3 == 0 && ty & 3 == 0`).

## 4. The art and its placement

**The art is building-sprite scenes, not road-sheet art.**
- `landinfo.xml` gives the two brushes PathBrush textures `boardwalktiles`
  (WaterfrontGame-100) and `ornatepiertiles`
  (SpringfieldHeights2BuildDecoGame-100).
- Both are 0x0103 bsv3 scenes.
- `tools/gen_pier_tiles.py` parses them into `web/assets/city/pier-tiles.json`
  (gitignored; regenerate with the script):
  - per state, the block list in draw order (the engine paints the list
    reversed, so `C_Shadow`, listed last, goes down first);
  - each block is `{n, c: sheet crop, p: top-left in art px, m: 2×2 matrix}`
    (diagonal only; `m[0] < 0` mirrors, and `p.x` is then the right edge).
- **One frame = one 4×4 cell at 1:1 art px.**
  - The deck-top crops span x −250…+253 and y −262…≈0: one 512 × 256 cell
    diamond, standing on the frame origin.
  - Beneath the deck: the side faces, legs (`C_Leg1–4`; the ornate pier
    ships none, so its waves stand in), wave rings (`C_PierWave*`) and
    the opaque blue drop shadow `C_Shadow` (507 × 265, centred ~69 px
    below the deck).
- **States** (`Normal_None / PostLeft / PostRight / PostLeftAndRight`)
  select the legs and waves. See §5.

**Placement rule (`.23`):** the frame ORIGIN is pinned to the cell's front
corner (x0, y1) at 1:1 art px. This is the building pivot rule, and it puts
the deck's top surface exactly on the cell.

```
buildPierCell:  K = CAM.scale(cam) / ART.S                 // screen px per art px
                corner = (tx, ty + 4)                       // front corner of the cell
                block offset = (p + PIER_NUDGE) * K, pulled back to tile space
                through the inverse of the camera's tile affine (billboard:
                stays upright under Rotate/Mirror)
```

**How it was measured (independent of the deck):**
1. Render the viewer at the export's scale.
2. Register it to the full-res in-game export
   (`Tapped Out - Simpsons_Screenshot-2025-01-17--19-12-02.png`, 16200 ×
   8370, ~9.4 px per tile) using **only the building sprites**: the marina,
   ships, icebergs, Krusty Burger.
3. Classify plank vs water pixels in both images and project them into
   tile space.
4. Find the tile shift that best matches the two deck masks.

**Results:**
- **`.22` placement:** the marina L needed (−0.75, +0.75) tile =
  **48 art px down**.
- **`.23`:** (0, 0). A direct masked pixel match agrees to ~1 export px
  (~7 art px).
- **Reference check:** the marina building on its own registers within
  1 export px of all the other buildings, so it is a sound reference.
- **Squidport:** too covered by shops to pin the vertical. Its cross-deck
  shift is consistent.
- **Scripts:** in the session scratchpad: `reg.py`, `topdown.py`,
  `tdshift.py`, `regone.py`. They are not in the repo. The method is above
  if they need rebuilding.

**Rules that were tried and are wrong.** Do not reintroduce them:

| CHANGELOG | rule | error |
|---|---|---|
| ≤ `.19` | centre `C_Shadow` on the cell | ~70 art px too high (C_Shadow is the drop shadow, below the deck) |
| `.21` / `.22` | pin the "ground corner" fitted to the `C_PierWave` leg rings | ~48–50 art px too high |
| old | per-TILE frames at ¼ size, 127 × 66 box mapping | 4× too small, slightly stretched |

**Why `.21` was wrongly accepted:** the user judged `.20` (which is the
`.23` rule) "too low" next to the marina's own dock planks. The real cause
was draw order (§6): the marina's dock end was painted over the brush,
which makes the brush look lower. That was misread as a position error, and
the fix overshot. **Lesson:** when a join looks off, check what draws over
what before moving anything.

## 5. Which state each cell uses

Art-derived; the binary's state setter was never pinned. A cell's legs go
on the lower edges that face water:

- `PostLeft` iff the lower-left neighbour cell (tx, ty + 4) is water;
- `PostRight` iff (tx + 4, ty) is water;
- both, or neither.

"Water" means inside the sea rect (§2) and not another brush cell. The
per-cell masks in the save may be what the engine actually uses. That is
untested. Static frame 0 only; the wave loop is not ported.

## 6. Draw order

There are three ordering rules.

**1. Among brush cells:** back to front by oriented depth (`CAM.oriented`
sum, then u). A cell's raised deck, legs and splash must overdraw the cell
behind it, and its `C_Shadow` must never land on a nearer deck. Plain
`tx + ty` is wrong under the default ORIENT; it striped every deck row
blue.

**2. Ground copy.** Every cell is drawn in the ground layer (`featC`),
under all buildings. That is right for whatever stands on a deck: the
Squidport shops, the Ferris wheel, the holo trees.

**3. Scene "over" pass (`.25`).** A cell that lies wholly in front of a
building it overlaps on screen is blitted again in the scene pool, right
after that building. A single depth key can't serve both this case and
rule 2, which is why there are two copies.
- **"In front"** is the iso separating-axis test on oriented footprints:
  `cell.u0 ≥ B.u1 || cell.v0 ≥ B.v1`. It only counts when the two drawn
  rects overlap in world space.
  - Building rect: the sprite manifest's w/h/anchor.
  - Cell rect: its blocks' extents.
- **Cells in front follow.** A late cell takes every overlapping cell in
  front of it to the same slot, in ground order, so its shadow can't land
  on a nearer deck.
- **Re-emits.** Buildings already drawn that stand on, or in front of, a
  late cell and overlap it are emitted again after the cells.
- **Counts in this save:** 188 cells redrawn, 12 building re-emits.
- **Caching:** `derivePierOver()` re-derives when the ground rebuilds
  (`pierRecs` identity) or the sprite manifest changes.
- **Case that motivated it:** BarnacleBayMarina's footprint is x −8..4,
  y 144..156. The brush cell x −12..−8, y 144..148 butts against its west
  face on the viewer's side. Before `.25`, the marina's dock end (side
  face, legs, blue shadow) was painted over that cell. With the pass on,
  the brush L's top and front edges run flush into the marina's dock.
- **Other effects, checked:** at the pirate dock, its end now covers the
  island's surf. At the Squidport, the deck now shows under the arch.
  The checked areas showed no case of a deck covering a shop.

## 7. Tools, knobs and probes

- **Road Lab → "marina align"** (`viewer/road-lab.html#tab-align`): the
  live viewer framed on the marina. It moves every brush frame together
  (buttons, arrow keys / shift+arrows, dx/dy fields, A/B toggle) and
  outputs copyable JSON:
  - `pierDx/pierDy`, in screen art px from the shipped placement;
  - the tile-space equivalent;
  - the viewer version and camera;
  - a reproducing URL.

  Use it for the remaining "slightly off". Read the result with the
  over pass ON. The user's first reading, (0, +32), was taken with the
  pass off and was compensating for the overlap.
- **Viewer URL:**
  - `?pierDx=&pierDy=`: the art-px nudge, ships at 0.
  - `?pierOver=0`: turns off the over pass (A/B).
  - `?camTx=&camTy=&camZ=`: open on a view that is never saved.
- **Console / harness probes:**
  - `__CV_PIER_NUDGE(dx, dy)`: sets the nudge live.
  - `__CV_PIER_OVER()`: lists which cells go after which building, plus
    the re-emits.
  - `__CV_CAM()`: the live camera.
  - `DIAG.pierOver`: the over-pass counts.
- **Harnesses:**
  - `smoke-pier-tiles`: the manifest re-parse, the origin rule, no ground
    offset, the deck spanning one cell, the over pass.
  - `smoke-road-lab`: the Road Lab controls exist.
  - `smoke-camera`: the sea is checked against tiles.
- **Evidence** (`mapdump/registration/`, gitignored):
  - `m4-boardwalk-marina-firstprinciples.png`: game | `.22` | `.23`.
  - `m4-boardwalk-marina-zorder.png`: over pass off | on | on + (0, +32).
  - `m4-boardwalk-zorder-squidport-check.png`: Squidport off | on |
    changed pixels.

## 8. Open

- **The "slightly off" residual at the marina join.** The export
  measurement says 0 ± ~7 art px; the user still sees a small offset.
  Candidates:
  - a few px of nudge;
  - the marina sprite's own anchor;
  - the per-cell state (legs) at the join.

  Get a marina-align readout with the over pass on.
- **Walkway B's type** (notes/10 §3) and the engine's real state setter
  (§5).
- **Wave animation:** none on the sea or the brush rings.
- **Road Lab boardwalk/pier tabs:** they still preview one frame per tile
  diamond (the old box mapping). That is fine for crop calibration, but
  they do not show in-town scale.
- **Old sea numbers:** the Road Lab text and the beach manifest's
  `coast.coastY1: 512` still quote them.
