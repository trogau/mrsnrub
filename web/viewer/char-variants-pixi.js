/* char-variants-pixi.js — character family strip for the PixiJS city view
   (web/viewer/). Companion to asset-variants-pixi.js (building sprite
   variants): when a character is selected on the map, fetch
   assets/characters/families/<cid>.json (tools/gen_city_sprites.py `chars`
   pass 4) and show EVERY cell of that cast member — idles/blinks, walks,
   actions, outfits — as mini players stepping the individual frame PNGs on
   their per-frame delays (the delays are one PLAY of the cell, matching the
   original client's timeBetweenAnims model). Click a tile to make the map
   character perform that cell (opts.onPreview). */
(function (global) {
    'use strict';

    var B = '../';                 // web/ root, relative to this page
    var players = [];              // live players, advanced by ONE shared rAF
    var ticker = null;
    var cache = {};                // cid -> family json
    var MAX_W = 150, MAX_H = 130;  // cell display cap in the sidebar
    var TILE_CAP = 150;            // tiles per card (Homer owns 600+ cells)

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
        var shown = live.slice(0, TILE_CAP);
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
        if (live.length > TILE_CAP)
            box.appendChild(el('div', 'vdim', 'showing first ' + TILE_CAP +
                               ' of ' + live.length + ' animated cells'));
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
        a.href = B + 'assets-explorer.html?path=' +
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

        var ctx = cv.getContext('2d');
        var imgs = new Array(c.frames.length);
        var p = { i: 0, t: 0, playing: true, rate: 1, last: 0 };
        function imgAt(i) {
            var im = imgs[i];
            if (im === undefined) {
                im = imgs[i] = new Image();
                im.decoding = 'async';
                im.onload = function () { if (p.i === i) draw(); };
                im.src = B + 'assets/characters/' + c.frames[i].file;
            }
            return im.complete && im.naturalWidth ? im : null;
        }
        function draw() {
            var im = imgAt(p.i);
            if (!im) { imgAt((p.i + 1) % c.frames.length); return; }
            ctx.clearRect(0, 0, cv.width, cv.height);
            ctx.imageSmoothingEnabled = s < 1;
            ctx.drawImage(im, 0, 0, cv.width, cv.height);
        }
        function advance(now) {
            if (!p.playing) { p.last = now; return; }
            if (!p.last) p.last = now;
            p.t += (now - p.last) * p.rate;
            p.last = now;
            var guard = 0;
            while (p.t >= (c.frames[p.i].delay || 100) && guard++ < 240) {
                p.t -= (c.frames[p.i].delay || 100);
                p.i = (p.i + 1) % c.frames.length;
                draw();
            }
        }
        imgAt(0);
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
