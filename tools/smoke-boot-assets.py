#!/usr/bin/env python3
"""Smoke test for the M5.1 boot-assets toolchain (extract_boot_assets.py +
gen_boot_explorer.py).

Builds a fixture CDN root (two 7z bundles holding hand-made menu /
SplashScreens pack zips with decoy members) plus a fixture APK assets
tree, runs the extractor and the data generator against them, and asserts:
  * only boot members extract (abe.rgb / junk.png / .css decoys don't,
    the menuatlas pack family is skipped),
  * PNG dimensions match the hand-built .rgb pixels,
  * provenance (bundle/pack/tier/revision/indexVersion/role) lands in
    the manifest,
  * thumbnails are written,
  * APK-side entries map to the right pack per extract_assets.py's rules
    (core-splashes-<class>, core-<class>, res/drawable, audio/res-audio)
    and thumb_/non-boot files are skipped,
  * the generated data JS carries the GENERATED header + window.BOOT_DATA
    and round-trips to the manifest.
No network, no browser.
"""
from __future__ import annotations

import io
import json
import shutil
import struct
import subprocess
import sys
import tempfile
import wave
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))

import extract_boot_assets as eba  # noqa: E402
import gen_boot_explorer  # noqa: E402
from extract_assets import png_dims  # noqa: E402

SPLASH_BUNDLE = "4_12_XMAS2014_Takedown_Alt_3CAW93BIJU9G.7z"


def make_rgb(w=2, h=2, seed=0) -> bytes:
    px = bytes((i * 7 + seed) % 256 for i in range(w * h * 4))
    return struct.pack("<IHH", 0, w, h) + px


def make_pack_zip(members: dict[str, bytes], index_version: int) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in members.items():
            z.writestr(name, data)
    inner = buf.getvalue()
    hdr = b"BGrm" + struct.pack("<I", index_version)
    buf2 = io.BytesIO()
    with zipfile.ZipFile(buf2, "w", zipfile.ZIP_STORED) as z:
        z.writestr("0", hdr)
        z.writestr("1", inner)
    return buf2.getvalue()


def make_wav(seconds=0.4, rate=22050) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(bytes([90, 170] * int(rate * seconds)))
    return buf.getvalue()


def png_bytes(w=2, h=2, seed=0) -> bytes:
    from extract_assets import write_png
    import tempfile as _tf
    with _tf.NamedTemporaryFile(suffix=".png", delete=False) as f:
        p = Path(f.name)
    write_png(str(p), w, h, bytes((i * 5 + seed) % 256 for i in range(w * h * 4)))
    data = p.read_bytes()
    p.unlink()
    return data


