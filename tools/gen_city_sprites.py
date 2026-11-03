#!/usr/bin/env python3
"""City sprite pipeline: local CDN pool -> static sprite PNGs + anchor manifest.

Phase 2 (planning/phase-2-camera-view.md). Local-only: reads cdn/ + data/,
scratch pool in /tmp/opencode/citypool/ (disposable — re-run if wiped; the
path is a symlink to the project's .scratch/ on disk — the 12 GiB per-user
tmpfs quota cannot hold pool + season archives + worker staging),
generated output in web/assets/city/ (never hand-edit that directory).

Subcommands
-----------
  extract --worker N --workers M   pull the required slugs' rgb/bsv3/xml out
                                   of the 611-family *Game-100* pool into
                                   /tmp/opencode/citypool/. Run one process
                                   per worker (N = 0..M-1). Also handles the
                                   core game-100 pack with --core.
  backfill --worker N --workers M  scan EVERY candidate row (all revisions
                                   of every family) against the pool: keep
                                   files the first pass missed, and archive
                                   byte-different re-ships under
                                   /tmp/opencode/citypool/season/<class>/
                                   (the season-mode art; see classify_season).
                                   Never overwrites a pool main file.
  resolve                          base-preferred resolution: for every pool
                                   main whose family is a seasonal pack,
                                   promote the archived base copy from
                                   season/base/ and file the seasonal art
                                   into season/<class>/ (idempotent; sprites
                                   and anims run it automatically).
  report                           merge per-worker index files, print the
                                   coverage report (required slugs vs pool).
  sprites [--slug X] [--parse-only]  bsv3 parse (0x0103 + 0x0303 variants),
                                    static-frame compositing (fullest frame
                                    for 0x0103, frame 0 for 0x0303), writes
                                    web/assets/city/<slug>.png plus the
                                    city-sprites.json anchor manifest, and
                                    the per-slug season variants under
                                    web/assets/city/seasons/<class>/<slug>.png
                                    (manifest 'seasons' sub-maps).
                                    --shard I --shards N renders only
                                    sorted-required[I::N] into a private
                                    city-sprites-shardI.json — run N of
                                    these in parallel (single process gets
                                    OOM-killed on the full run even with the
                                    periodic malloc_trim), then sprites-merge.
                                    --parse-only validates every pool bsv3
                                    to exact EOF without rendering.
  sprites-merge                      fold city-sprites-shard*.json fragments
                                    into city-sprites.json, prune stale
                                    season PNGs, unlink the fragments.
  reanchor                         rewrite city-sprites.json anchors from the
                                    pool xml defs (no PNG re-render): a
                                    non-zero transImageX/Y pair is the
                                    authoritative engine anchor.
  chars                            character idle-frame PNGs from .bcell animation cells in the pool
  chars                            (family packs — run the extract workers first for full coverage) plus
  chars                            the core game-100 pack, matched to the save character names; writes
  chars                            web/assets/characters/<slug>*.png plus characters.json (asset
  chars                            manifest + save-id -> asset map for the M3 defID lookup).
  anims [--slug X] [--cap N] [--placed]  named-anim filmstrip atlases for animated 0x0103 bsv3 files:
                                   every named anim with >1 distinct frame is rendered (deduped,
                                   thinned to N frames, anchor-centred cells) into
                                   web/assets/city/anims/<slug>__<anim>.png + city-anims.json
                                   (consumed by the map pages' variant strips). --placed limits
                                   the batch to slugs the save actually places. city-anims.json
                                   also carries the 'behavior' gate (engine idle/tap anim per
                                   slug, plus the part loops a multi-part asset composites over its
                                   body) consumed by the City View map player.
                                     behavior [--refresh] [--write-map]
                                                           scan the extracted gamescripts packs for what the
                                                           engine actually animates: the
                                                           ActiveAnimationController/neutralAnim idle loop, the
                                                           BuildingTouched script's tap anim, and the
                                                           <AnimationLayerOrder> part lists per building. Cached in
                                                           data/building_behaviors.json (the scan walks ~190 packs;
                                                           re-run after new DLC extraction). --write-map regenerates
                                                           only city-anims.json's behavior gate from the existing
                                                           filmstrips (no atlas work).

The family list is the 611-family candidate set from the footprint pool
work (g100_cands{,2,3}.tsv in /tmp/opencode/, rebuilt from cdn/ with the
*Game-100* / *Game_LTD-100* / *BuildDecoGame*{Fall,Snow}-100 patterns if
gone — Game-25/50 excluded, see notes/01 catalog section).
"""

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from PIL import Image  # noqa: E402
Image.MAX_IMAGE_PIXELS = None   # the filmstrips are our own generated
                                # output: 100+ Mpx atlases are no bomb
from extract_assets import rgb_to_rgba  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CDN = ROOT / 'cdn'
DATA = ROOT / 'data'
POOL = Path('/tmp/opencode/citypool')
WORK_BASE = Path('/tmp/opencode/citypool_work')
CANDS = [Path(f'/tmp/opencode/g100_cands{i}.tsv')
         for i in ('', '2', '3', '4', '5')]
CORE_ZIP = CDN / '3_0_30' / 'game-100-v3_0_30.zip'


# ---------------------------------------------------------------- catalogs

def load_json(name):
    with open(DATA / name) as f:
        return json.load(f)


def compute_required():
    """The set of slugs the save can actually instantiate, plus their
    flipped variants (mirror buildings + monorail straight-track) and the
    directional fence assets. Superset on purpose: the save's per-instance
    flipState only removes from this, never adds to it."""
    ids = load_json('building_ids.json')
    sav = load_json('save_buildings.json')
    fp = load_json('building_footprints.json')
    fl = load_json('flip_assets.json')
    kmap = {k.lower().replace('_', ''): k for k in fl}

    req = set()
    for bid, rec in sav.items():
        slug = ids.get(bid, {}).get('slug') or rec['name'].lower()
        req.add(slug)
        if (slug + 'flipped') in fp:
            req.add(slug + 'flipped')
        if rec.get('via') == 'flip':
            key = kmap.get(rec['name'].lower())
            if key:
                req.update(v.lower() for v in fl[key].values())
    return req


# ---------------------------------------------------------------- families

def load_families():
    """family -> first (pack7z, innerzip) row. Later rows are alternate
    revisions of the same family; the first row in the candidate list wins
    (same policy as the original g100 pipeline)."""
    fams = {}
    for tsv in CANDS:
        if not tsv.exists():
            continue
        for line in open(tsv):
            parts = line.rstrip('\n').split('\t')
            if len(parts) < 4:
                continue
            fam, size, pack, inner = parts[0], int(parts[1]), parts[2], parts[3]
            fams.setdefault(fam, (pack, inner, size))
    return dict(sorted(fams.items()))


def open_inner_zip(work, pack, inner):
    """7z the inner pack zip out of the bundle, then open it (or its
    nested '1' payload) as a zip. Returns a zip path + cleanup dir."""
    work = Path(work)
    c = work / 'c'
    c.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(
        ['7z', 'x', '-y', str(CDN / pack), f'-o{c}', '--', inner],
        capture_output=True)
    zf = c / inner
    if r.returncode != 0 or not zf.exists():
        return None
    if zf.stat().st_size < 4096 or open(zf, 'rb').read(4) != b'PK\x03\x04':
        # not itself a zip — the pack zip IS the asset zip (flat packs)
        return zf
    x = work / 'x'
    x.mkdir(exist_ok=True)
    # extract only the '1' payload member (unzipping the whole pack staged
    # multiple GB on the quota-limited tmpfs pool volume for nothing)
    import zipfile
    with zipfile.ZipFile(zf) as z:
        names = z.namelist()
        if '1' in names:
            with z.open('1') as src, open(x / '1', 'wb') as dst:
                shutil.copyfileobj(src, dst)
            zf.unlink()
            return x / '1'
    return zf


# ---------------------------------------------------------------- worker

KINDS = {'.rgb': 'rgb', '.bsv3': 'bsv3', '.xml': 'xml', '.bcell': 'bcell'}

# ---------------------------------------------------------------- seasons
#
# TSTO has no client-side season switch: during an event the CDN simply
# RE-SHIPPED the same slug with themed art (XMAS*_Buildings_Snow_* reskinned
# the town in snow, Blargsgiving painted fall leaves, and every event patch
# carried a *BuildDecoGameSnow twin re-shipping the build-deco set with a
# snow overlay). The extraction pool used to resolve that by first-write-
# wins, so a seasonal copy that raced in first became THE art — which is why
# the map showed LawnChair/ChristmasGame snow under a summer town. The pool
# now keeps one main file per slug (base provider preferred) and archives
# byte-different re-ships under POOL/season/<class>/ for the season modes.
# Family-name classes (the pack naming is the only season signal the CDN
# layout leaves us); None = a plain/base content family.
SEASON = POOL / 'season'
SEASON_RULES = (
    ('base', r'nonwinter'),                # the 2014 unfreeze packs
    ('halloween', r'thoh|halloween'),      # before 'snow': THOH*...Snow
    ('winter', r'snow|xmas|christmas|coldturkey|newyears'),
    ('fall', r'blargsgiving|thanksgiving|gamefall'),
    ('easter', r'easter'),
    ('valentine', r'valentine'),
    ('july4th', r'4thofjuly'),
    ('stpatricks', r'stpatrick'),
    ('pride', r'pride'),
    ('summer', r'summergames|summerofourdiscontent|summerdonuts'),
)
SEASON_ORDER = ('winter', 'fall', 'halloween', 'easter', 'valentine',
                'july4th', 'stpatricks', 'pride', 'summer')
_SEASON_RE = [(c, re.compile(p)) for c, p in SEASON_RULES]


def classify_season(fam):
    """family name -> season class, or None for plain content packs.
    'base' means the name says so explicitly (NonWinter*); None is the
    ordinary base provider — both are non-seasonal for every policy here.
    Post-event *Takedown* revert packs ship the pre-event art, so they are
    base providers too — EXCEPT their own *Snow* families, which re-ship the
    generic snow cover (the revert removes the event decorations, not the
    winter skin), so those fall through to the ordinary season rules."""
    low = fam.lower()
    if 'takedown' in low and 'snow' not in low:
        return None
    for cls, rx in _SEASON_RE:
        if rx.search(low):
            return None if cls == 'base' else cls
    return None


def is_seasonal(fam):
    return classify_season(fam) is not None


def _md5_bytes(b):
    return hashlib.md5(b).hexdigest()


def load_rows():
    """every (fam, pack, inner, size) candidate row across the candidate
    TSVs, order-stable, exact-duplicate rows collapsed. load_families()
    keeps only each family's first row; the fill/backfill pass needs them
    all — a revision's zip can omit art its sibling revision ships
    (skinnerhouse's base art lives only in ArtieZiffGame-100 r119367, not
    first-listed r146180; crazycatladyshouse's lives only in the post-event
    XMAS*Takedown* revert packs)."""
    rows, seen = [], set()
    for tsv in CANDS:
        if not tsv.exists():
            continue
        for line in open(tsv):
            parts = line.rstrip('\n').split('\t')
            if len(parts) < 4:
                continue
            fam, size, pack, inner = parts[0], int(parts[1]), parts[2], parts[3]
            key = (fam, pack, inner)
            if key in seen:
                continue
            seen.add(key)
            rows.append((fam, pack, inner, size))
    return rows


def _wait_space(wid, need_bytes):
    """the pool volume (a tmpfs by default, symlinkable to disk) is quota
    limited; a multi-GB pack must not start its 7z staging when the volume
    is nearly full (workers run concurrently and one ENOSPC mid-write loses
    the family's keeps). Poll until there is room for the staged payload."""
    import time
    POOL.mkdir(parents=True, exist_ok=True)
    floor = max(int(need_bytes) * 3, 6 << 30)
    while shutil.disk_usage(POOL).free < floor:
        print(f'worker {wid}: waiting for pool volume space '
              f'({shutil.disk_usage(POOL).free >> 30} GiB free, '
              f'need {floor >> 30} GiB)', flush=True)
        time.sleep(30)


def _keep_files(z, fam, pack, log, required, stats):
    """write every keep-worthy entry of one pack zip into the pool.
    First copy of a file lands on POOL/<base>; a byte-DIFFERENT copy from a
    later family is archived under POOL/season/<class>/<base> ('base' when
    the later family is itself plain content — that copy lost the main race
    only to the scheduler). Byte-identical re-ships stay plain dup rows.
    .bcell cells never archive (character idle art has no season variants,
    and they are the pool's bulk — skipping their hash saves minutes)."""
    base_dir = SEASON / 'base'
    for n in z.namelist():
        b = os.path.basename(n)
        kind = KINDS.get(os.path.splitext(b)[1])
        if kind is None:
            continue
        slug = slug_of(b)
        is_tile = b.lower().startswith('roadtilesheet')
        is_bcell = kind == 'bcell'
        if not (is_tile or slug in required or is_bcell):
            continue
        stats['seen'] += 1
        dest = POOL / b
        if dest.exists():
            data = z.read(n)
            if is_bcell or _md5_bytes(dest.read_bytes()) == _md5_bytes(data):
                log.write(f'dup\t{b}\t{fam}\t{pack}\n')
                continue
            cls = classify_season(fam) or 'base'
            adir = SEASON / cls
            adir.mkdir(parents=True, exist_ok=True)
            adest = adir / b
            if adest.exists():      # one archived copy per (file, class)
                log.write(f'dup\t{b}\t{fam}\t{pack}\n')
                continue
            tmp = adest.with_suffix(adest.suffix + '.part')
            tmp.write_bytes(data)
            tmp.rename(adest)
            log.write(f'season\t{b}\t{fam}\t{pack}\t{cls}\n')
            stats['archived'] += 1
            continue
        tmp = dest.with_suffix(dest.suffix + '.part')
        tmp.write_bytes(z.read(n))
        tmp.rename(dest)
        stats['kept'] += 1
        log.write(f'{kind}\t{b}\t{fam}\t{pack}\n')


def backfill(wid, nworkers, only=None):
    """scan EVERY candidate row (all revisions of all families) against the
    existing pool, archiving byte-different re-ships into POOL/season/<cls>/
    and filling pool files the original extraction missed entirely. Never
    overwrites a pool main file. Run after extract; then `resolve`.
    `only` restricts the pass to rows whose family contains one of the given
    (comma-separated, case-insensitive) substrings — used to re-scan just
    the packs added to the candidate lists after the main run."""
    POOL.mkdir(parents=True, exist_ok=True)
    WORK_BASE.mkdir(parents=True, exist_ok=True)
    required = compute_required()
    rows = load_rows()
    if only:
        pats = [p.lower() for p in only.split(',') if p.strip()]
        rows = [r for r in rows if any(p in r[0].lower() for p in pats)]
    mine = [r for i, r in enumerate(rows) if i % nworkers == wid]
    log = open(POOL / f'index_bf{wid}.tsv', 'a')
    stats = {'seen': 0, 'kept': 0, 'archived': 0}
    fails = 0
    for fam, pack, inner, size in mine:
        work = WORK_BASE / f'bf{wid}'
        shutil.rmtree(work, ignore_errors=True)
        _wait_space(wid, size)
        zpath = open_inner_zip(work, pack, inner)
        if zpath is None:
            fails += 1
            log.write(f'FAIL\t{fam}\n')
            continue
        import zipfile
        try:
            with zipfile.ZipFile(zpath) as z:
                _keep_files(z, fam, pack, log, required, stats)
        except (OSError, zipfile.BadZipFile):
            fails += 1
            log.write(f'FAIL\t{fam}\n')
        shutil.rmtree(work, ignore_errors=True)
    log.close()
    print(f'backfill {wid}/{nworkers}: rows={len(mine)} kept={stats["kept"]} '
          f'archived={stats["archived"]} seen={stats["seen"]} fail={fails}',
          flush=True)


def _kept_fam_index():
    """pool basename -> family of its pool-keep index row (first row wins)."""
    fams = {}
    for log in sorted(POOL.glob('index_*.tsv')):
        try:
            for line in open(log):
                p = line.rstrip('\n').split('\t')
                if len(p) >= 3 and p[0] in ('rgb', 'bsv3', 'xml', 'bcell'):
                    fams.setdefault(p[1], p[2])
        except OSError:
            pass
    return fams


def resolve_seasons(verbose=True):
    """Deterministic base-preferred resolution over the extracted pool.

    Backfill archives every byte-different re-ship but never touches pool
    main files, which may still hold a seasonal winner from the original
    first-write-wins race (LawnChair shipped snowy because ChristmasGame
    raced in first). For each pool main whose keeping family is a seasonal
    pack, if POOL/season/base/ holds a byte-different copy from a base
    provider, promote that copy to main and file the seasonal copy under
    POOL/season/<class>/ — the art the season modes render. Idempotent:
    after a swap the main and the base archive are byte-equal, so re-runs
    no-op. Event-only art (no base provider anywhere) stays main in every
    mode: its seasonal art IS its only art."""
    if not SEASON.exists():
        return 0
    kept = _kept_fam_index()
    base_dir = SEASON / 'base'
    swaps = 0
    for f in sorted(POOL.iterdir()):
        if not f.is_file() or f.suffix not in ('.rgb', '.bsv3', '.xml'):
            continue
        fam = kept.get(f.name)
        if not fam or not is_seasonal(fam):
            continue
        basef = base_dir / f.name
        if not basef.exists():
            continue
        data = f.read_bytes()
        if basef.read_bytes() == data:
            continue                     # already resolved
        cls = classify_season(fam)
        cdir = SEASON / cls
        cdir.mkdir(parents=True, exist_ok=True)
        tgt = cdir / f.name
        if tgt.exists() and tgt.read_bytes() != data:
            tgt.unlink()                 # main copy wins its season slot
        if tgt.exists():
            f.unlink()
        else:
            shutil.move(str(f), str(tgt))
        shutil.copy2(basef, f)
        swaps += 1
        if verbose:
            print(f'resolve: {f.name} <- season/base (was {fam}, '
                  f'{cls} copy archived)', flush=True)
    if verbose and swaps:
        print(f'resolve: {swaps} pool files promoted from season/base '
              f'archives')
    return swaps


def slug_of(fname):
    """pool filename -> canonical slug it provides ('' if none)."""
    stem = os.path.basename(fname)
    for ext in ('.rgb', '.bsv3', '.xml'):
        if stem.endswith(ext):
            stem = stem[: -len(ext)]
            break
    else:
        return ''
    if stem.endswith('_transimage'):
        stem = stem[: -len('_transimage')]
    if stem.endswith('flipped'):
        stem = stem[: -len('flipped')]
    return stem


def worker(wid, nworkers, core=False):
    POOL.mkdir(parents=True, exist_ok=True)
    WORK_BASE.mkdir(parents=True, exist_ok=True)
    fams = load_families()
    mine = [f for i, f in enumerate(fams) if i % nworkers == wid]
    required = compute_required()
    stats = {'seen': 0, 'kept': 0, 'archived': 0}
    missing_fam = 0
    log = open(POOL / f'index_{wid}.tsv', 'a')
    for fam in mine:
        pack, inner, size = fams[fam]
        work = WORK_BASE / f'w{wid}'
        shutil.rmtree(work, ignore_errors=True)
        _wait_space(wid, size)
        zpath = open_inner_zip(work, pack, inner)
        if zpath is None:
            missing_fam += 1
            log.write(f'FAIL\t{fam}\n')
            continue
        import zipfile
        try:
            with zipfile.ZipFile(zpath) as z:
                _keep_files(z, fam, pack, log, required, stats)
        except (OSError, zipfile.BadZipFile):
            missing_fam += 1
            log.write(f'FAIL\t{fam}\n')
        shutil.rmtree(work, ignore_errors=True)
    log.close()
    print(f'worker {wid}/{nworkers}: families={len(mine)} kept={stats["seen"]} '
          f'new_files={stats["kept"]} archived={stats["archived"]} '
          f'missing={missing_fam}', flush=True)


def do_core():
    """The core game-100 pack: keep EVERYTHING (the landmark set is small
    and it is the A/B reference region)."""
    POOL.mkdir(parents=True, exist_ok=True)
    work = WORK_BASE / 'core'
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True, exist_ok=True)
    c = work / 'c'
    c.mkdir()
    subprocess.run(['unzip', '-o', '-q', str(CORE_ZIP), '-d', str(c)],
                   check=True, capture_output=True)
    zpath = c / '1'
    log = open(POOL / 'index_core.tsv', 'a')
    n = 0
    import zipfile
    with zipfile.ZipFile(zpath) as z:
        for info in z.infolist():
            base = os.path.basename(info.filename)
            if os.path.splitext(base)[1] not in KINDS and not base.lower().startswith('roadtilesheet'):
                continue
            dest = POOL / base
            if dest.exists():
                continue
            tmp = dest.with_suffix(dest.suffix + '.part')
            tmp.write_bytes(z.read(info))
            tmp.rename(dest)
            log.write(f'{KINDS.get(os.path.splitext(base)[1], "rgb")}\t'
                      f'{base}\tgame-100-core\t{CORE_ZIP.name}\n')
            n += 1
    log.close()
    shutil.rmtree(work, ignore_errors=True)
    print(f'core game-100: files={n}', flush=True)


# ---------------------------------------------------------------- report

def _pool_names():
    return {p.name for p in POOL.iterdir()
            if p.is_file() and not p.name.startswith('index_')}


def _fence_base_satisfied(slug, pool):
    """A via:flip fence id's base slug is not a real asset — it is
    satisfied when all four directional variants' rgb are in the pool."""
    sav = load_json('save_buildings.json')
    ids = load_json('building_ids.json')
    fl = load_json('flip_assets.json')
    kmap = {k.lower().replace('_', ''): k for k in fl}
    base_ids = [i for i, v in sav.items()
                if (ids.get(i, {}).get('slug') or v['name'].lower()) == slug]
    if not any(sav[i].get('via') == 'flip' for i in base_ids):
        return False
    key = kmap.get(slug)
    if not key:
        return False
    return all(any(f.lower().startswith(v.lower()) and f.endswith('.rgb')
                   for f in pool) for v in fl[key].values())


def do_report():
    required = compute_required()
    pool = _pool_names()
    idx = []
    season_files = {}
    for f in sorted(POOL.glob('index_*.tsv')):
        for line in open(f):
            p = line.rstrip('\n').split('\t')
            if len(p) >= 2 and p[0] in ('rgb', 'bsv3', 'xml', 'bcell'):
                idx.append((p[1], p[2] if len(p) > 2 else '?'))
            elif len(p) >= 5 and p[0] == 'season':
                season_files.setdefault(p[4], set()).add(slug_of(p[1]))
    have = {}
    for base, fam in idx:
        slug = slug_of(base)
        ext = os.path.splitext(base)[1]
        kind = ext.lstrip('.')
        if kind == 'xml':
            continue
        key = slug if not base.endswith('flipped' + ext) else slug + 'flipped'
        if kind == 'rgb' and base.endswith('_transimage.rgb'):
            key += '_transimage'
        have.setdefault(key, {})[kind if kind != 'rgb' else 'rgb'] = fam

    ok = missing = partial = 0
    missing_list = []
    for slug in sorted(required):
        if slug in have and 'rgb' in have[slug] and 'bsv3' in have[slug]:
            ok += 1
        elif slug in have and 'rgb' in have[slug]:
            partial += 1  # rgb without bsv3: still drawable (sheet frame 0)
        elif _fence_base_satisfied(slug, pool):
            ok += 1  # fence base: satisfied by its directional variants
        else:
            missing += 1
            missing_list.append(slug)
    print(f'required slugs: {len(required)}')
    print(f'  rgb+bsv3: {ok}   rgb-only: {partial}   missing: {missing}')
    if missing_list:
        print('missing:', ' '.join(missing_list[:40]),
              f'(+{max(0, len(missing_list) - 40)} more)')
    files = [p for p in POOL.iterdir() if p.is_file() and not p.name.startswith('index_')]
    tot = sum(p.stat().st_size for p in files)
    print(f'pool files: {len(files)}  size: {tot / 1e6:.1f} MB')
    if season_files:
        print('season archives (distinct required slugs):',
              {c: len(v & required) for c, v in sorted(season_files.items())
               if c != 'base'})
    kept = _kept_fam_index()
    gaps = [s for s in sorted(required)
            if kept.get(s + '.rgb') and is_seasonal(kept[s + '.rgb'])
            and not (SEASON / 'base' / (s + '.rgb')).exists()]
    if gaps:
        print(f'seasonal-only art ({len(gaps)} slugs, shown as-is every '
              f'mode):', ' '.join(gaps[:40]),
              f'(+{max(0, len(gaps) - 40)} more)')
    return ok + partial, len(required)


# ---------------------------------------------------------------- bsv3

class Bsv3Error(ValueError):
    pass


def _find_anim_section(data, name):
    """Locate the trailing named-anim section by walking backward from
    EOF (the 0x0303 frame section before it is variable-length and not
    fully decoded, so it cannot be reached by walking forward). The
    section is `u16 n_anims` followed by records of `u8 len, name (len
    bytes, NUL-terminated), u16 first_frame, u16 last_frame`. Returns
    (anims, section_start) or None. Verified on all 142 pool 0x0303
    files; the caller re-parses the section forward to exact EOF."""
    pos = len(data)
    recs = []
    while True:
        found = None
        for L in range(2, 64):
            li = pos - 5 - L  # len byte, given this record ends at `pos`
            if li < 2:
                break
            if data[li] != L:
                continue
            nm = data[li + 1:li + 1 + L]
            if nm[-1] != 0:
                continue
            if not all(32 <= ch < 127 for ch in nm[:-1]):
                continue
            f0, f1 = struct.unpack_from('<HH', data, pos - 4)
            if f0 > 0x7FFF or f1 > 0x7FFF:
                continue
            found = (li, nm[:-1].decode('latin1'), f0, f1)
            break
        if found is None:
            return None
        li, anm, f0, f1 = found
        recs.append((anm, f0, f1))
        na, = struct.unpack_from('<H', data, li - 2)
        if na == len(recs):
            recs.reverse()
            return recs, li - 2
        pos = li
        if len(recs) > 64:
            return None


def _v3_frame0(data, start, end, nbt):
    """Frame 0 of a 0x0303 frame section: it opens with a run of u16
    values encoding pool indices as (idx << 8), ending at the first u16
    that is not a valid one. Returns the de-duplicated pool index list,
    draw order preserved."""
    idxs = []
    seen = set()
    p = start
    while p + 2 <= end:
        u, = struct.unpack_from('<H', data, p)
        p += 2
        if u % 256 or u // 256 >= nbt:
            break
        i = u // 256
        if i not in seen:
            seen.add(i)
            idxs.append(i)
    return idxs


def _v3_frames(data, sec_start, sec_end, name, nf, nb, pool, cells):
    """Fully decode a 0x0303 frame section into per-frame block lists.

    Format (cracked 2026-10-31 against playdoughfactory, arcdetriomphe
    and boulangeriepatisserie, corpus-validated on 114/142 pool files):
    the section is `u16 nb0, u16 pad(0)` followed by ceil(nf/2) records
    of THREE zero-terminated u16 runs (A, B, C). frame(2k) draws run A,
    frame(2k+1) draws run C (B carries the delta/add list and is not
    drawn). A u16 with v % 256 == 0 is a 1-based pool reference
    (pool[(v >> 8) - 1]); a plain v is a pool reference whose base
    (0 or 1) is an authoring-time choice that varies per file AND per
    run, so for each record the (baseA, baseC) combination is chosen
    that maximises positional agreement between the pair — the same
    slot tends to reference the same pool entry in both frames — and
    the crop area of the cells each interpretation draws (repeated
    cells within one frame count negative: a frame never legitimately
    draws the same cell twice, which is what separates the arch's
    0-based pair {Crop0, Crop1} from the mis-shifted {Light_Crop1,
    Crop0}). Returns [(ci, x, y, a, b, c, d), ...] per frame, or None
    when the section does not validate (the caller keeps the legacy
    _v3_frame0 run + cluster/body fallback)."""
    nb0, pad = struct.unpack_from('<HH', data, sec_start)
    if pad != 0:
        return None
    if nf == 1:
        # single-frame files (footballfield, hangar, japanesecherrytree):
        # the section is just nb0/pad plus an optional terminator byte, and
        # the lone frame is the whole pool (matches the legacy run path's
        # full-pool picture; nb0 == nb on every such pool file).
        return [[pool[i] for i in range(nb0)]] if nb0 <= nb else None
    st = sec_start + 4
    parity = (sec_end - st) % 2
    n16 = (sec_end - st) // 2
    if n16 < 0:
        return None
    u = list(struct.unpack_from('<%dH' % n16, data, st))
    if parity and u and u[-1] == 0:
        u.pop()  # the final 0x00 terminator shared with the anim count's hi byte
    areas = [w * h for _n, _x, _y, w, h in cells]

    def readseg(i):
        seg = []
        while i < len(u) and u[i] != 0:
            seg.append(u[i])
            i += 1
        return seg, i + 1

    records = []
    want = (nf + 1) // 2
    i = 0
    while i < len(u) and len(records) < want:
        a, i = readseg(i)
        b, i = readseg(i)
        c, i = readseg(i)
        records.append((a, b, c))
    if not records:
        return None

    def dec(run, base, lenient=False):
        out = []
        for v in run:
            ix = (v >> 8) - 1 if v % 256 == 0 else v - base
            if not (0 <= ix < nb):
                return out if lenient else None
            out.append(ix)
        return out

    def score(A, C):
        n = min(len(A), len(C))
        ag = sum(1 for j in range(n) if A[j] == C[j])

        def val(F):
            seen = set()
            s = 0
            for ix in F:
                ci = pool[ix][0]
                s += areas[ci] if ci not in seen else -areas[ci]
                seen.add(ci)
            return s
        return (ag, val(A) + val(C))

    frames = []
    lenient_used = False
    for a, _b, c in records:
        best = None
        for lenient in (False, True):
            for ba in (1, 0):
                A = dec(a, ba, lenient)
                if not A:
                    continue
                for bc in (1, 0):
                    C = dec(c, bc, lenient) if c else None
                    cand = (score(A, C) if C is not None else score(A, A),
                            A, C)
                    if best is None or cand[0] > best[0]:
                        best = cand
            if best is not None:
                if lenient:
                    lenient_used = True
                break
        if best is None:
            return None
        _sc, A, C = best
        frames.append([pool[ix] for ix in A])
        if 2 * len(frames) - 1 < nf:
            frames.append([pool[ix] for ix in (C if C is not None else A)])
    if lenient_used:
        # A truncated (prefix-accepted) run means this file delta-encodes
        # its frames (terminal family) — silently drawing partial frames
        # is worse than the legacy fallback.
        return None
    while len(frames) < nf and frames:
        frames.append(list(frames[-1]))
    if len(frames) != nf or any(not fr for fr in frames):
        return None
    return frames


