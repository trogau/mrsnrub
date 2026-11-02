# 08 — RoadDrawer reverse-engineering (definitive, 2026-10-25)

The engine-side truth about how road sprites go together, from direct RE of
`lib/arm64-v8a/libscorpio.so` (extracted from `Springfield-V08.apk`, vaddr ==
file offset). This **supersedes every guess** in `notes/06` §10 and the
"base tile + clipped kerb/paving band pieces" model that `road-lab` used to
demonstrate and that `city-view-pixi.js` `Road art·spec` textured mode
implements. Where this note and older notes disagree, this note wins.

The **art** side of the same subject — sheet provenance, the lattice geometry,
what each cell's art actually contains, the unused river cells, and the shipped
Pixi draw recipe — is `notes/09-road-tiles.md`.

Raw working material (kept outside the repo, regenerable):
`/tmp/opencode/road-selector-findings.md` (selector, full 64-cell table +
method), `/tmp/opencode/road-draw-findings.md` (draw pass),
`/tmp/opencode/sel.asm`, `sel2.asm`, `gen.asm` (rizin dumps), and the
subagent artifacts under `/tmp/opencode/re/` (`emul.py` full-function
emulator, `verify_raw.py` raw-byte branch verification, closure outputs).
Evidence images for review live in `mapdump/registration/`:
`m4-re-sheet-states.png` (sheet with the 11 marked UV diamonds) and
`m4-re-states-triples.png` (per state: raw box | diamond clip | as-drawn
world square, bilinear-sampled with PIL).

Tooling notes: no `r2`; use `rizin -qc "pd N @ 0xADDR" file` (one `-c` per
command, strip ANSI with `sed 's/\x1b\[[0-9;]*m//g'`; `af`/`axt` unreliable
on this binary — prefer targeted `pd`/`pdj` + python `struct` scans; BL
pattern `(w>>26)==0x25`; ADRP must mask the pc low 12 bits; vtable pointers
come from `readelf -r` R_AARCH64_RELATIV addends).

## 1. Objects and entry points

RTTI name `10RoadDrawer` at `0x4006a0`; vtable at `0x1a3e0e0` (RELA addends):

| slot | addr | role |
|---|---|---|
| +0x10 | 0x1207edc | (setup) |
| +0x18 | 0x1208034 | per-cell record lookup wrapper |
| +0x20 | 0x10d684c | stub |
| +0x28 | **0x1208c04** | **generate**: item loop, emits all geometry |
| +0x30 | **0x1209814** | batch build: 64×64 window cull + instance register |
| rest | 0x10d63xx… | generic stubs |

Small caller `0x1099c38` `bl 0x1209814`, copies floats at +0x70/74/78 into
the batch at +0x14/24/34 (stride 0x10 batch params), tail-calls +0x28.

The selector `0x1208058` has **no BL callers**: `0x1208c04` hard-loads its
address into `x20` at entry (`adrp x1,0x1208000; add x1,x1,#0x58` @
0x1208c04–0x1208c08) and calls it via `blr x20`. The selector contains the
**only** code references to the 11-entry UV table.

## 2. The 11-entry UV quad table (`.rodata 0x400520`)

11 × 32 bytes = 8 float32 = four (u,v) corners in order **T,R,L,B** —
f01 = top vertex, f23 = right vertex, f45 = left vertex, f67 = bottom
vertex of the slot's inscribed sheet diamond (corrected from the earlier
"L,T,R,B" guess; measured 2026-10-25 by overlaying each quad on
`roadtilesheet.png`), ×512 = pixel coords on the 512×512
`roadtilesheet.png` (roadrivertiles-50; the -100 packs are the identical layout
at 2×, so the normalised UV = px/512 addresses every tier — the viewer draws
from the 1024² `-100` sheet since 2026-10-27, `notes/09` §6). Verified
properties:

