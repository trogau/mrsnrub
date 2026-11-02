#!/usr/bin/env python3
"""Generate the .pb byte-layout dataset for the Byte Map page (2026-10-19).

Parses the decoded city save (mapdump/*.pb, a plain Data.LandMessage
protobuf) with byte-offset tracking, resolves every field name from the
extracted schema (re/proto_schema.txt), tags each region with how well we
understand it (see STATUS below), and writes web/js/pb-layout-data.js
(window.PBLAYOUT) — consumed by web/pb-layout.html, which renders it as a
drill-down stacked bar of the file's bytes. Same "generated inline data,
opens from file://" pattern as tools/gen_map_explorer.py.

  python3 tools/gen_pb_layout.py [city.pb] [out.js]

Stdlib only, zero network. Re-run after a new save or new RE findings,
then bump the ?v= query on js/pb-layout-data.js in web/pb-layout.html so
browsers drop the cached copy.
"""
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PB = ROOT / 'mapdump/23034074771109153854742696256123764495.pb'
SCHEMA_TXT = ROOT / 're/proto_schema.txt'
OUT = ROOT / 'web/js/pb-layout-data.js'

MAX_DEPTH = 6          # nesting depth for the child drill-down
MIN_KIDS = 48          # don't bother parsing regions smaller than this
NODE_BUDGET = 4000     # total emitted nodes (keeps the JS payload small)

