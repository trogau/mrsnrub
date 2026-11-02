#!/usr/bin/env python3
"""
Boot-screen asset extractor (M5.1a) — pulls the game's boot/loading UI art
out of the local `cdn/` .7z bundles into `web/assets/boot/`, with full pack
provenance, alongside the APK-side set already in `web/assets/images`.

Boot-relevant CDN packs (verified 2026-10-29 against web/assets/manifest.json
and live `7z l` listings):

    SplashScreens-<tier>-r157326     bundle 4_12_XMAS2014_Takedown_Alt_3CAW93BIJU9G.7z
        splashscreen.rgb             the splash strip (same layout role as the
                                     APK's core-splashes splashscreen.rgb)
        splashscreen_homer.rgb       Homer panel on the splash
        splashscreen_hand.rgb        tap-to-start finger
        splashscreen_signature.rgb   signature plate
        technicaldifficulties(_leftside).rgb   the error scene
        lang_<lang>.rgb              per-language "The Simpsons Taped Out"
                                     splash title art (16 languages)
        *.txt sidecars               anchor coords, copied to data/ verbatim

    menu-<tier>-r<rev>  (5 revisions x 4 tiers)   bundle 3_0_30.7z
        loading_donut.rgb            the Homer-donut loading spinner
        donutbunch_NN.rgb            donut-bunch burst frames (x6)
        dailybonustitleart_NN.rgb    daily-bonus title art frames (x6)

Each pack zip is the standard container (0 = 'BGrm' index, 1 = ZIP of asset
files, notes/01); only the boot members are decoded. .rgb -> PNG uses the
verified decoders in tools/extract_assets.py (imported, never modified);
thumbs via its make_thumb(). The pack zip is streamed from the 7z with
`7z x -so` (same invocation as tools/cdn_explorer.py) — nothing is fetched,
nothing outside --assets/--js is written.

The APK side is NOT re-extracted (extract_assets.py owns web/assets/images);
its boot entries are catalogued from disk into the same manifest with
group='apk' so the boot explorer can show both sides side by side. The
source pack for each APK entry follows extract_assets.py's naming rules
(core-splashes-<class> for splash/error/lang art, core-<class> for the
loading donut, res/drawable, audio/res-audio).

The DLC side is likewise catalogued, not re-extracted (group='dlc'): the
full-screen splash panels each event DLC pack ships
(bse_<event>_minieventpanel_intro/outro.png in the <Event>Menu packs) and
the Krustyland unlock splash (fullscreen.png in the
KrustylandSplashes-<os>-<tier>-r<rev> packs). Each entry carries a 'dlc'
source name (pack family minus Menu/Splashes) so the boot explorer can
offer one source button per DLC.

Outputs (pipeline-owned; wiped and rewritten on each run):

    web/assets/boot/images/<pack>/<name>.png   decoded PNGs
    web/assets/boot/thumbs/<pack>/<name>.png   grid thumbnails (~192 px)
    web/assets/boot/data/<pack>/<file>         anchor .txt sidecars (raw)
    web/assets/boot/boot-manifest.json         inventory + provenance

Then run tools/gen_boot_explorer.py to turn the manifest into the
web/js/boot-explorer-data.js the boot explorer page (M5.1b) loads.

Usage:
    python3 tools/extract_boot_assets.py [--cdn cdn] [--assets web/assets]
        [--bundles a.7z,b.7z] [--dry-run]
"""

import argparse
import io
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import zipfile
from datetime import datetime, timezone

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TOOLS_DIR)
import extract_assets as ea  # verified decoders + pure-Python PNG writer

# ---------------------------------------------------------------------------
# boot pack specs (verified 2026-10-29: manifest dlc provenance + 7z listings)
# ---------------------------------------------------------------------------

TIERS = ('iphone', 'ipad', 'retina', 'ipad3')

# bundle .7z -> pack families to pull from it
BOOT_BUNDLES = [
    {
        'bundle': '4_12_XMAS2014_Takedown_Alt_3CAW93BIJU9G.7z',
        'families': [{
            'family': 'SplashScreens',
            # keep everything the pack ships: boot art + anchor sidecars
            'include': r'.*\.(rgb|txt)$',
        }],
    },
    {
        'bundle': '3_0_30.7z',
        'families': [{
            'family': 'menu',
            # only the boot/loading UI members of the core menu packs
            # (the packs' *_menu/sidebar_*/indicator_* art is NOT boot UI)
            'include': r'^(loading_donut|donutbunch_\d+|dailybonustitleart_\d+)'
                       r'\.(rgb|txt)$',
        }],
    },
]

