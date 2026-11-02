#!/usr/bin/env python3
"""Census the art that only the road-bridge pieces use.

The user's question: is there a different tile where a bridge meets the grass
(i.e. an abutment tile), and are there unused grass tiles that belong to it?

Three offline reads of shipped art, each written to mapdump/registration/ with
the m4- prefix so they sort with the other bridge evidence:

1. `m4-bridge-frames.png` — every bsv3 frame of `bridgetop`/`bridgebottom` on a
   labelled card with its bsv3 anchor marked. The engine ships 8 deck frames and
   only the viewer's rule picks 2 of them; four frames composite a `C_Grass_*`
   cell UNDER the deck cell, which is the abutment art the question asks about.
2. `m4-bridge-grass-match.png` — each `C_Grass_*` cell of the bridge sheet is
   template-matched (alpha-masked normalised correlation, pixel-exact at step 1
   over a local window around the best coarse hit) against the whole ground
   sheet `roadrivertiles-50/images/roadtilesheet.png`. A near-1.0 score means
   the ground sheet already ships that grass; a low score means the art exists
   ONLY in the bridge scene, so no ground tile can substitute for it.
3. `m4-road-cell-census.png` — every ground-sheet lattice cell whose 127x66
   inset box fits the canvas, labelled with its water/grass pixel fractions and
   whether the road rule samples it. This is the "unused grass tile" inventory.

    python3 tools/bridge-grass-census.py
"""
import importlib.util
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))

_spec = importlib.util.spec_from_file_location(
    'gcs', os.path.join(ROOT, 'tools', 'gen_city_sprites.py'))
gcs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gcs)

POOL = gcs.POOL
OUT = os.path.join(ROOT, 'mapdump', 'registration')
SHEET = os.path.join(ROOT, 'web', 'assets', 'dlc', 'roadrivertiles-50',
                     'images', 'roadtilesheet.png')

# lattice constants of terrain.js _sheetTile: the centre of cell (c,r) and the
# 127x66 inset box the engine's RoadDrawer UV quads actually sample.
LATTICE = dict(x0=274, y0=140, dx=135, dy=37, odd=67.5, bw=127, bh=66)

# the 11 cells the road rule picks (terrain.js SHEET_STATES, notes/09 §5)
ROAD_USED = {tuple(v) for v in [[-1, 7], [-1, 5], [-1, 6], [-2, 5], [-1, 4],
                                [-1, 1], [-2, 1], [-1, -1], [-1, 3], [-2, 3],
                                [-1, 2]]}


def card(img, label, sub='', scale=1, mark=None):
    """Annotated card: image (optionally nearest-scaled) + caption + anchor cross."""
    img = img.convert('RGBA')
    if scale != 1:
        img = img.resize((img.width * scale, img.height * scale), Image.NEAREST)
    h = img.height + (26 if label else 0) + (14 if sub else 0) + 8
    c = Image.new('RGBA', (max(img.width + 8, 250), h), (28, 28, 34, 255))
    c.paste(img, (4, 4), img)
    d = ImageDraw.Draw(c)
    y = img.height + 8
    if label:
        d.text((6, y), label, fill=(235, 235, 240, 255))
        y += 16
    if sub:
        d.text((6, y), sub, fill=(150, 190, 235, 255))
    if mark:
        ax, ay = mark[0] * scale, mark[1] * scale
        col = (255, 60, 200, 255)
        for t in range(-12, 13):
            c.putpixel((int(4 + ax) + t, int(4 + ay)), col)
            c.putpixel((int(4 + ax), int(4 + ay) + t), col)
    return c


def grid(cells, cols=4, pad=8):
    if not cells:
        return Image.new('RGBA', (200, 40), (16, 16, 20, 255))
    rows = (len(cells) + cols - 1) // cols
    cw = max(c.width for c in cells)
    ch = max(c.height for c in cells)
    out = Image.new('RGBA', (cols * cw + (cols + 1) * pad,
                             rows * ch + (rows + 1) * pad), (16, 16, 20, 255))
    for i, c in enumerate(cells):
        r, k = divmod(i, cols)
        out.paste(c, (pad + k * (cw + pad), pad + r * (ch + pad)))
    return out


