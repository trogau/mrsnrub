# mrsnrub project rules

## City View: the Canvas page is DEPRECATED
- `web/city-view.html` (+ `web/js/city-view.js`) is the DEPRECATED legacy
  page. Do NOT add new features, buttons, or toggles to it. It is kept
  only as the reference/fallback implementation (and the harness target
  `tools/smoke-city-view-dom.cjs`); touch it only to fix regressions or to
  keep it working with shared modules.
- ALL new view work goes into the PixiJS viewer: `web/viewer/index.html`
  (+ `web/viewer/city-view-pixi.js`). When porting a feature that exists
  on both pages, the Pixi page is the source of truth.
- Remember to bump the script cache-buster (`city-view-pixi.js?v=N`) in
  `web/viewer/index.html` whenever the viewer JS changes.

## Evidence files for user review
- Any file that the user must look at (evidence crops, overlay images,
  candidate-street renders, etc.) must be copied into
  `mapdump/registration/` — never left only in `/tmp/opencode/`.
  Name them with the existing `m4-*` / area prefixes so they sort with
  prior evidence.

## Git: never stage local database files
- Never put a `.sqlite` / `.sqlite-wal` / `.sqlite-shm` file in a `git add`
  line (e.g. `web/api/progress.sqlite`, `web/api/streets.sqlite`). They are
  local, generated runtime state and already gitignored — `git add` on them
  is a no-op at best. When the board/API changes, stage the code that reads
  or writes the DB (the `.php`, `.js`, `.css`, harnesses, docs, CHANGELOG),
  not the database file itself. Print the `git add` list without the sqlite
  path.
