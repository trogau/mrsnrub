#!/usr/bin/env python3
"""Render the RE'd river (water) tile interpretation for user review.

RiverDrawer is RoadDrawer's subclass and shares its draw body, so the road
cell model (notes/08) applies verbatim to the 11 slots in the river UV table
at .rodata 0x3fc320. This script bakes those slots exactly as the engine GPU
samples them (world square -> UV parallelogram) and writes evidence into
mapdump/registration/ with m4-riv-* prefixes:

  m4-riv-sheet-lattice.png  the shared sheet: river diamonds (cyan) vs road
                            slots (grey) on one lattice
  m4-riv-states.png         per state: raw sheet box | as-sampled bake
  m4-riv-cells.png          engine-model cells (4 quadrant quads, one state
                            each) for the connectivity cases
  m4-riv-wave-atlas.png     the separate WaterAnims overlay asset with its
                            C_Water_ / C_Ripple_ cell rects
  m4-riv-facts.txt          decoded quads, measured coverage, family table

The quads are hardcoded from the engine table (same values web/viewer/
road-lab.js shows); when the disassembly target is present they are re-read
and cross-checked, and a mismatch is reported on stdout.

  python3 tools/gen-water-evidence.py [--binary PATH] [--outdir DIR]
"""
import argparse
import os
import struct
import sys

import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHEET = os.path.join(ROOT, 'web', 'assets', 'dlc', 'roadrivertiles-50',
                     'images', 'roadtilesheet.png')
WAVE_PNG = os.path.join(ROOT, 'web', 'assets', 'dlc', 'game-50',
                        'images', 'wateranimations.png')
WAVE_BSV3 = os.path.join(ROOT, 'web', 'assets', 'dlc', 'game-50',
                         'data', 'wateranimations.bsv3')
DEFAULT_BINARY = '/tmp/opencode/re/lib/arm64-v8a/libscorpio.so'
UV_TABLE = 0x3fc320

# lattice of the shared sheet: slot (col,row) -> centre px (notes/09)
def centre(c, r):
    return (274 + 135 * c + (67.5 if ((r % 2) + 2) % 2 else 0), 140 + 37 * r)

# [T,R,L,B] in sheet px — the float table at 0x3fc320 (x512)
QUADS = [
    [(272.74, 32.58), (336.54, 65.82), (209.32, 65.82), (272.99, 98.79)],
    [(206.07, 441.77), (269.62, 474.79), (142.29, 474.73), (205.95, 507.71)],
    [(272.86, 329.69), (336.73, 362.79), (209.45, 362.72), (272.96, 395.88)],
    [(274.55, 256.04), (337.66, 288.98), (211.52, 289.01), (274.52, 321.80)],
    [(273.87, 181.62), (337.53, 214.75), (210.15, 214.72), (273.90, 247.89)],
    [(272.81, 404.74), (336.49, 437.74), (209.30, 437.77), (272.94, 470.80)],
    [(136.66, 107.56), (200.17, 140.74), (73.27, 140.77), (136.71, 173.90)],
    [(135.38, 34.11), (198.49, 67.03), (72.28, 66.99), (135.55, 99.78)],
    [(69.61, 367.99), (132.74, 401.06), (6.19, 401.02), (69.48, 433.67)],
    [(70.43, 443.16), (133.52, 476.08), (7.74, 475.96), (70.47, 508.53)],
    [(137.26, 405.15), (200.09, 437.92), (74.39, 437.97), (137.22, 470.69)],
]
SLOTS = [(0, -2), (-1, 9), (0, 6), (0, 4), (0, 2), (0, 8),
         (-1, 0), (-1, -2), (-2, 7), (-2, 9), (-1, 8)]
ROAD_SLOTS = [(-1, 7), (-1, 5), (-1, 6), (-2, 5), (-1, 4), (-1, 1),
              (-2, 1), (-1, -1), (-1, 3), (-2, 3), (-1, 2)]
