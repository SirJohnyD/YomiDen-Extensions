# YomiDen Extensions (YDN)

The single extension catalog for the YomiDen app. It aggregates:

| Upstream | Content | How it's included |
|---|---|---|
| [Keiyoushi](https://github.com/keiyoushi/extensions) | Manga / manhwa / manhua (APK) | Linked to upstream downloads with SHA-256 + signer pin |
| [LNReader plugins](https://github.com/LNReader/lnreader-plugins) | Novels (JS) | Linked to upstream files with SHA-256 pin |
| [Lightnovel Crawler](https://github.com/lncrawl/lightnovel-crawler) | Novels + comics | Converted into JS plugins hosted here (`plugins/`) |

Duplicates are removed per content type with priority Keiyoushi → LNReader → lncrawl. Manual decisions live in `overrides.json`.

- Catalog the app reads: `https://raw.githubusercontent.com/SirJohnyD/yomiden-extensions/main/dist/index.json`
- Format: [`SCHEMA.md`](SCHEMA.md), JSON Schema in `schema/`
- Rebuilt every 6 hours by `.github/workflows/ydn-sync.yml` (also runnable manually)

## Run locally
```sh
(cd tools/lncrawl-gen && npm ci && node generate.mjs && node test.mjs)
python3 tools/aggregate.py
```

## License
lncrawl-derived plugins and the tooling are GPL-3.0 (see `LICENSE`), like Lightnovel Crawler. Keiyoushi (Apache-2.0) and LNReader (MIT) extensions are not re-hosted, only linked, and remain under their own licenses.

Not affiliated with Mihon, Keiyoushi, LNReader, Lightnovel Crawler or any content provider. This repo hosts no content.
