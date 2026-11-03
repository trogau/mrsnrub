<?php
/* Dynamic .bcell -> PNG endpoint (2026-11-01).
   Decodes a character animation cell and its frame art server-side so the
   browser does NOT need a pre-baked PNG per animation frame. One request:

     web/api/bcell.php?mode=sheet&src=pool&name=abe_walk
       -> ONE sprite-sheet PNG (unique frame images row-packed) with the
          frame manifest embedded as a tEXt chunk (keyword "bcell-manifest"),
          so the client can slice frames + play timing from the single image.

     ?mode=manifest ...   -> the same manifest as standalone JSON
     ?mode=frame&n=N ...  -> one frame as its own PNG

   Sources (src=):
     pool  <POOL_DIR>/<name>.bcell, companions <name>_image_N.rgb beside it
           (the /tmp/opencode/citypool extraction used by gen_city_sprites)
     pack  cdn/<pack> double-zip (pack zip -> entry "1" -> flat asset
           names), e.g. pack=3_0_30/game-100-v3_0_30.zip&name=abe_idle.bcell
           The inner "1" zip is unpacked once into the cache dir.

   Formats are the byte-exact decoders ported from tools/extract_assets.py
   (bcell10 inline blocks; bcell13 external <cell>_image_N.rgb companions;
   .rgb flags 0x0000 RGBA8888 / 0x2000 premul 4444 / 0x6000 straight 4444).
   PNG encode is the same filter-0 writer (IHDR/IDAT/IEND via gzcompress) —
   GD is deliberately NOT used so alpha stays exact and tEXt is possible.

   Everything decodes once: results are written under bcell-cache/ next to
   this file, keyed by source path+mtime+size+query, and served with
   far-future immutable cache headers + ETag revalidation.

   CLI (no server needed, for tests / manual checks):
     php web/api/bcell.php --mode=sheet --src=pool --name=abe_walk \
        --out=/tmp/opencode/abe_walk.png
     (--mode=manifest prints JSON to stdout; --out=... writes it too)

    Debug: add &debug=1 to any web request (sheet|manifest|frame) to get an
    HTML report instead of the raw asset — embedded image, per-stage timings,
    cache hit/write status + path, decoded cell/frame tables and any errors.
    Never cached; the underlying render still populates the disk cache. */
declare(strict_types=1);

const POOL_DIR = '/tmp/opencode/citypool';
const CDN_DIR = __DIR__ . '/../../cdn';
const CACHE_DIR = __DIR__ . '/bcell-cache';
const MAX_SHEET_W = 8192;       // wrap the row-pack at this width
const MAX_BLOB = 64 * 1024 * 1024;
const NAME_RE = '/^[A-Za-z0-9._\-]+$/';
const PACK_RE = '/^[A-Za-z0-9._\-]+(?:\/[A-Za-z0-9._\-]+)*$/';

/* ------------------------------------------------------------------ input */

/* Diagnostics collector for ?debug=1 (see render_debug). */
$GLOBALS['diag'] = ['errors' => [], 'marks' => [], 'info' => [],
                   'cache' => [], 'started' => microtime(true), 'last' => null];
$GLOBALS['debug'] = false;

function dbg_mark(string $label): void {
    $now = microtime(true);
    $d = &$GLOBALS['diag'];
    $from = $d['last'] ?? $d['started'];
    $d['marks'][] = [$label, round(($now - $from) * 1000, 1),
                    round(($now - $d['started']) * 1000, 1)];
    $d['last'] = $now;
}

function dbg_info(string $key, mixed $val): void {
    $GLOBALS['diag']['info'][$key] = $val;
}

function fail(string $msg, int $code = 400): never {
    if ($GLOBALS['debug']) {
        $GLOBALS['diag']['errors'][] = $msg . " (HTTP $code)";
        http_response_code(200);   // the report itself renders fine
        header('Content-Type: text/html; charset=utf-8');
        header('Cache-Control: no-store');
        echo render_debug(null, null);
        exit;
    }
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => $msg]);
    exit;
}

function safe_name(string $name): string {
    if (!preg_match(NAME_RE, $name)) fail("bad name '$name'");
    if (str_contains($name, '..')) fail('path traversal');
    return $name;
}

/* Characters.json slugs are flattened cell stems (aaronburridleblink <-
   aaronburr_idle_blink). When the exact stem is missing, resolve a
   slug-style query by comparing alphanumeric-only keys (deterministic:
   first match in sorted order). */
function slug_key(string $s): string { return preg_replace('/[^a-z0-9]/', '', strtolower($s)); }

/* Idle-loop suffixes tried for a bare-name slug (see pool_source). Mirrors
   CHAR_IDLE_SUFFIXES in tools/gen_city_sprites.py, most-specific first so a
   blink loop wins over a bare idle — keep the two lists in step. */
