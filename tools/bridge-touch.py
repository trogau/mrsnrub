#!/usr/bin/env python3
"""Does the export show bridge-stone / lamp colours on road tiles that merely
TOUCH water, or only where it actually built a bridge?

The user's ask has two halves: a road that CROSSES the river, and one that
"goes next to water". The crossings are shipped; this measures the second
case. For three groups of tiles we sample the export on a 0.4-tile grid inside
each tile and count the bridge-stone / bridge-lamp colours (the same class
lists tools/bridge-sites.py --check uses):

  crossings   the 3 bridged crossings' own corridor tiles   (positive control)
  touching    the road cells that have a water cell as a +-4 neighbour,
              sampled on the 1-tile strip along the shared edge
  plain       road cells with no water within +-6 tiles    (negative control)

If `touching` scores like `plain`, the game draws nothing special beside water.

    python3 tools/bridge-touch.py
"""
import importlib.util
import json
import random

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOT = ROOT + '/Tapped Out - Simpsons_Screenshot-2025-01-17--19-12-02.png'

spec = importlib.util.spec_from_file_location(
    'bs', os.path.join(ROOT, 'tools', 'bridge-sites.py'))
bs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bs)
STONE, LAMP, G2T = bs.STONE, bs.LAMP, bs.G2T
H = bs._homog()

OCC = json.load(open('/tmp/opencode/occ.json'))
CELLS = json.load(open('/tmp/opencode/cells.json'))
road = {tuple(p) for p in OCC['road']}
water = {tuple(p) for p in OCC['river']} | {tuple(p) for p in OCC['ocean']}
road_cells = sorted({tuple(v[:2]) for v in CELLS['road']})
water_cells = {(x, y) for (x, y) in water}


def proj(x, y):
    u, v = x + G2T[0], y + G2T[1]
    h00, h01, h02, h10, h11, h12, h20, h21 = H
    d = h20 * u + h21 * v + 1.0
    return (int(round((h00 * u + h01 * v + h02) / d)),
            int(round((h10 * u + h11 * v + h12) / d)))


shot = Image.open(SHOT).convert('RGB')


def count(tiles):
    """(stone, lamp, n) samples over a list of tiles, batched in one crop"""
    pts = []
    for (x, y) in tiles:
        for fy in (0.2, 0.4, 0.6, 0.8):
            for fx in (0.2, 0.4, 0.6, 0.8):
                pts.append(proj(x + fx, y + fy))
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    L, T = min(xs) - 2, min(ys) - 2
    crop = np.asarray(shot.crop((L, T, max(xs) + 3, max(ys) + 3))).astype(int)
    ns = nl = 0
    for (px, py) in pts:
        col = crop[py - T, px - L]
        if any(all(abs(col[i] - c[i]) <= 12 for i in range(3)) for c in STONE):
            ns += 1
        elif any(all(abs(col[i] - c[i]) <= 12 for i in range(3)) for c in LAMP):
            nl += 1
    return ns, nl, len(pts)


def rate(name, tiles):
    ns, nl, n = count(tiles)
    print(f'  {name:34s} {n:6d} samples  stone {ns:5d} ({100.0 * ns / n:5.2f}%)  '
          f'lamp {nl:4d} ({100.0 * nl / n:5.3f}%)')
    return ns / n, nl / n


CROSS = [((x, y) for x in range(156, 160) for y in range(16, 24)),
         ((x, y) for x in range(168, 176) for y in range(48, 52)),
         ((x, y) for x in range(224, 228) for y in range(64, 72))]

touch, plain = [], []
for (cx, cy) in road_cells:
    near = any((x, y) in water_cells
               for x in range(cx - 6, cx + 10) for y in range(cy - 6, cy + 10))
    sides = [d for d in ((1, 0), (-1, 0), (0, 1), (0, -1))
             if (cx + 4 * d[0], cy + 4 * d[1]) in water_cells]
    if (cx, cy) in water_cells:
        continue
    if sides:
        strip = []
        for (dx, dy) in sides:                        # 1-tile strip on the shared edge
            if dx:
                gx = cx + 3 if dx > 0 else cx
                strip += [(gx, cy + j) for j in range(4)]
            else:
                gy = cy + 3 if dy > 0 else cy
                strip += [(cx + i, gy) for i in range(4)]
        touch.append((cx, cy, strip))
    elif not near:
        plain.append((cx, cy))

print('positive control — the three bridged crossings:')
for g in CROSS:
    rate('crossing corridor', list(g))
print(f'\n{len(touch)} road cells that touch water (edge strip only):')
rs, rl = 0.0, 0.0
for (cx, cy, strip) in touch:
    rate(f'cell ({cx},{cy})', strip)
print(f'\nnegative control — {len(plain)} road cells with no water within 6 tiles:')
rnd = random.Random(7).sample(plain, min(24, len(plain)))
for (cx, cy) in rnd:
    rate(f'cell ({cx},{cy})', [(cx + i, cy + j) for i in range(4) for j in range(4)])
