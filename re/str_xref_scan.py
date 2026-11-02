#!/usr/bin/env python3
"""Find which code references which .rodata strings in the AArch64
libscorpio.so, WITHOUT a rizin analysis pass.

Technique: one linear pass over .text decoding
  - ADRP   (insn & 0x9F000000 == 0x90000000)  -> page = pc_page + sext21 << 12
  - ADD Xd, Xn, #imm12          (insn & 0xFFC00000 == 0x91000000)
  - ADD Xd, Xn, #imm12, LSL #12 (insn & 0xFFC00000 == 0x91400000)
tracking the last ADRP page written to each register. Every ADD whose
operand register holds a page yields a candidate data target; targets are
bucketed by address. .rodata C-strings whose START address has at least one
candidate are reported, with the xref PC(s) mapped to the enclosing
function (via a rizin `aflj` dump, if provided).

Verified against rizin's disassembler on sample instructions (ADRP page and
ADD immediate match exactly). Caveats: references materialized by other
instruction forms (ADRP + LDR pair, PC-relative LDR literals, computed
addresses) are not captured; a string referenced only mid-run (not at its
NUL-start) won't match, though in practice endpoints are whole strings.

Usage:  python3 re/str_xref_scan.py [path/to/libscorpio.so] [aflj.json]
Writes re/str_xrefs.tsv (string_vaddr, string, xref_pc, function; the string
field is backslash-escaped for tabs/newlines) and prints a per-function
summary of interesting strings.
"""
import json, os, struct, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SO = sys.argv[1] if len(sys.argv) > 1 else '/tmp/opencode/apk/libscorpio.so'
FUNCMAP = sys.argv[2] if len(sys.argv) > 2 else '/tmp/opencode/rz/funcmap.json'

# .text layout (arm64 libscorpio.so; see notes/05-game-logic.md). Adjust if
# re-extracting a different arch variant (v7a is 32-bit and needs a separate
# scanner; the other arm64 variant shares this layout).
TEXT_VA, TEXT_LEN = 0x6e5000, 0x12d8d04
RODATA_VA, RODATA_LEN = 0x34bbd0, 0x111c98

def load_phdr_map(data):
    e_phoff = struct.unpack_from('<Q', data, 32)[0]
    e_phentsize = struct.unpack_from('<H', data, 54)[0]
    e_phnum = struct.unpack_from('<H', data, 56)[0]
    segs = []
    for i in range(e_phnum):
        off = e_phoff + i * e_phentsize
        p_type, _flags = struct.unpack_from('<II', data, off)
        p_offset, p_paddr, p_vaddr, p_filesz = struct.unpack_from('<QQQQ', data, off + 8)
        segs.append((p_type, p_offset, p_vaddr, p_filesz))
    return segs

def slice_at(data, segs, va, size):
    for p_type, p_offset, p_vaddr, p_filesz in segs:
        if p_type == 1 and p_vaddr <= va < p_vaddr + p_filesz:
            start = p_offset + (va - p_vaddr)
            return data[start : start + size]
    raise ValueError(f'no PT_LOAD covering 0x{va:x}')

def scan_adrp_add(data, segs):
    """Return {target_vaddr: [pc, ...]} for all ADRP+ADD materializations."""
    text = slice_at(data, segs, TEXT_VA, TEXT_LEN)
    targets = {}
    last_adrp = {}
    n = len(text) // 4
    for i in range(n):
        insn = struct.unpack_from('<I', text, i * 4)[0]
        pc = TEXT_VA + i * 4
        if (insn & 0x9F000000) == 0x90000000:          # ADRP Xd, Xn, #imm21
            immlo = (insn >> 29) & 0x3
            immhi = (insn >> 5) & 0x7FFFF
            imm21 = (immhi << 2) | immlo
            if imm21 & (1 << 20):
                imm21 -= 1 << 21
            rd = insn & 0x1F
            last_adrp[rd] = (pc & ~0xFFF) + (imm21 << 12)
        elif (insn & 0xFFC00000) == 0x91000000:        # ADD Xd, Xn, #imm12
            imm = (insn >> 10) & 0xFFF
            page = last_adrp.get((insn >> 5) & 0x1F)
            if page is not None:
                targets.setdefault(page + imm, []).append(pc)
        elif (insn & 0xFFC00000) == 0x91400000:        # ADD Xd, Xn, #imm12, LSL #12
            imm = ((insn >> 10) & 0xFFF) << 12
            page = last_adrp.get((insn >> 5) & 0x1F)
            if page is not None:
                targets.setdefault(page + imm, []).append(pc)
    return targets

def rodata_strings(data, segs):
    """Yield (vaddr, string) for every ASCII C-string run (>=4 chars) in .rodata."""
    rd = slice_at(data, segs, RODATA_VA, RODATA_LEN)
    i, n = 0, len(rd)
    while i < n:
        j = i
        while j < n and rd[j] != 0:
            j += 1
        if j - i >= 4:
            try:
                yield RODATA_VA + i, rd[i:j].decode('ascii')
            except UnicodeDecodeError:
                pass
        i = j + 1

def load_funcs(path):
    if not os.path.exists(path):
        return []
    try:
        fms = json.load(open(path))
    except (json.JSONDecodeError, OSError):
        return []
    fns = sorted((f['offset'], f.get('name') or '?') for f in fms)
    return fns

def main():
    data = open(SO, 'rb').read()
    segs = load_phdr_map(data)
    targets = scan_adrp_add(data, segs)
    fns = load_funcs(FUNCMAP)
    import bisect
    fn_starts = [s for s, _ in fns]
    def fn_of(pc):
        if not fns:
            return ''
        k = bisect.bisect_right(fn_starts, pc) - 1
        if k >= 0:
            return fns[k][1]
        return ''

    rows = []
    for va, s in rodata_strings(data, segs):
        pcs = targets.get(va)
        if not pcs:
            continue
        for pc in pcs:
            rows.append((va, s, pc, fn_of(pc)))

    out = os.path.join(HERE, 'str_xrefs.tsv')
    with open(out, 'w') as f:
        f.write('string_vaddr\tstring\txref_pc\tfunction\n')
        for va, s, pc, fn in sorted(rows, key=lambda r: (r[3], r[2], r[0])):
            # strings may contain tabs/newlines -> escape for TSV
            ss = s.replace('\\', '\\\\').replace('\t', '\\t').replace('\n', '\\n')
            f.write(f'0x{va:x}\t{ss}\t0x{pc:x}\t{fn}\n')

    # per-function summary of interesting strings
    interesting = (lambda s: any(k in s for k in (
        '/games/', 'protoland', 'protocurrency', 'checkToken', 'upgradeland',
        'dlc', 'cdn.', 'login', 'Login', 'auth', 'nimble', 'token')))
    byfn = {}
    for va, s, pc, fn in rows:
        if interesting(s):
            byfn.setdefault(fn or '?', set()).add(s)
    print(f'# {len(rows)} string xref rows -> {out}')
    for fn in sorted(byfn):
        ss = sorted(byfn[fn])
        print(f'== {fn} ({len(ss)} interesting strings)')
        for s in ss[:12]:
            print(f'   {s}')
        if len(ss) > 12:
            print(f'   ... +{len(ss)-12} more')

if __name__ == '__main__':
    main()
