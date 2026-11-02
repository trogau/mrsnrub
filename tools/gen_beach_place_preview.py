#!/usr/bin/env python3
"""Static preview of the Road Lab beach PLACEMENT card (evidence only).

Mirrors what web/viewer/road-lab.js renderBeachPlace() draws, using the same
numbers (manifest tilebox / coverRows / GridTypeRange / Region, terrain.js sea
model, camera.js 2:1 oblique), so the user can eyeball "where those tiles get
applied" without opening a browser.

The answer it exists to show: the coast is TWO SETS, and landinfo.xml says so by
LandEdge filename. The SOUTHERN (below-the-mountains) shore stamps the `Beach`
pair with repeat="-1" — stamp until the edge ends — so that pair is stepped from
the seam (y = -16) south to the end of the ocean frame (y = 512), one continuous
4-tile-deep band. NORTH of the seam the file stamps a DIFFERENT asset,
springfieldheightsnobeach, with the finite repeat="6": six strips and stop. The
seam itself (where the mountain ridge meets the water — the Mountain03 asset) is
a CLAIM, not a measurement: the GridTypeRange rows split there and the region
table puts SHMountains at y -18..0, but the exact row is unverified.

The coast is drawn as top-down columns (528 rows would be a 3000-px strip) plus
one 2:1 oblique section that straddles the seam with the real art of BOTH sets.
"""
import json
import math
import os

from PIL import Image, ImageDraw

ROOT = '/home/dave/projects/mrsnrub'
OUT = os.path.join(ROOT, 'mapdump', 'registration')
M = json.load(open(os.path.join(ROOT, 'web', 'assets', 'city', 'beach-tiles.json')))

SEA = (84, 170, 252, 255)                 # terrain.js SEA_RGB
GRASS = (74, 128, 66, 255)                # road-lab.html canvas ground
SHORE = (77, 208, 225, 90)                # the southern set: shore / buildarea
BUILD = (255, 214, 110, 80)
SHORE_L = (77, 208, 225, 190)
BUILD_L = (255, 214, 110, 180)
HSHORE = (171, 71, 188, 90)               # the northern set: shore / beach+cliff
HBEACH = (139, 195, 74, 80)
HSHORE_L = (171, 71, 188, 200)
HBEACH_L = (139, 195, 74, 190)
GRID = (255, 255, 255, 26)
GRID8 = (255, 255, 255, 60)
SHORELINE = (255, 255, 255, 170)
CLAIM = (255, 183, 77, 220)
ANCHOR = (255, 112, 67, 255)
HANCHOR = (171, 71, 188, 255)
SEAM = (196, 160, 255, 230)
TYPES = {'shoreline': (150, 205, 235, 40), 'beach': (223, 206, 138, 40),
         'cliff': (150, 142, 132, 55)}

COAST = M['coast']['lower']               # the SOUTHERN stretch: seam .. 512
START, END, PITCH = COAST['from'], COAST['to'], COAST['pitchTiles']
ROWS = M['tiles']['shore']['coverRows']   # the rows one strip paints (17)
STRIPS = COAST['strips']                  # ceil(528 / 17) = 32
HI = M['coast']['heights']                # the NORTHERN set, from the file
HPITCH = HI['pitchTiles']                 # its own measured rows (17)
HINST = int(HI['repeat'])                 # repeat="6" — six strips then stop
SPANS = {'lower': ROWS, 'heights': HPITCH}
INSTANCES = [[p[0], p[1], 'lower'] for p in
             ([0, START + i * PITCH] for i in range(STRIPS))]
INSTANCES += [[0, START - (i + 1) * HPITCH, 'heights'] for i in range(HINST)]
X0, X1 = -14, 20
ANIMS = {'lower': [M['tiles']['buildarea']['anim'], M['tiles']['shore']['anim']],
         'heights': [M['tiles']['h_beach']['anim'], M['tiles']['h_shore']['anim']]}
SHEETS = {a: Image.open(os.path.join(ROOT, 'web', M['assets'][a]['sheet'])).convert('RGBA')
          for a in M['assets']}
ASSET_OF = {}
for _t in M['tiles'].values():
    for _n in (_t['anim'], _t.get('unpurchasedAnim')):
        if _n:
            ASSET_OF[_n] = _t['asset']


