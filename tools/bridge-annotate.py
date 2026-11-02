#!/usr/bin/env python3
"""Annotate screenshot crops of road x river crossings with the tile lattice.

Working tool for the bridge-placement investigation (notes/09 / bridges):
crops the full-res export screenshot around a crossing, upscales it, then
draws the grid->export homography lattice (mapdump/registration/g2e-homog.json)
with READABLE town-tile labels, plus the saved road/river cell rectangles so a
bridge piece can be read off in tile units.

    python3 tools/bridge-annotate.py A            # one site
    python3 tools/bridge-annotate.py              # all known sites

Crops are written to /tmp/opencode/charprobe/bridgeanno_<tag>.png; the copies
the user reviews are copied into mapdump/registration/ (m4-* prefix).
"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOT = os.path.join(ROOT, 'Tapped Out - Simpsons_Screenshot-2025-01-17--19-12-02.png')
HOMOG = os.path.join(ROOT, 'mapdump', 'registration', 'g2e-homog.json')
OUT = '/tmp/opencode/charprobe'

# town tile -> grid tile offset (calib-pairs.txt: grid = town + (12, 136))
GX0, GY0 = 12, 136

# crossing sites: tag -> (screenshot focus px, saved 4x4 cells as town top-lefts,
# road axis 'y' = lane runs along town y / 'x' = along town x, half crop px)
SITES = {
    'A': ((3470, 2880), [(156, 16), (156, 20)], 'y', 175),
    'B': ((3880, 2915), [(168, 48), (172, 48)], 'x', 175),
    'D': ((4520, 2740), [(224, 64), (224, 68)], 'y', 175),
}

_H = json.load(open(HOMOG))['h']


def H(gx, gy):
    h00, h01, h02, h10, h11, h12, h20, h21 = _H
    d = h20 * gx + h21 * gy + 1.0
    return ((h00 * gx + h01 * gy + h02) / d, (h10 * gx + h11 * gy + h12) / d)


def main():
    want = sys.argv[1:] or list(SITES)
    Image.MAX_IMAGE_PIXELS = None
    shot = Image.open(SHOT).convert('RGB')
    font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 15)
    big = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 22)
    for tag in want:
        (cx, cy), cells, axis, half = SITES[tag]
        # tile range visible in the crop, with a small margin
        gs = [H(cx - half, cy - half)]          # dummy to keep flake quiet
        del gs
        import numpy as np
        inv = np.linalg.inv(np.array([_H[:3], _H[3:6], [_H[6], _H[7], 1.0]]))

        def U(x, y):
            v = inv @ np.array([x, y, 1.0])
            return v[0] / v[2], v[1] / v[2]

        gx_lo, gy_lo = U(cx - half, cy + half)
        gx_hi, gy_hi = U(cx + half, cy - half)
        # the two iso diagonals both span x and y; take the conservative box
        corners = [U(cx + sx * half, cy + sy * half) for sx in (-1, 1) for sy in (-1, 1)]
        gx_lo = min(c[0] for c in corners) - 1
        gx_hi = max(c[0] for c in corners) + 1
        gy_lo = min(c[1] for c in corners) - 1
        gy_hi = max(c[1] for c in corners) + 1
        gx_lo, gx_hi = int(gx_lo), int(gx_hi) + 1
        gy_lo, gy_hi = int(gy_lo), int(gy_hi) + 1

        L, T, R, B = cx - half, cy - half, cx + half, cy + half
        SC = 4
        crop = shot.crop((L, T, R, B)).resize(((R - L) * SC, (B - T) * SC), Image.LANCZOS)
        d = ImageDraw.Draw(crop)

        def P(gx, gy):
            x, y = H(gx, gy)
            return ((x - L) * SC, (y - T) * SC)

        for x in range(gx_lo, gx_hi + 1):
            a, b = P(x, gy_lo), P(x, gy_hi)
            cell = (x - GX0) % 4 == 0
            d.line([a, b], fill=(255, 0, 255) if cell else (255, 150, 255), width=3 if cell else 1)
        for y in range(gy_lo, gy_hi + 1):
            a, b = P(gx_lo, y), P(gx_hi, y)
            cell = (y - GY0) % 4 == 0
            d.line([a, b], fill=(0, 220, 220) if cell else (150, 235, 235), width=3 if cell else 1)
        # tile labels (town coords) at tile centres
        for x in range(gx_lo, gx_hi):
            for y in range(gy_lo, gy_hi):
                px, py = P(x + 0.5, y + 0.5)
                if not (0 <= px < crop.width and 0 <= py < crop.height):
                    continue
                d.text((px - 16, py - 9), f'{x - GX0},{y - GY0}', font=font, fill=(255, 255, 0))
        # the saved 4x4 cells
        for (tx, ty) in cells:
            pts = [P(tx + GX0 + dx, ty + GY0 + dy)
                   for dx, dy in ((0, 0), (4, 0), (4, 4), (0, 4))]
            d.polygon(pts, outline=(255, 60, 60))
            d.line([pts[0], pts[1]], fill=(255, 60, 60), width=4)
            c = P(tx + GX0 + 2, ty + GY0 + 2)
            d.text((c[0] - 30, c[1] - 12), f'cell {tx},{ty}', font=big, fill=(255, 60, 60))
        d.text((6, 6), f'{tag}: road axis {axis}, saved cells {cells}', font=big, fill=(255, 255, 255))
        os.makedirs(OUT, exist_ok=True)
        p = os.path.join(OUT, f'bridgeanno_{tag}.png')
        crop.save(p)
        print(p, crop.size)


if __name__ == '__main__':
    main()
