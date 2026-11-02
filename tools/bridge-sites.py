#!/usr/bin/env python3
"""Derive where the engine paints road bridges, straight from the save.

The rule this tool implements is measured on the full-resolution export at
three crossings and cross-checked against the shipped art
(tools/fit-bridge.py scores candidate placements of each bsv3 cell;
tools/render-bridge.py composites them over the export; the periodicity and
lamppost-lattice measurements are in notes/09 §10 and
mapdump/registration/m4-bridge-*.png):

  * a road is a 4-tile corridor on the save's 4x4 CELL lattice — a +y (N-S)
    road occupies columns [cx, cx+3] with cx % 4 == 0 (measured 156 at site A,
    224 at site D), a +x (E-W) road rows [cy, cy+3] with cy % 4 == 0 (site B,
    48);
  * the road and water layers are INDEPENDENT occupancy sets, so a crossing
    shows up as water tiles UNDER the deck tiles: the water band is the set of
    corridor rows (or columns) the water layer covers across the full 4-tile
    corridor. That one test is also what excludes a quay that merely runs
    alongside the road — water touches those from the side, never under them.
    In this save 179 road tiles touch water, 112 of them sit on it, and only
    11 stretches fill a whole corridor; the span rule below keeps 3;
  * PIECES. bridgetop frame 4 (C_BridgeTop_08) is a three-lamppost section:
    piers with arch openings, the deck line, and a balustrade, hanging 75 px
    BELOW the deck line — the piece that stands in water. (Frames 5 / 2 / 6 /
    3 are the abutment-length and grass-abutment variants; the export's bank
    ends show the plain deep deck, so the rule uses f4 throughout unless
    --grass is given.)
  * ONE SECTION PER ROAD CELL (re-measured 2026-10-27). The game builds each
    row from separate sections, one per 4x4 road cell over water, butt-joined
    4 tiles apart: 110 px globe pitch inside a section and 2 x 110 + 36 = 256
    art px = 4 tiles per section, so the screenshot shows DOUBLED lampposts at
    every join. The section's pivot sits on the cell's far edge along the road
    (y = cy + 4 for a +y road; the bridgetop footprint is 2 x 4 with its pivot
    on the max-y corner like every building). Measured by globe detection on
    the screenshot registered against the Pixi viewer: all 12 globes at site A
    and all 12 at site B land within 0.1 tile of this rule. (The previous
    model stepped overlapping pieces by one globe pitch, which gives evenly
    spaced lampposts the game never shows.)
  * ROWS. Two rows, one per side of the carriageway, on the same along
    position: near row pivot ROW = -0.6 tiles off a +y corridor's west edge,
    far row ROW_SEP = 4.5 further. A +x corridor is the mirror image about
    the cell, (a, b) -> (4 - b, 4 - a): pivot on the cell's min-x edge, rows
    at cy + 4.6 and cy + 0.1 (exactly the earlier independent fit at B). The
    viewer draws the row nearer the viewer OVER the road art and the far row
    UNDER it (the crossing cells' road art is raised between the two);
  * +x roads draw the MIRRORED instance (the viewer's flip state);
  * BANKS: the road must reach both sides of the water — the fully-road run has
     to extend past the band at both ends. A band that IS the whole run is a
     road END sitting on the water, and 7 of the 11 raw candidates are exactly
     that: one real crossing read on the other axis (a N-S road's water strip
     is 4 columns wide, so it also looks like an E-W road of the same width,
     and the "corridor" of that reading is only the crossing patch itself);
  * MIN_SPAN: the band must at least be as wide as the road is (>= CELL = 4).
     A band exactly that wide is an inlet mouth — in this save the only one
     is the inlet at cols 252..255, rows 48..51 — and gets the one section
     per row its single cell implies. `--min-span 5` drops it.

The tool prints the crossings it finds and the placement list, so a placement
can be dropped straight into tools/render-bridge.py --place for a visual check
against the export, and so the same rule can be mirrored in the Pixi viewer
(web/viewer/city-view-pixi.js "road bridges" pass), which derives the
placements itself at runtime. --check gates every candidate on the export
itself showing bridge stone/lamp pixels inside that crossing's footprint: 11
band candidates -> 3 bridges, exactly the three the eye test accepts.

    python3 tools/bridge-sites.py                # whole town
    python3 tools/bridge-sites.py --check --place          # export-gated
    python3 tools/bridge-sites.py --json /tmp/opencode/bridges.json
    python3 tools/bridge-sites.py --near 172,48 --radius 25 --place
"""
import argparse
import json
import math
import os

