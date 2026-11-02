#!/usr/bin/env python3
"""Generate a standalone HTML report for one decoded DLC bundle (season).

Reads web/assets/manifest.json, selects every entry whose dlc.season matches,
and writes a self-contained report named <season>.html that inventories all
packs and assets. Images are NOT copied: the report references them in their
usual generated home, web/assets/dlc/<pack>/..., via a relative prefix
(default ../../web/assets/ so the report can live in
notes/dlc-extraction/).

Usage:
    python3 tools/dlc_report.py <season> [--out notes/dlc-extraction]
        [--bundle cdn/<season>.7z]     # hashed + described in the header
        [--zips <dir>]                 # dir of extracted inner zips; used to
                                       # show original zip names + publish dates
        [--prefix ../../web/assets/]   # href prefix for asset references

Example (3_0_0_Thanksgiving):
    7z x -y -o/tmp/opencode/tsto/3_0_0_Thanksgiving cdn/3_0_0_Thanksgiving.7z
    python3 tools/run_dlc_batch.py Springfield-V08.apk \
        /tmp/opencode/tsto/3_0_0_Thanksgiving/3_0_0_Thanksgiving
    python3 tools/dlc_report.py 3_0_0_Thanksgiving \
        --bundle cdn/3_0_0_Thanksgiving.7z \
        --zips /tmp/opencode/tsto/3_0_0_Thanksgiving/3_0_0_Thanksgiving
"""
import argparse
import datetime as dt
import glob
import hashlib
import html
import json
import os
import re
import sys

TIERS = ('100', '50', '25', 'ipad', 'ipad3', 'iphone', 'retina')
ZIP_RE = re.compile(r'^(?P<stem>[\w.-]+?)'
                    r'(?:-r(?P<rev>\d+)(?:-[0-9A-Za-z]+)?)?$')
VSEASON_RE = re.compile(r'-v\d[\w.]*(?=(?:-r\d|$))')
esc = html.escape


def pack_of_zip(base):
    base = VSEASON_RE.sub('', base)  # old-style name: game-100-v3_0_30
    m = ZIP_RE.match(base)
    stem, rev = m.group('stem'), m.group('rev')
    return stem + (f'-r{rev}' if rev else '')


def tier_key(t):
    return TIERS.index(t) if t in TIERS else len(TIERS)


def fmt_bytes(n):
    if n is None:
        return ''
    for unit, div in (('GB', 2**30), ('MB', 2**20), ('KB', 2**10)):
        if n >= div:
            return f'{n / div:.1f} {unit}'
    return f'{n} B'


