#!/usr/bin/env python3
"""Emit web/assets/city/beach-tiles.json: the FIXED coast beach tiles.

The tiles that line the ocean/land boundary in-game are not RoadMap tiles —
they are never paintable and never in the save (the SAND layer is engine
filler noise, notes/01). They are `LandEdge` strips the engine draws itself
along the map edge, declared in gamescripts landinfo.xml <LandSprite>:

    <LandEdge filename="Beach" direction="y" culling="left" width="16"
              offsety="-1" repeat="-1" animname="BEACHSHORE1"
              unpurchased_animname="BEACHSHORE2" purchase_grid_col="-1"
              reverse_render="true"/>
    <LandEdge filename="Beach" ... animname="BEACHBUILDAREA1"
              unpurchased_animname="BEACHBUILDAREA2" reverse_render="true"/>

so the two tile types of the bottom (below-the-mountains) set are:

    BEACHSHORE1/2      the water's edge: sand + wavy shoreline + animated
                       foam (C_Wave_*) + seaweed          (20 frames)
    BEACHBUILDAREA1/2  the buildable sand behind it, with the grass edge
                       on the inland side + rocks         (20 frames)

( /2 is the duller UNPURCHASED-plot variant. BEACHBORDEROVERLAY — the green
cliff/rock cap — is the map-BORDER overlay, kept in the manifest for context
but not one of the two coast types. The upper set above the mountains is a
different asset, springfieldheightsnobeach, deferred.)

The art itself ships as a building-sprite bsv3 asset, `Beach`:

    <pack>/data/beach.bsv3   5 anims over one 2048x1024 sheet
    <pack>/images/beach.png  the sandy-diamond sheet

This tool parses it with gen_city_sprites.parse_bsv3 (0x0103 scene: cells =
sheet crop rects, frames = block lists of (cell, x, y, 2x2 matrix)) and
writes one manifest the Road Lab blits per frame.

Geometry: unlike the pier/boardwalk tiles (notes/09 §12) this art is NOT
tile-space — it is pre-sheared oblique art: the LandEdge is blitted in
screen space at 64 art px per town tile (the same 64 px/tile the billboards
use, city-sprites.json), which is why the shoreline already runs at 2:1.
Block x/y are the crop's TOP-LEFT in 100-tier sheet px, the (a b;c d) matrix
is a scale (+ a<0 mirror), and the engine draws the block list in REVERSED
order — so `frames` is stored already reversed, array order = draw order.

Usage:
  python3 tools/gen_beach_tiles.py                 # write the manifest
  python3 tools/gen_beach_tiles.py --evidence      # + mapdump/registration/m4-beach-*.png
"""

import argparse
import importlib.util
import json
import math
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_spec = importlib.util.spec_from_file_location(
    'gen_city_sprites', os.path.join(ROOT, 'tools', 'gen_city_sprites.py'))
gcs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gcs)

OUT = os.path.join(ROOT, 'web', 'assets', 'city', 'beach-tiles.json')
EVID_DIR = os.path.join(ROOT, 'mapdump', 'registration')

LANDINFO = os.path.join(ROOT, 'web', 'assets', 'dlc', 'gamescripts-r497432',
                        'data', 'landinfo.xml')

