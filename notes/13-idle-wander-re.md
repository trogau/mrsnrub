# 13 — Idle wander (how the engine walks its characters with no job)

Third RE pass on **`libscorpio.so`** (AArch64), on one question: when a
character is standing in town and nobody has given it a job, what makes it
move? Answer: an **engine-side idle wander loop** — the client picks a nearby
tile, pathfinds to it over a shipped per-tile cost grid, walks it, dwells, and
repeats. No job, no script, no server round-trip. The web port replicates it in
`web/js/wander.js` behind the Pixi viewer's `Idle walk` toggle
(`web/viewer/city-view-pixi.js`, 2026-11-03).

Addresses are virtual addresses in `libscorpio.so` (`.text`: file offset ==
vaddr; `.data.rel.ro`: vaddr == file + 0x1000), the same conventions as
`notes/06`/`notes/08`. The working method is still the byte tracer
(`/tmp/opencode/rz/trace.py`): this build's Ghidra decompilation is unreliable
around the EA/Redwood script glue, so the claims below come from strings,
pointer tables and the literal compare chains, not from decompiled C.

---

## 1. The behaviour enum

The XML attribute is `<MovementBehavior mode="…">`. The client parses it into a
12-value enum; the name table is the 24-byte-stride descriptor run at
`.data.rel.ro` vaddr `0x1df358` (file `0x1de358`), twelve entries
`{char *name, u64 *slot, u32 type=0x403}`:

```
RandomRelaxed  RandomRush  RandomHover  JobLocation  Invalid  JobLocationHover
JobLocationWaitForScript  Scripted  Idle  Sneak  RushAndRest  CenterScreen
```

The parser at `0xec0808` resolves the attribute string and stores the value at
**behaviour struct `+0x4c`**; the numeric order it assigns is

| value | mode | what it means for a wandering character |
|---|---|---|
| 0 | Invalid | unset — never shipped |
| 1 | **RandomRelaxed** | **the built-in default: stroll around the home tile** |
| 2 | RandomRush | same loop, faster, shorter dwells, wider ring |
| 3 | RandomHover | stays close, slow |
| 4 | JobLocation | walk to the job location (needs a job — not ported) |
| 5 | JobLocationHover | loiter at the job location (not ported) |
| 6 | JobLocationWaitForScript | hold for a script (not ported) |
| 7 | Scripted | a script owns the movement (not ported) |
| 8 | Idle | stand still |
| 9 | Sneak | slow, tight, job-flavoured (the 124 `mode="sneak"` job rows) |
| 10 | RushAndRest | dash, then rest a while |
| 11 | CenterScreen | stay in the camera's middle (dialogue/cutscene) |

**Only 46 of the 412 shipped `<Character>` definitions name a mode at all**
(15 RandomRelaxed, 14 CenterScreen, 6 RandomRush, 1 RandomHover, plus the
sneak rows that live in job XML). `data/character_ids.json` × every
`web/assets/dlc/gamescripts-r*/data/*characters*.xml` gives the census:
981 of 1023 save characters carry a `<WalkSpeed>` and 56 a mode. So **the
default path is the one that matters**: plain characters — Homer, Marge,
Bart — define no `<MovementBehavior>` and get **RandomRelaxed** from the
engine. The port applies that default explicitly
(`CityWander.KNOBS.fallbackMode`), which also covers the job/cutscene modes:
with no jobs and no cutscene camera to honour, they wander relaxed too rather
than freezing.

## 2. The cost grid is why they hug the kerbs

`web/assets/dlc/gamescripts-r343174/data/settings.xml:1119` ships
`<RoadGridSettings>`: one `<RoadType>` per surface with its own `pathCost`.
The port copies the table verbatim into `CityWander.ROAD_COST` (the harness
asserts entry-for-entry equality):

| surface | pathCost | surface | pathCost |
|---|---|---|---|
| klroad | 10 | pavement | 24 |
| sidewalk / boardwalk / pier | 15 | grass | 32 |
| dirtedge / cobblestoneedge | 16 | beach | 40 |
| road / klroadedge | 18 | klparking | 64 |
| dirtroad / cobblestone | 19 | none / river / ocean / cliff | 196 |
| boardwalkedge / pieredge | 21 | wall / outofbounds | 99999 |

There is **no rule anywhere that says "walk on the road"**. Streets are 10–19
and grass is 32, so an A* over this table spends the crowd on the pavements and
the kerbs on its own; water at 196 and `wall`/`outofbounds` at 99999 keep them
off the sea and through no building. `<PreferredGridType>` /
`<AvoidGridType>` bias the same table for special characters. The port treats
anything above `KNOBS.maxCost` (100) as a wall, which admits every street,
grass and beach surface and none of the 196-family.

The three search contexts in the binary —
`GridMapSearchContext`, `RoadOnlySearchContext`, `BoardwalkOnlySearchContext`
(vtable names at `0x3fe681`, `0x3fe698`, `0x3fe6b0`, with their
`eastl::ref_count_sp_t<>` instantiations right after) — are the same
pathfinding engine handed a different tile map: wander anywhere, stick to the
streets, or stick to the boardwalk. The port's cost grid is the Grid variant;
the placed-building footprints from `M.buildings` are its `wall` tiles.

## 3. The loop, and the script API around it

The engine exposes the wander as script functions, which is the clearest proof
of what it is:

* `Character::startIdleMovement` (`0x39c97b`) — begin the wander loop;
* `Character::stopMovement` (`0x3b3b3c`) — halt it, keep the position;
* `Character::isMovementIdle` (`0x3a64cc`) — the query a script uses to tell an
  engine wander from a scripted move;
* `Movement::randomMove` (`0x3b89ba`) — one hop to a random reachable tile.

And the shipped content uses them: `EndofIdleWanderScript` (string at
`0x39cb3b`, and as a script/variable name at `0x3f4ba7`/`0x3f4bf2`/
`0x3f4c14`/`0x3fabb8`) is the marker event scripts fire at the end of an idle
wander leg — i.e. the client runs the wander and *notifies* scripts at the
boundaries, exactly the shape `CityWander.tick()` has: `IDLE` (dwell at the
post) → `WALK` (follow an A* polyline) → `IDLE`.

