#!/usr/bin/env python3
"""
Asset extraction pipeline for Springfield (The Simpsons: Tapped Out,
Android client v4.70.5, package com.ea.game.simpsons4_row.Springfield).

The APK bundles the game's content in proprietary packs:

    assets/<group>/<name>/0   'BGrm' index/manifest (redundant with the ZIP;
                              only its header version is recorded)
    assets/<group>/<name>/1   a standard ZIP of asset files

Formats handled:

    .rgb  [u32 flags][u16 width][u16 height][raw pixels]
          flags & 0x20000000  -> 2 bytes/px, RGBA4444 with channel order
                                B,A,R,G (high nibble first:
                                byte0 = (B<<4)|A, byte1 = (R<<4)|G)
            + flags & 0x40000000 (i.e. flag 0x6000) -> straight alpha
                                (unmultiplied colors; 3.0.30 menu
                                level-select art uses this variant)
            otherwise 4-bit  -> premultiplied, un-premultiplied on decode
          otherwise (flag 0) -> 4 bytes/px, straight RGBA
          (layout cross-checked against the tsto2rgb conversion tool and
          verified by rendering; all 3.0.30 CDN pack files match)
          -> converted to PNG (+ a ~192 px box-downsampled thumbnail in
             thumbs/ for the asset explorer grid)

    .bcell  'bcell10' [u16 n_records][u32 unknown]
            then per record (13 bytes): f32 delay_ms, i16 x_off, i16 y_off,
            5 bytes (stream coords; last record ends with 0x20)
            then one pixel block per unique frame (blocks <= n_records;
            records beyond the last block hold the final frame):
              first block:  [u16 w][u16 h]
              later blocks: [u32 0x20000000][u16 w][u16 h]
              w*h*2 bytes, same premultiplied RGBA4444 B,A,R,G as .rgb
            (verified to parse to exact EOF on all 359 files of the
            3.0.30 core pack)

    .bcell  'bcell13' [u8 ver][u16 n_frames] — 4.x character cells: the
            pixel data is EXTERNAL, in '<cell>_image_N.rgb' files shipped
            beside the cell in the same pack. Then per frame:
              [u8 name_len incl NUL] '<...>_image_N.rgb\0'
              f32 delay_ms, u32 tint (opaque; constant per source image),
              u8 0, u8 n_layers,
              then n_layers layers of:
                [u8 l1] s1\0  [u8 l2] s2\0  7 x f32
            Layer names pair up as (kind, kind+'.rgb'): the FIRST layer is
            the sprite itself (floats = x_off, y_off, scale, 0, 0, ~0.29,
            1.0 — top-left placement relative to the character engine
            origin); later layers are overlays (SHADOW / POSITION /
            INDICATOR / null — null layers carry six -2.0 floats).
            (verified to parse to exact EOF on all 13,652 bcell13 files
            of the extracted pool, 2026-10-23)
            -> one PNG per unique frame (<name>_f<N>.png) + one manifest
               entry of type 'anim' (frames/delays, char, animation)
               played back in the explorer's Animations tab

    .btp  magic 'BTP\\0' + 20-byte header (big-endian: u32 file size at
          offset 8, u32 entry count at offset 12), then entries
          (all length fields big-endian):
              [u8 name_len][name (NUL-terminated, name_len bytes)]
              [u32 str_len  (includes trailing NUL)][string]
              [u32 gap]     (absent after the final entry)
          -> converted to JSON { key: string }

    .wav / .png / .ttf / .otf / .xml / .txt / .fsh / .vsh / .html
          -> copied through as-is

All resolution variants are extracted: every splash pack
(core-splashes-{small,medium,large}) and every core UI pack
(core-{small,medium-small,medium,large}), plus the game-branded Android
shell icons from res/. The "game" class (medium splash, large UI) keeps the
pack origin name so splashscreen.xml lookups resolve; other variants are
origin-less and grouped via the manifest's family/resClass fields. Raw text
of every data/ file is embedded in data/webdata.js (dataText) so the asset
explorer can show file contents without fetch().

Usage:
    python3 tools/extract_assets.py <path/to/Springfield-V08.apk> [--out web/assets]
        [--dlc '{"file": "pack.zip", "url": "https://.../pack.zip"}' ...]

The optional --dlc flag additionally decodes DLC packs downloaded from the
fan CDN (cdn.projectspringfield.com) or the archive.org tsto-cdn-content
preservation set. They use the exact same container as APK packs
(0 = BGrm index, 1 = ZIP of asset files), so the same codecs apply.
Video packs (.mp4 cutscenes) are passed through with pure-stdlib box-walk
metadata (w/h, duration, codecs) and, when ffmpeg is installed, a JPEG
poster frame in the pack's thumbs/ dir. Character-animation packs (.bcell)
decode to per-frame PNGs plus an 'anim' manifest entry. Decoded content lands in
<out>/dlc/<pack>/, is never wiped by plain re-runs, and every manifest
entry carries dlc metadata (pack, season, tier, revision, source URL) so
the asset explorer can tag and group it. Spec overrides: "pack", "family",
"season", "tier", "revision" (useful when the pack comes out of a .7z
bundle whose URL does not name the pack).

Pure standard library; no third-party dependencies.
"""

import argparse
import datetime
import io
import json
import os
import re
import shutil
import struct
import sys
import zipfile
import zlib

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# --------------------------------------------------------------------------
# variant selection
# --------------------------------------------------------------------------
# The splash art ships in three resolutions (core-splashes-{small,medium,
# large}) and the core UI chrome + loading donut in four (core-{small,
# medium-small, medium, large}).
#
# ALL classes are extracted so the asset explorer can show everything the
# APK contains. The game itself composes a single consistent class: the
# MEDIUM splash set (the "scale 1" sizes in splashscreen.xml are the medium
# pack's native pixel sizes, design space height = 1024, verified by
# compositing) and the LARGE UI chrome (sharpness). Those "game class"
# entries keep the pack origin name so splashscreen.xml lookups resolve;
# every other variant is origin-less and is indexed via the manifest's
# `family`/`resClass` fields instead.
SPLASH_CLASSES = ('small', 'medium', 'large')
CORE_UI_CLASSES = ('small', 'medium-small', 'medium', 'large')
GAME_SPLASH_CLASS = 'medium'
GAME_UI_CLASS = 'large'
ANDROID_DENSITIES = ('mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi')
THUMB_MAX = 192      # explorer grid thumbnails (px, longest side)

SPLASH_BASES = (     # base name -> (native size in the medium class)
    'splashscreen',                        # 8192x1024 background strip
    'splash_homer',                        # 512x512
    'splashfinger',                        # 1024x512
    'signature',                           # 128x16
    'bse_titl_coppagradient',              # 4x1024
    'technicaldifficulties',               # 2048x1024
    'technicaldifficulties_leftside',      # 512x1024
)

