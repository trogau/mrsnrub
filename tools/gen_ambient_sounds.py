#!/usr/bin/env python3
"""gen_ambient_sounds.py — build the entity/zone ambient-loop map the City viewer plays.

The town hums on its own: the shipped scripts attach background loops to
buildings and decorations (`<AmbientSound soundKit="…"/>` inside a <Building>
or <Skin building="…"> block, resolved through a <SoundKit> package that
carries the loop's radius, volume and pitch), and attach zone loops to the land
itself (`<AmbientSounds><Region soundKit=… x1 y1 x2 y2/>` in landinfo.xml —
the ocean, the mountains, Krustyland). This tool reads that table from the
newest extracted `gamescripts-r<rev>` pack and writes the sidecar the viewer
streams from. It is the ambient counterpart of tools/gen_tap_sounds.py, which
reads the same pack's *Touched events; the two never touch each other's files.

Inputs
  web/assets/dlc/gamescripts-r<rev>/data/*.xml   the shipped scripts (newest
                            revision, found through the `packs` table, falling
                            back to what is on disk)
  web/api/assets.sqlite     type='audio' rows: every script-named loop is
                            resolved against these, case-insensitively with
                            the container dropped, and only a browser-playable
                            .m4a/.wav is ever kept — never the game's .caf
  data/building_ids.json    {id:{name,asset,slug}} — the viewer's building
                            catalog; an entity id this does not know is dropped

Output
  web/assets/city/ambient-sounds.json
    { "generated": "YYYY-MM-DD",
      "scripts": { "pack": "gamescripts-r…", "kits": n, "objects": n, "zones": n },
      "objects": { "b:<bid>": [ { "kit": "amb_ferris_wheel",
                                  "style": "LoopSingle" | "LoopSoundKit" | "PlayOnce",
                                  "inner": 12, "radius": 30,     // Position min/max, tiles
                                  "volume": 0.6, "pitch": 0.8,   // as the scripts wrote them
                                  "predelay": 4000, "postdelay": 8000,  // LoopSoundKit only
                                  "sounds": ["<assets-relative path>", …] }, … ] },
      "zones":   [ { "land": "Springfield", "name": "Ocean",
                     "x1": -48, "y1": -4, "x2": -2, "y2": 700, "radius": 24,
                     "volume": 0.7, "pitch": 1, "sounds": [ … ] }, … ] }
  Keys are prefixed 'b:' (building/decoration; the scripts file decorations as
  <Building> blocks too). Paths are relative to web/assets, so the viewer
  plays them as B + 'assets/' + path (the same convention as the tap sidecar).

Semantics the scripts give us and the sidecar keeps honest:
  * <SoundKit channel="objectAmbient_channel"> with <PlayStyle type="LoopSingle"/>
    plays ONE random member of its <Sound> list, looped, audible within the
    <Position min max> radius (tiles); volume/pitch come from <Volume>/<Pitch>.
  * type="LoopSoundKit" is the periodic one-shot: PreDelay/PostDelay (ms)
    between plays of a random member — the Duff Party Liner's boat horn.
  * Zones run on ambient_channel with 3s fades; landinfo.xml's Region rect is
    in the same tile grid the save places buildings on, so the viewer can test
    its camera centre against it directly. Springfield's centre kit is a
    settings indirection (__Settings_Config:Settings:SpringfieldSoundkit__)
    resolved through settings_config.xml — it is Springfield_Center.
  * A kit this pack does not define is chased through the other packs'
    *_soundkits.xml (newest first, and only while names are outstanding), the
    same way the tap tool chases tap kits. Nothing is guessed: a sound the
    corpus does not have, or a kit it cannot find, goes to --report.
  * Multiple <AmbientSound> elements on one entity (WaterslideTree carries two)
    are separate layers the game plays together; the sidecar keeps them as a
    list.

Usage
  python3 tools/gen_ambient_sounds.py [--web=web] [--repo=.]
                                      [--out=web/assets/city/ambient-sounds.json]
                                      [--scripts=<gamescripts pack data dir>]
                                      [--report=PATH] [--dry-run] [--verbose]

After generating, the viewer (web/viewer/city-view-pixi.js) fetches the JSON at
boot, loops the object kits whose radius reaches the camera and cross-fades the
zone loop that contains the camera centre.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
from datetime import date

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ATTR = re.compile(r'(\w+)="([^"]*)"')
# <Building>/<Skin> blocks, block form or self-closing (decorations ship as
# <Building> too). The \b keeps <Buildings>/<BuildingDefaults> out.
BLOCK = {k: re.compile(r'<%s\b[^>]*>.*?</%s>|<%s\b[^>]*/>' % (t, t, t), re.S)
         for k, t in (('b', 'Building'), ('s', 'Skin'))}
KIT_DEF = re.compile(r'<SoundKit\b[^>]*\bname="([^"]+)"[^>]*?(?:/>|>(.*?)</SoundKit>)', re.S)
AMB_EL = re.compile(r'<AmbientSound\b[^>]*/?>')
SOUND_IN_KIT = re.compile(r'<Sound\b[^>]*\bname="([^"]+)"')
STYLE = re.compile(r'<PlayStyle\b[^>]*\btype="([^"]+)"')
POSITION = re.compile(r'<Position\b[^>]*\bmin="([\d.]+)"[^>]*\bmax="([\d.]+)"')
VOLUME = re.compile(r'<Volume\b[^>]*\bvalue="([\d.]+)"')
PITCH = re.compile(r'<Pitch\b[^>]*\bvalue="([\d.]+)"')
PRED = re.compile(r'<PreDelay\b[^>]*\bvalue="([\d.]+)"')
POSTD = re.compile(r'<PostDelay\b[^>]*\bvalue="([\d.]+)"')
REGION = re.compile(r'<Region\b([^>]*)/>')
LAND = re.compile(r'<LandInfo\b[^>]*\bname="([^"]+)"[^>]*>.*?</LandInfo>', re.S)
SETTING = re.compile(r'<Attribute\b[^>]*\bname="SpringfieldSoundkit"[^>]*\bvalue="([^"]+)"')
PLAYABLE = re.compile(r'\.(m4a|wav)$', re.I)


def norm(s):
    """lowercase, drop everything but alphanumerics: 'Ferris_Wheel_Loop' -> 'ferriswheelloop'."""
    return re.sub(r'[^a-z0-9]', '', (s or '').lower())


def stem_of(name):
    """a shipped sound name as the scripts write it -> our lookup key."""
    s = re.sub(r'\.(caf|mp3|wav|m4a|ogg)$', '', (name or '').strip(), flags=re.I)
    return norm(s)


def f(x, d=None):
    try:
        return float(x)
    except (TypeError, ValueError):
        return d


# ------------------------------------------------------------------- reading
def load_audio(db_path):
    """every playable audio row, grouped by stem for the scripts' sound names."""
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        "SELECT a.base base, a.path path, p.pack pack, p.revision revision, "
        "a.res_class res_class, a.cat cat, a.bytes bytes "
        "FROM assets a LEFT JOIN packs p ON a.pack_id = p.id "
        "WHERE a.type='audio'").fetchall()
    con.close()
    by_stem = {}
    for r in rows:
        if not PLAYABLE.search(r['base']):        # .caf/.mp3 rows are the shipped
            continue                              # originals: no browser decodes them
        by_stem.setdefault(stem_of(r['base']), []).append(
            {'base': r['base'], 'path': r['path'], 'family': r['pack'],
             'revision': r['revision'], 'res_class': r['res_class'],
             'cat': r['cat'], 'bytes': r['bytes']})
    return by_stem