import numpy as np

OCC = '/tmp/opencode/occ.json'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOT = os.path.join(ROOT, 'Tapped Out - Simpsons_Screenshot-2025-01-17--19-12-02.png')
ROAD_W = 4                 # road corridors are one cell wide (4 tiles)
CELL = 4                   # save cell lattice
ART_S = 64                 # art px per ground tile (city-sprites.json)
ROW = -0.6                 # near row pivot, tiles off the corridor's west edge
ROW_SEP = 4.5              # far row ROW_SEP further (A, B, D fits)
MIN_SPAN = 4               # water must at least be as wide as the road itself

DEEP = ('bridgetop', 4)    # C_BridgeTop_08: piers in the water
BANK = ('bridgetop', 2)    # + C_Grass_04 bank at the tail end
FILLET = ('bridgetop', 6)  # + C_Grass_03 fillet at the head end
BOTH = ('bridgetop', 3)    # both grasses: one section IS the bridge
GRASS_ENDS = False         # True = grass-abutment frames on the end sections
                           # (the viewer's __CV_BRIDGES({grassEnds:true}) twin)


def bridge_run(axis, c, a, b):
    """Every piece of one crossing: one section per 4x4 road cell the water
    band [a, b] covers, per row, both rows on the same along position, for
    the corridor whose west (+y) or north (+x) edge is `c`. Mirrored for +x,
    exactly like the viewer's bridgeRun."""
    c0, c1 = a & ~3, b & ~3
    segs = []
    for cc in range(c0, c1 + 1, CELL):
        top = DEEP
        if GRASS_ENDS:
            tail = cc == c0 if axis == 'y' else cc == c1
            head = cc == c1 if axis == 'y' else cc == c0
            top = BOTH if tail and head else BANK if tail else FILLET if head else DEEP
        for r in range(2):
            off = ROW + r * ROW_SEP
            segs.append({'slug': top[0], 'frame': top[1],
                         'ax': c + off if axis == 'y' else cc,
                         'ay': cc + 4 if axis == 'y' else c + 4 - off,
                         'mir': 0 if axis == 'y' else 1, 'row': r, 'i': cc})
    segs.sort(key=lambda s: s['ax'] + s['ay'])          # painter's order
    return segs


def load():
    d = json.load(open(OCC))
    road = {tuple(p) for p in d['road']}
    water = {tuple(p) for p in d['river']} | {tuple(p) for p in d['ocean']}
    return road, water


def corridors(road):
    """4-tile-wide, cell-aligned road corridors -> (+y list, +x list).

    For every cell-aligned column group cx (x % 4 == 0) the rows whose full
    4-column band is road are collected and split into maximal runs; a run at
    least one cell long is a +y corridor. Symmetrically for row groups.
    """
    xs = [p[0] for p in road]
    ys = [p[1] for p in road]
    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)
    vert, horz = [], []
    for cx in range(x0 - (x0 % CELL), x1 + 1, CELL):
        cols = [cx + k for k in range(CELL)]
        rr = [y for y in range(y0, y1 + 1)
              if all((c, y) in road for c in cols)]
        for (a, b) in runs(rr):
            if b - a + 1 >= CELL:
                vert.append((cx, a, b))
    for cy in range(y0 - (y0 % CELL), y1 + 1, CELL):
        rows = [cy + k for k in range(CELL)]
        rr = [x for x in range(x0, x1 + 1)
              if all((x, r) in road for r in rows)]
        for (a, b) in runs(rr):
            if b - a + 1 >= CELL:
                horz.append((cy, a, b))
    return vert, horz


