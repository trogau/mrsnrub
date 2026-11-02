// Headless check of the Pixi viewer's global animation speed control
// (web/viewer/, 2026-11-03).
//
// Why it exists: nothing in the art says how fast a bsv3 loop plays. The frame
// records carry no delay, none of the city pool's 3 634 building XMLs has an
// fps/delay/duration attribute, and the binary's SequenceController just adds 1
// to a counter with no clock read (notes/01 §"bsv3 playback rate — still
// unmeasured"). So tools/gen_city_sprites.py stamps ONE empirical 12 fps on all
// 5 359 strips and the viewer scales that single number with this control.
//
// Four layers:
//  1. PAGE — the button ships next to Anim, carries data-tip (never title), and
//     the page loads a viewer JS that actually has the control (cache buster).
//  2. WIRING — the rate multiplies a SCALED CLOCK, not each strip's fps: every
//     building frame-selection site reads animClock (idle loops, toggle loops,
//     tap/in-out one-shots and their t0), while the things that must stay on
//     real time do — the character idle loops (their .bcell art ships a real
//     per-frame delay_ms), the decode retries, and the card filmstrip players
//     with their own per-tile cycler. The deprecated Canvas page stays put.
//  3. BEHAVIOUR — the ladder, the label and the boot precedence are sliced out
//     of the viewer VERBATIM (no copy of the rule lives here) and run against
//     stub storage: steps, wraps at both ends, shift+click, an off-ladder
//     ?animSpeed= rejoining at the shipped rate, the clamp, and the save. The
//     shipped default is pinned at 2× (the eye calibration: the manifest's bare
//     12 fps read slow against the game), with 1× kept on the ladder as the
//     unmodified reference.
//  4. CLOCK MATH — the accumulation line and the tick mapping are run verbatim
//     too: a frame must advance in proportion to the rate, the first frame must
//     not jump, and a long real delta must not be swallowed.
//
//   node tools/smoke-anim-speed.cjs
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const W = path.join(root, 'web');

let failures = 0;
function check(name, cond, info) {
    if (cond) { console.log('  ok  ' + name); }
    else { failures++; console.log('FAIL  ' + name + (info !== undefined ? '  [' + info + ']' : '')); }
}
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const html = read('web/viewer/index.html');
const pv = read('web/viewer/city-view-pixi.js');
const legacy = read('web/js/city-view.js');
const strips = read('web/viewer/asset-variants-pixi.js');

/* slice a named function out of the viewer source, verbatim */
function fn(text, name, endMark) {
    const at = text.indexOf('function ' + name + '(');
    if (at < 0) return null;
    const end = endMark ? text.indexOf(endMark, at) : text.indexOf('\n    }', at);
    return end < 0 ? null : text.slice(at, end);
}

console.log('viewbar control (page):');
const btn = (html.match(/<button[^>]*id="btn-animspeed"[^>]*>[\s\S]*?<\/button>/) || [])[0];
check('the rate button ships in the viewbar', !!btn, btn && btn.slice(0, 60));
check('it sits directly after the Anim toggle',
    html.indexOf('id="btn-anim"') < html.indexOf('id="btn-animspeed"') &&
    html.indexOf('id="btn-animspeed"') < html.indexOf('id="btn-season"'));
check('its tooltip is data-tip, never title',
    /data-tip="/.test(btn || '') && !/title="/.test(btn || ''));
check('the tooltip says what the rate multiplies, and how to pin it',
    /12 fps/.test(btn || '') && /animSpeed=/.test(btn || '') &&
    /shift\+click/.test(btn || ''), (btn || '').slice(0, 80));
const bust = (html.match(/city-view-pixi\.js\?v=(\d+)/) || [])[1] * 1;
check('the page loads a viewer JS that has the control',
    bust >= 101 && /ANIMSPEED_KEY/.test(pv), 'v=' + bust);
check('the button ships labelled at the shipped rate, not 1× (no JS-time flip)',
    (btn || '').endsWith('Speed 2\u00d7</button>'), (btn || '').slice(-24));
check('the tooltip says the shipped rate is 2\u00d7 over the manifest\u2019s 12 fps',
    /Ships at 2(?:\u00d7|&times;)/.test(btn || '') && /24 ticks\/s/.test(btn || '') &&
    /unmodified manifest rate/.test(btn || ''));
