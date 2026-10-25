#!/usr/bin/env python3
"""YDN catalog aggregator (spec 5.1 / 5.5). Python 3 stdlib only.

Fetches Keiyoushi (APK), LNReader (JS) and the lncrawl index, merges them with the plugins produced by
tools/lncrawl-gen, de-duplicates by domain (priority keiyoushi > lnreader > lncrawl), applies overrides.json and
writes dist/index.json, dist/report.md and dist/dedupe-review.md.

All paths are relative to this script (tools/..), so the folder can live anywhere (e.g. be the repo root).
Usage: python3 tools/aggregate.py [--offline]   (offline = reuse .cache/upstream/*.json)
"""
import concurrent.futures as cf
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
CACHE = os.path.join(ROOT, ".cache")
DIST = os.path.join(ROOT, "dist")
PLUGINS = os.path.join(ROOT, "plugins")
PUBLIC_BASE = os.environ.get("YDN_PUBLIC_BASE", "https://raw.githubusercontent.com/SirJohnyD/yomiden-extensions/main/")

KEI_INDEX = "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.json"
KEI_ASSETS = "https://raw.githubusercontent.com/keiyoushi/extensions/repo/release-assets.json"
LNR_INDEX = "https://raw.githubusercontent.com/LNReader/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json"
LNCRAWL_INDEX = "https://raw.githubusercontent.com/lncrawl/lightnovel-crawler/%s/sources/_index.json"
LNCRAWL_BRANCHES = ["dev", "master", "main"]

LNR_LANG = {
    "English": "en", "Русский": "ru", "العربية": "ar", "Español": "es", "Français": "fr", "Türkçe": "tr",
    "Português": "pt", "Bahasa Indonesia": "id", "中文, 汉语, 漢語": "zh", "Tiếng Việt": "vi", "日本語": "ja",
    "조선말, 한국어": "ko", "ไทย": "th", "Українська": "uk", "বাংলা": "bn", "Polski": "pl", "Multi": "multi",
}
SECOND_LEVEL = {"co", "com", "org", "net", "ac", "gov", "edu", "or", "ne"}


def log(*a):
    print("[aggregate]", *a, file=sys.stderr)


def http_get(url, retries=3):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "yomiden-ydn-aggregate"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read(), dict(r.headers)
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last = e
            if isinstance(e, urllib.error.HTTPError) and e.code in (403, 404):
                break
            time.sleep(1 + i)
    raise RuntimeError("GET %s failed: %s" % (url, last))


def fetch_json(url, name, offline):
    path = os.path.join(CACHE, "upstream", name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if offline and os.path.exists(path):
        with open(path, "rb") as f:
            return json.loads(f.read()), None
    body, headers = http_get(url)
    with open(path, "wb") as f:
        f.write(body)
    return json.loads(body), headers.get("ETag") or headers.get("Etag")


def github_commit(repo, branch):
    """Best-effort head commit of a branch (unauthenticated API may be rate limited -> None)."""
    try:
        headers = {"User-Agent": "yomiden-ydn-aggregate", "Accept": "application/vnd.github+json"}
        if os.environ.get("GITHUB_TOKEN"):
            headers["Authorization"] = "Bearer " + os.environ["GITHUB_TOKEN"]
        req = urllib.request.Request("https://api.github.com/repos/%s/commits/%s" % (repo, branch), headers=headers)
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())["sha"]
    except Exception:
        return None


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


def name_key(domain):
    """'topmanhua.com' / 'topmanhua.fan' / 'www.top-manhua.co.uk' -> 'topmanhua'."""
    labels = domain.split(".")
    if len(labels) > 1:
        labels = labels[:-1]
        if len(labels) > 1 and labels[-1] in SECOND_LEVEL:
            labels = labels[:-1]
    return re.sub(r"[^a-z0-9]", "", labels[-1]) if labels else ""


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def favicon(domain):
    return "https://www.google.com/s2/favicons?sz=128&domain=" + domain


