# Session notes — Springfield web port

Distilled reference for starting a **new session** on this project from a
different machine, without re-deriving anything. Everything here was learned
the hard way in earlier sessions (APK triage, format RE, pipeline, CDN work).

## Read order for a new session

1. **`00-orientation.md`** — what the project is, current state, quick-start
   commands, and the working agreements the user expects (etiquette, scope
   limits, documentation rules).
2. **`01-binary-formats.md`** — the reverse-engineered binary formats (`.rgb`,
   `.btp`, `.bcell`, `.bsv3`, packs, IMA-ADPCM WAVs, MP4, `.time` sidecars,
   indexes). These are verified byte-exact; do not re-derive or
   second-guess them.
3. **`02-architecture-and-decisions.md`** — how the web app, the asset
   explorer and the extraction pipeline are structured, and the invariants
   that must not be broken; plus all facts about the fan CDN / archive.org
   content sources.
4. **`03-open-work.md`** — what is deliberately pending or deferred, with the
   approval status of each item (several were explicitly deferred by the user
   and must not be started unilaterally).
5. **`04-server-api.md`** — the full wire-protocol reference for the fan TSTO
   private server in `server/` (every endpoint, payloads, the single-session
   model, town/currency persistence, SQLite schema, boot sequence). Read it
   whenever work touches game-server behavior; `server/` itself is a
   reference copy — do not modify it.
6. **`planning/`** — the phased roadmap. **Phase 1 (CDN Explorer) is
   live**: `python3 tools/cdn_explorer.py` serves `web/cdn-explorer.html`
   on port 8123 at this machine's Tailscale address (loopback fallback)
   over the three local bundles (`1_0_4`, `1_1_35`,
   `3_0_30`), with all RE findings persisted in `cdn/cdn-explorer.db`
   (start with its `findings` and `formats` tables — they are the
   accumulating RE journal; see `planning/phase-1-cdn-explorer.md` for the
   design and the no-network rule).
7. **Progress tracker** (`web/progress.html`) — the current completeness
   picture in one page (CDN funnel, package coverage vs the 4,869-entry
   v469 index, RE meters, session journal). Meters are computed by
   `python3 tools/progress_scan.py` into `web/api/progress.sqlite` — run
   it at the end of a working session. The **task & decision board** has
   its own page at `tasks/index.html` (same store; edit there, via the
   API, or keep `notes/03` consistent).
8. **`07-progress-board.md`** — the PROCESS guide for the task & decision
   board: what belongs there, entry conventions, approval rules (agents
   never self-approve decisions), how to POST entries, and the
   end-of-session checklist. **Every session that defers work or needs a
   user decision must follow it.**
9. **`08-road-drawer-re.md`** — the definitive RE of the engine's
   `RoadDrawer` (libscorpio.so): the 11-entry UV quad table, the per-cell
   selector decision tree (nibble bits, pass rule, family table with leaf
   addresses), the 4-quadrant-quads draw pass, and what that means for the
   viewer's textured road art. Supersedes the guesses in `notes/06` §10.
10. **`09-road-tiles.md`** — the art side of the same subject: where
    `roadtilesheet.png` comes from (DLC packs and tiers, the winter ice sheet),
    the sheet's diamond lattice (pitch vs box, why box crops show neighbour
    art), the measured content of all 11 cells, the 25 unused cells, the
    Pixi viewer's draw (§6: the 1024² `-100` sheet as UV meshes with the
    engine's own quad tables — the fix for blurry tiles — and the flat-fill
    layer that fixed the thin blue seam lines), and the list of superseded
    guesses still sitting in `terrain.js` comments. §9 now covers
    the **river** half too: `RiverDrawer` shares RoadDrawer's draw body, its
    UV table at `0x3fc320` lands on 11 of the unused water cells, the family
    table is the road table with entries 0/1 exchanged, and the flip is the
    anti-diagonal reflection (re-measured on the water art). That model is
    ported to the Pixi viewer behind the **Water art** toggle. §10 covers
    **road bridges**: the shipped `bridgetop` art, the crossing derive from
    the save, and the game-verified per-cell rule (one 3-lamppost section per
    road cell over water per side, doubled lampposts at the joins, near row
    over the road / far row under it; lamppost positions checked against the
    game screenshot), plus the **Bridge grass** toggle.
11. **`10-boardwalk-analysis.md`** — the boardwalk/pier investigation
    (2026-10-28): `oceanData` is the 4×4-cell codebook at 3 blocks/row
    holding ONLY the two brushes (262 cells under the Squidport,
    OrnatePier, the PirateShip and the marina), the mask-graph pier split,
    the viewer's per-cell art fixes, and why "the promenade is not in the
    save" (notes/01's 2026-10-19 recovery and a later review) was wrong.
12. **`11-ocean-boardwalk-pier.md`** — how the sea, boardwalk and ornate
    pier work end to end as of 2026-10-30: the sea rect (`SEA_TILE`, town
    tiles, shoreline x 0), the brush grid, the frame-origin-on-front-corner
    placement measured against the in-game export (and the two wrong rules
    it replaced), the per-cell state rule, the three draw-order rules
    including the scene "over" pass, and the Road Lab marina-align tool.

 13. **`12-building-animation-wiring.md`** — what makes a baked filmstrip
     actually play: the `behavior` gate in `city-anims.json` and its three
     gamescript authorities, the real task-triggered mechanism
     (`<Job><BuildingAnimation><Controller name=…>` — FlandersHome
     `WindowBreak`, DeathTable `ActiveFastBreak`, …), the 2026-11-02 audit of
     the 65 `0x0303` assets that ship strips but stay static (17 Espionage
     Mode land-variable sequences `_parse_controller` drops, 2 tap verbs with
     no matching anim, 46 buildings with no animation wiring at all), and the
     accounted-for list of v3 assets with no strip.

## Where it's served

The `web/` tree is served at the project **base URL**:

    http://dave-latitude-5550.tailc953b.ts.net:8081/mrsnrub/

so any page is `…/mrsnrub/web/<page>.html` — e.g. the progress dashboard
at `…/mrsnrub/web/progress.html` (its API: `…/web/api/progress.php`) and
the task & decision board at `…/mrsnrub/tasks/index.html`. The project
hub is `…/mrsnrub/web/index.html`; the game port is
`…/mrsnrub/web/original.html`.
Always give the user the full URL when a new page lands.

Also read the project `README.md` (layout, run/test instructions, scope
notes) and skim `CHANGELOG.md` (full history of what landed, newest first).

## What is NOT in these notes

- The full raw session history — that lives in the opencode session database
  (`~/.local/share/opencode/opencode.db`, tables `session_v2` /
  `session_message`; the Springfield sessions are titled "APK game reverse
  engineering and web port" and "Grouping Asset Explorer animations by
  character prefix"). If you have access to the old machine's home directory,
  copy that DB over for the complete record.
- Secrets — the opencode provider config (model + API key) is in
  `~/.config/opencode/opencode.jsonc` on the old machine; copy that file and
  the global rules file `~/.config/opencode/AGENTS.md` to the new machine
  rather than pasting the key anywhere.