# member stem -> (role, tab group, human label). Matched on the .rgb stem.
def role_of(stem):
    m = re.match(r'^(lang_[a-z]+)$', stem)
    if m:
        return ('splash-title', 'splash', 'Splash title (per language)')
    ROLES = {
        'splashscreen':                ('splash-strip',   'splash', 'Splash strip'),
        'splashscreen_homer':          ('splash-homer',   'splash', 'Splash Homer panel'),
        'splashscreen_hand':           ('splash-hand',    'splash', 'Tap-to-start hand'),
        'splashscreen_signature':      ('splash-signature', 'splash', 'Signature plate'),
        'technicaldifficulties':       ('error',          'error',  'Error scene'),
        'technicaldifficulties_leftside': ('error-leftside', 'error', 'Error scene (left panel)'),
        'loading_donut':               ('loading-donut',  'loading', 'Loading donut'),
        'donutbunch_00':               ('donut-bunch',    'extras', 'Donut-bunch burst'),
        'dailybonustitleart_00':       ('bonus-title',    'extras', 'Daily-bonus title'),
    }
    base = re.sub(r'_\d\d$', '', stem)
    role = ROLES.get(stem) or ROLES.get(base)
    if role:
        return role
    if stem.startswith('donutbunch_'):
        return ('donut-bunch', 'extras', 'Donut-bunch burst')
    if stem.startswith('dailybonustitleart_'):
        return ('bonus-title', 'extras', 'Daily-bonus title')
    return None


# ---------------------------------------------------------------------------
# APK-side boot inventory (extract_assets.py owns these files; we only
# catalogue them so the boot explorer shows CDN and APK art side by side).
# source follows extract_assets.py's rules; membership verified 2026-10-29
# against web/assets/manifest.json.
# ---------------------------------------------------------------------------

def apk_source(path):
    """core-splashes-<class> / core-<class> / res/drawable / audio/res-audio,
    following extract_assets.py's SPLASH_CLASSES / CORE_UI_CLASSES naming."""
    base = path.rsplit('/', 1)[-1]
    stem = base.rsplit('.', 1)[0]
    if base in ('10_next_segment.wav', 'bgloop.wav'):
        return 'audio/res-audio'
    if base == 'splashdefault.png':
        return 'res/drawable'
    def cls(stem):
        for s in ('_large', '_medium_small', '_medium', '_small'):
            if stem.endswith(s):
                return {'_large': 'large', '_medium_small': 'medium-small',
                        '_medium': 'medium',
                        '_small': 'small'}[s]
        return 'medium' if stem.startswith(('splash', 'signature', 'bse_',
                                            'technical', 'lang_')) else 'large'
    c = cls(stem)
    if stem.startswith('loading_donut'):
        return 'core/core-' + c
    if stem.startswith(('splash', 'signature', 'bse_titl', 'technical', 'lang_')):
        return 'core/core-splashes-' + c
    return None


def role_of_apk(stem):
    m = re.match(r'^(lang_[a-z]+)(_large|_medium_small|_medium|_small)?$', stem)
    if m:
        return ('splash-title', 'splash', 'Splash title (per language)')
    base = re.sub(r'_(large|medium|medium_small|small)$', '', stem)
    ROLES = {
        'splashscreen':              ('splash-strip',    'splash', 'Splash strip'),
        'splash_homer':              ('splash-homer',    'splash', 'Splash Homer panel'),
        'splashfinger':              ('splash-hand',     'splash', 'Tap-to-start finger'),
        'splashdefault':             ('splash-default',  'splash', 'Android boot splash (default)'),
        'signature':                 ('splash-signature', 'splash', 'Signature plate'),
        'bse_titl_coppagradient':    ('splash-gradient', 'splash', 'Copper gradient bar'),
        'technicaldifficulties':     ('error',           'error',  'Error scene'),
        'technicaldifficulties_leftside': ('error-leftside', 'error', 'Error scene (left panel)'),
        'loading_donut':             ('loading-donut',   'loading', 'Loading donut'),
    }
    return ROLES.get(base)


APK_AUDIO = ('10_next_segment.wav', 'bgloop.wav')


