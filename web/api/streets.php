<?php
/* M4 street-validation verdict store (City View, 2026-10-18).
   Serves the CANDIDATE N–S street list and persists per-street user
   verdicts (pending | ok | bad) in SQLite next to this file. The page
   (js/city-view.js) fetches GET with no args and POSTs JSON:
     {action:"verdict", id:<int>, verdict:"ok"|"bad"|"pending", note?}
     {action:"add",     x0,x1,ylo,yhi (ints), src?}      -> new row
     {action:"delete",  id}                               (user rows only)
   Promoting an 'ok' street into Terrain.AVENUE.streets (web/js/terrain.js)
   stays a manual per-street code change — this API records the eye test,
   it never mutates the shipped street table. Seeds mirror the built-in
   fallback list in Terrain.PROPOSED; keep the two in sync. */
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function out(array $a, int $code = 200): void {
    http_response_code($code);
    echo json_encode($a);
    exit;
}

/* Character-safe truncate without mbstring (not loaded on this box): /u
   counts codepoints; input is JSON-decoded so already valid UTF-8, with a
   byte-truncate fallback if the regex ever fails. */
function clip(string $s, int $n): string {
    return preg_match('/^.{0,' . $n . '}/us', $s, $m) ? $m[0] : substr($s, 0, $n);
}

function seeds(): array {
    /* MUST mirror Terrain.PROPOSED.streets (web/js/terrain.js) — the
       offline/file:// fallback list. The east arm extends the pitch-24
       grid to the coast (saved E-W avenues + dense road cells run to
       x~511 with sand to the NE, notes/06 s10); the half-pitch samples
       test whether the east grid is +12-offset like the x 126 case. */
    return [
        [126, 127, 146, 208, 'PROMOTED to Terrain.AVENUE 2026-10-18 (was crosswalk-straddle candidate)'],
        [118, 119, 263, 272, 're-measure — partially correct 2026-10-17'],
        [138, 139, 146, 282, 'pitch-24 from 114'],
        [162, 163, 146, 282, 'pitch-24 from 114'],
        [186, 187, 146, 282, 'pitch-24 from 114'],
        [210, 211, 146, 282, 'pitch-24 from 114'],
        [234, 235, 146, 282, 'pitch-24 from 114'],
        [258, 259, 146, 282, 'pitch-24 from 114'],
        [282, 283, 146, 282, 'pitch-24 from 114'],
        [42, 43, 146, 282, 'fills 30→66 gap'],
        [6, 7, 146, 282, 'pitch-24 west of 30'],
        [306, 307, 146, 282, 'pitch-24 east to the coast'],
        [330, 331, 146, 282, 'pitch-24 east to the coast'],
        [354, 355, 146, 282, 'pitch-24 east to the coast'],
        [378, 379, 146, 282, 'pitch-24 east to the coast'],
        [402, 403, 146, 282, 'pitch-24 east to the coast'],
        [426, 427, 146, 282, 'pitch-24 east to the coast'],
        [450, 451, 146, 282, 'pitch-24 east to the coast'],
        [474, 475, 146, 282, 'pitch-24 east to the coast'],
        [498, 499, 146, 282, 'pitch-24 east to the coast'],
        [318, 319, 146, 282, 'half-pitch sample — east grid +12-offset?'],
        [390, 391, 146, 282, 'half-pitch sample — east grid +12-offset?'],
        [462, 463, 146, 282, 'half-pitch sample — east grid +12-offset?'],
        [124, 143, 174, 175, 'E-W road — police stn south, saved-row twin x 128–143'],
    ];
}

function seed(PDO $pdo): void {
    $ins = $pdo->prepare('INSERT INTO streets (x0,x1,ylo,yhi,src) VALUES (?,?,?,?,?)');
    $pdo->beginTransaction();
    foreach (seeds() as $r) {
        $ins->execute($r);
    }
    $pdo->commit();
}

/* Idempotent top-up for databases seeded before new candidates were
   authored: inserts only seed rows whose (x0,x1,ylo,yhi) is absent, so
   verdicts on existing rows and user-added rows are untouched. */
function syncSeeds(PDO $pdo): void {
    $has = $pdo->prepare('SELECT 1 FROM streets WHERE x0=? AND x1=? AND ylo=? AND yhi=?');
    $ins = $pdo->prepare('INSERT INTO streets (x0,x1,ylo,yhi,src) VALUES (?,?,?,?,?)');
    $pdo->beginTransaction();
    foreach (seeds() as $r) {
        $has->execute([$r[0], $r[1], $r[2], $r[3]]);
        if (!$has->fetchColumn()) {
            $ins->execute($r);
        }
    }
    $pdo->commit();
}

