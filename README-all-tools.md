# Springfield — The Simpsons: Tapped Out (web port)

An academic front-end port of **The Simpsons: Tapped Out** (EA, Android
client v4.70.5, package `com.ea.game.simpsons4_row.Springfield`) built from
the APK in this directory. All art, fonts, audio and interface strings were
reverse-engineered out of the game's proprietary asset packs and reassembled
as a vanilla-JS web app — no build step, no dependencies.

> Academic exercise. All rights to the game and its content belong to EA /
> Twentieth Century Fox. Nothing here is intended for distribution or
> commercial use.

## Run it

Serve this directory over HTTP and open the project hub at `web/index.html`
(component index for everything below), or the game itself at
`web/original.html`:

```sh
cd web
python3 -m http.server 8080
# → http://localhost:8080/            (hub)
# → http://localhost:8080/original.html  (game)
```

The game also works by opening `web/original.html` directly in most browsers
(the app deliberately avoids `fetch()`: data is embedded in
`assets/data/webdata.js`, assets load through `Image`/`Audio` elements).

## Asset Explorer

`web/assets-explorer.php` (linked from the city screen's top bar) browses
**every asset extracted from the APK** — plus any decoded CDN DLC packs
(fan CDN or archive.org bundles): **3,562,466 manifest entries** indexed in
`web/api/assets.sqlite` (built by `php tools/build_assets_db.php` from
`assets/manifest-parts/*.js`). It is the one page that needs the PHP server:
the page itself renders the header counts and the ~220 core manifest entries
from the DB, and every browse / search / variant / string / data query goes
to `web/api/assets.php` (JSON, paginated at 240 tiles per page with a
"Load more" button; search is a DB-side `LIKE` over path/origin/family/
resClass/kind, so it covers all 3.5M entries without loading them). The old
static page remains as `assets-explorer.html`, a redirect stub that keeps
`?path=` deep links.

- **Images (101)**: thumbnails grid, big preview with fit / 100% zoom on a
  checkerboard, provenance (source pack, original file, anchor point,
  color mode), and one-click switching between the resolution classes the
  APK ships — e.g. the splash background in small 2048×1024, medium
  4096×1024 and large 4096×2048, the 16 logo variants in three sizes each.
- **Audio (62)**: music tracks, UI SFX and the Homer lines, with a full
  player (seek, volume, loop).
- **Movies (3,148)**: the game's H.264 cutscene movies (intro + 3 cutscenes
  × 4 device tiers × 7 languages) from the archive.org `1_1_35` bundle, plus
  every DLC video — poster tiles with a play badge, in-browser playback,
  resolution /
  duration / codec metadata, and device-tier variant switching within a
  language.
- **Animations (23,734 frames)**: the `.bcell` character sprite animations
  decoded from the CDN content — 123 characters (the 26 playable ones
  plus Treehouse-of-Horror and event variants), one filmstrip entry per
  idle/walk/special per character, played back in the detail pane at the
  recorded per-frame delays (play/pause, loop, frame counter). The tab is
  grouped by character (the first underscore-separated segment of the frame
  file name, e.g. `edna_*`): the first page lists the 123 characters,
  clicking one shows its distinct animations with their resolution
  tiers and duplicate CDN revisions collapsed into a single tile (DB-side
  grouping tables built by the indexer), and a
  "← all characters" breadcrumb goes back.
- **Fonts (4)**: rendered glyph samples in the game's own faces.
- **Strings (16)**: the decoded `.btp` string tables (90 keys each),
  searched in the database (`op=strings`).
- **Data**: `splashscreen.xml`, device-scale XML, name lists, the engine's
  GLSL shaders, the support fallback page — raw text stored in the DB's
  `data_text` table, served on demand by `op=data` (11 embedded core files).