const IDLE_SUFFIXES = ['idleblink', 'idleblinkleft', 'idleblinkright',
                       'idle', 'idleleft', 'idleright', 'idlestandby',
                       'standby', 'blink'];

/* First pool stem (sorted, so deterministic) whose alphanumeric-only key
   equals $want. The stem list is globbed and sorted once per request. */
function pool_find_stem(string $dir, string $want): ?string {
    static $stems = null;
    if ($stems === null) {
        $stems = [];
        foreach (glob($dir . '/*.bcell') ?: [] as $p) $stems[] = basename($p, '.bcell');
        sort($stems);
    }
    foreach ($stems as $b) if (slug_key($b) === $want) return $b;
    return null;
}

/* ---------------------------------------------------------------- sources */

/* A Source is a callable bundle: blob(name) -> string|null plus a cache-id
   string identifying the backing files. */

function pool_source(string $name): array {
    $dir = realpath(POOL_DIR);
    if ($dir === false || !is_dir($dir)) fail('pool not present: ' . POOL_DIR, 503);
    $cell = $dir . '/' . $name . '.bcell';
    if (!is_file($cell)) {
        $stem = pool_find_stem($dir, slug_key($name));
        if ($stem === null) {
            // a bare-name slug baked from the base idle (starspawn, cthulhu)
            // carries no role token, so it never equals a real cell stem —
            // retry with the idle suffixes do_chars prefers
            foreach (IDLE_SUFFIXES as $sfx) {
                $stem = pool_find_stem($dir, slug_key($name . '_' . $sfx));
                if ($stem !== null) break;
            }
        }
        if ($stem === null) fail("no such cell: $name.bcell in pool", 404);
        $cell = $dir . '/' . $stem . '.bcell';
        $name = $stem;
        dbg_info('cell stem', $name . ' (resolved from slug)');
    }
    $id = 'pool|' . $cell;
    $read = static function (string $n) use ($dir): ?string {
        $p = $dir . '/' . $n;
        if (!is_file($p)) {
            /* bcell13 frame names are mixed-case, pool files are lowercase. */
            $p = $dir . '/' . strtolower($n);
            if (!is_file($p)) return null;
        }
        if (filesize($p) > MAX_BLOB) return null;
        $b = file_get_contents($p);
        return $b === false ? null : $b;
    };
    dbg_info('source', 'pool — ' . $cell);
    return [$id, filemtime($cell), filesize($cell), $read, $name];
}

function pack_source(string $pack, string $name): array {
    if (!preg_match(PACK_RE, $pack) || str_contains($pack, '..')) fail("bad pack '$pack'");
    $root = realpath(CDN_DIR);
    if ($root === false) fail('cdn dir missing', 503);
    $zip = realpath($root . '/' . $pack);
    if ($zip === false || !str_starts_with($zip, $root . '/') || !is_file($zip)) {
        fail("no such pack: $pack", 404);
    }
    dbg_info('source', 'pack — ' . $zip . ' (entry ' . $name . ')');
    if (!ensure_cache_dir()) fail('cache dir not writable: ' . CACHE_DIR, 503);
    /* The pack zip holds a plain ZIP at entry "1"; unpack it once and keep
       it keyed by path+mtime+size (packs are immutable in practice). */
    $inner = CACHE_DIR . '/inner-' . sha1($zip . '|' . filemtime($zip) . '|' . filesize($zip)) . '.zip';
    if (!is_file($inner)) {
        dbg_info('inner zip', 'unpacking from pack...');
        $z = new ZipArchive();
        if ($z->open($zip) !== true) fail('cannot open pack zip', 500);
        $entry = $z->getFromName('1');
        $z->close();
        if ($entry === false) fail('pack zip has no entry 1', 422);
        $tmp = $inner . '.' . getmypid() . '.tmp';
        if (file_put_contents($tmp, $entry) === false || !rename($tmp, $inner)) {
            @unlink($tmp);
            fail('cannot cache inner zip', 500);
        }
        dbg_info('inner zip', 'unpacked + cached at ' . $inner);
    } else {
        dbg_info('inner zip', 'cache hit: ' . $inner);
    }
    dbg_mark('source + inner zip');
    $z = new ZipArchive();
    if ($z->open($inner) !== true) fail('cannot open inner zip', 500);
    if ($z->locateName($name . '.bcell') === false) {
        $want = slug_key($name);
        for ($i = 0; $i < $z->numFiles; $i++) {
            $n0 = $z->getNameIndex($i);
            if (substr($n0, -6) === '.bcell' && slug_key(substr($n0, 0, -6)) === $want) {
                $name = substr($n0, 0, -6);
                dbg_info('cell stem', $name . ' (resolved from slug)');
                break;
            }
        }
    }
    /* id must include the resolved stem: every cell in one pack zip would
       otherwise share a cache key and serve each other's sheets */
    $id = 'pack|' . $zip . '|' . $name;
    $mtime = filemtime($zip);
    $size = filesize($zip);
    $read = static function (string $n) use ($z): ?string {
        $b = $z->getFromName($n);
        return ($b === false || strlen($b) > MAX_BLOB) ? null : $b;
    };
    return [$id, $mtime, $size, $read, $name];
}