The walk **animation** is the same cell family the manifest ships for idles:
`<skin>_front_walk` / `<skin>_back_walk` (+ `_left`/`_right` variants; the
citypool extraction holds 829 stems with front/back cells and 1 522 side cells)
— the game simply swaps the idle cell for the stride cell while a move is in
progress, which is why a walking Homer looks like Homer striding and not
sliding.

## 4. Knobs vs evidence

Everything above is recovered. Everything below was **not** recoverable —
no shipped XML sets it (`minimumWalkTime` exists as a string at `0x3b860b` but
no `<Character>` or `<MovementBehavior>` row carries it; the dwell and target
radius are not in any settings block) — so they are **named knobs** in
`CityWander.KNOBS`, seeded from what *is* known. Change the number, not the
code; each knob's comment says what it is standing in for.

| knob | value | seeded from |
|---|---|---|
| `speedBase` | 1.3 tiles/s at speed 50 | the median shipped `<WalkSpeed>` is 50 |
| `speedMin` / `speedMax` | 0.9 / 2.0 | `settings.xml:259 <WalkDefaultSpeeds slow="0.9" fast="2.0">` |
| `dwellMin` / `dwellMax` | 6 / 24 s | unmeasured (the idle-trigger pattern of `timeBetweenAnimsMin/Max`, `0x3d898a`) |
| `rangeMin` / `rangeMax` | 3 / 22 tiles | unmeasured (ring around the post, keeps the crowd in its neighbourhood) |
| `homeChance` | 0.18 | unmeasured (a share of hops go straight back to the post) |
| `tries`, `maxNodes`, `maxSearch`, `retryDelay`, `minPath`, `postSeek` | 12, 2200, 2, 2.5 s, 2, 3 | port mechanics: bound the A* work, not the game |
| `buildingCost`, `maxCost` | 99999, 100 | the table's `wall` entry, and the gap between grass (32) and the 196 family |

Per-mode feel (`CityWander.MODES`: speed/dwell/range multipliers) is likewise a
port knob — the shipped XML says *which* mode a character has, not how fast it
feels. The relative order (Sneak < Relaxed < Rush) is all that is claimed.

## 5. The port

* `web/js/wander.js` — `CityWander`, pure module (no DOM, no network, no
  camera; `require`-able under Node). Cost grid memoised per tile from
  `terrain.typesAt()` + the building-footprint occupancy; 4-neighbour A* with
  packed numeric keys over one binary heap; a per-character
  `IDLE`/`WALK` machine on a deterministic mulberry32 stream seeded from the
  save id, so the crowd is never in lockstep but a reload walks the same way.
* `tools/gen_walk_data.py` → `web/js/walk-data.js` — the per-save-id
  `{speed, mode}` table harvested from every gamescripts pack (newest pack
  wins), baked as `window.WALK_DATA` so it works from `file://`.
  Regenerate after pulling a new pack.
* The viewer mutates the `M.chars` rows **in place**, so the scene pass, the
  click hit-test, the selection outline and the details card all follow the
  walker; `setEnabled(false)` restores the save's positions exactly.
  The details card keeps the save position next to the current one.
* Walk art comes from the dynamic `.bcell` endpoint (`api/bcell.php?src=pool`),
  because the pre-baked manifest ships idle cells only. A skin without a walk
  cell, a cell still decoding, or a page with the endpoint off walks in its
  idle pose — never a red X, which is reserved for an idle cell the endpoint
  refused.
* Screen-space direction: the cell is chosen from the movement vector *as
  drawn* (through the tile→screen affine), so Rotate/Mirror keep the character
  facing the way it visibly travels. The rule itself is the shipped content's —
  see §6.
* Which cells a skin really has comes from `api/bcell.php?src=pool&mode=anims`
  (one small JSON per skin) rather than from probing eight guessed names and
  eating 404s; if the endpoint is unavailable the viewer falls back to
  guessing the names, as it did before the listing existed.
* Cadence: the sim ticks every frame (p50 0.023 ms on the real save, ~460 of
  871 mid-stride, A* runs capped at `maxSearch` per tick), the crowd repaints
  on a 60 ms throttle only while a walker is on screen.
* Harness: `tools/smoke-idle-wander.cjs` — page (button ships ON, `data-tip`,
  script order), wiring (sim over the save's own rows, walk cell preferred,
  idle fallback, no red X, the deprecated Canvas page untouched), behaviour on
  the real save (moves locally inside the ring, never in the sea, never in a
  lot, at-rest on tile centres, deterministic, exact restore, cheap ticks), and
  evidence (cost table and speed clamp equal the shipped XML, RandomRelaxed is
  the default that actually reaches the cast, and the direction rule replays
  the `MovePick` table of §6 through the project's own projection).

## 6. Which walk cycle, and why: the shipped `MovePick` table

The direction rule is not a guess. The job/cutscene XML carries the engine's
own "moving this way plays that cycle" table, in `jobs.xml` and some 200 other
data files:

```xml
<MoveGroup name="FullMoveGroup">
  <MovePick x="-1" y="0" speed="1"><PriorityList>
    <Animation name="Front_Walk_Left"/><Animation name="Front_Walk"/>
  </PriorityList></MovePick>
```

`x`/`y` are a step in the character's own grid; the `PriorityList` is
best-first. Census over every `<MovePick>` in `gamescripts-r343174/data`
(1 812 files, the first `<Animation>` of each pick, locomotion names only —
461 distinct):

| grid step | drawn as | preferred cycle | count |
| --- | --- | --- | --- |
| `(-1, 0)` | down-left | `Front_Walk_Left`, then `Front_Walk` | 119 plain + 63 left |
| `(0, +1)` | down-right | `Front_Walk_Right`, then `Front_Walk` | 119 + 63 right |
| `(+1, 0)` | up-right | `Back_Walk_Right`, then `Back_Walk` | 124 + 50 right |
| `(0, -1)` | up-left | `Back_Walk_Left`, then `Back_Walk` | 124 + 50 left |
| `(-1, +1)` | straight down | `Front_Walk` (no side qualifier) | 158 |
| `(+1, -1)` | straight up | `Back_Walk` (no side qualifier) | 167 |

"Drawn as" is the project's own projection (`CAM.TILE` 2:1, `CAM.ORIENT`
`(1,-1,swap)`): tile → oriented axes → `world = ((u−v)·hw, (u+v)·hh)`, screen
`y` down. Feeding the four table rows through `CAM.tileAffine` reproduces the
table exactly, so the rule the viewer uses is just the two components of the
drawn vector, read at once:

