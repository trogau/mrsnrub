#!/usr/bin/env python3
"""Find WHERE the engine drew each bridge piece, and which frame it used.

The game composes a road x river crossing out of two core bsv3 scenes,
`bridgetop` (8 frames) and `bridgebottom` (2 frames); tools/render-bridge.py
draws a hypothesis, this tool scores hypotheses against the full-res export so
a hypothesis can be accepted on evidence. What the art actually contains
(measured off the sheets, mapdump/registration/m4-bridge-art-sheet.png):

  bridgetop f4/f0 = C_BridgeTop_08/05 — a three/two-lamppost section with piers
      and arch openings, the deck line, and piers hanging 75 px BELOW it: the
      piece that stands in water. f5/f7 = C_BridgeTop_09/06, the same with 20 px
      of pier: the abutment length used over dry ground. f1/f2/f3/f6 add a grass
      abutment cell. bridgebottom f0/f1 = C_BridgeBottom_02/03 — the balustrade
      wall with square openings plus the lampposts, NOTHING below its origin.
      Both pieces of a pair draw on ONE origin, so the wall is the only thing
      that shows above the road art and the arches the only thing below it.

  Every cell is periodic with its own period (110, 57) art px (53-61 % of the
  pixels opaque in both copies agree within 14/255 per channel, 70-72 % within
  20, mean abs diff 14-20 — `--period` prints it). That period is the
  lamppost spacing INSIDE one section. (2026-10-27: the game joins whole
  3-lamppost sections one per 4x4 road cell, 4 tiles apart, doubling the
  lampposts at each join — not overlapping pieces stepped by the period;
  notes/09 §10 "The shipped port". Placement is verified by lamppost
  detection on the registered screenshot, not by this tool's scores.)

Why a class-coverage score and not colour correlation: the bridge art uses a
handful of palette entries, and the export shows the same entries a few units
brighter/darker (the game lights sprites), e.g. art (136,170,153) lands on
screen as (140,170,156). So each piece's pixels are put in three CLASSES -
stone (sage balustrade/piers), deck (the asphalt roadway between the rails),
lamp (the cream globes) - in both palettes, and a placement scores

    sum_c W[c] * |pred_c & obs_c| / sum_c W[c] * |pred_c|

the weighted fraction of the piece's own pixels that land on the matching
screen class. Deck is weighted down (asphalt is everywhere); a piece only wins
by putting its stone on stone and its lamps on lamps. `--box` limits the
observed masks to the crossing's own tiles, which is what keeps the town's
sage roofs (same palette entry as the bridge stone) from saturating the score.

Beware what the score cannot see: the export is only ~10.5 px per ground tile,
so a lamppost globe is 3x3 px and free-position searches drift onto the
nearest sage patch. Pin k, box the search, and fit POSITION off the lamppost
lattice (the cream-globe blobs on their 110/64-tile pitch — that is what pinned
the row offsets, the 4.5-tile row separation and the deep/shallow choice in
tools/bridge-sites.py), using this tool to rank compositions.

    python3 tools/fit-bridge.py A --box 154,14,163,26 --piece T05,T06,T08,T09,B02,B03
"""
import argparse
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
GX0, GY0 = 12, 136                     # grid = saved town tile + (12, 136)
ART_S = 64.0                           # art px per world unit (notes/06)

# The three pixel classes, sampled from the bsv3 art sheets (top opaque
# colours of C_BridgeTop_08 / C_BridgeBottom_02) and from the export around a
# known crossing. The screen family is the art family shifted a few units per
# channel, so a tolerance of ~10 separates them from asphalt/water/grass.
ART = {
    'stone': [(136, 170, 153), (119, 153, 136), (170, 204, 187), (170, 221, 204),
              (85, 102, 102), (102, 119, 119), (136, 170, 170)],
    'deck':  [(153, 153, 153), (136, 136, 136), (170, 170, 170), (119, 119, 119)],
    'lamp':  [(238, 238, 204), (255, 221, 170), (255, 238, 187), (255, 255, 238)],
}
SCREEN = {
    'stone': [(140, 170, 156), (132, 162, 148), (173, 206, 189), (123, 158, 140),
              (82, 101, 99), (90, 105, 99), (107, 134, 123), (150, 180, 166)],
    'deck':  [(156, 154, 156), (189, 186, 189), (140, 138, 140), (123, 121, 123)],
    'lamp':  [(239, 239, 206), (255, 219, 165), (255, 243, 206), (255, 235, 170)],
}
W = {'stone': 1.0, 'deck': 0.5, 'lamp': 2.0}

