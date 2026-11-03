#!/usr/bin/env python3
"""Progress tracker scanner (2026-10-18).

Scans every project artifact we can measure and writes a timestamped
snapshot of meters into web/api/progress.sqlite, which web/api/progress.php
serves to web/progress.html. Everything here is COMPUTED from the tree —
the SQLite task board (tasks / snap_log) is the only hand-edited layer and
is managed through the progress page itself.

Sources scanned (all optional — a missing source yields a 0/absent meter,
never a crash):
  cdn/*.7z                    archive.org bundles downloaded (of 510)
  cdn/cdn-explorer.db         RE workbench: indexed sources/files/entries,
                              format registry, findings, file statuses
  cdn/v469-packages.json      master DLC index (the package denominator)
  cdn/file-urls.txt           fan-CDN file listing (fan-CDN denominator)
  web/assets/manifest.json    extracted asset inventory + decoded DLC packs
  web/js/*.js                 bsv3 renderer presence
  web/api/streets.sqlite      street eye-test verdicts
  re/*                        libscorpio.so RE artifacts
  notes/04-server-api.md      server-endpoint documentation coverage
  data/*.json                 building/character catalogs
  mapdump/registration/       evidence files

Usage:
  python3 tools/progress_scan.py [--note TEXT] [--dry-run]
  python3 tools/progress_scan.py --root DIR --db PATH   # fixtures (smoke)
Pure stdlib, zero network.
"""
import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path

# archive.org `tsto-cdn-content` item holds 510 .7z bundles / 38.5 GB
# (verified count recorded in notes/02-architecture-and-decisions.md).
TOTAL_ARCHIVE_ORG_BUNDLES = 510

SECTIONS = ['cdn', 'formats', 'native', 'serverapi', 'assets', 'map']

SCHEMA = """
CREATE TABLE IF NOT EXISTS snapshots (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    taken_at  TEXT NOT NULL DEFAULT (datetime('now')),
    note      TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS metrics (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),
    section     TEXT NOT NULL,
    key         TEXT NOT NULL,
    label       TEXT NOT NULL,
    num         INTEGER NOT NULL,
    den         INTEGER,
    unit        TEXT NOT NULL DEFAULT '',
    detail      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_metrics_snap ON metrics(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_metrics_key  ON metrics(section, key);
CREATE TABLE IF NOT EXISTS coverage (
    bundle     TEXT PRIMARY KEY,
    downloaded INTEGER NOT NULL DEFAULT 0,
    indexed    INTEGER NOT NULL DEFAULT 0,
    unpacked   INTEGER NOT NULL DEFAULT 0,
    packs      INTEGER NOT NULL DEFAULT 0,
    season     TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS tasks (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    title   TEXT NOT NULL,
    kind    TEXT NOT NULL DEFAULT 'task',      -- task | milestone | decision
    status  TEXT NOT NULL DEFAULT 'todo',      -- see TASK_STATUSES
    source  TEXT NOT NULL DEFAULT '',
    notes   TEXT NOT NULL DEFAULT '',
    ord     INTEGER NOT NULL DEFAULT 0,
    updated TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS snap_log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      TEXT NOT NULL DEFAULT (datetime('now')),
    message TEXT NOT NULL
);
"""

TASK_STATUSES = ['todo', 'doing', 'done', 'blocked', 'deferred',
                 'pending-approval']

# Seeded once (first run) from notes/03-open-work.md approval states.
SEED_TASKS = [
    ('Index remaining CDN bundles in the CDN Explorer',
     'task', 'todo', 'progress scan 2026-10-18',
     '507 of 510 downloaded bundles are still un-indexed — the cheapest '
     'remaining progress: run cdn_explorer scans per bundle.'),
    ('IMA ADPCM -> PCM16 audio re-encode (62 WAVs)',
     'task', 'deferred', 'notes/03 s1',
     'User said "No, leave the audio fix for now." Fully specified in '
     'notes/01; biggest functional gap (no sound plays in the web build).'),
    ('.bsv3 canvas renderer (building animations)',
     'task', 'deferred', 'notes/03 s2',
     '837 building-scene files carried as raw data; format fully '
     'documented, renderer is natural next step.'),
    ('Terrain codebook: char -> 16-bit mask (RoadsUtil::RoadmapBoolRect)',
     'task', 'todo', 'notes/03',
     'Search recipe in notes/01 "Terrain & roadmaps"; next RE step for '
     'the city renderer (Phase 2).'),
    ('Phase 3: libscorpio.so gameplay decompilation',
     'task', 'deferred', 'notes/03 s3',
     'Never approved; would need radare2 or Ghidra installed.'),
    ('Download fan-CDN tho2104.7z (120 MB, CDN root)',
     'decision', 'pending-approval', 'notes/03',
     'Referenced by no index or ledger; needs explicit approval for '
     'that download.'),
    ('Download fan-CDN THOH2014Game-100 (42 MB art pack)',
     'decision', 'pending-approval', 'notes/03',
     'The only real in-game art pack on the fan CDN; never pulled.'),
    ('All 510 archive.org tsto-cdn-content bundles downloaded',
     'milestone', 'done', 'notes/02',
     'cdn/*.7z complete at 39 GB (2026-10-18).'),
    ('Phase 1: CDN Explorer RE workbench live',
     'milestone', 'done', 'planning/phase-1-cdn-explorer.md',
     'python3 tools/cdn_explorer.py on :8123.'),
    ('Progress tracker online',
     'milestone', 'done', 'progress scan 2026-10-18',
     'tools/progress_scan.py + web/api/progress.php + web/progress.html.'),
]


