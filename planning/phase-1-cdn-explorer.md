# Phase 1 — CDN Explorer (CDN reverse-engineering workbench)

Status: **in progress** (2026-10-15 session) — scope revised per user: start on
three local bundles only, **no network of any kind** (see Network policy).

## Goal

A **CDN Explorer** web page, *independent of the Asset Explorer*, that indexes
the **local CDN pack bundles** — starting with the three user-downloaded
preservation bundles (`1_0_4.7z`, `1_1_35.7z`, `3_0_30.7z`; the remaining 507
bundles stay on disk, unindexed, until asked) — and provides a workbench for
reverse-engineering the content **one file at a time**. As files are
understood, their findings are recorded in an **SQLite database** so the
knowledge base persists across sessions, and the explorer can browse into
zips/packs (virtual file system), hex-dump, preview, and tag formats directly
from the interface.

This is the project's RE bench: it turns "reverse-engineer one file at a
time" into a repeatable, accumulating workflow.

## Scope

**In:**
- Index of all files in the three in-scope bundles (lazy per-bundle listing
  via `7z l -slt`), with derived family/tier/lang/season/revision/sig from
  pack names and `.time`-sidecar detection.
- SQLite database as the durable store for file metadata **and** RE findings.
- Virtual browsing: open any indexed zip → see entries → open pack `1` (nested
  zip) → see asset files; byte-range reads; hex view.
- Previews of known formats (`.rgb`/`.bcell` → PNG render, `.btp` → JSON,
  text formats → text) reusing the decoders in `tools/extract_assets.py` —
  **without** touching `web/assets/` (no pipeline runs from this tool).
- Findings journal per file/entry: magic notes, format records, decode notes,
  references, decisions; per-file status workflow
  (`unknown → identified → decoded`, plus `skipped`/`error`).
- Format registry (magic bytes → format → decoder reference → notes doc).
- Generation view: all rows of the same base pack name across bundles
  (e.g. `game-100` at original / r146180 / r157326 within `3_0_30`) side by
  side.
- "Send to pipeline": emit the `--dlc` JSON spec for a file so it can later be
  decoded into `web/assets/` by the existing pipeline (the explorer never
  modifies `web/assets/`).
- "Mystery" view: `status=unknown` files grouped by name pattern (family),
  to suggest the next high-value target.

**Deferred (out of this phase — kept for a later pass, no user action yet):**
- Ingesting the fan CDN metadata (`cdn/catalog.json`, 60 files) and the fan
  master index (`cdn/v469-packages.json`, 5,146 entries). **Key fact for that
  pass (verified against the HAR, 2026-10-14/15):** every master-index entry
  is `dir='dlc'` (the index file's *own* location, not a content prefix) plus a
  **colon-prefixed** `file`, e.g.
  `4_6_2r1_XMAS2013_Takedown:BGDLCMenu-ipad3-r65332-590BB3C1.zip` — the colon
  is the dir/filename separator, so `cdn_path = file.split(':', 1)` joined
  with `/`. 314 of 320 index dirs match local bundle dirs verbatim; the 6
  that don't (`Main/`, `SeasonFall/`, `HalloweenWater/`, `HalloweenNight/`,
  `splash_THOH2014/`, `4_70_NewHorizons/`) are the fan-live THOH2014 dirs.
- Indexing the other 507 local bundles (the tool supports it: `--bundles`).
- Bulk anything, any fan-server (game API) interaction.
- The playable city (Phases 2–4).

## Current state / what exists to build on

- `cdn/*.7z` — all 510 archive.org bundles (39 GB) on disk; **in scope for
  indexing: `1_0_4.7z` (4.7 MB), `1_1_35.7z` (413 MB), `3_0_30.7z` (192 MB)**
  — the user-downloaded trio from `notes/02`. Each bundle is one CDN
  content-version *directory*: a flat set of pack zips (+ `.time` sidecars).
  Internal paths are CDN-relative (`1_0_4/fontcache-….zip`). **Measured
  2026-10-14: `7z l -slt` on the 3.9 GB out-of-scope bundle returned 754
  entries in milliseconds** — 7z reads only the archive tail; per-bundle
  scans are cheap, no chunking needed.
