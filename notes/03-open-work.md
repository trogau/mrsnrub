# 03 — Open work & deferred items

Everything below is **parked**. Approval status matters: several items were
explicitly deferred by the user — ask before starting any of them.

## Awaiting user input (2026-10-20): City View animation stall at overview zoom

**Status: fix shipped blind, needs the user's telemetry to close.** The user
reported the City View "unusably slow" with animations ON, worst at zoom
~0.33. Gates were added (viewport gate, blit cap, `ANIM_MIN_PX=64`
readability floor, two-tier filmstrip decode caps — see changelog
2026-10-20.21 → .24) but the root cause was never confirmed, and the
corrected math says only a few dozen buildings are on screen at 0.33, so
per-frame blits cannot explain it. The user will test later.

**User action needed** — hard-refresh city-view (statsbar must end
`v2026-10-20.24`), then at zoom 0.33 paste the full statsbar string
(`mode · fps · avg/max ms · aN/M · v…`) three times:

1. as-is, animation ON, when it crawls;
2. with `?animMax=0` added to the URL (if equally slow, animation is
   exonerated entirely — other features landed on this page that day);
3. sitting still 5–10 s, animation ON — a climbing `M` or trailing `F`
   = filmstrip cells thrashing the shared GL atlas (planned fix then:
   dedicated atlas region for filmstrips).

**Follow-up decisions once the strings are in:**
- Is 0.33 fast now? Pick the lowest zoom that should still animate
  (sets the `ANIM_MIN_PX` default; knob: `?animMinPx=N` /
  `__CV_ANIM_minPx(n)`).
- If slow even with `?animMax=0`: base-renderer regression, not the
  filmstrips — chase mode/fps per render path instead.

## Deferred by explicit user instruction (design ready, just not approved)
### 1. Audio: IMA ADPCM → PCM16 re-encode in the pipeline

**Status: user said "No, leave the audio fix for now."** Still the single
biggest functional gap: all 62 WAVs are IMA ADPCM, which browsers cannot
decode, so **no sound plays anywhere in the web build** (game page swallows
the error silently; the explorer once mislabeled it "(autoplay blocked)").

The fix is fully specified (see `01-binary-formats.md`, Audio section):
decode IMA ADPCM in `tools/extract_assets.py` (1024-byte blocks,
standard IMA/DVI tables, decide nibble order by consecutive-sample MAD),
re-encode as PCM16 RIFF WAV **with the same filenames**, compute duration
from the decoded sample count (the `fact` chunk is slightly off), then
re-run the pipeline, validate all 62 with Python `wave`, add a
PCM-decodability assertion to `smoke-explorer.cjs`, and improve the
explorer's `play()` handler (report the real `error.name`; tolerate
`AbortError` from rapid re-clicks). Touch points: `wav_info()` and the
audio emit section of `extract_assets.py`, `js/audio.js`, `js/explorer.js`.

### 2. `.bsv3` canvas renderer (building animations)

837 building-scene files are in the viewer as raw data only. The format is
fully documented (`01-binary-formats.md`); a canvas renderer (cells are
crops of the building sprite sheets composited per frame, per the ×100
fixed-point positions, with the named anim states) is the natural next
step the project itself flagged ("a canvas renderer is future work").

### 3. Phase 3 — `libscorpio.so` gameplay decompilation

**Never approved.** Would need radare2 or Java + Ghidra installed (neither
present on the old machine; the user has so far declined all installs).
Realistic ceiling even if approved: a representative gameplay slice on a
static city — server-authoritative state, multiplayer and live-ops don't
exist on the client to port. Symbol map + decoder notes are in
`02-architecture-and-decisions.md`.

## Newly discovered (2026-10-20, full-archive decode run)

### `bcell13` 4.x character-animation containers — RESOLVED 2026-10-23

