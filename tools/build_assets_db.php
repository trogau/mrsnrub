<?php
/* build_assets_db.php — build web/api/assets.sqlite from the extraction
   pipeline output (web/assets/manifest.js + manifest-parts/*.js +
   web/assets/data/webdata.js).

   The manifest grew with the CDN archive to ~2.1M entries / ~2.2 GB of
   parts, so the Asset Explorer can no longer load it in the browser.
   This tool indexes it into SQLite once; web/api/assets.php serves the
   queries (grid pages, tab counts, search, variants, strings, data text)
   and web/assets-explorer.php inlines the few hundred core (non-DLC)
   entries the game's own modules (assets.js/i18n.js) still need.

   Usage:
     php tools/build_assets_db.php [--web=web] [--db=web/api/assets.sqlite]

   Rebuild is idempotent: the database is recreated from scratch.
   Stored entry JSON keeps every manifest field; rows also carry derived
   columns used only for querying/grouping (cat, tier_rank, base, ...).
*/
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit("CLI only\n");
}

$opt = [];
foreach (array_slice($argv, 1) as $a) {
    if (preg_match('/^--([^=]+)(?:=(.*))?$/', $a, $m)) {
        $opt[$m[1]] = $m[2] ?? true;
    } else {
        exit("unknown argument: $a\n");
    }
}
$root = dirname(__DIR__);
$web  = $opt['web'] ?? ($root . '/web');
$db   = $opt['db']  ?? ($web . '/api/assets.sqlite');

$t0 = microtime(true);
function say(string $s): void {
    fwrite(STDERR, $s . "\n");
}

// ---------------------------------------------------------------- manifest
$manifestJs = file_get_contents($web . '/assets/manifest.js');
if ($manifestJs === false) {
    exit("cannot read {$web}/assets/manifest.js\n");
}
if (!preg_match('/var parts = \[(.*?)\];/', $manifestJs, $m)) {
    exit("no parts list in manifest.js\n");
}
$parts = array_map(fn($p) => trim(trim($p), '"'), explode(',', $m[1]));

/* meta object: brace-scan from the "var m = {" start so strings (which
   contain braces and brackets) are respected. */
function extract_object(string $src, string $needle): ?string {
    $at = strpos($src, $needle);
    if ($at === false) { return null; }
    $i = strpos($src, '{', $at);
    $n = strlen($src);
    $depth = 0; $inStr = false; $esc = false;
    for ($j = $i; $j < $n; $j++) {
        $c = $src[$j];
        if ($inStr) {
            if ($esc) { $esc = false; }
            elseif ($c === '\\') { $esc = true; }
            elseif ($c === '"') { $inStr = false; }
            continue;
        }
        if ($c === '"') { $inStr = true; }
        elseif ($c === '{') { $depth++; }
        elseif ($c === '}') {
            $depth--;
            if ($depth === 0) { return substr($src, $i, $j - $i + 1); }
        }
    }
    return null;
}
$metaJson = extract_object($manifestJs, 'var m =');
$meta = $metaJson !== null ? json_decode($metaJson, true) : null;
if (!is_array($meta)) { exit("could not parse manifest meta\n"); }

// ------------------------------------------------------------ streaming JSON
/* Stream the top-level objects out of a `window.__MANIFEST_PARTS.push([...])`
   file without ever holding a part (157 MB) decoded in memory: jump between
   structural characters, track string context, emit balanced { } blocks. */
