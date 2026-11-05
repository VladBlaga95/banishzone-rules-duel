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
  version.json           the versions fetched

Change SCRIPTS_AT / CDB_AT to update (python … --latest prints the newest commits; --cards remakes cards.json only).
"""
import io
import json
import sqlite3
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

SCRIPTS_AT = "2bd02f71383b87d7dee174909a96d10491930c45"    # ProjectIgnis/CardScripts, 2026-11-03
CDB_AT = "781ec580fb82ced7cd17bae290ee2985824a0def"        # ProjectIgnis/BabelCDB, 2026-11-03
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
            for row in db.execute("select id, " + ", ".join(f"str{i}" for i in range(1, 17)) + " from texts"):
                t = [x or "" for x in row[1:]]
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


def main():
    if "--latest" in sys.argv:
        for repo in ("CardScripts", "BabelCDB"):
            d = json.loads(get(f"https://api.github.com/repos/ProjectIgnis/{repo}/commits/master"))
            print(repo, d["sha"], d["commit"]["committer"]["date"])
        return
    OUT.mkdir(parents=True, exist_ok=True)
    n = 0
    if "--cards" not in sys.argv:                 # (--cards: the card data again, the scripts as they are)
        print("Fetching the card scripts…")
        n = scripts()
    print("Reading the card database…")
    c = cards()
    (OUT / "version.json").write_text(json.dumps({"scripts": SCRIPTS_AT, "cdb": CDB_AT}), encoding="utf-8")
    print(f"{OUT}: {n} scripts, {c} cards")


if __name__ == "__main__":
    main()
