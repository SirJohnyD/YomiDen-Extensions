#!/usr/bin/env python3
"""Lists sites where YDN publishes only one format (comic or novel) but the site likely has the other.

Signals (each row lists its evidence):
  lnr-filter   LNReader plugin source has filter options / genres labelled Manga, Manhwa, Manhua, Webtoon or Comic
  lncrawl      lightnovel-crawler crawler with has_manga = true
  kei-novel    Keiyoushi comic source whose domain is also a known novel site (LNReader plugin or lncrawl crawler)
  novel-kei    published novel site whose domain is also a Keiyoushi comic source

Usage: tools/cross-format-audit.py [--index dist/index.json] [--lnr <lnreader-plugins clone>] [--lnc <lncrawl clone>]
Writes cross-format-report.md at the repo root.
"""
import argparse
import json
import os
import re
import urllib.parse
from collections import defaultdict

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
COMIC_LABEL = re.compile(
    r"""label:\s*['"](Manga|Manhwa|Manhua|Webtoons?|Comics?)['"]|value:\s*['"](manga|manhwa|manhua|webtoon|comic)['"]""",
    re.I,
)
ID_RE = re.compile(r"""^\s*id\s*=\s*['"]([^'"]+)['"]""", re.M)
SITE_RE = re.compile(r"""^\s*site\s*=\s*['"]([^'"]+)['"]""", re.M)


def domain_of(url):
    if not url:
        return ""
    if "://" not in url:
        url = "https://" + url
    host = (urllib.parse.urlparse(url).hostname or "").lower().rstrip(".")
    for p in ("www.", "m."):
        if host.startswith(p):
            host = host[len(p):]
    return host


def published_formats(extensions):
    """domain -> {contentType: [entry names]}"""
    out = defaultdict(lambda: defaultdict(list))
    for e in extensions:
        domains = set(e.get("sites") or [])
        for s in e.get("sources") or []:
            d = domain_of(s.get("homeUrl", ""))
            if d:
                domains.add(d)
        for d in domains:
            out[d][e["contentType"]].append("%s (%s)" % (e["name"], e["origin"]))
    return out


def lnr_signals(lnr_root):
    """domain -> (plugin id, sorted labels) from plugin sources whose filters mention comic types."""
    out = {}
    base = os.path.join(lnr_root, "plugins")
    if not os.path.isdir(base):
        return out
    for lang in sorted(os.listdir(base)):
        d = os.path.join(base, lang)
        if lang == "multisrc" or not os.path.isdir(d):
            continue
        for fn in sorted(os.listdir(d)):
            if not fn.endswith(".ts"):
                continue
            text = open(os.path.join(d, fn), encoding="utf-8", errors="replace").read()
            labels = sorted({(m.group(1) or m.group(2)).title() for m in COMIC_LABEL.finditer(text)})
            site = SITE_RE.search(text)
            if labels and site:
                pid = ID_RE.search(text)
                out[domain_of(site.group(1))] = (pid.group(1) if pid else fn[:-3], labels)
    return out


def lncrawl_info(lnc_root):
    """(has_manga domains {domain: crawler file}, novel-crawler domains {domain: crawler file})"""
    path = os.path.join(lnc_root, "sources", "_index.json")
    manga, every = {}, {}
    if not os.path.exists(path):
        return manga, every
    for c in json.load(open(path, encoding="utf-8")).get("crawlers", {}).values():
        for u in c.get("base_urls") or []:
            d = domain_of(u)
            if c.get("has_manga"):
                manga[d] = c["file_path"]  # a comic crawler, not evidence of a novel site
            else:
                every[d] = c["file_path"]
    return manga, every


def build_rows(extensions, lnr_root, lnc_root):
    pub = published_formats(extensions)
    lnr = lnr_signals(lnr_root)
    lnc_manga, lnc_all = lncrawl_info(lnc_root)
    rows = defaultdict(lambda: {"have": set(), "missing": set(), "evidence": []})

    def add(domain, missing, evidence):
        have = set(pub.get(domain, {}))
        if not have or missing in have:
            return  # not published at all (out of scope), or already published in that format
        r = rows[domain]
        r["have"] = have
        r["missing"].add(missing)
        r["evidence"].append(evidence)

    for d, (pid, labels) in lnr.items():
        add(d, "comic", "LNReader `%s` filters/genres mention: %s" % (pid, ", ".join(labels)))
    for d, f in lnc_manga.items():
        add(d, "comic", "lncrawl `%s` has_manga = true" % f)
    novel_known = set(lnr) | set(lnc_all)
    for e in extensions:
        if e["origin"] == "lnreader":
            novel_known.update(e.get("sites") or [])
    for d in sorted(set(pub)):
        formats = set(pub[d])
        if "comic" in formats and "novel" not in formats and d in novel_known:
            src = lnc_all.get(d) or (lnr[d][0] if d in lnr else "an LNReader plugin")
            add(d, "novel", "Keiyoushi comic domain is also a novel site (%s) that is not published" % src)
        if "novel" in formats and "comic" not in formats:
            kei = [n for n in pub[d].get("comic", [])]
            if kei:
                add(d, "comic", "domain is in Keiyoushi: %s" % ", ".join(kei))
    return rows, pub


def render(rows, pub):
    lines = [
        "# Cross-format audit", "",
        "Sites where YDN publishes one format but the site likely has the other. Generated by "
        "`tools/cross-format-audit.py`; evidence is heuristic, verify on the site before acting.", "",
        "| site | we publish | likely missing | evidence |", "|---|---|---|---|",
    ]
    order = sorted(rows.items(), key=lambda kv: (-len(kv[1]["evidence"]), kv[0]))
    for d, r in order:
        have = ", ".join("%s: %s" % (t, "; ".join(pub[d][t])) for t in sorted(r["have"])) or "nothing"
        lines.append("| %s | %s | %s | %s |" % (
            d, have.replace("|", "/"), ", ".join(sorted(r["missing"])), "<br>".join(r["evidence"]).replace("|", "/"),
        ))
    lines += ["", "%d site(s)." % len(rows), ""]
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--index", default=os.path.join(ROOT, "dist", "index.json"))
    ap.add_argument("--lnr", default="/home/claude/up/lnr")
    ap.add_argument("--lnc", default="/home/claude/up/lnc")
    ap.add_argument("--out", default=os.path.join(ROOT, "cross-format-report.md"))
    a = ap.parse_args()
    extensions = json.load(open(a.index, encoding="utf-8"))["extensions"]
    rows, pub = build_rows(extensions, a.lnr, a.lnc)
    with open(a.out, "w", encoding="utf-8", newline="\n") as f:
        f.write(render(rows, pub))
    print("%d site(s) -> %s" % (len(rows), a.out))


if __name__ == "__main__":
    main()
