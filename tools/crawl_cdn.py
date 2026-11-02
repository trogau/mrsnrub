#!/usr/bin/env python3
"""Crawl the fan-project CDN (cdn.projectspringfield.com) directory listings
into a metadata catalog (cdn/catalog.json).

Politeness rules (agreed with the project):
  * at most ONE concurrent connection
  * at least 10 seconds between any two HTTP requests
  * blank User-Agent (no literal UA value exists anywhere in the APK; the
    engine builds "User-Agent: %s\\r\\n" from a runtime value)
  * catalog only — never downloads pack bytes

Usage: python3 tools/crawl_cdn.py [out.json]
"""
import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone

BASE = "https://cdn.projectspringfield.com/static/"
DELAY = 10  # seconds between requests
TIMEOUT = 30

ROW = re.compile(
    r'<a href="([^"]+)">[^<]*</a>\s+'
    r"([0-9]{1,2}-[A-Za-z]{3}-[0-9]{4} [0-9:]{5})\s+(\S+)")

SUFFIX = {"": 1, "B": 1, "K": 1024, "M": 1024 ** 2, "G": 1024 ** 3}


def parse_size(raw):
    if raw == "-":
        return None
    m = re.fullmatch(r"([0-9.]+)([KMGB]?)", raw)
    if not m:
        return None
    return int(float(m.group(1)) * SUFFIX[m.group(2)])


def fetch(url, last_request):
    """GET with rate limiting + one retry. Returns (body, now, last_request)."""
    wait = DELAY - (time.time() - last_request)
    if wait > 0:
        time.sleep(wait)
    last_request = time.time()
    req = urllib.request.Request(url, headers={"User-Agent": ""})
    for attempt in (1, 2):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                body = r.read().decode("utf-8", "replace")
            print(f"  [req {int(time.time() - t0):4d}s] {url}", flush=True)
            return body, last_request
        except Exception as e:  # noqa: BLE001
            if attempt == 2:
                raise
            print(f"  retry after {e!r}", flush=True)
            time.sleep(15)
            last_request = time.time()
    raise RuntimeError("unreachable")


def main():
    global t0
    t0 = time.time()
    out_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cdn", "catalog.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    entries = {}   # relpath -> {kind, size, mtime}
    dirs = {}      # relpath -> {mtime-ish meta}
    queue = [""]   # dirs to list, relative to BASE
    last = time.time()
    requests_made = 0

    while queue:
        rel = queue.pop(0)
        if rel in dirs:
            continue
        body, last = fetch(BASE + rel, last)
        requests_made += 1
        if "<h1>Index of" not in body:
            print(f"  ! unexpected page for {rel!r}, skipping", flush=True)
            continue
        for href, mtime, size_raw in ROW.findall(body):
            if href.startswith("../"):
                continue
            child = (rel + href) if rel else href
            if href.endswith("/"):
                queue.append(child)
            entries[child] = {
                "kind": "dir" if href.endswith("/") else "file",
                "size": parse_size(size_raw),
                "size_raw": size_raw,
                "mtime": mtime,
            }
        dirs[rel] = "dir"
        print(f"  {rel or '/'}: {len([h for h, *_ in ROW.findall(body) if not h.startswith('../')])} items "
              f"(total files so far: {sum(1 for v in entries.values() if v['kind'] == 'file')})", flush=True)
        save(out_path, BASE, entries, requests_made)

    save(out_path, BASE, entries, requests_made, final=True)
    files = [e for e in entries.values() if e["kind"] == "file"]
    print(f"\nDone: {len(dirs)} directories, {len(files)} files, "
          f"{sum(e['size'] or 0 for e in files)} bytes, {requests_made} requests -> {out_path}")


def save(path, base, entries, requests, final=False):
    files = [e for e in entries.values() if e["kind"] == "file"]
    doc = {
        "base": base,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "final": final,
        "user_agent": None,  # blank, per instruction (no UA literal exists in the APK)
        "requests": requests,
        "summary": {
            "directories": sum(1 for e in entries.values() if e["kind"] == "dir"),
            "files": len(files),
            "total_bytes": sum(e["size"] or 0 for e in files),
        },
        "entries": {k: entries[k] for k in sorted(entries)},
    }
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(doc, f, indent=1)
    os.replace(tmp, path)


if __name__ == "__main__":
    main()
