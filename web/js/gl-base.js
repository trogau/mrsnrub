/* gl-base.js — WebGL base layer for City View (Phase 2, M4).
   Draws the zoomed-out (LOD) frame — grass tile, sea base, the flattened
   terrain + building atlases and the people dots — as a handful of
   textured-quad draws on a WebGL canvas layered BEHIND the 2D canvas.
   Rationale: even GPU-backed Canvas2D re-records path/pattern work on
   the CPU every pan frame and re-blits the full-frame atlases
   translucent over each other; in GL a pan frame is one uniform update
   plus ~5 draw calls with bilinear-sampled textures. Overlays/debug
   (grid, wire, walks, proposed, outlines, markers, sprites, block
   prisms) stay on the 2D canvas above.

   Deliberately tiny API: CityGL.create(canvas) -> renderer | null (any
   missing capability returns null and City View keeps the Canvas2D base
   path); renderer.draw(state) -> bool, false = GL failed, caller falls
   back. WebGL1 only (no extensions, no MSAA), all coordinates fed in
   as tile-space corners + the frame's tile->NDC affine (CAM.tileAffine
   derived), so the projection has one source of truth in camera.js. */
'use strict';
(function (globalThis) {

    var VS = [
        'attribute vec2 aPos;',
        'attribute vec2 aUv;',
        'uniform vec4 uM;',          // tile->ndc affine (a,b,d,e)
        'uniform vec2 uO;',          //                      (c,f)
        'varying vec2 vUv;',
        'void main() {',
        '  vUv = aUv;',
        '  gl_Position = vec4(uM.x*aPos.x + uM.y*aPos.y + uO.x,',
        '                     uM.z*aPos.x + uM.w*aPos.y + uO.y, 0.0, 1.0);',
        '}'
    ].join('\n');
    var FS = [
        'precision mediump float;',
        'varying vec2 vUv;',
        'uniform sampler2D uTex;',
        'uniform int uMode;',        // 0 = texture, 1 = flat uCol
        'uniform vec4 uCol;',
        'void main() {',
        '  if (uMode == 0) gl_FragColor = texture2D(uTex, vUv);',
        '  else gl_FragColor = uCol;',
        '}'
    ].join('\n');
    /* solid pass (classic-band buildings + sprites + people dots, drawn
       ABOVE the 2D canvas): screen-px space, premultiplied per-vertex
       colour MODULATED by the bound texture — prisms/dots sample a white
       texel (face colour wins), sprites carry (1,1,1,1) and the atlas
       pixels win. One program => prisms and sprites interleave in ONE
       depth-ordered vertex stream, one draw call. */
    var VSC = [
        'attribute vec2 aPos;',
        'attribute vec2 aUv;',
        'attribute vec4 aCol;',        // premultiplied 0..1
        'uniform vec2 uVH;',           // css px viewport size
        'varying vec2 vUv;',
        'varying vec4 vCol;',
        'void main() {',
        '  vUv = aUv;',
        '  vCol = aCol;',
        '  gl_Position = vec4(2.0 * aPos.x / uVH.x - 1.0,',
        '                     1.0 - 2.0 * aPos.y / uVH.y, 0.0, 1.0);',
        '}'
    ].join('\n');
    var FSC = [
        'precision mediump float;',
        'varying vec2 vUv;',
        'varying vec4 vCol;',
        'uniform sampler2D uTex;',
        'void main() { gl_FragColor = vCol * texture2D(uTex, vUv); }'
    ].join('\n');

    /* unit circle for the people-dot fans */
    var CSEG = 8, CUX = [], CUY = [];
    for (var ci = 0; ci < CSEG; ci++) {
        CUX.push(Math.cos(ci / CSEG * Math.PI * 2));
        CUY.push(Math.sin(ci / CSEG * Math.PI * 2));
    }

    function isPOT(n) { return n > 0 && (n & (n - 1)) === 0; }

    /* boot diagnostics: WHY the renderer refused to start ('' = never
       attempted, last fail() wins). Surfaced in the statsbar and
       window.__CV_DIAG.glReason so a slow machine reports its own cause. */
    var lastErr = '';
    function fail(m) { lastErr = m; return null; }

    function create(canvas) {
        if (!canvas) return fail('no-canvas');
        if (typeof WebGLRenderingContext === 'undefined')
            return fail('no-WebGLRenderingContext');
        var gl = null;
        /* MSAA first (smooth prism edges); Firefox's GPU blocklist refuses
           antialias contexts on some drivers, so retry plain before giving
           up — a jaggy city beats a 2D city */
        var attrs = [
            { alpha: true, antialias: true, depth: false,
              premultipliedAlpha: true, preserveDrawingBuffer: false },
            { alpha: true, antialias: false, depth: false,
              premultipliedAlpha: true, preserveDrawingBuffer: false }
        ];
        for (var ai = 0; ai < attrs.length && !gl; ai++) {
            try {
                gl = canvas.getContext('webgl', attrs[ai]);
            } catch (e) { gl = null; }
        }
        if (!gl) return fail('no-context');
        // headless stubs (the smoke harness) hand back a generic object —
        // only a real WebGL context may proceed
        if (!(gl instanceof WebGLRenderingContext)) return fail('not-webgl');

        function shader(type, src, tag) {
            var s = gl.createShader(type);
            gl.shaderSource(s, src);
            gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
                var log = '';
                try { log = String(gl.getShaderInfoLog(s)).slice(0, 120); }
                catch (e) { /* keep going */ }
                gl.deleteShader(s);
                return fail('shader-' + tag + ': ' + log);
            }
            return s;
        }
        var vs = shader(gl.VERTEX_SHADER, VS, 'vs'),
            fs = shader(gl.FRAGMENT_SHADER, FS, 'fs');
        if (!vs || !fs) return fail(lastErr);
        var prog = gl.createProgram();
        gl.attachShader(prog, vs); gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
            return fail('link-base: ' + String(gl.getProgramInfoLog(prog)).slice(0, 120));
        gl.useProgram(prog);
        var la = gl.getAttribLocation(prog, 'aPos'),
            lu = gl.getAttribLocation(prog, 'aUv'),
            um = gl.getUniformLocation(prog, 'uM'),
            uo = gl.getUniformLocation(prog, 'uO'),
            ut = gl.getUniformLocation(prog, 'uTex'),
            umode = gl.getUniformLocation(prog, 'uMode'),
            ucol = gl.getUniformLocation(prog, 'uCol');
        gl.enableVertexAttribArray(la);
        gl.enableVertexAttribArray(lu);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);   // premultiplied
        var buf = gl.createBuffer();
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);

        /* solid program: building prisms + dot fans (drawTop) */
        var vs2 = shader(gl.VERTEX_SHADER, VSC, 'vsc'),
            fs2 = shader(gl.FRAGMENT_SHADER, FSC, 'fsc');
        if (!vs2 || !fs2) return fail(lastErr);
        var progc = gl.createProgram();
        gl.attachShader(progc, vs2); gl.attachShader(progc, fs2);
        gl.linkProgram(progc);
        if (!gl.getProgramParameter(progc, gl.LINK_STATUS))
            return fail('link-solid: ' + String(gl.getProgramInfoLog(progc)).slice(0, 120));
        var lcP = gl.getAttribLocation(progc, 'aPos'),
            lcU = gl.getAttribLocation(progc, 'aUv'),
            lcC = gl.getAttribLocation(progc, 'aCol'),
            lcuVH = gl.getUniformLocation(progc, 'uVH'),
            lcuTex = gl.getUniformLocation(progc, 'uTex');
        var bufC = gl.createBuffer();
        var maxTex = 0;
        try { maxTex = +gl.getParameter(gl.MAX_TEXTURE_SIZE) || 0; }
        catch (e) { maxTex = 0; }

        /* one 1x1 white texel so the flat-colour mode keeps a bound sampler */
        var white = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, white);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA,
            gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        /* upload-once texture cache keyed on the source object (each
           rebuilt atlas canvas is a fresh object, so stale entries can
           never be reused) */
        function tex(src, repeat) {
            if (src.__glT) return src.__glT;
            var pot = src.width && isPOT(src.width) && isPOT(src.height);
            if (repeat && !pot) return null;    // WebGL1: REPEAT needs POT
            var t = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
            var wr = (repeat && pot) ? gl.REPEAT : gl.CLAMP_TO_EDGE;
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wr);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wr);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            if (pot && repeat) {
                gl.generateMipmap(gl.TEXTURE_2D);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER,
                    gl.LINEAR_MIPMAP_LINEAR);
            } else {
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            }
            src.__glT = t;
            return t;
        }

        /* tile-space quad -> 6 interleaved (x,y,u,v) vertices; the atlas
           canvas top-left (u0,v0) maps to the quad corner (x0,y0) */
        function pushQuad(arr, x0, y0, x1, y1, u0, v0, u1, v1) {
            arr.push(x0, y0, u0, v0, x1, y0, u1, v0, x1, y1, u1, v1,
                x0, y0, u0, v0, x1, y1, u1, v1, x0, y1, u0, v1);
        }
        function put(arr) {
            gl.bindBuffer(gl.ARRAY_BUFFER, buf);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr), gl.DYNAMIC_DRAW);
            gl.vertexAttribPointer(la, 2, gl.FLOAT, false, 16, 0);
            gl.vertexAttribPointer(lu, 2, gl.FLOAT, false, 16, 8);
            gl.drawArrays(gl.TRIANGLES, 0, arr.length / 4);
        }

        /* state = {
             A:            CAM.tileAffine result (CSS px), vw/vh: CSS size,
             T:            visibleTileRect (grass coverage),
             grassImg?, grassRGB, grassRepeat,
             sea:          {x0,y0,x1,y1,rgb} | null,
             terrain:      {img,x0,y0,W,H} (atlas px, ATLAS_TS px/tile),
             buildings:    same | null,
             atlasTS,
             dots:         {chars, r, rgb} | null   (r in tile units)
           } */
        function drawQuad(at, atlasTS, repeat) {
            var k = at.ts || atlasTS;
            var x1 = at.x0 + at.W / k, y1 = at.y0 + at.H / k;
            /* no UV inset for the 0.5px bilinear bleed: it is painted
               outward from each tile but clipped by the canvas boundary,
               so edge texels already hold correct opaque content */
            var arr = [];
            pushQuad(arr, at.x0, at.y0, x1, y1, 0, 0, 1, 1);
            var t = tex(at.img, repeat);
            if (!t) return false;
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.uniform1i(umode, 0);
            put(arr);
            return true;
        }
        function colorQuad(x0, y0, x1, y1, rgb) {
            var arr = [];
            pushQuad(arr, x0, y0, x1, y1, 0, 0, 1, 1);
            gl.bindTexture(gl.TEXTURE_2D, white);
            gl.uniform1i(umode, 1);
            gl.uniform4f(ucol, rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 1);
            put(arr);
        }

        return {
            draw: function (state) {
                try {
                    var A = state.A, vw = state.vw, vh = state.vh, ts = state.atlasTS;
                    if (canvas.width !== vw * (state.dpr || 1) ||
                        canvas.height !== vh * (state.dpr || 1)) {
                        canvas.width = vw * (state.dpr || 1);
                        canvas.height = vh * (state.dpr || 1);
                    }
                    /* resizing the drawing buffer resets ALL context state
                       (WebGL spec), so program/blend/attrib setup must be
                       re-applied every frame — these calls are free */
                    gl.viewport(0, 0, canvas.width, canvas.height);
                    gl.useProgram(prog);
                    gl.enable(gl.BLEND);
                    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
                    gl.enableVertexAttribArray(la);
                    gl.enableVertexAttribArray(lu);
                    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
                    gl.activeTexture(gl.TEXTURE0);
                    gl.clearColor(0, 0, 0, 0);
                    gl.clear(gl.COLOR_BUFFER_BIT);
                    // tile -> NDC: the dpr cancels between CSS px and the
                    // dpr-sized drawing buffer
                    gl.uniform4f(um, 2 * A.a / vw, 2 * A.b / vw,
                        -2 * A.d / vh, -2 * A.e / vh);
                    gl.uniform2f(uo, 2 * A.c / vw - 1, 1 - 2 * A.f / vh);
                    gl.uniform1i(ut, 0);

                    var T = state.T;
                    var gt = state.grassImg ? tex(state.grassImg, true) : null;
                    if (gt) {
                        /* uv in ABSOLUTE tile coords (/grassRepeat) so the
                           lawn is pinned to the grid and never swims with
                           the camera the way a viewport-anchored uv would */
                        var g = state.grassRepeat, garr = [];
                        pushQuad(garr, T.x0, T.y0, T.x1, T.y1,
                            T.x0 / g, T.y0 / g, T.x1 / g, T.y1 / g);
                        gl.bindTexture(gl.TEXTURE_2D, gt);
                        gl.uniform1i(umode, 0);
                        put(garr);
                    } else
                        colorQuad(T.x0, T.y0, T.x1, T.y1, state.grassRGB);
                    if (state.sea)
                        colorQuad(state.sea.x0, state.sea.y0,
                            state.sea.x1, state.sea.y1, state.sea.rgb);
                    if (!drawQuad(state.terrain, ts, false)) return false;
                    if (state.buildings && !drawQuad(state.buildings, ts, false))
                        return false;
                    if (state.dots) {
                        var chars = state.dots.chars, r = state.dots.r, arr = [];
                        for (var i = 0; i < chars.length; i++) {
                            var c = chars[i], cx = c[1], cy = c[2];
                            if (cx < T.x0 - 1 || cx > T.x1 + 1 ||
                                cy < T.y0 - 1 || cy > T.y1 + 1) continue;
                            pushQuad(arr, cx - r, cy - r, cx + r, cy + r, 0, 0, 1, 1);
                        }
                        if (arr.length) {
                            gl.bindTexture(gl.TEXTURE_2D, white);
                            gl.uniform1i(umode, 1);
                            var col = state.dots.rgb;
                            gl.uniform4f(ucol, col[0] / 255, col[1] / 255,
                                col[2] / 255, 1);
                            put(arr);
                        }
                    }
                    return true;
                } catch (e) { return false; }
            },

            /* classic-band top pass: ONE depth-ordered stream of quads —
               building prisms (flat colour x white texel) and sprite
               billboards (atlas pixels) — plus people dot fans after them,
               all on the GL canvas raised above the 2D one.
               state = { vw, vh, dpr,
                 quads: { arr: Float32Array n*8 of x,y,u,v,r,g,b,a (premult) },
                 dots:  { xy: Float32Array n*2 css px, n, r, rgb } | null,
                 tex:   atlas canvas | null   (null -> 1x1 white sampler),
                 wuv:   [u,v] sample point inside the atlas' white cell }
               The atlas canvas re-uploads only when city-view flags it
               (__glDirty) after packing new sprites into it. The canvas is
               cleared first, so an empty frame is a real clear. */
            drawTop: function (state) {
                try {
                    var d = state.dpr || 1;
                    if (canvas.width !== state.vw * d ||
                        canvas.height !== state.vh * d) {
                        canvas.width = state.vw * d;
                        canvas.height = state.vh * d;
                    }
                    gl.viewport(0, 0, canvas.width, canvas.height);
                    gl.useProgram(progc);
                    gl.enable(gl.BLEND);
                    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
                    gl.enableVertexAttribArray(lcP);
                    gl.enableVertexAttribArray(lcU);
                    gl.enableVertexAttribArray(lcC);
                    gl.uniform2f(lcuVH, state.vw, state.vh);
                    gl.uniform1i(lcuTex, 0);
                    /* the drawing-buffer reset also drops the unpack flag:
                       without this the atlas texImage2D below reads the
                       canvas as straight alpha while the blend is
                       premultiplied — every semi-transparent sprite pixel
                       then composites at full colour (garbled, glowing
                       sprites on the first load, since #glcv always starts
                       300x150 and is resized on this very frame) */
                    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
                    gl.clearColor(0, 0, 0, 0);
                    gl.clear(gl.COLOR_BUFFER_BIT);
                    /* texture: sprite atlas (re-uploaded when flagged) or
                       the plain white texel for prism/dot-only frames */
                    var src = state.tex, t = white;
                    if (src && src.width) {
                        t = src.__glT;
                        if (!t || src.__glDirty) {
                            if (!t) {
                                t = gl.createTexture();
                                src.__glT = t;
                            }
                            gl.bindTexture(gl.TEXTURE_2D, t);
                            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA,
                                gl.RGBA, gl.UNSIGNED_BYTE, src);
                            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,
                                gl.CLAMP_TO_EDGE);
                            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,
                                gl.CLAMP_TO_EDGE);
                            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER,
                                gl.LINEAR);
                            if (isPOT(src.width) && isPOT(src.height)) {
                                gl.generateMipmap(gl.TEXTURE_2D);
                                gl.texParameteri(gl.TEXTURE_2D,
                                    gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
                            } else {
                                gl.texParameteri(gl.TEXTURE_2D,
                                    gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                            }
                            src.__glDirty = false;
                        } else {
                            gl.bindTexture(gl.TEXTURE_2D, t);
                        }
                    } else {
                        gl.bindTexture(gl.TEXTURE_2D, white);
                    }
                    var wu = state.wuv ? state.wuv[0] : 0.5,
                        wv = state.wuv ? state.wuv[1] : 0.5;
                    gl.bindBuffer(gl.ARRAY_BUFFER, bufC);
                    function ptrs() {
                        gl.vertexAttribPointer(lcP, 2, gl.FLOAT, false, 32, 0);
                        gl.vertexAttribPointer(lcU, 2, gl.FLOAT, false, 32, 8);
                        gl.vertexAttribPointer(lcC, 4, gl.FLOAT, false, 32, 16);
                    }
                    var q = state.quads;
                    if (q && q.n > 0) {
                        gl.bufferData(gl.ARRAY_BUFFER, q.arr.subarray(0, q.n * 8),
                            gl.DYNAMIC_DRAW);
                        ptrs();
                        gl.drawArrays(gl.TRIANGLES, 0, q.n);
                    }
                    var dt = state.dots;
                    if (dt && dt.n > 0) {
                        var col = dt.rgb, cr = col[0] / 255, cg = col[1] / 255,
                            cb = col[2] / 255, r = dt.r, xy = dt.xy;
                        var arr = [], i, k, x, y;
                        for (i = 0; i < dt.n; i++) {
                            x = xy[i * 2]; y = xy[i * 2 + 1];
                            for (k = 0; k < CSEG; k++) {
                                var k2 = (k + 1) % CSEG;
                                arr.push(x, y, wu, wv, cr, cg, cb, 1,
                                    x + CUX[k] * r, y + CUY[k] * r, wu, wv, cr, cg, cb, 1,
                                    x + CUX[k2] * r, y + CUY[k2] * r, wu, wv, cr, cg, cb, 1);
                            }
                        }
                        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr),
                            gl.DYNAMIC_DRAW);
                        ptrs();
                        gl.drawArrays(gl.TRIANGLES, 0, arr.length / 8);
                    }
                    return true;
                } catch (e) { return false; }
            },
            maxTex: maxTex
        };
    }

    globalThis.CityGL = {
        create: create,
        lastError: function () { return lastErr; }
    };

})(typeof window !== 'undefined' ? window : globalThis);