def pick_canonical_path(rows):
    """one assets-relative path per distinct base name (many revisions exist).

    Prefer the converted wav corpus, the newest revision, then a stable order.
    (Same choice the tap sidecar makes, so a loop the two share is one file.)
    """
    def key(r):
        rev = r['revision'] if isinstance(r['revision'], int) else -1
        return (0 if (r['res_class'] or '') == 'wav' else 1,
                -rev, len(r['path']), r['path'])
    return sorted(rows, key=key)[0]['path']


def find_scripts_dir(web, db_path):
    """the newest extracted gamescripts pack, as (its data dir, pack label)."""
    def from_db():
        try:
            con = sqlite3.connect(db_path)
            row = con.execute(
                "SELECT pack FROM packs WHERE pack LIKE 'gamescripts-r%' "
                "ORDER BY revision DESC LIMIT 1").fetchone()
            con.close()
            return row[0] if row else None
        except sqlite3.Error:
            return None

    def on_disk():
        base = os.path.join(web, 'assets', 'dlc')
        best, best_rev = None, -1
        if os.path.isdir(base):
            for name in os.listdir(base):
                m = re.match(r'^gamescripts-r(\d+)$', name)
                if m and int(m.group(1)) > best_rev and \
                        os.path.isdir(os.path.join(base, name, 'data')):
                    best, best_rev = name, int(m.group(1))
        return best

    pack = from_db()
    if pack and not os.path.isdir(os.path.join(web, 'assets', 'dlc', pack, 'data')):
        pack = None                               # indexed but never extracted
    pack = pack or on_disk()
    if not pack:
        return None, None
    return os.path.join(web, 'assets', 'dlc', pack, 'data'), pack


