/* explorer.js — asset explorer page logic.
 *
 * Browses every asset extracted from the APK (manifest.js inventory +
 * webdata.js embedded data — no fetch(), so it works from file:// like
 * the game itself):
 *
 *   - images: grid of thumbnails, big preview with fit/100% zoom, and
 *     side-by-side switching between the small/medium/large resolution
 *     classes the game ships (manifest `family` grouping)
 *   - audio: 62 WAVs (music, UI SFX, Homer lines) with a full player
 *   - fonts: glyph samples rendered in the game's own faces
 *   - strings: the 16 decoded .btp string tables, searchable
 *   - data: raw text of XML/TXT/GLSL/HTML data files
 *   - motion: live previews of the animations the APK's data describes
 *     (the splash scene composed from splashscreen.xml, the loading
 *     donut spin, the tap-finger bob)
 */
(function () {
    'use strict';

    var M = window.MANIFEST;
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
    var byPath = {};
    for (var i = 0; i < M.files.length; i++) { byPath[M.files[i].path] = M.files[i]; }

    var FONT_FAMILIES = {
        'fonts/comiccrazyrevised.otf': "'ComicCrazy'",
        'fonts/comiccrazyrevisedbold.otf': "'ComicCrazy'",
        'fonts/helveticaneue.ttf': "'HelveticaNeue'",
        'fonts/helveticaneuebold.ttf': "'HelveticaNeue'"
    };
    var CLASS_RANK = { small: 0, 'medium-small': 1, medium: 2, large: 3,
                       mdpi: 0, hdpi: 1, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4,
                       drawable: 5,
                       // CDN pack device tiers (movie/video variants)
                       iphone: 0, ipad: 1, retina: 2, ipad3: 3 };

    // -------------------------------------------------- animation grouping
    // Character animation frames are named <char>_<animation>_f<n>.png
    // (edna_back_walk_f0.png = first frame of Edna's back-walk), so the
    // character is the first underscore-separated segment of the file
    // name. The explorer lists the characters first and collapses each
    // animation's 25/50/100 resolution classes (and duplicate CDN
    // revisions) into one tile.
    function animCharOf(e) {
        var b = base(e.path);
        var u = b.indexOf('_');
        return u < 0 ? b : b.slice(0, u);
    }
    // numeric rank of a resolution class / device tier: APK + numeric
    // CDN tiers (25/50/100) by value, device tiers by CLASS_RANK
    function tierRank(e) {
        var r = CLASS_RANK[e.resClass];
        if (r != null) { return r; }
        var n = parseInt(e.resClass, 10);
        return isFinite(n) ? n : 0;
    }
    // rank two entries of the same logical asset (character animation or
    // DLC file): highest resolution class first, then entries that carry
    // a grid thumbnail, then the unrevised ("current") CDN pack before
    // revisions (newest first)
    function repCmp(a, b) {
        var ta = tierRank(a), tb = tierRank(b);
        if (ta !== tb) { return tb - ta; }
        if (!!a.thumb !== !!b.thumb) { return a.thumb ? 1 : -1; }
        var ra = (a.dlc && a.dlc.revision != null) ? a.dlc.revision : 1 << 30;
        var rb = (b.dlc && b.dlc.revision != null) ? b.dlc.revision : 1 << 30;
        if (ra !== rb) { return rb - ra; }
        return a.path < b.path ? -1 : (a.path > b.path ? 1 : 0);
    }
    var ANIM_CHARS = {};  // char -> { list: [{ name, rep }], thumb }
    var ANIM_ALL = [];    // every distinct char + animation pair (search)
    (function () {
        var buckets = {};
        for (var i = 0; i < M.files.length; i++) {
            var e = M.files[i];
            if (e.type !== 'anim') { continue; }
            var c = animCharOf(e);
            var name = e.animation || base(e.path).replace(/_f\d*\.png$/, '');
            var key = c + '\u0000' + name;
            (buckets[key] = buckets[key] || { char: c, name: name, es: [] })
                .es.push(e);
        }
        for (var key in buckets) {
            var g = buckets[key];
            g.es.sort(repCmp);
            g.rep = g.es[0];
            (ANIM_CHARS[g.char] = ANIM_CHARS[g.char] || { list: [] }).list.push(g);
            ANIM_ALL.push(g);
        }
        for (var c2 in ANIM_CHARS) {
            var list = ANIM_CHARS[c2].list;
            list.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
            var thumb = null;
            for (var j = 0; j < list.length && !thumb; j++) {
                if (list[j].rep.thumb) { thumb = list[j].rep.thumb; }
            }
            ANIM_CHARS[c2].thumb = thumb;
        }
        ANIM_ALL.sort(function (a, b) {
            return a.char < b.char ? -1 : (a.char > b.char ? 1
                : (a.name < b.name ? -1 : 1));
        });
    })();

    // ------------------------------------------------------------ DLC grouping
    // DLC packs ship every file once per device tier (iphone/ipad/ipad3/
    // retina or 25/50/100) and once per CDN revision, so the explorer
    // lists the event families first and collapses each file's
    // tier/revision copies into one tile (the detail pane's variant
    // switcher offers them).
    var DLC_FAMS = {};    // family -> { list: [{ name, type, rep }], packs }
    var DLC_ALL = [];     // every distinct family + file (search)
    (function () {
        var buckets = {};
        for (var i = 0; i < M.files.length; i++) {
            var e = M.files[i];
            if (!e.path || e.path.indexOf('dlc/') !== 0) { continue; }
            if (e.type === 'video' || e.type === 'anim') { continue; }
            var name = base(e.path);
            var key = e.family + '\u0000' + name + '\u0000' + e.type;
            (buckets[key] = buckets[key] || { fam: e.family, name: name,
                                              type: e.type, es: [] }).es.push(e);
        }
        for (var key in buckets) {
            var g = buckets[key];
            g.es.sort(repCmp);
            g.rep = g.es[0];
            (DLC_FAMS[g.fam] = DLC_FAMS[g.fam] || { list: [], packs: {} })
                .list.push(g);
            for (var k = 0; k < g.es.length; k++) {
                var pk = g.es[k].dlc ? g.es[k].dlc.pack : '';
                DLC_FAMS[g.fam].packs[pk] = true;
            }
            DLC_ALL.push(g);
        }
        for (var f in DLC_FAMS) {
            var list = DLC_FAMS[f].list;
            list.sort(function (a, b) {
                return a.name < b.name ? -1 : (a.name > b.name ? 1
                    : (a.type < b.type ? -1 : 1));
            });
            var packs = 0;
            for (var p in DLC_FAMS[f].packs) { packs++; }
            DLC_FAMS[f].packs = packs;
            var thumb = null;
            for (var j = 0; j < list.length && !thumb; j++) {
                if (list[j].type === 'image' &&
                    (list[j].rep.thumb || list[j].rep.path)) {
                    thumb = list[j].rep.thumb || list[j].rep.path;
                }
            }
            DLC_FAMS[f].thumb = thumb;
        }
        DLC_ALL.sort(function (a, b) {
            return a.fam < b.fam ? -1 : (a.fam > b.fam ? 1
                : (a.name < b.name ? -1 : 1));
        });
    })();

    // ------------------------------------------------------------ tabs + grid
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

    function catOf(e) {
        if (e.type === 'video') { return 'video'; }
        if (e.type === 'anim') { return 'anim'; }
        if (e.path && e.path.indexOf('dlc/') === 0) { return 'dlc'; }
        if (e.source && e.source.indexOf('res/') === 0) { return 'android'; }
        if (e.type === 'text' || e.type === 'data') { return 'data'; }
        return e.type;
    }
    var state = { tab: 'all', q: '', selected: null, motionLang: 'en',
                  animChar: null, dlcFam: null };

    function visible(tab) {
        var out = [];
        for (var i = 0; i < M.files.length; i++) {
            var e = M.files[i];
            if (tab !== 'all' && catOf(e) !== tab) { continue; }
            if (state.q) {
                var hay = (e.path + ' ' + (e.origin || '') + ' ' +
                           (e.family || '') + ' ' + (e.resClass || '') +
                           ' ' + (e.kind || '')).toLowerCase();
                if (hay.indexOf(state.q) < 0) { continue; }
            }
            out.push(e);
        }
        return out;
    }

    var grid = document.getElementById('grid');
    var detail = document.getElementById('detail');
    var crumb = document.getElementById('crumb');

    function renderTabs() {
        var nav = document.getElementById('tabs');
        nav.innerHTML = '';
        var all = TABS.concat([MOTION]);
        for (var i = 0; i < all.length; i++) (function (t) {
            var b = el('button', state.tab === t.id ? 'on' : '', t.label);
            var n = t.id === 'motion' ? '' :
                ' <span class="n">' + visible(t.id).length + '</span>';
            b.innerHTML = t.label + n;
            b.addEventListener('click', function () { setTab(t.id); });
            nav.appendChild(b);
        })(all[i]);
    }

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

    function tileFor(e) {
        var t = el('div', 'tile' + (state.selected === e.path ? ' sel' : ''));
        t.dataset.path = e.path;
        var pic, glyph = null, picCls = 'tile-pic';
        var hasPic = e.type === 'image' || (e.type === 'video' && e.thumb) ||
            (e.type === 'anim' && e.frames && e.frames.length);
        if (hasPic) {
            pic = el('div', picCls);
            var img = document.createElement('img');
            img.loading = 'lazy';
            img.decoding = 'async';
            img.src = 'assets/' + (e.thumb || e.path);
            img.alt = base(e.path);
            pic.appendChild(img);
            if (e.type === 'video' || e.type === 'anim') {
                pic.classList.add(e.type === 'video' ? 'video' : 'anim');
                pic.appendChild(el('span', 'play-badge', '▶'));
            }
        } else {
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
            } else {
                glyph = '≡';
                picCls += ' glyph';
            }
            pic = el('div', picCls, glyph);
            if (e.type === 'font') {
                pic.style.fontFamily = FONT_FAMILIES[e.path] || 'sans-serif';
                pic.style.fontWeight = e.path.indexOf('bold') >= 0 ? 'bold' : 'normal';
                pic.style.fontSize = '34px';
            } else if (e.type === 'i18n') {
                pic.style.fontFamily = "'ComicCrazy', sans-serif";
                pic.style.fontSize = '26px';
            }
        }
        t.appendChild(pic);
        t.appendChild(el('div', 'tile-label', base(e.path)));
        t.appendChild(el('div', 'tile-sub', subLabel(e)));
        t.addEventListener('click', function () { select(e); });
        return t;
    }

    // one tile per character: representative thumb (or first frame, when
    // no downsampled thumb exists) + distinct-anim count
    function charTile(c) {
        var g = ANIM_CHARS[c];
        var t = el('div', 'tile');
        t.dataset.char = c;
        var pic = el('div', 'tile-pic');
        var img = document.createElement('img');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.src = 'assets/' + (g.thumb || g.list[0].rep.path);
        img.alt = c;
        pic.appendChild(img);
        t.appendChild(pic);
        t.appendChild(el('div', 'tile-label',
            c.charAt(0).toUpperCase() + c.slice(1)));
        t.appendChild(el('div', 'tile-sub',
            g.list.length + (g.list.length === 1 ? ' animation' : ' animations')));
        t.addEventListener('click', function () { setAnimChar(c); });
        return t;
    }

    // one tile per distinct animation of a character: its representative
    // (highest-resolution, current-revision) entry's first frame
    function animTile(c, g, showChar) {
        var e = g.rep;
        var t = el('div', 'tile' + (state.selected === e.path ? ' sel' : ''));
        t.dataset.path = e.path;
        var pic = el('div', 'tile-pic anim');
        var img = document.createElement('img');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.src = 'assets/' + (e.thumb || e.path);
        img.alt = c + '_' + g.name;
        pic.appendChild(img);
        pic.appendChild(el('span', 'play-badge', '▶'));
        t.appendChild(pic);
        t.appendChild(el('div', 'tile-label',
            showChar ? c + '_' + g.name : g.name));
        t.appendChild(el('div', 'tile-sub', subLabel(e)));
        t.addEventListener('click', function () { select(e); });
        return t;
    }

    // one tile per event family: representative image + asset count
    function famTile(f) {
        var g = DLC_FAMS[f];
        var t = el('div', 'tile');
        t.dataset.fam = f;
        var pic = el('div', 'tile-pic' + (g.thumb ? '' : ' glyph'));
        if (g.thumb) {
            var img = document.createElement('img');
            img.loading = 'lazy';
            img.decoding = 'async';
            img.src = 'assets/' + g.thumb;
            img.alt = f;
            pic.appendChild(img);
        } else {
            pic.appendChild(document.createTextNode(
                f.charAt(0).toUpperCase()));
        }
        t.appendChild(pic);
        t.appendChild(el('div', 'tile-label',
            f.charAt(0).toUpperCase() + f.slice(1)));
        t.appendChild(el('div', 'tile-sub',
            g.list.length + ' assets · ' + g.packs +
            (g.packs === 1 ? ' pack' : ' packs')));
        t.addEventListener('click', function () { setDlcFam(f); });
        return t;
    }

    // one tile per distinct file of a family: its representative
    // (highest-tier, current-revision) entry
    function dlcTile(f, g, showFam) {
        var e = g.rep;
        var t = el('div', 'tile' + (state.selected === e.path ? ' sel' : ''));
        t.dataset.path = e.path;
        if (g.type === 'image') {
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
            showFam ? f + ' / ' + g.name : g.name));
        t.appendChild(el('div', 'tile-sub',
            showFam ? (g.type + ' · ' + subLabel(e)) : subLabel(e)));
        t.addEventListener('click', function () { select(e); });
        return t;
    }

    // breadcrumb above the grid on a character's animation page or a
    // family's DLC page
    function renderCrumb() {
        crumb.innerHTML = '';
        var c = null, n = 0, unit = '', back = null;
        if (state.tab === 'anim' && state.animChar != null && !state.q) {
            c = state.animChar;
            n = ANIM_CHARS[c].list.length;
            unit = n === 1 ? ' animation' : ' animations';
            back = function () { setAnimChar(null); };
        } else if (state.tab === 'dlc' && state.dlcFam != null && !state.q) {
            c = state.dlcFam;
            n = DLC_FAMS[c].list.length;
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

    function setAnimChar(c) {
        state.animChar = c;
        renderGrid();
    }

    function setDlcFam(f) {
        state.dlcFam = f;
        renderGrid();
    }

    function renderGrid() {
        grid.innerHTML = '';
        var frag = document.createDocumentFragment();
        if (state.tab === 'anim' && !state.q) {
            if (state.animChar == null) {
                // level 1: the characters
                var cs = Object.keys(ANIM_CHARS).sort();
                for (var i = 0; i < cs.length; i++) {
                    frag.appendChild(charTile(cs[i]));
                }
            } else {
                // level 2: one character's distinct animations
                var g = ANIM_CHARS[state.animChar];
                for (var j = 0; j < g.list.length; j++) {
                    frag.appendChild(animTile(state.animChar, g.list[j], false));
                }
            }
        } else if (state.tab === 'anim') {
            // search: flat list of the matching distinct animations
            for (var k = 0; k < ANIM_ALL.length; k++) {
                var a = ANIM_ALL[k];
                var hay = (a.char + '_' + a.name + ' ' + (a.rep.family || '') +
                           ' ' + (a.rep.resClass || '') + ' ' + a.rep.path)
                    .toLowerCase();
                if (hay.indexOf(state.q) < 0) { continue; }
                frag.appendChild(animTile(a.char, a, true));
            }
        } else if (state.tab === 'dlc' && !state.q) {
            if (state.dlcFam == null) {
                // level 1: the event families
                var fs = Object.keys(DLC_FAMS).sort();
                for (var x = 0; x < fs.length; x++) {
                    frag.appendChild(famTile(fs[x]));
                }
            } else {
                // level 2: one family's distinct files
                var dg = DLC_FAMS[state.dlcFam];
                for (var y = 0; y < dg.list.length; y++) {
                    frag.appendChild(dlcTile(state.dlcFam, dg.list[y], false));
                }
            }
        } else if (state.tab === 'dlc') {
            // search: flat list of the matching distinct files
            for (var z = 0; z < DLC_ALL.length; z++) {
                var d = DLC_ALL[z];
                var hay2 = (d.name + ' ' + d.fam + ' ' + d.type + ' ' +
                            (d.rep.resClass || '') + ' ' + d.rep.path)
                    .toLowerCase();
                if (hay2.indexOf(state.q) < 0) { continue; }
                frag.appendChild(dlcTile(d.fam, d, true));
            }
        } else {
            var list = visible(state.tab);
            for (var n = 0; n < list.length; n++) { frag.appendChild(tileFor(list[n])); }
        }
        renderCrumb();
        grid.appendChild(frag);
    }

    function markSelected() {
        var tiles = grid.children;
        for (var i = 0; i < tiles.length; i++) {
            var on = tiles[i].dataset.path === state.selected;
            tiles[i].className = 'tile' + (on ? ' sel' : '');
        }
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
            try { currentAudio.pause(); } catch (e2) { /* ignore */ }
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

    // shared variant switcher: all manifest entries sharing e.family
    // (APK resolution classes or CDN device tiers), sorted by CLASS_RANK
    function famLabel(e) {
        return e.type === 'video' ? 'Device variants — '
             : (e.dlc ? 'DLC resolution tiers — '
                      : 'Resolution classes in the APK — ');
    }
    function appendVariants(box, e) {
        if (!e.family) { return; }
        // variant set. For APK content the family names the asset
        // (splashscreen.png / _medium / _large), so the set is the same
        // family + type in OTHER resolution classes. A DLC family is an
        // event shared by hundreds of files, so there the set is every
        // OTHER copy of this exact file (any device tier or CDN
        // revision) — plus this one.
        var name = e.dlc ? base(e.path) : null;
        var fam = [];
        for (var i = 0; i < M.files.length; i++) {
            var f = M.files[i];
            if (f.family !== e.family || f.type !== e.type) { continue; }
            if (name != null) {
                if (f.path !== e.path && base(f.path) === name) { fam.push(f); }
            } else if (f.resClass !== e.resClass) {
                fam.push(f);
            }
        }
        fam.push(e);
        fam.sort(function (a, b) {
            var ra = tierRank(a), rb = tierRank(b);
            if (ra !== rb) { return ra - rb; }
            var xa = (a.dlc && a.dlc.revision != null) ? a.dlc.revision : 1 << 30;
            var xb = (b.dlc && b.dlc.revision != null) ? b.dlc.revision : 1 << 30;
            if (xa !== xb) { return xa - xb; }
            return a.path < b.path ? -1 : 1;
        });
        if (fam.length <= 1) { return; }
        var v = el('div', 'variants');
        v.appendChild(el('div', 'vlabel', famLabel(e) + fam.length));
        var row = el('div', 'vrow');
        for (var j = 0; j < fam.length; j++) (function (f) {
            var b = el('button', f.path === e.path ? 'on' : '',
                f.resClass +
                (f.dlc && f.dlc.revision != null ? ' · r' + f.dlc.revision : '') +
                (f.w != null ? ' · ' + f.w + '×' + f.h : ''));
            b.addEventListener('click', function () { select(f); });
            row.appendChild(b);
        })(fam[j]);
        v.appendChild(row);
        box.appendChild(v);
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

        var a = new Audio('assets/' + e.path);
        a.preload = 'auto';
        currentAudio = a;

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
        a.volume = 0.8;
        var chk = document.createElement('label');
        chk.className = 'chk';
        var loop = document.createElement('input');
        loop.type = 'checkbox';
        chk.appendChild(loop);
        chk.appendChild(document.createTextNode(' loop'));
        row2.appendChild(vol);
        row2.appendChild(chk);

        function fmt(s) {
            if (!isFinite(s)) { s = 0; }
            s = Math.round(s);
            return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
        }
        play.addEventListener('click', function () {
            if (a.paused) {
                var pr = a.play();
                if (pr && pr.catch) {
                    pr.catch(function () { time.textContent = '(autoplay blocked)'; });
                }
            } else {
                a.pause();
            }
        });
        a.addEventListener('play', function () { play.textContent = '❚❚'; });
        a.addEventListener('pause', function () { play.textContent = '▶'; });
        a.addEventListener('ended', function () { play.textContent = '▶'; });
        a.addEventListener('loadedmetadata', function () {
            if (isFinite(a.duration)) {
                seek.max = a.duration;
                time.textContent = '0:00 / ' + fmt(a.duration);
            }
        });
        a.addEventListener('timeupdate', function () {
            seek.value = a.currentTime || 0;
            time.textContent = fmt(a.currentTime) + ' / ' +
                (isFinite(a.duration) ? fmt(a.duration) : '—');
        });
        seek.addEventListener('input', function () {
            if (isFinite(a.duration) && a.duration > 0) {
                a.currentTime = Number(seek.value);
            }
        });
        vol.addEventListener('input', function () { a.volume = Number(vol.value); });
        loop.addEventListener('change', function () { a.loop = loop.checked; });

        p.appendChild(row);
        p.appendChild(row2);
        box.appendChild(p);

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

    function detailI18n(e) {
        var box = el('div');
        var code = base(e.path).slice(0, -5);
        box.appendChild(detailHeader(e, el('span', 'badge', code.toUpperCase())));

        var strings = D.i18n[code] || {};
        var keys = Object.keys(strings).sort();

        var wrap = el('div', 'strings');
        var q = el('input');
        q.placeholder = 'filter keys or text…';
        var table = document.createElement('table');
        function renderRows(needle) {
            table.innerHTML = '';
            for (var i = 0; i < keys.length; i++) {
                var k = keys[i];
                var v = strings[k];
                if (needle && (k + ' ' + v).toLowerCase().indexOf(needle) < 0) {
                    continue;
                }
                var tr = document.createElement('tr');
                tr.appendChild(el('td', 'k', k));
                tr.appendChild(el('td', 'v', String(v)));
                table.appendChild(tr);
            }
        }
        renderRows('');
        q.addEventListener('input', function () {
            renderRows(q.value.trim().toLowerCase());
        });
        wrap.appendChild(q);
        wrap.appendChild(table);
        box.appendChild(wrap);

        box.appendChild(metaTable([
            ['Strings', keys.length],
            ['Source pack', e.source],
            ['Original file', e.origin || '—'],
            ['Decoded from', '.btp (Bight string pack)']
        ]));
        return box;
    }

    function detailData(e) {
        var box = el('div');
        box.appendChild(detailHeader(e));
        var txt = D.dataText ? D.dataText[e.path] : null;
        var pre = el('pre', 'data-text',
            txt != null ? txt : '(text not embedded — open ' + e.path + ')');
        box.appendChild(pre);
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
        if (e.type === 'image') { body = detailImage(e); }
        else if (e.type === 'audio') { body = detailAudio(e); }
        else if (e.type === 'video') { body = detailVideo(e); }
        else if (e.type === 'anim') { body = detailAnim(e); }
        else if (e.type === 'font') { body = detailFont(e); }
        else if (e.type === 'i18n') { body = detailI18n(e); }
        else { body = detailData(e); }
        detail.appendChild(body);
        detail.scrollTop = 0;
    }

    function select(e) {
        state.selected = e.path;
        markSelected();
        renderDetail(e);
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
        var e = state.selected ? byPath[state.selected] : null;
        if (e) { renderDetail(e); }
    }

    // preload the images the motion previews need (same set the game boots with)
    SplashLayout.parse(D.splashXml);
    var critical = Assets.criticalPaths();
    for (var c = 0; c < critical.length; c++) {
        Assets.load(critical[c], function () {});
    }

    // header counts
    var counts = {};
    for (var f = 0; f < M.files.length; f++) {
        var cc = catOf(M.files[f]);
        counts[cc] = (counts[cc] || 0) + 1;
    }
    document.getElementById('counts').textContent =
        M.files.length + ' assets · ' + (counts.image || 0) + ' images · ' +
        (counts.audio || 0) + ' sounds · ' +
        ((counts.video || 0) ? (counts.video || 0) + ' movies · ' : '') +
        (counts.font || 0) + ' fonts · ' +
        (counts.i18n || 0) + ' string tables · ' + (counts.android || 0) +
        ' android icons' +
        ((counts.dlc || 0) ? ' · ' + (counts.dlc || 0) + ' dlc' : '');

    var search = document.getElementById('search');
    search.addEventListener('input', function () {
        state.q = search.value.trim().toLowerCase();
        if (state.tab === 'motion') { setTab('all'); return; }
        renderTabs();
        renderGrid();
    });

    // deep link: assets-explorer.html?path=<manifest path> opens with that
    // asset selected (the map pages' sprite-variant tiles link here)
    try {
        var deep = new URLSearchParams(location.search).get('path');
        if (deep && byPath[deep]) { state.selected = deep; }
    } catch (err) { /* no URLSearchParams (or no query): plain boot */ }

    setTab('all');
})();