# ---- RE status of each region --------------------------------------------------
# How far our reverse engineering has actually reached, keyed per message path +
# field. 'decoded' = we parse AND use the content (notes/ + tools prove it);
# 'partial' = structure understood / partially decoded; 'schema' = name known
# from the compiled proto only, content never decoded; 'unknown' = not even
# in the schema. Anything not listed under a curated message inherits:
# 'schema' when the field name is known, else 'unknown'.
STATUS_TOP = {
    1:  ('decoded',
         'Save identity — the land id string: unique town key, used as the '
         'save filename and page identity'),
    3:  ('decoded',
         'Player state — town level (939 here), XP, money, ratings and '
         'progress flags; section-by-section dump in tools/decode_land.py'),
    4:  ('partial',
         '64x64 landBlocks "0"/"1" township footprint decoded — 2,366 of '
         '4,096 blocks set (43 full rows of 40 then tapering), positioned at '
         'landBlockPosition (-3,-7); remaining 30 fields (entity counts, '
         'timers, version strings) schema-only'),
    16: ('partial',
         'Union-typed analytics counter ledger — 17 groups (one event '
         'type each), 49,309 rows; Event fields are REUSED per type: '
         '18/19/20 = job completions keyed by (jobID, buildingID) '
         '(incl. decoration collection, tax jobs), 35/39 = per-character '
         'task tallies keyed by (jobID, charID, buildID) with 39 a '
         'complete-subset mirror of 35 (63 in-progress rows only in 35), '
         '41 = consumable-inventory uses (the only place terrain brushes '
         'ever appear: Boardwalk x19, Pier x4), 16/17 = per-character '
         'counters, 161 = friend-land character visits (characterID '
         '1..64, friendLand always 1), 175 = special-event participation '
         '(arg1 = event DataID), 69/76/96/98/172 = plain aggregate '
         'counters; id fields resolve against the shared DataID '
         'namespace, -1 = not applicable; zero positional/raster data — '
         'no brush-laid tiles are recorded here (2026-10-19)'),
    5:  ('decoded',
         'Main road grid — 512x1087 tiles, one char per 16-tile run; the '
         'char->16-bit codebook was verified from libscorpio.so (notes/01); '
         '7,527 tiles filled (1.35%) in this save'),
    6:  ('decoded',
         'Rivers layer — same verified codebook; only 170 real river tiles '
         'in this save, the rest is building-adjacent speckle (notes/01)'),
    7:  ('partial',
         'Placed building instances — 5,261 records, all 15 observed '
         'fields decoded (notes/01 field audit): template DataID (2,299 '
         'distinct, fully catalogued), integral tile positions, unix '
         'creation/update stamps 2013-02..2025-01, buildState (5=done; '
         'one building at 2), 153 skins (48 variants: festive/snow/donut '
         'packs), flipState orientations, cropState stages, GoKart '
         'betting, 24 self-vandalised buildings (vandalName = own land '
         'ID); road/river keyword sweep = props only (the real two '\
          'brush-gaters OrnatePier + SquidportEntrance are both '\
          'placed); 9 schema fields never serialised'),
    8:  ('decoded',
         'Character instances — 871 citizens with names and walk paths '
         '(characterData.pathCache, notes/01); ids resolved via '
         'data/character_ids.json'),
    34: ('decoded',
         'Ocean rim grid — 512x96 tiles, same verified codebook; 1,582 '
         'tiles filled (3.2%)'),
    35: ('decoded',
         'Per-template asset ledger — 4,260 rows keyed by (type, dataId): '
         '1=Building (3,146), 2=Character (529), 6=Consumable (528), '
         '15=GameObjectBundle (57); viewed/locked flags + unlockTime '
         '2013-06..2025-01; rows survive demolition (notes/01)'),
    36: ('partial',
         'Subland (2nd land area) — 64x64 landBlocks "0"/"1" mask with only '
         '10 blocks set, plus its OWN ROADS grid (tt=2, 128 chars, ~14 '
         'tiles: bddk/m/bdh/dc clusters) on the same codebook — an 11th '
         'raster the first >=128B census missed (notes/01)'),
    43: ('decoded',
         'Per-object script key/value store (AdvancedVariableSet) — 2,205 '
         'rows {name, value, createdTime} bound to their host via serverID '
         '= EntityHeader.id; objectTypeID = building template; variable '
         'names come from the gameplay scripts (SHLevel, DonutVeinMined, '
         'Maggie/Baby anim state, battle health/battle_type); orphaned '
         'rows survive demolition (notes/01)'),
    47: ('decoded',
         'Road-kind overlays — 7 TerrainData layers (DIRT_ROADS, DIRT, '
         'COBBLESTONE, ICERIVER, KLSROAD, GOLDROAD, SAND) on the same '
         'codebook; COBBLESTONE/ICERIVER/GOLDROAD are 100% empty here'),
    53: ('partial',
         'Storage bundles — 43 stashed decoration groups {objectID, '
         'serverID, x, y, flipped, origin, stash-time (unix ms)}; 3 of 43 '
         'CARRY THEIR OWN TERRAIN PATCH: ROADS 16x48 (18 tiles, origin '
         '(32,208), ZERO objects — a pure stashed road), DIRT 32x32 (3 '
         'tiles, w/ tree+promo props), SAND 16x32 (1 tile at x=512, '
         'outside the main grid frame); patch tiles are ABSENT from the '
         'main rasters (0/18, 0/3) — stashing removes them from the 512-'
         'wide grids and preserves them here (notes/01)'),
    10: ('partial',
         'Active job queue — 519 in-progress JobData records (390 distinct '
         'job templates: Shrub01 collection jobs, NPCTicketGeneration, '
         'SpookyCabinJob); state 1=working (507), 2=ready (11); grid/'
         'subland fields never used'),
    11: ('partial',
         'Quest log — 7,268 QuestData {questID, state, timesCompleted, '
         'objectives}; state 5=done (6,837), 1=new (370), 3=active (61); '
         'includes COMPLETED PaveParadise (47) and RiverRun (48) — the '
         'pavement and river brush gates from landinfo (notes/01)'),
    12: ('partial',
         'Notification/movement history — 1,543 records {buildingID, '
         'characterID, type (2: 768), start/end XYZ, moveTime, history*}; '
         'historyQuestID always -1; no terrain data'),
    13: ('decoded',
         'Inventory — 114 item stacks {itemType, itemID, count, fromLand}; '
         'itemType 2 = brush consumables: BoardwalkDrawing x365 and '
         'PierDrawing x6 still in stock (f16 counted the 19+4 spent); '
         'permanent brushes have no rows — nothing to consume'),
    18: ('decoded',
         'Sidebar queue — 2 entries {type 0, identifier, state 4, 2025-01}: '
         'JetEngineBike_SP_Con + TwoMinutesOfHate03 promos'),
    22: ('decoded',
         'Bonus unlocks — flag entries {id 0: true, id 1: false, +6418}'),
    23: ('decoded',
         'Character unlocks — 845 unlocked character template DataIDs'),
    24: ('decoded',
         'Skin unlocks — bitfield strings: 2,119 unlocked / 2,077 received'),
    26: ('decoded',
         'Spendables — currency counters keyed by DataID (cash 3,165,590, '
         'premium tokens, event currencies)'),
    27: ('partial',
         'Special events — 40 SpecialEvent records keyed by event DataID '
         '(Tailgate_Permanent, DonutPack1, RailYard prizes, '
         'ReplaceRailyard...); variables/prize/timegate sets; the '
         'f16 type-175 arg1 events live here; no terrain grids'),
    48: ('decoded',
         'Ad-hoc object registry — 187 {header id, identifier} rows, '
         'sequential server ids (1..47, 2001, 4001, 5001..5122, '
         '6001..6118, 7001..3); ids only, no content'),
    2: ('decoded',
        'Friend/township profile — {level 939, town name trawg, XP-ish '
        'counters} + repeated {DataID, value} currency ledger (mirrors '
        'f26 spendables)'),
    28: ('decoded',
         'Fake-friend stub — placeholder {30, 5, name fields, ts 2023-12}; '
         'no real content'),
    33: ('decoded',
         'debugLand — always 0'),
    39: ('decoded',
         'Collection items — 4 memorabilia rows {id, slot, count}'),
    40: ('decoded',
         'Friend list — repeated {16-digit friend land id, flags}; the '
         'towns f16 friendLand=1 events visited'),
    41: ('decoded',
         'All-friend-actions counter — all zeros here'),
    42: ('decoded',
         'Friend-list-created flag — 1'),
    46: ('decoded',
         'Daily tasks — task {id, claim ts} sets + lastReset 2025-01; '
         'creation 2019-05'),
    49: ('decoded',
         'countryCode = "US"'),
    51: ('decoded',
         'Job census — compact per-building job census {jobData[] '
         '{jobID, characterID, instanceID}, buildingID, randSeed}'),
    52: ('decoded',
         'DNA (gameplay experiment) state — {dna id, ts, flags} + counter'),
}
# per nested message path: {field no: (status, note)}
STATUS_SUB = {
    '.Data.LandMessage.InnerLandData': {
        2: ('decoded', 'landBlocks — 64x64 "0"/"1" township footprint '
                       '(2,366 of 4,096 blocks set; pairs with '
                       'landBlockWidth/Height/PositionX/Y)'),
    },
    '.Data.LandMessage.EntityHeader': {
        1: ('decoded', 'persistent instance id — unique per placed '
                       'entity (buildings: 103 .. 1.83e9, 5,261 distinct)'),
    },
    '.Data.LandMessage.BuildingData': {
        1: ('decoded', 'EntityHeader carrying the unique instance id'),
        2: ('decoded', 'building template DataID — 2,299 distinct, all '
                       'resolved via data/save_buildings.json'),
        3: ('decoded', 'creationTime, unix seconds: 2013-02-24 (launch '
                       'era!) .. 2025-01-24; peak build month 2021-11'),
        4: ('decoded', 'updateTime, unix seconds (max 2025-01-24 — the '
                       'save\'s last activity)'),
        5: ('decoded', 'positionX float — always integral tile coord '
                       '(−48..608)'),
        6: ('decoded', 'positionY float — always integral tile coord '
                       '(−111..780)'),
        8: ('decoded', 'buildState — 5=complete in 5,260/5,261; the one '
                       'state-2 record is TutsnTotsElementary under '
                       'construction'),
        10: ('decoded', 'cropState — stage flag {1,2} on 28 '
                        'revenue/collection buildings (visual ripeness)'),
        12: ('decoded', 'betStartTime — Springfield Games GoKart race '
                        'betting; 2 active bets (GoKartTrack, Luigi)'),
        13: ('decoded', 'betChoice = 3 on both active bets'),
        16: ('decoded', 'namelen = 39 (length of the vandalName string)'),
        17: ('decoded', 'vandalName — vandalizing land\'s 39-digit id; '
                        'all 24 rows = this land itself (self-tagged, '
                        'buildings.xml <Vandalism> feature)'),
        20: ('decoded', 'skin variant DataID — 153 buildings, 48 '
                        'variants: Decorated_Festive*, snow skins '
                        '(PushingAndShoveling/TheShiftingDrifts), '
                        'DonutPacks, driving ranges'),
        22: ('decoded', 'flipState orientation variant {1:1,619, 2:92, '
                        '3:62} — default / rotated / flipped'),
        23: ('decoded', 'subLandID = 1 for all 5,261 (every building on '
                        'the main land)'),
        24: ('decoded', 'timeOfVandalism — only 3 rows kept (2020-03)'),
    },
    '.Data.LandMessage.EventCountListData': {
        2: ('decoded', 'numElements — always matches the actual row count'),
        3: ('decoded', 'one counter event; every group holds a single '
                       'event type'),
    },
    '.Data.LandMessage.EventCountListData.Event': {
        1: ('decoded', 'occurrence count (per (type, keys) row; up to '
                       '91,272 on type 18)'),
        2: ('decoded', 'event type — selects how ALL other fields are '
                       'interpreted (union semantics): 16/17 character '
                       'counters, 18/19/20 job@building, 35/39 per-'
                       'character tasks (39 ⊂ 35), 41 consumable use, '
                       '161 friend-land character visits, 175 special-'
                       'event participation, 69/76/96/98/172 plain'),
        3: ('decoded', 'job DataID (types 18/19/20/35/39) — collection, '
                       'tax, guide-panel and brush-quest tasks'),
        4: ('decoded', 'character DataID (types 35/39; -1 = n/a)'),
        5: ('decoded', 'build DataID (types 35/39; -1 = n/a)'),
        6: ('decoded', 'consumable DataID (type 41 only) — inventory-use '
                       'log; the only terrain-brush rows in f16: '
                       'Boardwalk x19, Pier x4'),
        7: ('decoded', 'DataID, meaning per type: 16/17 = character, '
                       '18/19/20 = building, 161 = -1 sentinel'),
        8: ('decoded', 'friendLand flag — 1 = event occurred on a '
                       'friend\'s land (always 1 on type 161)'),
        10: ('decoded', 'arg1 — type-175 = special-event DataID '
                        '(SpringfieldMysterySpot, SecretAgents_Event, '
                        'MultiVac, ROSAPart...); 78 = literal 1'),
    },
    '.Data.LandMessage.GroupStorageBundleMessage.GroupStorageBundle': {
        1: ('decoded', 'stashed object {objectID DataID, serverID, x, y, '
                       'flipped} — trees, IncomeTax/NewFrontier/DonutVein '
                       'props, BF2016 promo items'),
        2: ('decoded', 'bundled TERRAIN PATCH — present on 3 of 43 '
                       'bundles; tiles removed from the main rasters at '
                       'stash time'),
        3: ('decoded', 'world-tile origin X of the stash (32, 240, 512 '
                       'observed — 512 is outside the main grid!)'),
        4: ('decoded', 'world-tile origin Y (-80 observed) — patch '
                       'placement offset'),
        5: ('decoded', 'stash timestamp, unix ms (2024-06..2024-10)'),
    },
    '.Data.LandMessage.GroupStorageBundleMessage.GroupStorageBundle.GroupStorageBundleRoadMap': {
        1: ('decoded', 'subLandID = 1 (main land)'),
        2: ('decoded', 'patch width in tiles (16/32/16)'),
        3: ('decoded', 'patch height in tiles (48/32/32)'),
        4: ('decoded', 'TerrainData {mapDataSize, mapData, terrainType} — '
                       'tt 2=ROADS, 6=DIRT, 12=SAND here'),
    },
    '.Data.LandMessage.InventoryItemData': {
        2: ('decoded', 'itemType — 0 = decoration inventory (112 rows), '
                       '2 = brush consumables (2 rows)'),
        3: ('decoded', 'item DataID — incl. BoardwalkDrawing (5000) x365 '
                       'and PierDrawing (139000) x6 in stock'),
        4: ('decoded', 'stack count'),
        7: ('decoded', 'fromLand — origin land of gifted/spent items'),
        8: ('decoded', 'source string length (source omitted)'),
    },
    '.Data.LandMessage.QuestData': {
        2: ('decoded', 'quest DataID — PaveParadise (47) and RiverRun '
                       '(48) both COMPLETED: the landinfo gates that '
                       'unlock pavement and river brushes'),
        3: ('decoded', 'state — 5=done (6,837), 1=new (370), 3=active (61)'),
        7: ('decoded', 'times completed'),
    },
    '.Data.LandMessage.JobData': {
        2: ('decoded', 'job DataID — 390 distinct (Shrub01, '
                       'NPCTicketGeneration, SpookyCabinJob, cheap-housing '
                       'event jobs...)'),
        3: ('decoded', 'character instance ref'),
        4: ('decoded', 'building instance ref'),
        6: ('decoded', 'state — 1=working (507), 2=ready (11)'),
    },
    '.Data.LandMessage.NotificationData': {
        4: ('decoded', 'notification type — 2 dominant (768/1,543)'),
        21: ('decoded', 'historyQuestID — always -1 in this save'),
    },
    '.Data.LandMessage.SpecialEventsData.SpecialEvent': {
        1: ('decoded', 'event DataID — Tailgate_Permanent, DonutPack1, '
                       'RailYard_PrizeTrack_Prize5_SPECIAL, '
                       'ReplaceRailyard, ScriptRunner, GlobalVariables...'),
    },
    '.Data.LandMessage.AdHocObjectData': {
        2: ('decoded', 'server-assigned sequential identifier'),
    },
    '.Data.LandMessage.TerrainData': {
        3: ('decoded', 'mapData grid string (1 char = 16 tiles)'),
        4: ('decoded', 'terrainType enum 1..12 (PAVEMENT..SAND); bundle/'
                       'subland patches carry it too'),
    },
    '.Data.LandMessage.GameObjectInfo': {
        1: ('decoded', 'EntityHeader (id 36856 in this save)'),
        2: ('decoded', 'ledger entries — 4,260 in this save'),
    },
    '.Data.LandMessage.GameObjectInfo.GameObject': {
        1: ('decoded', 'asset DataID within its category catalog'),
        2: ('decoded', 'category: 1 building, 2 character, 6 consumable, '
                       '15 GameObjectBundle'),
        3: ('decoded', 'unlock time (2013-06 .. 2025-01 here)'),
        4: ('decoded', 'locked — set on 6 preview/unreleased consumables'),
        5: ('decoded', 'viewed-in-UI flag (3,000 set)'),
    },
    '.Data.ObjectVariables': {
        1: ('decoded', 'the variable set (2,205 rows in this save)'),
    },
    '.Data.AdvancedVariableSet.AdvancedVariable': {
        1: ('decoded', 'variable name from the gameplay scripts (SHLevel, '
                       'DonutVeinMined, State, health, 0..3, …)'),
        2: ('decoded', 'string-encoded value (int/enum, e.g. 0, 1, Forward)'),
        3: ('decoded', 'created time (2019-04 .. 2025-01 here)'),
        4: ('schema', 'ttl — never set in this save'),
        5: ('decoded', 'host object class: unset=building, 3=battle/'
                       'numeric-name vars'),
        6: ('decoded', 'host EntityHeader.id (serverID); 0 = land-level'),
        7: ('decoded', "host's building template id (-1 for class 3)"),
        8: ('decoded', 'orphaned — host demolished, row kept (241 here)'),
        9: ('decoded', 'canBeOrphaned flag (1,521 set)'),
        10: ('schema', 'scope — never set in this save'),
        11: ('decoded', 'host subland id (4294967295 = not applicable)'),
    },
}

