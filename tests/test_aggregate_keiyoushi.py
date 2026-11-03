import unittest

from tools.aggregate import (
    build_keiyoushi,
    keiyoushi_source_urls,
    lnreader_cache_path,
    lnreader_index_url,
    pin_lnreader_plugin_url,
)


PACKAGE = "eu.kanade.tachiyomi.extension.all.ahottie"
APK_URL = (
    "https://github.com/keiyoushi/extensions/releases/download/"
    "fc7a827-0/tachiyomi-all.ahottie-v1.6.5.apk"
)
# Opaque current string from release-assets.json; it differs from the release API digest for this APK.
RELEASE_ASSET_VALUE = "8d8c3af868d63fdb3168a6d03d299f2ffeb0f7296f887643c1ac2d23eeffd9a5"
LEGACY_SHA256 = "8d8c3af868d63fdb3168a6d03d299f2ffeb0f7296f887643c1ac2d23eeffd9a5"
SIGNER = "9add655a78e96c4ec7a53ef89dccb557cb5d767489fac5e785d671a5a75d4da2"


def make_index():
    return {
        "signingKey": SIGNER,
        "extensionList": {
            "extensions": [
                {
                    "name": "AHottie",
                    "packageName": PACKAGE,
                    "versionName": "1.6.5",
                    "versionCode": 106005,
                    "contentWarning": "NSFW",
                    "resources": {"apkUrl": APK_URL, "iconUrl": "https://example.com/icon.png"},
                    "sources": [{"id": 1, "name": "AHottie", "language": "all", "homeUrl": "https://ahottie.top"}],
                },
            ],
        },
    }


class BuildKeiyoushiTests(unittest.TestCase):
    def test_current_string_schema_keeps_tagged_url_and_signer_but_omits_unverified_checksum(self):
        extensions, mismatched = build_keiyoushi(make_index(), {PACKAGE: RELEASE_ASSET_VALUE})

        self.assertEqual(mismatched, 1)
        self.assertEqual(len(extensions), 1)
        self.assertEqual(extensions[0]["url"], APK_URL)
        self.assertIsNone(extensions[0]["sha256"])
        self.assertEqual(extensions[0]["signer"], SIGNER)

    def test_previous_nested_object_schema_remains_supported(self):
        assets = {PACKAGE: {"apk": {"name": APK_URL.rsplit("/", 1)[-1], "sha256": LEGACY_SHA256}}}

        extensions, mismatched = build_keiyoushi(make_index(), assets)

        self.assertEqual(mismatched, 0)
        self.assertEqual(extensions[0]["sha256"], LEGACY_SHA256)
        self.assertEqual(extensions[0]["signer"], SIGNER)

    def test_previous_schema_still_rejects_wrong_asset_name(self):
        assets = {PACKAGE: {"apk": {"name": "wrong.apk", "sha256": LEGACY_SHA256}}}

        extensions, mismatched = build_keiyoushi(make_index(), assets)

        self.assertEqual(mismatched, 1)
        self.assertIsNone(extensions[0]["sha256"])
        self.assertEqual(extensions[0]["signer"], SIGNER)

    def test_invalid_current_checksum_is_not_published(self):
        extensions, mismatched = build_keiyoushi(make_index(), {PACKAGE: "not-a-sha256"})

        self.assertEqual(mismatched, 1)
        self.assertIsNone(extensions[0]["sha256"])
        self.assertEqual(extensions[0]["signer"], SIGNER)

    def test_upstream_inputs_are_pinned_to_one_commit(self):
        commit = "0123456789abcdef0123456789abcdef01234567"

        self.assertEqual(
            keiyoushi_source_urls(commit),
            (
                f"https://raw.githubusercontent.com/keiyoushi/extensions/{commit}/index.json",
                f"https://raw.githubusercontent.com/keiyoushi/extensions/{commit}/release-assets.json",
            ),
        )
        self.assertEqual(
            lnreader_index_url(commit),
            f"https://raw.githubusercontent.com/LNReader/lnreader-plugins/{commit}/.dist/plugins.min.json",
        )
        branch_url = "https://raw.githubusercontent.com/LNReader/lnreader-plugins/plugins/v3.0.0/.js/src/plugins/example.js"
        self.assertEqual(
            pin_lnreader_plugin_url(branch_url, commit),
            f"https://raw.githubusercontent.com/LNReader/lnreader-plugins/{commit}/.js/src/plugins/example.js",
        )

    def test_lnreader_cache_separates_same_id_and_version_at_different_urls(self):
        first = {"id": "example", "version": "1.0.0", "url": "https://example.test/plugins/commit-a.js"}
        updated = {"id": "example", "version": "1.0.0", "url": "https://example.test/plugins/commit-b.js"}

        self.assertNotEqual(
            lnreader_cache_path("/tmp/lnreader", first),
            lnreader_cache_path("/tmp/lnreader", updated),
        )


if __name__ == "__main__":
    unittest.main()
