#!/usr/bin/env python3
"""city_render.py — render ONE city asset to a PNG for web/api/bsprite.php.

    city_render.py sprite <stem> <out.png>
    city_render.py flag <stem> <out.png>
    city_render.py season <stem> <cls> <out.png>
    city_render.py anim    <stem> <anims/slug__Anim.png> <out.png>
    city_render.py stack   <stem> <out.png>

Imports gen_city_sprites and calls the SAME helpers the batch pipeline
uses (_render_sprite / _composite / _loop_occluder / _pack_sparse /
_anim_clock…), so a served PNG is pixel-identical to the pre-baked file
it replaces; tools/smoke-bsprite-api.py enforces that with ImageChops.
The anim path mirrors do_anims' per-anim block (sample -> dedupe ->
occluder -> cell geometry -> sparse-or-grid pack -> paste); which pack
style to use comes from the shipped city-anims.json entry, never from
re-running the behaviors/selection gates (the viewer only ever asks for
strips the manifest already lists).

No pipeline side effects: nothing is written under web/assets/city and
no manifest is touched — the only output is <out.png> plus, on stdout,
the JSON meta (the manifest-style entry / sprite record).

Failures print one stderr line 'E<code> <message>' (exit code is that
code mod 251; PHP reads the E-prefix):
    422 no source / not in the manifests     (genuine gap -> red box)
    423 not bakeable here                     (fall back, no box)
    424 bake failed / rendered nothing        (red box)
"""
import json
import math
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gen_city_sprites as G

CITY = G.ROOT / 'web/assets/city'


def die(code, msg):
    # exit() truncates to 8 bits (422 -> 166), so the status travels as an
    # 'E<code> ' prefix on the single stderr line; bsprite.php parses that.
    sys.stderr.write(f'E{code} {msg}\n')
    sys.exit(code % 251 or 1)


def _stem_ok(stem):
    if not stem or any(c in stem for c in '/\\\0') or stem.startswith('.'):
        die(423, 'bad stem')


def _pool_file(stem, ext):
    return G.POOL / (stem + ext)


def _load_anims_meta():
    p = CITY / 'city-anims.json'
    if not p.exists():
        die(422, 'no city-anims.json')
    return json.loads(p.read_text())


# ---------------------------------------------------------------- sprite
def do_sprite(stem, out):
    _stem_ok(stem)
    bsv3f, rgbf = _pool_file(stem, '.bsv3'), _pool_file(stem, '.rgb')
    if not bsv3f.exists() or not rgbf.exists():
        die(422, 'no bsv3/rgb in the pool')
    if not _pool_file(stem, '.xml').exists():
        die(422, 'no xml companion')
    e, _warns, canvas = G._render_sprite(stem, bsv3f, rgbf, G.POOL,
                                         Path(out), f'{stem}.png')
    if e is None or canvas is None:
        die(424, 'static frame holds nothing drawable')
    print(json.dumps(e))


# ---------------------------------------------------------------- season
def do_season(stem, cls, out):
    _stem_ok(stem)
    if cls not in G.SEASON_ORDER:
        die(423, f'unknown season class {cls}')
    cdir = G.SEASON / cls
    bsv3f, rgbf = _pool_file(stem, '.bsv3'), _pool_file(stem, '.rgb')
    vbs, vrgb = cdir / (stem + '.bsv3'), cdir / (stem + '.rgb')
    if not vbs.exists() and not vrgb.exists():
        die(422, f'no {cls} variant in the pool')
    rbs = vbs if vbs.exists() else bsv3f
    rrg = vrgb if vrgb.exists() else rgbf
    if not rbs.exists() or not rrg.exists():
        die(422, f'no {cls} variant in the pool')
    if (not vbs.exists() or vbs.read_bytes() == bsv3f.read_bytes()) \
            and (not vrgb.exists() or vrgb.read_bytes() == rgbf.read_bytes()):
        die(422, f'{cls} copy is the base art verbatim')   # (mirrors do_sprites)
    e, _warns, canvas = G._render_sprite(stem, rbs, rrg, cdir,
                                         Path(out), f'seasons/{cls}/{stem}.png')
    if e is None or canvas is None:
        die(424, 'season frame holds nothing drawable')
    e['season'] = cls
    print(json.dumps(e))