* **facing = sign(screen dy)** — down-screen is *toward* the camera, so it is
  the `Front_` cycle; up-screen is `Back_`.
* **side = sign(screen dx)** — `_Left` / `_Right`.
* fallback order is the `PriorityList`'s own: the **authored side cell, drawn
  exactly as authored**, then the plain cycle of the **same family**, then the
  other family (the content never mixes families in one list; the last step is
  only for the 3+7 stems that ship one family, and beats a character sliding in
  its idle pose).
* **One deliberate addition — a mirror on the plain cycles** (the user's
  ruling, 2026-11-04, after the §9 census and the walk-lab eye test: *"note
  some are mirrored now, it's the only way it looks right"*). The lab's four
  compass rows are these four steps named by what they *look like*, and in this
  projection a unit tile step is a 2:1 diagonal, so "north" is the **up-left**
  one (`Back_Walk_Left`), "east" up-right, "south" down-right and "west"
  down-left. Ruling: on the two steps whose authored cell a flat-authored skin
  does not have, the plain cycle is drawn **mirrored** —
  `mirror = (family back && side right) || (family front && side left)`,
  i.e. the `Back_Walk_Right` step plays a flipped `Back_Walk` and the
  `Front_Walk_Left` step a flipped `Front_Walk`; the other two steps play the
  plain cycle as drawn. Status: **an aesthetic ruling chosen against the
  shipped data, not a conclusion from it** — and specifically not a facing
  fix. §8 measures these cycles square-on (homer's four cells lean −2.0 px,
  deep inside the ±12 px "square-on" band), so no pixel says which way they
  travel and nothing here is correcting a wrong turn; the mirror is which of
  two reads the eye prefers for a step the game authored as its own cell. The
  census (§9) says the missing `homer_*_walk_left/right` cells are an authoring
  decision and the resolver (§9) proves the client asks for them and then plays
  the unsuffixed cell, so the shipped fallback was defensible — this is
  deliberately taken anyway, from the eye test. And it is a **stand-in, never
  an override**: the moment the authored side cell exists it wins tier 1 and is
  drawn unflipped, so the sided skins can never be double-mirrored. The
  engine's own way of filling those two rows is to author two cells (§8:
  mirroring there is always content, never a transform), which is exactly why
  the flip is suppressed by the art.
  Pinned in both places the rule lives: `walkPlan()` in
  `web/viewer/city-view-pixi.js` (asserted cell-by-cell and flag-by-flag by
  `tools/smoke-idle-wander.cjs`) and its copy `rulePlan()` / `rulePick()` in
  `web/viewer/walk-lab.html`.

Two traps this settles. First, **"dominant axis" cannot work**: in a 2:1
oblique every grid step is twice as far across as up/down, so a rule that
picked by the bigger component put the *whole town* in the sideways buckets and
played `Front_Walk_Left` for characters visibly walking away up-left — the
"they're walking backwards" report. Second, both components matter
simultaneously: a step is always partly sideways *and* partly toward/away,
which is why the table has no pure `Front_Walk` row for the four steps the
sim's 4-neighbour A* can take.

The art matches the naming: the pool holds 3 857 plain `front_walk`/`back_walk`
cells (829 stems) and 1 522 side cells — 415 stems ship side *pairs*, 411 of
them have **only** side variants and no plain cycle at all, and 5 skins
(`zombiehuman1…3`, `zombiepet1/2`) have all six. There is no facing or
direction field in the `.bcell` header to read instead: the u32 at +9 is 61 for
every walk (idles are 22/48), so the name is the only carrier.

## 7. The filmstrip audit: the walks were there, filed under "actions"

"Some of the animations might be missing" turned out to be a labelling bug, not
missing art. `tools/gen_city_sprites.py`'s pass 4 files each cell under its
**role-stripped** stem (`_char_split_role` moves the trailing `_walk`/`_idle`
into a `role` field), and the classifier was then handed only that key — so
`homer_front_walk` was judged as key `homer_front`, role `walk`, with no kind
word left in it, and fell through to the "≥ 2 distinct frames" fallback:
**action**. 3 156 walking cycles and 213 idle loops were labelled that way
(only 56 kept a `walk`-ish word inside the stem and landed in the Walks group).
The viewer's card sorts idle → walk → action → poses and caps a card at 150
tiles, so on Homer's 621-cell card the walks were not merely mislabelled, they
were unreachable — while the PNGs sat on disk and `bcell.php` served them
happily.

Three pieces, all verified rather than assumed:

* `char_cell_kind(key, role, distinct)` now searches the kind words in the key
  **and** the role (`tools/gen_city_sprites.py`, lifted to module level so
  nothing can drift). The role outranks the key: `<name>_walk_idle` is the
  standing loop, not a stride.
* `tools/char_family_relabel.py kinds` restates the labels of the 809 shipped
  `families/<cid>.json` with that imported rule — metadata only, no PNG
  re-render. `distinct` (hold vs loop) is recoverable from the label already in
  the file, since only `misc`/`standby`/other are reachable, so the result is
  what a full `chars` batch run would have written. Verified afterwards: 13 200
  cells compared field by field, zero differences outside `kind`. Walks went
  1 451 → 4 607 across the cast.
* With the walks correctly labelled, the *cap* became the problem: 194 walks and
  247 actions do not fit in 150 tiles, and one head slice let the biggest group
  eat the card. `char-variants-pixi.js` now shares the budget — every group the
  character has gets `KIND_QUOTA` tiles before the leftovers go to the biggest
  groups — and says "showing 150 of 544 animated cells — up to 30 per group
  first".

