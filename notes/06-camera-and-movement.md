# 06 — Camera & character movement (local game setup replication)

Second RE pass on **`libscorpio.so`** (AArch64), focused on the user's goal:
**replicating the local game setup** — camera behaviour and character
movement — for the web port. All addresses below are virtual addresses in
the arm64 `libscorpio.so` (file offset == vaddr for `.rodata`/`.text`/
`.data.rel.ro`-adjacent regions; `.data.rel.ro` vaddr = file + 0x1000).

Cross-reference data used here (disposable, in `/tmp/opencode/rz/`):
`xrefs.json` (rizin `axlj`, 7.03M), `funcmap.json` (`aflj`, 88,201 fns),
plus PLT/GOT maps built this session (`plt2sym.json`, `got_map_full.json`,
`gl_calls.json`).

---

## 1. Rendering pipeline: modern GLES2, camera math is 100% CPU-side

- The import table (481 imports) contains **no fixed-function matrix calls
  at all** — no `glMatrixMode`/`glLoadIdentity`/`glFrustumf`/`glOrthof`/
  `glRotatef`/`glTranslatef`/`glScalef`. Only the shader pipeline:
  `glCreateShader/Program`, `glCompileShader`, `glLinkProgram`,
  `glBindBuffer`, `glBufferData`, `glMapBufferOES`/`glUnmapBufferOES`,
  `glTexImage2D`/`glTexSubImage2D`, uniforms, `glViewport`, `glScissor`,
  `glClear`, `glUseProgram`, `glValidateProgram`.
- The bundled shaders (`web/assets/data/UberShader.vsh`, `2DShader.vsh`)
  are trivial: vertex = `position * matWorldViewProj`. **All camera math
  (pan/zoom/rotation/projection) is computed on the CPU and uploaded as
  matrix uniforms.**
- Uniform names found in the binary (referenced from the GL-state
  init code at `0x1453e30`–`0x1453e8c` inside `fcn.013de444`):
  `matWorld`, `matWorldViewProj`, `matWorldView`, `matWorldViewInv`,
  `matView`.
- **PLT/GOT layout of this binary** (needed to find any import call site;
  verified byte-exact):
  - Imports bind via two relocation kinds: `.rela.dyn` R_AARCH64_JUMP_SLOT
    (734, libc/protobuf) **and** `.rela.plt` type **1026** (6,068 — all the
    GL/other imports; `r_addend=0`, so not real IFUNC resolvers, just
    import bindings). GOT slots for the 50 GL/EGL imports all live on page
    `0x1ac3000`.
  - The PLT is a run of **16-byte stubs** at the tail of the R+X segment
    (`0x19b0000`–`0x19d5870`; a second uncalled table starts `0x19bdd30`):
    `adrp x16,page; ldr x17,[x16,#imm]; add x16,x16,#imm; br x17`.
    **BR x17 encodes `0xd61f0220`** (register-branch Rn is in bits [9:5]).
  - Call sites are plain `bl <stub>`; BL `imm26 = insn & 0x03FFFFFF`
    (NOT `insn >> 26` — that field is the opcode).
  - Full call-site map built by decoding every `bl` against the stub→symbol
    map: 5,660 distinct imported symbols called. Result for GL:
    `glUniformMatrix4fv` **1 site**, `glViewport` 2, `glGetUniformLocation`
    13, `glDeleteBuffers` 9, `glTexImage2D` 6, … `glDrawArrays`/
    `glDrawElements` **0 direct sites** (draw dispatch is indirect —
    open question).

## 2. The GL calls go through a cached state-wrapper layer

Every GL entry point is wrapped by a thin function registered in a table at
`0x24f100` (24-byte records, decoded 2026-10-16: `wrapper u64, slot u64,
tag 0x403+pad`; e.g. the `glUniformMatrix4fv` record at `0x24f188` =
wrapper `0x1454404`, slot `0x1a55768`). ~21 wrappers exist, all in
`0x1452xxx`–`0x1454c74`.

Anatomy (the `glUniformMatrix4fv` wrapper, `0x1454404`–`0x14544fc`):

```
uniformMatrix4fv_cached(this, index, const float m[16])
    entry = this->uniforms[index]          # 32-byte slot
    loc   = entry[0x1c]                    # cached glGetUniformLocation
    if (loc == -1) return                  # uniform absent
    cache = entry[0x10]                    # cached value blob
    if (!cache) cache = calloc(1, 0x40), entry[0x10] = cache
    if (entry.type == 0x40 && *cache == m) return   # 8-word compare: skip
    *cache = m
    glUniformMatrix4fv(loc, 1, /*transpose*/0, m)
```

i.e. the engine **deduplicates uniform uploads** (location caching +
value-equality skip). Consequence for the web port: the *matrix values* are
what matter, and any frame in which they don't change costs no GL call —
matching values across frames is also how we could empirically fingerprint
the matrix from runtime traces.

The wrapper takes an **index** into the state object's uniform array; the
uniforms were bound by name at init (`matWorldViewProj` etc., §1). So the
per-frame camera update = code that (a) computes the 4×4(s) and (b) calls
the cached wrapper with the right index — still to be located (§5).

## 3. The "camera cluster" was the script-API registration table

The earlier lead — camera method strings (`Camera::setZoomLevel`,
`Camera::getZoomLevel`, `Camera::shake`, `Camera::snapToPosition`,
`Camera::getPropertiesArray`) at `0xe85588`–`0xe85894` — sits inside
**`fcn.00df9c90`**, a mega-function starting at `0xdf9c90` that rizin
failed to split (funcmap says 12 bytes; it actually spans ≥3 MB and
references **12,216 strings** in `re/str_xrefs.tsv`).

It is the **script-binding initializer**: a long sequence of
`(type-signature string, method-name string) → register(0x12cbbb0)`
records, e.g.

| signature | name |
|---|---|
| `n:dd` | `Camera::setZoomLevel` |
| (none) | `Camera::getZoomLevel`, `Camera::shake`, `Camera::snapToPosition`, `Camera::getPropertiesArray` |
| `d:oo` | `JobInstance::getLocator` |
| `o:[sdj]` | `Job::getAllInstancesAsArray` |
| `a:[jo]{o}` | `Job::getReward` |
| `d:{[soid]}` | `Inventory::add` |
| `d:sdd` | `User::setVariable` |
| … | ~12k more (`Job::*`, `Inventory::*`, `User::*`, `Group::*`, …) |

The same function also registers **config variables by name**:
`cameraZoomLevel`, `cameraMaxPanSpeed`, `cameraMinPanSpeed`,
`cameraPanTime`, `cameraYOffset`, `allowCameraMovement`, `cameraFollows`,
`focusCameraOnMaster`, `panCamera`, `teleportCamera`, `shakeCamera`,
`skipInitialCameraPan`, `startFromCamera`, `InactiveTimeBeforeCameraReset`,
`SelectionBoxCameraMovementDeadZone`.

Registration stores only the **name + signature** (no function pointer in
the record) — dispatch is by name through the engine's reflection, which is
why the actual implementations can't be reached by following call edges.

**Implication for the web port:** the game's own scripting layer can drive
the camera directly (`panCamera`, `teleportCamera`, `shakeCamera`,
`Camera::setZoomLevel`) and read/write every tuning knob above. If we
replicate that API surface in the web client, scripted camera behaviour
(quest cut-scenes, shake on TNT) comes for free.

## 4. Camera classes & config knobs

- **Classes** (via the engine's own descriptor registry — these have **no
  C++ RTTI**; the roster lives in a 48-byte-per-record table in
  `.data.rel.ro` `0x21a628`–`0x24fa20`, record =
  `(name_ptr, blockA, 0x403, base_descriptor, blockB, 0x403)`):
  `BGSceneCamera` (record file `0x24ea20`), `CameraManager`
  (`0x220370`), `ShakeCameraAction` (`0x21a6e8`). The registry is the
  complete engine class roster (every `*Action`, `*ResProvider`,
  `*Component`, `*State`), and the base-descriptor slot links the
  hierarchy.
