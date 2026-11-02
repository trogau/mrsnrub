#!/usr/bin/env python3
"""Measure the river open-water pack bleed, and check the shipped remedy.

STATUS (2026-10-26): the viewer ships these bakes UNMODIFIED. The speck the user
reported was measured (below), proven by RE to be authentic engine output
(notes/09-road-tiles.md §9), and is now handled by the diagonal-guarded slab in
city-view-pixi.js — a pick change, not a pixel edit. An earlier in-bake scrub
was tried and reverted (it left its own visible mark).

What it does:
  * bakes the 11 river slots x 2 orientations the way bakeSlot does (bilinear
    parallelogram sample, SPEC_SLOT_W x SPEC_SLOT_H + grey pad), reading
    RIVER_QUADS back out of the shipped viewer and cross-checking it against
    the engine's float table at .rodata 0x3fc320;
  * lists, per slot, the non-water pieces inside the world square — the
    neighbour-cell art that leaks into the corner of the three all-open water
    tiles (2 = nw/es, 6 = ne, 9 = ws);
  * renders an all-open 6x6 pond block (the case the user reported) three ways
    into mapdump/registration/: m4-rivbleed-replica.png (engine picks 2/6/9, so
    the leak sits at every interior cell corner), m4-rivpond-slab.png (what the
    viewer draws now — the pick comes from the shipped code through
    tools/verify-riv-slab.cjs --picks, so the replica cannot drift from the
    implementation), and m4-rivpond-guard.png (same pond with one solid river
    cell: the quadrants facing it keep their bank art);
  * with --preview-scrub, also renders m4-rivbleed-scrub-preview.png using the
    REVERTED median-colour scrub, kept here only so the option can be compared.

    python3 tools/river_bleed_check.py [--preview-scrub]
"""
import json
import os
import re
import struct
import subprocess
import sys
from collections import deque

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = '/tmp/opencode/rivbleed'
SHEET = os.path.join(ROOT, 'web', 'assets', 'dlc', 'roadrivertiles-50',
                     'images', 'roadtilesheet.png')
PIXI = os.path.join(ROOT, 'web', 'viewer', 'city-view-pixi.js')
BINARY = '/tmp/opencode/re/lib/arm64-v8a/libscorpio.so'
UV_TABLE = 0x3fc320

# the reverted scrub's knobs — only used with --preview-scrub
RULE = dict(watermin=0.85, uspan=0.50, vspan=0.55, bridge=2, corner=0.30)


def load_rule():
    """Slot geometry from the viewer (bakeSlot's own constants); the scrub
    knobs stay local because that code is not shipped."""
    src = open(PIXI).read()
    slot = re.search(r'var SPEC_SLOT_W = (\d+), SPEC_SLOT_H = (\d+), '
                     r'SPEC_SLOT_PAD = (\d+);', src)
    assert slot, 'SPEC_SLOT_* not found in city-view-pixi.js'
    return [int(v) for v in slot.groups()]


SLOT_W, SLOT_H, PAD = load_rule()              # the viewer's own slot geometry
WATERMIN, USPAN, VSPAN = RULE['watermin'], RULE['uspan'], RULE['vspan']


def load_quads():
    """RIVER_QUADS parsed out of the viewer itself (so the harness checks the
    shipped table), cross-read against the engine's .rodata table."""
    src = open(PIXI).read()
    i = src.index('var RIVER_QUADS = [')
    body = src[src.index('[', src.index('=', i)) + 1:src.index('];', i)]
    lines = []
    for line in body.split('\n'):
        line = line.split('//')[0]
        while '/*' in line:
            a = line.index('/*')
            b = line.index('*/', a) if '*/' in line else len(line)
            line = line[:a] + ' ' + line[b + 2:]
        lines.append(line)
    txt = ',\n'.join(l.strip().rstrip(',') for l in lines if l.strip())
    quads = [[(p[0], p[1]) for p in q] for q in json.loads('[' + txt + ']')]
    assert len(quads) == 11, 'parsed %d river quads from the viewer' % len(quads)
    note = 'RIVER_QUADS parsed from city-view-pixi.js'
    if os.path.exists(BINARY):
        b = open(BINARY, 'rb').read()
        dev = 0.0
        for st in range(11):
            f = struct.unpack_from('<8f', b, UV_TABLE + st * 32)
            for k, corner in enumerate((0, 2, 4, 6)):
                dev = max(dev, abs(f[corner] * 512 - quads[st][k][0]),
                          abs(f[corner + 1] * 512 - quads[st][k][1]))
        note += '; max deviation vs engine table %.3f px' % dev
    return quads, note


