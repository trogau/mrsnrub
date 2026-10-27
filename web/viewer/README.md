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
| `asset-variants-pixi.js` | Copy of `../js/asset-variants.js` with `../` URL prefixes (keep in sync). |
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
  (`Road art·spec`) and river (`Water art`) cells are drawn the engine's
  way: four quadrant quads per 4×4 cell, each a 4-vertex `PIXI.Mesh` whose
  UVs are the engine's own quad table (`ROAD_QUADS` / `RIVER_QUADS`) on the
  1024² `roadrivertiles-100` sheet — one resample, ≈1:1 at rest zoom
  (notes/09 §6). Legacy road-art modes 1–3 use a 512² cleaned copy (each
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

## URL knobs (same as the legacy page)

* `?dpr=1` — pin the backing-store resolution
* `?artS / artAx / artAy / artRef` — sprite-pin tuning overrides
* `?animMax / animMinPx / charAnimMinPx` — anim budget knobs

## Console probes

`__CV_cam`, `__CV_DIAG` / `__CV_VER`, `__CV_PROBE`, `__CV_TILE_screen`,
`__CV_TAP(_at)`, `__CV_TOG(_strip)`, `__CV_ANIM(_fi/_layers/_max/_minPx/_stats)`
— same harness surface as `js/city-view.js`.

## Vendor update

`vendor/pixi.min.js` comes from the npm package pinned in `package.json`:

```sh
npm install
cp node_modules/pixi.js/dist/pixi.min.js vendor/
cp node_modules/pixi.js/dist/pixi.js.d.ts vendor/   # optional, for editors
```
