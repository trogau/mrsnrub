#!/usr/bin/env python3
"""Headless smoke suite for the progress tracker (2026-10-18).

Builds a tiny fixture project tree in a temp dir, runs
tools/progress_scan.py against it into a throwaway DB, asserts the meters
and the coverage grid, then exercises web/api/progress.php via the PHP CLI
(PROGRESS_DB + PROGRESS_TEST_BODY, same trick as streets.php): GET shape,
task add/update/delete, journal log, and input validation. No browser, no
network, no writes to the real web/api/progress.sqlite.

  python3 tools/smoke-progress.py
"""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
FAILS = []


def check(cond, msg):
    if cond:
        print('  ok   ' + msg)
    else:
        print('  FAIL ' + msg)
        FAILS.append(msg)


def build_fixture(root):
    (root / 'cdn').mkdir(parents=True)
    (root / 'cdn/1_0_4.7z').write_bytes(b'x')
    (root / 'cdn/2_3_0.7z').write_bytes(b'x')
    (root / 'cdn/file-urls.txt').write_text(
        'https://cdn.projectspringfield.com/static/S/f-a.zip\n'
        'https://cdn.projectspringfield.com/static/S/f-b.zip\n')
    (root / 'cdn/v469-packages.json').write_text(json.dumps([
        {'file': '3_0_30:game-100-v3_0_30-r157326-B8353263.zip', 'dir': 'dlc'},
        {'file': 'other-menu-ipad-r1.zip', 'dir': 'dlc'},
    ]))
    # minimal CDN Explorer DB (same table shapes the real one has)
    con = sqlite3.connect(root / 'cdn/cdn-explorer.db')
    con.executescript('''
        CREATE TABLE sources (id INTEGER PRIMARY KEY, kind TEXT,
            name TEXT UNIQUE, path TEXT, size INTEGER,
            scan_state TEXT DEFAULT 'pending', scanned_at TEXT, notes TEXT);
        CREATE TABLE files (id INTEGER PRIMARY KEY, source_id INTEGER,
            cdn_path TEXT, status TEXT DEFAULT 'unknown');
        CREATE TABLE entries (id INTEGER PRIMARY KEY, parent_id INTEGER,
            entry_path TEXT, status TEXT DEFAULT 'unknown');
        CREATE TABLE formats (name TEXT PRIMARY KEY, magic TEXT,
            container TEXT, doc TEXT, decoder TEXT);
        CREATE TABLE findings (id INTEGER PRIMARY KEY, target TEXT,
            target_id INTEGER, kind TEXT, summary TEXT, body TEXT);
    ''')
    con.execute("INSERT INTO sources(kind,name,path,scan_state)"
                " VALUES ('archive7z','1_0_4.7z','p','done')")
    con.execute("INSERT INTO sources(kind,name,path,scan_state)"
                " VALUES ('archive7z','2_3_0.7z','p','pending')")
    con.execute('INSERT INTO files(source_id,cdn_path,status) VALUES (1,"a","unknown")')
    con.execute('INSERT INTO files(source_id,cdn_path,status) VALUES (1,"b","unknown")')
    con.execute('INSERT INTO files(source_id,cdn_path,status) VALUES (1,"c","identified")')
    con.execute('INSERT INTO entries(parent_id,entry_path) VALUES (1,"x")')
    con.execute("INSERT INTO formats(name,magic,decoder) VALUES ('rgb','BGrm','x')")
    con.execute("INSERT INTO formats(name) VALUES ('bsv3')")
    con.execute("INSERT INTO findings(target,target_id,kind,summary)"
                " VALUES ('file',1,'magic','m')")
    con.commit()
    con.close()

    dlc = root / 'web/assets/dlc'
    (dlc / 'game-100-r157326').mkdir(parents=True)
    (dlc / 'other-pack-iphone-r5').mkdir(parents=True)
    manifest = {'files': [
        {'path': 'images/a.png', 'type': 'image'},
        {'path': 'dlc/game-100-r157326/images/b.png', 'type': 'image',
         'dlc': {'pack': 'game-100-r157326',
                 'url': 'https://archive.org/download/tsto-cdn-content/cdn/1_0_4.7z'}},
        {'path': 'dlc/game-100-r157326/data/pylon.bsv3', 'type': 'data',
         'dlc': {'pack': 'game-100-r157326',
                 'url': 'https://archive.org/download/tsto-cdn-content/cdn/1_0_4.7z'}},
        {'path': 'dlc/fan-iphone-r9/images/c.png', 'type': 'image',
         'dlc': {'pack': 'fan-iphone-r9',
                 'url': 'https://cdn.projectspringfield.com/static/S/f-a.zip'}},
        {'path': 'audio/ok.wav', 'type': 'audio', 'audio_format': 1},
        {'path': 'audio/adpcm.wav', 'type': 'audio', 'audio_format': 17},
    ]}
    (root / 'web/assets/manifest.json').write_text(json.dumps(manifest))
    (root / 'web/js').mkdir(parents=True)
    (root / 'web/js/app.js').write_text('// no building-scene renderer here')
    (root / 'web/api').mkdir(parents=True, exist_ok=True)

    re = root / 're'
    re.mkdir()
    (re / 'rtti_classes.txt').write_text('A\nB\n')
    (re / 'endpoints.txt').write_text('/games/x/one/\n/games/x/two/\n')
    (re / 'class_methods.json').write_text(
        json.dumps({'A': {'m1': [1], 'm2': [2]}, 'B': {}}))
    (re / 'proto_files.json').write_text(json.dumps(
        [{'file': 'a.proto', 'messages': [{'name': 'M', 'fields':
                                           [{'name': 'f%d' % i} for i in range(3)]}]}]))
    (re / 'syms-demangled.txt').write_text('a\nb\nc\n')
    (re / 'str_xrefs.tsv').write_text('hdr\nx\ny\n')

    (root / 'notes').mkdir()
    (root / 'notes/04-server-api.md').write_text('# api\n/games/x/one/ documented\n')

    (root / 'data').mkdir()
    (root / 'data/save_buildings.json').write_text('{"1":{},"2":{}}')
    (root / 'data/building_ids.json').write_text('{"1":{},"2":{},"3":{}}')
    (root / 'data/building_footprints.json').write_text('{"s1":{},"s2":{}}')
    (root / 'data/character_ids.json').write_text('{"c1":{}}')

    (root / 'mapdump/registration').mkdir(parents=True)
    (root / 'mapdump/registration/e1.png').write_bytes(b'x')
    (root / 'mapdump/registration/e2.png').write_bytes(b'x')
    (root / 'mapdump/save.pb').write_bytes(b'x')

    scon = sqlite3.connect(root / 'web/api/streets.sqlite')
    scon.execute('CREATE TABLE streets (id INTEGER PRIMARY KEY,'
                 ' verdict TEXT DEFAULT "pending")')
    scon.execute("INSERT INTO streets(verdict) VALUES ('ok')")
    scon.execute("INSERT INTO streets(verdict) VALUES ('pending')")
    scon.commit()
    scon.close()