/* -------------------------------------------------------------- decoders */

function u16(string $b, int $o): int { return unpack('v', substr($b, $o, 2))[1]; }

/* Little-endian [f32 delay, i16 x, i16 y] record (f is native order — the
   server is x86_64; 'v' is LE u16, signed by hand). */
function f32i16i16(string $b, int $o): array {
    $d = unpack('f', substr($b, $o, 4))[1];
    $u = unpack('v2', substr($b, $o + 4, 4));
    return [$d,
            $u[1] >= 0x8000 ? $u[1] - 0x10000 : $u[1],
            $u[2] >= 0x8000 ? $u[2] - 0x10000 : $u[2]];
}

/* RGBA4444 (B,A,R,G byte pairs) -> straight-alpha RGBA8888. Port of
   extract_assets._expand4444: parity split + nibble translate in C-speed
   string ops; only the semi-transparent pixels need the un-premultiply
   fixup, and fully opaque blobs skip the pixel loop entirely. */
function expand4444(string $px, bool $premul): string {
    static $tHi = null, $tLo = null, $opaque = null;
    if ($tHi === null) {
        $tHi = []; $tLo = []; $op = [];
        for ($v = 0; $v < 256; $v++) {
            $tHi[chr($v)] = chr(($v >> 4) * 17);
            $tLo[chr($v)] = chr(($v & 15) * 17);
            if (($v & 15) === 15) $op[] = chr($v);
        }
        $opaque = implode('', $op);   // b4 in high nibble, a4 = 15
    }
    $hex = unpack('H*', $px)[1];
    $b0 = hex2bin(preg_replace('/(..)(..)/', '$1', $hex));  // (B<<4)|A
    $b1 = hex2bin(preg_replace('/(..)(..)/', '$2', $hex));  // (R<<4)|G
    unset($hex);
    $B = strtr($b0, $tHi);
    $A = strtr($b0, $tLo);
    $R = strtr($b1, $tHi);
    $G = strtr($b1, $tLo);
    if ($premul) {
        $n = strlen($b0);
        if (strspn($b0, $opaque) !== $n) {
            for ($i = 0; $i < $n; $i++) {
                $v0 = ord($b0[$i]);
                $a = $v0 & 15;
                if ($a === 15) continue;
                $v1 = ord($b1[$i]);
                $r4 = $v1 >> 4; $g4 = $v1 & 15; $b4 = $v0 >> 4;
                if ($a === 0) {
                    $R[$i] = "\0"; $G[$i] = "\0"; $B[$i] = "\0";
                } else {
                    $R[$i] = chr(intdiv($r4 * 255, $a));
                    $G[$i] = chr(intdiv($g4 * 255, $a));
                    $B[$i] = chr(intdiv($b4 * 255, $a));
                }
            }
        }
    }
    return implode('', array_map(
        static fn(string $r, string $g, string $b, string $a): string => $r . $g . $b . $a,
        str_split($R), str_split($G), str_split($B), str_split($A)
    ));
}

/* .rgb blob -> [w, h, rgba] (all three verified header variants). */
function rgb_decode(string $blob, string $src): array {
    if (strlen($blob) < 8) fail("$src: short .rgb", 422);
    $flags = unpack('V', substr($blob, 0, 4))[1];
    $w = u16($blob, 4); $h = u16($blob, 6);
    $px = substr($blob, 8);
    $n = $w * $h;
    if ($n === 0) fail("$src: empty .rgb", 422);
    if (strlen($px) === $n * 4) return [$w, $h, $px];
    if (strlen($px) === $n * 2) {
        $premul = !(((($flags >> 16) & 0xFFFF)) & 0x4000);
        return [$w, $h, expand4444($px, $premul)];
    }
    fail(sprintf('%s: unexpected .rgb payload (%dx%d, %d bytes, flags=%08x)',
                 $src, $w, $h, strlen($px), $flags), 422);
}

