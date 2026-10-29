// Headless DOM test for the progress dashboard (web/progress.html) and the
// task board page (tasks/index.php — rendered by PHP server-side; this test
// drives the client re-render path). Drives the real web/js/progress.js and
// tasks/js/tasks.js in Node with a minimal DOM and a
// fetch stub fed by an API payload shaped exactly like api/progress.php
// output. Catches browser-only runtime errors (the class classList.add('')
// threw live) that node --check and the PHP-CLI smoke cannot: renders all
// meter states (zero / partial / full / no-den), sparklines, deltas,
// coverage chip states, task rows, then simulates the interactive paths —
// status-select change, task add, journal log — and asserts the POSTed
// bodies. classList is strict like the browser: empty tokens THROW.
// (2026-10-25: task board rendering moved out of progress.js into
// tasks/js/tasks.js; this test now runs both scripts against one DOM.)
//
//   node tools/smoke-progress-dom.cjs
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const FAILS = [];
function check(cond, msg) {
    if (cond) { console.log('  ok   ' + msg); }
    else { console.log('  FAIL ' + msg); FAILS.push(msg); }
}
process.on('unhandledRejection', (e) => {
    console.log('  FAIL unhandled rejection: ' + (e && e.stack || e));
    FAILS.push('unhandled:' + e);
});

// ---- strict minimal DOM ------------------------------------------------------
class FakeEl {
    constructor(tag) {
        this.tagName = String(tag || 'div').toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.style = {};
        this.dataset = {};
        this.textContent = '';
        this.value = '';
        this.selected = false;
        this.listeners = {};
        this._html = '';
        if (this.tagName === 'CANVAS') { this.width = 90; this.height = 16; }
        this._cls = new Set();
        const self = this;
        Object.defineProperty(this, 'className', {
            get() { return [...this._cls].join(' '); },
            set(v) {
                self._cls.clear();
                String(v || '').split(/\s+/).filter(Boolean)
                    .forEach(c => self._cls.add(c));
            }
        });
        // browser-strict: empty/whitespace tokens throw SyntaxError
        this.classList = {
            add(...cs) {
                for (const c of cs) {
                    if (!c || /\s/.test(c)) {
                        throw new Error(
                            'DOMTokenList.add: The empty string is not a valid token.');
                    }
                    self._cls.add(c);
                }
            },
            remove(...cs) { cs.forEach(c => self._cls.delete(c)); },
            toggle(c, on) {
                if (on === undefined) { on = !self._cls.has(c); }
                if (on) { self._cls.add(c); } else { self._cls.delete(c); }
                return on;
            },
            contains(c) { return self._cls.has(c); }
        };
    }
    get innerHTML() { return this._html; }
    set innerHTML(v) { this._html = v; if (v === '') { this.children = []; } }
    get options() { return this.children; }   // <select>
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
    setAttribute(k, v) { (this._attrs = this._attrs || {})[k] = String(v); }
    getAttribute(k) { return (this._attrs || {})[k]; }
    dispatch(ev, arg) {
        (this.listeners[ev] || []).slice().forEach(fn => fn(arg || {}));
    }
    getContext() {
        return {
            strokeStyle: '', lineWidth: 0,
            beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
        };
    }
    all(cls) {   // descendants with a class
        const out = [];
        (function walk(n) {
            for (const c of n.children) {
                if (c.classList.contains(cls)) { out.push(c); }
                walk(c);
            }
        })(this);
        return out;
    }
}
const byId = {};
function el(id) { return (byId[id] = byId[id] || new FakeEl('div')); }
global.document = {
    getElementById: (id) => el(id),
    createElement: (t) => new FakeEl(t),
    listeners: {},
    addEventListener(ev, fn) {
        (this.listeners[ev] = this.listeners[ev] || []).push(fn);
    },
    dispatch(ev, arg) {
        (this.listeners[ev] || []).slice().forEach(fn => fn(arg || {}));
    },
};
global.window = { confirm: () => true };

// ---- API payload (mirrors api/progress.php output) ----------------------------
const METRIC = (section, key, label, num, den, unit, detail) =>
    ({ section, key, label, num, den, unit: unit || '', detail: detail || '' });
