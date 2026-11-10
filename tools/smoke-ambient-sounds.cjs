// Static smoke for the ambient loops (tools/gen_ambient_sounds.py ->
// web/assets/city/ambient-sounds.json, streamed by web/viewer/city-view-pixi.js
// via AudioMixer). Headless Node, no browser:
//
//   node tools/smoke-ambient-sounds.cjs
//
// Asserts the sidecar is well formed, every layer it names exists on disk and
// is a browser-playable audio file, the kit parameters stay in the range the
// scripts actually ship, the CORE loops (ferris wheel, tireyard fire, the Duff
// Party Liner's periodic horn) resolve to the files the scripts name, and the
// land zones (ocean, mountains, centre, Krustyland) are all present with a
// real bed behind them. Everything here comes from the game's own table —
// <AmbientSound soundKit="…"/> and <AmbientSounds><Region> in the newest
// gamescripts pack — so the checks are file names, not guesses.
// Regenerate with: python3 tools/gen_ambient_sounds.py
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || path.join(__dirname, '..', 'web');
const A = path.join(ROOT, 'assets');
const SIDE = path.join(A, 'city', 'ambient-sounds.json');

let failures = 0;
function check(label, cond, extra) {
    if (cond) { console.log('  ok  ' + label); }
    else { failures++; console.log('  FAIL ' + label + (extra ? ' — ' + extra : '')); }
}

console.log('ambient-sounds sidecar:');
let doc;
try {
    doc = JSON.parse(fs.readFileSync(SIDE, 'utf8'));
    check('file parses', true);
} catch (e) {
    check('file parses', false, String(e && e.message));
    process.exit(1);
}
const objs = doc.objects || {};
const keys = Object.keys(objs);
const zones = doc.zones || [];
check('has a generated date', /^\d{4}-\d{2}-\d{2}$/.test(doc.generated || ''), doc.generated);
check('the scripts table was read',
      /^gamescripts-r\d+$/.test((doc.scripts || {}).pack || ''),
      JSON.stringify(doc.scripts || null));
check('objects mapped', keys.length >= 100, keys.length + ' objects');
check('zones mapped', zones.length >= 6, zones.length + ' zones');

console.log('objects:');
check('every key is "b:<id>"',
      keys.every((k) => /^b:\d+$/.test(k)),
      keys.filter((k) => !/^b:\d+$/.test(k)).slice(0, 5).join(','));
const allPaths = [];
let layers = 0;
keys.forEach((k) => {
    const v = objs[k];
    if (!Array.isArray(v) || !v.length) { check(k + ' has layers', false); return; }
    v.forEach((l, i) => {
        layers++;
        if (!l.kit) check(k + '#' + i + ' names its kit', false);
        if (!['LoopSingle', 'LoopSoundKit', 'PlayOnce'].includes(l.style)) {
            check(k + '#' + i + ' style is a shipped PlayStyle', false, l.style);
        }
        if (!(l.radius > 0 && l.radius <= 60)) {
            check(k + '#' + i + ' radius sane', false, String(l.radius));
        }
        if (!(l.volume > 0 && l.volume <= 1.5)) {
            check(k + '#' + i + ' volume sane', false, String(l.volume));
        }
        if (!(l.pitch >= 0.1 && l.pitch <= 3)) {
            check(k + '#' + i + ' pitch sane', false, String(l.pitch));
        }
        if (!Array.isArray(l.sounds) || !l.sounds.length) {
            check(k + '#' + i + ' has sounds', false);
            return;
        }
        l.sounds.forEach((p) => allPaths.push([k, p]));
    });
});
check('every referenced file exists on disk',
      allPaths.filter(([, p]) => !fs.existsSync(path.join(A, p))).length === 0,
      allPaths.filter(([, p]) => !fs.existsSync(path.join(A, p)))
          .map(([, p]) => p).slice(0, 8).join(','));
check('every referenced file is browser-playable (.m4a/.wav)',
      allPaths.every(([, p]) => /\.(m4a|wav)$/i.test(p)),
      allPaths.filter(([, p]) => !/\.(m4a|wav)$/i.test(p)).map(([, p]) => p).slice(0, 8).join(','));
const badBase = [...new Set(allPaths.map(([, p]) => p))]
    .filter((p) => /^(ui_|tapx_|general_button|mainmusic|tap_boost)/i.test(path.basename(p)));
check('no UI or menu sound filed as an ambient loop',
      badBase.length === 0, badBase.slice(0, 8).join(','));

console.log('core roster resolves (the loops the scripts name for the icons):');
function hasFile(k, re) {
    return (objs[k] || []).some((l) => (l.sounds || []).some((p) => re.test(path.basename(p))));
}
[['2210', 'FerrisWheel', /ferris_wheel/],
 ['1024', 'SpringfieldTireyard', /burning_tires/],
 ['901', 'PopsicleStickSkyscraper', /popsiclestick/],
 ['3702', 'Campfire', /campfire_med/],
 ['1180', 'Cauldron', /cauldron_bubble/],
 ['900', 'EscalatorToNowhere', /escalator/]]
    .forEach(([id, nm, re]) => {
        check('b:' + id + ' ' + nm + ' plays ' + re, hasFile('b:' + id, re),
              JSON.stringify(objs['b:' + id] || []));
    });
const liner = objs['b:20501'] || [];           // the periodic boat horn
check('DuffPartyLiner is a periodic kit with a post-delay',
      liner.length === 1 && liner[0].style === 'LoopSoundKit' &&
      liner[0].postdelay > 0 && liner[0].sounds.length >= 3,
      JSON.stringify(liner));

console.log('land zones:');
function zone(nm) { return zones.find((z) => z.name === nm) || null; }
function zoneHas(z, re) { return !!z && (z.sounds || []).some((p) => re.test(path.basename(p))); }
[['Springfield', /green_area/], ['Ocean', /beach_pier/], ['Mountains', /mountains/],
 ['SHMountains', /mountains/], ['SHOcean', /beach_pier/], ['SH', /green_area/]]
    .forEach(([nm, re]) => {
        check('Springfield zone ' + nm + ' has its bed', zoneHas(zone(nm), re),
              JSON.stringify(zone(nm) || null));
    });
const kl = zone('Krustyland');
check('Krustyland zone has its bed', zoneHas(kl, /krustyland_large/),
      JSON.stringify(kl || null));
zones.forEach((z) => {
    check('zone ' + z.land + '/' + z.name + ' rect is a rect',
          isFinite(z.x1) && isFinite(z.y1) && isFinite(z.x2) && isFinite(z.y2) &&
          z.x2 > z.x1 && z.y2 > z.y1 &&
          (z.sounds || []).length > 0 &&
          (z.sounds || []).every((p) => fs.existsSync(path.join(A, p))),
          JSON.stringify(z));
});
const sf = zones.filter((z) => z.land === 'Springfield');
check('the ocean bed reaches the west edge (x1 < 0)',
      sf.some((z) => /Ocean/.test(z.name) && z.x1 < 0 && z.x2 <= 0),
      sf.map((z) => z.name + ':' + z.x1 + '..' + z.x2).join(','));
check('the mountains bed sits north of the buildable square (y2 <= 0)',
      sf.some((z) => /Mountains/.test(z.name) && z.y2 <= 0),
      sf.map((z) => z.name + ':' + z.y1 + '..' + z.y2).join(','));

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nall good');
process.exit(failures ? 1 : 0);
