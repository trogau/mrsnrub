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
     ?mode=anims&name=X   -> the skin's locomotion cells that really exist,
                            as {name, src, anims:[{tail, stem}]} — one small
                            request that replaces the client's guess-and-404
                            probe over the 8 WALK_TAILS (see pool_walks)

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
/* Cell names may contain single spaces (the 'baby bear_*' family ships them
   literally in the packs), but never slashes or '..' (see safe_name). */
const NAME_RE = '/^[A-Za-z0-9 ._-]+$/';
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

/* Every pool stem, sorted (so deterministic), globbed once per request. */
function pool_stems(string $dir): array {
    static $stems = null;
    static $stamp = null;
    /* fpm workers live across harvests: re-stat the directory so cells
       extracted after a worker's first request become visible (a purely
       static cache served 'no such cell' for cells that were right there) */
    $m = @filemtime($dir);
    if ($stems === null || $stamp !== $m) {
        $stems = [];
        foreach (glob($dir . '/*.bcell') ?: [] as $p) $stems[] = basename($p, '.bcell');
        sort($stems);
        $stamp = $m;
    }
    return $stems;
}

/* First pool stem (sorted, so deterministic) whose alphanumeric-only key
   equals $want. */
function pool_find_stem(string $dir, string $want): ?string {
    foreach (pool_stems($dir) as $b) if (slug_key($b) === $want) return $b;
    return null;
}

/* The locomotion vocabulary the shipped content actually asks for. Taken
   from the <MoveGroup><MovePick x y><Animation name=…>> tables in the
   gamescripts job XML (461 distinct locomotion names across the
   gamescripts-rNNNNNN data directory): front_walk / back_walk (429 + 412
   uses) and their _left / _right variants (68 + 67 + 52 + 51), plus the rare
   front_run / back_run pair. Anything else (an active pose a job happens to
   walk with) is content-specific and not this endpoint's business. */
const WALK_TAILS = ['front_walk', 'back_walk',
                    'front_walk_left', 'front_walk_right',
                    'back_walk_left', 'back_walk_right',
                    'front_run', 'back_run'];

/* The shipped-game inventory: data/pack_census.tsv, one row per asset name the
   pack manifests list, written by tools/scan_pack_manifests.py from the entry
   `0` manifest of all 22,481 packs in cdn/. The pool is a FILTERED extraction
   (gen_city_sprites pulls the slugs the save needs, plus a backfill pass), so
   "no such cell in pool" has never by itself meant the game does not ship it —
   this is the file that says which of the two it is. Rows:
       <name>.bcell<TAB>kind<TAB>packs<TAB>sample-pack
   with provenance in the leading `#` line. */
const CENSUS = __DIR__ . '/../../data/pack_census.tsv';

/* [name => [packs, sample_pack]] plus the header's provenance, parsed once. */
function census_data(): array {
    static $cache = null;
    if ($cache !== null && $cache['mtime'] === (int)@filemtime(CENSUS))
        return $cache;
    $rows = []; $meta = ['bundles' => 0, 'packs' => 0, 'generated' => null];
    if (($fh = @fopen(CENSUS, 'r')) !== false) {
        while (($line = fgets($fh)) !== false) {
            if ($line[0] === '#') {
                if (preg_match('/bundles=(\d+) packs=(\d+).*generated=(\S+)/',
                               $line, $m)) {
                    $meta = ['bundles' => (int)$m[1], 'packs' => (int)$m[2],
                             'generated' => $m[3]];
                }
                continue;
            }
            $c = explode("\t", rtrim($line, "\n"));
            if (count($c) < 3) continue;
            $rows[slug_key(basename($c[0], '.bcell'))] =
                [(int)$c[2], $c[3] ?? null];
        }
        fclose($fh);
    }
    return $cache = ['mtime' => (int)@filemtime(CENSUS), 'rows' => $rows,
                     'meta' => $meta];
}

/* Which of those cells a skin really has: exact alphanumeric match on
   <name>_<tail>, so the costume next door (homer_adam_front_walk) is NOT
   reported for skin 'homer' — its key has 'adam' inside the tail. */