const payload = {
    snapshot: { id: 7, taken_at: '2026-10-18 01:00:00', note: 'dom smoke' },
    sections: {
        cdn: [
            METRIC('cdn', 'bundles.downloaded', 'archive.org bundles on disk', 510, 510),
            METRIC('cdn', 'packages.decoded', 'master-index packages decoded', 128, 4869),
            METRIC('cdn', 'bundles.unpacked', 'bundles unpacked to disk', 0, 510),
            METRIC('cdn', 'packs.distinct', 'decoded DLC packs', 146, null, 'packs',
                   '{"pack_dirs":217}'),
        ],
        formats: [METRIC('formats', 'files.decoded', 'CDN files: decoded', 3, 464)],
        assets: [METRIC('assets', 'assets.audio.pcm', 'audio playable', 0, 62,
                        'files', '{"note":"ADPCM"}')],
        map: [METRIC('map', 'map.buildings.resolved', 'save building ids resolved',
                     2299, 3440, 'ids')],
    },
    prev: {
        'cdn|bundles.downloaded': 508,   // up
        'cdn|packages.decoded': 128,     // flat
        'cdn|bundles.unpacked': 1,       // down
    },
    history: {
        'cdn|bundles.downloaded': [
            { ts: 'a', num: 508, den: 510 }, { ts: 'b', num: 510, den: 510 }],
        'cdn|packages.decoded': [
            { ts: 'a', num: 128, den: 4869 }, { ts: 'b', num: 128, den: 4869 }],
        'cdn|bundles.unpacked': [
            { ts: 'a', num: 1, den: 510 }, { ts: 'b', num: 0, den: 510 }],
        'cdn|packs.distinct': [
            { ts: 'a', num: 140 }, { ts: 'b', num: 146 }],
    },
    coverage: [
        { bundle: '3_0_30', downloaded: 1, indexed: 1, unpacked: 1, packs: 33, season: '3_0_30' },
        { bundle: '4_69_x', downloaded: 1, indexed: 0, unpacked: 0, packs: 0, season: '4_69' },
        { bundle: '9_9_y', downloaded: 0, indexed: 0, unpacked: 0, packs: 0, season: '' },
    ],
    tasks: [
        { id: 1, title: 'Index bundles', kind: 'task', status: 'todo', source: 'x', notes: 'n', ord: 0, milestone: '', updated: '2026-10-18 00:00:00' },
        { id: 2, title: 'Audio fix', kind: 'task', status: 'deferred', source: 'notes/03', notes: '', ord: 1, milestone: '', updated: '2026-10-29 00:00:00' },
        { id: 3, title: 'Download foo', kind: 'decision', status: 'pending-approval', source: 'notes/03', notes: '', ord: 2, milestone: '', updated: '2026-10-29 00:00:00' },
        { id: 4, title: 'Phase 1', kind: 'milestone', status: 'done', source: 'planning', notes: '', ord: 3, milestone: '', updated: '2026-10-29 00:00:00' },
    ],
    log: [{ id: 1, ts: '2026-10-18 00:00:00', message: 'hello' }],
    statuses: ['todo', 'doing', 'done', 'blocked', 'deferred', 'pending-approval'],
    kinds: ['task', 'milestone', 'decision'],
    milestones: ['M5 — Integration & game UI'],
};

// ---- fetch stub ---------------------------------------------------------------
const posts = [];
global.fetch = (url, opts) => {
    if (opts && opts.method === 'POST') {
        posts.push(JSON.parse(opts.body));
        return Promise.resolve({ json: () => Promise.resolve({ ok: true, id: 99 }) });
    }
    return Promise.resolve({ json: () => Promise.resolve(payload) });
};

const tick = () => new Promise(r => setTimeout(r, 5));

