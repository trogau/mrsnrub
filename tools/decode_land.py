#!/usr/bin/env python3
"""Full human-readable decode of a TSTO city save (Data.LandMessage .pb file).

Uses the project's compiled protos (server-python/protofiles). Requires a
`runtime_version` shim because the generated _pb2 files were made with a newer
protoc than the system protobuf.

Usage:
  python3 tools/decode_land.py <file.pb>
"""
import sys
import os
import types
import collections
import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'server-python'))

fake = types.ModuleType('google.protobuf.runtime_version')
fake.PROTOBUF_VERSION = (4, 21, 12)
fake.ValidateProtobufRuntimeVersion = lambda *a, **k: None
class _Domain:
    PUBLIC = 1
fake.Domain = _Domain
sys.modules['google.protobuf.runtime_version'] = fake

from protofiles import LandData_pb2  # noqa: E402

UTC = datetime.timezone.utc

def ts(v):
    try:
        return datetime.datetime.fromtimestamp(v, UTC).strftime('%Y-%m-%d %H:%M')
    except (OverflowError, OSError, ValueError):
        return f'{v} (not a ts)'

def show(label, value):
    print(f'    {label}: {value}')

def terrain_grid(t, label):
    grid = t.mapData
    tt = t.terrainType
    name = t.TerrainType.Name(tt)
    print(f"  terrain '{label}': type={tt} ({name}) header_id={t.header.id} "
          f"mapDataSize={t.mapDataSize} grid_len={len(grid)}")
    hist = collections.Counter(grid)
    top = ', '.join(f"{c!r}×{n}" for c, n in hist.most_common(20))
    print(f"    chars: {top}")
    return grid

def render(grid, width, label, limit=200):
    if len(grid) % width:
        print(f"  render {label}: width {width} does not divide {len(grid)}")
        return
    h = len(grid) // width
    print(f"  --- {label} as {width}×{h} ---")
    for r in range(min(h, limit)):
        print('    ' + grid[r * width:(r + 1) * width])

