#!/usr/bin/env python3
"""Generate web/js/map-explorer-data.js from the city save + data catalogs.

Inputs (all project-local):
  mapdump/<save>.pb            decoded LandMessage (terrain + placed objects)
  data/save_buildings.json     id -> {name, x, z, locX, locY, height, via}
  data/building_ids.json       id -> {name, asset, slug}
  data/building_footprints.json  slug -> {x, z, locX, locY, height}
  data/flip_assets.json        name -> {SE,SW,NE,NW: asset} (directional fences)
  data/character_ids.json      id -> name

Output:
  web/js/map-explorer-data.js  (window.MAP_DATA = {...}, ~0.6 MB, no network)

Per-instance footprint dims use the same rules as the verified static
renders (mapdump/renders/city_map.jpg, downtown_zoom.jpg) and
notes/01-binary-formats.md ("Footprint rect + flipState semantics"):

  rect tiles  X: [posX - locX + 1, posX - locX + x]
              Y: [posY - locY + 1, posY - locY + z]

  directional fences: flipState 0..3 selects the nameFlip{SE,SW,NE,NW}
  asset (SE/NW variants swap x/z when only the base xml exists);
  monorail StraightTrack (109500): fs=1 uses the ...flipped asset (2x4).

The terrain layers embed the raw mapData strings; the page decodes them
with the verified codebook (a..p -> one tile at offset c-'a', G -> none,
P -> all 16) on a 512-wide grid, town = grid - (12, 136).
"""
import glob
import json
import os
import sys
import types
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'server-python'))

fake = types.ModuleType('google.protobuf.runtime_version')
fake.PROTOBUF_VERSION = (4, 21, 12)
fake.ValidateProtobufRuntimeVersion = lambda *a, **k: None


class _Domain:
    PUBLIC = 1


fake.Domain = _Domain
sys.modules['google.protobuf.runtime_version'] = fake

from protofiles import LandData_pb2 as P  # noqa: E402

# ---- load catalogs -----------------------------------------------------------
saveb = json.load(open(os.path.join(ROOT, 'data/save_buildings.json')))
bids = json.load(open(os.path.join(ROOT, 'data/building_ids.json')))
foot = json.load(open(os.path.join(ROOT, 'data/building_footprints.json')))
flip = json.load(open(os.path.join(ROOT, 'data/flip_assets.json')))
cids = json.load(open(os.path.join(ROOT, 'data/character_ids.json')))

# ---- load save ---------------------------------------------------------------
pb_path = sorted(glob.glob(os.path.join(ROOT, 'mapdump/*.pb')))[0]
m = P.LandMessage()
m.ParseFromString(open(pb_path, 'rb').read())
print(f'save: {os.path.basename(pb_path)}')
print(f'buildings: {len(m.buildingData)}  characters: {len(m.characterData)}')

# Sprite manifest keys, needed by dims_for/variant_for (art that ships).
try:
    SPRITE_KEYS = set(json.load(
        open(os.path.join(ROOT, 'web/assets/city/city-sprites.json')))['sprites'])
except (OSError, ValueError):
    SPRITE_KEYS = set()

# flipState -> facing direction.  Re-derived 2026-10-25 from this save's
# IronRailing enclosure under the SHIPPED camera orientation
# (CAM.ORIENT fx=1, fy=-1, swap=1: +X runs upper-right, +Y lower-right).
# Chain geometry pins the footprint pair: fs 0/2 pieces step along X at
# spacing 2 and must be the x=2 variants (se/nw art, rise-right slope);
# fs 1/3 step along Y and must be the z=2 variants (sw/ne art).  Which
# member of each pair the enclosure picks follows from which boundary the
# fence stands on (bsv3 anchors): the y=76 side (faces +Y, lower-right)
# needs the art anchored bottom-left (se), the y=53 side the same slope
# drawn behind the pivot (nw), the x=116 side (faces -X, lower-left) the
# art anchored bottom-right (sw), the x=159 side its behind-pivot twin
# (ne).  Hence 0=SE, 1=SW, 2=NW, 3=NE.  (The original .rodata-order
# guess had 2/3 swapped, drawing those runs 90 deg off.)
FLIPDIR = {0: 'SE', 1: 'SW', 2: 'NW', 3: 'NE'}
TRACK_IDS = (109500, 109501, 109512, 109514)