def bake(sheet, O, E, S):
    """bakeSlot's world square sampled at pixel centres, bilinear like
    canvas drawImage; returns (SLOT_H, SLOT_W, 3) plus the grey pad."""
    us = (np.arange(SLOT_W) + 0.5) / SLOT_W
    vs = (np.arange(SLOT_H) + 0.5) / SLOT_H
    U, V = np.meshgrid(us, vs)
    xs = O[0] + U * E[0] + V * S[0]
    ys = O[1] + U * E[1] + V * S[1]
    fx, fy = xs - 0.5, ys - 0.5
    x0 = np.clip(np.floor(fx).astype(int), 0, 511)
    y0 = np.clip(np.floor(fy).astype(int), 0, 511)
    x1 = np.clip(x0 + 1, 0, 511)
    y1 = np.clip(y0 + 1, 0, 511)
    tx = np.clip(fx - x0, 0, 1)[..., None]
    ty = np.clip(fy - y0, 0, 1)[..., None]
    a = sheet.astype(np.float32)
    px = (a[y0, x0] * (1 - tx) * (1 - ty) + a[y0, x1] * tx * (1 - ty) +
          a[y1, x0] * (1 - tx) * ty + a[y1, x1] * tx * ty)
    core = np.rint(px).astype(np.uint8)
    cv = np.zeros((SLOT_H + 2 * PAD, SLOT_W + 2 * PAD, 4), np.uint8)
    cv[..., 3] = 255
    cv[..., 0], cv[..., 1], cv[..., 2] = 150, 150, 168        # the grey filler
    cv[PAD:PAD + SLOT_H, PAD:PAD + SLOT_W, :3] = core
    return cv


def scrub(cv, bridge=None, do_scrub=True):
    """The JS rule, ported to numpy: interior-only classification, water gate,
    land grouped with a `bridge`-px dilation (so a nub and the satellites
    behind a hairline of water count as one piece), then core land pieces that
    are corner-sized and corner-hugging are repainted with the median water
    colour. do_scrub=False gives the raw bake for the before/after evidence."""
    if bridge is None:
        bridge = RULE['bridge']
    H, W = cv.shape[:2]
    d = cv.copy()
    water = np.zeros((H, W), bool)
    core = np.zeros((H, W), bool)
    rgb = cv[..., :3].astype(int)
    blue = rgb[..., 2]
    red = rgb[..., 0]
    for y in range(PAD, H - PAD):
        for x in range(PAD, W - PAD):
            if blue[y, x] > red[y, x] + 25 and blue[y, x] > 110:
                water[y, x] = True
            else:
                core[y, x] = True
    wc, lc = int(water.sum()), int(core.sum())
    if wc + lc == 0 or wc < (wc + lc) * WATERMIN or not do_scrub:
        return d, 0, None
    land = core.copy()
    if bridge:
        for dy in range(-bridge, bridge + 1):
            for dx in range(-bridge, bridge + 1):
                if not (dy or dx):
                    continue
                land |= np.roll(np.roll(core, dy, 0), dx, 1)
        land[PAD:PAD] = False                       # np.roll wrapped: undo edges
        land[:PAD] = land[-PAD:] = False
        land[:, :PAD] = land[:, -PAD:] = False
    pix = rgb[water]
    med = tuple(int(np.sort(pix[:, c])[len(pix) >> 1]) for c in range(3))
    seen = np.zeros((H, W), bool)
    erased = 0
    for y in range(PAD, H - PAD):
        for x in range(PAD, W - PAD):
            if not land[y, x] or seen[y, x]:
                continue
            q = deque([(y, x)])
            seen[y, x] = True
            comp = []
            ys = [y, y]
            xs = [x, x]
            while q:
                cy, cx = q.popleft()
                if core[cy, cx]:
                    comp.append((cy, cx))
                    if cy < ys[0]: ys[0] = cy
                    if cy > ys[1]: ys[1] = cy
                    if cx < xs[0]: xs[0] = cx
                    if cx > xs[1]: xs[1] = cx
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        ny, nx = cy + dy, cx + dx
                        if not (PAD <= ny < H - PAD and PAD <= nx < W - PAD):
                            continue
                        if land[ny, nx] and not seen[ny, nx]:
                            seen[ny, nx] = True
                            q.append((ny, nx))
            u0 = (xs[0] - PAD) / SLOT_W
            u1 = (xs[1] + 1 - PAD) / SLOT_W
            v0 = (ys[0] - PAD) / SLOT_H
            v1 = (ys[1] + 1 - PAD) / SLOT_H
            if ((u1 - u0) <= USPAN and (v1 - v0) <= VSPAN and
                    (u0 < RULE['corner'] or u1 > 1 - RULE['corner']) and
                    (v0 < RULE['corner'] or v1 > 1 - RULE['corner'])):
                for cy, cx in comp:
                    d[cy, cx, :3] = med
                erased += len(comp)
    return d, erased, med