def tiles_at(ax, ay, set='lower'):
    """The tile-centre test the card uses, against the measured opaque boxes."""
    out = []
    for name in ANIMS[set]:
        b = M['anims'][name]['tilebox']
        for tx in range(math.ceil(b[0] - 0.5 + ax), math.floor(b[2] - 0.5 + ax) + 1):
            for ty in range(math.ceil(b[1] - 0.5 + ay),
                            math.floor(b[3] - 0.5 + ay) + 1):
                out.append((name, tx, ty))
    return out


def blocks(name):
    return M['anims'][name]['frames'][0]


def paints(name):
    """Shore tiles read one colour, the inland piece another — in BOTH sets."""
    return 'shore' in name.lower()


def fill_instances(y0, y1):
    """The strips (of either set) whose painted rows reach into [y0, y1)."""
    return [p for p in INSTANCES if p[1] + SPANS[p[2]] > y0 and p[1] < y1]


def type_bands(d, P, y0, y1):
    """GridTypeRange bands — the engine's own land table, the coverage claim.
    Note the two beach ranges meet at the seam row: the narrow (x 0..4) one is
    the southern set, the wide one (x 0..12 + cliff 12..16) is the Heights one."""
    for r in M['gridtype']['ranges']:
        f = TYPES.get(r['type'])
        if not f:
            continue                        # ocean = the sea fill
        a = max(X0, r['x0'] if r['x0'] is not None else X0)
        b = min(X1, r['x1'] if r['x1'] is not None else X1)
        t0 = max(y0, r['y0'] if r['y0'] is not None else y0)
        t1 = min(y1, r['y1'] if r['y1'] is not None else y1)
        if b > a and t1 > t0:
            d.polygon([*P(a, t0), *P(b, t0), *P(b, t1), *P(a, t1)], fill=f)


def seam_line(d, P, y0, y1):
    """The row where the southern fill stops and the Heights set takes over —
    drawn as the claim it is."""
    if not (y0 < START < y1):
        return
    d.line([*P(X0, START), *P(16, START)], fill=SEAM, width=2)
    a = P(X0, START)
    d.text((a[0] + 2, a[1] - 13),
           'seam y=%d (UNVERIFIED) — south: Beach (repeat=-1) · north: %s (repeat=%s)'
           % (START, HI['set'], HI['repeat']), fill=SEAM)