check('the statsbar readout stays quiet at the shipped rate only',
    /animSpeed === ANIM_SPEED_DEFAULT \? ''/.test(pv));

console.log('the rate drives a scaled clock, not each strip (wiring):');
check('the rate is declared, saved, and overridable from the URL',
    /var ANIMSPEED_KEY = 'mrsnrub\.cityview\.animspeed';/.test(pv) &&
    /QP\.get\('animSpeed'\)/.test(pv) &&
    /localStorage\.setItem\(ANIMSPEED_KEY/.test(pv));
check('idle loops read the scaled clock',
    /animIdx\(a2, animClock, ph\)/.test(pv) &&        // the per-part idle stack
    /animIdx\(a, animClock, ph\)/.test(pv),           // the toggle loop
    'no animClock idle call');
check('one-shots run on the scaled clock, from a t0 captured on it',
    /\(animClock - tp\.t0\) \* tp\.a\.fps/.test(pv) &&
    (pv.match(/t0: animClock/g) || []).length >= 3,
    't0 sites=' + (pv.match(/t0: animClock/g) || []).length);
check('no building blit path reads the real clock any more',
    !/animIdx\([a-z0-9]+, animNow/.test(pv) &&
    !/\(animNow - tp\.t0\)/.test(pv) &&
    !/t0: performance\.now\(\)/.test(pv), 'an animNow tap/idle site survived');
check('the probe default follows the drawn sprite (same clock)',
    /nowMs === undefined \? animClock : nowMs/.test(pv));
/* the character loops and the decode retries are the two things that MUST stay
   on real milliseconds: their timing is authored data, and a retry timer on a
   scaled clock would hold off a stalled decode for minutes at 0.25x */
check('character idle loops keep the authored delay_ms on the real clock',
    /\(\(animNow \|\| performance\.now\(\)\) \+ h\) % \(as\._tot \+ gap\)/.test(pv) &&
    /\(animNow \|\| performance\.now\(\)\) % \(as\._ptot \+ 1200\)/.test(pv));
check('the decode retry timer stays in real ms',
    /animRetryT = animNow \+ 2000/.test(pv));
check('the card filmstrip players keep their own per-tile rate',
    /st\.rate/.test(strips) && !/animSpeed/.test(strips));
/* 90 ms is ~11 Hz, already the ceiling on a 12 fps strip: speed the loops up
   and the repaint is what stutters. Slow them down and the interval must NOT
   stretch — characters and retries still run at that cadence. */
check('the repaint cadence follows the rate, floored at 90 ms',
    /animNextT = t \+ Math\.max\(16, Math\.min\(90, 90 \/ animSpeed\)\)/.test(pv));
/* the clock helpers are pinned identical to the legacy page by
   smoke-city-view-dom.cjs; the rate may only feed them, never rewrite them */
check('the shared tick mapping still takes the clock as a parameter',
    /function animIdx\(a, clockMs, ph\)/.test(pv) &&
    /Math\.floor\(clockMs \* a\.fps \/ 1000\)/.test(pv));
check('the DEPRECATED Canvas page is untouched by the rate (per AGENTS.md)',
    !/animSpeed|animClock/.test(legacy) &&
    /t0: performance\.now\(\)/.test(legacy));

console.log('the ladder, label and boot precedence (run verbatim):');
/* two contiguous pieces, concatenated: the rate's own state lines, then the
   ladder, the label, the boot read and the click listener. No copy of the rule
   lives here — what runs is what the page runs */
const s1 = pv.indexOf('var ANIMSPEED_KEY');
const e1 = pv.indexOf('\n', pv.indexOf('var animClockT', s1));
const s2 = pv.indexOf('function animSpeedStep(');
const e2 = pv.indexOf('\n    });', pv.indexOf("if ($('btn-animspeed'))", s2));
if (!(s1 >= 0 && e1 > s1 && s2 > e1 && e2 > s2)) {
    check('the rate block is sliceable out of the viewer', false,
        's1=' + s1 + ' e1=' + e1 + ' s2=' + s2 + ' e2=' + e2);
} else {
    const region = pv.slice(s1, e1) + '\n' +
        pv.slice(s2, e2 + '\n    });'.length);
    function boot(stored, q) {
        /* the stubs live INSIDE the evaluated scope so the returned closures can
           see the fake button the listener registered on */
        return new Function('stored', 'q', 'QP',
            'var store = { getItem: function () { return stored; },' +
            ' setItem: function (k, v) { store.v = v; } };' +
            'var el = { textContent: "", addEventListener: function (ev, f)' +
            ' { el.f = f; } };' +
            'var dirties = 0;' +
            'var localStorage = store;' +
            'var $ = function (id) { return id === "btn-animspeed" ? el : null; };' +
            'var markDirty = function () { dirties++; };' +
            region +
            '\nreturn { get rate() { return animSpeed; },' +
            ' label: function () { return el.textContent; },' +
            ' click: function (back) { el.f({ shiftKey: !!back }); },' +
            ' saved: function () { return store.v; },' +
            ' dirties: function () { return dirties; } };')(
                stored, q, { get: k => (k === 'animSpeed' ? q : null) });
    }
    const b0 = boot(null, null);
    check('boots at the shipped default (2× the manifest\u2019s 12 fps)' +
          ' and labels itself so',
        b0.rate === 2 && b0.label() === 'Speed 2\u00d7',
        b0.rate + ' / ' + b0.label());
    b0.click(false);
    check('a click steps the ladder, saves, relabels and asks for a repaint',
        b0.rate === 3 && b0.saved() === '3' &&
        b0.label() === 'Speed 3\u00d7' && b0.dirties() > 0,
        b0.rate + ' / ' + b0.saved() + ' / ' + b0.label() + ' / d=' + b0.dirties());
    check('a reload restores the saved rate', boot(b0.saved(), null).rate === 3);
    b0.click(true);
    check('shift+click steps back down to the default',
        b0.rate === 2 && b0.label() === 'Speed 2\u00d7',
        b0.rate + ' / ' + b0.label());
    check('an explicit 1\u00d7 survives a reload (a saved choice beats the default)',
        boot('1', null).rate === 1);
    const ladder = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];   // pinned on purpose
    check('the ladder is the documented one, ascending and bracketing 1×',
        JSON.stringify(ladder) === '[0.25,0.5,0.75,1,1.5,2,3,4]');
    check('the shipped default is 2 and sits on the ladder, with 1× (the raw' +
          ' manifest rate) kept beside it as the reference',
        /var ANIM_SPEED_DEFAULT = 2;/.test(pv) && ladder.indexOf(2) > 0 &&
        ladder.indexOf(1) > 0);
    let cy = boot(null, null), seen = [], g;
    for (g = 0; g < 8; g++) { seen.push(cy.rate); cy.click(false); }
    const i1 = ladder.indexOf(boot(null, null).rate);
    check('eight clicks visit every step exactly once and come back round',
        seen.join(',') === ladder.slice(i1).concat(ladder.slice(0, i1)).join(','),
        seen.join(','));
    cy = boot(null, '4');                       // the URL knob lands on the top step
    cy.click(false);
    check('clicking past the fastest rate wraps to the slowest',
        cy.rate === 0.25, cy.rate);
    cy.click(true);
    check('and down past the slowest wraps to the fastest', cy.rate === 4, cy.rate);
    const at = (stored, q) => boot(stored, q).rate;
    check('the URL knob beats the saved rate (a view worth pasting wins)',
        at('0.5', '3') === 3);
    check('junk in either slot falls back to the shipped rate, not to a step',
        at('banana', null) === 2 && at(null, 'banana') === 2,
        at('banana', null) + '/' + at(null, 'banana'));
    check('a wild URL value is clamped, not obeyed',
        at(null, '0.001') === 0.1 && at(null, '999') === 8,
        at(null, '0.001') + '/' + at(null, '999'));
    check('a URL rate off the ladder still shows its own label',
        boot(null, '1.25').label() === 'Speed 1.25\u00d7', boot(null, '1.25').label());
    const r = new Function(
        'var localStorage = { getItem: function () { return null; },' +
        ' setItem: function () {} };' +
        'var $ = function () { return { textContent: "", addEventListener:' +
        ' function () {} }; };' +
        'var markDirty = function () {};' +
        'var QP = { get: function () { return null; } };' +
        region +
        '\nreturn { step: animSpeedStep, x: animSpeedX };')();
    check('an off-ladder rate rejoins the ladder from the shipped rate' +
          ' rather than vanishing',
        r.step(2.7, false) === 3 && r.step(0, false) === 3 &&
        r.step(NaN, true) === 1.5, '2.7\u2192' + r.step(2.7, false));
    check('the label reads as a rate: 2 \u2192 "2\u00d7", 1.5 \u2192 "1.5\u00d7", 0.25 \u2192 "0.25\u00d7"',
        r.x(2) === '2\u00d7' && r.x(1.5) === '1.5\u00d7' &&
        r.x(0.25) === '0.25\u00d7' && r.x(0.75) === '0.75\u00d7',
        [r.x(2), r.x(1.5), r.x(0.25), r.x(0.75)].join(' '));
}

console.log('the clock really runs the strips at the set rate (run verbatim):');
{
    /* the accumulation lines out of loop(), verbatim: an unscaled first frame
       (no phantom jump), proportionality, and no hidden clamp on a long delta */
    const at2 = pv.indexOf('var an = performance.now();');
    const bt = pv.indexOf('animClockT = an;', at2);
    const block = at2 < 0 || bt < 0 ? null
        : pv.slice(at2, bt + 'animClockT = an;'.length);
    const acc = (clock0, t0, rate, now) => block === null ? null
        : new Function('animClock', 'animClockT', 'animSpeed', 'performance',
            block + '\nreturn animClock;')(clock0, t0, rate, { now: () => now });
    check('the accumulation block is sliceable out of the loop', !!block);
    check('the first frame does not teleport the clock forward',
        acc(0, 0, 4, 1000) === 0, acc(0, 0, 4, 1000));
    check('1× advances the clock with real time',
        acc(500, 1000, 1, 1100) === 600, acc(500, 1000, 1, 1100));
    check('4× advances it four times as far for the same real time',
        acc(500, 1000, 4, 1100) === 900, acc(500, 1000, 4, 1100));
    check('a backgrounded tab lands the loops elsewhere rather than stalling' +
        ' them (uncapped, like the animNow it mirrors)',
        acc(0, 1000, 2, 61000) === 120000, acc(0, 1000, 2, 61000));
    /* and the mapping the strips actually use: sliced verbatim, so a 2× clock
       must buy 2× the ticks off the engine's own loop length (rp/lt) */
    const helpers = fn(pv, 'animIdx', 'window.__CV_ANIM_FI');
    check('the tick mapping is sliceable out of the viewer', !!helpers);
    if (helpers) {
        const run = new Function(helpers +
            '\nvar plain = { fps: 12, frames: 19 };' +
            '\nvar sparse = { fps: 12, frames: 15, lt: 19, rp: [0, 3, 4, 5, 6, 7,' +
            ' 8, 9, 10, 11, 12, 13, 14, 15, 17] };' +
            '\nreturn { at: function (a, ms, ph) { return animIdx(a, ms, ph || 0); },' +
            ' n: function (a) { return tickCount(a); },' +
            ' plain: plain, sparse: sparse };')();
        check('the engine loop length (lt), not the deduped cell count, sets the' +
              ' cycle', run.n(run.sparse) === 19, 'n=' + run.n(run.sparse));
        check('the clock buys ticks in proportion to the rate and wraps on the' +
              ' loop (12 fps: 0.5 s → 6, 1 s → 12, 2 s → 24 mod 19)',
            run.at(run.plain, 500, 0) === 6 &&
            run.at(run.plain, 1000, 0) === 12 &&
            run.at(run.plain, 2000, 0) === 5,
            [run.at(run.plain, 500, 0), run.at(run.plain, 1000, 0),
             run.at(run.plain, 2000, 0)].join('/'));
        check('per-instance phase still de-synchronises the crowd',
            run.at(run.plain, 1000, 0) !== run.at(run.plain, 1000, 7),
            run.at(run.plain, 1000, 0) + ' vs ' + run.at(run.plain, 1000, 7));
        let inside = true, holds = 0, t;
        for (t = 0; t < run.n(run.sparse); t++) {
            const c = run.at(run.sparse, t * 1000 / 12, 0);
            if (!(c >= 0 && c < run.sparse.frames)) inside = false;
        }
        check('a sparse strip stays inside its cells across the whole loop',
            inside);
        check('the ticks after the last differing cell hold it (engine holds a' +
              ' repeated frame)',
            run.at(run.sparse, 17 * 1000 / 12, 0) === 14 &&
            run.at(run.sparse, 18 * 1000 / 12, 0) === 14,
            run.at(run.sparse, 17 * 1000 / 12, 0) + '/' +
            run.at(run.sparse, 18 * 1000 / 12, 0));
    }
}

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nall green');
process.exit(failures ? 1 : 0);
