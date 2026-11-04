#!/usr/bin/env python3
"""Keep the shipped character cards honest about their cells, cheaply.

  python3 tools/char_family_relabel.py kinds [--dry-run]
      Rewrite the `kind` of every cell in
      web/assets/characters/families/<cid>.json using the generator's own
      rule (gen_city_sprites.char_cell_kind, IMPORTED — not copied, so the
      two cannot drift).

      Why this exists: a cell is filed under its ROLE-STRIPPED stem, and the
      rule used to be handed that key alone. '<name>_front_walk' therefore
      arrived as key='<name>_front', role='walk' with no kind word left in
      it, and fell through to the distinct-frame fallback — 3 156 walking
      cycles and 213 '_idle' loops were labelled 'action'. The viewer's card
      sorts idle -> walk -> action -> poses and caps a card at 150 tiles, so
      on a 621-cell card like Homer's the plain walks never appeared at all:
      the "some of the animations might be missing" report, with the art
      sitting on disk the whole time.

      The re-label is metadata-only and EXACTLY what a full `chars` batch run
      would write. `distinct` (how many visually different frames a cell has,
      which decides kind-vs-standby) is recoverable from the label already in
      the file, because only three outcomes are reachable:
        'misc'        -> distinct 0     (no art)
        'standby'     -> distinct 1     (a hold, not a loop)
        anything else -> distinct 2+    (a real loop)
      Frame lists, PNG names, sizes and anchors are left untouched, so no
      pixel work happens and no image the browser has cached changes shape.

  python3 tools/char_family_relabel.py ownership
      Dry run for the pass-4 ownership rule: how many skins the save places
      have no front/back walk cell on their card under the old prefix set
      (catalog name + CHAR_ALIASES target) versus the new one, which adds the
      stem of the idle art the map actually draws (a catalog name is not
      always the stem, and when they disagreed a character's own cells went to
      a costume twin of that name or to nobody). It imports the generator's
      own _char_prefixes / _char_owners / _char_card_keys, so it reports what
      pass 4 will really do. Writes nothing: the cells it finds still have to
      be RENDERED, which is a `chars` batch run.

Both subcommands read the pool; only `kinds` writes, and only the JSON
sidecars.
"""
import argparse
import collections
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

from gen_city_sprites import (CHAR_ROLE_SUFFIXES, _char_norm, _char_prefixes,  # noqa: E402
                              char_cell_kind)

FAM_DIR = ROOT / 'web' / 'assets' / 'characters' / 'families'
CHARS_JSON = ROOT / 'web' / 'assets' / 'characters' / 'characters.json'
IDS_JSON = ROOT / 'data' / 'character_ids.json'

# the locomotion vocabulary, same as bcell.php's WALK_TAILS
WALK_TAILS = ('front_walk', 'back_walk', 'front_walk_left', 'back_walk_left',
              'front_walk_right', 'back_walk_right')


def _split_role(stem):
    """the generator's own suffix split, for building a cell's identity"""
    low = stem.lower()
    for r in CHAR_ROLE_SUFFIXES:
        if low.endswith('_' + r):
            return stem[: -(len(r) + 1)], r
    return stem, ''


def _cell_id(stem_tail):
    """'<stem>_<tail>' -> the inventory key + role that cell lives under"""
    k, r = _split_role(stem_tail)
    return _char_norm(k), r


# ---------------------------------------------------------------- labels

def distinct_from_kind(kind):
    """the one piece of frame data the label already encodes (see the
    docstring): enough for char_cell_kind(), which only asks whether a cell
    is a hold (<= 1 distinct frame) or a loop"""
    if kind == 'misc':
        return 0
    if kind == 'standby':
        return 1
    return 2


def relabel_kinds(dry_run):
    files = sorted(FAM_DIR.glob('*.json'))
    if not files:
        print(f'no cards under {FAM_DIR}')
        return 1
    before, after, changed = (collections.Counter(), collections.Counter(),
                              [])
    for p in files:
        j = json.loads(p.read_text())
        dirty = False
        for c in j.get('cells') or []:
            role = c.get('role') or ''
            was = c.get('kind')
            now = char_cell_kind(c['key'], role, distinct_from_kind(was or ''))
            before[(role, was)] += 1
            after[(role, now)] += 1
            if now != was:
                c['kind'] = now
                dirty = True
        if dirty:
            changed.append(p.name)
            if not dry_run:
                p.write_text(json.dumps(j))
    verb = 'would relabel' if dry_run else 'relabelled'
    print(f'{verb} {sum(before.values())} cells in '
          f'{len(changed)}/{len(files)} cards')
    moves = [(k, before[k], after[k]) for k in set(before) | set(after)
             if before[k] != after[k]]
    if not moves:
        print('  nothing to do — every card already carries the current rule')
        return 0
    print('  moved, by the role the cell name carries:')
    for (role, kind), b, a in sorted(moves, key=lambda m: m[1] - m[2]):
        print(f'    role={role or "(none)":15s} {kind:9s} {b:5d} -> {a:5d}')
    print('  (only `kind` changed: no PNG, size or anchor touched)')
    return 0


# ---------------------------------------------------------------- ownership

def ownership():
    from gen_city_sprites import (_char_inventory, _char_owners,  # noqa: E402
                                  _char_card_keys, _char_slug_stem)
    try:
        inv, _handles = _char_inventory()      # the very inventory pass 4 walks
    except Exception as e:               # noqa: BLE001 — report, don't crash
        print(f'inventory unavailable: {e}')
        return 1
    if not inv:
        print('no .bcell cells found — extract the pool first '
              '(see gen_city_sprites.py header)')
        return 1
    cids = json.loads(IDS_JSON.read_text())
    chars = json.loads(CHARS_JSON.read_text())['characters']

    def own_walks(stem):
        """the walking cycles the pool ships under a skin's own stem"""
        return [t for t in WALK_TAILS if _cell_id(f'{stem}_{t}')[0] in inv]

    for label, slugs in (('before (name + alias only)', False),
                         ("after  (+ the map idle's stem)", True)):
        pre = _char_prefixes(cids, chars, slugs)
        owners, loose = _char_owners(inv, pre)
        gap = []
        for cid, rec in sorted(chars.items(), key=lambda kv: int(kv[0])):
            stem = _char_slug_stem(_char_norm(rec['slug']))
            want = own_walks(stem)
            if not want:
                continue
            have = set(_char_card_keys(owners, pre.get(cid, ())))
            miss = [t for t in want if _cell_id(f'{stem}_{t}')[0] not in have]
            if miss:
                gap.append((cid, rec['name'], stem, miss))
        print(f'{label:32s} {len(gap):3d} of {len(chars)} placed skins miss'
              f' their own walking cycles    ({len(loose)} loose cells)')
        for cid, name, stem, miss in gap[:6]:
            print(f'    {cid:7s} {name[:24]:24s} {stem[:28]:28s} '
                  f'missing {", ".join(miss)}')
        if len(gap) > 6:
            print(f'    … and {len(gap) - 6} more')
    print('  dry run: newly claimed cells still need a `chars` batch run to'
          ' render their PNGs')
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('what', nargs='?', default='kinds',
                    choices=['kinds', 'ownership'])
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    return relabel_kinds(a.dry_run) if a.what == 'kinds' else ownership()


if __name__ == '__main__':
    sys.exit(main())