- `cdn/catalog.json`, `cdn/v469-packages.json` — fan CDN metadata, **not
  ingested in this phase** (deferred above).
- `tools/extract_assets.py` — pure-stdlib pipeline; contains all verified
  decoders (pack container, `.rgb`, `.btp`, `.bcell`, IMA-ADPCM WAV info,
  MP4 box walk) and a pure-Python PNG writer — **import** these, don't
  rewrite.
- `notes/01-binary-formats.md` — the verified format specs (byte-exact).
- `notes/04-server-api.md` + `server/` — the fan server (bodnjenie14 C++);
  `server/payloads/dlc server.har` records a real first load (1,056 zip URLs
  from EA's original CDN, `…/netstorage/gameasset/direct/simpsons/<dir>/<file>`)
  — ground truth for URL/path structure. (Stretch, deferred: tag files that
  were in that boot capture.)
- Environment: Python 3.14 (stdlib sqlite3 3.46), Node 22, `7z` 26.00.
  **7z 26.00 `-slt` quirk: `Path = …` / `Size = …` fields are at column 0**
  (no indent), and directory entries carry `Attributes = D` — the parser must
  skip those and the archive's own header block. Not a git repo.
  `web/assets/` is generated output — never hand-edit or modify from this
  phase.

## Key concepts

- **CDN file** = a downloadable pack zip, addressable by CDN-relative path
  (`3_0_30/game-100-v3_0_30.zip`). This is the unit the index, the findings,
  and the RE workflow attach to. `.time` sidecars are first-class rows too
  (tagged `is_sidecar`, linked to their parent zip via `sidecar_of`) — they
  are RE targets in their own right.
- **Entry** = a member of a CDN file's virtual file system. Packs are
  two-level: the zip contains `0` (BGrm index) and `1` (a *nested* zip of the
  actual asset files); movie bundles contain other zips. Entries store their
  **full virtual path** (`0`, `1`, `1/images/abe.rgb`) under the zip's files
  row, so findings can attach at any depth with no extra schema.
- **Source** = one local `.7z` bundle. (Future: fan-CDN / index sources —
  deferred.)
- **Naming grammar** (generic peel, right-to-left; `run_dlc_batch.py`'s
  parser is the reference for the season-specific edge cases):
  `<family>[-<tier>][-<lang>][-v<season>][-r<revision>[-<sig>]]` with tiers
  `25/50/100/iphone/ipad/ipad3/retina`, audio tiers `wav/mp3/caf`, lang =
  2 letters (optionally `-Hans`/`-Trad`-style 4-letter modifier), season
  `v\d+_\d+(_\d+)?`, sig = trailing 6–8 uppercase alnum. `_LTD` / `MERGED`
  stay in the family. Unparseable → everything lands in `family`, nothing is
  dropped.

## Architecture

New files only; the only touch to existing code is an **additive import** of
decoder functions from `tools/extract_assets.py`.

```
tools/cdn_explorer.py        THE tool: stdlib-only local server (single file)
cdn/cdn-explorer.db          SQLite database (durable RE knowledge base)
web/cdn-explorer.html        the page (sibling of assets-explorer.html)
web/css/cdn-explorer.css     its stylesheet (own file; copies the shared
                             [data-tip] block from app.css)
web/js/cdn-explorer.js       its logic (vanilla JS, classic script, no modules)
/tmp/opencode/cdn-cache/     disposable local cache for extracted zip members
tools/smoke-cdn-explorer.py  headless smoke suite (Python, stdlib)
```

- **Server**: `python3 tools/cdn_explorer.py [--port 8123] [--host ADDR]
  [--root DIR] [--db PATH] [--cache DIR] [--bundles all|name,name,…]`.
  Stdlib only (`http.server.ThreadingHTTPServer`) — project convention.
  Serves the page + all of `web/` (so `assets-explorer.html` cross-links
  work), a JSON API under `/api/`, and byte-range reads of cached members.
  Binds **this machine's Tailscale IPv4 by default** (detected via
  `tailscale ip -4`, falling back to parsing the `tailscale0` interface,
  then 127.0.0.1) so the workbench is reachable from other devices on the
  tailnet; `--host` always wins (footer says so). **The user starts/stops
  it** (service rule). `--root`/`--db`/`--cache` overrides exist precisely so
  the smoke suite runs against a fixture tree + temp DB. `--bundles` selects
  which `cdn/*.7z` files get indexed (default: the in-scope trio).
