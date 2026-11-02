// Headless DOM test for the boot-screen asset explorer (M5.1b). Drives the
// real web/js/boot-explorer.js in Node with a minimal DOM against the real
// generated web/js/boot-explorer-data.js: renders every tab, filters by
// source side, searches, clicks representative tiles into the detail pane,
// and checks the slot grouping + provenance rows. Catches "only breaks in a
// browser" runtime errors.
//
//   node tools/smoke-boot-explorer-dom.cjs [web-dir]
'use strict';
const path = require('path');
const ROOT = process.argv[2] || path.join(__dirname, '..', 'web');

// ---- element stub (same shim family as tools/smoke-explorer-dom.cjs) --------
class FakeEl {
    constructor(tag) {
        this.tagName = String(tag || 'div').toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.style = {};
        this.dataset = {};
        this.className = '';
        this._text = '';
        this.value = '';
        this.listeners = {};
        this._html = '';
        const self = this;
        this.classList = {
            _set: new Set(),
            toggle(c, on) {
                if (on === undefined) { on = !self.classList._set.has(c); }
                if (on) { self.classList._set.add(c); } else { self.classList._set.delete(c); }
                return on;
            },
            add(c) { this._set.add(c); },
            contains(c) { return this._set.has(c); }
        };
    }
    get innerHTML() { return this._html; }
    set innerHTML(v) {
        this._html = v;
        if (v === '') { this.children = []; }
    }
    get textContent() { return this._text; }
    set textContent(v) {
        this._text = v;
        if (v === '') { this.children = []; }
    }
    appendChild(c) {
        if (c && c.isFragment) {
            const kids = c.children.slice();
            for (const k of kids) { this.appendChild(k); }
            return c;
        }
        c.parentNode = this;
        this.children.push(c);
        return c;
    }
    removeChild(c) {
        const i = this.children.indexOf(c);
        if (i >= 0) { this.children.splice(i, 1); }
        return c;
    }
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
    dispatch(ev, arg) {
        (this.listeners[ev] || []).slice().forEach((fn) => fn(arg || {}));
    }
    removeAttribute(n) { delete this[n]; }
    querySelector(sel) {
        const pred = sel.startsWith('.')
            ? (n) => n.className && n.className.split(/\s+/).indexOf(sel.slice(1)) >= 0
            : (n) => n.tagName === sel.toUpperCase();
        const walk = (n) => {
            for (const c of (n.children || [])) {
                if (pred(c)) { return c; }
                const r = walk(c);
                if (r) { return r; }
            }
            return null;
        };
        return walk(this);
    }
    descend(n) {
        const out = [n];
        for (const c of (n.children || [])) { out.push(...this.descend(c)); }
        return out;
    }
}

// ---- globals -------------------------------------------------------------------
global.window = global;
const named = {};
['grid', 'detail', 'tabs', 'search', 'counts', 'crumb', 'gen-stamp'].forEach((id) => {
    named[id] = new FakeEl(id === 'search' ? 'input' : 'div');
});
global.document = {
    readyState: 'complete',
    getElementById: (id) => named[id] || null,
    createElement: (tag) => new FakeEl(tag),
    createDocumentFragment: () => Object.assign(new FakeEl('#frag'), { isFragment: true }),
    createTextNode: (t) => ({ nodeType: 3, text: t }),
    body: new FakeEl('body'),
    addEventListener: () => {}
};

// ---- load the data + page --------------------------------------------------------
require(path.join(ROOT, 'js/boot-explorer-data.js'));
const D = global.BOOT_DATA;
if (!D || !D.files || !D.files.length) {
    console.log('FAIL: window.BOOT_DATA missing — run tools/gen_boot_explorer.py');
    process.exit(1);
}
require(path.join(ROOT, 'js/boot-explorer.js'));

// ---- drive ------------------------------------------------------------------------
let failures = 0;
function check(label, cond, extra) {
    if (cond) { console.log('  ok  ' + label); }
    else { failures++; console.log('  FAIL ' + label + (extra ? ' — ' + extra : '')); }
}
const tiles = () => named.grid.children.filter((t) =>
    (t.className || '').indexOf('tile bs-') === 0);
const headers = () => named.grid.children.filter((t) =>
    t.className === 'gridgroup');
const texts = (n) => n.descend(n).map((x) => String(x.textContent || '')).join('|');

console.log('layout:');
check('8 tabs rendered', named.tabs.children.length === 8,
      named.tabs.children.length);
check('counts line shows the full set',
      String(named.counts.textContent) === D.files.length + ' of ' +
      D.files.length + ' assets', named.counts.textContent);