/* bcell10 -> [records, blocks]; records [delay, x, y, block_idx]. */
function parse_bcell10(string $blob, string $src): array {
    if (substr($blob, 0, 7) !== 'bcell10') fail("$src: not bcell10", 422);
    $n = u16($blob, 7);
    $records = [];
    $off = 13;
    for ($i = 0; $i < $n; $i++) {
        [$delay, $x, $y] = f32i16i16(substr($blob, $off, 8), 0);
        $records[] = [$delay, $x, $y, null];
        $off += 13;
    }
    $blocks = [];
    $pos = $off;
    $len = strlen($blob);
    while ($pos < $len) {
        if ($blocks) {
            $flag = unpack('V', substr($blob, $pos, 4))[1];
            $w = u16($blob, $pos + 4); $h = u16($blob, $pos + 6);
            $pos += 8;
            if ($flag !== 0x20000000) fail(sprintf('%s: bad frame flag %08x', $src, $flag), 422);
        } else {
            $w = u16($blob, $pos); $h = u16($blob, $pos + 2);
            $pos += 4;
        }
        $need = $w * $h * 2;
        if ($pos + $need > $len) fail("$src: truncated frame " . count($blocks), 422);
        $blocks[] = [$w, $h, substr($blob, $pos, $need)];
        $pos += $need;
    }
    $last = count($blocks) - 1;
    foreach ($records as $i => $r) {
        $records[$i][3] = $last >= 0 ? min($i, $last) : null;
    }
    return [$records, $blocks];
}

/* bcell13 -> frames [[delay, x_off, y_off, image_name]] (pixels external). */
function parse_bcell13(string $blob, string $src): array {
    if (substr($blob, 0, 7) !== 'bcell13') fail("$src: not bcell13", 422);
    $n = u16($blob, 8);
    $off = 10;
    $out = [];
    for ($f = 0; $f < $n; $f++) {
        $ln = ord($blob[$off]);
        $name = explode("\0", substr($blob, $off + 1, $ln))[0];
        $off += 1 + $ln;
        [$delay, $x, $y] = f32i16i16($blob, $off);
        $off += 8;
        $nlayers = ord($blob[$off + 1]);
        $off += 2;
        for ($li = 0; $li < $nlayers; $li++) {
            $l1 = ord($blob[$off]); $off += 1 + $l1;
            $l2 = ord($blob[$off]); $off += 1 + $l2;
            $off += 28;
        }
        $out[] = [$delay, $x, $y, $name];
    }
    if ($off !== strlen($blob)) fail("$src: bcell13 trailing bytes ($off != " . strlen($blob) . ')', 422);
    return $out;
}

/* bcell11 -> frames [[delay, x_off, y_off, image_name]] (pixels external).
   The sibling of bcell13: frames reference external '<cell>_image_N.rgb'
   companions exactly as bcell13 does; the ONLY structural difference is the
   per-frame header, where bcell13 reads two bytes (a u8 0 filler then u8
   n_layers) and bcell11 reads a single u8 n_layers (no filler). Verified to
   parse to exact EOF on all 413 pool bcell11 cells (2026-11-03), every one
   with n_layers == 0. Mirrors extract_assets.parse_bcell11. */
function parse_bcell11(string $blob, string $src): array {
    if (substr($blob, 0, 7) !== 'bcell11') fail("$src: not bcell11", 422);
    $n = u16($blob, 8);
    $off = 10;
    $out = [];
    for ($f = 0; $f < $n; $f++) {
        $ln = ord($blob[$off]);
        $name = explode("\0", substr($blob, $off + 1, $ln))[0];
        $off += 1 + $ln;
        [$delay, $x, $y] = f32i16i16($blob, $off);
        $off += 8;
        $nlayers = ord($blob[$off]);   // bcell13 has a leading u8 0 here; bcell11 not
        $off += 1;
        for ($li = 0; $li < $nlayers; $li++) {
            $l1 = ord($blob[$off]); $off += 1 + $l1;
            $l2 = ord($blob[$off]); $off += 1 + $l2;
            $off += 28;
        }
        $out[] = [$delay, $x, $y, $name];
    }
    if ($off !== strlen($blob)) fail("$src: bcell11 trailing bytes ($off != " . strlen($blob) . ')', 422);
    return $out;
}

/* ------------------------------------------------------------ sheet build */

/* Normalize a parsed cell to: images[] (unique decoded frames, sheet slots
   assigned row-first) + frames[] (one per record, with timing/offsets).
   Returns [$model, $raw] where $raw[k] = [w, h, rgba] aligns with
   model.images[k] — the decoded pixels travel with the model so callers
   never decode the same frame twice. */
