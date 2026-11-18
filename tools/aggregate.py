#!/usr/bin/env python3
"""YDN catalog aggregator (spec 5.1 / 5.5). Python 3 stdlib only.

Fetches comic APK feeds, LNReader (JS) and the lncrawl index, merges them with the plugins produced by
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
import subprocess
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
VENDOR_DIR = os.path.join(PLUGINS, "vendor", "lnreader")
PATCH_DIR = os.path.join(PLUGINS, "patches")
PUBLIC_BASE = os.environ.get("YDN_PUBLIC_BASE", "https://raw.githubusercontent.com/SirJohnyD/yomiden-extensions/main/")

KEI_INDEX = "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.json"
KEI_ASSETS = "https://raw.githubusercontent.com/keiyoushi/extensions/repo/release-assets.json"
LNR_INDEX = "https://raw.githubusercontent.com/LNReader/lnreader-plugins/plugins/v3.0.0/.dist/plugins.min.json"
LNCRAWL_INDEX = "https://raw.githubusercontent.com/lncrawl/lightnovel-crawler/%s/sources/_index.json"
LNCRAWL_BRANCHES = ["dev", "master", "main"]

# Order determines which supplemental APK wins when publishers package the same source.
# Fingerprints come from the respective repository metadata and must be reviewed if rotated.
COMIC_REPOS = {
    "littlesurvival": ("LittleSurvival/copymanga-copy20", "index.min.json",
                       "896d1ca35175c42baf61b1a157e4354df9568beed4ccc82a03762d1167005e79"),
    "kavita": ("Kareadita/tach-extension", "index.min.json",
               "5887aee6597996821a1f05ec0d88cac45ec2847143278ac6b1efc657bfad6be0"),
    "suwayomi": ("Suwayomi/tachiyomi-extension", "index.min.json",
                 "263228f0827ca0b66e8aad8eba50d71c0f13927fe6912520f8a05f19667283bc"),
    "cursed-manga": ("mojuru/cursed-manga-repo", "index.json",
                     "a5e2027162d4b7294d54fd069af923eee4078cc097765d3a0d84a747d3a8356e"),
    "felipegfa": ("FelipeGFA/extensoes", "index.json",
                  "9bf5754a79fd686cb77e6335a2a9e5351ad73ca824c27b09e7b3437f806fea77"),
}

SHOSETSU_REPOS = {
    "shosetsu-universe": "https://gitlab.com/shosetsuorg/extensions/-/raw/dev/",
    "shosetsu-noaione": "https://raw.githubusercontent.com/noaione/shosetsu-extensions/master/",
    "shosetsu-jobobby": "https://jobobby04.github.io/ShosetsuExtensions/master/",
    "shosetsu-suhan": "https://raw.githubusercontent.com/suhan-paradkar/ShosetsuExtensions/master/",
    "shosetsu-lazy": "https://raw.githubusercontent.com/capthehacker99/ShosetLazyExtensions/master/",
}

# Legacy Paperback bundles must pass the app's QuickJS bridge before being added here.
PAPERBACK_REPO = "xOnlyFadi/xonlyfadi-extensions"
PAPERBACK_BUILD = "977e6092959fc671c92ff7dde9180e4fa5a804da"
PAPERBACK_SOURCES = {"AEManga": "ar"}

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
        ref = urllib.parse.quote(branch, safe="")
        req = urllib.request.Request("https://api.github.com/repos/%s/commits/%s" % (repo, ref), headers=headers)
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())["sha"]
    except Exception:
        return None


def raw_github_url(repo, revision, path):
    return "https://raw.githubusercontent.com/%s/%s/%s" % (repo, revision, path.lstrip("/"))


def keiyoushi_source_urls(commit):
    if not commit:
        return KEI_INDEX, KEI_ASSETS
    return (
        raw_github_url("keiyoushi/extensions", commit, "index.json"),
        raw_github_url("keiyoushi/extensions", commit, "release-assets.json"),
    )


def lnreader_index_url(commit):
    if not commit:
        return LNR_INDEX
    return raw_github_url("LNReader/lnreader-plugins", commit, ".dist/plugins.min.json")


def pin_lnreader_plugin_url(url, commit):
    if not commit:
        return url
    branch_prefix = "https://raw.githubusercontent.com/LNReader/lnreader-plugins/plugins/v3.0.0/"
    if url.startswith(branch_prefix):
        return raw_github_url(
            "LNReader/lnreader-plugins",
            commit,
            url[len(branch_prefix):],
        )
    return url


def lnreader_cache_path(cache_dir, plugin):
    # The repo can replace code without changing id/version. Key cached bytes by the resolved URL too.
    url_key = hashlib.sha256(plugin["url"].encode("utf-8")).hexdigest()[:16]
    file_name = "%s-%s-%s.js" % (plugin["id"], plugin["version"], url_key)
    return os.path.join(cache_dir, re.sub(r"[^\w.-]", "_", file_name))


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
    out, unverified = [], 0
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
        release_asset = assets.get(pkg)
        if isinstance(release_asset, str):
            # The new string schema's values do not match GitHub's digest for the tagged APK, so do not
            # publish them as byte checksums. The app still pins the signing certificate.
            sha, unverified = None, unverified + 1
        else:
            # Backward compatibility with the previous {package: {apk: {name, sha256}}} schema.
            asset = (release_asset or {}).get("apk") or {}
            sha = asset.get("sha256")
            if sha and asset.get("name") != apk_url.rsplit("/", 1)[-1]:
                sha, unverified = None, unverified + 1
        sites = sorted({d for d in (domain_of(s["homeUrl"]) for s in sources) if d})
        out.append({
            "id": pkg, "name": e["name"], "lang": lang, "contentType": "comic",
            "nsfw": "NSFW" in str(e.get("contentWarning", "")).upper(), "origin": "keiyoushi", "package": "apk",
            "version": e.get("versionName", ""), "versionCode": int(e["versionCode"]), "url": apk_url, "sha256": sha,
            "iconUrl": e["resources"].get("iconUrl", ""), "sites": sites, "signer": signer, "sources": sources,
            "needsReview": False,
        })
    return out, unverified


def build_comic_repo(origin, index, base):
    _, filename, signer = COMIC_REPOS[origin]
    if filename == "index.json":
        if index["signingKey"].lower() != signer:
            raise ValueError(f"{origin} APK signing fingerprint changed")
        entries, _ = build_keiyoushi(index, {})
        for entry, raw in zip(entries, index["extensionList"]["extensions"]):
            entry["origin"] = origin
            # Mixed feeds can contain mature titles. Keep them out of the SFW tab.
            entry["nsfw"] |= "MIXED" in raw.get("contentWarning", "").upper()
        return entries

    entries = []
    for raw in index:
        apk, package = raw["apk"], raw["pkg"]
        if not re.fullmatch(r"[\w.-]+\.apk", apk) or not re.fullmatch(r"[\w.]+", package):
            raise ValueError(f"{origin} has an invalid APK filename or package: {package}")
        sources = [
            {"id": str(source["id"]), "name": source["name"], "lang": source["lang"],
             "homeUrl": source.get("baseUrl", "")}
            for source in raw.get("sources", [])
        ]
        sites = sorted({domain_of(source["homeUrl"]) for source in sources} - {""})
        icon_url = base + "icon/" + package + ".png"
        if origin == "littlesurvival" and package != "eu.kanade.tachiyomi.extension.zh.copymanga":
            icon_url = favicon(sites[0]) if sites else ""
        entries.append({
            "id": package, "name": raw["name"].removeprefix("Tachiyomi: "), "lang": raw["lang"],
            "contentType": "comic", "nsfw": bool(raw["nsfw"]), "origin": origin, "package": "apk",
            "version": raw["version"], "versionCode": int(raw["code"]), "url": base + "apk/" + apk,
            "sha256": None, "iconUrl": icon_url, "sites": sites,
            "signer": signer, "sources": sources, "needsReview": False,
        })
    return entries


def source_sites(entry):
    if entry["sources"]:
        return {(domain, source["lang"]) for source in entry["sources"]
                if (domain := domain_of(source["homeUrl"]))}
    return {(domain, entry["lang"]) for domain in entry["sites"]}


def add_comic_repos(existing, previous, offline):
    """Keep published entries and reuse each verified snapshot if its feed is briefly unavailable."""
    ids = {e["id"] for e in existing}
    comics = [e for e in existing if e["contentType"] == "comic"]
    source_ids = {source["id"] for entry in comics for source in entry["sources"] if source["id"]}
    sites = set().union(*(source_sites(entry) for entry in comics))
    added, upstreams, skipped, notes = [], {}, [], []
    for origin, (repo, filename, signer) in COMIC_REPOS.items():
        try:
            commit = None if offline else github_commit(repo, "repo")
            if not offline and not commit:
                raise RuntimeError("could not resolve repo branch")
            base = raw_github_url(repo, commit or "repo", "")
            url = base + filename
            index, etag = fetch_json(url, f"{origin}-index.json", offline)
            if filename != "index.json":
                meta, _ = fetch_json(base + "repo.json", f"{origin}-repo.json", offline)
                if meta["meta"]["signingKeyFingerprint"].lower() != signer:
                    raise ValueError("APK signing fingerprint changed")
            candidates = build_comic_repo(origin, index, base)
            if not candidates or any(
                not e["id"].startswith("eu.kanade.tachiyomi.extension.")
                or urllib.parse.urlparse(e["url"]).scheme != "https" for e in candidates
            ):
                raise ValueError("feed contains no compatible comic APKs or has an invalid download URL")
            upstreams[origin] = {"url": url, "commit": commit, "etag": etag,
                                 "count": len(candidates), "published": 0}
        except (RuntimeError, ValueError, KeyError, TypeError) as error:
            if origin not in previous.get("upstreams", {}):
                raise SystemExit(f"{origin}: unable to load initial extension feed: {error}") from error
            notes.append(f"{origin}: using the previous snapshot ({error})")
            upstreams[origin] = {**previous["upstreams"][origin], "published": 0}
            candidates = [e for e in previous["extensions"] if e["origin"] == origin and e["signer"] == signer]
        for entry in candidates:
            entry_ids = {source["id"] for source in entry["sources"] if source["id"]}
            entry_sites = source_sites(entry)
            covered_sites = (entry_sites and entry_sites <= sites
                             and all(source["homeUrl"] for source in entry["sources"]))
            if entry["id"] in ids or entry_ids & source_ids or covered_sites:
                skipped.append({"origin": origin, "id": entry["id"], "name": entry["name"],
                                "reason": "package, source ID or site and language already covered"})
                continue
            added.append(entry)
            ids.add(entry["id"])
            source_ids.update(entry_ids)
            sites.update(entry_sites)
            upstreams[origin]["published"] += 1
    return added, upstreams, skipped, notes


def build_shosetsu(index, root):
    libraries = sorted({lib["name"] for lib in index.get("libraries", [])
                        if re.fullmatch(r"[A-Za-z0-9_-]+", lib["name"])})
    entries = []
    for script in index["scripts"]:
        lang, file_name = script["lang"], script["fileName"]
        if (script.get("type", "LuaScript") != "LuaScript"
                or not re.fullmatch(r"[A-Za-z0-9-]+", lang)
                or not re.fullmatch(r"[A-Za-z0-9_-]+", file_name)):
            continue
        digest = script.get("md5") or ""
        entries.append({
            "id": f'shosetsu-{int(script["id"])}', "name": script["name"], "lang": lang,
            "contentType": "novel", "nsfw": True, "origin": "shosetsu", "package": "lua",
            "version": script["ver"], "versionCode": None,
            "url": root + f"src/{lang}/{file_name}.lua",
            "sha256": digest.lower() if re.fullmatch(r"[0-9a-fA-F]{64}", digest) else None,
            "iconUrl": script.get("imageURL") or "", "sites": [], "signer": None, "sources": [],
            "needsReview": False, "shosetsu": {"root": root, "libraries": libraries},
        })
    return entries


def add_shosetsu_repos(existing, previous, offline):
    def load_repo(item):
        key, root = item
        url = root + "index.json"
        try:
            index, etag = fetch_json(url, f"{key}-index.json", offline)
            candidates = build_shosetsu(index, root)
            state = {"url": url, "commit": None, "etag": etag, "count": len(index["scripts"]), "published": 0}
            return key, candidates, state, None
        except (RuntimeError, ValueError, KeyError, TypeError) as error:
            previous_upstreams = previous.get("upstreams", {})
            state = previous_upstreams.get(key, {})
            if key == "shosetsu-universe" and not state:
                state = previous_upstreams.get("shosetsu-official", {})
            candidates = [e for e in previous.get("extensions", [])
                          if e.get("shosetsu", {}).get("root") == root]
            return key, candidates, {**state, "published": 0} if state else None, f"{key}: {error}"

    def by_name(entry):
        return re.sub(r"[^\w]+", "", entry["name"].casefold()), entry["lang"]

    ids = {e["id"] for e in existing}
    names = {by_name(e) for e in existing if e["contentType"] == "novel"}
    entries, upstreams, notes = [], {}, []
    with cf.ThreadPoolExecutor(len(SHOSETSU_REPOS)) as pool:
        for key, candidates, state, note in pool.map(load_repo, SHOSETSU_REPOS.items()):
            if note:
                notes.append(note)
            if state is None:
                continue
            upstreams[key] = state
            for entry in candidates:
                entry_name = by_name(entry)
                if entry["id"] in ids or entry_name in names:
                    continue
                entries.append(entry)
                ids.add(entry["id"])
                names.add(entry_name)
                state["published"] += 1
    return entries, upstreams, notes


def prepare_paperback(offline):
    """Convert the pinned legacy bundles before CI snapshots plugins for publication."""
    root = raw_github_url(PAPERBACK_REPO, PAPERBACK_BUILD, "0.6/")
    index, etag = fetch_json(root + "versioning.json", f"paperback-{PAPERBACK_BUILD}.json", offline)
    entries = []
    for entry in index["sources"]:
        source_id = entry["id"]
        if source_id not in PAPERBACK_SOURCES:
            continue
        upstream_url = f"{root}{source_id}/source.js"
        cache = os.path.join(CACHE, "paperback", PAPERBACK_BUILD, source_id + ".js")
        index_path = os.path.join(CACHE, "upstream", f"paperback-{PAPERBACK_BUILD}.json")
        if not os.path.isfile(cache):
            bundle, _ = http_get(upstream_url)
            write_bytes_if_changed(cache, bundle)
        converter = os.path.join(ROOT, "tools", "lncrawl-gen", "prepare-paperback.mjs")
        code = subprocess.check_output(["node", converter, index_path, cache, source_id])
        plugin_id = "paperback-" + source_id
        path = f"plugins/paperback/{plugin_id}.js"
        write_bytes_if_changed(os.path.join(ROOT, path), code)
        entries.append({
            "id": plugin_id, "name": entry["name"], "lang": PAPERBACK_SOURCES[source_id],
            "contentType": "comic", "nsfw": entry.get("contentRating") != "EVERYONE",
            "origin": "paperback", "package": "js", "version": entry["version"] + "-ydn.1",
            "versionCode": None, "url": PUBLIC_BASE + path, "sha256": hashlib.sha256(code).hexdigest(),
            "iconUrl": f'{root}{source_id}/includes/{entry["icon"]}',
            "sites": [domain_of(entry["websiteBaseURL"])], "signer": None, "sources": [],
            "needsReview": False, "upstreamUrl": upstream_url,
            "upstreamSha256": hashlib.sha256(read_bytes(cache)).hexdigest(),
        })
    upstream = {"url": root + "versioning.json", "commit": PAPERBACK_BUILD, "etag": etag,
                "count": len(index["sources"]), "published": 0}
    return entries, upstream


def add_paperback(existing, candidates):
    covered = set()
    for entry in existing:
        if entry["contentType"] != "comic":
            continue
        covered.update((site, entry["lang"]) for site in entry["sites"])
        covered.update((domain_of(source["homeUrl"]), source["lang"]) for source in entry.get("sources", []))
    return [entry for entry in candidates
            if not any((site, entry["lang"]) in covered or (site, "all") in covered for site in entry["sites"])]


def build_lnreader(plugins):
    cache_dir = os.path.join(CACHE, "lnreader")
    os.makedirs(cache_dir, exist_ok=True)

    def fetch(p):
        path = lnreader_cache_path(cache_dir, p)
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


# --- Vendoring (LNReader plugins are re-hosted here so broken ones can be fixed without waiting for upstream) -------

PATCH_VERSION_RE = re.compile(r"^\s*//\s*ydn-patch:\s*(\d+)\s*$", re.M)


def safe_plugin_id(plugin_id):
    return re.sub(r"[^\w.-]", "_", plugin_id)


def read_bytes(path):
    with open(path, "rb") as f:
        return f.read()


def write_bytes_if_changed(path, data):
    if os.path.exists(path) and read_bytes(path) == data:
        return False
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "wb") as f:
        f.write(data)
    os.replace(path + ".tmp", path)
    return True


def patch_revision(patch_bytes):
    """`// ydn-patch: N` anywhere in the patch picks N for the `-ydn.N` version suffix (default 1)."""
    m = PATCH_VERSION_RE.search(patch_bytes.decode("utf-8", "replace"))
    return int(m.group(1)) if m else 1


def vendor_lnreader_entry(entry, upstream_bytes, upstream_url, *, vendor_dir, patch_dir, public_base, root):
    """Returns (new_entry, review_or_None). new_entry points at OUR raw copy (origin stays "lnreader").

    plugins/vendor/lnreader/<id>.js always mirrors upstream (so a patch can be diffed against it). If
    plugins/patches/<id>.js exists it is what gets published instead; the patch is never written by this tool.
    plugins/patches/<id>.base holds the upstream sha256 the patch was made against; when upstream moves on, the
    plugin is reported (patch-review.md) and our patch keeps being served until a human rebases it and runs
    `aggregate.py --ack-patch <id>`.
    """
    fid = safe_plugin_id(entry["id"])
    upstream_sha = hashlib.sha256(upstream_bytes).hexdigest()
    vendor_path = os.path.join(vendor_dir, fid + ".js")
    write_bytes_if_changed(vendor_path, upstream_bytes)
    patch_path = os.path.join(patch_dir, fid + ".js")
    out = dict(entry)
    out["upstreamUrl"] = upstream_url
    out["upstreamSha256"] = upstream_sha
    review = None
    if os.path.exists(patch_path):
        patch_bytes = read_bytes(patch_path)
        out["url"] = public_base + os.path.relpath(patch_path, root).replace(os.sep, "/")
        out["sha256"] = hashlib.sha256(patch_bytes).hexdigest()
        out["version"] = "%s-ydn.%d" % (entry["version"], patch_revision(patch_bytes))
        base_path = os.path.join(patch_dir, fid + ".base")
        if not os.path.exists(base_path):
            # first time we see this patch: assume it is based on the current upstream
            with open(base_path, "w", encoding="utf-8", newline="\n") as f:
                f.write(upstream_sha + "\n")
        base_sha = open(base_path, encoding="utf-8").read().strip()
        if base_sha != upstream_sha:
            review = {"id": entry["id"], "name": entry["name"], "upstreamVersion": entry["version"],
                      "baseSha256": base_sha, "upstreamSha256": upstream_sha, "upstreamUrl": upstream_url,
                      "vendorFile": os.path.relpath(vendor_path, root).replace(os.sep, "/"),
                      "patchFile": os.path.relpath(patch_path, root).replace(os.sep, "/")}
    else:
        out["url"] = public_base + os.path.relpath(vendor_path, root).replace(os.sep, "/")
        out["sha256"] = upstream_sha
    return out, review


def render_patch_review(reviews):
    lines = ["# Patched plugins whose upstream changed", "",
             "Our patch is still served. Diff `plugins/vendor/lnreader/<id>.js` against the patch, port what is needed, "
             "bump `// ydn-patch: N`, then run `python3 tools/aggregate.py --ack-patch <id>`.", ""]
    if not reviews:
        lines.append("Nothing to review.")
    for r in sorted(reviews, key=lambda r: r["id"]):
        lines += ["## %s (`%s`)" % (r["name"], r["id"]), "",
                  "- upstream version: %s" % r["upstreamVersion"],
                  "- patch based on sha256: `%s`" % r["baseSha256"],
                  "- upstream now: `%s`" % r["upstreamSha256"],
                  "- upstream file: %s" % r["upstreamUrl"],
                  "- compare: `%s` vs `%s`" % (r["vendorFile"], r["patchFile"]), ""]
    return "\n".join(lines) + "\n"


def vendor_lnreader(entries, plugins, commit, *, root=ROOT, public_base=None):
    """Vendors every successfully downloaded LNReader plugin. `plugins` is the (url-pinned) upstream index."""
    public_base = public_base or PUBLIC_BASE
    cache_dir = os.path.join(CACHE, "lnreader")
    by_id = {p["id"]: p for p in plugins}
    out, reviews, lock = [], [], {}
    for e in entries:
        p = by_id[e["id"]]
        upstream_bytes = read_bytes(lnreader_cache_path(cache_dir, p))
        new, review = vendor_lnreader_entry(
            e, upstream_bytes, p["url"], vendor_dir=VENDOR_DIR, patch_dir=PATCH_DIR, public_base=public_base, root=root,
        )
        out.append(new)
        lock[e["id"]] = {"version": e["version"], "upstreamUrl": p["url"], "upstreamSha256": new["upstreamSha256"]}
        if review:
            reviews.append(review)
    os.makedirs(VENDOR_DIR, exist_ok=True)
    lock_doc = {"upstream": "LNReader/lnreader-plugins", "commit": commit, "plugins": lock}
    write_if_changed(os.path.join(VENDOR_DIR, "lock.json"), json.dumps(lock_doc, indent=1, sort_keys=True) + "\n")
    return out, reviews


def build_own(own_dir=None, root=ROOT, public_base=None):
    """YDN-only plugins derived from LNReader ones (plugins/own/<id>.js + <id>.json meta). Origin stays "lnreader" for credit."""
    own_dir = own_dir or os.path.join(PLUGINS, "own")
    public_base = public_base or PUBLIC_BASE
    out = []
    if not os.path.isdir(own_dir):
        return out
    for fn in sorted(os.listdir(own_dir)):
        if not fn.endswith(".json"):
            continue
        meta = json.load(open(os.path.join(own_dir, fn), encoding="utf-8"))
        js_path = os.path.join(own_dir, meta["id"] + ".js")
        d = domain_of(meta.get("site", ""))
        out.append({
            "id": meta["id"], "name": meta["name"], "lang": meta["lang"], "contentType": meta["contentType"],
            "nsfw": bool(meta.get("nsfw", False)), "origin": "lnreader", "package": "js", "version": meta["version"],
            "versionCode": None, "url": public_base + os.path.relpath(js_path, root).replace(os.sep, "/"),
            "sha256": hashlib.sha256(read_bytes(js_path)).hexdigest(), "iconUrl": meta.get("iconUrl", ""),
            "sites": [d] if d else [], "signer": None, "sources": [], "needsReview": False,
        })
    return out


def ack_patch(plugin_id):
    fid = safe_plugin_id(plugin_id)
    lock = json.load(open(os.path.join(VENDOR_DIR, "lock.json"), encoding="utf-8"))["plugins"]
    sha = lock[plugin_id]["upstreamSha256"]
    with open(os.path.join(PATCH_DIR, fid + ".base"), "w", encoding="utf-8", newline="\n") as f:
        f.write(sha + "\n")
    log("patch for %s now based on upstream %s" % (plugin_id, sha))


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
    for o in ("keiyoushi", "lnreader", "lncrawl", *COMIC_REPOS, "shosetsu", "paperback"):
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
    if "--ack-patch" in sys.argv:
        ack_patch(sys.argv[sys.argv.index("--ack-patch") + 1])
        return
    with open(os.path.join(ROOT, "overrides.json"), encoding="utf-8") as f:
        overrides = json.load(f)
    with open(os.path.join(PLUGINS, "manifest.json"), encoding="utf-8") as f:
        manifest = json.load(f)

    kei_commit = None if offline else github_commit("keiyoushi/extensions", "repo")
    lnr_commit = None if offline else github_commit("LNReader/lnreader-plugins", "plugins/v3.0.0")
    if not offline and (not kei_commit or not lnr_commit):
        raise SystemExit("could not resolve Keiyoushi and LNReader refs to pin their catalog inputs")

    kei_index_url, kei_assets_url = keiyoushi_source_urls(kei_commit)
    lnr_source_index_url = lnreader_index_url(lnr_commit)
    kei_idx, kei_etag = fetch_json(kei_index_url, "keiyoushi-index.json", offline)
    assets, _ = fetch_json(kei_assets_url, "keiyoushi-release-assets.json", offline)
    lnr_idx, lnr_etag = fetch_json(lnr_source_index_url, "lnreader-plugins.json", offline)
    if lnr_commit:
        lnr_idx = [
            {**plugin, "url": pin_lnreader_plugin_url(plugin["url"], lnr_commit)}
            for plugin in lnr_idx
        ]
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

    kei, unverified_checksums = build_keiyoushi(kei_idx, assets)
    if unverified_checksums:
        log("%d keiyoushi APK(s) have unverified SHA-256 metadata; it was omitted" % unverified_checksums)
    lnr, unknown_lang, failed = build_lnreader(lnr_idx)
    lnr, patch_reviews = vendor_lnreader(lnr, lnr_idx, lnr_commit)
    try:
        paperback_candidates, paperback_upstream = prepare_paperback(offline)
        paperback_error = None
    except (RuntimeError, OSError, ValueError, subprocess.CalledProcessError) as error:
        paperback_candidates, paperback_upstream = [], None
        paperback_error = f"Paperback snapshot unavailable: {error}"
        log(paperback_error)
    own = build_own()
    if any(o["id"] in {e["id"] for e in lnr} for o in own):
        raise SystemExit("plugins/own ids must not collide with LNReader plugin ids")
    os.makedirs(DIST, exist_ok=True)
    write_if_changed(os.path.join(DIST, "patch-review.md"), render_patch_review(patch_reviews))
    if "--vendor-only" in sys.argv:
        log("vendored %d LNReader plugins, %d patched plugin(s) need review" % (len(lnr), len(patch_reviews)))
        return
    lnc = build_lncrawl(manifest)
    pub_lnr, pub_lnc, skipped, review, notes = dedupe(kei, lnr + own, lnc, overrides, rejected)
    if unverified_checksums:
        notes.append(
            "%d keiyoushi APK(s) had an unverified release-assets checksum (sha256 = null; signer verification remains)"
            % unverified_checksums
        )
    if patch_reviews:
        notes.append("%d patched LNReader plugin(s) changed upstream, see patch-review.md" % len(patch_reviews))
    if unknown_lang:
        notes.append("unmapped LNReader language names: %s" % ", ".join(unknown_lang))
    if failed:
        notes.append("LNReader plugins that failed to download and were left out: %s" % ", ".join(failed))

    index_path = os.path.join(DIST, "index.json")
    previous = {}
    if os.path.exists(index_path):
        with open(index_path, encoding="utf-8") as f:
            previous = json.load(f)
    existing = kei + pub_lnr + pub_lnc
    added, upstreams, comic_skips, comic_notes = add_comic_repos(existing, previous, offline)
    skipped.extend(comic_skips)
    notes.extend(comic_notes)
    lua, lua_upstreams, lua_notes = add_shosetsu_repos(existing + added, previous, offline)
    upstreams.update(lua_upstreams)
    notes.extend(lua_notes)
    if paperback_error:
        notes.append(paperback_error)
        paperback_upstream = previous.get("upstreams", {}).get("paperback")
        paperback_candidates = [e for e in previous.get("extensions", []) if e["origin"] == "paperback"]
    paperback = add_paperback(existing + added, paperback_candidates)
    if paperback_upstream:
        upstreams["paperback"] = {**paperback_upstream, "published": len(paperback)}
    extensions = sorted(existing + added + lua + paperback, key=lambda e: (e["origin"], e["id"]))
    ids = [e["id"] for e in extensions]
    dup = [i for i, n in Counter(ids).items() if n > 1]
    if dup:
        raise SystemExit("duplicate extension ids: %s" % dup[:10])

    catalog = {
        "schemaVersion": 1,
        "name": "YomiDen Extensions (YDN)",
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "upstreams": {
            "keiyoushi": {"url": kei_index_url, "commit": kei_commit, "etag": kei_etag, "count": len(kei_idx["extensionList"]["extensions"]), "published": len(kei)},
            "lnreader": {"url": lnr_source_index_url, "commit": lnr_commit, "etag": lnr_etag, "count": len(lnr_idx), "published": len(pub_lnr)},
            "lncrawl": {"url": lnc_url, "commit": manifest["lncrawl"]["commit"], "etag": lnc_etag, "count": manifest["lncrawl"]["crawlers"], "generated": len(lnc), "published": len(pub_lnc)},
            **upstreams,
        },
        "extensions": extensions,
    }
    # keep the old timestamp / volatile upstream fields when nothing real changed, so CI only commits real changes
    if previous:
        def stable(c):
            d = json.loads(json.dumps(c))
            d.pop("generatedAt", None)
            for u in d["upstreams"].values():
                u.pop("etag", None)
            return d

        if stable(previous) == stable(catalog):
            catalog["generatedAt"] = previous["generatedAt"]
            catalog["upstreams"] = previous["upstreams"]
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