check('gen stamp filled', String(named.genStamp = named['gen-stamp'].textContent)
      .indexOf(D.generated) >= 0, named['gen-stamp'].textContent);
check('grid has one tile per asset', tiles().length === D.files.length,
      tiles().length + '/' + D.files.length);
const slotKeys = [];
D.files.forEach((e) => {
    const k = e.tab + '|' + e.role + '|' + e.slot;
    if (!slotKeys.length || slotKeys[slotKeys.length - 1] !== k) { slotKeys.push(k); }
});
check('slot group headers match consecutive slots', headers().length === slotKeys.length,
      headers().length + '/' + slotKeys.length);
check('every tile carries its source tag',
      tiles().every((t) => t.descend(t).some((n) =>
          n.className === 'src-tag' &&
          ['APK', 'CDN', 'DLC'].indexOf(n.textContent) >= 0)));

console.log('tabs:');
const tab = (label) => named.tabs.children.find((b) =>
    b.descend(b).some((n) => String(n.textContent || n.text || '') === label));
const tabCount = (id) => D.files.filter((e) => e.tab === id).length;
[['Splash', 'splash'], ['DLC Splash', 'dlcsplash'], ['Loading', 'loading'],
 ['Error', 'error'],
 ['Menu extras', 'extras'], ['Audio', 'audio'], ['Anchors', 'data']].forEach(([label, id]) => {
    tab(label).dispatch('click');
    check(label + ' tab = ' + tabCount(id) + ' tiles',
          tiles().length === tabCount(id), tiles().length);
});
tab('All').dispatch('click');

console.log('source chips:');
const chip = (label) => named.crumb.children.find((b) => b.textContent === label);
chip('APK side').dispatch('click');
const nApk = D.files.filter((e) => e.group === 'apk').length;
check('APK chip = ' + nApk + ' tiles', tiles().length === nApk, tiles().length);
chip('CDN packs').dispatch('click');
const nCdn = D.files.filter((e) => e.group === 'cdn').length;
check('CDN chip = ' + nCdn + ' tiles', tiles().length === nCdn, tiles().length);
check('crumb names the source bundles',
      texts(named.crumb).indexOf('3_0_30.7z') >= 0);
chip('Both sides').dispatch('click');
check('Both sides restores the full grid', tiles().length === D.files.length);

console.log('dlc source buttons:');
tab('DLC Splash').dispatch('click');
const nDlcAll = D.files.filter((e) => e.tab === 'dlcsplash').length;
check('DLC Splash tab = ' + nDlcAll + ' tiles', tiles().length === nDlcAll,
      tiles().length);
chip('DLC splashes').dispatch('click');
const dlcNames = Array.from(new Set(D.files.filter((e) => e.group === 'dlc')
                                    .map((e) => e.dlc))).sort();
check('DLC chip keeps the ' + nDlcAll + ' splash tiles',
      tiles().length === nDlcAll, tiles().length);
const srcBtns = named.crumb.children.filter((b) =>
    (b.className || '').indexOf('srcbtn') >= 0);
check('one source button per DLC pack + All packs (' + dlcNames.length + ')',
      srcBtns.length === dlcNames.length + 1, srcBtns.length);
check('source row is labelled', texts(named.crumb).indexOf('DLC source') >= 0);
const target = srcBtns.find((b) => b.dataset.dlc === 'SplashAndBurn') ||
    srcBtns[1];
target.dispatch('click');
const nTarget = D.files.filter((e) => e.group === 'dlc' &&
                                      e.dlc === target.dataset.dlc).length;
check('source button filters by DLC name (' + target.dataset.dlc + ')',
      nTarget > 0 && tiles().length === nTarget &&
      tiles().every((t) => t.dataset.path.indexOf('dlc/') === 0),
      tiles().length + '/' + nTarget);
// the crumb repaints on click, so check the freshly rendered buttons
const activeSrc = named.crumb.children.filter((b) =>
    (b.className || '').indexOf('srcbtn') >= 0 &&
    (b.className || '').indexOf('on') >= 0);
check('active source button marked',
      activeSrc.length === 1 && activeSrc[0].dataset.dlc === target.dataset.dlc,
      activeSrc.map((b) => b.dataset.dlc).join(','));
named.crumb.children.filter((b) => (b.className || '').indexOf('srcbtn') >= 0)[0]
    .dispatch('click');   // All packs
check('All packs restores the DLC grid', tiles().length === nDlcAll,
      tiles().length);