def pond(bakes, scale=14, n=6):
    """An all-open water block: every cell passes on all four edges, so the
    render is exactly the four both-pass quadrants tiled — the case that made
    the bleed visible. Returns (n*CS, n*CS, 3) in tile space."""
    CS = 4 * scale
    canvas = np.zeros((n * CS, n * CS, 3), np.uint8)
    canvas[...] = (102, 187, 102)                       # terrain.js grass
    # all-edges-open pick/flip for each quadrant (notes/09 §9)
    plan = (('nw', 2, False, 0, 0), ('ne', 6, False, 2, 0),
            ('ws', 9, False, 0, 2), ('es', 2, True, 2, 2))
    for cy in range(n):
        for cx in range(n):
            for _name, st, fl, du, dv in plan:
                src = bakes[st][1 if fl else 0][PAD:PAD + SLOT_H, PAD:PAD + SLOT_W, :3]
                tile = np.asarray(Image.fromarray(src).resize(
                    (2 * scale, 2 * scale), Image.BILINEAR), np.uint8)
                canvas[cy * CS + dv * scale:cy * CS + dv * scale + 2 * scale,
                       cx * CS + du * scale:cx * CS + du * scale + 2 * scale] = tile
    return canvas


def land_px(img):
    r, g, b = (img[..., i].astype(int) for i in range(3))
    return int(((g > b + 12) & (g > r + 6)).sum())


QUAD_UV = {'nw': (0, 0), 'ne': (2, 0), 'ws': (0, 2), 'es': (2, 2)}
BIG = 4                                          # river cells are 4x4 tiles


