#!/usr/bin/env python3
"""Full CDN asset-name census: every asset name every pack really ships.

Why this exists (2026-11-04, notes/13 §8): the sprite pool under
/tmp/opencode/citypool is a FILTERED extraction — gen_city_sprites.py `extract`
pulls the slugs the save needs out of the candidate packs, and `backfill`
widens it to the candidate rows. Neither is a statement about the whole CDN.
So "homer_front_walk_left is not in the pool" has never meant "the game does
not ship it". This tool asks the packs themselves.

Every pack in cdn/ is a double container: a .7z bundle holding inner
`<Family>-r<rev>-<TAG>.zip` packs, and each inner pack holds entry `0`, a
`BGrm` manifest that lists the pack's asset paths, plus entry `1`, the blob.
Entry `0` is ~60 KB, so a complete name census of all 510 bundles costs one
7z pass per bundle and a regex over a few KB per pack — no 45 MB blobs
touched, and the answer is the shipped game's own inventory rather than
anything we generated.

Usage
-----
  scan_pack_manifests.py scan --worker N --workers M [--out DIR] [--kinds a,b]
      shard the bundle list (sorted, every Mth bundle to worker N), stage each
      bundle's inner zips, read the manifests, append to
      <out>/names_<N>.tsv + <out>/packs_<N>.tsv, and remember finished bundles
      in <out>/done_<N>.txt so an interrupted run resumes.

  scan_pack_manifests.py report [--grep REGEX] [--kinds a,b]
      merge the per-worker partials, print coverage totals (bundles/packs/names,
      names per kind), and with --grep list every matching name with the packs
      that ship it (REGEX is matched case-insensitively against the name).

  scan_pack_manifests.py bundles
      just print the bundle list the scan will walk.

The staging directory is <out>/work and each staged copy is deleted as soon
as its manifest is read, so the peak is one bundle's inner zips (the largest
bundle is ~4 GB compressed); keep --out on a real disk, not the tmpfs /tmp.
A bundle that is already a directory under cdn/ (kind 'dir') is read in place
and its files are never touched — see discard_staged().
"""
import argparse
import collections
import io
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CDN = ROOT / 'cdn'
DEFAULT_OUT = ROOT / '.scratch' / 'pack-scan'
DEFAULT_KINDS = 'bcell'
MANIFEST_MAX = 4 << 20          # a manifest is ~60 KB; anything bigger is art
SEVENZ = shutil.which('7z') or shutil.which('7za') or shutil.which('7zz')

ENTRY_RE = re.compile(rb'\x00(.)([a-z]{2,6})\x00(.)([\x20-\x7e]{2,250})\x00')
SAFE_RE = re.compile(r'[a-z0-9_.\-]+$')
BUNDLE_RE = re.compile(r'\.7z$')


# --------------------------------------------------------------- bundle list

def list_bundles():
    """every container in cdn/, as (label, kind, path): kind '7z' or 'dir'."""
    out = []
    for p in sorted(CDN.iterdir()):
        if p.is_file() and BUNDLE_RE.search(p.name):
            out.append((p.name, '7z', p))
        elif p.is_dir():
            if any(p.glob('*.zip')):
                out.append((p.name, 'dir', p))
    return out


# ---------------------------------------------------------------- extraction

def inner_zips(label, kind, path, work):
    """stage a bundle's inner pack zips and return their paths.

    A `dir` bundle (a directory already unpacked under cdn/, e.g. 3_0_30/) is
    read IN PLACE — its zips are the user's files and are never unlinked, so
    callers must only clean up paths that live under `work`."""
    if kind == 'dir':
        return sorted(path.glob('*.zip'))
    dest = work / label
    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)
    dest.mkdir(parents=True)
    # the packs live one level down inside the bundle (dir/name-rREV-TAG.zip),
    # and in a few old bundles at the top level
    for pat in ('*.zip', '*/*.zip'):
        subprocess.run([SEVENZ, 'x', '-y', '-bb0', '-bso0', '-bsp0',
                        str(path), '-o' + str(dest), '--', pat],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       check=False)
    return sorted(dest.rglob('*.zip'))


def discard_staged(zpath, work):
    """delete a staged copy once its manifest has been read.

    Only paths inside the staging directory are ours to delete. A `dir`
    bundle's zips live in cdn/ itself, and an earlier version of this scan
    unlinked those — it deleted the user's core pack files. Everything the
    scan reads in place must survive it."""
    if work is not None and work in zpath.parents:
        zpath.unlink()
    return zpath.exists()