# The coast is TWO sets, and landinfo.xml says so by `filename`: the lower
# (below-the-mountains) coast stamps `Beach`, the northern Springfield Heights
# coast stamps `springfieldheightsnobeach`. Both are <LandEdge> strips the
# engine places itself; neither is paintable and neither is in the save.
# Tiles are keyed by a lab-friendly name; `anim` is the manifest anim key
# (the Heights keys are namespaced — the two bsv3s both carry a
# case-insensitive "beachshore1").
ASSETS = {
    'beach':   {'bsv3': 'beach.bsv3', 'png': 'beach.png'},
    'heights': {'bsv3': 'springfieldheightsnobeach.bsv3',
                'png': 'springfieldheightsnobeach.png'},
    # the `Land` set: the far-north mountain row (+ its clouds), the rocks
    # where it meets the water, and the shoreline north of the Heights
    'land':    {'bsv3': 'land.bsv3', 'png': 'land.png'},
}
# manifest anim key per asset (two bsv3s carry case-insensitive twins)
ANIM_NS = {'beach': '', 'heights': 'heights.', 'land': 'land.'}
TILES = {
    'shore':     {'asset': 'beach', 'anim': 'beachShore1',
                  'unpurchased': 'beachShore2', 'landedge': 'BEACHSHORE1',
                  'type': 'coast'},
    'buildarea': {'asset': 'beach', 'anim': 'beachBuildArea1',
                  'unpurchased': 'beachBuildArea2', 'landedge': 'BEACHBUILDAREA1',
                  'type': 'coast'},
    'border':    {'asset': 'beach', 'anim': 'beachBorderOverlay',
                  'unpurchased': None, 'landedge': 'BEACHBORDEROVERLAY',
                  'type': 'border'},
    'h_shore':   {'asset': 'heights', 'anim': 'heights.BeachShore1',
                  'unpurchased': 'heights.BeachShore2', 'landedge': 'beachshore1',
                  'type': 'coast'},
    'h_beach':   {'asset': 'heights', 'anim': 'heights.Beach1',
                  'unpurchased': 'heights.Beach2', 'landedge': 'beach1',
                  'type': 'coast'},
    'h_overlay': {'asset': 'heights', 'anim': 'heights.BeachMtnOverlay',
                  'unpurchased': None, 'landedge': 'beachmtnoverlay',
                  'type': 'overlay'},
    # Land: direction="x" MOUNTAINS walks the north edge from y -112 (offsety
    # -7 blocks) east; MOUNTAINSTOWATER is its single water-end stamp;
    # SHORELINE2 (direction y, offsety -10, repeat 3) is the coast north of
    # the Heights beach, behind the ridge
    'n_mountains': {'asset': 'land', 'anim': 'land.mountains',
                    'unpurchased': None, 'landedge': 'MOUNTAINS',
                    'type': 'mountains'},
    'n_mtnwater':  {'asset': 'land', 'anim': 'land.mountainsTOwater',
                    'unpurchased': None, 'landedge': 'MOUNTAINSTOWATER',
                    'type': 'mountains'},
    'n_shore':     {'asset': 'land', 'anim': 'land.shoreline2',
                    'unpurchased': None, 'landedge': 'SHORELINE2',
                    'type': 'coast'},
}


def pack_dir(asset='beach'):
    """Newest tutorialgame-100 pack that carries data/<asset bsv3>."""
    dlc = os.path.join(ROOT, 'web', 'assets', 'dlc')
    want = ASSETS[asset]['bsv3']
    best = None
    for name in os.listdir(dlc):
        m = re.match(r'tutorialgame-100-r(\d+)$', name)
        if not m:
            continue
        if not os.path.exists(os.path.join(dlc, name, 'data', want)):
            continue
        rev = int(m.group(1))
        if best is None or rev > best[0]:
            best = (rev, name)
    if not best:
        raise SystemExit('no tutorialgame-100 pack with data/%s' % want)
    return best[1]


def landedge_attrs(animname):
    """The <LandEdge ... animname="X"> attributes from landinfo.xml — the
    <LandSprite> set first (the one the live viewer model uses), falling back
    to <AlternateLandSprite> (where BEACHBORDEROVERLAY lives). Returns
    (attrs, source-block-name)."""
    s = open(LANDINFO, encoding='utf-8-sig').read()
    for block in ('LandSprite', 'AlternateLandSprite'):
        parts = s.split('<' + block, 1)
        if len(parts) < 2:
            continue
        sprite = parts[1].split('</' + block + '>', 1)[0]
        # self-closing edges AND ones with <Requirement> children: MOUNTAINS
        # comes twice, Snow=1 (with an A2CEE2 sky background) and Snow=0. The
        # default season is the Snow=0 one; the snow variant's background is
        # kept as `snowBg` (it is the file's own colour for behind the ridge)
        found, snow = None, None
        for m in re.finditer(r'<LandEdge\b([^>]*?)(?:/>|>(.*?)</LandEdge>)', sprite, re.S):
            attrs = dict(re.findall(r'(\w+)="([^"]*)"', m.group(1)))
            if attrs.get('animname') != animname:
                continue
            body = m.group(2) or ''
            if re.search(r'key="Settings_Config:Settings:Snow" value="1"', body):
                snow = attrs
            elif found is None:
                found = attrs
        if found is not None:
            if snow and snow.get('bgColor'):
                found = dict(found, snowBgColor=snow['bgColor'])
            return found, block
    raise SystemExit('landinfo.xml has no LandEdge animname=%s' % animname)


