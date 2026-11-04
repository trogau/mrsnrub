/* char-variants-pixi.js — character family strip for the PixiJS city view
   (web/viewer/). Companion to asset-variants-pixi.js (building sprite
   variants): when a character is selected on the map, fetch
   assets/characters/families/<cid>.json (tools/gen_city_sprites.py `chars`
   pass 4) and show EVERY cell of that cast member — idles/blinks, walks,
   actions, outfits — as mini players stepping the individual frame PNGs on
   their per-frame delays (the delays are one PLAY of the cell, matching the
   original client's timeBetweenAnims model). Click a tile to make the map
   character perform that cell (opts.onPreview).
   When the viewer opts into the dynamic .bcell endpoint (opts.dynFor, set
   from window.VIEWER_DYNAMIC_BCELL), tiles play from the endpoint's single
   sprite sheet per animation — sliced per-frame with the manifest's rects
   and x_off/y_off offsets, the same geometry the map uses — and fall back
   to the per-frame PNGs while a sheet loads or if the cell has no dynamic
   art, so the panel never blanks out. */
(function (global) {
    'use strict';

    var B = '../';                 // web/ root, relative to this page
    var players = [];              // live players, advanced by ONE shared rAF
    var ticker = null;
    var cache = {};                // cid -> family json
    var sheetImgs = {};            // dyn sheet url -> Image (one decode per cell)
    // Tiles only fetch their dynamic sheet once they're scrolled near the
    // sidebar viewport — a 150-tile card would otherwise decode 150 full
    // sprite sheets (~8000 px wide each) the user never looked at.
    var io = null;
    if ('IntersectionObserver' in window)
        io = new IntersectionObserver(function (es) {
            for (var k = 0; k < es.length; k++) {
                var pl = es[k].target && es[k].target._player;
                if (pl) pl.seen(es[k].isIntersecting);
            }
        }, { rootMargin: '140px' });
    var MAX_W = 150, MAX_H = 130;  // cell display cap in the sidebar
    var TILE_CAP = 150;            // tiles per card (Homer owns 600+ cells)
    var KIND_QUOTA = 30;           // tiles a group gets before the leftovers

    var KIND_ORDER = ['idle', 'walk', 'action', 'standby', 'misc'];
    var KIND_LABEL = { idle: 'idle / blinks', walk: 'walks',
                       action: 'actions', standby: 'poses',
                       misc: 'other' };

    function stopAll() {
        for (var i = 0; i < players.length; i++) players[i].stop();
        players = [];
        if (ticker) { cancelAnimationFrame(ticker); ticker = null; }
    }

    function tick(now) {
        ticker = players.length ? requestAnimationFrame(tick) : null;
        for (var i = 0; i < players.length; i++) players[i].advance(now);
    }

    function render(cid, name, opts) {
        stopAll();
        opts = opts || {};
        var box = document.createElement('div');
        box.className = 'variants cvariants';
        var label = document.createElement('div');
        label.className = 'vlabel';
        label.textContent = 'Animations\u2026';
        box.appendChild(label);
        var st = { cur: null };               // cell key previewed on the map
        function put(j) {
            cache[String(cid)] = j;
            if (box.isConnected) fill(box, label, j, opts, st);
        }
        var hit = cache[String(cid)];
        if (hit) put(hit);
        else fetch(B + 'assets/characters/families/' + encodeURIComponent(cid) +
                   '.json')
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) { put(j || { cid: cid, name: name, cells: [] }); })
            .catch(function () { put({ cid: cid, name: name, cells: [] }); });
        return box;
    }

    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    }

    function fill(box, label, fam, opts, st) {
        var i;
        for (i = players.length - 1; i >= 0; i--) players[i].stop();
        players = [];
        if (ticker) { cancelAnimationFrame(ticker); ticker = null; }
        if (io) io.disconnect();
        box.textContent = '';
        box.appendChild(label);
        var cells = (fam && fam.cells) || [];
        var live = [], dead = 0, i2;
        for (i2 = 0; i2 < cells.length; i2++) {
            if (cells[i2].frames && cells[i2].frames.length) live.push(cells[i2]);
            else dead++;
        }
        label.textContent = live.length
            ? 'Animations \u2014 ' + live.length +
              (dead ? ' (' + dead + ' cells without art)' : '')
            : (cells.length ? 'Animations \u2014 no extractable art'
                            : 'Animations \u2014 none in the extracted packs');
        if (!live.length) return;
        live.sort(function (a, b) {
            var ka = KIND_ORDER.indexOf(a.kind), kb = KIND_ORDER.indexOf(b.kind);
            if (ka !== kb) return ka - kb;
            if ((a.outfit || '') !== (b.outfit || ''))
                return (a.outfit || '') < (b.outfit || '') ? -1 : 1;
            return a.key < b.key ? -1 : 1;
        });
        /* The tile budget is shared out rather than taken off the front of
           the list: one character can own 194 walks and 247 actions, and a
           single head slice lets the biggest group eat the whole card (which
           is exactly how the walks vanished from it once they were labelled
           correctly). Every group the character has gets its first slice, and
           whatever budget is left then goes to the groups that still have
           cells, in the order the card lays them out. */
        var byKind = {}, order = [];
        for (i = 0; i < live.length; i++) {
            if (!byKind[live[i].kind]) { byKind[live[i].kind] = []; order.push(live[i].kind); }
            byKind[live[i].kind].push(live[i]);
        }                       // live is already sorted, so order is too
        var shown = [], taken = {}, room = TILE_CAP, pass, g;
        for (pass = 0; pass < 2; pass++)
            for (g = 0; g < order.length && room > 0; g++) {
                var kd = order[g], list = byKind[kd];
                var have = taken[kd] || 0;
                var want = pass ? list.length - have
                                : Math.min(KIND_QUOTA, list.length) - have;
                if (want <= 0) continue;
                want = Math.min(want, room);
                shown = shown.concat(list.slice(have, have + want));
                taken[kd] = have + want;
                room -= want;
            }
        shown.sort(function (a, b) {
            var ka = KIND_ORDER.indexOf(a.kind), kb = KIND_ORDER.indexOf(b.kind);
            if (ka !== kb) return ka - kb;
            if ((a.outfit || '') !== (b.outfit || ''))
                return (a.outfit || '') < (b.outfit || '') ? -1 : 1;
            return a.key < b.key ? -1 : 1;
        });
        var resetRow = null;
        function syncPreview() {
            var tiles = box.querySelectorAll('.vtile.canim');
            for (var k = 0; k < tiles.length; k++)
                tiles[k].classList.toggle('prev',
                    tiles[k].getAttribute('data-key') === st.cur);
            if (resetRow) resetRow.style.display = st.cur ? 'flex' : 'none';
        }
        var lastG = null, row = null;
        for (i = 0; i < shown.length; i++) {
            var c = shown[i];
            var g = c.kind + '\u0000' + (c.outfit || '');
            if (g !== lastG) {
                lastG = g;
                box.appendChild(el('div', 'vgroup',
                    (KIND_LABEL[c.kind] || c.kind) +
                    (c.outfit ? ' \u00b7 ' + c.outfit : '') +
                    (c.dir ? ' \u00b7 ' + c.dir : '')));
                row = el('div', 'vrow');
                box.appendChild(row);
            }
            if (!resetRow) {
                resetRow = el('div', 'vpreview');
                var txt = el('span', 'vptxt', 'In-world preview: \u2014');
                var stopb = el('button', null, '\u2715 stop');
                stopb.addEventListener('click', function (ev) {
                    ev.stopPropagation();
                    st.cur = null;
                    if (opts.onPreview) opts.onPreview(null);
                    syncPreview();
                });
                resetRow.appendChild(txt);
                resetRow.appendChild(stopb);
                resetRow.style.display = 'none';
                box.appendChild(resetRow);
            }
            row.appendChild(tile(c, opts, st, syncPreview, txt));
        }
        if (shown.length < live.length)
            box.appendChild(el('div', 'vdim', 'showing ' + shown.length +
                               ' of ' + live.length + ' animated cells \u2014 ' +
                               'up to ' + KIND_QUOTA + ' per group first'));
        if (players.length && !ticker) ticker = requestAnimationFrame(tick);
    }

    function tile(c, opts, st, syncPreview, ptxt) {
        var t = el('div', 'vtile canim');
        t.setAttribute('data-key', c.key);
        t.dataset.tip = c.stem + ' \u00b7 ' + c.kind +
            (c.dir ? ' \u00b7 ' + c.dir : '') +
            (c.outfit ? ' \u00b7 outfit ' + c.outfit : '') +
            ' \u00b7 ' + c.frames.length + ' frames \u00b7 ' +
            Math.round(c.ms || 0) + ' ms per play \u2014 click: play on the map,' +
            ' name: open in Asset Explorer';
        var s = Math.min(1, MAX_W / c.w, MAX_H / c.h);
        var cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(c.w * s));
        cv.height = Math.max(1, Math.round(c.h * s));
        cv.className = 'vcv';
        t.appendChild(cv);
        var nm = el('div', 'vname');
        var a = document.createElement('a');
        a.href = B + 'assets-explorer.php?path=' +
            encodeURIComponent('assets/characters/' + (c.png || c.frames[0].file));
        a.textContent = c.outfit || c.stem;
        a.addEventListener('click', function (ev) { ev.stopPropagation(); });
        nm.appendChild(a);
        t.appendChild(nm);
        t.appendChild(el('div', 'vsub', c.kind + (c.dir ? '\u00b7' + c.dir : '') +
                         ' \u00b7 ' + c.frames.length + 'f \u00b7 ' +
                         Math.round(c.ms || 0) + 'ms'));
        var bar = el('div', 'vbar');
        var play = el('button', 'on', '\u23f8');
        var fast = el('button', null, '\u23e9 1\u00d7');
        bar.appendChild(play);
        bar.appendChild(fast);
        t.appendChild(bar);
        var seen = !io;                          // offscreen tiles stay pre-baked
        if (io) {
            t._player = { seen: function (v) {
                seen = v;
                if (v) { syncTrack(); draw(); }
            } };
            io.observe(t);
        }

        var ctx = cv.getContext('2d');
        var imgs = new Array(c.frames.length);
        var p = { i: 0, t: 0, playing: true, rate: 1, last: 0 };
        var track = null;
        function imgAt(i) {
            var im = imgs[i];
            if (im === undefined) {
                im = imgs[i] = new Image();
                im.decoding = 'async';
                im.onload = function () { if (track && !track.dyn && p.i === i) draw(); };
                im.src = B + 'assets/characters/' + c.frames[i].file;
            }
            return im.complete && im.naturalWidth ? im : null;
        }
        /* ---- dynamic sheet path (opts.dynFor → web/api/bcell.php) -------
           When the endpoint is on, the tile plays the cell's ONE sheet PNG:
           manifest.images[] gives each image's rect in the sheet and
           frames[] its placement at x_off/y_off from the character origin
           — the same geometry the map uses. The canvas is sized to the
           union bbox of all frames so inter-frame motion stays true. The
           manifest is the viewer's shared dynCells entry (one fetch per
           cell, shared with the map); the sheet URL decodes into one
           Image shared by every tile that asks for it. */
        function dynSheet() {
            if (!opts.dynFor || !seen) return null;
            var d = opts.dynFor(c);
            if (!d || d.st !== 1 || !d.man || !d.man.frames ||
                !d.man.frames.length || !d.url) return null;
            var im = sheetImgs[d.url];
            if (im === undefined) {
                im = sheetImgs[d.url] = new Image();
                im.decoding = 'async';
                im.onload = function () { syncTrack(); draw(); };
                im.onerror = function () { sheetImgs[d.url] = null; };
                im.src = d.url;
            }
            return (im && im.complete && im.naturalWidth)
                ? { man: d.man, img: im } : null;
        }
        /* playback model — same as the map (charFrameIdx) and the original
           client (IdleAnimation / timeBetweenAnimsMin/Max, notes/01): the
           cell's delays are ONE play, then the player HOLDS frame 0
           (standby) through a randomised gap. Modulo-looping a 208 ms blink
           cell played it ~5x/second. Shared by both art sources: a track
           is just geometry + timing for one of them. */
        var kh = 0, q;
        for (q = 0; q < c.key.length; q++) kh = (kh * 31 + c.key.charCodeAt(q)) | 0;
        kh = Math.abs(kh);
        function trackOf(dsn) {
            if (!dsn) {
                var cum = [], loop = 0;
                for (q = 0; q < c.frames.length; q++) {
                    cum.push(c.frames[q].delay || 100);
                    loop += c.frames[q].delay || 100;
                }
                if (!loop) loop = c.ms || 100;
                return { dyn: 0, n: c.frames.length, cum: cum, loopMs: loop,
                         cyc: loop + 2000 + (kh >>> 4) % 5000 +
                              (loop > 1200 ? loop : 0),
                         sc: s, minx: 0, miny: 0, bw: c.w, bh: c.h };
            }
            var man = dsn.man;
            if (!man._tr) {
                var fr = man.frames, ims = man.images;
                var x0 = 0, y0 = 0, x1 = 1, y1 = 1;
                for (q = 0; q < fr.length; q++) {
                    var f = fr[q], g = ims[f.image];
                    if (!g) continue;
                    if (f.x_off < x0) x0 = f.x_off;
                    if (f.y_off < y0) y0 = f.y_off;
                    if (f.x_off + g.w > x1) x1 = f.x_off + g.w;
                    if (f.y_off + g.h > y1) y1 = f.y_off + g.h;
                }
                var bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0);
                var cum2 = [], loop2 = 0;
                for (q = 0; q < fr.length; q++) {
                    cum2.push(fr[q].delay_ms > 0 ? fr[q].delay_ms : 100);
                    loop2 += fr[q].delay_ms > 0 ? fr[q].delay_ms : 100;
                }
                if (!loop2) loop2 = c.ms || 100;
                man._tr = { dyn: 1, n: fr.length, cum: cum2, loopMs: loop2,
                            cyc: loop2 + 2000 + (kh >>> 4) % 5000 +
                                 (loop2 > 1200 ? loop2 : 0),
                            fr: fr, ims: ims,
                            sc: Math.min(1, MAX_W / bw, MAX_H / bh),
                            minx: x0, miny: y0, bw: bw, bh: bh };
            }
            man._tr.img = dsn.img;
            return man._tr;
        }
        function syncTrack() {
            var tk = trackOf(dynSheet());
            if (opts.dynFor) {         // dead cell → red tile outline for triage
                var dd = opts.dynFor(c);
                t.classList.toggle('cdead', !!(dd && (dd.st === -1 ||
                    (dd.st === 1 && sheetImgs[dd.url] === null))));
            }
            if (tk === track) return;
            track = tk;
            if (p.i >= tk.n) p.i = 0;
            cv.width = Math.max(1, Math.round(tk.bw * tk.sc));
            cv.height = Math.max(1, Math.round(tk.bh * tk.sc));
        }
        function draw() {
            var t = track;
            if (!t) return;
            ctx.clearRect(0, 0, cv.width, cv.height);
            if (t.dyn) {
                var f = t.fr[p.i % t.n], g = t.ims[f.image];
                if (!g) return;
                ctx.imageSmoothingEnabled = t.sc < 1;
                ctx.drawImage(t.img, g.x, g.y, g.w, g.h,
                    (f.x_off - t.minx) * t.sc, (f.y_off - t.miny) * t.sc,
                    g.w * t.sc, g.h * t.sc);
                return;
            }
            var im = imgAt(p.i);
            if (!im) { imgAt((p.i + 1) % c.frames.length); return; }
            ctx.imageSmoothingEnabled = s < 1;
            ctx.drawImage(im, 0, 0, cv.width, cv.height);
        }
        function advance(now) {
            if (!p.playing) { p.last = now; return; }
            if (!p.last) p.last = now;
            syncTrack();
            p.t += (now - p.last) * p.rate;
            p.last = now;
            var t = track, pos = p.t % t.cyc, i2 = 0;
            if (pos < t.loopMs) {
                for (q = 0; q < t.cum.length; q++) {
                    pos -= t.cum[q];
                    if (pos < 0) { i2 = q; break; }
                }
            }                                        // else: standby hold
            if (i2 !== p.i || !p.drawn) { p.i = i2; p.drawn = 1; draw(); }
        }
        syncTrack();
        if (!track.dyn) imgAt(0);
        draw();
        players.push({
            stop: function () { p.playing = false; },
            advance: advance
        });

        play.addEventListener('click', function (ev) {
            ev.stopPropagation();
            p.playing = !p.playing;
            play.textContent = p.playing ? '\u23f8' : '\u25b6';
            play.classList.toggle('on', p.playing);
        });
        fast.addEventListener('click', function (ev) {
            ev.stopPropagation();
            p.rate = p.rate >= 4 ? 1 : p.rate * 2;
            fast.textContent = '\u23e9 ' + p.rate + '\u00d7';
        });
        t.addEventListener('click', function () {
            var on = st.cur !== c.key;
            st.cur = on ? c.key : null;
            if (opts.onPreview) opts.onPreview(on ? c : null);
            if (ptxt) ptxt.textContent = 'In-world preview: ' +
                (on ? c.stem : '\u2014');
            syncPreview();
        });
        return t;
    }

    global.CharVariants = {
        render: render,
        stop: stopAll
    };
})(window);
