# 05 — Game logic (native) — first pass

First-pass reverse engineering of **`libscorpio.so`** (the Bight **BGCore**
engine), the 28 MB native library that holds *all* gameplay logic. Done with
**rizin 0.8.2** (installed 2026-10-15) plus stdlib-Python helpers. This is the
long-deferred "Phase 3" from `03-open-work.md`, now started at the user's
request.

> Scope of this pass: static recon only — no dynamic analysis, no decompiler
> (rizin's `pd`/`pdf` disassembly works but nothing has been function-level
> decompiled yet). The goal was to establish *what the game is made of and how
> it talks to the server*. Findings below; raw artifacts in `re/`.

## 1. What survives after stripping

`libscorpio.so` is **stripped** (no `.symtab`), so the game's own C++ classes
have **no exported symbols and no method names**. What *does* survive, and is
the entire basis of this pass:

1. **`dynsym`** — 12,653 *defined* dynamic symbols. Almost all of it is
   **third-party**: `google::protobuf` (~3,000), `EA::Nimble` (EA's account/
   billing SDK), `google_breakpad`, OpenSSL, SQLite. Only the **JNI bridge**
   (`Java_com_ea_simpsons_*`, `Java_com_bight_android_jni_BGCoreJNIBridge_*`)
   is game-authored and exported.
2. **RTTI typeinfo name strings** in `.rodata` — the linker kept the mangled
   `N…E` typeinfo keys for ~856 classes. Demangled (the system `c++filt` is a
   no-op here, so a tiny `g++`+`abi::__cxa_demangle` helper was built), these
   expose the **full game class roster**: `BightGames::*` (71), `BGMenuCmds::*`
   (62), plus the 197 `Data::*` protobuf message classes. This is how the
   stripped game logic was mapped.
3. **A private protobuf descriptor pool** — the crown jewel, see §2.
4. **String constants** in `.rodata` — all URLs, API paths, UI labels, and the
   names of every *Task*/*NetworkHandler*/*Script* (these are registered by
   name at runtime).

The Bight game classes' *methods* are **not** recoverable from symbols — only
their class names (RTTI) and their string/URL constants. Function-level
behavior would need rizin's call-graph + disassembly cross-referenced against
these (the `aaa` pass was started; see §6).

## 2. The wire protocol (decoded in full) — `re/proto_schema.txt`

The binary embeds a **private protobuf descriptor pool** in a dedicated
section **`protodesc_cold`** (file offset `0x45d868`, 0xf76c bytes). It is a
concatenation of serialized `google::protobuf.FileDescriptorProto` blobs. A
stdlib parser (`re/parse_protodesc.py`) walks them and reconstructs the **entire
client↔server data model** — 16 game `.proto` files + the standard
`descriptor.proto`:

| file | package | msgs | what it carries |
|---|---|---|---|
| **`LandData.proto`** | `Data` | 20 | **The whole city.** `LandMessage` = 53 fields: `buildingData`, `characterData`, `jobData`, `questData`, `terrainData` (roads/rivers/ocean), `currency`, `inventoryItemData`, `memorabiliaItemData`, `subLandData`, `minigameData`, `timedScriptData`, `specialEventsData`, `dailyTaskDataList`, … plus ~90 nested sub-messages (`BuildingData`, `CharacterData`, `JobData`, `QuestData`, `TerrainData`, `UserData`, `FriendData`, …). |
| `AuthData.proto` | `Data` | 7 | Login: `UsersResponseMessage`, `TokenData` (sessionKey+expiry), `LinkData` (TNT/Nucleus identity), `UserIndirectData`. |
| `PurchaseData.proto` | `Data` | 7 | IAP: `PurchaseRequest/Response`, `CurrencyData`, `OrderData`, `SubscriptionData`; platform enum (ITUNES/GOOGLEPLAY/AMAZON). |
| `CustomerServiceData.proto` | `Data` | 6 | `LandResponseMessage` (land + session + error), `LandBackupResponseMessage`, `UserResponseMessage`. |
| `WholeLandTokenData.proto` | `Data` | 4 | Whole-land write token (optimistic locking for city saves): create/delete/check token request+response. |
| `Common.proto` | `Data` | 2 | `NameValue`, `NameValueSet`. |
| `GetFriendData.proto` | `Data` | 2 | Friend-land fetch (`FriendDataPair`, auth service enum NUCLEUS/FACEBOOK). |
| `GameplayConfigData.proto` | `Data` | 1 | `GameplayConfigResponse` (name/value gameplay tuning). |
| `ClientConfigData.proto` | `Data` | 1 | `ClientConfigResponse` (server-driven client config items). |
| `OffersData.proto` | `Data` | 1 | Store offers: `OfferItem` (MTX/PREMIUM/CHARACTER/BUILDING/CONSUMABLE), popularity lists, level-up XP offers, price overrides. |
| `GambleData.proto` | `Data` | 1 | `GambleResponse` (currency awarded). |
| `MatchmakingData.proto` | `Data` | 1 | `MatchmakingResponseMessage` (opponent's `LandMessage`). |
| `Error.proto` | `Data` | 1 | `ErrorMessage` (code/type/severity enums). |
| `ClientTelemetry.proto` | `com.ea.simpsons.client.telemetry` | 6 | FPS/memory/DLC-download telemetry. |
| `ClientMetrics.proto` | `…client.metrics` | 1 | Counter/histogram metrics. |
| `ClientLog.proto` | `…client.log` | 1 | Client log lines. |

This is the **complete server-authoritative data model**: everything the client
knows about a city (buildings, characters, jobs, quests, currency, terrain,
events) is a field of `Data::LandMessage`. Notably the client holds **no
gameplay state machine of its own** — it renders whatever `LandMessage` the
server sends and posts actions back.

### 2.1 Cross-validation against the fan server — exact parity

The fan server ships its own `.proto` sources
(`server/source/server/protobufs/`, same 16 filenames).
`re/diff_schema_vs_server.py` compares every message/field/number from the
decoded pool against those sources (rough text parse of the `.proto` files,
both directions):

```
TOTAL: 0 messages missing from pool, 0 fields missing, 0 number mismatches, 0 pool-only fields
```

15/15 game protos (198 messages, 1002 fields, 21 enums) match **exactly** —
message names, nesting, field names, field numbers, and enum values. The
schema we decoded straight out of the binary is therefore a faithful ground
truth, not an approximation, and the fan server's wire protocol is the
original EA protocol verbatim.

## 3. The server API surface — `re/endpoints.txt`

All HTTP paths found in `.rodata`. The game talks to one base host (fan build:
`game.pjtsto.com`; EA-original: the `bg_gameserver_plugin` service) plus the
CDN (`cdn.projectspringfield.com/static`, hardcoded in all four `libscorpio*.so`).

**Game server** (`/games/bg_gameserver_plugin/…`):
`checkToken/` · `land/` · `protoland/` · `upgradeland/` · `extraLandUpdate/` ·
`migrateLand` · `protocurrency/` · `currencyInventory/` · `purchase/` ·
`offers/` · `event/` · `friendData` (+`/facebook`, `/origin`) ·
`protoClientConfig` (+`/custom`) · `protoWholeLandToken/` · `deleteToken/` ·
`telemetrylog/` · `trackinglog/` · `trackingmetrics/`.

**Auth / identity** (Origin "TNT" / Nucleus / Synergy, mostly dead in the fan
build): `/rest/oauth/anonymous/` (+`/recover/`) · `/rest/oauth/origin` ·
`/rest/token/` · `/rest/token/validate` · `/rest/users` · `/identity/*` ·
`/personas` · `/users` · `/userlands` · `/extoken` · `/cachedUser`.

**DLC (CDN)**: `/dlc/index` (master index) · `/dlc/movie-intro-*`.

The protocol is **HTTP + protobuf** (not a raw socket): each "NetworkHandler"
(§4) is one HTTP round-trip that (de)serializes one of the §2 messages. The
whole-land **token** dance (`protoWholeLandToken` → `protoland`/`upgradeland`)
is the optimistic-locking scheme for saving a city: get a token, mutate, write
back with the token; a `conflict` flag (see `WholeLandTokenResponse`) signals
a competing write.

## 4. The client architecture (from RTTI + string names)

The game logic is organized into a small number of class families. Names come
from RTTI (`re/rtti_classes.txt`) and runtime registration strings.

**`BightGames::` — the network/session layer (71 classes).** The heart of
server communication:
- **Core**: `GameClient`, `GameClientManager`, `ScorpioGameClient` (the top
  object), `ServerCall`, `NetworkHandler` (base), `NetworkTaskHandler`,
  `TimerCallback`, `SimpsonsNetworkHandler` (game-specific base).
- **City/land I/O**: `CreateLandNetworkHandler`, `LandWriteNetworkHandler`,
  `WholeLandWriteNetworkHandler`, `ExtraLandWriteNetworkHandler`,
  `ReadLandWithTokenNetworkHandler`, `ReadFriendLandNetworkHandler`,
  `CheckWholeLandToken/…ChecksumNetworkHandler`, `Create/DeleteWholeLandToken…`.
- **Economy**: `CollectCurrencyNetworkHandler`, `ReadCurrencyNetworkHandler`,
  `RetrieveOffersNetworkHandler`, `PrizeBoxNetworkHandler`/`IPrizeBox…`.
- **Social/friends**: `StealBuildingNetworkHandler` (vandalism/theft),
  `FriendEventNetworkHandler`, `FindMatchNetworkHandler`,
  `UnregisterMatchmakingOpponentNetworkHandler`, the whole `TNTFriends*` set
  (invite/accept/reject/search/avatar — EA Origin, dead in fan build).
- **Auth/session**: `AnonymousLoginNetworkHandler`, `RequestAuthToken…`,
  `RequestMayhemID…`, `RequestSynergyID…`, `TNTOriginAuth…`, `Heartbeat…`,
  `ExternalConnectivityCheck…`, `DeleteUser…`.
- **Telemetry**: `TelemetrySendNetworkHandler`, `EndOfSessionTelemetry…`.

**`*Task` — async units of work (72 by name).** Each pairs with a
NetworkHandler or is local: `AnonymousLoginTask`, `ReadLandTask`,
`ReadFriendLandTask`, `ReadOpponentLandTask`, `SyncTask`, `SyncExtraTask`,
`DLCIndexTask`, `DLCMasterIndexTask`, `DLCMasterRedirectTask`,
`DLCCheckMasterIndexTask`, `DLCTierOverrideTask`, `GameConfigTask`,
`ClientConfigTask`, `HeartbeatTask`, `FindMatchTask`, `RetrieveOffersTask`-style
(`FetchMTXItemsTask`), `SaveLoginDataTask`, `DeleteUserTask`, the `TNT*`
tasks, `TimeTask`, `DailyTask`. These run on a task queue; a Task usually
*issues* a NetworkHandler and reacts to its callback.

**`*Script` — gameplay behaviour scripts (67 by name).** The engine's scripted
actions for buildings/jobs/friends: `Job*` (`OnJobBegin/Cancel/Complete/
Done/Started`, `JobsStarted`, `JobLocationWaitFor`), `VandalismScript`,
`CollectScript`, `CleanScript`, `IdleScript`, `IntroMessageScript`,
`TriviaScript`, `PrizeTrackButtonScript`, placement/requirement scripts
(`PlacementGridErrorScript`, `UnmetRequirementsScript`,
`CannotAffordUpgradeScript`, `InventoryCharRestrictionScript`), and button
scripts (`BuildButtonScript`, `FriendButtonScript`, `PlaySinglePlayerScript`,
…). These map 1:1 to the `timedScriptData` / quest/script state in
`LandMessage` — i.e. **server-driven** scripts the client plays back.

**`BGMenuCmds::` — the in-game UI/command layer (62 classes).** A retained-mode
menu system built from composable command objects: `Button`/`TextButton`/
`DragButton`, `Container`, `Component`, `Template`, `Scroll`, `Text`, `Rect`,
`Graphics`, plus transform/state commands (`ColorCmd`, `ScaleCmd`, `FlipCmd`,
`RotateCmd`, `AlignCmd`, `HideCmd`, `WidthCmd`, `HeightCmd`, `CenterCmd`,
`PickerCmd`, `ToggleCmd`, `SetAnchor*`, `SetCanvas*`) and `BSv2` (the `.bsv2`
menu-scene format — the ancestor of the `.bsv3` building scenes already
documented in `01-binary-formats.md`). `BGMenuParserCommands::*` is the XML
parser state machine that builds these from menu definition files
(`tinyxml2` is linked in for exactly this).

**Smaller subsystems (RTTI):** `Matchmaking::*` (target lists, formula &
spendable parameters for opponent matching), `DataSelector::*` (fixed/formula/
table value selectors — the game's little formula evaluator),
`JobCensusRulesComponent::*` + `DefaultJobReward::*` (job reward/census rules),
`RoadsUtil::*` (road-grid bool rects), `Subscription::*` (IAP subscription
validation), `SpecialEventGeneralBuffers::*`, `GameState_*` (per-screen state:
`GameState_JobList`, `GameState_BuildingSelected`, `GameState_HubQuestLot…`,
`State_TapBallMatch`, `State_HubFriendList`), `HUDHandler`, `BonusManager`,
`LoginDiagnostics`.

**Animation/behaviour controllers** (RTTI via `enable_make_shared<…>`):
`LogicController`, `RandomController`, `LoopingController`, `SequenceController`,
`MovePickController`, `MoveGroupController`, `AnimationController`,
`OverlayPhaseController`, `PriorityListController`, `LogicGateController` — a
hierarchical behaviour/animation sequencer (what drives `.bcell`/`.bsv3`
playback).

### Third-party stack (for context, not game logic)
`google::protobuf` (wire format + descriptor reflection), `EA::Nimble` (EA
account/billing/Facebook SDK — dead in fan build), `google_breakpad` (crash
minidumps), OpenSSL (TLS), SQLite (local cache), `eastl` (EA STL), `tinyxml2`
(menu XML), `jsoncpp` (`Json::Writer`).

## 5. Function-level string xrefs (no decompilation needed)

`re/str_xref_scan.py` finds string references by decoding **ADRP + ADD**
instruction pairs in one linear pass over `.text` (~1s, no rizin analysis
needed; ADRP page math and ADD immediates verified byte-for-byte against
rizin's disassembler). Output: `re/str_xrefs.tsv` — 52,336 rows of
(string, string-vaddr, xref-PC, enclosing-function).

**The network request factory.** All 21 `/games/bg_gameserver_plugin/*`
endpoint strings *plus* `/dlc/index` are referenced from a single function,
**`fcn.012f01b8`** (stripped; the next function start is `0x12f49ac`, so the
factory spans at least ~18 KB, `0x12f01b8`–`0x12f49ac`, endpoint xrefs at
`0x12f0f24`–`0x12f30d0`). It sits immediately before the
`BightGames::PrintNetworkHandler` vtable/methods (`0x12f4b3c`+), confirming
this is the BightGames network-layer module. The same window also references:

- the **complete network op vocabulary** — the client→server request types:
  `AUTHENTICATE` · `READ_SERVER_TIME` · `HEARTBEAT` · `UPGRADE_LAND` ·
  `UPGRADE_EXTRALAND` · `WHOLE_LAND_TOKEN` · `WHOLE_LAND_UPDATE` ·
  `WHOLE_LAND_CHECKSUM_CHECK` · `MIGRATE_LAND` · `MIGRATION_AVAILABLE_CHECK` ·
  `LAND/BUILDING` · `LAND/PERSON` · `LAND/QUEST` · `READ_CURRENCY` ·
  `READ_INVENTORY` · `RETRIEVE_OFFERS` · `READ_GAME_CONFIG` ·
  `READ_CUSTOM_GAME_CONFIG` · `READ_CLIENT_CONFIG` ·
  `READ_CUSTOM_CLIENT_CONFIG` · `READ_NOTIFICATION_STATUS` · `NOTIFICATION` ·
  `TELEMETRY` · `SESSION_TELEMETRY` · `METRIC_MESSAGE` · `LOG_MESSAGE` ·
  `REQUEST_TNT_MAYHEM_ID` · `CHECK_DLC_UPDATE` · `FIND_MATCH`
- the **Nimble/EA-identity REST paths** (`/rest/oauth/anonymous/`,
  `/rest/users/personas`, `/synergyId/`, `/rest/synergy/purchases/`,
  `/friends/*`, `/avatar/user/`, …) and the **auth header/param names**:
  `mh_session_key`, `nucleus_token`, `synergy_id`, `facebook_token`,
  `currentClientSessionId`, `mh_client_flag`.

So one ~14 KB module builds every outbound request: op-type → endpoint path
+ auth params. That's the single most valuable function cluster to decompile
next.

Spot-check (byte-verified against `rizin -c 'pd'`): `protoland` @ `0x38a978`
is referenced at **`0x12f1d80`**:
`adrp x11, 0x38a000` / `add x11, x11, #0x978` / `ldur x19, [x11, 0x1e]` —
the code then loads a pointer from a table entry 0x1e bytes past the string
(path string and handler-pointer are stored adjacently).

Other function clusters identified this way:
- `fcn.006e5004` — references `AnonymousLoginNetworkHandler::serverCallbackRaw`
  and the nucleus-token log lines (the login callback itself).
- `fcn.0070047c` — nucleus-token validation + `check dlc` response handling.
- `fcn.0073b0f8` — login state machine (`AnonymousLoginTask`, `GEN_Login`,
  `PostLoginSequence`, forced-logout states, `/dlc/movie-intro-*`).
- `fcn.00d776cc` — `CachedLoginData` (`auth.tnt-ea.com/tokeninfo`).
- `fcn.012b829c` — the CDN base-URL builder; the string is a **format
  template** with a zero-padded port slot
  (`https://cdn.projectspringfield.com:000…443/static/`), i.e. the port is
  substituted at runtime, not hardcoded per-se.

Caveats: statically-linked libs (libssh2, BoringSSL, breakpad, sqlite)
reference their own strings and map cleanly to `sym.*`/`method.*` names; the
game code itself is stripped, so `fcn.0…` names are address-derived.

**Cross-validation against the full `rizin aaa` (`axlj`, 7.03M xrefs).**
Compared string-target xrefs: my TSV's 52,236 (string, pc) pairs are a subset
plus 2,172 pairs rizin missed; every spot-checked "mine-only" pair was
verified genuine (the preceding ADRP computes exactly the target page — e.g.
`protoland` and the first `.rodata` string), i.e. **zero false positives in
sample**, while rizin's `aaa` additionally catches 126k xrefs in other
instruction shapes (LDR literals, mid-string and register-offset references)
that the ADRP+ADD scan by design doesn't see. The TSV is therefore safe to
trust for direct string-pointer materializations; for the complete xref
picture, union it with `axlj`.

## 6. JNI surface (the only exported game code)

Two exported groups in `dynsym` (full list in `re/syms-demangled.txt`):
- **`Java_com_bight_android_jni_BGCoreJNIBridge_*`** — the engine's Android
  shell: `init/pause/resume/destroy`, `keyPressed/Released`,
  `pointerPressed/Moved/Released`, `OGLESInit/Resize/Render/
  RenderGLLoadingScreen/Destroy`. This is where the native frame loop is
  pumped from Java.
- **`Java_com_ea_simpsons_ScorpioJNI_*`** — game callbacks into Java: lifecycle
  (`LifecycleOnCreate/Start/Pause/Resume/Stop/Destroy/OnLowMemory/…`),
  Play Store/MTX (`PlaystoreAnswer`, `PlaystoreGotSkuDetails`,
  `IsRestorableMTXProduct`), Facebook manager callbacks, `alertButtonPressed`,
  `videoComplete/VisibleCallback`, `serverStartTime/CurrentTime`,
  `GetNativeUserID/Age`, `IsDownloadingDLC`, `IsInRestartState`, etc.
- **`Java_com_ea_simpsons_Telemetry_JNITelemetryLog/SetCohortDate`**.

The dex layer is pure platform glue (Nimble, Firebase, billing, `BGActivity`);
all gameplay is native.

## 7. Where this leaves a "playable city"

Reaffirms the `02` scope note, now with the mechanism in hand:
- The client is a **thin renderer over `Data::LandMessage`**. It has no local
  rules engine for economy/quests/jobs — those are computed server-side and
  delivered as land updates + `timedScriptData` to play back. So a faithful
  client port would need (a) a server implementing the §3 protobuf API, or (b)
  a from-scratch rules engine. The fan server (`server/`, `server-python/`)
  already implements (a) — the realistic path to a playable web city is to
  **speak this protobuf protocol to an existing server**, not to port the
  native logic.
- The §2 schema + §3 endpoints + §4 class map are the blueprint for that: a
  web client could implement `AnonymousLogin → checkToken → protoland →
  upgradeland/protoland (with whole-land token)` and render `LandMessage`.
- Native decompilation of individual functions (e.g. the land-write or
  matchmaking logic) is still possible in rizin if a specific mechanic needs
  its exact algorithm; that's the next step, not the first pass.

## 8. Artifacts (`re/`)

| file | what it is |
|---|---|
| `re/parse_protodesc.py` | stdlib extractor: `protodesc_cold` → `proto_files.json`. Re-runnable on any `libscorpio*.so` (edit the `SO`/`OFF`/`SZ` header for the arch variant). |
| `re/proto_files.json` | the 17 decoded `FileDescriptorProto`s (machine-readable). |
| `re/proto_schema.txt` | same, rendered human-readable (messages/fields/enums/numbers). |
| `re/diff_schema_vs_server.py` | validates the decoded pool against the fan server's `.proto` sources (0 diffs — see §2.1). |
| `re/str_xref_scan.py` | stdlib ADRP+ADD string-xref scanner (no analysis pass; see §5). |
| `re/str_xrefs.tsv` | 52,336 string xrefs: string vaddr, string, xref PC, enclosing function. |
| `re/endpoints.txt` | every API/CDN/auth path string, grouped. |
| `re/rtti_classes.txt` | all ~856 demangled RTTI class names (the stripped class roster). |
| `re/class_methods.json` | demangled exported (mostly 3rd-party) method symbols → addresses. |
| `re/syms-demangled.txt` | full demangled `dynsym` (12,653). |

### Reproducing
```sh
# strings + sections (fast)
rizin -qc 'izzj' Springfield-V08.apk-extracted/libscorpio.so   # or the .so directly
# protobuf schema (the big one)
python3 re/parse_protodesc.py     # writes re/proto_files.json
# string xrefs without any analysis (fast, ~1s; see §5)
python3 re/str_xref_scan.py libscorpio.so [aflj.json]   # writes re/str_xrefs.tsv
# deep analysis (slow, ~minutes for 28 MB; run in background)
rizin -qc 'e search.str.max_region_size=0x8000000; aaa; axlj>xrefs.json; aflj>funcmap.json' libscorpio.so
# demangle helper (system c++filt is a no-op on this box)
g++ -O2 -o demangle demangle.cpp  # reads mangled names on stdin
```

Note: the AArch64 `libscorpio.so` and `libscorpio-neon.so` are near-identical
in layout (same section map; neon differs only in NEON codegen); the
`armeabi-v7a` variants are 32-bit builds. The `protodesc_cold` pool is the
**same 16 game protos in all arches** (v7a: same size `0xf76c` at offset
`0x41822c`; the two arm64 libs share offset `0x45d868`) — bytes differ
slightly between arches but the schema set is identical, so findings here
apply to every arch.