# ---------------------------------------------------------------------------
# DLC-side splash art (already extracted by extract_assets.py under
# web/assets/dlc/<pack>/). Catalogued from disk, never re-extracted:
#
#   bse_<event>_minieventpanel_intro/outro.png   the full-screen splash panel
#       each event DLC pack ships (shown when the event unlocks) — lives in
#       the event's <Event>Menu-<tier>-r<rev> packs
#   fullscreen.png                               Krustyland unlock splash,
#       one per KrustylandSplashes-<os>-<tier>-r<rev> pack
# ---------------------------------------------------------------------------

DLC_SPLASH_RE = re.compile(r'^bse_([a-z0-9]+)_minieventpanel_(intro|outro)$')


def dlc_splash_source(family):
    """Pack family -> the DLC name to filter/label by:
    'SplashAndBurnMenu' -> 'SplashAndBurn';
    'AnimalFriendlyThanksgivingMenu_LTD' -> 'AnimalFriendlyThanksgiving'
    (patch/LTD variants of one event share a button);
    'KrustylandSplashes-ios' -> 'Krustyland (ios)'."""
    name = re.sub(r'(_Patch_?\d+)?(_Menu|Menu)(_LTD)?$', '', family)
    m = re.match(r'^KrustylandSplashes-(ios|android)$', name)
    if m:
        return 'Krustyland (%s)' % m.group(1)
    return name


def collect_dlc_splash_entries(assets_dir):
    """Catalogue the per-DLC splash screens from web/assets/dlc/<pack>/images/."""
    entries = []
    dlc_root = os.path.join(assets_dir, 'dlc')
    if not os.path.isdir(dlc_root):
        return entries
    with os.scandir(dlc_root) as it:
        packs = sorted(e.name for e in it if e.is_dir())
    for pack in packs:
        parsed = pack_of_zip(pack + '.zip')
        if not parsed:
            continue
        _, family, tier, rev = parsed
        idir = os.path.join(dlc_root, pack, 'images')
        if not os.path.isdir(idir):
            continue
        for name in sorted(os.listdir(idir)):
            stem = name.rsplit('.', 1)[0]
            if not name.lower().endswith('.png'):
                continue
            m = DLC_SPLASH_RE.match(stem)
            if m:
                event, io_ = m.group(1), m.group(2)
                role = 'dlc-splash-' + io_
                label = 'Event splash (%s) — %s' % (io_, event)
                dlc = dlc_splash_source(family)
            elif stem == 'fullscreen' and family.startswith('KrustylandSplashes'):
                os_name = family.rsplit('-', 1)[-1]
                role = 'dlc-splash'
                label = 'Krustyland unlock splash (%s)' % os_name
                dlc = dlc_splash_source(family)
            else:
                continue
            full = os.path.join(idir, name)
            try:
                blob = open(full, 'rb').read()
                w, h = ea.png_dims(blob)
            except (OSError, ValueError):
                print('    SKIP dlc/%s/images/%s (unreadable)' % (pack, name))
                continue
            thumb = 'dlc/%s/thumbs/%s' % (pack, name)
            if not os.path.isfile(os.path.join(dlc_root, pack, 'thumbs', name)):
                thumb = None
            entries.append({
                'path': 'dlc/%s/images/%s' % (pack, name),
                'thumb': thumb,
                'type': 'image',
                'group': 'dlc',
                'role': role, 'tab': 'dlcsplash', 'label': label,
                'slot': stem,
                'bundle': None,
                'pack': pack,
                'tier': tier,
                'revision': rev,
                'origin': name,
                'dlc': dlc,
                'bytes': len(blob),
                'w': w, 'h': h,
            })
    return entries