def springfield_landinfo():
    """The <LandInfo id="1" name="Springfield"> element text (the other LandInfo
    is Krustyland, whose edges are parking lots, not coast)."""
    s = open(LANDINFO, encoding='utf-8-sig').read()
    parts = s.split('<LandInfo')
    for p in parts[1:]:
        if re.search(r'^[^>]*\bname="Springfield"', p, re.S):
            return p.split('</LandInfo>', 1)[0]
    raise SystemExit('landinfo.xml has no Springfield LandInfo')


def gridtype_ranges():
    """<GridTypeMap base_type="grass"><GridTypeRange .../></GridTypeMap> — the
    engine's OWN per-grid-cell land table. This is the authority on how far the
    beach goes: a range with only y_start (or only y_end) is unbounded that way,
    i.e. it runs the whole remaining coast. Missing bounds are kept as None."""
    out = []
    land = springfield_landinfo()
    m = re.search(r'<GridTypeMap\b([^>]*)>(.*?)</GridTypeMap>', land, re.S)
    if not m:
        raise SystemExit('landinfo.xml: no GridTypeMap')
    base = dict(re.findall(r'(\w+)="([^"]*)"', m.group(1))).get('base_type')
    for r in re.finditer(r'<GridTypeRange\b([^>]*)/>', m.group(2)):
        a = dict(re.findall(r'(\w+)="([^"]*)"', r.group(1)))
        num = lambda k: int(a[k]) if k in a else None      # noqa: E731
        out.append({'type': a.get('type'), 'x0': num('x_start'), 'x1': num('x_end'),
                    'y0': num('y_start'), 'y1': num('y_end')})
    return base, out


def edge_inventory():
    """Every <LandEdge> of the Springfield land, as attribute dicts. Kept in the
    manifest because the repeat values are only meaningful side by side:
    edges of a KNOWN fixed length carry a finite repeat (Krustyland's
    HIGHWAYFENCE_A repeat=13, TOPRIGHT_B repeat=12, the Heights beach repeat=6,
    the single MOUNTAINSTOWATER cap repeat=1), while the edges that run the
    whole map carry repeat="-1" (MOUNTAINS x2, the Mountains_Standard wall, and
    BOTH beach strips). So -1 = stamp until the edge ends, not a fixed count."""
    out = []
    land = springfield_landinfo()
    for block in ('LandSprite', 'AlternateLandSprite'):
        parts = land.split('<' + block, 1)
        if len(parts) < 2:
            continue
        body = parts[1].split('</' + block + '>', 1)[0]
        for m in re.finditer(r'<LandEdge\b([^>]*)/>', body):
            a = dict(re.findall(r'(\w+)="([^"]*)"', m.group(1)))
            out.append({'block': block,
                        'animname': a.get('animname'), 'filename': a.get('filename'),
                        'direction': a.get('direction'), 'culling': a.get('culling'),
                        'width': a.get('width'), 'repeat': a.get('repeat'),
                        'padding': a.get('padding')})
    return out


def blocks_of(parsed, frame):
    """Frame `frame`'s block list in ENGINE DRAW order (reversed list), as
    [cellIndex, x, y, a, b, c, d] tuples."""
    return [[ci, round(x, 2), round(y, 2), a, b, c, d]
            for ci, x, y, a, b, c, d in reversed(parsed['frames'][frame])]


def bounds_of(parsed, frame):
    xs, ys = [], []
    for ci, x, y, a, b, c, d in parsed['frames'][frame]:
        _, cx, cy, cw, ch = parsed['cells'][ci]
        xs += [x, x + cw * abs(a)]
        ys += [y, y + ch * abs(d)]
    x0, y0, x1, y1 = min(xs) - 4, min(ys) - 4, max(xs) + 4, max(ys) + 4
    return [round(x0, 2), round(y0, 2), round(x1 - x0, 2), round(y1 - y0, 2)]


def tile_basis(ax, ay, s=64):
    """art px offset from the strip's anchor -> (inland tx, along-ty) grid
    tiles. The ground basis is camera.js (ORIENT fx=1, fy=-1, swap=1, the
    canonical 2:1 oblique at 64 px/unit): +1 tile in y steps the screen by
    (+64, +32) px and +1 tile in x by (+64, -32) px, so the inverse of that
    pair is tx = (ax/64 - ay/32)/2, ty = (ax/64 + ay/32)/2. The pre-sheared
    LandEdge art lives in exactly this screen space, which is what makes the
    mapping exact rather than fitted."""
    return (ax / s - ay / (s / 2)) / 2.0, (ax / s + ay / (s / 2)) / 2.0