function pool_walks(string $dir, string $name): array {
    $want = [];
    foreach (WALK_TAILS as $t) $want[slug_key($name . '_' . $t)] = $t;
    $got = [];
    foreach (pool_stems($dir) as $stem) {
        $k = slug_key($stem);
        if (isset($want[$k])) $got[] = ['tail' => $want[$k], 'stem' => $stem];
    }
    usort($got, fn (array $a, array $b) => [$a['tail'], $a['stem']] <=>
                                           [$b['tail'], $b['stem']]);
    return $got;
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
    unset($b0, $b1);                       // free the 2×n halves before the
                                           // interleave peaks
    $n = strlen($R);
    // Interleave in bounded chunks: str_split/array_map over the WHOLE
    // frame built one 4-byte string per pixel — a multi-million-entry
    // array that fatalled the FPM worker (HTTP 500) on large cells while
    // the CLI (higher memory_limit) decoded them fine.
    $out = '';
    $CH = 1 << 14;                                  // pixels per chunk
    for ($o = 0; $o < $n; $o += $CH) {
        $len = min($CH, $n - $o);
        $out .= implode('', array_map(
            static fn(string $r, string $g, string $b, string $a): string
                => $r . $g . $b . $a,
            str_split(substr($R, $o, $len)), str_split(substr($G, $o, $len)),
            str_split(substr($B, $o, $len)), str_split(substr($A, $o, $len))
        ));
    }
    return $out;
}

/* .rgb blob -> [w, h] — the header only. Manifest mode needs each image's
   dimensions but never its pixels, so it must not pay for a full decode. */
