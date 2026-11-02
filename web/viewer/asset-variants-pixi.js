/* asset-variants-pixi.js — subdirectory copy of js/asset-variants.js for the
   PixiJS city view (web/viewer/). Same behaviour and the same
   AssetVariants global; the differences from the legacy copy (besides every
   asset URL and the Asset Explorer deep link carrying a ../ prefix, since
   this page lives one level below web/) are the dynamic endpoint tiles:
   city art routes through web/api/bsprite.php exactly when the map does,
   sharing window.__CV_DYNC (set by city-view-pixi.js): the same per-category
   VIEWER_DYNAMIC_CITY flags (incl. the ?dyn= URL override), the same boot
   preflight inventory, the same 25-failure circuit breaker, and the same
   pre-baked fallback. js/asset-variants.js belongs to the DEPRECATED Canvas
   page and stays frozen on pre-baked files — do not sync these changes over. */
(function (global) {
    'use strict';

    var B = '../';                 // web/ root, relative to this page
    var BSU = B + 'api/bsprite.php';

    var players = [];        // live anim players (stopped on every render)

    /* ---- dynamic endpoint routing (mirrors the DYNC block in
       city-view-pixi.js) --------------------------------------------------
       Tiles must show what the map actually draws, so the panel never
       decides for itself: it reads cfg/fails/inv off __CV_DYNC. A row goes
       to the endpoint only when its category is on, the breaker has not
       tripped, the boot inventory has settled, and (bodies) the pool can
       bake the stem; everything else — manifest-pack copies, menu/holo
       sidecars outside the pool, grasstile — stays a plain file. */
    function dynCon(D, kind) {      // cfg keys plural ('anims'), fails singular
        return D.cfg[kind] && D.fails[kind.replace(/s$/, '')] < 25;
    }
    function dynVq(D) {             // urlv must append as &v=…, never ?v=…
        var u = D.urlv || '';       // (a second '?' makes PHP read it into the
        return u.charAt(0) === '?'  //  preceding param's value → 404)
            ? '&' + u.slice(1) : u;
    }
    var dynWarn = {};
    function dynWarn1(msg) {
        if (dynWarn[msg]) return;
        dynWarn[msg] = 1;
        console.warn('[dyn-city] panel ' + msg);
    }
    function dynRoute(v) {                // {kind, url} for the endpoint, or null
        var D = global.__CV_DYNC;
        if (!D || !D.inv()) return null;
        var inv = D.inv().inv, p = v.path, m;
        if (v.kind === 'anim') {
            m = /^city\/anims\/([^/]+)__[^/]+\.png$/.exec(p);
            return m && dynCon(D, 'anims')
                ? { kind: 'anim', url: BSU + '?kind=anim&name=' + m[1] +
                        '&png=' + p.slice(5) + dynVq(D) } : null;
        }
        if ((m = /^city\/seasons\/([a-z]+)\/([^/]+)\.png$/.exec(p))) {
            return dynCon(D, 'seasons')
                ? { kind: 'season', url: BSU + '?kind=season&name=' + m[2] +
                        '&cls=' + m[1] + dynVq(D) } : null;
        }
        if ((m = /^city\/stacks\/([^/]+)\.png$/.exec(p))) {
            return dynCon(D, 'stacks')
                ? { kind: 'stack', url: BSU + '?kind=stack&name=' + m[1] +
                        dynVq(D) } : null;
        }
        if ((m = /^city\/flags\/([^/]+)\.png$/.exec(p))) {
            if (!dynCon(D, 'sprites')) return null;    // cloths ride sprites
            var FL = D.inv().flags || [];
            return FL.indexOf(m[1]) > -1
                ? { kind: 'flag', url: BSU + '?kind=flag&name=' + m[1] +
                        dynVq(D) } : null;
        }
        if ((m = /^city\/([^/]+)\.png$/.exec(p))) {
            if (!dynCon(D, 'sprites') || m[1] === 'grasstile') return null;
            if (!(inv[m[1]] & 1)) return null;      // pool cannot bake this stem
            return { kind: 'sprite', url: BSU + '?kind=sprite&name=' + m[1] +
                    dynVq(D) };
        }
        return null;
    }
    function preUrl(v) { return B + 'assets/' + v.path; }
    function dynFail(kind, p) {           // endpoint dead → file; shared breaker
        var D = global.__CV_DYNC;
        if (D) { D.fails[kind]++; }
        dynWarn1(p + ' (' + kind + '): endpoint failed, using pre-baked');
    }

    function renderVariants(slug, bidName) {
        var V = (global.MAP_DATA && global.MAP_DATA.variants) || {};
        var list = V[String(slug || '').toLowerCase()];
        stopPlayers();
        var rows = list ? list.slice() : [];
        /* Flag_Pole ships the pole only: the engine composites this bid's
           nation cloth (city-flags.json) on top, so show that cloth as
           this card's extra tile — routed through dynRoute like every
           other tile (shared cfg + breaker + preflight flags gate). */
        var cf = global.CITY_FLAGS;
        if (cf && String(slug || '').toLowerCase() === 'flag_pole' &&
                /Flag$/.test(String(bidName || ''))) {
            var stem = 'flag_' + String(bidName).replace(/Flag$/, '').toLowerCase();
            if (cf[stem] && !rows.some(function (r) { return r.path === 'city/' + cf[stem].png; })) {
                rows.push({ path: 'city/' + cf[stem].png, kind: 'flag',
                            name: stem });
            }
        }
        if (!rows.length) { return null; }

        var box = document.createElement('div');
        box.className = 'variants';
        var label = document.createElement('div');
        label.className = 'vlabel';
        label.textContent = 'Sprite variants — ' + rows.length;
        box.appendChild(label);

        var row = document.createElement('div');
        row.className = 'vrow';
        for (var i = 0; i < rows.length; i++) {
            row.appendChild(rows[i].kind === 'anim'
                ? animTile(rows[i]) : tile(rows[i]));
        }
        box.appendChild(row);
        return box;
    }

    function stopPlayers() {
        for (var i = 0; i < players.length; i++) players[i].stop();
        players = [];
    }

    function tile(v) {
        var name = v.path.split('/').pop();
        var t = document.createElement('a');
        t.className = 'vtile';
        t.href = B + 'assets-explorer.php?path=' + encodeURIComponent(v.path);
        t.dataset.tip = name + ' · ' + v.kind +
            (v.res ? ' · ' + v.res : '') +
            (v.w != null ? ' · ' + v.w + '×' + v.h : '') +
            ' — open in Asset Explorer';

        var pic = document.createElement('div');
        pic.className = 'vpic';
        var img = document.createElement('img');
        img.loading = 'lazy';
        img.decoding = 'async';
        var d = dynRoute(v);
        img.src = d ? d.url : preUrl(v);
        img.alt = name;
        pic.appendChild(img);
        t.appendChild(pic);

        var bits = [v.kind];
        if (v.res) { bits.push(v.res); }
        if (v.w != null) { bits.push(v.w + '×' + v.h); }
        t.appendChild(el('div', 'vname', name));
        t.appendChild(el('div', 'vsub', bits.join(' · ')));
        var sizeD = sizeNode();
        t.appendChild(sizeD);
        var sized = 0;
        function sizeNow() {                 // one size fetch, for the art shown
            if (sized) return;
            sized = 1;
            fillSize(sizeD, img.src);
        }
        if (d) {
            // HEAD only once the tile's own GET warmed the server cache —
            // two cold hits would spawn the python bake twice
            img.onload = sizeNow;
            img.onerror = function () {
                if (img.src === preUrl(v)) return;   // file genuinely missing
                dynFail(d.kind, v.path);
                img.src = preUrl(v);
            };
            if (img.complete && img.naturalWidth) { sizeNow(); }
        } else {
            fillSize(sizeD, img.src);
        }
        return t;
    }

    /* on-disk size under the resolution row: KB under 1 MB, else MB. A HEAD
       request answers without downloading (the carrier sheets are 12-14 MB
       each and these tiles are in a sidebar — we must never pull the body
       just to print a number); only if the server withholds content-length
       do we fall back to a GET. Results memoise per asset url. */
    var sizeCache = {};                   // asset url -> bytes (null = n/a)
    function sizeNode() { return el('div', 'vsize', '\u2026'); }
    function fillSize(d, url) {
        function put(b) {
            sizeCache[url] = b;
            d.textContent = b == null ? 'size n/a'
                : b < 1048576 ? Math.max(1, Math.round(b / 1024)) + ' KB'
                : (b / 1048576).toFixed(1) + ' MB';
        }
        if (sizeCache[url] !== undefined) {
            put(sizeCache[url]);
        } else {
            d.textContent = '\u2026';
            fetch(url, { method: 'HEAD' }).then(function (r) {
                var n = r.ok && r.headers.get('content-length');
                if (n) { return +n; }
                return fetch(url).then(function (r2) {
                    return r2.blob();
                }).then(function (bl) { return bl.size; });
            }).then(function (bytes) {
                put(bytes);
            }).catch(function () { put(null); });
        }
    }

    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) { n.className = cls; }
        if (text != null) { n.textContent = text; }
        return n;
    }

    /* ---- bsv3 named-anim filmstrip player (same as the shared copy) -------- */
    var MAX_W = 160, MAX_H = 140;      // cell display cap in the sidebar

    function animTile(v) {
        var t = el('div', 'vtile anim');
        t.dataset.tip = 'bsv3 animation \u201c' + v.name + '\u201d \u00b7 ' +
            v.frames + ' frames \u00b7 ' + v.cellw + '\u00d7' + v.cellh +
            ' \u2014 click to play/pause, \u23e9 cycles speed';
        var cv = document.createElement('canvas');
        var s = 1;
        function relayout() {
            s = Math.min(1, MAX_W / v.cellw, MAX_H / v.cellh);
            cv.width = Math.max(1, Math.round(v.cellw * s));
            cv.height = Math.max(1, Math.round(v.cellh * s));
        }
        relayout();
        cv.className = 'vcv';
        t.appendChild(cv);
        t.appendChild(el('div', 'vname', v.name));
        t.appendChild(el('div', 'vsub',
            'anim \u00b7 ' + v.frames + ' f \u00b7 bsv3'));
        var sizeD = sizeNode();
        t.appendChild(sizeD);
        var bar = el('div', 'vbar');
        var play = el('button', 'on', '\u23f8');
        var fast = el('button', null, '\u23e9 1\u00d7');
        bar.appendChild(play);
        bar.appendChild(fast);
        t.appendChild(bar);

        var ctx = cv.getContext('2d');
        var img = new Image();
        var st = { i: 0, t: 0, raf: null, playing: true, rate: 1, last: 0 };
        var d = dynRoute(v);
        st.dyn = !!d;
        var sized = 0;
        function sizeNow() {
            if (sized) return;
            sized = 1;
            fillSize(sizeD, img.src);
        }

        function draw() {
            if (!img.complete || !img.naturalWidth) { return; }
            ctx.clearRect(0, 0, cv.width, cv.height);
            ctx.imageSmoothingEnabled = s < 1;
            if (v.sub) {
                // sparse shelf (tools/gen_city_sprites.py): the frame is a
                // list of rects, each blitted from the packed (sx,sy) spot
                // to the cell coord (ox+ax, oy+ay) — mirrors animOf/sparse
                // blitting in city-view-pixi.js
                var rs = v.sub[st.i] || [];
                var ax = v.ax || 0, ay = v.ay || 0;
                for (var j = 0; j < rs.length; j++) {
                    var r = rs[j];
                    ctx.drawImage(img, r.sx, r.sy, r.w, r.h,
                                  (r.ox + ax) * s, (r.oy + ay) * s,
                                  r.w * s, r.h * s);
                }
                return;
            }
            var col = st.i % v.cols, row = Math.floor(st.i / v.cols);
            ctx.drawImage.apply(ctx, [img]
                .concat([col * v.cellw, row * v.cellh, v.cellw, v.cellh])
                .concat([0, 0, cv.width, cv.height]));
        }
        function frame(now) {
            st.raf = requestAnimationFrame(frame);
            if (!st.playing) { st.last = now; return; }
            if (!st.last) { st.last = now; }
            st.t += (now - st.last) * st.rate;
            st.last = now;
            var step = 1000 / (v.fps || 12);
            while (st.t >= step) {
                st.t -= step;
                st.i = (st.i + 1) % v.frames;
                draw();
            }
        }
        function usePre() {                // endpoint strip dead → shipped file
            st.dyn = false;
            if (v._dmsave) {               // undo endpoint geometry: the file
                for (var k in v._dmsave) { v[k] = v._dmsave[k]; }
                v._dmsave = null;
                relayout();
            }
            dynFail('anim', v.path);
            img.src = preUrl(v);
        }
        img.onload = function () { draw(); sizeNow(); };
        img.onerror = function () { if (st.dyn) usePre(); };
        if (d) {
            animMeta(v, {
                apply: function (j) {
                    if (st.dead || !st.dyn) return;   // re-rendered / fell back:
                    var ch = 0, i, k;                 // keep the file's geometry
                    for (i = 0; i < META_F.length; i++) {
                        k = META_F[i];
                        if (j[k] !== undefined && j[k] !== v[k]) {
                            if (!v._dmsave) { v._dmsave = {}; }
                            if (v._dmsave[k] === undefined) { v._dmsave[k] = v[k]; }
                            v[k] = j[k];
                            ch = 1;
                        }
                    }
                    if (ch) { relayout(); draw(); }
                }
            });
        }
        img.src = d ? d.url : preUrl(v);
        if (img.complete) { draw(); sizeNow(); }
        st.raf = requestAnimationFrame(frame);

        play.addEventListener('click', function (ev) {
            ev.stopPropagation();
            st.playing = !st.playing;
            play.textContent = st.playing ? '\u23f8' : '\u25b6';
            play.classList.toggle('on', st.playing);
        });
        fast.addEventListener('click', function (ev) {
            ev.stopPropagation();
            st.rate = st.rate >= 4 ? 1 : st.rate * 2;
            fast.textContent = '\u23e9 ' + st.rate + '\u00d7';
        });
        t.addEventListener('click', function () {
            st.playing = !st.playing;
            play.textContent = st.playing ? '\u23f8' : '\u25b6';
            play.classList.toggle('on', st.playing);
        });

        players.push({ stop: function () {
            cancelAnimationFrame(st.raf);
            st.dead = 1;
            if (!v._dm) { v._dmq = 0; }   // let a re-render re-issue the meta
        } });
        return t;
    }

    /* The working pipeline may sit a pixel ahead of the shipped manifests
       (uncommitted bake-rule edits), so a dynamic strip pulls its own
       mode=meta once and overwrites the row's slicing fields — same list
       and reconcile as animMeta() in city-view-pixi.js. Results memoise on
       the row object (shared across re-renders); ctx.apply belongs to the
       tile that asked and refuses the geometry if it fell back to the
       pre-baked file (which matches the manifest instead). */
    var META_F = ['frames', 'cols', 'cellw', 'cellh', 'ax', 'ay',
                  'fps', 'rp', 'lt', 'lf', 'sub', 'sparse', 'nc', 'w', 'h'];
    function animMeta(v, ctx) {
        if (v._dmq || v._dm) return;
        var D = global.__CV_DYNC;
        var m = /^city\/anims\/([^/]+)__/.exec(v.path);
        if (!D || !m) return;
        v._dmq = 1;
        fetch(BSU + '?kind=anim&name=' + m[1] + '&png=' + v.path.slice(5) +
              '&mode=meta' + dynVq(D))
            .then(function (r) {
                return r.json().catch(function () { return null; });
            }).then(function (j) {
                v._dmq = 0;
                if (!j || j.error) {
                    dynWarn1(v.path + ': ' + ((j && j.error) || 'meta fetch failed'));
                    return;
                }
                v._dm = j;
                ctx.apply(j);
            }).catch(function () { v._dmq = 0; });
    }

    global.AssetVariants = { render: renderVariants, stop: stopPlayers };
})(window);
