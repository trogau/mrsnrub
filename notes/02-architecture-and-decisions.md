# 02 — Architecture & decisions

## Web app (`web/`)

Vanilla JS **classic scripts** — no ES modules, no build step, and **no
`fetch()` anywhere**: all data is embedded in generated
`assets/data/webdata.js` (`window.WEBDATA`) and `assets/manifest.js`
(`window.MANIFEST`), so the app works from `file://`. Canvas 2D rendering,
`HTMLAudioElement`-based mixer. (Two exceptions: the Asset Explorer is a PHP
page backed by SQLite — see below; it needs the PHP server. And `js/audio.js`
fetches the short SFX once to decode them with Web Audio, falling back to a
plain `Audio` element when `fetch`/`AudioContext` is unavailable, e.g. from
`file://`.)

```
js/boot.js          canvas, main loop, G.setScene/fades, input, startup
js/assets.js        image loader + manifest lookups (case-insensitive origin)
js/audio.js         mixer: short SFX from pre-decoded Web Audio buffers,
                    music over HTMLAudioElement, plus the shared Player the
                    explorer's detail pane drives (element fallback when
                    Web Audio or http is unavailable)
js/i18n.js          string lookup over the 16 .btp tables
js/splashlayout.js  splashscreen.xml parser + layout math (DESIGN_H = 1024)
js/ui.js            buttons, text wrapping, generic popup (onClose(action))
js/scenes.js        splash / loading / city / error + global.SplashArt export
js/explorer.js      asset explorer page logic (fetch-based against
                    api/assets.php — see "Asset explorer" below)
```

### Scene-manager invariant (caused a real user-facing bug — keep it)

`G.scene` only switches when the fade **completes**; during a fade the
*fade target* is the logically-current scene. Scenes must never
re-request their own transition from `update()` — use a **fired-once
guard** (the loading scene's `transitioned` flag). The 2026-10-12.2 bug:
during the 0.45 s exit fade the loading scene's `update()` re-fired
`setScene('city')` + `playSfx('10_next_segment.wav')` **every frame** →
donut spun forever and that SFX was requested ~60×/sec (718× over 800
frames in the negative control). Both halves are fixed in
`boot.js` (`G.setScene` treats the fade target as current, ignores
redundant switches) and `scenes.js` (fired-once flag).
`tools/smoke-scene.cjs` is the regression harness for exactly this.

### Splash layout model (validated by Python compositing the real art)

- Ruleset picked by **closest aspect ratio** of the 11 in the XML.
- Background crop window is **left-anchored** (`single_edge edge=right` =
  left edge stays, right edge cut). `keep_center moving_edges=vertical`
  applies when the screen is wider than 4:1.
- Graphics placed top-left at `offset × (W,H)`; scale 1 = the medium pack's
  native pixels; the finger offset is **negative** (enters from off-screen
  left).
- The 4096×1024 cityscape strip only has art at **x 0–2052** (right half +
  bottom 128 px transparent); the transparent margin is filled with a
  sky→field gradient sampled from the art (fallbacks sky ≈ `0x23a1f3`,
  field ≈ `0x45a34d`). The visible seam at ~80 % width is a **known,
  accepted** compromise.
- XML names graphics mixed-case (`Splash_Homer.rgb`) vs lowercase pack
  files (`splash_homer.rgb`) — resolved by **case-insensitive** origin
  lookup in both `assets.js` and `splashlayout.js`.
- Only the "game class" entries (medium splash, large UI chrome) carry a
  pack `origin`; every other resolution variant is origin-less and grouped
  via manifest `family`/`resClass`. The smoke tests assert
  `byOrigin` still resolves to the game class — don't break that.

### Audio mapping

tap → `01_general_button`; tap-to-start → `mainmusic` (40.6 s
theme, one-shot); loading done → `10_next_segment` + `bgloop`
(55.0 s loop); popups → `17_diag_panel_open` / `18_diag_panel_close`.
(Mute all with `M`; Space/Enter taps center.)

Call sites name a sound by stem or `.wav` and `AudioMixer.fileUrl()` decides
the extension, so the corpus can change container without touching the 12
places that play a sound (currently `.m4a`).

**Why the SFX are not `HTMLAudioElement` any more (2026-11-03).** A brand-new
`<audio>` element that has not buffered the file starts output whenever its
decoder gets round to it, and the front of a 0.4 s tap sound is what goes
missing. The tell was the user's report that the same file played fine with
**loop** ticked — by then the file is buffered. Waiting for `canplay` and
rewinding to 0 before `play()` (the first fix) helped but was not enough: the
element's start time is still not the app's to control, and two taps of the
same sound cannot overlap. So the short sounds are fetched once, decoded to an
`AudioBuffer`, and replayed from that with `BufferSource.start(0, offset)` —
sample-exact, overlap-safe — and `boot.js` warms `AudioMixer.UI_SFX` on the
first gesture so even the first tap of a session is exact. Long music stays on
`<audio>`, where progressive buffering is the point. `tools/convert_audio_pcm.py
--format aac` (a quarter of the bytes to fetch) is what made the element
fallback good enough to keep.

### City screen

Deliberate **honest placeholder**: live city content is runtime DLC (see
below) and is not in the APK, so the hub demos the extracted material —
16-language live switcher, About popup, error-screen demo, Restart using
the real `gen_confirmquitgame*` strings, sound toggle, and the "Asset
explorer" button (anchor-click to open in a new tab — `window.open` with a
relative URL can be blocked, and anchors keep it working from `file://`).

