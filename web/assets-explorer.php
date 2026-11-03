<?php
/* assets-explorer.php — Asset Explorer page.

   Replaces the former static assets-explorer.html: the manifest grew to
   ~3.5M entries (~2.2 GB of parts), so instead of loading all of it in the
   browser this PHP page renders its header counts straight from the SQLite
   index (web/api/assets.sqlite, built by tools/build_assets_db.php) and
   inlines only the few hundred core (non-DLC) entries the game's own
   modules still need (assets.js builds its image/origin index from
   window.MANIFEST for the Motion tab). All browsing, paging, search,
   variant switching, string tables and data-file text go to
   api/assets.php, which queries the database — search words are matched
   there too (path, origin, family, resClass, kind + the decoded strings).

   Needs the PHP server (same as api/progress.php) and a built database:
     php tools/build_assets_db.php                                */
declare(strict_types=1);

require __DIR__ . '/api/assets-db.php';

$ready = is_file(assets_db_path());
$counts = [];
$total = 0;
$coreJson = '[]';
$buildCmd = 'php tools/build_assets_db.php';

if ($ready) {
    try {
        $pdo = assets_db();
        foreach ($pdo->query('SELECT cat, COUNT(*) n FROM assets GROUP BY cat') as $r) {
            $counts[$r['cat']] = (int)$r['n'];
            $total += (int)$r['n'];
        }
        // core (APK) entries: everything not decoded from a CDN DLC pack —
        // a few hundred rows, inlined so assets.js / the Motion tab work
        $st = $pdo->prepare(assets_entry_sel() . " WHERE a.path NOT LIKE 'dlc/%' ORDER BY a.id");
        $st->execute();
        $core = array_map('assets_entry', $st->fetchAll());
        $coreJson = json_encode(
            ['files' => $core, 'source' => 'core (inlined by assets-explorer.php)'],
            JSON_UNESCAPED_SLASHES);
    } catch (Throwable $e) {
        $ready = false;
    }
}

// header counts line, same shape the old page built client-side
$countsLine = $total ? ($total . ' assets · ' . ($counts['image'] ?? 0) . ' images · ' .
    ($counts['audio'] ?? 0) . ' sounds' .
    (($counts['video'] ?? 0) ? ' · ' . $counts['video'] . ' movies' : '') .
    ' · ' . ($counts['font'] ?? 0) . ' fonts · ' .
    ($counts['i18n'] ?? 0) . ' string tables · ' .
    ($counts['android'] ?? 0) . ' android icons' .
    (($counts['dlc'] ?? 0) ? ' · ' . $counts['dlc'] . ' dlc' : '')) : '';
?><!doctype html>
<!-- Asset explorer: browse every asset extracted from the APK (and every
     decoded CDN DLC pack) through the SQLite-backed PHP API. -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Springfield — Asset Explorer</title>
<link rel="icon" type="image/png" href="assets/images/icon.png">
<link rel="stylesheet" href="css/explorer.css">
</head>
<body>
<header>
  <a class="brand" href="original.html">&#8592; Springfield</a>
  <h1>Asset Explorer</h1>
  <a class="brand" href="progress.html">Progress &rarr;</a>
  <span class="sub" id="counts"><?= htmlspecialchars($countsLine) ?></span>
  <input id="search" type="search" placeholder="search name, family, origin…">
</header>
<?php if (!$ready): ?>
<main>
  <div class="placeholder" style="padding:2rem">
    <p><strong>The asset index is not available.</strong></p>
    <?php if ($_SERVER['REQUEST_METHOD'] ?? '') : ?>
    <p>Build it once from the extraction manifest:</p>
    <pre style="white-space:pre-wrap"><?= htmlspecialchars($buildCmd) ?></pre>
    <p>then reload this page. (Needs the PHP server, like the Progress
    dashboard; the raw manifest is ~2.2&nbsp;GB so it is indexed into
    <code>web/api/assets.sqlite</code> instead of being loaded here.)</p>
    <?php endif; ?>
  </div>
</main>
<?php else: ?>
<nav id="tabs"></nav>
<main>
  <div id="browser">
    <nav id="crumb"></nav>
    <section id="grid"></section>
  </div>
  <aside id="detail"><div class="placeholder">Select an asset on the left.</div></aside>
</main>
<?php endif; ?>
<footer>
  Academic port for study &mdash; The Simpsons: Tapped Out &copy; EA. All rights remain with their owners.
</footer>
<?php if ($ready): ?>
<script>window.MANIFEST = <?= $coreJson ?>;
window.EXPLORER_API = 'api/assets.php';</script>
<script src="assets/data/webdata.js"></script>
<script src="js/i18n.js"></script>
<script src="js/audio.js?v=2"></script>
<script src="js/assets.js"></script>
<script src="js/splashlayout.js"></script>
<script src="js/ui.js"></script>
<script src="js/scenes.js"></script>
<script src="js/explorer.js?v=9"></script>
<?php endif; ?>
</body>
</html>