def find_soundkit_files(db_path, skip_pack):
    """assets-relative paths of every *_soundkits.xml, newest revision first."""
    try:
        con = sqlite3.connect(db_path)
        con.row_factory = sqlite3.Row
        rows = con.execute(
            "SELECT a.path path FROM assets a JOIN packs p ON a.pack_id = p.id "
            "WHERE a.base LIKE '%soundkit%.xml' "
            "ORDER BY p.revision DESC, a.path").fetchall()
        con.close()
    except sqlite3.Error:
        return []
    out = []
    for r in rows:
        m = re.match(r'^dlc/([^/]+)/', r['path'])
        if m and m.group(1) == skip_pack:          # read already with the scripts
            continue
        out.append(r['path'])
    return out


def load_buildings(building_json):
    """-> (ent, data): normalized key -> id, plus the raw {id: rec} for ids."""
    ent, data = {}, {}
    raw = json.load(open(building_json, encoding='utf-8'))
    for bid, rec in raw.items():
        if not isinstance(rec, dict):
            continue
        data[bid] = rec
        for f_ in ('name', 'asset', 'slug'):
            nk = norm(rec.get(f_))
            if nk:
                ent.setdefault(nk, bid)
    return ent, data


# ------------------------------------------------------------------ scanning
def parse_kit(body):
    """a <SoundKit> inner body -> the playback parameters the viewer needs."""
    pos = POSITION.search(body)
    vol = VOLUME.search(body)
    pit = PITCH.search(body)
    pre = PRED.search(body)
    post = POSTD.search(body)
    style = STYLE.search(body)
    return {'style': style.group(1) if style else 'LoopSingle',
            'inner': f(pos.group(1)) if pos else None,
            'radius': f(pos.group(2)) if pos else None,
            'volume': f(vol.group(1), 1.0) if vol else 1.0,
            'pitch': f(pit.group(1), 1.0) if pit else 1.0,
            'predelay': f(pre.group(1)) if pre else None,
            'postdelay': f(post.group(1)) if post else None,
            'sounds': SOUND_IN_KIT.findall(body)}


