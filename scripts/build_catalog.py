#!/usr/bin/env python3
"""Build site/catalog.json from the Aleph with Beth channel on Lets.Church.

Uses the same public API the Lets.Church website uses (no account needed).
Every video is sorted into a "season" so the Apple TV app shows the course as
one TV show, in teaching order:

  1 Lessons            ordered by lesson number ("58b" right after "58");
                       gaps are filled from the Internet Archive where possible
  2 Review Games       ordered by the lessons they review
  3 Easy Stories       ordered by story number
  4 Worship & Songs    ordered by publish date
  5 Extras             everything else, by publish date

Usage: python3 scripts/build_catalog.py [output.json]
"""

import datetime
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

API = "https://lets.church/trpc/"
CHANNEL = "AlephwithBeth"
SHOW = "Aleph with Beth"
USER_AGENT = "aleph-with-beth-offline/1.0 (+https://github.com/DeanGadberry/hebrew)"

# Internet Archive items used to fill lessons Lets.Church doesn't have.
# (The relay only serves items listed in relay/worker.js ARCHIVE_ITEMS.)
ARCHIVE_ITEMS = ["aleph-with-beth-lessons-1-66-1080p"]
# The creators' torrents hold lessons 1-156 (https://freehebrew.online/offline/).
TORRENT_LAST_LESSON = 156
# Titles/sizes from the torrent's file list (written by the "Index torrent" workflow).
TORRENT_INDEX = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "site", "torrent-index.json")
ARCHIVE_LESSON_RE = re.compile(r"^(?:\d+\s*-\s*)?(.*?)\s*-\s*Lesson (\d+)([a-zA-Z]?)\.mp4$")

SEASONS = {
    1: "Lessons",
    2: "Review Games",
    3: "Easy Stories",
    4: "Worship & Songs",
    5: "Extras",
}

LESSON_RE = re.compile(r"\bLesson (\d+)([a-zA-Z]?)\b")
REVIEW_RE = re.compile(r"Review Game", re.I)
REVIEW_NUM_RE = re.compile(r"Lessons? (\d+)")
STORY_RE = re.compile(r"\bEasy Story (\d+)\b")
WORSHIP_RE = re.compile(r"worship|\bsong\b|psalm|תְּהִלִּים|blessing", re.I)

# Title parts that only repeat what the show/season already says.
NOISE_RE = re.compile(
    r"^(?:(?:Free |Communicative )?Biblical Hebrew(?: Easy Stories)?|Hebrew|Aleph with Beth|"
    r"Lesson \d+[a-z]?|Easy Story \d+)$",
    re.I,
)


def api(procedure, payload, attempts=4):
    url = API + procedure + "?input=" + urllib.parse.quote(json.dumps({"json": payload}))
    for attempt in range(attempts):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.load(resp)["result"]["data"]["json"]
        except Exception:
            if attempt == attempts - 1:
                raise
            time.sleep(2 ** (attempt + 1))


def fetch_channel():
    items, cursor = [], None
    while True:
        payload = {"slug": CHANNEL}
        if cursor:
            payload["cursor"] = cursor
        page = api("channel.getChannelMedia", payload)
        items += page["items"]
        cursor = page.get("nextCursor")
        if not cursor or not page["items"]:
            return items


def fetch_archive_lessons():
    """Lessons in the Internet Archive items: {(number, suffix): episode-fields}."""
    found = {}
    for item in ARCHIVE_ITEMS:
        req = urllib.request.Request(f"https://archive.org/metadata/{item}", headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=60) as resp:
            meta = json.load(resp)
        files = meta.get("files", [])
        thumbs = {}
        for f in files:
            if f.get("format") == "Thumbnail" and f.get("original"):
                thumbs.setdefault(f["original"], []).append(f["name"])
        for f in files:
            m = ARCHIVE_LESSON_RE.match(f["name"]) if f.get("source") == "original" else None
            if not m or not f.get("length"):
                continue
            name, number, suffix = m.group(1).strip(), int(m.group(2)), m.group(3).lower()
            thumb = sorted(thumbs.get(f["name"], []))
            found[(number, suffix)] = {
                "name": name or f"Lesson {number}{suffix}",
                "duration": round(float(f["length"])),
                "size": int(f.get("size") or 0),
                "height": int(f.get("height") or 0),
                "archive": {"item": item, "file": f["name"], "thumb": thumb[0] if thumb else None},
                "thumbnail": (
                    f"https://archive.org/download/{item}/{urllib.parse.quote(thumb[0])}" if thumb else None
                ),
            }
    return found


TV_SEASONS = {1: "Course", 2: "Worship & Songs", 3: "Extras"}
REVIEW_KEY_RE = re.compile(r"Lessons?\s*(\d+)(?:\s*[-–]\s*(\d+))?", re.I)


