#!/usr/bin/env python3
"""Per-tile classification map of a road x river crossing in the export.

Prints, for a window of SAVED town tiles, what the game actually drew in
each tile diamond — water '~', asphalt '=', grass '.', boardwalk 'w',
bridge stone '#', lamp globe 'O', tree 'T', other '?', by majority vote
over a sample grid inside the diamond. Positions go through the calibrated
grid->export homography (mapdump/registration/g2e-homog.json) with the
site's label correction, so the tile labels are directly comparable with
the decoded road/river layers (web/js/map-explorer-data.js) — that is what
pins which tiles the engine turned into a bridge.

    python3 tools/tilemap.py A
    python3 tools/tilemap.py A --win 149,167,11,29 --off -6,9
"""
import argparse
import json
import os

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOT = os.path.join(ROOT, 'Tapped Out - Simpsons_Screenshot-2025-01-17--19-12-02.png')
HOMOG = os.path.join(ROOT, 'mapdump', 'registration', 'g2e-homog.json')
_H = json.load(open(HOMOG))['h']
GX0, GY0 = 12, 136

# exact export palette entries (sampled on this screenshot)
PAL = [
    ('~', (99, 186, 222)),        # flat water
    ('=', (156, 154, 156)),       # road asphalt
    ('=', (189, 186, 189)),       # asphalt highlight
    ('w', (206, 202, 255)),       # boardwalk / promenade paving
    ('w', (173, 170, 189)),
    ('#', (140, 170, 156)),       # bridge stone (sage)
    ('#', (132, 162, 148)),
    ('#', (173, 206, 189)),       # bridge stone lite
    ('#', (82, 101, 99)),         # bridge stone dark
    ('#', (90, 105, 99)),
    ('O', (239, 239, 206)),       # lamp globe
    ('O', (255, 219, 165)),
    ('T', (33, 138, 82)),         # tree foliage
    ('T', (33, 101, 66)),
    ('.', (99, 186, 99)),         # grass
    ('.', (66, 105, 66)),
]
TOL = 14

SITES = {   # tag -> (crop centre px, saved-tile window, label correction)
    'A': ((3465, 2905), (149, 167, 11, 29), (-6, 9)),
    'B': ((3885, 2945), (165, 183, 43, 61), (-6, 9)),
    'D': ((4520, 2755), (221, 239, 59, 77), (-6, 9)),
}


def H(gx, gy):
    h00, h01, h02, h10, h11, h12, h20, h21 = _H
    d = h20 * gx + h21 * gy + 1.0
    return ((h00 * gx + h01 * gy + h02) / d, (h10 * gx + h11 * gy + h12) / d)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('site')
    ap.add_argument('--win', default='')
    ap.add_argument('--off', default='')
    args = ap.parse_args()
    Image.MAX_IMAGE_PIXELS = None
    (cx, cy), win, off = SITES[args.site]
    if args.win:
        win = tuple(int(v) for v in args.win.split(','))
    if args.off:
        off = tuple(int(v) for v in args.off.split(','))
    im = np.array(Image.open(SHOT).convert('RGB')).astype(np.int16)
    Hh, W = im.shape[:2]

    def P(sx, sy):
        """saved tile corner -> screenshot px."""
        return H(sx + off[0] + GX0, sy + off[1] + GY0)

    def pt(sx, sy, fx, fy):
        a, b = P(sx, sy), P(sx + 1, sy)
        c, d = P(sx + 1, sy + 1), P(sx, sy + 1)
        x = (1 - fx) * (1 - fy) * a[0] + fx * (1 - fy) * b[0] + fx * fy * c[0] + (1 - fx) * fy * d[0]
        y = (1 - fx) * (1 - fy) * a[1] + fx * (1 - fy) * b[1] + fx * fy * c[1] + (1 - fx) * fy * d[1]
        return int(round(x)), int(round(y))

    def cls(sx, sy):
        votes = {}
        for fx in (0.28, 0.44, 0.6, 0.76):
            for fy in (0.28, 0.44, 0.6, 0.76):
                x, y = pt(sx, sy, fx, fy)
                if not (0 <= y < Hh and 0 <= x < W):
                    continue
                r, g, b = im[y, x]
                hit = '?'
                for ch, (r0, g0, b0) in PAL:
                    if abs(r - r0) <= TOL and abs(g - g0) <= TOL and abs(b - b0) <= TOL:
                        hit = ch
                        break
                votes[hit] = votes.get(hit, 0) + 1
        if not votes:
            return ' '
        ch, n = max(votes.items(), key=lambda kv: kv[1])
        return ch if n >= 9 else ('?' if n >= 5 else ' ')

    sx0, sx1, sy0, sy1 = win
    print('    ' + ''.join(str(sx % 10) for sx in range(sx0, sx1)))
    for sy in range(sy0, sy1):
        print(f'{sy:4d} ' + ''.join(cls(sx, sy) for sx in range(sx0, sx1)))
    print('  legend ~water =asphalt w=boardwalk #=bridge-stone O=lamp T=tree .=grass ?=other')


if __name__ == '__main__':
    main()
