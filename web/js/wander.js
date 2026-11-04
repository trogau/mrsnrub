/* wander.js — engine-replica idle wander for the city view.
   (2026-11-03, notes/13 "Idle wander RE")

   What the engine actually does (reverse-engineered from libscorpio.so + the
   shipped gamescripts data, notes/13): a character that is not on a job runs
   an engine-side IDLE WANDER loop, not a job script. The pieces:

     * the behaviour enum (parser 0xec0808, stored at behaviour struct +0x4c):
       0 Invalid, 1 RandomRelaxed, 2 RandomRush, 3 RandomHover, 4 JobLocation,
       5 JobLocationHover, 6 JobLocationWaitForScript, 7 Scripted, 8 Idle,
       9 Sneak, 10 RushAndRest, 11 CenterScreen. Only 46 of the 412 shipped
       <Character> definitions name one, so plain characters — Homer, Marge,
       Bart — get the built-in default, RandomRelaxed. This port applies
       RandomRelaxed to every character without a <MovementBehavior mode>.
     * the path cost grid: settings.xml <RoadGridSettings> ships one pathCost
       per RoadType (klroad 10, sidewalk/boardwalk/pier 15, dirtedge 16,
       road 18, dirtroad/cobblestone 19, pavement 24, grass 32, none/river/
       ocean/cliff 196, wall/outofbounds 99999). Roads are CHEAP and grass is
       twice the price, which is the whole reason idle characters hug the
       streets — no rule says "walk on the road", the cost table does it.
       <PreferredGridType>/<AvoidGridType> bias the same table.
     * the script API: Character::startIdleMovement (0x39c97b),
       Character::stopMovement (0x3b3b3c), Character::isMovementIdle
       (0x3a64cc), Movement::randomMove (0x3b89ba); the search contexts
       GridMapSearchContext / RoadOnlySearchContext / BoardwalkOnlySearchContext
       are the "wander anywhere" vs "stick to the streets" variants.
     * speed: <WalkSpeed speed="N"> per character (20..75, mode 50), clamped
       into settings.xml <WalkDefaultSpeeds slow="0.9" fast="2.0">.

   The engine's own dwell/target values are still unmeasured (no shipped XML
   sets them and the strings are gone), so every one of those is a NAMED KNOB
   below (CityWander.KNOBS) seeded from the recovered data — change the number,
   not the code.

   Model: each character is a two-state machine, IDLE (stand at its post for a
   randomised dwell) and WALK (follow an A* polyline to a tile picked around
   that post, then dwell again). Targets ring the character's SAVE position so
   the crowd never migrates out of its neighbourhood. Positions are written
   back into the M.chars rows the caller passed in, so the renderer, the click
   hit-test and the details card all follow the walker; setEnabled(false)
   restores the save's positions.

   Pure: no DOM, no network, no camera. `node -e "require('./wander.js')"`
   is safe. */
'use strict';

