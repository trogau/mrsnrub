// Behaviour smoke for web/viewer/walk-lab.html (notes/13 §8, 2026-11-04).
// Runs the page's script with a stubbed DOM/fetch/Image and a synthetic alpha
// channel, so the direction rule, candidate availability, the lean arithmetic,
// the origin geometry and the paste-back report are checked without a browser.
//
//   node tools/smoke-walk-lab.cjs          fixtures (always runnable)
//   node tools/smoke-walk-lab.cjs --live   ALSO replay the real card JSON,
//                                          the real .bcell pool through
//                                          web/api/bcell.php, and the real
//                                          card PNG dimensions (skips with a
//                                          note when those artifacts are
//                                          not on disk)
// Usage: node tools/smoke-walk-lab.cjs [--live] [--report]
//   --report also dumps the paste-back report text the page produced, for
//   reading the four direction rows without a browser.
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const LIVE = process.argv.includes('--live');
const REPORT = process.argv.includes('--report');   /* also dump the report text */
const POOL_DIR = '/tmp/opencode/citypool';

const HTML = fs.readFileSync(
    path.join(ROOT, 'web/viewer/walk-lab.html'), 'utf8');
const SCRIPT = HTML.match(/<script>([\s\S]*?)<\/script>/);
if (!SCRIPT) { console.error('no inline <script> found'); process.exit(1); }

let checks = 0, failed = 0;
function check(ok, label) {
    checks++;
    if (ok) console.log('ok   ' + label);
    else { failed++; console.log('FAIL ' + label); }
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const findIn = (n, pred) => {
    if (pred(n)) return n;
    for (const c of n.children || []) { const r = findIn(c, pred); if (r) return r; }
    return null;
};
const findAll = (n, pred, out) => {
    out = out || [];
    if (pred(n)) out.push(n);
    (n.children || []).forEach(c => findAll(c, pred, out));
    return out;
};
/* every <a> in a subtree, as { text, href } */
const anchors = n => {
    const out = [];
    (function walk(x) {
        if (x.tag === 'a') out.push({ text: x.textContent, href: x.attrs.href });
        (x.children || []).forEach(walk);
    })(n);
    return out;
};
const hasLink = (n, href) => anchors(n).some(a => a.href === href);
/* the tile radios live in a <label>; a link inside it would toggle the radio
   when clicked, so no anchor may ever be a descendant of a label */
const linksInsideLabels = n => {
    let bad = 0;
    (function walk(x, inLabel) {
        const isLabel = x.tag === 'label';
        if (inLabel && x.tag === 'a') bad++;
        (x.children || []).forEach(c => walk(c, inLabel || isLabel));
    })(n, false);
    return bad;
};
const pngDims = buf => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });

/* alpha window: columns 40..60 are opaque, so the measured bbox midpoint is
   50 and every lean is 50 + x_off — the harness controls x_off and therefore
   predicts the number the page must print */
const OPAQUE = [40, 60];
const predictedLean = xOff => (OPAQUE[0] + OPAQUE[1]) / 2 + xOff;

/* ------------------------------------------------------------------ stubs */