def panel_topdown(y0, y1, cell=7, tag=''):
    """One column of the coast, top-down (flat grid)."""
    W = (X1 - X0) * cell + 32
    H = (y1 - y0) * cell + 44
    im = Image.new('RGBA', (W, H), (16, 18, 22, 255))
    d = ImageDraw.Draw(im)

    def P(tx, ty):
        return (16 + (tx - X0) * cell, 28 + (ty - y0) * cell)

    d.rectangle([*P(X0, y0), *P(X1, y1)], fill=GRASS)
    d.rectangle([*P(X0, y0), *P(0, y1)], fill=SEA)
    type_bands(d, P, y0, y1)
    for gx in range(X0, X1 + 1):
        d.line([*P(gx, y0), *P(gx, y1)], fill=GRID8 if gx % 8 == 0 else GRID)
    for gy in range(y0, y1 + 1):
        d.line([*P(X0, gy), *P(X1, gy)], fill=GRID8 if gy % 8 == 0 else GRID)
    for p in fill_instances(y0, y1):
        for name, tx, ty in tiles_at(p[0], p[1], p[2]):
            a, b = P(tx, ty), P(tx + 1, ty + 1)
            if p[2] == 'heights':
                fill, line = (HSHORE, HSHORE_L) if paints(name) else (HBEACH, HBEACH_L)
            else:
                fill, line = (SHORE, SHORE_L) if paints(name) else (BUILD, BUILD_L)
            d.rectangle([*a, *b], fill=fill, outline=line)
    d.line([*P(0, y0), *P(0, y1)], fill=SHORELINE, width=2)
    for p in fill_instances(y0, y1):
        col = HANCHOR if p[2] == 'heights' else ANCHOR
        a = P(p[0], p[1])
        d.line([a, P(p[0], p[1] + SPANS[p[2]])], fill=col, width=2)
        d.line([(a[0] - 5, a[1]), (a[0] + 5, a[1])], fill=col, width=2)
        d.line([(a[0], a[1] - 5), (a[0], a[1] + 5)], fill=col, width=2)
        if p[1] % 2 == 0:
            d.text((a[0] + 7, a[1] - 5),
                   ('H strip %d (%d,%d)' if p[2] == 'heights' else 'strip %d (%d,%d)')
                   % ((START - p[1]) // SPANS[p[2]] if p[2] == 'heights'
                      else (p[1] - START) // PITCH, p[0], p[1]),
                   fill=(234, 173, 255, 255) if p[2] == 'heights'
                   else (255, 232, 110, 255))
    seam_line(d, P, y0, y1)
    for gy in range((y0 + 15) // 16 * 16, y1, 16):
        d.text((18, P(-13.6, gy)[1] + 1), 'y%d' % gy, fill=(139, 147, 160, 255))
    d.text((8, 4), 'top-down · y %d..%d · grid tiles · sea west of grid x = 0' % (y0, y1),
           fill=(207, 214, 223, 255))
    if tag:
        d.text((8, 16), tag, fill=(139, 147, 160, 255))
    return im


def panel_iso(strips, zoom=0.42, ix0=-9, ix1=12):
    """A short section with the real art of BOTH sets: 2:1 oblique through the
    same basis the card uses — tile (tx,ty) -> screen (64(tx+ty), 32(ty-tx)) px.
    The window is kept tight around the band: the coast runs DIAGONALLY in this
    projection, so the full X0..X1 view would be thousands of px wide."""
    y0 = min(p[1] for p in strips) - 5
    y1 = max(p[1] for p in strips) + max(SPANS[p[2]] for p in strips) + 5
    s = 64 * zoom
    corners = [(s * (tx + ty), (s / 2) * (ty - tx))
               for tx, ty in ((ix0, y0), (ix1, y0), (ix1, y1), (ix0, y1))]
    minx = min(c[0] for c in corners)
    miny = min(c[1] for c in corners)
    W = int(max(c[0] for c in corners) - minx) + 32
    H = int(max(c[1] for c in corners) - miny) + 44
    im = Image.new('RGBA', (W, H), (16, 18, 22, 255))
    d = ImageDraw.Draw(im)

    def P(tx, ty):
        return (16 + s * (tx + ty) - minx, 28 + (s / 2) * (ty - tx) - miny)

    d.polygon([*P(ix0, y0), *P(0, y0), *P(0, y1), *P(ix0, y1)], fill=SEA)
    d.polygon([*P(0, y0), *P(ix1, y0), *P(ix1, y1), *P(0, y1)], fill=GRASS)
    type_bands(d, P, y0, y1)
    for gx in range(ix0, ix1 + 1):
        d.line([*P(gx, y0), *P(gx, y1)], fill=GRID8 if gx % 8 == 0 else GRID)
    for gy in range(y0, y1 + 1):
        d.line([*P(ix0, gy), *P(ix1, gy)], fill=GRID8 if gy % 8 == 0 else GRID)
    for p in strips:
        for name, tx, ty in tiles_at(p[0], p[1], p[2]):
            if p[2] == 'heights':
                fill, line = (HSHORE, HSHORE_L) if paints(name) else (HBEACH, HBEACH_L)
            else:
                fill, line = (SHORE, SHORE_L) if paints(name) else (BUILD, BUILD_L)
            d.polygon([*P(tx, ty), *P(tx + 1, ty), *P(tx + 1, ty + 1), *P(tx, ty + 1)],
                      fill=fill, outline=line)
    d.line([*P(0, y0), *P(0, y1)], fill=SHORELINE, width=2)
    c = [P(0, y0), P(16, y0), P(16, y1), P(0, y1)]      # width="16" claim, dashed
    for i in range(4):
        a, b = c[i], c[(i + 1) % 4]
        for t in range(0, 100, 12):
            u, v = t / 100.0, (t + 6) / 100.0
            d.line([(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u),
                    (a[0] + (b[0] - a[0]) * v, a[1] + (b[1] - a[1]) * v)],
                   fill=CLAIM, width=2)
    for p in strips:                                     # the pre-sheared art
        o = P(p[0], p[1])                                         # blitted UNSHIFTED
        for name in ANIMS[p[2]]:
            asset = ASSET_OF[name]
            sheet, cells = SHEETS[asset], M['assets'][asset]['cells']
            for ci, x, y, a, b, cc, dd in blocks(name):
                cn, cx, cy, cw, ch = cells[ci]
                crop = sheet.crop((cx, cy, cx + cw, cy + ch))
                if a < 0:
                    crop = crop.transpose(Image.FLIP_LEFT_RIGHT)
                w = max(1, int(round(cw * abs(a) * zoom)))
                h = max(1, int(round(ch * abs(dd) * zoom)))
                crop = crop.resize((w, h))
                im.alpha_composite(crop, (int(round(o[0] + x * zoom)),
                                          int(round(o[1] + y * zoom))))
    for p in strips:
        col = HANCHOR if p[2] == 'heights' else ANCHOR
        a = P(p[0], p[1])
        d.line([a, P(p[0], p[1] + SPANS[p[2]])], fill=col, width=2)
        d.line([(a[0] - 6, a[1]), (a[0] + 6, a[1])], fill=col, width=2)
        d.line([(a[0], a[1] - 6), (a[0], a[1] + 6)], fill=col, width=2)
    seam_line(d, P, y0, y1)
    d.text((8, 4), '2:1 oblique through CAM · %d strips (south pitch %d, north pitch %d)'
           ' · the art blits unshifted, its own tile step IS this projection'
           % (len(strips), PITCH, HPITCH), fill=(207, 214, 223, 255))
    return im


def main():
    span = int(math.ceil((END - START) / 4.0 / 8.0) * 8)   # 4 even columns
    cols = []
    # the first column is the SEAM column: it shows the last rows of the southern
    # fill meeting the six Heights strips (repeat="6") that replace it northward
    north_y0 = START - HINST * HPITCH - 8
    cols.append(panel_topdown(north_y0, START + 8,
                              tag='the seam: %d %s strips (repeat=%s) above, the '
                                  'southern fill below' % (HINST, HI['set'], HI['repeat'])))
    for i in range(4):
        y0 = START + i * span
        y1 = min(END, START + i * span + span) + (8 if i == 3 else 0)
        cols.append(panel_topdown(y0, y1, tag='southern strips %d..%d' % (
            (y0 - START) // PITCH, max(0, (y1 - START - 1) // PITCH))))
    # one oblique section straddling the seam: the last two southern strips and
    # the first three Heights strips, each drawn from its OWN sheet
    at_seam = [p for p in INSTANCES if START - 3 * HPITCH <= p[1] <= START + PITCH]
    iso = panel_iso(at_seam)
    pad = 16
    W = sum(c.width for c in cols) + iso.width + (len(cols) + 2) * pad
    H = max(max(c.height for c in cols), iso.height) + 2 * pad + 56
    out = Image.new('RGBA', (W, H), (24, 27, 32, 255))
    x = pad
    for c in cols:
        out.alpha_composite(c, (x, pad + 56))
        x += c.width + pad
    out.alpha_composite(iso, (x, pad + 56))
    d = ImageDraw.Draw(out)
    lower_tiles = STRIPS * len(tiles_at(0, 0, 'lower'))
    heights_tiles = HINST * len(tiles_at(0, 0, 'heights'))
    d.text((pad, 6), 'Road Lab · beach map placement — the coast is TWO SETS. '
           'SOUTH: %d Beach strips from the seam y=%d to y=%d = %d grid tiles '
           '(LandEdge repeat="%s" = stamp until the edge ends, pitch %d = the rows '
           'one strip paints). NORTH of the seam: %d %s strips = %d grid tiles '
           '(repeat="%s", then stop) — a DIFFERENT asset, not more of these.'
           % (STRIPS, START, END, lower_tiles, M['coast']['repeat'], PITCH,
              HINST, HI['set'], heights_tiles, HI['repeat']),
           fill=(207, 214, 223, 255))
    d.text((pad, 22), 'cyan = southern shore · amber = southern buildarea · violet = '
           'Heights shore · green = Heights beach+cliff (its art reaches 16 tiles '
           'inland where the lower pair is 4) · white line = shoreline (grid x = 0) · '
           'orange/violet = a strip anchor + its %d/%d-row span · dashed amber = '
           'LandEdge width="16" claim · pale bands = GridTypeRange land types'
           % (ROWS, HPITCH), fill=(139, 147, 160, 255))
    d.text((pad, 38), 'the two shores measure the SAME columns (x -4..0), so north of '
           'the seam the Heights set REPLACES the lower tiles rather than stacking over '
           'them · the seam row itself is UNVERIFIED against the map (GridTypeRange '
           'split + the SHMountains y -18..0 region band only say "about here")',
           fill=(196, 160, 255, 255))
    p = os.path.join(OUT, 'm4-beach-placement-preview.png')
    out.save(p)
    print('wrote', p, out.size)


if __name__ == '__main__':
    main()