WT_NAME = {0: 'varint', 1: 'fixed64', 2: 'bytes', 5: 'fixed32'}

# ---- TerrainData grid analysis -------------------------------------------------
# notes/01 "The char -> 16-bit codebook" — verified from libscorpio.so decoder
# 0x11a6288: a..p = one tile at x=k (mask 1<<k), P = all 16 (0xFFFF),
# G and anything else = 0. TerrainType enum names from notes/01.
TERRAIN_TYPES = {
    1: 'PAVEMENT', 2: 'ROADS', 3: 'RIVERS', 4: 'KRUSTYLAND_ROADS',
    5: 'OCEAN', 6: 'DIRT', 7: 'DIRT_ROADS', 8: 'COBBLESTONE', 9: 'ICERIVER',
    10: 'KLSROAD', 11: 'GOLDROAD', 12: 'SAND',
}


def char_mask(ch):
    """16-bit tile mask a mapData char writes, or None if the decoder ignores
    it. 'G' is the known empty filler (record stays zero => mask 0)."""
    o = ord(ch)
    if 0x61 <= o <= 0x70:
        return 1 << (o - 0x61)
    if o == 0x50:
        return 0xFFFF
    if o == 0x47:
        return 0
    return None


# Brush items (f35 type-6 ledger) that paint each RoadMap layer — cross-referenced
# against <RoadEntry consumableName=..><SaveInfo map=.. savedType=../> in
# landinfo.xml (2026-10-19). The landinfo map= attr is the authoritative
# brush -> physical-grid storage: pavement tiles live INSIDE the main road
# grid (savedType=pavement), and boardwalk/pier tiles are stored in the OCEAN
# grid — which is why those two layers never appear in roadMapList. TerrainType
# 6/7 map to landinfo 'dirtriver'/'dirt' respectively (drawer kind + the
# 170-char DIRT fill matching the river fill confirm the enum names are
# swapped vs the config). State text is this save's ledger + layer content.
BRUSHES = {
    1:  ('PavementDrawing (3)',
         'unlocked — pavement has no own layer: tiles share the main road '
         'grid (landinfo SaveInfo map=road savedType=pavement)'),
    2:  ('RoadDrawing (2)', 'unlocked here — brush uses are invisible to '
         'f16 (type 41 logs consumable-inventory items only); grid would '
         'also store pavement tiles, none drawn in this save'),
    3:  ('RiverDrawing (4)', 'unlocked here — permanent brush, no f16 '
         'use events either way (river fill is scatter, notes/01)'),
    5:  ('BoardwalkDrawing (5000) + PierDrawing (139000)',
         'unlocked — stored in this ocean grid (landinfo SaveInfo '
         'map=ocean); f16 counters show 19 boardwalk + 4 pier uses'),
    6:  ('DirtRiverDrawing (145015)', 'unlocked here — landinfo map=dirtriver'),
    7:  ('DirtRoadDrawing (145014)', 'unlocked here — landinfo map=dirt'),
    8:  ('CobblestoneDrawing (163100)', 'unlocked, never painted'),
    9:  ('IceRiverDrawing (188026)', 'LOCKED here — layer empty'),
    10: ('KrustylandSpringfieldPath (4266)',
         'unlocked here — 16 connector tiles'),
    11: ('GoldRoadDrawing (179000)', 'LOCKED here — layer empty'),
    12: ('SandDrawing (281002)', 'unlocked here'),
}