* Every entry is a **parallelogram**: f01 + f67 == f23 + f45 (to ~0.5 px on the
  512² sheet — re-measured 2026-10-25: max 0.49 px, median 0.26 px, i.e. float
  rounding plus by-eye art alignment, **not** bit-exact — so always use all four
  corners rather than deriving one from the other three). So
  bilinear mapping of a world square onto the quad is an exact affine
  shear — the GPU draws a plain textured quad and the "diamond" is just a
  sheared UV rect. As a screen transform (north-up, x east, z south) the
  emitter's corner assignment (see §5: f01→(minX,maxZ), f23→(maxX,maxZ),
  f45→(minX,minZ), f67→(maxX,minZ)) is **rot45 with the box's v axis
  NEGATED** — `x = k(u+v), y = k(u−v)`. A plain rot45 transposes the art
  across the main diagonal (kerbs land on the wrong edges); this was
  pixel-verified against the kerb art of every state.
* Slot lattice (sheet space): slot (c,r) centre =
  (274 + 135·c + (r odd ? 67.5 : 0), 140 + 37·r); 135×74 diamond lattice,
  art inset to a 127×66 box — the box corners sit **outside** the diamond
  and contain packing junk that is never sampled.
* Entry 11 (at `0x400680`) is the **identity full-[0,1]² quad**
  `{0,0, 1,0, 0,1, 1,1}` — the fallback table used by the draw pass when
  the selector pointer is null (see §5), not kerb parameters.

The state index ↔ sheet slot mapping is the existing `SHEET_STATES` table
(`web/js/terrain.js`): `[(-1,7),(-1,5),(-1,6),(-2,5),(-1,4),(-1,1),(-2,1),
(-1,-1),(-1,3),(-2,3),(-1,2)]` for states 0–10.

State meanings — art content pixel-classified 2026-10-25 (per-edge bright
sidewalk/kerb percentage inside each UV diamond, mapped through the true
corner assignment; see `mapdump/registration/m4-re-states-triples.png`
which shows raw | diamond clip | world square | flipped world square):

| state | quadrant | art (kerb/sidewalk lands on the CLOSED edges) |
|---|---|---|
| 0 | any | full paving slab — interior (flag-byte fast path) |
| 1 | NW / ES† | neither edge open — kerb corner W+N (ES draws mirrored → E+S) |
| 2 | NW / ES† | both open — plain paving, small kerb at outer corner |
| 3 | NW / ES† | first edge only — kerb band along W (ES mirrored → S) |
| 4 | NW / ES† | second edge only — kerb band along N (ES mirrored → E) |
| 5 | NE | neither open — kerb corner N+E |
| 6 | NE | both open — paving, small kerb at outer corner |
| 7 | NE | one open — kerb N (E-only case); N-only case drawn mirrored → kerb E |
| 8 | WS | neither open — kerb corner W+S |
| 9 | WS | both open — paving, small kerb at outer corner |
| 10 | WS | one open — kerb W (S-only case); W-only case drawn mirrored → kerb S |

† ES quadrant gets the selector flip byte forced to 1 for every result
(§3), which mirrors the sampled rect and maps the W/N kerb art onto E/S.

## 3. The selector — `0x1208058`

`selector(this /*x0*/, packedX /*w1*/, packedY /*w2*/, out /*x3*/)` → x0 =
pointer to one of the 11 UV quads (never NULL on valid subcoords); writes an
out byte. Coordinates: `cx = w1>>2`, `cy = w2>>2` (cell = 4×4 tiles),
sub-coords `xsub = w1&3`, `ysub = w2&3`, which **must** be from {0,2}² (odd
values fall through to the loop epilogue with x23 unassigned → infinite
loop — caller contract).

Record accessors (the 8-byte per-cell record, byte[4] holds the flags):

| addr | reads | meaning |
|---|---|---|
| `0x1134fa8` | `byte[4] & 0xf` | **connectivity nibble** |
| `0x1134cf0` | `bit4(byte[4])` | neighbour **solid** flag |
| `0x1134cfc` | `bit5(byte[4])` | **special** flag ⇒ state 0 immediately |
| vtable `+0x30` | — | neighbour `contains(x,y)` test |
| vtable `+0x18` | — | neighbour record fetch |

**Nibble bit directions (verified against the neighbour query coordinate
slots):** bit0 = **E** (cx+1,cy), bit1 = **W** (cx−1,cy), bit2 = **N**
(cx,cy−1), bit3 = **S** (cx,cy+1). This matches `Terrain.decodeCells`
(E=1 W=2 N=4 S=8) — the save-side masks already agree with the engine.

