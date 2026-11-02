#!/usr/bin/env python3
"""Batch-run the asset pipeline over locally extracted CDN pack zips.

Scans one or more directories for CDN pack zips named
    <family>[-<tier>][-<lang>]-v<season>[-r<rev>[-TAG]].zip
(the same 0/1 container as the in-APK packs), builds one --dlc spec per
zip and runs tools/extract_assets.py exactly once with all of them, so
the APK side is only re-extracted a single time.

Sources (kept in this repo; extract with `7z x` into a work dir first):
    cdn/3_0_30.7z -> 104 zips, the full 3.0.30 core CDN content
                    (all families, all device/resolution tiers, all
                    CDN revisions)
    cdn/1_1_35.7z -> 112 movie packs (4 movies x 7 languages x 4 device
                    tiers) + 4 CJK font-cache packs (skipped: custom
                    glyph-atlas binary, no known decoder)

Pack naming in the manifest (dlc/<pack>/):
    3_0_30 packs:  <family>-<tier>[-r<rev>]   e.g. menu-ipad3-r2
    1_1_35 packs:  full base name             e.g. movie-intro-ipad-de-v1_1_35
    movie families are per-language except EN (family = <movie>) so the
    variant switcher groups the 4 device tiers within one language.

Later bundles (e.g. 3_0_0_Thanksgiving, the 4.x event packs) keep their
zips inside a folder named after the bundle and *without* the -v<season>
suffix: 3_0_0_Thanksgiving/channel6menu-ipad-r146180-0D2B882C.zip. For
those, the season is taken from the containing directory and the pack is
named like the 3_0_30 ones: <family>-<tier>[-r<rev>].

Usage:
    python3 tools/run_dlc_batch.py <apk> <zipdir> [<zipdir> ...]
                                   [--skip <substring> ...] [--dry-run]

Examples:
    7z x -y -o/tmp/tsto/3_0_30 cdn/3_0_30.7z
    7z x -y -o/tmp/tsto/1_1_35 cdn/1_1_35.7z
    python3 tools/run_dlc_batch.py Springfield-V08.apk \
        /tmp/tsto/3_0_30 /tmp/tsto/1_1_35 --skip fontcache
"""
import argparse
import glob
import json
import os
import re
import runpy
import sys

URL_3_0_30 = 'https://archive.org/download/tsto-cdn-content/cdn/3_0_30.7z'
URL_1_1_35 = 'https://archive.org/download/tsto-cdn-content/cdn/1_1_35.7z'
ARCHIVE_CDN = 'https://archive.org/download/tsto-cdn-content/cdn/{}.7z'
TIERS = ('100', '50', '25', 'ipad', 'ipad3', 'iphone', 'retina')
NAME_RE = re.compile(
    r'^(?P<stem>[\w-]+?)-v(?P<season>[\w_]+)'
    r'(?:-r(?P<rev>\d+)(?:-[0-9A-Za-z]+)?)?$')
BUNDLE_RE = re.compile(
    r'^(?P<stem>[\w-]+?)(?:-r(?P<rev>\d+)(?:-[0-9A-Za-z]+)?)?$')


def _split_family_tier(stem, base):
    """Split a bare stem into (family, tier) on the last dash.

    The tier is whatever the CDN put after the family: a device class
    (ipad/retina/...), a resolution (100/50/25), an audio codec
    (mp3/caf/wav) or a language code (de/tc/zh...). Single-token stems
    (gamescripts) have no tier.
    """
    if '-' in stem:
        family, tier = stem.rsplit('-', 1)
    else:
        family, tier = stem, None
    return family, tier


def spec_for(path):
    """Build a --dlc spec for one pack zip, or None to skip it."""
    base = os.path.basename(path)[:-4]
    if base.startswith('DLCIndex'):
        print(f'skip (index container, not a pack): {base}')
        return None
    m = NAME_RE.match(base)
    if not m:
        # No -v<season> suffix: the season (bundle name) is the containing
        # directory, e.g. .../3_0_0_Thanksgiving/channel6menu-ipad-r146180-TAG
        season = os.path.basename(os.path.dirname(os.path.abspath(path)))
        m = BUNDLE_RE.match(base)
        if not m or not re.match(r'^[\w][\w.-]*$', season):
            print(f'skip (unrecognised name): {base}')
            return None
        stem, rev = m.group('stem'), m.group('rev')
        family, tier = _split_family_tier(stem, base)
        pack = stem + (f'-r{rev}' if rev else '')
        return {
            'file': os.path.abspath(path),
            'url': ARCHIVE_CDN.format(season),
            'pack': pack,
            'family': family,
            'tier': tier,
            'season': season,
            'revision': int(rev) if rev else None,
        }
    stem, season, rev = m.group('stem'), m.group('season'), m.group('rev')
    if season == '1_1_35':
        toks = stem.split('-')
        if len(toks) == 4 and toks[0] == 'movie' \
                and toks[2] in ('ipad', 'ipad3', 'iphone', 'retina'):
            movie, device, lang = toks[1], toks[2], toks[3]
            family = movie if lang == 'en' else f'{movie}-{lang}'
            tier = device
            pack = base
        else:
            print(f'skip (not a movie pack): {base}')
            return None
        url = URL_1_1_35
    else:
        # any other -v<season> name (2_3_0, 3_0_0, 1_0_4, ...): same
        # family-tier[-r<rev>] naming as 3_0_30
        family, tier = _split_family_tier(stem, base)
        pack = stem + (f'-r{rev}' if rev else '')
        url = ARCHIVE_CDN.format(season)
    return {
        'file': os.path.abspath(path),
        'url': url,
        'pack': pack,
        'family': family,
        'tier': tier,
        'season': season,
        'revision': int(rev) if rev else None,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument('apk')
    ap.add_argument('zipdirs', nargs='+')
    ap.add_argument('--skip', action='append', default=[],
                    help='skip zips whose name contains this (repeatable)')
    ap.add_argument('--prefix', action='append', default=[],
                    help='only include zips whose name starts with one of '
                         'these (repeatable)')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    zips = []
    for d in args.zipdirs:
        zips.extend(glob.glob(os.path.join(d, '*.zip')))
    zips.sort()

    specs, packs = [], set()
    for z in zips:
        if any(s in os.path.basename(z) for s in args.skip):
            continue
        if args.prefix and not any(
                os.path.basename(z).startswith(p) for p in args.prefix):
            continue
        spec = spec_for(z)
        if spec is None:
            continue
        if spec['pack'] in packs:
            print(f'dup pack name (skipping 2nd): {spec["pack"]}')
            continue
        packs.add(spec['pack'])
        specs.append(spec)

    print(f'{len(specs)} pack specs from {len(zips)} zips '
          f'({len(zips) - len(specs)} skipped)')
    for s in specs:
        print(f"  {s['pack']:<45} tier={s['tier']} rev={s['revision']}")

    if args.dry_run:
        return

    argv = [os.path.basename(os.path.abspath(__file__)), args.apk]
    for s in specs:
        argv += ['--dlc', json.dumps(s, separators=(',', ':'))]
    here = os.path.dirname(os.path.abspath(__file__))
    sys.argv = argv
    runpy.run_path(os.path.join(here, 'extract_assets.py'),
                   run_name='__main__')


if __name__ == '__main__':
    main()
