#!/usr/bin/env python3
"""Smoke test for web/api/bcell.php (dynamic .bcell -> PNG endpoint).

Runs the endpoint in CLI mode (no server needed) and checks, against the
verified Python decoders in extract_assets.py:
  * bcell10 via a CDN pack (double zip): records/blocks dedupe, sheet PNG
    decodes, per-image pixels are IDENTICAL to the pipeline frames
  * bcell13 via the city pool: frame names/offsets match parse_bcell13,
    mode=frame pixels match the pipeline .rgb decode
  * the sheet's embedded tEXt manifest round-trips and equals mode=manifest
  * second identical run is served from the disk cache (byte-equal output)
  * slug-style names (viewer characters.json slugs, e.g. aaronburridleblink)
    resolve to the real cell stem (aaronburr_idle_blink) on both sources

Usage:  python3 tools/smoke-bcell-api.py
Exits non-zero on the first failure. Skips (not fails) when php or the
local content (citypool / pack zip) is missing.
"""
import json
import os
import struct
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = os.path.join(ROOT, 'web', 'api', 'bcell.php')
TMP = '/tmp/opencode/bcell-smoke'
POOL = '/tmp/opencode/citypool'
PACK = '3_0_30/game-100-v3_0_30.zip'
BCELL10 = 'apu_baby_feeding_cycle'          # 4 records / 3 blocks, core pack
BCELL13 = 'aaronburr_back_walk'             # 5 frames, pool
PIPE_FRAMES = ['apubabyfeedingcycle.png', 'apubabyfeedingcycle_1.png',
               'apubabyfeedingcycle_2.png']

fails = []


def check(cond, label):
    print(('ok   ' if cond else 'FAIL ') + label)
    if not cond:
        fails.append(label)


def run(**kw):
    cmd = ['php', API] + [f'--{k}={v}' for k, v in kw.items()]
    r = subprocess.run(cmd, capture_output=True)
    return r.returncode, r.stdout


def png_text_chunk(blob, keyword):
    off = 8
    while off + 8 <= len(blob):
        ln = struct.unpack('>I', blob[off:off + 4])[0]
        tag = blob[off + 4:off + 8]
        if tag == b'tEXt':
            data = blob[off + 8:off + 8 + ln]
            kw, _, txt = data.partition(b'\0')
            if kw == keyword:
                return txt
        off += 12 + ln
    return None


