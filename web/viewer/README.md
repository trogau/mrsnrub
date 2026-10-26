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
  the grass `TilingSprite`, the sea quad, flat feature quads, the road sheet
  cells (each used slot of `roadtilesheet.png` clipped to its inscribed
  diamond once, offscreen; the sprites then just rotate 45° + scale), the
  manholes, avenue cells, and the two zoomed-out flat atlas blits
  (`terrain.flatInfo()`).
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
