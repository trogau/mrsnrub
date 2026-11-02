#!/usr/bin/env python3
"""Which saved coordinate structures leak which terrain layers?

Test: for each candidate coordinate set in the save (walk-path waypoints,
idle character positions, job grid anchors) compute the overlap with every
decoded terrain layer and the lift over a random-placement baseline. A set
with high lift on dirt/dirtroad/klsroad/river is a candidate stroke oracle.

Usage: python3 tools/layer_oracle.py [file.pb]
"""
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

OX, OY = 12, 136          # legacy grid offset (ocean frame only now)
CELL_OX, CELL_OY = -48, -112   # town tile of cell (0,0), notes/01
CELL_STRIDE = 37
AREA = 592 * 944          # land cell grid extent (148x236 cells x 16 tiles)


def cells(data):
    """TOWN tile sets from a mapData string.

    CORRECTED 2026-10-19 (notes/01 "Terrain grids: CELL semantics"):
    land layers are 4x4-tile CELL grids (16-byte blocks, 37 blocks per
    row); each non-'G' char covers the 16 town tiles
    [CELL_OX+4col,+4) x [CELL_OY+4row,+4) — the char value is a
    neighbour nibble, not a tile offset. The 3072-char ocean
    sea-patch keeps the legacy column-major per-tile frame (reciprocity
    0.87), anchored offshore west of the town frame (seaColOffset -33
    + legacy (12,136) town shift)."""
    if isinstance(data, str):
        data = data.encode('latin-1')
    out = set()
    if len(data) == 3072:
        for idx, b in enumerate(data):
            c = chr(b)
            if c == 'G':
                continue
            col, yb = divmod(idx, 32)
            mk = 0xFFFF if c == 'P' else (1 << (ord(c) - 97)
                                          if 'a' <= c <= 'p' else 0)
            for k in range(16):
                if mk >> k & 1:
                    out.add((col - 33 - OX, yb + k - OY))
        return out
    for off, b in enumerate(data):
        c = chr(b)
        if c == 'G':
            continue
        blk, k = divmod(off, 16)
        col = (blk % CELL_STRIDE) * 4 + k % 4
        row = (blk // CELL_STRIDE) * 4 + k // 4
        x0, y0 = CELL_OX + 4 * col, CELL_OY + 4 * row
        for dy in range(4):
            for dx in range(4):
                out.add((x0 + dx, y0 + dy))
    return out


def report(label, pts, layers):
    pts = set(pts)
    print(f"\n{label}: {len(pts)} unique grid points")
    for name, g in layers.items():
        if not g:
            print(f"  {name:9s}: layer empty")
            continue
        ov = len(pts & g)
        exp = len(pts) * len(g) / AREA
        lift = ov / exp if exp else 0.0
        print(f"  {name:9s}: cells={len(g):6d}  overlap={ov:5d}  "
              f"random-exp={exp:7.1f}  lift={lift:8.1f}x")


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        ROOT, 'mapdump/23034074771109153854742696256123764495.pb')
    m = P.LandMessage()
    m.ParseFromString(open(path, 'rb').read())

    rml = list(m.roadMapDataMessage.roadMapList)
    layers = {
        'road':     cells(m.roadsData.mapData),
        'river':    cells(m.riversData.mapData),
        'ocean':    cells(m.oceanData.mapData),
        'dirtroad': cells(rml[0].mapData) if len(rml) > 0 else set(),
        'dirt':     cells(rml[1].mapData) if len(rml) > 1 else set(),
        'klsroad':  cells(rml[4].mapData) if len(rml) > 4 else set(),
        'sand':     cells(rml[6].mapData) if len(rml) > 6 else set(),
    }

    # layers are TOWN-tile sets (see cells()); candidate point sets are
    # already town tiles, so no grid shift any more (was t2g +12,+136 —
    # a legacy-frame relic; mod-4 lattice phases are unaffected since
    # 12 and 136 are both multiples of 4)
    def t2g(p):
        return p

    # 1. walk-path waypoints (the known road oracle)
    wp = set()
    for c in m.characterData:
        for v in c.pathCache.vector:
            wp.add(t2g((int(round(v.x)), int(round(v.y)))))
    report('walk-path waypoints (pathCache)', wp, layers)

    # 2. idle character positions
    ip = set()
    for c in m.characterData:
        ip.add(t2g((int(round(c.positionX)), int(round(c.positionY)))))
    report('idle character positions', ip, layers)

    # 3. job grid anchors (if this save populates them)
    jp = set()
    for j in m.jobData:
        if j.hasGrid:
            jp.add((j.gridPositionX, j.gridPositionY))
    if jp:
        report('job grid anchors (JobData.hasGrid)', jp, layers)
    else:
        print(f"\njob grid anchors: none set ({len(m.jobData)} jobs, 0 hasGrid)")

    # lattice split of the walk oracle: does the OFF-lattice remainder ride
    # the non-road layers?
    off = {p for p in wp if not (p[0] % 4 == 3 or p[1] % 4 == 0)}
    report(f'walk waypoints OFF the road lattice ({len(off)})', off, layers)


if __name__ == '__main__':
    main()
