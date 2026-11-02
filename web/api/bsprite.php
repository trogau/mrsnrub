<?php
/* Dynamic city-art endpoint (2026-11-02) — the bsv3 sibling of bcell.php.

   Serves the four bakeable city asset kinds as on-demand PNGs so the
   viewer no longer needs every pre-baked file under web/assets/city:

     bsprite.php?kind=sprite&name=1979onda                 -> body PNG
     bsprite.php?kind=flag&name=flag_sweden                -> nation flag cloth
     bsprite.php?kind=season&name=1979onda&cls=winter      -> season PNG
     bsprite.php?kind=anim&name=1979onda&png=anims/1979onda__Active.png
                                                            -> filmstrip atlas
     bsprite.php?kind=stack&name=aircraftcarrier           -> stack composite

     &mode=meta      -> the pipeline's manifest-style JSON for that asset
                        (w/h/anchor; anims: frames/cols/cellw/cellh/ax/ay/
                        fps/rp/lt/sparse…)
     &debug=1        -> HTML report (params, cache state, subprocess command
                        + stderr + timings, embedded image, meta) — never
                        cached; the underlying render still populates the
                        disk cache.

   Decoding lives in tools/city_render.py, which imports gen_city_sprites
   and calls the SAME bake helpers the batch pipeline uses, so served
   bytes are pixel-identical to pre-baked PNGs by construction (verified
   by tools/smoke-bsprite-api.py). A cold asset costs one python3
   subprocess; results are written under bsprite-cache/ keyed by the
   source files' path+mtime+size and served immutable + ETag, so every
   later hit is a plain file read with no subprocess.

   Error codes (JSON {"error":…}): 404 bad params / unknown slug,
   422 source missing (genuine gap — the viewer red-boxes these),
   423 not bakeable here (viewer falls back to pre-baked, no box),
   424 bake failed, 500/503 subprocess or cache-dir trouble.

   CLI (for the harness / manual checks, no server needed):
     php web/api/bsprite.php --kind=sprite --name=1979onda \
        --out=/tmp/opencode/1979onda.png
     (--mode=meta prints the JSON meta to stdout) */
declare(strict_types=1);

const POOL_DIR = '/tmp/opencode/citypool';
const CACHE_DIR = __DIR__ . '/bsprite-cache';
const PY = '/usr/bin/python3';
const RENDER_PY = __DIR__ . '/../../tools/city_render.py';
const CITY_DIR = __DIR__ . '/../assets/city';
const NAME_RE = '/^[A-Za-z0-9._\-]+$/';
const CLS_RE = '/^[a-z]+$/';
const PNG_RE = '#^anims/[A-Za-z0-9._\-]+\.png$#';
const KINDS = ['sprite', 'flag', 'season', 'anim', 'stack'];
const BAKE_TIMEOUT = 150;        // seconds for the python subprocess

/* ------------------------------------------------------------------ input */

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
        http_response_code(200);
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

function safe(string $v, string $re, string $what): string {
    if ($v === '') return '';            /* optional params validated below */
    if (!preg_match($re, $v)) fail("bad $what '$v'", 404);
    if (str_contains($v, '..')) fail("path traversal in $what", 404);
    return $v;
}

/* ----------------------------------------------------------------- source */

/* stat() the exact source files the shim will open; they become the cache
   identity (any pipeline re-extract/refill busts the entry automatically).
   Returns [id-string, human description]. Missing files are NOT an error
   here — city_render.py reports them as 422 with a precise message; we
   just key on what exists. */
function source_files(string $kind, string $name, string $cls, string $png): array {
    $files = [];
    if ($kind === 'sprite' || $kind === 'anim') {
        $files = [POOL_DIR . "/$name.bsv3", POOL_DIR . "/$name.rgb",
                  POOL_DIR . "/$name.xml"];
    } elseif ($kind === 'flag') {   /* nation flag cloth: pool triple +
                                       the city-flags.json gate */
        $files = [POOL_DIR . "/$name.bsv3", POOL_DIR . "/$name.rgb",
                  POOL_DIR . "/$name.xml", CITY_DIR . '/city-flags.json'];
    } elseif ($kind === 'season') {
        $files = [POOL_DIR . "/$name.bsv3", POOL_DIR . "/$name.rgb",
                  POOL_DIR . "/$name.xml",
                  POOL_DIR . "/season/$cls/$name.bsv3",
                  POOL_DIR . "/season/$cls/$name.rgb"];
    } else {  /* stack: recomposes from the on-disk body + strip PNGs and
                  the two manifests — key on all of them */
        $files = [CITY_DIR . '/city-sprites.json', CITY_DIR . '/city-anims.json'];
        $sj = @json_decode((string)@file_get_contents(CITY_DIR . '/city-sprites.json'), true);
        $info = $sj['sprites'][$name] ?? null;
        if ($info) {
            $files[] = CITY_DIR . '/' . $info['png'];
            $aj = @json_decode((string)@file_get_contents(CITY_DIR . '/city-anims.json'), true);
            $layers = $aj['behavior'][$name]['layers'] ?? [];
            $anims = $aj['anims'][$name] ?? [];
            foreach ($layers as $w) {
                foreach ($anims as $e) {
                    if (strcasecmp($e['anim'], (string)$w) === 0) {
                        $files[] = CITY_DIR . '/' . $e['png'];
                    }
                }
            }
        }
    }
    $id = $kind . '|' . $name . '|' . $cls . '|' . $png;
    $desc = [];
    foreach ($files as $f) {
        $st = @stat($f);
        $id .= '|' . basename($f) . ':' . ($st === false ? 'x' : $st['mtime'] . ':' . $st['size']);
        $desc[] = basename($f) . ($st === false ? ' (missing)'
                       : ' ' . date('Y-m-d H:i:s', (int)$st['mtime'])
                         . ' ' . number_format((int)$st['size']) . 'B');
    }
    return [$id, implode(', ', $desc)];
}

