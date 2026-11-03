// Data-integrity test for the asset explorer (and the extraction pipeline
// that feeds it). Headless Node — no browser:
//
//   node tools/smoke-explorer.cjs
//
// Asserts that web/assets is complete and self-consistent: every manifest
// path exists on disk, thumbnails exist for the big images, the origin
// index resolves to the game's resolution class (so the game's
// splashscreen.xml lookups are unaffected by the extra variants), variant
// families are complete, and webdata.js embeds the text of every data file.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || path.join(__dirname, '..', 'web');
const A = path.join(ROOT, 'assets');

global.window = global;
require(path.join(A, 'manifest.js'));
require(path.join(A, 'data', 'webdata.js'));
const M = window.MANIFEST;
const D = window.WEBDATA;
const F = M.files;

let failures = 0;
function check(label, cond, extra) {
    if (cond) { console.log('  ok  ' + label); }
    else { failures++; console.log('  FAIL ' + label + (extra ? ' — ' + extra : '')); }
}

console.log('manifest inventory:');
const byPath = {};
F.forEach((e) => { byPath[e.path] = e; });
check('files listed', F.length >= 200, F.length);
check('every manifest path exists on disk',
      F.every((e) => fs.existsSync(path.join(A, e.path))),
      F.filter((e) => !fs.existsSync(path.join(A, e.path))).map((e) => e.path).join(','));
const counts = {};
F.forEach((e) => { counts[e.type] = (counts[e.type] || 0) + 1; });
console.log('      types:', JSON.stringify(counts));

console.log('images:');
const imgs = F.filter((e) => e.type === 'image');
check('all images have dimensions',
      imgs.every((e) => Number.isInteger(e.w) && Number.isInteger(e.h)));
// .rgb-derived images (game packs, up to 4096 px) get pipeline thumbnails;
// small Android pass-through PNGs (<=432 px) don't need them.
const big = imgs.filter((e) => e.source.startsWith('core/') &&
                               Math.max(e.w, e.h) > 256);
check('every game image >256px has a thumbnail',
      big.every((e) => e.thumb && fs.existsSync(path.join(A, e.thumb))),
      big.filter((e) => !e.thumb).map((e) => e.path).join(','));

// origin index must behave like assets.js (last writer wins) and must
// resolve to the GAME class so splashscreen.xml lookups are unaffected.
// Only APK entries participate: DLC origins are per-pack file names that
// legitimately repeat across tiers, revisions and event packs.
const byOrigin = {};
F.forEach((e) => { if (e.origin && !e.dlc) { byOrigin[e.origin] = e.path; } });
check('splashscreen.rgb -> medium strip',
      byOrigin['splashscreen.rgb'] === 'images/splashscreen.png', byOrigin['splashscreen.rgb']);
check('lang_en.rgb -> medium logo',
      byOrigin['lang_en.rgb'] === 'images/lang_en.png', byOrigin['lang_en.rgb']);
check('loading_donut.rgb -> large donut',
      byOrigin['loading_donut.rgb'] === 'images/loading_donut.png', byOrigin['loading_donut.rgb']);
check('no duplicate APK origins pointing at different paths',
      (() => {
          const seen = {};
          return F.filter((e) => !e.dlc).every((e) => {
              if (!e.origin) { return true; }
              if (seen[e.origin] && seen[e.origin].path !== e.path) {
                  // grouped variants (same family, different resolution /
                  // device classes) legitimately share the origin name
                  if (e.family && e.family === seen[e.origin].family) {
                      return true;
                  }
                  return false;
              }
              seen[e.origin] = e;
              return true;
          });
      })(),
      JSON.stringify(F.filter((e) => e.origin).map((e) => [e.origin, e.path])));
check('origin-less variants exist (family without origin)',
      F.some((e) => e.family && !e.origin && e.resClass === 'small'));

console.log('variant families:');
function fam(name) {
    return F.filter((e) => e.family === name).map((e) => e.resClass).sort();
}
check('splashscreen in small/medium/large',
      JSON.stringify(fam('splashscreen')) === JSON.stringify(['large', 'medium', 'small']));
check('lang_en in small/medium/large',
      JSON.stringify(fam('lang_en')) === JSON.stringify(['large', 'medium', 'small']));
check('lang logos: 16 families x 3 classes',
      F.filter((e) => e.family && e.family.startsWith('lang_')).length === 48,
      F.filter((e) => e.family && e.family.startsWith('lang_')).length);
check('loading_donut in 4 core classes',
      JSON.stringify(fam('loading_donut')) ===
      JSON.stringify(['large', 'medium', 'medium-small', 'small']));