- **Threading/DB**: `ThreadingHTTPServer` for the API + **one worker thread**
  draining a job queue (scan-source, sha256). **SQLite: a fresh connection
  per operation** (context manager, WAL mode, `PRAGMA foreign_keys=ON`).
  Do *not* share one connection across threads — sqlite3 connections are not
  cross-thread safe and the GIL is released during queries (WAL does not
  serialize by itself). API writes are small; the worker is the only long
  writer.
- **Jobs**: table-backed queue (`queued|running|done|error`). Kinds:
  `scan-source` (bundle listing), `sha256`. On startup: `running` → re-queue;
  sources not `done` → auto-queue a scan. Interrupted work resumes; scans are
  idempotent (delete-then-relist).
- **7z access**: `subprocess`, no shell:
  - list: `7z l -slt <bundle>` — parse the `Path = …` / `Size = …` blocks
    (column-0 fields in 26.00), skip `Attributes = D` dirs and the archive
    header block.
  - stream one member to the cache:
    `7z x -so <bundle> <member> > <cache>/<source>/<member>` (atomic via
    `.part` + rename).
  - Everything zip-level afterwards uses Python's `zipfile` on the cached
    file (no further 7z calls).
- **Cache**: `/tmp/opencode/cdn-cache/` (disposable; `--cache` override).
  Members cached as `<source>/<path>` with `/` → `__`; nested zips as
  `<source>/<member>#<entry-path>`. Cap: newest ~50 files / ~1 GB, LRU by
  mtime, enforced after each write and at startup.
- **Frontend**: fetch-based dev tool (the no-`fetch()` rule applies to the
  game app only), classic script, no build, no dependencies. Shared
  `[data-tip]` tooltip rule copied verbatim from `web/css/app.css` (never
  `title`); all dynamic text escaped.

### Database schema

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE sources (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,   -- 'archive7z'
  name        TEXT NOT NULL,   -- '3_0_30.7z'
  path        TEXT NOT NULL,
  size        INTEGER,
  scan_state  TEXT NOT NULL DEFAULT 'pending',  -- pending|listing|done|error
  scanned_at  TEXT,
  notes       TEXT
);

CREATE TABLE files (
  id          INTEGER PRIMARY KEY,
  source_id   INTEGER REFERENCES sources(id),
  cdn_path    TEXT NOT NULL,   -- '3_0_30/game-100-v3_0_30.zip'
  base_name   TEXT,            -- 'game-100' (tier/lang/season/rev/sig stripped)
  family      TEXT, tier       TEXT, lang TEXT,
  season      TEXT, revision   TEXT, sig TEXT,
  is_sidecar  INTEGER NOT NULL DEFAULT 0,  -- name ends in .time
  sidecar_of  INTEGER REFERENCES files(id),-- parent zip row, linked post-scan
  size        INTEGER,
  sha256      TEXT,            -- computed on demand (job)
  format      TEXT,            -- formats.name
  status      TEXT NOT NULL DEFAULT 'unknown',  -- unknown|identified|decoded|skipped|error
  notes       TEXT,
  UNIQUE(source_id, cdn_path)
);
CREATE INDEX idx_files_path    ON files(cdn_path);
CREATE INDEX idx_files_base    ON files(base_name);
CREATE INDEX idx_files_status  ON files(status);
CREATE INDEX idx_files_sidecar ON files(sidecar_of);

