# Phase 2 — City renderer: the camera-view basis

Status: **planned** (doc written 2026-10-16, to be started in a new session).
Predecessor: Phase 1 (CDN Explorer) ✅. Feeds Phase 3 (playable core).

## Goal

Replace the placeholder city screen with **the actual camera view of the
base game**: the decoded town *trawg* rendered the way Tapped Out renders
it — an oblique "2.5D" camera over a textured ground plane, with buildings
as real billboard sprites standing on their verified footprints, characters
as animated sprites, and game-like pan/zoom.

This phase is the **basis** of that: the camera model (projection, pan,
zoom), the sprite pipeline (sheets → ready-to-draw images with correct
anchors), and a renderer that composes them. The end state is a *static*
city you can fly around — no gameplay interaction yet (jobs, construction,
quests are Phase 3).

**"Like the base game" means:** ground = tiled texture, not flat colours;
buildings = the game's own 2D art, un-sheared billboards anchored to their
tile positions, drawn back-to-front (painter's algorithm); characters =
`.bcell` frame animation; camera pans in screen space and zooms with the
game's feel. The same town exists on the fan server, so the user's original
Android client is a direct A/B reference for any region/zoom.

## What already exists (the verified basis — build on this, don't re-derive)

### City save — fully decoded

- `mapdump/*.pb` is a plain `Data.LandMessage` protobuf (53 fields;
  `server-python/protofiles/LandData_pb2.py` + the `runtime_version` shim
  — the shim pattern is in `tools/gen_map_explorer.py`). Town *trawg*,
  level 939: **5,261 buildings (2,299 distinct ids), 871 characters
  (854 distinct ids)**. Dumps: `tools/decode_land.py`,
  `tools/terrain_dump.py`.
- **Terrain grids verified byte-exact** (`notes/01`, "Terrain &
  roadmaps"): 7 layers (`roadsData`, `riversData`, `oceanData`,
  `roadMapList[0..6]`), 1 char = 16 tiles, codebook `a..p → 1<<(c-'a')`,
  `G → 0`, `P → 0xFFFF` — proven from the `libscorpio.so` decoder at
  `0x11a6288`, not hypothesised. Grid 512×1087, row-major 16-wide records;
  overlay offset `town = grid − (12,136)` (best-fit, sharp in Y — exact
  origin still an open item). Layer draw order established: ocean → sand
  → dirt → river → road → dirtroad → klsroad over grass.

### Building & character catalogs — 100% resolved, saved in `data/`

- `building_ids.json` (3,440 ids → name/asset/slug),
  `building_footprints.json` (5,446 slugs → x/z/locX/locY/height),
  `save_buildings.json` (this save's 2,299 ids + resolution path),
  `flip_assets.json` (fence `nameFlip{SE,SW,NE,NW}` variants),
  `character_ids.json` (1,023 character ids → name; all 854 in the save
  resolve).
- **Footprint rect + flipState semantics verified**: a building at
  `(posX,posY)` covers `X:[posX−locX+1, posX−locX+x]`,
  `Y:[posY−locY+1, posY−locY+z]`; fence direction by flipState 0..3;
  monorail `StraightTrack` 4×2/2×4 flip. Cross-checked against the road
  grid (SimpsonHome/FlandersHome fronting the Y=29–30 road, Kwik-E-Mart
  fronting Y=39, flipped church — no overlaps).

### Interactive schematic map (this session's delivery)

- `web/map-explorer.html` (+ `css/`, `js/map-explorer.js`, generated
  `js/map-explorer-data.js` via `tools/gen_map_explorer.py`): canvas
  terrain + 5,261 hoverable building blocks at their true per-instance
  rects + 871 named character dots, pan/zoom, search, details pane.
  Headless-tested (`tools/smoke-map-explorer-dom.cjs`, 33 checks). This is
  the proven interactive scaffold and the **placement ground truth** the
  camera view must reproduce.

### Asset formats — fully documented (`notes/01`), decoders in-tree

- `.rgb` (3 flag variants incl. premultiplied RGBA4444 B,A,R,G layout),
  `.bcell10` character animations (parse-verified on all 4,053 files),
  `.bsv3` building animation scenes (fully documented — **not yet
  rendered**, the deferred item in `notes/03` §2), building-def XML
  (`x z height locX locY transImageX transImageY`). Pure-stdlib decoders +
  PNG writer live in `tools/extract_assets.py` — import, don't rewrite.

### Core pack asset layout (found 2026-10-16, `3_0_30/game-100`)

The nested `1` payload of a `*Game-100*` zip holds, **per building slug**:

```
slug.rgb                  sprite sheet (all anim cells; e.g. church 1148×840)
slug_transimage.rgb       second sheet (semantics open — overlay/shadow?)
slug.bsv3                 cells (crops of the sheet) + frames + named anim states
slug.xml                  footprint (+ transImageX/Y)
slugflipped.*             same set for the mirrored asset
```

plus **`roadtilesheet.rgb` — a 1024×1024 RGBA4444 terrain/road texture
sheet** in the same pack (and in event packs: `GreenRiversGame-100`
shipped one too). The same 611 family zips used for the footprint pool
(`g100_cands{,2,3}.tsv` pipeline pattern) therefore contain **everything**
needed to render the city: sheets, scenes, footprints, terrain texture.
All local; no network.

### Camera RE state (`notes/06` — read this first)

- The engine is GLES2 with **all camera math CPU-side**: the bundled
  shaders are `position * matWorldViewProj`; uniforms
  `matWorld/matView/matWorldViewProj/...` are uploaded through a cached
  state-wrapper layer (values matter, not call counts).
- Camera classes exist in the engine's descriptor registry:
  `BGSceneCamera`, `CameraManager`, `ShakeCameraAction`; script-visible
  knobs: `cameraZoomLevel`, `cameraMaxPanSpeed`, `cameraMinPanSpeed`,
  `cameraPanTime`, `cameraYOffset`, `allowCameraMovement`, `Pitch`, …
- **Camera values are NOT server-driven** (verified against the prod
  HAR: zero camera keys in either config response) → there is **one
  canonical camera behaviour**, and its numbers come out of the binary or
  are matched empirically against the original client's feel (the note
  sanctions both routes).
- Open RE item: the per-frame camera matrix build (render dispatcher
  `0x145f0d4`, vtable slot `0x538`/`0xf8`).
- rizin 0.8.2 is at `/tmp/opencode/r2x` (`LD_LIBRARY_PATH=
  /tmp/opencode/r2x/usr/lib`, `-e bin.relocs.apply=true`); AArch64
  decode cheats are recorded in `notes/06` §7 — don't re-learn them.

## Scope

**In:**

- Camera model for the web port: world(tile) ↔ screen transform
  (projection type + pitch + zoom scale), pan/zoom interaction with
  game-like velocity/clamping. RE-first, empirical fallback (see below).
- Sprite pipeline (local-only): extract `*.rgb`/`*.bsv3`/`*_transimage.rgb`
  from the 611 family zips into a disposable pool; a bsv3 parser verified
  against the tsto2rgb `bsv.py` reference; **static-frame PNGs** per asset
  (crop the default state's frame 0 out of the sheet) with anchor
  metadata, emitted into `web/assets/city/` + a manifest; character
  `.bcell` → frame PNGs (idle first, walk if cheap). Coverage report vs.
  the save.
- Textured terrain: `roadtilesheet.rgb` decoded, tile→UV mapping pinned,
  ground rendered as textured tiles with the 7 save-grid overlays
  (replacing the Map Explorer's flat colours).
- The camera-view page: standalone `web/city-view.html` first (sibling of
  the Map Explorer — it can iterate without touching the game shell),
  canvas renderer: terrain → depth-sorted sprites (buildings + characters)
  with viewport culling + lazy sprite loading, flipState mirroring,
  click-to-select with the details pane (reuse the Map Explorer's
  conventions: shared `[data-tip]` rule, no `title`, escaped text).
- Headless smoke suite (project standard), notes + CHANGELOG updates.

**Deferred (out of this phase):**

- Any gameplay: jobs/quests/construction/storage bundles/minigames,
  character movement & pathfinding (Phase 3; RE leads in `notes/06` §6).
- Building **animation playback** (bsv3 anim states) — static frames only;
  a couple of landmark animations are a stretch.
- Subland / storage-bundle terrain, `boardwalkTiles`, `landBlocks`
  rendering (`notes/01` open items 3–4).
- The IMA-ADPCM audio fix and everything else parked in `notes/03`.

## Key unknowns (RE targets, in attack order)

1. **The camera matrix build** (`notes/06` open item 1). Static route:
   render dispatcher `0x145f0d4` → vtable slot `0x538` of the engine-core
   singleton (`0x1b00d80`); identify the concrete class via the
   descriptor registry, reconstruct its vtable, find the 4×4 build →
   projection (is it pure oblique with uniform scale, or perspective-ish
   depth scaling?), zoom curve, pan velocity model (the `camera*` knobs
   sit near the math). **Fallback (sanctioned by `notes/06` §5b):** match
   empirically against the original client's feel — the user A/Bs
   screenshots of the same town/region/zoom from the Android client.
   Deliverable either way: the transform written into `notes/06` (new
   section) with the derivation, and a pure function in
   `web/js/camera.js` unit-testable headless.
2. **Sprite anchor semantics** — `transImageX/Y` in the footprint XML
   (e.g. manhole: −42.949 / 7.999; church: see `church.xml`). Hypothesis
   to test: 1/100-tile units (the bsv3 block positions are ×100 fixed
   point), offset of the sheet art from the position point. Verify
   empirically first (the art's base must land on the footprint for the
   known-correct placements — SimpsonHome et al.), RE the draw setup if
   ambiguous.
3. **bsv3 static-frame selection** — which named anim state is the
   building's "resting" display (probably the first state; confirm against
   tsto2rgb `bsv.py` and one A/B screenshot). Cells are crops of the
   sheet at ×100 fixed-point frame positions; "other-atlas" frames
   (u32 ≠ 0) need the second atlas — check whether the 611-pool slugs
   actually use them before implementing.
4. **`roadtilesheet.rgb` tile→UV mapping** (1024×1024 = 8,192 cells at
   128px, or 4,096 at 256px, …). RE target: `RoadMapDrawer`
   (`notes/01` "C++ side"). Empirical: the sheet must contain a
   recognisable manhole/road texture that lines up with the save's road
   grid when the mapping is right.
5. **`_transimage.rgb` semantics** — second sheet per building; probably
   an overlay layer (translucent parts drawn separately) or shadow.
   Verify visually once the main sheet renders; may be skippable for the
   basis.
6. **Character bcell coverage** — join the save's 854 character ids to
   bcell files across the CDN packs (id → name via `character_ids.json`;
   bcell packs are per-character/per-event). Report coverage; fallback =
   the Map Explorer's coloured dot with the name (never a blank).
7. **Exact grid origin** (`notes/01` open item 3) — with real art, a
   1-tile offset is visible. The best-fit `(12,136)` is the starting
   point; confirm via the A/B loop or the roadmap ctor.

## Architecture

New files only; reuse, don't fork, the existing pieces.

```
tools/gen_city_sprites.py    CDN pool → static sprite PNGs + anchor manifest
                             (reads cdn/ + data/ catalogs; imports the
                             .rgb/.bcell/PNG-writer from extract_assets.py;
                             7z+unzip in the g100 pipeline pattern;
                             pool in /tmp/opencode/, output in
                             web/assets/city/ + city-sprites.json)
web/city-view.html           the page (sibling of map-explorer.html)
web/css/city-view.css        layout + @font-face + shared [data-tip] block
web/js/camera.js             pure camera math + pan/zoom state (unit-testable)
web/js/city-view.js          scene: terrain, sprite loading/culling/sorting,
                             selection, details pane
web/js/city-view-data.js     GENERATED: save-derived placement data (same
                             shape as map-explorer-data.js — same generator
                             pattern, extended with sprite keys + anchors)
data/                        unchanged (canonical catalogs)
```

- **Renderer**: single canvas. Per frame: clear → textured terrain (only
  visible tiles) → visible objects sorted by ground depth
  (anchor `y` + footprint extent, ties by `x`) → draw sprites. Viewport
  culling from the camera rect; sprites lazy-loaded (`Image`, the game
  app's convention) with an LRU; per-zoom-level sprite cache since
  scaling a 1000px sheet every frame is the main perf risk. 5,261
  objects is fine once culled (a downtown viewport holds a few hundred).
- **Camera state**: `{x, y (world point under screen centre), zoom}` +
  velocity/inertia per the RE'd model (or tuned fallback); wheel = zoom
  at cursor, drag = pan, double-click = zoom in, presets = the Map
  Explorer's Full town / Downtown views (same town-rect crops, so results
  are comparable across the two pages).
- **Selection**: click → details pane with the full catalog record (the
  Map Explorer's pane logic is the template); hover = `data-tip`
  convention; the page must stay openable from `file://` where possible,
  otherwise a static-server note like the CDN Explorer's.

## Milestones

- **M0 — camera model** — RE attempt on the matrix build (or the
  empirical route, decided after the first disassembly hour); transform +
  interaction model documented in `notes/06`; `web/js/camera.js` with
  headless transform tests (pan invariance, zoom-at-point stability,
  clamps).
- **M1 — sprite pool & static sprites** — 611-family extraction of
  rgb/bsv3/transimage (reuse `g100_cands{,2,3}.tsv`); bsv3 parser
  round-tripped on the core pack (tsto2rgb `bsv.py` as reference if
  present in `/tmp/opencode/`, else the `notes/01` spec); static-frame
  PNGs + anchors for every save-referenced slug (incl. `flipped` and fence
  direction variants); character idle-frame PNGs; **coverage report**
  (target: 100% of the 2,299 ids have *something* to draw — sprite or
  labelled fallback block; ≥95% of instances as real sprites).
- **M2 — textured terrain** — `roadtilesheet` mapping pinned (RE or
  empirical), ground renderer with the 7 save overlays; sanity: the flat
  Map Explorer colours must sit inside the textured result (same tiles).
  *Status 2026-10-27: road and river cells use the RE'd UV tables on the
  1024² `roadrivertiles-100` sheet as UV meshes, and road × river bridges
  follow the game-verified per-cell rule (notes/09 §6, §10); other terrain
  types are still flat fills.*
- **M3 — city view page** — camera + terrain + building sprites with
  correct placement (SimpsonHome/FlandersHome/Kwik-E-Mart visually match
  the verified footprints against the Map Explorer), mirroring, fences &
  track pieces per-instance, selection + details, Full/Downtown presets.
  First user A/B screenshots against the original client.
- **M4 — characters + feel + hardening** — animated character sprites
  (idle loop), camera feel tuned against the A/B (pan speed, zoom clamp,
  inertia), perf pass (culling/cache measured in the smoke stub),
  `tools/smoke-city-view.cjs` (canvas-stub boot, N frames, draw counts,
  camera ops, sprite manifest integrity), notes/01+06 updates,
  CHANGELOG entries.
- **M4 TODO (as of 2026-10-17 — carry-forward list):**
  1. **Road sheet art fit (HIGH — RE fix landed 2026-10-17; user eye test
     done out of band 2026-10-29 — CLOSED; ships OFF by user decision).**
     Diagnosis: the original cell `(-1,4)`
     is the engine's COMPOSITE state 4 (half lavender paving-grid), not
     "plain asphalt" (the contact-sheet alpha catalogue was bogus — the
     sheet has no transparency), and the full-135×74 sampling box bled
     neighbouring cells into the diamond corners. RE'd the 11
     RoadDrawer UV quads (`.rodata 0x400520`, 11×8 floats,
     top/right/left/bottom UV corners ×512 = sheet px): state 0 =
     cell `(-1,7)` = full asphalt, and every quad samples the cell
     diamond INSET to 127×66. `terrain.js` default slot is now
     `(-1,7)` + the 127×66 inset box; PIL composites vs the export
     (`/tmp/opencode/m4-road-ab-stack.png`) match the control. A City
     View **Road art** toolbar button toggles `Terrain#useSheetArt`
     live (persisted, `mrsnrub.cityview.sheetart`). REMAINING: user
     eye test → flip the default ON — **CLOSED 2026-10-29:** the user
     ran the eye test out of band (with Claude); the default is
     deliberately left OFF (the Road art button stays opt-in). **Selection model landed
     2026-10-17 (.19):** the RoadDrawer base-tile selector
     (`0x1208058`) branches on a per-cell 4-bit neighbour-connectivity
     nibble (record byte 4 & 0xf via helper `0x1134fa8`) with ±1-cell
     neighbour queries and parity-mirrored variants (csel/tst `w21,1`
     at `0x1208234`/`0x12084d4`); quadrant-material classification of
     the 11 state cells gives `Terrain.SHEET_TABLE` (mask→state,
     bits 1=+x/2=−x/4=+y/8=−y): 2-wide band-edge rows (3-of-4 masks)
     pick states 3/4 (asphalt + paving/kerb strip on the grass side,
     flips for the mirrored edge), corner bends pick half-split 1/5/8,
     interior 0, dead-ends fall back to 0. Behind
     `Terrain#sheetSelect='neighbor'` (default `'uniform'`); the Road
     art button now cycles OFF→uniform→edges. Engine parity-variant
     alternation (e.g. state 3 vs 10) not modelled yet. Eye-test fix
     2026-10-17 (.20): the sheet cell box was painted with its axes
     swapped (`quad()` corners are [L,T,R,B], so image cols must follow
     q2−q0 and rows q3−q1) — every composite rendered 90° rotated,
     kerbs across the band; `smoke-camera` now pins the axes.
     `dirtroad`/`klsroad` still flat (no sheet variants exist).
   1b. **N–S avenues (experimental knob, corrected 2026-10-17 .22 after
      user eye test).** The game's continuous N–S streets are NOT in
      the save road layer (procedural — "road-construction code",
      notes/01 + notes/06 §10). Initial pitch-24 grid hypothesis was
      wrong (user: roads "not in the right spot"): per-row export
      walks show the streets are per-block — verified pair
      grid x 66–67 and 90–91 spanning y 221–258 only (between an
      UNSAVED E–W road at 223–225 and the saved 261–263 band);
      column 114/115 has a different phase (y 263–272). Knob is now
      `Terrain.AVENUE.streets = [[66,67,221,258],[90,91,221,258],
      [114,115,263,272]]` (per-street [x0,x1,yLo,yHi], verified only); flanks get kerb states
      4 / 3+flip via masks 13/14, crossings interior 0. Road art
      button cycles OFF→uniform→edges→edges+avenues (persisted 0..3).
      REMAINING: generator RE for the per-band column inventory + the
      unsaved 223–225 E–W road (east-side verification blocked on item 3
      registration); per-edge kerb overlay pass for 1-wide straights
      (masks 3/12 — band art itself landed 2026-10-25.4).
      *Eye tests CLOSED 2026-10-29: the user ran the mode-3 vs ghost-
      overlay eye test and the road-candidate review board
      (`tasks/m4-road-review/`, M4 TODO 7/8) out of band (with Claude);
      verdicts fully promoted into `Terrain.AVENUE.streets` — five
      verified 4-col bands (65–68, 89–92, 113–116, 29–32, 125–128,
      per `terrain.js`). Default left OFF by user decision.*
      RE status 2026-10-17 (notes/06 §10): original-server starter land
      captured from server/payloads/*.har `protoland/` responses —
      fresh-town roadsData = ONE 'P' E–W run + 7 frags, NO N–S chains
      (server never stores streets). Client record creators: string
      decoder, XML tile parser (0x10b2dd4, `tile x y road pavement
      building leaving`), builder-placement (0x118e420); bits 6..10 =
      adjacency updater 0x11a3bc8/0x11a4734. Streets = client-side
      (local land XML seeded by `StartingLand.xml`, loader 0x10b4784).
      Remaining RE: which of the three creators actually lays the
      street columns at town creation (XML parser vs placement pass) —
      pins the exact generator rule for the column inventory.
  2. **Camera perspective + constants via dynamic capture** — hook the
     `glUniformMatrix4fv` wrapper `0x1454404` and record the 16 floats
     per camera state (notes/06 §8); landmark calibration left 60–80 px
     east-side residuals = the game's mild perspective (notes/06 §9,
     `mapdump/registration/calib-pairs.txt`).
  3. **`PX_PER_UNIT` / `ZOOM` ladder / resting zoom / pan feel** —
     export screenshot implied ~9.4 px/world-unit (zoom ≈ 0.147 of the
     guessed `PX_PER_UNIT 64`); pin via (2) or the screenshot backlog.
     *Registration half done 2026-10-17.25:* `tools/calib-solve.py` +
     `g2e-homog.json` (robust ground-plane homography, kept-RMS 16 px,
     pinned by smoke-calib) replace the ad-hoc affine for export work;
     the px-per-unit ladder itself still waits on (2) or ~6 more
     east-of-x200 calib clicks (notes/06 §10).
  4. **M1 building sprites in the world view** — replace footprint
     blocks with `web/assets/city` billboards; needs
     px-per-world-unit-at-extraction (`*(0x1abc0ac8)`) + anchor mapping
     verified via PIL (notes/06 §10, `city-sprites.json` `anchor`).
     *Done 2026-10-25 (CHANGELOG 2026-10-25):* billboards shipped behind
     the Art button, whose default is now **ON** (localStorage still
     overrides). Anchor mapping RE-verified (pin = `tileToWorld(px,py)`,
     ax=ay=0, ref='anchor'); `ART.S` pinned empirically to **64** by
     `tools/fit-sprite-scale.py` (blurred edge-NCC of the two calib-
     verified landmarks against the full-res export; both peak at
     S 63–64 — notes/06 "Sprite scale S pinned"). The engine float
     itself stays unreachable (config-loaded, CDN-only).
  5. **Character sprites** — replace the char-coloured people dots
     (`CityObjects.drawPeople`) with idle-loop sprites (original M4 scope).
     *Done 2026-10-23 (CHANGELOG 2026-10-23, 2026-10-23.2):* dots replaced by
     `characters.json` v3 sprites, animated idle loops on both render
     paths. The 4.x event-pack `bcell13` decoder (board task 19) landed
     the same day: 809/1023 save characters mapped (was 119), 757
     assets of which 749 genuinely animate (distinct frame sources),
     companions harvested on demand per family pack. REMAINING: the 214
     unmatched names have no art in any pack (NPCs/undecoded `bcell11`
     variants), and the ~8 chars stuck on scene/prop art have no
     dedicated idle cell.
- **M5 — integration & game UI (REWRITTEN 2026-10-29, user sign-off)** —
  the original framing of this milestone (promote the page into the Canvas
  shell, or link both) is **superseded**: the Pixi viewer (`web/viewer/index.html`) *is* the
  base game and the entry point; the Canvas shell (`web/original.html` +
  `js/boot.js`/`scenes.js`/`ui.js`/`splashlayout.js`) is abandoned as a
  front-end and kept only as the porting reference for the splash/donut
  loader, audio mixer, i18n and error scene. The rest of M5 reproduces the
  game's UI (real `*Menu*`-pack chrome) on the viewer. Staged plan:
  [`phase-2-m5-integration.md`](phase-2-m5-integration.md).

## Acceptance criteria (definition of done)

1. `web/city-view.html` shows town *trawg* in the base game's style:
   textured ground, real building sprites on verified footprints, named
   characters, no sprite standing on a road tile (the footprints are the
   cross-check).
2. Camera behaviour matches the base game by the user's A/B against the
   original Android client (same town on the fan server); the model and
   its derivation are in `notes/06`.
3. Coverage report: ≥95% of the 5,261 building instances render as real
   sprites; every missing one degrades to the labelled fallback (name +
   id visible), never a blank.
4. Headless smoke suite green; all other suites still green; zero network
   made; `web/assets/` touched only by the pipeline tool; CHANGELOG
   discipline kept.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Camera matrix RE stalls (mega-functions, indirect dispatch) | empirical fallback is pre-sanctioned (`notes/06` §5b); the A/B screenshot loop is the acceptance path either way |
| Sprite sheets are big (1–2 MB × ~2,300 slugs) | generate **crops of the static frame only** (typical cell ≈ a few hundred px), never ship whole sheets; pool is disposable `/tmp`; lazy-load + LRU in the page |
| bsv3 edge cases (other-atlas frames, anim-state ambiguity) | tsto2rgb `bsv.py` reference + round-trip on the core pack first; static frame = first state until A/B says otherwise |
| `transImageX/Y` units wrong → art floats/misanchored | start from footprint-loc anchoring (verified geometry) and treat transImage as refinement; A/B catches visible errors |
| 1-tile grid-origin error becomes visible with real art | A/B loop; roadmap-ctor RE as backup (`notes/01` open items) |
| Perf: 5,261 sprites, big sheets scaled per frame | viewport culling + per-zoom cache; smoke stub measures draw counts/frame time; user confirms fluidity |
| `/tmp` scratch wiped between sessions (pool, join JSON, r2 cross-ref data) | everything canonical lives in `data/`, `mapdump/`, `notes/`; the 611-family pipeline is re-runnable from `cdn/` (document the rebuild in this doc's start notes) |

## Session-start checklist (for the executing session)

- Read, in order: `notes/00-orientation.md` (working agreements), this
  doc, `notes/01-binary-formats.md` (`.rgb`/`.bcell`/`.bsv3`/terrain
  sections), `notes/06-camera-and-movement.md` (camera state — start from
  its open items), `notes/03-open-work.md` (what is parked and why).
- Working agreements: the user starts/stops any server; **no browser
  launching by the assistant** — visual A/B is the user's job, so request
  concrete screenshots (specific region + zoom) rather than hoping;
  **no network without asking** (includes re-cloning tsto2rgb — use
  `/tmp/opencode/tsto2rgb` if still there); CHANGELOG discipline
  (`## 2026-10-16.N` counter for same-day changes); not a git repo (never
  print commit commands); scratch in `/tmp/opencode/`; `web/assets/` is
  generated — never hand-edit.
- Tool check: Python 3.14 stdlib, Node 22, `7z` + `unzip`, rizin
  `/tmp/opencode/r2x/usr/bin/r2` (needs `LD_LIBRARY_PATH=/tmp/opencode/
  r2x/usr/lib`, `-e bin.relocs.apply=true`), the `LandData_pb2` shim
  (copy from `tools/gen_map_explorer.py`).
- Rebuild-if-wiped: 611-family candidate list =
  `*Game-100*` / `*Game_LTD-100` / `*BuildDecoGame*{Fall,Snow}-100` zips
  across `cdn/` (Game-25/50 excluded — see `notes/01` catalog section);
  the extraction pattern is in the (now-wiped?) `g100_extract*.sh` —
  7z the inner zip out, `unzip -j -o <zip> '1'`, then `unzip -j` the
  wanted globs from `1`.
- The Map Explorer (`web/map-explorer.html`) is the placement ground
  truth and the UI template; `tools/gen_map_explorer.py` is the
  generator template. Don't duplicate its terrain decode — share or copy
  the verified codebook.

## References

- `notes/01-binary-formats.md` — `.rgb` / `.bcell` / `.bsv3` / terrain
  codebook / catalog chain / footprint semantics (all verified)
- `notes/06-camera-and-movement.md` — camera RE state, open items,
  AArch64 decode cheats
- `notes/03-open-work.md` — parked items (bsv3 renderer, audio, …)
- `data/*.json` — canonical catalogs (ids, footprints, save join, flips,
  characters)
- `mapdump/*.pb` — the city save (town *trawg*)
- `web/map-explorer.{html,css}` + `web/js/map-explorer*.js` — placement
  ground truth + interactive scaffold to imitate
- `tools/gen_map_explorer.py` — generator + proto-shim template
- `Springfield-V08.apk` + `cdn/` (510 packs, 39 GB) — all source content,
  local
- `server/payloads/boot after login.har` — prod client ground truth
  (camera values verified absent from server config)

## Execution notes (2026-10-16, execution session)

Decisions taken in the planning session, recorded here so the executing
session doesn't re-litigate them:

- **No A/B screenshots this phase** (user: currently unable to get the
  Android client running). Everything that can be closed on internal
  cross-checks is closed on them; the A/B-dependent items are tracked as
  explicit open items, not silently papered over:
  - camera *feel* (pan velocity, inertia, zoom curve) — RE constants if the
    matrix build yields them, else documented defaults;
  - sub-tile anchor refinement (gross anchoring is verified internally via
    the footprint-verified placements);
  - exact grid origin (stays best-fit `(12,136)` unless the roadmap-ctor RE
    lands);
  - resting anim-state choice (first named state; low-risk).
- **Screenshot verification backlog** — run in this order the moment
  screenshots land (drop them in the project or `/tmp/opencode`, note which
  is which): (1) downtown ~10–20 buildings mid-zoom → pitch/obliqueness +
  grid origin + zoom reference; (2) same area second zoom → zoom curve;
  (3) max-zoom single known building → sub-tile anchor offset +
  `_transimage` layer; (4) road-junction close-up with manhole → final UV
  mapping confirmation. Bonus: first-load framing (deterministic camera)
  with the minimap visible pins the exact world rect + zoom.
- **Sequencing**: parallel tracks — sprite extraction in the background
  (mechanical), camera RE in the foreground with the ~1h hard gate to the
  empirical/fallback route. (Extraction actually finished first: the pool
  is a full single-worker pass.)
- **Renderer: plain Canvas 2D, confirmed** (no framework this phase).
  One structural addition: the scene emits an ordered per-frame **draw
  list** that a thin backend consumes, so the Phase 3 decision — keep
  Canvas 2D vs. move the world to **PixiJS** (primary candidate,
  render-only so the existing shell/`ui.js` canvas-UI library survives) vs.
  Phaser (batteries-included, but its canvas/scene ownership collides with
  the own-UI constraint) — is reversible. 3D engines (three.js & co.)
  rejected: the view is oblique billboards over a 2D grid, not true 3D.
  **Decision point: M5** (integration), informed by the smoke-stub perf
  numbers from M4. Canvas 2D confirmed for Phase 2 (user: keep it
  broadly accessible — lightweight, file://, no dependency).
- **Camera zoom correction (user observation, 2026-10-16, also in
  `notes/06` §4):** the base game does NOT zoom out to whole-town scale —
  the camera rests at a close mid-zoom and only zooms in a little. M0's
  camera model (RE or fallback) must have a narrow, zoom-in-biased clamp
  range, not a wide fly-over range. "Full town" on our page stays a
  convenience preset, clearly outside the base-game clamps.

### M1 status (2026-10-16, delivered)

- **Sprite pool** (track A): 11,816 files in `/tmp/opencode/citypool/`
  (~8 GB, disposable), 3,630/3,630 required slugs covered. Re-runnable
  via `gen_city_sprites.py extract`.
- **bsv3 parser**: both variants round-tripped to exact EOF on all 3,618
  pool files (`sprites --parse-only`). 0x0103 fully decoded (inline
  frames); 0x0303 header/pool/anim pinned (see notes/01) with the
  variable-length frame section only partially decoded — the static
  pass uses the leading `idx<<8` run (frame 0) capped to one block per
  position slot, with per-cluster and body-only fallbacks.
- **Static sprites**: `web/assets/city/<slug>.png` + `city-sprites.json`
  for 3,592/3,630 slugs (the 38 misses are fence/wall/railing/track
  pieces with no billboard in their packs → M2). Static-frame pick =
  fullest frame by total local crop area (0x0103) — NOT the first
  named state's first frame, which was wrong on ~140 files (effect-only
  first states, partial construction poses).
- **Character idles**: `chars` subcommand → `web/assets/characters/`
  (33 core-pack idle PNGs + `characters.json` anchors). Save
  instantiates 854 distinct characters; full coverage from event packs
  is deferred to M4.
- **Open for M3/M4**: sub-tile anchor refinement (screenshot backlog
  item 3); the 56 alpha=1 0x0303 files render body-only (global
  sprite-handle table unrecovered); ~53 floating-structure anchors sit
  high above the canvas bottom (legitimate — verify visually in A/B).