WHAT = [
    'both edges banked - shore corner N+W   (roads state 1 role)',
    'full open-water slab                   (roads state 0 role)',
    'all edges open - plain water interior',
    'one edge banked - bank along W (N-open case)',
    'one edge banked - bank along N (W-open case)',
    'NE both banked - shore corner N+E',
    'NE all open - plain water',
    'NE one edge banked - bank N',
    'WS both banked - shore corner W+S',
    'WS all open - plain water',
    'WS one edge banked - bank W',
]
# quadrant -> (states for the two-edge pass pair, edge names)
FAM = {
    'nw': (('both', 2), ('N', 3), ('W', 4), ('none', 0)),
    'ne': (('both', 6), ('N|E', 7), ('none', 5)),
    'ws': (('both', 9), ('W|S', 10), ('none', 8)),
    'es': (('both', 2), ('E', 3), ('S', 4), ('none', 0)),
}
CELLS = [  # (label, E, W, N, S)
    ('E+W channel', 1, 1, 0, 0),
    ('N+S channel', 0, 0, 1, 1),
    ('E+S bend', 1, 0, 0, 1),
    ('isolated pool', 0, 0, 0, 0),
    ('all open', 1, 1, 1, 1),
]
WAVE_CELLS = [
    ('C_Water_01', 154, 21, 32, 8), ('C_Water_02', 153, 11, 33, 8),
    ('C_Water_03', 153, 1, 33, 8), ('C_Water_04', 79, 37, 34, 8),
    ('C_Water_05', 115, 13, 34, 8), ('C_Water_06', 149, 53, 14, 2),
    ('C_Water_07', 107, 59, 20, 3), ('C_Water_08', 94, 64, 23, 5),
    ('C_Water_09', 35, 18, 34, 6), ('C_Water_10', 75, 17, 33, 5),
    ('C_Ripple_06', 1, 27, 42, 16), ('C_Ripple_07', 35, 1, 38, 15),
    ('C_Ripple_08', 35, 72, 36, 14), ('C_Ripple_09', 117, 23, 35, 14),
    ('C_Ripple_10', 75, 1, 38, 14),
]
BG = (74, 128, 66)          # terrain.js grass
CYAN = (126, 224, 255)
GREY = (150, 150, 158)
YELLOW = (255, 232, 110)


def load_quads(binary):
    """Re-read the engine table when available and cross-check the literals."""
    if not binary or not os.path.exists(binary):
        return QUADS, 'binary not present — using hardcoded table'
    b = open(binary, 'rb').read()
    got = []
    for i in range(11):
        f = struct.unpack_from('<8f', b, UV_TABLE + i * 32)
        if not all(0.0 <= v <= 1.0 for v in f):
            return QUADS, 'table at 0x%x does not decode as UVs' % UV_TABLE
        got.append([(f[k] * 512, f[k + 1] * 512) for k in (0, 2, 4, 6)])
    dev = max(abs(got[i][c][a] - QUADS[i][c][a])
              for i in range(11) for c in range(4) for a in (0, 1))
    return got, 're-read from %s: max deviation vs literals %.3f px' % (
        os.path.basename(binary), dev)


def bake(sheet, quad, size):
    """World square (u,v) samples L + u*(B-L) + v*(T-L) — the engine's
    corner map T->BL R->BR L->TL B->TR."""
    T, R, L, B = quad
    ex, ey = B[0] - L[0], B[1] - L[1]
    sx, sy = T[0] - L[0], T[1] - L[1]
    us = (np.arange(size) + 0.5) / size
    vs = (np.arange(size) + 0.5) / size
    U, V = np.meshgrid(us, vs)
    xs = L[0] + U * ex + V * sx
    ys = L[1] + U * ey + V * sy
    xi = np.clip(np.round(xs).astype(int), 0, sheet.shape[1] - 1)
    yi = np.clip(np.round(ys).astype(int), 0, sheet.shape[0] - 1)
    return sheet[yi, xi]