/* --------------------------------------------------------------- bake */

function ensure_cache_dir(): bool {
    if (!is_dir(CACHE_DIR)) {
        if (!@mkdir(CACHE_DIR, 0777, true) && !is_dir(CACHE_DIR)) return false;
        @chmod(CACHE_DIR, 0777);  /* first creator may be CLI (dave) or
           PHP-FPM (www-data) — both must be able to write */
    }
    if (!is_writable(CACHE_DIR)) @chmod(CACHE_DIR, 0777);
    return is_writable(CACHE_DIR);
}

/* Run the shim once; it writes the PNG itself and prints meta JSON on
   stdout. Returns ['png' => path, 'meta' => array] — the caller renames
   the temp PNG into the cache. $err carries the shim's stderr on failure. */
function bake(string $kind, string $name, string $cls, string $png,
              ?string &$err, int &$errCode): ?array {
    $tmpPng = CACHE_DIR . '/bake-' . bin2hex(random_bytes(8)) . '.' . getmypid() . '.png';
    $argv = [PY, '-W', 'ignore', RENDER_PY, $kind, $name];
    if ($kind === 'season') $argv[] = $cls;
    if ($kind === 'anim') $argv[] = $png;
    $argv[] = $tmpPng;
    $cmd = 'timeout ' . BAKE_TIMEOUT . ' '
         . implode(' ', array_map('escapeshellarg', $argv)) . ' 2>/dev/null';
    $errFile = tempnam(sys_get_temp_dir(), 'bsprite');
    $cmd = substr($cmd, 0, -strlen(' 2>/dev/null')) . ' 2>' . escapeshellarg($errFile);
    dbg_info('subprocess', $cmd);
    $out = [];
    $code = 0;
    exec($cmd, $out, $code);
    $errCode = $code;
    $err = ($errFile && is_file($errFile)) ? trim((string)file_get_contents($errFile)) : '';
    if ($errFile) @unlink($errFile);
    dbg_mark('python bake (exit ' . $code . ')');
    if ($code !== 0 || !is_file($tmpPng)) {
        @unlink($tmpPng);
        if ($err === '') $err = 'renderer exited ' . $code;
        return null;
    }
    $meta = json_decode(implode("\n", $out), true);
    if (!is_array($meta)) $meta = new stdClass();
    return ['png' => $tmpPng, 'meta' => $meta];
}

/* ------------------------------------------------------------ cache/serving */