## Asset explorer (`web/assets-explorer.php`)

Separate page (not a canvas scene), **the only page that requires the PHP
server**: `assets-explorer.php` renders the header counts + the ~220 core
(non-DLC) manifest entries from `web/api/assets.sqlite` (inlined as
`window.MANIFEST` for the Motion tab / i18n), and `js/explorer.js` sends
every grid / search / variant / strings / data query to
`web/api/assets.php` (`?op=counts|list|asset|variants|strings|data|core|
meta|languages|original`; also runnable under the CLI for the smoke harness;
`ASSETS_DB` env overrides the DB path; `op=original` streams the kept
pre-conversion IMA ADPCM WAV from gitignored `var/audio-adpcm/` as an
attachment — it takes the *playable* path (`.wav` or `.m4a`) and maps it back
to the original `.wav` name; the DB is its allow-list, and `op=asset`
advertises it as `entry.original`). The DB is (re)built with
`php tools/build_assets_db.php` — a streaming brace-scanner over
`assets/manifest-parts/*.js` (~3.56M entries, ~20 min, DB ≈ 1.7 GB,
gitignored). **Re-run it after anything renames or re-stamps a manifest
path** (e.g. `tools/convert_audio_pcm.py --format aac`), or the audio board
and every audio deep link go stale. Grid paging is 240 tiles + "Load more"; search is a DB-side
`LIKE` over `(path || origin || family || res_class || kind)` mirroring the
old client-side haystack; the anim/DLC drill-downs use DB-side group tables
(`anim_group`/`anim_char`, `dlc_group`/`dlc_fam`) that replicate the old
representative-entry ranking via window functions. `assets-explorer.html`
survives as a redirect stub preserving `?path=` deep links. Shared DB
helpers live in `web/api/assets-db.php`. **11 tabs**: All / Images / Audio
/ Movies / Animations / Fonts / Strings / Data / Android shell / Motion /
DLC.

**Page scripts speak `window.`, never bare `global`.** Every module in
`web/js` is `(function (global) { … })(window)`, so inside them `global` is a
parameter; `js/explorer.js` alone is a plain `(function () { … })()` and must
use `window.` (as it does for `EXPLORER_API` / `WEBDATA`). Bare `global` is
undefined in a browser but defined in Node, so it fails only in the page — the
audio detail pane went blank that way (`global.AudioMixer` threw after the pane
was cleared, before anything was appended) while both harnesses passed.
`tools/smoke-explorer-dom.cjs` now `delete`s `globalThis.global` before loading
the page's scripts so the mistake throws under test as it does in Chrome.

**The API owes the page pure JSON — that contract is what broke the audio
pane.** The audio detail is the only panel whose `op=asset` call touches the
pre-conversion tree in gitignored `var/audio-adpcm/`, i.e. *outside* the
document root; a pool that sets `open_basedir` to the docroot answers the
`realpath()` / `is_file()` / `filesize()` there with an `E_WARNING`, and with
`display_errors` on that text is printed ahead of the body — `r.json()` throws,
and only audio entries lose their pane. So `assets.php` opens an output buffer
at its first line and `clean_stray_output()` discards (into `error_log`)
anything that escapes before a body — JSON or WAV bytes; `original_wav()`
`@`-suppresses every probe and treats any failure as "no original kept", never
"no pane"; and `op=meta` reports `originals: {dir, readable}` so a missing
*⬇ original IMA ADPCM* link explains itself. `tools/smoke-explorer-dom.cjs`
enforces it (see Tests below).

