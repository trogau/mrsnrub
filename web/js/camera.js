/* camera.js — pure camera model for the city view (Phase 2, M0).
   Classic script, no modules, no build, no network, no DOM.

   Projection (documented canonical oblique — notes/06 §8/§9):
     The base game is an oblique "2.5D" camera over a 2D tile grid. The
     reverse-engineering gate on the *exact* matrix constants ran out:
     the per-frame matrix build sits behind runtime-populated vtable
     dispatch (class-descriptor blocks are zero on disk), so M0 ships
     the canonical 2:1 oblique projection — the standard TSTO look —
     as a *documented* choice, never a silently tuned one. The
     obliqueness is a single named knob (TILE.hh/TILE.hw, the 2:1
     diamond = pitch ≈ 26.6°) so screenshot backlog item (1) can pin
     it without touching the rest of the model.

   World space:
     Town tile coordinates — the same space the Map Explorer building
     data uses (town = grid − (12,136), best-fit origin, notes/01).
     One tile is a diamond of half-width TILE.hw and half-height
     TILE.hh world units, 2:1 by default.

   Orientation (ORIENT — pinned manually by the user against the
   Android full-map export via the Rotate/Mirror rig, notes/06 §9/§10):
     Tile axes are projected through signs (fx, fy) + an optional axis
     swap: (a,b) = swap ? (y,x) : (x,y);
     tile (x,y) → ((a·fx − b·fy)·hw, (a·fx + b·fy)·hh).
     Shipped default ORIENT = { fx: 1, fy: −1, swap: 1 }: +x runs
     upper-right and +y lower-right, so the ocean rows (grid rows
     2–26, wave marks) run along the UPPER-LEFT edge of the diamond
     with the dense wave + pier half toward the TOP corner — the
     state the user visually matched to the in-game export. The
     earlier affine registration (roads/buildings/terrain, 16 axis
     assignments) scored the transposed branch a statistical tie but
     shipped the wrong one; the sx/sy ≈ 1.8 "anisotropy" it needed
     was the artifact of that wrong assignment. Note this makes the
     oblique a mirror of the plain Map Explorer top-down (x right,
     y down); the top-down remains a separate documented view, and
     chirality is pinned by the in-game export, not top-down agreement.

   Screen mapping (pure, no state beyond the camera object):
     s  = PX_PER_UNIT * zoom
     sx = vw/2 + (worldX − cam.x) * s
     sy = vh/2 + (worldY − cam.y) * s
     where (cam.x, cam.y) is the world point under the screen centre.

   Zoom (user observation, binding — notes/06 §4):
     The base game does NOT zoom out to whole-town scale. The camera
     rests at zoom 1.0 and only zooms *in* a little. The base-game
     clamp range is therefore narrow and zoom-in-biased: [1.0, 1.5].
     The "full town" fit is our own convenience preset, explicitly
     outside the base clamps: ask CAM.fitZoom() for the number and
     pass {unclamped: true}.

   Invariants (covered by tools/smoke-camera.cjs):
     - worldToTile ∘ tileToWorld = identity
     - pan invariance: the world point under the cursor is preserved
       when the camera pans by the pointer delta
     - zoom-at-point: the world point under the cursor is preserved
       across a zoom that keeps it fixed
     - clamps: wheel/double-click zoom stays in the workbench range
       [ZOOM.wbMin, ZOOM.max] (presets may sit anywhere; base-game
       fidelity constants ZOOM.min/max are for rest + the ladder)
       unless the caller opts out

   Headless: `node tools/smoke-camera.cjs`. */
'use strict';