function cache_put_file(string $src, string $file, bool &$cacheable, string $what): void {
    $d = &$GLOBALS['diag']['cache'];
    if (!$cacheable) { $d['write'] = 'SKIPPED — cache dir not writable'; return; }
    if (@rename($src, $file)) {
        @chmod($file, 0666);
        $d['write'] = $what . ' written';
    } else {
        @unlink($src);
        $d['write'] = 'FAILED — rename into ' . CACHE_DIR . ' denied';
        $cacheable = false;
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

function render_debug(?string $body, ?string $ctype): string {
    $d = $GLOBALS['diag'];
    $e = static fn(mixed $v): string => htmlspecialchars((string)$v, ENT_QUOTES, 'UTF-8');
    $h = [];
    $h[] = '<!doctype html><meta charset="utf-8"><title>bsprite.php debug</title>';
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
         . 'border:1px solid #33373d;border-radius:6px;max-width:100%;overflow:auto}'
         . 'img{image-rendering:pixelated;max-width:100%}'
         . 'pre{background:#1e2126;border:1px solid #33373d;border-radius:6px;'
         . 'padding:10px;overflow:auto;font-size:12px}'
         . 'code{background:#1e2126;padding:1px 5px;border-radius:4px}</style>';
    $p = $d['info']['params'] ?? [];
    $h[] = '<h1>bsprite.php — ' . $e(($p['kind'] ?? '?') . ' ' . ($p['name'] ?? '?'))
         . ' <span style="color:#9aa0a6">(' . $e($p['mode'] ?? '')
         . ($p['cls'] ?? '' ? ', ' . $e($p['cls']) : '')
         . ($p['png'] ?? '' ? ', ' . $e($p['png']) : '')
         . ', debug)</span></h1>';
    $h[] = '<div style="color:#9aa0a6">' . $e($d['info']['request'] ?? '') . '</div>';
    foreach ($d['errors'] as $err) $h[] = '<div class="err"><b>Error:</b> ' . $e($err) . '</div>';

    $c = $d['cache'];
    $h[] = '<h2>Cache</h2><table>';
    $hit = $c['hit'] ?? null;
    $h[] = '<tr><th>state</th><td>' . ($hit === true
           ? '<span class="ok">HIT</span> — served from disk, no subprocess'
           : ($hit === false ? 'MISS — python bake' : 'n/a (failed earlier)'))
         . '</td></tr>';
    $h[] = '<tr><th>dir</th><td><code>' . $e($c['dir'] ?? '') . '</code> ('
         . (($c['dir_writable'] ?? false) ? '<span class="ok">writable</span>'
            : '<span class="bad">NOT writable</span>') . ')</td></tr>';
    if (isset($c['file'])) $h[] = '<tr><th>file</th><td><code>' . $e($c['file']) . '</code></td></tr>';
    if (isset($c['write'])) $h[] = '<tr><th>write</th><td>' . $e($c['write']) . '</td></tr>';
    if (isset($c['etag'])) $h[] = '<tr><th>etag</th><td><code>' . $e($c['etag']) . '</code></td></tr>';
    $h[] = '</table>';

    $h[] = '<h2>Timings</h2><table><tr><th>stage</th><th>ms</th><th>total</th></tr>';
    foreach ($d['marks'] as [$label, $ms, $cum]) {
        $h[] = '<tr><td>' . $e($label) . '</td><td>' . $e($ms) . '</td><td>' . $e($cum) . '</td></tr>';
    }
    $h[] = '<tr><td><b>total</b></td><td></td><td><b>'
         . round((microtime(true) - $d['started']) * 1000, 1) . '</b></td></tr></table>';

    $h[] = '<h2>Source</h2><table>';
    foreach (['source files', 'subprocess', 'stderr', 'png bytes'] as $k) {
        if (isset($d['info'][$k])) {
            $v = $d['info'][$k];
            $h[] = '<tr><th>' . $e($k) . '</th><td>'
                 . (strlen((string)$v) > 300 ? '<code>' . $e($v) . '</code>' : $e($v))
                 . '</td></tr>';
        }
    }
    $h[] = '<tr><th>runtime</th><td>PHP ' . $e(PHP_VERSION) . ' (' . $e(PHP_SAPI)
         . '), peak memory ' . round(memory_get_peak_usage(true) / 1048576, 1)
         . ' MiB</td></tr></table>';

    $h[] = '<h2>Output</h2>';
    if ($body !== null && ($ctype ?? '') === 'image/png') {
        $h[] = '<div class="imgwrap"><img src="data:image/png;base64,'
             . base64_encode($body) . '" alt="generated asset"></div>';
    }
    if (isset($d['meta'])) {
        $h[] = '<details open><summary><b>meta</b></summary><pre>'
             . $e(json_encode($d['meta'], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES))
             . '</pre></details>';
    } elseif ($body !== null && str_contains((string)$ctype, 'json')) {
        $h[] = '<pre>' . $e($body) . '</pre>';
    }
    return implode("\n", $h);
}

/* ---------------------------------------------------------------- main */

function main(array $args, bool $cli): void {
    $GLOBALS['debug'] = !$cli && isset($args['debug']) && $args['debug'] !== '0';
    $kind = (string)($args['kind'] ?? 'sprite');
    if (!in_array($kind, KINDS, true)) fail('kind: ' . implode('|', KINDS), 404);
    $name = safe((string)($args['name'] ?? ''), NAME_RE, 'name');
    if ($name === '') fail('name required', 404);
    $cls = safe((string)($args['cls'] ?? ''), CLS_RE, 'cls');
    $png = safe((string)($args['png'] ?? ''), PNG_RE, 'png');
    $mode = (string)($args['mode'] ?? 'img');
    if (!in_array($mode, ['img', 'meta'], true)) fail('mode: img|meta', 404);
    if ($kind === 'season' && $cls === '') fail('season needs cls', 404);
    if ($kind === 'anim' && $png === '') fail('anim needs png=anims/<file>.png', 404);
    if ($kind !== 'season') $cls = '';
    if ($kind !== 'anim') $png = '';

    dbg_info('request', $cli ? '(cli)' : ($_SERVER['REQUEST_URI'] ?? '?'));
    dbg_info('params', ['kind' => $kind, 'name' => $name, 'cls' => $cls,
                        'png' => $png, 'mode' => $mode]);
    set_time_limit(BAKE_TIMEOUT + 30);
    $cacheable = ensure_cache_dir();
    $GLOBALS['diag']['cache']['dir'] = CACHE_DIR;
    $GLOBALS['diag']['cache']['dir_writable'] = $cacheable;

    [$srcId, $srcDesc] = source_files($kind, $name, $cls, $png);
    dbg_info('source files', $srcDesc);
    dbg_mark('source stat');
    $key = sha1($srcId);
    $pngFile = CACHE_DIR . '/' . $key . '.png';
    $metaFile = CACHE_DIR . '/' . $key . '.json';
    $GLOBALS['diag']['cache']['file'] = $pngFile;

    if (is_file($pngFile) && is_file($metaFile)) {
        $GLOBALS['diag']['cache']['hit'] = true;
        $pngBody = (string)file_get_contents($pngFile);
        $meta = json_decode((string)file_get_contents($metaFile), true);
        dbg_mark('cache read');
    } else {
        $GLOBALS['diag']['cache']['hit'] = false;
        /* negative cache: a bake that failed once (missing companion,
           static-only file) would otherwise re-spawn python on every
           view of that building until the pool changes */
        $failFile = CACHE_DIR . '/' . $key . '.err';
        if (is_file($failFile)) {
            $line = (string)file_get_contents($failFile);
            if (preg_match('/^(\d{3}) (.*)$/', $line, $mm)) {
                dbg_info('stderr', $mm[2]);
                fail("$kind $name" . ($cls ? "/$cls" : '') . ($png ? "/$png" : '')
                     . ': ' . $mm[2], (int)$mm[1]);
            }
        }
        $err = null;
        $errCode = 0;
        $r = bake($kind, $name, $cls, $png, $err, $errCode);
        if ($r === null) {
            /* the shim reports its status as 'E<code> message' (python
               truncates exit() to 8 bits); 124 is `timeout`'s own code */
            $code = 500;
            if (preg_match('/^E(\d{3}) /', (string)$err, $mm)) {
                $code = (int)$mm[1];
                $err = (string)substr($err, 5);
            } elseif ($errCode === 124) {
                $code = 504;
                $err = 'renderer timed out after ' . BAKE_TIMEOUT . 's';
            }
            if ($cacheable && $code !== 504) {   /* a timeout may succeed next time */
                @file_put_contents($failFile, $code . ' '
                                   . preg_replace('/\s+/', ' ', (string)$err));
                @chmod($failFile, 0666);
            }
            dbg_info('stderr', (string)$err);
            fail("$kind $name" . ($cls ? "/$cls" : '') . ($png ? "/$png" : '')
                 . ': ' . $err, $code);
        }
        $GLOBALS['diag']['meta'] = $r['meta'];
        $metaBody = json_encode($r['meta'], JSON_UNESCAPED_SLASHES);
        $pngBody = (string)file_get_contents($r['png']);   /* before rename */
        cache_put_file($r['png'], $pngFile, $cacheable, 'png');
        if ($cacheable) {
            $tmp = $metaFile . '.' . getmypid() . '.tmp';
            if (@file_put_contents($tmp, $metaBody) !== false) {
                @chmod($tmp, 0666);
                @rename($tmp, $metaFile);
            } else {
                @unlink($tmp);
            }
        }
        $meta = $r['meta'];
    }

    if ($mode === 'meta') {
        $GLOBALS['diag']['meta'] = $meta;
        $body = json_encode($meta, JSON_UNESCAPED_SLASHES);
        send($body, 'application/json; charset=utf-8', '"' . $key . '"', $cli, $args['out'] ?? null);
        return;
    }
    dbg_info('png bytes', number_format(strlen($pngBody)));
    send($pngBody, 'image/png', '"' . $key . '"', $cli, $args['out'] ?? null);
}

if (PHP_SAPI === 'cli' && !isset($_SERVER['REQUEST_METHOD'])) {
    $args = [];
    foreach (array_slice($argv, 1) as $a) {
        if (preg_match('/^--([^=]+)(?:=(.*))?$/', $a, $m)) $args[$m[1]] = $m[2] ?? '1';
    }
    main($args, true);
} else {
    /* web request — or the harness's emulated one (php -r pre-fills
       $_GET + REQUEST_METHOD to exercise THIS path without a server) */
    main($_GET, false);
}