def run(season, out_dir, bundle, zips, prefix, manifest):
    """Build one <season>.html report; manifest is parsed once by caller."""
    import types
    args = types.SimpleNamespace(season=season, out=out_dir, bundle=bundle,
                                 zips=zips, prefix=prefix)
    entries = [e for e in manifest['files']
               if e.get('dlc') and e['dlc'].get('season') == args.season]
    if not entries:
        return None
    pre = args.prefix if args.prefix.endswith('/') else args.prefix + '/'

    # original zip names + publish epochs from the extracted bundle dir
    zipinfo = {}
    if args.zips:
        for zp in sorted(glob.glob(os.path.join(args.zips, '*.zip'))):
            base = os.path.basename(zp)[:-4]
            epoch = None
            tp = zp + '.time'
            if os.path.isfile(tp):
                try:
                    epoch = int(open(tp).read().strip())
                except ValueError:
                    epoch = None
            zipinfo.setdefault(pack_of_zip(base), (base, epoch))

    # bundle identity
    bundle_html = ''
    if args.bundle and os.path.isfile(args.bundle):
        h = hashlib.sha256()
        with open(args.bundle, 'rb') as f:
            for chunk in iter(lambda: f.read(1 << 20), b''):
                h.update(chunk)
        bundle_html = (
            f'<div class="kv"><b>Bundle</b> <code>{esc(args.bundle)}</code>'
            f' &middot; {fmt_bytes(os.path.getsize(args.bundle))}'
            f' &middot; sha256 <code>{h.hexdigest()[:32]}…</code></div>')

    # group: family -> pack -> entries
    fams = {}
    for e in entries:
        fams.setdefault(e['dlc']['pack'], []).append(e)
    packs = {}
    for pname, es in fams.items():
        packs.setdefault(es[0]['family'] or pname, {})[pname] = es

    def pstats(es):
        return (sum(1 for e in es if e['type'] == 'image'
                    and e.get('kind') != 'character'),
                sum(1 for e in es if e.get('kind') == 'character'),
                sum(1 for e in es if e['type'] in ('data', 'text')),
                sum(1 for e in es if e['type'] == 'video'),
                sum(1 for e in es if e['type'] == 'audio'),
                sum(e.get('bytes') or 0 for e in es))

    out = [f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DLC bundle report — {esc(args.season)}</title>
<style>
:root {{ color-scheme: light dark; }}
body {{ font: 14px/1.45 system-ui, sans-serif; margin: 1.5rem auto;
        max-width: 1280px; padding: 0 1rem; }}
h1 {{ margin-bottom: .2rem; }} h2 {{ margin-top: 2.2rem;
     border-bottom: 2px solid currentColor; padding-bottom: .2rem; }}
h3 {{ margin: 1.4rem .2rem .4rem; }}
.meta code {{ background: rgba(127,127,127,.15); padding: 0 .3em;
     border-radius: 4px; font-size: 12px; }}
.kv {{ margin: .15rem 0; }}
table {{ border-collapse: collapse; width: 100%; }}
th, td {{ text-align: left; padding: .3rem .55rem; vertical-align: top;
     border-bottom: 1px solid rgba(127,127,127,.3); }}
th {{ font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }}
td.num {{ text-align: right; font-variant-numeric: tabular-nums; }}
.badge {{ display: inline-block; background: rgba(127,127,127,.18);
     border-radius: 8px; padding: 0 .5em; font-size: 12px; }}
details.pack {{ margin: .8rem .2rem; border: 1px solid rgba(127,127,127,.35);
     border-radius: 8px; padding: .2rem .6rem; }}
details.pack > summary {{ cursor: pointer; padding: .35rem 0; }}
.grid {{ display: flex; flex-wrap: wrap; gap: .7rem; padding: .3rem 0 .6rem; }}
.card {{ width: 158px; border: 1px solid rgba(127,127,127,.3);
     border-radius: 8px; padding: .35rem; font-size: 12px; }}
.card img, .card .imgbox {{ display: block; max-width: 150px;
     max-height: 110px; margin: 0 auto .3rem; }}
.card .name {{ word-break: break-all; }}
.strip {{ display: flex; flex-wrap: wrap; gap: 2px; margin-top: .3rem; }}
.strip img {{ max-height: 40px; max-width: 40px; }}
.alpha {{ background: repeating-conic-gradient(#9994 0 25%, #fff0 0 50%)
     0 0 / 16px 16px; }}
.dim {{ opacity: .65; font-size: 11.5px; }}
[data-tip] {{ position: relative; }}
[data-tip]:hover::after {{ content: attr(data-tip); position: absolute;
     left: 50%; bottom: 100%; transform: translateX(-50%);
     background: CanvasText; color: Canvas; padding: .25rem .5rem;
     border-radius: 6px; font-size: 12px; white-space: pre; z-index: 9;
     transition: opacity .15s; opacity: .95; pointer-events: none; }}
a {{ color: #1a6fd4; }} @media (prefers-color-scheme: dark) {{
     a {{ color: #6db3ff; }} }}
</style></head><body>
<h1>DLC bundle report — <code>{esc(args.season)}</code></h1>
<div class="meta">
{bundle_html}
<div class="kv"><b>Manifest</b> <a href="{pre}manifest.json">{pre}manifest.json</a>
 &middot; generated {esc(manifest.get('extractedAt', '?'))} by
 <code>tools/run_dlc_batch.py</code> / <code>tools/extract_assets.py</code></div>
<div class="kv"><b>This report</b> <code>tools/dlc_report.py {esc(args.season)}</code>
 &middot; built {dt.datetime.now().strftime('%Y-%m-%d %H:%M')}</div>
<div class="kv">Images are referenced in place from
 <code>{esc(pre)}dlc/&lt;pack&gt;/</code> — nothing is copied here.</div>
</div>"""]

    total = len(entries)
    nimg = sum(1 for e in entries if e['type'] == 'image'
               and e.get('kind') != 'character')
    nanim = sum(1 for e in entries if e.get('kind') == 'character')
    ndata = sum(1 for e in entries if e['type'] in ('data', 'text'))
    nvid = sum(1 for e in entries if e['type'] == 'video')
    naud = sum(1 for e in entries if e['type'] == 'audio')
    nbytes = sum(e.get('bytes') or 0 for e in entries)
    # on huge seasons (e.g. 3_0_30 with ~4k anims) capping the frame
    # strips keeps the HTML openable in a browser
    frame_cap = 12 if nanim > 500 else None
    empties = sorted(k for k in zipinfo if k not in fams)
    # a pack may be missing because an earlier (alphabetically) bundle
    # shipped the same pack/revision and the batch deduped it away
    owners = {}
    for e in manifest['files']:
        d = e.get('dlc')
        if d and d.get('pack') in zipinfo and d.get('season') != args.season:
            owners.setdefault(d['pack'], d['season'])
    out.append(f"""<h2>Summary</h2>
<div class="kv">{len(packs)} families &middot; {len(fams)} packs &middot;
 {total} decoded files ({nimg} images, {nanim} character anims,
 {ndata} data, {nvid} videos, {naud} audio)
 &middot; {fmt_bytes(nbytes)} decoded</div>""")
    if empties:
        parts = []
        for z in empties:
            if z in owners:
                parts.append(f'<code>{esc(z)}.zip</code> '
                             f'<span class="dim">(identical pack shipped '
                             f'earlier under <code>{esc(owners[z])}</code>)'
                             f'</span>')
            else:
                parts.append(f'<code>{esc(z)}.zip</code>')
        out.append(
            f'<div class="kv dim">{len(empties)} pack zips in the bundle '
            f'shipped empty (no files inside), duplicated an earlier '
            f'bundle, or decoded to nothing: ' + ', '.join(parts)
            + '</div>')
    if frame_cap:
        out.append(
            f'<div class="kv dim">Frame strips are capped at the first '
            f'{frame_cap} frames per animation in this report '
            f'({nanim} animations in the season).</div>')

    # family overview table
    out.append('<table><tr><th>Family</th><th>Packs</th><th>Tiers</th>'
               '<th>Revisions</th><th class="num">Img</th><th class="num">Anim</th>'
               '<th class="num">Data</th><th class="num">Vid</th>'
               '<th class="num">Aud</th><th class="num">Bytes</th></tr>')
    for fam in sorted(packs):
        pk = packs[fam]
        all_e = [e for es in pk.values() for e in es]
        ti = sorted({e['dlc']['tier'] for e in all_e if e['dlc']['tier']},
                    key=tier_key)
        rv = sorted({e['dlc']['revision'] for e in all_e
                     if e['dlc']['revision'] is not None})
        i, a, d, v, u, b = pstats(all_e)
        out.append(
            f'<tr><td><a href="#fam-{esc(fam)}"><b>{esc(fam)}</b></a></td>'
            f'<td>{len(pk)}</td><td>{esc(", ".join(ti))}</td>'
            f'<td>{"base" if any(e["dlc"]["revision"] is None for e in all_e) else ""}'
            f'{", ".join(str(r) for r in rv)}</td>'
            f'<td class="num">{i}</td><td class="num">{a}</td>'
            f'<td class="num">{d}</td><td class="num">{v}</td>'
            f'<td class="num">{u}</td><td class="num">{fmt_bytes(b)}</td></tr>')
    out.append('</table>')

    # characters summary
    chars = sorted({(e.get('char'), e.get('animation'))
                    for e in entries if e.get('kind') == 'character'})
    if chars:
        bychar = {}
        for c, a in chars:
            bychar.setdefault(c, []).append(a)
        out.append('<h3>Character animations</h3><table><tr><th>Character</th>'
                   '<th>States (' + str(len(chars)) + ')</th></tr>')
        for c in sorted(bychar):
            out.append(f'<tr><td><b>{esc(c)}</b></td><td>' +
                       ', '.join(f'<code>{esc(a)}</code>'
                                 for a in sorted(bychar[c])) + '</td></tr>')
        out.append('</table>')

    # per-family / per-pack sections
    for fam in sorted(packs):
        out.append(f'<h2 id="fam-{esc(fam)}">{esc(fam)}</h2>')
        pk = packs[fam]
        def sortkey(pn):
            es = pk[pn][0]['dlc']
            return (tier_key(es['tier']), es['revision'] is not None,
                    es['revision'] or 0)
        first = True
        for pn in sorted(pk, key=sortkey):
            es = pk[pn]
            d = es[0]['dlc']
            i, a, n, v, u, b = pstats(es)
            zn, ep = zipinfo.get(pn, (None, None))
            ztxt = (f' &middot; <code>{esc(zn)}.zip</code>' if zn else '')
            etxt = (f' <span class="dim">(published '
                    f'{dt.datetime.fromtimestamp(ep):%Y-%m-%d})</span>'
                    if ep else '')
            iv = d.get('indexVersion')
            openattr = ' open' if first else ''
            first = False
            bits = [f'{i} img', f'{a} anim', f'{n} data']
            if v:
                bits.append(f'{v} video')
            if u:
                bits.append(f'{u} audio')
            out.append(
                f'<details class="pack"{openattr}><summary>'
                f'<b>{esc(pn)}</b> '
                f'<span class="badge">tier {esc(str(d["tier"]))}</span> '
                f'<span class="badge">rev {esc(str(d["revision"]))}</span> '
                f'<span class="badge">index v{esc(str(iv))}</span> '
                f'<span class="dim">{" · ".join(bits)} · '
                f'{fmt_bytes(b)}</span>{ztxt}{etxt}</summary>')

            # images
            imgs = [e for e in es if e['type'] == 'image'
                    and e.get('kind') != 'character']
            if imgs:
                out.append('<h3>Images</h3><div class="grid">')
                for e in sorted(imgs, key=lambda x: x['origin']):
                    src = pre + (e.get('thumb') or e['path'])
                    full = pre + e['path']
                    tip = f"{e['origin']}\n{e['w']}×{e['h']} · {fmt_bytes(e['bytes'])}"
                    if e.get('premul') is not None:
                        tip += f"\npremul {e['premul']}"
                    out.append(
                        f'<div class="card" data-tip="{esc(tip)}">'
                        f'<a href="{esc(full)}">'
                        f'<img class="alpha" loading="lazy" '
                        f'src="{esc(src)}" alt="{esc(e["origin"])}"></a>'
                        f'<div class="name">{esc(e["origin"])}</div>'
                        f'<div class="dim">{e["w"]}×{e["h"]} · '
                        f'{fmt_bytes(e["bytes"])}</div></div>')
                out.append('</div>')

            # character anims
            anims = [e for e in es if e.get('kind') == 'character']
            if anims:
                out.append('<h3>Character animations</h3><div class="grid">')
                for e in sorted(anims, key=lambda x: x['origin']):
                    pdir = os.path.dirname(e['path'])
                    frames = e.get('frames') or []
                    shown = frames[:frame_cap] if frame_cap else frames
                    strip = ''.join(
                        f'<img class="alpha" loading="lazy" '
                        f'src="{esc(pre + pdir + "/" + fr["f"])}" alt="">'
                        for fr in shown)
                    tip = (f"{e['origin']}\n{e['n_cells']} cells · "
                           f"{len(frames)} frames")
                    out.append(
                        f'<div class="card" data-tip="{esc(tip)}">'
                        f'<div class="name"><b>{esc(e["char"])}</b> · '
                        f'{esc(e["animation"])}</div>'
                        f'<img class="alpha" loading="lazy" '
                        f'src="{esc(pre + e["path"])}" alt="">'
                        f'<div class="dim">{e["n_cells"]} cells · '
                        f'{len(frames)} frames'
                        + (f' (first {len(shown)} shown)'
                           if len(shown) < len(frames) else '')
                        + '</div>'
                        f'<details><summary class="dim">frames</summary>'
                        f'<div class="strip">{strip}</div></details></div>')
                out.append('</div>')

            # data files
            # audio (wav entries with codec metadata; mp3/caf ride as data
            # unless decoded as audio)
            auds = [e for e in es if e['type'] == 'audio']
            if auds:
                out.append('<h3>Audio</h3><table><tr><th>File</th>'
                           '<th>Codec</th><th>Format</th><th>Details</th>'
                           '<th class="num">Bytes</th></tr>')
                for e in sorted(auds, key=lambda x: x['origin']):
                    det = ' × '.join(
                        str(x) for x in (e.get('sample_rate'),
                                         e.get('channels')) if x)
                    if e.get('duration_s'):
                        det = (det + ' · ' if det else '') + \
                            f'{e["duration_s"]} s'
                    out.append(
                        f'<tr><td><code>{esc(e["origin"])}</code> '
                        f'<audio controls preload="none" '
                        f'src="{esc(pre + e["path"])}"></audio></td>'
                        f'<td>{esc(str(e.get("codec")))}'
                        f'</td><td>{esc(str(e.get("audio_format")))}</td>'
                        f'<td>{esc(det)}</td>'
                        f'<td class="num">{fmt_bytes(e["bytes"])}</td></tr>')
                out.append('</table>')

            # videos
            vids = [e for e in es if e['type'] == 'video']
            if vids:
                out.append('<h3>Videos</h3><div class="grid">')
                for e in sorted(vids, key=lambda x: x['origin']):
                    tip = (f"{e['origin']}\n{e.get('w')}x{e.get('h')} · "
                           f"{e.get('vcodec')} + {e.get('acodec')} · "
                           f"{e.get('duration_s')} s · "
                           f'{fmt_bytes(e["bytes"])}')
                    out.append(
                        f'<div class="card" data-tip="{esc(tip)}">'
                        f'<video controls preload="none" width="150" '
                        f'src="{esc(pre + e["path"])}"></video>'
                        f'<div class="name">{esc(e["origin"])}</div>'
                        f'<div class="dim">{e.get("w")}x{e.get("h")} · '
                        f'{e.get("duration_s")} s · '
                        f'{fmt_bytes(e["bytes"])}</div></div>')
                out.append('</div>')

            # data files (incl. raw/undecoded payloads)
            data = [e for e in es if e['type'] in ('data', 'text', 'font')]
            if data:
                out.append('<h3>Data files</h3><table><tr><th>File</th>'
                           '<th>Format</th><th class="num">Bytes</th></tr>')
                for e in sorted(data, key=lambda x: x['origin']):
                    ext = e['origin'].rsplit('.', 1)[-1]
                    if e.get('textOmitted'):
                        link = (f'<a href="{esc(pre + e["path"])}">open</a> '
                                '<span class="dim">(binary)</span> ')
                    elif ext in ('xml', 'json', 'txt', 'ttf', 'otf'):
                        link = f'<a href="{esc(pre + e["path"])}">view</a> '
                    else:
                        link = ''
                    out.append(
                        f'<tr><td><code>{esc(e["origin"])}</code> {link}</td>'
                        f'<td>{esc(ext)}</td>'
                        f'<td class="num">{fmt_bytes(e["bytes"])}</td></tr>')
                out.append('</table>')
            out.append('</details>')

    out.append('</body></html>')
    os.makedirs(args.out, exist_ok=True)
    dest = os.path.join(args.out, f'{args.season}.html')
    with open(dest, 'w', encoding='utf-8') as f:
        f.write('\n'.join(out))
    return dest


def build_index(out_dir, manifest, assets):
    """index.html linking every <season>.html report with live stats."""
    seasons = {}
    for e in manifest['files']:
        d = e.get('dlc')
        if not d:
            continue
        s = seasons.setdefault(d['season'], {'packs': set(), 'files': 0,
                                             'bytes': 0})
        s['packs'].add(d['pack'])
        s['files'] += 1
        s['bytes'] += e.get('bytes') or 0
    rows = []
    for season in sorted(seasons):
        s = seasons[season]
        f = os.path.join(out_dir, f'{season}.html')
        link = (f'<a href="{esc(season)}.html">{esc(season)}</a>'
                if os.path.isfile(f) else f'{esc(season)} <span class="dim">'
                f'(no report)</span>')
        bundle = os.path.join('cdn', f'{season}.7z')
        btxt = (fmt_bytes(os.path.getsize(bundle))
                if os.path.isfile(bundle) else '—')
        rows.append(
            f'<tr><td>{link}</td><td class="num">{len(s["packs"])}</td>'
            f'<td class="num">{s["files"]}</td>'
            f'<td class="num">{fmt_bytes(s["bytes"])}</td>'
            f'<td class="num">{btxt}</td></tr>')
    html_doc = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DLC extraction reports</title><style>
:root {{ color-scheme: light dark; }}
body {{ font: 14px/1.45 system-ui, sans-serif; margin: 1.5rem auto;
        max-width: 1080px; padding: 0 1rem; }}
table {{ border-collapse: collapse; width: 100%; }}
th, td {{ text-align: left; padding: .3rem .55rem;
        border-bottom: 1px solid rgba(127,127,127,.3); }}
th {{ font-size: 12px; text-transform: uppercase; }}
td.num {{ text-align: right; font-variant-numeric: tabular-nums; }}
.dim {{ opacity: .6; }} a {{ color: #1a6fd4; }}
@media (prefers-color-scheme: dark) {{ a {{ color: #6db3ff; }} }}
</style></head><body>
<h1>DLC extraction reports</h1>
<p>{len(seasons)} bundles decoded from the original-EA CDN archive
(<code>cdn/*.7z</code>). Reports generated by
<code>tools/dlc_report.py</code>; assets referenced in place from
<code>../../web/assets/dlc/</code>.</p>
<table><tr><th>Season / bundle</th><th class="num">Packs</th>
<th class="num">Entries</th><th class="num">Decoded</th>
<th class="num">Bundle</th></tr>
{''.join(rows)}
</table></body></html>
"""
    os.makedirs(out_dir, exist_ok=True)
    dest = os.path.join(out_dir, 'index.html')
    with open(dest, 'w', encoding='utf-8') as f:
        f.write(html_doc)
    return dest


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument('season')
    ap.add_argument('--out', default='notes/dlc-extraction')
    ap.add_argument('--bundle', default=None)
    ap.add_argument('--zips', default=None)
    ap.add_argument('--prefix', default='../../web/assets/')
    ap.add_argument('--assets', default='web/assets')
    args = ap.parse_args()
    with open(os.path.join(args.assets, 'manifest.json'),
              encoding='utf-8') as f:
        manifest = json.load(f)
    dest = run(args.season, args.out, args.bundle, args.zips,
               args.prefix, manifest)
    if dest is None:
        sys.exit(f'no manifest entries for season {args.season!r}')
    print(f'report -> {dest}')


if __name__ == '__main__':
    main()
