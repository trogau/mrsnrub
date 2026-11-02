#!/usr/bin/env python3
"""Diff two city saves (Data.LandMessage .pb) — brush-stroke locator.

Purpose (notes/01 "riversData is building-adjacent scatter"): the save
stores player brush terrain ONLY as per-layer codebook rasters, so the
way to prove where a brush actually persists — and whether this repo's
snapshot simply predates a placement — is a controlled experiment:
place a distinctive stroke in-game, capture the new save, and diff.
Every cell that appears in the newer save names its persistence layer
directly (f5 roads, f6 rivers, roadMapList[i], subland/bundle grids);
entries that appear anywhere else (buildingData, quests, ...) show up
in the structural sections instead.

Usage:
  python3 tools/save_diff.py OLD.pb NEW.pb

Exit 0 always (a report, not an assertion). Text output is designed to
be pasted into the notes.
"""
import os
import sys
import types
import collections

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

TYPE_NAMES = {1: 'PAVEMENT', 2: 'ROADS', 3: 'RIVERS', 4: 'KRUSTYLAND_ROADS',
              5: 'OCEAN', 6: 'DIRT', 7: 'DIRT_ROADS', 8: 'COBBLESTONE',
              9: 'ICERIVER', 10: 'KLSROAD', 11: 'GOLDROAD', 12: 'SAND'}


def load(path):
    m = P.LandMessage()
    m.ParseFromString(open(path, 'rb').read())
    return m


CELL_STRIDE = 37                  # verified (notes/01 cell semantics)
CELL_OX, CELL_OY = -48, -112      # town tile of cell (0,0)