const CAM = {
    /* Tile diamond half-extents in world units. 2:1 oblique (pitch
       ≈ 26.57°). The single knob for "how oblique" — pin via the
       screenshot backlog before hardening (M4). */
    TILE: { hw: 1.0, hh: 0.5 },

    /* Tile-axis orientation (see header "Orientation"): the single knob
       for "which way is north". Tile (x,y) → oriented axes
       (u,v) = (a·fx, b·fy) with (a,b) = swap ? (y,x) : (x,y), then
       world = ((u−v)·hw, (u+v)·hh). (fx,fy,swap) = (1,−1,1) is the
       state the user matched to the in-game export with the
       Rotate/Mirror rig (ocean along the upper-left edge, pier end
       at the top corner); do not tune casually — the (fx,fy,swap)
       triple is the town's chirality + corner assignment (8
       possibilities). The City View toolbar Rotate/Mirror buttons
       cycle this triple live (notes/06 §10). */
    ORIENT: { fx: 1, fy: -1, swap: 1 },

    /* Base pixels per world unit at rest zoom → resting tile ≈
       128×64 px. Documented default (resting-frame size); tuned in
       the M4 A/B pass if the base game's resting tile looks bigger/
       smaller. */
    PX_PER_UNIT: 64,

    /* Base-game zoom clamp (documented, notes/06 §4): rest 1.0, no
       zoom out, small zoom-in range — kept as FIDELITY constants for
       the M4 A/B pass (rest value + the dblclick ladder below).
       max = documented default pending backlog item (2). */
    ZOOM: {
        rest: 1.0,
        min: 1.0,
        max: 1.5,
        /* Workbench gesture floor (notes/06 §9): the City View is a
           study tool, and its presets frame the whole town / ocean
           band far below rest via unclamped fits (~0.02). Gestures
           therefore clamp to [wbMin, max], NOT [min, max]: clamping
           wheel zoom at ZOOM.min snapped a zoomed-out preset to 1.0
           on the very first wheel notch (a 64x jump) and then locked
           the user out of zooming back out. Wheel + dblclick zoom
           now traverse the full range continuously. */
        wbMin: 0.005,
        wheelSpeed: 0.0015,  // wheel: zoom *= exp(−deltaY * wheelSpeed)
        /* Discrete levels for double-click / buttons (the base game's
           zoom-in is a few steps, not continuous). Documented ladder —
           pinned by backlog item (2). */
        steps: [1.0, 1.25, 1.5]
    },

    /* Released-drag inertia. Documented defaults — the base game's
       knobs are cameraMaxPanSpeed / cameraMinPanSpeed / cameraPanTime
       (notes/06 §3); feel tuned in the M4 A/B pass.
       maxSpeed/minSpeed: screen px/s; decay: exponential rate 1/s
       (speed halves every ~0.2 s). */
    PAN: { maxSpeed: 3000, minSpeed: 60, decay: 3.5 }
};

/* ---- tile (town coords) <-> world (oblique) -------------------------------- */

/* Tile → oriented tile axes (u,v) per CAM.ORIENT. All projections,
   depth keys and screen transforms must derive (u,v) from this single
   helper so terrain, buildings and culling share one convention. */
CAM.oriented = function (x, y) {
    const o = CAM.ORIENT;
    const a = o.swap ? y : x, b = o.swap ? x : y;
    return [a * o.fx, b * o.fy];
};

/* Toolbar helpers: the 8 orientation triples form the dihedral group
   D4. rotate90 cycles the 4 rotations; mirror flips chirality. Pure:
   return a new triple (callers assign to CAM.ORIENT). */
CAM.orientRotate90 = function (o) {
    return o.swap
        ? { fx: -o.fx, fy: o.fy, swap: 0 }
        : { fx: o.fx, fy: -o.fy, swap: 1 };
};
CAM.orientMirror = function (o) {
    return { fx: o.fy, fy: o.fx, swap: o.swap ? 0 : 1 };
};

/* Tile centre → world point. */
CAM.tileToWorld = function (x, y) {
    const t = this.TILE, uv = CAM.oriented(x, y);
    return { x: (uv[0] - uv[1]) * t.hw, y: (uv[0] + uv[1]) * t.hh };
};

/* World point → (fractional) tile coords. Inverse of tileToWorld. */
CAM.worldToTile = function (wx, wy) {
    const t = this.TILE, o = CAM.ORIENT;
    const u = wx / (2 * t.hw) + wy / (2 * t.hh);
    const v = wy / (2 * t.hh) - wx / (2 * t.hw);
    return o.swap
        ? { x: v * o.fy, y: u * o.fx }
        : { x: u * o.fx, y: v * o.fy };
};

/* Painter's-algorithm depth of a tile anchor: oriented world row
   (u + v) of its centre. Sort objects by (depth, then oriented u)
   back-to-front. References CAM directly (not `this`) so the
   methods survive use as bare comparators/callbacks. */
CAM.depth = function (x, y) {
    const uv = CAM.oriented(x, y);
    return uv[0] + uv[1];
};

CAM.compareDepth = function (a, b) {
    const ua = CAM.oriented(a.x, a.y), ub = CAM.oriented(b.x, b.y);
    const d = (ua[0] + ua[1]) - (ub[0] + ub[1]);
    return d !== 0 ? d : ua[0] - ub[0];
};