def coverage(px):
    """Whole-square water fraction + which edge bands are banked (closed)."""
    r, g, bl = px[..., 0], px[..., 1], px[..., 2]
    water = (bl > r + 25) & (bl > 110)
    h, w = water.shape
    band = {'N': water[:h // 4, :].mean(), 'S': water[3 * h // 4:, :].mean(),
            'W': water[:, :w // 4].mean(), 'E': water[:, 3 * w // 4:].mean()}
    closed = ''.join(k for k in 'NSEW' if band[k] < 0.25)
    return water.mean(), closed


def quad_states(passes):
    """The road family table with entries 0/1 exchanged (notes/09)."""
    e, w, n, s = (bool(passes[k]) for k in 'ewns')
    nw = 2 if (n and w) else 3 if n else 4 if w else 0
    ne = 6 if (n and e) else 7 if (n or e) else 5
    ws = 9 if (w and s) else 10 if (w or s) else 8
    es = 2 if (e and s) else 3 if e else 4 if s else 0
    flip = {'nw': False, 'es': True,
            'ne': n and not e, 'ws': w and not s}
    return {'nw': nw, 'ne': ne, 'ws': ws, 'es': es}, flip


def quad_box(quad):
    xs = [p[0] for p in quad]
    ys = [p[1] for p in quad]
    return min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--binary', default=DEFAULT_BINARY)
    ap.add_argument('--outdir', default=os.path.join(ROOT, 'mapdump', 'registration'))
    a = ap.parse_args()
    os.makedirs(a.outdir, exist_ok=True)

    quads, note = load_quads(a.binary)
    print('table check:', note)
    sheet = np.asarray(Image.open(SHEET).convert('RGB')).astype(np.uint8)
    out = lambda n: os.path.join(a.outdir, n)

    # ---- 1. shared lattice -------------------------------------------------
    im = Image.fromarray(sheet).convert('RGB')
    d = ImageDraw.Draw(im)
    for r in range(-5, 10):
        for c in range(-4, 5):
            cx, cy = centre(c, r)
            d.rectangle([cx - 63.5, cy - 33, cx + 63.5, cy + 33], outline=(120, 200, 255))
    for i, (c, r) in enumerate(ROAD_SLOTS):
        cx, cy = centre(c, r)
        d.rectangle([cx - 63.5, cy - 33, cx + 63.5, cy + 33], outline=GREY)
    for i, (c, r) in enumerate(SLOTS):
        cx, cy = centre(c, r)
        d.polygon([(cx - 63.5, cy), (cx, cy - 33), (cx + 63.5, cy), (cx, cy + 33)],
                  outline=CYAN)
        d.text((cx - 61, cy - 31), str(i), fill=CYAN)
    d.text((2, 2), 'roadrivertiles sheet: 11 RiverDrawer slots (cyan diamonds, numbered)'
                   ' vs road slots (grey)', fill=YELLOW)
    im.save(out('m4-riv-sheet-lattice.png'))

    # ---- 2. raw box | as-sampled ------------------------------------------
    rowh, sq = 156, 120      # 156 keeps the "as sampled" caption clear of the next row
    im = Image.new('RGB', (760, rowh * 11 + 24), (16, 18, 22))
    d = ImageDraw.Draw(im)
    d.text((8, 4), 'the 11 river slots — left: raw sheet box  right: the parallelogram the '
                  'GPU samples (bank must sit on the closed edge)', fill=(207, 214, 223))
    y = 22
    for i, q in enumerate(quads):
        bx, by, bw, bh = quad_box(q)
        raw = Image.fromarray(sheet[int(by):int(by + bh + 1), int(bx):int(bx + bw + 1)])
        im.paste(raw.resize((200, 100), Image.NEAREST), (8, y + 14))
        arr = bake(sheet, q, sq)
        im.paste(Image.fromarray(arr), (232, y + 14))
        cov, closed = coverage(arr)
        d.text((8, y), 'state %d  (c,r=%s)  %-46s water %5.1f%%  banked=%s' % (
            i, SLOTS[i], WHAT[i], cov * 100, closed or '-'), fill=(207, 214, 223))
        d.text((232, y + 14 + sq + 2), 'as sampled', fill=(150, 150, 158))
        d.rectangle([8, y + 14, 208, y + 114], outline=(58, 65, 76))
        d.rectangle([232, y + 14, 232 + sq, y + 14 + sq], outline=(58, 65, 76))
        y += rowh
    im.save(out('m4-riv-states.png'))

    # ---- 3. engine-model cells --------------------------------------------
    cw = 148
    im = Image.new('RGB', (len(CELLS) * (cw + 16) + 16, 240), (16, 18, 22))
    d = ImageDraw.Draw(im)
    d.text((8, 4), 'engine model — one 4x4 cell = 4 quadrant quads, each sampling ONE full '
                  'state (RiverDrawer shares RoadDrawer’s draw body 0x1208c10)',
           fill=(207, 214, 223))
    for ci, (lbl, e, w, n, s) in enumerate(CELLS):
        st, flip = quad_states(dict(e=e, w=w, n=n, s=s))
        x0 = 8 + ci * (cw + 16)
        y0 = 26
        d.text((x0, y0 - 14), lbl, fill=(207, 214, 223))
        for qn in ('nw', 'ne', 'ws', 'es'):
            qx = x0 + (cw // 2 if qn in ('ne', 'es') else 0)
            qy = y0 + (cw // 2 if qn in ('ws', 'es') else 0)
            bk = bake(sheet, quads[st[qn]], cw // 2)
            if flip[qn]:
                # engine flip = anti-diagonal reflection (notes/09 §6 step 3:
                # flipped bake O=R, E=-(T-L), S=-(B-L)): world (u,v) samples
                # M(1-v,1-u). A plain u-mirror puts the bank on the wrong
                # edges (2026-10-26 re-check) — do not use it.
                bk = np.ascontiguousarray(np.transpose(bk[::-1, ::-1], (1, 0, 2)))
            im.paste(Image.fromarray(bk), (qx, qy))
        d.rectangle([x0, y0, x0 + cw, y0 + cw], outline=(200, 200, 210))
        d.line([(x0 + cw // 2, y0), (x0 + cw // 2, y0 + cw)], fill=(200, 200, 210))
        d.line([(x0, y0 + cw // 2), (x0 + cw, y0 + cw // 2)], fill=(200, 200, 210))
        d.text((x0, y0 + cw + 3), ' '.join('%s%d%s' % (q, st[q], '*' if flip[q] else '')
                                           for q in ('nw', 'ne', 'ws', 'es')), fill=YELLOW)
    im.save(out('m4-riv-cells.png'))

    # ---- 4. wave atlas -----------------------------------------------------
    wv = Image.open(WAVE_PNG).convert('RGBA')
    scale = 2
    im = Image.new('RGB', (wv.width * scale + 8, wv.height * scale + 96), (40, 80, 140))
    im.paste(wv.resize((wv.width * scale, wv.height * scale), Image.NEAREST), (4, 22))
    d = ImageDraw.Draw(im)
    d.text((4, 4), 'WaterAnims — wateranimations.png, the SEPARATE BGSprite the drawer holds at '
                  '[drawer+0x80] (3 s re-pick, rand() ~50/50)', fill=YELLOW)
    for nm, x, y, w, h in WAVE_CELLS:
        d.rectangle([4 + x * scale, 22 + y * scale, 4 + (x + w) * scale, 22 + (y + h) * scale],
                    outline=YELLOW)
        d.text((4 + x * scale, 22 + (y + h) * scale + 1), nm, fill=YELLOW)
    if os.path.exists(WAVE_BSV3):
        d.text((4, im.height - 16), 'cells from %s (0x0103 scene, parsed exact-to-EOF)'
               % os.path.basename(WAVE_BSV3), fill=(150, 150, 158))
    im.save(out('m4-riv-wave-atlas.png'))

    # ---- 5. facts ----------------------------------------------------------
    lines = ['river tile facts — decoded engine table 0x%x, %s' % (UV_TABLE, note), '']
    for i, q in enumerate(quads):
        cov, closed = coverage(bake(sheet, q, 128))
        lines.append('state %-2d slot(%s,%s)  water %5.1f%%  banked=%-4s  %s' % (
            i, SLOTS[i][0], SLOTS[i][1], cov * 100, closed or '-', WHAT[i]))
        lines.append('         T%s R%s L%s B%s' % tuple(str(tuple(round(v, 2) for v in p)) for p in q))
    lines += ['', 'quadrant family table (roads with 0/1 exchanged):']
    for q, tbl in FAM.items():
        lines.append('  %s: %s' % (q, ', '.join('%s=%d' % t for t in tbl)))
    lines += ['', 'selector 0x1099f8c references all 11 entries (18 adrp+add sites); no',
              'identity fallback entry and no special-flag route (0x1134cfc is never',
              'called), so roads’ "flag -> full slab" path is absent and entries 0/1',
              'have traded roles. The flip byte was re-measured on the water art itself',
              '(2026-10-26): the road emitter’s anti-diagonal reflection, verified by',
              'bank placement — flipped state 0 banks E+S, 7 banks E, 10 banks S.']
    open(out('m4-riv-facts.txt'), 'w').write('\n'.join(lines) + '\n')

    for f in ('m4-riv-sheet-lattice.png', 'm4-riv-states.png', 'm4-riv-cells.png',
              'm4-riv-wave-atlas.png', 'm4-riv-facts.txt'):
        print('wrote', out(f))


if __name__ == '__main__':
    sys.exit(main())