Each aligned quadrant path tests **only the two edges it touches**:
(0,0)→N,W · (2,0)→N,E · (0,2)→W,S · (2,2)→E,S. Define

    Pass_d = nibble_bit_d OR (contains(d) AND solid(record(d)))

(the bit "trusts" the edge; otherwise the neighbour is probed — if the
contains-test fails the solid bit is irrelevant). Then the family table,
with leaf addresses (exhaustively verified by emulating the whole function,
`re/emul.py`, branches cross-checked raw-byte-exact against rizin):

| quadrant | both pass | one pass | none | leaves |
|---|---|---|---|---|
| NW (N,W) | **2** | N-only **3** / W-only **4** | **1** | 0x12088b8 / 0x1208864 / 0x1208880 / 0x1208390 |
| NE (N,E) | **6** | either **7** | **5** | 0x12088c8 / 0x12087ac,0x12087d4 / 0x1208238 |
| WS (W,S) | **9** | either **10** | **8** | 0x1208900 / 0x1208800,0x1208824 / 0x12084d8 |
| ES (E,S) | **2** | E-only **3** / S-only **4** | **1** | 0x12088b8 / 0x1208864 / 0x1208880 / 0x1208650 |

Extra rules:

* `*out` is forced to 1 unconditionally on the (2,2) path entry (0x1208644)
  and set by the cmp-block routes (0x120883c).
* Special flag (byte[4] bit5 of the **center** record) ⇒ state **0**
  returned immediately at 0x12088a8 for any subcoord, before dispatch.
* No record / empty candidate list behaves as nibble 0 with all neighbour
  probes failing: (0,0)→1, (2,0)→5, (0,2)→8, (2,2)→1.
* NULL is never returned on aligned subcoords (loop-back `cbz x23` retries
  until the family default is assigned).
* Multiple road candidates per cell escalate partial results: prior k3 +
  later k4 (or vice versa) ⇒ exit k2; prior k7 + certain re-visits ⇒ k6;
  prior k10 ⇒ k9 (the "two half-connections make an interior" rule).
* The `tst w21,#1` + `csel x23, …` pairs are a **first-candidate-wins flag
  for multi-candidate cells**, NOT a parity variant chooser — there is **no
  parity/coordinate-dependent variant selection anywhere** (earlier
  readings of these as parity gates were wrong; w21 is reused as coordinate
  scratch strictly after its last `tst`).

The full 64-cell per-nibble enumeration (all contains/solid combinations,
witnesses) is in `/tmp/opencode/road-selector-findings.md` §5.

## 4. The draw pass — `0x1208c04` (+ emitter `0x12095e8`)

Verdict: **each road item draws 4 quadrant quads, each sampling ONE full
UV rect. There is no base+clip composition, no kerb/sidewalk second pass,
no overlay geometry.** The kerb and paving art lives *inside* the state
slots themselves — the 11 states are complete quadrant images.

* `0x1208c04` callocs `1,0x20000` (0x1208ee8) = 4096 × 0x20-byte records
  (a 64×64 cell window), runs the count pre-pass `bl 0x1208aa0` (adds
  exactly 1 per visible item, 0x1208b3c), then sizes the shared vertex/index
  buffers `count×320B` = count × **4 quads × 4 verts × 20B** and `count×48`
  indices (0x1208f24–0x1208f48).
* Item iteration: `bl 0x118dd48` / `bl 0x118dddc` (diagonal 15-step scan of
  the row array at `[grid+0x108]`); call-site math decomposes
  (block, block, diag) into quarter-tile packed coords.
* **Per item: 4 selector calls + 4 emit calls**, `w3 = 0..3` (selector
  `blr x20` @ 0x1208ff4 / 0x1209088 / 0x120911c / 0x12091b8; emit
  `bl 0x12095e8` @ 0x1209010 / 0x12090a4 / 0x1209138 / 0x1209388). The
  quadrant bits are `bfi`'d into the selector args only (0x1209078 etc.)
  and the args are then restored for the emit call — all four emits get the
  identical tile position; the quadrant distinction is `w3` + the per-
  quadrant selector result.