def dims_for(bid, fs):
    """Per-instance (x, z, locX, locY) — same rules as render_map_v2.py."""
    e = saveb.get(str(bid))
    if not e:
        return (2.0, 2.0, 1.0, 1.0)
    x, z = float(e['x']), float(e['z'])
    lx, ly = float(e.get('locX') or 1), float(e.get('locY') or 1)
    nm = e['name']
    fl = flip.get(nm)
    if fl:  # directional fence: pick variant by flipState
        slug = fl.get(FLIPDIR.get(fs, 'SE'), list(fl.values())[0]).lower()
        fp = foot.get(slug) or foot.get(slug.replace('_', ''))
        if fp:
            return (fp['x'], fp['z'], fp.get('locX') or 1, fp.get('locY') or 1)
        base = foot.get(slug[:-2])
        if base:
            if FLIPDIR.get(fs) in ('SE', 'NW') and base['x'] != base['z']:
                return (base['z'], base['x'], base.get('locX') or 1, base.get('locY') or 1)
            return (base['x'], base['z'], base.get('locX') or 1, base.get('locY') or 1)
    if bid == 109500 and fs == 1:  # monorail straight: flipped asset
        fp = foot.get('trackstraight4x2flipped')
        if fp:
            return (fp['x'], fp['z'], fp.get('locX') or 1, fp.get('locY') or 1)
    # Odd flipState on a non-directional asset = the engine's "flipped"
    # placement, which carries the <slug>flipped TWIN's semantics: its
    # footprint XML swaps x/z and locX/locY (verified on 939 shipped twin
    # pairs).  The save proves the engine applies this even when no twin
    # art ships — every asymmetric-footprint twin-less asset chains at the
    # SWAPPED spacing (PurpleHouse 7x6 rows step X by 6, WhiteHouse 6x4 by
    # 4, Flowers02 1x3 by 3, HorseTrough/FrontierFence/TireFence 2x1 cols
    # step Y by 2, KrustylandTurnstile 2x4 by 2).  fs 2/3 never occur on
    # these — they belong to the directional fence families handled above.
    if fs & 1:
        slug = (bids.get(str(bid)) or {}).get('slug') or nm.lower()
        if (slug + 'flipped') in SPRITE_KEYS:
            fp = foot.get(slug + 'flipped')
            if fp:
                return (fp['x'], fp['z'], fp.get('locX') or 1,
                        fp.get('locY') or 1)
        return (z, x, ly, lx)
    return (x, z, lx, ly)


# ---- town crop (same as city_map.jpg) ----------------------------------------
OX, OY = 12, 136
TX0, TX1, TY0, TY1 = -70, 630, -145, 800
S = 2
GW, GH = (TX1 - TX0) * S, (TY1 - TY0) * S

layers = [
    ('ocean', m.oceanData.mapData, [30, 92, 158]),
    ('sand', m.roadMapDataMessage.roadMapList[6].mapData, [223, 206, 138]),
    ('dirt', m.roadMapDataMessage.roadMapList[1].mapData, [150, 112, 70]),
    ('river', m.riversData.mapData, [92, 150, 220]),
    ('road', m.roadsData.mapData, [92, 92, 98]),
    ('dirtroad', m.roadMapDataMessage.roadMapList[0].mapData, [132, 96, 60]),
    ('klsroad', m.roadMapDataMessage.roadMapList[4].mapData, [176, 158, 128]),
]

