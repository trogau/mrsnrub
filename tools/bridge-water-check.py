#!/usr/bin/env python3
"""Is the bridge rule's own coordinate frame right at a site?

tools/bridge-sites.py derives crossings from the SAVE (road tiles with water
tiles under them) and then fits the piece placement against the full-res
export. Those are two coordinate systems, so a site can be FOUND correctly and
still be PAINTED in the wrong place if the grid->export mapping or the site's
tile offset drifted — a mistake no art-based check can see, because the fitter
just slides the pieces onto whatever art is nearby.

This checks the frame itself, without any bridge art in the loop: for every
tile of the site's neighbourhood it asks

    save : does the save's water / road layer occupy this tile?
    shot : which colour class dominates the export pixels inside that tile's
           projected diamond — water-blue, asphalt-grey, grass-green?

and prints a map of where the two disagree. A correctly placed site must show
water-blue exactly where the save says water; a shifted site shows up as a
block of `X` that walks off in one direction, which is also how to read the
direction and size of the shift.

    python3 tools/bridge-water-check.py C
    python3 tools/bridge-water-check.py A B C D
"""
import json
import os
import sys

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOT = os.path.join(ROOT, 'Tapped Out - Simpsons_Screenshot-2025-01-17--19-12-02.png')
HOMOG = os.path.join(ROOT, 'mapdump', 'registration', 'g2e-homog.json')
OCC = '/tmp/opencode/occ.json'
GX0, GY0 = 12, 136                       # grid = saved town tile + (12, 136)

# site -> (corridor axis, corridor edge, water band, tile offset the fitting
# tools use for this site) — the same numbers as tools/bridge-sites.py SITES
SITES = {
    'A': ('y', 156, 16, 23, (-5, 8)),
    'B': ('x', 48, 168, 175, (-5, 8)),
    'C': ('x', 48, 252, 255, (-5, 8)),
    'D': ('y', 224, 64, 71, (-5, 8)),
}

_H = json.load(open(HOMOG))['h']
_M = np.array([_H[:3], _H[3:6], [_H[6], _H[7], 1.0]])


def occupancy():
    """The two sets the viewer's bridgeOcc() builds, from the same dump
    tools/bridge-sites.py reads."""
    d = json.load(open(OCC))
    road = {tuple(p) for p in d['road']}
    water = {tuple(p) for p in d['river']} | {tuple(p) for p in d['ocean']}
    return water, road


def to_shot(tx, ty, off):
    """Saved tile -> export px, with the site's fitting offset applied."""
    v = _M @ np.array([tx + GX0 + off[0], ty + GY0 + off[1], 1.0])
    return v[0] / v[2], v[1] / v[2]


def sample(a, box, tx, ty, off):
    """Colour-class fractions inside one tile's projected diamond."""
    c = to_shot(tx + 0.5, ty + 0.5, off)
    xr = to_shot(tx + 1.5, ty + 0.5, off)
    yd = to_shot(tx + 0.5, ty + 1.5, off)
    ex, ey = xr[0] - c[0], yd[1] - c[1]
    shear = (yd[0] - c[0]) / ey if ey else 0.0
    cx, cy = c[0] - box[0], c[1] - box[1]
    h, w = a.shape[:2]
    ys, xs = np.mgrid[0:h, 0:w]
    u = (xs - cx) / ex
    v = (ys - cy - shear * (xs - cx)) / ey
    m = (np.abs(u) + np.abs(v)) <= 0.92       # inset: avoid the neighbours
    if m.sum() < 30:
        return None
    p = a[m].astype(int)
    r, g, b = p[:, 0], p[:, 1], p[:, 2]
    n = len(p)
    cl = dict(
        water=float(((b > r + 25) & (b > 110)).sum()) / n,
        road=float(((abs(r - g) < 18) & (abs(g - b) < 22) &
                    (r > 118) & (r < 216)).sum()) / n,
        grass=float(((g > r + 12) & (g > b + 12)).sum()) / n)
    return cl


def main():
    Image.MAX_IMAGE_PIXELS = None
    want = sys.argv[1:] or sorted(SITES)
    water, road = occupancy()
    print('save: %d water tiles, %d road tiles' % (len(water), len(road)))
    shot = Image.open(SHOT).convert('RGB')
    for tag in want:
        axis, c, wa, wb, off = SITES[tag]
        if axis == 'x':
            tx0, tx1, ty0, ty1 = wa - 4, wb + 5, c - 4, c + 9
        else:
            tx0, tx1, ty0, ty1 = c - 4, c + 9, wa - 4, wb + 5
        mid = to_shot((tx0 + tx1) / 2.0, (ty0 + ty1) / 2.0, off)
        pad = 60
        box = (int(mid[0]) - (tx1 - tx0) * 10 - pad, int(mid[1]) - (ty1 - ty0) * 8 - pad,
               int(mid[0]) + (tx1 - tx0) * 10 + pad, int(mid[1]) + (ty1 - ty0) * 8 + pad)
        a = np.array(shot.crop(box))
        print('\n## site %s  axis %s corridor %d  water band %d..%d  off %s'
              % (tag, axis, c, wa, wb, off))
        print('    ' + ' '.join('%-3d' % t for t in range(tx0, tx1 + 1)))
        agree = tot = 0
        bad = []
        for ty in range(ty0, ty1 + 1):
            line = ''
            for tx in range(tx0, tx1 + 1):
                cl = sample(a, box, tx, ty, off)
                if cl is None:
                    line += '  ?  '
                    continue
                w, r = (tx, ty) in water, (tx, ty) in road
                best = max(cl, key=cl.get)
                want_cls = 'water' if w else ('road' if r else None)
                if want_cls is None:
                    line += '  -  '
                    continue
                ok = best == want_cls
                tot += 1
                agree += ok
                if not ok:
                    bad.append((tx, ty, want_cls, best, round(cl[best], 2)))
                line += ' %s%s ' % ('W' if w else 'R', '=' if ok else 'X')
            print('%3d %s' % (ty, line))
        print('  W/R = save occupancy, = / X = the export class under that tile agrees')
        print('  agreement %d/%d = %.0f%%' % (agree, tot, 100.0 * max(agree, 0) / max(1, tot)))
        if bad:
            xs = [b[0] for b in bad]
            ys = [b[1] for b in bad]
            print('  disagreements: %d, tile bbox x %d..%d y %d..%d; worst:'
                  % (len(bad), min(xs), max(xs), min(ys), max(ys)))
            for b in sorted(bad, key=lambda b: -b[4])[:8]:
                print('     (%d,%d) save says %-5s export is %-5s (%.0f%%)'
                      % (b[0], b[1], b[2], b[3], 100 * b[4]))


if __name__ == '__main__':
    main()
