import unittest

from paths import candidate_paths, remap_path

REMAPS = [(r"\\nas\share\games", r"D:\Games"), (r"X:\Games", r"D:\Games")]


class RemapTests(unittest.TestCase):
    def test_prefix_is_replaced(self):
        self.assertEqual(remap_path(r"X:\Games\Foo\foo.exe", REMAPS), r"D:\Games\Foo\foo.exe")

    def test_case_insensitive_prefix(self):
        self.assertEqual(remap_path(r"\\NAS\Share\Games\Bar", REMAPS), r"D:\Games\Bar")

    def test_unknown_prefix_is_untouched(self):
        self.assertEqual(remap_path(r"C:\Other\baz", REMAPS), r"C:\Other\baz")

    def test_candidates_keep_original_first(self):
        paths = candidate_paths(r"X:\Games\Foo", REMAPS)
        self.assertEqual(paths[0], r"X:\Games\Foo")
        self.assertIn(r"D:\Games\Foo", paths)


if __name__ == "__main__":
    unittest.main()
