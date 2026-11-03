<?php
/* assets.php — JSON API over the Asset Explorer index (web/api/assets.sqlite,
   built by tools/build_assets_db.php from the extraction manifest).

   The manifest grew to ~2.1M entries (~2.2 GB of parts), so the explorer
   page (web/assets-explorer.php) no longer loads it in the browser; every
   browse/search query goes through this API instead:

     op=counts   [q]                          tab counts (honours search)
     op=list     tab q offset limit           flat grid page (all/image/
                                               audio/video/font/i18n/data/android)
     op=list     tab=anim   [char] q ...      character list / one character's
                                               animations / flat animation search
     op=list     tab=dlc    [fam]  q ...      family list / one family's files /
                                               flat DLC search
     op=asset    path                         full entry (detail pane, deep links)
     op=variants family type path [base] [res] switcher entries
     op=strings  lang q                       one .btp string table (DB-backed)
     op=data     path                         raw text of an embedded data file
     op=original path                         stream the pre-conversion IMA
                                              ADPCM WAV (attachment download;
                                              op=asset reports it as
                                              entry.original when present)
     op=languages                             the 16 decoded languages
     op=meta                                  manifest meta + totals

   Also runs under CLI for the smoke harness:
     php web/api/assets.php 'op=list&tab=image&limit=5'
*/
declare(strict_types=1);

require __DIR__ . '/assets-db.php';

/* Nothing but the JSON body (or the WAV bytes) may reach the client. The
   backup-audio probe below stats a tree outside the document root, and a pool
   with open_basedir and display_errors on turns each of those stats into an
   E_WARNING printed ahead of the JSON: the page's response.then(r => r.json())
   then dies and only the audio detail pane — the one caller that touches that
   tree — loses its player. Buffer from the first line, drop whatever escapes,
   keep it in the server log where it belongs. Buffering is on under CLI too so
   the smoke harness can prove the API stays pure JSON with display_errors on;
   the WAV streaming paths turn it off before they print bytes. */
ob_start();

function clean_stray_output(): void {
    while (ob_get_level() > 0) {
        $stray = (string) ob_get_clean();
        if (trim($stray) !== '') { error_log('assets.php stray output: ' . $stray); }
    }
}

const MAX_LIMIT = 1000;
const TAB_CATS  = ['all', 'image', 'audio', 'video', 'anim', 'font',
                   'i18n', 'data', 'dlc', 'android'];

