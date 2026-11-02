#!/usr/bin/env python3
"""Reconstruct FileDescriptorProto blobs from libscorpio.so's protodesc_cold section.

Pure stdlib. Scans for 0x0a <len> '<name>.proto' anchors, walks each blob
deterministically (LEN fields skip their length, varints skip their varint),
then recursively decodes FileDescriptorProto -> package/messages/fields/enums.
"""
import json, sys

SO = "/tmp/opencode/apk/libscorpio.so"
OFF = 0x45D868
SZ = 0xF76C

data = open(SO, "rb").read()
sec = data[OFF:OFF + SZ]

# ---------- minimal protobuf wire reader ----------
def read_varint(buf, pos):
    v = 0; sh = 0
    while True:
        b = buf[pos]; pos += 1
        v |= (b & 0x7F) << sh
        if not b & 0x80:
            return v, pos
        sh += 7
        if sh > 63:
            raise ValueError("varint too long")

def walk(buf, pos, end):
    """Yield (field_no, wire_type, value_or_vp, ve, next_pos)."""
    while pos < end:
        tag, pos = read_varint(buf, pos)
        if tag == 0:
            raise ValueError("zero tag")
        fn, wt = tag >> 3, tag & 7
        if wt == 0:
            v, pos = read_varint(buf, pos)
            yield fn, wt, v, None, pos
        elif wt == 1:
            pos += 8
            yield fn, wt, pos - 8, pos, pos
        elif wt == 2:
            ln, vp = read_varint(buf, pos)
            if vp + ln > end:
                raise ValueError("bad len")
            pos = vp + ln
            yield fn, wt, vp, vp + ln, pos
        elif wt == 5:
            pos += 4
            yield fn, wt, pos - 4, pos, pos
        else:
            raise ValueError(f"wire type {wt}")

def parse_msg(buf, pos, end):
    """Generic: return list of (field_no, wire_type, value). Stops at first bad tag."""
    out = []
    try:
        for fn, wt, v, ve, pos in walk(buf, pos, end):
            if wt == 0:
                out.append((fn, "varint", v))
            elif wt == 2:
                out.append((fn, "bytes", buf[v:ve]))
            else:
                out.append((fn, "raw", bytes(buf[v:ve])))
    except Exception:
        pass
    return out

# FieldDescriptorProto.Type enum (descriptor.proto)
TYPE_NAMES = {1:"double",2:"float",3:"int64",4:"uint64",5:"int32",6:"fixed64",
              7:"fixed32",8:"bool",9:"string",10:"group",11:"message",12:"bytes",
              13:"uint32",14:"enum",15:"sfixed32",16:"sfixed64",17:"sint32",18:"sint64"}
LABEL_NAMES = {1:"optional",2:"required",3:"repeated"}

def s(b):
    return b.decode("utf-8", "replace")

def v_of(fields, no, default=None):
    """First varint value for field no, or default."""
    for fn, kind, v in fields:
        if fn == no and kind == "varint":
            return v
    return default

def b_of(fields, no, default=b""):
    for fn, kind, v in fields:
        if fn == no and kind == "bytes":
            return v
    return default

def parse_field_desc(v):
    f = parse_msg(v, 0, len(v))
    num = v_of(f, 3)
    label = v_of(f, 4)
    typ = v_of(f, 5)
    tname = b_of(f, 6)
    return {
        "name": s(b_of(f, 1)),
        "number": num,
        "label": LABEL_NAMES.get(label, str(label)),
        "type": TYPE_NAMES.get(typ, str(typ)),
        "type_name": s(tname) if tname else None,
    }

def parse_enum_desc(v):
    f = parse_msg(v, 0, len(v))
    vals = []
    for fn, kind, val in f:
        if fn == 2 and kind == "bytes":
            try:
                sub = parse_msg(val, 0, len(val))
                vn = s(b_of(sub, 1))
                num = v_of(sub, 2)
                vals.append(f"{vn}={num}")
            except Exception:
                vals.append(s(val))
    return {"name": s(b_of(f, 1)), "values": vals}

