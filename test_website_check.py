import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from website_check import analyse_html


SHELL = '<html lang="en"><head><title>Example</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>{}</body></html>'


class WebsiteCheckTests(unittest.TestCase):
    def rules(self, body):
        return analyse_html(SHELL.format(body))["rules"]

    def test_names_and_form_labels(self):
        good = '<label for="email">Email</label><input id="email"><label>Name<input></label><button aria-label="Close"></button><a href="/"><img alt="Home" src="logo.png"></a><span id="name">Search</span><button aria-labelledby="name"></button>'
        self.assertEqual(self.rules(good), {})
        bad = '<input placeholder="Email"><button><span aria-hidden="true">x</span></button><a href="/"></a><button aria-labelledby="missing"></button>'
        self.assertEqual(self.rules(bad), {"control-name": 3, "field-label": 1})

    def test_images_and_duplicate_ids(self):
        result = self.rules('<img alt=""><img><span id="same"></span><div id="same"></div>')
        self.assertEqual(result, {"duplicate-id": 1, "image-alt": 1})

    def test_script_content_does_not_label_controls(self):
        result = self.rules('<button><script>window.text="Name";</script></button>')
        self.assertEqual(result, {"control-name": 1})

    def test_hidden_content_is_not_flagged(self):
        result = self.rules('<div hidden><button></button><img><input></div>')
        self.assertEqual(result, {})

    def test_zoom_restrictions(self):
        result = analyse_html('<html lang="en"><title>Page</title><meta name="viewport" content="user-scalable=no,maximum-scale=1"></html>')
        self.assertEqual(result["rules"], {"zoom": 2})

    def test_local_asset_checks_are_bounded(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "assets").mkdir()
            (root / "assets" / "yes.png").write_bytes(b"present")
            source = SHELL.format('<img alt="" src="/assets/yes.png?v=1"><img alt="" src="missing.png"><img alt="" src="../outside.png"><img alt="" src="https://example.com/remote.png">')
            result = analyse_html(source, "index.html", root)
            self.assertEqual(result["rules"], {"asset-path": 1, "missing-asset": 1})

    def test_cli_outputs_real_report_and_error_status(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            page = root / "index.html"
            page.write_text(SHELL.format('<script src="missing.js"></script>'), encoding="utf-8")
            report = root / "report.json"
            command = [sys.executable, str(Path(__file__).with_name("website_check.py")), str(page), "--site-root", str(root), "--format", "json", "--output", str(report), "--fail-on-error"]
            run = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(run.returncode, 1, run.stderr)
            data = json.loads(report.read_text(encoding="utf-8"))
            self.assertEqual(data[0]["file"], "index.html")
            self.assertEqual(data[0]["rules"], {"missing-asset": 1})


if __name__ == "__main__":
    unittest.main()