Still missing for real, and by a different mechanism: cells the pool has that
no card lists at all (680 plain walks, 214 side walks, 266 idles, 191 blinks).
Pass 4 gives a cell to the *longest catalog name* its stem starts with, and a
catalog name is not always the art's stem — `CapitalCityGoofball` ships
`pita_*`, `Xmas2014_Santa` ships `santa_*` — so those characters' own cells
went to whichever costume twin happened to be named exactly the stem, or to
nobody. `_char_prefixes()` now also claims the stem of the idle art the map
draws, and `tools/char_family_relabel.py ownership` dry-runs the rule on the
pool with the generator's own functions:

```
before (name + alias only)        84 of 809 placed skins miss their own walking cycles   (2 026 loose cells)
after  (+ the map idle's stem)      0 of 809 placed skins miss their own walking cycles   (1 704 loose cells)
```

The 322 newly claimed cells still need a `chars` batch run to render their
PNGs; until then those cards show what they always showed, and the map is
unaffected either way because it names cells straight through `bcell.php`.

A card's cells are selected by the *prefix string* its owner matched, not by
the owning character, so the extra prefix only ever adds: recomputing the card
keys for all 809 characters under the old and the new rule gives **no card that
loses a cell**, 94 cards that gain one (6 759 cell appearances, since a cell can
legitimately sit on its parent's card as an outfit and on the twin's card as its
own), and the `owners`-map tie-breaks that do move keep the same winning prefix.

## 8. How a character ends up facing the way it walks

Question raised from the viewer: if a walk cycle is drawn one way only, a
citizen walking the other way would moonwalk, and the shipped game plainly
does not do that. An earlier draft of this note answered "the whole walk
library is right-handed and the engine never mirrors it" — wrong, and wrong in
a way that hid the actual mechanism. Two things were missed; both are now
measured.

**Miss 1: most walk art has no facing to get wrong.** The plain
`<skin>_front_walk` / `_back_walk` cycles are drawn **squarely on** — straight
at the camera, or straight away from it — and are **centred on the character
origin**, so no travel direction is baked into them: the cycle itself carries
the stride (the legs swing apart and cross from pose to pose, which is what
reads as "walking toward you"), and the same drawing serves left or right.
They are not pixel-mirror symmetric — a hand-drawn head is turned a degree or
two — but at city scale the mirror is indistinguishable, which is what matters
(see row 2 of `mapdump/registration/m4-walk-facing-neutral-vs-directional.png`:
Homer pose 1 next to its own mirror). Measured as the silhouette bbox midpoint
relative to the origin the `.bcell` frame offsets are taken from (a genuinely
directional cycle scores ±20–30 px here; see the zombie rows further down):

| skin | plain cells on disk | `_front_walk_left` cells | mean &#124;mid&#124; | max &#124;mid&#124; |
|---|---|---|---|---|
| homer | 190 | 0 | 0.3 px | 1.0 px |
| marge | 24 | 0 | 0.4 px | 1.0 px |
| bart | 33 | 0 | 0.3 px | 1.0 px |
| lisa | 149 | 0 | 0.4 px | 1.0 px |
| maggie | 12 | 0 | 0.8 px | 1.5 px |
| apu | 144 | 0 | 1.6 px | 3.5 px |
| nelson | 18 | 0 | 0.6 px | 1.0 px |
| mrburns | 39 | 0 | 2.1 px | 3.0 px |
| agnes | 24 | 0 | 1.8 px | 3.0 px |
| ralph | 18 | 0 | 2.5 px | 3.5 px |
| sideshowbob | 15 | 0 | 8.5 px | 10.0 px |

Every one of them ships **zero** side variants, which is consistent: there is
nothing to vary. `sideshowbob` is the only outlier, and he is a 6-px-tall-thin
drawing whose lean is his tie. The earlier "random sample of twelve skins, all
face right" verdict in this note was an eyeball call on thumbnail sheets and is
retracted — it was looking at costumed and profile-drawn skins and generalising
to the crowd. Homer's base cycle is `Homer_Front_Walk_image_1..4.rgb`, 4 poses
held 4 frames each, ink centred at +0.0/−1.0/−1.0/−2.0 px.

**Miss 2: the directional cycles do turn around, by name.** The cycles that
are actually drawn in profile — the zombies, the costumed and job variants —
ship *both sides as separate cells*, and the engine asks for them by composed
name. Counting the per-cell `.bcell` files under `web/assets`: **6 214** names
contain `walk` + `left`, **6 204** contain `walk` + `right`, across 274 skins
(homer 546, jasper 516, bart 501, quimby 336, wiggum 324, …). The split is
clean by class:

* a costumed/job stem ships **only the pair** — `abe_hellfish_front_walk_left`
  and `_right` exist, `abe_hellfish_front_walk` does not;
* a base crowd cycle ships **only the unsuffixed** cell (table above).

So `§8`'s old "only five skins ship side walks" was an artifact of which pool
dump was on disk at the time, not of the data. Both classes, and the origin
line each sits on, are on one sheet:
`mapdump/registration/m4-walk-facing-neutral-vs-directional.png` — Homer's four
crowd poses (midpoints +0.0/−1.0/−1.0/−2.0 px), his pose 1 beside its own
mirror, then `zombiehuman1`'s plain cycle (+30, +31, +30.5, +30.5) above its
`_left` (−23, −24, −24.5, −24.5) and `_right` (+30, +31, +31, +30.5) cells.

**The engine composes the side name at runtime.** The `.rodata` suffix strings
`_left` (`0x356804`) and `_right` (`0x3cbde4`) have exactly six code sites, and
they sit together in one resolver at `0x1207430`–`0x12076d0` (plus a sibling at
`0x11f7e98`–`0x11f81a8`). Its shape:

