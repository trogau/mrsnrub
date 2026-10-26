/* asset-variants-pixi.js — subdirectory copy of js/asset-variants.js for the
   PixiJS city view (web/viewer/). Same behaviour and the same
   AssetVariants global; the only difference is that every asset URL and the
   Asset Explorer deep link carry a ../ prefix, since this page lives one
   level below web/. Keep in sync with js/asset-variants.js when it changes. */
(function (global) {
    'use strict';

    var B = '../';                 // web/ root, relative to this page

    var players = [];        // live anim players (stopped on every render)

    function renderVariants(slug) {
        var V = (global.MAP_DATA && global.MAP_DATA.variants) || {};
        var list = V[String(slug || '').toLowerCase()];
        stopPlayers();
        if (!list || !list.length) { return null; }

        var box = document.createElement('div');
        box.className = 'variants';
        var label = document.createElement('div');
        label.className = 'vlabel';
        label.textContent = 'Sprite variants — ' + list.length;
        box.appendChild(label);

        var row = document.createElement('div');
        row.className = 'vrow';
        for (var i = 0; i < list.length; i++) {
            row.appendChild(list[i].kind === 'anim'
                ? animTile(list[i]) : tile(list[i]));
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
        t.href = B + 'assets-explorer.html?path=' + encodeURIComponent(v.path);
        t.dataset.tip = name + ' · ' + v.kind +
            (v.res ? ' · ' + v.res : '') +
            (v.w != null ? ' · ' + v.w + '×' + v.h : '') +
            ' — open in Asset Explorer';

        var pic = document.createElement('div');
        pic.className = 'vpic';
        var img = document.createElement('img');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.src = B + 'assets/' + v.path;
        img.alt = name;
        pic.appendChild(img);
        t.appendChild(pic);

        var bits = [v.kind];
        if (v.res) { bits.push(v.res); }
        if (v.w != null) { bits.push(v.w + '×' + v.h); }
        t.appendChild(el('div', 'vname', name));
        t.appendChild(el('div', 'vsub', bits.join(' · ')));
        return t;
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
        var s = Math.min(1, MAX_W / v.cellw, MAX_H / v.cellh);
        cv.width = Math.max(1, Math.round(v.cellw * s));
        cv.height = Math.max(1, Math.round(v.cellh * s));
        cv.className = 'vcv';
        t.appendChild(cv);
        t.appendChild(el('div', 'vname', v.name));
        t.appendChild(el('div', 'vsub',
            'anim \u00b7 ' + v.frames + ' f \u00b7 bsv3'));
        var bar = el('div', 'vbar');
        var play = el('button', 'on', '\u23f8');
        var fast = el('button', null, '\u23e9 1\u00d7');
        bar.appendChild(play);
        bar.appendChild(fast);
        t.appendChild(bar);

        var ctx = cv.getContext('2d');
        var img = new Image();
        var st = { i: 0, t: 0, raf: null, playing: true, rate: 1, last: 0 };

        function cellRect() {
            var col = st.i % v.cols, row = Math.floor(st.i / v.cols);
            return [col * v.cellw, row * v.cellh, v.cellw, v.cellh];
        }
        function draw() {
            if (!img.complete || !img.naturalWidth) { return; }
            var r = cellRect();
            ctx.clearRect(0, 0, cv.width, cv.height);
            ctx.imageSmoothingEnabled = s < 1;
            ctx.drawImage.apply(ctx, [img].concat(r)
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
        img.onload = function () { draw(); };
        img.src = B + 'assets/' + v.path;
        if (img.complete) { draw(); }
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

        players.push({ stop: function () { cancelAnimationFrame(st.raf); } });
        return t;
    }

    global.AssetVariants = { render: renderVariants };
})(window);