CELLS = {   # name -> (slug, x, y, w, h, anchorX, anchorY); anchor = -block x,y
    'T05': ('bridgetop', 297, 1, 258, 267, 220.95, 190.75),
    'T06': ('bridgetop', 297, 270, 258, 213, 221.25, 190.75),
    'T08': ('bridgetop', 1, 1, 294, 325, 257.2, 248.0),
    'T09': ('bridgetop', 1, 328, 294, 270, 256.95, 247.75),
    'G03': ('bridgetop', 428, 485, 117, 67, 0.0, 0.0),      # frame-relative
    'G04': ('bridgetop', 297, 485, 129, 98, 0.0, 0.0),      # frame-relative
    'B02': ('bridgebottom', 1, 1, 294, 249, 257.0, 249.0),
    'B03': ('bridgebottom', 1, 252, 254, 191, 217.0, 191.0),
}
SITES = {   # tag -> (crop centre px, road axis, tile-label correction)
    'A': ((3465, 2905), 'y', (-5, 8)),
    'B': ((3885, 2945), 'x', (-5, 8)),
    'D': ((4520, 2755), 'y', (-5, 8)),
}


def H(gx, gy):
    h00, h01, h02, h10, h11, h12, h20, h21 = _H
    d = h20 * gx + h21 * gy + 1.0
    return ((h00 * gx + h01 * gy + h02) / d, (h10 * gx + h11 * gy + h12) / d)


_INV = np.linalg.inv(np.array([_H[:3], _H[3:6], [_H[6], _H[7], 1.0]]))


def U(x, y):
    v = _INV @ np.array([x, y, 1.0])
    return v[0] / v[2], v[1] / v[2]


def local_s(gx, gy, e=0.5):
    ax, _ = H(gx + e, gy); bx, _ = H(gx - e, gy)
    cx, _ = H(gx, gy + e); dx, _ = H(gx, gy - e)
    return ((ax - bx) / (2 * e) + (cx - dx) / (2 * e)) / 2.0


_C = {}


def cell_img(name):
    if name not in _C:
        slug, x, y, w, h = CELLS[name][:5]
        if slug not in _C:
            b = open(os.path.join(POOL, slug + '.rgb'), 'rb').read()
            W_, H_, bpp, rgba, pm = rgb_to_rgba(b, slug)
            _C[slug] = Image.frombytes('RGBA', (W_, H_), rgba)
        _C[name] = _C[slug].crop((x, y, x + w, y + h))
    return _C[name]


def class_masks(a, pal, tol):
    """{class -> bool mask} of an (h,w,3) int image; first class wins."""
    out = {k: np.zeros(a.shape[:2], bool) for k in pal}
    taken = np.zeros(a.shape[:2], bool)
    for k, cols in pal.items():
        m = np.zeros(a.shape[:2], bool)
        for (r0, g0, b0) in cols:
            m |= (np.abs(a[..., 0] - r0) <= tol) & (np.abs(a[..., 1] - g0) <= tol) \
                & (np.abs(a[..., 2] - b0) <= tol)
        out[k] = m & ~taken
        taken |= m
    return out


def tile_keep(shape, off, box, L, T):
    """Mask of screen pixels inside the saved-tile rect box=(x0,y0,x1,y1)."""
    keep = np.zeros(shape, bool)
    for ty in range(box[1], box[3]):
        for tx in range(box[0], box[2]):
            A = H(tx + off[0] + GX0, ty + off[1] + GY0)
            Bp = H(tx + off[0] + GX0 + 1, ty + off[1] + GY0)
            Cp = H(tx + off[0] + GX0 + 1, ty + off[1] + GY0 + 1)
            Dp = H(tx + off[0] + GX0, ty + off[1] + GY0 + 1)
            for fy in np.arange(0.03, 1.0, 0.06):
                for fx in np.arange(0.03, 1.0, 0.06):
                    x = (1 - fx) * (1 - fy) * A[0] + fx * (1 - fy) * Bp[0] \
                        + fx * fy * Cp[0] + (1 - fx) * fy * Dp[0] - L
                    y = (1 - fx) * (1 - fy) * A[1] + fx * (1 - fy) * Bp[1] \
                        + fx * fy * Cp[1] + (1 - fx) * fy * Dp[1] - T
                    keep[int(round(y)), int(round(x))] = True
    return keep