```
ldrb w22,[x19,#117]            ; "prefer the right-facing variant"
cbz  w22, <plain-name path>
   add x1,_right ; bl 0x6ed618  ; base name + "_right"  (string append)
   bl 0x13d3a00                 ; c_str
   mov x0,x20 ; bl 0x1054c4c    ; look the composed name up in the animation set
   tbz w0,#0 -> miss            ; miss => eor w22,w0,#1 / eor w8,w8,#1
                                ;   -> toggles prefer-right and retries the
                                ;      other side
<plain path>: ldr x1,[x19,#104] ; the unsuffixed name, same lookup
   eor w22,w0,#1 ; if it missed, flip the preference for next time
   ...                          ; builds BOTH "<base>_right" and "<base>_left"
   b   0x10537c8(x20, rightStr, <global ""?>, 0, [x19,#120], [x19,#121])
```

i.e. try `<name>` + the preferred side suffix, look it up in the character's
animation set, and on a miss retry with the other suffix; the unsuffixed name
is the last resort and its result is cached in the preference byte at `+117`.
Two more booleans (`+120`, `+121`) are threaded into the final resolver along
with both candidate strings. `idle_left`/`idle_right` (`0x3bcc06`, `0x3ddbf8`)
are used the same way at `0xe72948`/`0xe72960`, so idles take a side too.

That the pairs really are two drawings of one pose, and not one drawing plus a
flag, was checked on the pixels:

* Mirror-image twins. Mirroring a `_right` cell about the **character origin**
  reproduces its `_left` twin at median IoU 0.89 (27/40 pairs ≥ 0.85), against
  0.63 with no mirror (0/80) and 0.71 when mirrored about the sprite's bbox
  centre. So the mirror axis is the feet/anchor column — which is also the
  origin the `.bcell` frame offsets are measured from, and the reason a
  composed-name lookup is enough: no transform has to travel with the cell.
* Which way the unsuffixed cell of a directional skin faces. Five skins ship
  the plain cycle *and* both named sides (`zombiehuman1`–`3`, `zombiepet1`–`2`).
  The plain cycle matches its own `_walk_right` cell at IoU 0.94–0.97 and
  matches `_walk_left` only after mirroring: the unsuffixed drawing of a
  directional skin **is** the right-facing one, and the composed lookup is what
  turns it around. Measured against the character origin,
  `zombiehuman1_front_walk`'s silhouette centre of mass sits +10.6 px with its
  bbox midpoint +30 px (frames 0–3: +30, +31, +30.5, +30.5); `_walk_right`
  gives +11.1 / +30 (…, +31.5, +31.5, +31) and `_walk_left` gives −4.4 / −23.
  See `mapdump/registration/m4-walk-facing-proof-zombie.png`.

**A draw-time mirror is not how a walk turns around.** Five independent lines:

1. *The cell format has no flip bit.* `bcell10`'s per-frame record is
   `f32 delay, i16 x_off, i16 y_off`; in `bcell13` the 7-float transform belongs
   to the ground-overlay layers only — "there is no sprite layer: the sprite is
   the frame's external image, drawn at scale 1.0 at (x_off, y_off)"
   (`tools/extract_assets.py`). Nothing in a cell can say "mirror me".
2. *The save format tracks flip for buildings only.* `LandMessage.BuildingData`
   carries `flipped = 7` and `flipState = 22`; `LandMessage.CharacterData` has
   no flip field at all — character, updateTime, positionX/Y, skin, skinBackup,
   subLandID, flags, pathCache (`re/proto_schema.txt`).
3. *All the flip vocabulary is building-side.* `Building::tryFlip`,
   `DirectionsToFlip`, `flipWithBuilding`, `ignoreBuildingFlipFile`,
   `CleanFlipped`, `SprayFlipped`, `VandalizedFlipped`, `Flippable`,
   `FlipParameters`, `MirrorFlipStateComponent` (a `BGBaseComponent`), and the
   asset-def trio `flippedname`/`flippedbsv3`/`flippedanim`. In the shipped XML
   `<DirectionsToFlip value="4"/>` appears only on Building decorations
   (fences, railings) and `flipped=` only on `<building>` placements.
4. *Direction is a file name, not a flag.* The engine resolves a walk by name
   out of the `MovePick`/`PriorityList` (§6), and when the shipped data wants a
   character to face the other way it names a second cell —
   `<Animation name="…_Left" flipped="…_Right"/>`. `flipped=` is a *pointer to
   another animation*, never a mirror request; both cells ship.
5. *No walk opts in.* The engine's `<Animation>` parser is `0x10a3d78`–
   `0x10a4044` (found by scanning `.text` for ADRP+ADD pairs that materialise a
   `.rodata` address). It is vtable-dispatched — `.rela.dyn` slots `0x1a26990`
   and `0x1a2c2c8` point at it, the vtable is `0x1a2c2b0`, whose typeinfo names
   the class `AnimationController` — and its constructor is `0x10a3a44`, which
   installs that vptr and calls the base constructor `0x10dcc98`. Each XML
   attribute is one bit of a **flags word at `obj+96`**, read-modify-written as
   `ldr w8,[x22]; and/orr; str w8,[x22]`, and the base constructor initialises
   the word to **6** — so two attributes default to true, which is exactly the
   pair the shipped data mostly writes as `false` (`idle` 74 false / 1 true,
   `shadow` 536 false / 10 true). `shouldFlipAnimation` is **bit 9** (set with
   `orr w8,w8,w9,lsl #9`, `0x10a3f9c`); an absent attribute leaves the bit as
   the constructor left it, i.e. **false**. So the switch is real, and walks
   never pull it — see the census below.

**The flip switch, and who actually pulls it.** Swept every pack on disk
(22 129 `gamescripts-r*` directories, 1 204 559 `<Animation>` elements):
`shouldFlipAnimation` is written 10 085 times — **912 `true`, 9 173 `false`** —
and in the newest pack (r497432) 8 true / 162 false. The claim made in an
earlier draft of this note, that no shipped script sets it, was wrong; it was
verified only against r64455, a pack from before the attribute existed.

What the census does settle:

* **Not one walk.** Of the 912 `true` in the whole corpus, zero name a walk or
  run. All 8 in r497432 are job *sequence* animations on vehicles and props:
  `Tool_Around_Town_Active`, `Mascot_Steamroller_Front/Back_Active`,
  `Mascot_Train_Front/Back_Active`, `Drive_A_Carriage_Active`.