Fully decoded (board task 19): `bcell13` cells carry per-frame external
image names (`<cell>_image_N.rgb` in the same pack), delay, and — the
sprite's own **i16 (x_off, y_off) placement** relative to the character
origin (feet-on-ground), followed by SHADOW/POSITION/INDICATOR/null
overlay layers (2026-10-25 correction: the earlier "first layer is the
sprite" reading was wrong — those floats are the shadow-texture
transform; confirmed against the tsto2rgb writer). `parse_bcell13` in
`tools/extract_assets.py` parses all 14,328 pool cells to exact EOF;
`tools/gen_city_sprites.py chars` renders them (companions harvested on
demand per family pack — the full ~165k companion set is far too big
for the tmpfs pool). Format spec in `01-binary-formats.md`.
`bcell11` (289 pool cells) remains an undecoded lighter variant: same
name + delay preamble, no SHADOW strings — smaller scope than bcell13,
left open deliberately.

## Pending user decisions (downloads / scope)

- **Fan CDN `tho2104.7z`** (120 MB, CDN root) — referenced by no index or
  ledger; could be a manually distributed bundle (possibly containing
  pre-seeded `dlc/` contents). Never opened. Needs explicit approval for
  that one download.
- **`THOH2014Game-100`** (42 MB, the *only* real in-game art pack on the
  fan CDN) — identified as the natural next fan-CDN download in-session but
  never pulled; still needs approval. (Everything from the fan CDN so far
  is the single 25 KB pilot pack `THOHXXXIVBuildDecoMenuFall-iphone`,
  decoded and tagged in the DLC tab.)
- **Terrain-grid codebook (char → 16-bit mask)** — the city-save
  terrain/roadmap grid format is characterized (`01-binary-formats.md`,
  "Terrain & roadmaps": 1 char = 16 tiles, `'G'` = empty, 512×1087 main
  grid), but the actual char→bits mapping is not extracted: no static
  table exists, it is a computed switch inside the still-unlocated
  `RoadsUtil::RoadmapBoolRect` decoder in `libscorpio.so`. A concrete
  search recipe (vtable/typeinfo scan + char-switch scan, cross-check
  against building footprints) is in that note. This is the next RE step
  for the city renderer (Phase 2).
- **More archive.org bundles** — **done 2026-10-21**: all 510 bundles are
  downloaded and every one has been decoded through the asset pipeline
  (3,562,506 manifest entries; reports in `notes/dlc-extraction/`, board
  milestone #12). Remaining scraps live as board tasks: `dlc.7z`'s
  DLCIndex-* history (#14), fontcache glyph atlases (#15), duplicate-pack
  curation (#17). The "user downloads the big files" agreement still
  applies to any future archive.org pulls.

## Nice-to-haves (small, unscoped)

- Prettier character display names in the Animations drill-down (currently
  just the filename prefix with a capitalized first letter — "Comicbookguy").
- The "All" tab still shows all ~14k raw entries flat (by design; it's the
  escape hatch from the grouped tabs).
- Visual spot-checks in a real browser were always left to the user
  (project rule: no browser launching by the assistant). If the user
  reports anything off: splash knobs are in `js/scenes.js` (SplashArt) +
  `js/splashlayout.js` (`DESIGN_H = 1024`); scene transition in
  `js/boot.js` (`G.setScene` / `updateFade`).

## Intentionally out of scope (decided, don't revisit without asking)

- **No playable city** — the APK ships only splash/core baseline; gameplay
  is native C++ + server-authoritative. The city screen stays an honest
  placeholder hub.
- **`ascenderuni.ttf`** (17.8 MB CJK fallback font) deliberately omitted —
  only the four UI faces the screens use are shipped.
- **fontcache** CJK glyph-atlas binaries — no known decoder; skipped.
- **Third-party SDK drawables** in `res/` — not game art; skipped by the
  pipeline.
- The fan CDN's `dlc/` + `outputs/` dirs are the fan project's admin
  content (indexes, ledgers), not game content to decode.

## Housekeeping for the new machine

- Not a git repo — if the user wants versioning, ask; never `git init` or
  commit on your own.
- Keep the project self-contained: APK + `cdn/` bundles + pipeline must
  rebuild everything (`web/assets/` is disposable generated output, ~907 MB
  — safe to delete and regenerate, it is the main bulk if space is tight).
- Scratch under `/tmp/opencode/` is disposable; the `tsto2rgb` reference
  clone is re-creatable from GitHub.
- Served at `https://wp.tail684c.ts.net/mrsnrub/web/` on the old box; on
  the new machine it's just any static server over `web/` (or `file://`).