def main():
    path = sys.argv[1]
    data = open(path, 'rb').read()
    m = LandData_pb2.LandMessage()
    consumed = m.ParseFromString(data)
    print(f'== LandMessage: {len(data)} bytes, parsed {consumed}, '
          f"clean EOF: {consumed == len(data)} ==\n")

    print('== identity ==')
    print(f"    land id      : {m.id}")
    print(f"    countryCode  : {m.countryCode}")
    f = m.friendData
    print(f"    town name    : {f.name!r}")
    print(f"    town level   : {f.level}   rating: {f.rating}   "
          f"dataVersion: {f.dataVersion}")
    print(f"    lastPlayed   : {f.lastPlayedTime} ({ts(f.lastPlayedTime)} UTC)")
    for s in f.sublandInfos:
        print(f"    subland      : id={s.sublandId} rating={s.rating} created={s.created}")
    print(f"    spendables   : {len(f.spendable)}")
    print(f"    boardwalkTiles: {f.boardwalkTileCount}")

    u = m.userData
    print('\n== userData ==')
    show('level', u.level)
    show('experience', u.experience)
    show('money', u.money)
    show('lastBonus', u.lastBonus)
    show('friendsUnlocked', u.friendsUnlocked)
    show('reorganizeUnlocked', u.reorganizeUnlocked)
    show('sidebarDefaultOpen', u.sidebarDefaultOpen)
    show('bonusExperience', u.bonusExperience)
    show('bonusLevel', u.bonusLevel)
    show('hasPrestigeData', u.hasPrestigeData)
    show('tutorialComplete', u.tutorialComplete)
    show('visualLevel', u.visualLevel)
    show('timezoneOffset', u.timezoneOffset)
    show('userPreferences', u.userPreferences)
    show('shouldAnalyze', u.shouldAnalyze)
    show('gambleItemType', u.gambleItemType)
    show('fullDLCCompleted', u.fullDLCCompleted)
    show('lastBonusCollection', ts(u.lastBonusCollection))
    show('powerupDataList', str(u.powerupDataList).replace('\n', ' ')[:200])
    for s in u.subscriptions:
        print(f"    subscription: {s}")
    if u.stickerUnlockData:
        print(f"    stickerUnlocks: {len(u.stickerUnlockData)}")

    n = m.innerLandData
    print('\n== innerLandData ==')
    show('header id', n.header.id)
    show('landBlocks', f"len={len(n.landBlocks)} "
          f"(ones={n.landBlocks.count('1')}, zeros={n.landBlocks.count('0')}) "
          f"'{n.landBlocks[:32]}…'")
    show('nextInstanceID', n.nextInstanceID)
    pairs = [('numChars', len(m.characterData)), ('numBuildings', len(m.buildingData)),
             ('numConsumables', len(m.consumableData)), ('numJobs', len(m.jobData)),
             ('numQuests', len(m.questData)), ('numNotices', len(m.notificationData)),
             ('numInventoryItems', len(m.inventoryItemData)),
             ('numMemorabiliaItems', len(m.memorabiliaItemData)),
             ('numEventCountLists', len(m.eventCountListData)),
             ('numPremiumUnlocks', len(m.premiumUnlockItemData)),
             ('numActionLimits', len(m.actionLimitData)),
             ('numQuestGroups', len(m.questGroupData)),
             ('numSavedFriends', len(m.friendListData))]
    for name, actual in pairs:
        want = getattr(n, name)
        mark = '' if want == actual else '   !!! MISMATCH'
        print(f"    {name}: {want} (actual {actual}){mark}")
    show('nextCurrencyID', n.nextCurrencyID)
    show('creationTime', f"{n.creationTime} ({ts(n.creationTime)})")
    show('lastLevelUpTimeStamp', f"{n.lastLevelUpTimeStamp} ({ts(n.lastLevelUpTimeStamp)})")
    show('timeSpentPlaying', f"{n.timeSpentPlaying}s (~{n.timeSpentPlaying//86400}d)")
    show('landBlockWidth/Height', f"{n.landBlockWidth}×{n.landBlockHeight}")
    show('landBlockPosition', f"({n.landBlockPositionX}, {n.landBlockPositionY})")

    print('\n== terrain ==')
    grids = {}
    if m.HasField('roadsData'):
        grids['roads'] = terrain_grid(m.roadsData, 'roadsData')
    if m.HasField('riversData'):
        grids['rivers'] = terrain_grid(m.riversData, 'riversData')
    if m.HasField('oceanData'):
        grids['ocean'] = terrain_grid(m.oceanData, 'oceanData')
    for i, t in enumerate(m.roadMapDataMessage.roadMapList):
        grids[f'roadmap{i}'] = terrain_grid(t, f'roadMapList[{i}]')
    for s in m.subLandData:
        print(f"  subLandData: id={s.subLandID} blocks_len={len(s.landBlocks)} "
              f"({s.landBlocks.count('1')} ones) "
              f"wxh={s.landBlockWidth}×{s.landBlockHeight} "
              f"pos=({s.landBlockPositionX},{s.landBlockPositionY}) "
              f"terrain_layers={len(s.terrainData)}")
        for i, t in enumerate(s.terrainData):
            grids[f'subland{s.subLandID}_t{i}'] = terrain_grid(t, f'subLand {s.subLandID}[{i}]')

    # --- storage bundles: explicit mapDataSizeX/Y reveal grid dimensions
    print('\n== groupStorageBundles ==')
    for i, b in enumerate(m.groupStorageBundleMessage.groupStorageBundle):
        rmaps = [(r.subLandID, r.mapDataSizeX, r.mapDataSizeY) for r in b.groupStorageBundleRoadMap]
        print(f"  bundle[{i}]: entries={len(b.groupStorageBundleEntryData)} "
              f"roadmaps={rmaps} origin=({b.originPosX},{b.originPosY}) ts={b.timestampId}")

    # --- buildings
    print('\n== buildings ==')
    ids = collections.Counter()
    states = collections.Counter()
    subs = collections.Counter()
    skins = collections.Counter()
    xs, ys = [], []
    for b in m.buildingData:
        ids[b.building] += 1
        states[b.buildState] += 1
        subs[b.subLandID] += 1
        if b.skin: skins[b.skin] += 1
        xs.append(b.positionX)
        ys.append(b.positionY)
    print(f"    count: {len(m.buildingData)}")
    print(f"    positionX: {min(xs)} … {max(xs)}   positionY: {min(ys)} … {max(ys)}")
    print(f"    buildState hist: {dict(states.most_common())}")
    print(f"    subLandID hist: {dict(subs.most_common())}")
    print(f"    skins: {dict(skins.most_common(8))}")
    print(f"    distinct building defIDs: {len(ids)}")
    print(f"    top defIDs: {dict(ids.most_common(25))}")
    b0 = m.buildingData[0]
    print(f"    first: instanceID={b0.header.id} def={b0.building} "
          f"pos=({b0.positionX},{b0.positionY}) state={b0.buildState} "
          f"created={ts(b0.creationTime)} flipped={b0.flipped}")

    # --- characters
    print('\n== characters ==')
    cids = collections.Counter()
    csub = collections.Counter()
    cxs, cys = [], []
    for c in m.characterData:
        cids[c.character] += 1
        csub[c.subLandID] += 1
        cxs.append(c.positionX)
        cys.append(c.positionY)
    print(f"    count: {len(m.characterData)}")
    print(f"    positionX: {min(cxs)} … {max(cxs)}   positionY: {min(cys)} … {max(cys)}")
    print(f"    subLandID hist: {dict(csub.most_common())}")
    print(f"    top character defIDs: {dict(cids.most_common(30))}")

    # --- jobs
    print('\n== jobs ==')
    jstats = collections.Counter()
    jids = collections.Counter()
    for j in m.jobData:
        jstats[j.state] += 1
        jids[j.job] += 1
    print(f"    count: {len(m.jobData)}; state hist: {dict(jstats.most_common())}")
    print(f"    top job IDs: {dict(jids.most_common(10))}")

    # --- quests
    print('\n== quests ==')
    qstate = collections.Counter()
    for q in m.questData:
        qstate[q.questState] += 1
    print(f"    count: {len(m.questData)}; questState hist: {dict(qstate.most_common())}")
    q0 = m.questData[0]
    print(f"    first: id={q0.questID} state={q0.questState} "
          f"scriptState={q0.questScriptState} timesCompleted={q0.timesCompleted} "
          f"objectives={len(q0.objectiveData)}")

    # --- quest groups
    print('\n== questGroups ==')
    for q in m.questGroupData[:6]:
        print(f"    group {q.questGroupID}: state={q.questGroupState} "
              f"currentChild={q.currentChild} lastChild={q.lastChild} "
              f"numChildren={q.numChildren} completeDaily={q.numCompleteDaily}")
    print(f"    (…{max(0, len(m.questGroupData)-6)} more)")

    # --- character sets
    for cs in [m.characterSetsData]:
        names = [c.name for c in cs.characterSet]
        print(f"\n== characterSets ({len(names)} sets, "
              f"numCompleteSets={cs.numCompleteSets}) ==")
        for i in range(0, len(names), 8):
            print('    ' + ', '.join(names[i:i + 8]))

    # --- notifications sample
    print(f"\n== notifications ({len(m.notificationData)}) ==")
    ntypes = collections.Counter(nt.type for nt in m.notificationData)
    print(f"    type hist: {dict(ntypes.most_common(10))}")
    nt0 = m.notificationData[0]
    print(f"    first: type={nt0.type} building={nt0.buildingID} "
          f"char={nt0.characterID} static={nt0.isStatic} setup={nt0.isSetup}")

    # --- inventory
    print(f"\n== inventory ({len(m.inventoryItemData)}) ==")
    inv = collections.Counter()
    for it in m.inventoryItemData:
        inv[(it.itemType, it.itemID)] += it.count
    print(f"    top items (type,id)→count: {dict(inv.most_common(15))}")

    # --- object variables
    ov = m.objectVariables.variables
    print(f"\n== objectVariables ({len(ov.variable)} entries) ==")
    by_class = collections.Counter()
    for v in ov.variable:
        by_class[v.objectClass] += 1
    print(f"    objectClass hist: {dict(by_class.most_common(10))}")
    print('    sample (name=value, created):')
    for v in ov.variable[:15]:
        print(f"      {v.name} = {v.value}  ({ts(v.createdTime)})")

    # --- friends
    print(f"\n== saved friends ({len(m.friendListData)}) ==")
    for fr in m.friendListData:
        print(f"    id={fr.friendID} hideInMap={fr.hideInMap} "
              f"visited={fr.hasBeenVisited} isOrigin={fr.isOrigin}")

    # --- minigames
    print(f"\n== minigames ({len(m.minigameData)}) ==")
    for mg in m.minigameData:
        print(f"    minigameID={mg.minigameID} buildingRef={mg.buildingRefID} "
              f"state={mg.state} updated={ts(mg.updateTime)}")

    # --- game objects
    go = m.gameObjectInfo
    print(f"\n== gameObjectInfo ({len(go.gameObject)}) ==")
    gtypes = collections.Counter(g.gameObjectType for g in go.gameObject)
    print(f"    type hist: {dict(gtypes.most_common(12))}")
    g0 = go.gameObject[0]
    print(f"    first: dataId={g0.dataId} type={g0.gameObjectType} "
          f"unlockTime={g0.unlockTime} locked={g0.locked} viewed={g0.viewed}")

    # --- fake friend
    if m.HasField('fakeFriendData'):
        ff = m.fakeFriendData
        print(f"\nfakeFriendData: townLevel={ff.townLevel} building={ff.building!r} "
              f"actionType={ff.actionType!r} actionTime={ff.actionTime!r}")

    # --- ad hoc objects
    if m.adHocObjectData:
        ah = collections.Counter(a.identifier for a in m.adHocObjectData)
        print(f"\n== adHocObjectData ({len(m.adHocObjectData)}) ==")
        print(f"    identifier hist: {dict(ah.most_common(10))}")

    # --- daily tasks
    if m.HasField('dailyTaskDataList'):
        d = m.dailyTaskDataList
        print(f"\n== dailyTasks ==\n    taskSet={d.taskSetName!r} "
              f"completed={d.numTasksCompleted} totalCompleted={d.totalTasksCompleted} "
              f"totalChallenges={d.totalChallengesCompleted} "
              f"queued={d.queuedTask} activeMetaReward={d.activeMetaRewardID}")
        for t in d.taskDataList:
            print(f"    task: questID={t.questID} rewardID={t.rewardID} "
                  f"menuSlot={t.menuSlot} started={t.timeStarted} finished={t.timeFinished}")

    # --- spendables
    sp = m.spendablesData
    print(f"\n== spendables ({len(sp.spendable)}) ==")
    stypes = collections.Counter(s.type for s in sp.spendable)
    print(f"    type hist: {dict(stypes.most_common(12))}")

    # --- special events
    se = m.specialEventsData
    print(f"\n== specialEvents ({len(se.specialEvent)}) ==")
    for e in se.specialEvent[:10]:
        print(f"    event id={e.id} updated={e.updateTime} "
              f"prizes={len(e.prizeDataSet.prizeData)} "
              f"timedChars={len(e.timedCharacterDataSet.timedCharacterData)} "
              f"banks={len(e.bankDataSet.bankData)}")

    # --- render terrain grids
    if grids:
        print('\n== terrain renders ==')
        # candidate widths to try
        g0 = grids.get('roads') or next(iter(grids.values()))
        cands = set()
        for w in range(32, 400):
            if len(g0) % w == 0 and len(g0) // w <= 400:
                cands.add(w)
        print(f"    grid len {len(g0)}; candidate widths: {sorted(cands)}")
        for label in ('roads', 'rivers', 'ocean'):
            if label in grids:
                for w in sorted(cands)[:12]:
                    render(grids[label], w, f'{label}@{w}')

if __name__ == '__main__':
    main()
