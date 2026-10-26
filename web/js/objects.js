/* objects.js — object-category classifier for the City View object legend
   (Phase 2, M3). Companion to js/terrain.js (ground) and js/camera.js.

   WHY HEURISTICS: the save catalog (MAP_DATA.binfo) carries no category
   field — binfo is [name, asset, slug, x, z, locX, locY, height, kind, tier],
   and 'kind' is only the asset/flip flag. So the buckets below are derived
   from the *name*, which is a workbench aid for isolating clutter, not the
   game's own taxonomy (that lives in the server asset XMLs).

   METHOD: split a name on CamelCase/digits into words, singularise, and
   look each word up in a per-bucket word set. Buckets are tried in the
   order of CATS; the first bucket with a word hit wins; everything else
   falls through to 'buildings' (the right default — named landmarks like
   KrustyBurger / PowerPlant are buildings, and this avoids the substring
   traps a plain regex hits: PowerPlant contains "plant", BartsTreehouse
   contains "tree"). Characters (people) are a separate save layer, not
   catalogued here; the legend shows them as their own row. */
(function () {
    'use strict';

    function words(name) {
        return String(name)
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')   // BoardwalkLampPost -> …
            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // ABCDef -> ABC Def
            .split(/[^A-Za-z0-9]+/)
            .filter(Boolean)
            .map(function (w) { return w.toLowerCase(); });
    }
    /* crude singulariser; length guards keep bus->bu, gas->ga */
    function singular(w) {
        if (/ies$/.test(w)) return w.replace(/ies$/, 'y');
        if (/es$/.test(w) && w.length > 4) return w.replace(/es$/, '');
        if (/s$/.test(w) && w.length > 3) return w.replace(/s$/, '');
        return w;
    }
    function set(s) {
        var o = {}, a = s.split(/\s+/);
        for (var i = 0; i < a.length; i++) if (a[i]) o[a[i]] = 1;
        return o;
    }

    /* Bucket order = classify() precedence (vehicles first so e.g.
       "Houseboat" beats any decor word). Legend order is chosen by the
       caller; sw is the panel swatch colour. */
    var CATS = [
        { key: 'vehicles', sw: [196, 132, 96], words: set(
            'car truck bus boat ship yacht van motorcycle scooter sled plane jet blimp ' +
            'zeppelin airship submarine kayak canoe raft train locomotive trolley ' +
            'golfcart cart helicopter barge ferry houseboat rocket streetcrawler wagon ' +
            'taxi sedan limo snowmobile speedboat ambulance spaceship aircraft carrier float kart') },
        { key: 'rail', sw: [120, 120, 128], words: set(
            'monorail track') },                       // KL monorail only
        { key: 'nature', sw: [96, 176, 88], words: set(
            'tree shrub bush hedge flower palm bonsai grass moss fern cactus vine ivy ' +
            'topiary log stump mushroom rock boulder stone hill cliff pond coral shell ' +
            'kelp seaweed anemone starfish whale shark dolphin lobster crab squid octopus ' +
            'fish bird flamingo owl eagle turkey penguin bear sheep goat pig deer moose ' +
            'squirrel butterfly bee snail frog snake spider snowman pumpkin holly ' +
            'mistletoe evergreen sapling sprout leaf acorn reindeer') },
        { key: 'decor', sw: [206, 178, 106], words: set(
            'lamp lamppost streetlight bench fence wall gate sign banner flag statue ' +
            'balloon arch trash trashcan dumpster bin crate box umbrella table chair ' +
            'carpet rug mat awning mooring planter barrel pallet ladder slide swing ' +
            'seesaw merrygoround picnic cooler tent stall vending mailbox hydrant ' +
            'billboard poster graffiti cone bucket pipe buoy anchor railing bollard ' +
            'pillar column fountain gazebo birdbath pigeon gargoyle vase urn lantern ' +
            'torch candle cauldron wreath garland nativity santa icicle popsicle kerbing ' +
            'barrier barricade pump tire meter washer dryer toilet sink bathtub mattress ' +
            'couch sofa bookcase piano drum guitar saxophone trumpet microscope telescope ' +
            'magnifying glass cannon skeleton dinosaur pylon antenna radar globe clock ' +
            'sundial flagpole crosswalk speedbump dish') }
    ];
    var FALLBACK = 'buildings';
    var cache = Object.create(null);

    /* bucket key for one catalog name (memoised) */
    function classify(name) {
        var hit = cache[name];
        if (hit) return hit;
        var ws = words(name), i, j;
        hit = FALLBACK;
        for (i = 0; i < CATS.length && hit === FALLBACK; i++)
            for (j = 0; j < ws.length; j++)
                if (CATS[i].words[singular(ws[j])]) { hit = CATS[i].key; break; }
        cache[name] = hit;
        return hit;
    }

    /* { key -> instance count } over MAP_DATA.buildings (rows of
       [typeId, x0, y0, dx, dy, …]; type id -> binfo name -> classify). */
    function countCats(buildings, binfo) {
        var out = {}, i, k;
        out[FALLBACK] = 0;
        for (i = 0; i < CATS.length; i++) out[CATS[i].key] = 0;
        for (i = 0; i < buildings.length; i++) {
            var info = binfo[buildings[i][0]];
            k = classify(info ? info[0] : '');
            out[k]++;
        }
        return out;
    }

    /* people: the save's character instances (M.chars = [typeId, x, y] —
       exact float world positions in town tile units, the feet-on-ground
       point) as ground dots. The caller draws them after the buildings, so
       they read on top regardless of depth (workbench simplification).
       T = terrain.visibleTileRect. */
    var PEOPLE_R = 3;                     // dot radius, CSS px, at scale 40
    function drawPeople(ctx, CAM, chars, col, cam, vw, vh, T) {
        var r = Math.max(1.6, PEOPLE_R * Math.min(2.2, CAM.scale(cam) / 40));
        ctx.fillStyle = 'rgb(' + col.join(',') + ')';
        /* one path for the whole crowd: every dot shares the fill style,
           so per-dot beginPath/fill was pure call overhead (871 fills at
           whole-town zoom). Subpaths + a single fill are identical here. */
        ctx.beginPath();
        for (var i = 0; i < chars.length; i++) {
            var c = chars[i];
            if (c[1] < T.x0 - 1 || c[1] > T.x1 + 1 || c[2] < T.y0 - 1 || c[2] > T.y1 + 1)
                continue;
            var w = CAM.tileToWorld(c[1], c[2]);
            var p = CAM.worldToScreen(cam, w.x, w.y, vw, vh);
            ctx.moveTo(p.x + r, p.y - r);
            ctx.lineTo(p.x - r, p.y - r);
            ctx.lineTo(p.x - r, p.y + r);
            ctx.lineTo(p.x + r, p.y + r);
            ctx.closePath();
        }
        ctx.fill();
    }

    var API = { CATS: CATS, classify: classify, countCats: countCats,
        words: words, FALLBACK: FALLBACK, drawPeople: drawPeople,
        PEOPLE_R: PEOPLE_R };
    globalThis.CityObjects = API;
    if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
