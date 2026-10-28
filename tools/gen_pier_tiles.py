#!/usr/bin/env python3
"""Emit web/assets/city/pier-tiles.json: the in-game boardwalk / pier tile art.

The boardwalk and pier BRUSHES are not RoadMap tiles — landinfo.xml gives
them PathBrush textures and SaveInfo map="ocean" savedType="road|pavement",
so their art ships as ordinary building-sprite bsv3 assets (notes/09 §12):

  boardwalktiles   WaterfrontGame-100-r146180            13 anims
  ornatepiertiles  SpringfieldHeights2BuildDecoGame-100  5 anims

This tool parses both with gen_city_sprites.parse_bsv3 (0x0103 scene: cells
= sheet crop rects, frames = block lists of (cell, x, y, 2x2 matrix)) and
writes one manifest the Pixi viewer blits per tile.

Geometry (measured, notes/09 §12):

* Block x/y are the crop's TOP-LEFT in 100-tier sheet pixels, the (a b;c d)
  matrix is a scale (+ a<0 mirror), and the engine draws the block list in
  REVERSED order (the shadow, listed last, is painted first). The list is
  stored already reversed, so the viewer blits array order.
* C_Shadow fills its crop exactly with the tile DIAMOND, so it defines the
  calibration: box space = sheet px / 4 with the shadow's top-left at the
  origin, i.e. ox = -x/4, oy = -y/4. Box space is the same 127x66 sheet box
  the road/rivers tiles use, so the viewer reuses its sheet->tile transform
  (anchor 0.5, rotation 45 deg, scale sqrt2/127 x sqrt2/66) with both axes
  divided by 4. The deck crops sit ABOVE the diamond — an elevated deck —
  so calibrating from them would sink the tile.

Usage:
  python3 tools/gen_pier_tiles.py                 # write the manifest
  python3 tools/gen_pier_tiles.py --evidence      # + state composites
"""

import argparse
import importlib.util
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_spec = importlib.util.spec_from_file_location(
    'gen_city_sprites', os.path.join(ROOT, 'tools', 'gen_city_sprites.py'))
gcs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gcs)

OUT = os.path.join(ROOT, 'web', 'assets', 'city', 'pier-tiles.json')
EVID_DIR = os.path.join(ROOT, 'mapdump', 'registration')

# viewer state names, in tile-space order: which lower edge is water
STATES = ['Normal_None', 'Normal_PostLeft', 'Normal_PostRight',
          'Normal_PostLeftAndRight']

ASSETS = {
    'boardwalk': {
        'pack': 'WaterfrontGame-100-r146180',
        'asset': 'boardwalktiles',
        # every state the tile can ask for (Highlight_* is editor selection,
        # TopOnly/PostOnly_* are half-painted states: kept for the Road Lab)
        'states': STATES + ['TopOnly', 'PostOnly_PostLeft',
                            'PostOnly_PostRight', 'PostOnly_PostLeftAndRight',
                            'Neutral'],
    },
    'pier': {
        'pack': 'SpringfieldHeights2BuildDecoGame-100-r284665',
        'asset': 'ornatepiertiles',
        'states': STATES + ['Neutral'],
    },
}


def blocks_of(parsed, frame):
    """Frame `frame`'s block list in ENGINE DRAW order (reversed list)."""
    out = []
    for ci, x, y, a, b, c, d in reversed(parsed['frames'][frame]):
        name, cx, cy, cw, ch = parsed['cells'][ci]
        out.append({'n': name, 'c': [cx, cy, cw, ch],
                    'p': [round(x, 2), round(y, 2)],
                    'm': [a, b, c, d]})
    return out


def calib_of(parsed, frame):
    """(ox, oy): sheet px -> box px, from the frame's C_Shadow block."""
    for ci, x, y, a, b, c, d in parsed['frames'][frame]:
        if parsed['cells'][ci][0] == 'C_Shadow':
            return {'ox': round(-x / 4.0, 4), 'oy': round(-y / 4.0, 4)}
    raise SystemExit('no C_Shadow block found')