def warn(msg):
    print('  ! ' + msg, file=sys.stderr)


def jload(path):
    try:
        with open(path, 'r', encoding='utf-8') as fh:
            return json.load(fh)
    except (OSError, ValueError) as e:
        warn('%s: %s' % (path, e))
        return None


def q1(db, sql, default=None):
    """One scalar from a possibly-missing table/db; never raises."""
    try:
        con = sqlite3.connect('file:%s?mode=ro' % db, uri=True)
        try:
            return con.execute(sql).fetchone()[0]
        finally:
            con.close()
    except sqlite3.Error as e:
        warn('%s: %s' % (db, e))
        return default


# ---- pack-name normalisation -------------------------------------------------

# Master-index names look like '3_0_30:game-100-v3_0_30-r157326-B8353263.zip';
# decoded pack dirs (run_dlc_batch) look like 'game-100-r157326'. Collapse
# both to a comparable stem: drop the dir: prefix, then trailing revision
# (-rNNN), version (-vX_Y_Z) and CDN hash (-ABCDEFGH) tokens.
_REV = re.compile(r'^r\d+$')
_VER = re.compile(r'^v[\d_.]+$')
_HASH = re.compile(r'^(?=[0-9A-Z]{8,10}$)(?=.*\d)[0-9A-Z]+$')


def pack_stem(name):
    n = name
    if n.lower().endswith('.zip'):
        n = n[:-4]
    if ':' in n:
        n = n.rsplit(':', 1)[1]
    toks = n.split('-')
    while len(toks) > 1 and (_REV.match(toks[-1]) or _VER.match(toks[-1])
                             or _HASH.match(toks[-1])):
        toks.pop()
    return '-'.join(toks)


# ---- collectors ----------------------------------------------------------------

