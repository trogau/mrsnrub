# Phase 3 — Playable core (offline)

Status: **stub** (seeded 2026-10-20 with the in-game UI scope only; the rest
of the phase doc is still to be written). Predecessor: Phase 2 (City
renderer). Scope decisions here need user sign-off before any milestone is
committed.

## Goal (placeholder — to be written)

Offline playable slice: jobs, construction, quests, economy on top of the
Phase 2 city view, without a live server (the "offline-standalone" end goal
from the 2026-10-13/14 decisions). Character movement leads in `notes/06`
§6; the server-API ground truth is `server/` + `notes/04`.

## In-game UI assets (scoped 2026-10-20 — inventoried, not yet milestone'd)

The in-game interface art has never been milestone-scoped anywhere. It was
inventoried on 2026-10-20; **this is the spot where the work lands.**

### What exists (the verified basis — build on this, don't re-derive)

- **Full inventory**: `mapdump/registration/m4-ui-asset-inventory.md` —
  ~10,200 unique UI file names deduped across revisions/tiers from every
  `*Menu-*` CDN pack under `web/assets/dlc/`, classified into 22 element
  families with a pack-role table.
- **Pack taxonomy**: UI lives in `*Menu*` packs, not `*Game*`/`*BuildDeco*`:
  `menu-<tier>-r<rev>` (core menu: indicators, level badges, sidebar
  portraits, premium crops), `StoreRedesignMenu-*` (the whole shop skin:
  `bse_stor_2panel_*` panels, category/subcategory tabs with hl/off states,
  circle buttons, currency arrows), `tutorialmenu-*` (core UI variants incl.
  the full `ico_stor_*` store-category icon set), `promotionsmenu-*` /
  `NonWinterMenu-*` (promo/season), ~200 `<Event>Menu-*` theme packs
  (event store icons, `ico_cur_*` currencies in lg/md/sm, prize tracks,
  `ico_mhud_*` HUD tabs). `menuatlas*`/`menuoffsets*`/`gamecommon-*` are
  per-character atlases/offsets/shadows — not interface art.
- **APK-side UI** in `web/assets/images/`: splash/loading/screens, help
  circles, menu corners, 16 language flags, launcher icons.
- **Strings**: decoded `.btp` tables in `web/assets/i18n/*.json` (16 langs).
- **Element families ready to use** (counts from the inventory): store
  chrome + category icons, HUD buttons + show/hide layer toggles, generic
  controls (`but_genr_hubtab_*`, scroll arrows, `+`/`−`, close/cog/info),
  currencies, 202 build/harvest indicators, job badges, daily-task hub +
  quest tracker, prize-wheel icons, dialogue boxes (`bse_goddialogue_*`,
  `bse_robotdialogue_*`, `bse_hawkingdialogue_*` in sm/md/lg/xl), sidebar /
  unlock / reminder portraits, character-set strips, level badges.
- **Code-level RE of the UI system is already done** (`notes/05`):
  `BGMenuCmds::*` (62 classes — `Button`/`TextButton`, menu scenes, the
  `.bsv3` ancestor), `BGMenuParserCommands::*` XML menu parser,
  `HUDHandler`, and store offers via `OffersData.proto` (`OfferItem`
  MTX/PREMIUM/CHARACTER/BUILDING/CONSUMABLE).

### Candidate work (NOT yet milestones — needs user scoping)

> **2026-10-29 update:** with the M5 rewrite (the Pixi viewer is the game —
> [`phase-2-m5-integration.md`](phase-2-m5-integration.md)), candidates 1–5
> are absorbed there as stages M5.2–M5.6 (1→M5.2, 2→M5.3, 3→M5.4, 5→M5.5,
> 4→M5.6 stretch) and the open questions in item 6 are folded into that
> doc's §Open questions. This phase keeps the gameplay scope: economy, jobs,
> quests, construction rules. The inventory/basis below stays the reference.

1. **Menu asset pipeline**: promote `*Menu*` pack images into the extract
   pipeline / Asset Explorer as a browsable "UI" category (today they exist
   only as DLC-tab files; tier dedupe + revision collapse like the
   Animations tab does for characters).
2. **UI skin layer in the web shell**: theme the placeholder city-screen
   hub (M5-adjacent) with real chrome — top bar with currencies
   (`ico_stor_money_*`, donuts), task-book button (`ico_hud_taskbook`),
   settings/cog, build-menu category grid from `StoreRedesignMenu-*`.
3. **Dialogue boxes**: render `bse_*dialogue_*` panels behind the existing
   `.btp` string tables (sm/md/lg/xl per screen-size class).
4. **Store screen**: shop skin + `ico_stor_*` categories + `OfferItem`
   shapes from `OffersData.proto` (offline catalogue only; no MTX).
5. **Status indicators + badges**: put the 202 `indicator_*` icons on
   buildings in City View (ready/needs-harvest/vandalism/weeds) and the
   `ico_badge_*` job states on the task list.
6. **Open questions**: which revision of each pack is canonical (latest
   `-r` per tier?); iPhone-vs-retina tier choice for web (probably `retina`
   = `100`); whether `.bsv3` menu-scene files should drive layouts directly
   (ties into the deferred `.bsv3` canvas renderer, `notes/03` §2).

## Milestones

None yet — to be written when the phase doc is fleshed out. The UI candidate
work above should become M-items only after the user scopes the phase.