def build():
    man = {
        'gen': 'tools/gen_pier_tiles.py',
        'unit': 'sheet px are 100-tier pixels; box px = sheet px / 4 in the '
                '127x66 sheet box, so the viewer applies its sheet->tile '
                'transform (rot 45, scale sqrt2/127 x sqrt2/66) / 4',
        'calib': 'ox,oy offset the crop top-left so C_Shadow fills the box, '
                 'whose inscribed diamond is the tile',
        'states': STATES,
        'assets': {},
    }
    parsed_cache = {}
    for tname, cfg in ASSETS.items():
        pack, asset = cfg['pack'], cfg['asset']
        bsv3 = os.path.join(ROOT, 'web', 'assets', 'dlc', pack, 'data',
                            asset + '.bsv3')
        blob = open(bsv3, 'rb').read()
        parsed = gcs.parse_bsv3(blob, asset + '.bsv3')
        parsed_cache[tname] = parsed
        if parsed['v'] != 1:
            raise SystemExit('%s: expected a 0x0103 scene' % asset)
        first = {n: f0 for n, f0, f1 in parsed['anims']}
        states = {}
        for s in cfg['states']:
            if s not in first:
                raise SystemExit('%s: no %s anim' % (asset, s))
            states[s] = blocks_of(parsed, first[s])
        # the shadow sits in the Normal_* / Neutral frames; Normal_None is
        # the cheapest frame that carries it
        cal = calib_of(parsed, first[STATES[0] if STATES[0] in first
                                     else 'Neutral'])
        man['assets'][tname] = {
            'pack': pack,
            'sheet': 'assets/dlc/%s/images/%s.png' % (pack, asset),
            'shadow': [c for c in parsed['cells'] if c[0] == 'C_Shadow'][0][1:],
            'calib': cal,
            'states': states,
        }
        print('%-10s %-20s cells=%d frames=%d anims=%d  calib ox=%.2f oy=%.2f'
              % (tname, asset, len(parsed['cells']), parsed['nf'],
                 len(parsed['anims']), cal['ox'], cal['oy']))
        for s in cfg['states']:
            print('   %-26s %2d blocks' % (s, len(states[s])))
    return man


def evidence(man, parsed_cache):
    """State composites over the RE'd sea blue, for user review."""
    from PIL import Image, ImageDraw
    for tname, cfg in ASSETS.items():
        a = man['assets'][tname]
        sheet = Image.open(os.path.join(ROOT, 'web', a['sheet'])).convert('RGBA')
        st = list(a['states'])
        pad, w, h = 30, 320, 240
        canvas = Image.new('RGBA', (pad + (w + pad) * len(st), h + 2 * pad),
                           (84, 170, 252, 255))
        dr = ImageDraw.Draw(canvas)
        for i, name in enumerate(st):
            ox = pad + (w + pad) * i
            oy = pad
            dr.rectangle((ox, oy, ox + w, oy + h), outline=(255, 255, 0))
            # sheet-space centre: the shadow crop's middle lands mid-box
            so = (ox + w / 2 - (a['shadow'][0] + a['shadow'][2] / 2) / 4,
                  oy + h / 2 - (a['shadow'][1] + a['shadow'][3] / 2) / 4)
            for blk in a['states'][name]:
                cx, cy, cw, ch = blk['c']
                x, y = blk['p']
                m = blk['m']
                cr = sheet.crop((cx, cy, cx + cw, cy + ch))
                if m[0] < 0:
                    cr = cr.transpose(Image.FLIP_LEFT_RIGHT)
                    x -= cw * abs(m[0])
                dw, dh = max(1, int(round(cw * abs(m[0]) / 4))), \
                    max(1, int(round(ch * abs(m[3]) / 4)))
                cr = cr.resize((dw, dh), Image.NEAREST)
                canvas.alpha_composite(cr, (int(round(x / 4 + so[0])),
                                            int(round(y / 4 + so[1]))))
            dr.text((ox + 4, oy - 16), name, fill=(255, 255, 0))
        out = os.path.join(EVID_DIR, 'pier-%s-states.png' % tname)
        canvas.save(out)
        print('evidence', os.path.relpath(out, ROOT), canvas.size)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--evidence', action='store_true',
                    help='also write mapdump/registration/pier-<type>-states.png')
    args = ap.parse_args()
    man = build()
    with open(OUT, 'w') as fh:
        json.dump(man, fh, separators=(',', ':'))
    print('wrote', os.path.relpath(OUT, ROOT), os.path.getsize(OUT), 'bytes')
    if args.evidence:
        evidence(man, {})


if __name__ == '__main__':
    main()