# ------------------------------------------------------------------ anim
def do_anim(stem, png_field, out):
    """Re-bake one filmstrip atlas named by the city-anims.json entry."""
    _stem_ok(stem)
    ameta = _load_anims_meta()['anims']
    e0 = next((e for e in ameta.get(stem, []) if e['png'] == png_field),
              None)
    if e0 is None:
        die(422, f'{stem} has no strip {png_field}')
    bsv3f, rgbf = _pool_file(stem, '.bsv3'), _pool_file(stem, '.rgb')
    if not bsv3f.exists() or not rgbf.exists():
        die(422, 'no bsv3/rgb in the pool')
    parsed = G.parse_bsv3(bsv3f.read_bytes(), stem)
    if parsed['v'] not in (1, 3) or not parsed['frames'] or parsed['nf'] < 2:
        die(423, 'static-only file')
    nm = e0['anim']
    rng = next((r for r in (parsed['anims'] or [])
                if r[0].lower() == nm.lower()
                and r[1] <= r[2] < len(parsed['frames'])), None)
    if rng is None:
        die(422, f'{stem}: range {nm} not in the bsv3')
    _bake_anim(stem, nm, rng[1], rng[2], parsed, rgbf, e0, Path(out))


def _bake_anim(s, nm, a, b, parsed, rgbf, e0, out_png):
    """The per-anim block of do_anims (3381-3620), minus the selection
    gates: pack style and map-gate exemptions come from e0, the shipped
    manifest entry, so what is generated matches what was shipped."""
    cap = G.ANIM_MAX_FRAMES
    img = G.load_sheet(rgbf, s)
    idxs = G._sample_range(a, b, cap)
    keep, prev = [], None
    for i in idxs:
        sg = G._frame_sig(parsed['frames'][i])
        if sg != prev:
            keep.append(i)
            prev = sg
    if not keep or (len(keep) < 2 and b > a):
        die(424, 'loop has no motion after dedupe')
    occl = G._loop_occluder(parsed, img, s, keep)

    def render(fi, occl=occl):
        r = G._composite(parsed, img, s, parsed['frames'][fi])
        if r is None or occl is None:
            return r
        return (G._erase_occluded(r[0], r[1], r[2], occl),) + r[1:]

    pairs = [(i, render(i)) for i in keep]
    pairs = [p for p in pairs if p[1] is not None]
    keep = [p[0] for p in pairs]
    comps = [p[1] for p in pairs]
    if not comps or (len(comps) < 2 and b > a):
        die(424, 'no frames composite')
    Ax = max(int(round(c[1])) for c in comps)
    Ay = max(int(round(c[2])) for c in comps)
    cell_w = max(1, max(c[0].width - int(round(c[1])) for c in comps) + Ax)
    cell_h = max(1, max(c[0].height - int(round(c[2])) for c in comps) + Ay)
    cols = min(cap, max(1, int(math.ceil(math.sqrt(len(comps))))))
    rows = math.ceil(len(comps) / cols)
    uniform = cols * cell_w * rows * cell_h
    upx = uniform if uniform > G.MAN_MAP_ATLAS_PX else None
    lf = None

    if e0.get('sparse'):
        # cluster-rect shelf atlas (mirrors do_anims' sparse pass, incl.
        # the wrap-around thinning bisect for over-gate strips)
        sp = G._pack_sparse(comps, label=f'{s}/{nm}')
        comps0, keep0 = comps, keep
        if sp is None and len(comps0) > 10:
            lo, hi = 0, len(comps0)
            pts = [(len(comps0), G._SPARSE_PX[0])]
            best = None
            while hi - lo > 1:
                px = pts[-1][1]
                if len(pts) >= 2 and pts[-1][0] != pts[-2][0]:
                    (n1, p1), (n2, p2) = pts[-2], pts[-1]
                    sl = (p1 - p2) / float(n1 - n2)
                else:
                    sl = 0.0
                if sl > 0:
                    est = int((G.MAN_MAP_ATLAS_PX * 0.995
                               - (p1 - sl * n1)) / sl)
                else:
                    est = int(hi * G.MAN_MAP_ATLAS_PX / px * 0.9)
                n_try = max(lo + 1, min(hi - 1, max(10, est)))
                idx2 = sorted({(i * len(comps0)) // n_try
                               for i in range(n_try)})
                cand = [comps0[i] for i in idx2]
                ck = [keep0[i] for i in idx2]
                r = G._pack_sparse(cand, label=f'{s}/{nm}')
                if r is None:
                    hi = n_try
                    pts.append((n_try, G._SPARSE_PX[0]))
                else:
                    lo, best = n_try, (cand, ck, r)
            if best is None:
                comps, keep = comps0, keep0
            else:
                comps, keep, sp = best
        if sp is not None:
            atlas, subs, mw, mh = sp
            atlas.save(out_png)
            ent = {'anim': nm, 'png': f'anims/{s}__{G._safe_anim(nm)}.png',
                   'frames': len(comps), 'cols': 1,
                   'cellw': mw, 'cellh': mh,
                   'w': atlas.width, 'h': atlas.height,
                   'upx': uniform, 'sub': subs, 'ax': Ax, 'ay': Ay,
                   'fps': G.ANIM_FPS, 'sparse': 1}
            if G._strip_selfcontained(s, comps):
                ent['nc'] = 1
            if len(comps) < len(comps0):
                ent['lf'] = len(comps0)
                ent['fps'] = max(G.ANIM_FPS, min(
                    18, round(4.0 * (b - a) / len(comps))))
            G._anim_clock(ent, keep, a, b)
            print(json.dumps(ent))
            return

    if uniform > G.MAN_MAP_ATLAS_PX and len(comps) > 2 and b > a:
        # grid fallback thinned to fit the player's decode gate (copied)
        n_before = len(comps)
        fit = int(G.MAN_MAP_ATLAS_PX // (cell_w * cell_h))
        while fit >= 2:
            c2 = min(cap, max(1, int(math.ceil(math.sqrt(fit)))))
            if c2 * math.ceil(fit / c2) * cell_w * cell_h \
                    <= G.MAN_MAP_ATLAS_PX:
                break
            fit -= 1
        if fit >= 2:
            idx2 = sorted({(i * len(comps)) // fit for i in range(fit)})
            comps = [comps[i] for i in idx2]
            keep = [keep[i] for i in idx2]
            lf = n_before
            Ax = max(int(round(c[1])) for c in comps)
            Ay = max(int(round(c[2])) for c in comps)
            cell_w = max(1, max(c[0].width - int(round(c[1]))
                                for c in comps) + Ax)
            cell_h = max(1, max(c[0].height - int(round(c[2]))
                                for c in comps) + Ay)
            cols = min(cap, max(1, int(math.ceil(math.sqrt(len(comps))))))
            rows = math.ceil(len(comps) / cols)
            uniform = cols * cell_w * rows * cell_h
    atlas = Image.new('RGBA', (cols * cell_w, rows * cell_h), (0, 0, 0, 0))
    drawn = 0
    for k, i in enumerate(keep):
        r = render(i)
        if r is None:
            continue
        fr, fx, fy = r[0], int(round(r[1])), int(round(r[2]))
        ox = (k % cols) * cell_w + Ax - fx
        oy = (k // cols) * cell_h + Ay - fy
        atlas.alpha_composite(fr, (ox, oy))
        drawn += 1
    if not drawn or (drawn < 2 and b > a):
        die(424, 'atlas holds nothing')
    atlas.save(out_png)
    ent = {'anim': nm, 'png': f'anims/{s}__{G._safe_anim(nm)}.png',
           'frames': drawn, 'cols': cols,
           'cellw': cell_w, 'cellh': cell_h,
           'ax': Ax, 'ay': Ay, 'fps': G.ANIM_FPS}
    if upx:
        ent['upx'] = upx
    if lf and lf != drawn:
        ent['lf'] = lf
    G._anim_clock(ent, keep, a, b)
    print(json.dumps(ent))


# ----------------------------------------------------------------- stack
def do_stack(stem, out):
    """Recompose one oversized-stack static (mirrors _stack_statics'
    compose; the manifest already decided this slug earns one)."""
    _stem_ok(stem)
    city = CITY
    sj = json.loads((city / 'city-sprites.json').read_text())
    info = (sj.get('sprites') or {}).get(stem)
    if not info or not info.get('stack'):
        die(422, 'no stack for this slug')
    ameta = _load_anims_meta()
    rec = (ameta.get('behavior') or {}).get(stem) or {}
    want = rec.get('layers')
    if not want:
        die(422, 'no behavior layers')
    base = stem
    for suf in ('flipped', 'ne', 'nw', 'se', 'sw'):
        if base.endswith(suf):
            base = base[:-len(suf)]
            break
    if base in G._STACK_SKIP:
        die(423, 'slug on the stack skip list')
    low = {e['anim'].lower(): e for e in
           (ameta.get('anims') or {}).get(stem, [])}
    ents = [low[w.lower()] for w in want if w.lower() in low]
    if not ents:
        die(422, 'behaviour layers have no strips')
    try:
        body = Image.open(city / info['png']).convert('RGBA')
        pieces = []
        for e in ents:
            st = Image.open(city / e['png']).convert('RGBA')
            if e.get('sparse'):
                for r in (e.get('sub') or [[]])[0]:
                    pieces.append(
                        (int(round(info['anchor'][0] + r['ox'])),
                         int(round(info['anchor'][1] + r['oy'])),
                         st.crop((r['sx'], r['sy'],
                                  r['sx'] + r['w'], r['sy'] + r['h']))))
            else:
                pieces.append(
                    (int(round(info['anchor'][0] - e['ax'])),
                     int(round(info['anchor'][1] - e['ay'])),
                     st.crop((0, 0, e['cellw'], e['cellh']))))
    except OSError as ex:
        die(422, f'piece source unreadable: {ex}')
    x0, y0, x1, y1 = 0, 0, body.size[0], body.size[1]
    for cx, cy, c in pieces:
        x0, y0 = min(x0, cx), min(y0, cy)
        x1, y1 = max(x1, cx + c.size[0]), max(y1, cy + c.size[1])
    full = Image.new('RGBA', (x1 - x0, y1 - y0), (0, 0, 0, 0))
    full.alpha_composite(body, (-x0, -y0))
    for cx, cy, c in pieces:
        full.alpha_composite(c, (cx - x0, cy - y0))
    full.save(out)
    print(json.dumps({'png': f'stacks/{stem}.png',
                      'w': full.size[0], 'h': full.size[1],
                      'anchor': [info['stack']['anchor'][0],
                                 info['stack']['anchor'][1]]}))


# ---------------------------------------------------------------- flag
def do_flag(stem, out):
    """One SoccerCup2015 nation flag cloth (flag_<country>): the engine
    composites these on top of the shared Flag_Pole asset. Sources join
    the pool via `gen_city_sprites.py flags`; the manifest is
    city-flags.json, deliberately separate from city-sprites.json."""
    _stem_ok(stem)
    p = CITY / 'city-flags.json'
    if not p.exists():
        die(422, 'no city-flags.json (run gen_city_sprites.py flags)')
    e0 = (json.loads(p.read_text()).get('flags') or {}).get(stem)
    if not e0:
        die(422, f'{stem} not in city-flags.json')
    bsv3f, rgbf = _pool_file(stem, '.bsv3'), _pool_file(stem, '.rgb')
    if not bsv3f.exists() or not rgbf.exists():
        die(422, 'no bsv3/rgb in the pool')
    if not _pool_file(stem, '.xml').exists():
        die(422, 'no xml companion')
    e, _warns, canvas = G._render_sprite(stem, bsv3f, rgbf, G.POOL,
                                         Path(out), e0.get('png',
                                         f'flags/{stem}.png'))
    if e is None or canvas is None:
        die(424, 'static frame holds nothing drawable')
    print(json.dumps(e))


def main(argv):
    if len(argv) < 4:
        die(423, __doc__)
    kind = argv[1]
    try:
        if kind == 'sprite':
            do_sprite(argv[2], argv[3])
        elif kind == 'flag':
            do_flag(argv[2], argv[3])
        elif kind == 'season':
            if len(argv) < 5:
                die(423, 'season needs <cls>')
            do_season(argv[2], argv[3], argv[4])
        elif kind == 'anim':
            if len(argv) < 5:
                die(423, 'anim needs <png-field>')
            do_anim(argv[2], argv[3], argv[4])
        elif kind == 'stack':
            do_stack(argv[2], argv[3])
        else:
            die(423, f'unknown kind {kind}')
    except SystemExit:
        raise
    except Exception as ex:                     # decode/parse blow-ups
        die(424, f'{type(ex).__name__}: {ex}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