* Vertex format `(x, y=0, z, u, v)` — 5 × float32, **stride 0x14** (20 B);
  the emitter scatters the 8 UV floats of the chosen quad into the 4
  per-vertex UV fields; the 32-byte descriptor is never stored. Runtime
  floats: `*(0x1abc0ac8)` = world scale S, `*(0x1ac0260)` = UV scale.
* **Flip**: the flip byte (`w5` to the emitter) swaps the corner pair
  (f2,f3)↔(f4,f5) — a diagonal mirror done as a UV corner permutation
  (equivalent to mirroring u across the parallelogram). In the emitter
  this is the `csel` cascade around 0x1209724–0x1209730. Source: the
  selector's out byte — **forced to 1 on the entire (2,2) path**
  (0x1208644), so the ES quadrant always draws the shared corner family
  mirrored (that is how W/N kerb art serves the E/S edges), and set on
  the NE/WS one-edge-open cmp routes (0x12087cc / 0x120883c) so state 7
  mirrors for the N-only case (kerb → E) and state 10 mirrors for the
  W-only case (kerb → S). Consistency proof: without these flips the
  shipped art (state 3 kerb W, 4 kerb N, 7 kerb N, 10 kerb W) would put
  kerbs on OPEN edges for ES / NE-N-only / WS-W-only.
* Selector-absent fallback path (`cbz x20, 0x12091d4` @ 0x1208f8c) uses
  the identity full-rect quad at `0x400680` with flip forced 0 — i.e. a
  plain sheet-clamped full-texture quad.
* The tail (0x12093b4–0x12095bc) is batch submission only (wrapper vtable
  `0x1a028f0`, virtual call `[batch]+0x58` with the buffers). `0x1209814`
  (vtable+0x30) computes per-cell world centres
  `((i%64 + baseX + 0.5)·16S, (i>>6 + baseY + 0.5)·16S)` and registers
  instances — no vertices.
* Exhaustive call/data scan of 0x1208c04–0x12095e8: the only `.rodata`
  float refs are the UV table and the identity quad; the only globals are
  S, the UV scale, and the device singleton. **No second table, no extra
  record allocation, no strip/kerb geometry anywhere.**

## 5. What this means for the viewer

* `RoadDrawer` granularity is **per quadrant of the 4×4-cell** (sub-coords
  {0,2}²), each quadrant independently choosing one of the 11 states from
  its two cell edges. A road "cell" render = 4 half-cell quads.
* The textured spec mode in `city-view-pixi.js` (`Road art·spec`) must
  therefore be **4 quadrant blits per cell, one full slot rect each** — the
  previous base-state + per-side clipped band pieces were an invented
  model that does not exist in the engine (`specClipPoly`/`__specpieces`
  machinery should go).
* Because the quads are parallelograms, the existing per-slot
  rot45/√2-scale transform is exactly right — just applied per half-cell.
* `Terrain.decodeCells` nibble bits already match the engine direction
  convention (E=1 W=2 N=4 S=8); pass-rule modelling in the lab is
  `bit OR (contains AND solid)` per edge.
* The flat-colour `ROAD_ART` tuning (0.75/2.5/0.75 etc., `notes/06` §10)
  remains the user-approved presentation for the FLAT spec mode; this RE
  only rewrites the *textured* composition model.
* The `road-lab` sheet inspector (`web/viewer/road-lab.{html,js}`,
  section "road art sheet") now demonstrates this true model: 11 states
  raw-box + parallelogram, a live cell built from 4 quadrant quads with
  `nw#/ne#/ws#/es#` pick labels, mask E/W/N/S + neighbour-solid probe
  toggles (pass rule), force-state override, flip, and a copyable
  `ROAD_ENGINE` reference block. Harness: `tools/smoke-road-lab.cjs`.

## 6. Pixi viewer parity notes (verified 2026-10-25)

Porting §4's four-quadrant draw into `city-view-pixi.js` spec mode
(`Road art·spec`) took three iterations; the notes below are the conclusions
that survived, in the order they were learned. Tooling: `road-lab.js` (canvas
inspector, engine model = source of truth, harness `tools/smoke-road-lab.cjs`),
and two offline bilinear PIL replicas of the GPU draw —
`/tmp/opencode/re_pixi_sim.py` (coverage audit) and
`/tmp/opencode/re_pixi_shear.py` (model comparison + overdraw measurement).

