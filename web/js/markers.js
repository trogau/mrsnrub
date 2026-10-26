/* markers.js — paste-in coordinate highlighting (City View bottom-right bar).

   The evidence workflow is "I have a handful of tile coordinates from an
   analysis — show them to me in the map" (e.g. the five `riversData`
   cells that survived the speckle census, notes/01 "riversData is
   building-adjacent scatter"). City View's objects legend therefore
   carries a textarea; every coordinate pair typed or pasted into it is
   drawn as a yellow diamond on the ground.

   Coordinates are TOWN tiles — the same system the tile-grid hover
   readout, the walk overlay and the inspector use (grid = town + 12,136
   via MAP_DATA.ox/oy), so a value that appears in the "hover x,y"
   readout pastes straight back in. parse() is deliberately tolerant:
   "(130,20) (144,17)", "130,20\n144,17" and
   "town 130/20, 144/17; 128, 36" all yield the same pairs. */
(function (globalThis) {
    'use strict';

    var FILL = 'rgba(244, 208, 63, 0.35)';
    var EDGE = '#f4d03f';

    /* -> [[x, y], ...] in input order, duplicates kept.
       -? pairs every signed integer, then steps two at a time, so a
       trailing unpaired number is dropped rather than mis-read. */
    function parse(text) {
        var nums = String(text == null ? '' : text).match(/-?\d+/g) || [];
        var out = [];
        for (var i = 0; i + 1 < nums.length; i += 2)
            out.push([parseInt(nums[i], 10), parseInt(nums[i + 1], 10)]);
        return out;
    }

    /* one tile diamond [x,x+1)×[y,y+1) + its centre cross; cam/vw/vh/T as
       in CityWalks.draw (T = Terrain#visibleTileRect, skipped when the
       tile is off-screen) */
    function draw(ctx, CAM, pts, cam, vw, vh, T) {
        if (!pts || !pts.length) return;
        ctx.save();
        ctx.font = '11px monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        for (var i = 0; i < pts.length; i++) {
            var x = pts[i][0], y = pts[i][1];
            if (T && (x + 1 < T.x0 || x > T.x1 || y + 1 < T.y0 || y > T.y1))
                continue;
            var cs = [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]], k, p;
            ctx.beginPath();
            for (k = 0; k < 4; k++) {
                var t = CAM.tileToWorld(cs[k][0], cs[k][1]);
                p = CAM.worldToScreen(cam, t.x, t.y, vw, vh);
                if (k) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
            }
            ctx.closePath();
            ctx.fillStyle = FILL;
            ctx.strokeStyle = EDGE;
            ctx.lineWidth = 1.5;
            ctx.fill();
            ctx.stroke();
            var c = CAM.tileToWorld(x + 0.5, y + 0.5);
            var q = CAM.worldToScreen(cam, c.x, c.y, vw, vh);
            ctx.beginPath();
            ctx.moveTo(q.x - 4, q.y); ctx.lineTo(q.x + 4, q.y);
            ctx.moveTo(q.x, q.y - 4); ctx.lineTo(q.x, q.y + 4);
            ctx.stroke();
            ctx.lineWidth = 3;
            ctx.strokeStyle = 'rgba(10,14,22,0.9)';
            ctx.strokeText(x + ',' + y, q.x + 7, q.y - 5);
            ctx.strokeStyle = EDGE;
            ctx.lineWidth = 1;
            ctx.strokeText(x + ',' + y, q.x + 7, q.y - 5);
        }
        ctx.restore();
    }

    var API = { parse: parse, draw: draw, FILL: FILL, EDGE: EDGE };
    globalThis.CityMarkers = API;
    if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
