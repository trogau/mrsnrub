# 10 — Boardwalk / pier analysis: oceanData is the brush grid (2026-10-28)

**Status: shipped** (CHANGELOG `2026-10-28.1`, viewer `v=45`). This note
summarises the investigation and the fix, and explains why the earlier
conclusion "the Squidport promenade is not in the save" (notes/01's
2026-10-19 recovery section, and a later agent review that built on it)
was wrong. The short technical reference is notes/09 §12 "The data".

## TL;DR

- **The boardwalk and pier ARE in the save.** `oceanData` (LandMessage f34,
  3,072 chars) is **not** a wave-mark frame. It is the same **4×4-cell
  codebook** as the 34,784-char terrain layers, **3 blocks per row × 64
  rows**. It holds **only** the two brushes: 262 cells (4,192 tiles), with
  no waves at all.
- Cell (c, r) covers town tiles `[−48 + 4c, +4) × [−112 + 4r, +4)`, which is
  the land's block pin (−3, −7) × 16.
- The decoded shapes sit exactly under the Squidport, OrnatePier, the
  PirateShip and BarnacleBayMarina.
- **Type split** (user rule: pier must connect to the OrnatePier building):
  - **pier** = 19 cells: the walkway chain whose end lies under OrnatePier.
  - **boardwalk** = 243 cells: everything else.
- **Before:** 1 boardwalk and 4 pier tiles. The deck under the Squidport
  shops clicked as `grass`, and the shops stood half in the sea.
- **After:** the whole promenade renders with the engine's own brush art,
  and clicks report `boardwalk` or `pier`.

## 1. The symptom

In the real in-game full-map export (`m4-squidport-pb-vs-ingame.png`, left
half), the Squid Port district (around town (−18, 22)) is a large plank
promenade with:
- the Ferris wheel, lighthouse and stalls;
- the shops (tattoo, sushi, …) standing on the deck.

The viewer drew sea and grass there. A click reported `grass`.

## 2. What was wrong: the decode, not the layering

### 2.1 The old reading (2026-10-19, now superseded)

`gen_map_explorer.py` and `terrain.js` read `oceanData` with the legacy
per-tile decode:
- column-major, one char = 16 sub-tiles of one column;
- `grid x = col − 33` (`Terrain#seaColOffset`).

That reading produces a "wave band" plus **five strictly periodic
lattices** (notes/01, table A–E). Those lattices were treated as natural
sea texture. Only the 5 tiles that broke the pattern were kept as brush
tiles: boardwalk (−7, 48) and piers (−11, 135), (−11, 150), (−12, 421),
(−12, 439). Everything else in the string was drawn as fake wave marks.

### 2.2 The correct reading

Decode it exactly like the land layers, but with 3 blocks per row:
- 16 consecutive chars = one block of 4×4 cells (byte k → cell row k//4,
  col k%4);
- blocks are row-major, 3 per row;
- `G` = empty, `P` = solid cell, `a`..`p` = neighbour mask (byte − 97;
  E=1 W=2 N=4 S=8).

**Proof 1: neighbour-mask reciprocity.** Every mask bit should be answered
by the neighbour it points at. Real cell data gives exactly 1.000; a wrong
layout does not.

| layout | reciprocity |
|---|---|
| **3 blocks/row, row-major** | **1.000** |
| 6 blocks/row | 0.980 |
| 12 blocks/row | 0.939 |
| 24 blocks/row | 0.880 |
| legacy per-tile (old reading) | 0.87 |

This is the same test that established the land layers' 37-blocks/row
decode (notes/01 "Terrain grids"). The old reading's "periodic lattices"
are what regular cell bytes look like when they are smeared out one tile
per char.

**Proof 2: the decoded grid is structure, not sea.** Rows are cell rows,
columns 0–11 are cell columns.

```
    0123456789ab
  6 ....P..PPP..      <- PirateShip dock (P)
  9 ....PPPP....
 14 PPPPPPPPPP..      <- OrnatePier block: P slab + two 1-cell walkways
 15 PjddddddkP..
 16 PmPPPPPPmP..
 17 PmPjddcPmP..
 18 PmPmPPPPmP..
 19 PmPfddddgP..
 20 PmPPPPPPPP..
 21 Pfdddddddc..
 22 PPPPPPPPPPP.
 23 Pjdddddddc..      <- walkway A starts at col 9, under OrnatePier
 24 PmPPPP......
 25 PmPbkP......
 26 PmPPmP......
 27 PfddgP......
 28 PPPPPP......
 31 ......jllk..      <- Squidport deck: a clean 4x28-cell rectangle
 32 ......nppo..         (rows 32..57 identical)
 58 ......fhhg..
 64 .......aaa..      <- BarnacleBayMarina jetty (mask-0 'a' cells)
 65 .......a....
```