def guess_w(chars):
    """Char-grid width for layers without explicit dimensions: largest
    divisor <= sqrt(n) (main layers override with the verified 32)."""
    for w in range(int(chars ** 0.5), 0, -1):
        if chars % w == 0:
            return w
    return 32


def grid_detail(s, tt=None, hid=None, mds=None, pool=None):
    """Analysis of one mapData grid string: char histogram with codebook
    masks, tiles-filled ratio, first filled chars, size cross-check, plus
    the char grid itself (pooled into D.grids) and its tile width."""
    hist = {}
    for c in s:
        hist[c] = hist.get(c, 0) + 1
    chars = len(s)
    tiles = 0
    rows = []
    unknown = 0
    for c, n in sorted(hist.items(), key=lambda kv: -kv[1]):
        m = char_mask(c)
        if m is None:
            unknown += n
        else:
            tiles += n * bin(m).count('1')
        rows.append({'c': c, 'n': n, 'm': m})
    runs = []
    for idx, c in enumerate(s):
        if c != 'G':
            runs.append([idx, c])
            if len(runs) >= 8:
                break
    # tile width: main layers are verified 512 tiles wide (32 chars) —
    # notes/01 "Main-grid geometry" (34,784 = 32 x 1087, 1087 prime);
    # ocean rim 3,072 = 32 x 96. Others: best guess, labelled as such.
    if chars == 34784:
        w, wn = 32, '512 tiles wide x 1087 rows — verified (notes/01)'
    elif chars == 3072:
        w, wn = 32, '512 tiles wide x 96 rows (ocean rim)'
    else:
        w = guess_w(chars)
        wn = 'width assumed: %d chars (%d tiles wide)' % (w, w * 16)
    d = {
        'tt': tt, 'ttn': TERRAIN_TYPES.get(tt, '?') if tt is not None else None,
        'hid': hid,
        'mds': mds, 'len': chars,
        'sizeOk': (mds == chars) if mds is not None else None,
        'tiles': tiles, 'tileTotal': chars * 16,
        'fill': round(100.0 * tiles / max(chars * 16, 1), 3),
        'nonG': chars - hist.get('G', 0), 'unknown': unknown,
        'hist': rows[:24], 'runs': runs,
        'w': w, 'wn': wn,
    }
    if pool is not None:
        d['g'] = pool(s)
    return d


