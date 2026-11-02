#!/usr/bin/env python3
"""Dump all TerrainData payloads (top-level + roadmap + sublands) with metadata.

Usage: terrain_dump.py <city.pb> [outdir]
"""
import os
import sys
import types

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

fake = types.ModuleType('google.protobuf.runtime_version')
fake.PROTOBUF_VERSION = (4, 21, 12)
fake.ValidateProtobufRuntimeVersion = lambda *a, **k: None
class _Domain:
    PUBLIC = 1
fake.Domain = _Domain
sys.modules['google.protobuf.runtime_version'] = fake
sys.path.insert(0, os.path.join(root, 'server-python'))
from protofiles import LandData_pb2  # noqa: E402

TYPES = {1: 'PAVEMENT', 2: 'ROADS', 3: 'RIVERS', 4: 'KRUSTYLAND_ROADS', 5: 'OCEAN',
         6: 'DIRT', 7: 'DIRT_ROADS', 8: 'COBBLESTONE', 9: 'ICERIVER',
         10: 'KLSROAD', 11: 'GOLDROAD', 12: 'SAND'}

pb_file = sys.argv[1]
outdir = sys.argv[2] if len(sys.argv) > 2 else None
msg = LandData_pb2.LandMessage()
msg.ParseFromString(open(pb_file, 'rb').read())

layers = []
for name in ('roadsData', 'riversData', 'oceanData'):
    t = getattr(msg, name)
    if t is not None and t.HasField('mapData') and t.mapData:
        layers.append((f'{name}', t))
for i, t in enumerate(msg.roadMapDataMessage.roadMapList):
    if t.mapData:
        layers.append((f'roadMapList[{i}]', t))
for sl in msg.subLandData:
    for i, t in enumerate(sl.terrainData):
        if t.mapData:
            layers.append((f'subLand{sl.subLandID}[{i}]', t))

print(f"{'name':22s} {'type':14s} {'hdr.id':>8s} {'mapDataSize':>11s} {'len':>7s}  ratio")
payloads = {}
for name, t in layers:
    ratio = ''
    if t.mapDataSize:
        ratio = f'{len(t.mapData)/t.mapDataSize:.3f}'
    print(f"{name:22s} {TYPES.get(t.terrainType, t.terrainType):14s} {t.header.id:8d} {t.mapDataSize:11d} {len(t.mapData):7d}  {ratio}")
    if outdir:
        os.makedirs(outdir, exist_ok=True)
        with open(os.path.join(outdir, f'{name}.txt'), 'w') as f:
            f.write(t.mapData)
    payloads[name] = t.mapData

# quick char histogram
import collections
for name, t in layers[:3]:
    h = collections.Counter(t.mapData)
    top = ''.join(f'{c}×{n}' for c, n in h.most_common(20))
    print(f"\n{name}: {top}")