CREATE TABLE entries (
  id          INTEGER PRIMARY KEY,
  parent_id   INTEGER NOT NULL REFERENCES files(id),  -- the zip being browsed
  entry_path  TEXT NOT NULL,   -- FULL virtual path: '0' | '1' | '1/images/abe.rgb'
  size        INTEGER,
  crc32       INTEGER,
  method      TEXT,            -- 'deflate' | 'stored' | …
  magic       TEXT,            -- first 16 bytes, hex (advisory sniff)
  format      TEXT,            -- sniff label, advisory until a finding says so
  status      TEXT NOT NULL DEFAULT 'unknown',
  notes       TEXT,
  UNIQUE(parent_id, entry_path)
);
CREATE INDEX idx_entries_parent ON entries(parent_id);

CREATE TABLE formats (
  name       TEXT PRIMARY KEY,  -- 'rgb' | 'bcell' | 'btp' | 'bsv3' | 'pack-index' | …
  magic      TEXT,              -- hex bytes, e.g. '42 47 72 6d' (BGrm)
  container  TEXT,              -- 'raw' | 'zip' | 'zip(0/1 container)'
  doc        TEXT,              -- 'notes/01-binary-formats.md' section
  decoder    TEXT               -- 'tools/extract_assets.py::rgb_to_rgba' | NULL
);

