<?php
/* Progress dashboard API (2026-10-18).
   Serves the latest scanner snapshot (meters + per-bundle coverage grid +
   trend history) written by tools/progress_scan.py into progress.sqlite
   next to this file, and persists the hand-maintained layers: the task
   board (tasks) and the free-form journal (snap_log). The page
   (js/progress.js) fetches GET with no args and POSTs JSON:
     {action:"task-add",    title, kind?, notes?}          kind task|milestone|decision
     {action:"task-update", id, status?, title?, notes?}   status in TASK_STATUSES
     {action:"task-delete", id}
     {action:"log",         message}
   Scan data (snapshots/metrics/coverage) is READ-ONLY here by design —
   only the scanner writes it, so the browser can never fake progress.
   CLI (tools/smoke-progress.py + manual checks) has no request stream:
   point it at a fixture DB with PROGRESS_DB=<path> and pass the POST body
   via the PROGRESS_TEST_BODY env var (same trick as streets.php). */
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

const KINDS = ['task', 'milestone', 'decision'];
const STATUSES = ['todo', 'doing', 'done', 'blocked', 'deferred',
                  'pending-approval'];
const HISTORY_N = 60;      // snapshots deep per metric trend

function out(array $a, int $code = 200): void {
    http_response_code($code);
    echo json_encode($a);
    exit;
}

/* Character-safe truncate without mbstring (not loaded on this box). */
function clip(string $s, int $n): string {
    return preg_match('/^.{0,' . $n . '}/us', $s, $m) ? $m[0] : substr($s, 0, $n);
}