def main():
    tmp = Path(tempfile.mkdtemp(prefix='smoke-progress-'))
    try:
        root = tmp / 'proj'
        build_fixture(root)
        db = tmp / 'progress.sqlite'

        print('== scan fixture ==')
        r = subprocess.run(
            [sys.executable, str(HERE / 'progress_scan.py'),
             '--root', str(root), '--db', str(db), '--note', 'smoke'],
            capture_output=True, text=True)
        check(r.returncode == 0, 'scanner exits 0 (%s)' % r.stderr[-200:])

        con = sqlite3.connect(db)
        con.row_factory = sqlite3.Row

        def met(key):
            row = con.execute('SELECT num,den FROM metrics WHERE key=?',
                              (key,)).fetchone()
            return (row['num'], row['den']) if row else None

        check(met('bundles.downloaded') == (2, 510),
              'bundles.downloaded 2/510 (%s)' % (met('bundles.downloaded'),))
        check(met('bundles.indexed') == (1, 2), 'bundles.indexed 1/2')
        check(met('bundles.unpacked') == (0, 2), 'bundles.unpacked 0/2')
        check(met('packages.decoded') == (1, 2),
              'v469 stem match: 1/2 (%s)' % (met('packages.decoded'),))
        off = con.execute("SELECT detail FROM metrics WHERE key="
                          "'packs.offindex'").fetchone()
        check(off and 'other-pack-iphone' in off['detail'],
              'off-index pack identified')
        check(met('fancdn.downloaded') == (1, 2), 'fan-CDN 1/2')
        check(met('files.unknown') == (2, 3), 'files.unknown 2/3')
        check(met('files.identified') == (1, 3), 'files.identified 1/3')
        check(met('registry.decoders') == (1, 2), 'registry decoders 1/2')
        check(met('findings.count') == (1, None), 'findings 1')
        check(met('re.methods') == (2, None), 'methods 2')
        check(met('re.proto_fields') == (3, None), 'proto fields 3')
        check(met('re.xrefs') == (2, None), 'xrefs 2 (header excluded)')
        check(met('api.endpoints.documented') == (1, 2),
              'documented endpoints 1/2')
        check(met('assets.audio.pcm') == (1, 2), 'PCM audio 1/2')
        check(met('assets.bsv3.rendered') == (0, 1), 'bsv3 raw 0/1')
        check(met('map.buildings.resolved') == (2, 3), 'buildings 2/3')
        check(met('map.streets.ok') == (1, 2), 'streets ok 1/2')
        check(met('map.evidence') == (2, None), 'evidence files 2')
        check(met('map.save') == (1, None), 'city save 1')

        cov = {r['bundle']: dict(r) for r in
               con.execute('SELECT * FROM coverage')}
        check('1_0_4' in cov and cov['1_0_4']['indexed'] == 1
              and cov['1_0_4']['packs'] == 1,
              'coverage: 1_0_4 indexed + 1 pack (%s)' % cov.get('1_0_4'))
        check('2_3_0' in cov and cov['2_3_0']['indexed'] == 0
              and cov['2_3_0']['packs'] == 0,
              'coverage: 2_3_0 untouched')
        ntasks = con.execute('SELECT COUNT(*) FROM tasks').fetchone()[0]
        check(ntasks == 10, 'task board seeded (%d)' % ntasks)
        con.close()

        print('== second snapshot (history/deltas) ==')
        r = subprocess.run(
            [sys.executable, str(HERE / 'progress_scan.py'),
             '--root', str(root), '--db', str(db)],
            capture_output=True, text=True)
        check(r.returncode == 0, 'rescan exits 0')
        con = sqlite3.connect(db)
        n = con.execute('SELECT COUNT(DISTINCT snapshot_id) FROM metrics'
                        ).fetchone()[0]
        con.close()
        check(n == 2, 'two snapshots retained (%d)' % n)

        php = shutil.which('php')
        if not php:
            print('  SKIP php not installed — API checks skipped')
        else:
            print('== php -l ==')
            r = subprocess.run([php, '-l', str(ROOT / 'web/api/progress.php')],
                               capture_output=True, text=True)
            check(r.returncode == 0, 'progress.php lint (%s)' % r.stdout.strip())

            print('== progress.php GET ==')
            env = dict(os.environ, PROGRESS_DB=str(db))
            env.pop('PROGRESS_TEST_BODY', None)
            r = subprocess.run([php, str(ROOT / 'web/api/progress.php')],
                               capture_output=True, text=True, env=env)
            data = json.loads(r.stdout)
            check('sections' in data and 'cdn' in data['sections'],
                  'GET serves cdn meters')
            check(len(data.get('history', {})) > 0
                  and len(next(iter(data['history'].values()))) == 2,
                  'history has 2 points per metric')
            check(len(data.get('coverage', [])) >= 2, 'coverage served')
            check(len(data.get('tasks', [])) == 10, 'tasks served')
            check(data.get('prev', {}).get('cdn|bundles.downloaded') == 2,
                  'prev snapshot deltas served')

            def post(body):
                e = dict(env, PROGRESS_TEST_BODY=json.dumps(body))
                r = subprocess.run(
                    [php, str(ROOT / 'web/api/progress.php')],
                    capture_output=True, text=True, env=e)
                return json.loads(r.stdout)

            print('== progress.php POST ==')
            a = post({'action': 'task-add', 'title': 'smoke task',
                      'kind': 'milestone'})
            check(a.get('ok') and a.get('id'), 'task-add ok')
            tid = a.get('id')
            u = post({'action': 'task-update', 'id': tid, 'status': 'doing'})
            check(u.get('ok'), 'task-update status ok')
            bad = post({'action': 'task-update', 'id': tid, 'status': 'wat'})
            check('error' in bad, 'task-update rejects bad status')
            nod = post({'action': 'task-update', 'id': 999999,
                        'status': 'done'})
            check('error' in nod, 'task-update 404s unknown id')
            d = post({'action': 'task-delete', 'id': tid})
            check(d.get('ok'), 'task-delete ok')
            d2 = post({'action': 'task-delete', 'id': tid})
            check('error' in d2, 'task-delete 404s second time')
            lg = post({'action': 'log', 'message': 'smoke note'})
            check(lg.get('ok'), 'log ok')
            g = json.loads(subprocess.run(
                [php, str(ROOT / 'web/api/progress.php')],
                capture_output=True, text=True, env=env).stdout)
            check(g['log'] and g['log'][0]['message'] == 'smoke note',
                  'journal entry served')
            check(not post({}).get('ok'), 'empty body rejected')

            print('== fresh db (no snapshots yet) ==')
            e = dict(env, PROGRESS_DB=str(tmp / 'fresh.sqlite'))
            r = subprocess.run([php, str(ROOT / 'web/api/progress.php')],
                               capture_output=True, text=True, env=e)
            check('error' in json.loads(r.stdout), 'fresh db returns helpful error')
            r = subprocess.run([php, str(ROOT / 'web/api/progress.php')],
                               capture_output=True, text=True,
                               env=dict(env, PROGRESS_DB=str(tmp / 'none.sqlite')))
            check('progress_scan' in json.loads(r.stdout).get('error', ''),
                  'missing db points at the scanner')

        print()
        if FAILS:
            print('%d FAILURE(S)' % len(FAILS))
            return 1
        print('all progress-tracker smoke checks passed')
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
