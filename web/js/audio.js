/* audio.js — small mixer: short SFX from pre-decoded Web Audio buffers, music
 * over HTMLAudioElement. Falls back to HTMLAudioElement for everything when
 * Web Audio or http is unavailable (the page must keep working from file://).
 * All audio files come from the APK, playable copies are AAC .m4a written by
 * tools/convert_audio_pcm.py (see notes/01-binary-formats.md, 'Audio').
 */
(function (global) {
    'use strict';

    var BASE = 'assets/audio/';
    var EXT = '.m4a';

    /* Call sites name a sound ('01_general_button.wav' or the bare stem); the
       corpus decides the extension, so normalise here rather than at the 12
       places that play a sound. */
    function fileUrl(name) {
        return BASE + String(name).replace(/\.(wav|m4a|mp3|ogg)$/i, '') + EXT;
    }

    /* play() rejects for two very different reasons and the old code called
       both of them "autoplay blocked". NotSupportedError means the browser
       cannot decode the file (every IMA ADPCM WAV the pipeline emits until
       tools/convert_audio_pcm.py runs — see notes/01-binary-formats.md);
       NotAllowedError is the actual autoplay policy. Gameplay stays silent
       either way, but say the truth once per file so a codec regression is
       visible in the console instead of sounding like silence. */
    var warned = {};
    function reportPlayFailure(name, err) {
        var why = (err && err.name) || (err && err.message) || 'play failed';
        if (why === 'AbortError') { return; }      // play() superseded: normal
        var key = name + ':' + why;
        if (warned[key]) { return; }
        warned[key] = true;
        if (global.console && global.console.warn) {
            global.console.warn('audio: ' + name + ' would not play (' + why + ')');
        }
    }

    function mediaErrorName(el) {
        var c = el && el.error && el.error.code;
        if (c === 4) { return 'MediaError(4) unsupported or corrupt audio'; }
        return c ? 'MediaError(' + c + ')' : 'play failed';
    }

    /* ------------------------------------------------------------ Web Audio
       A tap sound has to begin on sample 0. An HTMLAudioElement that has not
       buffered the file yet starts whenever its decoder gets round to it, and
       the front of the sound is what goes missing — heard as "the first bit
       is cut off", and hidden by loop, which replays an already-buffered
       file. So the short sounds are fetched once, decoded to an AudioBuffer,
       and replayed from that: sample-exact, and several can overlap. Long
       music tracks stay on <audio>, where buffering is the point. */
    var AC = null, acFailed = false;
    function ctx() {
        if (AC || acFailed) { return AC; }
        var Ctor = global.AudioContext || global.webkitAudioContext;
        if (!Ctor) { acFailed = true; return null; }
        try {
            AC = new Ctor();
        } catch (err) {
            acFailed = true;
            AC = null;
        }
        return AC;
    }

    var buffers = {};                        // url -> {buf} | {err} | pending

    function fetchArrayBuffer(url) {
        if (typeof global.fetch === 'function') {
            return global.fetch(url).then(function (r) {
                if (!r.ok) { throw new Error('HTTP ' + r.status); }
                return r.arrayBuffer();
            });
        }
        return new Promise(function (resolve, reject) {
            var xr = new XMLHttpRequest();
            xr.open('GET', url, true);
            xr.responseType = 'arraybuffer';
            xr.onload = function () {
                if (xr.status === 0 || (xr.status >= 200 && xr.status < 300)) {
                    resolve(xr.response);
                } else {
                    reject(new Error('HTTP ' + xr.status));
                }
            };
            xr.onerror = function () { reject(new Error('network')); };
            xr.send();
        });
    }

    /* Decode once per URL; the record is kept either way so a file that
       cannot be decoded never blocks the element fallback for long. */
    function decode(url) {
        var rec = buffers[url];
        if (rec) { return rec; }
        rec = buffers[url] = {};
        var c = ctx();
        if (!c) {
            rec.err = true;
            rec.ready = Promise.reject(new Error('no Web Audio'));
            return rec;
        }
        rec.ready = fetchArrayBuffer(url).then(function (ab) {
            return new Promise(function (resolve, reject) {
                var done = function (buf) { resolve(buf); };
                // Safari still only knows the two-callback form
                var p = c.decodeAudioData(ab, done, reject);
                if (p && p.then) { p.then(done, reject); }
            });
        }).then(function (buf) {
            if (!buf || !buf.length) { throw new Error('decoded empty'); }
            rec.buf = buf;
            return buf;
        }, function (err) {
            rec.err = true;
            delete buffers[url];
            throw err;
        });
        if (rec.ready.catch) { rec.ready.catch(function () { /* reported */ }); }
        return rec;
    }

    function resumeCtx() {
        var c = ctx();
        if (c && c.state === 'suspended' && c.resume) {
            c.resume().catch(function () { /* the next tap will do it */ });
        }
    }

    function startSource(buf, vol, when, loop, onEnd) {
        var c = ctx();
        if (!c) { return null; }
        var src = c.createBufferSource();
        var gain = c.createGain();
        src.buffer = buf;
        src.loop = !!loop;
        gain.gain.value = vol;
        src.connect(gain);
        gain.connect(c.destination);
        if (onEnd) { src.onended = onEnd; }
        src.start(when || 0);
        return src;
    }

    /* The player the Asset Explorer's detail pane drives. One interface, two
       engines: a decoded AudioBuffer when Web Audio works (starts on sample 0
       and can overlap), an HTMLAudioElement when it does not (file://, a
       browser without AudioContext, or a file that will not decode). */
    function Player(url) {
        this.url = url;
        this.kind = 'buffer';
        this.vol = 1;
        this.rate = 1;              // playbackRate: the ambient sidecar's kit pitch
        this.loop = false;
        this._rec = null;
        this._src = null;
        this._gain = null;
        this._offset = 0;          // position the current play started from
        this._started = 0;         // ctx time of that start
        this._playing = false;
        this._el = null;           // set once the element engine takes over
        this.onState = null;       // called whenever the UI should refresh
    }

    Player.prototype._emit = function (what) {
        if (this.onState) { this.onState(what); }
    };

    /* Fetch + decode, then cb(true) if the buffer engine is live, cb(false)
       if the element engine took over. Either way the player is usable. */
    Player.prototype.prepare = function (cb) {
        var self = this;
        if (!ctx()) { this._useElement(); cb(false); return; }
        var rec = decode(this.url);
        this._rec = rec;
        if (rec.buf) { cb(true); return; }
        if (rec.err) { this._useElement(); cb(false); return; }
        rec.ready.then(function () { cb(true); },
                        function () { self._useElement(); cb(false); });
    };

    Player.prototype._useElement = function () {
        if (this._el) { return; }
        var self = this;
        this.kind = 'element';
        var el = new Audio(this.url);
        this._el = el;
        el.preload = 'auto';
        el.volume = this.vol;
        el.loop = this.loop;
        el.addEventListener('play', function () { self._emit('play'); });
        el.addEventListener('pause', function () { self._emit('pause'); });
        el.addEventListener('ended', function () { self._emit('ended'); });
        el.addEventListener('canplay', function () { self._emit('ready'); });
        el.addEventListener('loadedmetadata', function () { self._emit('ready'); });
        el.addEventListener('progress', function () { self._emit('progress'); });
        el.addEventListener('error', function () { self._emit('error'); });
    };

    Player.prototype.ready = function () {
        return this.kind === 'element' || !!(this._rec && this._rec.buf);
    };

    Player.prototype.dur = function () {
        if (this.kind === 'element') {
            return this._el && isFinite(this._el.duration) ? this._el.duration : NaN;
        }
        return this._rec && this._rec.buf ? this._rec.buf.duration : NaN;
    };

    Player.prototype.pos = function () {
        if (this.kind === 'element') {
            return this._el ? (this._el.currentTime || 0) : 0;
        }
        if (!this._playing) { return this._offset; }
        var c = ctx();
        if (!c) { return this._offset; }
        var t = this._offset + (c.currentTime - this._started);
        var d = this.dur();
        if (this.loop && isFinite(d) && d > 0) { t = t % d; }
        return Math.max(0, t);
    };

    Player.prototype.paused = function () {
        if (this.kind === 'element') { return this._el ? this._el.paused : true; }
        return !this._playing;
    };

    /* How much of the file is available to play right now, in seconds: the
       buffer engine has all of it or none, the element one says via buffered.
       The explorer shows this to tell "skipped" from "still arriving". */
    Player.prototype.bufferedEnd = function () {
        if (this.kind === 'element') {
            var b = this._el && this._el.buffered;
            return (b && b.length) ? b.end(b.length - 1) : 0;
        }
        return this.ready() ? this.dur() : 0;
    };

    Player.prototype.play = function (fromHead) {
        if (this.kind === 'element') { this._playElement(fromHead); return; }
        var self = this;
        var buf = this._rec && this._rec.buf;
        if (!buf) { return; }
        var c = ctx();
        if (!c) { return; }
        resumeCtx();
        this.stopSource();
        if (fromHead) { this._offset = 0; }
        var t = this._offset;
        if (isFinite(buf.duration) && buf.duration > 0 && t >= buf.duration) {
            t = this.loop ? 0 : buf.duration;
        }
        var src = c.createBufferSource();
        var gain = c.createGain();
        src.buffer = buf;
        src.loop = !!this.loop;
        if (this.rate !== 1 && src.playbackRate) src.playbackRate.value = this.rate;
        gain.gain.value = this.vol;
        src.connect(gain);
        gain.connect(c.destination);
        src.onended = function () {
            if (self.loop || src !== self._src) { return; }   // ended naturally
            self._playing = false;
            self._offset = self.dur();
            self._src = null;
            self._emit('ended');
        };
        try {
            src.start(0, t);
        } catch (err) {
            this._emit('error');
            return;
        }
        this._src = src;
        this._gain = gain;
        this._offset = t;
        this._started = c.currentTime;
        this._playing = true;
        this._emit('play');
    };

    /* Same cold-start rule as playSfx: an element that is still fetching
       starts output whenever its decoder gets round to it, which eats the
       attack. Wait for real data, rewind to 0, then go. */
    Player.prototype._playElement = function (fromHead) {
        var self = this;
        var el = this._el;
        if (!el) { return; }
        var go = function () {
            if (fromHead) {
                try { el.currentTime = 0; } catch (err) { /* not seekable */ }
            }
            try { el.playbackRate = Math.min(4, Math.max(0.0625, self.rate || 1)); }
            catch (err) { /* not supported: pitch is a nicety */ }
            var p = el.play();
            if (p && p.catch) { p.catch(function () { /* logged by error */ }); }
        };
        if (el.readyState >= 3) { go(); }
        else { el.addEventListener('canplay', go, { once: true }); }
    };

    Player.prototype.pause = function () {
        if (this.kind === 'element') {
            if (this._el) { this._el.pause(); }
            return;
        }
        if (!this._playing) { return; }
        this._offset = this.pos();
        this._playing = false;
        this.stopSource();
        this._emit('pause');
    };

    Player.prototype.stopSource = function () {
        var src = this._src;
        this._src = null;
        this._gain = null;
        if (!src) { return; }
        src.onended = null;
        try { src.stop(); } catch (err) { /* already done */ }
    };

    Player.prototype.seek = function (t) {
        t = Math.max(0, Number(t) || 0);
        if (this.kind === 'element') {
            if (this._el) {
                try { this._el.currentTime = t; } catch (err) { /* seekable yet */ }
            }
            this._emit('seek');
            return;
        }
        var was = this._playing;
        this.stopSource();
        this._playing = false;
        this._offset = t;
        if (was) { this.play(false); }        // restarts from the new offset
        this._emit('seek');
    };

    Player.prototype.setVolume = function (v) {
        this.vol = Math.min(1, Math.max(0, Number(v)));
        if (this.kind === 'element') {
            if (this._el) { this._el.volume = this.vol; }
        } else if (this._gain) {
            this._gain.gain.value = this.vol;
        }
    };

    Player.prototype.setLoop = function (on) {
        this.loop = !!on;
        if (this.kind === 'element') {
            if (this._el) { this._el.loop = this.loop; }
        } else if (this._src) {
            this._src.loop = this.loop;
        }
    };

    /* Playback rate (the scripts' kit <Pitch value>): applied at the next
       play() and live where the engine supports it. The ambient loops are the
       only caller that uses it; everything else stays at 1. */
    Player.prototype.setRate = function (r) {
        r = Number(r);
        this.rate = (isFinite(r) && r >= 0.0625 && r <= 4) ? r : 1;
        if (this.kind === 'element') {
            if (this._el) { try { this._el.playbackRate = this.rate; } catch (err) { /* ignore */ } }
        } else if (this._src && this._src.playbackRate) {
            this._src.playbackRate.value = this.rate;
        }
    };

    /* MediaError code, when the element engine failed to load: 4 means the
       browser cannot decode the file at all (notes/01-binary-formats.md). */
    Player.prototype.errorCode = function () {
        return this._el && this._el.error ? this._el.error.code : 0;
    };

    Player.prototype.dispose = function () {
        this.stopSource();
        this._playing = false;
        if (this._el) {
            try { this._el.pause(); } catch (err) { /* ignore */ }
            this._el.src = '';
            this._el = null;
        }
    };

    /* The sounds the UI plays without being asked for them: warming these is
       what makes the first tap of a session as exact as the tenth. */
    var UI_SFX = ['01_general_button.wav', '02_close_or_back.wav',
                  '10_next_segment.wav', '17_diag_panel_open.wav',
                  '18_diag_panel_close.wav'];

    var Mixer = {
        muted: false,
        UI_SFX: UI_SFX,
        _music: null,     // { el, name, fade } for the current music track
        _sfxLive: [],     // in-flight SFX elements (so GC doesn't collect them)

        _newAudio: function (name) {
            var el = new Audio(fileUrl(name));
            el.preload = 'auto';
            return el;
        },

        playSfx: function (name, opts) {
            if (this.muted) { return; }
            opts = opts || {};
            var vol = (typeof opts.volume === 'number') ? opts.volume : 0.5;
            var url = fileUrl(name);
            /* Buffer first: if the sound is already decoded (every tap after
               the first, and every tap once preload() has run), this starts on
               the sample and can overlap with itself. */
            var rec = ctx() ? decode(url) : null;
            if (rec && rec.buf) {
                resumeCtx();
                if (startSource(rec.buf, vol, 0, false, null)) { return; }
            }
            if (rec && !rec.err) {
                /* First play of this sound: start it when the decode lands.
                   Late and complete beats immediate with the attack missing. */
                var self = this;
                rec.ready.then(function (buf) {
                    if (self.muted) { return; }
                    resumeCtx();
                    if (!startSource(buf, vol, 0, false, null)) {
                        self._playElement(name, url, vol);
                    }
                }, function () { /* the element path below, next time */ });
                return;
            }
            this._playElement(name, url, vol);
        },

        /* HTMLAudioElement path: the fallback when there is no Web Audio (or
           the file would not decode). Still warms up before starting — see
           the cold-start comment. */
        _playElement: function (name, url, vol) {
            var el = new Audio(url);
            el.preload = 'auto';
            el.volume = vol;
            var self = this;
            var drop = function () {
                var ix = self._sfxLive.indexOf(el);
                if (ix >= 0) { self._sfxLive.splice(ix, 1); }
            };
            el.addEventListener('ended', drop);
            el.addEventListener('error', function () {
                drop();
                reportPlayFailure(name, { name: mediaErrorName(el) });
            });
            this._sfxLive.push(el);
            // keep the live pool small (SFX are short)
            if (this._sfxLive.length > 12) {
                var old = this._sfxLive.shift();
                try { old.pause(); } catch (e) { /* ignore */ }
            }
            /* A brand-new element is still fetching, and play() at readyState
               0 starts output as soon as the first chunk decodes — which is
               how the attack of a tap sound goes missing. Wait for real data,
               put the playhead at 0, then go. */
            var startAtHead = function () {
                try { el.currentTime = 0; } catch (e2) { /* not seekable yet */ }
                var p = el.play();
                if (p && p.catch) {
                    p.catch(function (err) { reportPlayFailure(name, err); });
                }
            };
            if (el.readyState >= 3) { startAtHead(); }
            else { el.addEventListener('canplay', startAtHead, { once: true }); }
        },

        /* Warm the UI sounds into AudioBuffers so the first tap of a session
           is as exact as the tenth. Cheap (a few hundred KB) and silent; call
           it from the first gesture. */
        preload: function (names) {
            if (!ctx()) { return; }
            (names || []).forEach(function (n) { decode(fileUrl(n)); });
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
                    el.play().catch(function (err) { reportPlayFailure(name, err); });
                }
                this._fadeTo(prev, vol, fadeIn);
                return prev;
            }

            el = this._newAudio(name);
            el.loop = !!loop;
            el.volume = 0;
            this._music = { el: el, name: name, vol: vol };
            var start = function () {
                /* same cold-start rule as playSfx: by now the file has data,
                   but nothing has seeked it, so pin the playhead to the top
                   before the fade begins */
                try { el.currentTime = 0; } catch (e2) { /* not seekable yet */ }
                self._fadeTo(self._music, vol, fadeIn);
            };
            if (el.readyState >= 3) { start(); }
            else {
                el.addEventListener('canplay', start, { once: true });
                el.load();
            }
            el.addEventListener('error', function () {
                reportPlayFailure(name, { name: mediaErrorName(el) });
            });
            el.play().catch(function (err) {
                /* Autoplay policy: the browser may defer start until a
                   gesture. The first tap already counts as one; if the
                   track is still silent, retry on the next tap. */
                self._pendingStart = true;
                reportPlayFailure(name, err);
            });
        },

        // Retry a music start blocked by autoplay policies. Call from the
        // first user gesture handler.
        resume: function () {
            resumeCtx();
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

        // A player for one file: pre-decoded Web Audio buffer when that works,
        // an HTMLAudioElement when it does not. cb(true/false) from prepare().
        makePlayer: function (url) {
            try {
                return new Player(url);
            } catch (err) {
                return null;
            }
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
