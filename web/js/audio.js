/* audio.js — small mixer over HTMLAudioElement (works from file://,
 * no WebAudio fetch/CORS needed). All audio files come from the APK.
 */
(function (global) {
    'use strict';

    var BASE = 'assets/audio/';

    var Mixer = {
        muted: false,
        _music: null,     // { el, name, fade } for the current music track
        _sfxLive: [],     // in-flight SFX elements (so GC doesn't collect them)

        _newAudio: function (name) {
            var el = new Audio(BASE + name);
            el.preload = 'auto';
            return el;
        },

        playSfx: function (name, opts) {
            if (this.muted) { return; }
            opts = opts || {};
            var el = this._newAudio(name);
            el.volume = (typeof opts.volume === 'number') ? opts.volume : 0.5;
            var self = this;
            var drop = function () {
                var ix = self._sfxLive.indexOf(el);
                if (ix >= 0) { self._sfxLive.splice(ix, 1); }
            };
            el.addEventListener('ended', drop);
            el.addEventListener('error', drop);
            this._sfxLive.push(el);
            // keep the live pool small (SFX are short)
            if (this._sfxLive.length > 12) {
                var old = this._sfxLive.shift();
                try { old.pause(); } catch (e) { /* ignore */ }
            }
            var p = el.play();
            if (p && p.catch) { p.catch(function () { /* autoplay blocked */ }); }
        },

        // name: file basename (e.g. 'bgloop.wav'); loop: bool
        playMusic: function (name, loop, opts) {
            opts = opts || {};
            var vol = (typeof opts.volume === 'number') ? opts.volume : 0.35;
            var fadeIn = (typeof opts.fadeIn === 'number') ? opts.fadeIn : 1.2;
            var self = this;

            // fade out the previous track
            var prev = this._music;
            if (prev && prev.name !== name) {
                this._fadeTo(prev, 0, 0.6, function () {
                    try { prev.el.pause(); } catch (e) { /* ignore */ }
                });
            }

            var el;
            if (prev && prev.name === name) {
                el = prev.el;                    // same track: just keep looping
                el.loop = !!loop;
                if (el.paused) {
                    el.play().catch(function () { /* autoplay blocked */ });
                }
                this._fadeTo(prev, vol, fadeIn);
                return prev;
            }

            el = this._newAudio(name);
            el.loop = !!loop;
            el.volume = 0;
            this._music = { el: el, name: name, vol: vol };
            var start = function () { self._fadeTo(self._music, vol, fadeIn); };
            if (el.readyState >= 3) { start(); }
            else {
                el.addEventListener('canplay', start, { once: true });
                el.load();
            }
            el.play().catch(function () {
                /* Autoplay policy: the browser may defer start until a
                   gesture. The first tap already counts as one; if the
                   track is still silent, retry on the next tap. */
                self._pendingStart = true;
            });
        },

        // Retry a music start blocked by autoplay policies. Call from the
        // first user gesture handler.
        resume: function () {
            var m = this._music;
            if (m && m.el.paused && !m.el.ended) {
                m.el.play().catch(function () { /* ignore */ });
            }
            this._pendingStart = false;
        },

        stopMusic: function (fadeOut) {
            var m = this._music;
            if (!m) { return; }
            this._fadeTo(m, 0, (typeof fadeOut === 'number') ? fadeOut : 0.5, function () {
                try { m.el.pause(); } catch (e) { /* ignore */ }
            });
        },

        setMuted: function (muted) {
            this.muted = muted;
            var m = this._music;
            if (m) { m.el.muted = muted; }
        },

        _fadeTo: function (track, to, seconds, onDone) {
            var el = track.el;
            var from = el.volume;
            var t0 = null;
            var step = function (ts) {
                if (t0 === null) { t0 = ts; }
                var k = Math.min(1, (ts - t0) / (seconds * 1000));
                el.volume = from + (to - from) * k;
                if (k < 1 && !el.paused) {
                    track._fade = requestAnimationFrame(step);
                } else if (onDone) {
                    onDone();
                }
            };
            if (track._fade) { cancelAnimationFrame(track._fade); }
            if (seconds <= 0) {
                el.volume = to;
                if (onDone) { onDone(); }
                return;
            }
            track._fade = requestAnimationFrame(step);
        }
    };

    global.AudioMixer = Mixer;
})(window);
