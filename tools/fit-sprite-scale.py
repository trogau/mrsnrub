#!/usr/bin/env python3
"""M4 item 4: pin the building-sprite world scale S (+ anchor verify) empirically.

The engine's px-per-world-unit constant (notes/06 s10: *PTR_DAT_01bbcac8)
is config-loaded at runtime and statically unreachable, so S is measured
instead of read: the full-res export screenshot (the same image the ground
homography g2e-homog.json was calibrated on) is template-matched against
the extracted city sprites.

Position AND scale are fitted jointly (2026-10-25 lesson: pins derived from
the 4-pair exact homography can sit 100+ px off their building, so a
pin-centred search only ever scores street texture). Scoring is masked
EDGE-NCC over the sprite's bottom band (gradient maps, which — unlike
intensity NCC — are not biased toward whichever template covers the most
smooth ground). Only strong peaks are trusted; the winning (dx, dy) is
reported against the homography pin, so anchor-convention error shows up
as a systematic offset median.

    S = cam_scale_export / k_best,   cam_scale_export = pitch / sqrt(1.25)

(pitch = local export px per tile step from H; TILE hw=1, hh=0.5, so one
tile side = sqrt(1.25) world units -> px-per-world-unit in export space,
the same convention as CAM.scale / drawSprite's k = CAM.scale/ART.S.)

Usage:
    python3 tools/fit-sprite-scale.py [--list] [--top N] [--save-crops]
                                      [--slug S] [--use-shipped]
"""
import argparse
import json
import os
import re
import sys

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None  # the 16200x8370 export is intentionally huge

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXPORT = os.path.join(ROOT, 'Tapped Out - Simpsons_Screenshot-2025-01-17--19-12-02.png')
HOMOG = os.path.join(ROOT, 'mapdump/registration/g2e-homog.json')
SPRITES = os.path.join(ROOT, 'web/assets/city/city-sprites.json')
CITYDIR = os.path.join(ROOT, 'web/assets/city')
TILE_SIDE = (1.0 ** 2 + 0.5 ** 2) ** 0.5   # sqrt(1.25): tile side in world units
GX_OFF, GY_OFF = 12, 136                   # town tile -> calib grid label


def load_map_data():
    src = open(os.path.join(ROOT, 'web/js/map-explorer-data.js'), encoding='utf8').read()
    m = re.search(r'window\.MAP_DATA\s*=\s*', src)
    i = m.end()
    depth = 0
    for j in range(i, len(src)):
        c = src[j]
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                break
    return json.loads(src[i:j + 1])


def make_H(h):
    h00, h01, h02, h10, h11, h12, h20, h21 = h

    def H(gx, gy):
        d = h20 * gx + h21 * gy + 1.0
        return np.array([(h00 * gx + h01 * gy + h02) / d,
                         (h10 * gx + h11 * gy + h12) / d])
    return H


def load_pairs():
    out = []
    for ln in open(os.path.join(ROOT, 'mapdump/registration/calib-pairs.txt')):
        if '|' in ln and not ln.strip().startswith('#'):
            parts = [p.strip() for p in ln.split('|')]
            ex, ey = (float(v) for v in parts[1].split(','))
            gx, gy = (float(v) for v in parts[2].split(','))
            out.append((parts[0], gx, gy, ex, ey))
    return out


def fit_homog_lsq(pairs, drop=('zoo',)):
    """Plain DLT least-squares homography over (gx,gy)->(ex,ey) pairs.
    The shipped g2e-homog.json was an exact 4-pair fit (no validation);
    its robust fit dropped to exactly-determined, so we refit on all
    good pairs (8 pairs, 16 eqs, 8 DOF) for the fit's pins."""
    pts = [(name, gx, gy, ex, ey) for (name, gx, gy, ex, ey) in pairs if name not in drop]
    A = []
    for _, gx, gy, ex, ey in pts:
        A.append([gx, gy, 1, 0, 0, 0, -ex * gx, -ex * gy, -ex])
        A.append([0, 0, 0, gx, gy, 1, -ey * gx, -ey * gy, -ey])
    _, _, Vt = np.linalg.svd(np.array(A))
    h = Vt[-1]
    h = h / h[8]
    Hh = make_H(h[:8])
    res = {name: float(np.hypot(*(Hh(gx, gy) - np.array([ex, ey]))))
           for (name, gx, gy, ex, ey) in pts}
    return h[:8], res


def edges(g):
    gx = np.zeros_like(g)
    gy = np.zeros_like(g)
    gx[:, 1:-1] = g[:, 2:] - g[:, :-2]
    gy[1:-1, :] = g[2:, :] - g[:-2, :]
    return gx, gy