def lattice_boxes(w, h):
    """Lattice cells whose inset box fits a w x h template, as (c, r, left, top)."""
    img = Image.open(SHEET).convert('RGB')
    W, H = img.size
    x0, y0, dx, dy, odd = (LATTICE[k] for k in
                           ('x0', 'y0', 'dx', 'dy', 'odd'))
    out = []
    for r in range(-4, 11):
        for c in range(-4, 7):
            cx = x0 + dx * c + (r % 2) * odd
            cy = y0 + dy * r
            bx, by = cx - w / 2, cy - h / 2
            if bx < 0 or by < 0 or bx + w > W or by + h > H:
                continue
            out.append((c, r, int(round(bx)), int(round(by))))
    return out, img


def slide_scores(tpl_rgba, S, cands, step=1):
    """Alpha-masked mean normalised correlation of `tpl_rgba` at each candidate
    (c, r, left, top). Returns the candidates sorted best-first."""
    g = np.array(tpl_rgba, dtype=np.float64)
    mask = g[..., 3] > 16
    if mask.sum() < 200:
        return []
    gv = g[..., :3][mask]
    g0 = gv - gv.mean(0)
    gn = np.sqrt((g0 * g0).sum(1))
    scored = []
    for c, r, x, y in cands:
        for dy in range(-step, step + 1):
            for dx in range(-step, step + 1):
                win = S[y + dy:y + dy + g.shape[0],
                        x + dx:x + dx + g.shape[1]][mask]
                if win.shape[0] != mask.sum():
                    continue
                w0 = win - win.mean(0)
                den = gn * np.sqrt((w0 * w0).sum(1))
                sc = float(((g0 * w0).sum(1) /
                            np.where(den > 1e-6, den, 1e9)).mean())
                scored.append((sc, c, r, x + dx, y + dy))
    scored.sort(key=lambda t: -t[0])
    return scored


def classify(a):
    """(water, grass) pixel fractions of an RGB array, same thresholds the
    notes/09 §5 census uses."""
    r = a[..., 0].astype(int)
    g = a[..., 1].astype(int)
    b = a[..., 2].astype(int)
    n = a.shape[0] * a.shape[1]
    water = ((b > r + 25) & (b > 110)).sum() / n
    grass = ((g > r + 12) & (g > b + 12)).sum() / n
    return water, grass


def frames_card():
    man = json.load(open(os.path.join(ROOT, 'web', 'assets', 'city',
                                      'city-sprites.json')))['sprites']
    keys = [k for k in sorted(man)
            if k.startswith('bridgetop_f') or k.startswith('bridgebottom_f')]
    cards = []
    for k in keys:
        e = man[k]
        im = Image.open(os.path.join(ROOT, 'web', 'assets', 'city', e['png']))
        cards.append(card(
            im, k, 'anchor (%.2f, %.2f)  cell %s  blocks %d' % (
                e['anchor'][0], e['anchor'][1], e.get('cell'),
                e.get('blocks', 0)), mark=e['anchor']))
    sheet = gcs.load_sheet(POOL / 'bridgetop.rgb', 'bridgetop')
    parsed = gcs.parse_bsv3((POOL / 'bridgetop.bsv3').read_bytes(), 'bridgetop')
    for nm, x, y, w, h in parsed['cells']:
        if not nm.startswith('C_Grass'):
            continue
        crop = sheet.crop((x, y, x + w, y + h))
        a = np.array(crop)
        wat, gra = classify(a)
        cards.append(card(crop, '%s  (%d,%d %dx%d)' % (nm, x, y, w, h),
                          'opaque %d/%d  mean %s  water %.0f%% grass %.0f%%' % (
                              int((a[..., 3] > 16).sum()), w * h,
                              tuple(int(v) for v in
                                    a[..., :3].reshape(-1, 3).mean(0)),
                              100 * wat, 100 * gra), scale=2))
    return grid(cards)


