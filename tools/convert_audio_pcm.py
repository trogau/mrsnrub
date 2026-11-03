#!/usr/bin/env python3
"""convert_audio_pcm.py — re-encode the pipeline's IMA ADPCM WAVs for the web.

Two output formats:

  --format pcm   IMA ADPCM -> PCM16 WAV (the original fix, still supported)
  --format aac   IMA ADPCM (or PCM16) -> AAC-LC 96k in .m4a — what the web
                 build plays now: 25-30 % of the WAV size, so the browser has
                 a quarter of the bytes to fetch before it can start, which is
                 most of the "the beginning of the sound is missing" report.
                 AAC-LC also measured best in the codec bake-off
                 (32.7/35.2/43.7 dB against the WAV, vs ~25.8 dB for MP3 96k).
                 Renames audio/x.wav -> audio/x.m4a, so the manifest "path"
                 field of the affected entries is re-stamped too and
                 php tools/build_assets_db.php has to run afterwards.

Browsers decode only PCM / IEEE-float WAV, so every fmt-tag-17 (IMA ADPCM)
file the extraction pipeline emits is silent in the web build: <audio>'s
play() promise rejects with NotSupportedError. That is "no sound anywhere"
on the game page and "(autoplay blocked)" in the Asset Explorer — nothing
to do with autoplay policy (see notes/01-binary-formats.md, 'Audio').

The game ships these files IMA ADPCM, written by FFmpeg itself (ISFT Lavf
tag in the LIST/INFO chunk), so the reference decoder is ffmpeg and this
tool shells out to it. The extraction pipeline itself stays pure-stdlib:
ffmpeg is only needed when the audio corpus changes, never for image or
animation runs.

    ffmpeg -nostdin -loglevel error -i in.wav -map_metadata -1 \
           -c:a pcm_s16le -f wav -y out.wav
    ffmpeg -nostdin -loglevel error -i in.wav -map_metadata -1 \
           -c:a aac -b:a 96k -movflags +faststart -y out.m4a

Safety:
  * PCM mode only touches fmt-tag-17 files, so re-running is a no-op (the 67
    already-PCM16 CDN ambient loops are skipped); AAC mode takes every WAV
    that is not already a .m4a, so it is a no-op once the corpus is AAC;
  * the pre-conversion file is copied to var/audio-adpcm/ (IMA ADPCM) or
    var/audio-pcm/ (a WAV with no ADPCM original, i.e. the CDN loops) before
    it is replaced, and --restore puts it back and deletes the .m4a, so the
    corpus is restorable without re-running the multi-hour extraction;
  * the ffmpeg output is verified before it replaces the original: PCM with
    the stdlib `wave` module (16-bit, same rate/channels, frame count
    matching the ADPCM block arithmetic), AAC by decoding it back to s16le
    and checking codec, rate, channels, frame count and that it is not pure
    silence — a bad run leaves the source file alone and lands in the report
    instead;
  * PCM mode never changes filenames. AAC mode renames x.wav to x.m4a and
    re-stamps the manifest "path" of those entries, so the SQLite index has
    to be rebuilt afterwards (op=original still serves the ADPCM original
    from the backup tree either way).

Metadata: manifest.json + manifest-parts/*.js are patched in place for the
converted entries (path, audio_format, codec, bytes, duration_s). Duration
comes from the decoded frame count, NOT the RIFF `fact` chunk, which is off
for these files (verified: fact reports 10 205 samples for 5 blocks of
blockalign 1024, i.e. 2 041 samples/block = (blockalign - 4) * 2 + 1).

Usage:
  python3 tools/convert_audio_pcm.py [--web=web] [--dry-run] [--limit N]
                                    [--only GLOB] [-P N] [--no-keep]
                                    [--no-manifest] [--report PATH]
                                    [--format pcm|aac] [--bitrate 96k]
  python3 tools/convert_audio_pcm.py --restore [--web=web] [-P N]
  python3 tools/convert_audio_pcm.py --restamp [--web=web] [--only GLOB]

  --only GLOB    restrict to files whose path (relative to web/assets)
                 matches GLOB, e.g. --only 'audio/0*' (repeatable)
  --no-keep      skip the var/ backups (not recommended)
  --no-manifest  convert the files but leave the manifest untouched
  --format       pcm (default) = ADPCM -> PCM16 WAV; aac = anything playable
                 -> AAC-LC .m4a (renames the file)
  --bitrate      AAC bitrate, default 96k
  --restore      copy the backups back over web/assets, delete the .m4a that
                 replaced them, and re-stamp the manifest entries from the
                 restored files' headers
  --restamp      repair the manifest audio fields from the audio files on
                 disk (no conversion) — use after editing audio by hand

After a conversion, rebuild the explorer index:
  php tools/build_assets_db.php
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import wave
from multiprocessing import Pool

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FFMPEG = os.environ.get('FFMPEG', 'ffmpeg')
FFPROBE = os.environ.get('FFPROBE', 'ffprobe')
PCM_CODEC_MAP = {1: 'pcm', 3: 'float', 17: 'ima-adpcm'}
AUDIO_EXTS = ('.wav', '.m4a')
AAC_CODEC = 'aac'
AAC_EXT = '.m4a'
AAC_DEFAULT_BITRATE = '96k'


def say(s: str) -> None:
    print(s, file=sys.stderr, flush=True)


# --------------------------------------------------------------- RIFF probe
def probe(path: str) -> dict | None:
    """Parse a WAV header. Returns None when it is not a readable RIFF/WAVE.

    frames is the PCM frame count the file holds (or should hold, for
    ADPCM): block arithmetic for tag 17, byte arithmetic for tag 1/3.
    """
    try:
        with open(path, 'rb') as f:
            head = f.read(8192)
    except OSError:
        return None
    if head[:4] != b'RIFF' or head[8:12] != b'WAVE':
        return None
    off, fmt, data, fact = 12, None, None, None
    while off + 8 <= len(head):
        cid, csize = struct.unpack_from('<4sI', head, off)
        body = off + 8
        if cid == b'fmt ' and body + 16 <= len(head):
            fmt = struct.unpack_from('<HHIIHH', head, body)
        elif cid == b'fact' and csize >= 4 and body + 4 <= len(head):
            fact = struct.unpack_from('<I', head, body)[0]
        elif cid == b'data':
            data = csize
        off = body + csize + (csize & 1)
    if not fmt or data is None:
        return None
    tag, channels, rate, byterate, blockalign, bits = fmt
    if tag == 17:
        if blockalign <= 4:
            return None
        per_block = (blockalign - 4) * 2 + 1     # mono IMA: 2 041 at 1 024
        blocks, rest = divmod(data, blockalign)
        frames = blocks * per_block
        if rest > 4:
            frames += (rest - 4) * 2 + 1
    else:
        per_frame = max(1, channels * (bits // 8))
        frames = data // per_frame
    return {'tag': tag, 'channels': channels, 'rate': rate, 'byterate': byterate,
            'blockalign': blockalign, 'bits': bits, 'data': data,
            'frames': frames, 'fact': fact}


# ------------------------------------------------------------------ convert
def convert_one(job: dict) -> dict:
    """ffmpeg one ADPCM WAV to PCM16, verify, back up, replace.

    Runs in a worker process; must stay import-picklable (top level).
    """
    root, rel = job['web'], job['rel']
    src = os.path.join(root, 'assets', rel)
    out = {'rel': rel, 'status': 'fail', 'error': None}
    before = probe(src)
    if before is None:
        out['error'] = 'not a readable RIFF/WAVE'
        return out
    out.update(before_bytes=os.path.getsize(src), tag_before=before['tag'],
               channels=before['channels'], rate=before['rate'],
               frames_expected=before['frames'])
    if before['tag'] != 17:
        out['status'] = 'skip'
        return out

    tmp = src + '.pcm16.tmp'
    cmd = [FFMPEG, '-nostdin', '-loglevel', 'error', '-i', src,
           '-map_metadata', '-1', '-c:a', 'pcm_s16le', '-f', 'wav', '-y', tmp]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    except FileNotFoundError:
        out['error'] = f'{FFMPEG} not found (apt-get install ffmpeg)'
        return out
    except subprocess.TimeoutExpired:
        out['error'] = 'ffmpeg timed out'
        if os.path.exists(tmp):
            os.unlink(tmp)
        return out
    if r.returncode != 0:
        out['error'] = (r.stderr or '').strip()[:300] or f'ffmpeg rc={r.returncode}'
        if os.path.exists(tmp):
            os.unlink(tmp)
        return out

    # ---- verify with the stdlib decoder before touching the original ------
    try:
        with wave.open(tmp, 'rb') as w:
            ch, sw, fr, nf = (w.getnchannels(), w.getsampwidth(),
                              w.getframerate(), w.getnframes())
            peak = 0
            if nf:
                step = max(1, nf // 20000)
                for i in range(0, nf, step):
                    take = min(step, nf - i)
                    buf = w.readframes(take)
                    smp = struct.unpack('<%dh' % (len(buf) // 2), buf)
                    for v in smp:
                        v = -v if v < 0 else v
                        if v > peak:
                            peak = v
    except Exception as exc:                                # noqa: BLE001
        out['error'] = f'wave cannot read ffmpeg output: {exc}'
        os.unlink(tmp)
        return out
    if sw != 2 or ch != before['channels'] or fr != before['rate'] or nf == 0:
        out['error'] = f'unexpected PCM shape (ch={ch} rate={fr} width={sw * 8})'
        os.unlink(tmp)
        return out
    if peak == 0:
        out['error'] = 'decoded output is pure silence'
        os.unlink(tmp)
        return out
    drift = abs(nf - before['frames'])
    if drift > max(2041, int(before['frames'] * 0.02)):
        out['error'] = (f'frame count {nf} disagrees with block arithmetic '
                        f'{before["frames"]} (drift {drift})')
        os.unlink(tmp)
        return out

    if job['keep']:
        os.makedirs(os.path.dirname(os.path.join(job['backup'], rel)),
                    exist_ok=True)
        shutil.copy2(src, os.path.join(job['backup'], rel))
    os.replace(tmp, src)
    out.update(status='ok', after_bytes=os.path.getsize(src), tag_after=1,
               frames=nf, peak=peak, codec='pcm', audio_format=1,
               duration_s=round(nf / fr, 1))
    return out


# --------------------------------------------------------------------- aac
def ffprobe_audio(path: str) -> dict | None:
    """ffprobe one audio file as {codec, rate, channels, duration}; None if
    it cannot be read at all. duration is None when the container hides it."""
    try:
        r = subprocess.run(
            [FFPROBE, '-v', 'error', '-select_streams', 'a:0', '-show_entries',
             'stream=codec_name,sample_rate,channels,duration', '-of',
             'default=nw=1:nk=1', path],
            capture_output=True, text=True, timeout=120)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if r.returncode != 0:
        return None
    vals = [v for v in r.stdout.split('\n') if v != '']
    if len(vals) < 3:
        return None
    try:
        dur = float(vals[3]) if len(vals) > 3 and vals[3] != 'N/A' else None
        return {'codec': vals[0], 'rate': int(vals[1]), 'channels': int(vals[2]),
                'duration': dur}
    except ValueError:
        return None


def decode_stats(path: str, channels: int) -> dict | None:
    """Decode anything ffmpeg can to s16le: total frames and whether any of
    it is non-silent. Stops at the first non-silent sample, so the full pass
    only happens for files that really are quiet."""
    raw = path + '.dec.tmp'
    try:
        r = subprocess.run([FFMPEG, '-nostdin', '-loglevel', 'error', '-i', path,
                            '-f', 's16le', '-acodec', 'pcm_s16le', '-y', raw],
                           capture_output=True, text=True, timeout=300)
        if r.returncode != 0:
            return None
        size = os.path.getsize(raw)
        loud = False
        with open(raw, 'rb') as f:
            while not loud:
                buf = f.read(1 << 22)
                if not buf:
                    break
                loud = any(v for v in struct.unpack('<%dh' % (len(buf) // 2), buf))
        ch = max(1, channels)
        return {'frames': size // (2 * ch), 'silent': not loud}
    finally:
        if os.path.exists(raw):
            os.unlink(raw)


def keep_original(job: dict, rel: str, src: str) -> None:
    """Preserve the pre-conversion file, without ever clobbering a backup.

    The ADPCM original in var/audio-adpcm/ is the better thing to keep, so it
    wins; a WAV that never was ADPCM (the CDN ambient loops) is copied to
    var/audio-pcm/ instead, or --restore could not put it back.
    """
    if not job['keep']:
        return
    for root in (job['backup'], job.get('backup_pcm')):
        if not root:
            continue
        dest = os.path.join(root, rel)
        if os.path.exists(dest):
            return                      # already preserved by an earlier run
    dest = os.path.join(job['backup'], rel)
    if not os.path.exists(dest):
        dest = os.path.join(job['backup_pcm'], rel)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    shutil.copy2(src, dest)


def convert_one_aac(job: dict) -> dict:
    """ffmpeg one playable WAV to AAC-LC .m4a, verify, back up, rename.

    Runs in a worker process; must stay import-picklable (top level).
    """
    root, rel = job['web'], job['rel']
    src = os.path.join(root, 'assets', rel)
    dst = src[:-4] + AAC_EXT
    out = {'rel': rel, 'status': 'fail', 'error': None}
    before = probe(src)
    if before is None:
        out['error'] = 'not a readable RIFF/WAVE'
        return out
    out.update(before_bytes=os.path.getsize(src), tag_before=before['tag'],
               channels=before['channels'], rate=before['rate'],
               frames_expected=before['frames'])
    if before['tag'] not in (1, 3, 17):
        out['status'] = 'skip'
        out['error'] = f'unhandled fmt tag {before["tag"]}'
        return out

    tmp = src + '.aac.tmp'           # -f mp4 below: ffmpeg cannot guess .tmp
    cmd = [FFMPEG, '-nostdin', '-loglevel', 'error', '-i', src,
           '-map_metadata', '-1', '-c:a', 'aac', '-b:a', job['bitrate'],
           '-f', 'mp4', '-movflags', '+faststart', '-y', tmp]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    except FileNotFoundError:
        out['error'] = f'{FFMPEG} not found (apt-get install ffmpeg)'
        return out
    except subprocess.TimeoutExpired:
        out['error'] = 'ffmpeg timed out'
        if os.path.exists(tmp):
            os.unlink(tmp)
        return out
    if r.returncode != 0:
        out['error'] = (r.stderr or '').strip()[:300] or f'ffmpeg rc={r.returncode}'
        if os.path.exists(tmp):
            os.unlink(tmp)
        return out

    # ---- verify it before anything is renamed ------------------------------
    got = ffprobe_audio(tmp)
    if got is None:
        out['error'] = 'ffprobe cannot read ffmpeg output'
        os.unlink(tmp)
        return out
    if (got['codec'] != 'aac' or got['rate'] != before['rate']
            or got['channels'] != before['channels']):
        out['error'] = (f'unexpected AAC stream '
                        f"({got['codec']} {got['channels']}ch {got['rate']} Hz)")
        os.unlink(tmp)
        return out
    # +faststart has to have taken effect: with the index after the audio data
    # the browser cannot start until the whole file has arrived.
    with open(tmp, 'rb') as f:
        head = f.read(1 << 20)
    moov, mdat = head.find(b'moov'), head.find(b'mdat')
    if moov < 0 or (0 <= mdat < moov):
        out['error'] = f'moov atom not first (moov={moov} mdat={mdat})'
        os.unlink(tmp)
        return out
    st = decode_stats(tmp, before['channels'])
    if st is None:
        out['error'] = 'output does not decode'
        os.unlink(tmp)
        return out
    if st['silent']:
        out['error'] = 'decoded output is pure silence'
        os.unlink(tmp)
        return out
    # the encoder pads to whole 1024-sample frames and the container may or
    # may not describe the trimming, so allow a frame of slack either way on
    # top of the source's own partial trailing block.
    drift = abs(st['frames'] - before['frames'])
    if drift > max(4096, int(before['frames'] * 0.02)):
        out['error'] = (f'decoded frame count {st["frames"]} disagrees with '
                        f'source {before["frames"]} (drift {drift})')
        os.unlink(tmp)
        return out

    keep_original(job, rel, src)
    os.replace(tmp, dst)                # the new file lands first, so a crash
    os.unlink(src)                      # can never leave the sound missing
    out.update(status='ok', path_new=rel[:-4] + AAC_EXT,
               after_bytes=os.path.getsize(dst), codec='aac',
               decoded_frames=st['frames'],
               duration_s=round(before['frames'] / before['rate'], 1))
    return out


# ---------------------------------------------------------------- manifest
def _apply(entry: dict, upd: dict) -> None:
    """Merge upd into entry; a None value removes the key."""
    for k, v in upd.items():
        if v is None:
            entry.pop(k, None)
        else:
            entry[k] = v


def patch_parts(parts_dir: str, updates: dict) -> tuple[int, int]:
    """Rewrite the audio entries in manifest-parts/*.js. Returns (files, entries)."""
    touched = total = 0
    for name in sorted(os.listdir(parts_dir)):
        if not name.endswith('.js'):
            continue
        path = os.path.join(parts_dir, name)
        with open(path, 'rb') as f:
            raw = f.read()
        if b'"type":"audio"' not in raw:
            continue
        start, end = raw.index(b'['), raw.rindex(b']') + 1
        entries = json.loads(raw[start:end].decode('utf-8'))
        hit = 0
        for e in entries:
            u = updates.get(e.get('path'))
            if u and e.get('type') == 'audio':
                _apply(e, u)
                hit += 1
        if not hit:
            continue
        buf = (raw[:start]
               + json.dumps(entries, ensure_ascii=False,
                            separators=(',', ':')).encode('utf-8')
               + raw[end:])
        with open(path + '.tmp', 'wb') as f:
            f.write(buf)
        os.replace(path + '.tmp', path)
        touched += 1
        total += hit
    return touched, total


def _element_end(buf, start: int) -> int:
    """Index just past the JSON object that starts at buf[start] == '{'."""
    depth = 0
    i = start
    instr = esc = False
    n = len(buf)
    while i < n:
        c = buf[i]
        if instr:
            if esc:
                esc = False
            elif c == 0x5C:                                 # backslash
                esc = True
            elif c == 0x22:                                 # quote
                instr = False
        elif c == 0x22:
            instr = True
        elif c in (0x5B, 0x7B):                             # [ {
            depth += 1
        elif c in (0x5D, 0x7D):                             # ] }
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    raise ValueError('unterminated JSON element')


def patch_manifest_json(man_path: str, updates: dict) -> tuple[int, int]:
    """Rewrite the audio entries inside manifest.json's "files" array.

    Returns (entries rewritten, entries that were already correct).

    manifest.json is ~2.1 GB, so it is memory-mapped and spliced rather than
    parsed: every entry the pipeline writes starts with {"path":"<path>",
    "type":"audio", so the entries to change are located with a literal
    search, re-serialised one at a time, and the rest of the file is copied
    through byte for byte.
    """
    import mmap
    hits = []
    with open(man_path, 'rb') as f:
        size = os.fstat(f.fileno()).st_size
        mm = mmap.mmap(f.fileno(), size, access=mmap.ACCESS_READ)
        try:
            # "files" sits after the notes + dlc lists, which run to hundreds
            # of KB; grow the probe window instead of scanning the whole file.
            at, span = -1, 1 << 20
            while at < 0:
                at = mm.find(b'"files":[', 0, min(size, span))
                if at < 0:
                    if span > (1 << 26):
                        raise SystemExit('manifest.json: no "files" array')
                    span *= 4
            at += len(b'"files":[')
            end = mm.rfind(b']}')
            # manifest files[] is path-sorted and callers pass sorted paths,
            # so one forward cursor turns this into a single pass over 2.1 GB.
            cursor = at
            missing = []
            already = 0

            def locate(key):
                """(start, end, entry) for the audio entry whose "path" is
                key, looking ahead from the cursor first (cheap, monotone)
                and only then in the whole array."""
                needle = ('{"path":%s,"type":"audio"'
                          % json.dumps(key)).encode('utf-8')
                p = mm.find(needle, cursor, end)
                if p < 0:
                    p = mm.find(needle, at, end)
                if p < 0:
                    return None
                e = _element_end(mm, p)
                entry = json.loads(mm[p:e].decode('utf-8'))
                if entry.get('type') != 'audio' or entry.get('path') != key:
                    return None
                return p, e, entry

            for path in sorted(updates):
                upd = updates[path]
                # AAC runs rename the entry, so it may be filed under either
                # the old path (nothing done yet) or the new one (re-run).
                found = locate(path)
                if found is None and upd.get('path'):
                    found = locate(upd['path'])
                if found is None:
                    missing.append(path)
                    continue
                p, e, entry = found
                want = dict(entry)
                _apply(want, upd)
                new = json.dumps(want, ensure_ascii=False,
                                 separators=(',', ':')).encode('utf-8')
                cursor = e
                if new == mm[p:e]:
                    already += 1        # re-run: this one is done already
                    continue
                hits.append((p, e, new))
        finally:
            mm.close()
    if missing:
        raise SystemExit('manifest.json: %d of %d entries not found (first: '
                         '%s) — refusing to rewrite'
                         % (len(missing), len(updates), missing[0]))

    hits.sort()
    for (_p0, e0, _n0), (p1, _e1, _n1) in zip(hits, hits[1:]):
        if p1 < e0:
            raise SystemExit('manifest.json: overlapping matches — refusing '
                             'to rewrite')
    if not hits:
        return 0, already                       # nothing to splice, skip 2 GB
    tmp = man_path + '.tmp'
    with open(man_path, 'rb') as src, open(tmp, 'wb') as dst:
        cur = 0
        for p, e, new in hits:
            src.seek(cur)
            dst.write(src.read(p - cur))
            dst.write(new)
            cur = e
        src.seek(cur)
        shutil.copyfileobj(src, dst, 1 << 20)
    os.replace(tmp, man_path)
    return len(hits), already


# -------------------------------------------------------------------- main
def wav_updates(assets: str, rels: list, converted: bool | None = None) -> dict:
    """Manifest fields for each WAV, read back from its own RIFF header.

    converted=True marks the entries as re-encoded (codec_src), False marks
    them as originals again (codec_src removed), None leaves codec_src alone.
    """
    ups = {}
    for rel in rels:
        path = os.path.join(assets, rel)
        info = probe(path)
        if not info:
            continue
        u = {'audio_format': info['tag'],
             'codec': PCM_CODEC_MAP.get(info['tag'], 'unknown'),
             'bytes': os.path.getsize(path),
             'duration_s': round(info['frames'] / info['rate'], 1)}
        if converted is True:
            u['codec_src'] = 'ima-adpcm'
        elif converted is False:
            u['codec_src'] = None
        ups[rel] = u
    return ups


def aac_updates(assets: str, results: list) -> dict:
    """Manifest fields for each converted file, keyed by its OLD path.

    The 'path' field itself is part of the update: x.wav becomes x.m4a on
    disk, so the entry has to follow. codec_src stays 'ima-adpcm' only where
    an ADPCM original really is in the backup tree.
    """
    ups = {}
    for r in results:
        if r['status'] != 'ok':
            continue
        newrel = r['path_new']
        u = {'path': newrel,
             'codec': AAC_CODEC,
             'audio_format': None,          # a RIFF fmt tag means nothing here
             'bytes': r['after_bytes'],
             'duration_s': r['duration_s']}
        was_adpcm = r['tag_before'] == 17
        ups[r['rel']] = u
        if was_adpcm:
            u['codec_src'] = 'ima-adpcm'
    return ups


def list_audio(root: str) -> list:
    """Every audio file under root, relative to it, sorted."""
    out = []
    for dirpath, _dirs, names in os.walk(root):
        for n in names:
            if n.lower().endswith(AUDIO_EXTS):
                out.append(os.path.relpath(os.path.join(dirpath, n), root))
    out.sort()
    return out


def aac_stamps(assets: str, rels: list, adpcm_backup: str) -> dict:
    """Manifest fields for .m4a files already on disk (for --restamp)."""
    ups = {}
    for rel in rels:
        path = os.path.join(assets, rel)
        got = ffprobe_audio(path)
        if not got or got['codec'] != 'aac':
            continue
        u = {'codec': AAC_CODEC,
             'audio_format': None,
             'bytes': os.path.getsize(path)}
        if got['duration']:
            u['duration_s'] = round(got['duration'], 1)
        if os.path.exists(os.path.join(adpcm_backup, rel[:-len(AAC_EXT)] + '.wav')):
            u['codec_src'] = 'ima-adpcm'
        ups[rel] = u
    return ups


def apply_manifest(web: str, updates: dict) -> None:
    assets = os.path.join(web, 'assets')
    parts, hit = patch_parts(os.path.join(assets, 'manifest-parts'), updates)
    say(f'manifest-parts: {hit} entries in {parts} file(s) updated')
    n, already = patch_manifest_json(os.path.join(assets, 'manifest.json'),
                                     updates)
    say(f'manifest.json: {n} audio entries updated'
        + (f', {already} already up to date' if already else ''))
    say('next: php tools/build_assets_db.php')


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--web', default=os.path.join(REPO, 'web'))
    ap.add_argument('--backup', default=os.path.join(REPO, 'var', 'audio-adpcm'))
    ap.add_argument('--backup-pcm', dest='backup_pcm',
                    default=os.path.join(REPO, 'var', 'audio-pcm'),
                    help='where a WAV with no ADPCM original is preserved')
    ap.add_argument('--format', choices=('pcm', 'aac'), default='pcm',
                    help='pcm = ADPCM -> PCM16 WAV (default); '
                         'aac = anything playable -> AAC-LC .m4a')
    ap.add_argument('--bitrate', default=AAC_DEFAULT_BITRATE,
                    help='AAC bitrate for --format aac (default 96k)')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--only', action='append', default=[], metavar='GLOB')
    ap.add_argument('-P', '--procs', type=int, default=min(14, os.cpu_count() or 4))
    ap.add_argument('--no-keep', dest='keep', action='store_false')
    ap.add_argument('--no-manifest', dest='manifest', action='store_false')
    ap.add_argument('--report', default=None, metavar='PATH')
    ap.add_argument('--restore', action='store_true')
    ap.add_argument('--restamp', action='store_true',
                    help='re-stamp manifest audio fields from the WAVs on '
                         'disk, without converting anything')
    args = ap.parse_args()

    assets = os.path.join(args.web, 'assets')
    if not os.path.isdir(assets):
        raise SystemExit(f'no asset dir at {assets}')

    if args.restore:
        return restore(args, assets)

    if args.restamp:
        rels = list_audio(assets)
        if args.only:
            rels = [r for r in rels
                    if any(fnmatch.fnmatch(r, g) for g in args.only)]
        if args.limit:
            rels = rels[:args.limit]
        # the backup dir is the record of what was converted: an audio file
        # with a backup there used to be ADPCM, so it gets codec_src
        wavs = [r for r in rels if r.lower().endswith('.wav')]
        m4as = [r for r in rels if r.lower().endswith(AAC_EXT)]
        ups = {}
        for rel in wavs:
            was_adpcm = os.path.exists(os.path.join(args.backup, rel))
            ups.update(wav_updates(assets, [rel],
                                   converted=True if was_adpcm else None))
        ups.update(aac_stamps(assets, m4as, args.backup))
        say(f're-stamping {len(ups)} audio entries from disk '
            f'({len(wavs)} wav, {len(m4as)} m4a)')
        apply_manifest(args.web, ups)
        return 0

    files = list_audio(assets)
    if args.only:
        files = [f for f in files
                 if any(fnmatch.fnmatch(f, g) for g in args.only)]
    say(f'{len(files)} audio files under {assets}, format={args.format}')

    jobs, already, unreadable, stale = [], 0, [], []
    for rel in files:
        if rel.lower().endswith(AAC_EXT):
            # a .m4a is the end state of an AAC run; its .wav sibling should
            # be gone, and if it is not, the manifest entry was renamed already
            if os.path.exists(os.path.join(assets, rel[:-len(AAC_EXT)] + '.wav')):
                stale.append(rel)
            already += 1
            continue
        info = probe(os.path.join(assets, rel))
        if info is None:
            unreadable.append(rel)
        elif args.format == 'pcm' and info['tag'] != 17:
            already += 1
        elif args.format == 'aac' and info['tag'] not in (1, 3, 17):
            unreadable.append(rel)
        else:
            jobs.append(rel)
    if args.limit:
        jobs = jobs[:args.limit]

    est_in = sum(os.path.getsize(os.path.join(assets, r)) for r in jobs)
    est_out = 0.0
    for rel in jobs:
        info = probe(os.path.join(assets, rel))
        if args.format == 'aac':
            secs = info['frames'] / info['rate']
            kbps = int(args.bitrate.rstrip('kK')) * 1000
            est_out += secs * kbps / 8 + 1024
        else:
            est_out += info['frames'] * info['channels'] * 2 + 44
    def hum(n: float) -> str:
        return f'{n / 1e9:.2f} GB' if n >= 1e9 else f'{n / 1e6:.1f} MB'
    say(f'{len(jobs)} need converting ({hum(est_in)} -> ~'
        f'{hum(est_out)} {args.format.upper()}), {already} already in '
        f'target format, {len(unreadable)} unreadable')
    for rel in unreadable[:10]:
        say(f'  UNREADABLE {rel}')
    for rel in stale[:10]:
        say(f'  BOTH {rel} and its .wav still exist: the WAV will be re-encoded '
            f'over (idempotent), manifest already renamed')

    if args.dry_run:
        for rel in jobs[:20]:
            say(f'  would convert {rel}')
        if len(jobs) > 20:
            say(f'  ... {len(jobs) - 20} more')
        return 0

    if not jobs:
        say('nothing to do')
        return 0

    payload = [{'web': args.web, 'rel': rel, 'keep': args.keep,
                'backup': args.backup, 'backup_pcm': args.backup_pcm,
                'bitrate': args.bitrate} for rel in jobs]
    worker = convert_one_aac if args.format == 'aac' else convert_one
    results = []
    with Pool(args.procs) as pool:
        for i, res in enumerate(pool.imap_unordered(worker, payload, 16), 1):
            results.append(res)
            if i % 500 == 0 or i == len(jobs):
                say(f'  {i}/{len(jobs)} converted')
    ok = [r for r in results if r['status'] == 'ok']
    bad = [r for r in results if r['status'] == 'fail']

    if args.report:
        os.makedirs(os.path.dirname(os.path.abspath(args.report)), exist_ok=True)
        with open(args.report, 'w', encoding='utf-8') as f:
            json.dump({'ok': ok, 'failed': bad}, f, indent=1)
        say(f'report: {args.report}')

    for r in bad[:20]:
        say(f'  FAILED {r["rel"]}: {r["error"]}')
    if bad:
        say(f'{len(bad)} file(s) left untouched (originals intact)')

    if args.manifest and ok:
        if args.format == 'aac':
            apply_manifest(args.web, aac_updates(assets, ok))
        else:
            apply_manifest(args.web, {r['rel']: {'audio_format': 1,
                                                 'codec': 'pcm',
                                                 'codec_src': 'ima-adpcm',
                                                 'bytes': r['after_bytes'],
                                                 'duration_s': r['duration_s']}
                                      for r in ok})
    elif not args.manifest:
        say('manifest left untouched (--no-manifest)')

    say(f'done: {len(ok)} converted, {len(bad)} failed'
        + ('' if not args.keep else f'; originals in {args.backup}'))
    return 1 if bad else 0


def restore(args, assets: str) -> int:
    """Copy the ADPCM backups back and re-stamp the manifest from them."""
    if not os.path.isdir(args.backup):
        raise SystemExit(f'no backup dir at {args.backup}')
    # the ADPCM original is the better thing to put back, so it wins over a
    # preserved PCM16 WAV of the same name (the CDN ambient loops).
    by_rel = {}
    for root, was_adpcm in ((args.backup_pcm, False), (args.backup, True)):
        if not os.path.isdir(root):
            continue
        for dirpath, _dirs, names in os.walk(root):
            for n in names:
                if n.lower().endswith('.wav'):
                    rel = os.path.relpath(os.path.join(dirpath, n), root)
                    by_rel[rel] = (os.path.join(dirpath, n), was_adpcm)
    rels = sorted(by_rel)
    if args.only:
        rels = [r for r in rels
                if any(fnmatch.fnmatch(r, g) for g in args.only)]
    if args.limit:
        rels = rels[:args.limit]
    say(f'restoring {len(rels)} files from {args.backup}'
        f' (and {args.backup_pcm})')
    updates = {}
    for rel in rels:
        src, was_adpcm = by_rel[rel]
        dst = os.path.join(assets, rel)
        m4a_rel = rel[:-len('.wav')] + AAC_EXT
        m4a_was_there = os.path.exists(os.path.join(assets, m4a_rel))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)          # the WAV comes back first, so a crash
        if m4a_was_there:               # can never leave the sound missing
            os.unlink(os.path.join(assets, m4a_rel))
        if not args.manifest:
            continue
        u = wav_updates(assets, [rel], converted=None)[rel]
        u['path'] = rel                 # an AAC run renamed it; undo that
        u['codec_src'] = 'ima-adpcm' if was_adpcm else None
        updates[m4a_rel if m4a_was_there else rel] = u
    if args.manifest and updates:
        apply_manifest(args.web, updates)
    elif not args.manifest:
        say('manifest left untouched (--no-manifest)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