def terrain_detail(buf, b0, b1, pool=None):
    """Grid analysis of one TerrainData region (notes/01 verified codebook).
    None if the region doesn't parse as TerrainData-shaped data."""
    vals = {}
    i = b0
    while i < b1:
        try:
            tag, i = read_varint(buf, i)
        except IndexError:
            return None
        field, wt = tag >> 3, tag & 7
        if wt == 0:
            v, i = read_varint(buf, i)
            vals[field] = v
        elif wt == 2:
            ln, i = read_varint(buf, i)
            if i + ln > b1:
                return None
            vals[field] = buf[i:i + ln]
            i += ln
        else:
            return None
    grid = vals.get(3)
    if not isinstance(grid, bytes):
        return None
    hdr_id = None
    if isinstance(vals.get(1), bytes):
        try:
            hdr_id, _e = read_varint(vals[1], 0)   # EntityHeader.id (field 1)
        except IndexError:
            pass
    return grid_detail(grid.decode('latin1'), tt=vals.get(4), hid=hdr_id,
                       mds=vals.get(2), pool=pool)


# ---- schema extraction ---------------------------------------------------------

def load_schema(path):
    """re/proto_schema.txt -> {message path: {field no: {name,type,tpath}}}.

    The file lists 'message LandMessage' / 'message LandMessage.FriendData'
    blocks with 'optional|repeated <type> <name> = N  // .full.Path' fields.
    """
    msgs = {}
    cur = None
    stack = {}          # indent -> message path
    msg_re = re.compile(r'^(\s*)message\s+([\w.]+)\s*$')
    fld_re = re.compile(
        r'^(\s*)(optional|repeated|required)\s+(\w+)\s+(\w+)\s*=\s*(\d+)'
        r'(?:\s*//\s*(\S+))?')
    for line in path.read_text(encoding='utf-8', errors='replace').splitlines():
        if not line.strip() or line.lstrip().startswith('//'):
            continue
        m = msg_re.match(line)
        if m:
            indent, name = len(m.group(1)), m.group(2)
            path_name = '.Data.' + name if '.' in name or indent else name
            if '.' not in path_name:
                path_name = '.Data.' + path_name
            stack = {k: v for k, v in stack.items() if k < indent}
            stack[indent] = path_name
            cur = msgs.setdefault(path_name, {})
            continue
        m = fld_re.match(line)
        if m and cur is not None:
            indent, _, ftype, fname, fno, tpath = m.groups()
            fno = int(fno)
            if tpath and not tpath.startswith('.'):
                tpath = None
            cur[fno] = {'name': fname, 'type': ftype, 'tpath': tpath}
    return msgs


