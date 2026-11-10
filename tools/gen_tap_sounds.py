#!/usr/bin/env python3
"""gen_tap_sounds.py — build the entity -> tap-sound map the City viewer plays.

When you click a character or a building in the viewer it should say something:
the game ships a per-entity "tap" voice/sfx line (`<stem>_tap[_N].mp3`, extracted
to `<stem>_tap[_N].m4a`) and there is no table in the game data that ties an
entity to its line — the audio stems are the game's own, and match neither the
display name nor the animation slug for most of the roster (`Wiggum` ->
`chief_wiggum`, `Frink` -> `prof_frink`, a building `SpringfieldGeneral` ->
`springfieldgeneral`). So the map is reconstructed here, from the extracted
corpus, by attributing every `*_tap*` file to the entity it belongs to.

Inputs
  web/assets/dlc/gamescripts-r<rev>/data/*.xml   the shipped scripts — the
                           game's OWN tap table (see "The scripts table" below;
                           the newest extracted gamescripts revision is used)
  web/api/assets.sqlite    type='audio' rows: every row is a candidate for a
                           script-named line, rows whose base contains 'tap'
                           also feed the heuristic pass (the AAC corpus
                           tools/convert_audio_pcm.py produced)
  web/assets/characters/characters.json   {characters:{id:{name,slug,pool}}}
  web/assets/characters/families/<cid>.json  cells[].stem (underscored anim stems)
  data/building_ids.json   {id:{name,asset,slug}}

Output
  web/assets/characters/tap-sounds.json
    { "generated": "YYYY-MM-DD",
      "entities": { "c:<cid>": ["<assets-relative path>", ...],
                    "b:<bid>": [ ... ] } }
  Keys are prefixed: 'c:' character, 'b:' building. Paths are relative to
  web/assets, so the viewer plays them as B + 'assets/' + path (the same
  convention as the Asset Explorer).

The scripts table — the scripts say outright what a click plays, so when a
line is named there it wins and the heuristic below is not consulted for that
entity. A <Building> block (and a <Skin building="…"> reskin) carries either
    <Sound event="BuildingTouched" sound="20_simpson_house_1.caf" />
or a kit reference
    <SoundKit event="BuildingTouched" name="DronePack_tap" />
resolved through a <SoundKit name="…" channel="buildingTap_channel"> package
that lists its <Sound name="sfx_…_tap" /> entries. Characters do the same with
event="CharacterSoundTouched" / "CharacterTouched" on <Character> and
<Skin character="…"> blocks. Reading that table is what makes the town talk:
the stem heuristic alone attributed 315 buildings, the scripts name 1900+, and
they name the CORE ones the file names hide — the Simpson house, the power
plant and the Kwik-E-Mart ship `20_simpson_house_1` / `24_nuclear_plant_2` /
`30_kwik_e_mart_2`, which no `_tap` stem would ever have matched. Sound names
are resolved against every audio row (case-insensitively, extension dropped)
and only a browser-playable copy (.m4a/.wav) is kept; the game's `.caf` is not.
Names the table gives that the corpus does not have are reported, never guessed.

Attribution — for each distinct tap base name the scripts do NOT claim, a
"core stem" is derived (strip sfx_/ea_tsto_/dec_ prefixes and a leading number,
cut at the first 'tap' marker) and matched, in priority order, against the
entity dictionaries:
  1. an explicit override (tools/tap_sounds_overrides.json)
  2. core stem == an entity key (character name/slug/family-stem/pool, building
     name/asset/slug), compared with punctuation/spaces removed
  3. the longest trailing token-run of the core stem == an entity key (handles a
     costume prefix: `fireman_homer_tap_1` -> homer), or the whole core is a
     prefix/suffix of exactly one entity key (a building named in truncated form:
     `springfieldgeneral` -> SpringfieldGeneralHospital) — the latter only when
     the core is long enough to belong to just that one entity
  4. the DLC bundle's family name (minus a trailing 'Audio') == an entity key,
     but only when that label corroborates the core (one contains the other) —
     this recovers a character whose own voice file is named obliquely
     (`monroe_tap` in `MarvinMonroeAudio`, `ruth_powers_*` in `RuthPowersAudio`)
     while the corroboration guard rejects files that merely rode in a shared or
     another entity's pack.
The first signal that hits wins, so a bundle name never overrides a direct stem
match. When both a character and a building claim the same signal, the tie is
broken toward the character. Anything left unattributed is written to the report
so the override file can be grown later — an entity the scripts do not name and
that owns no `*_tap*` file simply stays silent, which is what the game does with
a fence or a hedge.

Usage
  python3 tools/gen_tap_sounds.py [--web=web] [--repo=.]
                                 [--out=web/assets/characters/tap-sounds.json]
                                 [--overrides=tools/tap_sounds_overrides.json]
                                 [--scripts=<gamescripts pack data dir>]
                                 [--no-scripts]
                                 [--report=PATH] [--dry-run] [--verbose]

After generating, the viewer (web/viewer/city-view-pixi.js) fetches the JSON at
boot and plays a random path from the clicked entity's list via AudioMixer.
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

# a tap file's base name, minus extension, that we try to attribute
TAP_FILTER = '%tap%'

# prefixes that decorate the game's own file names but are not part of the stem
DROP_PREFIX = re.compile(r'^(?:sfx[_-]+|ea_tsto[_-]+|dec[_-]+|ea[_-]+)+', re.I)
LEADING_NUM = re.compile(r'^\d+[_-]+')
TRAILING_JUNK = re.compile(r'[_-]+$')


def norm(s):
    """lowercase, drop everything but alphanumerics: 'Kwik-E-Mart' -> 'kwikemart'."""
    return re.sub(r'[^a-z0-9]', '', (s or '').lower())


def core_stem(base):
    """'sfx_22for30_basketballcourt_shot_made' style -> the entity-bearing core.

    Cut at the FIRST 'tap' marker (so deep_space_homer_tap_1 -> deep_space_homer
    and breakoutbounty_escapedconvict_tappable_runaway -> breakoutbounty_escapedconvict),
    strip decoration prefixes / a leading number / a trailing separator.
    """
    s = re.sub(r'\.(m4a|wav|mp3|caf)$', '', base, flags=re.I)
    s = DROP_PREFIX.sub('', s)
    s = LEADING_NUM.sub('', s)
    i = s.lower().find('tap')
    if i > 0:                     # keep the part before the tap marker
        s = s[:i]
    s = TRAILING_JUNK.sub('', s)
    return s.strip()


# ------------------------------------------------------------------ entities
def load_characters(char_json, families_dir):
    """-> (ent, chars, name_ent). `ent` is normalized key -> (kind, id, display);
    characters carry several keys (name/slug/pool plus every family-stem). `name_ent`
    is the same shape but holds only display names — the safe index for the fuzzy
    2b tier, which must not see a concatenated skin stem like `bartstretchdude`."""
    ent = {}
    name_ent = {}                           # display names only (no derived stems)
    data = json.load(open(char_json, encoding='utf-8'))
    chars = data.get('characters', {}) or {}
    for cid, rec in chars.items():
        keys = [rec.get('name'), rec.get('slug')] + list(rec.get('pool', []) or [])
        for k in keys:
            nk = norm(k)
            if nk:
                ent.setdefault(nk, ('c', cid, rec.get('name', cid)))
        nk = norm(rec.get('name'))          # the name-only tier must not see a
        if nk:                              # concatenated skin stem (see match 2b)
            name_ent.setdefault(nk, ('c', cid, rec.get('name', cid)))
    # families/<cid>.json cells[].stem are the underscored animation stems
    if os.path.isdir(families_dir):
        for fn in os.listdir(families_dir):
            if not fn.endswith('.json'):
                continue
            cid = fn[:-5]
            try:
                j = json.load(open(os.path.join(families_dir, fn), encoding='utf-8'))
            except (OSError, ValueError):
                continue
            name = j.get('name', cid)
            for cell in j.get('cells', []) or []:
                st = cell.get('stem') or ''
                for cand in (st, re.sub(r'_(back|front|idle|active|walk|display|come|use|have|attack|hurt).*', '', st)):
                    nk = norm(cand)
                    if nk:
                        ent.setdefault(nk, ('c', cid, name))
    return ent, chars, name_ent


def load_buildings(building_json):
    """-> (ent, data). `ent` is normalized key -> ('b', id, display) from the
    catalog's name/asset/slug; `data` is the raw {id: rec} for id lookups."""
    ent = {}
    data = json.load(open(building_json, encoding='utf-8'))
    for bid, rec in data.items():
        if not isinstance(rec, dict):
            continue
        for f in ('name', 'asset', 'slug'):
            nk = norm(rec.get(f))
            if nk:
                ent.setdefault(nk, ('b', bid, rec.get('name', bid)))
    return ent, data