def grass_match_card():
    sheet = gcs.load_sheet(POOL / 'bridgetop.rgb', 'bridgetop')
    parsed = gcs.parse_bsv3((POOL / 'bridgetop.bsv3').read_bytes(), 'bridgetop')
    cards = []
    print('grass provenance (alpha-masked NCC against the ground sheet):')
    for nm, x, y, w, h in parsed['cells']:
        if not nm.startswith('C_Grass'):
            continue
        crop = sheet.crop((x, y, x + w, y + h))
        cands, ground = lattice_boxes(w, h)
        S = np.array(ground.convert('RGB'), dtype=np.float64)
        scored = slide_scores(crop, S, cands, step=2)
        top = scored[:3]
        print('  %-12s %dx%d  lattice candidates %d' % (nm, w, h, len(cands)))
        for sc, c, r, px, py in top:
            print('      best (c%d, r%d) score %.3f at sheet px (%d,%d) %s'
                  % (c, r, sc, px, py,
                     'ROAD-USED' if (c, r) in ROAD_USED else 'unused'))
        cards.append(card(crop, '%s (%dx%d) — best ground matches' % (
            nm, w, h), '  '.join('(c%d,r%d) %.3f' % (t[1], t[2], t[0])
                                 for t in top), scale=2))
        for sc, c, r, px, py in top:
            box = ground.crop((px, py, px + w, py + h))
            cards.append(card(box, 'ground cell (c%d, r%d)' % (c, r),
                              'score %.3f at (%d,%d)  %s' % (
                                  sc, px, py,
                                  'ROAD-USED' if (c, r) in ROAD_USED
                                  else 'unused by the road rule'), scale=2))
    return grid(cards)


def cell_census_card():
    """Every ground lattice cell, labelled, with water/grass fractions."""
    img = Image.open(SHEET).convert('RGB')
    W, H = img.size
    x0, y0, dx, dy, odd = (LATTICE[k] for k in
                           ('x0', 'y0', 'dx', 'dy', 'odd'))
    bw, bh = LATTICE['bw'], LATTICE['bh']
    cards = []
    rows = []
    for r in range(-4, 11):
        for c in range(-4, 7):
            cx = x0 + dx * c + (r % 2) * odd
            cy = y0 + dy * r
            bx, by = cx - bw / 2, cy - bh / 2
            if bx < 0 or by < 0 or bx + bw > W or by + bh > H:
                continue
            box = img.crop((int(round(bx)), int(round(by)),
                            int(round(bx + bw)), int(round(by + bh))))
            a = np.array(box)
            wat, gra = classify(a)
            mean = tuple(int(v) for v in a.reshape(-1, 3).mean(0))
            sd = int(a.std())
            tag = 'ROAD' if (c, r) in ROAD_USED else '-'
            rows.append((c, r, wat, gra, mean, sd, tag))
            cards.append(card(box, 'cell (%d,%d)' % (c, r),
                              'water %.0f%% grass %.0f%% mean %s sd %d %s' % (
                                  100 * wat, 100 * gra, mean, sd, tag),
                              scale=1))
    print('\nground-sheet census (sorted by grass fraction):')
    for c, r, wat, gra, mean, sd, tag in sorted(rows, key=lambda t: -t[3]):
        print('  (%2d,%2d) grass %5.1f%% water %5.1f%% mean %-16s sd %3d %s'
              % (c, r, 100 * gra, 100 * wat, str(mean), sd, tag))
    return grid(cards, cols=6)


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, im in (('m4-bridge-frames.png', frames_card()),
                     ('m4-bridge-grass-match.png', grass_match_card()),
                     ('m4-road-cell-census.png', cell_census_card())):
        p = os.path.join(OUT, name)
        im.save(p)
        print('%s  %dx%d -> %s' % (name, im.width, im.height, p))


if __name__ == '__main__':
    main()
