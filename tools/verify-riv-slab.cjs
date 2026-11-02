/* Offline check for the diagonal-guarded river slab (no browser).
   Extracts RIV_FAM / rivStates / rivFlip / rivDiagOpen AND the neighbour-probe
   block of buildRivCell straight out of web/viewer/city-view-pixi.js, so the
   wiring (which diagonal cell is asked, with which faces) is what gets tested,
   not a hand-copied model of it. Asserts:
     * all-open quadrant + diagonal open water facing us on both faces -> state 1
     * all-open quadrant + diagonal land / solid / missing / not facing us
                                                             -> engine 2 / 6 / 9
     * any banked pick (a tested edge closed)                 -> unchanged
   Usage: node tools/verify-riv-slab.cjs
*/
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(
    path.join(__dirname, '..', 'web', 'viewer', 'city-view-pixi.js'), 'utf8');

function grab(startMarker, endMarker, what) {
    const i = src.indexOf(startMarker);
    if (i < 0) throw new Error('missing start of ' + what);
    const j = src.indexOf(endMarker, i);
    if (j < 0) throw new Error('missing end of ' + what);
    return src.slice(i, j + endMarker.length);
}

const code = [
    grab('var RIV_FAM = {', '\n    };', 'RIV_FAM'),
    grab('function rivStates(p) {', '\n    }', 'rivStates'),
    grab('function rivFlip(p, q) {', '\n    }', 'rivFlip'),
    grab('function rivDiagOpen(rec, fA, fB) {', '\n    }', 'rivDiagOpen'),
    /* the exact per-cell neighbour/diagonal wiring from buildRivCell */
    'function cellPicks(tx, ty, big, m, recs) {\n' +
        grab('var pass = { e: !!(m & 1)', 'var es = rivStates(pass);', 'buildRivCell probe') +
        '\nreturn { states: es, pass: pass }; }',
].join('\n');

const ctx = {};
vm.createContext(ctx);
vm.runInContext(code +
    '\nthis.RIV_FAM=RIV_FAM;this.rivStates=rivStates;this.rivFlip=rivFlip;' +
    'this.rivDiagOpen=rivDiagOpen;this.cellPicks=cellPicks;', ctx);
const { RIV_FAM, rivStates, rivFlip, rivDiagOpen, cellPicks } = ctx;

/* engine-true reference: the shipped table before the slab deviation */
function engineStates(p) {
    function f2(f, a, b) { return a && b ? f.both : a ? f.first : b ? f.second : f.none; }
    function f1(f, a, b) { return a && b ? f.both : (a || b) ? f.one : f.none; }
    return {
        nw: f2(RIV_FAM.nw, p.n, p.w), ne: f1(RIV_FAM.ne, p.n, p.e),
        ws: f1(RIV_FAM.ws, p.w, p.s), es: f2(RIV_FAM.es, p.e, p.s),
    };
}
const QUADS = ['nw', 'ne', 'ws', 'es'];

let pass = 0, fail = 0;
function ok(cond, msg) {
    if (cond) pass++; else { fail++; console.log('  FAIL  ' + msg); }
}

/* ---- evidence mode: print what the shipped code picks for a K x K block of
   all-open river cells, so the PIL replica in tools/river_bleed_check.py
   renders the viewer's own choices instead of a re-implementation of them.
       node tools/verify-riv-slab.cjs --picks=6 --big=4 --m=15 --solid=4x4
   stdout is a JSON array of { tx, ty, q: { nw|ne|ws|es: [state, flip] } }. ---- */