* **Transform order.** `pixi.min.js` composes the sprite matrix as
  `a=cos·scaleX, b=sin·scaleX, c=−sin·scaleY, d=cos·scaleY`
  (`updateLocalTransform`, skew 0) with the anchor subtracted in LOCAL space
  — i.e. world = T·R·S, byte-for-byte the lab's
  `translate → rotate → scale`.
* **Corner assignment (easy to get wrong).** The engine assigns the slot
  diamond's four points to the quad's corners as `T→BL, R→BR, L→TL, B→TR`,
  and the flip byte swaps the table entries `(f2,f3)↔(f4,f5)`, i.e. re-assigns
  `TL→R, BL→T, TR→B, BR→L`. Swapping both pairs (or mirroring instead of
  permuting) yields a non-parallelogram and half of each quadrant comes out
  empty — the "triangular hole" signature. It was a bug in the replica first,
  which is how the signature got documented.
* **A rotated sprite cannot express a UV quad.** A Pixi sprite maps the WHOLE
  frame through rotation+scale, so rotating the 127×66 slot box by 45° draws
  the box's CORNERS as a diamond whose half-diagonals are the quadrant's side:
  **twice** the quadrant's area (measured 1.75–2.0× in the replica). With
  transparent frame corners that overdraw is invisible; make them opaque (a
  mean-paving backing) and every quadrant paints four grey triangles over its
  neighbours — the artifacts in the 2026-10-25 `roads.png`. The engine has no
  corners to hide: the quad's four vertices *are* the UV parallelogram, so
  nothing outside it is ever rasterised and nothing is ever blended.
* **Therefore: draw the UV quad itself.** Since 2026-10-27 the viewer does
  exactly what the engine does: each quadrant is a 4-vertex `PIXI.Mesh`
  (`quadMesh`/`quadGeom`) over the half-cell square whose UVs are the four
  `0x400520` corners / 512 (`ROAD_QUADS`), sampling the 1024² sheet once —
  `notes/09` §6. *History:* the 2026-10-25 fix was to bake the parallelogram
  and draw it unrotated — `buildSpecSlots`
  rasterised the UV map itself — bake pixel (i,j) samples the sheet at
  `O + ((i−PAD)/127)·E + ((j−PAD)/66)·S`, unflipped `O=L, E=B−L, S=T−L` — so
  the frame `(PAD,PAD,127,66)` *is* the slot parallelogram, and
  `buildSpecCell` draws each quadrant as a plain sprite at
  `scale(hs/127, hs/66)`, no rotation and no clip. The 2 px margin carries
  real (extrapolated) art, so edge filtering never reads a transparent texel
  or another state's slot, and the bake is composited over an opaque fill so
  the quad is opaque like the engine's.
* **The flip is a baked orientation, not a mirror.** In the sheared
  parameterisation the flip byte's permutation is the ANTI-DIAGONAL reflection
  `O=R, E=−(T−L), S=−(B−L)`; a plain horizontal mirror is wrong (replica
  diff: correct d≈1 vs mirror d up to 43 per channel). Both orientations are
  baked per state (22 small canvases, `specSlotTex(state, flip)`) so the
  sprite never used a negative scale. That bake upscaled the 512² sheet 2× and
  resampled twice (the "blurry roads" report); the meshes keep its corner map:
  unflipped TL→L TR→B BR→R BL→T, flipped TL→R TR→B BR→L BL→T.
* **Verification.** Replica vs the approved reference draw: mean |Δ| 0.77 per
  channel, 0.15% of pixels differ by >40; single-quadrant painted area is
  exactly the quadrant (ratio 1.000, where the rotated-box model measured
  1.75); coverage audit over every nibble 0–15 plus `P` at t = 2…26 px/tile:
  0 uncovered, 0 partial pixels. Evidence renders:
  `mapdump/registration/m4-pixi-town-compare.png` (broken vs reference vs
  fixed on a street grid), `m4-pixi-shear-check.png`, `m4-pixi-sim-z{10,26}.png`.
* Legacy sheet modes 1–3 (`_sheetTile`/`SHEET_TABLE`, positive-sy fakes) are
  deliberately untouched: only `sheetArtMode === 4` uses this path, and
  `avenC` (legacy avenue sprites) is hidden there.