def build_fixtures(fx: Path) -> None:
    cdn = fx / "cdn"
    cdn.mkdir(parents=True)

    # 3_0_30.7z: complete menu pack + decoy pack family + partial pack
    menu_full = {
        "loading_donut.rgb": make_rgb(4, 4, 1),
        **{f"donutbunch_{i:02d}.rgb": make_rgb(3, 3, 2 + i) for i in range(6)},
        **{f"dailybonustitleart_{i:02d}.rgb": make_rgb(3, 3, 10 + i) for i in range(6)},
        "abe.rgb": make_rgb(2, 2),           # decoy: atlas texture member
        "junk.png": b"\x89PNG\r\n\x1a\n",    # decoy: non-boot member
        "popup_menu.rgb": make_rgb(2, 2, 5),  # decoy: menu UI, not boot
    }
    menu_partial = {
        "loading_donut.rgb": make_rgb(4, 4, 3),
        "donutbunch_00.rgb": make_rgb(3, 3, 4),
    }
    zbuf = io.BytesIO()
    with zipfile.ZipFile(zbuf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("menu-retina-v3_0_30-r9-0D2B882C.zip",
                    make_pack_zip(menu_full, 9))
        zf.writestr("menu-ipad-v3_0_30-r9.zip", make_pack_zip(menu_partial, 9))
        zf.writestr("menuatlas-retina-v3_0_30-r9.zip",
                    make_pack_zip({"menuatlas.rgb": make_rgb()}, 9))
    (cdn / "3_0_30.7z").write_bytes(zbuf.getvalue())

    # Splash bundle: one SplashScreens pack with sidecar txt + decoys
    splash_members = {
        "splashscreen.rgb": make_rgb(240, 4, 20),
        "splashscreen_homer.rgb": make_rgb(3, 5, 21),
        "splashscreen_signature.rgb": make_rgb(6, 2, 22),
        "technicaldifficulties.rgb": make_rgb(6, 3, 23),
        "technicaldifficulties_leftside.rgb": make_rgb(3, 3, 24),
        "lang_brazilian.rgb": make_rgb(5, 1, 25),
        "technicaldifficulties.txt": b"Uh oh, there was an error.\n",
        "languageinfo.txt": b"EuropeanEnglish\n",
        "splashscreen.css": b".junk{}",       # decoy: not .rgb/.txt
    }
    sbuf = io.BytesIO()
    with zipfile.ZipFile(sbuf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("SplashScreens-retina-r9-B8353263.zip",
                    make_pack_zip(splash_members, 9))
    (cdn / SPLASH_BUNDLE).write_bytes(sbuf.getvalue())

    # APK assets tree (flat, like web/assets/{images,audio,thumbs})
    a = fx / "assets"
    (a / "images").mkdir(parents=True)
    (a / "audio").mkdir(parents=True)
    (a / "thumbs").mkdir(parents=True)
    images = {
        "splashdefault.png": png_bytes(6, 3, 30),
        "splashscreen_large.png": png_bytes(4, 2, 31),
        "loading_donut.png": png_bytes(4, 4, 32),
        "technicaldifficulties.png": png_bytes(6, 3, 33),
        "thumb_loading_donut.png": png_bytes(1, 1, 34),   # skip: thumb_
        "icon_gold.png": png_bytes(2, 2, 35),             # skip: not boot
    }
    for name, data in images.items():
        (a / "images" / name).write_bytes(data)
    (a / "thumbs" / "splashscreen_large.png").write_bytes(png_bytes(1, 1, 36))
    (a / "audio" / "10_next_segment.wav").write_bytes(make_wav(0.4))
    (a / "audio" / "bgloop.wav").write_bytes(make_wav(0.2))
    (a / "audio" / "3_2_0_dlc_hollywood.wav").write_bytes(make_wav(0.1))  # skip

    # DLC corpus tree (already-extracted packs, catalogued not re-extracted)
    dlc_packs = {
        "SplashAndBurnMenu-retina-r9": {
            "bse_splashandburn_minieventpanel_intro.png": png_bytes(6, 4, 40),
            "bse_splashandburn_minieventpanel_outro.png": png_bytes(6, 4, 41),
            "bse_splashandburn_minieventpanel_mid.png": png_bytes(2, 2, 42),   # skip
            "ico_priz_splashandburn_prize1_lg.png": png_bytes(2, 2, 43),       # skip
        },
        "AnimalFriendlyThanksgivingMenu_LTD-retina-r9": {
            "bse_animalfriendlythanksgiving_minieventpanel_intro.png":
                png_bytes(5, 3, 44),
        },
        "KrustylandSplashes-ios-retina-r9": {
            "fullscreen.png": png_bytes(8, 4, 45),
            "other.png": png_bytes(2, 2, 46),                                   # skip
        },
        "RandomEventMenu-retina-r9": {
            "fullscreen.png": png_bytes(2, 2, 47),  # skip: not a Krustyland pack
        },
    }
    for pack, files in dlc_packs.items():
        (a / "dlc" / pack / "images").mkdir(parents=True)
        (a / "dlc" / pack / "thumbs").mkdir(parents=True)
        for name, data in files.items():
            (a / "dlc" / pack / "images" / name).write_bytes(data)
            (a / "dlc" / pack / "thumbs" / name).write_bytes(data)
    # one splash pack whose thumb is missing -> thumb must be None
    (a / "dlc" / "SplashAndBurnMenu-ipad-r9" / "images").mkdir(parents=True)
    (a / "dlc" / "SplashAndBurnMenu-ipad-r9" / "images" /
     "bse_splashandburn_minieventpanel_intro.png").write_bytes(png_bytes(4, 3, 48))


def check(cond, msg, failures):
    if cond:
        print(f"  ok: {msg}")
    else:
        print(f"  FAIL: {msg}")
        failures.append(msg)


def main() -> int:
    if not shutil.which("7z"):
        print("SKIP: 7z binary not available")
        return 0
    fx = Path(tempfile.mkdtemp(prefix="smoke-boot-", dir="/tmp/opencode"))
    try:
        build_fixtures(fx)
        assets = fx / "assets"
        failures: list[str] = []

        old_argv = sys.argv
        sys.argv = ["extract_boot_assets.py", "--cdn", str(fx / "cdn"),
                    "--assets", str(assets)]
        try:
            rc = eba.main()
        finally:
            sys.argv = old_argv
        check(rc == 0, "extractor exit 0", failures)

        man = json.loads((assets / "boot" / "boot-manifest.json").read_text())
        files = man["files"]

        def find(pack, fname):
            for e in files:
                if e["pack"] == pack and e["path"].rsplit("/", 1)[-1] == fname:
                    return e
            return None

        # --- CDN menu pack -------------------------------------------------
        ld = find("menu-retina-r9", "loading_donut.png")
        check(ld is not None, "loading_donut extracted", failures)
        if ld:
            check(ld["group"] == "cdn" and ld["bundle"] == "3_0_30.7z"
                  and ld["tier"] == "retina" and ld["revision"] == 9
                  and ld["indexVersion"] == 9 and ld["role"] == "loading-donut"
                  and ld["tab"] == "loading",
                  "cdn menu provenance (bundle/pack/tier/revision/indexVersion)",
                  failures)
            check(png_dims((assets / ld["path"]).read_bytes()) == (4, 4),
                  "loading_donut.png dims 4x4", failures)
            check(ld["thumb"] is None,
                  "no thumb for sub-192px source (make_thumb skip)", failures)
        n_extras = len([e for e in files if e["pack"] == "menu-retina-r9"
                        and e["tab"] == "extras"])
        check(n_extras == 12, f"all 12 extras frames extracted ({n_extras})",
              failures)
        check(not any(e["path"].rsplit("/", 1)[-1] in ("abe.png", "junk.png",
                                                       "popup_menu.png")
                      for e in files),
              "atlas/menu/png decoys excluded", failures)
        check(not any(e["pack"].startswith("menuatlas") for e in files),
              "menuatlas pack family skipped", failures)
        check(find("menu-ipad-r9", "loading_donut.png") is not None,
              "partial menu-ipad pack still contributes its boot members",
              failures)

        # --- SplashScreens pack -------------------------------------------
        se = find("SplashScreens-retina-r9", "splashscreen.png")
        check(se is not None and se["group"] == "cdn"
              and se["bundle"] == SPLASH_BUNDLE and se["role"] == "splash-strip"
              and se["tab"] == "splash",
              "splash provenance", failures)
        if se:
            check(png_dims((assets / se["path"]).read_bytes()) == (240, 4),
                  "splashscreen.png dims 240x4", failures)
            check(se["thumb"] and (assets / se["thumb"]).exists(),
                  "splashscreen thumb written", failures)
        for fname, role, dims in (
                ("splashscreen_homer.png", "splash-homer", (3, 5)),
                ("splashscreen_signature.png", "splash-signature", (6, 2)),
                ("technicaldifficulties.png", "error", (6, 3)),
                ("technicaldifficulties_leftside.png", "error-leftside", (3, 3)),
                ("lang_brazilian.png", "splash-title", (5, 1))):
            e = find("SplashScreens-retina-r9", fname)
            check(e is not None and e["role"] == role
                  and png_dims((assets / e["path"]).read_bytes()) == dims,
                  f"{fname} role={role} dims={dims}", failures)

        # data/ sidecars: .txt copied, .css decoy not
        data_names = {e["path"].rsplit("/", 1)[-1] for e in files
                      if e["type"] == "data"}
        check(data_names == {"technicaldifficulties.txt", "languageinfo.txt"},
              f"only .txt sidecars extracted ({sorted(data_names)})", failures)
        dtxt = next(e for e in files if e["path"].endswith("languageinfo.txt"))
        check("EuropeanEnglish" in dtxt.get("text", ""),
              "txt preview captured in manifest", failures)

        # --- APK side ------------------------------------------------------
        sd = find("res/drawable", "splashdefault.png")
        check(sd is not None and sd["group"] == "apk"
              and sd["role"] == "splash-default" and sd["tier"] == "android"
              and sd["bundle"] == "Springfield-V08.apk",
              "apk splashdefault mapping (res/drawable/android)", failures)
        ss = find("core/core-splashes-large", "splashscreen_large.png")
        check(ss is not None and ss["role"] == "splash-strip"
              and ss["tier"] == "large" and ss["thumb"]
              and (assets / ss["thumb"]).exists(),
              "apk splashscreen_large -> core-splashes-large + thumb", failures)
        ld_a = find("core/core-large", "loading_donut.png")
        check(ld_a is not None and ld_a["role"] == "loading-donut"
              and ld_a["tab"] == "loading",
              "apk loading_donut -> core-large", failures)
        td_a = find("core/core-splashes-medium", "technicaldifficulties.png")
        check(td_a is not None and td_a["tab"] == "error",
              "apk technicaldifficulties -> core-splashes-medium/error",
              failures)
        check(not any(e["path"].endswith("thumb_loading_donut.png")
                      or e["path"].endswith("icon_gold.png") for e in files),
              "thumb_/ and non-boot apk files skipped", failures)
        au = {e["path"].rsplit("/", 1)[-1]: e for e in files
              if e["type"] == "audio"}
        check(set(au) == {"10_next_segment.wav", "bgloop.wav"},
              f"audio set exact ({sorted(au)})", failures)
        if "bgloop.wav" in au:
            check(au["bgloop.wav"].get("duration_s") == 0.2
                  and au["bgloop.wav"].get("kind") == "music",
                  "bgloop duration/kind recorded", failures)
        if "10_next_segment.wav" in au:
            check(au["10_next_segment.wav"].get("kind") == "sfx",
                  "sting kind=sfx", failures)

        # --- DLC-side splashes --------------------------------------------
        si = find("SplashAndBurnMenu-retina-r9",
                  "bse_splashandburn_minieventpanel_intro.png")
        check(si is not None and si["group"] == "dlc" and si["tab"] == "dlcsplash"
              and si["role"] == "dlc-splash-intro" and si["dlc"] == "SplashAndBurn"
              and si["tier"] == "retina" and si["revision"] == 9
              and si["bundle"] is None,
              "event intro -> dlc group, tab, role, dlc source", failures)
        if si:
            check(si["path"] == "dlc/SplashAndBurnMenu-retina-r9/images/"
                  "bse_splashandburn_minieventpanel_intro.png"
                  and si["thumb"] == "dlc/SplashAndBurnMenu-retina-r9/thumbs/"
                        "bse_splashandburn_minieventpanel_intro.png",
                  "dlc path/thumb stay in the dlc corpus", failures)
        so = find("SplashAndBurnMenu-retina-r9",
                  "bse_splashandburn_minieventpanel_outro.png")
        check(so is not None and so["role"] == "dlc-splash-outro",
              "event outro role", failures)
        ltd = find("AnimalFriendlyThanksgivingMenu_LTD-retina-r9",
                   "bse_animalfriendlythanksgiving_minieventpanel_intro.png")
        check(ltd is not None and ltd["dlc"] == "AnimalFriendlyThanksgiving",
              "_LTD variant merges under the base DLC name", failures)
        kf = find("KrustylandSplashes-ios-retina-r9", "fullscreen.png")
        check(kf is not None and kf["role"] == "dlc-splash"
              and kf["dlc"] == "Krustyland (ios)" and "ios" in kf["label"],
              "Krustyland fullscreen -> dlc-splash with os label", failures)
        check(not any(e["path"].endswith("bse_splashandburn_minieventpanel_mid.png")
                      or e["path"].endswith("ico_priz_splashandburn_prize1_lg.png")
                      or e["pack"] == "RandomEventMenu-retina-r9"
                      or e["path"].endswith("other.png")
                      for e in files),
              "non-splash dlc images + foreign fullscreen skipped", failures)
        nothumb = find("SplashAndBurnMenu-ipad-r9",
                       "bse_splashandburn_minieventpanel_intro.png")
        check(nothumb is not None and nothumb["thumb"] is None,
              "dlc entry without thumb dir gets thumb=None", failures)

        # --- consistency ---------------------------------------------------
        boot_paths = set()
        for e in files:
            if e["path"].startswith("boot/"):
                boot_paths.add(e["path"])
            if e.get("thumb") and e["thumb"].startswith("boot/"):
                boot_paths.add(e["thumb"])
        on_disk = sum(1 for p in (assets / "boot").rglob("*") if p.is_file()
                      and p.name != "boot-manifest.json")
        check(on_disk == len(boot_paths),
              f"boot files on disk ({on_disk}) == manifest paths "
              f"({len(boot_paths)}, {len(files)} entries)",
              failures)
        counts = {}
        for e in files:
            counts[e["tab"]] = counts.get(e["tab"], 0) + 1
        check(counts == man["counts"], "manifest counts match entries", failures)
        check(all(e["group"] == "apk" or e["group"] == "dlc"
                  or e["path"].startswith("boot/") for e in files)
              and all(not e["path"].startswith("boot/")
                      for e in files if e["group"] == "dlc"),
              "cdn paths under boot/; apk + dlc entries stay in place", failures)

        # --- generator -----------------------------------------------------
        js_dir = fx / "js"
        js_dir.mkdir()
        old_argv = sys.argv
        sys.argv = ["gen_boot_explorer.py", "--assets", str(assets),
                    "--js", str(js_dir)]
        try:
            rc = gen_boot_explorer.main()
        finally:
            sys.argv = old_argv
        check(rc == 0, "generator exit 0", failures)
        text = (js_dir / "boot-explorer-data.js").read_text()
        check(text.startswith("/* GENERATED by tools/gen_boot_explorer.py"),
              "data js GENERATED header", failures)
        check("window.BOOT_DATA = " in text, "data js window.BOOT_DATA", failures)
        payload = json.loads(text.split("window.BOOT_DATA = ", 1)[1]
                             .strip().rstrip(";"))
        check(len(payload["files"]) == len(files),
              "data js entry count matches manifest", failures)
        check(payload["counts"] == man["counts"],
              "data js counts match manifest", failures)

        print("PASS" if not failures else f"FAIL ({len(failures)})")
        return 1 if failures else 0
    finally:
        shutil.rmtree(fx, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
