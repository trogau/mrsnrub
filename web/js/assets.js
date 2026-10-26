/* assets.js — image loading + manifest lookups.
 * All data comes from the generated assets/ tree (see manifest.json);
 * no fetch() is used, so the app also works from file:// in browsers
 * that block it (images load via <img>-style Image objects).
 */
(function (global) {
    'use strict';

    var MANIFEST = global.MANIFEST;

    var Assets = {
        images: {},      // asset path (e.g. 'images/splashscreen.png') -> HTMLImageElement
        byPath: {},      // path -> manifest entry
        byOrigin: {},    // original pack filename (e.g. 'lang_french.rgb') -> path
        total: 0,
        loadedCount: 0,
        errors: []
    };

    var i;
    for (i = 0; i < MANIFEST.files.length; i++) {
        var e = MANIFEST.files[i];
        Assets.byPath[e.path] = e;
        if (e.origin) {
            // splashscreen.xml names some files with mixed case
            // ("Splash_Homer.rgb") while the pack files are lowercase;
            // index both spellings.
            Assets.byOrigin[e.origin] = e.path;
            Assets.byOrigin[e.origin.toLowerCase()] = e.path;
        }
    }

    // Paths needed before the first scene can draw.
    var CRITICAL = [
        'images/splashscreen.png',
        'images/splash_homer.png',
        'images/splashfinger.png',
        'images/signature.png',
        'images/loading_donut.png'
    ];

    Assets.criticalPaths = function () {
        var list = CRITICAL.slice();
        var logo = Assets.logoPath(global.I18n ? I18n.current : 'en');
        if (logo) { list.push(logo); }
        return list;
    };

    // splashscreen.xml <Language> names files like lang_french.rgb; our assets
    // are the same images re-encoded as lang_<code>.png — resolve via manifest.
    Assets.logoPath = function (lang) {
        // lang file basenames used by the XML, per language code
        var base = {
            en: 'lang_en', fr: 'lang_french', it: 'lang_italian',
            de: 'lang_german', es: 'lang_spanish', zh: 'lang_ch',
            kr: 'lang_ko', pt: 'lang_brazilian', ru: 'lang_russian',
            da: 'lang_danish', nl: 'lang_dutch', no: 'lang_norwegian',
            sv: 'lang_swedish', tc: 'lang_traditionalchinese',
            th: 'lang_thai', tr: 'lang_turkish'
        }[lang];
        if (!base) { return null; }
        var p = Assets.byOrigin[base + '.rgb'];
        return p || null;
    };

    Assets.load = function (path, onDone) {
        if (Assets.images[path]) { onDone(Assets.images[path]); return; }
        var img = new Image();
        img.onload = function () {
            Assets.images[path] = img;
            Assets.loadedCount++;
            onDone(img);
        };
        img.onerror = function () {
            Assets.errors.push(path);
            onDone(null);
        };
        img.src = 'assets/' + path;
        return img;
    };

    // Load every manifest image not yet loaded; onProgress(done, total).
    Assets.loadRemaining = function (onProgress, onDone) {
        var pending = [];
        var p;
        for (p in Assets.byPath) {
            if (Assets.byPath[p].type === 'image' && !Assets.images[p]) {
                pending.push(p);
            }
        }
        var total = pending.length;
        if (total === 0) { onProgress(0, 0); onDone(); return; }
        var done = 0;
        var finish = function (img) {
            done++;
            onProgress(done, total);
            if (done === total) { onDone(); }
        };
        for (i = 0; i < pending.length; i++) {
            Assets.load(pending[i], finish);
        }
    };

    Assets.get = function (path) { return Assets.images[path] || null; };

    global.Assets = Assets;
})(window);
