#!/usr/bin/env python3
"""cell_find.py — locate which bytes of a city save encode given tile cells.

Purpose (notes/01): when another renderer shows terrain at coordinates
where our decoded layer says 'G' (empty), this tool answers "where do
THOSE pixels come from?" by checking the claimed cells against every
length-delimited codebook string in the raw .pb.

The layout hypotheses were reduced 2026-10-19 by the verification in
notes/01 "Terrain grids: cell semantics" (road-spec.json cross-check):
34784-char terrain layers are 4x4-tile CELL grids — 16 bytes per block
(byte k -> cell row k//4, col k%4), 37 blocks per row; a non-'G' char
is one cell, 'P' = solid, 'a'..'p' = neighbour nibble E=1,W=2,N=4,S=8.
Cell (col,row) covers town tiles [CELL_OX+4col,+4) x [CELL_OY+4row,+4)
with CELL_OX/OY = -48/-112 (InnerLandData landBlockPosition x 16).
Reciprocity of the nibbles is exactly 1.000 at stride 37 for every
land layer, so that layout is not a hypothesis any more — it is proven.
The legacy per-tile hypotheses (stride-32 rows / stride-1087 columns,
1 char = a 16-tile run) are retained ONLY because the 3072-char ocean
sea-patch still decodes that way (its reciprocity is 0.87, not a cell
codebook).

Usage:
  python3 tools/cell_find.py mapdump/CITY.pb --cells "120,12 116,20" \
      [--layer f6]

--cells takes town-tile coordinates (same convention as the City View
hover readout and markers textarea). Every string field >= 200 bytes is
tested: for each claimed cell the byte at the hypothesised index must
NOT be 'G' (the codebook empty char). A hypothesis surviving all cells
is printed with its file offset; "NONE" means the claimed cells are not
encoded by any codebook string in the file (the renderer is sourcing
them from outside the .pb, or from non-codebook bytes).
"""
import os
import re
import sys
import types
from collections import namedtuple

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

CELL_STRIDE = 37                  # verified blocks per block-row
CELL_OX, CELL_OY = -48, -112      # town tile of cell (0,0)
GRID_W, GRID_H = 512, 1087        # legacy per-tile frame (ocean only)
Hypo = namedtuple('Hypo', 'name fn')

MASK_BITS = ('E', 'W', 'N', 'S')


def cell_index(tx, ty, ox=CELL_OX, oy=CELL_OY):
    """Byte index of the cell covering town tile (tx,ty)."""
    col = (tx - ox) // 4
    row = (ty - oy) // 4
    return ((row // 4) * CELL_STRIDE + col // 4) * 16 + (row % 4) * 4 + col % 4


def cell_of(tx, ty, ox=CELL_OX, oy=CELL_OY):
    return (tx - ox) // 4, (ty - oy) // 4


def describe(ch):
    """Human-readable meaning of a cell char under the cell codebook."""
    if ch == 'G':
        return 'G empty'
    if ch == 'P':
        return 'P solid'
    m = ord(ch) - 97
    if 0 <= m <= 15:
        return f"{ch} mask={''.join(b for i, b in enumerate(MASK_BITS) if m >> i & 1) or '-'}"
    return f"{ch} ?"


def hypotheses():
    """Layout hypotheses: idx = fn(tx, ty) on claimed TOWN tiles."""
    return [
        Hypo('cell-codebook stride37 (VERIFIED, notes/01)',
             lambda tx, ty: cell_index(tx, ty)),
        Hypo('legacy per-tile row-major stride32 (ocean frame)',
             lambda tx, ty: ((ty + 136) * GRID_W + tx + 12) // 16),
        Hypo('legacy per-tile col-major stride1087 (ocean frame)',
             lambda tx, ty: ((tx + 12) * GRID_H + ty + 136) // 16),
    ]


def walk_strings(raw, min_len=200):
    """Yield (file_offset, bytes) for every maximal run of codebook chars
    (G, P, a..p) of length >= min_len. Terrain grids in this format are
    purely codebook chars (verified by histogram), so regex runs find
    them all; over/under-inclusion at the edges only means an index
    shift, which the layout hypotheses tolerate or reject."""
    pat = re.compile(rb'[GPabcdefghijklmnop]{%d,}' % min_len)
    for mm in pat.finditer(raw):
        yield mm.start(), mm.group(0)


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return
    path = args[0]
    cells, layer = [], None
    i = 1
    while i < len(args):
        a = args[i]
        if a == '--cells':
            i += 1
            nums = [int(t) for t in re.findall(r'-?\d+', args[i])]
            cells = list(zip(nums[0::2], nums[1::2]))
        elif a == '--layer':
            i += 1
            layer = args[i]
        i += 1
    if not cells:
        print(__doc__)
        return

    raw = open(path, 'rb').read()
    print(f'claimed town tiles: {cells}')
    print(f'as cells (col,row): {[cell_of(x, y) for x, y in cells]}\n')

    m = P.LandMessage()
    m.ParseFromString(raw)

    # Known layers first, decoded with the verified cell codebook, for a
    # baseline report.
    known = {'f5': m.roadsData, 'f6': m.riversData, 'f34': m.oceanData}
    for idx, td in enumerate(m.roadMapDataMessage.roadMapList):
        known[f'rm[{idx}]t{td.terrainType}'] = td
    print('== baseline: verified cell decode at those tiles ==')
    print('   (ocean f34 uses the legacy per-tile frame — chars there are'
          ' not cell masks)')
    for name, td in known.items():
        if layer and name != layer:
            continue
        s = td.mapData
        if isinstance(s, str):
            s = s.encode('latin-1')
        vals = []
        for tx, ty in cells:
            i2 = cell_index(tx, ty)
            vals.append(chr(s[i2]) if i2 < len(s) else '-')
        mark = ' <-- has content' if any(v not in 'G-' for v in vals) else ''
        print(f'  {name:12} {"".join(vals)}{mark}')
        if any(v not in 'G-' for v in vals):
            detail = '; '.join(f'({tx},{ty})={describe(v)}'
                               for (tx, ty), v in zip(cells, vals) if v != 'G')
            print(f'               {detail}')

    print('\n== brute force: any string where all claimed tiles are non-G ==')
    hyps = hypotheses()
    hits = 0
    for off, blob in walk_strings(raw):
        for h in hyps:
            ok = True
            for tx, ty in cells:
                idx2 = h.fn(tx, ty)
                if idx2 >= len(blob) or blob[idx2] == 0x47:
                    ok = False
                    break
            if ok:
                # require it not be trivially all-non-G
                g_count = blob.count(b'G')
                if g_count / len(blob) > 0.2:
                    hits += 1
                    chars = ''.join(chr(blob[h.fn(tx, ty)])
                                    for tx, ty in cells if h.fn(tx, ty) < len(blob))
                    print(f'  HIT off={off} len={len(blob)} '
                          f'layout={h.name} chars={chars}')
    if not hits:
        print('  NONE — no codebook-like string in the file encodes all '
              'claimed tiles. The other renderer is sourcing them from '
              'outside this .pb (template XML, another capture, or its '
              'own generation).')


if __name__ == '__main__':
    main()
