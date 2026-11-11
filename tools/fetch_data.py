"""The Rules Duel's data, at fixed versions: Project Ignis' card scripts and card database, into
assets/duel-scripts/ (not in git — this fetches it again).

    python assets/duel-engine/tools/fetch_data.py            → assets/duel-scripts/

  official/c<code>.lua   a script per card (Project Ignis CardScripts, AGPL-3.0)
  *.lua                  the shared rule files the scripts use (constant.lua, utility.lua, proc_*.lua…)
  COPYING                the scripts' licence
  cards.json             each card as the engine's cardReader wants it — code, alias, archetype codes, type,
                         level, attribute, race, ATK, DEF, scales, Link Arrows — from BabelCDB's cards.cdb and
                         its release-*.cdb (sets just released)
  strings.json           each card's effect texts — what an effect's button says — {code: [str1, str2, …]}
                         (no text: the engine doesn't need it)
  system.json            EDOPro's own texts, by number — what a choice says when a script names one of them
                         ("Add to hand", 573) — {number: text}, from Project Ignis Distribution's config/strings.conf
  shared.json            the shared rule files as one — {name: text} — so a duel asks for them once, not one after
                         another (engine-worker.js); --shared makes it again from the files here, fetching nothing
  version.json           the versions fetched, and when
  last-update.json       what the last --update brought: the new cards, the cards that got their script

Updating — new cards and script fixes come out every week or so:

    python assets/duel-engine/tools/fetch_data.py --check     what's new since the versions here: how many commits,
                                                              new card scripts, changed ones — nothing downloaded
                                                              but those few lines (exit code 3: there is something)
    python assets/duel-engine/tools/fetch_data.py --update    this file's SCRIPTS_AT / CDB_AT / SYSTEM_AT moved to the
                                                              newest commits, everything fetched again, and what
                                                              came said: the new cards by name, the cards now scripted

Both players of a duel must run the same data (the duel is the same engine on each side): update, then deploy when
no duel is being played. (--latest prints the newest commits; --cards remakes cards.json only, --system system.json
only.)
"""
import datetime
import io
import json
import re
import sqlite3
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

SCRIPTS_AT = "d100052a19ddd4478967b215ffbbfb8232bdaacb"    # ProjectIgnis/CardScripts, 2026-11-11
CDB_AT = "0f17a0ce1e8980374ef577e076e20d11d6057ede"        # ProjectIgnis/BabelCDB, 2026-11-11
SYSTEM_AT = "54a6e2395c532648ff762540e9615319fac4f51b"     # ProjectIgnis/Distribution, 2026-08-12
MODULE = Path(__file__).resolve().parents[1]
# (in BanishZone: assets/duel-scripts/ beside the module; in the module's own repository: duel-scripts/ in it)
OUT = MODULE.parent / "duel-scripts" if MODULE.parent.name == "assets" else MODULE / "duel-scripts"


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "banishzone-duel"}), timeout=120) as r:
        return r.read()


def scripts():
    """The official scripts, the shared rule files and the licence, from the repository's archive at SCRIPTS_AT."""
    data = get(f"https://codeload.github.com/ProjectIgnis/CardScripts/tar.gz/{SCRIPTS_AT}")
    print(f"  CardScripts archive: {len(data) / 1e6:.1f} MB")
    n = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        for m in tar:
            if not m.isfile():
                continue
            parts = m.name.split("/")[1:]             # (past the archive's top folder)
            keep = (len(parts) == 1 and (parts[0].endswith(".lua") or parts[0] == "COPYING")) or \
                   (len(parts) == 2 and parts[0] == "official" and parts[1].endswith(".lua") and "/" not in parts[1])
            if not keep or ".." in parts:
                continue
            dest = OUT.joinpath(*parts)
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(tar.extractfile(m).read())
            n += 1
    return n


NAMES = {}     # (each card's name, as cards() reads it: to say which cards are new)
REPOS = (("scripts", "SCRIPTS_AT", "CardScripts"), ("cdb", "CDB_AT", "BabelCDB"), ("system", "SYSTEM_AT", "Distribution"))


def shared():
    """shared.json: the rule files beside official/ (constant.lua, utility.lua, proc_*.lua…) as one file."""
    out = {f.name: f.read_text(encoding="utf-8", errors="replace") for f in sorted(OUT.glob("*.lua"))}
    (OUT / "shared.json").write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    return len(out)


