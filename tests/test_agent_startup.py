import contextlib
import io
import json
import tomllib
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from malenia import __version__
from malenia.cli import main
from malenia.config import data_directory, database_path
from malenia.server import create_server
from malenia.store import TaskStore


class AgentStartupTests(unittest.TestCase):
    def test_new_runtime_interrupts_old_browser_job_without_claiming_success(self):
        with tempfile.TemporaryDirectory() as temp:
            store=TaskStore(Path(temp)/"restart.sqlite3")
            job=store.request_browser_audit()
            store.claim_browser_audit()
            server=create_server("127.0.0.1",0,store,"test-token")
            try:
                self.assertEqual(store.latest_browser_audit_job()["status"],"failed")
                self.assertEqual(store.latest_browser_audit_job()["failure_reason"],"agent_restarted")
                self.assertFalse(store.finish_browser_audit(job["job_id"],True))
                self.assertEqual(store.request_browser_audit()["status"],"pending")
            finally:
                server.server_close()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.store = TaskStore(self.root / 'test.sqlite3')

    def tearDown(self):
        self.temporary.cleanup()

    def test_second_listener_cannot_take_over_the_first_endpoint(self):
        first = create_server('127.0.0.1', 0, self.store, 'test-only-token')
        try:
            with self.assertRaises(OSError):
                create_server('127.0.0.1', first.server_port, self.store, 'other-test-token')
            self.assertEqual(first.socket.getsockname()[1], first.server_port)
        finally:
            first.server_close()

    def test_busy_port_fails_before_announcing_readiness_or_printing_a_token(self):
        first = create_server('127.0.0.1', 0, self.store, 'test-only-token')
        output, errors = io.StringIO(), io.StringIO()
        try:
            with patch('sys.argv', ['malenia-agent', '--port', str(first.server_port)]), \
                 patch('malenia.cli.database_path', return_value=self.root / 'cli.sqlite3'), \
                 patch.dict(os.environ, {'MALENIA_API_TOKEN': 'test-token-must-not-print'}), \
                 contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                code = main()
            self.assertEqual(code, 2)
            self.assertEqual(output.getvalue(), '')
            self.assertIn('occupied or unavailable', errors.getvalue())
            self.assertNotIn('test-token-must-not-print', errors.getvalue())
            self.assertEqual(first.socket.getsockname()[1], first.server_port)
        finally:
            first.server_close()

    def test_fresh_malenia_namespace_and_version(self):
        with patch.dict(os.environ, {'LOCALAPPDATA': str(self.root), 'XDG_DATA_HOME': str(self.root)}):
            self.assertEqual(data_directory(), self.root / 'Malenia')
            self.assertEqual(database_path(), self.root / 'Malenia' / 'malenia.sqlite3')
        self.assertEqual(__version__, '0.16.1')

    def test_desktop_and_bundled_runtime_release_versions_match(self):
        root = Path(__file__).resolve().parents[1]
        versions = {
            "Python package": tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"],
            "Cargo": tomllib.loads((root / "desktop/src-tauri/Cargo.toml").read_text(encoding="utf-8"))["package"]["version"],
            "Tauri": json.loads((root / "desktop/src-tauri/tauri.conf.json").read_text(encoding="utf-8"))["version"],
            "Frontend": json.loads((root / "desktop/package.json").read_text(encoding="utf-8"))["version"],
        }
        for component, version in versions.items():
            with self.subTest(component=component):
                self.assertEqual(version, __version__, "Desktop rejects an agent with a different release")