def class_search(SM, tmpl, kk, mir, peaks=1, sep=0):
    """Top-`peaks` class-coverage placements of a cell at scale kk.

    Returns [(score, coverage, ox, oy), ...]: the score map's local maxima, at
    least `sep` px apart (non-max suppression), so both spans of a two-piece
    crossing show up instead of just the stronger one."""
    w, h = int(round(tmpl.width * kk)), int(round(tmpl.height * kk))
    if w < 12 or h < 12 or w + 2 > SM['stone'].shape[1] or h + 2 > SM['stone'].shape[0]:
        return []
    aa = np.array(tmpl.resize((w, h), Image.LANCZOS)).astype(int)
    if mir:
        aa = aa[:, ::-1]
    op = aa[..., 3] > 120
    pm = class_masks(aa[..., :3], ART, 10)
    tot = 0.0
    num = np.zeros((SM['stone'].shape[0] - h + 1, SM['stone'].shape[1] - w + 1))
    cov = {}
    for c in ('stone', 'deck', 'lamp'):
        m = (pm[c] & op).astype(float)
        area = int(m.sum())
        cov[c] = area
        if area < 40:
            continue
        tot += W[c] * area
        num += W[c] * fftconvolve(SM[c].astype(float), m[::-1, ::-1], mode='valid')
    if tot < 500:
        return []
    sc = num / tot
    out = []
    sep = sep or max(w, h) // 2
    for _ in range(max(1, peaks)):
        idx = np.unravel_index(np.argmax(sc), sc.shape)
        v = float(sc[idx])
        if v <= 0:
            break
        out.append((v, cov, int(idx[1]), int(idx[0])))
        y0, y1 = max(0, idx[0] - sep), min(sc.shape[0], idx[0] + sep + 1)
        x0, x1 = max(0, idx[1] - sep), min(sc.shape[1], idx[1] + sep + 1)
        sc[y0:y1, x0:x1] = 0.0
    return out


def _agreement(a, op, dx, dy, tol):
    """(frac of both-opaque pixels agreeing within tol, mean abs diff, count)
    for cell `a` against a copy of itself shifted by (dx,dy). Clipped, not
    rolled: wrapping would compare the sheet's opposite edges."""
    H, W = op.shape
    y0, y1 = max(0, -dy), min(H, H - dy)
    x0, x1 = max(0, -dx), min(W, W - dx)
    if y1 - y0 < 8 or x1 - x0 < 8:
        return 0.0, 99.0, 0
    s1, s2 = a[..., :3][y0:y1, x0:x1], a[..., :3][y0 + dy:y1 + dy, x0 + dx:x1 + dx]
    o1, o2 = op[y0:y1, x0:x1], op[y0 + dy:y1 + dy, x0 + dx:x1 + dx]
    both = o1 & o2
    n = int(both.sum())
    if n < 2000:
        return 0.0, 99.0, n
    dd = np.abs(s1[both] - s2[both])
    return float(((dd <= tol).all(axis=1)).mean()), float(dd.mean()), n


