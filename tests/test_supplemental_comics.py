import unittest
from unittest.mock import patch

from tools.aggregate import COMIC_REPOS, add_comic_repos, add_paperback, add_shosetsu_repos, build_comic_repo


class SupplementalComicTests(unittest.TestCase):
    def test_legacy_metadata_preserves_source_id_and_signer(self):
        entry, = build_comic_repo("kavita", [{
            "pkg": "eu.kanade.tachiyomi.extension.all.kavita", "apk": "kavita-v1.4.29.apk",
            "name": "Tachiyomi: Kavita", "version": "1.4.29", "code": 29, "lang": "all",
            "nsfw": 0, "sources": [{"id": 7266875667263635239, "name": "Kavita", "lang": "all"}],
        }], "https://example.org/repo/")
        self.assertEqual(entry["signer"], COMIC_REPOS["kavita"][2])
        self.assertEqual(entry["sources"][0]["id"], "7266875667263635239")
        self.assertEqual(entry["url"], "https://example.org/repo/apk/kavita-v1.4.29.apk")
        self.assertEqual(entry["iconUrl"], "https://example.org/repo/icon/eu.kanade.tachiyomi.extension.all.kavita.png")
        self.assertFalse(entry["nsfw"])

    def test_v2_rejects_signer_change(self):
        with self.assertRaisesRegex(ValueError, "signing fingerprint changed"):
            build_comic_repo("felipegfa", {"signingKey": "unexpected"}, "")

    def test_v2_marks_mixed_source_nsfw(self):
        entry, = build_comic_repo("felipegfa", {
            "signingKey": COMIC_REPOS["felipegfa"][2],
            "extensionList": {"extensions": [{
                "packageName": "eu.kanade.tachiyomi.extension.en.example", "name": "Example",
                "versionCode": 1, "contentWarning": "CONTENT_WARNING_MIXED",
                "resources": {"apkUrl": "https://example.org/example.apk"},
            }]},
        }, "")
        self.assertTrue(entry["nsfw"])
        self.assertEqual(entry["origin"], "felipegfa")

    def test_snapshot_fallback_keeps_new_languages_and_skips_collisions(self):
        def comic(package, source, lang):
            return {
                "id": package, "name": package, "origin": "kavita", "contentType": "comic",
                "signer": COMIC_REPOS["kavita"][2],
                "sources": [{"id": source, "homeUrl": "https://example.org", "lang": lang}],
            }

        existing = comic("existing", "100", "en")
        candidates = [comic("existing", "101", "es"), comic("same-id", "100", "pt"),
                      comic("same-site", "102", "en"), comic("new-language", "103", "es")]
        previous = {"upstreams": {"kavita": {"count": 4}}, "extensions": candidates}
        with patch.dict(COMIC_REPOS, {"kavita": COMIC_REPOS["kavita"]}, clear=True):
            with patch("tools.aggregate.github_commit", return_value=None):
                added, upstreams, skipped, notes = add_comic_repos([existing], previous, False)
        self.assertEqual([entry["id"] for entry in added], ["new-language"])
        self.assertEqual(upstreams["kavita"]["published"], 1)
        self.assertEqual(len(skipped), 3)
        self.assertEqual(len(notes), 1)


    def test_paperback_does_not_shadow_current_comic_sources(self):
        candidate = {"contentType": "comic", "lang": "ar", "sites": ["manga.ae"]}
        apk = {"contentType": "comic", "lang": "en", "sites": [],
               "sources": [{"homeUrl": "https://manga.ae", "lang": "all"}]}
        novel = {"contentType": "novel", "lang": "ar", "sites": ["manga.ae"]}
        self.assertEqual(add_paperback([novel], [candidate]), [candidate])
        self.assertEqual(add_paperback([apk], [candidate]), [])

    def test_universe_keeps_snapshot_from_previous_key_if_index_is_down(self):
        root = "https://gitlab.com/shosetsuorg/extensions/-/raw/dev/"
        saved = {"id": "shosetsu-123", "name": "Example", "lang": "en", "shosetsu": {"root": root}}
        previous = {"upstreams": {"shosetsu-official": {"count": 1}}, "extensions": [saved]}
        with patch.dict("tools.aggregate.SHOSETSU_REPOS", {"shosetsu-universe": root}, clear=True):
            with patch("tools.aggregate.fetch_json", side_effect=RuntimeError("unavailable")):
                entries, upstreams, notes = add_shosetsu_repos([], previous, False)
        self.assertEqual(entries, [saved])
        self.assertEqual(upstreams["shosetsu-universe"]["published"], 1)
        self.assertTrue(notes)
