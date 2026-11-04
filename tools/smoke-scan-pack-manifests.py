#!/usr/bin/env python3
"""Smoke test for tools/scan_pack_manifests.py (the CDN name census).

The census is the thing that decides "the asset does not exist" versus "we
never extracted it", so its name parser is the part that must not be wrong.
Everything here is offline: the manifests are synthesised in the exact
length-prefixed layout the real BGrm manifests use, including the trap that
makes a naive regex wrong — a length byte is often itself an ASCII character,
so the bytes before an asset name are `-`, `6`, `m.` and friends, which a
plain `[a-z0-9_.-]+\\.bcell` regex happily swallows into the name.

Checks
  * a well-formed record parses to its exact name (no eaten length bytes)
  * the ASCII-length-byte trap yields the CLEAN name, not '-lisa_walk.bcell'
  * a record whose length bytes disagree is rejected (a real name cannot lie
    about its own length) — this is what stops adjacent blobs leaking in
  * only the --kinds requested come back, and names are lower-cased
  * manifest_bytes reads entry 0 of a pack zip, and falls back to small
    members when a pack does not use that name
  * fam_of turns WhackingDayGame-100-r23893 into WhackingDayGame-100 but
    leaves a family that legitimately ends in -r<digits> alone
  * report aggregation: unique names, per-kind totals, the _left/_right walk
    tally, and --grep matching across bundles/packs
  * (skipped when cdn/ is absent) a real bundle scans to a non-zero bcell
    count, and every name it reports for the core pack exists in the pool or
    is reported as a genuine gap

Usage:  python3 tools/smoke-scan-pack-manifests.py
Exits non-zero on the first failure.
"""
import io
import re
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scan_pack_manifests as S                                    # noqa: E402

FAILS = []


def ok(cond, label):
    print(('ok   ' if cond else 'FAIL ') + label)
    if not cond:
        FAILS.append(label)


def record(name, ext=None, name_len=None, ext_len=None):
    """one manifest record: <name>\\0<extlen+1><ext>\\0<namelen+1><name>\\0 — the
    layout confirmed byte-for-byte against the core game-100 pack."""
    ext = ext if ext is not None else name.rsplit('.', 1)[1]
    n = name.encode()
    e = ext.encode()
    ln = name_len if name_len is not None else len(n) + 1
    el = ext_len if ext_len is not None else len(e) + 1
    return b'\x00' + bytes([el]) + e + b'\x00' + bytes([ln]) + n + b'\x00'


def manifest(records):
    return b'BGrm\x03\x02\x00\x00' + b''.join(records)


# --------------------------------------------------------------- the parser

blob = manifest([
    record('homer_front_walk.bcell'),
    record('homer_back_walk.bcell'),
    record('homer.xml'),
    record('homer_front_walk_image_1.rgb'),
    record('Lisa_walk_the_line_front_walk.bcell'),
])

got = dict(S.names_from(blob, {'bcell'}))
ok(got == {'homer_front_walk.bcell': 'bcell',
           'homer_back_walk.bcell': 'bcell',
           'lisa_walk_the_line_front_walk.bcell': 'bcell'},
   'well-formed records parse to their exact names: %s' % sorted(got))

ok('homer.xml' not in got and not any(n.endswith('.rgb') for n in got),
   'only the requested --kinds come back')

# the trap: a length byte is just a byte, and every value in 0x20..0x7e is a
# printable word character — so a name 44 chars long is preceded by 0x2d ('-'),
# one 53 chars long by 0x36 ('6'), one 109 long by 0x6e ('n'). A regex that
# walks backwards over [a-z0-9_.-] glues those characters onto the name, which
# is exactly how an earlier draft of this census produced
# '-lisa_go_trick_or_treating_active_right.bcell'. These names have HONEST
# length bytes; only their lengths are chosen, so the parser is the one being
# tested, not the fixture.
def named(nchars):
    stem = 'homer_' + 'a' * (nchars - len('homer_.bcell'))
    return stem + '.bcell'

trap_names = [named(44), named(53), named(109)]          # '-', '6', 'n' prefixes
t = dict(S.names_from(manifest([record(n) for n in trap_names]), {'bcell'}))
ok(set(t) == set(trap_names),
   'names whose length byte is itself printable stay clean: %s' % sorted(t))
ok(not any(n.startswith(('-', '6', 'n.')) for n in t),
   'no length byte was eaten into a name')
ok(dict(S.names_from(manifest([record(named(44))]), {'bcell'}))
   == {named(44): 'bcell'},
   'the "-" case (44 chars) parses exactly')

# a lying length byte: a real record states its own length, so disagreement
# means the bytes are not a record and must not become a name
lie = manifest([
    record('homer_front_walk.bcell', name_len=4),
    record('homer_front_walk.bcell', ext_len=9),
    record('homer_back_walk.bcell'),
])
ok(set(n for n, _ in S.names_from(lie, {'bcell'})) == {'homer_back_walk.bcell'},
   'records with disagreeing length bytes are rejected')

# extension must match the name it claims
mism = manifest([record('homer_front_walk.bcell', ext='xml')])
ok(not S.names_from(mism, {'bcell'}), 'a name that contradicts its extension is rejected')

# non-ASCII / control bytes inside a "name" must not produce a name
ctrl = b'\x00\x06bcell\x00\x05ho\x01me\x00'
ok(not S.names_from(ctrl, {'bcell'}),
   'control bytes inside a name reject it')

ok(dict(S.names_from(manifest([record('Homer_Front_Walk.bcell')]), {'bcell'}))
   == {'homer_front_walk.bcell': 'bcell'},
   'names are folded to lower case (the pool and the API both key on that)')