def collect_apk_entries(assets_dir):
    """Catalogue the APK-side boot files from web/assets/{images,audio,thumbs}."""
    entries = []
    img_dir = os.path.join(assets_dir, 'images')
    thumbs = os.path.join(assets_dir, 'thumbs')
    for name in sorted(os.listdir(img_dir)):
        stem = name.rsplit('.', 1)[0]
        role = role_of_apk(stem)
        if not role:
            continue
        full = os.path.join(img_dir, name)
        blob = open(full, 'rb').read()
        w, h = ea.png_dims(blob)
        thumb = 'thumbs/' + name
        if not os.path.isfile(os.path.join(thumbs, name)):
            thumb = None
        tier = None
        for s in ('_large', '_medium_small', '_medium', '_small'):
            if stem.endswith(s):
                tier = {'_large': 'large', '_medium_small': 'medium-small',
                        '_medium': 'medium',
                        '_small': 'small'}[s]
                break
        if tier is None:
            tier = ('android' if stem == 'splashdefault'
                    else 'medium' if stem.startswith(
                        ('splash', 'signature', 'bse_', 'technical', 'lang_'))
                    else 'large')
        entries.append({
            'path': 'images/' + name,
            'thumb': thumb,
            'type': 'image',
            'group': 'apk',
            'role': role[0], 'tab': role[1], 'label': role[2],
            'slot': re.sub(r'_(large|medium|medium_small|small)$', '', stem),
            'bundle': 'Springfield-V08.apk',
            'pack': apk_source('images/' + name),
            'tier': tier,
            'revision': None,
            'origin': None,
            'bytes': len(blob),
            'w': w, 'h': h,
        })
    for name in APK_AUDIO:
        full = os.path.join(assets_dir, 'audio', name)
        if not os.path.isfile(full):
            continue
        blob = open(full, 'rb').read()
        info = ea.wav_info(blob) or ()
        entries.append({
            'path': 'audio/' + name,
            'thumb': None,
            'type': 'audio',
            'group': 'apk',
            'role': 'boot-audio', 'tab': 'audio',
            'label': 'Scene-handoff sting' if name.startswith('10_') else 'City music loop',
            'slot': name.rsplit('.', 1)[0],
            'bundle': 'Springfield-V08.apk',
            'pack': 'audio/res-audio',
            'tier': None, 'revision': None,
            'origin': name,
            'bytes': len(blob),
            'w': None, 'h': None,
            'kind': 'sfx' if name.startswith('10_') else 'music',
            **({'audio_format': info[0], 'channels': info[1],
                'sample_rate': info[2], 'duration_s': round(info[3], 1)}
               if len(info) == 4 else {}),
        })
    return entries


# ---------------------------------------------------------------------------
# 7z access (same two invocations as tools/cdn_explorer.py)
# ---------------------------------------------------------------------------

def seven_zip():
    for exe in ('7z', '7za'):
        p = shutil.which(exe)
        if p:
            return p
    raise SystemExit('need 7z (or 7za) on PATH')


def list_7z(bundle_path):
    """{member path: size} for a .7z bundle (cheap archive-tail listing)."""
    out = subprocess.run([seven_zip(), 'l', '-slt', bundle_path],
                         capture_output=True, text=True, timeout=1800)
    if out.returncode != 0:
        raise RuntimeError('7z l failed on %s: %s' % (bundle_path, out.stderr[:200]))
    members, cur = {}, None
    for line in out.stdout.splitlines():
        if line.startswith('Path = ') and not line[7:].endswith('/'):
            cur = line[7:]
        elif line.startswith('Size = ') and cur is not None:
            try:
                members[cur] = int(line[7:])
            except ValueError:
                pass
            cur = None
        elif line.startswith('Attributes = ') and 'D' in line[13:].split()[0:1]:
            cur = None
    return {k: v for k, v in members.items() if not k.endswith('.time')}


def extract_7z_stream(bundle_path, member):
    """Stream ONE member of a .7z to memory via `7z x -so`."""
    p = subprocess.run([seven_zip(), 'x', '-so', bundle_path, member],
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       timeout=600)
    if p.returncode != 0 or not p.stdout:
        raise RuntimeError('7z x -so failed for %s!%s: %s'
                           % (bundle_path, member, p.stderr[:200]))
    return p.stdout


# ---------------------------------------------------------------------------
# pack zip naming grammar (mirrors run_dlc_batch.pack_of_zip / NAME_RE)
# ---------------------------------------------------------------------------

SIG_RE = re.compile(r'-(?=[0-9A-Z]{6,8}$)[0-9A-Z]{6,8}$')
REV_RE = re.compile(r'-r(\d+)$')
VSEASON_RE = re.compile(r'-v\d[\w.]*$')


def pack_of_zip(member):
    """'3_0_30/menu-ipad-v3_0_30-r146180-0D2B882C.zip' ->
    ('menu-ipad-r146180', 'menu-ipad', 'ipad', 146180)."""
    base = member.rsplit('/', 1)[-1]
    if base.endswith('.zip'):
        base = base[:-4]
    base = SIG_RE.sub('', base)
    rev = None
    m = REV_RE.search(base)
    if m:
        rev = int(m.group(1))
        base = base[:m.start()]
    base = VSEASON_RE.sub('', base)
    m = re.match(r'^(.*)-([^-]+)$', base)
    if not m:
        return None
    family, tier = m.group(1), m.group(2)
    pack = base if rev is None else '%s-r%d' % (base, rev)
    return pack, family, tier, rev