def load_torrent_index():
    try:
        with open(TORRENT_INDEX, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return {}


def title_words(text):
    """English words of a title, for matching story/song names across sources."""
    text = re.sub(r"[\u0590-\u05ff]+", " ", text or "")
    text = re.sub(r"\b(easy stor(y|ies)|biblical hebrew|hebrew worship|free|lesson \d+[a-z]?|story \d+)\b", " ", text, flags=re.I)
    return {w for w in re.findall(r"[a-z0-9]+", text.lower()) if len(w) > 1 and w not in {"the", "and", "of", "to", "a"}}


def course_key(kind, title):
    """Key that identifies the same lesson / review game in both sources."""
    if kind == "lesson":
        m = LESSON_RE.search(title)
        return ("lesson", int(m.group(1)), m.group(2).lower()) if m else None
    if kind == "review":
        m = REVIEW_KEY_RE.search(title)
        return ("review", int(m.group(1)), int(m.group(2) or m.group(1))) if m else None
    return None


def add_tv_order(episodes, order):
    """Number every episode for the TV app.

    Season 1 "Course" follows the creators' own watching order (the numbered
    files in their torrent: lessons with their review games, stories and songs
    in between). Episodes newer than the torrent follow by publish date.
    Remaining songs and extras become seasons 2 and 3.
    """
    kind_of = {1: "lesson", 2: "review", 3: "story", 4: "worship", 5: "extra"}
    main = [o for o in order if not o.get("folder")]
    by_key, by_words = {}, []
    for o in main:
        name = o["name"]
        if re.search(r"review game", name, re.I):
            k = course_key("review", name)
        elif LESSON_RE.search(name):
            k = course_key("lesson", name)
        else:
            k = None
        if k:
            by_key.setdefault(k, o["seq"])
        else:
            by_words.append((o["seq"], title_words(name)))

    placed, unplaced = [], []
    used_seq = set()
    for ep in episodes:
        kind = kind_of[ep["season"]]
        seq = None
        k = course_key(kind, ep["sourceTitle"])
        if k and k in by_key:
            seq = by_key[k]
        elif kind in ("story", "worship", "extra"):
            words = title_words(ep["sourceTitle"])
            best, best_score = None, 0.0
            for s_, w in by_words:
                if not words or not w or s_ in used_seq:
                    continue
                score = len(words & w) / len(words | w)
                if score > best_score:
                    best, best_score = s_, score
            if best is not None and best_score >= 0.6:
                seq = best
        if seq is not None:
            used_seq.add(seq)
            placed.append((seq, ep))
        elif kind in ("lesson", "review", "story"):
            unplaced.append(ep)

    course = [ep for _, ep in sorted(placed, key=lambda x: x[0])]
    # Newer than the torrent: slot in after the last course item published before it.
    for ep in sorted(unplaced, key=lambda e: e.get("publishedAt") or ""):
        when = ep.get("publishedAt") or ""
        at = len(course)
        while at > 0 and (course[at - 1].get("publishedAt") or "") > when:
            at -= 1
        course.insert(at, ep)

    in_course = {id(ep) for ep in course}
    for n, ep in enumerate(course, 1):
        ep["tvSeason"], ep["tvEpisode"] = 1, n
    for season, kind in ((2, "worship"), (3, "extra")):
        rest = [ep for ep in episodes if id(ep) not in in_course and kind_of[ep["season"]] == kind]
        for n, ep in enumerate(rest, 1):
            ep["tvSeason"], ep["tvEpisode"] = season, n


def number_of(placeholder_id):
    return int(placeholder_id.rsplit("-", 1)[1])


def clean_title(title):
    parts = [p.strip() for p in re.split(r"\s+[-–־]\s+", title)]
    kept = [p for p in parts if p and not NOISE_RE.match(p)]
    return " - ".join(kept) or title.strip()


def short_description(text):
    # Every description ends with the same block of links; keep the lesson's own words.
    text = (text or "").strip()
    cut = re.search(r"\n\s*\n|Visit https?://freehebrew\.online", text)
    head = text[: cut.start()] if cut else text
    return head.strip()


def classify(item):
    title = item["title"]
    published = item.get("publishedAt") or item.get("createdAt") or ""
    if REVIEW_RE.search(title):
        m = REVIEW_NUM_RE.search(title)
        return 2, (int(m.group(1)) if m else 0, published), None
    story = STORY_RE.search(title)
    if story:
        return 3, (int(story.group(1)), published), f"Easy Story {story.group(1)}"
    lesson = LESSON_RE.search(title)
    if lesson:
        number, suffix = int(lesson.group(1)), lesson.group(2).lower()
        return 1, (number, suffix), f"Lesson {number}{suffix}"
    if WORSHIP_RE.search(title):
        return 4, (published,), None
    return 5, (published,), None


def build(items, archive_lessons=None):
    by_season = {n: {} for n in SEASONS}
    for item in items:
        if not item.get("lengthSeconds"):
            continue  # live streams / unprocessed uploads
        season, key, label = classify(item)
        published = item.get("publishedAt") or item.get("createdAt") or ""
        # Lessons that were re-uploaded: keep the newest copy.
        dedupe = key if season == 1 else (item["id"],)
        current = by_season[season].get(dedupe)
        if current and (current[0].get("publishedAt") or "") >= published:
            continue
        by_season[season][dedupe] = (item, key, label)

    # Patch lessons Lets.Church is missing with Internet Archive copies.
    for key, extra in (archive_lessons or {}).items():
        if key in by_season[1]:
            continue
        label = f"Lesson {key[0]}{key[1]}"
        item = {
            "id": f"ia-{key[0]}{key[1]}",
            "title": f"{extra['name']} - Lesson {key[0]}{key[1]}",
            "description": "",
            "lengthSeconds": extra["duration"],
            "thumbnailUrl": extra["thumbnail"],
            "_archive": extra,
        }
        by_season[1][key] = (item, key, label)

    # Whatever is still missing comes from the creators' torrent (lessons 1-156),
    # fetched by the "Fetch missing lessons" workflow. Placeholders keep the
    # episode numbers stable and let the page offer them.
    torrent_index = load_torrent_index().get("lessons", {})
    have = set(by_season[1])
    top = max((key[0] for key in have), default=0)
    for number in range(1, min(top, TORRENT_LAST_LESSON) + 1):
        if (number, "") in have:
            continue
        key = (number, "")
        known = torrent_index.get(str(number), {})
        by_season[1][key] = ({
            "id": f"torrent-{number}",
            "title": f"{known['title']} - Lesson {number}" if known.get("title") else f"Lesson {number}",
            "_size": known.get("size"),
            "description": "",
            "lengthSeconds": 0,
            "thumbnailUrl": None,
            "_torrent": True,
        }, key, f"Lesson {number}")

    episodes = []
    for season, entries in by_season.items():
        ordered = sorted(entries.values(), key=lambda e: e[1])
        for number, (item, _key, label) in enumerate(ordered, 1):
            name = clean_title(item["title"])
            episodes.append({
                "id": item["id"],
                "season": season,
                "episode": number,
                "label": label,
                "title": f"{label} – {name}" if label and name != label else name,
                "sourceTitle": item["title"],
                "description": short_description(item.get("description")),
                "longDescription": (item.get("description") or "").strip(),
                "publishedAt": item.get("publishedAt"),
                "duration": round(item["lengthSeconds"]),
                "thumbnail": item.get("thumbnailUrl"),
            })
            if item.get("_torrent"):
                episodes[-1].update({"source": "torrent", "lesson": number_of(item["id"])})
                if item.get("_size"):
                    episodes[-1]["size"] = item["_size"]
            extra = item.get("_archive")
            if extra:
                episodes[-1].update({
                    "source": "archive",
                    "archive": extra["archive"],
                    "size": extra["size"],
                    "height": extra["height"],
                })

    missing = sorted(e["lesson"] for e in episodes if e.get("source") == "torrent")
    add_tv_order(episodes, load_torrent_index().get("order", []))

    return {
        "show": SHOW,
        "channel": f"https://lets.church/channel/{CHANNEL}",
        "license": "Public domain (freely given, Matt 10:8)",
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "seasons": [
            {"number": n, "name": name, "count": sum(1 for e in episodes if e["season"] == n)}
            for n, name in SEASONS.items()
        ],
        # How files are tagged for the TV app: one "Course" season in the
        # creators' watching order, then the songs and extras left over.
        "tvSeasons": [
            {"number": n, "name": name, "count": sum(1 for e in episodes if e["tvSeason"] == n)}
            for n, name in TV_SEASONS.items()
        ],
        # Lesson numbers neither Lets.Church nor the Internet Archive items have;
        # they're listed as "torrent" episodes (see .github/workflows/fetch-missing.yml).
        "missingLessons": missing,
        "episodes": episodes,
    }


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "site/catalog.json"
    catalog = build(fetch_channel(), fetch_archive_lessons())
    if len(catalog["episodes"]) < 100:
        sys.exit(f"Only {len(catalog['episodes'])} episodes found; refusing to overwrite the catalog")

    # Keep the file byte-identical when nothing changed, so the nightly job doesn't commit noise.
    try:
        with open(out, encoding="utf-8") as f:
            previous = json.load(f)
        if {**previous, "generatedAt": None} == {**catalog, "generatedAt": None}:
            print(f"{out}: unchanged ({len(catalog['episodes'])} episodes)")
            return
    except (FileNotFoundError, ValueError):
        pass

    with open(out, "w", encoding="utf-8") as f:
        json.dump(catalog, f, ensure_ascii=False, indent=1)
        f.write("\n")
    counts = ", ".join(f"{s['name']}: {s['count']}" for s in catalog["seasons"])
    print(f"{out}: {len(catalog['episodes'])} episodes ({counts})")


if __name__ == "__main__":
    main()