/* Axis-aligned oblique-space bounding box of a tile-space rect
   (tile-space rect {x0,y0,x1,y1}, inclusive-ish endpoints fine).
   Min/max over all four oriented corners — with ORIENT signs/swap the
   extremal corners are not fixed. */
CAM.tileRectToWorldRect = function (r) {
    const t = this.TILE;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [cx, cy] of [[r.x0, r.y0], [r.x0, r.y1], [r.x1, r.y0], [r.x1, r.y1]]) {
        const uv = CAM.oriented(cx, cy);
        const wx = (uv[0] - uv[1]) * t.hw, wy = (uv[0] + uv[1]) * t.hh;
        if (wx < x0) x0 = wx; if (wx > x1) x1 = wx;
        if (wy < y0) y0 = wy; if (wy > y1) y1 = wy;
    }
    return { x0: x0, y0: y0, x1: x1, y1: y1 };
};

/* ---- camera object ---------------------------------------------------------- */

CAM.createCamera = function (o) {
    o = o || {};
    return {
        x: o.x || 0,          // world point under the screen centre
        y: o.y || 0,
        zoom: o.zoom != null ? o.zoom : this.ZOOM.rest,
        vx: 0,                // released-drag inertia, screen px/s
        vy: 0
    };
};

/* Current scale: screen px per world unit. */
CAM.scale = function (cam) { return this.PX_PER_UNIT * cam.zoom; };

CAM.worldToScreen = function (cam, wx, wy, vw, vh) {
    const s = this.scale(cam);
    return { x: vw / 2 + (wx - cam.x) * s, y: vh / 2 + (wy - cam.y) * s };
};

CAM.screenToWorld = function (cam, sx, sy, vw, vh) {
    const s = this.scale(cam);
    return { x: cam.x + (sx - vw / 2) / s, y: cam.y + (sy - vh / 2) / s };
};

/* Tile -> screen AFFINE coefficients for the batched LOD paths. The
   tile -> world -> screen chain is affine in the tile coords (ORIENT is
   sign/swap linear, tileToWorld and worldToScreen are linear), so a
   frame's worth of corners can be projected with 4 mul-adds instead of
   an object allocation + function pair per point. Sampled from three
   canonical probe projections, so ORIENT/scale/pan keep one source of
   truth: sx = a*x + b*y + c, sy = d*x + e*y + f. */
CAM.tileAffine = function (cam, vw, vh) {
    const p0 = this.tileToWorld(0, 0), p1 = this.tileToWorld(1, 0),
          p2 = this.tileToWorld(0, 1);
    const s0 = this.worldToScreen(cam, p0.x, p0.y, vw, vh);
    const s1 = this.worldToScreen(cam, p1.x, p1.y, vw, vh);
    const s2 = this.worldToScreen(cam, p2.x, p2.y, vw, vh);
    return { a: s1.x - s0.x, b: s2.x - s0.x, c: s0.x,
             d: s1.y - s0.y, e: s2.y - s0.y, f: s0.y };
};

/* Convenience: screen rect of a world rect (for culling). */
CAM.worldRectToScreenRect = function (cam, r, vw, vh) {
    const a = this.worldToScreen(cam, r.x0, r.y0, vw, vh);
    const b = this.worldToScreen(cam, r.x1, r.y1, vw, vh);
    return {
        x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y),
        x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y)
    };
};

/* ---- zoom ------------------------------------------------------------------- */

/* Gesture clamp: workbench range [ZOOM.wbMin, ZOOM.max] so unclamped
   presets and wheel/dblclick zoom interoperate without jumps (see
   ZOOM.wbMin). Base-game fidelity constants ZOOM.min/max are NOT
   applied here — they live on for rest + the dblclick ladder. */
CAM.clampZoom = function (z) {
    return Math.min(this.ZOOM.max, Math.max(this.ZOOM.wbMin, z));
};

/* Zoom by `factor` keeping the world point under (sx, sy) fixed.
   {unclamped: true} skips the base-game clamps (convenience presets). */