def cards():
    """cards.json from BabelCDB at CDB_AT (read here, not kept): cards.cdb, then each release-*.cdb — a set
    just released, kept apart until it's merged into cards.cdb (Blazing Eternity's, release-betb.cdb, in
    November 2026); a card in both: the release file's."""
    names = ["cards.cdb"] + sorted(f["name"] for f in json.loads(get(f"https://api.github.com/repos/ProjectIgnis/BabelCDB/contents/?ref={CDB_AT}"))
                                   if f["name"].startswith("release-") and f["name"].endswith(".cdb"))
    out, strs = {}, {}
    with tempfile.TemporaryDirectory() as tmp:
        for name in names:
            f = Path(tmp) / name
            f.write_bytes(get(f"https://raw.githubusercontent.com/ProjectIgnis/BabelCDB/{CDB_AT}/{name}"))
            db = sqlite3.connect(f"file:{f}?mode=ro", uri=True)
            for cid, alias, setcode, typ, level, attr, race, atk, df in db.execute(
                    "select id, alias, setcode, type, level, attribute, race, atk, def from datas"):
                link = typ & 0x4000000
                # (the last: 1 if it has a script — a Normal Monster needs none; an alternate artwork uses its alias's)
                scripted = int((OUT / "official" / f"c{alias or cid}.lua").is_file())
                out[cid] = [alias, [(setcode >> (16 * i)) & 0xffff for i in range(4) if (setcode >> (16 * i)) & 0xffff],
                            typ, level & 0xff, attr, race, atk, 0 if link else df, (level >> 24) & 0xff, (level >> 16) & 0xff, df if link else 0, scripted]
            # each card's effect texts (str1…str16): what an effect's button says ("Special Summon this card"…)
            for row in db.execute("select id, name, " + ", ".join(f"str{i}" for i in range(1, 17)) + " from texts"):
                NAMES[row[0]] = row[1] or ""
                t = [x or "" for x in row[2:]]
                while t and not t[-1]:
                    t.pop()
                if t:
                    strs[row[0]] = t
            db.close()
            print(f"  {name}")
    # (a list per card, to keep it small: the order is the engine's OcgCardData — see engine-worker.js)
    (OUT / "cards.json").write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    (OUT / "strings.json").write_text(json.dumps(strs, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    return len(out)


def system():
    """system.json: the "!system <number> <text>" lines of Distribution's config/strings.conf at SYSTEM_AT."""
    text = get(f"https://raw.githubusercontent.com/ProjectIgnis/Distribution/{SYSTEM_AT}/config/strings.conf").decode("utf-8")
    out = {}
    for line in text.splitlines():
        kind, _, rest = line.strip().partition(" ")
        num, _, words = rest.partition(" ")
        if kind == "!system" and num.isdigit() and words.strip():
            out[int(num)] = words.strip()
    (OUT / "system.json").write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    return len(out)


def pins():
    return {"scripts": SCRIPTS_AT, "cdb": CDB_AT, "system": SYSTEM_AT}


def latest():
    """Each repository's newest commit: {scripts | cdb | system: (sha, its date)}."""
    out = {}
    for key, _, repo in REPOS:
        d = json.loads(get(f"https://api.github.com/repos/ProjectIgnis/{repo}/commits/master"))
        out[key] = (d["sha"], d["commit"]["committer"]["date"][:10])
    return out


def check(new=None):
    """What's new since the versions pinned here, a line per repository — True if anything is. Reads GitHub's
    comparison of the two commits (its file list stops at 300: said when it does); downloads no scripts."""
    new, now, any_new = new or latest(), pins(), False
    for key, _, repo in REPOS:
        sha, date = new[key]
        if sha == now[key]:
            print(f"{repo}: up to date")
            continue
        any_new = True
        c = json.loads(get(f"https://api.github.com/repos/ProjectIgnis/{repo}/compare/{now[key]}...{sha}"))
        files = c.get("files") or []
        line = f"{repo}: {c.get('ahead_by', '?')} commit(s) newer, the last on {date}"
        if key == "scripts":
            official = [f for f in files if re.fullmatch(r"official/c\d+\.lua", f.get("filename", ""))]
            added = sum(1 for f in official if f.get("status") == "added")
            line += f" — {added} new card script(s), {len(official) - added} changed"
        elif key == "cdb":
            dbs = sorted({f.get("filename", "") for f in files if f.get("filename", "").endswith(".cdb")})
            line += " — " + (", ".join(dbs) if dbs else "no card database changed")
        if len(files) >= 300:
            line += " (or more: GitHub lists the first 300 files)"
        print(line)
    return any_new


def repin(new):
    """This file's SCRIPTS_AT / CDB_AT / SYSTEM_AT moved to `new` ({key: (sha, date)}), and the values in use here;
    the module's README.md names the same commits: changed there too."""
    path, readme, was = Path(__file__), MODULE / "README.md", pins()
    if readme.is_file():
        text = readme.read_bytes()
        for key, _, _ in REPOS:
            text = text.replace(was[key].encode(), new[key][0].encode())
        readme.write_bytes(text)
    src = path.read_bytes().decode("utf-8")
    for key, name, repo in REPOS:
        sha, date = new[key]
        src, n = re.subn(rf'(?m)^{name} = "[0-9a-f]{{40}}"[ \t]*#[^\r\n]*',
                         (f'{name} = "{sha}"').ljust(59) + f"# ProjectIgnis/{repo}, {date}", src)
        if n != 1:
            raise SystemExit(f"{name} not found in {path.name}: nothing changed")
        globals()[name] = sha
    path.write_bytes(src.encode("utf-8"))


def update():
    """--update: the newest versions pinned and fetched; what came, said and kept in last-update.json."""
    new = latest()
    if not check(new):
        print("Nothing new: the data is as it was.")
        return
    old_pins = pins()
    try:
        before = json.loads((OUT / "cards.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        before = {}
    repin(new)
    OUT.mkdir(parents=True, exist_ok=True)
    print("Fetching the card scripts…")
    n = scripts()
    shared()
    print("Reading the card database…")
    c = cards()
    print("Reading EDOPro's own texts…")
    t = system()
    today = datetime.date.today().isoformat()
    (OUT / "version.json").write_text(json.dumps({**pins(), "date": today}), encoding="utf-8")
    after = json.loads((OUT / "cards.json").read_text(encoding="utf-8"))
    name = lambda k: NAMES.get(int(k)) or f"#{k}"
    # (an alternate artwork — it has an alias — isn't a new card)
    fresh = sorted((name(k) for k in after if k not in before and not after[k][0]), key=str.lower)
    scripted = sorted((name(k) for k in after if k in before and after[k][11] and not before[k][11] and not after[k][0]), key=str.lower)
    (OUT / "last-update.json").write_text(json.dumps({"date": today, "from": old_pins, "to": pins(), "new": fresh, "scripted": scripted},
                                                     ensure_ascii=False), encoding="utf-8")
    print(f"{OUT}: {n} scripts, {c} cards, {t} system texts")
    for label, names in (("new card(s)", fresh), ("card(s) now scripted", scripted)):
        if before and names:
            print(f"{len(names)} {label}: " + ", ".join(names[:40]) + (f" and {len(names) - 40} more" if len(names) > 40 else ""))
    print("Next: python tools/export_engine_source.py (the pins are part of the public source), then deploy — when no duel is being played.")


def main():
    if hasattr(sys.stdout, "reconfigure"):          # (a Windows console: the names and dashes as they are)
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if "--latest" in sys.argv:
        for key, (sha, date) in latest().items():
            print(key, sha, date)
        return
    if "--check" in sys.argv:
        sys.exit(3 if check() else 0)
    if "--update" in sys.argv:
        update()
        return
    if "--shared" in sys.argv:
        print(f"{OUT}: {shared()} rule files in shared.json")
        return
    OUT.mkdir(parents=True, exist_ok=True)
    versions = {**pins(), "date": datetime.date.today().isoformat()}
    if "--system" in sys.argv:                    # (--system: EDOPro's own texts again, the rest as it is)
        print(f"{OUT}: {system()} system texts")
        (OUT / "version.json").write_text(json.dumps(versions), encoding="utf-8")
        return
    n = 0
    if "--cards" not in sys.argv:                 # (--cards: the card data again, the scripts as they are)
        print("Fetching the card scripts…")
        n = scripts()
        shared()
    print("Reading the card database…")
    c = cards()
    print("Reading EDOPro's own texts…")
    t = system()
    (OUT / "version.json").write_text(json.dumps(versions), encoding="utf-8")
    print(f"{OUT}: {n} scripts, {c} cards, {t} system texts")


if __name__ == "__main__":
    main()