- **DLC (3,535,363 entries / 21,885 packs)**: content decoded from
  CDN packs other than the movies (see *Regenerating assets*). The tab is
  grouped by event family (`game`, `menu`, `treehouseofhorrorsgame`, …):
  the first page lists the 2,378 families (a representative image plus the
  asset/pack counts), clicking one shows its distinct files — each
  file's device tiers and duplicate CDN revisions collapse into one tile
  — and a "← all families" breadcrumb goes back. Tiles carry a green "DLC
  pack" badge and the detail pane shows the pack filename, season,
  resolution tier, revision and the CDN source URL, with the variant
  switcher offering that file's other tiers/revisions (for data files
  too). (Currently: the complete 3.0.30 core CDN content — every family,
  device/resolution tier and CDN revision of the original 2015, EA's
  2024 takedown and the fan-era 2025 generations — plus the fan CDN and
  archive.org bundles decoded since.)
- **Android shell**: launcher icons in all 5 densities, the pre-engine
  default splash, push icon.
- **Motion**: live previews of the animations the APK's data describes —
  the splash screen composed every frame from `splashscreen.xml`
  (with aspect-ratio and language selectors), the loading donut spin and
  the tap-finger bob. (The APK contains no frame-based sprite animations;
  those live in the native engine and the runtime DLC.)

## CDN Explorer (Phase 1)

`web/cdn-explorer.html` is a standalone **RE workbench** for the local
archive.org CDN bundles — independent of the Asset Explorer. It indexes the
three in-scope bundles (`1_0_4.7z`, `1_1_35.7z`, `3_0_30.7z` — 464 files,
`.time` sidecars included as first-class linked rows) into
`cdn/cdn-explorer.db` and lets you reverse-engineer the content one file at
a time:

- **Browse** any indexed zip → its entries → the nested pack `1` → asset
  files (virtual file system; members stream from the local `.7z` into a
  disposable `/tmp` cache — nothing is ever downloaded).
- **Inspect** with a hex view and on-the-fly previews (`.rgb`/`.bcell` →
  PNG, `.btp` → JSON, text formats → text) reusing the pipeline's decoders.
- **Record** findings (magic / format / decode / reference / decision) on
  any file *or* entry, with a per-target status workflow
  (`unknown → identified → decoded`, plus `skipped`/`error`) — the journal
  is the durable SQLite database, so a fresh session picks up the full RE
  history.
- **Organize** via a format registry (magic → spec → decoder), a
  generations view (same pack across revisions/bundles), a "Mystery" view
  grouping `status=unknown` files by name pattern as the next-target
  picker, on-demand sha256, and a `--dlc` pipeline-spec copy-out for
  handing files to `tools/extract_assets.py`.

```sh
python3 tools/cdn_explorer.py            # → http://<tailscale-ip>:8123/
```

Stdlib-only; by default binds this machine's **Tailscale IPv4** address so
the workbench is reachable from other devices on the tailnet (falls back to
127.0.0.1 when Tailscale is down; `--host` overrides). Makes **zero
outbound** network connections. Plan: `planning/phase-1-cdn-explorer.md`.

## Map Explorer

`web/map-explorer.html` is a standalone **interactive schematic map** of the
decoded city save (`mapdump/*.pb`) — no sprites: terrain is decoded in-page
from the raw `mapData` strings (verified codebook), and buildings/characters
sit at their real footprints from the `data/` catalogs (see
`notes/01-binary-formats.md`):

- **Terrain**: 7 layers (ocean, sand, dirt, river, road, dirt road,
  Krusty-Land road) drawn to a canvas.
- **Buildings**: all 5,261 instances with per-instance rects (directional
  fence variants and the monorail straight-track flip included); hover for a
  quick tip, and the details pane lists everything recovered for the id
  (asset, slug, footprint, anchor, height, position, flipState, how it was
  resolved, count in save). Click pins it.
- **Characters**: 871 named dots from the character catalog.
- **Search** by name / asset / slug / id across buildings *and* characters
  (Enter centers the first match); drag to pan, wheel / double-click to
  zoom, arrow keys nudge, Full town / Downtown presets.

The page is self-contained: `js/map-explorer-data.js` inlines the terrain
strings and the fully resolved instances, so it opens straight from
`file://` — no server, no network. Regenerate after a save or catalog
change:

```sh
python3 tools/gen_map_explorer.py      # → web/js/map-explorer-data.js
```

## Byte Map (city save .pb)