# ------------------------------------------------------------------- reading
def load_taps(db_path):
    """rows of (base, path, family, revision, res_class, cat) for tap audio."""
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        "SELECT a.base base, a.path path, p.pack pack, p.revision revision, "
        "a.res_class res_class, a.cat cat, a.bytes bytes "
        "FROM assets a LEFT JOIN packs p ON a.pack_id = p.id "
        "WHERE a.type='audio' AND a.base LIKE ?", (TAP_FILTER,)).fetchall()
    con.close()
    out = []
    for r in rows:
        out.append({'base': r['base'], 'path': r['path'], 'family': r['pack'],
                    'revision': r['revision'], 'res_class': r['res_class'],
                    'cat': r['cat'], 'bytes': r['bytes']})
    return out


def bundle_family(row):
    """the DLC bundle's family name (minus revision/res suffix), else None."""
    fam = row.get('family')
    if not fam:
        return None
    # packs are named like 'ArtieZiffAudio-wav-r146180'; the leading label is the key
    label = re.split(r'[-_]', fam)[0]
    return label


# --------------------------------------------------- the game's own tap table
# See the docstring: <Sound event="BuildingTouched" sound="…"/> on a <Building>,
# or a <SoundKit event="…" name="…_tap"/> reference resolved through a SoundKit
# package. TAP_EVENTS says which script events mean "the player poked this".
TAP_EVENTS = ('BuildingTouched', 'CharacterSoundTouched', 'CharacterTouched')

