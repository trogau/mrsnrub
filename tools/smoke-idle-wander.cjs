// Headless check of the Pixi viewer's idle wander (web/js/wander.js + the
// wiring in web/viewer/city-view-pixi.js, 2026-11-03, notes/13).
//
// Why it exists: the engine walks its idle characters by itself — no job, no
// script — and the port now does too, which means a whole movement stack got
// added to a page whose only previous motion was the camera. The three things
// that can silently go wrong are exactly the three this harness pins: (1) the
// crowd must stay where the save says it lives (a wander that drifts or parks
// characters in a wall makes the port's own ground truth wrong), (2) the cost
// grid must be the SHIPPED <RoadGridSettings> table, not a guess, because the
// table is the only reason idle characters hug the streets, and (3) a walking
// character must draw a walk cell and never a red X — there are no pre-baked
// walk PNGs, so the walk art only exists through the dynamic endpoint and its
// absence has to look like the idle pose.
//
// Four layers:
//  1. PAGE — the Idle walk button ships in the top bar, default on, carries
//     data-tip (never title), and the page loads the two new scripts plus a
//     cache-busted viewer JS.
//  2. WIRING — the viewer builds the sim over the save's own rows, ticks it in
//     the main loop, restores on toggle-off, prefers the walk cell with an
//     idle fallback and no error box, and the DEPRECATED Canvas page is left
//     alone (AGENTS.md).
//  3. BEHAVIOUR — the real module on the real data: characters move, stay on
//     walkable ground, never inside a placed building, never in the sea; the
//     run is deterministic; restore() is exact; a tick stays cheap.
//  4. EVIDENCE — the cost table, the speed defaults and the RandomRelaxed
//     fallback are pinned against the shipped XML they were read out of.
//
//   node tools/smoke-idle-wander.cjs
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

let failures = 0;
function check(name, cond, info) {
    if (cond) { console.log('  ok  ' + name); }
    else { failures++; console.log('FAIL  ' + name + (info !== undefined ? '  [' + info + ']' : '')); }
}
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const html = read('web/viewer/index.html');
const pv = read('web/viewer/city-view-pixi.js');
const legacy = read('web/js/city-view.js');
const wanderSrc = read('web/js/wander.js');
const walkDataSrc = read('web/js/walk-data.js');

console.log('the toggle (page):');
const btn = (html.match(/<button[^>]*id="btn-idlewalk"[^>]*>[\s\S]*?<\/button>/) || [])[0];
check('the Idle walk button ships in the top bar', !!btn, btn && btn.slice(0, 60));
check('it ships ON (class "on" in the markup, no JS-time flip)',
    /class="vbtn on"[^>]*id="btn-idlewalk"/.test(html), (btn || '').slice(0, 46));
check('it sits with the view toggles, before the tuning controls',
    html.indexOf('id="btn-art"') < html.indexOf('id="btn-idlewalk"') &&
    html.indexOf('id="btn-idlewalk"') < html.indexOf('id="btn-grid"'));
check('its tooltip is data-tip, never title',
    /data-tip="/.test(btn || '') && !/title="/.test(btn || ''));
check('the tooltip names the recovered source (cost table, default mode, walk cells)',
    /RoadGridSettings/.test(btn || '') && /RandomRelaxed/.test(btn || '') &&
    /_front_walk/.test(btn || '') && /CityWander\.KNOBS/.test(btn || ''),
    (btn || '').slice(0, 80));
const bust = (html.match(/city-view-pixi\.js\?v=(\d+)/) || [])[1] * 1;
check('the page loads the sim and the generated walk table',
    /\.\.\/js\/wander\.js\?v=\d+/.test(html) &&
    /\.\.\/js\/walk-data\.js\?v=\d+/.test(html));
check('and a viewer JS that has the wiring', bust >= 103 && /WANDER_KEY/.test(pv),
    'v=' + bust);
check('the sim loads before the viewer (it is constructed at parse time)',
    html.indexOf('js/wander.js') < html.indexOf('city-view-pixi.js'));

