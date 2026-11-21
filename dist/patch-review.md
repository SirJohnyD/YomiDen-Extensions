# Patched plugins whose upstream changed

Our patch is still served. Diff `plugins/vendor/lnreader/<id>.js` against the patch, port what is needed, bump `// ydn-patch: N`, then run `python3 tools/aggregate.py --ack-patch <id>`.

## NovelDex (`noveldex`)

- upstream version: 1.0.2
- patch based on sha256: `2e03b536b00f2b5050910cc2cac41daa226a167a604ac024319eacdc563adc66`
- upstream now: `bb40ecd952cd278db2c57c22a73119de39e7713ea3460d8049b00090bd2f52c5`
- upstream file: https://raw.githubusercontent.com/lnreader/lnreader-plugins/plugins/v3.0.0/.js/src/plugins/english/noveldex.js
- compare: `plugins/vendor/lnreader/noveldex.js` vs `plugins/patches/noveldex.js`