def period(name, tol=14, dxr=(8, 240), dyr=(-140, 140), coarse=6, top=5):
    """Self-agreement of a cell against a shifted copy of itself.

    For each shift (dx,dy) the fraction of pixels OPAQUE IN BOTH copies that
    agree within `tol` per channel, plus the mean absolute difference over
    those pixels. The shift that wins is the cell's own period: the engine can
    place a piece there and the art lines up with itself, which is why bridge
    sections OVERLAP instead of being joined at the piece width. Measured over
    the shipped cells it comes out at (110, 57) art px for every one of
    C_BridgeTop_05/06/08/09 and C_BridgeBottom_02/03 — 53-61 % agreement within
    14/255 per channel (70-72 % within 20), mean abs diff 14-20 — so the deck
    pitch is 110/ART.S = 1.71875
    tiles, not the ~4 tiles a piece is wide. NB a pure-x shift (dy = 0) scores
    0.000: the lattice is oblique, sweeping only dx is a false negative.

    Scanned coarse (every `coarse` px) then refined +/-coarse at unit step
    around the best few, which keeps a 300x325 cell to about a second."""
    a = np.asarray(cell_img(name)).astype(int)
    op = a[..., 3] > 8
    seen = {}
    for dy in range(dyr[0], dyr[1] + 1, coarse):
        for dx in range(dxr[0], dxr[1] + 1, coarse):
            seen[(dx, dy)] = _agreement(a, op, dx, dy, tol)
    for (dx, dy), _r in sorted(seen.items(), key=lambda kv: -kv[1][0])[:12]:
        for ry in range(dy - coarse, dy + coarse + 1):
            for rx in range(max(dxr[0], dx - coarse), dx + coarse + 1):
                if (rx, ry) not in seen:
                    seen[(rx, ry)] = _agreement(a, op, rx, ry, tol)
    out = [(f, m, dx, dy, n) for (dx, dy), (f, m, n) in seen.items() if n >= 2000]
    out.sort(key=lambda r: (-r[0], r[1]))
    return out[:top]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('site', nargs='?', default='A')
    ap.add_argument('--piece', default='')
    ap.add_argument('--kmul', default='0.92,1.10')
    ap.add_argument('--step', type=float, default=0.01)
    ap.add_argument('--win', type=int, default=200)
    ap.add_argument('--top', type=int, default=12)
    ap.add_argument('--off', default='')
    ap.add_argument('--box', default='',
                    help='saved-tile rect x0,y0,x1,y1 the bridge may occupy')
    ap.add_argument('--kfix', type=float, default=0.0,
                    help='use exactly this multiple of the camera scale')
    ap.add_argument('--peaks', type=int, default=1,
                    help='report this many local maxima per piece/mirror/scale')
    ap.add_argument('--sep', type=int, default=0,
                    help='non-max suppression radius, px (0 = half the piece)')
    ap.add_argument('--mir', default='01', help='restrict mirrors, e.g. --mir 1')
    ap.add_argument('--period', action='store_true',
                    help='skip the export search and report each cell\'s own period '
                         '(the shift where it agrees with a copy of itself) — that '
                         'is where the deck pitch 110/ART.S comes from')
    args = ap.parse_args()
    Image.MAX_IMAGE_PIXELS = None
    if args.period:
        names = [n for n in CELLS if not n.startswith('G')]
        if args.piece:
            names = args.piece.split(',')
        for n in names:
            r = period(n)
            print(f'  {n:4s} ' + '  '.join(f'({dx:4d},{dy:4d}) {frac:.2f} mad {mad:4.1f}'
                                           for frac, mad, dx, dy, _ in r[:3]))
        return
    (cx, cy), axis, off = SITES[args.site]
    if args.off:
        off = tuple(int(v) for v in args.off.split(','))
    box = tuple(int(v) for v in args.box.split(',')) if args.box else None
    shot = Image.open(SHOT).convert('RGB')
    L, T = cx - args.win, cy - args.win
    a = np.array(shot.crop((L, T, cx + args.win, cy + args.win))).astype(int)
    BM = class_masks(a, SCREEN, 10)
    if box:
        keep = tile_keep(a.shape[:2], off, box, L, T)
        BM = {k: (v & keep) for k, v in BM.items()}
    gx, gy = U(cx, cy)
    s = local_s(gx, gy)
    k0 = s / ART_S
    print('observed class px:', {k: int(v.sum()) for k, v in BM.items()})
    print(f'site {args.site} axis {axis}: centre saved tile '
          f'{gx - GX0 - off[0]:.2f},{gy - GY0 - off[1]:.2f}  '
          f's={s:.2f}px/tile  k_cam={k0:.4f}')
    lo, hi = (float(v) for v in args.kmul.split(','))
    if args.kfix:
        lo = hi = args.kfix
    only = set(args.piece.split(',')) if args.piece else set(CELLS)
    out = []
    for name in sorted(only):
        im = cell_img(name)
        for mir in (0, 1):
            for kk in np.arange(k0 * lo, k0 * (hi + 1e-9), k0 * args.step):
                for v, cov, ox, oy in class_search(BM, im, kk, mir,
                                                   peaks=args.peaks, sep=args.sep):
                    px, py = L + ox, T + oy             # cell top-left, shot px
                    axp, ayp = px + CELLS[name][5] * kk, py + CELLS[name][6] * kk
                    tg = U(px, py)
                    ta = U(axp, ayp)
                    out.append((v, name, mir, kk, px, py,
                                tg[0] - GX0 - off[0], tg[1] - GY0 - off[1],
                                ta[0] - GX0 - off[0], ta[1] - GY0 - off[1], cov))
    out.sort(key=lambda r: (-r[0], r[1]))
    for v, name, mir, kk, px, py, tx, ty, axp, ayp, cov in out[:args.top]:
        print(f'  {name}{"~" if mir else " "} k={kk:.3f} score {v:.3f} '
              f'(stone {cov["stone"]} deck {cov["deck"]} lamp {cov["lamp"]})  '
              f'cell tl tile {tx:6.2f},{ty:6.2f}  ->  ANCHOR tile {axp:6.2f},{ayp:6.2f}')


if __name__ == '__main__':
    main()