def _v3_runmax(data, sec_start, sec_end, pool, cells):
    """Best single frame recovered from a 0x0303 frame section whose A/B/C
    record parse failed (the delta-style files: kinghomersskyscraper,
    runwaypiece02up …). Whatever the record framing, the section is still a
    stream of zero-separated u16 runs of pool references, so split on the
    zeros and take the run that draws the most sheet art — counting each
    (cell, position) slot ONCE, so the same window crop legitimately drawn
    on three floors scores three times but a run that just repeats one
    block cannot win. Runs whose references leave the pool under both
    bases are encoding noise (the handle-table preamble) and are skipped.
    Verified on kinghomersskyscraper: the winning run is the complete
    tower with King Homer clinging to it, where the cluster fallback drew
    every climb/fly variant at once
    (mapdump/registration/m4-khs-*)."""
    n16 = (sec_end - sec_start) // 2
    if n16 <= 0:
        return None
    u = struct.unpack_from('<%dH' % n16, data, sec_start)
    areas = [w * h for _n, _x, _y, w, h in cells]
    best = None                     # (score, kept blocks)

    def consider(run):
        nonlocal best
        if len(run) < 3:
            return
        for base in (1, 0):
            seen = set()
            score = 0
            kept = []
            for v in run:
                ix = (v >> 8) - 1 if v % 256 == 0 else v - base
                if not (0 <= ix < len(pool)) or pool[ix][0] >= len(cells):
                    return                  # not a reference run at all
                key = (pool[ix][0], round(pool[ix][1]), round(pool[ix][2]))
                if key not in seen:
                    seen.add(key)
                    score += areas[pool[ix][0]]
                    kept.append(pool[ix])
            if len(seen) < 3:
                return
            if best is None or score > best[0]:
                best = (score, kept)

    run = []
    for v in u:
        if v == 0:
            consider(run)
            run = []
        else:
            run.append(v)
    consider(run)
    return best[1] if best else None


def _v3_clusters(pool, cells, thr=64.0):
    """Position clusters over the LOCAL pool blocks (ci < n_cells), keyed
    per cell index: blocks of the same cell within thr px of each other
    (greedy + one merge pass) are the animation variants of one slot."""
    clusters = []
    for i, (ci, x, y, _a, _b, _c, _d) in enumerate(pool):
        if ci >= len(cells):
            continue
        hit = None
        for c in clusters:
            if (c['ci'] == ci
                    and c['minx'] - thr <= x <= c['maxx'] + thr
                    and c['miny'] - thr <= y <= c['maxy'] + thr):
                hit = c
                break
        if hit is None:
            clusters.append({'ci': ci, 'blocks': [i], 'minx': x, 'maxx': x,
                             'miny': y, 'maxy': y})
            continue
        hit['blocks'].append(i)
        hit['minx'] = min(hit['minx'], x)
        hit['maxx'] = max(hit['maxx'], x)
        hit['miny'] = min(hit['miny'], y)
        hit['maxy'] = max(hit['maxy'], y)
    changed = True
    while changed:  # merge clusters whose bboxes came within thr
        changed = False
        for i in range(len(clusters)):
            for j in range(i + 1, len(clusters)):
                A, B = clusters[i], clusters[j]
                if (A['ci'] == B['ci']
                        and A['minx'] - B['maxx'] <= thr
                        and B['minx'] - A['maxx'] <= thr
                        and A['miny'] - B['maxy'] <= thr
                        and B['miny'] - A['maxy'] <= thr):
                    A['blocks'] += B['blocks']
                    A['minx'] = min(A['minx'], B['minx'])
                    A['maxx'] = max(A['maxx'], B['maxx'])
                    A['miny'] = min(A['miny'], B['miny'])
                    A['maxy'] = max(A['maxy'], B['maxy'])
                    del clusters[j]
                    changed = True
                    break
            if changed:
                break
    return clusters


def _cluster_reps(pool, cells, thr=64.0):
    """One representative (first) pool block per position cluster, sorted
    largest-crop first so bodies draw under their details. Fallback for
    0x0303 files whose frame-0 run resolves to no local blocks."""
    reps = [c['blocks'][0] for c in _v3_clusters(pool, cells, thr)]

    def area(i):
        _n, _x, _y, w, h = cells[pool[i][0]]
        return w * h
    return sorted(reps, key=area, reverse=True)


def parse_bsv3(data, name):
    """Parse a Tapped Out bsv3 building-sprite file, validating to exact
    EOF. Returns a dict:

      v        1 (magic 0x0103) or 3 (magic 0x0303)
      alpha    header alpha flag (0/1)
      cells    [(name, x, y, w, h)] — sheet crop rects, in index order
      nf       frame count
      anims    [(name, first, last)] — named state ranges
      v1: frames  [ [(ci, x, y, a, b, c, d), ...], ... ]
      v3: pool    [ (ci, x, y, a, b, c, d), ... ]  (shared block pool)
          frames  [ [(ci, x, y, a, b, c, d), ...], ... ] when the frame
                    section decoded fully (see _v3_frames); else None, and
          frame0  [int, ...]  pool indices of frame 0, decoded from the
                    leading (idx<<8) run of the frame section,
                    de-duplicated, draw order preserved
      warnings [str]

    Variant notes (empirically pinned on the 3.0.30 pool, 2026-10-16):

    0x0103: frames inline — `u16 nb, u8 pad(0), nb x block` where
        block = u16 ci, f32 x, f32 y, f32 a, f32 b, f32 c, f32 d
                (+ u8 alpha when the header alpha flag is set, so the
                stride is 26 or 27).
        Block x,y are FLOAT PIXEL offsets of the cell crop from the
        building anchor (0,0); a<0 marks a horizontal flip. (a b; c d)
        is the block's 2x2 matrix: scale/rotation/shear, applied by
        render_static (body cells are identity; effects, glows and
        drop shadows carry the transforms).

    0x0303 (142 pool files — landmarks with moving parts, e.g. satellite
        dish buildings): 4 extra header bytes (f32 1.0) after the magic,
        then the same cells, then
        u16 n_frames, u16 n_blocks, then the POOL:
        n_blocks x (u16 ci, f32 x, f32 y, f32 a, f32 b, f32 c, f32 d,
                    + u8 alpha when the alpha flag is set)
        — ci LEADING, stride 26/27 (2026-10-31: the old read put the
        u16 ci after the six floats and called the pool's first u16 a
        "reserved" field; that pairing spread every block across the
        wrong cell — playdoughfactory shipped shattered). ci is always
        a LOCAL cell index < n_cells on this corpus (alpha=1 included).
        x,y are float PIXEL offsets of the cell crop from the building
        anchor. The pool is followed by the FRAME section:
        u16 nb0 (frame-0 block count), u16 pad(0), then ceil(nf/2)
        records of three zero-terminated u16 runs (A, B, C);
        frame(2k) draws A, frame(2k+1) draws C — see _v3_frames for the
        reference/base-0-or-1 decoding and the per-record vote. 114 of
        the 142 pool files decode fully; the 28 that don't (delta-style
        encodings: terminal, bastille, planebot …) keep the legacy
        leading-(idx<<8) run + cluster/body fallback. The section's end
        = the start of the anim section, located by walking backward
        from EOF; the anim list is then forward-parsed to exact EOF.
    """
    if len(data) < 8:
        raise Bsv3Error(f'{name}: too small ({len(data)} bytes)')
    magic = struct.unpack_from('<H', data, 0)[0]
    if magic == 0x0103:
        v, p = 1, 2
    elif magic == 0x0303:
        v, p = 3, 6  # skip the extra f32 (1.0)
        if struct.unpack_from('<f', data, 2)[0] != 1.0:
            warnings_extra = [f'{name}: 0x0303 header f32 is not 1.0']
        else:
            warnings_extra = []
    else:
        raise Bsv3Error(f'{name}: unknown magic {magic:#06x}')
    warnings = warnings_extra if v == 3 else []

    nc = struct.unpack_from('<H', data, p)[0]
    alpha = data[p + 2]
    p += 3
    cells = []
    for _ in range(nc):
        ln = data[p]
        p += 1
        nm = data[p:p + ln].split(b'\0')[0].decode('latin1')
        p += ln
        x, y, w, h = struct.unpack_from('<hhhh', data, p)
        p += 8
        cells.append((nm, x, y, w, h))
    if p + 2 > len(data):
        raise Bsv3Error(f'{name}: truncated before frame count')
    nf = struct.unpack_from('<H', data, p)[0]
    p += 2

    frames = pool = frame0 = runmax = sec = None
    if v == 1:
        bs = 26 + alpha
        fmt = '<HffffffB' if alpha else '<Hffffff'
        frames = []
        for _f in range(nf):
            if p + 3 > len(data):
                raise Bsv3Error(f'{name}: truncated in frame {len(frames)}')
            nb = struct.unpack_from('<H', data, p)[0]
            pad = data[p + 2]
            p += 3
            if pad:
                warnings.append(f'{name}: frame {len(frames)} pad byte = {pad}')
            if p + bs * nb > len(data):
                raise Bsv3Error(f'{name}: truncated in frame {len(frames)}')
            blocks = []
            for _b in range(nb):
                t = struct.unpack_from(fmt, data, p)
                blocks.append(t[:7])
                p += bs
            frames.append(blocks)
    else:
        nb_total = struct.unpack_from('<H', data, p)[0]
        p += 2
        bs = 26 + alpha
        pool = []
        for _k in range(nb_total):
            if p + bs > len(data):
                raise Bsv3Error(f'{name}: truncated in pool block {_k}')
            ci = struct.unpack_from('<H', data, p)[0]
            x, y, a, b, c, dd = struct.unpack_from('<6f', data, p + 2)
            p += bs
            if not all(math.isfinite(f) for f in (x, y, a, b, c, dd)):
                raise Bsv3Error(f'{name}: non-finite float in pool block {_k}')
            pool.append((ci, x, y, a, b, c, dd))
        if pool and max(e[0] for e in pool) >= len(cells):
            warnings.append(f'{name}: pool ci >= n_cells; frame decode '
                            f'disabled, legacy fallback')
            pool_ok = False
        else:
            pool_ok = True
        pool_end = p
        found = _find_anim_section(data, name)
        if found is None:
            raise Bsv3Error(f'{name}: 0x0303 anim section not found')
        _anims, anim_start = found
        if anim_start < pool_end:
            raise Bsv3Error(f'{name}: anim section overlaps block pool')
        if pool_ok:
            frames = _v3_frames(data, pool_end, anim_start, name, nf,
                                nb_total, pool, cells)
        if frames is None:
            frame0 = _v3_frame0(data, pool_end + 4, anim_start, nb_total)
            if pool_ok:
                # best fallback picture for the undecoded section (used by
                # static_blocks when the leading run is too thin)
                runmax = _v3_runmax(data, pool_end + 4, anim_start,
                                    pool, cells)
        sec = (pool_end, anim_start)
        p = anim_start  # frame section consumed (or legacy run taken); anims below

    if p + 2 > len(data):
        raise Bsv3Error(f'{name}: truncated before anim list')
    na = struct.unpack_from('<H', data, p)[0]
    p += 2
    anims = []
    for _ in range(na):
        if p >= len(data):
            raise Bsv3Error(f'{name}: truncated in anim list')
        ln = data[p]
        p += 1
        nm = data[p:p + ln].split(b'\0')[0].decode('latin1')
        p += ln
        f0, f1 = struct.unpack_from('<HH', data, p)
        p += 4
        anims.append((nm, f0, f1))
    if p != len(data):
        raise Bsv3Error(f'{name}: {len(data) - p} trailing bytes after anims')
    return dict(v=v, alpha=alpha, cells=cells, nf=nf, frames=frames,
                pool=pool, frame0=frame0, runmax=runmax, anims=anims,
                warnings=warnings, sec=sec)


def _frame_local_area(frame, cells):
    """Total crop area (px^2) of a frame's blocks that map to local
    cells — a proxy for how complete the building is in that frame."""
    tot = 0
    for ci, _x, _y, _a, _b, _c, _d in frame:
        if ci < len(cells):
            tot += cells[ci][3] * cells[ci][4]
    return tot


def _best_frame_index(parsed):
    """The frame index that best represents the building statically: the
    first frame with the maximum total local-cell area. Frame 0 is often
    a partial pose, an effect, or an empty construction start; the
    fullest frame is the one where the body is actually present.
    Returns (index, area); (-1, 0) when no frame has any local block."""
    cells = parsed['cells']
    best_i, best_a = -1, 0
    for i, fr in enumerate(parsed['frames']):
        a = _frame_local_area(fr, cells)
        if a > best_a:
            best_i, best_a = i, a
    return best_i, best_a


def _neutral_frame_index(parsed):
    """Canonical idle pose: the first frame of an anim whose name
    contains 'neutral' (case-insensitive), when it has local blocks.
    Backed by tsto2rgb: its bsv writer likewise promotes the atlas
    containing 'neutral/0' to the main file (bsv.py, neutral_atlas_index).
    Returns None when no neutral anim resolves to a drawable frame."""
    for nm, f0, _f1 in parsed.get('anims') or []:
        if 'neutral' in nm.lower() and f0 < len(parsed['frames']):
            fr = parsed['frames'][f0]
            if _frame_local_area(fr, parsed['cells']) > 0:
                return f0
    return None


def static_blocks(parsed, name):
    """The blocks for the static frame, in draw order, as
    (ci, x, y, a, b, c, d) tuples. Sets parsed['static_src']:
      0x0103  'neutral' — the Neutral anim's first frame (the engine's
                      own promoted default; see _neutral_frame_index),
                      when one exists and draws.
              'best'    — otherwise the fullest frame (max total
                      local-cell area; frame 0 is often an
                      effect/partial pose/empty).
      0x0303  'neutral'— the Neutral anim's first frame, when the frame
                      section decoded and that frame carries the building
                      (>= 40% of the fullest frame's local-cell area);
              'best'   — otherwise the fullest decoded frame;
              'run'    — no decoded frames: frame 0 as the leading
                      (idx<<8) run, filtered to local cells;
              'runmax' — leading run too thin and the section undecoded:
                      the fullest zero-separated reference run of the
                      frame section (see _v3_runmax);
              'cluster'— one pool block per (cell, position) cluster,
                      when the run resolved to nothing;
      both    'body'   — the largest sheet cell alone, bottom-centre on
                         the anchor, when nothing resolves to local
                         blocks (alpha=1 global-handle pools, or frames
                         referencing no local cell).
    The decoded frame-0 run can spill past frame 0 into later frames
    (whose records are also (idx<<8) in some files); a real frame shows
    at most one pool block per position slot, so the run is capped to
    the first value of each cluster."""
    if parsed['v'] == 1:
        # the engine's own default pose: tsto2rgb promotes the atlas
        # holding 'neutral/0' to the main file (bsv.py,
        # neutral_atlas_index), so the Neutral anim's first frame is
        # what the game shows untoggled. Only fall back to the
        # max-area frame when no neutral anim resolves — 'best' on its
        # own picks motion frames whenever they're fatter than idle
        # (redstarhelicopter shipped its Active_In rotor-blur sweep
        # because the spinning-disc area beats the parked pose).
        ni = _neutral_frame_index(parsed)
        if ni is not None:
            parsed['static_src'] = 'neutral'
            return list(parsed['frames'][ni])
        fi, area = _best_frame_index(parsed)
        if fi >= 0 and area > 0:
            parsed['static_src'] = 'best'
            return list(parsed['frames'][fi])
        return _body_fallback(parsed, name)
    parsed['v3_fallback'] = False
    pool = parsed['pool']
    nc = len(parsed['cells'])
    if parsed.get('frames'):
        # Fully decoded (see _v3_frames): use the same engine-default-pose
        # rule as 0x0103 — the Neutral anim's first frame is what the game
        # shows untoggled (playdoughfactory's frame 0 is the Active_Out
        # pose with the lever/mask rig mid-cycle; its Neutral frame 132 is
        # the complete parked factory). Unlike 0x0103, a v3 'Neutral' can
        # also be a piece-frame (ktvbuilding's holds only the glass
        # facade, filthyangelsorphanage's two wall shards), so the pick
        # must still carry the building: require the neutral frame to have
        # >= 40% of the fullest frame's local-cell area.
        fi, area = _best_frame_index(parsed)
        ni = _neutral_frame_index(parsed)
        if ni is not None and (area == 0 or _frame_local_area(
                parsed['frames'][ni], parsed['cells']) >= 0.4 * area):
            parsed['static_src'] = 'neutral'
            return list(parsed['frames'][ni])
        if fi >= 0 and area > 0:
            parsed['static_src'] = 'best'
            return list(parsed['frames'][fi])
    idxs = [i for i in (parsed.get('frame0') or [])
            if i < len(pool) and pool[i][0] < nc]
    if idxs:
        # cap to one block per position slot (first value wins)
        owner = {}
        for c_i, c in enumerate(_v3_clusters(pool, parsed['cells'])):
            for b in c['blocks']:
                owner.setdefault(b, c_i)
        claimed = set()
        kept = []
        for i in idxs:
            c_i = owner.get(i)
            if c_i is not None and c_i not in claimed:
                claimed.add(c_i)
                kept.append(i)
        # a 1-2 block "frame 0" against a multi-slot pool is an encoding
        # mismatch (some files open the section with a different, not yet
        # decoded format) — prefer the full-building cluster picture
        if len(kept) >= 3:
            parsed['static_src'] = 'run'
            return [pool[i] for i in kept]
    if any(b[0] < nc for b in pool):
        # No usable leading run: the section is one of the undecoded
        # delta-style encodings. Recover the fullest zero-separated
        # reference run FIRST — it is a real engine frame (one block per
        # cell), while the cluster picture below draws every animation
        # variant of the pool at once (kinghomersskyscraper shipped as a
        # pile of duplicated floors, a dozen biplanes and three King
        # Homers before this existed).
        if parsed.get('runmax'):
            kept = parsed['runmax']
            parsed['warnings'].append(
                f'{name}: frame section undecoded; using the fullest '
                f'reference run ({len(kept)} blocks)')
            parsed['static_src'] = 'runmax'
            return kept
        parsed['warnings'].append(
            f'{name}: frame-0 run too thin ({len(idxs)} local blocks); '
            f'using one block per position cluster')
        idxs = _cluster_reps(pool, parsed['cells'])
        if idxs:
            parsed['static_src'] = 'cluster'
            return [pool[i] for i in idxs]
    return _body_fallback(parsed, name)


def _body_fallback(parsed, name):
    """Last-resort static blocks: the largest sheet cell alone, its
    bottom-centre on the building anchor. Used when no frame resolves to
    local blocks (0x0103 frames referencing no local cell, or 0x0303
    global-handle pools)."""
    cells = parsed['cells']
    parsed['warnings'].append(
        f'{name}: no local blocks resolvable; drawing largest sheet cell only')
    parsed['v3_fallback'] = True
    parsed['static_src'] = 'body'
    bi = max(range(len(cells)), key=lambda i: cells[i][3] * cells[i][4])
    _nm, _cx, _cy, cw, ch = cells[bi]
    return [(bi, -cw / 2.0, -float(ch), 1.0, 0.0, 0.0, 1.0)]


# Per-block measured corrections. Key: (asset, cell name,
# round(anchor_x, 1), round(anchor_y, 1)) -> (dx, dy) in engine units,
# added to the block anchor.
# EMPTY since 2026-10-24: the giantrobot east C_Upperarm_1 entry (0,
# +114.5) was the transformed-bbox top-left offset (ry0 = b*w) read out
# by hand before _composite adopted the bbox-TL placement rule directly;
# it would now double-apply. Kept as infrastructure for any future
# reference-fit outlier.
BLOCK_NUDGE = {}