**Proof 3: the origin is pinned by the buildings standing on it.** With
the origin at (−48, −112), the footprint tiles that land on brush cells are:

| building | footprint on brush cells |
|---|---|
| SquidportEntrance | 132 / 144 |
| FerrisWheel (−21, 15) | 15 / 15 |
| BoardwalkArtTent | 15 / 15 |
| BoardwalkAnimalsTent | 9 / 12 |
| BoardwalkBench | 2 / 2 |
| BoardwalkCarousel | 24 / 36 |
| HoloBoardwalkTree × 2 | 1 / 1 each |
| MetalBoardwalkRailing × 6 (y 124) | 0 — they sit on the deck's end edge (the deck ends at y 123), as railings should |

The x origin (−48) also came out of a blind best-fit sweep over all
ocean-side buildings. The y origin was pinned by the deck furniture.

**Proof 4: it renders like the game.** See
`m4-boardwalk-before-after.png` against the in-game export.

### 2.3 What is where (town tiles)

| structure | cells | town tiles | under |
|---|---|---|---|
| Squidport deck | 112 (all masked: `jllk / nppo / fhhg`) | x −24…−9, y 12…123 | SquidportEntrance, shops, tents, Ferris wheel, carousel |
| OrnatePier block | 131 (76 `P` + walkways of 19 and 36) | x −48…−5, y −56…3 | OrnatePier (−12, −22, 9×12) |
| PirateShip dock | 12 (`P`) | x −32…−9, y −88…−73 | PirateShip (−20, −89) |
| BarnacleBayMarina jetty | 7 (`a` = mask 0) | x −20…−9, y 144…163 | BarnacleBayMarina (−19, 149) |

The legacy "5 recovered tiles" are not brush tiles under the correct
decode. (−7, 48), (−11, 135) and (−12, 421) all report `grass` now.

## 3. Boardwalk vs pier

The save merges both brushes into this one grid, because landinfo routes
both BoardwalkDrawing and PierDrawing to `map="ocean"`. The per-cell type
is therefore not stored and has to be recovered.

The user's rules:
1. Every pier tile must connect to the OrnatePier building.
2. Not everything connected to OrnatePier is pier; some of it is
   boardwalk.
3. There is no pier in the main boardwalk area to the south.

Implementation (`gen_map_explorer.py`, `_mask_chains`):
- **Connectivity is the mask graph, not plain adjacency.** Two masked cells
  are linked only when each one's mask names the other (E↔W, N↔S). `P`
  cells are left out.
- **Plain adjacency doesn't work.** It merges the whole 131-cell OrnatePier
  block into one piece, which breaks rule 2.
- **pier** = every chain with a tile on or beside the OrnatePier footprint.
  In this save that is walkway A, a 19-cell spiral (rows 23–27) whose end
  cell (9, 23) lies under the building: 304 tiles.
- **boardwalk** = everything else: 243 cells, 3,888 tiles.
  - the `P` slab around the walkways;
  - walkway B (36 cells, rows 15–21), whose end cell (9, 21) stops 2 tiles
    short of the footprint;
  - the Squidport deck, the PirateShip dock and the jetty.
- **Least certain call: walkway B.** It has the same shape as walkway A
  but never reaches the building. If the game shows stone (ornate) tiles
  there, the rule should become "chains whose end cell is next to the
  OrnatePier block".

## 4. Viewer fixes needed to make it look right

The brush art (`assets/city/pier-tiles.json`, bsv3 frames from
`boardwalktiles` / `ornatepiertiles`, notes/09 §12) had only ever drawn 5
isolated tiles. It had three bugs that only show on a whole deck:

1. **Scale: one frame is one 4×4 CELL, not one tile.** The frame's
   `C_Shadow` diamond is 507×265 100-tier px, i.e. 512×256 = a 4×4 cell at
   the 128×64 px tile every other `-100` asset uses. The viewer blitted one
   frame per tile at ¼ size. It now blits one frame per cell (at the cell's
   origin tile, `tx & 3 == 0 && ty & 3 == 0`) and probes water at ±4 tiles.
2. **Draw order.** The deck is elevated about 45–65 px above its shadow, so
   a cell's shadow must never land on a nearer deck.
   - The sort key was `tx + ty`, which is screen depth in only one
     orientation. Under the default ORIENT it drew the far cells last, and
     their shadows striped every deck row blue.
   - It now sorts by `CAM.oriented` depth, the terrain feature sort's key.
   - An offline 3×3 composite of the frames (sheet space, correct order)
     tiles seamlessly, which proved the art itself is fine.
3. **Load race.** When the manifest loaded, it started the two sheet loads
   and immediately rebuilt the ground with no textures, so the cells
   stayed flat fills. It now waits for the sheets to decode, then rebuilds.

Also changed:
- Box → tile is now derived from the live camera (`CAM.tileAffine`). This
  is identical to the fixed π/4 chain under the default ORIENT and stays
  upright after Rotate/Mirror (checked).
- `terrain.js` no longer turns `oceanData` into ocean tiles, so the fake
  wave marks are gone. The Ocean preset frames the solid sea base instead,
  and a click on open sea reports `ocean` rather than `grass`.

## 5. Where the other agent's review was wrong (and right)

The review (2026-10-28) concluded: *"The Squidport/Barnacle Bay promenade
ground is absent from the save entirely — the client draws it from
district/template data not stored in the .pb … recommended: hand-table the
promenade extents as static cells."*

**Right:**
- **The symptom.** The game draws planks at (−18, 22); the old viewer drew
  grass.
- **The coordinate frame.** The hover readout is the raw positionX/Y frame
  that buildings use. Its prop checks hold: with the new decode,
  (−18, 22), LoveBench (−19, 26), BoardwalkBench (−19, 30) and
  FriedDoughStand (−11, 31) all report `boardwalk`.
- **Not in the land rasters.** The 10 main rasters (roads, rivers, the 7
  roadMapList layers) really have 0 cells in that window. The promenade is
  not there; it is in `oceanData`.
- **`city_map.jpg` is not in-game ground truth.** Plausible, but not
  re-checked here.

**Wrong:**
1. **"The ocean frame holds only the strictly-periodic natural wave
   lattices."**
   - Those lattices exist only under the legacy per-tile decode. They are
     the regular cell bytes of the deck and slabs, read one tile per char.
   - The decision test is neighbour-mask reciprocity: 1.000 for the cell
     decode at 3 blocks/row, 0.87 for the per-tile reading.
   - The review never tested the cell hypothesis for this string. It
     inherited the 2026-10-19 reading and searched everywhere except inside
     that string.
2. **"Its western half is marked 'P' solid SEA where the game draws
   planks."**
   - `P` means a solid **cell** (the codebook's no-mask full cell, as in
     the road layer's plazas), not "sea".
   - Those `P` cells are the OrnatePier slab and the PirateShip dock,
     boardwalk in both cases.
3. **"Only 5 promenade tiles ever existed as data (BoardwalkDrawing ×19,
   PierDrawing ×4 spent)."**
   - The 5 tiles are artefacts of the wrong decode. None of them is a brush
     tile under the correct one.
   - The ledger counts cannot be tile counts: 262 cells are confirmed
     independently by mask reciprocity, by building footprints and by the
     render matching the game.
   - What that ledger counts is unexplained; it may be purchases or
     inventory, not painted tiles. The 19 happens to equal the size of the
     pier walkway, but treat that as a coincidence until proven otherwise.
4. **"Client-derived ground, the same model as the N–S avenues."** No: the
   ground is saved data. The analogy to `CityTerrain.AVENUE` does not hold
   for the brushes.
5. **Option 1 (hand-table the promenade from the export)** would have
   hand-traced shapes the save already stores exactly. **Option 3**
   ("accept and document as unrecoverable") would have written down a
   false conclusion. Neither is needed.
6. **`subLandData[0]` (the 12-cell road T-fragment)** was not
   re-investigated. It is unrelated to the promenade either way.

