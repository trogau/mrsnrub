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
     op=languages                             the 16 decoded languages
     op=meta                                  manifest meta + totals

   Also runs under CLI for the smoke harness:
     php web/api/assets.php 'op=list&tab=image&limit=5'
*/
declare(strict_types=1);

require __DIR__ . '/assets-db.php';

const MAX_LIMIT = 1000;
const TAB_CATS  = ['all', 'image', 'audio', 'video', 'anim', 'font',
                   'i18n', 'data', 'dlc', 'android'];

function out(array $a, int $code = 200): void {
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
        out(['meta' => $meta, 'total' => $total, 'cats' => $catCounts]);
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

    out(['error' => 'unknown op'], 400);
} catch (Throwable $e) {
    $missing = str_contains($e->getMessage(), 'assets database missing');
    out(['error' => $missing ? $e->getMessage()
                              : 'assets api unavailable'], $missing ? 503 : 500);
}
