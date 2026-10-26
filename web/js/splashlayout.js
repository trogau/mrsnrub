/* splashlayout.js — data-driven splash composition.
 *
 * Parses the game's splashscreen.xml (embedded by the extraction pipeline)
 * and reproduces its layout model:
 *   - one <Ruleset> per screen aspect; the closest one wins
 *   - <Background> names a crop window (fractions) into the 4096x1024
 *     splashscreen strip; the RatioAdjustmentPolicy then maps that window
 *     onto the actual viewport:
 *        keep_center/moving_edges=vertical -> when the screen is WIDER than
 *        the window: crop the window's top/bottom, keeping the center
 *        single_edge/edge=right           -> when the screen is NARROWER:
 *        the window's left edge stays put, the right edge is what gets cut
 *   - each <Graphic> is placed with its <Placement> offset (fractions of the
 *     screen, top-left of the graphic's canvas) and scale. "Scale 1" is the
 *     native size of the (medium) pack, i.e. design-space height = 1024.
 */
(function (global) {
    'use strict';

    var DESIGN_H = 1024;

    var SplashLayout = {
        DESIGN_H: DESIGN_H,
        rulesets: [],

        parse: function (xmlText) {
            var doc = new DOMParser().parseFromString(xmlText, 'text/xml');
            var rs = doc.getElementsByTagName('Ruleset');
            this.rulesets = [];
            for (var i = 0; i < rs.length; i++) {
                var r = rs[i];
                var rule = {
                    aw: parseFloat(r.getAttribute('aspect_w')),
                    ah: parseFloat(r.getAttribute('aspect_h'))
                };
                var bg = r.getElementsByTagName('Background')[0];
                if (bg) {
                    rule.bg = {
                        name: bg.getAttribute('name'),
                        cropX: parseFloat(bg.getAttribute('crop_x')),
                        cropY: parseFloat(bg.getAttribute('crop_y')),
                        cropW: parseFloat(bg.getAttribute('crop_w')),
                        cropH: parseFloat(bg.getAttribute('crop_h')),
                        policies: []
                    };
                    var adj = bg.getElementsByTagName('Adjustment');
                    for (var a = 0; a < adj.length; a++) {
                        rule.bg.policies.push({
                            type: adj[a].getAttribute('type'),
                            movingEdges: adj[a].getAttribute('moving_edges'),
                            edge: adj[a].getAttribute('edge')
                        });
                    }
                }
                rule.graphics = [];
                var gs = r.getElementsByTagName('Graphic');
                for (var g = 0; g < gs.length; g++) {
                    var gr = gs[g];
                    var pl = gr.getElementsByTagName('Placement')[0];
                    var langs = null;
                    var langEl = gr.getElementsByTagName('Language')[0];
                    if (langEl) {
                        langs = {};
                        var kids = langEl.children;
                        for (var k = 0; k < kids.length; k++) {
                            langs[kids[k].tagName] = kids[k].getAttribute('name');
                        }
                    }
                    rule.graphics.push({
                        name: gr.getAttribute('name') || null,
                        scale_x: parseFloat(gr.getAttribute('scale_x') || '1'),
                        scale_y: parseFloat(gr.getAttribute('scale_y') || '1'),
                        offX: pl ? parseFloat(pl.getAttribute('offset_x')) : 0,
                        offY: pl ? parseFloat(pl.getAttribute('offset_y')) : 0,
                        languages: langs
                    });
                }
                this.rulesets.push(rule);
            }
            return this.rulesets.length;
        },

        // Closest ruleset for a viewport of the given aspect.
        select: function (W, H) {
            var target = W / H;
            var best = null, bestScore = Infinity;
            for (var i = 0; i < this.rulesets.length; i++) {
                var r = this.rulesets[i];
                var score = Math.abs(r.aw / r.ah - target);
                if (score < bestScore) { bestScore = score; best = r; }
            }
            return best;
        },

        // Compute concrete draw rects for a viewport W x H.
        // bgW/bgH: pixel size of the loaded background strip.
        compute: function (rule, W, H, bgW, bgH, lang) {
            var S = H / DESIGN_H;
            var out = { scale: S, bg: null, graphics: [] };
            var b = rule.bg;
            if (b) {
                var wx0 = b.cropX * bgW;
                var wy0 = b.cropY * bgH;
                var ww = b.cropW * bgW;
                var wh = b.cropH * bgH;
                var winScreenW = ww * S;      // window width if height-fit
                if (winScreenW >= W) {
                    // Screen narrower than the window: full height, the
                    // window's RIGHT edge is cut (single_edge/edge=right);
                    // the left edge stays anchored.
                    out.bg = {
                        sx: wx0, sy: wy0,
                        sw: Math.min(ww, W / S),
                        sh: wh,
                        dx: 0, dy: 0, dw: W, dh: H
                    };
                } else {
                    // Screen wider: fit the window's width, crop the height,
                    // keep the vertical center (keep_center).
                    var scale = W / ww;
                    var sh = H / scale;
                    out.bg = {
                        sx: wx0, sy: wy0 + (wh - sh) / 2,
                        sw: ww, sh: sh,
                        dx: 0, dy: 0, dw: W, dh: H
                    };
                }
            }
            for (var i = 0; i < rule.graphics.length; i++) {
                var g = rule.graphics[i];
                var origin = g.name;
                if (!origin && g.languages) {
                    origin = g.languages[lang] || g.languages.en;
                }
                var path = global.Assets.byOrigin[origin] ||
                           global.Assets.byOrigin[origin.toLowerCase()];
                if (!path) { continue; }
                out.graphics.push({
                    origin: origin,
                    path: path,
                    x: g.offX * W,
                    y: g.offY * H,
                    // size resolved at draw time (image may still be loading)
                    scaleW: S * g.scale_x,
                    scaleH: S * g.scale_y
                });
            }
            return out;
        }
    };

    global.SplashLayout = SplashLayout;
})(window);
