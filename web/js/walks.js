/* walks.js — cached client walk paths: debug overlay + street census.
   (2026-10-19, notes/06 "Walk-path oracle")

   MAP_DATA.walks are the save's characterData.pathCache polylines: the
   client's own cached walks, integer town waypoints, strictly
   axis-aligned. Characters only walk on streets, so ~90% of the cached
   segments ride the UNSAVED template road grid — they are coordinate
   evidence for the client-generated avenues/streets the pb never
   stores (the same conclusion the eye-test avenue table reached, but
   from data). City View renders them via draw() behind the "walk
   paths" object-legend row; census() distills them into candidate
   street lines:

     * a segment counts only when BOTH endpoints are off every SAVED
       road tile (8-neighbour probe on Terrain#_roadOccAll, the raw
       save roads — speckle filter must not skew the census),
     * V candidates sit on town x = 3 (mod 4), H candidates on town
       y = 0 (mod 4) — the template block lattice (landinfo.xml
       LandBlockSize/LandBlockPosition, notes/06), which is also where
       every measured walk line actually landed,
     * a line becomes a candidate at >= MIN_SEG segments. */
(function (globalThis) {
    'use strict';

    var MIN_SEG = 5;            // segments before a line is a candidate
    var WALK_STYLE = 'rgba(0, 229, 255, 0.55)';   // cached walk polylines
    var CAND_STYLE = 'rgba(255, 214, 10, 0.14)';  // candidate street bands
    var CAND_EDGE = 'rgba(255, 214, 10, 0.55)';   // candidate centre line

    /* roadOcc: {"x,y":1} of raw SAVED road tiles, TOWN-keyed exactly as
       Terrain#_roadOccAll builds them (decodeCells x/y + 0..3 span).
       Walk tiles are town-keyed too (verified 2026-10-25: with the
       calibrated cell origin, 80.7% of rasterised walk tiles land on
       saved road cells) — so the probe is a direct lookup; an earlier
       build added M.ox/M.oy here, which probed 12/136 tiles away and
       let on-road segments leak into the census. */
    function makeOnRoad(roadOcc) {
        return function (tx, ty) {
            for (var dy = -1; dy <= 1; dy++)
                for (var dx = -1; dx <= 1; dx++)
                    if (roadOcc[(tx + dx) + ',' + (ty + dy)]) return true;
            return false;
        };
    }

    /* walks -> {cols:[{x,y0,y1,n}], rows:[{y,x0,x1,n}]} sorted by n desc.
       x/y are TOWN tile coords — same frame draw() feeds tileToWorld,
       and the phases hold in it (V lines land on x = 3 mod 4, H lines
       on y = 0 mod 4; ox/oy are multiples of 4 so the grid->town map is
       phase-invariant). (ox/oy args are accepted but ignored — kept for
       caller compatibility.) */
    function census(walks, roadOcc) {
        var onRoad = makeOnRoad(roadOcc);
        var cols = {}, rows = {}, i, w;
        for (i = 0; i < walks.length; i++) {
            w = walks[i];
            for (var j = 0; j + 3 < w.length; j += 2) {
                var ax = w[j], ay = w[j + 1], bx = w[j + 2], by = w[j + 3];
                if (onRoad(ax, ay) || onRoad(bx, by)) continue;
                if (ay === by) {
                    var gy = ay;
                    if (gy % 4 !== 0) continue;
                    var r = rows[gy] || (rows[gy] = { y: gy, n: 0, x0: Infinity, x1: -Infinity });
                    r.n++;
                    r.x0 = Math.min(r.x0, ax); r.x1 = Math.max(r.x1, bx);
                } else if (ax === bx) {
                    var gx = ax;
                    if (((gx % 4) + 4) % 4 !== 3) continue;
                    var c = cols[gx] || (cols[gx] = { x: gx, n: 0, y0: Infinity, y1: -Infinity });
                    c.n++;
                    c.y0 = Math.min(c.y0, ay); c.y1 = Math.max(c.y1, by);
                }
            }
        }
        function pack(map) {
            return Object.keys(map).map(function (k) { return map[k]; })
                .filter(function (o) { return o.n >= MIN_SEG; })
                .sort(function (a, b) { return b.n - a.n; });
        }
        return { cols: pack(cols), rows: pack(rows) };
    }

    /* Draw the walk polylines (cyan) plus, when given, one translucent
       amber band per candidate street line (grid coords) spanning the
       census extent. cam/vw/vh/T as in CityObjects.drawPeople. */
    function draw(ctx, CAM, walks, cam, vw, vh, T, cand) {
        var i, j, w, p, hit;
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = WALK_STYLE;
        ctx.beginPath();
        for (i = 0; i < walks.length; i++) {
            w = walks[i];
            hit = false;
            for (j = 0; j < w.length; j += 2)
                if (w[j] >= T.x0 - 2 && w[j] <= T.x1 + 2 &&
                    w[j + 1] >= T.y0 - 2 && w[j + 1] <= T.y1 + 2) { hit = true; break; }
            if (!hit) continue;
            for (j = 0; j < w.length; j += 2) {
                var t = CAM.tileToWorld(w[j] + 0.5, w[j + 1] + 0.5);
                p = CAM.worldToScreen(cam, t.x, t.y, vw, vh);
                if (j) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
            }
        }
        ctx.stroke();
        if (!cand) return;
        ctx.fillStyle = CAND_STYLE;
        ctx.strokeStyle = CAND_EDGE;
        ctx.lineWidth = 1;
        for (i = 0; i < cand.cols.length; i++) {
            var c = cand.cols[i];
            quadFill(ctx, CAM, cam, vw, vh, c.x - 0.5, c.y0 - 0.5, 1, c.y1 - c.y0 + 1);
        }
        for (i = 0; i < cand.rows.length; i++) {
            var r = cand.rows[i];
            quadFill(ctx, CAM, cam, vw, vh, r.x0 - 0.5, r.y - 0.5, r.x1 - r.x0 + 1, 1);
        }
    }

    /* one screen quad for a tile-space rect [x,x+w)×[y,y+h) — same
       cell-quad convention as terrain.js quad() */
    function quadFill(ctx, CAM, cam, vw, vh, x, y, w, h) {
        var cs = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], k, p;
        ctx.beginPath();
        for (k = 0; k < 4; k++) {
            var t = CAM.tileToWorld(cs[k][0], cs[k][1]);
            p = CAM.worldToScreen(cam, t.x, t.y, vw, vh);
            if (k) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
    }

    var API = { census: census, draw: draw, MIN_SEG: MIN_SEG,
        WALK_STYLE: WALK_STYLE, CAND_STYLE: CAND_STYLE };
    globalThis.CityWalks = API;
    if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
