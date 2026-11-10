// Runtime harness for the city-view ambient sound layer. Extracts the viewer's
// ambient section (marker → blockAtTile), evals it against stubs (fake AudioMixer
// players, fake CAM, fetch serving the real sidecar), and drives it through the
// __CV_AMBIENT('scan') path: radius gating, AMB_MAX keep/kill, kit pitch/volume,
// zone crossfade on camera moves, and the muted early-return.
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', 'web');

const src = fs.readFileSync(path.join(ROOT, 'viewer/city-view-pixi.js'), 'utf8');
const a = src.indexOf('/* ── ambient sound');
const b = src.indexOf('function blockAtTile(tx, ty) {', a);
if (a < 0 || b < 0) throw new Error('section not found');
const section = src.slice(a, b);

const sidecar = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/city/ambient-sounds.json'), 'utf8'));
const made = [];
function FakePlayer(url) {
    this.url = url; this.loop = false; this.vol = 1; this.rate = 1; this.disposed = false;
    made.push(this);
}
FakePlayer.prototype.prepare = function (cb) { cb(true); };
FakePlayer.prototype.play = function () { this.playing = true; };
FakePlayer.prototype.setLoop = function (v) { this.loop = v; };
FakePlayer.prototype.setVolume = function (v) { this.vol = v; };
FakePlayer.prototype.setRate = function (v) { this.rate = v; };
FakePlayer.prototype.dispose = function () { this.disposed = true; };

const TILE = { hw: 32, hh: 16 };
const CAM = {
    worldToTile: function (wx, wy) {
        return { x: wx / (2 * TILE.hw) + wy / (2 * TILE.hh),
                 y: wy / (2 * TILE.hh) - wx / (2 * TILE.hw) };
    }
};
function tileToWorld(x, y) { return { x: (x - y) * TILE.hw, y: (x + y) * TILE.hh }; }

function mkBlock(id, tx, ty) {
    return { id: id, mi: id, x0: tx, y0: ty, x1: tx + 1, y1: ty + 1,
             cat: 'x', hkey: 'h' + id };
}
const buildings = [mkBlock(2210, 100, 200), mkBlock(1199, 101, 200), mkBlock(1024, 400, 400)];

const timers = [];
const cam = { x: 0, y: 0 };
const syncp = function (v) { return { then: function (f) { return syncp(f(v)); }, catch: function () { return this; } }; };
const stubs = {
    B: '../', window: { AudioMixer: {
        makePlayer: function (u) { return new FakePlayer(u); },
        resume: function () {} } },
    CAM: CAM, cam: cam,
    objHidden: {}, hiddenObjs: {},
    buildings: buildings,
    document: { addEventListener: function () {} },
    fetch: function (u) {
        return u.indexOf('ambient-sounds.json') >= 0
            ? syncp({ ok: true, json: function () { return sidecar; } })
            : syncp({ ok: false });
    },
    setInterval: function () { return 1; }, clearInterval: function () {},
    setTimeout: function (fn) { timers.push(fn); return timers.length; },
    clearTimeout: function () {},
    Math: Math, JSON: JSON, Date: Date, console: console
};
const names = Object.keys(stubs);
const body = "'use strict';\nvar soundOn=true;" + section +
    "\nreturn { scan: ambScan, setSound: function (v) { soundOn = v; }, zone: function(){return ambZone;}, objs: function(){return ambObj;}, doc: function(){return ambientDoc;} };";
const api = new Function(names.join(','), body).apply(null, names.map(n => stubs[n]));
if (!api.doc()) throw new Error('sidecar fetch did not land in the sandbox');
const scan = function () { stubs.window.__CV_AMBIENT('scan'); };
scan();   // the harness op doubles as the gesture unlock

let fail = 0;
function check(label, cond, extra) {
    console.log((cond ? '  ok  ' : '  FAIL ') + label + (!cond && extra ? ' — ' + extra : ''));
    if (!cond) fail++;
}

// 1. camera at the Ferris Wheel
let w = tileToWorld(100.5, 200.5);
cam.x = w.x; cam.y = w.y;
scan();
let act = Object.keys(api.objs());
let zone = api.zone();
console.log('at wheel:', act.join(' '), '| zone:', zone && zone.name);
check('wheel + fountain loop, distant tireyard silent',
      act.some(k => k.startsWith('2210#')) && act.some(k => k.startsWith('1199#')) &&
      !act.some(k => k.startsWith('1024#')), act.join(' '));
const live = made.filter(p => !p.disposed && p.loop && /ferris|waterfountain/.test(p.url));
check('loop players are looping with kit pitch/volume',
      live.some(p => /ferris/.test(p.url) && p.rate === 0.8) &&
      live.every(p => p.vol > 0 && p.vol <= 1), JSON.stringify(live.map(p => [p.url, p.rate, p.vol])));
check('centre bed is the krustyland loop (tile sits in that region)',
      zone && zone.name === 'Krustyland/Krustyland' && /krustyland/.test(zone.pl.url),
      zone && zone.name + ' ' + zone.pl.url);

// 2. camera off the west edge -> Ocean zone bed, cross-faded out old
w = tileToWorld(-20, 300);
cam.x = w.x; cam.y = w.y;
scan();
zone = api.zone();
console.log('offshore: zone:', zone && zone.name);
check('ocean bed takes over with a fade',
      zone && zone.name === 'Springfield/Ocean' && /beach_pier/.test(zone.pl.url) &&
      zone.pl.loop === true, zone && zone.name + ' ' + zone.pl.url);

// 3. centre again (tile outside the Krustyland rect)
w = tileToWorld(600, 600);
cam.x = w.x; cam.y = w.y;
scan();
zone = api.zone();
check('centre bed returns', zone && zone.name === 'Springfield/Springfield' &&
      /green_area/.test(zone.pl.url), zone && zone.name);

// 4. mute: no new players on scan while muted
api.setSound(false);
w = tileToWorld(100.5, 200.5);        // back at the wheel: would spawn if unmuted
cam.x = w.x; cam.y = w.y;
const n = made.length;
scan();
check('scan is quiet when muted', made.length === n, made.length + ' vs ' + n);
api.setSound(true);

console.log(fail ? 'FAILURES' : 'all good');
process.exit(fail ? 1 : 0);