$dbFile = getenv('PROGRESS_DB') ?: (__DIR__ . '/progress.sqlite');
if (!is_file($dbFile)) {
    out(['error' => 'no progress database yet — run: python3 tools/progress_scan.py'],
        503);
}
try {
    $pdo = new PDO('sqlite:' . $dbFile, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
} catch (PDOException $e) {
    out(['error' => 'cannot open progress db'], 500);
}
$pdo->exec('PRAGMA journal_mode=WAL');

/* CLI (smoke tests) has no request stream: a non-empty PROGRESS_TEST_BODY
   is treated as a POST, mirroring the body-source trick below. */
$method = $_SERVER['REQUEST_METHOD']
    ?? (getenv('PROGRESS_TEST_BODY') ? 'POST' : 'GET');

if ($method === 'POST') {
    $raw = php_sapi_name() === 'cli'
        ? (string)(getenv('PROGRESS_TEST_BODY') ?: '')
        : (string)file_get_contents('php://input');
    $body = json_decode($raw ?: '', true);
    if (!is_array($body)) {
        out(['error' => 'expected a JSON body'], 400);
    }
    $action = $body['action'] ?? '';

    if ($action === 'task-add') {
        $title = clip(trim((string)($body['title'] ?? '')), 160);
        if ($title === '') {
            out(['error' => 'title required'], 400);
        }
        $kind = in_array($body['kind'] ?? 'task', KINDS, true)
            ? ($body['kind'] ?? 'task') : 'task';
        $status = in_array($body['status'] ?? 'todo', STATUSES, true)
            ? ($body['status'] ?? 'todo') : 'todo';
        $notes = clip(trim((string)($body['notes'] ?? '')), 1000);
        $ord = (int)$pdo->query('SELECT COALESCE(MAX(ord)+1,0) FROM tasks')
            ->fetchColumn();
        $pdo->prepare('INSERT INTO tasks(title,kind,status,source,notes,ord)'
            . " VALUES (?,?,?,'user',?,?)")
            ->execute([$title, $kind, $status, $notes, $ord]);
        out(['ok' => true, 'id' => (int)$pdo->lastInsertId()]);
    }

    if ($action === 'task-update') {
        $id = filter_var($body['id'] ?? null, FILTER_VALIDATE_INT);
        if ($id === false || $id === null) {
            out(['error' => 'need id (int)'], 400);
        }
        $sets = [];
        $args = [];
        foreach (['status' => STATUSES, 'kind' => KINDS] as $f => $allowed) {
            if (isset($body[$f])) {
                if (!in_array($body[$f], $allowed, true)) {
                    out(['error' => "$f must be one of "
                        . implode('|', $allowed)], 400);
                }
                $sets[] = "$f=?";
                $args[] = $body[$f];
            }
        }
        if (isset($body['title'])) {
            $t = clip(trim((string)$body['title']), 160);
            if ($t === '') {
                out(['error' => 'title may not be empty'], 400);
            }
            $sets[] = 'title=?';
            $args[] = $t;
        }
        if (array_key_exists('notes', $body)) {
            $sets[] = 'notes=?';
            $args[] = clip(trim((string)$body['notes']), 1000);
        }
        if (!$sets) {
            out(['error' => 'nothing to update'], 400);
        }
        $args[] = $id;
        $n = $pdo->prepare('UPDATE tasks SET ' . implode(',', $sets)
            . ", updated=datetime('now') WHERE id=?");
        $n->execute($args);
        if ($n->rowCount() === 0 &&
            !$pdo->query('SELECT 1 FROM tasks WHERE id=' . (int)$id)
                ->fetchColumn()) {
            out(['error' => 'no such task id'], 404);
        }
        out(['ok' => true, 'id' => $id]);
    }

    if ($action === 'task-delete') {
        $id = filter_var($body['id'] ?? null, FILTER_VALIDATE_INT);
        if ($id === false || $id === null) {
            out(['error' => 'need id (int)'], 400);
        }
        $n = $pdo->prepare('DELETE FROM tasks WHERE id=?');
        $n->execute([$id]);
        if ($n->rowCount() === 0) {
            out(['error' => 'no such task id'], 404);
        }
        out(['ok' => true, 'id' => $id]);
    }

    if ($action === 'log') {
        $msg = clip(trim((string)($body['message'] ?? '')), 500);
        if ($msg === '') {
            out(['error' => 'message required'], 400);
        }
        $pdo->prepare('INSERT INTO snap_log(message) VALUES (?)')
            ->execute([$msg]);
        out(['ok' => true, 'id' => (int)$pdo->lastInsertId()]);
    }

    out(['error' => 'unknown action'], 400);
}

if ($method !== 'GET') {
    out(['error' => 'method not allowed'], 405);
}

$snap = $pdo->query('SELECT id,taken_at,note FROM snapshots'
    . ' ORDER BY id DESC LIMIT 1')->fetch();
if (!$snap) {
    out(['error' => 'database has no snapshots — run: python3 tools/progress_scan.py'],
        503);
}

$metrics = $pdo->query(
    'SELECT section,key,label,num,den,unit,detail FROM metrics'
    . ' WHERE snapshot_id=' . (int)$snap['id']
    . ' ORDER BY section,key'
)->fetchAll();
$sections = [];
$prev = [];
foreach ($metrics as $r) {
    $sections[$r['section']][] = $r;
}

/* Previous snapshot's numbers for "since last scan" deltas. */
$prevSnap = $pdo->query('SELECT id FROM snapshots WHERE id<' . (int)$snap['id']
    . ' ORDER BY id DESC LIMIT 1')->fetch();
if ($prevSnap) {
    $rs = $pdo->query('SELECT section,key,num FROM metrics WHERE snapshot_id='
        . (int)$prevSnap['id'])->fetchAll();
    foreach ($rs as $r) {
        $prev[$r['section'] . '|' . $r['key']] = (int)$r['num'];
    }
}

/* Trend history: last HISTORY_N snapshots, sparse per metric. */
$histSnapIds = $pdo->query('SELECT id,taken_at FROM snapshots ORDER BY id DESC'
    . ' LIMIT ' . HISTORY_N)->fetchAll();
$history = [];
if ($histSnapIds) {
    $ids = array_column($histSnapIds, 'id');
    $in = implode(',', array_map('intval', $ids));
    $ts = [];
    foreach ($histSnapIds as $s) {
        $ts[(int)$s['id']] = $s['taken_at'];
    }
    $rs = $pdo->query('SELECT snapshot_id,section,key,num,den FROM metrics'
        . " WHERE snapshot_id IN ($in)")->fetchAll();
    foreach ($rs as $r) {
        $history[$r['section'] . '|' . $r['key']][] = [
            'ts' => $ts[(int)$r['snapshot_id']],
            'num' => (int)$r['num'],
            'den' => $r['den'] === null ? null : (int)$r['den'],
        ];
    }
    foreach ($history as &$pts) {
        usort($pts, fn($a, $b) => strcmp($a['ts'], $b['ts']));
    }
    unset($pts);
}

$coverage = $pdo->query('SELECT bundle,downloaded,indexed,unpacked,packs,season'
    . ' FROM coverage ORDER BY season DESC,bundle')->fetchAll();
$tasks = $pdo->query('SELECT id,title,kind,status,source,notes,ord FROM tasks'
    . ' ORDER BY ord,id')->fetchAll();
$log = $pdo->query('SELECT id,ts,message FROM snap_log ORDER BY id DESC'
    . ' LIMIT 50')->fetchAll();

out([
    'snapshot' => $snap,
    'sections' => $sections,
    'prev' => $prev,
    'history' => $history,
    'coverage' => $coverage,
    'tasks' => $tasks,
    'log' => $log,
    'statuses' => STATUSES,
    'kinds' => KINDS,
]);