# ---- byte-tracking parse -------------------------------------------------------

def read_varint(buf, i):
    v = 0
    s = 0
    while True:
        b = buf[i]
        i += 1
        v |= (b & 0x7F) << s
        s += 7
        if not (b & 0x80):
            return v, i


def parse_spans(buf, off, end):
    """(field, wt, hdr_off, body_off, body_end) per occurrence or None."""
    out = []
    i = off
    n = 0
    while i < end:
        n += 1
        if n > 2_000_000:
            return None
        hdr = i
        try:
            tag, i = read_varint(buf, i)
        except IndexError:
            return None
        field, wt = tag >> 3, tag & 7
        if field == 0 or field > 4095 or wt not in (0, 1, 2, 5):
            return None
        if wt == 0:
            v0 = i
            try:
                _, i = read_varint(buf, i)
            except IndexError:
                return None
            body = (v0, i)
        elif wt == 2:
            try:
                ln, body_off = read_varint(buf, i)
            except IndexError:
                return None
            if body_off + ln > end:
                return None
            i = body_off + ln
            body = (body_off, i)
        elif wt == 5:
            if i + 4 > end:
                return None
            body = (i, i + 4)
            i += 4
        else:
            if i + 8 > end:
                return None
            body = (i, i + 8)
            i += 8
        out.append((field, wt, hdr, body[0], body[1]))
    return out if i == end else None


def probable_string(buf, off, end):
    if off >= end:
        return True
    chunk = buf[off:end]
    if b'\x00' in chunk:
        return False
    return sum(1 for b in chunk if 9 <= b < 127) / len(chunk) >= 0.95