(async () => {
    const src = fs.readFileSync(path.join(ROOT, 'web/js/progress.js'), 'utf8');
    vm.runInThisContext(src, { filename: 'progress.js' });
    const tsrc = fs.readFileSync(path.join(ROOT, 'tasks/js/tasks.js'), 'utf8');
    vm.runInThisContext(tsrc, { filename: 'tasks.js' });
    for (let i = 0; i < 4; i++) { await tick(); }

    console.log('== render ==');
    check(el('error').textContent === '', 'no API/render error banner');
    check(/snapshot #7/.test(el('statsbar').textContent), 'statsbar shows snapshot');
    const cards = el('meters').children;
    check(cards.length === 4, 'four meter cards (' + cards.length + ')');
    const mapCard = cards.find(c => (c.children[0] &&
        /Map & city/.test(c.children[0].textContent)));
    check(!!mapCard, 'map & city card rendered');
    const byteLink = mapCard && mapCard.children[0].children.find(
        a => a.tagName === 'A' && a.href === 'pb-layout.html');
    check(!!byteLink, 'Map & city header links to the Byte Map page');
    const metrics = el('meters').all('metric');
    check(metrics.length === 7, 'all 7 meter rows rendered (' + metrics.length + ')');
    check(metrics.filter(m => m.classList.contains('full')).length === 1,
          'full meter classed');
    check(metrics.filter(m => m.classList.contains('zero')).length === 2,
          'zero meters classed');
    const deltas = el('meters').all('m-delta');
    check(deltas.length === 3 &&
          deltas.filter(d => d.classList.contains('up')).length === 1 &&
          deltas.filter(d => d.classList.contains('down')).length === 1 &&
          deltas.filter(d => d.classList.contains('flat')).length === 1,
          'delta chips up/down/flat');
    check(el('meters').all('m-spark').length === 4, 'sparklines for 4 metrics');
    check(el('meters').all('m-bar').length === 6, 'bars for the 6 den metrics only');
    check(metrics.every(m => (m.getAttribute('data-tip') || '').length > 0),
          'every meter carries a data-tip');
    const chips = el('coverage').all('chip');
    check(chips.length === 3, 'coverage chips (' + chips.length + ')');
    check(chips.some(c => c.classList.contains('st-cover')) &&
          chips.some(c => c.classList.contains('st-down')),
          'chip states covered/downloaded');
    check(el('tasks').all('task').length === 4, 'four task rows');
    check(/3 open · 4 total/.test(el('taskstats').textContent),
          'task stats bar counts open/total');
    check(el('loglist').children.length === 1, 'journal entry rendered');
    check(el('taskkind').options.length === 3, 'task kind select filled');

    console.log('== interactions ==');
    const sel = el('tasks').all('task')[0].children.find(c => c.tagName === 'SELECT');
    sel.value = 'doing';
    sel.dispatch('change');
    for (let i = 0; i < 3; i++) { await tick(); }
    check(posts.some(p => p.action === 'task-update' && p.status === 'doing'),
          'select change POSTs task-update');
    // board sorts decisions first, so row 0 is the pending-approval decision (id 3)
    const del = el('tasks').all('task')[0].children.find(c => c.classList.contains('t-del'));
    del.dispatch('click');
    await tick();
    check(posts.some(p => p.action === 'task-delete' && p.id === 3),
          'delete button POSTs task-delete');
    el('tasktitle').value = 'new thing';
    el('taskkind').value = 'milestone';
    el('taskform').dispatch('submit', { preventDefault() {} });
    await tick();
    check(posts.some(p => p.action === 'task-add' && p.title === 'new thing'
                        && p.kind === 'milestone'), 'task form POSTs task-add');
    el('logmsg').value = 'session note';
    el('logform').dispatch('submit', { preventDefault() {} });
    await tick();
    check(posts.some(p => p.action === 'log' && p.message === 'session note'),
          'journal form POSTs log');

    console.log('== detail modal ==');
    // board sorts decisions first, so row 0 is the pending-approval (id 3),
    // which has empty notes → flagged for the plain-language detail
    const mrow = el('tasks').all('task')[0];
    check(mrow.classList.contains('no-detail'),
          'row without a detail is flagged no-detail');
    mrow.dispatch('click');
    check(el('tmodal').classList.contains('open'), 'row click opens the modal');
    const ta = el('tmodal').children[0].children.find(
        c => c.tagName === 'TEXTAREA');
    check(!!ta, 'modal carries a notes textarea');
    ta.value = 'What: index the rest. Why: coverage. Outcome: all indexed.';
    const save = el('tmodal').all('tm-save')[0];
    save.dispatch('click');
    await tick();
    check(posts.some(p => p.action === 'task-update' && p.id === 3
                       && /^What: index/.test(p.notes || '')),
          'Save detail POSTs task-update notes');
    check(!el('tmodal').classList.contains('open'), 'save closes the modal');
    mrow.dispatch('click');
    check(el('tmodal').classList.contains('open'), 'modal reopens on click');
    global.document.dispatch('keydown', { key: 'Escape' });
    check(!el('tmodal').classList.contains('open'), 'Esc closes the modal');
    mrow.dispatch('click');
    el('tmodal').dispatch('click', { target: el('tmodal') });
    check(!el('tmodal').classList.contains('open'), 'backdrop click closes');

    check(el('error').textContent === '', 'still no render error after interaction');

    console.log();
    if (FAILS.length) { console.log(FAILS.length + ' FAILURE(S)'); process.exit(1); }
    console.log('all progress-dom smoke checks passed');
})();