ATTR = re.compile(r'(\w+)="([^"]*)"')
# <Building>/<Character>/<Skin> blocks, block form or self-closing. The \b after
# the tag name keeps the <Buildings> root and <BuildingDefaults> out, and a
# block never reaches past its own close because the same tag does not nest.
BLOCK = {k: re.compile(r'<%s\b[^>]*>.*?</%s>|<%s\b[^>]*/>' % (t, t, t), re.S)
         for k, t in (('b', 'Building'), ('c', 'Character'), ('s', 'Skin'))}
KIT_DEF = re.compile(r'<SoundKit\b[^>]*\bname="([^"]+)"[^>]*>(.*?)</SoundKit>', re.S)
SOUND_EL = re.compile(r'<Sound\b[^>]*/?>')
KIT_EL = re.compile(r'<SoundKit\b[^>]*/?>')
SOUND_IN_KIT = re.compile(r'<Sound\b[^>]*\bname="([^"]+)"')
PLAYABLE = re.compile(r'\.(m4a|wav)$', re.I)


def stem_of(name):
    """a shipped sound name as the scripts write it -> our lookup key.

    '20_simpson_house_1.caf' and 'BART_TAP1.mp3' both reduce to the corpus' own
    base — lowercased, punctuation dropped, extension off — because the scripts'
    spelling and the extracted file's differ in case and container only.
    """
    s = re.sub(r'\.(caf|mp3|wav|m4a|ogg)$', '', (name or '').strip(), flags=re.I)
    return norm(s)


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