def manifest_bytes(zpath):
    """the pack's own asset-path manifest (entry 0; fall back to any small
    member, since a handful of bundles name it differently)."""
    try:
        with zipfile.ZipFile(zpath) as z:
            names = z.namelist()
            cands = ['0'] if '0' in names else []
            if not cands:
                cands = [i.filename for i in z.infolist()
                         if i.file_size and i.file_size < MANIFEST_MAX]
            blob = b''
            for n in cands:
                try:
                    blob += z.read(n)[:MANIFEST_MAX]
                except Exception:
                    continue
            return blob
    except (zipfile.BadZipFile, OSError):
        return b''


def names_from(blob, kinds):
    """(name, kind) pairs the manifest lists, deduped, restricted to `kinds`.

    The manifest is a table of records that each carry the asset name twice,
    once before and once after the extension, both length-prefixed with the
    length INCLUDING the terminator:

        ... <name>\\x00 <extlen+1> <ext> \\x00 <namelen+1> <name> \\x00 ...

    Anchoring on that second copy — and requiring both length bytes to agree
    with what was captured — is what keeps the length bytes themselves out of
    the names (a plain regex over the blob yields '-lisa_walk.bcell' style
    junk, because an ASCII-valued length byte is itself a word character)."""
    found = set()
    for m in ENTRY_RE.finditer(blob):
        elen, ext, nlen, name = (m.group(1)[0], m.group(2).decode('latin-1'),
                                 m.group(3)[0], m.group(4).decode('latin-1'))
        low = name.lower()
        if (elen != len(ext) + 1 or nlen != len(name) + 1
                or ext not in kinds or not low.endswith('.' + ext)
                or not SAFE_RE.match(low)):
            continue
        found.add((low, ext))
    return found


def fam_of(zpath):
    """22For30Game-100-r360509-QTYEP9D8.zip -> 22For30Game-100 (the revision
    and the cache tag are the same pack republished, not a family of its own)"""
    return re.sub(r'-r\d+(-[A-Z0-9]{6,})?$', '', zpath.stem)


# --------------------------------------------------------------------- scan

def do_scan(wid, nworkers, out, kinds):
    if not SEVENZ:
        sys.exit('no 7z / 7za / 7zz on PATH')
    work = out / 'work'
    work.mkdir(parents=True, exist_ok=True)
    out.mkdir(parents=True, exist_ok=True)
    done_f = out / ('done_%d.txt' % wid)
    done = set(done_f.read_text().split()) if done_f.exists() else set()
    names_f = open(out / ('names_%d.tsv' % wid), 'a', encoding='utf-8')
    packs_f = open(out / ('packs_%d.tsv' % wid), 'a', encoding='utf-8')

    bundles = list_bundles()
    mine = [b for i, b in enumerate(bundles) if i % nworkers == wid]
    n_done = n_pack = n_name = 0
    for label, kind, path in mine:
        if label in done:
            continue
        try:
            zips = inner_zips(label, kind, path, work)
        except Exception as e:                                # noqa: BLE001
            print('w%d FAIL %s: %s' % (wid, label, e), flush=True)
            continue
        seen_bundles = 0
        for zp in zips:
            if zp.suffix.lower() != '.zip':
                continue
            blob = manifest_bytes(zp)
            got = names_from(blob, kinds)
            fam = fam_of(zp)
            bc = sum(1 for _, e in got if e == 'bcell')
            names_f.writelines('%s\t%s\t%s\t%s\n' % (n, e, label, fam)
                               for n, e in sorted(got))
            packs_f.write('%s\t%s\t%d\t%d\t%d\n' % (label, fam,
                                                    len(blob), len(got), bc))
            n_pack += 1
            n_name += len(got)
            seen_bundles += 1
            # only our own staged copies are expendable: a `dir` bundle's zips
            # are the user's files and must survive the scan
            discard_staged(zp, work)
        names_f.flush()
        packs_f.flush()
        shutil.rmtree(work / label, ignore_errors=True)
        done.add(label)
        done_f.write_text('\n'.join(sorted(done)) + '\n')
        n_done += 1
        print('w%d %s  packs=%d names=%d  (%d/%d bundles)' %
              (wid, label, seen_bundles, n_name, n_done, len(mine)), flush=True)
    names_f.close()
    packs_f.close()
    print('w%d done: %d bundles, %d packs, %d names' % (wid, n_done, n_pack, n_name))