class Builder:
    def __init__(self, buf, schema):
        self.buf = buf
        self.schema = schema
        self.nodes = 0        # emitted nodes only (parsing is not capped)
        self.grids = []       # pooled mapData strings (det['g'] -> index)
        self.gpool = {}

    def _pool(self, s):
        i = self.gpool.get(s)
        if i is None:
            i = len(self.grids)
            self.gpool[s] = i
            self.grids.append(s)
        return i

    def build(self, off, end, msg_path, depth, top_level=False):
        """Aggregate message node: group field occurrences by field number."""
        spans = parse_spans(self.buf, off, end)
        if spans is None:
            return None
        fields_def = self.schema.get(msg_path, {})
        groups = {}
        order = []
        for field, wt, hdr, b0, b1 in spans:
            g = groups.get(field)
            if g is None:
                g = groups[field] = {'wt': wt, 'cnt': 0, 'size': 0,
                                     'hdr': hdr, 'b0': b0, 'b1': b1,
                                     'spans': []}
                order.append(field)
            g['cnt'] += 1
            g['size'] += b1 - hdr
            g['b1'] = b1
            g['spans'].append((hdr, b0, b1))
        kids = []
        for field in order:
            g = groups[field]
            fdef = fields_def.get(field)
            name = fdef['name'] if fdef else None
            tpath = fdef['tpath'] if fdef else None
            wt = g['wt']
            hdr, b0, b1 = g['hdr'], g['b0'], g['b1']
            node = {'f': field, 'n': name,
                    'wt': WT_NAME[wt], 'off': hdr,
                    'end': b1, 'size': g['size'], 'cnt': g['cnt']}
            st, note = self.status(msg_path, field, top_level, fdef)
            node['st'] = st
            if note:
                node['note'] = note
            if wt == 2:
                sub_path = tpath or (msg_path + '.' + name if name else msg_path)
                is_str = probable_string(self.buf, b0, b1)
                by_type = bool(fdef) and fdef['type'] == 'message'
                if (depth < MAX_DEPTH
                        and (by_type or (b1 - b0 >= MIN_KIDS and not is_str))):
                    # try message parse: use FIRST occurrence for structure,
                    # aggregate child sizes across all occurrences
                    first = parse_spans(self.buf, b0, b1)
                    if first is not None and self.nodes < NODE_BUDGET:
                        kid = self.build_children(g['spans'], sub_path, depth)
                        if kid is not None:
                            node['kids'] = kid
                            node['wt'] = 'message'
                            if g['cnt'] > 1:
                                node['agg'] = True
                            if sub_path.endswith('.TerrainData'):
                                dets = [terrain_detail(self.buf, s0, s1,
                                                        pool=self._pool)
                                        for (_h, s0, s1) in g['spans'][:8]]
                                dets = [d for d in dets if d]
                                if dets:
                                    node['det'] = dets[0] if len(dets) == 1 else dets
                if 'kids' not in node:
                    if is_str and (not fdef or fdef['type'] != 'bytes'):
                        node['wt'] = 'string'
                        s = self.buf[b0:b1].decode('latin1')
                        node['sample'] = s[:60] + ('…' if len(s) > 60 else '')
                    else:
                        node['wt'] = 'bytes'
            kids.append(node)
        self.nodes += len(kids)
        if self.nodes > NODE_BUDGET:
            raise OverflowError
        return kids

    def build_children(self, spans, sub_path, depth):
        """Aggregate children over every occurrence of a repeated message."""
        agg = {}
        order = []
        ok_first = None
        for (hdr, b0, b1) in spans:
            sub = parse_spans(self.buf, b0, b1)
            if sub is None:
                return None
            if ok_first is None:
                ok_first = (b0, b1)
            for field, wt, sh, sb0, sb1 in sub:
                a = agg.get(field)
                if a is None:
                    agg[field] = a = {'wt': wt, 'cnt': 0, 'size': 0,
                                      'hdr': sh, 'b0': sb0, 'b1': sb1,
                                      'spans': []}
                    order.append(field)
                a['cnt'] += 1
                a['size'] += sb1 - sh
                a['spans'].append((sh, sb0, sb1))
        # build from aggregated groups (structure of first occurrence order)
        fields_def = self.schema.get(sub_path, {})
        buf = self.buf
        kids = []
        for field in order:
            a = agg[field]
            fdef = fields_def.get(field)
            name = fdef['name'] if fdef else None
            tpath = fdef['tpath'] if fdef else None
            node = {'f': field, 'n': name, 'wt': WT_NAME[a['wt']],
                    'off': a['hdr'], 'end': a['b1'], 'size': a['size'],
                    'cnt': a['cnt']}
            st, note = self.status(sub_path, field, False, fdef)
            node['st'] = st
            if note:
                node['note'] = note
            if a['wt'] == 2:
                s0, e0 = a['spans'][0][1], a['spans'][0][2]
                sub_path2 = tpath or (sub_path + '.' + name if name else sub_path)
                is_str = probable_string(buf, s0, e0)
                by_type = bool(fdef) and fdef['type'] == 'message'
                if (depth + 1 < MAX_DEPTH
                        and (by_type or (e0 - s0 >= MIN_KIDS and not is_str))
                        and self.nodes < NODE_BUDGET):
                    kid = self.build_children(a['spans'], sub_path2, depth + 1)
                    if kid is not None:
                        node['kids'] = kid
                        node['wt'] = 'message'
                        if a['cnt'] > 1:
                            node['agg'] = True
                        if sub_path2.endswith('.TerrainData'):
                            dets = [terrain_detail(buf, s0, s1, pool=self._pool)
                                    for (_h, s0, s1) in a['spans'][:8]]
                            dets = [d for d in dets if d]
                            if dets:
                                node['det'] = dets[0] if len(dets) == 1 else dets
                if 'kids' not in node:
                    if is_str and (not fdef or fdef['type'] != 'bytes'):
                        node['wt'] = 'string'
                        s = buf[s0:e0].decode('latin1')
                        node['sample'] = s[:60] + ('…' if len(s) > 60 else '')
                        if field == 3 and sub_path.endswith('.TerrainData'):
                            node['det'] = grid_detail(s, pool=self._pool)
                    else:
                        node['wt'] = 'bytes'
            kids.append(node)
        if sub_path.endswith('.GroupStorageBundleRoadMap'):
            # the only grids with explicit dimensions (notes/01 proof table)
            k4 = next((k for k in kids if k['f'] == 4 and k.get('det')), None)
            a2, a3 = agg.get(2), agg.get(3)
            if (k4 and a2 and a3 and a2['wt'] == 0 and a3['wt'] == 0):
                dets = k4['det'] if isinstance(k4['det'], list) else [k4['det']]
                if len(dets) == len(a2['spans']) == len(a3['spans']):
                    for i, x in enumerate(dets):
                        try:
                            tx = read_varint(buf, a2['spans'][i][1])[0]
                            ty = read_varint(buf, a3['spans'][i][1])[0]
                        except IndexError:
                            continue
                        if tx % 16 == 0:
                            x['w'] = tx // 16
                            x['wn'] = '%d×%d tiles (explicit)' % (tx, ty)
                        if i == 0:
                            k3 = next((k for k in (k4.get('kids') or [])
                                       if k['f'] == 3 and k.get('det')
                                       and not isinstance(k['det'], list)), None)
                            if k3 and tx % 16 == 0:
                                k3['det']['w'] = tx // 16
                                k3['det']['wn'] = ('%d×%d tiles (explicit,'
                                                   ' first occurrence)' % (tx, ty))
        if sub_path.endswith('.TerrainData'):
            # give the mapData child its parent's terrainType / size context
            k3 = next((k for k in kids if k['f'] == 3 and k.get('det')), None)
            if k3:
                def _v(fno):
                    a = agg.get(fno)
                    if not a or a['wt'] != 0:
                        return None
                    try:
                        return read_varint(buf, a['spans'][0][1])[0]
                    except IndexError:
                        return None
                det = k3['det']
                det['tt'] = _v(4)
                if det['tt'] is not None:
                    det['ttn'] = TERRAIN_TYPES.get(det['tt'], '?')
                det['mds'] = _v(2)
                a1 = agg.get(1)
                if a1 and a1['wt'] == 2:
                    try:
                        _t, e = read_varint(buf, a1['spans'][0][1])
                        det['hid'] = read_varint(buf, e)[0]
                    except IndexError:
                        pass
                if det['mds'] is not None:
                    det['sizeOk'] = det['mds'] == det['len']
        self.nodes += len(kids)
        if self.nodes > NODE_BUDGET:
            raise OverflowError
        return kids

    def status(self, msg_path, field, top_level, fdef):
        if top_level and field in STATUS_TOP:
            return STATUS_TOP[field]
        sub = STATUS_SUB.get(msg_path)
        if sub and field in sub:
            return sub[field]
        if fdef:
            return ('schema', '')
        return ('unknown', 'not in extracted schema')


