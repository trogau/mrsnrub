#!/usr/bin/env python3
"""Decode a TSTO LandMessage (.pb city save) using the schema in re/proto_schema.txt.

Usage:
  python3 land_pb.py <file.pb>
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

# ---------------------------------------------------------------- protobuf
def parse_msg(buf, off, end):
    """Parse message region -> dict field -> list of values (bytes blobs kept raw)."""
    out = collections.defaultdict(list)
    order = []
    i = off
    while i < end:
        tag, i2 = read_varint(buf, i)
        field, wt = tag >> 3, tag & 7
        if wt == 0:
            v, i = read_varint(buf, i2)
        elif wt == 2:
            ln, i3 = read_varint(buf, i2)
            v = bytes(buf[i3:i3 + ln])
            i = i3 + ln
        elif wt == 5:
            v = struct.unpack_from('<f', buf, i2)[0]
            i = i2 + 4
        elif wt == 1:
            v = struct.unpack_from('<d', buf, i2)[0]
            i = i2 + 8
        else:
            raise ValueError(f"wire type {wt} at {i}")
        out[field].append(v)
        order.append(field)
    return out, order

def s(b):
    return b.decode('utf-8', 'replace')

def as_int64(v):
    return v - (1 << 64) if v >= (1 << 63) else v

# ------------------------------------------------- LandMessage field tables
# (name, kind) — kind: 'str','msg','varint','float','double','bool'
LAND_FIELDS = {
    1: ('id', 'str'), 2: ('friendData', 'msg'), 3: ('userData', 'msg'),
    4: ('innerLandData', 'msg'), 5: ('roadsData', 'msg'), 6: ('riversData', 'msg'),
    7: ('buildingData', 'msg'), 8: ('characterData', 'msg'), 9: ('consumableData', 'msg'),
    10: ('jobData', 'msg'), 11: ('questData', 'msg'), 12: ('notificationData', 'msg'),
    13: ('inventoryItemData', 'msg'), 14: ('memorabiliaItemData', 'msg'),
    15: ('premiumUnlockItemData', 'msg'), 16: ('eventCountListData', 'msg'),
    17: ('actionLimitData', 'msg'), 18: ('sidebarData', 'msg'), 19: ('characterSetsData', 'msg'),
    20: ('pushNotificationsData', 'msg'), 21: ('timedScriptData', 'msg'),
    22: ('bonusUnlocksData', 'msg'), 23: ('characterUnlocksData', 'msg'),
    24: ('skinUnlocksData', 'msg'), 25: ('delayedActionData', 'msg'),
    26: ('spendablesData', 'msg'), 27: ('specialEventsData', 'msg'),
    28: ('fakeFriendData', 'msg'), 29: ('questGroupData', 'msg'),
    30: ('purchases', 'msg'), 31: ('processedPurchaseData', 'msg'),
    32: ('customFriendActionData', 'msg'), 33: ('debugLand', 'bool'),
    34: ('oceanData', 'msg'), 35: ('gameObjectInfo', 'msg'), 36: ('subLandData', 'msg'),
    37: ('minigameData', 'msg'), 38: ('stealableBuildingData', 'msg'),
    39: ('collectionItemsData', 'msg'), 40: ('friendListData', 'msg'),
    41: ('allFriendActionsCount', 'msg'), 42: ('friendListDataIsCreatedAndSaved', 'bool'),
    43: ('objectVariables', 'msg'), 44: ('recommendations', 'msg'),
    45: ('amazonDimensionSet', 'msg'), 46: ('dailyTaskDataList', 'msg'),
    47: ('roadMapDataMessage', 'msg'), 48: ('adHocObjectData', 'msg'),
    49: ('countryCode', 'str'), 50: ('timerData', 'msg'),
    51: ('jobCensusDataMessage', 'msg'), 52: ('dnaMessage', 'msg'),
    53: ('groupStorageBundleMessage', 'msg'),
}

def get(msg, field):
    return msg.get(field, [None])[0]

def flat(msg):
    """{field: first_value} for display."""
    return {k: v[0] for k, v in msg.items()}

def show(label, value):
    print(f"    {label}: {value!r}" if isinstance(value, str) else f"    {label}: {value}")

def main():
    path = sys.argv[1]
    buf = open(path, 'rb').read()
    top, order = parse_msg(buf, 0, len(buf))
    print(f"== LandMessage ({len(buf)} bytes, {len(order)} top-level fields, "
          f"EOF clean) ==\n")

    # --- identity
    print(f"id            : {get(top, 1) and s(get(top, 1))}")
    print(f"countryCode   : {get(top, 49) and s(get(top, 49))}")
    print(f"debugLand     : {get(top, 33)}")
    print(f"friendListSaved: {get(top, 42)}")

    # --- friendData
    fr = top[2][0]
    f, _ = parse_msg(fr, 0, len(fr))
    print(f"\nfriendData:")
    show("name (town name)", s(f[5][0]))
    show("level", f[4][0])
    show("rating", f[6][0])
    show("dataVersion", f[1][0])
    show("sublandInfos", [flat(parse_msg(x, 0, len(x))[0]) for x in f[9]])
    show("boardwalkTileCount", f[10][0])
    import datetime
    ts = f[11][0]
    show("lastPlayedTime", f"{ts} ({datetime.datetime.fromtimestamp(ts, datetime.timezone.utc):%Y-%m-%d %H:%M UTC})")
    sp = f.get(7, [])
    spend = collections.Counter(flat(parse_msg(x, 0, len(x))[0]).get(1) for x in sp)
    show("spendables (count)", len(sp))
    show("spendable type histogram", dict(spend.most_common(10)))

    # --- userData
    ud = top[3][0]
    u, _ = parse_msg(ud, 0, len(ud))
    print(f"\nuserData ({len(ud)}B, fields {sorted(u)}):")
    for k in sorted(u):
        v = u[k][0]
        if isinstance(v, bytes):
            sub, _ = parse_msg(v, 0, len(v))
            show(f"f{k}", f"msg({len(v)}B) fields {sorted(sub)}")
        else:
            show(f"f{k}", as_int64(v) if k in (17, 18, 19, 20, 22, 23, 24) else v)

    # --- innerLandData + cross-check
    il = top[4][0]
    n, _ = parse_msg(il, 0, len(il))
    hdr2, _ = parse_msg(n[1][0], 0, len(n[1][0]))
    print(f"\ninnerLandData ({len(il)}B):")
    show("header id", hdr2[1][0])
    lb = s(n[2][0])
    show("landBlocks", f"'{lb[:60]}…' (len {len(lb)})" if len(lb) > 60 else f"'{lb}'")
    show("nextInstanceID", n[3][0])
    counts = {4: 'numChars', 5: 'numBuildings', 6: 'numConsumables', 7: 'numJobs',
              8: 'numQuests', 9: 'numNotices', 10: 'numInventoryItems',
              11: 'numMemorabiliaItems', 12: 'numEventCountLists',
              13: 'numPremiumUnlocks', 14: 'numActionLimits', 25: 'nextCurrencyID',
              26: 'numQuestGroups', 32: 'numSavedFriends', 33: 'landBlockWidth',
              34: 'landBlockHeight', 35: 'landBlockPositionX', 36: 'landBlockPositionY'}
    fieldmap = {'numChars': 8, 'numBuildings': 7, 'numConsumables': 9, 'numJobs': 10,
                'numQuests': 11, 'numNotices': 12, 'numInventoryItems': 13,
                'numMemorabiliaItems': 14, 'numEventCountLists': 16,
                'numPremiumUnlocks': 15, 'numActionLimits': 17, 'numQuestGroups': 29,
                'numSavedFriends': 40}
    ok = True
    for k, name in counts.items():
        v = n[k][0]
        line = f"    {name} = {as_int64(v) if k in (35, 36) else v}"
        if name in fieldmap:
            actual = len(top.get(fieldmap[name], []))
            line += f"  (top-level count: {actual})"
            if actual != v:
                line += "  !!! MISMATCH"
                ok = False
        print(line)
    for k in (17, 18, 19, 20, 24, 29):
        if k in n:
            v = as_int64(n[k][0])
            show({17: 'updateTime', 18: 'timeSpentPlaying', 19: 'lastLevelUpSpentTime',
                  20: 'lastLevelUpTimeStamp', 24: 'lastSideshowBobSpawned',
                  29: 'creationTime'}[k],
                 f"{v} ({datetime.datetime.fromtimestamp(v, datetime.timezone.utc):%Y-%m-%d})")

    # --- terrain grids
    def terrain(tag, data):
        t, _ = parse_msg(data, 0, len(data))
        th, _ = parse_msg(t[1][0], 0, len(t[1][0]))
        grid = s(t[3][0])
        tt = t.get(4, [None])[0]
        print(f"\nterrain '{tag}': header id={th.get(1, [None])[0]} "
              f"mapDataSize={t.get(2, [None])[0]} actual grid len={len(grid)} "
              f"terrainType={tt}")
        hist = collections.Counter(grid)
        print(f"  char histogram: {dict(hist.most_common(16))}")
        return grid

    grids = {}
    if 5 in top:
        grids['roadsData(f5)'] = terrain('roadsData', top[5][0])
    if 6 in top:
        grids['riversData(f6)'] = terrain('riversData', top[6][0])
    if 34 in top:
        grids['oceanData(f34)'] = terrain('oceanData', top[34][0])
    if 47 in top:
        rm, _ = parse_msg(top[47][0], 0, len(top[47][0]))
        for i, m in enumerate(rm.get(1, [])):
            g = terrain(f'roadMap[{i}]', m)
            grids[f'roadMap[{i}]'] = g
    if 36 in top:
        sl, _ = parse_msg(top[36][0], 0, len(top[36][0]))
        show("subLandData.subLandID", sl.get(2, [None])[0])
        slb = s(sl[3][0])
        show("subLandData.landBlocks", f"'{slb[:40]}…' (len {len(slb)})")
        for i, m in enumerate(sl.get(4, [])):
            grids[f'subLand terrain[{i}]'] = terrain(f'subLand[{i}]', m)
        for k in (6, 7, 8, 9):
            if k in sl:
                show({6: 'landBlockWidth', 7: 'landBlockHeight',
                      8: 'landBlockPositionX', 9: 'landBlockPositionY'}[k],
                     as_int64(sl[k][0]))

    # ASCII render of each grid with a few candidate widths
    for name, g in grids.items():
        ln = len(g)
        cands = []
        for w in (136, 184, 200, 256, 212, 189):
            if ln % w == 0:
                cands.append(w)
        # square-ish
        import math
        r = int(math.isqrt(ln))
        for w in (r - 1, r, r + 1, r + 2):
            if w > 0 and ln % w == 0 and w not in cands:
                cands.append(w)
        print(f"\n--- render {name} (len {ln}), divisor widths: {cands}")
        if cands:
            w = cands[0]
            h = ln // w
            if h <= 200:
                for row in g[:h * w].splitlines() if '\n' in g else [g[r * w:(r + 1) * w] for r in range(h)]:
                    print('    ' + row)

    # --- buildings
    bld = top.get(7, [])
    print(f"\nbuildingData: {len(bld)} buildings")
    first = bld[0]
    b, _ = parse_msg(first, 0, len(first))
    bh, _ = parse_msg(b[1][0], 0, len(b[1][0]))
    show("first building header (instanceID)", bh[1][0])
    show("building defID", b[2][0])
    show("creationTime", f"{as_int64(b[3][0])} "
         f"({datetime.datetime.fromtimestamp(b[3][0], datetime.timezone.utc):%Y-%m-%d})")
    show("updateTime", as_int64(b[4][0]))
    show("positionX", b[5][0])
    show("positionY", b[6][0])
    if 7 in b: show("flipped", b[7][0])
    if 8 in b: show("buildState", b[8][0])
    ids = collections.Counter()
    states = collections.Counter()
    subs = collections.Counter()
    xs, ys = [], []
    for m in bld:
        bb, _ = parse_msg(m, 0, len(m))
        ids[bb.get(2, [None])[0]] += 1
        states[bb.get(8, [0])[0]] += 1
        subs[bb.get(23, [0])[0]] += 1
        if 5 in bb: xs.append(bb[5][0])
        if 6 in bb: ys.append(bb[6][0])
    print(f"  defID histogram (top 15): {dict(ids.most_common(15))}")
    print(f"  buildState histogram: {dict(states.most_common(10))}")
    print(f"  subLandID histogram: {dict(subs.most_common(10))}")
    print(f"  positionX range: {min(xs)}…{max(xs)}   positionY range: {min(ys)}…{max(ys)}")

    # --- characters
    chars = top.get(8, [])
    print(f"\ncharacterData: {len(chars)} characters")
    cids = collections.Counter()
    for m in chars:
        c, _ = parse_msg(m, 0, len(m))
        cids[c.get(2, [None])[0]] += 1
    print(f"  character defID histogram (top 20): {dict(cids.most_common(20))}")
    c0, _ = parse_msg(chars[0], 0, len(chars[0]))
    ch0, _ = parse_msg(c0[1][0], 0, len(c0[1][0]))
    show("first char header (instanceID)", ch0[1][0])
    show("first char defID", c0.get(2, [None])[0])
    if 4 in c0: show("positionX", c0[4][0])
    if 5 in c0: show("positionY", c0[5][0])

    # --- jobs / quests sample
    jobs = top.get(10, [])
    j0, _ = parse_msg(jobs[0], 0, len(jobs[0]))
    print(f"\njobData: {len(jobs)}; first: "
          f"job={j0.get(2, [None])[0]} charRef={j0.get(3, [None])[0]} "
          f"buildingRef={j0.get(4, [None])[0]} state={j0.get(6, [None])[0]} "
          f"grid=({j0.get(12, [None])[0]},{j0.get(13, [None])[0]})")
    quests = top.get(11, [])
    qstate = collections.Counter()
    for m in quests:
        q, _ = parse_msg(m, 0, len(m))
        qstate[q.get(3, [0])[0]] += 1
    print(f"questData: {len(quests)}; questState histogram: {dict(qstate.most_common(10))}")
    q0, _ = parse_msg(quests[0], 0, len(quests[0]))
    show("first quest", f"id={q0.get(2, [None])[0]} state={q0.get(3, [None])[0]} "
         f"timesCompleted={q0.get(7, [None])[0]} objectives={len(q0.get(6, []))}")

    # --- character sets
    cs = top.get(19, [])
    if cs:
        csm, _ = parse_msg(cs[0], 0, len(cs[0]))
        sets = [dict(parse_msg(x, 0, len(x))[0]) for x in csm.get(3, [])]
        print(f"\ncharacterSetsData: {len(sets)} sets "
              f"(numCompleteSets={csm.get(2, [None])[0]})")
        print("  first 25: " + ', '.join(s(x.get(2, b'')) for x in sets[:25]))

    # --- objectVariables sample
    ov = top.get(43, [])
    if ov:
        ovv, _ = parse_msg(ov[0], 0, len(ov[0]))
        varset, _ = parse_msg(ovv[1][0], 0, len(ovv[1][0]))
        names = [s(v[1][0]) for v in varset.get(1, [])]
        print(f"\nobjectVariables: {len(names)} entries")
        print("  sample: " + ', '.join(names[:20]))

    # --- friend list
    fl = top.get(40, [])
    if fl:
        for m in fl:
            fm, _ = parse_msg(m, 0, len(m))
            print(f"\nsaved friend: id={s(fm[2][0])} hideInMap={fm.get(3, [0])[0]} "
                  f"visited={fm.get(4, [0])[0]} isOrigin={fm.get(5, [0])[0]}")

    # --- misc small ones
    if 28 in top:
        ff, _ = parse_msg(top[28][0], 0, len(top[28][0]))
        print(f"\nfakeFriendData: townLevel={ff.get(2, [None])[0]} "
              f"building='{s(ff.get(4, [b''])[0])}' actionType='{s(ff.get(6, [b''])[0])}' "
              f"actionTime='{s(ff.get(8, [b''])[0])}'")
    if 37 in top:
        print(f"\nminigameData: {len(top[37])}")
    if 35 in top:
        go, _ = parse_msg(top[35][0], 0, len(top[35][0]))
        gos = go.get(2, [])
        types = collections.Counter(flat(parse_msg(x, 0, len(x))[0]).get(2, 0) for x in gos)
        print(f"gameObjectInfo: {len(gos)} game objects; type histogram "
              f"(top 10): {dict(types.most_common(10))}")
    if 48 in top:
        print(f"adHocObjectData: {len(top[48])}")
    if 53 in top:
        gs, _ = parse_msg(top[53][0], 0, len(top[53][0]))
        bundles = gs.get(1, [])
        print(f"groupStorageBundleMessage: {len(bundles)} storage bundles")

if __name__ == '__main__':
    main()
