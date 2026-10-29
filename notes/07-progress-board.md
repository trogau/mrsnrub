# 07 — Progress board: how to add tasks & decisions

Process guide for **any working session** (this or another agent) on what
belongs on the task & decision board, how to write an
entry, and how to add it. The board lives in
`web/api/progress.sqlite` (tables `tasks`, `snap_log`), has its own page at
`tasks/index.php` (a PHP page since 2026-10-29; split out of
`web/progress.html` on 2026-10-25), is
edited through that page or `web/api/progress.php`, and is the single live
queue of "what's pending / what needs the user's call".

Companion meters (CDN funnel, RE stats, …) are computed by
`tools/progress_scan.py` — **never hand-add meters**; if something should
be measured and isn't, that itself is a task.

## What belongs on the board

Add an entry when any of these is true at the end of your work:

1. **A decision is needed from the user** — anything requiring their
   approval or choice before work can proceed (downloads, scope changes,
   installs, "do we want X at all"). `kind: decision`,
   `status: pending-approval`.
2. **Work is discovered but deferred** — you identified valuable work but
   are not doing it now (out of scope for the session, blocked on
   another item, or the user parked it). `kind: task`,
   `status: deferred` (user parked) or `todo` (nobody has claimed it).
3. **A milestone completed** — a phase/major deliverable landed.
   `kind: milestone`, `status: done`. One line, with the CHANGELOG
   version in `notes`.
4. **A blocker was hit** — work that cannot proceed (missing tool,
   upstream gone, awaiting another task). `kind: task`,
   `status: blocked`, and say *what* unblocks it in `notes`.

Do **not** use the board for: session scratch-pads, todo lists inside a
single task you're mid-way through, anything already tracked as a
headless test failure, or bugs you fix in the same session (those go in
the CHANGELOG).

## Entry conventions

- **`title`** — imperative, one actionable sentence, ≤ 160 chars,
  self-explanatory *without* this session's context (someone reads this
  months from now). Good: "Download fan-CDN THOH2014Game-100 (42 MB art
  pack)". Bad: "the download thing".
- **`kind`** — exactly one of:
  - `task` — someone can just do it once unblocked/approved.
  - `decision` — requires the user's explicit call before doing anything.
  - `milestone` — a record of something achieved (usually added as
    `done`).
- **`status`** — `todo | doing | done | blocked | deferred |
  pending-approval`. Sensible pairings: decisions are
  `pending-approval` until the user says otherwise; parked-by-user work
  is `deferred`.
- **`source`** — where the item came from, so it is traceable: a notes
  file (`notes/03 s2`), a plan (`planning/phase-2-camera-view.md`), the
  scanner (`progress scan 2026-10-18`), or your session name. For
  anything derived from `notes/03-open-work.md`, cite the section.
- **`milestone`** (optional, ≤ 40 chars) — grouping tag (2026-10-29).
  Rows sharing a tag render together under a header with a done/total
  progress bar; empty = Ungrouped (last). Use the plan's own label, e.g.
  `M5 — Integration & game UI` for every stage row of
  `planning/phase-2-m5-integration.md`, so the header shows milestone
  progress at a glance. Set it from the page (the `+ group` tag on each
  row / the milestone box in the add form) or via the API.
- **`notes` (the detail — REQUIRED, ≤ 4000 chars)** — every ticket must
  carry a plain-language explanation, readable months later without this
  session's context: **what the work is, what it is for, and the outcome
  it should land**. Write it as short prose or labelled lines
  (`What: … Why: … Outcome: …`), plus exact filenames/sizes, URLs, the
  blocking condition, what the user already said (quote short verbatim
  decisions, e.g. *"No, leave the audio fix for now"*), and the concrete
  next step. The board flags tickets without it (dotted amber title);
  click a row to open the detail modal and write it (Esc closes). Rows
  without a detail are not actionable by another session — treat writing
  one as part of adding the ticket.

## Approval rules

- Only the **user** moves an item out of `pending-approval` (they do it
  in the page's status dropdown). An agent must never set
  `pending-approval → done/doing/todo` on a decision.
- When the user approves a decision in conversation, set it to `doing`
  (and start it) or `done` (if the approval itself was the whole item,
  e.g. a download they performed), citing the approval in `notes`.
- Items marked `deferred` **by the user** stay deferred until they say
  otherwise — do not "helpfully" re-activate them; at most add a *new*
  decision asking whether to revisit.

## How to add / update entries

Preferred from a working session — POST to the API (it persists
immediately and shows up on the dashboard):

```sh
# add a task
curl -s -X POST http://dave-latitude-5550.tailc953b.ts.net:8081/mrsnrub/web/api/progress.php \
  -H 'Content-Type: application/json' \
  -d '{"action":"task-add","title":"Download fan-CDN tho2104.7z (120 MB, CDN root)",
       "kind":"decision","status":"pending-approval",
       "notes":"Referenced by no index/ledger. Needs explicit download approval. Source: notes/03"}'

# update status / notes after the user decides
curl -s -X POST .../progress.php -H 'Content-Type: application/json' \
  -d '{"action":"task-update","id":6,"status":"done","notes":"User approved + downloaded 2026-10-20"}'

# session journal line (free-form; complements the CHANGELOG)
curl -s -X POST .../progress.php -H 'Content-Type: application/json' \
  -d '{"action":"log","message":"indexed 12 more 4.x bundles; mystery list now <200 files"}'
```

Notes:
- `task-add` accepts `title` (required) plus `kind` (default `task`),
  `status` (default `todo`), `notes` and `milestone` (grouping tag);
  `source` is stamped `user` — if you need traceability, put the source
  reference at the start of `notes` (e.g. `"Source: notes/03 s2"`).
- `task-update` accepts `id` + any of `status`, `kind`, `title`,
  `notes`, `milestone` (set/clear the group; whitespace is trimmed). `task-delete` accepts `id` — only delete entries **you**
  added this session or that are factually obsolete (cite why in the
  journal with a `log` entry first).
- On the server box without HTTP, the CLI equivalent works:
  `PROGRESS_DB=web/api/progress.sqlite PROGRESS_TEST_BODY='<json>' php web/api/progress.php`
- Users (and you, when asked) can also edit everything in the page UI.

## End-of-session checklist

Before wrapping up, a session should:

1. Add tasks for work it *found but didn't do* (`todo`/`deferred`).
2. Add decisions for anything it *needs from the user*
   (`pending-approval`) and list the open decisions in its final reply
   so the user can act on them there and then.
3. Add/complete milestones for what shipped (mirroring the CHANGELOG).
4. Write one `log` journal line summarizing the session (the next
   session reads the journal top-down).
5. Run `python3 tools/progress_scan.py --note "what changed"` so the
   meters reflect the session.

## Relationship to notes/03-open-work.md

`notes/03` remains the *narrative* record (full design context,
user-quote provenance, intentionally-out-of-scope list). The board is the
*live queue*. Keep them consistent: when you add a genuinely new parked
item, add both the notes/03 paragraph and the board entry; when the board
shows `done`/`blocked`, notes/03 should be updated to match in the same
change. If they ever disagree, the board reflects status, notes/03
reflects rationale.