function build_model(string $name, string $cellBlob, callable $read): array {
    $magic = substr($cellBlob, 0, 7);
    $raw = [];   // per image key: [w, h, rgba]
    $frames = [];
    if ($magic === 'bcell10') {
        [$records, $blocks] = parse_bcell10($cellBlob, $name);
        foreach ($blocks as $bi => [$w, $h, $px]) {
            $raw[] = ['src' => "block:$bi", 'w' => $w, 'h' => $h,
                      'rgba' => expand4444($px, true)];
        }
        foreach ($records as $i => [$delay, $x, $y, $bi]) {
            if ($bi === null) continue;
            $frames[] = ['i' => $i, 'image' => $bi, 'delay_ms' => round($delay * 1000) / 1000,
                        'x_off' => $x, 'y_off' => $y];
        }
    } elseif ($magic === 'bcell13' || $magic === 'bcell11') {
        // bcell11 and bcell13 both keep the frame pixels EXTERNAL, in the
        // cell's '_image_N.rgb' companions; only their per-frame record
        // headers differ (see parse_bcell11 / parse_bcell13). Shared here.
        $recs = $magic === 'bcell13'
            ? parse_bcell13($cellBlob, $name)
            : parse_bcell11($cellBlob, $name);
        $byName = [];
        foreach ($recs as $i => [$delay, $x, $y, $img]) {
            if (!isset($byName[$img])) {
                $blob = $read(safe_name($img));
                if ($blob === null) fail("missing companion $img (cell $name)", 422);
                [$w, $h, $rgba] = rgb_decode($blob, $img);
                $raw[] = ['src' => $img, 'w' => $w, 'h' => $h, 'rgba' => $rgba];
                $byName[$img] = count($raw) - 1;
            }
            $frames[] = ['i' => $i, 'image' => $byName[$img],
                        'delay_ms' => round($delay * 1000) / 1000,
                        'x_off' => $x, 'y_off' => $y];
        }
    } else {
        fail("$name: unsupported cell magic '$magic'", 422);
    }
    /* Row-pack the unique images into the sheet. */
    $slots = [];
    $sx = 0; $sy = 0; $rowH = 0; $sheetW = 0;
    foreach ($raw as $k => $im) {
        if ($sx > 0 && $sx + $im['w'] > MAX_SHEET_W) {
            $sheetW = max($sheetW, $sx);
            $sx = 0; $sy += $rowH; $rowH = 0;
        }
        $slots[$k] = [$sx, $sy];
        $sx += $im['w'];
        $rowH = max($rowH, $im['h']);
    }
    $sheetW = max($sheetW, $sx);
    $sheetH = $sy + $rowH;
    dbg_info('pixel_bytes', array_sum(array_map(
        static fn(array $im): int => $im['w'] * $im['h'] * 4, $raw)));
    dbg_mark('cell parse + pixel decode');
    return [[
        'name' => $name, 'type' => $magic,
        'sheet' => ['w' => $sheetW, 'h' => $sheetH],
        'images' => array_map(static fn(array $im, int $k) => [
            'src' => $im['src'], 'w' => $im['w'], 'h' => $im['h'],
            'x' => $slots[$k][0], 'y' => $slots[$k][1],
        ], $raw, array_keys($raw)),
        'frames' => $frames,
        'total_delay_ms' => array_sum(array_column($frames, 'delay_ms')),
    ], array_map(static fn(array $im): array => [$im['w'], $im['h'], $im['rgba']], $raw)];
}

function render_sheet(array $raw, array $model): string {
    $sw = $model['sheet']['w']; $sh = $model['sheet']['h'];
    $blank = str_repeat("\0", $sw * 4);
    $rows = array_fill(0, $sh, $blank);
    foreach ($model['images'] as $k => $slot) {
        [$ox, $oy] = [$slot['x'], $slot['y']];
        [$w, $h, $rgba] = $raw[$k];
        for ($y = 0; $y < $h; $y++) {
            $row = &$rows[$oy + $y];
            $row = substr_replace($row, substr($rgba, $y * $w * 4, $w * 4), $ox * 4, $w * 4);
            unset($row);
        }
    }
    return implode('', $rows);
}

/* -------------------------------------------------------------- PNG out */

function png_chunk(string $tag, string $data): string {
    $c = $tag . $data;
    return pack('N', strlen($data)) . $c . pack('N', crc32($c));
}

/* Filter-0 RGBA PNG writer — same construction as the verified pure-Python
   one in tools/extract_assets.py; tEXt pairs are appended as extra chunks. */
function png_encode(int $w, int $h, string $rgba, array $text = []): string {
    $raw = '';
    $stride = $w * 4;
    for ($y = 0; $y < $h; $y++) $raw .= "\0" . substr($rgba, $y * $stride, $stride);
    $out = "\x89PNG\r\n\x1a\n"
         . png_chunk('IHDR', pack('N2C5', $w, $h, 8, 6, 0, 0, 0));
    foreach ($text as $kw => $txt) {
        $out .= png_chunk('tEXt', $kw . "\0" . $txt);
    }
    return $out . png_chunk('IDAT', gzcompress($raw, 6)) . png_chunk('IEND', '');
}