const pickArg = process.argv.find((a) => a.indexOf('--picks') === 0);
if (pickArg) {
    const opt = (name, dflt) => {
        const a = process.argv.find((s) => s.indexOf('--' + name + '=') === 0);
        return a ? a.split('=')[1] : dflt;
    };
    const K = parseInt(opt('picks', '6'), 10);
    const BIG = parseInt(opt('big', '4'), 10);
    const M = parseInt(opt('m', '15'), 10);
    /* --solid=4x4,8x12 : cells (tile coords, "X" between the axes) forced solid */
    const solid = new Set((opt('solid', '') || '')
        .split(',').filter(Boolean).map((s) => s.replace('x', ',')));
    const recs = {};
    for (let i = 0; i < K; i++)
        for (let j = 0; j < K; j++) {
            const k = BIG * i + ',' + BIG * j;
            recs[k] = { m: M, p: solid.has(k) ? 1 : 0 };
        }
    const out = [];
    for (let i = 0; i < K; i++) {
        for (let j = 0; j < K; j++) {
            const tx = BIG * i, ty = BIG * j;
            const r = cellPicks(tx, ty, BIG, M, recs);
            const q = {};
            QUADS.forEach((qn) => { q[qn] = [r.states[qn], !!rivFlip(r.pass, qn)]; });
            out.push({ tx: tx, ty: ty, q: q });
        }
    }
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
}

/* ---- 1. rivDiagOpen semantics (faces E1 W2 N4 S8) ---- */
ok(rivDiagOpen({ m: 1 | 8, p: 0 }, 1, 8) === true, 'open when both faces set');
ok(rivDiagOpen({ m: 1, p: 0 }, 1, 8) === false, 'needs both faces (missing S)');
ok(rivDiagOpen({ m: 8, p: 0 }, 1, 8) === false, 'needs both faces (missing E)');
ok(rivDiagOpen({ m: 1 | 8, p: 1 }, 1, 8) === false, 'solid diagonal is never open');
ok(rivDiagOpen({ m: -1, p: 0 }, 1, 8) === false, "'P' diagonal is never open");
ok(rivDiagOpen(undefined, 1, 8) === false, 'missing diagonal is not open');
ok(rivDiagOpen({ m: 15, p: 0 }, 1, 8) === true, 'extra faces do not matter');

/* ---- 2. the wiring: which diagonal cell / which faces each quadrant asks ---- */
{
    /* one cell at the origin; probe each diagonal by making ONLY that one a
       river cell that reaches back toward us on both faces */
    const BIG = 4;
    const CASES = {
        dnw: { at: [-BIG, -BIG], faces: 1 | 8 },   // nw neighbour must reach E+S
        dne: { at: [BIG, -BIG], faces: 2 | 8 },    // ne reaches W+S
        dws: { at: [-BIG, BIG], faces: 1 | 4 },    // ws reaches E+N
        des: { at: [BIG, BIG], faces: 2 | 4 },     // es reaches W+N
    };
    for (const name of Object.keys(CASES)) {
        const c = CASES[name];
        const recs = { '0,0': { m: 15, p: 0 } };
        recs[c.at[0] + ',' + c.at[1]] = { m: c.faces, p: 0 };
        const r = cellPicks(0, 0, BIG, 15, recs);
        ok(r.pass[name] === true, name + ' set from its own diagonal cell');
        /* the right faces: each of the two faces alone must NOT open it */
        for (const only of [1, 2, 4, 8]) {
            if ((c.faces & only) === 0) continue;
            const r2 = cellPicks(0, 0, BIG, 15, Object.assign({}, recs,
                { [c.at[0] + ',' + c.at[1]]: { m: only, p: 0 } }));
            ok(r2.pass[name] === false,
                name + ' needs face ' + only + ' AND its partner (got m=' + only + ')');
        }
        /* the other three diagonals must not be able to set it */
        for (const other of Object.keys(CASES)) {
            if (other === name) continue;
            const o = CASES[other];
            const r3 = cellPicks(0, 0, BIG, 15, Object.assign({}, recs,
                { [c.at[0] + ',' + c.at[1]]: { m: 0, p: 0 } },
                { [o.at[0] + ',' + o.at[1]]: { m: o.faces, p: 0 } }));
            ok(r3.pass[name] === false, name + ' is not set by ' + other +
                "'s cell");
        }
        /* quadrant picks follow their own guard only */
        const qn = { dnw: 'nw', dne: 'ne', dws: 'ws', des: 'es' }[name];
        ok(r.states[qn] === 1, qn + ' picks the slab when its diagonal is open');
        for (const other of QUADS) {
            if (other === qn) continue;
            ok(r.states[other] === engineStates(r.pass)[other],
                other + ' keeps the engine pick when only ' + qn +
                "'s diagonal is open (" + r.states[other] + ')');
        }
    }
}

