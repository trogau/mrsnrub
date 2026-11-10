#!/usr/bin python3
"""Offline version of the viewer's [cell frames] check, over the whole pool.

For every baked sheet in web/api/bcell-cache: read the manifest the sheet
carries in its own PNG tEXt, then for every image rect ask the same two
questions the Debug button asks the browser — does the rect fit the page it was
baked onto, and is it opaque near-black? Also flags frames that name an image
the manifest does not have, and sheets whose embedded manifest disagrees with
the PNG's real size.

Why this exists: the viewer's census can only ever sample the frame that is on
screen when Debug is pressed, and a walk or blink cell lives in its other
frames most of the time. This reads all of them, without a browser. Read-only —
nothing here writes to the cache.

    tools/audit-bcell-frames.py [cache-dir]
"""
import glob
import json
import os
import sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(os.path.dirname(HERE), 'web', 'api', 'bcell-cache')
KEY = 'bcell-manifest'          # the tEXt key bcell.php writes the sheet with
BLACK_LUM = 20                  # mean luma under this, over this coverage, is
BLACK_COV = 0.35                # "an opaque black square", as the viewer calls it


def stats(im, x, y, w, h):
    """coverage + mean luma over a sub-rect of an RGBA image, or None if the
    rect does not intersect the page at all"""
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(im.width, x + w), min(im.height, y + h)
    if x1 <= x0 or y1 <= y0:
        return None
    crop = im.crop((x0, y0, x1, y1))
    px = crop.load()
    n = vis = 0
    lum = 0
    for yy in range(crop.height):
        for xx in range(crop.width):
            r, g, b, a = px[xx, yy]
            n += 1
            if a > 128:
                vis += 1
                lum += (r + g + b) / 3
    if not n:
        return None
    return (vis / n, (lum / vis) if vis else None)


def audit(cache):
    """returns (sheets, rects, flags) where flags are (name, kind, detail)"""
    bad, n_sheets, n_rects = [], 0, 0
    for p in sorted(glob.glob(os.path.join(cache, '*.png'))):
        try:
            im = Image.open(p)
            raw = im.info.get(KEY)
            if raw is None:
                bad.append((os.path.basename(p)[:12], 'no-manifest',
                            'sheet carries no %s tEXt' % KEY))
                continue
            man = json.loads(raw)
            im = im.convert('RGBA')
        except Exception as e:                      # unreadable cache entry
            bad.append((os.path.basename(p)[:12], 'unreadable', str(e)[:70]))
            continue
        n_sheets += 1
        name = man.get('name') or os.path.basename(p)[:12]
        sh = man.get('sheet') or {}
        if sh.get('w') != im.width or sh.get('h') != im.height:
            bad.append((name, 'page-mismatch',
                        'manifest %sx%s vs png %dx%d' % (sh.get('w'), sh.get('h'),
                                                         im.width, im.height)))
        ims = man.get('images') or []
        for i, q in enumerate(ims):
            n_rects += 1
            s = stats(im, q['x'], q['y'], q['w'], q['h'])
            if s is None:
                bad.append((name, 'off-page',
                            'image %d %d,%d %dx%d outside %dx%d' %
                            (i, q['x'], q['y'], q['w'], q['h'], im.width, im.height)))
                continue
            cov, lum = s
            if cov > BLACK_COV and lum is not None and lum < BLACK_LUM:
                bad.append((name, 'bytes-black',
                            'image %d %d,%d %dx%d cov=%.2f lum=%d  '
                            '<-- the black square' %
                            (i, q['x'], q['y'], q['w'], q['h'], cov, lum)))
        for f in (man.get('frames') or []):
            if f.get('image', 0) >= len(ims):
                bad.append((name, 'frame-image-missing',
                            'frame %s names image %s, manifest has %d' %
                            (f.get('i'), f.get('image'), len(ims))))
    return n_sheets, n_rects, bad


def main():
    cache = sys.argv[1] if len(sys.argv) > 1 else CACHE
    if not os.path.isdir(cache):
        print('no such cache dir: %s' % cache)
        return 2
    n_sheets, n_rects, bad = audit(cache)
    kinds = {}
    for _, kind, _ in bad:
        kinds[kind] = kinds.get(kind, 0) + 1
    print('%d sheets, %d image rects audited in %s' % (n_sheets, n_rects, cache))
    print('flags: %s' % (json.dumps(kinds, sort_keys=True) if kinds else 'none'))
    for nm, kind, det in bad[:40]:
        print('  %-28s %-19s %s' % (nm[:28], kind, det))
    if len(bad) > 40:
        print('  ... %d more' % (len(bad) - 40))
    # a cache entry with no embedded manifest is a serving wart, not a broken
    # bake: only the three faults that could paint a black square fail the run
    return 1 if any(k in ('bytes-black', 'off-page', 'frame-image-missing')
                    for _, k, _ in bad) else 0


if __name__ == '__main__':
    sys.exit(main())
