# YomiDen Extensions (YDN)

The single extension catalog for the YomiDen app. It aggregates:

| Upstream | Content | How it's included |
|---|---|---|
| [Keiyoushi](https://github.com/keiyoushi/extensions) | Manga / manhwa / manhua (APK) | Linked to upstream downloads with SHA-256 + signer pin (signed APKs cannot be re-patched, so they are never re-hosted) |
| [LNReader plugins](https://github.com/LNReader/lnreader-plugins) | Novels (JS) | Vendored: our own copy in `plugins/vendor/lnreader/` (origin stays `lnreader`), with `upstreamUrl` / `upstreamSha256` |
| [Lightnovel Crawler](https://github.com/lncrawl/lightnovel-crawler) | Novels + comics | Converted into JS plugins hosted here (`plugins/`) |

Duplicates are removed per content type with priority Keiyoushi → LNReader → lncrawl. Manual decisions live in `overrides.json`.

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

Keiyoushi APKs stay linked to upstream releases: they are signed, so a patched copy could not be installed over them.

## Run locally
```sh
(cd tools/lncrawl-gen && npm ci && node generate.mjs && node test.mjs)
python3 tools/aggregate.py
```

## License
lncrawl-derived plugins and the tooling are GPL-3.0 (see `LICENSE`), like Lightnovel Crawler. Keiyoushi (Apache-2.0) and LNReader (MIT) extensions are not re-hosted, only linked, and remain under their own licenses.

Not affiliated with Mihon, Keiyoushi, LNReader, Lightnovel Crawler or any content provider. This repo hosts no content.
