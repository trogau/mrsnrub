# 00 — Orientation

## What this project is

An academic front-end port of **The Simpsons: Tapped Out** (EA, 2012–2025).
The source is `Springfield-V08.apk` — **a fan-made build** (package
`com.ea.game.simpsons4_row.Springfield`, client v4.70.5, Bight BGCore C++
engine) that talks to the fan project's servers, not EA's. Two deliverables
exist:

1. **`web/`** — a faithful vanilla-JS/Canvas port of the game's front-end
   (splash → loading → city hub → error screen), no dependencies, no build
   step, works from `file://`.
2. **`web/assets-explorer.php`** — a browsable viewer of **everything
   extracted**: ~3.56M manifest entries (3,562,466 deduped) from the APK
   plus every decoded CDN/archives.org DLC pack, served from a SQLite
   index (`web/api/assets.sqlite`, built by `tools/build_assets_db.php`;
   the only page that needs the PHP server) — images, 23,734 character
   animation frames (123 characters), 3,148 movies in 7 languages, the
   DLC drill-downs (2,378 event families, 21,885 packs) and DB-backed
   search. `assets-explorer.html` is now a redirect stub for old links.

Current verified state (2026-10-30): the headless smoke suites pass
(incl. `smoke-explorer-dom.cjs` against the real assets.sqlite); everything
is regenerable from the APK + local `cdn/` bundles with no downloads.

## Quick start

```sh
# Play the web build
cd web && python3 -m http.server 8080     # → http://localhost:8080/
# On the serving box the web/ tree is published at the project base URL
# http://dave-latitude-5550.tailc953b.ts.net:8081/mrsnrub/ (PHP enabled;
# pages hang off …/mrsnrub/web/<page>.html — give the user full URLs).

# Progress dashboard (scan data refresh)
python3 tools/progress_scan.py --note "what changed"   # → web/api/progress.sqlite

# Tests (headless Node, no browser — this is THE way to verify)
node tools/smoke-scene.cjs           # game flow: boot→splash→loading→city
node tools/smoke-explorer.cjs        # asset inventory integrity
node tools/smoke-explorer-dom.cjs    # explorer page, real explorer.js, stub DOM

# Regenerate web/assets from the APK only (~11 s, wipes+rebuilds non-DLC output)
python3 tools/extract_assets.py Springfield-V08.apk

# Re-run the whole local CDN archive through the pipeline (no downloads)
7z x -y -o/tmp/opencode/tsto/3_0_30 cdn/3_0_30.7z
7z x -y -o/tmp/opencode/tsto/1_1_35 cdn/1_1_35.7z
python3 tools/run_dlc_batch.py Springfield-V08.apk \
    /tmp/opencode/tsto/3_0_30 /tmp/opencode/tsto/1_1_35 --skip fontcache
```

`web/assets/` is **generated output — never hand-edit** it. Re-run the
pipeline instead. (Exception: the 2026-10-13 manifest dedupe was a one-off
in-place rewrite of `manifest.{json,js}`; the pipeline is now fixed so a
fresh batch run reproduces the deduped result.)

## Project layout (condensed)

```
Springfield-V08.apk        source APK (76.5 MB) — do not delete
tools/extract_assets.py    APK → web/assets pipeline, pure-stdlib Python 3;
                           --dlc '{json}' decodes CDN packs too
tools/run_dlc_batch.py     batch driver for directories of CDN pack zips
tools/dlc_report.py        one DLC season -> standalone HTML inventory report
                           (notes/dlc-extraction/, images referenced from web/)
tools/crawl_cdn.py         rate-limited fan-CDN lister → cdn/catalog.json
tools/smoke-*.cjs          three headless Node test suites
tools/smoke-server.sh      headless curl smoke test of the server-python
                           podman stack: full game boot flow + X-Accel
                           town roundtrip (re-runnable)
cdn/1_0_4.7z, 1_1_35.7z, 3_0_30.7z   user-downloaded archive.org bundles — do not delete
cdn/3_0_30/*.zip           two source zips kept for re-runs
cdn/catalog.json           fan-CDN tree metadata (9 dirs, 60 files, 278.6 MB)
cdn/v469-packages.json     parsed v4.69 master index (5,146 entries)
cdn/file-urls.txt          the 60 fan-CDN file URLs
web/index.html, assets-explorer.php (+ .html stub), css/, js/   the app (see 02)
web/assets/                GENERATED: images/ audio/ fonts/ i18n/ data/
                           dlc/<pack>/ manifest.{json,js} thumbs/
church.rgb                 stray decoded sample from format work
server/                    reference copy of the fan TSTO private server the
                           patched client talks to (C++/evpp, HTTP on :80).
                           Do not modify; API documented in notes/04
server-python/             second server build (upstream
                           al1sant0s/springfield, Django) — self-contained
                           podman stack in server-python/docker/: no host
                           bind mounts (named volumes only), nginx baked in,
                           published 192.168.1.147:8090, login codes via
                           console logs
notes/                     these files
```

