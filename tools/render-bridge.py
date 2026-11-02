#!/usr/bin/env python3
"""Composite candidate bridge pieces onto the full-res export screenshot.

The engine draws a road x river bridge as ORDINARY buildings: `bridgetop`
(8 frames) and `bridgebottom` (2 frames), each a bsv3 scene whose frames are
whole compositions of sheet cells placed relative to the building anchor
(block x,y = float pixel offset from the anchor, notes/09 "Bridges"). What the
frames are (measured off the sheets, mapdump/registration/m4-bridge-art-sheet.png):

    bridgetop f4/f0  C_BridgeTop_08/05 — three/two-lamppost section, piers with
                     arch openings, deck line, and piers hanging 75 px BELOW it:
                     the piece that stands IN WATER;
    bridgetop f5/f7  C_BridgeTop_09/06 — the same with 20 px of pier: the
                     abutment length used over dry ground;
    bridgetop f1/f2/f3/f6 — the same sections plus a grass abutment cell (the
                     export shows the deck art stopping AT the water's edge, so
                     the rule never picks these; they are baked for reference);
    bridgebottom f0/f1 C_BridgeBottom_02/03 — the balustrade wall with square
                     openings plus the lampposts, NOTHING below its origin.

(2026-10-27: the shipped rule uses ONE bridgetop_f4 section per road cell
over water per row, no bridgebottom — the grass frames only with
bridge-sites.py --grass; notes/09 §10. `--hyp rule` composites exactly that.) The viewer draws them
through the same path as every other building (`emitBuilding`): the instance's
position point is projected to the screen, the frame is scaled by k = s / ART.S
and pasted at the anchor.

This tool renders a HYPOTHESIS over a crop of the export, so a composition can
be checked against what the game actually drew. The default hypothesis is the
RULE itself — tools/bridge-sites.py's piece list for the nearest crossing —
so `--hyp rule` is "what the viewer paints" and the side-by-side panel is the
verdict:

    python3 tools/render-bridge.py A                       # the rule, vs the game
    python3 tools/render-bridge.py A --hyp h_t08           # one cell, for RE
    python3 tools/render-bridge.py A --place "bridgetop:4:155.15:19.98,..." \
                                  --off -5,8 --k 0.147

`--off dx,dy` is the site's tile-label correction: measured by matching
the screenshot's per-tile water/asphalt classification against the
decoded road/river layers (tools/measure-bridge.py prints it), because
the global grid->export homography (mapdump/registration/g2e-homog.json,
8 landmarks, RMS 16px) is only that accurate locally.

Renders go to /tmp/opencode/charprobe/rb_<site>_<hyp>.png; the copies for
review are copied to mapdump/registration/ with the m4- prefix.
"""
import argparse
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
from extract_assets import rgb_to_rgba                      # noqa: E402
from gen_city_sprites import parse_bsv3                     # noqa: E402

POOL = '/tmp/opencode/citypool'
SHOT = os.path.join(ROOT, 'Tapped Out - Simpsons_Screenshot-2025-01-17--19-12-02.png')
HOMOG = os.path.join(ROOT, 'mapdump', 'registration', 'g2e-homog.json')
OUT = '/tmp/opencode/charprobe'
_H = json.load(open(HOMOG))['h']
GX0, GY0 = 12, 136                   # grid = saved town tile + (12, 136)
ART_S = 64.0                         # art px per world unit (notes/06)

# site -> (crop centre px, half crop px, road axis, default tile-label offset)
SITES = {
    'A': ((3465, 2905), 130, 'y', (-5, 8)),
    'B': ((3885, 2945), 130, 'x', (-5, 8)),
    'C': ((4657, 2568), 130, 'x', (-5, 8)),
    'D': ((4520, 2755), 130, 'y', (-5, 8)),
}

# A placement is (slug, frame index, saved anchor tile x, z); a '~' suffix on
# the slug means the mirrored instance (what a +x road draws). The default
# hypothesis, 'rule', is tools/bridge-sites.py's own piece list for the site —
# the two rows of sections the viewer paints — so the side-by-side panel reads
# as "viewer vs game" without anyone pasting a --place string. The single-cell
# entries below stay for art RE: they are the only way to see one bsv3 frame on
# its own over the export.
CROSS = {   # site -> (axis, corridor edge tile, water band)  [bridge-sites.py]
    'A': ('y', 156, 16, 23),
    'B': ('x', 48, 168, 175),
    'C': ('x', 48, 252, 255),
    'D': ('y', 224, 64, 71),
}


