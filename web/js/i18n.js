/* i18n.js — localized strings, decoded from the game's .btp packs
 * (all 16 languages, embedded in webdata.js by the extraction pipeline).
 */
(function (global) {
    'use strict';

    var DATA = global.WEBDATA.i18n;

    var I18n = {
        current: 'en',
        languages: global.WEBDATA.languages.slice().sort(),

        t: function (key) {
            var d = DATA[this.current];
            if (d && d[key] != null) { return d[key]; }
            d = DATA.en;
            if (d && d[key] != null) { return d[key]; }
            return key;
        },

        // t with {0}..{n} positional substitution, e.g. gen_serverbusy
        tf: function (key) {
            var s = this.t(key);
            var args = Array.prototype.slice.call(arguments, 1);
            return s.replace(/\{(\d+)\}/g, function (m, i) {
                return (args[i] != null) ? String(args[i]) : m;
            });
        },

        set: function (lang) {
            if (DATA[lang]) { this.current = lang; }
        },

        has: function (lang) { return !!DATA[lang]; }
    };

    global.I18n = I18n;
})(window);
