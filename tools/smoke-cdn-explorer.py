#!/usr/bin/env python3
"""
Headless smoke test for tools/cdn_explorer.py.

Builds a tiny fixture tree in a temp dir (two REAL 7z bundles built with
`7z a`, each a flat CDN-version dir of zips — one a real pack with a
hand-built .rgb, one with a hand-built bcell10, plus a plain zip and a
corrupt zip), starts the explorer server on a spare port with
--root/--db/--cache pointed at the fixture, and drives the JSON API:

  * pass-0 sources + pass-1 scans complete; files rows + naming fields
    (family/tier/season/rev/sig) match the fixture
  * .time sidecar row is tagged and linked to its parent zip
  * /open lists entries incl. nested `1`; magic auto-tag labels
  * bytes/hex round-trip against the constructed bytes
  * .rgb and .bcell previews return valid PNGs (IHDR 2x2)
  * findings CRUD persists; formats seeded; mystery grouping sane;
    pipeline-spec JSON sane
  * corrupt zip -> status=error row, JSON 409, server stays up
  * sha256 job completes with the right digest
  * KILL + restart with the same DB -> all state persists

Usage:  python3 tools/smoke-cdn-explorer.py
No network involved; only local subprocess (7z) + loopback HTTP.
"""

import hashlib
import io
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.request
import zipfile

TOOLS = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(TOOLS)
SERVER = os.path.join(TOOLS, 'cdn_explorer.py')
PYTHON = sys.executable

FAILURES = []


def check(cond, msg):
    print(('  ok  ' if cond else '  FAIL ') + msg)
    if not cond:
        FAILURES.append(msg)


def step(msg):
    print(f'-- {msg}')


def http(base, method, path, body=None, raw=False):
    req = urllib.request.Request(base + path, method=method)
    data = None
    if body is not None:
        data = json.dumps(body).encode('utf-8')
        req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, data, timeout=120) as r:
            payload = r.read()
            return r.status, (payload if raw else json.loads(payload))
    except urllib.error.HTTPError as e:
        payload = e.read()
        try:
            return e.code, json.loads(payload)
        except ValueError:
            return e.code, payload


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


# ---------------------------------------------------------------- fixtures

def make_rgb_2x2():
    # flags=0 -> 8-bit straight RGBA
    return struct.pack('<IHH', 0, 2, 2) + bytes([
        255, 0, 0, 255,   0, 255, 0, 255,
        0, 0, 255, 255,   255, 255, 0, 255])


def make_bcell_2x2():
    # bcell10, 1 record, 1 frame 2x2. Pixel bytes are VALID premultiplied
    # RGBA4444 (nibble order B,A,R,G high first): A=15 so no unpremul math.
    px = b'\xff\x0f' * 4
    return (b'bcell10' + struct.pack('<HI', 1, 0)
            + struct.pack('<fhh', 100.0, 0, 0) + b'\x00\x00\x00\x00\x20'
            + struct.pack('<HH', 2, 2) + px)


def make_pack_zip(path, files, idx_version=5):
    inner = io.BytesIO()
    with zipfile.ZipFile(inner, 'w', zipfile.ZIP_DEFLATED) as z:
        for n, b in sorted(files.items()):
            z.writestr(n, b)
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('0', b'BGrm' + struct.pack('<I', idx_version))
        z.writestr('1', inner.getvalue())


def build_fixture(fix):
    os.makedirs(os.path.join(fix, 'cdn'))
    os.makedirs(os.path.join(fix, 'web'))
    with open(os.path.join(fix, 'web', 'index.html'), 'w', encoding='utf-8') as f:
        f.write('<!doctype html><title>fixture</title>\n')
    stage = os.path.join(fix, 'stage')

    os.makedirs(os.path.join(stage, 'demo_a'))
    a = os.path.join(stage, 'demo_a')
    make_pack_zip(os.path.join(a, 'pack-a-100-v1_0_4-r7-DEADBEEF.zip'),
                  {'abe.rgb': make_rgb_2x2(), 'note.txt': b'hello pack\n'})
    with open(os.path.join(a,
                           'pack-a-100-v1_0_4-r7-DEADBEEF.zip.time'), 'wb') as f:
        f.write(b'2024-11-01 00:00:00\n')
    with zipfile.ZipFile(os.path.join(a, 'plain.zip'), 'w',
                         zipfile.ZIP_DEFLATED) as z:
        z.writestr('readme.txt', b'just a zip\n')
    with open(os.path.join(a, 'corrupt.zip'), 'wb') as f:
        f.write(b'PK\x03\x04' + b'\x00' * 100)
    subprocess.run(['7z', 'a', '-y', os.path.join(fix, 'cdn', 'bundleA.7z'),
                    'demo_a'], cwd=stage, check=True, capture_output=True)
    shutil.rmtree(os.path.join(stage, 'demo_a'))

    os.makedirs(os.path.join(stage, 'demo_b'))
    b = os.path.join(stage, 'demo_b')
    make_pack_zip(os.path.join(b, 'char-packs-50-r2.zip'),
                  {'abe_idle.bcell': make_bcell_2x2()})
    subprocess.run(['7z', 'a', '-y', os.path.join(fix, 'cdn', 'bundleB.7z'),
                    'demo_b'], cwd=stage, check=True, capture_output=True)
    shutil.rmtree(stage)


