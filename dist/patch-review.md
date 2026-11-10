# Patched plugins whose upstream changed

Our patch is still served. Diff `plugins/vendor/lnreader/<id>.js` against the patch, port what is needed, bump `// ydn-patch: N`, then run `python3 tools/aggregate.py --ack-patch <id>`.

## NovelDex (`noveldex`)

- upstream version: 1.0.1
- patch based on sha256: `2e03b536b00f2b5050910cc2cac41daa226a167a604ac024319eacdc563adc66`
- upstream now: `bfa6fa19af49582a00929e4ef994ee2a6d5d0af3211c9ff291441c56b1110ba0`
- upstream file: https://raw.githubusercontent.com/lnreader/lnreader-plugins/plugins/v3.0.0/.js/src/plugins/english/noveldex.js
- compare: `plugins/vendor/lnreader/noveldex.js` vs `plugins/patches/noveldex.js`