console.log('the viewer wiring:');
check('the sim runs over the save\'s own rows, terrain, lots and speeds',
    /new CityWander\(\{[\s\S]{0,300}chars: M\.chars[\s\S]*terrain: terrain/.test(pv) &&
    /buildings: M\.buildings/.test(pv) && /WALK_DATA\.chars/.test(pv));
check('the toggle persists and defaults on (only an explicit "0" turns it off)',
    /var WANDER_KEY = 'mrsnrub\.cityview\.idlewalk';/.test(pv) &&
    /localStorage\.getItem\(WANDER_KEY\) !== '0'/.test(pv) &&
    /localStorage\.setItem\(WANDER_KEY, wanderOn \? '1' : '0'\)/.test(pv));
check('toggling hands the state to the sim, repaints, and restores the save layout',
    /wander\.setEnabled\(wanderOn\)/.test(pv) &&
    /setEnabled = function \(on\)[\s\S]*if \(!on\) this\.restore\(\)/.test(wanderSrc));
check('the loop advances the sim every frame and repaints on a throttle',
    /wander\.tick\(dt\)/.test(pv) && /wanderNextT = t \+ \d+/.test(pv) &&
    /walkLive && t >= wanderNextT/.test(pv));
check('the walk cell wins over the idle cell, and only for the walking character',
    /walkArtOf\(e\.c, e\.dir, e\.i\)/.test(pv) &&
    /if \(wk && emitCharDyn\(e, wk, true\)\) return;/.test(pv));
check('a walk cell that is missing or still decoding paints the idle pose (no red X)',
    /function emitCharDyn[\s\S]*?if \(!dv \|\| dv\.st === -1[\s\S]*?return false/.test(pv) &&
    !/dynErrBox\(e\.x, e\.y, wk/.test(pv));
/* The pending rule (2026-11-05): the map used to blit the pre-baked
   assets/characters/<png> whenever a cell's sheet had not decoded yet, so every
   character cost one request to 206k shipped frames for art the endpoint DOES
   serve (the family card had already been given this rule for its tiles). A
   character whose sheet is on its way is now simply not drawn. The shipped file
   survives for what an endpoint cannot serve: the path switched off for A/B
   (dynCell answers null), or a manifest that is ready but names an image its
   sheet does not carry — so the request site must stay, just unreachable while
   pending, and it must stay the file's ONLY request site on the map. */
{
    const at = pv.indexOf('function emitChar(e)');
    const body = at > -1 ? pv.slice(at, at + 4000) : '';
    const iWire = body.indexOf('dynErrBox(e.x, e.y, as2, kc)');
    const iHold = body.indexOf('if (!dynReady(as2)) return;');
    const iFile = body.indexOf("var url = B + 'assets/characters/'");
    check('a cell the endpoint rejected gets the wireframe and stops there',
        iWire > -1 && iHold > iWire, 'wire=' + iWire + ' hold=' + iHold);
    check('a cell whose sheet is still decoding draws nothing (no shipped-PNG fill)',
        iHold > -1 && iFile > iHold, 'hold=' + iHold + ' file=' + iFile);
    check('the hold is inside the dynamic branch, so switching the endpoint off ' +
          'still draws the shipped art',
        /if \(dv\) \{[\s\S]*?if \(!dynReady\(as2\)\) return;\s*\}/.test(body) &&
        iFile > -1);
    check('the map has exactly one character-art request site left',
        (pv.match(/B \+ 'assets\/characters\/' \+/g) || []).length === 1,
        String((pv.match(/B \+ 'assets\/characters\/' \+/g) || []).length));
    check('and the DEPRECATED Canvas page keeps its own static path untouched',
        /imgFor\('assets\/characters\/' \+ charFrameFile\(/.test(legacy));
}
/* The Debug button (2026-11-06): the pending rule made "where is my character"
   a question with five possible answers (sheet cell, walk cell, held because
   the sheet is still decoding, the endpoint's no, the shipped PNG, a dot), and
   answering them meant typing six console one-liners. So the page ships one
   button that prints them all — and the tallies it prints are the SAME branches
   the checks above pin, which is why they are asserted here: a refactor that
   quietly drops one of them would leave the report lying about what drew. */
{
    const dbg = (html.match(/<button[^>]*id="btn-debug"[^>]*>[\s\S]*?<\/button>/) || [])[0];
    check('the Debug button ships in the top bar, with data-tip and never title',
        !!dbg && /data-tip="/.test(dbg) && !/title="/.test(dbg),
        (dbg || '').slice(0, 60));
    check('it sits with the debug overlays (after Wire)',
        html.indexOf('id="btn-wire"') < html.indexOf('id="btn-debug"'));
    check('its tooltip promises the three things the console probes gave: the GPU' +
          ' limit, the per-branch tally, the sprite census',
        /GPU's texture limit/.test(dbg || '') &&
        /branch every character took/.test(dbg || '') &&
        /census of the sprites/.test(dbg || ''));
    check('one click yields one paste: __CV_DEBUG returns the text, the button' +
          ' copies it and opens it in a panel',
        /window\.__CV_DEBUG = function \(\)/.test(pv) &&
        /dbgShowPanel\(text\)/.test(pv) &&
        /navigator\.clipboard\.writeText/.test(pv));
    const at = pv.indexOf('function emitChar(e)');
    const body = at > -1 ? pv.slice(at, at + 4200) : '';
    check('every branch of the people pass counts itself (the report cannot' +
          ' silently stop reporting the held ones)',
        /charBr\.seen\+\+;/.test(body) &&
        /charBr\.wire\+\+;\s*dynErrBox\(e\.x, e\.y, as2, kc\)/.test(body) &&
        /charBr\.png\+\+; emitSpr\(t,/.test(body) &&
        /peopleDots\+\+;\s*charBr\.dot\+\+;/.test(body) &&
        /if \(loop\) charBr\.walk\+\+; else charBr\.sheet\+\+;/.test(pv));
    check('the tallies are reset with the frame, so they describe the frame on' +
          ' screen and not the whole session',
        /charBr\.seen = charBr\.sheet = charBr\.walk = charBr\.wire = charBr\.png =/.test(pv) &&
        /charBr\.seen - charBr\.sheet - charBr\.walk -\s*charBr\.wire - charBr\.png - charBr\.dot/.test(pv));
    check('the sprite census reads each texture\'s own pixels back on the CPU' +
          ' (bad bytes vs a bad upload, which nothing else on the page can tell)',
        /willReadFrequently/.test(pv) && /getImageData\(0, 0, 24, 24\)/.test(pv) &&
        /OPAQUE NEAR-BLACK/.test(pv) && /cov: Math\.round\(100 \* vis \/ n\)/.test(pv));
    check('and the GPU limit is printed with the black-upload warning, since an' +
          ' over-limit sheet uploads incomplete and samples black',
        /MAX_TEXTURE_SIZE/.test(pv) && /uploads INCOMPLETE and samples OPAQUE BLACK/.test(pv));
    check('the census reads each texture through the IMAGE the browser decoded, and' +
          ' names a missing 2d context instead of printing a bare TypeError on every' +
          " row (both flaws came back from the user's own paste)",
        /function dbgCtx\(\)/.test(pv) && /no 2d ctx \(/.test(pv) &&
        /el\.naturalWidth \|\| el\.width/.test(pv) &&
        /\(t\.el \|\| 'no element'\)/.test(pv) &&
        /'  rect ' \+ \(t\.frm \|\| '-'\)/.test(pv) &&
        /e && e\.message/.test(pv));
    check('and it compares every ready cell\'s manifest page against the sheet the' +
          ' browser actually decoded: two requests, two cache entries, and a sheet' +
          ' that re-baked under a cached manifest puts its rects off the page — a' +
          ' character drawn as an opaque black square until a HARD reload',
        /\[pair check\]/.test(pv) && /manifest page /.test(pv) &&
        /image rect\(s\) outside it/.test(pv) && /hard reload/.test(pv) &&
        /dd\.w !== cc\.man\.sheet\.w/.test(pv));
    check('the census can only measure a real <img>: the element the viewer' +
          ' decoded is stamped onto every texture it makes, and a Pixi source' +
          ' wrapper (which has a width but is not drawable) is rejected rather' +
          ' than reported',
        /r\.tex\.__el = im; r\.el = im;/.test(pv) && /t\.__el = r\.tex\.__el/.test(pv) &&
        /tex\.__el \|\| \(tex\.source && tex\.source\.source\)/.test(pv) &&
        /typeof el\.tagName !== 'string'/.test(pv));
    check('a texture with no element is reported as such, not as a clean row' +
          ' (the first census sampled the wrapper, every sample threw, and' +
          ' "suspicious: 0" read as a clean bill of health it never earned)',
        /'no <img>'/.test(pv) && /NOT-DRAWABLE/.test(pv) &&
        /with no <img> to trust \(unmeasured\)/.test(pv));
    check('a walking tile whose stem already ENDS in a locomotion tail is not' +
          ' probed with the tail appended again (six dead cells per character,' +
          ' all unanswerable)',
        /s === c\.stem \+ '_walk' \|\| s === c\.stem \+ '_run'/.test(pv) &&
        /\/_\(walk\|run\)\(_\(left\|right\)\)\?\$\/i\.test\(c\.stem\)/.test(pv));
    check('the report prints its own cache-buster, so a paste says which build' +
          ' it came from (a report from the very build being debugged is' +
          ' otherwise indistinguishable from a stale one)',
        /script\[src\*="city-view-pixi"\]/.test(pv) && /' · build v' \+ vb/.test(pv) &&
        /document\.querySelector &&/.test(pv));
    check('the census samples EVERY group before printing and never cuts a' +
          ' flagged one out of its own report (rows are capped, verdicts are' +
          ' not, so a one-sprite black square cannot hide in the tail)',
        /rows\.filter\(function \(r, i\) \{ return i < CAP \|\| r\.sus; \}\)/.test(pv) &&
        /more groups \(none flagged\)/.test(pv));
    check('the census verdicts the blit, not just the bytes: tint multiplies,' +
          ' so light art under a near-black tint is flagged (and only on real' +
          ' art, so the deliberately dark UNIT fills do not cry wolf)',
        /\*\*\* TINT KILLS ART/.test(pv) && /blit lum /.test(pv) &&
        /indexOf\('<unit white>'\) < 0 && g\.u\.indexOf\('<disc>'\) < 0/.test(pv) &&
        /g\.alpha > 0\.5/.test(pv));
    check('a hidden layer is not counted as on screen but IS named (LOD hides' +
          ' whole containers, and a report that silently drops a layer is how a' +
          ' black rectangle stayed unreported: the census has to say what it' +
          ' did not walk)',
        /c\.visible === false/.test(pv) && /hidden\.push\(nm\)/.test(pv) &&
        /not on screen \(hidden layer\)/.test(pv) &&
        /* the ordering that used to swallow it: a hidden container must reach
           scan() so it can be named, so sprites are the only thing the child
           loop drops, and it drops them AFTER recursing */
        /if \(!s\.texture\) \{ scan\(s, label, depth \+ 1\); continue; \}\s*\n\s*if \(s\.visible === false\) continue;/.test(pv));
    check('the census walks the whole stage, not the four containers it used to' +
          ' hand-pick: a rectangle drawn by the ground fills, the bridges, the' +
          ' LOD atlases or an overlay layer used to be absent from a report that' +
          ' said "sprites on screen", and every layer it can name is labelled',
        /scan\(app\.stage, '\?', 0\)/.test(pv) &&
        !/scan\(sceneG, 'scene'\);/.test(pv) &&
        /\[\[sceneG, 'scene'\], \[propG, 'prop'\], \[beachArtC, 'beach'\]/.test(pv) &&
        /\[grassFillS, 'grass'\]/.test(pv) && /\[markG, 'markers'\]/.test(pv) &&
        /across ' \+ cen\.layers \+ ' named layers/.test(pv) &&
        /if \(depth > 8\) return;/.test(pv));
    check('every texture the viewer makes outside texFor still carries its' +
          ' element and a name, so the sixty road-sheet cells on the raised' +
          ' layer are sampleable instead of printing "no element"',
        /function texFrom\(el, name\)/.test(pv) &&
        /roadHiTex = texFrom\(roadSheetImg/.test(pv) &&
        /terrFlatCache = \{ img: fi\.img,\s*\n?\s*tex: texFrom\(fi\.img/.test(pv) &&
        /UNIT = texFrom\(u/.test(pv));
    check('a dot is told apart from a catalogue gap: the no-record tally only' +
          ' counts frames where the art lookup actually ran (under LOD or with' +
          ' art off everything is a dot by design), and a real one prints the' +
          ' characters' + "' names rather than a bare count",
        /sawArt && !as2/.test(pv) &&
        /charBr\.dotWho && charBr\.dotWho\.length < 8/.test(pv) &&
        /charBr\.looked \|\| !charBr\.dot/.test(pv));
    check('the report asks the GPU what it was GIVEN, not just what the file' +
          ' holds: renderer.extract.pixels (gl.readPixels) is compared against' +
          ' the CPU sample, and an opaque black patch the source does not have' +
          ' is an upload fault, which is the remaining suspect on this GPU',
        /app\.renderer && app\.renderer\.extract/.test(pv) &&
        /ex\.pixels\(\{ target: tex \}\)/.test(pv) &&
        /\*\*\* GPU BLACK \(bytes fine: upload fault\)/.test(pv) &&
        /if \(gpuBad && !cpuBad\)/.test(pv) &&
        /\*\*\* GPU EMPTY/.test(pv));
    check('a readback is bounded: a per-texture cap and a per-report budget keep' +
          ' the Debug button from allocating hundreds of megabytes on a big' +
          ' frame, and both say so in the row instead of failing silently',
        /so\.width \* so\.height > dbgGpuCap/.test(pv) &&
        /\(too big\)/.test(pv) && /dbgGpuBudget <= 0/.test(pv) &&
        /skipped \(report budget\)/.test(pv) &&
        /dbgGpuMemo\.length = 0;/.test(pv));
    check('every frame of every ready cell is read back, not just the frame on' +
          ' screen when the button was pressed — an animating cell lives in its' +
          ' other frames most of the time, which is how a black frame survives' +
          ' the census — including rects that fall off the decoded page and' +
          ' frames naming an image the manifest does not have',
        /\[cell frames\]/.test(pv) &&
        /nf = Math\.min\(frs\.length, 24\)/.test(pv) &&
        /rect off the decoded page/.test(pv) &&
        /names image /.test(pv) && /frames read back on both sides/.test(pv));
    const css = read('web/css/city-view.css');
    check('the paste-back panel is styled (a textarea: copies with no JS, columns line up)',
        /#dbgbox\.show \{ display: flex/.test(css) && /#dbgbox textarea \{/.test(css) &&
        /white-space: pre/.test(css));
}
check('the card\'s preview cell still wins over the walk cell',
    /e\.dir && !\(charPreview &&/.test(pv));
check('a walking cycle replays back to back; an idle keeps its play-and-hold',
    /function charFrameIdx\(as, id, k, fr, loop\)/.test(pv) &&
    /var gap = loop \? 0/.test(pv));
check('two instances of one skin do not stride in lockstep (index in the phase hash)',
    /charFrameIdx\(as2, e\.c\[0\] \+ ':' \+ e\.i,/.test(pv));
/* The mirror half of the walk ruling (notes/13 §6, §8): the flag comes from
   walkPlan through the probe, and the draw flips about the CHARACTER ORIGIN —
   a frame hangs off the origin at x_off, so its box [x_off, x_off+w] mirrors to
   [-(x_off+w), -x_off] (emitSpr's mir flag then flips the texture inside that
   box). Flipping inside the frame's own box would slide the character off its
   feet, which is the difference between a mirrored walk and a teleporting one. */
check('the walk mirror rides the plan and flips about the character origin',
    /var wmir = !!as2\.mir;/.test(pv) &&
    /\(wmir \? -\(df\.x_off \+ dim2\.w\) : df\.x_off\) \* kc/.test(pv) &&
    /dim2\.w \* kc, dim2\.h \* kc, wmir\)/.test(pv) &&
    /_walk: 1, mir: p\.mir/.test(pv) &&
    /names\.push\(\{ slug: s, mir: plan\[t\]\.mir \}\)/.test(pv));
check('the card says where the save put the character as well as where it stands',
    /idle wander/.test(pv) && /\(save ' \+ home\[0\]/.test(pv));
check('the DEPRECATED Canvas page is untouched by the wander (per AGENTS.md)',
    !/CityWander|wander\.tick|walkArtOf/.test(legacy));

console.log('walk cells (helpers sliced verbatim from the viewer):');
/* slice the pure helpers out of the viewer: what runs here is what the
   page runs, no copy of the rule lives in this file */
function slice(name, endMark) {
    const at = pv.indexOf('function ' + name + '(');
    if (at < 0) return null;
    const end = pv.indexOf(endMark, at);
    return end < 0 ? null : pv.slice(at, end + endMark.length);
}
const stemFn = slice('walkStem', '\n    }\n');
const candFn = slice('walkCandidates', '\n    }\n');
const planFn = slice('walkPlan', '\n    }\n');
const dirFn = slice('walkDirOf', '\n    }\n');
let stems = null, cands = null, plan = null, dirs = null;
if (!(stemFn && candFn && planFn && dirFn)) {
    check('the walk helpers are sliceable out of the viewer', false,
        'stem=' + !!stemFn + ' cand=' + !!candFn + ' plan=' + !!planFn +
        ' dir=' + !!dirFn);
} else {
    const suffixes = (pv.match(/var WALK_STEM_SUF = \[[\s\S]*?\];/) || [''])[0];
    const mk = new Function(suffixes + '\n' + stemFn + '\n' + candFn + '\n' +
        planFn + '\n' + dirFn +
        '\nreturn { walkStem: walkStem, walkCandidates: walkCandidates,' +
        ' walkPlan: walkPlan, walkDirOf: walkDirOf };');
    const W = mk();
    stems = W.walkStem; cands = W.walkCandidates;
    plan = W.walkPlan; dirs = W.walkDirOf;
    const slug = (f, s) => cands('homer', f, s).map(p => p.slug);
    const mflag = (f, s) => cands('homer', f, s).map(p => p.mir ? 'M' : '-');
    check('an idle slug flattens to its pool stem (homeridleblink -> homer)',
        stems('homeridleblink') === 'homer' &&
        stems('margeidle') === 'marge' && stems('apuidleblinkleft') === 'apu',
        stems('homeridleblink') + '/' + stems('margeidle') + '/' +
        stems('apuidleblinkleft'));
    check('a pose-only slug keeps its own stem (no bogus walk probe)',
        stems('talkingkrustydoll') === 'talkingkrustydoll');
    check('the ask order is the engine\'s PriorityList: side variant, then the' +
        ' plain cycle of the SAME family, then the other family',
        slug('back', 'right').slice(0, 4).join(',') ===
        'homerbackwalkright,homerbackwalk,homerfrontwalkright,homerfrontwalk' &&
        slug('front', 'right').slice(0, 2).join(',') ===
        'homerfrontwalkright,homerfrontwalk' &&
        slug('back', 'left').slice(0, 4).join(',') ===
        'homerbackwalkleft,homerbackwalk,homerfrontwalkleft,homerfrontwalk',
        slug('back', 'right').join(','));
    /* The mirror (the user's ruling, notes/13 §6) belongs to the STEP, not the
       cell: the two steps the shipped <MovePick> table calls Back_Walk_Right
       and Front_Walk_Left are the two a flat-authored skin has no art for, and
       the eye test says the mirrored plain cycle is the only thing that reads
       right for them — both plain cycles measure square-on, so this is a
       preference, not a facing fix (notes/13 §8). It is only ever a substitute:
       an AUTHORED side cell (tiers 1 and 3) is always drawn as authored, which
       is why every mir flag below is '-' in those slots. Pinned per quadrant so
       the mirror can never leak into a cell that ships its own side art. */
    check('the plain cycles are mirrored on exactly the two steps a flat skin' +
        ' has no art for (back-right, front-left), and an authored side cell' +
        ' never is',
        mflag('back', 'left').join('') === '---M-M' &&
        mflag('back', 'right').join('') === '-M--M-' &&
        mflag('front', 'right').join('') === '---M-M' &&
        mflag('front', 'left').join('') === '-M--M-' &&
        /* the mirror rides the FAMILY of the tail, so a plain run flips with
           the plain walk of the same family and the two side cells of the
           plan stay unflipped in every quadrant */
        plan('back', 'right').every((p, i) =>
            p.mir === [false, true, false, false, true, false][i]) &&
        plan('front', 'left').filter(p => /_walk_(left|right)$/.test(p.tail))
            .every(p => !p.mir),
        mflag('back', 'left') + '|' + mflag('back', 'right') + '|' +
        mflag('front', 'right') + '|' + mflag('front', 'left'));
    check('the plan spells its tails exactly as bcell.php\'s WALK_TAILS does' +
        ' (so mode=anims answers can be read off it)',
        plan('back', 'right').slice(0, 4).map(p => p.tail).join(',') ===
        'back_walk_right,back_walk,front_walk_right,front_walk' &&
        plan('front', 'left').slice(0, 4).map(p => p.tail).join(',') ===
        'front_walk_left,front_walk,back_walk_left,back_walk' &&
        plan('front', 'left').slice(4).map(p => p.tail).join(',') ===
        'front_run,back_run',
        plan('front', 'left').map(p => p.tail).join(','));
    /* The lab's four compass rows are these four steps: walkDirOf reads the
       DRAWN vector (the same tile→screen affine the sprites are placed with),
       never the tile step — in the 2:1 oblique a unit tile step comes out as a
       2:1 diagonal, so "north" is up-LEFT. Pinning the four diagonals here is
       what keeps the lab's compass names honest. */
    const AFF = require(path.join(root, 'web/js/camera.js'))
        .tileAffine({ x: 0, y: 0, zoom: 1 }, 1280, 800);
    const got = [[0, -1], [1, 0], [0, 1], [-1, 0]]
        .map(v => { const d = dirs({ vx: v[0], vy: v[1] }, AFF);
                    return d.fam + '/' + d.side; });
    check('the four tile steps draw as the four engine facings (up-left=back/left,' +
        ' up-right=back/right, down-right=front/right, down-left=front/left)',
        got.join(',') === 'back/left,back/right,front/right,front/left',
        got.join(',') + '  affine a,b,d,e=' + [AFF.a, AFF.b, AFF.d, AFF.e]);
    /* ---- the direction rule, pinned to the shipped content.
       <MoveGroup><MovePick x y speed><PriorityList><Animation name=…>> is the
       engine's own "walking this way plays that cycle" table, in jobs.xml and
       ~200 other job files. For each of the four grid steps the table's
       preferred animation carries a facing (Front_/Back_) and, for the ones
       that ship, a side (_Left/_Right). The viewer's rule is checked against
       it THROUGH the project's own projection (CAM.tileAffine), so a change to
       CAM.ORIENT or to walkDirOf that stops reproducing the table fails here.
       One stray per delta exists in the content (a job that asks for the
       opposite side, e.g. Front_Walk_Right on a (-1,0) pick), so the side
       claim is a majority test with a floor on the evidence. */
    const CAMX = require(path.join(root, 'web/js/camera.js'));
    const A = CAMX.tileAffine({ x: 0, y: 0, zoom: 1 }, 1280, 800);
    const DATA = path.join(root, 'web/assets/dlc/gamescripts-r343174/data');
    const tall = {};
    try {
        for (const f of fs.readdirSync(DATA)) {
            const s = fs.readFileSync(path.join(DATA, f), 'utf8');
            if (s.indexOf('<MovePick') < 0) continue;
            for (const m of s.matchAll(
                /<MovePick\b([^>]*?)(?:\/>|>([\s\S]*?)<\/MovePick>)/g)) {
                const gx = /\bx="(-?\d+)"/.exec(m[1]),
                    gy = /\by="(-?\d+)"/.exec(m[1]);
                if (!gx || !gy) continue;
                const body = m[2] || '';
                /* the FIRST animation of the list is the preferred one */
                const am = /<Animation\s+name="([^"]+)"/.exec(body);
                if (!am) continue;
                const n = am[1].toLowerCase();
                if (!/(walk|run|jog|trot|strut)/.test(n)) continue;
                const fam = n.includes('front') ? 'front'
                    : n.includes('back') ? 'back' : '';
                const side = /(^|_)left\b/.test(n) ? 'left'
                    : /(^|_)right\b/.test(n) ? 'right' : '';
                if (!fam) continue;
                const k = gx[1] + ',' + gy[1];
                (tall[k] = tall[k] || {})[fam + '/' + side] =
                    (tall[k][fam + '/' + side] || 0) + 1;
            }
        }
    } catch (e) { /* gamescripts pack not extracted: skipped below */ }
    const deltas = Object.keys(tall);
    if (!deltas.length) {
        console.log('  --  MovePick direction test skipped (gamescripts pack' +
            ' not extracted)');
    } else {
        console.log('  the shipped <MovePick> table, four grid steps:');
        for (const k of ['-1,0', '0,1', '1,0', '0,-1']) {
            const t = tall[k] || {};
            const all = Object.entries(t).sort((a, b) => b[1] - a[1]);
            if (!all.length) continue;
            const [dx, dy] = k.split(',').map(Number);
            const want = all[0][0].split('/');
            const got = dirs({ vx: dx, vy: dy }, A);
            const sides = all.filter(([n]) => n.endsWith('/left') ||
                n.endsWith('/right'));
            const agree = sides.filter(([n]) => n.endsWith('/' + got.side))
                .reduce((s, [, c]) => s + c, 0);
            const sideN = sides.reduce((s, [, c]) => s + c, 0);
            console.log('    tile ' + k.padEnd(6) + ' -> ' +
                all.map(([n, c]) => n + ' x' + c).join(', '));
            check('    tile ' + k + ': the viewer plays the table\'s family',
                got.fam === want[0], 'table ' + want[0] + ', viewer ' + got.fam);
            if (sideN >= 30)
                check('    tile ' + k + ': and the table\'s side qualifier' +
                    ' (majority, content strays allowed)',
                    agree / sideN > 0.9, agree + '/' + sideN + ' say ' +
                    got.side + ' (' + all.filter(([n]) =>
                        n.endsWith('/left') || n.endsWith('/right'))
                        .map(([n, c]) => n + ' x' + c).join(', ') + ')');
        }
        check('all four grid steps are covered by the table',
            ['-1,0', '0,1', '1,0', '0,-1'].every(k => tall[k]),
            deltas.join(' '));
        /* the two components matter AT ONCE: in the 2:1 oblique every grid
           step is 2 px across for 1 px down, so a rule that waited for the
           "dominant axis" would put the whole town in one cycle */
        const flat = CAMX.tileToWorld(1, 0);
        check('the projection is 2:1, so no grid step is ever more vertical' +
            ' than horizontal (why "dominant axis" cannot work)',
            Math.abs(flat.x) === Math.abs(flat.y) * 2);
        const FLIP = { a: A.a, b: A.b, c: 0, d: -A.d, e: -A.e, f: 0 };
        check('a mirrored rig flips the facing (the art is a billboard: what' +
            ' matters is how it visibly travels)',
            dirs({ vx: 1, vy: 0 }, A).fam !== dirs({ vx: 1, vy: 0 }, FLIP).fam,
            dirs({ vx: 1, vy: 0 }, A).fam + ' vs ' +
            dirs({ vx: 1, vy: 0 }, FLIP).fam);
    }
}

console.log('the sim on the real save (behaviour):');
globalThis.window = {};
require(path.join(root, 'web/js/map-explorer-data.js'));
const M = globalThis.window.MAP_DATA;
/* the endpoint resolves a flattened slug to a pool file by alphanumeric-only
   compare, so a walk probe reaches its cell only if some pool stem normalises
   to it. Checked against the extraction when it is on disk, skipped when not */
try {
    const POOL = '/tmp/opencode/citypool';
    if (!stems || !cands) throw new Error('helpers unavailable');
    const idx = new Map();
    for (const f of fs.readdirSync(POOL))
        if (f.endsWith('.bcell'))
            idx.set(f.slice(0, -6).replace(/[^a-z0-9]/g, ''), f);
    const man = JSON.parse(read('web/assets/characters/characters.json'));
    const has = s => {
        const stem = stems(s);
        return [['front', 'left'], ['front', 'right'], ['back', 'right'],
            ['back', 'left']]
            .flatMap(([fam, side]) => cands(stem, fam, side))
            .some(c => idx.has(c.slug));
    };
    const slugs = [...new Set(Object.values(man.characters).map(r => r.slug))];

    const noWalk = slugs.filter(s => !has(s));
    check('every shipped idle skin has a walk cell to play (or degrades to idle)',
        noWalk.length <= slugs.length * 0.05,
        (slugs.length - noWalk.length) + '/' + slugs.length + ' resolve, e.g. ' +
        noWalk.slice(0, 3).join(', '));
    /* the cast the SAVE places is what the town actually looks like — the
       skins without a walk cell are costume variants, crawlers and props, and
       those walk in their idle pose instead */
    const placed = M.chars.map(c => man.characters[c[0]] &&
        man.characters[c[0]].slug).filter(Boolean);
    const placedNoWalk = placed.filter(s => !has(s));
    check('the placed cast almost all have one',
        placedNoWalk.length <= placed.length * 0.05,
        (placed.length - placedNoWalk.length) + '/' + placed.length +
        ', e.g. ' + [...new Set(placedNoWalk)].slice(0, 4).join(', '));
    /* randomSkin="true" crowd (KrustylandNPC): the manifest must ship the
       skins pool (krustyland_skins.xml), every member with its own asset
       and a reachable walk cell, and the save name must NOT be fuzzy-
       matched onto somebody else's art (Krusty used to shadow the whole
       Krustyland crowd) */
    const poolRec = man.characters['2251'];
    check('the Krustyland crowd ships its skins pool, not one Krusty',
        poolRec && Array.isArray(poolRec.pool) && poolRec.pool.length >= 19 &&
        poolRec.pool.every(s => man.assets[s] && has(s)) &&
        !/^krusty/.test(poolRec.slug) &&
        /function charRecPick\(/.test(pv) && /rec\.pool\[h % rec\.pool\.length\]/.test(pv),
        poolRec ? poolRec.pool.length + ' skins, first ' + poolRec.slug : 'no pool');
} catch (e) {
    console.log('  --  walk-cell reachability skipped (citypool extraction not on disk)');
}

/* The viewer asks bcell.php mode=anims which cycles a skin really ships (one
   request instead of eight guessed probes). The interesting part is what it
   must NOT do: report the costume next door. Driven through the real
   endpoint when php and the pool are both present. */
try {
    const { execFileSync } = require('child_process');
    if (!fs.existsSync('/tmp/opencode/citypool/homer_front_walk.bcell'))
        throw new Error('pool not on disk');
    const ask = n => JSON.parse(execFileSync('php',
        [path.join(root, 'web/api/bcell.php'), '--src=pool', '--mode=anims',
            '--name=' + n], { encoding: 'utf8' })).anims;
    const set = a => a.map(x => x.tail).sort().join(',');
    check('mode=anims reports a plain-walk skin\'s cells',
        set(ask('homer')) === 'back_walk,front_walk', set(ask('homer')));
    check('mode=anims reports the skins that only ship side cells',
        set(ask('mrmcgreg')) ===
        'back_walk_left,back_walk_right,front_walk_left,front_walk_right',
        set(ask('mrmcgreg')));
    check('mode=anims reports a skin with every variant',
        ask('zombiehuman1').length === 6, set(ask('zombiehuman1')));
    check('a costume does not inherit its base skin\'s cells (exact match,' +
        ' not a prefix)',
        set(ask('homer_adam')) === 'back_walk,front_walk' &&
        ask('homer_adam').every(x => x.stem.indexOf('homer_adam_') === 0),
        ask('homer_adam').map(x => x.stem).join(','));
    check('an unknown skin answers empty rather than guessing',
        ask('nosuchskin').length === 0, set(ask('nosuchskin')));
} catch (e) {
    console.log('  --  mode=anims skipped (' + (e.code === 'ENOENT'
        ? 'php unavailable' : 'pool or endpoint unavailable') + ')');
}

globalThis.CAM = require(path.join(root, 'web/js/camera.js'));
const CT = require(path.join(root, 'web/js/terrain.js')).CityTerrain;
const CW = require(path.join(root, 'web/js/wander.js'));
const WD = JSON.parse(walkDataSrc.replace(/^[\s\S]*?window\.WALK_DATA = /, '')
    .replace(/;\s*$/, ''));
const terrain = new CT(M, {});
const SAVE = M.chars.map(c => [c[1], c[2]]);

function run(secs, opts) {
    const rows = M.chars.map(c => [c[0], c[1], c[2]]);
    const w = new CW(Object.assign({
        chars: rows, terrain: terrain, buildings: M.buildings,
        typeNames: CT.TYPE_ORDER, speeds: WD.chars
    }, opts || {}));
    w.setEnabled(true);
    const times = [];
    for (let f = 0; f < 60 * secs; f++) {
        const t0 = process.hrtime.bigint();
        w.tick(1 / 60);
        times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    return { rows: rows, w: w, times: times };
}
const A = run(40);
const st = A.w.info();
check('the save\'s characters are mostly walkers (only off-land props sit out)',
    st.walkers > M.chars.length * 0.9 && st.stuck < 20,
    'walkers=' + st.walkers + ' stuck=' + st.stuck);
check('the crowd actually moves (a third of them mid-stride at any moment)',
    st.walking > M.chars.length * 0.2, 'walking=' + st.walking);
check('and it moves locally, not across town (all inside the target ring)',
    /* the ring is around the character's POST, which is its save tile or the
       nearest walkable one (postSeek away), so the bound is ring + seek */
    A.rows.every((c, i) => Math.hypot(c[1] - SAVE[i][0], c[2] - SAVE[i][1]) <=
        CW.KNOBS.rangeMax * 1.5 + 2 * CW.KNOBS.postSeek + 1));
check('nobody ends up in the sea, on a river or past the land (cost grid holds)',
    A.rows.filter(c => !A.w.walkable(Math.floor(c[1]), Math.floor(c[2]))).length <=
        st.stuck,
    A.rows.filter(c => !A.w.walkable(Math.floor(c[1]), Math.floor(c[2]))).length +
    ' vs stuck ' + st.stuck);
/* the engine's wall entry: a character walking through a placed building would
   read as a port bug, not as a crowd member on a pavement behind a prism.
   The exception is the handful of props the save parks INSIDE a lot (pets in
   a house): they cannot reach a street, so they sit out the sim where they are
   — the same rows the cost grid calls unwalkable */
const inLot = A.rows.filter((c, i) => !A.w.st[i].skip &&
    A.w.occ[Math.floor(c[1]) + ',' + Math.floor(c[2])]);
check('nobody walks through a placed building lot', inLot.length === 0,
    inLot.length + ' inside lots');
/* an arrived character stands on a tile centre (the engine's own grid
   positions); only a mid-stride one is between centres */
const standing = A.rows.filter((c, i) => A.w.st[i] && !A.w.st[i].path &&
    !A.w.st[i].skip);
check('a character at rest stands on a tile centre, not between tiles',
    standing.length > 50 && standing.every(c =>
        Math.abs(Math.abs(c[1] % 1) - 0.5) < 1e-9 &&
        Math.abs(Math.abs(c[2] % 1) - 0.5) < 1e-9),
    standing.length + ' at rest');
check('hops are being planned, and failures are the minority (cost grid is connected)',
    A.w.stats.hops > 200 && A.w.stats.failed < A.w.stats.hops,
    'hops=' + A.w.stats.hops + ' failed=' + A.w.stats.failed);
const B = run(40);
let diffs = 0;
for (let i = 0; i < A.rows.length; i++)
    if (A.rows[i][1] !== B.rows[i][1] || A.rows[i][2] !== B.rows[i][2]) diffs++;
check('a reload of the same save walks the same way (seeded per save id)',
    diffs === 0, diffs + ' differing rows');
const warm = A.times.slice(600).sort((a, b) => a - b);
check('a tick is cheap enough to run every frame (p95 under 4 ms)',
    warm[Math.floor(warm.length * 0.95)] < 4,
    'p95=' + warm[Math.floor(warm.length * 0.95)].toFixed(2) + 'ms');
check('and A* runs are spread, so a crowd settling at once cannot spike a frame',
    /maxSearch/.test(wanderSrc) && /this\._searches >= k\.maxSearch/.test(wanderSrc));
A.w.setEnabled(false);
check('switching the toggle off puts every character back on its save position',
    A.rows.every((c, i) => c[1] === SAVE[i][0] && c[2] === SAVE[i][1]));

console.log('against the shipped data (evidence):');
const settings = read('web/assets/dlc/gamescripts-r343174/data/settings.xml');
const rowsXml = {};
for (const m of settings.matchAll(/<RoadType\s+type="(\w+)"\s+pathCost="(\d+)"/g))
    rowsXml[m[1]] = m[2] * 1;
const shipped = Object.keys(rowsXml);
check('the cost grid is the shipped <RoadGridSettings> table, entry for entry',
    shipped.length > 15 && shipped.every(k => CW.ROAD_COST[k] === rowsXml[k]),
    shipped.filter(k => CW.ROAD_COST[k] !== rowsXml[k]).join(',') || 'n=' + shipped.length);
check('streets are cheaper than grass and water is impassable (why they hug kerbs)',
    CW.ROAD_COST.klroad < CW.ROAD_COST.sidewalk &&
    CW.ROAD_COST.sidewalk < CW.ROAD_COST.road &&
    CW.ROAD_COST.road < CW.ROAD_COST.grass &&
    CW.ROAD_COST.grass < CW.KNOBS.maxCost &&
    CW.KNOBS.maxCost < CW.ROAD_COST.none);
const wds = /<WalkDefaultSpeeds\s+slow="([\d.]+)"\s+fast="([\d.]+)"/.exec(settings);
check('the speed clamp is settings.xml\'s own <WalkDefaultSpeeds>',
    !!wds && CW.KNOBS.speedMin === wds[1] * 1 && CW.KNOBS.speedMax === wds[2] * 1,
    wds ? wds[0] : 'not found');
check('the plain characters\' default mode is the engine\'s RandomRelaxed',
    CW.KNOBS.fallbackMode === 'RandomRelaxed' &&
    WD.defaults.mode === 'RandomRelaxed' && !!CW.MODES.RandomRelaxed);
const homer = WD.chars['3'];
const xml = read('web/assets/dlc/gamescripts-r343174/data/characters.xml');
const homerXml = /<Character\s+id="3"[\s\S]*?<\/Character>/.exec(xml);
check('a generated entry is what the XML says (Homer\'s <WalkSpeed speed>)',
    !!homerXml && homer && homer.speed ===
    parseFloat(/<WalkSpeed speed="(\d+)"/.exec(homerXml[0])[1]),
    JSON.stringify(homer));
check('the table covers the save\'s cast (the rest take the defaults)',
    Object.keys(WD.chars).length > M.chars.length * 0.9,
    Object.keys(WD.chars).length + ' of ' + M.chars.length + ' ids');
const named = Object.entries(WD.chars).filter(([, v]) => v.mode).length;
check('named modes are the exception, so the default path is the one that matters',
    named < 60, named + ' rows name a mode');
check('each recovered mode has its own feel, the job/cutscene modes fall back',
    CW.MODES.RandomRush.speed > CW.MODES.RandomRelaxed.speed &&
    CW.MODES.Sneak.speed < CW.MODES.RandomRelaxed.speed &&
    CW.MODES.JobLocation === null && CW.MODES.CenterScreen === null);
check('an unnamed or job-mode character still gets a wander (the fallback applies)',
    A.w._mode(undefined) === CW.MODES.RandomRelaxed &&
    A.w._mode({ mode: 'JobLocation' }) === CW.MODES.RandomRelaxed &&
    A.w._mode({ mode: 'sneak' }) === CW.MODES.Sneak &&
    A.w._mode({ mode: 'Sneak' }) === CW.MODES.Sneak, 'case-folded enum');
check('speed scales with <WalkSpeed> and stays inside the shipped bracket',
    A.w._speed({ speed: 50 }, CW.MODES.RandomRelaxed) <= CW.KNOBS.speedMax &&
    A.w._speed({ speed: 20 }, CW.MODES.RandomRelaxed) >= CW.KNOBS.speedMin &&
    A.w._speed({ speed: 75 }, CW.MODES.RandomRelaxed) >
    A.w._speed({ speed: 25 }, CW.MODES.RandomRelaxed));

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nall good');
process.exit(failures ? 1 : 0);
