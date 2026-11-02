# Phase 2 · M5 — Integration & game UI (the Pixi viewer *is* the game)

Status: **planned** — scope decided by the user 2026-10-29; stages below are
execution-ready. This doc **supersedes** the M5 bullet in
`phase-2-camera-view.md` (promote-into-the-Canvas-shell / link-both) and the
"Decision point: M5" note in its execution notes.

## The decision (2026-10-29, user sign-off)

- **The Pixi viewer is the base game.** `web/viewer/index.html`
  (+ `city-view-pixi.js`) is the game's entry point and the only front-end
  going forward — not a "workbench page" that later gets promoted into
  another shell.
- **The Canvas shell is abandoned as a front-end.** `web/original.html` and
  its modules (`js/boot.js`, `js/scenes.js`, `js/ui.js`,
  `js/splashlayout.js`) are kept only as **porting references** — the same
  way `web/city-view.html` is kept for the renderer. They get no new work;
  `tools/smoke-city-view-dom.cjs` keeps the legacy city page honest.
- **What survives the shell, ported into the viewer:** the splash screen
  (the game's own `splashscreen.xml` layout) and the Homer-donut loading
  screen — repurposed so the donut's progress bar reflects *real* loading of
  the viewer's boot assets — plus the audio mixer, i18n strings, error
  scene, and a corrected "About this build" popup. The shell's placeholder
  hub itself is dropped.
- **The rest of M5 is reproducing the game's UI**: the real chrome from the
  `*Menu*` CDN packs (inventory:
  `mapdump/registration/m4-ui-asset-inventory.md`, 10,168 names / 22
  families), replacing the viewer's workbench toolbar look with the game's
  HUD. Phase 3's "In-game UI assets" candidates 1–5 are absorbed here as
  stages M5.2–M5.6; the phase-3 doc keeps gameplay scope (economy, jobs,
  quests) and the candidate-6 open questions are folded into §Open questions
  below.

## Verified basis (build on this; don't re-derive)

- **Viewer boot** (`web/viewer/city-view-pixi.js`): `loadManifests()` counts
  the two boot textures + two art manifests into the `#assets` bar, then
  sprite PNGs stream in per-pan (loaded/known, in-flight, dead). That counted
  set is exactly what the donut should gate on; a new **boot set** (below)
  formalizes it.
- **Shell pieces to port** (read-only sources): `web/js/scenes.js`
  (splash scene ~L40-110, loading scene ~L120-210 with `10_next_segment.wav`
  → `bgloop.wav` handoff, error scene ~L445-500 with
  `images/technicaldifficulties.png`), `web/js/splashlayout.js` (ruleset →
  crop-window → ratio-policy layout model over the 4096×1024
  `splashscreen.png` strip, DESIGN_H 1024), `web/js/audio.js`
  (HTMLAudioElement mixer — file:// safe, no WebAudio fetch), `web/js/i18n.js`
  (decoded `.btp` → `web/assets/i18n/*.json`, 16 langs), `web/js/ui.js`
  (Canvas2D popup/button lib — reference for behaviour only; the port is
  DOM-over-canvas, matching the viewer's existing chrome).
- **Splash/loading art already local** in `web/assets/images/`:
  `splashscreen.png` (strip), `splash_homer*.png`, `splashfinger*.png`,
  `splashdefault.png`, `loading_donut*.png`, `technicaldifficulties.png`;
  layout XML at `web/assets/data/splashscreen.xml`.
- **UI chrome**: only extracted as DLC-tab files under `web/assets/dlc/`;
  the 2026-10-20 inventory maps them to families (store panels
  `bse_stor_*`, category icons `ico_stor_*`, HUD buttons `ico_hud_*` /
  `ico_mhud_*`, currencies, `indicator_*`, `ico_badge_*`, dialogue panels
  `bse_*dialogue_*`). Code-level RE already in `notes/05`
  (`BGMenuCmds::*`, `HUDHandler`, `OffersData.proto`).

## Stages

Each stage ships behind green smoke suites, `file://` still working, zero
network, viewer cache-buster bumped (`city-view-pixi.js?v=N`), CHANGELOG
discipline kept. Stages are strictly ordered; each is independently demoable.

### M5.0 — Housekeeping: record the decision, flip the entry point (docs + hub)

No engine code.
- Mark `web/original.html` (and the four shell modules) as DEPRECATED in a
  comment and in `AGENTS.md` (new-view-work rule already points at the Pixi
  page; add the shell equivalent). Keep them served as reference.
- Project hub (`web/index.html`): relabel "Game port" → *legacy shell
  (deprecated)* and make **City View (PixiJS)** the "Game (entry point)"
  card at the top.
- Update `planning/README.md` + this doc's status as stages land.

**Done when:** the hub presents the viewer as the game; AGENTS/READMEs say
the shell is reference-only; nothing broke (all pages still open).

### M5.1 — Boot sequence in the viewer: splash → tap → donut (real loading) → town

Port the shell's opening into the viewer as an **overlay layer over `#cv`**
(DOM + the existing CSS conventions, art via `new Image()`), driven by a
small `viewer/boot-sequence.js`:

- **Splash**: `splashscreen.xml` ruleset/crop/ratio model (port
  `splashlayout.js` — it is DOM-free already, reuse near-verbatim).
- **Tap-to-start** gate (also unlocks audio, like the shell's
  pointer-gated `AudioMixer`).
- **Loading scene**: Homer donut (`images/loading_donut.png`) + progress
  bar. Progress = **real counts**, not the shell's fake ramp: a declared
  *boot set* — the two boot textures + two art manifests + the
  `characters.json` manifest + the HUD chrome art from M5.2/M5.3 (stubbed
  to the manifest set until then) — counted down as fetches resolve; dead
  assets tick through but degrade as today.
- Handoff: `10_next_segment.wav` + fade into the world at the existing
  rest camera preset; `bgloop.wav` music in.
- **Error scene** port: `technicaldifficulties.png` + Retry for boot-set
  failures.
- **Modes**: the current toolbar/stats become *workbench mode* (toggle
  persisted in `mrsnrub.cityview.*` localStorage, plus `?workbench=1`);
  default is *game mode* — no toolbar, no statsbar, no debug toggles.

**Done when:** opening `viewer/index.html` gives splash → tap → donut with
honest progress → the town, with music; workbench toggle restores today's
chrome; `?nogl`-style failure path shows the error scene; smoke harnesses
extended to boot the overlay headlessly.

*Split on the board 2026-10-29 (user) into:* **M5.1a** extract the
boot-screen assets from the `cdn/` bundles (boot/loading UI art in the
`menu-*` and related packs, with pack provenance — alongside the
APK-side `web/assets/images` set already in hand); **M5.1b** a simple
web-page tool to view all extracted boot assets (contact sheet, like the
Asset Explorer pattern) so the art can be picked; **M5.1c** the general
wiring of splash/donut/error into the Pixi viewer — *blocked on M5.1a+b
and expected to break down further once the asset set is chosen.*

### M5.2 — UI asset pipeline: promote `*Menu*` chrome to `web/assets/ui/`

(= Phase-3 candidate 1.) Generation step (extend the pipeline, e.g.
`tools/gen_ui_assets.py`): from the `*Menu*` packs pick the **canonical
revision per family** (latest `-r` per tier — see Open questions), collapse
tiers (default `retina`/`100`), dedupe, copy into `web/assets/ui/`, and emit
`web/assets/ui/ui-manifest.json` (name → path, family, states
hl/off/sm/md/lg). Only the families the shipped screens use (a curated
~200–400 files, not all 10,168). Add the **UI category** to the Asset
Explorer from the same manifest.

**Done when:** every file the M5.3–M5.6 screens reference resolves from a
stable `web/assets/ui/…` URL and browses in the Explorer; `web/assets/` is
touched only by the pipeline tool.

### M5.3 — HUD chrome: the game's top bar over the world

DOM overlay (`pointer-events: none` on the layer, `auto` on controls — the
map keeps every click outside the chrome):

- **Currency bar**: cash + donut counters using `ico_stor_money_*` /
  currency art, game-styled panel, values from a local placeholder
  `GameState` (Phase 3 will feed it; M5 only needs it live-updatable).
- **Buttons**: task book (`ico_hud_taskbook`), settings cog
  (`but_genr_*`/cog art); real hover/press art states + button SFX via the
  ported mixer.
- Game-like insets so chrome never covers the town centre; the rest/preset
  buttons move to a game-styled bottom strip (keep Full/Ocean under
  workbench).

**Done when:** the resting town screen reads like the game's city screen;
every control has the game's art + sound; toggling workbench mode does not
disturb the HUD.

### M5.4 — Dialogue boxes & popups on the `.btp` strings

(= Phase-3 candidate 3.) Port the shell's popups as a small viewer dialog
layer: panels from `bse_goddialogue_*` (sm/md/lg/xl by viewport class),
body strings through `js/i18n.js`. Ship: **About this build** — now the
*truth* (the city, 5,261 buildings and characters are locally extracted and
playable — no more "no city to play in this build" — the original
`phase-2-camera-view.md` acceptance item), **Restart/quit confirm**,
**Settings** (sound, language cycle — replacing the hub's Language button),
**Error** dialog body.

**Done when:** popups match the game's panel style, follow the language
cycle, and the About text tells the truth in all 16 languages that ship the
keys used.

### M5.5 — World-space UI: status indicators & job badges

(= Phase-3 candidate 5.) Pixi layer in the scene pool (depth-sorted with
buildings): `indicator_*` icons over buildings (ready / needs-harvest /
vandalism / weeds) driven by the decoded save's building fields where they
exist, and `ico_badge_*` states on the (workbench) task list. Data-light:
presentation + a `WorldUI.setIndicator(instanceId, kind)` API; Phase 3's
economy drives it later.

**Done when:** indicators render at the right screen scale/anchor at every
zoom, cull with their buildings, and a harness counts them like the other
scene layers.

### M5.6 — (Stretch) Store / build-menu skin

(= Phase-3 candidate 4, offline only.) `StoreRedesignMenu-*` panels +
`ico_stor_*` category grid as the **build menu** shell; catalogue rows from
the `OfferItem` shapes in `OffersData.proto` (`notes/05`) rendered from the
extracted building art; **no MTX, no purchases, no server** — selecting an
entry just centres the camera on that building type. This is the natural
on-ramp into Phase 3's build flow.

**Done when:** the menu opens from the HUD with real skin, lists catalogue
rows with correct icons, and centring works; clearly labelled offline demo
where a live game would transact.

## Acceptance criteria (definition of done for M5)

1. A first visit to `web/viewer/index.html` plays: splash → tap → donut
   (real progress) → the town with game HUD chrome, music + SFX — entirely
   from `file://`, zero network.
2. Game mode shows no workbench chrome; one toggle brings it all back
   (toggles, stats, presets, verdict tools) for the RE work that continues.
3. All shipped screens use real game art + `.btp` strings; the About popup
   is true; the legacy shell is reachable but clearly labelled deprecated.
4. Smoke suites green (existing harnesses + new boot/HUD ones), `web/assets/`
   only touched by the pipeline, CHANGELOG + cache-busters kept current.

## Out of scope

- Gameplay logic: economy, jobs, quests, construction rules → Phase 3
  (`phase-3-playable-core.md`). M5 ships the *chrome*, wired to placeholders.
- Any server dependence or MTX of any kind.
- Playing `.bsv3` menu scenes as live layouts (ties to the deferred bsv3
  canvas renderer, `notes/03` §2) — M5 uses the flattened PNG chrome.

## Open questions (need a user call before/at the stage that needs them)

1. **Canonical pack revision**: latest `-r` per family assumed (M5.2) — OK?
2. **Tier**: `retina`/`100` for web (M5.2) — OK?
3. **Workbench escape hatch**: keyboard shortcut + `?workbench=1` (M5.1
   default), or a visible-but-subtle tab?
4. Keep the preset strip (Rest/Springfield Downs/Downtown) in game mode,
   or presets-only-at-boot?

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| DOM overlay steals map input (pan/zoom/click-select) | overlay root `pointer-events:none`; controls opt in; harness clicks the map through the overlay |
| `file://` breaks new subsystems (fetch/WebAudio) | textures via `new Image()` (proven), audio via `js/audio.js` (HTMLAudioElement), boot manifest inlined like `map-explorer-data.js` if fetch fails |
| Boot set grows → donut lies again | progress is *counted from the declared set*; harness asserts bar monotonicity and completion only when all resolve/reject |
| Menu art at wrong tier/revision looks off vs. the game screenshots | M5.2 is manifest-driven — flipping tier/revision is a re-run, not a re-wire; keep both in the manifest |
| Workbench mode bit-rot (nobody tests the hidden chrome) | workbench toggle is the *default for the smoke harness*, game mode is asserted separately |
| Overlay/DOM layer drifts from Pixi canvas on resize/DPR | single layout pass on resize (same pattern as the existing toolbar), assertions in the boot harness |

## Session-start checklist (for the executing session)

- Read: this doc; `phase-2-camera-view.md` (M0–M4 status + agreements);
  `notes/00` agreements; `notes/05` (UI RE); the inventory
  `mapdump/registration/m4-ui-asset-inventory.md`; the shell sources listed
  in §Verified basis.
- Working agreements unchanged: user starts/stops servers; no assistant
  browser launches (screenshot asks are specific); no network without
  asking; `web/assets/` generated-only; evidence files →
  `mapdump/registration/` with `m4-`/`m5-` prefixes; CHANGELOG counter;
  viewer `?v=` bump with every viewer JS change; not a git repo — no commit
  commands.
- Per stage: pick it, do it, run the suites, update this doc's stage status
  line, CHANGELOG entry, stop for the next session if context runs low.

## References

- `phase-2-camera-view.md` — M0–M4 history, camera/terrain/sprite basis
- `phase-3-playable-core.md` — remaining gameplay scope + UI inventory summary
- `mapdump/registration/m4-ui-asset-inventory.md` — the 10,168-name UI inventory
- `web/js/scenes.js`, `splashlayout.js`, `audio.js`, `i18n.js`, `ui.js` —
  porting references (deprecated shell)
- `web/assets/data/splashscreen.xml`, `web/assets/images/*` — splash/loading art
- `notes/05` — `BGMenuCmds::*`, `HUDHandler`, `OffersData.proto`
- `web/viewer/README.md` — renderer architecture + console probes

## Stage status

- M5.0 — not started
- M5.1 — **M5.1a + M5.1b done 2026-10-29**: `tools/extract_boot_assets.py`
  extracts the boot set from `cdn/` into `web/assets/boot/` and catalogues
  the APK-side set plus the per-DLC splash screens from `web/assets/dlc/`
  (1356 files: splash=144, dlcsplash=840, loading=24, error=14, extras=240,
  audio=2, data=92; 440 CDN + 76 APK + 840 DLC, pack provenance in
  `boot-manifest.json`), and `web/boot-explorer.html` (data via
  `tools/gen_boot_explorer.py`) is the contact sheet for picking — with a
  DLC Splash tab and one source button per DLC pack (93). **M5.1c blocked
  on the art selection** — pick per-slot winners in the boot explorer, then
  wire splash/donut/error into the Pixi viewer.
- M5.2 — not started
- M5.3 — not started
- M5.4 — not started
- M5.5 — not started
- M5.6 — not started (stretch)
