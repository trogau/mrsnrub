#!/usr/bin/env python3
"""
CDN Explorer — local reverse-engineering workbench for TSTO CDN pack bundles.

Indexes the in-scope local `.7z` preservation bundles (default: the three
user-downloaded bundles `1_0_4.7z`, `1_1_35.7z`, `3_0_30.7z`; select more
with --bundles) into a SQLite database, and serves a single-page workbench
for browsing the contents one file at a time: virtual zip/pack browsing
(including the nested `1` asset zip), hex view, previews for known formats
(.rgb/.bcell -> PNG, .btp -> JSON, text), a findings journal, a format
registry, and --dlc pipeline-spec generation for the existing decoder
pipeline.

Design (see planning/phase-1-cdn-explorer.md):

  * stdlib only (project convention), single file
  * ThreadingHTTPServer bound by default to this machine's Tailscale IPv4
    address (falls back to 127.0.0.1 when Tailscale is not up) so the
    workbench is reachable from other devices on the tailnet; the USER
    starts/stops it; --host always wins
  * one worker thread drains a jobs queue (scan-source, sha256); jobs are
    table-backed so they re-queue across restarts
  * SQLite in WAL mode; a FRESH connection per operation (sqlite3
    connections are not cross-thread safe and the GIL is released during
    queries — never share one connection across threads)
  * 7z is invoked via subprocess (no shell): `7z l -slt` for cheap
    archive-tail listings, `7z x -so` to stream one member to the cache
  * extracted members live in a disposable cache (default
    /tmp/opencode/cdn-cache, LRU-capped at ~50 files / ~1 GB)
  * the tool makes ZERO network connections; it never writes anywhere
    outside the cache dir and the database (in particular never
    web/assets/)

Decoder functions (rgb/bcell/btp/PNG writer) are imported from
tools/extract_assets.py — additive import, that file is not modified.

Usage:
    python3 tools/cdn_explorer.py [--port 8123] [--host ADDR]
                                  [--root DIR] [--db PATH] [--cache DIR]
                                  [--bundles all|1_0_4.7z,3_0_30.7z,...]
"""

import argparse
import contextlib
import hashlib
import io
import json
import os
import queue
import re
import sqlite3
import struct
import subprocess
import sys
import threading
import time
import urllib.parse
import zipfile
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TOOLS_DIR)
import extract_assets as ea  # verified decoders + pure-Python PNG writer

# --------------------------------------------------------------------------
# constants
# --------------------------------------------------------------------------

DEFAULT_BUNDLES = ('1_0_4.7z', '1_1_35.7z', '3_0_30.7z')
STATUSES = ('unknown', 'identified', 'decoded', 'skipped', 'error')
FINDING_KINDS = ('magic', 'format', 'decode', 'reference', 'decision')
BYTES_MAX = 1024 * 1024          # per /bytes request
HEX_MAX = 8192                   # per /hex request
PREVIEW_MAX = 64 * 1024 * 1024   # whole-entry read cap for previews
SNIFF_BYTES = 16
CACHE_MAX_FILES = 50
CACHE_MAX_BYTES = 1024 * 1024 * 1024
ARCHIVE_BASE_URL = 'https://archive.org/download/tsto-cdn-content/cdn/'

FORMAT_SEED = [
    # (name, magic, container, doc, decoder)
    ('rgb', 'flags 0x0000 / 0x2000 / 0x6000 (sanity-checked at sniff time)',
     'raw', 'notes/01-binary-formats.md #rgb-the-games-image-format',
     'tools/extract_assets.py::rgb_to_rgba'),
    ('bcell', '62 63 65 6c 6c 31 30  ("bcell10")', 'raw',
     'notes/01-binary-formats.md #bcell--character-sprite-animations',
     'tools/extract_assets.py::parse_bcell'),
    ('btp', '42 54 50 00  ("BTP\\0")', 'raw',
     'notes/01-binary-formats.md #btp--localized-string-packs',
     'tools/extract_assets.py::parse_btp'),
    ('bsv3', '01 03', 'raw',
     'notes/01-binary-formats.md #bsv3--building-animation-scenes', None),
    ('pack-index', '42 47 72 6d  ("BGrm")', 'zip (0/1 container, entry 0)',
     'notes/01-binary-formats.md #pack-container', None),
    ('zip', '50 4b 03 04', 'zip', None, None),
    ('png', '89 50 4e 47 0d 0a 1a 0a', 'raw', None,
     'tools/extract_assets.py::png_dims'),
    ('wav', '52 49 46 46 … 57 41 56 45  ("RIFF….WAVE", IMA-ADPCM)', 'RIFF',
     'notes/01-binary-formats.md #audio', 'tools/extract_assets.py::wav_info'),
    ('mp4', '…. 66 74 79 70  ("ftyp")', 'raw (box walk)',
     'notes/01-binary-formats.md #video-movie-packs',
     'tools/extract_assets.py::mp4_info'),
    ('text', None, 'raw', None, None),
    ('time-sidecar', None, 'raw (undecoded — open work)',
     'notes/03-open-work.md', None),
    ('fontcache', None, 'raw (undecodable — open work)',
     'notes/03-open-work.md', None),
]

# --------------------------------------------------------------------------
# pack-name grammar  (generic right-to-left peel; unparseable -> family only)
# --------------------------------------------------------------------------

TIER_TOKENS = ('retina', 'ipad3', 'ipad', 'iphone', 'wav', 'mp3', 'caf',
               '25', '50', '100')
_RE_REV = re.compile(r'-(r\d+)(?:-([0-9A-Z]{6,8}))?$')
_RE_SEASON = re.compile(r'-(v\d+(?:_\d+)+)$')
_RE_LANG = re.compile(r'-(?:[a-z]{2}-[A-Za-z]{4}|[a-z]{2})$')
_RE_TIER = re.compile(r'-(?:' + '|'.join(TIER_TOKENS) + r')$')


def parse_pack_name(name):
    """Derive naming fields from a pack zip base name (without .zip).

    Grammar: <family>[-<tier>][-<lang>][-v<season>][-r<revision>[-<sig>]]
    (movie/event names may interleave tier and lang in any order). Anything
    that doesn't peel cleanly stays in family — never dropped."""
    out = dict(base_name=None, family=None, tier=None, lang=None,
               season=None, revision=None, sig=None)
    stem = name
    m = _RE_REV.search(stem)
    if m:
        out['revision'], out['sig'] = m.group(1)[1:], m.group(2)
        stem = stem[:m.start()]
    m = _RE_SEASON.search(stem)
    if m:
        out['season'] = m.group(1)[1:]
        stem = stem[:m.start()]
    while True:
        m = _RE_LANG.search(stem)
        if m:
            out['lang'] = m.group(0)[1:]
            stem = stem[:m.start()]
            continue
        m = _RE_TIER.search(stem)
        if m:
            out['tier'] = m.group(0)[1:]
            stem = stem[:m.start()]
            continue
        break
    out['family'] = stem
    out['base_name'] = stem
    return out