function boot(fetchImpl) {
    const ALL_DRAWS = [];
    const sheetDims = {};                  /* name -> {w,h} from its manifest */

    function mkEl(tag) {
        const e = {
            tag, children: [], style: {}, attrs: {}, _text: '', className: '',
            isConnected: true, width: 0, height: 0, value: '', checked: false,
            type: '', placeholder: '', title: '', _html: '',
            set innerHTML(v) { this._html = v; if (v === '') this.children = []; },
            get innerHTML() { return this._html; },
            appendChild(c) { this.children.push(c); return c; },
            addEventListener(ev, fn) { (this._ev = this._ev || {})[ev] = fn; },
            setAttribute(k, v) { this.attrs[k] = v; },
            getAttribute(k) { return this.attrs[k]; },
            set textContent(v) { this._text = v; if (v === '') this.children = []; },
            get textContent() {
                if (this._text) return this._text;
                if (!this.children.length) return '';
                return this.children.map(c => c.textContent || '').join('');
            },
            get options() { return this.children; },
            querySelector(sel) {
                const m = /^option\[value="(.*)"\]$/.exec(sel);
                if (!m) return null;
                return this.children.find(c => c.value === m[1]) || null;
            },
            select() {},
            getContext() {
                return this._ctx = this._ctx || {
                    imageSmoothingEnabled: true, clears: 0, _cur: null,
                    clearRect() { this.clears++; },
                    drawImage(img, sx, sy, sw, sh, dx, dy) {
                        ALL_DRAWS.push({ tag: e.tag, dx, dy, sw, sh,
                            mir: !!(this._cur && this._cur.sx === -1) });
                    },
                    /* the transform is recorded, not ignored: whether the
                       stage actually asked for the mirrored draw is the half
                       of the ruling no report line can prove */
                    save() { this._cur = null; },
                    restore() { this._cur = null; },
                    translate(x, y) { (this._cur = this._cur || {}).tx = x; },
                    scale(x, y) {
                        (this._cur = this._cur || {}).sx = x;
                        if (x === -1) e._mirrored = true;
                    },
                    getImageData(x, y, w, h) {
                        const d = new Uint8ClampedArray(w * h * 4);
                        for (let px = 0; px < w; px++) {
                            const on = px >= OPAQUE[0] && px <= OPAQUE[1];
                            for (let py = 0; py < h; py++) {
                                d[((py * w) + px) * 4 + 3] = on ? 255 : 0;
                            }
                        }
                        return { data: d, width: w, height: h };
                    }
                };
            }
        };
        return e;
    }

    const ids = {};
    ['skin', 'cid', 'filter', 'group', 'sections', 'report', 'status',
     'load', 'reset', 'copy', 'link-anims', 'link-card', 'link-census']
        .forEach(id => { ids[id] = mkEl('div'); });
    ids.skin.value = 'homer';
    ids.cid.value = '3';

    class FakeImage {
        set src(v) {
            this._src = v;
            let d = null;
            const sh = /mode=sheet&src=pool&name=(.*)$/.exec(v);
            if (sh) d = sheetDims[decodeURIComponent(sh[1])];
            else {
                const f = path.join(ROOT, 'web/assets/characters',
                    decodeURIComponent(v.replace(/^.*\/assets\/characters\//, '')));
                if (fs.existsSync(f)) d = pngDims(fs.readFileSync(f));
            }
            this.width = d ? d.w : 100;
            this.height = d ? d.h : 210;
            setImmediate(() => this.onload && this.onload());
        }
        get src() { return this._src; }
    }

    const sandbox = {
        document: {
            createElement: mkEl,
            createTextNode: t => ({ tag: '#text', textContent: String(t) }),
            getElementById: id => ids[id] || (ids[id] = mkEl('div')),
            body: { contains: () => true },
            execCommand: () => true
        },
        Image: FakeImage,
        fetch: url => fetchImpl(url, sheetDims),
        URLSearchParams,
        location: { search: '' },
        navigator: {},
        console,
        setImmediate,
        requestAnimationFrame() { return 0; }     /* timing itself is not the point */
    };
    sandbox.window = sandbox;
    vm.runInNewContext(SCRIPT[1], sandbox, { filename: 'walk-lab.html' });
    return { ids, ALL_DRAWS };
}

async function settled(ids, needle) {
    for (let i = 0; i < 120 && ids.report.value.indexOf(needle) < 0; i++) {
        await wait(25);
    }
    return ids.report.value;
}

/* ---------------------------------------------------------------- fixtures */

const FRAME_W = 100, FRAME_H = 210;
const POOL = {
    homer: ['back_walk', 'front_walk'],
    homer_coolhomer: ['back_walk_right', 'front_walk_left', 'front_walk_right']
};
const XOFF = { front_walk: -50, back_walk: -30 };

function fxManifest(stem) {
    const fam = /front_walk/.test(stem) ? 'front_walk' : 'back_walk';
    return {
        name: stem, type: 'bcell11', sheet: { w: FRAME_W * 2, h: FRAME_H },
        images: [{ src: 'a.rgb', w: FRAME_W, h: FRAME_H, x: 0, y: 0 },
                 { src: 'b.rgb', w: FRAME_W, h: FRAME_H, x: FRAME_W, y: 0 }],
        frames: [{ i: 0, image: 0, delay_ms: 166.667, x_off: XOFF[fam], y_off: -FRAME_H },
                 { i: 1, image: 1, delay_ms: 166.667, x_off: XOFF[fam], y_off: -FRAME_H }],
        total_delay_ms: 333.334
    };
}
const fxCardCell = (stem, dir) => ({
    stem, role: '', dir, kind: 'walk', ms: 333.3, w: FRAME_W, h: FRAME_H,
    anchor: [50, 205],
    frames: [{ file: stem + '.png', delay: 166.6 },
             { file: stem + '_1.png', delay: 166.6 }]
});
const FIXTURE_CARD = {
    cid: '3', name: 'Homer',
    cells: [fxCardCell('homer_coolhomer_front_walk_left', 'left'),
            fxCardCell('homer_coolhomer_back_walk_left', 'left'),
            { stem: 'homer_idle', role: 'idle', dir: '', kind: 'idle', ms: 900,
              w: FRAME_W, h: FRAME_H, anchor: [50, 205],
              frames: [{ file: 'hi.png', delay: 450 }] }]
};

/* The pack census answer, in the shape web/api/bcell.php mode=census returns.
   Two of homer's four side cells are the truth (no pack ships them);
   homer_back_walk_left is a deliberate FICTION — the real census says no pack
   ships it either — invented here so the amber "shipped but never extracted"
   branch has a fixture, the way a real extraction gap would look. */
const CENSUS_META = { bundles: 505, packs: 22481, generated: '2026-11-04T00:00:00' };
const CENSUS_GAP = {
    homer_back_walk_left: { packs: 16, sample_pack: 'Krustyland2Game-100' }
};

function fxCensus(stem) {
    const gap = CENSUS_GAP[stem];
    if (gap) {
        return { name: stem, in_pool: false, shipped: true, packs: gap.packs,
                 sample_pack: gap.sample_pack,
                 verdict: 'shipped but never extracted', census: CENSUS_META };
    }
    const inPool = Object.keys(POOL).some(function (g) {
        return POOL[g].some(function (t) { return g + '_' + t === stem; });
    });
    if (inPool) {
        return { name: stem, in_pool: true, shipped: true, packs: 235,
                 sample_pack: 'AgnesSkinnerGame-100-r26843',
                 verdict: 'shipped and extracted', census: CENSUS_META };
    }
    return { name: stem, in_pool: false, shipped: false, packs: 0,
             sample_pack: null, verdict: 'not shipped by any pack',
             census: CENSUS_META };
}

function fixtureFetch(url) {
    let body = null;
    if (/families\/3\.json$/.test(url)) body = FIXTURE_CARD;
    else if (/mode=census&name=/.test(url)) {
        body = fxCensus(decodeURIComponent(/name=(.*)$/.exec(url)[1]));
    } else if (/mode=anims&src=pool&name=/.test(url)) {
        const name = decodeURIComponent(/name=(.*)$/.exec(url)[1]);
        body = POOL[name] ? { name, src: 'pool', cells: 15629,
                              anims: POOL[name].map(t => ({ tail: t,
                                                            stem: name + '_' + t })) }
                          : null;
    } else if (/mode=manifest&src=pool&name=/.test(url)) {
        body = fxManifest(decodeURIComponent(/name=(.*)$/.exec(url)[1]));
    }
    if (!body) return Promise.resolve({ ok: false, status: 404 });
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
}

/* -------------------------------------------------------------------- live */

function liveFetch(url, sheetDims) {
    let m;
    if ((m = /families\/([\w.\-]+)\.json$/.exec(url))) {
        const p = path.join(ROOT, 'web/assets/characters/families', m[1] + '.json');
        if (!fs.existsSync(p)) return Promise.resolve({ ok: false, status: 404 });
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        return Promise.resolve({ ok: true, json: () => Promise.resolve(j) });
    }
    if ((m = /mode=(anims|manifest|census)&src=pool&name=([^&]+)$/.exec(url)) ||
        (m = /mode=(census)&name=([^&]+)$/.exec(url))) {
        const mode = m[1], name = decodeURIComponent(m[2]);
        try {
            const out = cp.execFileSync(
                'php', [path.join(ROOT, 'web/api/bcell.php'), '--mode=' + mode,
                        '--src=pool', '--name=' + name],
                { encoding: 'utf8', maxBuffer: 1 << 26 });
            const j = JSON.parse(out);
            if (mode === 'manifest') sheetDims[name] = j.sheet;
            return Promise.resolve({ ok: true, json: () => Promise.resolve(j) });
        } catch (e) {
            return Promise.resolve({ ok: false, status: 404 });
        }
    }
    return Promise.resolve({ ok: false, status: 404 });
}
function liveAvailable() {
    return fs.existsSync(path.join(ROOT, 'web/assets/characters/families/3.json')) &&
           fs.existsSync(path.join(POOL_DIR, 'homer_front_walk.bcell'));
}

/* ------------------------------------------------------------- assertions */

function checkPage(label, ids, ALL_DRAWS, rep) {
    check(rep.length > 200, label + ': the page script ran and filled the report');
    const secs = ids.sections.children;
    check(secs.length === 4, label + ': four sections rendered, got ' + secs.length);
    const titles = secs.map(s => (s.children[0] && s.children[0].textContent) || '');
    ['walking north', 'walking east', 'walking south', 'walking west']
        .forEach(t => check(titles.some(x => x.indexOf(t) === 0),
                            label + ': section titled "' + t + '"'));
    const pickOf = t => new RegExp(
        '\\[' + t + '\\][\\s\\S]*?my pick\\s+: (\\S+)').exec(rep);
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const secOf = t => {
        const i = rep.indexOf('[' + t + ']');
        const j = rep.indexOf('[walking', i + 1);
        return i < 0 ? '' : rep.slice(i, j < 0 ? rep.length : j);
    };
    /* The four rulings the user made from this page on 2026-11-04, one per
       ENGINE step. In the 2:1 oblique a unit tile step draws as a 2:1
       diagonal, so "north" is up-LEFT and the rest follow the same reading —
       and each row is exactly the <MovePick> the shipped jobs carry. homer
       ships only the two plain cycles (notes/13 §8: a flat-authored crowd skin
       has no _left/_right art), so the plain cycle answers all four, MIRRORED
       on the two steps whose authored cell would face the other way. */
    const RULE = [
        ['walking north',  '(0,-1)', 'Back_Walk_Left',   'back',  'left',
         'homer_back_walk',  'homer_back_walk_left',     false],
        ['walking east',   '(+1,0)', 'Back_Walk_Right',  'back',  'right',
         'homer_back_walk',  'homer_back_walk_right',    true],
        ['walking south',  '(0,+1)', 'Front_Walk_Right', 'front', 'right',
         'homer_front_walk', 'homer_front_walk_right',   false],
        ['walking west',   '(-1,0)', 'Front_Walk_Left',  'front', 'left',
         'homer_front_walk', 'homer_front_walk_left',    true]
    ];
    RULE.forEach(function (r, idx) {
        const t = r[0], tile = r[1], ask = r[2], fam = r[3], side = r[4];
        const use = r[5], wanted = r[6], mir = r[7];
        const sec = secOf(t);
        const m = pickOf(t);
        check(m && m[1] === use,
              label + ': ' + t + ' plays ' + use + ' (got ' + (m || [])[1] + ')');
        const mk = /my pick\s+: \S+\s+mirror=(YES|no) \((rule|override)\)/.exec(sec);
        check(!!mk && mk[1] === (mir ? 'YES' : 'no') && mk[2] === 'rule',
              label + ': ' + t + ' is mirror=' + (mir ? 'YES' : 'no') +
              ' as the rule says (got ' + (mk || [])[1] + ' ' + (mk || [])[2] + ')');
        check(new RegExp('engine step\\s+: tile ' + esc(tile) +
              '  the shipped MovePick asks ' + esc(ask)).test(sec),
              label + ': ' + t + ' names the engine step (tile ' + tile +
              ', ' + ask + ')');
        check(new RegExp('screen vector\\s+: dx=\\S+ dy=\\S+  ->  family=' + fam +
              '  side=' + side + '  ->  mirror=' + (mir ? 'yes' : 'no') +
              ' \\(rule\\)').test(sec),
              label + ': ' + t + ' derives family ' + fam + ' and side ' + side +
              ' from the drawn vector');
        check(new RegExp('viewer plays\\s+: ' + esc(use) +
              '(?: MIRRORED)?   \\[rule wanted ' + esc(wanted) +
              ', not shipped -> plain cycle, ' + (mir ? 'mirrored' : 'as authored') +
              '\\]').test(sec),
              label + ': ' + t + ' says the authored ' + wanted + ' is missing and' +
              ' the plain cycle answers ' + (mir ? 'mirrored' : 'as authored'));
        check(new RegExp('source\\s+: \\.\\./api/bcell\\.php\\?mode=manifest' +
              '&src=pool&name=' + esc(use)).test(sec),
              label + ': ' + t + ' quotes the API URL of the cell it plays');
        /* the other half of the ruling: the stage must really ask for the
           flipped draw, since every line above is only text */
        const stg = findIn(secs[idx], n => n.className === 'stage');
        const cvn = stg && findIn(stg, n => n.tag === 'canvas');
        check(!!cvn && !!cvn._mirrored === mir,
              label + ': ' + t + ' ' + (mir ? 'draws its big stage mirrored'
                                            : 'draws its big stage as authored') +
              ' (canvas mirrored=' + !!(cvn && cvn._mirrored) + ')');
    });
    ['homer_front_walk_left', 'homer_front_walk_right',
     'homer_back_walk_left', 'homer_back_walk_right'].forEach(s =>
        check(new RegExp(s + '\\s+NOT SHIPPED').test(rep),
              label + ': ' + s + ' reported as not shipped'));
    /* the mirror belongs to the step, so it must never leak: the two rows the
       ruling leaves alone may not print MIRRORED, and the two it rules on must */
    RULE.forEach(function (r) {
        const plays = (/viewer plays\s+: (.*)/.exec(secOf(r[0])) || [])[1] || '';
        check(/\bMIRRORED\b/.test(plays) === r[7],
              label + ': ' + r[0] + ' ' + (r[7] ? 'is' : 'is not') +
              ' drawn mirrored (' + plays + ')');
    });
    check(/viewer rule: family = \(screen dy < 0 \? back : front\)/.test(rep),
          label + ': report states the rule it applied');
    check(/mirror = \(back && right\) \|\|[\s\S]*\(front && left\)/.test(rep),
          label + ': report states the mirror rule');
    check(/pool tails reported by api\/bcell\.php for "homer": back_walk, front_walk/
          .test(rep), label + ': availability came from the API');

    /* every cell is inspectable through the API: the packed sheet, its frame
       table, the per-frame PNGs, and the debug view */
    check(hasLink(secs[1], '../api/bcell.php?mode=sheet&src=pool&name=homer_back_walk'),
          label + ': east links the pool sheet PNG of the (mirrored) cell it plays');
    check(hasLink(secs[1], '../api/bcell.php?mode=manifest&src=pool&name=homer_back_walk'),
          label + ': east links the cell manifest (delays and offsets)');
    check(hasLink(secs[1], '../api/bcell.php?mode=frame&n=1&src=pool&name=homer_back_walk'),
          label + ': big stage links each frame as its own PNG');
    check(hasLink(secs[0], '../api/bcell.php?mode=sheet&src=pool&name=homer_back_walk&debug=1'),
          label + ': north links bcell.php?debug=1 for its cell');
    check(hasLink(secs[3], '../api/bcell.php?mode=sheet&src=pool&name=homer_front_walk_left&debug=1'),
          label + ': the unshipped left cell still links the API answer for it');
    check(/ pool\/homer_front_walk_left\.bcell/.test(JSON.stringify(secs[3])),
          label + ': the unshipped cell names the pool path it would live at');
    var inside = secs.reduce(function (n, s) { return n + linksInsideLabels(s); }, 0);
    check(inside === 0,
          label + ': no source link sits inside a tile label (would toggle the radio),' +
          ' found ' + inside);
    var tilesNode = findIn(secs[1], function (n) { return n.className === 'tiles'; });
    var tanchors = anchors(tilesNode).map(function (a) { return a.text; });
    check(tanchors.indexOf('f0') >= 0 && tanchors.indexOf('f1') < 0,
          label + ': tiles carry one frame link each, the full set only on the stage');
    /* the two inventory endpoints, for the group on show */
    check(ids['link-anims'].attrs.href ===
          '../api/bcell.php?mode=anims&src=pool&name=homer',
          label + ': the bar links the pool inventory for the stem group (' +
          ids['link-anims'].attrs.href + ')');
    check(ids['link-card'].attrs.href === '../assets/characters/families/3.json',
          label + ': the bar links the character card');
    /* ---- the pack census annotation (notes/13 §8) ------------------------
       The pool is a filtered extraction, so "not in pool" proves nothing; the
       census of every pack manifest in cdn/ does. Each absent cell must carry
       its verdict, already resolved at first paint, and the report line must
       say the same thing so a pasted report cannot be misread. */
    check(ids['link-census'].attrs.href ===
          '../api/bcell.php?mode=census&name=homer_front_walk',
          label + ': the bar links the pack census for the family (' +
          ids['link-census'].attrs.href + ')');
    const why = findAll(secs[3], n => n.className && /^why\b/.test(n.className));
    check(why.length === 4, label + ': each of the 4 absent cells carries a census' +
          ' phrase, got ' + why.length);
    check(why.every(n =>
          /\((absent from all \d+ pack manifests|shipped by \d+ pack\(s\))/.test(n.textContent)),
          label + ': every census phrase is a verdict, never a placeholder (' +
          why.map(n => n.textContent).join(' | ') + ')');
    check(!/census unavailable|checking/.test(why.map(n => n.textContent).join(' ')),
          label + ': the census is resolved before the first paint');
    check(/homer_front_walk_left\s+NOT SHIPPED\s+absent from all \d+ pack manifests/
          .test(rep),
          label + ': the report says WHY the left cell is missing');
    check(hasLink(secs[3], '../api/bcell.php?mode=census&name=homer_front_walk_left'),
          label + ': the absent cell links straight to its census answer');
    return secs;
}

(async () => {
    /* ---- fixtures ---- */
    const A = boot(fixtureFetch);
    const rep = await settled(A.ids, 'AVAILABLE WALK CELLS');
    const secs = checkPage('fixtures', A.ids, A.ALL_DRAWS, rep);
    if (REPORT) console.log('\n----- fixture report -----\n' + rep + '\n');

    check(/\bhomer_front_walk\s+2f\s+333ms\s+lean \+0\.0px\s+src=pool/.test(rep),
          'fixtures: square-on front cycle measures lean +0.0px from the sheet');
    check(/\bhomer_back_walk\s+2f\s+333ms\s+lean \+20\.0px\s+src=pool/.test(rep),
          'fixtures: profiled back cycle measures lean +20.0px');
    const dxy = A.ALL_DRAWS.map(d => d.dx + ',' + d.dy);
    check(dxy.includes('-50,-210') && dxy.includes('-30,-210'),
          'fixtures: frames hang off the character origin, not the canvas corner');

    const west = secs[3];
    const westRep = () => {
        const i = A.ids.report.value.indexOf('[walking west]');
        return A.ids.report.value.slice(i);
    };
    const mirrorBox = findIn(west, n => n.tag === 'input' && n.type === 'checkbox');
    check(!!mirrorBox, 'fixtures: west section has a mirror checkbox');
    if (mirrorBox) {
        /* the ruling mirrors west, so the box starts ticked; the box is an
           OVERRIDE, and clearing it must hand the choice back to the rule
           rather than pin west to whatever was ticked at the time */
        check(mirrorBox.checked === true,
              'fixtures: west starts ticked because the rule mirrors it');
        mirrorBox.checked = false;
        mirrorBox._ev.change();
        check(/mirror=no \(override\)/.test(westRep()),
              'fixtures: unchecking overrides the rule in the report');
        check(/viewer plays\s+: homer_front_walk\b(?!.*MIRRORED)/.test(westRep()),
              'fixtures: the override reaches the stage (no MIRRORED in the line)');
        mirrorBox.checked = true;
        mirrorBox._ev.change();
        check(/mirror=YES \(rule\)/.test(westRep()),
              'fixtures: ticking it back to the rule clears the override');
    }
    const noteBox = findIn(west, n => n.tag === 'input' && n.placeholder);
    check(!!noteBox, 'fixtures: west section has a note field');
    if (noteBox) {
        noteBox.value = 'mirrored front cycle reads as walking down-left';
        noteBox._ev.input();
        check(/note\s+: mirrored front cycle reads as walking down-left/
              .test(A.ids.report.value), 'fixtures: the note reaches the report');
    }

    /* the census gap case: a cell no pool .bcell holds but the packs do ship
       must be told apart from an authoring absence, in words and in colour */
    const gap = findIn(west, n => n.className === 'why gap');
    check(!!gap && /shipped by 16 pack\(s\), e\.g\. Krustyland2Game-100 — never extracted/
          .test(gap.textContent),
          'fixtures: a shipped-but-unextracted cell is flagged as OUR gap (' +
          (gap ? gap.textContent : 'none') + ')');
    check(/homer_back_walk_left\s+NOT SHIPPED\s+shipped by 16 pack\(s\)/
          .test(A.ids.report.value),
          'fixtures: the report carries the gap verdict too');
    const whyAll = findAll(west, n => n.className && /^why\b/.test(n.className));
    check(whyAll.filter(n => n.className === 'why gap').length === 1 &&
          whyAll.filter(n => n.className === 'why').length === 3,
          'fixtures: exactly one absence is our gap (amber), three are authoring' +
          ' facts (grey): ' + whyAll.map(n => n.className + '=' + n.textContent).join(' | '));

    const groups = A.ids.group.children.map(o => o.value);
    check(groups.indexOf('homer') >= 0, 'fixtures: group list has the bare stem');
    check(groups.indexOf('homer_coolhomer') >= 0,
          'fixtures: group list has the costume stem (' + groups.join(', ') + ')');
    check(groups.length === new Set(groups).size,
          'fixtures: reloading does not duplicate the group list');

    A.ids.group.value = 'homer_coolhomer';
    A.ids.group._ev.change.call(A.ids.group);     /* the handler reads this.value */
    const rep2 = await settled(A.ids, 'homer_coolhomer_back_walk_left');
    check(/stem-group=homer_coolhomer/.test(rep2), 'fixtures: switching group reloads');
    check(/homer_coolhomer_front_walk_left\s+2f[\s\S]{0,30}src=card\+pool/.test(rep2),
          'fixtures: cell in both sources is labelled card+pool');
    check(/homer_coolhomer_back_walk_left\s+2f[\s\S]{0,30}src=card(?![+])/.test(rep2),
          'fixtures: card-only cell still renders (pre-baked fallback)');
    check(/homer_coolhomer_front_walk\s+NOT SHIPPED/.test(rep2),
          'fixtures: costume group shows its plain cell as absent');
    /* a card-only cell has no pool .bcell, so it must link the card art and
       the card JSON rather than a sheet URL that would 404 */
    const coolSec = A.ids.sections.children[1];
    /* the OTHER half of the ruling: this skin ships its own side art, so tier
       1 answers and the mirror is switched off entirely — the engine never
       flips a cell authored for that side (notes/13 §8) */
    const eastRep = rep2.slice(rep2.indexOf('[walking east]'));
    check(/my pick\s+: homer_coolhomer_back_walk_right\s+mirror=no \(rule\)/
              .test(eastRep),
          'fixtures: a skin with authored side art plays it, unmirrored (' +
          (eastRep.match(/my pick\s+: .*/) || ['none'])[0] + ')');
    check(/viewer plays\s+: homer_coolhomer_back_walk_right\s+\[the cell the engine asks for, as authored\]/
          .test(eastRep),
          'fixtures: the east line says the authored cell is used as authored');
    check(hasLink(coolSec, '../assets/characters/families/3.json'),
          'fixtures: card-only cell links the character card');
    check(anchors(coolSec).some(a => /\/homer_coolhomer_back_walk_left\.png$/.test(a.href)),
          'fixtures: card-only cell links its pre-baked frame PNGs');
    check(!hasLink(coolSec,
          '../api/bcell.php?mode=sheet&src=pool&name=homer_coolhomer_back_walk_left'),
          'fixtures: card-only cell gets no pool sheet link');
    check(hasLink(coolSec,
          '../api/bcell.php?mode=sheet&src=pool&name=homer_coolhomer_back_walk_left&debug=1'),
          'fixtures: card-only cell still links the debug view (names the pool path)');

    /* ---- live: the real card, the real pool, the real PHP endpoint ---- */
    if (!LIVE) {
        console.log(failed ? '\nFAILURES: ' + failed
                           : '\nall good (' + checks + ' checks, --live skipped)');
        process.exit(failed ? 1 : 0);
    }
    if (!liveAvailable()) {
        console.log('\nnote: --live skipped, the generated card or the .bcell pool ' +
                    'is not on disk');
        process.exit(failed ? 1 : 0);
    }
    const B = boot(liveFetch);
    const rep3 = await settled(B.ids, 'AVAILABLE WALK CELLS');
    checkPage('live', B.ids, B.ALL_DRAWS, rep3);
    /* --report: the paste-back text itself, so the four rows can be read
       without opening a browser (the page is the same script either way) */
    if (REPORT) console.log('\n----- live report -----\n' + rep3 + '\n');

    /* the lean the page must print is derivable from the real manifest */
    const out = cp.execFileSync('php', [path.join(ROOT, 'web/api/bcell.php'),
        '--mode=manifest', '--src=pool', '--name=homer_front_walk'],
        { encoding: 'utf8', maxBuffer: 1 << 26 });
    const man = JSON.parse(out);
    const want = Math.max.apply(null, man.frames.map(f =>
        Math.abs(predictedLean(f.x_off)))).toFixed(1);
    check(new RegExp('homer_front_walk\\s+' + man.frames.length + 'f\\s+\\d+ms\\s+lean ' +
          (want == '0.0' ? '[+-]' : '[-+]') + want + 'px\\s+src=pool').test(rep3),
          'live: front cycle lean matches the real manifest offsets (±' + want + 'px)');
    check(/homer_front_walk_left\s+NOT SHIPPED/.test(rep3),
          'live: the crowd skin really has no left-facing walk cell');
    check(/stem-group=homer\b/.test(rep3), 'live: the bare stem group is the default');
    const glist = B.ids.group.children.map(o => o.value);
    check(glist.length > 10, 'live: Homer\'s costume stems are listed (' +
          glist.length + ' groups)');

    console.log(failed ? '\nFAILURES: ' + failed : '\nall good (' + checks + ' checks)');
    process.exit(failed ? 1 : 0);
})();
