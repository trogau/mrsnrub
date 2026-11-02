"""Landmark calibration inputs (user-side):
  calib-export.png  — the Android export at S=4 with a labelled pixel ruler.
  calib-world.png   — top-down map from the save (tiles), with a labelled
                      32-tile grid and pins on unmistakable named buildings.
User reports matching (px, tile) pairs; we solve the transform exactly.
"""
import json
import numpy as np
from PIL import Image, ImageDraw, ImageFont
Image.MAX_IMAGE_PIXELS = None

root = '/home/dave/projects/mrsnrub'
src = open(root + '/web/js/map-explorer-data.js', encoding='utf8').read()
M = json.loads(src[src.index('{'):src.rindex('}')+1])
OX, OY = M['ox'], M['oy']

def decode(s):
    # normal layers: char i -> 16 sub-columns along x of row i//32
    pts = []
    for i, ch in enumerate(s):
        c = ord(ch)
        if c == 0x47: continue
        r = i//32; x0 = (i % 32)*16
        if c == 0x50: pts.extend((x0+k, r) for k in range(16))
        else:
            kk = c-0x61
            if 0 <= kk < 16: pts.append((x0+kk, r))
    return np.array(pts, dtype=np.int32) if pts else np.zeros((0, 2), np.int32)

def decode_vert(s):
    # sea-patch frame (3072 chars) is COLUMN-major: char i -> 16
    # sub-cells along y of column i//32 (notes/06 §10).
    pts = []
    for i, ch in enumerate(s):
        c = ord(ch)
        if c == 0x47: continue
        x = i//32; y0 = (i % 32)*16
        if c == 0x50: pts.extend((x, y0+k) for k in range(16))
        else:
            kk = c-0x61
            if 0 <= kk < 16: pts.append((x, y0+kk))
    return np.array(pts, dtype=np.int32) if pts else np.zeros((0, 2), np.int32)

layers = {L['n']: ((decode_vert(L['s']) if len(L['s']) == 3072 else decode(L['s'])), L['c'])
          for L in M['layers']}
binfo = M['binfo']
brect = {}   # id -> list of grid rects (x0,y0,x1,y1)
for b in M['buildings']:
    bid = str(b[0])
    if isinstance(b[1], float) and isinstance(b[3], float) and b[3] > 0 and b[4] > 0:
        # town-coords rect (x, y, w, h) as emitted by gen_map_explorer
        x0, y0 = b[1] + OX, b[2] + OY
        brect.setdefault(bid, []).append((x0, y0, x0 + b[3], y0 + b[4]))
    else:
        x, y = b[6] + OX, b[7] + OY          # anchor tile (grid)
        info = binfo.get(bid)
        w = info[3] if info else 2
        h = info[4] if info else 2
        brect.setdefault(bid, []).append((x, y, x + w, y + h))