# --------------------------------------------------------------------------
# 7z helpers
# --------------------------------------------------------------------------

def seven_zip():
    import shutil
    exe = shutil.which('7z') or shutil.which('7za')
    if not exe:
        raise RuntimeError('7z not found on PATH')
    return exe


def seven_zip_version():
    try:
        p = subprocess.run([seven_zip()], capture_output=True, text=True,
                           timeout=15)
    except Exception:
        return None
    for line in (p.stdout + p.stderr).splitlines():
        if '7-Zip' in line:
            return line.strip()
    return None


def list_7z(bundle_path):
    """List archive members. Returns [{'path','size'}] for files only.

    7z 26.00 `-slt` prints column-0 `Path = …` / `Size = …` blocks;
    directory entries carry `Attributes = D` and the archive's own header
    block carries `Type = 7z` — both are skipped."""
    out = subprocess.run([seven_zip(), 'l', '-slt', bundle_path],
                         capture_output=True, text=True, timeout=1800)
    if out.returncode != 0:
        raise RuntimeError(f'7z l failed ({out.returncode}): '
                           f'{out.stderr.strip()[:300]}')
    members, cur = [], None
    for line in out.stdout.splitlines():
        s = line.strip()
        if s.startswith('Path = '):
            if cur is not None:
                members.append(cur)
            cur = {'path': s[7:], 'size': None, 'is_dir': False,
                   'is_header': False}
        elif cur is not None:
            if s.startswith('Size = '):
                cur['size'] = int(s[7:]) if s[7:].strip().isdigit() else None
            elif s.startswith('Attributes = D'):
                cur['is_dir'] = True
            elif s.startswith('Type = 7z'):
                cur['is_header'] = True
    if cur is not None:
        members.append(cur)
    return [m for m in members if not m['is_dir'] and not m['is_header']]


def extract_7z_member(bundle_path, member, dest):
    """Stream one archive member to `dest` (atomic via .part + rename)."""
    part = dest + '.part'
    with open(part, 'wb') as f:
        p = subprocess.run([seven_zip(), 'x', '-so', bundle_path, member],
                           stdout=f, stderr=subprocess.PIPE)
    if p.returncode != 0:
        with contextlib.suppress(OSError):
            os.unlink(part)
        raise RuntimeError(f'7z x failed ({p.returncode}): '
                           f'{p.stderr.decode("utf-8", "replace").strip()[:300]}')
    os.replace(part, dest)
    return dest


# --------------------------------------------------------------------------
# magic sniffing (advisory — status stays unknown until a finding says so)
# --------------------------------------------------------------------------

def sniff(head, name):
    """Return (format_label, magic_hex) for a 16-byte head + member name."""
    hx = head[:SNIFF_BYTES].hex(' ')
    if head[:4] in (b'PK\x03\x04', b'PK\x05\x06', b'PK\x07\x08'):
        return 'zip', hx
    if head[:4] == b'BGrm':
        return 'pack-index', hx
    if head[:7] == b'bcell10':
        return 'bcell', hx
    if head[:4] == b'BTP\x00':
        return 'btp', hx
    if head[:8] == b'\x89PNG\r\n\x1a\n':
        return 'png', hx
    if head[:4] == b'RIFF' and head[8:12] == b'WAVE':
        return 'wav', hx
    if head[4:8] == b'ftyp':
        return 'mp4', hx
    if head[:2] == b'\x01\x03':
        return 'bsv3', hx
    if name.lower().endswith('.rgb') and len(head) >= 8:
        flags, w, h = struct.unpack_from('<IHH', head, 0)
        if (flags >> 16) & 0xFFFF in (0, 0x2000, 0x6000) \
                and 0 < w < 4096 and 0 < h < 4096:
            return 'rgb', hx
    if head and all(b in (9, 10, 13) or 32 <= b < 127 for b in head):
        return 'text', hx
    return 'unknown', hx


# --------------------------------------------------------------------------
# app
# --------------------------------------------------------------------------

def now_sql():
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