# ---------------------------------------------------------------------------------------------------------------
def build_keiyoushi(index, assets):
    signer = index.get("signingKey")
    out, mismatched = [], 0
    for e in index["extensionList"]["extensions"]:
        pkg = e["packageName"]
        sources = [
            {"id": str(s.get("id", "")), "name": s.get("name", ""), "lang": s.get("language", ""), "homeUrl": s.get("homeUrl", "")}
            for s in e.get("sources", [])
        ]
        langs = {s["lang"] for s in sources if s["lang"]}
        pkg_lang = pkg.split(".extension.")[-1].split(".")[0]
        lang = next(iter(langs)) if len(langs) == 1 else ("all" if pkg_lang == "all" else "multi")
        apk_url = e["resources"]["apkUrl"]
        asset = (assets.get(pkg) or {}).get("apk") or {}
        sha = asset.get("sha256")
        if sha and asset.get("name") != apk_url.rsplit("/", 1)[-1]:
            sha, mismatched = None, mismatched + 1
        sites = sorted({d for d in (domain_of(s["homeUrl"]) for s in sources) if d})
        out.append({
            "id": pkg, "name": e["name"], "lang": lang, "contentType": "comic",
            "nsfw": "NSFW" in str(e.get("contentWarning", "")).upper(), "origin": "keiyoushi", "package": "apk",
            "version": e.get("versionName", ""), "versionCode": int(e["versionCode"]), "url": apk_url, "sha256": sha,
            "iconUrl": e["resources"].get("iconUrl", ""), "sites": sites, "signer": signer, "sources": sources,
            "needsReview": False,
        })
    return out, mismatched


def build_lnreader(plugins):
    cache_dir = os.path.join(CACHE, "lnreader")
    os.makedirs(cache_dir, exist_ok=True)

    def fetch(p):
        path = os.path.join(cache_dir, re.sub(r"[^\w.-]", "_", "%s-%s.js" % (p["id"], p["version"])))
        if not os.path.exists(path):
            url = urllib.parse.quote(p["url"], safe=":/%")
            body, _ = http_get(url)
            with open(path + ".tmp", "wb") as f:
                f.write(body)
            os.replace(path + ".tmp", path)
        return sha256_file(path)

    with cf.ThreadPoolExecutor(8) as ex:
        shas = list(ex.map(lambda p: _safe(fetch, p), plugins))
    out, unknown_lang, failed = [], set(), []
    for p, sha in zip(plugins, shas):
        if sha is None:
            failed.append(p["id"])
            continue
        raw_lang = p.get("lang", "").replace("‎", "").strip()
        lang = LNR_LANG.get(raw_lang)
        if not lang:
            unknown_lang.add(raw_lang)
            lang = re.sub(r"[^a-z]", "", raw_lang.lower()) or "multi"
        d = domain_of(p.get("site", ""))
        out.append({
            "id": p["id"], "name": p["name"], "lang": lang, "contentType": "novel", "nsfw": False, "origin": "lnreader",
            "package": "js", "version": p["version"], "versionCode": None, "url": p["url"], "sha256": sha,
            "iconUrl": p.get("iconUrl", ""), "sites": [d] if d else [], "signer": None, "sources": [], "needsReview": False,
        })
    return out, sorted(unknown_lang), failed


def _safe(fn, x):
    try:
        return fn(x)
    except Exception as e:
        log("failed:", x.get("id"), e)
        return None


def build_lncrawl(manifest):
    out = []
    for p in manifest["plugins"]:
        path = os.path.join(ROOT, p["path"])
        sha = sha256_file(path)
        sites = []
        for u in p["baseUrls"]:
            d = domain_of(u)
            if d and d not in sites:
                sites.append(d)
        out.append({
            "id": p["id"], "name": p["name"], "lang": p["lang"], "contentType": p["contentType"], "nsfw": False,
            "origin": "lncrawl", "package": "js", "version": p["version"], "versionCode": None,
            "url": PUBLIC_BASE + p["path"], "sha256": sha, "iconUrl": favicon(sites[0]), "sites": sites, "signer": None,
            "sources": [], "needsReview": False,
            "upstream": {"file": p["file"], "commit": manifest["lncrawl"]["commit"], "template": p["template"], "customized": p["customized"]},
        })
    return out