check('ic_launcher in 5 densities',
      JSON.stringify(fam('ic_launcher')) ===
      JSON.stringify(['hdpi', 'mdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']));
check('game-class entries keep origin',
      byPath['images/splashscreen.png'].origin === 'splashscreen.rgb' &&
      !byPath['images/splashscreen_large.png'].origin);
check('anchors decoded (splashscreen medium 2056,841)',
      JSON.stringify(byPath['images/splashscreen.png'].anchor) === '[2056,841]',
      JSON.stringify(byPath['images/splashscreen.png'].anchor));

console.log('audio / fonts / i18n:');
const aud = F.filter((e) => e.type === 'audio');
check('62 APK audio files',
      aud.filter((e) => e.path.startsWith('audio/')).length === 62,
      aud.filter((e) => e.path.startsWith('audio/')).length);
check('3 music tracks', aud.filter((e) => e.kind === 'music' &&
      !e.path.startsWith('dlc/')).length === 3);   // DLC packs add more
check('all APK audio have kind + duration',
      aud.filter((e) => !e.dlc).every((e) => e.kind && e.duration_s != null));
// Browsers decode PCM/IEEE-float WAV and AAC in an MP4 container, and nothing
// else — a fmt-tag-17 (IMA ADPCM) file is silent whatever the play() handler
// reports. That is the check that would have caught "no sound everywhere" plus
// the explorer's misleading "(autoplay blocked)". tools/convert_audio_pcm.py
// re-encodes the corpus to AAC .m4a (25-30 % of the WAV, a quarter of the
// bytes to fetch before a cold play can start), so both shapes are accepted
// here: whatever the corpus is in, everything on disk must be playable.
function fmtTag(rel) {
    const fd = fs.openSync(path.join(A, rel), 'r');
    try {
        const b = Buffer.alloc(8192);
        fs.readSync(fd, b, 0, 8192, 0);
        if (b.toString('latin1', 0, 4) !== 'RIFF' ||
            b.toString('latin1', 8, 12) !== 'WAVE') { return -1; }
        let off = 12, tag = -1;
        while (off + 8 <= b.length) {
            const size = b.readUInt32LE(off + 4);
            if (b.toString('latin1', off, off + 4) === 'fmt ' &&
                off + 24 <= b.length) { tag = b.readUInt16LE(off + 8); }
            off += 8 + size + (size & 1);
        }
        return tag;
    } finally { fs.closeSync(fd); }
}
function pcmSeconds(rel) {
    const fd = fs.openSync(path.join(A, rel), 'r');
    try {
        const b = Buffer.alloc(8192);
        fs.readSync(fd, b, 0, 8192, 0);
        let off = 12, ch = 0, rate = 0, bits = 0, data = 0;
        while (off + 8 <= b.length) {
            const size = b.readUInt32LE(off + 4);
            const cid = b.toString('latin1', off, off + 4);
            if (cid === 'fmt ') {
                ch = b.readUInt16LE(off + 10); rate = b.readUInt32LE(off + 12);
                bits = b.readUInt16LE(off + 22);
            } else if (cid === 'data') { data = size; }
            off += 8 + size + (size & 1);
        }
        if (!rate || !ch || !bits || !data) { return null; }
        return data / (ch * (bits / 8)) / rate;
    } finally { fs.closeSync(fd); }
}
/* MP4: brand, whether the index (moov) precedes the audio (mdat) — a file
   whose moov is last cannot start playing until it has fully arrived, which
   is why the converter insists on -movflags +faststart — and the track
   duration from mdhd, which is what the browser will report. */
