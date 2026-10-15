import importlib.util
import os
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    "torrent_fetch", os.path.join(os.path.dirname(__file__), "..", "scripts", "torrent_fetch.py"))
tf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tf)


def benc(v):
    if isinstance(v, int):
        return b"i%de" % v
    if isinstance(v, str):
        v = v.encode()
    if isinstance(v, bytes):
        return b"%d:%s" % (len(v), v)
    if isinstance(v, list):
        return b"l" + b"".join(benc(x) for x in v) + b"e"
    return b"d" + b"".join(benc(k) + benc(v[k]) for k in sorted(v)) + b"e"


class TorrentFetchTest(unittest.TestCase):
    def test_file_list(self):
        meta = {"info": {"name": "root", "piece length": 16384, "pieces": b"x" * 20, "files": [
            {"length": 10, "path": ["Aleph", "067 - Something-Lesson 67.mp4"]},
            {"length": 20, "path": ["Aleph", "068 - Where Is Joseph-Lesson 68.mp4"]},
        ]}}
        with tempfile.NamedTemporaryFile(suffix=".torrent", delete=False) as f:
            f.write(benc(meta))
        try:
            files = tf.torrent_files(f.name)
        finally:
            os.unlink(f.name)
        self.assertEqual(files[1], (2, "Aleph/068 - Where Is Joseph-Lesson 68.mp4", 20))

    def test_lesson_key(self):
        self.assertEqual(tf.lesson_key("x/068 - Where Is Joseph-Lesson 68.mp4"), (68, ""))
        self.assertEqual(tf.lesson_key("x/Lesson 70b - More passages.mp4"), (70, "b"))
        self.assertEqual(tf.lesson_key("x/Lesson 072.mp4"), (72, ""))
        self.assertIsNone(tf.lesson_key("x/Review Game for Lessons 67-68.mp4"))
        self.assertIsNone(tf.lesson_key("x/Lesson 68.srt"))

    def test_title(self):
        self.assertEqual(tf.title_from("068 - Where Is Joseph-Lesson 68.mp4"), "Where Is Joseph")
        self.assertIsNone(tf.title_from("Lesson 68.mp4"))

    def test_magnet(self):
        self.assertIn("2DF4DD7EA75BC5F68BDC7D4BCE59390B12AB15BD", tf.magnet("1080p"))


if __name__ == "__main__":
    unittest.main()
