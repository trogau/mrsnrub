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
  web/api/assets.sqlite    type='audio' rows whose base name contains 'tap'
                           (the AAC corpus tools/convert_audio_pcm.py produced)
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

Attribution — for each distinct tap base name, a "core stem" is derived (strip
sfx_/ea_tsto_/dec_ prefixes and a leading number, cut at the first 'tap' marker)
and matched, in priority order, against the entity dictionaries:
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
so the override file can be grown later — an entity with no `*_tap*` file simply
stays silent.

Usage
  python3 tools/gen_tap_sounds.py [--web=web] [--repo=.]
                                 [--out=web/assets/characters/tap-sounds.json]
                                 [--overrides=tools/tap_sounds_overrides.json]
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
    ent = {}
    data = json.load(open(building_json, encoding='utf-8'))
    for bid, rec in data.items():
        if not isinstance(rec, dict):
            continue
        for f in ('name', 'asset', 'slug'):
            nk = norm(rec.get(f))
            if nk:
                ent.setdefault(nk, ('b', bid, rec.get('name', bid)))
    return ent


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

    char_ent, _chars, char_name = load_characters(char_json, families)
    bldg_ent = load_buildings(building_json)

    taps = load_taps(db)
    # group rows by base name so one file -> one canonical path
    by_base = {}
    for r in taps:
        by_base.setdefault(r['base'], []).append(r)

    entities = {}
    unattributed = {}
    for base, rows in by_base.items():
        core = core_stem(re.sub(r'\.(m4a|wav|mp3|caf)$', '', base, flags=re.I))
        hit = match(core, rows, char_ent, bldg_ent, overrides, name_ent=char_name)
        if not hit:
            unattributed[base] = {'core': core,
                                  'family': bundle_family(rows[0])}
            continue
        kind, eid, _disp, _sig = hit
        key = f'{kind}:{eid}'
        entities.setdefault(key, set()).add(pick_canonical_path(rows))

    # deterministic, sorted output
    entities_out = {k: sorted(v) for k, v in sorted(entities.items())}
    result = {'generated': date.today().isoformat(),
              'entities': entities_out}

    print(f'{len(by_base)} distinct tap base names, '
          f'{len(entities_out)} entities with sound '
          f'({sum(1 for k in entities_out if k.startswith("c:"))} characters, '
          f'{sum(1 for k in entities_out if k.startswith("b:"))} buildings), '
          f'{len(unattributed)} unattributed')

    if a.report:
        os.makedirs(os.path.dirname(os.path.abspath(a.report)), exist_ok=True)
        with open(a.report, 'w', encoding='utf-8') as f:
            json.dump({'unattributed': dict(sorted(unattributed.items()))},
                      f, indent=1)
        print(f'report: {a.report}')

    if a.verbose:
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