_sprite_cache = {}


def sprites_png(slug):
    if not _sprite_cache:
        _sprite_cache.update({k: v['png'] for k, v in
                              json.load(open(SPRITES))['sprites'].items()})
    return _sprite_cache[slug]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--list', action='store_true', help='list candidates, no fit')
    ap.add_argument('--top', type=int, default=18, help='fit N best buildings')
    ap.add_argument('--save-crops', action='store_true', help='write evidence overlays')
    ap.add_argument('--slug', default=None, help='fit only this slug (diagnostics)')
    ap.add_argument('--use-shipped', action='store_true',
                    help='use shipped g2e-homog.json instead of the LSQ refit')
    ap.add_argument('--min-ncc', type=float, default=0.45,
                    help='trust threshold for a peak (default 0.45)')
    args = ap.parse_args()

    M = load_map_data()
    pairs = load_pairs()
    if args.use_shipped:
        hz = json.load(open(HOMOG))
        H = make_H(hz['h'])
        kept = hz.get('kept') or [n for n, *_ in pairs]
        print('homog: shipped (exact 4-pair fit)')
    else:
        h9, res = fit_homog_lsq(pairs)
        H = make_H(h9)
        kept = [name for name, *_ in pairs if name != 'zoo']
        print('homog: LSQ over', len(kept), 'pairs; residuals',
              {k: round(v, 1) for k, v in res.items()})
    sprites = json.load(open(SPRITES))['sprites']
    pairs_all = {name: (gx, gy) for name, gx, gy, _, _ in pairs}
    pairs_g = [pairs_all[n] for n in kept if n in pairs_all]

    cands = []
    for row in M['buildings']:
        bid, x, z, w, d, flip, px, py = row[:8]
        info = M['binfo'].get(str(bid))
        if not info:
            continue
        slug = info[2]
        key = slug + 'flipped' if (flip and (slug + 'flipped') in sprites) else slug
        if args.slug and key != args.slug:
            continue
        sp = sprites.get(key)
        if not sp or not (4 <= w + d <= 12) or sp['w'] < 120:
            continue
        if 'mountain' in key:                   # skyline props tile/overlap
            continue
        gx, gy = px + GX_OFF, py + GY_OFF
        p0 = H(gx, gy)
        if not (200 < p0[0] < 16000 and 200 < p0[1] < 8170):
            continue
        e1 = H(gx + 1, gy) - p0
        e2 = H(gx, gy + 1) - p0
        pitch = 0.5 * (np.hypot(*e1) + np.hypot(*e2))
        cands.append(dict(bid=bid, name=info[0], slug=key, w=w, d=d,
                          px=px, py=py, artw=sp['w'], arth=sp['h'],
                          anchor=sp['anchor'], p0=p0, pitch=pitch,
                          score_area=(w + d) * sp['w']))
    cands.sort(key=lambda c: -c['score_area'])
    picks, used = [], set()
    for c in cands:
        if c['slug'] in used:
            continue
        if all(np.hypot(*(c['p0'] - q['p0'])) > 130 for q in picks):
            picks.append(c)
            used.add(c['slug'])
        if len(picks) >= args.top:
            break
    if args.list:
        for c in picks:
            print(f"{c['name']:28s} {c['slug']:28s} fp {c['w']:g}x{c['d']:g} "
                  f"art {c['artw']}x{c['arth']} pin=({c['p0'][0]:.0f},{c['p0'][1]:.0f}) "
                  f"pitch={c['pitch']:.1f}")
        print(len(picks), 'picks of', len(cands), 'candidates')
        return

    img = np.asarray(Image.open(EXPORT).convert('RGB'), dtype=np.float32)
    results = []
    for c in picks:
        res = fit_one(img, c)
        if res:
            c.update(res)
            results.append(c)
            ok = 'OK ' if c['ncc'] >= args.min_ncc else 'weak'
            print(f"{ok} {c['name']:28s} S={c['S']:6.2f}  off=({c['dx']:+6.1f},{c['dy']:+6.1f})px "
                  f"= ({c['dx']/c['pitch']:+5.1f},{c['dy']/c['pitch']:+5.1f}) tiles  ncc={c['ncc']:.3f}")
    trusted = [c for c in results if c['ncc'] >= args.min_ncc]
    if not trusted:
        print('no strong peaks — raise --top or check inputs', file=sys.stderr)
        return 1
    S = np.array([c['S'] for c in trusted])
    dx = np.array([c['dx'] for c in trusted]) / np.array([c['pitch'] for c in trusted])
    dy = np.array([c['dy'] for c in trusted]) / np.array([c['pitch'] for c in trusted])
    print(f"\nTRUSTED n={len(S)} (of {len(results)} fits)  "
          f"S median {np.median(S):.2f}  mean {S.mean():.2f}  stdev {S.std():.2f}  "
          f"IQR {np.percentile(S, 25):.2f}..{np.percentile(S, 75):.2f}")
    print(f"pin offset median vs H: dx {np.median(dx):+.2f} tiles  dy {np.median(dy):+.2f} tiles")
    if args.save_crops:
        save_overlays(img, trusted if len(trusted) >= 4 else results)
    return 0


