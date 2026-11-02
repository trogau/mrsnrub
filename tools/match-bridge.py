#!/usr/bin/env python3
"""Locate the engine's bridge cells in the full-res export screenshot.

The engine composes road-over-river bridges from the two core bsv3 scenes
`bridgetop` (deck + balustrade + lamps, 8 frames) and `bridgebottom`
(arch + piers, 2 frames); their cells are listed in notes/09 ("Bridges").
This tool template-matches each cell — plain and horizontally mirrored
(the engine's se/sw/ne/nw families are one art set drawn both ways) — into
a crop around a known road x river crossing, using masked colour NCC at the
scale the camera model says the piece must have:

    k = s / ART.S       s = px per world unit at the crossing
                        (local Jacobian of mapdump/registration/g2e-homog.json)
                        ART.S = 64 (notes/06 "Sprite scale S pinned")

so the winner is read off in TILE units, not free pixels.

    python3 tools/match-bridge.py A
    python3 tools/match-bridge.py            # all sites in SITES
"""
import json
import os
import sys

import numpy as np
from PIL import Image
from scipy.signal import fftconvolve

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
from extract_assets import rgb_to_rgba                      # noqa: E402

POOL = '/tmp/opencode/citypool'
SHOT = os.path.join(ROOT, 'Tapped Out - Simpsons_Screenshot-2025-01-17--19-12-02.png')
HOMOG = os.path.join(ROOT, 'mapdump', 'registration', 'g2e-homog.json')

_H = json.load(open(HOMOG))['h']
ART_S = 64.0                     # art px per world unit (notes/06)
GX0, GY0 = 12, 136               # town -> grid offset

# cell rectangles recovered from the bsv3 scene headers
CELLS = {
    'T05': ('bridgetop', 297, 1, 258, 267),
    'T06': ('bridgetop', 297, 270, 258, 213),
    'T08': ('bridgetop', 1, 1, 294, 325),
    'T09': ('bridgetop', 1, 328, 294, 270),
    'G03': ('bridgetop', 428, 485, 117, 67),
    'G04': ('bridgetop', 297, 485, 129, 98),
    'B02': ('bridgebottom', 1, 1, 294, 249),
    'B03': ('bridgebottom', 1, 252, 254, 191),
}

# crossing sites: tag -> (crop centre px, saved road x river cells, road axis)
SITES = {
    'A': ((3470, 2885), 'y'),     # road lane x=159 over the E-W river
    'B': ((3880, 2915), 'x'),     # road lane y=48 over the N-S river
    'D': ((4520, 2740), 'y'),
}


def H(gx, gy):
    h00, h01, h02, h10, h11, h12, h20, h21 = _H
    d = h20 * gx + h21 * gy + 1.0
    return ((h00 * gx + h01 * gy + h02) / d, (h10 * gx + h11 * gy + h12) / d)


_INV = np.linalg.inv(np.array([_H[:3], _H[3:6], [_H[6], _H[7], 1.0]]))


def U(x, y):
    v = _INV @ np.array([x, y, 1.0])
    return v[0] / v[2], v[1] / v[2]


def local_scale(gx, gy, e=0.5):
    """px per world unit s at a grid point: the homography's local Jacobian.

    The camera model gives dScreen/dgx = (s, -s/2) and dScreen/dgy = (s, s/2)
    under the shipped ORIENT, so s is the mean x-derivative."""
    ax, _ = H(gx + e, gy)
    bx, _ = H(gx - e, gy)
    cx, _ = H(gx, gy + e)
    dx, _ = H(gx, gy - e)
    return ((ax - bx) / (2 * e) + (cx - dx) / (2 * e)) / 2.0


_CACHE = {}


def cell_img(name):
    if name not in _CACHE:
        slug, x, y, w, h = CELLS[name]
        b = open(os.path.join(POOL, slug + '.rgb'), 'rb').read()
        W, Hh, bpp, rgba, pm = rgb_to_rgba(b, slug)
        _CACHE[name] = Image.frombytes('RGBA', (W, Hh), rgba).crop((x, y, x + w, y + h))
    return _CACHE[name]


def masked_ncc(I, I2, tmpl, k):
    """best masked colour-NCC score + position for template at scale k."""
    w, h = max(6, int(round(tmpl.width * k))), max(6, int(round(tmpl.height * k)))
    if w + 6 > I.shape[1] or h + 6 > I.shape[0]:
        return None
    t = tmpl.resize((w, h), Image.LANCZOS)
    a = np.array(t).astype(float)
    m = (a[..., 3] > 110)
    if m.sum() < 60:
        return None
    mf = m.astype(float)
    oy, ox = I.shape[0] - h + 1, I.shape[1] - w + 1
    num = np.zeros((oy, ox))
    den_t = 0.0
    for c in range(3):
        tc = a[..., c] * mf
        mu = tc.sum() / m.sum()
        rk = (tc - mu * mf)[::-1, ::-1]
        num += fftconvolve(I[..., c], rk, mode='valid')
        den_t += ((tc - mu * mf) ** 2).sum()
    den_i = np.sqrt(fftconvolve(I2, mf[::-1, ::-1], mode='valid') + 1e-9)
    sc = num / (np.sqrt(den_t) * den_i + 1e-9)
    idx = np.unravel_index(np.argmax(sc), sc.shape)
    return float(sc[idx]), int(idx[1]), int(idx[0])


def main():
    Image.MAX_IMAGE_PIXELS = None
    shot = Image.open(SHOT).convert('RGB')
    want = sys.argv[1:] or list(SITES)
    names = sys.argv[1] if len(sys.argv) > 2 else None
    only = set(names.split(',')) if names else None
    for tag in want:
        (cx, cy), axis = SITES[tag]
        gx, gy = U(cx, cy)
        s = local_scale(gx, gy)
        k0 = s / ART_S
        print(f'## {tag} centre px ({cx},{cy}) = grid {gx:.2f},{gy:.2f} '
              f'= town {gx - GX0:.2f},{gy - GY0:.2f}   s={s:.2f}px/tile  k={k0:.4f}')
        half = 210
        box = shot.crop((cx - half, cy - half, cx + half, cy + half))
        arr = np.array(box).astype(float)
        I2 = arr * arr
        rows = []
        for name, tmpl in sorted(CELLS.items()):
            if only and name not in only:
                continue
            im = cell_img(name)
            for mir in (0, 1):
                t = im.transpose(Image.FLIP_LEFT_RIGHT) if mir else im
                best = None
                for kk in (k0 * f for f in np.arange(0.86, 1.15, 0.01)):
                    r = masked_ncc(arr, I2, t, kk)
                    if r and (best is None or r[0] > best[0]):
                        best = (r[0], kk, r[1], r[2])
                if best:
                    rows.append((best[0], name, mir, best[1],
                                 cx - half + best[2], cy - half + best[3]))
        rows.sort(reverse=True)
        for v, name, mir, kk, px, py in rows[:8]:
            tgl, tbt = U(px, py)          # sprite top-left in tiles
            print(f'   {name}{"~" if mir else " "} k={kk:.4f} ({kk * ART_S:.1f}px/tile)'
                  f' score {v:.3f}  top-left px ({px},{py}) = tile '
                  f'{tgl - GX0:.2f},{tbt - GY0:.2f}')


if __name__ == '__main__':
    main()