Key mechanisms (in `js/explorer.js`):

- `cat_of(entry)` (in `tools/build_assets_db.php`) assigns each entry's tab
  (`assets.cat`) — `dlc/` paths → DLC tab **except** videos (→ Movies) and
  anims (→ Animations); `os == android` → Android. `api/assets.php` filters
  grids/counts on it.
- **Variant switcher** (`appendVariants` → `op=variants`): for APK content,
  same-`family` other resolution classes + self; for **DLC** entries, every
  *other copy of that exact base filename* (any tier/revision) — this fixed
  the bug where one `family` covered hundreds of files and a menu image
  rendered a row of **3,560 buttons**. Buttons are labeled
  `tier · r<rev> · W×H`. Data files (`xml`/`bsv3`) got a variant row too
  (`detailData` previously had none).
- **Drill-down pattern** (two tabs, DB-side grouping tables + shared
  `#browser`/`#crumb` DOM — breadcrumb lives *outside* `#grid` so
  `markSelected()` only touches tiles):
  - **Animations**: character = first underscore-separated segment of the
    frame filename (`edna_back_walk_f0.png` → Edna) — grouped into
    `anim_char`/`anim_group` at index time. Page 1 = 123 character tiles
    (thumb, falling back to the first frame when no thumb exists); click →
    that character's distinct animations from `anim_group` (one row per
    animation, best tier/thumb/revision picked by SQL window functions).
  - **DLC**: page 1 = the 2,378 event families from `dlc_fam` (representative
    image + asset/pack counts, paged); click → that family's distinct files
    from `dlc_group`, tiers and revisions collapsed.
  - **Representative-entry ranking** (now SQL-side, mirrors the old
    `repCmp`): highest `tier_rank` → has thumb → newest revision (NULL
    counts as newest, 1073741824) → path order. `CLASS_RANK`: small 0 …
    iphone 0, ipad 1, retina 2, ipad3 3, 25/50/100 numeric.
  - **Search bypasses grouping** (flat LIKE list of matches, DB-side);
    switching tabs resets to the top level (`state.animChar` /
    `state.dlcFam` = null).
- **Animation player**: per-frame `setTimeout` chain at the recorded bcell
  delays, play/pause/loop/frame-counter, checkerboard stage. **No
  autoplay** — module-level `animTimer` + `stopAnim()` from `renderDetail`
  (autoplay would hang the Node smoke suites).
- Video player pauses on selection/tab change (`stopVideo()`).
- Manifest entry shape to know: `{path, type, origin?, family?, resClass?,
  anchor?, thumb?, premul?, audio_format?, codec?, dlc?: {pack, season,
  tier, revision, url}, char?, animation?, frames?, w?, h?, duration_s?,
  vcodec?, acodec?, dataText?}`. `manifest.js` is minified 2-line
  `window.MANIFEST = …` — load in Node via `global.window={}; require(…)`.

## Extraction pipeline (`tools/extract_assets.py`)

Pure-stdlib Python; reads packs **in-memory from the APK zip** (~11 s for a
plain run). Key design points:

- **Idempotent + additive**: a plain run wipes and rebuilds each non-DLC
  output subdir (so removed variants never go stale); `dlc/` is never in
  the wipe list — a plain run re-merges the previous run's `dlc/` manifest
  entries whose files still exist. Passing `--dlc` for a pack re-wipes just
  that pack's dir.
- `--dlc` spec (repeatable): `{"file", "url", "pack"?, "family"?, "tier"?,
  "season"?, "revision"?}`. Season/tier/revision are derived from the URL
  (`/<season>/<name>-<tier>-r<revision>.zip`) unless overridden. `pack`/
  `family` overrides exist because 7z-bundle sources name the *bundle*, not
  the pack.
- **Per-file error isolation**: each DLC file decodes inside try/except —
  a corrupt/unrecognized file is stored as raw data with a `decode_error`
  note + console warning instead of killing a multi-hour batch (nothing in
  the current archive triggers it).
- Emits `manifest.json` (human-readable) + `manifest.js`, `webdata.js`,
  ~192 px box-downsampled thumbnails for `.rgb`-derived images >256 px
  (pure-Python downsample; Android icons and small frames have no thumbs by
  design — tests must account for that).