check('every DLC tile tagged DLC',
      tiles().every((t) => t.descend(t).some((n) =>
          n.className === 'src-tag' && n.textContent === 'DLC')));
const dlcEntry = D.files.find((e) => e.group === 'dlc' && e.dlc === 'SplashAndBurn');
const dlcTile = named.grid.children.find((t) => t.dataset.path === dlcEntry.path);
dlcTile.dispatch('click');
check('DLC detail names the side, DLC source, pack + revision',
      texts(named.detail).indexOf('DLC pack (extracted CDN corpus)') >= 0 &&
      texts(named.detail).indexOf('SplashAndBurn') >= 0 &&
      texts(named.detail).indexOf(dlcEntry.pack) >= 0);
tab('All').dispatch('click');
chip('APK side').dispatch('click');
check('leaving the DLC chip clears the DLC source filter',
      tiles().length === D.files.filter((e) => e.group === 'apk').length,
      tiles().length);
chip('Both sides').dispatch('click');
tab('All').dispatch('click');

console.log('search:');
named.search.value = 'loading_donut';
named.search.dispatch('input');
const hits = tiles().map((t) => D.files.find((e) => e.path === t.dataset.path));
check('search "loading_donut" finds copies from both sides',
      hits.length >= 4 &&
      new Set(hits.map((e) => e.group)).size === 2,
      hits.length + ' hits');
check('counts reflects the filtered view',
      String(named.counts.textContent) === hits.length + ' of ' +
      D.files.length + ' assets', named.counts.textContent);
named.search.value = 'zzz-no-such-thing';
named.search.dispatch('input');
check('no-match shows the placeholder',
      named.grid.children.length === 1 &&
      named.grid.children[0].className === 'placeholder');
named.search.value = '';
named.search.dispatch('input');
check('clearing search restores the grid', tiles().length === D.files.length);

console.log('detail:');
const tileByPath = (p) => tiles().find((t) => t.dataset.path === p);
const cdnSplash = D.files.find((e) => e.group === 'cdn' && e.role === 'splash-strip');
tileByPath(cdnSplash.path).dispatch('click');
const dt = texts(named.detail);
check('splash detail names the bundle', dt.indexOf(cdnSplash.bundle) >= 0,
      cdnSplash.bundle);
check('splash detail names the pack + tier + revision',
      dt.indexOf(cdnSplash.pack) >= 0 && dt.indexOf(cdnSplash.tier) >= 0 &&
      dt.indexOf('r' + cdnSplash.revision) >= 0, cdnSplash.pack);
check('splash detail names the origin .rgb', dt.indexOf(cdnSplash.origin) >= 0,
      cdnSplash.origin);
check('image detail renders zoom bar + full-size img',
      !!named.detail.querySelector('.zoombar') &&
      named.detail.descend(named.detail).some((n) =>
          n.tagName === 'IMG' && String(n.src) === 'assets/' + cdnSplash.path));
check('selected tile highlighted',
      tileByPath(cdnSplash.path).className.indexOf('sel') >= 0);

const donut = D.files.find((e) => e.role === 'loading-donut');
const donutPeers = D.files.filter((e) => e.role === donut.role &&
                                        e.slot === donut.slot);
tileByPath(donut.path).dispatch('click');
const vrow = named.detail.querySelector('.vrow');
check('slot variant row lists all ' + donutPeers.length + ' copies',
      vrow && vrow.children.length === donutPeers.length,
      vrow ? vrow.children.length : 'none');
// vrow is sorted APK-first, so the last button is a CDN copy (≠ donut)
const otherBtn = vrow.children[vrow.children.length - 1];
otherBtn.dispatch('click');
const selTiles = tiles().filter((t) => (t.className || '').indexOf('sel') >= 0);
check('variant button moves selection to another copy of the slot',
      selTiles.length === 1 && selTiles[0].dataset.path !== donut.path &&
      donutPeers.some((e) => e.path === selTiles[0].dataset.path),
      selTiles.map((t) => t.dataset.path).join(','));

const wav = D.files.find((e) => e.type === 'audio');
tileByPath(wav.path).dispatch('click');
check('audio detail creates a player',
      named.detail.descend(named.detail).some((n) =>
          n.tagName === 'AUDIO' && String(n.src) === 'assets/' + wav.path));

const txt = D.files.find((e) => e.type === 'data');
tileByPath(txt.path).dispatch('click');
check('data detail previews the sidecar text',
      named.detail.descend(named.detail).some((n) =>
          n.className === 'data-text' &&
          String(n.textContent || '').length > 0));

console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