def rule_placements(site):
    """Every piece of the site's crossing in the viewer's painter's order —
    straight out of the rule the viewer runs."""
    import importlib.util
    p = importlib.util.spec_from_file_location(
        'bridge_sites', os.path.join(ROOT, 'tools', 'bridge-sites.py'))
    m = importlib.util.module_from_spec(p)
    p.loader.exec_module(m)
    axis, c, a, b = CROSS[site]
    hyp = []
    for s in m.bridge_run(axis, c, a, b):
        tilde = '~' if s['mir'] else ''
        hyp.append((s['slug'] + tilde, s['frame'], s['ax'], s['ay']))
    return hyp


HYP = {
    'none':      [],
    'h_t08':     [('bridgetop', 4, 159, 16)],
    'h_t09':     [('bridgetop', 5, 159, 16)],
    'h_t05':     [('bridgetop', 0, 159, 16)],
    'h_t06':     [('bridgetop', 7, 159, 16)],
    'h_b02':     [('bridgebottom', 0, 159, 16)],
    'h_b03':     [('bridgebottom', 1, 159, 16)],
    'h_pair':    [('bridgebottom', 0, 159, 16), ('bridgetop', 4, 159, 16)],
    'h_row':     [p for y in (19.98, 21.70, 23.42, 25.14, 26.86)
                  for p in ((('bridgebottom', 0, 155.15, y)),
                            (('bridgetop', 4, 155.15, y)))],
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


_SC = {}


def scene(slug):
    """(sheet RGBA image, parsed bsv3) for a pool slug, decoded once."""
    if slug not in _SC:
        b = open(os.path.join(POOL, slug + '.rgb'), 'rb').read()
        W, Hh, bpp, rgba, pm = rgb_to_rgba(b, slug)
        sheet = Image.frombytes('RGBA', (W, Hh), rgba)
        p = parse_bsv3(open(os.path.join(POOL, slug + '.bsv3'), 'rb').read(), slug)
        _SC[slug] = (sheet, p)
    return _SC[slug]


def draw_frame(dst, slug, fi, k, px, py, alpha=1.0, mir=0):
    """Paste frame fi of `slug` with its building anchor at screen (px,py).

    mir=1 draws the instance's mirrored form (the viewer's flipState-odd
    case): every block is placed mirrored about the position point, which is
    what emitSpr's negative scale does to a shipped pixel-mirrored twin."""
    sheet, p = scene(slug)
    blocks = p['frames'][fi] if p['v'] == 1 else p['frame0']
    for (ci, x, y, a, bb, c, d) in blocks:
        if not (a and d):
            continue
        nm, cx, cy, cw, ch = p['cells'][ci]
        cell = sheet.crop((cx, cy, cx + cw, cy + ch))
        w, h = max(1, int(round(cw * abs(a) * k))), max(1, int(round(ch * abs(d) * k)))
        cell = cell.resize((w, h), Image.LANCZOS)
        ox, oy = px + x * k, py + y * k
        if (a < 0) ^ mir:
            cell = cell.transpose(Image.FLIP_LEFT_RIGHT)
        if mir:
            ox = px - (x * k) - w
        if alpha < 1.0:
            cell.putalpha(cell.getchannel('A').point(lambda v: int(v * alpha)))
        dst.alpha_composite(cell, (int(round(ox)), int(round(oy))))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('site')
    ap.add_argument('--hyp', default='rule')
    ap.add_argument('--off', default='')
    ap.add_argument('--k', type=float, default=0.0)
    ap.add_argument('--sc', type=int, default=6)
    ap.add_argument('--lattice', type=int, default=1)
    ap.add_argument('--half', type=int, default=0)
    ap.add_argument('--solo', type=int, default=0, help='no side-by-side panel')
    ap.add_argument('--alpha', type=float, default=1.0,
                    help='composite opacity (0.5 = see the game underneath)')
    ap.add_argument('--place', default='',
                    help='override the hypothesis: slug:frame:x:y[,slug:frame:x:y...]')
    args = ap.parse_args()
    hyp = rule_placements(args.site) if args.hyp == 'rule' else HYP[args.hyp]
    if args.place:
        hyp = []
        for tok in args.place.split(','):
            slug, fi, sx, sy = tok.split(':')
            hyp.append((slug, int(fi), float(sx), float(sy)))
    Image.MAX_IMAGE_PIXELS = None
    (cx, cy), half, axis, off = SITES[args.site]
    if args.half:
        half = args.half
    if args.off:
        off = tuple(float(v) for v in args.off.split(','))
    L, T, R, B = cx - half, cy - half, cx + half, cy + half
    shot = Image.open(SHOT).convert('RGB')
    gx, gy = U(cx, cy)
    s = local_s(gx, gy)
    k = args.k or s / ART_S
    sc = args.sc
    crop = shot.crop((L, T, R, B)).convert('RGBA').resize(
        ((R - L) * sc, (B - T) * sc), Image.NEAREST)

    def P(sx, sy):
        """saved tile -> canvas px, with the site's label correction."""
        a, b = H(sx + off[0] + GX0, sy + off[1] + GY0)
        return (a - L) * sc, (b - T) * sc

    # the bridge segments' position points: anchor -> frame cells at k*sc
    for (slug, fi, sx, sy) in hyp:
        mir = slug.endswith('~')
        slug = slug.rstrip('~')
        px, py = P(sx, sy)
        draw_frame(crop, slug, fi, k * sc, px, py, alpha=args.alpha, mir=mir)
        r = 5
        d0 = ImageDraw.Draw(crop)
        d0.line([(px - r, py), (px + r, py)], fill=(255, 0, 0, 255), width=2)
        d0.line([(px, py - r), (px, py + r)], fill=(255, 0, 0, 255), width=2)
        print(f'   placed {slug} f{fi} at saved tile ({sx},{sy}) -> canvas '
              f'({px:.0f},{py:.0f}) = shot px ({L + px / sc:.0f},{T + py / sc:.0f})')

    d = ImageDraw.Draw(crop)
    font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 15)
    if args.lattice:
        cs = [U(x, y) for x in (L, R) for y in (T, B)]
        gl = int(min(c[0] for c in cs)) - 1 - GX0 - off[0]
        gh = int(max(c[0] for c in cs)) + 2 - GX0 - off[0]
        kl = int(min(c[1] for c in cs)) - 1 - GY0 - off[1]
        kh = int(max(c[1] for c in cs)) + 2 - GY0 - off[1]

        def PL(sx, sy):
            return P(sx, sy)
        for x in range(gl, gh + 1):
            d.line([PL(x, kl), PL(x, kh)], fill=(255, 60, 60, 200), width=1)
        for y in range(kl, kh + 1):
            d.line([PL(gl, y), PL(gh, y)], fill=(0, 140, 255, 200), width=1)
        for x in range(gl, gh):
            for y in range(kl, kh):
                a, b = PL(x + 0.1, y + 0.1)
                d.text((a + 2, b - 13), f'{x},{y}', font=font, fill=(255, 255, 0, 255))
    out = crop.convert('RGB')
    # side-by-side with the plain crop for comparison
    plain = shot.crop((L, T, R, B)).convert('RGB').resize(out.size, Image.NEAREST)
    tag = (args.place or args.hyp).replace(':', '').replace(',', '+')
    if args.solo:
        sp = os.path.join(OUT, f'rb_{args.site}_{tag}_solo.png')
        out.save(sp)
        print(sp, out.size, f'k={k:.4f} off={off}')
    combo = Image.new('RGB', (plain.width * 2 + 12, max(plain.height, out.height)), (20, 20, 20))
    combo.paste(plain, (0, 0))
    combo.paste(out, (plain.width + 12, 0))
    dd = ImageDraw.Draw(combo)
    f2 = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 22)
    dd.text((8, 4), 'game', font=f2, fill=(255, 255, 0))
    dd.text((plain.width + 20, 4), f'{args.place or args.hyp}  k={k:.3f}  off={off}', font=f2,
            fill=(255, 255, 0))
    os.makedirs(OUT, exist_ok=True)
    p = os.path.join(OUT, 'rb_%s_%s.png' % (args.site, (args.place or args.hyp).replace(':', '').replace(',', '+')))
    combo.save(p)
    print(p, combo.size, f'k={k:.4f} s={s:.2f}px/tile off={off}')


if __name__ == '__main__':
    main()