function mp4Info(rel) {
    const fd = fs.openSync(path.join(A, rel), 'r');
    try {
        const size = Math.min(fs.fstatSync(fd).size, 1 << 20);
        const b = Buffer.alloc(size);
        fs.readSync(fd, b, 0, size, 0);
        const out = {
            ftyp: b.toString('latin1', 4, 8),
            brand: b.toString('latin1', 8, 12),
            moov: b.indexOf('moov'), mdat: b.indexOf('mdat'), seconds: null,
        };
        const i = b.indexOf('mdhd');
        if (i > 0) {
            const ver = b[i + 4];
            if (ver === 0 && i + 24 <= b.length) {
                const ts = b.readUInt32BE(i + 16), dur = b.readUInt32BE(i + 20);
                if (ts) { out.seconds = dur / ts; }
            } else if (ver === 1 && i + 36 <= b.length) {
                const ts = b.readUInt32BE(i + 24);
                const dur = Number(b.readBigUInt64BE(i + 28));
                if (ts) { out.seconds = dur / ts; }
            }
        }
        return out;
    } finally { fs.closeSync(fd); }
}
const BRANDS = ['M4A ', 'mp42', 'isom', 'iso2', 'iso5', 'avc1'];
const notPlayable = [], notStreamable = [], mislabeled = [], staleDur = [];
const missingFile = [];
aud.forEach((e) => {
    if (!fs.existsSync(path.join(A, e.path))) { missingFile.push(e.path); return; }
    let seconds = null;
    if (/\.m4a$/i.test(e.path)) {
        const m = mp4Info(e.path);
        if (m.ftyp !== 'ftyp') { notPlayable.push(e.path + ' no ftyp'); return; }
        if (BRANDS.indexOf(m.brand) < 0) {
            notPlayable.push(e.path + ' brand=' + m.brand); return;
        }
        if (m.moov < 0 || (m.mdat >= 0 && m.moov > m.mdat)) {
            notStreamable.push(e.path + ' moov=' + m.moov + ' mdat=' + m.mdat);
        }
        if (e.codec !== 'aac') { mislabeled.push(e.path + ' codec=' + e.codec); }
        seconds = m.seconds;
    } else if (/\.wav$/i.test(e.path)) {
        const tag = fmtTag(e.path);
        if (tag !== 1 && tag !== 3) {
            notPlayable.push(e.path + ' fmt=' + tag); return;
        }
        if (e.codec !== 'pcm' && e.codec !== 'float') {
            mislabeled.push(e.path + ' codec=' + e.codec);
        }
        seconds = pcmSeconds(e.path);
    } else {
        notPlayable.push(e.path + ' (unknown audio extension)'); return;
    }
    if (!e.codec) { mislabeled.push(e.path + ' (no codec)'); }
    if (seconds !== null &&
            Math.abs(Math.round(seconds * 10) / 10 - (e.duration_s || 0)) > 0.15) {
        staleDur.push(e.path + '=' + e.duration_s + 's vs ' +
                      (Math.round(seconds * 10) / 10) + 's');
    }
});
check('every audio file exists where the manifest says',
      missingFile.length === 0,
      missingFile.length + ': ' + missingFile.slice(0, 5).join(', '));
check('every audio file is browser-playable (AAC .m4a or PCM WAV)',
      notPlayable.length === 0,
      notPlayable.length + ': ' + notPlayable.slice(0, 5).join(', '));
check('every .m4a keeps its moov before mdat (streams from the front)',
      notStreamable.length === 0,
      notStreamable.length + ': ' + notStreamable.slice(0, 5).join(', '));
check('manifest codec matches the container',
      mislabeled.length === 0,
      mislabeled.length + ': ' + mislabeled.slice(0, 5).join(', '));
check('duration_s matches the container (fact chunk is unreliable)',
      staleDur.length === 0,
      staleDur.length + ': ' + staleDur.slice(0, 5).join(', '));
check('4 fonts', F.filter((e) => e.type === 'font' &&
      !e.path.startsWith('dlc/')).length === 4);    // DLC adds font packs
const i18n = F.filter((e) => e.type === 'i18n');
check('16 string tables', i18n.length === 16, i18n.length);
check('each table has 90 strings', i18n.every((e) => e.strings === 90));
check('webdata.i18n matches manifest languages',
      JSON.stringify(D.languages) === JSON.stringify(i18n.map((e) =>
          e.path.split('/').pop().slice(0, -5)).sort()));
check('webdata.i18n has all keys for en',
      Object.keys(D.i18n.en || {}).length === 90);

console.log('dlc (fan CDN packs):');
const dlc = F.filter((e) => e.path.startsWith('dlc/'));
if (M.dlc && M.dlc.length) {
    check('manifest dlc list matches entries',
          dlc.length > 0 && M.dlc.every((d) => d.pack && d.url),
          JSON.stringify(M.dlc));
    check('every dlc entry is tagged with pack metadata',
          dlc.every((e) => e.dlc && e.dlc.pack && e.dlc.url &&
                           e.source === e.dlc.url),
          dlc.filter((e) => !e.dlc).map((e) => e.path).join(','));
    check('dlc entries keep the pack source visible (source url)',
          // fan-CDN packs: url is the pack zip itself; archive.org packs
          // come out of a .7z bundle whose url names the bundle, not the pack
          dlc.every((e) => e.source.endsWith('.7z') ||
                           e.source.includes(e.dlc.pack + '.zip')));
    check('every dlc thumb (if any) exists on disk',
          dlc.every((e) => !e.thumb || fs.existsSync(path.join(A, e.thumb))));
} else {
    console.log('      (none decoded yet — pass --dlc to the pipeline)');
}