`web/pb-layout.html` (linked from the Progress dashboard's **Map & city**
card) visualises **where the bytes of the decoded city save went**: the
`Data.LandMessage` protobuf in `mapdump/*.pb` rendered as drill-down
stacked bars — row 0 splits the whole 1.9 MB file by top-level field (in
file order), click a segment to open its interior, again to go deeper.
Segments are coloured by how far our RE has actually reached —
**decoded** (we parse and use it, e.g. the verified terrain grids),
**partial** (structure understood, e.g. building instances),
**schema-only** (name known from the compiled proto, content never
decoded), **unknown** — with hover tooltips carrying exact byte offsets,
occurrence counts and finding notes, and a details pane per selection.
Repeated messages aggregate their children's sizes across all
occurrences (structure from the first). `TerrainData` grid layers
(roadsData, riversData, oceanData, the 7 road overlays, subland terrain)
get a **grid analysis** panel: terrainType name, `mapDataSize`
cross-check, tiles-filled ratio, and a char histogram annotated with the
verified `a..p`/`G`/`P` codebook meanings from notes/01 — plus a **2-D
tile map** rendered on a canvas (one opaque pixel per filled tile:
roads drawn gold at the verified 512 x 1087 geometry, rivers blue, ocean
teal, overlays in per-type colours, decoder-ignored chars in red; the 7
overlay layers list one thumbnail each). The page is self-contained
(`js/pb-layout-data.js` inlines everything, pooled grid strings
included; opens from `file://`):

```sh
python3 tools/gen_pb_layout.py [city.pb]   # → web/js/pb-layout-data.js
# then bump ?v= on js/pb-layout-data.js in web/pb-layout.html (cache-bust)
```

## Progress Tracker

`web/progress.html` is the project's **progress dashboard**: one page
showing how far along the RE / unpacking / extraction work is.

```
http://dave-latitude-5550.tailc953b.ts.net:8081/mrsnrub/web/progress.html
```

(The `…:8081/mrsnrub/` prefix is this project's web base URL on the
serving box; every page under `web/` hangs off it. The API it reads is
`…/mrsnrub/web/api/progress.php`. Unlike the other explorer pages this
one needs the PHP server — it does not open from `file://`.)

- **Meters** (progress bars + trend sparklines, snapshot-over-snapshot
  deltas) across six sections: the CDN funnel (bundles downloaded →
  indexed → unpacked → contributing decoded packs; decoded packages vs
  the 4,869-entry v469 master index), format RE (CDN Explorer status mix,
  format registry, findings), native `.so` RE (classes, methods,
  endpoints, protobuf fields, string xrefs), server-API documentation,
  the asset pipeline (counts per type; PCM audio and `.bsv3` renderer
  gaps), and map/city (building resolution, street eye tests, evidence).
- **Bundle coverage grid** — every archive.org bundle as a chip
  (grey = downloaded untouched, blue = unpacked, amber = indexed, green =
  contributing decoded packs), grouped by season.
- **Task & decision board** — now its own page at `tasks/index.html`
  (`…/mrsnrub/tasks/index.html`), split out of the dashboard on 2026-10-25.
  It carries the deferred/pending-approval items from `notes/03-open-work.md`,
  editable in the page (add / status / delete); the dashboard links to it.
  The free-form journal for end-of-session notes stayed on the dashboard.
- Everything derived is **computed by the scanner, never hand-entered**:

```sh
python3 tools/progress_scan.py [--note TEXT]   # → new snapshot
```

## What you get