* **It is authored per direction.** 21 of r497432's 5 324 `<MovePick>` blocks
  carry the flag, and the same animation gets *opposite* values in the
  left/right blocks (`loveandwar_jobs.xml`): `Tool_Around_Town_Active` is
  `true` at `x="-1"` and `y="-1"`, `false` at `x="1"` and `y="0"`. So the flag
  means "play this one drawing mirrored, for this walk direction" — the
  mechanism exists and is used, just not for the walk library.
* Where a job wants a real turn-around it names a second cell instead and
  leaves the flag false (`cirqueduspringfield_jobs.xml`:
  `Pickpocket_Strangers_1_Left` at `x="-1"`, `…_Right` at `x="1"`, both
  `shouldFlipAnimation="false"`), which is the same convention the walk cells
  use (`§6`).
* `characterFlip="true"` survives 3 times, all on
  `<EffectOverlay bsv3="robofunzo_*_hover.bcell" centerHorizontalByBoundingBox="true">`
  in `xmas2017_specialevents.xml` — an effect overlay, not a character. The
  thousands of `flipState` hits are `*_gameobjectbundles.xml` and
  `krustyland_startingland.xml`, i.e. the building-side flip of item 2–3.
* The draw-time reader of bit 9 is not in the binary's obvious path: the only
  two sites that load `+96` and test bit 9 (`0x134ab0c`, `0x134b220`) are
  field-by-field struct copies (`ldr w8,[x20,#96]; str w8,[x19,#96]`), so the
  flag is copied onto the instance and consumed downstream. Not chased; it
  cannot matter for walks, which never set the bit.

So the walk library splits cleanly. The crowd's symmetric cycles need no
facing decision at all; the directional cycles get theirs from a **name**,
composed at runtime as `<animation>_left` / `_right` and looked up in the
character's animation set, with the unsuffixed (right-facing) cell as the
fallback when only one side was drawn. Nothing in that path asks for a
draw-time mirror of a walk — which is why the game never moonwalks and why bit
9 stays unwritten by walks: the turn-around is content, not a transform. The
mirror *is* available (bit 9 of the flags word, census above) and is used, but
for job-sequence vehicles and props rather than the walk library.

**Consequence for the viewer:** ask for the side name first and fall back to
the plain cycle — which is what `walkCandidates` does, so the walk library
needs no general sprite mirror (`scale.x = -1`): it would be a no-op on the
symmetric crowd art that is centred, and it would break the directional cycles
whose left art ships, by mirroring the right cell a second time. The one mirror
the viewer does keep is the narrow stand-in of §6 — a plain (`_walk`/`_run`)
cell, only on the two steps whose authored side cell is missing, never an
authored `_left`/`_right` cell, and `walkPlan`'s `mir` flag is what carries it
to the draw. It flips about the **character origin**, not the frame's own box:
a frame hangs off the origin at `x_off`, so its box `[x_off, x_off+w]` mirrors
to `[-(x_off+w), -x_off]` and the texture is flipped inside that box — the same
rule the lab's stage uses (`translate` to the origin, then `scale(-1,1)`), so
what the eye tests there is what the map draws. The other thing the viewer must
not do is decide facing from a
dominant axis: `front`/`back` comes from the screen-`dy` sign and the side from
the screen-`dx` sign, per §6. If job-sequence animations are ever animated in
the viewer, honour `shouldFlipAnimation` per `<MovePick>` direction then — it
is the one place shipped data really does ask for a mirror.

**Settling it by eye rather than by argument.** `web/viewer/walk-lab.html`
(linked from the City View header as *Walk lab*) lays the four directions out
side by side: one section each for walking north / east / south / west, every
walk cell the skin really has (`NOT SHIPPED` for the ones that do not exist,
read from `bcell.php mode=anims` and the card JSON rather than guessed), the
cell the rule above currently picks, the side cell it wanted, the lean
measured in the browser from the pixels, a mirror toggle that starts on the
rule's answer (moving it is an override, moving it back clears the override),
and a note field per direction — all of which collapses into a paste-back
report that also prints the engine step each row is (`tile (0,-1)`, the shipped
`MovePick` asks `Back_Walk_Left`) so the four rows can be ruled on without
guessing what "north" means. The stem-group
dropdown steps from the bare `<skin>` cycle out to the costumed and job stems,
where the side art actually ships. Nothing on the page has to be believed: each
cell links its `sheet.png`, `manifest.json`, individual `mode=frame&n=` PNGs and
the `&debug=1` report, and a missing cell links the API answer plus the
`pool/<stem>.bcell` path it would live at. `tools/smoke-walk-lab.cjs` pins its
rule, availability, mirror rule, link targets and report format (87 checks; 152
with `--live`, which replays the real card and pool; `--report` also dumps the
paste-back text so the four rows can be read without a browser).

**Method note — what did not work, so it isn't repeated.** Inferring facing
from geometry is hopeless here. A self-mirror IoU is not a facing test: the
shipped IDLE loops — nothing in the game draws an idle facing left or right —
score a median 0.70 against their own mirror, because hand-drawn art is never
symmetric. And no silhouette feature separates the twins whose names already
state the direction: centroid AUC 0.48, leg-band 0.31, bbox centre 0.59, reach
skew 0.59, head-band 0.64 (best). Scoring the 3 209 plain cycles with the best
of those gives 48% right / 52% left — noise. Facing lives in the face and the
hands; it has to be looked at — **but only after the neutral/directional
question is settled, and never by eye at thumbnail size.** The eyeball pass
that produced this note's first, wrong answer read the sample sheets as "all
face right" because a 16-px-wide head reads as a nose pointing one way or the
other; the same skins measured against the origin come out at 0.3 px. The
order that works is: (1) bbox midpoint vs the character origin — over ~15 px
means the art has a facing, about 0 means it does not; (2) only for the
directional ones, the two pixel tests — known-twin pairing, and
plain-vs-own-`_right`.

## 9. The pack census: "the asset does not exist", finally earned

