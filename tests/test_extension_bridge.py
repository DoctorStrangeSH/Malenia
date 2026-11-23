import json
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError

from malenia.extension_bridge import BUNDLED_EXTENSION_ID
from malenia.resources import ResourceManager
from malenia.server import make_handler
from malenia.store import TaskStore


class ExtensionBridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = TaskStore(Path(self.tmp.name) / "db.sqlite3")
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.store, "secret-token", ResourceManager()))
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.port = self.httpd.server_address[1]

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.tmp.cleanup()

    def post(self, payload, origin, host=None):
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}/v1/extension/message",
                                         data=json.dumps(payload).encode(), method="POST",
                                         headers={"Content-Type": "application/json", "Origin": origin,
                                                  **({"Host": host} if host else {})})
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, dict(response.headers), json.loads(response.read())

    def test_bundled_extension_can_talk_without_desktop_token(self):
        origin = f"chrome-extension://{BUNDLED_EXTENSION_ID}"
        status, headers, body = self.post({"type": "hello", "request_id": "r1"}, origin)
        self.assertEqual(status, 200)
        self.assertEqual((body["ok"], body["host"], body["request_id"], body["transport"]), (True, "com.malenia.browser", "r1", "http"))
        self.assertEqual(headers["Access-Control-Allow-Origin"], origin)

    def test_web_pages_and_other_extensions_are_rejected(self):
        for origin in ("https://evil.example", "chrome-extension://" + "a" * 32, ""):
            with self.assertRaises(HTTPError) as caught:
                self.post({"type": "hello"}, origin)
            self.assertEqual(caught.exception.code, 403, origin)

    def test_dns_rebinding_host_is_rejected(self):
        with self.assertRaises(HTTPError) as caught:
            self.post({"type": "hello"}, f"chrome-extension://{BUNDLED_EXTENSION_ID}", host="evil.example:8765")
        self.assertEqual(caught.exception.code, 403)

    def test_desktop_api_still_requires_token(self):
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}/v1/tasks", data=b"{}", method="POST",
                                         headers={"Origin": f"chrome-extension://{BUNDLED_EXTENSION_ID}"})
        with self.assertRaises(HTTPError) as caught:
            urllib.request.urlopen(request, timeout=5)
        self.assertEqual(caught.exception.code, 401)


if __name__ == "__main__":
    unittest.main()


class BundledIdConsistencyTests(unittest.TestCase):
    def test_python_rust_and_manifest_key_agree(self):
        import base64
        import hashlib
        import re
        root = Path(__file__).resolve().parents[1]
        rust = (root / "desktop/src-tauri/src/browser_setup.rs").read_text("utf-8")
        self.assertIn(f'EXTENSION_ID: &str = "{BUNDLED_EXTENSION_ID}"', rust)
        key = json.loads((root / "browser-extension/manifest.json").read_text("utf-8"))["key"]
        digest = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
        self.assertEqual("".join(chr(ord("a") + int(c, 16)) for c in digest), BUNDLED_EXTENSION_ID)
        self.assertIn("http://127.0.0.1:8765/*", json.loads((root / "browser-extension/manifest.json").read_text("utf-8"))["host_permissions"])


class GoogleErrorClassificationTests(unittest.TestCase):
    def test_actionable_codes(self):
        from malenia.google_sheets import _classify_api_error
        disabled = {"code": 403, "status": "PERMISSION_DENIED", "message": "Google Sheets API has not been used in project 123 before or it is disabled.",
                    "details": [{"reason": "SERVICE_DISABLED"}]}
        self.assertEqual(_classify_api_error(403, disabled), "google_api_disabled")
        self.assertEqual(_classify_api_error(403, {"status": "PERMISSION_DENIED", "message": "The caller does not have permission"}), "google_no_access")
        self.assertEqual(_classify_api_error(403, {"details": [{"reason": "ACCESS_TOKEN_SCOPE_INSUFFICIENT"}]}), "google_reauthorization_required")
        self.assertEqual(_classify_api_error(404, {}), "google_sheet_not_found")
        self.assertEqual(_classify_api_error(429, {}), "google_rate_limited")
        self.assertEqual(_classify_api_error(500, {}), "google_request_failed")