def main(argv):
    pb = Path(argv[0]) if argv else PB
    out = Path(argv[1]) if len(argv) > 1 else OUT
    buf = pb.read_bytes()
    schema = load_schema(SCHEMA_TXT)
    b = Builder(buf, schema)
    top = b.build(0, len(buf), '.Data.LandMessage', 0, top_level=True)
    if top is None:
        print('FATAL: file does not parse as a protobuf message to EOF',
              file=sys.stderr)
        return 1
    # annotate grid dets with their controlling brush (f35 ledger + landinfo
    # SaveInfo cross-ref, see BRUSHES)
    def annotate(node):
        dets = node.get('det')
        if dets is not None:
            for x in (dets if isinstance(dets, list) else [dets]):
                br = BRUSHES.get(x.get('tt'))
                if br:
                    x['bn'] = br[0]
                    x['bs'] = br[1]
        for k in node.get('kids', []):
            annotate(k)
    for k in top:
        annotate(k)
    total = sum(k['size'] for k in top)
    by_status = {}
    for k in top:
        by_status[k['st']] = by_status.get(k['st'], 0) + k['size']
    data = {
        'file': pb.name,
        'size': len(buf),
        'sha256': hashlib.sha256(buf).hexdigest()[:16],
        'fields': len(top),
        'topBytes': total,
        'byStatus': by_status,
        'root': top,
        'grids': b.grids,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        '/* GENERATED by tools/gen_pb_layout.py — do not hand-edit.\n'
        '   Byte-layout of %s (%d bytes, sha256 %s…). Rebuild:\n'
        '   python3 tools/gen_pb_layout.py\n'
        '   Consumed by web/pb-layout.html (Byte Map). */\n'
        'window.PBLAYOUT = %s;\n'
        % (pb.name, len(buf), data['sha256'][:8],
           json.dumps(data, separators=(',', ':'))))
    print('%s: %d bytes, %d top-level fields, %d nodes, %d KB js -> %s'
          % (pb.name, len(buf), len(top), b.nodes,
             out.stat().st_size // 1024, out))
    for st in ('decoded', 'partial', 'schema', 'unknown'):
        if st in by_status:
            print('  %-8s %9d B  %5.1f%%' % (st, by_status[st],
                                             100.0 * by_status[st] / total))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