# ---------- image A: export with ruler ----------
S = 4
im = Image.open(root + '/Tapped Out - Simpsons_Screenshot-2025-01-17--19-12-02.png').convert('RGB')
A = im.resize((im.size[0]//S, im.size[1]//S), Image.LANCZOS)
da = ImageDraw.Draw(A)
try: font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 22)
except Exception: font = ImageFont.load_default()
for gx in range(0, im.size[0], 500):
    x = gx//S
    da.line([(x, 0), (x, A.size[1])], fill=(255, 60, 60), width=1)
    da.text((x+3, 4), str(gx), fill=(255, 60, 60), font=font)
for gy in range(0, im.size[1], 500):
    y = gy//S
    da.line([(0, y), (A.size[0], y)], fill=(255, 60, 60), width=1)
    da.text((4, y+3), str(gy), fill=(255, 60, 60), font=font)
# finer lines every 100 px without labels
for gx in range(0, im.size[0], 100):
    da.line([(gx//S, 0), (gx//S, A.size[1])], fill=(255, 150, 150), width=1)
for gy in range(0, im.size[1], 100):
    da.line([(0, gy//S), (A.size[0], gy//S)], fill=(255, 150, 150), width=1)
A.save(root + '/mapdump/registration/calib-export.png')
print('saved calib-export.png', A.size, '(grid: 500px labelled / 100px minor, full-res px)')

# ---------- image B: world top-down ----------
# tile space: x from -80 (offshore sea) to 640 (buildings reach 620), y 0..1087
XLO, XHI, GW, GH = -80, 640, 512, 1087
PX = lambda x: (x - XLO) * 2
B = Image.new('RGB', ((XHI - XLO) * 2, GH * 2), (99, 186, 99))   # bare grass ref colour
db = ImageDraw.Draw(B)
SEA_COL_OFF = -33        # keep in sync with Terrain#seaColOffset
# sea base: water polygon grid x -64..0, y 0..512 (Squid Port side)
db.rectangle([PX(-64), 0, PX(0), 512 * 2], fill=(60, 140, 220))
for name, (pts, col) in layers.items():
    off = SEA_COL_OFF if name == 'ocean' else 0
    col = tuple(int(v) for v in col)
    for x, y in pts:
        x += off
        if XLO <= x < XHI and 0 <= y < GH:
            db.rectangle([PX(x), y*2, PX(x)+1, y*2+1], fill=col)
for bid, rects in brect.items():
    for (x0, y0, x1, y1) in rects:
        if x1 < XLO or x0 > XHI: continue
        db.rectangle([PX(x0), y0*2, PX(x1)-1, y1*2-1], fill=(190, 150, 120), outline=(90, 60, 40))
for gx in range(-64, XHI + 1, 32):
    db.line([(PX(gx), 0), (PX(gx), GH * 2)], fill=(255, 255, 255), width=1)
    db.text((PX(gx)+2, 2), str(gx), fill=(255, 255, 255), font=font)
for gy in range(0, GH + 1, 32):
    db.line([(0, gy*2), ((XHI - XLO) * 2, gy*2)], fill=(255, 255, 255), width=1)
    db.text((2, gy*2+2), str(gy), fill=(255, 255, 255), font=font)
# pins on distinctive named buildings — EXACT names only. (The old
# substring WANT list matched 65 props — FireHydrant, PoliceTank,
# Campfire, Zoominator rides — and stamped every one with a label at
# its own spot: an unreadable pile of yellow text downtown.)
# One pin per name (largest footprint, >=12 tiles rejects prop
# duplicates), capped at 24, well spread. Pin CIRCLES stay at the exact
# tile centres (those are the calibration targets); the labels are
# SPREAD OUT: each slides to the nearest free spot in a growing ring of
# candidates (collision-checked against all placed labels), with a red
# leader line back to its circle, and number -> name -> tile centre is
# listed in a legend panel (bottom-left, open ground south of the sea).
PINS = ['PowerPlant', 'Kwik-E-Mart', 'DuffStadium', 'BurnsBasketBallStadium',
        'SpringfieldElementary', 'MoeTavern', 'PoliceStation',
        'SpringfieldGeneralHospital', 'SpringfieldLibrary', 'MonsarnoLibrary',
        'SpringfieldMuseumOfNaturalHistory', 'SpringfieldMuseum',
        'SpringfieldZooEntrance', 'EARLsLighthouse', 'AbandonedLighthouse',
        'OrnatePier', 'SquidportEntrance', 'BarnacleBayMarina',
        'LuxuryYacht', 'FerrisWheel', 'GiantFerrisWheel', 'AnimalHospital',
        'CletusFarm', 'SpringfieldPenitentiary']
best = {}   # name -> (area, cx, cy)  [grid coords]
for bid, info in binfo.items():
    nm = info[0]
    if nm not in PINS or bid not in brect:
        continue
    x0, y0, x1, y1 = brect[bid][0]
    area = (x1 - x0) * (y1 - y0)
    if area >= 12 and (nm not in best or area > best[nm][0]):
        best[nm] = (area, (x0 + x1) / 2, (y0 + y1) / 2)
pins = sorted(best, key=lambda nm: -best[nm][0])[:24]   # biggest landmarks first
try: font_s = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 14)
except Exception: font_s = font

placed = []   # label rects already in use
def free(r):
    if r[0] < 2 or r[1] < 2 or r[2] > B.size[0] - 2 or r[3] > B.size[1] - 2:
        return False
    for q in placed:
        if r[0] < q[2] + 4 and r[2] > q[0] - 4 and r[1] < q[3] + 4 and r[3] > q[1] - 4:
            return False
    return True
found = []
for i, nm in enumerate(pins):
    _, cxg, cyg = best[nm]
    cx, cy = PX(cxg), cyg * 2
    label = '%d %s' % (i + 1, nm)
    try:
        tb = db.textbbox((0, 0), label, font=font_s)
        w, h = tb[2] - tb[0], tb[3] - tb[1]
    except Exception:
        w, h = 8 * len(label), 16
    spot = None
    for d in (14, 26, 44, 70, 110):
        for lx, ly in ((cx + d, cy - h // 2), (cx - d - w, cy - h // 2),
                       (cx - w // 2, cy - d - h), (cx - w // 2, cy + d),
                       (cx + d, cy - h - d // 2), (cx - d - w, cy - h - d // 2),
                       (cx + d, cy + d // 2), (cx - d - w, cy + d // 2)):
            if free((lx, ly, lx + w, ly + h)):
                spot = (lx, ly)
                break
        if spot:
            break
    if not spot:
        spot = (cx + 14, cy - h // 2)   # give up gracefully; leader line still points
        print('WARN: label for %s fell back to an unplaced spot' % nm)
    placed.append((spot[0], spot[1], spot[0] + w, spot[1] + h))
    db.ellipse([cx - 7, cy - 7, cx + 7, cy + 7], outline=(255, 0, 0), width=3)
    db.text((cx - 4, cy - 8), str(i + 1), fill=(255, 60, 60), font=font_s)
    db.line([(cx, cy), (spot[0] + (0 if spot[0] > cx else w), spot[1] + h // 2)],
            fill=(255, 0, 0), width=1)
    db.text(spot, label, fill=(255, 255, 0), font=font_s)
    found.append((nm, int(cxg), int(cyg)))
# legend panel
lx, ly, lh = 6, GH - 30 - 16 * (len(pins) + 2), 16
db.rectangle([lx - 3, ly - 3, lx + 320, ly + lh + 16 * (len(pins) + 1)],
             fill=(10, 12, 18), outline=(255, 255, 0))
db.text((lx, ly), 'PINS  # name (tile centre)', fill=(255, 255, 0), font=font_s)
for i, (nm, cxg, cyg) in enumerate(found):
    db.text((lx, ly + lh * (i + 1)), '%2d  %s (%d,%d)' % (i + 1, nm, cxg, cyg),
            fill=(235, 235, 235), font=font_s)
B.save(root + '/mapdump/registration/calib-world.png')
print('saved calib-world.png', B.size, '(grid: 32 tiles; numbered pins, see legend)')
print('pins:', found)