/* ------------------------------------------------------------ cache/serving */

function ensure_cache_dir(): bool {
    if (!is_dir(CACHE_DIR)) {
        if (!@mkdir(CACHE_DIR, 0777, true) && !is_dir(CACHE_DIR)) return false;
        @chmod(CACHE_DIR, 0777);  /* first creator may be CLI (dave) or
           PHP-FPM (www-data) — both must be able to write */
    }
    if (!is_writable(CACHE_DIR)) @chmod(CACHE_DIR, 0777);
    return is_writable(CACHE_DIR);
}

/* Write-through cache; a non-writable dir degrades to no-caching with ONE
   error_log line instead of a silent per-request failure. */
function cache_put(string $file, string $body, bool &$cacheable): void {
    $d = &$GLOBALS['diag']['cache'];
    if (!$cacheable) {
        $d['write'] = 'SKIPPED — cache dir not writable';
        return;
    }
    $tmp = $file . '.' . getmypid() . '.tmp';
    if (@file_put_contents($tmp, $body) !== false) {
        @chmod($tmp, 0666);
        if (@rename($tmp, $file)) {
            $d['write'] = 'written (' . number_format(strlen($body)) . ' bytes)';
        } else {
            @unlink($tmp);
            $d['write'] = 'FAILED — rename into ' . CACHE_DIR . ' denied';
            $cacheable = false;
        }
    } else {
        $cacheable = false;
        @unlink($tmp);
        $d['write'] = 'FAILED — ' . CACHE_DIR . ' not writable by '
                    . (function_exists('posix_getpwuid')
                       ? posix_getpwuid(posix_geteuid())['name'] : 'uid ' . posix_geteuid());
        error_log('bcell.php: cache dir not writable (' . CACHE_DIR
                  . ') — serving uncached');
    }
}