function out(array $a, int $code = 200): void {
    clean_stray_output();
    if (php_sapi_name() !== 'cli') {
        http_response_code($code);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
    }
    echo json_encode($a, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function q(array $g, string $k, string $d = ''): string {
    return is_string($g[$k] ?? null) ? $g[$k] : $d;
}
function qi(array $g, string $k, int $d): int {
    $v = filter_var($g[$k] ?? null, FILTER_VALIDATE_INT);
    return $v === false ? $d : $v;
}
function like(string $s): string {
    return '%' . str_replace(['\\', '%', '_'], ['\\\\', '\%', '\_'], $s) . '%';
}

/* The pre-conversion IMA ADPCM WAVs tools/convert_audio_pcm.py replaced
   (gitignored, outside the document root). Browsers cannot decode these, so
   they are offered as downloads only — see notes/01-binary-formats.md.
   The playable file next door may be a .wav (PCM mode) or the .m4a an AAC run
   renamed it to; the backup tree always keeps the original .wav name. */
/* dirname() rather than '../..' in the middle: the containment check below
   compares a realpath against this prefix, and a path with hops in it never
   matches one without. */
define('ORIGINALS_DIR', dirname(__DIR__, 2) . '/var/audio-adpcm');

/* Every probe here is @-suppressed and any failure means "no original", never
   "no pane": realpath()/filesize()/filemtime() raise E_WARNING when an
   open_basedir-restricted pool cannot see outside the document root, and that
   text used to land in the middle of op=asset's JSON. The path is already
   restricted to a relative [A-Za-z0-9._/-] .wav/.m4a with no '..', so the
   concatenation below stays inside the backup tree; realpath is kept as a
   bonus check for when the pool does allow it. */
function original_wav(string $path): ?array {
    if ($path === '' || !preg_match('#^[A-Za-z0-9._/-]+\.(wav|m4a)$#', $path)
        || str_contains($path, '..') || $path[0] === '/') {
        return null;
    }
    try {
        $orig = preg_replace('/\.(wav|m4a)$/i', '', $path) . '.wav';
        $file = ORIGINALS_DIR . '/' . $orig;
        if (!@is_file($file)) { return null; }         // corpus never converted
        $bytes = @filesize($file);
        if ($bytes === false) { return null; }         // barred or vanished
        $root = @realpath(ORIGINALS_DIR);
        $real = @realpath($file);
        if ($real !== false && $root !== false && !str_starts_with($real, $root . '/')) {
            return null;                               // symlink out of the tree
        }
        $mtime = @filemtime($file);
        return ['file' => $file, 'bytes' => (int) $bytes, 'mtime' => (int) $mtime];
    } catch (Throwable $e) {
        return null;
    }
}

try {
    if (php_sapi_name() === 'cli') {
        $get = [];
        parse_str((string)($argv[1] ?? ''), $get);
    } else {
        $get = $_GET;
        if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
            out(['error' => 'method not allowed'], 405);
        }
    }

    $pdo = assets_db();

    $op   = q($get, 'op', 'list');
    $q    = trim(q($get, 'q'));
    $hasQ = $q !== '';

    // flat search predicate over the same fields the old client-side
    // explorer matched (path origin family resClass kind)
    $searchOn = function (array $extra = []) use ($hasQ, $q): array {
        if (!$hasQ) { return ['', []]; }
        $cols = $extra ? implode(' || ', $extra) :
            "(a.path || ' ' || COALESCE(a.origin,'') || ' ' ||"
            . " COALESCE(a.family,'') || ' ' || COALESCE(a.res_class,'') ||"
            . " ' ' || COALESCE(a.kind,''))";
        return [" AND $cols LIKE ? ESCAPE '\\'", [like($q)]];
    };

    $entrySel = assets_entry_sel();
    $entrySelG = fn(string $cols): string => assets_entry_sel($cols);
    $entry = fn(?array $r): ?array => assets_entry($r);

    // ------------------------------------------------------------------ meta
    if ($op === 'meta') {
        $meta = json_decode((string)$pdo->query(
            "SELECT value FROM meta WHERE key='manifest'")->fetchColumn(), true);
        $cats = $pdo->query('SELECT cat, COUNT(*) n FROM assets GROUP BY cat')->fetchAll();
        $total = 0;
        $catCounts = [];
        foreach ($cats as $c) { $catCounts[$c['cat']] = (int)$c['n']; $total += (int)$c['n']; }
        // A missing "original IMA ADPCM" download is a disk or pool-permission
        // question, not a data question (var/ sits outside the document root),
        // so say which it is instead of going quiet.
        $odir = ORIGINALS_DIR;
        out(['meta' => $meta, 'total' => $total, 'cats' => $catCounts,
             'originals' => ['dir' => $odir, 'readable' => (bool) @is_dir($odir)]]);
    }

    if ($op === 'languages') {
        out(['langs' => json_decode((string)$pdo->query(
            "SELECT value FROM meta WHERE key='languages'")->fetchColumn(), true) ?: []]);
    }

    // the core (non-DLC) manifest entries the page inlines for assets.js
    if ($op === 'core') {
        $st = $pdo->prepare(assets_entry_sel() . " WHERE a.path NOT LIKE 'dlc/%' ORDER BY a.id");
        $st->execute();
        $files = array_map('assets_entry', $st->fetchAll());
        out(['files' => $files]);
    }

    // --------------------------------------------------------------- counts
    if ($op === 'counts') {
        [$sql, $args] = $searchOn();
        if ($hasQ) {
            $rows = $pdo->prepare(
                'SELECT a.cat, COUNT(*) n FROM assets a WHERE 1=1' . $sql . ' GROUP BY a.cat');
            $rows->execute($args);
        } else {
            $rows = $pdo->query('SELECT cat, COUNT(*) n FROM assets GROUP BY cat');
        }
        $counts = ['all' => 0];
        foreach ($rows as $r) {
            $counts[$r['cat']] = (int)$r['n'];
            $counts['all'] += (int)$r['n'];
        }
        foreach (TAB_CATS as $t) {
            if ($t !== 'all') { $counts[$t] ??= 0; }
        }
        out(['counts' => $counts]);
    }

    // ----------------------------------------------------------------- list
    if ($op === 'list') {
        $tab    = q($get, 'tab', 'all');
        $char   = q($get, 'char');
        $fam    = q($get, 'fam');
        $offset = max(0, qi($get, 'offset', 0));
        $limit  = min(MAX_LIMIT, max(1, qi($get, 'limit', 240)));
        if (!in_array($tab, TAB_CATS, true)) {
            out(['error' => 'unknown tab'], 400);
        }

        if ($tab === 'anim' || $tab === 'dlc') {
            // grouped drill-down tabs (search returns a flat match list)
            if ($tab === 'anim') {
                if ($hasQ) {
                    [$sql, $args] = $searchOn([
                        "(g.char || '_' || g.name || ' ' || COALESCE(a.family,'')"
                        . " || ' ' || COALESCE(a.res_class,'') || ' ' || a.path)"]);
                    $c = $pdo->prepare(
                        "SELECT COUNT(*) FROM anim_group g"
                        . ' JOIN assets a ON a.id = g.rep_id WHERE 1=1' . $sql);
                    $c->execute($args);
                    $st = $pdo->prepare($entrySelG('g.char, g.name')
                        . ' JOIN anim_group g ON g.rep_id = a.id'
                        . ' WHERE 1=1' . $sql
                        . ' ORDER BY g.char, g.name LIMIT ? OFFSET ?');
                    $st->execute([...$args, $limit, $offset]);
                    $items = [];
                    foreach ($st->fetchAll() as $r) {
                        $items[] = ['char' => $r['char'], 'name' => $r['animation'],
                                    'entry' => $entry($r)];
                    }
                    out(['kind' => 'anims', 'total' => (int)$c->fetchColumn(),
                         'offset' => $offset, 'items' => $items]);
                }
                if ($char === '') {
                    $total = (int)$pdo->query('SELECT COUNT(*) FROM anim_char')->fetchColumn();
                    $rows = $pdo->prepare(
                        'SELECT char, thumb, rep_path, n_anims FROM anim_char'
                        . ' ORDER BY char LIMIT ? OFFSET ?');
                    $rows->execute([$limit, $offset]);
                    out(['kind' => 'chars', 'total' => $total, 'offset' => $offset,
                         'items' => $rows->fetchAll()]);
                }
                $st = $pdo->prepare($entrySelG('g.char, g.name')
                    . ' JOIN anim_group g ON g.rep_id = a.id'
                    . ' WHERE g.char = ? ORDER BY g.name LIMIT ? OFFSET ?');
                $st->execute([$char, $limit, $offset]);
                $c = $pdo->prepare('SELECT COUNT(*) FROM anim_group WHERE char=?');
                $c->execute([$char]);
                $items = [];
                foreach ($st->fetchAll() as $r) {
                    $items[] = ['name' => $r['animation'], 'entry' => $entry($r)];
                }
                out(['kind' => 'anims', 'total' => (int)$c->fetchColumn(),
                     'offset' => $offset, 'items' => $items]);
            }
            // dlc
            if ($hasQ) {
                [$sql, $args] = $searchOn([
                    "(g.name || ' ' || g.fam || ' ' || g.type || ' '"
                    . " || COALESCE(a.res_class,'') || ' ' || a.path)"]);
                $c = $pdo->prepare('SELECT COUNT(*) FROM dlc_group g'
                    . ' JOIN assets a ON a.id = g.rep_id WHERE 1=1' . $sql);
                $c->execute($args);
                $st = $pdo->prepare($entrySelG('g.fam, g.name, g.type')
                    . ' JOIN dlc_group g ON g.rep_id = a.id WHERE 1=1' . $sql
                    . ' ORDER BY g.fam, g.name, g.type LIMIT ? OFFSET ?');
                $st->execute([...$args, $limit, $offset]);
                $items = [];
                foreach ($st->fetchAll() as $r) {
                    $items[] = ['fam' => $r['fam'], 'name' => $r['name'],
                                'entry' => $entry($r)];
                }
                out(['kind' => 'files', 'total' => (int)$c->fetchColumn(),
                     'offset' => $offset, 'items' => $items]);
            }
            if ($fam === '') {
                $total = (int)$pdo->query('SELECT COUNT(*) FROM dlc_fam')->fetchColumn();
                $rows = $pdo->prepare(
                    'SELECT fam, thumb, n_assets, packs FROM dlc_fam'
                    . ' ORDER BY fam LIMIT ? OFFSET ?');
                $rows->execute([$limit, $offset]);
                out(['kind' => 'fams', 'total' => $total, 'offset' => $offset,
                     'items' => $rows->fetchAll()]);
            }
            $st = $pdo->prepare($entrySelG('g.fam, g.name, g.type')
                . ' JOIN dlc_group g ON g.rep_id = a.id'
                . ' WHERE g.fam = ? ORDER BY g.name, g.type LIMIT ? OFFSET ?');
            $st->execute([$fam, $limit, $offset]);
            $c = $pdo->prepare('SELECT COUNT(*) FROM dlc_group WHERE fam=?');
            $c->execute([$fam]);
            $items = [];
            foreach ($st->fetchAll() as $r) {
                $items[] = ['name' => $r['name'], 'entry' => $entry($r)];
            }
            out(['kind' => 'files', 'total' => (int)$c->fetchColumn(),
                 'offset' => $offset, 'items' => $items]);
        }

        // flat tabs
        $where = $tab === 'all' ? '' : ' WHERE a.cat = ?';
        $args = $tab === 'all' ? [] : [$tab];
        if ($hasQ) {
            [$sql, $sargs] = $searchOn();
            $where .= ($where ? ' AND' : ' WHERE') . substr($sql, 5); // strip leading AND
            $args = array_merge($args, $sargs);
        }
        $c = $pdo->prepare("SELECT COUNT(*) FROM assets a $where");
        $c->execute($args);
        $st = $pdo->prepare("$entrySel $where ORDER BY a.id LIMIT ? OFFSET ?");
        $st->execute([...$args, $limit, $offset]);
        out(['kind' => 'assets', 'total' => (int)$c->fetchColumn(),
             'offset' => $offset,
             'items' => array_map($entry, $st->fetchAll())]);
    }

    // ----------------------------------------------------------------- asset
    if ($op === 'asset') {
        $path = q($get, 'path');
        if ($path === '') { out(['error' => 'need path'], 400); }
        $st = $pdo->prepare("$entrySel WHERE a.path = ?");
        $st->execute([$path]);
        $row = $st->fetch();
        $e = $entry($row === false ? null : $row);
        if (!$e) { out(['error' => 'no such asset path'], 404); }
        // tell the detail pane whether the pre-conversion original is on disk
        if (($e['type'] ?? '') === 'audio') {
            $o = original_wav($path);
            if ($o !== null) {
                $e['original'] = ['bytes' => $o['bytes'], 'codec' => 'ima-adpcm'];
            }
        }
        out(['entry' => $e]);
    }

    // -------------------------------------------------------------- variants
    if ($op === 'variants') {
        $family = q($get, 'family');
        $type   = q($get, 'type');
        $path   = q($get, 'path');
        $base   = q($get, 'base');
        $res    = q($get, 'res');
        if ($family === '' || $type === '' || $path === '') {
            out(['error' => 'need family, type and path'], 400);
        }
        if ($base !== '') {
            // DLC: every other copy of this exact file (any tier/revision)
            $where = ' WHERE a.family = ? AND a.type = ? AND (a.base = ? OR a.path = ?)';
            $args = [$family, $type, $base, $path];
        } else {
            // APK: same family + type in OTHER resolution classes, + self
            $where = ' WHERE a.family = ? AND a.type = ?'
                   . ' AND (a.res_class IS NOT ? OR a.path = ?)';
            $args = [$family, $type, ($res === '' ? null : $res), $path];
        }
        $st = $pdo->prepare($entrySel . $where
            . ' ORDER BY a.tier_rank, COALESCE(p.revision, 1073741824), a.path');
        $st->execute($args);
        $items = [];
        foreach ($st->fetchAll() as $r) { $items[] = $entry($r); }
        out(['kind' => 'assets', 'items' => $items]);
    }

    // --------------------------------------------------------------- strings
    if ($op === 'strings') {
        $lang  = q($get, 'lang', 'en');
        $limit = min(5000, max(1, qi($get, 'limit', 2000)));
        $args = [$lang];
        $where = ' WHERE lang = ?';
        if ($hasQ) {
            $where .= " AND (key || ' ' || value) LIKE ? ESCAPE '\\'";
            $args[] = like($q);
        }
        $c = $pdo->prepare("SELECT COUNT(*) FROM strings $where");
        $c->execute($args);
        $st = $pdo->prepare(
            "SELECT key, value FROM strings $where ORDER BY key LIMIT ?");
        $st->execute([...$args, $limit]);
        $rows = [];
        foreach ($st->fetchAll() as $r) { $rows[] = [$r['key'], $r['value']]; }
        out(['lang' => $lang, 'total' => (int)$c->fetchColumn(), 'rows' => $rows]);
    }

    // ------------------------------------------------------------------ data
    if ($op === 'data') {
        $path = q($get, 'path');
        if ($path === '') { out(['error' => 'need path'], 400); }
        $st = $pdo->prepare('SELECT text FROM data_text WHERE path = ?');
        $st->execute([$path]);
        $t = $st->fetchColumn();
        out(['path' => $path, 'text' => $t === false ? null : (string)$t]);
    }

    // --------------------------------------------------------- original audio
    if ($op === 'original') {
        $path = q($get, 'path');
        $o = original_wav($path);
        if ($o === null) { out(['error' => 'no original WAV for that path'], 404); }
        // only files the board knows about, and only audio: the backup tree
        // mirrors web/assets, so the DB is the allow-list
        $st = $pdo->prepare('SELECT type FROM assets WHERE path = ?');
        $st->execute([$path]);
        if ($st->fetchColumn() !== 'audio') { out(['error' => 'no such audio asset'], 404); }
        $name = preg_replace('/\.(wav|m4a)$/i', '', basename($path)) . '-original.wav';
        if (php_sapi_name() === 'cli') {
            clean_stray_output();                 // do not buffer a WAV in RAM
            $to = q($get, 'out', '');
            if ($to !== '') { copy($o['file'], $to); fwrite(STDERR, "wrote $to\n"); }
            else { readfile($o['file']); }
            exit;
        }
        $etag = '"' . sha1($o['file'] . '|' . $o['bytes'] . '|' . $o['mtime']) . '"';
        if (($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) {
            clean_stray_output();
            http_response_code(304);
            exit;
        }
        if (!@is_readable($o['file'])) {
            out(['error' => 'original not readable'], 404);
        }
        clean_stray_output();
        header('Content-Type: audio/x-wav');
        header('Content-Length: ' . $o['bytes']);
        header('Content-Disposition: attachment; filename="' . $name . '"');
        header('ETag: ' . $etag);
        header('Cache-Control: public, max-age=31536000, immutable');
        if (@readfile($o['file']) === false) { exit(1); }   // log has the reason
        exit;
    }

    out(['error' => 'unknown op'], 400);
} catch (Throwable $e) {
    $missing = str_contains($e->getMessage(), 'assets database missing');
    out(['error' => $missing ? $e->getMessage()
                              : 'assets api unavailable'], $missing ? 503 : 500);
}
