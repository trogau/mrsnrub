/* boot.js — canvas setup, main loop, scene switching, input routing,
 * and the startup sequence:
 *
 *   1. parse splashscreen.xml (embedded data)
 *   2. load the critical splash images + fonts
 *   3. show the splash scene
 *
 * The rest of the assets load during the loading scene, exactly like the
 * game loads its content after the splash.
 */
(function (global) {
    'use strict';

    var canvas = document.getElementById('game');
    var ctx = canvas.getContext('2d');

    var G = global.G = {
        canvas: canvas,
        ctx: ctx,
        W: 0, H: 0, DPR: 1,
        t: 0,
        scene: null,
        fade: null,            // {from, to, t} during a scene transition
        pointerIn: false,
        pointerX: 0, pointerY: 0
    };

    // ---- resize -------------------------------------------------------------
    function resize() {
        G.DPR = Math.min(window.devicePixelRatio || 1, 2);
        G.W = window.innerWidth;
        G.H = window.innerHeight;
        canvas.width = Math.round(G.W * G.DPR);
        canvas.height = Math.round(G.H * G.DPR);
        ctx.setTransform(G.DPR, 0, 0, G.DPR, 0, 0);
        if (G.scene && G.scene.onResize) { G.scene.onResize(); }
    }
    window.addEventListener('resize', resize);
    resize();

    // ---- scene manager (fade between scenes) --------------------------------
    // While a fade is running, G.scene still points at the outgoing scene;
    // the FADE TARGET is the scene that logically owns the transition. Using
    // it as the "current" scene here is what stops a scene whose update()
    // keeps requesting the same transition from resetting the fade every
    // frame (which would loop forever and spam SFX/audio requests).
    G.setScene = function (name) {
        var to = global.Scenes[name];
        if (!to) { return; }
        var from = G.fade ? G.fade.to : G.scene;
        if (!from) {
            to.enter();
            G.scene = to;
            return;
        }
        if (to === from) { return; }
        if (from.leave) { from.leave(); }
        to.enter();
        G.fade = { from: from, to: to, t: 0 };
    };

    function updateFade(dt) {
        if (!G.fade) { return; }
        G.fade.t += dt / 0.45;
        if (G.fade.t >= 1) {
            G.scene = G.fade.to;
            G.fade = null;
        }
    }

    // ---- main loop ------------------------------------------------------------
    var last = performance.now();
    function frame(now) {
        var dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        G.t += dt;

        if (G.scene) { G.scene.update(dt); }
        updateFade(dt);

        ctx.clearRect(0, 0, G.W, G.H);
        if (G.scene) { G.scene.draw(ctx); }
        if (G.fade && G.fade.t < 1) {
            ctx.save();
            ctx.globalAlpha = Math.min(1, G.fade.t);
            G.fade.to.draw(ctx);
            ctx.restore();
        }
        global.UI.popup.draw(ctx, G);

        requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    // ---- input -----------------------------------------------------------------
    function pointFromEvent(e) {
        var r = canvas.getBoundingClientRect();
        var p = (e.touches && e.touches[0]) || e;
        return [p.clientX - r.left, p.clientY - r.top];
    }

    function onTap(x, y) {
        global.AudioMixer.resume();   // unblock music on first gesture
        if (global.UI.popup.onTap(x, y)) { return; }
        var s = (G.fade && G.fade.t > 0.5) ? G.fade.to : G.scene;
        if (s && s.onTap) { s.onTap(x, y); }
    }

    canvas.addEventListener('mousedown', function (e) {
        var p = pointFromEvent(e);
        onTap(p[0], p[1]);
    });
    canvas.addEventListener('touchstart', function (e) {
        e.preventDefault();
        var p = pointFromEvent(e);
        onTap(p[0], p[1]);
    }, { passive: false });
    canvas.addEventListener('mousemove', function (e) {
        var p = pointFromEvent(e);
        G.pointerX = p[0];
        G.pointerY = p[1];
        G.pointerIn = true;
    });
    canvas.addEventListener('mouseleave', function () {
        G.pointerIn = false;
    });
    // keyboard: space/enter also tap (accessibility)
    window.addEventListener('keydown', function (e) {
        if (e.key === ' ' || e.key === 'Enter') {
            onTap(G.W / 2, G.H / 2);
        } else if (e.key === 'm' || e.key === 'M') {
            global.AudioMixer.setMuted(!global.AudioMixer.muted);
            if (G.scene && G.scene.name === 'city' && G.scene.soundBtn) {
                G.scene.soundBtn.label = G.scene.soundLabel();
            }
        }
    });

    // ---- boot ---------------------------------------------------------------------
    function boot() {
        var bootEl = document.getElementById('boot');
        SplashLayout.parse(global.WEBDATA.splashXml);

        var paths = global.Assets.criticalPaths();
        var pending = paths.length;
        var failed = false;

        function onOne(img) {
            if (!img) { failed = true; }
            pending--;
            if (pending === 0) {
                if (failed) {
                    document.getElementById('bootmsg').textContent =
                        'Some assets failed to load — serve the web/ directory ' +
                        'over HTTP (or fix the asset paths) and reload.';
                    return;
                }
                // let the display font be ready for canvas text
                var ready = (document.fonts && document.fonts.load)
                    ? Promise.all([
                        document.fonts.load('bold 32px ComicCrazy'),
                        document.fonts.load('16px HelveticaNeue')
                    ]).catch(function () {})
                    : Promise.resolve();
                ready.then(start);
            }
        }
        for (var i = 0; i < paths.length; i++) {
            global.Assets.load(paths[i], onOne);
        }

        function start() {
            if (bootEl) { bootEl.classList.add('done'); }
            G.setScene('splash');
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})(window);