def fit_one(img, c):
    """Hierarchical joint (dx, dy, S) edge-NCC search of c's sprite."""
    try:
        pim = Image.open(os.path.join(CITYDIR, sprites_png(c['slug']))).convert('RGBA')
    except FileNotFoundError:
        return None
    arr = np.asarray(pim, dtype=np.float32)
    alpha = arr[..., 3]
    ys, xs = np.where(alpha > 128)
    if len(xs) == 0:
        return None
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    band_top = y1 - max(6, int(0.35 * (y1 - y0)))      # bottom band (ground rows)
    grey = (arr[..., 0] * 0.299 + arr[..., 1] * 0.587 + arr[..., 2] * 0.114)
    grey = np.where(alpha > 128, grey, grey[alpha > 128].mean())
    gx_t, gy_t = edges(grey)
    tmpl = np.stack([gx_t, gy_t], -1)[band_top:y1, x0:x1, :]
    tmsk = (arr[band_top:y1, x0:x1, 3] > 128)
    if tmsk.sum() < 200:
        return None
    pitch = c['pitch']
    # ROI: biggest plausible template + the whole search window
    kw = pitch / TILE_SIDE / 44.0                       # S down to 44
    WIN = 170
    bx0 = int(c['p0'][0] - c['anchor'][0] * kw) - WIN
    by0 = int(c['p0'][1] - c['anchor'][1] * kw - (y1 - band_top) * kw) - WIN
    bx1 = int(c['p0'][0] + (pim.size[0] - c['anchor'][0]) * kw) + WIN
    by1 = int(c['p0'][1] + (pim.size[1] - c['anchor'][1]) * kw) + WIN
    rx0, ry0 = max(0, bx0), max(0, by0)
    rx1, ry1 = min(img.shape[1], bx1), min(img.shape[0], by1)
    roi = img[ry0:ry1, rx0:rx1]
    if roi.shape[0] < 20 or roi.shape[1] < 20:
        return None
    rg = roi[..., 0] * 0.299 + roi[..., 1] * 0.587 + roi[..., 2] * 0.114
    rgx, rgy = edges(rg)
    RH, RW = rgx.shape

    tmpl_cache = {}

    def make_tmpl(k):
        tw, th = max(8, int(round(tmpl.shape[1] * k))), max(6, int(round(tmpl.shape[0] * k)))
        key = (tw, th)
        if key not in tmpl_cache:
            pack = np.stack([np.clip(tmpl[..., 0] / 4 + 128, 0, 255),
                             np.clip(tmpl[..., 1] / 4 + 128, 0, 255),
                             np.zeros(tmpl.shape[:2])], -1).astype(np.uint8)
            T = np.asarray(Image.fromarray(pack).resize((tw, th), Image.BILINEAR),
                           dtype=np.float32)[..., :2] - 128
            Mk = np.asarray(Image.fromarray((tmsk * 255).astype(np.uint8))
                            .resize((tw, th), Image.NEAREST), dtype=np.float32) > 127
            mm = Mk[..., None]
            n = max(1.0, Mk.sum())
            Tm = (T * mm).sum((0, 1)) / n
            Tv = (T * mm - Tm) * mm
            tmpl_cache[key] = (th, tw, Tv, (Tv * Tv).sum(), Mk)
        return tmpl_cache[key]

    def score(k, tm, dx, dy):
        th, tw, Tv, tss, Mk = tm
        bx = c['p0'][0] - c['anchor'][0] * k + x0 * k + dx
        by = c['p0'][1] - c['anchor'][1] * k + band_top * k + dy
        px0 = int(round(bx)) - rx0
        py0 = int(round(by)) - ry0
        if px0 < 0 or py0 < 0 or px0 + tw > RW or py0 + th > RH:
            return None
        m = Mk[..., None]
        n = max(1.0, Mk.sum())
        Pg = np.stack([rgx[py0:py0 + th, px0:px0 + tw],
                       rgy[py0:py0 + th, px0:px0 + tw]], -1)
        Pm = (Pg * m).sum((0, 1)) / n
        Pv = (Pg * m - Pm) * m
        num = (Pv * Tv).sum()
        den = np.sqrt((Pv * Pv).sum() * tss)
        return num / den if den > 1e-6 else -1.0

    def sweep(S_list, cx, cy, win, step):
        out = []
        for s in S_list:
            k = pitch / TILE_SIDE / s
            tm = make_tmpl(k)
            for dy in range(cy - win, cy + win + 1, step):
                for dx in range(cx - win, cx + win + 1, step):
                    v = score(k, tm, dx, dy)
                    if v is not None:
                        out.append((v, s, dx, dy))
        out.sort(reverse=True)
        dedup = []
        for v, s, dx, dy in out:
            if all(abs(dx - u[2]) + abs(dy - u[3]) + 4 * abs(s - u[1]) > 12 for u in dedup):
                dedup.append((v, s, dx, dy))
            if len(dedup) >= 12:
                break
        return dedup

    peaks = sweep([48, 55, 62, 70, 78, 86], 0, 0, WIN, 6)
    if not peaks:
        return None
    refine = []
    for v, s, dx, dy in peaks[:8]:
        refine += sweep([s + o for o in (-3, -1.5, 0, 1.5, 3)], dx, dy, 7, 2)
    refine.sort(reverse=True)
    if not refine:
        return None
    v2, s2, dx2, dy2 = refine[0]
    v3, s3, dx3, dy3 = v2, s2, dx2, dy2
    fine = sweep([s2 + o / 10.0 for o in range(-5, 6)], dx2, dy2, 2, 1)
    if fine:
        v3, s3, dx3, dy3 = fine[0]
    return dict(S=float(s3), dx=float(dx3), dy=float(dy3), ncc=float(v3),
                peaks=[(round(v, 3), s, dx, dy) for v, s, dx, dy in peaks[:5]])