# ------------------------------------------------------------------- report

def load_partial(out, stem):
    rows = []
    for f in sorted(out.glob(stem)):
        with open(f, encoding='utf-8') as fh:
            for line in fh:
                rows.append(line.rstrip('\n').split('\t'))
    return rows


def do_report(out, grep, kinds):
    names = load_partial(out, 'names_*.tsv')
    packs = load_partial(out, 'packs_*.tsv')
    if not names:
        sys.exit('no census yet — run scan first')
    by_kind = collections.Counter(r[1] for r in names)
    uniq = collections.defaultdict(set)          # name -> {(bundle, pack fam)}
    for r in names:
        uniq[r[0]].add((r[2], r[3]))
    print('bundles scanned : %d' % len({r[0] for r in packs}))
    print('packs read      : %d' % len(packs))
    print('name rows       : %d  (unique names %d)' % (len(names), len(uniq)))
    print('by kind         : ' + ', '.join('%s=%d' % kv
                                           for kv in by_kind.most_common()))
    bcells = {n for n in uniq if n.endswith('.bcell')}
    walk = [n for n in bcells if '_walk' in n]
    side = [n for n in walk if n.endswith(('_left.bcell', '_right.bcell'))]
    print('walk cells      : %d unique, %d of them _left/_right' %
          (len(walk), len(side)))
    if grep:
        rx = re.compile(grep, re.I)
        hits = sorted(n for n in uniq if rx.search(n))
        print('\n--grep %s : %d names' % (grep, len(hits)))
        for n in hits[:400]:
            srcs = ', '.join(sorted({'%s/%s' % s for s in uniq[n]})[:4])
            print('  %-56s %s' % (n, srcs))
        if len(hits) > 400:
            print('  … %d more' % (len(hits) - 400))


def do_merge(out, dest, kinds):
    """fold the per-worker partials into one queryable census file.

    Written as a TSV with provenance in a leading comment so the file can be
    committed and still answer "how complete is this?" on its own:

        # bundles=511 packs=22481 kinds=bcell generated=2026-11-04T…
        homer_front_walk.bcell\tbcell\t4\tgame-100-v3_0_30

    `packs` is how many distinct packs ship the name and `sample` names one of
    them, which is what tells a reader whether a name missing from the pool is
    an authoring fact or an extraction gap."""
    rows = load_partial(out, 'names_*.tsv')
    packs = load_partial(out, 'packs_*.tsv')
    if not rows:
        sys.exit('nothing to merge — run scan first')
    seen = {}                              # name -> {kind, bundles shipping it}
    for name, kind, bundle, fam in rows:
        if kinds and kind not in kinds:
            continue
        seen.setdefault(name, (kind, set()))[1].add((bundle, fam))
    head = ('# bundles=%d packs=%d kinds=%s generated=%s\n'
            % (len({r[0] for r in packs}), len(packs), ','.join(sorted(kinds)),
               __import__('datetime').datetime.now().isoformat(timespec='seconds')))
    with open(dest, 'w', encoding='utf-8') as fh:
        fh.write(head)
        for name in sorted(seen):
            kind, srcs = seen[name]
            fh.write('%s\t%s\t%d\t%s\n' % (name, kind, len(srcs),
                                           sorted(s for _, s in srcs)[0]))
    print('%s: %d names from %d packs' % (dest, len(seen), len(packs)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['scan', 'report', 'bundles', 'merge'])
    ap.add_argument('--worker', type=int, default=0)
    ap.add_argument('--workers', type=int, default=1)
    ap.add_argument('--out', type=Path, default=DEFAULT_OUT)
    ap.add_argument('--kinds', default=DEFAULT_KINDS,
                    help='comma list of extensions to keep (default bcell)')
    ap.add_argument('--grep', default=None)
    ap.add_argument('--dest', type=Path, default=None,
                    help='merge output (default <out>/names.tsv)')
    a = ap.parse_args()
    kinds = {k.strip().lstrip('.') for k in a.kinds.split(',') if k.strip()}
    if a.cmd == 'bundles':
        for label, kind, path in list_bundles():
            print('%s\t%s\t%d' % (label, kind, path.stat().st_size))
    elif a.cmd == 'scan':
        do_scan(a.worker, a.workers, a.out, kinds)
    elif a.cmd == 'merge':
        do_merge(a.out, a.dest or (a.out / 'names.tsv'), kinds)
    else:
        do_report(a.out, a.grep, kinds)


if __name__ == '__main__':
    main()