function stream_entries(string $file, callable $cb): void {
    $fh = fopen($file, 'rb');
    if (!$fh) { exit("cannot read $file\n"); }
    $started = false;          // seen the opening [
    $depth = 0;
    $inStr = false;
    $cur = '';
    $carry = '';
    $eof = false;
    while (true) {
        if (!$eof) {
            $chunk = fread($fh, 1 << 22);
            if ($chunk === false || $chunk === '') { $eof = true; }
            else { $carry .= $chunk; }
        }
        $len = strlen($carry);
        $i = 0;
        while ($i < $len) {
            if (!$started) {
                $p = strpos($carry, '[', $i);
                if ($p === false) { break; }
                $started = true;
                $i = $p + 1;
                continue;
            }
            if ($inStr) {
                // find the closing quote, honouring backslash escapes
                $p = $i;
                while (true) {
                    $p = strpos($carry, '"', $p);
                    if ($p === false) { break; }
                    $b = $p - 1; $back = 0;
                    while ($b >= 0 && $carry[$b] === '\\') { $back++; $b--; }
                    if ($back % 2 === 0) { break; }   // unescaped quote
                    $p++;
                }
                if ($p === false) { break; }           // continue next chunk
                $cur .= substr($carry, $i, $p - $i + 1);
                $inStr = false;
                $i = $p + 1;
                continue;
            }
            // outside a string: jump to the next ", { or }
            $p = $i + strcspn($carry, '"{}', $i);
            if ($p >= $len) { break; }                 // nothing structural left
            $c = $carry[$p];
            if ($depth === 0) {
                if ($c === '{') { $depth = 1; $cur = '{'; }
                $i = $p + 1;
                continue;
            }
            // inside an object: copy the skipped run, then the structural char
            $cur .= substr($carry, $i, $p - $i) . $c;
            if ($c === '"') { $inStr = true; }
            elseif ($c === '{') { $depth++; }
            elseif ($c === '}') {
                $depth--;
                if ($depth === 0) { $cb($cur); $cur = ''; }
            }
            $i = $p + 1;
        }
        $carry = $i > 0 ? substr($carry, $i) : $carry;
        if ($eof) { break; }
    }
    fclose($fh);
}