`tools/run_dlc_batch.py`: scans directories of extracted pack zips, derives
one `--dlc` spec per zip from the CDN filename
(`<family>[-<tier>][-<lang>]-v<season>[-r<rev>]`), runs the pipeline
**exactly once** with all of them. `--skip`/`--prefix` filter by name
substring, `--dry-run` lists specs. Movie families are per-language
(`movie-intro-de`, …) with English keeping the plain name, so the variant
switcher groups the 4 device tiers within a language.

Batch gotchas learned the hard way: a 216-pack run exceeded the 10-minute
foreground shell timeout → run big batches **in the background** (or split
with `--prefix`); an orphaned concurrent batch caused 3 missing manifest
entries (lost-update race) — never run two pipeline invocations at once.

## Tests (all headless — the project's verification standard)

| suite | what it proves |
|---|---|
| `tools/smoke-scene.cjs` | real boot→splash→loading→city at simulated 60 fps (DOM/Image/Audio/rAF stubs, real PNG IHDR dims, Audio stub logs every element; needs a bigger heap than the ~4 GB node default — run `node --max-old-space-size=12288 tools/smoke-scene.cjs`, OOMs otherwise with or without local changes): reaches city in finite frames, every audio file requested exactly once. Accepts an optional web-dir arg (used for negative controls: run the same harness against a copy with the old buggy code — it reproduced the 718-request spam). |
| `tools/smoke-explorer.cjs` | inventory integrity: every manifest path on disk (including every audio entry's file), thumbs present, `byOrigin` → game class, variant families complete, anim cells/frames consistency + frame files + sane delays, video metadata, every audio file browser-playable (AAC-in-MP4 with `moov` before `mdat`, or PCM/float WAV) with `codec` and `duration_s` agreeing with the container, DLC tagging, origin-namespace checks scoped to APK entries. |
| `tools/smoke-explorer-dom.cjs` | drives the **real** `explorer.js` in a minimal DOM against the **real** `assets.sqlite` — the `fetch()` stub shells out to `api/assets.php` via the PHP CLI (`ASSETS_DB` override, and now also serves `assets/…` file bodies for the buffer engine) and expected numbers come from the DB via `node:sqlite`. **Runs itself twice, once per audio engine** (`AUDIO_ENGINE=element|buffer`): the `buffer` run installs a stub `AudioContext` whose `decodeAudioData` probes the genuine `.m4a` with ffprobe, which is the path a real browser takes — without it the harness could only ever see the `HTMLAudioElement` fallback, so a buffer-engine fault (the one that blanked the audio pane) was invisible. It asserts all five audio tiles stay on the buffer engine, that a cold click reports `start 0.000 s` and a buffer covering the clip, and that the source starts at offset 0; the `element` run keeps the wait-for-`canplay`-and-rewind test. Renders every tab, checks tab counts vs the DB, pages the grid + Load more, both drill-downs end-to-end (incl. breadcrumb back), a **stratified** tile sample (video/audio/font/strings/i18n/data samples, the audio panel's playable + original-ADPCM download links, the player's engine/start-position readout, splash variant switch, multi-pack DLC files, animation drill-down + search), motion canvases, search, `op=asset` per sampled DLC pack, and — the regression test for the blank audio pane — that `op=asset` for an audio path stays **pure JSON with no warning text** under `-d open_basedir=<web> -d display_errors=1`. It also `delete`s `globalThis.global` before loading the page's scripts: Node's bare `global` does not exist in a browser, and that single difference hid a `ReferenceError` that blanked the audio pane in the real page (see *Page scripts speak `window.`* above). |

The DOM stub needs the usual gotchas covered: `getElementsByTagName`,
`querySelector` class selectors, text nodes without `children`, media
element methods (`load`, `pause`, `removeAttribute`).

## Content sources & network facts

**Fan infrastructure** (the APK's real runtime targets):

- `https://game.pjtsto.com` — authoritative game server. Injected from
  **classes.dex** (Java layer, `https://%s/%s/%s` URL template), not the
  engine. Root answers "OK" (2 B); unknown endpoints → JSON 404.
- `https://cdn.projectspringfield.com:443/static/` — hardcoded in all four
  `libscorpio{,-neon}.so` binaries. **nginx with autoindex ON → the whole
  tree is anonymously enumerable** (no login; only *which packs are
  current* is negotiated in-session with the game server).
- Engine DLC paths: `/dlc/index` (master index, `DLCIndexTask`),
  `/dlc/movie-intro-*`. The binary's literal
  `DLCIndex-v4-69-5-412AA04C483EBCA5.zip` is a stale compile-time fallback.
- EA-original dead plumbing still in the binary (dead in the fan build):
  Nimble SDK (`app_version_check_finished` up-to-date gate),
  `auth.tnt-ea.com`, `nucleus.tnt-ea.com`, `account.origin.com`, Origin
  friends endpoint, help/tos.ea.com, `http://notdefined/` placeholder slot,
  telemetry protobufs; Android SDK: EAMobile director, MS App Center /
  OneCollector, Firebase, fb.gg.
- **Fan server runs a single-event game**: of the 5,146 files in the v4.69
  master index only **75 are hosted** (all THOH2014-world related:
  `4_11_THOH2014_D4IR9TM9OCKH/`, `HalloweenWater/`, `SeasonFall/`,
  `HalloweenNight/`, `Main/`, `splash_THOH2014/`). The index references 320
  CDN dirs; `dlc/` and `outputs/` are the fan's own admin dirs. THOH2014
  (Treehouse of Horror XXV) ran **2026-10-11 → 2026-11-16**, composed of
  SeasonFall + HalloweenWater + HalloweenNight with act timegates; the CDN
  was (re)populated 2026-10-12. The 42 MB `THOH2014Game-100` is the only
  real in-game art on the fan CDN.
- **Base-city art is NOT indexed DLC at all**: the index lists core packs
  `3_0_30:game-{25,50,100}-v3_0_30-r157326-B8353263.zip` but there is no
  `3_0_30/` dir on the fan CDN — that content only exists in the
  archive.org preservation set.
- Signature verification stripped: main-list `IndexFileSig` replaced with
  the literal string "You should patch the APK/IPA to bypass this!"
  (TutorialPackages keeps real 96-hex sigs).
- Unexplained: 120 MB `tho2104.7z` at the CDN root — referenced by no index
  or ledger, never downloaded (needs user approval).

**archive.org `tsto-cdn-content`** — a pre-shutdown (Jan 2025) preservation
of **EA's original CDN**: 510 `.7z` bundles / 38.5 GB in `cdn/`, one per
original content-version dir, `1_0_4` (2012) → `4_69_*`/`5_0` (2025), every
event/patch/takedown/tie-in/promo/language pack/movie — a superset of
`v469-packages.json` (dir names match verbatim). Top level also has the
original **4.69.5 iOS .ipa + Android NA/ROW .apk** (the fan APK is a
re-pointed build of that exact binary), final splash/technical-difficulties
art, and a torrent.

What's local (user-downloaded, do not delete):

| bundle | contents | status |
|---|---|---|
| `cdn/1_0_4.7z` (4.7 MB) | 12 CJK fontcache zips (two generations) | inspected; undecodable → skipped |
| `cdn/1_1_35.7z` (413 MB) | 112 movie packs (4 families × 4 tiers × 7 langs) + 4 fontcache | **all 112 movies decoded** into the viewer |
| `cdn/3_0_30.7z` (192 MB) | 104 zips / 208 files — the core game dir: `game-{25,50,100}`, `menu-{ipad,ipad3,iphone,retina}`, THOH game+menu, backtoschool, hawhaw, librarygame, seasonpremiere, roadrivertiles — each in up to 3 CDN generations (2015 original, `r146180-0D2B882C` EA-final Nov-2024 **trimmed stub**, `r157326-B8353263`/`r272024` fan-era) | **everything decoded** via the batch driver |

CDN-generation note: 3 `librarygame-*-r146180` packs are **empty inside**
(EA stripped them in the takedown generation) — not data loss.

## Native binary notes (for any future Phase 3)

`libscorpio.so` (28 MB) holds **all** game logic (Bight BGCore engine,
GL ES 2 + OpenAL, protobuf to the game server) and has **13,134
unstripped dynamic symbols** — the full class map is readable via
`nm -D | c++filt` (`ScorpioApp`, `ScorpioResources`, the building system,
`DLCIndexTask`/`DLCMasterRedirectTask`/`UnzipDLCPackTask`,
`com.ea.simpsons.ScorpioJNI_*`, `com.bight.android.jni.BGCoreJNIBridge_*`).
The dex layer is pure platform glue (Nimble, Firebase, billing,
`BGActivity`). The game is server-authoritative — multiplayer/IAP/live-ops
cannot be reproduced client-only; a playable city would need the runtime
DLC content (now mostly in hand) plus a from-scratch logic
reimplementation, which was judged out of scope for this build.