def find_scripts_dir(web, db_path):
    """the newest extracted gamescripts pack, as (its data dir, pack label).

    Every content drop lands its scripts in the gamescripts bundle, so the
    newest revision is the fullest copy of the table; older revisions are read
    later, and only for the kits this one is missing. (None, None) when nothing
    is extracted — the heuristic pass then stands on its own.
    """
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


def entity_of(kind, attrs, chars, buildings, char_ent, bldg_ent):
    """a script block's own identity -> (kind, catalog id), or None to drop it.

    The scripts' `id=` is the id the viewer clicks (buildings.xml's
    `<Building id="1" name="SimpsonHome">` is b:1), so it is trusted first; a
    <Skin> carries its parent in `building=` / `character=` and has an id of its
    own that must never be used as one. Names fall back to the same normalized
    indexes the heuristic pass uses.
    """
    if kind == 's':                               # a reskin belongs to its parent
        for k, key in (('building', 'b'), ('character', 'c')):
            if attrs.get(k):
                return entity_of(key, {('id' if key == 'b' else 'name'): attrs[k]},
                                 chars, buildings, char_ent, bldg_ent)
        return None
    table = buildings if kind == 'b' else chars
    ent = bldg_ent if kind == 'b' else char_ent
    aid = attrs.get('id')
    if aid is not None and aid in table:
        return (kind, aid)
    for f in ('name', 'asset', 'slug'):
        nk = norm(attrs.get(f))
        if nk and nk in ent:
            return ent[nk][:2]
    return None


def scan_scripts(data_dir, web, audio, chars, buildings, char_ent, bldg_ent,
                 extra_kit_files=None, kit_file_budget=40000):
    """the scripts' tap table -> ('b:<id>'/'c:<id>' -> {assets-relative path}, stats).

    One pass over the pack's XMLs collects both halves of the table — the
    <SoundKit> packages and the entity blocks that reference them — so a kit
    defined in one file and used in another still resolves. A kit this pack
    never defines is chased through the other packs' *_soundkits.xml (newest
    first, `extra_kit_files`, and only while names are still outstanding).
    """
    kits = {}                                     # norm kit name -> {sound names}
    blocks = []                                   # (kind, attrs, sounds, kit names)
    files = sorted(f for f in os.listdir(data_dir) if f.endswith('.xml'))
    for fn in files:
        try:
            txt = open(os.path.join(data_dir, fn), encoding='utf-8',
                       errors='replace').read()
        except OSError:
            continue
        for m in KIT_DEF.finditer(txt):
            names = SOUND_IN_KIT.findall(m.group(2))
            if names:
                kits.setdefault(norm(m.group(1)), set()).update(names)
        if 'Touched' not in txt:
            continue
        for kind in ('b', 'c', 's'):
            for m in BLOCK[kind].finditer(txt):
                blk = m.group(0)
                if 'Touched' not in blk:
                    continue
                attrs = dict(ATTR.findall(blk[:blk.find('>') + 1]))
                sounds, kit_names = set(), set()
                for el in SOUND_EL.findall(blk):
                    a = dict(ATTR.findall(el))
                    if a.get('event') in TAP_EVENTS and a.get('sound'):
                        sounds.add(a['sound'])
                for el in KIT_EL.findall(blk):
                    a = dict(ATTR.findall(el))
                    if a.get('event') in TAP_EVENTS and a.get('name'):
                        kit_names.add(a['name'])
                if sounds or kit_names:
                    blocks.append((kind, attrs, sounds, kit_names))

    # a kit the scripts reference but this pack never defines: chase it through
    # the other packs, but only while names are still outstanding.
    want = set(norm(n) for _k, _a, _s, kn in blocks for n in kn
               if norm(n) not in kits)
    read = 0
    for rel in (extra_kit_files or []):
        if not want or read >= kit_file_budget:
            break
        try:
            txt = open(os.path.join(web, 'assets', rel), encoding='utf-8',
                       errors='replace').read()
        except OSError:
            continue
        read += 1
        for m in KIT_DEF.finditer(txt):
            if norm(m.group(1)) in want:
                names = SOUND_IN_KIT.findall(m.group(2))
                if names:
                    kits.setdefault(norm(m.group(1)), set()).update(names)
        want = set(n for n in want if n not in kits)

    def path_of(nm):
        rows = audio.get(stem_of(nm))
        return pick_canonical_path(rows) if rows else None

    out, missing, unknown = {}, set(), set()
    for kind, attrs, sounds, kit_names in blocks:
        ent = entity_of(kind, attrs, chars, buildings, char_ent, bldg_ent)
        if not ent:
            continue
        paths = out.setdefault('%s:%s' % ent, set())
        for nm in sounds:
            p = path_of(nm)
            if p:
                paths.add(p)
            else:
                unknown.add(nm)
        for kn in kit_names:
            members = kits.get(norm(kn))
            if not members:
                missing.add(kn)
                continue
            for nm in members:
                p = path_of(nm)
                if p:
                    paths.add(p)
                else:
                    unknown.add(nm)
    out = {k: v for k, v in out.items() if v}
    stats = {'pack': os.path.basename(os.path.dirname(data_dir)),
             'files': len(files), 'kits': len(kits), 'kit_files': read,
             'defs': len(blocks), 'entities': len(out),
             'missing_kits': sorted(missing), 'unknown_sounds': sorted(unknown)}
    return out, stats