def cells(data):
    """{(town_x, town_y): char} for a mapData string.

    CORRECTED 2026-10-19 (road-spec.json verified, notes/01 "Terrain
    grids: cell semantics"): 34784-char land layers are cell grids —
    16 bytes per 4x4-tile block, CELL_STRIDE blocks per row; a non-'G'
    char is one cell at town tile (CELL_OX+4col, CELL_OY+4row), 'P'
    solid, 'a'..'p' neighbour nibble E=1,W=2,N=4,S=8. Keying by char
    (not by expanded tile set) so mask-only edits inside one cell still
    diff. The 3072-char ocean sea-patch keeps the legacy per-tile frame
    (reciprocity 0.87, not a cell codebook): chars are expanded to
    their 16 grid tiles, town-adjusted by the legacy (12,136) offset."""
    if isinstance(data, str):
        data = data.encode('latin-1')
    out = {}
    if len(data) == 3072:
        for idx, b in enumerate(data):
            c = chr(b)
            if c == 'G':
                continue
            gx, gy = idx % 32, idx // 32
            for k in range(16):
                out[(gx * 16 + k - 12, gy - 136)] = c
        return out
    for off, b in enumerate(data):
        c = chr(b)
        if c == 'G':
            continue
        blk, k = divmod(off, 16)
        col = (blk % CELL_STRIDE) * 4 + k % 4
        row = (blk // CELL_STRIDE) * 4 + k // 4
        out[(CELL_OX + 4 * col, CELL_OY + 4 * row)] = c
    return out


def terrain_layers(m):
    """label -> TerrainData, for every grid the save can carry."""
    out = {'f5.roadsData': m.roadsData, 'f6.riversData': m.riversData,
           'f34.oceanData': m.oceanData}
    for i, td in enumerate(m.roadMapDataMessage.roadMapList):
        out[f'roadMapList[{i}].{TYPE_NAMES.get(td.terrainType, td.terrainType)}'] = td
    for si, sl in enumerate(m.subLandData):
        for j, td in enumerate(sl.terrainData):
            sid = sl.subLandID if sl.HasField('subLandID') else si
            out[f'subLand[{sid}].terrainData[{j}]'
                f'.{TYPE_NAMES.get(td.terrainType, td.terrainType)}'] = td
    for bi, b in enumerate(m.groupStorageBundleMessage.groupStorageBundle):
        for j, r in enumerate(b.groupStorageBundleRoadMap):
            td = r.terrainData
            out[f'bundle[{bi}].roadMap[{j}]'
                f'.{TYPE_NAMES.get(td.terrainType, td.terrainType)}'
                f'@{b.originPosX},{b.originPosY}'] = td
    return out


def diff_terrain(a, b):
    la, lb = terrain_layers(a), terrain_layers(b)
    for key in sorted(set(la) | set(lb)):
        ta, tb = la.get(key), lb.get(key)
        if ta is None or tb is None:
            print(f'  ~ layer {key}: present only in '
                  f'{"NEW" if ta is None else "OLD"}')
            continue
        ca, cb = cells(ta.mapData), cells(tb.mapData)
        if ca == cb:
            continue
        added = {k: v for k, v in cb.items() if k not in ca}
        removed = {k: v for k, v in ca.items() if k not in cb}
        changed = {k: (ca[k], cb[k]) for k in set(ca) & set(cb)
                   if ca[k] != cb[k]}
        print(f'  * layer {key} ({TYPE_NAMES.get(tb.terrainType)}): '
              f'+{len(added)} / -{len(removed)} cells'
              + (f' / ~{len(changed)} nibbles' if changed else ''))
        for label, s in (('added', added), ('removed', removed)):
            if s:
                head = ', '.join(f'({x},{y})={c}'
                                 for (x, y), c in sorted(s.items())[:40])
                print(f'      {label}: {head}'
                      + (' ...' if len(s) > 40 else ''))
        if changed:
            head = ', '.join(f'({x},{y}) {o}->{n}'
                             for (x, y), (o, n) in sorted(changed.items())[:40])
            print(f'      changed: {head}'
                  + (' ...' if len(changed) > 40 else ''))


def buildings_key(b):
    return (b.building, int(round(b.positionX)), int(round(b.positionY)),
            b.flipped if b.HasField('flipped') else 0)


def diff_buildings(a, b):
    names = {}
    try:
        import json
        raw = json.load(open(os.path.join(ROOT, 'data', 'building_ids.json')))
        names = {int(k): (v.get('name') if isinstance(v, dict) else str(v))
                 for k, v in raw.items()}
    except Exception:
        pass
    sa = {buildings_key(x) for x in a.buildingData}
    sb = {buildings_key(x) for x in b.buildingData}
    for label, s in (('added', sorted(sb - sa)), ('removed', sorted(sa - sb))):
        if s:
            print(f'  * buildings {label}: {len(s)}')
            for bid, x, y, fl in s[:40]:
                print(f'      id={bid} ({names.get(bid, "?")}) at ({x},{y})'
                      + (' flipped' if fl else ''))
            if len(s) > 40:
                print(f'      ... {len(s) - 40} more')


def diff_counts(a, b):
    fields = [
        ('buildingData', lambda m: len(m.buildingData)),
        ('characterData', lambda m: len(m.characterData)),
        ('jobData', lambda m: len(m.jobData)),
        ('questData', lambda m: len(m.questData)),
        ('inventoryItemData', lambda m: len(m.inventoryItemData)),
        ('consumableData', lambda m: len(m.consumableData)),
        ('adHocObjectData', lambda m: len(m.adHocObjectData)),
        ('timedScriptData', lambda m: len(m.timedScriptData)),
        ('delayedActionData', lambda m: len(m.delayedActionData)),
        ('collectionItemsData', lambda m: len(m.collectionItemsData)
         if hasattr(m, 'collectionItemsData') else 0),
    ]
    for name, f in fields:
        try:
            na, nb = f(a), f(b)
        except Exception:
            continue
        if na != nb:
            print(f'  * {name}: {na} -> {nb}')


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        return
    a, b = load(sys.argv[1]), load(sys.argv[2])
    print(f'OLD={sys.argv[1]}\nNEW={sys.argv[2]}\n')
    print('== terrain grid diffs (brush persistence lands here) ==')
    diff_terrain(a, b)
    print('== buildingData (props/decorations persist here) ==')
    diff_buildings(a, b)
    print('== top-level count changes ==')
    diff_counts(a, b)
    print('== raw size ==')
    print(f'  {os.path.getsize(sys.argv[1])} -> {os.path.getsize(sys.argv[2])} bytes')


if __name__ == '__main__':
    main()
