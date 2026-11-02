#!/usr/bin/env python3
"""Audit every pool asset for the transimage-box condition.

The bug class (2026-10-31, notes/06): a building shows as a flat box or
sliver on the City View because its bsv3 is a degenerate single-cell
placeholder — one white 'C_Square' or blue 'C_CrowdofPres' quad over a
tiny solid-colour .rgb — while the art the game actually draws lives in
the '<slug>_transimage.rgb' companion, offset by the xml Building's
transImageX/Y. gen_city_sprites's _transimage_only gate draws those
companions instead; this harness finds any slug where that gate should
fire but hasn't (new pool sync, gate drift, or art the pool holds but
the manifest never rendered).

Run after a pool sync or when a building draws as a box:

    python3 tools/audit-transimage-boxes.py

Exit 0 = nothing fixable pending; 1 = slugs listed that want
`sprites --slug <s>` (the gate converts them automatically).

Buckets:
  FIXABLE     single cell + marker-quad sheet + content-carrying
              transimage + non-zero xml pair, but the manifest entry is
              not pivot=transimage -> re-render it
  NO-ART      marker-quad sheet, no transimage at all -> a true box
              unless the quad IS the art (eyeball, e.g. trashcan,
              spotlightwhite*: >=9 quantised colours or no companion)
  PARTIAL     marker sheet with transimage XOR xml pair (usually a
              zeroed transImage pair: companion drawn at the origin)
  NO-SOURCE   manifest key with neither bsv3 nor rgb in the pool
              (bridge _f<N> keys are synthetic frames, expected)

Markers share the generator's thresholds: sheet <=96x96, >=25% opaque,
<=8 colours quantised to 32-unit buckets.
"""
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from extract_assets import rgb_to_rgba       # noqa: E402
from gen_city_sprites import POOL, parse_bsv3, _sheet_marker  # noqa: E402

MANIFEST = Path(__file__).resolve().parents[1] / \
    'web' / 'assets' / 'city' / 'city-sprites.json'


def _content(path):
    """(opaque-ratio, quantised-colour-count) of a sheet, or None."""
    try:
        _w, _h, _bpp, rgba, _pm = rgb_to_rgba(path.read_bytes(), path.name)
    except Exception:
        return None
    n = _w * _h
    if not n:
        return None
    opaque = 0
    cols = set()
    for i in range(3, len(rgba), 4):
        if rgba[i] > 8:
            opaque += 1
            cols.add((rgba[i-3] // 32, rgba[i-2] // 32, rgba[i-1] // 32))
    return opaque / n, len(cols)


def _xml_pair(slug):
    p = POOL / (slug + '.xml')
    if not p.exists():
        return None
    try:
        r = ET.fromstring(p.read_text(errors='replace'))
        return (float(r.get('transImageX') or 0),
                float(r.get('transImageY') or 0))
    except Exception:
        return None


def main():
    man = json.loads(MANIFEST.read_text())['sprites']
    fixable, no_art, partial, no_source = [], [], [], []
    for slug, e in sorted(man.items()):
        b3, rg = POOL / (slug + '.bsv3'), POOL / (slug + '.rgb')
        if not b3.exists() and not rg.exists():
            no_source.append(slug)
            continue
        if not b3.exists():
            continue
        try:
            parsed = parse_bsv3(b3.read_bytes(), slug)
        except Exception as ex:
            print(f'  PARSE-FAIL {slug}: {ex}')
            continue
        if len(parsed['cells']) != 1:
            continue
        m = _sheet_marker(rg) if rg.exists() else None
        if m is None:
            continue
        ti = POOL / (slug + '_transimage.rgb')
        tf = _content(ti) if ti.exists() else None
        real = tf is not None and tf[0] >= 0.01 and tf[1] > m[3]
        xy = _xml_pair(slug)
        has_xy = xy is not None and (xy[0] != 0 or xy[1] != 0)
        rec = (slug, f'{m[0]}x{m[1]}', f'cols={m[3]}', f'fill={m[2]:.2f}',
               ti.stat().st_size if ti.exists() else 0, xy,
               e.get('pivot'), e.get('static'))
        if real and has_xy:
            if e.get('pivot') != 'transimage':
                fixable.append(rec)
        elif (ti.exists() and tf) or has_xy:
            partial.append(rec)
        else:
            no_art.append(rec)

    def dump(title, rows):
        print(f'\n== {title}: {len(rows)}')
        for r in rows:
            print(f'  {r[0]:34} quad {r[1]:>8} {r[2]:>7} {r[3]:>7} '
                  f'trans={r[4]:>8} xy={r[5]} pivot={r[6]} static={r[7]}')

    dump('FIXABLE (run: sprites --slug <s>)', fixable)
    dump('PARTIAL (transimage XOR xml pair — eyeball)', partial)
    dump('NO-ART marker sheets (true boxes / real flat art)', no_art)
    print(f'\n== manifest keys with no pool source: {len(no_source)}')
    for s in no_source:
        print('  ', s)
    if fixable:
        print('\nFIXABLE pending — re-render each with '
              'gen_city_sprites.py sprites --slug <s>')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
