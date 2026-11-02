#!/usr/bin/env python3
"""Solve each bridge piece's ANCHOR tile from the export's bridge silhouette.

The class/colour template fits saturated (the export's sage roofs compete with
the bridge art), so this tool instead matches BOUNDING BOXES, which are enough
now that the frame inventory is known: the game draws one bsv3 scene per
4-tile road cell, so the drawn silhouette of a crossing is the union of one or
two known cell rects (tools/fit-bridge.py CELLS) placed at an unknown anchor.

  1. mask the export around the crossing with the bridge palette (sage stone +
     cream lamps — sampled on this screenshot; tree foliage and asphalt are
     excluded), keep the components inside the crossing window;
  2. convert that mask to tile coordinates through the calibrated homography;
  3. for every candidate (cell, mirror), compute that cell's ink rectangle
     relative to its building anchor (the bsv3 block offsets), map art px to
     tiles with the local Jacobian, and solve anchor = mask_centroid -
     ink_centroid; print the implied anchor plus the residual on the two
     extents, so a winner can be read off directly.

    python3 tools/anchor-bridge.py D
    python3 tools/anchor-bridge.py A --piece T08,B02 --min 40
"""
import argparse
import json
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import importlib.util                                          # noqa: E402

_spec = importlib.util.spec_from_file_location(
    'fitbridge', os.path.join(ROOT, 'tools', 'fit-bridge.py'))
_fb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_fb)
CELLS, SITES, H, U, local_s = _fb.CELLS, _fb.SITES, _fb.H, _fb.U, _fb.local_s
GX0, GY0, ART_S, class_masks, SCREEN = _fb.GX0, _fb.GY0, _fb.ART_S, _fb.class_masks, _fb.SCREEN
from extract_assets import rgb_to_rgba                      # noqa: E402,F401


def jac(gx, gy, e=0.5):
    """d(screen px)/d(tile) at a tile point."""
    ax, ay = H(gx + e, gy); bx, by = H(gx - e, gy)
    cx, cy = H(gx, gy + e); dx, dy = H(gx, gy - e)
    return np.array([[(ax - bx) / (2 * e), (ay - by) / (2 * e)],
                     [(cx - dx) / (2 * e), (cy - dy) / (2 * e)]])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('site')
    ap.add_argument('--piece', default='')
    ap.add_argument('--min', type=int, default=40, help='min component px')
    ap.add_argument('--pad', type=int, default=120, help='crop half-size px')
    ap.add_argument('--tol', type=int, default=14)
    args = ap.parse_args()
    Image.MAX_IMAGE_PIXELS = None
    (cx, cy), axis, off = SITES[args.site]
    shot = Image.open(os.path.join(ROOT, 'Tapped Out - Simpsons_Screenshot'
                                   '-2025-01-17--19-12-02.png')).convert('RGB')
    L, T = cx - args.pad, cy - args.pad
    a = np.array(shot.crop((L, T, cx + args.pad, cy + args.pad))).astype(int)
    m = class_masks(a, SCREEN, args.tol)['stone'] | class_masks(a, SCREEN, args.tol)['lamp']
    m = ndimage.binary_closing(m, np.ones((3, 3)))
    lab, n = ndimage.label(m)
    pts = []
    for i in range(1, n + 1):
        ys, xs = np.where(lab == i)
        if len(ys) < args.min:
            continue
        pts.append(np.stack([xs + L, ys + T], 1).astype(float))
    if not pts:
        print('no bridge-like pixels')
        return
    P = np.vstack(pts)
    S = np.array([U(*p) for p in P]) - np.array([GX0 + off[0], GY0 + off[1]])
    x0, y0 = S.min(0)
    x1, y1 = S.max(0)
    print(f'site {args.site}: {len(P)} bridge px in {len(pts)} comps   '
          f'mask tile box x[{x0:.2f},{x1:.2f}] y[{y0:.2f},{y1:.2f}]  '
          f'({x1 - x0:.2f} x {y1 - y0:.2f} tiles)')
    gx, gy = U(cx, cy)
    J = jac(gx, gy)
    Ji = np.linalg.inv(J)
    only = set(args.piece.split(',')) if args.piece else set(CELLS)
    print('  piece  mir  ->  ANCHOR tile      (ink box rel. anchor, tiles)')
    for name in sorted(only):
        slug, x, y, w, h, anc_x, anc_y = CELLS[name]
        for mir in (0, 1):
            # ink rect relative to the anchor, in art px
            if mir:
                ix0, ix1 = -(x + w), -x
            else:
                ix0, ix1 = x, x + w
            iy0, iy1 = y, y + h
            d = np.array([[(ix0 + ix1) / 2, (iy0 + iy1) / 2]]) * (local_s(gx, gy) / ART_S)
            dt = Ji @ (d.T / 1.0)                      # art px -> tile delta
            c = S.mean(0)
            ax_, ay_ = c[0] - dt[0][0], c[1] - dt[1][0]
            bw = (ix1 - ix0) * local_s(gx, gy) / ART_S
            bh = (iy1 - iy0) * local_s(gx, gy) / ART_S
            print(f'  {name:4s}  {"~" if mir else " "}   ({ax_:7.2f},{ay_:7.2f})'
                  f'    w~{abs(bw):.2f} h~{abs(bh):.2f}')


if __name__ == '__main__':
    main()