def opaque_tilebox(sheet, blocks, s=64, stride=2, alpha=16):
    """Bounding box, in GRID TILES from the anchor, of the OPAQUE pixels of a
    frame (not the block rects: the rects include transparent sea/sky, which
    inflates the box). This is what says which map tiles a strip covers."""
    from PIL import Image                                   # noqa: F401
    txs, tys = [], []
    for ci, x, y, a, b, c, d in blocks:
        _, cx, cy, cw, ch = sheet['cells'][ci]
        crop = sheet['img'].crop((cx, cy, cx + cw, cy + ch))
        if a < 0:
            crop = crop.transpose(Image.FLIP_LEFT_RIGHT)
        w = max(1, int(round(cw * abs(a))))
        h = max(1, int(round(ch * abs(d))))
        crop = crop.resize((w, h))
        px = crop.split()[3].load()
        for yy in range(0, h, stride):
            for xx in range(0, w, stride):
                if px[xx, yy] > alpha:
                    tx, ty = tile_basis(x + xx, y + yy, s)
                    txs.append(tx)
                    tys.append(ty)
    if not txs:
        raise SystemExit('opaque_tilebox: frame has no opaque pixels')
    return [round(min(txs), 3), round(min(tys), 3),
            round(max(txs), 3), round(max(tys), 3)]


def load_asset(asset):
    """Parse one coast asset (the lower `Beach` bsv3 or the Heights one) with
    its sheet open, so the opaque footprints can be measured from both."""
    from PIL import Image
    pack = pack_dir(asset)
    base = os.path.join(ROOT, 'web', 'assets', 'dlc', pack)
    bsv3 = ASSETS[asset]['bsv3']
    parsed = gcs.parse_bsv3(open(os.path.join(base, 'data', bsv3), 'rb').read(), bsv3)
    if parsed['v'] != 1:
        raise SystemExit('%s: expected a 0x0103 scene' % bsv3)
    sheet = {'img': Image.open(os.path.join(base, 'images',
                                            ASSETS[asset]['png'])).convert('RGBA'),
             'cells': parsed['cells']}
    return pack, parsed, sheet


def land_blocks():
    """<LandBlockSize>/<LandBlockPosition>/<NumExtraViewableBlocks> of the
    Springfield land, in 16-tile blocks — the frame the LandEdge offsets count
    in, and where a repeat="-1" edge along x ends (position + size)."""
    t = springfield_landinfo()
    def tag(name):
        m = re.search(r'<%s\b([^>]*)/>' % name, t)
        return dict(re.findall(r'(\w+)="([^"]*)"', m.group(1))) if m else {}
    size, pos, extra = tag('LandBlockSize'), tag('LandBlockPosition'), tag('NumExtraViewableBlocks')
    return {'tiles': 16,
            'x': int(pos.get('x', 0)), 'y': int(pos.get('y', 0)),
            'w': int(size.get('x', 0)), 'h': int(size.get('y', 0)),
            'extra': {k: int(v) for k, v in extra.items()}}


def regions():
    """<Region> bands of the Springfield land — the only place the file states
    how far north the coast goes. The mountain band (SHMountains y -18..0) sits
    between the town (Springfield y 4..700) and Springfield Heights (SH y
    -108..-18), so the coast has a SOUTHERN shore and a NORTHERN one, and a
    beach set that stops at the mountains stops at y about -16 (which is exactly
    where GridTypeMap splits its two beach ranges)."""
    out = []
    for m in re.finditer(r'<Region\b([^>]*)/?>', springfield_landinfo()):
        a = dict(re.findall(r'(\w+)="([^"]*)"', m.group(1)))
        if not a.get('name'):
            continue
        out.append({'name': a['name'].strip(), 'x0': int(a['x1']), 'y0': int(a['y1']),
                    'x1': int(a['x2']), 'y1': int(a['y2'])})
    return out