# ---------------------------------------------------------------------------------------------------------------
def dedupe(kei, lnr, lnc, overrides, rejected_domains):
    """Returns (published_lnr, published_lnc, skipped[list of dict], review[list of dict], notes)."""
    # Matching is per content type: a comic extension never hides a novel plugin for the same domain (and vice versa).
    kei_domains = defaultdict(list)
    for e in kei:
        for d in e["sites"]:
            kei_domains[(e["contentType"], d)].append(e)
    skipped, review, notes = [], [], []

    pub_lnr = []
    lnr_domains = defaultdict(list)
    for e in lnr:
        hit = next((kei_domains[(e["contentType"], d)][0] for d in e["sites"] if (e["contentType"], d) in kei_domains), None)
        if hit:
            skipped.append({"origin": "lnreader", "id": e["id"], "name": e["name"], "reason": "same domain as keiyoushi: %s" % hit["name"]})
            continue
        pub_lnr.append(e)
        for d in e["sites"]:
            lnr_domains[(e["contentType"], d)].append(e)

    ov = {domain_of(o["domain"]): o for o in overrides.get("sites", [])}
    for d, o in ov.items():
        if o.get("use", {}).get("origin") == "keiyoushi":
            want = o["use"].get("extension", "").lower()
            if not any(e["name"].lower() == want for e in kei):
                notes.append("override for %s names keiyoushi extension '%s', which is not in the current index" % (d, o["use"]["extension"]))

    pub_lnc, seen = [], {}
    other_keys = defaultdict(list)  # name key -> higher priority entries
    for e in kei + pub_lnr:
        for d in e["sites"]:
            other_keys[(e["contentType"], name_key(d))].append((d, e))
    for e in sorted(lnc, key=lambda x: x["id"]):
        rej = [d for d in e["sites"] if d in rejected_domains]
        live = [d for d in e["sites"] if d not in rejected_domains]
        if not live:
            skipped.append({"origin": "lncrawl", "id": e["id"], "name": e["name"], "reason": "rejected by lncrawl: " + rejected_domains[rej[0]]})
            continue
        o = next((ov[d] for d in e["sites"] if d in ov), None)
        decision = o["decision"] if o else None
        if decision == "skip":
            use = o.get("use")
            extra = " (use %s %s)" % (use["origin"], use["extension"]) if use else ""
            skipped.append({"origin": "lncrawl", "id": e["id"], "name": e["name"], "reason": "override skip: %s%s" % (o.get("reason", ""), extra)})
            continue
        if decision != "keep":
            ct = e["contentType"]
            hit = next(((d, (kei_domains.get((ct, d)) or lnr_domains.get((ct, d)))[0]) for d in live if kei_domains.get((ct, d)) or lnr_domains.get((ct, d))), None)
            if hit:
                skipped.append({"origin": "lncrawl", "id": e["id"], "name": e["name"], "reason": "same domain as %s: %s" % (hit[1]["origin"], hit[1]["name"])})
                continue
        first = next((d for d in live if (e["contentType"], d) in seen), None)
        if first:
            skipped.append({"origin": "lncrawl", "id": e["id"], "name": e["name"], "reason": "same domain as lncrawl plugin %s" % seen[(e["contentType"], first)]})
            continue
        if decision != "keep":
            similar = [(d, od, oe) for d in live for (od, oe) in other_keys.get((e["contentType"], name_key(d)), []) if od != d]
            if similar:
                e["needsReview"] = True
                review.append({"id": e["id"], "name": e["name"], "domain": similar[0][0], "other_domain": similar[0][1], "other": "%s (%s)" % (similar[0][2]["name"], similar[0][2]["origin"])})
        for d in live:
            seen[(e["contentType"], d)] = e["id"]
        e["sites"] = live
        pub_lnc.append(e)
    return pub_lnr, pub_lnc, skipped, review, notes


def render_report(catalog, skipped, review, notes, extras):
    c = Counter((e["origin"], e["contentType"]) for e in catalog["extensions"])
    lines = ["# YDN catalog report", "", "Generated at %s" % catalog["generatedAt"], "", "## Published", "", "| origin | comic | novel | total |", "|---|---|---|---|"]
    for o in ("keiyoushi", "lnreader", "lncrawl"):
        lines.append("| %s | %d | %d | %d |" % (o, c[(o, "comic")], c[(o, "novel")], c[(o, "comic")] + c[(o, "novel")]))
    lines.append("| **all** | %d | %d | %d |" % (sum(v for (o, t), v in c.items() if t == "comic"), sum(v for (o, t), v in c.items() if t == "novel"), len(catalog["extensions"])))
    lines += ["", "Flagged `needsReview`: %d (see dedupe-review.md)" % len(review), ""]
    for k, v in extras.items():
        lines.append("- %s: %s" % (k, v))
    for n in notes:
        lines.append("- NOTE: " + n)
    lines += ["", "## Skipped by de-dup (%d)" % len(skipped), "", "| origin | id | name | reason |", "|---|---|---|---|"]
    for s in sorted(skipped, key=lambda s: (s["origin"], s["id"])):
        lines.append("| %s | %s | %s | %s |" % (s["origin"], s["id"], s["name"], s["reason"]))
    return "\n".join(lines) + "\n"


def render_review(review):
    lines = ["# De-dup review", "", "Published lncrawl plugins whose site name matches a Keiyoushi / LNReader site on a different domain.",
             "They are NOT skipped (`needsReview: true`). Decide each in `overrides.json`: `keep` or `skip` (optionally with `use`).", ""]
    if not review:
        lines.append("Nothing to review.")
    else:
        lines += ["| plugin | its domain | looks like | their domain |", "|---|---|---|---|"]
        for r in sorted(review, key=lambda r: r["id"]):
            lines.append("| %s (`%s`) | %s | %s | %s |" % (r["name"], r["id"], r["domain"], r["other"], r["other_domain"]))
    return "\n".join(lines) + "\n"