// --------------------------------------------------------------- schema
$ddl = <<<'SQL'
DROP TABLE IF EXISTS meta;
DROP TABLE IF EXISTS sources;
DROP TABLE IF EXISTS packs;
DROP TABLE IF EXISTS assets;
DROP TABLE IF EXISTS anim_group;
DROP TABLE IF EXISTS anim_char;
DROP TABLE IF EXISTS dlc_group;
DROP TABLE IF EXISTS dlc_fam;
DROP TABLE IF EXISTS strings;
DROP TABLE IF EXISTS data_text;
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE sources (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE packs (
    id INTEGER PRIMARY KEY,
    pack TEXT NOT NULL,
    season TEXT, tier TEXT,
    revision INTEGER,
    url TEXT,
    index_version INTEGER,
    UNIQUE (pack, revision)
);
CREATE TABLE assets (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    base TEXT NOT NULL,
    type TEXT NOT NULL,
    cat TEXT NOT NULL,
    source_id INTEGER REFERENCES sources(id),
    origin TEXT, family TEXT, res_class TEXT,
    tier_rank INTEGER NOT NULL DEFAULT 0,
    kind TEXT, bytes INTEGER, w INTEGER, h INTEGER,
    duration_s REAL, channels INTEGER, sample_rate INTEGER,
    codec TEXT, vcodec TEXT, acodec TEXT, audio_format INTEGER,
    bpp INTEGER, premul INTEGER, anchor TEXT,
    thumb TEXT,
    char TEXT, animation TEXT, n_cells INTEGER, n_frames INTEGER,
    frames TEXT,
    strings INTEGER,
    decode_error TEXT,
    pack_id INTEGER REFERENCES packs(id)
);
CREATE INDEX assets_cat   ON assets(cat, id);
CREATE INDEX assets_type  ON assets(type);
CREATE INDEX assets_fam   ON assets(family, type, base);
CREATE INDEX assets_char  ON assets(char, animation);
CREATE TABLE anim_group (
    char TEXT NOT NULL, name TEXT NOT NULL,
    rep_id INTEGER NOT NULL, thumb TEXT, variants INTEGER NOT NULL,
    PRIMARY KEY (char, name)
);
CREATE TABLE anim_char (
    char TEXT PRIMARY KEY, thumb TEXT, rep_path TEXT, n_anims INTEGER NOT NULL
);
CREATE TABLE dlc_group (
    fam TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
    rep_id INTEGER NOT NULL, packs INTEGER NOT NULL
);
CREATE INDEX dlc_group_fam ON dlc_group(fam, name);
CREATE TABLE dlc_fam (
    fam TEXT PRIMARY KEY, thumb TEXT, n_assets INTEGER NOT NULL,
    packs INTEGER NOT NULL
);
CREATE TABLE strings (
    lang TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL
);
CREATE INDEX strings_lang ON strings(lang, key);
CREATE TABLE data_text (path TEXT PRIMARY KEY, text TEXT NOT NULL);
SQL;

@unlink($db);
@unlink($db . '-wal');
@unlink($db . '-shm');
$pdo = new PDO('sqlite:' . $db, null, null, [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
]);
$pdo->exec('PRAGMA journal_mode=DELETE');      // read-mostly: no WAL sidecars
$pdo->exec('PRAGMA synchronous=OFF');
$pdo->exec('BEGIN');
foreach (explode(';', $ddl) as $stmt) {
    if (trim($stmt) !== '') { $pdo->exec($stmt); }
}
$pdo->exec('COMMIT');

// ------------------------------------------------------------ row helpers
$CLASS_RANK = [
    'small' => 0, 'medium-small' => 1, 'medium' => 2, 'large' => 3,
    'mdpi' => 0, 'hdpi' => 1, 'xhdpi' => 2, 'xxhdpi' => 3, 'xxxhdpi' => 4,
    'drawable' => 5,
    'iphone' => 0, 'ipad' => 1, 'retina' => 2, 'ipad3' => 3,
];
function tier_rank(?string $resClass, array $CLASS_RANK): int {
    if ($resClass === null || $resClass === '') { return 0; }
    $k = strtolower($resClass);
    if (isset($CLASS_RANK[$k])) { return $CLASS_RANK[$k]; }
    return is_numeric($k) ? (int)$k : 0;
}
function cat_of(array $e): string {
    if (($e['type'] ?? '') === 'video') { return 'video'; }
    if (($e['type'] ?? '') === 'anim')  { return 'anim'; }
    if (str_starts_with($e['path'] ?? '', 'dlc/')) { return 'dlc'; }
    if (str_starts_with($e['source'] ?? '', 'res/')) { return 'android'; }
    if (($e['type'] ?? '') === 'text' || ($e['type'] ?? '') === 'data') { return 'data'; }
    return $e['type'] ?? 'data';
}

$srcId = [];   // source name -> id
function source_id(PDO $pdo, array &$srcId, ?string $name): ?int {
    if ($name === null || $name === '') { return null; }
    if (!isset($srcId[$name])) {
        $pdo->prepare('INSERT OR IGNORE INTO sources (name) VALUES (?)')
            ->execute([$name]);
        $q = $pdo->prepare('SELECT id FROM sources WHERE name = ?');
        $q->execute([$name]);
        $srcId[$name] = (int)$q->fetchColumn();
    }
    return $srcId[$name];
}
$packId = [];  // "pack|revision" -> id
function pack_id(PDO $pdo, array &$packId, array $dlc): ?int {
    if (empty($dlc['pack'])) { return null; }
    $rev = isset($dlc['revision']) ? (int)$dlc['revision'] : null;
    $key = $dlc['pack'] . '|' . ($rev ?? '');
    if (!isset($packId[$key])) {
        $pdo->prepare('INSERT OR IGNORE INTO packs'
            . ' (pack,season,tier,revision,url,index_version) VALUES (?,?,?,?,?,?)')
            ->execute([
                $dlc['pack'], $dlc['season'] ?? null, $dlc['tier'] ?? null,
                $rev, $dlc['url'] ?? null,
                isset($dlc['indexVersion']) ? (int)$dlc['indexVersion'] : null,
            ]);
        $q = $pdo->prepare(
            'SELECT id FROM packs WHERE pack = ? AND revision IS ?');
        $q->execute([$dlc['pack'], $rev]);
        $packId[$key] = (int)$q->fetchColumn();
    }
    return $packId[$key];
}

$ins = $pdo->prepare(<<<'SQL'
INSERT OR REPLACE INTO assets (
    path, base, type, cat, source_id, origin, family, res_class, tier_rank,
    kind, bytes, w, h, duration_s, channels, sample_rate, codec, vcodec,
    acodec, audio_format, bpp, premul, anchor, thumb, char, animation,
    n_cells, n_frames, frames, strings, decode_error, pack_id
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
SQL
);

function asset_row(array $e, array $CLASS_RANK): array {
    $path = $e['path'] ?? '';
    $base = basename($path);
    $type = $e['type'] ?? 'data';
    $char = $e['char'] ?? null;
    $anim = $e['animation'] ?? null;
    if ($type === 'anim') {
        if ($char === null) { $u = strpos($base, '_'); $char = $u === false ? $base : substr($base, 0, $u); }
        if ($anim === null) { $anim = preg_replace('/_f\d*\.png$/', '', $base); }
    }
    return [
        $path, $base, $type, cat_of($e),
        $e['source'] ?? null,                       // source_id filled below
        $e['origin'] ?? null, $e['family'] ?? null,
        $e['resClass'] ?? null,
        tier_rank($e['resClass'] ?? null, $CLASS_RANK),
        $e['kind'] ?? null,
        isset($e['bytes']) ? (int)$e['bytes'] : null,
        isset($e['w']) ? (int)$e['w'] : null,
        isset($e['h']) ? (int)$e['h'] : null,
        isset($e['duration_s']) ? (float)$e['duration_s'] : null,
        isset($e['channels']) ? (int)$e['channels'] : null,
        isset($e['sample_rate']) ? (int)$e['sample_rate'] : null,
        $e['codec'] ?? null, $e['vcodec'] ?? null, $e['acodec'] ?? null,
        isset($e['audio_format']) ? (int)$e['audio_format'] : null,
        isset($e['bpp']) ? (int)$e['bpp'] : null,
        isset($e['premul']) ? (($e['premul'] === false) ? 0 : 1) : null,
        isset($e['anchor']) ? json_encode($e['anchor']) : null,
        $e['thumb'] ?? null,
        $char, $anim,
        isset($e['n_cells']) ? (int)$e['n_cells'] : null,
        isset($e['n_frames']) ? (int)$e['n_frames'] : null,
        isset($e['frames']) ? json_encode($e['frames']) : null,
        isset($e['strings']) ? (int)$e['strings'] : null,
        $e['decode_error'] ?? null,
        null,                                       // pack_id filled below
    ];
}

// ------------------------------------------------------------- ingest
$seen = 0;
$skipped = 0;
$partN = 0;
foreach ($parts as $p) {
    $file = $web . '/assets/manifest-parts/' . $p;
    $partN++;
    $tp = microtime(true);
    $before = $seen;
    $pdo->prepare('BEGIN')->execute();
    stream_entries($file, function (string $json) use (&$seen, &$skipped, $CLASS_RANK) {
        global $pdo, $srcId, $packId;
        $e = json_decode($json, true);
        if (!is_array($e) || !isset($e['path'])) { $skipped++; return; }
        $row = asset_row($e, $CLASS_RANK);
        $row[4]  = source_id($pdo, $srcId, $row[4]);
        $row[31] = pack_id($pdo, $packId, $e['dlc'] ?? []);
        $ins = $GLOBALS['ins'];
        $ins->execute($row);
        $seen++;
    });
    $pdo->exec('COMMIT');
    say(sprintf('  %s: %d entries (%.1fs)', $p, $seen - $before, microtime(true) - $tp));
}
say("ingested $seen entries" . ($skipped ? " ($skipped unparsable skipped)" : ''));

// ------------------------------------------------------------- groups
say('building groups...');
$pdo->exec(<<<'SQL'
INSERT INTO anim_group (char, name, rep_id, thumb, variants)
SELECT char, name, id, thumb, cnt FROM (
    SELECT a.id, a.char, a.animation AS name, a.thumb,
           ROW_NUMBER() OVER (PARTITION BY a.char, a.animation
               ORDER BY a.tier_rank DESC, (a.thumb IS NOT NULL) DESC,
                        COALESCE(p.revision, 1073741824) DESC, a.path) rn,
           COUNT(*)     OVER (PARTITION BY a.char, a.animation) cnt
    FROM assets a LEFT JOIN packs p ON p.id = a.pack_id
    WHERE a.type = 'anim'
) WHERE rn = 1
SQL);

$pdo->exec(<<<'SQL'
INSERT INTO anim_char (char, thumb, rep_path, n_anims)
SELECT g.char,
       (SELECT a.thumb FROM anim_group g2
          JOIN assets a ON a.id = g2.rep_id
         WHERE g2.char = g.char AND g2.thumb IS NOT NULL
         ORDER BY g2.name LIMIT 1),
       (SELECT a.path FROM anim_group g2
          JOIN assets a ON a.id = g2.rep_id
         WHERE g2.char = g.char
         ORDER BY g2.name LIMIT 1),
       COUNT(*)
FROM anim_group g GROUP BY g.char
SQL);

$pdo->exec(<<<'SQL'
CREATE TEMP TABLE dlc_ranked AS
SELECT fam, name, type, id, COUNT(*) OVER (PARTITION BY fam, name, type) cnt
FROM (
    SELECT a.family AS fam, a.base AS name, a.type,
           a.id,
           ROW_NUMBER() OVER (PARTITION BY a.family, a.base, a.type
               ORDER BY a.tier_rank DESC, (a.thumb IS NOT NULL) DESC,
                        COALESCE(p.revision, 1073741824) DESC, a.path) rn
    FROM assets a LEFT JOIN packs p ON p.id = a.pack_id
    WHERE a.cat = 'dlc'
) WHERE rn = 1
SQL);
$pdo->exec(<<<'SQL'
INSERT INTO dlc_group (fam, name, type, rep_id, packs)
SELECT r.fam, r.name, r.type, r.id,
       (SELECT COUNT(DISTINCT a.pack_id) FROM assets a
         WHERE a.cat = 'dlc' AND a.family = r.fam
           AND a.base = r.name AND a.type = r.type)
FROM dlc_ranked r
SQL);
$pdo->exec(<<<'SQL'
INSERT INTO dlc_fam (fam, thumb, n_assets, packs)
SELECT f.fam,
       (SELECT COALESCE(a.thumb, a.path) FROM dlc_group g
          JOIN assets a ON a.id = g.rep_id
         WHERE g.fam = f.fam AND g.type = 'image'
         ORDER BY g.name LIMIT 1),
       f.n,
       (SELECT COUNT(DISTINCT a.pack_id) FROM assets a
         WHERE a.cat = 'dlc' AND a.family = f.fam)
FROM (SELECT fam, COUNT(*) n FROM dlc_group GROUP BY fam) f
SQL);

// ------------------------------------------------------------- webdata
$webdataJs = file_get_contents($web . '/assets/data/webdata.js');
if ($webdataJs === false) { exit("cannot read webdata.js\n"); }
$i = strpos($webdataJs, '{');
$j = strrpos($webdataJs, '}');
$D = json_decode(substr($webdataJs, $i, $j - $i + 1), true);
if (!is_array($D)) { exit("could not parse webdata.js\n"); }

$pdo->prepare('BEGIN')->execute();
$insS = $pdo->prepare('INSERT INTO strings (lang, key, value) VALUES (?,?,?)');
foreach (($D['i18n'] ?? []) as $lang => $tbl) {
    foreach ($tbl as $k => $v) { $insS->execute([$lang, (string)$k, (string)$v]); }
}
$insT = $pdo->prepare('INSERT OR REPLACE INTO data_text (path, text) VALUES (?,?)');
foreach (($D['dataText'] ?? []) as $p => $t) { $insT->execute([$p, (string)$t]); }
$pdo->exec('COMMIT');

// ------------------------------------------------------------------ meta
$meta['builtAt'] = date('c');
$meta['entryCount'] = (int)$pdo->query('SELECT COUNT(*) FROM assets')->fetchColumn();
$insM = $pdo->prepare('INSERT INTO meta (key, value) VALUES (?,?)');
$insM->execute(['manifest', json_encode($meta, JSON_UNESCAPED_SLASHES)]);
$insM->execute(['languages', json_encode($D['languages'] ?? [])]);
$insM->execute(['tabDefs', json_encode([
    ['id' => 'all', 'label' => 'All'],
    ['id' => 'image', 'label' => 'Images'],
    ['id' => 'audio', 'label' => 'Audio'],
    ['id' => 'video', 'label' => 'Movies'],
    ['id' => 'anim', 'label' => 'Animations'],
    ['id' => 'font', 'label' => 'Fonts'],
    ['id' => 'i18n', 'label' => 'Strings'],
    ['id' => 'data', 'label' => 'Data'],
    ['id' => 'dlc', 'label' => 'DLC'],
    ['id' => 'android', 'label' => 'Android shell'],
])]);

$pdo->exec('PRAGMA optimize');
@chmod($db, 0644);
say(sprintf("wrote %s (%.1f MB) in %.1fs", $db,
    filesize($db) / 1048576, microtime(true) - $t0));
