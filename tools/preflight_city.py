#!/usr/bin/env python3
"""preflight_city.py — rebuild web/assets/city/city-source.json.

The dynamic city endpoint (web/api/bsprite.php) serves assets by shell-
execing tools/city_render.py, which costs a python interpreter start per
cold slug. To keep the viewer from spawning thousands of doomed subprocess
calls for stems whose source files never made it out of the packs, it
first consults this inventory: one JSON file listing, per slug stem, what
the bake pool can actually render.

  bit 1  body   <stem>.bsv3 + .rgb + .xml in the pool        (also the
                                                               capability
                                                               for anims —
                                                               same files)
  bit 2  season at least one pool season/<cls>/<stem>.{bsv3,rgb}

The viewer fetches city-source.json at boot (cheap, ~100 KB) and only
then hits the endpoint; stems missing from `inv` draw pre-baked art with
no request. Re-run after any pool refill (gen_city_sprites extract/
backfill/resolve_seasons).

Safety: an empty or crippled pool would emit an empty inventory and the
viewer would mark every building dead, so the generator refuses to write
unless the pool looks real (>500 bsv3) — the previous inventory stays.
"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gen_city_sprites as G

OUT = G.ROOT / 'web/assets/city/city-source.json'
BODY = 1
SEASON = 2


def main():
    pool = G.POOL
    if not pool.is_dir():
        print(f'pool {pool} missing: leaving inventory untouched',
              file=sys.stderr)
        return 1
    stems = {}
    for f in pool.glob('*.bsv3'):
        stems.setdefault(f.stem, 0)
    rgbs = {f.stem for f in pool.glob('*.rgb')
            if not f.stem.endswith('_transimage')}
    xmls = {f.stem for f in pool.glob('*.xml')}
    n = 0
    for s in stems:
        if s in rgbs and s in xmls:
            stems[s] |= BODY
            n += 1
    sn = 0
    for cls in G.SEASON_ORDER:
        d = G.SEASON / cls
        if not d.is_dir():
            continue
        for f in d.iterdir():
            if f.suffix not in ('.bsv3', '.rgb'):
                continue
            st = f.stem
            if st in stems and not stems[st] & SEASON:
                stems[st] |= SEASON
                sn += 1
    # nation flag cloths (kind=flag): listed only when fully sourced; the
    # viewer overlay + panel ask the endpoint for exactly these stems
    flags = []
    fp = G.ROOT / 'web/assets/city/city-flags.json'
    if fp.exists():
        try:
            flags = sorted(s for s in json.loads(fp.read_text())['flags']
                           if s in stems and stems[s] & BODY)
        except (ValueError, KeyError):
            flags = []
    if n < 500:
        print(f'only {n} fully-sourced stems in {pool}: pool looks broken, '
              f'leaving inventory untouched', file=sys.stderr)
        return 1
    OUT.write_text(json.dumps(
        {'gen': int(time.time()), 'pool': str(pool), 'inv': stems,
         'bodied': n, 'seasoned': sn, 'flags': flags},
        separators=(',', ':')))
    print(f'preflight: {n} bodied stems, {sn} with season variants, '
          f'{len(flags)} flag cloths -> {OUT}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