# btp language suffix -> language code used in splashscreen.xml <Language> tags
LANGMAP = {
    'eng_us': 'en', 'fre_fr': 'fr', 'ita_it': 'it', 'ger_de': 'de',
    'spa_es': 'es', 'chs_cn': 'zh', 'kor_kr': 'kr', 'por_br': 'pt',
    'rus_ru': 'ru', 'dan_dk': 'da', 'dut_nl': 'nl', 'nor_no': 'no',
    'swe_se': 'sv', 'cht_cn': 'tc', 'tha_th': 'th', 'tur_tr': 'tr',
}

MUSIC_WAVS = {'mainmusic.wav', 'bgloop.wav', 'friendmusic.wav'}

# --------------------------------------------------------------------------
# format codecs
# --------------------------------------------------------------------------

def _png_chunk(tag, data):
    c = tag + data
    return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xFFFFFFFF)


def png_bytes(w, h, rgba):
    raw = b''.join(b'\x00' + rgba[y * w * 4:(y + 1) * w * 4] for y in range(h))
    return (b'\x89PNG\r\n\x1a\n'
            + _png_chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
            + _png_chunk(b'IDAT', zlib.compress(raw, 6))
            + _png_chunk(b'IEND', b''))


def write_png(path, w, h, rgba):
    with open(path, 'wb') as f:
        f.write(png_bytes(w, h, rgba))