# ------------------------------------------------------------------ choose
def pick_canonical_path(rows):
    """one assets-relative path per distinct base name (many revisions exist).

    Prefer the converted wav corpus, the newest revision, then a stable order.
    """
    def key(r):
        rev = r['revision'] if isinstance(r['revision'], int) else -1
        return (0 if (r['res_class'] or '') == 'wav' else 1,
                -rev, len(r['path']), r['path'])
    return sorted(rows, key=key)[0]['path']


def match(core, rows, char_ent, bldg_ent, overrides, name_ent=None):
    """-> ('c'|'b', id, display, signal) or None. signal is a rank (0 best)."""
    ncore = norm(core)
    name_ent = name_ent or {}
    # 0. explicit override (by core stem, or by any base of this file group)
    for okey in (core, ncore) + tuple(r['base'] for r in rows):
        ov = overrides.get(okey) or overrides.get(norm(okey))
        if ov:
            if ov.get('exclude'):
                return None
            ent = ov.get('entity')
            if ent:
                kind, bid = ent.split(':', 1)
                disp = (char_ent.get(ncore) or bldg_ent.get(ncore) or (None, None, None))[2]
                return (kind, bid, disp, 0)
    # 1. exact core stem == an entity key
    hit = char_ent.get(ncore) or bldg_ent.get(ncore)
    if hit:
        return (hit[0], hit[1], hit[2], 1)
    # 2. longest trailing token-run of the core stem (costume prefix drop):
    #    `fireman_homer_tap_1` -> homer. Runs BEFORE the bundle signal so a real
    #    building/character claims its own file before an event bundle can grab it.
    toks = [t for t in re.split(r'[_\s]+', core) if t]
    for i in range(len(toks)):
        sub = norm('_'.join(toks[i:]))
        if not sub:
            continue
        hc, hb = char_ent.get(sub), bldg_ent.get(sub)
        if hc:
            return (hc[0], hc[1], hc[2], 2)       # char wins a bare tie
        if hb:
            return (hb[0], hb[1], hb[2], 2)
    # 2b. the whole core is a prefix or suffix of exactly ONE entity NAME. This
    #     recovers the buildings whose tap file names them in a truncated form
    #     (`springfieldgeneral` -> SpringfieldGeneralHospital, `postoffice` ->
    #     SpringfieldPostOffice) and a few characters whose name carries a
    #     prefix (`grumple` -> TheGrumple). Matched against the NAME index only,
    #     never the derived family/pool/skin stems: a skin stem is
    #     `<base><skin>`, so `stretch_dude` would otherwise be pulled onto the
    #     base hero via `bartstretchdude`. Guarded by a minimum length and
    #     uniqueness so a short or shared stem stays unattributed rather than
    #     play the wrong entity's line.
    if len(ncore) >= 7:
        cands = {}
        for ents in (name_ent, bldg_ent):
            for k, rec in ents.items():
                if k.startswith(ncore) or k.endswith(ncore):
                    cands[(rec[0], rec[1])] = rec
        if len(cands) == 1:
            c = next(iter(cands.values()))
            return (c[0], c[1], c[2], 2)
    # 3. the DLC bundle's family name (minus 'Audio'), but only when the label
    #    both names a real entity AND corroborates the core (one contains the
    #    other). The corroboration guard is what keeps a shared/placeholder pack
    #    (e.g. 'DatabaseAudio', which ships unrelated building taps) or a file
    #    that merely rode in someone else's pack (a Rosa skin in MaggieAudio)
    #    from being mis-filed onto the bundle's namesake.
    for r in rows:
        label = bundle_family(r)
        if not label:
            continue
        nb = norm(re.sub(r'audio$', '', label, flags=re.I))
        if not nb or not (nb in ncore or ncore in nb):
            continue
        hit = char_ent.get(nb) or bldg_ent.get(nb)
        if hit:
            return (hit[0], hit[1], hit[2], 3)
    return None