# ---- brush tiles on the OCEAN grid (boardwalk / pier) -------------------------
# landinfo SaveInfo routes BoardwalkDrawing + PierDrawing into the OCEAN grid
# (map="ocean"), and f34 oceanData holds nothing else: it is NOT a wave-mark
# frame. Re-decoded 2026-10-28 (notes/09 §12): the 3,072 chars are the same
# 4x4-cell codebook as the 34,784-char layers (16 chars = one block of 4x4
# cells, byte k -> cell row k//4, col k%4; 'P' solid, 'a'..'p' = E1 W2 N4 S8
# neighbour mask), 3 blocks per row x 64 rows. E/W/N/S mask reciprocity is
# exactly 1.000 at stride 3 (6: 0.98, 12: 0.94, the old column-major per-tile
# read: 0.87). Cell (c, r) covers TOWN tiles [OCEAN_CELL_OX + 4c, +4) x
# [OCEAN_CELL_OY + 4r, +4): the land's own block pin (-3, -7) x 16. Checked
# on the deck furniture: SquidportEntrance 132/144 footprint tiles on brush
# cells, FerrisWheel 15/15, both Boardwalk tents, BoardwalkBench; the
# MetalBoardwalkRailing row sits on the deck's end edge (y 124).
# The save merges both brushes into this one grid, so the type is recovered
# from connectivity. Pier tiles must connect to the OrnatePier building (the
# brush's gate), but not everything touching it is pier: the OrnatePier block
# is a solid 'P' slab (boardwalk) holding two 1-cell walkways. So connectivity
# is the MASK graph — two masked cells link only when both name each other
# (E/W, N/S bits) — and pier = every walkway chain with a tile on or beside
# the OrnatePier footprint (this save: the 19-cell spiral whose end cell lies
# under the building). Everything else is boardwalk: the 'P' slabs, the
# 36-cell walkway that never reaches the gate, the Squidport deck, the
# PirateShip dock and the BarnacleBayMarina jetty (mask-0 'a' cells).
OCEAN_CELL_OX, OCEAN_CELL_OY, OCEAN_BLOCKS_W = -48, -112, 3