def scan(data_dir, web, audio, bldg_ent, bldg_data, extra_kit_files=None):
    """the scripts' ambient table -> (objects, zones, stats, report).

    One pass over the pack's XMLs collects the <SoundKit> packages and the
    <Building>/<Skin> blocks that bind them; a second reads the land zones.
    """
    kits = {}                                     # norm kit name -> params
    blocks = []                                   # (kind, attrs, kit names)
    files = sorted(f for f in os.listdir(data_dir) if f.endswith('.xml'))
    for fn in files:
        try:
            txt = open(os.path.join(data_dir, fn), encoding='utf-8',
                       errors='replace').read()
        except OSError:
            continue
        if 'SoundKit' in txt:
            for m in KIT_DEF.finditer(txt):
                params = parse_kit(m.group(2) or '')
                if params['sounds']:
                    kits.setdefault(norm(m.group(1)), []).append(params)
        if 'AmbientSound' not in txt:
            continue
        for kind in ('b', 's'):
            for m in BLOCK[kind].finditer(txt):
                blk = m.group(0)
                els = AMB_EL.findall(blk)
                if not els:
                    continue
                attrs = dict(ATTR.findall(blk[:blk.find('>') + 1]))
                names = [dict(ATTR.findall(el)).get('soundKit') for el in els]
                blocks.append((kind, attrs, [n for n in names if n]))

    # a kit the scripts reference but this pack never defines: chase it through
    # the other packs, but only while names are still outstanding.
    want = set(norm(n) for _k, _a, ns in blocks for n in ns if norm(n) not in kits)
    read = 0
    for rel in (extra_kit_files or []):
        if not want or read >= 40000:
            break
        try:
            txt = open(os.path.join(web, 'assets', rel), encoding='utf-8',
                       errors='replace').read()
        except OSError:
            continue
        read += 1
        for m in KIT_DEF.finditer(txt):
            if norm(m.group(1)) in want:
                params = parse_kit(m.group(2) or '')
                if params['sounds']:
                    kits.setdefault(norm(m.group(1)), []).append(params)
        want = set(n for n in want if n not in kits)

    missing, unknown = set(), set()

    def resolve(nm):
        rows = audio.get(stem_of(nm))
        if not rows:
            unknown.add(nm)
            return None
        return pick_canonical_path(rows)

    def layer(kit_name):
        variants = kits.get(norm(kit_name))
        if not variants:
            missing.add(kit_name)
            return None
        params = variants[0]                      # first definition wins
        paths = [p for p in (resolve(s) for s in params['sounds']) if p]
        if not paths:
            return None
        lay = {k: params[k] for k in
               ('style', 'inner', 'radius', 'volume', 'pitch', 'predelay', 'postdelay')}
        # a kit with no <Position> is heard anywhere on the land; the viewer
        # needs a radius to fade on, so give it the land zones' own default.
        if lay['radius'] is None:
            lay['radius'] = 16.0
        if lay['inner'] is None or lay['inner'] > lay['radius']:
            lay['inner'] = min(8.0, lay['radius'])
        lay['kit'] = kit_name
        lay['sounds'] = sorted(set(paths))
        return lay

    # ---- objects: <Building id> / <Skin building> bindings, catalog-checked
    objects = {}
    for kind, attrs, names in blocks:
        if kind == 's':
            parent = attrs.get('building')
            bid = bldg_ent.get(norm(parent)) if parent else None
        else:
            bid = attrs.get('id')
            if bid not in bldg_data:
                nk = bldg_ent.get(norm(attrs.get('name')))
                bid = nk if nk and (attrs.get('id') is None or nk == attrs.get('id')) else None
        if not bid:
            continue
        layers = [lay for lay in (layer(n) for n in names) if lay]
        if layers:
            # the scripts repeat one kit per animation state (OldKingCoal
            # carries Ambient_Pinchy eight times); one loop is one loop
            uniq = {json.dumps(l, sort_keys=True): l for l in layers}
            objects.setdefault('b:%s' % bid, []).extend(uniq.values())

    # ---- zones: landinfo.xml Regions, settings indirection resolved
    zones = []
    landinfo = os.path.join(data_dir, 'landinfo.xml')
    center_kit = None
    settings = os.path.join(data_dir, 'settings_config.xml')
    if os.path.exists(settings):
        m = SETTING.search(open(settings, encoding='utf-8',
                                errors='replace').read())
        center_kit = m.group(1) if m else None
    if os.path.exists(landinfo):
        txt = open(landinfo, encoding='utf-8', errors='replace').read()
        for m in LAND.finditer(txt):
            land = m.group(1)
            for rm in REGION.finditer(m.group(0)):
                a = dict(ATTR.findall(rm.group(1)))
                sk = a.get('soundKit', '')
                if sk.startswith('__Settings_Config'):
                    sk = center_kit or ''         # Springfield_Center
                if not sk:
                    continue
                lay = layer(sk)
                if not lay:
                    continue
                zones.append({'land': land, 'name': (a.get('name') or '').strip(),
                              'x1': f(a.get('x1'), 0), 'y1': f(a.get('y1'), 0),
                              'x2': f(a.get('x2'), 0), 'y2': f(a.get('y2'), 0),
                              'radius': f(a.get('radius'), 8),
                              'volume': lay['volume'], 'pitch': lay['pitch'],
                              'sounds': lay['sounds']})

    for k in objects:                             # deterministic output
        objects[k].sort(key=lambda l: (l['kit'], l['sounds']))
    stats = {'pack': os.path.basename(os.path.dirname(data_dir)),
             'files': len(files), 'kits': len(kits), 'kit_files': read,
             'defs': len(blocks), 'objects': len(objects), 'zones': len(zones)}
    report = {'missing_kits': sorted(missing), 'unknown_sounds': sorted(unknown)}
    return objects, zones, stats, report


