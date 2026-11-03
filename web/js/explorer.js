/* explorer.js — asset explorer page logic (server-backed).
 *
 * The manifest grew to ~3.5M entries (~2.2 GB of parts), so this page no
 * longer loads it in the browser. web/assets-explorer.php serves the shell
 * and inlines only the ~220 core (non-DLC) entries the game's own modules
 * (assets.js / splashlayout.js / scenes.js) need for the Motion tab; every
 * browse, search, variant, string and data-file query goes to the PHP API
 * in web/api/assets.php, which reads the SQLite index built by
 * tools/build_assets_db.php. Search words (path, origin, family, resClass,
 * kind — plus the decoded .btp strings) are matched in the database.
 *
 *   - images: grid of thumbnails, big preview with fit/100% zoom, and
 *     side-by-side switching between the small/medium/large resolution
 *     classes the game ships (manifest `family` grouping)
 *   - audio: WAVs (music, UI SFX, Homer lines) with a full player
 *   - fonts: glyph samples rendered in the game's own faces
 *   - strings: the 16 decoded .btp string tables, searchable in the DB
 *   - data: raw text of XML/TXT/GLSL/HTML data files (from the DB)
 *   - motion: live previews of the animations the APK's data describes
 *   - dlc / animations tabs: DB-side grouping into families/characters
 */