class APIError(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code
        self.msg = msg


class App:
    SCHEMA = """
CREATE TABLE IF NOT EXISTS sources (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL UNIQUE,
  path        TEXT NOT NULL,
  size        INTEGER,
  scan_state  TEXT NOT NULL DEFAULT 'pending',
  scanned_at  TEXT,
  notes       TEXT
);
CREATE TABLE IF NOT EXISTS files (
  id          INTEGER PRIMARY KEY,
  source_id   INTEGER REFERENCES sources(id),
  cdn_path    TEXT NOT NULL,
  base_name   TEXT,
  family      TEXT, tier       TEXT, lang TEXT,
  season      TEXT, revision   TEXT, sig TEXT,
  is_sidecar  INTEGER NOT NULL DEFAULT 0,
  sidecar_of  INTEGER REFERENCES files(id),
  size        INTEGER,
  sha256      TEXT,
  format      TEXT,
  status      TEXT NOT NULL DEFAULT 'unknown',
  notes       TEXT,
  UNIQUE(source_id, cdn_path)
);
CREATE INDEX IF NOT EXISTS idx_files_path    ON files(cdn_path);
CREATE INDEX IF NOT EXISTS idx_files_base    ON files(base_name);
CREATE INDEX IF NOT EXISTS idx_files_status  ON files(status);
CREATE INDEX IF NOT EXISTS idx_files_sidecar ON files(sidecar_of);
CREATE TABLE IF NOT EXISTS entries (
  id          INTEGER PRIMARY KEY,
  parent_id   INTEGER NOT NULL REFERENCES files(id),
  entry_path  TEXT NOT NULL,
  size        INTEGER,
  crc32       INTEGER,
  method      TEXT,
  magic       TEXT,
  format      TEXT,
  status      TEXT NOT NULL DEFAULT 'unknown',
  notes       TEXT,
  UNIQUE(parent_id, entry_path)
);
CREATE INDEX IF NOT EXISTS idx_entries_parent ON entries(parent_id);
CREATE TABLE IF NOT EXISTS formats (
  name       TEXT PRIMARY KEY,
  magic      TEXT,
  container  TEXT,
  doc        TEXT,
  decoder    TEXT
);
CREATE TABLE IF NOT EXISTS findings (
  id          INTEGER PRIMARY KEY,
  target      TEXT NOT NULL,
  target_id   INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  summary     TEXT NOT NULL,
  body        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_findings_target ON findings(target, target_id);
CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,
  ref         TEXT NOT NULL,
  state       TEXT NOT NULL,
  detail      TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_ref ON jobs(kind, ref);
"""

    def __init__(self, root, db_path, cache_dir, allow_bundles):
        self.root = os.path.abspath(root)
        self.cdn_dir = os.path.join(self.root, 'cdn')
        self.web_dir = os.path.join(self.root, 'web')
        self.db_path = os.path.abspath(db_path)
        self.cache_dir = os.path.abspath(cache_dir)
        self.allow = allow_bundles  # set of basenames, or None = all
        self.q = queue.Queue()
        self.worker = None

    # ------------------------------------------------------------- db
    @contextlib.contextmanager
    def db(self):
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute('PRAGMA journal_mode=WAL')
            conn.execute('PRAGMA foreign_keys=ON')
            yield conn
        finally:
            conn.close()

    def init_db(self):
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        os.makedirs(self.cache_dir, exist_ok=True)
        with self.db() as conn:
            conn.executescript(self.SCHEMA)
            for row in FORMAT_SEED:
                conn.execute(
                    'INSERT OR IGNORE INTO formats (name, magic, container,'
                    ' doc, decoder) VALUES (?,?,?,?,?)', row)
            conn.commit()
        self.register_sources()
        self._cap_cache()
        # crash recovery: re-queue anything that was mid-flight
        with self.db() as conn:
            stuck = conn.execute(
                "SELECT id, kind, ref FROM jobs WHERE state='running'"
            ).fetchall()
            conn.execute("UPDATE jobs SET state='queued', detail='re-queued "
                         "after restart', updated_at=? WHERE state='running'",
                         (now_sql(),))
            pending = conn.execute(
                "SELECT id FROM sources WHERE scan_state != 'done'"
            ).fetchall()
            conn.commit()
        for r in stuck:
            self.q.put((r['id'], r['kind'], r['ref']))
        for s in pending:
            self.enqueue('scan-source', str(s['id']))

    def register_sources(self):
        if not os.path.isdir(self.cdn_dir):
            return
        names = sorted(os.listdir(self.cdn_dir))
        for name in names:
            if not name.endswith('.7z'):
                continue
            if self.allow is not None and name not in self.allow:
                continue
            path = os.path.join(self.cdn_dir, name)
            try:
                size = os.path.getsize(path)
            except OSError:
                continue
            with self.db() as conn:
                conn.execute(
                    'INSERT INTO sources (kind, name, path, size, scan_state)'
                    ' VALUES (?,?,?,?,?) '
                    'ON CONFLICT(name) DO UPDATE SET path=excluded.path,'
                    ' size=excluded.size',
                    ('archive7z', name, path, size, 'pending'))
                conn.commit()

    # ---------------------------------------------------------- cache
    def _safe(self, s):
        return s.replace('/', '__')

    def member_cache_path(self, source_name, cdn_path):
        return os.path.join(self.cache_dir, source_name,
                            self._safe(cdn_path))

    def nested_cache_path(self, source_name, cdn_path, entry_prefix):
        return os.path.join(self.cache_dir, source_name,
                            self._safe(cdn_path) + '#' + self._safe(entry_prefix))

    def ensure_member(self, src, cdn_path):
        """Ensure the bundle member is extracted into the cache; return path."""
        p = self.member_cache_path(src['name'], cdn_path)
        if os.path.isfile(p) and os.path.getsize(p) > 0:
            return p
        os.makedirs(os.path.dirname(p), exist_ok=True)
        extract_7z_member(src['path'], cdn_path, p)
        self._cap_cache()
        return p

    def _cap_cache(self):
        try:
            items = []
            for dirpath, _dirnames, filenames in os.walk(self.cache_dir):
                for fn in filenames:
                    if fn.endswith('.part'):
                        continue
                    fp = os.path.join(dirpath, fn)
                    with contextlib.suppress(OSError):
                        st = os.stat(fp)
                        items.append((st.st_mtime, fp, st.st_size))
            items.sort(reverse=True)  # newest first
            kept_n = kept_b = 0
            for mtime, fp, size in items:
                if kept_n >= CACHE_MAX_FILES or kept_b >= CACHE_MAX_BYTES:
                    with contextlib.suppress(OSError):
                        os.unlink(fp)
                else:
                    kept_n += 1
                    kept_b += size
        except Exception as e:
            print(f'[cache] cap pass failed: {e}', file=sys.stderr)

    def cache_stats(self):
        n = b = 0
        for dirpath, _d, filenames in os.walk(self.cache_dir):
            for fn in filenames:
                if fn.endswith('.part'):
                    continue
                with contextlib.suppress(OSError):
                    st = os.stat(os.path.join(dirpath, fn))
                    n += 1
                    b += st.st_size
        return n, b

    # --------------------------------------------------------- jobs
    def enqueue(self, kind, ref):
        with self.db() as conn:
            dup = conn.execute(
                "SELECT id FROM jobs WHERE kind=? AND ref=? AND state IN"
                " ('queued','running')", (kind, ref)).fetchone()
            if dup:
                return dup['id']
            cur = conn.execute(
                "INSERT INTO jobs (kind, ref, state) VALUES (?,?, 'queued')",
                (kind, ref))
            job_id = cur.lastrowid
            conn.commit()
        self.q.put((job_id, kind, ref))
        return job_id

    def start_worker(self):
        self.worker = threading.Thread(target=self._work, name='cdn-worker',
                                       daemon=True)
        self.worker.start()

    def _work(self):
        while True:
            job_id, kind, ref = self.q.get()
            with self.db() as conn:
                conn.execute("UPDATE jobs SET state='running', updated_at=?"
                             " WHERE id=?", (now_sql(), job_id))
                conn.commit()
            try:
                if kind == 'scan-source':
                    self._job_scan(int(ref))
                elif kind == 'sha256':
                    self._job_sha256(int(ref))
                else:
                    raise RuntimeError(f'unknown job kind {kind!r}')
                with self.db() as conn:
                    conn.execute("UPDATE jobs SET state='done', updated_at=?"
                                 " WHERE id=?", (now_sql(), job_id))
                    conn.commit()
            except Exception as e:
                # per-file/per-bundle failures must never kill the worker
                with self.db() as conn:
                    conn.execute("UPDATE jobs SET state='error', detail=?"
                                 ", updated_at=? WHERE id=?",
                                 (str(e)[:500], now_sql(), job_id))
                    conn.commit()
                print(f'[worker] job {kind} {ref} failed: {e}',
                      file=sys.stderr)

    def _job_scan(self, source_id):
        with self.db() as conn:
            src = conn.execute('SELECT * FROM sources WHERE id=?',
                               (source_id,)).fetchone()
            if not src:
                raise RuntimeError(f'source {source_id} gone')
            conn.execute("UPDATE sources SET scan_state='listing',"
                         " scanned_at=NULL WHERE id=?", (src['id'],))
            conn.commit()
            members = list_7z(src['path'])
            # wipe previous rows for this source (scan is idempotent)
            conn.execute("DELETE FROM findings WHERE target='file' AND"
                         " target_id IN (SELECT id FROM files WHERE"
                         " source_id=?)", (src['id'],))
            conn.execute("DELETE FROM findings WHERE target='entry' AND"
                         " target_id IN (SELECT id FROM entries WHERE"
                         " parent_id IN (SELECT id FROM files WHERE"
                         " source_id=?))", (src['id'],))
            conn.execute("DELETE FROM entries WHERE parent_id IN (SELECT id"
                         " FROM files WHERE source_id=?)", (src['id'],))
            conn.execute("DELETE FROM files WHERE source_id=?", (src['id'],))
            for m in members:
                path = m['path']
                name = os.path.basename(path)
                is_side = 1 if name.endswith('.time') else 0
                stem = name[:-5] if is_side else name
                if stem.endswith('.zip'):
                    stem = stem[:-4]
                elif '.' in stem:
                    stem = stem.rsplit('.', 1)[0]
                parsed = parse_pack_name(stem)
                conn.execute(
                    'INSERT INTO files (source_id, cdn_path, base_name,'
                    ' family, tier, lang, season, revision, sig, is_sidecar,'
                    ' size, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                    (src['id'], path, parsed['base_name'], parsed['family'],
                     parsed['tier'], parsed['lang'], parsed['season'],
                     parsed['revision'], parsed['sig'], is_side,
                     m['size'], 'unknown'))
            # link .time sidecars to their parent zip (same source)
            conn.execute(
                'UPDATE files SET sidecar_of = (SELECT p.id FROM files p'
                ' WHERE p.source_id = files.source_id AND'
                " p.cdn_path = substr(files.cdn_path, 1,"
                " length(files.cdn_path)-5) LIMIT 1) WHERE is_sidecar = 1")
            conn.execute("UPDATE sources SET scan_state='done', scanned_at=?"
                         ", notes=? WHERE id=?",
                         (now_sql(), f'{len(members)} files listed',
                          src['id']))
            conn.commit()
            print(f'[scan] {src["name"]}: {len(members)} files',
                  file=sys.stderr)

    def _job_sha256(self, file_id):
        with self.db() as conn:
            frow = conn.execute('SELECT * FROM files WHERE id=?',
                                (file_id,)).fetchone()
            if not frow:
                raise RuntimeError(f'file {file_id} gone')
            src = conn.execute('SELECT * FROM sources WHERE id=?',
                               (frow['source_id'],)).fetchone()
            if not src:
                raise RuntimeError(f'source for file {file_id} gone')
        p = self.ensure_member(src, frow['cdn_path'])
        h = hashlib.sha256()
        with open(p, 'rb') as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b''):
                h.update(chunk)
        digest = h.hexdigest()
        with self.db() as conn:
            conn.execute('UPDATE files SET sha256=? WHERE id=?',
                         (digest, file_id))
            conn.execute("UPDATE jobs SET detail=? WHERE kind='sha256' AND"
                         " ref=? AND state='running'",
                         (digest, str(file_id)))
            conn.commit()

    # ------------------------------------------------- virtual FS
    def _get_source(self, conn, source_id):
        src = conn.execute('SELECT * FROM sources WHERE id=?',
                           (source_id,)).fetchone()
        if not src:
            raise APIError(404, 'source not found')
        return src

    def _get_file(self, conn, file_id):
        frow = conn.execute('SELECT * FROM files WHERE id=?',
                            (file_id,)).fetchone()
        if not frow:
            raise APIError(404, 'file not found')
        return frow

    def _get_entry(self, conn, entry_id):
        erow = conn.execute('SELECT * FROM entries WHERE id=?',
                            (entry_id,)).fetchone()
        if not erow:
            raise APIError(404, 'entry not found')
        return erow

    def container_for_entry(self, frow, src, entry_path):
        """Ensure the member + every nested zip on the path to entry_path is
        cached. Returns (zip_path, leaf_name_in_that_zip)."""
        member = self.ensure_member(src, frow['cdn_path'])
        zpath, leaf = member, entry_path
        parts = entry_path.split('/')
        for i in range(1, len(parts)):
            prefix = '/'.join(parts[:i])
            npath = self.nested_cache_path(src['name'], frow['cdn_path'],
                                           prefix)
            if not os.path.isfile(npath):
                with zipfile.ZipFile(zpath) as zf:
                    data = zf.read(prefix)
                tmp = npath + '.part'
                with open(tmp, 'wb') as f:
                    f.write(data)
                os.replace(tmp, npath)
                if not zipfile.is_zipfile(npath):
                    raise APIError(409, f'entry {prefix!r} is not a zip')
                self._cap_cache()
            zpath, leaf = npath, '/'.join(parts[i:])
        return zpath, leaf

    def read_entry_bytes(self, frow, src, entry_path, offset, length):
        zpath, leaf = self.container_for_entry(frow, src, entry_path)
        with zipfile.ZipFile(zpath) as zf:
            with zf.open(leaf) as fh:
                if offset:
                    fh.seek(offset)
                return fh.read(length)

    def open_file_zip(self, conn, frow):
        """List a CDN zip's entries (pass 2). Returns the entry rows."""
        if not frow['cdn_path'].endswith('.zip'):
            raise APIError(409, 'not a zip (use bytes/hex instead)')
        src = self._get_source(conn, frow['source_id'])
        try:
            cpath = self.ensure_member(src, frow['cdn_path'])
            zf = zipfile.ZipFile(cpath)
        except (zipfile.BadZipFile, RuntimeError) as e:
            conn.execute("UPDATE files SET status='error', notes=?"
                         " WHERE id=?",
                         (f'corrupt zip: {e}'[:400], frow['id']))
            conn.commit()
            raise APIError(409, f'corrupt zip: {e}')
        with zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                try:
                    head = zf.open(info).read(SNIFF_BYTES)
                except Exception:
                    head = b''
                label, hx = sniff(head, info.filename)
                method = {0: 'stored', 8: 'deflate'}.get(info.compress_type,
                                                         str(info.compress_type))
                conn.execute(
                    'INSERT INTO entries (parent_id, entry_path, size, crc32,'
                    ' method, magic, format) VALUES (?,?,?,?,?,?,?) '
                    'ON CONFLICT(parent_id, entry_path) DO UPDATE SET'
                    ' size=excluded.size, crc32=excluded.crc32,'
                    ' method=excluded.method, magic=excluded.magic,'
                    ' format=excluded.format',
                    (frow['id'], info.filename, info.file_size, info.CRC,
                     method, hx, label))
        conn.commit()
        return conn.execute(
            'SELECT * FROM entries WHERE parent_id=? ORDER BY entry_path',
            (frow['id'],)).fetchall()

    def open_entry_zip(self, conn, erow):
        """Open an entry that is itself a zip (e.g. pack entry `1`).

        The entry's bytes are read out of their container, hoisted into the
        nested cache, and listed from there (subsequent bytes/hex/preview
        reads then use the cached copy)."""
        frow = self._get_file(conn, erow['parent_id'])
        src = self._get_source(conn, frow['source_id'])
        try:
            zpath, leaf = self.container_for_entry(frow, src,
                                                   erow['entry_path'])
            with zipfile.ZipFile(zpath) as zf:
                data = zf.read(leaf)
        except (zipfile.BadZipFile, RuntimeError, KeyError) as e:
            conn.execute("UPDATE entries SET status='error', notes=?"
                         " WHERE id=?", (f'bad nested zip: {e}'[:400],
                                         erow['id']))
            conn.commit()
            raise APIError(409, f'bad nested zip: {e}')
        if not zipfile.is_zipfile(io.BytesIO(data)):
            conn.execute("UPDATE entries SET status='error', notes=?"
                         " WHERE id=?", ('not a zip', erow['id']))
            conn.commit()
            raise APIError(409, 'not a zip')
        npath = self.nested_cache_path(src['name'], frow['cdn_path'],
                                       erow['entry_path'])
        if not os.path.isfile(npath):
            tmp = npath + '.part'
            with open(tmp, 'wb') as f:
                f.write(data)
            os.replace(tmp, npath)
            self._cap_cache()
        with zipfile.ZipFile(npath) as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                child = f"{erow['entry_path']}/{info.filename}"
                try:
                    head = zf.open(info).read(SNIFF_BYTES)
                except Exception:
                    head = b''
                label, hx = sniff(head, info.filename)
                method = {0: 'stored', 8: 'deflate'}.get(info.compress_type,
                                                         str(info.compress_type))
                conn.execute(
                    'INSERT INTO entries (parent_id, entry_path, size, crc32,'
                    ' method, magic, format) VALUES (?,?,?,?,?,?,?) '
                    'ON CONFLICT(parent_id, entry_path) DO UPDATE SET'
                    ' size=excluded.size, crc32=excluded.crc32,'
                    ' method=excluded.method, magic=excluded.magic,'
                    ' format=excluded.format',
                    (frow['id'], child, info.file_size, info.CRC, method,
                     hx, label))
        conn.commit()
        return conn.execute(
            'SELECT * FROM entries WHERE parent_id=? AND entry_path LIKE ?'
            ' ORDER BY entry_path',
            (frow['id'], erow['entry_path'] + '/%')).fetchall()

    def entry_preview(self, conn, erow):
        """Return (bytes, content_type) for a previewable entry, or raise
        APIError(415)."""
        frow = self._get_file(conn, erow['parent_id'])
        src = self._get_source(conn, frow['source_id'])
        zpath, leaf = self.container_for_entry(frow, src, erow['entry_path'])
        with zipfile.ZipFile(zpath) as zf:
            if zf.getinfo(leaf).file_size > PREVIEW_MAX:
                raise APIError(413, 'entry too large for preview')
            data = zf.read(leaf)
        name = erow['entry_path'].lower()
        if name.endswith('.rgb'):
            w, h, _bpp, rgba, _premul = ea.rgb_to_rgba(data, erow['entry_path'])
            return ea.png_bytes(w, h, rgba), 'image/png'
        if name.endswith('.bcell'):
            _records, blocks = ea.parse_bcell(data, erow['entry_path'])
            if not blocks:
                raise APIError(415, 'bcell has no frame blocks')
            w, h, px = blocks[0]
            return ea.png_bytes(w, h, ea._unpremul4444(px)), 'image/png'
        if name.endswith('.png'):
            return data, 'image/png'
        if name.endswith('.btp'):
            strings = ea.parse_btp(data, erow['entry_path'])
            body = (json.dumps(strings, ensure_ascii=False, indent=1)
                    + '\n').encode('utf-8')
            return body, 'text/plain; charset=utf-8'
        if name.endswith(('.xml', '.txt', '.json', '.fsh', '.vsh', '.html',
                          '.csv')) or erow['format'] == 'text':
            return data.decode('utf-8', 'replace')[:500000].encode('utf-8'), \
                'text/plain; charset=utf-8'
        raise APIError(415, 'no preview for this format (use the hex view)')