def parse_msg_desc(v, prefix=""):
    f = parse_msg(v, 0, len(v))
    name = s(b_of(f, 1))
    full = f"{prefix}{name}"
    msg = {"name": full}
    fields = []
    for fn, kind, val in f:
        if fn == 2 and kind == "bytes":
            try:
                fields.append(parse_field_desc(val))
            except Exception as e:
                fields.append({"error": str(e)})
    if fields:
        msg["fields"] = fields
    nested = []
    for fn, kind, val in f:
        if fn == 3 and kind == "bytes":
            try:
                nested.append(parse_msg_desc(val, full + "."))
            except Exception as e:
                nested.append({"error": str(e)})
    if nested:
        msg["nested"] = nested
    enums = []
    for fn, kind, val in f:
        if fn == 4 and kind == "bytes":
            try:
                enums.append(parse_enum_desc(val))
            except Exception as e:
                enums.append({"error": str(e)})
    if enums:
        msg["enums"] = enums
    return msg

def parse_file_desc(v):
    f = parse_msg(v, 0, len(v))
    out = {
        "file": s(b_of(f, 1)),
        "package": s(b_of(f, 2)),
        "dependencies": [s(d) for fn, kind, d in f if fn == 3 and kind == "bytes"],
        "messages": [],
        "enums": [],
    }
    for fn, kind, val in f:
        if fn == 4 and kind == "bytes":
            try:
                out["messages"].append(parse_msg_desc(val))
            except Exception as e:
                out["messages"].append({"error": str(e)})
        elif fn == 5 and kind == "bytes":
            try:
                out["enums"].append(parse_enum_desc(val))
            except Exception as e:
                out["enums"].append({"error": str(e)})
    return out

# ---------- scan for FileDescriptorProto anchors ----------
anchors = []
pos = 0
n = len(sec)
while pos < n - 2:
    if sec[pos] == 0x0A:
        try:
            ln, p2 = read_varint(sec, pos + 1)
        except Exception:
            pos += 1
            continue
        if 4 <= ln <= 0x4000 and p2 + ln <= n:
            cand = sec[p2:p2 + ln]
            if cand.endswith(b".proto") and len(cand) >= 5 and \
               all(32 <= b < 127 for b in cand):
                anchors.append(pos)
                pos = p2 + ln
                continue
    pos += 1

print(f"anchors: {len(anchors)}", file=sys.stderr)

seen = set()
files = []
for i, a in enumerate(anchors):
    # candidate span: up to the next anchor (or section end)
    end = anchors[i + 1] if i + 1 < len(anchors) else n
    # verify by walking: must consume exactly to `end`
    ok, last_end = True, a
    try:
        for fn, wt, v, ve, pos in walk(sec, a, end):
            last_end = pos
        if last_end != end:
            # not tight: fall back to violation stop
            ok = False
    except Exception:
        ok = False
    if not ok:
        # walk until field-number regression / bad tag
        last_end = a
        prev = 0
        p = a
        while p < end:
            try:
                tag, p2 = read_varint(sec, p)
            except Exception:
                break
            fn, wt = tag >> 3, tag & 7
            if wt in (3, 4) or fn > 20 or fn < prev:
                break
            prev = fn
            if wt == 0:
                p = read_varint(sec, p2)[1]
            elif wt == 1:
                p = p2 + 8
            elif wt == 2:
                ln, p2b = read_varint(sec, p2)
                p = p2b + ln
            elif wt == 5:
                p = p2 + 4
            else:
                break
        last_end = p
    span = sec[a:last_end]
    key = span[:256]
    if key in seen:
        continue
    seen.add(key)
    files.append(parse_file_desc(span))

json.dump(files, open("/tmp/opencode/rz/proto_files.json", "w"), indent=1)
print(f"parsed {len(files)} file descriptors", file=sys.stderr)
for fd in files:
    print(f"  {fd.get('file','?'):<38} pkg={fd.get('package',''):<50} msgs={len(fd.get('messages',[]))} deps={fd.get('dependencies')}")
