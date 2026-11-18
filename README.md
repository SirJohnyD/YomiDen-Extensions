# YomiDen Extensions (YDN)

The single extension catalog for the YomiDen app. It aggregates:

| Upstream | Content | How it's included |
|---|---|---|
| [Keiyoushi](https://github.com/keiyoushi/extensions) | Manga / manhwa / manhua (APK) | Linked to upstream downloads with SHA-256 + signer pin (signed APKs cannot be re-patched, so they are never re-hosted) |
| [LittleSurvival](https://github.com/LittleSurvival/copymanga-copy20), [Kavita](https://github.com/Kareadita/tach-extension), [Suwayomi](https://github.com/Suwayomi/tachiyomi-extension), [Cursed Manga](https://github.com/mojuru/cursed-manga-repo), [FelipeGFA](https://github.com/FelipeGFA/extensoes) | Additional manga / manhwa / manhua (APK) | Linked to upstream downloads with each repository's own signer pin |
| [LNReader plugins](https://github.com/LNReader/lnreader-plugins) | Novels (JS) | Vendored: our own copy in `plugins/vendor/lnreader/` (origin stays `lnreader`), with `upstreamUrl` / `upstreamSha256` |
| Shosetsu | Novels (Lua) | Linked to upstream scripts and their repository libraries. Requires a YomiDen build with Shosetsu support. |
| [Lightnovel Crawler](https://github.com/lncrawl/lightnovel-crawler) | Novels + comics | Converted into JS plugins hosted here (`plugins/`) |

Duplicates are removed per content type with priority Keiyoushi → LNReader → lncrawl. Supplemental APKs are added after this step, skipping existing package names, overlapping source IDs, or entries whose
site and language pairs are all already covered. Mixed-content supplemental feeds are flagged NSFW. Manual lncrawl
decisions live in `overrides.json`.

## Other repository formats

| Requested repository | Catalog coverage |
|---|---|
| Yūzōnō Tachiyomi | The live manga index only carries a migration entry pointing to Keiyoushi, which YDN already includes. |
| Paperback | The supplied repo links to Paperback extensions built for its iOS runtime. Each source would need a port. |
| Shosetsu (official, Universe, noaione, Jobobby04, suhan-paradkar, ShosetLazyExtensions) | The catalog imports Lua sources from reachable feeds. The Universe index currently returns 404 at the supplied location. |
| IReader and NovelSourcery | These use native novel extension APIs. YDN's novels use its JS runtime. Each missing source would need a port or corresponding app runtime. |
| Yūzōnō Anime | The APKs implement Aniyomi's anime API. YDN supports comics and novels. |


- Catalog the app reads: `https://raw.githubusercontent.com/SirJohnyD/yomiden-extensions/main/dist/index.json`
- Format: [`SCHEMA.md`](SCHEMA.md), JSON Schema in `schema/`
- Rebuilt every 6 hours by `.github/workflows/ydn-sync.yml` (also runnable manually)

## Vendored LNReader plugins and patches
Every LNReader plugin is copied to `plugins/vendor/lnreader/<id>.js` (mirror of upstream at the pinned commit, listed with
its sha256 in `plugins/vendor/lnreader/lock.json`) and the catalog serves that copy. Only `.js` text is stored.

To fix a broken plugin: put the fixed file at `plugins/patches/<id>.js`. It replaces the vendored file in the catalog and
the version becomes `<upstream version>-ydn.N`, where N comes from a `// ydn-patch: N` line in the patch (default 1; bump it
for each change). Sync never writes to `plugins/patches/` except for the `<id>.base` marker (the upstream sha256 the patch
was made against). If upstream later changes a patched plugin, our patch keeps being served and the plugin is listed in
`dist/patch-review.md`; diff the vendored copy against the patch, port what you need, then run
`python3 tools/aggregate.py --ack-patch <id>`.

YDN-only plugins derived from LNReader ones live in `plugins/own/<id>.js` + `<id>.json` (catalog metadata); they are published with
origin `lnreader`. NovelDex is the first case: `node tools/noveldex/build.mjs <noveldex.ts>` builds the patched novel plugin
(`plugins/patches/noveldex.js`, adds type and origin to the genres so the app can detect the format) and `NovelDex Comics`
(`plugins/own/noveldex-comics.js`). `tools/cross-format-audit.py` writes `cross-format-report.md` (sites that likely host the
other format).

Comic APKs stay linked to their upstream publishers and keep their original signing certificates.

## Run locally
```sh
(cd tools/lncrawl-gen && npm ci && node generate.mjs && node test.mjs)
python3 tools/aggregate.py
```

## License
lncrawl-derived plugins and the tooling are GPL-3.0 (see `LICENSE`), like Lightnovel Crawler. Comic APKs are linked to their original publishers. Vendored LNReader plugins remain under the MIT license.

Not affiliated with Mihon, Keiyoushi, LNReader, Lightnovel Crawler or any content provider. This repo hosts no content.