The claim in §8 — that `homer_front_walk_left` does not exist — was **not
earned** when it was first written. Every asset fact in this project came from
the sprite pool at `/tmp/opencode/citypool`, and that pool is a **filtered
extraction**: `tools/gen_city_sprites.py extract` pulls the slugs the save
asks for, `backfill` widens it to the candidate rows. Neither is a statement
about the CDN. "Not in the pool" had never meant "not shipped", and the
question deserved the packs' own answer.

**Ask the packs.** Every shipped pack is a double container — a `.7z` bundle
in `cdn/` holding inner `<Family>-r<rev>-<TAG>.zip` packs, and each inner pack
holds entry `0`, a `BGrm` **manifest** listing the pack's asset paths, plus
entry `1`, the 45 MB art blob. The manifest is ~60 KB, so the complete name
inventory of the CDN costs one `7z` pass per bundle and a regex over a few KB
per pack, never touching the blobs. `tools/scan_pack_manifests.py` does it
(`scan --worker N --workers M`, resumable per bundle; `report --grep`; `merge
--dest`); `tools/smoke-scan-pack-manifests.py` pins the parser.

The parser is the part that had to be right. A plain regex over the manifest
yields names like `-lisa_go_trick_or_treating_active_right.bcell` and
`6homer_ninja_front_walk.bcell`, because a record's **length byte is often
itself a printable word character** (`44` = `-`, `53` = `6`, `109` = `n`) and
a backward-walking `[a-z0-9_.-]+` swallows it. Records are parsed structurally
instead, anchored on the name's second copy:

    … <name>\0 <extlen+1> <ext> \0 <namelen+1> <name> \0 …

and both length bytes must agree with what was captured. Control:
`WhackingDayGame-100-r23893` carries 255 `\x06bcell\x00` markers and the
parser returns exactly 255 names, 0 rejected — and all 255 exist in the pool,
so nothing is silently dropped.

**Coverage** (`data/pack_census.tsv`, provenance in its `#` header): 505
bundles carrying content (6 of 511 are 178-byte empty stubs), **22 481 packs**,
**15 768 unique `.bcell` names**, no worker failures. Cross-checked against
the pool both ways: 145 names the CDN ships and we never extracted (all
`shadows_*`/event art, e.g. `shadows_pet_walk`), and 6 pool files no manifest
lists (`baby bear_*` — names with spaces, which the manifest layout escapes
differently). Both directions are explained; the census is now the authority,
and `api/bcell.php?mode=census&name=X` answers the question per cell:
`{name, in_pool, shipped, packs, sample_pack, verdict}`.

**What it says:**

| probe | packs shipping it |
|---|---|
| `homer_front_walk` | **235** |
| `homer_front_walk_left` / `_right` | **0 — by no pack** |
| `wiggum_front_walk_left` / `_right` | 16 (`Krustyland2Game-100`) |
| `wiggum_front_walk` (plain) | **0** |

Wiggum is the mirror image of Homer and that is the whole point: a skin is
authored *flat* or *sided*, and the shipped content honours it both ways.
Grouping every walk cell by `(stem, front|back)` gives 4 626 groups:
**3 855 ship only the plain cycle, 755 ship only a left/right pair, and 16
ship all three** (zombies and pets — the ones with a real turning-around
need). And side twins are **authored in pairs**: of 2 275 `_left`/`_right`
bases, **2 270 ship both**, and the 5 exceptions are not walks at all
(`moe_respectable_fun_in_limo_*`, `ned_devilflanders_victory_animation`).
If the client mirrored missing sides at runtime, one-sided pairs would be
harmless; the content says they essentially never happen.

**And they are not lazy flips.** Compositing the twins of
`homer_conductor_front_walk` on a shared canvas (frames placed by their own
`x_off`/`y_off`, then mirrored about the origin) gives alpha IoU **0.975**
with 20.9 % of pixels differing by more than 24 — the same drawing redone,
not the same pixels reused — while `zombiehuman1`'s twins reach only **0.676**:
two independent drawings. So even where mirroring *would* have been enough,
the artists drew both cells.

### The shipped config names the fallback, so nothing had to be generated

`gamescripts-r497432/data/controllers.xml` is the file the wander path
actually runs: `<DefaultController name="FullMoveGroup_Attract"/>` attaches
one of its `MoveGroup`s to every `FullMoveGroup` character (`characters.xml:1286,1298`,
24× in `promocharacters.xml`, `mattgroening_characters.xml`). Its four walking
`MovePick`s are (`controllers.xml:143–180`):

    <MovePick x="-1" y="0"><PriorityList>
        <Animation name="Front_Walk_Left" /><Animation name="Front_Walk" />
    </PriorityList></MovePick>          … and so on for (0,1) (0,-1) (1,0)

Those are **relative** names, resolved per character: for the base skin the
lookup order at runtime is literally `homer_front_walk_left` → `homer_front_walk`.
The side name is asked for, the plain cell is the **declared fallback in the
same PriorityList**, and the miss is designed-in — not a hole in our index.
Corroboration for §6 comes for free: those four grid steps are exactly
consistent with `screen_x = gx + gy`, `screen_y = gy − gx`, i.e. facing from
the screen-`dy` sign and side from the screen-`dx` sign — derived here from a
second file, independently of the job XML.

Three more local facts close the "or does some config ask for a mirror?"
branch. (1) 61 `MoveGroup`s exist in that pack; **21 name side names, 23 name
only the plain walks** — and `NoLeftRightMoveGroup` (`controllers.xml:181`) is
the explicit plain-only controller, used by `thoh2018_skins.xml` six times:
plain-vs-sided is an authoring choice the config states outright. (2) Side art
exists exactly where a `*skins.xml` entry names it
(`characterskins.xml:274`, CoolHomer: `Front_Walk_Left="coolhomer_Front_Walk_Left"`
…), and across 945 walk-side `AnimationRemap` values and job `MovePick`s in
that pack, **zero name a side cell that has no art**. (3) There is **no
character-side equivalent of `data/flip_assets.json`**: the card JSONs
(809 files) contain no flip-ish key at all, and the `.bcell` containers carry
no mirror bit either — every field the decoders skip was measured (bcell11
`n_layers` = 0 in all 5 099 records, bcell13 filler byte = 0 in all 273 474,
bcell10's unread u32 and record-tail bytes are cell-level constants and an
end sentinel), and none correlates with sidedness. Left/right twins differ
only in the embedded image name and the per-frame offsets.

