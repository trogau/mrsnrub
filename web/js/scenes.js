/* scenes.js — the four scenes of the port:
 *
 *   splash    the game's launch screen, laid out by splashscreen.xml
 *   loading   donut spinner + real asset-load progress (the game loads its
 *             DLC here; we load the rest of our extracted assets)
 *   city      honest placeholder: the city content is runtime DLC on EA's
 *             servers and is not in the APK, so this is a hub that demos
 *             the extracted material (i18n, popups, screens, audio)
 *   error     the real "technical difficulties" screen (art + strings)
 */
(function (global) {
    'use strict';

    var UI = global.UI;
    var I18n = global.I18n;

    // Shared splash composition ------------------------------------------------
    // fill: sky -> field gradient sampled from the background art so the
    // transparent margins of the strip read as open sky/field (porting
    // decision — the native engine drew over its scene background color).
    var SplashArt = {
        sky: null,      // [r,g,b]
        field: null,

        sampleColors: function (img) {
            try {
                var c = document.createElement('canvas');
                c.width = img.naturalWidth;
                c.height = img.naturalHeight;
                var cx = c.getContext('2d');
                cx.drawImage(img, 0, 0);
                var read = function (x, y) {
                    var p = cx.getImageData(x, y, 1, 1).data;
                    return [p[0], p[1], p[2]];
                };
                this.sky = read(100, 30);
                this.field = read(300, 750);
            } catch (e) {
                this.sky = [0x23, 0xa1, 0xf3];
                this.field = [0x45, 0xa3, 0x4d];
            }
        },

        draw: function (ctx, G, layout, opts) {
            opts = opts || {};
            var dim = opts.dim || 0;
            var t = G.t;
            ctx.save();
            // gradient fill behind the strip
            var bgimg = Assets.get('images/splashscreen.png');
            if ((!this.sky || !this.field) && bgimg) { this.sampleColors(bgimg); }
            if (!this.sky || !this.field) {
                this.sky = [0x23, 0xa1, 0xf3];
                this.field = [0x45, 0xa3, 0x4d];
            }
            var grad = ctx.createLinearGradient(0, 0, 0, G.H);
            grad.addColorStop(0, 'rgb(' + this.sky.join(',') + ')');
            grad.addColorStop(1, 'rgb(' + this.field.join(',') + ')');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, G.W, G.H);
            // background window
            if (layout.bg) {
                var bg = Assets.get('images/splashscreen.png');
                if (bg) {
                    ctx.drawImage(bg,
                        layout.bg.sx, layout.bg.sy, layout.bg.sw, layout.bg.sh,
                        layout.bg.dx, layout.bg.dy, layout.bg.dw, layout.bg.dh);
                }
            }
            // graphics, in XML order (logo last = frontmost)
            for (var i = 0; i < layout.graphics.length; i++) {
                var g = layout.graphics[i];
                var img = Assets.get(g.path);
                if (!img) { continue; }
                var x = g.x, y = g.y;
                if (g.origin === 'SplashFinger.rgb' && !opts.still) {
                    y += Math.sin(t * 2.4) * 6 * layout.scale;   // finger bob
                }
                ctx.drawImage(img, x, y,
                    img.naturalWidth * g.scaleW, img.naturalHeight * g.scaleH);
            }
            if (dim > 0) {
                ctx.fillStyle = 'rgba(6, 8, 14,' + dim + ')';
                ctx.fillRect(0, 0, G.W, G.H);
            }
            ctx.restore();
        }
    };

    var currentLayout = function () {
        var G = global.G;
        var rule = SplashLayout.select(G.W, G.H);
        var bg = Assets.get('images/splashscreen.png');
        return SplashLayout.compute(rule, G.W, G.H,
            bg ? bg.naturalWidth : 4096,
            bg ? bg.naturalHeight : 1024, I18n.current);
    };

    var Scenes = {};

    // ---- Splash --------------------------------------------------------------
    Scenes.splash = {
        name: 'splash',
        enter: function () {},
        update: function (dt) {},
        draw: function (ctx) {
            var G = global.G;
            SplashArt.draw(ctx, G, currentLayout());
            // subtle vignette so the finger reads
            ctx.save();
            var v = ctx.createRadialGradient(G.W / 2, G.H / 2, G.H * 0.55,
                                             G.W / 2, G.H / 2, G.H * 0.95);
            v.addColorStop(0, 'rgba(0,0,0,0)');
            v.addColorStop(1, 'rgba(0,0,0,0.25)');
            ctx.fillStyle = v;
            ctx.fillRect(0, 0, G.W, G.H);
            ctx.restore();
        },
        onTap: function (x, y) {
            global.AudioMixer.resume();
            global.AudioMixer.playSfx('01_general_button.wav');
            global.AudioMixer.playMusic('mainmusic.wav', false, { fadeIn: 1.6 });
            global.G.setScene('loading');
        }
    };

    // ---- Loading ---------------------------------------------------------------
    Scenes.loading = {
        name: 'loading',
        t0: 0,
        progress: 0,
        disp: 0,
        done: false,
        transitioned: false,

        enter: function () {
            this.t0 = global.G.t;
            this.progress = 0;
            this.disp = 0;
            this.done = false;
            this.transitioned = false;
            var self = this;
            global.Assets.loadRemaining(
                function (done, total) {
                    self.progress = total ? done / total : 1;
                },
                function () { self.done = true; }
            );
        },

        update: function (dt) {
            if (this.transitioned) { return; }
            var G = global.G;
            this.disp += (this.progress - this.disp) * Math.min(1, dt * 7);
            // hold the screen briefly so the donut isn't skipped over.
            // update() keeps running during the exit fade (G.scene only
            // switches when the fade ends), so fire the transition exactly
            // once — otherwise the SFX/music would re-trigger every frame.
            if (this.done && this.disp > 0.999 && G.t - this.t0 > 0.9) {
                this.transitioned = true;
                global.AudioMixer.playSfx('10_next_segment.wav');
                global.AudioMixer.playMusic('bgloop.wav', true, { fadeIn: 1.2 });
                G.setScene('city');
            }
        },

        draw: function (ctx) {
            var G = global.G;
            ctx.save();
            ctx.fillStyle = '#0e1420';
            ctx.fillRect(0, 0, G.W, G.H);
            // donut
            var s = Math.max(90, Math.min(170, Math.min(G.W, G.H) * 0.26));
            var cx = G.W / 2, cy = G.H * 0.40;
            var donut = Assets.get('images/loading_donut.png');
            if (donut) {
                ctx.save();
                ctx.translate(cx, cy);
                ctx.rotate(G.t * 1.8);
                ctx.drawImage(donut, -s / 2, -s / 2, s, s);
                ctx.restore();
            }
            // progress bar
            var bw = Math.min(430, G.W * 0.55);
            var bx = (G.W - bw) / 2, by = cy + s / 2 + 44;
            UI.roundRect(ctx, bx, by, bw, 12, 6);
            ctx.fillStyle = 'rgba(0,0,0,0.45)';
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = '#c8a04c';
            ctx.stroke();
            var fw = Math.max(8, (bw - 6) * this.disp);
            if (fw > 1) {
                UI.roundRect(ctx, bx + 3, by + 3, fw, 6, 3);
                ctx.fillStyle = '#f7c948';
                ctx.fill();
            }
            // text
            ctx.textAlign = 'center';
            ctx.textBaseline = 'alphabetic';
            ctx.fillStyle = '#f4d03f';
            ctx.font = 'bold 30px ' + UI.FONT_DISPLAY + ', sans-serif';
            ctx.fillText('Loading Springfield\u2026', cx, by - 26);
            ctx.fillStyle = '#9fb2c8';
            ctx.font = '16px ' + UI.FONT_TEXT + ', sans-serif';
            ctx.fillText(Math.round(this.disp * 100) + ' %', cx, by + 42);
            ctx.restore();
        },
        onTap: function () {}
    };

    // ---- City (placeholder hub) --------------------------------------------------
    // Buttons are created once (with their handlers); their positions are
    // re-derived every frame in draw(), so the panel survives resizes and
    // re-wrapping in other languages.
    Scenes.city = {
        name: 'city',
        buttons: [],
        soundBtn: null,
        assetBtn: null,

        enter: function () {
            var self = this;
            var G = global.G;
            this.buttons = [
                UI.makeButton({
                    label: this.langLabel(),
                    onTap: function () { self.cycleLang(); }
                }),
                UI.makeButton({
                    label: 'About this build', style: 'gray',
                    onTap: function () { self.about(); }
                }),
                UI.makeButton({
                    label: 'Error screen', style: 'gray',
                    onTap: function () { G.setScene('error'); }
                }),
                UI.makeButton({
                    label: 'Restart', style: 'gray',
                    onTap: function () { self.confirmQuit(); }
                })
            ];
            this.soundBtn = UI.makeButton({
                label: this.soundLabel(), fontSize: 18, style: 'gray',
                w: 126, h: 42, x: G.W - 150, y: 16,
                onTap: function () {
                    global.AudioMixer.setMuted(!global.AudioMixer.muted);
                    self.soundBtn.label = self.soundLabel();
                }
            });
            this.assetBtn = UI.makeButton({
                label: 'Asset explorer', fontSize: 18, style: 'yellow',
                w: 150, h: 42, x: G.W - 312, y: 16,
                onTap: function () {
                    global.AudioMixer.playSfx('01_general_button.wav');
                    openInNewTab('assets-explorer.html');
                }
            });
        },

        onResize: function () { this.enter(); },

        langLabel: function () {
            return 'Language: ' + I18n.current.toUpperCase();
        },
        soundLabel: function () {
            return global.AudioMixer.muted ? 'Sound: off' : 'Sound: on';
        },

        cycleLang: function () {
            var list = I18n.languages;
            var ix = list.indexOf(I18n.current);
            var next = list[(ix + 1) % list.length];
            I18n.set(next);
            // pre-warm the localized splash logo for a possible restart
            var logo = global.Assets.logoPath(next);
            if (logo) { global.Assets.load(logo, function () {}); }
            if (this.buttons[0]) { this.buttons[0].label = this.langLabel(); }
        },

        about: function () {
            var m = global.MANIFEST;
            var counts = { image: 0, audio: 0, font: 0, i18n: 0 };
            for (var i = 0; i < m.files.length; i++) {
                counts[m.files[i].type] = (counts[m.files[i].type] || 0) + 1;
            }
            UI.popup.show({
                title: 'About this build',
                body: 'The Simpsons: Tapped Out (EA), Android client ' +
                    m.sourceVersion + ' \u2014 academic front-end port.\n\n' +
                    'Every image, font, sound and string here was extracted ' +
                    'from the game\u2019s own asset packs (' + m.files.length +
                    ' assets: ' + counts.image + ' images, ' + counts.audio +
                    ' sounds, ' + counts.font + ' fonts, ' + counts.i18n +
                    ' string tables in 16 languages).\n\n' +
                    'The live city, buildings and characters are downloaded ' +
                    'as DLC from EA\u2019s servers at runtime and are not part ' +
                    'of the APK, so there is no city to play in this build.',
                width: 560
            });
        },

        confirmQuit: function () {
            UI.popup.show({
                title: I18n.t('gen_confirmquitgameheader_core'),
                body: I18n.t('gen_confirmquitgame_core'),
                buttons: [
                    { label: I18n.t('gen_yes_core'), action: 'yes',
                      onTap: function () { global.G.setScene('splash'); } },
                    { label: I18n.t('gen_no_core'), action: 'no' }
                ]
            });
        },

        update: function (dt) {},

        draw: function (ctx) {
            var G = global.G;
            SplashArt.draw(ctx, G, currentLayout(), { dim: 0.58 });
            // top bar
            ctx.save();
            ctx.fillStyle = 'rgba(10, 8, 4, 0.55)';
            ctx.fillRect(0, 0, G.W, 66);
            ctx.fillStyle = '#f4d03f';
            ctx.font = 'bold 32px ' + UI.FONT_DISPLAY + ', sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText('Springfield', 24, 35);
            var titleW = ctx.measureText('Springfield').width;
            ctx.fillStyle = 'rgba(242, 232, 213, 0.75)';
            ctx.font = '14px ' + UI.FONT_TEXT + ', sans-serif';
            ctx.fillText('v' + global.MANIFEST.sourceVersion + ' \u2014 web port',
                24 + titleW + 14, 35);
            ctx.restore();

            // panel (geometry re-derived each frame so it tracks resizing
            // and re-wrapping when the language changes)
            var pw = Math.min(600, G.W * 0.86);
            var px = (G.W - pw) / 2;
            var body =
                'The live city is downloaded from EA\u2019s servers as DLC \u2014 ' +
                'it is not part of this Android APK, so there is no city to ' +
                'load here. Everything else you can see and hear (splash ' +
                'screen, fonts, music, sound effects, strings in 16 ' +
                'languages) comes straight from the game\u2019s asset packs.';
            ctx.save();
            ctx.font = '16px ' + UI.FONT_TEXT + ', sans-serif';
            var lines = UI.wrap(ctx, body, pw - 72);
            ctx.restore();
            var padX = 36, padTop = 24, padBot = 26;
            var titleH = 46, bodyGap = 26, btnH = 50, gap = 16;
            var bodyH = lines.length * 24;
            var ph = padTop + titleH + bodyGap + bodyH + 24 + 2 * btnH + gap + padBot;
            var py2 = Math.max(84, Math.min(G.H * 0.30, G.H - ph - 30));
            var bw = (pw - padX * 2 - gap) / 2;
            var by1 = py2 + padTop + titleH + bodyGap + bodyH + 24;
            var by2 = by1 + btnH + gap;
            var bx1 = px + padX, bx2 = px + padX + bw + gap;
            var pos = [[bx1, by1], [bx2, by1], [bx1, by2], [bx2, by2]];
            for (var i = 0; i < this.buttons.length && i < pos.length; i++) {
                this.buttons[i].x = pos[i][0];
                this.buttons[i].y = pos[i][1];
                this.buttons[i].w = bw;
                this.buttons[i].h = btnH;
            }
            ctx.save();
            var grad = ctx.createLinearGradient(0, py2, 0, py2 + ph);
            grad.addColorStop(0, 'rgba(74, 52, 24, 0.97)');
            grad.addColorStop(1, 'rgba(36, 23, 8, 0.97)');
            UI.roundRect(ctx, px, py2, pw, ph, 16);
            ctx.fillStyle = grad;
            ctx.shadowColor = 'rgba(0,0,0,0.5)';
            ctx.shadowBlur = 20;
            ctx.fill();
            ctx.shadowColor = 'transparent';
            ctx.lineWidth = 3;
            ctx.strokeStyle = '#c8a04c';
            ctx.stroke();
            ctx.fillStyle = '#f4d03f';
            ctx.font = 'bold 28px ' + UI.FONT_DISPLAY + ', sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'alphabetic';
            ctx.fillText('Welcome to Springfield', px + pw / 2, py2 + titleH);
            ctx.fillStyle = '#f2e8d5';
            ctx.font = '16px ' + UI.FONT_TEXT + ', sans-serif';
            for (var j = 0; j < lines.length; j++) {
                ctx.fillText(lines[j], px + pw / 2,
                    py2 + titleH + bodyGap + j * 24);
            }
            ctx.restore();
            // buttons (hover)
            for (i = 0; i < this.buttons.length; i++) {
                var hov = G.pointerIn && this.buttons[i].hit(G.pointerX, G.pointerY);
                UI.drawButton(ctx, this.buttons[i], !!hov);
            }
            var ahov = G.pointerIn && this.assetBtn.hit(G.pointerX, G.pointerY);
            UI.drawButton(ctx, this.assetBtn, !!ahov);
            var shov = G.pointerIn && this.soundBtn.hit(G.pointerX, G.pointerY);
            UI.drawButton(ctx, this.soundBtn, !!shov);
            // footer
            ctx.save();
            ctx.fillStyle = 'rgba(242, 232, 213, 0.5)';
            ctx.font = '12px ' + UI.FONT_TEXT + ', sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Academic port for study \u2014 The Simpsons: Tapped ' +
                'Out \u00a9 EA. All rights remain with their owners.',
                G.W / 2, G.H - 14);
            ctx.restore();
        },

        onTap: function (x, y) {
            var i;
            for (i = 0; i < this.buttons.length; i++) {
                if (this.buttons[i].hit(x, y)) {
                    global.AudioMixer.playSfx('01_general_button.wav');
                    this.buttons[i].onTap();
                    return;
                }
            }
            if (this.soundBtn && this.soundBtn.hit(x, y)) {
                global.AudioMixer.playSfx('01_general_button.wav');
                this.soundBtn.onTap();
                return;
            }
            if (this.assetBtn && this.assetBtn.hit(x, y)) {
                this.assetBtn.onTap();
                return;
            }
        }
    };

    // Anchor-based navigation: window.open() to a relative URL is blocked
    // for file:// pages in some browsers, but a plain link click is not.
    function openInNewTab(url) {
        var a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.parentNode.removeChild(a);
    }

    // ---- Error (technical difficulties) ----------------------------------------
    // The real in-game screen: technicaldifficulties art (Bart at left,
    // maroon field at right) + the actual btp strings for a failed
    // connection, with a Retry button.
    Scenes.error = {
        name: 'error',
        btn: null,

        enter: function () {
            var G = global.G;
            var bw = 220, bh = 54;
            // message area = right of Bart (x: 0.35W .. W)
            var areaCx = (G.W * 0.35 + G.W) / 2;
            this.btn = UI.makeButton({
                label: I18n.t('gen_retry'),
                x: areaCx - bw / 2, y: G.H * 0.70,
                w: bw, h: bh, fontSize: 24,
                onTap: function () {
                    global.AudioMixer.playSfx('02_close_or_back.wav');
                    G.setScene('city');
                }
            });
        },

        update: function (dt) {},

        draw: function (ctx) {
            var G = global.G;
            var img = Assets.get('images/technicaldifficulties.png');
            ctx.save();
            ctx.fillStyle = '#3a0d0d';
            ctx.fillRect(0, 0, G.W, G.H);
            if (img) {
                // cover fit
                var sc = Math.max(G.W / img.naturalWidth, G.H / img.naturalHeight);
                var dw = img.naturalWidth * sc, dh = img.naturalHeight * sc;
                ctx.drawImage(img, (G.W - dw) / 2, (G.H - dh) / 2, dw, dh);
            }
            // message area: right of Bart (~35% of the width)
            var cx = (G.W * 0.35 + G.W) / 2;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'alphabetic';
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 34px ' + UI.FONT_DISPLAY + ', sans-serif';
            ctx.shadowColor = 'rgba(0,0,0,0.6)';
            ctx.shadowBlur = 6;
            ctx.shadowOffsetY = 2;
            ctx.fillText(I18n.t('err_cannotconnect_name'), cx, G.H * 0.40);
            ctx.shadowColor = 'transparent';
            ctx.fillStyle = '#f2d9c8';
            ctx.font = '19px ' + UI.FONT_TEXT + ', sans-serif';
            var lines = UI.wrap(ctx, I18n.t('err_cannotconnect_body'), G.W * 0.52);
            for (var i = 0; i < lines.length; i++) {
                ctx.fillText(lines[i], cx, G.H * 0.40 + 38 + i * 26);
            }
            var hov = G.pointerIn && this.btn.hit(G.pointerX, G.pointerY);
            UI.drawButton(ctx, this.btn, !!hov);
            ctx.restore();
        },

        onTap: function (x, y) {
            if (this.btn && this.btn.hit(x, y)) {
                this.btn.onTap();
            }
        },

        onResize: function () { this.enter(); }
    };

    global.Scenes = Scenes;
    // The splash compositor is shared with the asset explorer's Motion tab
    // (live preview of the game's launch screen).
    global.SplashArt = SplashArt;
})(window);