def viewer_picks(k, big=BIG, m=15, solid=None):
    """Ask the SHIPPED viewer code what it draws, via the harness in
    tools/verify-riv-slab.cjs (it extracts RIV_FAM / rivStates / rivFlip /
    rivDiagOpen and buildRivCell's neighbour probe out of
    web/viewer/city-view-pixi.js). Keeps this replica from drifting away from
    the implementation it is supposed to show."""
    cmd = ['node', os.path.join(ROOT, 'tools', 'verify-riv-slab.cjs'),
           '--picks=%d' % k, '--big=%d' % big, '--m=%d' % m]
    if solid:
        cmd.append('--solid=' + ','.join('%dx%d' % xy for xy in solid))
    r = subprocess.run(cmd, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def pond_from_picks(cells, k, bakes, scale=14):
    """Render a k x k river block from viewer_picks() output (one entry per
    cell, drawn at its own tile coords), so the picture is exactly the
    quadrant bakes the City View composites."""
    CS = BIG * scale                             # tile width of one river cell
    canvas = np.zeros((k * CS, k * CS, 3), np.uint8)
    canvas[...] = (102, 187, 102)                # terrain.js grass
    for c in cells:
        for qn, (st, fl) in c['q'].items():
            du, dv = QUAD_UV[qn]
            src = bakes[st][1 if fl else 0][PAD:PAD + SLOT_H, PAD:PAD + SLOT_W, :3]
            tile = np.asarray(Image.fromarray(src).resize(
                (2 * scale, 2 * scale), Image.BILINEAR), np.uint8)
            x0 = c['tx'] * scale + du * scale
            y0 = c['ty'] * scale + dv * scale
            canvas[y0:y0 + 2 * scale, x0:x0 + 2 * scale] = tile
    return canvas


def tint_spread(img):
    """How uniform the water reads: per-channel std dev over the region."""
    a = img.reshape(-1, 3).astype(float)
    return [round(float(a[:, c].std()), 1) for c in range(3)]


def pieces(cv):
    """The non-water pieces inside the world square (pad excluded) — i.e. the
    neighbour-cell art that leaked into this bake, in the quad's (u,v) frame."""
    H, W = cv.shape[:2]
    rgb = cv[..., :3].astype(int)
    water = np.zeros((H, W), bool)
    for y in range(PAD, H - PAD):
        for x in range(PAD, W - PAD):
            water[y, x] = (rgb[y, x, 2] > rgb[y, x, 0] + 25) and (rgb[y, x, 2] > 110)
    land = ~water
    land[:PAD] = land[-PAD:] = False
    land[:, :PAD] = land[:, -PAD:] = False
    seen = np.zeros((H, W), bool)
    out = []
    for y in range(PAD, H - PAD):
        for x in range(PAD, W - PAD):
            if not land[y, x] or seen[y, x]:
                continue
            q = deque([(y, x)])
            seen[y, x] = True
            comp = []
            ys = [y, y]
            xs = [x, x]
            while q:
                cy, cx = q.popleft()
                comp.append((cy, cx))
                ys[0] = min(ys[0], cy); ys[1] = max(ys[1], cy)
                xs[0] = min(xs[0], cx); xs[1] = max(xs[1], cx)
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        ny, nx = cy + dy, cx + dx
                        if not (PAD <= ny < H - PAD and PAD <= nx < W - PAD):
                            continue
                        if land[ny, nx] and not seen[ny, nx]:
                            seen[ny, nx] = True
                            q.append((ny, nx))
            if len(comp) >= 8:
                col = tuple(int(v) for v in cv[[c[0] for c in comp],
                                               [c[1] for c in comp]].mean(0))
                out.append(dict(px=len(comp),
                                u0=round((xs[0] - PAD) / SLOT_W, 2),
                                u1=round((xs[1] + 1 - PAD) / SLOT_W, 2),
                                v0=round((ys[0] - PAD) / SLOT_H, 2),
                                v1=round((ys[1] + 1 - PAD) / SLOT_H, 2),
                                colour=col))
    return out, float(water[PAD:H - PAD, PAD:W - PAD].mean())


def main():
    preview = '--preview-scrub' in sys.argv
    os.makedirs(OUT, exist_ok=True)
    sheet = np.asarray(Image.open(SHEET).convert('RGB'))
    quads, note = load_quads()
    manifest = {'note': note, 'pad': PAD, 'w': SLOT_W + 2 * PAD,
                'h': SLOT_H + 2 * PAD, 'slots': []}
    print(note)
    print('bakeSlot geometry: %dx%d + %dpx pad   (viewer ships these bakes raw)'
          % (SLOT_W, SLOT_H, PAD))
    print('state orient  water%  bleed pieces')
    raw = [[None, None] for _ in quads]
    fixed = [[None, None] for _ in quads]
    for st, q in enumerate(quads):
        T, R, L, B = q
        e1 = (B[0] - L[0], B[1] - L[1])
        e2 = (T[0] - L[0], T[1] - L[1])
        for orient, (O, E, S) in enumerate((
                (L, e1, e2),
                (R, (-e2[0], -e2[1]), (-e1[0], -e1[1])))):
            cv = bake(sheet, O, E, S)
            raw[st][orient] = cv
            fixed[st][orient] = scrub(cv)[0] if preview else cv
            tag = '%02d-%d' % (st, orient)
            cv.astype(np.uint8).tofile(os.path.join(OUT, tag + '.in'))
            ps, wc = pieces(cv)
            manifest['slots'].append({'tag': tag, 'state': st, 'orient': orient,
                                      'water': round(wc, 4), 'pieces': ps})
            print('%5d %6d %7.1f  %s' % (st, orient, 100 * wc, ' | '.join(
                'px%d u%.2f-%.2f v%.2f-%.2f %s' % (
                    p['px'], p['u0'], p['u1'], p['v0'], p['v1'], p['colour'])
                for p in ps) or 'clean'))
    json.dump(manifest, open(os.path.join(OUT, 'manifest.json'), 'w'), indent=1)
    print('\n%d slot bakes + manifest -> %s' % (len(manifest['slots']), OUT))

    # ---- user-facing evidence (mapdump/registration, per AGENTS.md) ---------
    ev = os.path.join(ROOT, 'mapdump', 'registration')
    os.makedirs(ev, exist_ok=True)
    before = pond(raw)
    n = before.shape[0] - 0
    n = 6 * 4 * 14                                    # the pond proper, no margin
    Image.fromarray(before).save(os.path.join(ev, 'm4-rivbleed-replica.png'))
    print('all-open pond replica: %d land px in the interior (%.2f%%)' % (
        land_px(before[:n, :n]), 100 * land_px(before[:n, :n]) / n ** 2))
    if preview:
        Image.fromarray(pond(fixed)).save(os.path.join(ev, 'm4-rivbleed-scrub-preview.png'))
        print('reverted-scrub preview: %d land px (%.2f%%)' % (
            land_px(pond(fixed)[:n, :n]), 100 * land_px(pond(fixed)[:n, :n]) / n ** 2))
    worst = max(range(len(quads)), key=lambda st: sum(
        p['px'] for s in manifest['slots'] if s['state'] == st for p in s['pieces']))
    strip = np.repeat(np.repeat(raw[worst][0][PAD:PAD + SLOT_H, PAD:PAD + SLOT_W, :3],
                                6, 0), 6, 1)
    Image.fromarray(strip).save(os.path.join(ev, 'm4-rivbleed-worst.png'))
    print('evidence: m4-rivbleed-replica.png, m4-rivbleed-worst.png (state %d, 6x)%s'
          % (worst, ', m4-rivbleed-scrub-preview.png' if preview else ''))

    # ---- the shipped remedy: the diagonal-guarded slab (notes/09 §9) --------
    # Same 6x6 all-open pond, but drawn from what city-view-pixi.js NOW picks:
    # an all-open quadrant whose diagonal neighbour is open water toward us on
    # both faces takes state 1 (the 100%-water slab) instead of the both-pass
    # tiles, so the pond interior has neither the bleed nub nor the 2/6/9 tint
    # grid. The pond edge keeps 2/6/9 — there the corner IS the shoreline art.
    K, SCALE = 6, 14
    slab = pond_from_picks(viewer_picks(K), K, raw, SCALE)
    lo, hi = BIG * SCALE, (K - 1) * BIG * SCALE          # fully surrounded cells
    core_s, core_e = slab[lo:hi, lo:hi], before[lo:hi, lo:hi]
    Image.fromarray(slab).save(os.path.join(ev, 'm4-rivpond-slab.png'))
    lp_s, lp_e = land_px(core_s), land_px(core_e)
    area = core_s.shape[0] * core_s.shape[1]
    print('\npond interior (%d cells, %d px):' % ((K - 2) ** 2, area))
    print('  engine-true  m4-rivbleed-replica.png  land %5d px (%.2f%%)  tint sd %s'
          % (lp_e, 100.0 * lp_e / area, tint_spread(core_e)))
    print('  guarded slab m4-rivpond-slab.png      land %5d px (%.2f%%)  tint sd %s'
          % (lp_s, 100.0 * lp_s / area, tint_spread(core_s)))
    assert lp_s == 0, 'the guarded pond still leaks land pixels: %d' % lp_s
    assert max(tint_spread(core_s)) < max(tint_spread(core_e)), \
        'the guarded pond is not more uniform than the engine-true one'

    # and the guard itself: one solid river cell inside the pond keeps the
    # corner art on the quadrants that face it (the bank belongs there)
    GK = 8
    guard = pond_from_picks(viewer_picks(GK, solid=[(4 * 4, 4 * 4)]), GK, raw, SCALE)
    Image.fromarray(guard).save(os.path.join(ev, 'm4-rivpond-guard.png'))
    st_solid = {}
    for c in viewer_picks(GK, solid=[(4 * 4, 4 * 4)]):
        if abs(c['tx'] - 16) <= BIG and abs(c['ty'] - 16) <= BIG:
            st_solid[(c['tx'], c['ty'])] = c['q']
    kept = sorted({v[0] for q in st_solid.values() for v in q.values() if v[0] != 1})
    print('  guard check  m4-rivpond-guard.png: around the solid cell the picks '
          'stay %s' % kept)
    assert any(v[0] != 1 for q in st_solid.values() for v in q.values()), \
        'the diagonal guard slabs everything, even facing a solid cell'
    print('evidence: m4-rivpond-slab.png, m4-rivpond-guard.png')


if __name__ == '__main__':
    main()