def _composite(parsed, img, name, blocks):
    """Composite one block list (ci, x, y, a, b, c, d) onto a fresh canvas.
    Shared by render_static (the static frame) and the animation frame
    renderer. Returns (canvas, anchor_x, anchor_y, drawn, skipped, rotmax)
    or None when nothing drawable. Anchor = canvas px of the building
    anchor (0,0).

    Placement (revised 2026-10-24, see the long rule note in the body):
    the block's transformed content AABB starts at (x, y), with content
    spanning (x,y)+(M(u,v)-(rx0,ry0)) where X = a*u + c*v, Y = b*u + d*v
    ((b,c) are stored transposed); rotated blocks (b or c nonzero) blit
    with the SIGNED matrix — a negative diagonal is a reflection, not an
    in-place crop mirror; b=c=0 blocks take the diagonal signs of (a, dd)
    as in-place crop mirrors. Identity blocks paste without resampling;
    pure diagonal scales resize NEAREST; rotations/shears go through the
    affine path, BILINEAR.
    Evidence: b=c=0 blocks obey the mirror-pair relation x' ~ -(x + w)
    (fresh raw audit 5907:10 over the pool's flipped pairs — identical
    under both placement rules); rotated blocks pin their transformed-bbox
    top-left at (x, y) with transposed (b, c) (redstarhelicopter rotor
    hub-attachment, parked-vs-rotated same-cell anchor consistency, and
    the C_Blade03_01 two-angle pivot inconsistency).
    rotmax records the largest |b| or |c| seen for triage."""
    cells = parsed['cells']
    plan = []
    skipped = 0
    rotmax = 0.0
    for ci, x, y, a, b, c, dd in blocks:
        nudge = BLOCK_NUDGE.get((name, cells[ci][0], round(x, 1), round(y, 1)))
        if nudge:
            x, y = x + nudge[0], y + nudge[1]
        if ci >= len(cells):
            skipped += 1  # global sprite id not in this file
            continue
        _nm, cx, cy, cw, ch = cells[ci]
        if _nm.endswith('Input'):
            # Engine-internal source art — never a placed piece (2026-10-29,
            # boatloadofdonuts / "DonutBoat"). Pool audit (all 3618 bsv3):
            # exactly ONE asset carries an *Input cell at all, and it is the
            # only cell of its kind — C_WaveInput, drawn by that one asset in
            # 12 frame slots, always identity-placed.
            # It is the DonutBoat's bow-splash slot going off-pattern once per
            # wave cycle. That slot runs the (N, N+8) wave family with one
            # fixed rotation across the whole loop:
            #   beat 0  C_Wave_00  (414.15,-383.72) m=(0.626,0.778,-0.653,0.755)
            #   beat 1  C_WaveInput(406.25,-324.20) m=IDENTITY      <-- anomaly
            #   beat 2  C_Wave_02  (399.69,-391.00) m=(0.626,0.778,-0.653,0.755)
            #   beat 3  C_Wave_03  (395.77,-400.36) m=(0.626,0.778,-0.653,0.755)
            # x tracks the series (406 vs the ~407 the drift interpolates),
            # but y sits ~65 px low and the rotation is missing. The crop
            # settles it: C_Wave_00..03 (the bow family) all run bottom-left
            # to top-right, while C_WaveInput has the OPPOSITE diagonal, the
            # one the hull-side family C_Wave_08..11 shares — i.e. a stray
            # hull-side wave left in the bow slot, unrotated. On screen it
            # reads as a flat water sprite sliding horizontally across the
            # stern for 3 of every 20 idle frames.
            # Dropping it is also what the game's own flattened reference
            # shows: boatloadofdonuts_transimage.rgb (the Neutral pose) has
            # the rotated bow splash and no horizontal patch, and the body
            # PNG drawn under the strip keeps supplying that splash while the
            # strip skips its off-pattern beat — so the loop stays whole.
            skipped += 1
            if not parsed.get('_input_warned'):
                parsed['_input_warned'] = True
                parsed['warnings'].append(
                    f'{name}: skipped {len([1 for c in cells if c[0].endswith("Input")])} '
                    f'engine-internal *Input cell(s)')
            continue
        if not (0 <= cx and 0 <= cy and cx + cw <= img.width
                and cy + ch <= img.height):
            skipped += 1
            parsed['warnings'].append(
                f'{name}: cell {ci} crop out of sheet at ({cx},{cy},{cw},{ch})')
            continue
        det = a * dd - b * c
        if abs(det) < 1e-6:
            skipped += 1
            parsed['warnings'].append(
                f'{name}: block {ci} degenerate matrix {a},{b},{c},{dd}')
            continue
        rotmax = max(rotmax, abs(b), abs(c))
        # (See docstring + the placement note below for the full evidence
        # chain: mirror-pair audit pins the b=c=0 case; the rotation fan
        # and limb chaining pin the rotated case.)
        # (b, c) are stored transposed relative to [X;Y]=[a b;c d][u;v]:
        # X = a*u + c*v, Y = b*u + d*v. Evidence 2026-10-19: the GiantRobot
        # 54-deg upperarm only chains toward its forearm/hand this way
        # (elbow gaps 300->83, 110->48 px), with the per-asset joint vote
        # 21:17.
        if abs(b) > 1e-3 or abs(c) > 1e-3:
            # Rotated block: blit with the stored matrix INCLUDING SIGNS
            # (2026-10-28, redstarbarge). The engine draws src(u,v) at
            # M(u,v); a mirrored authoring pass (the *flipped twins)
            # records a REFLECTION (det<0: M' = F·M) plus the exact
            # mirror placement x' = -(x+w'), y' = y. The old abs()+
            # pre-mirror rule forced det>0, so the flipped twin's rotated
            # crops landed at mirror-inconsistent angles — the barge's
            # C_Wave_12 wake streaks cut across the bow "almost
            # sideways". Signed draws the flipped twin as the pixel
            # mirror of its (verified-correct) unflipped twin: per-block
            # mirror diff 4997/7489 asymmetric px -> 973/969 AA noise.
            # b=c=0 blocks keep the flip+abs path below; for them the
            # two rules are identical, so the mirror-pair audit 5907:10
            # still holds.
            flip_h, flip_v = False, False
            ma, mb, mc, md = a, c, b, dd
        else:
            flip_h, flip_v = a < 0, dd < 0
            ma, mb, mc, md = abs(a), c, b, abs(dd)
        rel = [(ma * u + mb * v, mc * u + md * v)
               for u, v in ((0, 0), (cw, 0), (cw, ch), (0, ch))]
        rx0 = min(p[0] for p in rel)
        ry0 = min(p[1] for p in rel)
        rx1 = max(p[0] for p in rel)
        ry1 = max(p[1] for p in rel)
        # Transformed-bbox top-left placement: content spans (x,y) ..
        # (x,y)+(rx1-rx0, ry1-ry0), i.e. the rotated cell's AABB starts at
        # (x, y) — pinned 2026-10-24 by three independent checks on
        # redstarhelicopter rotor data: (1) every rotated blade piece's
        # content rect intersects its hub (centre of C_Top) to within
        # 0-4 px across all angle groups and both rotors, vs up to 161 px
        # misses under crop-origin; (2) the SAME cell used identity-parked
        # (frames 0/193) and rotated (189/193) predicts the stored rotated
        # anchor to within 2-4 px as hub-rotation + (rx0, ry0), while
        # crop-origin misses y by 9-45 px; (3) a per-cell pivot model dies
        # on C_Blade03_01, whose two rotation groups imply pivots 80 px
        # apart. The earlier crop-origin vote (innstable C_Ray fan roots
        # coinciding at (x,y)) is not a counterexample: with bbox-TL the
        # beam roots simply sit at M^-1*(rx0, ry0) inside each crop, which
        # reproduces the same convergence. The 2026-10-19 BLOCK_NUDGE on
        # giantrobot's east upperarm is the same effect read out by hand
        # (its ry0 = b*w = -114.5). For b=c=0 flip/scale blocks
        # (mirror-pair audit 5907:10) rx0=ry0=0 and this is IDENTICAL to
        # crop-origin placement, so that audit still holds.
        qx0, qy0 = x, y
        qx1 = qx0 + rx1 - rx0
        qy1 = qy0 + ry1 - ry0
        if (qx1 - qx0) * (qy1 - qy0) > 4_000_000:
            skipped += 1
            parsed['warnings'].append(
                f'{name}: block {ci} transformed rect too large '
                f'({qx1 - qx0:.0f}x{qy1 - qy0:.0f})')
            continue
        plan.append((qx0, qy0, qx1, qy1, ma, mb, mc, md, flip_h, flip_v,
                     cx, cy, cw, ch, rx0, ry0))
    if plan:
        # Garbage-placement guard (2026-10-25): the winter re-ship of
        # museumofsuperfinearts places C_Shadow at (-2.15e6,-2.15e6). The
        # block is small so the 4 Mpx rect guard misses it, but the canvas
        # bbox stretches to 2.1M px — Image.new asked for 18 TB of RGBA and
        # the OOM killer took two sprites runs down (dmesg total-vm
        # 18030802388kB). Cull rects whose centre sits > 20k px from the
        # median centre: the widest legitimate sprite spans ~3.3k px
        # (thetoothchipper 2498x1929, privateisland05 1938x2414), and the
        # median rect's own centre is distance 0 from itself, so a cull
        # pass can never empty the plan.
        cen = [((t[0] + t[2]) / 2.0, (t[1] + t[3]) / 2.0) for t in plan]
        mx = sorted(c[0] for c in cen)[len(cen) // 2]
        my = sorted(c[1] for c in cen)[len(cen) // 2]
        kept = [t for t, (ccx, ccy) in zip(plan, cen)
                if abs(ccx - mx) <= 20000 and abs(ccy - my) <= 20000]
        if len(kept) < len(plan):
            parsed['warnings'].append(
                f'{name}: culled {len(plan) - len(kept)} block(s) >20k px '
                f'from the block cluster (garbage placement)')
            plan = kept
    if not plan:
        return None
    # Snap every block to integer device pixels in ABSOLUTE space BEFORE
    # subtracting the canvas origin (2026-10-30, privateisland05). Rounding
    # (qx0 - X0) per frame made a static block's cell-space position a
    # function of the FRAME, not of the block: when a moving water block
    # changed the bbox fraction, every static block's paste shifted +-1 px
    # and the cluster scan turned that into +-2 px oy wobble + 78<->84 px
    # bbox breathing — the island's rocks bobbed independently while the
    # engine holds them at one fixed float position. Snapping once against
    # the block's own coordinates makes placement depend on that block's
    # data alone, so identical blocks place identically on every frame.
    snapped = []
    for (qx0, qy0, qx1, qy1, ma, mb, mc, md, flip_h, flip_v,
         cx, cy, cw, ch, rx0, ry0) in plan:
        bx0, by0 = int(round(qx0)), int(round(qy0))
        ow = max(1, int(round(qx1 - qx0)))
        oh = max(1, int(round(qy1 - qy0)))
        snapped.append((bx0, by0, ow, oh, ma, mb, mc, md, flip_h, flip_v,
                        cx, cy, cw, ch, rx0, ry0))
    OX = min(t[0] for t in snapped)
    OY = min(t[1] for t in snapped)
    W = max(1, max(t[0] + t[2] for t in snapped) - OX)
    H = max(1, max(t[1] + t[3] for t in snapped) - OY)
    if W * H > 16_000_000:
        # 3.3x the largest legitimate sprite (4.8 Mpx); catches whatever
        # coordinate garbage survives the cull above before the allocation
        parsed['warnings'].append(
            f'{name}: canvas {W}x{H} over the 16 Mpx sanity cap, skipped')
        return None
    canvas = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    # Draw order = REVERSE file record order (pinned 2026-10-19 against
    # the official Giant_Robot_Menu render: luma-NCC 0.903 reversed vs
    # 0.807 forward, 0.832 shadow-first — see notes/06). Ground shadows
    # are the last records in every file we have, so reversed they land
    # behind everything, which is also what every building needs.
    for (bx0, by0, ow, oh, ma, mb, mc, md, flip_h, flip_v,
         cx, cy, cw, ch, rx0, ry0) in reversed(snapped):
        cr = img.crop((cx, cy, cx + cw, cy + ch))
        if flip_h:
            cr = cr.transpose(Image.FLIP_LEFT_RIGHT)
        if flip_v:
            cr = cr.transpose(Image.FLIP_TOP_BOTTOM)
        if abs(mb) < 1e-3 and abs(mc) < 1e-3:
            if not (abs(ma - 1.0) < 1e-3 and abs(md - 1.0) < 1e-3):
                cr = cr.resize((ow, oh), Image.NEAREST)
        else:
            detm = ma * md - mb * mc
            if abs(detm) < 1e-9:
                continue
            # PIL transform samples the crop at (a*x+b*y+c, d*x+e*y+f) for
            # WINDOW-LOCAL x,y; window pixel (x,y) displays the transformed
            # point rel = (rx0 + x, ry0 + y), so the inverse map is
            # (u, v) = M^-1 * (x + rx0, y + ry0) — constants M^-1*(rx0,ry0).
            coeffs = (md / detm, -mb / detm, (md * rx0 - mb * ry0) / detm,
                      -mc / detm, ma / detm, (-mc * rx0 + ma * ry0) / detm)
            cr = cr.transform((ow, oh), Image.AFFINE, coeffs,
                              resample=Image.BILINEAR)
        canvas.alpha_composite(cr, (bx0 - OX, by0 - OY))
    return canvas, -OX, -OY, len(plan), skipped, rotmax


def render_static(parsed, img, name):
    """Composite the static frame (see static_blocks) onto a canvas."""
    return _composite(parsed, img, name, static_blocks(parsed, name))


def load_sheet(path, name):
    data = path.read_bytes()
    w, h, _bpp, rgba, _premul = rgb_to_rgba(data, name)
    return Image.frombytes('RGBA', (w, h), rgba)


# ---------------------------------------------------------------- animation frames

# No frame timing is encoded in bsv3 (notes/01: the 26 B block stride has
# no room for delays), so loops play at a chosen constant. 12 fps sits in
# the range TSTO's particle/prop loops read as "live" at city zoom.
ANIM_FPS = 12
ANIM_MAX_FRAMES = 48      # per animation, sampled evenly from the range
ANIM_MAX_ANIMS = 4        # longest loops kept per asset
ANIM_SPARSE_PX = 12_000_000   # layer atlases above this try cluster-rect
LOOP_SLOT_TOL = 32.0          # engine units: a loop cell this close to a
                              # static block's (x, y), and clearly nearer than
                              # any other slot, is that slot's part variant —
                              # it inherits the slot's paint depth
                              # (_loop_occluder). Measured 2026-10-29 on
                              # boatloadofdonuts, whose wave parts drift 0-25
                              # units around their slots while the nearest
                              # OTHER slot is 24-180 units away.
                              # packing (the player gates at 16 Mpx)


def _frame_sig(blocks):
    """Hashable identity of a frame: its block list, floats rounded."""
    return tuple((b[0], round(b[1], 3), round(b[2], 3),
                  round(b[3], 4), round(b[4], 4), round(b[5], 4),
                  round(b[6], 4)) for b in blocks)


def _sample_range(a, b, cap):
    """Indices a..b (inclusive), thinned evenly to <= cap, endpoints kept."""
    n = b - a + 1
    if n <= cap:
        return list(range(a, b + 1))
    step = (n - 1) / (cap - 1)
    return sorted({a, b, *(a + round(i * step) for i in range(cap))})


def _placed_slugs():
    """Slugs the decoded save can actually instantiate (placed buildings +
    their flip_assets.json directional variants), from data/ catalogs."""
    sav = load_json('save_buildings.json')
    ids = load_json('building_ids.json')
    fl = load_json('flip_assets.json')
    out = set()
    for bid in sav:
        s = ((ids.get(bid) or {}).get('slug') or '').lower()
        if s:
            out.add(s)
    for variants in fl.values():
        for s in variants.values():
            out.add(s.lower())
    return out


# ------------------------------------------------- engine idle/tap behaviour table
#
# The real game does NOT loop every named anim a bsv3 carries:
#   * what loops on its own is the building's controller animation —
#     <ActiveAnimationController name="X"/> (per-building or its file's
#     BuildingDefaults, default 'Neutral'), with <BSv2 neutralAnim="X"/> in
#     the *_assetdata.xml files as the asset-level override;
#   * everything else plays on demand: <OnEvent event="BuildingTouched">
#     binds a <Script name package> in the same pack's *_scripts*.xml, and
#     that script's first self-targeting <Action type="anim-play"> names the
#     tap animation. The verb's 'NoLoop' suffix is engine playback
#     semantics, never part of a bsv3 anim name (verified: zero anims named
#     *NoLoop in the whole 0x0103 pool), so 'ActiveNoLoop' plays 'Active'
#     once and reverts to the controller anim.
# Scanning the extracted gamescripts packs once for both halves gives the
# city map its animation gate: loop only the controller anim, keep the tap
# strip for click-to-play. Cache: data/building_behaviors.json.
#
# A third signal covers the buildings the engine COMPOSITES: a lot whose art
# is one bsv3 drawn as several stacked parts. Two places declare the parts —
#   * <AnimationLayerOrder><Animation name="X"/></AnimationLayerOrder> in the
#     *_assetdata.xml files (the draw-order list; EscalatorToNowhere is
#     StairsUL, Stairs, Characters, StairsOV), and
#   * sibling buildings that render from the same asset (building_ids.json
#     maps OldEnglishStationBase and OldEnglishStationTop to slug
#     'oldenglishstation'), each with its own controller anim — NeutralBase
#     and NeutralTop, which are loops of the base part and the roof part.
# So for those assets no single anim is "the" idle: the parts loop TOGETHER,
# each over the building's static body. The behavior map carries them as
# slug -> layers: [anim, ...] (in draw order) and the map player composites
# them; see _layer_wants().

DLC = ROOT / 'web' / 'assets' / 'dlc'
BEHAVIORS = DATA / 'building_behaviors.json'

# anim-play target attributes (the data uses all three spellings)
_ANIMPLAY_TARGET_ATTRS = ('Building', 'building', 'onBuilding')
# anim-play actions aimed at these are not building-targeted at all
_ANIMPLAY_SKIP_ATTRS = ('character', 'object0', 'object1', 'flyBy')


def _gamescript_packs():
    """gamescripts-r*/data dirs, newest revision first."""
    packs = []
    for d in DLC.glob('gamescripts-r*/data'):
        try:
            rev = int(d.parent.name.rsplit('r', 1)[1])
        except ValueError:
            continue
        packs.append((rev, d))
    return [d for _rev, d in sorted(packs, reverse=True)]


def _script_anim_steps(elem):
    """[(verb, target|None)] for self-candidate anim-play actions of a
    script element, document order (the engine plays them in sequence;
    character/object-targeted actions are not ours to animate)."""
    steps = []
    for act in elem.iter('Action'):
        if (act.get('type') or '').lower() != 'anim-play':
            continue
        if any(act.get(k) for k in _ANIMPLAY_SKIP_ATTRS):
            continue
        verb = act.get('animation')
        if not verb:
            continue
        tgt = next((act.get(k) for k in _ANIMPLAY_TARGET_ATTRS
                    if act.get(k)), None)
        steps.append((verb, tgt))
    return steps


def _scan_behaviors():
    """name -> {'idle': ctrlAnimOrNone, 'tapVerb': verbOrNone} from every
    gamescripts pack, newest revision winning each field separately (a
    newer def's controller is kept even when only an older pack carries
    the building's OnEvent). A <Building> element counts as a definition
    only with id=/type=/children (reward/quest XMLs carry bare name-only
    references that must not shadow the real def). Only names with a
    signal (explicit controller or a tap anim) are stored; everything
    else is engine-default and absent-from-cache."""
    by_name = {}
    packs = _gamescript_packs()
    for dat in packs:
        defs_here = {}          # name -> partial record, this pack
        scripts = {}            # script tag -> anim-play steps, this pack
        for f in sorted(dat.glob('*.xml')):
            try:
                t = f.read_text(errors='replace')
            except OSError:
                continue
            if ('<Building ' in t or '<BSv2 ' in t) and 'Building' in t:
                try:
                    root = ET.fromstring(t)
                except ET.ParseError:
                    continue
                defaults = None
                for d in root.findall('BuildingDefaults'):
                    for tag in ('NeutralAnimationController',
                                'ActiveAnimationController'):
                        a = d.find(tag)
                        if a is not None and a.get('name'):
                            defaults = a.get('name')
                            break
                    if defaults:
                        break
                for b in root.iter('Building'):
                    nm = b.get('name')
                    if not nm:
                        continue
                    prior = by_name.get(nm)
                    if prior and prior.get('idle') is not None \
                            and prior.get('tapVerb'):
                        continue          # fully resolved by a newer pack
                    rec = {'idle': None, 'tapVerb': None}
                    bs = b.find('BSv2')
                    if bs is not None and bs.get('neutralAnim'):
                        rec['idle'] = bs.get('neutralAnim')
                    else:
                        # NeutralAnimationController is the idle-loop
                        # declaration; ActiveAnimationController drives the
                        # state machine but doubles as the loop name for
                        # always-on props; file BuildingDefaults fill gaps
                        for tag in ('NeutralAnimationController',
                                    'ActiveAnimationController'):
                            a = b.find(tag)
                            if a is not None and a.get('name'):
                                rec['idle'] = a.get('name')
                                break
                        if rec['idle'] is None and defaults:
                            rec['idle'] = defaults
                            rec['idleFromDefaults'] = True
                    for ev in b.findall('OnEvent'):
                        if ev.get('event') != 'BuildingTouched':
                            continue
                        sc = ev.find('Script')
                        if sc is not None and sc.get('name'):
                            rec['tapRef'] = sc.get('name')
                            break
                    existing = defs_here.get(nm)
                    if existing:
                        # same building defined in two files of the pack
                        # (def + *_assetdata): merge the signals — an
                        # explicit neutralAnim/controller beats a value
                        # inherited from the other file's BuildingDefaults
                        if (existing['idle'] is None
                                or (existing.get('idleFromDefaults')
                                    and rec['idle'] is not None
                                    and not rec.get('idleFromDefaults'))):
                            if rec['idle'] is not None:
                                existing['idle'] = rec['idle']
                                existing['idleFromDefaults'] = \
                                    rec.get('idleFromDefaults', False)
                        if not existing.get('tapRef') and rec.get('tapRef'):
                            existing['tapRef'] = rec['tapRef']
                        continue
                    if not (b.get('id') or b.get('type') or len(b)):
                        continue          # name-only reference, not a def
                    defs_here[nm] = rec
            if '<ScriptPackage' in t:
                try:
                    root = ET.fromstring(t)
                except ET.ParseError:
                    continue
                for sc in root:
                    if sc.tag and sc.tag not in scripts and len(sc):
                        steps = _script_anim_steps(sc)
                        vars_set = {a.get('variable')
                                    for a in sc.iter('Action')
                                    if (a.get('type') or '') ==
                                    'setObjectVariable' and a.get('variable')}
                        if steps or vars_set:
                            scripts[sc.tag] = (steps, vars_set)
        for nm, rec in defs_here.items():
            ref = rec.pop('tapRef', None)
            rec.pop('idleFromDefaults', None)
            if ref:
                steps, vars_set = (scripts.get(ref) or ((), set()))
                for verb, tgt in steps:
                    if tgt is None or tgt == nm:
                        rec['tapVerb'] = verb
                        break
                if vars_set:
                    # which object variables the tap flips: a controller
                    # machine only clicks through if its driving variable
                    # is among them (_toggle_anims checks this)
                    rec['tapVars'] = sorted(vars_set)
            if (rec['idle'] is not None or rec['tapVerb'] is not None
                    or rec.get('tapVars')):
                prior = by_name.get(nm)
                if prior:
                    # a newer pack resolved half the record (e.g. its def
                    # carries the controller but the BuildingTouched lives
                    # only in older revisions' files): fill the gap, never
                    # clobber the newer value
                    if prior['idle'] is None and rec['idle'] is not None:
                        prior['idle'] = rec['idle']
                    if prior['tapVerb'] is None and rec['tapVerb'] is not None:
                        prior['tapVerb'] = rec['tapVerb']
                    if not prior.get('tapVars') and rec.get('tapVars'):
                        prior['tapVars'] = rec['tapVars']
                else:
                    by_name[nm] = rec
    return by_name, len(packs)


def _scan_layer_orders():
    """name -> [<AnimationLayerOrder> anim names] from the packs'
    *_assetdata*.xml, newest revision winning. The list is the engine's own
    compositor: those named anims are drawn together (first entry at the
    back) over the building's body, so for a multi-part asset they are the
    loops that belong on at the same time. Only four buildings declare one
    today (EscalatorToNowhere is the only multi-layer one: StairsUL, Stairs,
    Characters, StairsOV), but the scan is a pass over a few small files and
    the data is the authority when it exists."""
    out = {}
    for dat in _gamescript_packs():              # newest revision first
        for f in sorted(dat.glob('*assetdata*.xml')):
            try:
                t = f.read_text(errors='replace')
            except OSError:
                continue
            if '<AnimationLayerOrder' not in t:
                continue
            try:
                root = ET.fromstring(t)
            except ET.ParseError:
                continue
            for b in root.iter('Building'):
                nm = b.get('name')
                lo = b.find('AnimationLayerOrder')
                if not nm or lo is None or nm in out:
                    continue
                names = [x.get('name') for x in lo if x.get('name')]
                if names:
                    out[nm] = names
    return out


def _write_behavior_cache(by_name, orders, n_packs, controllers=None):
    import datetime
    BEHAVIORS.write_text(json.dumps(
        {'version': 3,
         'generated': datetime.date.today().isoformat(),
         'packs_scanned': n_packs,
         'byName': dict(sorted(by_name.items())),
         'layers': dict(sorted(orders.items())),
         'controllers': dict(sorted((controllers or {}).items()))}, indent=1))


def load_behaviors(refresh=False):
    """name -> {'idle', 'tapVerb'}; cached in data/building_behaviors.json
    (the pack scan is minutes-long, the packs are static) — build on first
    use, re-scan with --refresh or after new DLC extraction. The cache
    records how many packs it saw; extracting new gamescripts revisions
    invalidates it automatically (a stale cache silently under-resolves
    every building that only the new packs define — FortuneTellerMachine
    shipped with a 'Tap' strip and no binding until a refreshed scan
    found its tragedy-era definition). The same file caches the
    <AnimationLayerOrder> table (load_layer_orders)."""
    if not refresh and BEHAVIORS.exists():
        try:
            cached = json.loads(BEHAVIORS.read_text())
            if cached.get('packs_scanned') == len(_gamescript_packs()) and \
                    'layers' in cached and 'controllers' in cached:
                return cached['byName']
            # a v2 cache cannot be topped up: byName needs the tapVars
            # field the toggle gate resolves against — re-scan
            if 'controllers' not in cached:
                refresh = True
            else:
                print('  (gamescripts packs changed since the last scan — '
                      're-scanning; or run: gen_city_sprites.py behavior)')
        except (ValueError, KeyError):
            pass
    by_name, n_packs = _scan_behaviors()
    _write_behavior_cache(by_name, _scan_layer_orders(), n_packs,
                          _scan_controllers())
    return by_name


def load_layer_orders(refresh=False):
    """name -> [<AnimationLayerOrder> anim names]; shares the idle/tap
    cache file, so it is refreshed by the same --refresh."""
    if not refresh and BEHAVIORS.exists():
        try:
            cached = json.loads(BEHAVIORS.read_text())
            if 'layers' in cached and \
                    cached.get('packs_scanned') == len(_gamescript_packs()):
                return cached['layers']
        except (ValueError, KeyError):
            pass
    load_behaviors(refresh=refresh)
    try:
        return json.loads(BEHAVIORS.read_text()).get('layers') or {}
    except (OSError, ValueError):
        return _scan_layer_orders()


def _match_anim_verb(want, have, allow_base=False):
    """engine anim verb -> actual bsv3 anim name from `have` (case-
    insensitive; a trailing 'NoLoop' is engine semantics and stripped
    before the retry; a trailing 'Controller' names the anim the same way
    HouseBoatTopController plays HouseBoatTop). With allow_base (idle
    matches only) a '_Base'/'Base' suffix is also tried: multi-part
    buildings (SubFootprints) store the base part's loop as '<controller>_Base'
    on the main asset — ChineseJunk loops Neutral_Base, KrustyStation's base
    part loops ActiveBase. None when no strip exists for it."""
    if not want:
        return None
    low = {n.lower(): n for n in have}
    w = want.lower()
    if w in low:
        return low[w]
    if w.endswith('noloop'):
        base = w[:-len('noloop')].rstrip('_-')
        if base in low:
            return low[base]
        w = base
    if w.endswith('controller') and len(w) > len('controller'):
        base = w[:-len('controller')].rstrip('_-')
        if base in low:
            return low[base]
        w = base
    if allow_base:
        for cand in (w + '_base', w + 'base'):
            if cand in low:
                return low[cand]
    return None


def _slug_name_index():
    """slug -> building name(s) from data/building_ids.json."""
    ids = load_json('building_ids.json')
    idx = {}
    for v in ids.values():
        s = (v.get('slug') or '').lower()
        if not s:
            continue
        names = idx.setdefault(s, [])
        if v['name'] not in names:
            names.append(v['name'])
    return idx


def _slug_names(name_idx, slug):
    """every building name that renders from this asset slug. Multi-part
    lots share one bsv3 (OldEnglishStation + …Base + …Top all map to
    'oldenglishstation'); directional/flipped twins borrow the base list."""
    names = name_idx.get(slug)
    if names:
        return names
    for suf in ('flipped', 'ne', 'nw', 'se', 'sw'):
        if slug.endswith(suf):
            names = name_idx.get(slug[:-len(suf)])
            if names:
                return names
    return None


def _behavior_rec(by_name, slug, name_idx):
    """behavior record for a slug: building_ids gives the building name(s)
    behind the asset slug; directional/flipped twins borrow their base
    asset's record. {'idle': ..|None, 'tapVerb': ..|None} or None when the
    slug maps to no building with a signal."""
    names = _slug_names(name_idx, slug)
    if not names:
        return None
    best = None
    for nm in names:
        rec = by_name.get(nm)
        if not rec:
            continue
        if rec.get('tapVerb'):
            return rec
        if best is None and rec.get('idle') is not None:
            best = rec
    return best


def _fallback_tap_anim(have):
    """No BuildingTouched binding was found, but the asset carries a strip
    literally named 'Tap': that naming is the authors' own tap-anim
    convention (the scripts' tap verbs include 'Tap' x105), so trust it
    as the tap anim anyway — e.g. FortuneTellerMachine, whose def lives
    only in retired event packs the gamescripts data no longer ships."""
    for n in have:
        if n.lower() == 'tap':
            return n
    return None


# Engine click-state-machines. Many buildings' NeutralAnimationController
# name is NOT a bsv3 anim — it names a <Sequence> in the packs'
# buildingcontrollers.xml: an object-variable state machine whose branches
# each pick one named anim, advanced by the BuildingTouched script (which
# carries no anim-play step: DecorationTapped_WithActiveInOut flips
# State/ActiveIn/ActiveOut, Three_Way_Toggle_Tapped cycles ToggleState…).
# In the game RedstarHelicopter therefore sits at Neutral (static art),
# plays Active_In on the first tap and loops Active while active; the next
# tap plays Active_Out back to Neutral. Parsing the Sequences gives the
# map a click-toggle record for the whole family — three shapes:
#   inout  {in, loop?, out}  ActiveIn/ActiveOut transitions + State 0/1
#   active {loop}            State 0 static/Neutral, State 1 loops <loop>
#   cycle  {poses:[…]}       ToggleState 0..N, each state loops poses[i]
# (pose 0 renders through the normal idle gate when the asset has a
# Neutral strip; the map player only blits states 1..N).
# Land::/System:: conditions are game-state-driven (EspionageMode_*), not
# click-driven, so those Sequences are skipped — as are names ending in
# '_Tap' (the BuildingTouched script anim-plays once; the tapVerb path
# already gates those) and branches that don't select exactly one anim.
_CTRL_PAIR_RE = re.compile(r'Object::(\w+)\s*==\s*(\d+)')


def _parse_controller(seq):
    """<Sequence> element -> machine spec, or None when it is not a pure
    object-variable click state machine (see the note above)."""
    if (seq.get('name') or '').lower().endswith('_tap'):
        return None
    logic = seq.find('Logic')
    if logic is None:
        return None                       # linear Sequence, not a toggle
    branches = []                         # [(pairs|None, anim), ...]
    for br in logic:
        if br.tag not in ('If', 'ElseIf', 'Else'):
            return None
        anims = [a.get('name') for a in br.iter('Animation')]
        if len(anims) != 1 or not anims[0]:
            return None                   # zero- or multi-anim branch
        expr = br.get('expression')
        if expr and ('Land::' in expr or 'System::' in expr):
            return None
        pairs = None if br.tag == 'Else' else _CTRL_PAIR_RE.findall(expr or '')
        if br.tag != 'Else' and not pairs:
            return None                   # condition on something unparsable
        branches.append((pairs, anims[0]))
    if len(branches) < 2:
        return None
    varset = {v for pr, _a in branches if pr for v, _n in pr}
    # inout: ActiveIn / ActiveOut transitions, State 0 = neutral, Else = loop
    if varset == {'ActiveIn', 'ActiveOut', 'State'} and len(branches) == 4:
        get = lambda want: next(
            (a for pr, a in branches
             if pr and any(v == want and n == '1' for v, n in pr)), None)
        a_in, a_out = get('ActiveIn'), get('ActiveOut')
        neutral = next((a for pr, a in branches
                        if pr and any(v == 'State' and n == '0' for v, n in pr)),
                       None)
        loop = next((a for pr, a in branches if pr is None), None)
        if a_in and a_out and neutral and loop:
            return {'kind': 'inout', 'var': 'State',
                    'in': a_in, 'loop': loop, 'out': a_out}
        return None
    # active: State==0 neutral, Else loops one anim
    if varset == {'State'} and len(branches) == 2:
        loop = next((a for pr, a in branches if pr is None), None)
        neutral = next((a for pr, a in branches
                        if pr and any(v == 'State' and n == '0' for v, n in pr)),
                       None)
        if loop and neutral:
            return {'kind': 'active', 'var': 'State', 'loop': loop}
        return None
    # cycle: Var==1..N branches + Else (state 0); one pose per state
    else:
        numbered, poses0 = [], None
        for pr, a in branches:
            if pr is None:
                if poses0 is not None:
                    return None           # more than one Else
                poses0 = a
                continue
            if len(pr) != 1:
                return None               # compound condition
            (v, n), = pr
            numbered.append((v, int(n), a))
        if poses0 is None or not numbered:
            return None
        var = numbered[0][0]
        if any(v != var for v, _n, _a in numbered):
            return None
        states = {n for _v, n, _a in numbered}
        if states != set(range(1, max(states) + 1)) or \
                len(numbered) != max(states):
            return None
        poses = [poses0] + [None] * max(states)
        for _v, n, a in numbered:
            poses[n] = a
        return {'kind': 'cycle', 'var': var, 'poses': poses}


def _scan_controllers():
    """Sequence name -> click-machine spec, newest pack revision winning
    each name (mirrors _scan_layer_orders: a few small files, and the
    Sequences are the engine's own definition of what clicking does)."""
    out = {}
    for dat in _gamescript_packs():
        for f in sorted(dat.glob('*buildingcontrollers*.xml')):
            try:
                root = ET.fromstring(f.read_text(errors='replace'))
            except (OSError, ET.ParseError):
                continue
            for seq in root.iter('Sequence'):
                nm = seq.get('name')
                if not nm or nm in out:
                    continue
                spec = _parse_controller(seq)
                if spec:
                    out[nm] = spec
    return out


def load_controllers(refresh=False):
    """controller name -> click-machine spec; shares the idle/tap cache."""
    if not refresh and BEHAVIORS.exists():
        try:
            cached = json.loads(BEHAVIORS.read_text())
            if 'controllers' in cached and \
                    cached.get('packs_scanned') == len(_gamescript_packs()):
                return cached['controllers']
        except (ValueError, KeyError):
            pass
    load_behaviors(refresh=refresh)
    try:
        return json.loads(BEHAVIORS.read_text()).get('controllers') or {}
    except (OSError, ValueError):
        return _scan_controllers()


def _toggle_anims(controllers, bv, have):
    """behavior record -> manifest toggle gate, or None: the building's
    controller must be a parsed click-machine, its driving variable must be
    one the BuildingTouched script actually sets (otherwise clicks never
    advance it), and the strips the states name must exist — a half-toggle
    would leave the building stuck on a pose with no way back."""
    spec = controllers.get(bv.get('idle') or '')
    if not spec or spec['var'] not in (bv.get('tapVars') or ()):
        return None
    if spec['kind'] == 'inout':
        a_in = _match_anim_verb(spec['in'], have)
        a_out = _match_anim_verb(spec['out'], have)
        if not (a_in and a_out):
            return None
        return {'kind': 'inout', 'in': a_in,
                'loop': _match_anim_verb(spec['loop'], have),
                'out': a_out}
    if spec['kind'] == 'active':
        m = _match_anim_verb(spec['loop'], have)
        return {'kind': 'active', 'loop': m} if m else None
    poses = [_match_anim_verb(w, have) if w else None
             for w in spec['poses']]
    if any(p is None for p in poses[1:]) or len(poses) < 2:
        return None                       # a missing pose has no way back
    return {'kind': 'cycle', 'poses': poses}


def _anim_motion(parsed):
    """anim name -> number of DISTINCT frames in its range. A range whose
    frames are all one pose is a hold, not a loop: the atlas step drops it
    (deduped frames < 2), so it can never be an idle or a layer."""
    sigs = [_frame_sig(fr) for fr in parsed['frames']]
    out = {}
    for nm, a, b in (parsed['anims'] or []):
        if b <= a or b > len(parsed['frames']):
            continue
        out[nm] = len(set(sigs[a:b]))
    return out


_SPARSE_FAIL = None                 # last self-check failure state (debug)
_SPARSE_PX = [0]                      # last rejected pack's atlas px (retry)


def _pack_sparse(comps, blk=4, pad=3, max_w=4096, max_h=4096, label='',
                 conn=4, tile_min=24000, fill_max=65):
    """Cluster-rect packing for layer strips whose cells are almost all
    transparency (the escalator's riders: ~20k opaque px in a 2.8 Mpx
    canvas). Instead of one full-cell-per-frame atlas, pack the bbox of
    every opaque figure-cluster into one shelf atlas and record per-frame
    source rects for the player to blit (entry 'sub').

    Each crop is masked to its OWN cluster blocks (neighbour pixels inside
    a bbox zeroed, else they blit twice: the doubled wake-water bug), and
    the block scan rounds up so the trailing partial-block band — the
    boats' waterline — is scanned too.

    Crops that repeat across frames — a static hull under an animating
    wake, the carrier's unmoving deck — are byte-hashed and packed ONCE:
    every frame showing one blits the shared rect (sub entries may point
    at the same sx/sy). That dedupe replaces the old per-rect fat-blob
    bail, which killed exactly the strips the uniform atlas cannot ship
    under the player's decode gate (AircraftCarrier's 24 Mpx hull).

    Clustering splits STATIC from MOVING blocks (2026-10-30,
    privateisland05's top): a block is MOVING when its RGBA pixels differ
    across the loop (compared in anchor space), and moving blocks never
    join a static cluster's 8-connectivity. Without that, the island's
    gull/flag/swimmer/rotor each touch the tower, dragging their changing
    pixels into the tower's cluster: the 4.5 Mpx tower crop hashed unique
    on every frame, the atlas blew past the decode gate, and the strip
    fell back to a 2-cell grid that read as frozen. With the split the
    tower crop is byte-equal across all 48 frames — packed once — and the
    atlas is one tower rect plus small per-frame part rects. Every opaque
    pixel is still covered (a moving block whose part is absent in a
    frame carries that frame's own art into the moving cluster), so the
    self-check below stays exact.

    The bail-outs are now the savings tests: <3x vs full cells, or an
    atlas still over the player's cap. Returns
    (atlas, subs, maxw, maxh) or None."""
    try:
        import numpy as np
    except ImportError:
        return None
    from collections import deque
    _SPARSE_PX[0] = 0                       # stale hint from prior strip

    # Moving-block map in ANCHOR space: lay every frame's RGBA onto one
    # union canvas at its anchor offset and flag each blk-px block whose
    # pixels ever differ from frame 0. Frames' canvases differ in size
    # and origin, so the comparison must run anchor-space, not canvas-
    # space (the same distinction the grid snap above had to respect).
    anch = [(int(round(t[1])), int(round(t[2]))) for t in comps]
    amin_x = min(-fx for fx, _ in anch)
    amin_y = min(-fy for _, fy in anch)
    amax_x = max(t[0].width - fx for t, (fx, _) in zip(comps, anch))
    amax_y = max(t[0].height - fy for t, (_, fy) in zip(comps, anch))
    tpx, tpy = amin_x % blk, amin_y % blk      # pad so a grid line lands
    UW = -(-(amax_x - amin_x + tpx) // blk) * blk   # on anchor coord 0
    UH = -(-(amax_y - amin_y + tpy) // blk) * blk

    def place(k):
        a = np.asarray(comps[k][0])
        r = (0 - anch[k][1]) - amin_y + tpy
        c = (0 - anch[k][0]) - amin_x + tpx
        D = np.zeros((UH, UW, 4), np.uint8)
        D[r:r + a.shape[0], c:c + a.shape[1]] = a
        return D
    D0 = place(0)
    diff = np.zeros((UH, UW), bool)
    for k in range(1, len(comps)):
        diff |= (place(k) != D0).any(axis=2)
    GH, GW = UH // blk, UW // blk
    mv = diff.reshape(GH, blk, GW, blk).any(axis=(1, 3))   # moving blocks
    del diff, D0

    cands = []                    # clustered candidates, same tuple shape
    labs = [None] * len(comps)    # per-frame block -> cluster id map
    cid = 0                       # cluster ids unique across the strip
    for k, tup in enumerate(comps):
        im, fx, fy = tup[0], int(round(tup[1])), int(round(tup[2]))
        a = np.asarray(im)[:, :, 3]
        hgt, wid = a.shape
        m = a > 8
        # Anchor-aligned grid (2026-10-30, privateisland05): the bbox grid
        # must snap in ANCHOR space, not canvas space. The canvas origin
        # drifts +-2 px frame to frame (its topmost block is animating
        # water), so a canvas-aligned grid snapped a STATIC rock's top edge
        # to a different line each frame and the shipped oy bobbed
        # -503/-502/-501 while the engine holds the rock still. Shifting
        # the scan so a grid line passes through the anchor makes the snap
        # phase a function of engine space alone: same block -> same rect
        # on every frame. ox/oy are already anchor-relative (X0 - fx), so
        # they inherit the stability.
        shx, shy = (-fx) % blk, (-fy) % blk
        gh, gy = -(-(hgt + shy) // blk), -(-(wid + shx) // blk)   # ceil:
        if not gh or not gy:                      # the trailing partial
            return None                           # block band is art too
        # pad the trailing partial blocks so the waterline rows beyond
        # gh*blk / gy*blk are scanned too, not silently dropped:
        gridp = np.pad(m, ((shy, gh * blk - hgt - shy),
                           (shx, gy * blk - wid - shx)))
        grid = gridp.reshape(gh, blk, gy, blk).any(axis=(1, 3))
        # this frame's slice of the anchor-space moving map
        offy = (0 - fy - amin_y + tpy) // blk
        offx = (0 - fx - amin_x + tpx) // blk
        mvf = mv[offy:offy + gh, offx:offx + gy]
        lab = np.full((gh, gy), -1, np.int32)     # block -> rect index
        seen = np.zeros_like(grid, bool)

        def grow(i0, j0, gmask):
            nonlocal cid
            q = deque([(i0, j0)])
            seen[i0, j0] = True
            y0, x0, y1, x1 = i0, j0, i0, j0
            while q:
                y, x = q.popleft()
                lab[y, x] = cid
                if y < y0:
                    y0 = y
                if y > y1:
                    y1 = y
                if x < x0:
                    x0 = x
                if x > x1:
                    x1 = x
                for dy, dx in ([(0, 1), (0, -1), (1, 0), (-1, 0)] if conn == 4
                               else [(dy, dx) for dy in (-1, 0, 1)
                                     for dx in (-1, 0, 1)]):
                        ny, nx = y + dy, x + dx
                        if 0 <= ny < gh and 0 <= nx < gy and \
                                gmask[ny, nx] and not seen[ny, nx]:
                            seen[ny, nx] = True
                            q.append((ny, nx))
            # No canvas-edge clipping (2026-10-30, privateisland05's top):
            # the frame canvases' bboxes breathe a few px as art moves, and
            # min(wid, ...) then moved the rect edge with them — the byte-
            # identical 1.7k x 2.0k tower cluster packed 48 TIMES (1702 px
            # wide on some frames, 1704 on others). A pure grid multiple is
            # frame-invariant; area outside the canvas blits as transparent.
            X0, Y0 = x0 * blk - shx - pad, y0 * blk - shy - pad
            X1, Y1 = x1 * blk + blk - shx + pad, y1 * blk + blk - shy + pad
            cands.append((k, X0, Y0, X1, Y1, fx, fy, cid, shx, shy))
            cid += 1

        for gmask in (grid & ~mvf, grid & mvf):  # static clusters first,
            for i in range(gh):                   # then the moving parts
                for j in range(gy):
                    if gmask[i, j] and not seen[i, j]:
                        grow(i, j, gmask)
        labs[k] = lab
    if not cands:
        return None
    # cluster crop masked to its OWN blocks: pixels inside the bbox that
    # belong to a neighbouring cluster are zeroed — pasted unmasked they
    # blit twice under the twin's own rect, which is what doubled the
    # boats' wake water. The rect may reach outside the frame canvas
    # (grid-multiple bounds); that area crops as zero.
    def crop(cand):
        k, X0, Y0, X1, Y1, _fx, _fy, cd, shx, shy = cand
        cw, ch = comps[k][0].size
        arr = np.zeros((Y1 - Y0, X1 - X0, 4), np.uint8)
        cx0, cy0 = max(X0, 0), max(Y0, 0)
        cx1, cy1 = min(X1, cw), min(Y1, ch)
        if cx1 > cx0 and cy1 > cy0:
            arr[cy0 - Y0:cy1 - Y0, cx0 - X0:cx1 - X0] = \
                np.asarray(comps[k][0].crop((cx0, cy0, cx1, cy1)))
        lab = labs[k]
        gh, gy = lab.shape
        ys, xs = np.arange(Y0, Y1), np.arange(X0, X1)
        byr = np.clip((ys + shy) // blk, 0, gh - 1)[:, None]
        bxr = np.clip((xs + shx) // blk, 0, gy - 1)[None, :]
        m = lab[byr, bxr] == cd
        m &= ((ys >= 0) & (ys < ch))[:, None]
        m &= ((xs >= 0) & (xs < cw))[None, :]
        arr[~m] = 0
        return arr

    # cross-frame dedupe: identical crops (static parts of an animating
    # cell) pack once; twins blit the canonical rect. Keyed on content
    # only — a same-content crop that moved still carries its own ox/oy,
    # so sharing the atlas slot draws it in the right place either way.
    # Each cluster is first split into tight, dense rectangles
    # (2026-10-30, privateisland05's top loop): sparkle/wake chains
    # 8-connect into sprawling bboxes whose every pixel of sky and sea
    # between the art still cost atlas. First split along fully
    # transparent rows/columns to fixed point, then recurse large sparse
    # boxes in half along their long edge: the tower's 49 %-fill 3.1 Mpx
    # blob and the balloon's 51 %-fill 0.38 Mpx/frame chain both shrink
    # toward their opaque pixels, which is what fit enough loop phases
    # under the player's decode gate to read as animation. Every pixel
    # lands in exactly one box, so the self-check below stays exact.
    def _runs(mask):
        # start/end of each True run, vectorised: the density recursion
        # calls this on every node of every cluster crop
        m = mask.astype(np.int8)
        d = np.diff(m)
        starts = [int(v) for v in np.flatnonzero(d == 1) + 1]
        ends = [int(v) for v in np.flatnonzero(d == -1) + 1]
        if m[0]:
            starts.insert(0, 0)
        if m[-1]:
            ends.append(len(m))
        return list(zip(starts, ends))

    def _boxes(op, y0, y1, x0, x1, depth=0):
        if not op[y0:y1, x0:x1].any():          # a density split can
            return []                            # leave an empty half
        rows = _runs(op[y0:y1, x0:x1].any(axis=1))
        if len(rows) > 1:
            out = []
            for a, b in rows:
                out += _boxes(op, y0 + a, y0 + b, x0, x1, depth)
            return out
        cols = _runs(op[y0:y1, x0:x1].any(axis=0))
        if len(cols) > 1:
            out = []
            for a, b in cols:
                out += _boxes(op, y0, y1, x0 + a, x0 + b, depth)
            return out
        h, w = y1 - y0, x1 - x0
        if (w * h > tile_min and min(h, w) >= 96 and depth < 8 and
                int(op[y0:y1, x0:x1].sum()) * 100 < fill_max * h * w):
            if w >= h:                            # exact partition: no
                m = x0 + w // 2                   # pixel in two boxes
                return (_boxes(op, y0, y1, x0, m, depth + 1) +
                        _boxes(op, y0, y1, m, x1, depth + 1))
            m = y0 + h // 2
            return (_boxes(op, y0, m, x0, x1, depth + 1) +
                    _boxes(op, m, y1, x0, x1, depth + 1))
        return [(y0, y1, x0, x1)]

    rects, arrs, twin = [], [], []
    per = [[] for _ in comps]
    canon, uniq = {}, []
    for cand in cands:
        k, X0, Y0, X1, Y1, fx, fy, cd, shx, shy = cand
        arr = crop(cand)
        op = arr[:, :, 3] > 8
        if not op.any():
            continue
        hgt, wid = op.shape
        for ry0, ry1, rx0, rx1 in _boxes(op, 0, hgt, 0, wid):
            pa = arr[ry0:ry1, rx0:rx1]
            n = len(rects)
            rects.append((k, X0 + rx0, Y0 + ry0, X0 + rx1, Y0 + ry1,
                          fx, fy, cd, shx, shy))
            arrs.append(pa)
            per[k].append(n)
            key = hashlib.sha1(pa.tobytes()
                               + b'%08x%08x' % (pa.shape[1], pa.shape[0])
                               ).digest()
            c = canon.get(key)
            if c is None:
                canon[key] = n
                uniq.append(n)
                twin.append(None)
            else:
                twin.append(c)
    if not rects:
        return None
    mxw = max(r[3] - r[1] for r in rects)
    mxh = max(r[4] - r[2] for r in rects)
    W = min(max_w, max(mxw + 4, 64))
    # Bottom-left skyline packing (2026-10-30, privateisland05's top):
    # the old shelf left most of every row past its tallest cell empty
    # (~55% filled), and the loop was thinned to 14 frames to fit the
    # player's gate. Filling the column-height valleys instead packs the
    # same pieces near-nominal, so far more frames fit. Widest first
    # (the tower rect alone fixes the atlas width). The page must also
    # fit a GPU texture side limit: the narrow (769 px) pack that first
    # shipped the island top grew to H = 20161, a side over the GPU's
    # MAX_TEXTURE_SIZE uploads incomplete and BLITS BLACK (the "renders
    # as entirely black sprites" report, 2026-10-30) — so when the
    # column heights exceed max_h, widen toward max_w and re-pack.
    need = sum((rects[i][3] - rects[i][1] + 2) *
               (rects[i][4] - rects[i][2] + 2) for i in uniq)
    order = sorted(uniq, key=lambda n: -(rects[n][3] - rects[n][1]))
    pos = [None] * len(rects)
    while True:
        colh = [0] * W
        for i in order:
            _, X0, Y0, X1, Y1 = rects[i][:5]
            rw, rh = X1 - X0, Y1 - Y0
            rw2, rh2 = min(W, rw + 2), rh + 2   # 2 px gutters, as before
            win = np.lib.stride_tricks.sliding_window_view(colh, rw2).max(axis=1)
            x = int(np.argmin(win))
            y = int(win[x])
            pos[i] = (x, y)
            colh[x:x + rw2] = [y + rh2] * rw2
        H = max(colh) + 2
        if H <= max_h or W >= max_w:
            break
        W = min(max_w, max(2 * W, int(need * 1.10 / max_h) + 8))
    if H > max_h:                     # a single rect taller than a page:
        _SPARSE_PX[0] = W * H         # uniform cells (bisect sees this)
        return None
    for n in range(len(rects)):         # twins ride the canonical slot
        if twin[n] is not None:
            pos[n] = pos[twin[n]]
    full = sum(t[0].width * t[0].height for t in comps)
    _SPARSE_PX[0] = W * H             # last pack attempt's size (retry hint)
    if W * H * 3 > full:                # less than a 3x win: uniform cells
        return None
    if W * H > MAN_MAP_ATLAS_PX:        # still undecodable for the player
        return None
    atlas = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    subs = []
    for k, idxs in enumerate(per):
        fr = []
        for idx in idxs:
            _, X0, Y0, X1, Y1, fx, fy, _cd = rects[idx][:8]
            px, py = pos[idx]
            if twin[idx] is None:
                atlas.alpha_composite(Image.fromarray(arrs[idx]), (px, py))
            fr.append({'sx': px, 'sy': py, 'w': X1 - X0, 'h': Y1 - Y0,
                       'ox': X0 - fx, 'oy': Y0 - fy})
        subs.append(fr)
    # end-to-end self-check: re-blit every frame from the packed atlas and
    # diff its alpha against the source frame. Content lost (e.g. a
    # never-scanned band) or gained (double-blended neighbour pixels) is a
    # packer bug — never let it ship silently.
    A = np.asarray(atlas)[:, :, 3]
    bad = 0
    for k, idxs in enumerate(per):
        ca = np.asarray(comps[k][0])[:, :, 3]
        ci, cn = ca.astype(np.int16), np.zeros_like(ca, np.int16)
        for idx in idxs:
            _, X0, Y0, X1, Y1 = rects[idx][:5]
            px, py = pos[idx]
            # rect bounds may reach outside the frame canvas (grid-
            # multiple bounds): clip the blit to the canvas, atlas-side
            # window shifts with the clipped edge
            cx0, cy0 = max(0, X0), max(0, Y0)
            cx1, cy1 = min(ca.shape[1], X1), min(ca.shape[0], Y1)
            if cx1 <= cx0 or cy1 <= cy0:
                continue
            # int32: d * (255 - a) hits 65025, past int16 range
            a = A[py + (cy0 - Y0):py + (cy1 - Y0),
                  px + (cx0 - X0):px + (cx1 - X0)].astype(np.int32)
            d = cn[cy0:cy1, cx0:cx1].astype(np.int32)
            cn[cy0:cy1, cx0:cx1] = (a + d * (255 - a) // 255).astype(np.int16)
        # and nothing may blit where THIS frame draws no art: the twin
        # sharing rides on "same block content on every frame", which is
        # vacuously true for a cluster absent from the anchor-space
        # reference frame — without this, a mover that vanishes for half
        # the loop (the private-island gulls/balloons) ghosts at its
        # other poses' positions (2026-10-30, nine-balloons mapsim).
        extra = int(((cn > 8) & (ci <= 8)).sum())
        lost = int((ci - cn > 8).sum())
        gain = int((cn - ci > 8).sum())
        if lost or gain or extra:
            bad += 1
            print(f'  SPARSE-CHECK {label} frame {k}: '
                  f'{lost} px lost, {gain} px extra, {extra} px phantom')
    if bad:
        global _SPARSE_FAIL                        # debug hook: last failure
        _SPARSE_FAIL = dict(comps=comps, atlas=atlas, subs=subs,
                            rects=rects, pos=pos, labs=labs, per=per,
                            blk=blk, label=label)  # tools debugging
        raise AssertionError(f'sparse packer self-check failed for {label} '
                             f'({bad} frames)')
    return atlas, subs, mxw, mxh


def _sibling_base_anim(nm, have):
    """the bsv3 anim named '<sibling>Base'/'<sibling>_Base' when the asset
    carries one: the base part's loop named after the base building, the
    convention TheRottingPelicanBase/ChineseJunk's Neutral_Base follow. A
    pack that forgets the base's NeutralAnimationController (the engine
    then runs the body's default 'Neutral' and the map loses the whole
    base loop — SpringfieldMaximumSecurityPrison shipped idle) still gets
    its base composited when the strip is there to be found."""
    low = {h.lower(): h for h in have or []}
    return low.get(nm.lower() + 'base') or low.get(nm.lower() + '_base')


def _sibling_top_anim(have, claimed):
    """the asset's unclaimed top-part loop when a top sibling declared no
    controller: PrivateIsland's proxy buildings ship without a controller
    yet every PrivateIsland0X bsv3 carries 'PrivateIslandTop' (90 motion
    frames of palms) beside the base's declared 'privateislandbase' — the
    asset's own name is the top part's authority there. Like _active_pairs
    the claim is all-or-nothing: exactly one top-like candidate (last word
    Top, never a tap-state Active_*) or none; directional faces are
    alternative placements, already excluded by the last-word test."""
    cands = [h for h in have or []
             if 'active' not in h.lower() and h.lower() not in claimed
             and _part_last_word(h) == 'top']
    return cands[0] if len(cands) == 1 else None


def _layer_wants(by_name, orders, slug, name_idx, have=None):
    """ordered anim names the engine composites for this asset — the parts
    that loop TOGETHER over the body: the <AnimationLayerOrder> list when
    the assetdata declares one, then the controller anim of every building
    that renders from this slug (OldEnglishStationBase loops NeutralBase,
    …Top loops NeutralTop). With `have` (the asset's bsv3 anim names) a
    sibling that declared no controller contributes the '<sibling>Base'
    strip it owns by naming convention instead (_sibling_base_anim), and a
    controller-less *top* sibling contributes the asset's lone unclaimed
    top-like strip when a base-like loop is already wanted there
    (_sibling_top_anim — without that pair the base loop alone would gate
    as the idle and REPLACE the body, blanking the island's whole upper
    half). Deduped case-insensitively, draw order first."""
    names = _slug_names(name_idx, slug)
    if not names:
        return []
    out, seen = [], set()
    idles = []
    for nm in names:
        rec = by_name.get(nm)
        w = (rec or {}).get('idle')
        if w is None and not rec:
            w = _sibling_base_anim(nm, have)
        idles.append([w] if w else [])
    if have:
        want_lo = {w.lower() for lst in idles for w in lst}
        if any(_PART_BASE_RE.search(w) for lst in idles for w in lst):
            for i, nm in enumerate(names):
                if idles[i] or _part_last_word(nm) != 'top':
                    continue
                w = _sibling_top_anim(have, want_lo)
                if w:
                    idles[i] = [w]
                    want_lo.add(w.lower())
    for lst in ([orders.get(nm) or [] for nm in names] + idles):
        for w in lst:
            if w and w.lower() not in seen:
                seen.add(w.lower())
                out.append(w)
    return out


# Part-pair naming for multi-part sibling buildings sharing one asset (see
# _part_layers): the base part's loop is named '…Base'/'…Bottom', the top
# part's '…Top…' (or plain 'Neutral' on the top sibling — RedstarBarge).
_PART_BASE_RE = re.compile(r'(base|bottom)$', re.I)
_PART_TOP_RE = re.compile(r'top', re.I)
# directional sibling faces are ALTERNATIVES, not stacked parts: a sign
# placed South renders its South loop, it never composites East over it.
# Checked on the anim's LAST WORD (Neutral_South / FlandersHellSouth), so
# 'Base' is not mistaken for the 'se' face.
_PART_ORIENT_WORDS = {'south', 'east', 'sw', 'se', 'ne', 'nw', 'flipped'}


def _part_last_word(name):
    """last identifier word of an anim name: 'Neutral_South' and
    'FlandersHellSouth' both give 'south'."""
    last = re.split(r'[^A-Za-z0-9]+', name)[-1]
    return re.sub(r'(?<=[a-z0-9])(?=[A-Z])', ' ', last).split()[-1].lower()


def _active_pairs(have, parts):
    """the click-state twin of every layer part, in part order: the one
    anim whose last identifier word matches the part's (Base pairs Base,
    Top pairs Top) and whose name says 'active' — AircraftCarrier loops
    Neutral_Base / _Top and clicks over to Active_Base / Active_Top.
    All parts must pair with EXACTLY one candidate or none does: the
    stack plays whole (DonutBoat's Active_In_Base vs Active_Out_Base is
    an ambiguity, not an answer)."""
    out = []
    for w in parts:
        tail = _part_last_word(w)
        hits = [a for a in have if 'active' in a.lower() and
                _part_last_word(a) == tail and a.lower() != w.lower()]
        if len(hits) != 1:
            return None
        out.append(hits[0])
    if len({a.lower() for a in out}) != len(out):
        return None
    return out


def _part_layers(by_name, orders, slug, name_idx, have, idle):
    """Part loops to composite for an asset the engine splits across
    sibling buildings that each own one controller anim of the same bsv3 —
    the sea fleet above all (LuxuryYacht loops YachtBase and LuxuryYacht_Top
    loops YachtTop, two engine instances at one spot; the save only ever
    places the base one, so a single-base idle left every ship, island and
    platform missing its whole upper half on the map). Returns the part
    anims in draw order (base first), or None unless:
      * the sibling idles resolve to two distinct strips — or to just the
        base one when the top sibling's verb names a loop the bsv3 never
        shipped (DonutBoat plays BoatloadOfDonuts_Top in the engine, but
        only Active_*_Top exist): the top then lives in the body PNG and
        the base loop alone still must not REPLACE it,
      * one is base-like (name ends Base/Bottom) and another top-like
        (contains Top; a plain 'Neutral' on the top sibling qualifies;
        an unmatched top-like want qualifies when its strip is absent),
      * none is a directional face (South/East twins are alternatives), and
      * the single idle we resolved IS one of the part loops — an asset
        whose idle already covers the whole body is left alone."""
    matched, seen = [], set()
    unmatched_top = False
    for w in _layer_wants(by_name, orders, slug, name_idx, have):
        m = _match_anim_verb(w, have, allow_base=True)
        if m and m.lower() not in seen:
            seen.add(m.lower())
            matched.append(m)
        elif not m and _PART_TOP_RE.search(w) and \
                _part_last_word(w) not in _PART_ORIENT_WORDS:
            unmatched_top = True      # engine loops a top half we never got
    if idle.lower() not in seen:
        return None
    if len(matched) < 2 and not (len(matched) == 1 and unmatched_top):
        return None
    if any(_part_last_word(m) in _PART_ORIENT_WORDS for m in matched):
        return None
    if not any(_PART_BASE_RE.search(m) for m in matched):
        return None
    if not any(_PART_TOP_RE.search(m) or m.lower() == 'neutral'
               for m in matched) and not unmatched_top:
        return None
    return matched


def _behavior_map(by_name, orders, controllers, ameta, name_idx):
    """slug -> {'idle': bsv3 anim name|None, 'tap': bsv3 anim name|None,
    'layers': [anim, ...]|absent, 'toggle': {...}|absent} restricted to
    slugs the filmstrip manifest carries; verbs resolved against the strips
    that actually exist, so the map never points the web player at a missing
    atlas.

    'layers' is for the assets a single idle cannot draw: those whose idle
    resolves to nothing (EscalatorToNowhere's controller says 'Neutral', the
    bsv3 has no such loop) AND those whose idle resolves to just ONE part
    of a multi-part asset (_part_layers: the Base loop of a ship whose Top
    loop lives on the sibling building). The map player draws the static
    body and blits every layer cell over it, in list order.

    'toggle' is the click-state-machine gate (_scan_controllers): the
    building's taps flip the machine's variable, so clicks cycle states
    even though nothing loops on its own. State 0 is the idle/static look:
    when the machine names a Neutral strip and it exists, it ALSO gates as
    the ordinary idle loop; the player blits the toggle record's strips for
    states 1..N."""
    out = {}
    for s, rows in ameta.items():
        have = [e['anim'] for e in rows]
        if s in OVERLAY_SLUGS:
            continue        # companion strips ride their base slug's gate
        gate = OVERLAY_GATE.get(s)
        if gate:
            # the machine has no engine-animatable range of its own; play
            # the merged overlay strips under the synthesized gate, and
            # never let the generic verbs claim an Overlay* strip as an
            # idle (a lone strip REPLACES the body, blanking the tower)
            need = ([gate.get('tap')] if gate.get('tap') else []) + \
                   list(gate.get('layers') or [])
            if all(w in have for w in need):
                out[s] = {'idle': gate.get('idle'), 'tap': gate.get('tap'),
                          'layers': list(gate.get('layers') or [])}
            continue
        bv = _behavior_rec(by_name, s, name_idx) or {}
        tap_verb = bv.get('tapVerb')
        tap = (_match_anim_verb(tap_verb, have) if tap_verb
               else _fallback_tap_anim(have))
        idle = _match_anim_verb(bv.get('idle') or 'Neutral', have,
                                allow_base=True)
        ctl = controllers.get(bv.get('idle') or '')
        tog = None if tap else _toggle_anims(controllers, bv, have)
        if idle is None and (tog or ctl):
            # state 0 of a click-machine IS the Neutral anim: assets that
            # carry it keep an idle loop even while generic-controlled —
            # even when the click cycle itself was rejected (a pose has no
            # strip; ChokeCam's Toggle02)
            idle = _match_anim_verb('Neutral', have, allow_base=True)
        if idle and _part_last_word(idle) in _PART_ORIENT_WORDS:
            # the resolved idle is a DIRECTIONAL SIBLING's face loop: the
            # base building carries no idle of its own, so _behavior_rec
            # fell through to the …South record, and its face loop then
            # resolved as a real idle. A face animates the OTHER instance
            # of the asset and draws only its own slice — as a
            # body-REPLACING idle it erased the rest of the scene
            # (FlandersPersonalHell lost the arch's right gate,
            # HellGraduationBanner its right panel, GeriatricParkFrontGate
            # its east tower, SpellementaryCorridors an arcade bay). The
            # asset's whole-body loop is the base instance's idle whenever
            # one ships (the engine default; heavengate, whose building
            # carries no record at all, already plays it); when none does,
            # drop it and let the composite path below layer the face OVER
            # the body, which holds the whole static scene.
            idle = _match_anim_verb('Neutral', have, allow_base=True)
        part_lay = _part_layers(by_name, orders, s, name_idx, have, idle) \
            if idle else None
        if part_lay:
            # the resolved idle is ONE part of a split asset (a ship's hull
            # loop, its superstructure looping on the sibling building):
            # compositing owns the idle slot, exactly as for the no-idle
            # composites below — drawing the lone part left the object's
            # whole upper half off the map
            idle = None
        elif idle and _PART_BASE_RE.search(idle):
            # a loop NAMED for a part must never REPLACE the body either:
            # the player draws a plain idle strip instead of the body PNG,
            # so the lone base-water loops left ornatepier's and squidport's
            # arches and SmallIsland02's islet off the map (their top loops
            # are 1-frame holds, so no top strip exists to pair with). The
            # rest of the art lives only in the body — composite the part.
            part_lay = [idle]
            idle = None
        rec = {'idle': idle, 'tap': tap}
        if part_lay:
            rec['layers'] = part_lay
        elif idle is None:
            lay, seen = [], set()
            tap_low = (tap or '').lower()
            # The asset's whole-body loop: its presence settles the
            # directional question — South/East sibling loops are then
            # ALTERNATIVE faces played by separately-placed sibling
            # instances (a second gate at another park entrance), not
            # parts to stack on this one (see _part_layers' face rule).
            full = _match_anim_verb('Neutral', have, allow_base=True)
            faces = 0
            for w in _layer_wants(by_name, orders, s, name_idx, have):
                m = _match_anim_verb(w, have, allow_base=True)
                if m and m.lower() not in seen and m.lower() != tap_low:
                    if full and _part_last_word(m) in _PART_ORIENT_WORDS:
                        faces += 1        # an alternative face, not a part
                        continue
                    seen.add(m.lower())
                    lay.append(m)
            if lay:
                rec['layers'] = lay       # composites own the no-idle slot
            elif faces and full:
                # every sibling wanted a face and the bsv3 ships the whole
                # gate as its own loop: that loop IS the base instance's
                # idle (heavengate, whose building carries no behavior verb
                # at all, already plays it this way). Stacking the faces
                # instead drew each sibling's tower art at the offset it
                # was authored for and left the placed base instance a
                # torn, half-covered gate (ItchyScratchyLandGate, where
                # the body bakes no right tower at all and the mis-placed
                # Neutral_East strip floated a second one over the banner).
                rec['idle'] = full
                if tog:
                    rec['toggle'] = tog   # whole-loop idle + clickable states
            elif tog:
                rec['toggle'] = tog
        elif tog:
            rec['toggle'] = tog           # idle Neutral + clickable states
        if rec.get('layers'):
            # the layered click one-shot: one Active strip per part, played
            # together over the body (viewer: _tap.list). Multi-frame only
            # — a 1-frame "animation" has nothing to play.
            tl = _active_pairs([e['anim'] for e in rows if e['frames'] > 1],
                               rec['layers'])
            if tl:
                rec['tapLayers'] = tl
        if not any((rec.get('idle'), rec.get('tap'), rec.get('layers'),
                    rec.get('toggle'))):
            gate = V3_CLICK_GATES.get(s)
            if gate:
                # nothing generic resolved; play the synthesized inout
                # machine if every strip it names really ships as a loop
                fr = {e['anim']: e['frames'] for e in rows}
                need = [gate['in'], gate['loop'], gate['out']]
                if all(fr.get(n, 0) > 1 for n in need if n):
                    rec['toggle'] = dict(gate)
        out[s] = rec
    return out


def _anim_note(cap):
    """manifest header, shared by the atlas pass and the map-only rewrite."""
    return ('bsv3 0x0103 named-anim filmstrips; frames deduped, thinned to '
            f'{cap}/anim, anchor-centred cells; no timing encoded, played at '
            f'{ANIM_FPS} fps. behavior: engine idle/tap anim per slug (loop '
            'only idle; play tap once on click), from the gamescripts packs; '
            'layers: the part loops a multi-part asset composites over its '
            'body (1-frame entries are its static parts); sparse: cluster-'
            'rect packed, blit per entry in sub[] (upx: the pre-sparse '
            'uniform size); tapLayers: the layered click one-shot, one '
            'Active strip per part played together; toggle: the engine\'s '
            'click state machine from buildingcontrollers.xml — inout '
            '{in,loop,out} plays in then loops loop, click again plays out; '
            'active {loop} toggles the loop on/off; cycle {poses} walks '
            'pose loops on each click (state 0 is the idle/static look); '
            'Overlay* strips were baked from an un-placed overlay companion '
            'asset and merged onto the base slug (see OVERLAY_COMPANIONS)')


# The map player refuses to decode a filmstrip over this many pixels
# (ANIM_MAX_ATLAS_PX in web/viewer/city-view-pixi.js), and a part stack
# draws whole or not at all — so a stack with ANY oversized strip never
# animates on the map and its static fallback is the plain body PNG. For
# the sea fleet that fallback lies about the object: AircraftCarrier's
# hull sides and wake (170k px) exist ONLY in its oversized 24 Mpx
# Neutral_Base strip, so the map drew a deck floating on the ocean.
MAN_MAP_ATLAS_PX = 16e6
# ...but freezing a frame is the wrong answer for click/traffic machines
# whose loop CONTENT moves through the frame (a monorail train would be
# baked half in and half out of the station; a gate door stuck open):
# their body PNGs already read as complete static scenes.
_STACK_SKIP = {'futuristicmonorailstation', 'northwardmonorailbridge',
               'itchyscratchygate'}

_BODY_MASKS = {}          # slug -> (opaque mask, anchor_x, anchor_y) | None


def _body_mask(slug):
    """The shipped flattened body PNG's opaque mask and its anchor, cached.
    One read per slug serves every strip the slug ships."""
    if slug not in _BODY_MASKS:
        m = None
        try:
            import numpy as np              # lazy, as in _pack_sparse
            sj = json.loads((ROOT / 'web/assets/city/city-sprites.json')
                            .read_text())
            info = (sj.get('sprites') or {}).get(slug) or {}
            p = ROOT / 'web/assets/city' / info.get('png', '')
            if p.is_file():
                m = (np.asarray(Image.open(p).convert('RGBA'))[:, :, 3] > 8,
                     int(round(info['anchor'][0])),
                     int(round(info['anchor'][1])))
        except (OSError, KeyError, TypeError, ValueError,
                json.JSONDecodeError):
            m = None                      # no body to compare against
        _BODY_MASKS[slug] = m
    return _BODY_MASKS[slug]


def _strip_selfcontained(slug, comps):
    """May the viewer skip the body PNG under this sparse strip's cells?

    Only when the strip re-blits the scene the body shows: every frame's
    rects are the layer's OWN composite, so a strip whose frames carry the
    whole building (privateisland05's top: tower, island, sea, balloon and
    all) hides nothing by suppressing the body — while the body, drawn
    under it, re-exposes the stale Neutral pose (the frozen second balloon
    beside the loop's moving one, 2026-10-30). A thin overlay layer (the
    same asset's base strip: a 342x186 cell of spray) is only ever an
    addition to the body, so it must keep it.

    Measured against the body PNG's own pixels in anchor space: the frames
    together must account for the whole body (UNION — a mover is never at
    the body's home pose, which is exactly the case this enables), and no
    single frame may drop much of it (per-frame floor, so a strip that
    shows a fragment most of the loop can't claim the scene)."""
    bm = _body_mask(slug)
    if not bm:
        return False
    import numpy as np                      # lazy, as in _pack_sparse
    body, bax, bay = bm
    n_body = int(body.sum())
    if n_body < 4096 or not comps:
        return False
    hgt, wid = body.shape
    union = np.zeros((hgt, wid), bool)
    worst = 1.0
    for c in comps:
        canvas, fax, fay = c[0], c[1], c[2]
        arr = np.asarray(canvas)[:, :, 3] > 8
        ch, cw = arr.shape
        ox, oy = int(round(fax - bax)), int(round(fay - bay))
        sx0, sy0 = max(0, -ox), max(0, -oy)
        sx1, sy1 = min(cw, wid - ox), min(ch, hgt - oy)
        if sx1 <= sx0 or sy1 <= sy0:
            frac = 0.0
        else:
            m = np.zeros((hgt, wid), bool)
            m[sy0 + oy:sy1 + oy, sx0 + ox:sx1 + ox] = arr[sy0:sy1, sx0:sx1]
            union |= m
            frac = int((m & body).sum()) / n_body
        worst = min(worst, frac)
    return int((union & body).sum()) >= 0.9 * n_body and worst >= 0.8


def _stack_statics(man):
    """Bake body + every layer's cell 0 into web/assets/city/stacks/<slug>.png
    for the oversized part stacks the map can never animate, and hang the
    composite off the city-sprites.json entry as `stack` {png,w,h,anchor}
    (its own canvas/anchor: cells may overhang the body, the carrier's
    hull strip reaches 37 px below the body PNG's bottom edge). The
    viewer draws it in place of the body when the static fallback runs;
    animation (any layer that DOES fit the cap) is untouched — the stack
    is only ever a still. Returns the slugs baked. Idempotent: always
    recomposes from the pristine body PNG, which the entry's `png` still
    names."""
    from PIL import ImageChops
    city = ROOT / 'web/assets/city'
    sp_path = city / 'city-sprites.json'
    sj = json.loads(sp_path.read_text())
    sprites = sj.get('sprites') or {}
    (city / 'stacks').mkdir(exist_ok=True)
    baked = []
    for slug, rec in sorted((man.get('behavior') or {}).items()):
        want = rec.get('layers')
        base = slug
        for suf in ('flipped', 'ne', 'nw', 'se', 'sw'):
            if base.endswith(suf):
                base = base[:-len(suf)]
                break
        if not want or base in _STACK_SKIP:
            continue
        low = {e['anim'].lower(): e for e in (man.get('anims') or {}).get(slug, [])}
        ents = [low[w.lower()] for w in want if w.lower() in low]
        if not ents or not any(
                e.get('upx', e['cols'] * e['cellw'] *
                        math.ceil(e['frames'] / e['cols']) * e['cellh'])
                > MAN_MAP_ATLAS_PX for e in ents):
            # upx: the pre-sparse uniform size — a cluster-packed strip CAN
            # animate now, but its 1-frame cell 0 still belongs in the
            # static (Anim-off) composite: the baked stack is the fallback
            continue
        info = sprites.get(slug)
        if not info:
            continue
        try:
            body = Image.open(city / info['png']).convert('RGBA')
            pieces = []
            for e in ents:
                st = Image.open(city / e['png']).convert('RGBA')
                if e.get('sparse'):
                    # shelf atlas: there is no cell grid to crop — blit
                    # frame 0's rects at their anchor-relative offsets,
                    # exactly as the player composites the live stack
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
        except OSError:
            continue
        W, H = body.size
        x0, y0, x1, y1 = 0, 0, W, H
        for cx, cy, c in pieces:
            x0, y0 = min(x0, cx), min(y0, cy)
            x1, y1 = max(x1, cx + c.size[0]), max(y1, cy + c.size[1])
        # skip no-ops: strips whose cell 0 only re-paint what the body
        # already shows (luxuryyacht's water sparkle) would just churn files
        full = Image.new('RGBA', (x1 - x0, y1 - y0), (0, 0, 0, 0))
        full.alpha_composite(body, (-x0, -y0))
        under = Image.new('RGBA', full.size, (0, 0, 0, 0))
        under.alpha_composite(body, (-x0, -y0))
        for cx, cy, c in pieces:
            full.alpha_composite(c, (cx - x0, cy - y0))
        added = sum(ImageChops.subtract(full.getchannel('A'),
                                        under.getchannel('A')).histogram()[21:])
        if added < max(4096, 0.01 * W * H):
            continue
        rel = 'stacks/' + slug + '.png'
        full.save(city / rel)
        info['stack'] = {'png': rel, 'w': full.size[0], 'h': full.size[1],
                         'anchor': [info['anchor'][0] - x0,
                                    info['anchor'][1] - y0]}
        baked.append(slug)
    # prune stale composites: a slug that lost its bake last pass (its
    # strips moved under the cap, or the delta gate now rejects it) must
    # not keep a `stack` pointing at a stale — possibly mis-baked — PNG
    stale = [s for s, i in sprites.items() if i.get('stack') and s not in baked]
    for s in stale:
        del sprites[s]['stack']
    if baked or stale:
        sp_path.write_text(json.dumps(sj, indent=1))
        for f in (city / 'stacks').glob('*.png'):   # orphaned composites
            if f.stem not in baked:
                f.unlink()
    return baked


def do_behavior_map():
    """rewrite ONLY city-anims.json's 'behavior' gate from the manifest as
    it stands (no atlas work): the pack tables changed, or the gate rules
    did, and the map player needs the new idle/tap/layers without waiting
    on a full filmstrip pass. Also (re)bakes the oversized-stack statics
    (see _stack_statics) and refreshes their city-sprites.json entries."""
    import datetime
    ameta_path = ROOT / 'web/assets/city/city-anims.json'
    man = json.loads(ameta_path.read_text())
    ameta = man.get('anims') or {}
    man['generated'] = datetime.date.today().isoformat()
    man['note'] = _anim_note(ANIM_MAX_FRAMES)
    man['behavior'] = _behavior_map(load_behaviors(), load_layer_orders(),
                                    load_controllers(),
                                    ameta, _slug_name_index())
    ameta_path.write_text(json.dumps(man, indent=1))
    baked = _stack_statics(man)
    if baked:
        print(f'static stacks baked for {len(baked)} oversized-stack slugs: '
              + ', '.join(baked))
    n_lay = sum(1 for v in man['behavior'].values() if v.get('layers'))
    n_id = sum(1 for v in man['behavior'].values() if v.get('idle'))
    n_tp = sum(1 for v in man['behavior'].values() if v.get('tap'))
    n_tg = sum(1 for v in man['behavior'].values() if v.get('toggle'))
    n_var = len(load_controllers())
    print(f'behavior map: {len(man["behavior"])} slugs — {n_id} idle loops, '
          f'{n_lay} layered, {n_tp} tap anims, {n_tg} toggles '
          f'({n_var} click-machines parsed) -> {ameta_path}')


def _loop_occluder(parsed, img, name, keep):
    """Blocks the static bakes ABOVE a loop, which the loop never draws.

    Returns (oc_canvas, oc_ax, oc_ay, above_canvas, above_ax, above_ay), or
    None when nothing qualifies. Call site: do_anims' render()."""
    if parsed['v'] != 1 or not parsed.get('frames'):
        return None
    saved = parsed.get('static_src')
    try:
        st = static_blocks(parsed, name) or []
    finally:
        if saved is not None:
            parsed['static_src'] = saved
    if not st:
        return None
    order = {}                              # cell -> list index, first = top
    for i, b in enumerate(st):
        order.setdefault(b[0], i)
    frames = [parsed['frames'][i] for i in keep]
    keep_ci = {b[0] for fr in frames for b in fr}
    st_ci = set(order)
    # The cell only ever hides art the BODY paints, so the neutral frame the
    # body was baked from has to BE this loop's base pose: require the loop to
    # redraw at least one of the static's own blocks. captainmordecaiboat's
    # Top_Active loop draws 7 hull cells while its static is 3 top/flag cells,
    # i.e. two different part sets — erasing its "omitted" blocks (which are
    # the whole body) would have blanked the animation. Measured 2026-10-29
    # over the 86 scored loops: this drops 8 loops, exactly the one that got
    # worse (captainmordecaiboat) plus seven no-ops/negligible ones.
    if not (st_ci & keep_ci):
        return None
    cand = [b for b in st if b[0] not in keep_ci]
    if not cand:
        return None
    # a frame that draws some OTHER cell in the candidate's position slot is
    # swapping in a part variant, not omitting baked art
    swapped = {(round(b[1], 1), round(b[2], 1))
               for fr in frames for b in fr if b[0] not in st_ci}
    cand = [b for b in cand if (round(b[1], 1), round(b[2], 1)) not in swapped]
    if not cand:
        return None
    depth = min(order[b[0]] for b in cand)
    # Depth for a cell the static does not carry: the loop swaps part
    # variants into slots the static fills with its own cell (the DonutBoat's
    # C_Wave_09..11 take the C_Wave_08 slots), so inherit the depth of the
    # nearest static block by position. Only a block with no slot neighbour at
    # all is treated as painted above the omitted ones — that art stays.
    slots = [(b[1], b[2], order[b[0]]) for b in st]

    def block_depth(b):
        if b[0] in order:
            return order[b[0]]
        ds = sorted((b[1] - sx) ** 2 + (b[2] - sy) ** 2 for sx, sy, _si in slots)
        if not ds or ds[0] > LOOP_SLOT_TOL ** 2:
            return -1                       # not in any slot: treat as painted
                                            # above the omitted blocks
        if len(ds) > 1 and ds[0] >= 0.75 ** 2 * ds[1]:
            return -1                       # ambiguous owner: same, be safe
        near = min(range(len(slots)),
                   key=lambda k: (slots[k][1] - b[1]) ** 2 + (slots[k][2] - b[2]) ** 2)
        return slots[near][2]

    ins = [block_depth(b) for fr in frames for b in fr]
    known = [i for i in ins if i >= 0]
    if not known or depth >= min(known):
        return None                     # the omitted blocks sit below the loop
    # union across the loop: art that paints over the omitted blocks in ANY
    # frame is never erased, so the cells stay consistent with each other
    above = [b for fr in frames for b in fr if block_depth(b) < depth]
    oc = _composite(parsed, img, name, cand)
    if not oc:
        return None
    # The whole premise is that the BODY already paints these blocks, so the
    # cell must not re-expose them. Where the body paints nothing there is
    # nothing to hide behind and erasing would punch a hole in the sprite
    # (captainmordecaiboat: its static resolves to the 4 tops/flag blocks
    # while the loop draws the hull, so its "omitted" blocks are not baked in
    # at all). Intersect with the body's own alpha and bail out when the body
    # backs too little of the occluder.
    from PIL import ImageChops
    base = _composite(parsed, img, name, st)
    if not base:
        return None
    oca = oc[0].getchannel('A')
    m = Image.new('L', oc[0].size, 0)
    m.paste(base[0].getchannel('A'),
            (int(round(oc[1] - base[1])), int(round(oc[2] - base[2]))))
    newa = ImageChops.multiply(oca, m.point(lambda v: 255 if v > 60 else 0))
    opaque = lambda im: sum(im.histogram()[61:])      # noqa: E731
    tot = opaque(oca)
    if not tot or opaque(newa) < 0.2 * tot:
        return None                     # the body does not back these blocks
    oc = (oc[0].copy(), oc[1], oc[2], oc[3], oc[4], oc[5])
    oc[0].putalpha(newa)
    ab = _composite(parsed, img, name, above) if above else None
    return (oc[0], oc[1], oc[2],
            ab[0] if ab else None, ab[1] if ab else None, ab[2] if ab else None)


def _erase_occluded(c, ax, ay, occl):
    """Punch the omitted top blocks' silhouette out of a rendered cell.

    `occl` is _loop_occluder's tuple; the occluder and its 'above' render are
    aligned to the cell by their anchors (_composite reports the building
    anchor as canvas px). Art any frame paints OVER the omitted blocks
    survives; everything the omitted blocks would cover becomes transparent,
    so the body PNG shows through exactly where the engine hides it."""
    from PIL import ImageChops
    oc, oax, oay, ab, abx, aby = occl

    def aligned(ch, cx, cy):                # align by the anchor
        m = Image.new('L', c.size, 0)
        m.paste(ch, (int(round(ax - cx)), int(round(ay - cy))))
        return m

    mask = aligned(oc.getchannel('A'), oax, oay)
    if ab is not None:
        mask = ImageChops.subtract(mask, aligned(ab.getchannel('A'), abx, aby))
    mask = mask.point(lambda v: 0 if v > 60 else 255)
    c = c.copy()
    c.putalpha(ImageChops.multiply(c.getchannel('A'), mask))
    return c


def _anim_clock(ent, keep, a, b):
    """Record on a strip entry which engine tick each cell stands for.

    rp[k] = cell k's offset in the raw loop, lt = the loop's tick count
    (b - a + 1). The engine holds every raw frame for one tick, and generation
    samples long loops and drops runs of identical frames, so a cell's
    position in the atlas says nothing about when it should be shown. Without
    the mapping the player wraps each strip on its OWN cell count, so the two
    halves of one asset drift apart: the GreenpeaceBoat's loops are both 20
    ticks, but its hull kept 10 cells and its superstructure 8, so they bobbed
    at different rates (2026-10-29, "both parts animating, just at different
    times"). The same mapping also puts every loop back on the engine's clock
    instead of playing a thinned strip faster than it moves in the game."""
    n = ent.get('frames') or 0
    rp = [i - a for i in keep[:n]]
    lt = b - a + 1
    if n and (rp != list(range(n)) or lt != n):
        ent['rp'] = rp
        ent['lt'] = lt


# Assets whose motion lives in un-placed overlay companions (2026-10-31,
# lavamachine): the base bsv3's frame section is ONE repeated record (every
# frame identical, no motion to bake), while the real loops live in
# <slug>…overlay… bsv3s the same DLC pack ships WITHOUT xml — no building
# places them and no gamescript names them, the engine composites them from
# code no data file exposes. The naming carries the intent
# (<slug>neutraloverlay01 idles, <slug>activeoverlay02 is the click
# eruption). do_anims bakes each companion's named range as a plain strip
# (its origin IS the building's ground pin — verified: the plume erupts
# from the tower top when origin-aligned) and merges it into the BASE slug
# under a unique alias, so the existing layers/tap gate draws
# body + idle overlay + tap one-shot with no viewer change. The pool gained
# the companion files from the cdn 7z's nested pack zip; the XMAS2017
# duplicates are byte-identical, so there is no winter variant.
OVERLAY_COMPANIONS = {
    'lavamachine': (
        ('lavamachineneutraloverlay01', 'Neutral', 'OverlayNeutral'),
        ('lavamachineactiveoverlay02', 'Active', 'OverlayActive'),
    ),
}
# The gate the merged strips play under — synthesized from the naming, as
# no gamescript names the machine. _behavior_map applies it only while the
# strips exist, and never lets the generic verbs claim the Overlay* strips
# (an idle strip would REPLACE the body, blanking the tower).
OVERLAY_GATE = {
    'lavamachine': {'idle': None, 'tap': 'OverlayActive',
                    'layers': ['OverlayNeutral']},
}
OVERLAY_SLUGS = {c for comps in OVERLAY_COMPANIONS.values()
                 for c, _a, _n in comps}

# Synthesized click gate for the fully-decoded 0x0303 assets the gamescript
# data never names (no behavior record, no controller: _behavior_rec finds
# nothing, so the generic verbs resolve no idle/tap) whose bsv3 ranges are
# themselves the engine's click-machine vocabulary — Active / Active_In /
# Active_Out is the inout family (notes/01). playdoughfactory ships exactly
# that trio plus a 1-frame 'Neutral' hold (its static art; a hold never
# bakes an atlas), and Active_In is itself one repeated pose, so the real
# inout record — which requires BOTH transition strips to ship — cannot
# form. 'in' re-uses the Active loop instead: the first click starts the
# machine running seamlessly (loop pick-up is invisible), the second plays
# the genuine shutdown transition (Active_Out) back to the static body.
# _behavior_map applies a gate only when every strip it names ships as a
# multi-frame loop and nothing generic resolved.
V3_CLICK_GATES = {
    'playdoughfactory': {'kind': 'inout', 'in': 'Active',
                         'loop': 'Active', 'out': 'Active_Out'},
}


def do_anims(slug=None, cap=ANIM_MAX_FRAMES, placed=False):
    """Filmstrip atlases for the animated bsv3 assets (0x0103 only: the
    0x0303 frame section is not decoded, notes/01). For every named anim
    spanning >1 distinct frame, render its frames (deduped, thinned to
    `cap`) and pack them into one atlas PNG under
    web/assets/city/anims/ + web/assets/city/city-anims.json. Each cell
    is the same canvas, the frame pasted so its building anchor lands at
    the cell centre — cells share a size and the player just translates.
    --placed limits the batch to the slugs the save actually places.

    city-anims.json also carries a 'behavior' map (the M4 gate): per slug,
    which named anim the engine loops on its own (ActiveAnimationController
    / neutralAnim, default 'Neutral') and which one the BuildingTouched
    script plays on tap. do_anims forces strips for both so the web player
    never points at a missing atlas; the packs scan itself is cached in
    data/building_behaviors.json (see `behavior` subcommand).

    Assets with no controller loop of their own but with <AnimationLayerOrder>
    / multi-part sibling buildings are the third case: their motion lives in
    the PART loops (escalatortonowhere: Stairs + Characters), so those are
    forced into `wanted` too and the map records them as slug -> layers."""
    import datetime
    resolve_seasons()          # filmstrips must follow the resolved base art
    man_path = ROOT / 'web/assets/city/city-sprites.json'
    sprites = json.loads(man_path.read_text())['sprites']
    out_dir = ROOT / 'web/assets/city/anims'
    out_dir.mkdir(parents=True, exist_ok=True)
    ameta_path = ROOT / 'web/assets/city/city-anims.json'
    ameta = {}
    if ameta_path.exists():
        try:
            ameta = json.loads(ameta_path.read_text()).get('anims', {})
        except ValueError:
            ameta = {}
    behaviors = load_behaviors()
    orders = load_layer_orders()
    controllers = load_controllers()
    name_idx = _slug_name_index()

    def write_meta():
        ameta_path.write_text(json.dumps({
            'version': 2,
            'generated': datetime.date.today().isoformat(),
            'note': _anim_note(cap),
            'anims': dict(sorted(ameta.items())),
            'behavior': _behavior_map(behaviors, orders, controllers,
                                      ameta, name_idx)},
            indent=1))

    if isinstance(slug, str):
        slug = [s for s in slug.split(',') if s]      # --slug a,b,c
    slugs = list(slug) if slug else sorted(sprites)
    if placed:
        keep = _placed_slugs()
        slugs = [s for s in slugs if s in keep]
    # overlay companions bake as themselves (plain v1 assets) and the merge
    # pass below moves their strips onto the base slug
    comp_jobs = {}
    for base, comps in OVERLAY_COMPANIONS.items():
        if base in slugs:
            for c, an, al in comps:
                comp_jobs[c] = (base, an, al)
                if c not in slugs:
                    slugs.append(c)
    n_assets = n_anims = 0
    fails = []
    since_ckpt = 0
    for s in slugs:
        bsv3f, rgbf = POOL / (s + '.bsv3'), POOL / (s + '.rgb')
        if not bsv3f.exists() or not rgbf.exists():
            continue
        try:
            parsed = parse_bsv3(bsv3f.read_bytes(), s)
            if parsed['v'] not in (1, 3) or not parsed['frames'] \
                    or parsed['nf'] < 2:
                # 0x0303 joins 0x0103 when the frame section decoded (see
                # _v3_frames); files whose section did not keep frames=None
                # and stay static-only.
                continue
            if s in comp_jobs:
                # a companion ships more ranges than the gate uses (the
                # eruption file also replays the idle pose); baking only
                # the aliased range keeps the batch and the atlas dir lean
                parsed['anims'] = [r for r in (parsed['anims'] or [])
                                   if r[0] == comp_jobs[s][1]]
            rngs = [(nm, a, b) for nm, a, b in (parsed['anims'] or [])
                    if b > a and b < len(parsed['frames'])]
            all_ranges = [(nm, a, b) for nm, a, b in (parsed['anims'] or [])
                          if a <= b < len(parsed['frames'])]
            if not rngs:
                continue
            # the engine's own loop (controller anim) and tap anim must
            # both have strips, even when they lose the longest-4 cut
            bv = _behavior_rec(behaviors, s, name_idx) or {}
            have_names = [nm for nm, _a, _b in rngs]
            strips = {e['anim'].lower() for e in ameta.get(s, [])}
            idle_want = _match_anim_verb(bv.get('idle') or 'Neutral',
                                         have_names, allow_base=True)
            tap_want = (_match_anim_verb(bv['tapVerb'], have_names)
                        if bv.get('tapVerb')
                        else _fallback_tap_anim(have_names))
            wanted = [w for w in (idle_want, tap_want) if w]
            layset, statics = set(), set()
            # The engine composites the parts of a split stack TOGETHER, so
            # every part the bsv3 carries must ship. Consulting the wants only
            # when the idle resolved to nothing left the DonutBoat
            # (2026-10-29) animating a bare hull: its idle resolved to
            # BoatloadOfDonuts_Base, the longest-4 cut dropped
            # BoatloadOfDonuts_Top, and the top half stayed frozen in the body
            # PNG. Ask the same authority the behavior map uses — _part_layers,
            # which refuses directional-face twins (the GeriatricParkGate's
            # South/East loops are alternative placements, not parts) — and
            # force whatever ELSE it says draws with the idle.
            motion = None
            part_wants = []
            for want in _layer_wants(behaviors, orders, s, name_idx,
                                     have_names):
                m = _match_anim_verb(want, have_names, allow_base=True)
                if m and m not in part_wants:
                    part_wants.append(m)
            stack = _part_layers(behaviors, orders, s, name_idx,
                                 list(have_names) + part_wants,
                                 idle_want or 'Neutral') if part_wants else None
            for m in part_wants:
                if not idle_want:
                    layset.add(m.lower())     # as before this fix
                elif not stack or m.lower() == idle_want.lower() or \
                        m not in stack:
                    continue                  # not a stack, or the idle has it
                if m.lower() in strips or \
                        m.lower() in [q.lower() for q in wanted]:
                    continue
                if idle_want:
                    # only a mate this pass has to generate joins layset: the
                    # stacks that already ship a pair keep the gates (sparse
                    # packing, the tap pairing) exactly as they shipped
                    layset.add(m.lower())
                if motion is None:
                    motion = _anim_motion(parsed)
                if motion.get(m, 0) > 1:      # a hold is not a loop
                    wanted.append(m)
            if not idle_want:
                # a part whose range is a single frame is a static piece of
                # the composite (EscalatorToNowhere's StairsOV is the front
                # panel that hides the step ends): it must still ship, as a
                # 1-frame layer, or the loops paint over art the engine
                # would have drawn on top of them
                declared = set()
                for nm_ in _slug_names(name_idx, s) or []:
                    declared.update(w.lower() for w in orders.get(nm_) or [])
                for nm_, a_, b_ in all_ranges:
                    if a_ != b_ or nm_.lower() not in declared or \
                            nm_.lower() in strips or \
                            nm_.lower() in [q.lower() for q in wanted]:
                        continue
                    wanted.append(nm_)
                    statics.add(nm_.lower())
                    layset.add(nm_.lower())
            if layset:
                # the click-state pair of every layer part must ship too,
                # or the map has nothing to play on tap: _behavior_map
                # records tapLayers only when EVERY part pairs (draw order
                # is its business; here the names only force generation)
                prs = _active_pairs(have_names, sorted(layset))
                if prs:
                    for p in prs:
                        if p.lower() not in [q.lower() for q in wanted]:
                            wanted.append(p)
            # strips the map draws WITHOUT the click path's oversize
            # exemption — layer parts and the resolved idle — must come
            # back through this pass (sparse / thinning) even when they
            # lost the longest-4 cut, or their stale over-cap atlas is
            # all the map will ever have. Plain tap/toggle strips keep
            # their old gate-exempt uniform atlases: the huge pool has
            # always carried them on click.
            need = set(layset)
            if idle_want:
                need.add(idle_want.lower())
            for e in ameta.get(s, []):
                apx = (e['w'] * e['h'] if e.get('w') else
                       e['cols'] * e['cellw'] *
                       math.ceil(e['frames'] / e['cols']) * e['cellh'])
                if apx > MAN_MAP_ATLAS_PX and e['anim'].lower() in need \
                        and e['anim'] not in wanted:
                    wanted.append(e['anim'])
            if slug is None and s in ameta:
                have = {e['anim'].lower() for e in ameta[s]}
                if all(w.lower() in have for w in wanted):
                    continue  # resumable: strips already generated
            sigs = {_frame_sig(fr) for fr in parsed['frames']}
            if len(sigs) < 2:
                continue      # every frame identical: no motion to show
            img = load_sheet(rgbf, s)
            # keep the longest loops; dedupe identical frame ranges
            have_ranges = list(all_ranges)
            seen = set()
            rngs = sorted(rngs, key=lambda r: -(r[2] - r[1]))
            rngs = [r for r in rngs
                    if not (r[1], r[2]) in seen and not seen.add((r[1], r[2]))]
            rngs = rngs[:ANIM_MAX_ANIMS]
            for want in wanted:
                if any(r[0].lower() == want.lower() for r in rngs):
                    continue
                rr = next((r for r in have_ranges
                           if r[0].lower() == want.lower()), None)
                if rr:
                    rngs.append(rr)   # may duplicate a kept range under
                                      # its own name: entries key by name
            entry = ameta.setdefault(s, [])
            for nm, a, b in rngs:
                idxs = _sample_range(a, b, cap)
                # drop frames identical to their predecessor in the loop
                keep, prev = [], None
                for i in idxs:
                    sg = _frame_sig(parsed['frames'][i])
                    if sg != prev:
                        keep.append(i)
                        prev = sg
                if not keep or (len(keep) < 2 and b > a):
                    continue          # a single-frame hold ships as 1 cell
                # cell = the union bbox of the loop's frames expressed in
                # ANCHOR space: every frame's art spans (w - fx) right and
                # (h - fy) down from its anchor, and Ax/Ay px left/up of it
                # (_composite returns the anchor as canvas px). Centreing
                # the ANCHOR (not the canvas) in the cell is what keeps the
                # ground pin still AND keeps art that hangs above/below the
                # anchor — e.g. fountain sprays, ay > h — inside the cell.
                # Frames are rendered twice (cheap geometry pass, then the
                # paste pass) rather than held in RAM: a 48-frame loop of a
                # large landmark would be ~0.7 Gpx otherwise.
                # 2026-10-29: a loop must not re-expose art the body hides
                # (boatloadofdonuts / the "DonutBoat" stray-water report).
                # Its idle frames carry 9 blocks while its Neutral static
                # carries 11: the two extras, C_BoatLoadOfDonutsTop (the
                # donut pile) and C_BoatLoadOL (the funnel), are listed
                # FIRST, so they paint ABOVE everything (_composite paints
                # the list last-first). The engine therefore hides the bow
                # wake behind the pile — the game's own flattened
                # boatloadofdonuts_transimage.rgb shows a clean deck, and
                # our static matches it to 0.4% inside that block. The cell
                # has no pile to hide behind, so blitting it over the body
                # laid the wake across the deck on every beat but the one
                # whose off-pattern wave cell the *Input rule already drops
                # ("still there on all but one frame"). Punching the omitted
                # blocks' silhouette out of every cell is exactly what the
                # engine's paint order does with them. _loop_occluder gates
                # it to blocks missing from EVERY frame of the loop, never
                # replaced in their own slot, and listed above every block
                # the loop does draw — so animator parts (a tail that
                # appears in some frames, a swapped sign variant) are
                # untouched and the erase is a no-op for them.
                occl = _loop_occluder(parsed, img, s, keep)

                def render(fi, occl=occl):
                    r = _composite(parsed, img, s, parsed['frames'][fi])
                    if r is None or occl is None:
                        return r
                    return (_erase_occluded(r[0], r[1], r[2], occl),) + r[1:]
                pairs = [(i, render(i)) for i in keep]
                pairs = [p for p in pairs if p[1] is not None]
                keep = [p[0] for p in pairs]        # keep and comps stay
                comps = [p[1] for p in pairs]       # index-aligned (thinning
                                                    # and the paste loop pair
                                                    # keep[k] with cell k)
                if not comps or (len(comps) < 2 and b > a):
                    continue
                Ax = max(int(round(c[1])) for c in comps)
                Ay = max(int(round(c[2])) for c in comps)
                cell_w = max(1, max(c[0].width - int(round(c[1]))
                                    for c in comps) + Ax)
                cell_h = max(1, max(c[0].height - int(round(c[2]))
                                    for c in comps) + Ay)
                cols = min(cap, max(1, int(math.ceil(math.sqrt(len(comps))))))
                rows = math.ceil(len(comps) / cols)
                uniform = cols * cell_w * rows * cell_h
                upx = uniform if uniform > MAN_MAP_ATLAS_PX else None
                lf = None                 # pre-thin loop length (see below)
                if b > a and ((nm.lower() in layset and
                               uniform > ANIM_SPARSE_PX) or
                              uniform > MAN_MAP_ATLAS_PX):
                    # mostly-empty layer strip (the riders), or any strip the
                    # player would reject outright (uniform atlas over its
                    # decode gate — the carrier's hull): cluster-rects are
                    # the only way it animates on the map at all
                    # (2026-10-30, privateisland05's top) If the atlas is
                    # still over the gate, thin the loop with wrap-around
                    # phase sampling and retry — the moving content grows
                    # ~linearly with frame count, so a gate-passing strip
                    # usually sits at 2/3..1/2 of the sampled frames. 30
                    # visible phases beat the 2-cell grid fallback.
                    sp = _pack_sparse(comps, label=f'{s}/{nm}')
                    n_before = len(comps)
                    comps0, keep0 = comps, keep
                    # (2026-10-30, privateisland05's top) If the atlas is
                    # over the player's gate, thin with wrap-around phase
                    # sampling and repack: atlas px ≈ fixed (statics,
                    # packed once) + linear (per-frame movers), so one
                    # probe estimates the fit and a short bisect between
                    # the passing and failing counts lands the largest
                    # loop that fits. 30 visible phases beat the 2-cell
                    # grid fallback; the probes converge in 2-4 packs.
                    if sp is None and len(comps0) > 10:
                        lo, hi = 0, len(comps0)     # pass / fail counts
                        pts = [(len(comps0), _SPARSE_PX[0])]
                        best = None
                        while hi - lo > 1:
                            px = pts[-1][1]
                            if len(pts) >= 2 and pts[-1][0] != pts[-2][0]:
                                (n1, p1), (n2, p2) = pts[-2], pts[-1]
                                sl = (p1 - p2) / float(n1 - n2)
                            else:
                                sl = 0.0
                            if sl > 0:
                                # solve the two-point line for the gate
                                est = int((MAN_MAP_ATLAS_PX * 0.995
                                           - (p1 - sl * n1)) / sl)
                            else:
                                est = int(hi * MAN_MAP_ATLAS_PX / px * 0.9)
                            n_try = max(lo + 1, min(hi - 1, max(10, est)))
                            idx2 = sorted({(i * len(comps0)) // n_try
                                           for i in range(n_try)})
                            cand = [comps0[i] for i in idx2]
                            ck = [keep0[i] for i in idx2]
                            r = _pack_sparse(cand, label=f'{s}/{nm}')
                            if r is None:
                                hi = n_try
                                pts.append((n_try, _SPARSE_PX[0]))
                            else:
                                lo, best = n_try, (cand, ck, r)
                        if best is None:            # grid pass below must
                            comps, keep = comps0, keep0   # see full sampling
                        else:
                            comps, keep, sp = best
                    if sp is not None:
                        atlas, subs, mw, mh = sp
                        png = f'{s}__{_safe_anim(nm)}.png'
                        atlas.save(out_dir / png)
                        entry[:] = [e for e in entry if e['anim'] != nm]
                        ent = {'anim': nm, 'png': f'anims/{png}',
                               'frames': len(comps), 'cols': 1,
                               'cellw': mw, 'cellh': mh,
                               'w': atlas.width, 'h': atlas.height,
                               'upx': uniform,
                               'sub': subs, 'ax': Ax, 'ay': Ay,
                               'fps': ANIM_FPS, 'sparse': 1}
                        if _strip_selfcontained(s, comps):
                            # this strip's cells ARE the scene (measured
                            # against the body PNG, see the test): the
                            # flattened body under one only re-exposes the
                            # stale Neutral pose — the frozen second
                            # balloon beside the loop's moving one
                            # (privateisland05, 2026-10-30). The viewer
                            # skips the body for these; an overlay strip
                            # that only adds a piece never gets the flag.
                            ent['nc'] = 1
                        if len(comps) < n_before:
                            ent['lf'] = n_before   # shared-clock marker,
                            # same convention as the thinned grid path
                            # Thinning slows a loop as much as it cuts
                            # frames: at 12 fps a 22-cell/96-tick strip
                            # holds each pose 0.37 s beside the base's
                            # 0.17 s (the "top reads slow" report). Run
                            # the strip's own clock so poses change ~4/s
                            # (the base's cadence), capped at 18 — past
                            # 1.5x the shared 12 a city loop turns
                            # jittery.
                            ent['fps'] = max(ANIM_FPS, min(
                                18, round(4.0 * (b - a) / len(comps))))
                        _anim_clock(ent, keep, a, b)
                        entry.append(ent)
                        n_anims += 1
                        continue
                if uniform > MAN_MAP_ATLAS_PX and len(comps) > 2 and b > a:
                    # over the player's decode gate and cluster-rects lost
                    # (the carrier's wake animates across the WHOLE hull
                    # bbox, so no shared rect exists): thin the loop to the
                    # most frames whose grid atlas fits — a choppy wave is
                    # still a ship, a frozen one is the floating-deck bug
                    n_before = len(comps)
                    fit = int(MAN_MAP_ATLAS_PX // (cell_w * cell_h))
                    while fit >= 2:
                        c2 = min(cap, max(1, int(math.ceil(math.sqrt(fit)))))
                        if c2 * math.ceil(fit / c2) * cell_w * cell_h \
                                <= MAN_MAP_ATLAS_PX:
                            break
                        fit -= 1
                    if fit >= 2:
                        # Sample WRAP-AROUND phases, not an endpoints
                        # linspace (2026-10-30, privateisland05): the old
                        # round(i*step) picked cells 0 and len-1 at fit=2,
                        # which are temporally ADJACENT in a looping strip
                        # — the Top shipped rp [0, 95] of a 96-tick loop
                        # and read as frozen. Phase spread keeps ~half the
                        # loop between adjacent shipped poses.
                        idx2 = sorted({(i * len(comps)) // fit
                                       for i in range(fit)})
                        comps = [comps[i] for i in idx2]
                        keep = [keep[i] for i in idx2]
                        lf = n_before       # loop length BEFORE thinning:
                        # the player maps its shared clock through it, so a
                        # thinned layer stays in step with its stack-mates
                        Ax = max(int(round(c[1])) for c in comps)
                        Ay = max(int(round(c[2])) for c in comps)
                        cell_w = max(1, max(c[0].width - int(round(c[1]))
                                            for c in comps) + Ax)
                        cell_h = max(1, max(c[0].height - int(round(c[2]))
                                            for c in comps) + Ay)
                        cols = min(cap, max(1, int(math.ceil(
                            math.sqrt(len(comps))))))
                        rows = math.ceil(len(comps) / cols)
                        uniform = cols * cell_w * rows * cell_h
                atlas = Image.new('RGBA', (cols * cell_w, rows * cell_h),
                                  (0, 0, 0, 0))
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
                    continue
                png = f'{s}__{_safe_anim(nm)}.png'
                atlas.save(out_dir / png)
                entry[:] = [e for e in entry if e['anim'] != nm]
                ent = {'anim': nm, 'png': f'anims/{png}',
                       'frames': drawn, 'cols': cols,
                       'cellw': cell_w, 'cellh': cell_h,
                       'ax': Ax, 'ay': Ay,
                       'fps': ANIM_FPS}
                if upx:
                    ent['upx'] = upx    # pre-thin size: still a baked-stack
                                        # slug (the Anim-off picture)
                if lf and lf != drawn:
                    ent['lf'] = lf      # pre-thin length for an old player
                _anim_clock(ent, keep, a, b)
                entry.append(ent)
                n_anims += 1
            if entry:
                n_assets += 1
            else:
                ameta.pop(s, None)
        except Exception as e:
            fails.append((s, f'{type(e).__name__}: {e}'))
        since_ckpt += 1
        if since_ckpt >= 100:      # checkpoint so an interrupted run resumes
            since_ckpt = 0
            write_meta()

    # merge the overlay companions into their base slug (see
    # OVERLAY_COMPANIONS): the strips keep their own anchor-centred cells,
    # only the manifest key and anim name change; the comp keys stay so a
    # resumed batch does not re-render them (they are never placed, and
    # _behavior_map skips them, so they draw nothing on their own).
    for base, comps in OVERLAY_COMPANIONS.items():
        if slug is not None and base not in slugs:
            continue
        for comp, an, al in comps:
            src = next((e for e in ameta.get(comp, []) if e['anim'] == an),
                       None)
            if src:
                e2 = dict(src)
                e2['anim'] = al
                if not any(e['anim'] == al for e in ameta.get(base, [])):
                    n_anims += 1
                ameta[base] = [e for e in ameta.get(base, [])
                               if e['anim'] != al] + [e2]
    write_meta()
    print(f'anims: {n_assets} assets, {n_anims} new atlases '
          f'(manifest {len(ameta)} assets in {ameta_path})')
    if fails:
        print(f'  failures: {len(fails)}')
        for s, e in fails[:10]:
            print(f'    {s}: {e}')


def _safe_anim(nm):
    """filmstrip filename slug for an anim name. The 32-char cap must not
    silently collide: SpringfieldMaximumSecurityPrisonTop_Active and
    …PrisonBase both truncated to 'SpringfieldMaximumSecurityPrison', so
    the two entries shared one PNG and the later write clobbered the tap
    strip. A truncated name keeps a short digest of the full name instead."""
    safe = ''.join(c if c.isalnum() else '_' for c in nm)
    if len(safe) <= 32:
        return safe or 'anim'
    return safe[:27] + '_' + hashlib.sha1(
        safe.encode('utf-8')).hexdigest()[:4]




def xml_anchor(slug, canvas_h, pool_dir=None):
    """Authoritative sprite anchor from the asset's pool xml def, or None.

    transImageX/Y semantics (pinned 2026-10-19, notes/06): for assets whose
    bsv3 pivot is sound, the pair may be anything the author typed (several
    healthy assets carry far-off values — powerplant00 non-flipped tx
    -320.05 vs its bsv3 anchor 778.75 — while ~347 others match the bsv3
    anchor to <1.5px, e.g. powerplant00flipped ax 757.30 vs -tx 757.299),
    so it is NOT a universal anchor source. It is, however, the authoring
    ground truth for the degenerate single-block 'C_Building' assets whose
    bsv3 pivot forced the bbox bottom-centre guess: ax = -transImageX,
    ay = canvas_h + transImageY there (powerplant01flipped true ax 757.0 vs
    bbox guess 539.0, a 3.5-tile error that hung the building east/south of
    its lot — user eye-test picked this render: m4-pp2-variants.png panel
    B). Hence: authoritative only when pivot would be 'bbox'.
    A (0, 0) pair is 'unspecified' and returns None (most assets).
    """
    p = (pool_dir or POOL) / (slug + '.xml')
    if not p.exists():
        return None
    try:
        r = ET.fromstring(p.read_text(errors='replace'))
        tx = float(r.get('transImageX') or 0)
        ty = float(r.get('transImageY') or 0)
    except Exception:
        return None
    if tx == 0.0 and ty == 0.0:
        return None
    return (-tx, canvas_h + ty)


def _sheet_marker(path):
    """Flatness signature of a sheet as a PLACEHOLDER marker quad:
    (w, h, opaque-ratio, quantised-colour-count) when the sheet is a
    small (<=96x96) solid-ish slab in <=8 bucket colours (colours
    quantised to 32-unit buckets so one marker colour's AA/premultiply
    levels collapse), else None. Real single-cell art — trashcan's grey
    can, pylon's orange cone — buckets past 8 and is not a marker."""
    try:
        _w, _h, _bpp, rgba, _pm = rgb_to_rgba(path.read_bytes(), path.name)
    except Exception:
        return None
    n = _w * _h
    if not n or _w > 96 or _h > 96:
        return None
    opaque = 0
    cols = set()
    for i in range(3, len(rgba), 4):
        if rgba[i] > 8:
            opaque += 1
            cols.add((rgba[i - 3] // 32, rgba[i - 2] // 32, rgba[i - 1] // 32))
    ratio = opaque / n
    if ratio < 0.25 or len(cols) > 8:
        return None
    return _w, _h, ratio, len(cols)


def _transimage_only(s, parsed, rgbf):
    """The companion path for a transimage-only asset, else None.

    The crowd-of-* props (crowdofmovementarians, crowdofseasonalworkers,
    crowdofbullies, crowdofcosplayers, gnomeautomatoncrowd,
    dancingchildren, unrulycrowd, hellkidscrowd, …) ship a degenerate
    bsv3: ONE cell over a tiny solid-colour placeholder .rgb — a white
    'C_Square' (48x48) or a blue 'C_CrowdofPres' sliver (12x24). The
    body fallback draws that quad and the sprite reads as a flat box/
    sliver on the map; the art the game actually shows is the coloured
    '<slug>_transimage.rgb' companion, which the engine draws at the
    Building xml's (transImageX, transImageY) offset from the block
    origin (same pinning as xml_anchor: ax = -tx, ay = H + ty, verified
    on the ~347 healthy assets whose bsv3 anchor matches that pair to
    <1.5 px).

    Fires only on the full signature — single cell, marker-quad sheet,
    companion on disk that carries real content (>1% opaque and more
    colours than the marker), and a non-zero xml offset pair — so
    healthy single-cell assets keep the bsv3 path (trashcan/pylon ship
    real art in their own 12-bucket sheets and are not markers; the
    spotlightwhite* slugs have no companion at all).
    """
    if len(parsed['cells']) != 1:
        return None
    tif = POOL / (s + '_transimage.rgb')
    if not tif.exists():
        return None
    m = _sheet_marker(rgbf)
    if m is None:
        return None
    try:
        _w, _h, _bpp, rgba, _pm = rgb_to_rgba(tif.read_bytes(), tif.name)
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
            cols.add((rgba[i - 3] // 32, rgba[i - 2] // 32, rgba[i - 1] // 32))
    if opaque / n < 0.01 or len(cols) <= m[3]:
        return None
    return tif


def _render_transimage(s, tif, xml_dir, out_png, png_field, parsed):
    """Static frame for a transimage-only asset: the full companion
    sheet as-is (its transparent margins carry the authoring offset, so
    no trim) with the origin-derived anchor from the xml pair."""
    p = (xml_dir or POOL) / (s + '.xml')
    try:
        r = ET.fromstring(p.read_text(errors='replace'))
        tx = float(r.get('transImageX') or 0)
        ty = float(r.get('transImageY') or 0)
    except Exception:
        return None
    if tx == 0.0 and ty == 0.0:
        return None
    img = load_sheet(tif, s + '_transimage')
    out_png.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_png)
    parsed['warnings'].append(
        f'{s}: transimage-only asset (placeholder-quad sheet); drew '
        f'{tif.name} at ({tx}, {ty}) instead')
    return {
        'png': png_field,
        'w': img.width,
        'h': img.height,
        'anchor': [round(-tx, 2), round(img.height + ty, 2)],
        'pivot': 'transimage',
        'variant': f'0{parsed["v"]}03',
        'static': 'transimage',
        'blocks': 1,
        'skipped': 0,
        'rotmax': 0.0,
    }, img


def do_reanchor():
    """Apply the xml-anchor rule to an existing manifest without re-rendering
    any PNGs (anchors are manifest-only metadata)."""
    import datetime
    manifest_path = ROOT / 'web' / 'assets' / 'city' / 'city-sprites.json'
    manifest = json.loads(manifest_path.read_text())
    man = manifest['sprites']
    changed = 0
    for s, e in sorted(man.items()):
        if e.get('pivot') != 'bbox':
            continue  # xml only replaces the degenerate bbox guesses
        xa = xml_anchor(s, e['h'])
        if xa and (abs(xa[0] - e['anchor'][0]) > 0.01
                   or abs(xa[1] - e['anchor'][1]) > 0.01):
            e['anchor'] = [round(xa[0], 2), round(xa[1], 2)]
            e['pivot'] = 'xml'
            changed += 1
    manifest['generated'] = datetime.date.today().isoformat()
    manifest_path.write_text(json.dumps(manifest, indent=1))
    from collections import Counter
    print(f'reanchor: {changed}/{len(man)} anchors taken from xml defs; '
          f'pivot {dict(Counter(e.get("pivot") for e in man.values()))}')


def _render_sprite(s, bsv3f, rgbf, xml_dir, out_png, png_field):
    """Composite one slug's static frame to out_png, recorded in the entry
    as png=<png_field> (path relative to web/assets/city). Returns
    (manifest_entry, warnings, canvas) or (None, warnings, None) when the
    static frame holds nothing drawable. Shared by the base render and the
    season-variant render in do_sprites."""
    parsed = parse_bsv3(bsv3f.read_bytes(), s)
    img = load_sheet(rgbf, s)
    r = render_static(parsed, img, s)
    if r is None:
        ti = _transimage_only(s, parsed, rgbf)
        if ti:
            et = _render_transimage(s, ti, xml_dir, out_png, png_field,
                                    parsed)
            if et:
                return et[0], parsed['warnings'], et[1]
        return None, parsed['warnings'], None
    canvas, ax, ay, drawn, skipped, rotmax = r
    ti = _transimage_only(s, parsed, rgbf)
    if ti:
        et = _render_transimage(s, ti, xml_dir, out_png, png_field,
                                parsed)
        if et:
            return et[0], parsed['warnings'], et[1]
    pivot = 'bsv3'
    if ay < 4.0:
        # Degenerate authoring pivot: some single-block 'C_Building'
        # assets (powerplant01/02, generichouse00/02/03/04, skipsdiner,
        # bench & similar props) export with the block rect's TOP-LEFT
        # at the origin (ay ~ 0; healthy assets sit at ay ~ h..1.5h),
        # which would hang the whole image below its ground pin. Re-pin
        # the bbox bottom-centre onto the anchor — the engine's own
        # convention for well-formed 1x1 props. Distribution of raw ay
        # over the pool is bimodal (max 1.25px broken vs >=289px
        # healthy — flat ground decals like runwaypiece03 sit BELOW the
        # origin and must not re-pin), so an absolute px threshold
        # never fires on healthy sprites.
        ax, ay = canvas.width / 2.0, float(canvas.height)
        pivot = 'bbox'
        parsed['warnings'].append(
            f'{s}: degenerate bsv3 pivot, anchor re-pinned '
            f'to bbox bottom-centre')
    xa = xml_anchor(s, canvas.height, xml_dir)
    if xa and pivot == 'bbox':
        # xml def beats the bbox guess for degenerate pivots only;
        # healthy bsv3 anchors stay untouched (see xml_anchor docstring).
        ax, ay = xa
        pivot = 'xml'
    out_png.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_png)
    entry = {
        'png': png_field,
        'w': canvas.width,
        'h': canvas.height,
        'anchor': [round(ax, 2), round(ay, 2)],
        'pivot': pivot,
        'variant': f'0{parsed["v"]}03',
        'static': parsed.get('static_src'),
        'blocks': drawn,
        'skipped': skipped,
        'rotmax': round(rotmax, 4),
    }
    return entry, parsed['warnings'], canvas


def _trim_malloc():
    """PIL's big transient canvases leave glibc arenas mapped even after the
    Image objects die, and a multi-hour single-process sprites run grows to
    the cgroup limit and gets OOM-killed (observed 2026-10-25: Killed at
    ~2000 slugs). gc + malloc_trim(0) after every checkpoint hands the RSS
    back to the kernel."""
    try:
        import ctypes
        import gc
        gc.collect()
        ctypes.CDLL('libc.so.6').malloc_trim(0)
    except Exception:
        pass


def do_sprites(slug=None, parse_only=False, shard=None, shards=1):
    import datetime
    pool_bsv3 = sorted(POOL.glob('*.bsv3'))
    if parse_only:
        ok = fails = v3n = v1n = 0
        for f in pool_bsv3:
            try:
                r = parse_bsv3(f.read_bytes(), f.name)
            except Exception as e:
                fails += 1
                if fails <= 20:
                    print(f'  FAIL {f.name}: {type(e).__name__}: {e}')
                continue
            ok += 1
            if r['v'] == 3:
                v3n += 1
            else:
                v1n += 1
        print(f'parse-only: {ok}/{len(pool_bsv3)} bsv3 files parse to exact EOF'
              f'  (0x0103: {v1n}, 0x0303: {v3n})  failures: {fails}')
        return

    required = compute_required()
    # seasonal race winners -> base art before anything renders (see
    # resolve_seasons; a no-op once the pool is resolved). Shard 0 owns the
    # swap so parallel shards never race on the pool moves.
    if shard in (None, 0):
        resolve_seasons()
    out_dir = ROOT / 'web' / 'assets' / 'city'
    out_dir.mkdir(parents=True, exist_ok=True)
    # shard mode writes a private fragment; `sprites-merge` folds all
    # fragments into city-sprites.json (single writers avoid corruption)
    manifest_path = (out_dir / f'city-sprites-shard{shard}.json'
                     if shard is not None else out_dir / 'city-sprites.json')
    manifest = {}
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text())
        except ValueError:
            manifest = {}
    man = manifest.setdefault('sprites', {})

    if isinstance(slug, str):
        slug = [s for s in slug.split(',') if s]      # --slug a,b,c
    slugs = list(slug) if slug else sorted(required)
    if shard is not None:
        slugs = [s for i, s in enumerate(slugs) if i % shards == shard]
    rendered = v1 = v3 = nosrc = rgbonly = failed = 0
    tot_skipped = 0
    fail_list = []
    warn_list = []
    season_count = {}
    keep_season = set()
    for s in slugs:
        bsv3f = POOL / (s + '.bsv3')
        rgbf = POOL / (s + '.rgb')
        if not bsv3f.exists():
            if rgbf.exists():
                rgbonly += 1
            else:
                nosrc += 1
            continue
        try:
            e, warns, canvas = _render_sprite(
                s, bsv3f, rgbf, POOL, out_dir / f'{s}.png', f'{s}.png')
        except Exception as ex:
            failed += 1
            if len(fail_list) < 20:
                fail_list.append((s, f'{type(ex).__name__}: {ex}'))
            continue
        warn_list.extend(warns)
        if e is None:
            failed += 1
            if len(fail_list) < 20:
                fail_list.append((s, 'nothing drawable in static frame'))
            continue
        rendered += 1
        v1 += e['variant'] == '0103'
        v3 += e['variant'] == '0303'
        tot_skipped += e['skipped']
        base_md5 = _md5_bytes(canvas.tobytes())
        # season variants: byte-different archived re-ships (resolve has
        # also filed swapped-out seasonal mains into their class dirs)
        se = {}
        if SEASON.exists():
            for cls in SEASON_ORDER:
                cdir = SEASON / cls
                vrgb, vbs = cdir / (s + '.rgb'), cdir / (s + '.bsv3')
                if not vrgb.exists() and not vbs.exists():
                    continue
                rbs = vbs if vbs.exists() else bsv3f
                rrg = vrgb if vrgb.exists() else rgbf
                if rbs == bsv3f and rrg == rgbf:
                    continue
                if (not vbs.exists()
                        or vbs.read_bytes() == bsv3f.read_bytes()) \
                        and (not vrgb.exists()
                             or vrgb.read_bytes() == rgbf.read_bytes()):
                    continue     # archived copy is the base art verbatim
                spng = f'seasons/{cls}/{s}.png'
                try:
                    ve, vw, vcanvas = _render_sprite(
                        s, rbs, rrg, cdir, out_dir / spng, spng)
                except Exception:
                    continue
                warn_list.extend(vw)
                if ve is None or vcanvas is None or \
                        _md5_bytes(vcanvas.tobytes()) == base_md5:
                    (out_dir / spng).unlink(missing_ok=True)
                    continue     # re-encoded same pixels: not a season art
                ve['season'] = cls
                se[cls] = ve
                season_count[cls] = season_count.get(cls, 0) + 1
                keep_season.add(spng)
        if se:
            e['seasons'] = se
        man[s] = e
        if rendered % 250 == 0:
            print(f'  ...{rendered} rendered ({s})', flush=True)
            manifest['version'] = 1
            manifest['generated'] = datetime.date.today().isoformat()
            manifest['count'] = len(man)
            manifest_path.write_text(json.dumps(manifest, indent=1))
            _trim_malloc()
    if rendered or (slug and rendered == 0):
        manifest['version'] = 1
        manifest['generated'] = datetime.date.today().isoformat()
        manifest['count'] = len(man)
        manifest_path.write_text(json.dumps(manifest, indent=1))

    if not slug and shard is None:
        # stale season PNGs: only what the manifest references may stay
        sroot = out_dir / 'seasons'
        if sroot.exists():
            for p in sroot.glob('*/*.png'):
                if p.relative_to(out_dir).as_posix() not in keep_season:
                    p.unlink()
            for d in sroot.iterdir():
                if d.is_dir() and not any(d.iterdir()):
                    d.rmdir()

    files = [p for p in out_dir.rglob('*.png')]
    tot = sum(p.stat().st_size for p in files)
    print(f'sprites: slugs={len(slugs)} rendered={rendered} '
          f'(0x0103={v1}, 0x0303={v3})')
    if season_count:
        print(f'  season variants: '
              + '  '.join(f'{c}={n}' for c, n in
                          sorted(season_count.items(), key=lambda kv: -kv[1])))
    if not slug:
        print(f'  no rgb+bsv3 in pool: {nosrc}   rgb-only (no bsv3): {rgbonly}'
              f'   failed: {failed}')
    if fail_list:
        print('  failures:')
        for s, e in fail_list:
            print(f'    {s}: {e}')
    if warn_list:
        print(f'  warnings: {len(warn_list)}')
        for w in warn_list[:10]:
            print(f'    {w}')
    print(f'  output: {len(files)} png, {tot / 1e6:.1f} MB in {out_dir}')
    print(f'  manifest: {manifest_path} ({len(man)} sprites, '
          f'{tot_skipped} blocks skipped as global ids)')


# The road-bridge pieces: the engine's RoadDrawer stacks one deck cell and one
# strut cell per 4-tile segment, and neither slug is ever a building INSTANCE
# (no binfo/instance rows), so compute_required() never lists them and
# `sprites` would bake only their static frame. Frame indices are the bsv3
# Neutral range (bridgetop 0 = C_BridgeTop_05 arch, 5 = C_BridgeTop_09 far-end
# flat; bridgebottom 0 = C_BridgeBottom_02 far, 1 = C_BridgeBottom_03 arch).
BRIDGE_FRAMES = {'bridgetop': (0, 1, 2, 3, 4, 5, 6, 7), 'bridgebottom': (0, 1)}


def do_bridges():
    """Bake the engine-composited bridge pieces as their own manifest entries.

    Keys are `<slug>_f<frame>` and the anchors keep the raw bsv3 block-origin
    convention (no degenerate-pivot re-pin, no xml override): the pieces are
    placed by their own instance origin, which is where the bsv3 block origin
    sits, so the viewer's rule and tools/bridge-sites.py both work in that
    frame. Every frame ships because the road-bridge rule picks one by depth
    under the deck (deep piers vs abutment-length piers) and by end (the `g`
    frames add the grass abutment cell). See notes/09 §10.
    """
    import datetime
    out_dir = ROOT / 'web' / 'assets' / 'city'
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = out_dir / 'city-sprites.json'
    manifest = {}
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text())
        except ValueError:
            manifest = {}
    man = manifest.setdefault('sprites', {})
    n = 0
    for slug, frames in BRIDGE_FRAMES.items():
        bsv3f, rgbf = POOL / f'{slug}.bsv3', POOL / f'{slug}.rgb'
        if not bsv3f.exists() or not rgbf.exists():
            print(f'  MISSING {slug}: no bsv3/rgb in the pool')
            continue
        parsed = parse_bsv3(bsv3f.read_bytes(), slug)
        img = load_sheet(rgbf, slug)
        if parsed['v'] != 1:
            print(f'  {slug}: v{parsed["v"]} file, bridge rule fitted on v1')
        for fi in frames:
            if fi >= len(parsed['frames']):
                print(f'  {slug}: no frame {fi}')
                continue
            r = _composite(parsed, img, slug, parsed['frames'][fi])
            if r is None:
                print(f'  {slug} f{fi}: nothing drawable')
                continue
            canvas, ax, ay, drawn, skipped, rotmax = r
            key = f'{slug}_f{fi}'
            png = f'{key}.png'
            canvas.save(out_dir / png)
            man[key] = {
                'png': png, 'w': canvas.width, 'h': canvas.height,
                'anchor': [round(ax, 2), round(ay, 2)], 'pivot': 'bsv3',
                'variant': f'0{parsed["v"]}03', 'static': 'bsv3-frame',
                'cell': parsed['cells'][parsed['frames'][fi][0][0]][0]
                        if parsed['frames'][fi] else None,
                'blocks': drawn, 'skipped': skipped,
                'rotmax': round(rotmax, 4),
            }
            n += 1
            print(f'  {key}: {canvas.width}x{canvas.height} '
                  f'anchor ({ax:.2f}, {ay:.2f}) cell {man[key]["cell"]}')
    manifest['version'] = 1
    manifest['generated'] = datetime.date.today().isoformat()
    manifest['count'] = len(man)
    manifest_path.write_text(json.dumps(manifest, indent=1))
    print(f'bridges: {n} frame sprites -> {manifest_path.name} '
          f'({len(man)} sprites)')


def do_sprites_merge():
    """Fold every city-sprites-shard<N>.json fragment (written by parallel
    `sprites --shard I --shards N` runs) into city-sprites.json, prune stale
    season PNGs against the merged reference set, and remove the fragments."""
    import datetime
    out_dir = ROOT / 'web' / 'assets' / 'city'
    manifest_path = out_dir / 'city-sprites.json'
    manifest = {}
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text())
        except ValueError:
            manifest = {}
    man = manifest.setdefault('sprites', {})
    frags = sorted(out_dir.glob('city-sprites-shard*.json'))
    if not frags:
        print('sprites-merge: no shard fragments found')
        return
    for p in frags:
        j = json.loads(p.read_text())
        man.update(j.get('sprites', {}))
        p.unlink()
    keep = {v['png'] for e in man.values()
            for v in (e.get('seasons') or {}).values()}
    sroot = out_dir / 'seasons'
    stale = 0
    if sroot.exists():
        for p in sroot.glob('*/*.png'):
            if p.relative_to(out_dir).as_posix() not in keep:
                p.unlink()
                stale += 1
        for d in sroot.iterdir():
            if d.is_dir() and not any(d.iterdir()):
                d.rmdir()
    manifest['version'] = 1
    manifest['generated'] = datetime.date.today().isoformat()
    manifest['count'] = len(man)
    manifest_path.write_text(json.dumps(manifest, indent=1))
    print(f'sprites-merge: {len(frags)} fragments -> {manifest_path} '
          f'({len(man)} sprites), {stale} stale season pngs pruned')


# Save names whose character ships under a different asset stem (verified
# against the pack inventories: the .bcell file stem, e.g. abe_idle.bcell).
CHAR_ALIASES = {
    'grampa': 'abe',
    'cbguy': 'comicbookguy',
    'willy': 'willie',
}

# Resting-pose role preference: the at-rest loop, then plain idle, then a
# static pose, then walk (a still walk frame still beats a grey dot).
CHAR_ROLES = ('idle_standby', 'idle', '', 'walk')

# Idle-loop upgrade candidates: tried as <stem> + suffix, longest
# animation wins (see do_chars). '<name>_idle' in the core pack is a
# single pose; the blink/shift loops ship as separate cells.
CHAR_IDLE_SUFFIXES = ('idleblink', 'idleblinkleft', 'idleblinkright',
                      'idle', 'idleleft', 'idleright', 'idlestandby',
                      'standby', 'blink')
# stems carrying these words are locomotion/one-shot scenes, not in-place
# idles — they look wrong looping on a standing character
CHAR_MOTION_WORDS = ('walk', 'run', 'jog', 'dance', 'cheer', 'victory',
                     'pose')

# Role suffixes recognised when splitting '<stem>_<role>.bcell'.
CHAR_ROLE_SUFFIXES = ('idle_standby', 'idle', 'walk', 'cheer', 'dance',
                      'sleep', 'sit', 'work', 'greet', 'special')


def _char_norm(s):
    return ''.join(c for c in s.lower() if c.isalnum())


def _char_split_role(stem):
    """'<name>_<role>' -> (name_stem, role); ('<name>', '') when the
    stem carries no known role suffix."""
    low = stem.lower()
    for r in CHAR_ROLE_SUFFIXES:
        if low.endswith('_' + r):
            return stem[: -(len(r) + 1)], r
    return stem, ''


def _char_inventory():
    """normalized stem -> {'stem': display stem, 'roles': {role: source}},
    over the pool's .bcell cells (family packs, once the extract workers
    have run) plus the core game-100 pack's inline cells (stored in the
    core zip's nested inner zip — entry '1' is itself a zip). Pool entries
    are added first and win (setdefault). bcell13 cells (4.x event art,
    frames external in '<stem>_image_N.rgb' companions) are added last so
    a renderable bcell10 for the same stem+role always shadows them;
    their companions are harvested on demand at render time
    (_fetch_companions). bcell11 cells stay skipped here too — do_chars has no bcell11
     renderer; the dynamic endpoint (web/api/bcell.php) decodes them, and
     the `char-companions` subcommand harvests their companions for it."""
    import io
    import zipfile
    inv = {}
    handles = []

    def add(stem, role, source):
        key = _char_norm(stem)
        entry = inv.setdefault(key, {'stem': stem, 'roles': {}})
        entry['roles'].setdefault(role, source)

    deferred13 = []
    if POOL.exists():
        for p in sorted(POOL.glob('*.bcell')):
            try:
                with p.open('rb') as fh:
                    magic = fh.read(7)
            except OSError:
                continue
            if magic == b'bcell10':
                stem, role = _char_split_role(p.name[: -len('.bcell')])
                add(stem, role, ('file', p, None))
            elif magic == b'bcell13':
                deferred13.append((p, _char_split_role(
                    p.name[: -len('.bcell')])))
    if CORE_ZIP.exists():
        z = zipfile.ZipFile(CORE_ZIP)
        handles.append(z)
        inner = zipfile.ZipFile(io.BytesIO(z.read('1')))
        handles.append(inner)
        for n in inner.namelist():
            base = os.path.basename(n)
            if not base.lower().endswith('.bcell'):
                continue
            stem, role = _char_split_role(base[: -len('.bcell')])
            add(stem, role, ('zip', inner, n))
    # last so a renderable bcell10 (pool or core) always shadows a
    # bcell13 for the same stem+role
    for p, (stem, role) in deferred13:
        add(stem, role, ('bcell13', p, None))
    return inv, handles


# ------------------------------------------------------- bcell13 companions
#
# bcell13 cells reference their frames as external '<stem>_image_N.rgb'
# files in the same pack. The full 4.x companion set is ~165k distinct
# files (several GB) — far too much for the tmpfs pool — so the frames a
# chosen cell actually needs are harvested ON DEMAND, batched per family
# pack (one 7z + unzip per family), and persisted into the pool so later
# runs read them straight off disk.

_BCELL_INDEX = None          # bcell stem -> (fam, pack), lazily built


def _bcell_index():
    """bcell stem -> (fam, pack) for the copy the pool harvest kept.
    Reads the workers' index_*.tsv keep lines ('bcell<TAB>base<TAB>fam
    <TAB>pack'); the first line for a stem is the pack that won."""
    global _BCELL_INDEX
    if _BCELL_INDEX is None:
        _BCELL_INDEX = {}
        for log in sorted(POOL.glob('index_*.tsv')):
            try:
                for line in open(log):
                    parts = line.rstrip('\n').split('\t')
                    if len(parts) == 4 and parts[0] == 'bcell':
                        stem = parts[1]
                        if stem.endswith('.bcell'):
                            stem = stem[: -len('.bcell')]
                        _BCELL_INDEX.setdefault(stem.lower(),
                                                (parts[2], parts[3]))
            except OSError:
                pass
    return _BCELL_INDEX


def _fetch_companions(need_by_fam):
    """Fetch '<stem>_image_N.rgb' companion files into the pool.
    need_by_fam: family -> set of companion basenames. Returns the number
    of files newly written (0 when everything already lives in the pool
    or no family resolves)."""
    import zipfile
    fams = load_families()
    got = 0
    for fam, names in sorted(need_by_fam.items()):
        ent = fams.get(fam)
        if ent is None:
            continue
        work = WORK_BASE / 'lazy' / re.sub(r'[^A-Za-z0-9_.-]', '_', fam)
        shutil.rmtree(work, ignore_errors=True)
        try:
            zpath = open_inner_zip(work, ent[0], ent[1])
            if zpath is None:
                continue
            z = zipfile.ZipFile(zpath)
            want = {}
            for n in z.namelist():
                base = os.path.basename(n).lower()
                if base.endswith('.rgb') and base not in want:
                    want[base] = n
            for name in sorted(names):
                if (POOL / name).exists():
                    continue
                zn = want.get(name)
                if zn is None:
                    continue
                tmp = POOL / (name + '.part')
                tmp.write_bytes(z.read(zn))
                tmp.rename(POOL / name)
                got += 1
            z.close()
        except (OSError, zipfile.BadZipFile):
            pass
        shutil.rmtree(work, ignore_errors=True)
    return got


def do_char_companions():
    """Harvest the '_image_N.rgb' companions the dynamic character endpoint
    (web/api/bcell.php, src=pool) needs, so placed characters render instead
    of the red wireframe. External-companion cells store their frames in
    '<stem>_image_N.rgb' beside the cell (see extract_assets.parse_bcell11 /
    parse_bcell13). Two sets are pulled:

      1. EVERY bcell11 cell in the pool. do_chars renders only bcell10/
         bcell13 and SKIPS bcell11, so those companions never enter the pool
         any other way (e.g. slug 'homeridleblink' -> homer_idle_blink, the
         character #3 idle, decoded but failed 'missing companion').

      2. The external-companion cell each PLACED-CHARACTER slug resolves to,
         resolved here exactly the way web/api/bcell.php pool_source() does
         (exact stem, then alphanumeric slug_key, then the idle-suffix
         fallback mirroring CHAR_IDLE_SUFFIXES). do_chars baked many core
         characters (Marge/Abe/Moe/Krusty idles) from a self-contained CORE
         bcell10 twin, so the pool's bcell13 twin — the cell the endpoint
         actually reads — had its companions never fetched.

    Companions already in the pool are skipped; the rest are pulled per
    family pack (idempotent).

    The first pass reuses _fetch_companions (the same pass do_chars uses).
    But load_families() keeps only each family's FIRST candidate row, and for
    the 2025 re-pack families that row is a 47KB stub carrying the tiny .bcell
    but NOT the multi-MB .rgb art — its sibling revision zip does. So whatever
    the first pass could not satisfy is retried across EVERY candidate inner
    zip of the cell's .7z BUNDLE, stopping once the needed set is complete.
    Grouping by bundle (not by the index family key) is deliberate: a cell can
    be kept under a partial re-pack family (e.g. XMAS2013CharacterGame-100-
    r57598) while its full art lives in a SIBLING family sharing the same .7z
    (the plain XMAS2013CharacterGame-100 r146180) — load_rows() documents the
    same sibling-revision recovery for the building fill pass."""
    import json as _json
    import zipfile
    from extract_assets import parse_bcell11, parse_bcell13
    idx = _bcell_index()
    need = {}          # family -> {companion basenames}   (for _fetch_companions)
    need_by_pack = {}  # .7z bundle -> {basenames}          (for the fallback)
    handled = set()    # pool stems (lower) we've queued companions for

    def queue(stem, blob, magic):
        """Queue stem's still-missing frame companions into need/need_by_pack."""
        ent = idx.get(stem.lower())
        if ent is None:
            return                        # no pool-keep family row -> unfetchable
        parse = parse_bcell11 if magic == b'bcell11' else parse_bcell13
        try:
            recs = parse(blob, stem + '.bcell')
        except Exception:
            return
        for rec in recs:                  # rec = (delay, x_off, y_off, image_name)
            fn = rec[3].lower()
            if not (POOL / fn).exists():
                need.setdefault(ent[0], set()).add(fn)
                need_by_pack.setdefault(ent[1], set()).add(fn)
        handled.add(stem.lower())

    # (1) every bcell11 cell the pool holds
    for p in sorted(POOL.glob('*.bcell')):
        try:
            with p.open('rb') as fh:
                magic = fh.read(7)
                if magic != b'bcell11':
                    continue
                fh.seek(0)
                blob = fh.read()
        except OSError:
            continue
        queue(p.name[: -len('.bcell')], blob, magic)

    # (2) the external-companion cell each placed-character slug resolves to,
    # mirroring pool_source()'s resolution in web/api/bcell.php exactly
    by_key = {}
    for st in sorted(p.name[: -len('.bcell')] for p in POOL.glob('*.bcell')):
        by_key.setdefault(_char_norm(st), st)      # first sorted match wins

    def resolve(name):
        if (POOL / (name + '.bcell')).exists():
            return name
        st = by_key.get(_char_norm(name))
        if st:
            return st
        for sfx in CHAR_IDLE_SUFFIXES:
            st = by_key.get(_char_norm(name + '_' + sfx))
            if st:
                return st
        return None

    cpath = ROOT / 'web' / 'assets' / 'characters' / 'characters.json'
    slugs = set()
    if cpath.is_file():
        try:
            chars = _json.loads(cpath.read_text()).get('characters', {})
            slugs = {v['slug'] for v in chars.values() if v.get('slug')}
        except (OSError, ValueError):
            slugs = set()
    for slug in sorted(slugs):
        stem = resolve(slug)
        if stem is None or stem.lower() in handled:
            continue
        try:
            with (POOL / (stem + '.bcell')).open('rb') as fh:
                magic = fh.read(7)
                if magic not in (b'bcell11', b'bcell13'):
                    continue
                fh.seek(0)
                blob = fh.read()
        except OSError:
            continue
        queue(stem, blob, magic)

    total = sum(len(v) for v in need.values())
    fetched = _fetch_companions(need)

    # second pass: companions the first pass could not satisfy (a stub first
    # row, or the art kept under a sibling family in the same bundle). Retry
    # them across every inner zip of each .7z bundle until the set is complete.
    still = {}
    for pack, names in need_by_pack.items():
        miss = {n for n in names if not (POOL / n).exists()}
        if miss:
            still[pack] = miss
    if still:
        bundle_inners = {}
        for _fam, pack, inner, _size in load_rows():
            inners = bundle_inners.setdefault(pack, [])
            if inner not in inners:
                inners.append(inner)
        for pack, missing in sorted(still.items()):
            remaining = set(missing)
            for inner in sorted(bundle_inners.get(pack, []), reverse=True):
                if not remaining:
                    break
                work = WORK_BASE / 'lazy11' / re.sub(r'[^A-Za-z0-9_.-]',
                                                     '_', pack)
                shutil.rmtree(work, ignore_errors=True)
                try:
                    zpath = open_inner_zip(work, pack, inner)
                    if zpath is None:
                        continue
                    z = zipfile.ZipFile(zpath)
                    want = {}
                    for n in z.namelist():
                        base = os.path.basename(n).lower()
                        if base.endswith('.rgb') and base not in want:
                            want[base] = n
                    for name in sorted(remaining):
                        if (POOL / name).exists():
                            remaining.discard(name)
                            continue
                        zn = want.get(name)
                        if zn is None:
                            continue
                        tmp = POOL / (name + '.part')
                        tmp.write_bytes(z.read(zn))
                        tmp.rename(POOL / name)
                        fetched += 1
                        remaining.discard(name)
                    z.close()
                except (OSError, zipfile.BadZipFile):
                    pass
                finally:
                    shutil.rmtree(work, ignore_errors=True)

    left = sum(1 for v in need.values() for n in v
               if not (POOL / n).exists())
    print(f'char-companions: {len(handled)} external-companion cells, '
          f'{total} companions needed, {fetched} fetched into {POOL}'
          + (f' ({left} still missing)' if left else ''))


def _dedup_built(built):
    """collapse frames that render identically (2026-10-23): the packs
    repeat the same image over several ticks, and blink loops' eyes-open
    ticks are byte-for-byte copies of frame 0 — those shipped to disk as
    duplicate '<slug>_1/_2.png' files faking a motion that never changed.
    Repeats merge into the kept frame with their delay added; a trailing
    repeat of frame 0 merges into the LEADING frame, since the player
    cycles the loop and the wall-clock hold is the same."""
    if len(built) < 2:
        return built
    out = []                                # [(delay, x, y, im, sig)]
    for (delay, x, y, im) in built:
        sig = hashlib.md5(im.tobytes()).hexdigest()
        if out and sig == out[-1][4] and (x, y) == (out[-1][1], out[-1][2]):
            prev = out[-1]
            out[-1] = (prev[0] + delay, prev[1], prev[2], prev[3], prev[4])
            continue
        out.append((delay, x, y, im, sig))
    if len(out) > 1 and out[0][4] == out[-1][4] and \
            (out[0][1], out[0][2]) == (out[-1][1], out[-1][2]):
        first = out[0]
        out[0] = (first[0] + out[-1][0],) + tuple(first[1:])
        out.pop()
    return [(d, x, y, _im) for (d, x, y, _im, _s) in out]


def do_chars():
    """Character idle sprites for every distinct character the save
    instantiates, from .bcell animation cells. Each '<name>_<role>.bcell'
    holds frames as records (delay, x_off, y_off, block) placed relative
    to the character anchor (0,0 = feet on the ground line), so the
    canvas is the union bbox of the frames and the anchor is
    (-min_x, -min_y) in canvas pixels.

    Save names (data/character_ids.json) are matched to asset stems by
    exact, then unique-prefix, then unique-contains normalized matching,
    plus CHAR_ALIASES for assets shipped under a different name (Grampa
    -> abe, CBGuy -> comicbookguy, Willy -> willie). Characters with no
    asset in any scanned pack stay grey dots in City View.

    Idle-loop upgrade (2026-10-23): the core pack's '<name>_idle' bcell
    is a single 666 ms pose — the real animated idle lives in separate
    '<name>idleblink'-style cells (pool only). A matched base whose frames
    are static is therefore upgraded to an animated variant: first the
    stem + a known idle suffix, then any stem containing the save name
    AND 'idle'/'blink' (no walk/run/dance words — in-place loops only).
    'Static' and 'most frames' are judged by PIXEL content
    (pix_distinct): many bcell13 cells repeat one image across their
    ticks, and counting frame references called that an animation —
    43 assets shipped byte-identical PNGs and never moved on the map.
    Duplicate ticks are also collapsed at render time (_dedup_built),
    so a cell that only repeats one pose ships ONE png instead of three
    copies of it; the blink loops' eyes-open tick merges into frame 0.

    Family-pack cells come from the pool, so run the extract workers
    first for full coverage (they keep *.bcell alongside the required
    building assets); without a pool this degrades to the core pack set.
    Writes web/assets/characters/<slug>*.png + characters.json:
    assets keyed by asset stem, characters keyed by save id (the M3
    defID lookup), unmatched names listed for triage."""
    import datetime
    from extract_assets import parse_bcell, parse_bcell13, _unpremul4444

    inv, handles = _char_inventory()
    out_dir = ROOT / 'web' / 'assets' / 'characters'
    out_dir.mkdir(parents=True, exist_ok=True)

    def find(norm):
        norm = CHAR_ALIASES.get(norm, norm)
        if norm in inv:
            return norm

        def pick_tied(cands):
            # longest-first; ties (happylittleelf02../03..,
            # traincarriagecarriage105/255) prefer the cell whose pixels
            # the pool can actually hydrate — an unshipped bcell13 twin
            # scores 0 and would lose the character to a dot — then
            # lexicographic max so runs stay deterministic
            top = max(len(p) for p in cands)
            return max(sorted(p for p in cands if len(p) == top),
                       key=lambda p: (
                           1 if pix_distinct(frames_of(inv[p])[1]) else 0,
                           p))
        if len(norm) >= 4:
            cands = {p for p in inv
                     if p.startswith(norm) or norm.startswith(p)}
            if cands:
                return pick_tied(cands)
        if len(norm) >= 5:
            cands = {p for p in inv
                     if len(p) >= 4 and (norm in p or p in norm)}
            if cands:
                return pick_tied(cands)
        return None

    def frames_of(entry):
        """(role, frames) for one inventory entry. Frames are unified
        tuples (delay, x, y, scale, src): bcell10 inline blocks carry
        src=('px', w, h, bytes) with scale 1.0; bcell13 records carry
        src=('rgb', companion-basename) with the frame's stored i16
        (x_off, y_off) placement at scale 1.0 (its layer floats are
        SHADOW/POSITION/INDICATOR overlay transforms only — see
        extract_assets.parse_bcell13). The bcell13 geometry comes from
        the cell alone, so choose() (frame counting) never touches
        companion pixels — those hydrate at render time via
        frame_pil()."""
        for role in CHAR_ROLES:
            src = entry['roles'].get(role)
            if src is None:
                continue
            kind, a, b = src
            try:
                blob = a.read_bytes() if kind in ('file', 'bcell13') \
                    else a.read(b)
            except Exception:
                continue
            if kind == 'bcell13':
                try:
                    recs = parse_bcell13(blob, str(a))
                except Exception:
                    continue
                frames = []
                for (delay, x, y, name) in recs:
                    if not math.isfinite(delay) or delay < 0:
                        delay = 0.0
                    frames.append((delay, float(x), float(y), 1.0,
                                   ('rgb', name.lower())))
                if frames:
                    return role, frames
                continue
            try:
                r10, blocks = parse_bcell(blob, str(b or a))
            except Exception:
                continue
            frames = []
            for delay, xoff, yoff, bi in r10:
                if not (0 <= bi < len(blocks)):
                    continue
                w, h, px = blocks[bi]
                if w < 1 or h < 1 or w * h > 4_000_000:
                    continue
                frames.append((delay if (delay and math.isfinite(delay))
                               else 0.0,
                               float(xoff), float(yoff), 1.0,
                               ('px', w, h, px)))
            if frames:
                return role, frames
        return None, []

    cids = load_json('character_ids.json')
    assets = {}
    chars = {}
    unmatched = set()
    cache = {}

    rgb_hash = {}                         # companion basename -> content hash

    def pix_distinct(frames):
        """distinct actually-rendered frames: the number of distinct
        (image content, scale) pairs that are present to render. Counting
        frame SOURCES lied — a bcell13 cell may repeat the same
        '_image_N.rgb' across several ticks (AdvisorFrink_Idle's three
        ticks are all image_1) or ship the identical image under different
        companion names, and both looked 'animating'. A companion the
        prefetch could not harvest can never hydrate either (frame_pil
        drops it), so an absent file contributes NO frame rather than a
        distinct one — an unrenderable cell scores 0 and loses the pick
        to a cell the map can actually show."""
        keys = set()
        for _d, _x, _y, scale, src in frames:
            if src[0] == 'px':
                keys.add(('px', src[1], src[2],
                          hashlib.md5(src[3]).hexdigest(), round(scale, 3)))
            else:
                if src[1] in rgb_hash:
                    h = rgb_hash[src[1]]
                    if h is None:
                        continue            # never harvested (cached miss)
                else:
                    try:
                        h = hashlib.md5((POOL / src[1]).read_bytes()).hexdigest()
                    except OSError:
                        rgb_hash[src[1]] = None
                        continue            # companion never harvested
                    rgb_hash[src[1]] = h
                keys.add(('rgb', h, round(scale, 3)))
        return len(keys)

    def candidates(hit, nm):
        """(base|None, suffix_candidates, contains_candidates) for a
        matched base stem — the cells choose() competes; frames are read
        but companion pixels need not exist yet (see pass 1)."""
        role, frames = frames_of(inv[hit])

        def harvest(cands):
            got = []
            for k in cands:
                if k not in inv:
                    continue
                r2, f2 = frames_of(inv[k])
                if f2:
                    got.append((k, r2, f2))
            return got

        sfx_cands = [hit + s for s in CHAR_IDLE_SUFFIXES]
        if len(nm) >= 4 and nm != hit:
            sfx_cands += [nm + s for s in CHAR_IDLE_SUFFIXES]
        # NO cap on the contains list: 'zombie''s best art sits past the
        # 12th sorted candidate and the truncation cost real assets
        cont_cands = (sorted(k for k in inv
                             if (nm in k or k in nm)
                             and ('idle' in k or 'blink' in k))
                      if len(nm) >= 4 else [])
        return ([(hit, role, frames)] if frames else [],
                harvest(sfx_cands), harvest(cont_cands))

    def choose(hit, nm, base, sfx, cont):
        """(stem, role, frames) to render for a matched base stem: the
        base itself, upgraded to an animated idle variant when possible
        (see do_chars docstring). Priority: a dedicated <stem/name>+idle
        suffix cell (>=2 PIXEL-distinct frames) > the base when it
        already animates in place > any idle/blink cell referencing the
        name > the base. 'animating' means pix_distinct() >= 2: cells
        that repeat one image over several ticks no longer qualify, so
        they stop shadowing a real blink variant — and pass 3 collapses
        their duplicate PNGs to a single honest pose."""

        def ok(k):
            return k != hit and not any(w in k for w in CHAR_MOTION_WORDS)

        def best_of(group):
            best = None
            for k, r2, f2 in group:
                if not ok(k):
                    continue
                n2 = pix_distinct(f2)
                bn = pix_distinct(best[2]) if best else 0
                if (n2 >= 2 and (best is None or n2 > bn
                                 or (n2 == bn and len(k) < len(best[0])))):
                    best = (k, r2, f2)
            return best

        def renderable_once(group):
            # nothing animates anywhere: a still variant whose pixels the
            # pool actually has beats a base whose bcell13 companions
            # never shipped — that one renders as no asset at all and the
            # character stays a dot on the map
            for k, r2, f2 in group:
                if ok(k) and pix_distinct(f2) >= 1:
                    return (k, r2, f2)
            return None

        if not base:
            return (best_of(sfx) or best_of(cont)
                    or renderable_once(sfx + cont))
        stem, role, frames = base[0]
        if role in ('idle', 'idle_standby') and pix_distinct(frames) > 1:
            return base[0]
        return (best_of(sfx)
                or (base[0] if pix_distinct(frames) > 1 and ok(stem) else None)
                or best_of(cont)
                or renderable_once(sfx + cont)
                or base[0])

    # Pass 1 — list each save character's candidate cells and harvest the
    # bcell13 companions ANY candidate references. The pixel-distinct
    # frame count that decides the pick reads companion images, so the
    # fetch must precede the choice — otherwise the same image shipped
    # under repeat tick names masquerades as an animation. Files already
    # in the pool cost nothing; the index is keyed by the pool cell's raw
    # stem (candidates work in normalized keys).
    need = {}
    idx = _bcell_index()

    def collect(cand):
        stem, role, frames = cand
        src = inv[stem]['roles'].get(role)
        if not src or src[0] != 'bcell13':
            return
        ent = idx.get(src[1].name[: -len('.bcell')].lower())
        if ent is None:
            return
        for f in frames:
            if f[4][0] == 'rgb' and not (POOL / f[4][1]).exists():
                need.setdefault(ent[0], set()).add(f[4][1])

    order = []
    pending = []
    for cid in sorted(cids, key=int):
        name = cids[cid]
        hit = find(_char_norm(name))
        if hit is None:
            unmatched.add(name)
            continue
        if hit not in cache:
            cache[hit] = candidates(hit, _char_norm(name))
            for group in cache[hit]:
                for c in group:
                    collect(c)
        pending.append((cid, name, hit))
    fetched = _fetch_companions(need)

    # Pass 2 — the companion bytes are in the pool: finalise the pick per
    # base stem (cache entries become the (stem, role, kind, frames)
    # tuple pass 3 renders; characters sharing a base resolve once).
    for cid, name, hit in pending:
        sel = cache[hit]
        if sel is None:
            unmatched.add(name)
            continue
        if len(sel) == 4:                   # already finalised (shared hit)
            order.append((cid, name, hit))
            continue
        got = choose(hit, _char_norm(name), *sel)
        if not got or not got[2]:
            cache[hit] = None
            unmatched.add(name)
            continue
        stem, role, frames = got
        kind = inv[stem]['roles'][role][0]
        cache[hit] = (stem, role, kind, frames)
        order.append((cid, name, hit))

    # Pass 3 — render each chosen cell: hydrate frames, float union bbox
    # over the placed frames, anchor = the cell's engine origin (0, 0)
    # — the same feet-on-ground convention the bcell10 path uses.
    img_cache = {}

    def frame_pil(src, scale):
        if src[0] == 'px':
            _, w, h, px = src
            try:
                im = Image.frombytes('RGBA', (w, h), _unpremul4444(px))
            except Exception:
                return None
        else:
            im = img_cache.get(src[1])
            if im is None:
                try:
                    rw, rh, _bpp, rgba, _pm = rgb_to_rgba(
                        (POOL / src[1]).read_bytes(), src[1])
                    im = Image.frombytes('RGBA', (rw, rh), rgba)
                except Exception:
                    im = False
                img_cache[src[1]] = im
                # families hydrate ~10x the cells of a pick-only run: the
                # companion images must not all pile up in RAM at once
                if len(img_cache) > 3000:
                    img_cache.clear()
            if im is False:
                return None
        if scale != 1.0:
            im = im.resize((max(1, round(im.width * scale)),
                            max(1, round(im.height * scale))),
                           Image.LANCZOS)
        return im

    rendered = {}
    for cid, name, hit in order:
        stem, role, kind, frames = cache[hit]
        if stem in rendered:
            asset = rendered[stem]
        else:
            built = []
            for (delay, x, y, scale, src) in frames:
                im = frame_pil(src, scale)
                if im is not None:
                    built.append((delay, x, y, im))
            built = _dedup_built(built)
            if built:
                min_x = min(b[1] for b in built)
                min_y = min(b[2] for b in built)
                max_x = max(b[1] + b[3].width for b in built)
                max_y = max(b[2] + b[3].height for b in built)
                cw = max(1, math.ceil(max_x - min_x))
                ch = max(1, math.ceil(max_y - min_y))
                out_frames = []
                for i, (delay, x, y, im) in enumerate(built):
                    canvas = Image.new('RGBA', (cw, ch))
                    canvas.paste(im, (round(x - min_x), round(y - min_y)))
                    fname = (f'{stem}.png' if i == 0
                             else f'{stem}_{i}.png')
                    canvas.save(out_dir / fname)
                    out_frames.append({'file': fname, 'delay': delay})
                asset = {
                    'png': f'{stem}.png', 'w': cw, 'h': ch,
                    'anchor': [round(-min_x, 2), round(-min_y, 2)],
                    'role': role, 'frames': out_frames,
                }
            else:
                asset = None
            rendered[stem] = asset
        if asset is None:
            unmatched.add(name)
            continue
        assets[stem] = asset
        chars[cid] = {'name': name, 'slug': stem}

    # Pass 4 — families (2026-10-27): ship EVERY pool cell of a mapped
    # character (walks, taps/actions, outfits), not just the map idle.
    # Each inventory cell is owned by the LONGEST catalog name (or
    # CHAR_ALIASES target — the asset stem a save name ships under) its
    # normalized stem starts with. A character's card shows its own cells
    # PLUS every cell owned by a catalog name that extends its own
    # ('homer' also gets 'homerlizard…' cells), so outfits surface under
    # the base character while cataloged twins keep their own complete
    # card too. 3-letter prefixes own only where the map actually has art
    # (a bare 'lou' must not swallow 'louie…'). Cells nobody owns are
    # listed in the manifest for triage. Frames share the flat PNG
    # namespace in out_dir; per-character sidecars under families/ keep
    # the boot manifest lean (the viewer fetches one when a card opens).
    fam_dir = out_dir / 'families'
    fam_dir.mkdir(exist_ok=True)

    FAM_DIRS = ('left', 'right', 'front', 'back')
    FAM_KIND_WORDS = (
        ('idle', 'idle'), ('blink', 'idle'), ('standby', 'idle'),
        ('walk', 'walk'), ('run', 'walk'), ('trot', 'walk'),
        ('jog', 'walk'),
        ('cheer', 'action'), ('dance', 'action'), ('victory', 'action'),
        ('pose', 'action'), ('active', 'action'))
    FAM_TRIM_TAIL = ('idle', 'blink', 'idleblink', 'standby', 'walk',
                     'run', 'cheer', 'dance', 'active', 'special', 'greet',
                     'work', 'sit', 'sleep', 'victory', 'pose')

    def cell_kind(key, distinct):
        for w, kind in FAM_KIND_WORDS:
            if w in key:
                return 'standby' if distinct <= 1 else kind
        if distinct >= 2:
            return 'action'
        return 'standby' if distinct == 1 else 'misc'

    def cell_dir(key):
        for d in FAM_DIRS:
            if key.endswith(d):
                return d
        return ''

    def outfit_words(disp, key, nm):
        """Costume/action label: the cell's words minus the character's
        name and minus trailing role/direction words — e.g.
        bart_beelzebart_idle_blink -> 'beelzebart',
        homerlizardidleblink (nm='homer') -> 'lizard'. Underscored
        display stems keep their word breaks; glued stems return the
        trimmed remainder as one word."""
        toks = [t for t in disp.lower().replace(' ', '_').split('_') if t]
        if len(toks) > 1:
            acc = ''
            while len(toks) > 1:
                t = _char_norm(toks[0])
                if not t or not key.startswith(acc + t):
                    break
                acc += t
                toks.pop(0)
            while toks and (_char_norm(toks[-1]) in FAM_TRIM_TAIL or
                            _char_norm(toks[-1]) in FAM_DIRS or
                            _char_norm(toks[-1]).isdigit()):
                toks.pop()
            return ' '.join(t for t in (_char_norm(x) for x in toks) if t)
        rest = key[len(nm):] if key.startswith(nm) else key
        while rest:
            for w in ('idleblink', 'standby', 'left', 'right', 'front',
                      'back', 'idle', 'blink', 'walk', 'run', 'cheer',
                      'dance', 'victory', 'pose'):
                if rest.endswith(w):
                    rest = rest[:-len(w)]
                    break
            else:
                if rest and rest[-1].isdigit():
                    rest = rest[:-1]
                    continue
                break
        return rest

    # ownership: prefixes the save cast can claim (name + alias target)
    cid_prefixes = {}                # cid -> usable prefix set
    for cid, name in cids.items():
        nm = _char_norm(name)
        pre = {nm} if nm else set()
        al = CHAR_ALIASES.get(nm)
        if al:
            pre.add(al)
        pre = {p for p in pre if p and len(p) >= 3 and
               (len(p) > 3 or cid in chars)}
        if pre:
            cid_prefixes[cid] = pre
    owner_of = {}                    # prefix -> owning cid (lowest id wins)
    for cid in sorted(cid_prefixes, key=int):
        for p in cid_prefixes[cid]:
            owner_of.setdefault(p, cid)
    usable = sorted(owner_of, key=lambda s: (-len(s), s))
    owners = {}                      # inv key -> owning prefix
    loose = []
    for key in inv:
        for p in usable:
            if key.startswith(p):
                owners[key] = p
                break
        else:
            loose.append(key)

    # prefetch the bcell13 companions EVERY owned cell references (the
    # pass-1 fetch only covered the chosen map idles), thinning absurdly
    # long cells evenly to 64 frames first (endpoints kept)
    fam_frames = {}                  # key -> (role, frames)
    need_f = {}
    for key in owners:
        role, frames = frames_of(inv[key])
        if len(frames) > 64:
            frames = [frames[i] for i in _sample_range(0, len(frames) - 1, 64)]
        if not frames:
            continue
        fam_frames[key] = (role, frames)
        src = inv[key]['roles'].get(role)
        if src and src[0] == 'bcell13':
            ent = idx.get(src[1].name[: -len('.bcell')].lower())
            if ent is not None:
                for f in frames:
                    if f[4][0] == 'rgb' and not (POOL / f[4][1]).exists():
                        need_f.setdefault(ent[0], set()).add(f[4][1])
    fetched_f = _fetch_companions(need_f)

    # render every owned cell once (pass 3's pick reuses via `rendered`)
    fam_cell = {}                    # key -> metadata entry (no outfit)
    fam_rendered = 0
    for key in sorted(owners):
        disp = inv[key]['stem']
        role, frames = fam_frames.get(key, ('', []))
        entry = {'key': key, 'stem': disp, 'role': role,
                 'dir': cell_dir(key)}
        if key in rendered and rendered[key] is not None:
            a = rendered[key]
        elif frames:
            built = []
            for (delay, x, y, scale, src) in frames:
                im = frame_pil(src, scale)
                if im is not None:
                    built.append((delay, x, y, im))
            built = _dedup_built(built)
            if built:
                min_x = min(b[1] for b in built)
                min_y = min(b[2] for b in built)
                max_x = max(b[1] + b[3].width for b in built)
                max_y = max(b[2] + b[3].height for b in built)
                cw = max(1, math.ceil(max_x - min_x))
                ch = max(1, math.ceil(max_y - min_y))
                out_frames = []
                for i, (delay, x, y, im) in enumerate(built):
                    canvas = Image.new('RGBA', (cw, ch))
                    canvas.paste(im, (round(x - min_x), round(y - min_y)))
                    fname = (f'{key}.png' if i == 0 else f'{key}_{i}.png')
                    canvas.save(out_dir / fname)
                    out_frames.append({'file': fname, 'delay': delay})
                a = {'png': f'{key}.png', 'w': cw, 'h': ch,
                     'anchor': [round(-min_x, 2), round(-min_y, 2)],
                     'frames': out_frames}
            else:
                a = None
            rendered[key] = a        # shared across characters AND reruns
        else:
            a = None
        if a:
            fam_rendered += 1
            entry['png'] = a['png']
            entry['w'] = a['w']
            entry['h'] = a['h']
            entry['anchor'] = a['anchor']
            entry['frames'] = a['frames']
            entry['ms'] = round(sum(fr['delay'] or 100
                                    for fr in a['frames']), 1)
        else:
            entry['frames'] = []
            entry['reason'] = 'no-frames' if not frames else 'no-pixels'
        entry['kind'] = cell_kind(
            key, pix_distinct(frames) if frames else 0)
        fam_cell[key] = entry

    # one sidecar per save character: own cells + the cells of every
    # catalog prefix that extends one of its prefixes (outfits/actions)
    fam_keep = set()
    fam_written = set()
    for cid in sorted(cids, key=int):
        if cid not in chars:
            continue
        my = sorted(cid_prefixes.get(cid, ()), key=len, reverse=True)
        mine = [k for k, p in owners.items()
                if any(p == px or p.startswith(px) for px in my)]
        cells = []
        for k in sorted(mine):
            e = fam_cell[k]
            px = next((p for p in my if k.startswith(p)), my[0] if my else '')
            entry = dict(e)
            entry['outfit'] = outfit_words(e['stem'], k, px)
            cells.append(entry)
            if e.get('png'):
                fam_keep.add(e['png'])
                fam_keep.update(fr['file'] for fr in e['frames'])
        side = {'cid': cid, 'name': cids[cid], 'cells': cells}
        sp = fam_dir / (cid + '.json')
        sp.write_text(json.dumps(side))
        fam_written.add(sp.name)
    for p in fam_dir.glob('*.json'):
        if p.name not in fam_written:
            p.unlink()

    for h in handles:
        try:
            h.close()
        except Exception:
            pass

    manifest = {
        'version': 4,
        'generated': datetime.date.today().isoformat(),
        'assets': dict(sorted(assets.items())),
        'characters': chars,
        'unmatched': sorted(unmatched),
        'count': len(chars),
        'familyCells': len(owners),
        'familyRendered': fam_rendered,
        'unmatchedCells': sorted(loose),
    }
    manifest_path = out_dir / 'characters.json'
    manifest_path.write_text(json.dumps(manifest, indent=1))
    # drop PNGs no manifest entry references any more: dedup retired the
    # byte-identical '_1/_2' copies, and re-runs change the picks — the
    # directory should only hold what the map actually loads
    keep = {a['png'] for a in assets.values()}
    keep.update(fr['file'] for a in assets.values() for fr in a['frames'])
    keep |= fam_keep                 # family sidecar frames stay on disk too
    stale = sum(1 for p in out_dir.glob('*.png') if p.name not in keep)
    for p in out_dir.glob('*.png'):
        if p.name not in keep:
            p.unlink()
    print(f'chars: {len(chars)}/{len(cids)} save characters -> '
          f'{len(assets)} rendered assets '
          f'({len(unmatched)} names unmatched, {stale} stale pngs pruned)')
    print(f'  families: {fam_rendered}/{len(owners)} owned cells rendered, '
          f'{len(loose)} loose cells, {len(fam_written)} sidecars')
    if fetched or need:
        print(f'  companions: {fetched} bcell13 frame images fetched '
              f'from {len(need)} family packs')
    if fetched_f or need_f:
        print(f'  family companions: {fetched_f} fetched from '
              f'{len(need_f)} family packs')
    print(f'  output: {out_dir}')
    print(f'  manifest: {manifest_path}')


# ---------------------------------------------------------------- flags
# The SoccerCup2015 DLC ships one waving-cloth bsv3 per nation
# (flag_sweden, flag_cameroon, …): the engine composites flag_<country>
# on top of the shared Flag_Pole asset, so bids like SwedenFlag draw a
# bare pole until the cloth joins the pool. The main extract pass only
# walks *Game-100* families, so these never landed. `flags` pulls them
# from the local cdn/ bundle and bakes web/assets/city/flags/<stem>.png
# + city-flags.json (the manifest the viewer overlay and
# web/api/bsprite.php kind=flag read; it is deliberately separate from
# city-sprites.json — the cloths are not standalone buildings).

def do_flags():
    POOL.mkdir(parents=True, exist_ok=True)
    CITY = ROOT / 'web/assets/city'
    packs = sorted(CDN.glob('4_15_SoccerCup2015*.7z'))
    if not packs:
        print('no 4_15_SoccerCup2015 bundle under', CDN, flush=True)
        return
    stats = {'seen': 0, 'kept': 0}
    log = open(POOL / 'index_flags.tsv', 'a')
    work = WORK_BASE / 'flags'
    import zipfile
    for pack in packs:
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir(parents=True, exist_ok=True)
        # inner pack zips carrying the flag art (Menu packs have none);
        # open_inner_zip's 7z filter matches the STORED path, so keep the
        # top-level folder prefix the listing shows
        listing = subprocess.run(['7z', 'l', str(pack)], capture_output=True,
                                 text=True).stdout
        inners = sorted({ln.split()[-1]
                         for ln in listing.splitlines()
                         if 'SoccerCup2015Game-100-' in ln
                         and ln.strip().endswith('.zip')})
        for inner in inners:
            zpath = open_inner_zip(work, pack.name, inner)
            if zpath is None:
                print(f'  FAIL {pack.name}:{inner}', flush=True)
                continue
            try:
                with zipfile.ZipFile(zpath) as z:
                    for info in z.infolist():
                        base = os.path.basename(info.filename)
                        if (not base.startswith('flag_')
                                or os.path.splitext(base)[1] not in KINDS):
                            continue
                        stats['seen'] += 1
                        dest = POOL / base
                        if dest.exists():
                            continue          # never overwrite (backfill rule)
                        tmp = dest.with_suffix(dest.suffix + '.part')
                        tmp.write_bytes(z.read(info))
                        tmp.rename(dest)
                        log.write(f'{KINDS[os.path.splitext(base)[1]]}\t'
                                  f'{base}\tsoccercup\t{inner}\n')
                        stats['kept'] += 1
            except (OSError, zipfile.BadZipFile):
                print(f'  BADZIP {pack.name}:{inner}', flush=True)
        shutil.rmtree(work, ignore_errors=True)
    log.close()
    stems = sorted(p.stem for p in POOL.glob('flag_*.bsv3'))
    out = {}
    for stem in stems:
        bsv3f, rgbf = POOL / (stem + '.bsv3'), POOL / (stem + '.rgb')
        if not rgbf.exists() or not (POOL / (stem + '.xml')).exists():
            print(f'  {stem}: incomplete triple, skipped', flush=True)
            continue
        e, warns, canvas = _render_sprite(stem, bsv3f, rgbf, POOL,
                                          CITY / 'flags' / f'{stem}.png',
                                          f'flags/{stem}.png')
        if e is None:
            print(f'  {stem}: nothing drawable', flush=True)
            continue
        for w in warns:
            print(f'  warn {w}', flush=True)
        out[stem] = e
    (CITY / 'city-flags.json').write_text(
        json.dumps({'gen': int(time.time()), 'flags': out},
                   separators=(',', ':')))
    print(f'flags: pool files seen={stats["seen"]} new={stats["kept"]} '
          f'baked={len(out)} -> {CITY / "city-flags.json"}', flush=True)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    ex = sub.add_parser('extract')
    ex.add_argument('--worker', type=int, default=0)
    ex.add_argument('--workers', type=int, default=1)
    ex.add_argument('--core', action='store_true')
    bf = sub.add_parser('backfill')
    bf.add_argument('--worker', type=int, default=0)
    bf.add_argument('--workers', type=int, default=1)
    bf.add_argument('--only', default=None,
                    help='comma-separated family-name substrings: scan only '
                         'those candidate rows (e.g. takedown)')
    sub.add_parser('resolve', help='promote archived base art over seasonal '
                                   'race winners in the pool')
    sub.add_parser('report')
    sp = sub.add_parser('sprites')
    sp.add_argument('--slug', default=None)
    sp.add_argument('--parse-only', action='store_true')
    sp.add_argument('--shard', type=int, default=None,
                    help='render only slug list[i::N] into a private '
                         'city-sprites-shardI.json (run N in parallel, then '
                         'sprites-merge)')
    sp.add_argument('--shards', type=int, default=1)
    sub.add_parser('sprites-merge')
    sub.add_parser('bridges', help='bake the engine-composited road-bridge '
                                   'deck/strut frames (notes/09 §10)')
    sub.add_parser('chars')
    sub.add_parser('char-companions',
                   help='harvest the _image_N.rgb companions of every bcell11 '
                        'cell the pool holds into the pool (fills the gap left '
                        'by do_chars skipping bcell11; lets web/api/bcell.php '
                        'serve bcell11 via src=pool)')
    sub.add_parser('reanchor')
    an = sub.add_parser('anims')
    an.add_argument('--slug', default=None)
    an.add_argument('--cap', type=int, default=ANIM_MAX_FRAMES)
    an.add_argument('--placed', action='store_true',
                    help='only slugs the save actually places')
    bh = sub.add_parser('behavior')
    bh.add_argument('--refresh', action='store_true',
                    help='re-scan the gamescripts packs (cached otherwise)')
    bh.add_argument('--write-map', action='store_true',
                    help="rewrite city-anims.json's behavior gate from the "
                         'current manifest (no atlas work)')
    sub.add_parser('flags', help='extract + bake the SoccerCup2015 nation '
                                 'flag cloths (flag_* -> city-flags.json)')
    a = ap.parse_args()
    if a.cmd == 'extract':
        if a.core:
            do_core()
        else:
            worker(a.worker, a.workers)
    elif a.cmd == 'backfill':
        backfill(a.worker, a.workers, only=a.only)
    elif a.cmd == 'resolve':
        resolve_seasons()
    elif a.cmd == 'report':
        do_report()
    elif a.cmd == 'sprites':
        do_sprites(slug=a.slug, parse_only=a.parse_only,
                   shard=a.shard, shards=a.shards)
    elif a.cmd == 'sprites-merge':
        do_sprites_merge()
    elif a.cmd == 'bridges':
        do_bridges()
    elif a.cmd == 'anims':
        do_anims(slug=a.slug, cap=a.cap, placed=a.placed)
    elif a.cmd == 'behavior':
        by_name = load_behaviors(refresh=a.refresh)
        orders = load_layer_orders(refresh=a.refresh)
        n_tap = sum(1 for v in by_name.values() if v.get('tapVerb'))
        print(f'behavior: {len(by_name)} buildings with an engine idle/tap '
              f'signal ({n_tap} with a tap anim), {len(orders)} with an '
              f'AnimationLayerOrder -> {BEHAVIORS}')
        if a.write_map:
            do_behavior_map()
    elif a.cmd == 'chars':
        do_chars()
    elif a.cmd == 'char-companions':
        do_char_companions()
    elif a.cmd == 'reanchor':
        do_reanchor()
    elif a.cmd == 'flags':
        do_flags()


if __name__ == '__main__':
    main()