def _ocean_cells(data):
    out = {}
    for i, ch in enumerate(data):
        if ch == 'G':
            continue
        blk, k = divmod(i, 16)
        by, bx = divmod(blk, OCEAN_BLOCKS_W)
        out[(bx * 4 + k % 4, by * 4 + k // 4)] = ch
    return out


def _mask_chains(cells):
    """walkway chains: masked (non-'P') cells joined where BOTH masks name
    each other (E1 W2 N4 S8, y grows south); 'P' cells are left out"""
    link = {1: (1, 0, 2), 2: (-1, 0, 1), 4: (0, -1, 8), 8: (0, 1, 4)}

    def mask(k):
        ch = cells.get(k)
        return None if ch is None or ch == 'P' else ord(ch) - 97

    seen, chains = set(), []
    for k in sorted(cells):
        if mask(k) is None or k in seen:
            continue
        seen.add(k)
        st, cur = [k], []
        while st:
            c, r = st.pop()
            cur.append((c, r))
            mk = mask((c, r))
            for bit, (dx, dy, opp) in link.items():
                q = (c + dx, r + dy)
                mq = mask(q)
                if mk & bit and mq is not None and mq & opp and q not in seen:
                    seen.add(q)
                    st.append(q)
        chains.append(cur)
    return chains


def _cell_tiles(comp):
    return [(OCEAN_CELL_OX + 4 * c + dx, OCEAN_CELL_OY + 4 * r + dy)
            for c, r in comp for dy in range(4) for dx in range(4)]


_pier_gate = set()                      # OrnatePier footprint (town tiles)
for b in m.buildingData:
    if (saveb.get(str(b.building)) or {}).get('name') != 'OrnatePier':
        continue
    px, py = int(round(b.positionX)), int(round(b.positionY))
    x, z, lx, ly = dims_for(b.building, b.flipState)
    for dy in range(int(z)):
        for dx in range(int(x)):
            _pier_gate.add((px - lx + 1 + dx, py - ly + 1 + dy))
_ocells = _ocean_cells(m.oceanData.mapData)
_pier_cells = set()
for chain in _mask_chains(_ocells):
    if any((x + dx, y + dy) in _pier_gate for x, y in _cell_tiles(chain)
           for dx in (-1, 0, 1) for dy in (-1, 0, 1)):
        _pier_cells.update(chain)
_pr = _cell_tiles(sorted(_pier_cells))
_bw = _cell_tiles(sorted(k for k in _ocells if k not in _pier_cells))
print('ocean brush tiles: boardwalk %d, pier %d (OrnatePier footprint %d tiles)'
      % (len(_bw), len(_pr), len(_pier_gate)))

# extra layers with pre-decoded pts (GRID coords = town + (OX, OY), the frame
# terrain.js subtracts for every pts layer); one entry per tile, which is
# what the per-tile brush art (pier-tiles.json) draws.
brush_layers = [
    {'n': 'boardwalk', 'c': [190, 140, 90],
     'pts': [v for x, y in sorted(_bw, key=lambda t: (t[1], t[0]))
             for v in (x + OX, y + OY)]},
    {'n': 'pier', 'c': [126, 110, 96],
     'pts': [v for x, y in sorted(_pr, key=lambda t: (t[1], t[0]))
             for v in (x + OX, y + OY)]},
]

# ---- per-instance building rects ---------------------------------------------
# Directional-variant sprite (fences/walls/balconies): the flip_assets.json
# variant for the instance's flipState, kept only when its art actually
# ships in the sprite manifest (City View consumes it as row col 8; None ->
# the old base/flipped pick). dims_for already resolved the footprint.


def variant_for(bid, fs):
    e = saveb.get(str(bid))
    if not e:
        return None
    fl = flip.get(e['name'])
    if not fl:
        return None
    slug = fl.get(FLIPDIR.get(fs, 'SE'), list(fl.values())[0]).lower()
    return slug if slug in SPRITE_KEYS else None


cnt = Counter(b.building for b in m.buildingData)
buildings = []
for b in m.buildingData:
    bid = b.building
    px, py = int(round(b.positionX)), int(round(b.positionY))
    x, z, lx, ly = dims_for(bid, b.flipState)
    row = [bid, px - lx + 1, py - ly + 1, x, z, b.flipState, px, py]
    v = variant_for(bid, b.flipState)
    if v:
        row.append(v)
    buildings.append(row)

binfo = {}
for bid, e in saveb.items():
    a = bids.get(bid, {})
    binfo[bid] = [
        e['name'],
        a.get('asset'),
        a.get('slug'),
        e['x'], e['z'],
        e.get('locX'), e.get('locY'),
        e.get('height'),
        e['via'],
        cnt.get(int(bid), 0),
    ]

# ---- sprite variants index -----------------------------------------------------
# Several building assets ship more than one sprite: the main art, a
# <slug>_transimage sidecar (per-pixel alpha helper, notes/06), a
# <slug>_menu build-menu thumbnail, <slug>_holo event variants, and
# flipped copies. The explorer pages show them as a thumbnail strip in
# the building details card, so index every image that belongs to an
# asset's slug. Sources: the CDN manifest (web/assets/manifest.json)
# plus the composites in web/assets/city/ (generated by
# gen_city_sprites.py, not listed in the manifest). The manifest ships
# every CDN file once per device tier and revision, so keep ONE
# representative per slug+kind: best family first (main `game` pack,
# then other event packs, then menu packs), highest tier, largest px.
KIND_BY_SUFFIX = {
    '_transimage': 'transimage',
    '_menu': 'menu',
    '_holo': 'holo',
    '_flipped': 'flipped',
    '': 'sprite',
}
# Representative ranking per (slug, kind): city composites (full-res bsv3
# composites) win, then the main `game` pack, then other event packs, then
# menu packs (base menu pack beats seasonal menu reskins); within a rank,
# largest w first.
FAMILY_RANK = {'game': 1}          # others default to 2, menu packs 3


def _fam_rank(e):
    fam = (e.get('family') or '')
    if fam in FAMILY_RANK:
        return FAMILY_RANK[fam]
    return 3 if fam.startswith('menu') or 'menu' in fam else 2


# (slug, kind) -> (sort-key, entry). A file belongs to slug S if its stem
# is S or S plus one of the known suffixes.
SUFFIXES = [s for s in KIND_BY_SUFFIX if s]


def _split(stem):
    """(slug, kind) for a file stem, or None if not a known variant form."""
    for suf in SUFFIXES:
        if stem.endswith(suf):
            return stem[:-len(suf)] or None, KIND_BY_SUFFIX[suf]
    return stem, 'sprite'


try:
    _man = json.load(open(os.path.join(ROOT, 'web/assets/manifest.json')))
except (OSError, ValueError):
    _man = {'files': []}

_city_dir = os.path.join(ROOT, 'web/assets/city')
_city_pngs = set(
    f[:-4] for f in os.listdir(_city_dir) if f.endswith('.png')
) if os.path.isdir(_city_dir) else set()


def _add(slug, kind, path, w, h, res, rank):
    key = (rank, -(w or 0), path)
    slot = _cand.get((slug, kind))
    if slot is None or key < slot[0]:
        _cand[(slug, kind)] = (key, {'path': path, 'kind': kind,
                                     'w': w, 'h': h, 'res': res})


_cand = {}
for e in _man['files']:
    if e.get('type') != 'image' or not e.get('path'):
        continue
    stem = os.path.basename(e['path'])[:-4].lower()
    slug, kind = _split(stem)
    if not slug:
        continue
    _add(slug, kind, e['path'], e.get('w'), e.get('h'),
         e.get('resClass'), _fam_rank(e))

for stem in _city_pngs:
    slug, kind = _split(stem)
    if not slug:
        continue
    _add(slug, kind, 'city/' + stem + '.png', None, None,
         'city', 0 if kind == 'sprite' else 2)

KIND_ORDER = ['sprite', 'transimage', 'menu', 'holo', 'flipped', 'anim']
try:
    _anims_meta = json.load(open(os.path.join(
        ROOT, 'web/assets/city/city-anims.json')))['anims']
except (OSError, ValueError, KeyError):
    _anims_meta = {}
variants = {}
for bid, e in bids.items():
    slug = (e.get('slug') or e.get('asset') or '').lower()
    if not slug or slug in variants:
        continue
    rows = [_cand[(slug, k)][1] for k in KIND_ORDER if (slug, k) in _cand]
    # bsv3 named-anim filmstrips (tools/gen_city_sprites.py anims): played
    # in-place by the details card, so no manifest deep link is offered
    for a in _anims_meta.get(slug) or []:
        row = {'path': 'city/' + a['png'], 'kind': 'anim',
               'name': a['anim'], 'frames': a['frames'],
               'cols': a['cols'], 'cellw': a['cellw'],
               'cellh': a['cellh'], 'fps': a['fps'],
               'ax': a.get('ax'), 'ay': a.get('ay')}
        if a.get('sparse') and a.get('sub'):
            # sparse shelf: the card player blits per-frame rects from the
            # packed atlas (see the 'sub' handler in asset-variants.js)
            row['sub'] = a['sub']
        rows.append(row)
    if rows:
        variants[slug] = rows
print(f'variants: {len(variants)} assets with extra sprites '
      f'(tree01: {[r["kind"] for r in variants.get("tree01", [])]})')

chars = [[c.character, round(c.positionX, 3), round(c.positionY, 3)]
         for c in m.characterData]
seen = {c[0] for c in chars}
char_names = {cid: nm for cid, nm in cids.items() if int(cid) in seen}

# ---- cached walk paths (notes/06 "Walk-path oracle") --------------------------
# characterData.pathCache = the client's own cached walk polylines (a
# VectorFloatArray of integer town (x,y) waypoints). Characters only walk
# on streets, so ~90% of the segments ride the UNSAVED template road grid
# (columns x=3 mod 4, rows y=0 mod 4 in grid coords) — they leak the
# invisible network. Deduped: many characters replay identical paths.
walks = []
_wseen = set()
for c in m.characterData:
    pts = []
    for v in c.pathCache.vector:
        p = (int(round(v.x)), int(round(v.y)))
        if not pts or pts[-1] != p:
            pts.append(p)
    if len(pts) < 2:
        continue
    key = tuple(pts)
    if key in _wseen:
        continue
    _wseen.add(key)
    walks.append([v for p in pts for v in p])   # flat [x0,y0,x1,y1,...] town

data = {
    'ox': OX, 'oy': OY,
    'tx0': TX0, 'ty0': TY0, 's': S, 'gw': GW, 'gh': GH,
    'grass': [74, 128, 66],
    'pal': [[216, 216, 224], [198, 150, 120], [150, 182, 212], [212, 202, 150],
            [172, 150, 192], [150, 192, 162], [214, 170, 150], [182, 182, 192],
            [202, 160, 172], [160, 172, 202]],
    'trackcol': [120, 120, 128],
    'charcol': [255, 224, 70],
    'tracks': list(TRACK_IDS),
    'layers': [{'n': n, 'c': c, 's': s} for n, s, c in layers] + brush_layers,
    # building instance: [id, x0, y0, w, h, flipState, posX, posY,
    #                     variantSlug?] (town tiles; col 8 present only for
    #                     directional flip_assets.json names whose variant art ships)
    'buildings': buildings,
    # binfo[id] = [name, asset, slug, x, z, locX, locY, height, via, count]
    'binfo': binfo,
    # slug -> extra sprites of that asset, ordered [sprite, transimage,
    # menu, holo, flipped, anim] (one representative per kind — highest
    # family rank, then largest). Each: {path, kind, w, h, res}; path is
    # relative to web/assets/, so asset pages open it as assets/<path>.
    # kind 'anim' rows instead carry {path, kind, name, frames, cols,
    # cellw, cellh, fps} — a bsv3 filmstrip atlas played in place by the
    # card player — plus 'sub' (per-frame rect lists) when the strip is
    # sparse-packed (tools/gen_city_sprites.py _pack_sparse).
    # details card. Consumed by web/js/asset-variants.js (Map Explorer +
    # City View details cards).
    'variants': variants,
    # character instance: [id, x, y] (town tiles)
    'chars': chars,
    'charNames': char_names,
    # cached client walk paths (characterData.pathCache), deduped:
    # each entry a flat [x0, y0, x1, y1, ...] integer TOWN list. Consumed
    # by web/js/walks.js (City View "walk paths" overlay + street census).
    'walks': walks,
    'downtown': [(-40, 180, -80, 175)],  # X0, X1, Y0, Y1 (town tiles)
}

out = os.path.join(ROOT, 'web/js/map-explorer-data.js')
with open(out, 'w') as f:
    f.write('/* GENERATED by tools/gen_map_explorer.py — do not edit by hand.\n')
    f.write(f'   Source save: {os.path.basename(pb_path)} '
            f'({len(buildings)} buildings, {len(chars)} characters). */\n')
    f.write('window.MAP_DATA = ')
    json.dump(data, f, separators=(',', ':'))
    f.write(';\n')
print(f'wrote {out} ({os.path.getsize(out) // 1024} KB)')
print(f'  layers: {[l[0] for l in layers]}')
print(f'  binfo: {len(binfo)} ids, chars: {len(chars)}, char names: {len(char_names)}')
