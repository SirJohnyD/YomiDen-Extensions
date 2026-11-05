import hashlib
import os
import tempfile
import unittest

from tools.aggregate import patch_revision, render_patch_review, vendor_lnreader_entry

BASE = "https://raw.githubusercontent.com/SirJohnyD/yomiden-extensions/abc/"
UP = "https://raw.githubusercontent.com/LNReader/lnreader-plugins/c0ffee/plugins/english/x.js"
ENTRY = {"id": "x", "name": "X", "version": "1.2.0", "url": UP, "sha256": "0" * 64, "origin": "lnreader"}


def sha(b):
    return hashlib.sha256(b).hexdigest()


class VendorTest(unittest.TestCase):
    def run_vendor(self, root, upstream=b"upstream"):
        return vendor_lnreader_entry(
            ENTRY, upstream, UP,
            vendor_dir=os.path.join(root, "plugins/vendor/lnreader"),
            patch_dir=os.path.join(root, "plugins/patches"),
            public_base=BASE, root=root,
        )

    def test_unpatched_points_at_vendored_copy(self):
        with tempfile.TemporaryDirectory() as root:
            e, review = self.run_vendor(root)
            self.assertIsNone(review)
            self.assertEqual(e["url"], BASE + "plugins/vendor/lnreader/x.js")
            self.assertEqual(e["sha256"], sha(b"upstream"))
            self.assertEqual((e["upstreamUrl"], e["upstreamSha256"], e["origin"]), (UP, sha(b"upstream"), "lnreader"))
            self.assertEqual(open(os.path.join(root, "plugins/vendor/lnreader/x.js"), "rb").read(), b"upstream")

    def test_patch_replaces_vendored_file_and_bumps_version(self):
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root, "plugins/patches"))
            patch = b"// ydn-patch: 3\nfixed"
            path = os.path.join(root, "plugins/patches/x.js")
            open(path, "wb").write(patch)
            e, review = self.run_vendor(root)
            self.assertIsNone(review)
            self.assertEqual(e["url"], BASE + "plugins/patches/x.js")
            self.assertEqual(e["sha256"], sha(patch))
            self.assertEqual(e["upstreamSha256"], sha(b"upstream"))
            self.assertEqual(e["version"], "1.2.0-ydn.3")
            self.assertEqual(open(path, "rb").read(), patch)  # never overwritten

    def test_upstream_change_goes_to_review_and_keeps_patch(self):
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root, "plugins/patches"))
            patch = b"fixed"
            path = os.path.join(root, "plugins/patches/x.js")
            open(path, "wb").write(patch)
            self.run_vendor(root)  # records <id>.base
            e, review = self.run_vendor(root, upstream=b"upstream v2")
            self.assertEqual(review["baseSha256"], sha(b"upstream"))
            self.assertEqual(review["upstreamSha256"], sha(b"upstream v2"))
            self.assertEqual(e["sha256"], sha(patch))
            self.assertEqual(e["version"], "1.2.0-ydn.1")
            self.assertEqual(open(path, "rb").read(), patch)
            self.assertIn("`x`", render_patch_review([review]))

    def test_patch_revision_default(self):
        self.assertEqual(patch_revision(b"no marker"), 1)


if __name__ == "__main__":
    unittest.main()
