# 12 — Building animation wiring: who tells the viewer to play a filmstrip

Written 2026-11-02 after the full `0x0303` regeneration, to record why most
newly-baked v3 filmstrips still never play, and what the scripts actually say
about each case. Per-asset evidence:
`mapdump/registration/m4-v3-gate-audit.md` (65 rows) + sample atlases
`mapdump/registration/m4-v3f-*.png`.

## 1. Two halves of `city-anims.json`, and the gate is the one that matters

`web/assets/city/city-anims.json` (written by `tools/gen_city_sprites.py
anims`) carries:

- `anims` — `slug → [{anim, file, frames, cellw/cellh, cols, …}]`: **what
  exists on disk** under `web/assets/city/anims/`.
- `behavior` — `slug → {idle, tap, toggle, layers}`: **what the game does**
  with it. This is the *gate*. The Pixi viewer only ever plays a strip a gate
  names (`pickAnim(list, behav[s].idle)`, the tap path, and the
  `toggle`/`inout`/`active`/`cycle` paths in `web/viewer/city-view-pixi.js`).

**A strip with no gate is dead weight: the building draws its static PNG.**
That is why PlaydoughFactory needed a hand-written `V3_CLICK_GATES` entry
(changelog 2026-10-31.4) — real `Active`/`Active_Out` frames, no script names
them, so nothing played.

The gate's authority is the gamescripts scan cached in
`data/building_behaviors.json` (`behavior` subcommand; invalidate by
extracting new packs or `--refresh`). Three sources feed it:

| source | record | gate |
|---|---|---|
| `<Building>` def's `NeutralAnimationController` / `ActiveAnimationController` | `byName[name].idle` | loops the anim while the state holds |
| `BuildingTouched` script in `*_scripts.xml` | `tapVerb` + `tapVars` | one-shot on click |
| `buildingcontrollers.xml` `<Sequence name=…><Logic><If …><Animation name=…/>` | `controllers[name]` via `_parse_controller` | `toggle` (`inout` / `active` / `cycle`) |

## 2. Task-triggered building animation is real — and it is NOT these assets

`<Job>` blocks can carry:

```xml
<BuildingAnimation><Controller name="WindowBreak" /></BuildingAnimation>
```

which plays on the job's target building while the character works (49
`<AnimateBuildings>` + 9 `<BuildingAnimation>` in the newest pack). Verified
examples, useful as the reference set for "animation triggered by a character
task":

| job | building | plays |
|---|---|---|
| `SmashUpFlanderssHouse` (Homer) | FlandersHome | Controller `WindowBreak` |
| `HoldAWhackingDayPromotionTemp` (Apu) | KwikEMart | Controller `WindowBreak` |
| `SingTheStonecuttersSongAnim{,2,3,Prem}` | StonecutterTableSeat | `ActiveTopEmpty` `loop="true"` |
| Secret Agents (Hank Scorpio / Agent Bont jobs) | **DeathTable** | Controller `ActiveFastBreak` |
| Rommelwood `FaceTheTrainingPlane` | TrainingPlane | `TrainingPlane_Active` |
| Sci-fi `PrintSomeResumes` | 3DPrinter | `3DPrinterController` |
| Superheroes Boss Fight `ShirkHisResponsibilities` | BeachHouse | `Active` |

All 6 pack revisions were searched (`<BuildingAnimation>`,
`<AnimateBuildings>`, `<Controller name=`) plus every `<Job>` / `<Date>` /
`<Consumable>` element containing an `<Animation>`: **none of the 65
gate-less v3 assets is named by any of them.** So "these are job-triggered"
is ruled out for this batch (it stays true as a mechanism for the assets
above — none of which the viewer animates today either; that is its own open
item).

## 3. What the 65 gate-less v3 assets actually are

Counts from the audit (newest pack `gamescripts-r364478`, names resolved with
`_slug_name_index` / `data/building_ids.json`):

### A — 17 = Secret Agents *Espionage Mode* (event-driven, not tap)

`AgencyHeadquarters`, `CafeKafka`(±flip), `GlobexCompound`(±flip),
`CrouchingPandaHiddenEggroll`(±flip), `SecretCoffeeBar`(±flip),
`SecretDentist`(±flip), `SecretDryCleaners`(±flip), `SecretMechanic`(±flip),
`SecretPawnShop`(±flip).

Their def says e.g. `NeutralAnimationController=EspionageMode_Neutral_Simple`,
and `buildingcontrollers.xml` defines:

```xml
<Sequence name="EspionageMode_Neutral_Simple"><Logic>
  <If expression="Land::getVariable('EspionageMode')==1"><Animation name="Active"/></If>
  <Else><Animation name="Neutral"/></Else></Logic></Sequence>

<Sequence name="EspionageMode_Neutral_InOut"><Logic>
  <If expression="Land::getVariable('EspionageMode')==1 &amp;&amp; Object::EspionageModeJustFlipped==0">
      <Animation name="Active_In" skipIfMissing="true" script="SecretAgents_Scripts:EspionageModeFlippedOn"/>
      <Animation name="ActiveIn"  skipIfMissing="true" …/></If>
  <ElseIf expression="Land::getVariable('EspionageMode')==0 &amp;&amp; Object::EspionageModeJustFlipped==1">
      <Animation name="Active_Out" …/><Animation name="ActiveOut" …/></ElseIf> …
```