function send(string $body, string $ctype, string $etag, bool $cliOut, ?string $outPath): void {
    if ($cliOut) {
        if ($outPath !== null) { file_put_contents($outPath, $body); fwrite(STDERR, "wrote $outPath\n"); }
        else { fwrite(STDOUT, $body); }
        return;
    }
    if ($GLOBALS['debug']) {
        $GLOBALS['diag']['cache']['etag'] = $etag;
        dbg_mark('render');
        http_response_code(200);
        header('Content-Type: text/html; charset=utf-8');
        header('Cache-Control: no-store');
        echo render_debug($body, $ctype);
        return;
    }
    if (($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) {
        http_response_code(304);
        return;
    }
    header('Content-Type: ' . $ctype);
    header('ETag: ' . $etag);
    header('Cache-Control: public, max-age=31536000, immutable');
    echo $body;
}

/* ------------------------------------------------------------ debug page */

/* HTML report for ?debug=1: embedded image, per-stage timings, cache
   outcome and any fail() errors. Tolerates a partial run (body/model may
   be missing when fail() short-circuited). */
function render_debug(?string $body, ?string $ctype): string {
    $d = $GLOBALS['diag'];
    $e = static fn(mixed $v): string => htmlspecialchars((string)$v, ENT_QUOTES, 'UTF-8');
    $h = [];
    $h[] = '<!doctype html><meta charset="utf-8"><title>bcell.php debug</title>';
    $h[] = '<style>body{font:14px/1.45 system-ui,sans-serif;margin:24px;'
         . 'background:#15171a;color:#e8eaed}'
         . 'h1{font-size:19px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 6px;'
         . 'color:#9ec1ff;border-bottom:1px solid #33373d;padding-bottom:3px}'
         . 'table{border-collapse:collapse}td,th{padding:3px 14px 3px 0;'
         . 'text-align:left;vertical-align:top;font-variant-numeric:tabular-nums}'
         . 'th{color:#9aa0a6;font-weight:600}'
         . '.err{background:#5c1f1f;border:1px solid #b3402e;border-radius:6px;'
         . 'padding:10px 14px;margin:12px 0;color:#ffd7d0}'
         . '.ok{color:#81c995}.bad{color:#f28b82}'
         . '.imgwrap{background:conic-gradient(#3c4045 0 25%,#23262a 0 50%,'
         . '#3c4045 0 75%,#23262a 0) 0 0/16px 16px;padding:8px;display:inline-block;'
         . 'border:1px solid #33373d;border-radius:6px}'
         . 'img{image-rendering:pixelated;max-width:100%}'
         . 'pre{background:#1e2126;border:1px solid #33373d;border-radius:6px;'
         . 'padding:10px;overflow:auto;font-size:12px}'
         . 'code{background:#1e2126;padding:1px 5px;border-radius:4px}</style>';
    $params = $d['info']['params'] ?? [];
    $h[] = '<h1>bcell.php — ' . $e($params['name'] ?? '?') . ' '
         . '<span style="color:#9aa0a6">(' . $e($params['mode'] ?? '') . ', '
         . $e($params['src'] ?? '') . ($params['pack'] ?? null ? ', ' . $e($params['pack']) : '')
         . ', debug)</span></h1>';
    $h[] = '<div style="color:#9aa0a6">' . $e($d['info']['request'] ?? '') . '</div>';
    foreach ($d['errors'] as $err) {
        $h[] = '<div class="err"><b>Error:</b> ' . $e($err) . '</div>';
    }

    /* cache */
    $c = $d['cache'];
    $h[] = '<h2>Cache</h2><table>';
    $hit = $c['hit'] ?? null;
    $h[] = '<tr><th>state</th><td>' . ($hit === true
           ? '<span class="ok">HIT</span> — served from disk, nothing decoded'
           : ($hit === false ? 'MISS — full render' : 'n/a (failed earlier)'))
         . '</td></tr>';
    $h[] = '<tr><th>dir</th><td><code>' . $e($c['dir'] ?? '') . '</code> ('
         . (($c['dir_writable'] ?? false) ? '<span class="ok">writable</span>'
            : '<span class="bad">NOT writable</span>') . ')</td></tr>';
    if (isset($c['file'])) $h[] = '<tr><th>file</th><td><code>' . $e($c['file']) . '</code></td></tr>';
    if (isset($c['write'])) $h[] = '<tr><th>write</th><td>' . $e($c['write']) . '</td></tr>';
    if (isset($c['etag'])) $h[] = '<tr><th>etag</th><td><code>' . $e($c['etag'])
         . '</code></td></tr>';
    $h[] = '</table>';

    /* timings */
    $h[] = '<h2>Timings</h2><table><tr><th>stage</th><th>ms</th><th>total</th></tr>';
    foreach ($d['marks'] as [$label, $ms, $cum]) {
        $h[] = '<tr><td>' . $e($label) . '</td><td>' . $e($ms) . '</td><td>' . $e($cum) . '</td></tr>';
    }
    $h[] = '<tr><td><b>total</b></td><td></td><td><b>'
         . round((microtime(true) - $d['started']) * 1000, 1) . '</b></td></tr></table>';

    /* source + sizes */
    $h[] = '<h2>Source &amp; sizes</h2><table>';
    foreach (['source', 'source files', 'inner zip', 'cell bytes', 'cell',
              'pixel bytes', 'png bytes'] as $k) {
        if (isset($d['info'][$k])) {
            $v = $d['info'][$k];
            $h[] = '<tr><th>' . $e($k) . '</th><td>'
                 . (is_int($v) ? number_format($v) : $e($v)) . '</td></tr>';
        }
    }
    $h[] = '<tr><th>runtime</th><td>PHP ' . $e(PHP_VERSION) . ' (' . $e(PHP_SAPI)
         . '), peak memory ' . round(memory_get_peak_usage(true) / 1048576, 1)
         . ' MiB</td></tr></table>';

    /* the asset itself */
    $h[] = '<h2>Output</h2>';
    if ($body !== null && ($ctype ?? '') === 'image/png') {
        $h[] = '<div class="imgwrap"><img src="data:image/png;base64,'
             . base64_encode($body) . '" alt="generated sheet"></div>';
    }
    if (isset($d['model'])) {
        $m = $d['model'];
        $h[] = '<details open><summary><b>frames</b> (' . count($m['frames'])
             . ') — draw each image at (x_off, y_off) from the character origin</summary>'
             . '<table><tr><th>#</th><th>image</th><th>delay ms</th><th>x_off</th>'
             . '<th>y_off</th><th>sheet rect</th></tr>';
        foreach ($m['frames'] as $f) {
            $im = $m['images'][$f['image']];
            $h[] = '<tr><td>' . $e($f['i']) . '</td><td>' . $e($f['image'])
                 . ' · ' . $e($im['src']) . '</td><td>' . $e($f['delay_ms'])
                 . '</td><td>' . $e($f['x_off']) . '</td><td>' . $e($f['y_off'])
                 . '</td><td>' . $e($im['x'] . ',' . $im['y'] . ' ' . $im['w'] . '×' . $im['h'])
                 . '</td></tr>';
        }
        $h[] = '</table></details>';
        $h[] = '<details><summary>raw manifest JSON</summary><pre>'
             . $e(json_encode($m, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES))
             . '</pre></details>';
    } elseif ($body !== null && str_contains((string)$ctype, 'json')) {
        $h[] = '<pre>' . $e($body) . '</pre>';
    }
    return implode("\n", $h);
}

/* ---------------------------------------------------------------- main */

function main(array $args, bool $cli): void {
    $GLOBALS['debug'] = !$cli && isset($args['debug']) && $args['debug'] !== '0';
    $mode = $args['mode'] ?? 'sheet';
    $srcKind = $args['src'] ?? 'pool';
    if (!in_array($mode, ['sheet', 'manifest', 'frame'], true)) fail('mode: sheet|manifest|frame');
    $name = safe_name($args['name'] ?? '');
    if ($name === '') fail('name required');
    dbg_info('request', $cli ? '(cli)' : ($_SERVER['REQUEST_URI'] ?? '?'));
    dbg_info('params', ['mode' => $mode, 'src' => $srcKind, 'name' => $name,
                        'pack' => $args['pack'] ?? null, 'n' => $args['n'] ?? null]);
    set_time_limit(120);
    $cacheable = ensure_cache_dir();
    $GLOBALS['diag']['cache']['dir'] = CACHE_DIR;
    $GLOBALS['diag']['cache']['dir_writable'] = $cacheable;

    if ($srcKind === 'pool') {
        [$id, $mtime, $size, $read, $stem] = pool_source($name);
    } elseif ($srcKind === 'pack') {
        [$id, $mtime, $size, $read, $stem] = pack_source($args['pack'] ?? '', $name);
    } else {
        fail('src: pool|pack');
    }
    dbg_info('source files', $id . ' (mtime ' . date('Y-m-d H:i:s', $mtime)
                          . ', ' . number_format((int)$size) . ' bytes)');
    $cell = $read($stem . '.bcell');
    if ($cell === null) fail('cannot read cell', 500);
    dbg_info('cell bytes', number_format(strlen($cell)));
    dbg_mark('cell read');

    $n = isset($args['n']) ? (int)$args['n'] : null;
    $key = sha1($id . '|' . $mtime . '|' . $size . '|' . $mode . '|' . ($n ?? ''));
    $cacheFile = CACHE_DIR . '/' . $key . ($mode === 'sheet' ? '.png' : ($mode === 'frame' ? '.' . $n . '.png' : '.json'));
    $GLOBALS['diag']['cache']['file'] = $cacheFile;

    $outPath = $args['out'] ?? null;
    if (is_file($cacheFile)) {
        $GLOBALS['diag']['cache']['hit'] = true;
        $body = file_get_contents($cacheFile);
        $ctype = $mode === 'manifest' ? 'application/json; charset=utf-8' : 'image/png';
        dbg_mark('cache read');
        send($body, $ctype, '"' . $key . '"', $cli, $outPath);
        return;
    }
    $GLOBALS['diag']['cache']['hit'] = false;

    [$model, $raw] = build_model($stem, $cell, $read);
    $GLOBALS['diag']['model'] = $model;
    dbg_info('cell', $model['type'] . ', ' . count($model['frames']) . ' frames, '
             . count($model['images']) . ' unique images, sheet '
             . $model['sheet']['w'] . '×' . $model['sheet']['h'] . ' px, '
             . 'total ' . $model['total_delay_ms'] . ' ms');

    if ($mode === 'manifest') {
        $body = json_encode($model, JSON_UNESCAPED_SLASHES);
        dbg_mark('json encode');
        cache_put($cacheFile, $body, $cacheable);
        send($body, 'application/json; charset=utf-8', '"' . $key . '"', $cli, $outPath);
        return;
    }
    if ($mode === 'frame') {
        $f = $model['frames'][$n ?? -1] ?? null;
        if ($f === null) fail('no such frame n', 404);
        [$w, $h, $rgba] = $raw[$f['image']];
        $body = png_encode($w, $h, $rgba);
        dbg_mark('png encode');
        cache_put($cacheFile, $body, $cacheable);
        send($body, 'image/png', '"' . $key . '"', $cli, $outPath);
        return;
    }
    /* sheet: one PNG + embedded manifest (single request for the browser) */
    $pixels = render_sheet($raw, $model);
    dbg_mark('sheet pack');
    $body = png_encode($model['sheet']['w'], $model['sheet']['h'], $pixels,
                       ['bcell-manifest' => json_encode($model, JSON_UNESCAPED_SLASHES)]);
    unset($pixels);
    dbg_info('png bytes', number_format(strlen($body)));
    dbg_mark('png encode');
    cache_put($cacheFile, $body, $cacheable);
    send($body, 'image/png', '"' . $key . '"', $cli, $outPath);
}

if (PHP_SAPI === 'cli') {
    $args = [];
    foreach (array_slice($argv, 1) as $a) {
        if (preg_match('/^--([^=]+)(?:=(.*))?$/', $a, $m)) $args[$m[1]] = $m[2] ?? '1';
    }
    main($args, true);
} else {
    main($_GET, false);
}
