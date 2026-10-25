# YDN catalog format

`dist/index.json` is the single catalog the YomiDen app reads
(`https://raw.githubusercontent.com/SirJohnyD/yomiden-extensions/main/dist/index.json`). Machine-readable schema:
[`schema/index.schema.json`](schema/index.schema.json) (JSON Schema 2020-12). `schemaVersion` is `1`; additive fields
may appear without a bump, so consumers must ignore unknown keys.

## Top level

| field | type | notes |
|---|---|---|
| `schemaVersion` | int | `1` |
| `name` | string | Display name of the repo (`YomiDen Extensions (YDN)`) |
| `generatedAt` | ISO-8601 UTC | Only changes when the catalog content changes |
| `upstreams` | object | `keiyoushi`, `lnreader`, `lncrawl`, each `{url, commit, etag, count, published}`; `lncrawl` also has `generated`. `count` = entries upstream, `published` = entries that survived de-dup. `commit` is null when it could not be resolved |
| `extensions` | array | Sorted by `origin`, then `id` |

## Extension entry

| field | type | notes |
|---|---|---|
| `id` | string | Unique in the whole catalog. APK: Android package name. JS: plugin id (`lncrawl-<module>` for lncrawl). For JS it must equal the plugin's own `id` (source id = `hash("ydn:" + id)` / `hash("lnr:" + id)`) |
| `name` | string | Display name |
| `lang` | string | ISO code (`en`, `pt-BR`), `all` or `multi` |
| `contentType` | `"comic"` \| `"novel"` | Keiyoushi = comic, LNReader = novel, lncrawl = either |
| `nsfw` | bool | Keiyoushi `contentWarning` NSFW; others currently `false` |
| `origin` | `"keiyoushi"` \| `"lnreader"` \| `"lncrawl"` | Attribution / debugging; shown only in extension details |
| `package` | `"apk"` \| `"js"` | How to install |
| `version` | string | APK: `versionName`. JS: upstream version; lncrawl: `<generatorRev>.0.<upstream crawler epoch>` (monotonic) |
| `versionCode` | int \| null | APK only |
| `url` | string | Download URL. Keiyoushi/LNReader: the upstream URL (linked, not re-hosted). lncrawl: raw URL of the plugin in this repo (`.../main/plugins/<lang>/<id>.js`) |
| `sha256` | string \| null | Lower-case hex of the downloaded file. JS: always set, **this is the integrity pin**. APK: from Keiyoushi `release-assets.json`; null if upstream lacks it |
| `iconUrl` | string | Upstream icon; lncrawl uses a favicon service for the first site |
| `sites` | string[] | Home domains, lower-case, `www.`/`m.` stripped. Used for de-dup and "also available as" |
| `signer` | string \| null | APK: Keiyoushi `signingKey` (SHA-256 fingerprint of the signing certificate, from its `index.json`). JS: `null` |
| `sources` | object[] | APK: `{id, name, lang, homeUrl}` per source (`id` is a string; 64-bit). JS: `[]` |
| `needsReview` | bool | `true` = published, but a human has not yet decided whether it duplicates another site on a different TLD (see `dist/dedupe-review.md`) |
| `upstream` | object | lncrawl only: `{file, commit, template, customized}`; the lncrawl source file + commit this plugin was generated from (attribution, GPL-3.0), the lncrawl template class, and overridden method names that the port approximates |

The app installs `apk` entries as Mihon extensions, verifying the APK signer against `signer`; `js` entries are
installed as plugins after verifying `sha256` of the downloaded file.

## Plugin format (`package: "js"`)

LNReader plugin format, run by the app's QuickJS host (`novel-runtime/`): a CommonJS script that sets
`exports.default` to an object with `id`, `name`, `site`, `version`, `icon`, `popularNovels(page, {showLatestNovels, filters})`,
`searchNovels(term, page)`, `parseNovel(path)`, `parseChapter(path)`. The runtime has no native `async`/`await`; generated
plugins are lowered to ES2016.

### Comic extension (YomiDen)

Plugins with `contentType: "comic"` additionally declare:

* `contentType: "comic"` on the plugin object (default is `"novel"`).
* `parsePages(chapterPath) -> Promise<string[]>`: absolute image URLs in reading order. `parseChapter` may return `''`.
* optional `imageRequestInit: { headers: { Referer: site } }`, which the app applies when loading page images.

`parseNovel` returns the series with its chapter list (oldest first) exactly as for novels. Chapter and series `path`s are
relative to `site` (`/novel/x/`) unless the URL is not on the site root, in which case they are absolute.

## Generation and de-dup

`tools/lncrawl-gen` ports lncrawl template crawlers to plugins (`plugins/<lang>/<id>.js`, `plugins/manifest.json`);
`tools/aggregate.py` builds the catalog. De-dup is by domain (lower-case, `www.`/`m.` stripped), priority
Keiyoushi, then LNReader, then lncrawl, and **per content type** (a comic extension never hides a novel plugin).
`overrides.json` is applied last (`keep` / `skip` / `use`). lncrawl `rejected` domains are dropped. Same site name on a
different TLD is published with `needsReview: true` and listed in `dist/dedupe-review.md`. `dist/report.md` has the counts
and the skipped list.