def water_band_y(road, water, cx, y0, y1):
    """rows the water layer covers ACROSS the +y corridor cols [cx, cx+3].

    The layers are independent occupancy sets, so a crossing shows up as
    water tiles UNDER the deck tiles: requiring the whole 4-tile corridor to
    be water is both the definition of "road over water" and what drops the
    shoreline quays (a quay has water beside the road, never under it). The
    earlier version of this test read the two columns outside the corridor
    and demanded water on both sides; it passes the same three sites but
    needs min_span to hide the axis-confusion candidates this one rejects."""
    return [y for y in range(y0, y1 + 1)
            if all((cx + k, y) in water for k in range(CELL))]


def water_band_x(road, water, cy, x0, x1):
    """columns the water layer covers across the +x corridor rows [cy, cy+3]"""
    return [x for x in range(x0, x1 + 1)
            if all((x, cy + k) in water for k in range(CELL))]


def runs(vals):
    out, a, b = [], None, None
    for v in sorted(vals):
        if a is None:
            a = b = v
        elif v == b + 1:
            b = v
        else:
            out.append((a, b))
            a = b = v
    if a is not None:
        out.append((a, b))
    return out


STONE = [(140, 170, 156), (132, 162, 148), (173, 206, 189), (123, 158, 140),
         (82, 101, 99), (90, 105, 99), (107, 134, 123), (150, 180, 166)]
LAMP = [(239, 239, 206), (255, 219, 165), (255, 243, 206), (255, 235, 170)]
# measured town -> calibrated-homography grid offset (road-on-asphalt and
# river-on-water agreement scan, see notes): grid = town + (7.5, 144.25)
G2T = (7.5, 144.25)


def _homog():
    import json as _j
    p = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     'mapdump', 'registration', 'g2e-homog.json')
    return _j.load(open(p))['h']


def evidence(shot, h, row, step=0.25):
    """Count the export's bridge-stone / lamp pixels inside a crossing's own
    footprint. The engine only paints that art where it actually built a
    bridge, so this is the gate that separates real crossings from road tiles
    that merely touch water (quays, plaza slabs)."""
    from PIL import Image
    h00, h01, h02, h10, h11, h12, h20, h21 = h
    a, b = row['water']
    c0, c1 = row['corr']
    if row['axis'] == 'y':
        xs, ys = range(c0, c1 + 1), range(a - 1, b + 2)
    else:
        xs, ys = range(a - 1, b + 2), range(c0, c1 + 1)
    pts = []
    for y in ys:
        for x in xs:
            u = x + G2T[0]
            v = y + G2T[1]
            for fy in (0.2, 0.4, 0.6, 0.8):
                for fx in (0.2, 0.4, 0.6, 0.8):
                    d = h20 * (u + fx) + h21 * (v + fy) + 1.0
                    pts.append((int(round((h00 * (u + fx) + h01 * (v + fy) + h02) / d)),
                                int(round((h10 * (u + fx) + h11 * (v + fy) + h12) / d))))
    xs_ = [p[0] for p in pts]
    ys_ = [p[1] for p in pts]
    L, T = min(xs_) - 2, min(ys_) - 2
    R, B = max(xs_) + 3, max(ys_) + 3
    crop = np.asarray(shot.crop((L, T, R, B))).astype(int)
    n_stone = n_lamp = n = 0
    for (px, py) in pts:
        col = crop[py - T, px - L]
        n += 1
        if any(all(abs(col[i] - c[i]) <= 12 for i in range(3)) for c in STONE):
            n_stone += 1
        elif any(all(abs(col[i] - c[i]) <= 12 for i in range(3)) for c in LAMP):
            n_lamp += 1
    return n_stone, n_lamp, n