CREATE TABLE findings (
  id          INTEGER PRIMARY KEY,
  target      TEXT NOT NULL,    -- 'file' | 'entry'
  target_id   INTEGER NOT NULL,
  kind        TEXT NOT NULL,    -- 'magic' | 'format' | 'decode' | 'reference' | 'decision'
  summary     TEXT NOT NULL,
  body        TEXT,             -- markdown-ish (rendered as <pre>)
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_findings_target ON findings(target, target_id);

CREATE TABLE jobs (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,    -- 'scan-source' | 'sha256'
  ref         TEXT NOT NULL,    -- source id / file id
  state       TEXT NOT NULL,    -- queued|running|done|error
  detail      TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_jobs_ref ON jobs(kind, ref);
```

Seed `formats` at init: `rgb` (flags 0x0000/0x2000/0x6000, sanity at sniff
time), `bcell` `bcell10`, `btp` `BTP\0`, `bsv3` `01 03`, `pack-index`
`BGrm`, `zip`, `png`, `wav` (RIFF/WAVE, IMA-ADPCM note), `mp4` (`ftyp`),
`text`, `time-sidecar` (open), `fontcache` (open/undecodable).

## Indexing strategy (all resumable)

1. **Pass 0 — immediate, no I/O**: register the in-scope sources (allowlist
   vs `cdn/*.7z` glob). Page is usable instantly.
2. **Pass 1 — per-bundle listing (worker, resumable)**: `7z l -slt` per
   bundle → `files` rows (cdn_path, size, naming fields, sidecar flag) +
   link `sidecar_of` for `.time` rows. `scan_state` tracks progress.
   Listing is cheap (measured: millisecond-class, archive-tail only) — three
   scans finish in seconds.
3. **Pass 2 — per-zip entry listing (on demand)**: first open of a zip
   extracts that one member to the cache, lists via `zipfile`, writes
   `entries` rows (full virtual paths). Magic auto-tag at list time (cheap
   16-byte sniff, always readable): `zip`, `BGrm`, `bcell10`, `BTP\0`, PNG,
   WAV, MP4, `bsv3` `01 03`, UTF-8 text sniff, and `.rgb` by extension +
   flags-field sanity (0/0x2000/0x6000, plausible w×h). Tagging is advisory:
   `entries.format` gets the label, `status` stays `unknown` until a finding
   or human decision.

## API (all JSON, under /api/, on the local server)

```
GET  /api/health                          server + db + 7z versions + counts
GET  /api/sources                         incl. scan_state/scanned_at
POST /api/sources/{id}/scan               re-list a bundle (resets its rows)
GET  /api/jobs                            recent jobs (poll for progress)
GET  /api/files?source=&prefix=&family=&tier=&status=&format=&sidecar=&q=&page=&per_page=
GET  /api/files/{id}                      detail + entries + sidecars +
                                          generations (same family+tier+lang)
                                          + last 10 findings
POST /api/files/{id}                      update {status, format, notes}
GET  /api/entries?file_id=                listed entries of a zip
POST /api/entries/{id}                    update {status, format, notes}
GET  /api/files/{id}/open                 list zip entries (caches member + DB)
GET  /api/entries/{id}/open               nested open (entry that is a zip)
GET  /api/files/{id}/bytes?offset=&length=    max 1 MiB
GET  /api/entries/{id}/bytes?offset=&length=
GET  /api/entries/{id}/hex?offset=&length=    server-annotated 16-byte rows
GET  /api/entries/{id}/preview            image/png (rgb/bcell frame 0/png)
                                          | text (xml/txt/json/fsh/vsh/btp→JSON)
                                          | 415 otherwise
GET  /api/files/{id}/sha256               returns sha, or enqueues job (poll)
GET  /api/stats                           counts by status/format/source
GET  /api/formats        POST /api/formats
GET  /api/findings?target=&target_id=
POST /api/findings      DELETE /api/findings/{id}
GET  /api/mystery                     unknown files grouped by name pattern
GET  /api/pipeline-spec?file_id=      the --dlc JSON for a local file
```

Static: everything under `web/` is served read-only (page, css, js, and —
for cross-links — the rest of the site). Previews are generated on the fly
(pure-Python PNG writer from the pipeline).

**Bytes/preview on demand**: if the member (or a nested zip) isn't cached,
the endpoint extracts/hoists it first (one-time cost, seconds for big packs),
then serves. A corrupt zip → file row `status=error`, notes carry the
reason, API returns a JSON error — the worker/server never crash.

## UI (web/cdn-explorer.html)

Layout (one page, no router):

- **Top bar**: title · global search (path/notes/base name) · filters
  (source, status, format, tier; sidecars checkbox) · stats strip
  (`N files · M identified · K decoded · scan progress`).
- **Left pane** (tabs **Files | Mystery**):
  - Files: sortable table (path, size, family·tier·lang·season·r, format,
    status badge, source). Sidecars show a ⏱ marker.
  - Mystery: unknown files grouped by name pattern (family), count + total
    size + sample paths + a "sidecars" group — the next-target picker.
- **Right pane (detail)** for a selected file, and a nested **entry panel**
  when an entry is selected:
  - metadata card (path, source, size, sha256 [button → poll job], naming
    fields, status [editable], format [editable], notes [editable]);
  - **generations table** (same family+tier+lang across revisions/bundles:
    source, size, revision/sig) — click to jump;
  - **virtual FS tree** (zip → `0`,`1` → nested entries, lazy per open);
  - **hex view** (256-byte pages, offset seek) + **preview** (image on
    checkerboard / text in `<pre>`) for entries;
  - **findings** (chronological, kind badge, `<pre>` body, dependency-free)
    + add form (kind, summary, body) + delete;
  - **actions**: rescan source, sha256, copy `--dlc` pipeline spec (dialog
    with textarea), open in Asset Explorer (`assets-explorer.html` link).

Styling: own `cdn-explorer.css` in the explorer palette (dark blue panels,
gold accents — "clarity over game theming" per scope); the shared `[data-tip]`
rule block copied verbatim; all dynamic text escaped via one `esc()`.

## The "one file at a time" RE workflow

The page should make this loop the center of gravity:

1. **Pick a target** — filter `status=unknown` or use the Mystery view
   (name-pattern groups suggest high-value targets: `fontcache` blobs from
   `1_0_4`, `menuoffsets-*` packs, `.time` sidecars, unrecognized event
   packs).
2. **Inspect** — open/hex/preview; compare against known formats
   (`notes/01`), the HAR ground truth (`server/payloads/`) — **local
   references only; fetching anything from the internet requires explicit
   user approval first** (see Network policy).
3. **Record** — add findings (kind `magic`/`format`/`decode`/`reference`),
   upsert the `formats` row if it's a new format, move the status
   (`identified` → `decoded` once a decoder parses to EOF). Findings must be
   written readable by a cold session: byte offsets, evidence, what's still
   unknown.
4. **Promote** — when a format is verified, the session updates
   `notes/01-binary-formats.md` (byte-exact spec) + `CHANGELOG.md` per
   project discipline. (Stretch, later: export findings to markdown.)
5. **Hand off** — decodable content gets its `--dlc` spec copied out; actual
   decoding into `web/assets/` is a separate pipeline task (never run from
   the explorer).

## Network policy (hard rule, user-mandated 2026-10-15)

- **No downloads and no outbound network connections of any kind** (fan CDN,
  archive.org, GitHub, anything) **without asking the user first** — per
  instance, not blanket. This covers the assistant and the tool alike; the
  tool itself makes **zero outbound** network calls (it only *serves* on
  its Tailscale address, so tailnet peers can open it).
- Community repos (`al1sant0s/tsto2rgb`, `TappedOutReborn/DLC-Downloader`)
  are reference-only and may be pulled **only after explicit approval**.
- `tho2104.7z` at the fan CDN root (notes/02: "needs user approval") stays
  untouched.
- If a download is ever approved, reuse the `tools/crawl_cdn.py` policy as a
  floor: 1 concurrent connection, ≥10 s between requests, blank User-Agent.

## Testing (headless, project standard)

`tools/smoke-cdn-explorer.py` (stdlib Python — the tool is Python; the
existing Node suites stay untouched):

- **Fixture** tree in a temp dir: two tiny real 7z archives built with
  `7z a` — bundle A: a real pack (`0` = BGrm + version, `1` = nested zip
  with a hand-built 2×2 `.rgb` + a `.txt`), a `.time` sidecar, a plain zip,
  a corrupt zip; bundle B: a pack whose `1` holds a hand-built `bcell10`.
- Start the server on a spare port with `--root`/`--db`/`--cache` pointed at
  the fixture (+ temp DB).
- Assert: sources appear and scans complete; files rows + naming fields
  (family/tier/season/rev/sig) match the fixture; sidecar row is tagged and
  linked; `/open` lists entries incl. nested `1`; bytes/hex round-trip
  against the constructed bytes; `.rgb` preview is a valid PNG (IHDR 2×2);
  `.bcell` preview renders frame 0; findings CRUD persists; formats seeded;
  pipeline-spec JSON sane; corrupt zip → `status=error` row, no crash.
- **Restart with the same DB** → all state persists (sources done, findings
  intact, error row intact). (True mid-scan resume is the same code path —
  re-queue of `listing` sources at startup; the fixture scans are too fast
  to interrupt deterministically.)

## Milestones

- **M0 — spike & scaffold** ✅ (spike measured 2026-10-14: 7z listing of the
  largest bundle ≈ instant; scaffold + DB init + formats seed + bare page).
- **M1 — index & browse** ✅ (2026-10-15) — passes 0–1 + jobs/progress UI +
  files table with filters/search + mystery view. Verified: all three
  bundles listed (464 files, 232 sidecars linked to parents), scan state
  survives restart.
- **M2 — virtual FS, hex, previews** ✅ (2026-10-15) — on-demand zip
  listing, nested pack opens, byte-range + hex, previews, magic auto-tag.
  Verified on real content: `3_0_30/game-100-v3_0_30.zip` opens → `1` opens
  (945 entries: 359 bcell / 280 rgb / 161 text / 145 unknown) →
  `aztectheatre.rgb` renders as an 856×808 PNG, `abe_back_walk.bcell` shows
  frame 0; hex/bytes round-trip; `web/assets/` untouched.
- **M3 — RE journal** ✅ (2026-10-15) — findings CRUD + status workflow +
  format registry + generations view (grouped by family+tier+lang, so
  `game-100` shows exactly its 3 revisions and not `game-25`/`game-50`) +
  sha256 + pipeline-spec copy + Asset-Explorer cross-link. Smoke-tested on
  the fixture and used live for the `.time` identification below.
- **M4 — hardening & docs** ✅ (2026-10-15) — smoke suite green (33
  checks, fixture kept on failure); cache cap + pagination in place;
  `notes/README.md` + project README updated; CHANGELOG entries; end-to-end
  demo of the RE loop: `.time` sidecar taken **unknown → identified**
  (10-byte ASCII Unix epoch, verified 30/30 across all three bundles, spec
  promoted to `notes/01-binary-formats.md`, 30 sampled rows marked with a
  format finding).

## Acceptance criteria (definition of done)

1. `python3 tools/cdn_explorer.py --port 8123` (started by the user) serves
   the page; the index covers **all files in the three in-scope bundles**
   and is browsable/filterable/searchable.
2. Any indexed zip opens to its entries; pack `1` opens to its files; hex
   view and previews work for at least `.rgb`, `.bcell`, text, and one
   unknown binary.
3. The RE journal works: findings attach to files *and* entries, persist
   across restarts, and at least **one real unknown file has been taken
   unknown → identified/decoded** with its findings (suggested: a
   `fontcache` blob from `1_0_4`, the `menuoffsets-*` packs, or a `.time`
   sidecar — pick whichever is most useful).
4. Restart persistence verified; smoke suite green; corrupt-zip path proven
   non-fatal.
5. `web/assets/`, the game app, and the Asset Explorer are untouched
   (verify: no diffs, smoke-scene/explorer suites still green); **zero
   network connections made**.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Corrupt/odd zips (pipeline already hit decode errors in the archive) | per-file try/except → `status=error` rows; worker never crashes (pipeline convention) |
| Cache growth in /tmp | LRU cap (newest ~50 members / ~1 GB); cache is disposable |
| Name-grammar edge cases (movies, `_LTD`, `MERGED`, per-lang families) | generic right-to-left peel; failures → untagged (family = whole name), not dropped |
| Nested-zip byte reads on big packs | nested zips hoisted to the cache once; forward-seek reads, 1 MiB page cap |
| SQLite concurrency (threads) | fresh connection per operation + WAL; no shared connections |
| Big movie packs (1_1_35) slow first open | one-time 7z extraction to cache; subsequent opens read the cache |

## Session-start checklist (for the executing session)

- Read `notes/00-orientation.md` (working agreements), skim `notes/01`
  (formats) and `notes/04` (server API); this doc + `planning/README.md`.
- Working agreements: user starts/stops the server; no browser launching by
  the assistant (verify via smoke suite + reading generated output);
  **no network of any kind without asking first**; CHANGELOG discipline
  (newest-first, bold lead phrases, `## 2026-10-15.N` counters as needed);
  not a git repo (never print commit commands); scratch in `/tmp/opencode/`;
  `web/assets/` is generated — never hand-edit or write.
- Tool check: `7z` (26.00 ✓), Python 3.14 stdlib ✓, Node 22 (only for the
  existing suites, to confirm no regressions).

## References

- `notes/01-binary-formats.md` — verified byte-exact format specs
- `notes/02-architecture-and-decisions.md` — pipeline, naming grammar, CDN facts
- `notes/03-open-work.md` — deferred items the explorer feeds (fontcache, bsv3, …)
- `notes/04-server-api.md` — fan server endpoints/persistence
- `server/payloads/dlc server.har` — recorded real first load (EA CDN URL shape)
- `cdn/catalog.json`, `cdn/v469-packages.json` — fan CDN metadata (deferred)
- Community ground truth (network access needs approval):
  `al1sant0s/tsto2rgb`, `TappedOutReborn/DLC-Downloader`
