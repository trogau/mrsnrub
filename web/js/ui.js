/* ui.js — drawing helpers, buttons and the generic popup.
 *
 * The popup styling follows the game's generic dialog look (dark panel,
 * bright border, yellow rounded "OK" buttons, comic display font). The
 * panel itself is drawn with gradients + the corner radius rather than the
 * 12x12 menu-corner PNGs, which are too small to 9-slice usefully at modern
 * resolutions.
 */
(function (global) {
    'use strict';

    var UI = {};

    UI.FONT_DISPLAY = 'ComicCrazy';
    UI.FONT_TEXT = 'HelveticaNeue';

    UI.roundRect = function (ctx, x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    };

    // ---- Buttons -----------------------------------------------------------
    // style: 'yellow' (primary) or 'gray' (secondary)
    UI.makeButton = function (o) {
        return {
            label: o.label,
            x: o.x, y: o.y, w: o.w, h: o.h,
            fontSize: o.fontSize || 22,
            style: o.style || 'yellow',
            onTap: o.onTap,
            hit: function (px, py) {
                return px >= this.x && px <= this.x + this.w &&
                       py >= this.y && py <= this.y + this.h;
            }
        };
    };

    UI.drawButton = function (ctx, b, hovered) {
        var top, bot, border;
        if (b.style === 'yellow') {
            top = hovered ? '#ffe27a' : '#f7c948';
            bot = hovered ? '#f2b52e' : '#d99a17';
            border = '#5c3a00';
        } else {
            top = hovered ? '#9a9a9a' : '#7d7d7d';
            bot = hovered ? '#767676' : '#5c5c5c';
            border = '#221a10';
        }
        var grad = ctx.createLinearGradient(0, b.y, 0, b.y + b.h);
        grad.addColorStop(0, top);
        grad.addColorStop(1, bot);
        ctx.save();
        UI.roundRect(ctx, b.x, b.y, b.w, b.h, Math.min(14, b.h / 3));
        ctx.fillStyle = grad;
        ctx.shadowColor = 'rgba(0,0,0,0.45)';
        ctx.shadowBlur = hovered ? 10 : 5;
        ctx.shadowOffsetY = 2;
        ctx.fill();
        ctx.shadowColor = 'transparent';
        ctx.lineWidth = 2;
        ctx.strokeStyle = border;
        ctx.stroke();
        ctx.fillStyle = (b.style === 'yellow') ? '#241700' : '#ffffff';
        ctx.font = 'bold ' + b.fontSize + 'px ' + UI.FONT_DISPLAY + ', sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + b.fontSize * 0.08);
        ctx.restore();
    };

    // ---- Text --------------------------------------------------------------
    UI.wrap = function (ctx, text, maxW) {
        var words = String(text).split(/\s+/);
        var lines = [];
        var line = '';
        for (var i = 0; i < words.length; i++) {
            var test = line ? line + ' ' + words[i] : words[i];
            if (ctx.measureText(test).width > maxW && line) {
                lines.push(line);
                line = words[i];
            } else {
                line = test;
            }
        }
        if (line) { lines.push(line); }
        return lines;
    };

    // ---- Generic popup ------------------------------------------------------
    // UI.popup.show({
    //   title, body, width,
    //   buttons: [{label, style, action, onTap}],
    //   onClose: function(action) {}   // 'ok' | action string | 'dismiss'
    // })
    // The popup renders above the current scene and consumes taps while open.
    UI.popup = {
        open: null,
        buttons: [],

        show: function (opts) {
            this._clear();
            var G = global.G;
            var ctx = G.ctx;
            var padX = 36, padTop = 26, padBot = 30;
            var btnH = 52, gap = 14;
            var btns = (opts.buttons && opts.buttons.length)
                ? opts.buttons
                : [{ label: global.I18n.t('ui_ok'), action: 'ok' }];

            ctx.save();
            ctx.font = '16px ' + UI.FONT_TEXT + ', sans-serif';
            var bodyLines = this._wrapText(ctx, opts.body || '', 0);
            ctx.font = 'bold 22px ' + UI.FONT_DISPLAY + ', sans-serif';
            var rowW = 0;
            for (var i = 0; i < btns.length; i++) {
                btns[i]._w = Math.max(130, ctx.measureText(btns[i].label).width + 56);
                rowW += btns[i]._w + gap;
            }
            rowW -= gap;
            var w = Math.max(opts.width || 520, rowW + padX * 2,
                             ctx.measureText((opts.body || '').slice(0, 60)).width);
            ctx.restore();
            var bodyW = w - padX * 2;
            ctx.save();
            ctx.font = '16px ' + UI.FONT_TEXT + ', sans-serif';
            bodyLines = this._wrapText(ctx, opts.body || '', bodyW);
            ctx.restore();

            var h = padTop + 46 + 16 + bodyLines.length * 24 + 26 + btnH + padBot;
            var x = (G.W - w) / 2;
            var y = (G.H - h) / 2;

            var self = this;
            this.open = {
                title: opts.title || '',
                body: opts.body || '',
                onClose: opts.onClose || null,
                x: x, y: y, w: w, h: h
            };
            var bx = x + (w - rowW) / 2;
            var by = y + h - padBot - btnH;
            for (i = 0; i < btns.length; i++) {
                var b = btns[i];
                this.buttons.push(UI.makeButton({
                    label: b.label,
                    x: bx, y: by, w: b._w, h: btnH,
                    style: b.style || 'yellow',
                    onTap: (function (btn, action) {
                        return function () {
                            global.AudioMixer.playSfx('01_general_button.wav');
                            if (btn.onTap) { btn.onTap(); }
                            self._close(action || 'ok');
                        };
                    })(b, b.action)
                }));
                bx += b._w + gap;
            }
            global.AudioMixer.playSfx('17_diag_panel_open.wav');
        },

        _close: function (action) {
            var p = this.open;
            if (!p) { return; }
            this._clear();
            global.AudioMixer.playSfx('18_diag_panel_close.wav');
            if (p.onClose) { p.onClose(action); }
        },

        _clear: function () {
            this.open = null;
            this.buttons = [];
        },

        isOpen: function () { return !!this.open; },

        onTap: function (px, py) {
            if (!this.open) { return false; }
            for (var i = 0; i < this.buttons.length; i++) {
                if (this.buttons[i].hit(px, py)) {
                    this.buttons[i].onTap();
                    return true;
                }
            }
            this._close('dismiss');
            return true;
        },

        draw: function (ctx, G) {
            if (!this.open) { return; }
            var p = this.open;
            var self = this;
            ctx.save();
            ctx.fillStyle = 'rgba(8, 6, 2, 0.55)';
            ctx.fillRect(0, 0, G.W, G.H);
            var grad = ctx.createLinearGradient(0, p.y, 0, p.y + p.h);
            grad.addColorStop(0, '#4a3418');
            grad.addColorStop(0.12, '#3a2812');
            grad.addColorStop(1, '#241708');
            UI.roundRect(ctx, p.x, p.y, p.w, p.h, 16);
            ctx.fillStyle = grad;
            ctx.shadowColor = 'rgba(0,0,0,0.6)';
            ctx.shadowBlur = 24;
            ctx.fill();
            ctx.shadowColor = 'transparent';
            ctx.lineWidth = 3;
            ctx.strokeStyle = '#c8a04c';
            ctx.stroke();
            UI.roundRect(ctx, p.x + 5, p.y + 5, p.w - 10, p.h - 10, 11);
            ctx.lineWidth = 1;
            ctx.strokeStyle = 'rgba(255, 226, 140, 0.35)';
            ctx.stroke();
            ctx.fillStyle = '#f4d03f';
            ctx.font = 'bold 28px ' + UI.FONT_DISPLAY + ', sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'alphabetic';
            ctx.fillText(p.title, p.x + p.w / 2, p.y + 52);
            ctx.fillStyle = '#f2e8d5';
            ctx.font = '16px ' + UI.FONT_TEXT + ', sans-serif';
            var lines = this._wrapText(ctx, p.body, p.w - 72);
            var y = p.y + 52 + 28;
            for (var i = 0; i < lines.length; i++) {
                ctx.fillText(lines[i], p.x + p.w / 2, y + i * 24);
            }
            for (i = 0; i < this.buttons.length; i++) {
                var hov = G.pointerIn &&
                    this.buttons[i].hit(G.pointerX, G.pointerY);
                UI.drawButton(ctx, this.buttons[i], !!hov);
            }
            ctx.restore();
        },

        _wrapText: function (ctx, text, maxW) {
            var words = String(text).split(/\s+/);
            var lines = [];
            var line = '';
            for (var i = 0; i < words.length; i++) {
                var test = line ? line + ' ' + words[i] : words[i];
                if (ctx.measureText(test).width > maxW && line) {
                    lines.push(line);
                    line = words[i];
                } else {
                    line = test;
                }
            }
            if (line) { lines.push(line); }
            return lines;
        }
    };

    global.UI = UI;
})(window);
