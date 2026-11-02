#!/usr/bin/env python3
"""Score a candidate bridge placement by pixel agreement with the export.

tools/fit-bridge.py searches placements one art cell at a time by correlating
class masks; this tool scores a WHOLE crossing (the piece list that
tools/bridge-sites.py produces, i.e. two rows of sections stepped by the art's
lamppost pitch) by compositing the pieces onto the export crop and asking, for
every OPAQUE art pixel, what the export shows there:

  hit : the export pixel matches the art pixel's own class (stone/deck/lamp)
  pos : the export pixel matches any bridge-art palette entry or the outline ink
  neu : the export pixel is what the ROAD's own art paints (lavender paving,
        asphalt, kerb) or plain water/grass outside the deck: the engine draws
        the road over the bridge, so a bridge pixel there says nothing either
        way and it is excluded from both the credit and the blame
  bad : anything else — bridge art landing on something plainly not a bridge

    score = (hit + 0.35*pos - 0.6*bad) / (opaque - neu)

The `neu` class is the fix for a bias that made the first calibration useless:
the road's paving lavender (206,202,255) and its kerb grey (173,170,189) sat in
NEG, so every legitimate pixel of the balustrade rows that the carriageway
covers was charged as a mismatch. With those colours neutral the same crossing
scored 0.274-0.285 where the biased scorer had called it 0.50/0.48/0.39.

Sweeping --sweep dx,dy,dstep around a produced placement shows which candidate
the export agrees with. Note what the score CANNOT see: at the export's ~10.5
px per tile a lamppost globe is 3x3 px, so a placement error of half a tile
moves only a handful of pixels. For POSITION, fit the lamppost lattice instead
(the cream-globe blobs and their 110/64-tile pitch are what pinned the row
offsets, the 4.5-tile row separation and the deep/shallow piece choice; see
notes/09 §10) and use this scorer to compare compositions, not to place them.

    python3 tools/score-bridge.py A --place "$(python3 tools/bridge-sites.py --near 158,20 --place | grep -o "'[^']*'" | tr -d "'")"
    python3 tools/score-bridge.py A --place 'bridgetop:4:155.15:19.98,...' --sweep 0,0,0.25
"""
import argparse
import importlib.util
import json
import os

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOT = os.path.join(ROOT, 'Tapped Out - Simpsons_Screenshot-2025-01-17--19-12-02.png')


def _load(name):
    p = importlib.util.spec_from_file_location(name.replace('-', '_'),
                                               os.path.join(ROOT, 'tools', name))
    m = importlib.util.module_from_spec(p)
    p.loader.exec_module(m)
    return m


fb = _load('fit-bridge.py')
rb = _load('render-bridge.py')

# what the export shows where a bridge is NOT drawn — grass, open water, trees,
# boardwalk planking. NOT road paving/kerb: see the docstring.
NEG = [(99, 186, 99), (66, 105, 66), (99, 186, 222), (90, 175, 215),
       (33, 138, 82), (33, 101, 66)]
# what the road's own art paints over the deck (lavender paving, kerb, asphalt)
# plus the shore slabs: neither credit nor blame
NEU = [(206, 202, 255), (173, 170, 189), (156, 154, 156), (189, 186, 189),
       (140, 138, 140), (123, 121, 123), (102, 102, 102), (128, 128, 128),
       (38, 78, 122), (52, 99, 147), (235, 224, 176), (203, 190, 150)]
POS = [c for cols in fb.ART.values() for c in cols] + [(17, 17, 17), (0, 0, 0),
                                                       (34, 34, 34)]
# measured town -> calibrated grid offset (road-on-asphalt scan)
G2T = (7.5, 144.25)


def near(img, pal, t):
    m = np.zeros(img.shape[:2], bool)
    for (r0, g0, b0) in pal:
        m |= (np.abs(img[..., 0] - r0) <= t) & (np.abs(img[..., 1] - g0) <= t) \
             & (np.abs(img[..., 2] - b0) <= t)
    return m


def score(base, aa, op):
    g = base.astype(int)
    ac = fb.class_masks(aa, fb.ART, 12)
    gc = fb.class_masks(g, fb.SCREEN, 12)
    hit = (ac['stone'] & gc['stone']) | (ac['deck'] & gc['deck']) | \
          (ac['lamp'] & gc['lamp'])
    pos = near(g, POS, 26)
    neu = near(g, NEU, 20)
    neg = near(g, NEG, 20)
    n = int(op.sum())
    if not n:
        return 0.0, {}
    h = int((hit & op).sum())
    p = int((pos & op & ~neu).sum())
    b = int((neg & op & ~pos & ~neu).sum())
    den = max(1, n - int((neu & op).sum()))
    return (h + 0.35 * p - 0.6 * b) / den, {'hit': h, 'pos': p, 'bad': b, 'n': n,
                                            'neu': int((neu & op).sum())}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('site')
    ap.add_argument('--place', required=True,
                    help='slug:frame:ax:ay[,..] from tools/bridge-sites.py --place')
    ap.add_argument('--sweep', default='', help='dx,dy,dstep grid sweep')
    ap.add_argument('--k', type=float, default=0.0,
                    help='art px -> export px scale; 0 = local px/tile from the '
                         'calibrated homography divided by ART.S (the honest '
                         'value: the engine scales the sheet by s / ART.S)')
    ap.add_argument('--half', type=int, default=100)
    ap.add_argument('--json', default='')
    args = ap.parse_args()
    Image.MAX_IMAGE_PIXELS = None
    toks = []
    for t in args.place.split(','):
        s, f, ax, ay = t.split(':')
        toks.append((s.rstrip('~'), int(f), float(ax), float(ay), s.endswith('~')))
    (cx, cy), _half, axis, off = rb.SITES[args.site]
    shot = Image.open(SHOT).convert('RGB')
    L, T = cx - args.half, cy - args.half
    base = np.array(shot.crop((L, T, cx + args.half, cy + args.half)))
    W = H = args.half * 2
    gx, gy = rb.U(cx, cy)
    k = args.k or rb.local_s(gx, gy) / rb.ART_S

    def one(dx, dy):
        cv = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        for (s, f, ax, ay, m) in toks:
            # the piece list is in SAVE tiles; grid = tile + (7.5, 144.25)
            gx2, gy2 = ax + dx + G2T[0], ay + dy + G2T[1]
            px, py = fb.H(gx2, gy2)
            rb.draw_frame(cv, s, f, k, px - L, py - T, mir=m)
        a = np.array(cv)
        return score(base, a[..., :3], a[..., 3] > 120)

    print(f'site {args.site}  k={k:.4f}  off={off}  {len(toks)} pieces')
    if args.sweep:
        dx, dy, st = (float(v) for v in args.sweep.split(','))
        res = []
        for i in range(-8, 9):
            for j in range(-8, 9):
                v, d = one(i * st + dx, j * st + dy)
                res.append((v, i * st + dx, j * st + dy, d))
        res.sort(key=lambda r: -r[0])
        for v, a, b, d in res[:8]:
            print(f'  d=({a:+.2f},{b:+.2f}) score {v:.3f}  {d}')
    else:
        v, d = one(0, 0)
        print(f'site {args.site} score {v:.3f}  {d}')
        if args.json:
            json.dump({'site': args.site, 'score': v, 'counts': d}, open(args.json, 'w'))


if __name__ == '__main__':
    main()