def build():
    pack = pack_dir('beach')
    base = os.path.join(ROOT, 'web', 'assets', 'dlc', pack)
    parsed = gcs.parse_bsv3(open(os.path.join(base, 'data', 'beach.bsv3'),
                                 'rb').read(), 'beach.bsv3')
    if parsed['v'] != 1:
        raise SystemExit('beach.bsv3: expected a 0x0103 scene')

    man = {
        'gen': 'tools/gen_beach_tiles.py',
        'source': 'landinfo.xml <LandSprite>/<AlternateLandSprite> <LandEdge> — '
                  'the game places these itself at the ocean/land boundary; '
                  'they are not RoadMap tiles and the save holds no beach cells',
        'pxPerTile': 64,
        'note': 'pre-sheared oblique art: blit blocks in screen space at '
                'sheet px x (zoom x 64/64), array order = engine draw order; '
                'a<0 mirrors the crop about its x',
        'basis': 'grid tile (tx,ty) from the anchor = screen (64(tx+ty), '
                 '32(ty-tx)) px — camera.js ORIENT {1,-1,1} at 64 px/unit; '
                 'inverse tx=(ax/64-ay/32)/2, ty=(ax/64+ay/32)/2. So +y is '
                 'the along-coast axis and +x the inland axis, and tileBox '
                 'below is measured from the OPAQUE art, not the block rects',
        'assets': {},
        'anims': {},
        'tiles': {},
    }
    # BOTH coast assets: the lower `Beach` pack and the Heights one. The Heights
    # anims are namespaced `heights.` because the two bsv3s carry
    # case-insensitive twins (beachShore1 / BeachShore1).
    sheets = {}
    for asset in ('beach', 'heights', 'land'):
        pack_a, parsed_a, sheet_a = load_asset(asset)
        sheets[asset] = sheet_a
        man['assets'][asset] = {
            'pack': pack_a,
            'sheet': 'assets/dlc/%s/images/%s' % (pack_a, ASSETS[asset]['png']),
            'bsv3': 'assets/dlc/%s/data/%s' % (pack_a, ASSETS[asset]['bsv3']),
            'cells': [[n, x, y, w, h] for n, x, y, w, h in parsed_a['cells']],
        }
        for n, f0, f1 in parsed_a['anims']:
            if asset == 'land' and n.startswith('Friendsmap'):
                continue                      # the friends-map card, not the town
            key = ANIM_NS[asset] + n
            # the Land anims ship frame 0 only: the viewer draws frame 0 of
            # every coast anim, and the 132-frame mountains/cloud loop alone
            # would quadruple the manifest
            nkeep = 1 if asset == 'land' else f1 - f0 + 1
            man['anims'][key] = {
                'asset': asset,
                'framesTotal': f1 - f0 + 1,
                'frames': [blocks_of(parsed_a, f0 + i)
                           for i in range(nkeep)],
                'bounds': bounds_of(parsed_a, f0),
                'tilebox': opaque_tilebox(sheet_a, parsed_a['frames'][f0]),
            }
    # the tab was built around the lower set, so keep its sheet/cells at top level
    man['pack'] = man['assets']['beach']['pack']
    man['sheet'] = man['assets']['beach']['sheet']
    man['cells'] = man['assets']['beach']['cells']
    for tname, cfg in TILES.items():
        if cfg['anim'] not in man['anims']:
            raise SystemExit('%s: no %s anim' % (cfg['asset'], cfg['anim']))
        le, src = landedge_attrs(cfg['landedge'])
        man['tiles'][tname] = {
            'asset': cfg['asset'],
            'anim': cfg['anim'],
            'unpurchasedAnim': cfg['unpurchased'],
            'kind': cfg['type'],
            'landedge': {k: le[k] for k in
                         ('direction', 'culling', 'width', 'offsetx', 'offsety',
                          'repeat', 'animname', 'unpurchased_animname',
                          'reverse_render', 'purchase_grid_col', 'usetexture',
                          # the solid fill the engine paints UNDER the strip
                          # (Heights beach1: EEDDCC sand, 13.5 x 16 tiles at
                          # x -0.5) — the art's own sand is only patches on it
                          'hasBackground', 'bgColor', 'bgColorUnpurchased',
                          'bgWidth', 'bgHeight', 'bgOffsetX', 'bgOffsetY',
                          'padding', 'snowBgColor')
                         if k in le},
            'landedgeBlock': src,
        }
        a = man['anims'][cfg['anim']]
        # the along-coast span is the OPAQUE extent (bounds include transparent
        # padding: the buildarea rects run to 20.7 tiles but its art stops at 17)
        tb = a['tilebox']
        man['tiles'][tname]['spanTiles'] = int(-(-(tb[3] - tb[1]) // 1))
        man['tiles'][tname]['artSpanTiles'] = int(round(a['bounds'][2] / man['pxPerTile']))
        man['tiles'][tname]['opaqueX'] = [tb[0], tb[2]]
        man['tiles'][tname]['opaqueY'] = [tb[1], tb[3]]
        # the number of grid rows the art actually PAINTS (a tile counts when its
        # centre is inside the opaque box). This, not spanTiles, is what the
        # strips have to be stepped by to tile the coast without gaps: the art
        # reaches 17.1 tiles along the coast but only fills 17 whole rows, so an
        # 18-tile pitch would leave a 1-row gap every 18.
        man['tiles'][tname]['coverRows'] = (int(math.floor(tb[3] - 0.5)) -
                                            int(math.ceil(tb[1] - 0.5)) + 1)
        print('%-10s %-18s frames=%2d blocks=%2d span=%d rows=%d (art %d) '
              'tilebox x %.2f..%.2f y %.2f..%.2f  LandEdge %s/%s w=%s r=%s'
              % (tname, cfg['anim'], len(a['frames']), len(a['frames'][0]),
                 man['tiles'][tname]['spanTiles'], man['tiles'][tname]['coverRows'],
                 man['tiles'][tname]['artSpanTiles'], tb[0], tb[2], tb[1], tb[3],
                 le.get('direction'), le.get('culling'), le.get('width'),
                 le.get('repeat')))
    base, ranges = gridtype_ranges()
    man['gridtype'] = {'source': 'landinfo.xml <GridTypeMap base_type="grass">'
                                ' <GridTypeRange> (the engine\'s own land-type '
                                'table; units are GRID TILES — the beach range '
                                'x 0..4 matches the measured buildarea '
                                'footprint tile for tile)', 'base_type': base,
                      'ranges': ranges}
    man['regions'] = regions()
    man['landBlocks'] = land_blocks()
    lower = [r for r in ranges if r['type'] == 'beach' and r['y0'] is not None]
    north = [r for r in ranges if r['type'] == 'beach' and r['y1'] is not None
             and r['x1'] and r['x1'] > 4]
    man['coast'] = {
        'repeat': man['tiles']['shore']['landedge'].get('repeat'),
        'twoSets': 'the coast is TWO sets, and the file says so by filename. '
                   'The lower, below-the-mountains shore stamps `Beach` '
                   '(BEACHSHORE1/BEACHBUILDAREA1, repeat="-1" = stamp until the '
                   'edge ends); the northern Springfield Heights shore stamps '
                   '`springfieldheightsnobeach` (beachshore1/beach1/'
                   'beachmtnoverlay, repeat=6 = SIX strips, then stop). The two '
                   'meet at the mountain band, so the lower set runs the coast '
                   'from the south end up to the mountains and NOT past them.',
        'edgeInventory': edge_inventory(),
        'lower': {'from': lower[0]['y0'] if lower else None,
                  'to': None,
                  'x': [lower[0]['x0'], lower[0]['x1']] if lower else None,
                  'note': 'the SOUTHERN shore: stamped from the mountain band '
                          'south to the sea frame. Where it STOPS northward is '
                          'the seam — the last row before the Mountains_Standard '
                          'ridge reaches the water (the Mountain03 asset in the '
                          'viewer). The GridTypeRange y_start and the '
                          'SHMountains region band both put it near y -16, but '
                          'the exact row is unverified: see seamUnverified.'},
        'heights': {
            'set': 'springfieldheightsnobeach',
            'note': 'the NORTHERN shore (Springfield Heights), a DIFFERENT set: '
                    'finite repeat=6 (six strips then stop), plus a single '
                    'beachmtnoverlay stamp, offsety="-7" vs the lower set\'s '
                    '"-1". Its shore art measures the SAME columns as the '
                    'lower shore (tx -4.2..0, 17 rows), so north of the seam it '
                    'replaces these tiles rather than occupying extra columns; '
                    'whether it is also painted OVER them at the join is '
                    'unverified (offsety differs, and both a beachmtnoverlay and '
                    'a BEACHBORDEROVERLAY exist).',
            'repeat': man['tiles']['h_shore']['landedge'].get('repeat'),
            'offsety': man['tiles']['h_shore']['landedge'].get('offsety'),
            'x': [north[0]['x0'], north[0]['x1']] if north else None,
            'pitchTiles': man['tiles']['h_shore']['coverRows'],
        },
        'blockTiles': 8,          # LandBlockSize/roadmap blocks are 8 tiles
        'coastY1': 512,           # terrain.js seaFillY1 = the ocean frame end
        'seamUnverified': True,   # the north end of the lower fill is not pinned
    }
    if lower:
        rows = man['tiles']['shore']['coverRows']
        # from the seam row down to the sea frame — the DRAW frame, not a
        # proven coastline length (see seamUnverified)
        man['coast']['lower']['to'] = man['coast']['coastY1']
        man['coast']['lower']['tiles'] = (man['coast']['lower']['to'] -
                                          man['coast']['lower']['from'])
        man['coast']['lower']['pitchTiles'] = rows
        man['coast']['lower']['strips'] = -(-man['coast']['lower']['tiles'] // rows)
    return man


def sheet_img(man, asset='beach'):
    """One bsv3 sprite sheet, opened once per run per asset."""
    global _SHEETS
    if '_SHEETS' not in globals():
        _SHEETS = {}
    if asset not in _SHEETS:
        from PIL import Image
        _SHEETS[asset] = Image.open(os.path.join(ROOT, 'web',
                                                 man['assets'][asset]['sheet'])
                                    ).convert('RGBA')
    return _SHEETS[asset]


def composite(man, anims):
    """Frame 0 of one or more anims stacked over the in-game sea blue. Anims of
    one bsv3 share that file's coordinate space, so drawing them unshifted at
    the same edge position is exactly how the engine composites the coast."""
    from PIL import Image
    bs = [man['anims'][a]['bounds'] for a in anims]
    x0 = min(b[0] for b in bs)
    y0 = min(b[1] for b in bs)
    w = max(b[0] + b[2] for b in bs) - x0
    h = max(b[1] + b[3] for b in bs) - y0
    cv = Image.new('RGBA', (int(w), int(h)), (84, 170, 252, 255))   # sea (terrain.js)
    for anim in anims:
        a = man['anims'][anim]
        sheet = sheet_img(man, a['asset'])
        cells = man['assets'][a['asset']]['cells']
        for ci, x, y, ai, b, c, d in a['frames'][0]:
            _, cx, cy, cw, ch = cells[ci]
            cr = sheet.crop((cx, cy, cx + cw, cy + ch))
            if ai < 0:
                cr = cr.transpose(Image.FLIP_LEFT_RIGHT)
            cr = cr.resize((max(1, int(round(cw * abs(ai)))),
                            max(1, int(round(ch * abs(d))))))
            cv.alpha_composite(cr, (int(round(x - x0)), int(round(y - y0))))
    return cv


def evidence(man):
    """Composite each anim on its own, plus each set's coast band (build area
    behind, shore on top), for user review (project rule: user-facing evidence
    lives in mapdump/registration, m4-* prefix)."""
    for tname, t in man['tiles'].items():
        for anim in (t['anim'], t['unpurchasedAnim']):
            if not anim:
                continue
            cv = composite(man, [anim])
            out = os.path.join(EVID_DIR, 'm4-beach-%s.png' % anim)
            cv.save(out)
            print('evidence', os.path.relpath(out, ROOT), cv.size, '(%s)' % tname)
    for variant, pair in (('1', ('beachBuildArea1', 'beachShore1')),
                          ('2', ('beachBuildArea2', 'beachShore2'))):
        cv = composite(man, pair)              # buildarea behind, shore on top
        out = os.path.join(EVID_DIR, 'm4-beach-coastband-%s.png' % variant)
        cv.save(out)
        print('evidence', os.path.relpath(out, ROOT), cv.size, '(coast band)')
    cv = composite(man, ('heights.Beach1', 'heights.BeachShore1'))
    out = os.path.join(EVID_DIR, 'm4-beach-coastband-heights.png')
    cv.save(out)
    print('evidence', os.path.relpath(out, ROOT), cv.size, '(heights coast band)')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--evidence', action='store_true',
                    help='also write mapdump/registration/m4-beach-<anim>.png')
    args = ap.parse_args()
    man = build()
    with open(OUT, 'w') as fh:
        json.dump(man, fh, separators=(',', ':'))
    print('wrote', os.path.relpath(OUT, ROOT), os.path.getsize(OUT), 'bytes')
    if args.evidence:
        evidence(man)


if __name__ == '__main__':
    main()