# ---------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--repo', default=REPO)
    ap.add_argument('--web', default=None, help='web root (default <repo>/web)')
    ap.add_argument('--db', default=None, help='assets.sqlite (default <web>/api/assets.sqlite)')
    ap.add_argument('--out', default=None, help='output JSON (default <web>/assets/characters/tap-sounds.json)')
    ap.add_argument('--overrides', default=None,
                    help='override JSON (default <repo>/tools/tap_sounds_overrides.json)')
    ap.add_argument('--scripts', default=None, metavar='DIR',
                    help='gamescripts data dir holding the game\'s own tap table '
                         '(default: the newest extracted gamescripts-r<rev> pack)')
    ap.add_argument('--no-scripts', action='store_true',
                    help='skip the scripts table and use only the *_tap* stem heuristic')
    ap.add_argument('--report', default=None, metavar='PATH')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--verbose', action='store_true')
    a = ap.parse_args()

    web = a.web or os.path.join(a.repo, 'web')
    db = a.db or os.path.join(web, 'api', 'assets.sqlite')
    char_json = os.path.join(web, 'assets', 'characters', 'characters.json')
    families = os.path.join(web, 'assets', 'characters', 'families')
    building_json = os.path.join(a.repo, 'data', 'building_ids.json')
    out_path = a.out or os.path.join(web, 'assets', 'characters', 'tap-sounds.json')
    ovr_path = a.overrides or os.path.join(a.repo, 'tools', 'tap_sounds_overrides.json')

    for p in (db, char_json, building_json):
        if not os.path.exists(p):
            raise SystemExit(f'missing input: {p}')

    overrides = {}
    if os.path.exists(ovr_path):
        raw = json.load(open(ovr_path, encoding='utf-8'))
        for src in ('cores', 'bases'):
            for k, v in (raw.get(src) or {}).items():
                overrides[k] = v if isinstance(v, dict) else {'entity': v}
        for k in (raw.get('exclude') or []):
            overrides[k] = {'exclude': True}

    char_ent, chars, char_name = load_characters(char_json, families)
    bldg_ent, buildings = load_buildings(building_json)

    # 1. the game's own table: what the scripts say a click plays.
    scripted, sstats = {}, None
    if not a.no_scripts:
        data_dir, pack = (a.scripts, os.path.basename(os.path.dirname(
            os.path.normpath(a.scripts)))) if a.scripts else find_scripts_dir(web, db)
        if data_dir:
            scripted, sstats = scan_scripts(
                data_dir, web, load_audio(db), chars, buildings,
                char_ent, bldg_ent,
                extra_kit_files=find_soundkit_files(db, pack))

    # 2. the stem heuristic over the *_tap* corpus — the fallback for everything
    #    the scripts do not name, and the whole story when no scripts pack has
    #    been extracted. An entity the table spoke for is left alone: its own
    #    line beats a guess.
    taps = load_taps(db)
    # group rows by base name so one file -> one canonical path
    by_base = {}
    for r in taps:
        by_base.setdefault(r['base'], []).append(r)

    entities = {k: set(v) for k, v in scripted.items()}
    unattributed = {}
    attributed = 0                                # files the heuristic claimed
    kept = 0                                      # …of those, ones actually used
    for base, rows in by_base.items():
        core = core_stem(re.sub(r'\.(m4a|wav|mp3|caf)$', '', base, flags=re.I))
        hit = match(core, rows, char_ent, bldg_ent, overrides, name_ent=char_name)
        if not hit:
            unattributed[base] = {'core': core,
                                  'family': bundle_family(rows[0])}
            continue
        kind, eid, _disp, _sig = hit
        key = f'{kind}:{eid}'
        attributed += 1
        if key in scripted:
            continue                              # the game's own line wins
        entities.setdefault(key, set()).add(pick_canonical_path(rows))
        kept += 1

    # deterministic, sorted output
    entities_out = {k: sorted(v) for k, v in sorted(entities.items())}
    result = {'generated': date.today().isoformat(),
              'entities': entities_out}
    if sstats:
        result['scripts'] = {'pack': sstats['pack'],
                             'defs': sstats['defs'],
                             'kits': sstats['kits'],
                             'entities': sstats['entities']}

    def split(keys):
        return (sum(1 for k in keys if k.startswith('c:')),
                sum(1 for k in keys if k.startswith('b:')))

    named = [k for k in entities_out if k in scripted]
    guessed = [k for k in entities_out if k not in scripted]
    cn, bn = split(named)
    print(f'{len(by_base)} distinct tap base names, '
          f'{len(entities_out)} entities with sound '
          f'({sum(1 for k in entities_out if k.startswith("c:"))} characters, '
          f'{sum(1 for k in entities_out if k.startswith("b:"))} buildings)')
    if sstats:
        print(f'  scripts: {sstats["pack"]} — {sstats["files"]} xml, '
              f'{sstats["defs"]} tapped defs, {sstats["kits"]} soundkits '
              f'({sstats["kit_files"]} extra kit files read), '
              f'{cn} characters + {bn} buildings named by the game'
              + (f', {len(sstats["missing_kits"])} kit(s) missing, '
                 f'{len(sstats["unknown_sounds"])} sound(s) not in the corpus'
                 if (sstats['missing_kits'] or sstats['unknown_sounds']) else ''))
    print(f'  stems:   {attributed} of {len(by_base)} *_tap* file(s) attributed, '
          f'{kept} kept as lines for the {len(guessed)} entities the scripts do '
          f'not name ({len(unattributed)} unattributed)')

    if a.report:
        os.makedirs(os.path.dirname(os.path.abspath(a.report)), exist_ok=True)
        with open(a.report, 'w', encoding='utf-8') as f:
            json.dump({'unattributed': dict(sorted(unattributed.items())),
                       'scripts': sstats and {
                           'pack': sstats['pack'],
                           'missing_kits': sstats['missing_kits'],
                           'unknown_sounds': sstats['unknown_sounds']}},
                      f, indent=1)
        print(f'report: {a.report}')

    if a.verbose:
        if sstats:
            for k in sstats['missing_kits']:
                print(f'  NO-KIT   {k}')
            for k in sstats['unknown_sounds']:
                print(f'  NO-FILE  {k}')
        for k in sorted(unattributed):
            print(f'  UNATTR {k}  (core={unattributed[k]["core"]}, '
                  f'family={unattributed[k]["family"]})')

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