(function () {
    'use strict';

    var API = window.EXPLORER_API || 'api/assets.php';
    var PAGE = 240;                       // tiles per grid page
    var D = window.WEBDATA;

    // ---------------------------------------------------------------- helpers
    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) { n.className = cls; }
        if (text != null) { n.textContent = text; }
        return n;
    }
    function humanBytes(n) {
        if (n == null) { return '—'; }
        if (n < 1024) { return n + ' B'; }
        if (n < 1024 * 1024) { return (n / 1024).toFixed(1) + ' KB'; }
        return (n / 1024 / 1024).toFixed(2) + ' MB';
    }
    function base(p) { return p.split('/').pop(); }
    function esc(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;',
                     '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    var seqs = {};                        // fetch race guard, per channel
    function apiGet(params, ch) {
        var qs = [];
        for (var k in params) {
            if (params[k] != null && params[k] !== '') {
                qs.push(encodeURIComponent(k) + '=' +
                        encodeURIComponent(params[k]));
            }
        }
        var my = (seqs[ch] = (seqs[ch] || 0) + 1);
        return fetch(API + '?' + qs.join('&'), { cache: 'no-store' })
            .then(function (r) {
                return r.json().then(function (j) {
                    if (!r.ok) { throw new Error(j.error || ('HTTP ' + r.status)); }
                    return { my: my, data: j };
                });
            });
    }

    var FONT_FAMILIES = {
        'fonts/comiccrazyrevised.otf': "'ComicCrazy'",
        'fonts/comiccrazyrevisedbold.otf': "'ComicCrazy'",
        'fonts/helveticaneue.ttf': "'HelveticaNeue'",
        'fonts/helveticaneuebold.ttf': "'HelveticaNeue'"
    };

    var TABS = [
        { id: 'all', label: 'All' },
        { id: 'image', label: 'Images' },
        { id: 'audio', label: 'Audio' },
        { id: 'video', label: 'Movies' },
        { id: 'anim', label: 'Animations' },
        { id: 'font', label: 'Fonts' },
        { id: 'i18n', label: 'Strings' },
        { id: 'data', label: 'Data' },
        { id: 'dlc', label: 'DLC' },
        { id: 'android', label: 'Android shell' }
    ];
    var MOTION = { id: 'motion', label: 'Motion' };

    var state = { tab: 'all', q: '', selected: null, motionLang: 'en',
                  animChar: null, dlcFam: null,
                  offset: 0, total: 0, kind: 'assets', items: [],
                  gridSeq: 0 };

    var grid = document.getElementById('grid');
    var detail = document.getElementById('detail');
    var crumb = document.getElementById('crumb');

    // ---------------------------------------------------------------- tabs
    function renderTabs() {
        var nav = document.getElementById('tabs');
        apiGet({ op: 'counts', q: state.q }, 'counts').then(function (res) {
            if (res.my !== seqs.counts) { return; }
            var counts = res.data.counts;
            nav.innerHTML = '';
            var all = TABS.concat([MOTION]);
            for (var i = 0; i < all.length; i++) (function (t) {
                var b = el('button', state.tab === t.id ? 'on' : '');
                b.innerHTML = esc(t.label) +
                    (t.id === 'motion' ? ''
                        : ' <span class="n">' + (counts[t.id] || 0) + '</span>');
                b.addEventListener('click', function () { setTab(t.id); });
                nav.appendChild(b);
            })(all[i]);
        }, function () { /* keep stale tab counts */ });
    }

    // --------------------------------------------------------------- tiles
    function subLabel(e) {
        switch (e.type) {
            case 'image':
                return (e.w != null ? e.w + '×' + e.h : '') +
                       (e.resClass ? ' · ' + e.resClass : '');
            case 'audio':
                return (e.kind || '') +
                       (e.duration_s != null ? ' · ' + e.duration_s + 's' : '');
            case 'video':
                return (e.w != null ? e.w + '×' + e.h + ' · ' : '') +
                       (e.duration_s != null ? e.duration_s + 's' : '') +
                       (e.resClass ? ' · ' + e.resClass : '');
            case 'anim':
                return (e.n_frames || 0) + ' frames' +
                       (e.w != null ? ' · ' + e.w + '×' + e.h : '') +
                       (e.resClass ? ' · ' + e.resClass : '');
            case 'font':
                return (e.path.indexOf('bold') >= 0 ? 'bold' : 'regular') + ' face';
            case 'i18n':
                return (e.strings || 0) + ' strings';
            default:
                return humanBytes(e.bytes);
        }
    }

    function tilePic(e, opts) {
        var picCls = 'tile-pic';
        var hasPic = e.type === 'image' || (e.type === 'video' && e.thumb) ||
            (e.type === 'anim' && e.frames && e.frames.length);
        if (opts.pic) { hasPic = true; }
        if (hasPic) {
            var pic = el('div', picCls + (opts.picCls ? ' ' + opts.picCls : ''));
            var img = document.createElement('img');
            img.loading = 'lazy';
            img.decoding = 'async';
            img.src = 'assets/' + (opts.src || e.thumb || e.path);
            img.alt = base(e.path);
            pic.appendChild(img);
            if (e.type === 'video' || e.type === 'anim') {
                pic.classList.add(e.type === 'video' ? 'video' : 'anim');
                pic.appendChild(el('span', 'play-badge', '▶'));
            }
            return pic;
        }
        var glyph = null;
        if (e.type === 'audio') {
            glyph = e.kind === 'music' ? '♫' : '♪';
            picCls += ' glyph' + (e.kind === 'music' ? ' music' : '');
        } else if (e.type === 'font') {
            glyph = 'Ag';
            picCls += ' glyph';
        } else if (e.type === 'i18n') {
            glyph = base(e.path).slice(0, -5).toUpperCase();
            picCls += ' glyph';
        } else if (e.type === 'video') {
            glyph = '▶';
            picCls += ' glyph video';
        } else if (opts.glyph != null) {
            glyph = opts.glyph;
            picCls += ' glyph';
        } else {
            glyph = '≡';
            picCls += ' glyph';
        }
        var pic2 = el('div', picCls, glyph);
        if (e.type === 'font') {
            pic2.style.fontFamily = FONT_FAMILIES[e.path] || 'sans-serif';
            pic2.style.fontWeight = e.path.indexOf('bold') >= 0 ? 'bold' : 'normal';
            pic2.style.fontSize = '34px';
        } else if (e.type === 'i18n') {
            pic2.style.fontFamily = "'ComicCrazy', sans-serif";
            pic2.style.fontSize = '26px';
        }
        return pic2;
    }

    function makeTile(cls) {
        var t = el('div', 'tile' + (cls || ''));
        return t;
    }

    function tileFor(e) {
        var t = makeTile(state.selected === e.path ? ' sel' : '');
        t.dataset.path = e.path;
        t.appendChild(tilePic(e, {}));
        t.appendChild(el('div', 'tile-label', base(e.path)));
        t.appendChild(el('div', 'tile-sub', subLabel(e)));
        t.addEventListener('click', function () { select(e.path); });
        return t;
    }

    // one tile per character (Animations tab level 1, from anim_char)
    function charTile(g) {
        var t = makeTile();
        t.dataset.char = g.char;
        var pic = el('div', 'tile-pic');
        var img = document.createElement('img');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.src = 'assets/' + (g.thumb || g.rep_path);
        img.alt = g.char;
        pic.appendChild(img);
        t.appendChild(pic);
        t.appendChild(el('div', 'tile-label',
            g.char.charAt(0).toUpperCase() + g.char.slice(1)));
        t.appendChild(el('div', 'tile-sub',
            g.n_anims + (g.n_anims === 1 ? ' animation' : ' animations')));
        t.addEventListener('click', function () { setAnimChar(g.char); });
        return t;
    }

    // one tile per distinct animation (rep entry), from the DB's group rows
    function animTile(g, showChar) {
        var e = g.entry;
        var t = makeTile(state.selected === e.path ? ' sel' : '');
        t.dataset.path = e.path;
        t.appendChild(tilePic(e, { pic: true, picCls: 'anim',
                                   src: e.thumb || e.path }));
        t.appendChild(el('div', 'tile-label',
            showChar ? g.char + '_' + g.name : g.name));
        t.appendChild(el('div', 'tile-sub', subLabel(e)));
        t.addEventListener('click', function () { select(e.path); });
        return t;
    }

    // one tile per event family (DLC tab level 1, from dlc_fam)
    function famTile(g) {
        var t = makeTile();
        t.dataset.fam = g.fam;
        var pic = el('div', 'tile-pic' + (g.thumb ? '' : ' glyph'));
        if (g.thumb) {
            var img = document.createElement('img');
            img.loading = 'lazy';
            img.decoding = 'async';
            img.src = 'assets/' + g.thumb;
            img.alt = g.fam;
            pic.appendChild(img);
        } else {
            pic.appendChild(document.createTextNode(
                g.fam.charAt(0).toUpperCase()));
        }
        t.appendChild(pic);
        t.appendChild(el('div', 'tile-label',
            g.fam.charAt(0).toUpperCase() + g.fam.slice(1)));
        t.appendChild(el('div', 'tile-sub',
            g.n_assets + ' assets · ' + g.packs +
            (g.packs === 1 ? ' pack' : ' packs')));
        t.addEventListener('click', function () { setDlcFam(g.fam); });
        return t;
    }

    // one tile per distinct file of a family (rep entry)
    function dlcTile(g, showFam) {
        var e = g.entry;
        var t = makeTile(state.selected === e.path ? ' sel' : '');
        t.dataset.path = e.path;
        if (e.type === 'image') {
            var pic = el('div', 'tile-pic');
            var img = document.createElement('img');
            img.loading = 'lazy';
            img.decoding = 'async';
            img.src = 'assets/' + (e.thumb || e.path);
            img.alt = g.name;
            pic.appendChild(img);
            t.appendChild(pic);
        } else {
            t.appendChild(el('div', 'tile-pic glyph',
                g.name.slice(-4).toUpperCase()));
        }
        t.appendChild(el('div', 'tile-label',
            showFam ? g.fam + ' / ' + g.name : g.name));
        t.appendChild(el('div', 'tile-sub',
            showFam ? (e.type + ' · ' + subLabel(e)) : subLabel(e)));
        t.addEventListener('click', function () { select(e.path); });
        return t;
    }

    // ---------------------------------------------------------------- grid
    function gridParams() {
        var p = { op: 'list', tab: state.tab, q: state.q,
                  offset: state.offset, limit: PAGE };
        if (state.tab === 'anim' && !state.q) { p.char = state.animChar; }
        if (state.tab === 'dlc' && !state.q) { p.fam = state.dlcFam; }
        return p;
    }

    function tilesFor(kind, items) {
        var frag = document.createDocumentFragment();
        for (var i = 0; i < items.length; i++) {
            var g = items[i];
            if (kind === 'assets') { frag.appendChild(tileFor(g)); }
            else if (kind === 'chars') { frag.appendChild(charTile(g)); }
            else if (kind === 'anims') { frag.appendChild(animTile(g, g.char != null)); }
            else if (kind === 'fams') { frag.appendChild(famTile(g)); }
            else if (kind === 'files') { frag.appendChild(dlcTile(g, g.fam != null)); }
        }
        return frag;
    }

    function renderCrumb() {
        crumb.innerHTML = '';
        var c = null, n = state.total, unit = '', back = null;
        if (state.tab === 'anim' && state.animChar != null && !state.q) {
            c = state.animChar;
            unit = n === 1 ? ' animation' : ' animations';
            back = function () { setAnimChar(null); };
        } else if (state.tab === 'dlc' && state.dlcFam != null && !state.q) {
            c = state.dlcFam;
            unit = ' assets';
            back = function () { setDlcFam(null); };
        }
        if (!c) { return; }
        var b = el('button', null, '← all ' +
            (state.tab === 'anim' ? 'characters' : 'families'));
        b.addEventListener('click', back);
        crumb.appendChild(b);
        crumb.appendChild(el('span', 'crumb-label',
            c.charAt(0).toUpperCase() + c.slice(1) + ' · ' + n + unit));
    }

    function appendLoadMore() {
        if (state.offset >= state.total) { return; }
        var more = el('button', 'more', 'Load more — showing ' +
            Math.min(state.offset, state.total) + ' of ' + state.total);
        more.addEventListener('click', function () {
            state.offset += PAGE;
            fetchGrid(false);
        });
        grid.appendChild(more);
    }

    function fetchGrid(reset) {
        if (reset) { state.offset = 0; }
        apiGet(gridParams(), 'grid').then(function (res) {
            if (res.my !== seqs.grid) { return; }   // a newer render won
            var d = res.data;
            state.kind = d.kind;
            state.total = d.total;
            if (reset) {
                state.items = d.items;
                grid.innerHTML = '';
            } else {
                for (var i = 0; i < d.items.length; i++) {
                    state.items.push(d.items[i]);
                }
            }
            grid.appendChild(tilesFor(d.kind, d.items));
            renderCrumb();
            appendLoadMore();
        }, function (err) {
            if (reset) { grid.innerHTML = ''; }
            grid.appendChild(el('div', 'placeholder',
                'The asset index could not be queried: ' + err.message +
                ' — is the PHP server running and the database built ' +
                '(php tools/build_assets_db.php)?'));
        });
    }

    function renderGrid() { fetchGrid(true); }

    function markSelected() {
        var tiles = grid.children;
        for (var i = 0; i < tiles.length; i++) {
            if (!tiles[i].dataset) { continue; }
            var on = tiles[i].dataset.path === state.selected;
            if (tiles[i].classList.contains('tile')) {
                tiles[i].className = 'tile' + (on ? ' sel' : '');
            }
        }
    }

    function setAnimChar(c) {
        state.animChar = c;
        renderGrid();
    }

    function setDlcFam(f) {
        state.dlcFam = f;
        renderGrid();
    }

    // ------------------------------------------------------------- detail pane
    function detailHeader(e, extra) {
        var h = el('div', 'd-head');
        var h2 = el('h2', null, base(e.path));
        if (extra) { h2.appendChild(extra); }
        h.appendChild(h2);
        var bits = [];
        if (e.resClass) { bits.push(e.resClass); }
        if (e.w != null && e.h != null) { bits.push(e.w + '×' + e.h); }
        bits.push(humanBytes(e.bytes));
        h.appendChild(el('div', 'd-sub', bits.join(' · ')));
        return h;
    }

    function metaTable(rows) {
        var t = document.createElement('table');
        t.className = 'meta';
        for (var i = 0; i < rows.length; i++) {
            var tr = document.createElement('tr');
            tr.appendChild(el('td', null, rows[i][0]));
            tr.appendChild(el('td', 'val', String(rows[i][1])));
            t.appendChild(tr);
        }
        return t;
    }

    // metadata rows for content decoded from a fan-CDN DLC pack
    function dlcRows(e) {
        if (!e.dlc) { return []; }
        return [
            ['DLC pack', e.dlc.pack],
            ['Season', e.dlc.season || '—'],
            ['Tier', e.dlc.tier || '—'],
            ['Revision', e.dlc.revision ? 'r' + e.dlc.revision : '—'],
            ['Source URL', e.dlc.url]
        ];
    }

    var currentAudio = null;
    function stopAudio() {
        if (currentAudio) {
            try {
                if (currentAudio.dispose) { currentAudio.dispose(); }
                else { currentAudio.pause(); }
            } catch (e2) { /* ignore */ }
            currentAudio = null;
        }
    }
    var currentVideo = null;
    function stopVideo() {
        if (currentVideo) {
            try {
                currentVideo.pause();
                currentVideo.removeAttribute('src');
                currentVideo.load();
            } catch (e2) { /* ignore */ }
            currentVideo = null;
        }
    }
    var animTimer = null;
    function stopAnim() {
        if (animTimer != null) {
            clearTimeout(animTimer);
            animTimer = null;
        }
    }

    // shared variant switcher: the DB returns all manifest entries sharing
    // e.family (APK resolution classes or CDN device tiers), sorted
    function famLabel(e) {
        return e.type === 'video' ? 'Device variants — '
             : (e.dlc ? 'DLC resolution tiers — '
                      : 'Resolution classes in the APK — ');
    }
    function appendVariants(box, e) {
        if (!e.family) { return; }
        apiGet({ op: 'variants', family: e.family, type: e.type,
                 path: e.path, res: e.resClass,
                 base: e.dlc ? base(e.path) : null }, 'variants')
            .then(function (res) {
                var fam = res.data.items || [];
                if (fam.length <= 1) { return; }
                var v = el('div', 'variants');
                v.appendChild(el('div', 'vlabel', famLabel(e) + fam.length));
                var row = el('div', 'vrow');
                for (var j = 0; j < fam.length; j++) (function (f) {
                    var b = el('button', f.path === e.path ? 'on' : '',
                        f.resClass +
                        (f.dlc && f.dlc.revision != null ? ' · r' + f.dlc.revision : '') +
                        (f.w != null ? ' · ' + f.w + '×' + f.h : ''));
                    b.addEventListener('click', function () { select(f.path); });
                    row.appendChild(b);
                })(fam[j]);
                v.appendChild(row);
                box.appendChild(v);
            }, function () { /* variant row is optional */ });
    }

    function detailImage(e) {
        var box = el('div');
        var badge = e.dlc ? el('span', 'badge dlc', 'DLC pack')
                          : (e.origin ? el('span', 'badge star', '★ used by the game')
                                      : null);
        box.appendChild(detailHeader(e, badge));

        // preview with fit / 100% zoom
        var bar = el('div', 'zoombar');
        var img = document.createElement('img');
        img.src = 'assets/' + e.path;
        img.alt = base(e.path);
        var scroll = el('div', 'pv-scroll fit');
        scroll.appendChild(img);
        var fitBtn = el('button', 'on', 'Fit');
        var fullBtn = el('button', '100%');
        function setZoom(fit) {
            scroll.className = 'pv-scroll ' + (fit ? 'fit' : '');
            if (!fit) { img.removeAttribute('style'); }
            fitBtn.className = fit ? 'on' : '';
            fullBtn.className = fit ? '' : 'on';
        }
        fitBtn.addEventListener('click', function () { setZoom(true); });
        fullBtn.addEventListener('click', function () { setZoom(false); });
        bar.appendChild(fitBtn);
        bar.appendChild(fullBtn);
        bar.appendChild(el('span', 'hint', 'scroll at 100% to pan'));
        box.appendChild(bar);
        box.appendChild(scroll);

        appendVariants(box, e);

        var rows = [
            ['Type', 'image' + (e.bpp ? ' · ' +
                (e.bpp === 4 ? 'RGBA (4 bytes/px)'
                              : 'RGBA4444 (2 bytes/px), ' +
                                (e.premul === false ? 'straight alpha'
                                                     : 'premultiplied')) : '')],
            ['Source pack', e.dlc ? '—' : e.source],
            ['Original file', e.origin || '—'],
            ['Anchor point', e.anchor ? e.anchor[0] + ', ' + e.anchor[1] : '—'],
            ['File size', humanBytes(e.bytes)]
        ];
        if (e.thumb) { rows.push(['Grid thumbnail', e.thumb]); }
        rows = rows.concat(dlcRows(e));
        box.appendChild(metaTable(rows));
        return box;
    }

    function detailAudio(e) {
        stopAudio();
        var box = el('div');
        var kindBadge = el('span', 'badge', e.kind || 'audio');
        box.appendChild(detailHeader(e, kindBadge));

        /* The mixer owns playback: a pre-decoded Web Audio buffer where the
           browser allows it — which starts on sample 0, the point of this
           whole exercise — and an HTMLAudioElement when it does not. */
        var url = 'assets/' + e.path;
        var player = (window.AudioMixer && window.AudioMixer.makePlayer)
            ? window.AudioMixer.makePlayer(url) : null;

        var p = el('div', 'player');
        var row = el('div', 'row');
        var play = el('button', 'big', '▶');
        var seek = el('input');
        seek.type = 'range';
        seek.min = 0;
        seek.max = 0;
        seek.step = 0.05;
        var time = el('span', 'time', '0:00 / ' +
            (e.duration_s != null ? e.duration_s + 's' : '—'));
        row.appendChild(play);
        row.appendChild(seek);
        row.appendChild(time);

        var row2 = el('div', 'row');
        var vol = el('input', 'vol');
        vol.type = 'range';
        vol.min = 0;
        vol.max = 1;
        vol.step = 0.01;
        vol.value = 0.8;
        if (player) { player.setVolume(0.8); }
        /* Diagnostic for the "the first bit is missing / silence then sound"
           report: ears cannot tell a file that starts late from a file whose
           head was skipped, so measure it. 'start' is the position playback
           actually began at and 'wait' how long the click waited for the first
           'playing' event — start > 0 means samples were really jumped over,
           a long wait with start 0.000 means the head is only delayed by the
           fetch/decode. 'got' is what the network delivered for this file. */
        var diag = el('span', 'diag', 'buf —');
        var waitMs = null, startAt = null;
        function stamp() {
            var buf = player ? player.bufferedEnd() : 0;
            var txt = 'start ' + (startAt == null ? '—' : startAt.toFixed(3) + ' s') +
                ' · wait ' + (waitMs == null ? '—' : waitMs + ' ms') +
                ' · buf ' + buf.toFixed(2) + ' s · ' +
                (player ? player.kind : 'no player');
            try {
                var en = (window.performance || {}).getEntriesByName;
                var abs = url;
                if (en && window.location) {
                    abs = new URL(url, window.location.href).href;
                    var l = (window.performance.getEntriesByName(abs) || [])[0];
                    if (l && l.duration) {
                        txt += ' · got ' + humanBytes(l.transferSize || l.encodedBodySize || 0) +
                            ' in ' + Math.round(l.duration) + ' ms';
                    }
                }
            } catch (err) { /* Resource Timing or URL unavailable: fine */ }
            diag.textContent = txt;
            diag.setAttribute('data-tip',
                'where playback actually started, how long the click waited for '
                + 'it, how much is available, and what the network delivered; '
                + '"buffer" means the sound was decoded before it was played, '
                + 'so it cannot lose its head');
        }
        function onPlaying() {
            if (!player) { return; }
            waitMs = Math.round(performance.now() - playAt);
            startAt = player.pos() || 0;
            stamp();
            if (window.console && window.console.info &&
                    (waitMs > 60 || startAt > 0.02)) {
                window.console.info('explorer audio: ' + e.path + ' started at ' +
                    startAt.toFixed(3) + ' s after ' + waitMs + ' ms via ' +
                    player.kind);
            }
        }

        var chk = document.createElement('label');
        chk.className = 'chk';
        var loop = document.createElement('input');
        loop.type = 'checkbox';
        chk.appendChild(loop);
        chk.appendChild(document.createTextNode(' loop'));
        row2.appendChild(vol);
        row2.appendChild(chk);
        row2.appendChild(diag);

        function fmt(s) {
            if (!isFinite(s)) { s = 0; }
            s = Math.round(s);
            return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
        }
        var playAt = 0;
        var raf = null;

        function syncButtons() {
            if (player) { play.textContent = player.paused() ? '▶' : '❚❚'; }
        }

        function updateTime() {
            if (!player) { return; }
            var d = player.dur();
            if (isFinite(d) && d > 0) { seek.max = d; }
            seek.value = player.pos();
            time.textContent = fmt(player.pos()) + ' / ' +
                (isFinite(d) ? fmt(d) : '—');
        }

        /* A decoded buffer has no timeupdate events, so the position is
           polled while it plays; the element path is polled the same way. */
        function tick() {
            raf = null;
            if (!player) { return; }
            updateTime();
            if (!player.paused()) { raf = requestAnimationFrame(tick); }
        }

        if (player) {
            player.onState = function (what) {
                if (what === 'play') {
                    onPlaying();
                    syncButtons();
                    if (!raf) { tick(); }
                } else if (what === 'pause' || what === 'ended') {
                    syncButtons();
                    updateTime();
                } else if (what === 'ready') {
                    updateTime();
                } else if (what === 'error') {
                    /* Say what really happened: MediaError code 4 is "the
                       browser cannot decode this" (an ADPCM WAV that never got
                       converted), anything else is a load/play failure. */
                    var c = player.errorCode ? player.errorCode() : 0;
                    time.textContent = c === 4
                        ? '(undecodable: ' + (e.codec || 'unknown codec') + ', ' +
                          (e.sample_rate || '?') + ' Hz)'
                        : '(' + what + ')';
                    play.textContent = '▶';
                }
                stamp();
            };
            currentAudio = player;
            player.prepare(function () { updateTime(); stamp(); });
        } else {
            time.textContent = '(no audio player)';
        }

        play.addEventListener('click', function () {
            if (!player) { return; }
            if (player.paused()) {
                playAt = performance.now();
                var d = player.dur();
                var at = player.pos();
                /* From the top when nothing has been heard yet or it finished:
                   the element engine then waits for data and rewinds before
                   it makes sound, which is what kept eating the attack. */
                player.play(at <= 0.001 ||
                    (isFinite(d) && d > 0 && at >= d - 0.05));
            } else {
                player.pause();
            }
        });
        seek.addEventListener('input', function () {
            if (player) { player.seek(Number(seek.value)); updateTime(); }
        });
        vol.addEventListener('input', function () {
            if (player) { player.setVolume(Number(vol.value)); }
        });
        loop.addEventListener('change', function () {
            if (player) { player.setLoop(loop.checked); }
        });

        p.appendChild(row);
        p.appendChild(row2);
        box.appendChild(p);

        /* Downloads: what plays here (the AAC an AAC run wrote, or the PCM16
           WAV if the corpus is still in that state) and, when the conversion
           left it behind, the game's own IMA ADPCM file — which no browser can
           decode, so a link is the only useful thing to offer. */
        function dlLink(href, fname, label, tip) {
            var a = document.createElement('a');
            a.className = 'dl';
            a.href = href;
            a.download = fname;
            a.textContent = label;
            if (tip) { a.setAttribute('data-tip', tip); }
            return a;
        }
        var dlRow = el('div', 'row dl-row');
        var asPlayed = e.codec === 'aac' ? 'AAC .m4a' :
            (e.codec === 'pcm' ? 'PCM16 WAV' : (e.codec || 'file'));
        dlRow.appendChild(dlLink('assets/' + e.path, base(e.path),
            '\u2b07 ' + asPlayed,
            'the file this page plays (' + humanBytes(e.bytes) + ')'));
        if (e.original) {
            dlRow.appendChild(dlLink(
                API + '?op=original&path=' + encodeURIComponent(e.path),
                base(e.path).replace(/\.(wav|m4a)$/i, '') + '-original.wav',
                '\u2b07 original IMA ADPCM',
                'the game\u2019s own file before tools/convert_audio_pcm.py '
                + 're-encoded it (' + humanBytes(e.original.bytes) + ')'));
        }
        p.appendChild(dlRow);

        var rows = [
            ['Kind', e.kind || '—'],
            ['Channels', e.channels || '—'],
            ['Sample rate', e.sample_rate ? e.sample_rate + ' Hz' : '—'],
            ['Codec', e.codec || '—'],
            ['Duration', e.duration_s != null ? e.duration_s + ' s' : '—'],
            ['Source pack', e.dlc ? '—' : e.source],
            ['Original file', e.origin || '—'],
            ['File size', humanBytes(e.bytes)]
        ];
        if (e.original) {
            rows.push(['Pre-conversion file',
                'IMA ADPCM \u00b7 ' + humanBytes(e.original.bytes)]);
        }
        rows = rows.concat(dlcRows(e));
        box.appendChild(metaTable(rows));
        return box;
    }

    function detailVideo(e) {
        stopVideo();
        var box = el('div');
        box.appendChild(detailHeader(e, el('span', 'badge dlc', 'DLC pack')));

        var v = document.createElement('video');
        v.className = 'video-player';
        v.controls = true;
        v.preload = 'metadata';
        if (e.thumb) { v.poster = 'assets/' + e.thumb; }
        v.src = 'assets/' + e.path;
        box.appendChild(v);
        currentVideo = v;

        appendVariants(box, e);

        var rows = [
            ['Type', 'video · ' + (e.vcodec || '?') +
                     (e.acodec ? ' + ' + e.acodec : '')],
            ['Duration', e.duration_s != null ? e.duration_s + ' s' : '—'],
            ['Source pack', '—'],
            ['Original file', e.origin || '—'],
            ['File size', humanBytes(e.bytes)]
        ];
        if (e.thumb) { rows.push(['Grid thumbnail', e.thumb]); }
        rows = rows.concat(dlcRows(e));
        box.appendChild(metaTable(rows));
        return box;
    }

    function detailAnim(e) {
        stopAnim();
        var box = el('div');
        box.appendChild(detailHeader(e, el('span', 'badge dlc', 'DLC pack')));

        var frames = e.frames || [];
        if (!frames.length) {
            box.appendChild(el('div', 'hint', 'no frames decoded'));
            return box;
        }

        // stage over a checkerboard so transparent pixels read clearly
        var stage = el('div', 'anim-stage');
        var img = document.createElement('img');
        img.className = 'anim-img';
        img.alt = e.path;
        stage.appendChild(img);
        box.appendChild(stage);

        var p = el('div', 'player');
        var row = el('div', 'row');
        var play = el('button', 'big', '▶');
        var count = el('span', 'time', '1 / ' + frames.length);
        row.appendChild(play);
        row.appendChild(el('span', 'hint',
            (e.char || 'character') + ' · ' + (e.animation || '')));
        row.appendChild(count);
        var row2 = el('div', 'row');
        var chk = document.createElement('label');
        chk.className = 'chk';
        var loop = document.createElement('input');
        loop.type = 'checkbox';
        loop.checked = true;
        chk.appendChild(loop);
        chk.appendChild(document.createTextNode(' loop'));
        row2.appendChild(chk);
        p.appendChild(row);
        p.appendChild(row2);
        box.appendChild(p);

        var idx = 0;
        var dir = e.path.replace(/[^/]*$/, '');  // dir of the first frame
        function show(i) {
            idx = i;
            img.src = 'assets/' + dir + frames[i].f;
            count.textContent = (i + 1) + ' / ' + frames.length;
        }
        function step() {
            if (!loop.checked && idx >= frames.length - 1) {
                animTimer = null;
                play.textContent = '▶';
                return;
            }
            show((idx + 1) % frames.length);
            animTimer = setTimeout(step,
                                   Math.max(16, frames[idx].delay || 100));
        }
        show(0);
        play.addEventListener('click', function () {
            if (animTimer != null) {
                clearTimeout(animTimer);
                animTimer = null;
                play.textContent = '▶';
            } else {
                play.textContent = '❚❚';
                animTimer = setTimeout(step, 16);
            }
        });

        appendVariants(box, e);

        var rows = [
            ['Type', 'animation · ' + (e.n_frames || frames.length) +
                     ' frames' +
                     (e.n_cells ? ' · ' + e.n_cells + ' cells' : '')],
            ['Character', e.char || '—'],
            ['Animation', e.animation || '—'],
            ['Frame size', e.w != null ? e.w + '×' + e.h : '—'],
            ['Source pack', '—'],
            ['Original file', e.origin || '—'],
            ['File size', humanBytes(e.bytes)]
        ];
        if (e.thumb) { rows.push(['Grid thumbnail', e.thumb]); }
        rows = rows.concat(dlcRows(e));
        box.appendChild(metaTable(rows));
        return box;
    }

    function detailFont(e) {
        var box = el('div');
        box.appendChild(detailHeader(e));
        var fam = FONT_FAMILIES[e.path] || 'sans-serif';
        var bold = e.path.indexOf('bold') >= 0;
        var s = el('div', 'font-sample');
        s.style.fontFamily = fam + ', sans-serif';
        s.style.fontWeight = bold ? 'bold' : 'normal';
        s.appendChild(el('div', 'line l1', 'The quick brown fox jumps over the lazy dog'));
        s.appendChild(el('div', 'line l2', '0123456789 .,;:!?()[]&%$#@'));
        s.appendChild(el('div', 'line l3',
            'Homer Simpson · Springfield · Tapped Out · academic port'));
        box.appendChild(s);
        box.appendChild(metaTable([
            ['Family', fam.replace(/'/g, '') + (bold ? ' (bold face)' : ' (regular face)')],
            ['Format', e.origin ? e.origin.slice(-3).toUpperCase() : '—'],
            ['File size', humanBytes(e.bytes)],
            ['Source pack', e.dlc ? '—' : e.source]
        ].concat(dlcRows(e))));
        return box;
    }

    // the string table itself is queried from the database (op=strings),
    // so the key/text search works over the stored rows
    function detailI18n(e) {
        var box = el('div');
        var code = base(e.path).slice(0, -5);
        box.appendChild(detailHeader(e, el('span', 'badge', code.toUpperCase())));

        var wrap = el('div', 'strings');
        var q = el('input');
        q.placeholder = 'filter keys or text…';
        var table = document.createElement('table');
        var countRow = el('div', 'hint', '');
        function load(needle) {
            apiGet({ op: 'strings', lang: code, q: needle }, 'strings')
            .then(function (res) {
                if (res.my !== seqs.strings) { return; }   // newer keystroke won
                var rows = res.data.rows;
                table.innerHTML = '';
                for (var i = 0; i < rows.length; i++) {
                    var tr = document.createElement('tr');
                    tr.appendChild(el('td', 'k', rows[i][0]));
                    tr.appendChild(el('td', 'v', String(rows[i][1])));
                    table.appendChild(tr);
                }
                countRow.textContent = rows.length + ' of ' + res.data.total +
                    ' strings in the database';
            }, function (err) {
                table.innerHTML = '';
                countRow.textContent = 'string query failed: ' + err.message;
            });
        }
        var timer = null;
        q.addEventListener('input', function () {
            if (timer) { clearTimeout(timer); }
            timer = setTimeout(function () {
                load(q.value.trim());
            }, 200);
        });
        load('');
        wrap.appendChild(q);
        wrap.appendChild(table);
        box.appendChild(wrap);
        box.appendChild(countRow);

        box.appendChild(metaTable([
            ['Strings', e.strings != null ? e.strings : '—'],
            ['Source pack', e.source],
            ['Original file', e.origin || '—'],
            ['Decoded from', '.btp (Bight string pack)']
        ]));
        return box;
    }

    // data-file text comes from the database (op=data)
    function detailData(e) {
        var box = el('div');
        box.appendChild(detailHeader(e));
        apiGet({ op: 'data', path: e.path }, 'data').then(function (res) {
            if (res.my !== seqs.data) { return; }
            var pre = el('pre', 'data-text',
                res.data.text != null ? res.data.text
                    : '(text not embedded — open ' + e.path + ')');
            // insert right after the header (before variants/meta)
            box.insertBefore(pre, box.children[1] || null);
        }, function () { /* leave the pane header-only */ });
        appendVariants(box, e);
        box.appendChild(metaTable([
            ['Kind', e.type],
            ['Source pack', e.dlc ? '—' : e.source],
            ['Original file', e.origin || '—'],
            ['File size', humanBytes(e.bytes)]
        ].concat(dlcRows(e))));
        return box;
    }

    function renderDetail(e) {
        stopAudio();
        stopVideo();
        stopAnim();
        stopMotionIfNeeded();
        detail.innerHTML = '';
        var body;
        /* A renderer that throws must not leave the pane blank: the user is
           left with an empty sidebar and no clue which of the six builders
           failed. Render what worked and show the failure in its place. */
        try {
            if (e.type === 'image') { body = detailImage(e); }
            else if (e.type === 'audio') { body = detailAudio(e); }
            else if (e.type === 'video') { body = detailVideo(e); }
            else if (e.type === 'anim') { body = detailAnim(e); }
            else if (e.type === 'font') { body = detailFont(e); }
            else if (e.type === 'i18n') { body = detailI18n(e); }
            else { body = detailData(e); }
        } catch (err) {
            if (window.console && window.console.error) {
                window.console.error('explorer: ' + e.type + ' detail failed', err);
            }
            detail.appendChild(el('div', 'placeholder',
                base(e.path) + ': ' + (e.type || '?') + ' panel failed: ' +
                (err && err.message ? err.message : err)));
            if (err && err.stack && window.console && window.console.error) {
                window.console.error(err.stack);
            }
            return;
        }
        detail.appendChild(body);
        detail.scrollTop = 0;
    }

    function select(path) {
        state.selected = path;
        markSelected();
        apiGet({ op: 'asset', path: path }, 'asset').then(function (res) {
            if (state.selected !== path) { return; }   // superseded click
            renderDetail(res.data.entry);
        }, function (err) {
            detail.innerHTML = '';
            detail.appendChild(el('div', 'placeholder',
                'Could not load ' + path + ': ' + err.message));
        });
    }

    // --------------------------------------------------------------- motion tab
    var motionRaf = null;
    var motionT0 = 0;
    var motionCanvases = {};

    var ASPECTS = {
        '16:9': [960, 540],
        '4:3': [960, 720],
        '21:9': [1080, 463],
        '1:1': [640, 640]
    };

    function stopMotion() {
        if (motionRaf != null) {
            cancelAnimationFrame(motionRaf);
            motionRaf = null;
        }
    }
    // leaving the motion tab (selecting another tab) stops the loop; the
    // placeholder/detail swap below calls this via setTab
    function stopMotionIfNeeded() {
        if (state.tab === 'motion') { stopMotion(); }
    }

    function motionCard(title, canvas, note) {
        var c = el('div', 'motion-card');
        var h = el('h3');
        h.appendChild(document.createTextNode(title));
        c.appendChild(h);
        canvas.className = 'motion-cv';
        c.appendChild(canvas);
        if (note) { c.appendChild(el('p', 'note', note)); }
        return c;
    }

    function renderMotion() {
        detail.innerHTML = '';
        var intro = el('p', 'motion-intro',
            'The APK contains no frame-based sprite animations — character and ' +
            'building animation data lives in the native engine (libscorpio.so) ' +
            'and in the runtime DLC that is not part of the APK. What the APK ' +
            'does describe is the motion of its own screens, reproduced here ' +
            'from the game\u2019s data:');
        detail.appendChild(intro);

        // 1) live splash scene (splashscreen.xml layout + finger bob)
        var splash = document.createElement('canvas');
        var dims = ASPECTS['16:9'];
        splash.width = dims[0];
        splash.height = dims[1];
        var card1 = motionCard('Splash screen — live composition', splash,
            'Composed every frame exactly like the game: the closest aspect ' +
            'ruleset from splashscreen.xml is selected, the background window ' +
            'is cropped per the ratio policies, and the tap finger bobs. ' +
            'Change aspect or language to see different rulesets and the ' +
            'localized logo.');
        var selA = document.createElement('select');
        for (var k in ASPECTS) {
            var o = document.createElement('option');
            o.value = k;
            o.textContent = k;
            if (k === '16:9') { o.selected = true; }
            selA.appendChild(o);
        }
        selA.addEventListener('change', function () {
            var d2 = ASPECTS[selA.value];
            splash.width = d2[0];
            splash.height = d2[1];
        });
        var selL = document.createElement('select');
        for (var li = 0; li < I18n.languages.length; li++) {
            var ol = document.createElement('option');
            ol.value = I18n.languages[li];
            ol.textContent = I18n.languages[li];
            if (ol.value === 'en') { ol.selected = true; }
            selL.appendChild(ol);
        }
        selL.addEventListener('change', function () {
            state.motionLang = selL.value;
        });
        selA.style.marginLeft = 'auto';
        selL.style.marginLeft = '6px';
        card1.querySelector('h3').appendChild(selA);
        card1.querySelector('h3').appendChild(selL);
        detail.appendChild(card1);
        motionCanvases.splash = { cv: splash, ctx: splash.getContext('2d') };

        // 2) loading donut spin
        var donut = document.createElement('canvas');
        donut.width = 240;
        donut.height = 240;
        detail.appendChild(motionCard(
            'Loading donut — engine spin', donut,
            'The real loading spinner, rotating as the game spins it ' +
            '(0.40 s / revolution in the loading scene).'));
        motionCanvases.donut = { cv: donut, ctx: donut.getContext('2d') };

        // 3) tap finger bob
        var finger = document.createElement('canvas');
        finger.width = 480;
        finger.height = 240;
        detail.appendChild(motionCard(
            'Tap finger — bob', finger,
            'The \u201ctap here\u201d finger from the splash screen, bobbing on ' +
            'the same sine the layout engine gives it.'));
        motionCanvases.finger = { cv: finger, ctx: finger.getContext('2d') };

        motionT0 = performance.now();
        motionRaf = requestAnimationFrame(motionFrame);
    }

    function drawSplashNow(t) {
        var m = motionCanvases.splash;
        if (!m) { return; }
        var W = m.cv.width, H = m.cv.height;
        var rule = SplashLayout.select(W, H);
        var bg = Assets.get('images/splashscreen.png');
        var layout = SplashLayout.compute(rule, W, H,
            bg ? bg.naturalWidth : 4096, bg ? bg.naturalHeight : 1024,
            state.motionLang);
        m.ctx.clearRect(0, 0, W, H);
        SplashArt.draw(m.ctx, { t: t, W: W, H: H }, layout);
    }
    function drawDonutNow(t) {
        var m = motionCanvases.donut;
        if (!m) { return; }
        var img = Assets.get('images/loading_donut.png');
        var ctx = m.ctx, W = m.cv.width, H = m.cv.height;
        ctx.clearRect(0, 0, W, H);
        if (!img) { return; }
        var s = Math.min(W, H) * 0.8;
        ctx.save();
        ctx.translate(W / 2, H / 2);
        ctx.rotate(t * 1.8 * Math.PI);   // game: rotate(G.t * 1.8) rad
        ctx.drawImage(img, -s / 2, -s / 2, s, s);
        ctx.restore();
    }
    function drawFingerNow(t) {
        var m = motionCanvases.finger;
        if (!m) { return; }
        var img = Assets.get('images/splashfinger.png');
        var ctx = m.ctx, W = m.cv.width, H = m.cv.height;
        ctx.clearRect(0, 0, W, H);
        var g = ctx.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, 'rgb(35, 161, 243)');
        g.addColorStop(1, 'rgb(69, 163, 77)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
        if (!img) { return; }
        var dw = img.naturalWidth * (H / 512);
        var dh = img.naturalHeight * (H / 512);
        var y = H / 2 - dh / 2 + Math.sin(t * 2.4) * 8;
        ctx.drawImage(img, W / 2 - dw / 2, y, dw, dh);
    }
    function motionFrame(now) {
        var t = (now - motionT0) / 1000;
        drawSplashNow(t);
        drawDonutNow(t);
        drawFingerNow(t);
        motionRaf = requestAnimationFrame(motionFrame);
    }

    // ------------------------------------------------------------------- flow
    function setTab(id) {
        stopAudio();
        stopVideo();
        stopMotion();
        state.tab = id;
        state.animChar = null;   // animations re-enter at the character list
        state.dlcFam = null;     // dlc re-enters at the family list
        var main = document.querySelector('main');
        main.classList.toggle('motion', id === 'motion');
        renderTabs();
        if (id === 'motion') {
            grid.innerHTML = '';
            renderMotion();
            return;
        }
        renderGrid();
    }

    // preload the images the motion previews need (same set the game boots with)
    SplashLayout.parse(D.splashXml);
    var critical = Assets.criticalPaths();
    for (var c = 0; c < critical.length; c++) {
        Assets.load(critical[c], function () {});
    }

    var search = document.getElementById('search');
    var searchTimer = null;
    search.addEventListener('input', function () {
        if (searchTimer) { clearTimeout(searchTimer); }
        searchTimer = setTimeout(function () {
            state.q = search.value.trim();
            if (state.tab === 'motion') { setTab('all'); return; }
            renderTabs();
            renderGrid();
        }, 250);
    });

    // deep link: assets-explorer.php?path=<manifest path> opens with that
    // asset selected (the map pages' sprite-variant tiles link here)
    try {
        var deep = new URLSearchParams(location.search).get('path');
        if (deep) { state.selected = deep; }
    } catch (err) { /* no URLSearchParams (or no query): plain boot */ }

    setTab('all');
    if (state.selected) { select(state.selected); }
})();