# --------------------------------------------------------------------------
# HTTP layer
# --------------------------------------------------------------------------

def row_json(r):
    return {k: r[k] for k in r.keys()} if r is not None else None


class Handler(BaseHTTPRequestHandler):
    app = None          # set before serve_forever
    server_version = 'CDNExplorer/1.0'

    # -- plumbing --------------------------------------------------------
    def log_message(self, fmt, *args):
        print(f'[{self.address_string()}] {fmt % args}', file=sys.stderr)

    def _send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_raw(self, data, ctype, code=200):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_error_json(self, code, msg):
        self._send_json({'error': msg}, code)

    def _read_body_json(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n > 1024 * 1024:
            raise APIError(413, 'body too large')
        raw = self.rfile.read(n) if n else b'{}'
        try:
            return json.loads(raw.decode('utf-8'))
        except (ValueError, UnicodeDecodeError):
            raise APIError(400, 'body must be JSON')

    def _dispatch(self, method):
        parsed = urllib.parse.urlsplit(self.path)
        path = urllib.parse.unquote(parsed.path)
        query = urllib.parse.parse_qs(parsed.query)
        body = self._read_body_json() if method in ('POST',) else {}
        for m, pattern, fn in self.routes():
            if m != method:
                continue
            mm = re.fullmatch(pattern, path)
            if not mm:
                continue
            try:
                result = fn(self, mm.groups(), query, body)
                if result is None:
                    return
                if isinstance(result, tuple) and len(result) == 2 \
                        and isinstance(result[1], str) and '/' in result[1]:
                    self._send_raw(result[0], result[1])
                else:
                    self._send_json(result)
            except APIError as e:
                self._send_error_json(e.code, e.msg)
            except Exception as e:
                import traceback
                traceback.print_exc()
                self._send_error_json(500, f'{type(e).__name__}: {e}')
            return
        if method == 'GET' and (path == '/' or path == ''):
            self.send_response(302)
            self.send_header('Location', '/cdn-explorer.html')
            self.end_headers()
            return
        if method == 'GET':
            self._serve_static(path)
            return
        self._send_error_json(404, f'no route {method} {path}')

    # -- static ----------------------------------------------------------
    _STATIC_TYPES = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.json': 'application/json',
        '.txt': 'text/plain; charset=utf-8',
        '.ico': 'image/x-icon',
        '.ttf': 'font/ttf',
        '.otf': 'font/otf',
    }

    def _serve_static(self, path):
        if os.path.isdir(self.app.web_dir):
            base = os.path.realpath(self.app.web_dir)
            full = os.path.realpath(os.path.join(base, path.lstrip('/')))
            if (full == base or full.startswith(base + os.sep)) \
                    and os.path.isfile(full):
                ext = os.path.splitext(full)[1].lower()
                with open(full, 'rb') as f:
                    self._send_raw(f.read(), self._STATIC_TYPES.get(
                        ext, 'application/octet-stream'))
                return
        self._send_error_json(404, f'not found: {path}')

    # -- routes ----------------------------------------------------------
    def routes(self):
        H = __class__
        return [
            ('GET', r'^/api/health$', H.h_health),
            ('GET', r'^/api/sources$', H.h_sources),
            ('POST', r'^/api/sources/(\d+)/scan$', H.h_source_scan),
            ('GET', r'^/api/jobs$', H.h_jobs),
            ('GET', r'^/api/files$', H.h_files_list),
            ('GET', r'^/api/files/(\d+)$', H.h_file),
            ('POST', r'^/api/files/(\d+)$', H.h_file_update),
            ('GET', r'^/api/files/(\d+)/open$', H.h_file_open),
            ('GET', r'^/api/files/(\d+)/bytes$', H.h_file_bytes),
            ('GET', r'^/api/files/(\d+)/sha256$', H.h_file_sha256),
            ('GET', r'^/api/entries$', H.h_entries_list),
            ('POST', r'^/api/entries/(\d+)$', H.h_entry_update),
            ('GET', r'^/api/entries/(\d+)/open$', H.h_entry_open),
            ('GET', r'^/api/entries/(\d+)/bytes$', H.h_entry_bytes),
            ('GET', r'^/api/entries/(\d+)/hex$', H.h_entry_hex),
            ('GET', r'^/api/entries/(\d+)/preview$', H.h_entry_preview),
            ('GET', r'^/api/stats$', H.h_stats),
            ('GET', r'^/api/formats$', H.h_formats_get),
            ('POST', r'^/api/formats$', H.h_formats_post),
            ('GET', r'^/api/findings$', H.h_findings_get),
            ('POST', r'^/api/findings$', H.h_findings_post),
            ('DELETE', r'^/api/findings/(\d+)$', H.h_findings_delete),
            ('GET', r'^/api/mystery$', H.h_mystery),
            ('GET', r'^/api/pipeline-spec$', H.h_pipeline_spec),
        ]

    def do_GET(self):
        self._dispatch('GET')

    def do_POST(self):
        self._dispatch('POST')

    def do_DELETE(self):
        self._dispatch('DELETE')

    # -- API handlers ------------------------------------------------------
    def h_health(self, _g, _q, _b):
        n, b = self.app.cache_stats()
        with self.app.db() as conn:
            nsrc = conn.execute('SELECT COUNT(*) c FROM sources').fetchone()['c']
            nfil = conn.execute('SELECT COUNT(*) c FROM files').fetchone()['c']
            nent = conn.execute('SELECT COUNT(*) c FROM entries').fetchone()['c']
        return {'ok': True,
                'python': sys.version.split()[0],
                '7z': seven_zip_version(),
                'db': self.app.db_path,
                'cache_files': n, 'cache_bytes': b,
                'sources': nsrc, 'files': nfil, 'entries': nent}

    def h_sources(self, _g, _q, _b):
        with self.app.db() as conn:
            rows = conn.execute(
                'SELECT s.*, (SELECT COUNT(*) FROM files f WHERE'
                ' f.source_id = s.id) AS file_count FROM sources s'
                ' ORDER BY s.name').fetchall()
            return [row_json(r) for r in rows]

    def h_source_scan(self, g, _q, _b):
        with self.app.db() as conn:
            self.app._get_source(conn, int(g[0]))
            n = self.app.enqueue('scan-source', g[0])
        return {'queued': n}

    def h_jobs(self, _g, _q, _b):
        with self.app.db() as conn:
            rows = conn.execute(
                'SELECT * FROM jobs ORDER BY id DESC LIMIT 30').fetchall()
            active = conn.execute(
                "SELECT COUNT(*) c FROM jobs WHERE state IN"
                " ('queued','running')").fetchone()['c']
            return {'active': active,
                    'jobs': [row_json(r) for r in rows]}

    def h_files_list(self, _g, q, _b):
        sql = ('SELECT f.*, s.name AS source_name FROM files f JOIN sources'
               ' s ON s.id = f.source_id WHERE 1=1')
        args = []
        if q.get('source'):
            sql += ' AND f.source_id = ?'
            args.append(int(q['source'][0]))
        if q.get('prefix'):
            sql += ' AND f.cdn_path LIKE ?'
            args.append(q['prefix'][0] + '%')
        for col in ('family', 'tier', 'status', 'format'):
            if q.get(col):
                sql += f' AND f.{col} = ?'
                args.append(q[col][0])
        if q.get('sidecar'):
            sql += ' AND f.is_sidecar = ?'
            args.append(int(q['sidecar'][0]))
        if q.get('q'):
            like = f"%{q['q'][0]}%"
            sql += (' AND (f.cdn_path LIKE ? OR f.base_name LIKE ? OR'
                    ' f.notes LIKE ?)')
            args += [like, like, like]
        sql += ' ORDER BY f.cdn_path'
        page = max(1, int(q.get('page', ['1'])[0]))
        per = min(1000, max(1, int(q.get('per_page', ['200'])[0])))
        with self.app.db() as conn:
            count_sql = ('SELECT COUNT(*) c FROM (' +
                         sql.replace('SELECT f.*, s.name AS source_name',
                                     'SELECT 1') + ')')
            total = conn.execute(count_sql, args).fetchone()['c']
            rows = conn.execute(sql + f' LIMIT {per} OFFSET {(page - 1) * per}',
                                args).fetchall()
            return {'total': total, 'page': page, 'per_page': per,
                    'items': [row_json(r) for r in rows]}

    def h_file(self, g, _q, _b):
        fid = int(g[0])
        with self.app.db() as conn:
            frow = self.app._get_file(conn, fid)
            src = conn.execute('SELECT * FROM sources WHERE id=?',
                               (frow['source_id'],)).fetchone()
            entries = conn.execute(
                'SELECT * FROM entries WHERE parent_id=? ORDER BY'
                ' entry_path', (fid,)).fetchall()
            sidecars = conn.execute(
                'SELECT * FROM files WHERE sidecar_of=? ORDER BY cdn_path',
                (fid,)).fetchall()
            generations = []
            if frow['family'] and not frow['is_sidecar']:
                # same logical pack = family + tier + lang, across
                # revisions/bundles (NULL-safe: IS, not =)
                generations = conn.execute(
                    'SELECT f.*, s.name AS source_name FROM files f JOIN'
                    ' sources s ON s.id=f.source_id WHERE f.is_sidecar=0'
                    ' AND f.family IS ? AND f.tier IS ? AND f.lang IS ?'
                    ' ORDER BY f.cdn_path',
                    (frow['family'], frow['tier'], frow['lang'])).fetchall()
            findings = conn.execute(
                'SELECT * FROM findings WHERE target=? AND target_id=?'
                ' ORDER BY id DESC LIMIT 10', ('file', fid)).fetchall()
            return {'file': row_json(frow),
                    'source': row_json(src),
                    'entries': [row_json(r) for r in entries],
                    'sidecars': [row_json(r) for r in sidecars],
                    'generations': [row_json(r) for r in generations],
                    'findings': [row_json(r) for r in findings]}

    def h_file_update(self, g, _q, b):
        fid = int(g[0])
        sets, args = [], []
        if 'status' in b:
            if b['status'] not in STATUSES:
                raise APIError(400, f'status must be one of {STATUSES}')
            sets.append('status=?')
            args.append(b['status'])
        if 'format' in b:
            sets.append('format=?')
            args.append(b['format'])
        if 'notes' in b:
            sets.append('notes=?')
            args.append(b['notes'])
        if not sets:
            raise APIError(400, 'nothing to update')
        args.append(fid)
        with self.app.db() as conn:
            self.app._get_file(conn, fid)
            cur = conn.execute(f'UPDATE files SET {", ".join(sets)} WHERE'
                               f' id=?', args)
            conn.commit()
            if cur.rowcount != 1:
                raise APIError(404, 'file not found')
        return self.h_file((str(fid),), {}, {})

    def h_file_open(self, g, _q, _b):
        fid = int(g[0])
        with self.app.db() as conn:
            frow = self.app._get_file(conn, fid)
            rows = self.app.open_file_zip(conn, frow)
            return {'file_id': fid,
                    'opened': len(rows),
                    'entries': [row_json(r) for r in rows]}

    def h_file_bytes(self, g, q, _b):
        offset = max(0, int(q.get('offset', ['0'])[0]))
        length = min(BYTES_MAX, max(1, int(q.get('length', [str(BYTES_MAX)])[0])))
        with self.app.db() as conn:
            frow = self.app._get_file(conn, int(g[0]))
            src = self.app._get_source(conn, frow['source_id'])
        p = self.app.ensure_member(src, frow['cdn_path'])
        with open(p, 'rb') as f:
            f.seek(offset)
            data = f.read(length)
        return data, 'application/octet-stream'

    def h_file_sha256(self, g, _q, _b):
        fid = int(g[0])
        with self.app.db() as conn:
            frow = self.app._get_file(conn, fid)
            if frow['sha256']:
                return {'sha256': frow['sha256'], 'state': 'done'}
        job = self.app.enqueue('sha256', str(fid))
        return {'sha256': None, 'state': 'queued', 'job': job}

    def h_entries_list(self, _g, q, _b):
        with self.app.db() as conn:
            rows = conn.execute(
                'SELECT * FROM entries WHERE parent_id=? ORDER BY entry_path',
                (int(q['file_id'][0]),)).fetchall() if q.get('file_id') else []
            return {'entries': [row_json(r) for r in rows]}

    def h_entry_update(self, g, _q, b):
        eid = int(g[0])
        sets, args = [], []
        if 'status' in b:
            if b['status'] not in STATUSES:
                raise APIError(400, f'status must be one of {STATUSES}')
            sets.append('status=?')
            args.append(b['status'])
        if 'format' in b:
            sets.append('format=?')
            args.append(b['format'])
        if 'notes' in b:
            sets.append('notes=?')
            args.append(b['notes'])
        if not sets:
            raise APIError(400, 'nothing to update')
        args.append(eid)
        with self.app.db() as conn:
            self.app._get_entry(conn, eid)
            conn.execute(f'UPDATE entries SET {", ".join(sets)} WHERE id=?',
                         args)
            conn.commit()
        return {'updated': eid}

    def h_entry_open(self, g, _q, _b):
        eid = int(g[0])
        with self.app.db() as conn:
            erow = self.app._get_entry(conn, eid)
            rows = self.app.open_entry_zip(conn, erow)
            return {'parent_file_id': erow['parent_id'],
                    'opened': len(rows),
                    'entries': [row_json(r) for r in rows]}

    def _entry_ctx(self, conn, eid):
        erow = self.app._get_entry(conn, eid)
        frow = self.app._get_file(conn, erow['parent_id'])
        src = self.app._get_source(conn, frow['source_id'])
        return erow, frow, src

    def h_entry_bytes(self, g, q, _b):
        offset = max(0, int(q.get('offset', ['0'])[0]))
        length = min(BYTES_MAX, max(1, int(q.get('length', [str(BYTES_MAX)])[0])))
        with self.app.db() as conn:
            erow, frow, src = self._entry_ctx(conn, int(g[0]))
        data = self.app.read_entry_bytes(frow, src, erow['entry_path'],
                                         offset, length)
        return data, 'application/octet-stream'

    def h_entry_hex(self, g, q, _b):
        offset = max(0, int(q.get('offset', ['0'])[0]))
        length = min(HEX_MAX, max(16, int(q.get('length', ['256'])[0])))
        with self.app.db() as conn:
            erow, frow, src = self._entry_ctx(conn, int(g[0]))
        data = self.app.read_entry_bytes(frow, src, erow['entry_path'],
                                         offset, length)
        rows = []
        for i in range(0, len(data), 16):
            chunk = data[i:i + 16]
            rows.append([i, ' '.join(f'{b:02x}' for b in chunk),
                         ''.join(chr(b) if 32 <= b < 127 else '.' for b in
                                 chunk)])
        return {'offset': offset, 'rows': rows}

    def h_entry_preview(self, g, _q, _b):
        with self.app.db() as conn:
            erow, frow, src = self._entry_ctx(conn, int(g[0]))
            data, ctype = self.app.entry_preview(conn, erow)
        return data, ctype

    def h_stats(self, _g, _q, _b):
        with self.app.db() as conn:
            src = conn.execute(
                'SELECT COUNT(*) t, SUM(CASE WHEN scan_state=\'done\' THEN 1'
                ' ELSE 0 END) d FROM sources').fetchone()
            by_status = {r['status']: r['c'] for r in conn.execute(
                'SELECT status, COUNT(*) c FROM files GROUP BY status')}
            by_format = {r['f']: r['c'] for r in conn.execute(
                "SELECT COALESCE(format,'(none)') f, COUNT(*) c FROM files"
                ' GROUP BY f ORDER BY c DESC LIMIT 12')}
            side = conn.execute(
                'SELECT COUNT(*) c FROM files WHERE is_sidecar=1'
            ).fetchone()['c']
            nfiles = conn.execute('SELECT COUNT(*) c FROM files').fetchone()['c']
            nent = conn.execute('SELECT COUNT(*) c FROM entries').fetchone()['c']
            nfind = conn.execute('SELECT COUNT(*) c FROM findings').fetchone()['c']
            active = conn.execute(
                "SELECT COUNT(*) c FROM jobs WHERE state IN"
                " ('queued','running')").fetchone()['c']
            return {'sources': {'total': src['t'], 'done': src['d'] or 0},
                    'files': {'total': nfiles, 'by_status': by_status,
                              'by_format': by_format, 'sidecars': side},
                    'entries': nent, 'findings': nfind, 'active_jobs': active}

    def h_formats_get(self, _g, _q, _b):
        with self.app.db() as conn:
            rows = conn.execute('SELECT * FROM formats ORDER BY name'
                                ).fetchall()
            return {'formats': [row_json(r) for r in rows]}

    def h_formats_post(self, _g, _q, b):
        name = (b.get('name') or '').strip()
        if not name:
            raise APIError(400, 'name required')
        with self.app.db() as conn:
            conn.execute(
                'INSERT INTO formats (name, magic, container, doc, decoder)'
                ' VALUES (?,?,?,?,?) '
                'ON CONFLICT(name) DO UPDATE SET magic=excluded.magic,'
                ' container=excluded.container, doc=excluded.doc,'
                ' decoder=excluded.decoder',
                (name, b.get('magic'), b.get('container'), b.get('doc'),
                 b.get('decoder')))
            conn.commit()
        return {'upserted': name}

    def h_findings_get(self, _g, q, _b):
        sql = 'SELECT * FROM findings'
        args = []
        if q.get('target'):
            sql += ' WHERE target=? AND target_id=?'
            args = [q['target'][0], int(q['target_id'][0])]
        sql += ' ORDER BY id DESC LIMIT 500'
        with self.app.db() as conn:
            rows = conn.execute(sql, args).fetchall()
            return {'findings': [row_json(r) for r in rows]}

    def h_findings_post(self, _g, _q, b):
        target = b.get('target')
        kind = b.get('kind')
        summary = (b.get('summary') or '').strip()
        if target not in ('file', 'entry'):
            raise APIError(400, "target must be 'file' or 'entry'")
        if kind not in FINDING_KINDS:
            raise APIError(400, f'kind must be one of {FINDING_KINDS}')
        if not summary:
            raise APIError(400, 'summary required')
        target_id = int(b.get('target_id') or 0)
        with self.app.db() as conn:
            table = 'files' if target == 'file' else 'entries'
            if not conn.execute(f'SELECT 1 FROM {table} WHERE id=?',
                                (target_id,)).fetchone():
                raise APIError(404, f'{target} {target_id} not found')
            cur = conn.execute(
                'INSERT INTO findings (target, target_id, kind, summary,'
                ' body) VALUES (?,?,?,?,?)',
                (target, target_id, kind, summary, b.get('body')))
            conn.commit()
            fid = cur.lastrowid
        return self.h_findings_get((), {'target': [target],
                                        'target_id': [str(target_id)]}, {})

    def h_findings_delete(self, g, _q, _b):
        with self.app.db() as conn:
            cur = conn.execute('DELETE FROM findings WHERE id=?', (int(g[0]),))
            conn.commit()
            if cur.rowcount != 1:
                raise APIError(404, 'finding not found')
        return {'deleted': int(g[0])}

    def h_mystery(self, _g, _q, _b):
        """Name-driven next-target picker: unknown files grouped by
        family (name pattern); sidecars get their own group."""
        with self.app.db() as conn:
            rows = conn.execute(
                'SELECT f.*, s.name AS source_name FROM files f JOIN sources'
                ' s ON s.id=f.source_id WHERE f.status=\'unknown\''
                ' ORDER BY f.cdn_path').fetchall()
        groups = {}

        def g(key):
            return groups.setdefault(key, {'name': key, 'count': 0,
                                            'bytes': 0, 'sources': set(),
                                            'samples': [], 'tiers': set(),
                                            'langs': set(),
                                            'seasons': set()})
        for r in rows:
            if r['is_sidecar']:
                grp = g('.time sidecars')
            else:
                grp = g(r['family'] or '(untagged)')
            grp['count'] += 1
            grp['bytes'] += r['size'] or 0
            grp['sources'].add(r['source_name'])
            if len(grp['samples']) < 4:
                grp['samples'].append(r['cdn_path'])
            if r['tier']:
                grp['tiers'].add(r['tier'])
            if r['lang']:
                grp['langs'].add(r['lang'])
            if r['season']:
                grp['seasons'].add(r['season'])
        out = [{'name': v['name'], 'count': v['count'], 'bytes': v['bytes'],
                'sources': sorted(v['sources']), 'samples': v['samples'],
                'tiers': sorted(v['tiers']), 'langs': sorted(v['langs']),
                'seasons': sorted(v['seasons'])}
               for v in groups.values()]
        out.sort(key=lambda x: (-x['count'], x['name']))
        return {'unknown_total': len(rows), 'groups': out}

    def h_pipeline_spec(self, _g, q, _b):
        fid = int(q.get('file_id', [0])[0] or 0)
        with self.app.db() as conn:
            frow = self.app._get_file(conn, fid)
            src = self.app._get_source(conn, frow['source_id'])
        if not frow['cdn_path'].endswith('.zip'):
            raise APIError(409, 'pipeline spec only makes sense for zips')
        cpath = self.app.ensure_member(src, frow['cdn_path'])
        pack = os.path.basename(frow['cdn_path'])[:-4]
        spec = {'file': cpath,
                'url': ARCHIVE_BASE_URL + frow['cdn_path'],
                'pack': pack,
                'family': frow['family'],
                'season': frow['season'],
                'tier': frow['tier'],
                'revision': frow['revision']}
        spec = {k: v for k, v in spec.items() if v is not None}
        return {'spec': spec, 'json': json.dumps(spec, indent=1)}


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def tailscale_ip():
    """This machine's Tailscale IPv4 address, or None if unavailable.

    Prefers `tailscale ip -4` (authoritative when the daemon is up); falls
    back to parsing the tailscale0 interface directly."""
    try:
        p = subprocess.run(['tailscale', 'ip', '-4'], capture_output=True,
                           text=True, timeout=10)
        if p.returncode == 0 and p.stdout.strip():
            return p.stdout.strip().splitlines()[0].strip()
    except (OSError, subprocess.TimeoutExpired):
        pass
    try:
        out = subprocess.run(['ip', '-4', '-o', 'addr', 'show', 'dev',
                              'tailscale0'],
                             capture_output=True, text=True, timeout=10)
        m = re.search(r'inet (\d+\.\d+\.\d+\.\d+)', out.stdout)
        if m:
            return m.group(1)
    except (OSError, subprocess.TimeoutExpired):
        pass
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument('--port', type=int, default=8123)
    ap.add_argument('--host', default=None,
                    help='bind address (default: this machine\'s Tailscale '
                         'IPv4, else 127.0.0.1)')
    ap.add_argument('--root', default=REPO_ROOT,
                    help='project root (contains cdn/ and web/)')
    ap.add_argument('--db', default=None,
                    help='SQLite path (default <root>/cdn/cdn-explorer.db)')
    ap.add_argument('--cache', default='/tmp/opencode/cdn-cache',
                    help='disposable member cache dir')
    ap.add_argument('--bundles', default=','.join(DEFAULT_BUNDLES),
                    help="comma-separated .7z basenames to index, or 'all'")
    args = ap.parse_args()

    allow = None if args.bundles.strip().lower() == 'all' \
        else {s.strip() for s in args.bundles.split(',') if s.strip()}
    app = App(args.root,
              args.db or os.path.join(args.root, 'cdn', 'cdn-explorer.db'),
              args.cache, allow)
    app.init_db()
    app.start_worker()
    if args.host:
        host, host_src = args.host, 'explicit --host'
    else:
        ts = tailscale_ip()
        host, host_src = (ts, 'Tailscale') if ts \
            else ('127.0.0.1', 'loopback fallback (no Tailscale address found)')
    Handler.app = app
    httpd = ThreadingHTTPServer((host, args.port), Handler)
    httpd.daemon_threads = True
    print(f'CDN Explorer on http://{host}:{args.port}/cdn-explorer.html')
    print(f'  db     {app.db_path}')
    print(f'  cache  {app.cache_dir}')
    print(f'  bundles {sorted(allow) if allow else "all of cdn/*.7z"}')
    print(f'  bind   {host} ({host_src}); makes no outbound network '
          'connections. Ctrl-C to stop.')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\nstopping')
    finally:
        httpd.server_close()


if __name__ == '__main__':
    main()