try {
    $pdo = new PDO('sqlite:' . __DIR__ . '/streets.sqlite', null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    $pdo->exec('PRAGMA journal_mode=WAL');
    $pdo->exec(<<<'SQL'
        CREATE TABLE IF NOT EXISTS streets (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            x0      INTEGER NOT NULL,
            x1      INTEGER NOT NULL,
            ylo     INTEGER NOT NULL,
            yhi     INTEGER NOT NULL,
            src     TEXT    NOT NULL DEFAULT '',
            verdict TEXT    NOT NULL DEFAULT 'pending',
            note    TEXT    NOT NULL DEFAULT '',
            addedby TEXT    NOT NULL DEFAULT 'seed',
            updated TEXT    NOT NULL DEFAULT (datetime('now'))
        )
SQL);
    if ((int)$pdo->query('SELECT COUNT(*) FROM streets')->fetchColumn() === 0) {
        seed($pdo);
    } else {
        syncSeeds($pdo);        // pick up candidates authored after first seed
    }

    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($method === 'GET') {
        $streets = $pdo->query(
            'SELECT id,x0,x1,ylo,yhi,src,verdict,note,addedby FROM streets'
            . ' ORDER BY x0,ylo,id'
        )->fetchAll();
        $verdicts = [];
        foreach ($streets as $s) {
            if ($s['verdict'] !== 'pending') {
                $verdicts[(string)$s['id']] = $s['verdict'];
            }
        }
        out(['streets' => $streets, 'verdicts' => $verdicts]);
    }

    if ($method !== 'POST') {
        out(['error' => 'method not allowed'], 405);
    }

    /* Body source: php://input on the web SAPI. CLI has no request stream,
       so CLI (tools/ smoke + manual checks) pipes the JSON body in via the
       STREETS_TEST_BODY env var instead. */
    $raw = php_sapi_name() === 'cli'
        ? (string)(getenv('STREETS_TEST_BODY') ?: '')
        : (string)file_get_contents('php://input');
    $body = json_decode($raw ?: '', true);
    if (!is_array($body)) {
        out(['error' => 'expected a JSON body'], 400);
    }
    $action = $body['action'] ?? '';

    if ($action === 'verdict') {
        $id = filter_var($body['id'] ?? null, FILTER_VALIDATE_INT);
        $verdict = $body['verdict'] ?? 'pending';
        if ($id === false || $id === null ||
            !in_array($verdict, ['pending', 'ok', 'bad'], true)) {
            out(['error' => 'need id (int) and verdict in pending|ok|bad'], 400);
        }
        $note = is_string($body['note'] ?? null)
            ? clip(trim($body['note']), 200) : '';
        $n = $pdo->prepare(
            "UPDATE streets SET verdict=?, note=?, updated=datetime('now') WHERE id=?"
        );
        $n->execute([$verdict, $note, $id]);
        if ($n->rowCount() === 0 &&
            !$pdo->query('SELECT 1 FROM streets WHERE id=' . (int)$id)->fetchColumn()) {
            out(['error' => 'no such street id'], 404);
        }
        out(['ok' => true, 'id' => $id, 'verdict' => $verdict]);
    }

    if ($action === 'add') {
        $x0 = filter_var($body['x0'] ?? null, FILTER_VALIDATE_INT);
        $x1 = filter_var($body['x1'] ?? null, FILTER_VALIDATE_INT);
        $ylo = filter_var($body['ylo'] ?? null, FILTER_VALIDATE_INT);
        $yhi = filter_var($body['yhi'] ?? null, FILTER_VALIDATE_INT);
        $src = is_string($body['src'] ?? null)
            ? clip(trim($body['src']), 120) : 'user';
        if (in_array(false, [$x0, $x1, $ylo, $yhi], true) ||
            in_array(null, [$x0, $x1, $ylo, $yhi], true)) {
            out(['error' => 'need integer x0,x1,ylo,yhi'], 400);
        }
        if ($x0 > $x1) { [$x0, $x1] = [$x1, $x0]; }
        if ($ylo > $yhi) { [$ylo, $yhi] = [$yhi, $ylo]; }
        if ($x0 < 0 || $x1 > 511 || $ylo < 0 || $yhi > 1086 ||
            ($x1 - $x0) > 1 || ($yhi - $ylo) > 1000) {
            out(['error' => 'out of range (grid 0..511 x 0..1086, <=2 cols wide)'], 400);
        }
        $dup = $pdo->prepare(
            'SELECT id FROM streets WHERE x0=? AND x1=? AND ylo=? AND yhi=?'
        );
        $dup->execute([$x0, $x1, $ylo, $yhi]);
        if ($row = $dup->fetchColumn()) {
            out(['ok' => true, 'id' => (int)$row, 'existed' => true]);
        }
        $ins = $pdo->prepare(
            "INSERT INTO streets (x0,x1,ylo,yhi,src,addedby,updated)"
            . " VALUES (?,?,?,?,?,'user',datetime('now'))"
        );
        $ins->execute([$x0, $x1, $ylo, $yhi, $src]);
        out(['ok' => true, 'id' => (int)$pdo->lastInsertId()]);
    }

    if ($action === 'delete') {
        $id = filter_var($body['id'] ?? null, FILTER_VALIDATE_INT);
        if ($id === false || $id === null) {
            out(['error' => 'need id (int)'], 400);
        }
        $n = $pdo->prepare("DELETE FROM streets WHERE id=? AND addedby='user'");
        $n->execute([$id]);
        if ($n->rowCount() === 0) {
            out(['error' => 'only user-added rows can be deleted'], 400);
        }
        out(['ok' => true, 'deleted' => $id]);
    }

    out(['error' => 'unknown action'], 400);
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode(['error' => 'streets api unavailable']);
}
