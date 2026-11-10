# 14 — The scripts' sound tables: what a click plays, what the town hums

Where the *scripts* (not the file names) say what plays. Both sidecars the
Pixi viewer streams — `tap-sounds.json` (clicks) and `ambient-sounds.json`
(background loops) — are read out of the same place: the newest extracted
`web/assets/dlc/gamescripts-r<rev>/data/*.xml` pack (4,003 XMLs, the fullest
copy of the table; found through the `packs` table, newest revision). Nothing
here is guessed from stems: stem heuristics only ever speak for entities the
table is silent about (see `tools/gen_tap_sounds.py` for that half).

## 1. Tap table (2026-11-10, `tools/gen_tap_sounds.py`)

* `<Building>` / `<Skin building=…>` blocks carry
  `<Sound event="BuildingTouched" sound="20_simpson_house_1.caf" />` or a kit
  reference `<SoundKit event="BuildingTouched" name="…_tap" />`.
* `<Character>` / `<Skin character=…>` do the same with
  `CharacterSoundTouched` / `CharacterTouched`.
* A `<SoundKit name="…" channel="buildingTap_channel">` package lists its
  `<Sound name="…"/>` members; kits not defined in the scripts pack are chased
  through other packs' `*_soundkits.xml` (newest first).
* Sound names resolve against **every** audio row in `web/api/assets.sqlite`
  (case-insensitive, container dropped) and only a browser-playable
  `.m4a`/`.wav` is kept — never the game's `.caf`.

## 2. Ambient object loops (new, `tools/gen_ambient_sounds.py`)

179 catalogued buildings/decorations (decorations ship as `<Building>` blocks
too) carry:

```xml
<AmbientSound soundKit="amb_ferris_wheel" />
```

resolved through a `<SoundKit>` package (in `ambient_buildings.xml`,
`ambient_decorations.xml`, `ambient_jobs.xml`, `*_soundkits.xml`, or the
event pack that ships the decoration):

```xml
<SoundKit name="amb_ferris_wheel" channel="objectAmbient_channel">
    <PlayStyle type="LoopSingle" />     <!-- or LoopSoundKit / PlayOnce -->
    <Position min="12" max="30" />      <!-- full-vol radius / cutoff, tiles -->
    <Sound name="Ferris_Wheel_Loop" />  <!-- random member loops -->
    <Volume value="0.6" /> <Pitch value="0.8" />
</SoundKit>
```

* `LoopSingle` loops ONE random member; `LoopSoundKit`/`PlayOnce` with
  `PreDelay`/`PostDelay` is the periodic one-shot (the Duff Party Liner's boat
  horn: 3 horns, post-delay 8000 ms ± variance).
* Kits repeat themselves: the scripts reuse a small library (95 loop/amb files
  serve everything) and differentiate with `Pitch` — Rancho Relaxo's "fountain"
  is `dec_WaterFountain_Med_amb_loop` at pitch 1.8, all 31 World-Cup flags are
  `dec_American_Flag_Flapping_Loop`, Kwik-E-Mart Central Office "mountain air"
  is the zone mountains loop at pitch 0.7. Pitch reaches the browser via
  `Player.setRate` in `web/js/audio.js`.
* Kits with no `<Position>` (e.g. `Ambient_Pinchy`) get a 16-tile default in
  the sidecar; the same kit repeated per animation state (OldKingCoal carries
  `Ambient_Pinchy` 8×) is deduped — one loop is one loop.
* `<AmbientSound>` also appears on `<Job>` blocks (7 jobs: hand-cranked
  generator, McBain gunfire, Fat Tony's violin…) — not placed by the viewer
  today, left out of the sidecar.
* 127 of the save's 2,299 placed buildings own a loop; the remaining silent
  majority are fences, hedges and trees, which the scripts really do leave
  silent.

## 3. Zone beds (terrain ambience)

`landinfo.xml` attaches per-land regions in **the same tile grid the save
places buildings on** (so the viewer tests `CAM.worldToTile(cam.x, cam.y)`
against them directly):

```xml
<AmbientSounds>
  <Region name="Ocean" soundKit="Springfield_Water" radius="24"
          x1="-48" y1="-4" x2="-2" y2="700" />
</AmbientSounds>
```

Springfield ships 6 regions (centre + Springfield Heights via the
`__Settings_Config:Settings:SpringfieldSoundkit__` indirection — resolves
through `settings_config.xml` to `Springfield_Center`, the green-area loop;
an ocean strip on the west edge of both halves; mountain strips on the north
edge of both), Krustyland 1. Zone kits run on `ambient_channel` with 3000 ms
`FadeInTime`/`FadeOutTime`; the viewer cross-fades and picks the SMALLEST
containing region. The beds live in
`dlc/AmbientAudio_CoreLoops-wav-r337922/audio/` (and the centre loop, newest
revision, in `tutorialsnowaudio-wav-r492453`).

## 4. The viewer wiring

`web/viewer/city-view-pixi.js` fetches `assets/city/ambient-sounds.json?v=1`
at boot. Object loops are re-scanned every 500 ms against the camera centre
(distance falloff inner→radius), capped at 5 concurrent players (the game's
single `objectAmbient_channel`), and obey the **Sound** toggle; the zone bed
cross-fades over 3 s on region change. Nothing starts before the first user
gesture (autoplay policy) — the ctx resume and an immediate rescan ride the
first pointerdown/keydown. Harness: `node tools/smoke-ambient-sounds.cjs`
(checks the core roster — ferris wheel, tireyard fire, Popsicle-stick
skyscraper, the liner's periodic horn — plus all seven zones and their rects).