def _expand4444(px, premul):
    """Expand RGBA4444 (2 bytes/px, channel order B,A,R,G, high nibble
    first: byte0 = (B<<4)|A, byte1 = (R<<4)|G) into 8-bit straight-alpha
    RGBA.

    premul=True  (header flag 0x2000): stored colors are premultiplied by
        alpha; opaque pixels (A = 15) need no division, only the
        semi-transparent subset is fixed up individually.
    premul=False (header flag 0x6000): straight alpha, colors already
        unmultiplied (c4 > a4 occurs in 88/88 affected files, which is
        impossible for premultiplied data).

    Both variants were verified on the 3.0.30 menu level-select art
    (levels_level*.rgb, unlock_lock.rgb).
    """
    b0 = px[0::2]  # (B << 4) | A
    b1 = px[1::2]  # (R << 4) | G
    t_hi = bytes((v >> 4) * 17 for v in range(256))
    t_lo = bytes((v & 15) * 17 for v in range(256))
    B = bytearray(b0.translate(t_hi))
    A = b0.translate(t_lo)
    R = bytearray(b1.translate(t_hi))
    G = bytearray(b1.translate(t_lo))
    if premul:
        for i, v in enumerate(b0):
            a = v & 15
            if a != 15:
                r4, g4, b4 = b1[i] >> 4, b1[i] & 15, v >> 4
                R[i] = (r4 * 255 // a) if a else 0
                G[i] = (g4 * 255 // a) if a else 0
                B[i] = (b4 * 255 // a) if a else 0
    n = len(b0)
    rgba = bytearray(n * 4)
    rgba[0::4] = bytes(R)
    rgba[1::4] = bytes(G)
    rgba[2::4] = bytes(B)
    rgba[3::4] = A
    return bytes(rgba)


def _unpremul4444(px):
    """Premultiplied variant, kept for the bcell frame path (bcell10
    frame blocks always carry the 0x20000000 flag)."""
    return _expand4444(px, True)


def rgb_to_rgba(rgb_bytes, src_name):
    """Decode a Bight .rgb blob. Returns (w, h, bpp, rgba, premul).

    Header: u16 (0), u16 flag, u16 w, u16 h.  Flag bits: 0x2000 = 4-bit
    sprite (premultiplied), 0x4000 = straight alpha (set together with
    0x2000 in 3.0.30 menu level-select art), 0 = 8-bit straight RGBA.
    premul is True/False for 4-bit files and None for 8-bit.  (Verified
    against the tsto2rgb conversion tool and the 3.0.30 core CDN content.)
    """
    flags, w, h = struct.unpack_from('<IHH', rgb_bytes, 0)
    flag16 = (flags >> 16) & 0xFFFF
    px = rgb_bytes[8:]
    n = w * h
    if len(px) == n * 4:
        return w, h, 4, px, None
    if len(px) == n * 2:
        premul = not (flag16 & 0x4000)
        return w, h, 2, _expand4444(px, premul), premul
    raise ValueError(f'{src_name}: unexpected .rgb payload '
                     f'({w}x{h}, {len(px)} bytes, flags={flags:#x})')


def parse_bcell(blob, src_name):
    """Parse a 'bcell10' character-animation file.

    Layout (verified against all 359 files of the 3.0.30 core pack):
      'bcell10'  u16 n_records  u32 (unknown)
      per record, 13 bytes: f32 delay_ms, i16 x_off, i16 y_off, 5 bytes
      (stream coords; the last record's final byte is 0x20)
      then one pixel block per frame, in record order (blocks <= n;
      any extra records hold the last frame):
        first block:  u16 w, u16 h
        later blocks: u32 0x20000000, u16 w, u16 h
        w*h*2 bytes of premultiplied RGBA4444 (as in .rgb 4-bit files)

    Returns (records, blocks): records = [(delay_ms, x, y, block_idx)],
    blocks = [(w, h, px4444)].
    """
    if blob[:7] != b'bcell10':
        raise ValueError(f'{src_name}: not a bcell10 file')
    n = struct.unpack_from('<H', blob, 7)[0]
    off = 13
    records = []
    for _ in range(n):
        delay, x, y = struct.unpack_from('<fhh', blob, off)
        records.append([delay, x, y, None])
        off += 13
    pos = off
    blocks = []
    while pos < len(blob):
        if blocks:
            flag, w, h = struct.unpack_from('<IHH', blob, pos)
            pos += 8
            if flag != 0x20000000:
                raise ValueError(f'{src_name}: bad frame flag '
                                 f'{flag:#x} @ {pos - 8}')
        else:
            w, h = struct.unpack_from('<HH', blob, pos)
            pos += 4
        need = w * h * 2
        if pos + need > len(blob):
            raise ValueError(f'{src_name}: truncated frame {len(blocks)}')
        blocks.append((w, h, blob[pos:pos + need]))
        pos += need
    last = len(blocks) - 1
    for i, r in enumerate(records):
        r[3] = min(i, last) if blocks else None
    return records, blocks


def parse_bcell13(blob, src_name):
    """Parse a 'bcell13' character-animation cell (4.x packs).

    Layout (verified to exact EOF on all 14,328 pool bcell13 cells,
    2026-10-25; confirmed against the tsto2rgb writer in tools/tsto2rgb):
      'bcell13' u8 ver u16 n_frames
      per frame:
        u8 name_len (incl NUL), '<...>_image_N.rgb\\0'
        f32 delay_ms, i16 x_off, i16 y_off, u8 0, u8 n_layers
        n_layers x (u8 l1 s1\\0, u8 l2 s2\\0, 7 x f32)
      x_off/y_off are the frame image's top-left relative to the
      character origin (feet on the ground line) — same convention as
      bcell10's i16 record offsets (tsto2rgb writes them as
      -w/2 + offsetX, -h + offsetY). The layers are ground overlays
      ONLY (SHADOW/POSITION/INDICATOR/null; their 7 floats are the
      overlay transform over the (kind, kind.rgb) texture pair). There
      is no sprite layer: the sprite is the frame's external image,
      drawn at scale 1.0 at (x_off, y_off).

    Returns [(delay_ms, x_off, y_off, image_name)] — pixel data lives
    in the referenced .rgb files (same pack / pool).
    """
    if blob[:7] != b'bcell13':
        raise ValueError(f'{src_name}: not a bcell13 file')
    n = struct.unpack_from('<H', blob, 8)[0]
    off = 10                      # 7 magic + u8 ver + u16 count
    out = []
    for _ in range(n):
        ln = blob[off]
        name = blob[off + 1:off + 1 + ln].split(b'\0')[0].decode('latin1')
        off += 1 + ln
        delay, x, y = struct.unpack_from('<fhh', blob, off)
        off += 8                  # delay + i16 x_off + i16 y_off
        nlayers = blob[off + 1]
        off += 2
        for _li in range(nlayers):
            l1 = blob[off]
            off += 1 + l1
            l2 = blob[off]
            off += 1 + l2
            off += 28
        out.append((delay, x, y, name))
    if off != len(blob):
        raise ValueError(f'{src_name}: bcell13 trailing bytes '
                         f'({off} != {len(blob)})')
    return out


def parse_bcell11(blob, src_name):
    """Parse a 'bcell11' character-animation cell (4.x packs).

    The sibling of bcell13: the frame pixels are ALSO external, in
    '<cell>_image_N.rgb' files beside the cell. The only structural
    difference is the per-frame header — bcell13 reads two bytes there
    (a u8 0 filler then u8 n_layers) while bcell11 reads a SINGLE u8
    n_layers, no filler. Verified to parse to exact EOF on all 413 pool
    bcell11 cells (2026-11-03); every one carries n_layers == 0 (a bare
    sprite frame, no ground overlays), so the layer walk is kept only to
    stay honest if a layered bcell11 ever turns up.

      'bcell11' u8 ver u16 n_frames
      per frame:
        u8 name_len (incl NUL), '<...>_image_N.rgb\\0'
        f32 delay_ms, i16 x_off, i16 y_off, u8 n_layers
        n_layers x (u8 l1 s1\\0, u8 l2 s2\\0, 7 x f32)
      x_off/y_off are the frame image's top-left relative to the
      character origin — the same convention as bcell13/bcell10.

    Returns [(delay_ms, x_off, y_off, image_name)] — pixel data lives in
    the referenced .rgb files (same pack / pool).
    """
    if blob[:7] != b'bcell11':
        raise ValueError(f'{src_name}: not a bcell11 file')
    n = struct.unpack_from('<H', blob, 8)[0]
    off = 10                      # 7 magic + u8 ver + u16 count
    out = []
    for _ in range(n):
        ln = blob[off]
        name = blob[off + 1:off + 1 + ln].split(b'\0')[0].decode('latin1')
        off += 1 + ln
        delay, x, y = struct.unpack_from('<fhh', blob, off)
        off += 8                  # delay + i16 x_off + i16 y_off
        nlayers = blob[off]       # bcell13 has a leading u8 0 here; bcell11 not
        off += 1
        for _li in range(nlayers):
            l1 = blob[off]
            off += 1 + l1
            l2 = blob[off]
            off += 1 + l2
            off += 28
        out.append((delay, x, y, name))
    if off != len(blob):
        raise ValueError(f'{src_name}: bcell11 trailing bytes '
                         f'({off} != {len(blob)})')
    return out


def rgb_to_png(rgb_bytes, out_path, src_name=''):
    """Convert a Bight .rgb blob to PNG. Returns (w, h, bpp)."""
    w, h, bpp, rgba, _premul = rgb_to_rgba(rgb_bytes, src_name or out_path)
    write_png(out_path, w, h, rgba)
    return w, h, bpp


def make_thumb(w, h, rgba, maxdim=THUMB_MAX):
    """Box-downsample an RGBA buffer to ~maxdim px (longest side).

    Two stages for speed in pure Python: an integer-stride (slicing)
    pre-pass down to <=400 px, then a small box average to the target.
    Returns (tw, th, rgba) or None if the source is already small enough.
    """
    k = maxdim / max(w, h)
    if k >= 1:
        return None
    pre = 400
    s = max(1, max(w, h) // pre)
    if s > 1:
        # stride-sample rows, then columns (C-speed slicing)
        rows = [rgba[y * w * 4:(y + 1) * w * 4] for y in range(0, h, s)]
        w2 = (w + s - 1) // s
        h2 = len(rows)
        buf = bytearray(w2 * h2 * 4)
        for y in range(h2):
            src = rows[y]
            for x in range(w2):
                i = (y * w2 + x) * 4
                j = min(x * s, w - 1) * 4
                buf[i:i + 4] = src[j:j + 4]
        rgba, w, h = bytes(buf), w2, h2
    k = maxdim / max(w, h)  # target for the final stage
    tw = max(1, round(w * k))
    th = max(1, round(h * k))
    out = bytearray(tw * th * 4)
    for ty in range(th):
        y0 = ty * h // th
        y1 = max(y0 + 1, (ty + 1) * h // th)
        for tx in range(tw):
            x0 = tx * w // tw
            x1 = max(x0 + 1, (tx + 1) * w // tw)
            r = g = b = a = 0
            for y in range(y0, y1):
                row = y * w * 4
                for x in range(x0, x1):
                    i = row + x * 4
                    r += rgba[i]
                    g += rgba[i + 1]
                    b += rgba[i + 2]
                    a += rgba[i + 3]
            n = (y1 - y0) * (x1 - x0)
            j = (ty * tw + tx) * 4
            out[j] = r // n
            out[j + 1] = g // n
            out[j + 2] = b // n
            out[j + 3] = a // n
    return tw, th, bytes(out)


def parse_anchor(blob):
    """'x,y' anchor sidecar text -> [x, y] ints, or None."""
    try:
        a, b = blob.decode('ascii').strip().split(',')
        return [int(a), int(b)]
    except Exception:
        return None


def parse_btp(data, src_name):
    """Parse a 'BTP' localized string pack into a dict."""
    if data[:4] != b'BTP\x00':
        raise ValueError(f'{src_name}: bad BTP magic')
    # Header fields are big-endian: u16 ver(4), u16 hdr_size(16),
    # u32 file_size, u32 entry_count; entry fields below are little-endian.
    fsize = struct.unpack_from('>I', data, 0x08)[0]
    count = struct.unpack_from('>I', data, 0x0C)[0]
    if fsize != len(data):
        print(f'  WARN {src_name}: header size {fsize} != actual {len(data)}',
              file=sys.stderr)
    off = 0x18
    out = {}
    for i in range(count):
        nlen = data[off]
        off += 1
        name = data[off:off + nlen].rstrip(b'\x00').decode('utf-8', 'replace')
        off += nlen
        slen = struct.unpack_from('>I', data, off)[0]
        off += 4
        val = data[off:off + slen].rstrip(b'\x00').decode('utf-8', 'replace')
        off += slen
        out[name] = val
        if i < count - 1:
            off += 4  # gap between entries
    if off != len(data):
        print(f'  WARN {src_name}: parsed {count} entries but stopped at '
              f'offset {off:#x} of {len(data):#x}', file=sys.stderr)
    return out


def wav_info(blob):
    """Return (audio_format, channels, sample_rate, duration_s) for a WAV.

    audio_format is the RIFF fmt tag (1 = PCM, 3 = IEEE float, 17 = IMA
    ADPCM). The pipeline currently only remuxes PCM; tag 17 files are
    flagged in the manifest so the explorer/tests can identify them."""
    if blob[:4] != b'RIFF' or blob[8:12] != b'WAVE':
        return None
    off = 12
    fmt = data = None
    while off + 8 <= len(blob):
        cid, csize = struct.unpack_from('<4sI', blob, off)
        body = off + 8
        if cid == b'fmt ':
            fmt = struct.unpack_from('<HHIIHH', blob, body)
        elif cid == b'data':
            data = csize
        off = body + csize + (csize & 1)
    if not fmt or data is None:
        return None
    tag, channels, rate, byterate, _ba, _bits = fmt
    return tag, channels, rate, data / byterate if byterate else 0.0


def png_dims(blob):
    if blob[:8] == b'\x89PNG\r\n\x1a\n':
        w, h = struct.unpack_from('>II', blob, 16)
        return w, h
    return None


def _mp4_boxes(blob, start, end):
    """Yield (fourcc, payload_start, payload_end) for each MP4 box."""
    off = start
    while off + 8 <= end:
        box = off
        size = struct.unpack_from('>I', blob, box)[0]
        fourcc = blob[box + 4:box + 8]
        hdr = 8
        if size == 1:
            if box + 16 > end:
                break
            size = struct.unpack_from('>Q', blob, box + 8)[0]
            hdr = 16
        elif size == 0:
            size = end - box
        if size < hdr or box + size > end:
            break
        yield fourcc, box + hdr, box + size
        off = box + size


def mp4_info(blob):
    """Best-effort metadata for an MP4 (pure-stdlib box walk).

    Returns a dict with keys w, h, duration_s, vcodec, acodec (each None
    when not found), or None when no moov box is present."""
    info = {'w': None, 'h': None, 'duration_s': None, 'vcodec': None,
            'acodec': None}
    moov = None
    for fourcc, ps, pe in _mp4_boxes(blob, 0, len(blob)):
        if fourcc == b'moov':
            moov = (ps, pe)
            break
    if not moov:
        return None

    def dur_at(ps):
        ver = blob[ps]
        ts = struct.unpack_from('>I', blob, ps + 12)[0]
        if not ts:
            return None
        dur = (struct.unpack_from('>I', blob, ps + 16)[0] if ver == 0
               else struct.unpack_from('>Q', blob, ps + 20)[0])
        return dur / ts

    for fourcc, ps, pe in _mp4_boxes(blob, *moov):
        if fourcc == b'mvhd':
            if info['duration_s'] is None:
                info['duration_s'] = dur_at(ps)
        elif fourcc == b'trak':
            for f2, p2s, p2e in _mp4_boxes(blob, ps, pe):
                if f2 != b'mdia':
                    continue
                for f3, p3s, p3e in _mp4_boxes(blob, p2s, p2e):
                    if f3 == b'mdhd' and info['duration_s'] is None:
                        info['duration_s'] = dur_at(p3s)
                    elif f3 == b'minf':
                        for f4, p4s, p4e in _mp4_boxes(blob, p3s, p3e):
                            if f4 != b'stbl':
                                continue
                            for f5, p5s, p5e in _mp4_boxes(blob, p4s, p4e):
                                if f5 != b'stsd' or p5e - p5s < 16:
                                    continue
                                n = struct.unpack_from('>I', blob, p5s + 4)[0]
                                es = p5s + 8
                                for _ in range(n):
                                    if es + 8 > p5e:
                                        break
                                    c = blob[es + 4:es + 8]
                                    if c in (b'avc1', b'avc3', b'mp4v', b'hev1',
                                             b'hvc1', b'vp09'):
                                        if info['vcodec'] is None:
                                            info['vcodec'] = c.decode('ascii')
                                            # VisualSampleEntry: 4 reserved +
                                            # 2 data_ref + 2 pre_defined +
                                            # 2 reserved + 12 pre_defined,
                                            # then width, height
                                            if es + 36 <= p5e:
                                                info['w'] = struct.unpack_from(
                                                    '>H', blob, es + 32)[0]
                                                info['h'] = struct.unpack_from(
                                                    '>H', blob, es + 34)[0]
                                    elif c in (b'mp4a', b'aac ', b'alac',
                                               b'ac-3', b'ec-3'):
                                        if info['acodec'] is None:
                                            info['acodec'] = c.decode('ascii').strip()
                                    es += struct.unpack_from('>I', blob, es)[0]
    return info


def make_video_poster(blob, out_path, seek_s=1.0):
    """Grab one frame as a JPEG poster via ffmpeg, if installed.

    Returns True on success. The pipeline degrades gracefully when ffmpeg
    is missing (the explorer falls back to a glyph tile)."""
    exe = shutil.which('ffmpeg')
    if not exe:
        return False
    import subprocess
    import tempfile
    src = None
    try:
        with tempfile.NamedTemporaryFile(suffix='.mp4', delete=False) as tf:
            tf.write(blob)
            src = tf.name
        subprocess.run(
            [exe, '-y', '-loglevel', 'error', '-ss', str(seek_s), '-i', src,
             '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', out_path],
            timeout=120, check=True)
        return os.path.isfile(out_path) and os.path.getsize(out_path) > 0
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return False
    finally:
        if src:
            try:
                os.remove(src)
            except OSError:
                pass


# --------------------------------------------------------------------------
# pipeline
# --------------------------------------------------------------------------

class Pack:
    """One assets/<group>/<name>/ pair: index (0) + zip of files (1)."""

    def __init__(self, apk_zip, prefix, group, name):
        self.rel = f'{group}/{name}'
        self.index_version = None
        self.files = {}  # filename -> bytes
        idx = apk_zip.read(f'assets/{group}/{name}/0') \
            if f'assets/{group}/{name}/0' in apk_zip.namelist() else None
        if idx and idx[:4] == b'BGrm':
            self.index_version = struct.unpack_from('<I', idx, 4)[0]
        with zipfile.ZipFile(io.BytesIO(apk_zip.read(f'assets/{group}/{name}/1'))) as z:
            for info in z.infolist():
                if not info.is_dir():
                    self.files[os.path.basename(info.filename)] = z.read(info)
        # loose files sit next to 0/1 in the pack dir (e.g. the GLSL shaders
        # in res-core); pick those up too
        dirprefix = f'assets/{group}/{name}/'
        for n in apk_zip.namelist():
            b = os.path.basename(n)
            if n.startswith(dirprefix) and n.count('/') == 3 and b not in ('0', '1'):
                self.files[b] = apk_zip.read(n)


def find_packs(apk_zip):
    packs = []
    seen = set()
    for n in apk_zip.namelist():
        parts = n.split('/')
        if len(parts) == 4 and parts[0] == 'assets' and parts[3] in ('0', '1'):
            key = (parts[1], parts[2])
            if key not in seen:
                seen.add(key)
                packs.append(Pack(apk_zip, n, parts[1], parts[2]))
    return sorted(packs, key=lambda p: p.rel)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument('apk')
    ap.add_argument('--out', default=os.path.join(REPO_ROOT, 'web', 'assets'))
    ap.add_argument('--dlc', action='append', default=[], metavar='JSON',
                    help='also decode a DLC pack from the fan CDN (same '
                         '0/1 container as APK packs). JSON spec: '
                         '{"file": "/path/pack.zip", "url": '
                         '"https://cdn.../pack.zip"}; optional "season", '
                         '"tier", "revision" overrides. Repeatable.')
    ap.add_argument('--no-apk', action='store_true',
                    help='reuse the previous manifest non-DLC entries '
                         'instead of re-extracting the APK (batch runs '
                         'paired with --fast)')
    ap.add_argument('--fast', action='store_true',
                    help='skip rebuilding data/webdata.js (used by batch '
                         'runs; finish with one full run without --fast)')
    args = ap.parse_args()

    apk = args.apk
    if not zipfile.is_zipfile(apk):
        raise SystemExit(f'ERROR: {apk} is not a ZIP/APK')
    out = args.out
    t0 = datetime.datetime.now()
    # previous manifest, loaded once: reused for --no-apk seeding, the
    # dlc merge, and the languages fallback on --fast runs
    prev_languages = []
    old_files = []
    _pm = os.path.join(out, 'manifest.json')
    if os.path.isfile(_pm):
        try:
            with open(_pm, encoding='utf-8') as f:
                _old = json.load(f)
            prev_languages = _old.get('languages', [])
            old_files = _old.get('files', [])
        except (ValueError, OSError):
            pass

    if not args.no_apk:
        print(f'Extracting APK to {out} ...')
        apk_zip = zipfile.ZipFile(apk)
        packs = find_packs(apk_zip)
        print(f'{len(packs)} packs found')

        sub = {'images': 'images', 'audio': 'audio', 'fonts': 'fonts',
               'i18n': 'i18n', 'data': 'data', 'thumbs': 'thumbs'}
        for k in sub.values():
            # wipe so re-runs are fully idempotent (no stale variants)
            d = os.path.join(out, k)
            if os.path.isdir(d):
                shutil.rmtree(d)
            os.makedirs(d)

    manifest_files = []

    def emit(subdir, outname, blob, ftype, src_rel, origin, **extra):
        path = os.path.join(out, subdir, outname)
        if os.path.exists(path):
            os.remove(path)
        with open(path, 'wb') as f:
            f.write(blob)
        entry = {'path': f'{subdir}/{outname}', 'type': ftype,
                 'source': src_rel, 'origin': origin, 'bytes': len(blob)}
        entry.update(extra)
        manifest_files.append(entry)
        return entry

    if args.no_apk:
        manifest_files = [e for e in old_files
                          if not e['path'].startswith('dlc/')
                          and os.path.isfile(os.path.join(out, e['path']))]
        print(f'--no-apk: reusing {len(manifest_files)} core entries '
              f'(no APK re-extraction)')
    else:
        # ---- 1. splash art (core-splashes-*), ALL resolution classes ------------
        # lang filenames in the packs use full words; map them to short codes.
        lang_full = {'en': 'en', 'fr': 'french', 'it': 'italian', 'de': 'german',
                     'es': 'spanish', 'zh': 'ch', 'kr': 'ko', 'pt': 'brazilian',
                     'ru': 'russian', 'da': 'danish', 'nl': 'dutch', 'no': 'norwegian',
                     'sv': 'swedish', 'tc': 'traditionalchinese', 'th': 'thai', 'tr': 'turkish'}
        full_to_code = {v: k for k, v in lang_full.items()}

        def sidecar_anchor(files, base):
            # anchor sidecars are named inconsistently in the packs
            for cand in (f'{base}.rgb.txt', f'{base}.txt'):
                if cand in files:
                    return parse_anchor(files[cand])
            return None

        def emit_rgb_image(outname, blob, src_rel, origin, family, res_class, anchor=None):
            w, h, bpp, rgba, premul = rgb_to_rgba(blob, f'{src_rel}/{outname}')
            write_png(os.path.join(out, 'images', outname), w, h, rgba)
            entry = {
                'path': f'images/{outname}', 'type': 'image',
                'source': src_rel, 'origin': origin,
                'bytes': os.path.getsize(os.path.join(out, 'images', outname)),
                'w': w, 'h': h, 'bpp': bpp,
                'family': family, 'resClass': res_class,
            }
            if premul is not None:
                entry['premul'] = premul
            if anchor is not None:
                entry['anchor'] = anchor
            t = make_thumb(w, h, rgba)
            if t:
                tw, th, tbuf = t
                write_png(os.path.join(out, 'thumbs', outname), tw, th, tbuf)
                entry['thumb'] = f'thumbs/{outname}'
            manifest_files.append(entry)
            return entry

        for cls in SPLASH_CLASSES:
            pack = next(p for p in packs if p.rel == f'core/core-splashes-{cls}')
            files = pack.files
            is_game = (cls == GAME_SPLASH_CLASS)
            suffix = '' if is_game else f'_{cls}'
            bases = list(SPLASH_BASES) + [f'lang_{full}' for full in sorted(lang_full.values())]
            for base in sorted(bases):
                fname = f'{base}.rgb'
                if fname not in files:
                    raise SystemExit(f'ERROR: {fname} missing in {pack.rel}')
                fam = f'lang_{full_to_code[base[5:]]}' if base.startswith('lang_') else base
                emit_rgb_image(f'{fam}{suffix}.png', files[fname], pack.rel,
                               fname if is_game else None, fam, cls,
                               anchor=sidecar_anchor(files, base))
            if is_game and 'common_anchor.txt' in files:
                emit('data', 'common_anchor.txt', files['common_anchor.txt'],
                     'text', pack.rel, 'common_anchor.txt')

        # ---- 2. core UI chrome + loading donut (core-*), ALL classes -----------
        for cls in CORE_UI_CLASSES:
            pack = next(p for p in packs if p.rel == f'core/core-{cls}')
            is_game = (cls == GAME_UI_CLASS)
            suffix = '' if is_game else f'_{cls.replace("-", "_")}'
            for fname, blob in sorted(pack.files.items()):
                if fname.endswith('.png'):
                    d = png_dims(blob)
                    base = fname[:-4]
                    emit('images', f'{base}{suffix}.png', blob, 'image', pack.rel,
                         fname if is_game else None,
                         w=d[0] if d else None, h=d[1] if d else None,
                         family=base, resClass=cls)
                elif fname == 'loading_donut.rgb':
                    emit_rgb_image(f'loading_donut{suffix}.png', blob, pack.rel,
                                   fname if is_game else None,
                                   'loading_donut', cls)
                elif fname.endswith('.txt') and is_game:
                    emit('data', fname, blob, 'text', pack.rel, fname)

        # ---- 3. res-core: fonts, i18n, data -----------------------------------
        rescore = next(p for p in packs if p.rel == 'core/res-core')
        for fname, blob in sorted(rescore.files.items()):
            if fname.endswith('.ttf') or fname.endswith('.otf'):
                # skip the 17.8 MB CJK fallback font; the UI uses ComicCrazy + Helvetica Neue
                if fname == 'ascenderuni.ttf':
                    continue
                emit('fonts', fname, blob, 'font', rescore.rel, fname)
            elif fname.endswith('.btp'):
                lang_code = None
                for suffix, code in LANGMAP.items():
                    if fname == f'scorpio_core_{suffix}.btp':
                        lang_code = code
                if lang_code is None:
                    continue
                strings = parse_btp(blob, f'{rescore.rel}/{fname}')
                json_bytes = (json.dumps(strings, ensure_ascii=False, indent=1) + '\n').encode('utf-8')
                emit('i18n', f'{lang_code}.json', json_bytes, 'i18n',
                     rescore.rel, fname, strings=len(strings))
            elif fname.endswith(('.xml', '.fsh', '.vsh')):
                emit('data', fname, blob, 'data', rescore.rel, fname)

        # ---- 4. audio (res-audio) ---------------------------------------------
        audio_pack = next(p for p in packs if p.rel == 'audio/res-audio')
        for fname, blob in sorted(audio_pack.files.items()):
            if not fname.endswith('.wav'):
                continue
            info = wav_info(blob)
            extra = {}
            if info:
                tag, ch, rate, dur = info
                extra.update(audio_format=tag, channels=ch, sample_rate=rate,
                             duration_s=round(dur, 1),
                             codec={1: 'pcm', 3: 'float', 17: 'ima-adpcm'}.get(
                                 tag, 'unknown'),
                             kind='music' if fname in MUSIC_WAVS else 'sfx')
            emit('audio', fname, blob, 'audio', audio_pack.rel, fname, **extra)

        # ---- 5. support fallback page ------------------------------------------
        for p in packs:
            if p.rel == 'core/support':
                for fname, blob in sorted(p.files.items()):
                    emit('data', fname, blob, 'data', p.rel, fname)

        # ---- 6. Android shell icons (res/) ---------------------------------------
        # The launcher icons, the pre-engine default splash and the push
        # notification icon are game-branded. The other res/drawable* PNGs are
        # third-party SDK chrome (appcompat / Facebook / Google sign-in /
        # Messenger) and are not extracted.
        for density in ANDROID_DENSITIES:
            for base in ('ic_launcher', 'ic_launcher_background',
                         'ic_launcher_foreground', 'ic_launcher_round', 'pn_icon'):
                n = f'res/drawable-{density}/{base}.png'
                if n in apk_zip.namelist():
                    blob = apk_zip.read(n)
                    d = png_dims(blob)
                    emit('images', f'{base}_{density}.png', blob, 'image',
                         f'res/drawable-{density}', None,
                         w=d[0] if d else None, h=d[1] if d else None,
                         family=base, resClass=density)
        n = 'res/drawable/splashdefault.png'
        if n in apk_zip.namelist():
            blob = apk_zip.read(n)
            d = png_dims(blob)
            emit('images', 'splashdefault.png', blob, 'image', 'res/drawable',
                 None, w=d[0] if d else None, h=d[1] if d else None,
                 family='splashdefault', resClass='drawable')
        # app icon (also the web page favicon; duplicated from the xxxhdpi set)
        launcher = 'res/drawable-xxxhdpi/ic_launcher_foreground.png'
        if launcher in apk_zip.namelist():
            blob = apk_zip.read(launcher)
            d = png_dims(blob)
            emit('images', 'icon.png', blob, 'image', 'res/drawable-xxxhdpi',
                 'ic_launcher_foreground.png', w=d[0] if d else None, h=d[1] if d else None)

    # ---- 6b. DLC packs from the fan CDN (optional --dlc flag) ---------------
    # Same container as APK packs (0 = BGrm index, 1 = ZIP of assets). Content
    # goes under dlc/<pack>/, which plain re-runs do NOT wipe; only the packs
    # explicitly passed via --dlc are re-wiped and replaced. Every entry
    # carries dlc metadata (pack/season/tier/revision/url) for the explorer.
    def _decode_dlc_file(iname, blob, bname, extra, pack, pdir, url):
        """Decode one file inside a --dlc pack into dlc/<pack>/... .

        The dlc loop wraps this in try/except so a single corrupt or
        unknown file cannot abort a multi-pack batch run (it is stored
        as raw data instead).
        """
        if iname.endswith('.rgb'):
            w, h, bpp, rgba, premul = rgb_to_rgba(blob, f'{url}/{iname}')
            buf = png_bytes(w, h, rgba)
            entry = emit(f'dlc/{pack}/images', bname + '.png', buf,
                         'image', url, iname, w=w, h=h, bpp=bpp, **extra)
            if premul is not None:
                entry['premul'] = premul
            t = make_thumb(w, h, rgba)
            if t:
                tw, th, tbuf = t
                write_png(os.path.join(pdir, 'thumbs', bname + '.png'),
                          tw, th, tbuf)
                entry['thumb'] = f'dlc/{pack}/thumbs/{bname}.png'
        elif iname.endswith('.png'):
            d = png_dims(blob)
            emit(f'dlc/{pack}/images', iname, blob, 'image', url, iname,
                 w=d[0] if d else None, h=d[1] if d else None, **extra)
        elif iname.endswith('.wav'):
            info2 = wav_info(blob)
            if info2:
                tag, ch, rate, dur = info2
                extra.update(audio_format=tag, channels=ch,
                             sample_rate=rate, duration_s=round(dur, 1),
                             codec={1: 'pcm', 3: 'float',
                                    17: 'ima-adpcm'}.get(tag, 'unknown'))
            extra.update(kind='music' if iname in MUSIC_WAVS else 'dlc')
            emit(f'dlc/{pack}/audio', iname, blob, 'audio', url, iname,
                 **extra)
        elif iname.endswith('.btp'):
            strings = parse_btp(blob, f'{url}/{iname}')
            jbuf = (json.dumps(strings, ensure_ascii=False, indent=1)
                    + '\n').encode('utf-8')
            emit(f'dlc/{pack}/data', bname + '.json', jbuf, 'data', url,
                 iname, strings=len(strings), **extra)
        elif iname.endswith(('.mp4', '.m4v', '.mov')):
            vinfo = mp4_info(blob) or {}
            extra.update(kind='movie', w=vinfo.get('w'), h=vinfo.get('h'),
                         vcodec=vinfo.get('vcodec'),
                         acodec=vinfo.get('acodec'),
                         duration_s=(round(vinfo['duration_s'], 1)
                                     if vinfo.get('duration_s') else None))
            entry = emit(f'dlc/{pack}/videos', iname, blob, 'video', url,
                         iname, **extra)
            if make_video_poster(blob, os.path.join(pdir, 'thumbs',
                                                     bname + '.jpg')):
                entry['thumb'] = f'dlc/{pack}/thumbs/{bname}.jpg'
        elif iname.endswith('.bcell'):
            records, blocks = parse_bcell(blob, f'{url}/{iname}')
            if not blocks:
                return
            first_rgba = None
            for bi, (w, h, px) in enumerate(blocks):
                rgba = _unpremul4444(px)
                if bi == 0:
                    first_rgba = (w, h, rgba)
                with open(os.path.join(pdir, 'images',
                                       f'{bname}_f{bi}.png'), 'wb') as f:
                    f.write(png_bytes(w, h, rgba))
            fw, fh, frgba = first_rgba
            entry = emit(f'dlc/{pack}/images', f'{bname}_f0.png',
                         png_bytes(fw, fh, frgba), 'anim', url, iname,
                         **extra)
            parts = bname.split('_')
            entry.update(
                kind='character', char=parts[0],
                animation='_'.join(parts[1:]) or 'idle',
                n_cells=len(records), n_frames=len(blocks),
                w=max(w for w, _, _ in blocks),
                h=max(h for _, h, _ in blocks),
                frames=[{'f': f'{bname}_f{r[3]}.png',
                         'delay': round(r[0], 1)} for r in records],
                bytes=sum(os.path.getsize(
                    os.path.join(pdir, 'images', f'{bname}_f{bi}.png'))
                    for bi in range(len(blocks))))
            t = make_thumb(fw, fh, frgba)
            if t:
                tw, th, tbuf = t
                write_png(os.path.join(pdir, 'thumbs', bname + '.png'),
                          tw, th, tbuf)
                entry['thumb'] = f'dlc/{pack}/thumbs/{bname}.png'
        elif iname.endswith(('.ttf', '.otf')):
            emit(f'dlc/{pack}/fonts', iname, blob, 'font', url, iname,
                 **extra)
        else:
            emit(f'dlc/{pack}/data', iname, blob, 'data', url, iname,
                 **extra)

    for spec_json in args.dlc:
        spec = json.loads(spec_json)
        url = spec['url']
        fname = url.rsplit('/', 1)[-1]
        pack = spec.get('pack') or (
            fname[:-4] if fname.endswith('.zip') else fname)
        mrev = re.match(r'^(.*)-r(\d+)(?:-[0-9A-Za-z]+)?$', pack)
        base_name = mrev.group(1) if mrev else pack
        revision = mrev.group(2) if mrev else None
        mtier = re.match(r'^(.*)-([0-9A-Za-z]+)$', base_name)
        family = spec.get('family') or (mtier.group(1) if mtier else base_name)
        tier = spec.get('tier') or (mtier.group(2) if mtier else None)
        season = None
        if '/static/' in url:
            tail = url.split('/static/', 1)[1]
            if tail.count('/') >= 1:
                season = tail.split('/', 1)[0]
        dmeta = {
            'pack': pack,
            'season': spec.get('season', season),
            'tier': spec.get('tier', tier),
            'revision': spec.get('revision', revision),
            'url': url,
        }
        pdir = os.path.join(out, 'dlc', pack)
        if os.path.isdir(pdir):
            shutil.rmtree(pdir)
        for sub in ('images', 'audio', 'fonts', 'data', 'videos', 'thumbs'):
            os.makedirs(os.path.join(pdir, sub), exist_ok=True)
        try:
            with zipfile.ZipFile(spec['file']) as z:
                idx = z.read('0') if '0' in z.namelist() else b''
                inner = zipfile.ZipFile(io.BytesIO(z.read('1')))
        except (OSError, zipfile.BadZipFile, KeyError) as e:
            # A broken inner zip (truncated download, stub placeholder)
            # must never abort the batch: log and move on.
            print(f'  WARNING: pack {pack}: unreadable zip ({e}) - skipped')
            continue
        if idx[:4] == b'BGrm':
            dmeta['indexVersion'] = struct.unpack_from('<I', idx, 4)[0]
        print(f'DLC pack {pack} ({dmeta["season"]}, tier {tier}, '
              f'rev {revision}): decoding {len(inner.infolist())} files')
        seen = set()
        for info in inner.infolist():
            if info.is_dir():
                continue
            iname = os.path.basename(info.filename)
            # Some CDN zips store the same file multiple times (EA shipped
            # e.g. abe_menu.rgb 8x in menu-*-r2, byte-identical); keep the
            # first copy so the manifest gets one entry per file.
            if iname in seen:
                continue
            seen.add(iname)
            blob = inner.read(iname)
            bname = iname.rsplit('.', 1)[0] if '.' in iname else iname
            extra = {'dlc': dmeta, 'family': family, 'resClass': tier}
            try:
                _decode_dlc_file(iname, blob, bname, extra, pack, pdir, url)
            except Exception as e:
                # Never let one corrupt/unknown file abort a batch run:
                # store the raw bytes as data so nothing is lost.
                print(f'  WARNING: {pack}/{iname}: {e} - stored as raw data')
                emit(f'dlc/{pack}/data', iname, blob, 'data', url, iname,
                     decode_error=str(e), **extra)

    # keep dlc/ entries from previous runs (DLC content is additive; only
    # packs re-passed via --dlc were wiped and are replaced above)
    have = {e['path'] for e in manifest_files}
    for e in old_files:
        if e['path'].startswith('dlc/') and e['path'] not in have \
                and os.path.isfile(os.path.join(out, e['path'])):
            manifest_files.append(e)

    # ---- 7. machine-readable data bundle (no fetch -> works from file://) --
    i18n_bundle = {}
    if not args.fast:
        for entry in manifest_files:
            if entry['type'] == 'i18n':
                code = entry['path'].split('/')[-1][:-5]
                i18n_bundle[code] = json.loads(
                    open(os.path.join(out, 'i18n', f'{code}.json'),
                         encoding='utf-8').read())
        splash_xml = open(os.path.join(out, 'data', 'splashscreen.xml'),
                          'rb').read().decode('utf-8')
        # raw text of every data/ file, so the asset explorer can display
        # file contents without fetch() (file:// safe). Guarded: the full
        # CDN archive stores ~30k data files including raw binaries
        # (bsv3, mp3/caf audio), so only small, mostly-printable files are
        # embedded; everything else is flagged textOmitted and the explorer
        # shows a placeholder instead.
        def _embeddable(path, nbytes):
            if nbytes is not None and nbytes > 65536:
                return False
            with open(path, 'rb') as f:
                probe = f.read(2048)
            if b'\x00' in probe:
                return False
            text = probe.decode('utf-8', errors='replace')
            ok = sum(1 for c in text if c.isprintable() or c in '\t\n\r')
            return not text or ok / len(text) >= 0.9
        data_text = {}
        for entry in manifest_files:
            if entry['type'] in ('text', 'data'):
                fpath = os.path.join(out, entry['path'])
                if _embeddable(fpath, entry.get('bytes')):
                    with open(fpath, encoding='utf-8', errors='replace') as f:
                        data_text[entry['path']] = f.read()
                else:
                    entry['textOmitted'] = True
        webdata = {
            'i18n': i18n_bundle,
            'splashXml': splash_xml,
            'languages': sorted(i18n_bundle.keys()),
            'dataText': data_text,
        }
        webjs = '// generated by tools/extract_assets.py - do not edit\n'
        webjs += f'window.WEBDATA = {json.dumps(webdata, ensure_ascii=False)};\n'
        with open(os.path.join(out, 'data', 'webdata.js'), 'w',
                  encoding='utf-8') as f:
            f.write(webjs)

    # ---- 8. manifest -------------------------------------------------------
    dlc_seen = {}
    for e in manifest_files:
        if e.get('dlc'):
            dlc_seen[e['dlc']['pack']] = e['dlc']
    dlc_list = sorted(dlc_seen.values(), key=lambda d: d['pack'])
    manifest = {
        'game': 'The Simpsons: Tapped Out ("Springfield")',
        'source': os.path.basename(apk),
        'sourcePackage': 'com.ea.game.simpsons4_row.Springfield',
        'sourceVersion': '4.70.5',
        'engine': 'Bight Games BGCore (native C++, OpenGL ES 2.0)',
        'extractedAt': t0.strftime('%Y-%m-%d %H:%M:%S'),
        'notes': [
            'City/building/character content is downloaded at runtime as DLC '
            'and is NOT part of the APK; only core/splash content is present. '
            'The original 3.0.30 core content (game-100: building sprites, '
            'character animations, building/animation data; roadrivertiles-100: '
            'ground/road tiles) from the archive.org tsto-cdn-content '
            'preservation set is also decoded into dlc/.',
            'ascenderuni.ttf (17.8 MB CJK fallback font) was intentionally omitted.',
            'All splash resolution classes (small/medium/large) and all core '
            'UI classes (small/medium-small/medium/large) are extracted; the '
            'game composes the medium splash set + large UI. Image entries '
            'carry family/resClass (and thumb/anchor where applicable) so '
            'the asset explorer can group and compare variants.',
            'Android shell icons (launcher, default splash, push icon) are '
            'included from res/; third-party SDK drawables (appcompat, '
            'Facebook, Google, Messenger) are not game content and were not '
            'extracted.',
        ],
        'languages': sorted(i18n_bundle.keys()) or prev_languages,
        'music': sorted(MUSIC_WAVS),
        'dlc': dlc_list,
        'files': sorted(manifest_files, key=lambda e: e['path']),
    }
    if dlc_list:
        manifest['notes'].append(
            'DLC packs decoded on top of the APK content (fan CDN '
            'cdn.projectspringfield.com + archive.org tsto-cdn-content): '
            + '; '.join(f"{d['pack']} ({d['season'] or '?'}, tier "
                        f"{d['tier'] or '?'}, r{d['revision']})"
                        for d in dlc_list)
            + '. See the dlc/ directory; re-add with the --dlc flag after a '
              'fresh extraction. Pack files from the CDN are the same 0/1 '
              'container as the APK packs.')
    with open(os.path.join(out, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, separators=(',', ':'))
    if not args.fast:
        with open(os.path.join(out, 'manifest.js'), 'w', encoding='utf-8') as f:
            f.write('// generated by tools/extract_assets.py - do not edit\n')
            f.write('window.MANIFEST = '
                    + json.dumps(manifest, ensure_ascii=False) + ';\n')

    # ---- summary ------------------------------------------------------------
    total = 0
    bytype = {}
    for e in manifest_files:
        size = os.path.getsize(os.path.join(out, e['path']))
        total += size
        bytype.setdefault(e['type'], [0, 0])
        bytype[e['type']][0] += 1
        bytype[e['type']][1] += size
    print(f'\nDone in {(datetime.datetime.now() - t0).total_seconds():.1f}s -> {out}')
    for t, (n, s) in sorted(bytype.items()):
        print(f'  {t:6s} {n:4d} files  {s/1024/1024:7.2f} MB')
    print(f'  {"total":6s} {len(manifest_files):4d} files  {total/1024/1024:7.2f} MB')


if __name__ == '__main__':
    main()