/* ---- 3. exhaustive: nibble x 4 diagonal flags x centre-solid, all quadrants */
for (let m = 0; m < 16; m++) {
    for (let mask = 0; mask < 16; mask++) {
        for (const cSolid of [false, true]) {
            const BIG = 4;
            const DIAG = { nw: ['nw', 1 | 8], ne: ['ne', 2 | 8], ws: ['ws', 1 | 4], es: ['es', 2 | 4] };
            const DXY = { nw: [-BIG, -BIG], ne: [BIG, -BIG], ws: [-BIG, BIG], es: [BIG, BIG] };
            const recs = { '0,0': { m: m, p: 0 } };
            for (const qn of QUADS) {
                const bit = { nw: 1, ne: 2, ws: 4, es: 8 }[qn];
                if (mask & bit) recs[DXY[qn].join(',')] = { m: DIAG[qn][1], p: 0 };
            }
            /* a solid cell just north of centre forces pass.n (the engine probe) */
            if (cSolid) recs['0,' + -BIG] = { m: 15, p: 1 };
            const r = cellPicks(0, 0, BIG, m, recs);
            const eng = engineStates(r.pass);
            for (const qn of QUADS) {
                const got = r.states[qn], want = eng[qn];
                const both = qn === 'nw' ? (r.pass.n && r.pass.w)
                    : qn === 'ne' ? (r.pass.n && r.pass.e)
                        : qn === 'ws' ? (r.pass.w && r.pass.s)
                            : (r.pass.e && r.pass.s);
                const dOpen = r.pass['d' + qn];
                if (both && dOpen) {
                    ok(got === 1, qn + ' m=' + m + ' mask=' + mask +
                        ' cSolid=' + cSolid + ': open quadrant must slab, got ' + got);
                } else {
                    ok(got === want, qn + ' m=' + m + ' mask=' + mask +
                        ' cSolid=' + cSolid + ' d' + qn + '=' + dOpen +
                        ': expected engine ' + want + ', got ' + got);
                }
                ok(typeof rivFlip(r.pass, qn) === 'boolean', qn + ' flip boolean');
            }
        }
    }
}