| Screen | What it is |
| --- | --- |
| **Splash** | The real launch screen: Springfield cityscape strip, Homer, tap-finger, Groening signature and the localized "Tapped Out" logo — composed at runtime from the game's own `splashscreen.xml` (per-aspect-ratio rules, background crop windows, placement offsets). |
| **Loading** | The real loading donut spinning over a progress bar that reflects the actual asset download. |
| **City** | An honest placeholder: the live city/buildings/characters are downloaded as DLC from EA's servers at runtime and are **not** in the APK, so there is no city to play. This hub demos the extracted material instead. |
| **Error** | The real "technical difficulties" screen (Bart art + the game's own connection-error strings + Retry). |

Features driven by the extracted data:

- **Splash layout is data-driven**: 11 aspect-ratio rulesets (22:9 … 4:3)
  are parsed from `splashscreen.xml`; the closest one is selected per
  viewport, including the background crop-window math and the
  `single_edge/right` + `keep_center` ratio policies.
- **16 languages** (en, de, fr, es, it, pt, ru, da, nl, no, sv, zh, tc, kr,
  th, tr) from the `.btp` string packs — switch live from the city screen;
  the splash logo swaps to the localized artwork.
- **Audio**: all 62 WAVs from the APK (3 music tracks + UI SFX + Homer
  lines). Button blips, dialog open/close, the main theme on tap-to-start,
  background loop in the city.
- **Fonts**: the game's `ComicCrazy` and `Helvetica Neue` faces, used for
  canvas text.
- **Generic popup** styled after the game's dialogs, using real strings
  (`Quit Game` / `Do you want to leave the game?` / `YES` / `NO`).

## Project layout

```
Springfield-V08.apk        the source APK
tools/extract_assets.py    APK → web/assets pipeline (pure stdlib Python);
                           also decodes fan-CDN DLC packs via --dlc
tools/crawl_cdn.py         rate-limited CDN listing crawler → cdn/catalog.json
tools/cdn_explorer.py      CDN Explorer — RE-workbench server
                           (stdlib; binds Tailscale by default, :8123;
                           see planning/)
tools/progress_scan.py     Progress tracker scanner — recomputes all
                           progress meters into web/api/progress.sqlite
                           (run at the end of a working session)
tools/gen_map_explorer.py  city save + data catalogs →
                           web/js/map-explorer-data.js (Map Explorer data)
tools/gen_pb_layout.py     city save .pb → web/js/pb-layout-data.js
                           (Byte Map: per-field byte allocation + RE status)
tools/build_assets_db.php  Asset Explorer indexer: streams the manifest
                           parts → web/api/assets.sqlite (entries + group
                           tables for the anim/DLC drill-downs; ~20 min)
tools/smoke-scene.cjs      headless game-flow regression test (Node)
tools/smoke-explorer.cjs   headless asset-inventory integrity test (Node)
tools/smoke-explorer-dom.cjs  headless DOM test of the explorer page (Node)
tools/smoke-cdn-explorer.py  headless CDN Explorer smoke suite (Python)
tools/smoke-map-explorer-dom.cjs  headless DOM test of the map page (Node)
cdn/catalog.json           fan-CDN tree listing (9 dirs, 60 files, 278.6 MB)
cdn/v469-packages.json     parsed v4.69 master DLC index (5,146 package
                           entries — the game's full content catalog)
cdn/*.7z                   archive.org `tsto-cdn-content` bundles: copies of
                           original-EA-CDN content dirs (1_0_4, 1_1_35)
cdn/cdn-explorer.db        CDN Explorer SQLite DB: file index + RE findings
data/
  building_ids.json        3,440 building ids → name/asset/slug (gamescripts chain)
  building_footprints.json 5,446 asset slugs → x/z/locX/locY/height (CDN pool)
  save_buildings.json      this save's 2,299 ids resolved (with resolution path)
  character_ids.json       character ids → name (gamescripts chain)
  flip_assets.json         fence names → nameFlip{SE,SW,NE,NW} asset variants
mapdump/
  *.pb                     decoded city save (LandMessage)
  renders/*.jpg            static schematic renders (real footprints)
tasks/
  index.html               Task & decision board page (needs the PHP server;
                           split out of web/progress.html 2026-10-25)
  js/tasks.js              Board page logic (same store via web/api/progress.php)
web/
  index.html               project hub — index of every page/component
  original.html            game shell (classic scripts, no modules/build;
                           formerly index.html)
  viewer/                  City View (PixiJS) — THE viewer; all future viewer
                           work happens here (see viewer/README.md)
    index.html               oblique 2.5D city view on PixiJS 8 (opens from file://)
    city-view-pixi.js        renderer + workbench port
    vendor/pixi.min.js       vendored PixiJS 8 UMD build
  city-view.html           legacy Canvas2D/hybrid-WebGL city view — DEPRECATED,
                           kept as implementation reference only
  assets-explorer.html     redirect stub (keeps old links + ?path= deep links)
  assets-explorer.php      asset explorer page (PHP: renders header counts +
                           the core manifest from assets.sqlite; grid/search/
                           strings/data go to api/assets.php)
  cdn-explorer.html        CDN Explorer (RE workbench) page
  map-explorer.html        Map Explorer (interactive save map) page
  progress.html            Progress dashboard (needs the PHP server)
  pb-layout.html           Byte Map — city save .pb byte allocation
                           (linked from the dashboard's Map & city card)
  api/
    streets.php            City View street-verdict store (SQLite)
    assets.php             Asset Explorer JSON API (counts/list/asset/
                           variants/strings/data/meta over assets.sqlite;
                           also runs under the CLI for the smoke harness)
    assets-db.php          shared PDO connection + entry mapping (API + page)
    assets.sqlite          Asset Explorer index (written by
                           tools/build_assets_db.php; gitignored)
    progress.php           Progress dashboard API (read-only scan data +
                           editable task board / journal)
    progress.sqlite        scanner snapshots + tasks (written by
                           tools/progress_scan.py)
  css/app.css              game layout, @font-face, shared [data-tip] tooltip rule
  css/explorer.css         explorer layout + @font-face
  css/cdn-explorer.css     CDN Explorer layout + @font-face
  css/map-explorer.css     Map Explorer layout + @font-face
  css/progress.css         Progress dashboard layout + @font-face
  css/pb-layout.css        Byte Map layout + @font-face
  js/
    boot.js                canvas, main loop, scene manager, input, startup
    assets.js              image loader + manifest lookups
    audio.js               HTMLAudioElement mixer (SFX + crossfading music)
    i18n.js                string lookup over the 16 decoded .btp tables
    splashlayout.js        splashscreen.xml parser + layout math
    ui.js                  buttons, text wrapping, generic popup
    scenes.js              splash / loading / city / error scenes
    explorer.js            asset explorer page logic
    cdn-explorer.js        CDN Explorer page logic
    map-explorer.js        Map Explorer page logic
    progress.js            Progress dashboard page logic
    pb-layout.js           Byte Map page logic (drill-down bars)
    map-explorer-data.js   GENERATED by tools/gen_map_explorer.py (inline data)
    pb-layout-data.js      GENERATED by tools/gen_pb_layout.py (inline data)
  assets/                  GENERATED by the pipeline (do not hand-edit)
    images/  thumbs/  audio/  fonts/  i18n/  data/
    dlc/<pack>/            decoded CDN DLC packs: images/ audio/ data/
                           videos/ thumbs/ (additive — plain re-runs keep
                           them; see --dlc below)
    manifest.json          human-readable inventory (dims, durations, provenance,
                           family/resClass variant grouping, anchors, thumbs)
    manifest.js            same data as window.MANIFEST
    data/webdata.js        embedded i18n tables + splashscreen.xml + raw text of
                           every data file (window.WEBDATA)
```

## Regenerating assets

```sh
python3 tools/extract_assets.py Springfield-V08.apk
```

rebuilds `web/assets/` from the APK in ~12 s (no third-party packages):
all splash resolution classes (small/medium/large), all core UI classes,
fonts, i18n, audio, data files (incl. the engine's GLSL shaders), Android
shell icons, grid thumbnails for the big images, and the manifest +
webdata bundles. `--out` overrides the output directory.

Fan-CDN DLC packs (same `0`/`1` container as the APK packs) are decoded
with `--dlc`, repeatable:

```sh
python3 tools/extract_assets.py Springfield-V08.apk \
  --dlc '{"file": "pack.zip", "url": "https://cdn.projectspringfield.com/static/SeasonFall/pack.zip"}'
```

Metadata (season, resolution tier, revision) is derived from the URL
(`/<season>/<name>-<tier>-r<revision>.zip`); `season`/`tier`/`revision`
keys in the JSON override it. Content lands in `web/assets/dlc/<pack>/`
and is tagged on every manifest entry. DLC is additive: a plain re-run
keeps previously decoded packs and re-merges their manifest entries;
passing `--dlc` for a pack again replaces just that pack. The CDN tree
itself is cataloged (metadata only) in `cdn/catalog.json` by
`tools/crawl_cdn.py`, which enforces ≤1 concurrent connection, ≥10 s
between requests and a blank User-Agent.

Video files (`.mp4`/`.m4v`/`.mov`) inside a pack pass through to
`dlc/<pack>/videos/` as manifest type `video` with pure-stdlib box-walk
metadata (resolution, duration, codecs) and — when ffmpeg is installed —
a poster frame in the pack's `thumbs/` dir (tiles fall back to a ▶ glyph
without it). Packs that come out of an archive.org `.7z` bundle (whose
URL names the bundle, not the pack) set their true CDN package name via
the `pack` / `family` spec keys:

```sh
python3 tools/extract_assets.py Springfield-V08.apk \
  --dlc '{"file": "movie-intro-ipad-en-v1_1_35.zip",
          "url": "https://archive.org/download/tsto-cdn-content/cdn/1_1_35.7z",
          "pack": "movie-intro-ipad-en-v1_1_35", "family": "movie-intro",
          "tier": "ipad", "season": "1_1_35"}'
```

Whole bundle directories (hundreds of packs) go through the batch driver,
which derives the per-pack specs from the CDN file names and runs the
pipeline exactly once:

```sh
7z x -y -o/tmp/tsto/3_0_30 cdn/3_0_30.7z
7z x -y -o/tmp/tsto/1_1_35 cdn/1_1_35.7z
python3 tools/run_dlc_batch.py Springfield-V08.apk \
    /tmp/tsto/3_0_30 /tmp/tsto/1_1_35 --skip fontcache
```

(`--skip`/`--prefix` filter by zip-name substring, `--dry-run` lists the
specs. The four CJK `fontcache` packs are custom glyph-atlas binaries with
no known decoder and are skipped.) Each per-file decode is wrapped in
try/except: a single corrupt or unrecognized file is stored as raw data
with a `decode_error` note instead of aborting the whole batch.

## Tests

All headless, no browser:

```sh
node tools/smoke-scene.cjs          # game flow: boot→splash→loading→city at 60 fps simulated
node tools/smoke-explorer.cjs       # asset inventory: files on disk, variants, dataText
node tools/smoke-explorer-dom.cjs   # explorer page: renders every tab, clicks a stratified tile sample
python3 tools/smoke-cdn-explorer.py # CDN Explorer: fixture 7z bundles, full API, kill+restart persistence
node tools/smoke-map-explorer-dom.cjs  # map page: boot, hover/pin, search, zoom/pan on a minimal DOM
python3 tools/smoke-progress.py     # progress tracker: fixture scan meters, coverage grid, PHP API (CLI)
node tools/smoke-progress-dom.cjs   # progress page: real progress.js on a stub DOM (strict classList), meter/coverage/task render + POST flows
node tools/smoke-pb-layout-dom.cjs  # Byte Map page: real pb-layout.js on a stub DOM, bars/drill-down/breadcrumb/Esc on the generated data
```

`smoke-scene.cjs` stubs the DOM/Image/Audio, taps the splash and drives the
real frame loop, asserting the scene transition completes in finite frames
and every audio file is requested exactly once. `smoke-explorer-dom.cjs`
drives the real `explorer.js` with a minimal DOM against the **real**
`assets.sqlite`: the `fetch()` stub shells out to `web/api/assets.php` via
the PHP CLI, and expected counts/totals come straight from the database via
`node:sqlite`. It exercises every tab (including
Movies, Animations and DLC), both drill-downs
(Animations character pages and the DLC family pages, incl. breadcrumb
back), grid paging + Load more, a stratified sample of tiles (every video/audio/font/strings tile,
capped image/anim/data samples — every detail renderer is exercised
without the O(n²) cost of clicking every tile), the variant switcher,
the motion canvases and search.

## Formats decoded (findings)

The APK packs live at `assets/<group>/<name>/` as two files:

- `0` — a `BGrm` index/manifest (version u32 after the magic). Redundant
  with the ZIP; only the version is recorded.
- `1` — a **plain ZIP** of asset files.

File formats:

- **`.rgb`** — `[u32 flags][u16 width][u16 height][raw pixels]`.
  `flags & 0x20000000` → 2 bytes/px, **RGBA4444 with channel order B,A,R,G**
  (high nibble first: `byte0 = (B<<4)|A`, `byte1 = (R<<4)|G`). Within the
  4-bit files there are two storage variants:
  - flag `0x2000` (most game art) — colors are **premultiplied** by alpha;
    the pipeline un-premultiplies on decode.
  - flag `0x6000` (`0x2000 | 0x4000`) — **straight (unmultiplied) alpha**.
    Used by the 3.0.30 menu level-select art (`levels_level*.rgb`,
    `unlock_lock.rgb`, 88 files); proven by channel nibbles exceeding the
    alpha nibble, which is impossible for premultiplied data. Decoded
    without the un-premultiply step.
  Flag `0` → 4 bytes/px straight RGBA. (The 4-bit layout was cross-checked
  against the community `tsto2rgb` conversion tool, which writes these
  files with ImageMagick in exactly that channel order; earlier "gray +
  alpha" reads were only accidentally close because the art is mostly
  flat-colored.)
- **`.btp`** — localized string packs. Magic `BTP\0`, then a 20-byte
  **big-endian** header (u32 file size @8, u32 entry count @12), then
  entries with big-endian lengths:
  `[u8 name_len][name+NUL][u32 str_len incl. NUL][string][u32 gap]`
  (no gap after the final entry). 90 keys per language, 16 languages.
- **`.bcell`** (magic `bcell10`, character animations) —
  `[u16 n_records][u32 unknown]`, then per record (13 bytes):
  `f32 delay_ms, i16 x_off, i16 y_off, 5 bytes` (stream coordinates; the
  last record's final byte is `0x20`), then one pixel block per unique
  frame in record order (there can be fewer blocks than records — the
  extra records hold the last frame): the first block is `[u16 w][u16 h]`,
  every following block `[u32 0x20000000][u16 w][u16 h]`, each followed by
  `w*h*2` bytes of the same premultiplied RGBA4444 B,A,R,G pixels as
  `.rgb`. Verified to parse to exact EOF on all 4,053 files of the full
  3.0.30 CDN content.
- **`.bsv3`** (building animation scenes) — `[u16 0x0103][u16 n_cells]
  [u8 alpha_flag]`, per cell a NUL-terminated `C_<name>_Crop_NN` string
  plus `i16 x, y, w, h`; then `u16 n_frames`, per frame `u16 n_blocks` +
  blocks of `[u16 cell_index][f32 x][f32 y][f32 1][u32 0][f32 1]`
  (×100 fixed point, optional `u8 alpha`); then `u16 n_anims`, per anim a
  NUL-terminated state name + `u16 first/last frame`. Kept as raw data
  files (decoded layout documented here; a canvas renderer is future work).
- **`.txt`** — anchor coordinates / UI name lists, kept as-is.

## Scope notes & porting decisions

- **No gameplay**: `libscorpio.so` (28 MB, Bight BGCore engine) holds all
  game logic and is server-authoritative against `game.pjtsto.com`; the APK
  ships only the splash/core baseline. A playable city would require either
  the runtime DLC content (server-side, not recoverable from the APK) or a
  from-scratch reimplementation — out of scope for this build.
- **Splash background**: the 4096×1024 strip contains art only in
  x 0–2052; the transparent margin is filled with a sky→field gradient
  sampled from the art itself (the native engine drew over its scene
  background color).
- **Resolution classes**: the game ships small/medium/large splash packs;
  this build uses the **medium** set consistently (the XML "scale 1" sizes
  match the medium pack's native pixels; design-space height = 1024).
- `ascenderuni.ttf` (17.8 MB CJK fallback font) was intentionally omitted;
  the four UI faces used by the screens are included.
# mrsnrub