**Verdict, from both directions.** The engine's resolver (
`0x1207250`–`0x1207754`, rizin-disassembled) composes `<name>_left`/`_right`,
tests it with the pure predicate `bl 0x1054c4c`, and on a miss toggles its
preference byte (`ldrb/eor #1/strb [x19,#0x75]`) and plays the **base name
with the global empty string** as the side (`0x12076cc`, via `0x10537c8`).
No code path on a miss creates, registers or flips an animation. The two
booleans this note left unresolved are now bound, from the ctor at
`0x1206f1c`: `+117 appendLeftRight`, `+118 autodetectFlip`, `+119 invertFlip`,
`+120 loop`, `+121 shadow` — and `invertFlip` only sets **bit 4 of the actor's
word at `+620`**, a facing bit, not a scale. Every flip mechanism in the binary
is name selection, a facing bit, or the building/object flip subsystem.
Mirroring in this engine is always content-authored
(`animation="I_Love_You_Left" flipped="I_Love_You_Right"`), never a transform
applied to a walk.

So for the base crowd the answer to "walking west should be
`homer_front_walk_left`" is: it *is* what the client asks for, it genuinely
does not exist in any of the 22 481 packs, and the client plays
`homer_front_walk` because its own PriorityList says to. A blanket client-side
mirror would still be wrong — it would double-mirror the sided skins whose left
art really does ship, and the resolver above has just shown that the engine
itself never flips a walk — so the viewer's mirror is narrowed to exactly the
case this evidence leaves empty: a **plain** (`_walk`/`_run`) cell, reached only
after the authored side cell missed, on the **two** steps whose authored cell
would have faced the other way (`(back && right) || (front && left)`). That is
the user's ruling from the walk-lab eye test, recorded as a deliberate deviation
in §6; the other two steps play the plain cycle as authored, and a skin that
ships its own side art is drawn as authored everywhere.

## 10. Still open

* ~~The four direction picks are awaiting the eye test~~ — the eye test came
  back, twice (§6). The first pass asked for the away-facing `back_walk` on
  west; the second pass retracted that and is the rule as it now stands: the
  plain cycle on all four steps, **mirrored** on the two whose authored side
  cell a flat skin does not have. So the open part of the claim is narrower
  than it was, but it is still open: only **homer** has been looked at, on one
  save, at one zoom. The census (§9) and the resolver (§9) both say the flat
  cycle is what the game ships for him, so a walk that still looks wrong is
  about the *projection or the anchor* — not the choice of cell. Worth doing
  next: the same four rows for a dozen more crowd stems in the lab (the
  stem-group dropdown reaches the costumed stems, where the side art does ship,
  which is the check that the authored cell still wins unflipped), and a look
  at a running town rather than four side-by-side loops — the mirror is only
  noticeable in motion.
* The dwell/radius values: any of them could be pinned by finding the wander
  driver function's constants. The strings are gone, so the next step is
  following `startIdleMovement`'s caller chain in the tracer and reading the
  immediates it seeds the timer with.
* Whether the engine biases targets toward *other* characters (the game reads
  as a crowd that occasionally converges). Nothing recovered here says so.
* `RoadOnly`/`BoardwalkOnly` — if a mode is ever wanted per character, the cost
  grid is already per-surface, so it is one predicate away.
* `shouldFlipAnimation` is a real per-animation mirror switch (§8), and shipped
  data does use it — 912 times in the corpus, always on job-sequence vehicles
  and props, authored per `<MovePick>` direction. It is set on **no walk**:
  walks turn around by composed name, not by transform. If job sequences are
  ever animated, honour the flag per direction rather than mirroring
  unconditionally.
* ~~The side-name resolver is read but not completely understood~~ — settled
  (§9): the attr-to-field bindings are `+117 appendLeftRight`,
  `+118 autodetectFlip`, `+119 invertFlip`, `+120 loop`, `+121 shadow` (ctor
  `0x1206f1c`), the miss path plays the base name with an empty side string,
  and the base name is the `PriorityList` `<Animation name>` resolved against
  the character's skin prefix (`AnimationRemap` does the per-skin renaming).
  Still not read for its own sake: the global string at `0x1abc000+2736`.
* **Why some stems ship side art and some do not is now answerable but not
  closed.** Measured, per `(stem, front|back)` walk group: 3 855 plain-only,
  755 sided-pair-only, 16 both (§9). It is not geometry — the lean test fails
  as a class predictor (TP 182 / FP 722 / FN 467 / TN 2 483, medians 9.5 /
  11.5 / 9.0 px, statistically flat), and prop-carrying cycles are the worst
  false positives (`opal_give_away_gifts` 119.5 px with no side art). What it
  does track is **authoring intent**: the config states it outright — 21 of
  61 `MoveGroup`s name side names and 23 name only the plain walks
  (`NoLeftRightMoveGroup` is the explicit plain-only controller,
  `controllers.xml:181`), and a skin gets side art where a `*skins.xml`
  `AnimationRemap` names those cells. The local half of the proof is that
  every config-named side cell has art; the missing half is the reverse
  implication per era, which needs the pack→name map this census now has
  (`data/pack_census.tsv` records a sample pack per name, and first-seen
  bundle grouping says both classes are live in the 4.x era, so it is not a
  style that changed over time).
* `bcell12` is a **fifth container format nobody decodes**: 26 cells in the
  pool, all event critters (`bunny01/02/03`, `chirpyboybartjr`,
  `theeggcouncilguy`), bcell13-shaped frame records plus `SHADOW` ground
  overlay layers, and their `_image_N.rgb` are absent from the dump.
  `tools/extract_assets.py` handles 10/11/13 only, so those 26 cells are
  silently unavailable to the pipeline, the API and the lab.
* Whether an idle ever actually plays a `_left`/`_right` variant in the crowd
  path: the strings are used at `0xe72948`/`0xe72960`, but the crowd idles ship
  no side cells, so it may be a path only costumed/job characters take.
