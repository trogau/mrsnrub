// Static smoke for the click-to-play tap sounds (tools/gen_tap_sounds.py ->
// web/assets/characters/tap-sounds.json, played by web/viewer/city-view-pixi.js
// via AudioMixer). Headless Node, no browser:
//
//   node tools/smoke-tap-sounds.cjs
//
// Asserts the sidecar is well formed, every path it names exists on disk and
// is a browser-playable audio file, the CORE roster and a few buildings resolve
// to at least one line, and the attribution guards hold. Two sources feed the
// sidecar and they are checked differently: the game's own scripts table
// (<Sound event="BuildingTouched"> / its SoundKits in the newest gamescripts
// pack) names lines outright — those are trusted and named in the checks below
// — and the *_tap* stem heuristic only speaks for entities the table is silent
// about, so the guard against the shared "DatabaseAudio"/"MaggieAudio" packs
// leaking files still applies to what it produces.
// Regenerate with: python3 tools/gen_tap_sounds.py
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || path.join(__dirname, '..', 'web');
const A = path.join(ROOT, 'assets');
const SIDE = path.join(A, 'characters', 'tap-sounds.json');

let failures = 0;
function check(label, cond, extra) {
    if (cond) { console.log('  ok  ' + label); }
    else { failures++; console.log('  FAIL ' + label + (extra ? ' — ' + extra : '')); }
}

console.log('tap-sounds sidecar:');
let doc;
try {
    doc = JSON.parse(fs.readFileSync(SIDE, 'utf8'));
    check('file parses', true);
} catch (e) {
    check('file parses', false, String(e && e.message));
    process.exit(1);
}
const ents = doc.entities || {};
const keys = Object.keys(ents);
check('has a generated date', /^\d{4}-\d{2}-\d{2}$/.test(doc.generated || ''), doc.generated);
check('has entities', keys.length > 100, keys.length);
const charKeys = keys.filter((k) => k.startsWith('c:'));
const bldgKeys = keys.filter((k) => k.startsWith('b:'));
check('both characters and buildings mapped',
      charKeys.length > 300 && bldgKeys.length > 1000,
      charKeys.length + ' chars / ' + bldgKeys.length + ' buildings');
// the town's voice comes from the scripts table; say which copy was read
check('the scripts table was read',
      /^gamescripts-r\d+$/.test((doc.scripts || {}).pack || ''),
      JSON.stringify(doc.scripts || null));

console.log('keys:');
check('every key is "c:<id>" or "b:<id>"',
      keys.every((k) => /^[cb]:\d+$/.test(k)),
      keys.filter((k) => !/^[cb]:\d+$/.test(k)).slice(0, 5).join(','));
check('no empty entity lists',
      keys.every((k) => Array.isArray(ents[k]) && ents[k].length > 0),
      keys.filter((k) => !(ents[k] || []).length).slice(0, 5).join(','));

console.log('paths:');
const allPaths = [];
keys.forEach((k) => ents[k].forEach((p) => allPaths.push([k, p])));
const missing = allPaths.filter(([, p]) => !fs.existsSync(path.join(A, p))).map(([, p]) => p);
check('every referenced file exists on disk', missing.length === 0,
      missing.slice(0, 8).join(',') + (missing.length > 8 ? ' (+' + (missing.length - 8) + ')' : ''));
const badExt = [...new Set(allPaths.map(([, p]) => p))]
    .filter((p) => !/\.(m4a|wav)$/i.test(p));
check('every referenced file is browser-playable (.m4a/.wav)',
      badExt.length === 0, badExt.slice(0, 8).join(','));
const badBase = [...new Set(allPaths.map(([, p]) => p))]
    .filter((p) => /^(ui_|tapx_|general_button|mainmusic|tap_boost)/i.test(path.basename(p)));
check('no UI or menu sound filed as an entity line',
      badBase.length === 0, badBase.slice(0, 8).join(','));
// one path should never appear twice within one entity
keys.forEach((k) => {
    const s = new Set(ents[k]);
    if (s.size !== ents[k].length) check('no duplicate paths in ' + k, false, ents[k].join(','));
});

console.log('core roster resolves:');
function hasFile(k, re) { return (ents[k] || []).some((p) => re.test(path.basename(p))); }
[['1', 'Bart'], ['3', 'Homer'], ['5', 'Marge'], ['4', 'Lisa'], ['16', 'Wiggum'],
 ['19', 'Frink'], ['7', 'Burns'], ['14', 'Lovejoy'], ['61', 'DrederickTatum'],
 ['25', 'HansMoleman'], ['49', 'SideshowMel'], ['2400', 'SuperintendentChalmers'],
 ['22', 'Willy'], ['11', 'CBGuy'], ['15', 'Grampa']].forEach(([id, nm]) => {
    check('character ' + nm + ' (c:' + id + ') has a line', (ents['c:' + id] || []).length > 0);
});
['87', '55', '61', '86', '9002', '34000'].forEach((id) => {
    check('building #' + id + ' has a line', (ents['b:' + id] || []).length > 0,
          'b:' + id + ' -> ' + JSON.stringify(ents['b:' + id] || []));
});
// the buildings the scripts name by file rather than by *_tap* stem: these are
// the ones the stem heuristic could never reach, so they are the regression
// this table exists for.
[['1', 'SimpsonHome', /simpson_house/], ['2', 'PowerPlant', /nuclear_plant/],
 ['3', 'Kwik-E-Mart', /kwik_e_mart/], ['9', 'FlandersHome', /flanders_home/]]
    .forEach(([id, nm, re]) => {
        check('building ' + nm + ' (b:' + id + ') plays its own line',
              hasFile('b:' + id, re), JSON.stringify(ents['b:' + id] || []));
    });
// irregular stems must land on the right person
check('Wiggum plays chief_wiggum, not the house',
      hasFile('c:16', /chief_wiggum_tap/i) && !hasFile('c:16', /wiggum_house/i),
      JSON.stringify(ents['c:16'] || []));
check('Frink plays prof_frink', hasFile('c:19', /prof_frink_tap/i),
      JSON.stringify(ents['c:19'] || []));
check('Grampa plays abe lines', hasFile('c:15', /_abe_tap/i),
      JSON.stringify(ents['c:15'] || []));

console.log('attribution guards (shared/placeholder packs):');
// "Database" is a placeholder character that rode in a shared DatabaseAudio
// pack alongside unrelated building taps — it must own only its own lines.
const db = (ents['c:31000'] || []).map((p) => path.basename(p));
check('c:31000 Database owns only databasetap*',
      db.every((b) => /databasetap/i.test(b)), db.join(','));
// Rosa rode into MaggieAudio; the heuristic must not file it on Maggie, and
// Rosa (c:135006) must own the rosa line instead. Maggie's own lines are what
// her scripts declare — five pacifier sucks plus her MAGGIE voice line — so the
// guard is that everything she owns says "maggie".
const maggie = (ents['c:135000'] || []).map((p) => path.basename(p));
check('c:135000 Maggie owns only maggie lines',
      maggie.length > 0 && maggie.every((b) => /maggie/i.test(b)), maggie.join(','));
check('Rosa (c:135006) owns the rosa line',
      hasFile('c:135006', /rosa_tap/i), JSON.stringify(ents['c:135006'] || []));
// a building must not be filed as a character (keys are disjoint by prefix;
// sanity-check no b: id equals a c: id by accident of a bad prefix)
check('entity keys are unique', new Set(keys).size === keys.length);

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nall good');
process.exit(failures ? 1 : 0);