def collect(root):
    """Return (meters, coverage) where meters is a list of row tuples
    (section, key, label, num, den, unit, detail-json-str)."""
    m = []

    def add(section, key, label, num, den=None, unit='', detail=None):
        m.append((section, key, label, int(num),
                  None if den is None else int(den), unit,
                  json.dumps(detail, sort_keys=True) if detail else ''))

    # ---------------- cdn ------------------------------------------------------
    cdn = root / 'cdn'
    bundles = sorted(p.stem for p in cdn.glob('*.7z'))
    bundle_set = set(bundles)
    add('cdn', 'bundles.downloaded', 'archive.org bundles on disk',
        len(bundles), TOTAL_ARCHIVE_ORG_BUNDLES, 'bundles',
        {'total_known': TOTAL_ARCHIVE_ORG_BUNDLES})

    db = cdn / 'cdn-explorer.db'
    indexed = q1(db, "SELECT COUNT(*) FROM sources "
                     "WHERE scan_state='done'", 0) or 0
    add('cdn', 'bundles.indexed', 'bundles indexed in CDN Explorer',
        indexed, len(bundles), 'bundles')
    add('cdn', 'files.indexed', 'CDN Explorer file rows',
        q1(db, 'SELECT COUNT(*) FROM files', 0) or 0)
    add('cdn', 'entries.indexed', 'CDN Explorer entry rows (nested)',
        q1(db, 'SELECT COUNT(*) FROM entries', 0) or 0)

    unpacked = sorted(p.name for p in cdn.iterdir()
                      if p.is_dir() and not p.name.startswith('.'))
    add('cdn', 'bundles.unpacked', 'bundles unpacked to disk',
        len(unpacked), len(bundles), 'bundles',
        {'dirs': unpacked})

    # decoded packs from the manifest
    manifest = jload(root / 'web/assets/manifest.json') or {}
    files = manifest.get('files', [])
    dlc_dirs = []
    dlc_dir = root / 'web/assets/dlc'
    if dlc_dir.is_dir():
        dlc_dirs = sorted(p.name for p in dlc_dir.iterdir() if p.is_dir())
    stems = {}
    for d in dlc_dirs:
        stems.setdefault(pack_stem(d), []).append(d)

    v469 = jload(cdn / 'v469-packages.json') or []
    v469_stems = {pack_stem(p.get('file', '')) for p in v469 if p.get('file')}
    denom = len(v469_stems)
    matched = {s for s in stems if s.lower() in {x.lower() for x in v469_stems}}
    off_index = {s: v for s, v in stems.items() if s not in matched}
    add('cdn', 'packages.decoded', 'master-index packages decoded',
        len(matched), denom, 'packages',
        {'index_entries': len(v469), 'distinct_stems': denom})
    add('cdn', 'packs.distinct', 'decoded DLC packs (rev-collapsed)',
        len(stems), None, 'packs', {'pack_dirs': len(dlc_dirs)})
    add('cdn', 'packs.offindex', 'decoded packs outside the v469 index',
        len(off_index), None, 'packs',
        {'note': 'fan-CDN / unlisted packs', 'names': sorted(off_index)})

    # fan CDN
    fan_urls = cdn / 'file-urls.txt'
    fan_total = 0
    if fan_urls.is_file():
        fan_total = sum(1 for ln in fan_urls.read_text().splitlines()
                        if ln.strip())
    fan_packs = set()
    for e in files:
        url = ''
        d = e.get('dlc') or {}
        url = d.get('url') or e.get('source') or ''
        if 'cdn.projectspringfield.com' in url:
            fan_packs.add(pack_stem(d.get('pack') or e.get('origin') or url))
    add('cdn', 'fancdn.downloaded', 'fan-CDN packs decoded',
        len(fan_packs), fan_total or None, 'files')

    # per-bundle coverage grid: which bundles contributed decoded packs
    # (counted as distinct rev-collapsed pack stems, not raw file entries)
    pack_re = re.compile(r'/cdn/([^/]+)\.7z')
    covered = {}
    for e in files:
        url = (e.get('dlc') or {}).get('url') or e.get('source') or ''
        mt = pack_re.search(url)
        if mt:
            pack = (e.get('dlc') or {}).get('pack') or e.get('path', '')
            covered.setdefault(mt.group(1), set()).add(pack_stem(pack))
    cov_indexed = set()
    try:
        con = sqlite3.connect('file:%s?mode=ro' % db, uri=True)
        for (name,) in con.execute(
                "SELECT name FROM sources WHERE scan_state='done'"):
            cov_indexed.add(name[:-3] if name.lower().endswith('.7z')
                            else name)
        con.close()
    except sqlite3.Error:
        pass
    all_bundles = sorted(bundle_set | set(covered) | cov_indexed)
    coverage = []
    for b in all_bundles:
        season = re.match(r'^(\d+(?:_\d+)*)', b)
        coverage.append({
            'bundle': b,
            'downloaded': 1 if b in bundle_set else 0,
            'indexed': 1 if b in cov_indexed else 0,
            'unpacked': 1 if b in unpacked else 0,
            'packs': len(covered.get(b, ())),
            'season': season.group(1) if season else '',
        })
    cov_covered = sum(1 for c in coverage if c['packs'])
    add('cdn', 'bundles.covered', 'bundles contributing decoded packs',
        cov_covered, len(bundles), 'bundles')

    # ---------------- formats ---------------------------------------------------
    n_files = q1(db, 'SELECT COUNT(*) FROM files', 0) or 0
    for st in ('unknown', 'identified', 'decoded', 'skipped', 'error'):
        n = 0
        try:
            con = sqlite3.connect('file:%s?mode=ro' % db, uri=True)
            n = con.execute(
                'SELECT COUNT(*) FROM files WHERE status=?', (st,)).fetchone()[0]
            con.close()
        except sqlite3.Error as e:
            warn('%s (status=%s): %s' % (db, st, e))
        add('formats', 'files.' + st, 'CDN files: ' + st, n,
            n_files or None)
    n_entries = q1(db, 'SELECT COUNT(*) FROM entries', 0) or 0
    for st in ('unknown', 'identified', 'decoded', 'skipped', 'error'):
        n = 0
        try:
            con = sqlite3.connect('file:%s?mode=ro' % db, uri=True)
            n = con.execute(
                'SELECT COUNT(*) FROM entries WHERE status=?',
                (st,)).fetchone()[0]
            con.close()
        except sqlite3.Error as e:
            warn('%s (entry status=%s): %s' % (db, st, e))
        if n or st != 'unknown':
            add('formats', 'entries.' + st, 'CDN entries: ' + st, n,
                n_entries or None)
    add('formats', 'registry.registered', 'format registry entries',
        q1(db, 'SELECT COUNT(*) FROM formats', 0) or 0)
    add('formats', 'findings.count', 'RE findings recorded',
        q1(db, 'SELECT COUNT(*) FROM findings', 0) or 0)
    decodable = q1(db, 'SELECT COUNT(*) FROM formats WHERE decoder '
                       "IS NOT NULL", 0) or 0
    add('formats', 'registry.decoders', 'registry formats with decoder',
        decodable, q1(db, 'SELECT COUNT(*) FROM formats', 0) or None)

    # ---------------- native (.so RE) -------------------------------------------
    re_dir = root / 're'

    def lines(p):
        try:
            with open(p, 'rb') as fh:
                return sum(1 for _ in fh)
        except OSError:
            return 0

    add('native', 're.classes', 'RTTI classes recovered',
        lines(re_dir / 'rtti_classes.txt'))
    cm = jload(re_dir / 'class_methods.json') or {}
    methods = sum(len(v) for v in cm.values() if isinstance(v, dict))
    add('native', 're.methods', 'class methods catalogued', methods,
        None, 'methods', {'classes': len(cm)})
    add('native', 're.symbols', 'demangled symbols',
        lines(re_dir / 'syms-demangled.txt'))
    add('native', 're.endpoints', 'endpoints discovered',
        lines(re_dir / 'endpoints.txt'))
    pf = jload(re_dir / 'proto_files.json') or []
    fields = sum(len(msgg.get('fields', []))
                 for f in pf if isinstance(f, dict)
                 for msgg in f.get('messages', []))
    add('native', 're.proto_fields', 'protobuf fields parsed', fields,
        None, 'fields', {'proto_files': len(pf)})
    xr = lines(re_dir / 'str_xrefs.tsv')
    add('native', 're.xrefs', 'string xrefs scanned', max(xr - 1, 0))

    # ---------------- serverapi --------------------------------------------------
    eps = [ln.strip() for ln in (re_dir / 'endpoints.txt').read_text(
    ).splitlines() if ln.strip()] if (re_dir / 'endpoints.txt').is_file() else []
    doc_text = ''
    docpath = root / 'notes/04-server-api.md'
    if docpath.is_file():
        doc_text = docpath.read_text(encoding='utf-8', errors='replace')
    documented = sum(1 for e in eps if e.strip('/') and e.strip('/')
                     in doc_text)
    add('serverapi', 'api.endpoints.documented',
        'discovered endpoints documented', documented, len(eps) or None,
        'endpoints')
    php = sorted((root / 'web/api').glob('*.php'))
    add('serverapi', 'api.php.endpoints', 'own PHP API endpoints',
        len(php), None, 'endpoints',
        {'files': [p.name for p in php]})

    # ---------------- assets -----------------------------------------------------
    by_type = {}
    playable = 0
    bsv3 = 0
    errors = 0
    for e in files:
        t = e.get('type', '?')
        by_type[t] = by_type.get(t, 0) + 1
        if t == 'audio':
            # browsers play AAC-in-MP4 and PCM/float WAV; the corpus' own
            # re-encode stamps codec 'aac' (no RIFF fmt tag) or codec 'pcm'
            # with fmt tag 1. Anything else is still IMA ADPCM = silent.
            if e.get('codec') in ('aac', 'pcm', 'float') or \
                    e.get('audio_format') in (1, 3):
                playable += 1
        if e.get('path', '').endswith('.bsv3'):
            bsv3 += 1
        if e.get('decode_error'):
            errors += 1
    add('assets', 'assets.total', 'manifest entries', len(files))
    for t in ('image', 'anim', 'data', 'video', 'audio', 'i18n', 'font',
              'text'):
        if t in by_type:
            add('assets', 'assets.' + t, 'assets: ' + t, by_type[t])
    add('assets', 'assets.audio.pcm',
        'audio browser-playable (AAC 96k / PCM16)', playable,
        by_type.get('audio'),
        'files', {'note': 'rest are IMA ADPCM (re-encode with '
                          'tools/convert_audio_pcm.py --format aac)'})
    renderer = any('bsv3' in p.read_text(encoding='utf-8', errors='replace')
                   for p in (root / 'web/js').glob('*.js')) \
        if (root / 'web/js').is_dir() else False
    add('assets', 'assets.bsv3.rendered', 'bsv3 scenes rendered (not raw)',
        bsv3 if renderer else 0, bsv3, 'files',
        {'note': 'raw data until the canvas renderer lands'})
    add('assets', 'assets.decode_errors', 'entries with decode_error',
        errors)

    # ---------------- map -----------------------------------------------------------
    save_b = jload(root / 'data/save_buildings.json') or {}
    ids = jload(root / 'data/building_ids.json') or {}
    fp = jload(root / 'data/building_footprints.json') or {}
    chars = jload(root / 'data/character_ids.json') or {}
    add('map', 'map.buildings.resolved', 'save building ids resolved',
        len(save_b), len(ids) or None, 'ids')
    add('map', 'map.footprints', 'footprint slugs catalogued', len(fp))
    add('map', 'map.characters', 'character ids catalogued', len(chars))
    streets_db = root / 'web/api/streets.sqlite'
    ok = q1(streets_db, "SELECT COUNT(*) FROM streets "
                        "WHERE verdict='ok'", 0) or 0
    tot = q1(streets_db, 'SELECT COUNT(*) FROM streets', 0) or 0
    add('map', 'map.streets.ok', 'candidate streets validated ok', ok,
        tot or None, 'streets')
    reg = root / 'mapdump/registration'
    ev = sum(1 for p in reg.iterdir() if p.is_file()) if reg.is_dir() else 0
    add('map', 'map.evidence', 'registration evidence files', ev)
    pbs = list((root / 'mapdump').glob('*.pb')) if (root / 'mapdump'
                                                    ).is_dir() else []
    add('map', 'map.save', 'decoded city saves (.pb)', len(pbs))
    return m, coverage