def start_server(base_args, port, log):
    proc = subprocess.Popen(
        [PYTHON, SERVER, '--port', str(port), *base_args],
        stdout=log, stderr=subprocess.STDOUT)
    return proc


def wait_health(base, proc, tries=100):
    for _ in range(tries):
        if proc.poll() is not None:
            raise RuntimeError('server exited early')
        try:
            code, d = http(base, 'GET', '/api/health')
            if code == 200 and d.get('ok'):
                return d
        except (urllib.error.URLError, ConnectionError, OSError):
            time.sleep(0.1)
    raise RuntimeError('server never became healthy')


def wait_sources_done(base, n, tries=120):
    for _ in range(tries):
        code, srcs = http(base, 'GET', '/api/sources')
        if code == 200 and len(srcs) == n \
                and all(s['scan_state'] == 'done' for s in srcs):
            return srcs
        time.sleep(0.25)
    raise RuntimeError('scans did not finish')


# ------------------------------------------------------------------- main

def main():
    shutil.which('7z') or sys.exit('SMOKE FAIL: 7z not on PATH')
    scratch = '/tmp/opencode'
    os.makedirs(scratch, exist_ok=True)
    fix = tempfile.mkdtemp(prefix='cdn-smoke.', dir=scratch)
    log = open(os.path.join(fix, 'server.log'), 'wb')
    print(f'fixture: {fix}')
    success = False
    procs = []
    try:
        step('build fixture (two 7z bundles)')
        build_fixture(fix)

        db = os.path.join(fix, 'db', 'explorer.db')
        cache = os.path.join(fix, 'cache')
        base_args = ['--root', fix, '--db', db, '--cache', cache,
                     '--host', '127.0.0.1',
                     '--bundles', 'all']
        port = free_port()
        base = f'http://127.0.0.1:{port}'

        step('start server, wait for scans')
        proc = start_server(base_args, port, log)
        procs.append(proc)
        h = wait_health(base, proc)
        check(h.get('7z'), f'health reports 7z ({h.get("7z")})')
        srcs = wait_sources_done(base, 2)
        check({s['name'] for s in srcs} == {'bundleA.7z', 'bundleB.7z'},
              'sources registered + scanned')

        step('files rows + naming parse')
        code, d = http(base, 'GET', '/api/files?per_page=500')
        check(code == 200 and d['total'] == 5,
              f"5 files listed (got {d.get('total')})")
        by_path = {r['cdn_path']: r for r in d['items']}
        pack = by_path.get('demo_a/pack-a-100-v1_0_4-r7-DEADBEEF.zip', {})
        check(pack.get('family') == 'pack-a' and pack.get('tier') == '100'
              and pack.get('season') == '1_0_4' and pack.get('revision') == '7'
              and pack.get('sig') == 'DEADBEEF'
              and pack.get('base_name') == 'pack-a',
              'naming peel: family/tier/season/rev/sig correct')
        side = by_path.get(
            'demo_a/pack-a-100-v1_0_4-r7-DEADBEEF.zip.time', {})
        check(side.get('is_sidecar') == 1 and side.get('sidecar_of')
              == pack.get('id'), 'sidecar tagged + linked to parent zip')
        bpack = by_path.get('demo_b/char-packs-50-r2.zip', {})
        check(bpack.get('family') == 'char-packs'
              and bpack.get('tier') == '50' and bpack.get('revision') == '2',
              'second bundle naming parse')

        step('open pack zip -> entries 0/1')
        code, d = http(base, 'GET', f"/api/files/{pack['id']}/open")
        check(code == 200 and d['opened'] == 2,
              f"pack zip lists 2 entries (got {code})")
        e_by_path = {e['entry_path']: e for e in d['entries']}
        check(e_by_path.get('0', {}).get('format') == 'pack-index',
              "entry '0' sniffed as BGrm pack-index")
        check(e_by_path.get('1', {}).get('format') == 'zip',
              "entry '1' sniffed as zip")

        step('open nested 1 -> asset files + magic tags')
        code, d = http(base, 'GET', f"/api/entries/{e_by_path['1']['id']}/open")
        check(code == 200, f'nested open ok (got {code})')
        n_by_path = {e['entry_path']: e for e in d['entries']}
        abe = n_by_path.get('1/abe.rgb', {})
        note = n_by_path.get('1/note.txt', {})
        check(abe.get('format') == 'rgb', '.rgb sniffed via extension+flags')
        check(note.get('format') == 'text', '.txt sniffed as text')

        step('hex + bytes round-trip')
        rgb = make_rgb_2x2()
        code, d = http(base, 'GET',
                       f"/api/entries/{abe['id']}/hex?offset=0&length=16")
        check(code == 200 and d['rows'][0][1] == rgb[:16].hex(' '),
              'hex first 16 bytes match constructed .rgb')
        code, payload = http(base, 'GET',
                             f"/api/entries/{abe['id']}/bytes?offset=8&length=8",
                             raw=True)
        check(code == 200 and payload == rgb[8:16],
              'entry bytes offset/length round-trip')
        code, payload = http(base, 'GET',
                             f"/api/files/{pack['id']}/bytes?offset=0&length=4",
                             raw=True)
        check(code == 200 and payload == b'PK\x03\x04',
              'file (member) bytes serve zip header')

        step('previews')
        code, payload = http(base, 'GET', f"/api/entries/{abe['id']}/preview",
                             raw=True)
        ihdr_ok = (code == 200 and payload[:8] == b'\x89PNG\r\n\x1a\n'
                   and payload[12:16] == b'IHDR'
                   and struct.unpack_from('>II', payload, 16) == (2, 2))
        check(ihdr_ok, '.rgb preview is a valid 2x2 PNG')
        code, payload = http(base, 'GET', f"/api/entries/{note['id']}/preview",
                             raw=True)
        check(code == 200 and payload == b'hello pack\n',
              'text preview round-trips')
        # bundle B: pack with a bcell inside
        code, d = http(base, 'GET', f"/api/files/{bpack['id']}/open")
        be = {e['entry_path']: e for e in d['entries']}
        code, d = http(base, 'GET', f"/api/entries/{be['1']['id']}/open")
        be = {e['entry_path']: e for e in d['entries']}
        bcell = be.get('1/abe_idle.bcell', {})
        check(bcell.get('format') == 'bcell', 'bcell10 sniffed')
        code, payload = http(base, 'GET',
                             f"/api/entries/{bcell['id']}/preview", raw=True)
        check(code == 200 and payload[:8] == b'\x89PNG\r\n\x1a\n'
              and struct.unpack_from('>II', payload, 16) == (2, 2),
              'bcell frame 0 renders as 2x2 PNG')
        code, payload = http(base, 'GET',
                             f"/api/entries/{be['1/abe_idle.bcell']['id']}"
                             '/bytes?offset=0&length=7', raw=True)
        check(code == 200 and payload == b'bcell10',
              'nested-entry bytes read through the nested cache')

        step('findings CRUD + formats + mystery + stats')
        code, d = http(base, 'POST', '/api/findings',
                       {'target': 'file', 'target_id': pack['id'],
                        'kind': 'magic', 'summary': 'smoke finding',
                        'body': 'evidence @ 0x00'})
        check(code == 200, 'finding created')
        fid = d['findings'][0]['id']
        code, d = http(base, 'POST', '/api/findings',
                       {'target': 'entry', 'target_id': abe['id'],
                        'kind': 'decode', 'summary': 'entry finding'})
        eid_f = d['findings'][0]['id']
        code, d = http(base, 'GET',
                       f"/api/findings?target=file&target_id={pack['id']}")
        check(any(f['id'] == fid for f in d['findings']),
              'file finding listed')
        code, d = http(base, 'DELETE', f'/api/findings/{eid_f}')
        check(code == 200, 'entry finding deleted')
        code, d = http(base, 'GET', '/api/formats')
        names = {f['name'] for f in d['formats']}
        check({'rgb', 'bcell', 'btp', 'pack-index', 'bsv3'} <= names,
              'formats seed present')
        code, d = http(base, 'GET', '/api/mystery')
        groups = {g['name']: g for g in d['groups']}
        check(groups.get('.time sidecars', {}).get('count') == 1
              and groups.get('pack-a', {}).get('count') == 1,
              'mystery groups unknown files by name pattern')
        code, d = http(base, 'GET', '/api/stats')
        check(d['files']['total'] == 5
              and d['files']['by_status'].get('unknown') == 5
              and d['sources']['done'] == 2,
              'stats counts correct')

        step('pipeline spec')
        code, d = http(base, 'GET', f"/api/pipeline-spec?file_id={pack['id']}")
        check(code == 200 and d['spec']['pack']
              == 'pack-a-100-v1_0_4-r7-DEADBEEF'
              and d['spec']['file'].endswith('pack-a-100-v1_0_4-r7-DEADBEEF.zip')
              and os.path.isfile(d['spec']['file'])
              and 'demo_a/pack-a-100-v1_0_4-r7-DEADBEEF.zip'
              in d['spec']['url'],
              'pipeline spec: cached file path + CDN url + naming')
        json.loads(d['json'])  # valid json

        step('corrupt zip is non-fatal')
        corrupt = by_path.get('demo_a/corrupt.zip', {})
        code, d = http(base, 'GET', f"/api/files/{corrupt['id']}/open")
        check(code == 409, f"corrupt zip open -> 409 (got {code})")
        code, d = http(base, 'GET', f"/api/files/{corrupt['id']}")
        check(d['file']['status'] == 'error',
              'corrupt zip row marked status=error')
        code, h2 = http(base, 'GET', '/api/health')
        check(code == 200 and h2['ok'], 'server still healthy after error')

        step('status update + sha256 job')
        plain = by_path.get('demo_a/plain.zip', {})
        code, d = http(base, 'POST', f"/api/files/{plain['id']}",
                       {'status': 'identified', 'notes': 'smoke'})
        check(code == 200 and d['file']['status'] == 'identified'
              and d['file']['notes'] == 'smoke', 'file status/notes update')
        code, plain_bytes = http(base, 'GET',
                                 f"/api/files/{plain['id']}/bytes?length=1048576",
                                 raw=True)
        expected_sha = hashlib.sha256(plain_bytes).hexdigest()
        code, d = http(base, 'GET', f"/api/files/{plain['id']}/sha256")
        check(code == 200, 'sha256 accepted')
        got = None
        for _ in range(60):
            code, d = http(base, 'GET', f"/api/files/{plain['id']}")
            if d['file']['sha256']:
                got = d['file']['sha256']
                break
            time.sleep(0.25)
        check(got == expected_sha, 'sha256 job produced correct digest')

        step('static serving')
        code, payload = http(base, 'GET', '/index.html', raw=True)
        check(code == 200 and b'fixture' in payload,
              'web/ served read-only')

        step('kill + restart -> state persists')
        proc.kill()
        proc.wait()
        log.flush()
        port2 = free_port()
        base2 = f'http://127.0.0.1:{port2}'
        log2 = open(os.path.join(fix, 'server2.log'), 'wb')
        proc2 = start_server(base_args, port2, log2)
        procs.append(proc2)
        wait_health(base2, proc2)
        try:
            wait_sources_done(base2, 2, tries=10)
            code, d = http(base2, 'GET', '/api/files?per_page=500')
            check(code == 200 and d['total'] == 5,
                  'files persist across restart')
            code, d = http(base2, 'GET',
                           f"/api/findings?target=file&target_id={pack['id']}")
            check(any(f['id'] == fid for f in d['findings']),
                  'findings persist across restart')
            code, d = http(base2, 'GET', f"/api/files/{corrupt['id']}")
            check(d['file']['status'] == 'error',
                  'error row persists across restart')
            code, d = http(base2, 'GET', f"/api/files/{plain['id']}")
            check(d['file']['status'] == 'identified'
                  and d['file']['sha256'] == expected_sha,
                  'updates + sha256 persist across restart')
        finally:
            proc2.kill()
            proc2.wait()
        success = not FAILURES
    except Exception:
        traceback.print_exc()
        raise
    finally:
        for p in procs:  # never leak a test server, even on failure
            if p.poll() is None:
                p.kill()
                try:
                    p.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
        if success:
            shutil.rmtree(fix, ignore_errors=True)
        else:
            print(f'(fixture kept for inspection: {fix})')

    print()
    if FAILURES:
        print(f'SMOKE FAIL: {len(FAILURES)} failure(s):')
        for m in FAILURES:
            print('  -', m)
        return 1
    print('SMOKE OK: cdn-explorer')
    return 0


if __name__ == '__main__':
    sys.exit(main())