def write_if_changed(path, text):
    old = None
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            old = f.read()
    if old != text:
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        return True
    return False


def main():
    offline = "--offline" in sys.argv
    with open(os.path.join(ROOT, "overrides.json"), encoding="utf-8") as f:
        overrides = json.load(f)
    with open(os.path.join(PLUGINS, "manifest.json"), encoding="utf-8") as f:
        manifest = json.load(f)

    kei_idx, kei_etag = fetch_json(KEI_INDEX, "keiyoushi-index.json", offline)
    assets, _ = fetch_json(KEI_ASSETS, "keiyoushi-release-assets.json", offline)
    lnr_idx, lnr_etag = fetch_json(LNR_INDEX, "lnreader-plugins.json", offline)
    lnc_idx, lnc_etag, lnc_url = None, None, None
    for br in LNCRAWL_BRANCHES:
        try:
            lnc_url = LNCRAWL_INDEX % br
            lnc_idx, lnc_etag = fetch_json(lnc_url, "lncrawl-index.json", offline)
            break
        except Exception as e:
            log("lncrawl branch", br, "failed:", e)
    if lnc_idx is None:
        raise SystemExit("could not fetch the lncrawl index")
    rejected = {}
    for url, reason in (lnc_idx.get("rejected") or {}).items():
        rejected[domain_of(url)] = reason

    kei, mismatched = build_keiyoushi(kei_idx, assets)
    lnr, unknown_lang, failed = build_lnreader(lnr_idx)
    lnc = build_lncrawl(manifest)
    pub_lnr, pub_lnc, skipped, review, notes = dedupe(kei, lnr, lnc, overrides, rejected)
    if mismatched:
        notes.append("%d keiyoushi APK(s) had no matching release-assets sha256 (sha256 = null)" % mismatched)
    if unknown_lang:
        notes.append("unmapped LNReader language names: %s" % ", ".join(unknown_lang))
    if failed:
        notes.append("LNReader plugins that failed to download and were left out: %s" % ", ".join(failed))

    extensions = sorted(kei + pub_lnr + pub_lnc, key=lambda e: (e["origin"], e["id"]))
    ids = [e["id"] for e in extensions]
    dup = [i for i, n in Counter(ids).items() if n > 1]
    if dup:
        raise SystemExit("duplicate extension ids: %s" % dup[:10])

    kei_commit = github_commit("keiyoushi/extensions", "repo")
    lnr_commit = github_commit("LNReader/lnreader-plugins", "plugins/v3.0.0")
    catalog = {
        "schemaVersion": 1,
        "name": "YomiDen Extensions (YDN)",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "upstreams": {
            "keiyoushi": {"url": KEI_INDEX, "commit": kei_commit, "etag": kei_etag, "count": len(kei_idx["extensionList"]["extensions"]), "published": len(kei)},
            "lnreader": {"url": LNR_INDEX, "commit": lnr_commit, "etag": lnr_etag, "count": len(lnr_idx), "published": len(pub_lnr)},
            "lncrawl": {"url": lnc_url, "commit": manifest["lncrawl"]["commit"], "etag": lnc_etag, "count": manifest["lncrawl"]["crawlers"], "generated": len(lnc), "published": len(pub_lnc)},
        },
        "extensions": extensions,
    }
    # keep the old timestamp / volatile upstream fields when nothing real changed, so CI only commits real changes
    index_path = os.path.join(DIST, "index.json")
    os.makedirs(DIST, exist_ok=True)
    if os.path.exists(index_path):
        with open(index_path, encoding="utf-8") as f:
            prev = json.load(f)

        def stable(c):
            d = json.loads(json.dumps(c))
            d.pop("generatedAt", None)
            for u in d["upstreams"].values():
                u.pop("etag", None)
            return d

        if stable(prev) == stable(catalog):
            catalog["generatedAt"] = prev["generatedAt"]
            catalog["upstreams"] = prev["upstreams"]
    write_if_changed(index_path, json.dumps(catalog, ensure_ascii=False, indent=1) + "\n")
    extras = {
        "lncrawl generated plugins": len(lnc),
        "lncrawl crawlers not ported (legacy/custom/dead/other templates)": manifest["lncrawl"]["crawlers"] - len(lnc),
        "template crawlers skipped by the generator": len(manifest["skipped"]),
    }
    write_if_changed(os.path.join(DIST, "report.md"), render_report(catalog, skipped, review, notes, extras))
    write_if_changed(os.path.join(DIST, "dedupe-review.md"), render_review(review))
    log("published %d (keiyoushi %d, lnreader %d, lncrawl %d), skipped %d, review %d" % (len(extensions), len(kei), len(pub_lnr), len(pub_lnc), len(skipped), len(review)))


if __name__ == "__main__":
    main()
