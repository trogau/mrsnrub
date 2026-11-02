#!/usr/bin/env python3
"""Compare decoded descriptor-pool schema (re/proto_files.json) against the
fan server's .proto sources (server/source/server/protobufs/).

Rough text parse of .proto (good enough for name/number comparison).
"""
import json, os, re, sys

POOL = "re/proto_files.json"
SRC = "server/source/server/protobufs"

def parse_proto_text(path):
    """Return {message_name: {field_name: number}} + {enum_name: {val: num}}.
    Nested messages keyed 'Outer.Inner'."""
    txt = open(path).read()
    # strip comments
    txt = re.sub(r'//.*', '', txt)
    txt = re.sub(r'/\*.*?\*/', '', txt, flags=re.S)
    msgs, enums = {}, {}
    stack = []  # open blocks: list of ('msg'|'enum', name)
    for line in txt.splitlines():
        s = line.strip()
        mm = re.match(r'^message\s+(\w+)\s*\{?\s*$', s)
        if mm:
            stack.append(('msg', mm.group(1)))
            continue
        em = re.match(r'^enum\s+(\w+)\s*\{?\s*$', s)
        if em:
            stack.append(('enum', em.group(1)))
            continue
        if s.startswith('}'):
            if stack:
                stack.pop()
            continue
        if not stack:
            continue
        # full path = msg names only (enums don't nest other msgs/enums here)
        path = '.'.join(n for k, n in stack if k == 'msg')
        kind, leaf = stack[-1]
        if kind == 'msg':
            # proto3 fields carry no label; proto2 has repeated/optional/required
            fm = re.match(r'^(?:(?:repeated|optional|required)\s+)?([\w.]+)\s+(\w+)\s*=\s*(\d+)', s)
            if fm:
                msgs.setdefault(path, {})[fm.group(2)] = (int(fm.group(3)), fm.group(1))
        elif kind == 'enum':
            ev = re.match(r'^(\w+)\s*=\s*(\d+)\s*;', s)
            if ev:
                enums.setdefault(path + '.' + leaf, {})[ev.group(1)] = int(ev.group(2))
    return msgs, enums

def pool_msgs(fd):
    """Flatten pool file descriptor to {name: {field: (num, type)}} + enums.
    NOTE: 'nested' message names in proto_files.json are ALREADY fully
    qualified ('Outer.Inner'), so use them as-is (no prefix)."""
    msgs, enums = {}, {}
    def walk(m, full):
        flds = {}
        for f in m.get('fields', []):
            tn = f.get('type_name') or f.get('type') or ''
            flds[f.get('name', '?')] = (f.get('number'), tn)
        msgs[full] = flds
        for e in m.get('enums', []):
            enums[full + '.' + e.get('name', '?')] = e.get('values', [])
        for nm in m.get('nested', []):
            walk(nm, nm.get('name', '?'))
    for m in fd.get('messages', []):
        walk(m, m.get('name', '?'))
    for e in fd.get('enums', []):
        enums[e.get('name', '?')] = e.get('values', [])
    return msgs, enums

pool = json.load(open(POOL))
total_missing_msgs = total_missing_fields = total_bad_fields = total_extra_fields = 0
files_report = []
for fd in pool:
    fn = fd.get('file')
    if not fn or fn.startswith('google/'):
        continue
    src_path = os.path.join(SRC, fn)
    if not os.path.exists(src_path):
        files_report.append((fn, 'MISSING ON SERVER', '', ''))
        continue
    src_msgs, src_enums = parse_proto_text(src_path)
    pm, pe = pool_msgs(fd)
    missing_msgs = [m for m in src_msgs if m not in pm]
    extra_msgs = [m for m in pm if m not in src_msgs]
    missing_f = bad_f = extra_f = 0
    details = []
    for m, flds in src_msgs.items():
        if m not in pm:
            continue
        for f, (num, typ) in flds.items():
            if f not in pm[m]:
                missing_f += 1
                if len(details) < 4:
                    details.append(f"field {m}.{f}={num} not in pool")
            else:
                pnum, ptyp = pm[m][f]
                if pnum != num:
                    bad_f += 1
                    if len(details) < 4:
                        details.append(f"num {m}.{f}: pool={pnum} src={num}")
    for m, flds in pm.items():
        if m not in src_msgs:
            continue
        for f, (pnum, ptyp) in flds.items():
            if f not in src_msgs[m]:
                extra_f += 1
                if len(details) < 8:
                    details.append(f"pool-only field {m}.{f}={pnum}")
    total_missing_msgs += len(missing_msgs)
    total_missing_fields += missing_f
    total_bad_fields += bad_f
    total_extra_fields += extra_f
    files_report.append((fn, f"{len(pm)} msgs",
                         f"missing: {missing_msgs if missing_msgs else '-'}",
                         f"extra: {extra_msgs if extra_msgs else '-'}; field issues: {missing_f} missing/{bad_f} num-mismatch/{extra_f} pool-only" + ("; " + "; ".join(details) if details else "")))

print(f"{'file':<28} {'pool':<10} server-side diff")
for fn, p, ms, ex in files_report:
    print(f"{fn:<28} {p:<10} {ms} | {ex}")
print()
print(f"TOTAL: {total_missing_msgs} messages missing from pool, "
      f"{total_missing_fields} fields missing, {total_bad_fields} number mismatches, "
      f"{total_extra_fields} pool-only fields")