(`_HQ` is the same thing wrapped in a `Object::SkinID` test.) So these are a
**land-variable mode**, town-wide, flipped by the Secret Agents event — not a
click machine. They are dropped because `_parse_controller` only recognises
the click shapes (`State`/`ActiveIn`/`ActiveOut` variables): **21 of the 104
`<Sequence>`s in `buildingcontrollers.xml` parse.** To ship them: teach
`_parse_controller` the `Land::getVariable('X')==1 → <Animation>` shape,
record `{kind:'mode', var:'EspionageMode', on, in?, out?}` in the gate, and
give the viewer a preview toggle next to the season buttons. *Not started —
deferred by the user 2026-11-02.*

In-game check for the user: during the Secret Agents event these are the
buildings that change when espionage mode flips.

### C — 2 = tap verb names an anim the file does not have

- `pagoda` — tap verb `Active15Loops`; the `.bsv3` has `Active_In 0–17`,
  `Active 18–18` (a 1-frame hold), `Active_Out 19–36`, `Neutral 37`.
- `shintoshrine` — tap verb `ActiveNoLoop`; its `Active 158–232` range is 75
  frames of **one** unique image (hence "NoLoop"), so `anims` correctly
  refuses to bake a strip and `_toggle_anims` drops the half-toggle.

### D — 46 = no animation wiring at all

`Americatown`, `Barra`(±), `BowlingLane`(`FullBowlingLane`),
`ChateauMaison`(±), `Churrascarias`(±), `CypressCreekElementary`(±),
`FiestaTerrace`(±), `HeavenlyHillsEastWing`(±), `HimejiCastle`,
`HomersWorkbench`, `LandOfChocolateShop`(flip), `LeKrustyBurger`(±),
`MarketingAgency`(flip), `MotherlovingSugarCo`(±),
`NicksBowlingShop01/02`(±), `NorbertsPlane`, `ParisHotel`(±),
`PinPalsBowlingAlley`(±), `RioDaysInnEro`(±), `RoyalTokyo`(±),
`RunwayLight`, `SambaSchool`(±), `ShaboomKaboomCafe`(±),
`StonersSpotPalace`(±), `TouristInformationCenter`(±), `TreeSteakhouse`,
`WritersBuilding`.

Their `<Building>` def contains only `BSv2 / BuildTime / (Cost) / GridType /
Group / Job / RatingElem / Requirement(s) / Sell / SoundKit / Unique` — no
controller, no tap script, no `<Animation>` anywhere. Read: **authored
`Active*` art the shipped scripts never play.** Leave static (user's call
2026-11-02: nothing auto-loops without script authority).

## 4. State of the v3 batch after the 2026-11-02 regeneration

- `sprites --slug <142 v3 slugs>`: 142/142 bodies + 141 winter + 1 halloween.
  Static picks (all real engine frames): **neutral 88, best 26, run 26,
  runmax 2** — no `cluster`/`body` fallback left. The only 1-block picks are
  `atfvan`, `atfvanflipped`, `japanesecherrytree` (legitimate single-block
  art).
- `anims --slug <same list>`: 96 assets, **150 new atlases**, 2547 → 2639
  assets, 5502 strip PNGs.
- The 47 v3 assets with no strip are fully accounted for: 28 undecoded
  delta-style files (static-only, see `01-binary-formats.md` §bsv3 — includes
  `kinghomersskyscraper`, `terminal`, `bastille`, `deathtable`, `planebot`
  …), 15 whose only "anims" are 1 frame (`nf <= 2`: `footballfield`,
  `hangar`, `japanesecherrytree`, the Heavenly Hills wings, `paintedhome01/02`,
  `ktvbuilding`, `filthyangelsorphanage`, `arcdetriomphe`), and 4 whose
  decoded frames are byte-identical.
- Those 4 are worth remembering: `runwaypiece01/02/02down/03` decode 43
  frames that **all draw the same 13 blocks** (verified: one distinct cell
  set across every frame — the runway slab plus its lights, from a 14-entry
  pool), so `anims` skips them with "every frame identical". Their in-game light blink is not in the frame
  section — it is not a decoder failure. (`runwaypiece02up` is the sibling
  that *is* in the undecoded family; its static runway now renders via
  `_v3_runmax`.)

## 5. Reproducing / extending

```bash
cd tools
python3 gen_city_sprites.py sprites --slug a,b,c      # comma lists supported
python3 gen_city_sprites.py anims   --slug a,b,c
python3 gen_city_sprites.py behavior --write-map       # gates only
python3 gen_city_sprites.py parse-only                 # 3620/3620 parse to EOF
```

After any regeneration bump `ASSET_V` / `MANIFEST_V` in
`web/viewer/city-view-pixi.js` (and the `city-view-pixi.js?v=N` buster in
`web/viewer/index.html` when the JS changes).

Open, user-deferred: (a) `mode` gates + viewer spy-mode toggle for the 17
class-A assets, (b) supporting the `<Job><BuildingAnimation>` task-triggered
plays of §2 (none of which the viewer can play today), (c) cracking the 28
delta-style frame sections.
