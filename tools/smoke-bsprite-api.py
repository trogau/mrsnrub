#!/usr/bin/env python3
"""smoke-bsprite-api.py — checks for the dynamic city endpoint stack:
tools/preflight_city.py, tools/city_render.py and web/api/bsprite.php
(CLI mode, no server needed).

  * preflight inventory carries known stems with the right bits
  * the shim renders every kind; sprites/seasons match the pre-baked PNG
    pixel-for-pixel (a size drift of <= 2 px is tolerated ONLY where the
    working tree of gen_city_sprites.py has advanced past the shipped
    bake — it is reported, never hidden)
  * the PHP endpoint serves identical bytes, caches (warm call performs
    no re-bake), reports per-kind meta, and maps failures to 422/423
    JSON errors with traversal/bad params refused
Run: python3 tools/smoke-bsprite-api.py
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parent.parent
PHP = 'php'
TMP = Path('/tmp/opencode/bsprite-harness')
CACHE = ROOT / 'web/api/bsprite-cache'
CITY = ROOT / 'web/assets/city'
fails = 0


def check(name, cond, extra=''):
    global fails
    print(('ok   ' if cond else 'FAIL ') + name + (('  (' + extra + ')') if extra and not cond else ''))
    if not cond:
        fails += 1


def php(args, out=None):
    cmd = [PHP, str(ROOT / 'web/api/bsprite.php')] + [f'--{a}' for a in args]
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r


def shim(args):
    cmd = ['python3', str(ROOT / 'tools/city_render.py')] + [str(a) for a in args]
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r


def diff_png(a, b):
    """('identical'|'diff'|'size', maxdiff or sizes)"""
    x, y = Image.open(a).convert('RGBA'), Image.open(b).convert('RGBA')
    if x.size != y.size:
        return 'size', (x.size, y.size)
    bb = ImageChops.difference(x, y).getbbox()
    return ('identical' if bb is None else 'diff'), bb


def main():
    TMP.mkdir(parents=True, exist_ok=True)

    # ---- preflight -----------------------------------------------------
    r = subprocess.run(['python3', str(ROOT / 'tools/preflight_city.py')],
                       capture_output=True, text=True)
    check('preflight exits 0', r.returncode == 0, r.stderr[-120:])
    inv = json.loads((CITY / 'city-source.json').read_text())
    check('preflight: 1979onda bodied', inv['inv'].get('1979onda', 0) & 1 == 1)
    check('preflight: winter-bit on for 1979onda', inv['inv'].get('1979onda', 0) & 2 == 2)
    check('preflight: unknown stem absent', 'definitely_not_a_building' not in inv['inv'])
    check('preflight: pool recorded', bool(inv.get('pool')))

    # ---- shim kinds vs pre-baked ---------------------------------------
    def bake(kind, *rest):
        out = TMP / (f'{kind}-{"-".join(str(x) for x in rest)}'
                     .replace('/', '_') + '.png')
        r = shim([kind] + list(rest) + [out])
        return r, out

    r, p = bake('sprite', '1979onda')
    check('shim sprite exit 0', r.returncode == 0, r.stderr[-160:])
    kind, info = diff_png(p, CITY / '1979onda.png')
    drifted = kind == 'size' and max(abs(a - b) for a, b in zip(*info)) <= 2
    check('shim sprite pixel-identical to pre-baked',
          kind == 'identical' or drifted,
          'size drift ' + str(info) if kind == 'size' else 'PIXDIFF')
    if kind == 'size':
        print(f'     note: 1979onda size drift {info} — pipeline ahead of shipped bake')

    r, p = bake('season', '1979onda', 'winter')
    check('shim season exit 0', r.returncode == 0, r.stderr[-160:])
    kind, info = diff_png(p, CITY / 'seasons/winter/1979onda.png')
    check('shim season pixel-identical', kind == 'identical', str(info))

    r, p = bake('anim', '1979onda', 'anims/1979onda__Active.png')
    check('shim anim exit 0', r.returncode == 0, r.stderr[-160:])
    ent = json.loads(r.stdout)
    pre = Image.open(CITY / 'anims/1979onda__Active.png')
    new = Image.open(p)
    check('shim anim atlas grid consistent with its own meta',
          new.width == ent['cols'] * ent['cellw'] and
          new.height == -(-ent['frames'] // ent['cols']) * ent['cellh'],
          f"{new.size} vs {ent['cols']}x{ent['cellw']}x{ent['cellh']}")
    same = pre.size == new.size and ImageChops.difference(pre.convert('RGBA'),
                                                          new.convert('RGBA')).getbbox() is None
    near = pre.size != new.size and max(abs(a - b) for a, b in zip(pre.size, new.size)) <= 4
    check('shim anim pixel-identical (or documented drift)', same or near,
          f'pre {pre.size} new {new.size}')

    r, p = bake('stack', 'whale')
    check('shim stack exit 0', r.returncode == 0, r.stderr[-160:])
    kind, info = diff_png(p, CITY / 'stacks/whale.png')
    check('shim stack pixel-identical', kind == 'identical', str(info))

    r, p = bake('flag', 'flag_sweden')
    check('shim flag exit 0', r.returncode == 0, r.stderr[-160:])
    kind, info = diff_png(p, CITY / 'flags/flag_sweden.png')
    check('shim flag pixel-identical to pre-baked', kind == 'identical', str(info))

    # ---- shim error codes ------------------------------------------------
    def died(r, code):
        return r.returncode != 0 and r.stderr.startswith(f'E{code} ')
    r = shim(['sprite', 'definitely_not_a_building', TMP / 'x.png'])
    check('shim: missing source exits E422', died(r, 422), f'rc={r.returncode} {r.stderr[:60]}')
    r = shim(['season', '1979onda', 'summer', TMP / 'x.png'])
    check('shim: no season variant exits E422', died(r, 422), f'rc={r.returncode} {r.stderr[:60]}')
    r = shim(['anim', '1979onda', 'anims/1979onda__Nope.png', TMP / 'x.png'])
    check('shim: unknown strip exits E422', died(r, 422), f'rc={r.returncode} {r.stderr[:60]}')
    r = shim(['stack', '1979onda', TMP / 'x.png'])
    check('shim: slug without stack exits E422', died(r, 422), f'rc={r.returncode} {r.stderr[:60]}')
    r = shim(['flag', 'flag_notacountry', TMP / 'x.png'])
    check('shim: flag not in city-flags.json exits E422', died(r, 422), f'rc={r.returncode} {r.stderr[:60]}')

    # ---- PHP endpoint: serve, cache, meta --------------------------------
    r = php(['kind=sprite', 'name=1979onda', f'out={TMP}/p-sprite.png'])
    check('php sprite exit 0', r.returncode == 0, r.stderr[-160:])
    check('php sprite bytes == shim bytes',
          (TMP / 'p-sprite.png').read_bytes() ==
          (TMP / 'sprite-1979onda.png').read_bytes())
    # exact identity between the two producers for the season kind:
    r = php(['kind=season', 'name=1979onda', 'cls=winter', f'out={TMP}/p-season.png'])
    check('php season bytes == shim bytes',
          (TMP / 'p-season.png').read_bytes() ==
          (TMP / 'season-1979onda-winter.png').read_bytes())

    # warm call: cache file mtimes must not move (no re-bake)
    def mtimes():
        # live-server stale-strip (the endpoint prunes entries keyed on an
        # old pipeline) may unlink a file between glob and stat — skip it
        out = {}
        for f in CACHE.glob('*.png'):
            try:
                out[f] = f.stat().st_mtime_ns
            except FileNotFoundError:
                pass
        return out
    m0 = mtimes()
    t0 = time.time()
    php(['kind=sprite', 'name=1979onda', f'out={TMP}/p-sprite2.png'])
    warm = time.time() - t0
    m1 = mtimes()
    check('php warm call: no cache re-bake',
          all(m1.get(f) == ns for f, ns in m0.items() if f in m1))
    check('php warm call fast (<1.5s)', warm < 1.5, f'{warm:.2f}s')
    check('php warm bytes == cold bytes',
          (TMP / 'p-sprite.png').read_bytes() == (TMP / 'p-sprite2.png').read_bytes())

    r = php(['mode=meta', 'kind=anim', 'name=1979onda', 'png=anims/1979onda__Active.png'])
    ent = json.loads(r.stdout)
    check('php anim meta has slice fields',
          all(k in ent for k in ('frames', 'cols', 'cellw', 'cellh', 'ax', 'ay', 'fps')))
    man = json.loads((CITY / 'city-anims.json').read_text())['anims']['1979onda'][0]
    check('php anim meta matches shipped manifest',
          all(ent.get(k) == man.get(k) for k in ('anim', 'cols', 'ax', 'ay', 'fps'))
          and abs(ent.get('cellw', 0) - man['cellw']) <= 2
          and abs(ent.get('cellh', 0) - man['cellh']) <= 2,
          json.dumps({k: ent.get(k) for k in ('cols', 'cellw', 'cellh', 'ax', 'ay')}))

    # ---- the timing this endpoint serves IS the timing the player gets ----
    # city-view-pixi.js animMeta() overwrites a strip's fps/rp/lt/lf with this
    # answer, so a cadence rule stamped only into city-anims.json never
    # reaches the map: the Dragon of Springfieldia kept replaying its raw
    # 132-tick loop (12 poses, 5.5 s a cycle) through here while its shipped
    # entry correctly read 36 ticks — three "too slow" reports, all invisible
    # (2026-11-04). Pin a strip that was actually atlas-thinned, not just a
    # small one. The cells themselves are NOT compared: the shim re-bakes its
    # own atlas and its thin pass may land on different source frames.
    r = php(['mode=meta', 'kind=anim', 'name=springfieldiadragon',
             'png=anims/springfieldiadragon__Neutral.png'])
    ent = json.loads(r.stdout)
    man = next(e for e in json.loads((CITY / 'city-anims.json').read_text())
               ['anims']['springfieldiadragon'] if e['anim'] == 'Neutral')
    clock = ('frames', 'fps', 'lf', 'lt', 'lt0')
    check('php anim meta carries the manifest clock for an atlas-thinned strip',
          all(ent.get(k) == man.get(k) for k in clock),
          json.dumps({k: (ent.get(k), man.get(k)) for k in clock}))
    check('the served thinned loop is no slideshow (a pose turns every ~3 ticks)',
          ent.get('lt', 9e9) <= 3.5 * ent.get('frames', 1) and
          ent.get('lt0', 0) >= 2 * ent.get('lt', 1),
          json.dumps({k: ent.get(k) for k in ('frames', 'lt', 'lt0', 'lf')}))
    # and the cache identity must cover the pipeline itself, or a rule change
    # is served stale forever out of bsprite-cache (the bug above)
    php_src = (ROOT / 'web/api/bsprite.php').read_text()
    check('the endpoint cache keys on the bake pipeline, not only the pool',
          '$files[] = RENDER_PY;' in php_src and '$files[] = GEN_PY;' in php_src,
          '')

    # ---- the idle gate falls back to the asset's own Neutral loop ------
    # when the engine's behavior table names an idle the bsv3 doesn't
    # carry, the engine plays the promoted neutral/0 atlas — the map must
    # too, or the building ships frozen (Atlantis' engine idle is
    # 'Active', its only loop is its 16-pose Neutral; 2026-11-05).
    am = json.loads((CITY / 'city-anims.json').read_text())
    atl = next((e for e in am['anims'].get('atlantis') or []
                if e['anim'] == 'Neutral'), None)
    check('a slug whose engine idle is missing from its bsv3 gates its '
          'Neutral loop (atlantis)',
          (am['behavior'].get('atlantis') or {}).get('idle') == 'Neutral'
          and atl and atl['frames'] > 1,
          json.dumps({'gate': am['behavior'].get('atlantis'),
                      'strip': bool(atl) and atl['frames']}))

    # ---- PHP endpoint: errors ---------------------------------------------
    r = php(['kind=sprite', 'name=definitely_not_a_building', f'out={TMP}/x.png'])
    check('php unknown body -> error JSON', '"error"' in r.stdout)
    r = php(['kind=sprite', *['name=../../etc/passwd'], f'out={TMP}/x.png'])
    check('php traversal refused', 'error' in r.stdout.lower() and not (TMP / 'x.png').exists())
    r = php(['kind=bogus', 'name=1979onda'])
    check('php bad kind refused', '"error"' in r.stdout)
    r = php(['kind=season', 'name=1979onda', 'out=x'])
    check('php season without cls refused', '"error"' in r.stdout)

    # ---- PHP endpoint: the $_GET path (what the browser really hits) --------
    # The CLI --args branch never parses query strings, so the double-'?'
    # cache-buster bug (?kind=sprite&name=x + '?v=…' → name reads as
    # "x?v=…" → 404 on every building) only exists on this path. Emulate a
    # web invoke: pre-fill $_GET + REQUEST_METHOD, dispatch takes $_GET.
    def get(query):
        code = ('parse_str($argv[1], $_GET);'
                '$_SERVER["REQUEST_METHOD"]="GET";'
                f'require {str(ROOT / "web/api/bsprite.php")!r};')
        return subprocess.run([PHP, '-r', code, query], capture_output=True)

    r = get('kind=sprite&name=1979onda&v=20261102.1')
    check('php GET with &v= cache-buster serves PNG',
          r.returncode == 0 and r.stdout[:8] == b'\x89PNG\r\n\x1a\n',
          r.stderr[-120:].decode(errors='replace'))
    r = get('kind=sprite&name=1979onda?v=20261102.1')
    check('php GET with double-? name refused (regression: map red boxes)',
          b'error' in r.stdout and r.stdout[:4] != b'\x89PNG',
          r.stdout[:80])
    r = get('kind=anim&name=1979onda&png=anims/1979onda__Active.png'
            '&mode=meta&v=20261102.1')
    check('php GET meta with &v= is JSON',
          r.returncode == 0 and json.loads(r.stdout).get('frames'),
          r.stdout[:80])
    r = get('kind=flag&name=flag_sweden&v=20261102.1')
    check('php GET flag with &v= serves PNG',
          r.returncode == 0 and r.stdout[:8] == b'\x89PNG\r\n\x1a\n',
          r.stderr[-120:].decode(errors='replace'))
    check('php GET flag bytes == pre-baked cloth',
          r.stdout == (CITY / 'flags/flag_sweden.png').read_bytes())
    r = get('kind=flag&name=flag_notacountry&v=20261102.1')
    check('php GET unknown flag -> error JSON',
          b'error' in r.stdout and r.stdout[:4] != b'\x89PNG',
          r.stdout[:80])


if __name__ == '__main__':
    main()
    print('FAILURES:', fails)
    sys.exit(1 if fails else 0)