# ---- main ------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--root', default=str(Path(__file__).resolve().parent.parent))
    ap.add_argument('--db', default=None,
                    help='SQLite path (default: <root>/web/api/progress.sqlite)')
    ap.add_argument('--note', default='', help='snapshot note')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args(argv)
    root = Path(a.root)
    dbp = Path(a.db) if a.db else root / 'web/api/progress.sqlite'

    meters, coverage = collect(root)

    if a.dry_run:
        for r in meters:
            print('%-9s %-28s %6s / %-'
                  '-6s %s' % (r[0], r[1], r[3], r[4] if r[4] is not None
                              else '', r[2]))
        print('coverage rows: %d' % len(coverage))
        return 0

    dbp.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(dbp)
    con.executescript(SCHEMA)
    con.execute('INSERT INTO snapshots(note) VALUES (?)', (a.note,))
    sid = con.execute('SELECT last_insert_rowid()').fetchone()[0]
    con.executemany(
        'INSERT INTO metrics(snapshot_id,section,key,label,num,den,unit,detail)'
        ' VALUES (?,?,?,?,?,?,?,?)',
        [(sid,) + r for r in meters])
    con.execute('DELETE FROM coverage')
    con.executemany(
        'INSERT INTO coverage(bundle,downloaded,indexed,unpacked,packs,season)'
        ' VALUES (?,?,?,?,?,?)',
        [(c['bundle'], c['downloaded'], c['indexed'], c['unpacked'],
          c['packs'], c['season']) for c in coverage])
    if con.execute('SELECT COUNT(*) FROM tasks').fetchone()[0] == 0:
        con.executemany(
            'INSERT INTO tasks(title,kind,status,source,notes,ord)'
            ' VALUES (?,?,?,?,?,?)',
            [(t[0], t[1], t[2], t[3], t[4], i)
             for i, t in enumerate(SEED_TASKS)])
        print('seeded %d tasks from notes/03' % len(SEED_TASKS))
    con.commit()
    con.close()

    print('snapshot #%d at %s -> %s' % (
        sid,
        __import__('datetime').datetime.now(
            __import__('datetime').timezone.utc).isoformat(),
        dbp))
    last = None
    for r in meters:
        if r[0] != last:
            print('\n[%s]' % r[0])
            last = r[0]
        pct = (' %5.1f%%' % (100.0 * r[3] / r[4])) if r[4] else ''
        print('  %-30s %6d%s%s' % (r[2], r[3],
                                   (' / %-6d' % r[4]) if r[4] else '', pct))
    return 0


if __name__ == '__main__':
    sys.exit(main())