(function (global) {

    /* settings.xml <RoadGridSettings> pathCost table (gamescripts-r343174).
       Kept verbatim so the tuning is auditable against the file; the keys are
       the engine's RoadType names. */
    var ROAD_COST = {
        none: 196, road: 18, sidewalk: 15, grass: 32, river: 196,
        pavement: 24, ocean: 196, shoreline: 196, outofbounds: 99999,
        boardwalk: 15, boardwalkedge: 21, beach: 40, klroad: 10,
        klroadedge: 18, klparking: 64, wall: 99999, cliff: 196, pier: 15,
        pieredge: 21, dirtroad: 19, dirtedge: 16, dirtpavement: 25,
        cobblestone: 19, cobblestoneedge: 16
    };
    /* the viewer's terrain.js layer names -> the engine's RoadType. terrain.js
       has no plaza/pavement layer of its own ('P' cells are the road layer),
       and its 'sand' is the beach band landinfo.xml stamps. */
    var LAYER_ROAD_TYPE = {
        road: 'road', klsroad: 'klroad', dirtroad: 'dirtroad',
        boardwalk: 'boardwalk', pier: 'pier',
        sand: 'beach', dirt: 'dirtroad', river: 'river', ocean: 'ocean'
    };
    var WALL = 99999;

    /* Unrecovered-from-the-binary values live here as named knobs, seeded
       from the recovered data (notes/13 "Knobs vs evidence"). */
    var KNOBS = {
        speedBase: 1.3,          // tiles/s at <WalkSpeed speed="50">
        speedMin: 0.9,           // <WalkDefaultSpeeds slow>
        speedMax: 2.0,           // <WalkDefaultSpeeds fast>
        dwellMin: 6,             // s standing at the post between walks
        dwellMax: 24,
        rangeMin: 3,             // target ring around the post, tiles
        rangeMax: 22,
        homeChance: 0.18,        // next hop is straight back to the post
        tries: 12,               // target samples per hop before giving up
        maxNodes: 2200,          // A* expansion cap per hop
        maxSearch: 2,            // A* runs per tick, so a crowd settling at
                                 // once cannot spike a single frame
        maxCost: 100,            // above this a tile is a wall (the 196-entry
                                 // water/cliff costs never make it into a path)
        buildingCost: 99999,     // placed-building footprints (the engine's wall)
        minPath: 2,              // drop hops shorter than this many tiles
        retryDelay: 2.5,         // s to wait before re-rolling a failed hop
        postSeek: 3,             // tiles to look for a walkable post tile
        fallbackMode: 'RandomRelaxed'   // what an unnamed/scripted mode gets
    };
    /* Per-mode feel. The enum is the engine's; the multipliers are port
       knobs (the shipped XML says which mode, not how fast it feels). */
    var MODES = {
        RandomRelaxed: { speed: 1.0, dwell: 1.0, range: 1.0 },
        RandomRush: { speed: 1.7, dwell: 0.45, range: 1.5 },
        RandomHover: { speed: 0.8, dwell: 0.7, range: 0.35 },
        Sneak: { speed: 0.65, dwell: 1.2, range: 0.6 },
        RushAndRest: { speed: 1.5, dwell: 1.6, range: 1.3 },
        /* the job/cutscene modes have no jobs or cameras to honour here, so
           they fall through to fallbackMode (RandomRelaxed) */
        JobLocation: null, JobLocationHover: null,
        JobLocationWaitForScript: null, Scripted: null,
        Idle: null, CenterScreen: null, Invalid: null
    };
    var ST_IDLE = 0, ST_WALK = 1;

    function lower(s) { return String(s || '').toLowerCase(); }
    /* the shipped XML mixes cases ("sneak" 124x, "Sneak" 7x) */
    var MODE_BY_LOWER = {};
    (function () {
        for (var k in MODES) if (Object.prototype.hasOwnProperty.call(MODES, k))
            MODE_BY_LOWER[lower(k)] = MODES[k];
    })();

    function hash32(s) {
        var h = 0;
        for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
        return Math.abs(h);
    }
    /* deterministic per-character pseudo-random stream (mulberry32), seeded
       off the save id so the crowd is never in lockstep but a reload of the
       same save walks the same way */
    function rng(seed) {
        var a = seed >>> 0;
        return function () {
            a = (a + 0x6D2B79F5) >>> 0;
            var t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    /* ---- Terrain/occupancy helpers ------------------------------------------ */
    /* one binary heap for every A* run (reset per search) */
    function Heap() {
        this.k = [];        // node keys
        this.f = [];        // priorities
    }
    Heap.prototype.reset = function () { this.k.length = 0; this.f.length = 0; };
    Heap.prototype.push = function (key, pri) {
        var k = this.k, f = this.f, i = k.length;
        k.push(key); f.push(pri);
        while (i > 0) {
            var p = (i - 1) >> 1;
            if (f[p] <= f[i]) break;
            var tk = k[p]; k[p] = k[i]; k[i] = tk;
            var tf = f[p]; f[p] = f[i]; f[i] = tf;
            i = p;
        }
    };
    Heap.prototype.pop = function () {
        var k = this.k, f = this.f, n = k.length - 1;
        var top = k[0];
        k[0] = k[n]; f[0] = f[n]; k.pop(); f.pop();
        var i = 0;
        for (;;) {
            var l = i * 2 + 1, r = l + 1, m = i;
            if (l < n && f[l] < f[m]) m = l;
            if (r < n && f[r] < f[m]) m = r;
            if (m === i) break;
            var tk = k[m]; k[m] = k[i]; k[i] = tk;
            var tf = f[m]; f[m] = f[i]; f[i] = tf;
            i = m;
        }
        return top;
    };
    Heap.prototype.size = function () { return this.k.length; };

    function CityWander(opts) {
        opts = opts || {};
        this.chars = opts.chars || [];
        this.terrain = opts.terrain || null;
        this.speeds = opts.speeds || null;        // WALK_DATA.chars
        this.typeNames = opts.typeNames ||
            (global.CityTerrain && global.CityTerrain.TYPE_ORDER) || [];
        this.typeIdx = {};                        // layer name -> terrain index
        for (var i = 0; i < this.typeNames.length; i++)
            this.typeIdx[this.typeNames[i]] = i;
        this.knobs = {};
        for (var kk in KNOBS)
            if (Object.prototype.hasOwnProperty.call(KNOBS, kk))
                this.knobs[kk] = (opts.knobs && opts.knobs[kk] !== undefined)
                    ? opts.knobs[kk] : KNOBS[kk];

        this.home = [];                           // save positions to restore
        this.st = [];                             // per-char state (lazy)
        this.costs = {};                          // "x,y" -> pathCost
        this.occ = {};                            // "x,y" -> 1 (building lot)
        this.enabled = false;
        this.stats = { walkers: 0, stuck: 0, walking: 0, hops: 0, failed: 0 };
        this._heap = new Heap();
        this.buildObstacles(opts.buildings);
        this._capture();
    }

    /* save positions + the obstacle grid. Building footprints are the
       engine's wall tiles: M.buildings rows are
       [id, ..., w, h, flip, pivotX, pivotY] and the lot rect is
       [px, py-h) x [py, py+w) — the same rect the viewer draws the prism on. */
    CityWander.prototype.buildObstacles = function (rows) {
        this.occ = {};
        this.costs = {};                          // obstacle change invalidates
        if (!rows) return;
        for (var i = 0; i < rows.length; i++) {
            var b = rows[i];
            var x0 = Math.floor(b[6]), y0 = Math.floor(b[7] - b[4]),
                x1 = Math.ceil(b[6] + b[3]), y1 = Math.ceil(b[7]);
            for (var x = x0; x < x1; x++)
                for (var y = y0; y < y1; y++)
                    this.occ[x + ',' + y] = 1;
        }
    };

    CityWander.prototype._capture = function () {
        var c = this.chars;
        this.home.length = 0;
        for (var i = 0; i < c.length; i++)
            this.home.push([c[i][1], c[i][2]]);
        this.st = new Array(c.length);
        this.stats.walkers = 0;
        this.stats.stuck = 0;
    };

    /* ---- cost grid ---------------------------------------------------------- */
    /* One pathCost per tile, memoised. terrain.typesAt gives the LAYER indices
       painted on the tile; the cheapest painted surface wins (a bridge tile is
       both road and river — you walk the road), and a bare tile is the
       engine's grass. Buildings and everything past the town's land bounds are
       the wall/outofbounds entry, so the crowd stays on the streets without
       any explicit "roads only" rule. */
    CityWander.prototype.costAt = function (x, y) {
        var key = x + ',' + y;
        var c = this.costs[key];
        if (c !== undefined) return c;
        c = this._cost(x, y);
        this.costs[key] = c;
        return c;
    };
    CityWander.prototype._cost = function (x, y) {
        var k = this.knobs;
        if (x < -1000 || x > 2900 || y < -1000 || y > 2900)
            return WALL;                          // outside the packed key range
        if (this.occ[x + ',' + y]) return k.buildingCost;
        var t = this.terrain, best = ROAD_COST.grass, hit = 0;
        if (t && t.typesAt) {
            var a = t.typesAt(x, y);
            for (var i = 0; i < a.length; i++) {
                var name = this.typeNames[a[i]];
                var rt = LAYER_ROAD_TYPE[name];
                if (!rt) continue;
                hit = 1;
                var c = ROAD_COST[rt];
                if (c < best) best = c;
            }
            if (!hit && t.bbox && (x < t.bbox.x0 - 2 || x > t.bbox.x1 + 2 ||
                                   y < t.bbox.y0 - 2 || y > t.bbox.y1 + 2))
                return WALL;                      // past every painted feature
        }
        return best;
    };
    CityWander.prototype.walkable = function (x, y) {
        return this.costAt(x, y) <= this.knobs.maxCost;
    };

    /* nearest walkable tile to (x,y) within postSeek — a character whose save
       position sits on a lot or a decoration steps out to the street first */
    CityWander.prototype._post = function (x, y) {
        var tx = Math.floor(x), ty = Math.floor(y);
        if (this.walkable(tx, ty)) return [tx, ty];
        var r = this.knobs.postSeek;
        for (var d = 1; d <= r; d++)
            for (var dy = -d; dy <= d; dy++)
                for (var dx = -d; dx <= d; dx++) {
                    if (Math.max(Math.abs(dx), Math.abs(dy)) !== d) continue;
                    if (this.walkable(tx + dx, ty + dy))
                        return [tx + dx, ty + dy];
                }
        return null;
    };

    /* ---- A* over the cost grid --------------------------------------------- */
    /* 4-neighbour only: the template street lattice is axis-aligned
       (notes/06), so diagonals would cut corners through blocks and stop the
       crowd hugging the kerbs. */
    var DX = [1, -1, 0, 0], DY = [0, 0, 1, -1];
    CityWander.prototype.findPath = function (sx, sy, tx, ty) {
        var k = this.knobs, H = this._heap;
        var g = {}, from = {}, closed = {};      // per-search: never stale
        /* numeric node keys: (x,y) packed, so the open list never builds a
           string. ±1024/4096 covers the whole town frame (notes/01). */
        function KY(x, y) { return ((x + 1024) << 12) | (y + 1024); }
        var start = KY(sx, sy), goal = KY(tx, ty);
        if (start === goal) return null;
        if (!this.walkable(tx, ty)) return null;
        H.reset();
        g[start] = 0; from[start] = -1; closed[start] = 0;
        H.push(start, (Math.abs(tx - sx) + Math.abs(ty - sy)) *
            ROAD_COST.klroad);                    // admissible: cheapest tile
        var seen = 1, cur;
        while (H.size()) {
            cur = H.pop();
            if (closed[cur] === 2) continue;
            closed[cur] = 2;
            if (cur === goal) break;
            if (++seen > k.maxNodes) return null;
            var cx = (cur >> 12) - 1024, cy = (cur & 4095) - 1024;
            for (var n = 0; n < 4; n++) {
                var nx = cx + DX[n], ny = cy + DY[n], nk = KY(nx, ny);
                var c = this.costAt(nx, ny);
                if (c > k.maxCost) continue;
                var ng = g[cur] + c;
                if (g[nk] !== undefined && ng >= g[nk]) continue;
                g[nk] = ng; from[nk] = cur; closed[nk] = 1;
                H.push(nk, ng + (Math.abs(tx - nx) + Math.abs(ty - ny)) *
                     ROAD_COST.klroad);
            }
        }
        if (g[goal] === undefined) return null;
        var path = [], node = goal, hops = 0;
        while (node >= 0 && node !== start && hops++ < 4096) {
            path.push([(node >> 12) - 1024 + 0.5, (node & 4095) - 1024 + 0.5]);
            node = from[node];
        }
        path.reverse();
        return path.length >= k.minPath ? path : null;
    };

    /* ---- per-character state ------------------------------------------------ */
    CityWander.prototype._mode = function (rec) {
        var name = rec && rec.mode;
        var m = name ? MODE_BY_LOWER[lower(name)] : undefined;
        if (m === undefined || m === null)
            m = MODE_BY_LOWER[lower(this.knobs.fallbackMode)] || MODES.RandomRelaxed;
        return m;
    };
    CityWander.prototype._speed = function (rec, m) {
        var k = this.knobs;
        var sp = (rec && rec.speed) || 50;
        var tps = k.speedBase * (sp / 50) * m.speed;
        return Math.min(k.speedMax * m.speed, Math.max(k.speedMin, tps));
    };

    CityWander.prototype._init = function (i) {
        var c = this.chars[i], s = {}, k = this.knobs;
        var rec = this.speeds && this.speeds[c[0]];
        s.mode = this._mode(rec);
        s.speed = this._speed(rec, s.mode);
        s.rnd = rng(hash32(String(c[0])) + i * 7919);
        var p = this._post(c[1], c[2]);
        if (!p) {                                 // pets in the sea, off-land
            s.skip = 1;
            this.stats.stuck++;
        } else {
            s.hx = p[0]; s.hy = p[1];
            if (this.costAt(Math.floor(c[1]), Math.floor(c[2])) > k.maxCost) {
                c[1] = p[0] + 0.5; c[2] = p[1] + 0.5;   // step out of the water
            }
            this.stats.walkers++;
        }
        s.st = ST_IDLE;
        s.t = s.rnd() * this.knobs.dwellMax;      // stagger the crowd's starts
        this.st[i] = s;
        return s;
    };

    CityWander.prototype._pickTarget = function (s) {
        var k = this.knobs, r = s.rnd;
        if (r() < k.homeChance) return [s.hx, s.hy];
        var span = k.rangeMax - k.rangeMin;
        for (var a = 0; a < k.tries; a++) {
            var rad = k.rangeMin + r() * span;
            var ang = r() * Math.PI * 2;
            var tx = Math.round(s.hx + Math.cos(ang) * rad * s.mode.range);
            var ty = Math.round(s.hy + Math.sin(ang) * rad * s.mode.range);
            if (tx === s.hx && ty === s.hy) continue;
            if (this.walkable(tx, ty)) return [tx, ty];
        }
        return null;
    };

    CityWander.prototype._depart = function (i, s) {
        var k = this.knobs;
        if (this._searches >= k.maxSearch) {      // spread the crowd's replans
            s.t = 0.25;
            return;
        }
        this._searches++;
        var t = this._pickTarget(s);
        if (!t) { s.t = k.retryDelay; return; }
        var path = this.findPath(Math.floor(this.chars[i][1]),
                                 Math.floor(this.chars[i][2]), t[0], t[1]);
        if (!path) {                              // water or a block in the way
            this.stats.failed++;
            s.t = k.retryDelay;
            return;
        }
        s.path = path; s.pi = 0; s.trav = 0;
        var d0x = path[0][0] - this.chars[i][1], d0y = path[0][1] - this.chars[i][2];
        var d0 = Math.sqrt(d0x * d0x + d0y * d0y) || 1;
        s.vx = d0x / d0; s.vy = d0y / d0;
        s.dir = this.dirOf(s.vx, s.vy);
        s.st = ST_WALK;
        this.stats.hops++;
    };

    CityWander.prototype._arrive = function (i, s, x, y) {
        var c = this.chars[i];
        c[1] = x; c[2] = y;
        s.st = ST_IDLE; s.path = null;
        var k = this.knobs;
        s.t = (k.dwellMin + s.rnd() * (k.dwellMax - k.dwellMin)) * s.mode.dwell;
    };

    /* ---- public API --------------------------------------------------------- */
    /* Advance the simulation by dt seconds. Returns true when any character
       moved (the caller repaints). Cheap: one pass over the crowd, and an
       A* run only happens when a dwell expires. */
    CityWander.prototype.tick = function (dt) {
        if (!this.enabled || !(dt > 0)) return false;
        this._searches = 0;
        var moved = false, n = this.chars.length, walking = 0;
        for (var i = 0; i < n; i++) {
            var s = this.st[i] || this._init(i);
            if (s.skip) continue;
            if (s.st === ST_IDLE) {
                s.t -= dt;
                if (s.t <= 0) this._depart(i, s);
                continue;
            }
            var k = this.knobs;
            s.trav += dt * s.speed;
            var c = this.chars[i], px = c[1], py = c[2];
            while (s.trav > 0 && s.pi < s.path.length) {
                var q = s.path[s.pi];
                var dx = q[0] - px, dy = q[1] - py;
                var d = Math.sqrt(dx * dx + dy * dy);
                if (d < 1e-6) { s.pi++; continue; }
                s.vx = dx / d; s.vy = dy / d;
                s.dir = this.dirOf(s.vx, s.vy);
                if (s.trav >= d) { px = q[0]; py = q[1]; s.trav -= d; s.pi++; }
                else { px += dx * (s.trav / d); py += dy * (s.trav / d); s.trav = 0; }
            }
            if (s.pi >= s.path.length) { this._arrive(i, s, px, py); }
            else { c[1] = px; c[2] = py; }
            walking++;
            moved = true;
        }
        this.stats.walking = walking;
        return moved;
    };

    /* tile-space movement direction. The engine ships <name>_front_walk /
       _back_walk cells and, for some skins, _left/_right variants; the viewer
       maps the movement vector through the camera to pick one. Tile-space
       dy<0 is "up the screen" in the shipped orientation (notes/06 §9), so
       back is the away-facing cell. */
    CityWander.prototype.dirOf = function (vx, vy) {
        if (Math.abs(vy) >= Math.abs(vx)) return vy < 0 ? 'back' : 'front';
        return vx < 0 ? 'left' : 'right';
    };

    /* the walk state of one character: null when it is standing at its post
       (the caller draws the idle cell), else {dir, speed} while walking */
    CityWander.prototype.get = function (i) {
        var s = this.st[i];
        if (!this.enabled || !s || s.skip || s.st !== ST_WALK) return null;
        return s;
    };

    CityWander.prototype.setEnabled = function (on) {
        on = !!on;
        if (on === this.enabled) return;
        this.enabled = on;
        if (!on) this.restore();
    };

    /* put every character back on its save position (toggle off, harness) */
    CityWander.prototype.restore = function () {
        for (var i = 0; i < this.chars.length; i++) {
            var h = this.home[i];
            if (!h) continue;
            this.chars[i][1] = h[0];
            this.chars[i][2] = h[1];
            if (this.st[i]) { this.st[i].st = ST_IDLE; this.st[i].path = null; }
        }
        this.stats.walking = 0;
    };

    /* re-seed after the data set changes (a new save loaded into the page) */
    CityWander.prototype.reset = function (rows) {
        if (rows) this.buildObstacles(rows);
        this.stats.hops = 0; this.stats.failed = 0;
        this._capture();
    };

    CityWander.prototype.info = function () {
        return { enabled: this.enabled, walkers: this.stats.walkers,
                 stuck: this.stats.stuck, walking: this.stats.walking,
                 hops: this.stats.hops, failed: this.stats.failed,
                 tiles: Object.keys(this.costs).length,
                 knobs: this.knobs };
    };

    CityWander.KNOBS = KNOBS;
    CityWander.MODES = MODES;
    CityWander.ROAD_COST = ROAD_COST;
    CityWander.LAYER_ROAD_TYPE = LAYER_ROAD_TYPE;

    global.CityWander = CityWander;
    if (typeof module !== 'undefined' && module.exports)
        module.exports = CityWander;

})(typeof window !== 'undefined' ? window : globalThis);