# ---------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--repo', default=REPO)
    ap.add_argument('--web', default=None, help='web root (default <repo>/web)')
    ap.add_argument('--db', default=None, help='assets.sqlite (default <web>/api/assets.sqlite)')
    ap.add_argument('--out', default=None,
                    help='output JSON (default <web>/assets/city/ambient-sounds.json)')
    ap.add_argument('--scripts', default=None, metavar='DIR',
                    help='gamescripts data dir holding the ambient table '
                         '(default: the newest extracted gamescripts-r<rev> pack)')
    ap.add_argument('--report', default=None, metavar='PATH')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--verbose', action='store_true')
    a = ap.parse_args()

    web = a.web or os.path.join(a.repo, 'web')
    db = a.db or os.path.join(web, 'api', 'assets.sqlite')
    building_json = os.path.join(a.repo, 'data', 'building_ids.json')
    out_path = a.out or os.path.join(web, 'assets', 'city', 'ambient-sounds.json')

    for p in (db, building_json):
        if not os.path.exists(p):
            raise SystemExit(f'missing input: {p}')

    data_dir, pack = (a.scripts, os.path.basename(os.path.dirname(
        os.path.normpath(a.scripts)))) if a.scripts else find_scripts_dir(web, db)
    if not data_dir:
        raise SystemExit('no extracted gamescripts-r<rev> pack found '
                         '(--scripts=DIR to point at one)')

    bldg_ent, bldg_data = load_buildings(building_json)
    objects, zones, stats, report = scan(
        data_dir, web, load_audio(db), bldg_ent, bldg_data,
        extra_kit_files=find_soundkit_files(db, pack))

    result = {'generated': date.today().isoformat(),
              'scripts': {'pack': stats['pack'], 'kits': stats['kits'],
                          'objects': stats['objects'], 'zones': stats['zones']},
              'objects': {k: v for k, v in sorted(objects.items())},
              'zones': zones}

    print(f'{stats["pack"]} — {stats["files"]} xml, {stats["kits"]} soundkits defined '
          f'({stats["kit_files"]} extra kit files read), '
          f'{stats["defs"]} <AmbientSound> defs, '
          f'{stats["objects"]} catalogued objects, {stats["zones"]} land zones')
    loops = sum(len(l['sounds']) for v in objects.values() for l in v)
    print(f'  {loops} object loop references, '
          f'{sum(len(z["sounds"]) for z in zones)} zone loop references')
    if report['missing_kits'] or report['unknown_sounds']:
        print(f'  {len(report["missing_kits"])} kit(s) missing, '
              f'{len(report["unknown_sounds"])} sound(s) not in the corpus')

    if a.report:
        os.makedirs(os.path.dirname(os.path.abspath(a.report)), exist_ok=True)
        with open(a.report, 'w', encoding='utf-8') as f:
            json.dump({'scripts': dict(stats, **{'objects': stats['objects']}),
                       'missing_kits': report['missing_kits'],
                       'unknown_sounds': report['unknown_sounds']}, f, indent=1)
        print(f'report: {a.report}')

    if a.verbose:
        for k in report['missing_kits']:
            print(f'  NO-KIT   {k}')
        for k in report['unknown_sounds']:
            print(f'  NO-FILE  {k}')

    if a.dry_run:
        print('--dry-run: not written')
        return 0

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    tmp = out_path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, separators=(',', ':'),
                  sort_keys=True)
    os.replace(tmp, out_path)
    print(f'wrote {out_path}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
