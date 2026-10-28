/* city-view.js — City View (Phase 2, M3). Assembles the oblique 2.5D scene:
   textured terrain (js/terrain.js, M2) + raised building blocks, driven by the
   M0 oblique camera (js/camera.js). Classic script, no modules, no network.

   Buildings are drawn as raised footprint blocks (footprint + height from the
   save) for now — the M1 per-building sprite billboards (web/assets/city) land
   in the next increment once the sprite world-scale + anchor are pinned.

   Data: window.MAP_DATA (js/map-explorer-data.js). */
'use strict';

(function () {
    var M = window.MAP_DATA;
    var $ = function (id) { return document.getElementById(id); };

    var stage = $('stage');
    var cv = $('cv');
    var ctx = cv.getContext('2d');
    var dpr = 1, VW = 0, VH = 0;

    /* perf-debug URL params (2026-10-20.5): ?nogl=1 disables the WebGL
       base layer (A/B the Canvas2D fallback in the same session),
       ?dpr=1 caps the backing store everywhere for machines where the
       raster — not the JS — is the frame cost. */
    var QP = (function () {
        try { return new URLSearchParams(location.search); }
        catch (e) { return { get: function () { return null; } }; }
    })();

    /* ---- asset loading indicator ---------------------------------------------
       One toolbar pill tracks every remote pull: the two boot textures and
       two art manifests get a counted progress bar (assets 2/4), then the
       Art layer's on-demand sprite PNGs stream through the same pill
       (art 132/1,832 while anything is in flight, or as a steady readout
       while Art·sprites mode is on). Failed assets count as settled —
       every one of them has a degrade path (flat grass / flat roads /
       blocks / dots), so the pill can never stick at "loading".
       window.__ASSETS exposes the counters for console + harness. */
    var ALOAD = { boot: 4, bootDone: 0, pend: 0, artGot: 0, artKnown: 0, artDead: 0 };
    window.__ASSETS = ALOAD;
    function aPaint() {
        var el = $('assets');
        if (!el) return;
        var html = null;
        if (ALOAD.bootDone < ALOAD.boot) {
            var p = Math.round(ALOAD.bootDone * 100 / ALOAD.boot);
            html = '<i style="width:' + Math.max(3, p) + '%"></i>assets ' +
                ALOAD.bootDone + '/' + ALOAD.boot;
        } else if (ALOAD.pend > 0 || (artMode === 1 && ALOAD.artKnown)) {
            var q = ALOAD.artKnown
                ? Math.round(ALOAD.artGot * 100 / ALOAD.artKnown) : 0;
            html = '<i style="width:' + Math.max(3, q) + '%"></i>art ' +
                ALOAD.artGot.toLocaleString() + '/' + ALOAD.artKnown.toLocaleString() +
                (ALOAD.pend ? ' \u00b7 ' + ALOAD.pend + ' loading' : '') +
                (ALOAD.artDead ? ' \u00b7 ' + ALOAD.artDead + ' dead' : '');
        }
        if (html === null) { el.classList.add('off'); return; }
        el.classList.remove('off');
        el.innerHTML = html;
    }
    var aT = 0;
    function aPaintSoon() {                 // throttle the per-PNG settle storm
        var n = Date.now();
        if (n - aT > 120) { aT = n; aPaint(); }
        else setTimeout(aPaint, 125);       // trailing paint so the bar settles
    }
    function aBootSettled() { ALOAD.bootDone++; aPaintSoon(); }
    aPaint();                               // "assets 0/4" before anything lands

    /* ---- grass texture (optional; flat grass if it fails to load) ---------- */
    var terrain, grassImg = null;
    (function () {
        var im = new Image();
        im.onload = function () { grassImg = im; if (terrain) terrain.grassImg = im; markDirty(); aBootSettled(); };
        im.onerror = function () { aBootSettled(); /* keep flat grass */ };
        im.src = 'assets/city/grasstile.png';
    })();

    /* ---- road sheet art (real roadrivertiles base tiles, notes/06 §10) -----
       terrain.js stays DOM-free, so the page owns the Image; until it
       loads (or if the pack is absent) roads keep the flat fills. */
    var roadSheetImg = null;
    (function () {
        var im = new Image();
        im.onload = function () { roadSheetImg = im; applyRoadSheet(); markDirty(); aBootSettled(); };
        im.onerror = function () { aBootSettled(); /* keep flat roads */ };
        im.src = 'assets/dlc/roadrivertiles-50/images/roadtilesheet.png';
    })();
    /* winter roads: the XMAS RiverRoadTiles pack re-shipped the same
       512x512 sheet layout as icy tiles (notes/06 §10 tiling is
       layout-agnostic), so winter mode just swaps the sheet — grass
       stays green, matching what the game itself overlaid. */
    var iceSheetImg = null;
    (function () {
        var im = new Image();
        im.onload = function () { iceSheetImg = im; applyRoadSheet(); markDirty(); };
        im.onerror = function () { /* winter keeps the normal sheet */ };
        im.src = 'assets/dlc/XMAS2017_RiverRoadTiles_LTD-50-r492453/images/iceroadtilesheet.png';
    })();
    function applyRoadSheet() {
        if (!terrain) return;
        terrain.roadSheetImg = (SEASON.mode === 'winter' && iceSheetImg)
            ? iceSheetImg : roadSheetImg;
    }

    /* ---- season mode (2026-10-25) -------------------------------------------
       TSTO shipped no season switch: during an event the CDN simply RE-SHIPPED
       the same building slugs with themed art (snow, fall leaves, halloween
       costumes). The generator (gen_city_sprites.py backfill/resolve) worked
       out which provider is the town's BASE art and rendered the byte-
       different re-ships as per-slug variants under assets/city/seasons/
       <class>/<slug>.png, listed in each city-sprites.json entry's `seasons`
       map. The toggle is a pure data overlay: swap the sprite entry + the
       road sheet. Event-only art (holidaytree) has no base twin and shows
       as-is in every mode. Filmstrip anims were cut from the BASE sheet, so
       a building drawn from a season sprite stays static (animOf gates it). */
    var SEASON = { mode: 'base', present: {} };       // present: class -> slug count
    window.__CV_SEASON = SEASON;                      // harness/debug hook
    var SEASON_ORDER = ['winter', 'fall', 'halloween', 'easter', 'valentine',
                        'july4th', 'stpatricks', 'pride', 'summer'];
    var SEASON_LABEL = { winter: 'Winter', fall: 'Autumn', halloween: 'Halloween',
        easter: 'Easter', valentine: 'Valentine', july4th: 'July 4th',
        stpatricks: "St Patrick's", pride: 'Pride', summer: 'Summer' };
    var SEASON_KEY = 'mrsnrub.cityview.season';
    try {
        var _sm = localStorage.getItem(SEASON_KEY);
        if (_sm) SEASON.mode = _sm;
    } catch (e) { /* private mode */ }
    function spriteEntry(key) {                        // season-aware manifest entry
        var sp = citySprites && citySprites[key];
        if (sp && SEASON.mode !== 'base' && sp.seasons) {
            var v = sp.seasons[SEASON.mode];
            if (v) return v;
        }
        return sp;
    }
    function applySeasonMode() {
        var b = $('btn-season');
        if (b) {
            b.classList.toggle('on', SEASON.mode !== 'base');
            b.textContent = 'Season\u00b7' + (SEASON.mode === 'base'
                ? 'base' : (SEASON_LABEL[SEASON.mode] || SEASON.mode));
        }
        applyRoadSheet();
    }
    applySeasonMode();
    if ($('btn-season')) $('btn-season').addEventListener('click', function () {
        var modes = ['base'], i;
        for (i = 0; i < SEASON_ORDER.length; i++)
            if (SEASON.present[SEASON_ORDER[i]]) modes.push(SEASON_ORDER[i]);
        i = modes.indexOf(SEASON.mode);
        SEASON.mode = modes.length < 2 ? 'base'
            : (i < 0 ? modes[1] : modes[(i + 1) % modes.length]);
        try { localStorage.setItem(SEASON_KEY, SEASON.mode); } catch (e) { /* private mode */ }
        applySeasonMode();
        markDirty();
    });

    /* ---- sprite art (M4 TODO items 4/5): billboard sprites ---------------
       Buildings draw their extracted city sprite (assets/city/<slug>.png,
       static bsv3 composites + canvas anchors from city-sprites.json) and
       people draw their .bcell idle pose (assets/characters/, characters.json
       maps save character ids -> assets). Manifests are fetched at boot; a
       missing manifest or PNG degrades that layer to its primitive (raised
       block / yellow dot), per-building and per-character.
       Billboards are screen-aligned: the sprite's anchor pixel is placed at
       the projected ground point and the art scales with zoom. The ground
       point is RE-pinned (notes/06 "Sprite placement RE"): the engine places
       the instance at S*(-z, x, height) from the raw export positionX/Y and
       never touches locX/locY there (they only seed the footprint grid, as
       locX-1/locY-1 subfootprint records). Export positions land on integer
       lattice points (characters on .5 centres), so the pin is the diamond
       CORNER tileToWorld(px,py) — ax/ay default 0. S = art px per tile unit,
       MEASURED 2026-10-25 (tools/fit-sprite-scale.py: blurred edge-NCC of
       the calib-verified Kwik-E-Mart + PoliceStation sprites against the
       full-res export; both peak at S 63-64 — the PX_PER_UNIT candidate,
       notes/06 s10). */
    var ART_KEY = 'mrsnrub.cityview.art';
    var artMode = 1;                        // ships ON (M4 item 4): 0 blocks/dots, 1 sprites
    var ART = {
        S: 64,          // art px per tile unit (measured; see note above)
        ax: 0, ay: 0,       // ground-point nudge in tile units (A/B knob);
                            // RE: the engine pins the raw instance position,
                            // which sits on tile LATTICE POINTS — no half-tile
                            // term (notes/06 "Sprite placement RE")
        ref: 'anchor'       // 'anchor' = pin at tile (px,py); 'origin' = footprint origin
    };
    var TUNE_KEY = 'mrsnrub.cityview.arttune.v2';   // v2: corner-pin defaults
    (function readArtUrl() {           // saved panel tuning, then ?artS= &artAx= &artAy= &artRef=origin
        try {
            var t = JSON.parse(localStorage.getItem(TUNE_KEY));
            if (t) {
                if (isFinite(t.S)) ART.S = t.S;
                if (isFinite(t.ax)) ART.ax = t.ax;
                if (isFinite(t.ay)) ART.ay = t.ay;
                if (t.ref === 'origin' || t.ref === 'anchor') ART.ref = t.ref;
            }
        } catch (e) { /* no saved tuning */ }
        try {
            var qp = new URLSearchParams(location.search);
            var n = function (k) { var v = parseFloat(qp.get(k)); return isFinite(v) ? v : null; };
            if (n('artS') !== null) ART.S = n('artS');
            if (n('artAx') !== null) ART.ax = n('artAx');
            if (n('artAy') !== null) ART.ay = n('artAy');
            if (qp.get('artRef') === 'origin') ART.ref = 'origin';
        } catch (e) { /* no URL (headless harness) */ }
    })();
    window.ART = ART;                  // console: ART.ay = 1; __ART_tweak()
    window.__ART_tweak = function (patch) {
        for (var k in patch) ART[k] = patch[k];
        markDirty();
    };
    var citySprites = null;                 // city-sprites.json sprites map
    var charMan = null;                     // characters.json {assets, characters}
    (function loadManifests() {
        fetch('assets/city/city-sprites.json').then(function (r) {
            return r.ok ? r.json() : null;
        }).then(function (j) {
            if (j && j.sprites) {
                citySprites = j.sprites;
                ALOAD.artKnown += Object.keys(j.sprites).length;
                // season variants stream through the same art pill count
                for (var sk in j.sprites) {
                    var ss = j.sprites[sk].seasons;
                    if (!ss) continue;
                    for (var cc in ss) {
                        SEASON.present[cc] = (SEASON.present[cc] || 0) + 1;
                        ALOAD.artKnown++;
                    }
                }
                applySeasonMode();          // label the button with real data
                aglInvalidate();
                markDirty();
            }
            aBootSettled();
        }).catch(function () { aBootSettled(); /* blocks only */ });
        fetch('assets/characters/characters.json').then(function (r) {
            return r.ok ? r.json() : null;
        }).then(function (j) {
            if (j && j.assets) {
                charMan = j;
                ALOAD.artKnown += Object.keys(j.assets).length;
                aglInvalidate();
                markDirty();
            }
            aBootSettled();
        }).catch(function () { aBootSettled(); /* dots only */ });
    })();
    var imgCache = {};
    function imgFor(url) {                  // lazy loader; null until decoded
        var im = imgCache[url];
        if (im === undefined) {
            ALOAD.pend++; aPaintSoon();     // streams through the asset pill
            im = new Image();
            im.onload = function () {
                ALOAD.pend--; ALOAD.artGot++; markDirty(); aPaintSoon();
            };
            im.onerror = function () {
                imgCache[url] = null;       // degrade to block/dot
                ALOAD.pend--; ALOAD.artDead++; markDirty(); aPaintSoon();
            };
            imgCache[url] = im;
            im.src = url;
        }
        return (im && im.complete && im.naturalWidth) ? im : null;
    }
    function applyArtMode() {
        var b = $('btn-art');
        if (b) {
            b.classList.toggle('on', artMode === 1);
            b.textContent = artMode === 1 ? 'Art\u00b7sprites' : 'Art\u00b7blocks';
        }
        aPaint();                       // the art stream readout rides the toggle
    }
    (function loadArt() {
        var av = null;
        try { av = localStorage.getItem(ART_KEY); } catch (e) { /* private mode */ }
        artMode = (av === null || parseInt(av, 10) === 1) ? 1 : 0;   // default ON (M4 item 4)
        applyArtMode();
    })();
    if ($('btn-art')) $('btn-art').addEventListener('click', function () {
        artMode = artMode ? 0 : 1;
        try { localStorage.setItem(ART_KEY, String(artMode)); } catch (e) { /* private mode */ }
        applyArtMode();
        markDirty();
    });

    /* ---- in-place bsv3 animation (M4 variants, .20) ---------------------------
       city-anims.json (tools/gen_city_sprites.py anims) carries one filmstrip
       PNG per named bsv3 loop per asset: uniform cells laid out in anchor
       SPACE — the loop's (ax, ay) is where the building's ground pin sits
       inside a cell, exactly like a static PNG's anchor, so a cell blits at
       the same place the static sprite does. The real game does NOT loop
       every strip a bsv3 carries: the manifest's behavior map (.27, parsed
       from the gamescripts packs) says which named anim each building's
       controller loops on its own (ActiveAnimationController / neutralAnim,
       engine default 'Neutral') and which one its BuildingTouched script
       plays once when tapped. The map loops ONLY the idle anim and plays
       the tap strip once per click; v1 manifests without the map keep the
       old longest-loop behaviour. A third gate covers the engine's
       click-STATE-MACHINES (buildingcontrollers.xml Sequences, parsed by
       the generator into the manifest's toggle record): the controller
       name is not an anim and the tap script only flips object variables,
       so nothing looped and nothing tap-resolved. Three shapes — inout
       {in,loop,out} plays in then loops loop, the next click plays out;
       active {loop} toggles the loop on/off; cycle {poses[]} walks pose
       loops one click at a time. State 0 is always the idle/static look
       (its Neutral strip gates as the ordinary idle loop when present).
       See togglers/tapBuilding below.
       Some assets have no controller loop at all and animate as STACKED
       PART LOOPS instead — EscalatorToNowhere's <AnimationLayerOrder> is
       StairsUL, Stairs, Characters, StairsOV (the steps and the riders each
       loop in their own strip), and multi-part lots split the same way
       (OldEnglishStationBase loops NeutralBase, …Top loops NeutralTop).
       Those slugs carry behavior.layers = [anim, …] in draw order: the
       player keeps the static body PNG and blits every layer's current cell
       over it, so a record is {cells:[strip…], base:1} where an ordinary
       idle is {cells:[strip], base:0} (the cell replaces the PNG). When an
       animated slug draws above the readability gate we blit the current
       cell instead of the static PNG, in BOTH art paths (2D drawSprite and
       the GL atlas, where each frame packs as its own atlas cell). All
       instances share the clock but carry a deterministic per-building
       phase, so a row of fountains ripples out of step. The scene is
       dirty-driven, so while a frame rendered any animated sprite the loop
       schedules the next repaint at the loop rate (it stops by itself once
       nothing animated is on screen). */
    var ANIM_KEY = 'mrsnrub.cityview.anim';
    var animOn = true;
    var anims = null;                     // slug -> {cells:[strip…], base:0|1}
    var taps = {};                        // slug -> one-shot tap filmstrip
    var togglers = {};                    // slug -> engine click-state-machine
                                          // {kind, in/loop/out | poses[]}
    var behav = null;                     // slug -> {idle, tap} (v2 manifest)
    var animNow = 0;                      // ms, one clock per rendered frame
    var animLive = 0;                     // animated sprites in the last frame
    var charAnimLive = 0;                 // animating character sprites (see charFrameFile)
    var CHAR_ANIM_MIN_PX = QP.get('charAnimMinPx') !== null
        ? (Math.abs(QP.get('charAnimMinPx') | 0)) : 24;
    var animNextT = 0;                    // next scheduled animation repaint
    /* per-frame cap on animated blits: filmstrip cells are huge source
       images and (in GL mode) each distinct (frame, tier) packs its own
       atlas cell, so a screenful of hundreds of animated props is the
       worst-case repaint. Past the cap the rest draw their static PNG.
       ?animMax=N tunes it live; 0 pins everything static (A/B the cost). */
    var ANIM_MAX_BLITS = QP.get('animMax') !== null
        ? Math.max(0, parseInt(QP.get('animMax'), 10) || 0) : 96;
    var animBudget = 0;                   // blits left this rendered frame
    /* readability floor: an animation is only worth its decode/raster cost
       when the animated region actually reads — the cell's SHORTER edge must
       span at least this many screen px; the 12px static-sprite gate is far
       too permissive to be shared. 48 is set from the catalogue, not just
       taste: the smallest filmstrip cell anywhere is golfcoursefountain's
       134px Neutral spray loop, and the boot view (SpringfieldDowns fit,
       k≈0.45-0.65 depending on window height) lands that spray at ~60-85 px
       — the old 64 floor sat right on top of it, so the fountain sat static
       at load and only came alive once you zoomed in. A 134px particle
       region at ~60 screen px reads as live (that's exactly what the 12fps
       loops are tuned for), and the next-smallest cell in the catalogue is
       332px, so nothing else changes tier at 48 — overview zoom still parks
       fountains/decor as static PNGs. ?animMinPx=N tunes it live. */
    var ANIM_MIN_PX = QP.get('animMinPx') !== null
        ? Math.max(0, parseInt(QP.get('animMinPx'), 10) || 0) : 48;
    /* decoded-filmstrip caps: a filmstrip is one big PNG decoded per slug
       and cached for the session. Two tiers (measured over the manifest:
       6 Mpx passes 35% of assets, 16 Mpx passes ~60% — a single-tier 6 Mpx
       cap silently froze most of the catalogue, shark-tank/lighthouse/gear
       landmarks included, while the sidebar player happily played them):
       - over ANIM_MAX_ATLAS_PX (16 Mpx ≈ 64 MB RGBA): never animate on the
         map (still plays in the details card);
       - over ANIM_BIG_ATLAS_PX (6 Mpx): animate, but at most ANIM_BIG_MAX
         distinct big atlases decode per session, and decoded filmstrips
         beyond ANIM_CACHE_MAX are LRU-evicted so a long pan across a dense
         town can't pile up GBs of decoded film. */
    var ANIM_MAX_ATLAS_PX = 16e6;
    var ANIM_BIG_ATLAS_PX = 6e6;
    var ANIM_BIG_MAX = 8;
    var ANIM_CACHE_MAX = 40;
    var animBigLive = 0;                  // big filmstrips decoded this session
    /* click-driven exceptions to the 16 Mpx map cap: the engine's toggle
       class (the helicopter) carries the catalogue's biggest atlases
       (redstarhelicopter's Active_Out is 45 Mpx) yet NEVER animates on its
       own, so every oversize decode there is one the user asked for with a
       click. The in/out one-shots are transient and budget-exempt like the
       tap strips; the Active-state loop keeps playing, so oversize strips
       share a session cap of ANIM_HUGE_MAX decoded oversize filmstrips —
       sized so one asset completes a full in/loop/out cycle (3) with a
       spare slot, since anything past the cap just falls back to static. */
    var ANIM_HUGE_MAX = 4;
    var animHuge = {};                    // oversize filmstrip url -> strip png
    var animLru = [];                     // filmstrip urls, most-recent last
    (function loadAnims() {
        fetch('assets/city/city-anims.json').then(function (r) {
            return r.ok ? r.json() : null;
        }).then(function (j) {
            if (!j || !j.anims) return;
            anims = {}; taps = {}; togglers = {};
            behav = j.behavior || null;
            for (var s in j.anims) {
                var list = j.anims[s];     // generator sorts loops longest-first
                if (!list || !list.length) continue;
                // v2 manifests gate on the engine's own behaviour: only the
                // controller anim loops; the tap anim waits for a click.
                // v1 manifests (no map) keep the longest-loop behaviour.
                var loop = behav ? pickAnim(list, behav[s] && behav[s].idle)
                                 : list[0];
                var tap = behav ? pickAnim(list, behav[s] && behav[s].tap)
                                : null;
                if (loop && loop.frames > 1) anims[s] = { cells: [loop], base: 0 };
                // no controller loop: a multi-part asset animates as its
                // part loops, each blitted over the static body (draw order
                // = manifest order, which the generator took from the
                // <AnimationLayerOrder> / the part buildings' own defs)
                else if (behav && behav[s] && behav[s].layers) {
                    var cs = [], seen = [], li;
                    for (li = 0; li < behav[s].layers.length; li++) {
                        var e = pickAnim(list, behav[s].layers[li]);
                        if (e && e.frames >= 1 && seen.indexOf(e.anim) < 0) {
                            seen.push(e.anim); cs.push(e);   // frames==1: a
                        }                                     // static part
                    }
                    if (cs.length) anims[s] = { cells: cs, base: 1 };
                }
                if (tap && tap.frames > 1 && tap !== loop) taps[s] = tap;
                // engine click-state-machine (buildingcontrollers.xml,
                // mirrored into the manifest's toggle record): three shapes
                // — inout {in,loop,out}, active {loop}, cycle {poses[]}
                var tg = behav && behav[s] && behav[s].toggle;
                if (tg) {
                    var kind = tg.kind || 'inout', a2, i2, rec2 = null;
                    if (kind === 'inout') {
                        var aIn = pickAnim(list, tg['in']),
                            aLp = pickAnim(list, tg.loop),
                            aOut = pickAnim(list, tg.out);
                        if (aIn && aOut && aIn.frames > 1 && aOut.frames > 1)
                            rec2 = { kind: 'inout', 'in': aIn, out: aOut,
                                     loop: (aLp && aLp.frames > 1) ? aLp : null };
                    } else if (kind === 'active') {
                        a2 = pickAnim(list, tg.loop);
                        if (a2 && a2.frames > 1)
                            rec2 = { kind: 'active', loop: a2 };
                    } else if (kind === 'cycle' && tg.poses) {
                        var ps = [];
                        for (i2 = 0; i2 < tg.poses.length; i2++)
                            ps.push(tg.poses[i2] ? pickAnim(list, tg.poses[i2]) : null);
                        for (i2 = 1; i2 < ps.length; i2++)
                            if (ps[i2] && ps[i2].frames > 1) rec2 = { kind: 'cycle', poses: ps };
                    }
                    if (rec2) togglers[s] = rec2;
                }
            }
            window.__CV_ANIM = anims;
            applyAnimMode();
            markDirty();
        }).catch(function () { /* static sprites only */ });
    })();
    function togLabel(t) {              // details-card words for a click-
        if (!t) return '';              // state-machine record (manifest
        var k = t.kind || 'inout';      // shape, resolved anim names)
        if (k === 'active') return t.loop + ' on/off';
        if (k === 'cycle')
            return (t.poses || []).map(function (p) { return p || 'static'; })
                .join(' \u2192 ');
        return t['in'] + ' \u2192 ' + (t.loop || '(hold ' + t['in'] + ')') +
            ' \u2192 ' + t.out;
    }
    function pickAnim(list, name) {
        if (!name) return null;
        var n = String(name).toLowerCase(), i;
        for (i = 0; i < list.length; i++)
            if (list[i].anim.toLowerCase() === n) return list[i];
        if (n.length > 6 && n.slice(-6) === 'noloop') {
            // defensive verb match: the engine's '…NoLoop' suffix is
            // playback semantics, not part of a bsv3 anim name
            n = n.slice(0, -6).replace(/[_-]+$/, '');
            for (i = 0; i < list.length; i++)
                if (list[i].anim.toLowerCase() === n) return list[i];
        }
        return null;
    }
    function applyAnimMode() {
        var b = $('btn-anim');
        if (b) b.classList.toggle('on', !!(animOn && anims));
    }
    (function loadAnimPref() {
        try { animOn = localStorage.getItem(ANIM_KEY) !== '0'; } catch (e) { /* private mode */ }
    })();
    if ($('btn-anim')) $('btn-anim').addEventListener('click', function () {
        animOn = !animOn;
        try { localStorage.setItem(ANIM_KEY, animOn ? '1' : '0'); } catch (e) { /* private mode */ }
        applyAnimMode();
        markDirty();
    });
    /* the cells to blit for building b, or null: off (button/manifest), the
       flipped twin has no filmstrip of its own, a cell would not read at
       this zoom, or the per-frame blit budget is spent. Returns
       {cells:[{a,fi}…], base:0|1}: base 1 = draw the static PNG under the
       cells (a multi-part asset's body), base 0 = the one cell replaces it.
       The blit sites additionally gate on each cell's DEST rect: the tile
       cull lets buildings up to 6 tiles past the viewport through, which at
       deep zoom is >1000 px off-screen — those would rasterize huge atlas
       slices for nothing and keep the repaint clock alive while nothing
       visibly moves. */
    function animKey(b) {                 // strips follow the DRAWN sprite:
        if (!b.slug) return null;         // a mirrored instance needs the
        if (!b.flip) return b.slug;       // mirrored filmstrip, never the
        return (citySprites && citySprites[b.slug + 'flipped'])
            ? b.slug + 'flipped' : null;  // unmirrored one
    }
    function animOf(b, k) {
        if (!anims || !animOn || !artMode) return null;
        var key = animKey(b);
        if (!key) return null;
        // season-mode art: the filmstrips were cut from the BASE sheet, so
        // overlaying their cells on a snowy/fall body would mix seasons —
        // the building draws its static season PNG instead
        var base = citySprites && citySprites[key];
        if (base && base.seasons && base.seasons[SEASON.mode]) return null;
        var tp = b._tap;              // a tapped building plays its one-shot
        if (tp) {                     // tap filmstrip, then back to the idle
            var tfi = Math.floor((animNow - tp.t0) * tp.a.fps / 1000);
            if (tfi >= tp.a.frames) {
                b._tap = null;
                // an ActiveInOut transition finished: advance the toggle's
                // state (in → active loop, out → back to static Neutral)
                if (tp.then !== undefined) b._tog = tp.then;
            }
            else {
                // taps skip the blit budget; every one-shot is click-driven,
                // so like the toggle transitions it is exempt from the
                // huge-atlas cap — the big rotor strips of the police/
                // attack/burns helis are plain taps
                var r = animCell(tp.a, k, tfi, true);
                if (r) { r.tap = 1; return { cells: [r], base: 0, tap: 1 }; }
                // gated (under the readability floor): the one-shot can't
                // draw — let the idle path answer instead
            }
        }
        if (animBudget <= 0) return null;
        // per-building phase from the ground pin: stable, no state per instance
        var ph = Math.abs(Math.round((b.px || 0) * 3 + (b.py || 0) * 7));
        var tg = togglers[key];           // clickable state machine?
        if (tg) {
            var st = b._tog | 0, a = null, hold = 0;
            if (tg.kind === 'cycle') {
                if (st >= tg.poses.length) st = 0;
                a = tg.poses[st];
            } else if (st) {
                a = tg.loop || tg['in'];  // no Active loop: hold In's last
                hold = tg.loop ? 0 : 1;   // frame (the engine shows a miss)
            }
            if (a) {                      // click-driven: oversize-exempt
                var c = animCell(a, k, hold ? a.frames - 1
                    : (Math.floor(animNow * a.fps / 1000) + ph) % a.frames,
                    true);
                return c ? { cells: [c], base: 0 } : null;
            }
            // state 0 with no strip of its own: the idle path below (the
            // gated Neutral loop) or the static body PNG
        }
        var rec = anims[key];
        if (!rec) return null;
        var cells = null;
        for (var i = 0; i < rec.cells.length; i++) {
            var a = rec.cells[i];
            var c = animCell(a, k, (Math.floor(animNow * a.fps / 1000) + ph) % a.frames);
            if (!c) {
                // a layered stack must composite whole: one missing part
                // (e.g. the front-panel occluder) would smear the layers
                // that paint over art the body already shows
                if (rec.base) return null;
                continue;
            }
            if (!cells) cells = [];
            cells.push(c);
        }
        if (!cells) return null;
        return { cells: cells, base: rec.base };
    }
    function animCell(a, k, fi, oversize) {
        if (a.px === undefined)           // decoded filmstrip size, measured once
            a.px = a.w ? a.w * a.h        // sparse: the atlas itself sizes
                       : a.cols * a.cellw * Math.ceil(a.frames / a.cols) * a.cellh;
        if ((a.px > ANIM_MAX_ATLAS_PX && !oversize) ||
            Math.min(a.cellw, a.cellh) * k < ANIM_MIN_PX) return null;
        return { a: a, fi: fi };
    }
    function ubOf(a) {                    // anchor-relative drawing bounds
        if (!a.sub) {                     // uniform: the whole cell
            if (!a.ub) a.ub = [-a.ax, -a.ay, -a.ax + a.cellw,
                               -a.ay + a.cellh];
            return a.ub;
        }
        if (a.ub === undefined) {         // sparse: union of every rect
            var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
            for (var f = 0; f < a.sub.length; f++)
                for (var q = a.sub[f], j = 0; j < q.length; j++) {
                    var r = q[j];
                    if (r.ox < x0) x0 = r.ox;
                    if (r.oy < y0) y0 = r.oy;
                    if (r.ox + r.w > x1) x1 = r.ox + r.w;
                    if (r.oy + r.h > y1) y1 = r.oy + r.h;
                }
            a.ub = x1 > x0 ? [x0, y0, x1, y1] : null;
        }
        return a.ub;
    }
    function animFrame(a, b, nowMs) {     // one deterministic frame per prop
        var ph = Math.abs(Math.round((b.px || 0) * 3 + (b.py || 0) * 7));
        return (Math.floor((nowMs === undefined ? animNow : nowMs) *
                           a.fps / 1000) + ph) % a.frames;
    }
    window.__CV_ANIM_FI = function (slug, b, nowMs) {   // smoke-test probe
        if (!anims || !anims[slug]) return -1;
        return animFrame(anims[slug].cells[0], b, nowMs);
    };
    window.__CV_ANIM_layers = function (slug) {         // smoke-test probe
        var r = anims && anims[slug];
        return r ? { n: r.cells.length, base: r.base,
                     anims: r.cells.map(function (a) { return a.anim; }) } : null;
    };
    /* click-to-play: the BuildingTouched script's anim-play equivalent —
       play the slug's tap filmstrip once (ActiveNoLoop semantics), then
       the building reverts to its idle loop. Driven by the canvas click
       below (and the __CV_TAP harness probes). */
    function tapBuilding(b) {
        if (!b || !anims || !animOn || !artMode) return false;
        var key = animKey(b);
        if (!key) return false;
        var tg = togglers[key];
        if (tg) {                       // engine click-state-machine
            if (b._tap) return false;   // re-taps ignored mid-transition,
            if (tg.kind === 'inout') {  // like the ActiveIn/Out var guard
                b._tap = b._tog
                    ? { a: tg.out, t0: performance.now(), then: 0 }
                    : { a: tg['in'], t0: performance.now(), then: 1 };
            } else if (tg.kind === 'active') {
                b._tog = b._tog ? 0 : 1;
            } else {                    // cycle: advance one pose per click
                b._tog = ((b._tog | 0) + 1) % tg.poses.length;
            }
            markDirty();
            return true;
        }
        var t = taps[key];
        if (!t) return false;
        b._tap = { a: t, t0: performance.now() };
        markDirty();
        return true;
    }
    /* front-most VISIBLE block covering a tile, or null. The prism
       hit-test only claims the drawn faces (roof + two sides), so the
       ground strip behind a tall building's roof — and every tile of the
       lot the sprite art stands on — would otherwise fall through to the
       ground tile. The real game lets you touch a building anywhere on
       its lot, so the click handler treats a ground click inside a
       block's tile footprint as a touch on that block. */
    function blockAtTile(tx, ty) {
        for (var k = buildings.length - 1; k >= 0; k--) {   // front-to-back
            var b = buildings[k];
            if (objHidden[b.cat]) continue;
            if (tx >= b.x0 && tx < b.x1 && ty >= b.y0 && ty < b.y1) return b;
        }
        return null;
    }
    window.__CV_TAP = function (mi, fire) {  // console/harness: inspect/fire
        var b = byMi[mi];
        if (!b) return -1;
        if (fire) tapBuilding(b);
        if (!b._tap) return -1;
        var fi = Math.floor((performance.now() - b._tap.t0) *
                            b._tap.a.fps / 1000);
        return fi < b._tap.a.frames ? fi : -1;
    };
    window.__CV_TAP_at = function (tx, ty, fire) {  // harness: lot rule
        var b = blockAtTile(tx, ty);
        if (!b) return -1;
        if (fire) tapBuilding(b);
        if (!b._tap) return -1;
        var fi = Math.floor((performance.now() - b._tap.t0) *
                            b._tap.a.fps / 1000);
        return fi < b._tap.a.frames ? fi : -1;
    };
    window.__CV_TOG = function (mi) {   // harness: state-machine readout
        var b = byMi[mi];
        if (!b) return null;
        if (b._tap) return 'play';
        var k = animKey(b);
        var tg = k && togglers[k];
        if (tg && tg.kind === 'cycle') return 'pose' + (b._tog | 0);
        return b._tog ? 'active' : 'neutral';
    };
    window.__CV_TOG_strip = function (mi) {  // harness: strip the current
        var b = byMi[mi];                     // state renders (name check)
        if (!b) return null;
        if (b._tap) return b._tap.a.anim;
        var k = animKey(b);
        var tg = k && togglers[k];
        if (!tg) return null;
        var st = b._tog | 0;
        if (tg.kind === 'cycle')
            return st < tg.poses.length && tg.poses[st] ? tg.poses[st].anim : null;
        return st ? (tg.loop || tg['in']).anim : null;
    };
    window.__CV_TILE_screen = function (tx, ty) {  // harness: tile -> screen
        var w = CAM.tileToWorld(tx, ty);
        return CAM.worldToScreen(cam, w.x, w.y, VW, VH);
    };
    window.__CV_ANIM_max = function (n) { // console/harness: tune the blit cap
        if (n !== undefined) ANIM_MAX_BLITS = Math.max(0, n | 0);
        return ANIM_MAX_BLITS;
    };
    window.__CV_ANIM_minPx = function (n) {          // readability floor knob
        if (n !== undefined) ANIM_MIN_PX = Math.max(0, n | 0);
        return ANIM_MIN_PX;
    };
    /* the huge-slot budget is a SESSION cap and click-driven one-shots keep
       arriving (heli rotor taps): recycle the oldest huge entry that no
       building is mid-animation on. */
    function freeHugeSlot() {
        var i, b, live = {};
        for (i = 0; i < buildings.length; i++) {
            b = buildings[i];
            if (b._tap) live[b._tap.a.png] = 1;
            if (b._tog) {                       // an engaged toggle machine
                var tgx = togglers[animKey(b)]; // still blits its state strip
                if (!tgx) continue;
                var pa = tgx.kind === 'cycle'
                    ? tgx.poses[(b._tog | 0) % tgx.poses.length]
                    : tgx.loop || tgx['in'];
                if (pa) live[pa.png] = 1;
            }
        }
        for (i = 0; i < animLru.length; i++) {
            var old = animLru[i];
            if (!animHuge[old] || live[animHuge[old]]) continue;
            delete animHuge[old];               // frees the oversize slot
            animLru.splice(i, 1);
            var im = imgCache[old];
            if (im) { try { im.src = ''; } catch (e) { /* freed on GC */ } }
            delete imgCache[old];               // a still-visible one reloads
            return true;
        }
        return false;
    }
    /* filmstrip request point (both render paths): enforces the big-atlas
       session budget and the LRU bound. Returns the decoded Image, null =
       draw the static PNG instead (budget spent / still decoding). */
    function animAtlasFor(a, click) {
        var url = 'assets/city/' + a.png;
        if (!(url in imgCache)) {             // first request this session
            if (a.px > ANIM_MAX_ATLAS_PX ||
                (click && a.px > ANIM_BIG_ATLAS_PX)) {
                // oversize: only the click-driven paths (toggle machines
                // and tap one-shots) ever ask, so it rides the small
                // oversize session pool — recycled by freeHugeSlot(), not
                // the big-tier budget (which is for loops the map picked
                // on its own and is never released: the ziffcorp heli tap
                // at 15.7M sat just under MAX and starved there)
                if (!animHuge[url]) {
                    if (Object.keys(animHuge).length >= ANIM_HUGE_MAX &&
                        !freeHugeSlot()) return null;
                    animHuge[url] = a.png;
                }
            } else if (a.px > ANIM_BIG_ATLAS_PX) {
                if (animBigLive >= ANIM_BIG_MAX) return null;
                animBigLive++;
            }
            animLru.push(url);
            while (animLru.length > ANIM_CACHE_MAX) {
                var old = animLru.shift();    // oldest touched url dies first
                var im = imgCache[old];
                if (im) { try { im.src = ''; } catch (e) { /* freed on GC */ } }
                delete imgCache[old];         // a still-visible one reloads
                delete animHuge[old];         // frees its oversize-slot too
            }
        } else {                              // touch → most-recently-used
            var i = animLru.indexOf(url);
            if (i < 0) animLru.push(url);     // reloaded after an eviction
            else if (i < animLru.length - 1) {
                animLru.splice(i, 1);
                animLru.push(url);
            }
        }
        return imgFor(url);
    }
    window.__CV_ANIM_stats = function () {    // console/harness telemetry
        return { big: animBigLive, bigMax: ANIM_BIG_MAX,
                 lru: animLru.length, lruMax: ANIM_CACHE_MAX,
                 capPx: ANIM_MAX_ATLAS_PX, bigPx: ANIM_BIG_ATLAS_PX };
    };

    /* ---- art tune panel: pin-convention A/B without reloads ------------------
       The sprite ground point has several candidate conventions (anchor tile vs
       footprint origin; tile centre vs diamond corner; empirical S). The panel
       edits ART live (every change re-renders), persists the values in
       localStorage so a reload keeps your A/B, and steps the camera through
       the big-anchor-offset buildings — the instances where anchor-vs-origin
       disagrees most and the pin convention is easiest to judge. */
    (function buildTunePanel() {
        var p = $('arttune');
        if (!p || !document.createElement) return;
        var vals = {}, refs = [];
        function row(label) {
            var r = document.createElement('div');
            r.className = 'trow';
            var l = document.createElement('span');
            l.className = 'tlab';
            l.textContent = label;
            r.appendChild(l);
            p.appendChild(r);
            return r;
        }
        function btn(txt, fn, tip) {
            var b = document.createElement('button');
            b.className = 'tbtn';
            b.textContent = txt;
            if (tip) b.setAttribute('data-tip', tip);
            b.addEventListener('click', fn);
            return b;
        }
        function paint() {
            for (var i = 0; i < refs.length; i++)
                refs[i].classList.toggle('on', ART.ref === refs[i].textContent);
            vals.ax.textContent = ART.ax.toFixed(2);
            vals.ay.textContent = ART.ay.toFixed(2);
            vals.S.textContent = String(Math.round(ART.S));
            try {
                localStorage.setItem(TUNE_KEY, JSON.stringify(
                    { S: ART.S, ax: ART.ax, ay: ART.ay, ref: ART.ref }));
            } catch (e) { /* private mode */ }
            markDirty();
        }
        var rPin = row('pin');
        refs.push(btn('anchor', function () { ART.ref = 'anchor'; paint(); },
            'pin sprite anchor at the catalog anchor tile (px,py)'));
        refs.push(btn('origin', function () { ART.ref = 'origin'; paint(); },
            'pin sprite anchor at the footprint origin (catalog pos − loc + 1)'));
        rPin.appendChild(refs[0]); rPin.appendChild(refs[1]);
        function stepper(label, key, step, min) {
            var r = row(label);
            var v = document.createElement('span');
            v.className = 'tval';
            r.appendChild(btn('−', function () {
                ART[key] = Math.max(min, ART[key] - step); paint();
            }));
            r.appendChild(v);
            vals[key] = v;
            r.appendChild(btn('+', function () {
                ART[key] = ART[key] + step; paint();
            }));
        }
        stepper('ax', 'ax', 0.25, -4);
        stepper('ay', 'ay', 0.25, -4);
        stepper('S', 'S', 1, 8);
        /* candidate walkers: one instance per slug, each list isolates one
           degree of freedom of the pin convention */
        function bySlug(list) {
            var seen = {}, out = [];
            for (var i = 0; i < list.length; i++)
                if (!seen[list[i].slug]) { seen[list[i].slug] = 1; out.push(list[i]); }
            return out;
        }
        function makeWalker(label, tip, pick) {
            var r = row(label);
            r.className += ' wide';
            var st = { list: null, i: 0 };
            var b = btn('⏭ ' + label, function () {
                if (!st.list) st.list = pick();
                if (!st.list.length) { b.textContent = '⏭ none'; return; }
                var e = st.list[st.i % st.list.length];
                st.i++;
                centerOnTile((e.x0 + e.x1) / 2, (e.y0 + e.y1) / 2);
                if (cam.zoom < 1) cam.zoom = CAM.ZOOM.rest;
                setSel({ kind: 'b', i: e.mi });
                b.textContent = '⏭ ' + e.slug.slice(0, 16) + ' ' +
                    st.i + '/' + st.list.length;
                markDirty();
            }, tip);
            r.appendChild(b);
        }
        makeWalker('singles',
            'one instance of every 1x1 prop (pivot-centred art): the base corner must sit exactly on the wire\'s front ground edge — any residual offset is the tile-internal pin, dial ax/ay once against these',
            function () {
                return bySlug(buildings.filter(function (b) {
                    return b.slug && b.x1 - b.x0 === 1 && b.y1 - b.y0 === 1;
                }));
            });
        makeWalker('anchored',
            'one instance per slug of multi-tile buildings: judge the three visible base corners against the wire ground edges (the prism must sit under the art, not beside it)',
            function () {
                return bySlug(buildings.filter(function (b) {
                    return b.slug && (b.x1 - b.x0 > 1 || b.y1 - b.y0 > 1);
                }));
            });
        makeWalker('offsets',
            'one instance per slug of the widest footprints first: the diamond corners must match the sprite base at full size — if big buildings drift off the wire, S (art px per tile) is the knob to correct',
            function () {
                return bySlug(buildings.filter(function (b) {
                    return b.slug && (b.x1 - b.x0) + (b.y1 - b.y0) >= 8;
                }).sort(function (a, c) {
                    return ((c.x1 - c.x0) + (c.y1 - c.y0)) -
                        ((a.x1 - a.x0) + (a.y1 - a.y0));
                }));
            });
        row('reset').appendChild(btn('defaults', function () {
            ART.S = 64; ART.ax = 0; ART.ay = 0; ART.ref = 'anchor';
            paint();
        }, 'back to the shipped defaults'));
        paint();
    })();
    if ($('btn-tune')) $('btn-tune').addEventListener('click', function () {
        var p = $('arttune');
        if (!p) return;
        var show = p.style.display === 'none' || p.style.display === undefined;
        p.style.display = show ? '' : 'none';
        $('btn-tune').classList.toggle('on', show);
        if (show && !artMode) {          // tuning sprites you cannot see is no fun
            artMode = 1;
            try { localStorage.setItem(ART_KEY, '1'); } catch (e) { /* private mode */ }
            applyArtMode();
        }
        markDirty();
    });

    /* ---- orientation rig (manual pin — notes/06 §9/§10) ---------------------
       CAM.ORIENT {fx, fy, swap} has 8 states (dihedral group of the tile
       square). The Rotate-90° and Mirror buttons cycle them live; the
       readout in the toolbar shows the exact triple so it can be pasted
       back into the repo. Persisted in localStorage so a reload keeps
       your rig; camera.js ships the registered default. */
    /* Speckle filter (notes/01 "Filler grids"): hides the engine-
       generated filler in the terrain grids — the whole SAND lattice,
       the park-path/KLSROAD single-tile layers, and road dashes not
       anchored to a 'P' full-segment. Ships ON; exposed as a legend
       row (buildLegend) so the before/after A/B is one click away, and
       persisted so a reload keeps your choice. */
    var SPECK_KEY = 'mrsnrub.cityview.speckle';
    var speckOn = true;
    try { speckOn = localStorage.getItem(SPECK_KEY) !== '0'; } catch (e) { /* private mode */ }

    /* Road network model A/B (js/terrain.js Terrain#roadNetwork): read
       ROADS as an orthogonal 4-connected network — speckle anchoring
       without diagonal edges + solid 'P' plazas painted flat full-
       asphalt. Ships OFF; toolbar button next to the road-art cycle,
       persisted so the comparison survives reload. Plaza art only
       shows with sheet art on (Road art·edges). */
    var ROADNET_KEY = 'mrsnrub.cityview.roadnet';
    var roadNetOn = false;
    try { roadNetOn = localStorage.getItem(ROADNET_KEY) === '1'; } catch (e) { /* private mode */ }

    /* Walk paths overlay (notes/06 "Walk-path oracle"): draws the save's
       cached characterData.pathCache polylines — the client's own walks,
       ~90% of which ride the UNSAVED template street grid — plus amber
       bands for the candidate street lines the census distils from them
       (columns x≡3 mod 4, rows y≡0 mod 4 in grid coords). Debug view,
       ships OFF; toggled from the object legend. */
    var WALK_KEY = 'mrsnrub.cityview.walks';
    var walksOn = false;
    try { walksOn = localStorage.getItem(WALK_KEY) === '1'; } catch (e) { /* private mode */ }

    /* Pasted-coordinate markers (js/markers.js). The objects legend
       (bottom-right) carries a textarea; every "(x,y)" / "x,y" pair typed
       or pasted into it is drawn as a yellow tile diamond, so evidence
       coordinates from the notes/01 censuses — the five surviving
       riversData cells, candidate street tiles, etc. — can be checked
       against the map in context. Town tiles, matching the tile-grid
       hover readout; the value persists across reloads. */
    var MARKER_KEY = 'mrsnrub.cityview.markers';
    /* First-visit seed = the five saved river cells in the OlmecHead/
       Falls window that survived the speckle census (notes/01
       "riversData is building-adjacent scatter") — the plausible player
       RiverDrawing tiles, marked so they can be eye-checked against the
       live map. Any edit replaces it: the textarea's raw text persists
       under MARKER_KEY from then on. */
    var MARKER_SEED = '';   // no default marks (2026-10-20: user request);
                            // the persisted textarea value still wins
    var markerText = MARKER_SEED;
    try {
        var mt = localStorage.getItem(MARKER_KEY);
        if (mt !== null) markerText = mt;
    } catch (e) { /* private mode */ }
    var markerPts = (typeof CityMarkers !== 'undefined')
        ? CityMarkers.parse(markerText) : [];

    var ORIENT_KEY = 'mrsnrub.cityview.orient';
    (function loadOrient() {           // must run BEFORE terrain/buildings
        try {
            var so = JSON.parse(localStorage.getItem(ORIENT_KEY));
            if (so && (so.fx === 1 || so.fx === -1) && (so.fy === 1 || so.fy === -1) &&
                (so.swap === 0 || so.swap === 1)) CAM.ORIENT = so;
        } catch (e) { /* defaults */ }
    })();

    terrain = new CityTerrain(M, { speckleFilter: speckOn, roadNetwork: roadNetOn });
    if (grassImg) terrain.grassImg = grassImg;
    applyRoadSheet();

    /* per-layer tile counts for the terrain details card (data-invariant,
       so computed once from the boot instance) */
    var terrainCounts = {};
    (function () {
        var f = terrain.features, TO = CityTerrain.TYPE_ORDER;
        for (var i = 0; i < f.length; i++) {
            var n = TO[f[i][2]];
            terrainCounts[n] = (terrainCounts[n] || 0) + 1;
        }
    })();

    /* candidate street census from the cached walk paths (data-invariant:
       uses _roadOccAll, the RAW saved roads). null when the save carries
       no paths. CityWalks = js/walks.js. */
    var walkCensus = (M.walks && M.walks.length && typeof CityWalks !== 'undefined')
        ? CityWalks.census(M.walks, terrain._roadOccAll, M.ox, M.oy)
        : null;

    /* ---- camera + presets --------------------------------------------------- */
    var DT = M.downtown[0];                 // [x0,x1,y0,y1] town tiles
    var TOWN = {                            // full extent of the terrain data
        // town = grid - (ox, oy), so the grid's top/left edges sit at
        // NEGATIVE town coords; the sea polygon sits WEST of grid x 0
        // (Terrain#seaFillX0) — include it so whole-town presets show
        // the water instead of clipping it.
        x0: -64 - M.ox, y0: -M.oy, x1: 512 - M.ox, y1: 1087 - M.oy
    };
    var cam = CAM.createCamera({ zoom: CAM.ZOOM.rest });
    window.__CV_cam = cam;               // console/harness: steer the view directly

    function centerOnTile(tx, ty) {
        var w = CAM.tileToWorld(tx, ty);
        cam.x = w.x; cam.y = w.y; cam.vx = 0; cam.vy = 0;
    }
    function presetRest() {                 // close mid-zoom, downtown centre
        cam.zoom = CAM.ZOOM.rest;
        centerOnTile((DT[0] + DT[1]) / 2, (DT[2] + DT[3]) / 2);
    }
    function presetDowntown() {
        CAM.fitTileRect(cam, { x0: DT[0], y0: DT[2], x1: DT[1], y1: DT[3] }, VW, VH);
    }
    function presetFull() {
        CAM.fitTileRect(cam, TOWN, VW, VH);
    }
    /* Ocean reference preset: frames the save's ocean layer (grid rows
       2–26 → town y ≈ −134…−110) so the blue tiles can be used as the
       orientation landmark (notes/06 §9 ocean anchor). */
    function presetOcean() {
        var OCEAN_BB = terrain.typeBBox[0];    // terrain TYPE_IDX.ocean = 0
        if (!OCEAN_BB) return;
        CAM.fitTileRect(cam, {
            x0: OCEAN_BB.x0 - 8, y0: OCEAN_BB.y0 - 8,
            x1: OCEAN_BB.x1 + 8, y1: OCEAN_BB.y1 + 8
        }, VW, VH);
    }

    /* Springfield Downs opening preset: frames the save's capital
       landmark (catalog id 20, "SpringfieldDowns", one instance). The
       view opens zoomed in on its drawn footprint with a small context
       margin instead of the downtown fit. The instance is looked up by
       catalog name so no tile coordinates are hard-coded; falls back to
       the downtown fit when the save carries no instance. */
    function presetSpringfield() {
        for (var i = 0; i < buildings.length; i++) {
            var e = M.binfo[buildings[i].id];
            if (e && e[0] === 'SpringfieldDowns') {
                var b = buildings[i];
                CAM.fitTileRect(cam, {
                    x0: b.x0 - 6, y0: b.y0 - 6, x1: b.x1 + 6, y1: b.y1 + 6
                }, VW, VH);
                return;
            }
        }
        presetDowntown();
    }

    var lastPreset = null;              // re-applied after an orientation change

    /* ---- buildings (raised blocks), precomputed + depth-sorted -------------- */
    var pal = M.pal;
    /* building height (save "height") -> world-y units. Knob: the save height
       is a story count (e.g. 3.5); tune via the screenshot backlog. */
    var HEIGHT_SCALE = 0.5;
    function shade(c, f) {
        return 'rgb(' + Math.min(255, c[0] * f | 0) + ',' +
            Math.min(255, c[1] * f | 0) + ',' + Math.min(255, c[2] * f | 0) + ')';
    }
    var buildings = [];
    var byMi = [];                      // M.buildings index -> drawn block
    var catOfMi = [];                   // M.buildings index -> object bucket
    function buildBuildings() {         // re-run after an ORIENT change (depth keys)
        buildings = [];
        bAtlas = null;                  // flat-LOD atlas stale (rebuilt lazily)
        for (var i = 0; i < M.buildings.length; i++) {
            var b = M.buildings[i];
            var info = M.binfo[b[0]];
            var hgt = info ? (info[7] || 3) : 3;
            var px = b[6], py = b[7];           // ground pivot tile corner (RE-pinned)
            /* Art-pinned footprint (notes/06 sprite placement RE): the sprite's
               ground pivot is the tile corner (posX,posY) = the diamond's
               screen-FRONT corner (min x, max y), so the prism / wire /
               hit-test rect is [px .. px+w] x [py-d .. py]. The old catalog
               rule (px-locX+1 ...) tracked the engine's occupancy grid, not
               the art base, leaving blocks, wire and the click outline off
               the drawn sprite by (locX-1, locY-1+d) tiles. */
            var front = CAM.oriented(px, py);   // true screen-front corner (x0,y1)
            var col = pal[b[0] % pal.length];
            var blk = {
                mi: i,                          // index into M.buildings (details)
                id: b[0],
                x0: px, y0: py - b[4], x1: px + b[3], y1: py,
                hgt: hgt * HEIGHT_SCALE,
                col: col,
                /* face fill styles precomputed: shade() built three rgb()
                   strings per block PER FRAME (15k string allocations at
                   whole-town zoom). The palette is fixed, so bake them. */
                fR: shade(col, 1.0),
                fL: shade(col, 0.62),
                fT: shade(col, 1.28),
                /* numeric premultiplied-ready face colours for the GL
                   prism pass (0..255 triples, /255 at vertex build) */
                cR: col,
                cL: [col[0] * 0.62 | 0, col[1] * 0.62 | 0, col[2] * 0.62 | 0],
                cT: [Math.min(255, col[0] * 1.28 | 0),
                     Math.min(255, col[1] * 1.28 | 0),
                     Math.min(255, col[2] * 1.28 | 0)],
                cat: CityObjects.classify(info ? info[0] : ''),   // object legend
                slug: (b[8] || (info ? (info[2] || '') : '')),    // sprite key
                flip: b[8] ? 0 : b[5], px: b[6], py: b[7],        // sprite anchor
                depth: front[0] + front[1],               // front corner, oriented
                ox1: front[0]                             // oriented tie-break
            };
            buildings.push(blk);
            byMi[i] = blk;
            catOfMi[i] = blk.cat;
        }
        buildings.sort(function (a, b) { return a.depth - b.depth || a.ox1 - b.ox1; });
    }
    buildBuildings();

    /* screen-space quads of one block (shared by drawBlock, hitTest and the
       selection/search outlines so all three agree on the silhouette).
       The roof is the ground footprint shifted up by hgt*scale — project
       the four ground corners ONCE and derive the roof points (was eight
       full tileToWorld+worldToScreen calls per block per frame). */
    function blockPolys(b) {
        var h = b.hgt * CAM.scale(cam);
        function g(x, y) { var w = CAM.tileToWorld(x, y); return CAM.worldToScreen(cam, w.x, w.y, VW, VH); }
        var g00 = g(b.x0, b.y0), g10 = g(b.x1, b.y0),
            g11 = g(b.x1, b.y1), g01 = g(b.x0, b.y1);
        function up(p) { return { x: p.x, y: p.y - h }; }
        var r00 = up(g00), r10 = up(g10), r11 = up(g11), r01 = up(g01);
        return {
            // visible faces: right (+x, lit), left (+y, shadow), top
            right: [r10, r11, g11, g10],
            left: [r11, r01, g01, g11],
            top: [r00, r10, r11, r01]
        };
    }

    /* screen centre + radius of one character dot (mirrors CityObjects.drawPeople).
       M.chars rows carry the save's exact float positions (tile units). */
    function charScreen(c) {
        var w = CAM.tileToWorld(c[1], c[2]);
        var p = CAM.worldToScreen(cam, w.x, w.y, VW, VH);
        p.r = Math.max(1.6, CityObjects.PEOPLE_R * Math.min(2.2, CAM.scale(cam) / 40));
        return p;
    }

    function drawBlock(b, T) {
        if (b.x1 < T.x0 - 2 || b.x0 > T.x1 + 2 || b.y1 < T.y0 - 2 || b.y0 > T.y1 + 2)
            return;
        function poly(pts, fill) {
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            for (var k = 1; k < 4; k++) ctx.lineTo(pts[k].x, pts[k].y);
            ctx.closePath();
            ctx.fillStyle = fill;
            ctx.fill();
        }
        var q = blockPolys(b);
        poly(q.right, b.fR);
        poly(q.left, b.fL);
        poly(q.top, b.fT);
    }

    /* ---- building LOD (zoomed-out orbit) ------------------------------------
       Below s = 2 px/unit (the same threshold where terrain enters its
       fixed-diamond tiny mode — whole-town presets sit near s ≈ 0.6) a
       block is a pile of sub-pixel fills: extrusions <= ~5 px, three
       polygons apiece for 5.3k blocks. Draw ONE flat footprint diamond
       per block through the tile->screen affine, batched per face style,
       so the whole town costs ~10 fills instead of ~16k. Painter order
       across colors is not preserved; at sub-pixel tile size the
       overlap it used to resolve was invisible anyway. Wire/sprites are
       meaningless below this scale and ride along. */
    var BUILD_LOD_S = 2;
    /* The flat footprints are static in TILE space too (faces are
       axis-aligned rects there; the oblique diamond shape comes from the
       frame's affine, not the geometry), so bake them once into one
       offscreen canvas per object bucket and blit per frame like the
       terrain atlas — pan at orbit zoom = ~15 GPU blits total. One canvas
       per bucket so the object-legend toggles just skip a blit; painter
       order is baked from the depth-sorted list. Rebuilt when the blocks
       change (orientation rig) or buckets toggle. */
    var BAtlasTS = 2;
    var bAtlas = null;
    function buildBuildAtlas() {
        if (bAtlas) return bAtlas;
        if (!buildings.length || typeof document === 'undefined' ||
            !document.createElement) return null;
        var i, b, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (i = 0; i < buildings.length; i++) {
            b = buildings[i];
            if (b.x0 < x0) x0 = b.x0;
            if (b.y0 < y0) y0 = b.y0;
            if (b.x1 > x1) x1 = b.x1;
            if (b.y1 > y1) y1 = b.y1;
        }
        x0 -= 1; y0 -= 1; x1 += 1; y1 += 1;
        var k = BAtlasTS, bleed = 0.5,
            W = Math.max(1, Math.ceil((x1 - x0) * k)),
            H = Math.max(1, Math.ceil((y1 - y0) * k));
        if (W * H > 40e6) return null;                  // sanity
        var byCat = {}, cats = [];
        for (i = 0; i < buildings.length; i++) {        // depth-sorted already
            b = buildings[i];
            var rec = byCat[b.cat];
            if (!rec) {
                rec = byCat[b.cat] = document.createElement('canvas');
                rec.width = W; rec.height = H;
                rec._c = rec.getContext('2d');
                cats.push(b.cat);
            }
            rec._c.fillStyle = b.fT;
            rec._c.fillRect((b.x0 - x0) * k - bleed, (b.y0 - y0) * k - bleed,
                (b.x1 - b.x0) * k + bleed * 2, (b.y1 - b.y0) * k + bleed * 2);
        }
        bAtlas = { x0: x0, y0: y0, W: W, H: H, byCat: byCat, cats: cats,
                   flat: null, flatSig: null };
        return bAtlas;
    }
    /* flattened + visibility-resolved building bitmap, shared by the 2D
       LOD blit and the WebGL base layer; rebuilt only when the object
       legend toggles a bucket */
    function buildBuildFlat() {
        var at = buildBuildAtlas();
        if (!at) return null;
        var sig = '', ci;
        for (ci = 0; ci < at.cats.length; ci++)
            sig += at.cats[ci] + (objHidden[at.cats[ci]] ? '1' : '0') + ';';
        if (!at.flat || at.flatSig !== sig) {
            if (typeof document === 'undefined' || !document.createElement)
                return null;
            var flat = document.createElement('canvas');
            flat.width = at.W; flat.height = at.H;
            var fc = flat.getContext('2d');
            for (ci = 0; ci < at.cats.length; ci++)
                if (!objHidden[at.cats[ci]])
                    fc.drawImage(at.byCat[at.cats[ci]], 0, 0);
            at.flat = flat; at.flatSig = sig;
        }
        return { img: at.flat, x0: at.x0, y0: at.y0, W: at.W, H: at.H,
                 ts: BAtlasTS };
    }
    function drawBlocksFlat(T, d) {
        var A = CAM.tileAffine(cam, VW, VH);
        var f = buildBuildFlat();
        if (f) {
            var k = f.ts;
            d = d || dpr || 1;
            var tcx = A.c + A.a * f.x0 + A.b * f.y0,
                tcy = A.f + A.d * f.x0 + A.e * f.y0;
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'low';    // fast minify path (ignored where unsupported)
            ctx.save();
            ctx.setTransform(d * A.a / k, d * A.d / k, d * A.b / k, d * A.e / k,
                d * tcx, d * tcy);
            ctx.drawImage(f.img, 0, 0, f.W, f.H, 0, 0, f.W, f.H);
            ctx.restore();
            return;
        }
        /* fallback (no canvas): flat footprint diamonds batched per face style */
        var buckets = {}, order = [];
        for (var i = 0; i < buildings.length; i++) {
            var b = buildings[i];
            if (objHidden[b.cat]) continue;
            if (b.x1 < T.x0 - 2 || b.x0 > T.x1 + 2 || b.y1 < T.y0 - 2 || b.y0 > T.y1 + 2)
                continue;
            var arr = buckets[b.fT];
            if (!arr) { arr = buckets[b.fT] = []; order.push(b.fT); }
            var x0 = b.x0, y0 = b.y0, x1 = b.x1, y1 = b.y1;
            arr.push(
                A.a * x0 + A.b * y0 + A.c, A.d * x0 + A.e * y0 + A.f,
                A.a * x1 + A.b * y0 + A.c, A.d * x1 + A.e * y0 + A.f,
                A.a * x1 + A.b * y1 + A.c, A.d * x1 + A.e * y1 + A.f,
                A.a * x0 + A.b * y1 + A.c, A.d * x0 + A.e * y1 + A.f);
        }
        for (var j = 0; j < order.length; j++) {
            var bk = buckets[order[j]];
            ctx.beginPath();
            for (var k = 0; k < bk.length; k += 8) {
                ctx.moveTo(bk[k], bk[k + 1]);
                ctx.lineTo(bk[k + 2], bk[k + 3]);
                ctx.lineTo(bk[k + 4], bk[k + 5]);
                ctx.lineTo(bk[k + 6], bk[k + 7]);
                ctx.closePath();
            }
            ctx.fillStyle = order[j];
            ctx.fill();
        }
    }

    /* all 12 edges of one block's prism (Wire toggle). The four ground
       edges are cyan (they are what sprite bases should sit on); top rim
       and verticals white, so hidden west/north base edges stay visible
       through the solid faces and sprites. */
    function drawWireBox(b, T) {
        if (b.x1 < T.x0 - 2 || b.x0 > T.x1 + 2 || b.y1 < T.y0 - 2 || b.y0 > T.y1 + 2)
            return;
        var s = CAM.scale(cam);
        function gp(x, y) { var w = CAM.tileToWorld(x, y); return CAM.worldToScreen(cam, w.x, w.y, VW, VH); }
        function rp(x, y) { var p = gp(x, y); p.y -= b.hgt * s; return p; }
        var g = [gp(b.x0, b.y0), gp(b.x1, b.y0), gp(b.x1, b.y1), gp(b.x0, b.y1)];
        var t = [rp(b.x0, b.y0), rp(b.x1, b.y0), rp(b.x1, b.y1), rp(b.x0, b.y1)];
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(0,229,255,0.9)';          // ground edges: what bases sit on
        ctx.beginPath();
        ctx.moveTo(g[0].x, g[0].y); ctx.lineTo(g[1].x, g[1].y);
        ctx.lineTo(g[2].x, g[2].y); ctx.lineTo(g[3].x, g[3].y);
        ctx.closePath();
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';       // top rim
        ctx.beginPath();
        ctx.moveTo(t[0].x, t[0].y); ctx.lineTo(t[1].x, t[1].y);
        ctx.lineTo(t[2].x, t[2].y); ctx.lineTo(t[3].x, t[3].y);
        ctx.closePath();
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.beginPath();
        for (var i = 0; i < 4; i++) { ctx.moveTo(g[i].x, g[i].y); ctx.lineTo(t[i].x, t[i].y); }
        ctx.stroke();
    }

    /* one building as its city sprite (M4 items 4/5); returns false when
       the block should be drawn instead (manifest missing, no asset for
       this slug, or the PNG has not decoded yet — then again once it does,
       imgFor's onload marks the scene dirty and it swaps in) */
    function drawSprite(b, T) {
        if (!citySprites || !b.slug) return false;
        if (b.x1 < T.x0 - 6 || b.x0 > T.x1 + 6 || b.y1 < T.y0 - 6 || b.y0 > T.y1 + 6)
            return true;                        // off-screen: nothing to draw
        var key = (b.flip && citySprites[b.slug + 'flipped'])
            ? b.slug + 'flipped' : b.slug;
        var sp = spriteEntry(key);
        if (!sp) return false;
        var k = CAM.scale(cam) / ART.S;         // screen px per art px
        /* sprite LOD: a full-size PNG minified below ~12 screen px in
           BOTH dimensions is an unreadable blur — and the most expensive
           raster work on the page (5k bilinear downscales per pan frame
           when zoomed out with Art on). Fall back to the block path and
           skip the PNG decode entirely. Blocks carry the footprint +
           colour at that scale; art appears once it can actually be read. */
        if (sp.w * k < 12 && sp.h * k < 12) return false;
        var im = imgFor('assets/city/' + sp.png);
        if (!im) return false;
        var gx = ART.ref === 'origin' ? b.x0 : b.px;
        var gy = ART.ref === 'origin' ? b.y0 : b.py;
        var w = CAM.tileToWorld(gx + ART.ax, gy + ART.ay);
        var p = CAM.worldToScreen(cam, w.x, w.y, VW, VH);
        var an = animOf(b, k);            // filmstrip cells instead of the PNG?
        if (an) {
            var drew = 0, i, j, ok = 1;
            // a layer cell may legitimately be as big as the body it hides
            // (EscalatorToNowhere's front panel), so layered assets get a
            // body-relative cap; single-cell loops keep the plain one.
            var cap = an.base ? Math.max(4096, Math.max(sp.w, sp.h) * k) : 2048;
            for (i = 0; i < an.cells.length; i++) {
                var c0 = an.cells[i], st = c0.a;
                if (!animAtlasFor(st, c0.tap) ||
                    Math.max(st.cellw, st.cellh) * k > cap) {
                    if (an.base) ok = 0;  // stack must draw whole, or not
                }                         // at all: keep the plain body
            }
            if (ok) {
                if (an.base) {            // multi-part body: PNG under the cells
                    ctx.drawImage(im, p.x - sp.anchor[0] * k, p.y - sp.anchor[1] * k,
                                  sp.w * k, sp.h * k);
                    drew = 1;
                }
                for (i = 0; i < an.cells.length; i++) {
                    var c = an.cells[i], a = c.a, fi = c.fi;
                    var aim = animAtlasFor(a, c.tap);  // null = decoding/big budget spent
                    if (!aim) continue;
                    if (a.sub) {                  // sparse strip: blit its rects
                        var rs = a.sub[fi] || [];
                        for (j = 0; j < rs.length; j++) {
                            var r = rs[j], rw = r.w * k, rh = r.h * k;
                            var rx = p.x + r.ox * k, ry = p.y + r.oy * k;
                            if (rx + rw < -4 || rx > VW + 4 ||
                                ry + rh < -4 || ry > VH + 4) continue;
                            ctx.drawImage(aim, r.sx, r.sy, r.w, r.h,
                                          rx, ry, rw, rh);
                            drew++;
                        }
                        continue;
                    }
                    var aw = a.cellw * k, ah = a.cellh * k;
                    var ax0 = p.x - a.ax * k, ay0 = p.y - a.ay * k;
                    if (ax0 + aw < -4 || ax0 > VW + 4 || ay0 + ah < -4 || ay0 > VH + 4)
                        continue;         // truly off-screen: skip
                    ctx.drawImage(aim, (fi % a.cols) * a.cellw,
                                  Math.floor(fi / a.cols) * a.cellh,
                                  a.cellw, a.cellh, ax0, ay0, aw, ah);
                    drew++;
                }
            }
            if (drew) { animLive++; if (!an.tap) animBudget--; return true; }
            // nothing blitted (decoding / off-screen / stack rejected):
            // fall through to the static PNG
        }
        ctx.drawImage(im, p.x - sp.anchor[0] * k, p.y - sp.anchor[1] * k,
                      sp.w * k, sp.h * k);
        return true;
    }

    /* ---- character idle loops (M4 item 5, 2026-10-23; timing corrected
       2026-10-27) ------------------------------------------------------------
       characters.json v3 (gen_city_sprites.py chars) picks animated
       <name>idleblink-style cells. Like the original client, each cell is
       ONE play of the animation (its per-frame delay_ms cover that single
       pass — see notes/01 and the binary's timeBetweenAnimsMin/Max idle
       triggers), so here it plays once and the character then HOLDS the
       standby frame fr[0] through a randomised per-character gap; looping
       the cell end-to-end made a 208 ms blink replay ~5x/second. The
       per-character phase/gap is a stable hash of the save id, so the
       crowd does not blink in lockstep. Loops obey both toggles (Art
       + Anim) and a legibility floor — a blink is subtle pixels, wasted
       below ~24 px (knob: ?charAnimMinPx=N). charAnimLive counts looping
       characters in the last frame and drives repaint scheduling. */
    function charFrameFile(as, id, k) {
        var fr = as.frames;
        if (!fr || !fr.length) return as.png;
        if (fr.length < 2 || !animOn || !artMode ||
            Math.max(as.w, as.h) * k < CHAR_ANIM_MIN_PX) return fr[0].file;
        if (as._tot === undefined) {
            var tot = 0, i;
            for (i = 0; i < fr.length; i++) tot += fr[i].delay || 100;
            as._tot = tot || 1;
        }
        var h = 0, s = String(id), i;
        for (i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
        h = Math.abs(h);
        var gap = 2000 + (h >>> 4) % 5000 + (as._tot > 1200 ? as._tot : 0);
        var t = ((animNow || performance.now()) + h) % (as._tot + gap);
        if (t >= as._tot) return fr[0].file;    // standby between plays
        for (i = 0; i < fr.length; i++) {
            t -= (fr[i].delay || 100);
            if (t < 0) return fr[i].file;
        }
        return fr[fr.length - 1].file;
    }
    function charAnimating(as, k) {
        return !!(as.frames && as.frames.length > 1 && animOn && artMode &&
                  Math.max(as.w, as.h) * k >= CHAR_ANIM_MIN_PX);
    }

    /* people as .bcell idle poses; characters without a rendered asset
       fall back to the yellow dots (same culling/radius as before) */
    function drawPeopleArt(ctx, chars, cam, T) {
        var fallback = null, k = CAM.scale(cam) / ART.S;
        for (var i = 0; i < chars.length; i++) {
            var c = chars[i];
            if (c[1] < T.x0 - 1 || c[1] > T.x1 + 1 || c[2] < T.y0 - 1 || c[2] > T.y1 + 1)
                continue;
            var a = null;
            if (charMan) {
                var rec = charMan.characters[c[0]];
                a = rec && charMan.assets[rec.slug];
            }
            /* same sprite LOD as building billboards: too small to read
               -> batched fallback dot, and skip the PNG decode entirely */
            if (!a || (a.w * k < 12 && a.h * k < 12)) {
                if (!fallback) fallback = [];
                fallback.push(c);
                continue;
            }
            var im = imgFor('assets/characters/' + charFrameFile(a, c[0], k));
            if (charAnimating(a, k)) charAnimLive++;
            if (!im) {
                if (!fallback) fallback = [];
                fallback.push(c);
                continue;
            }
            var w = CAM.tileToWorld(c[1], c[2]);
            var p = CAM.worldToScreen(cam, w.x, w.y, VW, VH);
            ctx.drawImage(im, p.x - a.anchor[0] * k, p.y - a.anchor[1] * k,
                          a.w * k, a.h * k);
        }
        if (fallback)
            CityObjects.drawPeople(ctx, CAM, fallback, M.charcol, cam, VW, VH, T);
    }

    /* people are drawn via CityObjects.drawPeople (see objects.js) */

    /* ---- tile grid overlay (debug): the sprite-alignment yardstick ---------
       Draws the tile lattice over the scene (majors every 10) plus a
       highlighted diamond on the tile under the cursor, so sprite anchor
       offsets can be read off directly against the tile the clickable
       entity occupies. Persisted like the other view toggles. */
    var GRID_KEY = 'mrsnrub.cityview.grid';
    var gridOn = false;
    var hoverTile = null;                 // [tx, ty] under the cursor (grid on only)
    function applyGridMode() {
        var b = $('btn-grid');
        if (b) b.classList.toggle('on', gridOn);
    }
    (function loadGrid() {
        try { gridOn = localStorage.getItem(GRID_KEY) === '1'; } catch (e) { /* private mode */ }
        applyGridMode();
    })();
    if ($('btn-grid')) $('btn-grid').addEventListener('click', function () {
        gridOn = !gridOn;
        if (!gridOn) hoverTile = null;
        try { localStorage.setItem(GRID_KEY, gridOn ? '1' : '0'); } catch (e) { /* private mode */ }
        applyGridMode();
        markDirty();
    });

    /* ---- building wireframe (debug): the full bounding box -------------------
       drawBlock only fills the three visible faces, so the base edges on the
       far (west/north) sides never appear — unusable for checking whether a
       sprite sits on its footprint. Wire draws all 12 prism edges, the four
       ground edges highlighted in cyan, over blocks and sprites alike. */
    var WIRE_KEY = 'mrsnrub.cityview.wire';
    var wireOn = false;
    function applyWireMode() {
        var b = $('btn-wire');
        if (b) b.classList.toggle('on', wireOn);
    }
    (function loadWire() {
        try { wireOn = localStorage.getItem(WIRE_KEY) === '1'; } catch (e) { /* private mode */ }
        applyWireMode();
    })();
    if ($('btn-wire')) $('btn-wire').addEventListener('click', function () {
        wireOn = !wireOn;
        try { localStorage.setItem(WIRE_KEY, wireOn ? '1' : '0'); } catch (e) { /* private mode */ }
        applyWireMode();
        markDirty();
    });

    function drawGrid(cam, T) {
        var s = CAM.scale(cam);
        if (s < 0.6) return;                          // sub-pixel lattice: nothing to see
        var x0 = Math.floor(T.x0) - 1, x1 = Math.ceil(T.x1) + 2;
        var y0 = Math.floor(T.y0) - 1, y1 = Math.ceil(T.y1) + 2;
        var minors = s >= 12;                         // below that, majors only
        function g(x, y) { var w = CAM.tileToWorld(x, y); return CAM.worldToScreen(cam, w.x, w.y, VW, VH); }
        function line(xa, ya, xb, yb, col) {
            var a = g(xa, ya), b = g(xb, yb);
            ctx.strokeStyle = col;
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
        ctx.save();
        ctx.lineWidth = 1;
        var x, y, major;
        for (x = x0; x <= x1; x++) {
            major = ((x % 10) + 10) % 10 === 0;
            if (!major && !minors) continue;
            line(x, y0, x, y1, major ? 'rgba(0,229,255,0.75)' : 'rgba(0,229,255,0.28)');
        }
        for (y = y0; y <= y1; y++) {
            major = ((y % 10) + 10) % 10 === 0;
            if (!major && !minors) continue;
            line(x0, y, x1, y, major ? 'rgba(0,229,255,0.75)' : 'rgba(0,229,255,0.28)');
        }
        if (s >= 40) {                                // major-line numbering
            ctx.font = '10px monospace';
            ctx.fillStyle = 'rgba(0,229,255,0.9)';
            for (x = x0; x <= x1; x++)
                if (((x % 10) + 10) % 10 === 0) { var p = g(x, y0); ctx.fillText(String(x), p.x + 2, p.y - 2); }
            for (y = y0; y <= y1; y++)
                if (((y % 10) + 10) % 10 === 0) { var q = g(x0, y); ctx.fillText(String(y), q.x + 2, q.y - 2); }
        }
        if (hoverTile) {                              // cursor tile diamond
            var c0 = g(hoverTile[0], hoverTile[1]), c1 = g(hoverTile[0] + 1, hoverTile[1]),
                c2 = g(hoverTile[0] + 1, hoverTile[1] + 1), c3 = g(hoverTile[0], hoverTile[1] + 1);
            ctx.beginPath();
            ctx.moveTo(c0.x, c0.y); ctx.lineTo(c1.x, c1.y);
            ctx.lineTo(c2.x, c2.y); ctx.lineTo(c3.x, c3.y);
            ctx.closePath();
            ctx.fillStyle = 'rgba(0,229,255,0.22)';
            ctx.strokeStyle = 'rgba(0,229,255,0.95)';
            ctx.lineWidth = 1.5;
            ctx.fill(); ctx.stroke();
        }
        ctx.restore();
    }

    /* cursor tile readout for the grid (separate listener: the pan handler
       below early-returns unless the pointer is down) */
    stage.addEventListener('pointermove', function (e) {
        if (!gridOn) return;
        var r = stage.getBoundingClientRect();
        var wpt = CAM.screenToWorld(cam, e.clientX - r.left, e.clientY - r.top, VW, VH);
        var tp = CAM.worldToTile(wpt.x, wpt.y);
        var nx = Math.floor(tp.x), ny = Math.floor(tp.y);
        if (!hoverTile || hoverTile[0] !== nx || hoverTile[1] !== ny) {
            hoverTile = [nx, ny]; markDirty();
        }
    });
    stage.addEventListener('pointerleave', function () {
        if (hoverTile) { hoverTile = null; markDirty(); }
    });

    /* ---- render ------------------------------------------------------------- */
    var needsRender = true;
    function markDirty() { needsRender = true; }

    /* per-bucket visibility (object legend); see CityObjects.classify */
    var objHidden = {};

    /* ---- WebGL base layer (hybrid renderer, 2026-10-20.4) --------------------
       In the LOD (zoomed-out) regime the 2D canvas above draws only the
       overlays; the base — grass tile, sea, the two flattened atlases and
       the people dots — goes to #glcv behind it through CityGL: a pan
       frame becomes one uniform update + ~5 textured-quad draws with no
       path/pattern recording and no translucent full-frame blit stacking
       (Canvas2D's structural costs even when GPU-backed). Any missing
       capability (no WebGL, no atlas canvas) or a failed draw keeps the
       proven Canvas2D base path — glR simply goes null. */
    var glR = (function () {
        try {
            if (QP.get('nogl')) return null;
            return (typeof CityGL !== 'undefined' && $('glcv'))
                ? CityGL.create($('glcv')) : null;
        } catch (e) { return null; }
    })();
    try {                       // one line of truth for "is GL actually on"
        console.info('[city-view] base layer: ' +
            (glR ? 'WebGL' : 'Canvas2D — ' +
                (window.CityGL ? CityGL.lastError() : 'no CityGL script')));
    } catch (e) { /* no console */ }

    /* ---- classic-band GL buildings + sprites (2026-10-20.7, sprites .10) -----
       "Zoomed out" as a user experiences it (whole town on screen, s ≈ 2–8)
       never reaches the s<2 flat-atlas LOD, so the classic loop pays
       ~5.3k buildings × 3 Canvas2D fills (or one big bilinear drawImage in
       Art mode) per pan frame. In GL the same depth-sorted scene is ONE
       draw call: each block emits either three flat-coloured prism quads
       or one sprite billboard quad, all in the same vertex stream, so a
       nearer prism keeps painting over a farther building's sprite exactly
       as in 2D. Sprites come from a lazily packed GPU atlas (agl below);
       the 2D sprite path stays only where the scan in glBuildBlock says
       the atlas could not paint a sprite sharp (or the view is deep enough
       that 2D is cheap and native PNG detail is the point). Dots
       draw after the quads, matching the 2D stacking. The GL canvas raises
       above the 2D canvas for these frames, so only CLEAN views take this
       path — wireframe, grid, walks, tile markers, search matches and the
       selection outline all paint 2D on top of buildings and keep the
       Canvas2D loop (debug tooling, cost secondary). */
    var bq = new Float32Array(0);         // quad vertex scratch (8 floats/vertex)
    var dxy = new Float32Array(0);        // people dot centres scratch
    var peopleDots = 0;                   // chars left as dots last frame
    var gbFrames = 0;                     // frames since... (atlas re-pack cadence)
    var aglBudget = 0;                    // new atlas packs allowed this frame
    function pushQuadC(a, n, x0, y0, x1, y1, x2, y2, x3, y3, c, u, v) {
        /* flat-coloured prism face: samples the atlas' white cell so the
           solid pass' single texture binding stays valid; 6 verts = 2 tris */
        var cr = c[0] / 255, cg = c[1] / 255, cb = c[2] / 255;
        a[n] = x0; a[n + 1] = y0; a[n + 2] = u; a[n + 3] = v; a[n + 4] = cr; a[n + 5] = cg; a[n + 6] = cb; a[n + 7] = 1;
        a[n + 8] = x1; a[n + 9] = y1; a[n + 10] = u; a[n + 11] = v; a[n + 12] = cr; a[n + 13] = cg; a[n + 14] = cb; a[n + 15] = 1;
        a[n + 16] = x2; a[n + 17] = y2; a[n + 18] = u; a[n + 19] = v; a[n + 20] = cr; a[n + 21] = cg; a[n + 22] = cb; a[n + 23] = 1;
        a[n + 24] = x0; a[n + 25] = y0; a[n + 26] = u; a[n + 27] = v; a[n + 28] = cr; a[n + 29] = cg; a[n + 30] = cb; a[n + 31] = 1;
        a[n + 32] = x2; a[n + 33] = y2; a[n + 34] = u; a[n + 35] = v; a[n + 36] = cr; a[n + 37] = cg; a[n + 38] = cb; a[n + 39] = 1;
        a[n + 40] = x3; a[n + 41] = y3; a[n + 42] = u; a[n + 43] = v; a[n + 44] = cr; a[n + 45] = cg; a[n + 46] = cb; a[n + 47] = 1;
        return n + 48;
    }
    function pushQuadT(a, n, x0, y0, x1, y1, cell) {
        /* sprite billboard: white vertex colour, atlas cell carries the
           (premultiplied) pixels */
        var u0 = cell.u0, v0 = cell.v0, u1 = cell.u1, v1 = cell.v1;
        a[n] = x0; a[n + 1] = y0; a[n + 2] = u0; a[n + 3] = v0; a[n + 4] = 1; a[n + 5] = 1; a[n + 6] = 1; a[n + 7] = 1;
        a[n + 8] = x1; a[n + 9] = y0; a[n + 10] = u1; a[n + 11] = v0; a[n + 12] = 1; a[n + 13] = 1; a[n + 14] = 1; a[n + 15] = 1;
        a[n + 16] = x1; a[n + 17] = y1; a[n + 18] = u1; a[n + 19] = v1; a[n + 20] = 1; a[n + 21] = 1; a[n + 22] = 1; a[n + 23] = 1;
        a[n + 24] = x0; a[n + 25] = y0; a[n + 26] = u0; a[n + 27] = v0; a[n + 28] = 1; a[n + 29] = 1; a[n + 30] = 1; a[n + 31] = 1;
        a[n + 32] = x1; a[n + 33] = y1; a[n + 34] = u1; a[n + 35] = v1; a[n + 36] = 1; a[n + 37] = 1; a[n + 38] = 1; a[n + 39] = 1;
        a[n + 40] = x0; a[n + 41] = y1; a[n + 42] = u0; a[n + 43] = v1; a[n + 44] = 1; a[n + 45] = 1; a[n + 46] = 1; a[n + 47] = 1;
        return n + 48;
    }
    /* ---- the sprite atlas: sprites are capped to the px size actually
       painted at this zoom (16..256 levels), so 3,592 manifest PNGs that
       need ~2.5 Gpx at native size fit on a 4096 page at overview zooms.
       Cells pack shelf-first, lazily (aglBudget/frame) straight from the
       decoded PNGs; a full page re-packs the current view every ~120
       frames, evicted sprites show as blocks meanwhile. The 8x8 white
       block at (0,0) is the prism/dot sample point. */
    var agl = { page: 0, cv: null, c2: null, cx: 2, cy: 10, rowH: 0,
                map: {}, n: 0, dirty: false, lastUp: 0, full: false,
                dead: false, wuv: [0.5, 0.5] };
    window.__AGL = agl;                   // console peek: cells packed, full/dead
    window.__CV_PROBE = function () {     // console: where the GL top frame went
        var s = CAM.scale(cam);
        var A = CAM.tileAffine(cam, VW, VH);
        var T = terrain.visibleTileRect(cam, VW, VH);
        var n1 = buildBuildQuads(A, s, T);
        var n2 = buildPeopleQuads(A, s, T, n1);
        var wu = agl.cv ? agl.wuv[0] : 0.5;
        var spr = 0, cells = {};
        for (var q = 0; q < n1 / 8; q++) {
            if (bq[q * 48 + 2] !== wu) {   // prism faces all sample the white cell
                spr++;
                cells[bq[q * 48 + 2].toFixed(5) + ',' + bq[q * 48 + 3].toFixed(5)] = 1;
            }
        }
        return {
            s: Math.round(s * 100) / 100, lod: s < BUILD_LOD_S,
            buildQuads: n1 / 8, spriteQuads: spr, prismQuads: n1 / 8 - spr,
            peopleQuads: (n2 - n1) / 8, dots: peopleDots,
            distinctCells: Object.keys(cells).length,
            atlas: { n: agl.n, full: agl.full, dead: agl.dead, page: agl.page,
                     dirty: !!(agl.cv && agl.cv.__glDirty) },
            art: { sprites: !!citySprites, chars: !!charMan, pend: ALOAD.pend,
                   got: ALOAD.artGot, dead: ALOAD.artDead, known: ALOAD.artKnown },
            keys: Object.keys(agl.map).slice(0, 40)
        };
    };
    function aglInvalidate() {            // manifests (re)loaded: start fresh
        agl.map = {}; agl.n = 0; agl.cx = 2; agl.cy = 10; agl.rowH = 0;
        agl.full = false;
        if (agl.cv) {
            agl.c2.clearRect(0, 0, agl.page, agl.page);
            agl.c2.fillStyle = '#fff';
            agl.c2.fillRect(0, 0, 8, 8);
            agl.cv.__glDirty = true;
        }
    }
    function aglInit() {
        if (agl.cv || agl.dead) return;
        var mt = glR ? Math.min(4096, +glR.maxTex || 0) : 0;
        var p = 512;
        while (p * 2 <= mt) p *= 2;
        if (p < 1024) { agl.dead = true; return; }   // tiny GL limits: prisms only
        agl.page = p;
        agl.cv = document.createElement('canvas');
        agl.cv.width = p; agl.cv.height = p;
        agl.c2 = agl.cv.getContext('2d');
        agl.c2.fillStyle = '#fff';
        agl.c2.fillRect(0, 0, 8, 8);
        agl.wuv[0] = 3.5 / p; agl.wuv[1] = 3.5 / p;
        agl.cv.__glDirty = true;
    }
    function aglCap(drawnPx) {                        // pow2 cell tier
        return drawnPx <= 16 ? 16 : drawnPx <= 32 ? 32 : drawnPx <= 64 ? 64
            : drawnPx <= 128 ? 128 : drawnPx <= 256 ? 256
                : drawnPx <= 512 ? 512 : 1024;
    }
    function aglCell(key, im, w, h, cap, sx, sy) {
        /* (sx, sy) = read a SUB-RECT of im (one filmstrip cell) instead of
           the whole PNG; everything else — shelf pack, guard border, UVs —
           is identical, so animation cells are ordinary atlas cells */
        var c = agl.map[key];
        if (c) return c;
        if (agl.full || !im || !w || !h) return null;
        var sc = cap / Math.max(w, h);
        if (sc > 1) sc = 1;
        var cw = Math.max(2, Math.round(w * sc)), ch = Math.max(2, Math.round(h * sc));
        if (agl.cx + cw + 4 > agl.page) { agl.cx = 2; agl.cy += agl.rowH + 2; agl.rowH = 0; }
        if (agl.cy + ch + 4 > agl.page) { agl.full = true; return null; }
        if (sx === undefined)
            agl.c2.drawImage(im, agl.cx + 1, agl.cy + 1, cw, ch);   // 1px guard border
        else
            agl.c2.drawImage(im, sx, sy, w, h, agl.cx + 1, agl.cy + 1, cw, ch);
        c = { u0: (agl.cx + 0.5) / agl.page, v0: (agl.cy + 0.5) / agl.page,
              u1: (agl.cx + cw - 0.5) / agl.page, v1: (agl.cy + ch - 0.5) / agl.page };
        agl.map[key] = c; agl.n++;
        agl.cx += cw + 2;                          // shelf cursor: cell + 1px
                                                   // guard each side — without
                                                   // this every cell repacks
                                                   // the same spot and ALL
                                                   // sprites sample the last
                                                   // image that landed there
        if (ch > agl.rowH) agl.rowH = ch;
        agl.dirty = true;
        return c;
    }
    function aglUpload(t) {               // batch page re-uploads after packs
        if (!agl.dirty || !agl.cv) return;
        if (t - agl.lastUp > 250) {
            agl.cv.__glDirty = true; agl.dirty = false; agl.lastUp = t;
        } else markDirty();               // throttled: force a follow-up frame,
                                          // else the tail of packs after the
                                          // last image load never reaches the
                                          // GPU (view idles with stale cells)
    }
    function spriteFor(b, k) {
        if (!citySprites || !b.slug) return null;
        var key = (b.flip && citySprites[b.slug + 'flipped'])
            ? b.slug + 'flipped' : b.slug;
        var sp = spriteEntry(key);
        if (!sp) return null;
        if (sp.w * k < 12 && sp.h * k < 12) return null;   // 2D's readability gate
        return sp;
    }
    var SPR = { sp: null, sx: 0, sy: 0, sw: 0, sh: 0, an: null,
                px: 0, py: 0, bx: 0, by: 0, bw: 0, bh: 0 };
    function spriteGeo(b, k, A) {
        /* mirror drawSprite's placement exactly; false = no sprite drawn
           (manifest miss / below gate) — out param SPR avoids per-call
           objects (called once per visible building per frame). SPR.an
           carries the filmstrip cells when the sprite animates: SPR.px/py
           is the ground pin in screen px, every piece (the body PNG when
           an.base, then one quad per cell) hangs off it with its own
           anchor, and SPR.sx..sh is the union the cull + scan measure. */
        var sp = spriteFor(b, k);
        if (!sp) return false;
        var gx = ART.ref === 'origin' ? b.x0 : b.px;
        var gy = ART.ref === 'origin' ? b.y0 : b.py;
        var wx = gx + ART.ax, wy = gy + ART.ay;
        var pxx = A.a * wx + A.b * wy + A.c;
        var pyy = A.d * wx + A.e * wy + A.f;
        var an = animOf(b, k);
        var cells = null, i, st;
        if (an) {                         // cells that would upscale past
            for (i = 0; i < an.cells.length; i++) {  // their atlas cell are
                st = an.cells[i].a;                  // dropped; the rest of
                if (Math.max(st.cellw, st.cellh) * k <= AGL_CELL_MAX)
                    { if (!cells) cells = []; cells.push(an.cells[i]); }
            }
            if (an.base && cells && cells.length < an.cells.length)
                cells = null;                        // stack must draw whole
            if (!cells && !an.base) an = null;       // the whole loop is
            else if (an) an = { cells: cells || [],  // too big: static tier
                                base: an.base, tap: an.tap };
        }
        SPR.an = an;                      // tier: keep the static quad so the
                                          // scan doesn't drop the WHOLE frame
                                          // to 2D for one big filmstrip
        SPR.px = pxx; SPR.py = pyy;
        SPR.bx = pxx - sp.anchor[0] * k; SPR.by = pyy - sp.anchor[1] * k;
        SPR.bw = sp.w * k; SPR.bh = sp.h * k;
        var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
        if (!an || an.base) { x0 = SPR.bx; y0 = SPR.by; x1 = SPR.bx + SPR.bw; y1 = SPR.by + SPR.bh; }
        if (an) for (i = 0; i < an.cells.length; i++) {
            var ub = ubOf(an.cells[i].a);
            if (!ub) continue;
            var cx = pxx + ub[0] * k, cy = pyy + ub[1] * k;
            if (cx < x0) x0 = cx;
            if (cy < y0) y0 = cy;
            if (pxx + ub[2] * k > x1) x1 = pxx + ub[2] * k;
            if (pyy + ub[3] * k > y1) y1 = pyy + ub[3] * k;
        }
        if (x1 < -4 || x0 > VW + 4 || y1 < -4 || y0 > VH + 4) {
            SPR.sp = null; return false;          // off-screen: 2D draws none either
        }
        SPR.sx = x0; SPR.sy = y0; SPR.sw = x1 - x0; SPR.sh = y1 - y0;
        SPR.sp = sp;
        return true;
    }
    /* pack/look up one sprite PIECE: st = a filmstrip strip (rc = one of
       its sparse rects), null = the static body PNG (a multi-part asset
       blits both, body first). */
    function aglPieceCell(sp, st, fi, rc, k) {
        if (st && !animAtlasFor(st)) return null;      // budget spent / decoding
        var tw = rc ? rc.w : (st ? st.cellw : sp.w),
            th = rc ? rc.h : (st ? st.cellh : sp.h);
        var im = imgFor('assets/city/' + (st ? st.png : sp.png));
        if (!im) return null;
        var tier = aglCap(Math.max(tw, th) * k);
        var key = st ? st.png + '#' + fi + (rc ? '-' + rc.sx + '_' + rc.sy : '')
                         + '@' + tier
                     : sp.png + '@' + tier;
        var cell = agl.map[key];
        if (!cell && aglBudget > 0) {
            cell = st
                ? aglCell(key, im, tw, th, tier,
                          rc ? rc.sx : (fi % st.cols) * st.cellw,
                          rc ? rc.sy : Math.floor(fi / st.cols) * st.cellh)
                : aglCell(key, im, tw, th, tier);
            aglBudget--;
        }
        return cell;
    }
    /* quality gate for GL sprites: the GL pass stays on while every sprite
       PAINTED ON SCREEN fits its atlas cell with a 1.5x upscale allowance
       (biggest tier 1024 -> tolerate 1536). That covers the whole band
       where Canvas2D is actually slow (thousands of billboards per pan),
       so in practice Art is GL-always; the 2D path survives only for
       extreme close-ups of the handful of giant landmarks (few buildings
       on screen there -> 2D is fast anyway) and for GPUs too small to
       host the atlas (agl.dead). The scan costs one cheap pass over the
       culled buildings and only runs in Art mode. */
    var AGL_CELL_MAX = 1536;
    function spriteScanBlock(A, s, T) {
        var k = s / ART.S;
        for (var i = 0; i < buildings.length; i++) {
            var b = buildings[i];
            if (objHidden[b.cat]) continue;
            if (b.x1 < T.x0 - 6 || b.x0 > T.x1 + 6 ||
                b.y1 < T.y0 - 6 || b.y0 > T.y1 + 6) continue;
            if (spriteGeo(b, k, A)) {
                if (agl.dead) return 'dead';        // no atlas: 2D must draw real
                if (Math.max(SPR.sw, SPR.sh) > AGL_CELL_MAX)
                    return 'big';                   // would upscale past its 512 cell
            }
        }
        return '';
    }
    function buildBuildQuads(A, s, T) {
        var need = buildings.length * 144 + 4096;   // 3 faces x 6 verts x 8 floats
        if (bq.length < need) bq = new Float32Array(need);
        var a = bq, n = 0, i;
        var art = !!artMode && !!agl.cv && !agl.dead;
        var k = s / ART.S;
        var wu = agl.cv ? agl.wuv[0] : 0.5, wv = agl.cv ? agl.wuv[1] : 0.5;
        var mgn = art ? 6 : 2;                      // drawSprite culls at +6 tiles
        for (i = 0; i < buildings.length; i++) {
            var b = buildings[i];
            if (objHidden[b.cat]) continue;         // object legend
            if (b.x1 < T.x0 - mgn || b.x0 > T.x1 + mgn ||
                b.y1 < T.y0 - mgn || b.y0 > T.y1 + mgn) continue;
            if (art) {
                if (spriteGeo(b, k, A)) {
                    var sp = SPR.sp, an = SPR.an, j, q, cell, ub;
                    var pcs = [], ok = 1, drewCell = 0;
                    if (!an || an.base) {              // static body, or the
                        cell = aglPieceCell(sp, null, 0, null, k);  // body of a
                        if (cell)                      // multi-part asset
                            pcs.push([SPR.bx, SPR.by, SPR.bx + SPR.bw,
                                      SPR.by + SPR.bh, cell]);
                        else if (an) ok = 0;
                    }
                    if (an && ok) for (j = 0; j < an.cells.length && ok; j++) {
                        var st = an.cells[j].a, fi = an.cells[j].fi;
                        if (st.sub) {                  // sparse: one quad/rect
                            var rs = st.sub[fi] || [];
                            for (q = 0; q < rs.length; q++) {
                                var r = rs[q];
                                cell = aglPieceCell(sp, st, fi, r, k);
                                if (!cell) { ok = 0; break; }
                                pcs.push([SPR.px + r.ox * k, SPR.py + r.oy * k,
                                          SPR.px + (r.ox + r.w) * k,
                                          SPR.py + (r.oy + r.h) * k, cell]);
                            }
                        } else {
                            cell = aglPieceCell(sp, st, fi, null, k);
                            if (!cell) { ok = 0; break; }
                            ub = ubOf(st);
                            pcs.push([SPR.px + ub[0] * k, SPR.py + ub[1] * k,
                                      SPR.px + ub[2] * k, SPR.py + ub[3] * k,
                                      cell]);
                        }
                        drewCell++;
                    }
                    if (!ok) {                         // part stack incomplete:
                        pcs = [];                      // body only beats half
                        cell = aglPieceCell(sp, null, 0, null, k);    // the composite
                        if (cell)
                            pcs.push([SPR.bx, SPR.by, SPR.bx + SPR.bw,
                                      SPR.by + SPR.bh, cell]);
                        drewCell = 0;
                    }
                    if (pcs.length) {
                        for (j = 0; j < pcs.length; j++)
                            n = pushQuadT(a, n, pcs[j][0], pcs[j][1],
                                          pcs[j][2], pcs[j][3], pcs[j][4]);
                        if (drewCell) { animLive++; if (!an.tap) animBudget--; }
                        continue;
                    }
                    /* not packed/decoded yet: fall through to the prism */
                }
            }
            var ax0 = A.a * b.x0 + A.b * b.y0 + A.c, ay0 = A.d * b.x0 + A.e * b.y0 + A.f;
            var ax1 = A.a * b.x1 + A.b * b.y0 + A.c, ay1 = A.d * b.x1 + A.e * b.y0 + A.f;
            var ax2 = A.a * b.x1 + A.b * b.y1 + A.c, ay2 = A.d * b.x1 + A.e * b.y1 + A.f;
            var ax3 = A.a * b.x0 + A.b * b.y1 + A.c, ay3 = A.d * b.x0 + A.e * b.y1 + A.f;
            var h = b.hgt * s;
            var mnx = Math.min(ax0, ax1, ax2, ax3), mxx = Math.max(ax0, ax1, ax2, ax3);
            var mny = Math.min(ay0, ay1, ay2, ay3) - h, mxy = Math.max(ay0, ay1, ay2, ay3);
            if (mxx < -4 || mnx > VW + 4 || mxy < -4 || mny > VH + 4) continue;
            n = pushQuadC(a, n, ax1, ay1 - h, ax2, ay2 - h, ax2, ay2, ax1, ay1, b.cR, wu, wv);
            n = pushQuadC(a, n, ax2, ay2 - h, ax3, ay3 - h, ax3, ay3, ax2, ay2, b.cL, wu, wv);
            n = pushQuadC(a, n, ax0, ay0 - h, ax1, ay1 - h, ax2, ay2 - h, ax3, ay3 - h, b.cT, wu, wv);
        }
        return n;                                   // float count
    }
    function buildPeopleQuads(A, s, T, n) {
        /* mirror drawPeopleArt: readable char -> sprite quad at its anchor,
           everything else -> fallback dot (drawn after all quads, as in 2D) */
        var chars = M.chars;
        if (dxy.length < chars.length * 2) dxy = new Float32Array(chars.length * 2);
        var a = bq, nd = 0;
        var art = !!artMode && !!agl.cv && !agl.dead && !!charMan;
        var k = s / ART.S;
        for (var i = 0; i < chars.length; i++) {
            var c = chars[i];
            if (c[1] < T.x0 - 1 || c[1] > T.x1 + 1 ||
                c[2] < T.y0 - 1 || c[2] > T.y1 + 1) continue;
            var cx = c[1], cy = c[2];
            var x = A.a * cx + A.b * cy + A.c, y = A.d * cx + A.e * cy + A.f;
            if (x < -4 || x > VW + 4 || y < -4 || y > VH + 4) continue;
            if (art) {
                var rec = charMan.characters[c[0]];
                var as = rec && charMan.assets[rec.slug];
                if (as && !(as.w * k < 12 && as.h * k < 12)) {
                    var url = 'assets/characters/' + charFrameFile(as, c[0], k);
                    if (charAnimating(as, k)) charAnimLive++;
                    var tier = aglCap(Math.max(as.w, as.h) * k);
                    var key = url + '@' + tier;
                    var cell = agl.map[key];
                    if (!cell && aglBudget > 0) {
                        var im = imgFor(url);
                        if (im) { cell = aglCell(key, im, as.w, as.h, tier); aglBudget--; }
                    }
                    if (cell) {
                        n = pushQuadT(a, n, x - as.anchor[0] * k, y - as.anchor[1] * k,
                            x - as.anchor[0] * k + as.w * k,
                            y - as.anchor[1] * k + as.h * k, cell);
                        continue;
                    }
                }
            }
            dxy[nd++] = x; dxy[nd++] = y;
        }
        peopleDots = nd / 2;
        return n;
    }
    /* why the clean-view GL building path declines a frame ('' = take it).
       Named reasons so the statsbar/`__CV_DIAG.block` reports the cause —
       every one of these silently falling back was invisible before. */
    function glBuildBlock(A, s, T) {
        /* Art refuses GL only when a sprite PAINTED ON SCREEN would exceed
           its atlas cell (blurry) or at deep zoom, where only a handful of
           buildings are visible (2D is fast there) and the native-PNG
           detail is exactly what the user is looking at. The scan is one
           extra pass over culled buildings, only in Art mode. */
        if (artMode) {
            var ab = spriteScanBlock(A, s, T);
            if (ab) { DIAG.artBlock = ab; return 'art'; }   // 'deep' | 'big'
        }
        if (wireOn) return 'wire';                // blockers after this point
        if (gridOn) return 'grid';                // are actionable even when
        if (walksOn) return 'walks';              // GL is already dead for
        if (markerPts.length) return 'marks';     // other reasons
        if (searchMatches.length) return 'search';
        if (selected) return 'sel';
        if (!glR) return DIAG.glReason || 'nogl';
        return '';
    }

    /* ---- renderer diagnostics (2026-10-20.5) ---------------------------------
       statsbar carries which base path is drawing and how long render()
       takes per frame. "Still slow" reports are otherwise unfixable from
       the headless side: only the real browser knows whether the GL
       layer took over and whether the frame cost is JS or raster. */
    var DIAG = {
        mode: '2D', ms: 0, fps: 0, maxMs: 0, anims: 0, charAnims: 0,
        block: '',                                 // why GL declined THIS frame
        artBlock: '',                              // block='art': 'deep' | 'big'
        glReason: glR ? ''                         // why GL never booted
            : (window.CityGL ? CityGL.lastError() : 'no-CityGL-script'),
        ver: '2026-10-23.1'
    };
    window.__CV_DIAG = DIAG;
    window.__CV_VER = DIAG.ver;                    // console sanity check
    var diagFrames = 0, diagMsAcc = 0, diagLastT = 0;

    function render() {
        var t0 = performance.now();
        animNow = t0;                     // one clock per frame: instances agree
        animLive = 0;                     // counted by the art passes below
        charAnimLive = 0;
        animBudget = ANIM_MAX_BLITS;      // shared 2D/GL blit allowance
        var s = CAM.scale(cam);
        var lod = s < BUILD_LOD_S;
        /* backing-store cap (2026-10-20.5): bilinear-smoothed atlas tiles
           at 2px/tile gain nothing from 4x the device pixels, and a
           zoomed-out pan frame is dominated by clear/fill RASTER work on
           the backing store — capping the LOD regime to dpr 1 cuts that
           ~4x. Sharpness restores above the threshold. ?dpr=1 forces the
           cap in every regime for raster-bound machines. */
        var capDpr = QP.get('dpr') ? (parseFloat(QP.get('dpr')) || 1)
            : (lod ? 1 : Infinity);
        var edpr = Math.min(dpr, capDpr);
        if (cv.width !== Math.round(VW * edpr) ||
            cv.height !== Math.round(VH * edpr)) {
            cv.width = Math.round(VW * edpr);
            cv.height = Math.round(VH * edpr);
        }
        ctx.setTransform(edpr, 0, 0, edpr, 0, 0);
        ctx.clearRect(0, 0, VW, VH);
        var useGL = false, glB = false, gTerrain = null, gBuild = null;
        if (glR && lod) {
            gTerrain = terrain.flatInfo();        // lazily builds the atlases
            gBuild = buildBuildFlat();
            useGL = !!(gTerrain && gBuild);
        }
        terrain.glBase = useGL;                   // suppress 2D grass/sea/atlas
        terrain.render(ctx, cam, VW, VH, edpr);
        var T = terrain.visibleTileRect(cam, VW, VH);
        if (useGL) {
            var rpx = Math.max(1.6, CityObjects.PEOPLE_R * Math.min(2.2, s / 40));
            useGL = glR.draw({
                A: CAM.tileAffine(cam, VW, VH),
                vw: VW, vh: VH, dpr: edpr, T: T,
                grassImg: terrain.grassImg || null,
                grassRGB: M.grass, grassRepeat: terrain.grassRepeat,
                sea: (terrain.seaFill && terrain.seaFillX1 > terrain.seaFillX0 &&
                        !terrain.hidden['ocean'])
                    ? { x0: terrain.seaFillX0 - terrain.ox,
                        y0: terrain.seaFillY0 - terrain.oy,
                        x1: terrain.seaFillX1 - terrain.ox,
                        y1: terrain.seaFillY1 - terrain.oy,
                        rgb: CityTerrain.SEA_RGB }
                    : null,
                terrain: gTerrain,
                buildings: gBuild,
                atlasTS: gTerrain.ts,
                dots: (artMode || objHidden.people) ? null
                    : { chars: M.chars, r: rpx / s, rgb: M.charcol }
            });
            if (!useGL) { glR = null; DIAG.glReason = 'draw-fail'; }
        }
        var gbBlock = '';                          // classic-band refusal, if any
        if (!useGL) {
            if (lod) {
                drawBlocksFlat(T, edpr);          // orbit LOD: flat batched footprints
            } else {
                var A = CAM.tileAffine(cam, VW, VH);
                gbBlock = glBuildBlock(A, s, T);
                if (!gbBlock) {
                    /* classic band, clean view (glBuildBlock proved glR
                       live): prisms/sprites/dots in ONE depth-ordered
                       GL stream on the canvas raised above the 2D layer */
                    aglInit();
                    if (agl.full && (++gbFrames % 120) === 60) aglInvalidate();
                    aglBudget = agl.full ? 96 : 16;
                    var nf = buildBuildQuads(A, s, T);
                    if (objHidden.people) peopleDots = 0;
                    else nf = buildPeopleQuads(A, s, T, nf);
                    aglUpload(performance.now());
                    glB = glR.drawTop({
                        vw: VW, vh: VH, dpr: edpr,
                        quads: { arr: bq, n: nf / 8 },
                        dots: peopleDots ? {
                            xy: dxy, n: peopleDots, rgb: M.charcol,
                            r: Math.max(1.6, CityObjects.PEOPLE_R *
                                Math.min(2.2, s / 40))
                        } : null,
                        tex: agl.cv, wuv: agl.wuv
                    });
                    if (!glB) { glR = null; DIAG.glReason = 'drawTop-fail'; }
                }
            }
            if (!glB && !lod && !useGL) {
                for (var i = 0; i < buildings.length; i++) {
                    var b = buildings[i];
                    if (objHidden[b.cat]) continue;
                    if (!(artMode && drawSprite(b, T))) drawBlock(b, T);
                    if (wireOn) drawWireBox(b, T);
                }
            }
        }
        if ($('glcv')) $('glcv').classList.toggle('above', !!glB);
        if (!objHidden.people && !(useGL && !artMode) && !glB)
            if (artMode) drawPeopleArt(ctx, M.chars, cam, T);
            else CityObjects.drawPeople(ctx, CAM, M.chars, M.charcol, cam, VW, VH, T);
        if (walksOn && M.walks && typeof CityWalks !== 'undefined')
            CityWalks.draw(ctx, CAM, M.walks, cam, VW, VH, T, walkCensus);
        if (gridOn) drawGrid(cam, T);
        if (markerPts.length && typeof CityMarkers !== 'undefined')
            CityMarkers.draw(ctx, CAM, markerPts, cam, VW, VH, T);
        drawMarks();
        /* frame diagnostics: mode says which base path drew this frame
           (GL = WebGL layer took over, 2D·LOD = fallback atlas blits,
           2D = classic); fps/ms only count rendered (dirty) frames. */
        DIAG.ms = performance.now() - t0;
        DIAG.anims = animLive;            // filmstrip sprites in the last frame
        DIAG.charAnims = charAnimLive;    // characters on an idle loop
        DIAG.mode = useGL ? 'GL' : (glB ? 'GL·bld' : (lod ? '2D·LOD' : '2D'));
        DIAG.block = (useGL || glB) ? ''
            : (lod ? (DIAG.glReason || 'nogl') : gbBlock);
        diagFrames++; diagMsAcc += DIAG.ms;
        if (DIAG.ms > DIAG.maxMs) DIAG.maxMs = DIAG.ms;
        $('zoomread').textContent = 'zoom ' + cam.zoom.toFixed(2) + '  ·  tile ' +
            CAM.TILE.hw + ':' + CAM.TILE.hh + ' · ' + Math.round(CAM.scale(cam)) + 'px/unit' + (gridOn && hoverTile
            ? '  ·  hover ' + hoverTile[0] + ',' + hoverTile[1] : '');
    }

    var lastT = 0;
    function loop(t) {
        requestAnimationFrame(loop);
        var dt = lastT ? Math.min(0.05, (t - lastT) / 1000) : 0;
        lastT = t;
        if (cam.vx || cam.vy) { CAM.tick(cam, dt); markDirty(); }
        if (needsRender) { needsRender = false; render(); }
        else if ((animLive || charAnimLive) && artMode && animOn && t >= animNextT) {
            // keep the filmstrips and character idle loops moving: last
            // frame drew animated sprites, so schedule the next cell swap
            // (~the loops' 12 fps)
            animNextT = t + 90;
            markDirty();
        }
        if (t - diagLastT > 500) {                 // statsbar at 2 Hz
            var win = t - diagLastT || 500;
            diagLastT = t;
            DIAG.fps = Math.round(diagFrames * 1000 / win);
            var pr = $('perfread');
            if (pr) pr.textContent = DIAG.mode +
                (DIAG.block ? '(' + DIAG.block + ')' : '') + ' · ' +
                DIAG.fps + 'fps · ' +
                (diagFrames ? (diagMsAcc / diagFrames).toFixed(1) : '0.0') +
                '/' + DIAG.maxMs.toFixed(1) + 'ms' +
                /* anim diagnostics: filmstrip sprites drawn last frame, and
                   GL atlas state — a climbing cell count (or a trailing F =
                   page full) while the view is static = atlas churn */
                ' · a' + DIAG.anims +
                (agl.cv ? '/' + agl.n + (agl.full ? 'F' : '') : '/') +
                ' · v' + DIAG.ver;
            diagFrames = 0; diagMsAcc = 0; DIAG.maxMs = 0;
        }
    }

    /* ---- input: pan / fling / zoom ------------------------------------------ */
    /* The legend overlays the stage, so a press on a legend row would
       otherwise be swallowed by the pan gesture below (and
       setPointerCapture would steal the click from the button).
       Anything under a UI overlay (e.g. #legend) is not map input. */
    function overUI(e) {
        var t = e.target;
        return !!(t && t.closest && t.closest('.legend'));
    }
    var down = false, moved = false, lx = 0, ly = 0, dx0 = 0, dy0 = 0;
    var mvT = 0, flingX = 0, flingY = 0;     // release velocity, screen px/s
    stage.addEventListener('pointerdown', function (e) {
        if (e.button !== 0 || overUI(e)) return;
        down = true; moved = false;
        lx = dx0 = e.clientX; ly = dy0 = e.clientY;
        mvT = 0; flingX = flingY = 0;
        cam.vx = 0; cam.vy = 0;
        stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener('pointermove', function (e) {
        if (!down) return;
        var now = performance.now();
        var dx = e.clientX - lx, dy = e.clientY - ly;
        if (!moved && Math.hypot(e.clientX - dx0, e.clientY - dy0) > 3) {
            moved = true; stage.classList.add('panning');
        }
        if (moved) {
            CAM.panByScreen(cam, dx, dy);
            var dt = mvT ? Math.max(4, now - mvT) / 1000 : 0.016;
            flingX = flingX * 0.5 + (dx / dt) * 0.5;   // smoothed release velocity
            flingY = flingY * 0.5 + (dy / dt) * 0.5;
            mvT = now; lx = e.clientX; ly = e.clientY; markDirty();
        }
    });
    stage.addEventListener('pointerup', function (e) {
        if (!down) return;
        down = false; stage.classList.remove('panning');
        if (moved) { CAM.setFling(cam, flingX, flingY); markDirty(); }  // release -> fling
    });
    stage.addEventListener('wheel', function (e) {
        if (overUI(e)) return;
        e.preventDefault();
        var r = stage.getBoundingClientRect();
        CAM.wheel(cam, e.deltaY, e.clientX - r.left, e.clientY - r.top, VW, VH);
        markDirty();
    }, { passive: false });
    stage.addEventListener('dblclick', function (e) {
        if (overUI(e)) return;
        /* on a marked tile, dblclick centers the mark instead of stepping
           zoom (the mark is what the user is looking at); elsewhere the
           normal step-zoom gesture is untouched */
        if (markerPts.length) {
            var rr = stage.getBoundingClientRect();
            var wq = CAM.screenToWorld(cam, e.clientX - rr.left,
                e.clientY - rr.top, VW, VH);
            var tq = CAM.worldToTile(wq.x, wq.y);
            var bx = Math.round(tq.x), by = Math.round(tq.y);
            for (var mi = 0; mi < markerPts.length; mi++)
                if (markerPts[mi][0] === bx && markerPts[mi][1] === by) {
                    centerOnTile(bx + 0.5, by + 0.5);
                    markDirty();
                    return;
                }
        }
        var r = stage.getBoundingClientRect();
        CAM.zoomStep(cam, e.clientX - r.left, e.clientY - r.top, VW, VH);
        markDirty();
    });

    window.addEventListener('keydown', function (e) {
        var t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;  // search typing
        var n = 40;
        if (e.key === 'Escape') { setSel(null); }
        else if (e.key === 'ArrowLeft') { CAM.panByScreen(cam, n, 0); markDirty(); e.preventDefault(); }
        else if (e.key === 'ArrowRight') { CAM.panByScreen(cam, -n, 0); markDirty(); e.preventDefault(); }
        else if (e.key === 'ArrowUp') { CAM.panByScreen(cam, 0, n); markDirty(); e.preventDefault(); }
        else if (e.key === 'ArrowDown') { CAM.panByScreen(cam, 0, -n); markDirty(); e.preventDefault(); }
    });

    /* ---- select + details pane + search ---------------------------------------
       A click (not a pan-drag) hit-tests the depth-sorted blocks, people
       and ground tiles and shows the Map Explorer-style details card in the
       right pane; Esc or clicking the same ground tile again deselects. The header search matches building/character
       names, slugs, assets or ids: every match is outlined on the canvas
       (blue), the selected one in gold, and Enter centers + selects the first.
       Hidden object-legend buckets are neither clickable nor searchable. */
    var details = $('details');
    var search = $('search');
    var matchinfo = $('matchinfo');
    var results = $('results');
    var PLACEHOLDER = '<div class="placeholder">Click a building or character&hellip;</div>';
    var selected = null;              // {kind:'b'|'c', i} — i indexes M.buildings / M.chars
    var searchMatches = [];           // [{kind, i}]
    var searchQ = '';                 // last applied query (for result ranking)
    var searchTimer = null;
    var MATCH_DRAW_CAP = 600;         // outline cap — keeps render cheap for huge buckets
    var RESULT_CAP = 100;             // result-list cap (grouped by catalog id)

    function esc(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    /* details cards — same fields as the Map Explorer's pane (M.binfo row is
       [name, asset, slug, x, z, locX, locY, height, via, count]) */
    function buildingHtml(i) {
        var b = M.buildings[i];
        var e = M.binfo[b[0]];
        if (!e) return '<h3>unknown</h3><p class="dim">No catalog entry for #' + b[0] + '.</p>';
        var name = e[0], asset = e[1], slug = e[2], x = e[3], z = e[4],
            locX = e[5], locY = e[6], height = e[7], via = e[8], count = e[9];
        var viaCls = via === 'asset' ? 'via-asset' :
            (via === 'flip' || via === 'rotated') ? 'via-flip' : 'via-other';
        var bv = behav && behav[String(slug).toLowerCase()];   // gate readout
        return '<h3>' + esc(name) + '</h3>' +
            '<div class="tagrow"><span class="tag">building <b>#' + b[0] + '</b></span>' +
            '<span class="tag"><b>' + count + '</b>&times; in save</span>' +
            '<span class="tag">bucket <b>' + esc(catOfMi[i]) + '</b></span></div>' +
            '<table>' +
            '<tr><td>asset</td><td>' + esc(asset) + '</td></tr>' +
            '<tr><td>slug</td><td>' + esc(slug) + '</td></tr>' +
            '<tr><td>footprint</td><td>' + b[3] + ' &times; ' + b[4] + ' tiles (drawn)</td></tr>' +
            '<tr><td>catalog dims</td><td>' + x + ' &times; ' + z + ', anchor ' + locX + ', ' + locY + '</td></tr>' +
            '<tr><td>height</td><td>' + height + '</td></tr>' +
            '<tr><td>position</td><td>' + b[6] + ', ' + b[7] + '</td></tr>' +
            '<tr><td>covers tiles</td><td>X ' + Math.round(b[1]) + '..' + Math.round(b[1] + b[3] - 1) +
            ', Y ' + Math.round(b[2]) + '..' + Math.round(b[2] + b[4] - 1) + '</td></tr>' +
            '<tr><td>resolved via</td><td class="' + viaCls + '">' + esc(via) + '</td></tr>' +
            (bv ? '<tr><td>engine anims</td><td>' +
                  (bv.idle ? 'idle <b>' + esc(bv.idle) + '</b>'
                           : (bv.layers ? 'part loops <b>' +
                              esc(bv.layers.join(' + ')) + '</b>' : 'idle static')) +
                  (bv.toggle ? ' · click <b>' + esc(togLabel(bv.toggle)) +
                       '</b> (toggle)'
                      : bv.tap ? ' · tap <b>' + esc(bv.tap) + '</b> (click)'
                      : ' · no tap anim') + '</td></tr>'
                 : '') +
            '</table>' +
            '<div class="pinnote">Selected — Esc or clicking a ground tile deselects.' +
            ' Enter in the search box centers matches.</div>';
    }
    function charHtml(i) {
        var c = M.chars[i];
        var name = M.charNames[c[0]];
        var count = 0;
        for (var k = 0; k < M.chars.length; k++) if (M.chars[k][0] === c[0]) count++;
        return '<h3>' + esc(name || 'char #' + c[0]) + '</h3>' +
            '<div class="tagrow"><span class="tag">character <b>#' + c[0] + '</b></span>' +
            '<span class="tag"><b>' + count + '</b>&times; in save</span></div>' +
            '<table><tr><td>position</td><td>' + c[1] + ', ' + c[2] + '</td></tr>' +
            '<tr><td>name resolved</td><td>' +
            (name ? 'yes (character catalog)' : 'no') + '</td></tr></table>' +
            '<div class="pinnote">Selected — Esc or clicking a ground tile deselects.</div>';
    }

    /* ground tile card — town + grid coords, layer size/bbox, source frame */
    function terrainHtml(x, y, type) {
        var isGrass = type === 'grass';
        var ti = isGrass ? -1 : CityTerrain.TYPE_ORDER.indexOf(type);
        var bb = ti >= 0 ? terrain.typeBBox[ti] : null;
        var layer = null;
        for (var i = 0; !isGrass && i < M.layers.length; i++)
            if (M.layers[i].n === type) layer = M.layers[i];
        return '<h3>' + esc(type) + ' tile</h3>' +
            '<div class="tagrow"><span class="tag">terrain <b>' + esc(type) + '</b></span>' +
            (isGrass
                ? '<span class="tag">base fill</span>'
                : '<span class="tag"><b>' + (terrainCounts[type] || 0) +
                  '</b> tiles in layer</span>') +
            '</div>' +
            '<table>' +
            '<tr><td>town tile</td><td>' + x + ', ' + y + '</td></tr>' +
            '<tr><td>grid tile</td><td>' + (x + M.ox) + ', ' + (y + M.oy) + '</td></tr>' +
            (bb ? '<tr><td>layer bbox (town)</td><td>X ' + bb.x0 + '..' + bb.x1 +
                  ', Y ' + bb.y0 + '..' + bb.y1 + '</td></tr>' : '') +
            (layer ? '<tr><td>layer source</td><td>' + esc(layer.n) +
                  (layer.s ? ' frame, ' + layer.s.length + ' chars</td></tr>'
                           : ' (recovered brush tiles, generator-classified)</td></tr>') : '') +
            (isGrass ? '<tr><td>note</td><td>base lawn — any tile no layer covers</td></tr>' : '') +
            '</table>' +
            '<div class="pinnote">Selected — Esc or click the tile again to deselect.</div>';
    }

    function selCatalogId() {
        if (!selected) return null;
        return selected.kind === 'b' ? M.buildings[selected.i][0]
            : selected.kind === 'c' ? M.chars[selected.i][0] : null;
    }
    function setSel(sel) {
        selected = sel;
        details.innerHTML = !sel ? PLACEHOLDER
            : sel.kind === 'c' ? charHtml(sel.i)
            : sel.kind === 't' ? terrainHtml(sel.x, sel.y, sel.type)
            : buildingHtml(sel.i);
        // sprite-variant strip under the building card (shared renderer,
        // js/asset-variants.js — same strip the Map Explorer shows)
        if (sel && sel.kind === 'b' && window.AssetVariants) {
            var e = M.binfo[M.buildings[sel.i][0]];
            var v = AssetVariants.render(e && e[2]);
            if (v) details.appendChild(v);
        }
        markResultSel();
        markDirty();
    }
    function centerSel() {
        if (!selected) return;
        if (selected.kind === 'c') {
            centerOnTile(M.chars[selected.i][1], M.chars[selected.i][2]);
        } else {
            var b = byMi[selected.i];
            centerOnTile((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
        }
        if (cam.zoom < CAM.ZOOM.rest) cam.zoom = CAM.ZOOM.rest;   // don't inspect from orbit
        markDirty();
    }

    /* ---- canvas hit-test (front-to-back, mirrors the draw order) ------------- */
    function pointInPoly(px, py, q) {
        var inside = false;
        for (var i = 0, j = q.length - 1; i < q.length; j = i++) {
            if ((q[i].y > py) !== (q[j].y > py) &&
                px < (q[j].x - q[i].x) * (py - q[i].y) / (q[j].y - q[i].y) + q[i].x)
                inside = !inside;
        }
        return inside;
    }
    function hitTest(sx, sy) {
        if (!objHidden.people) {           // people draw on top -> claim clicks first
            for (var i = M.chars.length - 1; i >= 0; i--) {
                var p = charScreen(M.chars[i]);
                if (Math.abs(sx - p.x) <= p.r + 2 && Math.abs(sy - p.y) <= p.r + 2)
                    return { kind: 'c', i: i };
            }
        }
        for (var k = buildings.length - 1; k >= 0; k--) {   // depth-sorted back-to-front
            var b = buildings[k];
            if (objHidden[b.cat]) continue;
            var q = blockPolys(b);
            if (pointInPoly(sx, sy, q.top) || pointInPoly(sx, sy, q.right) ||
                pointInPoly(sx, sy, q.left))
                return { kind: 'b', i: b.mi, b: b };
        }
        /* ground: inverse-project the click to the tile-space cell and ask
           the terrain for its top VISIBLE layer ('grass' is the base fill) */
        var wpt = CAM.screenToWorld(cam, sx, sy, VW, VH);
        var tp = CAM.worldToTile(wpt.x, wpt.y);
        var tx = Math.floor(tp.x), ty = Math.floor(tp.y);
        var tt = terrain.topTypeAt(tx, ty);
        return tt ? { kind: 't', x: tx, y: ty, type: tt } : null;
    }
    stage.addEventListener('click', function (e) {
        if (moved || overUI(e)) return;    // pan-drag and legend rows are not picks
        if (proposedOn && e.shiftKey) { proposeStreet(e); return; }
        var r = stage.getBoundingClientRect();
        var hit = hitTest(e.clientX - r.left, e.clientY - r.top);
        // BuildingTouched: play the tap anim once — on the block itself,
        // or on any tile of the lot under it (the prism only claims the
        // drawn faces; the lot is the building's touch target)
        if (hit && hit.kind === 'b') tapBuilding(hit.b);
        else if (hit && hit.kind === 't') {
            var bb = blockAtTile(hit.x, hit.y);
            if (bb) tapBuilding(bb);
        }
        // ground fills the whole plane — clicking the SAME tile again deselects
        if (hit && selected && hit.kind === 't' && selected.kind === 't' &&
            hit.x === selected.x && hit.y === selected.y && hit.type === selected.type)
            hit = null;
        setSel(hit);
    });

    /* ---- match / selection outlines ------------------------------------------ */
    function strokeQuad(pts, col, w) {
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (var k = 1; k < 4; k++) ctx.lineTo(pts[k].x, pts[k].y);
        ctx.closePath();
        ctx.strokeStyle = col;
        ctx.lineWidth = w;
        ctx.stroke();
    }
    function strokeRing(p, col, w) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r + 3, 0, 6.2832);
        ctx.closePath();
        ctx.strokeStyle = col;
        ctx.lineWidth = w;
        ctx.stroke();
    }
    function drawMarks() {
        var i, m, b;
        for (i = 0; i < Math.min(searchMatches.length, MATCH_DRAW_CAP); i++) {
            m = searchMatches[i];
            if (m.kind === 'b') {
                b = byMi[m.i];
                if (objHidden[b.cat]) continue;
                strokeQuad(blockPolys(b).top, 'rgba(106,169,217,0.9)', 2);
            } else if (!objHidden.people) {
                strokeRing(charScreen(M.chars[m.i]), 'rgba(106,169,217,0.9)', 2);
            }
        }
        if (selected) {
            if (selected.kind === 'b') {
                b = byMi[selected.i];
                var q = blockPolys(b);
                strokeQuad(q.top, '#f4d03f', 2.5);
                strokeQuad(q.right, '#f4d03f', 2.5);
                strokeQuad(q.left, '#f4d03f', 2.5);
            } else if (selected.kind === 'c') {
                strokeRing(charScreen(M.chars[selected.i]), '#f4d03f', 2.5);
            } else {
                strokeQuad(terrain.quad(cam, VW, VH, selected.x, selected.y),
                    '#f4d03f', 2.5);
            }
        }
    }

    /* ---- search ---------------------------------------------------------------- */
    search.addEventListener('input', function () {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(doSearch, 120);
    });
    search.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && searchMatches.length) {
            setSel(searchMatches[0]);
            centerSel();
            e.preventDefault();
        }
        if (e.key === 'Escape') { search.value = ''; doSearch(); }
        e.stopPropagation();               // arrows/Esc while typing must not pan
    });
    /* ---- result list (right pane, under the details card) --------------------
       Matches are grouped by catalog id (thousands of tree/decor instances
       collapse to one row each), ranked exact-then-prefix-then-substring,
       and capped. A row click selects its first instance and centers it. */
    function resultGroups() {
        var map = {}, order = [];
        for (var i = 0; i < searchMatches.length; i++) {
            var m = searchMatches[i];
            var id = m.kind === 'b' ? M.buildings[m.i][0] : M.chars[m.i][0];
            var key = m.kind + ':' + id;
            var g = map[key];
            if (!g) {
                g = map[key] = {
                    kind: m.kind, id: id, n: 0, first: m.i,
                    name: m.kind === 'b'
                        ? (M.binfo[id] ? M.binfo[id][0] : 'unknown #' + id)
                        : (M.charNames[id] || 'char #' + id)
                };
                order.push(g);
            }
            g.n++;
        }
        var q = searchQ;
        function rank(g) {                       // exact id/name first, then prefix, then rest
            var nm = g.name.toLowerCase();
            if (q === String(g.id) || nm === q) return 0;
            if (nm.indexOf(q) === 0) return 1;
            return 2;
        }
        order.sort(function (a, b) {
            return rank(a) - rank(b) ||
                a.name.localeCompare(b.name) ||
                (a.kind === b.kind ? 0 : a.kind === 'b' ? -1 : 1);
        });
        return order;
    }
    function renderResults() {
        if (!searchMatches.length) { results.innerHTML = ''; return; }
        var gs = resultGroups();
        var rows = ['<div class="reshead"><b>' + gs.length + '</b> item' +
            (gs.length === 1 ? '' : 's') + ' &middot; click to select &amp; center</div>'];
        for (var i = 0; i < Math.min(gs.length, RESULT_CAP); i++) {
            var g = gs[i];
            var sw = g.kind === 'b' ? M.pal[g.id % M.pal.length] : M.charcol;
            rows.push('<button type="button" class="res" data-kind="' + g.kind +
                '" data-id="' + g.id + '">' +
                '<span class="sw" style="background:rgb(' + sw.join(',') + ')"></span>' +
                esc(g.name) + ' <b class="n">' + g.n + '&times;</b>' +
                ' <span class="cid">#' + g.id + '</span></button>');
        }
        if (gs.length > RESULT_CAP)
            rows.push('<div class="dim">&hellip;and ' + (gs.length - RESULT_CAP) +
                ' more &mdash; refine the search</div>');
        results.innerHTML = rows.join('');
        markResultSel();
    }
    function markResultSel() {
        var btns = results.querySelectorAll('button.res');
        var selId = selCatalogId();
        for (var i = 0; i < btns.length; i++) {
            var on = !!selected && btns[i].getAttribute('data-kind') === selected.kind &&
                +btns[i].getAttribute('data-id') === selId;
            btns[i].classList.toggle('sel', on);
        }
    }
    results.addEventListener('click', function (e) {
        var btn = e.target.closest && e.target.closest('button.res');
        if (!btn) return;
        var kind = btn.getAttribute('data-kind');
        var id = +btn.getAttribute('data-id');
        for (var i = 0; i < searchMatches.length; i++) {
            var m = searchMatches[i];
            var mid = m.kind === 'b' ? M.buildings[m.i][0] : M.chars[m.i][0];
            if (m.kind === kind && mid === id) {
                setSel({ kind: kind, i: m.i });
                centerSel();
                return;
            }
        }
    });

    function doSearch() {
        var q = search.value.trim().toLowerCase();
        searchQ = q;
        searchMatches = [];
        if (!q) { matchinfo.textContent = ''; results.innerHTML = ''; markDirty(); return; }
        for (var i = 0; i < M.buildings.length; i++) {
            var b = M.buildings[i], e = M.binfo[b[0]];
            var hay = e ? (e[0] + ' ' + (e[1] || '') + ' ' + (e[2] || '')).toLowerCase() : '';
            if ((q === String(b[0]) || hay.indexOf(q) >= 0) && !objHidden[catOfMi[i]])
                searchMatches.push({ kind: 'b', i: i });
        }
        if (!objHidden.people) {
            for (var j = 0; j < M.chars.length; j++) {
                var c = M.chars[j];
                var nm = (M.charNames[c[0]] || '').toLowerCase();
                if (q === String(c[0]) || nm.indexOf(q) >= 0)
                    searchMatches.push({ kind: 'c', i: j });
            }
        }
        matchinfo.textContent = searchMatches.length + ' match' +
            (searchMatches.length === 1 ? '' : 'es') +
            (searchMatches.length ? ' — Enter centers first' : '');
        renderResults();
        markDirty();
    }

    /* ---- view buttons -------------------------------------------------------- */
    function setOn(id) {
        ['btn-rest', 'btn-springfield', 'btn-downtown', 'btn-full', 'btn-ocean',
         'btn-reset'].forEach(function (b) {
            $(b).classList.toggle('on', b === id);
        });
    }
    function usePreset(fn, id) { fn(); lastPreset = fn; setOn(id); markDirty(); }
    $('btn-rest').addEventListener('click', function () { usePreset(presetRest, 'btn-rest'); });
    $('btn-springfield').addEventListener('click', function () {
        usePreset(presetSpringfield, 'btn-springfield');
    });
    $('btn-downtown').addEventListener('click', function () { usePreset(presetDowntown, 'btn-downtown'); });
    $('btn-full').addEventListener('click', function () { usePreset(presetFull, 'btn-full'); });
    $('btn-ocean').addEventListener('click', function () { usePreset(presetOcean, 'btn-ocean'); });
    $('btn-reset').addEventListener('click', function () {
        usePreset(presetDowntown, 'btn-downtown');
        setSel(null);
        search.value = '';
        doSearch();
    });

    /* ---- orientation buttons + paste-back readout --------------------------- */
    function setOrient(o) {
        CAM.ORIENT = { fx: o.fx, fy: o.fy, swap: o.swap };
        try { localStorage.setItem(ORIENT_KEY, JSON.stringify(CAM.ORIENT)); } catch (e) { /* private mode */ }
        var wasHidden = Object.keys(terrain.hidden);   // legend toggles survive a rig press
        terrain = new CityTerrain(M, { speckleFilter: speckOn, roadNetwork: roadNetOn });   // re-sort features under new ORIENT
        wasHidden.forEach(function (t) { terrain.setVisible(t, false); });
        if (grassImg) terrain.grassImg = grassImg;
        applyRoadSheet();
        applySheetArtMode();                   // the Road-art toggle survives a rig press
        applyRoadNetMode();                    // ...and so does the road-network model
        buildBuildings();                      // re-key + re-sort building depth
        if (lastPreset) lastPreset();          // re-frame the preset in the new projection
        updateOrientReadout();
        markDirty();
    }
    function updateOrientReadout() {
        var o = CAM.ORIENT;
        $('orientread').textContent = 'ORIENT = { fx: ' + o.fx + ', fy: ' + o.fy +
            ', swap: ' + o.swap + ' }';
    }
    $('btn-rot').addEventListener('click', function () { setOrient(CAM.orientRotate90(CAM.ORIENT)); });
    $('btn-flip').addEventListener('click', function () { setOrient(CAM.orientMirror(CAM.ORIENT)); });

    /* ---- road sheet art toggle (M4 TODO item 1) -------------------------------
       Ships OFF (flat Phase-1 roads); the button cycles OFF -> uniform
       sheet (state 0) -> neighbour-selected sheet (kerb/sidewalk edge
       states, Terrain#sheetSelect='neighbor') -> neighbour + experimental
       procedural N–S avenues (Terrain#useAvenues — the game's template
       streets that are missing from the save road layer, notes/06 s10)
       and persists 0..3 in localStorage so a reload keeps your A/B.
       Corrected 2026-10-17: the road cell is now the RE'd RoadDrawer
       state 0 = (-1,7) full asphalt with the engine's inset 127x66
       sampling box (was the state-4 paving composite (-1,4)); the
       neighbour mode implements the RE'd selector's connectivity-nibble
       model (states 1/3/4/5/8, Terrain.SHEET_TABLE). See terrain.js
       Terrain#useSheetArt + notes/06 s10. */
    var SHEETART_KEY = 'mrsnrub.cityview.sheetart';
    var sheetArtMode = 0;   // 0 off, 1 uniform sheet, 2 neighbour, 3 neighbour+avenues
    function applySheetArtMode() {
        terrain.useSheetArt = sheetArtMode > 0;
        terrain.sheetSelect = sheetArtMode >= 2 ? 'neighbor' : 'uniform';
        terrain.useAvenues = sheetArtMode === 3;
        var b = $('btn-sheetart');
        if (b) {
            b.classList.toggle('on', sheetArtMode > 0);
            b.textContent = sheetArtMode === 3 ? 'Road art·av' :
                sheetArtMode === 2 ? 'Road art·edges' : 'Road art';
        }
    }
    (function loadSheetArt() {
        try { sheetArtMode = parseInt(localStorage.getItem(SHEETART_KEY), 10) || 0; } catch (e) { /* private mode */ }
        if (!(sheetArtMode >= 0 && sheetArtMode <= 3)) sheetArtMode = 0;
        applySheetArtMode();
    })();
    if ($('btn-sheetart')) $('btn-sheetart').addEventListener('click', function () {
        sheetArtMode = (sheetArtMode + 1) % 4;
        try { localStorage.setItem(SHEETART_KEY, String(sheetArtMode)); } catch (e) { /* private mode */ }
        applySheetArtMode();
        markDirty();
    });

    /* ---- 1-wide N-S fragment debug overlay (M4 TODO 1b support) -----------
       Magenta diamonds mark saved road cells isolated along x but stacked
       along y — the 1-wide N-S access fragments (driveway/frontage stubs,
       notes/06 s10) — so they can be eyeballed against the export and
       told apart from the 2-wide streets. Terrain#debugFrags; persisted
       so the A/B survives reload. */
    var FRAGS_KEY = 'mrsnrub.cityview.frags';
    var fragsOn = false;
    function applyFragsMode() {
        terrain.debugFrags = fragsOn;
        var b = $('btn-frags');
        if (b) b.classList.toggle('on', fragsOn);
    }
    (function loadFrags() {
        try { fragsOn = localStorage.getItem(FRAGS_KEY) === '1'; } catch (e) { /* private mode */ }
        applyFragsMode();
    })();
    if ($('btn-frags')) $('btn-frags').addEventListener('click', function () {
        fragsOn = !fragsOn;
        try { localStorage.setItem(FRAGS_KEY, fragsOn ? '1' : '0'); } catch (e) { /* private mode */ }
        applyFragsMode();
        markDirty();
    });

    /* ---- road network model toggle (2026-10-19) -------------------------------
       A/B for Terrain#roadNetwork (terrain.js): reads ROADS as an orthogonal
       4-connected network — speckle singles anchored only through ORTHOGONAL
       contact with 'P' ground, and 'P'-derived tiles painted as solid plaza
       interiors (sheet state 0, no kerb). The usual eye-test is Road art
       cycled to "edges" (neighbour sheet selection) with this button
       flipped: the plaza boundary tiles lose their spurious kerb strips. */
    function applyRoadNetMode() {
        terrain.setRoadNetwork(roadNetOn);
        var b = $('btn-roadnet');
        if (b) b.classList.toggle('on', roadNetOn);
    }
    applyRoadNetMode();   // sync the button with the persisted flag (ctor already applied it)
    if ($('btn-roadnet')) $('btn-roadnet').addEventListener('click', function () {
        roadNetOn = !roadNetOn;
        try { localStorage.setItem(ROADNET_KEY, roadNetOn ? '1' : '0'); } catch (e) { /* private mode */ }
        applyRoadNetMode();
        markDirty();
    });

    /* ---- candidate-street verdict tool (M4, 2026-10-18) ----------------------
       Eye-test harness for the procedural N–S streets (notes/06 §10, "Road
       system-of-record, CLOSED"): shows CityTerrain.PROPOSED as verdict-tinted
       cells (Terrain#showProposed) and lists them in #proplegend with
       ok / bad / pending buttons. When served over HTTP the candidate list
       + verdicts come from api/streets.php (SQLite) and verdict clicks
       POST there; offline (file://, or the API is down) the page falls
       back to the built-in CityTerrain.PROPOSED list and localStorage verdicts.
       Shift+clicking the map while the overlay is on proposes a new
       2-wide street at the clicked grid column (y-range = current view).
       Promoting an 'ok' street into Terrain.AVENUE.streets stays a manual
       per-street edit. */
    var PROPSW_KEY = 'mrsnrub.cityview.propshow';
    var PROPVR_KEY = 'mrsnrub.cityview.propverdicts';
    var proposedOn = false;
    var propApi = false;              // true once api/streets.php answered
    function localVerdicts() {
        try { return JSON.parse(localStorage.getItem(PROPVR_KEY)) || {}; }
        catch (e) { return {}; }
    }
    function applyProposedMode() {
        terrain.showProposed = proposedOn;
        var b = $('btn-proposed');
        if (b) b.classList.toggle('on', proposedOn);
        var p = $('proplegend');
        if (p) p.style.display = proposedOn ? '' : 'none';
    }
    function propTint(v) {
        return v === 'ok' ? 'rgb(70,220,120)' :
            v === 'bad' ? 'rgb(230,70,70)' : 'rgb(0,200,255)';
    }
    function escAttr(s) {
        return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
            .replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function buildPropPanel() {
        var el = $('proplegend');
        if (!el) return;
        var S = CityTerrain.PROPOSED.streets, rows = [];
        var counts = { ok: 0, bad: 0, pending: 0 };
        for (var i = 0; i < S.length; i++) {
            var st = S[i];
            var v = CityTerrain.PROPOSED.verdicts[st.id] || 'pending';
            counts[v === 'ok' || v === 'bad' ? v : 'pending']++;
            rows.push('<button type="button" class="row" data-pid="' + st.id +
                '" data-tip="' + escAttr(st.src || '') + '">' +
                '<span class="sw" style="background:' + propTint(v) + '"></span>' +
                'x ' + st.x0 + '\u2013' + st.x1 + ' \u00b7 y ' + st.ylo +
                '\u2013' + st.yhi +
                ' <b class="n">' + v + '</b>' +
                '<b class="go" data-act="go" style="pointer-events:auto">\u2316</b></button>');
        }
        el.innerHTML = '<span class="head">candidate streets ' +
            '(' + counts.ok + ' ok / ' + counts.bad + ' bad / ' +
            counts.pending + ' pending' + (propApi ? ' \u00b7 sqlite' : ' \u00b7 local') +
            ')</span>' + rows.join('');
        var btns = el.querySelectorAll('button.row');
        for (var j = 0; j < btns.length; j++) {
            (function (btn) {
                var id = parseInt(btn.getAttribute('data-pid'), 10);
                btn.addEventListener('click', function (e) {
                    var t = e && e.target;
                    if (t && t.classList && t.classList.contains('go')) {
                        gotoStreet(id);       // ⌖ = center camera on the street
                        return;
                    }
                    var cur = CityTerrain.PROPOSED.verdicts[id];
                    // cycle: pending -> ok -> bad -> pending
                    var next = !cur ? 'ok' : (cur === 'ok' ? 'bad' : 'pending');
                    setPropVerdict(id, next);
                });
                // row mouseover -> Terrain#hoverProposed: that street repaints
                // loud yellow with outlines, the rest dim to ghost alpha
                btn.addEventListener('mouseenter', function () {
                    terrain.hoverProposed = id;
                    markDirty();
                });
                btn.addEventListener('mouseleave', function () {
                    if (terrain.hoverProposed === id) terrain.hoverProposed = null;
                    markDirty();
                });
            })(btns[j]);
        }
    }
    function gotoStreet(id) {
        var S = CityTerrain.PROPOSED.streets;
        for (var i = 0; i < S.length; i++) {
            if (S[i].id !== id) continue;
            var st = S[i];
            if (!proposedOn) {              // the point is to SEE the street
                proposedOn = true;
                try { localStorage.setItem(PROPSW_KEY, '1'); } catch (e) { /* private mode */ }
                applyProposedMode();
            }
            // grid -> town tile midpoint; rest zoom frames ~20 tiles wide
            centerOnTile((st.x0 + st.x1 + 1) / 2 - M.ox,
                (st.ylo + st.yhi + 1) / 2 - M.oy);
            cam.zoom = CAM.ZOOM.rest;
            markDirty();
            return;
        }
    }
    function setPropVerdict(id, verdict) {
        var lv = localVerdicts();
        if (verdict === 'pending') delete lv[id]; else lv[id] = verdict;
        try { localStorage.setItem(PROPVR_KEY, JSON.stringify(lv)); }
        catch (e) { /* private mode */ }
        if (verdict === 'pending') delete CityTerrain.PROPOSED.verdicts[id];
        else CityTerrain.PROPOSED.verdicts[id] = verdict;
        if (propApi && typeof fetch === 'function') {
            fetch('api/streets.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'verdict', id: id, verdict: verdict })
            }).catch(function () { /* offline mirror already saved */ });
        }
        buildPropPanel();
        markDirty();
    }
    function applyLocalVerdicts() {
        var lv = localVerdicts();
        for (var id in lv)
            if (Object.prototype.hasOwnProperty.call(lv, id))
                CityTerrain.PROPOSED.verdicts[id] = lv[id];
    }
    function refreshProposed() {
        if (!propApi || typeof fetch !== 'function') return;
        fetch('api/streets.php', { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
            .then(function (d) {
                if (!d || !Array.isArray(d.streets) || !d.streets.length) return;
                CityTerrain.PROPOSED.streets = d.streets.map(function (s) {
                    return {
                        id: +s.id, x0: +s.x0, x1: +s.x1,
                        ylo: +s.ylo, yhi: +s.yhi, src: s.src || ''
                    };
                });
                for (var vid in CityTerrain.PROPOSED.verdicts)
                    if (Object.prototype.hasOwnProperty.call(CityTerrain.PROPOSED.verdicts, vid))
                        delete CityTerrain.PROPOSED.verdicts[vid];
                if (d.verdicts)
                    for (var id in d.verdicts)
                        if (Object.prototype.hasOwnProperty.call(d.verdicts, id))
                            CityTerrain.PROPOSED.verdicts[id] = d.verdicts[id];
                applyLocalVerdicts();           // offline edits win until re-POST
                buildPropPanel();
                markDirty();
            })
            .catch(function () { /* keep current list */ });
    }
    function proposeStreet(e) {
        var r = stage.getBoundingClientRect();
        var w = CAM.screenToWorld(cam, e.clientX - r.left, e.clientY - r.top, VW, VH);
        var t = CAM.worldToTile(w.x, w.y);
        var gx = Math.floor(t.x) + M.ox, gy = Math.floor(t.y) + M.oy;
        var T = terrain.visibleTileRect(cam, VW, VH);
        var ylo = Math.max(0, Math.min(T.y0, gy) + M.oy);
        var yhi = Math.min(1086, Math.max(T.y1, gy) + M.oy);
        if (propApi && typeof fetch === 'function') {
            fetch('api/streets.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'add', x0: gx, x1: gx + 1, ylo: ylo, yhi: yhi,
                    src: 'user shift+click @ y' + gy
                })
            }).then(function (r2) { return r2.ok ? r2.json() : Promise.reject(); })
                .then(refreshProposed)
                .catch(function () { /* server said no; nothing to show */ });
        } else {
            var S = CityTerrain.PROPOSED.streets;
            for (var i = 0; i < S.length; i++)
                if (S[i].x0 === gx && S[i].ylo === ylo) return;   // dedupe
            S.push({
                id: -((Date.now() / 1000) | 0) % 1000000,
                x0: gx, x1: gx + 1, ylo: ylo, yhi: yhi,
                src: 'user shift+click @ y' + gy + ' (local — offline)'
            });
            buildPropPanel();
            markDirty();
        }
    }
    (function initProposed() {
        try { proposedOn = localStorage.getItem(PROPSW_KEY) === '1'; }
        catch (e) { /* private mode */ }
        applyLocalVerdicts();
        applyProposedMode();
        buildPropPanel();                       // built-in list, sync
        if (typeof fetch === 'function') {      // server list wins when present
            fetch('api/streets.php', { cache: 'no-store' })
                .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
                .then(function (d) {
                    if (d && Array.isArray(d.streets) && d.streets.length) {
                        propApi = true;
                        refreshProposed();
                    }
                })
                .catch(function () { /* built-in list stays */ });
        }
    })();
    if ($('btn-proposed')) $('btn-proposed').addEventListener('click', function () {
        proposedOn = !proposedOn;
        try { localStorage.setItem(PROPSW_KEY, proposedOn ? '1' : '0'); }
        catch (e) { /* private mode */ }
        applyProposedMode();
        markDirty();
    });

    /* ---- HUD ---------------------------------------------------------------- */
    /* Two overlay panels of toggle buttons: #legend = ground layers
       (Terrain#setVisible), #objlegend = object buckets (objHidden,
       CityObjects.classify) + people. Both share this builder; rows are
       real buttons (keyboard accessible) with the data-tip convention. */
    function togglePanel(el, head, items, isOff, setVis) {
        var rows = ['<span class="head">' + head + '</span>'];
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            rows.push('<button type="button" class="row" data-type="' + it.key +
                '" aria-pressed="true" data-tip="click to hide/show this layer">' +
                '<span class="sw" style="background:rgb(' + it.rgb.join(',') + ')"></span>' +
                it.key + (it.count != null ? ' <b class="n">' + it.count + '</b>' : '') +
                '</button>');
        }
        el.innerHTML = rows.join('');
        var btns = el.querySelectorAll('button.row');
        for (var j = 0; j < btns.length; j++) {
            (function (btn) {
                btn.addEventListener('click', function () {
                    var t = btn.getAttribute('data-type');
                    var show = isOff(t);                      // toggle
                    setVis(t, show);
                    btn.setAttribute('aria-pressed', show ? 'true' : 'false');
                    btn.classList.toggle('off', !show);
                    markDirty();
                });
            })(btns[j]);
        }
    }
    function buildLegend() {
        var items = [{ key: 'grass', rgb: M.grass }];
        for (var i = 0; i < M.layers.length; i++)
            items.push({ key: M.layers[i].n, rgb: M.layers[i].c });
        togglePanel($('legend'), 'ground', items,
            function (t) { return terrain.isHidden(t); },
            function (t, on) {
                terrain.setVisible(t, on);
                // a tile whose layer was just hidden must not stay selected
                if (!on && selected && selected.kind === 't' && selected.type === t)
                    setSel(null);
            });
        /* Speckle-filter row (notes/01 "Filler grids"): appended with the
           same .row button markup so it matches the layer toggles. ON
           (default) hides the engine-generated filler — the whole SAND
           lattice (the diamonds south of the GiantRobot), the park-path
           DIRT_ROADS + KLSROAD single tiles, and road dashes not
           anchored to a 'P' full-segment — so the row is a live
           before/after A/B of the filter. Persisted in localStorage. */
        var fbtn = document.createElement('button');
        fbtn.type = 'button';
        fbtn.className = 'row';
        fbtn.setAttribute('data-tip',
            'hide engine-generated filler grids: SAND lattice, park-path/KLSROAD ' +
            'singles, road dashes not touching a full road segment');
        fbtn.innerHTML = '<span class="sw" style="background:#b9a76a"></span>speckle filter';
        function markSpeck() {
            fbtn.setAttribute('aria-pressed', terrain.speckleFilter ? 'true' : 'false');
            fbtn.classList.toggle('off', !terrain.speckleFilter);
        }
        fbtn.addEventListener('click', function () {
            speckOn = !terrain.speckleFilter;
            terrain.setSpeckleFilter(speckOn);
            try { localStorage.setItem(SPECK_KEY, speckOn ? '1' : '0'); }
            catch (e) { /* private mode */ }
            // filler tiles must not stay selected once filtered out
            if (speckOn && selected && selected.kind === 't') setSel(null);
            markSpeck();
            markDirty();
        });
        markSpeck();
        $('legend').appendChild(fbtn);
    }
    function buildObjLegend() {
        var counts = CityObjects.countCats(M.buildings, M.binfo);
        var items = [{ key: 'buildings', rgb: M.pal[0], count: counts[CityObjects.FALLBACK] }];
        for (var i = 0; i < CityObjects.CATS.length; i++)
            items.push({ key: CityObjects.CATS[i].key, rgb: CityObjects.CATS[i].sw,
                count: counts[CityObjects.CATS[i].key] });
        items.push({ key: 'people', rgb: M.charcol, count: M.chars.length });
        togglePanel($('objlegend'), 'objects', items,
            function (t) { return !!objHidden[t]; },
            function (t, on) {
                if (on) delete objHidden[t]; else objHidden[t] = true;
                bAtlas = null;          // orbit LOD blits per-bucket canvases
                // an element on a hidden bucket must not stay selected/outlined
                if (!on && selected) {
                    if (selected.kind === 'c' && t === 'people') setSel(null);
                    else if (selected.kind === 'b' && byMi[selected.i].cat === t) setSel(null);
                }
            });
        /* Walk-paths row (notes/06 "Walk-path oracle"): cyan polylines =
           the save's cached character walks; amber bands = candidate
           streets distilled from the walks that do NOT sit on any saved
           road (grid x≡3 / y≡0 mod 4 lattice). Label carries the census
           size so the oracle's yield is visible at a glance. */
        if (M.walks && M.walks.length && typeof CityWalks !== 'undefined') {
            var wbtn = document.createElement('button');
            wbtn.type = 'button';
            wbtn.className = 'row';
            wbtn.setAttribute('data-tip',
                'cyan = cached character walk paths from the save (pathCache); ' +
                'amber = candidate template streets they reveal (off saved roads, ' +
                'grid x\u22613 mod 4 cols / y\u22610 mod 4 rows)');
            var nc = walkCensus ? walkCensus.cols.length : 0,
                nr = walkCensus ? walkCensus.rows.length : 0;
            wbtn.innerHTML = '<span class="sw" style="background:#00e5ff"></span>walk paths' +
                ' <b class="n">' + M.walks.length + ' \u00b7 ' + nc + 'c/' + nr + 'r</b>';
            function markWalk() {
                wbtn.setAttribute('aria-pressed', walksOn ? 'true' : 'false');
                wbtn.classList.toggle('off', !walksOn);
            }
            wbtn.addEventListener('click', function () {
                walksOn = !walksOn;
                try { localStorage.setItem(WALK_KEY, walksOn ? '1' : '0'); }
                catch (e) { /* private mode */ }
                markWalk();
                markDirty();
            });
            markWalk();
            $('objlegend').appendChild(wbtn);
        }
        /* Coordinate-marker textarea (js/markers.js): a second row under
           the object toggles. parse-on-input keeps markerPts fresh for
           render(); the raw text persists so the list survives reloads.
           .legend rows are pointer-events:auto, and keydown/pan both
           early-return on INPUT/TEXTAREA targets, so typing never pans
           the map or steals arrow keys. */
        if (typeof CityMarkers !== 'undefined') {
            var head = document.createElement('div');
            head.className = 'mhead';
            head.textContent = 'mark tiles';
            var ta = document.createElement('textarea');
            ta.id = 'markinput';
            ta.rows = 2;
            ta.spellcheck = false;
            ta.placeholder = '(120,12) (116,20) …';
            ta.value = markerText;
            ta.setAttribute('data-tip',
                'paste tile coordinates — every pair is marked with a yellow ' +
                'diamond; town tiles, the same numbers the tile-grid hover ' +
                'readout shows (grid = town + ' + M.ox + ',' + M.oy + ')');
            var mstat = document.createElement('div');
            mstat.className = 'mstat';
            function updateStat() {
                mstat.textContent = markerPts.length
                    ? markerPts.length + ' marked · '
                      + 'double-click a mark to centre' : '';
            }
            ta.addEventListener('input', function () {
                markerPts = CityMarkers.parse(ta.value);
                try { localStorage.setItem(MARKER_KEY, ta.value); }
                catch (e) { /* private mode */ }
                updateStat();
                markDirty();
            });
            updateStat();
            $('objlegend').appendChild(head);
            $('objlegend').appendChild(ta);
            $('objlegend').appendChild(mstat);
        }
    }
    function buildStats() {
        $('statsbar').innerHTML =
            '<b>' + M.buildings.length.toLocaleString() + '</b> buildings · ' +
            '<b>' + M.chars.length + '</b> characters · ' +
            '<b>' + buildings.length + '</b> drawn · ' +
            '<b id="perfread">…</b>';              // frame diagnostics (loop)
    }

    /* ---- resize -------------------------------------------------------------- */
    function resize() {
        dpr = window.devicePixelRatio || 1;
        VW = stage.clientWidth; VH = stage.clientHeight;
        cv.width = Math.round(VW * dpr); cv.height = Math.round(VH * dpr);
        markDirty();
    }
    window.addEventListener('resize', resize);

    /* ---- boot ---------------------------------------------------------------- */
    buildLegend();
    buildObjLegend();
    buildStats();
    resize();
    presetSpringfield();
    lastPreset = presetSpringfield;
    setOn('btn-springfield');
    updateOrientReadout();
    requestAnimationFrame(loop);
})();