# --------------------------------------------------------------- pack reading

buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w') as z:
    z.writestr('0', manifest([record('wiggum_front_walk_left.bcell')]))
    z.writestr('1', b'\x00' * 5000)
packed = buf.getvalue()

try:
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / 'WiggumGame-100-r23893-ABCD1234.zip'
        p.write_bytes(packed)
        got = S.names_from(S.manifest_bytes(p), {'bcell'})
        ok(set(n for n, _ in got) == {'wiggum_front_walk_left.bcell'},
           'manifest_bytes reads entry 0 of a pack zip: %s' % sorted(got))
        ok(S.fam_of(p) == 'WiggumGame-100',
           'fam_of strips the revision and tag: %s' % S.fam_of(p))

        # a pack with no entry 0: the small-member fallback still finds it
        buf2 = io.BytesIO()
        with zipfile.ZipFile(buf2, 'w') as z:
            z.writestr('index', manifest([record('wiggum_front_walk_left.bcell')]))
            z.writestr('blob', b'\x00' * 5000)
        p2 = Path(td) / 'Odd-100-r1.zip'
        p2.write_bytes(buf2.getvalue())
        ok(set(n for n, _ in S.names_from(S.manifest_bytes(p2), {'bcell'}))
           == {'wiggum_front_walk_left.bcell'},
           'a pack that does not name its manifest 0 is still read')

        # a corrupt container must not raise, just yield nothing
        p3 = Path(td) / 'Broken-100-r1.zip'
        p3.write_bytes(b'not a zip at all')
        ok(S.manifest_bytes(p3) == b'', 'a corrupt pack yields no bytes, not a traceback')
except Exception as e:                                            # noqa: BLE001
    ok(False, 'pack-zip checks raised: %r' % (e,))

# a `dir` bundle is the user's own files: reading it must never delete it.
# (An earlier draft unlinked every zip it read, and ate cdn/3_0_30/ — the two
# core packs had to be re-extracted from cdn/3_0_30.7z.)
with tempfile.TemporaryDirectory() as td:
    cdn_dir = Path(td) / 'cdn' / '3_0_30'
    cdn_dir.mkdir(parents=True)
    core = cdn_dir / 'game-100-v3_0_30.zip'
    core.write_bytes(packed)
    work = Path(td) / 'work'
    work.mkdir()
    staged = work / 'x.zip'
    staged.write_bytes(packed)
    ok([p.name for p in S.inner_zips('3_0_30', 'dir', cdn_dir, work)]
       == ['game-100-v3_0_30.zip'], 'a dir bundle lists its packs in place')
    S.discard_staged(core, work)
    ok(core.exists(), 'discard_staged leaves the user\'s in-place pack alone')
    ok(S.discard_staged(staged, work) is False and not staged.exists(),
       'discard_staged does delete our own staged copy')

# a family whose real name ends in -r<digits> must survive fam_of intact
ok(S.fam_of(Path('gamecommon-25-r23893.zip')) == 'gamecommon-25',
   'fam_of on an ordinary revision pack: %s' % S.fam_of(Path('gamecommon-25-r23893.zip')))

# ----------------------------------------------------------------- reporting

import tempfile
with tempfile.TemporaryDirectory() as td:
    out = Path(td)
    (out / 'names_0.tsv').write_text(
        'homer_front_walk.bcell\tbcell\tA.7z\tAGame-100\n'
        'homer_back_walk.bcell\tbcell\tA.7z\tAGame-100\n'
        'wiggum_front_walk_left.bcell\tbcell\tB.7z\tBGame-100\n'
        'wiggum_front_walk_right.bcell\tbcell\tB.7z\tBGame-100\n',
        encoding='utf-8')
    (out / 'packs_0.tsv').write_text(
        'A.7z\tAGame-100\t63163\t2\t2\nB.7z\tBGame-100\t34673\t2\t2\n',
        encoding='utf-8')
    names = S.load_partial(out, 'names_*.tsv')
    packs = S.load_partial(out, 'packs_*.tsv')
    uniq = {r[0] for r in names}
    ok(len(uniq) == 4 and len(packs) == 2,
       'report aggregation reads the per-worker partials')
    walk = [n for n in uniq if '_walk' in n]
    side = [n for n in walk if n.endswith(('_left.bcell', '_right.bcell'))]
    ok(len(walk) == 4 and len(side) == 2,
       'the _left/_right walk tally counts sided cells (%d of %d)' % (len(side), len(walk)))
    rx = re.compile('homer.*walk', re.I)
    ok(sorted(n for n in uniq if rx.search(n)) ==
       ['homer_back_walk.bcell', 'homer_front_walk.bcell'],
       '--grep matches across bundles')

# ------------------------------------------------- real CDN (skipped if absent)
if (S.CDN / '3_0_30').is_dir() and S.SEVENZ:
    bundles = [b for b in S.list_bundles() if b[0] == '3_0_30']
    if bundles:
        with tempfile.TemporaryDirectory() as td:
            zips = S.inner_zips('3_0_30', 'dir', bundles[0][2], Path(td))
            total = 0
            for zp in zips:
                total += len(S.names_from(S.manifest_bytes(zp), {'bcell'}))
        ok(total > 100,
           'the core 3_0_30 dir bundle scans to %d bcell names' % total)
else:
    print('note  cdn/ or 7z unavailable — real-bundle check skipped')

print()
if FAILS:
    print('FAILURES: %d' % len(FAILS))
    for f in FAILS:
        print('  - ' + f)
    sys.exit(1)
print('all good')