# ---------------------------------------------------------------------------
# CDN extraction
# ---------------------------------------------------------------------------

def extract_cdn(cdn_dir, boot_dir, bundles_filter=None, dry_run=False):
    """Decode boot art from the cdn/ bundles. Returns (entries, bundles_used)."""
    entries = []
    bundles_used = []
    for spec in BOOT_BUNDLES:
        bundle = spec['bundle']
        if bundles_filter and bundle not in bundles_filter:
            continue
        bundle_path = os.path.join(cdn_dir, bundle)
        if not os.path.isfile(bundle_path):
            print('WARNING: bundle missing, skipped: %s' % bundle)
            continue
        wanted_families = {f['family']: re.compile(f['include']) for f in spec['families']}
        members = list_7z(bundle_path)
        hits = []
        for member in sorted(members):
            parsed = pack_of_zip(member)
            if not parsed:
                continue
            pack, family, tier, rev = parsed
            if family in wanted_families and tier in TIERS:
                hits.append((member, pack, family, tier, rev))
        if not hits:
            print('WARNING: no boot packs matched in %s' % bundle)
            continue
        bundles_used.append({'bundle': bundle,
                             'bytes': os.path.getsize(bundle_path),
                             'packs': len(hits)})
        for member, pack, family, tier, rev in hits:
            print('  %s ! %s' % (bundle, member))
            if dry_run:
                continue
            blob = extract_7z_stream(bundle_path, member)
            try:
                with zipfile.ZipFile(io.BytesIO(blob)) as z:
                    idx = z.read('0') if '0' in z.namelist() else b''
                    inner = zipfile.ZipFile(io.BytesIO(z.read('1')))
                    ilist = inner.infolist()
                index_version = (struct.unpack_from('<I', idx, 4)[0]
                                 if idx[:4] == b'BGrm' else None)
                seen = set()
                for info in ilist:
                    if info.is_dir():
                        continue
                    name = info.filename.rsplit('/', 1)[-1]
                    stem = name.rsplit('.', 1)[0]
                    if stem.endswith('.rgb'):      # anchor sidecar: foo.rgb.txt
                        stem = stem[:-4]
                    if not wanted_families[family].match(name):
                        continue
                    if name in seen:   # pack zips may store a name twice
                        continue
                    seen.add(name)
                    data = inner.read(info)
                    if name.endswith('.rgb'):
                        role = role_of(stem)
                        if not role:
                            continue
                        try:
                            w, h, _bpp, rgba, _premul = ea.rgb_to_rgba(data, name)
                        except Exception as e:            # noqa: BLE001
                            print('    SKIP %s: %s' % (name, e))
                            continue
                        ipath = 'boot/images/%s/%s.png' % (pack, stem)
                        tpath = 'boot/thumbs/%s/%s.png' % (pack, stem)
                        full_i = os.path.join(boot_dir, 'images', pack, stem + '.png')
                        os.makedirs(os.path.dirname(full_i), exist_ok=True)
                        ea.write_png(full_i, w, h, rgba)
                        thumb_rel = None
                        t = ea.make_thumb(w, h, rgba)
                        if t:
                            os.makedirs(os.path.join(boot_dir, 'thumbs', pack),
                                         exist_ok=True)
                            ea.write_png(os.path.join(boot_dir, 'thumbs', pack,
                                                      stem + '.png'), t[0], t[1], t[2])
                            thumb_rel = tpath
                        entries.append({
                            'path': ipath, 'thumb': thumb_rel, 'type': 'image',
                            'group': 'cdn',
                            'role': role[0], 'tab': role[1], 'label': role[2],
                            'slot': re.sub(r'_\d\d$', '', stem),
                            'bundle': bundle, 'pack': pack, 'tier': tier,
                            'revision': rev, 'origin': name,
                            'bytes': len(data), 'pngBytes': os.path.getsize(full_i),
                            'w': w, 'h': h, 'indexVersion': index_version,
                        })
                    elif name.endswith('.txt'):
                        dpath = 'boot/data/%s/%s' % (pack, name)
                        full_d = os.path.join(boot_dir, 'data', pack, name)
                        os.makedirs(os.path.dirname(full_d), exist_ok=True)
                        with open(full_d, 'wb') as f:
                            f.write(data)
                        entries.append({
                            'path': dpath, 'thumb': None, 'type': 'data',
                            'group': 'cdn',
                            'role': 'anchor', 'tab': 'data',
                            'label': 'Anchor sidecar',
                            'slot': stem,
                            'bundle': bundle, 'pack': pack, 'tier': tier,
                            'revision': rev, 'origin': name,
                            'bytes': len(data), 'w': None, 'h': None,
                            'indexVersion': index_version,
                            'text': data.decode('utf-8', 'replace')[:200],
                        })
                inner.close()
            except (OSError, zipfile.BadZipFile, KeyError) as e:
                print('    WARNING: pack %s unreadable (%s) - skipped' % (pack, e))
    return entries, bundles_used


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

