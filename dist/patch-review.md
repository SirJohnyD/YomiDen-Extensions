# Patched plugins whose upstream changed

Our patch is still served. Diff `plugins/vendor/lnreader/<id>.js` against the patch, port what is needed, bump `// ydn-patch: N`, then run `python3 tools/aggregate.py --ack-patch <id>`.

Nothing to review.