/* ---- 4. the reported case: a 4x4 block of all-open river cells (big = 4) ---- */
{
    const BIG = 4, K = 4;                       // cells at 0,4,8,12 in x and y
    const recs = {};
    for (let i = 0; i < K; i++)
        for (let j = 0; j < K; j++) recs[4 * i + ',' + 4 * j] = { m: 15, p: 0 };
    /* per quadrant: the diagonal cell is at (tx±BIG, ty±BIG); it is "inside the
       pond" exactly when that key exists in recs and faces us on both faces */
    const DXY = { nw: [-BIG, -BIG], ne: [BIG, -BIG], ws: [-BIG, BIG], es: [BIG, BIG] };
    const FACE = { nw: 1 | 8, ne: 2 | 8, ws: 1 | 4, es: 2 | 4 };
    let slabs = 0, corners = 0, inner = 0;
    for (let i = 0; i < K; i++) {
        for (let j = 0; j < K; j++) {
            const tx = 4 * i, ty = 4 * j;
            const r = cellPicks(tx, ty, BIG, 15, recs);
            const eng = engineStates(r.pass);
            for (const qn of QUADS) {
                const diagRec = recs[(tx + DXY[qn][0]) + ',' + (ty + DXY[qn][1])];
                const expectSlab = !!diagRec && !diagRec.p && diagRec.m >= 0 &&
                    (diagRec.m & FACE[qn]) === FACE[qn];
                ok(r.states[qn] === (expectSlab ? 1 : eng[qn]),
                    'pond cell ' + tx + ',' + ty + ' quadrant ' + qn + ': expected ' +
                    (expectSlab ? 'slab 1' : 'engine ' + eng[qn]) + ', got ' + r.states[qn]);
                if (expectSlab) slabs++; else corners++;
            }
            if (i > 0 && j > 0 && i < K - 1 && j < K - 1) {
                inner++;
                ok(QUADS.every((q) => r.states[q] === 1),
                    'fully surrounded cell ' + tx + ',' + ty + ' is pure slab, got ' +
                    JSON.stringify(r.states));
            }
        }
    }
    ok(inner === 4, '4x4 pond has 4 fully-surrounded cells (got ' + inner + ')');
    /* 16 cells x 4 quadrants = 64; each rim cell loses the quadrants whose
       diagonal falls outside the block (the pond edge, where the corner art is
       the real shoreline, must stay engine art) */
    ok(slabs + corners === 64, 'every quadrant accounted for (' + slabs + ' slab / ' +
        corners + ' engine corner)');
    /* independent count of the quadrants whose diagonal falls outside the
       block — those are the pond edge, the only places that may keep corner art */
    let outside = 0;
    for (let i = 0; i < K; i++)
        for (let j = 0; j < K; j++)
            for (const qn of QUADS)
                if (!((4 * i + DXY[qn][0]) + ',' + (4 * j + DXY[qn][1]) in recs)) outside++;
    ok(corners === outside, 'exactly the pond-edge quadrants keep engine corners (' +
        corners + ' == ' + outside + ')');
    const keptVals = [];
    for (let i = 0; i < K; i++)
        for (let j = 0; j < K; j++) {
            const r = cellPicks(4 * i, 4 * j, BIG, 15, recs);
            QUADS.forEach((q) => { if (r.states[q] !== 1) keptVals.push(r.states[q]); });
        }
    ok(keptVals.length === corners && keptVals.every((v) => [2, 6, 9].indexOf(v) >= 0),
        'the kept corners are only ever the both-pass tiles 2/6/9 (' +
        keptVals.join(',') + ')');
}

/* ---- 5. the guard itself: one solid / non-facing diagonal keeps corner art ---- */
{
    const BIG = 4;
    const base = {};
    for (let i = 0; i < 4; i++)
        for (let j = 0; j < 4; j++) base[4 * i + ',' + 4 * j] = { m: 15, p: 0 };
    /* interior cell (4,4), northwest diagonal turned solid */
    let recs = Object.assign({}, base, { '0,0': { m: 15, p: 1 } });
    let r = cellPicks(4, 4, BIG, 15, recs);
    const eng = engineStates({ e: true, w: true, n: true, s: true });
    ok(r.states.nw === eng.nw, 'solid diagonal keeps the engine nw corner (' +
        r.states.nw + ')');
    ok(r.states.ne === 1 && r.states.ws === 1 && r.states.es === 1,
        'other quadrants still slab: ' + JSON.stringify(r.states));
    /* northwest diagonal is water but faces away (only E+W, never reaches us) */
    recs = Object.assign({}, base, { '0,0': { m: 1 | 2, p: 0 } });
    r = cellPicks(4, 4, BIG, 15, recs);
    ok(r.states.nw === eng.nw, 'non-facing diagonal keeps the engine nw corner (' +
        r.states.nw + ')');
    ok(r.states.ne === 1 && r.states.ws === 1 && r.states.es === 1,
        'unaffected quadrants still slab: ' + JSON.stringify(r.states));
    /* a banked quadrant (n closed) never slabs, even with an open diagonal */
    recs = Object.assign({}, base);
    recs['4,' + (4 - BIG)] = { m: 15, p: 0 };      // north neighbour, not solid
    r = cellPicks(4, 4, BIG, 15 & ~4, recs);        // our own nibble: N closed
    ok(r.states.nw !== 1 && r.states.ne !== 1,
        'banked quadrants keep their bank: ' + JSON.stringify(r.states));
}

console.log('\n' + (fail ? fail + ' FAILED, ' : '') + pass + ' checks passed');
process.exit(fail ? 1 : 0);