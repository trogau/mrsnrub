#!/usr/bin/env python3
"""Generic protobuf walker for reverse-engineering unknown .pb files.

Usage:
  python3 proto_walk.py <file>             # structural overview + per-field stats

Walks the file recursively: at every nesting level it tallies field numbers,
wire types, occurrence counts, varint ranges, string samples, and length
histograms — enough to eyeball the schema of an unknown message.
"""
import sys
import struct
import collections

def read_varint(buf, i):
    v = 0
    s = 0
    while True:
        b = buf[i]
        i += 1
        v |= (b & 0x7F) << s
        s += 7
        if not (b & 0x80):
            return v, i

def is_probable_string(buf, i, ln):
    if ln <= 0:
        return False
    chunk = buf[i:i + ln]
    if b'\x00' in chunk:
        return False
    ok = sum(1 for b in chunk if 9 <= b < 127)
    return ok / ln >= 0.95

WT_NAMES = {0: 'varint', 1: '64bit', 2: 'bytes', 5: '32bit'}

def parse_region(buf, off, end):
    """Parse a message region. Returns (fieldlist, ok).

    fieldlist = list of (field, wtype, value|None, child_stats|None, child_ok)
    """
    fields = []
    i = off
    n = 0
    while i < end:
        tag, i2 = read_varint(buf, i)
        field = tag >> 3
        wt = tag & 7
        n += 1
        if field == 0 or field > 1500 or i2 > end:
            return fields, False
        if wt == 0:
            v, i3 = read_varint(buf, i2)
            if i3 > end:
                return fields, False
            fields.append((field, wt, v, None, None))
            i = i3
        elif wt == 2:
            ln, i3 = read_varint(buf, i2)
            if i3 + ln > end:
                return fields, False
            is_str = is_probable_string(buf, i3, ln)
            fields.append((field, wt, ln if not is_str else None,
                           (buf[i3:i3 + ln]) if not is_str else
                           buf[i3:i3 + ln].decode('latin1'), None))
            i = i3 + ln
        elif wt == 5:
            if i2 + 4 > end:
                return fields, False
            fields.append((field, wt, struct.unpack_from('<I', buf, i2)[0], None, None))
            i = i2 + 4
        elif wt == 1:
            if i2 + 8 > end:
                return fields, False
            fields.append((field, wt, struct.unpack_from('<Q', buf, i2)[0], None, None))
            i = i2 + 8
        else:
            return fields, False
        if n > 1_000_000:
            return fields, False
    return fields, True

def summarize(buf, off, end, depth, label, max_depth=4):
    """Recursive structural summary with per-field stats."""
    fields, ok = parse_region(buf, off, end)
    if not ok:
        print(f"{label}: NOT a clean message (stopped early)")
        return
    # group consecutive-ish stats by (field, wt)
    groups = collections.OrderedDict()
    for field, wt, val, blob, _ in fields:
        g = groups.setdefault((field, wt), {
            'n': 0, 'min': None, 'max': None, 'lens': [], 'strs': collections.Counter(),
            'blob_lens': []})
        g['n'] += 1
        if wt == 0:
            g['min'] = val if g['min'] is None else min(g['min'], val)
            g['max'] = val if g['max'] is None else max(g['max'], val)
        elif wt == 2:
            if isinstance(blob, str):
                s = blob if len(blob) <= 40 else blob[:37] + '…'
                g['strs'][s] += 1
            else:
                g['blob_lens'].append(blob)
        elif wt in (5, 1):
            g['min'] = val if g['min'] is None else min(g['min'], val)
            g['max'] = val if g['max'] is None else max(g['max'], val)

    for (field, wt), g in groups.items():
        parts = []
        if g['min'] is not None:
            parts.append(f"range {g['min']}…{g['max']}")
        if g['strs']:
            top = ', '.join(f"{s!r}×{c}" for s, c in g['strs'].most_common(8))
            more = f" (+{len(g['strs'])-8} kinds)" if len(g['strs']) > 8 else ''
            parts.append(f"strings: {top}{more}")
        # length histogram for nested messages
        lens = collections.Counter(len(b) for b in g['blob_lens'])
        if lens:
            top = ', '.join(f"{l}×{c}" for l, c in lens.most_common(6))
            more = f" (+{len(lens)-6} sizes)" if len(lens) > 6 else ''
            parts.append(f"lens: {top}{more}")
        # recurse into nested messages of interesting sizes
        if wt == 2 and depth < max_depth:
            # look at the first blob that is NOT a probable string
            for b in g['blob_lens'][:1]:
                subf, subok = parse_region(b, 0, len(b))
                if subok and len(subf) > 0 and subf != [(0, 0, 0, None, None)]:
                    # count how many distinct field numbers inside
                    fnums = collections.Counter(f for f, *_ in subf)
                    parts.append(f"nested: fields {dict(fnums.most_common(12))}")
                    # recurse once more if this nested type is consistent
                    if depth + 1 < max_depth:
                        n2 = len(g['blob_lens'])
                        print(f"{'  ' * depth}- (first of {n2})")
                        # only recurse if every blob parses the same way
                        consistent = True
                        first_fn = [f for f, *_ in subf]
                        for b2 in g['blob_lens'][1:4]:
                            sf2, ok2 = parse_region(b2, 0, len(b2))
                            if not ok2 or [f for f, *_ in sf2] != first_fn:
                                consistent = False
                                break
                        if consistent:
                            summarize(b, 0, len(b), depth + 1, '', max_depth)
                    break
        print(f"{'  ' * depth}· f{field} {WT_NAMES.get(wt, wt)} ×{g['n']}  {'; '.join(parts)}")

def main():
    path = sys.argv[1]
    max_depth = 4
    buf = open(path, 'rb').read()
    print(f"file: {path}  ({len(buf)} bytes)\n")
    summarize(buf, 0, len(buf), 0, 'top', max_depth)

if __name__ == '__main__':
    main()
