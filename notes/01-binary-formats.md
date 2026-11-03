# 01 — Binary formats (reverse-engineered, verified)

Everything below was verified byte-exact against real files (exact-EOF
parsing, rendered output cross-checked visually, and against the community
reference repo https://github.com/al1sant0s/tsto2rgb — the authoritative
ground truth for the pixel formats). Implementations live in
`tools/extract_assets.py`; do not re-derive these, reuse the pipeline.

## Pack container (APK packs AND CDN packs — byte-identical)

Packs live at `assets/<group>/<name>/` inside the APK (10 packs), and as
`<PkgName>-<tier>-r<revision>[-TAG].zip` on the CDN. Every pack is **two
files**:

- `0` — a small **`BGrm`** index/manifest: magic `BGrm`, then a u32 version
  (515 for everything seen). Redundant with the ZIP — only the version is
  recorded in the manifest. (One index leaked a dev build path:
  `Users/jharding/Apocalypse/4.2.0_WhackingDay/pack…` — "Apocalypse" is the
  Bight project codename.)
- `1` — a **plain ZIP** of the asset files. No custom parser needed:
  `zipfile.ZipFile(z.read('assets/<group>/<name>/1'))`.

Loose files (e.g. the engine's 4 GLSL shaders) can sit next to `0`/`1` —
the pipeline reads those too. Watch out: some CDN zips store the **same
filename multiple times at the zip root** (byte-identical copies, e.g.
`abe_menu.rgb` ×8 in `menu-*-r2`); the pipeline now skips repeats within a
pack (this caused 516 duplicate manifest entries until fixed).

## `.rgb` — the game's image format

Header (all little-endian): `[u32 flags][u16 width][u16 height][pixels]`.
`flags` = u16(0) ‖ u16(colorflag) packed:

| flag | pixels | decode |
|---|---|---|
| `0x0000` | 4 B/px | straight RGBA, plain |
| `0x2000` | 2 B/px | **premultiplied** RGBA4444 — un-premultiply on decode |
| `0x6000` = `0x2000\|0x4000` | 2 B/px | **straight (unmultiplied)** RGBA4444 — do **not** un-premultiply |

The 2 B/px layout is the same in both variants: **RGBA4444 with channel
order B,A,R,G, high nibble first**:

```
byte0 = (B<<4) | A
byte1 = (R<<4) | G
```

Un-premultiply for the `0x2000` files: `c8 = c4*255//a4`, `a8 = a4*17`,
with an opaque fast path (`c4*17`).

How each fact was established (so you know it's solid):

- The 4-bit layout was cross-checked against `tsto2rgb`'s ImageMagick
  writers, which produce exactly this channel order.
- An earlier "gray + alpha" reading of the 4-bit data was only *accidentally
  close* (the art is mostly flat-colored) — the splash/buildings were
  mis-colored until the fix in CHANGELOG `2026-10-13.2`.
- `0x6000` was proven straight-alpha because in 88/88 affected files (menu
  level-select `levels_level*.rgb`, `unlock_lock.rgb`) channel nibbles
  **exceed** the alpha nibble — impossible for premultiplied data; the
  premultiplied decoder crashed on them.
- `flags & 0x20000000` (the u16 flag = 0x2000/0x6000, i.e. depth 4) is the
  classic test; most game art is depth-4, large-class splash art is depth-8.
- The manifest records a `premul` boolean per image and the explorer shows
  "premultiplied" vs "straight alpha".

## `.btp` — localized string packs

16 languages × 90 keys each (`scorpio_core_<lang>_<cc>.btp`).

```
"BTP\0" + 20-byte BIG-ENDIAN header:
    u32 file_size  @8
    u32 entry_count @12          (90)
entries, lengths BIG-ENDIAN:
    [u8 name_len][name + NUL][u32 str_len (incl. NUL)][string][u32 gap]
    — no gap after the final entry
```

Mixed-endianness trap: the magic-adjacent count/size fields are big-endian
while a naive read assumes LE — the parser bit here twice. All 16 files
parse to exact EOF. Output: `web/assets/i18n/<lang>.json`.

## `.bcell` — character sprite animations (magic `bcell10`)

Frame pixels are embedded in the file (characters have **no** standalone
`.rgb` sheets).

```
"bcell10" (7 B)
u16 n_records
u32 unknown            (22 for idle, 61 for walk — meaning unknown, unused)
per record, 13 bytes:
    f32 delay_ms       (e.g. 60 / 45)
    i16 x_off          (draw offset, e.g. -35; NOT the frame dimension)
    i16 y_off          (e.g. -193)
    5 bytes            stream coordinates, semantics unknown (not needed)
                       — the LAST record's final byte is 0x20
per UNIQUE frame, in record order (there can be FEWER blocks than
records — records after the last block hold the final frame):
    first block:  [u16 w][u16 h]
    later blocks: [u32 0x20000000][u16 w][u16 h]
    followed by w*h*2 bytes of premultiplied RGBA4444 B,A,R,G (same as .rgb)
```

Gotchas that were real bugs:

- Frame w/h come from the per-frame header, not from the x/y offsets
  (idle record says x,y = -35,-193 but the frame is 74×202).
- Records outnumber blocks: `abe_feed_pigeons` = 29 records / 27 blocks.
- No zlib, no lzma, no compression — raw pixels (files 30 KB–2.4 MB).

Verified: parses to exact EOF on **all 4,053 files** of the complete 3.0.30
CDN content; rendered frames visually perfect (Abe idle/walk/feed, Homer,
THOH variants). 46 characters total: the 26 playable (abe, apu, bart,
cletus, comicbookguy, duffman, hankscorpio, hansmoleman, homer, krusty,
lisa, luigi, marge, milhouse, moe, mrburns, ned, professorfrink, quimby,
revlovejoy, sideshowbob, skinner, snake, squeakyvoiceteen, wiggum, willie)
plus Treehouse-of-Horror zombies/ghosts and event variants.

A newer `bcell13` writer exists in tsto2rgb (adds NUL frame-name strings,
f32[7] tail per cell) — fully decoded 2026-10-23 (see below); the 3.0.30
core pack itself is v10-only.

## `.bcell13` — 4.x character cells with external frames (decoded 2026-10-23, placement corrected 2026-10-25)

The 4.x event packs ship character animation as `bcell13` cells whose
pixel data is EXTERNAL, in `<cell>_image_N.rgb` files beside the cell in
the same pack (bcell10 embeds its 4444 blocks inline). Layout:

```
'bcell13' u8 ver u16 n_frames
per frame:
  u8 name_len (incl NUL)  '<...>_image_N.rgb\0'
  f32 delay_ms
  i16 x_off  i16 y_off        <- sprite top-left vs the character origin
  u8 0  u8 n_layers
  n_layers x ( u8 l1 s1\0  u8 l2 s2\0  7 x f32 )
```

The frame's sprite is the external `<cell>_image_N.rgb` image drawn at
scale 1.0 with its top-left at (x_off, y_off) relative to the character
origin (feet on the ground line, y down) — exactly bcell10's i16 record
offsets. The tsto2rgb writer (tools/tsto2rgb, the format's own
reference) confirms it writes `x = -w/2 + offsetX*scale/100`,
`y = -h + offsetY*scale/100` there, i.e. bottom-centre minus a per-
cell-definition registration offset (baked art is a tight crop: e.g.
exorcismpriest 74x222 -> (-35,-214) => anchor (35,214)).

The (kind, kind+`.rgb`) layers are ground OVERLAYS ONLY: SHADOW /
POSITION / INDICATOR / null. There is NO sprite layer in a bcell13 —
using the first layer's floats (they are the SHADOW texture transform,
e.g. (-40.95,-19.65,0.674,...) for standard-size characters; 0.674 is
the stock overlay scale, moped-sized cells ~1.167) as sprite placement
was the old bake bug that shrank every 4.x character by ~0.67 and left
bogus constant anchors. Frame `.rgb` files are the standard 4-bit
premultiplied RGBA4444 sprite variant (`rgb_to_rgba` decodes them
unchanged); their header is u32 flags (0x20000000 = 4-bit), u16 w,
u16 h.

Character screen scale: art pixels map 1:1 with building art
(64 px per tile unit at scale 1) — measured from the 16200x8370
screenshot: road border stones give the ~1 tile step (12.3x6.1 px at
full res) and the landoctopus frame (202 px art) measures ~3.6 tile
diamonds -> ~56-64 art px per tile.

Verified: parses to exact EOF on **all 14,328 bcell13 cells** of the
extracted pool (2026-10-25). Rendered by `tools/gen_city_sprites.py
chars`; companions are harvested on demand from the cdn bundles (the full
companion set is ~165k distinct files — too large for the tmpfs pool).
`bcell11` (289 pool cells) is a lighter undecoded variant — same name +
delay preamble, no SHADOW strings.

## `.bsv3` — building animation scenes (fully decoded, rendered)

Two magic variants in the 3.0.30 city pool (3,618 files): `0x0103`
(3,476 — ordinary buildings, frames stored inline) and `0x0303`
(142 — landmarks with moving parts, shared block pool). Both must parse
to exact EOF; `tools/gen_city_sprites.py sprites --parse-only` verifies
the whole corpus (3,618/3,618 green, 2026-10-16).

### `0x0103` — inline frames

```
u16 0x0103            magic
u16 n_cells
u8  alpha_flag
per cell:  NUL-terminated name + i16 x, y, w, h   (sheet crop rects)
u16 n_frames
per frame: u16 n_blocks, u8 pad(0), n_blocks × block
    block: u16 ci, f32 x, f32 y, f32 a, f32 b, f32 c, f32 d
           (+ u8 alpha iff alpha_flag)          → stride 26 or 27
u16 n_anims
per anim:  u8 len, name (len bytes, NUL-terminated), u16 first, u16 last
```

- `x, y` are **float pixels** — the cell crop's top-left relative to the
  building anchor (0,0). (The earlier ×100 fixed-point claim was wrong;
  retracted 2026-10-16.)
- `a < 0` → horizontal flip of the crop. `b, c, d` are rotation-ish
  floats near (1, 0, 0) for these files; the static renderer ignores
  them (records max |b| per sprite in the manifest).
- Named anim states (e.g. `Active`, `ActiveTop`, `Neutral`) delimit
  frame ranges; the static pick is the fullest frame overall (max total
  local crop area — frame 0 is often an effect overlay or a partial
  construction pose, e.g. cityhall's first state is a graffiti decal).

### `0x0303` — shared block pool

```
u16 0x0303
f32 1.0               (constant)
u16 n_cells
u8  alpha_flag
per cell:  (as 0x0103)
u16 n_frames
u16 n_blocks
POOL: n_blocks × (u16 ci, f32 x, f32 y, f32 a, f32 b, f32 c, f32 d
                  [, u8 alpha])                  → stride 26/27, ci FIRST
FRAME SECTION: u16 nb0, u16 pad(0), ceil(nf/2) records of three
               zero-terminated u16 runs (A, B, C)   (see below)
u16 n_anims
per anim:  (as 0x0103)
```

- **Pool layout was misread until 2026-10-31:** the old parser consumed
  the six floats first, then the `u16` ci — so every entry's ci actually
  came from the *next* entry, and the pool's leading u16 was invented as
  a "reserved" field. That off-by-one pairing is what shipped buildings
  shattered (playdoughfactory's blocks all drew the next cell's crop).
  With ci read first, `ci` is a plain LOCAL cell index on the whole
  corpus: every pool entry satisfies `ci < n_cells`, both alpha flags.
  The earlier "alpha=1 → global sprite handles" and "some files number
  cells from 1" theories were both artifacts of that misalignment and
  are retracted.
- **Frame section — decoded (cracked 2026-10-31 against playdoughfactory,
  arcdetriomphe, boulangeriepatisserie; 114/142 pool files decode
  fully).** After `u16 nb0` (frame-0 block count) and `u16 pad(0)` come
  `ceil(nf/2)` records, each three zero-terminated `u16` runs (A, B, C):
  `frame(2k)` draws A, `frame(2k+1)` draws C; B is the delta/add list
  and is not drawn. Reference forms inside a run: `v % 256 == 0` is a
  1-based pool reference (`pool[(v>>8) - 1]`); a plain `v` is a pool
  reference whose base (0 or 1) is an authoring-time choice that varies
  per file *and* per run, so each record picks the (baseA, baseC)
  combination maximising positional agreement between the A/C pair plus
  drawn crop area, with duplicate cells in one frame counted negative
  (a real frame never draws the same cell twice — that penalty is what
  separates the arc's 0-based `{Crop0, Crop1}` from the mis-shifted
  `{Light_Crop1, Crop0}`). Proven cases: arcdetriomphe 0-based,
  boulangeriepatisserie 1-based, playdoughfactory 1-based.
  `nf == 1` files (footballfield, hangar, japanesecherrytree) carry just
  the nb0/pad header — the lone frame is the whole pool. Files whose
  runs don't validate under any base (the delta-style encodings:
  terminal, bastille, planebot, deathtable, kinghomersskyscraper …,
  28 files) keep the legacy fallbacks: the leading-`(idx<<8)` run, then
  `_v3_runmax` (split the whole section on zeros and take the
  zero-separated reference run that draws the most sheet art, scoring
  each `(cell, position)` slot once — this recovers kinghomersskyscraper's
  complete tower + King Homer pose), then the one-block-per-cluster
  picture, then the largest cell alone.
- Static renderer: with frames decoded it picks like 0x0103 — the
  Neutral anim's first frame when that frame carries the building
  (≥ 40 % of the fullest frame's local area; a v3 "Neutral" can be a
  piece-frame, e.g. ktvbuilding's glass facade), else the fullest
  frame. Without decoded frames it decodes the leading run, caps it to
  one block per position slot (same-ci, 64 px clusters), and falls back
  to per-cluster representatives when the run is too thin.
- **Anim-section location (works on all 142):** backward walk from EOF —
  per record try L = 2..63 with the len byte at `end−5−L` equal to L,
  printable NUL-terminated name, `u16 first/last` at `end−4`; stop when
  the `u16` just before the first record's len byte equals the record
  count. The section is then forward-parsed to exact EOF. (An odd-sized
  frame stream shares its final 0x00 terminator with the anim count's
  high byte.)

Static compositing (first M1 milestone): `web/assets/city/<slug>.png` +
`city-sprites.json` (canvas bbox top-left origin, anchor = building
(0,0) in canvas px). 3,592 of the 3,630 save-required slugs render; the
38 misses are fence/wall/railing/track pieces whose pool packs ship no
billboard sprite (M2 terrain scope).

Building definition `.xml`: `<Building x= z= height= locX= locY=
transImageX= transImageY=/>` (1,344 files, passed through as data).

### Building ID → name → asset catalog (fully recovered, local-only)

The numeric `buildingData.building` IDs join to real names and footprints
through the **`gamescripts-r*.zip`** packs (cumulative, newest = r497432 in
the 4_69 pack). Chain, all verified against the save:

1. **id → name**: `<Building id="N" name="Foo" ...>` in `gsdata/*.xml`
   (core `buildings.xml`, per-event `*_buildings.xml`/`*_decorations.xml`).
   **Only** `<DataID>` entries from `buildingmasterlist.xml` may fill gaps —
   every other master list (characters, jobs, consumables, …) shares the
   same numeric space and WILL collide (e.g. id 3 = Kwik-E-Mart, not Homer).
2. **name → asset**: `<BSv2 name="..." [flippedname=] [nameFlipSE/SW/NE/NW=]>`
   inside the `<Building name=...>` block, in `*assetdata*.xml` files *and*
   inline in building defs. Parse the attribute dict; prefer plain `name=`;
   if only `nameFlip*` exist it is a directional fence.
3. **asset → footprint**: `asset.lower().xml` from the per-building data
   pools. Footprint XMLs live in the nested payload (`1`) of every
   `*Game-100*` / `*Game_LTD-100` / `*BuildDecoGame*{Fall,Snow}-100` zip in
   `cdn/` (611 families extracted; pool holds 5,446 unique footprint
   slugs vs 137 in the core web assets). Some slugs (e.g. `spookywall`,
   `trackstraight4x2`) exist **only** in the seasonal snow/LTD variant zips.

Saved: `data/building_ids.json` (3,440 ids → name/asset/slug),
`data/building_footprints.json` (5,446 slugs → x/z/locX/locY/height),
`data/save_buildings.json` (this save's 2,299 ids resolved, 100%).

### Footprint rect + flipState semantics (verified)

A building at `(positionX, positionY)` covers tiles

```
X: [posX - locX + 1, posX - locX + x]    Y: [posY - locY + 1, posY - locY + z]
```

(locX/locY are 1-based corner offsets; loc=1 ⇒ rect starts at the position.)
Verified: SimpsonHome (8×6, loc 4,1) and FlandersHome sit side by side
fronting the Y=29–30 road; Kwik-E-Mart (7×4) fronts the Y=39 road on its
south side; a flipState-1 church fronts the road on its south (flipped)
side with no overlap.

`flipState` (0..3): for normal buildings 1 = mirror — and the mirror is
a full **twin-swap placement**: the engine applies the `<slug>flipped`
twin's footprint semantics (x↔z, locX↔locY swap) **even when no twin art
ships**, and the mirrored art is anchored at (w−ax, ay) about the
position point (2026-10-25, save-measured): every twin-less asymmetric
asset with fs=1 chains at the swapped spacing — PurpleHouse 7×6 rows
step X by 6, WhiteHouse 6×4 by 4, Flowers02 1×3 by 3 (all 12 instances
are fs=1), HorseTrough/FrontierFence/TireFence 2×1 columns step Y by 2,
KrustylandTurnstile 2×4 by 2.  This is also why twins themselves swap
x/z in their footprint XMLs: a horizontal mirror of iso art maps the
+X axis onto the +Y axis, i.e. mirror = the 90°-look "rotation".
fs 2/3 never occur on non-fence buildings
(2026-10-25 histogram: all 154 fs=2/3 placements belong to the
directional fence families);
for directional fences it selects the `nameFlip{SE,SW,NE,NW}` variant
(**0=SE, 1=SW, 2=NW, 3=NE** — re-derived 2026-10-25 from this save's
IronRailing enclosure under the SHIPPED camera orientation (CAM.ORIENT
fx=1, fy=-1, swap=1: +X runs upper-right, +Y lower-right). Chain
spacing pins the pairs — fs 0/2 pieces step along X (need the x=2
variants se/nw), fs 1/3 along Y (need the z=2 variants sw/ne) — and
which side of the enclosure each stands on (via the bsv3 anchors)
picks se/sw for fs 0/1 and nw/ne for fs 2/3. Two earlier guesses were
wrong: the .rodata-string-order claim 0=SE,1=SW,2=NE,3=NW had 2/3
swapped (90°-off rows/columns), and an interim re-derivation reasoned
with the wrong screen axes and produced 0=SW,1=NW,2=NE,3=SE);
SE/NW variants swap x/z relative to SW/NE (confirmed on 4 fence
families); monorail
`StraightTrack` (109500) uses base 4×2 at fs=0 and the `...flipped`
asset 2×4 at fs=1 (pieces chain contiguously, 4-tile spacing).
Curve pieces are 4×4 centred (loc 2,2).

Engine corroboration (libscorpio.so strings): `MirrorFlipStateComponent`
(+ its XML child `<MirroredFlipState se= sw= ne= nw=>`, used by 5 curve
pieces to remap fs→direction), `flippedname`/`flippedbsv3`/`flippedanim`
(explicit flipped-art overrides on `<BSv2>`/`<EffectOverlay>`, e.g.
`LisaStatueFlipped`), `nameFlipSE/SW/NE/NW` (the fence families), and
placement-UI flags `<Flippable value=>` / `<DirectionsToFlip value=>`.

## Audio — the game's 13.6k WAVs ship as IMA ADPCM (browsers CANNOT play them)

RIFF fmt **tag 17** (IMA/DVI ADPCM), mono, 22 050 Hz (715 DLC files at
24 000 Hz), FFmpeg-written (`ISFT Lavf…` in the LIST/INFO chunk). Browsers
decode only PCM/IEEE-float WAV, so every `play()` rejects with
`NotSupportedError` — that is the "no sound anywhere" report, and why the
explorer handler mislabeled every rejection "(autoplay blocked)".
**Fixed 2026-11-03: `tools/convert_audio_pcm.py` re-encodes the corpus with
ffmpeg.** The playable corpus is now **AAC-LC 96k in `.m4a`** (`--format aac`,
13 643 files, 1.32 GB of WAV → 338 MB). Each output is verified before it
replaces the original — ffprobe says `aac`/same rate/same channels, the `moov`
atom precedes `mdat` (`-movflags +faststart`, otherwise the browser cannot
start before the whole file has arrived), it decodes back to s16le non-silent,
and the decoded frame count agrees with the ADPCM block arithmetic. Nothing is
deleted: the ADPCM originals live in `var/audio-adpcm/` (and the 67 PCM16 CDN
loops that never were ADPCM in `var/audio-pcm/`), and `--restore` puts either
kind back. `op=original` serves the ADPCM to the explorer's download link.
PCM16 (`--format pcm`) is still supported — it is what the corpus was from
2026-11-03 until the AAC switch, and `--restore` returns to it.

Format notes, for anyone decoding these by hand again:

- Block layout: **1 024-byte blocks** = `u16 predictor` + `u16 index` (≤88)
  + 1 020 nibble bytes = **2 041 samples/block** = `(blockalign - 4) * 2 + 1`
  (measured: `fact` says 10 205 samples for 5 blocks of `blockalign=1024`;
  the "2 044 samples/block" written here earlier was wrong).
- Standard IMA/DVI step table (89 entries, 7 … 2 149 687) and index deltas
  `[-1,-1,-1,-1,2,4,6,8]` twice; index clamped 0–88, predictor clamped
  ±32 767, output s16 little-endian.
- Per nibble, canonical IMA with the sign in bit 3:
  `diff = ((2 * (n & 7) + 1) * step[idx]) >> 3; if (n & 8) diff = -diff;`
  then `pred += diff; idx += delta[n]`. The formula recorded here earlier —
  `-(n&1) - 2*(n&2) - 4*(n&4) - 8*(n&8)` — uses bit *values* instead of bit
  positions and does not decode IMA.
- Nibble order is NOT ambiguous here: FFmpeg's `adpcm_ima_wav` (which wrote
  these files) is low-nibble-first, unlike its `adpcm_ima_qt` sibling. Do
  not settle it with the consecutive-sample MAD heuristic this file used to
  recommend — on this corpus the two orders score within 1% of each other,
  so the test can't tell them apart. Use a reference decoder.
- The RIFF `fact` chunk sample counts are off — compute duration from the
  decoded frame count (`bgloop.wav` was indexed at 50.7 s but is 55.0 s).
- Manifest flags: `audio_format` is the fmt tag (PCM mode only — an MP4 has
  no fmt tag, so an AAC entry drops it), `codec` is one of
  `pcm`/`float`/`ima-adpcm`/`aac`, and re-encoded entries keep
  `codec_src: 'ima-adpcm'` where an ADPCM original really is in the backup
  tree. `tools/smoke-explorer.cjs` fails the build if an audio entry's file is
  missing, is neither AAC-in-MP4 nor PCM/float WAV, has its `moov` after its
  `mdat`, or whose `codec`/`duration_s` disagree with the container.
- Why AAC and not MP3/Opus: encoded from the same PCM at 96k, AAC measured
  32.7 / 35.2 / 43.7 dB SNR against the WAV on the three audition clips vs
  ~25.8 dB for MP3 96k, at 25–30 % of the WAV size; Opus in Ogg was rejected
  over Safari/Ogg support risk. The clips are in `mapdump/registration/`
  (`m4-audio-{pcm,adpcm,aac96,mp396,mp364,opus48}-*`, plus
  `m4-audio-aac96-playable-*` which are byte-identical to what the site
  serves now).
- The files themselves are intact: an independent stdlib IMA ADPCM decoder
  (canonical step table, low-nibble-first) reproduced ffmpeg's PCM to
  **max sample difference 0** over 77 558 frames, and the corpus' head
  silence has a **median of 20 ms** (438 files ≥ 0.25 s, which is why a few
  sounds *feel* late even when nothing is dropped). So "the beginning is
  missing" was a playback-side problem, not a decoding one — see
  notes/02-architecture-and-decisions.md.

## Video (movie packs)

H.264 MP4 + AAC (`movie-intro` + `movie-cutscene01/02/03` × 4 device tiers
`ipad/ipad3/iphone/retina` × 7 languages `de/en/es/fr/it/ko/zh`).
Pipeline does a **pure-stdlib MP4 box walk** (no ffmpeg required) for
metadata; useful offsets verified against ffprobe:

- `stsd`: payload = ver/flags(4) + entry_count(4), then entries; sample
  entry fourcc at `es+4`; **width = `es+32`, height = `es+34`** (es = entry
  start including size+type).
- `mvhd`/`mdhd`: version = byte 0; timescale u32 @+12; duration u32 @+16
  (v0) / u64 @+20 (v1).
- ffmpeg poster frames: input-seek (`-ss` before `-i`) fails on pipes —
  write a temp file (ffmpeg 6.1.1 on the old machine). Poster = frame at
  t=1 s, 320 px JPEG → `dlc/<pack>/thumbs/`.

## Other formats

- **`.txt` sidecars**: anchor coordinates as two u32 fixed-point values
  (e.g. `500000000,500000000` = 12.207,12.207 at 1/41943040 scale) —
  decoded into the manifest `anchor` field.
- **fontcache** (CJK `fontcache_0/1` blobs in the `1_0_4` packs): custom
  pre-rasterized glyph-atlas binary, **no known decoder** — deliberately
  skipped (`--skip fontcache` in the batch driver). 4 packs.
- **DLCIndex XML** (master index inside `DLCIndex[-v…].zip`): `<Package>`
  entries with `FileName val="DIR:file.zip"` → CDN path
  `static/DIR/file.zip`; `FileSize` is in **KB**; `IndexFileSig` = real
  96-hex RSA digest (stripped to the placeholder *"You should patch the
  APK/IPA to bypass this!"* in the fan build's main list).
- **`splashscreen.xml`** (APK `core` pack): declarative splash layout — 11
  aspect-ratio rulesets (22:9 … 4:3) with background crop windows,
  placement offsets, `single_edge edge=right` + `keep_center
  moving_edges=vertical` policies, per-language logo elements.
- **`customdevicescales.xml`**: device scaling config + full in-game menu
  enum list (`eMenu_Loading`, …).

## Terrain & roadmaps — the city map grids (inside a city save)

A city save (`.pb`, e.g. `mapdump/23034074771109153854742696256123764495.pb`,
extracted from the uploaded `23034074771109153854742696256123764495.7z`) is a
plain **`Data.LandMessage`** protobuf — the complete server-authoritative city
state (53 top-level fields; full schema in `re/proto_schema.txt`). It parses
to clean EOF with the project's compiled proto
(`server-python/protofiles/LandData_pb2.py`, which needs the
`google.protobuf.runtime_version` shim for the system protobuf 4.21.12).
Decoders (both stdlib + that shim):

- `tools/decode_land.py <city.pb>` — human-readable dump of every section
  (identity, user data, buildings, characters, jobs, quests, terrain,
  storage bundles, …) with cross-checks (every `num*` counter vs. actual
  array length).
- `tools/terrain_dump.py <city.pb> [outdir]` — every `TerrainData` payload
  with type/size metadata and a char histogram; with `outdir` it writes each
  raw grid to `<outdir>/<name>.txt`.

Sample save identity: town *trawg*, level 939, land id
`23034074771109153854742696256123764495`, 5,261 buildings, 871 characters,
43 storage bundles, 5 minigames.

### `TerrainData` schema (verified against the compiled proto)

```
message TerrainData {
  EntityHeader header     = 1;  // .id: 7 for roadsData, 8 for riversData, 0 elsewhere
  uint32       mapDataSize = 2; // == len(mapData), in CHAR units
  string       mapData     = 3; // the grid: 'G' empty, else one cell per
                                // char (see "Terrain grids: CELL semantics")
  TerrainType  terrainType = 4; // 1=PAVEMENT 2=ROADS 3=RIVERS 4=KRUSTYLAND_ROADS
                                // 5=OCEAN 6=DIRT 7=DIRT_ROADS 8=COBBLESTONE
                                // 9=ICERIVER 10=KLSROAD 11=GOLDROAD 12=SAND
}
```

Grid layers in the sample save:

| LandMessage field (no.) | layer | terrainType | chars |
|---|---|---|---|
| `roadsData` (5) | main roads | ROADS | 34,784 |
| `riversData` (6) | main rivers | RIVERS | 34,784 |
| `oceanData` (34) | ocean rim | OCEAN | 3,072 |
| `roadMapDataMessage` (47) → `roadMapList[0..6]` (1 each) | per-road-kind overlays | DIRT_ROADS, DIRT, COBBLESTONE, ICERIVER, KLSROAD, GOLDROAD, SAND | 34,784 each |
| `subLandData` (36) → `terrainData[]` | subland 2 (64×64 block) | ROADS | 128 |
| `groupStorageBundleMessage` (53) → `groupStorageBundle[]` → `groupStorageBundleRoadMap[]` (2) | per-bundle roadmaps | various | see below |

### Terrain grids: CELL semantics — the corrected decode (2026-10-19, VERIFIED)

**This section supersedes the "1 char = 16 tiles" positional codebook
for every 34,784-char land layer** (roads, rivers, and the
`roadMapList` overlays). It came from cross-checking an external spec
(`road-spec.json`, produced by another LLM from the same `.pb`) and
verifying every falsifiable claim against the binary. The 3,072-char
ocean sea-patch is the exception (see "Ocean frame keeps the legacy
decode" below).

The true semantics, verified:

* A layer string is a grid of **4×4-tile cells** laid out as
  **16-byte blocks, row-major, 37 blocks per row**. Byte `k` of a
  block is cell (row `k//4`, col `k%4`) *within* the block; block
  `(bc, br)` starts at cell (col `4·bc`, row `4·br`). 34,784 chars =
  2,174 blocks = a **148 × 236 cell grid** (last block-row holds 28
  blocks).
* Each non-`'G'` char is **one cell**:
  * `'P'` = solid filled cell (plaza / paved interior, no connectivity);
  * `'a'..'p'` = value `c-'a'` is the cell's **4-bit neighbour mask,
    E=1, W=2, N=4, S=8** — i.e. exactly the connectivity nibble the
    RoadDrawer state machine selects its 11 cell sprites with
    (notes/06 §10).
* Cell (col,row) covers **town tiles**
  `[CELL_OX + 4·col, +4) × [CELL_OY + 4·row, +4)` with
  **CELL_OX/OY = (−48, −112)** — `InnerLandData`
  (`LandMessage` f4) `landBlockPositionX/Y = (−3,−7)` blocks × 16.

Verification performed (all on `mapdump/23034074771109153854742696256123764495.pb`):

1. **Reciprocity is the proof.** If a cell has the E bit set its east
   neighbour must have W (likewise W/E, N/S). Under the cell
   interpretation, reciprocity is **exactly 1.000** for roads
   (2536/2536), rivers (398/398), DIRT_ROADS (186/186), DIRT
   (452/452), KLSROAD (42/42) and SAND (2292/2292) **only at stride
   37**; every other stride tested (12/16/32/33/36/38/40/48) gives
   0.82–0.88. A positional codebook would make perfect reciprocity
   statistically impossible.
2. **Origin pinned by `InnerLandData`**: 64×64 `'0'/'1'` land mask,
   2366 ones in columns 0..39, `landBlockPosition = (−3,−7)`, w/h
   64/64 — and **5259/5261 buildings fall inside `'1'` blocks** using
   block = 16 town tiles from that origin. Building position range
   (−48..608, −111..780) matches the layer origin (−48,−112).
3. **Content makes sense**: roads = 7 geometric components, largest
   1420 cells (the street network + 392 P plazas); rivers = 2 real
   connected networks (150 cells spanning tiles x 80..351, y 0..76 —
   the falls/lake district, 11 cells directly under the
   `SpringfieldLake` art at (264,14,18×14); plus a 20-cell branch at
   x 308..324, y 116..131); DIRT_ROADS = ONE 94-cell footpath (91 of
   94 cells at row ≡1 mod 4 — paths run one cell-row per block-band);
   KLSROAD = one connected 16-cell path; SAND = 3 beach masses (max
   547 cells, NE corner x 412..543). The "1 char = 16 tiles" decode
   could produce none of this.
4. **User ground truth**: the river network contains a dense
   hand-drawn-looking cluster at tiles x 116..128, y 8..36 immediately
   SW of `SpringfieldFalls` (136,12) — matching the RiverDrawing-brush
   water the user remembers laying around OlmecHead, which the old
   decode had smeared into "isolated speckle with y%17 banding".
   Five seed cells: (120,12)`'p'` (116,20)`'o'` (128,24)`'g'`
   (124,36)`'f'` (128,36)`'k'` — now the City View marker seed.

**Ocean frame keeps the legacy decode**: f34's 3072 chars give
reciprocity 0.87 (stride 37) — wave marks do not connect, and the
column-major offshore anchoring (notes/06 §10 water props) still
stands. Brush layers (boardwalk/pier) pre-decoded from that frame in
`gen_map_explorer.py` are likewise unchanged.

Consequences retracted (each section below carries a banner):

* "Filler grids" (sand/dirtroad/klsroad speckle, road frontage stubs):
  all lattice "phases" like x≡3 mod 16 were shadows of the wrong index
  arithmetic; those layers are genuine authored ground. The City View
  `SPECKLE_POLICY` now ships EMPTY (filter toggle kept, inert).
* "riversData is building-adjacent scatter": retracted — scatter was a
  decode artefact; the layer is two real stream networks.
* The "walk census is the only road oracle" framing in notes/06: the
  saved road layer is now trustworthy end-to-end (walk waypoints are
  still real data; the template-lattice observation stands, but the
  road layer no longer needs oracle help).
* Bundle-roadmap dimension ratios (below) are NOT discriminating:
  16 tiles/char holds in BOTH models (a 4×4-cell grid has 16 tiles per
  char too), so they never supported the positional reading uniquely.

Code touched by the corrected decode: `web/js/terrain.js`
(`decodeCells`, `Terrain#cellStateFor` nibble→sheet-state, cell-sized
quads; the nibble now drives the 11-state art selection directly),
`web/js/city-view.js` (marker seed), `tools/cell_find.py`,
`tools/save_diff.py`, `tools/smoke-camera.cjs` (speckle block replaced
by cell-decode truth assertions).

### Grid encoding: 1 char = 16 tiles, 1 bit per tile — **verified**

> ⚠ **SUPERSEDED 2026-10-19 for land layers** — see "Terrain grids:
> CELL semantics" above. Retained because the structural observations
> (dominant `'G'`, char counts, bundle ratios) are real data and the
> ocean frame still uses a per-char frame; the *positional meaning* of
> the char value was wrong (it is a neighbour nibble, not a tile
> offset within a 16-tile run).

`mapData` is one ASCII character per **16 tiles**; each char encodes a
16-bit mask (one bit per tile). **`'G'` = all 16 tiles empty (0)** — it is
the dominant char in every layer (roads 33,137/34,784; rivers 34,614; the
COBBLESTONE / ICERIVER / GOLDROAD overlays are 100% `'G'`).

Proof via the storage-bundle roadmaps, which are the only grids in the save
that carry explicit tile dimensions
(`GroupStorageBundleRoadMap{subLandID=1, mapDataSizeX=2, mapDataSizeY=3,
terrainData=4}`):

| bundle | mapDataSizeX × Y | tiles | `len(mapData)` | tiles ÷ 16 |
|---|---|---|---|---|
| 16 | 16 × 48 | 768 | 48 | 48 ✓ |
| 19 | 32 × 32 | 1,024 | 64 | 64 ✓ |
| 22 | 16 × 32 | 512 | 32 | 32 ✓ |

(43 bundles in this save; only 16/19/22 carry a roadmap — the other 40 are
entry-only, so no further dimension anchors exist here.)

### The char → 16-bit codebook — **verified from `libscorpio.so`**

> ⚠ **REINTERPRETED 2026-10-19** — the decoder is real, but "value k =
> x-offset within the 16-tile run" was the wrong *semantic*: `c-'a'` is
> the cell's E/W/N/S neighbour nibble and `'P'` the solid-plaza flag
> (see "Terrain grids: CELL semantics" above; proven by stride-37
> reciprocity, which a positional reading cannot produce). The record
> layout and the `cmp w8,#0x50`/`sub w?,w?,#0x61` arithmetic are still
> accurate notes on the client's loader; only the coordinate meaning
> inferred for the low nibble was wrong (its bit4/5 "1-unit/2-unit"
> flags line up suspiciously well with nibble-vs-solid, which the
> disassembly should be re-read to confirm when time allows).

The decoder is a single per-char function at **`0x11a6288`** (called from the
roadmap record-object ctor at `0xdb4fbc`, body `0xdb4ebc`). It walks the
`mapData` string one char at a time (`count = mapDataSize`) and, per char `c`,
writes one **8-byte record** (array is calloc'd, so records start zeroed).
Only bytes 4–5 of each record are used, as one little-endian **u16**:

```
u16 @ record+4:
  bits 0..3  value k            (x-offset 0..15 within the 16-tile run)
  bit 4 (0x10)  "1-unit" flag   (a..p)
  bit 5 (0x20)  "2-unit" flag   (P)
  bits 6..15    other flags — set only by the road-construction code, never by the string
```

Per-char behaviour (the whole decoder, `cmp w8,#0x50` / `sub w?,w?,#0x61` /
`cmp w?,#0xf` / `b.hi`):

| char | record written | 16-bit mask | meaning |
|---|---|---|---|
| `a`…`p` (0x61…0x70) | 1-unit flag, `k = c-'a'` | `1 << k` | one tile at x-offset `k` (bit 0 = leftmost) |
| `P` (0x50) | 2-unit flag, value 0 | `0xFFFF` | all 16 tiles (full row segment) |
| `G` (0x47) and any other char | (stays zero) | `0x0000` | no tiles |

So the explicit codebook is:

```
a=0x0001  b=0x0002  c=0x0004  d=0x0008  e=0x0010  f=0x0020  g=0x0040  h=0x0080
i=0x0100  j=0x0200  k=0x0400  l=0x0800  m=0x1000  n=0x2000  o=0x4000  p=0x8000
G=0x0000  P=0xFFFF
```

It is the **identity mapping** the data-side hypothesis assumed — now proven
from the binary, not a static table (there is none; the mapping is computed
inline: `k = c - 0x61`, then `1 << k`).

**Piece geometry.** A record's on-tile size is read by `pieceSize(record,obj)`
(`0x1134e1c`): 1-unit → `[obj+0xbc]` (else 1); 2-unit → `[obj+0xb8]` (else 2).
`obj` is the per-layer roadmap object whose 0x200-byte parameter block is
memcpy'd from a type template in the ctor `0xdb5038`. For the **roads** layer
the sizes are 1-unit = 1, 2-unit = 16, hence `a..p` = one tile and `P` = the
full 16-tile segment. A record's `value k` is the piece's x-offset within the
segment, so a 1-unit piece at `k` is the single tile at x-offset `k`, and the
2-unit piece (value 0, size 16) spans offsets 0..15.

**`terrainType` → internal type** — 12-entry table at `0x3f38c0` (index
`terrainType-1`):

```
type:    1    2    3    4    5    6    7    8    9   10   11   12
maps to: 0    0    1   11    2    4    3    5    6    7    8    9
```
(default when the field is absent = 11, i.e. the same as `terrainType 4`).

**Confirmation (independent of the binary):**
- `roadsData` rows 262 and 281 are 32 × `'P'` — solid **full-width horizontal
  avenues**; a solid horizontal road is exactly one `'P'` per group. The P
  count-per-row histogram peaks at multiples consistent with full avenues.
- Decoding with the identity codebook + offset `town = grid − (12,136)` puts
  **576/5,261 buildings adjacent to a road tile** (sharp in Y at −136, broad in
  X at ≈−12); the left-to-right bit order wins over right-to-left (576 vs 197),
  and P = all-16 wins over P = 2-tile (576 vs 210).
- Single-tile roads (`a..p`) sit closer to buildings than random tiles do
  (p50 distance 5.1 vs 11.4; 49% vs 31% within 5 tiles) — i.e. they are the
  1-tile-wide roads / driveway stubs that flank building footprints. This also
  resolves the earlier `d` vs `m` puzzle: **`m` is exactly bit 12, one tile —
  no hidden multi-bit pattern**; its scattered look is just where the
  single-tile road pieces fall, whereas `d` (x-offset 3) happens to stack into
  vertical 1-tile-wide road runs.

### Main-grid geometry: 512 × 1087 tiles, char = 16×1 run (verified)

> ⚠ **SUPERSEDED 2026-10-19** — "512 × 1087" describes the string, not
> the world: the land grids are 148 × 236 cells of 4×4 town tiles
> (origin −48,−112), i.e. 592 × 944 tiles (see "Terrain grids: CELL
> semantics" above). The "4×4-block-per-char layout ruled out because
> 1087 is odd" argument had a false premise — block rows need not tile
> 2,174 blocks evenly: the verified layout is 58 full block-rows of 37
> + one partial row of 28 (a normal truncated last row, exactly like a
> truncated image row), so the odd factor never constrained anything.

The top-level layers carry **no** width/height field — only the 34,784-char
payload. 34,784 = 32 × 1087 and **1087 is prime**, which pins the geometry:

- The char grid must be 32 × 1087 (or a coarser split), so with one char =
  16 tiles the tile grid is **512 wide × 1087 rows** (the only candidate
  wide enough to be sensible).
- A 4×4-block-per-char layout is **ruled out**: it would require 1087 (or
  2174/4348) char rows to be ÷4-integer, and 1087 is odd.
- Consistency: at width 512 the non-`'G'` rows of `roadsData` span
  rows 39..799, which brackets the building `positionY` range
  (−111 … 780, in 0.5-step floats) — roads exist exactly where buildings
  are. (Building `positionX` spans −48 … 608, wider than 512, so the grid
  is a region of the town, not its full extent — consistent with the grid
  origin being offset; `landBlockPosition` here is (−3, −7).)
- `innerLandData.landBlocks` is a separate, coarser structure: one
  `'0'`/`'1'` char per land block, `landBlockWidth×Height = 64×64` blocks
  (2,366 unlocked in this save). 64 blocks × 8 tiles = 512 — the classic
  512×512 base map, with the terrain grid extended beyond it in Y.
- **Verified overlay offset:** decoding `roadsData` with the codebook above
   and placing it over the town at `town_x = grid_x − 12`, `town_y = grid_y −
   136` (i.e. a building at town `(bx,by)` overlays grid cell `(bx+12, by+136)`)
   maximises building↔road adjacency (576/5,261; sharp in Y, broad in X). This
   is the offset the renderers use. (It is a best-fit overlay, not a proven
   exact origin — see open item below.)

Char histograms, top of each layer (full list: `tools/terrain_dump.py`):

- roads (34,784): `G×33137 m×832 P×392 d×350 l×14 n×8 e×8 o×7 h×7 i×5 p×5 g×4 c×4 f×4 b×3 j×2 k×2`
- rivers (34,784): `G×34614 d×31 j×20 g×19 k×15 f×15 h×14 m×13 l×11 o×10 p×9 n×9 i×2 c×1 b×1`
- ocean (3,072): `G×2810 P×88 p×52 d×28 n×26 o×26 m×13 a×7 j×4 f×4 k×3 c×3 g×3 l×2 h×2 b×1`

### C++ side (what the client calls this)

- The grid class is **`RoadsUtil::RoadmapBoolRect`** (RTTI name @ 0x3ff414),
  implementing **`RoadsUtil::IBoolRect`** (0x3ff432). Consumers found in the
  binary: `RoadMap`, `RoadMapTileMapAdaptor`, `RoadMapArrayAdaptor`,
  `RoadMapDrawer`, `UpdateRoadMapAction` / `HideRoadMapsAction`, and the
  `AllRoadmapGridTester` / `SpecficRoadmapGridTester` pair (upstream typo)
  over `IGridTester`.
- **Vtables are real, not abstract** — an earlier "vtable is all zeros ⇒
  abstract" reading was wrong because the raw file bytes were read without
  applying the `.rela.dyn` RELATIVE relocs (reloc `info&0xFF==3`, addend =
  absolute value). Located via a reloc-addend == typeinfo-vaddr scan
  (`/tmp/opencode/find_vtables.py`): RBR vptr = **0x1a38010** (vtable
  typeinfo-slot 0x1a38008, typeinfo 0x1a38040); `RoadMap` typeinfo 0x1a38058
  (vtable ti-slot 0x1a37fb8, 8 vfuncs 0x118c0e8…0x118d814); `IBoolRect`
  abstract vtable ti-slot 0x1a38050.
- **`IBoolRect` vfuncs** (the `RoadmapBoolRect` impl): `at(x,y)→bool`
  `0x1192d84`, `width*4` `0x1192e54`, `height*4` `0x1192e68`,
  `getSize(&w,&h)` `0x1192e7c`. The RBR ctor is `0x11939ec` (the only
  ADRP+ADD ref to the vptr); its `init` `0x119300c` flood-fills connected
  components (`0x1192ea0`) into 96-byte records. `fromString`/`toString` are
  **non-virtual** members.
- The function-registry entries literally named `RoadMap::Grid::fromString`
  / `RoadMap::Grid::toString` (crash-name registration at ≈0xe8cdb8; name
  literals 0x389cd6 / 0x392f54; fn-table slots 0x1abfe68 / 0x1abfe70) resolve
  to `0xe54ddc` / `0xe54e3c` — **float conversion helpers (`scvtf`/`fcvtzs`),
  NOT the grid decoder** (a useful negative). The real char→record decoder is
  **`0x11a6288`** (see the codebook section); the record array it fills is the
  compact string-form roadmap, which the higher-level query objects expand for
  per-tile `at()` lookups.

### Resolved this pass

- **The char → 16-bit-mask codebook** — done (see above): `a..p → 1<<(c-'a')`
  at x-offset `c-'a'`, `G → 0`, `P → 0xFFFF`; decoder at `0x11a6288`,
  row-major 16×1, left-to-right. Not a static table; computed inline
  (`k = c - 0x61`, `1 << k`).
- **Grid origin / row-major ordering** — row-major 16×1 confirmed by geometry
  (1087 prime ⇒ only a 16-wide row run divides 512×1087); bit order L2R and the
  best-fit overlay offset `town = grid − (12,136)` confirmed by building↔road
  adjacency.

### Open items — next RE steps (not done in this pass)

1. **Per-layer piece sizes.** Only the **roads** layer's sizes are pinned
   (1-unit = 1, 2-unit = 16, from the data). The sizes live at `[obj+0xbc]` /
   `[obj+0xb8]`, memcpy'd from a per-type template block (`0x200` bytes at
   `[template+0x5a0]+8` in ctor `0xdb5038`). Read the template globals to pin
   rivers/ocean/etc. (in this save only roads uses `P`, so it doesn't affect
   rendering this town).
2. **Ocean / other-layer grid width.** The top-level layers store no
   width/height; `oceanData` is 3,072 chars = 49,152 tiles (512×96 assumed
   from the rim shape, but 256×192 / 192×256 also divide it). The only grids
   with explicit `mapDataSizeX/Y` are the storage-bundle roadmaps.
3. **Exact grid origin** (the overlay offset is a best fit, not proven exact).
4. `landBlocks` block size (assumed 8×8 tiles) and how
   `boardwalkTiles` / storage-bundle origins tie to grid coordinates.

### Filler grids — procedurally-generated speckle inside the terrain layers (2026-10-19)

> ⚠ **RETRACTED 2026-10-19 (same day)** — every "lattice phase" cited
> below (x≡15 mod 16, x≡3 mod 16, y%17 bands …) was an artefact of the
> WRONG per-tile index arithmetic. Under the verified cell decode
> ("Terrain grids: CELL semantics" above) sand/dirtroad/klsroad have
> nibble reciprocity 1.000 at stride 37 and form genuine connected
> shapes (DIRT_ROADS = one 94-cell footpath, KLSROAD = one 16-cell
> path, SAND = 3 beach masses). Nothing here is generator filler;
> `SPECKLE_POLICY` in `web/js/terrain.js` ships EMPTY. Kept as a
> cautionary record of a self-consistent but wrong analysis.

**The saved terrain strings contain engine-generated filler that the real
client never paints.** Symptom that uncovered it: three "sand" diamonds
immediately south of the GiantRobot in City View, absent from the real
client and every static render. They are genuine save bytes —
`roadMapDataMessage.roadMapList[6]` (terrainType 12 = SAND) rows 70–72,
chars `'f'`/`'h'`/`'h'` at grid (37,70) (39,71) (39,72) — but the whole
SAND grid is procedural noise:

- All 632 sand tiles sit on a rigid **speckle lattice**: dominant phase
  x≡15 (mod 16) (`'p'`, 437 tiles), diagonal 3–4-row streaks repeating
  every ~19 rows, spread across the entire map (town x −5…499), including
  112 tiles *under* other buildings' footprints. Translation test
  (x+16,y): 381/558 match. No player places identical speckle map-wide.
- Same test on **`roadsData` (f5)**: 1,182 of 1,255 single-tile entries
  sit at two fixed phases — x≡3 (mod 16) `'d'` (350 tiles: the *same*
  vertical dash runs 76–79, 168–171, 189–195, 222–225, 298–300, 340–344
  repeated in every 16th column, 71% adjacent-column overlap, almost
  never adjacent to a `'P'` road: 7/350) and x≡12 (mod 16) `'m'` (832
  tiles: every 16th column filled, hashed per-column rows). The 6,272
  `'P'` full-segment tiles ARE the authored avenues. Earlier "driveway
  stubs" reading (adjacency p50 5.1 vs 11.4) still holds — buildings sit
  on the same 16-grid — but the cross-map duplication proves they are
  auto-generated frontage markers, not per-item roads.
- **DIRT_ROADS (roadMapList[0])**: 88/94 singles at x≡3 (mod 16) in 8
  columns that come in two identical groups 256 columns apart
  (x 67–115 / 323–371, rows 61–72) — the park footpaths, generated and
  duplicated between park layouts.
- **KLSROAD (roadMapList[4])**: 16 isolated connector singles (rows
  259/277), no segments.
- **~~Organic (genuine)~~ CORRECTED 2026-10-19**: `riversData` and DIRT
  (roadMapList[1]) were first called "real placed terrain" because they
  use all 16 phases with no translation invariance. That test only
  excludes *periodic* filler. Deeper census (player ground truth, see
  "riversData is building-adjacent scatter" below) shows both are
  **procedural scatter, not strokes**: 162/170 river cells and nearly
  all dirt cells are isolated single tiles (only 4 two-cell components,
  zero polylines), ~61–67% sit within 2 tiles of a building (~25×
  random — placement-triggered decoration), they arrive in ~17-row
  bands (river rows 133–134, 138–141, 152–158, 171–174, 190–192,
  208–211, 270, 288–289), and river/dirt/road cells are **mutually
  exclusive** (0 overlap) — a one-cell-one-fill assignment process,
  not independent brush strokes.

**Renderer policy** (`Terrain.SPECKLE_POLICY`, `web/js/terrain.js`):
`sand`/`dirtroad`/`klsroad` → `'drop'` (whole grid is filler); `road` →
`'anchor'` (keep a tile only when its 8-connected component contains a
`'P'`-derived tile — real ground grows out of full segments, the speckle
components are isolated thin runs); everything else unfiltered. Ships ON;
City View has a **speckle filter** legend row (persisted,
`mrsnrub.cityview.speckle`) for before/after A/B. Effects on this save:
sand 632→0, dirtroad 94→0, klsroad 16→0, road 7,527→6,326 (−1,201, the
lattice dashes + unanchored singles), river/dirt/ocean unchanged.
`_roadOccAll` keeps the unfiltered saved roads for the `debugFrags`
overlay (it exists to inspect the very fragments the filter hides).

### There is no stroke store — brush terrain persists ONLY as per-layer rasters (2026-10-19)

Question: the walk-path census leaks the road grid; is there an analogous
saved element capturing the **path strokes** of the other brush-laid
terrain types (rivers, dirt, dirtroad, klsroad, sand)? Answer from three
independent lines of evidence: **no — nowhere in the save or client.**
(Refined same day, see "riversData is building-adjacent scatter": player
strokes DO persist, but only as delta cells inside the same raster
strings that also hold generator scatter — so raw raster ≠ truth, and
each layer needs its scatter separated before it can be trusted.)

1. **Schema**: the full client proto pool (`re/proto_schema.txt`, cross-
   checked against a raw `protodesc_cold` token scan in
   `/tmp/opencode/ghidra_out/pdc_dbg.txt`) contains exactly one polyline
   type — `VectorFloatArray` (repeated `VectorFloat{x,y}`) — used by
   exactly one field: `characterData.pathCache`. No message/field named
   stroke/brush/spline/polyline/curve/point-list exists anywhere. Brush
   terrain persists only as raster `TerrainData{header,mapDataSize,
   mapData,terrainType}`: f5 roads, f6 rivers, f34 ocean,
   `roadMapDataMessage.roadMapList[0..6]`, plus tiny `subLandData` (f36)
   and `GroupStorageBundleRoadMap` (f53) patches.
2. **Client runtime** (notes/06 phases 21–28): brushes draw transiently —
   one shared provider (`town+0x5a0`) feeds every layer through the same
   `FUN_0128bc54` merge; the client journals no stroke list either.
   What "captures all terrain types laid down as strokes" is split across
   (a) the provider+rasters at runtime and (b) the landinfo `RoadEntry`
   records (drawer hash, PathBrush BST, behavior ∈ {road,river,ocean})
   as the *definition* of which types are stroke-laid and how.
3. **Empirical census** (`tools/layer_oracle.py`): every coordinate-
   bearing structure in the save overlapped against every decoded layer
   with random-placement baselines. Only `road` shows lift
   (walk waypoints 3.8×, idle positions 3.9×); river/dirt/dirtroad/
   klsroad/sand/ocean are all at noise (0–1.8×). `JobData.gridPosition`
   (`hasGrid`) is never populated in this save (0/519). The extra grids
   are micro-patches, not strokes: bundle16 ROADS 18 cells at origin
   (32,208), bundle19 DIRT 3, bundle22 SAND 1, subland2 ROADS ~20.

Practical reading: the **visible** terrain networks (road lattice, park
footpaths, big rivers) are client-generated template/decoration content
the save never stores as such — the saved rasters are mostly *server-side
bookkeeping*: player deltas (roads `P`-runs, the 3 river tiles at
SpringfieldFalls) plus **procedural scatter** (building-adjacent single-
tile speckle, see below). The walk census was only ever needed for
`road`, the single layer whose rendered template lattice has no saved
trace at all.

### riversData is building-adjacent scatter + a handful of real tiles (2026-10-19)

> ⚠ **RETRACTED 2026-10-19 (same day)** — the scatter/banding picture
> was produced by the wrong per-tile decode. The layer is actually TWO
> real connected stream networks (150 + 20 cells, reciprocity 1.000,
> nibbles included) — see verification item 3/4 in "Terrain grids:
> CELL semantics". The 5 "genuine" tiles this section conceded are
> superseded by the 5 seed cells there.

Player ground truth settled this: the tiles laid by the RiverDrawing
brush around/below OlmecHead are real, yet City View's river layer
showed water all over town where the game shows grass. Census:

* 162/170 saved river cells are **isolated single tiles** (8-connected;
  only 4 two-cell components; zero polylines) — impossible for brush
  strokes, which paint connected runs.
* 61% lie within 2 tiles of a building footprint (~25× random) —
  the same placement-triggered auto-decoration that scatters DIRT
  (67%), SAND, DIRT_ROADS, KLSROAD. River/dirt/road cells are pairwise
  disjoint (0 overlap): a one-cell-one-fill assignment, not strokes.
* Rows arrive in bands (~17-row rhythm): 133–134, 138–141, 152–158,
  171–174, 190–192, 208–211, 270, 288–289.
* The genuine content is a handful of tiles hugging water decorations:
  in the Falls/OlmecHead window only `(130,20) (144,17) (128,36)`
  (town coords; the first two flank the SpringfieldFalls footprint,
  the third sits below-left — matching the player's own placements);
  a tight cluster of 7–9 sits within 4 tiles of SpringfieldLake and 1
  at ForestStream. ~149 of the 170 are scatter noise.
* `roadMapList[2]` COBBLESTONE, `[3]` ICERIVER, `[5]` GOLDROAD are
  completely empty — there is no hidden alternate river layer.

Implication for City View: `river` needs a speckle policy too. Isolated
singles cannot be separated from genuine brush singles by shape alone;
the reliable signal is **proximity to a water decoration** (Falls/Lake/
Stream/pond footprints, known from buildingData). Proposed: `'anchor'`-
style keep = cell within ~8 tiles of a water decoration OR in a
≥2-cell component. Dirt deserves the same treatment once ground truth
for a placed dirt brush is available.

**Decisive experiment pending** (needs a fresh save capture): place a
distinctive test run of brush tiles in an empty field, re-capture the
`.pb`, and run `tools/save_diff.py OLD.pb NEW.pb` — it reports every
changed cell per terrain grid (f5/f6/f34, each `roadMapList` slot,
subland grids, bundle grids), added/removed `buildingData` entries by
id+name+position, and top-level section-count changes. New cells name
the brush-stroke persistence field for each terrain type directly,
with no oracle needed. (Self-diff of the current save is clean;
verified 2026-10-19.) `tools/cell_find.py` complements it for
"another viewer shows terrain HERE" disputes: it brute-forces every
codebook string in the raw file (4 layout hypotheses) and either names
the encoding field or proves the cells aren't in the file — run on the
five Falls-window tiles it locates them uniquely in the f6 string
(off 40606). Recursive unknown-field scan: empty; whole-file scan finds
exactly 10 codebook strings (the known layers). DIRT_ROADS is a
generator comb (11-cell vertical runs at x=55/71/87/103/311/327/343/
359, rows −74…−64), KLSROAD two lattice rows (123/141), f6 rivers 170
isolated singles with y mod 17 banding (6 residues empty) — generator
fingerprints throughout.

#### Brush → save-layer map (`landinfo.xml` SaveInfo, 2026-10-19)

The RiverDrawing item's config settles where brush strokes persist —
each drawable `RoadEntry` carries an explicit `<SaveInfo map=...
savedType=...>`:

| brush (consumableName) | SaveInfo map | save location |
|---|---|---|
| RoadDrawing | road | f5 roadsData |
| RiverDrawing (**icon `ICO_DECR_WATERTILE_SM`** = decor water tile) | river | f6 riversData |
| (ocean rim) | ocean (road + pavement variants) | f34 oceanData |
| DirtRoadDrawing | dirt | roadMapList[1] DIRT(6) |
| DirtRiverDrawing | dirtriver | roadMapList[0] DIRT_ROADS(7) |
| CobblestoneDrawing | cobblestone | roadMapList[2] COBBLESTONE(8) |
| IceRiverDrawing | iceriver | roadMapList[3] ICERIVER(9) |
| KrustylandSpringfieldPath | klsroad | roadMapList[4] KLSROAD(10) |
| GoldRoadDrawing | goldroad | roadMapList[5] GOLDROAD(11) |
| SandDrawing | sand | roadMapList[6] SAND(12) |

* Every entry is `savedType="road"` + `markRoadsLeaving="true"` — the
  same 16-tiles-per-char codebook raster as roadsData. Pavement/
  boardwalk/pier brushes have no SaveInfo (not persisted as their own
  layer).
* The 10 SaveInfo maps are exactly the 10 per-layer maps merged by the
  provider rebuild loop (`10× FUN_0128bc54(FUN_0115ef00(i), provider)`,
  notes/06 phase 21+): the RE and the schema agree — player brush
  strokes can ONLY persist as these rasters, so a player's
  RiverDrawing tiles must live in f6, and the ~165 non-stroke cells
  there are server-side scatter (or the capture predates the player's
  later placements — this `.pb` is a point-in-time uploaded snapshot).
* Player placements are also NOT hidden in `buildingData`: a full-name
  scan for water-ish decoration names (river/pond/stream/creek/lake/
  falls/pool/canal) finds 31 placed props town-wide (all big quest/lake
  buildings), zero in the OlmecHead/Falls window; the catalog's canal
  tile props (`GrandCanal1..5`, ids 197509–197527) are never placed.

### Walk paths — `characterData.pathCache` (2026-10-19)

The save's only genuine **path** storage: `CharacterData.pathCache` is a
nested `VectorFloatArray` of integer town-coord (x, y) walk waypoints
(853/871 characters populated; fields `header, character, updateTime,
positionX, positionY, skin, skinBackup, subLandID, flags, pathCache`).
Runtime-cached, but it doubles as an oracle for the road network the
server save never stores (characters only walk on streets; ~90% of
cached segments sit off `roadsData`, strictly axis-aligned, on the
template lattice grid x ≡ 3 (mod 4) / y ≡ 0 (mod 4)). Decoded, exported
(`MAP_DATA.walks`) and rendered by City View — full findings and the
PathBrush/SpringfieldFalls context in `notes/06` "Walk-path oracle".

### `gameObjectInfo` (field 35) — the per-template asset ledger (decoded 2026-10-19)

62,896 B (0x16e909–0x17deb9), the 8th-largest section of the sample save and
previously schema-only. `GameObjectInfo{header(EntityHeader id=36856),
repeated GameObject{dataId, gameObjectType, unlockTime, locked, viewed}}` —
**4,260 entries** (3,701 distinct dataIds; the same dataId recurs across
types, so the key is the (type, dataId) pair). `gameObjectType` is the
**asset category**, and every entry is a per-*template* state record —
cross-checked against the local gamescripts configs (`/tmp/opencode/gsdata/`)
and `data/*_ids.json` catalogs:

| type | n | identity | catalog match |
|---|---|---|---|
| 1 | 3,146 | **Building** ledger | 100% ⊆ `data/building_ids.json` (3,440 known) |
| 2 | 529 | **Character** ledger | 100% ⊆ `data/character_ids.json` |
| 6 | 528 | **Consumable** ledger | 100% ⊆ `*consumables*.xml` DataIDs |
| 15 | 57 | **GameObjectBundle** ledger | 57/57 ∈ bundle `MasterList` DataIDs (`*_gameobjectbundles.xml`) |

Semantics observed in this save:

- **Ledger, not placement**: type 1 covers 3,146 building templates but only
  2,299 are currently placed — **862 ledger entries survive demolition**
  (15 placed buildings have no ledger row: bundle-placed/never "discovered"
  — open oddity). So the field is the player's *discovered/unlocked* history
  per template, not the map contents.
- `viewed=1` on 3,000 entries (all 57 bundles, 2,295 buildings, 220
  characters, 428 consumables) = seen-in-UI flag.
- `locked=1` on exactly 6 entries, all type-6 consumables: `TalkingKrustyDoll`,
  `Decorated_FestiveMansionOfSolidGold`, `CoconutBabaloo`, `GoldRoadDrawing`,
  `PreachLoveAndPeace`, `NewLardLad_Statue_Con` — preview/unreleased items.
- `unlockTime` present on 3,944 entries, spanning **2013-06-13 .. 2025-01-24**
  (ms epoch) — matches the account's lifetime; it is when the template was
  first unlocked/placed.
- Type-15 ids resolve to named bundles via `<MasterList><DataID id= name=>`
  (e.g. 283500 = `MemorialChurchBundle`, 15-donut bundle from
  `abartfuture_gameobjectbundles.xml`); the client-side registry strings
  `GameObjectBundlesMasterList.xml` / `gameObjectBundle` in
  `libscorpio.so` (`re/str_xrefs.tsv`) are the same config.
- **Terrain cross-check (keyword scan, 2026-10-19):** neither this field
  nor `objectVariables` (below) holds any road/river grid data — but the
  type-6 ledger tracks the *tools that draw* them: `GoldRoadDrawing`
  (179000, **locked** here — and the f47 GOLDROAD overlay is 100% empty),
  `SandDrawing` (281002) + `SandTileUnlock` (281001, unlocked — and the
  SAND overlay carries 632 painted tiles). Locked-brush ⇔ empty-layer and
  unlocked-brush ⇔ painted-layer both hold. Remaining keyword hits are
  decorative names (`CobblestoneWall`, `SandsOfSpace*`, …), not terrain.

Status in the Byte Map (`tools/gen_pb_layout.py` STATUS_TOP/SUB): f35 is now
**decoded**. Remaining top-level byte-share frontier: questData (128 KB),
notificationData (113 KB), jobData (16 KB), innerLandData (4 KB, 32 fields).

### `objectVariables` (field 43) — per-object script key/value store (decoded 2026-10-19)

88,256 B (the 5th-largest section), previously schema-only. It is a single
`ObjectVariables{variables}` → `.Data.AdvancedVariableSet` — a classic
**key/value variable store**: 2,205 `AdvancedVariable{name, value,
createdTime, ttl, objectClass, serverID, objectTypeID, orphaned,
canBeOrphaned, scope, sublandID, flags, uuid}` rows, 247 distinct names,
values are string-encoded ints/enums (`'0'`, `'1'`, `'Forward'`…).

How the rows bind to the world:

- **`serverID` = the hosting object's `EntityHeader.id`** — 510 of the 783
  distinct serverIDs hit the current `buildingData` header ids; the other
  ~270 (e.g. the contiguous 1,828,6xxxxxx block) are **demolished/removed
  objects whose rows linger**, which is what the `orphaned` flag is for
  (241 rows set; `canBeOrphaned` on 1,521). One row has `serverID=0` = a
  land-level variable (`EspionageModeJustFlipped`).
- **`objectTypeID` = the host's building template id** — 232 of 234 distinct
  values ∈ `data/building_ids.json` (the odd ones are the `-1` sentinel).
- **`objectClass`** unset (1,662 rows) = building-scoped script vars; class
  **3** (539 rows, `objectTypeID=sublandID=4294967295`) is a different host
  class whose vars are numerically named (`0`–`3` × 38 each) plus battle
  state (`health` × 28, `battle_type` × 27) — the minigame/battle state
  store. `ttl` and `scope` are never set in this save.
- `createdTime` present on all rows, spanning **2019-04-14 .. 2025-01-23**.

What the names are: gameplay-script state variables — they resolve into the
gamescripts configs (local copy `/tmp/opencode/gsdata/`): top families are
`SHLevel` × 151 (Uptown Springfield Heights — `seasonpremiere2016_*`
decoration/upgrade configs), `DonutVeinMined` × 146 (donut-mine diggable
decorations), `Maggie/MaggieIn/MaggieOut/Baby` × ~126 each (pushchair
animation-state vars), `State`/`ActiveIn`/`ActiveOut`/`Forward`/`Reverse`/
`AnimationDirection` (decoration animation state), `UpgradeRushCost` × 50,
`dummy` × 49 (always `'1'` — placeholder), plus battle vars above. The
139 orphaned `SHLevel` rows are the demolished Springfield Heights plots —
the same demolition-survival story as the `gameObjectInfo` ledger above.

Byte Map: f43 is now **decoded** (`tools/gen_pb_layout.py` STATUS tables).
Remaining schema-only frontier: questData (128 KB), notificationData
(113 KB), jobData (16 KB), inventoryItemData (2.4 KB) and friends.

### Terrain dragnet over every remaining schema-only segment (2026-10-19)

All 27 remaining schema-only top-level fields (~1.15 MB) were digested
recursively and keyword-scanned (`road|river|dirt|sand|kls|krusty|gold|
cobble|boardwalk|pier|pavement|ocean|terrain|brush|drawing|tile|street|
grid|map`), followed by a **whole-file raster census**: walk every nested
message and collect every ≥128-byte string whose chars are all codebook
(`a..p`, `G`, `P`). Outcome: **no terrain data hides anywhere outside the
grids the Byte Map already models.**

- **Raster census — the file holds exactly 10 codebook grids:** `f5.f3`
  (main roads, 1,647 filled chars), `f6.f3` (rivers, 170), `f34.f3`
  (ocean, 3,072 B / 262) and 7× `f47.f1.f3` overlays (94, 170, 0, 0, 16,
  0, 632). Nothing else at any depth in the 1.83 MB. 100% of terrain
  bytes are on the Byte Map.
  **(Corrected 2026-10-19: the census threshold (>=128 B strings)
  missed 4 small grids — 3 stashed-bundle patches in f53 and the
  subland grid in f36; see "Stashed bundles carry their own terrain".
  True total: 14 codebook grids.)**
- **f16 `eventCountListData` (825 KB — the single biggest unexplored
  segment, larger than questData)** is a pure analytics ledger: 17 groups,
  one event **type** per group, 49,309 Event rows `{count, type, jobID,
  charID, buildID, consumeID, buildingID, friendLand, arg1}`; `numElements`
  always equals the real row count. Fields are **union-typed** — the type
  selects how every id field is read (see the ledger anatomy section
  below). Zero strings, zero geometry → Byte Map status stays **partial**
  (five plain-counter types have no verifiable meaning).
  Terrain-adjacent: the type-41 rows include **BoardwalkDrawing ×19** and
  **PierDrawing ×4** — the only in-save trace of those two brushes (see
  SaveInfo below).
- **`landBlocks` decoded** (`f4.f2 InnerLandData.landBlocks`): 4,096 chars
  of `0`/`1` = a 64×64 township occupancy mask (2,366 ones; row profile
  43 full rows of 40 then a tapering coastline), pairing with
  landBlockWidth=64 / Height=64 / Position=(-3,-7) in the same message.
  The f36 subland carries its own mask with just **10** bits set (an
  earlier Byte Map note mis-attributed the 2,366 figure to the subland —
  corrected).
- Only other keyword hits: f19 `characterSetsData` set names
  (`BoardwalkPerformers`, `TheMayflowerMapleBowl`, …) — theming labels.

### eventCountListData anatomy — union-typed analytics counters (2026-10-19)

Full per-type profile of the 49,309 Event rows. The key discovery:
`Event` has **union semantics** — `type` (f2) selects how every other id
field must be read, so the schema field names (`jobID`, `buildingID`, …)
are only accurate for one group each. All ids resolve against the shared
**DataID** namespace; `-1` is the "not applicable" sentinel. Per type:

| type | rows | fields present (beyond count/type) | reading |
|---|---|---|---|
| 16 | 35 | buildingID→**character** DataID (Bart, Homer, Lisa, Cletus, Kearney, TomOFlanagan, FryingDutchman…), friendLand 0/1 | per-character counter, both own- and friend-land |
| 17 | 28 | same, friendLand **always 0** | same counter, own-land only |
| 18 | 1,479 | jobID (1,053 distinct; Shrub00, PhoneBooth, Manhole, BartsTreehouse, AtW visitor tasks…), buildingID (Kearney, Duffman, Quimby, Moonbounce…), friendLand 445/1,479 | job completions keyed by (job, building) — the big collection/tax log; count up to **91,272** |
| 19 | 104 | same shape; jobIDs 10002–10066 old-style + 139501 `OrnatePier2` | bonus/secondary job tallies |
| 20 | 2 | same shape | same, barely used |
| 35 | 23,638 | jobID (BuyMilk, ShopForGifts, FleeTheScaryHornedMan — spacing/need tasks), charID, buildID (both may be −1) | per-character task tallies |
| 39 | 23,575 | identical key space | **complete subset mirror of 35**: 39⊂35, 63 in-progress rows only in 35 → 35 = assigned/attempted, 39 = completed |
| 41 | 413 | consumeID only | **consumable-inventory log** — one row per item, counts up to 1,485 (BurnsMonster), RailYard prizes ~800 each; the only terrain-brush rows anywhere: Boardwalk ×19, Pier ×4 |
| 69 / 76 | 2 / 2 | — | plain counters, {73,6} / {68,6} — pair, meaning unknown |
| 71 | 2 | characterID=17 ×2, friendLand 0 and 1 | single-character event ×2 venues |
| 78 | 1 | arg1=1, count=2,247 | plain counter with literal arg |
| 96 / 98 / 172 | 1 / 1 / 3 | — | lifetime aggregate counters (364 / 9,794 / {116,34,21}) |
| 161 | 17 | characterID **1..64**, buildingID=−1, friendLand **always 1** | friend-land character visits, one row per citizen template |
| 175 | 6 | arg1 ∈ {1, 321, 216000, 135000, 173000, 159000} → `SpringfieldMysterySpot`, `ROSAPart`, `SecretAgents_Event`, `MultiVac`, `DeployTheBeacon` | special-event participation; cross-refs f27 `specialEventsData` |

Terrain-dragnet re-run over **every id field of every type**: all
road/river/sand/dirt keyword hits are game-content names, not terrain
state — job names like `PavingRoadsWithGoodIntentions`,
`WettingDirtForMudBaths`, `HoloBoardwalkTree`; guide-panel quest jobs
`GoldRoadDrawing` (179000) and `SandTileUnlock`/`SandDrawing` (281001/2)
as jobID/charID/buildID in types 35/39; `OrnatePier2` (139501) jobs in
18/19 (`PierDrawing`'s `linkedBuilding`). **No event type carries
positions, tile counts, or raster references** — f16 can never account
for brush-laid road/river tiles, and per the type-41 semantics it also
*cannot* record their use (permanent-unlock brushes consume no
inventory). Conclusion unchanged: the rasters (Byte Map) are the only
terrain record in the save.

### landinfo `SaveInfo` = the authoritative brush → storage-grid map (2026-10-19)

`landinfo.xml` gives every brush RoadEntry a `<SaveInfo map= savedType=/>`
naming the physical raster it writes:

| brush (DataID) | landinfo layer | stored in | savedType |
|---|---|---|---|
| RoadDrawing (2) | road | main roads grid (f5) | road |
| PavementDrawing (3) | pavement | **main roads grid (f5)** | pavement |
| RiverDrawing (4) | river | main rivers grid (f6) | road |
| BoardwalkDrawing (5000) | boardwalk | **ocean grid (f34)** | road |
| PierDrawing (139000) | pier | **ocean grid (f34)** | pavement |
| DirtRoadDrawing (145014) | dirt | DIRT_ROADS (7) | road |
| DirtRiverDrawing (145015) | dirtriver | DIRT (6) | road |
| CobblestoneDrawing (163100) | cobblestone | COBBLESTONE (8) | road |
| IceRiverDrawing (188026) | iceriver | ICERIVER (9) | road |
| KrustylandSpringfieldPath (4266) | klsroad | KLSROAD (10) | road |
| GoldRoadDrawing (179000) | goldroad | GOLDROAD (11) | road |
| SandDrawing (281002) | sand | SAND (12) | road |

Consequences:

- **Boardwalk and pier never appear in roadMapList because they are
  stored in the OCEAN grid** (`map=ocean`, savedType road/pavement) — the
  f34 fill includes those 19+4 brush tiles. This closes the loop with the
  f16 counters above.
- **PAVEMENT (terrainType 1) has no overlay for the same reason** — see
  the pavement investigation below.
- The TerrainType enum names **DIRT(6)/DIRT_ROADS(7) are swapped vs the
  landinfo layer names**: DIRT(6) is landinfo `dirtriver` (drawer=river;
  its 170 filled chars mirror the river grid), DIRT_ROADS(7) is landinfo
  `dirt` (drawer=road).
- `KrustylandSpringfieldPath` (DataID 4266, unlocked) is in the f35
  type-6 ledger — every terrainType except KRUSTYLAND_ROADS(4) (a
  pre-placed park layer, no brush) now has a named controlling brush;
  Byte Map annotates all of them.

Byte Map after this sweep: f4 and f16 → **partial** with notes, ocean and
KLSROAD brush annotations added; meters now decoded 27.5% / partial 55.6%
/ schema-only 16.9%.

### The pavement storage question — as far as the evidence goes (2026-10-19)

Question: `SaveInfo map="road" savedType="pavement"` puts pavement inside
the main road grid, but how do the two logical layers coexist in one
char raster? What is provable, and what is not:

- **The mapData string is position-only.** The verified decoder
  (`0x11a6288`) writes, per char, just the x-offset (`a..p`) or full-run
  (`P`) plus the 1-unit/2-unit flags; record bits 6..15 are "set only by
  the road-construction code, never by the string". So the string itself
  **cannot** encode a pavement-vs-road type. `roadsData.mapData` is not a
  second layer either — f5/f6/f34 are plain single-`mapData` TerrainData
  messages (f1 header, f2 size, f3 string, f4 terrainType), and the
  raster census confirms exactly one string each.
- **No separate save slot exists anywhere**: the proto has no
  pavement/boardwalk/pier field, no TerrainType enum value for boardwalk/
  pier, and this save's `roadMapList` carries no tt=1. If pavement tiles
  are saved, they are merged into the road string (and boardwalk/pier
  into the ocean string), losing the distinction at save time — the
  client must re-derive it at load (plausibly from the runtime flags the
  road-construction code sets on records; the config parser that reads
  `savedType` lives in `fcn.00df9c90`).
- **This save cannot settle it empirically**: the f16 type-41 counters
  show the only terrain brushes ever consumed here were BoardwalkDrawing
  (×19) and PierDrawing (×4) — PavementDrawing was **never used**, so the
  empty pavement state says nothing. Type-41 rows are a
  **consumable-inventory log** (per-ID counts up to 1,485): the
  boardwalk/pier brushes consume one inventory item per tile (landinfo
  `consumableCount` + `onlyInventory`), so they leave events — while
  permanent-unlock brushes (RoadDrawing, PavementDrawing, RiverDrawing,
  …) consume nothing, so their uses are invisible to f16 **either way**;
  absence there is not evidence roads were quest-granted.
- The road grid's 903 single-tile components are procedural lattice
  (x=508 column, row stride 37 — filler), not stray sidewalk tiles.
- The ocean grid is likewise speckle-dominated (161 components: an
  organic wave band + five lattice single sets), so most of the 19+4
  brush tiles there per landinfo are not separable from rim noise at
  this save — but the structure-breakers east of the band ARE
  (next section).

**Decisive test (needs another save):** grab a `.pb` from a town that
definitely painted pavement (level ≥6 + `PaveParadise` quest). If
`roadMapList` then contains a **terrainType=1** entry, layers are stored
per-type and landinfo `map=` is presentation-only; if tt=1 never appears,
the merged-string storage (and load-time re-derivation) is confirmed.


### Recovering boardwalk/pier tiles from the ocean frame (2026-10-19)

> **SUPERSEDED 2026-10-28** (notes/09 §12 "The data"): `oceanData` is not a
> wave frame with brush tiles painted over it. It is the 4×4-cell codebook
> (3 blocks/row, mask reciprocity 1.000, origin (−48, −112)) and holds
> ONLY the brushes — 262 cells: the Squidport deck, the OrnatePier block,
> the PirateShip dock and the BarnacleBayMarina jetty. The "natural
> lattices" below are artefacts of reading it one tile per char, and the 5
> "recovered" tiles were mis-decoded cell bytes. Kept for the record only.

The "not separable" conclusion above holds only for tiles painted **over**
the natural structure. The frame itself decomposes exactly, so the
exceptions can be lifted out — `tools/gen_map_explorer.py` now emits two
pre-decoded layers (`boardwalk`, `pier`) that City View and the map
explorer render like any other terrain layer.

Natural model (grid x = frame col − 33 = `Terrain#seaColOffset`, notes/06
§s10; measured exhaustively over all 1,582 tiles):

| zone    | rule |
| ------- | ---- |
| band+rim | `x <= -22` (organic wave band + outer speckle columns, 161-component blobs) |
| A       | `y % 16 == 12` and `x % 4 == 0` |
| B       | `x in {-21,-18,-15,-12}`, `y % 64 in {45, 63}` |
| C       | `x in {-20,-17,-14,-11}`, `y % 64 in {15, 30}` |
| D       | `x in {-19,-16,-13}`, `y % 64 in {15, 30, 45, 63}` |
| E       | `x == -9` (`y % 64 == 48`);  `x == -8` (`y % 16 == 0`) |

Every tile with `x >= -21` matching **none** of these was brush-painted.
This save yields exactly five anomalies:

- `(-11,135)+(-11,150)` and `(-12,421)+(-12,439)` — two isolated 2-tile
  pairs sitting offshore in open water. **Count matches the f16 type-41
  ledger exactly: PierDrawing ×4** → assigned `pier`.
- `(-7,48)` — directly at the door of the SquidportEntrance gate building
  at (−8,48) → assigned `boardwalk`.

The other 15 BoardwalkDrawing tiles were painted over band/lattice
positions and are **unrecoverable** — the mapData string is position-only
and the type distinction is lost at save time. Note also the one
`OrnatePier` building at (−4,−16) lies *outside* the frame (y starts at
0), so pier tiles cannot be recovered from building proximity — only from
the structure-breaker rule.

Evidence: `mapdump/registration/m4-brush-classification.png` (full frame
+ zooms of the three sites). Rendering: City View legend rows
`boardwalk` (plank tan) / `pier` (weathered grey-brown, flat fills — the
plank art is not in the extracted packs), click-to-inspect cards, legend
toggles; same layers in the map explorer. Smoke: `smoke-city-view-dom.cjs`
"ocean brush layers" block (7 checks).


### buildingData (f7) — full field audit (decoded 2026-10-19)

`repeated BuildingData` = the 5,261 placed instances (209,539 B). The
schema lists 25 fields; this save serialises **15**, and every observed
one is now understood (Byte Map `STATUS_SUB['.Data.LandMessage.BuildingData']`):

- **f1 header** → `EntityHeader{ id }` = persistent **instance id**,
  unique per placement (103 .. 1,833,326,036) — the join key used by
  f35's serverID cross-check and (presumably) the live server.
- **f2 building** template DataID (2,299 distinct, fully catalogued);
  **f5/f6 positionX/Y** floats that are **always integral tile
  coordinates** (X −48..608, Y −111..780) — same frame as the
  landBlocks/tile rasters.
- **f3/f4 creationTime/updateTime** are unix seconds, not ms:
  2013-02-24 (game-launch era!) .. 2025-01-24; peak build month 2021-11
  (565 buildings) and 2020-11; updateTime max = the save's last activity.
- **f8 buildState**: 5 = complete (5,260/5,261). The lone
  `buildState=2` is **TutsnTotsElementary** (created 2025-01-12,
  updated 2025-01-15) — a build genuinely still in progress when the
  save was taken.
- **f10 cropState** {1,2} on 28 revenue/collection buildings
  (GiftCards, Tailgate, OpenAirStage, BullyVernLair…) — a visual
  stage/ripeness flag; no `crop` config exists in buildings.xml, so the
  name is legacy and the semantics (growing vs ready) are inferred, not
  verified.
- **f12/f13 betStartTime/betChoice** — Springfield Games **GoKart race
  betting** (`springfieldgames_buildings.xml` GoKartTrack 162002, placed
  by script `ReplaceGoKartsWithBetting`): 2 active bets (GoKartTrack and
  Luigi), both `betChoice=3`, times = 2025-01. `betActive`/`winningBet`
  (f11/f14) never serialised (false).
- **f16/f17 namelen+vandalName** (24 rows) and **f24 timeOfVandalism**
  (3 rows) — the `<Vandalism>` tag-for-rewards feature
  (`buildings.xml`: `suppressFriendClean/vandalRewardInstant/
  cleanRewardInstant`). All 24 vandalNames are **this land's own
  39-digit id** — self-tagged buildings awaiting clean-up; `vandalized`
  (f15) itself is never serialised (the name string is the marker).
- **f20 skin** — active **skin variant DataID**: 153 buildings, 48
  variants, e.g. `Decorated_Festive*` (44011–44019), winter skins
  `PushingAndShoveling_3..5` / `TheShiftingDrifts_1..2` (263003–7),
  `DonutPack1/2` (284000/1), driving-range upgrades (269004/7),
  `PrivateIsland_Complete01/04`. Sometimes equals the template id
  (default variant).
- **f22 flipState** {1:1,619, 2:92, 3:62} — orientation variant
  (default / rotated / flipped); `flipped` (f7) never serialised.
- **f23 subLandID = 1 for all** — every building lives on the main land
  (the f36 subland hosts none of them).
- Never serialised in this save (9): flipped, hurry, betActive,
  winningBet, vandalized, isOwnerList, ownerList, grantRewards, flags.

`stealableBuildingData` (f38, same message) is **absent** from the save.
Byte Map: f7 children now render fully **decoded** with these notes;
the segment stays *partial* at node level (9 unobserved fields +
cropState semantics inferred).

#### Road/river angle (2026-10-19 follow-up)

Keyword sweep over all 2,299 distinct f7 template names: **80 hits, all
cosmetic props** (BoardwalkFence ×28, CobblestoneWall ×22 — a wall, not
the cobble layer — Krustyland props ×21, 41 water-feature buildings
like SpringfieldLake / DinosaurLake / ToxicWasteLake / MinnowPond).
**No road or river is stored as a building** — consistent with the
raster census and the "no stroke store" finding. But four clusters are
terrain-story corroborations:

- **OrnatePier ×1 at (−4,−16)** and **SquidportEntrance ×1 at (−8,48)**
  — precisely the two `ConsumableLimit` gate buildings landinfo requires
  for PierDrawing (`linkedBuilding="OrnatePier"`) and BoardwalkDrawing
  (`linkedBuilding="SquidportEntrance"`). Their presence + negative
  coordinates (western ocean edge, cf. ocean RoadMap `origin=-3,-7`)
  independently confirms the f16 Boardwalk ×19 / Pier ×4 brush uses
  really happened, on that ocean corner.
- **48 boardwalk-themed props** (fence/lamp/railing/tree/bench/tents/
  carousel) = the Squidport boardwalk district the 19 boardwalk tiles
  were painted into.
- **21 Krustyland props + GoldTrain** — the KRUSTYLAND_ROADS(4) layer
  has no brush (pre-placed park); its 16 filled raster chars are the
  paths around these very props.
- Ponds/lakes/fountains are **single building assets**, not raster —
  distinct from the building-adjacent speckle in the river grid.


### Stashed bundles carry their own terrain — census revised to 14 grids (2026-10-19)

Full-segment review pass (everything still `schema`/`partial` on the
Byte Map). Headline: the >=128 B raster census had **missed four small
grids**, and two of them change the terrain story.

**1. f53 storage bundles hold RoadMap terrain patches.**
`GroupStorageBundle` = stashed decoration group: repeated
`{objectID, serverID, positionX/Y, flipped}` + `originPosX/Y` +
`timestampId` (unix ms; 2024-06..2024-10). **3 of 43 bundles also carry
a `groupStorageBundleRoadMap {subLandID, mapDataSizeX/Y, TerrainData}`**
with a live codebook grid:

| tt | patch | tiles | origin | bundled objects |
|---|---|---|---|---|
| 2 ROADS | 16x48 | 18 | (32,208) | **none — a pure stashed road** |
| 6 DIRT | 32x32 | 3 | (240,0) | Tree04/06, MapleTree, BF2016 promo |
| 12 SAND | 16x32 | 1 | (512,−80) | IncomeTax/NewFrontier/DonutVein/Buffalo props |

ROADS patch ASCII (x-offsets 8/8/12×14/4×2): a two-segment vertical
road strip. **Correlation check: 0/18 road tiles and 0/3 dirt tiles
appear in the main rasters at those positions** — when a bundle is
stashed, its terrain tiles are *removed* from the 512-wide main grids
and preserved inside the bundle; unstashing presumably restores them.
The sand tile at x=512 sits **outside the main grid frame** entirely.
Adjacent main-grid roads do abut the patch origin (16 tiles nearby),
matching a road that was connected before stashing.

**2. f36 subland has its own ROADS grid** — `SubLandData.terrainData`
tt=2, mapDataSize 128 (chars), 8 non-`G` chars (`bddk`, `bdh`, `dc`,
3× `m`) ≈ 14 tiles. The 64×64 subland mask keeps 10 blocks;
landBlockPosition (−2,0).

**3. f13 inventoryItemData = the brush consumable ledger.**
114 stacks `{itemType, itemID, count, fromLand, sourceLen}`;
**itemType 2 = consumables**: `BoardwalkDrawing (5000) ×365` and
`PierDrawing (139000) ×6` still in stock — the direct counterpart of
the f16 type-41 spends (19+4). Permanent brushes (road/pavement/river)
have **no rows**: nothing to consume. itemType 0 = decoration
inventory counts (e.g. 109512 ×3,533).

**4. f11 questData closes the brush-gate loop.** 7,268 QuestData
`{questID, state, timesCompleted, objectives}`; state 5=done (6,837),
1=new (370), 3=active (61). **`PaveParadise` (47) and `RiverRun` (48)
are both completed** — the exact landinfo `DrawRequirements` gates for
the pavement and river brushes; also done: `TheDirtiestRoadsInSpringfield`
(145516).

**5. Everything else checked, terrain-negative.** f10 jobData: 519
working jobs (390 templates: Shrub01 collections, NPCTicketGeneration,
SpookyCabinJob; state 1=working/2=ready; grid fields unused). f12
notifications: 1,543 move/history records, historyQuestID −1. f27: 40
named SpecialEvents (incl. `ReplaceRailyard` — a building-swap event;
the f16 type-175 arg1 ids live here). f48: 187 sequential ad-hoc
registry ids. f18 sidebar promos (JetEngineBike_SP_Con,
TwoMinutesOfHate03), f22 bonus flags, f23 845 char unlocks, f24 skin
bitfields 2,119/2,077, f26 currencies, f2 = level-939 profile +
currency ledger, f40 friend land ids, f46 daily tasks, f49 "US",
f51 job census, f52 DNA state. Byte Map: schema-only now **0.4%** of
bytes (was 16.9%).

Consequence for the road-map hunt: the main rasters are still the only
*visible* terrain record, but the save's full terrain set is 10 main +
1 subland + 3 bundle patches; a future save-completeness tool must
restore stashed patches on unstash, and the subland's road tiles live
outside the main grids.


## .time sidecars (CDN upload timestamps)

Every CDN pack zip has a sibling `<name>.zip.time` file of **exactly 10
ASCII bytes, no newline**: a Unix epoch timestamp in seconds (UTC) — the
last-modified time of the corresponding `.zip` on the fan CDN.

Verified 2026-10-15 (CDN Explorer session) on 30/30 of a 10-per-bundle
sample across `1_0_4` / `1_1_35` / `3_0_30`: all files are 10 bytes and
match `^\d{10}$`, and the values form a consistent per-generation
timeline rather than per-file content data:

- `1354651…` = 2012-12-05 — the original uploads
- `1417567…`/`1417568…` = 2014-12-03 — the `r146180-0D2B882C` re-revisions
- `1427206…` = 2015-03-24 — the `r157326-B8353263` re-revisions

Decoder: `int(text, 10)` → `datetime.fromtimestamp(v, timezone.utc)`.
(Recorded as a format finding on `cdn/cdn-explorer.db`; the remaining
sidecars are all 10 bytes and will triage identically.)

## Resolution tiers

Tiers are resolution scales (from tsto2rgb `bsv.py` `TIERS_SCALES`):
`{25: 1/4, 50: 1/2, 100: 1, ipad3: 1, retina: 2/3, ipad: 1/2, iphone: 1/3}`.
The web port's "game class" (what the splash actually composes) =
**medium** splash pack (design-space height 1024; scale S =
viewportH/1024) + **large** UI chrome.

## bsv3 playback rate — still unmeasured (2026-10-31, open)

Nothing in the art says how fast a bsv3 loop plays: the frame records carry no
delay (`bcell` characters have `delay_ms`, bsv3 buildings have nothing), and
none of the 3 634 building XMLs in the city pool carries an
`fps`/`delay`/`duration`/`interval` attribute — so a viewer has to pick a
ticks/s constant.

What the binary does say, in `libscorpio.so`: `SequenceControllerInstance::Update`
(vtable `0x1a28b38` slot 2, fcn `0x1085364`) loads a counter at `[obj+0x3c]`,
adds 1, stores it back, and indexes a 16-byte-stride vector at `[obj+8]` with
it — `+1` per call, unconditionally, with no clock read, no accumulator and no
per-frame delay compare. That settles *how* the raw frame index advances.

What it does **not** settle is how often that update runs, and that is the
number that decides speed. It is a vtable slot, so no BL points at it
(`tools/../rz/walk.py callers` finds nothing); the render path contains no
frame limiter, but "no limiter" is only an argument for vsync-rate updates if
the update is actually driven from the draw callback, which was not proven. A
20-frame loop at 60 ticks/s is a third of a second, which no prop art was
authored to read at; side-by-side with the game, 60 ticks/s looked far too
fast and 12 read as closer to right. Treat 12 fps (the `ANIM_FPS` default in
`tools/gen_city_sprites.py`) as the empirical value, not a verified one, and
re-open this by finding the caller of the vtable slot rather than by
re-deriving the increment.

**2026-11-03 update — the viewer now ships at 2× that, i.e. 24 ticks/s.** The
Pixi viewer gained a global playback-rate control (the `Speed` button in the
viewbar, `?animSpeed=`; CHANGELOG 2026-11-03/.2), which turned this
comparison into a live A/B instead of a regenerate-and-reload. Against
`Tapped Out - Simpsons_Screenshot-2025-01-17--19-12-02.png` the bare 12 fps
read slow and 2× read right, so `ANIM_SPEED_DEFAULT = 2` in
`web/viewer/city-view-pixi.js`. Two things this deliberately does NOT change:
`ANIM_FPS` stays **12** in `tools/gen_city_sprites.py`, so the manifest keeps
recording the raw strip timing and the rate remains an opinion the viewer
applies at draw time (the deprecated Canvas page and the details-card
players still read 12 fps), and 1× stays on the button ladder as the
unmodified reference. Anyone re-deriving the constant should quote the rate
the viewer *ships at*, not the manifest's `fps` field, or the two will
disagree by exactly this factor. Still an eye call, not a measurement: the
caller of the vtable slot remains the way to settle it.