def main():
    if subprocess.run(['which', 'php'], capture_output=True).returncode != 0:
        print('skip: php not installed'); return 0
    if not os.path.isdir(POOL):
        print('skip: citypool not built'); return 0
    if not os.path.isfile(os.path.join(ROOT, 'cdn', PACK)):
        print('skip: cdn pack not present'); return 0
    os.makedirs(TMP, exist_ok=True)
    sys.path.insert(0, os.path.join(ROOT, 'tools'))
    from PIL import Image, ImageChops
    from extract_assets import parse_bcell13, rgb_to_rgba

    # -- bcell10 via pack ------------------------------------------------
    rc, out = run(mode='manifest', src='pack', pack=PACK, name=BCELL10)
    m10 = json.loads(out)
    check(rc == 0 and m10.get('type') == 'bcell10', 'bcell10 manifest parses')
    check(len(m10['frames']) == 4 and len(m10['images']) == 3,
          'bcell10 records>blocks dedupe (4 frames / 3 images)')
    sheet = os.path.join(TMP, BCELL10 + '.png')
    rc, _ = run(mode='sheet', src='pack', pack=PACK, name=BCELL10, out=sheet)
    blob = open(sheet, 'rb').read()
    check(blob[:8] == b'\x89PNG\r\n\x1a\n', 'bcell10 sheet is a PNG')
    txt = png_text_chunk(blob, b'bcell-manifest')
    check(txt is not None and json.loads(txt) == m10,
          'sheet tEXt manifest == mode=manifest JSON')
    im = Image.open(sheet).convert('RGBA')
    same = True
    for k, ref_name in enumerate(PIPE_FRAMES):
        ref = Image.open(os.path.join(ROOT, 'web/assets/characters',
                                      ref_name)).convert('RGBA')
        s = m10['images'][k]
        fr = im.crop((s['x'], s['y'], s['x'] + s['w'], s['y'] + s['h']))
        same = same and ref.size == fr.size \
            and ImageChops.difference(ref, fr).getbbox() is None
    check(same, 'bcell10 frames pixel-identical to pipeline PNGs')
    rc2, out2 = run(mode='sheet', src='pack', pack=PACK, name=BCELL10)
    check(rc2 == 0 and out2 == blob, 'second sheet call served from cache')

    # -- bcell13 via pool -------------------------------------------------
    cell = open(os.path.join(POOL, BCELL13 + '.bcell'), 'rb').read()
    want = parse_bcell13(cell, BCELL13)
    rc, out = run(mode='manifest', src='pool', name=BCELL13)
    m13 = json.loads(out)
    check(rc == 0 and m13.get('type') == 'bcell13', 'bcell13 manifest parses')
    got = [(f['delay_ms'], m13['images'][f['image']]['src'],
            f['x_off'], f['y_off']) for f in m13['frames']]
    exp = [(round(d * 1000) / 1000, n, x, y) for d, x, y, n in want]
    check(got == exp, 'bcell13 frame names/offsets/delays == parse_bcell13')
    k = 2
    fpath = os.path.join(TMP, BCELL13 + f'_f{k}.png')
    rc, _ = run(mode='frame', src='pool', name=BCELL13, n=k, out=fpath)
    w, h, _, rgba, _ = rgb_to_rgba(
        open(os.path.join(POOL, want[k][3].lower()), 'rb').read(), 'ref')
    ref = Image.frombytes('RGBA', (w, h), rgba)
    fr = Image.open(fpath).convert('RGBA')
    check(rc == 0 and fr.size == ref.size
          and ImageChops.difference(fr, ref).getbbox() is None,
          'bcell13 mode=frame pixel-identical to pipeline decode')

    # -- slug resolution (viewer characters.json slugs) --------------------
    # pool: flattened stem -> real cell with underscores
    rc, out = run(mode='manifest', src='pool', name='aaronburridleblink')
    ms = json.loads(out)
    check(rc == 0 and ms.get('name') == 'aaronburr_idle_blink',
          'pool slug aaronburridleblink -> aaronburr_idle_blink')
    rc, out2 = run(mode='manifest', src='pool', name='aaronburr_idle_blink')
    check(ms == json.loads(out2), 'slug manifest == stem manifest (pool)')
    spath = os.path.join(TMP, 'slug-' + BCELL10 + '.png')
    rc, _ = run(mode='sheet', src='pack', pack=PACK, name='apubabyfeedingcycle',
                out=spath)
    check(rc == 0 and open(spath, 'rb').read() == blob,
          'pack slug apubabyfeedingcycle -> same sheet bytes as stem')
    # collision guard: a different cell from the SAME pack zip must not
    # reuse the first cell's cache entry (key must include the stem)
    spath2 = os.path.join(TMP, 'other-cell.png')
    rc, _ = run(mode='sheet', src='pack', pack=PACK,
                name='apu_back_walk_feeding_cycle', out=spath2)
    check(rc == 0 and open(spath2, 'rb').read() != blob,
          'distinct cells from one pack get distinct sheets')

    # -- errors -----------------------------------------------------------
    rc, out = run(mode='sheet', src='pool', name='../../etc/passwd')
    check(b'error' in out, 'path traversal rejected')
    rc, out = run(mode='sheet', src='pool', name='nope_not_here')
    check(b'error' in out and rc == 0, 'missing cell -> JSON error (404 body)')

    print('FAILURES: %d' % len(fails))
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