**Root cause of the miss.** notes/01's 2026-10-19 section ("Recovering
boardwalk/pier tiles from the ocean frame") kept the legacy per-tile
reading for `oceanData`. The land layers were moved to the cell codebook
the same day, but `oceanData` was explicitly exempted (its per-tile
reciprocity 0.87 was taken as "not this codebook"). Nobody tried the
codebook at a different block width. The "five periodic lattices" were a
red flag: genuine water texture is not strictly periodic in five
interleaved residue classes, but misread structured data is. That section
is now marked **SUPERSEDED** in notes/01.

## 6. How to reproduce (for any agent)

```python
# python3 from the project root; loads the save the same way gen_map_explorer.py does
s = m.oceanData.mapData                      # 3072 chars
cells = {}
for i, ch in enumerate(s):
    if ch == 'G':
        continue
    blk, k = divmod(i, 16)
    by, bx = divmod(blk, 3)                  # 3 blocks per row
    cells[(bx * 4 + k % 4, by * 4 + k // 4)] = ch
# reciprocity: for every mask bit, the neighbour must exist and point back
# (or be 'P')
#   -> 1.000 at 3 blocks/row; 0.98 / 0.94 / 0.88 at 6 / 12 / 24
# town tile of cell (c, r) = (-48 + 4*c, -112 + 4*r)
```

`python3 tools/gen_map_explorer.py` prints
`ocean brush tiles: boardwalk 3888, pier 304 (OrnatePier footprint 108 tiles)`.

## 7. Files changed

- `tools/gen_map_explorer.py`
  - new cell decode (`_ocean_cells`), mask chains (`_mask_chains`) and the
    OrnatePier split;
  - the brush layers ship as per-tile `pts` (grid = town + (ox, oy)).
- `web/js/map-explorer-data.js`: regenerated. Only the boardwalk and pier
  layers changed; the `bridgetop`/`bridgebottom` variant entries were kept
  as shipped (the generator now prefers the baked city sprite, an
  unrelated drift).
- `web/js/terrain.js`: no ocean tiles from `oceanData`; Ocean-preset bbox
  from the sea base; `topTypeAt` returns `ocean` on open sea.
- `web/viewer/city-view-pixi.js`: per-cell brush frames, oriented draw
  order, camera-derived box map, sheet-load settle. `v=45`,
  `DIAG.ver 2026-10-28.1`.
- Cache-busters on both pages: data `v=14`, terrain `v=15`.
- Harnesses updated to the new model:
  - `smoke-pier-tiles`
  - `smoke-city-view-dom` (243 boardwalk cells incl. the SquidportEntrance
    centre; 19 pier cells; clicks an uncovered pier tile)
  - `smoke-camera` (no wave-mark tiles)
- **Passing:** all three updated harnesses, plus `check-bridges`,
  `smoke-road-lab`, `verify-riv-slab`, `smoke-calib`, `smoke-spec-view`,
  `smoke-explorer` and `smoke-map-explorer-dom`.
- **Not passing:** `smoke-explorer-dom` (the asset explorer) timed out at
  300 s. It does not load the map data or `terrain.js`, so this change did
  not cause it.
- Docs: notes/09 §12 "The data"; notes/01's 2026-10-19 section marked
  superseded; CHANGELOG `2026-10-28.1`.

## 8. Evidence (`mapdump/registration/`)

- `m4-ocean-brush-celldecode.png`: top-down decode at origin (−48, −112)
  with building footprints. Deck furniture is outlined in magenta; boats
  sit in the water around the deck.
- `m4-boardwalk-before-after.png`: Squidport before and after, with and
  without objects.
- `m4-pier-ornate.png`: OrnatePier stone walkway in the plank slab, the
  BarnacleBayMarina jetty and the PirateShip dock.
- `m4-squidport-pb-vs-ingame.png`: the in-game ground truth (pre-existing).

## 9. Open questions

- **Walkway B's type** (§3). Confirm against an in-game view of the
  OrnatePier area; the existing exports crop it out.
- **What the f13/f16 ledger counts** (BoardwalkDrawing ×19, PierDrawing
  ×4).
- **Brush state selection.** It is still art-derived: legs on edges facing
  water. Per-cell masks are now available and may be what the engine
  actually uses (notes/09 §12).
- **The Road Lab boardwalk/pier tabs** still preview one frame per tile
  diamond. That is fine for state/crop calibration, but not
  representative of the in-town scale.