TABS = ['splash', 'dlcsplash', 'loading', 'error', 'extras', 'audio', 'data']
TIER_RANK = {'iphone': 0, 'ipad': 1, 'retina': 2, 'ipad3': 3,
             'small': 0, 'medium-small': 1, 'medium': 2, 'large': 3}
TAB_RANK = {t: i for i, t in enumerate(TABS)}


def sort_key(e):
    return (TAB_RANK.get(e['tab'], 99), e['role'], e['slot'],
            {'apk': 0, 'cdn': 1}.get(e['group'], 2),
            TIER_RANK.get(e['tier'] or '', 9),
            -(e['revision'] or 0), e['pack'])


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument('--cdn', default=os.path.join(REPO_ROOT, 'cdn'))
    ap.add_argument('--assets', default=os.path.join(REPO_ROOT, 'web', 'assets'))
    ap.add_argument('--bundles', help='comma-separated bundle .7z names to use '
                                      '(default: all specs)')
    ap.add_argument('--dry-run', action='store_true',
                    help='list the boot packs without extracting')
    args = ap.parse_args()

    bundles_filter = set(args.bundles.split(',')) if args.bundles else None
    boot_dir = os.path.join(args.assets, 'boot')

    if not args.dry_run:
        if os.path.isdir(boot_dir):
            shutil.rmtree(boot_dir)
        for sub in ('images', 'thumbs', 'data'):
            os.makedirs(os.path.join(boot_dir, sub), exist_ok=True)

    print('CDN boot packs:')
    cdn_entries, bundles_used = extract_cdn(args.cdn, boot_dir, bundles_filter,
                                            args.dry_run)
    print('APK-side boot entries:')
    apk_entries = [] if args.dry_run else collect_apk_entries(args.assets)
    print('  %d files from %s/{images,audio}' % (len(apk_entries), args.assets))
    print('DLC-side splash entries:')
    dlc_entries = [] if args.dry_run else collect_dlc_splash_entries(args.assets)
    n_dlc = len({e['dlc'] for e in dlc_entries})
    print('  %d files from %d DLC splash sources in %s/dlc'
          % (len(dlc_entries), n_dlc, args.assets))

    files = sorted(cdn_entries + apk_entries + dlc_entries, key=sort_key)
    counts = {}
    for e in files:
        counts[e['tab']] = counts.get(e['tab'], 0) + 1
    manifest = {
        'generated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'tool': 'tools/extract_boot_assets.py',
        'notes': [
            'Boot-screen art for the M5.1 boot sequence, extracted from the '
            'local cdn/ .7z bundles (group=cdn, with pack provenance) plus '
            'the APK-side set already extracted by tools/extract_assets.py '
            '(group=apk; those files stay under web/assets/{images,audio}) '
            'plus the per-DLC splash screens (group=dlc; event '
            'minieventpanel_intro/outro panels and KrustylandSplashes '
            'fullscreen art, catalogued from web/assets/dlc/).',
            'Paths are relative to web/assets/. Pipeline-owned: only this '
            'tool writes web/assets/boot/.',
        ],
        'bundles': bundles_used,
        'counts': counts,
        'files': files,
    }

    if args.dry_run:
        print('dry run: %d CDN entries would be extracted' % len(cdn_entries))
        return 0

    with open(os.path.join(boot_dir, 'boot-manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=1)
        f.write('\n')
    print('wrote %s (%d files: %s)'
          % (os.path.relpath(boot_dir, REPO_ROOT), len(files),
             ', '.join('%s=%d' % kv for kv in sorted(counts.items()))))
    print('now run: python3 tools/gen_boot_explorer.py')
    return 0


if __name__ == '__main__':
    sys.exit(main())
