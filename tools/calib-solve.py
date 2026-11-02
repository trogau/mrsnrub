#!/usr/bin/env python3
"""Solve the City View grid->export registration from calib-pairs.txt.

Reads the landmark correspondence block in
mapdump/registration/calib-pairs.txt (name | export px x,y | grid tile x,y,
captured with tools/calib-pick.html) and fits:

  * the 6-DOF affine  [x'; y'] = A [gx; gy; 1]           (g2e-affine.json)
  * the 8-DOF projective homography (ground plane)       (g2e-homog.json)

The game camera views the ground plane through a perspective matrix, so the
exact model of grid->export for ground features is a homography; the affine
is kept as the historical baseline (M2/M3 shipped with it). Prints per-pair
residuals so badly clicked pairs stand out (2026-10-17: zoo/hospital read
~50 px while the other seven fit inside ~30 px — re-pick before trusting
the south-east corner).

Writes JSON {h: [h00,h01,h02,h10,h11,h12,h20,h21], rms: ...} with
H = [[h00,h01,h02],[h10,h11,h12],[h20,h21,1]] such that
screen = ((h00*gx+h01*gy+h02)/(h20*gx+h21*gy+1), ...).

tools/smoke-calib.cjs pins the JSON against the pairs file.

Usage: python3 tools/calib-solve.py [pairs.txt]
"""
import json
import os
import re
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAIRS = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    ROOT, 'mapdump', 'registration', 'calib-pairs.txt')
OUT_DIR = os.path.join(ROOT, 'mapdump', 'registration')


def load_pairs(path):
    pairs = []
    with open(path) as fh:
        for line in fh:
            parts = [p.strip() for p in line.split('|')]
            if len(parts) != 3:
                continue
            m1 = re.fullmatch(r'([-\d.]+)\s*,\s*([-\d.]+)', parts[1])
            m2 = re.fullmatch(r'([-\d.]+)\s*,\s*([-\d.]+)', parts[2])
            if m1 and m2:
                pairs.append((parts[0], float(m1.group(1)), float(m1.group(2)),
                              float(m2.group(1)), float(m2.group(2))))
    return pairs


def fit_affine(pairs):
    rows, rhs = [], []
    for _, ex, ey, gx, gy in pairs:
        rows.append([gx, gy, 1, 0, 0, 0]); rhs.append(ex)
        rows.append([0, 0, 0, gx, gy, 1]); rhs.append(ey)
    a = np.linalg.lstsq(np.array(rows), np.array(rhs), rcond=None)[0]
    return a


def fit_homog(pairs):
    rows, rhs = [], []
    for _, ex, ey, gx, gy in pairs:
        rows.append([gx, gy, 1, 0, 0, 0, -gx * ex, -gy * ex]); rhs.append(ex)
        rows.append([0, 0, 0, gx, gy, 1, -gx * ey, -gy * ey]); rhs.append(ey)
    s = np.linalg.lstsq(np.array(rows), np.array(rhs), rcond=None)[0]
    return s


def homog_res(s, pairs):
    return [np.hypot(*[X - Y for X, Y in zip(res_homog(s, gx, gy), (ex, ey))])
            for _, ex, ey, gx, gy in pairs]


def fit_homog_robust(pairs, thresh_mult=3.0, thresh_floor=40.0):
    """Deterministic outlier rejection: fit all, drop pairs whose residual
    exceeds max(floor, mult * median), refit. Reproducible from the pairs
    file alone (no manual indices). zoo/hospital are the south-east
    outliers this drops (2026-10-17)."""
    s = fit_homog(pairs)
    keep = list(range(len(pairs)))
    for _ in range(3):
        r = homog_res(s, pairs)
        med = np.median([r[i] for i in keep])
        cut = max(thresh_floor, thresh_mult * med)
        nk = [i for i in keep if r[i] <= cut]
        if len(nk) < 4 or nk == keep:
            break
        keep = nk
        s = fit_homog([pairs[i] for i in keep])
    return s, keep


def res_affine(a, gx, gy):
    return a[0] * gx + a[1] * gy + a[2], a[3] * gx + a[4] * gy + a[5]


def res_homog(s, gx, gy):
    den = s[6] * gx + s[7] * gy + 1.0
    return ((s[0] * gx + s[1] * gy + s[2]) / den,
            (s[3] * gx + s[4] * gy + s[5]) / den)


def main():
    pairs = load_pairs(PAIRS)
    if len(pairs) < 4:
        sys.exit('need >=4 correspondence pairs, got %d' % len(pairs))
    a = fit_affine(pairs)
    s = fit_homog(pairs)
    ra, rh = [], []
    print('%-12s %8s %8s' % ('pair', 'affine', 'homog'))
    for name, ex, ey, gx, gy in pairs:
        ax, ay = res_affine(a, gx, gy)
        hx, hy = res_homog(s, gx, gy)
        da = np.hypot(ax - ex, ay - ey); dh = np.hypot(hx - ex, hy - ey)
        ra.append(da); rh.append(dh)
        print('%-12s %8.1f %8.1f' % (name, da, dh))
    rms_a = float(np.sqrt(np.mean(np.square(ra))))
    print('RMS affine %.1f px' % rms_a)
    s_r, keep = fit_homog_robust(pairs)
    kept = [pairs[i] for i in keep]
    rh = homog_res(s_r, pairs)
    rms_hr = float(np.sqrt(np.mean([rh[i] ** 2 for i in keep])))
    print('homography robust: kept %s, dropped %s — RMS %.1f px (kept only)' % (
        [pairs[i][0] for i in keep],
        [pairs[i][0] for i in range(len(pairs)) if i not in keep], rms_hr))
    for fn, payload in (('g2e-affine.json', {'a': a.tolist(), 'rms': rms_a}),
                        ('g2e-homog.json', {'h': s_r.tolist(), 'rms': rms_hr,
                                            'kept': [pairs[i][0] for i in keep]})):
        with open(os.path.join(OUT_DIR, fn), 'w') as fh:
            json.dump(payload, fh, indent=1)
        print('wrote', fn)


if __name__ == '__main__':
    main()