## Working agreements with the user

These were stated in-conversation over the project's life and in the global
rules file; a new session must honor them:

- **Academic exercise**; the user acknowledged IP caveats once — no need to
  re-litigate rights, but keep the README's disclaimer stance.
- **Never commit without explicit confirmation** — and this directory is
  **not a git repo**, so never print commit commands.
- **CHANGELOG.md discipline** (global rule): newest-first, `## YYYY-MM-DD`
  header with `.2/.3/.4…` counter for same-day changes, bullet with a **bold
  lead phrase**, plain-language explanation, fixes get their own bullet (or
  `### Fixed` subsection). Update it for every user-visible change.
- **No browser launching** (Chromium/Playwright/etc.) without explicit
  permission — verification is via the headless Node smoke suites plus
  static checks (`node --check`, reading generated output).
- **Never read web-server config** (nginx/vhost/systemd) without asking.
  The user serves the site at `https://wp.tail684c.ts.net/mrsnrub/web/`
  (Tailscale, nginx) and manages services manually — never start/stop/kill
  anything.
- **Fan-CDN etiquette (user-mandated)** for `cdn.projectspringfield.com`:
  at most **one concurrent connection**, **≥10 s between requests**
  (a ≥5 s floor was stated once for multi-request work), **blank
  User-Agent** (verified: the APK contains no literal UA value — the engine
  sends `User-Agent: %s\r\n` with a runtime value; do not re-chase this).
  `tools/crawl_cdn.py` already encodes all of this.
- **Downloads need approval.** The user downloads large bundles themselves
  (they supplied all three archive.org 7z files). Never download from the
  fan CDN beyond what was explicitly authorized; metadata-only crawling is
  fine.
- **Tooltips** use the shared CSS `[data-tip]` pattern (see
  `web/css/app.css`), never `title` attributes.
- Scratch space is `/tmp/opencode/` (may be wiped at any time); anything that
  matters must live in the project. Reference clone of the community
  `tsto2rgb` repo (format ground truth) was at `/tmp/opencode/tsto2rgb/` —
  re-clone from https://github.com/al1sant0s/tsto2rgb if needed.

## Environment expectations for the new machine

- **Python 3.12, stdlib only** — the pipeline deliberately uses no third-party
  packages (no PIL/numpy/wand; there is a pure-Python PNG writer inside
  `extract_assets.py`). This is a design constraint, keep it.
- **Node 22** for the smoke suites.
- **`7z`/`7za`** for the CDN bundles; **ffmpeg optional** (only for movie
  poster frames — the pipeline degrades gracefully to a ▶ glyph without it).
- No Java / radare2 / Ghidra needed (Phase 3 native work not approved).
- Binutils on the old machine **could not disassemble AArch64**
  (`objdump` failed; `readelf`/`nm` work). If native analysis ever starts,
  a hand-rolled ADRP/ADD-imm decoder worked: ADRP test
  `(c & 0xFF000000) == 0x93000000`, immlo `(c>>30)&3`, immhi `(c>>21)&0x7FFFF`;
  ADD-imm `(c & 0x9F000000) in (0x91000000, 0x91400000)`, imm12
  `(c>>10)&0xFFF` (−4096 if bit 31). `libscorpio.so` map: `.rodata`
  vaddr==offset @0x34bbd0, `.text` @0x6e5000 len 0x12d8d04, `.data.rel.ro`
  @0x19d6870.
- After any asset regeneration, the served site needs a **hard refresh**
  (Ctrl+Shift+R) in the user's browser.

## Open questions to check with the user on session start

See `03-open-work.md` — several items are parked awaiting the user's
decision (audio fix, bsv3 renderer, native decompilation, more downloads).
Ask which, if any, to pick up; do not start deferred items unilaterally.