function rgb_size(string $blob, string $src): array {
    if (strlen($blob) < 8) fail("$src: short .rgb", 422);
    $w = u16($blob, 4); $h = u16($blob, 6);
    if ($w * $h === 0) fail("$src: empty .rgb", 422);
    return [$w, $h];
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
   Returns [$model, $raw] where $raw[k] = [src, w, h, get] aligns with
   model.images[k]; 'get' is a lazy decoder — manifest mode never calls
   it, frame mode calls it once (the requested frame only), and
   render_sheet() calls it one image at a time so peak memory stays a
   single frame. */
function build_model(string $name, string $cellBlob, callable $read,
                     bool $pixels = true): array {
    $magic = substr($cellBlob, 0, 7);
    /* $raw[k] = [src, w, h, get] — 'get' is a zero-arg closure returning the
       decoded RGBA, so pixels are decoded ONE image at a time by whoever
       needs them (sheet stamp loop / frame). Eagerly decoding every
       companion held 100+ MB for large cells and fatalled FPM's
       memory_limit; manifest mode never calls get at all. */
    $raw = [];
    $frames = [];
    if ($magic === 'bcell10') {
        [$records, $blocks] = parse_bcell10($cellBlob, $name);
        foreach ($blocks as $bi => [$w, $h, $px]) {
            $raw[] = ['src' => "block:$bi", 'w' => $w, 'h' => $h,
                      'get' => $pixels
                          ? static fn(): string => expand4444($px, true)
                          : null];
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
                [$w, $h] = rgb_size($blob, $img);   // header: size + sanity
                unset($blob);
                $fn = null;
                if ($pixels) {
                    $rd = $read; $nm = $img;
                    $fn = static function () use ($rd, $nm): string {
                        $b = $rd(safe_name($nm));
                        if ($b === null) fail("missing companion $nm", 422);
                        return rgb_decode($b, $nm)[2];
                    };
                }
                $raw[] = ['src' => $img, 'w' => $w, 'h' => $h, 'get' => $fn];
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
    ], $raw];
}

/* Decode one image's RGBA through its lazy 'get' (build_model), releasing
   the closure so a huge cell never holds more than one frame's pixels. */
function raw_rgba(array &$raw, int $k): string {
    $get = $raw[$k]['get'] ?? null;
    $raw[$k]['get'] = null;
    if ($get === null) fail('pixels not loaded for image ' . $k, 500);
    return $get();
}

/* Sheet PNG, written BAND BY BAND. The row-pack in build_model fills
   contiguous horizontal bands (all images sharing a y share one row of the
   pack), so we stamp one band, deflate its rows into the IDAT stream and
   release it before building the next: peak memory is one band (~one row
   of the pack) + one decoded frame, instead of the whole sheet buffer
   (100+ MB for a 77-image cell, which fatalled FPM's memory_limit). */
function render_sheet_png(array $model, array &$raw, array $text = []): string {
    $sw = $model['sheet']['w']; $sh = $model['sheet']['h'];
    $blank = str_repeat("\0", $sw * 4);
    $bands = [];
    foreach ($model['images'] as $k => $im) {
        $bands[$im['y']][] = [$k, $im['x']];
    }
    ksort($bands);
    $ctx = deflate_init(ZLIB_ENCODING_DEFLATE, ['level' => 6]);
    $z = fopen('php://temp/maxmemory:4194304', 'w+b');   // IDAT bytes spill
    $clen = 0;                                            // to disk, not RAM
    $emit = static function (string $s) use ($z, &$clen): void {
        if ($s !== '') { $clen += strlen($s); fwrite($z, $s); }
    };
    $written = 0;
    foreach ($bands as $by => $slotList) {
        $rowH = max(array_map(static fn($s) => $raw[$s[0]]['h'], $slotList));
        $rows = array_fill(0, $rowH, $blank);
        foreach ($slotList as [$k, $ox]) {
            $w = $raw[$k]['w']; $h = $raw[$k]['h'];
            $rgba = raw_rgba($raw, $k);        // one frame's pixels at a time
            for ($y = 0; $y < $h; $y++) {
                $row = &$rows[$y];
                $row = substr_replace($row, substr($rgba, $y * $w * 4, $w * 4), $ox * 4, $w * 4);
                unset($row);
            }
            unset($rgba);
        }
        foreach ($rows as $y => $row) {
            $emit(deflate_add($ctx, "\0" . $row, ZLIB_NO_FLUSH));
            unset($rows[$y]);
        }
        $written += $rowH;
    }
    if ($written < $sh) {                      // pad a truncated last band
        for ($y = $written; $y < $sh; $y++) {
            $emit(deflate_add($ctx, "\0" . $blank, ZLIB_NO_FLUSH));
        }
    }
    $emit(deflate_add($ctx, '', ZLIB_FINISH));
    $head = "\x89PNG\r\n\x1a\n"
          . png_chunk('IHDR', pack('N2C5', $sw, $sh, 8, 6, 0, 0, 0));
    foreach ($text as $kw => $txt) {
        $head .= png_chunk('tEXt', $kw . "\0" . $txt);
    }
    $tail = png_chunk('IEND', '');
    rewind($z);
    $final = fopen('php://temp/maxmemory:4194304', 'w+b');
    fwrite($final, $head . pack('N', $clen) . 'IDAT');
    stream_copy_to_stream($z, $final);
    fwrite($final, $tail);
    fclose($z);
    rewind($final);
    $body = stream_get_contents($final);
    fclose($final);
    return $body;
}

/* -------------------------------------------------------------- PNG out */

function png_chunk(string $tag, string $data): string {
    $c = $tag . $data;
    return pack('N', strlen($data)) . $c . pack('N', crc32($c));
}

/* Filter-0 RGBA PNG writer — same construction as the verified pure-Python
   one in tools/extract_assets.py; tEXt pairs are appended as extra chunks.
   $pixels is either one RGBA string or render_sheet()'s row array; rows are
   deflate-streamed one at a time (and nulled as consumed) so a huge sheet
   never exists twice in memory at once. */
function png_encode(int $w, int $h, $pixels, array $text = []): string {
    $stride = $w * 4;
    $ctx = deflate_init(ZLIB_ENCODING_DEFLATE, ['level' => 6]);
    $parts = [];
    if (is_array($pixels)) {
        foreach ($pixels as $y => $row) {
            $parts[] = deflate_add($ctx, "\0" . $row, ZLIB_NO_FLUSH);
            $pixels[$y] = null;
        }
        $parts[] = deflate_add($ctx, '', ZLIB_FINISH);
        $comp = implode('', $parts);
    } else {
        $raw = '';
        for ($y = 0; $y < $h; $y++) $raw .= "\0" . substr($pixels, $y * $stride, $stride);
        $comp = gzcompress($raw, 6);
    }
    $out = "\x89PNG\r\n\x1a\n"
         . png_chunk('IHDR', pack('N2C5', $w, $h, 8, 6, 0, 0, 0));
    foreach ($text as $kw => $txt) {
        $out .= png_chunk('tEXt', $kw . "\0" . $txt);
    }
    return $out . png_chunk('IDAT', $comp) . png_chunk('IEND', '');
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
    if (!in_array($mode, ['sheet', 'manifest', 'frame', 'anims', 'census'], true))
        fail('mode: sheet|manifest|frame|anims|census');
    $name = safe_name($args['name'] ?? '');
    if ($name === '') fail('name required');
    dbg_info('request', $cli ? '(cli)' : ($_SERVER['REQUEST_URI'] ?? '?'));
    dbg_info('params', ['mode' => $mode, 'src' => $srcKind, 'name' => $name,
                        'pack' => $args['pack'] ?? null, 'n' => $args['n'] ?? null]);
    set_time_limit(120);

    /* the skin's locomotion inventory: one small JSON answer to "which walk
       cycles does this skin actually ship", so the viewer asks once per skin
       instead of probing (and 404ing) eight guessed names. Pool-only: a
       pack's contents are a zip listing away, and the viewer uses the pool. */
    if ($mode === 'anims') {
        if ($srcKind !== 'pool') fail('mode anims needs src=pool');
        $cacheable = ensure_cache_dir();
        $GLOBALS['diag']['cache']['dir'] = CACHE_DIR;
        $GLOBALS['diag']['cache']['dir_writable'] = $cacheable;
        $dir = realpath(POOL_DIR);
        if ($dir === false || !is_dir($dir)) fail('pool not present: ' . POOL_DIR, 503);
        $all = pool_stems($dir);
        $id = 'pool-list|' . $dir;
        $key = sha1($id . '|' . filemtime($dir) . '|' . count($all) .
                    '|anims|' . $name);
        $cacheFile = CACHE_DIR . '/' . $key . '.json';
        $GLOBALS['diag']['cache']['file'] = $cacheFile;
        if (is_file($cacheFile)) {
            $GLOBALS['diag']['cache']['hit'] = true;
            dbg_mark('cache read');
            send(file_get_contents($cacheFile),
                 'application/json; charset=utf-8', '"' . $key . '"', $cli,
                 $args['out'] ?? null);
            return;
        }
        $GLOBALS['diag']['cache']['hit'] = false;
        $anims = pool_walks($dir, $name);
        dbg_info('pool cells scanned', count($all));
        dbg_info('locomotion cells', array_column($anims, 'stem'));
        $body = json_encode(['name' => $name, 'src' => 'pool',
                             'cells' => count($all), 'anims' => $anims],
                            JSON_UNESCAPED_SLASHES);
        cache_put($cacheFile, $body, $cacheable);
        send($body, 'application/json; charset=utf-8', '"' . $key . '"',
             $cli, $args['out'] ?? null);
        return;
    }

    /* The shipped-game answer: is this cell absent because the game does not
       ship it, or because our extraction never pulled it? The pool cannot
       answer that on its own — it is a filtered extraction — so a missing cell
       used to be one undifferentiated "no such cell", which is exactly the
       ambiguity that lets "we never extracted it" be read as "it does not
       exist". The census is the packs' own inventory (entry 0 of every pack in
       cdn/, via tools/scan_pack_manifests.py). */
    if ($mode === 'census') {
        $dat = census_data();
        if (!$dat['rows'])
            fail('no census: run tools/scan_pack_manifests.py merge', 503);
        $dir = realpath(POOL_DIR);
        $pool = $dir !== false && is_file($dir . '/' . $name . '.bcell');
        $row = $dat['rows'][slug_key($name)] ?? null;
        dbg_info('census', $dat['meta']);
        $body = json_encode([
            'name' => $name,
            'in_pool' => $pool,
            'shipped' => $row !== null,
            'packs' => $row ? $row[0] : 0,
            'sample_pack' => $row ? $row[1] : null,
            'verdict' => $row === null ? 'not shipped by any pack'
                       : ($pool ? 'shipped and extracted'
                                : 'shipped but never extracted'),
            'census' => $dat['meta'],
        ], JSON_UNESCAPED_SLASHES);
        /* keyed on the two inputs, so re-scanning or re-extracting changes the
           ETag; the viewer busts the URL with ?v= when it wants a fresh answer */
        $etag = '"' . sha1($name . '|' . $dat['mtime'] . '|' .
                           ($dir ? filemtime($dir) : 0) . '|' . ($pool ? 1 : 0)) . '"';
        send($body, 'application/json; charset=utf-8', $etag, $cli,
             $args['out'] ?? null);
        return;
    }

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

    /* the manifest only needs each image's dimensions, not its pixels —
       decoding every companion here fatalled large cells under FPM's
       memory_limit (500) while working under the CLI's roomier default */
    [$model, $raw] = build_model($stem, $cell, $read, $mode !== 'manifest');
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
        $k = $f['image'];
        $body = png_encode($raw[$k]['w'], $raw[$k]['h'], raw_rgba($raw, $k));
        dbg_mark('png encode');
        cache_put($cacheFile, $body, $cacheable);
        send($body, 'image/png', '"' . $key . '"', $cli, $outPath);
        return;
    }
    /* sheet: one PNG + embedded manifest (single request for the browser),
       stamped + deflated band by band (see render_sheet_png) */
    $body = render_sheet_png($model, $raw,
                             ['bcell-manifest' => json_encode($model, JSON_UNESCAPED_SLASHES)]);
    dbg_mark('sheet pack + png encode');
    dbg_info('png bytes', number_format(strlen($body)));
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
