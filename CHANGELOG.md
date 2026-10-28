# Changelog

## 2026-10-28.1

- **Boardwalk and pier tiles are now on the map — the whole Squidport deck,
  the OrnatePier walkway, the PirateShip dock and the Barnacle Bay jetty.**
  Before, only 5 tiles drew and the deck under the Squidport shops clicked
  as `grass`. Cause: `oceanData` (f34) was read with the legacy one-tile-
  per-char decode as a wave-mark frame. It is the 4×4-cell codebook (3
  blocks/row, mask reciprocity 1.000, origin (−48, −112) = the land's block
  pin) and holds only the two brushes: 262 cells. Type split by mask
  connectivity: pier = the walkway chain reaching the OrnatePier footprint
  (19 cells), everything else boardwalk (243). notes/09 §12 "The data";
  notes/01's 2026-10-19 recovery section is marked superseded. Evidence:
  `mapdump/registration/m4-ocean-brush-celldecode.png`,
  `m4-boardwalk-before-after.png`, `m4-pier-ornate.png`.
  - `tools/gen_map_explorer.py`: new cell decode + split; regenerated
    `web/js/map-explorer-data.js` (only the two brush layers change; the
    `bridgetop`/`bridgebottom` variant entries were kept as shipped).
  - `web/js/terrain.js`: the ocean layer contributes no tiles (no more fake
    wave marks); the Ocean preset frames the sea base; clicks on open sea
    report `ocean`.
  - `city-view-pixi.js`: one brush frame per 4×4 CELL (the `C_Shadow`
    diamond is 512×256 px = a cell; the per-tile blit was 4× too small),
    back-to-front by oriented depth (the `tx+ty` sort striped every deck
    row with the far cells' shadows), box→tile from the live camera, and
    the ground rebuilds once the brush sheets have decoded (it used to
    rebuild before they loaded). `v=45`, `2026-10-28.1`; data `v=14`,
    terrain `v=15` on both pages.
  - Harnesses updated for the new model: `smoke-pier-tiles`,
    `smoke-city-view-dom`, `smoke-camera`.

## 2026-10-28

- **Road Lab: the pier / boardwalk tab split into two tabs — boardwalk and
  pier, each in its own context.** One tab with a type button forced the two
  brush assets to share a single view state; now each brush gets its own tab
  (`tab-bw` / `tab-pier`, `road-lab.js?v=25`), its own canvas (`cv-bw` /
  `cv-pier`) and its own independent controls — sheet zoom, water-edge
  toggles, state stepper + auto, crop overlay and calib boxes — mirroring
  the two-tab split the dirt layers got. The shared manifest
  (`assets/city/pier-tiles.json`) and the tile-space preview chain are
  unchanged; the view objects come from a `newPierView(type, cvId, pre)`
  factory bound through `bindPierView(S)` (same pattern as
  `newDirtView`/`bindDirtView`). `tools/smoke-road-lab.cjs` drives both tabs
  and gates their independence (boardwalk steppers must never move the pier
  view); `tools/smoke-pier-tiles.cjs` gates the new tab/pane/control wiring.

## 2026-10-27.9

- **Characters are clickable, and their card now shows the whole
  animation family (walks, actions, outfits) with in-world preview.**
  Three parts:
  1. *Pick fix*: in Art mode a character is a billboard but `hitTest`
     still tested the ~6 px dot box at the feet, so clicking the visible
     sprite fell through to the building below. The people pass now tests
     the drawn sprite rect — the exact rect `renderScene` blits
     (`anchor`, `w×h × scale/ART.S`, skipped under the orbit-LOD floor
     where characters are dots again).
  2. *Data*: `gen_city_sprites.py chars` gained **pass 4 (families)** —
     every pool `.bcell` whose normalized stem starts with a save name
     (or its `CHAR_ALIASES` asset stem, so Grampa owns the `abe*` cells)
     is rendered with the existing frame pipeline (64-frame thinning,
     companion prefetch batched per family pack, `img_cache` capped to
     keep RAM flat). Ownership is longest-prefix; a card shows its own
     cells plus every cell owned by a catalog name extending its own, so
     outfits live under the base character. `characters.json` → **v4**
     (`familyCells`/`familyRendered`/`unmatchedCells`); cells ship as
     lazy per-character sidecars `assets/characters/families/<cid>.json`
     so boot stays lean. First run: 13,105 owned cells → 12,473 rendered
     (404 `no-pixels`, 12 `no-frames`), 2,026 loose cells listed for
     triage, 809 sidecars, ~199k PNGs / 2.9 GB, 162,727 bcell13
     companions pulled from 197 local family packs.
  3. *UI*: new `web/viewer/char-variants-pixi.js` (companion to
     asset-variants-pixi) renders the character card's strip — grouped
     idle/walk/action/pose, one tile per cell with a canvas player
     stepping the frame PNGs on their per-frame delays (one shared rAF
     for all tiles, 150-tile cap; Homer owns 600+ cells), play/pause +
     speed, `data-tip` metadata, Asset Explorer deep link. Clicking a
     tile sets `charPreview` and the map character replays that cell
     (one pass on its delays + 1.2 s standby hold) until stopped or
     deselected. `AssetVariants` gained a `stop` export (both copies)
     and `setSel` stops all card players + clears the preview on every
     selection change. `charHtml` now lists the map asset slug.
  Viewer `v=44`, `char-variants-pixi.js v=1` (new), `asset-variants-pixi.js
  v=2`, `asset-variants.css v=13`, `DIAG.ver 2026-10-27.9`. Checks:
  `node --check` all files, a headless boot of the new module against the
  real Bart sidecar (tiles/groups/preview toggle), a manifest + 809-sidecar
  verifier (0 errors), and `smoke-city-view-dom.cjs` /
  `smoke-map-explorer-dom.cjs` fully green.

## 2026-10-27.8

- **Boardwalk / pier brush tiles now draw with the game's own art.** The two
  ocean-grid brushes were flat plank fills: they are not RoadMap tiles —
  landinfo.xml gives them PathBrush textures `boardwalktiles`
  (WaterfrontGame) / `ornatepiertiles` (SpringfieldHeights2BuildDeco) with
  SaveInfo `map="ocean"`, so the art ships as building-sprite **bsv3
  scenes**. New `tools/gen_pier_tiles.py` parses both with the shared
  `parse_bsv3` and emits `web/assets/city/pier-tiles.json` (`--evidence`
  writes `mapdump/registration/pier-<type>-states.png`); per state it stores
  the engine's block list **already in draw order** (the tile paints the
  list reversed — `C_Shadow`, listed last, goes down first and *is* the
  tile diamond). Each brush tile blits its frame through the road-sheet
  transform — anchor 0.5, rot 45°, scale matrix·SHEET/4 in the 127×66 sheet
  box, **box px = sheet px / 4**, calibrated on `C_Shadow` alone
  (`ox=−x/4, oy=−y/4`; the deck crops sit ~30 px above the diamond — an
  elevated deck, never a calibration reference). Which lower edge faces
  water picks the state (PostLeft / PostRight / PostLeftAndRight; water =
  inside the sea base with no same-layer brush tile); static frame 0, like
  the road art. The Pixi viewer gained the art (depth-sorted by `tx+ty`,
  legacy fill shrunk under the opaque shadow) and a **Pier art** toolbar
  toggle (`btn-pierart`, pref `mrsnrub.cityview.pierart`, ON by default;
  `city-view-pixi.js?v=43`). Notes: `notes/09-road-tiles.md` §12.
- **Road Lab pier / boardwalk tab** (`tab-pier`, `road-lab.js?v=24`): the
  calibration rig for the manifest — sheet with the focused state's crop
  rects numbered in engine draw order, every state blitted unclipped into
  tile space (the elevated deck must show), water-edge toggles driving the
  auto-state pick, crop-overlay and calib-box overlays, type toggle
  boardwalk/pier, state stepper + auto, sheet zoom. New
  `tools/smoke-pier-tiles.cjs` re-parses both .bsv3s as a drift guard over
  every manifest block (cell/crop/pos/matrix), gates calib, draw order and
  the `a<0` mirror case, and checks the viewer/lab/page integration;
  `tools/smoke-road-lab.cjs` boots and drives the new tab.

## 2026-10-27.7

- **Fixed: character idle animations now play once, then hold — characters
  blink every few seconds instead of fluttering.** The idle cells
  (`<name>IdleBlink` etc.) store **one pass** of the animation: their
  per-frame `delay_ms` values are the timing of that single play, which is
  how `tools/tsto2rgb` (the format's own reference writer) bakes them into
  GIF frame durations, and the client binary drives them through its
  `IdleAnimation` / `timeBetweenAnimsMin` / `timeBetweenAnimsMax`
  idle-trigger properties — the character stands on its standby frame and
  re-triggers the cell after a random gap. The viewer instead replayed the
  whole cell on a modulo loop, so a 2-frame blink cell (open 41–83 ms +
  closed 125–167 ms ≈ 0.2 s) fired ~5 times a second — and 693 of the 809
  mapped characters sit on such a cell, so the whole crowd fluttered.
  `charFrameFile` (both `web/viewer/city-view-pixi.js` and the reference
  Canvas page `web/js/city-view.js`) now plays the frames once per cycle
  and returns `fr[0]` (standby) through a per-character randomised gap of
  2–7 s (hash of the save id, which also offsets the phase so the crowd
  doesn't blink in lockstep); loops over 1.2 s ("active" idles like dances)
  additionally wait one loop-length before replaying. Measured on the live
  manifest: blink cycle 2.2–17 s (median 4.5 s), closed-eye fraction ~3 %.
  No new settings; existing toggles/knobs (Art, Anim, `?charAnimMinPx`)
  unchanged. Viewer `v=43`; `smoke-city-view-dom.cjs` all green.

## 2026-10-27.6

- **Fixed the pink/purple dirt tiles + Road Lab split into two views.**
  The `.rgb` decoder shipped in .5 read the pixels as RGB565, but the
  format (documented and implemented by `tools/extract_assets.py`, the
  tool that produced every PNG under `web/assets`) is RGBA4444: header
  `u32 flags` LE + `u16 w` + `u16 h`, then 2 bytes/px with
  `byte0=(B<<4)|A`, `byte1=(R<<4)|G`, nibbles expanded ×17 — reading that
  data as 565 mixes the B/A/R/G nibbles and renders magenta. The viewer
  loader and the lab's `decodeRgb` (renamed from `decodeRgb565`) now
  follow the oracle, take w/h from the header (the 100-tier sheet is
  1024², so the old sqrt trick silently "worked"), support the 8-bit
  RGBA payload variant, and auto-detect the header's lying premul flag
  (the dirt sheet sets flag 0x2000 yet stores `c4 > a4`, impossible for
  premultiplied data → straight alpha; visually confirmed: sandy planks
  + grass banks). Second: the Road Lab dirt tab became **two tabs** —
  "dirt road" (`DIRT`, road quadrants) and "dirt (river)" (`DIRTR`,
  river quadrants) — because the two layers are different drawers; each
  view has its own zoom/force/flip/mask/probe state and its own sheet
  button, with decoded sheets cached in `DIRT_IMGS`. The harness gained
  an oracle check against the real 25-tier file (256², 47.1 % visible,
  avg RGB 179,148,86 — a 565 read fails all three), a viewer-decoder
  drift guard, and per-view independence checks; 182 checks pass.
  Regenerated `mapdump/registration/m4-dirt-ww-vs-xmas-{slots,full}.png`
  with the correct decode. Viewer `v=42`, lab `v=23`. Notes: 09 §11.

## 2026-10-27.5

- **Dirt sheets are now season-aligned via the engine's own pack layering
  (correction to .4).** landinfo.xml settles the provenance: one static
  texture per dirt type — `<RoadMap texture="DirtRoadTileSheet.rgb"
  type="dirt" drawer="road" origin="0,-7" size="37,64">` + the
  `dirtriver`/`river` twin — unchanged from r308122 (WildWest-2016, when
  the types appeared) through today's r497432. The engine resolves that
  name from whichever installed pack ships it, and exactly two do:
  `WildWest_RiverRoadTiles` (`data/dirtroadtilesheet.rgb`, sandy — the
  permanent normal-season art in the live game) and
  `XMAS2016/2017_RiverRoadTiles_LTD` (`images/dirtroadtilesheet.png`,
  snowy — the Christmas override). My .4 "BASE art" claim (from comparing
  only the XMAS re-ships) and the interim "winter-only" read were both
  wrong; the base packs ship no dirt sheet at all. The viewer now mirrors
  the pack priority: `dirtSheetTex()` serves the XMAS PNG in winter and
  the WildWest `.rgb` — decoded client-side (RGBA4444, see .6) — every
  other season, with flat tan fills only if both fail to load. Because
  quadrant meshes bake their texture at build time, the season button now
  also runs `buildGround()` after switching — which additionally fixes a
  latent bug where the spec road quads never picked up the ice sheet when
  cycling into winter. The Road Lab dirt tab gained a **sheet** button
  cycling the two packs (`DIRT_PACKS`); the
  smoke harness serves real pack files through a synchronous `fetch`
  stub so the decoder itself is gated against the 25-tier WildWest file.
  Road Lab comments / `DIRT_ART` contract and the notes/README provenance
  text corrected; evidence: `mapdump/registration/
  m4-dirt-ww-vs-xmas-{slots,full}.png`. Notes: 09 §11.

## 2026-10-27.4

- **New toolbar button: Dirt art.** The two dirt layers finally get their
  real in-game art. `dirtroad` park footpaths (engine DIRT_ROADS = landinfo
  `dirt`, `DirtRoadDrawing`) draw as the road quadrant model, and `dirt`
  river scatter (engine DIRT = landinfo `dirtriver`, `DirtRiverDrawing`) as
  the river quadrant model — both sampling the DLC's `dirtroadtilesheet.png`
  (XMAS2017_RiverRoadTiles_LTD; season-alignment of this sheet corrected in
  2026-10-27.5). The sheet sits on
  the same lattice as roadrivertiles — boundary-ray measurements matched the
  road sheet within ±1–2 px at all 11 states, and a `.rodata` quad scan of
  `libscorpio.so` found no third UV table — so the engine's own
  `ROAD_QUADS` (0x400520) / `RIVER_QUADS` (0x3fc320) tables carry over
  unchanged; each layer probes its own saved grid for the solid-side rays.
  ON by default, persisted in `localStorage` (`mrsnrub.cityview.dirtart`);
  off = the old flat tan fills, and with the art off the legacy road-sheet
  passes / manholes behave exactly as before. The Road Lab gained a **dirt
  sheet** tab (tab 3, `v=20`) with a model button swapping the two quadrant
  halves and a `DIRT_ART` reference contract; `tools/smoke-road-lab.cjs`
  gates it including drift guards that the lab's and the viewer's
  `ROAD_QUADS` and sheet path agree. Notes: 09 §11. Evidence:
  `mapdump/registration/m4-dirt-sheet-{slots,full}.png`. Viewer `v=39`.

## 2026-10-27.3

- **Bridge ends no longer bleed over the road.** The far bridge row's end
  section reached a few px past the last raised (over-water) road cell and,
  sitting above the un-raised neighbour cell, drew over it: a green hairline
  along the cell boundary at both ends of every crossing with Bridge grass on,
  and the far row's end pier poking over the pavement with it off. The road
  cell just past each end of a crossing is now raised over the bridge layer
  too (`bridgeCells`, 15 cells; `tools/check-bridges.cjs` updated). Evidence:
  `mapdump/registration/m4-bridge-grass-seam-B.png`,
  `m4-bridge-endcell-B.png` (before | after). Viewer `v=38`.

## 2026-10-27.2

- **New toolbar button: Bridge grass.** Toggles the grass-abutment frames on
  the end section of each bridge row: `bridgetop_f2` (the `C_Grass_04`
  rock-and-grass bank) at the tail end, `f6` (the `C_Grass_03` fillet) at the
  head end, `f3` (both) on a one-cell crossing. Off by default, since the
  game's own bank crops show the plain deck. Persisted in `localStorage`
  (`mrsnrub.cityview.bridgegrass`); `__CV_BRIDGES({grassEnds})` keeps the
  button state in sync. Only the near row's grass is visible (the far row's
  lands under the raised road). Evidence: `mapdump/registration/
  m4-bridge-grass-{A,B,C}.png` (off | on, changed pixels outlined).
- **Notes and specs now describe the 2026-10-27 approach as the current one.**
  - notes/09: §6 is now the full-res UV-mesh draw (the old slot bake is a
    short history note); §10's port section is rewritten around the per-cell
    bridge rule, its game-screenshot verification and the grass toggle, with
    the 2026-10-26 composition condensed into a "History" paragraph. The
    art-periodicity paragraph no longer claims pieces overlap by one pitch.
  - notes/08 §2/§6, notes/06 (sheet-art entries), notes/README,
    web/viewer/README, the Road Lab bridge-tab header and
    planning/phase-2 M2 status all point at the new draw and bridge rule.

## 2026-10-27.1

- **Road and river tiles are sharp now — they were drawn from the half-size
  sheet and resampled twice.** The viewer loaded `roadrivertiles-50` (512²),
  but buildings come from the `-100` packs, where a resting tile is 128×64 px;
  every 2×2-tile road/river quadrant (256×128 px on screen) was therefore a
  2× upscale of a 127×66 diamond, and it was resampled twice on the way (baked
  into a sheared 127×66 canvas, then warped back by the ground matrix). The
  `-100` sheet ships with the identical layout at exactly 2×, so the viewer now
  loads it (and the `-100` ice sheet for winter) and draws each quadrant as a
  4-vertex `PIXI.Mesh` with the engine's own UV corners: one resample, ≈1:1 at
  rest zoom, exactly the engine's quad. Roads now use the real `0x400520` UV
  table (`ROAD_QUADS`) instead of the fitted lattice. Legacy road-art modes 1–3
  keep their 512² cleaned canvas, built by downscaling the hi-res sheet.
- **The thin blue lines on rivers (and grey lines on asphalt) are gone.** They
  were the flat type-colour fills: each cell's fill overhangs by BLEED and sat
  in the same container as the art, cell after cell, so every later cell's fill
  painted a 1–2 px strip over its neighbour's finished art. Fills now live in
  their own layer under all art, with no overhang where art covers the cell.
- **Bridges are built the way the game builds them: one section per road
  cell.** The game screenshot shows doubled lampposts at every section join;
  each row is separate 3-lamppost `bridgetop` sections butt-joined exactly 4
  tiles apart, one per 4×4 road cell over water. The old pass stepped
  overlapping pieces by one lamppost pitch (evenly spaced posts, five per row)
  and paired each with a fully hidden `bridgebottom`. Globe detection on the
  screenshot registered against the viewer puts all 12 lampposts at site A and
  all 12 at site B within 0.1 tile of the new rule. The row nearer the viewer
  now draws over the road art (its lampposts and rail were hidden behind the
  kerb) and the far row under it, as in the game. 14 pieces instead of 32.
  `tools/bridge-sites.py`, `tools/check-bridges.cjs`, the Road Lab bridge tab
  and its smoke checks follow the new rule; notes/09 §6 and §10.
- Evidence in `mapdump/registration/`: `m4-terrain-crisp-{before,after}.png`,
  `m4-riv-seam-{before,after}.png`, `m4-bridge-cell-A-before.png`,
  `m4-bridge-cell-{A,B,C,D}.png`.

## 2026-10-26.17

- **Bridge sections now pick themselves the way the engine does — by the ground
  under the two ends of the deck.** The viewer drew every wet section as the
  plain deep-piered `bridgetop_f4` and the bank section as the dry `f5`, which
  left each bridge's two ends blunt: the shipped art carries the abutments
  (`C_Grass_04`, a grass bank 3.7–5.7 tiles behind the piece origin at the deck's
  far end, and `C_Grass_03`, a fillet hugging the origin at the near end) inside
  the frames `f2` / `f6` / `f3`, and the binary reaches those frames with the
  tile's SOLID bit — the `bridge…[g]` name formatters at `0x1198238` are gated
  by `0x1134cf0`, so `g` = that end stands on land (notes/09 §10). The rule now
  asks the same question: the outermost wet section of each row takes `f2` where
  its tail end leaves the water, `f6` where its head end does, and `f3` when one
  section spans the whole band; interior and bank sections keep the plain deck
  (grass there would sit in the middle of the road, and the carriageway art
  covers that deck anyway). Each row of the three river crossings therefore
  reads `f2 · f4 · f4 · f6 · f5` along the deck — site B, being mirrored, is
  `f5 · f6 · f4 · f4 · f2` — with the positions themselves unchanged. The bank
  ends are the one place this is grammar-faithful rather than export-faithful:
  the export's own bank crops (`m4-bridge-A-{near,far}-bank.png`) show the
  balustrade simply stopping at the shore, so `__CV_BRIDGES({grassEnds: false})`
  or `tools/bridge-sites.py --no-grass` reproduces the export reading, and both
  are drift-guarded by `tools/check-bridges.cjs` and the Road Lab smoke harness.
- **The inlet crossing by the circus is set exactly on the water, and it is now
  one complete bridge.** Its single section per row used to be pinned to the
  nearest lamppost-lattice step (origin 250.86), which left its deck centre at
  253.25 — three quarters of a tile west of the 4-tile inlet's middle — and both
  of its body ends (249.89 / 256.60) sitting on road tiles. It is now placed
  with its deck centre on tile 254.0, the middle of the 252–256 band (origin
  251.62), and because both ends are on land the engine's rule makes it
  `bridgetop_f3`: the deck with the grass bank at one end and the fillet at the
  other, which is what makes it read as a bridge instead of a deck floating in
  the water. Sites A/B/D keep their export-validated anchors; only the frames at
  the ends changed. Evidence: `mapdump/registration/m4-siteC-rule-f3-crop.png`
  (the composite at the inlet) alongside `m4-siteC-export.png`,
  `m4-siteC-inlet.png` and `m4-siteC-arch.png` (the export alone, and the two
  pieces of stone that had been mistaken for the game's bridge there — they
  project to rule tiles (225, 65) and (234.6, 58.8), not to this crossing).
- **Two new evidence tools, and the frame grammar is now drawn rather than
  described.** `tools/bridge-grass-census.py` composes every `bridgetop` /
  `bridgebottom` frame from the bsv3 block lists with its instance anchor
  marked, next to the two grass cells on their own
  (`mapdump/registration/m4-bridge-frames.png`, `m4-bridge-grass-match.png`,
  `m4-road-cell-census.png`), and confirms the abutment art ships *only* inside
  `bridgetop` — the best masked match for either grass cell anywhere in the
  ground sheet is 0.169 / 0.507. `tools/bridge-water-check.py` checks the rule's
  own coordinate frame without any bridge art in the loop: it rasterises each
  tile's projected diamond over the export, classifies it water / asphalt /
  grass, and prints where that disagrees with the save's road/river/ocean
  layers, so a mis-registered site shows up as a block of `X` that walks off in
  one direction. Sites A and B agree on 61 % of their classifiable tiles (all
  disagreements are buildings or road-over-water); **site C agrees on 48 %** —
  the dragon's art covers the inlet and rows 52–53 read as road where the save
  has river — which is written into notes/09 §10 as the reason site C's frame is
  the least trustworthy of the four.
- **Road Lab and the harnesses follow the new frames.** The Bridges tab's
  `BRIDGE_REF` snapshot and `BRIDGE_ART`/`BRIDGE_IMGS` carry `f2`, `f3` and `f6`
  with their manifest anchors, `tools/check-bridges.cjs` expects the new per-row
  frame lists, and `tools/smoke-road-lab.cjs` gained two checks — that a row
  carries the grass abutment at both bank ends with the plain deck between, and
  that the inlet composites one centred `f3` per row. Cache-busters:
  `city-view-pixi.js?v=35`, `road-lab.js?v=19`.

## 2026-10-26.16

- **The inlet by the circus is bridged with a single section per row.** The
  east–west road at rows 48–51 ends on a 4-tile-wide reach of the river at cols
  252–255, and the viewer drew it as a plain road tile over water: the crossing
  was being thrown out by `BRIDGE_MIN_SPAN = 5`, a threshold that existed to
  suppress seven *bogus* candidates (the same crossing read on the other axis,
  where the "corridor" is only the crossing patch itself). Those seven are now
  rejected for the right reason — **the road must reach both banks**, i.e. the
  fully-road run has to extend past the water band at both ends — so the span
  gate could drop to 4 and the real inlet gets a bridge. Because a band as wide
  as the road is an inlet mouth rather than a river the game bridged end to end,
  such a band gets **one section per row instead of the full five**: the section
  whose deck centre stands in the middle of the water (same index in both rows,
  so the pair stays in phase). Site C therefore paints one deep-piered
  `bridgetop_f4` + `bridgebottom_f0` pair on each side of the carriageway,
  mirrored, at along 250.86, rows 48.10 / 52.60 — 32 pieces / 64 sprites town-
  wide, up from 30 / 60. **This crossing is decoration, not reproduction:** the
  export shows no bridge art there (confirmed with the building layer off, so
  `DragonOfSpringfieldia` is not hiding it — the earlier note claiming otherwise
  was wrong, and the "bridge stone" pixels the gate picked up are the dragon's
  own sage scales). The tool now says so in its own output
  (`... game: bare`), and `--min-span 5` / `__CV_BRIDGES({minSpan: 5})` puts it
  back the way the game has it. Files:
  `web/viewer/city-view-pixi.js` (`BRIDGE_MIN_SPAN`, new `BRIDGE_FULL_SPAN`,
  bank test in `deriveBridges`, single-section clamp in `bridgeRun`, probe
  exposes `fullSpan`), `tools/bridge-sites.py` (same rule, `--min-span` default
  now 4, gate labels the inlet), `tools/check-bridges.cjs` (site C rows,
  32/64, 7 crossing cells, along-window so B and C — both mirrored +x crossings
  on rows 48.10/52.60 — stop matching each other),
  `tools/smoke-road-lab.cjs` (per-site button counts instead of a hard-coded
  20, new inlet check), `web/viewer/road-lab.js` (`BRIDGE_REF` +site C, 32
  pieces) and `tools/render-bridge.py` (`CROSS['C']`, so `--hyp rule` works for
  the inlet too). Cache-busters `city-view-pixi.js?v=34`, `road-lab.js?v=18`.
  Harnesses green: `node tools/check-bridges.cjs` (32 pieces / 64 sprites, 4
  sites, 7/7 crossing cells), `node tools/smoke-road-lab.cjs` (all checks incl.
  the `BRIDGE_REF` drift guard), `python3 tools/bridge-sites.py --check
  --place`. Evidence in `mapdump/registration/`: `m4-bridge-view-C.png`,
  `m4-bridge-view-C-road.png` (the viewer's own derive with the shipped frames
  over the export, then with the corridor's road pixels stamped back),
  `m4-bridge-rule-C.png`, and `m4-bridge-C-{wide,tight}.png` (the export alone,
  which is what shows the game painting no bridge there).

## 2026-10-26.15

- **Road bridges re-derived: the deck is stepped one lamppost per piece, not
  butt-joined at the piece width.** Reading the `bridgetop`/`bridgebottom` bsv3
  blocks and the full-res export together showed the old model was wrong in
  three ways at once. (1) *Pitch*: every bridge cell is periodic with its own
  period vector (110, 57) art px — shifting a cell by that amount leaves
  53-61 % of the mutually-opaque pixels agreeing within 14/255 (70-72 % within
  20, mean abs diff 14-20), and the lamppost globes sit on exactly that
  lattice, so the engine steps **one piece per globe pitch (110/64 = 1.71875
  tiles) and overlaps them**, where the viewer had been joining pieces at 4.05
  tiles. (2) *The `bridgebottom` half is not a flat deck* — its cells lie
  entirely above their origin, so it is the balustrade wall + lampposts sharing
  ONE origin with the deck piece, which is why the game shows only the wall
  above the road and only the piers below it. (3) *The two rows are not a
  symmetric pair*: they are 4.5 tiles apart on one lattice and IN PHASE, at
  −0.85 / +3.65 tiles off a +y corridor's west edge and +0.10 / +4.60 for a
  mirrored +x corridor, and the road's own art hides each row's inner half.
  Each section now picks the deep-piered `bridgetop_f4` where its deck centre
  stands in the water and the abutment-length `bridgetop_f5` where it does not
  (four + one at all three crossings). The crossings selected are unchanged:
  still exactly three (A, B, D), still 30 pieces.
  `web/viewer/city-view-pixi.js` (constants + `bridgeRun`, pieces sorted by
  `x + y`), `web/viewer/road-lab.js` (`BRIDGE_REF` regenerated, `BRIDGE_FIT`
  emptied — the fit now lives in the rule) and the tool mirrors
  (`tools/bridge-sites.py`, `tools/score-bridge.py`, `tools/fit-bridge.py`,
  `tools/render-bridge.py`) were rewritten to match. New:
  `python3 tools/fit-bridge.py --period` prints the periodicity proof, and
  `tools/render-bridge.py A --hyp rule` composites the rule's own piece list
  next to the game's crop without a pasted `--place` string. The scorer also
  lost a bias that had made the first calibration useless: the road's lavender
  paving (206,202,255) and kerb grey (173,170,189) sat in its blame list,
  charging every legitimate balustrade pixel the carriageway covers as a
  mismatch; they are a neutral class now. Cache-busters
  `city-view-pixi.js?v=33`, `road-lab.js?v=17`. Harnesses green
  (`node tools/check-bridges.cjs` — 30 pieces / 60 emitted sprites, per-row
  table; `node tools/smoke-road-lab.cjs` — all checks incl. the `BRIDGE_REF`
  drift guard; `python3 tools/bridge-sites.py --check --place`). Evidence:
  `mapdump/registration/m4-bridge-view-{A,B,D}.png` (the viewer's own derive
  with the shipped frames over the export), `…-road.png` (same, with the
  corridor's road pixels pasted back over the deck), `…-bare.png` (the export
  alone), `m4-bridge-rule-{A,B,D}.png` (game vs composite). `notes/09-road-tiles.md`
  §10 rewritten to this model, including a warning that the `bridge{se,sw}…`
  `.rodata` name family is the monorail viaduct's grammar, not the road bridge's.

## 2026-10-26.14

- **Bridge tab: per-span along/base steppers + export-fitted preset.** The
  user's four crossing-A defects (east row's base not occluded by the road,
  west row's right/left piers cut off, spans 1/2 overlapping in the centre)
  were reproduced off-browser with a PIL re-implementation of the lab's exact
  math (`/tmp/opencode/bridge-lab-repro.py`): the PNG pieces blit pixel-
  identically to the bsv3 `draw_frame` reference, so the defect is in the
  calibrated **placement**, not the art or the lab plumbing. Per-piece
  `tools/score-bridge.py` sweeps against the export say the whole crossing
  sits 0.4–0.8 tiles too far east and the visible west row's BASE wants
  ~0.4 tiles west of its deck (whole-set score 0.269 → 0.391, "bad" pixels
  648 → 338). The tab gained `along` (per-span, along the road) and `base Δ`
  (base piece only, cross-axis) steppers plus an **apply export fit** button
  (`BRIDGE_FIT`, site A) so the fit can be eye-tested span-by-span; state is
  `segOff[i]` + `segBase[i]`. Harness grew to 133 checks (along/base stepper
  independence, fit preset), all green. Cache-buster `road-lab.js?v=16`.
  Evidence: `mapdump/registration/m4-bridge-fit-A-overlay.png` (fitted pieces
  over the export), `m4-bridge-lab-rule-vs-fitted.png`,
  `m4-bridge-lab-rule.png` / `m4-bridge-lab-fitted.png`,
  `m4-bridge-game-A-zoom.png`.

## 2026-10-26.13

- **Road Lab spans are now independently moveable and toggleable.** The
  bridge tab's steppers/toggles were row-coupled (◀/▶ stepped one of the two
  deck rows, chips hid whole segments through a row-visibility list). Each of
  the 4 spans per crossing now has its own offset and visibility: the chip
  row gained a per-span **select** button (highlights the selection; the
  ◀/▶ steppers then nudge that span 0.05 tiles across the road) and a
  per-span **show** toggle; the readout shows `span i/4 Δ(x,y)`. State
  changed from `rowOff`/`rowVis` to `segOff[i]`/`pieceVis[i]` + `segSel`, and
  `bridgePieceRects` reads the span's own offset. The harness adds
  independence checks (stepping span 3 moves only span 3's rects; select
  highlights; reset zeroes all spans) — 129 checks, all green. Cache-buster
  `road-lab.js?v=15`.

## 2026-10-26.12

- **Road Lab gained a Bridges tab** (`web/viewer/road-lab.html`, cache-buster
  `road-lab.js?v=11`) to debug the remaining viewer bridge issue (east rows
  correct, west rows lost their deck top) outside the live viewer. The tab
  composites one calibrated crossing — water band from the river slots, the
  real `bridgetop_f0/f5` + `bridgebottom_f0/f1` art with the manifest anchors,
  and the corridor's road cells drawn per the game's order — and exposes the
  model as controls: crossing picker (A/D/B), zoom, per-row 0.05-tile nudges,
  per-segment visibility chips, deck/base/road draw-order toggle (`rail over
  road` moves the road pass under the pieces), tile grid, and anchor crosshairs
  (bases cyan, decks orange). The 12-segment `BRIDGE_REF` table is a snapshot
  of the viewer's `deriveBridges()` output; the smoke harness
  (`tools/smoke-road-lab.cjs`) now re-runs the viewer's derive (same extraction
  as `tools/check-bridges.cjs`) and fails if the lab table ever drifts, plus
  19 checks on the composite itself (anchors land exactly on the segment tile
  point, row grouping, toggle/nudge/chip behaviour, label layout). The shim
  also gained `measureText` and fake natural sizes for the four bridge PNGs.
- **Fixed: bridge art path in the lab.** The tab's loader asked for
  `assets/city/*.png` (no `../`), so the page in `web/viewer/` reported
  "bridge art failed to load"; the smoke harness now asserts the `../` prefix
  so the path can't regress, and the cache-buster moved to `v=12`.
- **Bridge tab now shares the viewer's ground projection.** The first cut
  drew the water/road cells as flat axis-aligned quads under a paper-grid —
  "2D flat road tiles with isometric bridge tiles". The tab now loads
  `web/js/camera.js` and draws everything through the same model as the
  viewer: `CAM.tileAffine` (canonical 2:1 oblique) as the canvas base CTM for
  the ground pass (water cells, tile grid, and the road cells in true TILE
  space — `groundC`/`raisedG` twins), with the bridge pieces as screen-space
  billboards placed from the same `A` (`bridgeView()` returns it). `blitQuad`
  grew a base-matrix mode (`LAB_BASE_MTX`) so the quadrant CTMs compose onto
  the projection instead of resetting to identity — the sheet/water tabs are
  unaffected. Zoom is now the camera's px/unit (0.25–3, readout in px/unit).
- **Fixed: road cells were mis-drawn beside the bridges.** An engine road
  cell is a 4×4-tile block drawn as four quadrant quads, but the tab blitted
  each crossing cell into a 1-tile square using the tuning tab's arbitrary
  pass mask — the road looked like confetti beside the decks. Crossing cells
  (and one land block each side for continuity) now draw as 4-tile blocks
  with the crossing's own road-direction pass (+ land-context blocks extend
  the study window to 20×20 tiles). The harness additionally asserts the road
  pass runs real quadrant CTMs, and the cache-buster is now `v=13`.

## 2026-10-26.11

- **Bridges were invisible: fixed the container coordinate space.** The `.10`
  change parented the bridge sprites inside `featC` — but `featC` lives under
  the projected ground container, where children speak TILE space (the
  container chain owns the oblique projection), while `bridgePiece` still
  positioned them with the screen-space affine: every piece landed miles
  off-screen and no bridge rendered at all (user report: "now none of the
  bridges are showing at all!"). The deck art now emits into `bridgeG`, a
  screen-space stage container drawn right after the ground (so bridges sit
  over the water art, under the buildings), and the six crossing road cells
  are REPARENTED from `featC` into `raisedG`, a tile-space twin of `groundC`
  (same oblique matrix) drawn right after the bridges — reproducing the
  game's water → bridge → road order with correct geometry. `tools/check-
  bridges.cjs` gained a render-pass smoke that runs the real `renderBridges`
  against stubs and fails if any piece does not emit at a finite on-screen
  rect — the exact gap that let the invisible pass through every
  derive-only check. Viewer cache-buster `city-view-pixi.js?v=32`,
  `DIAG.ver = 2026-10-26.11`.

## 2026-10-26.10

- **Bridges now sit UNDER the road art.** The `.9` fix moved the east row a
  tile outward and added a third segment per row; the eye test rejected both
  ("the bridge extends way too far to the north… still overlapping in the
  middle… the east side bridge has just been moved further away — it was in
  the right spot before, but the road should have occluded the bottom of the
  bridge, instead of the other way around"). The missing piece of the model
  was STACKING, not placement: the game draws the corridor's own road cells
  OVER the bridge art, which hides each row's inner balustrade and leaves
  only the outer rail visible. `deriveBridges()` therefore reverts to the
  symmetric rule (rows at `cx-0.45` / `cx+4.45`, `cy+4.45` / `cy-0.45`; A
  155.55/160.45, D 223.55/228.45, B 52.45/47.55; 12 pieces again), and the
  six crossing road cells derived with the segments (`bridgeCells`:
  (156,16) (156,20), (168,48) (172,48), (224,64) (224,68)) must paint over
  the deck art, reproducing the game's water → bridge → road order (the
  first container attempt under `.10` regressed — see `.11`).
  `tools/bridge-sites.py` mirrors the rule and prints the same 12
  anchors; `tools/check-bridges.cjs` asserts the six rows at 2/2 plus the
  6-cell crossing set; the evidence overlays
  `mapdump/registration/m4-bridge-bothrows-{A,B,D}.png` are regenerated as
  export-vs-simulation pairs (composite + the road cells' own pixels pasted
  back over the deck). Viewer cache-buster `city-view-pixi.js?v=31`,
  `DIAG.ver = 2026-10-26.10`.

## 2026-10-26.9

- **Bridge rows now sit where the game's rails actually are.** The symmetric
  second row from `.8` was wrong in three ways at the crossing by (157, 16)
  (user report: "the east side bridges overlay the road", "the west side
  bridge is cut off on the north side", "the components overlap a bit").
  Per-tile class mapping of the export shows the game's rails occupy
  corridor columns `cx-3..cx-1` (west) and `cx+3..cx+4` (east) — the deck is
  NOT centred between mirror-symmetric rows: because a plain piece paints its
  balustrade WEST of its anchor, the far row's anchor must sit a full tile
  further out. `deriveBridges()` now places the near row 0.45 tiles outside
  the corridor (`BRIDGE_NEAR`) and the far row 1.45 tiles outside
  (`BRIDGE_FAR`) — A east 161.45, D east 229.45, B north 46.55 — and each row
  carries one extra segment (`round(span/4) + 1`) so the last arch lands on
  the near shore instead of stopping at the water's edge; that also removes
  the doubled-up components inside the carriageway the east row used to cover.
  12 pieces become 18 (3 crossings x 3 segments x 2 rows).
  `tools/bridge-sites.py` mirrors the rule, `tools/check-bridges.cjs` asserts
  all six rows at 3/3, and the evidence overlays
  `mapdump/registration/m4-bridge-bothrows-{A,B,D}.png` are regenerated.
  Viewer cache-buster `city-view-pixi.js?v=30`, `DIAG.ver = 2026-10-26.9`.

## 2026-10-26.8

- **Bridges now deck BOTH sides of the road.** The first bridge pass drew one
  row of deck pieces per crossing, so a bridge read as styled on one side and
  bare on the other (user report: the crossing at town tile (174, 50) showed
  bridge stone only on its south side). The game actually stacks a deck row on
  each corridor edge, 0.45 tiles outside the carriageway: the same segments,
  same frames, same pairing and mirroring, just re-anchored at `cx + 4.45`
  (east row of a N-S road) / `cy - 0.45` (north row of an E-W road). Fitted
  per site against the full-res export with an occlusion-robust class-match —
  A east peaks at 160.45, D east at 228.4, B north at 47.5 — and the plain
  shipped frames beat every alternative (mirrored pieces, the unbaked tall
  frames, swapped far/near pairing), so no art was re-baked. `deriveBridges()`
  in `web/viewer/city-view-pixi.js` now emits 12 pieces (3 crossings x 2
  segments x 2 rows); `tools/bridge-sites.py` mirrors the rule,
  `tools/check-bridges.cjs` asserts all six rows, and the evidence overlays
  are in `mapdump/registration/m4-bridge-secondrow-{A,B,D}.png`.
  Viewer cache-buster `city-view-pixi.js?v=29`, `DIAG.ver = 2026-10-26.8`.

## 2026-10-26.7

- **Roads that cross the river now get the game's own bridge art.** The City
  View painted plain asphalt over every river crossing; the full game stacks
  its `bridgetop`/`bridgebottom` deck pieces there instead. Nothing in the save
  says so (no bridge flag, no instance rows — the engine derives the pieces
  from road/water tile probes, notes/09 §10), so the viewer now derives them
  the same
  way from the saved ground layers. New in `web/viewer/city-view-pixi.js`: a
  **road bridges** pass, drawn under the buildings from the same sprite pool,
  plus a **Road bridges** legend toggle (`localStorage`
  `mrsnrub.cityview.bridges`, ships ON) and a `__CV_BRIDGES()` probe
  (`{on:false}` hides the pass, `{minSpan:4}` also bridges the 4-wide inlet,
  `{recalc:true}` re-derives). The rule, measured against the full-res export
  and mirrored in `tools/bridge-sites.py`: a road is one cell of the save's 4×4
  lattice wide (columns `cx..cx+3`, `cx % 4 == 0`, or rows `cy..cy+3`), the
  water band is the corridor rows/columns the water layer covers across the
  **full 4-tile corridor** — water *under* the deck, which is what drops the
  town's shoreline quays (179 road tiles touch water, 112 of them sit on it,
  11 stretches fill a corridor) — and the band must be **wider than the road
  itself**, ≥ 5 tiles. That drops the eight 4-wide leftovers: seven are one
  real crossing read on the other axis, the eighth a road end sitting on a
  4-wide inlet. One ~4-tile segment is then anchored 1.1 tiles past the far
  water edge and stepped back by 4.05 — the far segment (south end of a N-S
  road, east end of an E-W road) is the flat pair, the rest the arch pair, and
  E-W roads use the mirrored instance. This save yields the three crossings
  the export shows: cols 156–159 × rows 16–23, rows 48–51 × cols 168–175,
  cols 224–227 × rows 64–71.
- **`gen_city_sprites.py bridges` bakes the deck pieces.** `bridgetop` and
  `bridgebottom` are never building instances, so `compute_required()` never
  asked for them and `sprites` only ever wrote their static frame. The new
  subcommand composites the four frames the rule stacks as their own manifest
  entries — `bridgetop_f0` (`C_BridgeTop_05`), `bridgetop_f5`
  (`C_BridgeTop_09`), `bridgebottom_f0` (`C_BridgeBottom_02`),
  `bridgebottom_f1` (`C_BridgeBottom_03`) — keeping the raw bsv3 block-origin
  anchors the rule was fitted with (no degenerate-pivot re-pin, no xml
  override). The viewer fetches the manifest through a new `MANIFEST_V`
  buster rather than bumping `ASSET_V`, so four new entries don't re-download
  12k sprite PNGs.
- **Three calibration tools, and a headless check for the pass.**
  `tools/bridge-sites.py` derives the crossings from the save and prints the
  `--place` strings the other tools eat; `--check` gates every candidate on the
  export actually showing bridge stone/lamp pixels in that crossing's own
  footprint (11 band candidates → 3, exactly the eye-tested set).
  `tools/score-bridge.py`
  composites a whole crossing onto the export and scores every opaque art pixel
  (`hit`/`pos`/`bad`; the shipped rule scores 0.500 / 0.482 / 0.393 at the
  three sites, and `--sweep` is what pinned the E-W anchors), and
  `tools/render-bridge.py` puts the composite beside the game's crop for the
  eye test. `node tools/check-bridges.cjs` boots the viewer's own bridge source
  against the shipped data and asserts the six segments and their anchors, so
  the JS pass cannot drift from the calibrated Python. Evidence (side-by-side
  composites at A/B/D, the baked pieces, and the occluded rejected candidate):
  `mapdump/registration/m4-bridge-place-{A,B,D}.png`,
  `m4-bridge-pieces-baked.png`, `m4-bridge-look-nosite2.png`.
- **Roads that only run beside the river keep their plain asphalt — measured.**
  The other half of the ask ("or goes next to water") needed evidence, not a
  guess: `tools/bridge-touch.py` samples the export inside every road tile and
  counts the bridge-stone / bridge-lamp colours for the 16 road cells that have
  a water cell as a ±4 neighbour, against the three bridged corridors and 24
  road cells with no water within six tiles. The crossings score 6–11 % stone,
  the shore roads 0 % — except the four cells that abut the crossings, whose
  stone is the deck art's own one-tile overhang (the viewer gets that for free
  by drawing the game's PNGs at the fitted anchors). So there is no separate
  "beside water" treatment to port; the abutment tufts belong to the deck ends
  (notes/09 §10).

## 2026-10-26.6

- **Pond interiors no longer show the land speck: open water now samples the
  engine's own slab tile.** Following today's RE verdict (the speck is authentic
  `RiverDrawer` output), the City View takes the option you picked: in
  `web/viewer/city-view-pixi.js` an all-open quadrant — both edges it tests are
  open — samples **state 1**, the engine's 100%-water slab, instead of the
  both-pass tiles 2/6/9, but only when its **diagonal** neighbour is a river cell
  that is not solid and connects back toward us on *both* of its faces
  (`E1 W2 N4 S8`). That mirrors the engine's own slab rule (it picks state 1 when
  the diagonal is *solid*) with solidity inverted, so the bleed corner is drawn
  exactly when the cell that owns it is land: inside a pond it is gone, along a
  shore or next to a solid river cell the bank art stays byte-for-byte as the
  engine picks it. No pixel is invented — only which shipped slot is sampled.
  New code: `rivDiagOpen()` plus four guards set in `buildRivCell`; banked
  quadrants, the `'P'` slab path, and Road Lab are untouched. Measured on the
  reported case (16 fully surrounded cells of a 6×6 all-open pond): land pixels
  **1600 → 0**, water tint spread 9.7/16.3/32.0 → 0.0/0.0/0.0. One thing to know
  before judging it: state 1 is a *flat* fill (3 unique colours, sd 0.0) where
  2/6/9 carry real texture (sd 2.4–4.5), so a big pond is now uniformly blue and
  the only texture left is the shoreline ring — that flat look is what the engine
  itself paints when a quadrant is buried in solid cells. Evidence:
  `mapdump/registration/m4-rivpond-slab.png` and `m4-rivpond-guard.png` (the same
  pond with one solid river cell, where the four quadrants facing it keep their
  corner art), regenerated by `tools/river_bleed_check.py`. Harness:
  `tools/verify-riv-slab.cjs` (4220 checks) tests the shipped picks by
  extracting `rivStates` / `rivDiagOpen` / `rivFlip` **and `buildRivCell`'s own
  neighbour probe** out of the viewer, and its `--picks=K` mode feeds the
  renders. Cache-buster `city-view-pixi.js?v=26`; docs in
  `notes/09-road-tiles.md` §9 ("The shipped remedy").

## 2026-10-26.5

- **RE settled the pond speck: the shipped game draws it too — our port is
  faithful.** Finished the `notes/09` §9 TODO by disassembling **and emulating**
  the RiverDrawer quad selector (`0x1099f8c`): the road work's ARM64 interpreter
  runs the real 721 instructions and a concolic walker replays each run once per
  unanswered world question, so the whole decision tree is measured, not
  guessed. Three results. (1) `RIV_FAM` is **exactly** the engine's rule for this
  save's world (no solid river cells): 64/64 quadrant × nibble matches, and the
  selector never returns NULL. (2) The pure open-water slab (state 1) is *not*
  the open-water tile — the engine picks it only when the quadrant's two edge
  neighbours **and its diagonal** are all solid (nw `N+W+NW`, ne `N+E+NE`,
  ws `W+S+SW`, es `E+S+SE`); the ne quadrant also falls back to state 4 when only
  its diagonal is solid. Both rules are inert while no river cell is solid, so
  nothing ships, but `notes/09` §9 now records them as what a fuller port needs.
  (3) Nothing in the engine can hide the bleed: the shared emitter
  (`0x12095e8`) tiles the quadrants at `+2S` with a one-sided seam epsilon
  `*(0x1ac0260)/8`, all four vertices are coplanar `y = 0` in a 20-byte
  `(x, y, z, u, v)` format with **no vertex alpha**, `roadtilesheet.png` is
  α = 255 on every pixel, and the only later water layer (WaterAnims, 75% of
  pixels α < 8) is a sparse shimmer. So `mapdump/registration/m4-rivbleed-replica.png`
  is what `RiverDrawer` itself emits for a pond interior; removing the speck is a
  viewer choice, not a bug fix. Code unchanged (`?v=25` stays); docs:
  `notes/09-road-tiles.md` §9.

## 2026-10-26.4

- **Reverted: the pond "land speck" scrub — the City View is back to raw
  engine bakes.** The artifact you reported (a piece of land at the centre of
  four water tiles in a large pond) is real and is now measured: three of the
  11 river slots — the *all edges open* tiles states 2 (nw/es), 6 (ne) and 9
  (ws), which are what an open pond is paved with — keep a chunk of the
  *neighbouring* lattice cell's art inside the corner of their UV quad (grass +
  kerb, dirt + kerb, grass; 477/946+satellites/284 px at the 127×66 bake
  size). An earlier attempt today erased those pixels and recoloured them with
  the tile's own median water blue; numerically clean, but it **left its own
  visible smudge**, so it has been reverted — `buildRivSlots` now stores
  exactly what `bakeSlot` samples from `roadtilesheet.png`, with no invented
  pixels. No art is generated or modified anywhere in the viewer. New
  diagnostic (measurement + replica only, no viewer coupling):
  **`tools/river_bleed_check.py`** parses `RIVER_QUADS` back out of the viewer,
  cross-reads the engine's table (0.005 px), reports the bleed pieces per slot,
  and writes `mapdump/registration/m4-rivbleed-replica.png` (the all-open pond
  block, 3.19% land px) and `m4-rivbleed-worst.png`; `--preview-scrub` renders
  the reverted approach for comparison. `notes/09-road-tiles.md` §9 records the
  measurements, the five possible reasons the engine doesn't show this, and the
  RE TODO (cheapest probe: does a fully-open quadrant actually pick the pure
  open-water slab, state 1, rather than 2/6/9?). Cache-buster is now
  `city-view-pixi.js?v=25`.

## 2026-10-26.3

- **River cells in the PixiJS City View now draw with the engine's own
  RiverDrawer art** — a new **Water art** toolbar button (`btn-waterart`,
  persisted as `mrsnrub.cityview.waterart`, ships ON; off = the old flat blue
  fills). Rivers are built the same engine-true way the Road-art spec mode
  builds streets (RiverDrawer's build wrapper reaches RoadDrawer's draw body,
  so the four-quadrant-quad emitter applies verbatim): the saved river nibble
  (E=1 W=2 N=4 S=8) plus the neighbour-solid probe picks one of 11 states per
  quadrant from the river family table — the road table with entries 0↔1
  exchanged, so solid 'P' cells land on the open-water slab — and each quad
  samples its own UV parallelogram from the engine's measured float table
  (`.rodata 0x3fc320`) on the same `roadtilesheet.png`, using the 13 water
  cells the road census left unused. Bakes carry both orientations, the
  flipped one being the anti-diagonal reflection verified in the lab. Details
  in `notes/09-road-tiles.md` §9. Out of scope on purpose: the ocean base
  stays a flat fill (the engine has no sea drawer — that is base terrain) and
  the 3 s WaterAnims shimmer is not ported until its cell bindings are
  proven; the ice pack's river UVs were never researched, so winter keeps
  base-art rivers under icy roads. Legacy 1-tile river records and cells whose
  bakes are missing (e.g. the sheet could not load) keep the flat fill.

## 2026-10-26.2

- **Fixed: flipped quadrant quads in the Road Lab water tab sampled the wrong
  sheet region** — every engine-flipped quadrant (the ES quadrant of every
  cell, plus NE when only N is open and WS when only W is open) drew a black
  triangle or a bank on the wrong edge; e.g. the isolated pool's bottom-right
  quad was black junk instead of the shore corner's bank. Two compounding
  bugs, both in `blitQuad`: the flip CTM negated the wrong matrix entries (so
  the world square no longer mapped onto the UV parallelogram and the sample
  bled into the black sheet-cell corners), and the flip was modelled as a
  horizontal mirror at all. The engine's flip is the road emitter's
  **anti-diagonal reflection** — world `(u,v)` samples `M(1−v,1−u)`, the
  flipped bake `O=R, E=−(T−L), S=−(B−L)` of `notes/09` §6 step 3 — and this
  is now *re-measured on the water art itself*, not just inherited by code
  identity: flipped state 0 banks E+S, state 7 banks E, state 10 banks S,
  while a u-mirror leaves the opposite edge open water. The flip CTM is now a
  separate, exported `uvCTM(st, x0, y0, size, flip)`;
  `tools/smoke-road-lab.cjs` grew 3 new checks asserting the corner contract
  for both orientations (104 → 107, all passing), and
  `tools/gen-water-evidence.py`'s PIL replica got the same anti-diagonal fix
  (its `bk[:, ::-1]` had the identical bug — the earlier
  `m4-riv-cells.png` had the same wrong tiles). `notes/09` §9 moves the flip
  byte from the unproven list to verified. Evidence regenerated;
  cache-buster `road-lab.js?v=10`.

## 2026-10-26

- **Road Lab gained a water / river tab — the RE'd `RiverDrawer` art, "pretend
  they are roads"** — the 13 unused water cells in `roadtilesheet.png` (the
  census lead in `notes/09` §5) are now decoded: `RiverDrawer` is RoadDrawer's
  own subclass and its build wrapper `0x1099f20` loads its selector `0x1099f8c`
  then branches into the *same* draw body roads use, so the road cell model
  (4 quadrant quads, one UV parallelogram each, ES quadrant forces the mirror
  byte) applies verbatim. Its UV table is `.rodata 0x3fc320` (11 entries,
  T,R,L,B, ×512 = sheet px) and lands on the 13 unused cells' lattice — the
  same lattice as roads, on the same sheet. The quadrant family table is the
  road table with entries 0↔1 exchanged (1 = open-water slab, 0 = W+N shore
  corner), verified by selector reference-order scan and by pixel-measured bank
  art (the bank always sits on the closed edge, exactly like the road kerb).
  The new tab mirrors every sheet-inspector control with its own state (`WATER`
  object, own pack/zoom/force/mask/probe/flip/raw/grid) so road and water can
  be compared side by side; blits use the measured quads through an affine
  canvas CTM, and a reference block (`WATER_ENGINE`) emits the contract. The
  wave overlay is shown as evidence only: it is a **separate** asset
  (WaterAnims `wateranimations.png`/`.bsv3`, a BGSprite the drawer keeps at
  `[drawer+0x80]`, 3 s `rand()` re-pick) and which two cells those frames are
  is labelled UNPROVEN, as is the river flip byte (inherited by code identity).
  New files: `tools/gen-water-evidence.py` (re-runnable PIL evidence generator;
  cross-checks the quads against the binary — max deviation 0.005 px) writing
  `mapdump/registration/m4-riv-sheet-lattice.png`, `m4-riv-states.png`,
  `m4-riv-cells.png`, `m4-riv-wave-atlas.png`, `m4-riv-facts.txt`.
  `tools/smoke-road-lab.cjs` grew 67 → 104 checks (water defaults, parallelogram
  exactness, family picks, flips, affine-warp, clamps, tab switching, reference
  contract, label collisions) — all pass. Docs: `notes/09-road-tiles.md` gains
  §9 (river slots) and `notes/README.md` item 10 points at it. The Pixi viewer
  still paints water as flat fills; porting the spec-slot machinery to it is
  the next step after review.

## 2026-10-25.35

- **Docs: new `notes/09-road-tiles.md` — everything learned about the road tile
  art** — the art-side companion to `notes/08-road-drawer-re.md` (which owns the
  engine/selector RE), written after the spec-mode fix was confirmed. It records:
  asset provenance (`roadrivertiles-50/images/roadtilesheet.png`, the `-25/-50/-100`
  tiers, the XMAS2017/2018 ice sheets, the pack's grass art) and the fact that
  the sheet is **fully opaque** (`alpha unique [255]`) — every transparent pixel
  we ever showed was self-inflicted by `buildSheetCanvas`'s diamond clip; the
  lattice geometry (pitch 135×74 vs the 127×66 art box, why box crops pick up a
  neighbour's art, and how far the engine's quad centres really sit from the
  fitted formula: dx −0.25…−2.80 px, dy −0.03…+1.78 px); a per-state table adding
  the measured paving/mid/asphalt split to the `notes/08` semantics (the split
  tracks how many edges are closed — 55 % paving for "none open", 12–16 % for
  "both open"), so a bake/UV regression is catchable numerically; the UV
  parallelogram's real tolerance (≤ 0.5 px, max 0.49 px — `notes/08` §2 corrected
  from "exactly"); the census of the **25 unused lattice cells** (13 water/grass
  river cells, 6 near-black structured cells, 6 solid-black filler) with
  `RiverDrawer` (RTTI at `0x3fc311`) logged as an unexplored lead; the shipped
  bake-and-draw recipe with its code anchors; the list of superseded guesses that
  still sits in `terrain.js`'s legacy comment block (no parity variant
  alternation, no dead-end fallback to state 0, no mirrored right-edge art); and
  the verification tooling, including the PIL `Image.transform(AFFINE)`
  forward/inverse trap that produced the "triangular hole" false alarm. New
  evidence: `mapdump/registration/m4-road-lattice-census.png` (all 36 boxes,
  used/unused labelled) and `m4-road-tile-facts.txt` (UV corners, centre
  deviations, box classifications). `notes/README.md` read order gains item 10.

## 2026-10-25.34

- **Fixed: panning the high-detail viewer sometimes grabbed the tile instead**
  — grabbing a loaded tile in `mapdump/renders/high-detail/` could start the
  browser's native image drag (a translucent "screenshot" ghost) instead of
  panning: the drag fires `pointercancel`, which aborts the pan handler. The
  CSS `-webkit-user-drag: none` guard is unreliable (Safari ignores it on
  `<img>`), so tiles created by `viewer.js` now set `draggable = false`, the
  viewport gets `user-select: none`, and a `dragstart` handler on the viewport
  calls `preventDefault()` as a catch-all. Cache-busters
  `viewer.js?v=2` / `style.css?v=2` in `index.html`.

## 2026-10-25.33

- **Fixed (again): the spec-mode triangles — the quadrant quads are now BAKED,
  not rotated** — `.32` made this worse, and the offline replica explains why:
  a Pixi sprite maps the **whole** texture frame through rotation+scale, so
  drawing the 127×66 slot box with `rotation = π/4` at `scale(±hs·√2/127,
  −hs·√2/66)` puts the box's four CORNERS on the quadrant's edge midpoints —
  a diamond of **twice** the quadrant's area (measured 1.75–2.0× in the
  replica). While the frame corners were transparent (the pre-`.32` shared
  sheet) that overdraw was invisible; giving them an opaque mean-paving
  backing painted grey wedges over the neighbouring cells — the shards in
  `roads.png`. The engine has no such corners: its quad's four vertices *are*
  the UV parallelogram, so nothing outside it is ever rasterised. `buildSpecSlots`
  now bakes that parallelogram into an axis-aligned 131×70 image per state
  (draw the sheet through the inverse parallelogram map: bake pixel (i,j)
  samples `L + ((i−2)/127)·(B−L) + ((j−2)/66)·(T−L)`), plus a second bake per
  state for the selector flip byte, which in this parameterisation is the
  anti-diagonal re-assignment `O=R, E=−(T−L), S=−(B−L)` — **not** a horizontal
  mirror (measured: the correct one matches the reference draw at d≈1, a
  plain mirror at d up to 43). `buildSpecCell` then draws each quadrant as a
  plain **unrotated** sprite at `scale(hs/127, hs/66)` — no rotation, no
  negative scale, no clip, no transparency: quad == quadrant. Verified with
  the bilinear replica (`/tmp/opencode/re_pixi_shear.py`): new vs the approved
  reference draw mean |Δ| 0.77 (0.15% of pixels differ by >40), painted area
  exactly the cell (ratio 1.000 where v21 measured 1.75). Evidence:
  `mapdump/registration/m4-pixi-town-compare.png` (v21 vs reference vs new on
  a street grid) and `m4-pixi-shear-check.png`. Viewer cache-buster
  `city-view-pixi.js?v=22`. Notes: `notes/08-road-drawer-re.md` §6.

## 2026-10-25.32

- **Fixed: triangular shards along the spec-mode quadrant edges — the engine
  quads now use opaque per-state slot textures** — the Pixi spec mode read its
  quadrant art as sub-textures of the shared cleaned sheet, which put the
  diamond clip's *transparency* inside the texture. The engine's quads carry no
  alpha at all (the sheet diamond is only a UV boundary), and the diamond's
  left/right vertices sit exactly on the slot frame's edges — with the odd-row
  slots landing on `.5` pixel frames — so bilinear taps at the quad corners
  blended in neighbouring sheet pixels and the transparent ring around each
  baked diamond leaked the flat road fill through as wedges (the canvas
  road-lab is immune: it clips geometrically in destination space). New
  `buildSpecSlots()` bakes each of the 11 states into its own 131×70 canvas —
  mean-paving opaque backing, clip diamond scaled 1.05, a 2 px opaque ring,
  sprite frame the true 127×66 box at integer `(2,2)` — and `buildSpecCell()`
  reads those via `specSlotTex()`. Also verified parity of the sprite maths
  against the engine (`pixi.min.js` composes world = T·R·S with the anchor in
  local space, i.e. identical to the lab's `translate→rotate→scale`; corner
  mapping `L→TL T→BL R→BR B→TR`, flip mirrors u only), and an offline bilinear
  replica of the draw (`/tmp/opencode/re_pixi_sim.py`, evidence
  `mapdump/registration/m4-pixi-sim-z{10,26}.png`) shows 0 uncovered and 0
  partial pixels per cell for all nibbles 0–15 and `'P'`. Notes:
  `notes/08-road-drawer-re.md` §6.

## 2026-10-25.31

- **Changed: the PixiJS viewer's "Road art·spec" mode now draws roads the
  way the RE'd engine draws them** — the spec mode (Road art button's last
  setting in `web/viewer/index.html`, `city-view-pixi.js?v=20`) replaces its
  old base-plus-clipped-strip composition with the engine-true model from
  `notes/08-road-drawer-re.md` / road-lab: each 4×4 road cell is FOUR
  half-cell quadrant quads, each sampling one full state diamond from the
  road sheet picked by the selector's family table (`ENG_FAM`/`engStates`:
  NW/ES use the both/first/second/none family, NE/WS the one-edge family),
  drawn with rot45 and the box's **v axis negated** (`scale(±√2/127,
  −√2/66)` — the chirality that puts state 3's kerb on W, 4's on N) and the
  selector flip byte (`engFlip`: ES always, NE for the N-only case, WS for
  the W-only case) negating the u axis. Pass bits are the saved nibble
  (E=1 W=2 N=4 S=8) OR'd with the neighbour-solid probe, matching the
  engine's `Pass_d = bit OR (contains AND solid)`; solid 'P' plaza cells
  draw the state-0 full slab. The old spec-only baked piece atlas
  (`__specpieces`) and its clip helper are gone; the legacy sheet modes
  1–3 (`terrain.js` composite model) are untouched, and the flat-colour
  fallback still applies when the sheet image cannot load.

## 2026-10-25.30

- **Fixed: road-lab state orientations were transposed — corrected against
  the actual sheet art** — pixel-classifying every UV diamond in
  `roadtilesheet.png` (per-edge bright-kerb percentages under the emitter's
  UV→corner assignment) showed the lab's rot45 blit mapped the sheet diamond
  with the wrong chirality: plain rot45 transposes art across the main
  diagonal (T↔B corners swapped), so e.g. state 3's kerb band drew along N
  instead of W. The engine map is `x=k(u+v), y=k(u−v)` — rot45 with the
  box's **v axis negated** (`blitSlot` now scales `(±√2/127, −√2/66)`).
  The analysis also settled the flip byte's role: the selector forces
  out=1 on the whole (2,2) path (0x1208644), so the **ES quadrant always
  draws the shared corner family mirrored** (W/N kerb art → E/S edges),
  and NE/WS set it on the one-edge-open route (state 7 mirrors for N-only
  → kerb E; state 10 mirrors for W-only → kerb S). New `engFlip()` models
  this; engine cells XOR it with the user mirror, the family grid shows
  each sub-case with its flip (`*`), STATE_WHAT strings are replaced by
  the measured kerb positions, and the ROAD_ENGINE reference block now
  documents the flip contract + the T,R,L,B vertex order. Evidence sheets
  `mapdump/registration/m4-re-states-triples.png` (new 4th column: flipped
  square) and `m4-re-sheet-states.png` regenerated; `notes/08` corrected
  (the old "L,T,R,B" corner guess → measured T,R,L,B). `road-lab.js?v=8`;
  `tools/smoke-road-lab.cjs` adds engFlip truth-table checks and a
  negative-v-scale check (67 checks, all pass).

## 2026-10-25.29

- **Fixed: overlapping labels in the road-lab inspector's lower sections** —
  the two blocks above the copy-reference button (engine-model cells and
  quadrant families) laid on top of each other: the live/demo cell captions
  drew 7 px under the section header, the per-cell pick list shared the
  caption line, five 160 px cells overflowed the 760 px canvas, and the
  family-grid captions were drawn to the RIGHT of each square where they
  landed on the next column. Captions now sit ABOVE each demo cell with
  the `nw#/ne#/ws#/es#` picks BELOW it (cells slimmed to 132 px so all
  five fit the canvas), family captions moved BELOW their squares, and
  every row pitch now clears the 11 px text height. `road-lab.js?v=7`.
  `tools/smoke-road-lab.cjs` gained a label-collision check (the canvas
  shim records every `fillText` position; overlapping label boxes fail the
  run) — regression-verified to flag the old layout, passes clean on the
  new one.

## 2026-10-25.28

- **Fixed + split: road-lab slot overlap, and the page is now two tabs** —
  the RE'd-slots column overlapped because the rot45 slot blit draws the
  whole 127×66 sheet box, whose corner junk maps to a 2×-oversized diamond
  around the target square and bled into neighbours (the engine only ever
  samples the inscribed diamond). `blitSlot` now clips every blit to its
  square (matching the GPU sampling region — quadrant demos and the
  family grid stop bleeding too), and the state rows are spread further
  apart with the as-sampled copy drawn as a clean `zh×zh` square. The page
  (`web/viewer/road-lab.html`, `road-lab.js?v=6`) is split into two tabs:
  **tab 1 "sprite sheet"** (the engine-model inspector, now the default
  view) and **tab 2 "footpath / carriageway tuning"** (the original N/S,
  E/W and pavement rigs with the view/preset/tone bar moved into the
  pane). Panes use `display:contents` so sections keep laying out side by
  side in `<main>`, and both tabs' canvases always repaint so switching
  never shows a stale frame. The copyable reference block stays shared.
  `tools/smoke-road-lab.cjs` gained clip-count, default-tab, and
  tab-switch checks (and the shim now counts `clip()` and registers
  built elements by id) — all pass.

## 2026-10-25.27

- **Characters render at true size, true anchor, and exact save position** —
  two format bugs made every 4.x (`bcell13`) character wrong. (1) The
  sprite's placement is a pair of **i16 offsets stored after the frame
  delay**, which `parse_bcell13` had been skipping as a "tint" word while
  borrowing the FIRST LAYER's floats instead — but bcell13 layers are
  ground overlays only (SHADOW/POSITION/INDICATOR/null); their 0.674
  "scale" is the stock shadow-texture transform, so the bake shrank every
  4.x character to ~2/3 size and stamped a bogus constant anchor
  (40.95, 19.65) on 716/756 assets. The corrected layout is confirmed
  three ways: the `tsto2rgb` writer in `tools/tsto2rgb` writes
  `x = -w/2 + offsetX, y = -h + offsetY` into those i16s, all 14,328 pool
  cells parse to exact EOF, and values sanity-check against bcell10
  (exorcismpriest (-35,-214) on a 74x222 frame ≈ bottom-centre feet
  origin). `tools/gen_city_sprites.py chars` re-baked at scale 1.0 from
  the stored offsets. (2) `MAP_DATA.chars` rows now carry the save's
  **exact float positions** (no int-rounding; 864/871 sit on tile centres)
  and every draw site (`city-view-pixi.js` v19, `city-view.js` v31,
  `objects.js` v13, `gl-base.js` v14) draws at the raw value instead of
  tile+0.5, removing the systematic +1.0/+0.5-tile offset. Character
  px/tile was re-verified as equal to building art (S=64) by measuring
  the 16200x8370 screenshot against the road-stone tile lattice, so
  `kc = s/64` stays. Spec corrected in `notes/01-binary-formats.md`
  (the "u32 tint / first layer is the sprite" claim is retired).

## 2026-10-25.26

- **PixiJS viewer resumes at your last camera position and zoom** — the
  Pixi city view (`web/viewer/city-view-pixi.js?v=18`) now remembers where
  you were looking: the tile under the screen centre + zoom level are
  persisted to `localStorage` (new key `mrsnrub.cityview.cam`, throttled to
  ~2.5 writes/sec in the render loop plus a flush on `pagehide`), and on
  reload the view reopens exactly there instead of always jumping to the
  Springfield preset. Tile coords (not world coords) are stored so the
  saved view stays correct across the persisted ORIENT change; the restore
  runs before boot so a saved view replaces the default preset (no preset
  button is highlighted). The first visit, or a corrupt/missing entry, falls
  back to the old Springfield-preset behaviour; the Canvas page is
  untouched.

## 2026-10-25.25

- **RoadDrawer RE lands: road-lab sheet inspector rebuilt on the engine's
  true quadrant model + `notes/08-road-drawer-re.md`** — direct RE of
  `libscorpio.so` (from `Springfield-V08.apk`) settled how road sprites
  really go together: every road cell draws **4 quadrant quads** (sub-coords
  (x&3,y&3) ∈ {0,2}²), each sampling ONE full 127×66 state rect (the
  inscribed-diamond UV parallelogram) chosen from the quadrant's two cell
  edges by the selector at `0x1208058` — no base+clip composition, no
  second kerb pass, no parity variants (the earlier guesses are retired).
  New `notes/08-road-drawer-re.md` consolidates the whole finding (UV quad
  table, record accessors, nibble bit directions E=1/W=2/N=4/S=8, pass rule
  `bit OR (contains AND solid)`, the 4-family state table with leaf
  addresses, the draw-pass geometry/flip byte), `notes/06` §10 and
  `notes/README.md` now point at it, and evidence renders are in
  `mapdump/registration/m4-re-sheet-states.png` + `m4-re-states-triples.png`.
  The road-lab "road art sheet" inspector (`web/viewer/road-lab.js?v=5`,
  served from `web/viewer/road-lab.html`) demonstrates the true model:
  base/footpath/clip-S steppers replaced by **cell mask E/W/N/S** and
  **neighbour-solid probe** toggles (the engine's pass rule), a **force
  state** override (auto = engine family table), a **flip** toggle (the
  emitter's corner-swap), raw-box vs parallelogram draws, per-quadrant
  `nw#/ne#/ws#/es#` pick labels on the live cell + E+W / N+S / bend /
  isolated demos, and a quadrant family reference grid; the copyable
  reference block now emits `ROAD_ENGINE = { … }` (replacing the invented
  `ROAD_SHEET`). `tools/smoke-road-lab.cjs` extended with engine-table
  checks (street/isolated/interior/bend picks, mask/probe OR-in, force
  clamp, ROAD_ENGINE block) — all pass. The flat-colour `ROAD_ART` tuning
  and the Pixi `Road art·spec` mode are untouched by this entry; replacing
  the spec-mode textured composition with engine-true quadrant rendering
  is the follow-up once the lab + evidence PNGs are reviewed.

## 2026-10-25.24

- **Fixed: twin-less flipState-1 objects now mirror like the engine
  does (Flowers02 and ~690 other placements)** — the blanket
  mirror-in-place fallback from .22/.23 was geometrically wrong: the
  game renders a "flipped" instance the way it renders a shipped
  `<slug>flipped` TWIN — footprint and loc offsets swapped (x↔z,
  locX↔locY) and the mirrored art anchored at (w−ax, ay) about the
  position point, which is NOT the same as mirroring within the rect
  the base art drew. The save proves the engine really does this even
  when no twin art ships: every twin-less asymmetric asset with
  flipState=1 chains at the SWAPPED spacing (PurpleHouse 7×6 rows step
  X by 6, WhiteHouse 6×4 by 4, all 12 Flowers02 instances chain 1×3
  footprints at X-spacing 3, HorseTrough/FrontierFence/TireFence 2×1
  column-step by 2, KrustylandTurnstile 2×4 by 2), and mirror = that
  swap because a horizontal mirror of iso art maps the +X axis onto
  +Y. `tools/gen_map_explorer.py` `dims_for()` now resolves odd
  flipState placements to the twin's footprint file when it ships
  (678/678 instances) or the swapped base dims when it doesn't
  (693/693); `web/js/map-explorer-data.js` regenerated. In
  `web/viewer/city-view-pixi.js` the mirror fallback (`mir`) draws at
  the twin-equivalent rect (`bl` uses the mirrored anchor) instead of
  mirroring about the drawn-rect centre — this un-skews Flowers02's
  flowerbed strips and re-anchors GoldenBuddha/AngelFossil exactly like
  shipped twins are anchored. The earlier per-asset hunt (which assets
  "should" mirror) is moot: the engine mirrors ALL twin-less odd-fs
  placements — confirmed against the game binary's
  `MirrorFlipStateComponent` / `flippedname` / `MirroredFlipState`
  machinery in `libscorpio.so`. `notes/01` flipState section rewritten
  with the evidence; viewer cache-buster `?v=17`, `__CV_VER` bumped.

## 2026-10-25.23

- **Fixed: fence mapping and twin-less statue position (follow-up to
  2026-10-25.22)** — the previous round's flipState remapping was itself
  wrong: it reasoned with the wrong screen axes and ignored the shipped
  camera orientation (`CAM.ORIENT` fx=1, fy=-1, swap=1 — +X runs
  upper-right, +Y lower-right). Re-derived against the true projection,
  the chain spacing (fs 0/2 pieces step along X every 2 tiles, fs 1/3
  along Y) forces fs 0/2 to the x=2 variants and fs 1/3 to the z=2
  variants, and the enclosure sides + bsv3 anchors pin
  **0=SE, 1=SW, 2=NW, 3=NE** (the original `.rodata`-order guess had
  NE/NW swapped). `FLIPDIR` in `tools/gen_map_explorer.py` corrected and
  `web/js/map-explorer-data.js` regenerated — IronRailing runs now get
  `ironbarfencese` (y=76 side, 2×1), `ironbarfencesw` (x=116),
  `ironbarfencenw` (y=53), `ironbarfencene` (x=159): right slope, right
  footprint, and no longer sitting a tile too far south. `notes/01`
  updated with the corrected mapping and both superseded guesses.
- **Fixed: mirror fallback keeps twin-less decorations in place** — the
  new Pixi mirror (for flipState-1 objects without a shipped
  `<slug>flipped` twin, e.g. GoldenBuddha/AngelFossil) now mirrors the
  base PNG *within its own screen rect* (about the centre of where it
  draws) instead of about the ground pivot, so the object keeps its
  position and only the facing flips; the fallback is also restricted to
  flipState 1 (the only documented mirror state). `city-view-pixi.js?v=16`.

## 2026-10-25.22

- **Fixed: decoration/fence orientation per the save file (PixiJS view)** —
  two independent orientation bugs made placed decorations draw the wrong
  way. (1) The `flipState 0..3 → SE/SW/NE/NW` fence/wall mapping used by
  `tools/gen_map_explorer.py` was a guess that had two of the four
  directions 90° off; re-derived from the save's IronRailing enclosure
  (its max-Y/min-X/min-Y/max-X edges carry fs 0/1/2/3, and fs 0/2 pieces
  chain along X while fs 1/3 chain along Y across every placed family),
  the true order is **0=SW, 1=NW, 2=NE, 3=SE**. `web/js/map-explorer-data.js`
  was regenerated, so every directional fence/wall/balcony/curve the save
  places (IronRailing, WoodenFence, FancyFence, ConcreteWall, BarbedWire,
  monorail curves, …) now picks the correct variant art and footprint
  orientation; `notes/01-binary-formats.md` records the corrected mapping.
  (2) Decorations whose flipState is set but whose `<slug>flipped` twin
  art never shipped (e.g. GoldenBuddha, AngelFossil) drew completely
  unrotated; the Pixi viewer (`city-view-pixi.js`, `?v=15`) now mirrors
  the base PNG about the sprite's ground pivot in that case — the shipped
  twins are plain mirrors (verified on the barbed-wire pair), so this
  matches the game. Only the Pixi page changed; the deprecated canvas
  page is untouched.

## 2026-10-25.21

- **Fixed: road-lab sheet inspector painted nothing (blank green box)** —
  `renderArt()` set `cv-art`'s height to fit its content *after* drawing,
  and assigning `canvas.height` clears the bitmap in real browsers, so the
  finished frame was wiped on every render and only the CSS canvas
  background showed. The canvas now resizes, then re-runs the full paint
  into the fresh bitmap (with a re-run guard). `road-lab.js?v=4`. The
  smoke harness grew a fake `Image` (drives the real blit path headless),
  a last-canvas-op trail, and a check that no render pass ends on a
  bitmap-clearing resize — verified to fail on the old code.

## 2026-10-25.20

- **Added: road-art sheet inspector on the road-lab page** — a new
  "road art sheet" section renders every tile the asset packs ship so the
  `Road art·spec` composition can be diagnosed visually instead of by
  guesswork. Controls: a pack picker over the 10 verified sheets
  (`roadtilesheet.png` / `iceroadtilesheet.png` reskins — base, hi-res,
  ice, GreenRivers, StPatrick's, Christmas, Blargsgiving, AtomSmasher,
  tutorial, XMAS2015 snow), the full 512² sheet with the RE'd diamond
  lattice overlaid and the 11 catalogued states numbered, each state
  enlarged side-by-side raw-box vs diamond-clipped, a 4-cell composition
  demo (base slot + one band piece per grass side), and strip-piece
  previews per side. Interactive knobs: zoom, base state (0–10), footpath
  state (manual override vs per-side auto picks 3/4/4/3), clip S (manual
  0.30–0.95 steps of 0.05 vs auto `1 − avgFoot/2`), raw-boxes and lattice
  toggles. The copy/pasteable reference block gains a `ROAD_SHEET = {pack,
  src, baseState, pieces, clipS}` contract to port back into the viewer.
  `road-lab.js?v=3`; the smoke harness gained ~18 inspector checks
  (pack select, steppers, clamps, auto flags, reference contract).

## 2026-10-25.19

- **Added: `Road art·spec` now uses the real roadrivertiles art** — the
  Pixi viewer's spec mode composes each nibble cell the same way the engine
  composes its straights, but at the road-lab widths: the full-cell state-0
  asphalt base, plus one state-3/4 kerb/paving band piece per GRASS
  (non-connected) side. The band pieces are re-baked at the tuned clip —
  inner diamond scaled `1 − FW/2` (0.625) instead of the engine's
  `SHEET_CLIP_S` (0.71) — so the textured sidewalk lands exactly on the
  0.75-tile footpath strip with the art's own kerb line. East-side grass
  reuses the pre-mirror `nx` bake (negative-scaleX mirrors clip + texture
  together), matching the existing PIECE_DEFS trick. 'P' cells stay the
  flat uniform pavement slab, and the flat-colour rects remain as the
  fallback when the sheet PNG has not loaded (e.g. `file://` without the
  DLC copy, or winter's ice sheet). Served as `city-view-pixi.js?v=14`;
  the Road-art tooltip updated.

## 2026-10-25.18

- **Changed: road art rebalanced to the 0.75 / 2.5 / 0.75 road-lab preset**
  — the footpath strips widen and the carriageway narrows accordingly in
  both surfaces that draw the tuned spec composition: the Pixi viewer's
  `Road art·spec` mode (`city-view-pixi.js`, `SPEC.FW` 0.5 → 0.75; served
  as `city-view-pixi.js?v=13`) and the Spec View nibble composition
  (`spec-view.js`, `FW` 0.5 → 0.75; served as `spec-view.js?v=4`). Colours
  and the 'P' uniform-pavement rule are unchanged; the Spec-View legend
  and the Road-art button tooltip now quote the new ratio.

## 2026-10-25.17

- **Changed: finer footpath sizes in road-lab** — the presets row gains
  three in-between stops (hairline 0.25/3.5/0.25, mid 0.75/2.5/0.75,
  mid-wide 1.25/1.5/1.25) alongside the existing ones, and the width
  steppers now move in eighths of a tile (0.125) instead of quarters, so
  values like 0.75 or 1.125 are one click away. Readouts and the
  copy/pasteable `ROAD_ART` block now print three decimals (1.125 was
  rounding to 1.13). `road-lab.js?v=2`; the smoke harness drives the new
  presets and the eighth-tile stepper grid.

## 2026-10-25.16

- **Added: Spec View and Road Lab listed on the project hub** —
  `web/index.html` (City viewer card) now links `viewer/spec-view.html`
  (road-layout ground truth from `road-spec.json` only, with the tuned
  footpath/carriageway presentation) and `viewer/road-lab.html` (the
  footpath/carriageway tuning sandbox with the copy/pasteable `ROAD_ART`
  reference), which had been reachable only by direct URL.

## 2026-10-25.15

- **Added: 'Road art·spec' mode in the Pixi viewer** — the Road-art button
  cycle (`web/viewer/city-view-pixi.js`) gains a 4th stop: the road-lab
  tuned composition rendered straight from the saved cell codebook, no sheet
  art involved. Each nibble cell becomes tile-space rects: 0.5-tile footpath
  strips (`#9c9ca3`) flanking a 3-tile carriageway (`#5c5c62`) centred on the
  cell axis, with a strip reaching each connected edge (mask E=1 W=2 N=4
  S=8), and 'P' cells one uniform pavement slab (`#7e7e85`). Sprites are
  built only while the mode is on (the toggle rebuilds the ground), live in
  the feature container so the legend Road toggle and the zoom-out LOD apply
  unchanged, and the mode persists via the existing
  `mrsnrub.cityview.sheetart` key. Cycle: flat → sheet → edges → avenues →
  **spec** → flat. `index.html`: `city-view-pixi.js?v=12`, button tooltip
  updated.

## 2026-10-25.14

- **Changed: spec-view road art uses the road-lab tuned geometry (0.5 / 3 /
  0.5)** — the nibble-cell composition in `spec-view.js` now follows the
  `ROAD_ART` reference dialed in on the road-lab page: the carriageway is
  3 tiles wide on each axis, centred in the 4×4 cell (axis at 2), with
  0.5-tile footpath strips along the sides. Asphalt is drawn as a central
  3×3 core plus a 0.5×3 strip to each connected edge (was a 2×2 core with
  1-tile stubs); the footpath base shows through on non-connected sides,
  kerb lines kept. Colours unchanged (asphalt `#5c5c62`, footpath
  `#9c9ca3`, pavement `#7e7e85`). `spec-view.js?v=3`. New headless check
  pins the composition: a 'd' (E+W) cell must fill footpath then exactly
  3 asphalt quads.

## 2026-10-25.13

- **Added: road-lab tuning page (`web/viewer/road-lab.html`)** — a
  self-contained sandbox for dialing in the road-cell footpath / carriageway
  art before it is ported into the spec-view (and later terrain) rendering.
  It shows enlarged examples of every saved road type — N/S (mask m) through
  roads plus an E-arm junction and pavement-flanked case, E/W (mask d) with
  an S-arm and flanked case, and 'P' pavement slabs (3×3 and road-adjacent) —
  with per-side footpath width steppers (0.25-tile steps, carriageway clamped
  to ≥ 1 tile), footpath/pavement tone steppers, presets (current 1/2/1,
  thin, one-sided, wide, none) and view toggles (2:1 iso matching
  `camera.js`, 4×4 sub-tile lattice, kerb lines, width callouts). Every
  control updates a live copy/pasteable `ROAD_ART = {...}` reference block
  (geometry + colours) below the canvases. New harness
  `tools/smoke-road-lab.cjs` drives the steppers, presets, tones and toggles
  headlessly.

## 2026-10-25.12

- **Changed: spec-view road presentation — footpath/main-road art and
  'P' = pavement (uniform grey)** — the spec viewer (`spec-view.html`)
  previously painted every nibble cell as one flat asphalt diamond and
  'P' as a tan "plaza" slab. Nibble cells now render the main-road
  presentation from the saved 4-bit mask: an asphalt core (central 2×2
  sub-tiles) plus a carriageway stub toward each connected edge, with
  footpath flanking (light grey, kerb line) filling the outer sub-rows/
  cols on non-connected sides — the model the walk oracle corroborates
  (cached walks ride the footpath: 'd' cells concentrate at sub-y 0,
  'm' cells at sub-x 3). 'P' cells are pavement: one uniform grey slab,
  no footpath or kerb art, renamed from "plaza" everywhere on the page
  (legend, hover readout). Flat single-fill below ~4 px/cell keeps zoom-
  out fast. `spec-view.js?v=2`; legend's stale origin note corrected to
  (0,−112). New headless checks in `tools/smoke-spec-view.cjs`: nibble
  cells must paint footpath + asphalt styles, 'P' cells pavement grey
  only.

## 2026-10-25.11

- **Fixed: road network world alignment — CELL_OX −48 → 0 (roads were
  48 tiles too far west of everything else)** — the cell-grid origin had
  only ever been verified against InnerLandData land-block positions, a
  check that is blind to any 16-tile shift (48 = exactly 3 blocks), so
  the whole cell-codebook layer family (road/river/sand/dirt/dirtroad/
  klsroad) shipped offset west relative to buildings and characters.
  Calibrated tile-exactly against the save's own oracles: rasterised
  `pathCache` walk tiles must land ON road cells (characters only walk
  on streets) and building anchors must sit OFF them; a full 2-D offset
  sweep peaks uniquely at (+48, 0) — walk hit 22.5% → 80.7%, building-
  anchor purity 87.6% → 91.0%, buildings-on-river 2.5% → 0.9%,
  buildings-on-road 13.1% → 9.3%, river now runs along SpringfieldLake's
  south shore/east outlet instead of cutting through the lake. Changed
  `CELL_OX` in `web/js/terrain.js` (plus header docs), cache-busters
  `terrain.js?v=14` on both City View pages. Side fix surfaced by the
  re-alignment: `CityWalks.census` probed `_roadOccAll` with walk tiles
  shifted by `M.ox/M.oy` (12/136) — a frame mismatch that let on-road
  segments leak into the candidate census; census is now fully town-frame
  (`web/js/walks.js`, `walks.js?v=13`), which correctly reduces the
  candidate set to the genuinely unsaved lines (cols −21/−17/187, row
  −60) — the old "unsaved walk avenues" were in fact saved roads hidden
  by the shifted probe. Spec viewer data regenerated with the calibrated
  origin (`tools/gen_spec_view_data.py` → `spec-view-data.js?v=2`).
  Regression gates added to `tools/smoke-camera.cjs`: CELL_OX/OY pin,
  ≥75% walk-tile road coverage, ≤15% building-anchor overlap, and the
  re-pinned lake-shore river check. Evidence:
  `mapdump/registration/m4-road-offset-calibration.svg` (before/after
  panels: gray road cells, green/red walk tiles, blue building anchors).

## 2026-10-25.10

- **Added: standalone Road spec viewer — renders ONLY road-spec.json** —
  new test page `web/viewer/spec-view.html` (+ `spec-view.js`,
  `spec-view-data.js`) that draws the ground-truth road layer exactly as
  `road-spec.json` defines it: every non-'G' cell as ONE 4×4-tile quad at
  the spec's own layout (origin −48,−112, stride 37), asphalt diamonds for
  nibble cells a–p with the saved 4-bit neighbour mask (E=1 W=2 N=4 S=8)
  painted as yellow centre→edge connection stubs, red dots on dead ends,
  orange dots on T-junctions/crossings, and tan slabs for solid 'P'
  plaza cells. No MAP_DATA, no terrain.js, no Pixi — the only data is the
  spec grid, embedded at generation time (file://-safe). Camera is the
  shared City View model (`js/camera.js`, same ORIENT {1,−1,1} 2:1
  oblique): wheel zoom at the cursor, drag pan with fling, double-click
  zoom ladder, plus Fit/Rest/Rot/Flip buttons, a `col,row` jump box, and
  toggles for connection stubs, char labels, cell-grid outlines and the
  4×4 sub-tile lattice; the stats bar reads out the hovered cell's char +
  decoded mask. Data pipeline: `tools/gen_spec_view_data.py` extracts the
  grid from `road-spec.json` (re-padding its two truncated 147-char rows),
  asserts the char histogram against the spec's own
  `road_layer_stats.char_histogram`, and writes the embed. New headless
  suite `tools/smoke-spec-view.cjs` boots the page under a DOM shim and
  checks row-for-row spec equality, all 1,647 cells drawn at Fit, label
  zoom-gating and viewport culling (9 checks, all pass).

## 2026-10-25.9

- **Fixed: PixiJS road cells drew their sheet art at quarter scale — streets
  no longer match the saved cell layout (road-spec.json)** — diffed the
  viewer's road layer against `road-spec.json` ground truth end to end: the
  decode is exact (all 1,647 cells, full nibble histogram match, reciprocity
  1.000 — the two apparent grid diffs are truncated 147-char rows in the
  spec itself), so the mismatch was in the Pixi draw, not the data. The
  spec's core model is "every cell paints as ONE 4×4-tile diamond": the
  canvas reference feeds `quad(…, big=4)` to `_sheetTile`, so the 127×66
  sheet box's edge midpoints land on the CELL square's corners. The Pixi
  port (buildGround) instead used the viewer's unit-tile constants
  `SHEET_SX/SY = √2/127, √2/66` — the correct mapping only for 1-tile
  avenue cells — for every road cell, so each cell's art rendered as a
  1×1-tile diamond floating in the middle of its 4×4 flat fill: bends drew
  at cell centres instead of corners, the kerb/sidewalk strip composites
  shrank to a quarter of the street, and the streets read as grey bands
  sprinkled with small art fragments. `buildGround` now scales each cell's
  sheet sprite (and its baked strip pieces) linearly with the cell size
  (`big * SHEET_SX/SY`); the avenue pass keeps the unit mapping, which is
  correct there. Evidence + regression guard: `tools/smoke-camera.cjs`
  gained two checks pinning the footprint invariant (canvas affine == pixi
  big-scaled sprite for big=1 and big=4, plus a negative check that the old
  unit scale is wrong for 4×4 cells); the full camera suite passes. Cache
  buster bumped: `city-view-pixi.js?v=11` in `web/viewer/index.html`
  (`terrain.js` unchanged). Eye test: Road-art modes 1–3 on the Pixi page
  should now show full-cell streets matching the City Canvas page.

## 2026-10-25.8

- **Fixed: buildings still wearing their holiday skin in base mode (CrazyCatLady's
  house)** — follow-up to the season-mode work. CrazyCatLady's house rendered snowy
  in every mode because the ONLY art the pool had ever seen for it came from the
  Christmas packs: the plain (unsnowed) art ships in the post-event *Takedown*
  "revert" packs, and those packs were never in the candidate scan, so `resolve`
  had no base copy to promote. Extended the candidate lists to the 28 local
  takedown bundles (`/tmp/opencode/g100_cands4.tsv`, `g100_cands5.tsv`), taught
  `classify_season` that `*Takedown*` packs are base providers — except their own
  `*Snow*` families, which re-ship the generic snow cover and still classify as
  winter/halloween as named — and added `backfill --only <substring>` so a pack
  family can be re-scanned without replaying all 1,400 rows. The three XMAS
  takedown packs supplied base art for **594 pool files (~297 slugs)**, all
  promoted by `resolve` (which now prints each swap); the other 25 takedown packs
  only re-shipped art already in the pool. Sprite PNGs for the affected slugs and
  171 animation filmstrips were re-rendered from the base art (season variant
  entries 3,404 → 3,481, anims manifest stable at 2,542, coverage 3,630/3,630,
  DOM smoke suite passes). Seven map-visible slugs stay in their event art by
  design — `iceberglarge`, `greatwalltower(flipped)`, `springfieldxmastreefarm(
  flipped)`, `dogpoundflipped`, `geriatricparkgate(flipped)` — their snowy art is
  the only art the CDN ever shipped for them. The regenerated PNGs keep their
  old filenames, so the Pixi viewer now sends every city asset URL through a
  `cityUrl()` helper carrying a single `ASSET_V` cache-buster (bump it plus the
  script's `?v=` — now `city-view-pixi.js?v=10` in `web/viewer/index.html` —
  whenever the pipeline regenerates art; the deprecated canvas page is
  unchanged). Evidence:
  `mapdump/registration/m4-season-crazycatladyshouse-base-vs-winter.png`
  (base / winter / easter panels).

## 2026-10-25.7

- **Fixed: PixiJS viewer now actually draws the road sheet art, and the
  sidewalk strips were halved** — two follow-ups from the 2026-10-25.5 eye
  test. (1) The new viewer (`web/viewer/`) shared `terrain.js` but owned its
  own sheet pipeline, and it had never worked: `buildSheetCanvas` deleted the
  stale `texs['__sheet']` registry entry but no code ever (re-)registered the
  cleaned sheet canvas, so `sheetSlotTex` always returned null and every road
  sprite kept the untinted 1×1 `UNIT` texture — all roads drew as flat grey
  diamonds whatever the Road-art mode said. The cleaned sheet now registers as
  `__sheet` (and the new strip-piece bake as `__pieces`) after every
  rebuild/season swap. `buildGround` reproduces the canvas page's multi-pass
  pick per cell (nibble straights masks 3/12 and `Terrain#_pavePick` bands =
  flat asphalt base + kerb/paving pieces on the grass edges; other nibbles =
  one full piece; `applySheetMode` assigns full-slot or baked-piece textures),
  and pixi's no-clip-sprites constraint is solved by BAKING the strip clips
  into a small second canvas (`PIECE_DEFS`, box-space polygons from the shared
  `Terrain.sheetClipPoly`; the flipped px piece bakes the pre-mirror nx clip
  because a negative-scaleX sprite mirrors its baked alpha too).
  `applySheetArtMode` rebuilds the ground instead of just toggling, since the
  pick consults the avenue probe. Cache-busters bumped: `terrain.js?v=13`
  (both pages), `city-view-pixi.js?v=9`. (2) The sidewalk strips were still
  too fat in City View: a row scan of the sheet shows the state 3/4 paving
  art reaches ~2/3 of the way into the cell, so the half-diamond clip showed
  ALL of it (~50% sidewalk). `_halfClip`/pixi now clip to an edge STRIP —
  outer diamond minus a copy scaled `Terrain.SHEET_CLIP_S = 0.71` about the
  centre (hexagon) — giving ≈25% sidewalk per edge and a ≈50% asphalt core,
  matching the export L-A-A-L transects. Evidence:
  `mapdump/registration/m4-sidewalk-beforeafter.png` (three panels: flat /
  full-half clip / new strip clip). `smoke-camera` gains a `sheetClipPoly`
  area spec; camera / city-view-dom / calib suites pass.

## 2026-10-25.6

- **Added: City View season mode — the town's seasonal re-ship art, toggled
  from the viewbar** — TSTO never shipped a season switch: during an event
  the CDN simply RE-SHIPPED the same building slugs with themed art (snowy
  lawns, fall leaves, halloween costumes), and the sprite pool's original
  first-write-wins extraction let those re-ships become THE art for ~1.4k
  slugs (LawnChair, SkinnerHouse and the Muntz house have rendered snowy in
  every summer session until now). The `Season` button on
  `web/city-view.html` now cycles **base → winter → autumn → Halloween →
  Easter → Valentine → July 4th → St Patrick's → Pride → Summer** (only
  classes present in the manifest are in the cycle; choice persists in
  localStorage `mrsnrub.cityview.season`). Base art was restored by two new
  `tools/gen_city_sprites.py` stages: `backfill` (12 parallel workers over
  ALL 1,336 candidate rows — byte-compares every re-ship, keeps gap-fills,
  archives the 10,745 byte-different seasonal copies under
  `citypool/season/<class>/`, `base` = plain-provider copies that lost the
  original race) and `resolve` (promotes 2,149 archived base copies to pool
  main, evicting the seasonal winner into its class dir; idempotent).
  `sprites` re-rendered all 3,592 slugs plus 3,404 season-variant PNGs under
  `web/assets/city/seasons/<class>/<slug>.png`, each mirrored in its
  city-sprites.json entry's new `seasons` sub-map (pixel-identical variants
  dedup away); `anims` re-cut 479 filmstrips whose body art the swap moved.
  The renderer (`web/js/city-view.js`, `?v=30`, **and the PixiJS viewer
  `web/viewer/city-view-pixi.js` `?v=8` + `web/viewer/index.html`**)
  resolves both draw paths through a season-aware `spriteEntry()`,
  suppresses filmstrip anims on season-overridden buildings (the cells
  belong to the base sheet), and in winter swaps the road tile sheet for
  the XMAS2017 pack's icy 512×512
  layout (grass stays green — no snow grass ships in the data; on the
  Pixi page the diamond-cleaned sheet canvas is rebuilt from the icy
  image); event-only art like holidaytree has no base twin and shows as-is in every mode.
  Sprites runs now shard (`sprites --shard I --shards N` + the new
  `sprites-merge`) because the single process grew to 17.9 GB RSS before the
  kernel killed it — the culprit was a garbage-placed `C_Shadow` block at
  (-2.15e6, -2.15e6) in the winter `museumofsuperfinearts` re-ship asking
  PIL for an 18 TB canvas; `_composite` now culls block rects >20k px from
  the cluster median and hard-caps canvases at 16 Mpx. Evidence:
  `mapdump/registration/m4-season-{lawnchair,skinnerhouse,muntzhouse}-base-vs-winter.png`;
  `tools/smoke-city-view-dom.cjs` gained a four-check season-toggle section.

## 2026-10-25.5

- **Fixed: nibble W-bit mapping, road cross-section proportions, saved 'P'
  sidewalk art, and 4-column N–S avenues** — four coupled road-art fixes
  after the user eye test ("roads missing sidewalks", "sidewalk too big
  vs the road"). (1) `Terrain.cellStateFor` mapped nibble bit 2 (W) to
  the +y bit, colliding with S — every E–W straight (nibble 3, 350 cells
  in the save) rendered as a bend half-split instead of the band state;
  occupancy reciprocity on the shipped save (1173/1173 exact nibble
  agreement) confirms the corrected `t = (m&3) | (m&4)<<1 | (m&8)>>1`
  mapping. (2) The visible streets are single-cell-wide nibble cells
  (masks 3/12 — 1182 cells) and single-cell-tall 'P' rows, i.e. FULL
  road cross-sections: they now paint flat asphalt across the whole cell
  with the kerb/paving piece (states 3 / 4+flip) laid over each grass
  HALF only (`_pavePick` / render-pass half-clipped composites) —
  one full stacked band piece drowned the road in paving. (3) Every
  cell-codebook road — including all `m=-1` 'P' cells — previously went
  through `cellStateFor`, which hard-maps 'P' to flat state 0, so
  avenues never got the kerb/paving pieces and the neighbour-select
  branch was unreachable; 'P' cells now select via `Terrain#_pavePick`
  (interiors + plaza slabs, vertical run >= 8, stay flat). (4)
  `Terrain.AVENUE.streets` entries were 2-col asphalt cores; they are
  now the full 4-col bands incl. sidewalk columns
  (`[65,68] [89,92] [113,116] [29,32] [125,128]`) — export transect
  measures L-A-A-L at cols 89..92 across the 90/91 avenue. Evidence:
  `mapdump/registration/m4-sidewalk-beforeafter.png` (before/after
  composites: E-W avenue, 1-wide N-S straight, template band).
  Earlier "sidewalks are separate occupancy cells" theory tested and
  rejected — the engine paints sidewalk lanes from the sheet art
  (states 3/4 are asphalt+kerb+paving composites). `smoke-camera` specs
  extended (nibble table, `_pavePick` cases, 4-col avenue masks);
  camera / city-view-dom / calib suites pass. Sheet art remains OFF by
  default; "Road art" neighbour(+avenues) shows the new look.

## 2026-10-25.4

- **Added: M4 road-candidate eye-test board + 1-wide straight road art** —
  two Phase-2 (M4 TODO 7/8) deliverables. (1) `tasks/m4-road-review/` is a
  new self-contained review page (opens from `file://`, no server): twelve
  annotated export crops (`img/region-A..L`) covering the full-map
  `scanall` inventory (56 N–S + 59 E–W candidate segments, nominal
  calib-grid coords with drift halo boxes), one verdict row per candidate
  (✓ approve / ✗ reject / ? unsure + free-text note) persisted in
  localStorage, and an export button that emits the verdicts as JSON for
  promotion into `Terrain.AVENUE.streets` / `api/streets.php`. Assets are
  regenerated by `tasks/m4-road-review/build_review.py` (which also
  mirrors the full-res crops to `mapdump/registration/m4-avscan-*.png`).
  (2) `web/js/terrain.js` `SHEET_TABLE` now draws the 1-wide straights
  (masks 3 E–W, 12 N–S — the saved driveway/fragment cells) with the
  engine's diagonal band states 3/4 instead of falling back to state 0
  flat asphalt: the RE'd `FUN_01308058` base-tile selector composes those
  cells from four iso quadrant quads of exactly this art, so one band
  piece per cell is the single-piece equivalent. Before/after renders:
  `mapdump/registration/m4-mask312-art.png`. Sheet art remains OFF by
  default (neighbour-select behind the City View "Road art" button);
  `tools/smoke-camera.cjs` spec updated to the new table.

## 2026-10-25.3

- **Changed: City View ships with building sprites (Art mode ON) at the
  measured sprite scale S=64** — the **Art** button on `web/city-view.html`
  and the PixiJS viewer (`web/viewer/index.html`) now defaults to
  `Art·sprites`: a fresh visitor sees the game's own extracted building and
  character art instead of the coloured blocks/dots (the localStorage
  preference still overrides, and the button still toggles both ways).
  The guessed billboard scale `ART.S` (62) is replaced by a measured
  **64**: the new harness `tools/fit-sprite-scale.py` template-matches the
  extracted city sprites against the full-resolution export screenshot
  using blurred edge-NCC on each sprite's ground band, and the two
  registration-verified landmarks (Kwik-E-Mart, PoliceStation) both peak
  at S 63–64 — confirming the `PX_PER_UNIT` candidate from the RE notes.
  Evidence pastes: `mapdump/registration/m4-sfit-{kwikemart,policestation}.png`.
  The harness also documents that the shipped ground homography was an
  exact 4-pair fit and gets refitted (least squares over 8 pairs, zoo
  dropped) inside the tool; cache-busters bumped (`city-view.js?v=29`,
  `city-view-pixi.js?v=7`).

## 2026-10-25.2

- **Fixed: unreadable link colour on the project hub / progress styles** —
  `web/css/progress.css` never styled plain content links, so the hub page
  (and any page using this stylesheet) fell back to the browser-default
  dark blue, which is unreadable on the dark-blue panels. Links now use the
  project gold (`--gold-bright`, visited `--gold`, hover brighter gold);
  the class-specific `.brand` / `.sec-link` styles are unchanged.

## 2026-10-25

- **Changed: project layout reorganised around the PixiJS viewer** — the
  PixiJS city view moved from `web/city-view/pixijs/` to `web/viewer/` and
  its page is now `web/viewer/index.html` (scripts/`B` prefixes, README and
  cache-busters updated: `city-view-pixi.js?v=6`). The classic game shell
  `web/index.html` was renamed to `web/original.html`; every "← Springfield"
  brand link across the explorer pages now points at it, and the new
  **project hub** at `web/index.html` indexes all major components built so
  far (port, viewers, RE workbenches, tracking pages). `web/city-view.html`
  is marked **DEPRECATED** — a red banner plus header-comment notice send
  all future viewer work to `web/viewer/`; the legacy page stays as the
  Canvas2D/hybrid-WebGL reference.

- **Added: standalone task board page at `tasks/index.html`** — the task &
  decision board split out of the Progress dashboard into `tasks/` at the
  project root (`tasks/index.html` + `tasks/js/tasks.js`, reusing
  `web/css/progress.css`). It reads/writes the same store through
  `../web/api/progress.php` (`web/api/progress.sqlite`), so no server
  change is needed; the dashboard keeps the meters, coverage grid and
  journal and links to the board. `tools/smoke-progress-dom.cjs` now drives
  both `web/js/progress.js` and `tasks/js/tasks.js` (plus a new
  open/total stats-bar assertion); `notes/07-progress-board.md` and both
  READMEs updated for the new URLs.

## 2026-10-24.6

- **Fixed: ZiffCorp "Helicopter" tap animation starved by the big-atlas
  budget** — the building named *Helicopter* (binfo 105506, asset
  ZiffCorpHelicopter) does have a click one-shot: a 47-frame `Active`
  rotor strip. At 15.7M decoded px it sits just under the 16M huge-slot
  threshold, so it loaded through the big-tier budget instead — and that
  budget (8 atlases, `animBigLive`) is permanently consumed by every
  6–16M filmstrip the map auto-plays while panning (160+ assets qualify)
  and is never released. Once spent, the tap silently drew the static
  PNG. `animAtlasFor()` now takes a click-driven flag: tap/toggle
  one-shots in the big tier ride the recyclable oversize pool (the one
  `freeHugeSlot()` manages) instead of the never-released budget; map-
  picked idle loops keep the old gate. Same fix in `js/city-view.js` and
  `city-view-pixi.js`; cache-buster `?v=5`, `DIAG.ver` → `2026-10-24.6`.

## 2026-10-24.5

- **Fixed: helicopter tap animations were silently gated out (PixiJS +
  canvas city views)** — every helicopter except Redstar plays a
  click-driven one-shot (`Active` or `Tap` filmstrip) instead of a toggle
  machine, but `animOf()` passed the huge-atlas exemption (strips decoded
  above 16M px) only to toggle transitions, so the police/attack/burns/
  geriatricpark/itchyscratchy/usblackops rotor strips (17–36M px) were
  rejected and clicks did nothing. All tap one-shots are click-driven, so
  they now ride the same oversize exemption as the toggle paths. The
  session cap of 4 huge atlases no longer deadlocks after the first four
  helicopters: when full, the oldest huge atlas that no building is
  mid-animation on is recycled (`freeHugeSlot()` in both `city-view.js`
  and `city-view-pixi.js`). The mirroredglobowarm Neutral *idle* loop
  (31M px) stays static by design — map-chosen loops keep the budget
  guard. Script cache-buster bumped (`?v=4`), `DIAG.ver` → `2026-10-24.5`.

## 2026-10-24.4

- **Fixed: sheared side faces on 3D building blocks (PixiJS city view)** —
  in block mode (Art off) the prisms' left/right faces were distorted
  parallelograms instead of vertical rectangles. `emitBlock()` fed
  `emitQuad()` the far bottom corner of each face as the third point, so
  the unit quad was spanned along the face diagonal; the roof is cyclic
  and was unaffected. Both side faces now pass the corner adjacent to the
  quad origin (matching the original's explicit 4-corner quads in
  `js/city-view.js`), and the selection/wire outlines from `blockPolys()`
  line up again. Script cache-buster bumped (`?v=3`) and `DIAG.ver` →
  `2026-10-24.4`.

## 2026-10-24.3

- **Fixed: PixiJS city view crashed at load (featC undefined)** — the page
  died with `TypeError: can't access property "children", featC is
  undefined` and nothing rendered. The Road-network toggle applies its
  persisted state while the script is still parsing (`applyRoadNetMode() →
  buildGround()`), but under PixiJS 8 the scene containers only exist once
  `app.init()` resolves and `makeScene()` runs. `buildGround()` now returns
  early until the containers exist; the boot sequence already re-runs it
  right after `makeScene()`, so the toggle state still lands. The page's
  script tag is bumped to `city-view-pixi.js?v=2` — browsers that cached
  the broken `?v=1` copy need the new query string (or a hard reload) to
  pick the fix up.

## 2026-10-24.2

- **PixiJS port of the City View workbench** — the Canvas2D + hybrid-WebGL
  city view (`web/city-view.html`) drops frames once the town fills in, so
  it now has a full reimplementation on PixiJS 8 at
  `web/city-view/pixijs/city-view-pixi.html` (open it directly from
  `file://` like the original). One Pixi canvas renders everything: the
  ground is a single Container whose per-frame matrix is `CAM.tileAffine`
  (grass tiling sprite, sea quad, feature quads, diamond-cleaned road sheet
  cells, manholes, avenues, zoomed-out flat atlas blits — placed once in
  tile space, never re-projected), the scene is a screen-space sprite pool
  refilled in depth order each frame (prism faces are unit quads driven by
  a `setFromMatrix` parallelogram; art sprites, bsv3 filmstrip anim cells
  and people dots are pooled sprites), and the debug overlays are per-frame
  `Graphics` + pooled `Text`. All chrome, toggles, panels, hit-testing,
  presets, orientation rig, tune panel, prop-street verdicts and console
  probes from `js/city-view.js` are ported; the DOM-free shared modules
  (`camera.js`, `terrain.js` data model, `objects.js`, `walks.js`,
  `markers.js`) are reused verbatim and `terrain.render()` is never called.
  Textures wrap `Image` elements (no `PIXI.Assets.load`) to keep `file://`
  compatibility, `localStorage` keys are shared with the old page so tuning
  carries over, and `vendor/pixi.min.js` (8.22.0) is vendored via npm — see
  `web/city-view/pixijs/README.md` for the vendor-update recipe. The port
  is WebGL-only — the legacy `?nogl=1` Canvas-renderer fallback is not
  offered. URL knobs (`?dpr`, `artS/artAx/artAy/artRef`, anim budget
  knobs) work the same as before.

## 2026-10-24

- **Rotated sprite blocks now anchor by transformed-bbox top-left (M4
  city art)** — during RedstarHelicopter's rotor spin-up/spin-down
  (`Active_In`/`Active_Out` tap strips) the blade pieces detached from
  their hubs, floating up to 161 px away, while the parked pose and the
  blur-disc loop looked fine. `_composite` in `tools/gen_city_sprites.py`
  placed rotated blocks by crop-origin (cell (0,0) corner at `(x,y)`,
  content spanning `(x,y)+M(u,v)`); the correct rule anchors the rotated
  content's **AABB top-left** at `(x,y)`. The two rules coincide for
  identity/scale blocks, so only rotated pieces (ramp frames, limbs,
  flags, waves…) move. Pinned by three independent checks on the
  helicopter rotor data: every rotated blade piece's content rect
  intersects its hub centre to 0–4 px across all angle groups (corner
  rule: up to 161 px misses); the same cell used identity-parked vs
  rotated predicts its stored anchor to 2–4 px only under bbox; and a
  per-cell pivot model is falsified by `C_Blade03_01`'s two rotation
  groups implying pivots 80 px apart. `BLOCK_NUDGE`'s lone
  `giantrobot` east-upperarm entry was this same offset read out by
  hand (`ry0 = b*w = −114.5`) and is retired — the official-menu-fit
  harness (`mapdump/registration/m4-east-nudge-fit.py`) now scores
  0.873 (was 0.848 with the nudge). Regenerated all statics (122
  manifest entries changed canvas/anchor) and re-rendered the 1601
  slugs with rotated blocks in their anim frames (strips are resumable
  — the manifest was pruned first to force them); three `Neutral`
  strips dropped by the longest-4 cut during the forced rerun
  (`aquaworld02`, `mcgrewsstovepipeoven`, `theactualnorthpoleflipped`)
  were re-rendered and restored. Evidence:
  `mapdump/registration/m4-redstarheli-{in219,in227,in251}-bbox.png`,
  `-spinup-bbox-strip.png`, `-blade-cells.png`,
  `-atlas-in{00,06,12,20}.png`, `m4-innstable-rayframe-bbox-compare.png`
  (the innstable ray frame also visibly improves — previously a severed
  horse head and a stray beam streak). No player change; hard-refresh
  to bust cached PNGs.

## 2026-10-23.4

- **Static sprites now use the engine's Neutral-pose default (M4 city
  art)** — `RedstarHelicopter` rendered as a mid-takeoff frame (rotor
  motion-blur discs) instead of its parked idle. The `sprites` pass
  picked each building's static frame by maximum painted area
  (`static_src: 'best'`), which favors animation frames whenever an
  effect frame is fatter than the idle; for the helicopter the
  `Active_In` sweep (area 1.18 M) beat the parked `Neutral` frame
  (0.64 M). `tools/gen_city_sprites.py` now prefers the `Neutral`
  anim's first frame — the same pose the engine itself promotes to
  the main file (tsto2rgb `neutral_atlas_index`) — via the previously
  unused `_neutral_frame_index`, falling back to max-area only when
  no neutral anim resolves. Regenerated the full required set: 3430
  manifest entries picked their neutral pose (993 with a new
  canvas/anchor, including `ziffcorphelicopter` and the other action
  -frame statics); evidence crops
  `mapdump/registration/m4-redstarhelicopter-{neutral0,activehead}.png`.
  No player change needed (anchors/canvas sizes come from the
  regenerated manifest); hard-refresh to bust cached PNGs.

## 2026-10-23.3

- **Character sprites: duplicate frames collapsed, pixel-aware idle
  selection (M4 item 5)** — many map characters showed the same sprite
  over and over and never visibly animated. Three causes, all fixed in
  `tools/gen_city_sprites.py chars`: (1) the picker counted frame
  *source references*, not pixels, so `bcell13` cells that repeat one
  `_image_N.rgb` across ticks (or ship byte-identical images under
  different tick names) counted as "animating" and shadowed the real
  `idleblink` variant — selection now scores candidates by distinct
  rendered content (`pix_distinct`), prefetching the candidates'
  companion images from the family packs first; a cell whose
  companions never shipped scores 0 and loses to art the map can
  actually show. (2) Blink loops shipped `[open, closed, open]` with
  the two eyes-open ticks byte-identical — pass 3 now merges
  consecutive duplicate frames (delays accumulate) and folds a
  trailing repeat of frame 0 into the leading one, which the looping
  player renders identically. (3) A dedup helper returned the last
  frame's image for every frame, turning 674 assets into frozen
  loops; fixed. Same-length name matches are also decided
  deterministically now (renderable cell first, then lexicographic),
  so re-runs stop flipping between twin cells. Result after
  regeneration: 809/1023 save characters → 756 assets, 0
  fake-animation assets (was 43), duplicate-file groups 969 → 86
  (all legitimate non-adjacent repeats inside long action loops), and
  698 placed characters cycle genuinely distinct frames. Characters
  still drawn as dots (121 in this save) are names whose art is not
  in any shipped pack (event/pet variants), not a pipeline bug.

## 2026-10-23.2

- **`bcell13` decoder — City View character coverage 119 → 809 (board
  task 19)** — the 4.x event packs store character art in a newer
  animation container (`bcell13`) whose frames are EXTERNAL
  `<cell>_image_N.rgb` files in the same pack; the pipeline could only
  read `bcell10`'s inline pixel blocks, so 13,652 pool cells — nearly
  the whole 4.x cast — rendered as nothing. `tools/extract_assets.py`
  gained `parse_bcell13` (frame = image name + delay + tint + layer
  list; the first layer's floats place the sprite relative to the
  character engine origin — verified to exact EOF on all 13,652 pool
  cells; spec in `notes/01-binary-formats.md`). `gen_city_sprites.py
  chars` now admits bcell13 cells (ranked below any renderable bcell10,
  so core art never regresses), harvests the referenced companion `.rgb`
  files ON DEMAND — batched per family pack via the pool index,
  persisted into the pool — and renders them with float-precision union
  bounding boxes. `choose()` now counts DISTINCT frame sources, so a
  cell that repeats one image over several ticks no longer blocks the
  blink-loop upgrade (ArtieZiff: 2 identical ticks → real 3-frame blink).
  `characters.json` regenerated: **809/1023 save characters mapped
  (was 119), 757 assets, 749 animating** — 214 names remain unmatched
  (NPCs with no art in any pack). No renderer change; the manifest
  format is unchanged. Evidence: `mapdump/registration/m4-char-b13-sheet.png`
  (14 bcell13 loops + Homer/Marge bcell10 controls, ground baseline
  through each anchor). `bcell11` (289 pool cells) stays an undecoded
  lighter variant, deliberately out of scope.

## 2026-10-23

- **Characters idle-loop on the map + duplicate-sprite fix (M4 TODO item
  5)** — two causes, two fixes. (1) *Duplicates*: the save instantiates
  119 named characters but `chars` rendered only 53 poses, so variant
  names (25 Homers, 9 Barts…) all fuzzy-matched onto the base
  character's static pose; worse, the core pack's `<name>_idle` bcell is
  a **single 666 ms pose** — the real animated loops ship as separate
  `<name>idleblink`-style cells in the pool that nothing ever selected
  (and the longest-stem-wins fallback even pinned characters onto one-off
  scene art: Duffman looped a 153-frame promo, Maggie drew as walking
  Marge). `do_chars` now upgrades every match to a dedicated
  idle/blink cell: `<stem/name>`+idle-suffix candidates first (motion
  stems — walk/run/victory/pose — excluded so nothing moonwalks in
  place), then any `idle`/`blink` stem referencing the name, most frames
  wins. `characters.json` v3: **111/119 mapped characters now animate**
  (32 real blink loops; the remainder keep the best multi-frame art they
  have). Remaining duplicates (Homer-variant x25) are honest until the
  4.x event packs decode — those costumes are `bcell13` containers,
  already parked work. (2) *Playback*: `city-view.js` (v28) drew
  `frames[0]` forever; both people paths (`drawPeopleArt` 2D +
  `buildPeopleQuads` GL) now cycle the manifest frames on their own
  delays, phase-offset by a hash of the character id so the crowd does
  not blink in lockstep. Gated behind Art+Anim toggles and a 24 px
  legibility floor (`?charAnimMinPx=N`); `charAnimLive` joins `animLive`
  in the dirty-driven repaint scheduler, and `__CV_DIAG.charAnims` (new)
  reports the count. Files: `tools/gen_city_sprites.py`,
  `web/js/city-view.js` (`?v=28`), `web/city-view.html`,
  `tools/smoke-city-view-dom.cjs` (3-frame char seed, two new checks).
  Evidence: `mapdump/registration/m4-char-idle-sheet.png` (first 8 idle
  loops, frame-by-frame).

## 2026-10-21.10

- **GL atlas shelf cursor never advanced — every sprite sampled one cell
  (`?v=27`)** — the real cause of the still-open "sprites messed up and
  overlapping on first load" report. The live `__CV_PROBE()` showed 185
  sprite quads sampling **2 distinct atlas cells**: `aglCell` packs a cell
  at the shelf cursor (`agl.cx`, `agl.cy`) and handles row-wrapping, but
  never executed `agl.cx += cw + 2` after packing — so *every* cell
  landed at (2,10), each new sprite overwriting the last, and every
  billboard (prisms were fine — they sample the white block at (0,0))
  painted the single image that won that slot. 2D paths draw straight
  from the decoded PNGs, which is why `?nogl=1` and the click-to-2D
  fallback looked correct. The packer now advances the cursor by cell
  width + guard borders. The DOM smoke grew a `--gl` child run (auto-
  spawned by the main run): a fake renderer captures `drawTop` state with
  8 seeded sprites around the boot camera, and checks the packer gives
  every cell its own slot and that sprite quads sample >= 4 distinct
  cells — it reports `cells=8 slots=1 / distinctU=1` on the pre-fix
  code. `__CV_VER` 2026-10-21.10. Files: `web/js/city-view.js`,
  `tools/smoke-city-view-dom.cjs`.

## 2026-10-21.9

- **`__CV_PROBE()` console probe (`?v=26`)** — the live report for the
  still-open first-load GL-sprite bug (atlas stuck at 55 cells while
  `GL·bld` draws 5,261 buildings) needs to know what the top pass
  actually submits, which is invisible from the outside. One console
  call now rebuilds the current frame's quad streams and returns the
  breakdown: build sprite quads vs prism quads, people quads vs dots,
  distinct atlas cells sampled, atlas state (`n/full/dead/dirty`),
  manifest/asset-loader state (`citySprites`/`charMan` loaded, pending/
  got/dead/known art), and the first 40 atlas keys. Side-effect-free
  apart from doing what every render frame already does (quad build +
  budgeted atlas packs).

## 2026-10-21.8

- **GL sprites garbled on first load, fixed by any click (`?v=25`)** —
  the WebGL top pass (`drawTop`) re-applies the program/blend/attrib
  state that a drawing-buffer resize drops, but had forgotten one item:
  `UNPACK_PREMULTIPLY_ALPHA_WEBGL`. On load `#glcv` is resized from its
  300x150 default, which resets that flag to false, and the atlas
  `texImage2D` on that same frame uploads the sprite page as straight
  alpha while the solid program blends premultiplied — every
  semi-transparent sprite pixel composited at full colour, so the whole
  city looked like overlapping washed-out blobs. A left-click only
  "fixed" it by selecting something, which makes `glBuildBlock` refuse
  GL and fall back to the correct Canvas2D sprite path. `drawTop` now
  re-sets the unpack flag every frame (parity with `draw`, which always
  did). Also fixed a stale-tail case in `aglUpload`: when new atlas
  cells packed inside the 250 ms re-upload throttle and the last image
  load then went quiet, no further frame was ever requested and the
  final batch of cells never reached the GPU — a throttled upload now
  marks the view dirty so a follow-up frame completes it. Files:
  `web/js/gl-base.js` (`?v=13`), `web/js/city-view.js` (`?v=25`,
  `__CV_VER` 2026-10-21.8).

## 2026-10-21.7

- **All engine click-state-machines animate (`?v=24`)** — finishes the
  class of dead vehicles/props from yesterday's helicopter fix: the
  remaining generic controller families (`Generic_Three_Way_Toggle0102`,
  `GenericActiveNeutral_Toggle`, `GenericInOut_Toggle`, four-way, …) now
  click through their states on the map too. The generator no longer
  hardcodes the one trio it knew: `_scan_controllers()` parses the packs'
  `buildingcontrollers.xml` `<Sequence>` elements directly into three
  machine shapes — `inout {in,loop,out}` (ActiveIn/ActiveOut transitions
  + State 0/1 hold), `active {loop}` (State 0 static/Neutral, State 1
  loops), and `cycle {poses[]}` (ToggleState 0..N, one pose loop per
  click) — 21 machines parsed. Sequences with `Land::`/`System::`
  conditions (game-state-driven, e.g. `EspionageMode_*`), branches that
  don't select exactly one anim, and `_Tap`-suffixed names (the tapVerb
  path already gates those) are deliberately skipped. A machine is only
  gated when the building's BuildingTouched script actually
  `setObjectVariable`s the machine's driving variable — the behaviour
  scan now records each tap script's set-variables as `tapVars` (cache
  bumped to **version 3**, forcing a re-scan), so clicks can never strand
  a building on a pose the engine would never advance to. Conservative
  strip rules: `cycle` requires every non-zero pose strip to exist
  (ChokeCam's missing `Toggle02` → no click gate), `inout` may lack its
  `Active` loop (SensoryDeprivationTank) and then holds In's last frame
  while active, matching the engine. A machine's state 0 IS its Neutral
  anim, so that strip now also gates as the ordinary idle loop even when
  the controller name is generic (+43 idle loops, e.g. DronePack's
  30-frame Neutral idles at rest). Totals: **121 toggle slugs** (106
  inout, 13 cycle, 2 active) and 681 idle loops in
  `city-anims.json`'s behavior gate. The map player's togglers are
  kind-aware (`animOf` blits pose/state strips, `tapBuilding` flips or
  advances per kind, one-shot re-click guard kept for `inout`), the
  details card describes each shape (`Neutral → Toggle_02 → Toggle_01`
  etc.), and a new harness probe `__CV_TOG_strip(mi)` reports which
  strip the current state renders. The DOM harness pins the generator's
  gates for k9unit/lobster-scorpion/deprivation-tank and drives all
  three shapes end-to-end (pose wrap-around, active on/off, In-hold,
  Out-return); the `active` kind runs on a synthetic gate because the
  real one sits 8 tiles from another seed's camera — ALL CHECKS PASSED.

## 2026-10-21.6

- **Click-to-animate for the engine's built-in toggle class (`?v=23`)** —
  a big slice of the map looked dead: ~57 decorations (RedstarHelicopter,
  OilWell, TowerOfTetanus, DuffGardensStage, …) never animated at all,
  idle *or* on click. The behaviour scanner only understood two engine
  patterns — a controller whose `name` is a bsv3 anim, and a
  BuildingTouched script with an `anim-play` step — but this class uses
  neither: the building declares the engine-builtin state machine
  `<NeutralAnimationController name="GenericActiveInOutNeutral_Toggle"/>`
  and its tap script (`DecorationTapped_WithActiveInOut`) only sets the
  `ActiveIn`/`ActiveOut` object variables that controller consumes. Both
  gate fields resolved to null, so the map had nothing to loop and
  nothing to play on click. Now the generator recognises the generic
  controller (`_toggle_anims`) and emits a per-slug
  `toggle: {in: Active_In, loop: Active, out: Active_Out}` record (35
  slugs gated, resolved only when all three strips exist); the map
  player sits those buildings static at Neutral, plays the `in`
  one-shot on click then loops `loop`, and the next click plays `out`
  back to static — re-clicks while a one-shot is playing are ignored,
  matching the engine's ActiveIn/ActiveOut guard. Click-driven oversize
  filmstrips (the helicopter's `Active_Out` is 45 Mpx) are exempt from
  the 16 Mpx map decode cap — the detail card has always decoded them,
  and here every oversize load is a user request — under a small
  session cap (`ANIM_HUGE_MAX = 4`, freed on LRU eviction). The
  helicopter class now matches the other click-to-play vehicles; the
  remaining generic controller families (`GenericActiveNeutral_Tap`,
  `Generic_Three_Way_Toggle…`) are still untouched. Gate display shows
  `click in → loop → out (toggle)` in the details card; new harness
  probe `__CV_TOG(mi)`. Regenerated `city-anims.json`'s behavior gate
  (`gen_city_sprites.py behavior --write-map`); the DOM harness seeds
  the save-placed helicopter and checks the whole neutral → in → active
  → out → neutral cycle plus the oversize blit — ALL CHECKS PASSED.

## 2026-10-21.5

- **Escalator riders animate + front-panel occluder layers (`?v=22`)** —
  two follow-ups to the layered-animation fix. (1) The rider layer
  (`Characters`, 48 cells of mostly-transparent 1186×2399 art) blew the
  player's 16 Mpx decode gate, so the people never appeared. The generator
  now cluster-rect-packs oversized layer strips (`_pack_sparse`): each
  frame's opaque figures are packed as small rects into one shelf atlas
  and the manifest entry carries `sparse:1` + `sub[]` (per-frame source
  rects with anchor-relative offsets); the escalator's rider atlas went
  139 Mpx → 2.1 Mpx and plays in the free decode tier. Both render paths
  blit per-rect (`animCell` sizes sparse entries by the atlas itself).
  (2) The animated steps painted over the escalator's front-facing skirt:
  the engine hides that art in `StairsOV`, a zero-width (single-frame)
  range the generator had been dropping. Declared `<AnimationLayerOrder>`
  parts now ship even as 1-frame static layers (`StairsUL`, `StairsOV`),
  so the map composites body → StairsUL → Stairs → Characters → StairsOV
  exactly like the engine's frame-0 block order; evidence crops in
  `mapdump/registration/m4-esc-order-compare.jpg`. A layered stack is now
  drawn whole or not at all (one gated part would smear the composite —
  the body-only fallback is the correct static look), and layered cells
  get a body-relative size cap since they legitimately reach body size.
  Regenerated: `escalatortonowhere(+flipped)` strips + behavior map;
  harness seeds all four layers (statics included) — 122/122 checks pass.

## 2026-10-21.4

- **Full CDN archive decoded — all 510 bundles in the Explorer inventory** —
  the batch sweep of every local `cdn/*.7z` bundle finished: **3,562,506
  manifest entries** from 21,885 unique packs, one HTML report per bundle in
  `notes/dlc-extraction/` (plus the `index.html` hub). The final webdata
  phase the overnight run was OOM-killed inside was completed by a scoped
  finisher (`--fast` batch runs never built it): `dataText` now embeds only
  CORE (non-dlc) data files, and the 1,450,647 dlc text/data entries are
  flagged `textOmitted` — the Explorer shows its "(text not embedded — open
  &lt;path&gt;)" placeholder for them instead of shipping a multi-GB blob.
  All assets stay reachable on disk under `web/assets/dlc/…`.
- **`manifest.js` split into parts + dual-mode loader** — at 2.1 GB the
  single `window.MANIFEST` script exceeded V8's ~512 MB string cap, killing
  both the node smoke suites (`ERR_STRING_TOO_LONG`) and any browser parse.
  `manifest.js` is now a small loader over 14 ~150 MB entry parts in
  `assets/manifest-parts/` (browser: synchronous `document.write` script
  tags; node: direct `require()`), flattened into `window.MANIFEST` with
  the head metadata (pack list, languages) kept inline. The Explorer page
  loads again but is heavy at this entry count — season chunking and grid
  pagination are board tasks #16/#17.
- **Smoke suites updated for full-archive data shapes** — the core-era exact
  counts now assert the non-dlc set only (DLC legitimately adds 10 music
  tracks + 9 fonts); the movie check asserts the structural invariant that
  actually holds ("if any variant of a base movie is device-classed, all
  four device tiers ship") instead of a hard-coded 4×4 grid, since event
  cutscenes ship many mp4s per pack or none; the anim delay ceiling moved
  5 s → 10 s (the Halloween Shadows event loops idle ~5.8 s between cycles);
  and the DOM suite now runs its UI-behaviour checks over a bounded
  stratified subset (~135 k of 3.56 M entries — one tile per pack, all
  audio/anim/video/font, stride samples of the image/data bulk, plus one
  guaranteed multi-tier family so the variant-row check keeps real
  siblings), with full-set integrity left to the data suite. Both green.

## 2026-10-21.3

- **Layered animation for assets with no controller loop (escalator fix)** —
  the EscalatorToNowhere never moved in City View: its bsv3 has no `Neutral`
  loop, so the .27 behavior gate resolved its idle to nothing and the map
  drew the static PNG forever. The engine actually animates it as stacked
  **part loops** — its `<AnimationLayerOrder>` composites `Stairs` (the
  steps) and `Characters` (the riders) over the body. The generator now
  scans that table (`_scan_layer_orders`, cached as `layers` in
  `data/building_behaviors.json`, cache bumped to version 2), and when an
  asset's idle resolves to nothing its part loops are forced into the film-
  strip batch and recorded as `behavior[slug].layers = [anim, …]` in draw
  order. The map player keeps the static body PNG and blits every in-gate
  layer cell over it (2D and GL paths; over-cap layers skip individually,
  so the escalator's 139 Mpx rider strip stays gated while the 3.9 Mpx
  stairs loop plays). 16 slugs gain layers — escalator ±flipped,
  OldEnglishStation, TetanusTerminal, CountyFairSign, ItchyScratchyGate
  (both animate via their sibling part buildings' controller anims),
  DarkAlley, PortalGate, Whale, HomerWhale, NorthwardMonorailBridge,
  YellowSubmersible (its missing `SubmersibleTop` strip was generated).
  Flipped instances now animate too: strips resolve by the DRAWN key
  (`slug`/`slug+flipped`), closing a latent gap where a mirrored building
  silently kept the unmirrored — or no — filmstrip. New
  `behavior --write-map` flag regenerates just the gate without atlas
  work; the details card shows `part loops Stairs + Characters`; smoke
  suite extended with a layered-seed regression that pins the escalator
  itself (body drawn, Stairs blits, Characters gated) — 122/122. Cache
  bump: `city-view.js?v=21`.

## 2026-10-21.2

- **Stale behavior cache fixed the FortuneTellerMachine no-tap** — tapping
  the fortune-teller machine played nothing because `data/building_behaviors.json`
  had been scanned from 190 gamescripts packs while the DLC tree now holds
  **438** (new r48x/r49x revisions landed after the last scan), so ~540
  buildings — its def lives in the tragicmagic-era packs, where
  `BuildingTouched` runs the shared `DecorationTapped_SingleTap_Wait`
  script (`anim-play animation="Tap"`) — resolved to nothing.
  `load_behaviors` now records the pack count it scanned and
  **auto-rescans when the pack set changes**, so freshly extracted DLC
  can never silently under-resolve again. A full re-scan yields 1691
  buildings / 580 with tap anims (was 1149/358).
- **Strips literally named `Tap` count as tap anims without a binding** —
  assets whose def never shipped an `OnEvent` but carry a `Tap`-named
  bsv3 range (the authors' own tap convention, cf. the `Tap` script verb)
  now register it as their click-to-play anim (`_fallback_tap_anim`,
  generator-side so the web player never points at a missing atlas).
  Regenerated `city-anims.json`: 636 slugs loop / 494 are click-to-play /
  1553 static; in the save 442 keep looping, 236 (was 111) now animate on
  click — FortuneTellerMachine among them. No web-side change (manifest +
  generator only); smoke suite 118/118.

## 2026-10-21

- **Clicking a building's lot now plays its tap anim** — the click
  hit-test only claims a block's drawn prism faces (roof + two sides), so
  a click on a lot tile — especially the strip of ground behind a tall
  building's roof, or the tiles a big sprite stands on — fell through to
  the ground-tile picker and no tap anim played. The real game lets you
  touch a building anywhere on its lot, so a ground click inside a
  visible block's tile footprint (`blockAtTile`, front-most block wins,
  hidden legend buckets ignored) now counts as a BuildingTouched: the
  building's one-shot tap filmstrip plays and reverts, while the tile
  selection behaves exactly as before. Taps also fire on re-clicking an
  already-selected tile (the check moved before the deselect collapse).
  New probes `__CV_TAP_at(tx, ty, fire)` and `__CV_TILE_screen(tx, ty)`;
  smoke harness gained lot-rule regressions (probe + a real canvas click
  through the stage handler). `city-view.js` cache-busted to v=20.

## 2026-10-20.27

- **City View animation now behaves like the real game: controller anims
  loop, tap anims play on click** — the map played every asset's longest
  filmstrip unconditionally, so buildings that only animate when tapped in
  TSTO (LadyJusticeStatue is the canonical case: its sole strip is the
  tap-only `Active`) sprayed forever. The engine's actual model was RE'd
  from the gamescripts packs: an asset loops the anim named by its
  `<NeutralAnimationController>`/`<ActiveAnimationController>` or
  `<BSv2 neutralAnim>` (engine default `Neutral`), and everything else
  plays once from the `<OnEvent event="BuildingTouched">` → script →
  `<Action type="anim-play">` chain ("NoLoop" is playback semantics, never
  part of a bsv3 anim name). `tools/gen_city_sprites.py` gained a
  `behavior` subcommand that scans all 190 extracted gamescripts packs
  (cached in the new `data/building_behaviors.json`, ~1 min; `--refresh`
  after new DLC) and resolves 1149 buildings (358 with a tap anim); the
  `anims` step now forces filmstrips for both the idle and tap anims of
  every slug and writes a `behavior` map (`slug → {idle, tap}`, verbs
  resolved to real bsv3 names, `_Base` part-suffix matched) into
  `city-anims.json` v2. `web/js/city-view.js` loops ONLY the idle anim and
  plays the tap strip once on click (budget-exempt one-shot, then reverts
  to idle), and the details card grows an "engine anims" row showing each
  building's idle/tap. In the save: 502 slugs keep looping, 111 became
  click-to-animate, 962 went static; the golf fountain's Neutral spray
  (.25) is unaffected. Smoke harness seeds the behaviour map and asserts
  the full tap lifecycle (start → blit → revert → idle resumes); new
  console/harness probe `__CV_TAP(mi, fire)`. v1 manifests (no behavior
  key) keep the old longest-loop behaviour. `city-view.js` cache-busted
  to v=19.

## 2026-10-20.26

- **Planning: new Phase 3 stub with the in-game UI scope** —
  `planning/phase-3-playable-core.md` (indexed in `planning/README.md`)
  seeds the playable-core phase with the interface-asset work that had
  never been milestone-scoped: the pack taxonomy for `*Menu-*` UI packs, a
  pointer to the full inventory (`mapdump/registration/m4-ui-asset-inventory.md`,
  ~10,200 deduped UI files in 22 element families), the existing RE leads
  (`BGMenuCmds`, `OffersData.proto`, `notes/05`), six candidate work items
  (UI asset pipeline, shell skin, dialogue boxes, store screen, status
  indicators, open questions), and an explicit note that no milestones are
  committed yet — user scoping needed.

## 2026-10-20.25

- **GolfCourseFountain now animates in the boot view** — the map's
  animation readability floor (`ANIM_MIN_PX`, `web/js/city-view.js`) was
  lowered 64 → 48 screen px. The golf fountain's Neutral spray loop has
  the smallest filmstrip cell in the catalogue (185×134); at the boot
  zoom (SpringfieldDowns fit, k≈0.45–0.65 depending on window height)
  that 134 px region renders at ~60–85 px, so the old 64 px floor parked
  it as a static PNG until the user zoomed in — other fountains (next
  smallest cell 332 px) cleared it with room to spare. 48 keeps overview
  zoom parking fountains/decor static (134×0.34 ≈ 45 still parks) while
  letting the boot-view spray read; a catalogue scan shows no other asset
  changes tier at 48. `?animMinPx=N` and `__CV_ANIM_minPx()` still tune
  it live. `city-view.js` cache-busted to v=18.

## 2026-10-20.24

- **Filmstrip decode caps re-tiered (DuffMcSharkTank fix)** — the
  2026-10-20.22 blanket 6 Mpx filmstrip cap silently froze ~2/3 of the
  animated catalogue on the map (657 of 992 assets exceed it: shark tank,
  lighthouses, big landmarks), while the sidebar details card — which has
  no gates — kept playing them, exactly the asymmetry reported for
  DuffMcSharkTank. Caps are now two-tier: filmstrips up to
  `ANIM_MAX_ATLAS_PX` = **16 Mpx** animate on the map (raises coverage
  34% → 59%); above 6 Mpx they draw from a per-session budget of at most
  **8** big decodes (`ANIM_BIG_MAX`), and decoded filmstrips beyond **40**
  are LRU-evicted (`ANIM_CACHE_MAX`) so a long pan can't pile up GBs —
  previously decoded filmstrips were cached forever. Over 16 Mpx stays
  static on the map (the details card still plays it). New console probe
  `__CV_ANIM_stats()`. Files: `web/js/city-view.js`,
  `tools/smoke-city-view-dom.cjs` (big/giant seed checks).

## 2026-10-20.23

- **Statsbar carries the animation/atlas telemetry (diagnostic)** — the
  perfread readout now appends `· aN/M` after the ms figure: `N` =
  filmstrip sprites actually blitted last frame (0 = the gates parked
  everything), `M` = GL sprite-atlas cells packed, with a trailing `F`
  when the atlas page is full. This is what distinguishes the remaining
  overview-zoom stall causes: an `N` that should be 0 (gates not
  engaging), or a `M` climbing / `F` while the view is still (filmstrip
  cells churning the shared atlas → repack/upload storm). No behaviour
  change. File: `web/js/city-view.js`.

## 2026-10-20.22

- **Animation readability floor + decoded-filmstrip cap (overview-zoom
  stall)** — at zoom 0.33 the sprite LOD path was still blitting animated
  cells for hundreds of buildings, because `animOf` only refused cells
  whose SHORT edge fell under 12 screen px (far too permissive: at
  0.33 a 185×134 fountain cell is still 60 px). Two hard gates now park
  filmstrips when they can't pay their way: (1) `ANIM_MIN_PX` (default
  64, `?animMinPx=` / `__CV_ANIM_minPx()` to tune) requires the cell's
  short edge to span ≥ 64 screen px to animate — below that the prop
  draws its plain static PNG and never enters the GL atlas, which is the
  real fix for the unusable overview-zoom crawl; (2) `ANIM_MAX_ATLAS_PX`
  (6 Mpx) skips any loop whose decoded filmstrip is a multi-tens-of-Mpx
  source (giant lighthouse beams, big gear trains) so those can't stall
  the GPU upload even up close. Smoke checks cover both sides of the
  floor (overview parks the fountain, rest-zoom replays it) and the
  seeded asset now picks one that passes the gates. Files:
  `web/js/city-view.js`, `tools/smoke-city-view-dom.cjs`.

## 2026-10-20.21

- **Animation cost gates: viewport rect + per-frame blit cap** — with
  Anim on, every animated sprite past the viewport edge still blitted a
  ~1000 px slice of a multi-thousand-px filmstrip (the tile cull lets
  buildings up to 6 tiles past the screen through, which at deep zoom is
  far off-canvas), each one also counting as "live" and keeping the
  whole scene repainting at ~12 fps. The 2D path now gates on the cell's
  DEST rect (fully outside the viewport, or oversized > 2048 px drawn:
  draw the static PNG instead), the GL path downgrades oversized filmstrip
  cells to the static quad so one big lighthouse-beam cell can no longer
  trip the "too big for the atlas" scan and drop EVERY building into the
  slow Canvas2D fallback, and a shared per-render blit budget
  (`ANIM_MAX_BLITS`, default 96, `?animMax=N` / `__CV_ANIM_max(n)` to
  A/B live) caps animated blits per frame — past it props draw their
  static PNG while the few on-screen heroes still play. New smoke checks:
  off-screen buildings don't animate, back-in-view resumes, cap at 0
  pins everything static, raising it replays. Files: `web/js/city-view.js`,
  `tools/smoke-city-view-dom.cjs`.

## 2026-10-20.20

- **bsv3 loops play in-place on the City View map** — clicking a building
  to see its fountain spray was the only place animations played; now the
  Art layer itself animates. `city-view.js` fetches
  `assets/city/city-anims.json` alongside the sprite manifest and, when an
  animated slug draws above the 12 px readability gate, blits the current
  filmstrip cell (source-rect `drawImage`) at the building's own ground
  anchor instead of the static PNG — in BOTH art paths: the Canvas2D
  `drawSprite` pass and the GL atlas, where each frame packs as its own
  shelf cell (`aglCell` gained a sub-rect argument). Instances share one
  clock per rendered frame but carry a deterministic per-building phase
  (hashed from the ground pin), so a row of fountains ripples out of
  step; loops are the longest named anim per asset (city-anims.json).
  Since the scene is dirty-driven, a frame that painted any animated
  sprite schedules the next repaint at ~12 fps, and the loop stops itself
  when nothing animated is on screen. New **Anim** view-bar button
  (persisted via `mrsnrub.cityview.anim`, default on) falls back to static
  PNGs; `__CV_DIAG.anims` reports the filmstrip count and the harness
  covers registry, clock, repaint cadence and toggle. Flipped twins (no
  filmstrip generated) keep the static sprite. `gen_map_explorer.py` now
  also carries the loop `ax`/`ay` into `MAP_DATA.variants`. Files:
  `web/js/city-view.js`, `web/city-view.html`, `tools/gen_map_explorer.py`,
  `tools/smoke-city-view-dom.cjs`.

## 2026-10-20.19

- **Animation atlas cells fixed (anchor-space union bbox)** — the
  `anims` atlases from .18 sized each cell from the asset's static PNG
  and centred the frame ANCHOR in it, so assets whose art hangs above
  the ground pin (GolfCourseFountain: anchor ay 277 vs canvas h 225)
  rendered with the spray chopped off the top and dead space at the
  bottom — in the atlases and in the City View/Map Explorer players.
  Each loop's cell is now the union bounding box of all its frames
  expressed in ANCHOR space (anchor kept at a fixed cell point, cell
  grown to cover the tallest spray/base), and the loop's frames render
  in a cheap first pass to measure it; `city-anims.json` entries gained
  the cell's `ax`/`ay` anchor. Verified for the fountain: the static
  sprite and the Neutral/Tap cells pin to the same ground point
  (`mapdump/registration/m4-anims-fountain-anchor-check.png`), the cell
  is tight (Neutral 185×225 -> 185×134), and the smoke player checks
  pass. The full `--placed` regeneration was cancelled part-way per the
  user — 498 placed assets / 1,000 atlases (1.5 GB) currently carry the
  corrected loops (179 half-written orphans removed); re-run
  `python3 tools/gen_city_sprites.py anims --placed` any time to
  finish the rest (it resumes, skipping completed assets). Files:
  `tools/gen_city_sprites.py`, `web/js/map-explorer-data.js`.

## 2026-10-20.18

- **bsv3 building animations play in the details cards** — assets whose
  `.bsv3` scene encodes a real animation (named anim ranges spanning >1
  distinct frame, e.g. GolfCourseFountain's 120-frame `Neutral` water
  cycle + `Tap` cycle) now show a live player tile in the Map Explorer /
  City View variant strip: a canvas cycling the frames with play/pause,
  a 1x/2x/4x speed toggle, and one tile per named loop. bsv3 stores no
  frame timing, so loops play at 12 fps (constant `ANIM_FPS` in the
  generator). New generator mode
  `tools/gen_city_sprites.py anims [--slug X] [--cap N] [--placed]`
  renders every named loop (frames deduped, thinned to 48, drawn with
  the existing per-frame compositor `_composite`, anchor-centred cells)
  into filmstrip atlases under `web/assets/city/anims/` + the
  `city-anims.json` index; `gen_map_explorer.py` merges those into
  `MAP_DATA.variants` as kind `'anim'` rows, and `asset-variants.js`
  grew the canvas player (static tiles unchanged). Batch run with
  `--placed`: 1,608 placed assets, 3,348 atlases (4.6 GB) — 1,575 of the
  save's assets now animate; the 142 `0x0303` landmarks are skipped (the
  shared-pool frame section is not decoded yet, notes/01). Evidence
  contact sheets: `mapdump/registration/m4-anims-*.png`. Smoke gained
  the GolfCourseFountain player checks (canvas sizing, play/pause,
  speed cycle, atlas metadata). `asset-variants.*` bump to `?v=3`,
  map/city assets to `?v=3`/`?v=12`. Files: `tools/gen_city_sprites.py`,
  `tools/gen_map_explorer.py`, `web/js/asset-variants.js`,
  `web/css/asset-variants.css`, `tools/smoke-map-explorer-dom.cjs`.

## 2026-10-20.17

- **Matt Selman tie-in decoded; 3_0_30 report published** —
  `cdn/3_0_0r5_TieInMattSelman.7z` (Matt Selman tie-in / "Cool Homer") is
  now through the pipeline: 22 inner zips submitted, 19 decode (3 of the
  `TieInMattSelmanGame-*-r146180` revision zips are empty stubs EA shipped
  with no files inside) — 377 new manifest entries (182 images, 150
  `.bcell` anims: **homer** in his coolhomer outfit, 50 states incl.
  left/right variants of `act_superior`, `enjoy_a_duff_blue_ribbon`,
  `listen_to_indie_rock`, `show_off_your_fixie`, `style_goatee`; 45 data
  files), zero decode errors; DLC pack total 259 → 278.
  `notes/dlc-extraction/3_0_0r5_TieInMattSelman.html` published.
  `3_0_30.7z` was already decoded from earlier batch runs; its report is
  published as `notes/dlc-extraction/3_0_30.html` (101 packs, 13,741
  entries; its `librarygame-*-r146180` zips are the same kind of empty
  stubs). `tools/dlc_report.py` gained two things for this: old-style
  `-v<season>` zip names now map to their manifest pack names (so original
  zip + publish date show), the summary lists bundle zips that decoded to
  nothing, and frame strips are capped at 12 frames per animation on
  seasons with >500 animations so the HTML stays openable.

## 2026-10-20.16

- **Tie-In Mike Price DLC bundle decoded + report** —
  `cdn/3_0_0r4_TieInMikePrice.7z` (the 2012 Mike "Hammer" Price tie-in) is
  now through the pipeline: all 11 inner packs (`TieInMikePriceGame` tiers
  100/50/25 + `TieInMikePriceMenu` four device tiers with base and r146180
  revisions) decode into `web/assets/dlc/` — 76 new manifest entries
  (40 menu images, 33 `.bcell` anims: the **fattony** character's 11 states
  incl. `play_the_violin_*` and `get_rid_of_a_problem_*`, 3 xml data
  files), zero decode errors; DLC pack total 248 → 259. Report published
  at `notes/dlc-extraction/3_0_0r4_TieInMikePrice.html` via
  `tools/dlc_report.py`, images referenced in place from `web/assets/`.

- **Explorer DOM smoke: case-insensitive breadcrumb compare** — the DLC
  family and Animations character breadcrumb checks lowercased the crumb
  text but compared it against the original-case name, so the first
  CamelCase family (`TieInMikePriceGame`) false-failed the suite. The
  comparison now lowercases both sides; explorer itself was rendering the
  name correctly. File: `tools/smoke-explorer-dom.cjs`.

## 2026-10-20.15

- **Thanksgiving 2012 DLC bundle decoded + HTML asset report** —
  `cdn/3_0_0_Thanksgiving.7z` is now run through the asset pipeline: all
  34 inner pack zips (`channel6game`/`channel6menu`/`thanksgivinggame`/
  `thanksgivingmenu`, all tiers and CDN revisions) decode into
  `web/assets/dlc/` — 904 new manifest entries (676 images, 72 `.bcell`
  character anims for `bumblebeeman` + `kentbrockman`, 156 bsv3/xml data
  files, ~8 MB), zero decode errors; DLC pack total 214 → 248.
  `tools/run_dlc_batch.py` learned the newer bundle layout (zips stored in
  a folder named after the bundle, without the `-v<season>` suffix — the
  season now comes from the containing directory), so the same driver also
  covers future 4.x event bundles. New `tools/dlc_report.py <season>`
  generates a standalone inventory report into `notes/dlc-extraction/`
  (`3_0_0_Thanksgiving.html`, named after the season/bundle), with
  per-family/pack tables with tier/revision/indexVersion,
  original zip names + publish dates from the `.zip.time` sidecars, image
  grids, frame-strip animation previews, and data-file listings — images
  are referenced in place from `web/assets/dlc/…`, not copied. Verified
  with both explorer smoke suites.

## 2026-10-20.14

- **City View "mark tiles" starts empty** — the marker textarea no
  longer seeds with the five sample river cells; the map opens with no
  marks. A previously persisted textarea value (`mrsnrub.cityview.markers`)
  still wins, so an existing session's marks are unaffected — clear the
  box once to go blank for good. File: `web/js/city-view.js`
  (`MARKER_SEED` now `''`).

## 2026-10-20.13

- **Sprite variants in the details cards** — clicking a building in Map
  Explorer or City View now appends a "Sprite variants" thumbnail strip
  under its details card for every asset that ships more than one sprite.
  Tree01, e.g., shows four tiles: the full-res city composite, the
  `tree01_transimage` alpha sidecar (game-100 tier), the `tree01_menu`
  build-menu icon, and the THOH `tree01_holo` variant. Tiles render on a
  checkerboard (alpha visible), carry a data-tip naming file/kind/tier/px,
  and deep-link into the Asset Explorer, which gained a
  `?path=<manifest path>` deep link to open preselected. The index is
  generated: `tools/gen_map_explorer.py` reads `web/assets/manifest.json`
  + the `web/assets/city/` composites and emits `MAP_DATA.variants`
  (slug -> one representative per kind: sprite, transimage, menu, holo,
  flipped; city art wins, then the main `game` pack, then event packs,
  then menu packs, largest tier first). 2,234 assets have extra sprites.
  New files: `web/js/asset-variants.js` (shared strip renderer),
  `web/css/asset-variants.css` (shared styles for both pages). Smoke
  covers the Tree01 strip end-to-end; map assets bump to `?v=2`, city
  assets to `?v=11`.

## 2026-10-20.12

- **Art mode is GL-always** — removed the deep-zoom hard cutoff
  (≥ 24 px/unit used to force 2D). Added a 1024 px atlas tier, so at
  close zoom ordinary sprites (≤ ~1000 px painted) render through GL
  crisp, not blurry. The per-frame scan now keeps the 2D sprite path
  only when a sprite is PAINTED LARGER than 1536 px on screen (its
  1024 cell would be upscaled >1.5x — that's a single extreme close-up
  of a giant landmark, where only a handful of buildings are visible
  and 2D is cheap anyway), or when the GPU is too small to host the
  atlas (`__CV_DIAG.artBlock` names which). In practice: every zoom
  where Canvas2D was slow is now GL. Smoke seeds a giant sprite on the
  building nearest the rest-preset centre so the blur-guard check is
  deterministic; bench shows the rest close-up falling back exactly
  there. Assets bumped to `?v=10`. File: `web/js/city-view.js`.

## 2026-10-20.11

- **Quality-driven Art/GL gate** — the fixed 8 px/unit cutoff from .10
  (which reported `2D(art)` while panning the whole town at mid zooms) is
  replaced by a per-frame scan: GL keeps the frame as long as every
  sprite *painted on screen* fits its atlas cell (drawn size ≤ 512 px);
  it declines to the sharp 2D sprite path only when a sprite would be
  upscaled blurry (`big`), when a legible sprite exists but the GPU
  forced the atlas off (`dead`), or at deep zoom ≥ 24 px/unit where 2D
  is cheap anyway (`deep`). The scan is one cheap pass over the culled
  buildings, Art mode only. Atlas cell tiers extended to 512 px. The
  statsbar now ends with the build version (`· v2026-10-20.11`) so a
  stale-cache run showing old behaviour is visible without the console;
  `__CV_DIAG.artBlock` names the scan reason. Smoke's deep-zoom check
  still expects `2D(art)`; bench confirms mid-band Art frames stay
  `GL·bld`. Assets bumped to `?v=9`. File: `web/js/city-view.js`.

## 2026-10-20.10

- **GL sprites** — Art·sprites mode now takes the WebGL path in the
  zoomed-out band instead of always paying the Canvas2D cost. Each block
  emits EITHER its three prism quads OR one textured sprite-billboard
  quad into the SAME depth-ordered vertex stream, so a nearer prism keeps
  painting over a farther building's sprite exactly as in 2D — still
  ONE `drawArrays` call (plus the people-dot fans). Sprites come from a
  lazily packed GPU atlas: since 3,592 manifest PNGs need ~2.5 Gpx at
  native size, every cell is downscaled to the px size actually painted
  at the current zoom (16–256 tiers), which fits an overview screen on a
  4096 page. Cells pack shelf-first straight from decoded PNGs
  (budget 16/frame, 96 while re-packing a full page ~every 120 frames;
  evicted sprites show as blocks meanwhile), the page re-uploads to the
  GPU only when new cells land (throttled 250 ms) with mipmaps for
  clean minification. Above 8 px/unit Art still keeps the 2D path: few
  sprites on screen there, and it stays sharp at native PNG resolution
  the capped atlas can't match. People render as their art quads too,
  with dots for anything unreadable. `window.__AGL` exposes the atlas
  (cells/page/full/dead) for the console; smoke gained the mid-band
  ("Art no longer refuses GL") and deep-zoom ("keeps sharp 2D") checks;
  bench confirms the GL sprite path executes under a fake-WebGL harness.
  Assets bumped to `?v=8`. Files: `web/js/gl-base.js` (solid program now
  textures x vertex-colour, atlas re-upload, `maxTex`),
  `web/js/city-view.js` (atlas packer + quad builders).

## 2026-10-20.9

- **Zoomed-out Art mode joins the GL building path** — the
  `2D(art)` statsbar report showed the remaining slow-panning case:
  Art·sprites mode (persisted in localStorage) unconditionally refused
  the GL prism pass, even when zoomed out so far that EVERY sprite sits
  below the 12px readability gate and the 2D loop is only repainting
  plain blocks + dots — pixel-identical to what GL already draws. Art
  frames now refuse GL only while a sprite could actually be read:
  the largest manifest sprite dimension (`artMaxDim`, seeded from
  city-sprites.json + characters.json at load) times the frame's
  screen-px-per-art-px `k` must reach 12px, the same gate
  `drawSprite`/`drawPeopleArt` use. Cross it zooming in and the 2D
  sprite billboards take over as before. Headless bench with Art on:
  downtown 15,857 fills → 4,465 (`GL·bld`); one zoom step in, sprites
  render and the frame stays 2D by design. Smoke gained the
  gated-Art-GL-eligible check. Assets bumped to `?v=7`, build stamp
  `__CV_VER` to `2026-10-20.9`.

## 2026-10-20.8

- **Self-reporting renderer diagnostics** — a "still 2D" report was
  undiagnosable from the headless side, so every silent GL fallback now
  names itself. The statsbar readout gained the refusal reason
  (`2D(art)`, `2D(sel)`, `2D(no-context)`…), the boot console banner
  prints why (`base layer: Canvas2D — shader-fs: …`), and
  `window.__CV_DIAG` carries `glReason` (boot), `block` (per frame) and
  `ver` (build stamp, also `window.__CV_VER` — paste it into the console
  to rule out stale cached scripts at a glance). `CityGL` exports
  `lastError()` capturing the shader/link/context failure with the
  driver's info log. As a direct fix, GL boot now retries
  `getContext('webgl')` WITHOUT MSAA after a refusal — Firefox's GPU
  blocklist denies `antialias:true` contexts on some drivers, which
  would previously have killed the whole GL path. Files:
  `web/js/gl-base.js` (fail() + retry), `web/js/city-view.js`
  (`glBuildBlock`, DIAG fields, banner), smoke gained three checks.
  Assets bumped to `?v=6`.

## 2026-10-20.7

- **GL building prisms in the classic zoom band** — the zoom level a
  rider actually calls "zoomed out" (whole town on screen, s ≈ 2–8
  px/unit) never reached the s<2 flat-atlas LOD, so every pan frame paid
  ~5,300 buildings × 3 Canvas2D face fills ≈ 16k fill dispatches —
  measured as 99% of the downtown-frame cost, matching the report that
  buildings are what makes panning slow. Clean views now take a WebGL
  path: each block's four tile corners are projected with the frame's
  tile→screen affine, three flat-coloured premultiplied quads per block
  (colours baked in `buildBuildings`) upload once per frame as ONE
  `drawArrays` call on the GL canvas, which raises above the 2D canvas
  (CSS `#glcv.above`) so terrain stays below and dots land on top,
  exactly as before. People dots draw as 8-segment fans in the same
  pass. The path only engages when nothing paints 2D on top of
  buildings — sprites (Art mode), wireframe, grid, walks, tile markers,
  search matches and the selection outline keep the Canvas2D loop, and
  any GL failure falls back to it permanently. The GL canvas now asks
  for MSAA (`antialias:true`) so prism edges stay smooth. Headless
  bench (fake-WebGL): downtown 15,857 fills → 4,465 (terrain only),
  zoomed-in frames 26 fills. New files/functions: `drawTop()` in
  `web/js/gl-base.js` (solid vertex-colour program + dot fans),
  `buildBuildQuads`/`buildDotsXY`/`glBuildOK` in `web/js/city-view.js`;
  statsbar mode readout gained `GL·bld`. Assets bumped to `?v=5`.

## 2026-10-20.6

- **Asset loading indicator** — the toolbar (next to the zoom readout)
  now carries a live pill (`#assets`) for every remote pull: the two
  boot textures (grass tile, road sheet) and the two art manifests
  (city-sprites.json, characters.json) count down a gold progress bar
  as `assets 2/4`, then — while Art·sprites mode streams the sprite
  pack in as you pan — as `art 1,312/1,832 · 4 loading · 3 dead`
  (dead PNGs keep their block/dot degrade paths, so the pill can never
  stick at loading). The pill hides itself whenever nothing is in
  flight and Art mode is off, and `window.__ASSETS` exposes the raw
  counters (`boot/bootDone/pend/artGot/artKnown/artDead`) for the
  console and the smoke harness. Per-PNG repaints are throttled to ~8Hz
  with a trailing paint. Tooltip follows the project `data-tip`
  convention. Files: `web/js/city-view.js` (tracker + wiring in the
  boot loaders and `imgFor`/`applyArtMode`), `web/city-view.html`
  (pill + cache busters `?v=4`, CSS now versioned too),
  `web/css/city-view.css` (`#assets` pill), `tools/smoke-city-view-dom.cjs`
  (4 new assertions incl. art-mode readout + auto-hide).

## 2026-10-20.5

- **Frame telemetry + raster-side cuts for the zoomed-out regimes** —
  the statsbar now carries a live renderer readout (`perfread`):
  `GL · 58fps · 1.2/3.4ms` style, plus `window.__CV_DIAG` and a one-line
  console banner saying whether the WebGL base layer actually took over
  (a silently-failed GL init previously looked identical to "GL is on").
  New URL params: `?nogl=1` forces the Canvas2D base path (A/B in one
  session), `?dpr=1` caps the backing store in every regime. Perf work
  this pass targets raster, not JS (the pan frames are already ~0.5 ms
  of harness JS): the LOD regime now renders BOTH canvases at
  device-pixel-ratio ≤1 (bilinear-smoothed 2px/tile atlas tiles gain
  nothing from 4x the pixels — ~4x less clear/fill work per zoomed-out
  pan frame), the 2D fallback replaces the skewed full-viewport grass
  PATTERN fill with a flat lawn colour below `Terrain.FLAT_GRASS_S = 4`
  px/unit (a pattern minified to sub-pixel tufts is noise at that
  scale, and transformed pattern fills are Canvas2D's slowest raster
  op; the GL layer keeps the mipmapped texture), and LOD atlas blits set
  `imageSmoothingQuality='low'`. New bench regimes measured the classic
  band: worst frame is the downtown preset (s≈2.1, every building
  on-screen) at 15.9k fills / 61k path-ops — Canvas2D per-op overhead
  there is the remaining structural cost, the GL-quad fix for that band
  is scoped as the next step. Files: `web/js/city-view.js` (QP params,
  perfread + `__CV_DIAG`, edpr cap), `web/js/terrain.js` (flat grass +
  smoothing quality), `tools/smoke-city-view-dom.cjs` (diagnostics
  assertion), `web/city-view.html` (cache busters `?v=3`).

## 2026-10-20.4

- **Hybrid WebGL base layer for the zoomed-out (LOD) regime** — new
  `web/js/gl-base.js` (`CityGL`) draws the base of every LOD frame on a
  second canvas (`#glcv`, stacked behind the 2D canvas in `#stage`):
  grass tile (REPEAT + mipmapped), sea quad, the flattened terrain and
  building atlases and the people dots = ~5 textured-quad draws + one
  uniform update per pan frame, with no Canvas2D path/pattern recording
  or translucent full-frame blit stacking. The 2D canvas above keeps all
  overlays/debug (grid, wireframe, walks, proposed streets, outlines,
  markers, sprites, block prisms) and all pointer events. Any missing
  capability (no WebGL, headless harness, atlas unavailable) or a failed
  draw silently keeps the proven Canvas2D base path. Also: the two LOD
  atlases now flatten to ONE bitmap each (rebuilt only on legend
  toggles), so even the 2D fallback pan is 2 blits instead of ~14; and
  the Art·sprites LOD gate moved 4px → 12px — a full-size PNG minified
  below ~12 screen px is unreadable blur and was ~5,300 bilinear
  downscales per pan frame, so small sprites/characters now fall back to
  footprints/dots until the art can actually be read. Script tags in
  `city-view.html` bumped `?v=1` → `?v=2` (Firefox may have served
  stale JS through the earlier rounds). Files: `web/js/gl-base.js`
  (new), `web/js/terrain.js` (`#flatInfo`/`#_flat`, `glBase`
  suppression, `Terrain.SEA_RGB`), `web/js/city-view.js` (GL boot +
  render dispatch, `buildBuildFlat`), `web/city-view.html`,
  `web/css/city-view.css`, `tools/smoke-city-view-dom.cjs` (glcv stub +
  CityGL headless-fallback check).

## 2026-10-20.3

- **Zoomed-out panning now blits cached atlases instead of re-drawing the
  world every frame** — the `.2` fill batching cut the fill count but a
  pan at whole-town zoom still re-submitted ~42k antialiased path
  segments (10.6k diamonds × 4 segments) to the canvas each frame; path
  recording/tessellation is CPU per-primitive work even when Canvas2D is
  GPU-accelerated (Firefox renders 2D canvas on the GPU via WebRender —
  see `about:support` → Graphics; it only falls back to software when
  WebRender is blocked). The ground and the flat LOD footprints are
  static in TILE space, so they are now rasterised ONCE into offscreen
  canvases (2 atlas px per town tile — terrain per layer type, buildings
  per object bucket) and each frame just blits them under the frame's
  tile→screen affine: whole-town pan = ~14 GPU blits + grass/ocean rects
  + one batched dot path. Measured whole-town frame: 21k fills / 42k
  path-ops → 1 fill / 3.5k ops / 14 blits; harness JS 9.3 ms → 0.4 ms
  per pan frame. Atlases rebuild lazily only when their inputs change
  (feature rebuilds from the speckle/road-network toggles, the
  orientation rig, object-legend toggles). Visual note: below the
  tiny-tile threshold layers now draw as true-scale bilinear-smoothed
  tiles rather than the inflated fixed-size diamonds. Files:
  `web/js/terrain.js` (Terrain#drawAtlas / #_buildAtlas + invalidation
  in `_rebuild`), `web/js/city-view.js` (per-bucket building atlases in
  the flat LOD pass), `tools/smoke-city-view-dom.cjs` (LOD blit
  assertion).

## 2026-10-20.2

- **City View zoom-out render cost cut (fill batching + per-frame
  garbage)** — zoomed-out frames drew every entity as its own
  antialiased path: ~4.3k terrain diamonds, 5,261 blocks × 3 shaded
  faces (with three fresh `rgb()` strings allocated per block per
  frame), and 871 people dots ≈ 21k fills/frame. Below s = 2 px/unit
  buildings now render as flat footprint diamonds batched per colour,
  terrain `tiny` tiles batch one path per layer type, people batch into
  a single path, block face styles are precomputed, `blockPolys`
  projects 4 ground corners instead of 8 points, and billboards smaller
  than 4 screen px in both dimensions fall back to blocks/dots without
  even decoding their PNG. Whole-town frame: ~21k fills → 20; classic
  path (downtown/rest zoom) unchanged visually with ~2× cheaper
  projections. Files: `web/js/city-view.js`, `web/js/terrain.js`,
  `web/js/objects.js`, `web/js/camera.js` (new `CAM.tileAffine`).

## 2026-10-20

- **City View boots zoomed in on SpringfieldDowns** — the page now opens
  framed on the save's capital landmark (catalog id 20, the one placed
  instance at town tiles X 144–154, Y 0–12) instead of the whole-downtown
  fit. A new **Springfield Downs** toolbar button re-frames it at any time
  (and survives a Rotate/Mirror rig press, like the other presets); the
  instance is found by catalog name at boot, so no tile coordinates are
  hard-coded, and the view falls back to the downtown fit if a future save
  has no SpringfieldDowns. Files: `web/js/city-view.js` (new
  `presetSpringfield` + boot wiring), `web/city-view.html` (toolbar button),
  `tools/smoke-city-view-dom.cjs` (boot-framing assertion; the click tests
  now frame downtown first).

## 2026-10-19.32

- **Terrain decode corrected: layers are 4×4-tile CELLS with neighbour
  nibbles, not per-tile chars** — the long-standing "1 char = 16 tiles,
  `a`–`p` = tile position" codebook was wrong. Cross-checked against
  `road-spec.json` (an external spec of the same `.pb`) and verified in
  the binary: land layers are 16-byte blocks of 4×4 cells, 37 blocks per
  row (148×236 cells); a non-`'G'` char is one cell whose value `c-'a'`
  is the E/W/N/S neighbour mask (E=1,W=2,N=4,S=8) and `'P'` is a solid
  plaza cell. Proof: neighbour reciprocity is exactly **1.000 at stride
  37** for roads/rivers/dirt/dirtroad/klsroad/sand (0.82–0.88 at every
  other stride). Cell origin = `InnerLandData` landBlockPosition
  (−3,−7 blocks) ×16 = town tile (−48,−112) — verified: 5259/5261
  buildings fall inside the 64×64 land mask, and the river network now
  hugs SpringfieldLake. Consequences: "riversData is scatter" and the
  whole "filler grids" story (sand/dirtroad/klsroad speckle, road
  frontage stubs) are retracted — those layers are genuine connected
  ground (DIRT_ROADS = one 94-cell footpath, KLSROAD = one 16-cell
  path, SAND = 3 beach masses, rivers = two real streams incl. the
  hand-laid cluster at x 116–128, y 8–36 beside SpringfieldFalls).
  Files: `web/js/terrain.js` (new `decodeCells` + `Terrain#cellStateFor`
  — the saved nibble now selects the 11 RoadDrawer states directly;
  roads/rivers/etc. paint as one 4×4 diamond per cell; `SPECKLE_POLICY`
  ships EMPTY, the legend toggle stays but is inert), `web/js/city-view.js`
  (marker seed replaced with 5 real river cells), `tools/cell_find.py`
  and `tools/save_diff.py` (verified cell layout; diff now per-cell with
  nibble-change detection), `tools/smoke-camera.cjs` (speckle assertions
  replaced by cell-decode truth pins: 1647 road cells = 392 P + 1255
  nibbled, reciprocity 1.000, river-under-lake lookup). Both smoke
  suites pass. The 3072-char ocean sea-patch keeps the legacy per-tile
  frame (its reciprocity is 0.87 — not a cell codebook);
  `tools/layer_oracle.py` decodes in town space now (off-lattice walk
  waypoints lift 11–13× on dirt/dirtroad — they ride the trails). Notes:
  `notes/01` gained "Terrain grids: CELL semantics" and retraction
  banners on the superseded sections; `notes/06` §10 + walk-oracle
  reframed. New file: `road-spec.json` (the external spec, kept for
  reference).

## 2026-10-19.31

- **Road network model A/B in City View** — ROADS can now be read as an
  orthogonal network (4-connected streets with corners, T-junctions and
  solid 'P' plazas) instead of an unstructured tile soup, as an
  eye-test toggle. New `Terrain#roadNetwork` (ships OFF) changes two
  things: speckle singles are anchored only through ORTHOGONAL contact
  with 'P' ground (8-connected components grow 4-connected, so a filler
  single that merely kisses a street on a corner drops — data-invariant
  on this save, all 54 kept singles already touch orthogonally), and
  'P'-derived tiles keep their provenance (`_plazaOcc`) so they render
  as flat full-asphalt plaza interiors (sheet state 0) instead of
  taking kerb/corner art from the neighbour mask. Toolbar button
  **"Road network"** (`mrsnrub.cityview.roadnet`) flips it live; pair
  with Road art cycled to "edges" to see the plaza kerb delta (verified
  headless: neighbour mode's mixed state picks collapse to uniform
  state-0 draws over P runs). Files: `web/js/terrain.js`,
  `web/js/city-view.js`, `web/city-view.html`. Smoke:
  `smoke-city-view-dom.cjs` gains an 8-check "road network model"
  block (4-conn anchor drop, plaza provenance 6,272/0-orphan, live
  toggle + persistence).

## 2026-10-19.30

- **City View renders the recovered boardwalk + pier tiles** — the two
  ocean-grid brushes are now visible as their own layers. The natural sea
  frame (f34) decomposes into an organic band plus five periodic
  lattices, so tiles east of the band that match none of them are
  brush-painted: two isolated 2-tile pairs offshore (**= the f16
  PierDrawing ×4 ledger count**, rendered weathered grey-brown) and one
  tile at the SquidportEntrance door (rendered plank tan). The other 15
  boardwalk tiles were painted over natural positions and are
  unrecoverable (position-only strings). New legend rows `boardwalk` /
  `pier` with toggles + click-to-inspect cards in City View
  (`?v=1` cache-bust on all page scripts), same layers in the map
  explorer; classification lives in `tools/gen_map_explorer.py`,
  evidence in `mapdump/registration/m4-brush-classification.png`, notes
  in notes/01 ("Recovering boardwalk/pier tiles"). Smoke:
  `smoke-city-view-dom.cjs` gains a 7-check "ocean brush layers" block.

## 2026-10-19.29

- **Full remaining-segment review — stashed bundles carry their own
  terrain patches (census revised to 14 grids)** — reviewed every
  still-unexplored segment for road/river/brush links. Headline: the
  ≥128 B raster census had **missed four grids** — 3 of the 43 f53
  storage bundles carry a `groupStorageBundleRoadMap` with a live
  codebook grid (a **pure stashed 16×48 ROADS patch** of 18 tiles at
  origin (32,208) with zero objects, a 32×32 DIRT patch with tree/promo
  props, and a 16×32 SAND patch whose tile sits at x=512, *outside* the
  main grid frame), and **0/18 + 0/3 of those tiles exist in the main
  rasters** — stashing removes terrain from the main grids and
  preserves it inside the bundle; f36's subland likewise keeps its own
  tt=2 ROADS grid (~14 tiles). Also: **f13 inventory holds the brush
  consumables** — BoardwalkDrawing ×365 and PierDrawing ×6 still in
  stock (the direct counterpart of f16's 19+4 spends; permanent
  brushes have no rows), and **f11 questData shows `PaveParadise` (47)
  and `RiverRun` (48) completed** — the landinfo brush-unlock gates.
  Remaining segments profiled and annotated (f10 519-job working queue,
  f12 movement notifications, f27 40 named SpecialEvents, f48 ad-hoc
  registry, f2/f18/f22/f23/f24/f26/f28/f33/f39/f40/f41/f42/f46/f49/f51/
  f52) — **Byte Map schema-only falls 16.9% → 0.3%**; notes/01 gains
  "Stashed bundles carry their own terrain" and the census bullet is
  corrected. Data regenerated, assets `?v=16`, suite now 45 checks
  (3 new), all green.

## 2026-10-19.28

- **Road/river sweep of buildingData — props only, but four terrain-story
  confirmations** — checked whether f7 secretly holds road/river data:
  a keyword sweep of all 2,299 distinct template ids returns 80 hits,
  **all cosmetic props** (BoardwalkFence ×28, CobblestoneWall — a wall —
  21 Krustyland props, 41 pond/lake/fountain water features), so roads
  and rivers are confirmed **not** stored as buildings. But the sweep
  produced real corroboration: **OrnatePier at (−4,−16)** and
  **SquidportEntrance at (−8,48)** are present — exactly the two
  `ConsumableLimit` gate buildings landinfo requires for PierDrawing /
  BoardwalkDrawing, placed at the western ocean edge (matching the
  ocean RoadMap `origin=-3,-7`), independently confirming the f16
  Boardwalk ×19 / Pier ×4 uses; 48 boardwalk props mark the Squidport
  district, and the 21 Krustyland props explain the brush-less
  KRUSTYLAND_ROADS(4) layer's 16 filled raster chars as park paths.
  Documented in notes/01 (buildingData audit → "Road/river angle"),
  Byte Map f7 note extended, data regenerated, assets `?v=15`, suite
  now 42 checks (1 new), all green.

## 2026-10-19.27

- **buildingData (f7) fully explored — all 15 observed fields decoded** —
  the placed-building segment (5,261 records, 209 KB) was annotated only
  as "template id + position + times"; a full per-field audit resolved
  every serialised field: `EntityHeader.id` = persistent instance id,
  positions are always **integral tile coordinates** (same frame as the
  rasters), creation/update times are unix **seconds** spanning
  2013-02-24 (launch era) .. 2025-01-24 with a 2021-11 build peak,
  buildState 5=done with the lone state-2 record a **TutsnTotsElementary
  still under construction**, 153 buildings carry **48 skin variants**
  (Decorated_Festive*, winter PushingAndShoveling/TheShiftingDrifts,
  DonutPacks, driving ranges), flipState = orientation {1,2,3},
  cropState = stage flag on 28 revenue/collection buildings,
  betStartTime/betChoice = **Springfield Games GoKart betting** (2
  active bets), and 24 **self-vandalised** buildings whose vandalName is
  this land's own 39-digit id (buildings.xml `<Vandalism>`
  tag-for-rewards feature); 9 schema fields never serialised, f38
  stealableBuildingData absent. Byte Map: new `BuildingData` +
  `EntityHeader` child statuses render the f7 drill-down fully
  **decoded** with per-field notes; notes/01 gains "buildingData (f7) —
  full field audit". Data regenerated, assets `?v=14`, pb-layout suite
  now 41 checks (3 new), all suites green.

## 2026-10-19.26

- **eventCountListData fully profiled — union-typed analytics counters,
  and no hidden brush data** — answered whether f16 could account for
  the missing road/river brush records by profiling every value of all
  17 event types against the gsdata DataID catalogs: `Event` fields have
  **union semantics** (the type selects how each id field is read — e.g.
  type 16/17 "buildingID" resolves to *character* DataIDs like Bart /
  Cletus). New readings: 18/19/20 = job completions keyed by (jobID,
  buildingID) incl. decoration collection and tax jobs (counts up to
  91,272); 35/39 = per-character task tallies with **39 a complete
  subset of 35** (63 in-progress rows only in 35 → attempted vs
  completed); 161 = friend-land character visits (characterID 1..64);
  175 = special-event participation (arg1 = SpringfieldMysterySpot,
  SecretAgents_Event, MultiVac…, cross-refs f27); 69/76/96/98/172 =
  plain aggregate counters (meaning unverifiable — f16 stays
  **partial**). A keyword sweep over every id field of every type found
  only game-content names (`PavingRoadsWithGoodIntentions`,
  `OrnatePier2`, guide-panel jobs `GoldRoadDrawing`/`SandDrawing`) —
  **zero positional or raster data anywhere in f16**, confirming the
  rasters remain the save's only terrain record. Byte Map f16
  tooltip/overview + all Event field notes rewritten; notes/01 gains
  "eventCountListData anatomy" with the per-type table. Data
  regenerated, assets `?v=13`, pb-layout suite now 38 checks (2 new),
  all suites green.

## 2026-10-19.25

- **Corrected: f16 event ledger does NOT track road/pavement drawing —
  and its silence is expected** — a user question prompted a full audit
  of the type-41 rows: the only brush events in the entire 49,309-row
  ledger are BoardwalkDrawing ×19 and PierDrawing ×4 (plus zero
  brush-shaped arg1 values). Type 41 turns out to be a
  **consumable-inventory log** (per-item counts up to 1,485): the
  boardwalk/pier brushes burn one inventory item per tile (landinfo
  `consumableCount`/`onlyInventory`), while road/pavement/river brushes
  are permanent unlocks that consume nothing — so their uses never
  appear in f16 and **cannot**. This retracts the earlier Byte Map
  note's inference that roads were "quest/placement granted" (the
  7,527 tiles were most likely brush-laid with an untracked permanent
  brush); Byte Map ROADS/RIVERS brush notes and the notes/01 pavement
  section now state the correct semantics. Data regenerated, assets
  `?v=12`, all suites green.

## 2026-10-19.24

- **Resolved as far as evidence allows: the pavement/boardwalk storage
  question** — chased how road + pavement coexist in the main road
  raster: proved the `mapData` string is **position-only** (the verified
  decoder writes just x-offset + 1/2-unit flags; type bits are set only
  by runtime road-construction code), proved `roadsData.mapData` is
  *not* a pavement twin (f5/f6/f34 are plain single-string TerrainData
  messages, one raster each), and confirmed no proto slot exists for
  pavement/boardwalk/pier anywhere. The one save on hand can't settle
  the last unknown — **f16 counters show PavementDrawing was never
  consumed here** (only Boardwalk ×19 / Pier ×4), and the road grid's
  903 single-tile components are procedural lattice (x=508, row stride
  37), not stray sidewalks. Documented in notes/01 ("The pavement
  storage question") with the decisive follow-up test: a save from a
  town with painted pavement — if `roadMapList` then gains a
  **terrainType=1** entry, layers are stored per-type; if not, merged
  storage + load-time re-derivation is confirmed. Byte Map brush notes
  for ROADS/RIVERS now cite the f16 usage evidence; data regenerated,
  assets `?v=11`, all suites green (37 checks).

## 2026-10-19.23

- **Added: full terrain dragnet over the remaining schema-only segments —
  no terrain hides anywhere, and two big unknowns resolved** — every
  remaining schema-only field (27 segments, ~1.15 MB) was recursively
  digested and keyword-scanned, followed by a whole-file raster census
  (every ≥128 B string of pure codebook chars, any depth): the save holds
  **exactly 10 codebook grids, all already on the Byte Map**. The biggest
  unexplored segment, **f16 `eventCountListData` (825 KB)**, is an
  analytics ledger — 17 single-type groups / 49,309 Event rows (job
  completions, consumable uses incl. **BoardwalkDrawing ×19 / PierDrawing
  ×4**); `innerLandData.landBlocks` decoded as a 64×64 township
  occupancy mask (2,366 bits, position (-3,-7); subland mask = 10 bits —
  an old Byte Map note had that figure swapped onto the subland, fixed).
  `landinfo.xml` `SaveInfo` yielded the authoritative brush→grid map:
  **pavement tiles live in the main road grid and boardwalk/pier tiles in
  the OCEAN grid** (explaining why those layers never appear in
  roadMapList), and DIRT(6)/DIRT_ROADS(7) enum names are swapped vs the
  config; **KLSROAD's brush is `KrustylandSpringfieldPath` (DataID 4266,
  unlocked)** and is now annotated, along with the ocean boardwalk/pier
  note. Byte Map meters: schema-only 60.3% → **16.9%** (partial 55.6%);
  `BRUSHES` table + STATUS notes in `tools/gen_pb_layout.py`, suite at 37
  checks, assets `?v=10`, all suites green; documented in notes/01.
  Page: `http://dave-latitude-5550.tailc953b.ts.net:8081/mrsnrub/web/pb-layout.html`

## 2026-10-19.22

- **Added: Byte Map overlay rows now name their controlling brush + ledger
  state** — following the terrain cross-check, the f35 type-6 ledger was
  found to hold the **full drawing-brush set** (one `*Drawing` consumable
  per RoadMap layer: RoadDrawing, PavementDrawing, RiverDrawing,
  DirtRiverDrawing, DirtRoadDrawing, CobblestoneDrawing, IceRiverDrawing,
  GoldRoadDrawing, SandDrawing; plus Boardwalk/Pier). Each terrain grid's
  grid-analysis block and each `roadMapList` overlay row in the Byte Map
  now annotates its brush item (name + DataID) and its state in this
  save — e.g. **SAND → SandDrawing (unlocked here**, 632 painted tiles**)**
  and **GOLDROAD → GoldRoadDrawing (LOCKED here — layer empty)**.
  Curated as `BRUSHES` in `tools/gen_pb_layout.py` (annotated onto every
  det in a post-pass); suite at 33 checks, assets `?v=9`, all suites
  green. The overlay *grids* themselves were already rendered from the
  authoritative save bytes — this adds the ledger context, not new tiles.
  Page: `http://dave-latitude-5550.tailc953b.ts.net:8081/mrsnrub/web/pb-layout.html`

## 2026-10-19.21

- **Added: terrain cross-check note for the two decoded ledger fields** —
  keyword-scanned `gameObjectInfo` and `objectVariables` for road/river
  content per a user question: neither holds terrain data (grids live
  only in f5/f6/f34/f47/f36/f53), but the type-6 consumable ledger tracks
  the *terrain-drawing tools* — `GoldRoadDrawing` is `locked=1` here and
  the f47 GOLDROAD overlay is indeed 100% empty, while `SandDrawing` +
  `SandTileUnlock` are unlocked and SAND carries 632 painted tiles; the
  one objectVariables hit (`UI_SESSION_TOXIC_BURNS_GREEN_RIVERS`) is
  battle UI state. Documented as a bullet in the notes/01 gameObjectInfo
  section. Docs-only; no code or suite changes.

## 2026-10-19.20

- **Decoded: `objectVariables` (LandMessage field 43) — per-object script
  key/value store** — the 88.3 KB schema-only section (5th largest) is an
  `AdvancedVariableSet`: **2,205 rows** `{name, value, createdTime, …}`,
  247 distinct names, string-encoded values. Rows bind to their host
  object via **`serverID` = the hosting `EntityHeader.id`** (510 of 783
  hit current `buildingData` headers; the rest are demolished objects —
  which is what `orphaned=1` on 241 rows marks; `serverID=0` is
  land-level), and **`objectTypeID` = the host's building template**
  (232/234 ∈ `data/building_ids.json`). `objectClass` unset = building
  script vars; class **3** (539 rows) is the battle/minigame state store
  (numeric-named `0..3` + `health`/`battle_type`). Names resolve into the
  gamescripts configs (`/tmp/opencode/gsdata/`): `SHLevel` × 151 (Uptown
  Springfield Heights, 139 of them orphaned = demolished plots),
  `DonutVeinMined` × 146, `Maggie/MaggieIn/MaggieOut/Baby` anim state,
  `State/ActiveIn/Forward/Reverse/AnimationDirection`, `dummy`=1
  placeholders; `ttl`/`scope` never used; `createdTime` 2019-04 ..
  2025-01. Documented in **notes/01**; Byte Map flips f43 (and the
  variable sub-fields) to **decoded** — file meters now **decoded 27.5%**
  (was 22.8%) · partial 12.2% · schema-only 60.3%. Generator recursion
  no longer size-gates fields the schema says are messages (small
  `variable` entries now expose their interior). Assets `?v=8`, all 11
  suites green. Page:
  `http://dave-latitude-5550.tailc953b.ts.net:8081/mrsnrub/web/pb-layout.html`

## 2026-10-19.19

- **Added: Byte Map overview block for every confirmed segment** — the
  details pane now leads with an **overview** section (gold-bordered)
  explaining what the selected region *is*, for all curated segments:
  the four verified terrain grids (with their tile stats), `userData`,
  `buildingData`, `characterData`, `gameObjectInfo`'s four ledger
  categories, `subLandData`, the road overlays and the storage bundles —
  written from what notes/01 actually establishes, replacing the old
  one-line "our findings" strings (curated tables in
  `tools/gen_pb_layout.py` STATUS_TOP). Hover tooltips keep only the
  first clause so they stay readable. New checks in
  `tools/smoke-pb-layout-dom.cjs` (now 31), data regenerated, assets
  `?v=6`, all 11 suites green. Page:
  `http://dave-latitude-5550.tailc953b.ts.net:8081/mrsnrub/web/pb-layout.html`

## 2026-10-19.18

- **Decoded: `gameObjectInfo` (LandMessage field 35) — the per-template
  asset ledger** — the 62.9 KB schema-only section is now fully
  characterised: 4,260 `GameObject{dataId, gameObjectType, unlockTime,
  locked, viewed}` rows keyed by (type, dataId), where `gameObjectType` is
  the asset **category** — **1 = Building** (3,146 rows, 100% ⊆
  `data/building_ids.json`), **2 = Character** (529, 100% ⊆
  `character_ids.json`), **6 = Consumable** (528, 100% ⊆
  `*consumables*.xml`), **15 = GameObjectBundle** (57, all ∈ bundle
  `MasterList` DataIDs in the local `*_gameobjectbundles.xml` configs —
  e.g. 283500 = `MemorialChurchBundle`). It is a *discovered/unlocked*
  history, not map contents: type 1 retains **862 demolished buildings**,
  `viewed=1` on 3,000 rows, the only 6 `locked=1` rows are preview
  consumables (`TalkingKrustyDoll`, `GoldRoadDrawing`, …), and
  `unlockTime` spans 2013-06 .. 2025-01. Documented in
  **notes/01** ("gameObjectInfo — the per-template asset ledger");
  `tools/gen_pb_layout.py` STATUS tables flip f35 to **decoded** with
  per-subfield notes, so the Byte Map now reads **decoded 22.8%** (was
  19.6%) · partial 12.2% · schema-only 64.9%. Data regenerated, assets
  `?v=5`, all 11 suites green. Page:
  `http://dave-latitude-5550.tailc953b.ts.net:8081/mrsnrub/web/pb-layout.html`

## 2026-10-19.17

- **Changed: Byte Map page is now full-width** — the 1500 px content cap
  was removed, so on wide monitors the byte-allocation bars span the
  whole viewport (segments get properly readable again) and the details
  pane scales with the window (`clamp(340px, 26vw, 520px)`), which also
  renders the tile-map canvases larger. CSS cache-bumped to `?v=4` —
  one hard refresh. Page:
  `http://dave-latitude-5550.tailc953b.ts.net:8081/mrsnrub/web/pb-layout.html`

## 2026-10-19.16

- **Added: Byte Map 2-D tile maps** — clicking `roadsData`,
  `riversData`, `oceanData`, an overlay layer, subland terrain or a
  bundle roadmap now **draws the grid as an actual map** in the details
  pane: one opaque pixel per filled tile (roads gold at the verified
  **512 x 1087** geometry from notes/01 — filled rows 39..799 reproduce
  the published span exactly; rivers blue; ocean teal rim; per-type
  colours for all 12 terrainTypes; decoder-ignored chars flagged red).
  The 7 `roadMapList` overlays list a 64-px thumbnail per layer
  (COBBLESTONE/ICERIVER/GOLDROAD render empty, as found). Widths: main
  layers use the verified 32-char (512-tile) width, the 3 bundle
  roadmaps now carry their **explicit `mapDataSizeX/Y`** per occurrence
  (16×48 / 32×32 / 16×32, matching the notes/01 proof table), anything
  else is labelled "width assumed". Grid strings are pooled once in
  `pb-layout-data.js` (284 KB total; `det.g` -> `D.grids[i]`), rendered
  via `createImageData` so the page stays static/`file://`-friendly.
  Suite grown to 29 checks (`node tools/smoke-pb-layout-dom.cjs`,
  incl. putImageData paint + pixel-count-vs-tiles checks); all 11
  suites green. Assets cache-bumped to `?v=3` — one hard refresh.
  Page: `http://dave-latitude-5550.tailc953b.ts.net:8081/mrsnrub/web/pb-layout.html`

## 2026-10-19.15

- **Added: Byte Map terrain-grid detail** — clicking `roadsData`,
  `riversData`, `oceanData`, the 7 road-overlay layers, or subland
  terrain now shows a **grid analysis** block in the details pane,
  built from the codebook verified in notes/01: terrainType by name
  (ROADS / RIVERS / OCEAN / …), header id, `mapDataSize == len(mapData)`
  cross-check, **tiles-filled ratio** (e.g. roads 7,527 / 556,544 =
  1.35%; rivers 170; ocean 1,582), the first filled chars, and a **char
  histogram** — every distinct `mapData` char with its 16-bit mask,
  count, a log-scaled bar and its codebook meaning (`a..p` = 1 tile at
  x=k, `P` = all 16, `G` = empty; decoder-ignored chars flagged in
  amber). The 7 `roadMapList` overlays list per-layer stats
  (COBBLESTONE/ICERIVER/GOLDROAD are 100% empty in this save), and the
  segment tooltips carry a one-line grid summary. Generator
  (`tools/gen_pb_layout.py`) computes this offline into
  `pb-layout-data.js` (41 KB). Assets cache-bumped to `?v=2`; suite
  grown to 23 checks (`node tools/smoke-pb-layout-dom.cjs`), all 11
  suites green. Page unchanged:
  `http://dave-latitude-5550.tailc953b.ts.net:8081/mrsnrub/web/pb-layout.html`

## 2026-10-19.14

- **Fixed: dashboard assets could serve stale from browser cache** — the
  "byte map →" link added to the *Map & city* card yesterday didn't
  appear in browsers because `progress.html` loads `js/progress.js` and
  `css/progress.css` by plain unversioned URLs, so the old cached script
  kept being used. Asset references on `progress.html` (`?v=2`) and
  `pb-layout.html` (`?v=1`, including the generated
  `pb-layout-data.js`) now carry version queries; bump the number
  whenever those files change (the Byte Map page's cached data has the
  same exposure — `gen_pb_layout.py`'s docstring reminds you). Existing
  browsers need one hard refresh (Ctrl+Shift+R) to pick this up.

## 2026-10-19.13

- **Added: Byte Map — visualisation of the city save `.pb` byte
  allocation** — new standalone page `web/pb-layout.html` renders the
  1.9 MB `Data.LandMessage` save as drill-down stacked bars: row 0 splits
  the file by top-level field (in byte order), click to open any
  field's interior and keep drilling; segments are coloured by RE status
  (**decoded 19.6% · partial 12.2% · schema-only 68.2%** today), with
  hover tooltips (exact hex offsets, sizes, occurrence counts, finding
  notes), breadcrumb + Esc navigation and a details pane. Repeated
  messages (5,261 buildings, 7,268 quests, …) aggregate their children's
  sizes across all occurrences. Data is generated offline by
  **`tools/gen_pb_layout.py`** (stdlib; walks the .pb with byte-offset
  tracking, resolves names from `re/proto_schema.txt`, and tags curated
  RE status per field) into `web/js/pb-layout-data.js` — same
  inline-data / `file://` pattern as the Map Explorer. A **"byte map →"**
  link was added to the Progress dashboard's *Map & city* card header.
  Headless test: `node tools/smoke-pb-layout-dom.cjs` (real page script
  on a stub DOM, bar/drill-down/breadcrumb/Esc paths). All 11 suites
  green. Page:
  `http://dave-latitude-5550.tailc953b.ts.net:8081/mrsnrub/web/pb-layout.html`

## 2026-10-19.12

- **Added: brush → save-layer proof + `tools/save_diff.py` (controlled
  persistence experiment ready)** — `landinfo.xml` settles where player
  brush terrain persists: every drawable `RoadEntry` (13 brushes incl.
  `RiverDrawing`, whose icon is literally `ICO_DECR_WATERTILE_SM` — the
  decorative water tile) carries `<SaveInfo map=... savedType="road"
  markRoadsLeaving="true">`, i.e. a per-layer 16-tiles-per-char codebook
  raster, and the 10 SaveInfo maps are exactly the 10 per-layer maps the
  provider rebuild loop merges (notes/01 new table, notes/06 phase 21+).
  There is no vector stroke store, and the OlmecHead/Falls window holds
  zero water-named `buildingData` props (the catalog's `GrandCanal1..5`
  tile props were never placed), so the player's river strokes can only
  live in `riversData` — the remaining 165 cells there are generator
  scatter and/or the uploaded `.pb` simply predates later placements.
  New `tools/save_diff.py OLD.pb NEW.pb` per-cell-diffs every terrain
  grid (f5/f6/f34, all `roadMapList` slots, subland and bundle grids),
  reports added/removed buildings by id+name+position, and lists
  top-level section-count changes: place a distinctive stroke in-game,
  re-capture the save, and the diff names each brush's persistence layer
  directly. Self-diff of the current save is clean. New
  `tools/cell_find.py CITY.pb --cells "x,y ..."` is the complementary
  probe: given tile coordinates some viewer shows as terrain, it
  brute-forces every codebook string in the raw file under four layout
  hypotheses and either names the encoding field or proves the cells
  are not in the `.pb` at all (validated: the five Falls-window river
  tiles resolve uniquely to the f6 string, off 40606).

- **Verified: the save contains no hidden terrain data** — recursive
  protobuf unknown-field scan is empty and a whole-file binary scan
  finds exactly the 10 codebook strings already rendered (f5/f6/f34 +
  the 7 `roadMapList` slots; notes/01). `roadMapList[0]` DIRT_ROADS is
  a generator comb (vertical 11-cell runs at x=55/71/87/103/311/327/
  343/359, town rows −74…−64), `klsroad` two lattice rows (y=123/141),
  DIRT a lattice (`(115,1) (131,1) (147,1) (163,1)`…), and f6 rivers
  are 170 isolated singles with `y mod 17` banding (6 residue classes
  empty) — all generator fingerprints, no river network anywhere in
  the file beyond the marked tiles.

## 2026-10-19.11

- **Added: City View "mark tiles" textarea (paste coordinates → yellow
  diamond highlights)** — new `web/js/markers.js` (`CityMarkers.parse/
  draw`): a textarea under the object toggles in the bottom-right
  legend; every tile pair typed or pasted — `(130,20) (144,17)`, one
  per line, or comma/slash/mixed punctuation — is drawn as a yellow
  diamond + cross + coordinate label over the map, culled to the
  visible tile rect. Coordinates are town tiles, matching the
  tile-grid hover readout (grid = town + 12,136, noted in the
  tooltip). The raw text persists via localStorage
  (`mrsnrub.cityview.markers`); on a first visit the box seeds with
  the five `riversData` cells from the OlmecHead/Falls window (notes/
  01 "riversData is building-adjacent scatter") so the candidate
  player river strokes are eye-checkable in context immediately;
  double-click a mark centers the camera on it, elsewhere
  double-click still step-zooms. Tests: `smoke-camera.cjs` "tile
  markers" block (parse formats, culling, wiring) +
  `smoke-city-view-dom.cjs` "tile-marker textarea" block (paste →
  five diamonds, persistence, clear).

## 2026-10-19.10

- **Corrected: `riversData`/DIRT are generator scatter, not player
  strokes** — the earlier claim that "for non-road layers the saved
  raster is already the full truth" was wrong (caught via player ground
  truth: tiles laid with the RiverDrawing brush around OlmecHead are
  real, yet the City View river layer showed water all over town where
  the game shows grass). Census: 162/170 saved river cells are isolated
  single tiles, ~61% sit within 2 tiles of a building (~25× random),
  rows arrive in ~17-row bands, and river/dirt/road cells never
  overlap — a building-triggered auto-decoration process, like the
  sand/dirtroad/klsroad filler the speckle filter already drops. The
  genuine brush content is a handful of tiles hugging water decorations
  (3 at SpringfieldFalls incl. the player's, ~8 at SpringfieldLake, 1
  at ForestStream); COBBLESTONE/ICERIVER/GOLDROAD layers are empty, so
  there is no hidden river layer, and the proto pool still holds no
  stroke/vector store (`tools/layer_oracle.py` census). A `river`
  speckle policy (keep cells near water decorations) is proposed but
  not yet shipped pending confirmation, and the decisive test — place
  a known stroke, re-capture the save, binary-diff the `.pb` — is
  queued. `notes/01` corrected ("riversData is building-adjacent
  scatter"). New tool: `tools/layer_oracle.py` (overlap census of every
  coordinate-bearing save structure against every decoded layer, with
  random baselines).

## 2026-10-19.9

- **Added: City View "walk paths" overlay + candidate-street census** —
  chasing where unsaved roads/rivers could live, the save turned out to
  already leak the answer: `characterData.pathCache` stores the client's
  own cached walk polylines (integer waypoints), and characters only
  walk on streets — ~90% of the cached segments ride the template grid
  the pb never persists, on a rigid lattice (N–S avenues at grid
  x ≡ 3 mod 4, E–W streets at y ≡ 0 mod 4). Related client-side
  findings: `landinfo.xml` defines roads/rivers as `PathBrush` strokes
  (generated, never stored), and the "river" beside the OlmecHead is
  really the SpringfieldFalls decoration's oversized sprite art, not
  terrain. `tools/gen_map_explorer.py` now exports deduped walks
  (`MAP_DATA.walks`); new `web/js/walks.js` (`CityWalks`) draws them
  cyan plus amber candidate-street bands distilled by `census()` from
  off-saved-road segments (raw `_roadOccAll`, ≥5 segments/line). A new
  **"walk paths"** object-legend row toggles it (persisted,
  `mrsnrub.cityview.walks`, ships OFF). Evidence + tests: `notes/06`
  "Walk-path oracle", `notes/01`, `smoke-camera.cjs` walks block.

## 2026-10-19.8

- **Fixed: phantom ground filler (sand speckle etc.) now filtered, with a
  City View "speckle filter" legend toggle** — the three sand diamonds
  that appeared just south of the GiantRobot are real save bytes, but
  the whole `roadMapList` SAND grid is a procedural speckle lattice the
  real client never paints (x-period 16, ~19-row diagonal bands, map-
  wide); the same tests showed `roadsData`'s single-tile dashes are
  lattice filler at x≡3/12 (mod 16) (the "speckle" visible in a roads-
  only view), while DIRT_ROADS/KLSROAD are entirely generated.
  `Terrain` now drops the sand/dirtroad/klsroad grids and keeps a road
  tile only when its 8-connected component touches a `'P'` full-segment
  tile (roads 7,527→6,326; avenues, rivers, dirt and the sea are
  untouched). A new **speckle filter** row in the ground legend toggles
  it live for before/after comparison and persists in localStorage
  (`mrsnrub.cityview.speckle`, default on); `debugFrags` still sees the
  raw saved roads. Evidence + tests: `notes/01` "Filler grids",
  `smoke-camera.cjs` speckle block.

## 2026-10-19.7

- **Fixed: minimap click-to-jump landed on the wrong part of the map** —
  the minimap showed the z0 pyramid tile, which is square (the tile grid
  is): it covers 32,768 × 32,768 virtual px of which only the top
  20,889 are map, the rest white padding. The click handler mapped
  pointer positions against the real canvas height, so vertical clicks
  landed ~36% too high and the viewport rectangle was likewise
  squashed. `make_tiles.py` now also emits `minimap.jpg` — the z0 tile
  cropped to the real extent at canvas aspect — `index.html` uses it,
  and `viewer.js` maps clicks against the image box (excluding the
  container border). Regenerating the pyramid reproduces it.

## 2026-10-19.6

- **Fixed: map viewer now opens centred at ~35% instead of a black
  screen** — at boot the viewer opened with fit-to-screen zoom, but
  `fitToScreen()` ran before the viewport size (`vw`/`vh`) had ever been
  measured (they were only set inside `render()`), so `fitZoom()`
  computed `log2(0) = -Infinity` and every tile rendered at zero size;
  nothing appeared until a wheel event re-clamped the zoom. `fitToScreen()`
  and boot now measure the viewport first, and the initial view is the
  centre of the map at 35% screen zoom (`START_ZOOM_PCT` in
  `mapdump/renders/high-detail/viewer.js`); `0` / the Fit button still
  fits the whole map.

## 2026-10-19.5

- **Fixed: GiantRobot's east (left) shoulder detached from the torso** —
  the official menu render pins that one block's transformed **bbox
  top-left** at its `(x, y)` (shift `(0, −b·w) = (0, +114.5)` engine
  units) while every other rotated block pins the crop corner; the rig
  joint it was rotated about isn't encoded in the city bsv3 (26 B block
  stride, no pivot field), so the measured correction lives in an
  explicit anchor-keyed `BLOCK_NUDGE` table in
  `tools/gen_city_sprites.py`. Fit evidence: east-shoulder window
  silhouette IoU 0.673→0.932, luma NCC 0.190→0.763; full-frame vs the
  official render IoU 0.956, NCC 0.872. Also fixed on the way: all
  reference-fit masks now use the webp **alpha** channel (the menu
  renders have transparent, not white, backgrounds — RGB thresholds
  silently counted the background as silhouette). Evidence:
  `mapdump/registration/m4-east-shoulder-fixed{,-zoom}.png`; acceptance
  harness `mapdump/registration/m4-east-nudge-fit.py`; notes/06 "East
  upperarm bbox-pin exception".
- **Full pool regenerated under the reversed draw order + neutral-frame
  rule** — `gen_city_sprites.py sprites` completed 3,592/3,592 assets
  (3,593 pngs incl. legacy extras), 0 blocks skipped; static frames now
  come from the first frame of the *neutral* animation (GiantRobot
  frame 38) composited in reverse file-record order, and
  `web/assets/city/giantrobot.png` carries the shoulder fix above.

## 2026-10-19.4

- **Fixed: rotated sprite parts drawn in the wrong spot (GiantRobot's head
  and arms now assemble; 322 sprites affected)** — after the affine
  constants fix, rotated bsv3 blocks rendered but sat off-position: the
  compositor was placing each block's transformed **bbox top-left** at
  `(x, y)`, but the engine pins the cell's **(0,0) crop corner** at
  `(x, y)` and applies the matrix from there, with `(b, c)` stored
  **transposed** (`X = a·u + c·v`, `Y = b·u + d·v`). Evidence: the
  `innstable` searchlight's five ray blocks share a hub — crop-origin
  placement converges them to 9 px (bbox-TL splays them 132 px) — and the
  GiantRobot limb chain only reaches its forearm/hand under the transposed
  order (elbow gaps 300→83 px and 110→48 px; per-asset joint vote 21:17).
  The earlier mirror-pair audit is untouched: for `b = c = 0` flip/scale
  blocks (all audit cases) the two rules coincide, and a fresh raw re-audit
  of 1,200 flipped pairs confirms the content-edge relation 5,907:10.
  `render_static` in `tools/gen_city_sprites.py` updated; full pool
  regenerated (3,592/3,592; 322 rotation-carrying sprites changed canvas
  extent/anchor as rotated content now extends the bbox, power plants and
  other scale-only sprites byte-stable; one `pizzatruckflipped` 0.01 px
  anchor jitter traced to engine float-noise b/c of 1.5e-5). Evidence:
  `mapdump/registration/m4-giantrobot-placement-fix.png`,
  `m4-innstable-placement-fix.png`, `m4-giantrobot-placement.png`
  (hypothesis sheet). Smoke suites pass (`smoke-server.sh` needs the
  user-managed 8090 instance up).

## 2026-10-19.3

- **Fixed: rotated/sheared sprite parts vanished (GiantRobot lost its head
  and left arm; 1,349 sprites affected)** — the bsv3 affine compositor in
  `tools/gen_city_sprites.py` fed PIL inverse-mapping coefficients that
  folded each block's absolute canvas placement into the constant terms
  while PIL samples the crop in *window-local* coordinates: any rotated
  block far from the origin sampled its texture sheet far outside its
  crop, so the part rendered transparent (or as a random sheet region).
  The constants are now `M⁻¹·(rx0, ry0)` (the pre-normalization bbox
  offset), which is the correct bbox-local inverse map; identity/scale
  blocks (the NEAREST branch) were never affected. Full pool regenerated
  (3,592/3,592, anchors/pivots byte-identical to before — the new
  `reanchor` rule reproduces exactly, 0 diffs); GiantRobot's head, jaw,
  both hands and arms now draw with the correct painter order. Evidence:
  `mapdump/registration/m4-giantrobot-affinefix.png`. All smoke suites
  pass.

## 2026-10-19.2

- **Fixed: directional fences drawn along the wrong axis in City View**
  (barbed wire east of the PowerPlant, the WoodenFence row between
  `SimpsonHome` and `SkinnerHouse`, ~580 instances across 40+ families) —
  directional buildings have four art variants (`…se/…sw/…ne/…nw`,
  `flipState` 0..3 selecting them), and the exporter was already sizing
  footprints from the variant, but City View only ever picked
  `slug`/`slug+flipped`, so every `flipState != 0` fence drew the
  base east-west art. `tools/gen_map_explorer.py` now resolves the
  variant per instance (column 8 of a `MAP_DATA.buildings` row, emitted
  only when the variant art ships in `city-sprites.json`), and
  `web/js/city-view.js` uses it as the sprite key, suppressing the old
  flipped-suffix fallback for those rows. Regenerated
  `web/js/map-explorer-data.js` (583 rows gained variant slugs);
  instances whose directional art isn't extracted yet (zoo walls,
  stadium bleachers, ~65 names) keep today's base/flipped behavior as a
  stopgap. All smoke suites pass.

## 2026-10-19

- **Fixed: PowerPlantBuildings / PowerPlantLot sprites offset ~3.5 tiles (the
  "part of the power plant juts out south" bug)** — a full save audit
  confirmed the compound is exactly three instances (`PowerPlant`+`flip=1`,
  `PowerPlantBuildings`+`flip=1`, `PowerPlantLot`, pb pivots (4,12)/(9,12)/
  (14,12); no missed fourth component in `buildingData`, stealable/adHoc/
  subLand/group layers). The two `bbox`-re-pinned powerplant sprites sat on
  guessed anchors; the asset xml defs' long-mysterious `transImageX/Y` pair
  turns out to carry the authoring anchor for exactly these degenerate
  assets (`ax = -transImageX`, `ay = h + transImageY` — verified: ~347
  healthy assets reproduce their bsv3 anchor to <1.5 px, while several other
  healthy assets carry unrelated values, so the pair is applied **only**
  where the bsv3 pivot was degenerate). `powerplant01flipped` moves 218 px
  east and `powerplant02` 64 px; 36 assets gain authoritative anchors
  (`"pivot":"xml"` in `city-sprites.json`), all 3,554 healthy sprites
  untouched. `tools/gen_city_sprites.py` gains a `reanchor` subcommand
  (manifest-only, idempotent) and the same rule in the `sprites` render
  path. Evidence: `mapdump/registration/m4-pp2-variants.png` (panel B
  eye-tested as correct), `m4-pp-trans-*.png`. Known gap: the separate
  `_transimage.rgb` overlay layers (916 assets) remain uncomposited —
  eye-test showed the compound is correct without them; deferred. All
  smoke suites pass.

## 2026-10-18.20

- **Fixed: PowerPlant and 30+ other building sprites drawn at wrong size/position** —
  the sprite pipeline (`tools/gen_city_sprites.py`) was ignoring each bsv3
  block's 2×2 matrix and honoring only the flip sign, so scaled/rotated art
  (powerplant00's 2× cooling towers and 9.5× reactor glow, searchlight rays,
  sheared drop shadows) rendered at 1×/unrotated. Block placement semantics
  were pinned empirically from the pool's flipped/unflipped asset pairs
  (`(x,y)` = transformed-bbox top-left; mirror relation held 6141:23) and
  full affine compositing implemented (NEAREST for diagonal scales, BILINEAR
  for rotation/shear). Separately, 38 single-block assets ship with a
  degenerate pivot (image top-left at the origin, hanging below the ground
  pin) — they are now re-pinned to the bbox bottom-centre and flagged
  `"pivot":"bbox"` in `city-sprites.json`; healthy sprites and flat ground
  decals are untouched (bimodal raw-anchor distribution). Full pool
  regenerated (3592/3592, 0 failures); before/after evidence at
  `mapdump/registration/m4-powerplant-compare.png`. All 8 smoke suites pass.
- **Fixed: character idle art manifest nearly empty (20/1023 names)** —
  `chars` now filters the asset pool to parseable `bcell10` cells (the
  `bcell11`/`bcell13` stubs that reference missing external `_image_N.rgb`
  sheets were shadowing the core pack's renderable cells) and the name
  matcher tests stem-in-name both directions with longest-stem-wins.
  `characters.json` v2: 119 save characters -> 53 rendered idle sprites
  (full core street cast; characters without art remain dots). Supporting
  the stub format (Carl/Lenny/Ralph/Maggie + costumed chars) is the
  documented follow-up — needs the tsto2rgb bcell13 writer as ground truth.

## 2026-10-18.19

- **Added: tile-based viewer for the high-detail map render** — the 12
  8192x6963 PNGs in `mapdump/renders/high-detail/` form one
  32,768x20,889 px canvas that browsers can't display directly.
  `make_tiles.py` (PIL, plus
  ImageMagick-compatible output; originals only read) cuts them into a
  256px JPEG tile pyramid under
  `mapdump/renders/high-detail/tiles/{z}/{x}/{y}.jpg`
  (z 0..7, ~14k tiles, 131 MB) and writes `meta.json`/`meta.js`. A
  dependency-free viewer (`mapdump/renders/high-detail/index.html`,
  `viewer.js`,
  `style.css`) provides drag-pan, cursor-anchored wheel/pinch zoom
  (fractional levels, native 1:1 max), minimap jump-to, keyboard
  shortcuts, and lazy loading with a low-res ghost layer underneath.
  Opens straight from `file://`. Tiles verified against the originals
  (mean |diff| = JPEG noise only, incl. source-seam tiles); overview
  comparison saved as `mapdump/registration/m4-tilecheck-overview-vs-preview.jpg`.

## 2026-10-18.18

- **Fixed: block prisms, wire edges, click outline and hit-testing now sit
  on the sprite's actual base** — the City View block rectangle was built
  from the catalog rule `[posX−locX+1 .. +w] × [posY−locY+1 .. +d]`, which
  tracks the engine's *occupancy grid*, while the sprite's ground pivot is
  the tile corner `(posX, posY)` = the footprint diamond's screen-front
  corner (headless check: the bsv3 pivots of e.g. TheToothChipper sit
  below the art bbox, i.e. art hangs above a front-corner pivot; 1×1 prop
  art is pivot-centred). The two conventions disagree by `(locX−1,
  locY−1+d)` tiles, which is why the gold click outline — and the Wire
  edges and block fill, which share `blockPolys` — drifted off correctly
  placed sprites, worst for large footprints. `buildBuildings` now derives
  the rect as `[px .. px+w] × [py−d .. py]` from the instance pivot, and
  the painter depth uses the true screen-front corner `(x0, y1)`. The
  Tune walkers were re-targeted (singles = pivot-centred props, anchored
  = base-corner vs wire, offsets = widest footprints vs the S scale).
  Note `data/building_footprints.json` locX/locY still describe the
  occupancy grid (as the engine stores them); only City View's prism
  geometry changed. Map Explorer's flat view is untouched.

## 2026-10-18.17

- **Changed: sprite ground pin is now RE-pinned to the tile corner** —
  the Tune panel's `ax`/`ay` nudges default to **0** (was 0.5/0.5).
  Static RE of the game binary settled the placement convention that
  the eyeball knobs could not (route B, notes/06 "Sprite placement
  RE"): the engine places a building instance at `S·(−z, x, height)`
  from the raw export `positionX/Y` verbatim — `locX`/`locY` are read
  in exactly one place and only seed the footprint grid as
  `(locX−1, locY−1)`, never the world position — and every building
  position in the save is an integer lattice point (characters sit on
  `.5` centres, which is why the people layer keeps its `+0.5`). So
  the sprite's ground point is the diamond *corner*
  `tileToWorld(px, py)`, not the tile centre. The `arttune`
  localStorage key is versioned to `.v2` so half-tile nudges saved
  during earlier A/B testing do not mask the new defaults; the Tune
  walkers and URL knobs (`?artAx=&artAy=&artS=`) are unchanged. The
  art scale `S` stays empirical — try `?artS=64` (the camera's
  PX_PER_UNIT) against the shipped 62 during the eye-test.

## 2026-10-18.16

- **Added: building wireframe toggle (City View)** — the new **Wire**
  button (`#btn-wire`) draws the full 12-edge bounding box on every
  building block. The filled block prism only ever shows its three
  visible faces, so the base edges on the hidden west/north sides were
  invisible — now all four ground edges draw in cyan (what sprite bases
  should sit on) and the top rim + verticals in translucent white,
  over blocks and sprites alike, in painter order. Works with the Tile
  grid and Tune walkers for the sprite-seating eye-test. Persists in
  `localStorage` (`mrsnrub.cityview.wire`).

## 2026-10-18.15

- **Changed: tune-panel walkers split into three candidate lists (City
  View)** — the single **⏭ big-offset** walker is replaced by
  **⏭ singles** (every 1×1 prop whose anchor *is* the footprint origin,
  ~81 distinct), **⏭ anchored** (multi-tile buildings with
  anchor == origin, ~799 distinct) and **⏭ offsets** (anchor ≥2 tiles
  off origin, biggest first). Each list isolates one degree of freedom
  of the pin convention: on singles/anchored the anchor-vs-origin
  toggle is provably a no-op, so whatever residual offset you see there
  is the tile-internal pin (dial `ax`/`ay` once against them); offsets
  is where the pin choice is judged. All walkers now step one instance
  *per slug*, so each click shows different art (per-slug anchor errors
  surface instead of being masked by repeats of one busy asset).

## 2026-10-18.14

- **Added: in-browser sprite pin tuning panel (City View)** — the new
  **Tune** button (`#btn-tune`) opens a top-right panel that A/B's the
  billboard pin conventions live, no reloads: `pin` toggle
  (anchor tile vs footprint origin), `ax`/`ay` ground-point steppers
  (0.25-tile steps), an `S` scale stepper (art px per tile), a
  **⏭ big-offset** walker that steps the camera through the multi-tile
  buildings whose catalog anchor sits ≥2 tiles off the footprint origin
  (the instances where the pin convention shows most — it selects each
  so the details card names it), and a **defaults** reset. Values
  persist in `localStorage` (`mrsnrub.cityview.arttune`; precedence
  defaults < saved < URL params). Opening the panel auto-enables Art
  mode. `tools/smoke-city-view-dom.cjs` covers build, pin toggle,
  steppers, walker selection and reset.

## 2026-10-18.13

- **Added: sprite ground-point tuning knobs (City View)** — the Art
  billboard pin is now dialable live instead of by file edit: URL params
  `?artS=` (art px per tile), `?artAx=` / `?artAy=` (ground-point nudge
  in tile units) and `?artRef=origin` (pin at the footprint origin
  instead of the catalog anchor tile), plus a console surface
  (`window.ART` + `__ART_tweak({ay: 1})`) that re-renders on change.
  Added while chasing the eye-test report that sprites sit half a tile
  high on 1-tile objects (consistent with a tile-diamond corner pin,
  `artAx=0 artAy=1`) and several tiles north on large ones (consistent
  with the pin belonging at the footprint origin, since the save's
  anchor tile is offset from it by the catalog `locX/locY − 1`). Winning
  values get baked back into the `ART` defaults once pinned.

## 2026-10-18.12

- **Added: sprite-billboard art toggle (City View)** — the new **Art**
  button (`#btn-art`) cycles buildings and characters between the
  primitives (raised blocks / yellow dots, the shipped default) and the
  extracted art: city sprite billboards from `assets/city/` placed via
  the `city-sprites.json` canvas anchors at S ≈ 62 art-px per tile
  (notes/06 §10), and `.bcell` idle poses from `assets/characters/`
  (characters.json v2 maps save character ids to assets). Manifest or
  PNG missing degrades that one building/person to its primitive, so
  coverage gaps never blank the scene. The choice persists in
  `localStorage` (`mrsnrub.cityview.art`); `ART.S`/`ART.ax`/`ART.ay`
  are the empirical scale/anchor knobs. `tools/gen_city_sprites.py`
  now also harvests family `*.bcell` frames (worker KINDS + keep) for
  the character pipeline.

- **Added: tile grid overlay (City View)** — the new **Tile grid**
  button (`#btn-grid`) draws the tile lattice over the scene (minor
  lines cyan, majors every 10 brighter and numbered when zoomed in
  enough to read) plus a highlighted diamond on the tile under the
  cursor and a `hover x,y` tile readout — the alignment yardstick for
  eyeballing sprite anchor offsets against the tile the clickable
  entity occupies. Lattice lines drop out gracefully when the zoom is
  too far out to resolve them. Persists in `localStorage`
  (`mrsnrub.cityview.grid`). `tools/smoke-city-view-dom.cjs` gained
  toggle/lattice/readout checks for both buttons.

## 2026-10-18.11

- **Added: progress-board process guide** — `notes/07-progress-board.md`
  defines how work lands on the dashboard's task & decision board: what
  qualifies (pending-approval decisions, deferred/blocked work, shipped
  milestones — not session scratch-pads), title/kind/status/source/notes
  conventions, the approval rule (only the user moves an item out of
  `pending-approval`; user-deferred items stay deferred), copy/pasteable
  `curl` POST examples against `web/api/progress.php` (plus the CLI
  equivalent), an end-of-session checklist (add tasks/decisions, journal
  line, run the scanner), and how the board stays consistent with
  `notes/03-open-work.md` (board = status, notes/03 = rationale). Added
  as item 8 of the `notes/README.md` read order, mandatory for any
  session that defers work or needs a user decision.

## 2026-10-18.10

- **Fixed: progress dashboard failed to render in the browser** — the
  meter renderer called `classList.add()` with an empty class name for
  every partial (neither 0% nor 100%) meter; real browsers throw
  `DOMTokenList.add: The empty string is not a valid token`, which the
  page's fetch-catch misreported as "Progress API unreachable". The
  class is now added only when non-empty. This class of bug was invisible
  to the existing checks (syntax check + PHP-CLI API smoke), so
  **`tools/smoke-progress-dom.cjs`** lands with it: drives the real
  `js/progress.js` on a stub DOM whose `classList` is browser-strict
  (empty tokens throw), renders all meter states / sparklines / coverage
  chips / task rows and simulates the status-select, delete, task-add and
  journal POSTs. Verified to catch the original bug by mutation. All
  suites green.

## 2026-10-18.9

- **Added: Progress tracker — dashboard of RE / unpacking / extraction
  completeness** — a new three-part system measures how far along the
  project is and keeps the number honest: `tools/progress_scan.py`
  (stdlib-only, zero-network) scans every artifact in the tree and writes a
  timestamped snapshot of ~45 meters into `web/api/progress.sqlite`;
  `web/api/progress.php` (same JSON/SQLite pattern as `streets.php`) serves
  the latest snapshot, per-metric trend history vs previous snapshots, and
  the per-bundle coverage grid; and `web/progress.html` renders it as a
  dashboard with progress bars, sparkline trends, a 510-bundle coverage
  grid (downloaded → indexed → unpacked → contributing-decoded), an
  editable **task & decision board** (seeded from `notes/03-open-work.md`
  approval states; edited in the page via POST), and a session journal.
  Headline meters today: **510/510 archive.org bundles downloaded, 3/510
  indexed in the CDN Explorer, 128/4,869 v469 master-index packages decoded
  (2.6%)**, PCM audio 0/62, bsv3 rendered 0/834, save buildings
  2,299/3,440, streets eye-test 1/24. Scan data is computed-only (the PHP
  API never mutates metrics), so the browser cannot fake progress. Run
  `python3 tools/progress_scan.py` to add a snapshot (end of each working
  session). New page under the shared base URL:
  `http://dave-latitude-5550.tailc953b.ts.net:8081/mrsnrub/web/progress.html`
  (API: `…/web/api/progress.php`). Headless test: `python3
  tools/smoke-progress.py` (fixture tree + meter assertions + PHP CLI API
  exercise via `PROGRESS_DB`/`PROGRESS_TEST_BODY`).

## 2026-10-18.8

- **Fixed: E-W candidate extent now data-derived (police stn south road)**
  — the first horizontal candidate shipped as a guessed x 100–200 slab and
  the user eye test correctly rejected it ("way too long"). The f5 row
  census now supplies the extent instead of a guess: the saved south-side
  row runs 0–47 / 64–111 / **128–143** on y 175, so the beside-station
  stretch is exactly **x 124–143** (crossroads-to-end, y 174–175). Seed
  row migrated in place in SQLite (stale `bad` verdict from the long
  version cleared). Pins updated (`smoke-camera`). All 7 smoke suites
  green.

## 2026-10-18.7

- **Promoted: x 126–127 boulevard is now a street + E-W candidate beside the
  police station** — the user eye test approved the crosswalk-straddle
  candidate (verdict panel id 1: "the road that goes down near the police
  station, four-way intersection with the crossings"), so `[126, 127, 146,
  208]` joins `Terrain.AVENUE.streets` (5th verified street; kerb art still
  only shows in sheet-art mode 3, shipped default unchanged). The same
  eye-test caught that the E–W road drawn there sits on the **north** side
  of the police station while the game has it on the **south**: the data
  agrees — the save's player-edit layer holds a 170–171 row slicing the
  station footprint (grid x 135–141, y 168–172) while the KLCrosswalk
  props cluster at y 173–174 with a saved road row at 175. Per the closed
  road system-of-record the saved rows stay untouched (the game draws them
  too); the true template road enters as the first **E–W PROPOSED
  candidate** — x 100–200 @ y 174–175 (24 seeds; the panel/overlay/PHP
  handle horizontal rects fine, `syncSeeds()` adds it to your existing DB
  on next load). Also: DB verdict for id 1 set to `ok` server-side to match
  the eye test, and the sqlite WAL pair was opened to 666 so neither the
  CLI tooling nor the PHP user can lock the other out again. Pins: 126–127
  promoted extent + E-W candidate presence (`smoke-camera`), 24-row panel
  (`smoke-city-view-dom`). All 7 smoke suites green.

## 2026-10-18.6

- **Added: hover-to-find highlight + east-coast candidates (street verdict
  panel)** — hovering a candidate row in the City View streets panel now
  makes that street impossible to miss: `Terrain#hoverProposed` repaints it
  LAST in loud yellow with dark per-cell outlines while every other
  candidate dims to ghost alpha (unknown/hovered-off-list ids stay inert).
  Each row also gains a **⌖** button that turns the overlay on if needed and
  centers the camera on the street's midpoint at rest zoom — find off-screen
  candidates without hunting. Twelve new seed candidates cover the east arm
  to the coast, justified by the layer decode (saved E–W avenues + dense
  road cells run to x≈511, sand/beach NE): pitch-24 continuation 306/330/
  354/378/402/426/450/474/498 plus three half-pitch samples (318/390/462)
  testing whether the east grid is +12-offset like the x 126 case — 23
  seeds total. `api/streets.php` seeds from a single `seeds()` list and
  now runs an idempotent `syncSeeds()` on every GET, so databases seeded
  before new candidates were authored pick them up without touching
  existing verdicts or user rows. Pins updated: hover stroke diff +
  unknown-id inertness + east-seed presence (`smoke-camera`), 23-row panel
  + ⌖ affordance (`smoke-city-view-dom`). All 7 smoke suites green.

## 2026-10-18.5

- **Added: clickable terrain tiles (City View)** — ground tiles are now
  inspectable like blocks and people. `terrain.js` builds a `_occ`
  occupancy map (`"tx,ty"` -> layer typeIndices in draw order) alongside
  the feature list and exposes `Terrain#typesAt` (coverage, topmost last)
  and `Terrain#topTypeAt` (top VISIBLE layer honouring the ground-legend
  toggles; `'grass'` for the base fill, `null` when everything there is
  hidden); `Terrain.TYPE_ORDER` is now exported. The City View click
  hit-test falls through people -> blocks -> ground: the click is
  inverse-projected to its tile-space cell and the terrain card shows the
  layer name, town tile, grid tile, layer tile count + bbox and the source
  frame length. Since grass is an infinite plane, clicking the *same* tile
  again deselects (Esc still works), a ground-legend toggle hides +
  deselects its selected tile, and the selected tile is outlined with the
  gold diamond. Blocks/people still claim clicks first; the Prop streets
  shift+click path is untouched. `tools/smoke-city-view-dom.cjs` gained a
  "terrain tiles" section (API pins incl. hidden-layer fall-through, road-
  tile click card, re-click deselect) and the background-click check now
  asserts grass selection (37 checks total).

## 2026-10-18.4

- **Added: candidate-street eye-test tool (City View + PHP/SQLite)** — the
  Prospective N–S streets from the closed road system-of-record investigation
  (notes/06 §10) are now eye-testable in City View without touching the
  shipped street table. A new **Prop streets** viewbar button toggles
  `Terrain#showProposed`: `Terrain.PROPOSED` candidates (grid coords) render
  as per-cell translucent fills tinted by verdict — cyan pending / green ok /
  red bad — and a top-left verdict panel lists them (swatch, extent, source
  note, ok/bad/pending counter). Clicking a row cycles pending → ok → bad →
  pending; verdicts POST to the new `web/api/streets.php` (PDO SQLite,
  auto-created `web/api/streets.sqlite` with an 11-row seed) when served over
  HTTP, and fall back to the built-in list + localStorage when opened from
  `file://` or the API is down. **Shift+click** the map while the overlay is
  on proposes a new 2-wide candidate at the clicked grid column (y-range =
  current view) via the API's `add` action; user-added rows can be deleted,
  seed rows cannot. Promoting an `ok` verdict into `Terrain.AVENUE.streets`
  stays a manual per-street code change — `avenueAt`/`_roadOcc` deliberately
  never consult candidates. Seeds: x 126–127 (crosswalk straddle, y 146–208),
  118–119 re-measure, pitch-24 extensions 138…282, gap-filler 42–43 and
  western 6–7. New files: `web/api/streets.php` (the PHP process user needs
  write access to `web/api/` for the sqlite + WAL files; CLI tests feed the
  JSON body via `STREETS_TEST_BODY`). New pins in `tools/smoke-camera.cjs`
  (seeds never leak into `avenueAt`, overlay default-off, fill diff) and
  `tools/smoke-city-view-dom.cjs` (panel build, hidden-by-default, button
  toggle). All 7 smoke suites green.

## 2026-10-18.3

- **Added: search result list in the City View right pane** — typing in the
  search box now fills a clickable list under the details card: matches are
  grouped by catalog id (thousands of decor instances collapse to one row
  each, with the instance count), ranked exact-id/name first, then prefix,
  then substring, and capped at 100 rows with an "and N more — refine the
  search" hint. Clicking a row selects that item's first instance (details
  card + gold outline) and centers the camera on it; the selected item's
  row is marked, whether selected from the list or by clicking the canvas.
  Clearing the search empties the list. New smoke checks in
  `tools/smoke-city-view-dom.cjs` (27 checks total) pin the list build,
  result-row select, the cap hint, and clearing.

## 2026-10-18.2

- **Added: click-to-inspect + search (City View)** — `web/city-view.html`
  gains a Map Explorer-style right details pane and header search box. A
  click (drags are excluded) hit-tests the depth-sorted blocks and people
  front-to-back — people first, then the block's three screen quads from
  the new shared `blockPolys()` helper, so draw, hit-test and outlines
  always agree — and renders the same details card the Map Explorer shows
  (plus the object-legend bucket). Esc or a background click deselects;
  the selected block is outlined gold and search matches are outlined blue
  (capped at 600 draws). The search matches names/assets/slugs/ids across
  buildings and characters, reports a count in the viewbar, and Enter
  centers + selects the first match (zooming to rest if viewing from
  orbit). Hidden object-legend buckets are neither clickable nor
  searchable, and hiding a bucket deselects an element on it. Reset now
  also clears the selection and search; arrow keys no longer pan while
  typing in the search box. `CityObjects` now exports `PEOPLE_R` (dot
  geometry shared with the hit-test). New headless test
  `tools/smoke-city-view-dom.cjs` (22 checks) drives the real scripts:
  boot, select/deselect/Esc, drag-click suppression, dot picking, search,
  reset.

## 2026-10-18

- **Added: clickable legend layer toggles (Map Explorer)** — every legend
  swatch row in `web/map-explorer.html` is now a show/hide toggle: click
  (or Enter/Space, rows are `role="button"`) to hide a terrain layer
  (grass, ocean, sand, dirt, river, road, dirtroad, klsroad) and the
  canvas redraws without it; mono rail, characters, and a new **buildings**
  row (palette-gradient swatch) hide the matching overlay divs via an
  `.eloff` class. Hidden rows render struck-through and greyed, carry a
  `data-tip` naming the action (project tooltip convention, no `title`),
  and the legend now takes pointer events — pan-drag and click-to-unpin
  are stopped from reaching the stage through it. Hidden elements are
  excluded from search matches, and hiding a layer unpins an element that
  was pinned on it. `tools/smoke-map-explorer-dom.cjs` grew an 11-check
  "legend layer toggles" section (44 checks total).

## 2026-10-17.25

- **Added: fourth N–S avenue street 30/31 (`Terrain.AVENUE`)** — the
  candidate from .24 passed the eye test: grid columns 30–1/31–1
  spanning y 235–250 shipped in the streets table (west-of-town
  street, west of the 66/67 pair). Mode 3 of the **Road art** button
  now renders four streets. The other two .24 candidates split:
  78/79 rejected (plaza paving, not a street — the plaza grey
  (140,138,140) passes the asphalt key), 118/119 deferred to the
  fixed east-side registration (below). Smoke pins flipped:
  `avenueAt(30,240)` positive, negatives at (30,234)/(30,251).

- **Added: ground-plane homography registration (`tools/calib-solve.py`,
  M4 item 3)** — City View export registration now solves the 8-DOF
  projective model instead of the 6-DOF oblique affine. Roads are
  ground-plane features and a perspective camera maps the ground plane
  exactly by a homography, so the "east-side residuals = game
  perspective" note is resolved without any device capture. The new
  tool reads `calib-pairs.txt`, prints per-pair residuals, applies
  deterministic outlier rejection (drop residual > max(40 px,
  3×median) — rejects the `zoo` pair) and writes
  `mapdump/registration/g2e-affine.json` (baseline, RMS 40 px) and
  `g2e-homog.json` (robust fit, kept-RMS 16 px, with the kept-pair
  list). `tools/smoke-calib.cjs` gained section 6 pinning both JSONs
  against the pairs file. Re-running under the robust fit un-broke the
  east side: 118/119 now reads as one crisp run y 261–271 (twin of
  114/115) and 19 isolated long east candidates were found
  (168/169 y215–309, 232/233, 120/121, …) with evidence crops
  `mapdump/registration/m4-avH-<x>-<y0>-<y1>.png` — NOT shipped,
  awaiting eye test. Four dense auto-alignment routes (roadlike-pixel
  Powell fit, per-probe colour-offset search, free-(dx,dy) window
  search, NCC boulevard chaining) were tried and rejected with
  reasons in notes/06 §10.

## 2026-10-17.24

- **Changed: N–S avenues knob now per-street extents + third street
  (`Terrain.AVENUE`)** — the experimental avenues model moved from
  shared `columns`/`ySegments` (all pairs × all bands) to explicit
  streets `[x0, x1, yLo, yHi]`, letting each hand-placed street carry
  its own span. Adds the newly verified street at grid columns
  114–115 spanning y 263–272 (9/9 crisp asphalt rows in the export
  walk), alongside the existing 66–67 and 90–91 streets (y 221–258).
  Mode 3 of the **Road art** button now renders three streets. The
  stale "engine-laid" comment was replaced with the 2026-10-17 RE
  findings (client-side XML land format seeded by `StartingLand.xml`;
  server starter stores only one E–W 'P' run — notes/06 §10).
  Candidates measured but NOT yet shipped pending eye test: 30/31 @
  ~235–250, 78/79 @ 252–269, 118/119 — evidence crops under
  `mapdump/registration/m4-av-cand-*.png`. Smoke pins updated for the
  new model (per-street extents, negatives for 114/78/30/118).

## 2026-10-17.23

- **Added: `1-wide frags` debug toggle in City View (`Terrain#debugFrags`)** —
  highlights the save's 1-wide N–S road fragments (driveway/frontage
  stubs — road cells isolated along x but stacked along y) as
  translucent magenta diamonds, so they can be compared against the
  export and told apart from the 2-wide streets (boulevards +
  synthesised avenues). New toolbar button next to **Road art**,
  persisted in `localStorage` (`mrsnrub.cityview.frags`). The
  classifier runs once off the road occupancy and is cached. New
  `smoke-camera` pins: default off, the measured x = 291 gang (town
  279, y 52–59) present, side cells absent, classification invariant
  over every frag cell, and overlay fills increase when on. Evidence
  image `mapdump/registration/m4-frag-overlay.png` shows the gang
  near the Squipport park sitting under the game's pond/hedge props —
  ground-layer tiles, normally occluded.

## 2026-10-17.22

- **Fixed: experimental avenues drew roads through grass and
  speculative columns (`Terrain.AVENUE` → verified columns +
  `ySegments`)** — the user's eye test on `Road art·av` correctly
  flagged the synthesised streets as "not in the right spot".
  Per-row export walks showed the avenues are **per-block, not a
  full-height grid**: the two verified streets (grid x 66–67,
  90–91) exist only at **y 221–258**, bounded north by an E–W road
  at rows 223–225 that is *also* missing from the save layer and
  south by the saved 261–263 band; the next pitch column 114/115
  has no street there (its street sits at 263–272) — so the town
  blocks are hand-placed and the generalised `gx mod 24` grid was
  drawing streets the game doesn't have. `Terrain.AVENUE` now holds
  `columns: [[66,67],[90,91]]` + `ySegments: [[221,258]]` (verified
  streets only); `avenueAt` and the draw-pass viewport clamp follow,
  and `smoke-camera` pins the new model (verified pairs on, 114/115
  and out-of-segment rows off, mask 13/14 selection, draw pass).
  New evidence image replaces the old montage at
  `mapdump/registration/m4-avenues-abc.png` (game | 60% ghost
  overlay | cell outlines). Notes/06 §10 + planning 1b updated;
  the unsaved 223–225 E–W road and the per-band column inventory
  are new RE leads.

## 2026-10-17.21

- **Added: experimental procedural N–S avenues behind `Terrain#useAvenues`
  (Road art button mode 3, ships OFF)** — the investigation into "only
  E–W roads look right" concluded: the game's continuous N–S streets
  are **not in the save road layer at all** (raw `roadsData` is
  byte-identical to the web layer, char set complete), and the
  `roadMapList` files are the 7 road-KIND overlays from notes/01
  (DIRT_ROADS…SAND), not a street source — they don't cover the town's
  N–S columns. The engine lays them at runtime (notes/01: roadmap
  record bits 6..15 are "set only by the road-construction code").
  Sub-cell export walks near the west anchors measured two clean
  streets: centres grid x 66.9 / 90.9, ~2 cells wide, pitch 24.
  `Terrain.AVENUE` ({pitch 24, col 18, width 2, town-band bounds})
  synthesises those cells when the new knob is on; they join the
  neighbour-mask union so flanks select the existing kerb states 4 /
  3+flip (masks 13/14) and E–W-band crossings go interior. The City
  View **Road art** button now cycles OFF→uniform→edges→edges+avenues
  (`Road art·av`), persisted 0..3 in `mrsnrub.cityview.sheetart`;
  `sheetStateFor` gained an optional `extra` probe arg. New
  `smoke-camera` pins: `avenueAt` pitch/phase/y-band, mask 13/14
  selection, avenue draw pass, default stays FLAT; all six suites
  green. Generator RE (global phase, y extents) pending — see
  notes/06 §10 and planning 1b.

## 2026-10-17.20

- **Fixed: sheet road states rendered 90° rotated (kerbs across the
  road instead of along it)** — the eye test on the new **Road
  art·edges** mode showed the kerb/paving strips cutting across the
  2-wide bands. Cause: `_sheetTile` mapped the sheet cell box's
  image-column axis to `q[1]−q[3]` and its image-row axis to
  `q[2]−q[0]`, but `quad()` returns corners `[corner(x,y)=LEFT,
  (x+1,y)=TOP, (x+1,y+1)=RIGHT, (x,y+1)=BOTTOM]` — so the box was
  being painted with its axes swapped, rotating every composite state
  90° (state 0 is symmetric, which is why the approved flat/uniform
  look never exposed it). The affine now maps image columns along
  `q2−q0` (screen right) and image rows along `q3−q1` (screen down),
  exactly as the art appears in the sheet; the `SHEET_TABLE` state
  assignments are unchanged. `smoke-camera` pins the new axes (the
  sheet affine's first column must be more horizontal than vertical,
  second column more vertical). No user-facing knobs changed; docs
  corrected in `terrain.js` and notes/06 §10.

## 2026-10-17.19

- **Road kerb/sidewalk edge selection (M4 TODO item 1) — RE'd
  connectivity-nibble model behind `Terrain#sheetSelect`** — road
  tiles can now pick their roadrivertiles sheet state from their
  neighbourhood instead of drawing everything as flat asphalt (state
  0), reproducing the game's white-kerb + paving-slab strips along
  2-wide band edges. RE (libscorpio.so): the RoadDrawer base-tile
  selector `0x1208058` branches on a per-cell 4-bit
  neighbour-connectivity nibble (`bl 0x1134fa8` = `record.byte[4] &
  0xf`), confirmed by ±1-cell neighbour queries (vtable `+0x30`/
  `+0x18`, cells `(cx±1,cy)`, `(cx,cy±1)`), and mirrors left/right
  variants on a coordinate parity (`tst w21,1` + `csel` at
  `0x1208234`/`0x12084d4`); cell = one world unit = one save tile
  (wrapper divides query coords by 4). Quadrant-material
  classification of the 11 state cells (grey asphalt vs lavender
  paving) yields the mask→state table: 2-wide band-edge rows (3-of-4
  masks) → states 3/4 (asphalt with a paving+kerb strip on the grass
  side; horizontal flips supply the mirrored edges), corner bends →
  half-split states 1/5/8, interior → 0; dead ends/diagonals have no
  art in the 11 states and fall back to 0. New files: none. New
  surface: `Terrain#sheetSelect` (`'uniform'` shipped default — the
  approved flat look — or `'neighbor'`), `Terrain.SHEET_STATES`,
  `Terrain.SHEET_TABLE`, `Terrain.sheetStateFor`, `_sheetTile` flip
  arg; the City View **Road art** button now cycles OFF → uniform →
  edges (localStorage value now `0/1/2`). Not modelled yet: the
  engine's parity alternation of variant pairs (3 vs 10, 4 vs 7) and
  the flag-byte special paths. Still ships OFF; `smoke-camera` gained
  table/state checks and all six suites stay green (FLAT default +
  landmark anchor untouched).

## 2026-10-17.18

- **Road sheet art RE fix (M4 TODO item 1) — corrected cells + engine
  sampling, still OFF until eye test** — the roadrivertiles fit that
  failed the 2026-10-17.16 eye test had two root causes, both pinned by
  a static RE pass on `libscorpio.so`'s RoadDrawer: the 11 cell-state UV
  quads at `.rodata 0x400520` (11 × 32-byte records, 8 floats =
  top/right/left/bottom `(u,v)` corners, ×512 = sheet px) decode to 11
  lattice cells `0=(-1,7) 1=(-1,5) 2=(-1,6) 3=(-2,5) 4=(-1,4) 5=(-1,1)
  6=(-2,1) 7=(-1,-1) 8=(-1,3) 9=(-2,3) 10=(-1,2)`. The old default
  `(-1,4)` is **state 4, a composite** (half lavender paving-grid) — the
  contact-sheet "plain asphalt" catalogue was wrong (the sheet has no
  transparency, so the alpha-coverage test never discriminated);
  **state 0 `(-1,7)`** is the true full-asphalt tile. And every engine
  quad samples the cell diamond **inset to 127×66 px** (centre ±63.5/
  ±33) — the previous full-135×74 box dragged neighbouring cells
  (green/cliff) into the diamond corners. `terrain.js` now defaults
  `sheetSlots.road = [-1, 7]` and `_sheetTile` uses the inset box
  (transform denominators follow); verified headlessly with PIL
  composites of the downtown band over the Android full-map export
  (control vs old vs new, `/tmp/opencode/m4-road-ab-stack.png`; the
  cell-span-2 and continuous-sheet-lattice hypotheses tested worse).
  New City View toolbar **Road art** button toggles
  `Terrain#useSheetArt` live and persists in `localStorage` under
  `mrsnrub.cityview.sheetart` (survives Rotate/Mirror rebuilds) so the
  A/B needs no devtools. The shipped default stays FLAT roads until the
  user approves the look (`smoke-camera.cjs` pins both the corrected
  127×66 source rect and the FLAT default, +1 check for the state-0
  slot). Remaining for item 1 after approval: per-quadrant SELECTION
  (kerb/sidewalk edge composites, selector `0x1208058`) so band edges
  get edge-cells like the game. `notes/06` §10 rewritten with the
  full quad decode + corrected cell catalogue.

## 2026-10-17.17

- **Road sheet art deferred to M4 (ships OFF)** — the user eye test on
  the new roadrivertiles road art (2026-10-17.16) failed ("in but not
  right"), so `Terrain#useSheetArt` now **defaults to false**: City View
  ships the accepted flat Phase-1 road diamonds + drawn manholes again.
  The wiring, knobs, lattice constants and 8-check smoke block stay so
  M4 can iterate without rebuilding any of it. Diagnosis-first TODO
  written up as item 1 of the new **"M4 TODO"** list in
  `planning/phase-2-camera-view.md` (road art fit, dynamic camera
  capture for perspective/zoom constants, `PX_PER_UNIT`, M1 building
  sprites, character sprites); `notes/06` open item 4 points at it.

## 2026-10-17.16

- **City View roads now use the real in-game road art** — the
  roadrivertiles pack was already extracted on disk
  (`web/assets/dlc/roadrivertiles-50/images/roadtilesheet.png`); its
  lattice was measured (plane tiling of ~135×74 2:1 diamonds, cell
  centre = `274 + 135c + (r mod 2)·67.5, 140 + 37r`; 24 filled cells
  catalogued) and the `road` layer now paints the plain-asphalt cell
  `c=-1 r=4` instead of the flat grey diamond, clipped to the tile
  diamond and drawn through a composed affine (DPR-safe). The flat fill
  stays underneath (no antialias seams); the drawn manhole is suppressed
  under sheet tiles (the art has its own dots). New named knobs:
  `Terrain#useSheetArt` (false = flat Phase-1 colours),
  `Terrain#sheetSlots` (layer → cell), `Terrain#roadSheetImg` (page-owned
  Image; load failure or missing pack falls back to flat roads — City
  View now depends on that DLC pack being present under `web/assets/`).
  Deliberate: `dirtroad`/`klsroad` keep flat fills (sheet has no
  dirt-road variants) and the uniform per-layer cell mapping is our
  documented design — engine-faithful tile selection stays on the
  roadrivertiles RE backlog. `tools/smoke-camera.cjs` gained a 7-check
  block (source-rect pin, manhole suppression, both fallback paths,
  knob honoured). Sea-fill eyeball check closed (user-verified);
  legend/explorer gaps A–D settled as-is by user decision.

## 2026-10-17.15

- **Camera orientation settled by landmark calibration** — the 9
  user-picked export↔world correspondences from `tools/calib-pick.html`
  were solved by least squares against the oblique model
  (`tools/calib-images.py` images; raw data preserved in new
  `mapdump/registration/calib-pairs.txt`). Result: **the shipped
  `CAM.ORIENT {fx:1, fy:−1, swap:1}` is confirmed** — RMS **46 px** on a
  16200×8370 export, and it is the unique physically valid triple
  (`s, hw, hh > 0`) among the 8 dihedral states; the next valid state is
  41× worse. No shipped constant changed (`hh/hw` measured 0.522 vs the
  shipped 2:1 — inside click noise, `TILE` stays as documented). The
  long-running "sx/sy ≈ 1.8–2.1× anisotropy" question is **closed as a
  fitting artifact**: the calibration's fitted tile axes are equal-length
  (3% apart), so the save's building tile units are square. The
  60–80 px east-side residuals (same-sign, growing eastward) are the
  game camera's mild perspective — left as the documented affine
  approximation, homography deliberately not fit; perspective stays on
  the M4 list. `tools/smoke-camera.cjs` gained the permanent anchor: it
  re-projects all 9 landmarks through the production
  `CAM.oriented`/grid→town convention, bounds the RMS, enumerates the 8
  states via the group generators, and asserts the shipped triple beats
  every other valid state by >10× (this subsumes the old sea-band
  eye-anchor). `notes/06` §9 rewritten from "⚠ under revision" to
  "✅ landmark-calibrated" with the full method + history.

## 2026-10-17.14

- **Fixed: calibration picker paste box was always empty** — `makePaste`
  built its lines with `L.join('\n')` *then* called `L.push`/`L.join` on
  the resulting **string**, so the function threw on every refresh: the
  textarea never populated and the "(N pairs)" hint froze at its static
  HTML. Clicks were still recorded (pairs persisted to `localStorage`);
  just the paste output and its live count were dead. Now `L` stays an
  array and joins once at the end. `tools/smoke-calib.cjs` gained a
  **DOM-shim functional check** — it runs the page's inline script under
  Node against a fake `document`/`localStorage` and asserts the script
  boots, the paste box carries the documented header with 0 pairs, and
  the hint counts live — so this class of runtime-only crash (invisible
  to the static greps above) now fails the suite.

## 2026-10-17.13

- **Calibration world map: 65 stamped labels → 23 numbered pins with
  spread-out labels** — the world generator stamped a yellow label at
  every building whose name merely *contained* a keyword, so the broad
  lists (`Fire`, `Police`, `Museum`, `Stadium`, `Zoo`, `Ferris`) matched
  65 props (`FireHydrant`, `PoliceTank`, `Campfire`, `Zoominator` rides…)
  and downtown was an unreadable pile of text. `tools/calib-images.py`
  now uses an exact-name curated list (real landmarks only, footprint
  ≥ 12 tiles to reject prop duplicates, one pin per name, capped at 24 —
  23 resolved, spread from Squid Port to the Museum of Natural History).
  Pin **circles stay at the exact tile centres** (those are the
  calibration targets); the **labels are spread out**: each `# name`
  label slides to the nearest free spot in a growing ring of candidates
  (collision-checked against every placed label), with a red leader line
  back to its circle, and a legend panel (bottom-left, open ground south
  of the sea) lists number → name → tile centre. Reload the picker and
  the new `calib-world.png` shows through.
  `tools/smoke-calib.cjs` gained a freshness guard: both PNGs must be
  newer than `calib-images.py`, so a stale image after a generator edit
  now fails the suite.

## 2026-10-17.12

- **Fixed: calibration picker dots landed away from the click** — the
  image wrapper was a block-level div, so it took the *pane's* width
  instead of the image's; the `%`-positioned markers were computed
  against that too-narrow box and landed compressed toward the left
  (most visible on the 4050px-wide export). The wrapper now shrink-wraps
  the image (`width: fit-content`), markers are correctly `%`-based at
  any zoom, markers redraw once the images finish loading (a boot-time
  pass ran with `naturalWidth = 0`), and the sticky pane headers are
  `pointer-events: none` so clicks near the top edge reach the map.
- **Calibration picker opens zoomed in** — the export pane now starts at
  1.5× (world at 1×) via a new `DEFAULT_ZOOM` knob; the 25–200% buttons
  still override. `tools/smoke-calib.cjs` gained static guards for the
  shrink-wrap contract and the default-zoom knob.

## 2026-10-17.11

- **Landmark calibration picker (`tools/calib-pick.html`)** — instead of
  eyeballing the two calibration PNGs and reporting coordinates by hand,
  the user now *clicks*: open the page from `file://`, click a landmark
  on the export screenshot (left pane, ruler-labelled) then the same
  landmark on the world map (right pane, red pins) — a named pair is
  recorded. Repeat for 8–12 well-spread pairs; per-row **re-pick**
  buttons fix mistypes, pairs persist in `localStorage`
  (`mrsnrub.calib.pairs`) across reloads. The bottom panel live-renders
  a paste block (`name | export px x,y | grid tile x,y`, export coords
  in full-res screenshot px, world coords in grid tiles with town tiles
  shown in the table) to copy into chat — that output is the input for
  solving the projection exactly (notes/06 §9). New
  `tools/smoke-calib.cjs` statically pins the page's click→coordinate
  transforms to `tools/calib-images.py` (S, XLO, px-per-tile) and to the
  generated data's ox/oy, checks the PNGs exist, that the inline script
  parses, and that the paste-block header keeps the documented shape.

## 2026-10-17.10

- **City View object legend (per-category toggles)** — a second overlay
  panel, bottom-right, lists the placed objects by bucket: **buildings**,
  **vehicles**, **rail** (KL monorail), **nature**, **decor**, and
  **people**, each with its instance count and swatch, each clickable to
  hide/show that bucket (`objHidden` checked in `render`). New module
  `web/js/objects.js` (`CityObjects`) holds the classifier: the save
  catalog `binfo` has no category field, so buckets are derived from the
  asset *name* — CamelCase-word lookups per bucket (`classify`,
  `countCats`), with everything unmatched falling back to `buildings`
  (correct for named landmarks like `KrustyBurger`, and it avoids the
  substring traps a plain regex hits: `PowerPlant` contains "plant",
  `BartsTreehouse` contains "tree"). This is a RE workbench aid, not the
  game's taxonomy. `people` is now actually rendered: `M.chars` appear as
  char-coloured ground dots via `CityObjects.drawPeople`, drawn after the
  blocks (documented painter's-algorithm simplification) and culled to
  the viewport. Both panels share one `togglePanel` builder and the
  `.legend` CSS class (so the `overUI` gesture guard now matches
  `.legend`, keeping the map pannable under both); a static smoke check
  asserts the buckets are non-empty, partition every placed object, and
  that the spot-classified landmarks still land in the right bucket.

## 2026-10-17.9

- **City View legend is now the layer control panel** — every legend
  row (grass + the seven terrain types) is a clickable button that
  toggles that ground layer's visibility. Backed by new documented
  methods `Terrain#setVisible(type, on)` / `Terrain#isHidden(type)`
  (state in `Terrain#hidden`, checked in `Terrain#render`): hiding
  `ocean` drops the wave marks *and* the solid sea base together;
  hiding `grass` leaves the base unpainted. Rows are real
  `<button>`s with `aria-pressed`, a dimmed/strikethrough `.off`
  style, focus outline, the shared `data-tip` tooltip convention
  (`city-view.css` was missing the project's tooltip rule block —
  now present, identical to `app.css`), and the map stays pannable
  under the legend (container keeps `pointer-events: none`, rows opt
  back in). Toggle state survives a Rotate 90°/Mirror rebuild.
  `tools/smoke-camera.cjs` gained a fake-ctx block asserting
  paint/suppress/restore per type; all smoke suites and
  `node --check` pass.

- **Fixed: legend toggles did nothing when clicked** — the legend
  overlays the map stage, so the pan gesture's `pointerdown` handler
  (which calls `stage.setPointerCapture`) swallowed presses on the
  rows before their `click` fired. All stage gestures
  (`pointerdown`/`wheel`/`dblclick`) now bail out via an `overUI(e)`
  check (`target.closest('#legend')`); `smoke-camera.cjs` gained a
  static guard asserting every gesture keeps it.

## 2026-10-17.8

- **Ocean layer is column-major and offshore — it's the Squid Port
  sea** — the 3072-char ocean layer is the 96×512 sea-patch frame
  stored **COLUMN-major** (each char = 16 cells along **y** of column
  `i/32`), and the frame is anchored **outside the town, west of grid
  x = 0**: the sea is the Squid Port / Barnacle Bay water, a vertical
  strip at grid x ≈ −64..0 running y 0..512 with the shoreline at
  x ≈ 0. The previous row-major decode painted it as a horizontal
  band at the top; an interim fix then placed it *inside* the map
  (x 0..33) — which put the water on top of the boardwalk and 417
  road cells. Decisive data: 127 water props at negative x along the
  left edge (`SquidportEntrance`, `BarnacleBayMarina`, boardwalk
  stalls/railings at x −11..+4, `LuxuryYacht`, `AircraftCarrier`,
  whales, `PrivateIsland`×3, `Skull/Garbage/CandyApple/…Island`,
  `Shipwreck` at x −44; y 30..500) and the road layer's min x is
  exactly 0. Both decoders gained a documented `vert` flag, applied
  by string length (3072): `terrain.js#decodeTiles` (with
  `Terrain#seaColOffset` shifting marks to the water) and
  `map-explorer.js#decodeTiles`. `tools/smoke-camera.cjs` ocean
  anchors re-anchored to data facts (sea strip left-below of centre;
  dense wave-mark sub-band on the deep-water side; new invariants:
  every wave mark lies on the water polygon, the shoreline stays
  west of the road grid). The §9 orientation note in `notes/06` is
  marked under revision — the earlier eye-test verdict was judging
  the mis-decoded ocean — and awaits the landmark calibration.

- **Solid sea base fill** — `web/js/terrain.js` now paints the game's
  continuous sea as one water-blue parallelogram (`SEA_RGB =
  (84,170,252)`, the export-sampled sea colour) over the water
  polygon — grid x −64..0 × y 0..512 (offshore edge to shoreline,
  along the Squid Port coast) — under the wave-mark tiles, using the
  same ground transform as the grass fill. New documented knobs
  `Terrain#seaFill`, `seaColOffset` (−33), `seaFillX0` (−64),
  `seaFillX1` (0), `seaFillY0` (0), `seaFillY1` (512). The ocean
  wave-mark tiles switched to a lighter documented placeholder
  `(120,190,255)` so the RE'd mark pattern stays visible over the
  base. `tools/smoke-camera.cjs` gained a headless render
  check (fake ctx) asserting the base is painted in the RE blue,
  spans the water polygon, and shares the ground transform; all
  smoke suites and `node --check` pass. `city-view.js` `TOWN` now
  extends to the offshore edge so whole-town presets show the water.
  Note: the sand layer **is** rendered (632 tan tiles) but has only
  3 cells near the coast — the save contains no beach data; in-game
  shoreline sand is `roadrivertiles` base art, still to be RE'd.

- **Registration status note** — multi-class fitting of streets/
  buildings onto the export plateaued (~0.4–0.6) and was judged not
  trustworthy for the camera constants (perspective + classification
  noise; the old "anisotropic artifact" was likely real: the save's
  layer x/y units appear non-square). Pixel-exact camera alignment
  moved to landmark calibration; calibration inputs generated by
  `tools/calib-images.py` into `mapdump/registration/`
  (`calib-export.png` with a labelled pixel
  ruler, `calib-world.png` top-down with a 32-tile grid and pins on
  named landmarks incl. PowerPlant, Kwik-E-Mart, DuffStadium).

## 2026-10-17.7

- **Zoom fixed: wheel/double-click now traverse the full range
  continuously** — reported symptoms ("can't zoom out once zoomed in";
  "first zoom-in jumps to very zoomed") were both one bug: gesture
  zoom was clamped to the base-game range `[ZOOM.min, ZOOM.max]` =
  [1.0, 1.5] while the Full-town/Ocean presets sit far below rest
  (~0.02) via unclamped fits. The first wheel notch from a preset got
  snapped 0.02 → 1.0 (a 64x jump), and after that the wheel-out floor
  at 1.0 made the overview unreachable. `camera.js` now clamps
  gestures to a workbench range `[ZOOM.wbMin, ZOOM.max]` (new
  documented knob `wbMin = 0.005`); the base-game values
  (`rest/min/max`, ladder `steps`) are kept unchanged as fidelity
  constants for the M4 A/B pass and still drive the double-click
  ladder at/above rest. Below the ladder, double-click now steps in
  by 1.25x per click and lands exactly on rest when crossing it,
  instead of leaping from preset scale to 1.0. `smoke-camera.cjs`
  gained regression checks: one notch from a zoomed-out preset moves
  zoom continuously (no clamp jump), zooming back out to the preset
  scale works, and repeated double-clicks reach the ladder exactly.
  All smoke suites and `node --check` pass.

## 2026-10-17.6

- **Orientation pinned: City View ships `{ fx: 1, fy: -1, swap: 1 }`**
  — the user drove the new Rotate/Mirror rig against the Android
  full-map export and confirmed the correct state, so it is now the
  shipped default in `camera.js` (`CAM.ORIENT`). Under it, +x runs
  upper-right and +y lower-right: the ocean wave-mark band (grid rows
  2–26) sits along the diamond's upper-left edge with its dense/pier
  half toward the top corner — matching the game. This also corrects
  the record in notes/06 §9: the earlier registration pick
  (`{1,-1,0}`) had chosen the wrong one of the two statistically tied
  axis-assignment branches, and its `sx/sy ≈ 1.8` "anisotropy" was the
  artifact of that; the export's true pitch measures 0.501, confirming
  the documented 2:1 `TILE` default. `tools/smoke-camera.cjs` was
  re-anchored: the ocean band must render upper-left of the town
  centre and the dense wave-mark half must face the top corner (a
  rotation or mirror regression now fails the suite), and the
  adjacent-tile/depth-sort checks were made orientation-generic
  (swap-aware). All smoke suites and `node --check` pass; the headless
  re-render of the full-town and Ocean presets shows the sea band,
  sand fringe and avenue grid in the matched positions.

## 2026-10-17.5

- **Manual orientation rig for the City View** — since the registered
  orientation still didn't match the game by eye, the toolbar gains
  **↻ Rotate 90°** and **Mirror** buttons so the map can be positioned
  manually, plus a gold readout in the toolbar showing the exact
  current knob, e.g. `ORIENT = { fx: 1, fy: -1, swap: 0 }`, which can
  be pasted back into a bug report. To make all 8 orientations
  expressible, `CAM.ORIENT` grew from `{fx, fy}` to `{fx, fy, swap}`
  (an optional tile-axis swap): every projection, depth sort, ground
  matrix and culling path now derives from the one helper
  `CAM.oriented(x, y)`, with `CAM.orientRotate90` /
  `CAM.orientMirror` stepping the triple. The buttons rebuild the
  terrain + building sort orders and re-apply the active preset; the
  chosen triple persists in `localStorage`
  (`mrsnrub.cityview.orient`) across reloads — delete the key to get
  the shipped default back. `tools/smoke-camera.cjs` adds an
  orientation-rig block: group laws (rotate⁴ = id, mirror² = id, 8
  distinct states), round-trip/depth consistency in all 8 states, and
  `terrain.js` `groundTransform` agreement with the CAM projection in
  all 8 states. All smoke suites and `node --check` pass.

## 2026-10-17.4

- **City View orientation pinned by the in-game full-map export; ocean
  now paints game water-blue** — the Android full-map screenshot
  (`Tapped Out - Simpsons_Screenshot-2025-01-17--19-12-02.png`) was
  registered to the save's 512×1087 grid by content (roads/buildings/
  terrain scored per axis assignment over all 16 dihedral+transposed
  orientations, multi-start optimisation with coverage constraints,
  verified with rendered overlays). The winner puts tile (0,0) at the
  diamond's left corner with +x toward the bottom (beach/pier) corner
  — a **y-mirror** of tile space, so `CAM.ORIENT` changed from
  `{-1,-1}` (180° rotation) to `{fx:1, fy:-1}`. This corrects the
  "ocean not in the right place" symptom: under the old rot180 the
  ocean/wave-mark band and the pier end of the coast were mirrored to
  the wrong end of the coastline. The registration also measured the
  game's oblique pitch at 0.501 (validating the documented 2:1 `TILE`
  default) and showed mild perspective in the game camera (noted in
  notes/06 §9 for the M4 pass). Additionally, `terrain.js`'s ocean
  tile colour is now the sea water colour sampled from the export,
  `(84,170,252)`, instead of the legend navy — the sparse ocean layer
  turns out to be wave marks over the game's solid sea base art (and
  its string is a 512×96 patch grid, not town-sized). `smoke-camera.cjs`
  gains a coast-asymmetry assertion (dense wave-mark half must face
  the bottom corner) so a mirror regression fails the suite; all
  smoke suites and `node --check` pass.

## 2026-10-17.3

- **Ocean tiles now visible: minimum tile size + Ocean view preset** —
  the ocean tiles were always painted (1,582 diamonds, verified through
  the app's exact `terrain.js`/`camera.js` render path), but each one is
  ~2 px wide at whole-town zoom and the layer covers only ~12 % of its
  rows, so they vanished against the grass and were off-screen entirely
  in the Rest/Downtown presets. Two changes make them usable as the
  orientation reference point: (1) `terrain.js` now paints feature
  tiles at a minimum on-screen size — new knob `Terrain#minTilePx`
  (default 4 CSS px, 2:1) kicks in below threshold, so ocean/sand/river
  read as coloured diamonds at any zoom (manholes skip when tiles are
  in minimum-size mode); (2) a new **Ocean** button in `city-view.html`
  frames the ocean layer's bounding box in one click (via
  `Terrain#typeBBox`), which shows the blue band running diagonally
  upper-left → lower-right with its sand edge — matching the official
  Town viewer reference.

## 2026-10-17.2

- **City View orientation fixed: 180° tile-space rotation (ocean anchor)** —
  the oblique camera now renders the town the same way the game's own Town
  viewer does, with the ocean along the **lower-left edge** of the diamond
  (was: upper-right, and never in frame). New documented knob
  `CAM.ORIENT = {fx: -1, fy: -1}` in `web/js/camera.js` applies signs to
  the tile axes before projection (`tileToWorld`, `worldToTile`,
  `depth`/`compareDepth`, `tileRectToWorldRect` all derive from it);
  `terrain.js` (feature sort, ground transform, manholes) and
  `city-view.js` (building painter-sort) read the same knob — the
  Map Explorer top-down view is unchanged, and rot180 preserves its
  handedness (a single-axis mirror was rejected). Grounded in the save's
  ocean layer (1,582 tiles at grid rows 2–26 = the map's lowest tile-y
  band, verified present all along) vs `springfield-example.jpg`, where
  the sea runs diagonally upper-left → lower-right on the left side.
  Note: these seven terrain layers are sparse overlay masks — the solid
  sea fill in the reference is base terrain art not yet RE'd, so the
  ocean currently reads as a blue-diamond band on the correct edge.
- **Fixed: full-town preset clipped the ocean and north town** — the
  `TOWN` bounding box in `city-view.js` used the grid origin offsets
  `(+ox, +oy)` as its top/left edges instead of `(−ox, −oy)`, so the
  Full-town preset cropped the entire northern third (ocean rows,
  beaches, half of downtown). Headless verification: all 1,582 ocean
  tiles now project inside the viewport at the full-town fit, on the
  lower-left side; `tools/smoke-camera.cjs` extended with the
  orientation-aware depth checks and an ocean-anchor assertion
  (34/34 green), other smoke suites unchanged.

## 2026-10-17

- **Phase 2 M2 + M3: oblique 2.5D City View with textured terrain** — new
  `web/city-view.html` (+ `web/js/city-view.js`, `web/css/city-view.css`,
  `web/js/terrain.js`) renders Springfield in the M0 oblique 2.5D camera as
  a full-canvas scene: a textured grass ground with raised, depth-sorted
  building blocks standing on their real footprints. Pan (drag), fling
  (exponential-decay inertia), wheel + double-click zoom (M0 clamps),
  arrow-key nudge, and Rest / Downtown / Full-town presets (the two wide
  framings are unclamped convenience views, per the "no whole-town fly-out"
  rule). No server, no network — opens from `file://` like the Map
  Explorer, and reuses `map-explorer-data.js` for the seven terrain layers
  + building footprints.
- **M2 terrain is occupancy-driven** — the ground is a flat oblique plane:
  a skewed grass texture (`web/assets/city/grasstile.png`) fills the whole
  viewport, and every non-grass tile (ocean/sand/dirt/river/road/dirtroad/
  klsroad) is drawn as its own 2:1 diamond in painter's order, road tiles
  additionally getting a per-tile manhole. This reproduces every road
  width, corner, T-junction and stub the save holds. It deliberately does
  **not** use the engine's 11 pre-rendered road cell-sprites: those express
  only 1-sub-cell edge/corner/stub/full/T/cross states, and this town's
  roads are 1–2 tiles wide at arbitrary cell phases (0–57 % of road cells
  match a state sprite across all 16 phases; the 2×2-subcell road histogram
  is broad, not bimodal). The exact art UVs stay a screenshot-backlog
  refinement.
- **Buildings are raised footprint blocks for now** — footprint + save
  height, extruded straight up on screen (the oblique convention), lit top
  / shadow left faces, painter-sorted by front-corner depth. The M1
  per-building sprite billboards (`web/assets/city`, 3,592 PNGs) land next
  once the sprite world-scale + anchor are pinned.
- **Verified without a browser** (per this phase's no-screenshot rule): the
  `terrain.js` transform is cross-checked against `camera.js`
  (tile↔world↔screen identity, `quad()` vs manual corners,
  `visibleTileRect` round-trip), and the full composition is PIL-rendered
  to PNG and image-spot-checked (flat Map Explorer colours sit inside the
  textured result). `tools/smoke-camera.cjs` still green.
- **notes/06 §10: occupancy-driven road model + refuted per-cell diamond
  model documented**, with the evidence (phase sweep, subcell histogram,
  1-save-tile = 1-world-unit calibration, road palette) and the named
  tunable knobs: `terrain.js grassRepeat` (default 8 tiles/repeat),
  `city-view.js HEIGHT_SCALE` (default 0.5), plus the M0 camera knobs.

## 2026-10-16.6

- **Phase 2 M1: static sprite pipeline delivered** — new
  `sprites` subcommand in `tools/gen_city_sprites.py`: parses both
  `.bsv3` variants (0x0103 inline frames, 0x0303 shared block pool)
  to exact EOF, composites a static frame per building with PIL, and
  writes `web/assets/city/<slug>.png` plus the `city-sprites.json`
  anchor manifest (canvas size, anchor = building (0,0) in canvas px,
  variant, static-source, blocks drawn, rotmax). 3,592 of the 3,630
  save-required slugs render (0 parse failures across all 3,618 pool
  bsv3 files); the 38 misses are fence/wall/railing/track pieces whose
  packs ship no billboard sprite — M2 terrain scope. Regenerate with
  `python3 tools/gen_city_sprites.py sprites` (re-run `extract` first
  if `/tmp/opencode/citypool/` was wiped).
- **0x0303 (moving-part landmarks) pinned and rendered** — header
  (`f32 1.0` + `nf/n_blocks/reserved`), 26/27-byte pool with the cell
  index LAST, and the trailing anim section located by a backward
  walk from EOF (verified on all 142 files). The variable-length frame
  section is only partially decoded: it opens with frame 0 as a run of
  `idx<<8` u16s (verified against exact tilings on arcdetriomphe and
  globe); the static pass decodes that run, caps it to one block per
  position slot (a real frame shows one block per slot), and falls
  back to per-position-cluster representatives or a body-only sprite
  (largest sheet cell) when the file has no locally-mapped blocks —
  the 56 `alpha=1` files reference a global sprite-handle table that
  isn't in the file, so they render body-only until the table is
  recovered (open RE item).
- **Fixed: 0x0103 block unpack was short one float** — the block is
  `u16 ci + 6×f32` (26 B), the old format read 5; stride-based parsing
  masked it until rendering unpacked 7 values.
- **Fixed: static frame picked from the wrong state for ~140 files** —
  "first named state, first frame" broke on buildings whose first
  state is an effect (cityhall = a graffiti decal), whose body lives
  in a later state (babooncountry), or whose frame 0 is a partial
  pose (airfortress). The static pick is now the fullest frame overall
  (max total local crop area); the ~53 remaining anchors that sit
  well above the canvas bottom are legitimate (floating islands,
  airships, elevated platforms — verified spot-by-spot).
- **Character idle sprites** — new `chars` subcommand: the core
  game-100 pack's 33 `<slug>_idle.bcell` sets are decoded (bcell10
  format) and written to `web/assets/characters/<slug>.png` +
  `characters.json` (anchor at the feet, per-character off-centre x).
  18 of them match save character names directly (Bart, Homer, Lisa,
  Marge, Apu, …); the save instantiates 854 distinct characters, so
  full-coverage extraction from the event packs is M4 scope.
- **notes/01: bsv3 spec rewritten** — the 0x0103/0x0303 sections
  replace the stale 22-byte-block draft; the ×100 fixed-point claim on
  block offsets is retracted (they're float pixels) and the
  partially-decoded 0x0303 frame section + backward anim walk are
  documented.

## 2026-10-16.5

- **Phase 2 M0: camera model delivered (documented canonical oblique
  projection)** — new `web/js/camera.js` (pure, no DOM, classic
  script): the world↔screen transform for the city view. The
  reverse-engineering gate on the base game's *exact* matrix constants
  ran out (the per-frame 4×4 build sits behind runtime-populated vtable
  dispatch and the indirect GL-wrapper table — no static caller path,
  no static matrix constants), so per the planning doc's sanctioned
  fallback the model is the canonical 2:1 oblique projection with every
  number a named, documented knob (pitch ratio `TILE`, resting size
  `PX_PER_UNIT`, zoom ladder/clamps, pan inertia) rather than a
  silently tuned one. Implements the user's binding zoom correction:
  the base game does not zoom out to whole-town scale — the camera
  rests at 1.0 and only zooms *in* (base clamp `[1.0, 1.5]`, discrete
  double-click ladder `[1.0, 1.25, 1.5]` that wraps at the top,
  continuous clamped wheel); the full-town fit is an explicit
  unclamped convenience preset, clearly outside the base clamps.
- **Camera smoke suite** — new `tools/smoke-camera.cjs` (31 headless
  checks): tile/world round-trip, 2:1 diamond geometry, painter's
  sort, pan invariance, zoom-at-point stability, the zoom-in-biased
  clamps, ladder stepping (incl. mid-ladder snap), unclamped
  full-town fit, fling-inertia decay. All green.
- **notes/06: camera RE state captured at the gate** — new §8
  (wrapper-table decode, 0 static refs to the uniform slot, the 19
  singleton refs, runtime-populated class descriptors, negative
  static-matrix scan, full camera property roster) and §9 (the
  canonical projection derivation + which knobs the screenshot
  backlog must pin); §2 record layout corrected, §7 ADD field decode
  verified and annotated; open item 1 now lists the three remaining
  routes (screenshot backlog, runtime hook of the `glUniformMatrix4fv`
  wrapper, emulated vtable reconstruction) with the tooling that's
  ready for them.

## 2026-10-16.4

- **Planning: Phase 2 doc — "City renderer: the camera-view basis"** —
  `planning/phase-2-camera-view.md` (linked from `planning/README.md`)
  plans the next session's work: replacing the placeholder city screen
  with the base game's camera view — oblique camera over textured ground,
  buildings as billboard sprites on their verified footprints, characters
  as `.bcell` animations, game-like pan/zoom. It inventories the verified
  basis (decoded save, terrain codebook, 100% building/character
  catalogs, footprint/flipState semantics, Map Explorer scaffold,
  camera RE state from `notes/06`), scopes the phase (camera model RE or
  empirical A/B fallback, static-sprite pipeline from the 611 local CDN
  families, `roadtilesheet.rgb` terrain texture, standalone
  `web/city-view.html` with the same conventions as the Map Explorer),
  lists the seven key unknowns in attack order (camera matrix build,
  `transImageX/Y` anchor units, bsv3 static-frame choice, sheet UV
  mapping, `_transimage.rgb` semantics, character bcell coverage, exact
  grid origin), and sets milestones M0–M5, acceptance criteria and the
  session-start checklist. No code or data changes; new discovery logged
  for it: the core `game-100` pack's per-building asset layout
  (`slug.rgb` sheet + `slug.bsv3` scene + `slug_transimage.rgb` +
  `slug.xml`) and the 1024×1024 `roadtilesheet.rgb` terrain texture in
  the same packs.

## 2026-10-16.3

- **New Map Explorer: interactive HTML of the decoded city save** —
  `web/map-explorer.html` renders the save schematically (no sprites) as a
  pan/zoom page: the 7 terrain layers are decoded in-page from the raw
  `mapData` strings (verified codebook), all 5,261 buildings are drawn as
  blocks at their per-instance footprints (directional fence variants and
  the monorail straight-track flip included — the same rules as the
  verified JPG renders), and all 871 characters sit as named dots. Hover
  any object for a quick tip, click to pin it; the details pane lists
  everything recovered for the id — asset, slug, footprint, anchor,
  height, position, flipState, how it was resolved, and its count in the
  save. Search by name / asset / slug / id across buildings *and*
  characters (Enter centers the first match); drag to pan, wheel /
  double-click to zoom, arrow keys nudge, Full town / Downtown presets.
  The page is self-contained (data inlined — opens straight from
  `file://`, no server, no network).
- **New generator + two more catalog files** — `tools/gen_map_explorer.py`
  rebuilds `web/js/map-explorer-data.js` (≈0.6 MB inline data) from the
  save in `mapdump/` plus the `data/` catalogs, so it is re-runnable
  project-locally. Two pieces of the verified join are now kept in
  `data/`: `flip_assets.json` (fence name → `nameFlip{SE,SW,NE,NW}` asset
  variants) and `character_ids.json` (1,023 character ids → name; all 854
  distinct character ids in the save resolve).
- **Headless DOM test for the map page** —
  `tools/smoke-map-explorer-dom.cjs` drives the real `map-explorer.js` on
  a minimal DOM: boot + full object list (data-tip on every object, no
  `title` attributes), hover → details pane, click-to-pin + Esc, search
  dim/highlight/center, view presets, wheel-zoom clamping, drag-pan with
  click suppression, and the per-instance track dims in the data. 33
  checks, all passing.

## 2026-10-16.2

- **Building ID → name → asset → footprint catalog fully recovered
  (local-only, no binary RE needed)** — The newest `gamescripts` pack
  (r497432) is cumulative (4,003 XMLs), so the whole ID chain comes from
  XML: `buildings.xml` / `*_buildings.xml` / `*_decorations.xml` give
  `<Building id name=>` (3,440 ids; only `buildingmasterlist.xml`
  `<DataID>` entries may fill gaps — the other master lists share the
  numeric space and collide), `<BSv2 name/nameFlip*>` (in `*assetdata*.xml`
  *and* inline in building defs) gives the asset slug, and the footprint
  pool was rebuilt by extracting the nested `1` payload of **all 611**
  `*Game-100*` / `*Game_LTD-100*` / `*BuildDecoGame*{Fall,Snow}-100` zips
  across the 510-pack CDN (5,238 → 5,750 XMLs; some slugs such as
  `spookywall` and `trackstraight4x2` exist only in the seasonal snow/LTD
  variant zips, which the original core-only pass missed). Result:
  **100% of the save's 2,299 distinct building IDs (all 5,261 instances)
  resolve to real footprints**.
- **New/updated data files** — `data/building_ids.json` (3,440 ids →
  name/asset/slug), `data/building_footprints.json` (5,446 slugs →
  x/z/locX/locY/height — supersedes the old 137-entry core-only version,
  same slug-keyed schema), `data/save_buildings.json` (this save's 2,299
  ids resolved, incl. `via`: asset / flip / rotated / fence-fallback).
- **Footprint rect + flipState semantics verified** — a building at
  `(positionX, positionY)` covers tiles
  `X: [posX − locX + 1, posX − locX + x]`, `Y: [posY − locY + 1,
  posY − locY + z]` (locX/locY are 1-based corner offsets). Checked
  against the road grid: SimpsonHome (8×6, loc 4,1) and FlandersHome sit
  side by side fronting the Y=29–30 road; Kwik-E-Mart (7×4) fronts the
  Y=39 road; a flipState-1 church fronts the road on its flipped side
  with no overlap. `flipState` 0–3 maps to the `nameFlip{SE,SW,NE,NW}`
  fence variants in `.rodata` string order (SE/NW swap x/z relative to
  SW/NE, confirmed on 4 fence families); monorail `StraightTrack`
  (109500) is 4×2 at fs=0 and the `...flipped` asset 2×4 at fs=1; curve
  pieces are 4×4 centred. Details in `notes/01-binary-formats.md`
  ("Building ID → name → asset catalog" and "Footprint rect + flipState
  semantics"). No `web/` or server changes.

## 2026-10-16

- **Terrain `mapData` char→16-bit codebook extracted and verified from
  `libscorpio.so`** — Located the actual decoder (the earlier "open item #1"):
  a single per-char function at **`0x11a6288`**, called from the roadmap
  record-object ctor at `0xdb4fbc`. It writes one 8-byte record per char with a
  u16 payload (low 4 bits = x-offset `k`, bit 4 = "1-unit" flag, bit 5 =
  "2-unit" flag). The codebook is the **identity mapping**: **`a..p` → one tile
  at x-offset `c-'a'` (`1<<(c-'a')`), `G` → `0x0000`, `P` → `0xFFFF`** (all 16
  tiles via the 2-unit piece, whose per-layer on-tile size is 16 for roads).
  Confirmed three independent ways: (1) the binary's `cmp w8,#0x50` /
  `sub w?,w?,#0x61` / `cmp w?,#0xf` ladder; (2) `roadsData` rows 262 & 281 are
  32×`'P'` = solid full-width horizontal avenues; (3) decoding with this
  codebook at offset `town = grid − (12,136)` puts 576/5,261 buildings adjacent
  to road (left-to-right beats right-to-left 576:197; P=all-16 beats P=2-tile
  576:210). This also closes the `d`/`m` puzzle — `m` is exactly bit 12 (one
  tile), no hidden multi-bit pattern; it just falls where single-tile road /
  driveway tiles do. Also documented the `terrainType`→internal-type table
  (`0x3f38c0`), the real (non-abstract) vtables (found by applying `.rela.dyn`
  RELATIVE relocs to the reloc-addend==typeinfo scan — the old "vtable all
  zeros ⇒ abstract" reading was a raw-bytes mistake), and the `IBoolRect`
  vfuncs. Everything recorded in the "Terrain & roadmaps" section of
  `notes/01-binary-formats.md` (codebook table + mechanism + confirmation;
  "Resolved this pass" replaces the old open items). No `web/` or server
  changes — research/notes only.

## 2026-10-15.8

- **TSTO city-save / terrain-map format characterized (initial pass)** —
  decoded the uploaded `23034074771109153854742696256123764495.7z` (extracted
  to `mapdump/23034074771109153854742696256123764495.pb`, 1.9 MB) and
  characterized its map data. The `.pb` is a plain `Data.LandMessage`
  protobuf (clean EOF parse via `server-python/protofiles/LandData_pb2.py`
  plus the `google.protobuf.runtime_version` shim). New tools:
  `tools/decode_land.py` (full human-readable dump of every top-level
  section, cross-checking each `num*` counter against the actual arrays)
  and `tools/terrain_dump.py <city.pb> [outdir]` (dumps every `TerrainData`
  grid with type/size metadata + char histograms; `outdir` writes the raw
  payloads to `<outdir>/<name>.txt`). Headline format findings, documented
  in a new "Terrain & roadmaps" section of `notes/01-binary-formats.md`:
  terrain grids are one ASCII **char per 16 tiles (1 bit per tile),
  `'G'` = all-16-empty** — proven by the storage-bundle roadmaps' explicit
  `mapDataSizeX/Y` (16×48 → 48 chars, 32×32 → 64, 16×32 → 32); the main
  grid is 34,784 chars = **512 × 1087 tiles** (34,784 = 32 × 1087 with 1087
  prime, which rules out a 4×4-blocks-per-char layout); layer set =
  `roadsData` / `riversData` / `oceanData` + 7 per-road-kind overlays
  (`roadMapDataMessage.roadMapList`: DIRT_ROADS, DIRT, COBBLESTONE,
  ICERIVER, KLSROAD, GOLDROAD, SAND) + per-subland terrain + per-bundle
  roadmaps. C++ side (disassembly of `libscorpio.so`): the grid class is
  `RoadsUtil::RoadmapBoolRect` (abstract `IBoolRect`), and the registry
  entries literally named `RoadMap::Grid::fromString`/`toString` were
  exonerated — they resolve to float-conversion helpers, not the decoder.
  Recorded open items (with a concrete search recipe): the char → 16-bit-mask
  codebook (no static table exists — it is a computed switch inside the
  still-unlocated `RoadmapBoolRect` decoder), grid origin/row ordering, and
  `landBlocks` block size. No `web/` or server changes.

## 2026-10-15.7

- **Camera/movement RE pass 2: rendering pipeline + GL wrapper layer mapped,
  new `notes/06-camera-and-movement.md`** — Disassembly-focused follow-up on
  `libscorpio.so` aimed at replicating local camera + character movement.
  Findings: (1) the engine renders with a **modern GLES2 shader pipeline and
  no fixed-function matrix calls** — all camera math (pan/zoom/projection)
  is CPU-side and uploaded via `glUniformMatrix4fv`; the bundled shaders are
  just `position * matWorldViewProj`. (2) That single `glUniformMatrix4fv`
  site sits in a **cached GL state-wrapper layer** (~21 wrappers in a table
  at `0x24f100`) that dedupes uniform uploads by caching locations +
  value-equality — so only matrix *values* matter for a faithful port.
  (3) The earlier "camera cluster" turned out to be the **script-API
  registration table** (`fcn.00df9c90`, 12,216 strings): it registers
  script-callable methods (`Camera::setZoomLevel`, `panCamera`,
  `teleportCamera`, `shakeCamera`, …) and every camera **config knob**
  (`cameraMaxPanSpeed`, `cameraPanTime`, `cameraYOffset`, `cameraZoomLevel`,
  `Pitch`, `allowCameraMovement`, `cameraFollows`,
  `SelectionBoxCameraMovementDeadZone`, `InactiveTimeBeforeCameraReset`, …)
  by name — the game's own scripting layer can drive the camera directly.
  (4) Camera classes `BGSceneCamera`/`CameraManager`/`ShakeCameraAction`
  were located in the engine's 48-byte descriptor registry (they have **no
  C++ RTTI**, so vtables aren't traceable the usual way). Also recorded the
  binary's unusual PLT/GOT layout and a set of verified AArch64 decode
  rules (BR/BLR Rn is bits [9:5]; BL imm26 is `insn & 0x3FFFFFF`). Next
  steps (open items in the note): locate the per-frame matrix build
  (render dispatcher slot `0x538`/`0xf8`) and the pathfinder, and read the
  fan server's camera config *values*. No `web/` changes; no asset
  regeneration.

## 2026-10-15.6

- **Full `rizin aaa` cross-validation of the string-xref scan; request
  factory function pinned** — the background full analysis of
  `libscorpio.so` completed (7,033,811 xrefs, 88,201 functions). Comparing
  `axlj` against `re/str_xrefs.tsv`: every spot-checked pair found by the
  ADRP+ADD scan but missing from rizin's output verified genuine (zero false
  positives in sample; rizin's `aaa` simply missed those 2,172 direct
  ADRP+ADD xrefs while catching 126k more in other instruction shapes). The
  network request factory is now pinned to a single stripped function
  `fcn.012f01b8` (spans `0x12f01b8`–`0x12f49ac`, sits directly before the
  `BightGames::PrintNetworkHandler` vtable). `notes/05-game-logic.md` §5
  updated with the final function attribution and the cross-validation
  result.

## 2026-10-15.5

- **Function-level string cross-references without a full analysis pass** —
  new `re/str_xref_scan.py` decodes ADRP+ADD instruction pairs in one linear
  pass over `.text` (~1s, stdlib only; page math verified byte-for-byte
  against rizin's disassembler) and writes `re/str_xrefs.tsv` (52,336
  string→code xrefs). Headline findings, recorded in
  `notes/05-game-logic.md` §5: all 21 `/games/bg_gameserver_plugin/*`
  endpoints plus `/dlc/index` are referenced from a single ~14 KB code window
  (`0x12f0f24`–`0x12f30d0`) — the network request factory — which also
  carries the complete client→server op vocabulary (`AUTHENTICATE`,
  `UPGRADE_LAND`, `WHOLE_LAND_TOKEN`, `FIND_MATCH`, `HEARTBEAT`, … 24 more),
  the Nimble/EA-identity REST paths, and the auth header names
  (`mh_session_key`, `nucleus_token`, `synergy_id`, …). Identified the
  login-flow functions (login callback, token validation, login state
  machine, cached login data) and the CDN base-URL builder (the port is a
  runtime format slot, not hardcoded). Notes §5–§8 renumbered accordingly.

## 2026-10-15.4

- **Schema cross-validation: binary-decoded protocol matches the fan server
  exactly** — new `re/diff_schema_vs_server.py` compares every message, field,
  and number from the descriptor pool decoded out of `libscorpio.so`
  (`re/proto_files.json`) against the fan server's `.proto` sources in
  `server/source/server/protobufs/`, in both directions. Result: 15/15 game
  protos (198 messages, 1002 fields, 21 enums) with **zero** missing
  messages, zero missing fields, zero field-number mismatches, and zero
  pool-only fields. The decoded schema is confirmed as exact ground truth,
  and the fan server speaks the original EA protocol verbatim. Recorded in
  `notes/05-game-logic.md` §2.1.

## 2026-10-15.3

- **First pass on the native game logic (`libscorpio.so`) with rizin** — new
  `notes/05-game-logic.md` plus a new `re/` directory of artifacts. Key
  findings: (1) the binary embeds a private protobuf descriptor pool in a
  `protodesc_cold` section from which the **entire client↔server protocol**
  was reconstructed — 16 game `.proto` files, headlined by `LandData.proto`
  whose `LandMessage` (53 fields, ~90 nested messages) is the complete
  server-authoritative city state (buildings, characters, jobs, quests,
  currency, terrain, events); (2) the full server API surface (all
  `/games/bg_gameserver_plugin/*` routes, the whole-land-token save-lock
  dance, DLC `/dlc/index`); (3) the stripped game class roster recovered from
  RTTI typeinfo — 71 `BightGames::*` network/client classes
  (Task/NetworkHandler/Script families, `ScorpioGameClient`, land read/write
  handlers, steal/matchmaking handlers), 62 `BGMenuCmds::*` menu classes,
  plus Matchmaking/DataSelector/JobCensus/animation-Controller subsystems;
  (4) the exported JNI surface (engine pump + game callbacks). Confirms the
  client is a thin renderer over `LandMessage` — a playable web city is most
  realistically built by speaking this protobuf protocol to an existing
  server, not by porting the native logic. Artifacts: `re/parse_protodesc.py`
  (stdlib pool extractor), `re/proto_schema.txt` / `proto_files.json`
  (decoded protocol), `re/endpoints.txt`, `re/rtti_classes.txt`,
  `re/class_methods.json`, `re/syms-demangled.txt`, `re/demangle.cpp` (the
  system `c++filt` on this box is a no-op; this helper demangles).

## 2026-10-15.2

- **CDN Explorer now binds the Tailscale address by default** —
  `tools/cdn_explorer.py` auto-detects this machine's Tailscale IPv4
  (`tailscale ip -4`, falling back to parsing the `tailscale0` interface)
  and binds to it, so the workbench is reachable from other devices on the
  tailnet. If Tailscale is not up it falls back to 127.0.0.1 and says so in
  the startup banner. `--host` overrides the default either way. The tool
  still makes zero *outbound* connections; it is now reachable from tailnet
  devices, so keep it running only when you want it reachable. The smoke
  suite pins `--host 127.0.0.1` so it stays loopback regardless.

## 2026-10-15

- **CDN Explorer (Phase 1) shipped** — new `tools/cdn_explorer.py`
  (stdlib-only, binds 127.0.0.1, makes **zero** network connections) plus
  `web/cdn-explorer.html` (own `css/cdn-explorer.css` / `js/cdn-explorer.js`):
  a standalone RE workbench, independent of the Asset Explorer, that indexes
  the three local bundles `1_0_4.7z`, `1_1_35.7z`, `3_0_30.7z` (464 files,
  incl. 232 `.time` sidecars) into a new SQLite database,
  `cdn/cdn-explorer.db`. It provides virtual zip/pack browsing (incl. the
  nested `1` asset zip), hex view, on-the-fly previews (`.rgb`/`.bcell` →
  PNG, `.btp` → JSON, text), a findings journal + status workflow
  (`unknown → identified → decoded`) on files *and* entries, a format
  registry, a generations view, on-demand sha256 jobs, a "Mystery"
  unknown-by-name-pattern view, and `--dlc` pipeline-spec copy-out. Start it
  with `python3 tools/cdn_explorer.py` → http://127.0.0.1:8123/ (overrides:
  `--root/--db/--cache/--bundles`).
- **Phase 1 plan revised to the agreed scope** —
  `planning/phase-1-cdn-explorer.md` now targets the three
  user-downloaded bundles only: no fan-CDN metadata ingestion, no fan-index
  rows, no downloads of any kind (all deferred, with the verified
  colon-path derivation noted for the later pass). `.time` sidecars are
  first-class rows linked to their parent zip; corrections folded in:
  per-operation SQLite connections (the old "serialized by the GIL/WAL"
  claim was wrong), `--root`/`--db`/`--cache`/`--bundles` CLI, 7z 26.00
  `-slt` parser notes (column-0 fields, skip `Attributes = D` dirs),
  bytes/preview cache-miss behavior defined (triggers extraction), FTS5
  mention dropped, M0 spike marked measured (listing ≈ instant).
- **Format identified: `.time` sidecars are CDN upload timestamps** —
  exactly 10 ASCII bytes, no newline: the Unix epoch (seconds, UTC) of the
  sibling `.zip`'s last-modified time. Verified 30/30 on a 10-per-bundle
  sample; the values form a consistent per-generation timeline (originals
  2012-12-05, `r146180-0D2B882C` 2014-12-03, `r157326-B8353263`
  2015-03-24). Byte-exact spec added to `notes/01-binary-formats.md` (new
  "`.time` sidecars" section); the 30 sampled rows are marked `identified`
  in the explorer DB with a format finding on the representative row.
- **New headless smoke suite for the explorer** —
  `tools/smoke-cdn-explorer.py` (Python stdlib, loopback only): builds two
  tiny real 7z bundles (a real pack with hand-built `.rgb`/`.bcell`, a
  `.time` sidecar, a plain zip, a corrupt zip), drives the full API —
  scans, naming peel, sidecar links, nested opens, hex/bytes round-trips,
  PNG previews, findings CRUD, corrupt-zip non-fatality, sha256 job,
  kill+restart persistence — and cleans up its own test servers even on
  failure. All three existing Node suites still pass; `web/assets/`
  untouched.

## 2026-10-14.2

- **Planning: new `planning/` directory with the Phase 1 doc (CDN Explorer)** —
  the project is now staged; `planning/README.md` indexes the phases (1 CDN
  Explorer, 2 city renderer, 3 playable core, 4 depth & polish) and
  `planning/phase-1-cdn-explorer.md` is a self-contained, session-ready plan
  for a **CDN Explorer**: an RE workbench page independent of the Asset
  Explorer that indexes every CDN file (510 local `.7z` bundles, the 60
  live fan-CDN files, and the 5,146-entry fan master index) into a SQLite
  database (`cdn/cdn-explorer.db`), served by a stdlib-only local server
  (`tools/cdn_explorer.py`, default port 8123). It covers the full design:
  schema, three-pass resumable indexing, virtual zip/pack browsing with
  hex + preview (reusing `tools/extract_assets.py` decoders), the
  "reverse-engineer one file at a time" findings journal, a format
  registry, gated single-file fan-CDN downloads (etiquette preserved),
  milestones M0–M4, acceptance criteria, and a session-start checklist.
  Plan only — nothing implemented yet.

## 2026-10-14

- **Python (Django) TSTO server runs in a self-contained podman stack**
  (`server-python/docker/`): the new `server-python/` server build (upstream
  al1sant0s/springfield) now runs via `podman compose` with **no host bind
  mounts** — all state lives in named volumes (`sf-data` SQLite, `sf-media`
  towns/avatars, `sf-static`), and the required nginx reverse proxy
  (X-Accel-Redirect town/avatar offload) is a small image with its config
  baked in, sharing the media/static volumes read-only. New files:
  `compose.yaml` (server + nginx; published on `192.168.1.147:8090` plus
  loopback for debugging), `Dockerfile.server` (extends
  `ghcr.io/al1sant0s/springfield:latest` — no local miniforge build),
  `Dockerfile.nginx` + `nginx.conf`, `.env.example` (a real `.env` with a
  generated `SECRET_KEY` lives beside it). One-time setup already done:
  `migrate`, `collectstatic`, `createsuperuser`; the project's own 20-test
  suite passes. Game login codes use the console email backend — they are
  printed to `podman compose logs server` (`SENDER_EMAIL` must be set or
  codes are silently never dispatched). Superuser: `admin@localhost`,
  password in `server-python/docker/.env`.
- **Game-boot smoke test** (`tools/smoke-server.sh`): headless
  curl-driven check of the whole client boot flow through nginx — director
  bootstrap, device registration, anonymous + email auth (code read back
  from the container logs), mayhem id, checkToken → land token →
  userstats, and a town save/load roundtrip that proves the
  X-Accel-Redirect path (nginx streams the saved `.pb` back from the shared
  volume, byte-identical). Re-runnable against any base URL:
  `bash tools/smoke-server.sh [http://host:port]`.
- **Noted: podman-compose does not detect `.env` changes** on `up -d` —
  recreate the containers after editing `server-python/docker/.env`
  (documented in `.env.example`).

## 2026-10-13.6

- **Server API documented** (`notes/04-server-api.md`): full wire-protocol
  reference for the fan TSTO private server in `server/` — every
  game-facing endpoint (bootstrap/director, device registration, the
  EA-Connect-shaped auth flow, town save load/save, donut currency,
  gameplay/client config, lobby time, telemetry, DLC files), the admin
  dashboard endpoints, the single-session + `towns/*.pb` + SQLite
  persistence model, the typical client boot sequence, and known gotchas
  (e.g. `/mh/userstats` always 409 by design, unauthenticated dashboard).
  `notes/README.md` read-order and `notes/00-orientation.md` layout now
  reference it.

## 2026-10-13.5

- **DLC tab grouped by event family** (`web/js/explorer.js`): the flat
  10,219-tile list (9,703 after the dedup below) was ~6.6× the content,
  because every file exists per device tier (`iphone/ipad/ipad3/retina`
  or `25/50/100`) and per CDN revision. The tab is now two levels deep,
  mirroring the Animations tab: the first page lists the 11 event
  families (game, menu, treehouseofhorrorsgame, …) with a representative
  image and asset/pack counts; clicking one shows its distinct files
  (largest family: game, 586 — ~1,540 across all families), each file's
  tiers and duplicate revisions collapsed into one tile (highest-tier,
  unrevised/newest-revision entry is the representative), with a "← all
  families" breadcrumb back. Searching bypasses the grouping and lists the
  matching distinct files flat; switching tabs re-enters at the family
  level. `smoke-explorer-dom.cjs` now exercises the full drill-down
  (family tiles → family page → data-file detail → variant row →
  breadcrumb back). All three smoke suites green.
- **Fixed: the variant switcher listed unrelated files as variants for
  DLC content.** `appendVariants` grouped by `family` alone, but a DLC
  family is an *event* shared by hundreds of different files — clicking
  a menu image rendered up to 3,560 buttons (every other-tier menu
  image). For DLC entries the variant set is now every *other copy of
  that exact file* (same base filename, any tier/revision), and the
  buttons label the revision (`100 · r146180 · 320×480`); APK content
  keeps its family-based semantics. Data files (`xml`/`bsv3`) also gain
  the variant row — they had none at all before.
- **Fixed: 516 duplicate manifest entries** (102 paths, up to 8 copies
  each, byte-identical). EA's CDN zips store some files multiple times
  at the zip root (`abe_menu.rgb` appears 8× in `menu-*-v3_0_30-r2`),
  and the pipeline emitted one manifest entry per zip record.
  `tools/extract_assets.py` now skips repeated names within a pack, and
  the already-generated `web/assets/manifest.{json,js}` were deduped in
  place (14,605 → 14,089 entries; the on-disk assets were already
  single copies). No re-extraction needed.

## 2026-10-13.4

- **Animations tab grouped by character** (`web/js/explorer.js`): the flat
  4,053-tile list was unwieldy, so the tab is now two levels deep. The
  character is taken as the first underscore-separated segment of the frame
  file name (`edna_back_walk_f0.png` → Edna), giving 46 character tiles on
  the first page (a representative thumbnail or first frame plus the
  distinct-animation count). Clicking a character lists its distinct
  animations — each animation's 25/50/100 resolution classes and duplicate
  CDN revisions collapse into one tile (the highest-resolution,
  unrevised/newest-revision entry is the representative) — and a
  "← all characters" breadcrumb bar above the grid goes back. Searching
  while on the tab bypasses the grouping and lists the matching distinct
  animations as a flat list; switching tabs re-enters at the character
  level. New `#browser`/`#crumb` elements in `assets-explorer.html`
  (styled in `css/explorer.css`) hold the breadcrumb; the detail pane,
  player and variant switcher are unchanged. `smoke-explorer-dom.cjs` now
  exercises the full drill-down (46 character tiles → character page →
  anim detail → search mode → back) instead of asserting one flat tile per
  anim entry. All three smoke suites green.

## 2026-10-13.3

- **Complete 3.0.30 core CDN archive + all movie languages decoded into
  the viewer** (everything available locally; no downloads): all 104 packs
  of `cdn/3_0_30.7z` (every family — game, menu, treehouseofhorrorsgame,
  treehouseofhorrorsmenu, backtoschoolgame, backtoschoolmenu, hawhawgame,
  librarygame, seasonpremieregame, roadrivertiles — at every device/
  resolution tier 25/50/100 and iphone/ipad/ipad3/retina, in every CDN
  generation: the 2015 originals, EA's final `r146180` revision, the
  Nov-2024 takedown stubs `r406729` and the fan-era `r157326`/`r272024`
  uploads) plus all 112 movie packs of `cdn/1_1_35.7z` (intro + 3
  cutscenes × 4 device tiers × 7 languages). 214 non-empty packs, 14,605
  manifest entries, ~900 MB in `web/assets`: 8,166 images (buildings,
  ~6,400 menu icons across tiers/revisions, level-select art, road/grass
  tiles), 4,053 character animations covering **46 characters** (the 26
  playable ones plus Treehouse-of-Horror zombies/ghosts and event
  variants), 2,188 data files (building/character XML + bsv3 scenes) and
  112 movies. Three `librarygame-*-r146180` packs are empty inside (EA
  stripped them in the takedown generation) and the four CJK `fontcache`
  packs remain skipped (custom glyph-atlas binary, no known decoder).
  Re-run everything locally with
  `python3 tools/run_dlc_batch.py Springfield-V08.apk <3_0_30 zips>
  <1_1_35 zips> --skip fontcache`.
- **Found and fixed a second `.rgb` 4-bit variant: flag `0x6000` is
  straight (unmultiplied) alpha**. 88 files in the menu packs
  (`levels_level*.rgb`, `unlock_lock.rgb`) carry flag `0x2000 | 0x4000`;
  their channel nibbles exceed the alpha nibble (88/88 files — impossible
  for premultiplied data), which the old premultiplied decoder crashed on.
  The pipeline now decodes flag `0x6000` without un-premultiplying
  (verified visually on the level-select art); flag `0x2000` stays
  premultiplied, flag `0` stays 8-bit straight RGBA. Manifest image
  entries gain a `premul` field and the explorer's Type line now reads
  "RGBA4444 (2 bytes/px), premultiplied" vs "…straight alpha".
- **New `tools/run_dlc_batch.py`**: batch driver that scans directories of
  locally extracted CDN pack zips, derives one `--dlc` spec per zip from
  the CDN file name (`<family>[-<tier>][-<lang>]-v<season>[-r<rev>]`) and
  runs the pipeline exactly once with all of them (the APK side is only
  re-extracted a single time). `--skip`/`--prefix` filter by name,
  `--dry-run` lists the specs. Movie families are per-language
  (`movie-intro-de`, …) with English keeping the plain name, so the
  variant switcher groups the 4 device tiers within one language.
- **Hardened the DLC pipeline for big batches**: each pack file now
  decodes inside a try/except — a corrupt or unrecognized file is stored
  as raw data with a `decode_error` note and a console warning instead of
  aborting the whole multi-pack run (no file in the current archive
  triggers it).
- **Smoke suites scaled to the 14.6k-entry manifest**: the DOM suite now
  clicks a stratified sample (~1,670 tiles: every video/audio/font/
  strings tile, capped image/anim/data samples, one tile per DLC pack)
  instead of every tile; the movie-family integrity check accepts the 7
  language families; origin-namespace checks are scoped to APK entries
  (DLC origins are per-pack file names that legitimately repeat across
  tiers/revisions). All four suites green.

## 2026-10-13.2

- **Original 3.0.30 core game content decoded into the viewer** (`cdn/3_0_30.7z`
  from the archive.org `tsto-cdn-content` set): the `game-100` pack (42 MB
  compressed, 945 files) now lands in `web/assets/dlc/game-100/` — 359
  **character animations** (all 26 playable characters: abe…willie, 3,081
  unique frames as PNGs), 280 **building sprite sheets** (churches, donut
  shops, houses, …), 161 building/character definition `.xml` files and 145
  `.bsv3` animation scenes as data files. `roadrivertiles-100` (4 plain PNG
  ground/road tiles) came along in the same pass. Total viewer size is now
  1,201 assets / ~99 MB. The two source zips are kept in `cdn/3_0_30/`
  (extracted from `cdn/3_0_30.7z`); after a fresh extraction re-add them with
  `--dlc '{"file": "cdn/3_0_30/game-100-v3_0_30.zip", "url":
  "https://archive.org/download/tsto-cdn-content/cdn/3_0_30.7z", "pack":
  "game-100", "family": "game", "tier": "100", "season": "3_0_30"}'` and the
  same for `roadrivertiles-100-v3_0_30.zip` (pack/family
  `roadrivertiles-100`/`roadrivertiles`).
- **Cracked the `.bcell10` character-animation format**: `bcell10` + u16
  record count + u32 (unknown); per record 13 bytes (f32 delay_ms, i16 x/y
  offsets, 5 stream-coordinate bytes, last record flagged 0x20); then one
  pixel block per unique frame — first `[u16 w][u16 h]`, later
  `[u32 0x20000000][u16 w][u16 h]` — each followed by `w*h*2` bytes of
  premultiplied RGBA4444. Parses to exact EOF on all 359 files; records
  beyond the last block hold the final frame (e.g. `abe_feed_pigeons` =
  29 cells / 27 frames). Layout cross-checked against the community
  `tsto2rgb` repo's writers.
- **Fixed the `.rgb` 4-bit decode** (affects every previously extracted
  4-bit image, now re-extracted): the depth-4 layout is **premultiplied
  RGBA4444 with channel order B,A,R,G** (`byte0=(B<<4)|A`,
  `byte1=(R<<4)|G`, high nibble first), as written by `tsto2rgb` — not the
  "gray + alpha" the pipeline assumed (that read was only accidentally
  close on flat-colored art). The decoder now un-premultiplies to straight
  8-bit RGBA, with a fast path for opaque pixels; depth-8 files were always
  correct. Buildings, splash art and menu sprites now render in true color
  with correct alpha.
- **New "Animations" tab in the asset viewer**: each `.bcell` becomes a
  manifest entry of type `anim` (char, animation, per-frame file + delay,
  thumb) with a play/pause player over a checkerboard stage, frame
  counter, loop toggle and per-frame delays from the file. Tiles show the
  first frame with a play badge. The variant switcher now only offers
  *other* resolution classes (previously the 359 same-tier game-100
  animations would have listed each other as "variants"). Explorer image
  metadata now reads "premultiplied RGBA4444" instead of "gray + alpha".
- **Smoke suites extended**: `smoke-explorer.cjs` validates every anim
  entry (cells/frames consistency, frame files on disk, sane delays, not
  embedded in dataText); `smoke-explorer-dom.cjs` exercises the new tab
  end-to-end (11 tabs, tile count, player `<img>` target, pack/season/tier/
  URL tags) and the DLC detail check now looks up the correct pack's tile.
  All four suites green.

## 2026-10-13.1

- **Found the complete original-CDN archive on archive.org**: the item
  `tsto-cdn-content` ("The Simpsons: Tapped Out CDN Content") is a
  pre-shutdown preservation set of **EA's original CDN** — 510 `.7z`
  bundles (38.5 GB) in `cdn/`, one per CDN content-version directory,
  covering the game's whole 13-year life from `1_0_4` (2012 launch)
  through the final `4_69_*`/`5_0` content (2025). That is exactly the
  content the fan CDN never hosted, including the **core game directory**
  `3_0_30.7z` (192 MB — the `game-v3_0_30` base packs the v4.69 index
  lists but the fan CDN doesn't serve), every event, patch, takedown,
  tie-in, promo, language pack, and video. The item's top level also
  carries the original 4.69.5 iOS `.ipa` + Android NA/ROW `.apk` (our fan
  APK is a re-pointed build of that same binary), the final splash
  screen, and a torrent. No files were downloaded beyond the two bundles
  already on hand (`cdn/1_0_4.7z`, `cdn/1_1_35.7z`).
- **Game movies added to the asset viewer (new "Movies" tab)**: from
  `1_1_35.7z` (content version 1.1.35, 2013) the 16 **English** movie
  packs — `movie-intro` + `movie-cutscene01/02/03`, each in all four
  device tiers (ipad / ipad3 / iphone / retina) — were decoded into
  `web/assets/dlc/<pack>/videos/` (~59 MB of H.264 MP4 + AAC). Each gets
  a JPEG poster tile (ffmpeg frame grab, 320 px) with a play badge, an
  in-browser `<video>` player in the detail pane, pure-stdlib metadata
  (resolution, duration, codecs), and the device tiers share the movie's
  `family`, so the existing variant switcher flips between resolutions.
  The other six languages (de/es/fr/it/ko/zh) are still inside the 7z —
  adding them is one more `--dlc` pass per language.
- **`1_0_4.7z` inspected, nothing displayable added**: the launch
  version's CDN dir contained only 12 CJK **fontcache** packs (Korean +
  Chinese pre-rasterized glyph atlases, `fontcache_0/1` binary blobs).
  They are not image/font/video formats the viewer can render, so they
  were deliberately left out (they remain in the local 7z).
- **Pipeline: video support in `--dlc`**: `.mp4`/`.m4v`/`.mov` files in a
  pack now pass through to `dlc/<pack>/videos/` as manifest type
  `video` with box-walk metadata (`w`, `h`, `duration_s`, `vcodec`,
  `acodec` — pure stdlib, no ffmpeg required); when ffmpeg is installed a
  poster frame is written to `dlc/<pack>/thumbs/` (graceful fallback to a
  ▶ glyph tile otherwise). Two new `--dlc` spec overrides, `"pack"` and
  `"family"`, let a pack that comes out of a `.7z` bundle (whose URL
  names the bundle, not the pack) keep its true CDN package name.
- **Explorer: Movies tab + media fixes**: the explorer now has 10 tabs
  (Movies sits after Audio); video entries route there regardless of
  their `dlc/` path, the header count line shows the movie count, and
  any playing video pauses when the selection or tab changes. The
  manifest/test suites grew: 10-tab layout, Movies end-to-end (tiles,
  `<video>` src, pack/season/tier/URL in the detail), video metadata
  integrity, 7z-bundle source-URL allowance, and same-family origin
  duplicates for device variants. Web output is now 252 files / 74.7 MB.

## 2026-10-12.6

- **CDN file-URL index**: `cdn/file-urls.txt` — all 60 files currently on
  the fan CDN as bare absolute URLs, one per line, sorted (24 in
  `4_11_THOH2014_D4IR9TM9OCKH/`, 13 `HalloweenWater/`, 7 `SeasonFall/`,
  4 `splash_THOH2014/`, 3 `HalloweenNight/`, 3 `Main/`, 3 `dlc/` indexes,
  2 `outputs/` ledgers, plus the unreferenced root `tho2104.7z`).
  Generated locally from `cdn/catalog.json` (today's crawl) — **zero
  requests to the CDN** and nothing was downloaded.

## 2026-10-12.5

- **Core-game question answered via the live v4.69 index**: fetched the
  versioned master index
  `static/dlc/DLCIndex-v4_69_UNTROUBLEDVASES_PATCH2-r1791773848-LYOXW1QI.zip`
  (401 KB, the single "next" file a live v4.69 client downloads after the
  base index) and parsed all **5,146 `<Package>` entries** (1,212 unique
  content names) into `cdn/v469-packages.json` — the game's full content
  catalog from `4_0_0r1_Christmas` (2013) through `4_70_NewHorizons` (2025):
  event game packs, per-event menus, 58 movie packages, audio, textpools in
  all 16 languages, font cache, tutorials, promos. Each entry records its
  CDN dir, filename (with revision), tier, language, and size. Key finding
  on "where is the base city?": the index lists core-game packs
  `3_0_30:game-{25,50,100}-v3_0_30-r157326-B8353263.zip` (0.6/1.8/4.8 MB —
  the base game's core content, core version "3.0.30") and nothing else
  resembling base-Springfield art; no `Springfield-<tier>`, no `game-*`
  city pack, and the largest indexed files are all *event* content
  (Xmas2014/2016 takedown buildings & characters, ~50 MB each) or intro
  movies. So the base-city art is not delivered as indexed DLC at all, and
  the core `game-v3_0_30` pack is **listed but not hosted** on the fan CDN
  (no `3_0_30/` dir there). The index also reveals the fan project **stripped
  signature verification**: the main package list carries the placeholder
  `IndexFileSig` "You should patch the APK/IPA to bypass this!" instead of
  real RSA hashes (the `TutorialPackages` section still has real
  96-hex-char signatures).
- **Index vs. CDN cross-reference**: of the 5,146 indexed files only **75**
  are actually hosted on the fan CDN (all of them the THOH2014 event, its
  three seasons, `Main/` gamescripts+textpools-en, and the
  `splash_THOH2014` set). The index references **320 distinct CDN dirs**;
  only 6 of the CDN's 8 dirs are index-referenced (`dlc/` and `outputs/`
  are the fan's own admin dirs, not index content). Consequence: a v4.69
  client booting against this CDN 404s on essentially everything except the
  THOH2014 world — i.e. the fan server runs a **single-event game** (the
  THOH2014/SeasonFall/HalloweenWater/HalloweenNight world, whose 42 MB
  `THOH2014Game-100` pack is the only real "in-game" art available). The
  one unexplained artifact is the 120 MB `tho2104.7z` at the CDN root —
  referenced by no index or ledger; `7z`/`7za`/`7zr` are available on this
  machine should it ever be worth pulling down.

## 2026-10-12.4

- **Fan-CDN catalog**: new `tools/crawl_cdn.py` crawls the live fan CDN
  (`https://cdn.projectspringfield.com/static/`, nginx autoindex) into
  `cdn/catalog.json` — 9 directories, 60 files, 278.6 MB, metadata only
  (never downloads pack bytes). Politeness rules baked in per the project's
  wishes: at most one concurrent connection, ≥10 s between requests, and a
  **blank User-Agent** (verified by binary analysis that the APK contains
  no literal UA *value* — the engine sends `User-Agent: %s\r\n` built from
  a runtime value, so there is no "suitable" client UA to copy). The
  catalog confirms the full content layout: season dirs (`SeasonFall`,
  `HalloweenWater`, `HalloweenNight`, `4_11_THOH2014_D4IR9TM9OCKH`,
  `splash_THOH2014`), `Main/` (gamescripts + textpools), `dlc/` (the master
  `DLCIndex.zip` plus two versioned indexes), and the fan project's own
  build ledger in `outputs/` (`seasons.json`, `dlc_ledger.json`).
- **DLC packs in the asset explorer**: `tools/extract_assets.py` gains a
  repeatable `--dlc` flag (`--dlc '{"file": "pack.zip", "url":
  "https://cdn.../pack.zip"}'`) that decodes CDN packs — the exact same
  `0` (BGrm index) + `1` (ZIP) container as the APK packs, verified
  byte-for-byte on a live pack — into `web/assets/dlc/<pack>/`. Every
  manifest entry is tagged with the pack metadata (pack filename, season,
  tier, revision, CDN source URL, BGrm index version). DLC content is
  additive: plain re-runs leave `dlc/` untouched and re-merge its manifest
  entries; passing `--dlc` again for a pack replaces just that pack.
  Pilot pack: `SeasonFall/THOHXXXIVBuildDecoMenuFall-iphone-r2711434814.zip`
  (15 Treehouse-of-Horror menu tree images, 2 bpp gray+alpha `.rgb`,
  ~44–46×60 px). The explorer gets a new **DLC** tab (count badge, green
  "DLC pack" badge on tiles, meta table with the pack filename,
  season/tier/revision and the source URL); the header counts line shows
  the DLC total. Output is now 236 files / 16.06 MB.
- **WAV codec flagging (prep for the pending audio fix)**: `wav_info()`
  now reads the RIFF fmt tag, and every audio manifest entry carries
  `audio_format` + `codec` (all 62 APK WAVs are `ima-adpcm` — browsers
  only decode PCM/IEEE WAV, which is why audio currently doesn't play).
  The explorer's audio detail pane shows the codec. No decoding change —
  the IMA ADPCM → PCM16 fix is still deferred.
- **Tests**: `tools/smoke-explorer.cjs` gains DLC-integrity checks
  (manifest `dlc` list matches entries, every entry tagged with pack
  metadata + source URL, thumbs exist) and now scopes its audio counts to
  APK audio; `tools/smoke-explorer-dom.cjs` expects the 9th tab and
  exercises the DLC tab end-to-end (15 tiles, detail pane shows pack
  filename, season, tier, revision and CDN URL). All four headless suites
  pass.

## 2026-10-12.3

- **Asset explorer**: new page `web/assets-explorer.html` (reached via the
  "Asset explorer" button in the city screen's top bar, which opens in a
  new tab through an anchor click so it also works from `file://`) browses
  every asset extracted from the APK:
  - images: thumbnail grid, fit / 100% zoom preview on a checkerboard,
    provenance (source pack, original file, anchor point, color mode), and
    one-click switching between the resolution classes the APK ships
    (e.g. the splash background at 2048×1024 / 4096×1024 / 4096×2048);
  - audio: all 62 WAVs (music, UI SFX, Homer lines) with a seek/volume/loop
    player;
  - fonts: glyph samples rendered in the game's own faces;
  - strings: the 16 decoded `.btp` tables (90 keys each), searchable;
  - data: raw text of `splashscreen.xml`, device-scale XML, name lists, the
    engine's GLSL shaders and the support fallback page;
  - Android shell: launcher icons in all 5 densities, the pre-engine
    default splash, push icon;
  - Motion: live previews of the motion the APK's data describes — the
    splash screen composed every frame from `splashscreen.xml` (with
    aspect-ratio and language selectors), the loading-donut spin, and the
    tap-finger bob. (The APK contains no frame-based sprite animations;
    those live in `libscorpio.so` and the runtime DLC.)
  No `fetch()` anywhere — the page reads `manifest.js`/`webdata.js` like
  the game does.
- **Pipeline: full-APK asset coverage**: `tools/extract_assets.py` now
  extracts *all* resolution classes (splash small/medium/large; core UI
  small/medium-small/medium/large), the loose GLSL shader files that sit
  next to the pack `0`/`1` entries, the `support` fallback page, and the
  game-branded Android shell icons from `res/` (third-party SDK drawables
  are deliberately skipped). Image manifest entries gain `family`/
  `resClass` variant grouping, `anchor` (decoded from the packs'
  `.txt`/`.rgb.txt` sidecars) and `thumb` (~192 px box-downsampled grid
  thumbnails in `assets/thumbs/` for images over 256 px). `webdata.js`
  gains `dataText`, embedding the raw text of every data file so the
  explorer needs no `fetch()`. Output grows from 119 files / 6 MB to 221
  files / 16 MB; re-runs now wipe each output subdirectory first, so
  removed variants never go stale. The game's own composition is
  untouched: only the "game class" entries (medium splash, large UI) keep
  a pack `origin`, so `splashscreen.xml` lookups resolve exactly as before.
- **Tests**: two new headless suites — `tools/smoke-explorer.cjs`
  (inventory integrity: every manifest path on disk, thumbnails present,
  the origin index still resolves to the game's resolution class, variant
  families complete, `dataText` coverage) and
  `tools/smoke-explorer-dom.cjs` (drives the real `explorer.js` with a
  minimal DOM: renders every tab, clicks through all 221 asset tiles,
  exercises the variant switcher, motion canvases and search).

## 2026-10-12.2

### Fixed

- **Infinite loading loop (stuck donut + repeated `10_next_segment.wav`
  requests)**: while the 0.45 s scene fade was running, `G.scene` still
  pointed at the outgoing scene, so the loading scene's `update()` kept
  firing its "all done" branch **every frame** — re-creating the
  `10_next_segment.wav` `Audio` element (a fresh network request, ~60×/sec)
  and re-calling `setScene('city')`, which reset the fade's progress to 0
  each frame so it could never complete. Two fixes: `G.setScene()`
  (`web/js/boot.js`) now treats the *fade target* as the current scene and
  ignores redundant switches, and the loading scene (`web/js/scenes.js`)
  sets a `transitioned` flag so the SFX/music/transition fires exactly
  once.
- **Regression test**: `tools/smoke-scene.cjs` (Node, no browser needed)
  drives the real boot → splash → loading → city flow at simulated 60 fps
  with stubbed DOM/Image/Audio and asserts the transition finishes in
  finite frames and every audio file is requested exactly once
  (`node tools/smoke-scene.cjs`). Verified it fails with 718 duplicate
  `10_next_segment.wav` requests on the pre-fix code and passes on the fix.

## 2026-10-12

- **Web front-end port (Phase 1 + 2)**: `web/` now contains a playable web
  build of the game's front-end: splash screen (real cityscape, Homer,
  tap-finger, signature and localized logo, composed at runtime from the
  game's `splashscreen.xml` — 11 aspect rulesets, background crop windows,
  placement offsets), donut loading screen with real asset-load progress,
  a city placeholder hub, and the real "technical difficulties" error
  screen. Vanilla JS + Canvas 2D, no dependencies or build step; serves
  from any static host or `file://`.
- **Asset extraction pipeline**: `tools/extract_assets.py` (pure stdlib
  Python) unpacks the APK's proprietary `assets/<group>/<name>/1` ZIP packs
  straight from the APK and converts them to web formats — `.rgb` → PNG
  (4-byte RGBA, or gray+alpha when `flags & 0x20000000`), `.btp` → JSON
  (big-endian length fields, 90 strings × 16 languages) — and emits
  `web/assets/` (119 files, ~6 MB) with `manifest.json`/`manifest.js`
  provenance inventory and `data/webdata.js` (embedded i18n + splash XML so
  the app needs no `fetch()`).
- **Audio & i18n**: all 62 WAVs from the APK are wired in (button blips,
  dialog open/close, theme on tap-to-start, looping background music); the
  city screen can cycle all 16 decoded string tables live, and the splash
  logo swaps to the localized artwork.
- **Docs**: `README.md` with run instructions, project layout, the decoded
  `.rgb`/`.btp`/`BGrm` format notes, and scope/limitation notes (city
  content is runtime DLC, not in the APK).
