# City View — PixiJS port

The **current city viewer** for this project, at `web/viewer/index.html`
— any future viewer work happens here. A reimplementation of the now-deprecated
`web/city-view.html` (the oblique 2.5D Springfield
workbench) on [PixiJS](https://pixijs.com/) 8. The legacy page paints the
scene with Canvas2D plus a hand-rolled hybrid-WebGL layer (`js/gl-base.js`),
which drops frames once the town fills in; here the *entire* scene — ground,
road sheet art, avenues, building prisms/sprites, people, and every debug
overlay — goes through one Pixi renderer on a single canvas (`#cv`).
The renderer is WebGL-only (the legacy page's `?nogl=1` Canvas-renderer
fallback is not ported; without WebGL the page reports the init failure in
the statsbar).

Open it like the original: `file://` works, no server or network needed
(data is inlined by `../js/map-explorer-data.js`). The street-verdict
panel talks to `../api/streets.php` only when served over HTTP.

## Files

| File | What it is |
| --- | --- |
| `index.html` | Page chrome — same markup/IDs as `city-view.html`, minus the `#glcv` canvas. |
| `city-view-pixi.js` | The whole renderer + workbench port (chrome, toggles, panels, hit-testing, presets, verdict tools). |
| `asset-variants-pixi.js` | Building card (sprite variants). Subdirectory copy of `../js/asset-variants.js` with `../` URL prefixes, plus the viewer-only dynamic tiles and unpainted pack copies — see *Where the right-side panel's art comes from* (do **not** sync those back). |
| `char-variants-pixi.js` | Character card (every cell of one cast member as mini players). Viewer-only: the legacy page has no equivalent. Roster and sheets both come from `../api/bcell.php`. |
| `vendor/pixi.min.js` | Vendored PixiJS 8.22.0 UMD build (global `PIXI`); fetched via npm — see `package.json`. |

Shared DOM-free modules are reused **verbatim** from `../js/`:
`camera.js`, `terrain.js` (data model only — `terrain.render()` is never
called), `objects.js`, `walks.js`, `markers.js`, `map-explorer-data.js`.
Their canvas-draw code is re-implemented on Pixi inside
`city-view-pixi.js`.

## How it renders

* **Ground** — one Container whose per-frame matrix is `CAM.tileAffine`, so
  everything static in *tile space* is placed once and never re-projected:
  the grass `TilingSprite`, the sea quad, the flat type fills (their own
  `fillC` layer under all art, so their anti-seam overhang never paints over
  a neighbour's art), the road and river cells, the manholes, avenue cells,
  and the two zoomed-out flat atlas blits (`terrain.flatInfo()`). Road
  (`Road art·spec`), river (`Water art`) and dirt (`Dirt art`) cells are
  drawn the engine's
  way: four quadrant quads per 4×4 cell, each a 4-vertex `PIXI.Mesh` whose
  UVs are the engine's own quad table (`ROAD_QUADS` / `RIVER_QUADS`) on the
  1024² `roadrivertiles-100` sheet — one resample, ≈1:1 at rest zoom
  (notes/09 §6). The dirt layers reuse those same tables on the same-
  lattice dirt sheet (`dirtroadtilesheet`), art following the game's pack
  layering — the permanent WildWest `.rgb` (decoded at runtime) normally,
  the snowy XMAS `.png` in winter: `dirtroad` via the
  road model, `dirt` via the river model, each probing its own saved grid
  (notes/09 §11). Legacy road-art modes 1–3 use a 512² cleaned copy (each
  used slot clipped to its inscribed diamond, sprites rotate 45° + scale).
* **Bridges** — where a road corridor crosses the river: one 3-lamppost
  `bridgetop` section per road cell over water on each side of the road
  (doubled lampposts at the joins, as in the game). Screen-space layers
  `bridgeG` (far row) → `raisedG` (the crossing cells' road art,
  reparented) → `bridgeNearG` (near row). Toolbar: **Road bridges** on/off,
  **Bridge grass** swaps the end sections to the grass-abutment frames
  (off by default). Rule and measurements: notes/09 §10;
  `tools/bridge-sites.py` is the reference, `tools/check-bridges.cjs` the
  harness.
* **Scene** — a screen-space sprite **pool** refilled from index 0 each frame
  in depth order (child order = painter order). Prism faces are unit-quad
  sprites driven by a parallelogram matrix (`setFromMatrix`); art sprites,
  filmstrip anim cells and people dots are ordinary pooled sprites.
* **Overlays** — grid / wire / walks / markers / proposed / frags / selection
  outlines are per-frame `Graphics` + pooled `Text`, stacked in the original
  draw order.

Textures come from `new Image()` wrapped in `PIXI.Texture` — never
`PIXI.Assets.load` — which is what keeps `file://` working. No custom
shaders, no `CityGL`.

LOD follows the original: below `s = 2` buildings collapse to the terrain
flat atlas + the ported `buildBuildFlat` canvas bake; above it they are
prisms or extracted sprite billboards (`assets/city/`) with bsv3 filmstrip
anims (`assets/city/city-anims.json`) exactly as the Canvas page does.

Tuning state shares the **same `localStorage` keys** as the original page
(`mrsnrub.cityview.*`), so presets/orientation/art knobs carry between the
two pages.

## Where the right-side panel's art comes from

Both cards (the building card in `asset-variants-pixi.js`, the character card
in `char-variants-pixi.js`) stream from the two endpoints, so a *healthy* card
asks nothing under `assets/`:

| Card | What it asks for |
| --- | --- |
| Building | `../api/bsprite.php?kind=sprite\|season\|anim\|stack\|flag&name=…` for each `city/` row, sharing the map's `__CV_DYNC` inventory, per-category `VIEWER_DYNAMIC_CITY` flags and 25-failure breaker. |
| Character | `../api/bcell.php?mode=family&cid=N` for the roster (the generator's `families/<cid>.json` bytes, verbatim), then one `mode=sheet` PNG per cell — the same shared `dynCells` entry the map uses, so one cell costs one manifest + one sheet between the two. |

A tile still falls back to a pre-baked PNG when the endpoint really cannot
serve it: the breaker is tripped, the boot preflight has not answered, the pool
has no such stem, `grasstile` (never in the pool — no tool generates it), or a
character cell is *dead* (red outline). While an answer is merely **pending**
the tile stays empty (`vcv vpend`) and fetches nothing — the card used to pull
one frame PNG per tile at open, ~150 requests before the manifest had even
answered.

The **map** follows the same rule (2026-11-05): a character whose sheet is
still decoding is simply not drawn, so a character whose art comes from the
endpoint asks the art tree for zero requests. Its shipped PNG survives as the
art for `VIEWER_DYNAMIC_BCELL.characters = false` (the A/B hatch) and for a
manifest that is ready but names an image its sheet does not carry — a cell the
endpoint *rejects* gets the red wireframe, never the file. `tools/smoke-idle-wander.cjs`
pins all of that, including that the map has exactly one character-art request
site left.

**Manifest-pack copies** (the `dlc/` `_transimage` / `_menu` / `_holo` sidecars
the CDN packs ship beside the building art — 4,659 of the variant rows) are
listed but **not painted**: no endpoint can bake them (`bsprite.php` works from
the citypool, which holds none of that art) and the map never draws them, so
their thumbnails bought only a dependency on 4,659 files. They keep their
caption and their Asset Explorer deep link.

Escape hatches for A/B: `?packimg=1` (or `window.VIEWER_PANEL_PACK_IMGS = true`)
paints those thumbnails again. To fall back to the pre-baked files, switch the
endpoint off at its own level — `?dyn=0` (or the `VIEWER_DYNAMIC_CITY` flags in
`index.html`) for the building card, `window.VIEWER_DYNAMIC_BCELL`'s
`characters: false` for the character card.

## URL knobs (same as the legacy page)

* `?dpr=1` — pin the backing-store resolution
* `?artS / artAx / artAy / artRef` — sprite-pin tuning overrides
* `?animMax / animMinPx / charAnimMinPx` — anim budget knobs

Viewer-only (the legacy page has no endpoints to switch):

* `?dyn=0 / 1 / sprites,anims` — which building families ride `bsprite.php`
* `?packimg=1 / 0` — paint (or don't) the manifest-pack copy thumbnails the
  building card otherwise leaves unpainted

## Console probes

`__CV_cam`, `__CV_DIAG` / `__CV_VER`, `__CV_PROBE`, `__CV_TILE_screen`,
`__CV_TAP(_at)`, `__CV_TOG(_strip)`, `__CV_ANIM(_fi/_layers/_max/_minPx/_stats)`
— same harness surface as `js/city-view.js`.

The endpoint's own state: `__CV_DYNB` (`{cfg, cells}` — the `.bcell` cells asked
for so far, each `{st: 0 loading | 1 ready | -1 dead, man, url, err}`) and
`__CV_DYNC` (`{cfg, box, fails, inv()}` for `bsprite.php`), plus `__ASSETS`
(the art loader's counters, the same ones the header pill shows).

**The Debug button** (top bar, after Wire) prints all of that — plus the things
that only a live frame can answer — into a panel and onto the clipboard: the
build's own cache-buster (`build vNNN`, so a paste says which build produced
it), the GPU's `MAX_TEXTURE_SIZE` (a sheet wider than that uploads *incomplete*
and WebGL samples it as opaque black), which branch every on-screen character
took in the last frame (`.bcell` sheet cell / walk cell / **held** because its sheet
is still decoding / red wireframe / shipped `assets/characters` PNG / dot),
every cell that is not ready and why, the selected object's slug + asset +
cell, and a census of the sprites actually on screen — every visible sprite in
`app.stage`, each labelled with the layer it belongs to (`scene`, `raised`,
`ground`, `bridge`, `markers`, …), named by its URL, by the `<img>` the viewer
decoded for it (tag, `naturalWidth × naturalHeight`, and the URL that element
holds), by the sub-rect it blits, and read back on the CPU for coverage and mean
brightness, which is what separates *the served bytes are black* from *the bytes
are fine and the upload is not*.
That readback has to come from the viewer's own element: `PIXI.Texture.from`
re-keys the image into its registry, so Pixi's `source.source` is a wrapper
that has a width but is not drawable — measuring through it proves nothing, and
the report prints `no <img>` for those rather than a number. That is why every
texture the page makes, including the ones built outside `texFor` (ground, road
and ice sheets, dirt, the LOD atlases, the unit quad), goes through `texFrom`,
which stamps the element and a name on it.
Groups are keyed by texture *and* tint *and* effective alpha, because what
reaches the screen is the product of the three: a row with healthy pixels under a
near-black tint is flagged `*** TINT KILLS ART` and shows `blit lum N`, and rows
whose own bytes are opaque and near-black are flagged `*** OPAQUE NEAR-BLACK`.
Each row samples the texture **twice** — `cpu`, drawn out of the viewer's own
`<img>`, and `gpu`, read back out of GPU memory by `renderer.extract.pixels`
(ending in `gl.readPixels`). That second half is the only way to tell bad bytes
from a bad upload: an opaque black patch the source does not have can only have
arrived with the upload, so it is flagged `*** GPU BLACK (bytes fine: upload
fault)` (and a texture with nothing in it at all, `*** GPU EMPTY`). Readbacks are
bounded by a per-texture cap and a per-report budget, both printed as `skipped
…` rather than passing as clean.
Verdicts are computed for every group before any row prints, so a flagged group
is never lost to the row cap (the tail then reads `N more groups (none
flagged)`). The census walks the stage rather than a few hand-picked containers
on purpose, and prints `across N named layers` next to the sprite count: when it
walked four, a rectangle drawn by the ground fills, the bridges, the LOD atlases
or an overlay layer was simply absent from a report that said "sprites on
screen", and `suspicious: 0` again meant less than it read. Layers switched off
as a whole (LOD, art off) are not counted as on screen but are named —
`not on screen (hidden layer): beach, bridge-near` — because a report that
silently drops a layer cannot be trusted to have looked.
The census ends with how many rows it could not measure at all — and note that a
character drawn as a *dot* is not in it, so "nothing suspicious" plus dots means
look at the branch counters, not at the sprites.
Those counters split dots three ways, because they mean three different things:
below the readability floor, an asset with no png the endpoint could bake, and
**no record in the catalogue at all**. The last one names the characters (up to
eight, `Canyon Ranch Joe#185203`) — a count of them is nothing anyone can act
on — and it is only tallied on a frame where the art lookup actually ran, so an
LOD frame, where everything is a dot by design, does not invent a content gap.
A character is **two** requests — `mode=manifest` then `mode=sheet` — so the
report also runs a `[pair check]`: for every ready cell it compares the page
size the manifest claims against the sheet the browser actually decoded, and
prints `PAIR <name>: manifest page … vs sheet … — N image rect(s) outside it`
when they disagree. Each half is individually valid, so nothing else on the page
could notice the pair drifting apart. **It is not the black square, though:**
four reports in a row have come back `0 stale pairs`, and a hard reload does not
clear the square — so if a stale pair were the cause, one of those would have
said otherwise. `__CV_DEBUG()` returns the same text from the console, and
`tools/smoke-idle-wander.cjs` pins the tallies against the branches they describe
and the pair check against the compare it claims to do.
`[cell frames]` is where the square is hunted now. The census can only ever see
the frame that happened to be on screen when the button was pressed, while a walk
or blink cell lives in its other frames most of the time; and the `<img>` can
only ever testify about the file, not about what the GPU was given. So every
frame of every ready cell is read back on **both** sides, and two faults that a
live frame hides are reported: a rect that falls **off the decoded page** (WebGL
clamps it, and ANGLE may sample black there), and a frame **naming an image the
manifest does not have** — the shape of the `3 frames · 2 images` cells. A clean
cell costs one line: `julio_back_walk 2 frames · page 306x222 · clean`.

## Vendor update

`vendor/pixi.min.js` comes from the npm package pinned in `package.json`:

```sh
npm install
cp node_modules/pixi.js/dist/pixi.min.js vendor/
cp node_modules/pixi.js/dist/pixi.js.d.ts vendor/   # optional, for editors
```