console.log('video (movie packs):');
const vids = F.filter((e) => e.type === 'video');
if (vids.length) {
    check('every video has w/h/duration/codecs',
          vids.every((e) => e.w != null && e.h != null &&
                            e.duration_s != null && e.vcodec && e.acodec),
          vids.filter((e) => !e.vcodec).map((e) => e.path).join(','));
    check('every video thumb (if any) exists on disk',
          vids.every((e) => !e.thumb || fs.existsSync(path.join(A, e.thumb))));
    check('videos are not embedded in dataText',
          vids.every((e) => D.dataText[e.path] === undefined));
    const fams = {};
    vids.forEach((e) => { fams[e.family] = (fams[e.family] || 0) + 1; });
    // Full-archive movie shape: base movies ship 4 device tiers
    // (ipad/ipad3/iphone/retina); language-dubbed packs carry trailing
    // -lang (sometimes after the device), event cutscene packs can ship
    // several mp4s per pack or none at all (tier-less single packs). The
    // structural invariant that DOES hold: if any variant of a base is
    // device-classed, all 4 device tiers exist for that base.
    const DEVS = ['ipad', 'ipad3', 'iphone', 'retina'];
    const baseDevs = {};
    Object.keys(fams).forEach((f) => {
        let base = f, dev = null;
        for (;;) {
            const mt = base.match(
                /-(ipad3|ipad|iphone|retina|de|es|fr|it|ko|zh|en)$/);
            if (!mt) break;
            if (!dev && DEVS.indexOf(mt[1]) >= 0) dev = mt[1];
            base = base.slice(0, -(mt[1].length + 1));
        }
        (baseDevs[base] = baseDevs[base] || {})[dev || ''] = 1;
    });
    const missing = Object.keys(baseDevs).filter((b) => {
        const s = baseDevs[b];
        const hasDev = DEVS.some((d) => s[d]);
        return hasDev && !DEVS.every((d) => s[d]);
    });
    check('device-classed movie families ship all 4 device variants ' +
          '(' + Object.keys(fams).length + ' families, ' +
          Object.keys(baseDevs).length + ' movies)',
          missing.length === 0, missing.slice(0, 12).join(','));
} else {
    console.log('      (no movies decoded yet)');
}

console.log('anim (character animations):');
const anims = F.filter((e) => e.type === 'anim');
if (anims.length) {
    check('every anim has char/animation/cells/frames',
          anims.every((e) => e.char && e.animation && e.n_cells >= e.n_frames &&
                             Array.isArray(e.frames) &&
                             e.frames.length === e.n_cells),
          anims.filter((e) => !e.frames || e.frames.length !== e.n_cells)
              .map((e) => e.path).join(','));
    check('every anim frame file exists on disk',
          anims.every((e) => e.frames.every((fr) =>
              fs.existsSync(path.join(A, e.path.replace(/[^/]*$/, ''), fr.f)))),
          anims.filter((e) => !e.frames.every((fr) =>
              fs.existsSync(path.join(A, e.path.replace(/[^/]*$/, ''), fr.f))))
              .map((e) => e.path).slice(0, 3).join(','));
    check('anim delays are sane (1..10000 ms)',   // upper bound widened for
          anims.every((e) => e.frames.every((fr) =>
              fr.delay >= 1 && fr.delay <= 10000)));  // full-archive idle
                                                     // pauses (Shadows event
                                                     // loops idle ~5.8 s)
    check('anims are not embedded in dataText',
          anims.every((e) => D.dataText[e.path] === undefined));
    const chars = new Set(anims.map((e) => e.char));
    console.log('      ' + anims.length + ' animations, ' +
                chars.size + ' characters');
} else {
    console.log('      (no character animations decoded yet)');
}

console.log('embedded data text:');
const dataEntries = F.filter((e) => e.type === 'text' || e.type === 'data');
const embeddable = dataEntries.filter((e) => !e.textOmitted);
check('dataText covers every non-omitted data file',
      embeddable.every((e) => typeof D.dataText[e.path] === 'string' &&
                               D.dataText[e.path].length > 0),
      embeddable.filter((e) => typeof D.dataText[e.path] !== 'string')
          .map((e) => e.path).join(','));
check('textOmitted entries are not embedded',
      dataEntries.every((e) => !e.textOmitted ||
                               D.dataText[e.path] === undefined));
check('textOmitted entries exist on disk',
      dataEntries.every((e) => !e.textOmitted || fs.existsSync(
          path.join(A, e.path))));
check('shaders embedded', ['2DShader.fsh', '2DShader.vsh', 'UberShader.fsh',
                           'UberShader.vsh'].every((n) => D.dataText['data/' + n]));
check('support.html embedded', !!D.dataText['data/support.html']);

console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
