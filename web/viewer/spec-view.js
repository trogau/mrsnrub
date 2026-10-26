/* spec-view.js — standalone ground-truth road viewer (test page).
   Renders ONLY what road-spec.json defines: the saved road-layer cell
   grid (embedded by tools/gen_spec_view_data.py into spec-view-data.js).
   No MAP_DATA, no terrain.js, no Pixi: grass + the 1,647 spec cells,
   each as ONE 4x4-tile cell quad. Nibble cells (E=1,W=2,N=4,S=8) get
   the main-road presentation: asphalt core + a carriageway stub per
   connected edge, footpath flanking everywhere else. 'P' cells are
   pavement — uniform grey slabs with no footpath art.

   Same camera as the City View pages: camera.js CAM (ORIENT {1,-1,1},
   2:1 oblique, wheel zoom at cursor, drag pan + fling). Cell (c,r)
   covers town tiles [CELL_OX+4c .. +4) x [CELL_OY+4r .. +4); the tile-
   exact origin (0,-112) comes from the walk/building-oracle calibration
   (see terrain.js header), stride per the spec's tile_layout. */
'use strict';

(function () {
    var S = window.ROAD_SPEC;
    var $ = function (id) { return document.getElementById(id); };
    var stats = $('statsbar');
    if (!S || typeof CAM === 'undefined') {
        stats.textContent = 'spec-view-data.js or camera.js failed to load ' +
            '(regenerate the data: python3 tools/gen_spec_view_data.py)';
        return;
    }

    var stage = $('stage'), cv = $('cv'), ctx = cv.getContext('2d');
    var dpr = 1, VW = 0, VH = 0;

    /* palette (this page's own — nothing imported) */
    var GRASS = 'rgb(74,128,66)', ASPHALT = '#5c5c62';
    var FOOT = '#9c9ca3';                       // footpath strip flanks
    var PAVE = '#7e7e85';                       // 'P' = uniform pavement
    var STUB = '#ffe86e', END_RED = '#eb4646', JCT_ORANGE = '#ff9628';

    /* ---- camera (shared City View model) ------------------------------------ */
    var cam = CAM.createCamera({ zoom: CAM.ZOOM.rest });
    window.__SPEC_cam = cam;                 // console/harness hook

    /* road bbox in town tiles, straight off the grid (for Fit) */
    var BB = (function () {
        var c0 = 1e9, c1 = -1e9, r0 = 1e9, r1 = -1e9;
        for (var r = 0; r < S.rows; r++) {
            var row = S.grid[r];
            for (var c = 0; c < S.cols; c++)
                if (row.charCodeAt(c) !== 0x47) {          // 'G'
                    if (c < c0) c0 = c; if (c > c1) c1 = c;
                    if (r < r0) r0 = r; if (r > r1) r1 = r;
                }
        }
        return {
            x0: S.cell_ox + 4 * c0, y0: S.cell_oy + 4 * r0,
            x1: S.cell_ox + 4 * (c1 + 1), y1: S.cell_oy + 4 * (r1 + 1)
        };
    })();
    function fit() {
        CAM.fitTileRect(cam, { x0: BB.x0 - 2, y0: BB.y0 - 2,
            x1: BB.x1 + 2, y1: BB.y1 + 2 }, VW, VH);
        markDirty();
    }

    /* ---- view state (toggles) ------------------------------------------------- */
    var show = { stubs: true, labels: true, grid: false, tiles: false };
    function bindCb(id, key) {
        var b = $(id);
        b.checked = show[key];
        b.addEventListener('change', function () {
            show[key] = b.checked; markDirty();
        });
    }
    bindCb('cb-stubs', 'stubs'); bindCb('cb-labels', 'labels');
    bindCb('cb-grid', 'grid');   bindCb('cb-tiles', 'tiles');

    function orientReadout() {
        var o = CAM.ORIENT;
        $('orient').textContent = 'ORIENT = { fx: ' + o.fx + ', fy: ' + o.fy +
            ', swap: ' + o.swap + ' }  ·  zoom ' + cam.zoom.toFixed(3);
    }
    $('btn-fit').addEventListener('click', fit);
    $('btn-rest').addEventListener('click', function () {
        cam.zoom = CAM.ZOOM.rest; orientReadout(); markDirty();
    });
    $('btn-rot').addEventListener('click', function () {
        CAM.ORIENT = CAM.orientRotate90(CAM.ORIENT); orientReadout(); markDirty();
    });
    $('btn-flip').addEventListener('click', function () {
        CAM.ORIENT = CAM.orientMirror(CAM.ORIENT); orientReadout(); markDirty();
    });
    $('in-jump').addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        var m = /^\s*(\d+)\s*,\s*(\d+)\s*$/.exec(this.value);
        if (!m) { this.style.borderColor = '#eb4646'; return; }
        this.style.borderColor = '';
        var w = CAM.tileToWorld(S.cell_ox + 4 * +m[1] + 2, S.cell_oy + 4 * +m[2] + 2);
        cam.x = w.x; cam.y = w.y; cam.vx = cam.vy = 0;
        markDirty();
    });

    /* ---- render --------------------------------------------------------------- */
    var needsRender = true;
    function markDirty() { needsRender = true; }

    function resize() {
        dpr = Math.min(2, window.devicePixelRatio || 1);
        VW = stage.clientWidth; VH = stage.clientHeight;
        cv.width = Math.max(1, VW * dpr); cv.height = Math.max(1, VH * dpr);
        markDirty();
    }
    window.addEventListener('resize', resize);
    resize();

    /* quad of the tile rect [x,x+w) x [y,y+h): 4 screen corners
       [corner(x,y), (x+w,y), (x+w,y+h), (x,y+h)] — the same
       parallelogram terrain.js quad() draws for a cell */
    function quad(x, y, w, h) {
        var cs = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], out = [];
        for (var i = 0; i < 4; i++) {
            var t = CAM.tileToWorld(cs[i][0], cs[i][1]);
            out.push(CAM.worldToScreen(cam, t.x, t.y, VW, VH));
        }
        return out;
    }
    function fillQuad(q, col) {
        ctx.beginPath();
        ctx.moveTo(q[0].x, q[0].y); ctx.lineTo(q[1].x, q[1].y);
        ctx.lineTo(q[2].x, q[2].y); ctx.lineTo(q[3].x, q[3].y);
        ctx.closePath();
        ctx.fillStyle = col; ctx.fill();
    }

    /* visible town-tile rect from the four screen corners */
    function visibleTileRect() {
        var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        var cs = [[0, 0], [VW, 0], [0, VH], [VW, VH]];
        for (var i = 0; i < 4; i++) {
            var t = CAM.worldToTile(CAM.screenToWorld(cam, cs[i][0], cs[i][1], VW, VH).x,
                                    CAM.screenToWorld(cam, cs[i][0], cs[i][1], VW, VH).y);
            if (t.x < x0) x0 = t.x; if (t.x > x1) x1 = t.x;
            if (t.y < y0) y0 = t.y; if (t.y > y1) y1 = t.y;
        }
        return { x0: x0 - 4, y0: y0 - 4, x1: x1 + 4, y1: y1 + 4 };
    }

    function pc(m) { return (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1); }

    var hover = null;                       // {col,row,ch}
    function draw() {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = GRASS;
        ctx.fillRect(0, 0, VW, VH);

        var T = visibleTileRect();
        var c0 = Math.max(0, Math.floor((T.x0 - S.cell_ox) / 4) - 1),
            c1 = Math.min(S.cols - 1, Math.floor((T.x1 - S.cell_ox) / 4) + 1),
            r0 = Math.max(0, Math.floor((T.y0 - S.cell_oy) / 4) - 1),
            r1 = Math.min(S.rows - 1, Math.floor((T.y1 - S.cell_oy) / 4) + 1);

        var drawn = 0, stubW = 0;
        for (var r = r0; r <= r1; r++) {
            var row = S.grid[r];
            for (var c = c0; c <= c1; c++) {
                var ch = row.charCodeAt(c);
                if (ch === 0x47) continue;                  // 'G' empty
                ch = String.fromCharCode(ch);
                var x = S.cell_ox + 4 * c, y = S.cell_oy + 4 * r;
                var q = quad(x, y, 4, 4);
                var cx = (q[0].x + q[2].x) / 2, cy = (q[0].y + q[2].y) / 2;
                var cellPx = Math.abs(q[2].x - q[0].x);
                if (cellPx < 1.2) {                         // sub-pixel: fat dot
                    ctx.fillStyle = ch === 'P' ? PAVE : ASPHALT;
                    ctx.fillRect(cx - 1, cy - 1, 2, 2);
                    drawn++; continue;
                }
                var m = ch === 'P' ? -1 : ch.charCodeAt(0) - 97;
                if (ch === 'P') {
                    /* pavement: one uniform grey slab — footpath art is the
                       point of these tiles, nothing flanks them */
                    fillQuad(q, PAVE);
                    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
                    ctx.lineWidth = 1; ctx.stroke();
                } else if (cellPx >= 4) {
                    /* main-road presentation (road-lab tuned 2026-10-25):
                       carriageway 2.5 tiles wide on each axis, centred (axis
                       at 2), footpath strips 0.75 tiles along the sides.
                       Asphalt = central 2.5x2.5 core + a carriageway stub to
                       each connected edge; footpath base shows through on
                       the non-connected sides. Walk-oracle corroborated:
                       cached walks ride the footpath — on 'd' cells they
                       concentrate at sub-y 0, on 'm' cells at sub-x 3. */
                    var FW = 0.75;                          // footpath width
                    fillQuad(q, FOOT);                      // footpath base
                    var kerb = function (kx, ky, kw, kh) {
                        fillQuad(quad(kx, ky, kw, kh), ASPHALT);
                        ctx.strokeStyle = 'rgba(20,20,24,0.55)';
                        ctx.lineWidth = 1; ctx.stroke();    // kerb line
                    };
                    kerb(x + FW, y + FW, 4 - 2 * FW, 4 - 2 * FW);   // carriageway core
                    if (m & 1) kerb(x + 4 - FW, y + FW, FW, 4 - 2 * FW);  // E
                    if (m & 2) kerb(x, y + FW, FW, 4 - 2 * FW);          // W
                    if (m & 4) kerb(x + FW, y, 4 - 2 * FW, FW);          // N
                    if (m & 8) kerb(x + FW, y + 4 - FW, 4 - 2 * FW, FW); // S
                } else {
                    fillQuad(q, ASPHALT);                   // too small: flat
                }
                if (show.grid) {
                    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(q[0].x, q[0].y); ctx.lineTo(q[1].x, q[1].y);
                    ctx.lineTo(q[2].x, q[2].y); ctx.lineTo(q[3].x, q[3].y);
                    ctx.closePath(); ctx.stroke();
                }
                if (ch !== 'P') {
                    var k = pc(m);
                    if (show.stubs && m > 0) {
                        /* connection stubs: centre -> edge midpoint per set bit
                           (E=1 W=2 N=4 S=8; rows grow south so N = -y) */
                        stubW = Math.max(1.5, cellPx * 0.13);
                        ctx.strokeStyle = STUB; ctx.lineWidth = stubW;
                        ctx.lineCap = 'round';
                        ctx.beginPath();
                        var mid;
                        if (m & 1) { mid = pt2(x + 4, y + 2); ctx.moveTo(cx, cy); ctx.lineTo(mid.x, mid.y); }
                        if (m & 2) { mid = pt2(x, y + 2); ctx.moveTo(cx, cy); ctx.lineTo(mid.x, mid.y); }
                        if (m & 4) { mid = pt2(x + 2, y); ctx.moveTo(cx, cy); ctx.lineTo(mid.x, mid.y); }
                        if (m & 8) { mid = pt2(x + 2, y + 4); ctx.moveTo(cx, cy); ctx.lineTo(mid.x, mid.y); }
                        ctx.stroke();
                    }
                    if (m === 0 || k <= 1) {                // isolated / dead end
                        ctx.fillStyle = END_RED;
                        ctx.beginPath();
                        ctx.arc(cx, cy, Math.max(2, cellPx * 0.10), 0, 6.2832);
                        ctx.fill();
                    } else if (k >= 3) {                    // T-junction / cross
                        ctx.fillStyle = JCT_ORANGE;
                        ctx.beginPath();
                        ctx.arc(cx, cy, Math.max(2, cellPx * 0.10), 0, 6.2832);
                        ctx.fill();
                    }
                }
                if (show.labels && cellPx > 20) {
                    ctx.font = '11px ui-monospace, monospace';
                    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                    ctx.fillStyle = 'rgba(0,0,0,.75)';
                    ctx.fillText(ch, cx + 1, cy + 1);
                    ctx.fillStyle = '#fff';
                    ctx.fillText(ch, cx, cy);
                }
                if (show.tiles && cellPx > 44) {            // 4x4 tile lattice
                    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    for (var i = 1; i < 4; i++) {
                        var a = pt2(x + i, y), b = pt2(x + i, y + 4);
                        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
                        a = pt2(x, y + i); b = pt2(x + 4, y + i);
                        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
                    }
                    ctx.stroke();
                }
                drawn++;
            }
        }
        /* hover outline (spec coordinate readout lives in the stats bar) */
        if (hover) {
            var hx = S.cell_ox + 4 * hover.col, hy = S.cell_oy + 4 * hover.row;
            var hq = quad(hx, hy, 4, 4);
            ctx.strokeStyle = '#ff00d0'; ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(hq[0].x, hq[0].y); ctx.lineTo(hq[1].x, hq[1].y);
            ctx.lineTo(hq[2].x, hq[2].y); ctx.lineTo(hq[3].x, hq[3].y);
            ctx.closePath(); ctx.stroke();
        }
        orientReadout();
        stats.innerHTML = 'cells <b>' + S.rows + '×' + S.cols + '</b> grid, ' +
            'spec total <b>1,647</b>' +
            '<i>drawn ' + drawn + '</i>' +
            '<i>origin (' + S.cell_ox + ',' + S.cell_oy + ') stride ' + S.cell_stride + '</i>' +
            (hover ? '<i>cell ' + hover.col + ',' + hover.row + ' = <b>' + hover.ch +
                '</b>' + (hover.ch === 'P' ? ' pavement (uniform grey)'
                    : hover.ch !== 'G'
                    ? ' mask ' + (hover.ch.charCodeAt(0) - 97).toString(2).padStart(4, '0') +
                      ' (E' + (hover.ch.charCodeAt(0) - 97 & 1 ? 1 : 0) +
                      ' W' + (hover.ch.charCodeAt(0) - 97 & 2 ? 1 : 0) +
                      ' N' + (hover.ch.charCodeAt(0) - 97 & 4 ? 1 : 0) +
                      ' S' + (hover.ch.charCodeAt(0) - 97 & 8 ? 1 : 0) + ')'
                    : '') + '</i>' : '');
    }
    /* town tile -> screen (name kept short for the stub loop) */
    function pt2(tx, ty) {
        var w = CAM.tileToWorld(tx, ty);
        return CAM.worldToScreen(cam, w.x, w.y, VW, VH);
    }

    /* ---- input: drag pan + fling, wheel zoom at cursor, dblclick ladder ------ */
    var down = false, moved = false, lx = 0, ly = 0, dx0 = 0, dy0 = 0,
        mvT = 0, flingX = 0, flingY = 0;
    stage.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        down = true; moved = false;
        lx = dx0 = e.clientX; ly = dy0 = e.clientY;
        mvT = 0; flingX = flingY = 0;
        cam.vx = 0; cam.vy = 0;
        stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener('pointermove', function (e) {
        var r = stage.getBoundingClientRect();
        /* hover cell readout (works while panning too) */
        var wpt = CAM.screenToWorld(cam, e.clientX - r.left, e.clientY - r.top, VW, VH);
        var t = CAM.worldToTile(wpt.x, wpt.y);
        var hc = Math.floor((t.x - S.cell_ox) / 4), hr = Math.floor((t.y - S.cell_oy) / 4);
        var hh = (hc >= 0 && hc < S.cols && hr >= 0 && hr < S.rows)
            ? S.grid[hr][hc] : null;
        var nh = hh !== null ? { col: hc, row: hr, ch: hh } : null;
        if (JSON.stringify(nh) !== JSON.stringify(hover)) { hover = nh; markDirty(); }
        if (!down) return;
        var now = performance.now();
        var dx = e.clientX - lx, dy = e.clientY - ly;
        if (!moved && Math.hypot(e.clientX - dx0, e.clientY - dy0) > 3) {
            moved = true; cv.classList.add('panning');
        }
        if (moved) {
            CAM.panByScreen(cam, dx, dy);
            var dt = mvT ? Math.max(4, now - mvT) / 1000 : 0.016;
            flingX = flingX * 0.5 + (dx / dt) * 0.5;
            flingY = flingY * 0.5 + (dy / dt) * 0.5;
            mvT = now; lx = e.clientX; ly = e.clientY;
            markDirty();
        }
    });
    stage.addEventListener('pointerup', function () {
        if (!down) return;
        down = false; cv.classList.remove('panning');
        if (moved) { CAM.setFling(cam, flingX, flingY); markDirty(); }
    });
    stage.addEventListener('pointerleave', function () {
        hover = null; markDirty();
    });
    stage.addEventListener('wheel', function (e) {
        e.preventDefault();
        var r = stage.getBoundingClientRect();
        CAM.wheel(cam, e.deltaY, e.clientX - r.left, e.clientY - r.top, VW, VH);
        markDirty();
    }, { passive: false });
    stage.addEventListener('dblclick', function (e) {
        var r = stage.getBoundingClientRect();
        CAM.zoomStep(cam, e.clientX - r.left, e.clientY - r.top, VW, VH);
        markDirty();
    });
    window.addEventListener('keydown', function (e) {
        if (e.target && e.target.tagName === 'INPUT') return;
        if (e.key === '0') fit();
        else if (e.key === '+' || e.key === '=')
            { CAM.zoomAt(cam, 1.25, VW / 2, VH / 2, VW, VH); markDirty(); }
        else if (e.key === '-' || e.key === '_')
            { CAM.zoomAt(cam, 0.8, VW / 2, VH / 2, VW, VH); markDirty(); }
    });

    /* ---- frame loop (dirty-driven, inertia-aware) ----------------------------- */
    var last = 0;
    function frame(ts) {
        var dt = last ? Math.min(0.1, (ts - last) / 1000) : 0;
        last = ts;
        if (cam.vx || cam.vy) { CAM.tick(cam, dt); markDirty(); }
        if (needsRender) { needsRender = false; draw(); }
        requestAnimationFrame(frame);
    }
    fit();
    requestAnimationFrame(frame);

    window.__SPEC_view = {          // harness/debug hook
        cam: cam, fit: fit, redraw: markDirty, spec: S, bbox: BB
    };
})();