def save_overlays(img, results):
    """Per building: [fitted S | S=62 | S=64] pasted at the FITTED offset on
    the export crop (evidence for m4 item 4)."""
    from PIL import ImageDraw
    outdir = os.path.join(ROOT, 'mapdump/registration')
    for c in results:
        pim = Image.open(os.path.join(CITYDIR, sprites_png(c['slug']))).convert('RGBA')
        ks = {lab: c['pitch'] / TILE_SIDE / s for lab, s in
              (('fit', c['S']), ('62', 62.0), ('64', 64.0))}
        pxs = {lab: (int(round(c['p0'][0] - c['anchor'][0] * k + c['dx'])),
                     int(round(c['p0'][1] - c['anchor'][1] * k + c['dy'])))
               for lab, k in ks.items()}
        m = 60
        x0 = min(p[0] for p in pxs.values()) - m
        y0 = min(p[1] for p in pxs.values()) - m
        x1 = max(p[0] + int(round(pim.size[0] * k)) for p, k in
                 zip(pxs.values(), ks.values())) + m
        y1 = max(p[1] + int(round(pim.size[1] * k)) for p, k in
                 zip(pxs.values(), ks.values())) + m
        box = (max(0, x0), max(0, y0), min(img.shape[1], x1), min(img.shape[0], y1))
        cw, ch = box[2] - box[0], box[3] - box[1]
        panel = Image.new('RGB', (cw * 3 + 20, ch + 24), (12, 12, 12))
        for i, (lab, k) in enumerate(ks.items()):
            sm = pim.resize((max(2, int(round(pim.size[0] * k))),
                             max(2, int(round(pim.size[1] * k)))), Image.BILINEAR)
            tile = Image.fromarray(img[box[1]:box[3], box[0]:box[2]].astype(np.uint8))
            px, py = pxs[lab]
            tile.paste(sm, (px - box[0], py - box[1]), sm)
            d = ImageDraw.Draw(tile)
            d.rectangle([0, 0, cw - 1, ch - 1], outline=(255, 80, 80))
            d.text((4, 2), f"{lab} S={c['S']:.1f}" if lab == 'fit' else f"S={lab}",
                   fill=(255, 255, 0))
            panel.paste(tile, (i * (cw + 10), 24))
        ImageDraw.Draw(panel).text((4, 4), f"{c['name']}  fitted S={c['S']:.2f} "
                                   f"ncc={c['ncc']:.3f} off=({c['dx']:+.0f},{c['dy']:+.0f})px",
                                   fill=(255, 255, 255))
        panel.save(os.path.join(outdir, f"m4-sfit-{c['slug']}.png"))
    print('overlays ->', outdir)


if __name__ == '__main__':
    sys.exit(main())