def placements(road, water, near=None, radius=30, min_span=MIN_SPAN):
    """Every crossing of a road corridor by water, with its bridge pieces."""
    out = []
    vert, horz = corridors(road)
    for cx, y0, y1 in vert:
        band = water_band_y(road, water, cx, y0, y1)
        for (a, b) in runs(band):
            if b - a + 1 < min_span:
                continue
            if y0 >= a or y1 <= b:       # the road must reach both banks
                continue
            cyy = (a + b) / 2
            if near and (abs(cx + 2 - near[0]) > radius or abs(cyy - near[1]) > radius):
                continue
            out.append({'x': cx + 2.0, 'y': cyy, 'axis': 'y',
                        'corr': (cx, cx + CELL - 1), 'water': (a, b),
                        'segs': bridge_run('y', cx, a, b)})
    for cy, x0, x1 in horz:
        band = water_band_x(road, water, cy, x0, x1)
        for (a, b) in runs(band):
            if b - a + 1 < min_span:
                continue
            if x0 >= a or x1 <= b:       # the road must reach both banks
                continue
            cxx = (a + b) / 2
            if near and (abs(cxx - near[0]) > radius or abs(cy + 2 - near[1]) > radius):
                continue
            out.append({'x': cxx, 'y': cy + 2.0, 'axis': 'x',
                        'corr': (cy, cy + CELL - 1), 'water': (a, b),
                        'segs': bridge_run('x', cy, a, b)})
    uniq = {}
    for r in out:
        uniq[(r['axis'], r['corr'], tuple(r['water']))] = r
    out = list(uniq.values())
    out.sort(key=lambda r: (-len(r['segs']), r['y'], r['x']))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--near', default='')
    ap.add_argument('--radius', type=int, default=30)
    ap.add_argument('--min-span', type=int, default=MIN_SPAN,
                    help='shipped threshold: the town\'s three real crossings span 8 water tiles, '
                         'the inlet spans 4')
    ap.add_argument('--json', default='')
    ap.add_argument('--place', action='store_true',
                    help='also print the render-bridge --place string')
    ap.add_argument('--check', action='store_true',
                    help='gate each crossing on the export actually showing '
                         'bridge stone/lamp pixels in its footprint')
    ap.add_argument('--min-stone', type=int, default=25)
    ap.add_argument('--grass', action='store_true',
                    help='grass-abutment frames on the end sections (the '
                         'viewer\'s __CV_BRIDGES({grassEnds:true}) twin)')
    args = ap.parse_args()
    global GRASS_ENDS
    GRASS_ENDS = args.grass
    road, water = load()
    near = tuple(int(v) for v in args.near.split(',')) if args.near else None
    rows = placements(road, water, near, args.radius, args.min_span)
    shot = h = None
    if args.check:
        from PIL import Image
        Image.MAX_IMAGE_PIXELS = None
        shot = Image.open(SHOT).convert('RGB')
        h = _homog()
    print(f'{len(rows)} crossings')
    for r in rows:
        tag = ''
        if shot is not None:
            st, lp, n = evidence(shot, h, r)
            r['stone'], r['lamp'], r['samples'] = st, lp, n
            ok = st >= args.min_stone or lp >= 3
            inlet = r['water'][1] - r['water'][0] + 1 < CELL + 1
            r['game_bridged'] = ok
            tag = f"  evidence stone {st:4d} lamp {lp:3d} /{n}  " \
                  f"{('BRIDGE' if ok else 'plain') if not inlet else 'game: bare' if not ok else 'game: bridged'}"
            if not ok and not inlet:
                # the export shows no bridge art: not a crossing the engine built
                continue
        tok = ','.join(f"{s['slug']}{'~' if s['mir'] else ''}:{s['frame']}:"
                       f"{s['ax']:.2f}:{s['ay']:.2f}" for s in r['segs'])
        print(f"  ({r['x']:6.1f},{r['y']:6.1f}) axis {r['axis']} corridor "
              f"{r['corr']} water {r['water']}  {len(r['segs'])} seg(s){tag}")
        if args.place:
            print(f'      --place \'{tok}\'')
    if args.json:
        json.dump(rows, open(args.json, 'w'))
        print('wrote', args.json)


if __name__ == '__main__':
    main()