- **Config keys** (all in the §3 registration; values presumably arrive in
  `GameplayConfigResponse`/`ClientConfigResponse` — see `04-server-api.md`
  and the fan server's gameplay config): the full list in §3. `Pitch`
  (the isometric view pitch) and `SelectionBoxCameraMovementDeadZone`
  (UI hit-test dead zone) were found earlier in the same cluster.
- `cameraYOffset` suggests the world is rendered with a vertical offset
  (classic TSTO look: city tilted, camera panning in screen space).
- **Zoom behaviour (user observation, 2026-10-16):** there is no
  "zoom out to see the whole town" in the base game — the camera rests at
  a fairly close mid-zoom and only zooms *in* a little closer. So the
  zoom clamp range is narrow and biased in, and any web-port camera model
  (RE or empirical) should replicate that: one canonical resting zoom,
  small zoom-in range, no wide fly-out. (The Map Explorer / city-view
  "Full town" presets are our own convenience, not base-game behaviour;
  since 2026-10-17 City View *gestures* also traverse below rest via
  the workbench floor `ZOOM.wbMin` — §9 — so preset + wheel zoom
  interoperate without clamping jumps. The fidelity constants
  `ZOOM.rest/min/max` above remain the base-game claim.)

## 5. Render loop entry (for the next disassembly step)

JNI `Java_..._BGCoreJNIBridge_OGLESRender` (`0x145facc`) → dispatcher
`0x145f0d4` (ends `0x145f9d0`):

1. `x0 = *(0x1b00d80)` — global singleton (engine core).
2. vtable call slot `0x30` (frame begin?), slot `0x20`.
3. render-target object: vtable slot **`0x538`** — the main per-frame
   render (called 4× in the dispatcher, once per render pass; pass names
   loaded from strings `0x35f903`, `0x37cd2b`, `0x39d738`, `0x3ca41a`,
   `0x393b02`, `0x3b9017`).
4. slot `0xf8`, plus per-pass vtable calls at `0x388`/`0x560`/`0x570`.

Slot `0x538` (and `0xf8`) of the singleton's vtable are where the
per-frame camera update + matrix build will be. The vtable pointer is
runtime state, so the static route is: identify the singleton's class via
the §4 descriptor registry, then reconstruct its vtable from the class
records — or just disassemble the dispatcher's callers of `0x538` and work
backwards from the strings (pass names) to the concrete classes.

## 5b. The camera values are NOT server-driven (verified against live prod traffic)

`server/payloads/boot after login.har` is a capture of the **real EA
production client** (prod.simpsons-ea.com) at boot. Two config responses
were extracted and protobuf-decoded (stdlib wire parser; artifacts in
`/tmp/opencode/`):

- `GET /mh/gameplayconfig` → `GameplayConfigResponse`, **184** NameValues
  (`/tmp/opencode/gameplayconfig_namevals.json`) — all event dates / MTX /
  balancing. **Zero camera keys.**
- `GET /mh/games/bg_gameserver_plugin/protoClientConfig/` →
  `ClientConfigResponse`, **118** NameValues
  (`/tmp/opencode/clientconfig_namevals.json`) — URLs, version gates,
  feature flags. **Zero camera keys.**

Conclusion: `cameraMaxPanSpeed`, `Pitch`, `cameraZoomLevel`, etc. are
**client-compiled defaults**, not per-server tuning — the production
server never overrides them. (They're still *registered as script-visible
names* per §3, so quest scripts can read/override them at runtime.) For the
web port this means there is **one canonical camera behaviour** to
replicate, and its numbers have to come out of the binary (or be matched
empirically against the original client's feel).

## 6. Character movement (status)

From the first pass: movement classes are `JobInstance::
JobMovementBehaviourUpdater`, `MovePickController`, `MoveGroupController`,
`AnimationController`, `LogicGateController`; callbacks
`MoveToObjectInstanceCallback`, `SendCharacterToBuildingCallback`,
`EndofIdleWanderScriptCallback`, `FaceBuildingCallback`,
`JobPositionEndCallback`; pathfinding contexts `GridMapSearchContext` /
`RoadOnlySearchContext` / `BoardwalkOnlySearchContext` (grid / road-network
search over the server-supplied road data in `LandMessage.terrainData`).
**Not yet located in code** — next: find those typeinfo/descriptor records
and their `startSearch`-style methods, same technique as §4.

## 7. AArch64 decoding notes (verified this session — don't re-learn)

- ADRP: mask `0x9F000000==0x90000000`; `immhi=(insn>>5)&0x7FFFF`,
  `immlo=(insn>>29)&3`; page = `(pc & ~0xFFF) + sext21(immhi<<2|immlo)<<12`.
- ADD immediate: mask `0xFFC00000==0x91000000`; `Rn=insn&0x1F`,
  `Rd=(insn>>5)&0x1F`; `imm12=(insn>>10)&0xFFF` (shifted variant
  `0x91400000` → `imm12<<12`). Verified 2026-10-16 against
  `add x1,x1,0xd80` @ `0x145ed04` (and 2 more).
- BL: class `insn & 0xFC000000 == 0x94000000`; **`imm26 = insn &
  0x03FFFFFF`** sign-extended, target = `pc + imm26*4`.
- B (uncond): `insn & 0xFC000000 == 0x14000000`, same imm field.
- **Register branches put Rn in bits [9:5]**, not [4:0]:
  `BR x17 = 0xd61f0220`, `BR xN = 0xD61F0000 | (N<<5)`,
  `BLR xN = 0xD63F0000 | (N<<5)`, `RET = 0xd65f03c0`.
  (The "BR" class check that works: `insn & 0xFFFFFC1F == 0xD61F0000`.)
- LDR Xt,[Xn,#imm]: `insn & 0xFFC00000 == 0xF9400000`,
  `Rt = insn & 0x1F`, `Rn = (insn>>5)&0x1F`, `imm = (insn>>10)*8`.
- ELF64 phdr fields after `p_type`/`p_flags` are 64-bit.
- Rizin 0.8.2 here: `isj`/`iI`/`iij` import commands are unreliable
  (no addresses); `pd N @ 0xADDR` disassembly is trustworthy and resolves
  dynsym/PLT names.

## 8. Matrix builder: RE state at the 2026-10-16 gate

Second focused attempt at the per-frame 4×4 build (§5) reached a clean
static dead end. Recorded so a future session doesn't repeat the work:

- **Wrapper table decoded** (§2): 24-byte records `(wrapper u64, slot
  u64, tag 0x403+pad)`; `glUniformMatrix4fv` record @ `0x24f188` =
  wrapper `0x1454404`, slot `0x1a55768`.
- **The slot has zero direct code refs.** A verified
  ADRP+LDR/STR/ADD scanner over the whole R+X segment
  (`/tmp/opencode/rz/find_data_refs.py`, ~1 s, field formulas
  re-verified against rizin ground truth this session) finds no
  `adrp/ldr/str/add` to `0x1a55768`. Slots are filled by a generic
  table-walker init and the wrappers are called via indirect `blr`
  through the walker — **static caller-tracing of the wrapper is a
  dead end.**
- **Engine-core singleton `0x1b00d80`**: 19 code refs —
  `0x145d8e4 0x145d8f0 0x145d914 0x145daa0 0x145dc4c 0x145de00
  0x145e118 0x145e2cc 0x145e5bc 0x145ea18 0x145ed04 0x145f0f0
  0x145f124 0x145f1bc 0x145f208 0x145f600 0x145fbbc 0x145fdfc
  0x1460174`. The three `add` hits are `add x?, x?, #0xd80` loads of
  the singleton itself; the dispatcher region (`0x145f0xx`–`0x145f6xx`)
  is the per-frame render chain (§5). Page `0x1a55000` (the wrapper
  slots' page) is a dense global-state page (473 data refs; hottest
  `0x1a55000`×77, `0x1a55008`×85).
- **Class descriptors are runtime-populated.** `BGSceneCamera`
  (descriptor record file `0x24ea20`; name `13BGSceneCamera` @
  `0x408837`), `CameraManager` (`0x220370`), `ShakeCameraAction`
  (`0x21a6e8`): all their blockA/base/blockB pointers are **zero on
  disk** → static vtable reconstruction via the descriptor registry
  (the §4 route) is also a dead end.
- **No static matrix constants.** The 4×4 is built in code from camera
  state (as §1 predicted); a scan of the initialized data for 16-float
  matrix-shaped blocks found only false positives (the most
  matrix-like candidate, `0x3e3908`, is an ASCII string; 0 code refs).
- **Camera strings live only in the script-binding mega-function**
  (§3) — the full property roster mined this session: `cameraYOffset,
  Pitch, cameraZoomLevel, cameraMaxPanSpeed, cameraMinPanSpeed,
  cameraPanTime, zoomClampMultiplier, zoomSpeed, zoomLocator,
  zoomLocatorOffset, zoomLocatorSpeed, exitPitchSpeed,
  InactiveTimeBeforeCameraReset, SelectionBoxCameraMovementDeadZone,
  allowCameraMovement, cameraFollows, focusCameraOnMaster,
  skipInitialCameraPan, startFromCamera, teleportCamera, panCamera,
  shakeCamera, restoreZoomLevel, fromZoom, toZoom`. None of the
  `Camera::*` names appear in `dynsym`/`.symtab` (`iS~Camera` empty) —
  implementations sit behind the reflection dispatch (§3).

**Conclusion (gate hit):** the exact pitch/scale/zoom constants are not
reachable statically without dynamic analysis or runtime vtable
reconstruction. Per the plan's sanctioned fallback, M0 ships the
canonical oblique projection (§9) as a documented named-knob model.

## 9. Canonical oblique projection — the M0 camera model (fallback)

Delivered as `web/js/camera.js` (pure; headless-tested by
`tools/smoke-camera.cjs`, 31 checks). This is the **documented
canonical oblique projection** — the standard TSTO look — *not* the
engine's exact matrix (§8). Every number is a named, documented knob,
deliberately not silently tuned:

- **World space** = town tile coordinates (same space as the Map
  Explorer building data; grid origin stays best-fit `(12,136)`,
  `notes/01`).
- **Projection**: 2:1 oblique — tile `(x,y)` centre → world
  `((x−y)·hw, (x+y)·hh)` with `hw=1.0, hh=0.5` (tile diamond 2:1,
  pitch ≈ 26.6°). The single "how oblique" knob is the `hw/hh` ratio —
  pin it with screenshot backlog item (1).
- **Screen mapping**: `s = PX_PER_UNIT·zoom` (64 px/unit at rest →
  resting tile ≈ 128×64 px; documented default),
  `screen = viewportCentre + (world − camCentre)·s`.
- **Zoom** (user correction, §4; workbench fix 2026-10-17): rest
  `1.0`, base-game clamp `[1.0, 1.5]` kept as **fidelity constants**
  (`ZOOM.rest/min/max`) for the M4 A/B pass + the double-click ladder
  `[1.0, 1.25, 1.5]` (wraps at the top; snaps up from a mid-ladder
  wheel value). **Gestures clamp to `[ZOOM.wbMin, ZOOM.max]`**
  (wbMin `0.005`, documented knob): the presets frame the whole town
  via unclamped fits (~0.02), and clamping wheel zoom at `ZOOM.min`
  made the first wheel notch from a preset snap 0.02 → 1.0 (64x
  jump) and then locked the user out of zooming back out — reported
  as "zoom broken". Double-click below the ladder now steps in by
  1.25x per click, landing exactly on rest when crossing it, instead
  of leaping from preset scale to 1.0.
- **Pan**: 1:1 drag; released-drag inertia = exponential decay
  (`maxSpeed 3000 / minSpeed 60` px/s, `decay 3.5` s⁻¹) — documented
  defaults standing in for `cameraMaxPanSpeed/cameraMinPanSpeed/
  cameraPanTime`; tune in the M4 A/B pass.
- **Painter's order**: sort by the oriented world row (via
  `CAM.oriented(x, y)` → `u + v`, exposed as `CAM.depth`), ties by
  oriented `u`.
 - **Orientation (`CAM.ORIENT = {fx, fy, swap}`) — ✅ landmark-calibrated,
   2026-10-17.** Shipped default **`{ fx: 1, fy: −1, swap: 1 }`**:
   (a,b) = (y,x); u = a·fx, v = b·fy; world = ((u−v)·hw, (u+v)·hh). It was
   first picked via the City View Rotate/Mirror rig (§10) against the
   in-game full-map export (`Tapped Out - Simpsons_Screenshot-2025-01-17--
   19-12-02.png`, 16200×8370, the real game camera). That eye-test
   verdict became suspect when the ocean layer turned out to be
   mis-decoded (the 3072-char oceanData frame is COLUMN-major and sits
   OFFSHORE west of grid x=0 — Squid Port water at grid x ≈ −64..0, not
   a band at rows 0–33), invalidating every ocean-anchored orientation
   argument made before that fix. It is now **settled by landmark
   calibration**: 9 user-clicked export↔world correspondences (picked
   with `tools/calib-pick.html`, paste block solved by least squares)
   fit the oblique model to **RMS 46 px** and select `{1,−1,1}` — **the
   shipped triple is confirmed; the rig's eye test was right after all**.
   The decisive test is structural: the tile→screen map must equal
   `s·[[hw,−hw],[hh,hh]]·Orient`, so the unconstrained affine fit's two
   columns must be equal-length (they are: 10.47 vs 10.78 px/tile, 3% —
   the model's isosceles diamond) with inter-axis angle 54.7° (⇒ measured
   `hh/hw ≈ 0.52`, vs the shipped 0.500 — inside click noise; TILE stays
   2:1) and positive `det`. Enumerating all 8 dihedral triples with the
   model's positive-scale constraint (`s, hw, hh > 0`) leaves only
   `{1,−1,1}` (RMS 46 px) and its 180° rotation `{−1,−1,1}` physically
   valid; the other six force a negative tile axis or score RMS ≈ 1850 px
   (41× worse). History kept for the record: an ocean-anchor pick
   `{−1,−1,0}` was rejected; an affine registration (roads/buildings/
   ocean/sand vs segmented pixels) selected `(1,−1,0)` but failed the eye
   test — its `sx/sy ≈ 1.8` / `2.1×` "anisotropy" is now confirmed as the
   artifact of its wrong `swap` branch (the equal column lengths above
   rule out non-square tile units, closing that open question).
   Residuals are not white noise: they grow eastward (west points ≈ 20 px,
   hospital/zoo 60–80 px, same-sign in x) — the signature of the game
   camera's mild **perspective** (far-side streets compress), recorded
   for the M4 pass; the affine oblique stays the documented
   approximation, and a full 8-DOF homography was deliberately NOT fit
   (it would bake perspective into a model that is orthographic by
   design). The oblique remains a mirror of the plain Map Explorer
   top-down (x right, y down) — top-down stays a separate view.
   `smoke-camera.cjs` now anchors on these 9 correspondences directly
   (re-projects export px from grid tiles, bounds the RMS, and asserts
   `{1,−1,1}` is the unique physically valid orientation among the 8) —
   which subsumes the old sea-band eye-anchor; the two
   orientation-agnostic data facts (wave marks hug the frame's outer
   edge; piers/lighthouses/boardwalk railings at grid x −11..9, river
   mouths at x=3) stay. Related bug fixed earlier the same day:
  `city-view.js` `TOWN` bbox used `(+ox, +oy)` as the top/left edges
  instead of `(−ox, −oy)`, clipping the sea strip from the full-town
  preset.

**Open (do not treat as resolved):** exact pitch (`TILE` ratio),
`ZOOM.max`/ladder spacing, `PX_PER_UNIT` resting size, pan velocity
model — all pinned by the screenshot backlog or a deeper RE session.

## 10. M2 terrain model: occupancy-driven ground (road art is NOT per-cell)

> ⚠ **PARTIALLY SUPERSEDED 2026-10-19** — the title's claim was a
> consequence of the WRONG per-tile terrain decode. With the verified
> cell semantics (notes/01 "Terrain grids: CELL semantics") the save
> IS cell-based: every road char is one 4×4-tile cell whose nibble
> (E=1,W=2,N=4,S=8) is exactly the RoadDrawer connectivity state, so
> `terrain.js` now paints one 4×4 diamond per cell and selects the 11
> engine states **from the saved nibble** (`Terrain#cellStateFor`).
> Everything this section says about the RoadDrawer machinery (vtable,
> draw path, UV quads, 11-state table) remains solid RE; the "the town
> data refutes the cell model" argument is retracted — it measured a
> phantom. Occupancy maps survive in the renderer only for point
> lookup (`typesAt`) and the avenue/synth debug overlays.

Delivered as `web/js/terrain.js` + `web/city-view.html`/`.js`/`.css`
(Phase 2 M2 + M3, 2026-10-17). The ground is a **flat oblique plane**: a
skewed grass texture fills the whole viewport, and every non-grass tile
from the save's seven terrain layers (ocean/sand/dirt/river/road/
dirtroad/klsroad, all in `map-explorer-data.js`) is drawn as its own 2:1
diamond in painter's order; road tiles additionally get a per-tile
manhole so the street reads as paved.

> **Superseded 2026-10-25:** the selector/draw model below (parity gates,
> "per-edge kerb overlays in another pass", base+clip band pieces) is now
> settled by direct RE — see **`notes/08-road-drawer-re.md`** (the
> definitive selector family table, nibble bit directions, the 4-quadrant-
> quads-per-cell draw pass, and the finding that there is NO second kerb
> pass and NO parity selection). Read 08 first; keep 06 §10 for the
> camera/registration context and the sheet-art A/B history.

**Why occupancy-driven, not the engine's 11 road cell-sprites.** The base
engine's `RoadDrawer` picks one of 11 pre-rendered cell states per cell
(the 32-byte UV quads at `.rodata 0x400520+0x20k`; §8 + notes/01) — a
4-neighbourhood topology state machine. That model was RE'd fully
(vtable `0x1a3e0e0`, draw path `0x1099c38→0x1209814`, per-quadrant
selector `0x1208058`), but the town data **refutes** it as the rendering
source of truth for *this save*:

- The 11 states only express 1-sub-cell edge / corner / stub / full / T /
  cross — **no 2-wide in-cell band**.
- This town's roads are **1–2 save-tiles wide at arbitrary cell phases**:
  the three 2-wide W–E bands sit at mod-4 phases `(2,3)`, `(1,2)`,
  `(3,0)` — there is no fixed cell phase, so a per-cell state cannot tile
  them.
- Swept all 16 cell phases against the 11 diamond masks: **0/240** town
  road cells match at phase (0,0); the best phase is offset `(3,2)` at
  **1141/2007 ≈ 57 %** (1-wide edge/turn cells match, 2-wide bands never
  do). The dominant unmatched tuples are in-cell 2–3-wide bands
  `(12,12,15,15)`×116, `(12,12,3,3)`×60, `(15,15,3,3)`×48.
- The 2×2-save-tile "subcell" hypothesis is dead: the per-subcell
  road-count histogram is broad (97.5 % empty, 0.7 % at 1/4, 1.2 % at
  2/4, 0.6 % at 4/4) — roads do **not** align to 2×2 groups.
- Scale is pinned: **1 save tile = 1 world unit** (building overlay — the
  top-row buildings sit cleanly north of the first road band with a 3–4
  tile sidewalk gap).

So per-tile occupancy is the correct base: it reproduces every width,
corner, T-junction and stub the save contains. The 11 diamonds remain
**reference art** for later refinement of the 1-wide edge/turn/endpoint
states; the exact sub-cell↔tile phase, the runtime scale floats
`*(0x1abc0ac8)` (S) / `*(0x1ac0260)` (UV), and whether 2-wide bands want
the quarter-diamond art or a plain occupancy fill are all
**screenshot-backlog** items.

**Road palette + real sheet art (2026-10-17; M4-corrected)**: the actual in-game road
art is `web/assets/dlc/roadrivertiles-50/images/roadtilesheet.png`
(512×512, from the roadrivertiles pack — *not* the RoadDrawer's 11 cell
states, which the town data refutes as the render source, above). The
sheet is a plane tiling of ~135×74 2:1 diamonds; cell `(c, r)` centre =
`x = 274 + 135·c + (r mod 2)·67.5, y = 140 + 37·r` (lattice measured via
a contact-sheet pass; 24 filled cells: asphalt with manhole dots,
lavender sidewalk `(204,204,255)`, grass `(102,187,102)`, water
`(102,187,221)`, cliff `(170,136,119)` and combination tiles).
*(2026-10-27: the Pixi viewer now draws road and river cells from the 1024²
`roadrivertiles-100` sheet — the identical layout at 2× — as UV meshes with
the engine's own quad tables, which fixed the "blurry tiles" report;
`notes/09` §6. The deprecated canvas page / `terrain.js` legacy modes still
use the 512-space lattice described here.)*

**M4 RE of the 11 RoadDrawer UV quads (2026-10-17)** — the static route
worked for the ART (the §8 camera dead end doesn't apply): `p8 352 @
0x400520` (libscorpio.so `.rodata`, vaddr==file off) = 11 × 32 bytes =
8 floats = `(u,v)` corners **top,right,left,bottom** of a UV diamond;
×512 = sheet px. Every quad centre lands on the lattice formula above,
pinning the 11 state cells: `0=(-1,7) 1=(-1,5) 2=(-1,6) 3=(-2,5)
4=(-1,4) 5=(-1,1) 6=(-2,1) 7=(-1,-1) 8=(-1,3) 9=(-2,3) 10=(-1,2)` —
i.e. a two-column slice of the sheet. Two facts the eye-test diagnosis
turned on: **(a)** the original default cell `(-1,4)` is state 4, a
COMPOSITE (half lavender paving-grid + asphalt) — the contact-sheet
alpha test that catalogued it as "plain asphalt with 4 manhole dots"
was wrong (the sheet has NO transparency; `cov=1.00` everywhere);
state **0 `(-1,7)`** is the true full-asphalt tile (light grey + sparse
dots). **(b)** each quad is the cell diamond INSET to 127×66 px
(centre ±63.5/±33) — sampling the full 135×74 lattice box drags
neighbouring cells (green/cliff) into the diamond corners. With both
fixed, PIL composites of the downtown band over the Android export
match the control (`/tmp/opencode/m4-road-ab-stack.png`: A=game,
B=old, C=new); uniform per-tile scale is right (cell-span-2 and
sheet-plane-lattice variants were worse). `terrain.js` now defaults
`sheetSlots.road = [-1, 7]` and samples the 127×66 inset box; the City
View toolbar gained a **Road art** button (cycles OFF → uniform sheet →
neighbour-selected edges; `Terrain#useSheetArt` + `Terrain#sheetSelect`
live, persisted 0/1/2 in `localStorage` `mrsnrub.cityview.sheetart`) so the
A/B needs no console. Still ships **OFF** until the user approves.
Per-quadrant state SELECTION (2026-10-17.19, `Terrain#sheetSelect`):
the base-tile selector `0x1208058` disassembles to a decision tree over
a per-cell **4-bit neighbour-connectivity nibble** — `bl 0x1134fa8` =
`record.byte[4] & 0xf` (accessors `0x1134cfc`.. read flag bits 5–7 of
the same byte) — whose set branches pick one of the 11 UV quads
(`add x23, x8(0x400000), #0x520+0x20k`), gated by runtime ±1-cell
neighbour queries (vtable `+0x30` contains-test + `+0x18` get, cells
`(cx±1,cy)`, `(cx,cy±1)` from stack slots filled at `0x1208180`), with
left/right variants chosen by a coordinate parity (`tst w21,1` +
`csel` at `0x1208234`/`0x12084d4`/`0x12088bc`). Cell coords are
`(x>>2, y>>2)` of the fixed-point query coords (wrapper `0x1208058`
prologue), i.e. ONE cell per world unit = one save tile. We reproduce
it as `Terrain.SHEET_TABLE[mask] = [state, flip]` over tile-space road
occupancy (bits 1=+x, 2=−x, 4=+y, 8=−y); quadrant materials (u = sheet
image column drawn along q2−q0 = screen right, v = image row along
q3−q1 = screen down — `quad()` returns corners [L,T,R,B], so +x↔(u+,v−), +y↔(u+,v+), −x↔(u−,v+), −y↔(u−,v−);
an earlier revision mapped the box axes swapped, rendering every
composite rotated 90° — kerbs across the band instead of along it,
fixed 2026-10-17.20) classify as `A`=grey asphalt ~`(153,153,153)`,
`P`=lavender paving
~`(202,202,251)`: state 1 = right-half A (`{+x,+y}`), 5 = top-half
(`{+x,−y}`), 8 = bottom-half (`{−x,+y}`), 3/4 = 3-of-4 A with a
paving+kerb strip at −y/−x, 0 = all-A interior; `flip` mirrors u
(tile-space +x↔−y, +y↔−x) for the sheet's missing right-edge
variants. 2-wide bands therefore draw states 3/4 along both long edges
(white kerb + paving slabs like the export); dead ends/diagonals have
no art and fall back to 0. Not modelled: the engine's parity
alternation of variant pairs (3 vs 10, 4 vs 7) and the flag-byte
special paths (`bit5` → immediate quad at `0x12088a8`); `dirtroad`/
`klsroad` keep flat fills and the drawn manhole is suppressed under
sheet tiles (the art has its own dots); the flat fill stays underneath
(no AA seams), and `ctx.transform` COMPOSES so the caller's DPR base
transform survives.
Knobs: `Terrain#useSheetArt` (false = flat Phase-1 colours + drawn
manholes), `Terrain#sheetSelect` (`'uniform'` shipped default = state 0
everywhere; `'neighbor'` = RE'd table above), `Terrain#sheetSlots`
(layer → `[c, r]`), `Terrain#roadSheetImg`
(the page owns the Image — `city-view.js` loads it like the grass tile,
`onerror` keeps flat roads). Sampled palette for flat-mode reference:
asphalt/road
lavender `(204,204,255)`, curb `(170,170,187)`, manhole `(17,17,17)`,
pavement/grey `(153,153,153)`.

**Orientation naming + the missing N-S streets (2026-10-17 investigation)**
— per the user: **N–S = the direction the ocean band runs** (screen
upper-left ↔ lower-right = tile ±y), **E–W = tile ±x** (the 2-wide band
families that kerb states 3/4 serve). Findings on why only E–W roads
take kerb states: (a) the save `road` layer contains continuous
streets in the E–W (tile-x) family ONLY — per-column max y-runs are
3–7 tiles (driveway/frontage fragments), while rows run 192–384 tiles
(mask histogram: m7/m11 ≈ 2035 each, m3 = 1064, m12 = 134, m15 = 1004);
(b) a full-lattice scan of the sheet + a re-dump of the .rodata quad
table (exactly 11 × 32-byte entries at `0x400520`, floats end at
`0x400680` where the `10RoadDrawer` string begins) confirm **no
both-opposite-edge "strait" state exists** in the base-tile catalogue —
1-wide straights (masks 3/12) therefore have no art in this table and
the game must compose them in another pass (per-edge kerb overlays or a
second drawer); (c) the game's continuous N–S streets visible in the
export are **not in the save road layer at all** — a red overlay of
every road-layer tile over the export crop (x 55–105, y 183–262) lands
on the E–W boulevards and the town-hall *plaza paving* (plaza cells
are road-type!) but leaves the N–S streets beside the police building /
dinosaur pool uncovered. 2026-10-17 follow-up: the
`RoadMapList[N].txt` hypothesis is **dead** — those 7 files are the
per-kind road-KIND overlays (DIRT_ROADS, DIRT, COBBLESTONE, ICERIVER,
KLSROAD, GOLDROAD, SAND — notes/01), list[0]'s "continuous columns"
sit at y 62–72 (a different region) and sample as grass on the export,
and no list covers the town's N–S street columns in the y 190–250
band. The raw save `roadsData` is byte-identical to the web layer and
the char set is exactly G/P/a–p (decode complete), so the avenues are
laid by the ENGINE: notes/01 records that roadmap record bits 6..15
are "set only by the road-construction code, never by the string",
and the decoder cluster at `0x11a6288` even calls `rand()`.
Sub-cell export walks near the west anchors (local affine, <4 px
residual) pin two clean streets: centres grid x 66.9 and 90.9,
~2.25 cells wide; their 24.0 pitch suggested a templated grid
(`gx mod 24 ∈ {18,19}`), but a second correction (2026-10-17, after
the user's eye test flagged the avenues "not in the right spot")
killed the generalisation: per-row walks show the streets only span
**grid y 221–258** — the block bounded north by an E–W road at rows
223–225 that is ALSO absent from the save road layer, and south by
the saved E–W band 261–263 — while the next pitch column 114/115 has
no street in this band (its street sits at y 263–272 instead). The
town blocks are therefore hand-placed per-band, not one global grid.
(Building footprints do NOT avoid the streets — roads are a ground
layer drawn under buildings.) Export per-row probes are confounded
by decorations: saved rows 183/184 bleed high and 261–263 sample as
grass under the park/hedge props, so segment bounds were taken from
crisp 1.00-fraction runs only. Synthesised behind
`Terrain#useAvenues` (Road art button mode 3, ships OFF) as
`Terrain.AVENUE.streets = [[66,67,221,258],[90,91,221,258],
[114,115,263,272]]` — verified streets only (each entry is
[x0,x1,yLo,yHi] grid cells), no speculative pitch columns; the model
went per-street on 2026-10-17.24 when the export column-walk recheck
confirmed 114/115 @ 263–272 with 9/9 crisp rows (and refuted the
pitch-24 grid again: candidates 30/31 @ ~235–250 (81 % crisp), 78/79 @
252–269 (94 % but may be plaza paving — plaza grey 140,138,140 passes
the asphalt key) and 118/119 (patchy, east drift) do NOT sit on the
pitch; evidence crops `mapdump/registration/m4-av-cand-*.png` await
the user's eye). Avenue cells join the neighbour-mask union, so flanks
select masks 13/14 = kerb states 4 / 3+flip from the existing
`SHEET_TABLE`, and avenue×E–W-band crossings select 15 (interior).
2026-10-17 road-construction-code RE pass (option 1).  Key results:

* Client XML land format.  libscorpio.so has a tinyxml-style land file
  parser (cluster 0x10b2a00–0x10b4700): root element `Land` with `sizex`/
  `sizey` and layer names `roads rivers ocean dirt dirtriver cobblestone
  iceriver klsroad goldroad sand`, then `tilecount` + per-tile elements
  `tile x y road pavement building leaving`.  A single loader function
  (0x10b4784, exactly 3 call sites, all in 0x105b5xx–0x105b9xx) loads
  `"StartingLand.xml"` (bundled asset), a per-land filename stored in the
  land object (vtable slot 0x268 — the local land file / FTP override),
  and a runtime-built save-dir path.  `OverrideFTPLandFilename` is a
  debug knob.  The client also WRITES land XML locally (save cluster
  ~0xddd000, "Attempt to save different user's land!").  StartingLand.xml
  is NOT in the APK, IPA, or any CDN pack we hold — the seed presumably
  ships in the device's downloaded data or is created at town creation.
* Road RECORD creation sites in the client: (a) the string decoder
  0x11a6288, (b) the XML tile deserializer 0x10b2dd4 (reads
  tile x/y/road/pavement/building/leaving fields), (c) builder-placement
  code (GameState_PlaceBuilding region 0x86a–0x86b → creator 0x118e420,
  which calls set1unit + set bit6).  Bits 6..10 are written by a shared
  adjacency-update pass (0x11a3bc8/0x11a4734, callers 0x1191810,
  0x11a5038/0x11a5710 — 10 unrolled neighbour cases each): for each
  record, query neighbours via 0x1108e58(rec+0x80, dir) and OR the
  direction bits.  So "road-construction code" = connectivity updater;
  it never creates cells itself.
* ORIGINAL-SERVER STARTER LAND (server/payloads/*.har, endpoint
  `bg_gameserver_plugin/protoland/<id>`): the fresh-town roadsData
  (hdr.id=7) is only 80 chars — ONE 'P' 16-tile E–W run at y0 plus 7
  single-char frags (y3: b,d,d,d at x 17/35/51/67; y4: d,d,d,c at
  19/35/51/66, i.e. x≡1,3 mod 16 — the same frag families as trawg's
  frontage stubs).  Six road-kind layers carry the same single 'P' run.
  The original server NEVER stores N–S street chains, not even in the
  template.  Combined with the trawg audit this settles it: boulevards
  persist as 'P' rows (server-side seed/player-built), the N–S avenue
  grid is client-derived (drawn from the client's local land XML /
  construction pass), invisible to the server save.

Generator RE (per-band column inventory, the unsaved 223–225 E–W
road, river/ocean crossings) pending. 2026-10-17 completeness audit
(in response to "maybe the tiles are somewhere"): re-dumped EVERY
TerrainData payload from the raw `.pb` (roadsData, riversData,
oceanData, roadMapList[0..6], the 128-char subLand2 grid at pos
(−2,0)) plus the 3 binary `groupStorageBundleRoadMap` grids
(bundles 16/19/22, 48/64/32 chars) — decoded all, zero cells inside
the street rectangles. Save freshness also kills the stale-save
theory: bundle timestamps run to 2025-01-20, AFTER the 2025-01-17
export, and still lack the streets. And the format demonstrably CAN
store N–S lines: bundle 16's ROADS roadmap is literally a 12-char
`m`-chain vertical footpath (`GGGGiGiGmGm…`), the same mechanism as
roadsData's x≡3/12 mod 16 sparse columns — so the avenues' absence
is a fact, not an encoding artifact. Working model: the town layout
is stored as template parameters (block grid/seed among the 53
LandMessage fields) and the road-construction code rebuilds the
tiles at load; RE of that code's input is the decisive test. The 3-panel evidence image
(game control | 60% ghost overlay of the synthesised roads | magenta
cell outlines + cyan y-segment bounds) is kept at
`mapdump/registration/m4-avenues-abc.png`. Until wired, masks
3/12 stay state 0 (plain asphalt) — deliberate. Two greys exist in the art: 187
(state 0 interior) and 153 (composites); export sampling of individual
straight tiles was inconclusive due to affine drift in that region.

2026-10-18 pb-schema walk + decoration oracles.

* Exhaustive terrain-store census: EVERY TerrainData-bearing field of the
  save was decoded — roadsData(5), riversData(6), oceanData(34),
  roadMapDataMessage(47: 7 blocks, verified DUPLICATES of the already
  exported layers; COBBLESTONE/ICERIVER/GOLDROAD all-'G'),
  subLandData.terrainData(36: one 128-char frag at (−2,0)) and the 3
  groupStorageBundle roadMaps(53: ≤48-char co-op path strips). No other
  pb field carries road data (f16=event counters, f43=session vars;
  zero `.xml`/template refs anywhere). Verdict: the full network is
  NOT in the pb; the web renderer must bundle client land-template data.
* The user-provided renderer PNG (8000×5099, greys 153/187, river
  45,86,125, dirtroad 221,170,102) shares the export projection family
  (line families −28.5°/+25.5°) but its content is topologically
  different from the pb layers (connected rivers vs 170 isolated cells;
  full-map avenues vs max 8-cell N–S runs) and admits NO affine
  alignment to pb road cells (2-scale FFT sweep) — renderer roads come
  from its own template data, not the upload alone.
* **town→grid offset MEASURED: grid = town + (7.1, 141.6)** for f7
  buildingData records, via the user's manual drag-alignment of the
  4 station-adjacent KLCrosswalks (tool
  `mapdump/registration/m4-align-tool.html`, embedded crop + homography;
  report block pasted 2026-10-18) + pixel confirmation (placed cells
  sample 27–37% zebra-white on 52–60% asphalt; the old predictions
  0%/0%; junction centre 100% asphalt). The earlier "+(12,135) verified
  against four calib landmarks" claim was CIRCULAR — the calib grid
  coords were themselves derived from record coords — and the original
  (−70,−145) tx0/ty0 was also wrong; in homography-grid space the
  char column "gx=186" sits at ≈123 (186−70+7.1), i.e. 2 cells east of
  the zebra-confirmed N–S road x=120–121 (kerb offset). Landmark-derived
  calib grid frame differs from the record frame by ≈(−5,+7): treat any
  absolute coord from before this measurement as suspect by that amount.
  Homography drift grows far from the pins: the 24-record zebra scan
  (±4-cell search) needed per-record deltas of 0–4 cells, smooth within
  regions (west column all (−1,−2)) but one outlier (97,35)→(0,+3).
  Evidence: `mapdump/registration/m4-cross-overlay3/4.png`,
  `m4-anchor-{west,mid1,mid2,row177,east}.png` (cyan boxes = best-zebra
  cell per record, labels `rec tx,ty fsN d=delta`); anchor data in
  `/tmp/opencode/kl_anchors.json` (regenerate via scan, threshold
  white>205 both cells, fs=1 → 2×1 crosses N–S road, fs=0 → 1×2 E–W).
  CAVEAT: near squidport the white detector can catch white fences/
  parasols — those anchors need extra eye-test scrutiny.
* **KLCrosswalk (catalog 200521, f7 buildingData) ×24 = decoration road
  oracle.** 1×2 footprint; fs=1 = rotated (crosses an N–S road),
  fs=0 = crosses an E–W road. The 4-way SW of PoliceStation (grid
  135–141,167–171) is bracketed by exactly four records at
  (125–126,167),(125–126,172),(123,170–171),(128,170–171) — one per
  arm, "just before they converge" (user-confirmed layout). All 24
  records trace hidden road lines: N–S at gx≈17,37,57,73,97,125;
  E–W at gy≈170,186,214,218,246,290,310 — none present as full rows
  in roadsData. Character columns land 2–3 cells (kerb) from these.
  Evidence: `mapdump/registration/m4-cross-overlay3.png` (station box
  yellow, crosswalk cells cyan/magenta), `m4-cross-station-intersection.png`,
  `m4-cross-kl-{75,95,155}.png`. Project rule added (AGENTS.md): all
  user-eval files go in `mapdump/registration/`.

**Ocean tile colour** (sampled 2026-10-17 from the Android full-map
export): game sea water is sky blue ≈ `(84,170,252)`; the ocean layer's
sparse alternating mark pattern matches the in-game **wave marks**, so
the layer paints waves over water, not the water itself.
Ocean diamonds use the sampled blue instead of the Phase-1 legend navy
`(30,92,158)`; the Map Explorer legend keeps its swatch.

**Ocean layer layout + solid sea base (corrected twice, 2026-10-17)**: the
ocean layer string is **3072 chars = a 96-col × 512-row frame stored
COLUMN-major** (char i covers column x=i/32, 16 sub-cells along y),
unlike the other six layers' 34784-char row-major 512×1087 grids. And
the frame is anchored **offshore, west of the town frame**: the sea is
the **Squid Port / Barnacle Bay water**, a vertical strip at grid x
≈ −64..0 running y 0..512, shoreline at x ≈ 0. Decisive data: 127
water props — `SquidportEntrance` (−1,184), `BarnacleBayMarina`,
`BarnacleBayLamppost`s, boardwalk stalls and railings (x −11..+4),
`LuxuryYacht`, `AircraftCarrier`, `YellowSubmersible`, whales,
`PrivateIsland`×3, `Skull/Garbage/CandyApple/Lobster/Stormy/Tropical/
Mulberry Island`, `Shipwreck` (x −44..−2, y 30..500) — all sit at
negative x along the left edge; the road layer's **min x is exactly
0** (roads never enter the water); and zero water/river cells exist
near the top rows, killing the original row-major (horizontal band at
rows 0–33) decode. Wave marks (frame cols 2..26, 94% at cols 2..13 =
deep-water side) render via `Terrain#seaColOffset` (default −33 →
grid x −31..−7, on the water). The earlier "coastline at col 33, sea
inside x 0..33" fit came from the *row-major* export probe and is
void — it put the water on top of the Squid Port boardwalk and 417
road cells. Knobs: `Terrain#seaFill`, `seaColOffset`, `seaFillX0`
(−64, offshore edge), `seaFillX1` (0, shoreline), `seaFillY0`/`Y1`
(0/512, coast extent); re-tune with the M4 landmark calibration.
`terrain.js#decodeTiles(str, vert)` and `map-explorer.js#decodeTiles`
apply the column-major decode by string length (3072). Sand note: the
sand layer IS rendered (632 tiles, tan) but has only 3 cells at x<10 —
the save holds no beach data; in-game sand near the coast is base-tile
art from the `roadrivertiles` pack, still to be RE'd (backlog). The
sand band at grid y 14..201 is inland sandy ground, not a beach.
Registration status caveat: the
class-scored registration of streets/buildings onto the export
plateaued (~0.4–0.6) and is NOT a trustworthy judge of the camera
constants (perspective + classification noise); the exact-projection
question moved to **landmark calibration**
(`mapdump/registration/calib-{export,world}.png`, point correspondences
→ direct projective solve) and remains pending.

**Verified without a browser** (this phase's no-screenshot rule): the
`terrain.js` transform is cross-checked against `camera.js`
(tile↔world↔screen identity, `quad()` vs manual corners,
`visibleTileRect` round-trip) and the full composition is PIL-rendered to
PNG and image-spot-checked (flat Map Explorer colours sit inside the
textured result). `tools/smoke-camera.cjs` still green.

**Tunable knobs** (named for the backlog): `terrain.js
Terrain#grassRepeat` (world tiles per grass-texture repeat, default 8),
`terrain.js Terrain#minTilePx` (minimum on-screen feature-tile width in
CSS px so sparse layers stay visible at whole-town zoom; default 4,
manholes skipped in that mode), `city-view.js HEIGHT_SCALE` (save
height → world units, default 0.5), `terrain.js Terrain#seaFill` /
`seaColOffset` / `seaFillX0` / `seaFillX1` / `seaFillY0` / `seaFillY1`
(solid sea base: the Squid Port water polygon offshore of the
shoreline; see "Ocean layer layout + solid sea base"), `terrain.js
Terrain#useSheetArt` / `sheetSlots` / `roadSheetImg` (road layer painted
from the roadrivertiles-50 sheet; see "Road palette + real sheet art"),
plus the M0 camera's existing
pitch/zoom/pan knobs (§9). Ocean-anchor convenience: the City View's
**Ocean** preset frames `Terrain#typeBBox[ocean]`.

**Manual orientation rig (2026-10-17)**: `CAM.ORIENT` is now the full
triple `{fx, fy, swap}` — all 8 dihedral states (4 rotations × 2
chiralities), not just the sign pair. Everything (projections, depth
sort, ground matrix, culling) derives from the single helper
`CAM.oriented(x, y)`; `CAM.orientRotate90` / `CAM.orientMirror` step
the triple. The City View toolbar gained **↻ Rotate 90°** and **Mirror**
buttons (they rebuild terrain/building sort orders and re-apply the
last preset), and the toolbar shows the live readout
`ORIENT = { fx: …, fy: …, swap: … }` — the value to paste back when the
view matches the game; it is persisted in `localStorage` under
`mrsnrub.cityview.orient` (delete the key to fall back to the shipped
default `{ fx: 1, fy: −1, swap: 1 }`). `smoke-camera.cjs` pins the
group laws (rotate⁴ = id, mirror² = id, 8 distinct states),
round-trip/depth consistency via
`oriented()` in every state, and that `terrain.js`'s `groundTransform`
equals the CAM projection matrix in every state.

**Legend toggles (2026-10-17)**: the City View legend is now the
ground-layer control panel — each row (grass + the seven terrain
types) is a `<button>` that hides/shows its layer via
`Terrain#setVisible(type, on)` / `Terrain#isHidden(type)` (state in
`Terrain#hidden`). Hiding `ocean` drops the wave marks **and** the
solid sea base together; hiding `grass` leaves the base unpainted so
the water and features read on their own. Rows carry
`aria-pressed`/`.off` styling, use the shared `data-tip` tooltip
convention (its rule block was missing from `city-view.css` and is
now present, identical to `app.css`), and legend toggles survive a
Rotate 90°/Mirror rebuild, and every stage gesture
(`pointerdown`/`wheel`/`dblclick`) bails out over the legend via an
`overUI(e)` check — without it the pan gesture's
`setPointerCapture` steals the rows' clicks. `smoke-camera.cjs` asserts the paint/
suppress/restore behaviour with a fake ctx.

**Object legend (2026-10-17)**: a second `.legend` panel (bottom-right)
toggles placed objects by *category* — buildings, vehicles, rail (KL
monorail), nature, decor — plus **people**. The save catalog `binfo` has
no category field (`kind` is only the asset/flip flag), so `web/js/
objects.js` (`CityObjects`) derives buckets from the asset name: CamelCase
word split → singularise → per-bucket word set, first bucket hit wins,
unmatched falls back to `buildings` (correct for named landmarks like
`KrustyBurger`; avoids regex substring traps such as `PowerPlant` ⊃
"plant" and `BartsTreehouse` ⊃ "tree"). This is a workbench aid, not the
game's taxonomy. `people` is now rendered too: `M.chars`
(`[typeId, tileX, tileY]`, town coords) as char-coloured ground dots via
`CityObjects.drawPeople`, drawn after the blocks — a painter's-algorithm
simplification, so people read on top — and viewport-culled. Both panels
share one `togglePanel` builder and the `.legend` class, so `overUI`
matches `.legend`; a static smoke check asserts the buckets are
non-empty, partition every placed object, keep the spot-classified
landmarks in the right bucket, and paint/cull the people dots.

**Registration, M4 item 3 (2026-10-17.25)** — the "east-side residuals =
game perspective" note is now resolved: roads are ground-plane features,
and a perspective camera maps the ground plane *exactly* by a homography,
so no dynamic capture was needed to fix the model class. `tools/
calib-solve.py` fits both models from `calib-pairs.txt`: affine RMS
40 px → robust homography RMS 16 px (deterministic outlier drop keeps 8
pairs, rejects `zoo`; `hospital` lingers ~30 px — re-pick candidate).
Artifact `mapdump/registration/g2e-homog.json`, pinned by `tools/
smoke-calib.cjs`.

Four attempts to *automate* east-side registration from the save all
failed, and why matters for the next attempt: (1) Powell optimisation of
a "roadlike pixel fraction" objective over all long saved E–W runs moved
east-band ratios (0.04→0.11) but broke the verified west streets — a
false optimum; rejected. (2) Per-probe offset searches on river/sand/
klsroad colours saturated at the ±100 px radius (teal fountains + plaza
greys mimic water/tan). (3) Vertical-street window searches with a free
per-window (dx,dy) hit score-1.00 along *diagonal* grey features: the
recovered offsets saturated at the search edge with a smooth ~9.5 px/cell
gradient across column pairs, and the flank filter rejected the VERIFIED
114/115 street (its saved 112/113 grey run violates "flanks non-grey").
(4) NCC template chaining along boulevards died within 2–3 windows —
building/prop occlusion (roads render UNDER buildings) breaks the
template. Root cause common to all: at zoom 1.00 the export simply does
not show most saved road cells (park props, hedges, plazas whose grey
(140,138,140)/paving (206,202,255) mimics road greys), so dense image
correspondence is unextractable there. What DID work was the strict
no-offset walk (proven classifier, min≥0.5/gap2/len≥4) under the robust
homography: west guards stay green (30/31, 114/115 crisp), 118/119 now
resolves to one crisp run y 261–271 (parallel twin of 114/115), and the
east scan yields ~19 isolated long candidates (168/169 y215–309 len 95,
232/233, 120/121, 188/189, 256/257 …) — evidence crops
`mapdump/registration/m4-avH-<x>-<y0>-<y1>.png`, all pending user eye
test; adjacent-pair-same-y clusters were filtered as E–W boulevards.
Extra east-of-x200 clicks in `tools/calib-pick.html` would still tighten
residuals (suburbs/desert landmarks exist at x 250–330 in the save);
street table additions stay eye-tested-only.

**Road system-of-record, CLOSED (2026-10-18)** — the 2026-10-17 verdict
"roads provably NOT in the pb" was half wrong; the split is now settled
with hard evidence:

1. **Live-server capture (decisive).** `server/payloads/*.har` contains
   base64'd live `protoland` responses from EA prod (v4.69, Oct 2018
   tier). A brand-new tutorial town ships with **8 non-'G' characters
   (8 cells) in roadsData** — `bddd…dddc` at row 1, cells x = 1, 19, 35,
   51 / 259, 275, 291, 306 (pitch 16, spawn-driveways) — while every
   visible town road renders. Evidence: `mapdump/registration/
   m4-liveland-*.pb` (extracted bodies). So base roads are NOT
   server-persisted; the pb only accumulates road cells that change
   (player-placed / auto driveway stubs).
2. **Our save's f5 is that accumulation**, and it is real: six fully
   connected E–W avenues (x 0–511 at y 260–264 & 279–282; x-segments at
   146–149, 164–168, 183–186, 205–208), all split at 128-cell block
   boundaries, + 903 isolated 1-wide N–S stub fragments in two families
   (x ≡ 3 and x ≡ 12 mod 16, 15–30 cells tall) = driveways/frontage
   ("saved 1-wide N–S fragments" in terrain.js — confirmed). No saved
   component is a N–S boulevard. Heatmaps: `m4-f5-band-L/R.png`,
   `m4-heat-*.png`.
3. **Template has no layout.** Full-CDN recursive sweep (510/510 7z
   packs, inner zips opened one level deeper — the earlier sweep missed
   this) found every land template: `startingland.xml` (36 KB, newest
   rev r421947, `gamescripts-r*.zip::1`) declares only
   `<roads tilecount="96"/>` — counts, not coordinates — plus 506
   `<building id x y>` + 1 character. Island templates are 242-byte
   stubs. No road-tile list exists anywhere on the CDN. Artifacts:
   `mapdump/registration/m4-startingland.xml`,
   `m4-roadplacement.xml` (the player road-editing rules from the same
   zip — confirms roads are a *player tool*, additive/subtractive vs
   the other 9 maptypes).
4. **gamedata never goes over the wire**: no gamedata-XML endpoint in
   any HAR (only `gameplayconfig` feature-flags + `protoClientConfig`
   key/value stubs). `StartingLand.xml` is a mounted local resource
   from gamescripts, not a CDN fetch.
5. **Frame**: MAP_DATA `ox=12, oy=136` stands. The tutorial driveways
   (x ≡ 1 mod 16, row 1) prove decodeTiles semantics. The user-verified
   police crossroads (~town 114/115 × 35/36) sits on the pitch-24 N–S
   sequence 30/66/90/114 + 126 extended; 126 = new boulevard candidate
   (matches the KLCrosswalk straddle at grid x≈125–126, y≈170–171, and
   the E–W row 170–171 saved fragments at x 160–191 are its partial
   twin). Boulevard candidates for eye-test: x = 138, 162, 186, …
   (pitch 24 from 114) + 126.
   *Candidate loop CLOSED 2026-10-29: the user ran the
   `tasks/m4-road-review/` board eye test out of band and the verdicts
   were fully promoted into `Terrain.AVENUE.streets` (five verified
   4-col bands, per `terrain.js`).*

Consequence for M4: the street table can never come from data; it is
`f5 E–W avenues (saved) ∪ procedural N–S grid (eye-tested)`. The
`useAvenues` synthesiser is the correct mechanism; extend the table
only with user-approved streets.

**Police-stn crossroads, resolved (2026-10-18).** The user eye test
promoted the N–S boulevard `[126,127,146,208]` (verdict id 1 — the
four-way with crossings by the police station). Landmark geometry in
the save: PoliceStation instance grid x 135–141, y 168–172; the
four-way's KLCrosswalk props sit at grid (123/128, 171) and
(125, 168/173). The f5 player-edit layer holds an E–W row at
y 170–171 (x 124–143) slicing the station's north rows — the game
draws it, but it is NOT the template road beside the station: the
real one is the SOUTH-side row aligned with the crossings
(saved twin at y 175, x 100–143; crossings y 173–174). Entered as
E–W PROPOSED candidate id 24 (x 100–200 @ y 174–175) — first
horizontal candidate; the verdict tooling handles any grid rect.

**Eye-test harness (2026-10-18.4/.6).** The boulevard candidates above are
wired into City View as `Terrain.PROPOSED` (grid coords, verdict-tinted
overlay behind `Terrain#showProposed` / the "Prop streets" button) with
per-street ok/bad/pending verdicts persisted in SQLite via
`web/api/streets.php` (offline fallback: built-in seeds + localStorage;
shift+click proposes new columns). Row mouseover highlights that street
(`Terrain#hoverProposed`: loud yellow + outlines, others ghosted) and a
per-row ⌖ centers the camera on it. 2026-10-18.6 added the east arm to
the coast — layer decode shows the saved E–W avenues + dense road cells
running to grid x≈511 with sand/beach to the NE, so pitch-24 continues
306…498 plus half-pitch samples 318/390/462 (does the east grid sit
+12-offset like x 126?). The seeds mirror the PHP `seeds()` list row for
row; keep them in sync (`syncSeeds()` top-ups old DBs on GET). Promoting
an `ok` verdict into `Terrain.AVENUE.streets` remains the manual,
per-street step this section demands.

**Ghidra RE of the road generator, phases 8–20 (2026-10-18).** Toolchain:
Ghidra 12.1.4 headless, saved project `/tmp/opencode/ghproj/roadproj1`
(libscorpio.so, base **0x100000** — rizin addr + 0x100000 inside scripts;
forgetting it silently decompiles the wrong function). Scripts
`/tmp/opencode/GhidraRoads1..20.java`, dumps `/tmp/opencode/ghidra_out/`.

* **CDN still live.** `oct2018-4-35-0-uam5h44a.tstodlc.eamobile.com/netstorage/
  gameasset/direct/simpsons/...` serves the packages the HARs only indexed.
  Downloaded + unpacked `gamescripts-r497432-LYOXW1QI.zip` (→ 4281 entries,
  the `gsdata/` set) and `game-100-v3_0_30-r157326-B8353263.zip` (53 art
  entries). **No maptypes/grid asset exists in any package or index**
  (5051 package names searched). The per-land-type template table is NOT a
  data asset — it is built in-process.
* **`landinfo.xml` = the "maptypes" config** (gamescripts pkg; loaded via the
  0x968xxx Land-config manager cluster). Springfield: `<LandBlockSize x="40"
  y="64"/>`, `<LandBlockPosition x="-3" y="-7"/>`, and 10 `<RoadMap>` defs:
  road/river/dirt/dirtriver/cobblestone/iceriver/klsroad/goldroad/sand
  `origin="0,-7" size="37,64"` + ocean `origin="-3,-7" size="3,64"`, each
  with PathBrush/TileTypes/JoinToMap/Conversion rules — **no cell data**.
  Block units: template grid = 37×64 blocks of 40×64 tiles.
* **StartingLand parser** `FUN_011b41ac` (Ghidra): reads `<Land x y sizex
  sizey>` → `FUN_0124cd28` (tail wrapper) → **rect fill `FUN_01238f24`** on
  the base map `[land+0x5a0]`; then per layer (roads/rivers/ocean/dirt/
  dirtriver/cobblestone/iceriver/klsroad/goldroad/sand ids 0–9): entry =
  `FUN_0115c084(store singleton DAT_01bdfb90, id)`, then
  `FUN_011b34d8(elem, entry, base)`.
* **`FUN_011b34d8`** = merge + `<tile>` reader: line 13 `FUN_0128bc54(entry,
  base)` then loops `<tile x y road pavement building leaving>` children via
  `FUN_0128c600` cell-get-or-add + flag setters. Both local copies of
  startingland.xml have **zero `<tile>` elements** — template cells must
  pre-exist in the config entries.
* **Merge semantics settled** (`FUN_0128bc54(param_1, param_2)`): iterates
  param_1's w×h grid, queries param_2 (`FUN_012adda8`); hit → alloc 0x180
  cell in param_1, miss → delete. So param_1 ← raster copy of param_2's
  footprint clipped to param_1 extent.
* **Cell-origin census (exhaustive BL scans, code block 0x7e5000–0x1abdd03):**
  cell setter `FUN_012adc24` → rect_fill + seam_a `FUN_0124cda4` + seam_b
  `FUN_0124d114` + dead wrapper `FUN_012add2c` only. **rect_fill has exactly
  2 sites** (self-recursion `0x1238ea0`, the StartingLand wrapper
  `0x124cd34`; single wrapper caller `0x11b4280`). Get-or-add
  `FUN_0128c600` → tile parser + 9 sites all in the 0x136xxxx drawer cluster
  (`FUN_0136a480` etc. = map→map propagation: bbox loop, per-cell type-mask
  test, writes tiles via `FUN_0128c900` + creates cells — i.e. the
  sidewalk/edge auto-generation around existing cells). seam_a callers
  0xa092a4/0xf3fe18/0x10ee200/0x11ed2b4, seam_b caller 0x1336384.
* **Base-map ctor** `FUN_012aca54` zeroes everything (no cells); **ctor B**
  `FUN_0128be18` → descriptor copy `FUN_0128b99c` + cell bulk-copy
  `FUN_0128bf04`. No string decoder anywhere for mapData (char-cmp scan for
  'G'/'P'/'a' immediates: only protobuf enum false-positives at 0xeca1e8) —
  the f5 blob is server-side truth the client round-trips; the client's
  road state comes from the merge/propagation pipeline above.
* **Conclusion:** template N–S streets materialize inside the 0x968xxx
  Land-config manager cluster (per-land-type table behind
  `FUN_0115c084(DAT_01be3ca8, landTypeId)`, ctor cluster
  `FUN_0096a9e8`/`FUN_0096bbd8`/`FUN_0096d128`…), fed from
  `landinfo.xml`-class config parsed in-process; the seed coordinates are
  computed/generated in code, not stored. Remaining path to exact
  coordinates = runtime tracing (out of scope) or continuing the
  eye-test loop. Road-gen RE is CLOSED at this boundary.

### Walk-path oracle (2026-10-19) — the save leaks the invisible street grid

> ⚠ **REFRAMED 2026-10-19 (same day)** — "the invisible street grid"
> was invisible only to the wrong decode: the road layer is a complete
> saved cell network (notes/01 "Terrain grids: CELL semantics"). The
> walk waypoints themselves are raw `pathCache` data and unaffected —
> the mod-4 lattice observation stands (it measures walk waypoints,
> not terrain bytes), and `tools/layer_oracle.py` still runs — but
> the layer is no longer an oracle *for* roads. Under the corrected
> decode the walk-vs-road coverage oracle is weak anyway (walk points
> ride the template lattice: a flat ~24% road coverage sweep with no
> usable offset peak).

User hypothesis: "rivers and roads must be defined some other way — maybe
as a series of paths". Confirmed on three fronts:

* **PathBrush (client config).** Local copy of `landinfo.xml`
  (`/tmp/opencode/gsdata/landinfo.xml`) defines every RoadMap layer with
  `<PathBrush>` strokes (`type="road" innerGrid="road"
  outerGrid="sidewalk"`, river `grid="river"` …) plus
  `LandBlockSize x=40 y=64` / `LandBlockPosition x=-3 y=-7`; and
  `mapdump/registration/m4-roadplacement.xml` shows players place
  roads/rivers by **dragging a brush** (mode="road"/"river", Additive/
  Subtractive maptypes, `SaveInfo map="river" savedType="road"`). The
  network is *generated* at load from that config — consistent with the
  closure above; no path table ships as data.
* **`characterData.pathCache` is a real path store** (the only one): a
  `VectorFloatArray` of integer town (x,y) walk waypoints per character
  (853/871 populated). Characters only walk on streets, so these are an
  **oracle for the full road network**: of 2,349 waypoints only 10% are
  on/near a saved `roadsData` tile (8-neighbour probe vs `_roadOccAll`),
  and segments are strictly axis-aligned (656 H / 840 V / 0 diagonal).
  The off-saved-road walks land on a rigid lattice: **N–S avenues at
  grid x ≡ 3 (mod 4)** (top columns 195:68, 215:56, 155:52, 127:39,
  111:37, 75:34, 175:32, 39:31, 255:25, 99:20, 239:18, 263:14 segs) and
  **E–W streets at grid y ≡ 0 (mod 4)** (top rows 308:65, 184:51 —
  the *unsaved stretch* of the known avenue row 183/184 — 244:28,
  280:27, 212:24, 168:23, 312:23, 216:19). This also settles the
  half-pitch candidate-pair question from the avenue table: the walked
  member is the x≡3 one (31, 79, 115, 119).
  **Wired:** `tools/gen_map_explorer.py` exports deduped polylines as
  `MAP_DATA.walks`; `web/js/walks.js` (`CityWalks.census/draw`) renders
  them cyan + amber candidate bands behind the City View object-legend
  **"walk paths"** row (persisted `mrsnrub.cityview.walks`, ships OFF).
  Census = segments with BOTH endpoints off every raw saved road, phase-
  filtered to the lattice, ≥5 segments/line (MIN_SEG). Tests:
  `smoke-camera.cjs` "walk paths oracle" block.
* **The "river" at OlmecHead is decoration art, not terrain.** Player
  river tiles are a quest-gated brush (`RoadEntry type="river"
  consumableName="RiverDrawing"`, quest RiverRun) — hence riversData is
  only sparse strokes. The water the real client shows E/W/S of
  OlmecHead (145,20) is the **SpringfieldFalls** decoration (id 1241)
  placed at (136,12), footprint 8×12, whose sprite
  (`web/assets/city/springfieldfalls.png`, 1260×1086 px ≈ 2× the
  footprint diamond, + a flipped variant) spreads waterfall art beyond
  its rect; the two saved river tiles (130,20)/(144,17) hug that
  footprint = the player extending it with the brush. Whole-save census:
  one each of SpringfieldLake (264,14, 18×14), ForestStream (356,38,
  4×8), ToxicWasteLake, DinosaurLake, ponds — in-game "rivers" are big
  quest decorations + brush strokes, not a network. No tiles are
  "missing" there — block-mode City View just renders the falls as a
  footprint block, so its water vanishes (M4 sprite art fixes it).

## Open items

1. Camera matrix constants — static route exhausted (§8: indirect
   wrapper dispatch, runtime-populated descriptors, no static
   constants). Remaining routes: (a) **screenshot backlog**
   (`planning/phase-2-camera-view.md`) — pins pitch, zoom ladder,
   resting size, pan feel; (b) **dynamic capture** — hook the
   `glUniformMatrix4fv` wrapper `0x1454404` at runtime and record the
   16 floats (the §2 value-dedupe cache makes the values stable per
   camera state, so a few known pan/zoom deltas determine the model);
   (c) runtime vtable reconstruction of the dispatcher chain (§5)
   under emulation. Tooling ready: `find_data_refs.py` (verified
   ADRP/LDR/STR/ADD scanner, ~1 s) + rizin `aaa` complete
   (`/tmp/opencode/rz/aaa.log`).
2. Locate the pathfinder entry points (§6).
3. **M1 building sprite world-scale + anchor** — `city-view.js` currently
   draws raised footprint *blocks*; swapping in the `web/assets/city`
   billboard sprites needs the game's px-per-world-unit at extraction
   (≈ `*(0x1abc0ac8)`) + the `locX/locY` anchor-tile → world-point mapping
   (§10, `city-sprites.json` `anchor`). Verify placement via PIL before
   the screenshot A/B.
4. **M2 ground art polish** — grass repeat scale (`grassRepeat`), and
   the road sheet art: wiring + smoke pass exists
   (`Terrain#useSheetArt`, roadrivertiles-50 sheet, §10; the Pixi viewer's
   engine-true draw has since replaced this — `notes/09` §6) but the visual
   fit FAILED the user eye test 2026-10-17, so it ships **OFF by
   default** (flat Phase-1 colours); diagnosis + fix is M4 TODO item 1
   (`planning/phase-2-camera-view.md` — RE fix landed 2026-10-17; the
   re-do PASSED the user eye test out of band 2026-10-29, item CLOSED;
   OFF stays as the shipped default by user decision).
   Remaining polish also covers
   `dirtroad`/`klsroad` cells and whether grass/water move to sheet
   art — visual call, backlog.

Done: ~~read the server's camera config values~~ — done, negative result
(§5b): production serves no camera keys; values are client-side defaults.

**Road-generator RE session, 2026-10-18 (afternoon)** — user picked the
binary route to end the candidate eye-test loop. Findings:

1. **f47 `roadMapList` fully decoded** (7 × 34 784-char `TerrainData`,
   same G/P/a+k encoding, via `land_pb.parse_msg`): DIRT_ROADS = 94
   cells (park dirt paths, columns x ≡ 3 mod 16 at y 61–72), KLSROAD =
   16 connector cells on rows y 259 / y 277, SAND = beach speckle,
   COBBLESTONE/ICERIVER/GOLDROAD empty. None touch the town street grid
   (0 cells at the police station, 0 on any promoted street).
2. **Boot/server payloads**: no G-rich strings in any
   `server/payloads/*.har` — the server never ships base road grids.
3. **f36 SubLandData / f53 GroupStorageBundleRoadMap**: per-sub-land
   ROADS strings exist (`{subLandID, sizeX, sizeY, terrainData}`, e.g.
   subLandID 1 ROADS 48 chars) but are tiny neighbouring-block patches,
   not the 512-wide town grid.
4. **startingland.xml** (mapdump/registration/m4-startingland.xml):
   `<roads tilecount="96"/>` — count only, no coordinates ⇒ the 96
   template road tiles are generated **client-side**.
5. **Promoted streets are NOT in f5** (x126@146–208: 8/63 cells;
   x66@221–258: 0/38). Confirms all N–S template streets render from
   client-generated art; f5 holds only saved player/auto road mods
   (E–W avenue rows y 146/147, 164/165, 183/184, 261–263, 279–282 are
   full-block 16-aligned runs — saved, and drawn).
6. **iOS main exe** (`/tmp/opencode/TappedOut-ios`, Mach-O arm64 PIE,
   LC_DYLD_INFO): contains `RoadMap::Grid::fromString`@0x1013dc28d,
   `toString`@0x1013dc2a7 etc. A custom ADRP+ADD scanner finds the
   string refs (0x100720264 / 0x100720334) — but they are inline
   CHECK-failure log sequences with no inbound branches; rizin's
   `axt`/`iR` do not parse Mach-O rebase opcodes (bind-only), so data
   xrefs are blind. capstone/lief unavailable. No usable anchor to the
   generator.
7. **Android `libscorpio.so`** (ELF, RELA): parsed `.rela.dyn` manually
   (11 k ABS64 + 80 k 0x403-type relative slots) and reconstructed the
   RTTI chains: RoadMap vtable `0x1a37fc0` (8 virtual slots:
   0x118c0e8/0x118c258/0x118c890/0x118c454/0x118c764/0x1193bb4/
   0x118d9e0/0x118d814), RoadMapDrawer `0x1a2e860` (3 slots:
   0x10d62a8/0x10d6328/0x10d684c), RoadMapTileMapAdaptor `0x1a35588`
   (8 slots, accessors at 0x11357c0…0x1135120), RoadMapArrayAdaptor
   `0x1a35628` (8 slots 0x11357cc…), RoadmapBoolRect `0x1a38010`,
   GridTester classes `0x11a36e4…`. Constructor-inlined vptr stores at
   0x118b878/0x118be28/0x118c0fc (RoadMap), 0x10d628c/0x10d62b8
   (Drawer), 0x11350ac/0x11353c4/0x11357d4/0x1135800 (adaptors).
   RoadMap sub-helpers 0x118bc54 (36 callers) / 0x118b99c (2 callers,
   both inside the ctors) / 0x11adc24.
   Key disassembly (0x1138fa0–0x1139094 and 0x114ce20–0x114ce C8): a
   loop over layer ids **0..11 = the TerrainType enum** —
   `w0=id; bl 0x105ef00` (vector accessor, vector ptr at
   `[globals+0x338]+0x58`) returns the per-layer string, and when
   non-null `bl 0x118bc54(string, this+0x5a0)` builds a RoadMap grid
   from it. So the client's road grids ARE string-driven
   (`fromString`), one per terrain type, fed by the decoded server
   strings — for the template's 96 tiles the string must be built
   locally (generator still not pinned; needs proper recursive-descent
   function recovery or Ghidra).

Bottom line unchanged: every on-disk data source is now exhausted; the
template streets come from client-side generation. Cheapest paths
forward: (a) Ghidra headless on `libscorpio.so` restricted to the
0x1135–0x1193 function cluster to recover the string producer that
feeds `0x118bc54`; (b) accept f5 + eye-tested candidates; (c) defer
streets and do M4 items 2/4/5.

> **Update 2026-10-19 (phases 21–27, `GhidraLand1..7`): route (a) is
> DONE and the answer is negative — there is no client-side string
> producer and no client RNG.** `0x118bc54` = `FUN_0128bc54` (the
> provider→layer merge, 40 callers, already documented under phases
> 8–20); the "36-callers helper" was never a `fromString` feeder.
> See "Provider architecture" section at the end of this file.


### Sprite-anchor RE session, 2026-10-18 (M4 items 4/5 follow-up)

Eye-test with the Tune panel walkers showed **per-building offsets that
scale with size** (direction and amount vary) — the signature of a wrong
placement convention, not a wrong global constant. Findings this session:

1. **bcell vs bsv3 transforms** — a full-pool scan (200 files, 374 k
   blocks) proved the block floats are a real 2x2 matrix: `bcell`
   (chars/cars) uses rotations (~5 deg seen), `a=-1` flips and `d`
   y-stretches (1.18); **static `bsv3` building blocks are all
   identity** (verified block-by-block on kwikemart,
   policeheadquarters, phonebooth). Ignoring (b,c,d) therefore cannot
   explain the city-sprite misfit — but it WILL matter for character
   animation frames (item 5 follow-up).
2. **Anchor convention re-pinned**: every sampled building's body block
   sits at (x,y) = (−w,−h), i.e. the bsv3 origin is the **bottom-right
   pixel of the art bbox**, and `render_static` returns exactly that
   canvas px as the manifest anchor. Art + anchor are internally
   consistent; the error lives in the engine's
   `(tile px,py, locX,locY, w,d) -> screen point of the sprite origin`
   mapping + px-per-unit scale — precisely Open item 3 above.
3. **Binary RE status** (`libscorpio.so`, Ghidra roadproj1):
   - `.rodata` holds 8x `bsv3` / 6x `.bsv3` / 2x `bcell`; only
     0x4bc30c has direct xrefs — 7 functions, all **catalog XML
     parsers** (property names recovered: `drawOrder`,
     `AlternateOverlay`, `frameOverride`, `animDoneScript`, `rooted`,
     `formulaRequirement`, ...; the parsed asset-def object stores the
     bsv3/flippedbsv3/flippedanim file names at +0xf/+0x10/+0x12 and a
     13-bit flag word at +0xbc).
   - instruction-wide `cmp #0x103/#0x303` scan: only libc++/enum false
     positives (0xf06668 is a 0x102-enum range check).
   - struct-fingerprint scan (float ldr at displacements 0x12-0x1e and
     0x2-0x16): ZERO candidate functions -> the bsv3 parser reads by
     pointer increments, not struct displacements; next probe is the
     caller graph of the asset-def field readers above.
   - iOS `TappedOut-ios`: ObjC class names only (`BGSprite`,
     `BGCellSprite`, `AnchorObject`, `GridOffsetListComponent`) — no
     usable code anchors (Mach-O xrefs still blind, as before).
4. **Toolchain note** (headless invocations failed silently until fixed):
   opening the already-imported program is
   `analyzeHeadless /tmp/opencode/ghproj roadproj1 -noanalysis -process
   libscorpio.so -postScript X.java -scriptPath /tmp/opencode` —
   `-process` takes the BARE project file name (a slash in it throws
   "invalid filename specified"; `-open` does not exist; `-import`
   errors with "conflicting program file"). `Address.getValue()` does
   not exist in Ghidra 12.1.4 scripts - use `getOffset()`.
   Reusable multi-decompile runner: GhidraSprite5.java +
   /tmp/opencode/decomp_list.txt.

**Routes to pin the convention deterministically** (replacing the
ax/ay/S eyeball knobs): (A) fit from the game's own full-map export —
measure where each landmark sprite's origin pixel touches the ground
vs its saved (px,py,locX,locY,w,d) through the calib homography, then
least-squares the affine convention; (B) continue static RE from the
asset-def field readers into the sprite system; (C) runtime trace of
the drawer (Frida). (A) is cheapest and self-validating.

### Sprite placement RE (route B), 2026-10-18 — convention PINNED

Continued static RE from the catalog parsers into the building-class
code (Ghidra project `roadproj1`, scripts GhidraSprite7..14 + the
rewritten `adrp_scan.py` — ADRP+ADD scanner, **range-matching** whole
strings, PC page computed with vaddr = file-off + 0x100000; exact-
address matching misses refs that land mid-string, e.g. "bsv3" inside
"flippedbsv3"). Findings:

1. **`locX`/`locY` exist exactly once in the binary** (rodata 0x3d4703/
   0x3d4708), read by `FUN_00fd0c94` (building JSON parser; keys "x"
   "z" "height" "locX" "locY", + a `SubFootprints` list). The int pair
   is stored as **(locX−1, locY−1)** into the footprint record — they
   seed the footprint grid ONLY, never the world position.
2. Same parser stores the raw x/z/height floats at obj +0x80/+0x84/
   +0x88; the asset class (`FUN_00fcea54`, its sole caller; vtable
   `0x1b13e48`) then sets the object position verbatim:
   `+0x40=0, +0x48 = S·(−z), +0x4c = x·S, +0x50 = height·S` — a pure
   uniform scale with the axes swap + y-negation we already model as
   ORIENT {fx:1,fy:−1,swap:1}. **No half-tile term, no locX/locY.**
3. The export's instance positions discriminate corner-vs-centre:
   all 5261 building positionX/Y are integers (lattice points), while
   characters sit on .5 values (tile centres) — so the sprite ground
   pin is the diamond CORNER `tileToWorld(px,py)`, ax=ay=0. (People
   keep the existing +0.5 centre pin; it agrees.)
4. S (`*PTR_DAT_01bbcac8` → float @0x1bf5b00) has ~40 READ xrefs and
   no static writer — config-loaded at runtime, value unreachable
   statically. Stays empirical; 64 (PX_PER_UNIT) is the candidate to
   eye-test against 62.
5. Flip handling matches the port's `dims_for`: catalog keys
   nameFlipSE/SW/NE/NW; flipped entries carry swapped dims
   (base_<z>x<x> footprint art, `FUN_00fd2d1c`).

Baked into `ART` defaults (city-view.js): ref='anchor', ax=ay=0,
S=62; TUNE_KEY bumped to `.v2` so stale half-tile nudges don't mask
the new defaults. Remaining open (as of 2026-10-18): per-art quality —
the earlier size-dependent residual is consistent with an S misfit
(edge displacement grows with sprite extent), not a pin rule. S itself
was pinned 2026-10-25 — see "Sprite scale S pinned" at the end of this
file.

### Block rect vs sprite base (M4 click-overlay), 2026-10-18

User eye-test: sprites sit correctly (ref=anchor, ax=ay=0) but the click
outline / Wire / block fill ride off the sprite base. Headless evidence:
the block rect [px-lx+1 .. +w]×[py-ly+1 .. +d] (occupancy-grid rule) puts
the prism's screen-front corner (x0,y1) at (px-lx+1, py-ly+1+d) — off the
sprite pin by (lx-1, ly-1+d) tiles; measured across sizes (1×1 props agree,
big footprints are ~h tiles low). Sprite pivots are front-corner pivots:
large-building anchors sit BELOW the art bbox (art hangs above the pivot),
1×1 prop anchors are bbox-bottom-centre. City View's blockPolys rect is
therefore now [px .. px+w] × [py-d .. py] (front corner == pivot ==
tileToWorld(px,py)), painter depth sorted on oriented(x0,y1) (= max y−x =
screen-bottom). locX/locY remain the occupancy grid only. Map Explorer's
flat rect was left as-is (2D grid view, never sprite-overlaid).

### Sprite pivot & block-matrix RE (M4, 2026-10-18)

User eye-test flagged PowerPlant/PowerPlantBuildings as oddly drawn and
mislocated. Root causes, both in `tools/gen_city_sprites.py` (placement
math in city-view.js was already correct):

1. **Degenerate authoring pivots (38/3592 sprites)** — single-block
   `C_Building` assets (powerplant01/02, generichouse00/02/03/04,
   skipsdiner, jakesunisex, krustyburger, bench/gaspump/… props) export
   their block rect with the TOP-LEFT at the bsv3 origin, so the raw
   anchor `(−x0, −y0)` sits at ay ~ 0 and the image hangs BELOW the
   ground pin. The raw-ay distribution over the pool is bimodal (broken
   max 1.25 px vs healthy min 289 px — flat ground decals like
   runwaypiece03 sit BELOW the origin on purpose and must not re-pin).
   do_sprites re-pins those to bbox bottom-centre and flags
   `"pivot":"bbox"` in the manifest (threshold: `ay < 4` px).
2. **The block matrix was ignored** — each static block carries
   (ci, x, y, a, b, c, d); the old renderer used only `sign(a)` (flip)
   and pasted crops unscaled/unrotated. Pinned semantics (empirical):
   **(x, y) = top-left of the transformed bbox**; `a<0`/`d<0` mirror the
   crop inside it; (b, c) rotate/shear, applied through the
   |diagonals| matrix (BILINEAR; NEAREST for pure diagonal scale).
   Evidence: flipped assets mirror the unflipped assembly via
   `x' = −(x + bbox_w)` — held 6141:23 against the matrix-corner
   alternative over the pool's flipped pairs (GhidraSprite15/16
   detour: `transImageX/Y` are parsed by FUN_00fd0c94 into def
   +0x98/+0x9c, but are NOT the draw compensation — healthy correctly
   placed buildings carry non-zero values, verified-good props are 0;
   consumer unidentified, safely ignored).
   With transforms applied, powerplant00's cooling towers (2x scale),
   reactor glow dots (9.5x), innstable's searchlight rays (rotations)
   and sheared drop shadows render as authored. Full regen: 3592/3592,
   0 failures; smoke 8/8; evidence
   `mapdump/registration/m4-powerplant-compare.png`.

### Character idle art v2 (M4, 2026-10-18)

`chars` run regressed to 20/1023 save names because the pool harvest is
dominated by **bcell11/bcell13 stubs** (13,941 of 14,374): they store
frames as references to external `<Name>_image_N.rgb` sheets that the
harvest never carried, and `setdefault` let those stubs SHADOW the core
game-100 pack's renderable bcell10 cells (same stem+role). The core
pack's real cells live in the core zip's NESTED inner zip (outer entry
'1' is itself a zip — BGrm manifest + inner zip; inner entries are
normally named). Fixes: `_char_inventory` keeps pool cells only with
magic `bcell10`; `find()` gained stem-in-name matching both directions
(`frink` ⊂ `professorfrink`) and longest-stem-wins on ambiguity. Result
v2: 119 names -> 53 rendered assets (core street cast all covered).
Carl/Lenny/Ralph/Maggie/Willy + costumed chars exist ONLY as bcell13
stubs -> blocked on bcell13/11 parser + external image support; format
ground truth = tsto2rgb bcell13 writer (re-clone pending user OK;
bundles are all local, only the clone needs network).

### transImageX/Y decoded — anchor ground truth for degenerate pivots (M4, 2026-10-19)

The power plant "misplaced part" hunt ended with the `transImageX/Y` mystery
(from the 2026-10-18 session: def +0x98/9c, parsed at `FUN_00fd0c94`, no
consumer found). Findings, all from local pool files:

- Each building asset can ship a sidecar `<name>_transimage.rgb` (932 in the
  pool) — a single RGBA image (no bsv3) that `gen_city_sprites` indexes but
  never composites. The PP ones are large ground-plane wedges (grey-blue
  concrete/structure, wide at the building line, tapering south to a point).
- Every asset xml carries `transImageX/Y`. For ~347 assets with a non-zero
  pair, `(ax, ay) = (-tx, h + ty)` reproduces the healthy bsv3-derived
  anchor to <1.5 px (e.g. `powerplant00flipped` 757.30 vs 757.299). But at
  least ~250 other healthy assets carry unrelated values (`powerplant00`
  non-flipped tx -320.05 vs bsv3 ax 778.75; `duffpartyliner` off by 458 px),
  so the pair is NOT a universal anchor and Ghidra never found a draw
  consumer — the value is authoring data, only trustworthy where nothing
  better exists.
- Rule implemented: the pair is authoritative **only for the degenerate
  38-asset set** (bsv3 pivot ay < 4 px -> was `pivot:"bbox"`). 36 of the 38
  have a non-zero pair -> `pivot:"xml"`; the 2 without keep bbox.
  `powerplant01flipped` anchor 539 -> 757.05 (was 3.5 tiles east/wrong side
  of the towers), `powerplant02` 695 -> 631.4. User eye-test: panel B
  (xml anchors, no transimage) confirmed correct.
- Transimage overlays deliberately NOT composited yet (panel C/D rejected:
  bottom-left-at-anchor+(tx,ty) placement put the wedges too far south vs
  the in-game compound). 916 shipped sprites lack their overlay layer —
  known gap, revisit with real ground truth (tsto2rgb has the writer).
- Evidence: `mapdump/registration/m4-pp2-variants.png` (2x2 camera-accurate
  variant montage), `m4-pp-trans-<slug>.png` (per-asset A/B/C sheets).
  Tooling: `tools/gen_city_sprites.py reanchor` (manifest-only re-pin).
- Save audit (pb `buildingData`, 5261 rows): the PP compound is exactly ids
  2/44/45 at pb positions (4,12)/(9,12)/(14,12), flips 1/1/0, skins
  184005/194005/0; `stealableBuildingData` empty, `adHocObjectData` = 128
  unpositioned identifiers, group bundles = LuxuryYachts, subLand 2 unused
  -> no missed fourth component. Skins (catalog ids: WalkingKwikEMart,
  Luftwaffles) currently ignored by the sprite picker — semantics unknown.

### Affine compositor constants bug (M4, 2026-10-19)

GiantRobot rendered headless/one-armed. Diagnosis chain: manifest showed
24/24 blocks drawn, 0 skipped -> composite showed the head rect 89%
transparent (not occluded: NOT covered by the torso) -> sheet cell fine
(0.44 opaque) -> block matrices fine -> bug in `render_static`'s
`Image.transform(AFFINE)` coeffs: constants were `-M^-1*(qx0,qy0)`
(absolute bbox-corner fold-in) but PIL evaluates `a*x+b*y+c` with
window-local x,y, and the window displays rel = (rx0+x, ry0+y) — so the
constants must be `+M^-1*(rx0,ry0)`. Every rotated/sheared block away
from the origin sampled outside its crop (transparent or wrong sheet
region): 1,349 of 3,592 sprites had >=1 such block; identity/diagonal
scales (NEAREST branch, e.g. powerplant00's 2x towers) were unaffected —
which is why the 2026-10-18 affine session passed eye-test on
scale-heavy sprites. Draw order = file record order (no z field; format
confirmed in notes/01) — painter order is correct once parts exist
(jaw over head verified). Evidence: m4-giantrobot-affinefix.png.

### Rotated-block placement semantics (M4, 2026-10-19)

Parts drew but sat wrong (GiantRobot head/arm detached). Five hypotheses
composed in one shared engine frame (`/tmp/opencode/m4-robot-placement.py`
→ m4-giantrobot-placement.png, m4-innstable-placement.png): A bbox-TL at
(x,y) [old], B crop-origin at (x,y), TA/TB transposed variants, E ignore
b/c. Discriminators:

1. **innstable C_Ray fan** — 5 ray blocks (cell 306x49, rotations spanning
   ~33 deg) must share a hub at the beam root: max pairwise root spread
   A=131.6 px vs B=TB=15.9 px (TA=15.1). Fan geometry cannot tolerate a
   132 px splay on a 306 px beam.
2. **GiantRobot limb chain** — upperarm(0.58,-0.81,0.81,0.58, 54 deg)
   far-end to forearm origin: B 300 px, TB 83 px; forearm far-end to hand:
   B 110 px, TB 48 px. Under B the arm rotates *away* from the hand; only
   the transposed order chains. Pool-wide joint vote 21:17:42-tie for TB.
3. **Mirror-pair re-audit (raw values)** — 1,200 flipped pairs, b=c=0
   blocks only: content-edge relation x' = -(x + w) wins 5,907:10 over
   crop-origin x' = -x. Compatible with (1)-(2) because with the in-place
   mirror convention (flip the crop, matrix uses |diagonals|) rx0=ry0=0
   for b=c=0, so both rules coincide there — the 2026-10-18 audit never
   constrained the rotated case because flipped twins carry b=c=0.

Final rule in `render_static`: flip crop iff a<0 / dd<0; matrix
`X = a*u + c*v, Y = b*u + d*v` (b,c transposed); content rect =
(x,y)+bbox(rel), i.e. cell (0,0) corner lands at (x,y). Affine constants
stay `M^-1*(rx0,ry0)` (window-local, per the constants-bug section).
Aftermath: 322 rotation-carrying sprites changed canvas extent/anchor
(bbox grows as rotated content spreads); powerplants and other scale-only
assets byte-stable. pizzatruckflipped's 0.01 px anchor jitter = engine
float noise (b=c=-1.5e-5) — harmless.

### tsto2rgb cross-read + engine RE in progress (M4, 2026-10-19)

User eye-test: GiantRobot arm/waist STILL detached after the crop-origin
change => the rotation *composition* convention is still not right;
offline in-file constraints (mirror audit, ray fan, limb chain) are
exhausted — they pinned families of blocks but not the pivot model.
Ground truth hunt:

- `tools/tsto2rgb` (user-cloned) reviewed for security: no network
  imports; bundled dicer = stripped Rust ELF (elringus/sprite-dicing),
  zero socket/connect symbols, libc-only NEEDED list. Safe.
- It is a WRITER (png->atlas->rgb/bsv3/bcell), so it confirms the
  consumption-side invariants: bsv3 block (x,y) = where cell (0,0)
  (content top-left) lands — crop-origin ✓; engine units = 1/100 px;
  writer always emits identity (a,b,c,d), so it cannot settle rotation.
- bcell13 DECODED from bcell.py: magic `bcell13` + flag byte + u16
  count; per frame {name, f32 delay, i16 x, i16 y, u16 extra(1),
  "null", "null", 7 f32 [tx,ty,a,b,c,d,alpha]}; frames are
  bottom-centre pinned: x=-w/2+offsetX*scale/100, y=-h+offsetY*scale/100.
  Unblocks the character bcell13 parser task.
- Frame selection fix: `static_blocks` now prefers the first frame of an
  anim named *neutral* (`_neutral_frame_index`); tsto2rgb corroborates
  (promotes the atlas with 'neutral/0' to main file). Impact: 881 v1
  assets already used the neutral frame, 2565 switch frames, 30 have no
  neutral anim. Flip-pair check: 1148 pairs both resolve to neutral
  frames; 69 index-mismatches are harmless (flipped files renumber
  frames, pose still neutral on both sides).
- Engine RE: Ghidra scan of all 4.85M instructions for the bsv3 magic
  compares found `cmp #0x103` at f06668/15a258c/1628b7c and 20x
  `cmp #0x303` clustered in 1610000-17be000 — prime loader candidate
  0x16287e8 (checks both). Phase 18 decompiling those functions.
  Ghidra project moved to /home/dave/ghproj-mrsnrub (tmpfs quota).

### bsv3 PARSER located and decompiled in libscorpio.so (M4, 2026-10-19)

Chase path that worked (phases 17–25, /tmp/opencode/ghidra_out/):
magic-immediate scan hit only OpenSSL false positives; the real thread
was the `"%s.bsv3"` string → texture-format **registry** (`FUN_00ade124`
registers `"image8888"`, `"image4444"`, `".bsv3"`, …handler pairs at
0x1bbeaa0..f8) → `.bsv3` factory `FUN_014dcdb8` → decoder ctor
`FUN_0154f750` (slurps file, wraps reader, calls parser) → **parser
`FUN_0154e3a4`** (fully decompiled, phase 25).

Engine-side format facts (all agree with our empirical parse_bsv3):
- version = `byte0*100 + byte1` read as TWO u8s: magic bytes `[03 01]`
  (= u16 0x0103 LE) is engine **version 301**, `[03 03]` = 303. So our
  "v1/0x0103" family = engine v301 (per-frame inline blocks + dedup
  pool branch, via uint underflow of `ver-303`), our "v3/0x0303" =
  v303 (global block table + u16 index frames). Branch selection in
  the engine: `if (0x60 < (uint)(ver - 303))` → pool branch for 301.
- header u8 alpha flag sits BETWEEN the cell count and the cell array
  (`[u16 nc][u8 flag][cells]`) ✓ exactly where parse_bsv3 reads it.
- v>=303: 4-byte f32 skipped after magic (our "extra f32 1.0");
  v>=400: global alpha byte; v==302: name-blob skip (not in our pool).
- cells: `u8 namelen + name + 4 x i16`, name FNV-hashed to u64; stored
  reordered in memory `{w@8, h@a, x@c, y@e}` from file order
  (f1,f2,f3,f4 → @c,@e,@8,@a) — load-time reorder only, file order is
  what our parser reads and is authoritative.
- alpha flag byte after cells for 301<=v<400 (v103: absent, blocks 26 B;
  v303: present, blocks 27 B) ✓ our EOF-exact 26/27-B finding.
- v103 files: per-frame inline blocks `u16 n, u8 namecount(skip), n x
  {u16 ci, 6 x f32, [u8 alpha]}` — matches our "inline frames + u8 pad"
  (that pad = the engine's per-frame name-skip count byte).
- v303 files: global block table then frames as u16 index lists ✓ our
  pool model.
- trailing: anim table `{name→hash, u16 first, u16 last}` — the
  Active/Neutral ranges ✓.
- **block memory struct (stride 0x28): cellptr@0, a@8, b@c, c@10, d@14,
  x@18, y@1c, alpha@20 — matrix fields stored in FILE order, NO
  transposition at load time.** So the (b,c) transpose question is
  purely how the renderer multiplies; parser gives no hint either way.

Not yet found: the vertex-composition consumer of that struct. Structural
scan (phase 27) looks for f32 loads @0x18/0x1c + u16 loads @8/0xa
(LDR/LDP/LDR-pair forms) — AArch64 LDP pairs meant the first naive scan
missed; widened scan running.

### Official reference fit + draw order — attachment rule CLOSED (M4, 2026-10-19)

User supplied the official menu render `mapdump/renders/Giant_Robot_Menu.webp`
(84x176, robot faces RIGHT, closed jaw, both arms hang attached, shadow
ellipse). Fitting that render recovered the last two unknowns (transpose
sign, rotation pivot) AND exposed a third convention we had wrong: draw
order.

**Method** (harnesses kept in `mapdump/registration/`):
`m4-explicit-rule-test.py` (formula-explicit quad builder + numeric
joint checks), `m4-rule-windowed-fit.py` (per-block masked-NCC fit to the
2x-upscaled ref with phi pinned per rule), `m4-assembly-v2.py` (whole-
assembly NCC/IoU grid). Per-part free-fit on the 84-px ref is degenerate
(twin limbs collapse onto the visible side) — constrain phi per rule and
use the assembly-level luma NCC for stacking questions.
Pitfall fixed: `uv @ m.T` computes `m·(u,v)` — with `m=[[a,c],[b,d]]` that
is the TRANSPOSED rule regardless of how the matrix was filled; the first
grid runs had swapped T/N labels. Always write the two formulas literally
(XN: X=au+bv,Y=cu+dv / XT: X=au+cv,Y=bu+dv).

**Measured source-content axes (PCA on crops):** C_Upperarm_1 long axis
-25 deg (elbow left of shoulder), C_Forearm_1 and C_Femur_1 vertical,
C_Jaw_1 wedge at +54 deg. Reference facts: left upperarm hangs with elbow
about +25 deg right; file matrix is a pure +54.3-deg rotation -> the
rendered rotation must be VISUAL CCW, which is exactly what XT gives
(XT matrix column-2 (c,d)=(.812,.584): down-vector swings right).

**Rule-windowed fit verdict** (median residual, rotated blocks, 2x ref px):
XT-TL 11.6 | XN-TL 64.9 | XT-C 48.1 | XT-BC 67.7. Fitted phis matched the
file values one-for-one (Forearm_L +12.7 vs 12.7; Upperarm_L +53.3 vs
54.3; Femur +5.2 vs 4.2; Hand_L +5.0 vs 6.0) and every non-twin part sat
at a CONSTANT ~10 px offset from the XT-TL prediction (global canvas
offset only). => **X = a*u + c*v, Y = b*u + d*v, crop (0,0) pinned at
(x,y)** — the shipped placement rule was already right; the visible
brokenness was stacking (next paragraph).

**Draw order = REVERSE file record order.** Evidence (luma NCC of the
full assembly vs the reference, alpha-identical renders so only stacking
can move it): forward 0.807, REVERSED 0.903, shadow-first 0.832,
shadow-last-reversed 0.872. The three artifacts users saw were pure
stacking: toothed Jaw (record 5) painted over Head (record 4), rotated
Neck piston painted beside the head, Stomach coil/piston over the hip.
Pool audit: 350 v1 files carry shadow blocks; 277 have them in the file
tail, so reversed they draw first = behind (a descending-cell-index
"batched" order explains only 51/350 — rejected). v1 blocks have no
alpha byte when the header flag is 0 (GiantRobot: flag=0, stride 26), so
there is no per-block z key — reverse record order is the whole rule.
Consistent with a parser that prepends block nodes to a list.

`render_static` now composites `reversed(plan)`. Verified end-to-end:
shipped-path render of frame 38 scores luma-NCC 0.900 vs the official
render (was 0.807). Full pool regen batched with the neutral-frame
change (see CHANGELOG 2026-10-19.5).
Acceptance test for future rig surprises: rerun `m4-rule-windowed-fit.py`
against any official render — XT-TL + reversed draw order must come out
on top.

### East upperarm bbox-pin exception (M4, 2026-10-19)

User eye-test of the reversed-order GiantRobot render: "almost perfect —
the left shoulder (the one on the east side) is still in the wrong spot."

Diagnosis chain (all headless): the WEBP reference has a TRANSPARENT
background — every earlier silhouette mask built as `min(RGB) < 232`
after `convert('RGB')` counted the black-composited bg as silhouette
(sat 14779/14784 px!). Corrected mask = `alpha > 40`. With that, the
east-shoulder diff showed the upperarm rod drawn ~9 ref px too high;
local-window grid search (IoU+luma NCC, window x 52..80 y 36..62 ref px,
offsets in engine units) put the optimum at **engine Δ(−4, +114)**, IoU
0.673→0.932, NCC 0.190→0.763. Δ ≈ exactly `−b·w = 0.8119·141 = 114.5`,
i.e. this one block pins its **transformed-bbox top-left** at (x,y)
where every other rotated block pins the crop (0,0) corner. The implied
rotation pivot `(I−M)⁻¹Δ = (109, 61)` sits at the shoulder-cap art —
the menu render rotated about the rig joint, which the CITY bsv3 does
not encode (v1 block = u16 ci + 6×f32, stride 26 validated to exact
EOF: no pivot field; cells = name + rect only, no extra fields).

Ruled out: mirror-pair content-edge rule (west instance of the same cell
scores 0.955 at zero offset), crop-centre/bottom pivots (predict large
wrong-x shifts), a different animation frame (per-frame masked-arm NCC:
frames 0–3/37/38 tie at 0.577, others ≤0.38 — frame 38 pose is right),
per-rig global offset (all other parts fit at Δ≈0).

Action: `BLOCK_NUDGE` table in `tools/gen_city_sprites.py` records the
measured correction keyed by (asset, cell, anchor) — anchor-keyed so the
identity-pinned west twin is untouched. Applied in `render_static`.
Shipped-path score now total 0.826 (was 0.432); full-frame vs reference
IoU 0.933→0.956, luma NCC 0.808→0.872. Evidence + acceptance harness:
`mapdump/registration/m4-east-nudge-fit.py` (`--grid` re-runs the
search), `m4-east-shoulder-fixed.png`, `m4-east-shoulder-fixed-zoom.png`.
If future rigs show the same one-sided gap, test `Δ = −(0, min-corner-y)`
(bbox-TL) for the affected block before inventing new conventions.

### Provider architecture — 0x968xxx seed-computation attack (phases 21–27, 2026-10-19)

Attack on the one remaining open RE question ("who computes the
template road/river cells?"). Scripts `/tmp/opencode/GhidraLand1..7.java`
against the saved project `/home/dave/ghproj-mrsnrub/roadproj1`; dumps
`/tmp/opencode/ghidra_out/land_phase1..7.txt`. **Address gotcha
(revised):** in THIS project the Land-manager cluster + all string
anchors sit at the raw rizin addresses (`maptypes` @ 0x48dc0b,
`FUN_009689c8` …), while the RoadMap class region resolves at the §"RTTI
chain" addresses **+0x100000** (`FUN_0128bc54` = "helper 0x118bc54, 36
callers", `FUN_012adc24` = "0x11adc24", `FUN_0128b99c` = "0x118b99c,
2 callers in ctors" — all three matched by caller-count + behaviour).
Seed-list addresses must therefore be tried BOTH ways; a silent
NOFUNCTION line in the dump is the tell.

**Negative results (the important ones):**

* **No RNG exists.** Symbol census over every namespace for
  `rand/srand/random/srandom/drand48` returns nothing — libscorpio.so
  imports no PRNG and has no named one. There is no per-town seed to
  recover; the "seed-computation RE" question is CLOSED as
  not-a-thing-on-the-client.
* **0x968xxx cluster exonerated.** `FUN_009689c8` = the `maptypes`
  (landinfo.xml) DOM→record parser; `FUN_0096bbd8`/`FUN_0096a9e8`/
  `FUN_0096d128` = per-frame walk-agent updaters (build the walk
  Right/Up/Left/Down strings, spawn sprites, build per-land overlay
  RoadMaps gated by `DAT_01be3b70` land-type bitmasks 0x1b00/0x880900).
  No generator in the ctor trio.
* **No string→provider feeder.** The earlier "bl 0x118bc54(string,
  this+0x5a0)" note was the base mix-up: the callee is the provider→
  layer merge (`FUN_0128bc54(layer, provider)`, member-test per cell →
  alloc-0x180/delete), and the only writer chain into the provider is
  the 5 add-sites found by the phases 8–20 BL sweep (confirmed again
  via xrefs to `FUN_012adc24`: StartingLand rect fill `FUN_01238f24`,
  seam_a ×2 `FUN_0124cda4`, seam_b `FUN_0124d114`, dead wrapper
  `FUN_012add2c`).

**Provider class (`town+0x5a0`, town via `FUN_0115d988()`), fully mapped
(0x12ac000–0x12b3000):** a 64×64 `u64` sliding-window bitmap (origin
int32 at +0x2f0/+0x2f4, rows `+0x8 + 8*y`, bit `x−x0`), a coord push
list at +0x208/210/218, plus ~30 sibling vectors cleared by
`FUN_012acb74`. Methods: membership `FUN_012adda8`, add `FUN_012adc24`,
**frontier test `FUN_012addf8`** = member OR any of the 4-neighbours,
conditional add `FUN_012add2c` = `!member && frontier` (this is the
entire map-expansion growth rule), bounds `FUN_012b24ec` (window + 0x40).
`FUN_0115ef00(i)` = RoadMap layer i (0–9) from the
`DAT_01bf4338+0x58` vector; every rebuild path is the same
10-call unrolled block `[clear provider] → rect-add → 10×
FUN_0128bc54(layer_i, provider)` (`FUN_01238f24` bulk,
`FUN_0124cda4`/`FUN_0124d114` on `map+0x488` expand flag + width
compare `map+0x46c/0x468`).

**Config record layouts (the actual "definition beyond the tile grid"):**
`FUN_00f9bbdc` parses one land (from `maptypes`/landinfo.xml DOM):
`+0x130` GridTypeMap `base_type` ("grass") + `GridTypeRange` list of
`{typeName→hash, x_start, x_end, y_start, y_end}` **rectangles** — the
lattice-phase source: grid membership by coordinate range, no RNG;
`+0x1d8/0x1e0` RoadMap config vector, stride 200 B, each parsed by
`FUN_00f9f334`: `+0x00` texture, `+0x2c` name hash, `+0x4c` **drawer**
hash, `+0x50..0x68` PathBrush BST (entry: value u32 + name string),
`+0x28` layer, `+0x20` origin vec, `+0x18` second vec (size),
`+0xa0` behavior ∈ {road 0, river 1, ocean 2}, `+0xa4`
sidewalkGridType, `+0xa8` pavementType, `+0xac` roadType,
`+0xb0/b4` spawn/walkable prioritizeForGridTypes, `+0xbc`
searchPriority, `+0xc0..c5` animated/hasWalkableTiles/canSpawn/
hasBridgesOnRiver/checkGrassWhenSearching/checkRiverPathFindingCost,
JoinToMap roadMap-name hash vector +0x30..0x48, Conversion pairs
(gridTypeHash, sublandID) +0x88. Land record also holds
`+0x3c4` LandBlockPosition (x,y floats), `+0x3cc` LandBlockSize.
`GameState_PlaceLand` (`FUN_00a085a8`) walks the provider window and
places land props on `!road && frontier` cells — placement, not terrain
gen. Saved-string decode: `FUN_00eb4ebc` → per-cell `FUN_012a6288`
(`'P'`=0x50 → flag2 anchor; `'a'..'p'` → flag1 + subcell id),
callers are the f5/roadMapList codec wrappers (`FUN_00eb4b0c`,
`FUN_00eb5a80/5984/5a40`, `FUN_00ec1cfc/aa4`).

**Final model (replaces the "client-side generator" hypothesis):**
(1) server-saved layer strings are the per-town truth (decoded via
`FUN_012a6288`); (2) template streets/river phases come from the
landinfo config as RANGE-TESTED grid types + RoadEntry origin/size
(`origin="0,-7"`, `LandBlockPosition −3,−7`, block 40×64) applied
uniformly — every copy of a land type shares the identical lattice,
which is exactly the x≡3 / y≡0 mod-4 census lattice, so the lattice is
config, not save, and NOT unique per town; (3) client-side *growth*
exists only as the seam/frontier rule on expansion (explains the
walk-census unsaved stretches); (4) player brush strokes (RiverDrawing
etc.). Consequence for the tool: regenerating the "true" grid of an
arbitrary town needs no seed algorithm — StartingLand rect +
config-driven phases reproduce the template lattice, while per-town
which-streets-exist is only in the save (f5) or the walk-path oracle.
Still un-explored (low value): the drawer-hash dispatch table
(comparisons against `FUN_00969ab4` hashes) and the `GridTypeRange`
consumer `FUN_01208ec0`.

**Addendum — the tile-list template is real (`defaultfriend.xml`).**
The `FUN_011b41ac` caller of the phase-3 pavement parser reads
`x/y/sizex/sizey` off a `<Land>` root and hands each `<layer>` child to
`FUN_011b34d8`, which decodes `<tile x y building pavement leaving>`
lists (attr census via the `pavement`/`building`/`leaving` DAT keys →
the exact record-flag writes seen at `FUN_01234d64/ebc/f8c`).
`/tmp/opencode/gsdata/defaultfriend.xml` is the only gsdata file in that
format: `<Land x="1" y="0" sizex="11" sizey="6">` + `<roads
tilecount="1056">` (998 parsed tiles covering the full 44×24 grid,
attrs building 571 / leaving 426 / pavement 132; full-height avenue
columns at x=4,5,6,8,12,13,16,17,… and full-width street rows at
y=0,11,12,13,14,16,19,23) + `<rivers tilecount="1056">` (61 stroke
tiles). `startingland.xml` has the same root attrs but its
roads/rivers/dirt elements are `tilecount`-only stubs — so the
per-town truth stays in the save, while **friend/default towns ship a
complete tile-level street grid as data**. Phase-8 string scan: the
filenames `defaultfriend`/`startingland` do NOT occur in
libscorpio.so (the DOM is handed to the parsers by the caller — server
payload or generic asset loader); the `StartingLand` key is parsed both
in `FUN_00f9bbdc` and the town manager `FUN_0115b2f0`, `tilecount` in
`FUN_011b2a90` (same cluster), `tile ` in `FUN_01318fd4`/`FUN_0126f360`.

### Sprite scale S pinned — S=64 (M4 item 4, 2026-10-25)

`tools/fit-sprite-scale.py` measures S empirically (the engine float
`*PTR_DAT_01bbcac8` is config-loaded, no local config — CDN only, so
static/config sourcing was dead ends). Method, mirroring drawSprite's
model (`k = cam_scale/ART.S`, paste top-left = pin − anchor·k):

    S = cam_scale_export / k_best,   cam_scale_export = pitch / sqrt(1.25)

(pitch = local export px per tile step from the ground homography; TILE
hw=1, hh=0.5 → one tile side = sqrt(1.25) world units, the same px-per-
world-unit convention as CAM.scale.) k_best is found by masked EDGE-NCC
of the sprite's bottom band (bottom 35-50% of the alpha bbox) against
the full-res export screenshot — bottom band because the ground
homography is exact only at ground level (billboard height is a
clip-space quad).

Lessons the runs taught (each cost a full run):

1. **Intensity NCC is size-biased**: smooth low-texture windows win by
   inflation, so whole runs rode the scale-grid edges (fake 0.9 peaks).
   Correlating gradient maps (edge-NCC, 3-tap box blur on BOTH sides —
   the game renders filtered art) is what produced usable curves.
2. **The shipped g2e-homog.json is an exact 4-pair fit** (kept =
   lighthouse/squidport/pier/police = 8 equations for 8 DOF, zero
   validation). Away from those landmarks its extrapolation error
   reaches 100+ px — a whole fit run was scoring street texture at pins
   where the building was not (SpringfieldLibrary pin 126 px off its
   base; that instance's save position evidently postdates the
   screenshot). The tool now refits LSQ over all pairs minus zoo
   (residuals ≤11 px except lighthouse 29/pier 31) — and even then only
   the calib-verified landmark buildings are pin-trusted; ordinary
   instances can be save-vs-screenshot stale.
3. **Position must be free in the fit** (±12..170 px window): the pin
   error is a data property, not noise.

Verdict: the two registration-verified landmarks — Kwik-E-Mart (pair
residual 1.6 px) and PoliceStation (11 px) — both peak at **S=63-64**
(unimodal blurred edge-NCC curves, S 56..84 step 1; peaks 0.314 @64 and
0.436 @63). Third candidate (MakeAThingWorkshop, hospital pair residual
3.9 px) never locked — its screenshot patch is occlusion-heavy, curve
flat ≤0.12, discarded. S=64 == the PX_PER_UNIT candidate from the route-B
RE note above, closing the "62 vs 64" question. The fitted offsets
carry a systematic dy ≈ +5 tiles (building bases below the H-projected
pin) — that is the calib-click semantics (pairs were clicked on
building fronts, not at lattice-corner pivots), consistent with the
user-verified ax=ay=0; it is NOT a renderer nudge.

Shipped: `ART.S = 64` (city-view.js defaults + btn-tune reset), Art
button default flipped ON (artMode ships 1; localStorage
`mrsnrub.cityview.art` still overrides), city-view.html v=29. Evidence:
`mapdump/registration/m4-sfit-{kwikemart,policestation}.png` (fitted
S=64 vs shipped-62 pastes on the export, 3x). Smoke: boot pill expects
the visible art readout; toggle sequence ships-on -> blocks -> sprites.

### M4 TODO 7/8 closed — full-map street scan + 1-wide straight art (M4, 2026-10-25)

**Item 7a RE closed (static).** The street creator is the XML land
loader (`FUN_011b41ac` STARTINGLAND_PARSER -> `FUN_011b34d8`); there is
no procedural N–S generator in libscorpio — every rendered N–S avenue is
either template (starter land) or client-side, never persisted.
Address convention: notes addr = file offset = vaddr = rizin addr;
Ghidra scripts use addr + 0x100000.

**DISCARD warning.** Pre-2026-10-25 "cell_index verifications" and the
f5 raw-slice band sweeps in earlier notes were bogus (misread bytes /
wrong cell formula from `tools/cell_find.py` — its `cell_index(tx,ty)`
takes TOWN TILES with CELL_OX/OY=(−48,−112), stride 37, block formula
`((row//4)*37+col//4)*16+(row%4)*4+col%4`). All pre-existing f5 raw
cell-coordinate claims must be treated as unverified.

**Saved-road ground truth** = `LandMessage.roadsData.mapData` (34784
chars, save `mapdump/23034074771109153854742696256123764495.pb`),
decoded with the authoritative `decodeTiles` from `web/js/map-explorer.js`
(char i -> row i//32, x0=(i%32)*16, 'a'..'p' = 16-bit nibble mask,
'P' = all 16, 'G' = empty). Distribution: 832 'm' (mask 12, 1-wide N–S
driveways, always x≡12 mod 16), 350 'd' (mask 3), dense full-width P
rows 261–263 & 279–282 (+ P bands 146–149, 156, 164–167, 173–177,
183–189, 205–206). There are NO saved N–S boulevards at all — every
rendered N–S avenue is template/unsaved by construction.

**Frame finding.** The calib grid is ≈11.6 px/tile in the export (not
32) and the export is rotated ~28° vs the grid (H0[0,1]=+10.4,
H0[1,0]=−5.2; `/tmp/opencode/g2e_homog.npy`, rms 16, city extent grid
x −70..350, y 40..400). Every export sample needs a per-window offset
search ±80 px through H0 — raw export rows/cols must never be sampled
directly. The saved `mapData` grid could NOT be georeferenced onto the
export (full-band H0 sweeps ratio ≤0.31; driveway-cell probe hit-rate
19% vs 17% on +8-shifted controls — no signal). Consequence:
saved/unsaved classification of scan candidates is nominal-frame only
(scan grid == mapData nominal grid); it is sound for the avenue rows
(saved rows 261–263/279–282 classify saved, everything else ~0) but
individual candidate coords stay soft ±7 tiles.

**Scanall methodology** (`/home/dave/tmp/m4roads/scanall.py`):
vectorised grey-mask window scan, main-band mean ≥0.8 + flank ≤0.5
(12-row windows, step 3), ±80 px offset search through H0 per window.
Reproduces all 5 verified avenues (66->0.917, 90->1.0, 30, 126). Full
outputs `scanall_ns.json` (7945 hits) / `scanall_ew.json` (8316 hits);
segment clustering -> `ns_cands.json` / `ew_cands.json`; deduped
deliverable `m4-street-candidates.json` (56 NS + 59 EW, ids
`nsNN`/`ewNN`, fields x0,x1,ylo,yhi,mean,saved). TODO-target band
CONFIRMED: unsaved E–W road rows 217–228 x123–171 mean 0.984–0.985
(east segment) and rows 218–232 x9–93 (west segment). Eye-test tool:
`tasks/m4-road-review/` (annotated crops A–L + per-candidate verdicts +
JSON export; regenerate with `build_review.py`).

**Item 8 — 1-wide straights CLOSED (engine has the art).**
`FUN_01308058` ROADDRAWER_BASETILE_SELECTOR draws EACH cell as 4 iso
quadrant quads (parallelograms, hw-ratio 0.516 = tile ratio), each quad
picking one of 11 UV descriptors at file 0x400520 (11×32 B, verified
against `roadtilesheet.png`) based on the cell nibble (E=1,W=2,N=4,S=8)
+ neighbour probes via vtable +0x30/+0x18 + flag `FUN_01234cf0` + flip
toggles (3/4, 6/7, 9/10 pairs). Contact sheet
`mapdump/registration/m4-roadstates11.png` classifies the catalogue:
0 = flat interior, 1/4/10 = 1-wide diagonal straight bands, 3/6/9 =
bends/dead-ends, 2/5/7/8 = T-junctions. So masks 3/12 need no new art —
the "gap" was only our one-piece-per-cell simplification. Shipped quick
win: `SHEET_TABLE[3]=[3,false]`, `SHEET_TABLE[12]=[4,false]` (was
state-0 fallback); before/after montage
`mapdump/registration/m4-mask312-art.png`. Full quadrant replication of
the selector remains the unchosen high-fidelity option. Smoke spec
updated in `tools/smoke-camera.cjs`. (Pre-existing unrelated failures
during the run: `smoke-map-explorer-dom` variant data-tip assertion,
`smoke-scene` node heap OOM — neither loads terrain.js.)

**2026-10-25.5 — road art fidelity: P cells, sidewalks, 4-col avenues.**
User eye test: "roads still misplaced … all roads missing the sidewalk."
Export transects across the verified N–S avenue at the H0 offset
(−18,−22) measure **L-A-A-L across cols 89..92** (lavender sidewalk
columns each side of the 2-col asphalt core); E–W avenues in the
cell decode (road.s, `decodeCells`) are **single-cell-tall 'P' bands**
(town rows 32–35, 48–51 … i.e. 4 tile rows = the full L-A-A-L
cross-section), rows 108–147 are the plaza slabs. Anatomy conclusions:

1. The "sidewalk occupancy cells" theory was WRONG: the engine paints
   the sidewalk lanes from the sheet art itself — states 3/4 are
   asphalt+kerb+lavender-paving composites (montage
   `m4-roadstates11.png`, band strips `m4-band-state3/4.png`).
2. Our renderer had a routing bug: `f[3] >= -1` is always true for
   cell-codebook roads, so *all* saved road cells — 'P' included —
   went through `cellStateFor` ('P' → hard flat state 0) and the
   `sheetSelect='neighbor'` branch was unreachable. Fixed with
   `Terrain#_pavePick`: occupancy-union mask selects art; mask 15/0 →
   flat; plaza slabs (vertical run ≥ 8) → flat; band-edge rows 7/11
   (thin + continuous) → kerb states 3/4; a band one cell tall draws
   the mirrored kerb as a second pass clipped to the far half
   (`_halfClip`) so both edges get sidewalks.
3. `Terrain.AVENUE.streets` entries were the 2-col asphalt cores; the
   physical street is 4 cols wide, so entries now include the sidewalk
   columns ([65,68] [89,92] [113,116] [29,32] [125,128]); the avenue
   pass's union masks already give flat interiors + 13/14 kerb flanks.

Evidence: `mapdump/registration/m4-av-avenue{90,285,313}.png` (export
ground truth), `m4-sidewalk-beforeafter.png` (renderer before/after
mock of the composite). The residual "misplaced" reports remain the
soft nominal-frame registration issue (scan coords ±7 tiles) —
eye-test via `tasks/m4-road-review/` is the arbiter before promotion.