CAM.zoomAt = function (cam, factor, sx, sy, vw, vh, opts) {
    let z1 = cam.zoom * factor;
    if (!(opts && opts.unclamped)) z1 = this.clampZoom(z1);
    if (z1 === cam.zoom) return;
    const w = this.screenToWorld(cam, sx, sy, vw, vh);
    cam.zoom = z1;
    const s = this.scale(cam);
    cam.x = w.x - (sx - vw / 2) / s;
    cam.y = w.y - (sy - vh / 2) / s;
};

/* Wheel: zoom by exp(−deltaY * wheelSpeed) at the cursor. */
CAM.wheel = function (cam, deltaY, sx, sy, vw, vh) {
    this.zoomAt(cam, Math.exp(-deltaY * this.ZOOM.wheelSpeed), sx, sy, vw, vh);
};

/* Double-click / buttons: advance one level on the discrete ladder
   (ZOOM.steps); at the last level wrap back to rest (the base game
   toggles back out when fully zoomed in). Keeps the point under the
   cursor fixed. */
CAM.zoomStep = function (cam, sx, sy, vw, vh) {
    const L = this.ZOOM.steps;
    if (cam.zoom < L[0] - 1e-9) {
        // Below the ladder (zoomed-out preset scale): step in by 1.25x
        // per click, snapping onto the ladder's rest level when
        // crossing it — no 60x leap to 1.0 on the first double-click.
        const z1 = Math.min(L[0], cam.zoom * 1.25);
        this.zoomAt(cam, z1 / cam.zoom, sx, sy, vw, vh);
        return;
    }
    let i = 0;
    while (i < L.length && L[i] < cam.zoom - 1e-9) i++;  // first level >= zoom
    let z1;
    if (i < L.length && Math.abs(L[i] - cam.zoom) <= 1e-9) {
        z1 = L[(i + 1) % L.length];    // sitting on a level → advance (wrap at top)
    } else {
        z1 = i < L.length ? L[i] : L[0];  // between levels (wheel) → snap up
    }
    if (z1 !== cam.zoom) this.zoomAt(cam, z1 / cam.zoom, sx, sy, vw, vh);
};

/* Exact zoom to fit a *world-space* rect into the viewport. Unclamped
   by nature — the full-town preset uses this and is explicitly
   outside the base-game clamps. */
CAM.fitZoom = function (rect, vw, vh) {
    const zw = vw / ((rect.x1 - rect.x0) * this.PX_PER_UNIT);
    const zh = vh / ((rect.y1 - rect.y0) * this.PX_PER_UNIT);
    return Math.min(zw, zh);
};

/* Set a camera to frame a tile-space rect (presets). */
CAM.fitTileRect = function (cam, rect, vw, vh) {
    const wr = this.tileRectToWorldRect(rect);
    const z = this.fitZoom(wr, vw, vh);
    const c = this.tileToWorld((rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2);
    cam.zoom = z;
    cam.x = c.x;
    cam.y = c.y;
    cam.vx = 0;
    cam.vy = 0;
    return z;
};

/* ---- pan + inertia ------------------------------------------------------------ */

/* Pan by a screen delta (drag: pointer delta). The point under the
   pointer is what moves with it — equivalently the camera centre
   moves by the negative delta. */
CAM.panByScreen = function (cam, dx, dy) {
    const s = this.scale(cam);
    cam.x -= dx / s;
    cam.y -= dy / s;
};

/* Capture a released-drag velocity (screen px/s), clamped to
   PAN.maxSpeed. */
CAM.setFling = function (cam, vpxX, vpxY) {
    const v = Math.hypot(vpxX, vpxY);
    if (v > this.PAN.maxSpeed) {
        const k = this.PAN.maxSpeed / v;
        vpxX *= k; vpxY *= k;
    }
    cam.vx = vpxX;
    cam.vy = vpxY;
};

/* Advance inertia by dt seconds (call once per frame). Exponential
   decay; stops below PAN.minSpeed. */
CAM.tick = function (cam, dt) {
    if (!cam.vx && !cam.vy) return;
    if (dt <= 0) return;
    const sp = Math.hypot(cam.vx, cam.vy);
    const k = Math.exp(-this.PAN.decay * dt);
    if (sp * k < this.PAN.minSpeed) {
        cam.vx = 0;
        cam.vy = 0;
        return;
    }
    cam.vx *= k;
    cam.vy *= k;
    this.panByScreen(cam, cam.vx * dt, cam.vy * dt);
};

/* Node smoke tests: export; browser: top-level const is script-global. */
if (typeof module !== 'undefined' && module.exports) module.exports = CAM;
