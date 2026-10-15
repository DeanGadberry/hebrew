#!/usr/bin/env python3
"""Fetch chosen lessons from the creators' torrent and tag them.

Used by .github/workflows/fetch-missing.yml. Downloads only the requested
files (not the whole 8-32 GB torrent), stops sharing once done, and tags each
lesson with scripts/tag.mjs so it matches the files the web page produces.

  python3 scripts/torrent_fetch.py --lessons missing --resolution 1080p --out tagged/
  python3 scripts/torrent_fetch.py --lessons 68,72 --list-only

Needs aria2c, ffmpeg and node on PATH.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.parse

# From https://freehebrew.online/offline/ ("Aleph with Beth 2026 - Lessons 1-156").
TRACKERS = [
    "http://199.19.226.87:16970/announce",
    "udp://tracker.openbittorrent.com:80/announce",
    "udp://www.torrent.eu.org:451/announce",
    "udp://tracker.torrent.eu.org:451/announce",
]
TORRENTS = {
    "1080p": ("2DF4DD7EA75BC5F68BDC7D4BCE59390B12AB15BD", "Aleph with Beth 2026 - Lessons 1-156 - 1080p"),
    "720p": ("C13A21E942CC5E73A3302908A169804C77A47BBD", "Aleph with Beth 2026 - Lessons 1-156 - 720p"),
    "480p": ("21B7F270EE23550C12CBFB6ABC5564BF75127764", "Aleph with Beth 2026 - Lessons 1-156 - 480p"),
}
VIDEO_EXT = (".mp4", ".m4v", ".mov", ".mkv")
LESSON_RE = re.compile(r"Lesson\s*0*(\d+)\s*([a-zA-Z]?)(?![a-zA-Z])", re.I)
# "138 - Lesson 68 - Killing in the Camp.mp4" (torrent) or
# "103 - A Tense Reunion-Lesson 60.mp4" (Internet Archive)
TITLE_AFTER_RE = re.compile(r"Lesson\s*\d+[a-zA-Z]?\s*[-–:]\s*(.+)$", re.I)
TITLE_BEFORE_RE = re.compile(r"^(?:\d+\s*[-.]\s*)?(.*?)\s*[-–]?\s*Lesson\s*\d+[a-zA-Z]?\s*$", re.I)


def magnet(resolution):
    btih, name = TORRENTS[resolution]
    params = [("xt", f"urn:btih:{btih}"), ("dn", name)] + [("tr", t) for t in TRACKERS]
    return "magnet:?" + urllib.parse.urlencode(params)


# --- minimal bencode decoder (enough for .torrent files) --------------------

def bdecode(data, i=0):
    c = data[i:i + 1]
    if c == b"i":
        end = data.index(b"e", i)
        return int(data[i + 1:end]), end + 1
    if c == b"l":
        i, out = i + 1, []
        while data[i:i + 1] != b"e":
            v, i = bdecode(data, i)
            out.append(v)
        return out, i + 1
    if c == b"d":
        i, out = i + 1, {}
        while data[i:i + 1] != b"e":
            k, i = bdecode(data, i)
            v, i = bdecode(data, i)
            out[k] = v
        return out, i + 1
    colon = data.index(b":", i)
    n = int(data[i:colon])
    return data[colon + 1:colon + 1 + n], colon + 1 + n


def torrent_files(path):
    """[(aria2 index (1-based), path relative to the download dir, size)] in torrent order.

    Multi-file torrents are saved inside a folder named after the torrent."""
    with open(path, "rb") as f:
        meta, _ = bdecode(f.read())
    info = meta[b"info"]
    if b"files" not in info:
        return [(1, info[b"name"].decode("utf-8", "replace"), info[b"length"])]
    out = []
    for n, entry in enumerate(info[b"files"], 1):
        parts = entry.get(b"path.utf-8") or entry[b"path"]
        rel = [info[b"name"]] + list(parts)
        out.append((n, "/".join(p.decode("utf-8", "replace") for p in rel), entry[b"length"]))
    return out


def lesson_key(path):
    name = os.path.basename(path)
    if not name.lower().endswith(VIDEO_EXT) or re.search(r"review game", name, re.I):
        return None
    m = LESSON_RE.search(name)
    return (int(m.group(1)), m.group(2).lower()) if m else None


def title_from(path):
    stem = os.path.splitext(os.path.basename(path))[0]
    for pattern in (TITLE_AFTER_RE, TITLE_BEFORE_RE):
        m = pattern.search(stem)
        title = (m.group(1) if m else "").strip(" -–")
        if title:
            return title
    return None


def run(cmd, **kw):
    print("+", " ".join(cmd), flush=True)
    return subprocess.run(cmd, check=True, **kw)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lessons", default="missing", help='"missing" (default) or e.g. "68,72,74"')
    ap.add_argument("--resolution", default="1080p", choices=sorted(TORRENTS))
    ap.add_argument("--catalog", default="site/catalog.json")
    ap.add_argument("--work", default="work")
    ap.add_argument("--out", default="tagged")
    ap.add_argument("--list-only", action="store_true")
    args = ap.parse_args()

    with open(args.catalog, encoding="utf-8") as f:
        catalog = json.load(f)
    if args.lessons.strip().lower() == "missing":
        wanted = set(catalog.get("missingLessons", []))
    else:
        wanted = {int(x) for x in re.findall(r"\d+", args.lessons)}
    if not wanted:
        print("Nothing to fetch: no lessons requested / none missing.")
        return

    os.makedirs(args.work, exist_ok=True)
    torrent = os.path.join(args.work, TORRENTS[args.resolution][0].lower() + ".torrent")
    if not os.path.exists(torrent):
        run(["aria2c", "--bt-metadata-only=true", "--bt-save-metadata=true", "--enable-dht=true",
             "--bt-stop-timeout=600", f"--dir={args.work}", "--summary-interval=30", magnet(args.resolution)])
    files = torrent_files(torrent)

    chosen = {}
    for index, path, size in files:
        key = lesson_key(path)
        if key and key[0] in wanted and key[1] == "":
            chosen[key[0]] = (index, path, size)
    print(f"\n{len(files)} files in the torrent; matched {len(chosen)} of {len(wanted)} lessons:")
    for n in sorted(wanted):
        hit = chosen.get(n)
        print(f"  Lesson {n}: {hit[1] + f' ({hit[2] / 1e6:.0f} MB)' if hit else 'NOT FOUND'}")
    if args.list_only:
        return
    if not chosen:
        sys.exit("None of the requested lessons are in the torrent (see the file list above).")

    select = ",".join(str(chosen[n][0]) for n in sorted(chosen))
    run(["aria2c", f"--select-file={select}", "--seed-time=0", "--enable-dht=true", "--file-allocation=none",
         "--bt-stop-timeout=1800", "--summary-interval=60", "--console-log-level=warn",
         f"--dir={args.work}", torrent])

    os.makedirs(args.out, exist_ok=True)
    tagged = []
    for n in sorted(chosen):
        _, path, _ = chosen[n]
        src = os.path.join(args.work, path)
        if not os.path.exists(src):
            sys.exit(f"Downloaded file not found: {src}")
        art = os.path.join(args.work, f"cover-{n}.jpg")
        # Cover art: a frame a few seconds in (the title card).
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", "4", "-i", src, "-frames:v", "1",
                        "-vf", "scale=1280:-2", "-q:v", "3", art], check=False)
        cmd = ["node", "scripts/tag.mjs", "--catalog", args.catalog, "--lesson", str(n)]
        title = title_from(path)
        if title:
            cmd += ["--title", title]
        if os.path.exists(art):
            cmd += ["--art", art]
        out = subprocess.run(cmd + [src, args.out], check=True, capture_output=True, text=True).stdout.strip()
        tagged.append(out)
        os.remove(src)  # keep runner disk use low
        print(f"tagged {out}", flush=True)

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(f"### Fetched {len(tagged)} lesson(s) from the {args.resolution} torrent\n\n")
            f.write("\n".join(f"- {os.path.basename(t)}" for t in tagged) + "\n")
            missed = sorted(wanted - set(chosen))
            if missed:
                f.write(f"\nNot in the torrent: {', '.join(map(str, missed))}\n")


if __name__ == "__main__":
    main()
